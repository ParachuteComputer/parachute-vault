import type { Database } from "bun:sqlite";

// Scheduling hints only. History remains authoritative, including for deleted notes.
export const COMPACT_STATE_AGGREGATE = `SELECT v.note_id,
  (SELECT COUNT(*) FROM note_versions n WHERE n.note_id=v.note_id AND n.content_hash IS NOT NULL) AS versions,
  SUM(b.byte_size) AS stored,
  COALESCE(LENGTH(CAST(live_note.content AS BLOB)),
    (SELECT content_len FROM note_versions newest WHERE newest.note_id=v.note_id ORDER BY version_ix DESC LIMIT 1),0) AS live
  FROM (SELECT DISTINCT note_id,content_hash FROM note_versions WHERE content_hash IS NOT NULL __FILTER__) v
  JOIN note_blobs b ON b.hash=v.content_hash LEFT JOIN notes live_note ON live_note.id=v.note_id
  GROUP BY v.note_id`;

export interface CompactState { note_id: string; versions: number; stored: number; live: number }
export function readCompactState(db: Database, noteId: string): CompactState | null {
  return db.prepare(COMPACT_STATE_AGGREGATE.replace("__FILTER__", "AND note_id=?")).get(noteId) as CompactState | null;
}

/** Caller owns the enclosing write transaction; run after the live-row mutation. */
export function refreshCompactState(db: Database, noteId: string, opts?: { refused?: boolean }): void {
  // Keep the existing graceful behavior of writes before history tables exist.
  const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('note_versions','note_blobs','history_compact_state')").get() as { n: number };
  if (tables.n !== 3) return;
  const state = readCompactState(db, noteId);
  if (!state) {
    db.prepare("DELETE FROM history_compact_state WHERE note_id=?").run(noteId);
    return;
  }
  db.prepare(`INSERT INTO history_compact_state(note_id,versions,stored,live,refused,refreshed_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET
    versions=excluded.versions,stored=excluded.stored,live=excluded.live,
    refused=excluded.refused,refreshed_at=excluded.refreshed_at`)
    .run(noteId, state.versions, state.stored, state.live, opts?.refused ? 1 : 0, Date.now());
}
