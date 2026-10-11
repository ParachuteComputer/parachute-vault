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
  testHome = mkdtempSync(join(tmpdir(), "near-agg-"));
  previousHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = testHome;
  clearVaultStoreCache();
  writeVaultConfig({ name: "na", api_keys: [], created_at: new Date().toISOString() });
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
    scopes: ["vault:na:read"],
    legacyDerived: false,
    scoped_tags: tags,
    vault_name: null,
    caller_jti: null,
    actor: "test",
    via: "api",
  };
  return generateScopedMcpTools("na", auth).find((t) => t.name === "query-notes")!;
}

async function seed(extraNodeTags: string[] = []) {
  const store = getVaultStore("na");
  await store.upsertTagRecord("task", {
    fields: { owner: { type: "string", indexed: true }, status: { type: "string", indexed: true } },
  });
  const node = (t: string, tags = ["work", "node"]) => store.createNote(t, { tags });
  const task = async (t: string, target: string, owner: string, status: string, tags = ["work", "task"]) => {
    const n = await store.createNote(t, { tags, metadata: { owner, status } });
    await store.createLink(n.id, target, "node");
    return n;
  };
  const R = await node("R"), A = await node("A"), B = await node("B"), C = await node("C");
  const D = await node("D"), E = await node("E");
  await store.createLink(A.id, R.id, "parent");
  await store.createLink(B.id, A.id, "parent");
  await store.createLink(C.id, R.id, "parent");
  await store.createLink(E.id, D.id, "parent");
  await task("t1", A.id, "x", "open");
  await task("t2", B.id, "y", "open");
  await task("t3", C.id, "x", "closed");
  await task("t4", E.id, "x", "open"); // other tree
  await task("t5", R.id, "x", "open"); // anchor itself
  return { store, R, A, B, C, D, E, task, node };
}

const then = { relationship: "node", direction: "inbound" as const };
const mcpQuery = (R: string, extra: any = {}) => ({
  tag: "task",
  metadata: { status: "open" },
  near: { note_id: R, relationship: "parent", direction: "inbound", depth: 5, then },
  aggregate: { group_by: "owner", op: "count" },
  ...extra,
});
function restParams(R: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    tag: "task", "meta[status]": "open",
    "near[note_id]": R, "near[relationship]": "parent", "near[direction]": "inbound", "near[depth]": "5",
    "near[then][relationship]": "node", "near[then][direction]": "inbound",
    "aggregate[group_by]": "owner", "aggregate[op]": "count", ...extra,
  });
}
const rest = (store: any, p: URLSearchParams, scope?: any) =>
  scope
    ? handleNotes(new Request(`http://scratch/api/notes?${p}`), store, "", "na", scope)
    : handleNotes(new Request(`http://scratch/api/notes?${p}`), store, "");
const norm = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.group, r.value]));

test("subtree rollup: counts match ground truth over MCP and REST", async () => {
  const { store, R } = await seed();
  const expected = { x: 2, y: 1 }; // t1 (A), t5 (R) for x; t2 (B) for y. t3 closed, t4 other tree.
  expect(norm(await tool(null).execute(mcpQuery(R.id)) as any[])).toEqual(expected);
  const res = await rest(store, restParams(R.id));
  expect(res.status).toBe(200);
  expect(norm(await res.json())).toEqual(expected);
});

test("subtree rollup: ungrouped count and empty subtree", async () => {
  const { store, R, E } = await seed();
  const q: any = mcpQuery(R.id, { aggregate: { op: "count" } });
  expect(await tool(null).execute(q)).toEqual([{ group: null, value: 3 }]);
  // leaf with no tasks pointing at it inside subtree (parent-inbound of E is empty; E has t4 though)
  const leaf = await store.createNote("lonely", { tags: ["node"] });
  expect(await tool(null).execute({ ...q, near: { note_id: leaf.id, direction: "inbound", then } })).toEqual([{ group: null, value: 0 }]);
});

test("subtree rollup: cycle in parent edges terminates and counts once", async () => {
  const { store, R, A } = await seed();
  await store.createLink(R.id, A.id, "parent"); // R <-> A cycle
  expect(norm(await tool(null).execute(mcpQuery(R.id)) as any[])).toEqual({ x: 2, y: 1 });
});

test("subtree rollup: aggregate is complete, not LIMIT-truncated", async () => {
  const { store, R, A, task } = await seed();
  for (let i = 0; i < 30; i++) await task(`bulk${i}`, A.id, "z", "open");
  const rows = norm(await tool(null).execute(mcpQuery(R.id, { limit: 2 })) as any[]);
  expect(rows.z).toBe(30);
  const res = await rest(store, restParams(R.id, { limit: "2" }));
  expect(norm(await res.json()).z).toBe(30);
});

