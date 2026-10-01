/**
 * vault#766 retroactive-review fix-forward (PR #767 review):
 *
 *   1. Count surfaces (vault-info `map` + `stats` on both doors, the
 *      connect-time brief) must not count notes a private tag hides.
 *   2. `private_tags` parsing fails CLOSED for scoped tokens: a present but
 *      unreadable key, an unreadable vault.yaml, or a store not bound to a
 *      vault name → the scoped token sees nothing. A scalar is accepted as a
 *      one-element list; trailing comments are fine.
 *   3. `doctor` per-note findings use `noteWithinTagScope` (deny wins).
 *
 * Plus coverage the original suite lacked: near, expand_links, aggregate,
 * versions, semantic (semantic uses a mocked embedding provider — no real
 * model in tests).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeVaultConfig,
  readVaultConfig,
  readPrivateTagsConfig,
  parsePrivateTags,
  vaultConfigPath,
  hashKey,
} from "./config.ts";
import { getVaultStore, clearVaultStoreCache, BunStore } from "./vault-store.ts";
import { generateScopedMcpTools, getServerInstruction } from "./mcp-tools.ts";
import { handleNotes, handleVault, handleDoctor, type TagScopeCtx } from "./routes.ts";
import { expandTokenTagScope, TagScopeSet } from "./tag-scope.ts";
import { authenticateVaultRequest, type AuthResult } from "./auth.ts";
import { handleScopedMcp } from "./mcp-http.ts";
import type { EmbeddingProvider, EmbedInput, EmbedResult, ProviderAvailability } from "../core/src/embedding/provider.ts";
import { encodeVector, normalize } from "../core/src/embedding/vector-codec.ts";

const V = "privfc";
let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-private-tags-fc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function authFor(scopedTags: string[] | null): AuthResult {
  return {
    permission: "full",
    scopes: [`vault:${V}:read`, `vault:${V}:admin`],
    legacyDerived: false,
    scoped_tags: scopedTags,
    vault_name: null,
    caller_jti: null,
    actor: "test-user",
    via: "api",
  } as AuthResult;
}

function baseConfig() {
  return { name: V, api_keys: [], created_at: new Date().toISOString() };
}

/** Seed: project-only (Shared), project+capture (Mixed/Diary), capture-only (Cap). */
async function seed(privateTags: string[] | undefined) {
  writeVaultConfig({ ...baseConfig(), ...(privateTags ? { private_tags: privateTags } : {}) });
  const store = getVaultStore(V);
  const shared = await store.createNote("shared widget plan, see [[Mixed/Diary]]", { path: "Shared", tags: ["project"] });
  const mixed = await store.createNote("private widget diary", { path: "Mixed/Diary", tags: ["project", "capture"] });
  const cap = await store.createNote("raw widget capture", { path: "Cap", tags: ["capture"] });
  return { store, shared, mixed, cap };
}

/** Write raw vault.yaml text (for parser fail-closed cases). */
function writeRawConfig(privateTagsBlock: string) {
  writeVaultConfig(baseConfig());
  const p = vaultConfigPath(V);
  const base = `name: ${V}\ncreated_at: "${new Date().toISOString()}"\n`;
  writeFileSync(p, base + privateTagsBlock + (privateTagsBlock.endsWith("\n") ? "" : "\n"));
}

function tool(scoped: string[] | null, name: string) {
  return generateScopedMcpTools(V, authFor(scoped)).find((t) => t.name === name)!;
}

function paths(result: unknown): string[] {
  const notes = Array.isArray(result) ? result : (result as any)?.notes ?? [];
  return notes.map((n: any) => n.path).sort();
}

async function restCtx(store: any, scoped: string[] | null): Promise<TagScopeCtx> {
  return { allowed: await expandTokenTagScope(store, scoped), raw: scoped };
}

async function restVault(store: any, scoped: string[] | null, query = "") {
  const req = new Request(`http://localhost/vault/${V}/api/vault${query}`);
  const res = await handleVault(
    req,
    store,
    readVaultConfig(V)!,
    undefined,
    async () => ({ enabled: false }) as any,
    await restCtx(store, scoped),
    async () => ({ enabled: false }) as any,
  );
  return (await res.json()) as any;
}

