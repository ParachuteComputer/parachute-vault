/**
 * Contract tests for the transaction seam (core/src/txn.ts).
 *
 * Pins the behavior every migrated call site now depends on: commit returns
 * the callback's value, a throw rolls back and re-throws the ORIGINAL error,
 * and a ROLLBACK that itself fails (the "COMMIT already resolved the txn"
 * case) is swallowed so the original error still propagates. The swallow /
 * ordering cases use a structural fake `TxnCapableDb` so we can force a
 * COMMIT/ROLLBACK failure deterministically; the happy + real-rollback cases
 * run against a live bun:sqlite connection.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { transaction, transactionAsync, type TxnCapableDb } from "./txn.js";

/** A fake `TxnCapableDb` that records exec calls and can be told to throw on
 *  COMMIT and/or ROLLBACK — lets us drive the failure branches exactly. */
function fakeDb(opts: { commitThrows?: Error; rollbackThrows?: Error } = {}): {
  db: TxnCapableDb;
  calls: string[];
} {
  const calls: string[] = [];
  const db: TxnCapableDb = {
    exec(sql: string): void {
      calls.push(sql);
      if (sql === "COMMIT" && opts.commitThrows) throw opts.commitThrows;
      if (sql === "ROLLBACK" && opts.rollbackThrows) throw opts.rollbackThrows;
    },
  };
  return { db, calls };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  return db;
}

