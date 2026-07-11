/**
 * Schema validation: walk the tags carried by a note (plus their ancestors via
 * `parent_names`), look up each ancestor's `fields` declaration, merge them
 * (first-in-walk wins on conflict), and validate the note's metadata against
 * the merged field map. Writes are never blocked — schemas are guidance. The
 * MCP/REST layer surfaces a `validation_status` block on create/update
 * responses with any warnings the agent can act on (type mismatch, enum
 * mismatch, schema conflict).
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
 * Inheritance (vault#270, 2026-05-09):
 * - A note's effective ancestor set = union of {tag ∪ ancestors(tag)} for each
 *   tag on the note, walking `parent_names` recursively (cycle-safe).
 * - `_default` is an implicit universal parent: if a tag named `_default`
 *   exists in the tags table, it's appended to every note's effective ancestor
 *   set (including untagged notes). The `tags.parent_names` column is never
 *   auto-mutated — the magic lives at resolve time only.
 * - Conflict resolution: first-in-walk wins. The walk visits each note tag
 *   in order, then DFS through its `parent_names` array in declaration order,
 *   so "first-in-`parent_names`-array wins" is the operator-controlled
 *   precedence. Conflicts surface as advisory `schema_conflict` warnings; no
 *   write blocking.
 * - `_default` can technically carry its own `parent_names` and the resolver
 *   handles it (cycle guard + visited Set), but the resulting interaction is
 *   non-obvious — `_default` is usually appended last, so its ancestors
 *   become low-precedence. Treat `_default` as a root tag in normal use.
 *
 * Resolution model:
 * - Lazy: rebuilt on first access, cached on the store.
 * - Invalidated when `tags.fields` or `tags.parent_names` is mutated, when a
 *   tag is deleted, renamed, or merged.
 * - When no ancestor declares fields, validation is a no-op (status omitted).
 */

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchemaField {
  /**
   * Declared type for the field's metadata value. `"integer"` is distinct
   * from `"number"` only at validation time — JSON has no separate integer
   * type, so a JSON number with zero fractional part (`5`, `5.0`,
   * `Number.isInteger(n) === true`) is accepted as integer and a non-zero
   * fractional value (`5.5`) is rejected. This matches the indexed-fields
   * `"integer"` storage type (TYPE_MAP) and removes the false-positive
   * `type_mismatch` warning that previously fired on every integer-shaped
   * field because the validator had no `"integer"` case. See vault#310.
   */
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "reference";
  enum?: string[];
  description?: string;
  /**
   * Mirrors `TagFieldSchema.indexed` (core/src/tag-schemas.ts) — this field
   * has a generated column + B-tree index maintained on `notes` (see
   * core/src/indexed-fields.ts). Parsed here (not just there) because
   * `validateNote` uses it: an indexed field is a QUERY CONTRACT, not just a
   * storage hint, so a `type_mismatch` on an indexed field is always
   * enforced (`strict: true` on that ONE warning) regardless of this field's
   * own `strict` flag (vault#553 Decision A). Every other constraint
   * (enum/required/cardinality) on an indexed field stays governed by
   * `strict` as before — only the TYPE contract is unconditional, because
   * that's the one a type-mismatched write can silently poison range
   * queries with (SQLite's TEXT-sorts-above-INTEGER affinity ordering).
   */
  indexed?: boolean;
  /**
   * Strict enforcement opt-in (vault#299, Part A). Default `false` — when
   * unset/false, ALL constraints on this field are advisory: violations
   * surface as `validation_status` warnings and the write succeeds (the
   * historical byte-identical behavior). When `true`, ALL declared
   * constraints on this field (type + enum + required + cardinality) flip
   * to hard write rejections, all-or-nothing per field (the Gitcoin team's
   * call — "enum + required together, not enum alone"). Free-form fields
   * (`notes`/`description`) on an otherwise-strict tag stay advisory by
   * simply leaving `strict` off — strictness is per-field, not per-tag.
   */
  strict?: boolean;
  /**
   * Whether the field MUST be present (and non-null) on a note carrying this
   * tag. Advisory under `strict:false` (a `required` violation surfaces as a
   * `missing_required` warning); a hard rejection only when `strict:true`.
   */
  required?: boolean;
  /**
   * Cardinality constraint for the field's value. `"one"` (the implicit
   * default) means a single scalar — an array value is a `cardinality`
   * violation. `"many"` means the value must be an array. Advisory under
   * `strict:false`; a hard rejection when `strict:true`. Distinct from the
   * relationship cardinality vocabulary (that governs typed links, not
   * metadata fields).
   */
  cardinality?: "one" | "many";
}

