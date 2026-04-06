import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./schema.js";
import {
  useHomebrewSQLiteIfNeeded,
  loadVecExtension,
  initEmbeddingsTable,
  upsertEmbedding,
  deleteEmbedding,
  getUnembeddedNoteIds,
  semanticSearch,
  hybridSearch,
} from "./embeddings.js";
import * as noteOps from "./notes.js";

// Must be called before any Database is created on macOS
useHomebrewSQLiteIfNeeded();

const DIMS = 3; // tiny vectors for testing

let db: Database;
let vecAvailable: boolean;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  vecAvailable = loadVecExtension(db);
  if (vecAvailable) {
    initEmbeddingsTable(db, DIMS);
  }
});

// Helper: create a note and embed it
function createAndEmbed(content: string, embedding: number[], opts?: { path?: string; tags?: string[] }) {
  const note = noteOps.createNote(db, content, opts);
  if (vecAvailable) {
    upsertEmbedding(db, note.id, embedding, "test-model");
  }
  return note;
}

describe("embeddings", () => {
  it("loads sqlite-vec extension", () => {
    // This test verifies the extension loads (may fail if sqlite-vec not installed)
    if (!vecAvailable) {
      console.log("  [skipped] sqlite-vec not available");
      return;
    }
    expect(vecAvailable).toBe(true);
  });

  it("creates vec0 table", () => {
    if (!vecAvailable) return;
    // Table should exist after init
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_meta'",
    ).all();
    expect(tables).toHaveLength(1);
  });

  it("inserts and queries vectors", () => {
    if (!vecAvailable) return;

    createAndEmbed("About cats", [1.0, 0.0, 0.0]);
    createAndEmbed("About dogs", [0.9, 0.1, 0.0]);
    createAndEmbed("About cars", [0.0, 0.0, 1.0]);

    const results = semanticSearch(db, [1.0, 0.0, 0.0], { limit: 2 });
    expect(results).toHaveLength(2);
    // Cats should be closest
    expect(results[0].note.content).toBe("About cats");
    expect(results[0].distance).toBe(0);
    // Dogs second closest
    expect(results[1].note.content).toBe("About dogs");
  });

  it("upserts embeddings (update existing)", () => {
    if (!vecAvailable) return;

    const note = createAndEmbed("Original", [1.0, 0.0, 0.0]);

    // Update embedding
    upsertEmbedding(db, note.id, [0.0, 1.0, 0.0], "test-model-v2");

    // Query with new vector should find it
    const results = semanticSearch(db, [0.0, 1.0, 0.0], { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].note.id).toBe(note.id);
    expect(results[0].distance).toBe(0);
  });

  it("deletes embeddings", () => {
    if (!vecAvailable) return;

    const note = createAndEmbed("Delete me", [1.0, 0.0, 0.0]);
    deleteEmbedding(db, note.id);

    const results = semanticSearch(db, [1.0, 0.0, 0.0], { limit: 1 });
    expect(results).toHaveLength(0);
  });

  it("tracks unembedded notes", () => {
    if (!vecAvailable) return;

    noteOps.createNote(db, "Not embedded 1");
    noteOps.createNote(db, "Not embedded 2");
    createAndEmbed("Embedded", [1.0, 0.0, 0.0]);

    const unembedded = getUnembeddedNoteIds(db);
    expect(unembedded).toHaveLength(2);
  });

  it("filters by tags", () => {
    if (!vecAvailable) return;

    createAndEmbed("Cat daily", [1.0, 0.0, 0.0], { tags: ["daily"] });
    createAndEmbed("Cat doc", [0.95, 0.05, 0.0], { tags: ["doc"] });

    const results = semanticSearch(db, [1.0, 0.0, 0.0], {
      tags: ["daily"],
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0].note.tags).toContain("daily");
  });

  it("excludes tags", () => {
    if (!vecAvailable) return;

    createAndEmbed("Active note", [1.0, 0.0, 0.0], { tags: ["daily"] });
    createAndEmbed("Archived note", [0.95, 0.05, 0.0], { tags: ["daily", "archived"] });

    const results = semanticSearch(db, [1.0, 0.0, 0.0], {
      tags: ["daily"],
      excludeTags: ["archived"],
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0].note.content).toBe("Active note");
  });

  it("hybrid search combines FTS and vector", () => {
    if (!vecAvailable) return;

    // Note with keyword match but far vector
    const keyword = noteOps.createNote(db, "The quick brown fox jumps");
    upsertEmbedding(db, keyword.id, [0.0, 0.0, 1.0], "test");

    // Note with close vector but no keyword match
    const vector = noteOps.createNote(db, "Animals running around");
    upsertEmbedding(db, vector.id, [1.0, 0.0, 0.0], "test");

    // Note with both
    const both = noteOps.createNote(db, "The fox is quick and agile");
    upsertEmbedding(db, both.id, [0.9, 0.1, 0.0], "test");

    const results = hybridSearch(db, "fox", [1.0, 0.0, 0.0], { limit: 10 });
    expect(results.length).toBeGreaterThan(0);

    // The note with both signals should rank highest
    // (it matches FTS "fox" and is close in vector space)
    const ids = results.map((r) => r.note.id);
    expect(ids).toContain(both.id);
  });

  it("returns similarity scores between 0 and 1", () => {
    if (!vecAvailable) return;

    createAndEmbed("Close", [1.0, 0.0, 0.0]);
    createAndEmbed("Far", [0.0, 0.0, 1.0]);

    const results = semanticSearch(db, [1.0, 0.0, 0.0], { limit: 10 });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    // Close note should have higher score
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
