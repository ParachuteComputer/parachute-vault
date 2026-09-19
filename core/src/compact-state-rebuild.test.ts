import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "./store.js";
import { initSchema } from "./schema.js";
import { runDoctorScan } from "./doctor.js";

test("no ledger rows are not evidence of a downgrade", async () => {
  const db = new Database(":memory:");
  try {
    const store = new BunSqliteStore(db);
    const note = await store.createNote("before");
    await store.updateNote(note.id, { content: "after" });
    db.exec("DELETE FROM schema_version; UPDATE history_compact_state SET refused=1");
    initSchema(db);
    expect(db.prepare("SELECT refused FROM history_compact_state").get()).toEqual({ refused: 1 });
    db.exec("DROP TABLE history_compact_state; DELETE FROM schema_version");
    initSchema(db);
    expect(db.prepare("SELECT versions,refused FROM history_compact_state").get()).toEqual({ versions: 1, refused: 0 });
  } finally { db.close(); }
});

for (const tied of [false, true]) test(`a downgrade ledger entry rebuilds existing stale hints (tied=${tied})`, async () => {
  const db = new Database(":memory:");
  try {
    const store = new BunSqliteStore(db, { history: { compact_min_versions: 2, compact_ratio: 1 } });
    const note = await store.createNote("old".repeat(1000));
    await store.updateNote(note.id, { append: "first" });
    const stale = db.prepare("SELECT * FROM history_compact_state WHERE note_id=?").get(note.id) as any;
    await store.updateNote(note.id, { append: "second" });
    await store.updateNote(note.id, { content: "x" });
    // Reproduce the older writer: history/live rows advance but hints do not,
    // and that binary records its own version on open.
    db.prepare("UPDATE history_compact_state SET versions=?,stored=?,live=?,refused=1 WHERE note_id=?").run(stale.versions, stale.stored, stale.live, note.id);
    db.prepare("UPDATE schema_version SET applied_at='2026-01-01T00:00:00.000Z'").run();
    db.prepare("INSERT OR REPLACE INTO schema_version VALUES(31,?)").run(tied ? "2026-01-01T00:00:00.000Z" : "2026-01-02T00:00:00.000Z");
    expect(runDoctorScan(db).findings.some(f=>f.type==="history_compact_state_drift")).toBe(true);
    const rows = db.prepare("SELECT * FROM note_versions").all();
    initSchema(db);
    expect(runDoctorScan(db).findings.some(f=>f.type==="history_compact_state_drift")).toBe(false);
    expect(db.prepare("SELECT * FROM note_versions").all()).toEqual(rows);
    expect(store.compactHistory({ budgetMs: null, maxNotes: null }).notes_scanned).toBe(1);
    db.prepare("UPDATE history_compact_state SET refused=1").run();
    initSchema(db);
    expect(db.prepare("SELECT refused FROM history_compact_state WHERE note_id=?").get(note.id)).toEqual({ refused: 1 });
  } finally { db.close(); }
});
