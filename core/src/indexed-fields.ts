/**
 * Indexed-field lifecycle — manages generated columns + indexes on `notes`
 * for metadata fields declared `indexed: true` by one or more tag schemas.
 *
 * Semantic: the tag authorizes the index, but the index is universal across
 * all notes (not partitioned by tag). A generated column mirrors
 * `json_extract(metadata, '$.<field>')` and a B-tree index on that column
 * makes operator queries (eq/gt/lt/in/...) and `order_by` fast.
 *
 * Lifetime is tied to the declarer set: the column + index exist as long as
 * at least one tag schema declares `indexed: true` for the field. When the
 * last declarer releases (schema update or `delete-tag`), the column + index
 * are dropped. The `indexed_fields` table is the single source of truth and
 * is used by `rebuildIndexes` on vault init for idempotent reconstruction.
 *
 * See Parachute/Decisions/2026-04-19-metadata-indexing-via-tag-schemas.
 */

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SqliteType = "TEXT" | "INTEGER";
export type FieldType = "string" | "integer" | "boolean";

export const TYPE_MAP: Record<FieldType, SqliteType> = {
  string: "TEXT",
  integer: "INTEGER",
  boolean: "INTEGER",
};

export interface IndexedField {
  field: string;
  sqliteType: SqliteType;
  declarerTags: string[];
}

interface IndexedFieldRow {
  field: string;
  sqlite_type: string;
  declarer_tags: string;
}

export class IndexedFieldError extends Error {
  override name = "IndexedFieldError";
}

// Restrict field names to safe SQL identifiers. This also bounds the
// generated column and index names, which are derived from the field.
const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export function validateFieldName(field: string): void {
  if (!FIELD_NAME_RE.test(field)) {
    throw new IndexedFieldError(
      `invalid field name "${field}": must start with a letter or underscore and contain only [A-Za-z0-9_] (max 63 chars)`,
    );
  }
}

/** Map a tag-schema field type to the backing SQLite storage class. */
export function mapFieldType(type: string): SqliteType | null {
  return TYPE_MAP[type as FieldType] ?? null;
}

function columnName(field: string): string {
  return `meta_${field}`;
}

function indexName(field: string): string {
  return `idx_meta_${field}`;
}

