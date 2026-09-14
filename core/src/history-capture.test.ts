import { it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BunSqliteStore } from "./store.js";
import {
  exportVaultToDir,
  FsImportSource,
  importVault,
} from "./portable-md.js";
let db: Database, store: BunSqliteStore;
beforeEach(() => {
  db = new Database(":memory:");
  store = new BunSqliteStore(db);
});
afterEach(() => db.close());
const count = (table: "note_versions" | "note_blobs") =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
for (const leg of ["path", "transition"] as const)
  it(`P1 rollback after ${leg} rejection leaves no phantom history`, async () => {
    const n = await store.createNote("original", {
      path: "a",
      metadata: { status: "a" },
    });
    await store.createNote("occupied", { path: "b" });
    const before = count("note_blobs");
    if (leg === "path")
      await expect(
        store.updateNote(n.id, { content: "bad", path: "b" }),
      ).rejects.toMatchObject({ code: "PATH_CONFLICT" });
    else
      await expect(
        store.updateNote(n.id, {
          content: "bad",
          state_transition: { field: "status", from: "wrong", to: "b" },
        }),
      ).rejects.toMatchObject({ code: "TRANSITION_CONFLICT" });
    expect(count("note_versions")).toBe(0);
    expect(count("note_blobs")).toBe(before);
    expect((await store.getNote(n.id))!.content).toBe("original");
  });
it("P4 sequential append/prepend preserve reconstructable prior bodies", async () => {
  const content = "---\ntitle: T\n---\nbody\n";
  const n = await store.createNote(content);
  await store.updateNote(n.id, { append: "a\n" });
  await store.updateNote(n.id, { prepend: "p\n" });
  const rows = await store.listNoteVersions(n.id);
  expect(rows).toHaveLength(2);
  expect(rows.map((v) => v.version_ix)).toEqual([1, 0]);
  expect(rows.map((v) => v.op)).toEqual(["prepend", "append"]);
  expect(rows[0]!.content_hash).not.toBe(rows[1]!.content_hash);
  expect((await store.getNoteVersion(n.id, 0))!.content + "a\n").toBe(
    (await store.getNoteVersion(n.id, 1))!.content!,
  );
  expect((await store.getNote(n.id))!.content).toBe(
    "---\ntitle: T\n---\np\nbody\na\n",
  );
  // This pin makes no concurrency claim: synchronous transactions serialize these calls.
});
it("P5 live restore captures the prior body and preserves the source version", async () => {
  const n = await store.createNote("0", { path: "original" });
  for (let i = 1; i <= 5; i++)
    await store.updateNote(n.id, { content: String(i) });
  const source = await store.getNoteVersion(n.id, 1),
    before = await store.getNote(n.id);
  const r = await store.restoreNoteVersion(n.id, 1, {
    actor: "restorer",
    via: "api",
  });
  expect(r.content).toBe(source!.content!);
  expect(r.updatedAt! > before!.updatedAt!).toBe(true);
  expect(r.lastUpdatedBy).toBe("restorer");
  const rows = await store.listNoteVersions(n.id);
  expect(rows).toHaveLength(6);
  expect(rows[0]!.op).toBe("restore");
  expect((await store.getNoteVersion(n.id, rows[0]!.version_ix))!.content).toBe(
    "5",
  );
  expect(await store.getNoteVersion(n.id, 1)).toEqual(source);
});
it("P5 restore reads its source before a one-version prune", async () => {
  store = new BunSqliteStore(db, {
    history: { min_versions: 1, max_versions: 1 },
  });
  const n = await store.createNote("one");
  await store.updateNote(n.id, { content: "two" });
  expect((await store.restoreNoteVersion(n.id, 0, {})).content).toBe("one");
  expect(await store.listNoteVersions(n.id)).toHaveLength(1);
});
it("P8a tag rename captures only rewritten notes", async () => {
  await store.upsertTagRecord("old", {});
  const a = await store.createNote("#old a"),
    b = await store.createNote("#old b"),
    c = await store.createNote("untouched");
  await store.renameTag("old", "new");
  for (const n of [a, b])
    expect(await store.getNoteVersion(n.id, 0)).toMatchObject({
      op: "tag-rename",
      content: n.content,
    });
  expect(await store.listNoteVersions(c.id)).toHaveLength(0);
});
it("P8b path rename captures the source brackets and renamed note", async () => {
  const b = await store.createNote("B", { path: "B" }),
    a = await store.createNote("see [[B]]", { path: "A" });
  await store.updateNote(b.id, { path: "C", actor: "renamer", via: "api" });
  expect(await store.getNoteVersion(a.id, 0)).toMatchObject({
    content: "see [[B]]",
    op: "cascade-rename",
    actor: "renamer",
    via: "api",
  });
  expect(await store.getNoteVersion(b.id, 0)).toMatchObject({
    path: "B",
    op: "update",
  });
});
it("P9 skipUpdatedAt metadata writes still capture with NULL attribution", async () => {
  const n = await store.createNote("body");
  const r = await store.updateNote(n.id, {
    metadata: { x: 1 },
    skipUpdatedAt: true,
  });
  expect(r.updatedAt).toBe(n.updatedAt);
  expect(await store.listNoteVersions(n.id)).toHaveLength(1);
  expect(await store.getNoteVersion(n.id, 0)).toMatchObject({
    actor: null,
    via: null,
    op: "update",
    metadata: {},
  });
});
it("P10 deletion captures final state; blow-away opt-out does not", async () => {
  const a = await store.createNote("final"),
    b = await store.createNote("skip");
  await store.deleteNote(a.id, { actor: "a", via: "v" });
  await store.deleteNote(b.id, { captureHistory: false });
  expect(await store.getNote(a.id)).toBeNull();
  expect(await store.getNoteVersion(a.id, 0)).toMatchObject({
    content: "final",
    op: "delete",
    actor: "a",
    via: "v",
  });
  expect(await store.listNoteVersions(b.id)).toHaveLength(0);
});
it("P11b skipUpdatedAt transition reaches the mutating-key guard", async () => {
  const n = await store.createNote("body", { metadata: { status: "a" } });
  const r = await store.updateNote(n.id, {
    state_transition: { field: "status", from: "a", to: "b" },
    skipUpdatedAt: true,
  });
  expect(r.updatedAt).toBe(n.updatedAt);
  expect(await store.listNoteVersions(n.id)).toHaveLength(1);
  expect(await store.getNoteVersion(n.id, 0)).toMatchObject({
    metadata: { status: "a" },
  });
});
it("P12 blow-away round trip reattaches the existing version chains", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "history-import-"));
  try {
    const notes = [];
    for (let i = 0; i < 3; i++) {
      const n = await store.createNote("a", { path: `p${i}` });
      await store.updateNote(n.id, { content: "b" });
      await store.updateNote(n.id, { content: "c" });
      notes.push(n);
    }
    const before = new Map(
      await Promise.all(
        notes.map(
          async (n) => [n.id, await store.listNoteVersions(n.id)] as const,
        ),
      ),
    );
    await exportVaultToDir(store, { outDir, vaultName: "history" });
    const stats = await importVault(
      store,
      new FsImportSource({ inDir: outDir }),
      { blowAway: true },
    );
    expect(stats.notes_wiped).toBe(3);
    expect(stats.notes_created).toBe(3);
    expect(stats.notes_updated).toBe(0);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM note_versions WHERE op='delete'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
    // Replay recreates these IDs, with zero update-branch upserts, so MAX advances by zero.
    for (const n of notes)
      expect(await store.listNoteVersions(n.id)).toEqual(before.get(n.id)!);
    for (const n of notes) await store.deleteNote(n.id);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM note_versions WHERE op='delete'")
          .get() as { n: number }
      ).n,
    ).toBe(3);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
