import { Database } from "bun:sqlite";
import { normalizePath } from "./paths.js";
import { rebuildIndexes } from "./indexed-fields.js";
import { transaction } from "./txn.js";

export const SCHEMA_VERSION = 23;

export const SCHEMA_SQL = `
-- Notes: the universal record.
--
-- extension (v18, vault#328) carries the file suffix the note should
-- exhibit when serialized to disk — "md" by default, "csv"/"yaml"/"json"/
-- "mdx"/etc. for non-markdown notes. Stored extension-less in the path
-- column; on-disk uniqueness key is (path, extension). See
-- core/src/portable-md.ts:supportsInlineFrontmatter for the
-- frontmatter-vs-sidecar split.
--
-- Write-attribution (v23, vault#298) — two axes of provenance, both nullable:
--   created_by / created_via        — the principal + interface of the FIRST
--                                     write (set once at create; never rewritten).
--   last_updated_by / last_updated_via — the principal + interface of the MOST
--                                     RECENT write (set on every mutating update).
-- The *_by columns are the actor (a JWT sub, or an operator/token label for
-- non-JWT auth); the *_via columns are the channel the write arrived through
-- (mcp, surface:NAME, agent:ID, operator/cli, api). Legacy rows stay NULL —
-- we don't fabricate authors for writes that predate attribution. See
-- migrateToV23.
CREATE TABLE IF NOT EXISTS notes (
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

-- Tags: first-class identity carrying schema, hierarchy, and typed-link
-- declarations. One row per tag; no notes-as-config sidecars for these
-- concerns. See parachute-patterns/patterns/tag-data-model.md.
--
-- description    — human-readable blurb (markdown).
-- fields         — JSON: indexed metadata field declarations per
--                  query-operators.md. Replaces v6-era tag_schemas.fields.
-- relationships  — JSON: opaque relationship-vocabulary map. Keys are
--                  relationship names; values are arbitrary JSON the declaring
--                  app interprets (e.g. the Weaver's { "works-on": { from, to } }).
--                  Stored + returned verbatim; only the top level is validated
--                  (must be a JSON object/map). The historical typed shape
--                  { "rel": { target_tag, cardinality, description? } } remains a
--                  valid value. Not enforced at write time. See vault#428.
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
--
-- note_schemas + schema_mappings (v15) were retired in v17 (vault#267).
-- The two-table validation subsystem turned out to be a parallel path to
-- the per-tag fields column with zero operator usage; v17 drops both
-- tables and the six MCP tools that managed them. Validation now reads
-- tags.fields exclusively — see core/src/schema-defaults.ts.

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
-- VESTIGIAL as of 0.5.0 (vault#282 Stage 2). Vault is a pure hub
-- resource-server: it no longer mints (pvt_*) or validates rows in this
-- table — auth runs through hub-issued JWTs + VAULT_AUTH_TOKEN + legacy YAML
-- api_keys only. The table is KEPT (not dropped) because migrateVaultKeys
-- raw-INSERTs legacy YAML api_keys here as its import landing zone, and
-- dropping it would trip an upgrade on a missing column for operators with
-- leftover rows. A future cosmetic migration may drop it alongside
-- oauth_clients/oauth_codes. 'tokens list' / 'tokens revoke' (CLI) still
-- read/delete here for cleanup of leftover rows. See the field docs below for
-- the historical (pre-0.5.0) semantics.
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
-- vault_name (v16) binds the token to a single vault. NULL means the
-- token is server-wide / legacy (pre-v16 rows backfill to NULL on the
-- migration; auth treats NULL as accept-any-vault for back-compat).
-- New tokens minted via per-vault routes write the column explicitly so
-- cross-vault presentation rejects in authenticateVaultRequest. See
-- vault#257.
--
-- scope_tag / scope_path_prefix are deprecated Phase-0 columns — never
-- enforced at runtime, kept only for schema stability.
-- created_via (v19) records the provenance of a token. NULL means the
-- legacy/unspecified path (CLI, REST mint, YAML import); 'mcp_mint' means
-- the token was minted by the manage-token MCP tool, which lets the
-- list/revoke surface of that tool restrict itself to its own session's
-- mints (no cross-session token management from inside MCP).
--
-- parent_jti (v19) is the display id (t_hashprefix) of the token that
-- minted this one, or the hub-JWT jti claim when minted from a hub
-- session. Session-pinned list+revoke in manage-token filters on this.
--
-- revoked_at (v19) marked soft-revocation of vault-DB tokens. Vestigial
-- post-0.5.0 (vault#282 Stage 2) — the validation path that read it
-- (resolveToken) was removed alongside the pvt_* mint.
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
  last_used_at TEXT,
  vault_name TEXT,
  created_via TEXT,
  parent_jti TEXT,
  revoked_at TEXT
);

-- mcp_mint_ledger (v20) — session-pinned record of HUB JWTs minted by the
-- manage-token MCP tool (vault#403, MGT). After the auth-unification arc,
-- manage-token mints hub JWTs (via hub mint-token attenuation proxy), not
-- pvt_* vault-DB tokens — so the mints no longer live in the tokens table.
-- This ledger is a lightweight local index of (parent_jti to minted hub jti)
-- so the tool list/revoke surface can stay session-scoped: a session sees
-- and revokes only the hub JWTs it minted. Rows are NOT credentials — the
-- signed JWT is never stored, only its jti (the revocation handle) plus
-- display metadata. revoked_at mirrors the tokens-table soft-revoke marker
-- so a second revoke is idempotent even if the hub round-trip is skipped.
-- The authoritative revocation state lives in hub token registry; this is
-- the attribution index only.
CREATE TABLE IF NOT EXISTS mcp_mint_ledger (
  jti TEXT PRIMARY KEY,
  parent_jti TEXT NOT NULL,
  vault_name TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes TEXT,
  scoped_tags TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

-- Triggers (v21, vault frictionless-channel-setup PR 1): runtime, persisted,
-- per-vault webhook triggers. Complements the static config.yaml trigger
-- system — config.yaml triggers stay global; rows here are scoped to THIS
-- vault's DB and fire only for events on this vault. The structured columns
-- (events/when/action) are JSON-encoded; the action column carries the webhook
-- URL, send mode, timeout, and an optional auth { bearer } for the JWT webhook
-- path. Managed at runtime via the admin-scoped /api/triggers REST surface
-- and re-registered on the live hook registry at boot. See src/triggers-api.ts.
CREATE TABLE IF NOT EXISTS triggers (
  name TEXT PRIMARY KEY,
  events TEXT NOT NULL DEFAULT '[]',
  "when" TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- OAuth: registered clients (Dynamic Client Registration)
-- VESTIGIAL after vault 0.4.x workstream E (2026-05-25). The standalone
-- OAuth issuer that wrote these rows was retired (hub is the issuer now;
-- vault is resource-server-only). The tables are left in place so an
-- upgrade doesn't trip on a missing column for any operator who still
-- has rows mid-upgrade. A future migration will drop them.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT,
  created_at TEXT NOT NULL
);

-- OAuth: authorization codes (single-use, short-lived)
-- VESTIGIAL — see oauth_clients above. The vault_name column survives
-- as a sentinel of the per-vault-pinning invariant that used to apply
-- when vault was the issuer.
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
-- Session-pinned manage-token ledger lookup (v20): list/revoke scope on
-- (parent_jti, vault_name). The mcp_mint_ledger table is created
-- unconditionally above, so this index is safe in SCHEMA_SQL.
CREATE INDEX IF NOT EXISTS idx_mcp_mint_ledger_session ON mcp_mint_ledger(parent_jti, vault_name);
-- idx_tokens_vault_name is created in migrateToV16, not here. SCHEMA_SQL
-- runs BEFORE migrations; an upgrading v15 vault doesn't yet have the
-- vault_name column when this section evaluates, so the index has to
-- live downstream of the ALTER TABLE that adds the column. Fresh vaults
-- (column already present from this CREATE TABLE) still get the index
-- because migrateToV16 also runs the unconditional CREATE INDEX path.
`;

