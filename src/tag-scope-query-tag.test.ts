/**
 * vault#675 — a scoped caller must not be able to PROBE for an out-of-scope
 * tag by naming it in a query and reading hit/miss.
 *
 * #568/#674 stopped scoped reads from DISCLOSING an out-of-scope co-tag's
 * name. The oracle left behind: the caller names it itself. A note tagged
 * `["mine","project-manhattan"]` is admitted to a `mine`-scoped token via
 * `mine`, so `?tag=project-manhattan` came back with a row — confirming the
 * guessed name — while `?tag=some-tag-that-does-not-exist` came back empty.
 * No name leaked; membership did. Same on all three doors (REST `?tag=`,
 * MCP `query-notes { tag }`, live subscriptions).
 *
 * The fix (`scopeQueryTags` / `scopeQueryTagParam`, src/tag-scope.ts)
 * rewrites an out-of-scope query tag to a name no note can carry, so an
 * out-of-scope tag behaves EXACTLY as a tag that does not exist. Every test
 * below is written as that comparison — the assertion is not "empty", it is
 * "byte-identical to the nonexistent-tag control" — because equality with
 * the control is the actual security property. `NONEXISTENT` is itself out
 * of scope (every unknown name is), so the two requests differ in exactly
 * one way: whether the named tag exists in the vault.
 *
 * The live-subscription door is covered in `ws-subscribe.test.ts` (it needs
 * a real socket).
 *
 * Fixture + naming follow `tag-scope-note-tags.test.ts`: `mine` is in scope,
 * `project-manhattan` is the out-of-scope tag being probed for. Every test
 * carries an UNSCOPED control — the fix must be invisible to unscoped
 * tokens, which still query the co-tag normally.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { handleNotes, type TagScopeCtx } from "./routes.ts";
import { expandTokenTagScope, OUT_OF_SCOPE_QUERY_TAG } from "./tag-scope.ts";
import { stripTagHash } from "../core/src/tag-hierarchy.ts";
import type { AuthResult } from "./auth.ts";
import type { Store } from "../core/src/types.ts";

const OUT_OF_SCOPE = "project-manhattan";
/** The control: a name that is equally out of scope, but does NOT exist. */
const NONEXISTENT = "tag-that-does-not-exist";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-675-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function seedVault(name: string): Store {
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  return getVaultStore(name);
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
  } as AuthResult;
}

async function restScope(store: Store, scopedTags: string[] | null): Promise<TagScopeCtx> {
  return { allowed: await expandTokenTagScope(store, scopedTags), raw: scopedTags };
}

async function rest(store: Store, scope: TagScopeCtx, query: string): Promise<any> {
  const req = new Request(`http://localhost/vault/v/api/notes${query}`, { method: "GET" });
  const res = await handleNotes(req, store, "", "v", scope);
  return { status: res.status, body: await res.json() };
}

/**
 * The corpus every test probes:
 *   - `CoTagged`  — `["mine", OUT_OF_SCOPE]`: visible via `mine`. THE oracle
 *     — it is the row a probe for `OUT_OF_SCOPE` used to return.
 *   - `MineOnly`  — `["mine"]`: the in-scope baseline.
 *   - `HiddenOnly` — `[OUT_OF_SCOPE]`: already invisible pre-fix.
 */
async function seedCorpus(store: Store): Promise<void> {
  await store.createNote("co-tagged body", { path: "CoTagged", tags: ["mine", OUT_OF_SCOPE] });
  await store.createNote("mine only", { path: "MineOnly", tags: ["mine"] });
  await store.createNote("hidden", { path: "HiddenOnly", tags: [OUT_OF_SCOPE] });
}

const paths = (body: any): string[] =>
  (Array.isArray(body) ? body : (body?.notes ?? [])).map((n: any) => n.path).sort();

