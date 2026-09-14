import { it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./schema.js";
import { BunSqliteStore } from "./store.js";
let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});
afterEach(() => db.close());
function dropHistory() {
  db.exec(
    "DROP TABLE IF EXISTS note_versions; DROP TABLE IF EXISTS note_blobs;",
  );
}
it("P14a v28 upgrade creates both tables and three indexes without backfill", () => {
  dropHistory();
  db.prepare("UPDATE schema_version SET version=28").run();
  initSchema(db);
  expect(
    db.prepare("SELECT MAX(version) AS version FROM schema_version").get(),
  ).toEqual({ version: 29 });
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('note_versions','note_blobs') ORDER BY name",
    )
    .all();
  expect(tables).toEqual([{ name: "note_blobs" }, { name: "note_versions" }]);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_note_versions_note','idx_note_versions_hash','idx_note_versions_superseded')",
      )
      .all(),
  ).toHaveLength(3);
  expect(db.prepare("SELECT COUNT(*) AS n FROM note_versions").get()).toEqual({
    n: 0,
  });
});
it("P14b repeated init is idempotent", () => {
  initSchema(db);
  initSchema(db);
  expect(db.prepare("SELECT COUNT(*) AS n FROM note_versions").get()).toEqual({
    n: 0,
  });
});
it("P14c rerunning the v29 migration preserves captured rows", async () => {
  const store = new BunSqliteStore(db);
  const n = await store.createNote("a");
  await store.updateNote(n.id, { content: "b" });
  db.prepare("UPDATE schema_version SET version=28").run();
  initSchema(db);
  expect((await store.getNoteVersion(n.id, 0))!.content).toBe("a");
});
it("P14d missing tables before the first capture degrade to no history", async () => {
  const store = new BunSqliteStore(db);
  const n = await store.createNote("a");
  // Drop before this handle has probed true. A drop after capture is an
  // accepted throw because historyTablesPresent memoises true per handle.
  dropHistory();
  await store.updateNote(n.id, { content: "b" });
  expect((await store.getNote(n.id))!.content).toBe("b");
});
