/**
 * Cursor keyset ordering on the integer `updated_at_ms` column (schema v26,
 * vault#586).
 *
 * THE BUG this closes: the `(updated_at, id)` cursor keyset used THREE
 * inconsistent orderings of `updated_at` that agree ONLY when every timestamp
 * is canonical `.toISOString()` output —
 *   1. walk order = TEXT-lexicographic `ORDER BY n.updated_at ASC, n.id ASC`,
 *   2. boundary  = a canonical-ISO string compared as TEXT (`n.updated_at > ?`),
 *   3. watermark = `Date.parse(...)` millis, which read space-form timestamps
 *      in LOCAL time and THREW on unparseable strings.
 * Import stores frontmatter timestamps VERBATIM, so aged/imported vaults carry
 * non-canonical `updated_at` (`2024-11-02 14:30:00` space-form, `+02:00`
 * offset, no-`Z`) — under which the three diverge and cursor pagination
 * silently SKIPPED notes, re-delivered offset rows in an infinite loop, or
 * 400'd the whole walk. v26 introduces an integer `updated_at_ms` column that
 * makes walk-order, boundary, and watermark ONE numeric ordering.
 *
 * Mirrors the real failure: non-canonical values are injected via direct
 * sqlite UPDATE / seeded into a pre-v26 table (that's how they land in prod via
 * import), and the v26 backfill derives `updated_at_ms` UTC-correctly.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, SCHEMA_VERSION } from "./schema.js";
import { timestampToMs, decodeCursor } from "./cursor.js";
import { SqliteStore } from "./store.js";
import * as noteOps from "./notes.js";

/** Raw read of a note's integer keyset key (not on the Note wire shape). */
function msOf(db: Database, id: string): number | null {
  return (
    db.prepare("SELECT updated_at_ms FROM notes WHERE id = ?").get(id) as {
      updated_at_ms: number | null;
    }
  ).updated_at_ms;
}