/**
 * Tag-record snapshot used by the resolver. Loaded from the `tags` table once
 * and cached on the store. `allTags` carries every known name (so `_default`
 * existence checks and query expansion can be answered without a re-read).
 */
export interface ResolvedSchemas {
  /** Set of all known tag names (for `_default` magic + presence checks). */
  allTags: Set<string>;
  /** Per-tag own fields (only entries with at least one declaration). */
  tagToFields: Map<string, Record<string, SchemaField>>;
  /** Per-tag `parent_names` (only entries with at least one parent declared). */
  tagToParents: Map<string, string[]>;
}

export interface ValidationWarning {
  field: string;
  /** Tag whose schema declared the violated field (or won the conflict). */
  schema: string;
  /**
   * `type_mismatch` — value's type contradicts the declared `type`.
   * `enum_mismatch` — string value not in the declared `enum`.
   * `missing_required` — a `required` field is absent or null (vault#299).
   * `cardinality_mismatch` — value's shape (scalar vs array) contradicts the
   *   declared `cardinality` (vault#299).
   * `schema_conflict` — two ancestors declared the same field with
   * different specs; first-in-walk wins, the loser surfaces here so the
   * operator can resolve the disagreement.
   */
  reason:
    | "type_mismatch"
    | "enum_mismatch"
    | "missing_required"
    | "cardinality_mismatch"
    | "schema_conflict";
  message: string;
  /**
   * `schema_conflict` only — the tag whose declaration was overridden. Set
   * when `reason === "schema_conflict"`; absent on other reasons.
   * Surfaces structurally so agents don't have to regex `message` to find
   * the loser.
   */
  loser_schema?: string;
  /**
   * `true` when this violation comes from a `strict:true` field (vault#299).
   * A strict violation is an ENFORCEMENT error — the write path rejects it.
   * Absent/false for advisory warnings (the historical guidance behavior).
   * Surfaced structurally so the write path can split "block" from "warn"
   * without re-deriving the field's strict flag.
   */
  strict?: boolean;
}

export interface ValidationStatus {
  /** Tag names whose schemas contributed at least one field to the merged map. */
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
    if (f.indexed === true) field.indexed = true;
    if (f.strict === true) field.strict = true;
    if (f.required === true) field.required = true;
    if (f.cardinality === "one" || f.cardinality === "many") field.cardinality = f.cardinality;
    fields[k] = field;
  }
  return fields;
}

