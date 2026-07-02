/**
 * REST API route handlers for the multi-vault server.
 *
 * Mirrors the MCP tools:
 *   /api/notes          — query-notes, create-note, update-note, delete-note
 *   /api/tags           — list-tags, update-tag, delete-tag
 *   /api/find-path      — find-path
 *   /api/vault          — vault-info
 *
 * Each handler receives a Store instance (already resolved for the vault)
 * and the Request, and returns a Response.
 */

import type { Store, Note, QueryOpts } from "../core/src/types.ts";
import { TAG_EXPAND_MODES, stripTagHash, type TagExpandMode } from "../core/src/tag-hierarchy.ts";
import { listUnresolvedWikilinks } from "../core/src/wikilinks.ts";
import { transactionAsync } from "../core/src/txn.ts";
import { getNote, getNotes, getNoteTags, toNoteIndex, filterMetadata, mergeMetadata, MAX_BATCH_SIZE, validateExtension, ExtensionValidationError } from "../core/src/notes.ts";
import {
  parseContentRange,
  applyContentRange,
  contentRangeRequiresContent,
  type ContentRange,
} from "../core/src/content-range.ts";
import { attachValidationStatus, enforceStrictWrite } from "../core/src/mcp.ts";
import type { ValidationWarning } from "../core/src/schema-defaults.ts";
import { logStrictBypass } from "./scopes.ts";
import * as linkOps from "../core/src/links.ts";
import * as tagSchemaOps from "../core/src/tag-schemas.ts";
import { IndexedFieldError } from "../core/src/indexed-fields.ts";
import { buildVaultProjection, resolveTagInheritance } from "../core/src/vault-projection.ts";
import { loadSchemaConfig } from "../core/src/schema-defaults.ts";
import {
  buildExpandVisibility,
  filterHydratedLinksByTagScope,
  filterNotesByTagScope,
  noteWithinTagScope,
  tagScopeForbidden,
  tagsWithinScope,
} from "./tag-scope.ts";
import { findTokensReferencingTag } from "./token-store.ts";

/**
 * Tag-scope context threaded through handlers. `allowed` is the
 * pre-expanded set of permitted tags (root + descendants), `raw` is the
 * original allowlist for error messages. Both null when the token is
 * unscoped — handlers fast-path on `allowed === null` and behave
 * identically to the pre-tag-scope code path.
 */
export type TagScopeCtx = { allowed: Set<string> | null; raw: string[] | null };

const NO_TAG_SCOPE: TagScopeCtx = { allowed: null, raw: null };

/**
 * Write-attribution context (vault#298) for REST writes — the principal
 * (`actor`) and interface (`via`) threaded from the authenticated request into
 * `store.createNote` / `store.updateNote`. Both null for paths without an auth
 * context (the no-op default). See `WriteContext` in core/src/notes.ts.
 */
export type WriteCtx = {
  actor: string | null;
  via: string | null;
  /**
   * Migration-bypass (vault#299). True when the caller holds `vault:migrate`
   * — strict-schema enforcement is skipped and the bypass is logged. Defaults
   * to false (full enforcement) for every normal write.
   */
  bypassStrict?: boolean;
};

const NO_WRITE_CTX: WriteCtx = { actor: null, via: null };

/**
 * Run the shared strict-schema gate for a REST write (vault#299). Mirrors the
 * MCP path's `enforceStrict` closure: enforce unless the caller holds the
 * migration-bypass scope, and log every bypassed write to the daemon's
 * structured log (the audit-log table, #300, is deferred). Throws
 * `SchemaValidationError` (caught by the route's catch → 422) when not bypassed.
 */
function gateStrictWrite(
  store: Store,
  writeCtx: WriteCtx,
  shape: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> },
): void {
  enforceStrictWrite(store, shape, {
    bypass: writeCtx.bypassStrict === true,
    onBypass: (violations: ValidationWarning[]) => {
      logStrictBypass({
        actor: writeCtx.actor,
        via: writeCtx.via,
        path: shape.path ?? null,
        tags: shape.tags,
        violations,
      });
    },
  });
}

import {
  expandContent,
  DEFAULT_EXPAND_DEPTH,
  MAX_EXPAND_DEPTH,
  type ExpandContext,
  type ExpandMode,
} from "../core/src/expand.ts";
import { join, extname, normalize } from "path";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { assetsDir, readGlobalConfig, readVaultConfig } from "./config.ts";
import { shouldAutoTranscribe } from "./auto-transcribe.ts";
// usage.ts imports `assetsDir` from config.ts (neutral ground), so this import
// of invalidateUsageCache does NOT form a cycle — routes.ts → usage.ts only.
import { invalidateUsageCache } from "./usage.ts";

// Re-export `assetsDir` (now defined in config.ts) so the existing callers
// that import it from this module — mirror-deps, mirror-routes, server,
// triggers, cli — keep working unchanged.
export { assetsDir };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function parseBool(val: string | null, defaultVal: boolean): boolean {
  if (val === null) return defaultVal;
  return val === "true" || val === "1";
}

function parseBoolOrUndef(val: string | null): boolean | undefined {
  if (val === null) return undefined;
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  return undefined;
}

function parseQuery(url: URL, key: string): string | null {
  return url.searchParams.get(key);
}

/**
 * Parse `link_count_direction` (vault feedback #4). Defaults to "both";
 * anything other than the three known values falls back to "both" so a
 * typo silently degrades to the documented default rather than erroring.
 *
 * Tag-scope note (symmetric with the MCP param description): `linkCount`
 * is a raw degree that MAY include edges to notes a tag-scoped token can't
 * see — the tag-scope filter runs post-query, over the result notes, not
 * their neighbors. Only the number leaks, not the neighbor.
 */
function parseLinkCountDirection(url: URL): "both" | "outbound" | "inbound" {
  const v = url.searchParams.get("link_count_direction");
  if (v === "outbound" || v === "inbound") return v;
  return "both";
}

function parseQueryList(url: URL, key: string): string[] | undefined {
  const val = url.searchParams.get(key);
  return val ? val.split(",") : undefined;
}

/**
 * Parse `?content_offset=` / `?content_length=` (content range — bounded
 * reads for large notes; unit is UTF-8 bytes, see core/src/content-range.ts
 * for the codepoint-boundary slicing rules). Returns `{ range: null }` when
 * neither param is present (response byte-identical to the no-pagination
 * shape), or `{ error }` (400 INVALID_QUERY) on invalid values or when the
 * response shape excludes content — range params on a content-less shape
 * error loudly rather than silently no-op, same policy as `?expand=`.
 */
function parseContentRangeQuery(
  url: URL,
  includeContent: boolean,
): { range: ContentRange | null; error?: Response } {
  try {
    const range = parseContentRange(
      parseQuery(url, "content_offset") ?? undefined,
      parseQuery(url, "content_length") ?? undefined,
    );
    if (range && !includeContent) throw contentRangeRequiresContent();
    return { range };
  } catch (e: any) {
    // Duck-type on `name` — core is a separate module, so `instanceof`
    // is fragile across bundling boundaries (same note as the QueryError
    // handling in the structured-query path below).
    if (e && e.name === "QueryError") {
      return { range: null, error: json({ error: e.message, code: e.code ?? "INVALID_QUERY" }, 400) };
    }
    throw e;
  }
}

/**
 * Parse the extension query parameter (vault#328). Two accepted shapes:
 *   - `?extension=csv` (single value → string)
 *   - `?extension=csv&extension=yaml` OR `?extension=csv,yaml`
 *     (repeated or comma-list → array)
 * Returns undefined when absent so the queryNotes filter is skipped.
 * Validation lives at the engine layer — bad strings result in zero
 * matches rather than 400, mirroring how `path` works.
 */
function parseExtensionFilter(url: URL): string | string[] | undefined {
  const all = url.searchParams.getAll("extension");
  if (all.length === 0) return undefined;
  // Flatten comma-lists inside each param.
  const flat = all.flatMap((v) => v.split(",")).map((s) => s.trim()).filter((s) => s.length > 0);
  if (flat.length === 0) return undefined;
  if (flat.length === 1) return flat[0]!;
  return flat;
}

function parseInt10(val: string | null): number | undefined {
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

/**
 * Parse bracket-style metadata filters (vault#285 friction point 1.3).
 *
 * Maps `?meta[field][op]=value` (Stripe / JSON:API / Strapi convention) to
 * the engine `metadata` filter shape at `core/src/notes.ts:494-509`. Recognised
 * forms:
 *
 *   - `?meta[field]=value`                 — shorthand equality (JSON-scan;
 *                                            no indexed-field declaration
 *                                            required)
 *   - `?meta[field][op]=value`             — operator query (routes through
 *                                            the indexed generated column;
 *                                            engine raises FIELD_NOT_INDEXED
 *                                            if the field isn't declared)
 *   - `?meta[field][in][]=v1&[in][]=v2`    — array form for in/not_in
 *   - `?meta[field][in]=v1,v2`             — comma-separated form for in/not_in
 *
 * Supported operators mirror the engine: `eq`, `ne`, `gt`, `gte`, `lt`,
 * `lte`, `in`, `not_in`, `exists`. `exists` requires `"true"` or `"false"`;
 * other values reject with INVALID_OPERATOR_VALUE.
 *
 * Compound filters AND together: multiple `meta[a][gte]=1&meta[a][lt]=5`
 * on the same field merge into one operator object; filters on different
 * fields stack as independent AND clauses (engine semantics).
 *
 * **Bridge for the real `n.created_at` / `n.updated_at` columns** — these
 * route through `dateFilter` (the existing engine path that exempts them
 * from the indexed-field gate), not through the metadata-filter path. Only
 * `gte` (→ inclusive `from`) and `lt` (→ exclusive `to`) are accepted on
 * these fields, matching the dateFilter contract exactly. Other operators
 * reject with INVALID_QUERY so callers don't think `meta[created_at][eq]=…`
 * works.
 *
 * Returns `{ metadata?, dateFilter?, error? }`. When `error` is set the
 * caller should return it directly (already shaped as a 400 with
 * `error` + `code`).
 */
function parseMetaBrackets(url: URL): {
  metadata?: Record<string, unknown>;
  dateFilter?: { field: string; from?: string; to?: string };
  error?: Response;
} {
  // Real columns on `notes` — exempt from the indexed-field gate, routed
  // through `dateFilter` instead of `metadata`.
  const REAL_DATE_COLUMNS = new Set(["created_at", "updated_at"]);
  // Operators that take an array value. Used for parser-level rejection of
  // `[]`-array syntax on the wrong operator (e.g. `meta[field][eq][]=value`).
  const ARRAY_OPS = new Set(["in", "not_in"]);
  // `meta[FIELD]` or `meta[FIELD][OP]` or `meta[FIELD][OP][]`. Field names are
  // bounded by `FIELD_NAME_RE` at the engine layer; the parser is liberal here
  // and lets the engine raise the loud error on bad names.
  const META_RE = /^meta\[([^\]]+)\](?:\[([^\]]+)\](\[\])?)?$/;

  // `metadata[field]` is either a primitive (shorthand `eq` via json_extract)
  // or a sub-object of operator clauses. The two are *mutually exclusive per
  // field per request*: mixing them is a silent-data-loss footgun (op set,
  // then shorthand stomps; or shorthand set, then op stomps) so we reject
  // loudly. Track each field's chosen form here.
  const metadata: Record<string, unknown> = {};
  const shorthandFields = new Set<string>();
  const opBucketsByField = new Map<string, Map<string, string[]>>(); // field → op → values (array form)
  const opObjectByField = new Map<string, Record<string, unknown>>(); // field → built op object (single-value ops)

  // dateFilter accumulates `from` (gte) and `to` (lt) bounds on a single
  // column. Spanning both `created_at` AND `updated_at` in one request is
  // not expressible (the engine takes one `field`), so we reject early
  // rather than silently corrupting one bound. See vault#289 review F1.
  let dateField: "created_at" | "updated_at" | null = null;
  let dateFrom: string | undefined;
  let dateTo: string | undefined;

  function rejectMixedForms(field: string): Response {
    return json(
      {
        error: `bracket-meta filter: cannot mix shorthand and operator forms for the same field — \`meta[${field}]=…\` and \`meta[${field}][<op>]=…\` are mutually exclusive in one request. Pick one form.`,
        code: "INVALID_QUERY",
      },
      400,
    );
  }

  function getOpObject(field: string): Record<string, unknown> {
    let bucket = opObjectByField.get(field);
    if (!bucket) {
      bucket = {};
      opObjectByField.set(field, bucket);
    }
    return bucket;
  }

  for (const [key, value] of url.searchParams.entries()) {
    const m = META_RE.exec(key);
    if (!m) continue;
    const field = m[1]!;
    const op = m[2];
    const isArray = m[3] === "[]";

    // Bridge: real date columns route to dateFilter, not metadata.
    if (REAL_DATE_COLUMNS.has(field)) {
      if (!op) {
        return {
          error: json(
            {
              error: `bracket-date filter on \`${field}\` requires an operator: meta[${field}][gte]=… (lower bound) or meta[${field}][lt]=… (upper bound, exclusive).`,
              code: "INVALID_QUERY",
            },
            400,
          ),
        };
      }
      if (op !== "gte" && op !== "lt") {
        return {
          error: json(
            {
              error: `bracket-date filter on \`${field}\` supports only \`gte\` (inclusive lower bound) and \`lt\` (exclusive upper bound). Got: \`${op}\`. The dateFilter contract is half-open by design.`,
              code: "INVALID_QUERY",
            },
            400,
          ),
        };
      }
      // F1: dateFilter takes a single column. Reject the cross-column
      // case before assigning — otherwise the second column's
      // assignment would silently override the first.
      if (dateField !== null && dateField !== field) {
        return {
          error: json(
            {
              error: `bracket-date filter cannot span both \`created_at\` and \`updated_at\` in one request — issue two queries or use one column per request.`,
              code: "INVALID_QUERY",
            },
            400,
          ),
        };
      }
      dateField = field as "created_at" | "updated_at";
      if (op === "gte") dateFrom = value;
      else dateTo = value;
      continue;
    }

    // Regular metadata field.
    if (!op) {
      // Shorthand: `?meta[field]=value` → primitive (engine routes through
      // json_extract; no indexed declaration required).
      // F2: reject if any operator form already wrote a bucket for this
      // field — the two shapes don't compose and the silent stomp would
      // drop one form's intent. Mirror check for the reverse order below.
      if (opObjectByField.has(field) || opBucketsByField.has(field)) {
        return { error: rejectMixedForms(field) };
      }
      shorthandFields.add(field);
      metadata[field] = value;
      continue;
    }
    // F2: reject if shorthand already wrote a primitive for this field.
    if (shorthandFields.has(field)) {
      return { error: rejectMixedForms(field) };
    }
    // F4: `[]`-array syntax only makes sense for `in` / `not_in`. Other ops
    // (eq, gt, exists, …) take a scalar; `meta[field][eq][]=v` is a
    // shape error — surface it at the parser layer with a clear message
    // instead of letting the engine raise a generic INVALID_OPERATOR_VALUE
    // downstream.
    if (isArray && !ARRAY_OPS.has(op)) {
      return {
        error: json(
          {
            error: `bracket-meta filter: array form \`meta[${field}][${op}][]=…\` is only valid for \`in\` and \`not_in\`. \`${op}\` takes a single value — use \`meta[${field}][${op}]=value\` instead.`,
            code: "INVALID_OPERATOR_VALUE",
          },
          400,
        ),
      };
    }
    if (isArray) {
      // `meta[field][in][]=v1&meta[field][in][]=v2`. Nested map keeps
      // field and op as separate dimensions — no string-concat ambiguity
      // for field names that contain (or might one day be allowed to
      // contain) the delimiter character. See vault#289 review F5.
      let fieldBucket = opBucketsByField.get(field);
      if (!fieldBucket) {
        fieldBucket = new Map<string, string[]>();
        opBucketsByField.set(field, fieldBucket);
      }
      let values = fieldBucket.get(op);
      if (!values) {
        values = [];
        fieldBucket.set(op, values);
      }
      values.push(value);
      continue;
    }
    if (op === "in" || op === "not_in") {
      // Comma form: `meta[field][in]=v1,v2`. Mutually exclusive with the
      // `[]` array form per field+op — last write wins if both are
      // supplied; we don't reject because the resulting array is well-
      // defined regardless of which form a caller picked.
      const arr = value.includes(",")
        ? value.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
        : [value];
      getOpObject(field)[op] = arr;
    } else if (op === "exists") {
      const bool = value === "true" ? true : value === "false" ? false : null;
      if (bool === null) {
        return {
          error: json(
            {
              error: `bracket-meta filter: \`exists\` on \`${field}\` requires "true" or "false", got "${value}"`,
              code: "INVALID_OPERATOR_VALUE",
            },
            400,
          ),
        };
      }
      getOpObject(field)[op] = bool;
    } else {
      // eq / ne / gt / gte / lt / lte — all primitive, single value. Type
      // coercion is left to SQLite affinity rules: indexed columns are
      // declared TEXT or INTEGER, and SQLite will compare a string-shaped
      // numeric correctly against an INTEGER column. The engine raises
      // UNKNOWN_OPERATOR if `op` isn't in SUPPORTED_OPS.
      getOpObject(field)[op] = value;
    }
  }

  // Roll up `[]`-array buckets onto their op-objects. Done after the main
  // loop so `in`/`not_in` array-form and comma-form on the same field
  // collapse into one merged op-object cleanly.
  for (const [field, opMap] of opBucketsByField) {
    for (const [op, values] of opMap) {
      getOpObject(field)[op] = values;
    }
  }
  // Roll up op-objects onto the metadata payload.
  for (const [field, opObj] of opObjectByField) {
    metadata[field] = opObj;
  }

  const result: {
    metadata?: Record<string, unknown>;
    dateFilter?: { field: string; from?: string; to?: string };
  } = {};
  if (Object.keys(metadata).length > 0) result.metadata = metadata;
  if (dateField) {
    result.dateFilter = { field: dateField };
    if (dateFrom !== undefined) result.dateFilter.from = dateFrom;
    if (dateTo !== undefined) result.dateFilter.to = dateTo;
  }
  return result;
}

