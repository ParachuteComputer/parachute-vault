import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store";
import { generateMcpTools } from "./mcp";
import { handleNotes } from "../../src/routes";
import { traverseLinks } from "./links";

test("direction constrains every hop; defaults stay symmetric; cycles, depth and scope walls", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  try {
    const [root, a, b, child] = await Promise.all(
      ["root", "a", "b", "child"].map((path) => store.createNote(path, { path, tags: ["node"] })),
    );
    for (const [from, to] of [[a!, root!], [b!, root!], [child!, a!], [a!, child!]]) {
      await store.createLink(from!.id, to!.id, "parent");
    }
    await store.createLink(b!.id, child!.id, "unrelated");
    const ids = (opts: Parameters<typeof traverseLinks>[2]) =>
      traverseLinks(db, a!.id, opts).map((n) => n.noteId).sort();
    expect(ids({ direction: "inbound", relationship: "parent", max_depth: 5 })).toEqual([child!.id]);
    expect(ids({ direction: "outbound", relationship: "parent", max_depth: 5 })).toEqual([root!.id, child!.id].sort());
    expect(ids({ relationship: "parent", max_depth: 5 })).toEqual([root!.id, b!.id, child!.id].sort());
    expect(ids({ direction: "inbound", relationship: "parent", max_depth: 0 })).toEqual([]);
    expect(traverseLinks(db, root!.id, {
      direction: "inbound",
      relationship: "parent",
      max_depth: 5,
      isTraversable: (id) => id !== a!.id,
    }).map((n) => n.noteId)).toEqual([b!.id]);
    const query = generateMcpTools(store).find((t) => t.name === "query-notes")!;
    const result: any = await query.execute({
      tag: "node",
      near: { note_id: a!.id, depth: 5, relationship: "parent", direction: "inbound" },
    });
    expect(result.map((n: any) => n.id).sort()).toEqual([a!.id, child!.id].sort());
    expect((await query.execute({ near: { note_id: a!.id, direction: "sideways" } }) as any).error_type).toBe("invalid_query");
    const response = await handleNotes(
      new Request(`http://scratch/api/notes?tag=node&near[note_id]=${a!.id}&near[relationship]=parent&near[depth]=5&near[direction]=inbound`),
      store,
      "",
    );
    expect(response.status).toBe(200);
    const body: any = await response.json();
    const notes = Array.isArray(body) ? body : body.notes;
    expect(notes.map((n: any) => n.id).sort()).toEqual([a!.id, child!.id].sort());
    const invalidResponse = await handleNotes(
      new Request(`http://scratch/api/notes?near[note_id]=${a!.id}&near[direction]=sideways`),
      store,
      "",
    );
    expect(invalidResponse.status).toBe(400);
  } finally {
    db.close();
  }
});
