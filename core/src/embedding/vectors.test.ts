import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../store.js";
import {
  getNoteVectorRows,
  deleteObsoleteVectorRows,
  upsertNoteVector,
  countNotesPendingEmbedding,
  getNotesPendingEmbedding,
} from "./vectors.js";
import { normalize, decodeVector } from "./vector-codec.js";

const MODEL = "test-model";

let db: Database;
let store: SqliteStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("upsertNoteVector / getNoteVectorRows", () => {
  it("a fresh note has zero vector rows", async () => {
    const note = await store.createNote("hello", { path: "n" });
    expect(getNoteVectorRows(db, note.id)).toEqual([]);
  });

  it("upsert inserts a new row, readable back with matching hash/model", async () => {
    const note = await store.createNote("hello", { path: "n" });
    upsertNoteVector(db, note.id, { ix: 0, text: "hello" }, normalize(new Float32Array([1, 2, 3])), MODEL, "hash-a");
    const rows = getNoteVectorRows(db, note.id);
    expect(rows).toEqual([{ chunk_ix: 0, model: MODEL, content_hash: "hash-a" }]);
  });

  it("upsert on an existing chunk_ix REPLACES it (re-embed overwrites in place)", async () => {
    const note = await store.createNote("hello", { path: "n" });
    upsertNoteVector(db, note.id, { ix: 0, text: "v1" }, normalize(new Float32Array([1, 0, 0])), MODEL, "hash-v1");
    upsertNoteVector(db, note.id, { ix: 0, text: "v2" }, normalize(new Float32Array([0, 1, 0])), MODEL, "hash-v2");

    const rows = getNoteVectorRows(db, note.id);
    expect(rows.length).toBe(1);
    expect(rows[0].content_hash).toBe("hash-v2");

    const raw = db.prepare("SELECT vector FROM note_vectors WHERE note_id = ? AND chunk_ix = 0").get(note.id) as {
      vector: Uint8Array;
    };
    const decoded = decodeVector(raw.vector);
    expect(decoded[1]).toBeCloseTo(1, 5); // the v2 vector, not v1
  });

  it("a model change on the same chunk_ix also replaces (never appends a second row)", async () => {
    const note = await store.createNote("hello", { path: "n" });
    upsertNoteVector(db, note.id, { ix: 0, text: "x" }, normalize(new Float32Array([1, 0])), "model-a", "hash");
    upsertNoteVector(db, note.id, { ix: 0, text: "x" }, normalize(new Float32Array([0, 1])), "model-b", "hash");
    const rows = getNoteVectorRows(db, note.id);
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe("model-b");
  });

  it("multiple chunk_ix rows coexist independently", async () => {
    const note = await store.createNote("hello", { path: "n" });
    upsertNoteVector(db, note.id, { ix: 0, text: "a" }, normalize(new Float32Array([1, 0])), MODEL, "h0");
    upsertNoteVector(db, note.id, { ix: 1, text: "b" }, normalize(new Float32Array([0, 1])), MODEL, "h1");
    const rows = getNoteVectorRows(db, note.id).sort((a, b) => a.chunk_ix - b.chunk_ix);
    expect(rows.map((r) => r.chunk_ix)).toEqual([0, 1]);
  });
});

describe("deleteObsoleteVectorRows", () => {
  it("removes only the specified chunk_ix rows", async () => {
    const note = await store.createNote("hello", { path: "n" });
    upsertNoteVector(db, note.id, { ix: 0, text: "a" }, normalize(new Float32Array([1, 0])), MODEL, "h0");
    upsertNoteVector(db, note.id, { ix: 1, text: "b" }, normalize(new Float32Array([0, 1])), MODEL, "h1");
    upsertNoteVector(db, note.id, { ix: 2, text: "c" }, normalize(new Float32Array([1, 1])), MODEL, "h2");

    deleteObsoleteVectorRows(db, note.id, [1]);

    const rows = getNoteVectorRows(db, note.id).map((r) => r.chunk_ix).sort();
    expect(rows).toEqual([0, 2]);
  });

  it("is a no-op on an empty list (no IN () syntax error)", async () => {
    const note = await store.createNote("hello", { path: "n" });
    upsertNoteVector(db, note.id, { ix: 0, text: "a" }, normalize(new Float32Array([1, 0])), MODEL, "h0");
    expect(() => deleteObsoleteVectorRows(db, note.id, [])).not.toThrow();
    expect(getNoteVectorRows(db, note.id).length).toBe(1);
  });
});

