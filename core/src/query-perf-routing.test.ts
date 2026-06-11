/**
 * Regression pins for the 2026-06-10 query-perf work:
 *
 *  1. Plain `{field: value}` metadata equality on an INDEXED field now routes
 *     through the generated column as an index prefilter, keeping the
 *     original json_extract clause as a residual predicate. Results must be
 *     IDENTICAL to the JSON-scan path — property-tested here by giving every
 *     note twin fields (`*_idx` indexed, `*_raw` not) carrying the SAME
 *     value, then asserting every probe returns the same ids through both.
 *
 *  2. Tag membership is a semijoin (no `JOIN note_tags` + `DISTINCT n.*`),
 *     so a note matched by SEVERAL tags in one query must still appear once.
 *
 *  3. `getLinksHydratedForNotes` (the batched include_links path) must agree
 *     with per-note `getLinksHydrated`, including self-loops and links whose
 *     endpoints are both on the page.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { queryNotes } from "./notes.js";
import { getLinksHydrated, getLinksHydratedForNotes } from "./links.js";

let db: Database;
let store: SqliteStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("plain metadata equality: indexed routing is result-identical to the JSON scan", () => {
  /**
   * Edge values exercised through BOTH paths. Some of these never match
   * (today's documented scan behavior — e.g. a JS number binds as its JSON
   * text and SQLite won't equate INTEGER 5 with TEXT '5'); the pin is that
   * indexed routing reproduces the scan's verdict EXACTLY, match or not.
   */
  const STORED_VALUES: unknown[] = [
    "pending",
    "",
    "5",            // numeric-looking string
    5,              // JSON number — affinity edge case vs "5"
    0,
    -1.5,
    true,
    false,
    null,
    "naïve-Ünïcode ✨",
    { nested: { deep: 1 } },
    ["a", "b"],
    undefined,      // field absent from metadata
  ];

  const PROBES: unknown[] = [
    "pending",
    "",
    "5",
    5,
    0,
    -1.5,
    true,
    false,
    null,
    "naïve-Ünïcode ✨",
    "missing-everywhere",
  ];

  async function seedTwinFieldFixture(sqliteType: "string" | "integer") {
    // `status_idx` is indexed (string) via a tag schema; `status_raw` is not.
    await store.upsertTagRecord("thing", {
      fields: { status_idx: { type: sqliteType, indexed: true } },
    });
    for (let i = 0; i < STORED_VALUES.length; i++) {
      const v = STORED_VALUES[i];
      const metadata: Record<string, unknown> = { seq: i };
      if (v !== undefined) {
        metadata.status_idx = v;
        metadata.status_raw = v;
      }
      await store.createNote(`note ${i}`, { tags: ["thing"], metadata });
    }
  }

  for (const sqliteType of ["string", "integer"] as const) {
    it(`every probe matches the same notes through the indexed and scan paths (${sqliteType} column)`, async () => {
      await seedTwinFieldFixture(sqliteType);
      for (const probe of PROBES) {
        const viaIndexed = queryNotes(db, { metadata: { status_idx: probe } }).map((n) => n.id);
        const viaScan = queryNotes(db, { metadata: { status_raw: probe } }).map((n) => n.id);
        expect(viaIndexed).toEqual(viaScan);
      }
    });
  }

  it("string probe on the indexed field actually matches (sanity: not vacuous)", async () => {
    await seedTwinFieldFixture("string");
    const hits = queryNotes(db, { metadata: { status_idx: "pending" } });
    expect(hits.length).toBe(1);
    expect(hits[0]!.metadata?.seq).toBe(0);
  });

  it("indexed plain equality agrees with the operator form for string values", async () => {
    await seedTwinFieldFixture("string");
    for (const probe of ["pending", "", "missing-everywhere", "naïve-Ünïcode ✨"]) {
      const plain = queryNotes(db, { metadata: { status_idx: probe } }).map((n) => n.id);
      const operator = queryNotes(db, { metadata: { status_idx: { eq: probe } } }).map((n) => n.id);
      expect(plain).toEqual(operator);
    }
  });

  it("plain equality on a non-indexed field still works (no FIELD_NOT_INDEXED error)", async () => {
    await store.createNote("a", { metadata: { color: "blue" } });
    await store.createNote("b", { metadata: { color: "red" } });
    const hits = queryNotes(db, { metadata: { color: "blue" } });
    expect(hits.length).toBe(1);
  });
});

