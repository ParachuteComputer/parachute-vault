/**
 * Behavioral proof that the id-list query paths stay under the Cloudflare
 * Durable Object SQLite 100-bound-param cap over a real >100-note vault.
 *
 * bun:sqlite tolerates 999+ bound params, so it CANNOT reproduce the DO
 * `too many SQL variables` 500 directly — the ultimate DO-constraint proof is
 * the cloud staging export re-verify (orchestrator's post-merge step). What we
 * CAN prove locally, and what actually catches the regression that let the bug
 * ship, is the *shape* of the SQL each path issues: no single prepared
 * statement binds more than the chunk size (chunked lists) or a handful of
 * params (json_each id-sets). A prepare-spy records the max bind count per
 * statement; if a future edit raises the chunk size back over the cap, the
 * placeholder-IN assertion here fails.
 *
 * Root cause recap: DO SQLite caps bound params at 100/statement. The export
 * walk pages 500 notes at a time and hydrated each page's rows + tags with an
 * `id IN (?×page)` list sized for standard SQLite's 999 floor → >100 params →
 * DO 500. Fix: chunk id-lists at 90 (sql-in.ts) and bind embedded id-sets
 * (e.g. `near` neighborhoods) as one json_each param.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SqliteStore } from "./store.js";
import { exportVaultToDir } from "./portable-md.js";
import { IN_PARAM_CHUNK } from "./sql-in.js";

/** Zero-padded so lexicographic id order == numeric order. */
const pad = (i: number): string => String(i).padStart(5, "0");

/** Wrap `db.prepare` to record the max bind-arg count seen per SQL string.
 *  Install AFTER seeding so bulk-insert params don't pollute the sample. */
