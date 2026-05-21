/**
 * Opaque cursors for `query-notes` (vault#313).
 *
 * Agent loops want "give me notes I haven't seen since last call." Today's
 * pattern — pass `dateFilter: { field: "updated_at", from: <iso> }` and
 * track the timestamp client-side — is brittle: the client has to remember
 * the watermark, two notes at the same millisecond may collide, and a
 * second call landed mid-millisecond can miss or double-count rows.
 *
 * The opaque-cursor pattern (Stripe, GitHub, et al.) fixes this. The server
 * returns a `next_cursor: string` on each query response; the client passes
 * it back on the next call and the server resumes from exactly where it
 * left off. The cursor is base64url-encoded JSON the client must not
 * inspect — internal layout can evolve without breaking callers.
 *
 * # Cursor payload
 *
 * ```ts
 * {
 *   v: 1,                      // schema version
 *   last_updated_at: number,   // millisecond epoch of the last seen note
 *   last_id: string,           // ID of the last seen note — tiebreaker
 *   query_hash: string,        // sha256 of normalized query params (hex)
 * }
 * ```
 *
 * - `last_updated_at` is millisecond epoch (not ISO) so cursor bytes stay
 *   compact and the tiebreaker math is integer.
 * - `last_id` is the tiebreaker — when two notes share `updated_at`, the
 *   keyset query advances `id > last_id` at that timestamp so neither is
 *   skipped nor returned twice.
 * - `query_hash` binds the cursor to the exact query it was minted for.
 *   Passing a cursor minted on `tag: "foo"` into a call for `tag: "bar"`
 *   would silently return the wrong page; mismatch raises a structured
 *   400 (`cursor_query_mismatch`) instead.
 *
 * # Why JSON inside base64url
 *
 * A flat-string format (`<ts>:<id>:<hash>`) is two characters shorter but
 * forecloses on optional fields. JSON gives us a schema-versioned envelope
 * — if v2 needs additional state (e.g. a search-relevance secondary key),
 * old clients keep working and new clients can read both.
 *
 * # Race safety
 *
 * The cursor stores the maximum-`updated_at`+`id` of the LAST returned
 * page. The next call's keyset predicate is:
 *
 *   (updated_at > last_updated_at)
 *   OR (updated_at = last_updated_at AND id > last_id)
 *
 * A note written between calls A and B at a brand-new `updated_at` is
 * picked up by the first half of the predicate. A note written at the
 * exact same `updated_at` as the cursor's watermark (uncommon — wall-clock
 * collisions are rare at millisecond resolution but not impossible) is
 * picked up by the tiebreaker because the SQL `ORDER BY updated_at ASC,
 * id ASC` ensures stable interleaving with the prior page. Without the
 * tiebreaker, two notes sharing an `updated_at` would be at the mercy of
 * SQLite's row order, which is "stable in practice" but not contract.
 */

import { createHash } from "node:crypto";

export const CURSOR_VERSION = 1;

export interface CursorPayload {
  /** Schema version. Bumped if the cursor layout changes incompatibly. */
  v: number;
  /** Millisecond epoch of the last note returned. */
  last_updated_at: number;
  /** ID of the last note returned — tiebreaker for same-ms collisions. */
  last_id: string;
  /** sha256(hex) of normalized query params. Mismatch → cursor_query_mismatch. */
  query_hash: string;
}

/**
 * Thrown when a caller passes a malformed or stale cursor. The wrapping
 * layer (MCP / REST) catches and surfaces a 400 with the structured code
 * — callers should drop the cursor and restart the iteration.
 */
export class CursorError extends Error {
  override name = "CursorError";
  code: "cursor_invalid" | "cursor_query_mismatch";
  constructor(message: string, code: "cursor_invalid" | "cursor_query_mismatch") {
    super(message);
    this.code = code;
  }
}

/** Encode a cursor payload to a base64url-safe opaque string. */
export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64url");
}

/** Decode a cursor string. Throws `CursorError` on any structural problem. */
export function decodeCursor(cursor: string): CursorPayload {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new CursorError("cursor must be a non-empty string", "cursor_invalid");
  }
  let json: string;
  try {
    json = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new CursorError("cursor is not valid base64url", "cursor_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CursorError("cursor payload is not valid JSON", "cursor_invalid");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CursorError("cursor payload must be an object", "cursor_invalid");
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.v !== "number" || p.v !== CURSOR_VERSION) {
    throw new CursorError(
      `cursor schema version mismatch (expected ${CURSOR_VERSION}, got ${String(p.v)})`,
      "cursor_invalid",
    );
  }
  if (typeof p.last_updated_at !== "number" || !Number.isFinite(p.last_updated_at)) {
    throw new CursorError("cursor.last_updated_at must be a finite number", "cursor_invalid");
  }
  if (typeof p.last_id !== "string") {
    throw new CursorError("cursor.last_id must be a string", "cursor_invalid");
  }
  if (typeof p.query_hash !== "string" || p.query_hash.length === 0) {
    throw new CursorError("cursor.query_hash must be a non-empty string", "cursor_invalid");
  }
  return {
    v: p.v,
    last_updated_at: p.last_updated_at,
    last_id: p.last_id,
    query_hash: p.query_hash,
  };
}

