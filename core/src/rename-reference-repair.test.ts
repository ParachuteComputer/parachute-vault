import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";

let store: SqliteStore;

beforeEach(async () => {
  store = new SqliteStore(new Database(":memory:"));
  await store.upsertTagSchema("task", {
    fields: {
      node: { type: "reference", indexed: true },
      deps: { type: "reference", cardinality: "many" },
      label: { type: "string" },
    },
  });
});

const outbound = async (id: string) =>
  (await store.getLinks(id, { direction: "outbound" })).map((l) => [l.relationship, l.targetId]);

describe("rename repairs reference-field metadata (path change)", () => {
  it("rewrites a scalar reference holding the old path, bumps attribution, captures history", async () => {
    const parent = await store.createNote("p", { path: "Projects/Old" });
    const child = await store.createNote("c", { tags: ["task"], metadata: { node: "Projects/Old" } });
    const before = (await store.getNote(child.id))!;
    await new Promise((r) => setTimeout(r, 5));

    await store.updateNote(parent.id, { path: "Projects/New", actor: "alice", via: "mcp" });

    const after = (await store.getNote(child.id))!;
    expect(after.metadata!.node).toBe("Projects/New");
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect(await outbound(child.id)).toEqual([["node", parent.id]]);
    const versions = await store.listNoteVersions(child.id);
    expect(JSON.stringify(versions)).toContain("cascade-rename");
  });

  it("matches the old path case-insensitively", async () => {
    const parent = await store.createNote("p", { path: "Projects/Old" });
    const child = await store.createNote("c", { tags: ["task"], metadata: { node: "projects/old" } });
    await store.updateNote(parent.id, { path: "Projects/New" });
    expect((await store.getNote(child.id))!.metadata!.node).toBe("Projects/New");
  });

  it("rewrites matching elements of a many-cardinality array, leaving others", async () => {
    const parent = await store.createNote("p", { path: "Projects/Old" });
    const other = await store.createNote("o", { path: "Projects/Other" });
    const child = await store.createNote("c", {
      tags: ["task"],
      metadata: { deps: ["Projects/Other", "Projects/Old", other.id] },
    });
    await store.updateNote(parent.id, { path: "Projects/New" });
    expect((await store.getNote(child.id))!.metadata!.deps).toEqual([
      "Projects/Other", "Projects/New", other.id,
    ]);
  });

  it("leaves an id-valued reference untouched", async () => {
    const parent = await store.createNote("p", { path: "Projects/Old" });
    const child = await store.createNote("c", { tags: ["task"], metadata: { node: parent.id } });
    const before = (await store.getNote(child.id))!;
    await store.updateNote(parent.id, { path: "Projects/New" });
    const after = (await store.getNote(child.id))!;
    expect(after.metadata!.node).toBe(parent.id);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("leaves a title-valued reference untouched", async () => {
    const parent = await store.createNote("p", { path: "Projects/Old" });
    const child = await store.createNote("c", { tags: ["task"], metadata: { node: "Old" } });
    await store.updateNote(parent.id, { path: "Projects/New" });
    expect((await store.getNote(child.id))!.metadata!.node).toBe("Old");
  });

  it("leaves a field not declared type:reference untouched", async () => {
    const parent = await store.createNote("p", { path: "Projects/Old" });
    const child = await store.createNote("c", { tags: ["task"], metadata: { label: "Projects/Old" } });
    await store.updateNote(parent.id, { path: "Projects/New" });
    expect((await store.getNote(child.id))!.metadata!.label).toBe("Projects/Old");
  });

  it("leaves a reference field whose source note does not carry the declaring tag untouched", async () => {
    const parent = await store.createNote("p", { path: "Projects/Old" });
    // Link edge named `node` exists via structured link, but no tag declares it.
    const child = await store.createNote("c", { metadata: { node: "Projects/Old" } });
    await store.createLink(child.id, parent.id, "node");
    await store.updateNote(parent.id, { path: "Projects/New" });
    expect((await store.getNote(child.id))!.metadata!.node).toBe("Projects/Old");
  });

  it("mirrors the wikilink cascade's visibility policy: store-level, hidden-tag sources are repaired too", async () => {
    // The wikilink cascade is a store-level index repair with no scope
    // filter (a scoped token cannot see the writes, but stale paths in
    // notes it can't see would otherwise silently break). The reference
    // repair follows the same policy.
    await store.upsertTagSchema("secret", { fields: { node: { type: "reference" } } });
    const parent = await store.createNote("p", { path: "Projects/Old" });
    const hidden = await store.createNote("h", { tags: ["secret"], metadata: { node: "Projects/Old" } });
    const wl = await store.createNote("see [[Projects/Old]]", { tags: ["secret"] });
    await store.updateNote(parent.id, { path: "Projects/New" });
    expect((await store.getNote(wl.id))!.content).toBe("see [[Projects/New]]");
    expect((await store.getNote(hidden.id))!.metadata!.node).toBe("Projects/New");
  });

  it("query by the new path (indexed generated column) finds the child after rename", async () => {
    const tools = generateMcpTools(store);
    await tools.find((t) => t.name === "update-tag")!.execute({
      tag: "task", fields: { node: { type: "reference", indexed: true } },
    });
    const parent = await store.createNote("p", { path: "Projects/Old" });
    const child = await store.createNote("c", { tags: ["task"], metadata: { node: "Projects/Old" } });
    await store.updateNote(parent.id, { path: "Projects/New" });
    const query = tools.find((t) => t.name === "query-notes")!;
    const hit = await query.execute({ metadata: { node: { in: ["Projects/New"] } } }) as any[];
    expect(hit.map((n) => n.id)).toEqual([child.id]);
    const miss = await query.execute({ metadata: { node: { in: ["Projects/Old"] } } }) as any[];
    expect(miss).toEqual([]);
  });

  it("is a no-op when the path does not actually change", async () => {
    const parent = await store.createNote("p", { path: "Projects/Old" });
    const child = await store.createNote("c", { tags: ["task"], metadata: { node: "Projects/Old" } });
    const before = (await store.getNote(child.id))!;
    await store.updateNote(parent.id, { path: "Projects/Old", content: "edit" });
    expect((await store.getNote(child.id))!.updatedAt).toBe(before.updatedAt);
  });

  it("repairs two notes renamed in sequence (batch/folder style), including a chained rename", async () => {
    const a = await store.createNote("a", { path: "Projects/A" });
    const b = await store.createNote("b", { path: "Projects/B" });
    const child = await store.createNote("c", {
      tags: ["task"],
      metadata: { node: "Projects/A", deps: ["Projects/B", "Projects/A"] },
    });
    await store.updateNote(a.id, { path: "Archive/A" });
    await store.updateNote(b.id, { path: "Archive/B" });
    let m = (await store.getNote(child.id))!.metadata!;
    expect(m.node).toBe("Archive/A");
    expect(m.deps).toEqual(["Archive/B", "Archive/A"]);
    await store.updateNote(a.id, { path: "Archive/A2" });
    m = (await store.getNote(child.id))!.metadata!;
    expect(m.node).toBe("Archive/A2");
    expect(m.deps).toEqual(["Archive/B", "Archive/A2"]);
  });
});