/**
 * Connection-level pragmas applied on every Database open, in the order they
 * appear here.
 *
 * `journal_mode = WAL` is a persistent, DB-level setting (lives in the SQLite
 * header). Once any writer flips a DB into WAL it stays in WAL across opens
 * and processes — so daemon + CLI + parachute-runner + any read-side tool
 * see the same mode. Re-applying on every open is cheap and idempotent;
 * SQLite returns the current mode either way.
 *
 * `synchronous = NORMAL` is the safe, recommended pairing with WAL per the
 * SQLite docs: fsync only at checkpoint rather than on every commit. Crash
 * safety is preserved (WAL frames are still ordered + checksummed); the only
 * cost vs FULL is that an OS-level crash *between* checkpoints might lose
 * the last transaction. Acceptable for a knowledge graph that's snapshotted
 * by `VACUUM INTO` for backups.
 *
 * `wal_autocheckpoint = 1000` is SQLite's default; we set it explicitly so
 * the contract is visible in code rather than implicit. 1000 pages ≈ 4MB
 * before a passive checkpoint is triggered on the next write.
 *
 * `foreign_keys = ON` is per-connection (not persistent) — must be re-applied
 * on every open. Migrations occasionally disable it transiently (see
 * migrateToV14's BEGIN IMMEDIATE block); the boot path re-enables.
 *
 * WAL requires a filesystem that supports memory-mapped shared-memory
 * (the `-shm` sidecar). NFS, some FUSE mounts, and a few Docker volume
 * drivers don't qualify and silently fall back to the prior journal mode
 * (typically `delete`). `applyConnectionPragmas` detects this and returns
 * `wal: false` so the caller can log a warning — operators on those
 * filesystems should know they've lost multi-process concurrency.
 */
