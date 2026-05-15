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

import type { Store, Note } from "../core/src/types.ts";
import { listUnresolvedWikilinks } from "../core/src/wikilinks.ts";
import { toNoteIndex, filterMetadata, MAX_BATCH_SIZE } from "../core/src/notes.ts";
import { attachValidationStatus } from "../core/src/mcp.ts";
import * as linkOps from "../core/src/links.ts";
import * as tagSchemaOps from "../core/src/tag-schemas.ts";
import {
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
import {
  expandContent,
  DEFAULT_EXPAND_DEPTH,
  MAX_EXPAND_DEPTH,
  type ExpandContext,
  type ExpandMode,
} from "../core/src/expand.ts";
import { join, extname, normalize } from "path";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { vaultDir } from "./config.ts";

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

function parseQueryList(url: URL, key: string): string[] | undefined {
  const val = url.searchParams.get(key);
  return val ? val.split(",") : undefined;
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
              error: `bracket-date filter on \`${field}\` supports only \`gte\` (inclusive lower bound) and \`lt\` (exclusive upper bound). Got: \`${op}\`. The dateFilter contract uses these two ops because the equivalent flat shape (\`date_field=${field}&date_from=…&date_to=…\`) is half-open by design.`,
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
 */
function parseExpandParams(
  url: URL,
  db: any,
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
  return { ctx: { db, mode, expanded: new Set() }, depth };
}


/**
 * Resolve a note by ID or path. Tries ID first, then case-insensitive path.
 */
async function resolveNote(store: Store, idOrPath: string): Promise<Note | null> {
  const byId = await store.getNote(idOrPath);
  if (byId) return byId;
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

export async function handleNotes(
  req: Request,
  store: Store,
  subpath: string,
  vault?: string,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const db = (store as any).db;

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
        let result: any = includeContent ? { ...note } : toNoteIndex(note);
        const expand = parseExpandParams(url, db);
        if (expand && includeContent && typeof result.content === "string") {
          expand.ctx.expanded.add(note.id);
          result.content = expandContent(result.content, expand.ctx, expand.depth);
        }
        result = filterMetadata(result, parseIncludeMetadata(url));
        if (parseBool(parseQuery(url, "include_links"), false)) {
          result.links = linkOps.getLinksHydrated(db, note.id);
        }
        if (parseBool(parseQuery(url, "include_attachments"), false)) {
          result.attachments = await store.getAttachments(note.id);
        }
        return json(result);
      }

      // Full-text search
      if (search) {
        const searchTags = parseQueryList(url, "tag");
        const limit = parseInt10(parseQuery(url, "limit")) ?? 50;
        const rawResults = await store.searchNotes(search, { tags: searchTags, limit });
        // Tag-scope: drop any result the token isn't permitted to see. Filter
        // happens after the store query so an empty post-filter list still
        // returns 200 [] (consistent with "no matches"), not 403.
        const results = filterNotesByTagScope(rawResults, tagScope.allowed, tagScope.raw);
        const includeContent = parseBool(parseQuery(url, "include_content"), false);
        const inclMeta = parseIncludeMetadata(url);
        let output: any[] = includeContent ? results.map((n) => ({ ...n })) : results.map(toNoteIndex);
        const expand = parseExpandParams(url, db);
        if (expand && includeContent) {
          for (const n of output) expand.ctx.expanded.add(n.id);
          for (const n of output) {
            if (typeof n.content === "string") {
              n.content = expandContent(n.content, expand.ctx, expand.depth);
            }
          }
        }
        if (inclMeta !== undefined && inclMeta !== true) {
          output = output.map((n: any) => filterMetadata(n, inclMeta));
        }
        return json(output);
      }

      // Structured query
      //
      // Two filter syntaxes coexist on this endpoint:
      //
      //   - **Bracket-style** (canonical, vault#285 friction point 1.3):
      //     `?meta[field][op]=value` / `?meta[created_at][gte]=…`. Exposes
      //     the full engine `metadata` filter (eq/ne/gt/gte/lt/lte/in/
      //     not_in/exists) and the dateFilter bridge through one consistent
      //     shape. See `parseMetaBrackets` for the grammar.
      //
      //   - **Flat date params** (DEPRECATED): `?date_field=created_at&
      //     date_from=…&date_to=…` and the legacy `?date_from=…&date_to=…`.
      //     Still functional through 0.5.x; planned removal in 0.6.0
      //     (vault#288). New consumers should use bracket-style.
      //
      // Precedence on overlap: bracket-style wins. If a caller passes both
      // `meta[created_at][gte]=X` and `date_field=created_at&date_from=Y`,
      // the bracket form is the dateFilter the engine sees; the flat
      // params are silently dropped. We don't error — the bracket form is
      // documented as canonical, and rejecting the overlap would block a
      // realistic migration path where a caller half-converted their code.
      //
      // Surface asymmetry: REST flattens to a query string; MCP takes a
      // nested `date_filter: { field, from, to }` object directly. Both
      // lower to the same store-level `dateFilter` shape.
      const tags = parseQueryList(url, "tag");
      const bracket = parseMetaBrackets(url);
      if (bracket.error) return bracket.error;
      let results: Note[];
      try {
        results = await store.queryNotes({
          tags,
          tagMatch: (parseQuery(url, "tag_match") as "all" | "any") ?? (tags && tags.length > 1 ? "any" : undefined),
          excludeTags: parseQueryList(url, "exclude_tag"),
          hasTags: parseBoolOrUndef(parseQuery(url, "has_tags")),
          hasLinks: parseBoolOrUndef(parseQuery(url, "has_links")),
          path: parseQuery(url, "path") ?? undefined,
          pathPrefix: parseQuery(url, "path_prefix") ?? undefined,
          metadata: bracket.metadata,
          // Date-range precedence chain (highest to lowest):
          //   1. Bracket-style `meta[created_at][gte]=…` (canonical).
          //   2. Flat `date_field=…&date_from=…&date_to=…` (deprecated).
          //   3. Legacy `date_from=…&date_to=…` (no date_field, deprecated)
          //      — filters on `n.created_at` by definition.
          // The engine rejects combinations of `dateFilter` with the legacy
          // `dateFrom`/`dateTo`, so we never set both shapes simultaneously.
          ...(bracket.dateFilter
            ? { dateFilter: bracket.dateFilter }
            : parseQuery(url, "date_field")
              ? {
                  dateFilter: {
                    field: parseQuery(url, "date_field")!,
                    from: parseQuery(url, "date_from") ?? undefined,
                    to: parseQuery(url, "date_to") ?? undefined,
                  },
                }
              : {
                  dateFrom: parseQuery(url, "date_from") ?? undefined,
                  dateTo: parseQuery(url, "date_to") ?? undefined,
                }),
          sort: (parseQuery(url, "sort") as "asc" | "desc") ?? undefined,
          orderBy: parseQuery(url, "order_by") ?? undefined,
          limit: parseInt10(parseQuery(url, "limit")) ?? 50,
          offset: parseInt10(parseQuery(url, "offset")),
        });
      } catch (e: any) {
        // QueryError (non-indexed order_by, unknown operator, ...) surfaces
        // here. Duck-type on `name` + `code` — core is a separate module, so
        // `instanceof` is fragile across bundling boundaries.
        if (e && e.name === "QueryError") {
          return json({ error: e.message, code: e.code ?? "INVALID_QUERY" }, 400);
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
        const traversed = linkOps.traverseLinks(db, anchor.id, { max_depth: depth, relationship });
        const nearScope = new Set([anchor.id, ...traversed.map((t) => t.noteId)]);
        results = results.filter((n) => nearScope.has(n.id));
      }

      // Tag-scope: drop any result outside the allowlist before shaping
      // output. Same semantics as the search path — empty result is 200 [],
      // not 403.
      results = filterNotesByTagScope(results, tagScope.allowed, tagScope.raw);

      const includeContent = parseBool(parseQuery(url, "include_content"), false);
      const includeLinks = parseBool(parseQuery(url, "include_links"), false);
      const includeAttachments = parseBool(parseQuery(url, "include_attachments"), false);
      const inclMeta = parseIncludeMetadata(url);
      let output: any[] = includeContent ? results.map((n) => ({ ...n })) : results.map(toNoteIndex);
      const expand = parseExpandParams(url, db);
      if (expand && includeContent) {
        for (const n of output) expand.ctx.expanded.add(n.id);
        for (const n of output) {
          if (typeof n.content === "string") {
            n.content = expandContent(n.content, expand.ctx, expand.depth);
          }
        }
      }
      if (inclMeta !== undefined && inclMeta !== true) {
        output = output.map((n: any) => filterMetadata(n, inclMeta));
      }

      // Graph format — reshape into { nodes, edges }
      if (parseQuery(url, "format") === "graph") {
        const resultIds = new Set(results.map((n) => n.id));
        const nodes = output.map((n: any) => ({ id: n.id, path: n.path ?? null, tags: n.tags ?? [] }));
        const edges: { source: string; target: string; relationship: string }[] = [];
        if (includeLinks) {
          for (const n of results) {
            for (const link of linkOps.getLinksHydrated(db, n.id)) {
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
        const enrichedOut: any[] = [];
        for (const n of output) {
          const enriched: any = { ...n };
          if (includeLinks) enriched.links = linkOps.getLinksHydrated(db, n.id);
          if (includeAttachments) enriched.attachments = await store.getAttachments(n.id);
          enrichedOut.push(enriched);
        }
        return json(enrichedOut);
      }

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
      if (batched) db.exec("BEGIN");
      try {
        for (const item of items) {
          const note = await store.createNote(item.content ?? "", {
            id: item.id,
            path: item.path,
            tags: item.tags,
            metadata: item.metadata,
            created_at: item.createdAt ?? item.created_at,
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
        if (batched) db.exec("COMMIT");
      } catch (e: any) {
        if (batched) db.exec("ROLLBACK");
        // Duck-type for module-boundary robustness (matches the PATCH branch).
        if (e && e.code === "PATH_CONFLICT") {
          return json(
            { error_type: "path_conflict", error: "path_conflict", path: e.path, message: e.message },
            409,
          );
        }
        throw e;
      }

      // Apply tag schema defaults
      for (const note of created) {
        if (note.tags?.length) {
          await applySchemaDefaults(store, db, [note.id], note.tags);
        }
      }

      // Attach `validation_status` so HTTP create-note matches the MCP
      // surface (vault#287). Mirrors the MCP create-note attach site at
      // `core/src/mcp.ts:451`. `attachValidationStatus` returns the note
      // unchanged when no tag declares fields, so vaults without any tag
      // schemas see no behavior change.
      const final = created.map((n) => attachValidationStatus(store, db, n));
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

      // `transcribe: true` asks the transcription worker to read this audio
      // file and replace the note's content with the transcript. The caller
      // is declaring "overwrite my current content when the transcript lands"
      // — we persist that as `transcribe_stub: true` on the note so a later
      // user edit (which clears the marker) can opt out before the worker
      // runs.
      const attMeta = body.transcribe
        ? { transcribe_status: "pending" as const, transcribe_requested_at: new Date().toISOString() }
        : undefined;

      const attachment = await store.addAttachment(note.id, body.path, body.mimeType, attMeta);

      if (body.transcribe) {
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

  if (sub !== "") return json({ error: "Not found" }, 404);

  // GET /notes/:idOrPath — single note
  if (method === "GET") {
    const note = await resolveNote(store, idOrPath);
    if (!note) return json({ error: "Not found" }, 404);
    if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
      return json({ error: "Not found" }, 404);
    }
    const includeContent = parseBool(parseQuery(url, "include_content"), true);
    let result: any = includeContent ? { ...note } : toNoteIndex(note);
    const expand = parseExpandParams(url, db);
    if (expand && includeContent && typeof result.content === "string") {
      expand.ctx.expanded.add(note.id);
      result.content = expandContent(result.content, expand.ctx, expand.depth);
    }
    result = filterMetadata(result, parseIncludeMetadata(url));
    if (parseBool(parseQuery(url, "include_links"), false)) {
      result.links = linkOps.getLinksHydrated(db, note.id);
    }
    if (parseBool(parseQuery(url, "include_attachments"), false)) {
      result.attachments = await store.getAttachments(note.id);
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
          const createOpts: Parameters<Store["createNote"]>[1] = {
            ...(idLooksLikePath ? { path: explicitPath ?? idOrPathStr } : { id: idOrPathStr, ...(explicitPath !== undefined ? { path: explicitPath } : {}) }),
            ...(tagsArr.length > 0 ? { tags: tagsArr } : {}),
            ...(body.metadata !== undefined ? { metadata: body.metadata as Record<string, unknown> } : {}),
            ...(body.created_at !== undefined ? { created_at: body.created_at as string } : {}),
            ...(body.createdAt !== undefined ? { created_at: body.createdAt as string } : {}),
          };
          const content = (body.content as string | undefined) ?? "";
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
      if (!isAppendOnly && body.if_updated_at === undefined && body.force !== true) {
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
      if (body.metadata !== undefined) {
        const existing = (note.metadata as Record<string, unknown>) ?? {};
        updates.metadata = { ...existing, ...body.metadata };
      }
      if (body.created_at !== undefined || body.createdAt !== undefined) {
        updates.created_at = body.created_at ?? body.createdAt;
      }
      if (body.if_updated_at !== undefined) {
        updates.if_updated_at = body.if_updated_at;
      }

      if (Object.keys(updates).length > 0) {
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
      const validated = attachValidationStatus(store, db, updatedNote);
      const includeContentResp = body.include_content !== false;
      // `created: false` is appended to every update-path response so
      // sync-loop callers using `if_missing: "create"` can distinguish
      // the two branches without a separate query (vault#309). The
      // create-branch response above carries `created: true`.
      if (includeContentResp) return json({ ...validated, created: false });
      const lean: any = toNoteIndex(validated);
      const vs = (validated as any).validation_status;
      if (vs !== undefined) lean.validation_status = vs;
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
      // Path-rename collision — schema's UNIQUE(path) tripped. Issue #126.
      if (e && e.code === "PATH_CONFLICT") {
        return json(
          { error_type: "path_conflict", error: "path_conflict", path: e.path, message: e.message },
          409,
        );
      }
      throw e;
    }
  }

  // DELETE /notes/:idOrPath — admin only (enforced at server level)
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
    const db = (store as any).db;
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
    if (tagScope.allowed && !tagScope.allowed.has(tagName)) {
      return tagScopeForbidden(tagScope.raw ?? []);
    }
    const body = (await req.json()) as {
      description?: string | null;
      fields?: Record<string, unknown> | null;
      relationships?: Record<string, unknown> | null;
      parent_names?: unknown;
    };

    // Validate relationships shape + cardinality vocabulary up front so
    // a bad payload returns 400, not a thrown 500.
    let relationshipsPatch:
      | Record<string, tagSchemaOps.TagRelationship>
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
    // payload only declares new ones.
    let fieldsPatch:
      | Record<string, tagSchemaOps.TagFieldSchema>
      | null
      | undefined;
    if (body.fields === null) {
      fieldsPatch = null;
    } else if (body.fields !== undefined) {
      const existing = await store.getTagSchema(tagName);
      const merged: Record<string, tagSchemaOps.TagFieldSchema> = {
        ...(existing?.fields ?? {}),
        ...(body.fields as Record<string, tagSchemaOps.TagFieldSchema>),
      };
      fieldsPatch = Object.keys(merged).length > 0 ? merged : null;
    }

    const result = await store.upsertTagRecord(tagName, {
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(fieldsPatch !== undefined ? { fields: fieldsPatch } : {}),
      ...(relationshipsPatch !== undefined ? { relationships: relationshipsPatch } : {}),
      ...(parentNamesPatch !== undefined ? { parent_names: parentNamesPatch } : {}),
    });
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
    const referenced_by = findTokensReferencingTag((store as any).db, tagName);
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

  const db = (store as any).db;
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
};

const VALID_AUDIO_RETENTION = ["keep", "until_transcribed", "never"] as const;

function vaultResponse(vaultConfig: VaultConfigLike): Record<string, unknown> {
  return {
    name: vaultConfig.name,
    description: vaultConfig.description ?? null,
    config: {
      audio_retention: vaultConfig.audio_retention ?? "keep",
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
      config?: { audio_retention?: string };
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

    if (dirty && persist) persist();
    return json(vaultResponse(vaultConfig));
  }

  return json({ error: "Method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Unresolved wikilinks — REST-only (admin/maintenance)
// ---------------------------------------------------------------------------

export function handleUnresolvedWikilinks(req: Request, store: Store): Response {
  const url = new URL(req.url);
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : 50;
  const db = (store as any).db;
  return Response.json(listUnresolvedWikilinks(db, limit));
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
  const note = await resolveNote(store, idOrPath);
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
// Storage (file upload/serve) — kept as-is, Daily needs it
// ---------------------------------------------------------------------------

export function assetsDir(vault: string): string {
  return process.env.ASSETS_DIR ?? join(vaultDir(vault), "assets");
}
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

// Storage allowlist policy:
//   - audio + image + .pdf (knowledge-vault content: papers, scans, receipts)
//     + .mp4 (mobile capture default; iOS records mp4, not webm).
//   - .svg and .html are deliberately excluded — both can embed `<script>`
//     tags, which would turn an upload into a same-origin XSS vector when
//     the asset is served back from /storage/. If a future use case needs
//     SVG, sanitize on read (strip <script>/<foreignObject>) and revisit.
const ALLOWED_EXTENSIONS = new Set([
  ".wav", ".mp3", ".m4a", ".ogg", ".webm",
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".pdf", ".mp4",
]);

const MIME_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
};

export async function handleStorage(req: Request, path: string, vault: string): Promise<Response> {
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
    const ext = extname(file.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return json({ error: `File type ${ext} not allowed` }, 400);
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

    return json({ path: relativePath, size: buffer.length, mimeType }, 201);
  }

  const fileMatch = path.match(/^\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && fileMatch) {
    const reqPath = `${fileMatch[1]}/${fileMatch[2]}`;
    const filePath = normalize(join(assets, reqPath));

    if (!filePath.startsWith(normalize(assets))) {
      return json({ error: "Invalid path" }, 403);
    }
    if (!existsSync(filePath)) {
      return json({ error: "Not found" }, 404);
    }

    const stat = statSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const fileBuffer = readFileSync(filePath);

    return new Response(fileBuffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
      },
    });
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Tag schema defaults — same logic as core/src/mcp.ts applySchemaDefaults
// ---------------------------------------------------------------------------

async function applySchemaDefaults(store: Store, db: any, noteIds: string[], tags: string[]): Promise<void> {
  const schemas = tagSchemaOps.getTagSchemaMap(db);
  if (Object.keys(schemas).length === 0) return;

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
  if (Object.keys(defaults).length === 0) return;

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
  }
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