// ---------------------------------------------------------------------------
// Must-fix 1 — count surfaces
// ---------------------------------------------------------------------------

describe("must-fix 1: counts exclude notes hidden by private tags", () => {
  const expectScopedMap = (map: any) => {
    expect(map.total_notes).toBe(1);
    expect(map.tags).toEqual([{ name: "project", count: 1 }]);
    expect(map.path_buckets).toEqual([{ name: "Shared", count: 1 }]);
    expect(map.path_buckets.map((b: any) => b.name)).not.toContain("Mixed");
    expect(map.unfiled_notes).toBe(0);
  };

  test("MCP vault-info map + stats", async () => {
    await seed(["capture"]);
    const r = (await tool(["project"], "vault-info").execute({ include_stats: true })) as any;
    expectScopedMap(r.map);
    // stats stays a vault-wide aggregate (pre-existing behaviour) minus every
    // note a private tag hides: Mixed AND the capture-only Cap → 1.
    expect(r.stats.totalNotes).toBe(1);
    expect(r.stats.topTags.map((t: any) => t.tag)).not.toContain("capture");
    expect(JSON.stringify(r.stats)).not.toContain("capture");
  });

  test("MCP vault-info: naming the private tag restores the counts", async () => {
    await seed(["capture"]);
    const r = (await tool(["project", "capture"], "vault-info").execute({ include_stats: true })) as any;
    expect(r.map.total_notes).toBe(3);
    expect(r.stats.totalNotes).toBe(3);
  });

  test("MCP vault-info: unscoped is unchanged", async () => {
    await seed(["capture"]);
    const r = (await tool(null, "vault-info").execute({ include_stats: true })) as any;
    expect(r.map.total_notes).toBe(3);
    expect(r.stats.totalNotes).toBe(3);
  });

  test("regression: no private_tags → scoped map is the old any-match rollup", async () => {
    await seed(undefined);
    const r = (await tool(["project"], "vault-info").execute({})) as any;
    expect(r.map.total_notes).toBe(2);
  });

  test("REST GET /vault map + include_stats", async () => {
    const { store } = await seed(["capture"]);
    const body = await restVault(store, ["project"], "?include_stats=true");
    expectScopedMap(body.map);
    expect(body.stats.totalNotes).toBe(1);
    const owner = await restVault(store, null, "?include_stats=true");
    expect(owner.map.total_notes).toBe(3);
    expect(owner.stats.totalNotes).toBe(3);
  });

  test("connect-time brief counts exclude hidden notes", async () => {
    await seed(["capture"]);
    const scoped = await getServerInstruction(V, authFor(["project"]));
    expect(scoped).toContain("- 1 note, 1 tag total");
    const owner = await getServerInstruction(V, authFor(null));
    expect(owner).toContain("- 3 notes,");
  });
});

// ---------------------------------------------------------------------------
// Must-fix 2 — parser fails closed
// ---------------------------------------------------------------------------

