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

/**
 * bm25 column weights for `notes_fts` (vault#551 WS2C — ranking legibility,
 * schema v25). `notes_fts` indexes two columns, `path` (title) then
 * `content` (body), in that declared order (`core/src/schema.ts`) —
 * `bm25(notes_fts, w0, w1, ...)`'s weight arguments are POSITIONAL, so
 * `SEARCH_WEIGHT_PATH` must be passed first, `SEARCH_WEIGHT_CONTENT`
 * second, matching column declaration order exactly.
 *
 * A 10:1 ratio biases ranking heavily toward a TITLE match — a dedicated
 * note whose path/title contains the search term outranks another note
 * that merely mentions it once in passing body text (the interim harness's
 * "dedicated notes buried behind passing mentions" finding, confirmed via
 * a live bm25 probe: a title-match note scored roughly 2x a body-only
 * match on realistic content — see the migration test fixtures for the
 * live-verified case). Exported so `core/src/notes.ts`'s SQL construction
 * is the only place these numbers are used, rather than two call sites
 * risking drift.
 */
export const SEARCH_WEIGHT_PATH = 10.0;
export const SEARCH_WEIGHT_CONTENT = 1.0;

/**
 * Control characters — the C0 range (U+0000–U+001F) plus DEL (U+007F) —
 * treated as token SEPARATORS in literal mode, exactly like whitespace.
 *
 * The load-bearing case is NUL (U+0000): FTS5's query parser is C-string
 * based, so a NUL byte inside a quoted phrase reads as the end of the
 * string and FTS5 raises `SQLiteError: unterminated string` — a RAW error
 * that would otherwise escape literal mode as an unstructured 500 (REST) /
 * generic `isError` text (MCP), contradicting the "literal mode cannot
 * throw" guarantee this module and `docs/HTTP_API.md` assert. Sanitizing
 * these to spaces BEFORE FTS5 ever sees the query keeps that guarantee
 * true. `\s` in the tokenizer already covers the whitespace-range controls
 * (U+0009–U+000D); this class catches the rest (NUL, the other C0 bytes,
 * DEL). A control char embedded mid-token (`hello\0world`) splits the
 * token in two — both halves stay searchable, same as a space would.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

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
   * whitespace-only, or (once quote AND control characters are stripped,
   * since in literal mode a manually-typed `"` is ordinary content and a
   * control byte is a separator) nothing but quotes/whitespace/controls.
   * Passing such an input to FTS5 MATCH is either a syntax error or a
   * meaningless always-empty phrase; callers should short-circuit to an
   * empty result set (with an `empty_search` warning) instead of ever
   * building `query`.
   */
  isEmpty: boolean;
}

/**
 * Build a literal-mode FTS5 query from raw user search text (vault#551).
 *
 * Algorithm: sanitize control characters to spaces (see `CONTROL_CHARS` —
 * NUL and friends would otherwise crash FTS5's C-string parser), collapse
 * whitespace runs via a `\s+` split (also trims leading/trailing
 * whitespace), escape + phrase-quote each resulting token, and implicit-AND
 * them by joining with a single space — FTS5's default combination for
 * adjacent phrases with no explicit operator.
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
  // Sanitize control characters to spaces FIRST (see `CONTROL_CHARS`) —
  // done before both the emptiness check and tokenization so a NUL byte
  // (or any other C0/DEL control) becomes a token separator rather than
  // reaching FTS5's parser, where it would raise a raw `unterminated
  // string` SQLiteError and blow the "literal mode cannot throw" guarantee.
  const cleaned = raw.replace(CONTROL_CHARS, " ");
  // "Only whitespace/quotes/controls" (vault#551 edge case) — strip quotes
  // and whitespace and check whether any real content remains. Catches
  // blank/whitespace-only input, control-only input (now spaces), AND
  // inputs like `"`, `""`, `"   "` that would otherwise degenerate into a
  // phrase with no real token content. Checked BEFORE tokenizing so we
  // never build a query for these at all.
  if (cleaned.replace(/["\s]/g, "") === "") {
    return { query: "", isEmpty: true };
  }
  const tokens = cleaned.trim().split(/\s+/).filter(Boolean);
  return { query: tokens.map(escapeFtsToken).join(" "), isEmpty: false };
}

/**
 * Extract lowercase whitespace-delimited terms from raw literal-mode search
 * text, for the search title-boost post-rank (title axis, ratified
 * 2026-07-17) — NOT used to build the FTS5 MATCH query itself (that's
 * `buildLiteralSearchQuery`, above). Sanitizes control characters the same
 * way, plus strips any literal `"` a caller typed (kept as ordinary content
 * by `buildLiteralSearchQuery`, but a display-title substring check
 * shouldn't require the title to contain a literal quote mark).
 *
 * This is a heuristic re-rank signal, not a second index — it deliberately
 * does not attempt FTS5-tokenizer parity (stemming, unicode normalization).
 * It only needs to answer "does the note's first line plausibly contain the
 * query," not reproduce FTS5's match semantics exactly. Restricted to
 * literal-mode callers by convention (see `core/src/notes.ts` `searchNotes`)
 * — `search_mode: "advanced"` text carries FTS5 boolean/column/prefix
 * operators (`AND`, `path:`, `foo*`) that would leak into the term list as
 * false "content" if tokenized the same naive way.
 */
export function extractLiteralBoostTerms(raw: string): string[] {
  const cleaned = raw.replace(CONTROL_CHARS, " ").toLowerCase();
  return cleaned
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^"+|"+$/g, ""))
    .filter(Boolean);
}