const APPLY_PRAGMAS_LOGGED = new WeakSet<Database>();

export interface ConnectionPragmaResult {
  /** True when the connection ended up in WAL mode. False means the FS doesn't support WAL. */
  wal: boolean;
  /** The actual journal_mode SQLite reports — "wal", "delete", "memory", etc. */
  journalMode: string;
}

/**
 * Apply connection-level pragmas (journal mode, synchronous, FK enforcement)
 * and verify WAL took effect. Idempotent — safe to call multiple times on
 * the same connection. Logs a one-time warning per connection when WAL
 * couldn't be applied.
 *
 * Exported for read-side callers (auth-status, mirror-manager, etc.) that
 * open a Database directly without going through initSchema. Setting
 * `journal_mode` on a read-only handle is a no-op but harmless; the
 * useful state is set by whichever writer opens first.
 */
export function applyConnectionPragmas(db: Database): ConnectionPragmaResult {
  // PRAGMA journal_mode returns a row { journal_mode: "wal" } on success.
  // Use `.get()` (not `.exec()`) so we capture the result. Some bun:sqlite
  // versions throw on readonly handles attempting to set journal_mode; treat
  // that as "we couldn't set it, just read the current value" and recover.
  let journalMode: string;
  try {
    const row = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | null;
    journalMode = (row?.journal_mode ?? "").toLowerCase();
  } catch {
    // Most likely: readonly handle. Read-only opens never write the DB
    // header, so they can't change journal_mode — but they can still query
    // the current mode, which is set by the most recent writer.
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
    journalMode = (row?.journal_mode ?? "").toLowerCase();
  }
  const wal = journalMode === "wal";

  // synchronous + wal_autocheckpoint only matter when WAL is active. They're
  // harmless under DELETE mode but the rationale is WAL-specific, so gate
  // them on the success path. Both are best-effort — wrap in try to keep
  // readonly handles (which reject writes) from failing the whole open.
  if (wal) {
    try { db.exec("PRAGMA synchronous = NORMAL"); } catch {}
    try { db.exec("PRAGMA wal_autocheckpoint = 1000"); } catch {}
  } else if (journalMode !== "memory" && !APPLY_PRAGMAS_LOGGED.has(db)) {
    // `journalMode === "memory"` ⇒ this is a `:memory:` database, an
    // explicit choice (tests, ephemeral probes) rather than a filesystem
    // limitation. Suppress the warning so the test suite stays quiet;
    // real on-disk vaults that can't host WAL (NFS, some FUSE/Docker
    // volume drivers) still surface the diagnostic.
    APPLY_PRAGMAS_LOGGED.add(db);
    // eslint-disable-next-line no-console
    console.warn(
      `[vault] WAL mode could not be enabled (journal_mode=${journalMode || "unknown"}). ` +
      `The underlying filesystem may not support WAL (NFS, some FUSE/Docker volume drivers). ` +
      `Multi-process concurrent access will be limited to a single writer at a time.`,
    );
  }

  try { db.exec("PRAGMA foreign_keys = ON"); } catch {}

  return { wal, journalMode };
}

