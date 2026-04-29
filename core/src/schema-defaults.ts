/**
 * Default schemas resolved from `_schemas/*` and `_schema_defaults` config notes.
 *
 * A note at path `_schemas/<name>` declares a schema in its metadata:
 *
 *     ---
 *     description: "Task notes"
 *     fields:
 *       priority: { type: string, enum: [high, medium, low] }
 *       due_date: { type: string }
 *     required: [priority]
 *     ---
 *
 * A single note at path `_schema_defaults` maps notes to schemas by path prefix
 * or tag:
 *
 *     ---
 *     path_prefixes:
 *       "tasks/": "task"
 *       "journal/": "journal-entry"
 *     tags:
 *       "meeting": "meeting-notes"
 *     ---
 *
 * On create / update, the store resolves applicable schemas for a note (by
 * matching its path against `path_prefixes` and its tags against `tags`),
 * validates the note's metadata, and surfaces a `validation_status` block on
 * the response. Validation is **never** blocking — schemas are guidance, not
 * gates. Writes always succeed; the response carries warnings the agent can
 * act on (e.g. fill in a missing field on the next turn).
 *
 * Why notes-as-config rather than a SQL table:
 * - Same rationale as `_tags/*`: vault is note-first; the schema travels with
 *   the content; users edit it with the same tools as any note.
 * - Orthogonal to the existing `tag_schemas` table — that one drives indexed
 *   columns and per-tag UI hints. This layer is purely a validation guide
 *   addressed by path or tag rather than tag alone.
 *
 * Resolution model:
 * - Lazy: rebuilt on first access, cached on the store.
 * - Synchronously invalidated when any note at `_schemas/*` or
 *   `_schema_defaults` is created, updated, or deleted.
 * - When no `_schema_defaults` mapping note exists and no `_schemas/*`
 *   declarations match, validation is a no-op (status omitted).
 */

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Path prefixes
// ---------------------------------------------------------------------------

export const SCHEMA_CONFIG_PREFIX = "_schemas/";
export const SCHEMA_DEFAULTS_PATH = "_schema_defaults";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchemaField {
  type?: "string" | "number" | "boolean" | "array" | "object";
  enum?: string[];
  description?: string;
}

export interface SchemaDefinition {
  name: string;
  description?: string;
  fields: Record<string, SchemaField>;
  required: string[];
}

export interface SchemaDefaults {
  /** Path prefix → schema name. Longest prefix wins on tie. */
  pathPrefixes: Array<{ prefix: string; schema: string }>;
  /** Tag → schema name. */
  tagToSchema: Map<string, string>;
}

export interface ResolvedSchemas {
  defaults: SchemaDefaults;
  definitions: Map<string, SchemaDefinition>;
}

export interface ValidationWarning {
  field: string;
  schema: string;
  /** "missing_required" | "type_mismatch" | "enum_mismatch" */
  reason: "missing_required" | "type_mismatch" | "enum_mismatch";
  message: string;
}

