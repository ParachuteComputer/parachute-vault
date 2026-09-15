import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "./store.js";
import * as h from "./history.js";
const codec = await import("./delta.js").catch(() => null);
let db: Database, store: BunSqliteStore;
beforeEach(() => { db = new Database(":memory:"); store = new BunSqliteStore(db); });
afterEach(() => db.close());
const blobs = () => db.prepare("SELECT hash,content,byte_size,encoding,delta_of FROM note_blobs ORDER BY hash").all();
const versions = () => db.prepare("SELECT note_id,version_ix,content_hash,path,metadata,extension,superseded_at,actor,via,op,content_len,encoding,created_at FROM note_versions ORDER BY note_id,version_ix").all();
async function seed(count = 12, size = 20000, label = "note") {
  const body = (label + " abcdefghijklmnop\n").repeat(Math.ceil(size / (label.length + 18))).slice(0, size);
  const n = await store.createNote(body, { path: label, created_at: "2001-01-01T00:00:00.000Z" });
  for (let i = 0; i < count; i++)
    await store.updateNote(n.id, { append: `\nedit ${i}` });
  return n;
}
function randomHex(size: number) { const bytes = new Uint8Array(size / 2); for (let i = 0; i < bytes.length; i += 65536)
  crypto.getRandomValues(bytes.subarray(i, i + 65536)); return Buffer.from(bytes).toString("hex"); }
