/**
 * Vault-level private tags (vault#766).
 *
 * Tag scope is an allow-list with any-match: a note tagged `project` AND
 * `capture` used to be fully visible to a `project`-scoped token. With
 * `private_tags: [capture]` in vault.yaml, deny wins: the note is invisible
 * to any scoped token that does not itself name `capture` (or an ancestor).
 * Unscoped sessions are unaffected.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig, readVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { handleNotes, handleTags, type TagScopeCtx } from "./routes.ts";
import { expandTokenTagScope } from "./tag-scope.ts";
import type { AuthResult } from "./auth.ts";

const V = "priv";
let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-private-tags-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    scopes: [`vault:${V}:read`],
    legacyDerived: false,
    scoped_tags: scopedTags,
    vault_name: null,
    caller_jti: null,
    actor: "test-user",
    via: "api",
  } as AuthResult;
}

/** Seed: one project-only note, one project+capture (mixed) note, one capture-only note. */
async function seed(privateTags: string[] | undefined) {
  writeVaultConfig({
    name: V,
    api_keys: [],
    created_at: new Date().toISOString(),
    ...(privateTags ? { private_tags: privateTags } : {}),
  });
  const store = getVaultStore(V);
  const shared = await store.createNote("shared widget plan", { path: "Shared", tags: ["project"] });
  const mixed = await store.createNote("private widget diary", { path: "Mixed", tags: ["project", "capture"] });
  const cap = await store.createNote("raw widget capture", { path: "Cap", tags: ["capture"] });
  return { store, shared, mixed, cap };
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

async function rest(store: any, scoped: string[] | null, subpath: string, query = "") {
  const req = new Request(`http://localhost/vault/${V}/api/notes${subpath}${query}`);
  const res = await handleNotes(req, store, subpath, V, await restCtx(store, scoped));
  return { status: res.status, body: (await res.json()) as any };
}

describe("config: private_tags round-trips through vault.yaml", () => {
  test("block list written and parsed", () => {
    writeVaultConfig({ name: V, api_keys: [], created_at: new Date().toISOString(), private_tags: ["capture", "transcript"] });
    expect(readVaultConfig(V)?.private_tags).toEqual(["capture", "transcript"]);
  });
  test("absent → undefined", () => {
    writeVaultConfig({ name: V, api_keys: [], created_at: new Date().toISOString() });
    expect(readVaultConfig(V)?.private_tags).toBeUndefined();
  });
});

describe("private_tags: deny wins over scope allow", () => {
  test("MCP list: mixed note hidden from project-scoped token", async () => {
    await seed(["capture"]);
    expect(paths(await tool(["project"], "query-notes").execute({}))).toEqual(["Shared"]);
  });

  test("MCP list: visible when the token also names capture", async () => {
    await seed(["capture"]);
    expect(paths(await tool(["project", "capture"], "query-notes").execute({}))).toEqual(["Cap", "Mixed", "Shared"]);
  });

  test("MCP list: unscoped session still sees everything", async () => {
    await seed(["capture"]);
    expect(paths(await tool(null, "query-notes").execute({}))).toEqual(["Cap", "Mixed", "Shared"]);
  });

  test("regression: no private_tags → mixed note visible to project scope (old any-match)", async () => {
    await seed(undefined);
    expect(paths(await tool(["project"], "query-notes").execute({}))).toEqual(["Mixed", "Shared"]);
  });

  test("MCP FTS search: mixed note hidden; visible with capture named", async () => {
    await seed(["capture"]);
    expect(paths(await tool(["project"], "query-notes").execute({ search: "widget" }))).toEqual(["Shared"]);
    expect(paths(await tool(["project", "capture"], "query-notes").execute({ search: "widget" }))).toEqual(["Cap", "Mixed", "Shared"]);
  });

  test("MCP get-by-id / path: not_found for scoped, content for unscoped", async () => {
    const { mixed } = await seed(["capture"]);
    const byId = (await tool(["project"], "query-notes").execute({ id: mixed.id })) as any;
    expect(byId.error_type).toBe("not_found");
    expect(JSON.stringify(byId)).not.toContain("diary");
    const byPath = (await tool(["project"], "query-notes").execute({ id: "Mixed" })) as any;
    expect(byPath.error_type).toBe("not_found");
    const owner = (await tool(null, "query-notes").execute({ id: mixed.id })) as any;
    expect(owner.content).toBe("private widget diary");
  });

  test("private tag descendants are private too; naming the parent exempts them", async () => {
    const { store } = await seed(["capture"]);
    await store.upsertTagRecord("capture/voice", { parent_names: ["capture"] } as any);
    await store.createNote("voice memo widget", { path: "Voice", tags: ["project", "capture/voice"] });
    // Undeclared string-form sub-tag is covered as well.
    await store.createNote("text memo widget", { path: "Text", tags: ["project", "capture/text"] });
    expect(paths(await tool(["project"], "query-notes").execute({}))).toEqual(["Shared"]);
    expect(paths(await tool(["project", "capture"], "query-notes").execute({}))).toEqual(
      ["Cap", "Mixed", "Shared", "Text", "Voice"],
    );
  });

  test("MCP list-tags: counts exclude notes hidden by private tags", async () => {
    await seed(["capture"]);
    const tags = (await tool(["project"], "list-tags").execute({})) as any[];
    const project = tags.find((t) => t.name === "project");
    expect(tags.map((t) => t.name)).not.toContain("capture");
    expect(project.count).toBe(1);
    expect(project.expanded_count).toBe(1);
  });

  test("REST list / search / get-by-id enforce the same rule", async () => {
    const { store, mixed } = await seed(["capture"]);
    const list = await rest(store, ["project"], "");
    expect(list.status).toBe(200);
    expect(paths(list.body)).toEqual(["Shared"]);
    const search = await rest(store, ["project"], "", "?search=widget");
    expect(paths(search.body)).toEqual(["Shared"]);
    const get = await rest(store, ["project"], `/${mixed.id}`);
    expect(get.status).toBe(404);
    expect(JSON.stringify(get.body)).not.toContain("diary");

    const named = await rest(store, ["project", "capture"], "");
    expect(paths(named.body)).toEqual(["Cap", "Mixed", "Shared"]);
    const namedGet = await rest(store, ["project", "capture"], `/${mixed.id}`);
    expect(namedGet.status).toBe(200);
    const owner = await rest(store, null, "");
    expect(paths(owner.body)).toEqual(["Cap", "Mixed", "Shared"]);
  });

  test("REST list-tags counts exclude hidden notes", async () => {
    const { store } = await seed(["capture"]);
    const req = new Request(`http://localhost/vault/${V}/api/tags`);
    const res = await handleTags(req, store, "", await restCtx(store, ["project"]));
    const body = (await res.json()) as any[];
    expect(body.find((t) => t.name === "project")?.count).toBe(1);
  });
});