/**
 * Parse the `?metadata=<json>` alias on GET /api/notes — the JSON-object form
 * of the metadata filter, symmetric with the nested `metadata` object MCP
 * forwards verbatim (`core/src/mcp.ts`). The value is a JSON object of the form
 * `{"field":{"op":value}}` (operator query) or `{"field":value}` (shorthand
 * equality via the engine's json_extract fallback).
 *
 * This exists because the bracket grammar (`?meta[field][op]=value`) couldn't
 * see a `metadata=` param at all — it was silently dropped, and the query
 * returned ALL tag-matching notes (a silent wrong result, not an error).
 *
 * We do NOT validate operators here — the parsed object lowers straight into
 * `queryNotes`, where `validateOperatorObject` raises a loud 400 on unknown
 * operators (caught by the QueryError handler in handleNotes). We only enforce
 * that the param parses and is a non-null, non-array plain object; anything
 * else is a malformed filter the engine can't consume.
 *
 * An empty object (`metadata={}`) carries no filter intent, so it's treated as
 * absent: it sets no metadata filter AND doesn't trip the both-forms guard, so
 * it composes harmlessly with bracket params.
 *
 * Returns `{ metadata?, error? }`. When `error` is set the caller returns it
 * directly (already shaped as a 400 with `error` + `code`).
 */
function parseMetadataJsonAlias(url: URL): {
  metadata?: Record<string, unknown>;
  error?: Response;
} {
  const raw = parseQuery(url, "metadata");
  if (raw === null) return {};

  const malformed = (detail: string): Response =>
    json(
      {
        error: `metadata query param must be a JSON object of the form {"field":{"op":value}} — ${detail}`,
        code: "INVALID_QUERY",
      },
      400,
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: malformed(`failed to parse: ${e instanceof Error ? e.message : String(e)}`) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
    return { error: malformed(`got ${got}`) };
  }
  // Empty object → no filter intent. Return absent so it neither sets a
  // metadata filter nor trips the both-forms guard in the handler.
  if (Object.keys(parsed).length === 0) return {};
  return { metadata: parsed as Record<string, unknown> };
}

/**
 * Parse + validate the `?expand=` tag-expansion axis (vault tag `expand` axis).
 * Shared by `parseNotesQueryOpts` (structured + subscribe) AND the full-text
 * search branch of `handleNotes` (which bypasses `parseNotesQueryOpts`), so the
 * enum lives in exactly one place and `GET /notes?search=...&expand=bogus` is
 * validated identically to the structured path.
 *
 * Returns `{ expand }` (undefined when absent/empty → store defaults to
 * "subtypes") or `{ error }` (a 400 Response) on an unknown value.
 */
export function parseExpandParam(url: URL): { expand?: TagExpandMode; error?: Response } {
  const expandParam = parseQuery(url, "expand");
  if (expandParam === null || expandParam === "") return {};
  if (!(TAG_EXPAND_MODES as readonly string[]).includes(expandParam)) {
    return {
      error: json(
        {
          error: `invalid \`expand\` value "${expandParam}" — must be one of ${TAG_EXPAND_MODES.map((m) => `"${m}"`).join(", ")}. Omit for the default ("subtypes": parent_names descendants).`,
          code: "INVALID_QUERY",
        },
        400,
      ),
    };
  }
  return { expand: expandParam as TagExpandMode };
}

/**
 * Parse the shared notes-query parameters (tags / excludeTags / path /
 * pathPrefix / extension / metadata filters / date filters / sort / paging /
 * cursor) into a `QueryOpts`, plus flags for the query shapes that the live
 * subscription endpoint must reject (`search`, `near`, `cursor`).
 *
 * Factored out of `handleNotesInner`'s structured-query branch so the
 * `/subscribe` route evaluates the SAME predicate the snapshot query does —
 * predicate parity by construction, not copy-paste. `handleNotesInner` keeps
 * its own inline parsing for the single-note (`id`) and full-text (`search`)
 * branches; this helper covers the structured-query shape both endpoints share.
 *
 * Returns `{ error }` (a 400 Response) on a malformed metadata filter, exactly
 * as the inline code did. `hasSearch` is surfaced from the raw `search` param
 * (this helper does not itself build a search query — the caller routes that).
 */
export function parseNotesQueryOpts(url: URL): {
  queryOpts?: QueryOpts;
  hasSearch: boolean;
  hasNear: boolean;
  hasCursor: boolean;
  error?: Response;
} {
  const hasSearch = parseQuery(url, "search") !== null && parseQuery(url, "search") !== "";
  const hasNear = parseQuery(url, "near[note_id]") !== null;
  const cursorParam = parseQuery(url, "cursor");
  const hasCursor = cursorParam !== null && cursorParam !== "";

  const tags = parseQueryList(url, "tag");
  const bracket = parseMetaBrackets(url);
  if (bracket.error) return { hasSearch, hasNear, hasCursor, error: bracket.error };
  const metadataAlias = parseMetadataJsonAlias(url);
  if (metadataAlias.error) return { hasSearch, hasNear, hasCursor, error: metadataAlias.error };
  if (metadataAlias.metadata && bracket.metadata) {
    return {
      hasSearch,
      hasNear,
      hasCursor,
      error: json(
        {
          error: "pass metadata filters as either the JSON `metadata=` param or bracket `meta[field][op]=` form, not both.",
          code: "INVALID_QUERY",
        },
        400,
      ),
    };
  }

  // Tag-expansion axis (vault tag `expand` axis). Optional; absent →
  // "subtypes" (resolved at the store, kept undefined here so it stays
  // byte-identical to pre-axis behavior). Unknown value → 400 via the shared
  // helper (same shape the search branch uses).
  const expandParsed = parseExpandParam(url);
  if (expandParsed.error) return { hasSearch, hasNear, hasCursor, error: expandParsed.error };
  const expand = expandParsed.expand;

  const queryOpts: QueryOpts = {
    tags,
    tagMatch: (parseQuery(url, "tag_match") as "all" | "any") ?? (tags && tags.length > 1 ? "any" : undefined),
    expand,
    excludeTags: parseQueryList(url, "exclude_tag"),
    hasTags: parseBoolOrUndef(parseQuery(url, "has_tags")),
    hasLinks: parseBoolOrUndef(parseQuery(url, "has_links")),
    path: parseQuery(url, "path") ?? undefined,
    pathPrefix: parseQuery(url, "path_prefix") ?? undefined,
    extension: parseExtensionFilter(url),
    metadata: bracket.metadata ?? metadataAlias.metadata,
    // Write-attribution filters (vault#298) — symmetric with the MCP
    // query-notes tool so a REST caller can ask "what did Mathilda write" /
    // "what came in via the meeting-ingest surface" the same way.
    createdBy: parseQuery(url, "created_by") ?? undefined,
    lastUpdatedBy: parseQuery(url, "last_updated_by") ?? undefined,
    createdVia: parseQuery(url, "created_via") ?? undefined,
    lastUpdatedVia: parseQuery(url, "last_updated_via") ?? undefined,
    // Date-range filtering on the query string is bracket-style only:
    // `?meta[created_at][gte]=…&meta[created_at][lt]=…` (see
    // `parseMetaBrackets`). The flat `date_field` / `date_from` / `date_to`
    // params were removed in 0.6.4 (vault#288, breaking) — they are now
    // ignored. The MCP `date_from` / `date_to` shorthand is a separate,
    // supported convenience and is unaffected.
    ...(bracket.dateFilter ? { dateFilter: bracket.dateFilter } : {}),
    sort: (parseQuery(url, "sort") as "asc" | "desc") ?? undefined,
    orderBy: parseQuery(url, "order_by") ?? undefined,
    limit: parseInt10(parseQuery(url, "limit")) ?? 50,
    offset: parseInt10(parseQuery(url, "offset")),
    cursor: cursorParam ?? undefined,
  };

  return { queryOpts, hasSearch, hasNear, hasCursor };
}

/**
 * Parse include_metadata query param.
 * - absent/null → undefined (all metadata, default)
 * - "true"/"1" → true (all metadata)
 * - "false"/"0" → false (no metadata)
 * - "summary,status" → ["summary", "status"] (field filter)
 */
function parseIncludeMetadata(url: URL): boolean | string[] | undefined {
  const val = url.searchParams.get("include_metadata");
  if (val === null) return undefined;
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  const fields = val.split(",").map((s) => s.trim()).filter(Boolean);
  if (fields.length === 0) return undefined; // empty string → treat as default (all)
  return fields;
}

/**
 * Parse expand_links/expand_depth/expand_mode from query params, returning
 * an (ExpandContext, depth) pair if expansion is requested, else null.
 *
 * `tagScope` (security review): when the caller is tag-scoped, an `isVisible`
 * predicate is built from the SAME tag-scope allowlist the rest of the
 * handler uses and injected into the expand context. The expander then
 * leaves any `[[wikilink]]` whose target is out of scope UNRESOLVED — so
 * `expand_links=true` can never inline out-of-scope note content (and the
 * out-of-scope case is byte-indistinguishable from a missing target). For
 * an unscoped token the predicate is `undefined` and expansion behaves
 * exactly as before.
 */
function parseExpandParams(
  url: URL,
  db: any,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
): { ctx: ExpandContext; depth: number } | null {
  if (!parseBool(parseQuery(url, "expand_links"), false)) return null;
  const modeRaw = parseQuery(url, "expand_mode");
  const mode: ExpandMode = modeRaw === "summary" ? "summary" : "full";
  const depth = Math.max(
    0,
    Math.min(
      parseInt10(parseQuery(url, "expand_depth")) ?? DEFAULT_EXPAND_DEPTH,
      MAX_EXPAND_DEPTH,
    ),
  );
  const isVisible = buildExpandVisibility(tagScope.allowed, tagScope.raw);
  return { ctx: { db, mode, expanded: new Set(), ...(isVisible ? { isVisible } : {}) }, depth };
}


/**
 * Resolve a note by ID or path. Tries ID first, then case-insensitive
 * path. A trailing `.<ext>` matching the extension pattern is parsed
 * as `(path, extension)` to disambiguate notes sharing a path
 * differing only by extension (vault#330 S1). When the path is
 * ambiguous and no extension hint is supplied, `getNoteByPath` throws
 * `AmbiguousPathError` — REST handlers catch it and return 409.
 */
async function resolveNote(store: Store, idOrPath: string): Promise<Note | null> {
  const byId = await store.getNote(idOrPath);
  if (byId) return byId;
  const extMatch = idOrPath.match(/^(.*)\.([a-z0-9]{1,16})$/i);
  if (extMatch) {
    const explicit = await store.getNoteByPath(extMatch[1]!, extMatch[2]!);
    if (explicit) return explicit;
  }
  return await store.getNoteByPath(idOrPath);
}