/**
 * Initialize database schema. Idempotent — safe to call on every startup.
 */
export function initSchema(db: Database): void {
  applyConnectionPragmas(db);

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

  // Migrate v15 → v16: add `vault_name` column to tokens. Existing rows
  // backfilled to NULL ("server-wide / legacy" semantic) — at the time auth
  // accepted NULL for any vault so pre-v16 pvt_* tokens kept working. (pvt_*
  // validation was dropped at 0.5.0 / vault#282 Stage 2; the column is now
  // vestigial.) See vault#257.
  migrateToV16(db);

  // Migrate v16 → v17: rip the standalone `note_schemas` + `schema_mappings`
  // subsystem. Validation now reads `tags.fields` exclusively. The two
  // tables are dropped wholesale; if a vault carried rows we log a warning
  // naming the dropped schemas/mappings so the operator can recreate them
  // as `tags.fields` if needed. See vault#267.
  migrateToV17(db);

  // Migrate v17 → v18: add `notes.extension TEXT NOT NULL DEFAULT 'md'`.
  // Backward-compat by construction — every existing row defaults to "md"
  // (markdown), unchanged in meaning. See vault#328.
  migrateToV18(db);

  // Migrate v18 → v19: add MCP-mint provenance columns to `tokens`
  // (created_via, parent_jti, revoked_at) for vault#376's manage-token tool.
  // All three are nullable; existing rows backfill to NULL which means
  // "non-MCP-minted, not revoked" — identical pre-v19 semantics.
  migrateToV19(db);

  // Migrate v19 → v20: the `mcp_mint_ledger` table (session-pinned record of
  // hub JWTs minted by the manage-token MCP tool). Created by SCHEMA_SQL's
  // `CREATE TABLE IF NOT EXISTS` above, so this is a no-op confirmation hook
  // — present for symmetry with the other migration steps and to anchor the
  // version bump. See vault#403 (MGT — manage-token mints hub JWTs).
  migrateToV20(db);

  // Migrate v20 → v21: ensure the `triggers` table exists (runtime per-vault
  // webhook triggers). Created by SCHEMA_SQL's CREATE TABLE IF NOT EXISTS
  // above, so this is a defensive confirmation hook for upgrading vaults.
  migrateToV21(db);

  // Migrate v21 → v22: composite index notes(updated_at, id) backing cursor
  // keyset pagination and date_filter on updated_at — both were full table
  // scans. See the 2026-06-10 query-perf measurements.
  migrateToV22(db);

  // Migrate v22 → v23: write-attribution columns on `notes`
  // (created_by/created_via/last_updated_by/last_updated_via) + their indexes.
  // All four nullable; existing rows backfill to NULL ("written before
  // attribution" — we don't fabricate authors for legacy writes). See
  // vault#298.
  migrateToV23(db);

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

  const { copiedSchemas, copiedHierarchy } = transaction(db, () => {
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

    return { copiedSchemas, copiedHierarchy };
  });

  if (copiedSchemas > 0 || copiedHierarchy > 0) {
    console.log(
      `[vault] migrated to schema v14: copied ${copiedSchemas} tag_schemas + ${copiedHierarchy} _tags/* hierarchies onto tags rows`,
    );
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
  // note_schemas was dropped in v17; on any v17+ vault (or a v14→v17 skip),
  // this guard returns immediately and the function is effectively dead code.
  // Left in place rather than deleted because removing it would change initSchema's
  // migration call ordering. Safe to delete in a future cleanup.
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

  const { copiedSchemas, copiedMappings } = transaction(db, () => {
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
    ).get() as { metadata: string | null } | null;
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

    return { copiedSchemas, copiedMappings };
  });

  if (copiedSchemas > 0 || copiedMappings > 0) {
    console.log(
      `[vault] migrated to schema v15: copied ${copiedSchemas} _schemas/* + ${copiedMappings} _schema_defaults mappings into note_schemas/schema_mappings`,
    );
  }
}

