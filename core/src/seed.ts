import type Database from "better-sqlite3";

/** Built-in tags seeded on startup. */
export const BUILTIN_TAGS = [
  "daily",
  "doc",
  "digest",
  "pinned",
  "archived",
  "voice",
] as const;

/**
 * Seed builtin tags. Idempotent — skips if already present.
 */
export function seedBuiltins(db: Database.Database): void {
  const stmt = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  for (const tag of BUILTIN_TAGS) {
    stmt.run(tag);
  }
}