async function requireNote(store: Store, idOrPath: string): Promise<Note> {
  const note = await resolveNote(store, idOrPath);
  if (!note) throw new NotFoundError(`Note not found: "${idOrPath}"`);
  return note;
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Notes — GET/POST/PATCH/DELETE /api/notes[/:idOrPath]
// ---------------------------------------------------------------------------

/**
 * Convert a thrown `AmbiguousPathError` (vault#330 S1) into a structured
 * 409 JSON response. Shared by every handler that calls `resolveNote`
 * with a user-supplied path — handleNotes, handleFindPath,
 * handleViewNote. Returns null when the error isn't an
 * AmbiguousPathError so the caller can re-throw / fall through.
 */
function ambiguousPathResponse(e: any): Response | null {
  if (!e || e.code !== "AMBIGUOUS_PATH") return null;
  return json(
    {
      error_type: "ambiguous_path",
      error: "ambiguous_path",
      path: e.path,
      candidates: e.candidates,
      message: e.message,
    },
    409,
  );
}

export async function handleNotes(
  req: Request,
  store: Store,
  subpath: string,
  vault?: string,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
  writeCtx: WriteCtx = NO_WRITE_CTX,
): Promise<Response> {
  try {
    return await handleNotesInner(req, store, subpath, vault, tagScope, writeCtx);
  } catch (e: any) {
    const ambig = ambiguousPathResponse(e);
    if (ambig) return ambig;
    throw e;
  }
}

async function handleNotesInner(
  req: Request,
  store: Store,
  subpath: string,
  vault?: string,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
  writeCtx: WriteCtx = NO_WRITE_CTX,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const db = store.db;

  // ---- Collection routes (no ID in path) ----
  if (subpath === "") {
    // GET /notes — query (all filters as query params)
    if (method === "GET") {
      const id = parseQuery(url, "id");
      const search = parseQuery(url, "search");

      // Single note by id/path
      if (id) {
        const note = await resolveNote(store, id);
        if (!note) return json({ error: "Note not found", id }, 404);
        // Tag-scope: a token can't see what its allowlist excludes. Surface
        // as 404 (not 403) — the existence of the note is itself information
        // we shouldn't leak across the scope boundary.
        if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
          return json({ error: "Note not found", id }, 404);
        }
        const includeContent = parseBool(parseQuery(url, "include_content"), true);
        const contentRange = parseContentRangeQuery(url, includeContent);
        if (contentRange.error) return contentRange.error;
        let result: any = includeContent ? { ...note } : toNoteIndex(note);
        const expand = parseExpandParams(url, db, tagScope);
        if (expand && includeContent && typeof result.content === "string") {
          expand.ctx.expanded.add(note.id);
          result.content = expandContent(result.content, expand.ctx, expand.depth);
        }
        // Content range applies to the FINAL returned content (post-
        // expansion) — the window the client pages through is the same
        // document it would have received unpaged.
        if (contentRange.range && includeContent) applyContentRange(result, contentRange.range);
        result = filterMetadata(result, parseIncludeMetadata(url));
        if (parseBool(parseQuery(url, "include_links"), false)) {
          // Tag-scope: drop links whose neighbor is out of scope so the
          // hydrated sourceNote/targetNote summaries can't leak out-of-scope
          // ids/paths/tags. No-op for unscoped tokens.
          result.links = filterHydratedLinksByTagScope(
            linkOps.getLinksHydrated(db, note.id),
            tagScope.allowed,
            tagScope.raw,
          );
        }
        if (parseBool(parseQuery(url, "include_attachments"), false)) {
          result.attachments = await store.getAttachments(note.id);
        }
        // linkCount injected after filterMetadata on purpose — same as
        // links/attachments above; filterMetadata only touches `metadata`.
        if (parseBool(parseQuery(url, "include_link_count"), false)) {
          result.linkCount = linkOps.getLinkCounts(db, [note.id], parseLinkCountDirection(url)).get(note.id) ?? 0;
        }
        return json(result);
      }

      // Cursor + full-text search is mutually exclusive (vault#313 reviewer).
      // FTS owns its own ordering (relevance, not updated_at), so a cursor
      // would skip rows. MCP rejects this combo at `core/src/mcp.ts`; REST
      // would otherwise route into the `if (search)` branch below and
      // silently drop the cursor. Reject here for surface parity.
      if (search && parseQuery(url, "cursor")) {
        return json(
          {
            error: "cursor is incompatible with full-text search — FTS has its own ordering. Use date_filter on updated_at for since-last-checked search.",
            code: "INVALID_QUERY",
          },
          400,
        );
      }

      // Full-text search
      if (search) {
        const searchTags = parseQueryList(url, "tag");
        const limit = parseInt10(parseQuery(url, "limit")) ?? 50;
        // Tag-expansion axis (vault tag `expand` axis). This branch bypasses
        // `parseNotesQueryOpts`, so validate `?expand=` here too — otherwise
        // `GET /notes?search=x&expand=bogus` would silently ignore the bad
        // value. The validated mode is threaded into the search tag-narrowing.
        const tagExpand = parseExpandParam(url);
        if (tagExpand.error) return tagExpand.error;
        const rawResults = await store.searchNotes(search, {
          tags: searchTags,
          limit,
          expand: tagExpand.expand,
        });
        // Tag-scope: drop any result the token isn't permitted to see. Filter
        // happens after the store query so an empty post-filter list still
        // returns 200 [] (consistent with "no matches"), not 403.
        const results = filterNotesByTagScope(rawResults, tagScope.allowed, tagScope.raw);
        const includeContent = parseBool(parseQuery(url, "include_content"), false);
        const contentRange = parseContentRangeQuery(url, includeContent);
        if (contentRange.error) return contentRange.error;
        const inclMeta = parseIncludeMetadata(url);
        let output: any[] = includeContent ? results.map((n) => ({ ...n })) : results.map(toNoteIndex);
        const expand = parseExpandParams(url, db, tagScope);
        if (expand && includeContent) {
          for (const n of output) expand.ctx.expanded.add(n.id);
          for (const n of output) {
            if (typeof n.content === "string") {
              n.content = expandContent(n.content, expand.ctx, expand.depth);
            }
          }
        }
        // Content range — per-note, post-expansion (see core/src/content-range.ts).
        if (contentRange.range && includeContent) {
          for (const n of output) applyContentRange(n, contentRange.range);
        }
        if (inclMeta !== undefined && inclMeta !== true) {
          output = output.map((n: any) => filterMetadata(n, inclMeta));
        }
        // Opt-in link degree (vault feedback #4) — one batch count, same as
        // the structured-query path. Runs AFTER filterMetadata on purpose
        // (filterMetadata only touches `metadata`, so linkCount survives —
        // don't casually swap the order).
        if (parseBool(parseQuery(url, "include_link_count"), false)) {
          const counts = linkOps.getLinkCounts(
            db,
            output.map((n: any) => n.id),
            parseLinkCountDirection(url),
          );
          for (const n of output) n.linkCount = counts.get(n.id) ?? 0;
        }
        return json(output);
      }

      // Structured query
      //
      // Date-range filtering on the query string uses one syntax:
      //
      //   - **Bracket-style** (canonical, vault#285 friction point 1.3):
      //     `?meta[field][op]=value` / `?meta[created_at][gte]=…`. Exposes
      //     the full engine `metadata` filter (eq/ne/gt/gte/lt/lte/in/
      //     not_in/exists) and the dateFilter bridge through one consistent
      //     shape. See `parseMetaBrackets` for the grammar.
      //
      // The flat date params (`?date_field=created_at&date_from=…&date_to=…`
      // and the legacy bare `?date_from=…&date_to=…`) were REMOVED in 0.6.4
      // (vault#288, breaking change). They are now silently ignored — a
      // request that passes only flat date params comes back unfiltered.
      // Bracket-style is functionally complete (full operator set), so no
      // capability was lost. Migrate `date_field=created_at&date_from=X` to
      // `meta[created_at][gte]=X` (and `date_to=Y` to `meta[created_at][lt]=Y`).
      //
      // Surface asymmetry: REST flattens to a query string; MCP takes a
      // nested `date_filter: { field, from, to }` object directly (plus a
      // top-level `date_from` / `date_to` shorthand, which is unaffected by
      // this removal). Both lower to the same store-level `dateFilter` shape.
      // Structured-query parsing is shared with the live `/subscribe` route
      // (see `parseNotesQueryOpts`) so both endpoints lower an identical query
      // string to the same `QueryOpts` — predicate parity by construction.
      const parsed = parseNotesQueryOpts(url);
      if (parsed.error) return parsed.error;
      const queryOpts = parsed.queryOpts!;
      const cursorParam = parseQuery(url, "cursor");
      // Opaque cursor for "since last checked" agent loops (vault#313) is
      // mutually exclusive with the `near` graph-neighborhood scope (rebuilding
      // the neighborhood per page isn't stable).
      const nearNoteIdEarly = parseQuery(url, "near[note_id]");
      if (cursorParam && nearNoteIdEarly) {
        return json(
          {
            error: "cursor is incompatible with near (graph neighborhood). Resolve the neighborhood first, then iterate with cursor over the resulting note set.",
            code: "INVALID_QUERY",
          },
          400,
        );
      }
      let results: Note[];
      let nextCursor: string | null = null;
      try {
        if (cursorParam) {
          const page = await store.queryNotesPaged(queryOpts);
          results = page.notes;
          nextCursor = page.next_cursor;
        } else {
          results = await store.queryNotes(queryOpts);
        }
      } catch (e: any) {
        // QueryError (non-indexed order_by, unknown operator, ...) surfaces
        // here. Duck-type on `name` + `code` — core is a separate module, so
        // `instanceof` is fragile across bundling boundaries.
        if (e && e.name === "QueryError") {
          return json({ error: e.message, code: e.code ?? "INVALID_QUERY" }, 400);
        }
        // CursorError carries a structured code (cursor_invalid /
        // cursor_query_mismatch) so the agent loop can distinguish a
        // malformed cursor from a hash-mismatch and react appropriately
        // (the latter typically means the agent changed its filter and
        // should drop the cursor + restart from scratch).
        if (e && e.name === "CursorError") {
          return json({ error: e.message, code: e.code ?? "cursor_invalid" }, 400);
        }
        throw e;
      }

      // Near-scope filter (graph neighborhood)
      const nearNoteId = parseQuery(url, "near[note_id]");
      if (nearNoteId) {
        const anchor = await resolveNote(store, nearNoteId);
        if (!anchor) return json({ error: "Anchor note not found", note_id: nearNoteId }, 404);
        // Tag-scope: anchor must itself be visible to this token.
        if (!noteWithinTagScope(anchor, tagScope.allowed, tagScope.raw)) {
          return json({ error: "Anchor note not found", note_id: nearNoteId }, 404);
        }
        const depth = Math.min(parseInt10(parseQuery(url, "near[depth]")) ?? 2, 5);
        const relationship = parseQuery(url, "near[relationship]") ?? undefined;
        // Tag-scope policy for `near[]` (vault#439 — hop-guard, symmetric with
        // find-path): for a tag-scoped token the BFS refuses to traverse
        // THROUGH out-of-scope notes — scope is a wall, not a sieve. So a token
        // scoped to ["work"] can't reach an in-scope note at depth 2 via a
        // #personal intermediary at depth 1; that note is simply unreachable.
        // The `filterNotesByTagScope` pass below still runs (defense in depth),
        // but the wall makes it redundant for the `near[]` result set.
        // Unscoped tokens (`tagScope.raw === null`) install no predicate → the
        // FULL graph is walked exactly as before, behavior unchanged.
        const isTraversable = tagScope.raw
          ? (id: string) =>
              noteWithinTagScope(
                { id, tags: getNoteTags(db, id) } as Note,
                tagScope.allowed,
                tagScope.raw,
              )
          : undefined;
        const traversed = linkOps.traverseLinks(db, anchor.id, { max_depth: depth, relationship, isTraversable });
        const nearScope = new Set([anchor.id, ...traversed.map((t) => t.noteId)]);
        results = results.filter((n) => nearScope.has(n.id));
      }

      // Tag-scope: drop any result outside the allowlist before shaping
      // output. Same semantics as the search path — empty result is 200 [],
      // not 403.
      results = filterNotesByTagScope(results, tagScope.allowed, tagScope.raw);

      const includeContent = parseBool(parseQuery(url, "include_content"), false);
      const contentRange = parseContentRangeQuery(url, includeContent);
      if (contentRange.error) return contentRange.error;
      const includeLinks = parseBool(parseQuery(url, "include_links"), false);
      const includeAttachments = parseBool(parseQuery(url, "include_attachments"), false);
      const includeLinkCount = parseBool(parseQuery(url, "include_link_count"), false);
      const inclMeta = parseIncludeMetadata(url);
      let output: any[] = includeContent ? results.map((n) => ({ ...n })) : results.map(toNoteIndex);
      const expand = parseExpandParams(url, db, tagScope);
      if (expand && includeContent) {
        for (const n of output) expand.ctx.expanded.add(n.id);
        for (const n of output) {
          if (typeof n.content === "string") {
            n.content = expandContent(n.content, expand.ctx, expand.depth);
          }
        }
      }
      // Content range — per-note, post-expansion (see core/src/content-range.ts).
      if (contentRange.range && includeContent) {
        for (const n of output) applyContentRange(n, contentRange.range);
      }
      if (inclMeta !== undefined && inclMeta !== true) {
        output = output.map((n: any) => filterMetadata(n, inclMeta));
      }
      // Opt-in link degree (vault feedback #4). ONE batch count over all
      // result ids — NOT a per-note query — so the field stays O(2 index
      // scans) per request regardless of page size. Mutates `output` in
      // place; injected on the same objects the enrichment loop below
      // touches, the same way `links`/`attachments` are surfaced.
      // Ordering: this runs AFTER the filterMetadata pass above on purpose —
      // filterMetadata only touches the `metadata` key, so a linkCount
      // injected here survives. Don't casually swap the order; injecting
      // before filterMetadata would still survive today but couples the two
      // to filterMetadata's current narrow behavior.
      if (includeLinkCount) {
        const counts = linkOps.getLinkCounts(
          db,
          output.map((n: any) => n.id),
          parseLinkCountDirection(url),
        );
        for (const n of output) n.linkCount = counts.get(n.id) ?? 0;
      }

      // Graph format — reshape into { nodes, edges }
      if (parseQuery(url, "format") === "graph") {
        const resultIds = new Set(results.map((n) => n.id));
        const nodes = output.map((n: any) => ({ id: n.id, path: n.path ?? null, tags: n.tags ?? [] }));
        const edges: { source: string; target: string; relationship: string }[] = [];
        if (includeLinks) {
          const linksByNote = linkOps.getLinksHydratedForNotes(db, results.map((n) => n.id));
          for (const n of results) {
            for (const link of linksByNote.get(n.id) ?? []) {
              // Only include edges where source is this note and target is in the result set
              if (link.sourceId === n.id && resultIds.has(link.targetId)) {
                edges.push({ source: link.sourceId, target: link.targetId, relationship: link.relationship });
              }
            }
          }
        }
        return json({ nodes, edges });
      }

      if (includeLinks || includeAttachments) {
        // Whole-page link hydration in a constant number of queries — the
        // per-note variant cost (1 link query + 1 summary query + N tag
        // queries) × page size. 2026-06-10 perf measurements.
        const linksByNote = includeLinks
          ? linkOps.getLinksHydratedForNotes(db, output.map((n: any) => n.id))
          : null;
        const enrichedOut: any[] = [];
        for (const n of output) {
          const enriched: any = { ...n };
          if (linksByNote) {
            // Tag-scope: strip out-of-scope-neighbor links (no-op unscoped).
            enriched.links = filterHydratedLinksByTagScope(
              linksByNote.get(n.id) ?? [],
              tagScope.allowed,
              tagScope.raw,
            );
          }
          if (includeAttachments) enriched.attachments = await store.getAttachments(n.id);
          enrichedOut.push(enriched);
        }
        // Cursor mode wraps the list in {notes, next_cursor} so an agent
        // loop can chain calls without tracking a watermark client-side.
        // Legacy callers (no `cursor` param) still get the flat array.
        if (cursorParam) return json({ notes: enrichedOut, next_cursor: nextCursor });
        return json(enrichedOut);
      }

      if (cursorParam) return json({ notes: output, next_cursor: nextCursor });
      return json(output);
    }

    // POST /notes — create (single or batch)
    if (method === "POST") {
      const body = await req.json() as any;
      const items: any[] = body.notes ?? [body];

      // Batch cap (#213): refuse oversized batches before doing any work. 500
      // is the cap (Benjamin's number) — tighter blast radius than 1000 for
      // the runaway-client case that flooded a deployment with 7,453 notes.
      if (items.length > MAX_BATCH_SIZE) {
        return json(
          {
            error_type: "batch_too_large",
            error: "BatchTooLarge",
            message: `max ${MAX_BATCH_SIZE} notes per request, got ${items.length}`,
            limit: MAX_BATCH_SIZE,
          },
          413,
        );
      }

      // Tag-scope pre-validation: every new note in the batch must carry at
      // least one tag inside the token's allowlist. Reject the whole request
      // before any DB write so a tag-scoped token can't accidentally land a
      // partial batch with an in-scope prefix.
      if (tagScope.allowed) {
        for (let i = 0; i < items.length; i++) {
          if (!tagsWithinScope(items[i]?.tags, tagScope.allowed, tagScope.raw)) {
            return tagScopeForbidden(tagScope.raw ?? []);
          }
        }
      }

      const created: Note[] = [];
      // Wrap multi-item batches in a SQLite transaction so a mid-batch
      // failure (path conflict, etc.) rolls back every prior insert. Without
      // this, callers got half-applied batches where the prefix landed and
      // the offending entry surfaced the 409 — see #236. Single-item posts
      // are already atomic at the store layer and skip the wrap so they
      // don't collide with concurrent single-item callers on the shared
      // bun:sqlite connection.
      const batched = items.length > 1;
      const runBatch = async (): Promise<void> => {
        for (const item of items) {
          // Validate extension before reaching the Store (vault#328).
          // Thrown inside the batch transaction — rolls the batch back,
          // same shape as the path-conflict path.
          const extension = item.extension !== undefined
            ? validateExtension(item.extension)
            : undefined;
          // Strict-schema gate (vault#299) — reject before any write so a
          // mid-batch violation rolls back the batch transaction.
          gateStrictWrite(store, writeCtx, {
            path: item.path,
            tags: item.tags,
            metadata: item.metadata,
          });
          const note = await store.createNote(item.content ?? "", {
            id: item.id,
            path: item.path,
            tags: item.tags,
            metadata: item.metadata,
            created_at: item.createdAt ?? item.created_at,
            ...(extension !== undefined ? { extension } : {}),
            // Write-attribution (vault#298) — REST batch create.
            actor: writeCtx.actor,
            via: writeCtx.via,
          });

          // Create explicit links
          if (item.links) {
            for (const link of item.links as { target: string; relationship: string }[]) {
              const target = await resolveNote(store, link.target);
              if (target) await store.createLink(note.id, target.id, link.relationship);
            }
          }

          created.push((await store.getNote(note.id)) ?? note);
        }
      };
      try {
        await (batched ? transactionAsync(db, runBatch) : runBatch());
      } catch (e: any) {
        // Duck-type for module-boundary robustness (matches the PATCH branch).
        if (e && e.code === "PATH_CONFLICT") {
          return json(
            { error_type: "path_conflict", error: "path_conflict", path: e.path, message: e.message },
            409,
          );
        }
        // Strict-schema rejection (vault#299 Part A) on create — 422.
        if (e && e.code === "SCHEMA_VALIDATION") {
          return json(
            { error_type: "schema_validation", error: "schema_validation", violations: e.violations ?? [], message: e.message },
            422,
          );
        }
        if (e && e.code === "INVALID_EXTENSION") {
          return json(
            { error_type: "invalid_extension", error: "invalid_extension", extension: e.extension, reason: e.reason, message: e.message },
            400,
          );
        }
        throw e;
      }

      // Apply tag schema defaults, then re-read the notes whose metadata was
      // actually default-filled so the response reflects the final on-disk
      // state (the `created` entries were read before `applySchemaDefaults`
      // ran). Mirrors the MCP create-note path (vault#316). Batched re-read
      // (`getNotes` = one `WHERE id IN (...)`), skipped when no defaults
      // applied so the common no-defaults path adds zero extra reads.
      const mutatedIds = new Set<string>();
      for (const note of created) {
        if (note.tags?.length) {
          for (const id of await applySchemaDefaults(store, db, [note.id], note.tags)) {
            mutatedIds.add(id);
          }
        }
      }
      const refreshed =
        mutatedIds.size === 0
          ? created
          : (() => {
              const byId = new Map(getNotes(db, [...mutatedIds]).map((n) => [n.id, n]));
              return created.map((n) => byId.get(n.id) ?? n);
            })();

      // Attach `validation_status` so HTTP create-note matches the MCP
      // surface (vault#287). `attachValidationStatus` returns the note
      // unchanged when no tag declares fields, so vaults without any tag
      // schemas see no behavior change.
      const final = refreshed.map((n) => attachValidationStatus(store, db, n));
      return json(body.notes ? final : final[0], 201);
    }

    return json({ error: "Method not allowed" }, 405);
  }

  // ---- Note-level routes (/notes/:idOrPath[/attachments]) ----
  const idMatch = subpath.match(/^\/([^/]+)(\/.*)?$/);
  if (!idMatch) return json({ error: "Not found" }, 404);

  const idOrPath = decodeURIComponent(idMatch[1]!);
  const sub = idMatch[2] ?? "";

  // Attachments sub-routes (keep as-is — Daily needs them)
  if (sub === "/attachments") {
    if (method === "POST") {
      const note = await resolveNote(store, idOrPath);
      if (!note) return json({ error: "Not found" }, 404);
      if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
        return json({ error: "Not found" }, 404);
      }
      const body = await req.json() as { path: string; mimeType: string; transcribe?: boolean };
      if (!body.path || !body.mimeType) return json({ error: "path and mimeType are required" }, 400);

      // Decide whether to enqueue this attachment for transcription. Two paths:
      //
      // - **Explicit caller opt-in (legacy path, Lens flow):** `transcribe: true`
      //   on the POST. The note already has a `_Transcript pending._` stub the
      //   worker replaces on success — `transcribe_origin: "legacy"` preserves
      //   the stub-patching behavior.
      // - **Auto-transcribe (vault#353):** mime-type is `audio/*` AND the
      //   operator has flipped `auto_transcribe.enabled = true` AND scribe is
      //   reachable. The caller didn't opt in explicitly; we infer from the
      //   audio mime-type. `transcribe_origin: "auto"` tells the worker to
      //   materialize a `<attachment-path>.transcript.md` note on completion.
      //
      // Explicit `transcribe: true` wins — if the caller asked, we honor that
      // regardless of the auto-transcribe toggle (back-compat).
      const explicitOptIn = body.transcribe === true;
      // Per-vault auto-transcribe: read THIS vault's `auto_transcribe.enabled`
      // (vault.yaml) and pass it as the precedence-winning toggle. A vault that
      // set its own value uses it; one that left it unset falls through to the
      // global toggle inside `shouldAutoTranscribe` (per-vault → global → true).
      const perVaultEnabled = vault
        ? readVaultConfig(vault)?.auto_transcribe?.enabled
        : undefined;
      const autoOptIn = !explicitOptIn && shouldAutoTranscribe(body.mimeType, { perVaultEnabled });
      const attMeta = (explicitOptIn || autoOptIn)
        ? {
            transcribe_status: "pending" as const,
            transcribe_requested_at: new Date().toISOString(),
            transcribe_origin: (explicitOptIn ? "legacy" : "auto") as "legacy" | "auto",
          }
        : undefined;

      const attachment = await store.addAttachment(note.id, body.path, body.mimeType, attMeta);

      if (explicitOptIn) {
        const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
        if (noteMeta.transcribe_stub !== true) {
          await store.updateNote(note.id, {
            metadata: { ...noteMeta, transcribe_stub: true },
            skipUpdatedAt: true,
          });
        }
      }

      return json(attachment, 201);
    }
    if (method === "GET") {
      const note = await resolveNote(store, idOrPath);
      if (!note) return json({ error: "Not found" }, 404);
      if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
        return json({ error: "Not found" }, 404);
      }
      return json(await store.getAttachments(note.id));
    }
    return json({ error: "Method not allowed" }, 405);
  }

  const attMatch = sub.match(/^\/attachments\/([^/]+)$/);
  if (attMatch) {
    const attId = decodeURIComponent(attMatch[1]!);
    if (method === "DELETE") {
      const note = await resolveNote(store, idOrPath);
      if (!note) return json({ error: "Not found" }, 404);
      if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
        return json({ error: "Not found" }, 404);
      }
      const result = await store.deleteAttachment(note.id, attId);
      if (!result.deleted) return json({ error: "Not found" }, 404);
      // Unlink the storage file only if no other attachment still references
      // the same path. Best-effort: the row is already gone, so a missing
      // file or unlink error should not flip the DELETE to an error.
      if (vault && result.path && result.orphaned) {
        const assets = assetsDir(vault);
        const filePath = normalize(join(assets, result.path));
        if (filePath.startsWith(normalize(assets)) && existsSync(filePath)) {
          try { unlinkSync(filePath); } catch {}
        }
      }
      return new Response(null, { status: 204 });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  // POST /notes/:idOrPath/retry-transcription — vault#353 design Q5 + finding F.
  //
  // Re-runs transcription against a failed audio attachment. Two target
  // shapes, dispatched in handleRetryTranscription by whether the note carries
  // `transcript_status` frontmatter:
  //   - Auto-flow (vault#353): target is a `<audio>.transcript.md` note with
  //     `transcript_status: "failed"`; audio located via
  //     `transcript_attachment_id`, origin preserved as "auto".
  //   - Legacy in-body memo (finding F): target is the memo note itself (no
  //     `transcript_status`); finds its own failed attachment, resets it
  //     preserving `transcribe_origin: "legacy"`, and re-arms `transcribe_stub`.
  //
  // Wire shape:
  //   POST .../notes/<idOrPath>/retry-transcription
  //   →  202 { attachment_id, attachment_path, transcript_note_id, worker }
  //      400 not_failed              (auto-flow: transcript already succeeded)
  //      400 missing_attachment_id   (auto-flow: transcript_attachment_id absent)
  //      400 no_failed_attachment    (legacy: no failed audio attachment to retry)
  //      404 attachment_missing      (auto-flow: transcript_attachment_id row deleted)
  //      404 audio_missing           (audio file unlinked from disk)
  if (sub === "/retry-transcription") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!vault) return json({ error: "Vault context required" }, 400);
    const note = await resolveNote(store, idOrPath);
    if (!note) return json({ error: "Not found" }, 404);
    if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
      return json({ error: "Not found" }, 404);
    }
    return handleRetryTranscription(store, note, vault);
  }

  if (sub !== "") return json({ error: "Not found" }, 404);

  // GET /notes/:idOrPath — single note
  if (method === "GET") {
    const note = await resolveNote(store, idOrPath);
    if (!note) return json({ error: "Not found" }, 404);
    if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
      return json({ error: "Not found" }, 404);
    }
    const includeContent = parseBool(parseQuery(url, "include_content"), true);
    const contentRange = parseContentRangeQuery(url, includeContent);
    if (contentRange.error) return contentRange.error;
    let result: any = includeContent ? { ...note } : toNoteIndex(note);
    const expand = parseExpandParams(url, db, tagScope);
    if (expand && includeContent && typeof result.content === "string") {
      expand.ctx.expanded.add(note.id);
      result.content = expandContent(result.content, expand.ctx, expand.depth);
    }
    // Content range applies to the FINAL returned content (post-expansion).
    if (contentRange.range && includeContent) applyContentRange(result, contentRange.range);
    result = filterMetadata(result, parseIncludeMetadata(url));
    if (parseBool(parseQuery(url, "include_links"), false)) {
      // Tag-scope: drop out-of-scope-neighbor links (no-op unscoped).
      result.links = filterHydratedLinksByTagScope(
        linkOps.getLinksHydrated(db, note.id),
        tagScope.allowed,
        tagScope.raw,
      );
    }
    if (parseBool(parseQuery(url, "include_attachments"), false)) {
      result.attachments = await store.getAttachments(note.id);
    }
    if (parseBool(parseQuery(url, "include_link_count"), false)) {
      result.linkCount = linkOps.getLinkCounts(db, [note.id], parseLinkCountDirection(url)).get(note.id) ?? 0;
    }
    return json(result);
  }

  // PATCH /notes/:idOrPath — update (content, path, metadata, tags, links)
  if (method === "PATCH") {
    try {
      // Body is parsed up front so the `if_missing: "create"` branch
      // (vault#309) can fire when the note doesn't exist. Pre-#309
      // shape parsed the body only after the not-found check.
      const body = await req.json() as any;
      const note = await resolveNote(store, idOrPath);
      if (!note) {
        // vault#309 — `if_missing: "create"` turns this PATCH into a
        // create using the same payload. POST /notes is the canonical
        // create surface, but supporting it inline on PATCH lets sync
        // loops use one endpoint for both branches. Returns the
        // created note with `created: true` and HTTP 200 (not 201 —
        // the response shape is "the note as it now exists," same
        // contract as the update path; `created: true` carries the
        // signal).
        if (body.if_missing === "create") {
          const idOrPathStr = idOrPath;
          // Tag-scope check on the create branch: the prospective
          // tag set must still satisfy scope. Compute from body.tags
          // (create-shape: an array, not the {add,remove} dict).
          const tagsArr = Array.isArray(body.tags)
            ? body.tags as string[]
            : Array.isArray(body.tags?.add) ? body.tags.add as string[] : [];
          if (tagScope.allowed && !tagsWithinScope(tagsArr, tagScope.allowed, tagScope.raw)) {
            return tagScopeForbidden(tagScope.raw ?? []);
          }
          const idLooksLikePath = idOrPathStr.includes("/") || !/^[A-Za-z0-9_-]+$/.test(idOrPathStr);
          const explicitPath = typeof body.path === "string" ? body.path as string : undefined;
          // Validate extension before reaching the Store (vault#328).
          const createExt = body.extension !== undefined
            ? validateExtension(body.extension)
            : undefined;
          const createOpts: Parameters<Store["createNote"]>[1] = {
            ...(idLooksLikePath ? { path: explicitPath ?? idOrPathStr } : { id: idOrPathStr, ...(explicitPath !== undefined ? { path: explicitPath } : {}) }),
            ...(tagsArr.length > 0 ? { tags: tagsArr } : {}),
            ...(body.metadata !== undefined ? { metadata: body.metadata as Record<string, unknown> } : {}),
            ...(body.created_at !== undefined ? { created_at: body.created_at as string } : {}),
            ...(body.createdAt !== undefined ? { created_at: body.createdAt as string } : {}),
            ...(createExt !== undefined ? { extension: createExt } : {}),
            // Write-attribution (vault#298) — REST upsert-create branch.
            actor: writeCtx.actor,
            via: writeCtx.via,
          };
          const content = (body.content as string | undefined) ?? "";
          // Strict-schema gate (vault#299) — if_missing:"create" is a create.
          gateStrictWrite(store, writeCtx, {
            path: createOpts.path ?? undefined,
            tags: createOpts.tags,
            metadata: createOpts.metadata,
          });
          const created = await store.createNote(content, createOpts);
          if (tagsArr.length > 0) {
            await applySchemaDefaults(store, db, [created.id], tagsArr);
          }
          // vault#321 F2 — apply `links.add` on the create branch.
          // MCP's create-on-missing branch already did this
          // (`core/src/mcp.ts` if_missing=create block); the REST side
          // was missing it, producing a cross-surface inconsistency
          // operators (Gitcoin's drift sync) would trip on. Mirror the
          // MCP recipe exactly:
          //   - `links.add` IS applied — drift sync can declare typed
          //     links at upsert time and have them materialize.
          //   - `links.remove` is ignored (nothing to remove on a
          //     fresh note).
          //   - Missing target notes skip silently (mirrors MCP).
          const linksAdd = (body.links as any)?.add as { target: string; relationship: string; metadata?: Record<string, unknown> }[] | undefined;
          if (linksAdd) {
            for (const link of linksAdd) {
              const target = await resolveNote(store, link.target);
              if (target) {
                await store.createLink(created.id, target.id, link.relationship, link.metadata);
              }
            }
          }
          const final = await store.getNote(created.id);
          if (!final) return json({ error: "Note disappeared" }, 500);
          const validated = attachValidationStatus(store, db, final);
          const includeContentResp = body.include_content !== false;
          if (includeContentResp) return json({ ...validated, created: true });
          const lean: any = toNoteIndex(validated);
          const vs = (validated as any).validation_status;
          if (vs !== undefined) lean.validation_status = vs;
          lean.created = true;
          return json(lean);
        }
        throw new NotFoundError(`Note not found: "${idOrPath}"`);
      }
      // Tag-scope: existing note must be in scope. Mirror the read-side
      // 404-not-403 stance — a token can't see (and therefore can't
      // discover-then-modify) notes outside its allowlist.
      if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
        throw new NotFoundError(`Note not found: "${idOrPath}"`);
      }
      // Tag-scope: post-update tag set must still satisfy scope. Compute
      // the prospective tag set (existing − removed + added) and reject
      // before any write if it would drift outside the allowlist. This
      // covers the bot-untags-its-only-allowlisted-tag escape route.
      if (tagScope.allowed) {
        const removed = new Set<string>((body.tags?.remove as string[] | undefined) ?? []);
        const projected = new Set<string>((note.tags ?? []).filter((t) => !removed.has(t)));
        for (const t of (body.tags?.add as string[] | undefined) ?? []) projected.add(t);
        if (!tagsWithinScope([...projected], tagScope.allowed, tagScope.raw)) {
          return tagScopeForbidden(tagScope.raw ?? []);
        }
      }

      // --- Validate mutual exclusion of content modes ---
      const hasContent = body.content !== undefined;
      const hasAppendPrepend = body.append !== undefined || body.prepend !== undefined;
      const hasContentEdit = body.content_edit !== undefined;
      const contentModes = (hasContent ? 1 : 0) + (hasAppendPrepend ? 1 : 0) + (hasContentEdit ? 1 : 0);
      if (contentModes > 1) {
        return json(
          {
            error: "mutually_exclusive",
            message: "`content`, `append`/`prepend`, and `content_edit` are mutually exclusive — pick one mode of content update.",
          },
          400,
        );
      }

      // --- Safety-by-default: refuse mutations without a precondition ---
      // Mirror the MCP tool: require `if_updated_at` unless the caller
      // explicitly sets `force: true`. 428 Precondition Required is the
      // RFC 6585 status for exactly this case.
      //
      // Append/prepend-only updates are exempt — SQL-atomic concatenation
      // is no-conflict-by-design. Tag/link mutations are *not* exempt
      // (#201): they're idempotent set-ops, but still represent a
      // non-content change the caller should observe before re-asserting.
      const isAppendOnly = hasAppendPrepend
        && !hasContent
        && !hasContentEdit
        && body.path === undefined
        && body.metadata === undefined
        && body.created_at === undefined
        && body.createdAt === undefined
        && body.tags === undefined
        && body.links === undefined;
      // A state_transition is itself a compare-and-set precondition (vault#299
      // Part B) — a transition-only PATCH needs no if_updated_at/force.
      const isTransitionOnly = body.state_transition !== undefined
        && !hasContent
        && !hasAppendPrepend
        && !hasContentEdit
        && body.path === undefined
        && body.metadata === undefined
        && body.created_at === undefined
        && body.createdAt === undefined
        && body.tags === undefined
        && body.links === undefined;
      if (!isAppendOnly && !isTransitionOnly && body.if_updated_at === undefined && body.force !== true) {
        return json(
          {
            error_type: "precondition_required",
            error: "precondition_required",
            message:
              "update requires `if_updated_at` (the note's last-seen updated_at) or `force: true`.",
            note_id: note.id,
            path: note.path ?? null,
          },
          428,
        );
      }

      // --- Resolve content_edit into a full content string ---
      let contentOverride = body.content as string | undefined;
      if (hasContentEdit) {
        const ce = body.content_edit as { old_text?: unknown; new_text?: unknown };
        if (typeof ce?.old_text !== "string" || typeof ce?.new_text !== "string") {
          return json(
            { error: "bad_request", message: "`content_edit` requires { old_text: string, new_text: string }." },
            400,
          );
        }
        const idx = note.content.indexOf(ce.old_text);
        if (idx < 0) {
          // 422 Unprocessable Entity, not 404: the note exists, the request is
          // syntactically valid, but the search string can't be applied to the
          // current content. Returning 404 implied "note doesn't exist" and
          // confused operators chasing a missing record (#202).
          return json(
            { error: "unprocessable_content", message: `content_edit: \`old_text\` not found in note "${note.id}". Re-read and retry.` },
            422,
          );
        }
        const second = note.content.indexOf(ce.old_text, idx + 1);
        if (second >= 0) {
          return json(
            { error: "ambiguous", message: `content_edit: \`old_text\` matches multiple times in note "${note.id}" — must match exactly once. Add surrounding context.` },
            409,
          );
        }
        contentOverride = note.content.slice(0, idx) + ce.new_text + note.content.slice(idx + ce.old_text.length);
      }

      // --- Plan bracket cleanup for wikilink removals (no DB writes yet) ---
      // The actual link deletions happen only after the core UPDATE succeeds,
      // so a conflict leaves the note untouched.
      const linksRemove = body.links?.remove as { target: string; relationship: string }[] | undefined;
      const resolvedLinksToRemove: { targetId: string; relationship: string }[] = [];
      if (linksRemove) {
        for (const link of linksRemove) {
          const target = await resolveNote(store, link.target);
          if (!target) continue;
          resolvedLinksToRemove.push({ targetId: target.id, relationship: link.relationship });
          if (link.relationship === "wikilink" && target.path) {
            // Materialize the prospective content for append/prepend callers
            // so we don't fight the SQL-atomic path with a JS-level rewrite.
            const current = contentOverride
              ?? (hasAppendPrepend
                ? (body.prepend as string ?? "") + note.content + (body.append as string ?? "")
                : note.content);
            const cleaned = removeWikilinkBrackets(current, target.path);
            if (cleaned !== current) contentOverride = cleaned;
          }
        }
      }

      // --- Core update (runs the if_updated_at check atomically) ---
      const updates: any = {};
      if (contentOverride !== undefined) {
        updates.content = contentOverride;
      } else if (hasAppendPrepend) {
        if (body.append !== undefined) updates.append = body.append;
        if (body.prepend !== undefined) updates.prepend = body.prepend;
      }
      if (body.path !== undefined) updates.path = body.path;
      if (body.extension !== undefined) {
        // Validate up front (vault#328). Throws ExtensionValidationError
        // which the outer catch converts to a 400.
        updates.extension = validateExtension(body.extension);
      }
      if (body.metadata !== undefined) {
        // RFC 7386 merge: incoming `null` removes the key (vault#478/#479).
        updates.metadata = mergeMetadata(
          note.metadata as Record<string, unknown> | null | undefined,
          body.metadata as Record<string, unknown>,
        );
      }
      if (body.created_at !== undefined || body.createdAt !== undefined) {
        updates.created_at = body.created_at ?? body.createdAt;
      }
      if (body.if_updated_at !== undefined) {
        updates.if_updated_at = body.if_updated_at;
      }
      // Compare-and-set state transition (vault#299 Part B). Combinable with
      // other field updates; folds into the same atomic UPDATE.
      const stBody = body.state_transition as { field?: unknown; from?: unknown; to?: unknown } | undefined;
      if (stBody !== undefined) {
        if (typeof stBody.field !== "string" || stBody.field.length === 0) {
          return json(
            { error: "bad_request", message: "`state_transition.field` must be a non-empty string." },
            400,
          );
        }
        updates.state_transition = { field: stBody.field, from: stBody.from, to: stBody.to };
      }

      // --- Strict-schema gate (vault#299 Part A) ---
      // Validate the PROSPECTIVE shape (final tags + merged metadata, incl. a
      // state_transition's `to`) before the write so a rejection leaves the
      // note untouched. Throws SchemaValidationError → 422 in the catch.
      {
        const removeSet = new Set<string>((body.tags?.remove as string[] | undefined) ?? []);
        const projectedTags = new Set<string>((note.tags ?? []).filter((t) => !removeSet.has(t)));
        for (const t of (body.tags?.add as string[] | undefined) ?? []) projectedTags.add(t);
        const baseMeta = updates.metadata ?? ((note.metadata as Record<string, unknown>) ?? {});
        const projectedMeta = stBody !== undefined
          ? { ...baseMeta, [stBody.field as string]: stBody.to }
          : baseMeta;
        gateStrictWrite(store, writeCtx, { path: note.path, tags: [...projectedTags], metadata: projectedMeta });
      }

      if (Object.keys(updates).length > 0) {
        // Write-attribution (vault#298) — REST update. Stamp the most-recent-
        // write columns on the same UPDATE that bumps updated_at.
        updates.actor = writeCtx.actor;
        updates.via = writeCtx.via;
        await store.updateNote(note.id, updates);
      }

      // --- Remove links (after core UPDATE; conflict would have thrown already) ---
      for (const { targetId, relationship } of resolvedLinksToRemove) {
        await store.deleteLink(note.id, targetId, relationship);
      }

      // Tags
      if (body.tags?.add?.length) {
        await store.tagNote(note.id, body.tags.add);
        await applySchemaDefaults(store, db, [note.id], body.tags.add);
      }
      if (body.tags?.remove?.length) {
        await store.untagNote(note.id, body.tags.remove);
      }

      // Add links
      if (body.links?.add) {
        for (const link of body.links.add as { target: string; relationship: string; metadata?: Record<string, unknown> }[]) {
          const target = await resolveNote(store, link.target);
          if (target) await store.createLink(note.id, target.id, link.relationship, link.metadata);
        }
      }

      // Response shape: full Note (back-compat default) or lean NoteIndex
      // (vault#285 friction point 2.response — opt-out for callers making
      // frequent small edits to large notes). Mirror the MCP `update-note`
      // `include_content` knob exactly, *and* `validation_status` attachment
      // (vault#287) so HTTP and MCP consumers see the same schema-validation
      // signal. Recipe matches `core/src/mcp.ts:751` — attach to the full
      // Note first, then carry the field across the lean conversion (since
      // `toNoteIndex` drops unknown fields).
      const updatedNote = await store.getNote(note.id);
      if (updatedNote === null) return json({ error: "Note disappeared" }, 404);
      const validated: any = attachValidationStatus(store, db, updatedNote);
      // Echo hydrated links when a link mutation was part of this request,
      // OR the caller explicitly asked for them via `?include_links=true`
      // (vault feedback #8). Previously the update response omitted links
      // entirely (`getNote` populates tags but not links), forcing callers
      // to re-GET with `?include_links=true` just to confirm a link they
      // had just added/removed. Additive field, scoped to UPDATE: present
      // only when mutated or requested. Mirrors the GET / query-notes
      // hydration call form exactly (`linkOps.getLinksHydrated`).
      const linkMutated = body.links?.add !== undefined || body.links?.remove !== undefined;
      const includeLinksResp = linkMutated || parseBool(parseQuery(url, "include_links"), false);
      if (includeLinksResp) {
        // Tag-scope: strip out-of-scope-neighbor links from the echoed set
        // (no-op unscoped). A write token tag-scoped to #work mustn't learn
        // about a #personal note it happened to link to.
        validated.links = filterHydratedLinksByTagScope(
          linkOps.getLinksHydrated(db, updatedNote.id),
          tagScope.allowed,
          tagScope.raw,
        );
      }
      const includeContentResp = body.include_content !== false;
      // `created: false` is appended to every update-path response so
      // sync-loop callers using `if_missing: "create"` can distinguish
      // the two branches without a separate query (vault#309). The
      // create-branch response above carries `created: true`.
      if (includeContentResp) return json({ ...validated, created: false });
      const lean: any = toNoteIndex(validated);
      const vs = (validated as any).validation_status;
      if (vs !== undefined) lean.validation_status = vs;
      // Carry the link echo across the lean conversion — `toNoteIndex`
      // drops unknown fields, same as the `validation_status` recipe above.
      if (validated.links !== undefined) lean.links = validated.links;
      lean.created = false;
      return json(lean);
    } catch (e: any) {
      if (e instanceof NotFoundError) return json({ error: e.message }, 404);
      // Duck-type on `code` rather than `instanceof ConflictError`: this
      // error originates in the core package and survives any future
      // bundling / module-boundary split more robustly than a prototype check.
      if (e && e.code === "CONFLICT") {
        return json(
          {
            // New structured shape — what agents should key on.
            error_type: "conflict",
            current_updated_at: e.current_updated_at ?? null,
            your_updated_at: e.expected_updated_at,
            path: e.note_path ?? null,
            note_id: e.note_id,
            message: e.message,
            // Legacy fields — kept for the lens VaultConflictError shim and
            // any other pre-launch callers. Safe to drop post-launch.
            error: "conflict",
            expected_updated_at: e.expected_updated_at,
          },
          409,
        );
      }
      // State-transition compare-and-set conflict (vault#299 Part B). A
      // DISTINCT error vocabulary from `conflict` (settled lead #3): the
      // field VALUE didn't match `from`, not the updated_at token. 409.
      if (e && e.code === "TRANSITION_CONFLICT") {
        return json(
          {
            error_type: "transition_conflict",
            error: "transition_conflict",
            note_id: e.note_id,
            path: e.note_path ?? null,
            field: e.field,
            expected_from: e.expected_from,
            to: e.to,
            current: e.current ?? null,
            message: e.message,
          },
          409,
        );
      }
      // Strict-schema rejection (vault#299 Part A). One error carrying ALL
      // per-field violations (settled lead #1). 422 Unprocessable Entity —
      // the note exists / request is well-formed but violates the contract.
      if (e && e.code === "SCHEMA_VALIDATION") {
        return json(
          {
            error_type: "schema_validation",
            error: "schema_validation",
            violations: e.violations ?? [],
            message: e.message,
          },
          422,
        );
      }
      // Path-rename collision — schema's UNIQUE(path) tripped. Issue #126.
      if (e && e.code === "PATH_CONFLICT") {
        return json(
          { error_type: "path_conflict", error: "path_conflict", path: e.path, message: e.message },
          409,
        );
      }
      if (e && e.code === "INVALID_EXTENSION") {
        return json(
          { error_type: "invalid_extension", error: "invalid_extension", extension: e.extension, reason: e.reason, message: e.message },
          400,
        );
      }
      throw e;
    }
  }

  // DELETE /notes/:idOrPath — vault:write (no admin gate; consistent with verbForMethod)
  if (method === "DELETE") {
    const note = await resolveNote(store, idOrPath);
    if (!note) return json({ error: "Not found" }, 404);
    // Tag-scope: can't delete what you can't read. 404 (not 403) for the
    // same no-leak reason as the read paths.
    if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
      return json({ error: "Not found" }, 404);
    }
    await store.deleteNote(note.id);
    return json({ deleted: true, id: note.id });
  }

  return json({ error: "Method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Tags — GET/PUT/DELETE /api/tags[/:name], POST /api/tags/merge,
//        POST /api/tags/:name/rename
// ---------------------------------------------------------------------------

export async function handleTags(
  req: Request,
  store: Store,
  subpath = "",
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
): Promise<Response> {
  const url = new URL(req.url);

  // GET /tags — list all, or get single tag detail
  if (req.method === "GET" && subpath === "") {
    const singleTag = parseQuery(url, "tag");

    if (singleTag) {
      // Tag-scope: a tag-scoped token can only see tags reachable from its
      // allowlist (root + descendants per the parent_names hierarchy).
      // Anything else 404s — same "no leak" stance as note reads.
      if (tagScope.allowed && !tagScope.allowed.has(singleTag)) {
        return json({ error: "Tag not found", tag: singleTag }, 404);
      }
      const allTags = await store.listTags();
      const found = allTags.find((t) => t.name === singleTag);
      const record = await store.getTagRecord(singleTag);
      return json({
        name: singleTag,
        count: found?.count ?? 0,
        description: record?.description ?? null,
        fields: record?.fields ?? null,
        relationships: record?.relationships ?? null,
        parent_names: record?.parent_names ?? null,
        created_at: record?.created_at ?? null,
        updated_at: record?.updated_at ?? null,
      });
    }

    const tags = await store.listTags();
    const filtered = tagScope.allowed
      ? tags.filter((t) => tagScope.allowed!.has(t.name))
      : tags;
    if (parseBool(parseQuery(url, "include_schema"), false)) {
      const records = new Map(
        (await store.listTagRecords()).map((r) => [r.tag, r] as const),
      );
      return json(filtered.map((t) => {
        const r = records.get(t.name);
        return {
          ...t,
          description: r?.description ?? null,
          fields: r?.fields ?? null,
          relationships: r?.relationships ?? null,
          parent_names: r?.parent_names ?? null,
          created_at: r?.created_at ?? null,
          updated_at: r?.updated_at ?? null,
        };
      }));
    }
    return json(filtered);
  }

  // POST /tags/merge — atomic multi-source merge into a target tag.
  // Must come before the /:name matcher so "merge" isn't read as a tag name.
  if (subpath === "/merge") {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = (await req.json().catch(() => null)) as
      | { sources?: unknown; target?: unknown }
      | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);
    const sources = body.sources;
    const target = body.target;
    if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string" && s.length > 0)) {
      return json({ error: "sources must be a non-empty array of strings" }, 400);
    }
    if (typeof target !== "string" || target.length === 0) {
      return json({ error: "target must be a non-empty string" }, 400);
    }
    // Tag-scope: every source AND the target must be inside the allowlist.
    // A merge that pulls notes out of a token's scope (or pushes notes into
    // it) is a privilege escalation; refuse the whole op.
    if (tagScope.allowed) {
      for (const t of [...sources, target]) {
        if (!tagScope.allowed.has(t)) {
          return tagScopeForbidden(tagScope.raw ?? []);
        }
      }
    }
    // Same dependency check as DELETE /tags/:name — merging consumes every
    // source tag, so a source referenced by a tag-scoped token would orphan
    // that token's allowlist. Aggregate matches across sources for a single
    // 409 envelope.
    const referenced: { source: string; tokens: { id: string; label: string }[] }[] = [];
    const db = store.db;
    for (const src of sources) {
      const tokens = findTokensReferencingTag(db, src as string);
      if (tokens.length > 0) referenced.push({ source: src as string, tokens });
    }
    if (referenced.length > 0) {
      return json(
        {
          error: "TagInUseByTokens",
          error_type: "tag_in_use_by_tokens",
          message: `Cannot merge: ${referenced.length} source tag(s) referenced by tag-scoped token(s); revoke or re-mint them first.`,
          referenced_by: referenced,
        },
        409,
      );
    }
    const result = await store.mergeTags(sources, target);
    return json(result);
  }

  // POST /tags/:name/rename — atomic rename across tags + note_tags + schema
  const renameMatch = subpath.match(/^\/([^/]+)\/rename$/);
  if (renameMatch) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const oldName = decodeURIComponent(renameMatch[1]!);
    const body = (await req.json().catch(() => null)) as { new_name?: unknown } | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);
    const newName = body.new_name;
    if (typeof newName !== "string" || newName.length === 0) {
      return json({ error: "new_name must be a non-empty string" }, 400);
    }
    if (tagScope.allowed && (!tagScope.allowed.has(oldName) || !tagScope.allowed.has(newName))) {
      return tagScopeForbidden(tagScope.raw ?? []);
    }
    // Vault#240: rename now cascades to tokens.scoped_tags (and every
    // other surface). The old fail-closed token-reference check has been
    // removed; the cascade rewrites the JSON allowlist atomically. See
    // notes.ts:renameTag for the surfaces touched.
    const result = await store.renameTag(oldName, newName);
    if ("error" in result) {
      if (result.error === "not_found") return json({ error: "not_found", tag: oldName }, 404);
      if (result.error === "target_exists") {
        return json(
          {
            error: "target_exists",
            target: newName,
            conflicting: result.conflicting,
            message: "Target tag (or one of its sub-tags) already exists; use POST /api/tags/merge to combine them.",
          },
          409,
        );
      }
    }
    return json(result);
  }

  // POST /tags/:name/conformance — count existing notes that would VIOLATE a
  // proposed field spec for the tag (vault#283 tightening warning). Read-only
  // (POST because it carries a proposed `fields` body). Must precede the
  // /:name matcher so "conformance" isn't read as a tag name.
  const conformanceMatch = subpath.match(/^\/([^/]+)\/conformance$/);
  if (conformanceMatch) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const cTag = decodeURIComponent(conformanceMatch[1]!);
    if (tagScope.allowed && !tagScope.allowed.has(cTag)) {
      return json({ error: "Tag not found", tag: cTag }, 404);
    }
    const body = (await req.json().catch(() => null)) as
      | { fields?: Record<string, unknown> | null }
      | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);
    // The proposed fields the operator intends to save. Sanitized through the
    // same parse the resolver uses (drop non-object specs). Empty/absent →
    // nothing to enforce → zero violations.
    const proposed: Record<string, tagSchemaOps.TagFieldSchema> = {};
    if (body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)) {
      for (const [k, v] of Object.entries(body.fields)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          proposed[k] = v as tagSchemaOps.TagFieldSchema;
        }
      }
    }
    const report = await store.countTagConformance(cTag, proposed);
    return json(report);
  }

  // GET /tags/:name/effective — the tag's effective (own ∪ inherited) fields +
  // direct/effective parents + schema-conflict info, drawn from the same
  // projection vault-info exposes. Read-only inheritance preview for the
  // Schema editor (vault#283). Must precede the /:name matcher.
  const effectiveMatch = subpath.match(/^\/([^/]+)\/effective$/);
  if (effectiveMatch) {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const eTag = decodeURIComponent(effectiveMatch[1]!);
    if (tagScope.allowed && !tagScope.allowed.has(eTag)) {
      return json({ error: "Tag not found", tag: eTag }, 404);
    }
    const projection = buildVaultProjection(store.db);
    const record = await store.getTagRecord(eTag);
    // Resolve inheritance directly (not via projection.tags, which omits
    // hierarchy-only tags carrying no own schema) so the editor's preview
    // works even for a tag the operator is just starting to give fields.
    const resolved = loadSchemaConfig(store.db);
    const { effective_parents, effective_fields } = resolveTagInheritance(resolved, eTag);
    return json({
      name: eTag,
      parents: record?.parent_names ?? [],
      effective_parents,
      fields: record?.fields ?? null,
      effective_fields,
      indexed_fields: projection.indexed_fields,
    });
  }

  // Routes with tag name
  const nameMatch = subpath.match(/^\/([^/]+)$/);
  if (!nameMatch) return json({ error: "Not found" }, 404);
  const tagName = decodeURIComponent(nameMatch[1]!);

  // GET /tags/:name — single tag detail (full record)
  if (req.method === "GET") {
    if (tagScope.allowed && !tagScope.allowed.has(tagName)) {
      return json({ error: "Tag not found", tag: tagName }, 404);
    }
    const allTags = await store.listTags();
    const found = allTags.find((t) => t.name === tagName);
    const record = await store.getTagRecord(tagName);
    return json({
      name: tagName,
      count: found?.count ?? 0,
      description: record?.description ?? null,
      fields: record?.fields ?? null,
      relationships: record?.relationships ?? null,
      parent_names: record?.parent_names ?? null,
      created_at: record?.created_at ?? null,
      updated_at: record?.updated_at ?? null,
    });
  }

  // PUT /tags/:name — upsert tag identity row. Body accepts any combination
  // of { description, fields, relationships, parent_names }; omitted keys
  // are preserved, explicit null clears. See patterns/tag-data-model.md.
  if (req.method === "PUT") {
    // Canonical-bare-tag guard (vault#XXX): normalize the upserted tag NAME so
    // the existing-field merge read (store.getTagSchema below) and the upsert
    // both target the bare row. store.upsertTagRecord re-normalizes (idempotent)
    // for the write; this keeps the partial-merge read correct for a
    // `#`-decorated PUT path. (GET/DELETE/rename keep their literal lookups —
    // rename's source-name must still match a `#`-prefixed legacy row so the
    // data migration can rename it away.)
    const putTagName = stripTagHash(tagName);
    if (tagScope.allowed && !tagScope.allowed.has(putTagName)) {
      return tagScopeForbidden(tagScope.raw ?? []);
    }
    const body = (await req.json()) as {
      description?: string | null;
      fields?: Record<string, unknown> | null;
      relationships?: Record<string, unknown> | null;
      parent_names?: unknown;
      /**
       * When true, `fields` is treated as the FULL intended field map for the
       * tag — fields absent from the payload are DROPPED (a replace, not a
       * merge). Default false preserves the historical partial-update merge
       * the MCP `update-tag` tool relies on (omitted keys preserved). The
       * Schema editor (vault#283) sends the full map + `replace_fields: true`
       * so removing a field row actually deletes the field. See
       * patterns/tag-data-model.md.
       */
      replace_fields?: unknown;
    };
    const replaceFields = body.replace_fields === true;

    // Validate the relationships payload up front so a bad payload returns
    // 400, not a thrown 500. `relationships` is an opaque vocabulary map
    // (relationship-name → arbitrary JSON the app interprets); we only check
    // that it's a JSON object (a map), then persist verbatim.
    let relationshipsPatch:
      | tagSchemaOps.TagRelationshipMap
      | null
      | undefined;
    if (body.relationships === null) {
      relationshipsPatch = null;
    } else if (body.relationships !== undefined) {
      try {
        relationshipsPatch = tagSchemaOps.validateRelationships(body.relationships);
      } catch (err) {
        return json(
          { error: (err as Error).message, error_type: "invalid_relationships" },
          400,
        );
      }
    }

    let parentNamesPatch: string[] | null | undefined;
    if (body.parent_names === null) {
      parentNamesPatch = null;
    } else if (body.parent_names !== undefined) {
      if (!Array.isArray(body.parent_names)) {
        return json({ error: "parent_names must be an array of tag names" }, 400);
      }
      const cleaned = (body.parent_names as unknown[]).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      parentNamesPatch = cleaned.length > 0 ? cleaned : null;
    }

    // Field merge mirrors MCP update-tag — preserves prior keys when the
    // payload only declares new ones. UNLESS `replace_fields: true`, in which
    // case `fields` is the full intended map and absent keys are dropped (the
    // Schema editor's full-replacement save — vault#283; without this a
    // removed field row is silently resurrected by the merge).
    let fieldsPatch:
      | Record<string, tagSchemaOps.TagFieldSchema>
      | null
      | undefined;
    if (body.fields === null) {
      fieldsPatch = null;
    } else if (body.fields !== undefined) {
      if (replaceFields) {
        const full = body.fields as Record<string, tagSchemaOps.TagFieldSchema>;
        fieldsPatch = Object.keys(full).length > 0 ? full : null;
      } else {
        const existing = await store.getTagSchema(putTagName);
        const merged: Record<string, tagSchemaOps.TagFieldSchema> = {
          ...(existing?.fields ?? {}),
          ...(body.fields as Record<string, tagSchemaOps.TagFieldSchema>),
        };
        fieldsPatch = Object.keys(merged).length > 0 ? merged : null;
      }
    }

    // A bad indexed-field name (or an unindexable type, or a cross-tag type
    // mismatch) is a CLIENT error — return 400, not the catch-all 500. The
    // store pre-validates and is transactional, so the schema is left
    // unchanged on failure (no orphan/lying index). vault#478.
    let result;
    try {
      result = await store.upsertTagRecord(putTagName, {
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(fieldsPatch !== undefined ? { fields: fieldsPatch } : {}),
        ...(relationshipsPatch !== undefined ? { relationships: relationshipsPatch } : {}),
        ...(parentNamesPatch !== undefined ? { parent_names: parentNamesPatch } : {}),
      });
    } catch (err) {
      if (err instanceof IndexedFieldError) {
        return json(
          { error: err.message, error_type: "invalid_indexed_field" },
          400,
        );
      }
      throw err;
    }
    return json(result);
  }

  // DELETE /tags/:name — delete tag + identity row + remove from all notes
  if (req.method === "DELETE") {
    if (tagScope.allowed && !tagScope.allowed.has(tagName)) {
      return tagScopeForbidden(tagScope.raw ?? []);
    }
    // Tag-scoped tokens reference root tags by name; deleting a referenced
    // tag would silently orphan the token's allowlist. Fail closed (409)
    // and name the offending tokens so the operator can revoke or re-mint
    // before retrying. patterns/tag-scoped-tokens.md §Dependencies.
    const referenced_by = findTokensReferencingTag(store.db, tagName);
    if (referenced_by.length > 0) {
      return json(
        {
          error: "TagInUseByTokens",
          error_type: "tag_in_use_by_tokens",
          message: `Tag "${tagName}" is referenced by ${referenced_by.length} tag-scoped token(s); revoke or re-mint them before deleting.`,
          tag: tagName,
          referenced_by,
        },
        409,
      );
    }
    return json(await store.deleteTag(tagName));
  }

  return json({ error: "Method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Find-path — GET /api/find-path?source=...&target=...
// ---------------------------------------------------------------------------

export async function handleFindPath(
  req: Request,
  store: Store,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const source = parseQuery(url, "source");
  const target = parseQuery(url, "target");
  if (!source || !target) return json({ error: "source and target parameters are required" }, 400);

  const db = store.db;
  try {
    const sourceNote = await resolveNote(store, source);
    if (!sourceNote) return json({ error: `Note not found: "${source}"` }, 404);
    if (!noteWithinTagScope(sourceNote, tagScope.allowed, tagScope.raw)) {
      return json({ error: `Note not found: "${source}"` }, 404);
    }
    const targetNote = await resolveNote(store, target);
    if (!targetNote) return json({ error: `Note not found: "${target}"` }, 404);
    if (!noteWithinTagScope(targetNote, tagScope.allowed, tagScope.raw)) {
      return json({ error: `Note not found: "${target}"` }, 404);
    }
    const maxDepth = Math.min(parseInt10(parseQuery(url, "max_depth")) ?? 5, 10);

    // Tag-scope on the *path* itself: every intermediate hop must also be
    // within scope. A reachable target via an out-of-scope hop is not a
    // permitted answer — surface as "no path" (null).
    const result = linkOps.findPath(db, sourceNote.id, targetNote.id, { max_depth: maxDepth });
    if (result && tagScope.allowed) {
      for (const id of result.path) {
        const hop = await store.getNote(id);
        if (!hop || !noteWithinTagScope(hop, tagScope.allowed, tagScope.raw)) {
          return json(null);
        }
      }
    }
    return json(result);
  } catch (e: any) {
    if (e instanceof NotFoundError) return json({ error: e.message }, 404);
    // vault#331 N1 — surface AmbiguousPathError from resolveNote as 409
    // mirroring the handleNotes path. Without this, an ambiguous source/
    // target path on /api/find-path bubbled to a server-level 500.
    const ambig = ambiguousPathResponse(e);
    if (ambig) return ambig;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Vault info — GET/PATCH /api/vault
// ---------------------------------------------------------------------------

type VaultConfigLike = {
  name: string;
  description?: string;
  audio_retention?: "keep" | "until_transcribed" | "never";
  auto_transcribe?: { enabled?: boolean };
};

const VALID_AUDIO_RETENTION = ["keep", "until_transcribed", "never"] as const;

/**
 * Resolve the effective auto-transcribe toggle for a vault's GET response, the
 * SAME resolution `shouldAutoTranscribe` uses at the decision point:
 * **per-vault → global → true**. A vault that set its own `auto_transcribe`
 * shows that; one that left it unset shows the server-wide default (itself
 * default-ON). This keeps the GET in lock-step with what the worker actually
 * does, with no field-name drift.
 */
function resolveAutoTranscribeEnabled(vaultConfig: VaultConfigLike): boolean {
  return (
    vaultConfig.auto_transcribe?.enabled
    ?? readGlobalConfig().auto_transcribe?.enabled
    ?? true
  );
}

function vaultResponse(vaultConfig: VaultConfigLike): Record<string, unknown> {
  return {
    name: vaultConfig.name,
    description: vaultConfig.description ?? null,
    config: {
      audio_retention: vaultConfig.audio_retention ?? "keep",
      auto_transcribe: {
        enabled: resolveAutoTranscribeEnabled(vaultConfig),
      },
    },
  };
}

export async function handleVault(
  req: Request,
  store: Store,
  vaultConfig: VaultConfigLike,
  persist?: () => void,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const result: Record<string, unknown> = vaultResponse(vaultConfig);
    if (parseBool(parseQuery(url, "include_stats"), false)) {
      result.stats = await store.getVaultStats();
    }
    return json(result);
  }

  if (req.method === "PATCH") {
    const body = await req.json() as {
      description?: string;
      config?: { audio_retention?: string; auto_transcribe?: { enabled?: unknown } };
    };
    let dirty = false;

    if (body.description !== undefined) {
      vaultConfig.description = body.description;
      dirty = true;
    }

    if (body.config?.audio_retention !== undefined) {
      const v = body.config.audio_retention;
      if (!VALID_AUDIO_RETENTION.includes(v as typeof VALID_AUDIO_RETENTION[number])) {
        return json(
          {
            error: "invalid_audio_retention",
            message: `audio_retention must be one of: ${VALID_AUDIO_RETENTION.join(", ")}`,
          },
          400,
        );
      }
      vaultConfig.audio_retention = v as typeof VALID_AUDIO_RETENTION[number];
      dirty = true;
    }

    // auto_transcribe.enabled — PER-VAULT toggle persisted to THIS vault's
    // vault.yaml (via `persist`, the same writeVaultConfig path as
    // description/audio_retention). Flipping it for vault X affects only X;
    // scribe's "link to vault X" PATCHes this and never touches other vaults.
    // The worker reads the same per-vault field (per-vault → global → true).
    // Validate the shape: when `auto_transcribe` is present it must carry a
    // boolean `enabled`.
    if (body.config?.auto_transcribe !== undefined) {
      const enabled = body.config.auto_transcribe?.enabled;
      if (typeof enabled !== "boolean") {
        return json(
          {
            error: "invalid_auto_transcribe",
            message: "auto_transcribe.enabled must be a boolean",
          },
          400,
        );
      }
      vaultConfig.auto_transcribe = { ...vaultConfig.auto_transcribe, enabled };
      dirty = true;
    }

    if (dirty && persist) persist();
    return json(vaultResponse(vaultConfig));
  }

  return json({ error: "Method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Unresolved wikilinks — REST-only (admin/maintenance)
// ---------------------------------------------------------------------------

export function handleUnresolvedWikilinks(
  req: Request,
  store: Store,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
): Response {
  const url = new URL(req.url);
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : 50;
  const db = store.db;
  const result = listUnresolvedWikilinks(db, limit);

  // Unscoped token → return as-is (unchanged behavior).
  if (tagScope.raw === null) return Response.json(result);

  // Tag-scope confidentiality (security review): each unresolved row carries
  // a `source_id` (+ `source_path`) plus the raw `target_path` wikilink
  // string. For a tag-scoped token, surface ONLY rows whose SOURCE note is
  // within the token's tag scope — otherwise we'd leak out-of-scope note IDs
  // and the wikilink target strings those notes contain. Filter the page and
  // recompute `count` from the filtered set so the aggregate total of
  // out-of-scope rows doesn't leak either.
  const filtered = result.unresolved.filter((row) => {
    const note = getNote(db, row.source_id);
    return note !== null && noteWithinTagScope(note, tagScope.allowed, tagScope.raw);
  });
  return Response.json({ unresolved: filtered, count: filtered.length });
}

// ---------------------------------------------------------------------------
// Published notes — public, no-auth HTML rendering
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        out.push("</code></pre>");
        inCodeBlock = false;
      } else {
        out.push("<pre><code>");
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      out.push(escapeHtml(line));
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed) {
      out.push("");
      continue;
    }

    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1]!.length;
      out.push(`<h${level}>${inlineMarkdown(escapeHtml(headerMatch[2]!))}</h${level}>`);
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const items: string[] = [trimmed.slice(2)];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!.trim();
        if (next.startsWith("- ") || next.startsWith("* ")) {
          items.push(next.slice(2));
          i++;
        } else break;
      }
      out.push("<ul>");
      for (const item of items) {
        out.push(`<li>${inlineMarkdown(escapeHtml(item))}</li>`);
      }
      out.push("</ul>");
      continue;
    }

    out.push(`<p>${inlineMarkdown(escapeHtml(trimmed))}</p>`);
  }

  if (inCodeBlock) out.push("</code></pre>");
  return out.join("\n");
}

