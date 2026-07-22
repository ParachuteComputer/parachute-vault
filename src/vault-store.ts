/**
 * Vault store management — opens and caches per-vault SQLite stores.
 *
 * BunStore is an alias for SqliteStore from core. They share the same
 * implementation to avoid duplicating wikilink hooks and other behavior.
 */

import { SqliteStore } from "../core/src/store.ts";
import { defaultHookRegistry } from "../core/src/hooks.ts";
import type { Store } from "../core/src/types.ts";
import type { EmbeddingProvider } from "../core/src/embedding/provider.ts";
import { buildEmbeddingProvider } from "./embedding/select.ts";
import { readGlobalConfig } from "./config.ts";
import { openVaultDb } from "./db.ts";

/**
 * The honest hint `semanticSearch` surfaces when semantic search is OFF
 * (the 0.7.3 opt-in default). Points the operator at both the env override
 * and the persisted settings toggle — see `src/embedding/select.ts`.
 */
export const EMBEDDINGS_DISABLED_REASON =
  "semantic search is off — it is opt-in as of 0.7.3; enable it with EMBEDDINGS_ENABLED=true, or set embeddings_enabled: true in ~/.parachute/vault/config.yaml, then restart the vault";

export { SqliteStore as BunStore };
export { defaultHookRegistry };

/** Cache of open vault stores. */
const stores = new Map<string, SqliteStore>();

/** Reverse lookup: store instance → vault name. Used by hooks that need to
 *  resolve the vault's assets directory from the store handle. */
const storeToVault = new WeakMap<SqliteStore, string>();

/**
 * The one shared `EmbeddingProvider` instance for this process (semantic
 * search MVP, EXPERIMENTAL). Unlike `defaultTranscriptionProvider()`
 * (resolved fresh per call — transcription providers are cheap stateless
 * wrappers), this is memoized deliberately: the bundled floor tier
 * (`onnx-transformers.ts`) lazy-loads a ~34MB ONNX model on first use, and
 * every vault this server hosts should share that ONE loaded model rather
 * than each vault's `Store` triggering its own separate load. Resolved
 * from `process.env` on first access (so `.env` loaded via
 * `loadEnvFile()` in `server.ts` is visible) and reused for every
 * subsequent vault opened this process.
 *
 * `undefined` is a legitimate, cacheable resolution — semantic search is
 * OFF by default (opt-in as of 0.7.3), so the common case is "no provider,"
 * not "not resolved yet." A separate `resolved` flag (rather than null-
 * checking the provider itself) distinguishes the two, so a disabled vault
 * doesn't re-run `buildEmbeddingProvider()` on every call.
 *
 * Resolution threads the persisted `embeddings_enabled` config.yaml setting
 * in as the default, with the `EMBEDDINGS_ENABLED` env var as the override
 * (see `select.ts`'s `resolveEmbeddingsEnabled`). Because it's memoized at
 * first access, flipping the setting takes effect on the next server start.
 */
let sharedEmbeddingProvider: EmbeddingProvider | undefined;
let sharedEmbeddingProviderResolved = false;

/** The shared embedding provider (see `sharedEmbeddingProvider`'s doc comment). `undefined` when semantic search is off (the opt-in default). */
export function getSharedEmbeddingProvider(): EmbeddingProvider | undefined {
  if (!sharedEmbeddingProviderResolved) {
    sharedEmbeddingProvider = buildEmbeddingProvider(process.env, {
      persistedEnabled: readGlobalConfig().embeddings_enabled,
    });
    sharedEmbeddingProviderResolved = true;
  }
  return sharedEmbeddingProvider;
}

/** Test-only: force a fresh provider on the next `getSharedEmbeddingProvider()` call. */
export function resetSharedEmbeddingProviderForTests(): void {
  sharedEmbeddingProvider = undefined;
  sharedEmbeddingProviderResolved = false;
}

/** Get or create a store for a vault. */
export function getVaultStore(name: string): SqliteStore {
  let store = stores.get(name);
  if (!store) {
    const db = openVaultDb(name);
    // Share the process-wide hook registry so features can register
    // handlers once at startup and have them fire for every vault. Same
    // for the embedding provider (see `getSharedEmbeddingProvider`'s doc
    // comment) — every vault's semantic search resolves the SAME provider
    // instance. `embeddingDisabledReason` is only ever set here (core can't
    // read env/config itself — see `Store.embeddingDisabledReason`'s doc
    // comment), so `semanticSearch`'s no-provider hint can name the opt-in
    // toggle instead of generic provider-setup instructions. Derived from
    // provider-absence directly, so the hint is present exactly when (and
    // because) semantic search is off — no second read of the resolution.
    const embeddingProvider = getSharedEmbeddingProvider();
    store = new SqliteStore(db, {
      hooks: defaultHookRegistry,
      embeddingProvider,
      embeddingDisabledReason: embeddingProvider ? undefined : EMBEDDINGS_DISABLED_REASON,
    });
    stores.set(name, store);
    storeToVault.set(store, name);
  }
  return store;
}

/**
 * Look up the vault name for a previously-opened store. Accepts the `Store`
 * interface (not just the concrete `SqliteStore`) so hook handlers — which
 * receive `Store` from the dispatcher — can resolve the vault. The WeakMap is
 * keyed on the concrete instance the dispatcher passes through unchanged, so
 * the lookup still hits.
 */
export function getVaultNameForStore(store: Store): string | undefined {
  return storeToVault.get(store as SqliteStore);
}

/**
 * Close all open stores. When `silent` is true, swallow errors from
 * `db.close()` — used by test cleanup where the underlying DB files may
 * already be gone.
 */
export function closeAllStores(silent = false): void {
  for (const [, store] of stores) {
    if (silent) {
      try { store.db.close(); } catch {}
    } else {
      store.db.close();
    }
  }
  stores.clear();
}

/**
 * Test-only: close and clear all cached stores. Used between tests that
 * swap `PARACHUTE_HOME` out from under the cache, which would otherwise
 * hold handles to DBs whose files no longer exist.
 */
export function clearVaultStoreCache(): void {
  closeAllStores(true);
}
