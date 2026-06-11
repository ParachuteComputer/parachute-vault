/**
 * Content range / pagination — bounded reads for large notes.
 *
 * MCP responses are size-limited: a 100KB+ transcript can't come back in
 * one `query-notes` call, and a remote MCP client has no `curl | head -c`
 * escape hatch. These helpers let a caller read note content in byte
 * windows:
 *
 *   request:  `content_offset` (default 0) + `content_length` (byte budget)
 *   response: `content` (the slice) + `content_offset` (effective start)
 *             + `content_total_length` + `content_next_offset`
 *             (`null` when the slice reaches the end)
 *
 * Unit is **UTF-8 bytes** — the same unit as `byteSize` on the lean
 * NoteIndex shape, and the natural unit for budgeting response size. But
 * naive byte-slicing can split a multi-byte codepoint, which would corrupt
 * the JSON string. So slices always end on a codepoint boundary *within*
 * the budget: a slice never exceeds `content_length` bytes but may come up
 * to 3 bytes short when a multi-byte character straddles the cut. A
 * `content_offset` that lands mid-codepoint (only possible when the caller
 * computes offsets by hand — chained `content_next_offset` values are
 * always boundary-aligned) is aligned DOWN to the codepoint's leading byte
 * so no bytes are ever skipped; the effective start is echoed back as
 * `content_offset` on the response.
 *
 * Reassembly invariant (pinned by content-range.test.ts): starting at
 * offset 0 and following `content_next_offset` until `null`, the
 * concatenation of slices is byte-identical to the full content.
 */

import { QueryError } from "./query-operators.js";

/**
 * Minimum accepted `content_length`. A UTF-8 codepoint is at most 4 bytes,
 * so any budget >= 4 is guaranteed to make progress (the codepoint at the
 * window start always fits). Budgets 1–3 could stall forever on a 4-byte
 * emoji (empty slice, next_offset == offset); rejecting them up front is
 * deterministic and simpler than a runtime "no progress" error.
 */
export const MIN_CONTENT_LENGTH = 4;

export interface ContentRange {
  /** Byte offset (UTF-8) to start reading from. */
  offset: number;
  /** Max bytes to return. Absent = read to the end. */
  length?: number;
}

export interface ContentRangeFields {
  content: string;
  /** Effective start (requested offset aligned down to a codepoint boundary). */
  content_offset: number;
  /** Full content size in UTF-8 bytes. */
  content_total_length: number;
  /** Byte offset to resume from, or null when the slice reaches the end. */
  content_next_offset: number | null;
}

function toNonNegativeInt(raw: unknown, name: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    if (raw.trim() === "") return undefined; // `?content_offset=` — treat empty as absent
    if (!/^\d+$/.test(raw.trim())) {
      throw new QueryError(
        `invalid \`${name}\` value ${JSON.stringify(raw)} — must be a non-negative integer (UTF-8 byte count).`,
        "INVALID_QUERY",
      );
    }
    n = Number(raw.trim());
  } else {
    throw new QueryError(
      `invalid \`${name}\` value — must be a non-negative integer (UTF-8 byte count).`,
      "INVALID_QUERY",
    );
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new QueryError(
      `invalid \`${name}\` value ${JSON.stringify(raw)} — must be a non-negative integer (UTF-8 byte count).`,
      "INVALID_QUERY",
    );
  }
  return n;
}

/**
 * Parse the `content_offset` / `content_length` pair. Returns `null` when
 * neither is present (range mode off — response shape byte-identical to
 * the no-pagination behavior). Throws `QueryError` (INVALID_QUERY) on
 * negative / non-integer values or a `content_length` below
 * {@link MIN_CONTENT_LENGTH}.
 *
 * Accepts numbers (MCP params) and decimal strings (REST query params);
 * empty strings count as absent.
 */
export function parseContentRange(offsetRaw: unknown, lengthRaw: unknown): ContentRange | null {
  const offset = toNonNegativeInt(offsetRaw, "content_offset");
  const length = toNonNegativeInt(lengthRaw, "content_length");
  if (offset === undefined && length === undefined) return null;
  if (length !== undefined && length < MIN_CONTENT_LENGTH) {
    throw new QueryError(
      `invalid \`content_length\` value ${JSON.stringify(lengthRaw)} — must be at least ${MIN_CONTENT_LENGTH} bytes (the size of the largest UTF-8 codepoint, so every window makes progress).`,
      "INVALID_QUERY",
    );
  }
  return { offset: offset ?? 0, ...(length !== undefined ? { length } : {}) };
}

/**
 * The error both faces raise when range params are combined with a
 * response shape that excludes content (`include_content=false`, or a
 * list query left on its lean default). Centralized so MCP and REST emit
 * the same message.
 */
export function contentRangeRequiresContent(): QueryError {
  return new QueryError(
    `content_offset/content_length apply to note content, but content is not included in this response shape. Pass include_content=true (lists default to false) or drop the range params.`,
    "INVALID_QUERY",
  );
}

/** True for UTF-8 continuation bytes (0b10xxxxxx). */
function isContinuationByte(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

/**
 * Slice `content` to the requested byte window, never splitting a UTF-8
 * codepoint and never exceeding `range.length` bytes. See module doc for
 * the alignment rules.
 */
export function sliceContentRange(content: string, range: ContentRange): ContentRangeFields {
  const bytes = Buffer.from(content, "utf8");
  const total = bytes.byteLength;

  // At/past the end: empty slice, complete. Graceful (not an error) so a
  // pagination loop that overshoots — e.g. the note shrank between calls —
  // terminates cleanly on `content_next_offset: null`.
  if (range.offset >= total) {
    return {
      content: "",
      content_offset: total,
      content_total_length: total,
      content_next_offset: null,
    };
  }

  // Align the start DOWN to the leading byte of the codepoint containing
  // `offset` — never skip bytes (a forward-align would drop them from
  // every window and break reassembly).
  let start = range.offset;
  while (start > 0 && isContinuationByte(bytes[start]!)) start--;

  // Window end: budget capped at total. Align DOWN so the slice doesn't
  // end mid-codepoint — under the budget, never over.
  let end = range.length === undefined ? total : Math.min(start + range.length, total);
  while (end > start && end < total && isContinuationByte(bytes[end]!)) end--;

  return {
    content: bytes.subarray(start, end).toString("utf8"),
    content_offset: start,
    content_total_length: total,
    content_next_offset: end >= total ? null : end,
  };
}

/**
 * Apply a content range to a shaped response object in place: replaces
 * `content` with the slice and adds `content_offset`,
 * `content_total_length`, `content_next_offset`. No-op fields are never
 * added when range mode is off — callers only invoke this with a parsed
 * (non-null) range.
 */
export function applyContentRange(
  result: { content?: unknown; [key: string]: unknown },
  range: ContentRange,
): void {
  const fields = sliceContentRange(typeof result.content === "string" ? result.content : "", range);
  result.content = fields.content;
  result.content_offset = fields.content_offset;
  result.content_total_length = fields.content_total_length;
  result.content_next_offset = fields.content_next_offset;
}
