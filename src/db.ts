/**
 * Vault database — opens bun:sqlite databases for vaults.
 */

import { Database } from "bun:sqlite";
import { vaultDbPath, vaultDir } from "./config.ts";
import { mkdirSync } from "fs";

/** Open (or create) a vault's SQLite database. */
export function openVaultDb(name: string): Database {
  const dir = vaultDir(name);
  mkdirSync(dir, { recursive: true });
  return new Database(vaultDbPath(name));
}
