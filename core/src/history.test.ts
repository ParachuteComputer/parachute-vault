import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "./store.js";
// Keep base runs executable: the absent module makes individual pins RED,
// rather than aborting collection for the entire file.
const history = await import("./history.js").catch(() => null);
let db: Database;
let store: BunSqliteStore;
beforeEach(() => {
  db = new Database(":memory:");
  store = new BunSqliteStore(db);
});
afterEach(() => db.close());
const count = (table: "note_versions" | "note_blobs") =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("vault#524 history retention and blob integrity", () => {
  it("P2 metadata flips share one 116 KB body after the first capture", async () => {
    const body = "é".repeat(58_000);
    const n = await store.createNote(body, { path: "p" });
    await store.updateNote(n.id, { metadata: { status: 1 } });
    const bytes = (
      db.prepare("SELECT SUM(byte_size) AS n FROM note_blobs").get() as {
        n: number;
      }
    ).n;
    let previous = (await store.listNoteVersions(n.id))[0]!;
    for (let i = 2; i <= 5; i++) {
      await store.updateNote(n.id, { metadata: { status: i } });
      expect(count("note_blobs")).toBe(1);
      expect(
        (
          db.prepare("SELECT SUM(byte_size) AS n FROM note_blobs").get() as {
            n: number;
          }
        ).n,
      ).toBe(bytes);
      const rows = await store.listNoteVersions(n.id);
      expect(rows).toHaveLength(i);
      expect(rows[0]!.content_hash).toBe(previous.content_hash);
      expect(rows[0]!.content_len).toBe(116_000);
      previous = rows[0]!;
    }
    const size = db
      .prepare(
        `SELECT LENGTH(CAST(path AS BLOB))+LENGTH(CAST(metadata AS BLOB))+LENGTH(CAST(extension AS BLOB))+
      LENGTH(CAST(superseded_at AS BLOB))+LENGTH(CAST(COALESCE(actor,'') AS BLOB))+LENGTH(CAST(COALESCE(via,'') AS BLOB))+
      LENGTH(CAST(op AS BLOB))+LENGTH(CAST(content_hash AS BLOB))+32 AS n FROM note_versions WHERE note_id=? AND version_ix=4`,
      )
      .get(n.id) as { n: number };
    expect(size.n).toBeLessThan(1024);
  });
  for (const [edits, age, expected, minIx] of [
    [4, 1, 4, 0],
    [8, 1, 5, 3],
    [2, 0, 2, 0],
    [9, 0, 3, 6],
  ]) {
    it(`P3 retention arithmetic ${edits} edits age ${age}`, async () => {
      store = new BunSqliteStore(db, {
        history: { min_versions: 3, max_versions: 5, max_age_days: age },
      });
      const n = await store.createNote("start");
      for (let i = 0; i < edits!; i++) {
        await store.updateNote(n.id, { content: String(i) });
        await new Promise((r) => setTimeout(r, 2));
      }
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n, MIN(version_ix) AS lo, MAX(version_ix) AS hi FROM note_versions WHERE note_id=?",
        )
        .get(n.id) as { n: number; lo: number; hi: number };
      expect(row).toEqual({ n: expected, lo: minIx, hi: edits! - 1 });
    });
  }
  it("P6 shared blobs survive pruning and vanish only after the last reference", async () => {
    const a = await store.createNote("shared"),
      b = await store.createNote("shared");
    await store.updateNote(a.id, { content: "a" });
    await store.updateNote(b.id, { content: "b" });
    expect(count("note_blobs")).toBe(1);
    const hash = (await store.listNoteVersions(a.id))[0]!.content_hash;
    expect(() =>
      db.prepare("DELETE FROM note_blobs WHERE hash=?").run(hash),
    ).toThrow(/FOREIGN KEY/);
    db.prepare("UPDATE note_versions SET superseded_at=? WHERE note_id=?").run(
      "2000-01-01T00:00:00.000Z",
      a.id,
    );
    history!.pruneVersions(
      db,
      a.id,
      history!.resolveHistoryPolicy({
        min_versions: 0,
        max_versions: 1,
        max_age_days: 1,
      }),
    );
    expect(count("note_versions")).toBe(1);
    expect(count("note_blobs")).toBe(1);
    await store.eraseNoteHistory(b.id);
    expect(count("note_blobs")).toBe(0);
  });
  it("P7a null deleted retention issues no query and keeps history", async () => {
    const n = await store.createNote("one");
    await store.updateNote(n.id, { content: "two" });
    await store.deleteNote(n.id);
    const before = count("note_versions");
    const probe = new Proxy(db, {
      get(target, key) {
        if (key === "prepare") throw new Error("query attempted");
        return Reflect.get(target, key);
      },
    });
    expect(
      history!.sweepDeletedHistory(probe, history!.resolveHistoryPolicy()),
    ).toEqual({ notesSwept: 0, versionsDeleted: 0, blobsDeleted: 0 });
    expect(count("note_versions")).toBe(before);
  });
  it("P7b sweeps old deleted chains and preserves recent deleted and live chains", async () => {
    store = new BunSqliteStore(db, { history: { deleted_retention_days: 7 } });
    const old = await store.createNote("old"),
      recent = await store.createNote("recent"),
      live = await store.createNote("live");
    await store.deleteNote(old.id);
    await store.deleteNote(recent.id);
    await store.updateNote(live.id, { content: "now" });
    db.prepare(
      "UPDATE note_versions SET superseded_at='2000-01-01T00:00:00.000Z' WHERE note_id IN (?,?)",
    ).run(old.id, live.id);
    expect(store.sweepDeletedHistory()).toEqual({
      notesSwept: 1,
      versionsDeleted: 1,
      blobsDeleted: 1,
    });
    expect(await store.listNoteVersions(old.id)).toHaveLength(0);
    expect(await store.listNoteVersions(recent.id)).toHaveLength(1);
    expect(await store.listNoteVersions(live.id)).toHaveLength(1);
  });
  it("P7c tombstones survive the version ceiling", async () => {
    store = new BunSqliteStore(db, {
      history: { min_versions: 0, max_versions: 1 },
    });
    const n = await store.createNote("a");
    await store.deleteNote(n.id);
    await store.createNote("b", { id: n.id });
    await store.updateNote(n.id, { content: "c" });
    expect((await store.listNoteVersions(n.id)).map((v) => v.op)).toEqual([
      "update",
      "delete",
    ]);
  });
  it("P13 oversized prior body rejects update with no partial history", async () => {
    const content = "é".repeat(1_000_001),
      n = await store.createNote(content);
    await expect(
      store.updateNote(n.id, { content: "small" }),
    ).rejects.toMatchObject({ code: "HISTORY_OVERFLOW" });
    expect((await store.getNote(n.id))!.content).toBe(content);
    expect(count("note_versions")).toBe(0);
    expect(count("note_blobs")).toBe(0);
  });
  it("P19a/b oversized delete records size and attribution without a blob", async () => {
    const content = "é".repeat(1_000_001),
      n = await store.createNote(content);
    await expect(
      store.updateNote(n.id, { content: "x" }),
    ).rejects.toMatchObject({ code: "HISTORY_OVERFLOW" });
    await store.deleteNote(n.id, { actor: "a", via: "v" });
    expect(await store.getNote(n.id)).toBeNull();
    expect(count("note_blobs")).toBe(0);
    expect(await store.getNoteVersion(n.id, 0)).toMatchObject({
      op: "delete",
      content_hash: null,
      encoding: "overflow",
      content: null,
      content_len: 2_000_002,
      actor: "a",
      via: "v",
    });
  });
  it("P19d NULL overflow hash cannot poison full blob GC", async () => {
    const n = await store.createNote("x".repeat(2_000_001));
    await store.deleteNote(n.id);
    const second = await store.createNote("orphan");
    await store.updateNote(second.id, { content: "new" });
    db.prepare("DELETE FROM note_versions WHERE note_id=?").run(second.id);
    expect(count("note_blobs")).toBe(1);
    const third = await store.createNote("third");
    await store.eraseNoteHistory(third.id);
    expect(count("note_blobs")).toBe(0);
    expect(count("note_versions")).toBe(1);
  });
  it("P21 clamp preserves the 100-version floor without unbounded growth", async () => {
    expect(
      history!.resolveHistoryPolicy({ min_versions: 100, max_versions: 20 })
        .max_versions,
    ).toBe(100);
    store = new BunSqliteStore(db, {
      history: { min_versions: 100, max_versions: 20 },
    });
    const n = await store.createNote("0");
    for (let i = 0; i < 150; i++)
      await store.updateNote(n.id, { content: String(i) });
    expect(count("note_versions")).toBe(100);
  });
  it("P21 zero ceiling keeps the newest version and absurd ages cannot break writes", async () => {
    const policy = history!.resolveHistoryPolicy({
      min_versions: 0,
      max_versions: 0,
      max_age_days: 200000000,
      deleted_retention_days: 200000000,
    });
    expect(policy).toMatchObject({
      max_versions: 1,
      max_age_days: 36500,
      deleted_retention_days: 36500,
    });
    store = new BunSqliteStore(db, { history: policy });
    const n = await store.createNote("first");
    await store.updateNote(n.id, { content: "second" });
    await store.updateNote(n.id, { content: "third" });
    expect(await store.listNoteVersions(n.id)).toHaveLength(1);
    expect((await store.getNoteVersion(n.id, 1))!.content).toBe("second");
    await store.deleteNote(n.id);
    history!.sweepDeletedHistory(db, policy);
    expect(await store.getNote(n.id)).toBeNull();
  });
});
