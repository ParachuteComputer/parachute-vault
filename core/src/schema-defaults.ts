/**
 * Schema validation: walk the tags carried by a note, look up each tag's
 * `fields` declaration, and validate the note's metadata against the
 * collected field declarations. Writes are never blocked — schemas are
 * guidance. The MCP/REST layer surfaces a `validation_status` block on
 * create/update responses with any warnings the agent can act on (type
 * mismatch, enum mismatch).
 *
 * Storage: schemas live as `fields` columns on the `tags` table — same row
 * that already carries description, relationships, and parent_names. Authoring
 * is via `update-tag` (MCP) or PATCH /api/tags/:name (REST).
 *
 * This was a two-table subsystem (`note_schemas` + `schema_mappings`) prior
 * to v17 — see vault#267. Removed in v17 because zero operator vaults used
 * the path-prefix mapping kind, and tag-mapped schemas were fully redundant
 * with `tags.fields`. The single-axis tag-driven validation lives here.
 *
 * Resolution model:
 * - Lazy: rebuilt on first access, cached on the store.
 * - Invalidated when `tags.fields` is mutated (upsert/delete tag schema or
 *   tag record).
 * - When no tag on the note declares fields, validation is a no-op (status
 *   omitted).
 */

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchemaField {
  type?: "string" | "number" | "boolean" | "array" | "object";
  enum?: string[];
  description?: string;
}

/**
 * Per-tag field map: { tagName: { fieldName: SchemaField } }. Empty when no
 * tag declares any fields.
 */
export interface ResolvedSchemas {
  tagToFields: Map<string, Record<string, SchemaField>>;
}

export interface ValidationWarning {
  field: string;
  /** Tag whose schema declared the violated field. */
  schema: string;
  /** "type_mismatch" | "enum_mismatch" */
  reason: "type_mismatch" | "enum_mismatch";
  message: string;
}

export interface ValidationStatus {
  /** Tag names whose schemas applied (for transparency). */
  schemas: string[];
  /** Empty when all checks pass. */
  warnings: ValidationWarning[];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function parseFieldsJson(raw: string | null): Record<string, SchemaField> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const fields: Record<string, SchemaField> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const f = v as Record<string, unknown>;
    const field: SchemaField = {};
    if (typeof f.type === "string") field.type = f.type as SchemaField["type"];
    if (Array.isArray(f.enum)) field.enum = f.enum.filter((x): x is string => typeof x === "string");
    if (typeof f.description === "string") field.description = f.description;
    fields[k] = field;
  }
  return fields;
}

/**
 * Build a resolution map from the `tags` table. Returns a well-formed
 * `ResolvedSchemas` even when no tag declares fields (empty map).
 */
export function loadSchemaConfig(db: Database): ResolvedSchemas {
  const tagToFields = new Map<string, Record<string, SchemaField>>();
  const rows = db.prepare(
    `SELECT name, fields FROM tags WHERE fields IS NOT NULL`,
  ).all() as { name: string; fields: string | null }[];
  for (const row of rows) {
    if (!row.name) continue;
    const fields = parseFieldsJson(row.fields);
    if (Object.keys(fields).length === 0) continue;
    tagToFields.set(row.name, fields);
  }
  return { tagToFields };
}

// ---------------------------------------------------------------------------
// Resolution + validation
// ---------------------------------------------------------------------------

/**
 * Find the tags on this note whose schemas declare at least one field.
 * Returns tag *names* in note-tag order.
 */
export function resolveApplicableSchemas(
  resolved: ResolvedSchemas,
  note: { tags?: string[] },
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  if (!note.tags) return names;
  for (const tag of note.tags) {
    if (seen.has(tag)) continue;
    if (resolved.tagToFields.has(tag)) {
      names.push(tag);
      seen.add(tag);
    }
  }
  return names;
}

function valueMatchesType(value: unknown, type: SchemaField["type"]): boolean {
  if (type === undefined) return true;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
  }
}

/**
 * Validate a note's metadata against each applicable tag's `fields` and
 * collect warnings. Validation is non-blocking — the caller decides what to
 * do with the warnings (currently: surface them on the create/update
 * response).
 *
 * Rules per field:
 * - Present and `type` declared and value's type doesn't match → `type_mismatch`
 * - Present and `enum` declared and value not in enum → `enum_mismatch`
 *
 * Fields not declared by any applicable tag's schema are ignored entirely
 * (this isn't a "strict" validator — it's a guide). There is no `required`
 * concept on `tags.fields` (post-v17); declarations are advisory only.
 */
export function validateMetadata(
  resolved: ResolvedSchemas,
  schemaNames: string[],
  metadata: Record<string, unknown> | undefined,
): ValidationStatus {
  const warnings: ValidationWarning[] = [];
  const m = metadata ?? {};

  for (const name of schemaNames) {
    const fields = resolved.tagToFields.get(name);
    if (!fields) continue;

    for (const [fieldName, field] of Object.entries(fields)) {
      if (!(fieldName in m)) continue;
      const value = m[fieldName];
      if (value === undefined || value === null) continue;

      if (field.type && !valueMatchesType(value, field.type)) {
        warnings.push({
          field: fieldName,
          schema: name,
          reason: "type_mismatch",
          message: `'${fieldName}' should be ${field.type} (tag '${name}')`,
        });
      }

      if (field.enum && field.enum.length > 0 && typeof value === "string" && !field.enum.includes(value)) {
        warnings.push({
          field: fieldName,
          schema: name,
          reason: "enum_mismatch",
          message: `'${fieldName}' must be one of [${field.enum.join(", ")}] (tag '${name}')`,
        });
      }
    }
  }

  return { schemas: schemaNames, warnings };
}

/**
 * Convenience: combine resolve + validate for a note. Returns null when no
 * tag on the note declares any fields (so the caller can decide whether to
 * omit the field on the response or surface an empty status).
 */
export function validateNote(
  resolved: ResolvedSchemas,
  note: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> },
): ValidationStatus | null {
  const names = resolveApplicableSchemas(resolved, note);
  if (names.length === 0) return null;
  return validateMetadata(resolved, names, note.metadata);
}