/**
 * Migrate v15 → v16: per-vault token storage (vault#257).
 *
 * Adds `tokens.vault_name TEXT` (nullable). Existing rows stay NULL —
 * "server-wide / legacy" semantic. At the time, `authenticateVaultRequest`
 * accepted NULL for any vault so pre-v16 pvt_* tokens kept working. (pvt_*
 * validation + the `/vault/<name>/tokens` mint route were both removed at
 * 0.5.0 / vault#282 Stage 2 — the column + index are now vestigial; the
 * index still speeds the per-vault `listTokens` cleanup listing.)
 *
 * Wrapped in BEGIN IMMEDIATE / COMMIT (with try/catch ROLLBACK) per the
 * v14/v15 wrap pattern from vault#251 — the column add and index create
 * are individually idempotent (`hasColumn` / IF NOT EXISTS), but the
 * transaction means a crash mid-migration leaves either pre-v16 or
 * post-v16 state, never partial.
 */
function migrateToV16(db: Database): void {
  if (!hasTable(db, "tokens")) return;

  // Two responsibilities, separated so the index lands for both fresh
  // vaults (SCHEMA_SQL already created the column) and upgrading v15
  // vaults (column missing). Index creation lives outside the wrapped
  // ALTER block so a fresh vault — where the column exists but the index
  // doesn't — still gets it.
  if (!hasColumn(db, "tokens", "vault_name")) {
    transaction(db, () => {
      db.exec("ALTER TABLE tokens ADD COLUMN vault_name TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_vault_name ON tokens(vault_name)");
    });
    return;
  }

  // Column exists (fresh vault from SCHEMA_SQL, or post-upgrade vault).
  // Make sure the index exists too. IF NOT EXISTS makes this a no-op on
  // the steady-state path.
  db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_vault_name ON tokens(vault_name)");
}

/**
 * Migrate v16 → v17: rip `note_schemas` + `schema_mappings` (vault#267).
 *
 * The two-table validation subsystem from v15 turned out to be a parallel
 * path to `tags.fields` with zero operator usage. v17 drops both tables
 * outright. Fresh vaults never see them; upgrading vaults lose them.
 *
 * If an upgrading vault DID carry rows (which Aaron's didn't, but a future
 * operator's might), the migration logs the dropped names + mapping rules
 * so the operator can re-create them as `tags.fields` declarations on the
 * relevant tag rows. We don't try to auto-migrate path_prefix mappings —
 * the new validation surface is tag-axis only, and a path_prefix → tag
 * translation has no faithful one-to-one shape.
 *
 * Wrapped in BEGIN IMMEDIATE / COMMIT / ROLLBACK per the v14/v15/v16
 * pattern from vault#251 — DROP TABLE statements are individually atomic,
 * but the wrap means a crash mid-migration leaves either pre-v17 or
 * post-v17 state, never partial.
 */
function migrateToV17(db: Database): void {
  const hasNoteSchemas = hasTable(db, "note_schemas");
  const hasSchemaMappings = hasTable(db, "schema_mappings");
  if (!hasNoteSchemas && !hasSchemaMappings) return;

  // Snapshot any data so the operator can recreate as `tags.fields` if
  // needed. Read BEFORE the transaction so we don't lose the warning if
  // the DROP fails (the COMMIT below atomically swaps state).
  let droppedSchemas: { name: string; description: string | null }[] = [];
  let droppedMappings: { schema_name: string; match_kind: string; match_value: string }[] = [];
  if (hasNoteSchemas) {
    droppedSchemas = db.prepare(
      "SELECT name, description FROM note_schemas",
    ).all() as { name: string; description: string | null }[];
  }
  if (hasSchemaMappings) {
    droppedMappings = db.prepare(
      "SELECT schema_name, match_kind, match_value FROM schema_mappings",
    ).all() as { schema_name: string; match_kind: string; match_value: string }[];
  }

  transaction(db, () => {
    // Drop the index first — the index references the table; SQLite would
    // tear it down on DROP TABLE but the explicit DROP keeps the order
    // obvious if a future migration reads from sqlite_master mid-flight.
    db.exec("DROP INDEX IF EXISTS idx_schema_mappings_match");
    // schema_mappings has an FK to note_schemas — drop it first.
    if (hasSchemaMappings) {
      db.exec("DROP TABLE schema_mappings");
    }
    if (hasNoteSchemas) {
      db.exec("DROP TABLE note_schemas");
    }
  });

  if (droppedSchemas.length > 0 || droppedMappings.length > 0) {
    const schemaNames = droppedSchemas.map((s) => s.name).join(", ");
    const tagMappings = droppedMappings.filter((m) => m.match_kind === "tag");
    const pathMappings = droppedMappings.filter((m) => m.match_kind === "path_prefix");
    const lines: string[] = [
      `[vault] migrated to schema v17 (vault#267): note_schemas + schema_mappings retired.`,
    ];
    if (droppedSchemas.length > 0) {
      lines.push(`  dropped schemas (${droppedSchemas.length}): ${schemaNames}`);
    }
    if (tagMappings.length > 0) {
      const list = tagMappings.map((m) => `${m.match_value}→${m.schema_name}`).join(", ");
      lines.push(
        `  dropped tag mappings (${tagMappings.length}): ${list}`,
        `  recreate as \`tags.fields\` declarations on the relevant tag rows.`,
      );
    }
    if (pathMappings.length > 0) {
      const list = pathMappings.map((m) => `${m.match_value}→${m.schema_name}`).join(", ");
      lines.push(
        `  dropped path_prefix mappings (${pathMappings.length}): ${list}`,
        `  no path-prefix-driven validation in v17 — file vault#267 if you need this.`,
      );
    }
    console.log(lines.join("\n"));
  }
}

