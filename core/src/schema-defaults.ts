/**
 * Schema validation: resolves which schemas apply to a note (by path prefix
 * or tag), then validates the note's metadata against each. Writes are
 * never blocked — schemas are guidance. The MCP/REST layer surfaces a
 * `validation_status` block on create/update responses with any warnings
 * the agent can act on (missing required, type mismatch, enum mismatch).
 *
 * Storage (post-v15): schemas live in the `note_schemas` table; mapping
 * rules live in `schema_mappings`. Authoring is via `update-note-schema`
 * + `set-schema-mapping` (MCP/REST). The legacy `_schemas/<name>` and
 * `_schema_defaults` notes are retired but left in place — inert after
 * v15 (no resolver reads them).
 *
 * Resolution model:
 * - Lazy: rebuilt on first access, cached on the store.
 * - Invalidated when `note_schemas` or `schema_mappings` are mutated
 *   (table writes, not note writes).
 * - When no mappings exist and nothing else matches, validation is a
 *   no-op (status omitted).
 */

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Legacy path prefixes — kept exported for any historical caller that still
// references them. No resolver code reads notes-as-config post-v15.
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

function parseRequiredJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * Build the full resolution map from the `note_schemas` and `schema_mappings`
 * tables. Always returns a well-formed `ResolvedSchemas` even when the
 * tables are empty (empty maps).
 */
export function loadSchemaConfig(db: Database): ResolvedSchemas {
  const definitions = new Map<string, SchemaDefinition>();
  const defRows = db.prepare(
    `SELECT name, description, fields, required FROM note_schemas`,
  ).all() as { name: string; description: string | null; fields: string | null; required: string | null }[];
  for (const row of defRows) {
    if (!row.name) continue;
    definitions.set(row.name, {
      name: row.name,
      description: row.description ?? undefined,
      fields: parseFieldsJson(row.fields),
      required: parseRequiredJson(row.required),
    });
  }

  const defaults: SchemaDefaults = {
    pathPrefixes: [],
    tagToSchema: new Map(),
  };
  const mappingRows = db.prepare(
    `SELECT schema_name, match_kind, match_value FROM schema_mappings`,
  ).all() as { schema_name: string; match_kind: string; match_value: string }[];
  for (const row of mappingRows) {
    if (row.match_kind === "path_prefix") {
      defaults.pathPrefixes.push({ prefix: row.match_value, schema: row.schema_name });
    } else if (row.match_kind === "tag") {
      defaults.tagToSchema.set(row.match_value, row.schema_name);
    }
  }
  // Longest prefix wins — sort once at load so resolve is O(n) without re-sorts.
  defaults.pathPrefixes.sort((a, b) => b.prefix.length - a.prefix.length);

  return { defaults, definitions };
}

// ---------------------------------------------------------------------------
// Resolution + validation
// ---------------------------------------------------------------------------

/**
 * Find the schemas that apply to a note based on its path and tags. Returns
 * schema *names* in the order they were resolved (path-prefix first, then
 * each matching tag in declaration order). Names that don't have a row in
 * `note_schemas` are dropped.
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
