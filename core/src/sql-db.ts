/**
 * Minimal SQL database adapter interface.
 *
 * Both `bun:sqlite` (self-hosted, used by `BunSqliteStore`) and Cloudflare
 * Durable Objects SQLite (`ctx.storage.sql`, used by `DoSqliteStore`) expose
 * synchronous prepare/exec surfaces. This interface captures the subset our
 * ops helpers (`notes.ts`, `links.ts`, `wikilinks.ts`, `schema.ts`,
 * `tag-schemas.ts`) actually use, so the same helpers work on both runtimes.
 *
 * Conventions:
 * - Methods are synchronous. The async seam lives at the `Store` boundary.
 * - `exec` accepts multi-statement SQL (schema init, `BEGIN`/`COMMIT`).
 *   Implementations may split on `;` if the underlying driver only accepts
 *   one statement at a time.
 * - `transaction(fn)` runs `fn` inside a transaction. Use this instead of
 *   bare `BEGIN`/`COMMIT`/`ROLLBACK` — DO's storage has no bare statement
 *   form for those.
 */

import { Database as BunDatabase } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
  run(...params: unknown[]): SqlRunResult;
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

class BunSqlStatement implements SqlStatement {
  constructor(private readonly stmt: ReturnType<BunDatabase["prepare"]>) {}

  get<T = unknown>(...params: unknown[]): T | undefined {
    return (this.stmt.get(...(params as [])) as T | null) ?? undefined;
  }

  all<T = unknown>(...params: unknown[]): T[] {
    return this.stmt.all(...(params as [])) as T[];
  }

  run(...params: unknown[]): SqlRunResult {
    const r = this.stmt.run(...(params as []));
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }
}

// ---------------------------------------------------------------------------
// Multi-statement SQL splitter
//
// Drivers like Durable Objects' `ctx.storage.sql.exec` accept only one
// statement per call. Our schema SQL contains trigger bodies with `BEGIN ...
// END;` blocks, so a naive split on `;` would break them apart. This splitter
// tracks `BEGIN`/`END` depth and quoted strings/line comments to produce a
// clean list of top-level statements.
//
// Intentionally does NOT handle `/* block comments */` — our schema doesn't
// use them. Add that if we ever introduce schema SQL that does.
// ---------------------------------------------------------------------------

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  let beginDepth = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const rest = sql.slice(i);

    // Line comment
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) break;
      i = nl + 1;
      current += "\n";
      continue;
    }

    // String literal
    if (ch === "'") {
      const end = findStringEnd(sql, i);
      current += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Keyword detection (case-insensitive, word-bounded)
    const beginMatch = /^BEGIN\b/i.exec(rest);
    if (beginMatch && isWordBoundaryBefore(sql, i)) {
      beginDepth++;
      current += beginMatch[0];
      i += beginMatch[0].length;
      continue;
    }
    const endMatch = /^END\b/i.exec(rest);
    if (endMatch && isWordBoundaryBefore(sql, i) && beginDepth > 0) {
      beginDepth--;
      current += endMatch[0];
      i += endMatch[0].length;
      continue;
    }

    if (ch === ";" && beginDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

function findStringEnd(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      // Escaped quote: ''
      if (sql[i + 1] === "'") { i += 2; continue; }
      return i;
    }
    i++;
  }
  return sql.length - 1;
}

function isWordBoundaryBefore(sql: string, i: number): boolean {
  if (i === 0) return true;
  return !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "");
}

// ---------------------------------------------------------------------------
// Bun SQLite adapter — wraps `bun:sqlite`'s `Database`
// ---------------------------------------------------------------------------

export class BunSqliteAdapter implements SqlDb {
  constructor(public readonly db: BunDatabase) {}

  prepare(sql: string): SqlStatement {
    return new BunSqlStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
