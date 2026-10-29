/**
 * T-36: Cloudflare Durable Object SQLite refuses a LIKE/GLOB pattern over 50
 * bytes ("LIKE or GLOB pattern too complex"). Resolving a wikilink with
 * `path LIKE '%/' || target` broke every write and import that carried an
 * unresolved target over 48 bytes. bun:sqlite has no such cap, so this file
 * proves the shape (no wikilink resolve binds a LIKE pattern) and the exact
 * suffix semantics; the workerd proof is parachute-cloud's
 * workers/vault/test/long-wikilink.test.ts.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { resolveWikilink, resolveWikilinkDetailed } from "./wikilinks.js";

let db: Database;
let store: SqliteStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

/** Record every string bound to a statement that uses LIKE or GLOB. */
function spyLikeBinds(d: Database) {
  const seen: string[] = [];
  const orig = d.prepare.bind(d);
  (d as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = orig(sql) as Record<string, unknown>;
    if (/\b(LIKE|GLOB)\b/i.test(sql)) {
      for (const m of ["all", "get", "run", "values", "iterate"] as const) {
        const f = stmt[m];
        if (typeof f === "function") {
          stmt[m] = (...args: unknown[]) => {
            for (const a of args) if (typeof a === "string") seen.push(a);
            return (f as (...x: unknown[]) => unknown).apply(stmt, args);
          };
        }
      }
    }
    return stmt;
  };
  return { seen, restore: () => ((d as unknown as { prepare: unknown }).prepare = orig) };
}

const LONG = "Meeting notes with the whole friends group about the move to cloud";

describe("wikilinks under the Durable Object LIKE cap (T-36)", () => {
  it("resolving and healing a long link binds no LIKE pattern over 50 bytes", async () => {
    const spy = spyLikeBinds(db);
    try {
      const src = await store.createNote(`see [[Projects/${LONG}]] and [[${LONG}]]`);
      await store.createNote("target", { path: `Projects/${LONG}` });
      expect(resolveWikilink(db, LONG)).not.toBeNull();
      expect(resolveWikilinkDetailed(db, LONG).resolved).toBe(true);
      expect(src.id).toBeTruthy();
    } finally {
      spy.restore();
    }
    const tooLong = spy.seen.filter((s) => new TextEncoder().encode(s).length > 50);
    expect(tooLong).toEqual([]);
  });

  it("the basename match is exact and case-insensitive", async () => {
    const n = await store.createNote("deep", { path: `Archive/2026/${LONG}` });
    expect(resolveWikilink(db, LONG.toUpperCase())).toBe(n.id);
    expect(resolveWikilink(db, LONG.slice(1))).toBeNull(); // not a whole segment
  });

  it("'_' and '%' in a target are literal, not wildcards", async () => {
    await store.createNote("x", { path: "a/x-name" });
    await store.createNote("y", { path: "b/anything-at-all" });
    expect(resolveWikilink(db, "_-name")).toBeNull();
    expect(resolveWikilink(db, "%")).toBeNull();
    expect(resolveWikilinkDetailed(db, "_-name").resolved).toBe(false);
  });

  it("a queued link heals only on an exact suffix, not a wildcard one", async () => {
    const src = await store.createNote("[[_-name]]");
    await store.createNote("x", { path: "a/x-name" });
    const pending = db
      .prepare("SELECT target_path FROM unresolved_wikilinks WHERE source_id = ?")
      .all(src.id) as { target_path: string }[];
    expect(pending.map((r) => r.target_path)).toEqual(["_-name"]);
    await store.createNote("real", { path: "c/_-name" });
    const after = db
      .prepare("SELECT target_path FROM unresolved_wikilinks WHERE source_id = ?")
      .all(src.id);
    expect(after).toEqual([]);
  });
});
