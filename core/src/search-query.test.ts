import { describe, it, expect } from "bun:test";
import {
  SEARCH_MODES,
  escapeFtsToken,
  buildLiteralSearchQuery,
  isValidSearchMode,
  extractLiteralBoostTerms,
} from "./search-query.js";

describe("escapeFtsToken", () => {
  it("wraps a plain token in quotes", () => {
    expect(escapeFtsToken("widgets")).toBe(`"widgets"`);
  });

  it("doubles an embedded quote", () => {
    expect(escapeFtsToken(`say"hi`)).toBe(`"say""hi"`);
  });

  it("doubles multiple embedded quotes", () => {
    expect(escapeFtsToken(`"eleven-day`)).toBe(`"""eleven-day"`);
    expect(escapeFtsToken(`delay"`)).toBe(`"delay"""`);
  });

  it("preserves punctuation that isn't a quote (hyphen, period, apostrophe)", () => {
    expect(escapeFtsToken("eleven-day")).toBe(`"eleven-day"`);
    expect(escapeFtsToken("18.6")).toBe(`"18.6"`);
    expect(escapeFtsToken("didn't")).toBe(`"didn't"`);
  });
});

describe("buildLiteralSearchQuery", () => {
  it("wraps a single token", () => {
    const r = buildLiteralSearchQuery("widgets");
    expect(r.isEmpty).toBe(false);
    expect(r.query).toBe(`"widgets"`);
  });

  it("phrase-quotes each whitespace-delimited token and ANDs them (vault#551 root fix)", () => {
    const r = buildLiteralSearchQuery("eleven-day capping delay");
    expect(r.isEmpty).toBe(false);
    expect(r.query).toBe(`"eleven-day" "capping" "delay"`);
  });

  it("escapes an apostrophe as literal content, not syntax", () => {
    const r = buildLiteralSearchQuery("didn't");
    expect(r.isEmpty).toBe(false);
    expect(r.query).toBe(`"didn't"`);
  });

  it("escapes a decimal point as literal content, not syntax", () => {
    const r = buildLiteralSearchQuery("18.6");
    expect(r.isEmpty).toBe(false);
    expect(r.query).toBe(`"18.6"`);
  });

  it("collapses runs of whitespace between tokens", () => {
    const r = buildLiteralSearchQuery("widgets    gadgets");
    expect(r.query).toBe(`"widgets" "gadgets"`);
  });

  it("trims leading/trailing whitespace", () => {
    const r = buildLiteralSearchQuery("  widgets  ");
    expect(r.query).toBe(`"widgets"`);
  });

  it("escapes a manually-quoted phrase's embedded quote characters as content", () => {
    // The user typed literal quote marks expecting phrase syntax; in
    // literal mode those quote characters are just more content that gets
    // escaped like anything else (vault#551 — this is CORRECT, not a bug:
    // raw phrase/boolean/prefix syntax now requires search_mode:"advanced").
    const r = buildLiteralSearchQuery(`"eleven-day capping delay"`);
    expect(r.isEmpty).toBe(false);
    expect(r.query).toBe(`"""eleven-day" "capping" "delay"""`);
  });

  it("treats a blank string as empty", () => {
    expect(buildLiteralSearchQuery("").isEmpty).toBe(true);
  });

  it("treats a whitespace-only string as empty", () => {
    expect(buildLiteralSearchQuery("   ").isEmpty).toBe(true);
  });

  it("treats a lone quote character as empty", () => {
    expect(buildLiteralSearchQuery(`"`).isEmpty).toBe(true);
  });

  it("treats a quotes-and-whitespace-only string as empty", () => {
    expect(buildLiteralSearchQuery(`"  "  "`).isEmpty).toBe(true);
  });

  it("an empty-flagged result never carries a query string callers should use", () => {
    const r = buildLiteralSearchQuery("   ");
    expect(r.isEmpty).toBe(true);
    expect(r.query).toBe("");
  });

  // Control-character sanitization (vault#551 review fold) — a NUL byte
  // (or any C0/DEL control) inside a token would otherwise crash FTS5's
  // C-string parser with a raw `unterminated string` error, breaking the
  // "literal mode cannot throw" guarantee.
  it("splits a token on an embedded NUL byte — both halves stay searchable", () => {
    const r = buildLiteralSearchQuery("hello\x00world");
    expect(r.isEmpty).toBe(false);
    expect(r.query).toBe(`"hello" "world"`);
  });

  it("treats a NUL-only string as empty (short-circuits, never reaches FTS5)", () => {
    const r = buildLiteralSearchQuery("\x00");
    expect(r.isEmpty).toBe(true);
    expect(r.query).toBe("");
  });

  it("collapses a run of NUL/control bytes between tokens like whitespace", () => {
    const r = buildLiteralSearchQuery("hello\x00\x00world");
    expect(r.query).toBe(`"hello" "world"`);
  });

  it("sanitizes the other C0 controls and DEL (0x01-0x1F, 0x7F) as separators too", () => {
    expect(buildLiteralSearchQuery("a\x01\x02b").query).toBe(`"a" "b"`);
    expect(buildLiteralSearchQuery("a\x1fb").query).toBe(`"a" "b"`);
    expect(buildLiteralSearchQuery("a\x7fb").query).toBe(`"a" "b"`);
  });

  it("a control byte adjacent to a real token still yields the clean token", () => {
    expect(buildLiteralSearchQuery("\x00hello\x00").query).toBe(`"hello"`);
  });
});

