/**
 * Note history stores prior note-row states, inside the caller's write
 * transaction. captureVersion, appendRestoreMarker and pruneVersions open
 * no explicit transaction of their own. Live reads still use notes.content.
 * NULL content is recorded as an empty string; metadata bytes are preserved.
 *
 * Capture sites: Store.updateNote (including SQL append/prepend, transitions,
 * and skipUpdatedAt metadata writes), Store.deleteNote, cascadeRename, and
 * renameTag's content/path rewrites. Creates have no prior state. Schema
 * migrations, restoreNoteTimestamps, mergeTags' timestamp bump, deleteTag's
 * untagging, and blow-away deletion deliberately do not capture.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { transaction } from "./txn.js";

export type HistoryOp =
  | "update"
  | "append"
  | "prepend"
  | "delete"
  | "restore"
  | "tag-rename"
  | "cascade-rename";
export interface HistoryPolicy {
  enabled: boolean;
  min_versions: number;
  max_versions: number;
  max_age_days: number;
  deleted_retention_days: number | null;
}
export const DEFAULT_HISTORY_POLICY: HistoryPolicy = {
  enabled: true,
  min_versions: 20,
  max_versions: 100,
  max_age_days: 180,
  deleted_retention_days: null,
};
export function resolveHistoryPolicy(
  partial?: Partial<HistoryPolicy>,
): HistoryPolicy {
  const p = { ...DEFAULT_HISTORY_POLICY, ...partial };
  // The floor is the retention promise: clamp the ceiling up, never down.
  p.max_versions = Math.max(p.max_versions, p.min_versions);
  return p;
}
export const VERSION_MAX_BYTES = 2_000_000;
export interface PriorNoteRow {
  id: string;
  content: string | null;
  path: string | null;
  metadata: string | null;
  extension: string | null;
}
export interface VersionRow {
  note_id: string;
  version_ix: number;
  content_hash: string | null;
  path: string | null;
  metadata: Record<string, unknown>;
  extension: string | null;
  superseded_at: string;
  actor: string | null;
  via: string | null;
  op: HistoryOp;
  content_len: number;
  encoding: string | null;
}
type RawVersionRow = Omit<VersionRow, "metadata"> & { metadata: string | null };
export class HistoryOverflowError extends Error {
  readonly code = "HISTORY_OVERFLOW";
  constructor(
    readonly note_id: string,
    readonly byte_size: number,
    readonly limit: number,
  ) {
    super(
      `Note history exceeds ${limit} bytes: "${note_id}" (${byte_size} bytes)`,
    );
    this.name = "HistoryOverflowError";
  }
}
export class HistoryUnrecoverableError extends Error {
  readonly code = "HISTORY_UNRECOVERABLE";
  constructor(
    readonly note_id: string,
    readonly version_ix: number,
  ) {
    super(`Version content is unrecoverable: "${note_id}"@${version_ix}`);
    this.name = "HistoryUnrecoverableError";
  }
}
export class HistoryNotFoundError extends Error {
  code = "HISTORY_NOT_FOUND" as const;
  note_id: string;
  version_ix: number | null;
  constructor(noteId: string, versionIx: number | null) {
    super(
      versionIx === null
        ? `Note not found: "${noteId}"`
        : `Version not found: "${noteId}"@${versionIx}`,
    );
    this.name = "HistoryNotFoundError";
    this.note_id = noteId;
    this.version_ix = versionIx;
  }
}
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
const present = new WeakMap<Database, boolean>();
export function historyTablesPresent(db: Database): boolean {
  if (present.get(db)) return true;
  const exists = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get("note_versions");
  if (exists) present.set(db, true);
  return exists;
}
export function readPriorNoteRow(
  db: Database,
  id: string,
): PriorNoteRow | null {
  return db
    .prepare(
      "SELECT id, content, path, metadata, extension FROM notes WHERE id = ?",
    )
    .get(id) as PriorNoteRow | null;
}
function nextIndex(db: Database, noteId: string): number {
  return (
    db
      .prepare(
        "SELECT COALESCE(MAX(version_ix), -1) + 1 AS ix FROM note_versions WHERE note_id = ?",
      )
      .get(noteId) as { ix: number }
  ).ix;
}
/**
 * `createNote` does no capture, so a note larger than `VERSION_MAX_BYTES` can exist in any vault (probe H counts them). Every later `updateNote` throws `HistoryOverflowError` **inside** `store.ts:635`'s transaction and rolls the write back — correct, loud, and exactly what CodexJi asked for. But change 9 puts `deleteNote`'s capture inside a transaction too, and if a delete threw the same way the note would be **permanently undeletable**: no update can shrink it, and the only escape (`captureHistory: false`) is exposed on no door. An un-updatable note is a nuisance; an un-deletable one is a trap. So a `delete` capture **always succeeds**: it writes the tombstone with `content_hash = NULL`, the real `content_len`, and `encoding = 'overflow'`. The note's *existence*, size, path, metadata and deletion time are recorded; its bytes are not, and were never recordable. **Updates still throw — unchanged.** (ClaudeJi ruling 6, 2026-09-14 20:35Z.)
 */
