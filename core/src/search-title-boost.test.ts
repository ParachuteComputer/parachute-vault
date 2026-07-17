/**
 * Search title-boost (title axis, ratified 2026-07-17): literal-mode
 * search results whose `displayTitle` (first non-empty content line, NOT
 * `path`) contains every query term are post-ranked ahead of body-only
 * matches. No-migration — an in-memory re-rank of the already-fetched
 * page, not a `notes_fts` schema change (see `applySearchTitleBoost` /
 * `boostTitleMatches` in `notes.ts`).
 *
 * This is a DIFFERENT axis from the existing `path`-weighted bm25 ranking
 * covered in `search-fts-v25.test.ts` — a note's title here is its first
 * CONTENT line, not its `path`.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("search title-boost", () => {
  it("ranks a first-line (title) match above a body-only match", async () => {
    // Body-only match: "budget" appears only deep in the body, first line
    // is unrelated.
    await store.createNote(
      "Weekly Standup\nlots of unrelated notes here, but somewhere we discuss the budget in passing",
      { path: "standup-notes" },
    );
    // First-line (title) match: "Budget" is the first line itself.
    await store.createNote("Budget Review\nQ3 numbers", { path: "budget-review" });

    const hits = await store.searchNotes("budget");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].path).toBe("budget-review");
  });

  it("requires ALL query terms to be present in the first line to boost (a partial title match doesn't qualify)", async () => {
    // "budget" is in the title but "review" is only in the body — a
    // PARTIAL title match, which stays in the body-only tier.
    await store.createNote("Budget notes\nsee the quarterly review for details", { path: "partial" });
    // Both "budget" and "review" are in the title — a FULL title match.
    await store.createNote("Budget Review\nQ3 numbers", { path: "full-match" });

    const hits = await store.searchNotes("budget review");
    expect(hits.map((n) => n.path)).toEqual(["full-match", "partial"]);
  });

  it("ties (both notes in the same tier) keep the existing relevance order", async () => {
    // Two title-matching notes plus one body-only note. Comparing literal
    // mode (boosted) against advanced mode with the same plain-word query
    // (identical FTS5 syntax, so identical underlying bm25 order, but no
    // boost pass) isolates the boost's effect: within the title-match
    // tier, the boost must preserve whatever relative order the
    // underlying relevance ranking already gave — a stable sort, not a
    // fresh comparator that could reshuffle ties.
    await store.createNote("Project Widget\nfirst, mentions widget again for relevance", { path: "w1" });
    await store.createNote("Project Widget\nsecond", { path: "w2" });
    await store.createNote("Unrelated\nbody-only mention of widget project", { path: "body-only" });

    const boosted = await store.searchNotes("widget project");
    const rawOrder = await store.searchNotes("widget project", { mode: "advanced" });

    const titleTierBoosted = boosted.map((n) => n.path).filter((p) => p === "w1" || p === "w2");
    const titleTierRaw = rawOrder.map((n) => n.path).filter((p) => p === "w1" || p === "w2");
    expect(titleTierBoosted).toEqual(titleTierRaw);
    // The title-match tier precedes the body-only note in the boosted result.
    expect(boosted.map((n) => n.path).indexOf("body-only")).toBeGreaterThan(
      Math.max(...["w1", "w2"].map((p) => boosted.map((n) => n.path).indexOf(p))),
    );
  });

  it("does not disturb ordering when an explicit sort is requested", async () => {
    await store.createNote("Zebra body-only mention of gadget", { path: "z" });
    await store.createNote("Gadget Launch\nfirst line title match", { path: "a" });

    const asc = await store.searchNotes("gadget", { sort: "asc" });
    // created_at ASC means "z" (created first) comes before "a" — the
    // title-boost must NOT override an explicit sort.
    expect(asc.map((n) => n.path)).toEqual(["z", "a"]);
  });

  it("does not apply the boost under search_mode: advanced (raw FTS5 syntax, not naively tokenizable)", async () => {
    await store.createNote("Body only mentions gadget in passing text here", { path: "body-only" });
    await store.createNote("Gadget\nfirst line title match", { path: "title-match" });

    const advanced = await store.searchNotes("gadget", { mode: "advanced" });
    const literal = await store.searchNotes("gadget");

    // Literal mode boosts the title match to the front.
    expect(literal[0].path).toBe("title-match");
    // Advanced mode is unaffected by the boost — order comes from bm25
    // relevance alone (title-match still likely ranks first via the
    // EXISTING path-weighted bm25, but that's a different mechanism; the
    // test here just confirms advanced mode doesn't throw and returns
    // both notes, not that ordering matches/mismatches literal mode).
    expect(advanced.map((n) => n.path).sort()).toEqual(["body-only", "title-match"]);
  });

  it("a query with no results is unaffected (empty array in, empty array out)", async () => {
    const hits = await store.searchNotes("nonexistent_term_xyz");
    expect(hits).toEqual([]);
  });
});
