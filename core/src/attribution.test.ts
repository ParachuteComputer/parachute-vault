/**
 * Write-attribution (vault#298) — per-identity (`*_by`) + per-interface
 * (`*_via`) provenance at the store layer.
 *
 * Covers the core contract:
 *   - create stamps BOTH axes onto created_* AND mirrors into last_updated_*
 *   - update bumps ONLY last_updated_* (created_* is set-once)
 *   - a `skipUpdatedAt` machine write does NOT claim authorship
 *   - no-attribution writes leave the columns NULL (never "")
 *   - the four query-notes filters (created_by / last_updated_by /
 *     created_via / last_updated_via)
 *   - legacy rows written before the v23 migration stay NULL and don't crash
 *   - the cursor binds the attribution filters (changing them invalidates it)
 *
 * The auth → AuthResult → MCP/REST threading is exercised separately in
 * src/attribution-threading.test.ts (it needs the server-side auth context).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { initSchema, SCHEMA_VERSION } from "./schema.js";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

function rawRow(id: string) {
  return db
    .prepare(
      "SELECT created_by, created_via, last_updated_by, last_updated_via FROM notes WHERE id = ?",
    )
    .get(id) as {
    created_by: string | null;
    created_via: string | null;
    last_updated_by: string | null;
    last_updated_via: string | null;
  };
}

describe("write-attribution — schema", () => {
  it("bumped SCHEMA_VERSION to at least 23 (write-attribution columns landed)", () => {
    // Was a literal `toBe(23)` pin — that goes stale every time a later PR
    // bumps SCHEMA_VERSION further (vault#553 bumped it to 24). This test's
    // actual claim is "the write-attribution migration landed at/after v23",
    // not "v23 is still current."
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(23);
  });

  it("the four columns exist and are indexed", () => {
    const cols = (db.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toContain("created_by");
    expect(cols).toContain("created_via");
    expect(cols).toContain("last_updated_by");
    expect(cols).toContain("last_updated_via");

    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notes'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toContain("idx_notes_created_by");
    expect(idx).toContain("idx_notes_created_via");
    expect(idx).toContain("idx_notes_last_updated_by");
    expect(idx).toContain("idx_notes_last_updated_via");
  });
});

describe("write-attribution — per-identity (WHO) + per-interface (VIA)", () => {
  it("create captures actor + via on BOTH the created_* and last_updated_* pairs", async () => {
    const note = await store.createNote("hi", { actor: "aaron", via: "mcp" });
    // Read-model surfaces both axes.
    expect(note.createdBy).toBe("aaron");
    expect(note.createdVia).toBe("mcp");
    // First write IS the most-recent write — mirrored.
    expect(note.lastUpdatedBy).toBe("aaron");
    expect(note.lastUpdatedVia).toBe("mcp");

    const row = rawRow(note.id);
    expect(row.created_by).toBe("aaron");
    expect(row.created_via).toBe("mcp");
    expect(row.last_updated_by).toBe("aaron");
    expect(row.last_updated_via).toBe("mcp");
  });

  it("update bumps last_updated_* but leaves created_* untouched (set-once)", async () => {
    const note = await store.createNote("v1", { actor: "aaron", via: "mcp" });
    const updated = await store.updateNote(note.id, {
      content: "v2",
      actor: "mathilda",
      via: "surface:meeting-ingest",
    });

    // created_* pins the ORIGINAL author/channel forever.
    expect(updated.createdBy).toBe("aaron");
    expect(updated.createdVia).toBe("mcp");
    // last_updated_* reflects the most recent writer.
    expect(updated.lastUpdatedBy).toBe("mathilda");
    expect(updated.lastUpdatedVia).toBe("surface:meeting-ingest");

    const row = rawRow(note.id);
    expect(row.created_by).toBe("aaron");
    expect(row.last_updated_by).toBe("mathilda");
    expect(row.last_updated_via).toBe("surface:meeting-ingest");
  });

  it("append/prepend updates also record the most-recent author", async () => {
    const note = await store.createNote("base", { actor: "aaron", via: "mcp" });
    const after = await store.updateNote(note.id, {
      append: " +more",
      actor: "agent:nightly",
      via: "agent:nightly",
    });
    expect(after.content).toBe("base +more");
    expect(after.createdBy).toBe("aaron");
    expect(after.lastUpdatedBy).toBe("agent:nightly");
    expect(after.lastUpdatedVia).toBe("agent:nightly");
  });

  it("a skipUpdatedAt machine write does NOT claim authorship", async () => {
    const note = await store.createNote("x", { actor: "aaron", via: "mcp" });
    const before = rawRow(note.id);
    // A hook-style marker write: passes actor/via but skipUpdatedAt — should
    // not bump updated_at NOR rewrite last_updated_*.
    await store.updateNote(note.id, {
      metadata: { marker: true },
      skipUpdatedAt: true,
      actor: "some-hook",
      via: "operator",
    });
    const after = rawRow(note.id);
    expect(after.last_updated_by).toBe(before.last_updated_by); // still "aaron"
    expect(after.last_updated_by).toBe("aaron");
    expect(after.last_updated_via).toBe("mcp");
  });

  it("an attribution-less update honestly clears the most-recent author (NULL, not stale)", async () => {
    const note = await store.createNote("x", { actor: "aaron", via: "mcp" });
    // A real edit arriving with no attribution context — the latest writer is
    // unknown; we must NOT leave "aaron" as the apparent last editor.
    const after = await store.updateNote(note.id, { content: "y" });
    expect(after.createdBy).toBe("aaron"); // original author preserved
    expect(after.lastUpdatedBy).toBeNull();
    expect(after.lastUpdatedVia).toBeNull();
  });
});

describe("write-attribution — no context → NULL (never empty string)", () => {
  it("create without actor/via leaves all four columns NULL", async () => {
    const note = await store.createNote("anon");
    const row = rawRow(note.id);
    expect(row.created_by).toBeNull();
    expect(row.created_via).toBeNull();
    expect(row.last_updated_by).toBeNull();
    expect(row.last_updated_via).toBeNull();
    expect(note.createdBy).toBeNull();
    expect(note.createdVia).toBeNull();
  });

  it("empty / whitespace-only actor/via normalize to NULL", async () => {
    const note = await store.createNote("e", { actor: "   ", via: "" });
    const row = rawRow(note.id);
    expect(row.created_by).toBeNull();
    expect(row.created_via).toBeNull();
  });
});

describe("write-attribution — query filters", () => {
  beforeEach(async () => {
    await store.createNote("a", { actor: "aaron", via: "mcp" });
    await store.createNote("b", { actor: "mathilda", via: "surface:meeting-ingest" });
    const c = await store.createNote("c", { actor: "aaron", via: "api" });
    // c's most-recent write is by the nightly agent via mcp.
    await store.updateNote(c.id, { content: "c2", actor: "agent:nightly", via: "mcp" });
    await store.createNote("legacy"); // no attribution
  });

  it("created_by selects only that principal's CREATED notes", async () => {
    const aaron = await store.queryNotes({ createdBy: "aaron" });
    expect(aaron.map((n) => n.content).sort()).toEqual(["a", "c2"]);
  });

  it("last_updated_by selects by MOST-RECENT author (agent's edit on c)", async () => {
    const byAgent = await store.queryNotes({ lastUpdatedBy: "agent:nightly" });
    expect(byAgent.map((n) => n.content)).toEqual(["c2"]);
    // aaron created c but is no longer its last editor.
    const aaronLatest = await store.queryNotes({ lastUpdatedBy: "aaron" });
    expect(aaronLatest.map((n) => n.content)).toEqual(["a"]);
  });

  it("created_via / last_updated_via filter on the interface axis", async () => {
    const viaSurface = await store.queryNotes({ createdVia: "surface:meeting-ingest" });
    expect(viaSurface.map((n) => n.content)).toEqual(["b"]);
    const lastViaMcp = await store.queryNotes({ lastUpdatedVia: "mcp" });
    // "a" (created via mcp, never updated) + "c2" (last updated via mcp).
    expect(lastViaMcp.map((n) => n.content).sort()).toEqual(["a", "c2"]);
  });

  it("an attribution filter never matches legacy/unattributed (NULL) rows", async () => {
    const any = await store.queryNotes({ createdBy: "aaron" });
    expect(any.some((n) => n.content === "legacy")).toBe(false);
  });
});

describe("write-attribution — legacy backfill (v23 migration)", () => {
  it("a pre-v23 vault: existing rows stay NULL, new rows attribute, no crash", () => {
    // Build a v22-shaped notes table by hand (no attribution columns) +
    // schema_version row, then run initSchema to drive the v23 migration.
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        content TEXT DEFAULT '',
        path TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT,
        extension TEXT NOT NULL DEFAULT 'md'
      );
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
      INSERT INTO schema_version (version, applied_at) VALUES (22, '2026-01-01T00:00:00.000Z');
      INSERT INTO notes (id, content, created_at, updated_at)
        VALUES ('old-1', 'pre-existing', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    // Should migrate without throwing.
    initSchema(legacy);

    const ver = (legacy.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
      v: number;
    }).v;
    // A v22 vault runs the WHOLE migration chain (v23 write-attribution +
    // whatever landed after — v24's typed-index poison scan, vault#553),
    // ending at the current SCHEMA_VERSION rather than a hardcoded literal
    // that goes stale on every later bump.
    expect(ver).toBe(SCHEMA_VERSION);

    // Legacy row: attribution columns exist now but are NULL (not fabricated).
    const old = legacy
      .prepare("SELECT created_by, last_updated_by, created_via FROM notes WHERE id = ?")
      .get("old-1") as { created_by: string | null; last_updated_by: string | null; created_via: string | null };
    expect(old.created_by).toBeNull();
    expect(old.last_updated_by).toBeNull();
    expect(old.created_via).toBeNull();

    // A NEW write on the migrated DB attributes correctly.
    const migratedStore = new SqliteStore(legacy);
    return migratedStore.createNote("fresh", { actor: "aaron", via: "mcp" }).then((n) => {
      expect(n.createdBy).toBe("aaron");
      expect(n.createdVia).toBe("mcp");
      // The legacy row is still NULL and still queryable.
      return migratedStore.queryNotes({ createdBy: "aaron" }).then((res) => {
        expect(res.map((x) => x.content)).toEqual(["fresh"]);
      });
    });
  });

  it("re-running the v23 migration is idempotent (no duplicate-column error)", () => {
    const again = new Database(":memory:");
    const s = new SqliteStore(again); // runs migrations once
    initSchema(again); // run again — must not throw
    expect(() => s.createNote("ok", { actor: "x", via: "api" })).not.toThrow();
  });
});

describe("write-attribution — cursor binding", () => {
  it("changing an attribution filter between cursor polls invalidates the cursor", async () => {
    await store.createNote("a", { actor: "aaron", via: "mcp" });
    const page = await store.queryNotesPaged({ createdBy: "aaron" });
    // Reusing the cursor under a DIFFERENT createdBy must be rejected, not
    // silently continue aaron's watermark.
    await expect(
      store.queryNotesPaged({ createdBy: "mathilda", cursor: page.next_cursor }),
    ).rejects.toThrow(/different query/i);
  });
});
