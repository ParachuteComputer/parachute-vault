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
import { loadTagHierarchy, findParentCycle } from "./tag-hierarchy.js";
import { timestampToMs } from "./cursor.js";

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
  /**
   * Explicit backfill value (vault#553 Decision B). When a note gains this
   * tag and doesn't set the field, `applySchemaDefaults` (core/src/mcp.ts)
   * writes THIS value onto the note. Undeclared (the default) means the
   * field stays ABSENT on notes that don't set it — no more implicit
   * first-enum-value / type-zero-value backfill. This is what makes
   * `exists:false` trustworthy: "never set" and "explicitly set to the
   * default" are now distinguishable states.
   *
   * Must conform to this field's own `type` (and `enum`, when declared) —
   * `upsertTagRecord` (core/src/store.ts, the single chokepoint both REST
   * and MCP funnel through) validates the default BEFORE persisting via
   * {@link validateFieldDefault}; a non-conforming default is a tag-schema
   * error (`invalid_field_default` / `TagFieldViolation` reason
   * `"invalid_default"`), not a silent typo. `undefined` is JSON-serialized
   * away by `JSON.stringify` — an omitted `default` key round-trips as "not
   * declared", never as a stored `null`.
   */
  default?: unknown;
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
 * Thrown by `upsertTagRecord` (and therefore by both `PUT /api/tags/:name`
 * and the MCP `update-tag` tool — this is the single chokepoint both share,
 * see `core/src/store.ts:upsertTagRecord`) when the incoming `parent_names`
 * would create a cycle in the hierarchy (vault#552). Traversal elsewhere
 * (`getTagDescendants`) is already cycle-safe — a visited-set stops it from
 * looping forever — but the WRITE itself was dishonest about creating one:
 * an adversarial or accidental `A→B` then `B→A` (or a bare self-parent)
 * silently succeeded pre-#552. `cycle` is the offending path, e.g.
 * `["A", "B", "A"]` for a direct A↔B cycle, or the longer chain for a
 * transitive one; the SERVER layer scope-scrubs out-of-scope names in it
 * for a tag-scoped caller (`scrubParentCycleError` in src/tag-scope.ts),
 * same posture as `TagFieldConflictError`.
 */
/**
 * Thrown by `upsertTagRecord` (core/src/store.ts's chokepoint — REST
 * `PUT /api/tags/:name` and MCP `update-tag` both funnel through it) when a
 * field's declared `default` (vault#553 Decision B) doesn't conform to that
 * SAME field's own `type` (or `enum`, when declared). A bad default is a
 * tag-schema authoring error, not silently-accepted junk that would poison
 * every note gaining the tag — fail closed, same posture as
 * `IndexedFieldError` and `ParentCycleError`. `error_type` is stamped
 * directly (own-field validation leaf, one caller-facing shape) so the
 * generic MCP domain-error mapping (`src/mcp-http.ts`) and REST's dedicated
 * catch branch both surface it without a bespoke class-specific mapping.
 */
export class InvalidFieldDefaultError extends Error {
  code = "INVALID_FIELD_DEFAULT" as const;
  error_type = "invalid_field_default" as const;
  field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "InvalidFieldDefaultError";
    this.field = field;
  }
}

/**
 * Thrown by `upsertTagRecord` (core/src/store.ts's chokepoint) when a
 * field's declared `type` isn't one of the recognized values (vault#555
 * — `update-tag{fields:{weird:{type:"frobnicator"}}}` used to be accepted
 * and persisted verbatim, no error, for any NON-indexed field: the only
 * existing type check, `mapFieldType`, ran solely on `indexed: true` fields
 * — see {@link validateFieldType}'s doc comment). Own-field validation leaf,
 * same posture as `InvalidFieldDefaultError`.
 */
export class InvalidFieldTypeError extends Error {
  code = "INVALID_FIELD_TYPE" as const;
  error_type = "invalid_field_type" as const;
  field: string;
  type: string;
  valid_types: readonly string[];

  constructor(field: string, type: string) {
    super(
      `field "${field}" declares unknown type "${type}" — must be one of [${VALID_FIELD_TYPES.join(", ")}]`,
    );
    this.name = "InvalidFieldTypeError";
    this.field = field;
    this.type = type;
    this.valid_types = VALID_FIELD_TYPES;
  }
}

