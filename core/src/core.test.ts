import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

// ---- Notes CRUD ----

describe("notes", () => {
  it("creates a note", () => {
    const note = store.createNote("Morning walk");
    expect(note.content).toBe("Morning walk");
    expect(note.id).toBeTruthy();
    expect(note.createdAt).toBeTruthy();
  });

  it("creates a note with custom id", () => {
    const note = store.createNote("Test", { id: "custom-id" });
    expect(note.id).toBe("custom-id");
  });

  it("creates a note with path", () => {
    const note = store.createNote("# Grocery List", { path: "Grocery List" });
    expect(note.path).toBe("Grocery List");
  });

  it("creates a note with tags", () => {
    const note = store.createNote("Voice memo", { tags: ["daily", "voice"] });
    expect(note.tags).toContain("daily");
    expect(note.tags).toContain("voice");
  });

  it("gets a note by id", () => {
    const created = store.createNote("Test");
    const found = store.getNote(created.id);
    expect(found).toBeTruthy();
    expect(found!.id).toBe(created.id);
    expect(found!.content).toBe("Test");
  });

  it("returns null for missing note", () => {
    expect(store.getNote("nonexistent")).toBeNull();
  });

  it("updates note content", () => {
    const note = store.createNote("Original");
    const updated = store.updateNote(note.id, { content: "Updated" });
    expect(updated.content).toBe("Updated");
    expect(updated.updatedAt).toBeTruthy();
  });

  it("updates note path", () => {
    const note = store.createNote("Test");
    const updated = store.updateNote(note.id, { path: "Notes/Test" });
    expect(updated.path).toBe("Notes/Test");
  });

  it("updates created_at", () => {
    const note = store.createNote("Test");
    const newDate = "2025-01-15T12:00:00.000Z";
    const updated = store.updateNote(note.id, { created_at: newDate });
    expect(updated.createdAt).toBe(newDate);
    expect(updated.content).toBe("Test"); // content unchanged
    expect(updated.updatedAt).not.toBe(note.updatedAt); // updated_at bumped
  });

  it("updates metadata and created_at together", () => {
    const note = store.createNote("Test");
    const newDate = "2025-06-30T23:59:59.000Z";
    const meta = { source: "import", version: 2 };
    const updated = store.updateNote(note.id, { metadata: meta, created_at: newDate });
    expect(updated.createdAt).toBe(newDate);
    expect(updated.metadata).toEqual(meta);
    expect(updated.content).toBe("Test");
  });

  it("leaves created_at unchanged when not provided", () => {
    const note = store.createNote("Test");
    const updated = store.updateNote(note.id, { content: "Updated" });
    expect(updated.createdAt).toBe(note.createdAt);
  });

  it("deletes a note", () => {
    const note = store.createNote("Delete me");
    store.deleteNote(note.id);
    expect(store.getNote(note.id)).toBeNull();
  });

  it("cascade deletes tags and links", () => {
    store.createNote("A", { id: "a", tags: ["daily"] });
    store.createNote("B", { id: "b" });
    store.createLink("a", "b", "mentions");

    store.deleteNote("a");
    expect(store.getLinks("b")).toHaveLength(0);
  });
});

// ---- Tags ----

describe("tags", () => {
  it("starts with no tags", () => {
    const tags = store.listTags();
    expect(tags).toHaveLength(0);
  });

  it("tags a note", () => {
    const note = store.createNote("Test");
    store.tagNote(note.id, ["daily", "voice"]);
    const found = store.getNote(note.id);
    expect(found!.tags).toContain("daily");
    expect(found!.tags).toContain("voice");
  });

  it("untags a note", () => {
    const note = store.createNote("Test", { tags: ["daily", "voice"] });
    store.untagNote(note.id, ["voice"]);
    const found = store.getNote(note.id);
    expect(found!.tags).toContain("daily");
    expect(found!.tags).not.toContain("voice");
  });

  it("creates tags automatically", () => {
    const note = store.createNote("Test");
    store.tagNote(note.id, ["custom-tag"]);
    const tags = store.listTags();
    expect(tags.some((t) => t.name === "custom-tag")).toBe(true);
  });

  it("counts tag usage", () => {
    store.createNote("A", { tags: ["daily"] });
    store.createNote("B", { tags: ["daily"] });
    store.createNote("C", { tags: ["doc"] });

    const tags = store.listTags();
    const daily = tags.find((t) => t.name === "daily");
    expect(daily!.count).toBe(2);
  });

  it("tagging is idempotent", () => {
    const note = store.createNote("Test", { tags: ["daily"] });
    store.tagNote(note.id, ["daily"]); // duplicate
    const found = store.getNote(note.id);
    expect(found!.tags!.filter((t) => t === "daily")).toHaveLength(1);
  });
});

