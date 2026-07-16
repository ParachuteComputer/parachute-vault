/**
 * End-to-end wiring test for the `EMBEDDINGS_ENABLED=false` off switch's
 * error hint (review nano flag on #602): `getVaultStore` should thread
 * "explicitly disabled" through to `Store.semanticSearch`'s
 * `semantic_unavailable` hint, not the generic provider-setup message —
 * see `core/src/store.ts`'s `embeddingDisabledReason` doc comment for why
 * core can't determine this on its own. Unit coverage for the underlying
 * `Store` behavior lives in `core/src/store.semantic-search.test.ts`; this
 * file exercises the REAL `src/vault-store.ts` call site.
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

describe("getVaultStore — EMBEDDINGS_ENABLED=false hint wiring", () => {
  test("store.embeddingDisabledReason is set, and semanticSearch's hint names the off switch", async () => {
    process.env.EMBEDDINGS_ENABLED = "false";
    const store = getVaultStore("test");
    expect(store.embeddingDisabledReason).toBe("semantic search is disabled by EMBEDDINGS_ENABLED=false");

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

  test("no reason set when EMBEDDINGS_ENABLED is unset — the store still has a (bundled-floor) provider", async () => {
    delete process.env.EMBEDDINGS_ENABLED;
    const store = getVaultStore("test");
    expect(store.embeddingDisabledReason).toBeUndefined();
    expect(store.embeddingProvider).toBeDefined();
  });
});
