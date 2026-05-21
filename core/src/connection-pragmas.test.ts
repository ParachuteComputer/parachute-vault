/**
 * Tests for connection-level pragmas — WAL mode + synchronous=NORMAL +
 * foreign_keys=ON. See applyConnectionPragmas in schema.ts and vault#326.
 *
 * `:memory:` databases land in journal_mode=memory and DO NOT support WAL
 * (the WAL/shm sidecars need a real file). On-disk DBs are the realistic
 * path; we exercise both so the readonly + filesystem-unsupported branches
 * are covered.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyConnectionPragmas, initSchema } from "./schema.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vault-pragma-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pragma(db: Database, name: string): string | number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, string | number> | null;
  if (!row) return "";
  // PRAGMA xxx returns a one-key object whose key matches the pragma name.
  const v = Object.values(row)[0];
  return typeof v === "string" ? v.toLowerCase() : (v as number);
}

describe("applyConnectionPragmas — on-disk DB", () => {
  it("enables WAL mode on a fresh on-disk database", () => {
    const db = new Database(join(dir, "fresh.db"));
    const result = applyConnectionPragmas(db);
    expect(result.wal).toBe(true);
    expect(result.journalMode).toBe("wal");
    expect(pragma(db, "journal_mode")).toBe("wal");
    db.close();
  });

  it("sets synchronous=NORMAL when WAL succeeds", () => {
    const db = new Database(join(dir, "sync.db"));
    applyConnectionPragmas(db);
    // synchronous values: 0=off, 1=normal, 2=full, 3=extra. NORMAL is 1.
    expect(pragma(db, "synchronous")).toBe(1);
    db.close();
  });

  it("sets wal_autocheckpoint=1000 when WAL succeeds", () => {
    const db = new Database(join(dir, "checkpoint.db"));
    applyConnectionPragmas(db);
    expect(pragma(db, "wal_autocheckpoint")).toBe(1000);
    db.close();
  });

  it("enables foreign_keys", () => {
    const db = new Database(join(dir, "fk.db"));
    applyConnectionPragmas(db);
    expect(pragma(db, "foreign_keys")).toBe(1);
    db.close();
  });

  it("is idempotent — applying twice yields the same result", () => {
    const dbPath = join(dir, "idem.db");
    const db = new Database(dbPath);
    const a = applyConnectionPragmas(db);
    const b = applyConnectionPragmas(db);
    expect(a).toEqual(b);
    expect(b.wal).toBe(true);
    db.close();
  });

  it("a DB created in DELETE mode is migrated to WAL on next open", () => {
    const dbPath = join(dir, "migrate.db");

    // First connection — manually force DELETE journal mode (the legacy
    // shape that pre-WAL vaults shipped with). Write some data so we can
    // verify it survives the WAL flip.
    {
      const db = new Database(dbPath);
      db.exec("PRAGMA journal_mode = DELETE");
      db.exec("CREATE TABLE legacy (k TEXT PRIMARY KEY, v TEXT)");
      db.prepare("INSERT INTO legacy (k, v) VALUES (?, ?)").run("hello", "world");
      expect(pragma(db, "journal_mode")).toBe("delete");
      db.close();
    }

    // Second connection — apply pragmas. WAL takes effect, existing data
    // intact.
    {
      const db = new Database(dbPath);
      const result = applyConnectionPragmas(db);
      expect(result.wal).toBe(true);
      const row = db.prepare("SELECT v FROM legacy WHERE k = ?").get("hello") as { v: string };
      expect(row.v).toBe("world");
      db.close();
    }
  });
});

describe("applyConnectionPragmas — :memory: DB", () => {
  it("returns wal:false, journalMode='memory' WITHOUT warning", () => {
    // :memory: is bun:sqlite's ephemeral mode — journal_mode comes back as
    // "memory" and WAL can't be enabled. This is an explicit caller choice
    // (test fixtures, throwaway probes), not an operator-visible filesystem
    // limitation, so applyConnectionPragmas suppresses the warning for it
    // to keep test output clean.
    const db = new Database(":memory:");

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    try {
      const result = applyConnectionPragmas(db);
      expect(result.wal).toBe(false);
      expect(result.journalMode).toBe("memory");
      expect(warnings.length).toBe(0);
    } finally {
      console.warn = origWarn;
      db.close();
    }
  });

  it("still enables foreign_keys on the :memory: branch", () => {
    const db = new Database(":memory:");
    applyConnectionPragmas(db);
    expect(pragma(db, "foreign_keys")).toBe(1);
    db.close();
  });
});

describe("applyConnectionPragmas — WAL-unsupported on-disk filesystem (simulated)", () => {
  it("warns once when an on-disk DB lands in a non-WAL, non-memory mode", () => {
    // We can't easily mount an NFS volume in CI, so simulate the
    // unsupported-FS branch: open an on-disk DB and immediately force
    // journal_mode to a non-WAL mode that sticks. PRAGMA journal_mode=WAL
    // will then return that mode (because WAL silently fell back), which
    // is the exact shape the unsupported-FS detection triggers on.
    //
    // We do this by stubbing prepare("PRAGMA journal_mode = WAL") to
    // return { journal_mode: "delete" } — what bun:sqlite returns when
    // SQLite refuses the WAL flip.
    const db = new Database(join(dir, "stub.db"));

    const origPrepare = db.prepare.bind(db);
    // @ts-expect-error — narrow override for the one PRAGMA we care about
    db.prepare = (sql: string) => {
      if (sql === "PRAGMA journal_mode = WAL") {
        return {
          get: () => ({ journal_mode: "delete" }),
          all: () => [{ journal_mode: "delete" }],
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
        };
      }
      return origPrepare(sql);
    };

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    try {
      const result = applyConnectionPragmas(db);
      expect(result.wal).toBe(false);
      expect(result.journalMode).toBe("delete");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("WAL mode could not be enabled");
      expect(warnings[0]).toContain("journal_mode=delete");

      // Second call on the same handle: dedupe by WeakSet, no second warn.
      applyConnectionPragmas(db);
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = origWarn;
      db.close();
    }
  });
});

describe("initSchema integration", () => {
  it("leaves a fresh vault DB in WAL mode after full initialization", () => {
    const db = new Database(join(dir, "vault.db"));
    initSchema(db);
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "synchronous")).toBe(1);
    db.close();
  });
});

describe("multi-connection concurrency under WAL", () => {
  it("allows a second connection to read while a first holds an open write txn", () => {
    // The whole point of WAL: a reader running concurrently with a writer
    // does NOT block. Under the legacy DELETE journal mode an open write
    // txn locks out readers and a `BEGIN IMMEDIATE` from a sibling
    // connection on the same file errors with SQLITE_BUSY.
    //
    // Setup: writer opens, applies pragmas (flips DB to WAL), inserts a
    // row, BEGINS another txn (uncommitted). Reader opens a second
    // connection to the same file and SELECTs — should succeed instantly
    // with the pre-txn committed state.
    const dbPath = join(dir, "concurrent.db");
    const writer = new Database(dbPath);
    initSchema(writer);

    writer.exec(`CREATE TABLE k (id INTEGER PRIMARY KEY, v TEXT)`);
    writer.prepare(`INSERT INTO k (id, v) VALUES (?, ?)`).run(1, "committed");

    // Open a long-running write txn that doesn't commit.
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare(`INSERT INTO k (id, v) VALUES (?, ?)`).run(2, "uncommitted");

    // Reader: a separate connection (simulating a separate process).
    // Under WAL this read should succeed and see only the committed row.
    const reader = new Database(dbPath, { readonly: true });
    try {
      const rows = reader.prepare("SELECT id, v FROM k ORDER BY id").all() as { id: number; v: string }[];
      expect(rows).toEqual([{ id: 1, v: "committed" }]);
    } finally {
      reader.close();
    }

    writer.exec("ROLLBACK");
    writer.close();
  });
});