function parseParentsJson(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Build a resolution map from the `tags` table. Returns a well-formed
 * `ResolvedSchemas` even when no tag declares fields (empty `tagToFields`).
 */
export function loadSchemaConfig(db: Database): ResolvedSchemas {
  const allTags = new Set<string>();
  const tagToFields = new Map<string, Record<string, SchemaField>>();
  const tagToParents = new Map<string, string[]>();
  const rows = db.prepare(
    `SELECT name, fields, parent_names FROM tags`,
  ).all() as { name: string; fields: string | null; parent_names: string | null }[];
  for (const row of rows) {
    if (!row.name) continue;
    allTags.add(row.name);
    const fields = parseFieldsJson(row.fields);
    if (Object.keys(fields).length > 0) tagToFields.set(row.name, fields);
    const parents = parseParentsJson(row.parent_names);
    if (parents.length > 0) tagToParents.set(row.name, parents);
  }
  return { allTags, tagToFields, tagToParents };
}

// ---------------------------------------------------------------------------
// Resolution + validation
// ---------------------------------------------------------------------------

/**
 * Walk-order accumulator for a single note's effective ancestor set. DFS
 * through `parent_names` in declaration order, cycle-protected via a visited
 * Set. The output array preserves first-encounter order so the field-merge
 * pass can apply first-wins precedence.
 *
 * Exported so other consumers (vault projection, future hierarchy
 * inspectors) can reuse the exact walk semantics rather than carrying
 * their own copy. Mutating walks (push to `out`, add to `visited`) keep
 * the implementation cheap; callers pass fresh accumulators.
 */
export function walkAncestors(
  startTag: string,
  resolved: ResolvedSchemas,
  visited: Set<string>,
  out: string[],
): void {
  if (visited.has(startTag)) return;
  visited.add(startTag);
  out.push(startTag);
  const parents = resolved.tagToParents.get(startTag);
  if (!parents) return;
  for (const p of parents) {
    walkAncestors(p, resolved, visited, out);
  }
}

interface MergedField {
  spec: SchemaField;
  sourceTag: string;
}

interface NoteResolution {
  /** Walk-order tag list whose `fields` contributed at least one entry. */
  effectiveTags: string[];
  /** Field name → winning spec + source tag. First-in-walk wins. */
  mergedFields: Map<string, MergedField>;
  /** Conflict warnings — same field declared by ≥2 ancestors with diverging specs. */
  conflicts: ValidationWarning[];
}

/**
 * Resolve the effective schema for a note. Walks each note tag through its
 * `parent_names` chain (cycle-safe), implicitly appends `_default` when the
 * tag exists, and merges all encountered `fields` declarations with
 * first-in-walk precedence. A note with no tags still picks up `_default`'s
 * schema when one is declared.
 *
 * Internal — exported for tests. The public entry point is `validateNote`.
 */
export function resolveNoteSchemas(
  resolved: ResolvedSchemas,
  note: { tags?: string[] },
): NoteResolution {
  const visited = new Set<string>();
  const order: string[] = [];

  for (const tag of note.tags ?? []) {
    walkAncestors(tag, resolved, visited, order);
  }
  if (resolved.allTags.has("_default")) {
    walkAncestors("_default", resolved, visited, order);
  }

  const mergedFields = new Map<string, MergedField>();
  const conflicts: ValidationWarning[] = [];

  for (const tagName of order) {
    const fields = resolved.tagToFields.get(tagName);
    if (!fields) continue;
    for (const [fieldName, spec] of Object.entries(fields)) {
      const existing = mergedFields.get(fieldName);
      if (!existing) {
        mergedFields.set(fieldName, { spec, sourceTag: tagName });
        continue;
      }
      if (fieldSpecsEqual(existing.spec, spec)) continue;
      conflicts.push({
        field: fieldName,
        schema: existing.sourceTag,
        loser_schema: tagName,
        reason: "schema_conflict",
        message: `field '${fieldName}' has conflicting specs in ancestor tags '${existing.sourceTag}' (kept) and '${tagName}' (ignored)`,
      });
    }
  }

  const contributing = new Set<string>();
  for (const { sourceTag } of mergedFields.values()) contributing.add(sourceTag);
  const effectiveTags = order.filter((t) => contributing.has(t));

  return { effectiveTags, mergedFields, conflicts };
}

function fieldSpecsEqual(a: SchemaField, b: SchemaField): boolean {
  if (a.type !== b.type) return false;
  if (!stringArraysEqual(a.enum, b.enum)) return false;
  return true;
}

function stringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Human-readable JSON-shape name for a value, used to name the "got" side of
 * a `type_mismatch` message (vault#553 — "message names field + expected
 * type + got type"). Distinct from SQLite's `json_type()` vocabulary
 * (integer/real/true/false/text/...) — this is the JSON-Schema-ish vocabulary
 * `SchemaField.type` already uses, so the message reads as "expected X, got
 * Y" in the SAME words the schema declares.
 */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "string" | "number" | "boolean" | "object" | ...
}

function valueMatchesType(value: unknown, type: SchemaField["type"], cardinality?: SchemaField["cardinality"]): boolean {
  if (type === undefined) return true;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      // JSON has no separate integer type — `5.0` and `5` decode to the
      // same JS Number. Accept any finite Number whose fractional part is
      // zero; reject `5.5`, `NaN`, `Infinity`, and non-Number types.
      // vault#310 (Gitcoin Brain drift detector emits JSON for diffs;
      // without this case, every integer-typed field warned
      // `type_mismatch` and buried the real warnings).
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    // `reference` (vault#typed-reference-field) validates like `string` —
    // the write path (core/src/store.ts) separately resolves this value to
    // a note and maintains a graph link; see tag-schemas.ts's
    // `VALID_FIELD_TYPES` doc comment for the full contract.
    //
    // `cardinality: "many"` (vault#typed-reference-field gap #2) is a
    // one-to-MANY reference field — the value is an ARRAY of reference
    // strings, one per linked note, not a single string. Validate the
    // shape a "many" reference actually takes: an array whose elements are
    // ALL non-empty-typed strings (per-item type check — the ARRAY shape
    // itself is separately covered by the `cardinality_mismatch` check
    // below in `validateNote`, so this only needs to judge element types).
    // Without this branch, EVERY valid `cardinality:"many"` reference write
    // fired a self-contradictory `type_mismatch` ("should be reference, got
    // array") — an array is exactly what "many" asks for; only a
    // non-string ELEMENT should ever fail this check.
    case "reference":
      if (cardinality === "many") {
        return Array.isArray(value) && value.every((item) => typeof item === "string");
      }
      return typeof value === "string";
  }
}