// ---- Vault Stats ----

describe("vault stats", () => {
  it("handles empty vault gracefully", () => {
    const stats = store.getVaultStats();
    expect(stats.totalNotes).toBe(0);
    expect(stats.earliestNote).toBeNull();
    expect(stats.latestNote).toBeNull();
    expect(stats.notesByMonth).toEqual([]);
    expect(stats.topTags).toEqual([]);
    expect(stats.tagCount).toBe(0);
  });

  it("counts total notes and tagCount", () => {
    store.createNote("A", { tags: ["daily", "voice"] });
    store.createNote("B", { tags: ["daily"] });
    store.createNote("C");

    const stats = store.getVaultStats();
    expect(stats.totalNotes).toBe(3);
    expect(stats.tagCount).toBe(2); // "daily" and "voice"
  });

  it("reports earliest and latest notes correctly", () => {
    store.createNote("oldest", { id: "n1", created_at: "2025-01-15T10:00:00.000Z" });
    store.createNote("middle", { id: "n2", created_at: "2025-06-20T10:00:00.000Z" });
    store.createNote("newest", { id: "n3", created_at: "2026-03-01T10:00:00.000Z" });

    const stats = store.getVaultStats();
    expect(stats.earliestNote).toEqual({ id: "n1", createdAt: "2025-01-15T10:00:00.000Z" });
    expect(stats.latestNote).toEqual({ id: "n3", createdAt: "2026-03-01T10:00:00.000Z" });
  });

  it("groups notes by month across all present months", () => {
    store.createNote("a", { created_at: "2025-02-28T12:00:00.000Z" });
    store.createNote("b", { created_at: "2025-03-01T08:00:00.000Z" });
    store.createNote("c", { created_at: "2025-03-15T09:00:00.000Z" });
    store.createNote("d", { created_at: "2025-03-20T11:00:00.000Z" });
    store.createNote("e", { created_at: "2026-01-10T10:00:00.000Z" });

    const stats = store.getVaultStats();
    expect(stats.notesByMonth).toEqual([
      { month: "2025-02", count: 1 },
      { month: "2025-03", count: 3 },
      { month: "2026-01", count: 1 },
    ]);
  });

  it("returns topTags ordered by count desc, capped", () => {
    // Create notes with varying tag frequencies
    for (let i = 0; i < 5; i++) store.createNote(`captured-${i}`, { tags: ["captured"] });
    for (let i = 0; i < 3; i++) store.createNote(`reader-${i}`, { tags: ["reader"] });
    store.createNote("one", { tags: ["rare"] });

    const stats = store.getVaultStats();
    expect(stats.topTags[0]).toEqual({ tag: "captured", count: 5 });
    expect(stats.topTags[1]).toEqual({ tag: "reader", count: 3 });
    expect(stats.topTags[2]).toEqual({ tag: "rare", count: 1 });
  });

  it("caps topTags at the requested limit", () => {
    // 25 distinct tags, one per note
    for (let i = 0; i < 25; i++) {
      store.createNote(`n-${i}`, { tags: [`tag-${String(i).padStart(2, "0")}`] });
    }
    const stats = store.getVaultStats({ topTagsLimit: 20 });
    expect(stats.topTags).toHaveLength(20);
    expect(stats.tagCount).toBe(25);
  });

  it("response shape is complete", () => {
    store.createNote("hello", { tags: ["a"] });
    const stats = store.getVaultStats();
    expect(stats).toHaveProperty("totalNotes");
    expect(stats).toHaveProperty("earliestNote");
    expect(stats).toHaveProperty("latestNote");
    expect(stats).toHaveProperty("notesByMonth");
    expect(stats).toHaveProperty("topTags");
    expect(stats).toHaveProperty("tagCount");
  });

  it("getVaultStats returns correct stats", () => {
    store.createNote("one", { tags: ["x"], created_at: "2025-05-01T00:00:00.000Z" });
    store.createNote("two", { tags: ["x", "y"], created_at: "2025-06-01T00:00:00.000Z" });

    const result = store.getVaultStats();
    expect(result.totalNotes).toBe(2);
    expect(result.tagCount).toBe(2);
    expect(result.topTags[0].tag).toBe("x");
    expect(result.topTags[0].count).toBe(2);
    expect(result.notesByMonth).toHaveLength(2);
    expect(result.earliestNote!.createdAt).toBe("2025-05-01T00:00:00.000Z");
    expect(result.latestNote!.createdAt).toBe("2025-06-01T00:00:00.000Z");
  });
});

