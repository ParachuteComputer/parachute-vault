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

  it("get-vault-stats MCP tool works", () => {
    store.createNote("one", { tags: ["x"], created_at: "2025-05-01T00:00:00.000Z" });
    store.createNote("two", { tags: ["x", "y"], created_at: "2025-06-01T00:00:00.000Z" });

    const tools = generateMcpTools(db);
    const tool = tools.find((t) => t.name === "get-vault-stats")!;
    expect(tool).toBeTruthy();

    const result = tool.execute({}) as any;
    expect(result.totalNotes).toBe(2);
    expect(result.tagCount).toBe(2);
    expect(result.topTags[0].tag).toBe("x");
    expect(result.topTags[0].count).toBe(2);
    expect(result.notesByMonth).toHaveLength(2);
    expect(result.earliestNote.createdAt).toBe("2025-05-01T00:00:00.000Z");
    expect(result.latestNote.createdAt).toBe("2025-06-01T00:00:00.000Z");
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
    expect(names).toContain("delete-tag");
    expect(names).toContain("resolve-wikilink");
    expect(names).toContain("list-unresolved-wikilinks");
    expect(names).toContain("get-graph");
    expect(tools).toHaveLength(22);
  });

  it("create-note tool works", () => {
    const tools = generateMcpTools(db);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = createNote.execute({ content: "Hello", tags: ["daily"] }) as any;
    expect(result.content).toBe("Hello");
    expect(result.tags).toContain("daily");
  });

  it("update-note tool updates created_at", () => {
    const note = store.createNote("Test");
    const tools = generateMcpTools(db);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const newDate = "2025-03-01T00:00:00.000Z";
    const result = updateNote.execute({ id: note.id, created_at: newDate }) as any;
    expect(result.createdAt).toBe(newDate);
    expect(result.content).toBe("Test");
  });

  it("update-note tool updates metadata", () => {
    const note = store.createNote("Test");
    const tools = generateMcpTools(db);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const meta = { importance: "high" };
    const result = updateNote.execute({ id: note.id, metadata: meta }) as any;
    expect(result.metadata).toEqual(meta);
  });

  it("read-notes tool works", () => {
    store.createNote("Test", { tags: ["daily"] });
    const tools = generateMcpTools(db);
    const readNotes = tools.find((t) => t.name === "read-notes")!;
    const result = readNotes.execute({ tags: ["daily"] }) as any[];
    expect(result).toHaveLength(1);
  });

  it("read-notes defaults to including content (backwards compatible)", () => {
    store.createNote("Full body content here", { tags: ["daily"] });
    const tools = generateMcpTools(db);
    const readNotes = tools.find((t) => t.name === "read-notes")!;
    const result = readNotes.execute({ tags: ["daily"] }) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Full body content here");
    expect(result[0].byteSize).toBeUndefined();
    expect(result[0].preview).toBeUndefined();
  });

  it("read-notes with include_content: true returns full content", () => {
    store.createNote("Explicit include", { tags: ["daily"] });
    const tools = generateMcpTools(db);
    const readNotes = tools.find((t) => t.name === "read-notes")!;
    const result = readNotes.execute({ tags: ["daily"], include_content: true }) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Explicit include");
  });

  it("read-notes with include_content: false returns index metadata without content", () => {
    const content = "This is the note body that should not come back in index mode.";
    store.createNote(content, { tags: ["daily"], path: "Notes/index-test", metadata: { status: "draft" } });
    const tools = generateMcpTools(db);
    const readNotes = tools.find((t) => t.name === "read-notes")!;
    const result = readNotes.execute({ tags: ["daily"], include_content: false }) as any[];
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.content).toBeUndefined();
    expect(entry.id).toBeTruthy();
    expect(entry.path).toBe("Notes/index-test");
    expect(entry.createdAt).toBeTruthy();
    expect(entry.tags).toContain("daily");
    expect(entry.metadata).toEqual({ status: "draft" });
    expect(entry.byteSize).toBe(Buffer.byteLength(content, "utf8"));
    expect(entry.preview).toBe(content);
  });

  it("read-notes index mode truncates preview and counts utf-8 bytes", () => {
    // Multi-byte chars: each "✨" is 3 bytes in utf-8
    const longContent = "line one\nline two has\tlots    of   whitespace\n" + "x".repeat(300) + " ✨✨✨";
    store.createNote(longContent, { tags: ["long"] });
    const tools = generateMcpTools(db);
    const readNotes = tools.find((t) => t.name === "read-notes")!;
    const result = readNotes.execute({ tags: ["long"], include_content: false }) as any[];
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.byteSize).toBe(Buffer.byteLength(longContent, "utf8"));
    expect(entry.byteSize).toBeGreaterThan(longContent.length); // multi-byte chars
    expect(entry.preview.length).toBeLessThanOrEqual(120);
    expect(entry.preview.includes("\n")).toBe(false); // whitespace collapsed
  });

  it("read-notes index mode preview does not split astral-plane surrogate pairs", () => {
    // "😀" is U+1F600 — outside the BMP, encoded as a UTF-16 surrogate pair.
    // A naive .slice(0, 120) would cut on code unit 120, landing mid-pair
    // and producing a lone surrogate. Iterating by code points avoids this.
    const emoji = "😀";
    const longContent = emoji.repeat(130);
    store.createNote(longContent, { tags: ["astral"] });
    const tools = generateMcpTools(db);
    const readNotes = tools.find((t) => t.name === "read-notes")!;
    const result = readNotes.execute({ tags: ["astral"], include_content: false }) as any[];
    expect(result).toHaveLength(1);
    const preview = result[0].preview as string;

    // Must be truncated to at most 120 code points (not code units).
    const codePoints = Array.from(preview);
    expect(codePoints.length).toBeLessThanOrEqual(120);

    // Every code point should be the full emoji — no lone surrogates.
    for (const cp of codePoints) {
      expect(cp).toBe(emoji);
    }

    // No unpaired surrogates anywhere in the string.
    for (let i = 0; i < preview.length; i++) {
      const code = preview.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        // high surrogate — must be followed by a low surrogate
        const next = preview.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++;
      } else {
        // must not be a lone low surrogate
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
  });

  it("read-notes index mode honors existing filters (date range, path_prefix, limit, offset)", () => {
    store.createNote("A", { tags: ["keep"], path: "Projects/a", created_at: "2025-03-05T00:00:00.000Z" });
    store.createNote("B", { tags: ["keep"], path: "Projects/b", created_at: "2025-03-10T00:00:00.000Z" });
    store.createNote("C", { tags: ["keep"], path: "Other/c",    created_at: "2025-03-15T00:00:00.000Z" });
    store.createNote("D", { tags: ["keep"], path: "Projects/d", created_at: "2025-04-02T00:00:00.000Z" });

    const tools = generateMcpTools(db);
    const readNotes = tools.find((t) => t.name === "read-notes")!;

    // date range filter
    const inMarch = readNotes.execute({
      date_from: "2025-03-01",
      date_to: "2025-04-01",
      sort: "asc",
      include_content: false,
    }) as any[];
    expect(inMarch).toHaveLength(3);
    expect(inMarch.every((n) => n.content === undefined)).toBe(true);
    expect(inMarch.every((n) => typeof n.byteSize === "number")).toBe(true);

    // path_prefix filter
    const projects = readNotes.execute({
      path_prefix: "Projects",
      include_content: false,
    }) as any[];
    expect(projects).toHaveLength(3);
    expect(projects.every((n) => n.path!.startsWith("Projects"))).toBe(true);

    // limit + offset
    const page = readNotes.execute({
      path_prefix: "Projects",
      sort: "asc",
      limit: 2,
      offset: 1,
      include_content: false,
    }) as any[];
    expect(page).toHaveLength(2);
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
    const tools = generateMcpTools(db);
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

  it("resolve-wikilink: exact match", () => {
    store.createNote("Mickey doc", { path: "People/Mickey Myers" });
    const tools = generateMcpTools(store);
    const resolve = tools.find((t) => t.name === "resolve-wikilink")!;
    const result = resolve.execute({ target: "People/Mickey Myers" }) as any;
    expect(result.resolved).toBe(true);
    expect(result.path).toBe("People/Mickey Myers");
    expect(result.note_id).toBeTruthy();
    expect(result.candidates).toEqual([]);
  });

  it("resolve-wikilink: basename match", () => {
    store.createNote("Mickey doc", { path: "People/Mickey" });
    const tools = generateMcpTools(store);
    const resolve = tools.find((t) => t.name === "resolve-wikilink")!;
    const result = resolve.execute({ target: "Mickey" }) as any;
    expect(result.resolved).toBe(true);
    expect(result.path).toBe("People/Mickey");
  });

  it("resolve-wikilink: ambiguous — multiple basename matches", () => {
    store.createNote("Atlas person", { path: "People/Atlas" });
    store.createNote("Atlas project", { path: "Projects/Atlas" });
    const tools = generateMcpTools(store);
    const resolve = tools.find((t) => t.name === "resolve-wikilink")!;
    const result = resolve.execute({ target: "Atlas" }) as any;
    expect(result.resolved).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c: any) => c.path).sort()).toEqual(["People/Atlas", "Projects/Atlas"]);
  });

  it("resolve-wikilink: no match", () => {
    const tools = generateMcpTools(store);
    const resolve = tools.find((t) => t.name === "resolve-wikilink")!;
    const result = resolve.execute({ target: "Nonexistent" }) as any;
    expect(result.resolved).toBe(false);
    expect(result.ambiguous).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it("list-unresolved-wikilinks: returns unresolved entries", () => {
    store.createNote("See [[Ghost Note]]", { path: "Source" });
    const tools = generateMcpTools(store);
    const listUnresolved = tools.find((t) => t.name === "list-unresolved-wikilinks")!;
    const result = listUnresolved.execute({}) as any;
    expect(result.count).toBeGreaterThanOrEqual(1);
    const ghost = result.unresolved.find((u: any) => u.target_path === "Ghost Note");
    expect(ghost).toBeTruthy();
    expect(ghost.source_path).toBe("Source");
  });

  it("list-unresolved-wikilinks: empty when all resolved", () => {
    const tools = generateMcpTools(store);
    const listUnresolved = tools.find((t) => t.name === "list-unresolved-wikilinks")!;
    const result = listUnresolved.execute({}) as any;
    expect(result.count).toBe(0);
    expect(result.unresolved).toEqual([]);
  });

  it("get-links returns all links when id is omitted", () => {
    store.createNote("A", { id: "a" });
    store.createNote("B", { id: "b" });
    store.createNote("C", { id: "c" });
    store.createLink("a", "b", "mentions");
    store.createLink("b", "c", "cites");
    const tools = generateMcpTools(db);
    const getLinks = tools.find((t) => t.name === "get-links")!;

    const all = getLinks.execute({}) as any[];
    expect(all).toHaveLength(2);

    const cites = getLinks.execute({ relationship: "cites" }) as any[];
    expect(cites).toHaveLength(1);
    expect(cites[0].relationship).toBe("cites");
  });

  it("get-links returns bare Link[] (no hydration)", () => {
    store.createNote("A", { id: "a", path: "alpha" });
    store.createNote("B", { id: "b", path: "beta" });
    store.createLink("a", "b", "mentions");
    const tools = generateMcpTools(db);
    const getLinks = tools.find((t) => t.name === "get-links")!;
    const result = getLinks.execute({ id: "a" }) as any[];
    expect(result[0]).not.toHaveProperty("sourceNote");
    expect(result[0]).not.toHaveProperty("targetNote");
    expect(result[0].sourceId).toBe("a");
    expect(result[0].targetId).toBe("b");
  });

  it("get-graph returns notes, links, tags, meta with lean notes by default", () => {
    store.createNote("first", { id: "a", tags: ["proj"] });
    store.createNote("second", { id: "b", tags: ["proj"] });
    store.createNote("third", { id: "c", tags: ["other"] });
    store.createLink("a", "b", "mentions");

    const tools = generateMcpTools(db);
    const getGraph = tools.find((t) => t.name === "get-graph")!;
    const graph = getGraph.execute({}) as any;

    expect(graph.notes).toHaveLength(3);
    expect(graph.links).toHaveLength(1);
    expect(graph.meta.totalNotes).toBe(3);
    expect(graph.meta.totalLinks).toBe(1);
    expect(graph.meta.includeContent).toBe(false);
    expect(graph.notes[0]).not.toHaveProperty("content");
    expect(graph.notes[0]).toHaveProperty("byteSize");
    expect(graph.notes[0]).toHaveProperty("preview");
  });

  it("get-graph include_content=true returns full notes", () => {
    store.createNote("body text", { id: "a" });
    const tools = generateMcpTools(db);
    const getGraph = tools.find((t) => t.name === "get-graph")!;
    const graph = getGraph.execute({ include_content: true }) as any;
    expect(graph.notes[0].content).toBe("body text");
    expect(graph.meta.includeContent).toBe(true);
  });

  it("get-graph tag filter restricts notes and links to subgraph", () => {
    store.createNote("a", { id: "a", tags: ["proj"] });
    store.createNote("b", { id: "b", tags: ["proj"] });
    store.createNote("c", { id: "c", tags: ["other"] });
    store.createLink("a", "b", "mentions");
    store.createLink("a", "c", "mentions");

    const tools = generateMcpTools(db);
    const getGraph = tools.find((t) => t.name === "get-graph")!;
    const graph = getGraph.execute({ tags: ["proj"] }) as any;

    expect(graph.notes).toHaveLength(2);
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0].targetId).toBe("b");
    expect(graph.meta.totalNotes).toBe(3);
    expect(graph.meta.totalLinks).toBe(2);
    expect(graph.meta.filteredNotes).toBe(2);
    expect(graph.meta.filteredLinks).toBe(1);
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
