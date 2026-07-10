import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { parseWikilinks, syncWikilinks, resolveWikilink, resolveUnresolvedWikilinks, listUnresolvedWikilinks } from "./wikilinks.js";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe("parseWikilinks", () => {
  it("parses simple wikilinks", () => {
    const links = parseWikilinks("Check out [[My Note]] for details.");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("My Note");
    expect(links[0].embed).toBe(false);
  });

  it("parses multiple wikilinks", () => {
    const links = parseWikilinks("See [[Note A]] and [[Note B]].");
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("Note A");
    expect(links[1].target).toBe("Note B");
  });

  it("parses aliased wikilinks", () => {
    const links = parseWikilinks("See [[Real Name|display text]] here.");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Real Name");
    expect(links[0].display).toBe("display text");
  });

  it("parses heading anchors", () => {
    const links = parseWikilinks("See [[Note#Section One]].");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Note");
    expect(links[0].anchor).toBe("Section One");
  });

  it("parses block references", () => {
    const links = parseWikilinks("See [[Note#^abc123]].");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Note");
    expect(links[0].blockRef).toBe("abc123");
  });

  it("parses heading + alias combo", () => {
    const links = parseWikilinks("See [[Note#Heading|click here]].");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Note");
    expect(links[0].anchor).toBe("Heading");
    expect(links[0].display).toBe("click here");
  });

  it("parses embeds", () => {
    const links = parseWikilinks("![[My Image]]");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("My Image");
    expect(links[0].embed).toBe(true);
  });

  it("parses nested paths", () => {
    const links = parseWikilinks("See [[Projects/Parachute/README]].");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Projects/Parachute/README");
  });

  it("ignores wikilinks in code blocks", () => {
    const content = `
Some text [[Real Link]]

\`\`\`
[[Not A Link]]
\`\`\`

More text
`;
    const links = parseWikilinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Real Link");
  });

  it("ignores wikilinks in inline code", () => {
    const links = parseWikilinks("Use `[[Not A Link]]` syntax for links.");
    expect(links).toHaveLength(0);
  });

  it("handles empty content", () => {
    expect(parseWikilinks("")).toHaveLength(0);
  });

  it("handles content with no wikilinks", () => {
    expect(parseWikilinks("Just plain text.")).toHaveLength(0);
  });

  it("skips empty targets", () => {
    const links = parseWikilinks("Empty [[]] link.");
    expect(links).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("resolveWikilink", async () => {
  it("resolves exact path match", async () => {
    await store.createNote("Target note", { path: "My Note" });
    const id = resolveWikilink(db, "My Note");
    expect(id).toBeTruthy();
  });

  it("resolves case-insensitively", async () => {
    const note = await store.createNote("Target", { path: "My Note" });
    const id = resolveWikilink(db, "my note");
    expect(id).toBe(note.id);
  });

  it("resolves basename match", async () => {
    const note = await store.createNote("Deep note", { path: "Projects/Parachute/README" });
    const id = resolveWikilink(db, "README");
    expect(id).toBe(note.id);
  });

  it("returns null for ambiguous basename", async () => {
    await store.createNote("A", { path: "Folder1/README" });
    await store.createNote("B", { path: "Folder2/README" });
    const id = resolveWikilink(db, "README");
    expect(id).toBeNull();
  });

  it("returns null for unresolvable target", () => {
    const id = resolveWikilink(db, "Nonexistent Note");
    expect(id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

describe("syncWikilinks", async () => {
  it("creates links for resolved wikilinks", async () => {
    const target = await store.createNote("Target", { path: "Target Note" });
    const source = await store.createNote("See [[Target Note]]");

    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0].targetId).toBe(target.id);
    expect(links[0].relationship).toBe("wikilink");
  });

  it("tracks unresolved wikilinks", async () => {
    const source = await store.createNote("See [[Missing Note]]");

    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(0);

    // Check unresolved table
    const unresolved = db.prepare(
      "SELECT * FROM unresolved_wikilinks WHERE source_id = ?",
    ).all(source.id) as { source_id: string; target_path: string }[];
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].target_path).toBe("Missing Note");
  });

  it("resolves pending wikilinks when target note is created", async () => {
    const source = await store.createNote("See [[Future Note]]");

    // No link yet
    expect(await store.getLinks(source.id, { direction: "outbound" })).toHaveLength(0);

    // Create the target note
    const target = await store.createNote("I exist now", { path: "Future Note" });

    // Link should now exist
    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0].targetId).toBe(target.id);
  });

  it("removes links when wikilinks are removed from content", async () => {
    const target = await store.createNote("Target", { path: "Target" });
    const source = await store.createNote("See [[Target]]");

    expect(await store.getLinks(source.id, { direction: "outbound" })).toHaveLength(1);

    // Update content to remove the wikilink
    await store.updateNote(source.id, { content: "No more links here." });

    expect(await store.getLinks(source.id, { direction: "outbound" })).toHaveLength(0);
  });

  it("adds new links when wikilinks are added to content", async () => {
    const a = await store.createNote("A", { path: "Note A" });
    const b = await store.createNote("B", { path: "Note B" });
    const source = await store.createNote("See [[Note A]]");

    expect(await store.getLinks(source.id, { direction: "outbound" })).toHaveLength(1);

    // Update to add another link
    await store.updateNote(source.id, { content: "See [[Note A]] and [[Note B]]" });

    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(2);
  });

  it("does not create self-links", async () => {
    const note = await store.createNote("I link to [[Myself]]", { path: "Myself" });
    const links = await store.getLinks(note.id, { direction: "outbound" });
    expect(links.filter((l) => l.relationship === "wikilink")).toHaveLength(0);
  });

  it("deduplicates multiple mentions of same target", async () => {
    const target = await store.createNote("Target", { path: "Target" });
    const source = await store.createNote("See [[Target]] and again [[Target]]");

    const links = (await store.getLinks(source.id, { direction: "outbound" }))
      .filter((l) => l.relationship === "wikilink");
    expect(links).toHaveLength(1);
  });

  it("preserves non-wikilink links", async () => {
    const a = await store.createNote("A", { id: "a", path: "Note A" });
    const b = await store.createNote("B", { id: "b", path: "Note B" });

    // Manual semantic link
    await store.createLink("a", "b", "related-to");

    // Create note with wikilink to B
    const source = await store.createNote("See [[Note B]]", { id: "source" });

    // Update content to remove wikilink
    await store.updateNote("source", { content: "No links" });

    // Semantic link between a and b should still exist
    const links = await store.getLinks("a", { direction: "outbound" });
    expect(links.some((l) => l.relationship === "related-to")).toBe(true);
  });

  it("stores display text and anchor in link metadata", async () => {
    const target = await store.createNote("Target", { path: "Target" });
    const source = await store.createNote("See [[Target#Introduction|intro]]");

    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0].metadata?.display).toBe("intro");
    expect(links[0].metadata?.anchor).toBe("Introduction");
  });
});

// ---------------------------------------------------------------------------
// Integration with path changes
// ---------------------------------------------------------------------------

describe("path-based resolution", async () => {
  it("resolves pending links when a note gets a path", async () => {
    const source = await store.createNote("See [[Named Note]]");
    expect(await store.getLinks(source.id, { direction: "outbound" })).toHaveLength(0);

    // Create a note without a path, then give it one
    const target = await store.createNote("Unnamed");
    await store.updateNote(target.id, { path: "Named Note" });

    // The pending link should be resolved
    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0].targetId).toBe(target.id);
  });
});

