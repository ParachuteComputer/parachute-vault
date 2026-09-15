import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "./store.js";
import { initSchema, SCHEMA_VERSION } from "./schema.js";
test("P12 v29 opens losslessly, fresh and upgraded columns/indexes agree", async () => {
  const db = new Database(":memory:"), fresh = new Database(":memory:");
  try {
    const store = new BunSqliteStore(db);
    const a = await store.createNote("one"), b = await store.createNote("other");
    await store.updateNote(a.id, { content: "two" });
    await store.updateNote(a.id, { content: "three" });
    await store.deleteNote(a.id);
    await store.updateNote(b.id, { content: "changed" });
    // Remove only v30 additions to recreate the actual v29 table shape.
    db.exec("DROP INDEX IF EXISTS idx_note_blobs_delta_of");
    const cols = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    if (cols("note_blobs").some(c => c.name === "delta_of"))
      db.exec("ALTER TABLE note_blobs DROP COLUMN delta_of");
    if (cols("note_blobs").some(c => c.name === "encoding"))
      db.exec("ALTER TABLE note_blobs DROP COLUMN encoding");
    if (cols("note_versions").some(c => c.name === "created_at"))
      db.exec("ALTER TABLE note_versions DROP COLUMN created_at");
    db.exec("UPDATE schema_version SET version=29");
    const snap = () => ({ blobs: db.prepare("SELECT hash,content,byte_size FROM note_blobs ORDER BY hash").all(), versions: db.prepare("SELECT note_id,version_ix,content_hash,path,metadata,extension,superseded_at,actor,via,op,content_len,encoding FROM note_versions ORDER BY note_id,version_ix").all() });
    const before = snap();
    expect(() => initSchema(db)).not.toThrow();
    expect(SCHEMA_VERSION).toBe(30);
    expect(snap()).toEqual(before);
    expect(db.prepare("SELECT hash FROM note_blobs WHERE delta_of IS NOT NULL OR encoding IS NOT NULL").all()).toEqual([]);
    expect(db.prepare("SELECT note_id FROM note_versions WHERE created_at IS NOT NULL").all()).toEqual([]);
    initSchema(fresh);
    for (const table of ["note_blobs", "note_versions"]) {
      expect(cols(table).map(c => c.name).sort()).toEqual((fresh.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[]).map(c => c.name).sort());
    }
    for (const handle of [db, fresh])
      expect(handle.prepare("SELECT name FROM sqlite_master WHERE name='idx_note_blobs_delta_of'").get()).not.toBeNull();
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    initSchema(db);
    expect(snap()).toEqual(before);
    expect(() => db.exec("UPDATE note_blobs SET delta_of='nosuchhash'")).toThrow("FOREIGN KEY");
  }
  finally {
    db.close();
    fresh.close();
  }
});
