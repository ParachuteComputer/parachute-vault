/**
 * Per-section chunking for semantic search (V2, ratified in-scope by Aaron
 * per P0's finding — see `SEMANTIC-MVP-PLAN.md`/`RESULTS.md` §6: whole-note
 * embedding dilutes long, multi-topic journal entries, and that dilution —
 * not truncation — was the dominant miss pattern on Aaron's real corpus).
 *
 * Pure function, no I/O, no model dependency. Splits note content into
 * chunks targeting ~400–500 tokens, using a `chars/4` approximation
 * (documented, not exact — an exact tokenizer count would require a
 * model-specific tokenizer in core, which core's dependency-purity rule
 * forbids; the approximation only shapes chunk BOUNDARIES, not what gets
 * embedded, so being off by a few dozen tokens costs nothing but a
 * slightly-off chunk size). Splits on markdown headings first, then
 * paragraphs within an over-long section, then merges chunks that end up
 * too small into a neighbor so recall isn't fragmented by tiny slivers.
 *
 * Degenerate case: a note whose whole content already fits under the
 * target size is returned as a single chunk (`ix: 0`) — this is the same
 * shape a v1 whole-note embedding would produce, so a short note costs
 * nothing extra.
 */

/** One chunk of a note's content, ready to embed. */
export interface Chunk {
  /** 0-based chunk index within the note — the `note_vectors.chunk_ix` key. */
  ix: number;
  /** The chunk's text, ready to hand to `EmbeddingProvider.embed()`. */
  text: string;
}

/** `chars/4` is the documented, approximate chars-per-token ratio used to size chunks — see module doc. */
const CHARS_PER_TOKEN_APPROX = 4;

/** Middle of the plan's ~400–500 token target band. */
const TARGET_TOKENS = 450;

/** Default target chunk size in characters (~450 tokens). */
export const DEFAULT_TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN_APPROX;

/** Default minimum chunk size before it gets merged into a neighbor (~1/4 of target). */
export const DEFAULT_MIN_CHARS = Math.floor(DEFAULT_TARGET_CHARS / 4);

export interface ChunkOpts {
  /** Target chunk size in characters. Default `DEFAULT_TARGET_CHARS` (~1800 chars ≈ 450 tokens). */
  targetChars?: number;
  /** Chunks below this size get merged into the previous chunk. Default `DEFAULT_MIN_CHARS`. */
  minChars?: number;
}

/**
 * Split note content into embedding-ready chunks.
 *
 * Empty/whitespace-only content returns a single degenerate chunk with
 * empty text (`ix: 0`) — callers (the staleness gate, the embed-on-write
 * hook) treat an empty chunk as "nothing to embed" rather than special-
 * casing zero chunks.
 */
export function chunkNoteContent(content: string, opts: ChunkOpts = {}): Chunk[] {
  const targetChars = opts.targetChars ?? DEFAULT_TARGET_CHARS;
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;

  const trimmed = content.trim();
  if (trimmed.length === 0) return [{ ix: 0, text: "" }];
  // Degenerate case (the common one — most notes are short): whole note
  // fits in one chunk, byte-identical in spirit to v1's whole-note embed.
  if (trimmed.length <= targetChars) return [{ ix: 0, text: trimmed }];

  const sections = splitOnHeadings(trimmed);
  const rawChunks: string[] = [];
  for (const section of sections) {
    if (section.length <= targetChars) {
      rawChunks.push(section);
      continue;
    }
    rawChunks.push(...packParagraphs(section, targetChars));
  }

  const merged = mergeSmallChunks(rawChunks, minChars);
  return merged.map((text, ix) => ({ ix, text }));
}

/**
 * Split on markdown ATX headings (`#` through `######`), keeping each
 * heading attached to the section that follows it (so a chunk boundary
 * never separates a heading from its own content). Text before the first
 * heading (or a note with no headings at all) is its own leading section.
 */
function splitOnHeadings(text: string): string[] {
  const lines = text.split("\n");
  const sections: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && buf.length > 0) {
      sections.push(buf.join("\n").trim());
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length > 0) sections.push(buf.join("\n").trim());
  return sections.filter((s) => s.length > 0);
}

/** Split a section on blank-line-delimited paragraphs. */
function splitOnParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Greedily pack a section's paragraphs into chunks up to `targetChars`.
 * A single paragraph that alone exceeds `targetChars` becomes its own
 * oversized chunk — chunking never hard-truncates content; the provider's
 * own model window does that truncation, same as v1's whole-note path.
 *
 * If the section opens with its own markdown heading (the common case —
 * `splitOnHeadings` attaches a heading to the section that follows it),
 * the heading is pulled out and glued onto ONLY the first resulting
 * chunk, rather than treated as just another paragraph competing for the
 * `targetChars` budget. Without this, a section whose heading-plus-first-
 * paragraph landed just over budget could split the heading into its own
 * paragraph-sized "chunk," and — worse — a global small-chunk merge pass
 * has no way to tell that fragment apart from any other tiny chunk, so it
 * could get glued onto the END of the PRECEDING section instead of the
 * body it actually introduces.
 */
function packParagraphs(section: string, targetChars: number): string[] {
  const lines = section.split("\n");
  let heading = "";
  let body = section;
  if (/^#{1,6}\s/.test(lines[0] ?? "")) {
    heading = lines[0]!;
    body = lines.slice(1).join("\n").trim();
  }

  const paras = splitOnParagraphs(body);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > targetChars) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) chunks.push(buf);
  if (chunks.length === 0) chunks.push("");
  if (heading) chunks[0] = `${heading}\n\n${chunks[0]}`.trim();
  return chunks.filter((c) => c.length > 0);
}

/**
 * Merge any chunk under `minChars` into the PRECEDING chunk (so a tiny
 * trailing fragment — a one-line closing section, a short final
 * paragraph — doesn't become its own low-signal vector that fragments
 * recall). A small chunk that ends up FIRST (nothing precedes it — e.g. a
 * lone heading line that `packParagraphs` split away from its own
 * content) has no predecessor to fold backward into, so it's folded
 * FORWARD into what's then the second chunk instead — a tiny fragment
 * never survives as its own low-signal vector regardless of which end of
 * the note it lands on.
 */
function mergeSmallChunks(chunks: string[], minChars: number): string[] {
  const merged: string[] = [];
  for (const c of chunks) {
    if (merged.length > 0 && c.length < minChars) {
      merged[merged.length - 1] = `${merged[merged.length - 1]!}\n\n${c}`;
    } else {
      merged.push(c);
    }
  }
  if (merged.length > 1 && merged[0]!.length < minChars) {
    merged[1] = `${merged[0]!}\n\n${merged[1]!}`;
    merged.shift();
  }
  return merged;
}
