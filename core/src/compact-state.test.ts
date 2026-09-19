import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "./store.js";
import { initSchema } from "./schema.js";
import { runDoctorScan } from "./doctor.js";
import { pruneVersions, resolveHistoryPolicy, sweepDeletedHistory } from "./history.js";
import { readCompactState } from "./history-compact-state.js";
import { applyImportedNote, beginImportRun, importTargetDigest } from "./history-import.js";
let db: Database, store: BunSqliteStore;
beforeEach(() => { db = new Database(":memory:"); store = new BunSqliteStore(db, { history: { compact_min_versions: 2, compact_ratio: 1 } }); });
afterEach(() => db.close());
const state = (id: string) => db.query("SELECT versions,stored,live,refused FROM history_compact_state WHERE note_id=?").get(id) as { versions: number; stored: number; live: number; refused: number } | null;
test("live bytes refresh after mutation, empty histories are excluded and nonempty edits re-arm", async () => {
  const n = await store.createNote("large".repeat(1000));
  await store.updateNote(n.id, { append: "changed" });
  await store.updateNote(n.id, { content: "" });
  expect(state(n.id)?.live).toBe(0);
  expect(store.compactHistory({ budgetMs: null, maxNotes: null }).notes_scanned).toBe(0);
  await store.updateNote(n.id, { content: "x" });
  expect(state(n.id)?.live).toBe(1);
  expect(store.compactHistory({ budgetMs: null, maxNotes: null }).notes_scanned).toBe(1);
});
test("incompressible refusal disappears on pass two and any metadata capture re-arms", async () => {
  const n = await store.createNote("a");
  await store.updateNote(n.id, { content: "b" });
  await store.updateNote(n.id, { content: "c" });
  expect(store.compactHistory({ budgetMs: null, maxNotes: null }).notes_scanned).toBe(1);
  expect(state(n.id)?.refused).toBe(1);
  expect(store.compactHistory({ budgetMs: null, maxNotes: null }).notes_scanned).toBe(0);
  await store.updateNote(n.id, { metadata: { status: 1 } });
  expect(state(n.id)?.refused).toBe(0);
  expect(store.compactHistory({ budgetMs: null, maxNotes: null }).notes_scanned).toBe(1);
});
test("shared blob rewrites refresh other notes without re-arming refusal", async () => {
  const body = "shared history\n".repeat(1000);
  const a = await store.createNote(body), b = await store.createNote(body);
  await store.updateNote(a.id, { append: "a" });
  await store.updateNote(a.id, { content: "small" });
  await store.updateNote(b.id, { content: "small" });
  db.query("UPDATE history_compact_state SET refused=1 WHERE note_id=?").run(b.id);
  const before = state(b.id)!;
  expect(store.compactNote(a.id).blobs_deltified).toBeGreaterThan(0);
  expect(state(b.id)!.stored).toBeLessThan(before.stored);
  expect(state(b.id)!.refused).toBe(1);
});
test("v31 migration backfills deleted and live history once and preserves bodies", async () => {
  const n = await store.createNote("old");
  await store.updateNote(n.id, { content: "new" });
  await store.deleteNote(n.id);
  const before = db.query("SELECT * FROM note_versions").all();
  db.exec("DROP TABLE history_compact_state; UPDATE schema_version SET version=31");
  initSchema(db);
  expect(state(n.id)).toEqual({ versions: 2, stored: 6, live: 3, refused: 0 });
  expect(db.query("PRAGMA foreign_key_list(history_compact_state)").all()).toEqual([]);
  expect(db.query("SELECT * FROM note_versions").all()).toEqual(before);
  expect((await store.getNoteVersion(n.id, 0))?.content).toBe("old");
  db.query("UPDATE history_compact_state SET refused=1").run();
  initSchema(db);
  expect(state(n.id)?.refused).toBe(1);
  await store.eraseNoteHistory(n.id);
  expect(state(n.id)).toBeNull();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("doctor reports bounded hint drift without repairing history", async () => {
  const n = await store.createNote("before");
  await store.updateNote(n.id, { content: "after" });
  db.query("UPDATE history_compact_state SET stored=999 WHERE note_id=?").run(n.id);
  const result = runDoctorScan(db);
  expect(result.findings.some(f => f.type === ("history_compact_state_drift" as any) && f.severity === "warning")).toBe(true);
  expect(state(n.id)?.stored).toBe(999);
  expect(runDoctorScan(db, { allowedTags: ["restricted"] }).findings.some(f => f.type === "history_compact_state_drift")).toBe(false);
});
test("prune, imported observations, deleted compaction and sweep maintain exact counters", async () => {
  const n = await store.createNote("body".repeat(1000));
  const exact = () => {
    const actual = readCompactState(db, n.id)!;
    expect(state(n.id)).toMatchObject({ versions: actual.versions, stored: actual.stored, live: actual.live });
  };
  for (let i=0;i<4;i++) { await store.updateNote(n.id, { append: String(i) }); exact(); }
  const policy = resolveHistoryPolicy({ min_versions: 1, max_versions: 2, compact_min_versions: 2, compact_ratio: 1 });
  db.transaction(() => pruneVersions(db, n.id, policy))(); exact();
  const run = { run_id: "state-test", source_fingerprint: "source", tip: "tip", options_digest: "options" };
  beginImportRun(db, run);
  applyImportedNote(db, { run, noteId: n.id, targetDigest: importTargetDigest(db, n.id), policy: resolveHistoryPolicy({ enabled: false }), now: Date.now(), observations: [{ content: "import", path: null, metadata: {}, extension: "md", created_at: null, observed_at: new Date().toISOString(), commit: "commit", blob: "blob" }] });
  exact(); expect(state(n.id)?.refused).toBe(0);
  await store.deleteNote(n.id); exact();
  expect(store.compactNote(n.id).blobs_deltified).toBeGreaterThan(0); exact();
  const remaining = await store.listNoteVersions(n.id);
  for (const v of remaining) expect((await store.getNoteVersion(n.id, v.version_ix))?.content).not.toBeNull();
  expect(db.query("SELECT 1 FROM note_blobs b JOIN note_blobs base ON base.hash=b.delta_of WHERE base.encoding IS NOT NULL").all()).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  sweepDeletedHistory(db, resolveHistoryPolicy({ deleted_retention_days: 1 }), new Date(Date.now()+3*86400000));
  expect(state(n.id)).toBeNull();
});
test("explicit-ID recreation refreshes live bytes and bounded remaining is a total", async () => {
  for(let i=0;i<10;i++) {
    const n = await store.createNote("abc", { id: `candidate-${i}` });
    await store.updateNote(n.id, { content: "def" });
    await store.updateNote(n.id, { content: "x" });
  }
  const first = store.compactHistory({ maxNotes: 1, budgetMs: null });
  expect(first.remaining_candidates).toBe(9);
  await store.deleteNote("candidate-0");
  await store.createNoteRaw("", { id: "candidate-0" });
  expect(state("candidate-0")?.live).toBe(0);
});
test("failed enclosing write rolls back history and scheduling state together", async () => {
  const n = await store.createNote("before");
  await store.updateNote(n.id, { content: "after" });
  const before = state(n.id);
  db.exec("CREATE TRIGGER reject_hint BEFORE UPDATE ON history_compact_state BEGIN SELECT RAISE(ABORT,'injected refresh failure'); END");
  await expect(store.updateNote(n.id, { content: "must roll back" })).rejects.toThrow("injected refresh failure");
  expect((await store.getNote(n.id))?.content).toBe("after");
  expect(state(n.id)).toEqual(before);
  expect(await store.countNoteVersions(n.id)).toBe(1);
});