/**
 * Validate that a field's declared `default` (vault#553 Decision B) conforms
 * to its own `type` and (when declared) `enum`. Returns `null` when the
 * field has no `default` (the common case) or the default is valid;
 * otherwise a {@link TagFieldViolation} with `reason: "invalid_default"`.
 * Pure — never throws; the two callers (the store chokepoint's fail-fast
 * pre-validate, and {@link collectTagFieldViolations}'s bundled MCP report)
 * each decide how to surface it.
 *
 * Deliberately independent of `schema-defaults.ts`'s `valueMatchesType` (this
 * module doesn't import that one, and vice versa — no cycle either way) so
 * the two modules' type vocabularies can drift without cross-coupling; the
 * rules are kept in lockstep by hand (string/number/integer/boolean/array/
 * object, the SAME six as `TagFieldSchema.type`'s documented vocabulary).
 */
export function validateFieldDefault(field: string, spec: TagFieldSchema): TagFieldViolation | null {
  if (spec.default === undefined) return null;
  const value = spec.default;
  const typeOk = defaultMatchesType(value, spec.type);
  if (!typeOk) {
    return {
      field,
      reason: "invalid_default",
      message: `field "${field}" declares default ${JSON.stringify(value)}, which does not match its own type "${spec.type}"`,
    };
  }
  if (spec.enum && spec.enum.length > 0 && typeof value === "string" && !spec.enum.includes(value)) {
    return {
      field,
      reason: "invalid_default",
      message: `field "${field}" declares default "${value}", which is not one of its own enum values [${spec.enum.join(", ")}]`,
    };
  }
  return null;
}

/**
 * The full recognized vocabulary for `TagFieldSchema.type` — storage/
 * advisory validation accepts all eight; only `string`/`integer`/`boolean`/
 * `reference`/`date` are INDEXABLE (that narrower subset is
 * `indexed-fields.ts`'s `TYPE_MAP`, enforced separately via `mapFieldType`
 * for `indexed: true` fields). Matches `defaultMatchesType`'s switch and
 * `schema-defaults.ts`'s `SchemaField.type` union — kept in lockstep by hand
 * across the two deliberately-decoupled modules (see `validateFieldDefault`'s
 * doc comment for why they don't cross-import).
 *
 * `reference` (vault#typed-reference-field) is a dual-write field type: the
 * value is stored + validated exactly like `string` (an id/path/title the
 * caller passes), AND the write path (`core/src/store.ts` — see
 * `BunSqliteStore.syncReferenceFieldLinks`) additionally resolves that value
 * to a note and maintains a graph `links` edge from this note to the
 * resolved target, with `relationship` set to the field name. See
 * `docs/design/typed-reference-field.md` for the full design + known gaps.
 *
 * `date` stores/validates like `string` (an ISO-8601 date or timestamp) so
 * indexed `date` fields sort correctly under a plain TEXT comparison — see
 * `defaultMatchesType`'s `"date"` case and `schema-defaults.ts`'s
 * `valueMatchesType`, both of which reuse `cursor.ts`'s `timestampToMs`
 * (the SAME UTC-correct parser `date_filter`'s `updated_at` bound uses) so
 * there's exactly one ISO-parsing implementation in the codebase, not two.
 */
export const VALID_FIELD_TYPES = ["string", "number", "integer", "boolean", "array", "object", "reference", "date"] as const;

/**
 * Validate that a field's declared `type` is one of the recognized
 * values (vault#555). Returns `null` when `type` is unset (own-field checks
 * elsewhere already treat an unset type as "nothing to check against") or
 * recognized; otherwise a {@link TagFieldViolation} with `reason:
 * "invalid_type"`.
 *
 * Before this, a non-indexed field's `type` was NEVER validated anywhere —
 * `mapFieldType` (the only existing type check) runs solely on fields
 * declaring `indexed: true`. `update-tag{fields:{weird:{type:"frobnicator"}}}`
 * on a plain (non-indexed) field silently persisted the bogus type
 * verbatim; every later read of that field just skipped validation
 * entirely (`valueMatchesType` in schema-defaults.ts has no vocabulary
 * entry for it either). This is now the SINGLE gate — indexed fields still
 * get their own, narrower `unsupported_indexed_type` check (which also
 * covers a RECOGNIZED-but-unindexable type like `"array"`, a different
 * case from a genuinely unknown token).
 *
 * Pure — never throws; callers ({@link collectTagFieldViolations}'s bundled
 * MCP/REST report, and the store chokepoint's defense-in-depth pre-validate)
 * each decide how to surface it.
 */
