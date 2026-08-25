/**
 * `computeLede` — the first non-empty paragraph AFTER a note's title line,
 * used by `expand_mode: "summary"` (core/src/expand.ts) as a fallback when
 * `metadata.summary` is absent (summaries-as-content, 2026-07-17 dialogue).
 *
 * Shares its title-line rule (including the leading-frontmatter skip) with
 * `computeDisplayTitle` — see `display-title.test.ts` for that function's
 * own coverage. This file covers only the lede-specific behavior: where the
 * paragraph starts, how it's collapsed, the length cap, and the
 * title-only/no-content null cases.
 */
import { describe, it, expect } from "bun:test";
import { computeLede, LEDE_MAX_LEN } from "./notes.js";

describe("computeLede", () => {
  it("returns the first paragraph after a heading title, blank-line separated", () => {
    expect(
      computeLede("# Title\n\nThis is the lede paragraph.\n\nSecond paragraph — not the lede."),
    ).toBe("This is the lede paragraph.");
  });

  it("joins a multi-line paragraph into one collapsed line", () => {
    expect(
      computeLede("# Title\n\nThis lede paragraph\nspans two lines.\n\nSecond paragraph."),
    ).toBe("This lede paragraph spans two lines.");
  });

  it("treats text immediately following the title (no blank line) as the lede", () => {
    expect(computeLede("Grocery List\nmilk, eggs\ncheese")).toBe("milk, eggs cheese");
  });

  it("collapses internal whitespace runs to single spaces", () => {
    expect(computeLede("Title\n\nLine one   with    extra   spaces.")).toBe(
      "Line one with extra spaces.",
    );
  });

  it("returns null for a title-only note (does not repeat the title)", () => {
    expect(computeLede("Just a title")).toBeNull();
    expect(computeLede("# Just a title")).toBeNull();
  });

  it("returns null when only blank lines follow the title", () => {
    expect(computeLede("# Title\n\n\n   \n")).toBeNull();
  });

  it("returns null for empty, null, or undefined content", () => {
    expect(computeLede("")).toBeNull();
    expect(computeLede(null)).toBeNull();
    expect(computeLede(undefined)).toBeNull();
  });

  it("returns null when content is whitespace-only (no title at all)", () => {
    expect(computeLede("   \n\t\n   ")).toBeNull();
  });

  describe("leading frontmatter block", () => {
    it("finds the lede after a closed frontmatter block AND its title line", () => {
      expect(
        computeLede("---\ntitle: X\n---\n# Real Title\n\nThe lede text."),
      ).toBe("The lede text.");
    });

    it("finds the lede when the title immediately follows frontmatter with no blank line", () => {
      expect(
        computeLede("---\ntitle: X\n---\nReal Title\nlede text right after."),
      ).toBe("lede text right after.");
    });

    it("returns null for a frontmatter-only note with no body after the title", () => {
      expect(computeLede("---\ntitle: X\n---\nReal Title")).toBeNull();
    });
  });

  describe("markdown blocks that are not prose (vault#616)", () => {
    it("skips a fenced code block and returns the first prose paragraph after it", () => {
      expect(
        computeLede("# Title\n\n```js\nconst x = 1;\n```\n\nThe real lede."),
      ).toBe("The real lede.");
    });

    it("skips a fenced block that is not blank-line separated from the title", () => {
      expect(computeLede("# Title\n```\nraw\n```\n\nThe real lede.")).toBe("The real lede.");
    });

    it("skips a tilde-fenced code block", () => {
      expect(computeLede("# Title\n\n~~~\nraw\n~~~\n\nThe real lede.")).toBe("The real lede.");
    });

    it("skips a fence whose body contains blank lines", () => {
      expect(
        computeLede("# Title\n\n```\nline one\n\nline two\n```\n\nThe real lede."),
      ).toBe("The real lede.");
    });

    it("returns null when an unterminated fence runs to end of content", () => {
      expect(computeLede("# Title\n\n```js\nconst x = 1;")).toBeNull();
    });

    it("returns null when a code fence is all the content after the title", () => {
      expect(computeLede("# Title\n\n```js\nconst x = 1;\n```")).toBeNull();
    });

    it("skips a heading-only block rather than returning its raw marker", () => {
      expect(computeLede("# Title\n\n## Section\n\nThe real lede.")).toBe("The real lede.");
    });

    it("skips consecutive headings and fences until it finds prose", () => {
      expect(
        computeLede("# Title\n\n## Section\n\n### Sub\n\n```\ncode\n```\n\nThe real lede."),
      ).toBe("The real lede.");
    });

    it("returns null when only headings follow the title", () => {
      expect(computeLede("# Title\n\n## Section\n\n### Sub")).toBeNull();
    });

    it("keeps a paragraph whose FIRST line is a heading-marked line but has prose under it", () => {
      // A heading immediately followed by prose with no blank line: markdown
      // ends the heading at the newline, so the prose is the lede.
      expect(computeLede("# Title\n\n## Section\nThe real lede.")).toBe("The real lede.");
    });

    it("skips a setext underline / thematic break block under the title", () => {
      expect(computeLede("Title\n---\n\nThe real lede.")).toBe("The real lede.");
      expect(computeLede("# Title\n\n***\n\nThe real lede.")).toBe("The real lede.");
      expect(computeLede("Title\n===\n\nThe real lede.")).toBe("The real lede.");
    });

    it("does not mistake a prose line for a thematic break", () => {
      expect(computeLede("# Title\n\n--- and then some prose.")).toBe("--- and then some prose.");
    });
  });

  describe("length cap", () => {
    it("truncates to LEDE_MAX_LEN code points", () => {
      const longParagraph = "a".repeat(1000);
      const result = computeLede(`# Title\n\n${longParagraph}`)!;
      expect(result.length).toBe(LEDE_MAX_LEN);
      expect(result).toBe("a".repeat(LEDE_MAX_LEN));
    });

    it("does not truncate a lede at or under the cap", () => {
      const exact = "a".repeat(LEDE_MAX_LEN);
      expect(computeLede(`# Title\n\n${exact}`)).toBe(exact);
      const short = "short lede";
      expect(computeLede(`# Title\n\n${short}`)).toBe(short);
    });

    it("truncates by Unicode code point, not UTF-16 code unit (no split surrogate pairs)", () => {
      const emojiParagraph = "😀".repeat(500);
      const result = computeLede(`# Title\n\n${emojiParagraph}`)!;
      expect(Array.from(result).length).toBe(LEDE_MAX_LEN);
    });
  });
});
