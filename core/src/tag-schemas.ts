/**
 * Tag record CRUD — DB-backed storage for the per-tag identity row.
 *
 * Each tag row carries: human-readable description, indexed metadata field
 * declarations (`fields`), typed-link relationship declarations
 * (`relationships`), and the hierarchy parent list (`parent_names`).
 * See docs/contracts/tag-data-model.md.
 *
 * This module retains the historical `tag-schemas` filename and exports
 * (`TagSchema`, `listTagSchemas`, `getTagSchema`, `upsertTagSchema`,
 * `deleteTagSchema`, `getTagSchemaMap`) as a thin schema-only facade —
 * callers that only care about `description + fields` keep working without
 * change. New surface (`TagRecord`, `listTagRecords`, `getTagRecord`,
 * `upsertTagRecord`) returns the full row including relationships and
 * parent_names.
 */

import { Database } from "bun:sqlite";
import { mapFieldType, validateFieldName } from "./indexed-fields.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TagFieldSchema {
  type: string;
  description?: string;
  enum?: string[];
  // When true, a generated column + index are maintained on `notes` for this
  // field, making it available for operator queries and `order_by`. Global
  // across declarers — all tags declaring this field must agree on both
  // `type` and `indexed`. See core/src/indexed-fields.ts for lifecycle.
  indexed?: boolean;
  // Strict-enforcement opt-in (vault#299). Default false (advisory). When
  // true, ALL declared constraints on this field (type + enum + required +
  // cardinality) flip from validation_status warnings to hard write
  // rejections — all-or-nothing per field. Stored verbatim in the `fields`
  // JSON column; the resolver (schema-defaults.ts) interprets it.
  strict?: boolean;
  // The field must be present + non-null on a note carrying this tag.
  // Advisory unless `strict:true`. vault#299.
  required?: boolean;
  // "one" (scalar, default) or "many" (array). Advisory unless `strict:true`.
  // Distinct from relationship cardinality. vault#299.
  cardinality?: "one" | "many";
}

/**
 * Cardinality vocabulary for the historical typed-relationship shape.
 * Names rather than algebra so AI clients reading `list-tags` can reason
 * about intent directly. Retained for callers that still want the typed
 * `{ target_tag, cardinality }` declaration — but `relationships` is now an
 * opaque vocabulary map (see `TagRelationshipMap` / `validateRelationships`),
 * so this is one valid value shape among many, not a required one.
 * See docs/contracts/tag-data-model.md §Relationships.
 */
export type TagRelCardinality = "one" | "optional" | "many" | "many-required";

export const TAG_REL_CARDINALITIES: readonly TagRelCardinality[] = [
  "one",
  "optional",
  "many",
  "many-required",
] as const;

/**
 * The historical typed-relationship declaration. Still a valid opaque-map
 * value — vault no longer enforces it. New apps (the Weaver / structural-link
 * picker) declare their own freeform vocabulary instead.
 */
export interface TagRelationship {
  target_tag: string;
  cardinality: TagRelCardinality;
  description?: string;
}

/**
 * `relationships` is an opaque vocabulary map: relationship-name → arbitrary
 * JSON value the declaring app interprets. Vault stores and returns the values
 * verbatim and enforces only that the top-level value is a JSON object (a map).
 */
export type TagRelationshipMap = Record<string, unknown>;

/**
 * Schema-only view of a tag — the historical shape. Backwards-compatible
 * with v13-and-earlier callers.
 */
export interface TagSchema {
  tag: string;
  description?: string;
  fields?: Record<string, TagFieldSchema>;
}

/**
 * Full tag record — schema + typed relationships + hierarchy parents.
 */
export interface TagRecord extends TagSchema {
  relationships?: TagRelationshipMap;
  parent_names?: string[];
  created_at?: string;
  updated_at?: string;
}