describe("vault#675 — the substituted tag itself", () => {
  /**
   * The whole fix rests on two properties of `OUT_OF_SCOPE_QUERY_TAG`, and
   * both fail SILENTLY and CATASTROPHICALLY if someone edits the constant to
   * something more readable. Pinned here rather than trusted:
   *
   *  1. It survives tag normalization. `SqliteStore.normalizeQueryTags` maps
   *     `stripTagHash` over query tags and DROPS the empties; if the
   *     substitute normalized away, `tags` would collapse to `[]`, the tag
   *     filter would be skipped entirely, and an out-of-scope probe would
   *     return the caller's WHOLE visible set instead of nothing.
   *  2. Even a note DELIBERATELY tagged with it can't widen what a scoped
   *     caller sees. The substitution changes which notes the query matches;
   *     it does not touch the result-side scope filter, so a planted decoy is
   *     dropped exactly like any other out-of-scope note.
   */
  test("survives stripTagHash — a tag filter naming it is never normalized away", () => {
    expect(stripTagHash(OUT_OF_SCOPE_QUERY_TAG)).toBe(OUT_OF_SCOPE_QUERY_TAG);
    expect(OUT_OF_SCOPE_QUERY_TAG).not.toBe("");
  });

  test("a note deliberately tagged with it is still invisible to a scoped probe", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    // Storage does not forbid the name (nothing in a real tagging workflow —
    // YAML front-matter, a JSON `tags` array — can produce a NUL, but the
    // store doesn't police it). This is the residual case, and it is inert:
    // the note carries no in-scope tag, so the unchanged result-side filter
    // drops it.
    await store.createNote("decoy", { path: "Decoy", tags: [OUT_OF_SCOPE_QUERY_TAG] });
    const scope = await restScope(store, ["mine"]);

    const probe = await rest(store, scope, `?tag=${OUT_OF_SCOPE}`);
    const control = await rest(store, scope, `?tag=${NONEXISTENT}`);
    expect(probe.body).toEqual(control.body);
    expect(probe.body).toEqual([]);
  });
});

