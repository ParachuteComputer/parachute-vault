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
import { encodeDelta, decodeDelta } from "./delta.js";
import { transaction } from "./txn.js";

export type HistoryOp =
  | "import"
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
  compact_enabled: boolean;
  compact_ratio: number;
  compact_min_versions: number;
  compact_run_length: number;
  max_bytes_per_note: number | null;
  compact_budget_ms: number;
  compact_max_notes: number;
}
export const DEFAULT_HISTORY_POLICY: HistoryPolicy = {
  enabled: true,
  min_versions: 20,
  max_versions: 100,
  max_age_days: 180,
  deleted_retention_days: null,
  compact_enabled: true,
  compact_ratio: 3,
  compact_min_versions: 10,
  compact_run_length: 24,
  max_bytes_per_note: 8_388_608,
  compact_budget_ms: 250,
  compact_max_notes: 50,
};
export function resolveHistoryPolicy(
  partial?: Partial<HistoryPolicy>,
): HistoryPolicy {
  const p = { ...DEFAULT_HISTORY_POLICY, ...partial };
  // The floor is the retention promise: clamp the ceiling up, never down.
  p.max_versions = Math.max(1, p.max_versions, p.min_versions);
  p.max_age_days = Math.min(p.max_age_days, 36500);
  if (p.deleted_retention_days !== null)
    p.deleted_retention_days = Math.min(p.deleted_retention_days, 36500);
  p.compact_ratio = Math.max(1, p.compact_ratio);
  p.compact_min_versions = Math.max(2, p.compact_min_versions);
  p.compact_run_length = Math.min(100, Math.max(2, p.compact_run_length));
  if (p.max_bytes_per_note !== null) p.max_bytes_per_note = Math.max(65_536, p.max_bytes_per_note);
  p.compact_budget_ms = Math.min(60_000, Math.max(0, p.compact_budget_ms));
  p.compact_max_notes = Math.min(10_000, Math.max(0, p.compact_max_notes));
  return p;
}
export const VERSION_MAX_BYTES = 2_000_000;
export interface PriorNoteRow {
  id: string;
  content: string | null;
  path: string | null;
  metadata: string | null;
  extension: string | null;
  created_at: string | null;
}
export interface VersionRow {
  note_id: string;
  version_ix: number;
  content_hash: string | null;
  path: string | null;
  metadata: Record<string, unknown>;
  extension: string | null;
  created_at: string | null;
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
  readonly error_type = "history_unrecoverable";
  readonly code = "HISTORY_UNRECOVERABLE";
  constructor(
    readonly note_id: string,
    readonly version_ix: number,
    readonly reason: "overflow" | "delta_orphan" = "overflow",
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
      "SELECT id, content, path, metadata, extension, created_at FROM notes WHERE id = ?",
    )
    .get(id) as PriorNoteRow | null;
}
function nextIndex(db: Database, noteId: string): number {
  return (
    db
      .prepare(
        "SELECT COALESCE(MAX(version_ix), -1) + 1 AS ix FROM note_versions WHERE note_id = ? AND version_ix >= 0",
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
      superseded_at, actor, via, op, content_len, encoding, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'delete', ?, 'overflow', ?)`,
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
      prior.created_at,
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
    superseded_at, actor, via, op, content_len, encoding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
    prior.created_at,
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
    superseded_at, actor, via, op, content_len, encoding, created_at)
    SELECT note_id, ?, content_hash, path, metadata, extension, ?, ?, ?, 'restore', content_len, encoding, created_at
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
  now = Date.now(),
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
    now - policy.max_age_days * 86_400_000,
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
        "DELETE FROM note_blobs WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM note_versions WHERE content_hash = ?) AND NOT EXISTS (SELECT 1 FROM note_blobs WHERE delta_of = ?)",
      )
      .run(hash, hash, hash).changes;
  }
  return { versionsDeleted, blobsDeleted };
}
export function gcBlobs(db: Database): { blobsDeleted: number } {
  let blobsDeleted = 0;
  // Depth one needs two deletion waves; bounded even in a corrupt database.
  for (let pass = 0; pass < 4; pass++) {
    const changed = db.prepare("DELETE FROM note_blobs WHERE hash NOT IN (SELECT content_hash FROM note_versions WHERE content_hash IS NOT NULL) AND hash NOT IN (SELECT delta_of FROM note_blobs WHERE delta_of IS NOT NULL)").run().changes;
    blobsDeleted += changed;
    if (!changed) break;
  }
  return { blobsDeleted };
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
  "note_id, version_ix, content_hash, path, metadata, extension, superseded_at, actor, via, op, content_len, encoding, created_at";
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
        .join(", ")}, b.content, b.encoding AS blob_encoding, b.delta_of
    FROM note_versions v LEFT JOIN note_blobs b ON b.hash = v.content_hash WHERE v.note_id = ? AND v.version_ix = ?`,
    )
    .get(noteId, versionIx) as
    | (RawVersionRow & BlobReadRow)
    | null;
  if (!row) return null;
  const { content, blob_encoding, delta_of, ...verCols } = row;
  try {
    const reconstructed = materialise(db, verCols.content_hash!, { content, blob_encoding, delta_of });
    return { ...parseRow(verCols), content: reconstructed, encoding: verCols.encoding ?? blob_encoding };
  } catch (err) {
    if (!(err instanceof HistoryDeltaOrphanError)) throw err;
    console.warn("[history] unrecoverable delta", { hash: err.hash, delta_of: err.delta_of, reason: err.reason });
    throw new HistoryUnrecoverableError(noteId, versionIx, "delta_orphan");
  }
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

export class HistoryDeltaOrphanError extends Error {
  readonly code = "HISTORY_UNRECOVERABLE";
  constructor(readonly hash: string, readonly delta_of: string | null, readonly reason: "unknown_encoding" | "base_missing" | "base_not_whole" | "bad_delta" | "identity_mismatch") {
    super(`History delta cannot be reconstructed: ${reason}`);
    this.name = "HistoryDeltaOrphanError";
  }
}
interface BlobReadRow {
  content: string | null;
  blob_encoding: string | null;
  delta_of: string | null;
}
function materialise(db: Database, hash: string, row: BlobReadRow): string | null {
  if (row.content === null)
    return null;
  if (row.blob_encoding === null)
    return row.content;
  if (row.blob_encoding !== "fossil-delta")
    throw new HistoryDeltaOrphanError(hash, row.delta_of, "unknown_encoding");
  const base = row.delta_of ? db.prepare("SELECT content, encoding FROM note_blobs WHERE hash = ?").get(row.delta_of) as {
    content: string;
    encoding: string | null;
  } | null : null;
  if (!base)
    throw new HistoryDeltaOrphanError(hash, row.delta_of, "base_missing");
  if (base.encoding !== null)
    throw new HistoryDeltaOrphanError(hash, row.delta_of, "base_not_whole");
  let text: string;
  try {
    text = decodeDelta(base.content, row.content);
  }
  catch {
    throw new HistoryDeltaOrphanError(hash, row.delta_of, "bad_delta");
  }
  if (hashContent(text) !== hash)
    throw new HistoryDeltaOrphanError(hash, row.delta_of, "identity_mismatch");
  return text;
}
export function readBlobContent(db: Database, hash: string): string | null {
  const row = db.prepare("SELECT content, encoding AS blob_encoding, delta_of FROM note_blobs WHERE hash = ?").get(hash) as BlobReadRow | null;
  return row ? materialise(db, hash, row) : null;
}
export function countNoteVersions(db: Database, noteId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(noteId) as {
    n: number;
  }).n;
}
/** Attribution: each directly referenced blob once, excluding indirect bases. */
export function noteHistoryBytes(db: Database, noteId: string): number {
  return (db.prepare(`SELECT COALESCE(SUM(b.byte_size),0) AS n FROM
  (SELECT DISTINCT content_hash FROM note_versions WHERE note_id = ? AND content_hash IS NOT NULL) v
  JOIN note_blobs b ON b.hash = v.content_hash`).get(noteId) as {
    n: number;
  }).n;
}
export function historyStorageStats(db: Database) {
  const stats = { whole_blobs: 0, whole_bytes: 0, delta_blobs: 0, delta_bytes: 0, orphan_deltas: 0, unknown_encoding_blobs: 0 };
  if (!historyTablesPresent(db))
    return stats;
  const groups = db.prepare("SELECT encoding, COUNT(*) AS n, COALESCE(SUM(byte_size),0) AS bytes FROM note_blobs GROUP BY encoding").all() as {
    encoding: string | null;
    n: number;
    bytes: number;
  }[];
  for (const g of groups) {
    if (g.encoding === null) {
      stats.whole_blobs = g.n;
      stats.whole_bytes = g.bytes;
    }
    else if (g.encoding === "fossil-delta") {
      stats.delta_blobs = g.n;
      stats.delta_bytes = g.bytes;
    }
    else
      stats.unknown_encoding_blobs += g.n;
  }
  stats.orphan_deltas = (db.prepare(`SELECT COUNT(*) AS n FROM note_blobs d WHERE d.encoding = 'fossil-delta'
  AND (d.delta_of IS NULL OR NOT EXISTS (SELECT 1 FROM note_blobs b WHERE b.hash = d.delta_of AND b.encoding IS NULL))`).get() as {
    n: number;
  }).n;
  return stats;
}
export function topNotesByHistoryBytes(db: Database, limit: number): {
  note_id: string;
  bytes: number;
  versions: number;
}[] {
  return db.prepare(`SELECT v.note_id, SUM(b.byte_size) AS bytes,
  (SELECT COUNT(*) FROM note_versions n WHERE n.note_id = v.note_id) AS versions
  FROM (SELECT DISTINCT note_id, content_hash FROM note_versions WHERE content_hash IS NOT NULL) v
  JOIN note_blobs b ON b.hash = v.content_hash GROUP BY v.note_id ORDER BY bytes DESC LIMIT ?`).all(limit) as {
    note_id: string;
    bytes: number;
    versions: number;
  }[];
}
export interface CompactResult {
  blobs_deltified: number;
  blobs_skipped_too_large: number;
  versions_dropped: number;
  bytes_before: number;
  bytes_after: number;
}
export interface CompactSummary {
  notes_scanned: number;
  notes_compacted: number;
  notes_failed: number;
  blobs_deltified: number;
  versions_dropped: number;
  bytes_before: number;
  bytes_after: number;
  remaining_candidates: number;
  duration_ms: number;
  stopped_by: "complete" | "budget" | "max_notes" | "disabled";
}
export function compactNote(db: Database, noteId: string, policy: HistoryPolicy): CompactResult {
  const result: CompactResult = { blobs_deltified: 0, blobs_skipped_too_large: 0, versions_dropped: 0, bytes_before: 0, bytes_after: 0 };
  if (!policy.enabled || !policy.compact_enabled || !historyTablesPresent(db))
    return result;
  const rows = db.prepare("SELECT version_ix, content_hash, content_len FROM note_versions WHERE note_id = ? AND content_hash IS NOT NULL ORDER BY version_ix DESC").all(noteId) as {
    version_ix: number;
    content_hash: string;
    content_len: number;
  }[];
  const stored = noteHistoryBytes(db, noteId);
  result.bytes_before = result.bytes_after = stored;
  const current = db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId) as {
    content: string | null;
  } | null;
  const newest = current?.content == null
    ? db.prepare("SELECT content_len FROM note_versions WHERE note_id = ? ORDER BY version_ix DESC LIMIT 1").get(noteId) as { content_len: number } | null
    : null;
  const live = current?.content == null ? newest?.content_len ?? 0 : byteLength(current.content);
  const overBytes = policy.max_bytes_per_note !== null && stored > policy.max_bytes_per_note;
  if (!overBytes && rows.length < policy.compact_min_versions)
    return result;
  if (!overBytes && stored <= policy.compact_ratio * Math.max(live, 1))
    return result;
  return transaction(db, () => {
    for (let start = 0; start < rows.length; start += policy.compact_run_length) {
      const run = rows.slice(start, start + policy.compact_run_length);
      const baseRow = db.prepare("SELECT hash, encoding, delta_of FROM note_blobs WHERE hash = ?").get(run[0]!.content_hash) as {
        hash: string;
        encoding: string | null;
        delta_of: string | null;
      } | null;
      if (!baseRow)
        continue;
      const baseHash = baseRow.encoding === null ? baseRow.hash : baseRow.delta_of;
      if (!baseHash)
        continue;
      const base = db.prepare("SELECT encoding FROM note_blobs WHERE hash = ?").get(baseHash) as {
        encoding: string | null;
      } | null;
      if (!base)
        continue;
      // Never propagate a pre-existing depth-two chain into healthy blobs.
      if (base.encoding !== null)
        throw new HistoryDeltaOrphanError(baseRow.hash, baseHash, "base_not_whole");
      const text = readBlobContent(db, baseHash);
      if (text === null)
        continue;
      for (const r of run.slice(1)) {
        if (r.content_hash === baseHash)
          continue;
        const b = db.prepare("SELECT hash, content, byte_size, encoding FROM note_blobs WHERE hash = ?").get(r.content_hash) as {
          hash: string;
          content: string;
          byte_size: number;
          encoding: string | null;
        } | null;
        if (!b || b.encoding !== null)
          continue;
        if (db.prepare("SELECT 1 FROM note_blobs WHERE delta_of = ? LIMIT 1").get(b.hash))
          continue;
        const payload = encodeDelta(text, b.content);
        if (payload.length >= b.byte_size * 0.9) {
          result.blobs_skipped_too_large++;
          continue;
        }
        result.blobs_deltified += db.prepare("UPDATE note_blobs SET content = ?, byte_size = ?, encoding = 'fossil-delta', delta_of = ? WHERE hash = ? AND encoding IS NULL").run(payload, payload.length, baseHash, b.hash).changes;
      }
    }
    if (policy.max_bytes_per_note !== null)
      result.versions_dropped = enforceByteCeiling(db, noteId, policy);
    result.bytes_after = noteHistoryBytes(db, noteId);
    return result;
  });
}
function enforceByteCeiling(db: Database, noteId: string, policy: HistoryPolicy): number {
  let dropped = 0;
  while (policy.max_bytes_per_note !== null && noteHistoryBytes(db, noteId) > policy.max_bytes_per_note) {
    const rows = db.prepare("SELECT version_ix, op, content_hash FROM note_versions WHERE note_id = ? ORDER BY version_ix ASC").all(noteId) as Pick<VersionRow, "version_ix" | "op" | "content_hash">[];
    const victim = rows.find((r, i) => r.op !== "delete" && rows.length - 1 - i >= policy.min_versions);
    if (!victim)
      break;
    dropped += db.prepare("DELETE FROM note_versions WHERE note_id = ? AND version_ix = ?").run(noteId, victim.version_ix).changes;
    db.prepare("DELETE FROM note_blobs WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM note_versions WHERE content_hash = ?) AND NOT EXISTS (SELECT 1 FROM note_blobs WHERE delta_of = ?)").run(victim.content_hash, victim.content_hash, victim.content_hash);
  }
  return dropped;
}
export function compactVault(db: Database, policy: HistoryPolicy, opts?: {
  noteId?: string;
  budgetMs?: number | null;
  maxNotes?: number | null;
}): CompactSummary {
  const result: CompactSummary = { notes_scanned: 0, notes_compacted: 0, notes_failed: 0, blobs_deltified: 0, versions_dropped: 0, bytes_before: 0, bytes_after: 0, remaining_candidates: 0, duration_ms: 0, stopped_by: "complete" };
  if (!historyTablesPresent(db) || !policy.enabled || !policy.compact_enabled)
    return { ...result, stopped_by: "disabled" };
  const budget = opts?.budgetMs === undefined ? policy.compact_budget_ms : opts.budgetMs;
  const max = opts?.maxNotes === undefined ? policy.compact_max_notes : opts.maxNotes;
  if (max !== null && max <= 0)
    return { ...result, stopped_by: "max_notes" };
  if (budget !== null && budget <= 0)
    return { ...result, stopped_by: "budget" };
  const started = performance.now();
  const candidates = opts?.noteId !== undefined ? [{ note_id: opts.noteId }] : db.prepare(`SELECT v.note_id, SUM(b.byte_size) AS stored,
  (SELECT COUNT(*) FROM note_versions n WHERE n.note_id = v.note_id AND n.content_hash IS NOT NULL) AS versions,
  COALESCE(LENGTH(CAST(live_note.content AS BLOB)),
   (SELECT content_len FROM note_versions newest WHERE newest.note_id = v.note_id ORDER BY version_ix DESC LIMIT 1),0) AS live
  FROM (SELECT DISTINCT note_id, content_hash FROM note_versions WHERE content_hash IS NOT NULL) v
  JOIN note_blobs b ON b.hash = v.content_hash LEFT JOIN notes live_note ON live_note.id = v.note_id
  GROUP BY v.note_id
  HAVING (versions >= ? AND stored > ? * MAX(live,1)) OR (? IS NOT NULL AND stored > ?)
  ORDER BY stored DESC`).all(policy.compact_min_versions, policy.compact_ratio, policy.max_bytes_per_note, policy.max_bytes_per_note) as {
    note_id: string;
  }[];
  for (const candidate of candidates) {
    if (max !== null && result.notes_scanned >= max) {
      result.stopped_by = "max_notes";
      break;
    }
    // Always attempt one candidate, even when the candidate scan used the budget.
    if (result.notes_scanned > 0 && budget !== null && performance.now() - started >= budget) {
      result.stopped_by = "budget";
      break;
    }
    result.notes_scanned++;
    try {
      const r = compactNote(db, candidate.note_id, policy);
      if (r.blobs_deltified || r.versions_dropped)
        result.notes_compacted++;
      result.blobs_deltified += r.blobs_deltified;
      result.versions_dropped += r.versions_dropped;
      result.bytes_before += r.bytes_before;
      result.bytes_after += r.bytes_after;
    }
    catch (err) {
      result.notes_failed++;
      console.warn("[history] compaction failed", candidate.note_id, err);
    }
  }
  result.remaining_candidates = candidates.length - result.notes_scanned;
  result.duration_ms = performance.now() - started;
  return result;
}