describe("must-fix 2: private_tags parsing", () => {
  test("accepted shapes", () => {
    const ok = (y: string) => parsePrivateTags(y);
    expect(ok("name: x\n")).toEqual({ kind: "absent" });
    expect(ok("private_tags: capture\n")).toEqual({ kind: "ok", tags: ["capture"] });
    expect(ok("private_tags: capture # secret stuff\n")).toEqual({ kind: "ok", tags: ["capture"] });
    expect(ok("private_tags: [capture, \"transcript\"]  # c\n")).toEqual({ kind: "ok", tags: ["capture", "transcript"] });
    expect(ok("private_tags: # the list\n  - capture # voice\n  - 'transcript'\nname: x\n")).toEqual({
      kind: "ok",
      tags: ["capture", "transcript"],
    });
    expect(ok("private_tags:\n- capture\n- capture/voice\nname: x\n")).toEqual({ kind: "ok", tags: ["capture", "capture/voice"] });
    expect(ok("private_tags: []\n")).toEqual({ kind: "ok", tags: [] });
  });

  test("private_tags text inside top-level block scalars is not a key", () => {
    for (const key of ["description", "instructions"]) {
      for (const style of ["|", ">", "|-", ">+", "|2", ">2- # comment"]) {
        const yaml = `${key}: ${style}\n  notes\n\n  private_tags: [x]\n  'private_tags': [y]\nname: x\n`;
        expect(parsePrivateTags(yaml)).toEqual({ kind: "absent" });
        expect(parsePrivateTags(yaml + "private_tags: [real]\n")).toEqual({ kind: "ok", tags: ["real"] });
      }
    }
  });

  test("description containing private_tags round-trips without stray lines", () => {
    writeVaultConfig({ ...baseConfig(), description: "notes\nprivate_tags: [x]" });
    expect(readPrivateTagsConfig(V)).toEqual({ kind: "absent" });
    const config = readVaultConfig(V)!;
    expect(config.private_tags_raw).toBeUndefined();
    writeVaultConfig({ ...config, audio_retention: "keep" });
    const first = readFileSync(vaultConfigPath(V), "utf-8");
    writeVaultConfig(readVaultConfig(V)!);
    expect(readFileSync(vaultConfigPath(V), "utf-8")).toBe(first);
    expect(first.match(/private_tags:/g)).toHaveLength(1);
    expect(readPrivateTagsConfig(V)).toEqual({ kind: "absent" });
  });

  test("indented keys refuse relocation; quoted keys retain raw text", () => {
    for (const key of ["  private_tags", "'private_tags'", '"private_tags"']) {
      const yaml = `description: |\n  notes\nname: x\n${key}: [capture]\n`;
      expect(parsePrivateTags(yaml)).toEqual({
        kind: "invalid", reason: "private_tags key is indented or quoted",
        raw: key.startsWith(" ") ? "" : `${key}: [capture]`,
      });
    }
  });

  const unreadableMessage = "vault.yaml has an unreadable private_tags key; fix it by hand before editing this vault's config";

  for (const quote of ['"', "'"]) {
    for (const value of [" [secret]", "\n  - secret\n  # keep this comment\n  - capture", "\n- secret\n- capture"]) {
      test(`quoted key survives a normal config update: ${quote} ${JSON.stringify(value)}`, () => {
        const block = `${quote}private_tags${quote}:${value}`;
        writeRawConfig(block + "\naudio_retention: keep\n");
        expect(readPrivateTagsConfig(V).kind).toBe("invalid");
        const config = readVaultConfig(V)!;
        expect(config.private_tags_raw).toBe(block);
        writeVaultConfig({ ...config, description: "edited" });
        expect(readFileSync(vaultConfigPath(V), "utf-8")).toContain(block + "\n");
        expect(readPrivateTagsConfig(V).kind).toBe("invalid");
      });
    }
  }

  test("indented key refuses a normal config update without changing disk", () => {
    writeRawConfig("  private_tags: [secret]");
    const before = readFileSync(vaultConfigPath(V), "utf-8");
    expect(readPrivateTagsConfig(V).kind).toBe("invalid");
    expect(() => writeVaultConfig({ ...readVaultConfig(V)!, description: "edited" })).toThrow(unreadableMessage);
    expect(readFileSync(vaultConfigPath(V), "utf-8")).toBe(before);
    expect(readPrivateTagsConfig(V).kind).toBe("invalid");
  });

  test("MCP description edit returns a tool error for an indented key", async () => {
    writeRawConfig("  private_tags: [secret]");
    const before = readFileSync(vaultConfigPath(V), "utf-8");
    const res = await handleScopedMcp(new Request(`http://localhost/vault/${V}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "vault-info", arguments: { description: "edited" } } }),
    }), V, authFor(null));
    const body = await res.json() as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain(unreadableMessage);
    expect(readFileSync(vaultConfigPath(V), "utf-8")).toBe(before);
  });

  test("REST description edit returns 409 for an indented key", async () => {
    writeRawConfig("  private_tags: [secret]");
    const before = readFileSync(vaultConfigPath(V), "utf-8");
    const config = readVaultConfig(V)!;
    const res = await handleVault(new Request(`http://localhost/vault/${V}/api/vault`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "edited" }),
    }), getVaultStore(V), config, () => writeVaultConfig(config));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: unreadableMessage });
    expect(readFileSync(vaultConfigPath(V), "utf-8")).toBe(before);
  });

  test("legacy YAML-key auth returns 409 when its timestamp write is refused", async () => {
    writeVaultConfig({ ...baseConfig(), api_keys: [{ id: "legacy", label: "test", scope: "read",
      key_hash: hashKey("legacy-test-key"), created_at: new Date().toISOString() }] });
    const p = vaultConfigPath(V);
    const before = readFileSync(p, "utf-8") + "  private_tags: [secret]\n";
    writeFileSync(p, before);
    const result = await authenticateVaultRequest(new Request("http://localhost", {
      headers: { authorization: "Bearer legacy-test-key" },
    }), readVaultConfig(V)!);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected authentication error");
    expect(result.error.status).toBe(409);
    expect(await result.error.json()).toEqual({ error: unreadableMessage });
    expect(readFileSync(p, "utf-8")).toBe(before);
  });

  test("present-but-unreadable shapes are invalid, never []", () => {
    for (const y of [
      "private_tags: [capture, transcript\n", // unterminated flow list
      "private_tags: capture transcript\n", // scalar with a space
      "private_tags:\n  capture\n", // missing dash
      "private_tags:\n  - capture\n  - two words\n",
      "private_tags: capture\nprivate_tags: other\n", // duplicate key
      "private_tags: {capture: true}\n",
      "  private_tags: [capture]\n", // indented key
    ]) {
      expect(parsePrivateTags(y).kind).toBe("invalid");
    }
  });

  test("scalar and trailing-comment forms actually hide the mixed note", async () => {
    for (const block of ["private_tags: capture", "private_tags: capture   # hide raw captures", "private_tags: [capture] # c"]) {
      clearVaultStoreCache();
      rmSync(join(tmpHome, "vault", "data"), { recursive: true, force: true });
      mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
      const { store } = await seed(undefined);
      writeRawConfig(block);
      expect(paths(await tool(["project"], "query-notes").execute({}))).toEqual(["Shared"]);
      void store;
    }
  });

  test("unparseable key → scoped token sees nothing (list, get, map, tags, write)", async () => {
    const { shared } = await seed(undefined);
    writeRawConfig("private_tags: [capture, transcript");
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    try {
      expect(paths(await tool(["project"], "query-notes").execute({}))).toEqual([]);
      const get = (await tool(["project"], "query-notes").execute({ id: shared.id })) as any;
      expect(get.error_type).toBe("not_found");
      const info = (await tool(["project"], "vault-info").execute({ include_stats: true })) as any;
      expect(info.map.total_notes).toBe(0);
      expect(info.stats.totalNotes).toBe(0);
      expect((await tool(["project"], "list-tags").execute({})) as any[]).toEqual([]);
      const write = (await tool(["project"], "create-note").execute({ content: "x", tags: ["project"] })) as any;
      expect(write.error ?? write.error_type).toBeDefined();
    } finally {
      console.warn = origWarn;
    }
    expect(warns.some((w) => w.includes("private_tags") && w.includes("CLOSED"))).toBe(true);
    // Unscoped is unaffected.
    expect(paths(await tool(null, "query-notes").execute({}))).toEqual(["Cap", "Mixed/Diary", "Shared"]);
  });

  test("REST: unparseable key → scoped list empty, unscoped full", async () => {
    const { store } = await seed(undefined);
    writeRawConfig("private_tags:\n  capture\n");
    const ctx = await restCtx(store, ["project"]);
    expect(ctx.allowed instanceof TagScopeSet && ctx.allowed.denyAll).toBe(true);
    const res = await handleNotes(new Request(`http://localhost/vault/${V}/api/notes`), store, "", V, ctx);
    expect(paths(await res.json())).toEqual([]);
    const owner = await handleNotes(new Request(`http://localhost/vault/${V}/api/notes`), store, "", V, await restCtx(store, null));
    expect(paths(await owner.json())).toEqual(["Cap", "Mixed/Diary", "Shared"]);
  });

  test("vault.yaml that exists but can't be read → fail closed", async () => {
    await seed(undefined);
    const p = vaultConfigPath(V);
    rmSync(p);
    mkdirSync(p); // a directory where the file should be → readFileSync throws
    const store = getVaultStore(V);
    const allowed = await expandTokenTagScope(store, ["project"]);
    expect(allowed instanceof TagScopeSet && allowed.denyAll).toBe(true);
    expect(paths(await tool(["project"], "query-notes").execute({}))).toEqual([]);
  });

  test("missing vault.yaml → nothing private (not fail-closed)", async () => {
    await seed(undefined);
    rmSync(vaultConfigPath(V));
    const allowed = await expandTokenTagScope(getVaultStore(V), ["project"]);
    expect(allowed instanceof TagScopeSet && allowed.denyAll).toBe(false);
  });

  test("store not bound to a vault name → fail closed; explicit [] opts out", async () => {
    const store = new BunStore(new Database(":memory:"));
    const allowed = await expandTokenTagScope(store, ["project"]);
    expect(allowed instanceof TagScopeSet && allowed.denyAll).toBe(true);
    const explicit = await expandTokenTagScope(store, ["project"], []);
    expect(explicit instanceof TagScopeSet && explicit.denyAll).toBe(false);
    expect(await expandTokenTagScope(store, null)).toBeNull();
  });

  test("an unparseable key survives a config round-trip (writing another field doesn't erase it)", async () => {
    await seed(undefined);
    writeRawConfig("private_tags: [capture, transcript");
    const cfg = readVaultConfig(V)!;
    expect(cfg.private_tags).toBeUndefined();
    expect(cfg.private_tags_error).toBeDefined();
    writeVaultConfig({ ...cfg, description: "edited" });
    expect(parsePrivateTags(require("fs").readFileSync(vaultConfigPath(V), "utf-8")).kind).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// Must-fix 3 — doctor
// ---------------------------------------------------------------------------

describe("must-fix 3: doctor honors the private-tags deny", () => {
  async function seedDoctor() {
    const { store } = await seed(["capture"]);
    await store.upsertTagRecord("project", { fields: { n: { type: "integer", indexed: true } } } as any);
    // Poison value on the HIDDEN mixed note only (raw write bypasses the
    // indexed-type rejection so the doctor finding has something to find).
    const mixed = await store.createNote("hidden mismatch", { id: "hidden-mm", path: "Mixed/Two", tags: ["project", "capture"] });
    store.db.prepare("UPDATE notes SET metadata = ? WHERE id = ?").run(JSON.stringify({ n: "bad" }), mixed.id);
    return store;
  }

  test("MCP doctor: scoped run doesn't surface the hidden note", async () => {
    await seedDoctor();
    const scoped = (await tool(["project"], "doctor").execute({})) as any;
    expect(JSON.stringify(scoped.findings)).not.toContain("hidden-mm");
    expect(scoped.findings.find((f: any) => f.type === "mixed_type_indexed_field")).toBeUndefined();
    // Control: naming capture (or unscoped) surfaces it.
    const named = (await tool(["project", "capture"], "doctor").execute({})) as any;
    expect(JSON.stringify(named.findings)).toContain("hidden-mm");
  });

  test("REST doctor: same", async () => {
    const store = await seedDoctor();
    const res = await handleDoctor(new Request(`http://localhost/vault/${V}/api/doctor`), store, await restCtx(store, ["project"]));
    const body = (await res.json()) as any;
    expect(JSON.stringify(body.findings)).not.toContain("hidden-mm");
    const owner = await handleDoctor(new Request(`http://localhost/vault/${V}/api/doctor`), store, await restCtx(store, null));
    expect(JSON.stringify(((await owner.json()) as any).findings)).toContain("hidden-mm");
  });
});

// ---------------------------------------------------------------------------
// Read paths the original suite didn't cover
// ---------------------------------------------------------------------------

describe("private_tags: near / expand_links / aggregate / versions / semantic", () => {
  test("near: hidden neighbor excluded; hidden anchor is not_found", async () => {
    const { shared, mixed } = await seed(["capture"]);
    const near = await tool(["project"], "query-notes").execute({ near: { note_id: shared.id, depth: 2 } });
    expect(JSON.stringify(near)).not.toContain(mixed.id);
    expect(paths(near)).toEqual(["Shared"]);
    const anchored = (await tool(["project"], "query-notes").execute({ near: { note_id: mixed.id } })) as any;
    expect(JSON.stringify(anchored)).not.toContain("diary");
    expect(Array.isArray(anchored) ? anchored.length : anchored.error_type).toBeTruthy();
    // Control: with capture named the neighbor shows up.
    const named = await tool(["project", "capture"], "query-notes").execute({ near: { note_id: shared.id, depth: 2 } });
    expect(JSON.stringify(named)).toContain(mixed.id);
  });

  test("expand_links: a hidden wikilink target is not inlined", async () => {
    const { shared } = await seed(["capture"]);
    const r = (await tool(["project"], "query-notes").execute({ id: shared.id, expand_links: true })) as any;
    expect(r.content).not.toContain("private widget diary");
    const named = (await tool(["project", "capture"], "query-notes").execute({ id: shared.id, expand_links: true })) as any;
    expect(named.content).toContain("private widget diary");
  });

  test("aggregate count and group_by tag exclude hidden notes", async () => {
    await seed(["capture"]);
    const total = await tool(["project"], "query-notes").execute({ aggregate: { op: "count" } });
    expect(total).toEqual([{ group: null, value: 1 }]);
    const byTag = (await tool(["project"], "query-notes").execute({ aggregate: { op: "count", group_by: "tag" } })) as any[];
    expect(byTag).toEqual([{ group: "project", value: 1 }]);
    const named = await tool(["project", "capture"], "query-notes").execute({ aggregate: { op: "count" } });
    expect(named).toEqual([{ group: null, value: 3 }]);
  });

  test("versions: history of a hidden note is not_found", async () => {
    const { store, mixed } = await seed(["capture"]);
    await store.updateNote(mixed.id, { content: "private widget diary v2" });
    const r = (await tool(["project"], "query-notes").execute({ versions: { note_id: mixed.id } })) as any;
    expect(r.error_type).toBe("not_found");
    expect(JSON.stringify(r)).not.toContain("diary");
    const named = (await tool(["project", "capture"], "query-notes").execute({ versions: { note_id: mixed.id } })) as any;
    expect(named.error_type).toBeUndefined();
  });

  test("semantic (mocked embedder): hidden note excluded from near_text results", async () => {
    // No real model in tests: a deterministic mock provider + hand-inserted
    // vectors on an unbound in-memory store; private_tags passed explicitly.
    class Mock implements EmbeddingProvider {
      readonly name = "mock";
      readonly model = "mock-model";
      readonly dims = 4;
      async embed(input: EmbedInput): Promise<EmbedResult> {
        return { vectors: input.texts.map(() => new Float32Array([1, 0, 0, 0])), model: this.model, dims: this.dims };
      }
      async available(): Promise<ProviderAvailability> {
        return { ok: true };
      }
    }
    const db = new Database(":memory:");
    const store = new BunStore(db, { embeddingProvider: new Mock() });
    const a = await store.createNote("shared", { path: "Shared", tags: ["project"] });
    const b = await store.createNote("diary", { path: "Mixed", tags: ["project", "capture"] });
    for (const n of [a, b]) {
      db.prepare(
        `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, ?, ?, ?)`,
      ).run(n.id, encodeVector(normalize(new Float32Array([1, 0, 0, 0]))), 4, "mock-model", "h", new Date().toISOString());
    }
    const get = async (scoped: string[] | null, priv: string[]) => {
      const ctx: TagScopeCtx = { allowed: await expandTokenTagScope(store, scoped, priv), raw: scoped };
      const res = await handleNotes(new Request(`http://localhost/api/notes?semantic=true&near_text=x`), store, "", V, ctx);
      return paths(await res.json());
    };
    expect(await get(["project"], ["capture"])).toEqual(["Shared"]);
    expect(await get(["project", "capture"], ["capture"])).toEqual(["Mixed", "Shared"]);
    expect(await get(["project"], [])).toEqual(["Mixed", "Shared"]);
    db.close();
  });
});