describe("isValidSearchMode / SEARCH_MODES", () => {
  it("SEARCH_MODES is exactly literal + advanced", () => {
    expect(SEARCH_MODES).toEqual(["literal", "advanced"]);
  });

  it("accepts literal and advanced", () => {
    expect(isValidSearchMode("literal")).toBe(true);
    expect(isValidSearchMode("advanced")).toBe(true);
  });

  it("rejects an unknown string", () => {
    expect(isValidSearchMode("bogus")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidSearchMode(123)).toBe(false);
    expect(isValidSearchMode(null)).toBe(false);
    expect(isValidSearchMode(undefined)).toBe(false);
    expect(isValidSearchMode(["literal"])).toBe(false);
  });
});

describe("extractLiteralBoostTerms (search title-boost input, title axis)", () => {
  it("lowercases and whitespace-splits", () => {
    expect(extractLiteralBoostTerms("Budget Review")).toEqual(["budget", "review"]);
  });

  it("collapses whitespace runs", () => {
    expect(extractLiteralBoostTerms("widgets    gadgets")).toEqual(["widgets", "gadgets"]);
  });

  it("trims leading/trailing whitespace", () => {
    expect(extractLiteralBoostTerms("  widgets  ")).toEqual(["widgets"]);
  });

  it("strips literal quote characters a caller typed, unlike buildLiteralSearchQuery", () => {
    // buildLiteralSearchQuery treats a manually-typed `"` as ordinary
    // content (escaped into the FTS phrase); the boost-term extractor
    // strips it instead, since a title-string comparison shouldn't
    // require the title to contain a literal quote mark.
    expect(extractLiteralBoostTerms(`"eleven-day capping delay"`)).toEqual([
      "eleven-day",
      "capping",
      "delay",
    ]);
  });

  it("preserves punctuation that isn't a quote (hyphen, period, apostrophe)", () => {
    expect(extractLiteralBoostTerms("eleven-day")).toEqual(["eleven-day"]);
    expect(extractLiteralBoostTerms("18.6")).toEqual(["18.6"]);
    expect(extractLiteralBoostTerms("didn't")).toEqual(["didn't"]);
  });

  it("returns an empty array for blank/whitespace-only input", () => {
    expect(extractLiteralBoostTerms("")).toEqual([]);
    expect(extractLiteralBoostTerms("   ")).toEqual([]);
  });

  it("sanitizes control characters as separators, matching buildLiteralSearchQuery", () => {
    expect(extractLiteralBoostTerms("hello\x00world")).toEqual(["hello", "world"]);
  });
});
