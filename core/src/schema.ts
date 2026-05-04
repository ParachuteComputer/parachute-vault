import { Database } from "bun:sqlite";
import { normalizePath } from "./paths.js";
import { rebuildIndexes } from "./indexed-fields.js";

export const SCHEMA_VERSION = 15;

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

-- Tags: first-class identity carrying schema, hierarchy, and typed-link
-- declarations. One row per tag; no notes-as-config sidecars for these
-- concerns. See parachute-patterns/patterns/tag-data-model.md.
--
-- description    — human-readable blurb (markdown).
-- fields         — JSON: indexed metadata field declarations per
--                  query-operators.md. Replaces v6-era tag_schemas.fields.
-- relationships  — JSON: typed-link declarations
--                  ({ "rel": { target_tag, cardinality, description? } }).
--                  Cardinality vocabulary: one | optional | many | many-required.
--                  Phase 1 informational — declared but not enforced at write.
-- parent_names   — JSON array of parent tag names. Replaces the v6-era
--                  _tags/NAME config-note hierarchy.
CREATE TABLE IF NOT EXISTS tags (
  name TEXT PRIMARY KEY,
  description TEXT,
  fields TEXT,
  relationships TEXT,
  parent_names TEXT,
  created_at TEXT,
  updated_at TEXT
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

-- tag_schemas (v6) was retired in v14; description + fields lifted onto the
-- tags row directly. The CREATE TABLE was removed from SCHEMA_SQL after the
-- v14 data migration drops the table; existing v6+ vaults pick up the
-- migration on next boot. See migrateToV14.

-- Note schemas (v15): schema definitions used to validate notes by path
-- prefix or tag. Replaces the v6-era _schemas/NAME notes-as-config
-- convention. Validation is non-blocking — schemas surface warnings on
-- create/update responses, never reject the write. See
-- core/src/schema-defaults.ts and patterns/tag-data-model.md §Note schemas.
--
-- name        — primary key; the schema identifier referenced by mappings.
-- description — human-readable blurb (markdown).
-- fields      — JSON: { fieldName: { type?, enum?, description? } }.
-- required    — JSON: string[] of required field names.
CREATE TABLE IF NOT EXISTS note_schemas (
  name TEXT PRIMARY KEY,
  description TEXT,
  fields TEXT,
  required TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- Schema mappings (v15): replaces the singleton _schema_defaults note. One
-- row per match rule; the resolver walks the table at note-write time.
-- match_kind is constrained to 'path_prefix' or 'tag'. Composite PK so
-- (schema, kind, value) is naturally unique without an extra surrogate id.
-- ON DELETE CASCADE: dropping a schema cleans up its mappings.
CREATE TABLE IF NOT EXISTS schema_mappings (
  schema_name TEXT NOT NULL REFERENCES note_schemas(name) ON DELETE CASCADE,
  match_kind TEXT NOT NULL CHECK (match_kind IN ('path_prefix', 'tag')),
  match_value TEXT NOT NULL,
  PRIMARY KEY (schema_name, match_kind, match_value)
);

-- Indexed fields: SSOT for generated columns and indexes on notes derived
-- from tag-declared fields with indexed=true. One row per indexed metadata
-- field; declarer_tags is a JSON array of tags that currently declare it.
-- See core/src/indexed-fields.ts.
CREATE TABLE IF NOT EXISTS indexed_fields (
  field TEXT PRIMARY KEY,
  sqlite_type TEXT NOT NULL,
  declarer_tags TEXT NOT NULL DEFAULT '[]'
);

-- Tokens: API authentication with OAuth-standard scopes.
--
-- scopes is a whitespace-separated list of granted scopes (OAuth 2.0 §3.3)
-- — e.g. "vault:read vault:write". Introduced in v12 alongside enforcement;
-- NULL rows are pre-v12 tokens which fall back to deriving scopes from the
-- legacy permission column (see src/scopes.ts). permission is kept for the
-- one-release-cycle back-compat window and will be dropped in a future
-- migration.
--
-- scoped_tags is a JSON-encoded array of root tag names that constrain the
-- token's effective access (intersection with the scopes column). NULL
-- means unscoped — full vault access per scopes. Introduced in v13 per
-- patterns/tag-scoped-tokens.md. Hierarchy expansion is applied at auth
-- time via getTagDescendants; the column stores root names only.
--
-- scope_tag / scope_path_prefix are deprecated Phase-0 columns — never
-- enforced at runtime, kept only for schema stability.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'admin',
  scopes TEXT,
  scoped_tags TEXT,
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
-- vault_name pins the code to the vault it was issued for. handleToken
-- must verify it matches the requested vault — otherwise a code issued
-- under /vaults/A/oauth/authorize could be redeemed at /vaults/B/oauth/token.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope TEXT NOT NULL DEFAULT 'full',
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  vault_name TEXT
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
CREATE INDEX IF NOT EXISTS idx_schema_mappings_match ON schema_mappings(match_kind, match_value);
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

  // Migrate v8 → v9: add vault_name column to oauth_codes
  migrateToV9(db);

  // Migrate v9 → v10: indexed_fields table (created by SCHEMA_SQL above).
  migrateToV10(db);

  // Migrate v10 → v11: backfill updated_at = created_at for legacy rows.
  migrateToV11(db);

  // Migrate v11 → v12: add `scopes` column to tokens for Phase 2 enforcement.
  migrateToV12(db);

  // Migrate v12 → v13: add `scoped_tags` column to tokens for tag-scoped tokens.
  migrateToV13(db);

  // Migrate v13 → v14: tag-data-model reshape. Augment `tags` row with
  // description/fields/relationships/parent_names/timestamps; copy data
  // from the v6-era tag_schemas sidecar and from `_tags/<name>` config
  // notes; drop tag_schemas after copy. See patterns/tag-data-model.md.
  migrateToV14(db);

  // Migrate v14 → v15: retire the `_schemas/<name>` and `_schema_defaults`
  // notes-as-config sidecars. Copy each `_schemas/<name>` note into the
  // new `note_schemas` table and the `_schema_defaults` mappings into
  // `schema_mappings`. The legacy notes are LEFT IN PLACE — they are
  // inert post-v15 (no resolver reads them) and serve as audit trail.
  migrateToV15(db);

  // Rebuild any generated columns + indexes declared in indexed_fields.
  // No-op for a fresh vault; idempotent on existing vaults.
  rebuildIndexes(db);

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
      db.prepare("UPDATE notes SET path = ? WHERE id = ?").run(newPath, ids[i]!);
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

function migrateToV9(db: Database): void {
  // Add vault_name column to existing oauth_codes tables. Codes predating
  // this migration have NULL vault_name and will fail the token-exchange
  // vault check — acceptable because codes expire in 10 minutes.
  if (hasTable(db, "oauth_codes") && !hasColumn(db, "oauth_codes", "vault_name")) {
    db.exec("ALTER TABLE oauth_codes ADD COLUMN vault_name TEXT");
  }
}

function migrateToV10(db: Database): void {
  // SCHEMA_SQL's CREATE TABLE IF NOT EXISTS covers fresh vaults; this
  // ensures indexed_fields exists on vaults created before v10. No data
  // migration — rebuildIndexes() downstream handles column/index creation
  // if any rows are already present.
}

/**
 * Migrate v10 → v11: backfill `updated_at = created_at` for notes that never
 * received an update. Pre-v11 inserts left `updated_at` NULL, which broke
 * optimistic concurrency for clients that fall back to `createdAt` (the
 * common `updatedAt ?? createdAt` pattern) — the `updated_at IS ?` guard
 * never matched. From v11 onward, `createNote` sets both columns at insert.
 * Idempotent — safe to run on every boot.
 */
function migrateToV11(db: Database): void {
  if (!hasTable(db, "notes")) return;
  db.exec("UPDATE notes SET updated_at = created_at WHERE updated_at IS NULL");
}

/**
 * Migrate v11 → v12: add `scopes` column to tokens. Existing rows get NULL
 * and fall back to legacy `permission` → scopes derivation at read time
 * (see src/scopes.ts:legacyPermissionToScopes). New tokens minted on v12+
 * populate the column explicitly.
 */
function migrateToV12(db: Database): void {
  if (hasTable(db, "tokens") && !hasColumn(db, "tokens", "scopes")) {
    db.exec("ALTER TABLE tokens ADD COLUMN scopes TEXT");
  }
}

/**
 * Migrate v12 → v13: add `scoped_tags` column to tokens. NULL means unscoped
 * (current full-vault behavior); a JSON array of root tag names narrows the
 * token's access to notes carrying one of those tags or a sub-tag thereof
 * (hierarchy expansion via getTagDescendants at auth time). See
 * parachute-patterns/patterns/tag-scoped-tokens.md.
 */
function migrateToV13(db: Database): void {
  if (hasTable(db, "tokens") && !hasColumn(db, "tokens", "scoped_tags")) {
    db.exec("ALTER TABLE tokens ADD COLUMN scoped_tags TEXT");
  }
}

/**
 * Migrate v13 → v14: tag-data-model reshape (patterns/tag-data-model.md).
 *
 * Augments the `tags` table with five new columns and one timestamp pair,
 * then copies pre-existing data from two notes-as-config sidecars:
 *
 *   - tag_schemas (v6 sidecar) → tags.{description,fields}
 *   - notes at path `_tags/<name>` → tags.parent_names (from metadata.parents)
 *
 * After the copy lands, `tag_schemas` is dropped. The `_tags/<name>` notes
 * are LEFT IN PLACE — they're harmless historical record and a user might
 * have other content there. Future writes go to the tags row directly.
 *
 * Wrapped in BEGIN IMMEDIATE / COMMIT (with a try/catch ROLLBACK) so a
 * crash mid-migration leaves the DB in either pre-v14 or post-v14 state,
 * never half-migrated. Each step remains individually idempotent — the
 * transaction wrap is belt-and-suspenders, not load-bearing — so a future
 * reader who removes the `hasColumn` / `hasTable` guards still gets correct
 * behavior on retry.
 */
function migrateToV14(db: Database): void {
  if (!hasTable(db, "tags")) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    // 1. ALTER TABLE — additive, idempotent.
    const cols: [string, string][] = [
      ["description", "TEXT"],
      ["fields", "TEXT"],
      ["relationships", "TEXT"],
      ["parent_names", "TEXT"],
      ["created_at", "TEXT"],
      ["updated_at", "TEXT"],
    ];
    for (const [col, type] of cols) {
      if (!hasColumn(db, "tags", col)) {
        db.exec(`ALTER TABLE tags ADD COLUMN ${col} ${type}`);
      }
    }

    const now = new Date().toISOString();
    let copiedSchemas = 0;
    let copiedHierarchy = 0;

    // 2. Copy tag_schemas → tags.{description,fields}.
    if (hasTable(db, "tag_schemas")) {
      const rows = db.prepare(
        "SELECT tag_name, description, fields FROM tag_schemas",
      ).all() as { tag_name: string; description: string | null; fields: string | null }[];
      const upsert = db.prepare(
        "INSERT OR IGNORE INTO tags (name, created_at, updated_at) VALUES (?, ?, ?)",
      );
      const update = db.prepare(
        "UPDATE tags SET description = ?, fields = ?, updated_at = ? WHERE name = ?",
      );
      for (const row of rows) {
        upsert.run(row.tag_name, now, now);
        update.run(row.description, row.fields, now, row.tag_name);
        copiedSchemas++;
      }
    }

    // 3. Copy `_tags/<name>` notes' metadata.parents → tags.parent_names.
    // Only runs if the notes table exists (it always does post-SCHEMA_SQL,
    // but stay defensive — initSchema runs SCHEMA_SQL first so this is true).
    if (hasTable(db, "notes")) {
      const tagNotes = db.prepare(
        "SELECT path, metadata FROM notes WHERE path GLOB '_tags/*'",
      ).all() as { path: string; metadata: string | null }[];
      const upsert = db.prepare(
        "INSERT OR IGNORE INTO tags (name, created_at, updated_at) VALUES (?, ?, ?)",
      );
      const update = db.prepare(
        "UPDATE tags SET parent_names = ?, updated_at = ? WHERE name = ?",
      );
      for (const note of tagNotes) {
        const tagName = note.path.slice("_tags/".length);
        if (!tagName) continue;
        let parents: string[] | null = null;
        try {
          const meta = note.metadata ? JSON.parse(note.metadata) : {};
          const raw = meta?.parents;
          if (Array.isArray(raw) && raw.length > 0) {
            const cleaned = raw.filter((p: unknown): p is string => typeof p === "string" && p.length > 0);
            if (cleaned.length > 0) parents = cleaned;
          }
        } catch {
          // Malformed metadata — skip; the note is left untouched.
          continue;
        }
        if (!parents) continue;
        upsert.run(tagName, now, now);
        update.run(JSON.stringify(parents), now, tagName);
        copiedHierarchy++;
      }
    }

    // 4. Backfill timestamps for rows the copies didn't touch.
    db.exec(`UPDATE tags SET created_at = '${now}' WHERE created_at IS NULL`);

    // 5. Drop the sidecar after the copy is complete.
    if (hasTable(db, "tag_schemas")) {
      db.exec("DROP TABLE tag_schemas");
    }

    db.exec("COMMIT");

    if (copiedSchemas > 0 || copiedHierarchy > 0) {
      console.log(
        `[vault] migrated to schema v14: copied ${copiedSchemas} tag_schemas + ${copiedHierarchy} _tags/* hierarchies onto tags rows`,
      );
    }
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Migrate v14 → v15: retire `_schemas/<name>` + `_schema_defaults` notes
 * as the canonical source for schema definitions and mapping rules. After
 * this migration the resolver reads from `note_schemas` and
 * `schema_mappings` tables. The legacy notes are LEFT IN PLACE — they're
 * harmless historical record and a user might have other content there.
 *
 * Idempotent: SCHEMA_SQL creates the tables before this runs (CREATE TABLE
 * IF NOT EXISTS); the data copy uses INSERT OR IGNORE so re-running on a
 * post-v15 DB is a no-op. Wrapped in BEGIN/COMMIT so a crash mid-migration
 * leaves the DB in either pre-v15 or post-v15 state, never partial.
 */
function migrateToV15(db: Database): void {
  if (!hasTable(db, "note_schemas") || !hasTable(db, "notes")) return;

  // Short-circuit: if either destination table already has data, the
  // migration has run before. `||` not `&&` — a vault with schemas but zero
  // mappings (or mappings but zero schemas) is a valid post-v15 state, and
  // re-scanning notes on every boot would be wasted I/O.
  const hasSchemas = (db.prepare(
    "SELECT 1 FROM note_schemas LIMIT 1",
  ).get()) !== null;
  const hasMappings = (db.prepare(
    "SELECT 1 FROM schema_mappings LIMIT 1",
  ).get()) !== null;
  if (hasSchemas || hasMappings) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const now = new Date().toISOString();
    let copiedSchemas = 0;
    let copiedMappings = 0;

    // 1. Copy `_schemas/<name>` notes → note_schemas.
    const defRows = db.prepare(
      "SELECT path, metadata FROM notes WHERE path GLOB '_schemas/*'",
    ).all() as { path: string; metadata: string | null }[];
    const insertSchema = db.prepare(
      "INSERT OR IGNORE INTO note_schemas (name, description, fields, required, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const row of defRows) {
      const name = row.path.slice("_schemas/".length);
      if (!name) continue;
      let description: string | null = null;
      let fields: string | null = null;
      let required: string | null = null;
      try {
        const meta = row.metadata ? JSON.parse(row.metadata) : {};
        if (typeof meta?.description === "string") description = meta.description;
        if (meta?.fields && typeof meta.fields === "object" && !Array.isArray(meta.fields)) {
          fields = JSON.stringify(meta.fields);
        }
        if (Array.isArray(meta?.required)) {
          const cleaned = meta.required.filter((x: unknown): x is string => typeof x === "string");
          if (cleaned.length > 0) required = JSON.stringify(cleaned);
        }
      } catch {
        // Malformed metadata — skip; the note is left alone.
        continue;
      }
      insertSchema.run(name, description, fields, required, now, now);
      copiedSchemas++;
    }

    // 2. Copy `_schema_defaults` note → schema_mappings.
    const mappingNote = db.prepare(
      "SELECT metadata FROM notes WHERE path = '_schema_defaults'",
    ).get() as { metadata: string | null } | undefined;
    if (mappingNote?.metadata) {
      const insertMapping = db.prepare(
        "INSERT OR IGNORE INTO schema_mappings (schema_name, match_kind, match_value) VALUES (?, ?, ?)",
      );
      const ensureSchemaRow = db.prepare(
        "INSERT OR IGNORE INTO note_schemas (name, created_at, updated_at) VALUES (?, ?, ?)",
      );
      try {
        const meta = JSON.parse(mappingNote.metadata);
        const pathPrefixes = meta?.path_prefixes;
        if (pathPrefixes && typeof pathPrefixes === "object" && !Array.isArray(pathPrefixes)) {
          for (const [prefix, schema] of Object.entries(pathPrefixes as Record<string, unknown>)) {
            if (typeof schema === "string" && schema.length > 0 && prefix.length > 0) {
              // Foreign key requires the schema row to exist; create a stub
              // if the user mapped to a name with no _schemas/<name> note.
              ensureSchemaRow.run(schema, now, now);
              insertMapping.run(schema, "path_prefix", prefix);
              copiedMappings++;
            }
          }
        }
        const tags = meta?.tags;
        if (tags && typeof tags === "object" && !Array.isArray(tags)) {
          for (const [tag, schema] of Object.entries(tags as Record<string, unknown>)) {
            if (typeof schema === "string" && schema.length > 0 && tag.length > 0) {
              ensureSchemaRow.run(schema, now, now);
              insertMapping.run(schema, "tag", tag);
              copiedMappings++;
            }
          }
        }
      } catch {
        // Malformed _schema_defaults — leave both note and table empty;
        // user can fix and re-run.
      }
    }

    db.exec("COMMIT");

    if (copiedSchemas > 0 || copiedMappings > 0) {
      console.log(
        `[vault] migrated to schema v15: copied ${copiedSchemas} _schemas/* + ${copiedMappings} _schema_defaults mappings into note_schemas/schema_mappings`,
      );
    }
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
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
