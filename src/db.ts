/**
 * Vault database — opens bun:sqlite databases for vaults.
 */

import { Database } from "bun:sqlite";
import { vaultDbPath, vaultDir } from "./config.ts";
import { applyConnectionPragmas } from "../core/src/schema.ts";
import { mkdirSync } from "fs";

/**
 * Open (or create) a vault's SQLite database with vault's standard
 * connection pragmas (WAL + synchronous=NORMAL + foreign_keys=ON). Safe
 * for both the in-process store and out-of-process consumers (CLI,
 * parachute-runner, mirror tools) — pragmas are idempotent.
 *
 * The full schema migration runs separately when a `BunSqliteStore` is
 * instantiated around the returned handle; callers that just want raw
 * read access (auth probes, backup tooling) skip that and pay only the
 * pragma cost.
 */
export function openVaultDb(name: string): Database {
  const dir = vaultDir(name);
  mkdirSync(dir, { recursive: true });
  const db = new Database(vaultDbPath(name));
  applyConnectionPragmas(db);
  return db;
}
