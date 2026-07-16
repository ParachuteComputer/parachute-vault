/**
 * `note_vectors` CRUD — the small, pure-SQL surface the embed-on-write
 * hook (registered in `src/`, self-host; the DO-alarm drain, cloud) uses
 * to apply a `StalenessPlan` (see `staleness.ts`). Kept separate from
 * `notes.ts`'s read-side `semanticSearchNotes` scan so the write-path
 * helpers here have no dependency on the ranking/cosine code, and vice
 * versa.
 */

import { Database } from "bun:sqlite";
import { encodeVector } from "./vector-codec.js";
import type { Chunk } from "./chunker.js";
import type { ExistingVectorRow } from "./staleness.js";

/** Read a note's existing `note_vectors` rows — the shape `planStaleness` diffs against. */
export function getNoteVectorRows(db: Database, noteId: string): ExistingVectorRow[] {
  return db
    .prepare("SELECT chunk_ix, model, content_hash FROM note_vectors WHERE note_id = ?")
    .all(noteId) as ExistingVectorRow[];
}

/**
 * Delete specific obsolete chunk rows for a note — the "cheap sync write"
 * that keeps a shrunk note (or a model change) from leaving a ghost
 * vector that `semanticSearchNotes` would otherwise still rank against.
 * No-op on an empty list (avoids an `IN ()` syntax error).
 */
export function deleteObsoleteVectorRows(db: Database, noteId: string, obsoleteIxs: number[]): void {
  if (obsoleteIxs.length === 0) return;
  const placeholders = obsoleteIxs.map(() => "?").join(", ");
  db.prepare(`DELETE FROM note_vectors WHERE note_id = ? AND chunk_ix IN (${placeholders})`).run(
    noteId,
    ...obsoleteIxs,
  );
}

/**
 * Write (insert or replace) one chunk's embedded vector. Replace-by-PK
 * semantics — a re-embed (content changed, or the model changed)
 * overwrites the existing `(note_id, chunk_ix)` row in place; a vault
 * never carries two models' vectors for the same chunk simultaneously
 * (see the `note_vectors` schema doc comment).
 */
export function upsertNoteVector(
  db: Database,
  noteId: string,
  chunk: Chunk,
  vector: Float32Array,
  model: string,
  contentHash: string,
): void {
  db.prepare(
    `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (note_id, chunk_ix) DO UPDATE SET
       vector = excluded.vector,
       dims = excluded.dims,
       model = excluded.model,
       content_hash = excluded.content_hash,
       embedded_at = excluded.embedded_at`,
  ).run(noteId, chunk.ix, encodeVector(vector), vector.length, model, contentHash, new Date().toISOString());
}

/**
 * Count notes that have zero `note_vectors` rows under `model` — the same
 * "pending" definition `semanticSearchNotes` uses. Used by the
 * `embeddings` capability field (`GET /api/vault`) to report backfill
 * progress without a full semantic scan.
 */
export function countNotesPendingEmbedding(db: Database, model: string): { total: number; pending: number } {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
  const embedded = (
    db
      .prepare("SELECT COUNT(DISTINCT note_id) AS n FROM note_vectors WHERE model = ?")
      .get(model) as { n: number }
  ).n;
  return { total, pending: Math.max(0, total - embedded) };
}

/**
 * Notes with zero `note_vectors` rows under `model` — the actual
 * candidate list (not just a count) the self-host in-process drain and
 * the cloud DO-alarm drain walk to backfill/catch up a vault. A note with
 * SOME but not all chunks embedded (a partial prior embed, e.g. a crash
 * mid-drain) is NOT returned here — see the module doc on
 * `countNotesPendingEmbedding` for the same coarse-but-honest tradeoff;
 * the embed-on-write hook re-derives full freshness per note via
 * `planStaleness`, so a partially-embedded note self-heals on its next
 * edit even if the sweep doesn't re-visit it.
 */
export function getNotesPendingEmbedding(
  db: Database,
  model: string,
  limit?: number,
): { id: string; content: string }[] {
  const sql = `SELECT id, content FROM notes WHERE id NOT IN (SELECT DISTINCT note_id FROM note_vectors WHERE model = ?)${
    typeof limit === "number" ? " LIMIT ?" : ""
  }`;
  const params: (string | number)[] = typeof limit === "number" ? [model, limit] : [model];
  return db.prepare(sql).all(...params) as { id: string; content: string }[];
}