describe("transaction (sync)", () => {
  it("commits and returns the callback's value", () => {
    const db = freshDb();
    const result = transaction(db, () => {
      db.exec("INSERT INTO t (id, v) VALUES (1, 'a')");
      return { count: 1 };
    });
    expect(result).toEqual({ count: 1 });
    // Write is durable after commit.
    expect((db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);
  });

  it("wraps in BEGIN IMMEDIATE … COMMIT", () => {
    const { db, calls } = fakeDb();
    transaction(db, () => "ok");
    expect(calls).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("rolls back and re-throws the ORIGINAL error when the callback throws", () => {
    const db = freshDb();
    const sentinel = new Error("boom");
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO t (id, v) VALUES (1, 'a')");
        throw sentinel;
      }),
    ).toThrow(sentinel);
    // The inner INSERT was rolled back.
    expect((db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(0);
  });

  it("issues ROLLBACK (not COMMIT) on a callback throw", () => {
    const { db, calls } = fakeDb();
    expect(() => transaction(db, () => { throw new Error("x"); })).toThrow("x");
    expect(calls).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("swallows a ROLLBACK failure after a COMMIT throw and propagates the ORIGINAL (commit) error", () => {
    const commitErr = new Error("commit failed");
    const rollbackErr = new Error("no transaction is active");
    const { db, calls } = fakeDb({ commitThrows: commitErr, rollbackThrows: rollbackErr });
    let thrown: unknown;
    try {
      transaction(db, () => "value");
    } catch (e) {
      thrown = e;
    }
    // The COMMIT error is the original that propagates; the ROLLBACK error is swallowed.
    expect(thrown).toBe(commitErr);
    expect(calls).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
  });

  it("preserves the callback error even when ROLLBACK also fails", () => {
    const callbackErr = new Error("callback boom");
    const rollbackErr = new Error("rollback boom");
    const { db } = fakeDb({ rollbackThrows: rollbackErr });
    let thrown: unknown;
    try {
      transaction(db, () => { throw callbackErr; });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(callbackErr);
  });
});

describe("transaction — native transactionSync preference (DO backend)", () => {
  /** A db that exposes a native `transactionSync` (standing in for a Durable
   *  Object shim delegating to `ctx.storage.transactionSync`). Here it's backed
   *  by bun's own `.transaction()` so rollback-on-throw is real, while the raw
   *  BEGIN/COMMIT it issues internally never flow through our `exec` — letting
   *  us assert the seam issued no explicit transaction SQL. */
  function nativeDb(): { db: TxnCapableDb; execs: string[]; bun: Database } {
    const bun = freshDb();
    const execs: string[] = [];
    const db: TxnCapableDb = {
      exec(sql: string): void {
        execs.push(sql);
        bun.exec(sql);
      },
      transactionSync<T>(fn: () => T): T {
        return bun.transaction(fn)();
      },
    };
    return { db, execs, bun };
  }

  it("prefers transactionSync over BEGIN IMMEDIATE — delegates once, issues no raw txn SQL", () => {
    const calls: string[] = [];
    const state = { txnCalls: 0 };
    const db: TxnCapableDb = {
      exec(sql: string): void { calls.push(sql); },
      transactionSync<T>(fn: () => T): T { state.txnCalls++; return fn(); },
    };
    const result = transaction(db, () => { db.exec("WORK"); return "ok"; });
    expect(result).toBe("ok");
    expect(state.txnCalls).toBe(1);
    // Only the inner write — never BEGIN IMMEDIATE / COMMIT / ROLLBACK.
    expect(calls).toEqual(["WORK"]);
  });

  it("commits via native transactionSync and returns the callback's value", () => {
    const { db, bun } = nativeDb();
    const result = transaction(db, () => {
      db.exec("INSERT INTO t (id, v) VALUES (1, 'a')");
      return 42;
    });
    expect(result).toBe(42);
    expect((bun.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);
  });

  it("rolls back through the native transactionSync on a throw, re-throwing the ORIGINAL error", () => {
    const { db, execs, bun } = nativeDb();
    const sentinel = new Error("native boom");
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO t (id, v) VALUES (1, 'a')");
        throw sentinel;
      }),
    ).toThrow(sentinel);
    // Real rollback — the write did not persist.
    expect((bun.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(0);
    // The seam issued NO raw transaction SQL of its own (the native primitive
    // owns BEGIN/COMMIT/ROLLBACK internally); only the inner INSERT flowed through.
    expect(execs).toEqual(["INSERT INTO t (id, v) VALUES (1, 'a')"]);
  });

  it("bun path unchanged when the db has no transactionSync (BEGIN IMMEDIATE … COMMIT)", () => {
    const { db, calls } = fakeDb(); // no transactionSync
    transaction(db, () => "ok");
    expect(calls).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });
});

describe("transactionAsync", () => {
  it("commits and returns the callback's resolved value", async () => {
    const db = freshDb();
    const result = await transactionAsync(db, async () => {
      db.exec("INSERT INTO t (id, v) VALUES (1, 'a')");
      return 7;
    });
    expect(result).toBe(7);
    expect((db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);
  });

  it("wraps in BEGIN IMMEDIATE … COMMIT", async () => {
    const { db, calls } = fakeDb();
    await transactionAsync(db, async () => "ok");
    expect(calls).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("rolls back and re-throws the ORIGINAL error when the callback rejects", async () => {
    const db = freshDb();
    const sentinel = new Error("async boom");
    await expect(
      transactionAsync(db, async () => {
        db.exec("INSERT INTO t (id, v) VALUES (1, 'a')");
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
    expect((db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(0);
  });

  it("swallows a ROLLBACK failure after a COMMIT throw and propagates the ORIGINAL (commit) error", async () => {
    const commitErr = new Error("commit failed");
    const rollbackErr = new Error("no transaction is active");
    const { db, calls } = fakeDb({ commitThrows: commitErr, rollbackThrows: rollbackErr });
    let thrown: unknown;
    try {
      await transactionAsync(db, async () => "value");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(commitErr);
    expect(calls).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
  });

  it("preserves the callback error even when ROLLBACK also fails", async () => {
    const callbackErr = new Error("callback boom");
    const rollbackErr = new Error("rollback boom");
    const { db } = fakeDb({ rollbackThrows: rollbackErr });
    let thrown: unknown;
    try {
      await transactionAsync(db, async () => { throw callbackErr; });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(callbackErr);
  });
});
