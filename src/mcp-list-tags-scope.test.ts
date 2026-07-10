/**
 * Tag-scope enforcement on the MCP `list-tags` single-tag path (vault#550
 * fold; also closes vault#560). Core's list-tags is scope-unaware by
 * architecture — `applyTagScopeWrappers` in src/mcp-tools.ts is the
 * enforcement layer. Before this fix the wrapper only filtered ARRAY
 * results, so the single-tag (`{tag}` param) shape passed through
 * unwrapped, leaking (a) the FULL record of an existing out-of-scope tag
 * (#560), and (b) post-#550, a vault-wide `did_you_mean` suggestion that
 * could name an out-of-scope tag.
 *
 * Fixture: PARACHUTE_HOME temp home + a hand-built AuthResult (no JWT
 * infra needed — `generateScopedMcpTools` takes the resolved auth
 * directly), same pattern as attribution-threading.test.ts's MCP section.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import type { AuthResult } from "./auth.ts";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-listtags-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function authFor(vaultName: string, scopedTags: string[] | null): AuthResult {
  return {
    permission: "full",
    scopes: [`vault:${vaultName}:read`, `vault:${vaultName}:write`],
    legacyDerived: false,
    scoped_tags: scopedTags,
    vault_name: null,
    caller_jti: null,
    actor: "test-user",
    via: "api",
  };
}

async function listTagsTool(vaultName: string, scopedTags: string[] | null) {
  const tools = generateScopedMcpTools(vaultName, authFor(vaultName, scopedTags));
  return tools.find((t) => t.name === "list-tags")!;
}

describe("MCP list-tags single-tag path — tag-scope enforcement (vault#550 fold, closes #560)", () => {
  test("scoped token + EXISTING out-of-scope tag → tag_not_found with no record fields, no did_you_mean (#560's full-record leak)", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("work", { description: "top secret reorg planning" });
    await store.createNote("w", { tags: ["work"] });
    await store.createNote("h", { tags: ["health"] });

    const tool = await listTagsTool("journal", ["health"]);
    const result = (await tool.execute({ tag: "work" })) as any;

    expect(result.error_type).toBe("tag_not_found");
    expect(result.tag).toBe("work");
    // No leak: none of the record's fields, no counts, no suggestion.
    expect(result.description).toBeUndefined();
    expect(result.count).toBeUndefined();
    expect(result.expanded_count).toBeUndefined();
    expect(result.fields).toBeUndefined();
    expect(result.parent_names).toBeUndefined();
    expect(result.did_you_mean).toBeUndefined();
  });

  test("scoped token + NONEXISTENT tag → tag_not_found without an out-of-scope did_you_mean", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    // "project" exists but is OUT of scope — it must not surface as a
    // suggestion for the near-miss "projet".
    await store.upsertTagRecord("project", {});
    await store.createNote("h", { tags: ["health"] });

    const tool = await listTagsTool("journal", ["health"]);
    // "projet" is not in the allowlist → short-circuits to tag_not_found
    // before core even computes a suggestion.
    const result = (await tool.execute({ tag: "projet" })) as any;
    expect(result.error_type).toBe("tag_not_found");
    expect(result.tag).toBe("projet");
    expect(result.did_you_mean).toBeUndefined();
  });

  test("scoped token + in-scope miss keeps did_you_mean only when the suggestion is also in-scope", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    // Declared hierarchy: health/food is a child of health, so the
    // allowlist expansion covers both. A near-miss on the CHILD name is in
    // the allowlist's expansion? No — "health/fod" itself isn't a known
    // tag, but it IS within scope only if the allowlist contains it.
    // expandTokenTagScope(["health"]) = {health, health/food}; the literal
    // input "health/fod" is NOT in that set → short-circuit tag_not_found
    // (no suggestion) — pinning that the wrapper gates on the allowlist,
    // not on string prefixes.
    await store.upsertTagRecord("health/food", { parent_names: ["health"] });
    await store.createNote("hf", { tags: ["health/food"] });

    const tool = await listTagsTool("journal", ["health"]);
    const result = (await tool.execute({ tag: "health/fod" })) as any;
    expect(result.error_type).toBe("tag_not_found");
    expect(result.did_you_mean).toBeUndefined();
  });

  test("unscoped token unchanged — full record for existing tags, did_you_mean on misses", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("project", { description: "projects" });
    await store.createNote("p", { tags: ["project"] });

    const tool = await listTagsTool("journal", null);

    const hit = (await tool.execute({ tag: "project" })) as any;
    expect(hit.name).toBe("project");
    expect(hit.count).toBe(1);
    expect(hit.description).toBe("projects");

    const miss = (await tool.execute({ tag: "projet" })) as any;
    expect(miss.error_type).toBe("tag_not_found");
    expect(miss.did_you_mean).toBe("project");
  });

  test("scoped token + array list still filters to the allowlist (regression: pre-existing behavior)", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("h", { tags: ["health"] });
    await store.createNote("w", { tags: ["work"] });

    const tool = await listTagsTool("journal", ["health"]);
    const result = (await tool.execute({})) as any[];
    const names = result.map((t) => t.name);
    expect(names).toContain("health");
    expect(names).not.toContain("work");
  });

  // vault#554 carry-forward: the wrapper's SECOND scrub branch (the one
  // AFTER the early out-of-scope short-circuit above) fires when the queried
  // tag itself IS in the allowlist but core still reports tag_not_found —
  // the hollow-tag case (vault#550: no identity row, no notes directly
  // carrying it) reached ONLY via a child's `parent_names`. Core computes
  // `did_you_mean` vault-wide (scope-unaware by architecture), so it can
  // name an out-of-scope tag; the wrapper must strip that suggestion even
  // though the queried tag itself passed the allowlist gate. This branch was
  // execution-verified in a prior review; this test commits it.
  test("scoped token + in-scope HOLLOW tag (reachable only via a child's parent_names) scrubs an out-of-scope did_you_mean", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");

    // "health" itself has NO identity row and NO note directly carrying it —
    // it's in the allowlist expansion ONLY because "kale" declares it as a
    // parent. "kale" is deliberately NOT lexically close to "health" (the
    // mission's "non-close child") so it can't win did_you_mean and mask
    // the bug this test targets.
    await store.upsertTagRecord("kale", { parent_names: ["health"] });
    await store.createNote("k", { tags: ["kale"] });

    // Out-of-scope decoy, lexically close to "health" (prefix match) — this
    // is what core's vault-wide suggestSimilarTag would pick if nothing
    // scrubbed it.
    await store.createNote("hy", { tags: ["healthy"] });

    const tool = await listTagsTool("journal", ["health"]);
    const result = (await tool.execute({ tag: "health" })) as any;

    expect(result.error_type).toBe("tag_not_found");
    expect(result.tag).toBe("health");
    // The scrub: did_you_mean must NOT leak the out-of-scope "healthy",
    // even though "health" (the query) itself passed the allowlist gate.
    expect(result.did_you_mean).toBeUndefined();
  });
});