/**
 * Validate a note's metadata against the merged schema. Returns null when no
 * ancestor declares any fields (so the caller can omit `validation_status`
 * entirely). Otherwise returns the status with conflict warnings prepended,
 * followed by per-field violations.
 *
 * Rules per merged field:
 * - `required` declared and value absent/null → `missing_required`
 * - Present and `type` declared and value's type doesn't match → `type_mismatch`
 * - Present and `enum` declared and value not in enum → `enum_mismatch`
 * - Present and `cardinality` declared and shape (scalar vs array) wrong
 *   → `cardinality_mismatch`
 *
 * Every violation carries `strict: true` iff its field declared `strict:true`
 * (vault#299) — EXCEPT a `type_mismatch` on an `indexed: true` field, which is
 * ALWAYS `strict: true` regardless of the field's own `strict` setting
 * (vault#553 Decision A — an indexed field's type is a query contract, not
 * just guidance). The list itself is the SAME whether or not a field is
 * strict — the difference is only the per-warning `strict` flag, which the
 * write path uses to decide block-vs-warn. Under `strict:false` (and
 * `indexed:false`) this is byte-identical to the historical advisory
 * behavior PLUS the new `required`/`cardinality` advisory reasons (which
 * fire for any field declaring those, strict or not).
 *
 * Fields not declared by any ancestor's schema are ignored entirely.
 */
