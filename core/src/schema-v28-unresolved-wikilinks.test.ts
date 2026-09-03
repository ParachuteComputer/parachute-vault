/**
 * Migration v27 → v28: fold the lazy unresolved_wikilinks relationship-column
 * self-heal into the versioned chain (vault#567 item 2).
 *
 * The interesting path is an EXISTING vault whose `unresolved_wikilinks`
 * table still has the pre-#555 2-column PK — not a fresh vault (those
 * create the 3-column table lazily, or never create it). Gating is the
 * load-bearing claim: a vault that never queued a dangling link must NOT
 * grow the table on open.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, SCHEMA_VERSION } from "./schema.js";
import { SqliteStore } from "./store.js";
import { ensureRelationshipColumn } from "./wikilinks.js";

function hasTable(db: Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe("SCHEMA_VERSION v28", () => {
  it("bumped SCHEMA_VERSION to at least 28 (unresolved_wikilinks heal is versioned)", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(28);
  });
});

describe("migrateToV28 — does NOT create unresolved_wikilinks on a vault that never needed it", () => {
  it("a fresh vault (no dangling links) still has no unresolved_wikilinks table after initSchema", () => {
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    expect(store).toBeDefined();
    expect(hasTable(db, "unresolved_wikilinks")).toBe(false);
    expect(
      (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v,
    ).toBe(SCHEMA_VERSION);
  });
});

describe("migrateToV28 — heals a pre-#555 2-column table at boot", () => {
  let db: Database;
  let store: SqliteStore;
  let sourceId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    store = new SqliteStore(db);
    const src = await store.createNote("plain body, no wikilinks", { path: "src-note" });
    await store.createNote("plain target", { path: "Target A" });
    sourceId = src.id;
    db.exec(`
      CREATE TABLE unresolved_wikilinks (
        source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        target_path TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (source_id, target_path)
      )
    `);
    db.prepare("INSERT INTO unresolved_wikilinks (source_id, target_path) VALUES (?, ?)").run(
      src.id,
      "Target B",
    );
    db.prepare("INSERT INTO unresolved_wikilinks (source_id, target_path) VALUES (?, ?)").run(
      src.id,
      "Target A",
    );
  });

  it("initSchema rebuilds the 3-column PK and backfills relationship='wikilink'", () => {
    expect(columnNames(db, "unresolved_wikilinks")).not.toContain("relationship");
    initSchema(db);
    expect(columnNames(db, "unresolved_wikilinks")).toContain("relationship");
    expect(hasTable(db, "unresolved_wikilinks_pre_v555")).toBe(false);
    const rows = db
      .prepare("SELECT source_id, target_path, relationship FROM unresolved_wikilinks ORDER BY target_path")
      .all() as { source_id: string; target_path: string; relationship: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.relationship === "wikilink")).toBe(true);
    expect(rows.every((r) => r.source_id === sourceId)).toBe(true);
    expect(
      (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v,
    ).toBe(SCHEMA_VERSION);
  });

  it("is idempotent — a second initSchema neither throws nor duplicates rows", () => {
    initSchema(db);
    initSchema(db);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM unresolved_wikilinks").get() as { c: number }).c;
    expect(count).toBe(2);
    expect(columnNames(db, "unresolved_wikilinks")).toContain("relationship");
  });

  it("a 3-column table is a no-op (no rewrite)", () => {
    initSchema(db); // first pass heals
    const before = db.prepare("SELECT * FROM unresolved_wikilinks ORDER BY target_path").all();
    ensureRelationshipColumn(db);
    initSchema(db);
    const after = db.prepare("SELECT * FROM unresolved_wikilinks ORDER BY target_path").all();
    expect(after).toEqual(before);
  });
});
