/**
 * Freshness gate for `note_vectors` (V2 — see `SEMANTIC-MVP-PLAN.md` §3,
 * "Staleness hook"). Pure diffing logic: given a note's CURRENT chunks
 * (from `chunkNoteContent`) and the vector rows already on disk, decide
 * which chunk indices need (re-)embedding and which existing rows are
 * obsolete (the note shrank, or the configured model changed) and should
 * be pruned.
 *
 * No I/O here — `core/src/notes.ts`/`store.ts` own reading `note_vectors`
 * and applying the resulting plan (embed the stale ones, delete the
 * obsolete ones). Keeping this pure makes "no-op edit ≠ re-embed" and
 * "model change ⇒ full sweep" both directly testable without a database.
 *
 * `content_hash` uses `node:crypto`'s `createHash` — already a core
 * dependency (see `core/src/cursor.ts`), so this doesn't add a new one.
 */

import { createHash } from "node:crypto";
import type { Chunk } from "./chunker.js";

/** Deterministic content hash for one chunk's text — the freshness key. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The subset of a `note_vectors` row this module needs to reason about. */
export interface ExistingVectorRow {
  chunk_ix: number;
  model: string;
  content_hash: string;
}

export interface StalenessPlan {
  /**
   * Chunks that need embedding: either no row exists yet at this
   * `chunk_ix`, or the existing row's `model`/`content_hash` doesn't
   * match — a no-op edit (same content, same model) never lands here.
   */
  stale: Chunk[];
  /**
   * `chunk_ix` values present in `existing` that no longer correspond to
   * a current chunk (the note shrank) OR belong to a stale `model` — safe
   * to DELETE. Pruning these is what keeps a shrunk note's leftover
   * high-index chunk from lingering as a ghost match in the cosine scan.
   */
  obsoleteIxs: number[];
}

/**
 * Diff a note's current chunk set against its existing `note_vectors`
 * rows for the ACTIVE `model`. Rows recorded under a different model are
 * always obsolete (a `note_vectors` row's `model` never mixes with the
 * configured provider's model within one scan — see
 * `core/src/notes.ts:semanticSearchNotes`, which filters `WHERE model =
 * ?`) — so a model change surfaces as "every existing row is obsolete,
 * every current chunk is stale," i.e. a full re-embed sweep, matching the
 * plan's "model change → stale sweep (re-embed)."
 */
export function planStaleness(
  existing: ExistingVectorRow[],
  chunks: Chunk[],
  model: string,
): StalenessPlan {
  const existingByIx = new Map(existing.map((r) => [r.chunk_ix, r]));
  const currentIxs = new Set(chunks.map((c) => c.ix));

  const stale: Chunk[] = [];
  for (const c of chunks) {
    const row = existingByIx.get(c.ix);
    if (!row || row.model !== model || row.content_hash !== contentHash(c.text)) {
      stale.push(c);
    }
  }

  const obsoleteIxs: number[] = [];
  for (const row of existing) {
    if (!currentIxs.has(row.chunk_ix) || row.model !== model) {
      obsoleteIxs.push(row.chunk_ix);
    }
  }

  return { stale, obsoleteIxs };
}