function installBindSpy(db: Database) {
  const perSql = new Map<string, number>();
  const origPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = origPrepare(sql) as Record<string, unknown>;
    const record = (n: number) => perSql.set(sql, Math.max(perSql.get(sql) ?? 0, n));
    for (const m of ["all", "get", "run", "values", "iterate"] as const) {
      const orig = stmt[m];
      if (typeof orig === "function") {
        stmt[m] = (...args: unknown[]) => {
          record(args.length);
          return (orig as (...a: unknown[]) => unknown).apply(stmt, args);
        };
      }
    }
    return stmt;
  };
  return {
    restore() {
      (db as unknown as { prepare: unknown }).prepare = origPrepare;
    },
    /** Max binds over statements carrying a literal `IN (?, …)` placeholder
     *  list — the chunked kind that must never exceed the chunk size. */
    maxPlaceholderInBinds(): number {
      let max = 0;
      for (const [sql, n] of perSql) if (/\bIN \(\?/.test(sql)) max = Math.max(max, n);
      return max;
    },
    /** Max binds over ALL statements — must stay under the DO cap. */
    maxAnyBinds(): number {
      let max = 0;
      for (const n of perSql.values()) max = Math.max(max, n);
      return max;
    },
    usedJsonEach(): boolean {
      for (const sql of perSql.keys()) if (/json_each\(/.test(sql)) return true;
      return false;
    },
  };
}

const DO_PARAM_CAP = 100;

describe("id-list query paths stay under the DO 100-bound-param cap", () => {
  let store: SqliteStore;
  let db: Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    store = new SqliteStore(db);
    // 250 notes > the DO cap and > 2× the chunk size, so chunking spans
    // multiple chunks (250 = 90 + 90 + 70).
    const inputs = [];
    for (let i = 0; i < 250; i++) {
      inputs.push({ content: `note ${i}`, id: `n${pad(i)}`, path: `notes/n${pad(i)}` });
    }
    await store.createNotes(inputs);
  });

  it("getNotes chunks a >100-id fetch (correct rows, no statement over the cap)", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `n${pad(i)}`);
    const spy = installBindSpy(db);
    try {
      const notes = await store.getNotes(ids);
      // Correctness: every requested note returned, ordered by created_at then id.
      expect(notes.length).toBe(250);
      expect(notes.map((n) => n.id)).toEqual(ids);
    } finally {
      spy.restore();
    }
    // Regression guard: no IN-list statement binds more than the chunk size...
    expect(spy.maxPlaceholderInBinds()).toBeLessThanOrEqual(IN_PARAM_CHUNK);
    // ...and nothing at all trips the DO cap.
    expect(spy.maxAnyBinds()).toBeLessThanOrEqual(DO_PARAM_CAP);
  });

  it("queryNotes over a >100-id set (the `near` path) binds the set as one json_each param", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `n${pad(i)}`);
    const spy = installBindSpy(db);
    let notes;
    try {
      notes = await store.queryNotes({ ids, limit: 1000, sort: "asc" });
    } finally {
      spy.restore();
    }
    // Correctness: all 150 in-set notes returned.
    expect(notes.length).toBe(150);
    // The id-set filter rode a single json_each param, not 150 placeholders...
    expect(spy.usedJsonEach()).toBe(true);
    // ...so no statement — including the phase-1 id select carrying the set —
    // exceeds the DO cap, and the phase-2 chunked hydration stays under it.
    expect(spy.maxPlaceholderInBinds()).toBeLessThanOrEqual(IN_PARAM_CHUNK);
    expect(spy.maxAnyBinds()).toBeLessThanOrEqual(DO_PARAM_CAP);
  });

  it("empty id-set still short-circuits (no json_each, no rows)", async () => {
    const notes = await store.queryNotes({ ids: [], limit: 10 });
    expect(notes.length).toBe(0);
  });

  describe("metadata in / not_in operators (vault#536)", () => {
    /**
     * `in` / `not_in` used to build `meta_<field> IN (?, ?, …)` — one bound
     * param per user-supplied value, with no chunking and no json_each. It's
     * an embedded filter inside a paginated statement, so chunking isn't
     * available (it would break the shared LIMIT/OFFSET window); the fix is
     * the single-json_each-param shape #535 introduced for `near`.
     */
    beforeEach(async () => {
      await store.upsertTagRecord("doc", {
        fields: { rank: { type: "integer", indexed: true } },
      });
      for (let i = 0; i < 250; i++) {
        await store.updateNote(`n${pad(i)}`, { tags: ["doc"], metadata: { rank: i } });
      }
    });

    it("a >100-value `in` binds one json_each param, not one per value", async () => {
      const wanted = Array.from({ length: 150 }, (_, i) => i);
      const spy = installBindSpy(db);
      let notes;
      try {
        notes = await store.queryNotes({
          metadata: { rank: { in: wanted } },
          limit: 1000,
          sort: "asc",
        });
      } finally {
        spy.restore();
      }
      expect(notes.length).toBe(150);
      expect(spy.usedJsonEach()).toBe(true);
      expect(spy.maxPlaceholderInBinds()).toBeLessThanOrEqual(IN_PARAM_CHUNK);
      expect(spy.maxAnyBinds()).toBeLessThanOrEqual(DO_PARAM_CAP);
    });

    it("a >100-value `not_in` binds one json_each param too", async () => {
      const excluded = Array.from({ length: 150 }, (_, i) => i);
      const spy = installBindSpy(db);
      let notes;
      try {
        notes = await store.queryNotes({
          metadata: { rank: { not_in: excluded } },
          limit: 1000,
          sort: "asc",
        });
      } finally {
        spy.restore();
      }
      // 250 notes, 150 excluded → the 100 with rank >= 150.
      expect(notes.length).toBe(100);
      expect(spy.usedJsonEach()).toBe(true);
      expect(spy.maxAnyBinds()).toBeLessThanOrEqual(DO_PARAM_CAP);
    });

    it("stays under the cap alongside LIMIT/OFFSET pagination params", async () => {
      const wanted = Array.from({ length: 200 }, (_, i) => i);
      const spy = installBindSpy(db);
      let notes;
      try {
        notes = await store.queryNotes({
          metadata: { rank: { in: wanted } },
          limit: 25,
          offset: 10,
          sort: "asc",
        });
      } finally {
        spy.restore();
      }
      expect(notes.length).toBe(25);
      expect(spy.maxAnyBinds()).toBeLessThanOrEqual(DO_PARAM_CAP);
    });
  });

  describe("export a >100-note vault", () => {
    let outDir: string;
    beforeEach(() => { outDir = mkdtempSync(join(tmpdir(), "do-cap-export-")); });
    afterEach(() => { try { rmSync(outDir, { recursive: true, force: true }); } catch {} });

    it("exports all 250 notes with no statement over the cap (the shipped bug)", async () => {
      const spy = installBindSpy(db);
      let stats;
      try {
        stats = await exportVaultToDir(store, { outDir, exportedAt: "2026-07-03T00:00:00.000Z" });
      } finally {
        spy.restore();
      }
      // Correctness: every note on disk.
      expect(stats.notes).toBe(250);
      expect(existsSync(join(outDir, "notes/n00000.md"))).toBe(true);
      expect(existsSync(join(outDir, "notes/n00090.md"))).toBe(true); // first chunk boundary
      expect(existsSync(join(outDir, "notes/n00249.md"))).toBe(true); // tail
      // The bug: the export page's `id IN (?×page)` hydration exceeded 100 on
      // DO. Now every IN-list statement stays under the chunk size...
      expect(spy.maxPlaceholderInBinds()).toBeLessThanOrEqual(IN_PARAM_CHUNK);
      // ...and no statement trips the DO cap.
      expect(spy.maxAnyBinds()).toBeLessThanOrEqual(DO_PARAM_CAP);
    });
  });
});