describe("vault#675 — REST door: an out-of-scope query tag matches nothing", () => {
  test("?tag=<out-of-scope> — byte-identical to the same query naming a NONEXISTENT tag", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const scope = await restScope(store, ["mine"]);

    const probe = await rest(store, scope, `?tag=${OUT_OF_SCOPE}`);
    const control = await rest(store, scope, `?tag=${NONEXISTENT}`);

    expect(probe.status).toBe(control.status);
    expect(probe.body).toEqual(control.body);
    expect(probe.body).toEqual([]);
    expect(JSON.stringify(probe.body)).not.toContain(OUT_OF_SCOPE);
  });

  test("?tag=<out-of-scope> UNSCOPED control — the co-tagged note still comes back in full", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const scope = await restScope(store, null);

    const probe = await rest(store, scope, `?tag=${OUT_OF_SCOPE}`);
    expect(paths(probe.body)).toEqual(["CoTagged", "HiddenOnly"]);
  });

  test("tag_match=all — an out-of-scope tag ANDed with an in-scope one still matches nothing", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const scope = await restScope(store, ["mine"]);

    const probe = await rest(store, scope, `?tag=mine&tag=${OUT_OF_SCOPE}&tag_match=all`);
    const control = await rest(store, scope, `?tag=mine&tag=${NONEXISTENT}&tag_match=all`);

    expect(probe.body).toEqual(control.body);
    expect(probe.body).toEqual([]);
  });

  test("tag_match=any — the out-of-scope member contributes nothing, the in-scope member is unaffected", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    // A SECOND in-scope root is what makes `any` an oracle: `OpsCoTagged`
    // is visible via `ops`, so pre-fix the out-of-scope union member pulled
    // it into an answer to a question about `mine`.
    await store.createNote("ops co-tagged", { path: "OpsCoTagged", tags: ["ops", OUT_OF_SCOPE] });
    const scope = await restScope(store, ["mine", "ops"]);

    const probe = await rest(store, scope, `?tag=mine&tag=${OUT_OF_SCOPE}&tag_match=any`);
    const control = await rest(store, scope, `?tag=mine&tag=${NONEXISTENT}&tag_match=any`);

    expect(probe.body).toEqual(control.body);
    expect(paths(probe.body)).toEqual(["CoTagged", "MineOnly"]);
  });

  test("exclude_tag=<out-of-scope> — excludes nothing, exactly as excluding a nonexistent tag does", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const scope = await restScope(store, ["mine"]);

    const probe = await rest(store, scope, `?exclude_tag=${OUT_OF_SCOPE}`);
    const control = await rest(store, scope, `?exclude_tag=${NONEXISTENT}`);

    // Pre-fix this SHRANK the visible set (CoTagged dropped out) — a
    // difference-of-counts oracle on the same tag name.
    expect(probe.body).toEqual(control.body);
    expect(paths(probe.body)).toEqual(["CoTagged", "MineOnly"]);
  });

  test("?search= composes the same way — the FTS branch lowers the same query tags", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const scope = await restScope(store, ["mine"]);

    const probe = await rest(store, scope, `?search=body&tag=${OUT_OF_SCOPE}`);
    const control = await rest(store, scope, `?search=body&tag=${NONEXISTENT}`);

    expect(probe.body).toEqual(control.body);
    expect(paths(probe.body)).toEqual([]);
  });

  test("?format=graph — the graph projection is the same query, so nodes[] is empty too", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const scope = await restScope(store, ["mine"]);

    const probe = await rest(store, scope, `?format=graph&tag=${OUT_OF_SCOPE}`);
    const control = await rest(store, scope, `?format=graph&tag=${NONEXISTENT}`);

    expect(probe.body).toEqual(control.body);
    expect(probe.body.nodes).toEqual([]);
  });

  test("?aggregate[op]=count — the rollup can't be used as a counting oracle either", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const scope = await restScope(store, ["mine"]);

    const probe = await rest(store, scope, `?aggregate[op]=count&tag=${OUT_OF_SCOPE}`);
    const control = await rest(store, scope, `?aggregate[op]=count&tag=${NONEXISTENT}`);

    expect(probe.body).toEqual(control.body);
    expect(probe.body).toEqual([{ group: null, value: 0 }]);
  });

  test("cursor envelope — same shape as the nonexistent-tag control (opaque cursor aside)", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const scope = await restScope(store, ["mine"]);

    const probe = await rest(store, scope, `?tag=${OUT_OF_SCOPE}&cursor=`);
    const control = await rest(store, scope, `?tag=${NONEXISTENT}&cursor=`);

    expect(Object.keys(probe.body).sort()).toEqual(Object.keys(control.body).sort());
    expect(probe.body.notes).toEqual([]);
    // The cursor is opaque and derived from the caller's OWN query string —
    // it carries no vault state. What matters is that it is the watermark of
    // a genuinely empty page, which it is because the query really did match
    // nothing rather than being emptied afterwards.
    expect(typeof probe.body.next_cursor).toBe("string");
  });

  test("an IN-SCOPE query tag is untouched — including the `#`-prefixed form the engine strips", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    await store.createNote("sub", { path: "Sub", tags: ["mine/sub"] });
    const scope = await restScope(store, ["mine"]);

    expect(paths((await rest(store, scope, "?tag=mine")).body)).toEqual(["CoTagged", "MineOnly"]);
    expect(paths((await rest(store, scope, "?tag=%23mine")).body)).toEqual(["CoTagged", "MineOnly"]);
    expect(paths((await rest(store, scope, "?tag=mine/sub")).body)).toEqual(["Sub"]);
  });
});