// DB row shape (post-v14 `tags` table).
interface TagRow {
  name: string;
  description: string | null;
  fields: string | null;
  relationships: string | null;
  parent_names: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// CRUD — full record
// ---------------------------------------------------------------------------

/** List all tag records, sorted by name. */
export function listTagRecords(db: Database): TagRecord[] {
  const rows = db.prepare(
    "SELECT name, description, fields, relationships, parent_names, created_at, updated_at FROM tags ORDER BY name",
  ).all() as TagRow[];
  return rows.map(rowToRecord);
}

/** Get a single tag record, or null if the tag doesn't exist. */
export function getTagRecord(db: Database, tag: string): TagRecord | null {
  const row = db.prepare(
    "SELECT name, description, fields, relationships, parent_names, created_at, updated_at FROM tags WHERE name = ?",
  ).get(tag) as TagRow | null;
  return row ? rowToRecord(row) : null;
}

/**
 * Upsert a tag record — partial update. Any field left `undefined` is
 * preserved. Pass `null` explicitly to clear a column. Always touches
 * `updated_at`; sets `created_at` on first insert.
 */
export function upsertTagRecord(
  db: Database,
  tag: string,
  patch: {
    description?: string | null;
    fields?: Record<string, TagFieldSchema> | null;
    relationships?: TagRelationshipMap | null;
    parent_names?: string[] | null;
  },
): TagRecord {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO tags (name, created_at, updated_at) VALUES (?, ?, ?)",
  ).run(tag, now, now);

  const existing = getTagRecord(db, tag);

  const description =
    patch.description === undefined ? (existing?.description ?? null) : patch.description;
  const fields =
    patch.fields === undefined
      ? jsonOrNull(existing?.fields)
      : jsonOrNull(patch.fields);
  const relationships =
    patch.relationships === undefined
      ? jsonOrNull(existing?.relationships)
      : jsonOrNull(patch.relationships);
  const parent_names =
    patch.parent_names === undefined
      ? jsonOrNull(existing?.parent_names)
      : jsonOrNull(patch.parent_names);

  db.prepare(
    `UPDATE tags
       SET description = ?, fields = ?, relationships = ?, parent_names = ?, updated_at = ?
     WHERE name = ?`,
  ).run(description, fields, relationships, parent_names, now, tag);

  return getTagRecord(db, tag)!;
}

// ---------------------------------------------------------------------------
// CRUD — schema-only facade (back-compat)
// ---------------------------------------------------------------------------

/** List schema-only views for tags that have a description or fields set. */
export function listTagSchemas(db: Database): TagSchema[] {
  const rows = db.prepare(
    "SELECT name, description, fields FROM tags WHERE description IS NOT NULL OR fields IS NOT NULL ORDER BY name",
  ).all() as { name: string; description: string | null; fields: string | null }[];
  return rows.map((r) => ({
    tag: r.name,
    description: r.description ?? undefined,
    fields: parseJson<Record<string, TagFieldSchema>>(r.fields),
  }));
}

/**
 * Schema-only view for a single tag. Returns null if the tag has neither
 * a description nor fields (matches v13 behavior, where the absence of a
 * `tag_schemas` row meant "no schema").
 */
export function getTagSchema(db: Database, tag: string): TagSchema | null {
  const row = db.prepare(
    "SELECT name, description, fields FROM tags WHERE name = ?",
  ).get(tag) as { name: string; description: string | null; fields: string | null } | null;
  if (!row) return null;
  if (row.description === null && row.fields === null) return null;
  return {
    tag: row.name,
    description: row.description ?? undefined,
    fields: parseJson<Record<string, TagFieldSchema>>(row.fields),
  };
}

/** Get all schemas as a lookup map (tag → schema). Used by schema effects. */
export function getTagSchemaMap(
  db: Database,
): Record<string, { description?: string; fields?: Record<string, TagFieldSchema> }> {
  const map: Record<string, { description?: string; fields?: Record<string, TagFieldSchema> }> = {};
  for (const s of listTagSchemas(db)) {
    map[s.tag] = { description: s.description, fields: s.fields };
  }
  return map;
}

/**
 * Set or replace a tag's schema (description + fields). Other columns
 * (`relationships`, `parent_names`) are left untouched. Idempotent.
 */
export function upsertTagSchema(
  db: Database,
  tag: string,
  schema: { description?: string; fields?: Record<string, TagFieldSchema> },
): TagSchema {
  upsertTagRecord(db, tag, {
    description: schema.description ?? null,
    fields: schema.fields ?? null,
  });
  return getTagSchema(db, tag) ?? { tag, description: schema.description, fields: schema.fields };
}

/**
 * Clear a tag's schema (description + fields). Returns true if anything
 * was cleared. Other columns and the tag row itself are preserved — to
 * delete the tag entirely, use `noteOps.deleteTag`.
 */
export function deleteTagSchema(db: Database, tag: string): boolean {
  const before = getTagSchema(db, tag);
  if (!before) return false;
  db.prepare(
    "UPDATE tags SET description = NULL, fields = NULL, updated_at = ? WHERE name = ?",
  ).run(new Date().toISOString(), tag);
  return true;
}

