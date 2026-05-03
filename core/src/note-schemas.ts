/**
 * CRUD for the v15 `note_schemas` and `schema_mappings` tables.
 *
 * Replaces the v14-and-earlier `_schemas/<name>` and `_schema_defaults`
 * notes-as-config convention. The legacy notes are LEFT IN PLACE post-v15
 * but are no longer read by the resolver (see `schema-defaults.ts`).
 *
 * `note_schemas` rows are the schema definitions themselves; `schema_mappings`
 * rows are the rules that decide which notes a schema applies to (by path
 * prefix or by tag). One schema can be referenced by many mappings.
 */

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Allowed values for `schema_mappings.match_kind`. */
export const MAPPING_KINDS = ["path_prefix", "tag"] as const;
export type SchemaMappingKind = (typeof MAPPING_KINDS)[number];

export interface NoteSchemaField {
  type?: "string" | "number" | "boolean" | "array" | "object";
  enum?: string[];
  description?: string;
}

export interface NoteSchemaRecord {
  name: string;
  description: string | null;
  fields: Record<string, NoteSchemaField> | null;
  required: string[] | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SchemaMappingRecord {
  schema_name: string;
  match_kind: SchemaMappingKind;
  match_value: string;
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

interface SchemaRow {
  name: string;
  description: string | null;
  fields: string | null;
  required: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function parseFields(raw: string | null): Record<string, NoteSchemaField> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, NoteSchemaField>;
  } catch {
    return null;
  }
}

function parseRequired(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed.filter((x): x is string => typeof x === "string");
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

function rowToRecord(row: SchemaRow): NoteSchemaRecord {
  return {
    name: row.name,
    description: row.description,
    fields: parseFields(row.fields),
    required: parseRequired(row.required),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// note_schemas: read
// ---------------------------------------------------------------------------

export function listNoteSchemas(db: Database): NoteSchemaRecord[] {
  const rows = db.prepare(
    "SELECT name, description, fields, required, created_at, updated_at FROM note_schemas ORDER BY name",
  ).all() as SchemaRow[];
  return rows.map(rowToRecord);
}

export function getNoteSchema(db: Database, name: string): NoteSchemaRecord | null {
  const row = db.prepare(
    "SELECT name, description, fields, required, created_at, updated_at FROM note_schemas WHERE name = ?",
  ).get(name) as SchemaRow | undefined;
  return row ? rowToRecord(row) : null;
}

// ---------------------------------------------------------------------------
// note_schemas: write — partial upsert (mirrors upsertTagRecord shape)
// ---------------------------------------------------------------------------

export interface NoteSchemaPatch {
  description?: string | null;
  fields?: Record<string, NoteSchemaField> | null;
  required?: string[] | null;
}

/**
 * Partial-upsert a note schema. Auto-creates the row if missing. Any patch
 * field left undefined is preserved; pass null to clear. Empty `required: []`
 * collapses to null so the read path treats "no required fields" the same
 * as "required not declared."
 */
export function upsertNoteSchema(
  db: Database,
  name: string,
  patch: NoteSchemaPatch,
): NoteSchemaRecord {
  if (!name || typeof name !== "string") {
    throw new Error("note schema name must be a non-empty string");
  }

  const now = new Date().toISOString();
  const existing = getNoteSchema(db, name);

  const description = patch.description !== undefined ? patch.description : existing?.description ?? null;
  const fields =
    patch.fields !== undefined
      ? (patch.fields ? JSON.stringify(patch.fields) : null)
      : (existing?.fields ? JSON.stringify(existing.fields) : null);
  let requiredRaw: string | null;
  if (patch.required !== undefined) {
    requiredRaw = patch.required && patch.required.length > 0 ? JSON.stringify(patch.required) : null;
  } else {
    requiredRaw = existing?.required && existing.required.length > 0 ? JSON.stringify(existing.required) : null;
  }

  if (existing) {
    db.prepare(
      "UPDATE note_schemas SET description = ?, fields = ?, required = ?, updated_at = ? WHERE name = ?",
    ).run(description, fields, requiredRaw, now, name);
  } else {
    db.prepare(
      "INSERT INTO note_schemas (name, description, fields, required, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(name, description, fields, requiredRaw, now, now);
  }

  return getNoteSchema(db, name)!;
}

/**
 * Delete a note schema and all its mappings (via ON DELETE CASCADE).
 * Returns true if the row existed.
 */
export function deleteNoteSchema(db: Database, name: string): boolean {
  const result = db.prepare("DELETE FROM note_schemas WHERE name = ?").run(name);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// schema_mappings: read + write
// ---------------------------------------------------------------------------

export interface ListMappingsOpts {
  schema_name?: string;
  match_kind?: SchemaMappingKind;
}

export function listSchemaMappings(db: Database, opts: ListMappingsOpts = {}): SchemaMappingRecord[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.schema_name) {
    where.push("schema_name = ?");
    params.push(opts.schema_name);
  }
  if (opts.match_kind) {
    where.push("match_kind = ?");
    params.push(opts.match_kind);
  }
  const sql = `SELECT schema_name, match_kind, match_value FROM schema_mappings${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY schema_name, match_kind, match_value`;
  return db.prepare(sql).all(...params) as SchemaMappingRecord[];
}

/**
 * Idempotent insert. Composite PK on (schema, kind, value) — re-setting
 * the same triple is a no-op. Throws if `schema_name` doesn't reference
 * an existing `note_schemas` row (FK constraint).
 */
export function setSchemaMapping(
  db: Database,
  schema_name: string,
  match_kind: SchemaMappingKind,
  match_value: string,
): void {
  if (!MAPPING_KINDS.includes(match_kind)) {
    throw new Error(`match_kind must be one of: ${MAPPING_KINDS.join(", ")}`);
  }
  if (!match_value || typeof match_value !== "string") {
    throw new Error("match_value must be a non-empty string");
  }
  db.prepare(
    "INSERT OR IGNORE INTO schema_mappings (schema_name, match_kind, match_value) VALUES (?, ?, ?)",
  ).run(schema_name, match_kind, match_value);
}

/**
 * Delete a single mapping. Returns true if a row was removed.
 */
export function deleteSchemaMapping(
  db: Database,
  schema_name: string,
  match_kind: SchemaMappingKind,
  match_value: string,
): boolean {
  const result = db.prepare(
    "DELETE FROM schema_mappings WHERE schema_name = ? AND match_kind = ? AND match_value = ?",
  ).run(schema_name, match_kind, match_value);
  return result.changes > 0;
}
