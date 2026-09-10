/**
 * Tag-scope confidentiality of the WRITE-time link warnings (`ambiguous_link`
 * / `unresolved_link`) echoed by `create-note` / `update-note` on BOTH doors.
 *
 * vault#707 closed this oracle on the READ side: `include_ambiguous_links` /
 * `has_ambiguous_links` re-resolve each ambiguous row against an injected
 * `(noteId) => boolean` visibility closure, so a scoped reader gets exactly
 * what an unscoped reader would get on a vault containing only the notes it
 * can see. The write-time `warnings` array carries the SAME vault-wide
 * `candidate_count` and was never narrowed — so a `work`-scoped WRITER who
 * creates a note containing `[[Dup]]` learns from `candidate_count: 2` that a
 * second `Dup` exists in a scope it cannot see.
 *
 * Contract pinned here (identical to vault#707's):
 *   - >=2 visible candidates → `ambiguous_link`, `candidate_count` = the
 *     VISIBLE count.
 *   - exactly 1 visible candidate → not ambiguous in the writer's sub-vault;
 *     no `ambiguous_link` warning at all.
 *   - 0 visible candidates → what an unscoped writer on the sub-vault would
 *     see: an `unresolved_link` (broken) warning, NOT `ambiguous_link`.
 *   - unscoped → byte-identical to before (the control pins below).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { BunStore, getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { handleNotes } from "./routes.ts";
import type { TagScopeCtx } from "./routes.ts";
import { expandTokenTagScope } from "./tag-scope.ts";
import type { AuthResult } from "./auth.ts";

// ---------------------------------------------------------------------------
// MCP door — the scoped tool generator, same harness vault#707's pins use.
// ---------------------------------------------------------------------------

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-write-warn-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function toolsFor(vaultName: string, scopedTags: string[] | null) {
  return generateScopedMcpTools(vaultName, authFor(vaultName, scopedTags));
}

describe("MCP write-time link warnings under tag scope (vault#707 twin)", () => {
  /** `wdup/Dup` in scope; the other Dup(s) carry `otherTags`. */
  async function dupFixture(otherTags: string[][], includeVisible = true) {
    seedVault("journal");
    const store = getVaultStore("journal");
    if (includeVisible) {
      await store.createNote("work dup", { path: "wdup/Dup", tags: ["work"] });
    }
    const hidden = [];
    for (let i = 0; i < otherTags.length; i++) {
      hidden.push(await store.createNote("other dup", { path: `p${i + 1}/Dup`, tags: otherTags[i]! }));
    }
    return { store, hidden };
  }

  test("scoped create-note does NOT report a vault-wide candidate_count for a partly hidden collision", async () => {
    const { hidden } = await dupFixture([["personal"]]);
    const createNote = toolsFor("journal", ["work"]).find((t) => t.name === "create-note")!;

    const result = (await createNote.execute({
      content: "src [[Dup]]",
      path: "work-src",
      tags: ["work"],
    })) as any;

    // Only ONE Dup is visible to `work`, so `[[Dup]]` is not ambiguous at all
    // in this writer's sub-vault.
    const ambiguous = (result.warnings ?? []).filter((w: any) => w.code === "ambiguous_link");
    expect(ambiguous).toEqual([]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("p1/Dup");
    expect(serialized).not.toContain(hidden[0]!.id);
  });

  test("scoped update-note does NOT report a vault-wide candidate_count either", async () => {
    const { store, hidden } = await dupFixture([["personal"]]);
    const note = await store.createNote("plain", { path: "work-src", tags: ["work"] });
    const updateNote = toolsFor("journal", ["work"]).find((t) => t.name === "update-note")!;

    const result = (await updateNote.execute({ id: note.id, content: "src [[Dup]]", force: true })) as any;

    const ambiguous = (result.warnings ?? []).filter((w: any) => w.code === "ambiguous_link");
    expect(ambiguous).toEqual([]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("p1/Dup");
    expect(serialized).not.toContain(hidden[0]!.id);
  });

  test("scoped create-note with ALL candidates hidden sees a BROKEN link, not an ambiguous one", async () => {
    const { hidden } = await dupFixture([["personal"], ["personal"]], /* includeVisible */ false);
    const createNote = toolsFor("journal", ["work"]).find((t) => t.name === "create-note")!;

    const result = (await createNote.execute({
      content: "src [[Dup]]",
      path: "work-src",
      tags: ["work"],
    })) as any;

    const codes = (result.warnings ?? []).map((w: any) => w.code);
    expect(codes).toContain("unresolved_link");
    expect(codes).not.toContain("ambiguous_link");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("candidate_count");
    expect(serialized).not.toContain(hidden[0]!.id);
    expect(serialized).not.toContain(hidden[1]!.id);
  });

  test("POSITIVE CONTROL: a partly-visible 3-way collision reports the VISIBLE count (2)", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("w1", { path: "w1/Dup", tags: ["work"] });
    await store.createNote("w2", { path: "w2/Dup", tags: ["work"] });
    await store.createNote("p1", { path: "p1/Dup", tags: ["personal"] });
    const createNote = toolsFor("journal", ["work"]).find((t) => t.name === "create-note")!;

    const result = (await createNote.execute({
      content: "src [[Dup]]",
      path: "work-src",
      tags: ["work"],
    })) as any;

    const ambiguous = (result.warnings ?? []).filter((w: any) => w.code === "ambiguous_link");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].candidate_count).toBe(2);
  });

  test("UNSCOPED CONTROL: create-note still reports the full vault-wide count (regression)", async () => {
    await dupFixture([["personal"]]);
    const createNote = toolsFor("journal", null).find((t) => t.name === "create-note")!;

    const result = (await createNote.execute({
      content: "src [[Dup]]",
      path: "work-src",
      tags: ["work"],
    })) as any;

    const ambiguous = (result.warnings ?? []).filter((w: any) => w.code === "ambiguous_link");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].candidate_count).toBe(2);
    expect(ambiguous[0].target).toBe("Dup");
  });

  test("UNSCOPED CONTROL: update-note still reports the full vault-wide count (regression)", async () => {
    const { store } = await dupFixture([["personal"]]);
    const note = await store.createNote("plain", { path: "work-src", tags: ["work"] });
    const updateNote = toolsFor("journal", null).find((t) => t.name === "update-note")!;

    const result = (await updateNote.execute({ id: note.id, content: "src [[Dup]]", force: true })) as any;
    const ambiguous = (result.warnings ?? []).filter((w: any) => w.code === "ambiguous_link");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].candidate_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// REST door — handleNotes with a real tag-scope ctx, same harness the
// "HTTP tag-scope confidentiality" block in vault.test.ts uses.
// ---------------------------------------------------------------------------

const BASE = "http://localhost:1940";

function mkReq(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return new Request(`${BASE}${path}`, init);
}

describe("REST write-time link warnings under tag scope (vault#707 twin)", () => {
  let db: Database;
  let store: BunStore;
  let restTmp: string;

  beforeEach(() => {
    restTmp = join(tmpdir(), `vault-write-warn-rest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(restTmp, { recursive: true });
    db = new Database(join(restTmp, "test.db"));
    store = new BunStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(restTmp, { recursive: true, force: true });
  });

  async function scopeCtx(roots: string[]): Promise<TagScopeCtx> {
    return { allowed: await expandTokenTagScope(store, roots), raw: roots };
  }
  const NO_SCOPE: TagScopeCtx = { allowed: null, raw: null };

  test("scoped POST /notes does NOT report a vault-wide candidate_count", async () => {
    await store.createNote("work dup", { path: "wdup/Dup", tags: ["work"] });
    const hidden = await store.createNote("other dup", { path: "p1/Dup", tags: ["personal"] });

    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "src [[Dup]]", path: "work-src", tags: ["work"] }),
      store,
      "",
      "v",
      await scopeCtx(["work"]),
    );
    const body = await res.json() as any;
    const ambiguous = (body.warnings ?? []).filter((w: any) => w.code === "ambiguous_link");
    expect(ambiguous).toEqual([]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("p1/Dup");
    expect(serialized).not.toContain(hidden.id);
  });

  test("scoped PATCH /notes does NOT report a vault-wide candidate_count", async () => {
    await store.createNote("work dup", { path: "wdup/Dup", tags: ["work"] });
    const hidden = await store.createNote("other dup", { path: "p1/Dup", tags: ["personal"] });
    const note = await store.createNote("plain", { path: "work-src", tags: ["work"] });

    const res = await handleNotes(
      mkReq("PATCH", `/notes/${note.id}`, { content: "src [[Dup]]", if_updated_at: note.updatedAt }),
      store,
      `/${note.id}`,
      "v",
      await scopeCtx(["work"]),
    );
    const body = await res.json() as any;
    const ambiguous = (body.warnings ?? []).filter((w: any) => w.code === "ambiguous_link");
    expect(ambiguous).toEqual([]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("p1/Dup");
    expect(serialized).not.toContain(hidden.id);
  });

  test("scoped POST /notes with ALL candidates hidden sees a BROKEN link, not an ambiguous one", async () => {
    const h1 = await store.createNote("p1", { path: "p1/Dup", tags: ["personal"] });
    const h2 = await store.createNote("p2", { path: "p2/Dup", tags: ["personal"] });

    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "src [[Dup]]", path: "work-src", tags: ["work"] }),
      store,
      "",
      "v",
      await scopeCtx(["work"]),
    );
    const body = await res.json() as any;
    const codes = (body.warnings ?? []).map((w: any) => w.code);
    expect(codes).toContain("unresolved_link");
    expect(codes).not.toContain("ambiguous_link");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("candidate_count");
    expect(serialized).not.toContain(h1.id);
    expect(serialized).not.toContain(h2.id);
  });

  test("POSITIVE CONTROL: a partly-visible 3-way collision reports the VISIBLE count (2)", async () => {
    await store.createNote("w1", { path: "w1/Dup", tags: ["work"] });
    await store.createNote("w2", { path: "w2/Dup", tags: ["work"] });
    await store.createNote("p1", { path: "p1/Dup", tags: ["personal"] });

    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "src [[Dup]]", path: "work-src", tags: ["work"] }),
      store,
      "",
      "v",
      await scopeCtx(["work"]),
    );
    const body = await res.json() as any;
    const ambiguous = (body.warnings ?? []).filter((w: any) => w.code === "ambiguous_link");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].candidate_count).toBe(2);
  });

  test("UNSCOPED CONTROL: POST /notes still reports the full vault-wide count (regression)", async () => {
    await store.createNote("work dup", { path: "wdup/Dup", tags: ["work"] });
    await store.createNote("other dup", { path: "p1/Dup", tags: ["personal"] });

    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "src [[Dup]]", path: "work-src", tags: ["work"] }),
      store,
      "",
      "v",
      NO_SCOPE,
    );
    const body = await res.json() as any;
    const ambiguous = (body.warnings ?? []).filter((w: any) => w.code === "ambiguous_link");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].candidate_count).toBe(2);
  });

  test("UNSCOPED CONTROL: PATCH /notes still reports the full vault-wide count (regression)", async () => {
    await store.createNote("work dup", { path: "wdup/Dup", tags: ["work"] });
    await store.createNote("other dup", { path: "p1/Dup", tags: ["personal"] });
    const note = await store.createNote("plain", { path: "work-src", tags: ["work"] });

    const res = await handleNotes(
      mkReq("PATCH", `/notes/${note.id}`, { content: "src [[Dup]]", if_updated_at: note.updatedAt }),
      store,
      `/${note.id}`,
      "v",
      NO_SCOPE,
    );
    const body = await res.json() as any;
    const ambiguous = (body.warnings ?? []).filter((w: any) => w.code === "ambiguous_link");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].candidate_count).toBe(2);
  });
});
