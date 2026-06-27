/**
 * HTTP client for the vault admin SPA's Schema editor (vault#283).
 *
 * The live tag schema / hierarchy / indexed-field catalog lives in the DB
 * `tags` + `indexed_fields` tables (NOT vault.yaml — that block is a legacy
 * one-time seed). The editor reads + writes the DB through the same REST
 * surface the `update-tag` MCP tool funnels through:
 *
 *   - `GET  /api/tags?include_schema=true` — tag list with each tag's
 *     description / fields / relationships / parent_names / counts.
 *   - `GET  /api/tags/:name/effective` — the tag's own ∪ inherited fields,
 *     direct + effective parents, and the vault-wide indexed-field catalog
 *     (vault#283 read endpoint).
 *   - `PUT  /api/tags/:name` — upsert description / fields / parent_names
 *     (the human counterpart to `update-tag`). Server is the authoritative
 *     validator (400 invalid_indexed_field / invalid_relationships / bad
 *     parent_names); the SPA does light client-side checks for fast feedback
 *     and treats the API error as final.
 *   - `POST /api/tags/:name/conformance` — count EXISTING notes that would
 *     violate a PROPOSED field spec, before the operator commits a
 *     tightening (vault#283 / #314 tie-in).
 *
 * Authoritative validation is server-side. `indexed`/`type` are GLOBAL across
 * every tag declaring a field — the server's 400 is the backstop when two
 * tags disagree.
 */
import { HttpError, _authedFetch } from "./api.ts";

/**
 * A single field declaration on a tag, mirroring `core/src/tag-schemas.ts`
 * `TagFieldSchema`. `type` is the user-facing field type. `indexed`,
 * `strict`, `required`, `cardinality` are the per-field constraint flags.
 */
export interface SchemaFieldSpec {
  type?: string;
  description?: string;
  enum?: string[];
  indexed?: boolean;
  strict?: boolean;
  required?: boolean;
  cardinality?: "one" | "many";
}

/** Field types the editor offers. `string`/`integer`/`boolean` are the
 *  indexable subset (TYPE_MAP in core/src/indexed-fields.ts); `number`/
 *  `array`/`object` validate but can't back a generated column. */
export const FIELD_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "array",
  "object",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Types that can be marked `indexed` (back a generated column + index). */
export const INDEXABLE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "integer",
  "boolean",
]);

/** Tag list entry — name + count + the full identity row. */
export interface TagListEntry {
  name: string;
  count: number;
  description: string | null;
  fields: Record<string, SchemaFieldSpec> | null;
  relationships: Record<string, unknown> | null;
  parent_names: string[] | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Single-tag full record (GET /api/tags/:name). */
export interface TagRecordResult {
  name: string;
  count: number;
  description: string | null;
  fields: Record<string, SchemaFieldSpec> | null;
  relationships: Record<string, unknown> | null;
  parent_names: string[] | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Effective-fields preview (GET /api/tags/:name/effective). */
export interface EffectiveSchemaResult {
  name: string;
  parents: string[];
  effective_parents: string[];
  fields: Record<string, SchemaFieldSpec> | null;
  effective_fields: Record<string, SchemaFieldSpec>;
  indexed_fields: IndexedFieldCatalogEntry[];
}

/** One row of the vault-wide indexed-field catalog. */
export interface IndexedFieldCatalogEntry {
  name: string;
  /** User-facing type (string | integer | boolean). */
  type: string;
  /** Every tag that declares this field indexed. */
  tags: string[];
}

/** Conformance report (POST /api/tags/:name/conformance). */
export interface ConformanceResult {
  tag: string;
  total_notes: number;
  violating_notes: number;
  checked_fields: string[];
  sample: {
    id: string;
    path: string | null;
    fields: { field: string; reason: string; message: string }[];
  }[];
}

/** The patch body PUT /api/tags/:name accepts. Omitted keys are preserved;
 *  explicit null clears. By default `fields` is MERGED server-side with prior
 *  keys (the MCP update-tag partial-update contract). Set `replace_fields:
 *  true` so `fields` is treated as the FULL intended map — fields absent from
 *  it are DROPPED. The Schema editor always sends the full map + this flag so
 *  removing a field row actually deletes the field (vault#283). */
export interface TagPatch {
  description?: string | null;
  fields?: Record<string, SchemaFieldSpec> | null;
  parent_names?: string[] | null;
  replace_fields?: boolean;
}

const base = (vaultName: string) => `/vault/${encodeURIComponent(vaultName)}/api/tags`;

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    return parsed.message || parsed.error || text || `${res.status}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/** List every tag with its schema detail. */
export async function listSchemaTags(vaultName: string): Promise<TagListEntry[]> {
  const res = await _authedFetch(
    vaultName,
    `${base(vaultName)}?include_schema=true`,
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as TagListEntry[];
}

/** Fetch a single tag's full record. */
export async function getTagRecord(
  vaultName: string,
  tag: string,
): Promise<TagRecordResult> {
  const res = await _authedFetch(
    vaultName,
    `${base(vaultName)}/${encodeURIComponent(tag)}`,
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as TagRecordResult;
}

/** Fetch the effective (own ∪ inherited) fields + parents + indexed catalog. */
export async function getEffectiveSchema(
  vaultName: string,
  tag: string,
): Promise<EffectiveSchemaResult> {
  const res = await _authedFetch(
    vaultName,
    `${base(vaultName)}/${encodeURIComponent(tag)}/effective`,
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as EffectiveSchemaResult;
}

/**
 * Upsert a tag's schema. The Schema editor sends the FULL intended `fields`
 * map + `replace_fields: true`, so a field removed in the editor is actually
 * DROPPED server-side (without the flag the server merges over prior keys and
 * a removed field would be resurrected). The server is the authoritative
 * validator — a 400 with `invalid_indexed_field` / `invalid_relationships` /
 * parent_names error is final.
 */
export async function saveTag(
  vaultName: string,
  tag: string,
  patch: TagPatch,
): Promise<TagRecordResult> {
  const res = await _authedFetch(
    vaultName,
    `${base(vaultName)}/${encodeURIComponent(tag)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as TagRecordResult;
}

/**
 * Count existing notes that would violate the PROPOSED field spec for `tag`.
 * `fields` is the full merged field map the operator intends to save. Used
 * to warn before a tightening save (vault#283 / #314).
 */
export async function checkConformance(
  vaultName: string,
  tag: string,
  fields: Record<string, SchemaFieldSpec>,
): Promise<ConformanceResult> {
  const res = await _authedFetch(
    vaultName,
    `${base(vaultName)}/${encodeURIComponent(tag)}/conformance`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields }),
    },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as ConformanceResult;
}
