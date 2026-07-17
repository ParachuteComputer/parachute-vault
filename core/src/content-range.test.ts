/**
 * Content range / pagination tests — bounded reads for large notes.
 *
 * Three layers:
 *   1. Unit tests of the parse + slice helpers (boundary cases: offset
 *      past end, sub-minimum budget, multi-byte codepoints at the cut).
 *   2. Property test of the reassembly invariant: walking a string from
 *      offset 0 via `content_next_offset` and concatenating the slices is
 *      byte-identical to the full content, for arbitrary unicode content
 *      and budgets — and no slice ever exceeds the byte budget.
 *   3. MCP face (`query-notes` execute): single + list shapes, the
 *      include_content interaction, and the no-params regression
 *      (response shape byte-identical to pre-pagination behavior).
 *
 * The REST face is exercised in src/content-range-routes.test.ts.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import {
  parseContentRange,
  sliceContentRange,
  applyContentRange,
  parseAttachmentContentRange,
  alignByteWindow,
  MIN_CONTENT_LENGTH,
  DEFAULT_ATTACHMENT_WINDOW_BYTES,
  MAX_ATTACHMENT_WINDOW_BYTES,
} from "./content-range.js";
import { QueryError } from "./query-operators.js";

// ---------------------------------------------------------------------------
// 1. parseContentRange
// ---------------------------------------------------------------------------

describe("parseContentRange", () => {
  it("returns null when neither param is present (range mode off)", () => {
    expect(parseContentRange(undefined, undefined)).toBeNull();
    expect(parseContentRange(null, null)).toBeNull();
  });

  it("treats empty strings as absent (REST `?content_offset=`)", () => {
    expect(parseContentRange("", "")).toBeNull();
  });

  it("offset only → length omitted (read to end)", () => {
    expect(parseContentRange(10, undefined)).toEqual({ offset: 10 });
  });

  it("length only → offset defaults to 0", () => {
    expect(parseContentRange(undefined, 64)).toEqual({ offset: 0, length: 64 });
  });

  it("accepts decimal strings (REST query params)", () => {
    expect(parseContentRange("5", "1024")).toEqual({ offset: 5, length: 1024 });
  });

  it("rejects negative offset", () => {
    expect(() => parseContentRange(-1, undefined)).toThrow(/content_offset/);
  });

  it("rejects non-integer values", () => {
    expect(() => parseContentRange(1.5, undefined)).toThrow(/content_offset/);
    expect(() => parseContentRange(undefined, 7.2)).toThrow(/content_length/);
    expect(() => parseContentRange("abc", undefined)).toThrow(/content_offset/);
    expect(() => parseContentRange(undefined, "-4")).toThrow(/content_length/);
  });

  it(`rejects zero / negative / sub-minimum budget (< ${MIN_CONTENT_LENGTH})`, () => {
    expect(() => parseContentRange(undefined, 0)).toThrow(/content_length/);
    expect(() => parseContentRange(undefined, -8)).toThrow(/content_length/);
    expect(() => parseContentRange(undefined, MIN_CONTENT_LENGTH - 1)).toThrow(/content_length/);
    // The minimum itself is fine.
    expect(parseContentRange(undefined, MIN_CONTENT_LENGTH)).toEqual({
      offset: 0,
      length: MIN_CONTENT_LENGTH,
    });
  });

  it("throws QueryError with INVALID_QUERY code", () => {
    try {
      parseContentRange(undefined, 2);
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.name).toBe("QueryError");
      expect(e.code).toBe("INVALID_QUERY");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. sliceContentRange — boundary cases
// ---------------------------------------------------------------------------

describe("sliceContentRange", () => {
  it("plain ASCII window", () => {
    const r = sliceContentRange("hello world", { offset: 0, length: 5 });
    expect(r.content).toBe("hello");
    expect(r.content_offset).toBe(0);
    expect(r.content_total_length).toBe(11);
    expect(r.content_next_offset).toBe(5);
  });

  it("continuation window reaches the end → next_offset null", () => {
    const r = sliceContentRange("hello world", { offset: 5, length: 100 });
    expect(r.content).toBe(" world");
    expect(r.content_next_offset).toBeNull();
  });

  it("offset with no length reads to the end", () => {
    const r = sliceContentRange("hello world", { offset: 6 });
    expect(r.content).toBe("world");
    expect(r.content_total_length).toBe(11);
    expect(r.content_next_offset).toBeNull();
  });

  it("offset exactly at end → empty slice, complete", () => {
    const r = sliceContentRange("abc", { offset: 3 });
    expect(r.content).toBe("");
    expect(r.content_offset).toBe(3);
    expect(r.content_total_length).toBe(3);
    expect(r.content_next_offset).toBeNull();
  });

  it("offset past end → empty slice, complete (graceful loop termination)", () => {
    const r = sliceContentRange("abc", { offset: 999, length: 16 });
    expect(r.content).toBe("");
    expect(r.content_offset).toBe(3); // clamped to total
    expect(r.content_total_length).toBe(3);
    expect(r.content_next_offset).toBeNull();
  });

  it("empty content → empty slice, total 0", () => {
    const r = sliceContentRange("", { offset: 0, length: 16 });
    expect(r.content).toBe("");
    expect(r.content_total_length).toBe(0);
    expect(r.content_next_offset).toBeNull();
  });

  it("budget cutting mid-codepoint backs off to the boundary (never over budget)", () => {
    // "ab😀cd" — bytes: a=0, b=1, 😀=2..5 (4 bytes), c=6, d=7; total 8.
    const s = "ab\u{1F600}cd";
    expect(Buffer.byteLength(s, "utf8")).toBe(8);

    // Budget 5 would cut mid-emoji → slice backs off to byte 2.
    const r1 = sliceContentRange(s, { offset: 0, length: 5 });
    expect(r1.content).toBe("ab");
    expect(Buffer.byteLength(r1.content, "utf8")).toBeLessThanOrEqual(5);
    expect(r1.content_next_offset).toBe(2);

    // Next window picks up the whole emoji.
    const r2 = sliceContentRange(s, { offset: 2, length: 4 });
    expect(r2.content).toBe("\u{1F600}");
    expect(r2.content_next_offset).toBe(6);

    // Final window.
    const r3 = sliceContentRange(s, { offset: 6, length: 4 });
    expect(r3.content).toBe("cd");
    expect(r3.content_next_offset).toBeNull();
  });

  it("offset landing mid-codepoint aligns DOWN (no bytes skipped) and echoes the effective offset", () => {
    const s = "ab\u{1F600}cd"; // emoji occupies bytes 2..5
    const r = sliceContentRange(s, { offset: 4, length: 8 });
    expect(r.content_offset).toBe(2); // aligned down to the emoji's lead byte
    expect(r.content).toBe("\u{1F600}cd");
    expect(r.content_next_offset).toBeNull();
  });

  it("minimum budget always makes progress, even on a 4-byte codepoint", () => {
    const s = "\u{1F600}\u{1F601}"; // two 4-byte emoji
    const r = sliceContentRange(s, { offset: 0, length: MIN_CONTENT_LENGTH });
    expect(r.content).toBe("\u{1F600}");
    expect(r.content_next_offset).toBe(4);
  });

  it("applyContentRange mutates the shaped result in place", () => {
    const result: any = { id: "n1", content: "hello world", tags: ["x"] };
    applyContentRange(result, { offset: 0, length: 5 });
    expect(result.content).toBe("hello");
    expect(result.content_offset).toBe(0);
    expect(result.content_total_length).toBe(11);
    expect(result.content_next_offset).toBe(5);
    expect(result.tags).toEqual(["x"]); // untouched
  });
});

// ---------------------------------------------------------------------------
// 2b. Property test — reassembly invariant
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("content range — reassembly property", () => {
  // Mixed-width pool: 1-byte ASCII, 2-byte (é, ψ), 3-byte (你, ‱), 4-byte
  // (😀, 𝄞) — plus whitespace, so windows land on every codepoint width.
  const POOL = ["a", "Z", "9", " ", "\n", "é", "ψ", "你", "‱", "\u{1F600}", "\u{1D11E}"];

  it("concatenating all slices is byte-identical to the full content; no slice exceeds the budget", () => {
    const rand = mulberry32(0xc0ffee);
    for (let iter = 0; iter < 60; iter++) {
      const charCount = Math.floor(rand() * 120); // includes 0 (empty content)
      let content = "";
      for (let i = 0; i < charCount; i++) {
        content += POOL[Math.floor(rand() * POOL.length)]!;
      }
      const budget = MIN_CONTENT_LENGTH + Math.floor(rand() * 13); // 4..16 bytes
      const totalBytes = Buffer.byteLength(content, "utf8");

      let offset = 0;
      let assembled = "";
      let lastTotal: number | null = null;
      // Hard ceiling on iterations: every window must advance by >= 1 byte.
      for (let step = 0; step <= totalBytes + 2; step++) {
        const slice = sliceContentRange(content, { offset, length: budget });
        expect(Buffer.byteLength(slice.content, "utf8")).toBeLessThanOrEqual(budget);
        expect(slice.content_total_length).toBe(totalBytes);
        lastTotal = slice.content_total_length;
        assembled += slice.content;
        if (slice.content_next_offset === null) break;
        // Progress guarantee — next offset strictly advances.
        expect(slice.content_next_offset).toBeGreaterThan(offset);
        offset = slice.content_next_offset;
      }

      expect(assembled).toBe(content);
      expect(Buffer.from(assembled, "utf8").equals(Buffer.from(content, "utf8"))).toBe(true);
      expect(lastTotal).toBe(totalBytes);
    }
  });
});

// ---------------------------------------------------------------------------
// 2c. parseAttachmentContentRange + alignByteWindow (read-attachment)
// ---------------------------------------------------------------------------

describe("parseAttachmentContentRange", () => {
  it("defaults offset=0, length=DEFAULT_ATTACHMENT_WINDOW_BYTES when both are omitted", () => {
    expect(parseAttachmentContentRange(undefined, undefined)).toEqual({
      offset: 0,
      length: DEFAULT_ATTACHMENT_WINDOW_BYTES,
    });
  });

  it("offset only → length still defaults (never 'read to end' — that's the query-notes shape, not this one)", () => {
    expect(parseAttachmentContentRange(1000, undefined)).toEqual({
      offset: 1000,
      length: DEFAULT_ATTACHMENT_WINDOW_BYTES,
    });
  });

  it("accepts an explicit length up to the max", () => {
    expect(parseAttachmentContentRange(0, MAX_ATTACHMENT_WINDOW_BYTES)).toEqual({
      offset: 0,
      length: MAX_ATTACHMENT_WINDOW_BYTES,
    });
  });

  it("rejects a length below MIN_CONTENT_LENGTH", () => {
    expect(() => parseAttachmentContentRange(0, 2)).toThrow(QueryError);
  });

  it("rejects a length above MAX_ATTACHMENT_WINDOW_BYTES", () => {
    expect(() => parseAttachmentContentRange(0, MAX_ATTACHMENT_WINDOW_BYTES + 1)).toThrow(QueryError);
  });

  it("rejects a negative offset", () => {
    expect(() => parseAttachmentContentRange(-1, undefined)).toThrow(QueryError);
  });
});

describe("alignByteWindow", () => {
  /**
   * Simulates the real caller: a BOUNDED positional read of
   * `[max(0, offset-3), min(total, offset+length))` from `full`, THEN
   * alignment — never handing the whole buffer to `alignByteWindow`, so a
   * pass here proves the "never load the whole file" contract actually
   * holds and isn't just true by accident of the test passing the full
   * buffer.
   */
  function boundedRead(full: Buffer, offset: number, length: number): { raw: Uint8Array; rawStart: number } {
    const total = full.byteLength;
    const rawStart = Math.max(0, offset - 3);
    // +1: alignByteWindow's end-boundary check reads the byte AT the
    // (exclusive) window end to decide whether it's a continuation byte —
    // that's one byte past `offset + length`, so the read must include it
    // (see alignByteWindow's doc comment precondition).
    const rawEnd = Math.min(total, offset + length + 1);
    return { raw: full.subarray(rawStart, Math.max(rawStart, rawEnd)), rawStart };
  }

  it("offset past end → empty slice, complete (mirrors sliceContentRange)", () => {
    const full = Buffer.from("abc", "utf8");
    const { raw, rawStart } = boundedRead(full, 999, 16);
    const r = alignByteWindow(raw, rawStart, { offset: 999, length: 16 }, full.byteLength);
    expect(r.content).toBe("");
    expect(r.content_offset).toBe(3);
    expect(r.content_total_length).toBe(3);
    expect(r.content_next_offset).toBeNull();
  });

  it("matches sliceContentRange byte-for-byte on a plain ASCII window", () => {
    const s = "hello world";
    const full = Buffer.from(s, "utf8");
    const { raw, rawStart } = boundedRead(full, 0, 5);
    const bounded = alignByteWindow(raw, rawStart, { offset: 0, length: 5 }, full.byteLength);
    const whole = sliceContentRange(s, { offset: 0, length: 5 });
    expect(bounded).toEqual(whole);
  });

  it("never splits a codepoint under a bounded read (matches sliceContentRange across a 4-byte emoji)", () => {
    const s = "ab\u{1F600}cd"; // emoji occupies bytes 2..5 of 8
    const full = Buffer.from(s, "utf8");
    for (const [offset, length] of [
      [0, 5], // budget cuts mid-emoji → backs off to byte 2
      [2, 4], // exact emoji window
      [4, 8], // offset lands mid-emoji → aligns down to byte 2
      [6, 4], // final ASCII tail
    ] as const) {
      const { raw, rawStart } = boundedRead(full, offset, length);
      const bounded = alignByteWindow(raw, rawStart, { offset, length }, full.byteLength);
      const whole = sliceContentRange(s, { offset, length });
      expect(bounded).toEqual(whole);
    }
  });

  it("reassembly property: chaining content_next_offset through BOUNDED reads reproduces the full content", () => {
    const rand = mulberry32(0xba5eba11);
    const POOL = ["a", "Z", "9", " ", "\n", "é", "ψ", "你", "‱", "\u{1F600}", "\u{1D11E}"];
    for (let iter = 0; iter < 40; iter++) {
      const charCount = Math.floor(rand() * 100);
      let content = "";
      for (let i = 0; i < charCount; i++) content += POOL[Math.floor(rand() * POOL.length)]!;
      const full = Buffer.from(content, "utf8");
      const total = full.byteLength;
      const budget = MIN_CONTENT_LENGTH + Math.floor(rand() * 13); // 4..16 bytes

      let offset = 0;
      let assembled = "";
      for (let step = 0; step <= total + 2; step++) {
        const { raw, rawStart } = boundedRead(full, offset, budget);
        const slice = alignByteWindow(raw, rawStart, { offset, length: budget }, total);
        expect(Buffer.byteLength(slice.content, "utf8")).toBeLessThanOrEqual(budget);
        expect(slice.content_total_length).toBe(total);
        assembled += slice.content;
        if (slice.content_next_offset === null) break;
        expect(slice.content_next_offset).toBeGreaterThan(offset);
        offset = slice.content_next_offset;
      }
      expect(assembled).toBe(content);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. MCP face — query-notes
// ---------------------------------------------------------------------------

describe("MCP query-notes — content range", () => {
  let db: Database;
  let store: SqliteStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new SqliteStore(db);
  });

  function queryTool() {
    const tools = generateMcpTools(store);
    return tools.find((t) => t.name === "query-notes")!;
  }

  it("single note: paged read loop reassembles the full content", async () => {
    // Mixed-width content so windows hit multi-byte boundaries.
    const content = ("section \u{1F600} 你好 " .repeat(40)).trim();
    const note = await store.createNote(content);
    const query = queryTool();

    let offset = 0;
    let assembled = "";
    for (;;) {
      const r: any = await query.execute({ id: note.id, content_offset: offset, content_length: 64 });
      expect(r.content_total_length).toBe(Buffer.byteLength(content, "utf8"));
      assembled += r.content;
      if (r.content_next_offset === null) break;
      offset = r.content_next_offset;
    }
    expect(assembled).toBe(content);
  });

  it("single note: response carries the range fields and the slice", async () => {
    const note = await store.createNote("0123456789");
    const r: any = await queryTool().execute({ id: note.id, content_length: 4 });
    expect(r.content).toBe("0123");
    expect(r.content_offset).toBe(0);
    expect(r.content_total_length).toBe(10);
    expect(r.content_next_offset).toBe(4);
    expect(r.id).toBe(note.id); // rest of the note shape intact
  });

  it("single note, no range params → byte-identical to today (regression)", async () => {
    const note = await store.createNote("full body here");
    const r: any = await queryTool().execute({ id: note.id });
    expect(r.content).toBe("full body here");
    expect("content_total_length" in r).toBe(false);
    expect("content_next_offset" in r).toBe(false);
    expect("content_offset" in r).toBe(false);
  });

  it("single note: content_offset past end → empty slice, complete", async () => {
    const note = await store.createNote("abc");
    const r: any = await queryTool().execute({ id: note.id, content_offset: 999 });
    expect(r.content).toBe("");
    expect(r.content_total_length).toBe(3);
    expect(r.content_next_offset).toBeNull();
  });

  it("single note: include_content=false + range params → loud error", async () => {
    const note = await store.createNote("abc");
    expect(
      queryTool().execute({ id: note.id, include_content: false, content_length: 8 }),
    ).rejects.toThrow(/include_content/);
  });

  it("rejects sub-minimum / invalid budgets before any query work", async () => {
    const note = await store.createNote("abc");
    expect(queryTool().execute({ id: note.id, content_length: 0 })).rejects.toThrow(/content_length/);
    expect(queryTool().execute({ id: note.id, content_length: -5 })).rejects.toThrow(/content_length/);
    expect(queryTool().execute({ id: note.id, content_length: 2 })).rejects.toThrow(/content_length/);
    expect(queryTool().execute({ id: note.id, content_offset: -1 })).rejects.toThrow(/content_offset/);
  });

  it("list query: include_content=true applies the window per note", async () => {
    await store.createNote("alpha alpha alpha", { tags: ["big"] });
    await store.createNote("beta beta beta beta", { tags: ["big"] });
    const out: any[] = (await queryTool().execute({
      tag: "big",
      include_content: true,
      content_length: 5,
    })) as any[];
    expect(out.length).toBe(2);
    for (const n of out) {
      expect(Buffer.byteLength(n.content, "utf8")).toBeLessThanOrEqual(5);
      expect(typeof n.content_total_length).toBe("number");
      expect(n.content_next_offset).toBe(5);
    }
  });

  it("list query: lean default (no include_content) + range params → loud error", async () => {
    await store.createNote("alpha", { tags: ["big"] });
    expect(queryTool().execute({ tag: "big", content_length: 8 })).rejects.toThrow(
      /include_content/,
    );
  });

  it("list query, no range params → no range fields injected (regression)", async () => {
    await store.createNote("alpha", { tags: ["big"] });
    const out: any[] = (await queryTool().execute({ tag: "big", include_content: true })) as any[];
    expect(out.length).toBe(1);
    expect("content_total_length" in out[0]).toBe(false);
    expect("content_next_offset" in out[0]).toBe(false);
  });

  it("expand_links: the range applies to the EXPANDED content", async () => {
    await store.createNote("inlined body of B", { path: "B" });
    const a = await store.createNote("A says: [[B]]", { path: "A" });
    const query = queryTool();

    const unpaged: any = await query.execute({ id: a.id, expand_links: true });
    const paged: any = await query.execute({
      id: a.id,
      expand_links: true,
      content_offset: 0,
      content_length: 100000,
    });
    expect(paged.content).toBe(unpaged.content);
    expect(paged.content_total_length).toBe(Buffer.byteLength(unpaged.content, "utf8"));
    expect(paged.content_next_offset).toBeNull();
  });

  it("query-notes schema advertises the params (MCP discovery)", () => {
    const query = queryTool();
    const props = (query.inputSchema as any).properties;
    expect(props.content_offset).toBeDefined();
    expect(props.content_length).toBeDefined();
    expect(query.description).toContain("content_offset");
    expect(query.description).toContain("content_next_offset");
  });
});