describe("tag semijoin: no duplicate rows without DISTINCT", () => {
  it("a note carrying several matching tags appears once under tag_match=any", async () => {
    await store.upsertTagRecord("capture/voice", { parent_names: ["capture"] });
    await store.upsertTagRecord("capture/text", { parent_names: ["capture"] });
    // Tagged with the parent AND two children — the old JOIN produced 3 rows.
    const note = await store.createNote("multi", {
      tags: ["capture", "capture/voice", "capture/text"],
    });
    await store.createNote("single", { tags: ["capture/voice"] });

    const viaExpansion = await store.queryNotes({ tags: ["capture"] });
    expect(viaExpansion.map((n) => n.id).filter((id) => id === note.id).length).toBe(1);
    expect(viaExpansion.length).toBe(2);

    const viaAny = await store.queryNotes({
      tags: ["capture", "capture/voice", "capture/text"],
      tagMatch: "any",
    });
    expect(viaAny.map((n) => n.id).filter((id) => id === note.id).length).toBe(1);
  });

  it("tag_match=all still requires every input tag", async () => {
    const both = await store.createNote("both", { tags: ["a", "b"] });
    await store.createNote("only-a", { tags: ["a"] });
    const hits = await store.queryNotes({ tags: ["a", "b"], tagMatch: "all" });
    expect(hits.map((n) => n.id)).toEqual([both.id]);
  });
});

describe("getLinksHydratedForNotes agrees with per-note getLinksHydrated", () => {
  it("matches per-note hydration across self-loops, shared links, and isolated notes", async () => {
    const a = await store.createNote("a", { tags: ["x"] });
    const b = await store.createNote("b", { tags: ["y"], metadata: { k: 1 } });
    const c = await store.createNote("c", { path: "Notes/c" });
    const lonely = await store.createNote("lonely");

    await store.createLink(a.id, b.id, "mentions");      // both endpoints on page
    await store.createLink(b.id, a.id, "replies");       // reverse direction
    await store.createLink(a.id, a.id, "self");          // self-loop
    await store.createLink(c.id, a.id, "references");    // inbound from page note
    await store.createLink(b.id, c.id, "cites", { via: "test" });

    const pageIds = [a.id, b.id, c.id, lonely.id];
    const batch = getLinksHydratedForNotes(db, pageIds);

    for (const id of pageIds) {
      const single = getLinksHydrated(db, id);
      const batched = batch.get(id)!;
      const key = (l: { sourceId: string; targetId: string; relationship: string }) =>
        `${l.sourceId}→${l.targetId}:${l.relationship}`;
      // Same link set per note…
      expect(batched.map(key).sort()).toEqual(single.map(key).sort());
      // …ordered newest-first like the single-note SQL.
      const stamps = batched.map((l) => l.createdAt);
      expect([...stamps].sort().reverse()).toEqual(stamps);
      // …with identical hydrated summaries (path, tags, metadata).
      const summaries = (ls: typeof single) =>
        new Map(ls.map((l) => [key(l), JSON.stringify([l.sourceNote, l.targetNote])]));
      expect(summaries(batched)).toEqual(summaries(single));
    }

    // The self-loop appears once in a's list (not duplicated by the
    // source/target double-walk), matching the single-note query.
    const selfLoops = batch.get(a.id)!.filter((l) => l.sourceId === a.id && l.targetId === a.id);
    expect(selfLoops.length).toBe(1);

    expect(batch.get(lonely.id)).toEqual([]);
  });
});

describe("v22 keyset index", () => {
  it("exists after initSchema and covers (updated_at, id)", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notes_updated'")
      .get();
    expect(row).toBeTruthy();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT n.id FROM notes n
         WHERE (n.updated_at > ? OR (n.updated_at = ? AND n.id > ?))
         ORDER BY n.updated_at ASC, n.id ASC LIMIT 10`,
      )
      .all("2025-01-01", "2025-01-01", "x") as { detail: string }[];
    const details = plan.map((r) => r.detail).join(" | ");
    expect(details).toContain("idx_notes_updated");
    expect(details).not.toContain("TEMP B-TREE");
  });
});
