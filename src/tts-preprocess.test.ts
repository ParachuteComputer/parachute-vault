/**
 * Tests for markdownToSpeech — the preprocessor that strips markdown
 * syntax before handing text to a TTS provider.
 *
 * The philosophy: we don't need to match a markdown parser byte-for-byte.
 * We need to guarantee that none of the common markdown markers leak
 * through to the synthesizer. Each test asserts both "the words survive"
 * and "the markers are gone".
 */

import { describe, test, expect } from "bun:test";
import { markdownToSpeech } from "./tts-preprocess.ts";

describe("markdownToSpeech", () => {
  test("returns empty string for empty input", () => {
    expect(markdownToSpeech("")).toBe("");
  });

  test("strips header markers, keeps header text", () => {
    const out = markdownToSpeech("# Monthly Summary\n\nsome body");
    expect(out).not.toContain("#");
    expect(out).toContain("Monthly Summary");
    expect(out).toContain("some body");
  });

  test("handles multiple header levels", () => {
    const out = markdownToSpeech("## Section\n\n### Subsection\n\nbody");
    expect(out).not.toContain("#");
    expect(out).toContain("Section");
    expect(out).toContain("Subsection");
  });

  test("strips bold and italic markers", () => {
    const out = markdownToSpeech("This is **bold** and *italic* and _also italic_.");
    expect(out).toBe("This is bold and italic and also italic.");
  });

  test("strips strikethrough markers", () => {
    const out = markdownToSpeech("This is ~~gone~~ text.");
    expect(out).toBe("This is gone text.");
  });

  test("strips inline code backticks", () => {
    const out = markdownToSpeech("Run `bun test` now.");
    expect(out).toBe("Run bun test now.");
    expect(out).not.toContain("`");
  });

  test("silently drops fenced code blocks", () => {
    const input = [
      "Before the code.",
      "",
      "```ts",
      "const x = 42;",
      "console.log(x);",
      "```",
      "",
      "After the code.",
    ].join("\n");
    const out = markdownToSpeech(input);
    expect(out).toContain("Before the code");
    expect(out).toContain("After the code");
    expect(out).not.toContain("const x");
    expect(out).not.toContain("```");
  });

  test("flattens links to their visible text", () => {
    const out = markdownToSpeech("See [the docs](https://example.com/docs) for more.");
    expect(out).toBe("See the docs for more.");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("[");
  });

  test("flattens images to their alt text", () => {
    const out = markdownToSpeech("Here: ![a cat](https://example.com/cat.png) cute");
    expect(out).toContain("a cat");
    expect(out).toContain("cute");
    expect(out).not.toContain("!");
    expect(out).not.toContain("https://");
  });

  test("flattens unordered list markers and paces items", () => {
    const input = ["- first item", "- second item", "- third item"].join("\n");
    const out = markdownToSpeech(input);
    expect(out).not.toMatch(/^-/m);
    expect(out).toContain("first item.");
    expect(out).toContain("second item.");
    expect(out).toContain("third item.");
  });

  test("flattens ordered list markers", () => {
    const input = ["1. alpha", "2. beta", "3. gamma"].join("\n");
    const out = markdownToSpeech(input);
    expect(out).not.toMatch(/^\d+\./m);
    expect(out).toContain("alpha.");
    expect(out).toContain("beta.");
    expect(out).toContain("gamma.");
  });

  test("strips blockquote markers", () => {
    const out = markdownToSpeech("> a wise thing\n> someone said");
    expect(out).not.toContain(">");
    expect(out).toContain("a wise thing");
    expect(out).toContain("someone said");
  });

  test("drops horizontal rules", () => {
    const out = markdownToSpeech("before\n\n---\n\nafter");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("---");
  });

  test("strips HTML tags", () => {
    const out = markdownToSpeech("Hello <strong>bold</strong> <br/> world");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("Hello");
    expect(out).toContain("bold");
    expect(out).toContain("world");
  });

  test("collapses multiple blank lines to a single paragraph break", () => {
    const out = markdownToSpeech("para one\n\n\n\n\npara two");
    expect(out).toBe("para one\n\npara two");
  });

  test("normalizes runs of spaces", () => {
    const out = markdownToSpeech("too    many     spaces");
    expect(out).toBe("too many spaces");
  });

  test("realistic Monthly Summary fragment: no markdown markers survive", () => {
    const input = [
      "# Monthly Summary — March 2026",
      "",
      "**Captured notes:** 42 total across 7 tags.",
      "",
      "## Highlights",
      "",
      "- Shipped the ~~old~~ new `tts` pipeline with [Kokoro](https://github.com/kokoro).",
      "- Wrote *three* state notes to Vault.",
      "- Closed **5** issues.",
      "",
      "> Quote of the month: \"slow is smooth, smooth is fast\".",
      "",
      "---",
      "",
      "See you in April.",
    ].join("\n");

    const out = markdownToSpeech(input);

    // No markdown markers survive.
    expect(out).not.toContain("#");
    expect(out).not.toContain("**");
    expect(out).not.toContain("~~");
    expect(out).not.toContain("`");
    expect(out).not.toContain("](");
    expect(out).not.toContain("[");
    expect(out).not.toMatch(/^>/m);
    expect(out).not.toContain("---");
    expect(out).not.toMatch(/^-\s/m);

    // Core content survives.
    expect(out).toContain("Monthly Summary");
    expect(out).toContain("March 2026");
    expect(out).toContain("Captured notes");
    expect(out).toContain("42 total");
    expect(out).toContain("Highlights");
    expect(out).toContain("Kokoro");
    expect(out).toContain("three");
    expect(out).toContain("5");
    expect(out).toContain("Quote of the month");
    expect(out).toContain("slow is smooth");
    expect(out).toContain("See you in April");

    // URL was dropped.
    expect(out).not.toContain("github.com");
  });

  test("link with parens in the URL doesn't leak the trailing paren", () => {
    // Wikipedia and GitHub URLs commonly contain parens — the link
    // regex must consume them as part of the URL, not stop at the
    // first `)`.
    const out = markdownToSpeech(
      "See [Wikipedia](https://en.wikipedia.org/wiki/Wu_wei_(philosophy)) for more.",
    );
    expect(out).toBe("See Wikipedia for more.");
    expect(out).not.toContain(")");
    expect(out).not.toContain("(");
  });

  test("image with parens in src doesn't leak the trailing paren", () => {
    const out = markdownToSpeech("![diagram](path/to/(v2).png)\n\nbody");
    expect(out).not.toContain(")");
    expect(out).not.toContain("(");
    expect(out).toContain("diagram");
    expect(out).toContain("body");
  });

  test("note containing only a fenced code block returns empty string", () => {
    // The hook handler is responsible for guarding against this case
    // and not leaving the note stuck in audio_pending_at; this test
    // documents that the preprocessor itself returns empty as expected.
    const out = markdownToSpeech("```python\nprint('hi')\n```");
    expect(out).toBe("");
  });

  test("note containing only horizontal rules returns empty string", () => {
    const out = markdownToSpeech("---\n\n***\n\n___");
    expect(out).toBe("");
  });
});
