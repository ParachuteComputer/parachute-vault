/**
 * In-process query matcher for live subscriptions (live-query SSE — design
 * `design/2026-06-08-live-query-sse.md`).
 *
 * The snapshot path evaluates a `QueryOpts` against the DB via the SQL query
 * engine (`core/src/notes.ts queryNotes`). The live path can't go back to the
 * DB for every mutation — the changed note is already in hand from the
 * post-commit hook — so this module re-implements the *supported subset* of
 * the query predicate against a single in-memory `Note`.
 *
 * **Predicate parity is the contract.** For any supported query, the set of
 * notes the snapshot SQL returns MUST equal the set this matcher accepts.
 * `subscribe.test.ts` enforces that over a seeded corpus. Every clause below
 * is written to mirror the exact SQL semantics in `queryNotes`:
 *
 *   - `tags` ("all"/"any") with descendant expansion — mirrors the per-input
 *     `_tagsExpanded` JOINs (each input tag matches the input OR any declared
 *     descendant). Expansion is resolved ONCE at subscribe time (see
 *     `buildLiveMatcher`) and frozen into the matcher, exactly as the engine
 *     freezes it for the snapshot query.
 *   - `excludeTags` — raw exact-name match (engine does NOT expand excludes).
 *   - `path` — case-insensitive exact (engine: `n.path = ? COLLATE NOCASE`).
 *   - `pathPrefix` — prefix (engine: `n.path LIKE prefix || '%'`).
 *   - `extension` — lower-cased, default "md" (engine: `LOWER(n.extension)`),
 *     a note with no extension is treated as "md".
 *   - `metadata` operator objects (eq/ne/gt/gte/lt/lte/in/not_in/exists) +
 *     primitive exact-match — mirrors `buildOperatorClause` / the json_extract
 *     shorthand. NULL-aware exactly like the SQL (`ne`/`not_in` match the
 *     field-absent row; `eq null` matches absence).
 *
 *   - `hasTags` (presence) — `note.tags?.length > 0`, trivial + parity-safe.
 *
 * **Unsupported (rejected upstream with 400, never reach the matcher):**
 * `search` (FTS) and `near` (graph BFS) — not evaluable against a single note;
 * `hasLinks` — needs the `links` table (not on the in-hand note); date filters
 * (`dateFrom`/`dateTo`/`dateFilter`) — parity risk + some need indexed columns;
 * `cursor` — paging is meaningless for a live set. The subscribe route returns
 * 400 for these BEFORE a subscription is created (see
 * `unsupportedSubscriptionReason` + the route's raw-param checks).
 *
 * **Ignored (irrelevant to set membership):** `orderBy`, `limit`, `offset`,
 * `ids`. The route strips `limit`/`offset` from the snapshot query so the
 * snapshot is the COMPLETE matching set (parity with the unbounded matcher).
 */

import type { Note, QueryOpts, Store } from "../core/src/types.ts";
import { SUPPORTED_OPS } from "../core/src/query-operators.ts";

const OPS_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_OPS);

/**
 * Frozen, pre-resolved form of a `QueryOpts` for fast per-note matching.
 * Tag descendant expansion (a DB read) is done once here, not per event.
 */
export interface LiveMatcher {
  /** The original supported opts (for diagnostics / parity tests). */
  readonly opts: QueryOpts;
  /**
   * Per-input-tag expanded sets: `tagSets[i]` = `{tags[i]} ∪ descendants`.
   * Mirrors `_tagsExpanded` in the engine. Empty when no `tags` filter.
   * A note matches under "all" iff it carries ≥1 tag from EACH set; under
   * "any" iff it carries ≥1 tag from the UNION.
   */
  readonly tagSets: string[][];
  readonly tagMatch: "all" | "any";
  readonly excludeTags: string[];
  match(note: Note): boolean;
}

/**
 * Query shapes a live subscription can't evaluate against a single note.
 * The route layer rejects these with 400 before creating a subscription.
 */
