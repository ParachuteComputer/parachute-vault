import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { semanticSearchNotes } from "./notes.js";
import { encodeVector, normalize } from "./embedding/vector-codec.js";

const MODEL = "test-model";
const DIMS = 4;

let db: Database;
let store: SqliteStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

/** Insert a chunk_ix=0 vector row for a note under the test model. */
function insertVector(noteId: string, vector: number[]): void {
  const encoded = encodeVector(normalize(new Float32Array(vector)));
  db.prepare(
    `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at)
     VALUES (?, 0, ?, ?, ?, ?, ?)`,
  ).run(noteId, encoded, DIMS, MODEL, "hash", new Date().toISOString());
}

function insertChunkVector(noteId: string, ix: number, vector: number[]): void {
  const encoded = encodeVector(normalize(new Float32Array(vector)));
  db.prepare(
    `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(noteId, ix, encoded, DIMS, MODEL, `hash-${ix}`, new Date().toISOString());
}

describe("semanticSearchNotes", () => {
  it("ranks notes by cosine similarity, highest first", async () => {
    const a = await store.createNote("note a", { path: "a" });
    const b = await store.createNote("note b", { path: "b" });
    const c = await store.createNote("note c", { path: "c" });

    const query = normalize(new Float32Array([1, 0, 0, 0]));
    insertVector(a.id, [1, 0, 0, 0]); // identical direction — score ~1
    insertVector(b.id, [0, 1, 0, 0]); // orthogonal — score ~0
    insertVector(c.id, [0.9, 0.1, 0, 0]); // close-ish — score high but < a

    const result = semanticSearchNotes(db, query, {}, MODEL);
    expect(result.notes.map((n) => n.id)).toEqual([a.id, c.id, b.id]);
    expect(result.notes[0].score).toBeCloseTo(1, 4);
    expect(result.totalCandidates).toBe(3);
    expect(result.pendingCount).toBe(0);
  });

  it("respects limit (top-K)", async () => {
    const query = normalize(new Float32Array([1, 0, 0, 0]));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const n = await store.createNote(`note ${i}`, { path: `n${i}` });
      ids.push(n.id);
      insertVector(n.id, [1 - i * 0.01, 0.01 * i, 0, 0]);
    }
    const result = semanticSearchNotes(db, query, { limit: 2 }, MODEL);
    expect(result.notes.length).toBe(2);
    expect(result.totalCandidates).toBe(5);
  });

  it("filter-then-rank: structured filters (tags) narrow the candidate set BEFORE ranking", async () => {
    const query = normalize(new Float32Array([1, 0, 0, 0]));
    const tagged = await store.createNote("tagged note", { path: "tagged", tags: ["project"] });
    const untagged = await store.createNote("untagged note", { path: "untagged" });
    // untagged has the objectively CLOSER vector, but is filtered out by `tags`.
    insertVector(tagged.id, [0.5, 0.5, 0, 0]);
    insertVector(untagged.id, [1, 0, 0, 0]);

    const result = semanticSearchNotes(db, query, { tags: ["project"] }, MODEL);
    expect(result.notes.map((n) => n.id)).toEqual([tagged.id]);
    expect(result.totalCandidates).toBe(1);
  });

  it("pendingCount: candidates with no vector row for the active model are excluded from ranking but counted as pending", async () => {
    const query = normalize(new Float32Array([1, 0, 0, 0]));
    const embedded = await store.createNote("embedded", { path: "embedded" });
    const notYetEmbedded = await store.createNote("not yet embedded", { path: "pending" });
    insertVector(embedded.id, [1, 0, 0, 0]);
    // notYetEmbedded gets no note_vectors row at all.

    const result = semanticSearchNotes(db, query, {}, MODEL);
    expect(result.notes.map((n) => n.id)).toEqual([embedded.id]);
    expect(result.totalCandidates).toBe(2);
    expect(result.pendingCount).toBe(1);
  });

  it("ignores vectors recorded under a DIFFERENT model", async () => {
    const query = normalize(new Float32Array([1, 0, 0, 0]));
    const note = await store.createNote("note", { path: "n" });
    const encoded = encodeVector(normalize(new Float32Array([1, 0, 0, 0])));
    db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at)
       VALUES (?, 0, ?, ?, 'stale-model', 'hash', ?)`,
    ).run(note.id, encoded, DIMS, new Date().toISOString());

    const result = semanticSearchNotes(db, query, {}, MODEL);
    expect(result.notes).toEqual([]);
    expect(result.pendingCount).toBe(1); // no row under the ACTIVE model
  });

  it("best-chunk ranking: a long note's best-matching SECTION outranks a note with weak whole-note similarity", async () => {
    // This is the exact case chunking exists for (P0's dominant miss
    // pattern: whole-note embedding dilutes long, multi-topic notes).
    const query = normalize(new Float32Array([1, 0, 0, 0]));

    const longNote = await store.createNote("a long multi-section note", { path: "long" });
    // Section 0 is about something unrelated (poor match); section 2 is a
    // strong match for the query — best-chunk ranking must pick that up.
    insertChunkVector(longNote.id, 0, [0, 1, 0, 0]); // orthogonal — weak
    insertChunkVector(longNote.id, 1, [0.3, 0.3, 0.3, 0.3]); // mediocre
    insertChunkVector(longNote.id, 2, [1, 0, 0, 0]); // strong match

    const shortNote = await store.createNote("a short weakly-related note", { path: "short" });
    insertVector(shortNote.id, [0.5, 0.5, 0, 0]); // weak whole-note similarity

    const result = semanticSearchNotes(db, query, {}, MODEL);
    expect(result.notes.map((n) => n.id)).toEqual([longNote.id, shortNote.id]);
    expect(result.notes[0].score).toBeCloseTo(1, 4);
  });

  it("returns nothing (no throw) when the candidate set is empty", () => {
    const query = normalize(new Float32Array([1, 0, 0, 0]));
    const result = semanticSearchNotes(db, query, { tags: ["nonexistent"] }, MODEL);
    expect(result).toEqual({ notes: [], pendingCount: 0, totalCandidates: 0 });
  });
});