function inlineMarkdown(html: string): string {
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, (_match, text, url) => {
    const decoded = url.replace(/&amp;/g, "&");
    if (/^(https?:|mailto:|#|\/)/i.test(decoded)) {
      return `<a href="${url}">${text}</a>`;
    }
    return text;
  });
  return html;
}

function isNotePublished(note: { tags?: string[]; metadata?: unknown }, publishedTag: string = "publish"): boolean {
  if (note.tags?.includes(publishedTag)) return true;
  const meta = note.metadata as Record<string, unknown> | undefined;
  if (meta?.published === true) return true;
  return false;
}

/**
 * GET /view/:idOrPath — serve a note as clean HTML.
 * Supports ID or path resolution.
 */
export async function handleViewNote(
  store: Store,
  idOrPath: string,
  options: { authenticated?: boolean; publishedTag?: string } = {},
): Promise<Response> {
  const { authenticated = false, publishedTag = "publish" } = options;
  let note: Note | null;
  try {
    note = await resolveNote(store, idOrPath);
  } catch (e: any) {
    // vault#331 N1 — surface AmbiguousPathError as 409. The HTML view
    // route doesn't otherwise return JSON, but the structured body is
    // the right shape for the API contract; a human reader hitting
    // this URL gets the JSON inline (rare — the bare path form is
    // mostly an API consumer's mistake).
    const ambig = ambiguousPathResponse(e);
    if (ambig) return ambig;
    throw e;
  }
  if (!note) {
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  if (!authenticated && !isNotePublished(note, publishedTag)) {
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const title = note.path?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? note.id;
  const rendered = renderMarkdown(note.content);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body {
    max-width: 42rem;
    margin: 2rem auto;
    padding: 0 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
  }
  pre {
    background: #f5f5f5;
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
  }
  code {
    font-size: 0.9em;
    background: #f5f5f5;
    padding: 0.15em 0.3em;
    border-radius: 3px;
  }
  pre code {
    background: none;
    padding: 0;
  }
  a { color: #0066cc; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
  ul { padding-left: 1.5em; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e0e0e0; }
    pre, code { background: #2a2a2a; }
    a { color: #66b3ff; }
  }
</style>
</head>
<body>
${rendered}
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

// ---------------------------------------------------------------------------
// Retry transcription (vault#353 design Q5)
// ---------------------------------------------------------------------------

/**
 * Re-enqueue the original audio attachment for a failed transcription.
 *
 * Two target shapes are accepted:
 *
 *   - **Auto-flow (vault#353):** the target is a `<audio>.transcript.md` note
 *     carrying `transcript_status` frontmatter. Requires that status be
 *     `failed`; locates the audio via `transcript_attachment_id`; preserves
 *     `transcribe_origin: "auto"` so a retried success overwrites this
 *     transcript note in place. Behavior is byte-identical to the original
 *     vault#353 contract.
 *
 *   - **Legacy in-body memo (finding F):** the target is the memo note
 *     itself — no `transcript_status` frontmatter. The original capture body
 *     holds `![[<audio>]]` + a `_Transcription unavailable._` marker (written
 *     by the worker on terminal failure). We find the note's own failed audio
 *     attachment, reset it to pending **preserving `transcribe_origin:
 *     "legacy"`** (forcing "auto" would switch to the sibling-transcript-note
 *     shape and orphan the in-body embed), and **re-stamp `transcribe_stub:
 *     true`** on the note. The stub re-arm is load-bearing: the legacy success
 *     path early-returns unless `transcribe_stub === true`, so without it the
 *     retried success would never write the transcript back into the body.
 *     On success the worker replaces the `_Transcription unavailable._` marker
 *     with the transcript in place, yielding the same final shape a first-try
 *     success would.
 *
 * Common steps for both: validate the audio attachment row exists (404 if
 * gone) and its file is still on disk (404 if unlinked — e.g. retention=never
 * already dropped it), reset the transcribe_status fields, then kick the
 * worker if registered (otherwise the sweep picks it up).
 */
async function handleRetryTranscription(
  store: Store,
  note: Note,
  vault: string,
): Promise<Response> {
  const meta = (note.metadata as Record<string, unknown> | undefined) ?? {};

  // Legacy in-body memo: no `transcript_status` frontmatter. The note owns
  // the failed audio attachment directly; there's no sibling transcript note.
  if (typeof meta.transcript_status !== "string") {
    return handleRetryLegacyInBody(store, note, vault);
  }

  if (meta.transcript_status !== "failed") {
    return json(
      {
        error: "not_failed",
        message: `Transcript note status is "${meta.transcript_status}" — only failed transcripts can be retried.`,
        transcript_status: meta.transcript_status,
      },
      400,
    );
  }
  const attachmentId = typeof meta.transcript_attachment_id === "string"
    ? meta.transcript_attachment_id
    : undefined;
  if (!attachmentId) {
    return json(
      {
        error: "missing_attachment_id",
        message: "Transcript note has no `transcript_attachment_id` — can't locate the original audio.",
      },
      400,
    );
  }
  const attachment = await store.getAttachment(attachmentId);
  if (!attachment) {
    return json(
      {
        error: "attachment_missing",
        message: `Original audio attachment ${attachmentId} no longer exists in the vault.`,
      },
      404,
    );
  }
  // Audio file existence + safety: defense-in-depth against a bad attachment
  // row pointing outside the vault assets dir. Same guard as the worker.
  const assetsRoot = assetsDir(vault);
  const audioFilePath = normalize(join(assetsRoot, attachment.path));
  if (!audioFilePath.startsWith(normalize(assetsRoot)) || !existsSync(audioFilePath)) {
    return json(
      {
        error: "audio_missing",
        message: `Original audio file at "${attachment.path}" no longer exists on disk.`,
      },
      404,
    );
  }

  // Reset transcribe_status. Worker reads this row, sees "pending", processes
  // it. Preserve `transcribe_origin: "auto"` so the worker materializes the
  // transcript note (overwriting this failed note in place).
  const attMeta = { ...(attachment.metadata ?? {}) } as Record<string, unknown>;
  attMeta.transcribe_status = "pending";
  attMeta.transcribe_requested_at = new Date().toISOString();
  attMeta.transcribe_origin = "auto";
  delete attMeta.transcribe_backoff_until;
  delete attMeta.transcribe_error;
  delete attMeta.transcribe_error_code;
  delete attMeta.transcribe_attempts;
  await store.setAttachmentMetadata(attachment.id, attMeta);

  // Kick the worker for an event-driven re-run (no 30s sweep wait). The
  // worker re-reads the row + processes immediately. If the worker isn't
  // registered (scribe not configured this boot), we still reset the row;
  // the next boot's sweep will pick it up. The 503 path is for callers that
  // want certainty — but for v0.6 the sweep guarantee is enough.
  const { getTranscriptionWorker } = await import("./transcription-registry.ts");
  const worker = getTranscriptionWorker();
  if (worker) {
    // Refresh the attachment after the metadata write so the worker's
    // in-process dedupe check sees pending.
    const fresh = await store.getAttachment(attachment.id) ?? attachment;
    // Fire-and-forget — the response shouldn't wait on transcription.
    void worker.kick(vault, fresh);
  }

  return json(
    {
      status: "queued",
      attachment_id: attachment.id,
      attachment_path: attachment.path,
      transcript_note_id: note.id,
      worker: worker ? "kicked" : "sweep-only",
    },
    202,
  );
}

/**
 * Retry path for a legacy in-body voice memo (finding F). The target note is
 * the memo itself (no `transcript_status` frontmatter); it directly owns the
 * audio attachment whose transcription failed.
 *
 * Steps:
 *   1. Find the note's own audio attachment with `transcribe_status ===
 *      "failed"`. 400 `no_failed_attachment` if none — there's nothing to
 *      retry.
 *   2. Validate the audio file is still on disk (404 `audio_missing`).
 *   3. Reset the attachment to pending, **preserving `transcribe_origin:
 *      "legacy"`** (never force "auto" — that switches to the sibling-
 *      transcript-note shape and orphans the in-body `![[memo]]` embed).
 *   4. **Re-stamp `transcribe_stub: true`** on the note. The legacy worker
 *      success path early-returns unless the note carries this flag (it was
 *      cleared when the failure marker was written), so re-arming it is what
 *      lets the retried success replace the `_Transcription unavailable._`
 *      marker with the transcript.
 *   5. Kick the worker if registered; otherwise the sweep picks it up.
 */
async function handleRetryLegacyInBody(
  store: Store,
  note: Note,
  vault: string,
): Promise<Response> {
  const attachments = await store.getAttachments(note.id);
  const failed = attachments.find((a) => {
    const m = (a.metadata as Record<string, unknown> | undefined) ?? {};
    return m.transcribe_status === "failed";
  });
  if (!failed) {
    return json(
      {
        error: "no_failed_attachment",
        message:
          "Target note is not a transcript note and has no audio attachment with a failed transcription to retry.",
      },
      400,
    );
  }

  // Audio file existence + safety: defense-in-depth against a bad attachment
  // row pointing outside the vault assets dir. Same guard as the worker.
  const assetsRoot = assetsDir(vault);
  const audioFilePath = normalize(join(assetsRoot, failed.path));
  if (!audioFilePath.startsWith(normalize(assetsRoot)) || !existsSync(audioFilePath)) {
    return json(
      {
        error: "audio_missing",
        message: `Original audio file at "${failed.path}" no longer exists on disk.`,
      },
      404,
    );
  }

  // Reset the attachment back to pending. Preserve `transcribe_origin:
  // "legacy"` (a default of `undefined` is also legacy, but make it explicit
  // so a retried row reads unambiguously) — forcing "auto" here would make
  // the worker materialize a sibling transcript note instead of patching the
  // in-body embed, orphaning the memo.
  const attMeta = { ...(failed.metadata ?? {}) } as Record<string, unknown>;
  attMeta.transcribe_status = "pending";
  attMeta.transcribe_requested_at = new Date().toISOString();
  attMeta.transcribe_origin = "legacy";
  delete attMeta.transcribe_backoff_until;
  delete attMeta.transcribe_error;
  delete attMeta.transcribe_error_code;
  delete attMeta.transcribe_attempts;
  await store.setAttachmentMetadata(failed.id, attMeta);

  // Re-arm the stub on the note. The worker's legacy success path gates on
  // `transcribe_stub === true` and CLEARED it when it wrote the failure
  // marker; without re-stamping it the retried success early-returns and
  // never writes the transcript back into the body. Use skipUpdatedAt so the
  // note's modification time still reflects user intent, matching the
  // worker's own note writes.
  //
  // OC-guarded (vault#435): this read-transform-write would otherwise clobber
  // a user edit landing between `resolveNote` (above) and this write. Thread
  // `if_updated_at` and retry once on conflict — re-read, re-apply the
  // metadata-only re-stamp against the fresh note, write with the fresh
  // precondition. A second conflict surfaces as 409 so the user can retry.
  // Only the `transcribe_stub` flag is stamped (never content), so re-applying
  // against the fresh note is always the correct surgical transform.
  const restampStub = (current: Note): Record<string, unknown> => ({
    ...((current.metadata as Record<string, unknown> | undefined) ?? {}),
    transcribe_stub: true,
  });
  try {
    try {
      await store.updateNote(note.id, {
        metadata: restampStub(note),
        skipUpdatedAt: true,
        if_updated_at: note.updatedAt,
      });
    } catch (err: any) {
      if (!err || err.code !== "CONFLICT") throw err;
      // Conflict — re-read, re-apply the stub re-stamp, retry once.
      const fresh = await store.getNote(note.id);
      if (!fresh) {
        return json(
          { error: "note_missing", message: "Target note disappeared during retry." },
          404,
        );
      }
      await store.updateNote(fresh.id, {
        metadata: restampStub(fresh),
        skipUpdatedAt: true,
        if_updated_at: fresh.updatedAt,
      });
    }
  } catch (err: any) {
    if (err && err.code === "CONFLICT") {
      // Double conflict — the note kept changing under us. It's a user-facing
      // request; return 409 so the caller can retry against fresh state. The
      // attachment was already reset to pending above; a successful re-stamp
      // on the user's next retry (or the next sweep, if they re-arm the stub)
      // will let the worker patch the transcript in.
      return json(
        {
          error_type: "conflict",
          error: "conflict",
          note_id: note.id,
          current_updated_at: err.current_updated_at ?? null,
          your_updated_at: err.expected_updated_at,
          // Mirror the standard PATCH 409 shape (see the notes-update handler
          // above) — both `your_updated_at` and `expected_updated_at` carry the
          // same value, kept for shape-congruence with existing callers.
          expected_updated_at: err.expected_updated_at,
          message:
            "Note was modified concurrently while arming the retry; re-fetch and try again.",
        },
        409,
      );
    }
    throw err;
  }

  const { getTranscriptionWorker } = await import("./transcription-registry.ts");
  const worker = getTranscriptionWorker();
  if (worker) {
    const fresh = await store.getAttachment(failed.id) ?? failed;
    void worker.kick(vault, fresh);
  }

  return json(
    {
      status: "queued",
      attachment_id: failed.id,
      attachment_path: failed.path,
      transcript_note_id: note.id,
      worker: worker ? "kicked" : "sweep-only",
    },
    202,
  );
}

// ---------------------------------------------------------------------------
// Storage (file upload/serve) — kept as-is, Daily needs it
//
// `assetsDir` moved to config.ts (next to the other path helpers) to break the
// usage.ts↔routes.ts import cycle; it's re-exported from this module's top so
// existing importers are unaffected.
// ---------------------------------------------------------------------------

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

// Storage upload policy: DENY-LIST (vault#517). A knowledge vault stores
// arbitrary files — ebooks, office docs, datasets, archives, binaries — so we
// accept ANY upload EXCEPT the handful of types a browser can execute as
// active content in our origin when served back from /storage/. (The prior
// allowlist rejected the long tail: .epub/.csv/.zip/… all came back "File type
// not allowed".)
//
// BLOCKED — same-origin-XSS / active-content set:
//   .html/.htm/.xhtml/.shtml/.xht  HTML — embeds <script>
//   .svg                           XML image — embeds <script>
//   .xml                           can carry XSLT / be parsed as XHTML
//   .js/.mjs/.cjs                  JavaScript
//   .css                           style-injection / UI-redress vector
//
// Two independent guards keep every STORED file inert when served:
//   1. Only the curated MIME_TYPES below map to a real (always passive) type;
//      every other extension serves as application/octet-stream — a download,
//      never rendered.
//   2. The GET byte-serve response pins `X-Content-Type-Options: nosniff`, so
//      a browser can't sniff an octet-stream body into an executable type.
// The blocklist is belt-and-suspenders on top of those: even if a future MIME
// entry or an upstream proxy weakened (1) or (2), these extensions still never
// land on disk. If a future use case needs SVG, sanitize on read (strip
// <script>/<foreignObject>) and revisit.
const BLOCKED_EXTENSIONS = new Set([
  ".html", ".htm", ".xhtml", ".shtml", ".xht",
  ".svg",
  ".xml",
  ".js", ".mjs", ".cjs",
  ".css",
]);

// Explicit MIME types for the commonly-previewed formats. Anything accepted
// but absent here serves as application/octet-stream — a download, never
// rendered (e.g. .pages/.key/.numbers/.azw3/.exe/arbitrary binaries). None of
// these map to an active type (text/html, image/svg+xml), so a served asset
// can't execute script; `nosniff` on the GET response makes that ironclad.
//
// INVARIANT: never add an entry that maps to a browser-active type —
// text/html, image/svg+xml, application/xhtml+xml, text/javascript,
// application/wasm, text/css. Doing so re-enables same-origin execution for
// that extension (and would mean it must also join BLOCKED_EXTENSIONS).
const MIME_TYPES: Record<string, string> = {
  // Audio
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  // Image
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  // Video
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  // Documents / ebooks / data
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".mobi": "application/x-mobipocket-ebook",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".rtf": "application/rtf",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".zip": "application/zip",
};

export async function handleStorage(
  req: Request,
  path: string,
  vault: string,
  store: Store,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
): Promise<Response> {
  const assets = assetsDir(vault);

  if (req.method === "POST" && path === "/upload") {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return json({ error: "file is required" }, 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return json({ error: `File too large (${Math.round(file.size / 1024 / 1024)}MB). Max: 100MB` }, 413);
    }
    // Strip trailing dots/whitespace before extracting the extension so a
    // `evil.html.` / `evil.svg ` can't slip past the blocklist
    // (extname("evil.html.") === "."). The blocklist is belt-and-suspenders;
    // anything that still gets through serves as octet-stream + nosniff anyway.
    const ext = extname(file.name.replace(/[.\s]+$/, "")).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      // Active-content types only — blocked because they execute as script when
      // served same-origin from /storage/ (see BLOCKED_EXTENSIONS). Everything
      // else (incl. unknown/arbitrary files) is accepted and served as a
      // download (octet-stream + nosniff).
      return json({ error: `File type ${ext} not allowed (active/executable content)` }, 400);
    }

    const date = new Date().toISOString().split("T")[0]!;
    const dir = join(assets, date);
    mkdirSync(dir, { recursive: true });

    const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`;
    const filePath = join(dir, filename);
    const buffer = Buffer.from(await file.arrayBuffer());
    writeFileSync(filePath, buffer);

    const relativePath = `${date}/${filename}`;
    const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

    // Invalidate the usage dir-walk cache for this vault — the new attachment
    // changed the assets-directory footprint, so the next /.parachute/usage
    // read must re-walk rather than report a stale (smaller) number. Without
    // this hook the cache's 60s TTL would briefly under-report after an
    // upload. (usage.ts:invalidateUsageCache is a no-op-cheap map delete.)
    invalidateUsageCache(vault);

    return json({ path: relativePath, size: buffer.length, mimeType }, 201);
  }

  // Decode percent-encoding BEFORE matching. `path` arrives from
  // `url.pathname`, which (per WHATWG) keeps an encoded `%2F` slash literal —
  // so a caller requesting `/api/storage/<date>%2F<file>` would never satisfy
  // the literal-slash match below and would fall through to the 404. Decoding
  // first accepts both the literal-slash and `%2F`-encoded forms, and yields
  // the literal-slash path that the DB stores (`${date}/${filename}`) so the
  // tag-scope reverse-lookup matches. This intentionally diverges from the
  // single-note routes, which decode their *first* segment only and therefore
  // REQUIRE `%2F` for slashes-in-an-id — a trap-grade asymmetry we accept here
  // because storage paths are always multi-segment date/file pairs.
  //
  // Guard-safety (verified): the traversal guard below operates on the
  // post-`normalize(join())` filesystem path, so a decoded `..` is still
  // caught → 403. Decode is idempotent for today's unencoded callers
  // (filenames are `<Date.now()>-<uuid>.<ext>` — no stray `%`). A malformed
  // `%` (e.g. `2026%2`) throws → 404, consistent with the no-existence-oracle
  // stance (and an improvement over the prior catch-all 500).
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return json({ error: "Not found" }, 404);
  }

  const fileMatch = decodedPath.match(/^\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && fileMatch) {
    const reqPath = `${fileMatch[1]}/${fileMatch[2]}`;
    const filePath = normalize(join(assets, reqPath));

    if (!filePath.startsWith(normalize(assets))) {
      return json({ error: "Invalid path" }, 403);
    }
    if (!existsSync(filePath)) {
      return json({ error: "Not found" }, 404);
    }

    // Tag-scope gate (C0 adversarial-audit finding). The note-keyed
    // attachment surfaces (GET /notes/:id?include_attachments, GET
    // /notes/:id/attachments, query results) are all gated behind
    // `noteWithinTagScope`, but this raw byte-serve endpoint historically
    // shipped bytes purely by filesystem path with only a path-traversal
    // guard — so a tag-scoped token (scoped to e.g. ["work"]) could fetch
    // an out-of-scope note's attachment bytes directly if it learned the
    // storage path. Path secrecy (the 122-bit UUID in the filename) is NOT
    // an access control. When the token is tag-scoped, reverse-lookup the
    // requested path → owning attachment row(s) → note_id, and serve only
    // if at least one owning note is within scope. Unscoped tokens
    // (tagScope.raw === null) keep the prior behavior verbatim.
    //
    // 404 (not 403) on out-of-scope / no-owning-row, matching the
    // note-level surfaces — don't create an existence oracle that confirms
    // "this path exists but you can't see it."
    if (tagScope.raw !== null) {
      const rows = await store.getAttachmentsByPath(reqPath);
      let allowed = false;
      for (const att of rows) {
        const note = await store.getNote(att.noteId);
        if (note && noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        return json({ error: "Not found" }, 404);
      }
    }

    const stat = statSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const fileBuffer = readFileSync(filePath);

    return new Response(fileBuffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        // Defense-in-depth: never let a browser MIME-sniff a stored asset into
        // an active type (e.g. an octet-stream body sniffed as text/html).
        // Combined with the upload blocklist (no .svg/.html) this closes the
        // same-origin XSS surface for served attachments. Mirrors routing.ts's
        // SPA-asset stance.
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Tag schema defaults — same logic as core/src/mcp.ts applySchemaDefaults
// ---------------------------------------------------------------------------

// Returns the IDs of notes whose metadata was actually default-filled, so
// the caller can re-read ONLY the mutated notes (and skip the re-read when
// nothing changed). Mirrors the core/src/mcp.ts contract.
async function applySchemaDefaults(store: Store, db: any, noteIds: string[], tags: string[]): Promise<string[]> {
  const schemas = tagSchemaOps.getTagSchemaMap(db);
  if (Object.keys(schemas).length === 0) return [];

  const defaults: Record<string, unknown> = {};
  for (const tag of tags) {
    const schema = schemas[tag];
    if (!schema?.fields) continue;
    for (const [field, fieldSchema] of Object.entries(schema.fields)) {
      if (!(field in defaults)) {
        defaults[field] = defaultForField(fieldSchema);
      }
    }
  }
  if (Object.keys(defaults).length === 0) return [];

  const mutated: string[] = [];
  for (const noteId of noteIds) {
    const note = await store.getNote(noteId);
    if (!note) continue;
    const existing = (note.metadata as Record<string, unknown>) ?? {};
    const missing: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(defaults)) {
      if (!(field in existing)) missing[field] = value;
    }
    if (Object.keys(missing).length === 0) continue;
    await store.updateNote(noteId, {
      metadata: { ...existing, ...missing },
      skipUpdatedAt: true,
    });
    mutated.push(noteId);
  }
  return mutated;
}

function defaultForField(field: { type: string; enum?: string[] }): unknown {
  if (field.enum && field.enum.length > 0) return field.enum[0];
  switch (field.type) {
    case "boolean": return false;
    case "integer": return 0;
    default: return "";
  }
}

function removeWikilinkBrackets(content: string, targetPath: string): string {
  const escaped = targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  content = content.replace(new RegExp(`\\[\\[${escaped}\\|([^\\]]+)\\]\\]`, "gi"), "$1");
  content = content.replace(new RegExp(`\\[\\[${escaped}(#[^\\]]+)?\\]\\]`, "gi"), `${targetPath}$1`);
  return content;
}