it("P20 re-create uses tombstone path/time, selected metadata, no tags", async () => {
  const n = await store.createNote("one", {
    path: "p",
    tags: ["work"],
    metadata: { k: 1 },
  });
  await store.updateNote(n.id, { content: "two", metadata: { k: 2 } });
  await store.deleteNote(n.id, { actor: "a" });
  const tomb = (await store.listNoteVersions(n.id))[0]!;
  const r = await store.restoreNoteVersion(n.id, 0, {});
  expect(r).toMatchObject({
    id: n.id,
    path: "p",
    content: "one",
    metadata: { k: 1 },
    tags: [],
    createdAt: tomb.superseded_at,
  });
  const rows = await store.listNoteVersions(n.id);
  expect(rows[0]).toMatchObject({
    op: "restore",
    content_hash: tomb.content_hash,
  });
  expect(rows.some((v) => v.op === "delete")).toBe(true);
});
it("P20d path collision rolls back re-creation and its marker", async () => {
  const n = await store.createNote("one", { path: "p" });
  await store.deleteNote(n.id);
  await store.createNote("other", { path: "p" });
  const before = await store.listNoteVersions(n.id);
  await expect(store.restoreNoteVersion(n.id, 0, {})).rejects.toMatchObject({
    code: "PATH_CONFLICT",
  });
  expect(await store.getNote(n.id)).toBeNull();
  expect(await store.listNoteVersions(n.id)).toEqual(before);
});
