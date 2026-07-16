/**
 * Migration v26 → v27: the `note_vectors` table (semantic search MVP —
 * `SEMANTIC-MVP-PLAN.md`). Exercised against a REALISTIC pre-v27 fixture
 * (a hand-built v26-shape DB, not a fresh vault — per the real-install-
 * fixture discipline: fresh-DB-only testing misses the "existing vault
 * upgrading" path, which is the one that matters in production).
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, SCHEMA_VERSION } from "./schema.js";
import { encodeVector, normalize } from "./embedding/vector-codec.js";

/** A v26-shape vault: everything through vault#586, no `note_vectors` at all. */
function buildPreV27Vault(): Database {
  const db = new Database(":memory:");
  db.exec(`
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
      last_updated_via TEXT,
      updated_at_ms INTEGER
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
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag_name TEXT NOT NULL REFERENCES tags(name),
      PRIMARY KEY (note_id, tag_name)
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE links (
      source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      relationship TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(source_id, target_id, relationship)
    );
    CREATE INDEX idx_notes_updated_ms ON notes(updated_at_ms, id);
    -- A REAL v26 vault already went through migrateToV25's notes_fts
    -- rebuild+repopulate long ago — this fixture must include that
    -- already-populated state too, or a post-migration DELETE against
    -- notes hits the notes_fts_delete trigger with an external-content FTS5
    -- index that was never populated for these rows, which SQLite reports
    -- as disk-image corruption (a fixture-fidelity issue, not a real one).
    CREATE VIRTUAL TABLE notes_fts USING fts5(
      path, content, content='notes', content_rowid='rowid', tokenize='porter unicode61'
    );
    CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, path, content) VALUES (new.rowid, COALESCE(new.path, ''), new.content);
    END;
    CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, path, content) VALUES('delete', old.rowid, COALESCE(old.path, ''), old.content);
    END;
    CREATE TRIGGER notes_fts_update AFTER UPDATE OF content, path ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, path, content) VALUES('delete', old.rowid, COALESCE(old.path, ''), old.content);
      INSERT INTO notes_fts(rowid, path, content) VALUES (new.rowid, COALESCE(new.path, ''), new.content);
    END;
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
    INSERT INTO schema_version (version, applied_at) VALUES (26, '2026-07-01T00:00:00.000Z');
  `);
  const insert = db.prepare(
    "INSERT INTO notes (id, content, created_at, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("note-1", "some real morning-pages content", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", Date.UTC(2026, 5, 1));
  insert.run("note-2", "another pre-existing note", "2026-06-02T00:00:00.000Z", "2026-06-02T00:00:00.000Z", Date.UTC(2026, 5, 2));
  return db;
}

function hasTable(db: Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasIndex(db: Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
}

describe("migrateToV27 — creates note_vectors on a real pre-v27 fixture", () => {
  it("has no note_vectors table before migration; has one (+ its index) after", () => {
    const db = buildPreV27Vault();
    expect(hasTable(db, "note_vectors")).toBe(false);
    initSchema(db);
    expect(hasTable(db, "note_vectors")).toBe(true);
    expect(hasIndex(db, "idx_note_vectors_stale")).toBe(true);
    expect(
      (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v,
    ).toBe(SCHEMA_VERSION);
  });

  it("does NOT touch existing note rows — no data movement, unlike migrateToV26's backfill", () => {
    const db = buildPreV27Vault();
    const before = db.prepare("SELECT id, content, created_at, updated_at FROM notes ORDER BY id").all();
    initSchema(db);
    const after = db.prepare("SELECT id, content, created_at, updated_at FROM notes ORDER BY id").all();
    expect(after).toEqual(before);
  });

  it("every pre-existing note starts with ZERO note_vectors rows — the implicit 'needs embedding' backfill signal", () => {
    const db = buildPreV27Vault();
    initSchema(db);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM note_vectors").get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it("is idempotent — a second initSchema neither throws nor duplicates the table/index", () => {
    const db = buildPreV27Vault();
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    expect(hasTable(db, "note_vectors")).toBe(true);
  });

  it("note_vectors rows cascade-delete when their note is deleted (ON DELETE CASCADE)", () => {
    const db = buildPreV27Vault();
    initSchema(db);
    const vec = encodeVector(normalize(new Float32Array([1, 2, 3, 4])));
    db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at)
       VALUES (?, 0, ?, 4, 'test-model', 'deadbeef', ?)`,
    ).run("note-1", vec, new Date().toISOString());
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM note_vectors WHERE note_id = ?").get("note-1") as { n: number }).n,
    ).toBe(1);

    db.prepare("DELETE FROM notes WHERE id = ?").run("note-1");

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM note_vectors WHERE note_id = ?").get("note-1") as { n: number }).n,
    ).toBe(0);
    // note-2 is unaffected.
    expect(hasTable(db, "notes")).toBe(true);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM notes WHERE id = ?").get("note-2") as { n: number }).n,
    ).toBe(1);
  });

  it("PRIMARY KEY (note_id, chunk_ix) rejects a duplicate chunk row (upsert-by-replace is the caller's job)", () => {
    const db = buildPreV27Vault();
    initSchema(db);
    const vec = encodeVector(normalize(new Float32Array([1, 0, 0, 0])));
    const insert = db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at)
       VALUES (?, 0, ?, 4, 'test-model', 'hash-a', ?)`,
    );
    insert.run("note-1", vec, new Date().toISOString());
    expect(() => insert.run("note-1", vec, new Date().toISOString())).toThrow();
  });

  it("a fresh vault (no prior schema_version row) gets note_vectors directly from SCHEMA_SQL", () => {
    const db = new Database(":memory:");
    initSchema(db);
    expect(hasTable(db, "note_vectors")).toBe(true);
    expect(hasIndex(db, "idx_note_vectors_stale")).toBe(true);
  });
});