export function validateFieldType(field: string, spec: TagFieldSchema): TagFieldViolation | null {
  if (!spec.type) return null;
  if ((VALID_FIELD_TYPES as readonly string[]).includes(spec.type)) return null;
  return {
    field,
    reason: "invalid_type",
    message: `field "${field}" declares unknown type "${spec.type}" — must be one of [${VALID_FIELD_TYPES.join(", ")}]`,
  };
}

/**
 * Combined own-field `default` + `type` violation collection — no cross-tag
 * lookups needed, so no `db` parameter (unlike
 * {@link collectCrossTagFieldViolations}). Used by REST's `PUT
 * /api/tags/:name` (vault#555 fix — folds these into the SAME bundled
 * `tag_field_conflict` 422 report as the cross-tag checks, replacing the
 * old fail-fast single-violation `invalid_field_default` 400) and reused by
 * {@link collectTagFieldViolations} (MCP) so the two surfaces can't drift on
 * what counts as an own-field violation.
 */
export function collectOwnFieldDefaultAndTypeViolations(
  incomingFields: Record<string, TagFieldSchema>,
): TagFieldViolation[] {
  const violations: TagFieldViolation[] = [];
  for (const [fieldName, spec] of Object.entries(incomingFields)) {
    const typeViolation = validateFieldType(fieldName, spec);
    if (typeViolation) violations.push(typeViolation);
    const defaultViolation = validateFieldDefault(fieldName, spec);
    if (defaultViolation) violations.push(defaultViolation);
  }
  return violations;
}

/** Same eight-type vocabulary as `TagFieldSchema.type`'s doc comment. Unknown/unset types pass (nothing to check against). */
function defaultMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    // `reference` stores/validates like `string` — the value is the
    // id/path/title the write path resolves to a target note. See
    // VALID_FIELD_TYPES's doc comment.
    case "reference":
      return typeof value === "string";
    // `date` accepts an ISO-8601 date (`YYYY-MM-DD`) or full RFC3339
    // timestamp — the SAME grammar `date_filter`'s `updated_at` bound
    // parses (`timestampToMs`, imported from cursor.ts), not a second,
    // independently-drifting date parser. See VALID_FIELD_TYPES's doc
    // comment.
    case "date":
      return typeof value === "string" && timestampToMs(value) !== null;
    default:
      return true;
  }
}

export class ParentCycleError extends Error {
  code = "PARENT_CYCLE" as const;
  error_type = "parent_cycle" as const;
  tag: string;
  cycle: string[];

  constructor(tag: string, cycle: string[]) {
    super(
      `parent_cycle: setting "${tag}"'s parent_names would create a cycle: ${cycle.join(" → ")}`,
    );
    this.name = "ParentCycleError";
    this.tag = tag;
    this.cycle = cycle;
  }
}

