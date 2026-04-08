/**
 * Vault store management — opens and caches per-vault SQLite stores.
 *
 * BunStore is an alias for SqliteStore from core. They share the same
 * implementation to avoid duplicating wikilink hooks and other behavior.
 */

import { SqliteStore } from "../core/src/store.ts";
import { defaultHookRegistry } from "../core/src/hooks.ts";
import { openVaultDb } from "./db.ts";

export { SqliteStore as BunStore };
export { defaultHookRegistry };

/** Cache of open vault stores. */
const stores = new Map<string, SqliteStore>();

/** Get or create a store for a vault. */
export function getVaultStore(name: string): SqliteStore {
  let store = stores.get(name);
  if (!store) {
    const db = openVaultDb(name);
    // Share the process-wide hook registry so features can register
    // handlers once at startup and have them fire for every vault.
    store = new SqliteStore(db, { hooks: defaultHookRegistry });
    stores.set(name, store);
  }
  return store;
}

/** Close all open stores. */
export function closeAllStores(): void {
  for (const [, store] of stores) {
    store.db.close();
  }
  stores.clear();
}
