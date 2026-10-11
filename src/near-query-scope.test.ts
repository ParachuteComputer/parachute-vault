import { beforeEach, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { handleNotes } from "./routes.ts";
import type { AuthResult } from "./auth.ts";

let testHome: string;
let previousHome: string | undefined;
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "near-query-"));
  previousHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = testHome;
  clearVaultStoreCache();
  writeVaultConfig({ name: "near", api_keys: [], created_at: new Date().toISOString() });
});
afterEach(() => {
  clearVaultStoreCache();
  if (previousHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});
function tool(tags: string[] | null) {
  const auth: AuthResult = {
    permission: "full",
    scopes: ["vault:near:read"],
    legacyDerived: false,
    scoped_tags: tags,
    vault_name: null,
    caller_jti: null,
    actor: "test",
    via: "api",
  };
  return generateScopedMcpTools("near", auth).find((t) => t.name === "query-notes")!;
}
function ids(body: any): string[] {
  return (Array.isArray(body) ? body : body.notes).map((n: any) => n.id);
}

test("REST scopes near before limit and offset, matching MCP with tag and metadata filters", async () => {
  const store = getVaultStore("near");
  const anchor = await store.createNote("anchor", { tags: ["anchor"] });
  for (let i = 0; i < 3; i++) {
    await store.createNote("outside", { tags: ["task"], metadata: { status: "open" }, created_at: `2020-01-0${i + 1}T00:00:00Z` });
  }
  const matches = [];
  for (let i = 0; i < 3; i++) {
    const note = await store.createNote("match", { tags: ["task"], metadata: { status: "open" }, created_at: `2021-01-0${i + 1}T00:00:00Z` });
    await store.createLink(note.id, anchor.id, "parent");
    matches.push(note.id);
  }
  for (const opts of [
    { tags: ["task"], metadata: { status: "closed" } },
    { tags: ["other"], metadata: { status: "open" } },
  ]) {
    const note = await store.createNote("filtered neighbor", { ...opts, created_at: "2019-01-01T00:00:00Z" });
    await store.createLink(note.id, anchor.id, "parent");
  }
  const query = tool(null);
  for (const offset of [undefined, 0, 1, 2]) {
    const params = new URLSearchParams({ tag: "task", "meta[status]": "open", sort: "asc", limit: "2", "near[note_id]": anchor.id, "near[direction]": "inbound" });
    if (offset !== undefined) params.set("offset", String(offset));
    const response = await handleNotes(new Request(`http://scratch/api/notes?${params}`), store, "");
    expect(response.status).toBe(200);
    const body = await response.json();
    if (offset === undefined) {
      const warnings = JSON.parse(decodeURIComponent(response.headers.get("X-Parachute-Warnings")!));
      expect(warnings).toContainEqual(expect.objectContaining({ code: "truncated", limit: 2 }));
    } else {
      expect(response.headers.has("X-Parachute-Warnings")).toBe(false);
    }
    expect(Array.isArray(body)).toBe(true);
    const restIds = ids(body);
    expect(restIds).toEqual(matches.slice(offset ?? 0, (offset ?? 0) + 2));
    expect(restIds).toEqual(ids(await query.execute({ tag: "task", metadata: { status: "open" }, sort: "asc", limit: 2, offset, near: { note_id: anchor.id, direction: "inbound" } })));
  }
});

test("tag-scoped MCP and REST inbound traversal stops at invisible notes at every hop", async () => {
  const store = getVaultStore("near");
  const anchor = await store.createNote("anchor", { tags: ["work"] });
  const child = await store.createNote("child", { tags: ["work"] });
  const hidden = await store.createNote("hidden", { tags: ["personal"] });
  const beyond = await store.createNote("beyond", { tags: ["work"] });
  const outbound = await store.createNote("outbound", { tags: ["work"] });
  await store.createLink(child.id, anchor.id, "parent");
  await store.createLink(hidden.id, child.id, "parent");
  await store.createLink(beyond.id, hidden.id, "parent");
  await store.createLink(anchor.id, outbound.id, "parent");
  const scope = { allowed: new Set(["work"]), raw: ["work"] };
  const query = tool(["work"]);
  const params = new URLSearchParams({ "near[note_id]": anchor.id, "near[direction]": "inbound", "near[depth]": "5", "near[relationship]": "parent" });
  const response = await handleNotes(new Request(`http://scratch/api/notes?${params}`), store, "", "near", scope);
  expect(response.status).toBe(200);
  const expected = [anchor.id, child.id].sort();
  expect(ids(await response.json()).sort()).toEqual(expected);
  expect(ids(await query.execute({ near: { note_id: anchor.id, direction: "inbound", depth: 5, relationship: "parent" } })).sort()).toEqual(expected);
  params.set("near[note_id]", hidden.id);
  expect((await handleNotes(new Request(`http://scratch/api/notes?${params}`), store, "", "near", scope)).status).toBe(404);
});
