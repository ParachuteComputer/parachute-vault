import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import { getLinkCounts } from "./links.js";

// Feature: link-count field (`include_link_count` / `linkCount`) +
// `order_by=link_count` (vault feedback #4).
//
// LOCKED SEMANTICS exercised here:
//   - degree = row count = (#rows source_id=id) + (#rows target_id=id)
//   - both directions by default; outbound/inbound variants
//   - self-loop (source_id==target_id) counts as degree 2 under `both`
//   - the order_by sort key uses the SAME directional-sum definition, so
//     field value == sort key for EVERY note, self-loops included
//   - two typed links between the same pair count as 2 (row count)

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("getLinkCounts (core helper)", () => {
  it("counts both directions as a row sum", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    await store.createNote("C", { id: "c" });
    // a → b, a → c  (a outbound 2)
    // c → a          (a inbound 1)  => a degree 3
    await store.createLink("a", "b", "mentions");
    await store.createLink("a", "c", "mentions");
    await store.createLink("c", "a", "mentions");

    const both = getLinkCounts(db, ["a", "b", "c"]);
    expect(both.get("a")).toBe(3); // 2 outbound + 1 inbound
    expect(both.get("b")).toBe(1); // 1 inbound
    expect(both.get("c")).toBe(2); // 1 outbound (c→a) + 1 inbound (a→c)
  });

  it("outbound and inbound variants count only one direction", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    await store.createLink("a", "b", "mentions"); // a outbound, b inbound

    expect(getLinkCounts(db, ["a"], "outbound").get("a")).toBe(1);
    expect(getLinkCounts(db, ["a"], "inbound").get("a")).toBe(0);
    expect(getLinkCounts(db, ["b"], "outbound").get("b")).toBe(0);
    expect(getLinkCounts(db, ["b"], "inbound").get("b")).toBe(1);
  });

  it("returns 0 for ids with no links (id always present in map)", async () => {
    await store.createNote("Lonely", { id: "lonely" });
    const counts = getLinkCounts(db, ["lonely"]);
    expect(counts.get("lonely")).toBe(0);
  });

  it("empty id list → empty map (no query)", () => {
    expect(getLinkCounts(db, []).size).toBe(0);
  });

  it("self-loop counts as degree 2 under both (outbound + inbound)", async () => {
    await store.createNote("S", { id: "s" });
    await store.createLink("s", "s", "relates"); // self-loop

    expect(getLinkCounts(db, ["s"], "both").get("s")).toBe(2);
    expect(getLinkCounts(db, ["s"], "outbound").get("s")).toBe(1);
    expect(getLinkCounts(db, ["s"], "inbound").get("s")).toBe(1);
  });

  it("two typed links between the same pair count as 2 (row count)", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    await store.createLink("a", "b", "mentions");
    await store.createLink("a", "b", "cites"); // same pair, different relationship

    expect(getLinkCounts(db, ["a"], "both").get("a")).toBe(2);
    expect(getLinkCounts(db, ["b"], "both").get("b")).toBe(2);
  });

  it("dedupes repeated ids in the request (no double-count)", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    await store.createLink("a", "b", "mentions");
    const counts = getLinkCounts(db, ["a", "a", "a"]);
    expect(counts.get("a")).toBe(1);
  });

  it("batch correctness over a large page (exceeds the chunk size)", async () => {
    // 1000 notes > the 900-id chunk boundary; each note i links to note 0,
    // so note 0 has inbound degree 999 and every other note has outbound 1.
    for (let i = 0; i < 1000; i++) {
      await store.createNote(`n${i}`, { id: `n${i}` });
    }
    for (let i = 1; i < 1000; i++) {
      await store.createLink(`n${i}`, "n0", "mentions");
    }
    const ids = Array.from({ length: 1000 }, (_, i) => `n${i}`);
    const counts = getLinkCounts(db, ids);
    expect(counts.size).toBe(1000); // every id present even across chunks
    expect(counts.get("n0")).toBe(999); // all inbound
    expect(counts.get("n1")).toBe(1); // one outbound
    expect(counts.get("n999")).toBe(1);
  });
});

