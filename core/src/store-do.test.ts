/**
 * DoSqliteStore tests — exercised via a mock `DoDurableObjectStorage`
 * backed by bun:sqlite.
 *
 * The point of these tests isn't to retest the SQL (the `BunSqliteStore`
 * suite already covers every ops helper). It's to prove:
 *
 *   1. `DoSqliteAdapter` correctly maps the DO-style surface
 *      (`storage.sql.exec(query, ...bindings)` returning a cursor) onto
 *      the `SqlDb` contract the ops helpers consume.
 *   2. `DoSqliteStore` wires hooks, wikilink sync, schema init, and the
 *      statement-level behaviours the same way `BunSqliteStore` does.
 *   3. Multi-statement SQL (schema init, including FTS triggers with
 *      `BEGIN ... END;` blocks) is split cleanly.
 *   4. Attachments throw rather than silently misbehave.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { DoSqliteStore, type DoDurableObjectStorage, type DoSqlStorage, type DoSqlCursor } from "./store-do.js";
import { splitSqlStatements } from "./sql-db.js";

// ---------------------------------------------------------------------------
// Mock DO storage — delegates to an in-memory bun:sqlite Database, but
// only uses the DO-shaped surface (exec + cursor + transactionSync). This
// ensures the adapter would behave identically on real DO storage.
// ---------------------------------------------------------------------------

function mockStorage(db: Database): DoDurableObjectStorage {
  const sql: DoSqlStorage = {
    exec<T>(query: string, ...bindings: unknown[]): DoSqlCursor<T> {
      const stmt = db.prepare(query);
      // Detect data-modifying statements — bun:sqlite only gives us `.run()`
      // with `changes`, and `.all()` for reads. We route by SQL keyword.
      const isSelect = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query);

      if (isSelect) {
        const rows = stmt.all(...(bindings as [])) as T[];
        return { toArray: () => rows, rowsWritten: 0 };
      }

      const result = stmt.run(...(bindings as []));
      return { toArray: () => [] as T[], rowsWritten: result.changes };
    },
  };

  return {
    sql,
    transactionSync<T>(closure: () => T): T {
      db.exec("BEGIN");
      try {
        const r = closure();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

let store: DoSqliteStore;

beforeEach(() => {
  const db = new Database(":memory:");
  store = new DoSqliteStore(mockStorage(db));
});

// ---------------------------------------------------------------------------
// Splitter
// ---------------------------------------------------------------------------

describe("splitSqlStatements", () => {
  it("splits top-level statements on ;", () => {
    const stmts = splitSqlStatements("CREATE TABLE a (x INT); CREATE TABLE b (y INT);");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("CREATE TABLE a");
    expect(stmts[1]).toContain("CREATE TABLE b");
  });

  it("keeps BEGIN ... END; trigger bodies intact", () => {
    const sql = `
      CREATE TRIGGER t AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE INDEX i ON notes(created_at);
    `;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toMatch(/CREATE TRIGGER/);
    expect(stmts[0]).toMatch(/END$/);
    expect(stmts[1]).toMatch(/CREATE INDEX/);
  });

  it("ignores semicolons inside string literals", () => {
    const stmts = splitSqlStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'a;b'");
  });

  it("ignores line comments", () => {
    const stmts = splitSqlStatements(`
      -- a comment ;
      SELECT 1;
    `);
    expect(stmts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Store wiring
// ---------------------------------------------------------------------------

describe("DoSqliteStore", () => {
  it("initialises schema (no PRAGMA errors, FTS triggers land)", async () => {
    // If initSchema failed on multi-statement or PRAGMA, construction would
    // have thrown in beforeEach.
    const stats = await store.getVaultStats();
    expect(stats.totalNotes).toBe(0);
  });

  it("creates, retrieves, and deletes a note", async () => {
    const n = await store.createNote("hello from DO", { path: "Hello" });
    expect(n.id).toBeTruthy();
    expect(n.path).toBe("Hello");

    const fetched = await store.getNote(n.id);
    expect(fetched?.content).toBe("hello from DO");

    const byPath = await store.getNoteByPath("Hello");
    expect(byPath?.id).toBe(n.id);

    await store.deleteNote(n.id);
    expect(await store.getNote(n.id)).toBeNull();
  });

  it("tags and queries by tag", async () => {
    const n = await store.createNote("tagged", { tags: ["x", "y"] });
    const byTag = await store.queryNotes({ tags: ["x"] });
    expect(byTag.map((r) => r.id)).toContain(n.id);

    await store.untagNote(n.id, ["x"]);
    const after = await store.queryNotes({ tags: ["x"] });
    expect(after.map((r) => r.id)).not.toContain(n.id);
  });

  it("runs bulk createNotes inside transactionSync", async () => {
    const notes = await store.createNotes([
      { content: "one" },
      { content: "two" },
      { content: "three" },
    ]);
    expect(notes).toHaveLength(3);
    const all = await store.queryNotes({});
    expect(all).toHaveLength(3);
  });

  it("creates and queries links", async () => {
    const a = await store.createNote("A");
    const b = await store.createNote("B");
    await store.createLink(a.id, b.id, "relates-to");
    const links = await store.getLinks(a.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0]!.targetId).toBe(b.id);
  });

  it("syncs wikilinks on note create (cross-note link)", async () => {
    const target = await store.createNote("target body", { path: "Target" });
    const source = await store.createNote("see [[Target]]", { path: "Source" });
    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links.some((l) => l.targetId === target.id && l.relationship === "wikilink")).toBe(true);
  });

  it("runs FTS search after inserting via DO adapter", async () => {
    await store.createNote("the quick brown fox");
    await store.createNote("a slow blue whale");
    const hits = await store.searchNotes("brown");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("brown");
  });

  it("upserts and reads tag schemas", async () => {
    await store.upsertTagSchema("project", {
      description: "Active projects",
      fields: { name: { type: "string" } },
    });
    const s = await store.getTagSchema("project");
    expect(s?.description).toBe("Active projects");
    expect(s?.fields?.name?.type).toBe("string");
  });

  it("creates and reads attachment metadata (DB-only)", async () => {
    const n = await store.createNote("with attachment");
    const att = await store.addAttachment(n.id, "2026-04-14/audio.wav", "audio/wav", { duration: 12 });
    expect(att.path).toBe("2026-04-14/audio.wav");
    expect(att.mimeType).toBe("audio/wav");

    const atts = await store.getAttachments(n.id);
    expect(atts).toHaveLength(1);
    expect(atts[0]!.metadata).toEqual({ duration: 12 });
  });

  it("throws on blob I/O when no BlobStore is wired", async () => {
    expect(store.putBlob("k", new Uint8Array([1]))).rejects.toThrow(/BlobStore/);
    expect(store.getBlob("k")).rejects.toThrow(/BlobStore/);
    expect(store.deleteBlob("k")).rejects.toThrow(/BlobStore/);
  });

  it("routes blob I/O through the provided BlobStore", async () => {
    const db = new (await import("bun:sqlite")).Database(":memory:");
    const mem = new Map<string, { bytes: Uint8Array; mimeType?: string }>();
    const blobStore = {
      async put(key: string, data: Uint8Array | ArrayBuffer | Blob, opts?: { mimeType?: string }) {
        const bytes = data instanceof Uint8Array ? data
          : data instanceof ArrayBuffer ? new Uint8Array(data)
          : new Uint8Array(await (data as Blob).arrayBuffer());
        mem.set(key, { bytes, mimeType: opts?.mimeType });
      },
      async get(key: string) {
        const v = mem.get(key);
        if (!v) return null;
        return {
          body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(v.bytes); c.close(); } }),
          mimeType: v.mimeType,
          size: v.bytes.byteLength,
        };
      },
      async delete(key: string) { mem.delete(key); },
    };
    const s = new DoSqliteStore(mockStorage(db), { blobStore });
    await s.putBlob("a/b.bin", new Uint8Array([1, 2, 3]), { mimeType: "application/octet-stream" });
    const got = await s.getBlob("a/b.bin");
    expect(got).not.toBeNull();
    expect(got!.size).toBe(3);
    expect(got!.mimeType).toBe("application/octet-stream");
    await s.deleteBlob("a/b.bin");
    expect(await s.getBlob("a/b.bin")).toBeNull();
  });

  it("propagates BlobStore.put/delete rejections (not swallowed by async wrapper)", async () => {
    const db = new (await import("bun:sqlite")).Database(":memory:");
    const blobStore = {
      async put() { throw new Error("put failed"); },
      async get() { return null; },
      async delete() { throw new Error("delete failed"); },
    };
    const s = new DoSqliteStore(mockStorage(db), { blobStore });
    expect(s.putBlob("k", new Uint8Array([1]))).rejects.toThrow(/put failed/);
    expect(s.deleteBlob("k")).rejects.toThrow(/delete failed/);
  });
});