/**
 * Migrate v17 → v18: add `notes.extension TEXT NOT NULL DEFAULT 'md'`
 * (vault#328) AND widen the path-uniqueness index from `(path)` to
 * `(path, extension)` so two notes can share a path differing only by
 * extension (`Recipes/pasta` with both .md and .csv variants).
 *
 * Backward-compat by construction — every existing row defaults to "md",
 * so the new composite-index uniqueness collapses to the v5
 * "(path WHERE NOT NULL) is unique" behavior on existing data. Wrapped
 * in BEGIN IMMEDIATE / COMMIT / ROLLBACK per the v14+ pattern.
 */
function migrateToV18(db: Database): void {
  if (!hasTable(db, "notes")) return;

  // Two responsibilities (column add + index swap) — both idempotent
  // individually. Wrap in one transaction so an upgrading v17 vault
  // ends up at exactly v17 or v18, never partial.
  const needsColumn = !hasColumn(db, "notes", "extension");
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_notes_path_unique', 'idx_notes_path_ext_unique')",
  ).all() as { name: string }[];
  const hasOldUnique = indexes.some((r) => r.name === "idx_notes_path_unique");
  const hasNewUnique = indexes.some((r) => r.name === "idx_notes_path_ext_unique");
  if (!needsColumn && hasNewUnique && !hasOldUnique) return;

  transaction(db, () => {
    if (needsColumn) {
      db.exec("ALTER TABLE notes ADD COLUMN extension TEXT NOT NULL DEFAULT 'md'");
    }
    if (hasOldUnique) {
      db.exec("DROP INDEX idx_notes_path_unique");
    }
    if (!hasNewUnique) {
      db.exec(
        "CREATE UNIQUE INDEX idx_notes_path_ext_unique ON notes(path, extension) WHERE path IS NOT NULL",
      );
    }
  });
}

/**
 * Migrate v18 → v19: add `created_via`, `parent_jti`, `revoked_at` columns
 * to `tokens` so manage-token can attribute mints to the MCP session that
 * minted them, scope its list+revoke to those tokens, and soft-revoke
 * (preserving the audit trail).
 *
 * All three columns are nullable; existing rows backfill to NULL with
 * back-compat semantics — `created_via IS NULL` matches the CLI/REST-mint
 * provenance, `revoked_at IS NULL` matches "still active". Idempotent —
 * the column-existence guard means the migration is safe to re-run on a
 * post-v19 vault. See vault#376.
 */
function migrateToV19(db: Database): void {
  if (!hasTable(db, "tokens")) return;
  const cols: [string, string][] = [
    ["created_via", "TEXT"],
    ["parent_jti", "TEXT"],
    ["revoked_at", "TEXT"],
  ];
  for (const [col, type] of cols) {
    if (!hasColumn(db, "tokens", col)) {
      db.exec(`ALTER TABLE tokens ADD COLUMN ${col} ${type}`);
    }
  }
}

/**
 * Migrate v19 → v20: ensure the `mcp_mint_ledger` table exists. SCHEMA_SQL's
 * `CREATE TABLE IF NOT EXISTS` already covers fresh vaults AND upgrading
 * vaults (SCHEMA_SQL runs unconditionally on every open before the migration
 * steps), so this is a defensive no-op confirmation — there is no ALTER to
 * perform. Kept as a named step so the version-bump arc reads cleanly and a
 * future column addition has an obvious home. See vault#403 (MGT).
 */
