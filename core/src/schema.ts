import { Database } from "bun:sqlite";
import { normalizePath } from "./paths.js";

export const SCHEMA_VERSION = 8;

export const SCHEMA_SQL = `
-- Notes: the universal record
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  content TEXT DEFAULT '',
  path TEXT,
  metadata TEXT DEFAULT '{}',
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
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Links: directed relationships between notes
CREATE TABLE IF NOT EXISTS links (
  source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(source_id, target_id, relationship)
);

-- Tag schemas: optional metadata schema per tag
CREATE TABLE IF NOT EXISTS tag_schemas (
  tag_name TEXT PRIMARY KEY REFERENCES tags(name) ON DELETE CASCADE,
  description TEXT,
  fields TEXT -- JSON: { "field_name": { "type": "string", "description": "..." }, ... }
);

-- Tokens: API authentication with scoped permissions
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'admin',
  scope_tag TEXT,
  scope_path_prefix TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- OAuth: registered clients (Dynamic Client Registration)
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT,
  created_at TEXT NOT NULL
);

-- OAuth: authorization codes (single-use, short-lived)
CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope TEXT NOT NULL DEFAULT 'full',
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
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
export function initSchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Check if we need to migrate from v2
  const hasOldTables = hasTable(db, "things");
  if (hasOldTables) {
    migrateFromV2(db);
  }

  db.exec(SCHEMA_SQL);

  // Migrate v3 → v4: add metadata columns
  migrateToV4(db);

  // Migrate v4 → v5: unique path constraint
  migrateToV5(db);

  // Migrate v5 → v6: tag_schemas table (created by SCHEMA_SQL above,
  // this just ensures the table exists for databases created before v6)
  migrateToV6(db);

  // Migrate v6 → v7: tokens table (created by SCHEMA_SQL above,
  // this just ensures the table exists for databases created before v7)
  migrateToV7(db);

  // Migrate v7 → v8: OAuth tables (created by SCHEMA_SQL above,
  // this just ensures the tables exist for databases created before v8)
  migrateToV8(db);

  // Record schema version
  db.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)").run(
    SCHEMA_VERSION,
    new Date().toISOString(),
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/**
 * Migrate v3 → v4: add metadata JSON columns to notes and links.
 */
function migrateToV4(db: Database): void {
  if (hasTable(db, "notes") && !hasColumn(db, "notes", "metadata")) {
    db.exec("ALTER TABLE notes ADD COLUMN metadata TEXT DEFAULT '{}'");
  }
  if (hasTable(db, "links") && !hasColumn(db, "links", "metadata")) {
    db.exec("ALTER TABLE links ADD COLUMN metadata TEXT DEFAULT '{}'");
  }
  if (hasTable(db, "attachments") && !hasColumn(db, "attachments", "metadata")) {
    db.exec("ALTER TABLE attachments ADD COLUMN metadata TEXT DEFAULT '{}'");
  }
}

/**
 * Migrate v4 → v5: add UNIQUE constraint on path, normalize existing paths.
 */
function migrateToV5(db: Database): void {
  if (!hasTable(db, "notes")) return;

  // Check if the unique index already exists
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notes_path_unique'",
  ).all();
  if (indexes.length > 0) return;

  // Normalize existing paths
  const rows = db.prepare("SELECT id, path FROM notes WHERE path IS NOT NULL").all() as { id: string; path: string }[];
  for (const row of rows) {
    const normalized = normalizePath(row.path);
    if (normalized !== row.path) {
      db.prepare("UPDATE notes SET path = ? WHERE id = ?").run(normalized, row.id);
    }
  }

  // Handle duplicate paths (can happen after normalization) — append note ID suffix
  const dupes = db.prepare(`
    SELECT path, GROUP_CONCAT(id) as ids FROM notes
    WHERE path IS NOT NULL
    GROUP BY path COLLATE NOCASE
    HAVING COUNT(*) > 1
  `).all() as { path: string; ids: string }[];
  for (const dupe of dupes) {
    const ids = dupe.ids.split(",");
    // Keep first, rename the rest
    for (let i = 1; i < ids.length; i++) {
      const newPath = `${dupe.path}-${i}`;
      db.prepare("UPDATE notes SET path = ? WHERE id = ?").run(newPath, ids[i]);
    }
  }

  // Drop the old non-unique partial index and create a unique one
  db.exec("DROP INDEX IF EXISTS idx_notes_path");
  db.exec("CREATE UNIQUE INDEX idx_notes_path_unique ON notes(path) WHERE path IS NOT NULL");
}

/**
 * Migrate v5 → v6: create tag_schemas table.
 * The table is already in SCHEMA_SQL so it's created for new vaults.
 * This migration handles existing vaults that were created before v6.
 */
function migrateToV6(db: Database): void {
  // SCHEMA_SQL already creates the table via CREATE TABLE IF NOT EXISTS,
  // so this is a no-op for new vaults. For existing vaults where SCHEMA_SQL
  // ran above, the table now exists. Nothing extra needed here — the
  // vault.yaml → DB migration happens at the server level (see server.ts),
  // not at the core schema level, because core doesn't know about config files.
}

/**
 * Migrate v6 → v7: create tokens table.
 * The table is already in SCHEMA_SQL so it's created for new vaults.
 * This migration handles existing vaults that were created before v7.
 */
function migrateToV7(db: Database): void {
  // SCHEMA_SQL already creates the table via CREATE TABLE IF NOT EXISTS,
  // so this is a no-op for new vaults. For existing vaults where SCHEMA_SQL
  // ran above, the table now exists. Nothing extra needed here.
}

function migrateToV8(db: Database): void {
  // SCHEMA_SQL already creates oauth_clients and oauth_codes via
  // CREATE TABLE IF NOT EXISTS. Nothing extra needed here.
}

function hasTable(db: Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

/**
 * Migrate from v2 (things/thing_tags/edges/tools) to v3 (notes/note_tags/links).
 */
function migrateFromV2(db: Database): void {
  const alreadyMigrated = hasTable(db, "notes");
  if (alreadyMigrated) return;

  // Disable FK checks during migration to allow dropping tables freely
  db.exec("PRAGMA foreign_keys = OFF");

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
  db.exec("PRAGMA foreign_keys = ON");
}