function rowToField(row: IndexedFieldRow): IndexedField {
  let declarerTags: string[] = [];
  try {
    const parsed = JSON.parse(row.declarer_tags);
    if (Array.isArray(parsed)) {
      declarerTags = parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {}
  return {
    field: row.field,
    sqliteType: row.sqlite_type as SqliteType,
    declarerTags,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function listIndexedFields(db: Database): IndexedField[] {
  const rows = db
    .prepare("SELECT field, sqlite_type, declarer_tags FROM indexed_fields ORDER BY field")
    .all() as IndexedFieldRow[];
  return rows.map(rowToField);
}

export function getIndexedField(db: Database, field: string): IndexedField | null {
  const row = db
    .prepare("SELECT field, sqlite_type, declarer_tags FROM indexed_fields WHERE field = ?")
    .get(field) as IndexedFieldRow | undefined;
  return row ? rowToField(row) : null;
}

// ---------------------------------------------------------------------------
// DDL helpers
// ---------------------------------------------------------------------------

function hasNotesColumn(db: Database, col: string): boolean {
  // `table_xinfo` includes generated (VIRTUAL) columns, which `table_info`
  // omits. We use xinfo here so re-declaration paths detect the existing
  // generated column and stay idempotent.
  const rows = db.prepare("PRAGMA table_xinfo(notes)").all() as { name: string }[];
  return rows.some((r) => r.name === col);
}

function createColumnAndIndex(db: Database, field: string, sqliteType: SqliteType): void {
  const col = columnName(field);
  if (!hasNotesColumn(db, col)) {
    // SQLite requires VIRTUAL (not STORED) for generated columns added via
    // ALTER TABLE. VIRTUAL is also what we want here: the value isn't stored
    // twice (just indexed), so writes stay cheap.
    db.exec(
      `ALTER TABLE notes ADD COLUMN "${col}" ${sqliteType} GENERATED ALWAYS AS (json_extract(metadata, '$."${field}"')) VIRTUAL`,
    );
  }
  db.exec(`CREATE INDEX IF NOT EXISTS "${indexName(field)}" ON notes("${col}")`);
}

function dropColumnAndIndex(db: Database, field: string): void {
  db.exec(`DROP INDEX IF EXISTS "${indexName(field)}"`);
  if (hasNotesColumn(db, columnName(field))) {
    db.exec(`ALTER TABLE notes DROP COLUMN "${columnName(field)}"`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle operations
// ---------------------------------------------------------------------------

/**
 * Register `tag` as a declarer of indexed `field` with the given storage type.
 *
 * - First declarer: inserts the row, creates the generated column + index.
 * - Additional declarer (matching type): adds tag to the set. Idempotent if
 *   the tag is already a declarer.
 * - Type mismatch with an existing *other* declarer: throws. This is a
 *   defensive check; the MCP layer should have already rejected the call
 *   with a more descriptive cross-tag error message.
 * - Type mismatch when this tag is the sole declarer: drops + recreates the
 *   column with the new type. Allowed because no other schema's contract
 *   depends on the prior type.
 */
export function declareField(
  db: Database,
  field: string,
  sqliteType: SqliteType,
  tag: string,
): void {
  validateFieldName(field);
  const existing = getIndexedField(db, field);
  if (!existing) {
    db.prepare(
      "INSERT INTO indexed_fields (field, sqlite_type, declarer_tags) VALUES (?, ?, ?)",
    ).run(field, sqliteType, JSON.stringify([tag]));
    createColumnAndIndex(db, field, sqliteType);
    return;
  }
  if (existing.sqliteType !== sqliteType) {
    const others = existing.declarerTags.filter((t) => t !== tag);
    if (others.length > 0) {
      throw new IndexedFieldError(
        `field "${field}" is declared by tag(s) [${others.join(", ")}] with sqlite type ${existing.sqliteType}; tag "${tag}" requested ${sqliteType}`,
      );
    }
    dropColumnAndIndex(db, field);
    db.prepare(
      "UPDATE indexed_fields SET sqlite_type = ?, declarer_tags = ? WHERE field = ?",
    ).run(sqliteType, JSON.stringify([tag]), field);
    createColumnAndIndex(db, field, sqliteType);
    return;
  }
  if (existing.declarerTags.includes(tag)) {
    createColumnAndIndex(db, field, sqliteType);
    return;
  }
  const next = [...existing.declarerTags, tag];
  db.prepare("UPDATE indexed_fields SET declarer_tags = ? WHERE field = ?").run(
    JSON.stringify(next),
    field,
  );
  createColumnAndIndex(db, field, sqliteType);
}

/**
 * Remove `tag` from `field`'s declarer set. If the set becomes empty, drop
 * the row, the generated column, and the index. Returns true if the column
 * was dropped.
 */
export function releaseField(db: Database, field: string, tag: string): boolean {
  const existing = getIndexedField(db, field);
  if (!existing) return false;
  const next = existing.declarerTags.filter((t) => t !== tag);
  if (next.length === 0) {
    db.prepare("DELETE FROM indexed_fields WHERE field = ?").run(field);
    dropColumnAndIndex(db, field);
    return true;
  }
  db.prepare("UPDATE indexed_fields SET declarer_tags = ? WHERE field = ?").run(
    JSON.stringify(next),
    field,
  );
  return false;
}

/**
 * Reconcile the generated columns + indexes with `indexed_fields` rows.
 * Idempotent — safe to call on every vault init.
 *
 * `indexed_fields` is authoritative. Any row without its column/index gets
 * one created. Extras (columns beginning with `meta_` but not backed by a
 * row) are not touched — cleanup happens through the normal release path.
 */
export function rebuildIndexes(db: Database): void {
  for (const f of listIndexedFields(db)) {
    try {
      createColumnAndIndex(db, f.field, f.sqliteType);
    } catch (err) {
      console.error(
        `[indexed-fields] could not rebuild column for "${f.field}":`,
        err,
      );
    }
  }
}
