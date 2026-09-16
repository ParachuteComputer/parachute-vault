import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { initSchema } from "./schema.js";

test("v30 to v31 retains native history and matches fresh import tables; reopening is idempotent", async () => {
  const db = new Database(":memory:"), fresh = new Database(":memory:");
  try {
    const store = new SqliteStore(db), note = await store.createNote("before");
    await store.updateNote(note.id, { content: "after" });
    const tables = ["history_import_refs", "history_import_receipts", "history_import_runs"];
    for (const table of tables) db.exec(`DROP TABLE ${table}`);
    db.exec("UPDATE schema_version SET version=30");
    const before = db.query("SELECT * FROM note_versions").all();
    initSchema(db); initSchema(fresh); initSchema(db);
    expect(db.query("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 31 });
    expect(db.query("SELECT * FROM note_versions").all()).toEqual(before);
    for (const table of tables) {
      expect(db.query(`PRAGMA table_info(${table})`).all()).toEqual(fresh.query(`PRAGMA table_info(${table})`).all());
      expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally { db.close(); fresh.close(); }
});
