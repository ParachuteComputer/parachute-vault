import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
-- Notes: the universal record
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  content TEXT DEFAULT '',
  path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Tags: flat labels
CREATE TABLE IF NOT EXISTS tags (
  name TEXT PRIMARY KEY
);

-- Note-Tag join
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_name TEXT NOT NULL REFERENCES tags(name),
  PRIMARY KEY (note_id, tag_name)
);

-- Attachments: files associated with notes
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Links: directed relationships between notes
CREATE TABLE IF NOT EXISTS links (
  source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_id, target_id, relationship)
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- Full-text search on note content
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  content,
  content='notes',
  content_rowid='rowid'
);

-- FTS triggers
CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE OF content ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at);
CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path) WHERE path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_note_tags_note ON note_tags(note_id, tag_name);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_name, note_id);
CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id);
`;

/**
 * Initialize database schema. Idempotent — safe to call on every startup.
 */
export function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Check if we need to migrate from v2
  const hasOldTables = hasTable(db, "things");
  if (hasOldTables) {
    migrateFromV2(db);
  }

  db.exec(SCHEMA_SQL);

  // Record schema version
  db.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)").run(
    SCHEMA_VERSION,
    new Date().toISOString(),
  );
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

/**
 * Migrate from v2 (things/thing_tags/edges/tools) to v3 (notes/note_tags/links).
 */
function migrateFromV2(db: Database.Database): void {
  const alreadyMigrated = hasTable(db, "notes");
  if (alreadyMigrated) return;

  // Disable FK checks during migration to allow dropping tables freely
  db.pragma("foreign_keys = OFF");

  // Drop old FTS, triggers, and tables that will be recreated with new schema
  db.exec("DROP TRIGGER IF EXISTS things_fts_insert");
  db.exec("DROP TRIGGER IF EXISTS things_fts_delete");
  db.exec("DROP TRIGGER IF EXISTS things_fts_update");
  db.exec("DROP TABLE IF EXISTS things_fts");

  // Rename old tags table so we can create the new simplified one
  // (old tags has display_name, schema_json, etc. — new one is just name)
  db.exec("ALTER TABLE tags RENAME TO _old_tags");

  // Create new tables
  db.exec(SCHEMA_SQL);

  // Migrate things → notes
  db.exec(`
    INSERT INTO notes (id, content, created_at, updated_at)
    SELECT id, content, created_at, updated_at FROM things WHERE status = 'active'
  `);

  // Collect tag names from thing_tags, renaming known ones
  // We insert into the new tags table (which only has a 'name' column)
  db.exec(`
    INSERT OR IGNORE INTO tags (name)
    SELECT DISTINCT CASE
      WHEN tag_name = 'note' THEN 'daily'
      WHEN tag_name = 'daily-note' THEN 'daily'
      ELSE tag_name
    END
    FROM thing_tags
  `);

  // Migrate thing_tags → note_tags
  db.exec(`
    INSERT OR IGNORE INTO note_tags (note_id, tag_name)
    SELECT tt.thing_id, CASE
      WHEN tt.tag_name = 'note' THEN 'daily'
      WHEN tt.tag_name = 'daily-note' THEN 'daily'
      ELSE tt.tag_name
    END
    FROM thing_tags tt
    WHERE tt.thing_id IN (SELECT id FROM notes)
  `);

  // Migrate edges → links
  db.exec(`
    INSERT OR IGNORE INTO links (source_id, target_id, relationship, created_at)
    SELECT source_id, target_id, relationship, created_at FROM edges
    WHERE source_id IN (SELECT id FROM notes) AND target_id IN (SELECT id FROM notes)
  `);

  // Drop old tables
  db.exec("DROP TABLE IF EXISTS thing_tags");
  db.exec("DROP TABLE IF EXISTS edges");
  db.exec("DROP TABLE IF EXISTS tools");
  db.exec("DROP TABLE IF EXISTS things");
  db.exec("DROP TABLE IF EXISTS _old_tags");

  // Re-enable FK checks
  db.pragma("foreign_keys = ON");
}