export function unsupportedSubscriptionReason(opts: QueryOpts): string | null {
  // `search` / `near` are parsed/handled by the notes route separately; the
  // subscribe route detects them from raw query params. These guards catch the
  // remaining shapes that the matcher can't faithfully evaluate against a
  // single in-hand note (so snapshot and live would disagree).
  // Presence, not truthiness (vault#550) — a bootstrap `cursor: ""` is
  // still cursor intent and must still be rejected here, not silently
  // treated as "no cursor requested."
  if (opts.cursor !== undefined) {
    return "cursor pagination is not supported for live subscriptions";
  }
  if (opts.hasLinks !== undefined) {
    return "has_links is not supported for live subscriptions (requires the links table)";
  }
  if (opts.dateFilter || opts.dateFrom || opts.dateTo) {
    return "date filters are not supported for live subscriptions";
  }
  return null;
}

function metaValue(note: Note, key: string): unknown {
  const m = note.metadata;
  if (!m || typeof m !== "object") return undefined;
  return (m as Record<string, unknown>)[key];
}

/**
 * Compare two primitives the way SQLite's generated `meta_<field>` column
 * would for ordering operators. Values stored via the indexed column are
 * primitives; we compare numbers numerically and strings lexically, matching
 * SQLite's type affinity for a column holding the JSON-extracted scalar.
 */
function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  // Booleans compare as their numeric form (SQLite stores 1/0).
  const an = typeof a === "boolean" ? (a ? 1 : 0) : a;
  const bn = typeof b === "boolean" ? (b ? 1 : 0) : b;
  if (typeof an === "number" && typeof bn === "number") return an < bn ? -1 : an > bn ? 1 : 0;
  const as = String(an);
  const bs = String(bn);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Loose equality mirroring the json_extract shorthand + operator `eq`. */
function looseEq(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  // Numbers vs numeric strings: the engine's operator path binds the raw
  // value to an indexed numeric column, so `5` and `5` match; the shorthand
  // path stringifies. Normalize via string compare as a backstop.
  if (actual == null || expected == null) return actual === expected;
  if (typeof actual === "boolean" || typeof expected === "boolean") {
    return (actual ? 1 : 0) === (expected ? 1 : 0) || String(actual) === String(expected);
  }
  return String(actual) === String(expected);
}

function evalOperatorObject(actual: unknown, opObj: Record<string, unknown>): boolean {
  for (const [op, expected] of Object.entries(opObj)) {
    switch (op) {
      case "eq":
        if (expected === null) {
          if (actual !== undefined && actual !== null) return false;
        } else if (!looseEq(actual, expected)) {
          return false;
        }
        break;
      case "ne":
        // SQL: (col IS NULL OR col <> ?) — absent field passes; equal fails.
        if (expected === null) {
          if (actual === undefined || actual === null) return false;
        } else if (actual !== undefined && actual !== null && looseEq(actual, expected)) {
          return false;
        }
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        // SQL comparison operators yield NULL (→ excluded) when the column
        // is NULL/absent.
        if (actual === undefined || actual === null) return false;
        const c = cmp(actual, expected);
        if (c === null) return false;
        if (op === "gt" && !(c > 0)) return false;
        if (op === "gte" && !(c >= 0)) return false;
        if (op === "lt" && !(c < 0)) return false;
        if (op === "lte" && !(c <= 0)) return false;
        break;
      }
      case "in": {
        if (!Array.isArray(expected)) return false;
        if (expected.length === 0) return false; // engine emits `0`
        if (actual === undefined || actual === null) return false;
        if (!expected.some((v) => looseEq(actual, v))) return false;
        break;
      }
      case "not_in": {
        if (!Array.isArray(expected)) return false;
        if (expected.length === 0) break; // engine emits `1` (no-op pass)
        // SQL: (col IS NULL OR col NOT IN (...)) — absent passes.
        if (actual === undefined || actual === null) break;
        if (expected.some((v) => looseEq(actual, v))) return false;
        break;
      }
      case "exists": {
        const present = actual !== undefined && actual !== null;
        if (expected === true && !present) return false;
        if (expected === false && present) return false;
        break;
      }
      default:
        // Unknown operator — the snapshot path would have thrown
        // UNKNOWN_OPERATOR at query time, so this never matches.
        return false;
    }
  }
  return true;
}

/** True iff every key of `value` is a supported operator (operator-object). */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as object);
  if (keys.length === 0) return false;
  return keys.every((k) => OPS_SET.has(k));
}