describe("vault#675 — MCP door: identical semantics (one contract, two doors)", () => {
  function toolset(vaultName: string, scopedTags: string[] | null) {
    const tools = generateScopedMcpTools(vaultName, authFor(vaultName, scopedTags) as any);
    return (name: string) => tools.find((t) => t.name === name)!;
  }

  test("query-notes { tag } — byte-identical to naming a NONEXISTENT tag", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const queryNotes = toolset("v", ["mine"])("query-notes");

    const probe: any = await queryNotes.execute({ tag: OUT_OF_SCOPE });
    const control: any = await queryNotes.execute({ tag: NONEXISTENT });

    expect(probe).toEqual(control);
    expect(paths(probe)).toEqual([]);
    expect(JSON.stringify(probe)).not.toContain(OUT_OF_SCOPE);
  });

  test("query-notes { tag } UNSCOPED control — the co-tagged note still comes back", async () => {
    const store = seedVault("v");
    await seedCorpus(store);

    const probe: any = await toolset("v", null)("query-notes").execute({ tag: OUT_OF_SCOPE });
    expect(paths(probe)).toEqual(["CoTagged", "HiddenOnly"]);
  });

  test("query-notes { tag: [in, out], tag_match: all } — matches nothing", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const queryNotes = toolset("v", ["mine"])("query-notes");

    const probe: any = await queryNotes.execute({ tag: ["mine", OUT_OF_SCOPE], tag_match: "all" });
    const control: any = await queryNotes.execute({ tag: ["mine", NONEXISTENT], tag_match: "all" });

    expect(probe).toEqual(control);
    expect(paths(probe)).toEqual([]);
  });

  test("query-notes { tag: [in, out], tag_match: any } — the in-scope member is unaffected", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    await store.createNote("ops co-tagged", { path: "OpsCoTagged", tags: ["ops", OUT_OF_SCOPE] });
    const queryNotes = toolset("v", ["mine", "ops"])("query-notes");

    const probe: any = await queryNotes.execute({ tag: ["mine", OUT_OF_SCOPE], tag_match: "any" });
    const control: any = await queryNotes.execute({ tag: ["mine", NONEXISTENT], tag_match: "any" });

    expect(probe).toEqual(control);
    expect(paths(probe)).toEqual(["CoTagged", "MineOnly"]);
  });

  test("query-notes { exclude_tags } — excludes nothing", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const queryNotes = toolset("v", ["mine"])("query-notes");

    const probe: any = await queryNotes.execute({ exclude_tags: OUT_OF_SCOPE });
    const control: any = await queryNotes.execute({ exclude_tags: NONEXISTENT });

    expect(probe).toEqual(control);
    expect(paths(probe)).toEqual(["CoTagged", "MineOnly"]);
  });

  test("query-notes aggregate rollup — no counting oracle on this door either", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const queryNotes = toolset("v", ["mine"])("query-notes");

    const probe: any = await queryNotes.execute({ tag: OUT_OF_SCOPE, aggregate: { op: "count" } });
    const control: any = await queryNotes.execute({ tag: NONEXISTENT, aggregate: { op: "count" } });

    expect(probe).toEqual(control);
    expect(probe).toEqual([{ group: null, value: 0 }]);
  });

  test("an IN-SCOPE query tag is untouched on this door too", async () => {
    const store = seedVault("v");
    await seedCorpus(store);
    const queryNotes = toolset("v", ["mine"])("query-notes");

    expect(paths(await queryNotes.execute({ tag: "mine" }))).toEqual(["CoTagged", "MineOnly"]);
    expect(paths(await queryNotes.execute({ tag: "#mine" }))).toEqual(["CoTagged", "MineOnly"]);
  });

  test("BOTH-DOOR PARITY — REST and MCP answer an out-of-scope query tag the same way", async () => {
    const store = seedVault("v");
    await seedCorpus(store);

    const restBody = (await rest(store, await restScope(store, ["mine"]), `?tag=${OUT_OF_SCOPE}`)).body;
    const mcpBody: any = await toolset("v", ["mine"])("query-notes").execute({ tag: OUT_OF_SCOPE });

    expect(paths(mcpBody)).toEqual(paths(restBody));
    expect(paths(restBody)).toEqual([]);
  });
});