// ---------------------------------------------------------------------------
// unresolved_wikilinks relationship-column migration — atomicity (vault#555
// wire+generalist must-fix; W7's migrateToV25-interruption lesson applied).
// ---------------------------------------------------------------------------

describe("ensureRelationshipColumn — crash-safe rebuild", () => {
  /**
   * Build a legacy (pre-vault#555) 2-column `unresolved_wikilinks` table with
   * pending rows, on a store whose other tables already exist. Returns the
   * source note's id (a real row so the FK is satisfiable when
   * foreign_keys is on).
   */
  async function seedLegacyTable(): Promise<string> {
    // A plain note (no wikilinks) doesn't create the v555 table.
    const src = await store.createNote("plain body, no wikilinks", { path: "src-note" });
    const tgt = await store.createNote("plain target", { path: "Target A" });
    // Hand-build the pre-v555 shape (2-column PK, no `relationship`).
    db.exec(`
      CREATE TABLE unresolved_wikilinks (
        source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        target_path TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (source_id, target_path)
      )
    `);
    db.prepare("INSERT INTO unresolved_wikilinks (source_id, target_path) VALUES (?, ?)")
      .run(src.id, "Target B");
    db.prepare("INSERT INTO unresolved_wikilinks (source_id, target_path) VALUES (?, ?)")
      .run(src.id, "Target A"); // this one resolves to tgt after the migration
    return src.id;
  }

  function hasRelationshipColumn(): boolean {
    const cols = db.prepare("PRAGMA table_info(unresolved_wikilinks)").all() as { name: string }[];
    return cols.some((c) => c.name === "relationship");
  }

  function tableExists(name: string): boolean {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
    return row !== null;
  }

  it("a crash mid-rebuild (between RENAME and CREATE) rolls back — original table + pending rows intact, no orphan _pre_v555", async () => {
    await seedLegacyTable();
    expect(hasRelationshipColumn()).toBe(false); // legacy shape confirmed
    const rowsBefore = (db.prepare("SELECT COUNT(*) AS c FROM unresolved_wikilinks").get() as { c: number }).c;
    expect(rowsBefore).toBe(2);

    // Monkey-patch db.exec to throw on the migration's CREATE — i.e. AFTER
    // the RENAME has moved the table to _pre_v555 but BEFORE the new table
    // exists. This is the exact interruption window the transaction wrapper
    // must survive. BEGIN/RENAME/ROLLBACK all pass through untouched.
    const origExec = db.exec.bind(db);
    let crashed = false;
    (db as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (!crashed && /CREATE TABLE unresolved_wikilinks \(/.test(sql)) {
        crashed = true;
        throw new Error("simulated crash between RENAME and CREATE");
      }
      return origExec(sql);
    };

    let thrown: unknown;
    try {
      // resolveUnresolvedWikilinks calls ensureRelationshipColumn first —
      // the REAL heal path, not a hand-rolled copy.
      resolveUnresolvedWikilinks(db, "Target A", "irrelevant-id");
    } catch (e) {
      thrown = e;
    } finally {
      (db as unknown as { exec: (sql: string) => unknown }).exec = origExec;
    }

    // The crash propagated (not swallowed).
    expect(crashed).toBe(true);
    expect((thrown as Error)?.message).toContain("simulated crash");

    // ROLLBACK restored the ORIGINAL table exactly:
    expect(tableExists("unresolved_wikilinks")).toBe(true); // NOT renamed away
    expect(tableExists("unresolved_wikilinks_pre_v555")).toBe(false); // no orphan
    expect(hasRelationshipColumn()).toBe(false); // still the legacy 2-col shape
    const rowsAfter = (db.prepare("SELECT COUNT(*) AS c FROM unresolved_wikilinks").get() as { c: number }).c;
    expect(rowsAfter).toBe(2); // pending rows NOT lost

    // And a clean retry (no crash) fully recovers: migration runs, column
    // added, rows preserved and backfilled as "wikilink".
    resolveUnresolvedWikilinks(db, "nothing-matches-here", "irrelevant-id-2");
    expect(hasRelationshipColumn()).toBe(true);
    expect(tableExists("unresolved_wikilinks_pre_v555")).toBe(false);
    const migratedRows = db.prepare("SELECT relationship FROM unresolved_wikilinks").all() as { relationship: string }[];
    expect(migratedRows).toHaveLength(2);
    expect(migratedRows.every((r) => r.relationship === "wikilink")).toBe(true);
  });

  it("a successful (uninterrupted) rebuild migrates + backfills as wikilink, and a pending forward-ref then resolves", async () => {
    const srcId = await seedLegacyTable();

    // Drive the heal through the real read path.
    const before = listUnresolvedWikilinks(db);
    expect(before.count).toBe(2);
    expect(hasRelationshipColumn()).toBe(true); // listUnresolvedWikilinks healed it
    expect(before.unresolved.every((u) => u.relationship === "wikilink")).toBe(true);

    // "Target A" already exists (seedLegacyTable created it) — resolving now
    // backfills the edge from the migrated pending row.
    const targetA = await store.getNoteByPath("Target A");
    const resolved = resolveUnresolvedWikilinks(db, "Target A", targetA!.id);
    expect(resolved).toBe(1);
    const links = await store.getLinks(srcId, { direction: "outbound" });
    expect(links.some((l) => l.targetId === targetA!.id && l.relationship === "wikilink")).toBe(true);
  });
});
