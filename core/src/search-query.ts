/**
 * Literal-by-default FTS5 query construction (vault#551 — Reliability &
 * Usability Program WS2A).
 *
 * **Root cause fixed here:** `search` used to be bound straight to SQLite
 * FTS5 as raw query syntax. FTS5's bareword grammar treats punctuation as
 * SYNTAX, not content — a leading `-` means NOT, an apostrophe or a bare
 * `.` breaks the tokenizer's parse entirely — so ordinary human text like
 * `didn't`, `eleven-day capping delay`, or `18.6` either silently matched
 * the wrong thing or threw a syntax error that the old code swallowed into
 * an empty `[]` (see `core/src/notes.ts` `searchNotes`, pre-#551). The
 * 2026-07-09 deep test confirmed phrase-quoting cures every observed case:
 * FTS5 phrase syntax (`"..."`) tokenizes its content with the SAME
 * tokenizer used for indexing, so wrapping each whitespace-delimited token
 * of the user's string in a quoted phrase makes the query's tokens land on
 * exactly the same boundaries the indexer produced — punctuation-safe by
 * construction, no custom tokenizer needed.
 *
 * **Ratified split (see #551):** `search` is literal-by-default — every
 * token is escaped and phrase-quoted, so raw FTS5 operators (AND/OR/NOT,
 * manual phrase quoting, prefix `*`) are treated as ordinary text, not
 * syntax. `search_mode: "advanced"` opts back into raw FTS5 syntax
 * (today's pre-#551 behavior, unchanged) for callers who want boolean/
 * phrase/prefix operators. This module owns the literal-mode escaping so
 * both the self-hosted door (`core/src/notes.ts`) and the hosted door
 * inherit it from the same shared library.
 */

export const SEARCH_MODES = ["literal", "advanced"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export function isValidSearchMode(value: unknown): value is SearchMode {
  return typeof value === "string" && (SEARCH_MODES as readonly string[]).includes(value);
}

/**
 * Escape one token for FTS5 phrase-quoted literal matching: double every
 * embedded `"` (FTS5's own escape for a literal quote inside a quoted
 * string) and wrap the whole thing in `"..."`. A single-token phrase with
 * no embedded punctuation degrades to exactly the same match as an
 * unquoted bareword — this only changes behavior for tokens FTS5 would
 * otherwise have parsed as syntax.
 */
export function escapeFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

export interface LiteralSearchQuery {
  /**
   * FTS5 MATCH-ready query string, built by phrase-quoting each
   * whitespace-delimited token of the input and implicit-ANDing them
   * together. Meaningless (and never used) when `isEmpty` is true.
   */
  query: string;
  /**
   * True when the input carried no literal search content — blank/
   * whitespace-only, or (once quote characters are stripped, since in
   * literal mode a manually-typed `"` is ordinary content rather than
   * syntax) nothing but quote characters. Passing such an input to FTS5
   * MATCH is either a syntax error or a meaningless always-empty phrase;
   * callers should short-circuit to an empty result set (with an
   * `empty_search` warning) instead of ever building `query`.
   */
  isEmpty: boolean;
}

/**
 * Build a literal-mode FTS5 query from raw user search text (vault#551).
 *
 * Algorithm: collapse whitespace runs via a `\s+` split (also trims
 * leading/trailing whitespace), escape + phrase-quote each resulting
 * token, and implicit-AND them by joining with a single space — FTS5's
 * default combination for adjacent phrases with no explicit operator.
 *
 * Examples (see `search-query.test.ts` for the full matrix):
 *   - `didn't` → `"didn't"` — a single phrase; the embedded apostrophe is
 *     now literal content, not syntax. FTS5 tokenizes the phrase content
 *     with the same tokenizer used at index time, so it still matches
 *     content stored as "didn't" (both split into the same token sequence).
 *   - `eleven-day capping delay` → `"eleven-day" "capping" "delay"` — three
 *     phrases, ANDed. The hyphen inside the first phrase is content, not a
 *     NOT-operator.
 *   - `18.6` → `"18.6"` — the decimal point can't break tokenization
 *     mid-parse because it's inside a quoted phrase.
 *   - A manually-quoted input like `"eleven-day capping delay"` (a caller
 *     who typed literal quote marks, expecting phrase syntax to work in
 *     the default mode) gets its own quote characters escaped as content
 *     too — this is CORRECT per literal semantics, not a regression: the
 *     embedded `"` characters are themselves non-alphanumeric and get
 *     stripped by the same tokenizer, so the match still lands on the
 *     same underlying word sequence. Callers who want raw phrase/boolean/
 *     prefix syntax to be honored as SYNTAX should pass
 *     `search_mode: "advanced"` instead.
 */
export function buildLiteralSearchQuery(raw: string): LiteralSearchQuery {
  // "Only whitespace/quotes" (vault#551 edge case) — strip both and check
  // whether any real content remains. Catches blank/whitespace-only input
  // AND inputs like `"`, `""`, `"   "` that would otherwise degenerate into
  // a phrase with no real token content. Checked BEFORE tokenizing so we
  // never build a query for these at all.
  if (raw.replace(/["\s]/g, "") === "") {
    return { query: "", isEmpty: true };
  }
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  return { query: tokens.map(escapeFtsToken).join(" "), isEmpty: false };
}
