/**
 * bun:sqlite compatibility layer for @parachute/core.
 *
 * Core uses better-sqlite3's Database API. bun:sqlite is nearly identical
 * except it lacks `.pragma()`. This wrapper adds it so core functions work
 * unchanged.
 */

import { Database as BunDatabase } from "bun:sqlite";
import { vaultDbPath, vaultDir } from "./config.ts";
import { mkdirSync } from "fs";

/**
 * Wraps bun:sqlite Database to match the better-sqlite3 API surface
 * used by @parachute/core (prepare, exec, pragma).
 */
export class CompatDatabase {
  private db: BunDatabase;

  constructor(path: string) {
    this.db = new BunDatabase(path);
  }

  /**
   * Emulate better-sqlite3's pragma() method.
   * e.g. pragma("journal_mode = WAL") or pragma("foreign_keys")
   */
  pragma(str: string): unknown {
    const eqIdx = str.indexOf("=");
    if (eqIdx !== -1) {
      const key = str.slice(0, eqIdx).trim();
      const val = str.slice(eqIdx + 1).trim();
      return this.db.prepare(`PRAGMA ${key} = ${val}`).get();
    }
    return this.db.prepare(`PRAGMA ${str}`).get();
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  close(): void {
    this.db.close();
  }
}

/** Open (or create) a vault's SQLite database. */
export function openVaultDb(name: string): CompatDatabase {
  const dir = vaultDir(name);
  mkdirSync(dir, { recursive: true });
  return new CompatDatabase(vaultDbPath(name));
}
