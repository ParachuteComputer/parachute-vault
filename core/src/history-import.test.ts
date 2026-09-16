import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { resolveHistoryPolicy, eraseHistory, getVersion } from "./history.js";
import { applyImportedNote, beginImportRun, importTargetDigest, getImportedVersion, importStorageIndex, type ImportedObservation } from "./history-import.js";

const run = { run_id: "manifest", source_fingerprint: "source", tip: "tip", options_digest: "options" };
const rows: ImportedObservation[] = ["older", "newer"].map(content => ({ content, path: "history", metadata: {}, extension: "md", created_at: null, observed_at: "2026-01-01T00:00:00Z", commit: content, blob: content }));
async function fixture() {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  const note = await store.createNote("live", { path: "history" });
  beginImportRun(db, run);
  const opts = { run, noteId: note.id, observations: rows, policy: resolveHistoryPolicy({ min_versions: 20 }), now: Date.parse("2026-01-02T00:00:00Z"), targetDigest: importTargetDigest(db, note.id) };
  return { db, store, note, opts };
}
test("import preserves live state and native allocation; refs survive erase without resurrection", async () => {
  const { db, store, note, opts } = await fixture();
  try {
    const result = applyImportedNote(db, opts);
    expect(result.receipt.retained_count).toBe(2);
    expect(getImportedVersion(db, note.id, 0)?.content).toBe("newer");
    expect(getImportedVersion(db, note.id, 1)?.content).toBe("older");
    expect((await store.getNote(note.id))?.content).toBe("live");
    await store.updateNote(note.id, { content: "native" });
    expect(getVersion(db, note.id, 0)?.content).toBe("live");
    eraseHistory(db, note.id);
    expect(applyImportedNote(db, opts).skipped).toBe(true);
    expect(getImportedVersion(db, note.id, 0)).toBeNull();
    expect(db.query("SELECT count(*) n FROM note_versions").get()).toEqual({ n: 0 });
    expect(() => applyImportedNote(db, { ...opts, run: { ...run, run_id: "different" } })).toThrow("already owned");
  } finally { db.close(); }
});
test("failed native-drop projection rolls back blobs, references and receipt", async () => {
  const { db, opts } = await fixture();
  try {
    expect(() => applyImportedNote(db, { ...opts, expectedNativeDrops: [123] })).toThrow("deletion set");
    for (const table of ["history_import_receipts", "history_import_refs", "note_versions", "note_blobs"]) expect(db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  } finally { db.close(); }
});
test("stale target and oversized note cannot leave a partial import", async () => {
  const { db, store, note, opts } = await fixture();
  try {
    await store.updateNote(note.id, { content: "changed" });
    expect(() => applyImportedNote(db, opts)).toThrow("Stale");
    expect(() => applyImportedNote(db, { ...opts, targetDigest: importTargetDigest(db, note.id), observations: [...rows, { ...rows[0]!, content: "x".repeat(2_000_001) }] })).toThrow("Oversized");
    expect(db.query("SELECT count(*) n FROM history_import_receipts").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) n FROM note_versions WHERE version_ix<0").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});
test("import allocation rejects unsafe and negative public indices", () => {
  expect(importStorageIndex(0)).toBe(-1);
  for (const n of [-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity, NaN]) expect(() => importStorageIndex(n)).toThrow();
});

test("native allocation starts at zero even when the newest import was removed", async () => {
  const { db, store, note, opts } = await fixture();
  try {
    applyImportedNote(db, opts);
    db.prepare("DELETE FROM note_versions WHERE note_id=? AND version_ix=-1").run(note.id);
    await store.updateNote(note.id, { content: "native edit" });
    expect(getVersion(db, note.id, 0)?.content).toBe("live");
    expect(getImportedVersion(db, note.id, 1)?.content).toBe("older");
  } finally { db.close(); }
});

test("import policy discloses native removals separately and honors disabled retention", async () => {
  const { db, store, note, opts } = await fixture();
  try {
    await store.updateNote(note.id, { content: "first native" });
    await store.updateNote(note.id, { content: "second native" });
    const result = applyImportedNote(db, { ...opts, targetDigest: importTargetDigest(db, note.id), policy: resolveHistoryPolicy({ min_versions: 1, max_versions: 1 }), expectedNativeDrops: [0] });
    expect(result.nativeDrops).toEqual([0]);
    expect(result.receipt.pruned_native).toBe(1);
    expect(result.receipt.pruned_imported).toBe(2);
    expect(getVersion(db, note.id, 1)?.content).toBe("first native");
    expect((await store.getNote(note.id))?.content).toBe("second native");
    const other = await store.createNote("other");
    const disabled = applyImportedNote(db, { ...opts, noteId: other.id, targetDigest: importTargetDigest(db, other.id), policy: resolveHistoryPolicy({ enabled: false, min_versions: 0, max_versions: 1 }) });
    expect(disabled.receipt.retained_count).toBe(2);
  } finally { db.close(); }
});
