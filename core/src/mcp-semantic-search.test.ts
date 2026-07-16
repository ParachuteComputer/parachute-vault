import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import { QueryError } from "./query-operators.js";
import type { EmbeddingProvider, EmbedInput, EmbedResult, ProviderAvailability } from "./embedding/provider.js";
import { encodeVector, normalize } from "./embedding/vector-codec.js";

const MODEL = "mock-model";
const DIMS = 4;

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = MODEL;
  readonly dims = DIMS;
  available_ = true;
  reason_: string | undefined;
  vectorFor: (text: string) => number[];

  constructor(vectorFor?: (text: string) => number[]) {
    this.vectorFor = vectorFor ?? (() => [1, 0, 0, 0]);
  }

  async embed(input: EmbedInput): Promise<EmbedResult> {
    return { vectors: input.texts.map((t) => new Float32Array(this.vectorFor(t))), model: this.model, dims: this.dims };
  }

  async available(): Promise<ProviderAvailability> {
    return this.available_ ? { ok: true } : { ok: false, reason: this.reason_ };
  }
}

function insertVector(db: Database, noteId: string, vector: number[]): void {
  const encoded = encodeVector(normalize(new Float32Array(vector)));
  db.prepare(
    `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, ?, ?, ?)`,
  ).run(noteId, encoded, DIMS, MODEL, "hash", new Date().toISOString());
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
});

describe("query-notes MCP tool — semantic search (EXPERIMENTAL)", () => {
  it("throws INVALID_QUERY when semantic:true is passed without near_text", async () => {
    const store = new SqliteStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    await expect(query.execute({ semantic: true })).rejects.toThrow(QueryError);
  });

  it("throws INVALID_QUERY when semantic:true is combined with search", async () => {
    const store = new SqliteStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    await expect(query.execute({ semantic: true, near_text: "x", search: "y" })).rejects.toThrow(QueryError);
  });

  it("throws INVALID_QUERY when semantic is combined with aggregate", async () => {
    const store = new SqliteStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    await expect(
      query.execute({ semantic: true, near_text: "x", aggregate: { group_by: "tag", op: "count" } }),
    ).rejects.toThrow(QueryError);
  });

  it("throws INVALID_QUERY when semantic is combined with cursor", async () => {
    const store = new SqliteStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    await expect(query.execute({ semantic: true, near_text: "x", cursor: "" })).rejects.toThrow(QueryError);
  });

  it("throws a structured semantic_unavailable error when no provider is configured", async () => {
    const store = new SqliteStore(db); // no embeddingProvider
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    let caught: unknown;
    try {
      await query.execute({ semantic: true, near_text: "anything" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueryError);
    expect((caught as QueryError).error_type).toBe("semantic_unavailable");
  });

  it("near_text without semantic:true is a no-op that carries an ignored_param warning", async () => {
    const store = new SqliteStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    await store.createNote("hello world", { path: "n" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ near_text: "hello" })) as { notes: unknown[]; warnings: { code: string }[] };
    // A plain structured query with no filters returns a bare array UNLESS
    // warnings are present (vault#550 envelope rule) — here they are.
    expect(Array.isArray((result as any))).toBe(false);
    expect(result.warnings.some((w) => w.code === "ignored_param")).toBe(true);
  });

  it("returns notes ranked by meaning via near_text + semantic:true", async () => {
    const store = new SqliteStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const close = await store.createNote("close note", { path: "close" });
    const far = await store.createNote("far note", { path: "far" });
    insertVector(db, close.id, [1, 0, 0, 0]);
    insertVector(db, far.id, [0, 1, 0, 0]);

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const results = (await query.execute({ semantic: true, near_text: "anything", include_content: true })) as any[];
    expect(results.map((n: any) => n.id)).toEqual([close.id, far.id]);
    expect(results[0].score).toBeCloseTo(1, 4);
  });

  it("composes with tag filters (structured filters narrow the candidate set first)", async () => {
    const store = new SqliteStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const tagged = await store.createNote("tagged", { path: "tagged", tags: ["project"] });
    const untagged = await store.createNote("untagged", { path: "untagged" });
    insertVector(db, tagged.id, [1, 0, 0, 0]);
    insertVector(db, untagged.id, [1, 0, 0, 0]);

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const results = (await query.execute({ semantic: true, near_text: "x", tag: "project" })) as any[];
    expect(results.map((n: any) => n.id)).toEqual([tagged.id]);
  });

  it("attaches embeddings_pending warning + still returns real results when some candidates aren't embedded yet", async () => {
    const store = new SqliteStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const embedded = await store.createNote("embedded", { path: "a" });
    await store.createNote("pending", { path: "b" });
    insertVector(db, embedded.id, [1, 0, 0, 0]);

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ semantic: true, near_text: "x", include_content: true })) as {
      notes: any[];
      warnings: { code: string; pending?: number; total_candidates?: number }[];
    };
    expect(result.notes.map((n: any) => n.id)).toEqual([embedded.id]);
    const pendingWarning = result.warnings.find((w) => w.code === "embeddings_pending");
    expect(pendingWarning).toBeDefined();
    expect(pendingWarning!.pending).toBe(1);
    expect(pendingWarning!.total_candidates).toBe(2);
  });

  it("no embeddings_pending warning once every candidate has a vector", async () => {
    const store = new SqliteStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const note = await store.createNote("note", { path: "a" });
    insertVector(db, note.id, [1, 0, 0, 0]);

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const results = (await query.execute({ semantic: true, near_text: "x", include_content: true })) as any;
    // No warnings at all -> bare array (vault#550 envelope rule).
    expect(Array.isArray(results)).toBe(true);
  });
});