/**
 * Resolve a `QueryOpts` into a frozen `LiveMatcher`, expanding tag descendants
 * once via the store (the same hierarchy the snapshot query uses). Call at
 * subscribe time; the returned matcher is pure + sync for per-event use.
 */
export async function buildLiveMatcher(store: Store, opts: QueryOpts): Promise<LiveMatcher> {
  const tags = opts.tags ?? [];
  const tagMatch: "all" | "any" = opts.tagMatch ?? "all";
  // Per-input expansion along the SAME axis the snapshot query uses
  // (vault tag `expand` axis). `opts.expand` (default "subtypes") MUST be
  // threaded through here so the live matcher and the snapshot query engine
  // lower the IDENTICAL expansion — otherwise a subscription's snapshot and
  // its live events would disagree on which notes match. `expandTags` already
  // includes each input tag.
  const tagSets: string[][] = [];
  for (const t of tags) {
    const set = await store.expandTags([t], opts.expand);
    // Be defensive: ensure the root is present (expandTags always includes it
    // for non-empty input, but the contract should not rely on it here).
    set.add(t);
    tagSets.push(Array.from(set));
  }
  const excludeTags = opts.excludeTags ?? [];

  const matcher: LiveMatcher = {
    opts,
    tagSets,
    tagMatch,
    excludeTags,
    match(note: Note): boolean {
      return matchAgainst(note, opts, tagSets, tagMatch, excludeTags);
    },
  };
  return matcher;
}

function matchAgainst(
  note: Note,
  opts: QueryOpts,
  tagSets: string[][],
  tagMatch: "all" | "any",
  excludeTags: string[],
): boolean {
  const noteTags = note.tags ?? [];

  // ---- tags ----
  if (tagSets.length > 0) {
    if (tagMatch === "any") {
      const union = new Set(tagSets.flat());
      if (!noteTags.some((t) => union.has(t))) return false;
    } else {
      // "all": for each input tag's expanded set, the note must carry ≥1.
      for (const set of tagSets) {
        if (set.length === 0) continue;
        const s = new Set(set);
        if (!noteTags.some((t) => s.has(t))) return false;
      }
    }
  }

  // ---- excludeTags (raw exact, no expansion — mirrors engine) ----
  for (const ex of excludeTags) {
    if (noteTags.includes(ex)) return false;
  }

  // ---- hasTags (presence) — ignored by the engine when a `tags` filter is
  // also set (the tag filter already constrains to tagged notes), so mirror
  // that: only apply when there's no `tags` filter. See queryNotes
  // `filterByTags` short-circuit.
  if (opts.hasTags !== undefined && tagSets.length === 0) {
    const has = noteTags.length > 0;
    if (opts.hasTags !== has) return false;
  }

  // ---- path (case-insensitive exact) ----
  if (opts.path) {
    if (!note.path || note.path.toLowerCase() !== opts.path.toLowerCase()) return false;
  }

  // ---- pathPrefix (case-insensitive — the engine uses `LIKE prefix || '%'`,
  // and SQLite LIKE is ASCII-case-insensitive by default) ----
  if (opts.pathPrefix) {
    if (!note.path || !note.path.toLowerCase().startsWith(opts.pathPrefix.toLowerCase())) return false;
  }

  // ---- extension (lower-cased; default "md") ----
  if (opts.extension !== undefined) {
    const exts = Array.isArray(opts.extension) ? opts.extension : [opts.extension];
    const cleaned = exts
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .map((e) => e.toLowerCase());
    if (cleaned.length > 0) {
      const noteExt = (note.extension ?? "md").toLowerCase();
      if (!cleaned.includes(noteExt)) return false;
    }
  }

  // ---- metadata ----
  if (opts.metadata) {
    for (const [key, value] of Object.entries(opts.metadata)) {
      const actual = metaValue(note, key);
      if (isOperatorObject(value)) {
        if (!evalOperatorObject(actual, value)) return false;
      } else {
        // Primitive exact-match (json_extract shorthand). The engine compares
        // the JSON-extracted scalar against the string/JSON form.
        if (!looseEq(actual, value)) return false;
      }
    }
  }

  return true;
}
