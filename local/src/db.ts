import Database from "better-sqlite3";
import { SqliteStore } from "@parachute/core";

/**
 * Create a SqliteStore backed by a file (or :memory: for tests).
 */
export function createStore(dbPath: string): SqliteStore {
  const db = new Database(dbPath);
  return new SqliteStore(db);
}
