import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { QueryError } from "./query-operators.js";
import { EmbeddingError, type EmbeddingProvider, type EmbedInput, type EmbedResult, type ProviderAvailability } from "./embedding/provider.js";
import { encodeVector, normalize } from "./embedding/vector-codec.js";

const MODEL = "mock-model";
const DIMS = 4;

/** A deterministic, no-network mock — the standard shape MCP/REST tests inject. */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = MODEL;
  readonly dims = DIMS;
  available_ = true;
  reason_: string | undefined;
  /** Maps query text -> raw (pre-normalize) vector, so tests control ranking deterministically. */
  vectorFor: (text: string) => number[];

  constructor(vectorFor?: (text: string) => number[]) {
    this.vectorFor = vectorFor ?? (() => [1, 0, 0, 0]);
  }

  async embed(input: EmbedInput): Promise<EmbedResult> {
    return {
      vectors: input.texts.map((t) => new Float32Array(this.vectorFor(t))),
      model: this.model,
      dims: this.dims,
    };
  }

  async available(): Promise<ProviderAvailability> {
    return this.available_ ? { ok: true } : { ok: false, reason: this.reason_ };
  }
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
});

describe("Store.semanticSearch", () => {
  it("throws a structured semantic_unavailable QueryError when no provider is configured", async () => {
    const store = new SqliteStore(db);
    await store.createNote("hello", { path: "n" });
    let caught: unknown;
    try {
      await store.semanticSearch("anything");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueryError);
    expect((caught as QueryError).error_type).toBe("semantic_unavailable");
  });

  it("throws semantic_unavailable when the configured provider reports itself not ready", async () => {
    const provider = new MockEmbeddingProvider();
    provider.available_ = false;
    provider.reason_ = "no local model downloaded yet";
    const store = new SqliteStore(db, { embeddingProvider: provider });
    let caught: unknown;
    try {
      await store.semanticSearch("anything");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueryError);
    expect((caught as QueryError).error_type).toBe("semantic_unavailable");
    expect((caught as QueryError).hint).toBe("no local model downloaded yet");
  });

  it("embeds the query, normalizes it, and ranks by cosine similarity", async () => {
    const provider = new MockEmbeddingProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    const close = await store.createNote("close note", { path: "close" });
    const far = await store.createNote("far note", { path: "far" });

    const encode = (v: number[]) => encodeVector(normalize(new Float32Array(v)));
    db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at)
       VALUES (?, 0, ?, ?, ?, ?, ?)`,
    ).run(close.id, encode([1, 0, 0, 0]), DIMS, MODEL, "h1", new Date().toISOString());
    db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at)
       VALUES (?, 0, ?, ?, ?, ?, ?)`,
    ).run(far.id, encode([0, 1, 0, 0]), DIMS, MODEL, "h2", new Date().toISOString());

    const result = await store.semanticSearch("some query text");
    expect(result.notes.map((n) => n.id)).toEqual([close.id, far.id]);
    expect(result.notes[0].score).toBeCloseTo(1, 4);
  });

  it("normalizes a non-unit-length embedding before ranking (provider need not return normalized vectors)", async () => {
    // A provider returning an UN-normalized vector (magnitude != 1) must
    // still produce a valid cosine score once Store normalizes it.
    const provider = new MockEmbeddingProvider(() => [10, 0, 0, 0]); // magnitude 10, same direction as [1,0,0,0]
    const store = new SqliteStore(db, { embeddingProvider: provider });
    const note = await store.createNote("note", { path: "n" });
    db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at)
       VALUES (?, 0, ?, ?, ?, ?, ?)`,
    ).run(note.id, encodeVector(normalize(new Float32Array([1, 0, 0, 0]))), DIMS, MODEL, "h", new Date().toISOString());

    const result = await store.semanticSearch("query");
    expect(result.notes[0].score).toBeCloseTo(1, 4); // same direction -> cosine 1, regardless of the raw magnitude
  });

  it("composes with structured filters (tags) via the same expansion queryNotes uses", async () => {
    const provider = new MockEmbeddingProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    const tagged = await store.createNote("tagged", { path: "tagged", tags: ["project"] });
    const untagged = await store.createNote("untagged", { path: "untagged" });
    const encode = (v: number[]) => encodeVector(normalize(new Float32Array(v)));
    db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, ?, ?, ?)`,
    ).run(tagged.id, encode([1, 0, 0, 0]), DIMS, MODEL, "h1", new Date().toISOString());
    db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, ?, ?, ?)`,
    ).run(untagged.id, encode([1, 0, 0, 0]), DIMS, MODEL, "h2", new Date().toISOString());

    const result = await store.semanticSearch("query", { tags: ["project"] });
    expect(result.notes.map((n) => n.id)).toEqual([tagged.id]);
  });

  it("M2: maps a mid-embed() EmbeddingError to semantic_unavailable, never a raw throw (e.g. a lazy model load failing on the FIRST real embed call)", async () => {
    const provider = new MockEmbeddingProvider();
    // available() optimistically says ok — mirrors onnx-transformers.ts's
    // "lazy-fail, not crash" contract: readiness is cheap and never a real
    // load attempt, so a broken load only surfaces on the actual embed() call.
    provider.embed = async () => {
      throw new EmbeddingError("bundled ONNX embedding model failed to load: simulated ORT failure", {
        code: "onnx_unavailable",
        retriable: false,
      });
    };
    const store = new SqliteStore(db, { embeddingProvider: provider });
    let caught: unknown;
    try {
      await store.semanticSearch("anything");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueryError);
    expect((caught as QueryError).error_type).toBe("semantic_unavailable");
    expect((caught as QueryError).hint).toContain("simulated ORT failure");
  });

  it("M2: maps a mid-embed() PLAIN Error (not an EmbeddingError) to semantic_unavailable too — the catch isn't narrowly typed", async () => {
    const provider = new MockEmbeddingProvider();
    provider.embed = async () => {
      throw new TypeError("fetch failed: network unreachable");
    };
    const store = new SqliteStore(db, { embeddingProvider: provider });
    let caught: unknown;
    try {
      await store.semanticSearch("anything");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueryError);
    expect((caught as QueryError).error_type).toBe("semantic_unavailable");
    expect((caught as QueryError).hint).toContain("network unreachable");
  });

  it("reports pendingCount for candidates not yet embedded under the active model", async () => {
    const provider = new MockEmbeddingProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    await store.createNote("embedded", { path: "a" });
    await store.createNote("pending", { path: "b" });
    const first = await store.getNoteByPath("a");
    db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, ?, ?, ?)`,
    ).run(first!.id, encodeVector(normalize(new Float32Array([1, 0, 0, 0]))), DIMS, MODEL, "h", new Date().toISOString());

    const result = await store.semanticSearch("query");
    expect(result.totalCandidates).toBe(2);
    expect(result.pendingCount).toBe(1);
  });

  it("L4: a blank note never counts as pending — pendingCount 0 even though it will NEVER get a vector row", async () => {
    const provider = new MockEmbeddingProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    const real = await store.createNote("real content", { path: "real" });
    await store.createNote("", { path: "blank" });
    db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, ?, ?, ?)`,
    ).run(real.id, encodeVector(normalize(new Float32Array([1, 0, 0, 0]))), DIMS, MODEL, "h", new Date().toISOString());

    // Simulates "after sweep": the real note is embedded (a real sweep
    // would embed it), the blank note is skipped (a real sweep would
    // never select it — core/src/embedding/vectors.ts's
    // getNotesPendingEmbedding already excludes it). Before this fix, the
    // blank note would count as a candidate lacking a vector FOREVER —
    // a phantom embeddings_pending that never drains.
    const result = await store.semanticSearch("query");
    expect(result.totalCandidates).toBe(1); // the blank note isn't even a candidate
    expect(result.pendingCount).toBe(0);
  });

  it("L4: a whitespace-only note is excluded the same way", async () => {
    const provider = new MockEmbeddingProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    await store.createNote("   \n\t  ", { path: "whitespace" });
    const result = await store.semanticSearch("query");
    expect(result.totalCandidates).toBe(0);
    expect(result.pendingCount).toBe(0);
  });

  it("nano: no-provider hint names the explicit off switch when the caller supplied embeddingDisabledReason", async () => {
    const store = new SqliteStore(db, {
      embeddingDisabledReason: "semantic search is disabled by EMBEDDINGS_ENABLED=false",
    });
    let caught: unknown;
    try {
      await store.semanticSearch("anything");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueryError);
    expect((caught as QueryError).error_type).toBe("semantic_unavailable");
    expect((caught as QueryError).hint).toBe("semantic search is disabled by EMBEDDINGS_ENABLED=false");
  });

  it("nano: falls back to the generic provider-setup hint when no embeddingDisabledReason was supplied", async () => {
    const store = new SqliteStore(db); // no provider, no reason — "never configured," not "explicitly off"
    let caught: unknown;
    try {
      await store.semanticSearch("anything");
    } catch (e) {
      caught = e;
    }
    expect((caught as QueryError).hint).toContain("configure EMBEDDING_API_URL");
  });
});
