/**
 * End-to-end wiring test for the semantic-search opt-in gate (0.7.3) at the
 * REAL `src/vault-store.ts` call site. Semantic search is OFF by default;
 * when off, `getVaultStore` builds NO provider and threads the opt-in hint
 * through to `Store.semanticSearch`'s `semantic_unavailable` error — not the
 * generic provider-setup message — see `core/src/store.ts`'s
 * `embeddingDisabledReason` doc comment for why core can't determine this on
 * its own. Unit coverage for the underlying `Store` behavior lives in
 * `core/src/store.semantic-search.test.ts`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { QueryError } from "../core/src/query-operators.ts";
import {
  getVaultStore,
  clearVaultStoreCache,
  resetSharedEmbeddingProviderForTests,
  EMBEDDINGS_DISABLED_REASON,
} from "./vault-store.ts";

let tmpHome: string;
let prevHome: string | undefined;
let prevEnabled: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-embed-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  prevEnabled = process.env.EMBEDDINGS_ENABLED;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();
  resetSharedEmbeddingProviderForTests();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (prevEnabled === undefined) delete process.env.EMBEDDINGS_ENABLED;
  else process.env.EMBEDDINGS_ENABLED = prevEnabled;
  clearVaultStoreCache();
  resetSharedEmbeddingProviderForTests();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("getVaultStore — semantic-search opt-in gate wiring", () => {
  test("DEFAULT off (env unset, no persisted setting): no provider, and semanticSearch's hint names the opt-in toggle", async () => {
    delete process.env.EMBEDDINGS_ENABLED;
    const store = getVaultStore("test");
    expect(store.embeddingProvider).toBeUndefined();
    expect(store.embeddingDisabledReason).toBe(EMBEDDINGS_DISABLED_REASON);

    let caught: unknown;
    try {
      await store.semanticSearch("anything");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueryError);
    expect((caught as QueryError).error_type).toBe("semantic_unavailable");
    expect((caught as QueryError).hint).toBe(EMBEDDINGS_DISABLED_REASON);
  });

  test("EMBEDDINGS_ENABLED=false is the same off path — no provider, opt-in hint", () => {
    process.env.EMBEDDINGS_ENABLED = "false";
    const store = getVaultStore("test");
    expect(store.embeddingProvider).toBeUndefined();
    expect(store.embeddingDisabledReason).toBe(EMBEDDINGS_DISABLED_REASON);
  });

  test("EMBEDDINGS_ENABLED=true enables — the store gets a (bundled-floor) provider and no disabled reason", () => {
    process.env.EMBEDDINGS_ENABLED = "true";
    const store = getVaultStore("test");
    expect(store.embeddingProvider).toBeDefined();
    expect(store.embeddingDisabledReason).toBeUndefined();
  });
});
