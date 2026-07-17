/**
 * Title axis (ratified 2026-07-17): a note's title IS its first line —
 * derived from content, never stored. This file covers:
 *   - `computeDisplayTitle` derivation (first non-empty line, heading
 *     markers stripped, truncation, null-on-empty);
 *   - `displayTitle` presence on the lean `NoteIndex` shape, both via the
 *     MCP `query-notes` list path and the REST `GET /notes` list path.
 *
 * The search title-BOOST (ranking notes whose first line matches query
 * terms above the rest) lives in `search-title-boost.test.ts` — a
 * different concern (ranking) from derivation (this file).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import { computeDisplayTitle, toNoteIndex, DISPLAY_TITLE_MAX_LEN } from "./notes.js";
import type { Note } from "./types.js";

describe("computeDisplayTitle", () => {
  it("returns the first line when content is a single line", () => {
    expect(computeDisplayTitle("Grocery List")).toBe("Grocery List");
  });

  it("returns the first NON-EMPTY line, skipping leading blank lines", () => {
    expect(computeDisplayTitle("\n\n  \nReal Title\nbody text")).toBe("Real Title");
  });

  it("strips a leading markdown heading marker + its whitespace", () => {
    expect(computeDisplayTitle("# Grocery List\nmilk, eggs")).toBe("Grocery List");
    expect(computeDisplayTitle("## Section Two\nbody")).toBe("Section Two");
    expect(computeDisplayTitle("###### h6\nbody")).toBe("h6");
  });

  it("strips a heading marker with no space after it", () => {
    expect(computeDisplayTitle("###Title\nbody")).toBe("Title");
  });

  it("treats a heading-marker-only line as blank and moves to the next line", () => {
    expect(computeDisplayTitle("##\nReal Title")).toBe("Real Title");
  });

  it("does not strip markers past the first six (never a valid heading)", () => {
    // 7 leading `#`s: the regex only matches 1-6, so the 7th `#` survives
    // as ordinary content.
    expect(computeDisplayTitle("####### Title")).toBe("# Title");
  });

  it("returns null for empty content", () => {
    expect(computeDisplayTitle("")).toBeNull();
  });

  it("returns null for null/undefined content", () => {
    expect(computeDisplayTitle(null)).toBeNull();
    expect(computeDisplayTitle(undefined)).toBeNull();
  });

  it("returns null when content is whitespace-only", () => {
    expect(computeDisplayTitle("   \n\t\n   ")).toBeNull();
  });

  it("returns null when every line is a bare heading marker", () => {
    expect(computeDisplayTitle("#\n##\n### ")).toBeNull();
  });

  it("truncates to DISPLAY_TITLE_MAX_LEN code points", () => {
    const longTitle = "a".repeat(200);
    const result = computeDisplayTitle(longTitle)!;
    expect(result.length).toBe(DISPLAY_TITLE_MAX_LEN);
    expect(result).toBe("a".repeat(DISPLAY_TITLE_MAX_LEN));
  });

  it("does not truncate a title at or under the limit", () => {
    const exact = "a".repeat(DISPLAY_TITLE_MAX_LEN);
    expect(computeDisplayTitle(exact)).toBe(exact);
    const short = "short title";
    expect(computeDisplayTitle(short)).toBe(short);
  });

  it("truncates by Unicode code point, not UTF-16 code unit (no split surrogate pairs)", () => {
    // Astral-plane emoji are 2 UTF-16 code units each but 1 code point.
    const emojiTitle = "😀".repeat(150);
    const result = computeDisplayTitle(emojiTitle)!;
    expect(Array.from(result).length).toBe(DISPLAY_TITLE_MAX_LEN);
  });

  describe("leading frontmatter block (misuse path — direct create with raw frontmatter)", () => {
    it("skips a closed frontmatter block and derives the first line of the DOCUMENT", () => {
      expect(computeDisplayTitle("---\ntitle: X\n---\n# Real Title")).toBe("Real Title");
    });

    it("skips a closed frontmatter block with multiple fields + blank lines after", () => {
      expect(
        computeDisplayTitle("---\ntitle: X\ntags: [a, b]\n---\n\n\nReal Title\nbody"),
      ).toBe("Real Title");
    });

    it("falls back to treating an UNTERMINATED opening `---` as ordinary content", () => {
      // No closing fence anywhere in the content — a note whose real first
      // line is literally "---" (e.g. a markdown horizontal rule opener)
      // must not be mangled.
      expect(computeDisplayTitle("---\nnot frontmatter, just a rule\nmore text")).toBe("---");
    });

    it("returns null when content is EXACTLY a closed frontmatter block (nothing after)", () => {
      expect(computeDisplayTitle("---\ntitle: X\n---\n")).toBeNull();
      expect(computeDisplayTitle("---\ntitle: X\n---")).toBeNull();
    });

    it("returns null when only blank lines follow a closed frontmatter block", () => {
      expect(computeDisplayTitle("---\ntitle: X\n---\n\n  \n")).toBeNull();
    });

    it("does not treat a closing fence found past the bounded scan window as a frontmatter close", () => {
      // Opening `---` with the closing fence past FRONTMATTER_SCAN_LINES
      // (100): the scan gives up and falls back to ordinary-content
      // behavior, deriving from line 0.
      const filler = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n");
      expect(computeDisplayTitle(`---\n${filler}\n---\nReal Title`)).toBe("---");
    });

    it("normal content with no leading `---` is byte-identical to prior behavior", () => {
      expect(computeDisplayTitle("# Grocery List\nmilk, eggs")).toBe("Grocery List");
      expect(computeDisplayTitle("Just a note\nbody text")).toBe("Just a note");
    });
  });
});

describe("toNoteIndex — displayTitle wiring", () => {
  const baseNote: Note = {
    id: "n1",
    content: "# Real Title\nbody",
    createdAt: new Date().toISOString(),
    tags: [],
    metadata: {},
  };

  it("carries the computed display title onto the lean shape", () => {
    const index = toNoteIndex(baseNote);
    expect(index.displayTitle).toBe("Real Title");
  });

  it("is null when content is empty", () => {
    const index = toNoteIndex({ ...baseNote, content: "" });
    expect(index.displayTitle).toBeNull();
  });

  it("is null when content is missing entirely (defensive — matches preview's ?? \"\" fallback)", () => {
    const { content: _drop, ...rest } = baseNote;
    const index = toNoteIndex(rest as Note);
    expect(index.displayTitle).toBeNull();
  });
});

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("displayTitle — list-shape presence (MCP)", () => {
  it("query-notes list mode (include_content default false) carries displayTitle", async () => {
    await store.createNote("# Meeting Notes\nagenda: budget", { path: "a" });
    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const result = await queryNotes.execute({}) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].displayTitle).toBe("Meeting Notes");
    expect(result[0].content).toBeUndefined();
  });

  it("query-notes include_content=true does NOT carry displayTitle (full Note shape, unchanged)", async () => {
    await store.createNote("# Meeting Notes\nagenda: budget", { path: "a" });
    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const result = await queryNotes.execute({ include_content: true }) as any[];
    expect(result[0].content).toBeTruthy();
    expect(result[0].displayTitle).toBeUndefined();
  });

  it("displayTitle is null on the lean shape for an empty note", async () => {
    await store.createNote("", { path: "empty" });
    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const result = await queryNotes.execute({}) as any[];
    expect(result[0].displayTitle).toBeNull();
  });
});
