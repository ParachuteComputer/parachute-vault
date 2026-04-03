import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteStore } from "./store.js";
import { BUILTIN_TAGS } from "./seed.js";
import { generateMcpTools } from "./mcp.js";

let store: SqliteStore;
let db: Database.Database;

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
  it("seeds builtin tags", () => {
    const tags = store.listTags();
    for (const builtin of BUILTIN_TAGS) {
      expect(tags.some((t) => t.name === builtin)).toBe(true);
    }
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
    expect(tools).toHaveLength(11);
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
});