test("subtree rollup: tag-scoped token cannot count invisible notes or walk through them", async () => {
  const { store, R, A, task, node } = await seed();
  const hiddenNode = await node("H", ["personal", "node"]);
  await store.createLink(hiddenNode.id, A.id, "parent");
  const beyond = await node("beyond", ["work", "node"]);
  await store.createLink(beyond.id, hiddenNode.id, "parent"); // reachable only THROUGH hidden
  await task("viaHiddenNode", hiddenNode.id, "x", "open");
  await task("viaBeyond", beyond.id, "x", "open");
  await task("hiddenTask", A.id, "x", "open", ["personal"]);
  // No `tag` filter here: a scoped token's tag filter is itself intersected with its allowlist.
  const { tag: _t, ...q } = mcpQuery(R.id) as any;
  const unscopedTotal = norm(await tool(null).execute(q) as any[]);
  expect(unscopedTotal.x).toBe(5); // t1, t5, viaHiddenNode, viaBeyond, hiddenTask
  const expected = { x: 2, y: 1 };
  expect(norm(await tool(["work"]).execute(q) as any[])).toEqual(expected);
  const scope = { allowed: new Set(["work"]), raw: ["work"] };
  const rp = restParams(R.id); rp.delete("tag");
  const res = await rest(store, rp, scope);
  expect(res.status).toBe(200);
  expect(norm(await res.json())).toEqual(expected);
  // invisible anchor -> not found, no count leak
  const hiddenAnchorRes = await rest(store, restParams(hiddenNode.id), scope);
  expect(hiddenAnchorRes.status).toBe(404);
  const mcpHidden: any = await tool(["work"]).execute(mcpQuery(hiddenNode.id));
  expect(mcpHidden.error_type).toBe("not_found");
});

test("aggregate + near without `then` also works (direction-limited subtree count)", async () => {
  const { store, R } = await seed();
  const q: any = { near: { note_id: R.id, relationship: "parent", direction: "inbound", depth: 5 }, aggregate: { op: "count" } };
  expect(await tool(null).execute(q)).toEqual([{ group: null, value: 4 }]); // R + A, B, C
  const p = new URLSearchParams({ "near[note_id]": R.id, "near[relationship]": "parent", "near[direction]": "inbound", "near[depth]": "5", "aggregate[op]": "count" });
  expect(await (await rest(store, p)).json()).toEqual([{ group: null, value: 4 }]);
});

test("existing behaviour unchanged: near without aggregate returns notes; aggregate w/o near ignores graph; search/cursor still rejected", async () => {
  const { store, R } = await seed();
  const notes: any = await tool(null).execute({ near: { note_id: R.id, relationship: "parent", direction: "inbound", depth: 5 } });
  expect(notes.length).toBe(4);
  expect(norm(await tool(null).execute({ tag: "task", aggregate: { group_by: "owner", op: "count" } }) as any[])).toEqual({ x: 4, y: 1 });
  await expect(tool(null).execute({ search: "x", near: { note_id: R.id }, aggregate: { op: "count" } })).rejects.toThrow();
  await expect(tool(null).execute({ cursor: "", near: { note_id: R.id }, aggregate: { op: "count" } })).rejects.toThrow();
  const bad = await rest(store, restParams(R.id, { cursor: "" }));
  expect(bad.status).toBe(400);
});

test("`then` validation: bad direction is a 400 (MCP + REST)", async () => {
  const { store, R } = await seed();
  const r1: any = await tool(null).execute({ near: { note_id: R.id, then: { direction: "sideways" } }, aggregate: { op: "count" } });
  expect(r1.error_type).toBe("invalid_query");
  const r2 = await rest(store, restParams(R.id, { "near[then][direction]": "sideways" }));
  expect(r2.status).toBe(400);
});

test("REST near[then][...] without near[note_id] is a 400 with a clear message", async () => {
  const { store } = await seed();
  const p = new URLSearchParams({ tag: "task", "near[then][direction]": "inbound" });
  const res = await rest(store, p);
  expect(res.status).toBe(400);
  const body: any = await res.json();
  expect(body.error_type).toBe("invalid_query");
  expect(body.field).toBe("near");
  expect(body.error).toContain("near[note_id]");
});

test("scoped-token rename repairs reference metadata (store-level, like the wikilink cascade)", async () => {
  const store = getVaultStore("na");
  await store.upsertTagRecord("task", { fields: { node: { type: "reference" } } });
  const parent = await store.createNote("p", { path: "Projects/Old", tags: ["work"] });
  const child = await store.createNote("c", { tags: ["task"], metadata: { node: "Projects/Old" } });
  const update = (() => {
    const auth: AuthResult = {
      permission: "full", scopes: ["vault:na:write"], legacyDerived: false,
      scoped_tags: ["work"], vault_name: null, caller_jti: null, actor: "test", via: "api",
    };
    return generateScopedMcpTools("na", auth).find((t) => t.name === "update-note")!;
  })();
  await update.execute({ id: parent.id, path: "Projects/New", force: true });
  expect((await store.getNote(child.id))!.metadata!.node).toBe("Projects/New");
});