export function captureVersion(
  db: Database,
  prior: PriorNoteRow,
  opts: {
    actor: string | null;
    via: string | null;
    op: HistoryOp;
    policy: HistoryPolicy;
  },
): void {
  if (!opts.policy.enabled) return;
  if (!historyTablesPresent(db)) return;
  const text = prior.content ?? "";
  const size = byteLength(text);
  if (size > VERSION_MAX_BYTES) {
    if (opts.op !== "delete")
      throw new HistoryOverflowError(prior.id, size, VERSION_MAX_BYTES);
    const ix = nextIndex(db, prior.id);
    db.prepare(
      `INSERT INTO note_versions (note_id, version_ix, content_hash, path, metadata, extension,
      superseded_at, actor, via, op, content_len, encoding) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'delete', ?, 'overflow')`,
    ).run(
      prior.id,
      ix,
      prior.path,
      prior.metadata,
      prior.extension,
      new Date().toISOString(),
      opts.actor,
      opts.via,
      size,
    );
    pruneVersions(db, prior.id, opts.policy);
    return;
  }
  const hash = hashContent(text);
  db.prepare(
    "INSERT OR IGNORE INTO note_blobs (hash, content, byte_size) VALUES (?, ?, ?)",
  ).run(hash, text, size);
  const ix = nextIndex(db, prior.id);
  db.prepare(
    `INSERT INTO note_versions (note_id, version_ix, content_hash, path, metadata, extension,
    superseded_at, actor, via, op, content_len, encoding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    prior.id,
    ix,
    hash,
    prior.path,
    prior.metadata,
    prior.extension,
    new Date().toISOString(),
    opts.actor,
    opts.via,
    opts.op,
    size,
  );
  pruneVersions(db, prior.id, opts.policy);
}
export function appendRestoreMarker(
  db: Database,
  noteId: string,
  tombstone: VersionRow,
  attr: { actor: string | null; via: string | null },
  policy: HistoryPolicy,
): void {
  // Copy in SQL so the raw metadata TEXT is not parsed and re-serialized.
  const ix = nextIndex(db, noteId);
  db.prepare(
    `INSERT INTO note_versions (note_id, version_ix, content_hash, path, metadata, extension,
    superseded_at, actor, via, op, content_len, encoding)
    SELECT note_id, ?, content_hash, path, metadata, extension, ?, ?, ?, 'restore', content_len, encoding
      FROM note_versions WHERE note_id = ? AND version_ix = ?`,
  ).run(
    ix,
    new Date().toISOString(),
    attr.actor,
    attr.via,
    noteId,
    tombstone.version_ix,
  );
  pruneVersions(db, noteId, policy);
}
export function pruneVersions(
  db: Database,
  noteId: string,
  policy: HistoryPolicy,
): { versionsDeleted: number; blobsDeleted: number } {
  const rows = db
    .prepare(
      "SELECT version_ix, superseded_at, op, content_hash FROM note_versions WHERE note_id = ? ORDER BY version_ix DESC",
    )
    .all(noteId) as Pick<
    VersionRow,
    "version_ix" | "superseded_at" | "op" | "content_hash"
  >[];
  const cutoff = new Date(
    Date.now() - policy.max_age_days * 86_400_000,
  ).toISOString();
  const doomed = rows.filter(
    (r, i) =>
      i >= policy.min_versions &&
      r.op !== "delete" &&
      (i >= policy.max_versions || r.superseded_at < cutoff),
  );
  let versionsDeleted = 0,
    blobsDeleted = 0;
  for (const r of doomed)
    versionsDeleted += db
      .prepare("DELETE FROM note_versions WHERE note_id = ? AND version_ix = ?")
      .run(noteId, r.version_ix).changes;
  for (const hash of new Set(
    doomed.map((r) => r.content_hash).filter((h) => h !== null),
  )) {
    blobsDeleted += db
      .prepare(
        "DELETE FROM note_blobs WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM note_versions WHERE content_hash = ?)",
      )
      .run(hash, hash).changes;
  }
  return { versionsDeleted, blobsDeleted };
}
export function gcBlobs(db: Database): { blobsDeleted: number } {
  return {
    blobsDeleted: db
      .prepare(
        "DELETE FROM note_blobs WHERE hash NOT IN (SELECT content_hash FROM note_versions WHERE content_hash IS NOT NULL)",
      )
      .run().changes,
  };
}
export function sweepDeletedHistory(
  db: Database,
  policy: HistoryPolicy,
  now = new Date(),
): { notesSwept: number; versionsDeleted: number; blobsDeleted: number } {
  if (policy.deleted_retention_days === null)
    return { notesSwept: 0, versionsDeleted: 0, blobsDeleted: 0 };
  const cutoff = new Date(
    now.getTime() - policy.deleted_retention_days * 86_400_000,
  ).toISOString();
  const victims = db
    .prepare(
      `SELECT v.note_id, MAX(v.superseded_at) AS last FROM note_versions v
    LEFT JOIN notes n ON n.id = v.note_id WHERE n.id IS NULL GROUP BY v.note_id HAVING last < ?`,
    )
    .all(cutoff) as { note_id: string }[];
  return transaction(db, () => {
    let versionsDeleted = 0;
    for (const v of victims)
      versionsDeleted += db
        .prepare("DELETE FROM note_versions WHERE note_id = ?")
        .run(v.note_id).changes;
    return { notesSwept: victims.length, versionsDeleted, ...gcBlobs(db) };
  });
}
const columns =
  "note_id, version_ix, content_hash, path, metadata, extension, superseded_at, actor, via, op, content_len, encoding";
function parseRow(row: RawVersionRow): VersionRow {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {}
  return { ...row, metadata };
}
export function listVersions(
  db: Database,
  noteId: string,
  opts?: { limit?: number; offset?: number },
): VersionRow[] {
  return (
    db
      .prepare(
        `SELECT ${columns} FROM note_versions WHERE note_id = ? ORDER BY version_ix DESC LIMIT ? OFFSET ?`,
      )
      .all(noteId, opts?.limit ?? 50, opts?.offset ?? 0) as RawVersionRow[]
  ).map(parseRow);
}
export function getVersion(
  db: Database,
  noteId: string,
  versionIx: number,
): (VersionRow & { content: string | null }) | null {
  const row = db
    .prepare(
      `SELECT ${columns
        .split(", ")
        .map((c) => "v." + c)
        .join(", ")}, b.content
    FROM note_versions v LEFT JOIN note_blobs b ON b.hash = v.content_hash WHERE v.note_id = ? AND v.version_ix = ?`,
    )
    .get(noteId, versionIx) as
    | (RawVersionRow & { content: string | null })
    | null;
  return row ? { ...parseRow(row), content: row.content } : null;
}
export function latestTombstone(
  db: Database,
  noteId: string,
): VersionRow | null {
  const row = db
    .prepare(
      `SELECT ${columns} FROM note_versions WHERE note_id = ? AND op = 'delete' ORDER BY version_ix DESC LIMIT 1`,
    )
    .get(noteId) as RawVersionRow | null;
  return row ? parseRow(row) : null;
}
export function eraseHistory(
  db: Database,
  noteId: string,
): { versionsDeleted: number; blobsDeleted: number } {
  return transaction(db, () => {
    const versionsDeleted = db
      .prepare("DELETE FROM note_versions WHERE note_id = ?")
      .run(noteId).changes;
    return { versionsDeleted, ...gcBlobs(db) };
  });
}
export function deletedHistoryStats(db: Database): {
  notes: number;
  versions: number;
  bytes: number;
  overflow_tombstones: number;
} {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT v.note_id) AS notes, COUNT(*) AS versions,
    COALESCE(SUM(b.byte_size), 0) AS bytes,
    COALESCE(SUM(CASE WHEN v.encoding = 'overflow' THEN 1 ELSE 0 END), 0) AS overflow_tombstones
    FROM note_versions v LEFT JOIN notes n ON n.id = v.note_id
    LEFT JOIN note_blobs b ON b.hash = v.content_hash WHERE n.id IS NULL`,
    )
    .get() as {
    notes: number;
    versions: number;
    bytes: number;
    overflow_tombstones: number;
  };
}
