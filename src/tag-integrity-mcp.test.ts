/**
 * End-to-end coverage for the vault#552 MCP + REST surface: rename-tag and
 * merge-tags tool wiring (verb + tag-scope gating), delete-tag's
 * cascade/detach flags flowing through the MCP wrapper, and the `doctor`
 * tool/endpoint's tag-scope filtering. Fixture pattern mirrors
 * tag-field-conflict-scope.test.ts (PARACHUTE_HOME temp home + hand-built
 * AuthResult).
 *
 * Write/admin re-tier (this PR): the MCP `doctor` tool moved admin → read
 * (read-only, tag-scope-restricted diagnostic); `rename-tag`/`merge-tags`/
 * `delete-tag`/`update-tag` moved write → admin (schema/taxonomy curation,
 * not content). The REST `GET /api/doctor` endpoint is intentionally
 * UNCHANGED — it stays admin-gated (a separate enforcement point in
 * src/routing.ts) — so it and the MCP `doctor` tool now sit at different
 * tiers for the same underlying scan; see CHANGELOG.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { handleTags, handleDoctor, type TagScopeCtx } from "./routes.ts";
import type { AuthResult } from "./auth.ts";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-tag-integrity-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();
});

afterEach(() => {
  clearVaultStoreCache();
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function seedVault(name: string): void {
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  getVaultStore(name);
}

function authFor(vaultName: string, scopedTags: string[] | null, verb: "read" | "write" | "admin" = "write"): AuthResult {
  const verbs = verb === "admin" ? ["read", "write", "admin"] : verb === "write" ? ["read", "write"] : ["read"];
  return {
    permission: "full",
    scopes: verbs.map((v) => `vault:${vaultName}:${v}`),
    legacyDerived: false,
    scoped_tags: scopedTags,
    vault_name: null,
    caller_jti: null,
    actor: "test-user",
    via: "api",
  };
}

async function toolsFor(vaultName: string, scopedTags: string[] | null, verb: "read" | "write" | "admin" = "write") {
  return generateScopedMcpTools(vaultName, authFor(vaultName, scopedTags, verb));
}

describe("rename-tag / merge-tags — tag-scope gating (vault#552)", () => {
  test("rename-tag: old_name or new_name outside the allowlist is refused before reaching core", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("mine", {});
    await store.upsertTagRecord("theirs", {});

    const tools = await toolsFor("journal", ["mine"]);
    const renameTag = tools.find((t) => t.name === "rename-tag")!;

    const result = await renameTag.execute({ old_name: "theirs", new_name: "mine2" }) as any;
    expect(result.error_type).toBe("tag_scope_violation");

    // Untouched.
    expect(await store.getTagRecord("theirs")).not.toBeNull();
  });

  test("rename-tag: both names in-scope reaches core (wrapper doesn't spuriously block), which reports target_exists for an already-live target", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("mine", {});
    await store.upsertTagRecord("mine-other", {});

    // Both names are directly scoped (each tag is trivially a member of its
    // own descendant set), so the wrapper's scope check passes and the call
    // reaches core — which correctly refuses because "mine-other" already
    // exists (rename never silently overwrites; that's what merge-tags is
    // for). Proves the wrapper isn't the thing blocking this, core is.
    const tools = await toolsFor("journal", ["mine", "mine-other"]);
    const renameTag = tools.find((t) => t.name === "rename-tag")!;
    let caught: any;
    try {
      await renameTag.execute({ old_name: "mine", new_name: "mine-other" });
    } catch (e) { caught = e; }
    expect(caught?.error_type).toBe("target_exists");
  });

  test("merge-tags: a source outside the allowlist is refused before reaching core", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("mine", {});
    await store.upsertTagRecord("theirs", {});

    const tools = await toolsFor("journal", ["mine"]);
    const mergeTags = tools.find((t) => t.name === "merge-tags")!;
    const result = await mergeTags.execute({ sources: ["theirs"], target: "mine" }) as any;
    expect(result.error_type).toBe("tag_scope_violation");
    expect(await store.getTagRecord("theirs")).not.toBeNull();
  });

  test("merge-tags: a source referenced by a tag-scoped token is refused (409-equivalent), independent of the CALLER's own scope", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("mine", {});
    await store.upsertTagRecord("locked", {});
    // A DIFFERENT (vestigial) tag-scoped token row references "locked" —
    // merging it away would orphan that token's allowlist. Raw INSERT, same
    // fixture pattern as vault.test.ts's "MCP delete-tag returns
    // tag_in_use_by_tokens..." — vault no longer mints these post-0.5.0, but
    // findTokensReferencingTag still guards against leftover rows.
    store.db
      .prepare(
        "INSERT INTO tokens (token_hash, label, permission, scoped_tags, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        `sha256:locked-claw-${Math.random().toString(36).slice(2)}`,
        "locked-claw",
        "read",
        JSON.stringify(["locked"]),
        new Date().toISOString(),
      );

    const tools = await toolsFor("journal", null); // unscoped caller — still blocked by the token-reference guard
    const mergeTags = tools.find((t) => t.name === "merge-tags")!;
    const result = await mergeTags.execute({ sources: ["locked"], target: "mine" }) as any;
    expect(result.error_type).toBe("tag_in_use_by_tokens");
    expect(await store.getTagRecord("locked")).not.toBeNull();
  });
});

describe("delete-tag cascade/detach — MCP wrapper pass-through (vault#552)", () => {
  test("cascade:true flows through the tag-scope wrapper to the underlying store call", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("mine", { description: "root" });
    await store.upsertTagRecord("mine-child", { parent_names: ["mine"] });

    const tools = await toolsFor("journal", ["mine"]); // "mine-child" is a descendant, also in-scope
    const deleteTag = tools.find((t) => t.name === "delete-tag")!;

    const refused = await deleteTag.execute({ tag: "mine" }) as any;
    expect(refused.error).toBe("tag_referenced_as_parent");

    const cascaded = await deleteTag.execute({ tag: "mine", cascade: true }) as any;
    expect(cascaded.deleted).toBe(true);
    expect(await store.getTagRecord("mine")).toBeNull();
  });
});

describe("doctor — read gate (re-tier) + tag-scope filtering (vault#552)", () => {
  test("MCP: doctor is visible + callable for a read-only session (re-tier: admin → read)", async () => {
    // `generateScopedMcpTools` (the `toolsFor` helper) always returns the
    // FULL tool set — the `requiredVerb` visibility filter lives one layer
    // up, in `handleScopedMcp`'s tools/list dispatch (mcp-http.ts). Drive
    // through that layer, same pattern as vault.test.ts's `listToolNames`.
    seedVault("journal");
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const listReq = new Request("http://localhost:1940/vault/journal/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const listRes = await handleScopedMcp(listReq, "journal", authFor("journal", null, "read"));
    const listBody = await listRes.json() as any;
    const names: string[] = listBody.result.tools.map((t: any) => t.name);
    expect(names).toContain("doctor");

    // Explicitly calling it succeeds — no admin credential needed anymore.
    const callReq = new Request("http://localhost:1940/vault/journal/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "doctor", arguments: {} } }),
    });
    const callRes = await handleScopedMcp(callReq, "journal", authFor("journal", null, "read"));
    const callBody = await callRes.json() as any;
    expect(callBody.result?.isError).toBeFalsy();
    const report = JSON.parse(callBody.result.content[0].text);
    expect(report.findings).toBeDefined();
  });

  test("MCP: update-tag is invisible in tools/list to a write-only (non-admin) session, and excluded-tool-called-explicitly still refuses it (re-tier: write → admin)", async () => {
    seedVault("journal");
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const listReq = new Request("http://localhost:1940/vault/journal/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const listRes = await handleScopedMcp(listReq, "journal", authFor("journal", null, "write"));
    const listBody = await listRes.json() as any;
    const names: string[] = listBody.result.tools.map((t: any) => t.name);
    expect(names).not.toContain("update-tag");
    expect(names).not.toContain("delete-tag");
    expect(names).not.toContain("rename-tag");
    expect(names).not.toContain("merge-tags");
    // doctor, by contrast, IS visible — it's read-tier now, and write ⊇ read.
    expect(names).toContain("doctor");

    // Explicitly calling update-tag anyway is refused, not silently executed.
    const callReq = new Request("http://localhost:1940/vault/journal/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update-tag", arguments: { tag: "mine" } } }),
    });
    const callRes = await handleScopedMcp(callReq, "journal", authFor("journal", null, "write"));
    const callBody = await callRes.json() as any;
    expect(callBody.result?.isError).toBe(true);
  });

  test("MCP: doctor is visible + callable for an admin session, and a scoped admin session only reports in-scope findings", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    // In-scope dangling parent_names.
    await store.upsertTagRecord("mine-broken", { parent_names: ["mine-ghost-parent"] });
    // Out-of-scope dangling parent_names — must not appear in a scoped report.
    await store.upsertTagRecord("theirs-broken", { parent_names: ["theirs-ghost-parent"] });

    const unscopedTools = await toolsFor("journal", null, "admin");
    const unscopedDoctor = unscopedTools.find((t) => t.name === "doctor")!;
    const unscopedReport = await unscopedDoctor.execute({}) as any;
    const unscopedSubjects = unscopedReport.findings.map((f: any) => f.subject);
    expect(unscopedSubjects).toContain("mine-broken");
    expect(unscopedSubjects).toContain("theirs-broken");

    const scopedTools = await toolsFor("journal", ["mine-broken"], "admin");
    const scopedDoctor = scopedTools.find((t) => t.name === "doctor")!;
    const scopedReport = await scopedDoctor.execute({}) as any;
    const scopedSubjects = scopedReport.findings.map((f: any) => f.subject);
    expect(scopedSubjects).toContain("mine-broken");
    expect(scopedSubjects).not.toContain("theirs-broken");
  });

  test("REST: GET /api/doctor reports findings filtered to the tag-scoped caller's allowlist", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("mine-broken", { parent_names: ["mine-ghost-parent"] });
    await store.upsertTagRecord("theirs-broken", { parent_names: ["theirs-ghost-parent"] });

    const tagScope: TagScopeCtx = { allowed: new Set(["mine-broken"]), raw: ["mine-broken"] };
    const res = await handleDoctor(new Request("http://localhost/api/doctor"), store, tagScope);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const subjects = body.findings.map((f: any) => f.subject);
    expect(subjects).toContain("mine-broken");
    expect(subjects).not.toContain("theirs-broken");
  });
});

describe("parent_cycle — REST PUT /api/tags/:name surfaces the 409 (vault#552)", () => {
  test("A→B then B→A is rejected with error_type parent_cycle, naming the cycle", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("b", {});
    await store.upsertTagRecord("a", { parent_names: ["b"] });

    const req = new Request("http://localhost/api/tags/b", {
      method: "PUT",
      body: JSON.stringify({ parent_names: ["a"] }),
    });
    const res = await handleTags(req, store, "/b");
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error_type).toBe("parent_cycle");
    expect(body.tag).toBe("b");
    expect(body.cycle).toContain("a");
    expect(body.cycle).toContain("b");
    // MUST-FIX 5 (wire review): a `message` key is load-bearing — the shared
    // parachute-surface VaultClient 409 handler reads `body.message` (else it
    // shows a hardcoded "Note was edited elsewhere"). `error` is the short
    // code, `message` the human sentence — same split every sibling 409 uses.
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.message).toMatch(/cycle/i);
    expect(body.error).toBe("ParentCycle");
    expect(body.error).not.toContain(" "); // short code, not the full sentence

    // Nothing persisted.
    expect((await store.getTagRecord("b"))?.parent_names ?? null).toBeFalsy();
  });
});

describe("tag_referenced_as_parent — REST DELETE /api/tags/:name surfaces the 409 + flags (vault#552)", () => {
  test("refused by default, cascade query param proceeds", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("root", {});
    await store.upsertTagRecord("child", { parent_names: ["root"] });

    const refusedRes = await handleTags(new Request("http://localhost/api/tags/root", { method: "DELETE" }), store, "/root");
    expect(refusedRes.status).toBe(409);
    const refusedBody: any = await refusedRes.json();
    expect(refusedBody.error_type).toBe("tag_referenced_as_parent");
    expect(refusedBody.referencing_tags).toEqual(["child"]);
    // Same short-code-`error` + human-`message` split as every sibling 409
    // (wire consistency — parachute-surface reads `body.message`).
    expect(refusedBody.error).toBe("TagReferencedAsParent");
    expect(typeof refusedBody.message).toBe("string");
    expect(refusedBody.message.length).toBeGreaterThan(0);

    const cascadedRes = await handleTags(
      new Request("http://localhost/api/tags/root?cascade=true", { method: "DELETE" }),
      store,
      "/root",
    );
    expect(cascadedRes.status).toBe(200);
    const cascadedBody: any = await cascadedRes.json();
    expect(cascadedBody.deleted).toBe(true);
    expect(cascadedBody.parent_refs_detached).toBe(1);
  });
});
