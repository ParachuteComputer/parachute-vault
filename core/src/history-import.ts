/** Git-independent import primitives. Callers own source parsing and offline access. */
import type { Database } from "bun:sqlite";
import { transaction } from "./txn.js";
import { HistoryUnrecoverableError, hashContent, byteLength, VERSION_MAX_BYTES, pruneVersions, compactNote, getVersion, type HistoryPolicy, type VersionRow } from "./history.js";

export interface ImportedObservation {
  content: string;
  path: string | null;
  metadata: Record<string, unknown>;
  extension: string;
  created_at: string | null;
  observed_at: string;
  commit: string;
  blob: string;
}
export interface ImportRun {
  run_id: string;
  source_fingerprint: string;
  tip: string;
  options_digest: string;
}
export interface ImportReceipt {
  note_id: string;
  run_id: string;
  state_digest: string;
  imported_count: number;
  retained_count: number;
  pruned_imported: number;
  pruned_native: number;
  completed_at: string;
}
export function canonicalJson(value: unknown): string {
  function ordered(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(ordered);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, ordered(x)]));
    return v;
  }
  return JSON.stringify(ordered(value));
}
export function importStorageIndex(index: number): number {
  const storage = -index - 1;
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(storage)) throw new Error("Invalid import_ix");
  return storage;
}
export function projectHistoryRow<T extends VersionRow>(row: T): T | (Omit<T, "version_ix"> & { origin: "git-import"; import_ix: number }) {
  if (row.version_ix >= 0) return row;
  const { version_ix, ...rest } = row;
  return { ...rest, origin: "git-import", import_ix: -version_ix - 1 };
}
export function getImportedVersion(db: Database, id: string, index: number) {
  const ix = importStorageIndex(index);
  if (!db.prepare("SELECT 1 FROM history_import_refs WHERE note_id=? AND import_ix=?").get(id, index)) return null;
  try {
    const row = getVersion(db, id, ix);
    return row?.op === "import" ? row : null;
  } catch (error) {
    if (error instanceof HistoryUnrecoverableError) throw new ImportedHistoryUnrecoverableError(id, index, error.reason);
    throw error;
  }
}
export function beginImportRun(db: Database, run: ImportRun): void {
  transaction(db, () => {
    const existing = db.prepare("SELECT run_id,source_fingerprint,tip,options_digest FROM history_import_runs WHERE run_id=?").get(run.run_id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(run)) throw new Error("Import run conflicts with its manifest");
      return;
    }
    db.prepare("INSERT INTO history_import_runs VALUES(?,?,?,?, 'applying', ?)").run(run.run_id, run.source_fingerprint, run.tip, run.options_digest, new Date().toISOString());
  });
}
export function readImportReceipt(db: Database, id: string): ImportReceipt | null {
  return db.prepare("SELECT * FROM history_import_receipts WHERE note_id=?").get(id) as ImportReceipt | null;
}
/** Content-addressed global blob changes are excluded from the per-note state fingerprint. */
export function importTargetDigest(db: Database, id: string): string {
  return hashContent(canonicalJson({
    note: db.prepare("SELECT id,content,path,metadata,extension,created_at,updated_at FROM notes WHERE id=?").get(id),
    versions: db.prepare("SELECT * FROM note_versions WHERE note_id=? ORDER BY version_ix").all(id),
  }));
}
export function importObservationDigest(rows: ImportedObservation[]): string {
  return hashContent(canonicalJson(rows));
}
export function applyImportedNote(db: Database, opts: {
  run: ImportRun; noteId: string; observations: ImportedObservation[];
  policy: HistoryPolicy; now: number; targetDigest: string;
  expectedNativeDrops?: number[];
}): { receipt: ImportReceipt; nativeDrops: number[]; skipped: boolean } {
  return transaction(db, () => {
    const prior = readImportReceipt(db, opts.noteId);
    const digest = importObservationDigest(opts.observations);
    if (prior) {
      if (prior.run_id !== opts.run.run_id || prior.state_digest !== digest) throw new Error("Note already owned by another import; resume its original manifest");
      return { receipt: prior, nativeDrops: [], skipped: true };
    }
    if (!db.prepare("SELECT 1 FROM notes WHERE id=?").get(opts.noteId)) throw new Error("Import requires a live note");
    if (importTargetDigest(db, opts.noteId) !== opts.targetDigest) throw new Error("Stale import manifest: target note changed");
    if (!opts.observations.length) throw new Error("Cannot receipt an empty import");
    if (db.prepare("SELECT 1 FROM note_versions WHERE note_id=? AND version_ix<0").get(opts.noteId)) throw new Error("Unreceipted imported history exists");
    const nativeBefore = db.prepare("SELECT version_ix FROM note_versions WHERE note_id=? AND version_ix>=0 ORDER BY version_ix").all(opts.noteId) as { version_ix: number }[];
    const receipt: ImportReceipt = { note_id: opts.noteId, run_id: opts.run.run_id, state_digest: digest, imported_count: opts.observations.length, retained_count: 0, pruned_imported: 0, pruned_native: 0, completed_at: new Date(opts.now).toISOString() };
    db.prepare("INSERT INTO history_import_receipts VALUES(?,?,?,?,?,?,?,?)").run(receipt.note_id, receipt.run_id, receipt.state_digest, receipt.imported_count, 0, 0, 0, receipt.completed_at);
    for (let i = 0; i < opts.observations.length; i++) {
      const row = opts.observations[i]!;
      const size = byteLength(row.content);
      if (size > VERSION_MAX_BYTES) throw new Error("Oversized imported observation: quarantine the whole note");
      const index = opts.observations.length - i - 1;
      const storage = importStorageIndex(index);
      const hash = hashContent(row.content);
      db.prepare("INSERT OR IGNORE INTO note_blobs(hash,content,byte_size) VALUES(?,?,?)").run(hash, row.content, size);
      db.prepare(`INSERT INTO note_versions(note_id,version_ix,content_hash,path,metadata,extension,superseded_at,actor,via,op,content_len,encoding,created_at)
        VALUES(?,?,?,?,?,?,?,NULL,'git-import','import',?,NULL,?)`).run(opts.noteId, storage, hash, row.path, canonicalJson(row.metadata), row.extension, row.observed_at, size, row.created_at);
      db.prepare("INSERT INTO history_import_refs VALUES(?,?,?,?)").run(opts.noteId, index, row.commit, row.blob);
    }
    if (opts.policy.enabled) pruneVersions(db, opts.noteId, opts.policy, opts.now);
    compactNote(db, opts.noteId, opts.policy);
    const after = new Set((db.prepare("SELECT version_ix FROM note_versions WHERE note_id=?").all(opts.noteId) as { version_ix: number }[]).map(r => r.version_ix));
    for (let i = 0; i < opts.observations.length; i++) {
      const index = opts.observations.length - i - 1;
      if (after.has(importStorageIndex(index)) && getImportedVersion(db, opts.noteId, index)?.content !== opts.observations[i]!.content) throw new Error("Imported content failed verification");
    }
    const nativeDrops = nativeBefore.map(r => r.version_ix).filter(ix => !after.has(ix));
    if (opts.expectedNativeDrops && canonicalJson(nativeDrops) !== canonicalJson(opts.expectedNativeDrops)) throw new Error("Native deletion set differs from final manifest");
    receipt.retained_count = [...after].filter(ix => ix < 0).length;
    receipt.pruned_imported = receipt.imported_count - receipt.retained_count;
    receipt.pruned_native = nativeDrops.length;
    db.prepare("UPDATE history_import_receipts SET retained_count=?,pruned_imported=?,pruned_native=? WHERE note_id=?").run(receipt.retained_count, receipt.pruned_imported, receipt.pruned_native, opts.noteId);
    return { receipt, nativeDrops, skipped: false };
  });
}