async function map(id: string) { return Promise.all((await store.listNoteVersions(id, { limit: 1000 })).map(async (v) => [v.version_ix, (await store.getNoteVersion(id, v.version_ix))!.content])); }
test("P3/P8 stars roll over, preserve all bodies and rerun idempotently", async () => {
  const n = await seed(50);
  const before = await map(n.id);
  expect(store.compactNote(n.id).blobs_deltified).toBeGreaterThanOrEqual(45);
  expect(h.historyStorageStats(db).whole_blobs).toBeLessThanOrEqual(3);
  expect(h.historyStorageStats(db).whole_blobs).toBeGreaterThanOrEqual(1);
  expect(h.historyStorageStats(db).orphan_deltas).toBe(0);
  expect(await map(n.id)).toEqual(before);
  const after = blobs();
  expect(store.compactNote(n.id).blobs_deltified).toBe(0);
  expect(blobs()).toEqual(after);
});
test("P4/P5 GC removes orphan deltas, protects bases, and drains two waves", async () => {
  const n = await seed();
  store.compactNote(n.id);
  const first = db.prepare("SELECT v.version_ix,b.hash,b.delta_of FROM note_versions v JOIN note_blobs b ON b.hash=v.content_hash WHERE b.encoding='fossil-delta' ORDER BY v.version_ix LIMIT 1").get() as any;
  expect(() => db.prepare("DELETE FROM note_blobs WHERE hash=?").run(first.delta_of)).toThrow("FOREIGN KEY");
  db.prepare("DELETE FROM note_versions WHERE note_id=? AND version_ix=?").run(n.id, first.version_ix);
  h.gcBlobs(db);
  expect(db.prepare("SELECT hash FROM note_blobs WHERE hash=?").get(first.hash)).toBeNull();
  expect(db.prepare("SELECT hash FROM note_blobs WHERE hash=?").get(first.delta_of)).not.toBeNull();
  h.eraseHistory(db, n.id);
  expect(blobs()).toEqual([]);
});
test("P4 shared base survives erasure of another note", async () => {
  const n = await seed();
  const base = (await store.listNoteVersions(n.id))[0]!;
  const text = (await store.getNoteVersion(n.id, base.version_ix))!.content!;
  const other = await store.createNote(text);
  await store.updateNote(other.id, { append: "other" });
  store.compactNote(n.id);
  h.eraseHistory(db, n.id);
  expect(h.readBlobContent(db, base.content_hash!)).toBe(text);
  expect((await store.getNoteVersion(other.id, 0))!.content).toBe(text);
});
test("P6 triggers and off switch leave blobs unchanged; writes never compact", async () => {
  const n = await seed(9);
  let before = blobs();
  expect(store.compactNote(n.id).blobs_deltified).toBe(0);
  expect(blobs()).toEqual(before);
  expect(h.compactNote(db, n.id, h.resolveHistoryPolicy({ compact_min_versions: 2, compact_ratio: 100 })).blobs_deltified).toBe(0);
  expect(blobs()).toEqual(before);
  const large = await seed(20, 20000, "off");
  before = blobs();
  expect(h.compactNote(db, large.id, h.resolveHistoryPolicy({ compact_enabled: false, max_bytes_per_note: 65536, min_versions: 1 })).versions_dropped).toBe(0);
  expect(blobs()).toEqual(before);
  for (let i = 0; i < 200; i++)
    await store.updateNote(n.id, { append: `ordinary ${i}` });
  expect(db.prepare("SELECT hash FROM note_blobs WHERE encoding IS NOT NULL").all()).toEqual([]);
  // A live empty body has size zero, not the newest retained body's size.
  const emptyDb = new Database(":memory:");
  try {
    const emptyStore = new BunSqliteStore(emptyDb, { history: { compact_min_versions: 2 } });
    const empty = await emptyStore.createNote("empty fixture".repeat(2000));
    await emptyStore.updateNote(empty.id, { append: "one" });
    await emptyStore.updateNote(empty.id, { content: "" });
    expect(emptyStore.compactHistory({ budgetMs: null, maxNotes: null }).notes_compacted).toBe(1);
  } finally { emptyDb.close(); }
});
test("P7 third encode failure rolls back all changes", async () => {
  const n = await seed();
  const b = blobs(), v = versions();
  expect(codec).not.toBeNull();
  const original = codec!.encodeDelta;
  let count = 0;
  const mock = spyOn(codec!, "encodeDelta").mockImplementation((a, b) => { if (++count === 3)
    throw Error("injected"); return original(a, b); });
  try {
    expect(() => store.compactNote(n.id)).toThrow("injected");
    expect(blobs()).toEqual(b);
    expect(versions()).toEqual(v);
  }
  finally {
    mock.mockRestore();
  }
  expect(store.compactNote(n.id).blobs_deltified).toBeGreaterThan(0);
});
test("P8 bounded passes resume and converge; unbounded visits all", async () => {
  for (let i = 0; i < 3; i++)
    await seed(12, 20000, `note${i}`);
  for (let left = 2; left >= 0; left--) {
    const r = store.compactHistory({ maxNotes: 1, budgetMs: null });
    expect(r.notes_compacted).toBe(1);
    expect(r.remaining_candidates).toBe(left);
    expect(r.stopped_by).toBe(left ? "max_notes" : "complete");
  }
  expect(store.compactHistory({ maxNotes: null, budgetMs: null }).notes_scanned).toBe(0);
  for (let i = 0; i < 3; i++)
    await seed(12, 20000, `more${i}`);
  const budget = store.compactHistory({ budgetMs: 1, maxNotes: null });
  expect(budget.stopped_by).toBe("budget");
  expect(budget.notes_scanned).toBeLessThanOrEqual(1);
  const all = store.compactHistory({ budgetMs: null, maxNotes: null });
  expect(all.stopped_by).toBe("complete");
  expect(all.remaining_candidates).toBe(0);
});
test("P16/P8 incompressible candidates are refused on every pass", async () => {
  const bodies = Array.from({ length: 5 }, () => randomHex(20480));
  expect(codec).not.toBeNull();
  expect(codec!.encodeDelta(bodies[1]!, bodies[0]!).length).toBeGreaterThanOrEqual(20480 * .9);
  const n = await store.createNote(bodies[0]!);
  for (let i = 1; i <= 5; i++)
    await store.updateNote(n.id, { content: bodies[i % 5]! });
  const p = h.resolveHistoryPolicy({ compact_min_versions: 2, compact_ratio: 1 });
  const before = blobs();
  for (let i = 0; i < 2; i++) {
    const result = h.compactNote(db, n.id, p);
    expect(result.blobs_deltified).toBe(0);
    expect(result.blobs_skipped_too_large).toBeGreaterThanOrEqual(1);
    expect(blobs()).toEqual(before);
    expect(h.compactVault(db, p, { budgetMs: null, maxNotes: null })).toMatchObject({ notes_scanned: 1, stopped_by: "complete" });
  }
  const twin = await seed();
  expect(store.compactNote(twin.id)).toMatchObject({ blobs_skipped_too_large: 0 });
  expect(h.historyStorageStats(db).delta_blobs).toBeGreaterThan(0);
});
test("P14 overflow rows stay unchanged during compaction", async () => {
  const n = await store.createNote("x".repeat(h.VERSION_MAX_BYTES + 1));
  await store.deleteNote(n.id);
  const before = await store.listNoteVersions(n.id);
  expect(before[0]!.created_at).toBe(n.createdAt);
  await seed();
  store.compactHistory({ budgetMs: null, maxNotes: null });
  expect(await store.listNoteVersions(n.id)).toEqual(before);
  expect(await store.getNoteVersion(n.id, 0)).toMatchObject({ content: null, encoding: "overflow" });
});
test("P15 compaction precedes ceiling, floor includes protected tombstone", async () => {
  const n = await seed(40, 50000);
  expect(h.compactNote(db, n.id, h.resolveHistoryPolicy({ max_bytes_per_note: 300000 })).versions_dropped).toBe(0);
  expect(h.noteHistoryBytes(db, n.id)).toBeLessThan(300000);
  // A random corpus cannot shrink below the floor's 20 whole bodies.
  const q = await store.createNote(randomHex(50000));
  for (let i = 0; i < 40; i++)
    await store.updateNote(q.id, { content: randomHex(50000) });
  await store.deleteNote(q.id);
  const r = h.compactNote(db, q.id, h.resolveHistoryPolicy({ max_bytes_per_note: 65536 }));
  expect(r.versions_dropped).toBe(21);
  const remaining = await store.listNoteVersions(q.id);
  expect(remaining).toHaveLength(20);
  expect(remaining.filter(v => v.op === "delete")).toHaveLength(1);
  expect(Math.min(...remaining.map(v => v.version_ix))).toBe(21);
  expect(h.noteHistoryBytes(db, q.id)).toBeGreaterThan(65536);
  for (const v of remaining)
    expect((await store.getNoteVersion(q.id, v.version_ix))!.content).not.toBeNull();
});
test("P15 over-byte trigger works below minimum count and null disables dropping", async () => {
  const n = await seed(5, 1999000);
  expect(store.compactNote(n.id).blobs_deltified).toBeGreaterThan(0);
  expect(h.noteHistoryBytes(db, n.id)).toBeLessThan(8388608);
  const before = await store.countNoteVersions(n.id);
  h.compactNote(db, n.id, h.resolveHistoryPolicy({ max_bytes_per_note: null }));
  expect(await store.countNoteVersions(n.id)).toBe(before);
});
test("P15 attribution drops while indirect base remains on disk", async () => {
  const n = await seed();
  store.compactNote(n.id);
  const base = db.prepare("SELECT delta_of FROM note_blobs WHERE encoding='fossil-delta' LIMIT 1").get() as any;
  const before = h.noteHistoryBytes(db, n.id), count = blobs().length;
  db.prepare("DELETE FROM note_versions WHERE note_id=? AND content_hash=?").run(n.id, base.delta_of);
  h.gcBlobs(db);
  expect(h.noteHistoryBytes(db, n.id)).toBeLessThan(before);
  expect(blobs()).toHaveLength(count);
});
test("P17 creation time capture, restore marker and pre-v30 fallback", async () => {
  const n = await seed(2);
  await store.deleteNote(n.id);
  expect((await store.listNoteVersions(n.id)).every(v => v.created_at === n.createdAt)).toBe(true);
  expect((await store.restoreNoteVersion(n.id, 0, {})).createdAt).toBe(n.createdAt);
  expect((await store.listNoteVersions(n.id))[0]!.created_at).toBe(n.createdAt);
  await store.deleteNote(n.id);
  const tomb = (await store.listNoteVersions(n.id))[0]!;
  db.prepare("UPDATE note_versions SET created_at=NULL WHERE note_id=?").run(n.id);
  expect((await store.restoreNoteVersion(n.id, 0, {})).createdAt).toBe(tomb.superseded_at);
});
test("P18/P19 counts, clamps and defaults", async () => {
  const n = await seed(7);
  expect(await store.countNoteVersions(n.id)).toBe(7);
  expect(await store.countNoteVersions("absent")).toBe(0);
  expect(h.resolveHistoryPolicy({ compact_ratio: 0, compact_run_length: 500, max_bytes_per_note: 10 })).toMatchObject({ compact_ratio: 1, compact_run_length: 100, max_bytes_per_note: 65536, compact_budget_ms: 250, compact_max_notes: 50 });
  expect(h.resolveHistoryPolicy({ max_bytes_per_note: null }).max_bytes_per_note).toBeNull();
});
test("P20 oldest 116KB version reads p95 under 50ms", async () => {
  const n = await seed(24, 116000);
  store.compactNote(n.id);
  const times: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    expect((await store.getNoteVersion(n.id, 0))!.content).toBe(n.content);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log("P20 read latency", { p50: times[20], p95: times[38], max: times[39] });
  expect(times[38]!).toBeLessThan(50);
});
test("P23 corrupt chain cannot rewrite a healthy whole; vault continues", async () => {
  const n = await seed(12), good = await seed(12, 20000, "good");
  const rows = await store.listNoteVersions(n.id);
  expect(codec).not.toBeNull();
  const [r, d, w] = rows;
  const original = blobs();
  const content = (hash: string) => (db.prepare("SELECT content FROM note_blobs WHERE hash=?").get(hash) as any).content as string;
  const dt = content(d!.content_hash!), wt = content(w!.content_hash!), rt = content(r!.content_hash!);
  db.prepare("UPDATE note_blobs SET content=?,encoding='fossil-delta',delta_of=? WHERE hash=?").run(codec!.encodeDelta(wt, dt), w!.content_hash, d!.content_hash);
  db.prepare("UPDATE note_blobs SET content=?,encoding='fossil-delta',delta_of=? WHERE hash=?").run(codec!.encodeDelta(dt, rt), d!.content_hash, r!.content_hash);
  const before = blobs();
  expect(() => store.compactNote(n.id)).toThrow("base_not_whole");
  expect(blobs()).toEqual(before);
  expect(store.compactHistory({ maxNotes: null, budgetMs: null })).toMatchObject({ notes_failed: 1, notes_compacted: 1 });
  expect((await store.getNoteVersion(good.id, 0))!.content).toBe(good.content);
});
