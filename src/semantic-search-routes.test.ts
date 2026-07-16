/**
 * REST face of semantic search (EXPERIMENTAL — semantic search MVP).
 * Mirrors the MCP `query-notes` tool's `near_text`/`semantic` params —
 * see `core/src/mcp-semantic-search.test.ts` for the MCP-side twin of
 * this suite. Fully sandboxed — in-memory SQLite, mocked provider, no
 * daemon, no real model.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleNotes } from "./routes.ts";
import type { EmbeddingProvider, EmbedInput, EmbedResult, ProviderAvailability } from "../core/src/embedding/provider.ts";
import { encodeVector, normalize } from "../core/src/embedding/vector-codec.ts";

const MODEL = "mock-model";
const DIMS = 4;

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = MODEL;
  readonly dims = DIMS;
  available_ = true;
  reason_: string | undefined;

  async embed(input: EmbedInput): Promise<EmbedResult> {
    return { vectors: input.texts.map(() => new Float32Array([1, 0, 0, 0])), model: this.model, dims: this.dims };
  }

  async available(): Promise<ProviderAvailability> {
    return this.available_ ? { ok: true } : { ok: false, reason: this.reason_ };
  }
}

let db: Database;
let store: BunStore;

beforeEach(() => {
  db = new Database(":memory:");
});

afterEach(() => {
  db.close();
});

const BASE = "http://localhost/api";

function get(store: BunStore, path: string): Promise<Response> {
  return handleNotes(new Request(`${BASE}/notes${path}`, { method: "GET" }), store, "");
}

function insertVector(noteId: string, vector: number[]): void {
  const encoded = encodeVector(normalize(new Float32Array(vector)));
  db.prepare(
    `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, ?, ?, ?)`,
  ).run(noteId, encoded, DIMS, MODEL, "hash", new Date().toISOString());
}

/** Decode the `X-Parachute-Warnings` header (vault#550 — percent-encoded JSON; see `jsonWithWarnings` in routes.ts). */
function decodeWarningsHeader(res: Response): any[] | null {
  const raw = res.headers.get("X-Parachute-Warnings");
  if (!raw) return null;
  return JSON.parse(decodeURIComponent(raw));
}

describe("GET /notes?near_text=&semantic= (REST, EXPERIMENTAL)", () => {
  it("400s when semantic=true is passed without near_text", async () => {
    store = new BunStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const res = await get(store, "?semantic=true");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_type).toBe("invalid_query");
    expect(body.field).toBe("near_text");
  });

  it("400s when semantic=true is combined with search", async () => {
    store = new BunStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const res = await get(store, "?semantic=true&near_text=x&search=y");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("semantic");
  });

  it("400s when semantic=true is combined with cursor", async () => {
    store = new BunStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const res = await get(store, "?semantic=true&near_text=x&cursor=");
    expect(res.status).toBe(400);
  });

  it("503s with a structured semantic_unavailable error when no provider is configured", async () => {
    store = new BunStore(db); // no embeddingProvider
    const res = await get(store, "?semantic=true&near_text=anything");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error_type).toBe("semantic_unavailable");
  });

  it("M2: 503s (not a raw 500) when the provider's embed() call fails mid-flight, e.g. a lazy model load blowing up on the first real query", async () => {
    const provider = new MockEmbeddingProvider();
    provider.embed = async () => {
      throw new Error("bundled ONNX embedding model failed to load: simulated ORT failure");
    };
    store = new BunStore(db, { embeddingProvider: provider });
    const res = await get(store, "?semantic=true&near_text=anything");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error_type).toBe("semantic_unavailable");
  });

  it("near_text without semantic=true is inert and carries an ignored_param warning (via the header, bare-array body)", async () => {
    store = new BunStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    await store.createNote("hello world");
    const res = await get(store, "?near_text=hello");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const warnings = decodeWarningsHeader(res);
    expect(warnings?.some((w: any) => w.code === "ignored_param" && w.param === "near_text")).toBe(true);
  });

  it("returns notes ranked by meaning", async () => {
    store = new BunStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const close = await store.createNote("close note", { path: "close" });
    const far = await store.createNote("far note", { path: "far" });
    insertVector(close.id, [1, 0, 0, 0]);
    insertVector(far.id, [0, 1, 0, 0]);

    const res = await get(store, "?semantic=true&near_text=anything&include_content=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((n) => n.id)).toEqual([close.id, far.id]);
    expect(body[0].score).toBeCloseTo(1, 4);
  });

  it("composes with tag filters", async () => {
    store = new BunStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const tagged = await store.createNote("tagged", { path: "tagged", tags: ["project"] });
    const untagged = await store.createNote("untagged", { path: "untagged" });
    insertVector(tagged.id, [1, 0, 0, 0]);
    insertVector(untagged.id, [1, 0, 0, 0]);

    const res = await get(store, "?semantic=true&near_text=x&tag=project");
    const body = (await res.json()) as any[];
    expect(body.map((n) => n.id)).toEqual([tagged.id]);
  });

  it("attaches embeddings_pending warning (via the header) with counts while backfill is incomplete", async () => {
    store = new BunStore(db, { embeddingProvider: new MockEmbeddingProvider() });
    const embedded = await store.createNote("embedded", { path: "a" });
    await store.createNote("pending", { path: "b" });
    insertVector(embedded.id, [1, 0, 0, 0]);

    const res = await get(store, "?semantic=true&near_text=x&include_content=true");
    const body = (await res.json()) as any[];
    expect(body.map((n: any) => n.id)).toEqual([embedded.id]);
    const warnings = decodeWarningsHeader(res);
    const w = warnings?.find((x: any) => x.code === "embeddings_pending");
    expect(w).toBeDefined();
    expect(w.pending).toBe(1);
    expect(w.total_candidates).toBe(2);
  });
});