export interface ValidationStatus {
  /** Schema names that matched the note (for transparency). */
  schemas: string[];
  /** Empty when all checks pass. */
  warnings: ValidationWarning[];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function parseMetadata(raw: string | null): unknown {
  if (!raw || raw === "{}") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readSchemaDefinition(name: string, metadata: unknown): SchemaDefinition | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;

  const fieldsRaw = m.fields;
  const fields: Record<string, SchemaField> = {};
  if (fieldsRaw && typeof fieldsRaw === "object" && !Array.isArray(fieldsRaw)) {
    for (const [k, v] of Object.entries(fieldsRaw as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const f = v as Record<string, unknown>;
      const field: SchemaField = {};
      if (typeof f.type === "string") field.type = f.type as SchemaField["type"];
      if (Array.isArray(f.enum)) field.enum = f.enum.filter((x): x is string => typeof x === "string");
      if (typeof f.description === "string") field.description = f.description;
      fields[k] = field;
    }
  }

  const required: string[] = Array.isArray(m.required)
    ? m.required.filter((x): x is string => typeof x === "string")
    : [];

  const description = typeof m.description === "string" ? m.description : undefined;

  return { name, description, fields, required };
}

function readDefaultsMapping(metadata: unknown): SchemaDefaults {
  const result: SchemaDefaults = {
    pathPrefixes: [],
    tagToSchema: new Map(),
  };
  if (!metadata || typeof metadata !== "object") return result;
  const m = metadata as Record<string, unknown>;

  const pathPrefixes = m.path_prefixes;
  if (pathPrefixes && typeof pathPrefixes === "object" && !Array.isArray(pathPrefixes)) {
    for (const [prefix, schema] of Object.entries(pathPrefixes as Record<string, unknown>)) {
      if (typeof schema === "string" && schema.length > 0) {
        result.pathPrefixes.push({ prefix, schema });
      }
    }
    // Longest prefix wins — sort once at load so resolve is O(n) without re-sorts.
    result.pathPrefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  const tags = m.tags;
  if (tags && typeof tags === "object" && !Array.isArray(tags)) {
    for (const [tag, schema] of Object.entries(tags as Record<string, unknown>)) {
      if (typeof schema === "string" && schema.length > 0) {
        result.tagToSchema.set(tag, schema);
      }
    }
  }

  return result;
}

/**
 * Scan `_schemas/*` notes and (optionally) `_schema_defaults` to build the
 * full resolution map. Always returns a well-formed `ResolvedSchemas` even
 * when no config notes exist (empty maps).
 */
export function loadSchemaConfig(db: Database): ResolvedSchemas {
  const definitions = new Map<string, SchemaDefinition>();
  const defRows = db.prepare(
    `SELECT path, metadata FROM notes WHERE path LIKE '_schemas/%'`,
  ).all() as { path: string; metadata: string | null }[];
  for (const row of defRows) {
    const name = row.path.slice(SCHEMA_CONFIG_PREFIX.length);
    if (!name) continue;
    const def = readSchemaDefinition(name, parseMetadata(row.metadata));
    if (def) definitions.set(name, def);
  }

  let defaults: SchemaDefaults = { pathPrefixes: [], tagToSchema: new Map() };
  const mappingRow = db.prepare(
    `SELECT metadata FROM notes WHERE path = ?`,
  ).get(SCHEMA_DEFAULTS_PATH) as { metadata: string | null } | undefined;
  if (mappingRow) {
    defaults = readDefaultsMapping(parseMetadata(mappingRow.metadata));
  }

  return { defaults, definitions };
}

// ---------------------------------------------------------------------------
// Resolution + validation
// ---------------------------------------------------------------------------

/**
 * Find the schemas that apply to a note based on its path and tags. Returns
 * schema *names* in the order they were resolved (path-prefix first, then
 * each matching tag in declaration order). Names that don't have a backing
 * `_schemas/<name>` definition are dropped.
 */
export function resolveApplicableSchemas(
  resolved: ResolvedSchemas,
  note: { path?: string | null; tags?: string[] },
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  if (note.path) {
    for (const { prefix, schema } of resolved.defaults.pathPrefixes) {
      if (note.path.startsWith(prefix)) {
        if (!seen.has(schema) && resolved.definitions.has(schema)) {
          names.push(schema);
          seen.add(schema);
        }
        break; // longest match wins (sorted at load)
      }
    }
  }

  if (note.tags) {
    for (const tag of note.tags) {
      const schema = resolved.defaults.tagToSchema.get(tag);
      if (schema && !seen.has(schema) && resolved.definitions.has(schema)) {
        names.push(schema);
        seen.add(schema);
      }
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
 * Validate a note's metadata against each applicable schema and collect
 * warnings. Validation is non-blocking — the caller decides what to do with
 * the warnings (currently: surface them on the create/update response).
 *
 * Rules per field:
 * - In `required` and absent → `missing_required`
 * - Present and `type` declared and value's type doesn't match → `type_mismatch`
 * - Present and `enum` declared and value not in enum → `enum_mismatch`
 *
 * Fields not declared in the schema are ignored entirely (this isn't a
 * "strict" validator — it's a guide).
 */
export function validateMetadata(
  resolved: ResolvedSchemas,
  schemaNames: string[],
  metadata: Record<string, unknown> | undefined,
): ValidationStatus {
  const warnings: ValidationWarning[] = [];
  const m = metadata ?? {};

  for (const name of schemaNames) {
    const def = resolved.definitions.get(name);
    if (!def) continue;

    for (const requiredField of def.required) {
      if (!(requiredField in m) || m[requiredField] === undefined || m[requiredField] === null) {
        warnings.push({
          field: requiredField,
          schema: name,
          reason: "missing_required",
          message: `'${requiredField}' is required by schema '${name}'`,
        });
      }
    }

    for (const [fieldName, field] of Object.entries(def.fields)) {
      if (!(fieldName in m)) continue;
      const value = m[fieldName];
      if (value === undefined || value === null) continue;

      if (field.type && !valueMatchesType(value, field.type)) {
        warnings.push({
          field: fieldName,
          schema: name,
          reason: "type_mismatch",
          message: `'${fieldName}' should be ${field.type} (schema '${name}')`,
        });
      }

      if (field.enum && field.enum.length > 0 && typeof value === "string" && !field.enum.includes(value)) {
        warnings.push({
          field: fieldName,
          schema: name,
          reason: "enum_mismatch",
          message: `'${fieldName}' must be one of [${field.enum.join(", ")}] (schema '${name}')`,
        });
      }
    }
  }

  return { schemas: schemaNames, warnings };
}

/**
 * Convenience: combine resolve + validate for a note. Returns null when no
 * schemas apply (so the caller can decide whether to omit the field on the
 * response or surface an empty status).
 */
export function validateNote(
  resolved: ResolvedSchemas,
  note: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> },
): ValidationStatus | null {
  const names = resolveApplicableSchemas(resolved, note);
  if (names.length === 0) return null;
  return validateMetadata(resolved, names, note.metadata);
}