/**
 * Upsert a tag record — partial update. Any field left `undefined` is
 * preserved. Pass `null` explicitly to clear a column. Always touches
 * `updated_at`; sets `created_at` on first insert.
 *
 * Cycle guard (vault#552): when `patch.parent_names` is a non-empty array,
 * validate it against the CURRENT hierarchy (loaded fresh — this function is
 * the shared chokepoint for both REST and MCP, so it can't rely on a
 * possibly-stale caller cache) before touching any row. A conflicting parent
 * throws {@link ParentCycleError} and nothing is persisted — same
 * fail-closed-before-any-write posture as the cross-tag field-conflict
 * checks in this module.
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
  if (patch.parent_names != null && patch.parent_names.length > 0) {
    const hierarchy = loadTagHierarchy(db);
    const cycle = findParentCycle(hierarchy, tag, patch.parent_names);
    if (cycle) throw new ParentCycleError(tag, cycle);
  }

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
  reason:
    | "type_conflict"
    | "indexed_flag_conflict"
    | "unsupported_indexed_type"
    | "invalid_field_name"
    | "invalid_default"
    | "invalid_type";
  message: string;
  /**
   * The conflicting declarer tag — present on the cross-tag reasons
   * (`type_conflict` / `indexed_flag_conflict`) only; the solo own-field
   * reasons have no other party. Core populates it unconditionally
   * (scope-unaware by architecture); the SERVER layers scrub it — and
   * generalize `message` — when the declarer is outside a tag-scoped
   * caller's allowlist (`scrubTagFieldViolationsByScope` in
   * src/tag-scope.ts), so a scoped session learns THAT a conflict exists
   * (the write is still rejected — integrity is scope-independent) but not
   * WHICH out-of-scope tag it conflicts with or what that tag declares.
   */
  other_tag?: string;
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
 * Two deliberate exclusions preserve pre-existing wire contracts
 * (vault#554 — statuses/error_types on previously-working calls must not
 * change):
 *
 * 1. The SEPARATE own-field checks (unsupported type for indexing,
 *    invalid identifier) are NOT included — REST's `PUT /api/tags/:name`
 *    has an established, tested single-violation `IndexedFieldError` →
 *    400 `invalid_indexed_field` contract for those (vault#478). Use
 *    {@link collectTagFieldViolations} (own-field checks included) for a
 *    caller — MCP's `update-tag` tool — with no such prior contract.
 * 2. The type-conflict check is SKIPPED for any field whose INCOMING spec
 *    is `indexed: true` (wire review, vault#554): a both-indexed cross-tag
 *    type conflict already errors on main via `store.upsertTagRecord` →
 *    `declareField`'s cross-declarer sqlite-type check (`IndexedFieldError`
 *    → 400 `invalid_indexed_field`), and reporting it here would flip that
 *    established 400 to a 422. Letting it fall through preserves the 400.
 *    No case is silently re-accepted by the skip: an incoming-indexed type
 *    conflict against an INDEXED declarer hits declareField's 400; against
 *    a NON-indexed declarer the indexed-FLAG conflict below still fires
 *    (the flags necessarily differ). What this function newly reports —
 *    both silent 200s on main — is (a) type conflicts on NON-indexed
 *    incoming fields and (b) indexed-flag conflicts.
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
      // See doc comment exclusion 2: incoming-indexed type conflicts keep
      // their pre-existing declareField → 400 invalid_indexed_field path.
      if (!incomingIndexed && otherSpec.type !== spec.type) {
        violations.push({
          field: fieldName,
          reason: "type_conflict",
          message: `field "${fieldName}" type conflict: tag "${tag}" declares "${spec.type}"; tag "${other.tag}" declares "${otherSpec.type}". Types must agree across all declarers.`,
          other_tag: other.tag,
        });
      }
      if ((otherSpec.indexed === true) !== incomingIndexed) {
        violations.push({
          field: fieldName,
          reason: "indexed_flag_conflict",
          message: `field "${fieldName}" indexed-flag conflict: tag "${tag}" sets indexed=${incomingIndexed}; tag "${other.tag}" sets indexed=${otherSpec.indexed === true}. Must match across all declarers — change them atomically or not at all.`,
          other_tag: other.tag,
        });
      }
    }
  }
  return violations;
}

/**
 * Full field-violation collection: {@link collectCrossTagFieldViolations}
 * PLUS EVERY own-field check — {@link collectOwnFieldDefaultAndTypeViolations}
 * (a non-conforming `default`, vault#553 Decision B; an unrecognized `type`,
 * vault#555) AND the indexed-only checks (unsupported type for indexing,
 * invalid identifier). Used by the MCP `update-tag` tool, which — unlike
 * REST's indexed-type/name path — had no prior single-violation
 * status-code contract to preserve for those two (its old inline loop threw
 * an unstructured `Error` for them, same as everything else pre-#554);
 * collecting everything here is a strict improvement. See
 * {@link collectCrossTagFieldViolations}'s doc comment for why REST calls
 * that narrower function directly for the CROSS-tag checks, then ALSO calls
 * {@link collectOwnFieldDefaultAndTypeViolations} itself (vault#555 fix 5 —
 * REST used to get `invalid_default` coverage only via
 * `store.upsertTagRecord`'s fail-fast pre-validate, a single-violation
 * `InvalidFieldDefaultError` → 400 that silently dropped every OTHER bad
 * field in the same call; both surfaces now report every own-field default/
 * type violation together, bundled with the cross-tag ones) — the
 * indexed-type/name pair stays REST's own single-violation `400
 * invalid_indexed_field` path (unchanged wire contract, vault#478).
 */
export function collectTagFieldViolations(
  db: Database,
  tag: string,
  incomingFields: Record<string, TagFieldSchema>,
): TagFieldViolation[] {
  const violations = collectCrossTagFieldViolations(db, tag, incomingFields);
  violations.push(...collectOwnFieldDefaultAndTypeViolations(incomingFields));

  for (const [fieldName, spec] of Object.entries(incomingFields)) {
    if (spec.indexed === true) {
      const mapped = mapFieldType(spec.type);
      if (!mapped) {
        violations.push({
          field: fieldName,
          reason: "unsupported_indexed_type",
          message: `field "${fieldName}" has unsupported type "${spec.type}" for indexing (supported: string, integer, boolean, reference, date)`,
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
