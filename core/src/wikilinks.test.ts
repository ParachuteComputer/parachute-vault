import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import {
  parseWikilinks,
  syncWikilinks,
  resolveWikilink,
  resolveWikilinkDetailed,
  resolveUnresolvedWikilinks,
  queueUnresolvedLink,
  listUnresolvedWikilinks,
  getContentWikilinkWarnings,
  resolveOrQueueLink,
  requeueInboundWikilinksForDelete,
  getUnresolvedLinksForNote,
} from "./wikilinks.js";
import { findPath } from "./links.js";

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
// Title fallback (additive — id/path/basename still win first)
// ---------------------------------------------------------------------------

describe("resolveWikilink — title fallback", async () => {
  it("resolves via H1 title when path/basename both miss", async () => {
    const note = await store.createNote("# My Real Title\n\nSome body text.", { path: "Inbox/2026-07-10-abc123" });
    const id = resolveWikilink(db, "My Real Title");
    expect(id).toBe(note.id);
  });

  it("matches the H1 title case-insensitively", async () => {
    const note = await store.createNote("# My Real Title\n\nBody.", { path: "Inbox/xyz" });
    const id = resolveWikilink(db, "my real title");
    expect(id).toBe(note.id);
  });

  it("exact path match wins over a title match on a DIFFERENT note", async () => {
    // A note literally path-named "My Real Title" ...
    const byPath = await store.createNote("Path note body", { path: "My Real Title" });
    // ... and an unrelated note whose H1 happens to be the same string.
    await store.createNote("# My Real Title\n\nOther body.", { path: "Inbox/other" });
    const id = resolveWikilink(db, "My Real Title");
    expect(id).toBe(byPath.id);
  });

  it("basename match wins over title fallback", async () => {
    const byBasename = await store.createNote("Body", { path: "Projects/Parachute/README" });
    await store.createNote("# README\n\nOther body.", { path: "Inbox/other-readme" });
    const id = resolveWikilink(db, "README");
    expect(id).toBe(byBasename.id);
  });

  it("stays unresolved when two notes share the same H1 title (ambiguous)", async () => {
    await store.createNote("# Shared Title\n\nA.", { path: "Inbox/a" });
    await store.createNote("# Shared Title\n\nB.", { path: "Inbox/b" });
    const id = resolveWikilink(db, "Shared Title");
    expect(id).toBeNull();
  });

  it("does not fall through to title when basename is itself ambiguous", async () => {
    // Two notes share basename "README" (ambiguous at step 3) AND a third
    // note has an H1 title of "README" too — the ambiguous basename step
    // must not be rescued by the title step.
    await store.createNote("A", { path: "Folder1/README" });
    await store.createNote("B", { path: "Folder2/README" });
    await store.createNote("# README\n\nC.", { path: "Inbox/c" });
    const id = resolveWikilink(db, "README");
    expect(id).toBeNull();
  });

  it("ignores H2+ headings — only a literal single-# line counts", async () => {
    await store.createNote("## Not An H1\n\nBody.", { path: "Inbox/h2" });
    const id = resolveWikilink(db, "Not An H1");
    expect(id).toBeNull();
  });

  it("resolveWikilinkDetailed reports the title match as resolved", async () => {
    const note = await store.createNote("# Detailed Title\n\nBody.", { path: "Inbox/detail" });
    const result = resolveWikilinkDetailed(db, "Detailed Title");
    expect(result.resolved).toBe(true);
    expect(result.note_id).toBe(note.id);
    expect(result.path).toBe("Inbox/detail");
  });

  it("resolveWikilinkDetailed reports an ambiguous title match", async () => {
    await store.createNote("# Dup Title\n\nA.", { path: "Inbox/dup-a" });
    await store.createNote("# Dup Title\n\nB.", { path: "Inbox/dup-b" });
    const result = resolveWikilinkDetailed(db, "Dup Title");
    expect(result.resolved).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toHaveLength(2);
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

  it("creates a link via the title fallback when path/basename miss", async () => {
    const target = await store.createNote("# Weekly Review\n\nBody.", { path: "Inbox/2026-07-10-abc123" });
    const source = await store.createNote("See [[Weekly Review]]");

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

  // vault#570 — an ambiguous target (≥2 notes share the same basename/
  // title) must be reported distinctly from a genuine miss, via
  // `syncWikilinks`'s `ambiguous` array, and must NOT be linked or queued
  // into `unresolved_wikilinks` (queuing implies "wait for this to be
  // created", which doesn't describe an already-existing ambiguity).
  it("returns ambiguous targets separately from unresolved, creates no link, and does not queue them", async () => {
    const a = await store.createNote("A", { path: "Folder1/Dup" });
    const b = await store.createNote("B", { path: "Folder2/Dup" });
    // Empty content on create so the note exists (satisfying the
    // `unresolved_wikilinks` FK) without triggering `syncWikilinks` yet —
    // the manual call below is what's under test, and its return value
    // isn't otherwise observable through the Store API.
    const source = await store.createNote("");

    const content = "See [[Dup]] and also [[Truly Missing]]";
    const result = syncWikilinks(db, source.id, content);
    expect(result.added).toBe(0);
    expect(result.unresolved).toEqual(["Truly Missing"]);
    expect(result.ambiguous).toEqual([{ target: "Dup", count: 2 }]);

    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links.some((l) => l.targetId === a.id || l.targetId === b.id)).toBe(false);

    const pending = db.prepare(
      "SELECT target_path FROM unresolved_wikilinks WHERE source_id = ?",
    ).all(source.id) as { target_path: string }[];
    // Only the genuinely-missing target is queued — "Dup" is absent.
    expect(pending.map((r) => r.target_path)).toEqual(["Truly Missing"]);
  });
});

// ---------------------------------------------------------------------------
// getContentWikilinkWarnings (vault#570) — read-only warning derivation
// ---------------------------------------------------------------------------

describe("getContentWikilinkWarnings", () => {
  it("returns an unresolved_link warning for a content wikilink to a missing target", async () => {
    const source = await store.createNote("See [[Nowhere]]");
    const warnings = getContentWikilinkWarnings(db, source.id, "See [[Nowhere]]");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("unresolved_link");
    expect(warnings[0]!.target).toBe("Nowhere");
    expect(warnings[0]!.relationship).toBe("wikilink");
  });

  it("returns an ambiguous_link warning (with candidate_count) for a content wikilink matching 2 notes", async () => {
    await store.createNote("A", { path: "Folder1/Same" });
    await store.createNote("B", { path: "Folder2/Same" });
    const source = await store.createNote("See [[Same]]");
    const warnings = getContentWikilinkWarnings(db, source.id, "See [[Same]]");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("ambiguous_link");
    expect(warnings[0]!.target).toBe("Same");
    expect(warnings[0]!.candidate_count).toBe(2);
  });

  it("returns no warnings for a resolved wikilink, including a self-link", async () => {
    const target = await store.createNote("Target", { path: "Resolvable" });
    const source = await store.createNote("See [[Resolvable]]", { path: "Myself Again" });
    expect(getContentWikilinkWarnings(db, source.id, "See [[Resolvable]]")).toEqual([]);
    expect(getContentWikilinkWarnings(db, source.id, "See [[Myself Again]]")).toEqual([]);
    void target;
  });

  it("returns no warnings when content has no wikilinks", () => {
    expect(getContentWikilinkWarnings(db, "some-id", "plain text, no brackets")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveOrQueueLink (vault#555 + vault#570) — discriminated outcome
// ---------------------------------------------------------------------------

describe("resolveOrQueueLink", () => {
  it("returns {status: 'resolved', note_id} for a resolvable target", async () => {
    const target = await store.createNote("Target", { path: "Findable" });
    const source = await store.createNote("source");
    const outcome = resolveOrQueueLink(db, source.id, "Findable", "knows");
    expect(outcome.status).toBe("resolved");
    if (outcome.status === "resolved") expect(outcome.note_id).toBe(target.id);
  });

  it("returns {status: 'queued'} and queues the pending row for a genuinely missing target", async () => {
    const source = await store.createNote("source");
    const outcome = resolveOrQueueLink(db, source.id, "Not There", "knows");
    expect(outcome.status).toBe("queued");
    const pending = db.prepare(
      "SELECT target_path, relationship FROM unresolved_wikilinks WHERE source_id = ?",
    ).all(source.id) as { target_path: string; relationship: string }[];
    expect(pending).toEqual([{ target_path: "Not There", relationship: "knows" }]);
  });

  it("returns {status: 'ambiguous', candidates} and does NOT queue for a target matching 2 notes", async () => {
    const a = await store.createNote("A", { path: "Folder1/Twice" });
    const b = await store.createNote("B", { path: "Folder2/Twice" });
    const source = await store.createNote("source");
    const outcome = resolveOrQueueLink(db, source.id, "Twice", "knows");
    expect(outcome.status).toBe("ambiguous");
    if (outcome.status === "ambiguous") {
      expect(outcome.candidates.map((c) => c.note_id).sort()).toEqual([a.id, b.id].sort());
    }
    const tableExists = (db.prepare("PRAGMA table_info(unresolved_wikilinks)").all() as unknown[]).length > 0;
    if (tableExists) {
      const pending = db.prepare(
        "SELECT * FROM unresolved_wikilinks WHERE source_id = ?",
      ).all(source.id) as unknown[];
      expect(pending).toHaveLength(0);
    }
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
// requeueInboundWikilinksForDelete (LB6) — a deleted note's inbound wikilink
// edges must re-queue so recreating a note at the same path/title heals
// them, instead of staying dead until the SOURCE note is individually
// re-saved.
// ---------------------------------------------------------------------------

describe("delete → recreate re-resolves inbound wikilinks (LB6)", () => {
  it("A [[Foo]] survives Foo's delete-then-recreate without touching A", async () => {
    const a = await store.createNote("Link to [[Foo]]", { path: "A" });

    // Foo doesn't exist yet — the link is queued, not yet live.
    expect(await store.getLinks(a.id, { direction: "outbound" })).toHaveLength(0);
    const pendingBefore = db.prepare(
      "SELECT target_path FROM unresolved_wikilinks WHERE source_id = ?",
    ).all(a.id) as { target_path: string }[];
    expect(pendingBefore.map((r) => r.target_path)).toEqual(["Foo"]);

    // Create Foo — the wikilink resolves and the edge + backlink exist.
    const foo1 = await store.createNote("First Foo", { path: "Foo" });
    let links = await store.getLinks(a.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0]!.targetId).toBe(foo1.id);
    expect(findPath(db, a.id, foo1.id)).not.toBeNull();
    const backlinks = await store.getLinks(foo1.id, { direction: "inbound" });
    expect(backlinks.some((l) => l.sourceId === a.id)).toBe(true);

    // Delete Foo. Without the LB6 fix, `unresolved_wikilinks` stays empty —
    // nothing pending — even though A's `[[Foo]]` text is untouched.
    await store.deleteNote(foo1.id);
    expect(await store.getLinks(a.id, { direction: "outbound" })).toHaveLength(0);
    const pendingAfterDelete = db.prepare(
      "SELECT target_path, relationship FROM unresolved_wikilinks WHERE source_id = ?",
    ).all(a.id) as { target_path: string; relationship: string }[];
    expect(pendingAfterDelete).toEqual([{ target_path: "Foo", relationship: "wikilink" }]);

    // Recreate Foo (new note, new id — same path). A was never re-saved.
    const foo2 = await store.createNote("Second Foo", { path: "Foo" });

    // The A -> Foo edge is back, pointed at the NEW Foo, and find-path sees it.
    links = await store.getLinks(a.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0]!.targetId).toBe(foo2.id);
    expect(links[0]!.relationship).toBe("wikilink");
    expect(findPath(db, a.id, foo2.id)).not.toBeNull();

    // A's content was never touched.
    const reread = await store.getNote(a.id);
    expect(reread!.content).toBe("Link to [[Foo]]");

    // The pending row is consumed on resolution.
    const pendingAfterRecreate = db.prepare(
      "SELECT * FROM unresolved_wikilinks WHERE source_id = ?",
    ).all(a.id);
    expect(pendingAfterRecreate).toHaveLength(0);
  });

  it("only re-queues wikilink-relationship inbound edges, not explicit typed links", async () => {
    const source = await store.createNote("A", { id: "src", path: "Src" });
    const target = await store.createNote("B", { id: "tgt", path: "Tgt" });
    await store.createLink("src", "tgt", "related-to"); // hand-authored typed link, not a wikilink

    requeueInboundWikilinksForDelete(db, target.id);

    // getUnresolvedLinksForNote tolerates the table not existing at all
    // (no wikilink was ever parsed in this test) — a raw SELECT would throw.
    expect(getUnresolvedLinksForNote(db, source.id)).toHaveLength(0);
  });

  it("re-queues via basename resolution, not just exact path, and recovers on recreate at the same path", async () => {
    // Target lives at a nested path; source links via the bare basename —
    // resolved through resolveWikilink's basename fallback (rule #3), not
    // an exact path match.
    const target = await store.createNote("# Weekly Review\n\nBody.", { path: "Projects/Weekly Review" });
    const source = await store.createNote("See [[Weekly Review]]", { path: "A" });
    expect(await store.getLinks(source.id, { direction: "outbound" })).toHaveLength(1);

    await store.deleteNote(target.id);

    const pending = db.prepare(
      "SELECT target_path FROM unresolved_wikilinks WHERE source_id = ?",
    ).all(source.id) as { target_path: string }[];
    // The re-queued key is the RAW bracket text ("Weekly Review"), not the
    // deleted note's full path — that's what the basename-fallback lazy
    // resolver (`resolveUnresolvedWikilinks`'s `? LIKE '%/' || target_path`
    // suffix match) actually matches on.
    expect(pending.map((r) => r.target_path)).toEqual(["Weekly Review"]);

    // Recreate at the SAME nested path — the suffix match backfills it.
    const target2 = await store.createNote("# Weekly Review v2\n\nBody.", { path: "Projects/Weekly Review" });
    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0]!.targetId).toBe(target2.id);
  });

  // BLOCKER (Fable review) — the delete→recreate re-heal must cover links
  // that resolved via the H1-TITLE fallback and the explicit-EXTENSION form,
  // not just path/basename. The re-queued row's target string is the raw
  // bracket text (e.g. "John Doe" / "budget.csv"), which the OLD sweep
  // matched against the new note by PATH TEXT ONLY — so a title- or
  // extension-resolved link stayed queued (0 links rebuilt) forever. The
  // sweep now runs each candidate through the SAME resolver write-time uses,
  // so deferred resolution finally matches write-time on all four legs.
  it("re-heals a TITLE-fallback link AND an EXTENSION-form link on delete→recreate at the same path+H1", async () => {
    // A resolves to `people/jdoe` only via its H1 title "John Doe".
    // B resolves to `budget` (ext csv) only via the explicit [[budget.csv]]
    // form (the extension leg is exact-path, so `budget` lives at path
    // "budget", disambiguating it from a same-named `.md` note).
    const person = await store.createNote("# John Doe\n\nBio.", { path: "people/jdoe" });
    const budget = await store.createNote("month,total\n2026-01,9000", { path: "budget", extension: "csv" });
    const a = await store.createNote("met [[John Doe]] today", { path: "A" });
    const b = await store.createNote("see [[budget.csv]]", { path: "B" });

    // Both links live at write time (title fallback + extension form).
    expect((await store.getLinks(a.id, { direction: "outbound" }))[0]?.targetId).toBe(person.id);
    expect((await store.getLinks(b.id, { direction: "outbound" }))[0]?.targetId).toBe(budget.id);

    await store.deleteNote(person.id);
    await store.deleteNote(budget.id);

    // Both re-queued with their raw bracket text — NOT the deleted notes' paths.
    const pendingA = db.prepare("SELECT target_path FROM unresolved_wikilinks WHERE source_id = ?").all(a.id) as { target_path: string }[];
    const pendingB = db.prepare("SELECT target_path FROM unresolved_wikilinks WHERE source_id = ?").all(b.id) as { target_path: string }[];
    expect(pendingA.map((r) => r.target_path)).toEqual(["John Doe"]);
    expect(pendingB.map((r) => r.target_path)).toEqual(["budget.csv"]);
    expect(await store.getLinks(a.id, { direction: "outbound" })).toHaveLength(0);
    expect(await store.getLinks(b.id, { direction: "outbound" })).toHaveLength(0);

    // Recreate each at the SAME path + H1 (new note, new id). Neither A nor B
    // is re-saved — only the deferred sweep can rebuild these edges.
    const person2 = await store.createNote("# John Doe\n\nBio v2.", { path: "people/jdoe" });
    const budget2 = await store.createNote("month,total\n2026-02,9500", { path: "budget", extension: "csv" });

    // BOTH re-heal (RED before the sweep completion — title/ext legs missing).
    const aLinks = await store.getLinks(a.id, { direction: "outbound" });
    const bLinks = await store.getLinks(b.id, { direction: "outbound" });
    expect(aLinks).toHaveLength(1);
    expect(aLinks[0]!.targetId).toBe(person2.id);
    expect(findPath(db, a.id, person2.id)).not.toBeNull();
    expect(bLinks).toHaveLength(1);
    expect(bLinks[0]!.targetId).toBe(budget2.id);

    // Pending rows consumed on resolution.
    expect(getUnresolvedLinksForNote(db, a.id)).toHaveLength(0);
    expect(getUnresolvedLinksForNote(db, b.id)).toHaveLength(0);
  });

  it("re-heals a non-ASCII title that differs only in case (vault#589 COLLATE NOCASE is ASCII-only)", async () => {
    const source = await store.createNote("see [[CAFÉ]]", { path: "A" });
    expect(getUnresolvedLinksForNote(db, source.id).map((r) => r.target_path ?? r.target)).toEqual(["CAFÉ"]);
    expect(await store.getLinks(source.id, { direction: "outbound" })).toHaveLength(0);

    const target = await store.createNote("# café\n\nbody", { path: "people/cafe" });
    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0]!.targetId).toBe(target.id);
    expect(getUnresolvedLinksForNote(db, source.id)).toHaveLength(0);
  });

  // The completed sweep must NOT mis-resolve an AMBIGUOUS target — matching
  // write-time's "don't guess" contract. A pending [[John Doe]] is swept when
  // a same-titled note is created; if TWO notes already share that H1 by the
  // time the sweep verifies, the resolver returns ambiguous and the row stays
  // queued rather than the old path-only sweep's "link to whoever showed up."
  // (Reached via a pathless first note — the sweep is path-gated, so it never
  // fired to consume the row when only ONE John Doe existed.)
  it("does not re-heal a title link when the target is ambiguous (two notes share the H1)", async () => {
    const a = await store.createNote("met [[John Doe]]", { path: "A" });
    expect(getUnresolvedLinksForNote(db, a.id).map((l) => l.target)).toEqual(["John Doe"]); // queued, no John Doe yet

    // A PATHLESS note carrying the H1 — createNote's sweep is path-gated, so
    // it does NOT fire here; A's pending row survives with one John Doe extant.
    await store.createNote("# John Doe\n\nfirst.");
    expect(getUnresolvedLinksForNote(db, a.id).map((l) => l.target)).toEqual(["John Doe"]); // still queued

    // A SECOND note with the same H1, WITH a path → the sweep fires. Now two
    // notes carry "John Doe" → resolveWikilinkDetailed is ambiguous → the row
    // is left queued, nothing linked.
    await store.createNote("# John Doe\n\nsecond.", { path: "people/jd" });
    expect(await store.getLinks(a.id, { direction: "outbound" })).toHaveLength(0);
    expect(getUnresolvedLinksForNote(db, a.id).map((l) => l.target)).toEqual(["John Doe"]);
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

describe("deferred resolution — ID leg (vault#591)", () => {
  it("heals an ID-valued pending row when the target note is later created", async () => {
    const source = await store.createNote("src", { path: "Src" });
    const futureId = "tgt-id-591";
    queueUnresolvedLink(db, source.id, futureId, "reference");
    expect(await store.getLinks(source.id, { direction: "outbound" })).toHaveLength(0);

    const target = await store.createNote("tgt", { id: futureId, path: "Tgt" });
    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0]!.targetId).toBe(target.id);
    expect(links[0]!.relationship).toBe("reference");
    expect(getUnresolvedLinksForNote(db, source.id)).toHaveLength(0);
  });
});