// ---- Query ----

describe("queryNotes", () => {
  it("queries by tag", () => {
    store.createNote("Daily 1", { tags: ["daily"] });
    store.createNote("Doc 1", { tags: ["doc"] });

    const results = store.queryNotes({ tags: ["daily"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Daily 1");
  });

  it("queries by multiple tags (AND)", () => {
    store.createNote("Voice daily", { tags: ["daily", "voice"] });
    store.createNote("Text daily", { tags: ["daily"] });

    const results = store.queryNotes({ tags: ["daily", "voice"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Voice daily");
  });

  it("queries by multiple tags (OR)", () => {
    store.createNote("Voice daily", { tags: ["daily", "voice"] });
    store.createNote("Text daily", { tags: ["daily"] });
    store.createNote("A doc", { tags: ["doc"] });

    const results = store.queryNotes({ tags: ["voice", "doc"], tagMatch: "any" });
    expect(results).toHaveLength(2);
    const contents = results.map((n) => n.content).sort();
    expect(contents).toEqual(["A doc", "Voice daily"]);
  });

  it("excludes tags", () => {
    store.createNote("Active", { tags: ["digest"] });
    store.createNote("Archived", { tags: ["digest", "archived"] });

    const results = store.queryNotes({ tags: ["digest"], excludeTags: ["archived"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Active");
  });

  it("filters by date range", () => {
    store.createNote("Test");
    const results = store.queryNotes({
      dateFrom: new Date(Date.now() - 60000).toISOString(),
      dateTo: new Date(Date.now() + 60000).toISOString(),
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it("sorts ascending and descending", () => {
    store.createNote("First", { id: "first" });
    store.createNote("Second", { id: "second" });

    const asc = store.queryNotes({ sort: "asc" });
    expect(asc[0].content).toBe("First");

    const desc = store.queryNotes({ sort: "desc" });
    expect(desc[0].content).toBe("Second");
  });

  it("limits results", () => {
    for (let i = 0; i < 5; i++) store.createNote(`Note ${i}`);
    const results = store.queryNotes({ limit: 3 });
    expect(results).toHaveLength(3);
  });
});

// ---- Search ----

describe("searchNotes", () => {
  it("finds notes by content", () => {
    store.createNote("Walked up Flagstaff trail");
    store.createNote("Meeting about Horizon");

    const results = store.searchNotes("Flagstaff");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("Flagstaff");
  });

  it("filters search by tag", () => {
    store.createNote("Daily Flagstaff", { tags: ["daily"] });
    store.createNote("Doc Flagstaff", { tags: ["doc"] });

    const results = store.searchNotes("Flagstaff", { tags: ["daily"] });
    expect(results).toHaveLength(1);
    expect(results[0].tags).toContain("daily");
  });

  it("returns empty for no match", () => {
    store.createNote("Hello world");
    const results = store.searchNotes("nonexistent");
    expect(results).toHaveLength(0);
  });
});

// ---- Links ----

describe("links", () => {
  it("creates a link", () => {
    store.createNote("A", { id: "a" });
    store.createNote("B", { id: "b" });

    const link = store.createLink("a", "b", "mentions");
    expect(link.sourceId).toBe("a");
    expect(link.targetId).toBe("b");
    expect(link.relationship).toBe("mentions");
  });

  it("deletes a link", () => {
    store.createNote("A", { id: "a" });
    store.createNote("B", { id: "b" });
    store.createLink("a", "b", "mentions");
    store.deleteLink("a", "b", "mentions");

    const links = store.getLinks("a");
    expect(links).toHaveLength(0);
  });

  it("gets outbound links", () => {
    store.createNote("A", { id: "a" });
    store.createNote("B", { id: "b" });
    store.createNote("C", { id: "c" });
    store.createLink("a", "b", "mentions");
    store.createLink("c", "a", "quotes");

    const outbound = store.getLinks("a", { direction: "outbound" });
    expect(outbound).toHaveLength(1);
    expect(outbound[0].targetId).toBe("b");
  });

  it("gets inbound links", () => {
    store.createNote("A", { id: "a" });
    store.createNote("B", { id: "b" });
    store.createLink("a", "b", "mentions");

    const inbound = store.getLinks("b", { direction: "inbound" });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].sourceId).toBe("a");
  });

  it("gets all links (both directions)", () => {
    store.createNote("A", { id: "a" });
    store.createNote("B", { id: "b" });
    store.createNote("C", { id: "c" });
    store.createLink("a", "b", "mentions");
    store.createLink("c", "a", "quotes");

    const all = store.getLinks("a", { direction: "both" });
    expect(all).toHaveLength(2);
  });

  it("link creation is idempotent", () => {
    store.createNote("A", { id: "a" });
    store.createNote("B", { id: "b" });
    store.createLink("a", "b", "mentions");
    store.createLink("a", "b", "mentions"); // duplicate
    const links = store.getLinks("a");
    expect(links.filter((l) => l.relationship === "mentions")).toHaveLength(1);
  });
});

// ---- Attachments ----

describe("attachments", () => {
  it("adds and retrieves attachments", () => {
    const note = store.createNote("Voice memo", { tags: ["daily", "voice"] });
    const attachment = store.addAttachment(note.id, "2026-03-31/audio.wav", "audio/wav");

    expect(attachment.noteId).toBe(note.id);
    expect(attachment.mimeType).toBe("audio/wav");

    const attachments = store.getAttachments(note.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].path).toBe("2026-03-31/audio.wav");
  });

  it("cascade deletes attachments with note", () => {
    const note = store.createNote("Test");
    store.addAttachment(note.id, "file.png", "image/png");
    store.deleteNote(note.id);

    const attachments = store.getAttachments(note.id);
    expect(attachments).toHaveLength(0);
  });
});

// ---- MCP Tools ----

describe("MCP tools", () => {
  it("generates all 9 consolidated tools", () => {
    const tools = generateMcpTools(store);
    const names = tools.map((t) => t.name);

    expect(names).toContain("query-notes");
    expect(names).toContain("create-note");
    expect(names).toContain("update-note");
    expect(names).toContain("delete-note");
    expect(names).toContain("list-tags");
    expect(names).toContain("update-tag");
    expect(names).toContain("delete-tag");
    expect(names).toContain("find-path");
    expect(names).toContain("vault-info");
    expect(tools).toHaveLength(9);
  });

  it("create-note tool works", () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = createNote.execute({ content: "Hello", tags: ["daily"] }) as any;
    expect(result.content).toBe("Hello");
    expect(result.tags).toContain("daily");
  });

  it("create-note batch mode works", () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = createNote.execute({
      notes: [
        { content: "A", tags: ["daily"] },
        { content: "B", tags: ["doc"] },
      ],
    }) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].tags).toContain("daily");
    expect(result[1].tags).toContain("doc");
  });

  it("create-note with links resolves targets by path", () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    store.createNote("Target", { path: "People/Alice" });
    const result = createNote.execute({
      content: "Links to Alice",
      links: [{ target: "People/Alice", relationship: "mentions" }],
    }) as any;
    const links = store.getLinks(result.id, { direction: "outbound" });
    expect(links.some((l) => l.relationship === "mentions")).toBe(true);
  });

  it("update-note tool updates created_at", () => {
    const note = store.createNote("Test");
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const newDate = "2025-03-01T00:00:00.000Z";
    const result = updateNote.execute({ id: note.id, created_at: newDate }) as any;
    expect(result.createdAt).toBe(newDate);
    expect(result.content).toBe("Test");
  });

  it("update-note tool merges metadata", () => {
    const note = store.createNote("Test", { metadata: { existing: "value" } });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = updateNote.execute({ id: note.id, metadata: { importance: "high" } }) as any;
    expect(result.metadata).toEqual({ existing: "value", importance: "high" });
  });

  it("update-note tags add/remove works", () => {
    const note = store.createNote("Test");
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Add tags
    updateNote.execute({ id: note.id, tags: { add: ["pinned", "daily"] } });
    expect(store.getNote(note.id)!.tags).toContain("pinned");
    expect(store.getNote(note.id)!.tags).toContain("daily");

    // Remove tags
    updateNote.execute({ id: note.id, tags: { remove: ["pinned"] } });
    expect(store.getNote(note.id)!.tags).not.toContain("pinned");
    expect(store.getNote(note.id)!.tags).toContain("daily");
  });

  it("update-note links add/remove works", () => {
    store.createNote("A", { id: "a" });
    store.createNote("B", { id: "b" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Add link
    updateNote.execute({ id: "a", links: { add: [{ target: "b", relationship: "mentions" }] } });
    expect(store.getLinks("a", { direction: "outbound" })).toHaveLength(1);

    // Remove link
    updateNote.execute({ id: "a", links: { remove: [{ target: "b", relationship: "mentions" }] } });
    expect(store.getLinks("a", { direction: "outbound" })).toHaveLength(0);
  });

  it("update-note removes wikilink brackets when removing wikilink-type link", () => {
    store.createNote("Target", { id: "target", path: "People/Alice" });
    const source = store.createNote("See [[People/Alice]] for details", { id: "source" });
    store.createLink("source", "target", "wikilink");

    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = updateNote.execute({
      id: "source",
      links: { remove: [{ target: "target", relationship: "wikilink" }] },
    }) as any;
    expect(result.content).toBe("See People/Alice for details");
  });

  it("update-note batch mode works", () => {
    const a = store.createNote("A", { id: "a" });
    const b = store.createNote("B", { id: "b" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = updateNote.execute({
      notes: [
        { id: "a", content: "A updated" },
        { id: "b", tags: { add: ["pinned"] } },
      ],
    }) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("A updated");
    expect(store.getNote("b")!.tags).toContain("pinned");
  });

  it("update-note resolves note by path", () => {
    store.createNote("Test", { path: "Projects/README" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = updateNote.execute({ id: "Projects/README", content: "Updated" }) as any;
    expect(result.content).toBe("Updated");
  });

  it("query-notes single note by id", () => {
    const note = store.createNote("Hello", { path: "test/note" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ id: note.id }) as any;
    expect(result.content).toBe("Hello");
    expect(result.path).toBe("test/note");
  });

  it("query-notes single note by path", () => {
    store.createNote("By Path", { path: "Projects/README" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ id: "Projects/README" }) as any;
    expect(result.content).toBe("By Path");
  });

  it("query-notes by tag", () => {
    store.createNote("Test", { tags: ["daily"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ tag: ["daily"] }) as any[];
    expect(result).toHaveLength(1);
  });

  it("query-notes list defaults to no content (index mode)", () => {
    const content = "This is the note body.";
    store.createNote(content, { tags: ["daily"], path: "Notes/test", metadata: { status: "draft" } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ tag: ["daily"] }) as any[];
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.content).toBeUndefined();
    expect(entry.id).toBeTruthy();
    expect(entry.path).toBe("Notes/test");
    expect(entry.byteSize).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("query-notes list with include_content: true returns full content", () => {
    store.createNote("Full body", { tags: ["daily"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ tag: ["daily"], include_content: true }) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Full body");
  });

  it("query-notes index mode truncates preview and counts utf-8 bytes", () => {
    const longContent = "line one\nline two has\tlots    of   whitespace\n" + "x".repeat(300) + " ✨✨✨";
    store.createNote(longContent, { tags: ["long"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ tag: ["long"] }) as any[];
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.byteSize).toBe(Buffer.byteLength(longContent, "utf8"));
    expect(entry.byteSize).toBeGreaterThan(longContent.length);
    expect(entry.preview.length).toBeLessThanOrEqual(120);
    expect(entry.preview.includes("\n")).toBe(false);
  });

  it("query-notes index mode does not split astral-plane surrogate pairs", () => {
    const emoji = "😀";
    const longContent = emoji.repeat(130);
    store.createNote(longContent, { tags: ["astral"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ tag: ["astral"] }) as any[];
    expect(result).toHaveLength(1);
    const preview = result[0].preview as string;
    const codePoints = Array.from(preview);
    expect(codePoints.length).toBeLessThanOrEqual(120);
    for (const cp of codePoints) {
      expect(cp).toBe(emoji);
    }
  });

  it("query-notes honors filters (date range, path_prefix, limit, offset)", () => {
    store.createNote("A", { tags: ["keep"], path: "Projects/a", created_at: "2025-03-05T00:00:00.000Z" });
    store.createNote("B", { tags: ["keep"], path: "Projects/b", created_at: "2025-03-10T00:00:00.000Z" });
    store.createNote("C", { tags: ["keep"], path: "Other/c",    created_at: "2025-03-15T00:00:00.000Z" });
    store.createNote("D", { tags: ["keep"], path: "Projects/d", created_at: "2025-04-02T00:00:00.000Z" });

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    // date range filter
    const inMarch = query.execute({
      date_from: "2025-03-01",
      date_to: "2025-04-01",
      sort: "asc",
    }) as any[];
    expect(inMarch).toHaveLength(3);
    expect(inMarch.every((n) => n.content === undefined)).toBe(true);

    // path_prefix filter
    const projects = query.execute({ path_prefix: "Projects" }) as any[];
    expect(projects).toHaveLength(3);
    expect(projects.every((n) => n.path!.startsWith("Projects"))).toBe(true);

    // limit + offset
    const page = query.execute({
      path_prefix: "Projects",
      sort: "asc",
      limit: 2,
      offset: 1,
    }) as any[];
    expect(page).toHaveLength(2);
  });

  it("query-notes full-text search works", () => {
    store.createNote("Flagstaff trail");
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ search: "Flagstaff" }) as any[];
    expect(result).toHaveLength(1);
  });

  it("query-notes with include_links enriches results", () => {
    store.createNote("A", { id: "a", path: "alpha" });
    store.createNote("B", { id: "b", path: "beta" });
    store.createLink("a", "b", "mentions");
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ id: "a", include_links: true }) as any;
    expect(result.links).toBeDefined();
    expect(result.links).toHaveLength(1);
  });

  it("query-notes include_metadata: true returns all metadata (single)", () => {
    store.createNote("Body", { metadata: { summary: "short", status: "draft", priority: 1 } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ id: store.queryNotes({})[0].id, include_metadata: true }) as any;
    expect(result.metadata).toEqual({ summary: "short", status: "draft", priority: 1 });
  });

  it("query-notes include_metadata: false strips metadata (single)", () => {
    store.createNote("Body", { metadata: { summary: "short", status: "draft" } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ id: store.queryNotes({})[0].id, include_metadata: false }) as any;
    expect(result.metadata).toBeUndefined();
    expect(result.content).toBe("Body"); // other fields unaffected
  });

  it("query-notes include_metadata: string[] returns only specified fields (single)", () => {
    store.createNote("Body", { metadata: { summary: "short", status: "draft", priority: 1 } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ id: store.queryNotes({})[0].id, include_metadata: ["summary"] }) as any;
    expect(result.metadata).toEqual({ summary: "short" });
  });

  it("query-notes include_metadata: false strips metadata (list)", () => {
    store.createNote("A", { tags: ["meta-test"], metadata: { summary: "a" } });
    store.createNote("B", { tags: ["meta-test"], metadata: { summary: "b" } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ tag: "meta-test", include_metadata: false }) as any[];
    expect(result).toHaveLength(2);
    for (const n of result) {
      expect(n.metadata).toBeUndefined();
    }
  });

  it("query-notes include_metadata: string[] filters fields (list)", () => {
    store.createNote("A", { tags: ["meta-filter"], metadata: { summary: "a", status: "ok", extra: true } });
    store.createNote("B", { tags: ["meta-filter"], metadata: { summary: "b", extra: false } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ tag: "meta-filter", include_metadata: ["summary", "status"] }) as any[];
    expect(result).toHaveLength(2);
    const a = result.find((n: any) => n.metadata?.summary === "a");
    const b = result.find((n: any) => n.metadata?.summary === "b");
    expect(a.metadata).toEqual({ summary: "a", status: "ok" });
    expect(b.metadata).toEqual({ summary: "b" }); // status absent → omitted
  });

  it("query-notes include_metadata: string[] with no matching fields returns undefined metadata", () => {
    store.createNote("A", { tags: ["no-match-meta"], metadata: { summary: "a" } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ tag: "no-match-meta", include_metadata: ["nonexistent"] }) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].metadata).toBeUndefined();
  });

  it("query-notes near param scopes results to graph neighborhood", () => {
    store.createNote("Center", { id: "center" });
    store.createNote("Near", { id: "near", tags: ["t"] });
    store.createNote("Far", { id: "far", tags: ["t"] });
    store.createLink("center", "near", "mentions");
    // "far" is not linked to "center"

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ tag: "t", near: { note_id: "center", depth: 1 } }) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("near");
  });

  it("delete-note accepts path", () => {
    store.createNote("To delete", { path: "Temp/note" });
    const tools = generateMcpTools(store);
    const deleteTool = tools.find((t) => t.name === "delete-note")!;
    const result = deleteTool.execute({ id: "Temp/note" }) as any;
    expect(result.deleted).toBe(true);
    expect(store.getNoteByPath("Temp/note")).toBeNull();
  });

  it("delete-tag with zero notes removes tag from list", () => {
    store.createNote("Test", { tags: ["ephemeral"] });
    store.untagNote(store.queryNotes({}).find((n) => n.tags?.includes("ephemeral"))!.id, ["ephemeral"]);
    const before = store.listTags();
    expect(before.some((t) => t.name === "ephemeral")).toBe(true);

    const result = store.deleteTag("ephemeral");
    expect(result).toEqual({ deleted: true, notes_untagged: 0 });

    const after = store.listTags();
    expect(after.some((t) => t.name === "ephemeral")).toBe(false);
  });

  it("delete-tag with N notes untags all but preserves notes", () => {
    const n1 = store.createNote("A", { tags: ["doomed"] });
    const n2 = store.createNote("B", { tags: ["doomed", "keeper"] });

    const result = store.deleteTag("doomed");
    expect(result).toEqual({ deleted: true, notes_untagged: 2 });

    expect(store.getNote(n1.id)).not.toBeNull();
    expect(store.getNote(n2.id)).not.toBeNull();
    expect(store.getNote(n1.id)!.tags).not.toContain("doomed");
    expect(store.getNote(n2.id)!.tags).not.toContain("doomed");
    expect(store.getNote(n2.id)!.tags).toContain("keeper");
    expect(store.listTags().some((t) => t.name === "doomed")).toBe(false);
  });

  it("delete-tag nonexistent returns deleted: false", () => {
    const result = store.deleteTag("never-existed");
    expect(result).toEqual({ deleted: false, notes_untagged: 0 });
  });

  it("delete-tag MCP tool works", () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    createNote.execute({ content: "Test", tags: ["mcp-tag"] });

    const deleteTool = tools.find((t) => t.name === "delete-tag")!;
    const result = deleteTool.execute({ tag: "mcp-tag" }) as any;
    expect(result.deleted).toBe(true);
    expect(result.notes_untagged).toBe(1);

    const listTool = tools.find((t) => t.name === "list-tags")!;
    const tags = listTool.execute({}) as any[];
    expect(tags.some((t: any) => t.name === "mcp-tag")).toBe(false);
  });

  it("list-tags single tag detail with schema", () => {
    store.createNote("Test", { tags: ["person"] });
    store.upsertTagSchema("person", {
      description: "A person",
      fields: { name: { type: "string" } },
    });
    const tools = generateMcpTools(store);
    const listTags = tools.find((t) => t.name === "list-tags")!;
    const result = listTags.execute({ tag: "person" }) as any;
    expect(result.name).toBe("person");
    expect(result.count).toBe(1);
    expect(result.description).toBe("A person");
    expect(result.fields.name.type).toBe("string");
  });

  it("list-tags include_schema returns schemas for all tags", () => {
    store.createNote("A", { tags: ["person"] });
    store.createNote("B", { tags: ["project"] });
    store.upsertTagSchema("person", { description: "A person" });
    const tools = generateMcpTools(store);
    const listTags = tools.find((t) => t.name === "list-tags")!;
    const result = listTags.execute({ include_schema: true }) as any[];
    const person = result.find((t: any) => t.name === "person");
    expect(person.description).toBe("A person");
    const project = result.find((t: any) => t.name === "project");
    expect(project.description).toBeNull();
  });

  it("update-tag creates schema if not exists", () => {
    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    const result = updateTag.execute({
      tag: "person",
      description: "A person",
      fields: { name: { type: "string" } },
    }) as any;
    expect(result.tag).toBe("person");
    expect(result.description).toBe("A person");
  });

  it("update-tag merges fields with existing", () => {
    store.upsertTagSchema("person", {
      description: "A person",
      fields: { name: { type: "string" } },
    });
    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    const result = updateTag.execute({
      tag: "person",
      fields: { age: { type: "integer" } },
    }) as any;
    expect(result.fields.name.type).toBe("string");
    expect(result.fields.age.type).toBe("integer");
  });

  it("find-path works with ID/path resolution", () => {
    store.createNote("A", { id: "a", path: "People/Alice" });
    store.createNote("B", { id: "b" });
    store.createNote("C", { id: "c", path: "Projects/X" });
    store.createLink("a", "b", "mentions");
    store.createLink("b", "c", "related-to");

    const tools = generateMcpTools(store);
    const findPath = tools.find((t) => t.name === "find-path")!;
    const result = findPath.execute({ source: "People/Alice", target: "Projects/X" }) as any;
    expect(result).not.toBeNull();
    expect(result.path).toEqual(["a", "b", "c"]);
    expect(result.relationships).toEqual(["mentions", "related-to"]);
  });

  it("create-note via store triggers wikilink sync", () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;

    store.createNote("Target", { path: "Target Note" });
    const source = createNote.execute({ content: "See [[Target Note]]" }) as any;

    const links = store.getLinks(source.id, { direction: "outbound" });
    expect(links.some((l) => l.relationship === "wikilink")).toBe(true);
  });

  it("create-note with schema tag auto-populates defaults", () => {
    store.upsertTagSchema("person", {
      description: "A person",
      fields: {
        first_appeared: { type: "string" },
        active: { type: "boolean" },
        priority: { type: "integer" },
        status: { type: "string", enum: ["active", "archived"] },
      },
    });
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = createNote.execute({ content: "Alice", tags: ["person"] }) as any;
    const fresh = query.execute({ id: result.id }) as any;
    expect(fresh.metadata.first_appeared).toBe("");
    expect(fresh.metadata.active).toBe(false);
    expect(fresh.metadata.priority).toBe(0);
    expect(fresh.metadata.status).toBe("active");
  });
});