/**
 * Shape of query parameters that participate in the query-hash.
 *
 * Pagination / cursor parameters themselves are excluded — bumping `limit`
 * or advancing the cursor must NOT invalidate the cursor. Output-shape
 * parameters (`include_content`, etc.) are also excluded — they don't
 * affect *which* rows are returned, just how each row is rendered.
 *
 * The fields here are the *result-set-affecting* inputs. Any future filter
 * added to `QueryOpts` should also be added here.
 */
export interface QueryHashInputs {
  tags?: string[];
  tagMatch?: "all" | "any";
  excludeTags?: string[];
  hasTags?: boolean;
  hasLinks?: boolean;
  path?: string;
  pathPrefix?: string;
  extension?: string | string[];
  ids?: string[];
  metadata?: Record<string, unknown>;
  dateFrom?: string;
  dateTo?: string;
  dateFilter?: { field?: string; from?: string; to?: string };
  sort?: "asc" | "desc";
  orderBy?: string;
}

/**
 * Compute a stable hash of the query parameters.
 *
 * Stability matters: a caller that passes `{tag: "x", path_prefix: "p"}`
 * on call 1 and `{path_prefix: "p", tag: "x"}` on call 2 (same query,
 * different object-key order) must get the same hash. We achieve this
 * by canonicalizing — sorting array fields (where order is irrelevant),
 * recursively sorting object keys, and stringifying with a deterministic
 * key order.
 *
 * `undefined` fields are dropped before hashing. An empty `tags: []` and
 * an unset `tags` produce the same hash (both mean "no tag filter"), so
 * a caller that conditionally sets it doesn't accidentally invalidate
 * their cursor.
 *
 * Returned as a hex sha256 digest — 64 chars, fits comfortably in the
 * base64url cursor envelope.
 */
export function computeQueryHash(inputs: QueryHashInputs): string {
  const canonical = canonicalize(inputs);
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * Canonicalize a value for stable hashing.
 *
 * - Drops `undefined` properties (object keys with `undefined` values).
 * - Drops empty arrays at the top level (treated equivalent to unset).
 * - Sorts string-array fields where order doesn't affect query semantics
 *   (`tags`, `excludeTags`, `ids`, `extension` when array-shaped).
 * - Recursively sorts plain-object keys so JSON.stringify is order-stable.
 * - Primitives and arrays of primitives pass through unchanged (after the
 *   array-sort rule above).
 *
 * Inside `metadata`, sub-object keys (operator-clause shapes like
 * `{eq, gte, lt}`) are sorted too — the engine treats `{gte: 5, lt: 10}`
 * and `{lt: 10, gte: 5}` identically, so the cursor binding should as well.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    // Don't sort arbitrary arrays — order may be semantic (e.g. an `in`
    // operator's array value is order-irrelevant to SQLite, but cursor
    // semantics defer to the caller). For the known order-irrelevant
    // string-array fields we sort at the top-level canonicalization;
    // deep arrays pass through unchanged so a caller's intent is preserved.
    return (value as unknown[]).map((v) => canonicalize(v));
  }
  // Plain object. Sort keys, drop undefineds, sort known order-irrelevant
  // string-array fields.
  const ORDER_IRRELEVANT_STRING_ARRAYS = new Set([
    "tags",
    "excludeTags",
    "ids",
    "extension",
  ]);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as object).sort();
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (ORDER_IRRELEVANT_STRING_ARRAYS.has(k) && Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = [...(v as string[])].sort();
      continue;
    }
    out[k] = canonicalize(v);
  }
  return out;
}

/**
 * Parse an ISO-8601 timestamp to millisecond epoch.
 *
 * SQLite stores `updated_at` as a string ISO timestamp (set on insert /
 * update by the store layer). The cursor pipes that string out as a
 * millisecond integer for compact serialization. This helper exists so
 * the call sites (mint-cursor + decode-cursor-into-SQL-predicate) share
 * exactly one conversion, with NaN guarded.
 */
export function isoToMillis(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new CursorError(`invalid ISO timestamp for cursor: ${iso}`, "cursor_invalid");
  }
  return ms;
}

/**
 * Convert millisecond epoch back to an ISO-8601 timestamp string.
 *
 * Used to translate the cursor's `last_updated_at` into the form SQLite
 * compares (`n.updated_at` is a TEXT column carrying ISO strings). ISO
 * timestamps sort correctly lexicographically when they're all in the same
 * canonical form (Z-suffixed, fixed millisecond precision) — every
 * timestamp vault mints goes through `new Date(...).toISOString()` so the
 * lex-order matches the millis-order.
 */
export function millisToIso(ms: number): string {
  return new Date(ms).toISOString();
}
