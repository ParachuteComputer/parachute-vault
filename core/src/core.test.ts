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
    expect(stats.total_notes).toBe(0);
    expect(stats.earliest_note).toBeNull();
    expect(stats.latest_note).toBeNull();
    expect(stats.notes_by_month).toEqual([]);
    expect(stats.top_tags).toEqual([]);
    expect(stats.tag_count).toBe(0);
  });

  it("counts total notes and tag_count", () => {
    store.createNote("A", { tags: ["daily", "voice"] });
    store.createNote("B", { tags: ["daily"] });
    store.createNote("C");

    const stats = store.getVaultStats();
    expect(stats.total_notes).toBe(3);
    expect(stats.tag_count).toBe(2); // "daily" and "voice"
  });

  it("reports earliest and latest notes correctly", () => {
    store.createNote("oldest", { id: "n1", created_at: "2025-01-15T10:00:00.000Z" });
    store.createNote("middle", { id: "n2", created_at: "2025-06-20T10:00:00.000Z" });
    store.createNote("newest", { id: "n3", created_at: "2026-03-01T10:00:00.000Z" });

    const stats = store.getVaultStats();
    expect(stats.earliest_note).toEqual({ id: "n1", created_at: "2025-01-15T10:00:00.000Z" });
    expect(stats.latest_note).toEqual({ id: "n3", created_at: "2026-03-01T10:00:00.000Z" });
  });

  it("groups notes by month across all present months", () => {
    store.createNote("a", { created_at: "2025-02-28T12:00:00.000Z" });
    store.createNote("b", { created_at: "2025-03-01T08:00:00.000Z" });
    store.createNote("c", { created_at: "2025-03-15T09:00:00.000Z" });
    store.createNote("d", { created_at: "2025-03-20T11:00:00.000Z" });
    store.createNote("e", { created_at: "2026-01-10T10:00:00.000Z" });

    const stats = store.getVaultStats();
    expect(stats.notes_by_month).toEqual([
      { month: "2025-02", count: 1 },
      { month: "2025-03", count: 3 },
      { month: "2026-01", count: 1 },
    ]);
  });

  it("returns top_tags ordered by count desc, capped", () => {
    // Create notes with varying tag frequencies
    for (let i = 0; i < 5; i++) store.createNote(`captured-${i}`, { tags: ["captured"] });
    for (let i = 0; i < 3; i++) store.createNote(`reader-${i}`, { tags: ["reader"] });
    store.createNote("one", { tags: ["rare"] });

    const stats = store.getVaultStats();
    expect(stats.top_tags[0]).toEqual({ tag: "captured", count: 5 });
    expect(stats.top_tags[1]).toEqual({ tag: "reader", count: 3 });
    expect(stats.top_tags[2]).toEqual({ tag: "rare", count: 1 });
  });

  it("caps top_tags at the requested limit", () => {
    // 25 distinct tags, one per note
    for (let i = 0; i < 25; i++) {
      store.createNote(`n-${i}`, { tags: [`tag-${String(i).padStart(2, "0")}`] });
    }
    const stats = store.getVaultStats({ topTagsLimit: 20 });
    expect(stats.top_tags).toHaveLength(20);
    expect(stats.tag_count).toBe(25);
  });

  it("response shape is complete", () => {
    store.createNote("hello", { tags: ["a"] });
    const stats = store.getVaultStats();
    expect(stats).toHaveProperty("total_notes");
    expect(stats).toHaveProperty("earliest_note");
    expect(stats).toHaveProperty("latest_note");
    expect(stats).toHaveProperty("notes_by_month");
    expect(stats).toHaveProperty("top_tags");
    expect(stats).toHaveProperty("tag_count");
  });

  it("get-vault-stats MCP tool works", () => {
    store.createNote("one", { tags: ["x"], created_at: "2025-05-01T00:00:00.000Z" });
    store.createNote("two", { tags: ["x", "y"], created_at: "2025-06-01T00:00:00.000Z" });

    const tools = generateMcpTools(db);
    const tool = tools.find((t) => t.name === "get-vault-stats")!;
    expect(tool).toBeTruthy();

    const result = tool.execute({}) as any;
    expect(result.total_notes).toBe(2);
    expect(result.tag_count).toBe(2);
    expect(result.top_tags[0].tag).toBe("x");
    expect(result.top_tags[0].count).toBe(2);
    expect(result.notes_by_month).toHaveLength(2);
    expect(result.earliest_note.created_at).toBe("2025-05-01T00:00:00.000Z");
    expect(result.latest_note.created_at).toBe("2025-06-01T00:00:00.000Z");
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
  it("generates all expected tools", () => {
    const tools = generateMcpTools(db);
    const names = tools.map((t) => t.name);

    expect(names).toContain("create-note");
    expect(names).toContain("update-note");
    expect(names).toContain("delete-note");
    expect(names).toContain("read-notes");
    expect(names).toContain("search-notes");
    expect(names).toContain("tag-note");
    expect(names).toContain("untag-note");
    expect(names).toContain("create-link");
    expect(names).toContain("delete-link");
    expect(names).toContain("get-links");
    expect(names).toContain("list-tags");
    expect(names).toContain("create-notes");
    expect(names).toContain("batch-tag");
    expect(names).toContain("batch-untag");
    expect(names).toContain("traverse-links");
    expect(names).toContain("find-path");
    expect(names).toContain("get-note");
    expect(names).toContain("get-vault-stats");
    expect(tools).toHaveLength(18);
  });

  it("create-note tool works", () => {
    const tools = generateMcpTools(db);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = createNote.execute({ content: "Hello", tags: ["daily"] }) as any;
    expect(result.content).toBe("Hello");
    expect(result.tags).toContain("daily");
  });

  it("read-notes tool works", () => {
    store.createNote("Test", { tags: ["daily"] });
    const tools = generateMcpTools(db);
    const readNotes = tools.find((t) => t.name === "read-notes")!;
    const result = readNotes.execute({ tags: ["daily"] }) as any[];
    expect(result).toHaveLength(1);
  });

  it("search-notes tool works", () => {
    store.createNote("Flagstaff trail");
    const tools = generateMcpTools(db);
    const searchNotes = tools.find((t) => t.name === "search-notes")!;
    const result = searchNotes.execute({ query: "Flagstaff" }) as any[];
    expect(result).toHaveLength(1);
  });

  it("tag/untag tools work", () => {
    const note = store.createNote("Test");
    const tools = generateMcpTools(db);

    const tagTool = tools.find((t) => t.name === "tag-note")!;
    tagTool.execute({ id: note.id, tags: ["pinned"] });
    expect(store.getNote(note.id)!.tags).toContain("pinned");

    const untagTool = tools.find((t) => t.name === "untag-note")!;
    untagTool.execute({ id: note.id, tags: ["pinned"] });
    expect(store.getNote(note.id)!.tags).not.toContain("pinned");
  });

  it("link tools work", () => {
    store.createNote("A", { id: "a" });
    store.createNote("B", { id: "b" });
    const tools = generateMcpTools(db);

    const createLink = tools.find((t) => t.name === "create-link")!;
    createLink.execute({ source_id: "a", target_id: "b", relationship: "mentions" });

    const getLinks = tools.find((t) => t.name === "get-links")!;
    const links = getLinks.execute({ id: "a" }) as any[];
    expect(links).toHaveLength(1);

    const deleteLink = tools.find((t) => t.name === "delete-link")!;
    deleteLink.execute({ source_id: "a", target_id: "b", relationship: "mentions" });
    expect((getLinks.execute({ id: "a" }) as any[]).length).toBe(0);
  });

  it("create-note via store triggers wikilink sync", () => {
    // When MCP tools are generated with a Store, wikilinks should auto-sync
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;

    // Create target note first
    store.createNote("Target", { path: "Target Note" });

    // Create source via MCP tool with a wikilink
    const source = createNote.execute({ content: "See [[Target Note]]" }) as any;

    // Wikilink should have been resolved into a link
    const links = store.getLinks(source.id, { direction: "outbound" });
    expect(links.some((l) => l.relationship === "wikilink")).toBe(true);
  });
});