describe("countNotesPendingEmbedding", () => {
  it("all notes pending when none have vectors", async () => {
    await store.createNote("a", { path: "a" });
    await store.createNote("b", { path: "b" });
    expect(countNotesPendingEmbedding(db, MODEL)).toEqual({ total: 2, pending: 2 });
  });

  it("a note with at least one vector under the active model is no longer pending", async () => {
    const a = await store.createNote("a", { path: "a" });
    await store.createNote("b", { path: "b" });
    upsertNoteVector(db, a.id, { ix: 0, text: "a" }, normalize(new Float32Array([1, 0])), MODEL, "h");
    expect(countNotesPendingEmbedding(db, MODEL)).toEqual({ total: 2, pending: 1 });
  });

  it("a vector under a DIFFERENT model doesn't count toward the active model's embedded set", async () => {
    const a = await store.createNote("a", { path: "a" });
    upsertNoteVector(db, a.id, { ix: 0, text: "a" }, normalize(new Float32Array([1, 0])), "old-model", "h");
    expect(countNotesPendingEmbedding(db, MODEL)).toEqual({ total: 1, pending: 1 });
  });

  it("zero notes: zero total, zero pending", () => {
    expect(countNotesPendingEmbedding(db, MODEL)).toEqual({ total: 0, pending: 0 });
  });

  it("L4: a blank note is excluded from `total` too, not just `pending` — it never counts as pending, and never inflates the denominator either", async () => {
    const real = await store.createNote("real content", { path: "real" });
    await store.createNote("", { path: "blank" });
    // No vector for `real` yet — before this fix `total` would be 2
    // (counting the blank note), so `pending` would be 2 forever (the
    // blank note can never get embedded) instead of settling to 0 once
    // `real` is embedded.
    expect(countNotesPendingEmbedding(db, MODEL)).toEqual({ total: 1, pending: 1 });

    upsertNoteVector(db, real.id, { ix: 0, text: "real content" }, normalize(new Float32Array([1, 0])), MODEL, "h");
    expect(countNotesPendingEmbedding(db, MODEL)).toEqual({ total: 1, pending: 0 });
  });
});

describe("getNotesPendingEmbedding", () => {
  it("returns notes with zero vectors under the active model", async () => {
    const a = await store.createNote("a content", { path: "a" });
    const b = await store.createNote("b content", { path: "b" });
    upsertNoteVector(db, a.id, { ix: 0, text: "a content" }, normalize(new Float32Array([1, 0])), MODEL, "h");

    const pending = getNotesPendingEmbedding(db, MODEL);
    expect(pending.map((n) => n.id)).toEqual([b.id]);
    expect(pending[0].content).toBe("b content");
  });

  it("respects an optional limit", async () => {
    for (let i = 0; i < 5; i++) await store.createNote(`note ${i}`, { path: `n${i}` });
    const pending = getNotesPendingEmbedding(db, MODEL, 2);
    expect(pending.length).toBe(2);
  });

  it("empty array when every note is embedded", async () => {
    const a = await store.createNote("a", { path: "a" });
    upsertNoteVector(db, a.id, { ix: 0, text: "a" }, normalize(new Float32Array([1, 0])), MODEL, "h");
    expect(getNotesPendingEmbedding(db, MODEL)).toEqual([]);
  });

  it("M3: excludes a blank note — never returned as pending, so the sweep can't hammer it forever", async () => {
    await store.createNote("", { path: "blank" });
    const real = await store.createNote("real content", { path: "real" });
    const pending = getNotesPendingEmbedding(db, MODEL);
    expect(pending.map((n) => n.id)).toEqual([real.id]);
  });

  it("M3: excludes a whitespace-only note", async () => {
    await store.createNote("   \n\t  ", { path: "whitespace" });
    expect(getNotesPendingEmbedding(db, MODEL)).toEqual([]);
  });
});
