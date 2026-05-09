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
  type?: "string" | "number" | "boolean" | "array" | "object";
  enum?: string[];
  description?: string;
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
   * `schema_conflict` — two ancestors declared the same field with
   * different specs; first-in-walk wins, the loser surfaces here so the
   * operator can resolve the disagreement.
   */
  reason: "type_mismatch" | "enum_mismatch" | "schema_conflict";
  message: string;
  /**
   * `schema_conflict` only — the tag whose declaration was overridden. Set
   * when `reason === "schema_conflict"`; absent on type/enum mismatches.
   * Surfaces structurally so agents don't have to regex `message` to find
   * the loser.
   */
  loser_schema?: string;
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
 * Validate a note's metadata against the merged schema. Returns null when no
 * ancestor declares any fields (so the caller can omit `validation_status`
 * entirely). Otherwise returns the status with conflict warnings prepended,
 * followed by per-field type/enum mismatches.
 *
 * Rules per merged field:
 * - Present and `type` declared and value's type doesn't match → `type_mismatch`
 * - Present and `enum` declared and value not in enum → `enum_mismatch`
 *
 * Fields not declared by any ancestor's schema are ignored entirely (this
 * isn't a "strict" validator — it's a guide). There is no `required` concept
 * (post-v17); declarations are advisory only.
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
    if (!(fieldName in m)) continue;
    const value = m[fieldName];
    if (value === undefined || value === null) continue;

    if (spec.type && !valueMatchesType(value, spec.type)) {
      warnings.push({
        field: fieldName,
        schema: sourceTag,
        reason: "type_mismatch",
        message: `'${fieldName}' should be ${spec.type} (tag '${sourceTag}')`,
      });
    }

    if (spec.enum && spec.enum.length > 0 && typeof value === "string" && !spec.enum.includes(value)) {
      warnings.push({
        field: fieldName,
        schema: sourceTag,
        reason: "enum_mismatch",
        message: `'${fieldName}' must be one of [${spec.enum.join(", ")}] (tag '${sourceTag}')`,
      });
    }
  }

  return { schemas: resolution.effectiveTags, warnings };
}