function migrateToV20(db: Database): void {
  if (hasTable(db, "mcp_mint_ledger")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_mint_ledger (
      jti TEXT PRIMARY KEY,
      parent_jti TEXT NOT NULL,
      vault_name TEXT NOT NULL,
      label TEXT NOT NULL,
      scopes TEXT,
      scoped_tags TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_mcp_mint_ledger_session ON mcp_mint_ledger(parent_jti, vault_name)",
  );
}

/**
 * Migrate v20 → v21: ensure the `triggers` table exists (runtime per-vault
 * webhook triggers — vault frictionless-channel-setup PR 1). SCHEMA_SQL's
 * `CREATE TABLE IF NOT EXISTS` already covers fresh AND upgrading vaults
 * (it runs unconditionally before the migration steps), so this is a
 * defensive no-op confirmation for vaults created before v21. The reserved
 * keyword `when` is quoted in the column definition. Idempotent.
 */
function migrateToV21(db: Database): void {
  if (hasTable(db, "triggers")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      name TEXT PRIMARY KEY,
      events TEXT NOT NULL DEFAULT '[]',
      "when" TEXT NOT NULL DEFAULT '{}',
      action TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

/**
 * Migrate v21 → v22: composite B-tree on notes(updated_at, id).
 *
 * Two query shapes ride it (2026-06-10 perf measurements — both were full
 * table scans + temp-B-tree sorts before):
 *
 *   1. Cursor keyset pagination (vault#313): the predicate
 *      `updated_at > ? OR (updated_at = ? AND id > ?)` with
 *      `ORDER BY updated_at ASC, id ASC` matches the composite key exactly,
 *      so a "since last checked" poll seeks straight to the watermark and
 *      streams in order — no scan, no sort.
 *   2. `date_filter: { field: "updated_at" }` range queries (incremental
 *      rebuild flows, vault#285 1.5).
 *
 * Lives here (not SCHEMA_SQL) following the idx_tokens_vault_name precedent:
 * migrations run after every column-shape change, so the index statement
 * never races an older table shape. Fresh vaults reach this through the
 * same initSchema path — CREATE INDEX IF NOT EXISTS is idempotent.
 */
function migrateToV22(db: Database): void {
  if (!hasTable(db, "notes")) return;
  db.exec("CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at, id)");
}

/**
 * Migrate v22 → v23: per-identity + per-interface write attribution
 * (vault#298). Adds four nullable columns to `notes` and an index on each so
 * "what did Mathilda write" / "what came in via the meeting-ingest surface"
 * are indexed lookups, not scans:
 *
 *   created_by        — principal (actor) of the first write
 *   created_via       — interface/channel of the first write
 *   last_updated_by   — principal of the most recent write
 *   last_updated_via  — interface/channel of the most recent write
 *
 * `*_by` is the JWT `sub` (or an operator / `token:<id>` label for non-JWT
 * auth); `*_via` is the channel (`mcp`, `surface:<name>`, `agent:<id>`,
 * `operator`/`cli`, `api`). All four NULL on legacy rows — we deliberately do
 * NOT backfill an author for writes that predate attribution; NULL reads as
 * "unknown / pre-attribution," distinct from any real principal.
 *
 * Columns live here (not SCHEMA_SQL's index block) following the
 * idx_tokens_vault_name / idx_notes_updated precedent: SCHEMA_SQL runs before
 * the migration steps, so an upgrading v22 vault doesn't yet have the columns
 * when that block evaluates. Fresh vaults get the columns from the CREATE
 * TABLE above and the indexes from this same path. All idempotent — the
 * column-existence guard + CREATE INDEX IF NOT EXISTS make re-runs no-ops.
 */
function migrateToV23(db: Database): void {
  if (!hasTable(db, "notes")) return;
  const cols = ["created_by", "created_via", "last_updated_by", "last_updated_via"];
  for (const col of cols) {
    if (!hasColumn(db, "notes", col)) {
      db.exec(`ALTER TABLE notes ADD COLUMN ${col} TEXT`);
    }
  }
  for (const col of cols) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_${col} ON notes(${col})`);
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
