/**
 * Tag schema CRUD — DB-backed storage for tag metadata schemas.
 *
 * Each tag can optionally have a schema that describes expected metadata
 * fields for notes with that tag. Schemas drive auto-population of defaults
 * and soft warnings on create/tag operations.
 */

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TagFieldSchema {
  type: string;
  description?: string;
  enum?: string[];
}

export interface TagSchema {
  tag: string;
  description?: string;
  fields?: Record<string, TagFieldSchema>;
}

// DB row shape
interface TagSchemaRow {
  tag_name: string;
  description: string | null;
  fields: string | null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** List all tag schemas. */
export function listTagSchemas(db: Database): TagSchema[] {
  const rows = db.prepare("SELECT * FROM tag_schemas ORDER BY tag_name").all() as TagSchemaRow[];
  return rows.map(rowToSchema);
}

/** Get a single tag's schema, or null if none defined. */
export function getTagSchema(db: Database, tag: string): TagSchema | null {
  const row = db.prepare("SELECT * FROM tag_schemas WHERE tag_name = ?").get(tag) as TagSchemaRow | undefined;
  return row ? rowToSchema(row) : null;
}

/** Get all schemas as a lookup map (tag → schema). Used by schema effects. */
export function getTagSchemaMap(db: Database): Record<string, { description?: string; fields?: Record<string, TagFieldSchema> }> {
  const schemas = listTagSchemas(db);
  const map: Record<string, { description?: string; fields?: Record<string, TagFieldSchema> }> = {};
  for (const s of schemas) {
    map[s.tag] = { description: s.description, fields: s.fields };
  }
  return map;
}

/**
 * Create or replace a tag schema (upsert).
 * Ensures the tag exists in the tags table first.
 */
export function upsertTagSchema(
  db: Database,
  tag: string,
  schema: { description?: string; fields?: Record<string, TagFieldSchema> },
): TagSchema {
  // Ensure tag exists
  db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tag);

  const fieldsJson = schema.fields ? JSON.stringify(schema.fields) : null;
  db.prepare(`
    INSERT INTO tag_schemas (tag_name, description, fields)
    VALUES (?, ?, ?)
    ON CONFLICT(tag_name) DO UPDATE SET
      description = excluded.description,
      fields = excluded.fields
  `).run(tag, schema.description ?? null, fieldsJson);

  return getTagSchema(db, tag)!;
}

/** Delete a tag's schema. Returns true if a schema was deleted. */
export function deleteTagSchema(db: Database, tag: string): boolean {
  const result = db.prepare("DELETE FROM tag_schemas WHERE tag_name = ?").run(tag);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSchema(row: TagSchemaRow): TagSchema {
  let fields: Record<string, TagFieldSchema> | undefined;
  if (row.fields) {
    try { fields = JSON.parse(row.fields); } catch {}
  }
  return {
    tag: row.tag_name,
    description: row.description ?? undefined,
    fields,
  };
}