// ---------------------------------------------------------------------------
// timestampToMs — the ONE UTC-correct parser feeding the backfill + writes.
// ---------------------------------------------------------------------------
describe("timestampToMs — UTC-correct, never-throws (vault#586)", () => {
  it("canonical `.000Z` round-trips to its epoch", () => {
    expect(timestampToMs("2024-11-02T14:30:00.000Z")).toBe(Date.UTC(2024, 10, 2, 14, 30, 0, 0));
  });

  it("space-separated `YYYY-MM-DD HH:MM:SS` is read as UTC — NOT shifted by local tz (the live bug)", () => {
    const ms = timestampToMs("2024-11-02 14:30:00");
    // The correct UTC answer, independent of the host timezone.
    expect(ms).toBe(Date.UTC(2024, 10, 2, 14, 30, 0));
    // And identical to the explicit-Z form — proving the space separator did
    // NOT trigger a local-time reinterpretation.
    expect(ms).toBe(timestampToMs("2024-11-02T14:30:00Z"));
  });

  it("zone-less ISO `YYYY-MM-DDTHH:MM:SS` (no Z) is read as UTC, not local", () => {
    expect(timestampToMs("2024-05-05T06:30:00")).toBe(Date.UTC(2024, 4, 5, 6, 30, 0));
  });

  it("explicit `+HH:MM` / `-HH:MM` offsets shift to UTC", () => {
    // 10:00 at +02:00 == 08:00Z; 10:00 at -05:00 == 15:00Z.
    expect(timestampToMs("2024-04-04T10:00:00+02:00")).toBe(Date.UTC(2024, 3, 4, 8, 0, 0));
    expect(timestampToMs("2024-04-04T10:00:00-05:00")).toBe(Date.UTC(2024, 3, 4, 15, 0, 0));
    // Colon-less offset spelling too.
    expect(timestampToMs("2024-04-04T10:00:00+0200")).toBe(Date.UTC(2024, 3, 4, 8, 0, 0));
  });

  it("fractional seconds truncate (floor) to millisecond precision", () => {
    expect(timestampToMs("2024-01-01T00:00:00.5Z")).toBe(Date.UTC(2024, 0, 1, 0, 0, 0, 500));
    expect(timestampToMs("2024-01-01T00:00:00.123456Z")).toBe(Date.UTC(2024, 0, 1, 0, 0, 0, 123));
  });

  it("second- and minute-precision (no seconds) and date-only forms parse as UTC", () => {
    expect(timestampToMs("2024-11-02")).toBe(Date.UTC(2024, 10, 2, 0, 0, 0));
    expect(timestampToMs("2024-11-02T14:30")).toBe(Date.UTC(2024, 10, 2, 14, 30, 0));
  });

  it("genuinely unparseable / empty / non-string → null (caller supplies a fallback, no throw)", () => {
    expect(timestampToMs("not a timestamp")).toBeNull();
    expect(timestampToMs("")).toBeNull();
    expect(timestampToMs("   ")).toBeNull();
    expect(timestampToMs(null)).toBeNull();
    expect(timestampToMs(undefined)).toBeNull();
    // Never throws, whatever the input.
    expect(() => timestampToMs("2024-13-99 99:99:99xyz")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fixture: a pre-v26 vault — the notes table WITHOUT `updated_at_ms`, seeded
// with a matrix of `updated_at` shapes BEFORE the migration runs (exactly the
// aged/imported-vault upgrade scenario). `initSchema` drives the whole chain
// up through migrateToV26, which adds the column and backfills it.
// ---------------------------------------------------------------------------
interface SeedRow {
  id: string;
  updated_at: string;
  created_at: string;
  /** Expected backfilled updated_at_ms after migrateToV26. */
  expectedMs: number;
}

// A deliberate spread of shapes + mixed ULID / legacy-timestamp ids, plus a
// same-millisecond cluster, an unparseable-updated_at row (falls back to
// created_at), and a both-unparseable row (falls back to the 0 sentinel).
const SEED: SeedRow[] = [
  // canonical Z (ULID id)
  { id: "01J0AAAAAAAAAAAAAAAAAAAAAA", updated_at: "2024-01-01T00:00:00.000Z", created_at: "2024-01-01T00:00:00.000Z", expectedMs: Date.UTC(2024, 0, 1) },
  // second-precision Z, no millis (legacy-format id)
  { id: "2024-02-02-12-00-00-000000", updated_at: "2024-02-02T12:00:00Z", created_at: "2024-02-02T12:00:00Z", expectedMs: Date.UTC(2024, 1, 2, 12) },
  // SPACE-separated, no zone — the live bug shape
  { id: "note-space", updated_at: "2024-03-03 08:15:00", created_at: "2024-03-03T08:15:00.000Z", expectedMs: Date.UTC(2024, 2, 3, 8, 15) },
  // +02:00 offset
  { id: "note-offset-plus", updated_at: "2024-04-04T10:00:00+02:00", created_at: "2024-04-04T08:00:00.000Z", expectedMs: Date.UTC(2024, 3, 4, 8) },
  // -05:00 offset
  { id: "note-offset-minus", updated_at: "2024-04-04T10:00:00-05:00", created_at: "2024-04-04T15:00:00.000Z", expectedMs: Date.UTC(2024, 3, 4, 15) },
  // zone-less T form
  { id: "note-zoneless", updated_at: "2024-05-05T06:30:00", created_at: "2024-05-05T06:30:00.000Z", expectedMs: Date.UTC(2024, 4, 5, 6, 30) },
  // same-millisecond cluster (three rows share updated_at → same ms; id breaks the tie)
  { id: "cluster-c", updated_at: "2024-06-06T00:00:00.000Z", created_at: "2024-06-06T00:00:00.000Z", expectedMs: Date.UTC(2024, 5, 6) },
  { id: "cluster-a", updated_at: "2024-06-06T00:00:00.000Z", created_at: "2024-06-06T00:00:00.000Z", expectedMs: Date.UTC(2024, 5, 6) },
  { id: "cluster-b", updated_at: "2024-06-06T00:00:00.000Z", created_at: "2024-06-06T00:00:00.000Z", expectedMs: Date.UTC(2024, 5, 6) },
  // historically-unparseable updated_at → falls back to created_at's ms
  { id: "note-unparseable", updated_at: "not-a-real-timestamp", created_at: "2024-07-07T00:00:00.000Z", expectedMs: Date.UTC(2024, 6, 7) },
  // BOTH unparseable → the stable 0 sentinel (never NULL, never a throw)
  { id: "note-both-bad", updated_at: "garbage", created_at: "also-garbage", expectedMs: 0 },
];

function buildPreV26Vault(): Database {
  const db = new Database(":memory:");
  // The pre-v26 notes shape: everything v25 had EXCEPT `updated_at_ms`.
  db.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      content TEXT DEFAULT '',
      path TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      extension TEXT NOT NULL DEFAULT 'md',
      created_by TEXT,
      created_via TEXT,
      last_updated_by TEXT,
      last_updated_via TEXT
    );
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
    INSERT INTO schema_version (version, applied_at) VALUES (25, '2026-01-01T00:00:00.000Z');
  `);
  const insert = db.prepare(
    "INSERT INTO notes (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
  );
  for (const row of SEED) {
    insert.run(row.id, `content of ${row.id}`, row.created_at, row.updated_at);
  }
  return db;
}

describe("migrateToV26 — backfills updated_at_ms UTC-correctly (vault#586)", () => {
  it("has no updated_at_ms column before the migration; adds one after", () => {
    const db = buildPreV26Vault();
    const cols = () =>
      (db.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map((c) => c.name);
    expect(cols()).not.toContain("updated_at_ms");
    initSchema(db);
    expect(cols()).toContain("updated_at_ms");
    // Chain advanced all the way to the current schema version.
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(
      SCHEMA_VERSION,
    );
  });

  it("backfills each row from its updated_at with a UTC-correct parse (space-form NOT tz-shifted)", () => {
    const db = buildPreV26Vault();
    initSchema(db);
    for (const row of SEED) {
      const got = (
        db.prepare("SELECT updated_at_ms FROM notes WHERE id = ?").get(row.id) as {
          updated_at_ms: number | null;
        }
      ).updated_at_ms;
      expect(got).toBe(row.expectedMs);
    }
    // No row left NULL — a NULL key would break the `> ?` keyset predicate.
    const nulls = (
      db.prepare("SELECT COUNT(*) AS n FROM notes WHERE updated_at_ms IS NULL").get() as { n: number }
    ).n;
    expect(nulls).toBe(0);
  });

  it("creates the (updated_at_ms, id) keyset index", () => {
    const db = buildPreV26Vault();
    initSchema(db);
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notes_updated_ms'")
      .get();
    expect(idx).toBeTruthy();
  });

  it("the rewritten keyset predicate seeks the (updated_at_ms, id) index — no full scan / temp b-tree", () => {
    const db = buildPreV26Vault();
    initSchema(db);
    // This is the SQL queryNotes now emits in cursor mode (integer keyset).
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT n.id FROM notes n
         WHERE (n.updated_at_ms > ? OR (n.updated_at_ms = ? AND n.id > ?))
         ORDER BY n.updated_at_ms ASC, n.id ASC LIMIT 10`,
      )
      .all(0, 0, "") as { detail: string }[];
    const details = plan.map((r) => r.detail).join(" | ");
    expect(details).toContain("idx_notes_updated_ms");
    expect(details).not.toContain("TEMP B-TREE");
  });

  it("is idempotent — a second initSchema neither re-backfills nor throws", () => {
    const db = buildPreV26Vault();
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    // The unparseable-both row keeps its sentinel; nothing drifted.
    const got = (
      db.prepare("SELECT updated_at_ms FROM notes WHERE id = ?").get("note-both-bad") as {
        updated_at_ms: number | null;
      }
    ).updated_at_ms;
    expect(got).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The whole point: an aged vault with the full matrix walks a cursor from
// bootstrap to empty with zero misses, zero duplicates, bounded pages, and no
// throw — the exact loop that was broken pre-v26.
// ---------------------------------------------------------------------------
describe("cursor walk over a matrix of non-canonical timestamps (vault#586)", () => {
  const allIds = SEED.map((r) => r.id).sort();

  function walk(db: Database, limit: number): { seen: string[]; pages: number; threw: unknown } {
    const seen: string[] = [];
    let cursor = ""; // bootstrap
    let pages = 0;
    // Hard cap well above the honest bound so a broken (looping) walk fails
    // LOUDLY on the page-count assertion instead of spinning forever.
    const hardCap = SEED.length * 4 + 10;
    let threw: unknown = null;
    try {
      while (pages < hardCap) {
        const page = noteOps.queryNotesPaged(db, { cursor, limit });
        pages++;
        if (page.notes.length === 0) break;
        for (const n of page.notes) seen.push(n.id);
        cursor = page.next_cursor;
      }
    } catch (err) {
      threw = err;
    }
    return { seen, pages, threw };
  }

  it("bootstrap → empty page: every id exactly once, terminates within ceil(N/limit)+2 pages, no throw", () => {
    const db = buildPreV26Vault();
    initSchema(db);
    const limit = 3;
    const { seen, pages, threw } = walk(db, limit);

    // No page 400'd / threw (unparseable timestamps used to blow up the walk).
    expect(threw).toBeNull();
    // Zero duplicates.
    expect(seen.length).toBe(new Set(seen).size);
    // Zero misses + no extras: the visited set equals ALL ids.
    expect([...seen].sort()).toEqual(allIds);
    // Bounded termination (includes the final empty page).
    const bound = Math.ceil(SEED.length / limit) + 2;
    expect(pages).toBeLessThanOrEqual(bound);
  });

  it("holds across several page sizes (including limit=1 and a limit > N)", () => {
    for (const limit of [1, 2, 4, 100]) {
      const db = buildPreV26Vault();
      initSchema(db);
      const { seen, threw } = walk(db, limit);
      expect(threw).toBeNull();
      expect(seen.length).toBe(new Set(seen).size);
      expect([...seen].sort()).toEqual(allIds);
    }
  });

  it("a bare mid-walk sqlite UPDATE of updated_at alone (no ms) would strand a row — the store never does this, and a full walk still completes", () => {
    // Belt-and-suspenders: even after a rogue direct `UPDATE notes SET
    // updated_at` that leaves updated_at_ms untouched (NOT a path the store
    // exposes), the keyset — which reads updated_at_ms — still terminates and
    // never throws. The ms column is authoritative; the string is cosmetic.
    const db = buildPreV26Vault();
    initSchema(db);
    db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(
      "2099-01-01 00:00:00",
      "note-space",
    );
    const { seen, threw } = walk(db, 3);
    expect(threw).toBeNull();
    expect([...seen].sort()).toEqual(allIds);
  });
});

// ---------------------------------------------------------------------------
// LOAD-BEARING: the ALTER + backfill run inside ONE transaction, so a crash
// mid-backfill rolls the column back and the next boot re-runs cleanly. A
// partial backfill left behind (column present, some rows NULL) would be
// permanent — the `hasColumn` guard would report "done." This test drives the
// REAL migrateToV26 (via initSchema) and injects a crash on the 2nd backfill
// UPDATE. Remove the `transaction()` wrap and it goes RED (post-crash the
// column persists with NULLs, the guard skips, and recovery leaves NULLs).
// ---------------------------------------------------------------------------
describe("migrateToV26 is all-or-nothing (crash mid-backfill) (vault#586)", () => {
  it("a crash during the backfill rolls back the ALTER; the next initSchema fully recovers", () => {
    const db = buildPreV26Vault();
    const hasMsColumn = () =>
      (db.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).some(
        (c) => c.name === "updated_at_ms",
      );
    expect(hasMsColumn()).toBe(false);

    // Patch prepare so the backfill statement's `.run` throws on its 2nd call —
    // a faithful mid-loop interruption AFTER the ALTER (db.exec, untouched) and
    // after one row has already been written inside the transaction.
    const origPrepare = db.prepare.bind(db);
    let runCount = 0;
    let injected = false;
    (db as any).prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (/UPDATE notes SET updated_at_ms = \?/.test(sql)) {
        const origRun = stmt.run.bind(stmt);
        (stmt as any).run = (...args: unknown[]) => {
          runCount++;
          if (runCount === 2) {
            injected = true;
            throw new Error("simulated crash mid-backfill");
          }
          return (origRun as (...a: unknown[]) => unknown)(...args);
        };
      }
      return stmt;
    };

    expect(() => initSchema(db)).toThrow("simulated crash mid-backfill");
    // Positive control: the injection actually fired (not a vacuous pass).
    expect(injected).toBe(true);

    // Restore the real prepare for the assertions + recovery run.
    (db as any).prepare = origPrepare;

    // LOAD-BEARING: the transaction rolled back the ALTER — the column is GONE,
    // so the hasColumn guard correctly re-detects "not migrated". Without the
    // wrap the ALTER would have autocommitted and this reads `true`, the guard
    // skips forever, and the rows below stay NULL.
    expect(hasMsColumn()).toBe(false);
    // schema_version never advanced past the fixture's 25.
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(
      25,
    );

    // A clean restart re-runs the REAL migration and fully backfills — no NULLs.
    initSchema(db);
    expect(hasMsColumn()).toBe(true);
    const nulls = (
      db.prepare("SELECT COUNT(*) AS n FROM notes WHERE updated_at_ms IS NULL").get() as { n: number }
    ).n;
    expect(nulls).toBe(0);
    for (const row of SEED) {
      const got = (
        db.prepare("SELECT updated_at_ms FROM notes WHERE id = ?").get(row.id) as {
          updated_at_ms: number | null;
        }
      ).updated_at_ms;
      expect(got).toBe(row.expectedMs);
    }
  });
});

// ---------------------------------------------------------------------------
// SELF-HEAL (review nit 1): a vault whose notes table ALREADY has the column
// but carries NULL updated_at_ms rows — the shape a schema-v2-era upgrade
// produces (migrateFromV2's INSERT…SELECT omits the column). A
// column-presence-only guard would leave those NULL forever (invisible to the
// keyset). migrateToV26 must backfill WHERE updated_at_ms IS NULL regardless.
// ---------------------------------------------------------------------------
describe("migrateToV26 self-heals NULL updated_at_ms on an existing column (vault#586)", () => {
  function buildColumnPresentWithNullRows(): Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        content TEXT DEFAULT '',
        path TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT,
        extension TEXT NOT NULL DEFAULT 'md',
        created_by TEXT,
        created_via TEXT,
        last_updated_by TEXT,
        last_updated_via TEXT,
        updated_at_ms INTEGER
      );
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
      INSERT INTO schema_version (version, applied_at) VALUES (25, '2026-01-01T00:00:00.000Z');
    `);
    const ins = db.prepare(
      "INSERT INTO notes (id, content, created_at, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
    );
    // Two leaked rows: column present, updated_at_ms NULL — one space-form, one
    // unparseable (falls back to created_at).
    ins.run("leak-space", "", "2024-03-03T08:15:00.000Z", "2024-03-03 08:15:00", null);
    ins.run("leak-bad", "", "2024-07-07T00:00:00.000Z", "not-a-timestamp", null);
    // An already-populated row carrying a deliberately-arbitrary ms — the
    // self-heal touches only NULLs, so this must survive UNCHANGED.
    ins.run("already", "", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z", 999);
    return db;
  }

  it("backfills the NULL rows UTC-correctly, leaves populated rows untouched, ends with zero NULLs", () => {
    const db = buildColumnPresentWithNullRows();
    expect(msOf(db, "leak-space")).toBeNull(); // precondition: leaked NULL
    initSchema(db);

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM notes WHERE updated_at_ms IS NULL").get() as { n: number }).n,
    ).toBe(0);
    // Space-form healed to UTC (not local-shifted).
    expect(msOf(db, "leak-space")).toBe(Date.UTC(2024, 2, 3, 8, 15));
    // Unparseable updated_at healed via created_at fallback.
    expect(msOf(db, "leak-bad")).toBe(Date.UTC(2024, 6, 7));
    // Already-populated row: NOT re-derived (still the arbitrary 999).
    expect(msOf(db, "already")).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// WRITE-SITE PINS (review nit 3): assert updated_at_ms actually advances at
// the restore + rename-cascade sites, so reverting either ms hunk goes RED
// (previously the whole suite passed with those hunks removed).
// ---------------------------------------------------------------------------
describe("write sites maintain updated_at_ms in lockstep (vault#586)", () => {
  it("restoreNoteTimestamps derives updated_at_ms UTC-correctly from a non-canonical updated_at (pins store.ts hunk)", async () => {
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    const note = await store.createNote("x");
    const createMs = msOf(db, note.id)!;

    // Import restores a verbatim, non-canonical (space-form) updated_at.
    await store.restoreNoteTimestamps(note.id, "2024-01-01T00:00:00.000Z", "2024-03-03 08:15:00");

    // updated_at kept verbatim (round-trip fidelity); ms derived UTC-correctly.
    const row = db.prepare("SELECT updated_at, updated_at_ms FROM notes WHERE id = ?").get(note.id) as {
      updated_at: string;
      updated_at_ms: number;
    };
    expect(row.updated_at).toBe("2024-03-03 08:15:00");
    expect(row.updated_at_ms).toBe(Date.UTC(2024, 2, 3, 8, 15));
    // A revert of the store hunk would leave ms at the createNote value.
    expect(row.updated_at_ms).not.toBe(createMs);
  });

  it("renameTag path-cascade bumps updated_at_ms on a `_tags/<old>` note (pins notes.ts path hunk)", async () => {
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    // Body has no #task, so ONLY the path cascade touches this note — isolating
    // the path hunk from the content hunk.
    const note = await store.createNote("plain body, no hashtags", {
      path: "_tags/task",
      tags: ["task"],
    });
    const beforeMs = msOf(db, note.id)!;
    await new Promise((r) => setTimeout(r, 5));

    await store.renameTag("task", "todo");

    const fresh = await store.getNote(note.id);
    expect(fresh!.path).toBe("_tags/todo");
    const afterMs = msOf(db, note.id)!;
    expect(afterMs).toBeGreaterThan(beforeMs);
    expect(afterMs).toBe(Date.parse(fresh!.updatedAt!));
  });
});

// ---------------------------------------------------------------------------
// SAME-SNAPSHOT WATERMARK (review nit 2): the watermark is captured in the
// phase-1 page statement (the one that ordered + sliced the page), not a
// separate later read. A concurrent writer that bumps a page row's ms AFTER
// the page is read must NOT make the watermark leapfrog past unseen rows.
// ---------------------------------------------------------------------------
describe("queryNotesPaged watermark comes from the phase-1 page snapshot (vault#586)", () => {
  it("a concurrent writer bumping a page row's ms after the page read does NOT advance the watermark past it", () => {
    const db = buildPreV26Vault();
    initSchema(db);

    // The true max keyset key of the full page (bootstrap, limit > N): the
    // July row. note-offset-plus (an EARLIER row) is what we'll bump.
    const trueMax = Date.UTC(2024, 6, 7); // note-unparseable → created_at fallback
    const bumpTarget = "note-offset-plus";

    const origPrepare = db.prepare.bind(db);
    let bumped = false;
    (db as any).prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      // Intercept ONLY the phase-1 ordering statement.
      if (/SELECT n\.id, n\.updated_at_ms FROM notes n/.test(sql)) {
        const origAll = stmt.all.bind(stmt);
        (stmt as any).all = (...args: unknown[]) => {
          const rows = (origAll as (...a: unknown[]) => unknown[])(...args);
          // A concurrent writer lands right AFTER the page snapshot is read,
          // shoving the target row's ms far into the future. A watermark that
          // re-read the column in a SECOND statement would leapfrog to it.
          if (!bumped) {
            bumped = true;
            origPrepare("UPDATE notes SET updated_at_ms = ? WHERE id = ?").run(9_000_000_000_000, bumpTarget);
          }
          return rows;
        };
      }
      return stmt;
    };

    const page = noteOps.queryNotesPaged(db, { cursor: "", limit: 100 });
    (db as any).prepare = origPrepare;

    // Positive control: the interception actually fired (guards against the
    // phase-1 SQL drifting and silently no-op'ing the test).
    expect(bumped).toBe(true);
    // The watermark reflects the PRE-bump page snapshot — the real max — NOT
    // the injected 9e12. A re-read-based watermark would encode 9e12 and skip
    // every row between trueMax and 9e12 on the next call.
    const wm = decodeCursor(page.next_cursor).last_updated_at;
    expect(wm).toBe(trueMax);
    expect(wm).not.toBe(9_000_000_000_000);
  });
});
