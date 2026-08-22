/**
 * SQL `IN`-list helpers sized for the smallest backing SQLite we run on.
 *
 * ## The DO 100-bound-parameter cap
 *
 * Cloudflare Durable Object SQLite (the cloud vault's backing store) rejects
 * any statement carrying **more than 100 bound parameters** with
 * `too many SQL variables`. Standard SQLite — including bun:sqlite (self-host)
 * — tolerates 999 on old builds and 32766 on new ones, which is why an
 * `IN (?, ?, …)` list sized for the 999 floor shipped fine on self-host and
 * only 500'd on cloud vaults: a >100-note export page passed >100 ids in one
 * statement and DO SQLite rejected it. See vault export-500 diagnosis.
 *
 * Two DO-safe shapes, depending on whether the id-list is the *only* thing
 * in the statement:
 *
 * 1. **Standalone id-list** (its own `SELECT … WHERE id IN (…)`, no other
 *    params, no pagination): chunk at {@link IN_PARAM_CHUNK} and union the
 *    results in JS. Use {@link chunkForInClause}.
 *
 * 2. **Embedded id-set** (an `IN` filter inside a larger statement that also
 *    carries `ORDER BY` / `LIMIT` / `OFFSET` / other params — chunking would
 *    break the shared pagination window): bind the whole set as a SINGLE JSON
 *    array param via {@link IN_VIA_JSON_EACH} + {@link jsonEachParam}. One
 *    param regardless of set size, so it can never trip the cap. Requires the
 *    JSON1 extension, which both bun:sqlite and DO SQLite ship (the vault
 *    already relies on `json_extract` on DO for metadata queries).
 *
 * ## Future refinement — `maxBoundParams`
 *
 * The clean long-term shape is for the Store / DB shim to advertise a
 * `maxBoundParams` (DO = 100, bun = 999) and chunk to
 * `min(IN_PARAM_CHUNK, maxBoundParams - reservedParams)`, so self-host keeps
 * large-batch efficiency instead of paying the DO tax. Until then a global
 * 90 is SAFE on bun — it just issues more cheap, fully-indexed IN queries —
 * and is the conservative floor everywhere.
 */

/**
 * Chunk size for standalone `IN (?, ?, …)` id-lists. 90 leaves headroom
 * under the DO 100-param cap for statements whose only bound params are the
 * IN-list (the extra 10 covers the rare embedded extra param). Never raise
 * this above 100 without teaching every embedded callsite the DO cap — see
 * the module header.
 */
export const IN_PARAM_CHUNK = 90;

/**
 * Split `items` into consecutive chunks of at most `size` (default
 * {@link IN_PARAM_CHUNK}) for feeding to a chunked `IN (?, …)` query. Empty
 * input yields no chunks. This is the single place that decides IN-list chunk
 * boundaries, so a regression that raises the size is caught by one test.
 */
export function chunkForInClause<T>(items: readonly T[], size = IN_PARAM_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * SQL fragment for a single-param `IN` filter over an id-set embedded in a
 * larger statement: `WHERE col IN ${IN_VIA_JSON_EACH}`. Bind the matching
 * `?` with {@link jsonEachParam}. json_each expands the bound JSON array into
 * a one-column table, so the whole set costs exactly ONE bound parameter and
 * can never exceed the DO cap. Callers must guarantee the set is non-empty
 * (`json_each('[]')` yields no rows — correct for `IN`, but an empty set is
 * usually short-circuited to a `0 = 1` no-match upstream to skip the query).
 */
export const IN_VIA_JSON_EACH = "(SELECT value FROM json_each(?))";

/**
 * Serialize a value-set for the single {@link IN_VIA_JSON_EACH} bound param.
 *
 * Accepts `boolean`/`null` as well as ids because the metadata `in`/`not_in`
 * operators route through this too (vault#536), and those take any primitive
 * the caller can put in a metadata field. `bigint` is deliberately NOT
 * accepted — `JSON.stringify` throws on it — so callers must narrow first.
 */
export function jsonEachParam(
  values: readonly (string | number | boolean | null)[],
): string {
  return JSON.stringify(values);
}