// ---------------------------------------------------------------------------
// Validation — relationships (opaque vocabulary map)
// ---------------------------------------------------------------------------

/**
 * Validate a `relationships` payload before persisting. `relationships` is
 * an **opaque vocabulary map**: a JSON object whose keys are relationship
 * names and whose values are arbitrary JSON the declaring app interprets
 * (e.g. the Weaver / structural-link picker's `{ "works-on": { from, to } }`
 * shape). Vault does not enforce any inner structure — it stores and returns
 * the values verbatim.
 *
 * Rules (the only ones):
 *   - The top-level value must be a plain JSON object (a map). A top-level
 *     array or primitive is rejected — relationships is a map, not a list.
 *   - The payload must be JSON-serializable (no circular refs / functions /
 *     bigints), since it's persisted as a JSON column.
 *
 * Returns the value verbatim (round-trips through JSON.parse(JSON.stringify)
 * to both prove serializability and strip anything non-serializable). The
 * historical typed shape `{ target_tag, cardinality }` is a valid opaque map,
 * so this is a backwards-compatible superset — existing typed declarations
 * and callers keep working unchanged.
 *
 * Phase 1 was already informational ("declarations are not enforced at write
 * time"); dropping the inner-shape gate is consistent with that intent.
 */
export function validateRelationships(raw: unknown): Record<string, unknown> {
  // `error_type` (vault#554) is attached directly on the thrown Error
  // (duck-typed extra property, same pattern as QueryError's optional
  // fields) rather than via a dedicated class — this is a validation
  // leaf with one caller-facing shape, not a reusable domain error. Both
  // REST (src/routes.ts, which already hardcodes this same string) and the
  // generic MCP domain-error mapping (src/mcp-http.ts) key off it.
  if (raw === null || raw === undefined) {
    throw relationshipsError("relationships: expected an object, got null/undefined");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw relationshipsError(
      "relationships: expected an object mapping relationship name → value (got an array or primitive)",
    );
  }
  for (const rel of Object.keys(raw as Record<string, unknown>)) {
    if (!rel) {
      throw relationshipsError("relationships: keys must be non-empty strings");
    }
  }
  // Round-trip through JSON to (a) confirm the payload is serializable —
  // the column is stored as JSON — and (b) return a clean, owned copy with
  // no non-JSON values lingering. Throws on circular refs / bigint / etc.
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch (err) {
    throw relationshipsError(`relationships: value must be JSON-serializable (${(err as Error).message})`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function relationshipsError(message: string): Error {
  return Object.assign(new Error(message), { error_type: "invalid_relationships" as const });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRecord(row: TagRow): TagRecord {
  return {
    tag: row.name,
    description: row.description ?? undefined,
    fields: parseJson<Record<string, TagFieldSchema>>(row.fields),
    relationships: parseJson<TagRelationshipMap>(row.relationships),
    parent_names: parseJson<string[]>(row.parent_names),
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  };
}

function parseJson<T>(raw: string | null): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

function jsonOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    // Already-encoded payload (e.g. when copying from an existing row).
    return value;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Cross-tag field validation (vault#553 / #554) — update-tag messaging
// ---------------------------------------------------------------------------

/**
 * A single field-declaration violation surfaced by {@link collectTagFieldViolations}.
 * `reason` is a stable machine-checkable slug; `message` is the existing
 * human-readable prose (unchanged wording, just no longer thrown on the
 * first hit).
 */
export interface TagFieldViolation {
  field: string;
  reason: "type_conflict" | "indexed_flag_conflict" | "unsupported_indexed_type" | "invalid_field_name";
  message: string;
}

/**
 * Thrown by `update-tag` (MCP tool + REST `PUT /api/tags/:name`) when one or
 * more fields in the incoming `fields` payload conflict with another tag's
 * declaration, or declare an unindexable/invalid indexed field. Carries
 * EVERY violation found in the call (vault#553 settled complaint: the prior
 * behavior threw on the FIRST offending field and silently never reported
 * the rest — two testers independently assumed the other fields had landed).
 * The message states explicitly that no changes were applied — the whole
 * `upsertTagRecord` call is validated BEFORE any write, so a rejection here
 * always leaves the tag record untouched (atomicity unchanged from before;
 * this only improves what the caller is told).
 */
export class TagFieldConflictError extends Error {
  code = "TAG_FIELD_CONFLICT" as const;
  error_type = "tag_field_conflict" as const;
  tag: string;
  violations: TagFieldViolation[];

  constructor(tag: string, violations: TagFieldViolation[]) {
    const summary = violations.map((v) => `${v.field} (${v.reason}): ${v.message}`).join("; ");
    super(
      `tag_field_conflict: ${violations.length} field violation(s) for tag "${tag}" — no changes were applied. ${summary}`,
    );
    this.name = "TagFieldConflictError";
    this.tag = tag;
    this.violations = violations;
  }
}

/**
 * Validate the fields a caller is declaring/redeclaring for `tag` against
 * every OTHER tag's schema — `type` and `indexed` must agree across all
 * declarers (both are global per field). Returns every violation found —
 * never throws — so the caller can report the complete set in one
 * structured error (or none, when the array is empty).
 *
 * `incomingFields` is the set of fields THIS call is declaring (MCP:
 * `params.fields`; REST: `body.fields`) — not the full merged field map.
 * Fields the call doesn't touch were already valid (or already accepted)
 * and are not re-validated here, matching the pre-#553 scope of the check.
 *
 * Cross-tag-only on purpose (vault#554): the SEPARATE own-field checks
 * (unsupported type for indexing, invalid identifier) are deliberately
 * NOT included here — REST's `PUT /api/tags/:name` has an established,
 * tested single-violation `IndexedFieldError` → 400 `invalid_indexed_field`
 * contract for those (vault#478) that predates this function, and folding
 * them in here would silently flip that status/error_type to 422
 * `tag_field_conflict` for a caller who never touched a second tag. Use
 * {@link collectTagFieldViolations} (all four checks, own-field included)
 * for a caller — MCP's `update-tag` tool — that has no such prior contract
 * to preserve.
 */
export function collectCrossTagFieldViolations(
  db: Database,
  tag: string,
  incomingFields: Record<string, TagFieldSchema>,
): TagFieldViolation[] {
  const violations: TagFieldViolation[] = [];
  const otherSchemas = listTagSchemas(db).filter((s) => s.tag !== tag);

  for (const [fieldName, spec] of Object.entries(incomingFields)) {
    const incomingIndexed = spec.indexed === true;
    for (const other of otherSchemas) {
      const otherSpec = other.fields?.[fieldName];
      if (!otherSpec) continue;
      if (otherSpec.type !== spec.type) {
        violations.push({
          field: fieldName,
          reason: "type_conflict",
          message: `field "${fieldName}" type conflict: tag "${tag}" declares "${spec.type}"; tag "${other.tag}" declares "${otherSpec.type}". Types must agree across all declarers.`,
        });
      }
      if ((otherSpec.indexed === true) !== incomingIndexed) {
        violations.push({
          field: fieldName,
          reason: "indexed_flag_conflict",
          message: `field "${fieldName}" indexed-flag conflict: tag "${tag}" sets indexed=${incomingIndexed}; tag "${other.tag}" sets indexed=${otherSpec.indexed === true}. Must match across all declarers — change them atomically or not at all.`,
        });
      }
    }
  }
  return violations;
}

/**
 * Full field-violation collection: {@link collectCrossTagFieldViolations}
 * PLUS the own-field checks (unsupported type for indexing, invalid
 * identifier). Used by the MCP `update-tag` tool, which — unlike REST — had
 * no prior single-violation status-code contract to preserve for those two
 * checks (its old inline loop threw an unstructured `Error` for them, same
 * as everything else pre-#554); collecting everything here is a strict
 * improvement. See {@link collectCrossTagFieldViolations}'s doc comment for
 * why REST calls that narrower function directly instead of this one.
 */
export function collectTagFieldViolations(
  db: Database,
  tag: string,
  incomingFields: Record<string, TagFieldSchema>,
): TagFieldViolation[] {
  const violations = collectCrossTagFieldViolations(db, tag, incomingFields);

  for (const [fieldName, spec] of Object.entries(incomingFields)) {
    if (spec.indexed === true) {
      const mapped = mapFieldType(spec.type);
      if (!mapped) {
        violations.push({
          field: fieldName,
          reason: "unsupported_indexed_type",
          message: `field "${fieldName}" has unsupported type "${spec.type}" for indexing (supported: string, integer, boolean)`,
        });
      } else {
        try {
          validateFieldName(fieldName);
        } catch (err) {
          violations.push({
            field: fieldName,
            reason: "invalid_field_name",
            message: (err as Error).message,
          });
        }
      }
    }
  }

  return violations;
}
