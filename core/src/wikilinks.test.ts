import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { parseWikilinks, syncWikilinks, resolveWikilink, resolveUnresolvedWikilinks } from "./wikilinks.js";

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