/** Public import errors must not expose the negative storage key, even in prose. */
export class ImportedHistoryUnrecoverableError extends Error {
  readonly code = "HISTORY_UNRECOVERABLE";
  readonly error_type = "history_unrecoverable";
  readonly origin = "git-import";
  constructor(readonly note_id: string, readonly import_ix: number, readonly reason: "overflow" | "delta_orphan") {
    super(`Imported version content is unrecoverable: "${note_id}" import ${import_ix}`);
    this.name = "ImportedHistoryUnrecoverableError";
  }
}
export function parseHistorySelector(value: { version_ix?: unknown; origin?: unknown; import_ix?: unknown }):
  { version_ix: number } | { origin: "git-import"; import_ix: number } | null {
  const imported = value.origin !== undefined || value.import_ix !== undefined;
  if (imported) {
    if (value.version_ix !== undefined || value.origin !== "git-import" || typeof value.import_ix !== "number"
      || !Number.isSafeInteger(value.import_ix) || value.import_ix < 0) throw invalidHistorySelector();
    importStorageIndex(value.import_ix);
    return { origin: "git-import", import_ix: value.import_ix };
  }
  if (value.version_ix === undefined) return null;
  if (typeof value.version_ix !== "number" || !Number.isSafeInteger(value.version_ix) || value.version_ix < 0) throw invalidHistorySelector();
  return { version_ix: value.version_ix };
}
function invalidHistorySelector() {
  return Object.assign(new Error("Specify either a nonnegative version_ix or origin git-import with a nonnegative import_ix"), { error_type: "invalid_request", field: "versions" });
}
