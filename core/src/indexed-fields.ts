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
  // Stable error_type (vault#554) — additive; matches the string REST has
  // hardcoded in its json response since vault#478. Lets the generic MCP
  // domain-error mapping (src/mcp-http.ts) pick this class up.
  error_type = "invalid_indexed_field" as const;
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
    .get(field) as IndexedFieldRow | null;
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

export interface PrunedField {
  /** The field whose `indexed_fields` row was affected. */
  field: string;
  /** Declarer tags that no longer have a `tags` row (removed from the set). */
  deadDeclarers: string[];
  /**
   * True when the field had NO surviving live declarer and was fully dropped
   * (row + generated column + index). False when at least one live declarer
   * remained and only the dead declarers were pruned from the set.
   */
  dropped: boolean;
}

/**
 * Prune orphaned `indexed_fields` declarers — the gitcoin defect.
 *
 * A declarer tag is "dead" when no `tags` row carries that name (the tag was
 * deleted, or its schema was cleared, without releasing the field). For every
 * `indexed_fields` row:
 *
 *   - Drop dead declarers from the set.
 *   - If NO live declarer remains, drop the whole field — row + generated
 *     column + index. This is the only data-loss-free drop: the generated
 *     column is `json_extract(metadata, …)` so the source values stay in
 *     `notes.metadata`; only the (now-dead) index is lost.
 *   - If at least one live declarer remains (co-declaration), keep the column
 *     and just trim the dead names from the declarer set.
 *
 * `dryRun` (default) computes the plan without mutating; pass `dryRun: false`
 * to apply. Returns the per-field plan either way so the CLI / MCP surface can
 * print what it would (or did) drop.
 */
export function pruneOrphanedIndexedFields(
  db: Database,
  opts: { dryRun?: boolean } = {},
): PrunedField[] {
  const dryRun = opts.dryRun ?? true;
  const liveTags = new Set(
    (db.prepare("SELECT name FROM tags").all() as { name: string }[]).map((r) => r.name),
  );
  const plan: PrunedField[] = [];
  for (const f of listIndexedFields(db)) {
    const deadDeclarers = f.declarerTags.filter((t) => !liveTags.has(t));
    if (deadDeclarers.length === 0) continue; // every declarer is live — leave it
    const liveDeclarers = f.declarerTags.filter((t) => liveTags.has(t));
    const dropped = liveDeclarers.length === 0;
    plan.push({ field: f.field, deadDeclarers, dropped });
    if (dryRun) continue;
    if (dropped) {
      db.prepare("DELETE FROM indexed_fields WHERE field = ?").run(f.field);
      dropColumnAndIndex(db, f.field);
    } else {
      db.prepare("UPDATE indexed_fields SET declarer_tags = ? WHERE field = ?").run(
        JSON.stringify(liveDeclarers),
        f.field,
      );
    }
  }
  return plan;
}

/**
 * Replay `declareField` for every field a tag schema marks `indexed: true`.
 * Idempotent — used by the portable-md import path so a fresh import ends with
 * the same generated columns a live vault would have (the import writes
 * `tags.fields` via `upsertTagRecord` but never materializes the backing
 * columns). Without this, an imported vault's schemas say `indexed: true` but
 * queries fall back to full scans until each tag is next `update-tag`'d.
 *
 * `tagSchemas` is the post-import set of (tag, fields) pairs. Returns the
 * number of (tag, field) declarations replayed.
 */
export function reconcileDeclaredIndexes(
  db: Database,
  tagSchemas: { tag: string; fields?: Record<string, { type: string; indexed?: boolean }> }[],
): number {
  let declared = 0;
  for (const schema of tagSchemas) {
    if (!schema.fields) continue;
    for (const [fieldName, spec] of Object.entries(schema.fields)) {
      if (spec.indexed !== true) continue;
      const mapped = mapFieldType(spec.type);
      if (!mapped) continue; // unsupported type for indexing — skip, don't throw
      try {
        validateFieldName(fieldName);
        declareField(db, fieldName, mapped, schema.tag);
        declared++;
      } catch (err) {
        console.error(
          `[indexed-fields] could not re-declare "${fieldName}" for tag "${schema.tag}" on import:`,
          err,
        );
      }
    }
  }
  return declared;
}
