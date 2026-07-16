/**
 * GET /api/vault — `embeddings` capability field (semantic search MVP,
 * EXPERIMENTAL). This tests the WIRING (routes.ts's `handleVault` →
 * `resolveEmbeddingCap` → the response body) — `resolveEmbeddingCapability`
 * itself is unit-tested in `src/embedding/capability.test.ts`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleVault } from "./routes.ts";
import type { EmbeddingCapability } from "./embedding/capability.ts";

let db: Database;
let store: BunStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new BunStore(db);
});

afterEach(() => {
  db.close();
});

const BASE = "http://localhost/api";

describe("GET /api/vault embeddings capability", () => {
  test("surfaces enabled:true + provider/model when the injected resolver reports available", async () => {
    const cfg = { name: "default" };
    const resolveEmbeddingCap = async (): Promise<EmbeddingCapability> => ({
      enabled: true,
      provider: "onnx-transformers",
      model: "Xenova/bge-small-en-v1.5",
    });
    const res = await handleVault(
      new Request(`${BASE}/vault`, { method: "GET" }),
      store,
      cfg as any,
      undefined,
      undefined, // resolveCapability (transcription) — keep default
      undefined, // tagScope — keep default
      resolveEmbeddingCap,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.embeddings).toEqual({
      enabled: true,
      provider: "onnx-transformers",
      model: "Xenova/bge-small-en-v1.5",
    });
  });

  test("surfaces enabled:false with no provider/model when the injected resolver reports unavailable", async () => {
    const cfg = { name: "default" };
    const resolveEmbeddingCap = async (): Promise<EmbeddingCapability> => ({ enabled: false });
    const res = await handleVault(
      new Request(`${BASE}/vault`, { method: "GET" }),
      store,
      cfg as any,
      undefined,
      undefined,
      undefined,
      resolveEmbeddingCap,
    );
    const body = (await res.json()) as any;
    expect(body.embeddings).toEqual({ enabled: false });
  });

  test("the production default resolves the shared embedding provider (zero-config -> the bundled floor, enabled:true)", async () => {
    const cfg = { name: "default" };
    // No resolver override — exercises the real default wiring
    // (getSharedEmbeddingProvider() -> resolveEmbeddingCapability()).
    // Zero-config env -> the bundled onnx-transformers floor, which is
    // optimistically available() before any real model load — see
    // src/embedding/onnx-transformers.ts's "lazy-fail, not crash" doc.
    const res = await handleVault(new Request(`${BASE}/vault`, { method: "GET" }), store, cfg as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.embeddings.enabled).toBe(true);
    expect(body.embeddings.provider).toBe("onnx-transformers");
  });
});
