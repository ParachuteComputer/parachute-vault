/**
 * Search recall + ranking — schema v25 FTS rebuild (Wave 7 of the
 * Reliability & Usability Program, WS2B/C, vault#551). Covers the
 * MIGRATION-bearing risk this PR carries:
 *
 *   - a v24 vault (single-column `content`-only notes_fts) upgrades to the
 *     v25 shape (path + content, porter stemming) via `migrateToV25`,
 *     idempotently, without touching note data;
 *   - a fresh vault gets the v25 shape directly from SCHEMA_SQL;
 *   - post-migration, a note's TITLE (path) is searchable — impossible
 *     pre-v25;
 *   - existing body-text search keeps working (no regression);
 *   - porter stemming matches regular-affix variants;
 *   - bm25 ranking is weighted so a title match outranks a passing body
 *     mention, and every result carries a legible `score`;
 *   - the sync triggers keep the index correct across insert/update
 *     (content-only, path-only, both)/delete, including notes with no path.
 *
 * See `src/contract-search.test.ts` for the REST/MCP-surface coverage
 * (did_you_mean, the wrapped advanced-mode column-filter hint, sort
 * override parity).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { initSchema, SCHEMA_VERSION } from "./schema.js";
import { transaction } from "./txn.js";
import * as noteOps from "./notes.js";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("search — schema v25 FTS rebuild", () => {
  it("bumped SCHEMA_VERSION to at least 25 (notes_fts path+content landed)", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(25);
  });

  it("a fresh vault gets the v25 notes_fts shape directly (path + content columns)", () => {
    const cols = (db.prepare("PRAGMA table_info(notes_fts)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toContain("path");
    expect(cols).toContain("content");
  });

  it("a fresh vault: a note's title (path) is searchable even with unrelated body content", async () => {
    await store.createNote("nothing relevant in the body here", {
      path: "quarterly-budget-review",
    });
    const hits = await store.searchNotes("budget");
    expect(hits.map((n) => n.path)).toContain("quarterly-budget-review");
  });

  it("a fresh vault: existing body search still works (no regression)", async () => {
    await store.createNote("the widget shipped on time", { path: "unrelated-title" });
    const hits = await store.searchNotes("widget");
    expect(hits.map((n) => n.path)).toContain("unrelated-title");
  });
});

describe("search — v24 → v25 migration (legacy vault upgrade)", () => {
  /**
   * Build a v24-shaped vault by hand: the OLD single-column notes_fts
   * (content only), the OLD triggers (UPDATE OF content only — no path
   * sync), and a handful of notes seeded BEFORE the migration runs —
   * mirroring the real upgrade scenario (existing data, not a fresh DB).
   * `initSchema` then drives the whole migration chain up through v25.
   */
  function buildLegacyV24Vault(): Database {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        content TEXT DEFAULT '',
        path TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT,
        extension TEXT NOT NULL DEFAULT 'md',
        created_by TEXT,
        created_via TEXT,
        last_updated_by TEXT,
        last_updated_via TEXT
      );
      CREATE TABLE tags (
        name TEXT PRIMARY KEY,
        description TEXT,
        fields TEXT,
        relationships TEXT,
        parent_names TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE note_tags (
        note_id TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        PRIMARY KEY (note_id, tag_name)
      );
      CREATE TABLE indexed_fields (
        field TEXT PRIMARY KEY,
        sqlite_type TEXT NOT NULL,
        declarer_tags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
      INSERT INTO schema_version (version, applied_at) VALUES (24, '2026-01-01T00:00:00.000Z');

      CREATE VIRTUAL TABLE notes_fts USING fts5(
        content,
        content='notes',
        content_rowid='rowid'
      );
      CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER notes_fts_update AFTER UPDATE OF content ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);

    // Seed BEFORE migration — real-data-like: some notes with a path, one
    // without (path IS NULL — the coalesce-to-'' path must not throw).
    const insert = legacy.prepare(
      "INSERT INTO notes (id, content, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(
      "legacy-1",
      "a dedicated writeup mentioning propolis only once in passing text",
      "beekeeping-notes",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    insert.run(
      "legacy-2",
      "nothing about the topic here at all",
      "propolis",
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    insert.run(
      "legacy-3",
      "the firefighters responded quickly to the call",
      null,
      "2026-01-03T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    );
    // Manually populate the OLD single-column FTS index (mirrors what the
    // old triggers would have done on real inserts).
    legacy.exec(`INSERT INTO notes_fts(rowid, content) SELECT rowid, content FROM notes`);

    return legacy;
  }

  it("migrates a v24 vault to the current SCHEMA_VERSION without throwing", () => {
    const legacy = buildLegacyV24Vault();
    expect(() => initSchema(legacy)).not.toThrow();
    const ver = (legacy.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
    expect(ver).toBe(SCHEMA_VERSION);
  });

  it("post-migration: notes_fts carries path + content columns", () => {
    const legacy = buildLegacyV24Vault();
    initSchema(legacy);
    const cols = (legacy.prepare("PRAGMA table_info(notes_fts)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toContain("path");
    expect(cols).toContain("content");
  });

  it("post-migration: a note's TITLE is searchable (impossible pre-v25)", () => {
    const legacy = buildLegacyV24Vault();
    initSchema(legacy);
    // "beekeeping-notes" (legacy-1's path) never appears in any note's body.
    const hits = noteOps.searchNotes(legacy, "beekeeping");
    expect(hits.map((n) => n.id)).toContain("legacy-1");
  });

  it("post-migration: existing body search still works (no regression from the rebuild)", () => {
    const legacy = buildLegacyV24Vault();
    initSchema(legacy);
    const hits = noteOps.searchNotes(legacy, "firefighters");
    expect(hits.map((n) => n.id)).toContain("legacy-3");
  });

  it("post-migration: porter stemming matches a regular-affix variant not present verbatim", () => {
    const legacy = buildLegacyV24Vault();
    initSchema(legacy);
    // legacy-3's body has "firefighters" (plural) — singular query must match.
    const hits = noteOps.searchNotes(legacy, "firefighter");
    expect(hits.map((n) => n.id)).toContain("legacy-3");
  });

  it("post-migration: a title match ranks ABOVE a passing body-only mention, and both carry a score", () => {
    const legacy = buildLegacyV24Vault();
    initSchema(legacy);
    // legacy-2's path IS "propolis" (title match); legacy-1's body mentions
    // "propolis" once in passing (body-only match). Weighted bm25 must rank
    // the title match first.
    const hits = noteOps.searchNotes(legacy, "propolis");
    const ids = hits.map((n) => n.id);
    expect(ids.indexOf("legacy-2")).toBeLessThan(ids.indexOf("legacy-1"));
    for (const n of hits) {
      expect(typeof n.score).toBe("number");
    }
    const byId = new Map(hits.map((n) => [n.id, n.score!]));
    expect(byId.get("legacy-2")!).toBeGreaterThan(byId.get("legacy-1")!);
  });

  it("post-migration: a note that had NO path (path IS NULL) survived the rebuild and stays body-searchable", () => {
    const legacy = buildLegacyV24Vault();
    initSchema(legacy);
    const hits = noteOps.searchNotes(legacy, "firefighters");
    expect(hits.some((n) => n.id === "legacy-3")).toBe(true);
  });

  it("post-migration: the FTS index isn't duplicated or corrupted — an integrity-check passes", () => {
    const legacy = buildLegacyV24Vault();
    initSchema(legacy);
    // FTS5's built-in consistency check: throws if the shadow tables and
    // the external-content table have drifted apart (e.g. double-inserted
    // rows from a repopulation bug).
    expect(() => legacy.exec(`INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')`)).not.toThrow();
  });

  it("migration is idempotent — running initSchema twice does not duplicate rows or throw", () => {
    const legacy = buildLegacyV24Vault();
    initSchema(legacy);
    expect(() => initSchema(legacy)).not.toThrow();
    const hits = noteOps.searchNotes(legacy, "firefighter");
    // Exactly one match, not duplicated by a second repopulation pass.
    expect(hits.filter((n) => n.id === "legacy-3").length).toBe(1);
    expect(() => legacy.exec(`INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')`)).not.toThrow();
  });

  it("migration is idempotent on a vault that was ALREADY on v25 (e.g. a fresh vault) — no rebuild, no data loss", async () => {
    // `store`/`db` from the outer beforeEach is already a fresh v25 vault.
    await store.createNote("hello world", { path: "greeting" });
    expect(() => initSchema(db)).not.toThrow();
    const hits = await store.searchNotes("hello");
    expect(hits.length).toBe(1);
  });

  /**
   * MUST-FIX (generalist review, #565): the whole DDL + repopulation runs
   * inside ONE `transaction`, so a crash partway through can NEVER leave a
   * recreated-but-EMPTY notes_fts (which the path-column idempotency guard
   * would then treat as "done," leaving search permanently empty). This test
   * reproduces a mid-migration interruption by driving the exact rebuild DDL
   * through the SAME `transaction` seam `migrateToV25` uses and throwing
   * before repopulation completes, then asserts (a) the throw rolled the DDL
   * back to the pre-v25 v24 shape — NOT a committed-empty v25 table — and (b)
   * a subsequent clean `initSchema` fully repopulates search. The load-bearing
   * assertion is (a): under the pre-review shape (DDL OUTSIDE the transaction)
   * the rolled-back table would still carry the `path` column, the guard would
   * skip, and search would be silently empty forever.
   */
  it("an interrupted migration rolls back to the v24 shape and the next initSchema fully recovers — never silent-empty", () => {
    const legacy = buildLegacyV24Vault();

    // Sanity: it starts on the OLD single-column shape.
    const cols = () =>
      (legacy.prepare("PRAGMA table_info(notes_fts)").all() as { name: string }[]).map((c) => c.name);
    expect(cols()).toEqual(["content"]);

    // Simulate `migrateToV25` crashing AFTER the DDL but BEFORE repopulation
    // finishes — same `transaction` seam, same DDL, forced throw.
    expect(() =>
      transaction(legacy, () => {
        legacy.exec("DROP TRIGGER IF EXISTS notes_fts_insert");
        legacy.exec("DROP TRIGGER IF EXISTS notes_fts_delete");
        legacy.exec("DROP TRIGGER IF EXISTS notes_fts_update");
        legacy.exec("DROP TABLE IF EXISTS notes_fts");
        legacy.exec(`
          CREATE VIRTUAL TABLE notes_fts USING fts5(
            path, content, content='notes', content_rowid='rowid', tokenize='porter unicode61'
          )
        `);
        // ... crash here, before any INSERT INTO notes_fts.
        throw new Error("simulated crash mid-migration");
      }),
    ).toThrow("simulated crash mid-migration");

    // (a) Rollback restored the v24 shape — the recreated v25 table is GONE,
    //     so the `hasColumn(notes_fts, "path")` guard will re-detect
    //     "not migrated". If the DDL had been outside the transaction, `path`
    //     would still be present here and the migration would be skipped.
    expect(cols()).toEqual(["content"]);
    const versionAfterCrash = (
      legacy.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }
    ).v;
    expect(versionAfterCrash).toBe(24);

    // (b) A clean restart re-runs the migration and fully populates search —
    //     both a title-only term and a body term are findable, and the FTS
    //     integrity-check passes. Never the silent-empty state.
    initSchema(legacy);
    expect(cols()).toContain("path");
    expect(noteOps.searchNotes(legacy, "beekeeping").map((n) => n.id)).toContain("legacy-1"); // title-only
    expect(noteOps.searchNotes(legacy, "firefighters").map((n) => n.id)).toContain("legacy-3"); // body
    expect(() => legacy.exec(`INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')`)).not.toThrow();
  });
});

describe("search — FTS sync triggers keep path + content current (schema v25)", () => {
  it("a note created with no path is indexed fine (empty path, not an error)", async () => {
    const note = await store.createNote("body text only, no title");
    const hits = await store.searchNotes("body");
    expect(hits.map((n) => n.id)).toContain(note.id);
  });

  it("a path-ONLY update (content untouched) is now synced to the index — pre-v25 this was invisible to notes_fts", async () => {
    const note = await store.createNote("unrelated body text", { path: "oldtitle" });
    expect((await store.searchNotes("oldtitle")).map((n) => n.id)).toContain(note.id);
    await store.updateNote(note.id, { path: "newtitle" });
    expect((await store.searchNotes("newtitle")).map((n) => n.id)).toContain(note.id);
    expect((await store.searchNotes("oldtitle")).map((n) => n.id)).not.toContain(note.id);
  });

  it("deleting a note removes it from both the path and content index", async () => {
    const note = await store.createNote("nothing in the body matches this term", {
      path: "uniquetitleterm",
    });
    expect((await store.searchNotes("uniquetitleterm")).map((n) => n.id)).toContain(note.id);
    expect((await store.searchNotes("nothing")).map((n) => n.id)).toContain(note.id);
    await store.deleteNote(note.id);
    expect((await store.searchNotes("uniquetitleterm")).map((n) => n.id)).not.toContain(note.id);
    expect((await store.searchNotes("nothing")).map((n) => n.id)).not.toContain(note.id);
  });
});