describe("order_by=link_count (engine)", () => {
  // Helper: assert the field value (via getLinkCounts, both) equals the
  // sort-key ordering produced by order_by=link_count for EVERY note.
  async function assertFieldEqualsSortOrder(sort: "asc" | "desc") {
    const ordered = await store.queryNotes({ orderBy: "link_count", sort });
    const degrees = getLinkCounts(
      db,
      ordered.map((n) => n.id),
      "both",
    );
    const seq = ordered.map((n) => degrees.get(n.id) ?? 0);
    // The emitted SQL sorts by the same directional-sum degree, so the
    // degree sequence must already be monotonic in the requested direction.
    const sorted = [...seq].sort((a, b) => (sort === "desc" ? b - a : a - b));
    expect(seq).toEqual(sorted);
    return { ordered, degrees };
  }

  it("sorts by degree descending and the field matches the sort key", async () => {
    await store.createNote("Hub", { id: "hub" });
    await store.createNote("Mid", { id: "mid" });
    await store.createNote("Leaf", { id: "leaf" });
    // hub degree 3, mid degree 1, leaf degree 0
    await store.createLink("hub", "mid", "a");
    await store.createLink("hub", "leaf", "b");
    await store.createLink("mid", "hub", "c"); // hub inbound +1 => 3, mid outbound +1 => 2? recount below

    // Recount precisely: hub source: hub→mid, hub→leaf (2); hub target: mid→hub (1) = 3
    // mid source: mid→hub (1); mid target: hub→mid (1) = 2
    // leaf target: hub→leaf (1) = 1
    const { ordered } = await assertFieldEqualsSortOrder("desc");
    expect(ordered.map((n) => n.id)).toEqual(["hub", "mid", "leaf"]);
  });

  it("sorts ascending too", async () => {
    await store.createNote("Hub", { id: "hub" });
    await store.createNote("Leaf", { id: "leaf" });
    await store.createLink("hub", "leaf", "a");
    const { ordered } = await assertFieldEqualsSortOrder("asc");
    // leaf degree 1, hub degree 1 — both 1 here; just assert monotonic + the
    // tiebreaker keeps a deterministic order (created_at asc => hub first).
    expect(ordered.length).toBe(2);
  });

  it("self-loop: linkCount==2 AND its order_by position matches that 2", async () => {
    // selfy has a self-loop (degree 2), plain has one inbound (degree 1),
    // zero has none (degree 0). Descending order must place selfy first,
    // and selfy's field value must be exactly 2 (not 1).
    await store.createNote("Selfy", { id: "selfy" });
    await store.createNote("Plain", { id: "plain" });
    await store.createNote("Zero", { id: "zero" });
    await store.createLink("selfy", "selfy", "loop"); // degree 2
    await store.createLink("zero", "plain", "ref"); // plain inbound 1, zero outbound 1

    const { ordered, degrees } = await assertFieldEqualsSortOrder("desc");
    // selfy degree 2 is the max → first.
    expect(ordered[0]!.id).toBe("selfy");
    expect(degrees.get("selfy")).toBe(2);
    // The field value (2) equals the sort key — selfy outranks plain/zero
    // (both degree 1) precisely because the order_by subquery also counts
    // the self-loop twice. A single OR-COUNT would have made it 1 and tied.
    expect(degrees.get("plain")).toBe(1);
    expect(degrees.get("zero")).toBe(1);
  });

  it("created_at is the stable tiebreaker among equal degrees", async () => {
    // Three zero-degree notes; descending order falls back to created_at
    // descending (the tiebreaker honors direction).
    await store.createNote("First", { id: "first", created_at: "2026-01-01T00:00:00.000Z" });
    await store.createNote("Second", { id: "second", created_at: "2026-01-02T00:00:00.000Z" });
    await store.createNote("Third", { id: "third", created_at: "2026-01-03T00:00:00.000Z" });
    const desc = await store.queryNotes({ orderBy: "link_count", sort: "desc" });
    expect(desc.map((n) => n.id)).toEqual(["third", "second", "first"]);
    const asc = await store.queryNotes({ orderBy: "link_count", sort: "asc" });
    expect(asc.map((n) => n.id)).toEqual(["first", "second", "third"]);
  });

  it("does NOT require the field to be indexed (pseudo-field bypass)", async () => {
    await store.createNote("A", { id: "a" });
    // Would throw FIELD_NOT_INDEXED if it routed through requireIndexedField.
    const results = await store.queryNotes({ orderBy: "link_count" });
    expect(results.length).toBe(1);
  });
});

describe("query-notes MCP surface: include_link_count", () => {
  async function seed() {
    await store.createNote("Hub", { id: "hub" });
    await store.createNote("Leaf", { id: "leaf" });
    await store.createNote("Self", { id: "self" });
    await store.createLink("hub", "leaf", "a"); // hub out 1, leaf in 1
    await store.createLink("leaf", "hub", "b"); // hub in 1, leaf out 1 => both degree 2
    await store.createLink("self", "self", "loop"); // self degree 2
  }

  it("list mode: include_link_count injects linkCount; absent flag → no key", async () => {
    await seed();
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const withCount = (await query.execute({ include_link_count: true })) as any[];
    const hub = withCount.find((n) => n.id === "hub");
    expect(hub.linkCount).toBe(2);
    const self = withCount.find((n) => n.id === "self");
    expect(self.linkCount).toBe(2); // self-loop = 2

    const without = (await query.execute({})) as any[];
    expect(without.every((n) => !("linkCount" in n))).toBe(true);
  });

  it("single-note mode: include_link_count → correct degree", async () => {
    await seed();
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ id: "self", include_link_count: true })) as any;
    expect(result.linkCount).toBe(2);
  });

  it("direction variants on the MCP surface", async () => {
    await seed();
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const out = (await query.execute({
      id: "hub",
      include_link_count: true,
      link_count_direction: "outbound",
    })) as any;
    expect(out.linkCount).toBe(1); // hub→leaf only
    const inb = (await query.execute({
      id: "hub",
      include_link_count: true,
      link_count_direction: "inbound",
    })) as any;
    expect(inb.linkCount).toBe(1); // leaf→hub only
  });

  it("note with 0 links → linkCount: 0", async () => {
    await store.createNote("Lonely", { id: "lonely" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ id: "lonely", include_link_count: true })) as any;
    expect(result.linkCount).toBe(0);
  });

  it("order_by=link_count over MCP: field value == sort key for every note", async () => {
    await seed();
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const ordered = (await query.execute({
      order_by: "link_count",
      sort: "desc",
      include_link_count: true,
    })) as any[];
    // Every note carries linkCount, and the sequence is non-increasing.
    const seq = ordered.map((n) => n.linkCount as number);
    expect(seq).toEqual([...seq].sort((a, b) => b - a));
    // hub (2), leaf (2), self (2) all degree 2 here.
    for (const n of ordered) expect(typeof n.linkCount).toBe("number");
  });
});
