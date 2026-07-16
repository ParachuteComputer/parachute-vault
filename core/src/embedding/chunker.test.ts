import { describe, it, expect } from "bun:test";
import { chunkNoteContent, DEFAULT_TARGET_CHARS, DEFAULT_MIN_CHARS } from "./chunker.js";

describe("chunkNoteContent", () => {
  it("returns a single empty chunk for empty content", () => {
    expect(chunkNoteContent("")).toEqual([{ ix: 0, text: "" }]);
    expect(chunkNoteContent("   \n\n  ")).toEqual([{ ix: 0, text: "" }]);
  });

  it("degenerate case: a short note is a single whole-note chunk", () => {
    const content = "A short morning-pages note about coffee and focus.";
    const chunks = chunkNoteContent(content);
    expect(chunks).toEqual([{ ix: 0, text: content }]);
  });

  it("a note exactly at the target size is still a single chunk", () => {
    const content = "x".repeat(DEFAULT_TARGET_CHARS);
    const chunks = chunkNoteContent(content);
    expect(chunks.length).toBe(1);
    expect(chunks[0].ix).toBe(0);
  });

  it("splits a long note on markdown headings, keeping the heading with its section", () => {
    const section = (n: number) => "word ".repeat(Math.ceil(DEFAULT_TARGET_CHARS / 5)) + `end${n}`;
    const content = [
      `# Heading One`,
      section(1),
      `## Heading Two`,
      section(2),
      `### Heading Three`,
      section(3),
    ].join("\n\n");

    const chunks = chunkNoteContent(content);
    expect(chunks.length).toBe(3);
    expect(chunks[0].text.startsWith("# Heading One")).toBe(true);
    expect(chunks[1].text.startsWith("## Heading Two")).toBe(true);
    expect(chunks[2].text.startsWith("### Heading Three")).toBe(true);
    // Sequential 0-based ix.
    expect(chunks.map((c) => c.ix)).toEqual([0, 1, 2]);
  });

  it("packs paragraphs within an over-long headingless section up to the target size", () => {
    const para = "sentence ".repeat(30); // a few hundred chars
    const paras = Array.from({ length: 20 }, (_, i) => `${para}${i}`);
    const content = paras.join("\n\n");
    expect(content.length).toBeGreaterThan(DEFAULT_TARGET_CHARS * 2);

    const chunks = chunkNoteContent(content);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should wildly exceed the target (a single paragraph can
    // exceed it, but these paragraphs are all well under target size).
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(DEFAULT_TARGET_CHARS + para.length);
    }
    // Every paragraph's marker text survives somewhere in the chunk set.
    for (let i = 0; i < paras.length; i++) {
      expect(chunks.some((c) => c.text.includes(`${para}${i}`))).toBe(true);
    }
  });

  it("a single oversized paragraph becomes its own chunk rather than being hard-truncated", () => {
    const hugeParagraph = "word ".repeat(Math.ceil((DEFAULT_TARGET_CHARS * 2) / 5));
    const content = `intro paragraph here\n\n${hugeParagraph}\n\nclosing paragraph here`;
    const chunks = chunkNoteContent(content);
    const hugeChunk = chunks.find((c) => c.text.includes(hugeParagraph.slice(0, 20)));
    expect(hugeChunk).toBeDefined();
    // Not truncated: the full paragraph text is present verbatim.
    expect(hugeChunk!.text).toContain(hugeParagraph.trim());
  });

  it("merges a tiny trailing fragment into the previous chunk instead of leaving it alone", () => {
    const bigSection = (n: number) => "word ".repeat(Math.ceil(DEFAULT_TARGET_CHARS / 5)) + `end${n}`;
    const tinyTail = "ok"; // far under DEFAULT_MIN_CHARS
    const content = [`# One`, bigSection(1), `# Two`, bigSection(2), `# Three`, tinyTail].join("\n\n");

    const chunks = chunkNoteContent(content);
    // The tiny "# Three\n\nok" section merges into the preceding chunk —
    // it must NOT appear as its own separate chunk.
    expect(chunks.some((c) => c.text.trim() === "# Three\n\nok" || c.text.trim() === "ok")).toBe(false);
    // But its content is still present, folded into the last chunk.
    expect(chunks[chunks.length - 1].text).toContain("ok");
  });

  it("respects custom targetChars/minChars options", () => {
    const content = Array.from({ length: 10 }, (_, i) => `paragraph number ${i} `.repeat(5)).join("\n\n");
    const chunks = chunkNoteContent(content, { targetChars: 100, minChars: 20 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("chunk indices are always sequential starting at 0", () => {
    const section = (n: number) => "word ".repeat(Math.ceil(DEFAULT_TARGET_CHARS / 5)) + `end${n}`;
    const content = Array.from({ length: 5 }, (_, i) => `## Section ${i}\n\n${section(i)}`).join("\n\n");
    const chunks = chunkNoteContent(content);
    expect(chunks.map((c) => c.ix)).toEqual(chunks.map((_, i) => i));
  });
});