export function validateNote(
  resolved: ResolvedSchemas,
  note: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> },
): ValidationStatus | null {
  const resolution = resolveNoteSchemas(resolved, note);
  if (resolution.mergedFields.size === 0) return null;

  const m = note.metadata ?? {};
  const warnings: ValidationWarning[] = [...resolution.conflicts];

  for (const [fieldName, { spec, sourceTag }] of resolution.mergedFields) {
    const strictFlag = spec.strict === true ? { strict: true } : {};
    const present = fieldName in m;
    const value = present ? m[fieldName] : undefined;
    const absent = !present || value === undefined || value === null;

    if (spec.required === true && absent) {
      warnings.push({
        field: fieldName,
        schema: sourceTag,
        reason: "missing_required",
        message: `'${fieldName}' is required (tag '${sourceTag}')`,
        ...strictFlag,
      });
      // A required field that's absent has no value to type/enum/cardinality
      // check — the missing_required violation stands alone.
      continue;
    }

    if (absent) continue;

    if (spec.type && !valueMatchesType(value, spec.type, spec.cardinality)) {
      // Decision A (vault#553): an INDEXED field's type is a query
      // contract — a type-mismatched write poisons range-query ordering
      // (SQLite's TEXT-sorts-above-INTEGER affinity) regardless of whether
      // this field opted into `strict`. Force `strict: true` on THIS
      // warning alone when the field is indexed; every other constraint
      // (enum/required/cardinality) stays governed by `spec.strict` as
      // before.
      const indexedTypeStrict = spec.indexed === true;
      warnings.push({
        field: fieldName,
        schema: sourceTag,
        reason: "type_mismatch",
        message: `'${fieldName}' should be ${spec.type} (tag '${sourceTag}'), got ${jsonTypeOf(value)}${indexedTypeStrict ? " — indexed fields reject type-mismatched writes (vault#553)" : ""}`,
        ...(strictFlag.strict || indexedTypeStrict ? { strict: true } : {}),
      });
    }

    if (spec.enum && spec.enum.length > 0 && typeof value === "string" && !spec.enum.includes(value)) {
      warnings.push({
        field: fieldName,
        schema: sourceTag,
        reason: "enum_mismatch",
        message: `'${fieldName}' must be one of [${spec.enum.join(", ")}] (tag '${sourceTag}')`,
        ...strictFlag,
      });
    }

    if (spec.cardinality) {
      const isArray = Array.isArray(value);
      const wantMany = spec.cardinality === "many";
      if (wantMany !== isArray) {
        warnings.push({
          field: fieldName,
          schema: sourceTag,
          reason: "cardinality_mismatch",
          message: wantMany
            ? `'${fieldName}' must be an array (cardinality 'many', tag '${sourceTag}')`
            : `'${fieldName}' must be a single value, not an array (cardinality 'one', tag '${sourceTag}')`,
          ...strictFlag,
        });
      }
    }
  }

  return { schemas: resolution.effectiveTags, warnings };
}

// ---------------------------------------------------------------------------
// Strict enforcement (vault#299)
// ---------------------------------------------------------------------------

/**
 * Thrown by the write path when a note violates one or more `strict:true`
 * field constraints. Carries ALL per-field violations in a single error (the
 * settled design lead — one `SchemaValidationError`, not per-axis errors), so
 * an agent sees the whole contract it broke in one response and can fix every
 * field before retrying.
 *
 * Each entry is a `ValidationWarning` with `strict: true`. `code` is stable
 * (`SCHEMA_VALIDATION`) for transport mapping (MCP error / HTTP 422).
 */
export class SchemaValidationError extends Error {
  code = "SCHEMA_VALIDATION" as const;
  violations: ValidationWarning[];

  constructor(violations: ValidationWarning[]) {
    const summary = violations
      .map((v) => `${v.field}: ${v.reason}`)
      .join("; ");
    super(`schema_validation: ${violations.length} strict field violation(s) — ${summary}`);
    this.name = "SchemaValidationError";
    this.violations = violations;
  }
}

/**
 * Extract the enforcement-level (strict) subset of a validation status —
 * the violations the write path must reject. Conflict warnings are advisory
 * by nature (they describe operator schema disagreements, not note data) and
 * are never enforced even when a field is strict. Returns `[]` when nothing
 * strict was violated (the common case — the caller then proceeds with the
 * write).
 */
export function strictViolations(status: ValidationStatus | null): ValidationWarning[] {
  if (!status) return [];
  return status.warnings.filter((w) => w.strict === true && w.reason !== "schema_conflict");
}

/**
 * Validate-and-enforce: run `validateNote`, and if any `strict:true` field is
 * violated, throw a single `SchemaValidationError` carrying every violation.
 * Returns the full advisory `ValidationStatus` (or null) on success so the
 * caller can still surface advisory warnings on the response. `bypass: true`
 * skips the throw entirely (migration-bypass scope) — the caller is
 * responsible for logging the bypass.
 *
 * The write path calls this BEFORE persisting so a rejection leaves the note
 * untouched.
 */
export function enforceStrictSchema(
  resolved: ResolvedSchemas,
  note: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> },
  opts?: { bypass?: boolean },
): { status: ValidationStatus | null; violations: ValidationWarning[] } {
  const status = validateNote(resolved, note);
  const violations = strictViolations(status);
  if (violations.length > 0 && opts?.bypass !== true) {
    throw new SchemaValidationError(violations);
  }
  return { status, violations };
}
