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

describe("notes", async () => {
  it("creates a note", async () => {
    const note = await store.createNote("Morning walk");
    expect(note.content).toBe("Morning walk");
    expect(note.id).toBeTruthy();
    expect(note.createdAt).toBeTruthy();
  });

  it("creates a note with custom id", async () => {
    const note = await store.createNote("Test", { id: "custom-id" });
    expect(note.id).toBe("custom-id");
  });

  it("creates a note with path", async () => {
    const note = await store.createNote("# Grocery List", { path: "Grocery List" });
    expect(note.path).toBe("Grocery List");
  });

  it("creates a note with tags", async () => {
    const note = await store.createNote("Voice memo", { tags: ["daily", "voice"] });
    expect(note.tags).toContain("daily");
    expect(note.tags).toContain("voice");
  });

  it("gets a note by id", async () => {
    const created = await store.createNote("Test");
    const found = await store.getNote(created.id);
    expect(found).toBeTruthy();
    expect(found!.id).toBe(created.id);
    expect(found!.content).toBe("Test");
  });

  it("returns null for missing note", async () => {
    expect(await store.getNote("nonexistent")).toBeNull();
  });

  it("updates note content", async () => {
    const note = await store.createNote("Original");
    const updated = await store.updateNote(note.id, { content: "Updated" });
    expect(updated.content).toBe("Updated");
    expect(updated.updatedAt).toBeTruthy();
  });

  it("updates note path", async () => {
    const note = await store.createNote("Test");
    const updated = await store.updateNote(note.id, { path: "Notes/Test" });
    expect(updated.path).toBe("Notes/Test");
  });

  it("updates created_at", async () => {
    const note = await store.createNote("Test");
    const newDate = "2025-01-15T12:00:00.000Z";
    const updated = await store.updateNote(note.id, { created_at: newDate });
    expect(updated.createdAt).toBe(newDate);
    expect(updated.content).toBe("Test"); // content unchanged
    expect(updated.updatedAt).not.toBe(note.updatedAt); // updated_at bumped
  });

  it("updates metadata and created_at together", async () => {
    const note = await store.createNote("Test");
    const newDate = "2025-06-30T23:59:59.000Z";
    const meta = { source: "import", version: 2 };
    const updated = await store.updateNote(note.id, { metadata: meta, created_at: newDate });
    expect(updated.createdAt).toBe(newDate);
    expect(updated.metadata).toEqual(meta);
    expect(updated.content).toBe("Test");
  });

  it("leaves created_at unchanged when not provided", async () => {
    const note = await store.createNote("Test");
    const updated = await store.updateNote(note.id, { content: "Updated" });
    expect(updated.createdAt).toBe(note.createdAt);
  });

  it("deletes a note", async () => {
    const note = await store.createNote("Delete me");
    await store.deleteNote(note.id);
    expect(await store.getNote(note.id)).toBeNull();
  });

  it("cascade deletes tags and links", async () => {
    await store.createNote("A", { id: "a", tags: ["daily"] });
    await store.createNote("B", { id: "b" });
    await store.createLink("a", "b", "mentions");

    await store.deleteNote("a");
    expect(await store.getLinks("b")).toHaveLength(0);
  });
});

// ---- Tags ----

describe("tags", async () => {
  it("starts with no tags", async () => {
    const tags = await store.listTags();
    expect(tags).toHaveLength(0);
  });

  it("tags a note", async () => {
    const note = await store.createNote("Test");
    await store.tagNote(note.id, ["daily", "voice"]);
    const found = await store.getNote(note.id);
    expect(found!.tags).toContain("daily");
    expect(found!.tags).toContain("voice");
  });

  it("untags a note", async () => {
    const note = await store.createNote("Test", { tags: ["daily", "voice"] });
    await store.untagNote(note.id, ["voice"]);
    const found = await store.getNote(note.id);
    expect(found!.tags).toContain("daily");
    expect(found!.tags).not.toContain("voice");
  });

  it("creates tags automatically", async () => {
    const note = await store.createNote("Test");
    await store.tagNote(note.id, ["custom-tag"]);
    const tags = await store.listTags();
    expect(tags.some((t) => t.name === "custom-tag")).toBe(true);
  });

  it("counts tag usage", async () => {
    await store.createNote("A", { tags: ["daily"] });
    await store.createNote("B", { tags: ["daily"] });
    await store.createNote("C", { tags: ["doc"] });

    const tags = await store.listTags();
    const daily = tags.find((t) => t.name === "daily");
    expect(daily!.count).toBe(2);
  });

  it("tagging is idempotent", async () => {
    const note = await store.createNote("Test", { tags: ["daily"] });
    await store.tagNote(note.id, ["daily"]); // duplicate
    const found = await store.getNote(note.id);
    expect(found!.tags!.filter((t) => t === "daily")).toHaveLength(1);
  });
});

// ---- Vault Stats ----

describe("vault stats", async () => {
  it("handles empty vault gracefully", async () => {
    const stats = await store.getVaultStats();
    expect(stats.totalNotes).toBe(0);
    expect(stats.earliestNote).toBeNull();
    expect(stats.latestNote).toBeNull();
    expect(stats.notesByMonth).toEqual([]);
    expect(stats.topTags).toEqual([]);
    expect(stats.tagCount).toBe(0);
  });

  it("counts total notes and tagCount", async () => {
    await store.createNote("A", { tags: ["daily", "voice"] });
    await store.createNote("B", { tags: ["daily"] });
    await store.createNote("C");

    const stats = await store.getVaultStats();
    expect(stats.totalNotes).toBe(3);
    expect(stats.tagCount).toBe(2); // "daily" and "voice"
  });

  it("reports earliest and latest notes correctly", async () => {
    await store.createNote("oldest", { id: "n1", created_at: "2025-01-15T10:00:00.000Z" });
    await store.createNote("middle", { id: "n2", created_at: "2025-06-20T10:00:00.000Z" });
    await store.createNote("newest", { id: "n3", created_at: "2026-03-01T10:00:00.000Z" });

    const stats = await store.getVaultStats();
    expect(stats.earliestNote).toEqual({ id: "n1", createdAt: "2025-01-15T10:00:00.000Z" });
    expect(stats.latestNote).toEqual({ id: "n3", createdAt: "2026-03-01T10:00:00.000Z" });
  });

  it("groups notes by month across all present months", async () => {
    await store.createNote("a", { created_at: "2025-02-28T12:00:00.000Z" });
    await store.createNote("b", { created_at: "2025-03-01T08:00:00.000Z" });
    await store.createNote("c", { created_at: "2025-03-15T09:00:00.000Z" });
    await store.createNote("d", { created_at: "2025-03-20T11:00:00.000Z" });
    await store.createNote("e", { created_at: "2026-01-10T10:00:00.000Z" });

    const stats = await store.getVaultStats();
    expect(stats.notesByMonth).toEqual([
      { month: "2025-02", count: 1 },
      { month: "2025-03", count: 3 },
      { month: "2026-01", count: 1 },
    ]);
  });

  it("returns topTags ordered by count desc, capped", async () => {
    // Create notes with varying tag frequencies
    for (let i = 0; i < 5; i++) await store.createNote(`captured-${i}`, { tags: ["captured"] });
    for (let i = 0; i < 3; i++) await store.createNote(`reader-${i}`, { tags: ["reader"] });
    await store.createNote("one", { tags: ["rare"] });

    const stats = await store.getVaultStats();
    expect(stats.topTags[0]).toEqual({ tag: "captured", count: 5 });
    expect(stats.topTags[1]).toEqual({ tag: "reader", count: 3 });
    expect(stats.topTags[2]).toEqual({ tag: "rare", count: 1 });
  });

  it("caps topTags at the requested limit", async () => {
    // 25 distinct tags, one per note
    for (let i = 0; i < 25; i++) {
      await store.createNote(`n-${i}`, { tags: [`tag-${String(i).padStart(2, "0")}`] });
    }
    const stats = await store.getVaultStats({ topTagsLimit: 20 });
    expect(stats.topTags).toHaveLength(20);
    expect(stats.tagCount).toBe(25);
  });

  it("response shape is complete", async () => {
    await store.createNote("hello", { tags: ["a"] });
    const stats = await store.getVaultStats();
    expect(stats).toHaveProperty("totalNotes");
    expect(stats).toHaveProperty("earliestNote");
    expect(stats).toHaveProperty("latestNote");
    expect(stats).toHaveProperty("notesByMonth");
    expect(stats).toHaveProperty("topTags");
    expect(stats).toHaveProperty("tagCount");
  });

  it("getVaultStats returns correct stats", async () => {
    await store.createNote("one", { tags: ["x"], created_at: "2025-05-01T00:00:00.000Z" });
    await store.createNote("two", { tags: ["x", "y"], created_at: "2025-06-01T00:00:00.000Z" });

    const result = await store.getVaultStats();
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

describe("queryNotes", async () => {
  it("queries by tag", async () => {
    await store.createNote("Daily 1", { tags: ["daily"] });
    await store.createNote("Doc 1", { tags: ["doc"] });

    const results = await store.queryNotes({ tags: ["daily"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Daily 1");
  });

  it("queries by multiple tags (AND)", async () => {
    await store.createNote("Voice daily", { tags: ["daily", "voice"] });
    await store.createNote("Text daily", { tags: ["daily"] });

    const results = await store.queryNotes({ tags: ["daily", "voice"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Voice daily");
  });

  it("queries by multiple tags (OR)", async () => {
    await store.createNote("Voice daily", { tags: ["daily", "voice"] });
    await store.createNote("Text daily", { tags: ["daily"] });
    await store.createNote("A doc", { tags: ["doc"] });

    const results = await store.queryNotes({ tags: ["voice", "doc"], tagMatch: "any" });
    expect(results).toHaveLength(2);
    const contents = results.map((n) => n.content).sort();
    expect(contents).toEqual(["A doc", "Voice daily"]);
  });

  it("excludes tags", async () => {
    await store.createNote("Active", { tags: ["digest"] });
    await store.createNote("Archived", { tags: ["digest", "archived"] });

    const results = await store.queryNotes({ tags: ["digest"], excludeTags: ["archived"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Active");
  });

  it("filters by date range", async () => {
    await store.createNote("Test");
    const results = await store.queryNotes({
      dateFrom: new Date(Date.now() - 60000).toISOString(),
      dateTo: new Date(Date.now() + 60000).toISOString(),
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it("sorts ascending and descending", async () => {
    await store.createNote("First", { id: "first" });
    await store.createNote("Second", { id: "second" });

    const asc = await store.queryNotes({ sort: "asc" });
    expect(asc[0].content).toBe("First");

    const desc = await store.queryNotes({ sort: "desc" });
    expect(desc[0].content).toBe("Second");
  });

  it("limits results", async () => {
    for (let i = 0; i < 5; i++) await store.createNote(`Note ${i}`);
    const results = await store.queryNotes({ limit: 3 });
    expect(results).toHaveLength(3);
  });
});

// ---- Search ----

describe("searchNotes", async () => {
  it("finds notes by content", async () => {
    await store.createNote("Walked up Flagstaff trail");
    await store.createNote("Meeting about Horizon");

    const results = await store.searchNotes("Flagstaff");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("Flagstaff");
  });

  it("filters search by tag", async () => {
    await store.createNote("Daily Flagstaff", { tags: ["daily"] });
    await store.createNote("Doc Flagstaff", { tags: ["doc"] });

    const results = await store.searchNotes("Flagstaff", { tags: ["daily"] });
    expect(results).toHaveLength(1);
    expect(results[0].tags).toContain("daily");
  });

  it("returns empty for no match", async () => {
    await store.createNote("Hello world");
    const results = await store.searchNotes("nonexistent");
    expect(results).toHaveLength(0);
  });
});

// ---- Links ----

describe("links", async () => {
  it("creates a link", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });

    const link = await store.createLink("a", "b", "mentions");
    expect(link.sourceId).toBe("a");
    expect(link.targetId).toBe("b");
    expect(link.relationship).toBe("mentions");
  });

  it("deletes a link", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    await store.createLink("a", "b", "mentions");
    await store.deleteLink("a", "b", "mentions");

    const links = await store.getLinks("a");
    expect(links).toHaveLength(0);
  });

  it("gets outbound links", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    await store.createNote("C", { id: "c" });
    await store.createLink("a", "b", "mentions");
    await store.createLink("c", "a", "quotes");

    const outbound = await store.getLinks("a", { direction: "outbound" });
    expect(outbound).toHaveLength(1);
    expect(outbound[0].targetId).toBe("b");
  });

  it("gets inbound links", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    await store.createLink("a", "b", "mentions");

    const inbound = await store.getLinks("b", { direction: "inbound" });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].sourceId).toBe("a");
  });

  it("gets all links (both directions)", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    await store.createNote("C", { id: "c" });
    await store.createLink("a", "b", "mentions");
    await store.createLink("c", "a", "quotes");

    const all = await store.getLinks("a", { direction: "both" });
    expect(all).toHaveLength(2);
  });

  it("link creation is idempotent", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    await store.createLink("a", "b", "mentions");
    await store.createLink("a", "b", "mentions"); // duplicate
    const links = await store.getLinks("a");
    expect(links.filter((l) => l.relationship === "mentions")).toHaveLength(1);
  });
});

// ---- Attachments ----

describe("attachments", async () => {
  it("adds and retrieves attachments", async () => {
    const note = await store.createNote("Voice memo", { tags: ["daily", "voice"] });
    const attachment = await store.addAttachment(note.id, "2026-03-31/audio.wav", "audio/wav");

    expect(attachment.noteId).toBe(note.id);
    expect(attachment.mimeType).toBe("audio/wav");

    const attachments = await store.getAttachments(note.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].path).toBe("2026-03-31/audio.wav");
  });

  it("cascade deletes attachments with note", async () => {
    const note = await store.createNote("Test");
    await store.addAttachment(note.id, "file.png", "image/png");
    await store.deleteNote(note.id);

    const attachments = await store.getAttachments(note.id);
    expect(attachments).toHaveLength(0);
  });
});

// ---- MCP Tools ----

describe("MCP tools", async () => {
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

  it("create-note tool works", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = await createNote.execute({ content: "Hello", tags: ["daily"] }) as any;
    expect(result.content).toBe("Hello");
    expect(result.tags).toContain("daily");
  });

  it("create-note batch mode works", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = await createNote.execute({
      notes: [
        { content: "A", tags: ["daily"] },
        { content: "B", tags: ["doc"] },
      ],
    }) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].tags).toContain("daily");
    expect(result[1].tags).toContain("doc");
  });

  it("create-note with links resolves targets by path", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    await store.createNote("Target", { path: "People/Alice" });
    const result = await createNote.execute({
      content: "Links to Alice",
      links: [{ target: "People/Alice", relationship: "mentions" }],
    }) as any;
    const links = await store.getLinks(result.id, { direction: "outbound" });
    expect(links.some((l) => l.relationship === "mentions")).toBe(true);
  });

  it("update-note tool updates created_at", async () => {
    const note = await store.createNote("Test");
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const newDate = "2025-03-01T00:00:00.000Z";
    const result = await updateNote.execute({ id: note.id, created_at: newDate }) as any;
    expect(result.createdAt).toBe(newDate);
    expect(result.content).toBe("Test");
  });

  it("update-note tool merges metadata", async () => {
    const note = await store.createNote("Test", { metadata: { existing: "value" } });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = await updateNote.execute({ id: note.id, metadata: { importance: "high" } }) as any;
    expect(result.metadata).toEqual({ existing: "value", importance: "high" });
  });

  it("update-note tags add/remove works", async () => {
    const note = await store.createNote("Test");
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Add tags
    await updateNote.execute({ id: note.id, tags: { add: ["pinned", "daily"] } });
    expect((await store.getNote(note.id))!.tags).toContain("pinned");
    expect((await store.getNote(note.id))!.tags).toContain("daily");

    // Remove tags
    await updateNote.execute({ id: note.id, tags: { remove: ["pinned"] } });
    expect((await store.getNote(note.id))!.tags).not.toContain("pinned");
    expect((await store.getNote(note.id))!.tags).toContain("daily");
  });

  it("update-note links add/remove works", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Add link
    await updateNote.execute({ id: "a", links: { add: [{ target: "b", relationship: "mentions" }] } });
    expect(await store.getLinks("a", { direction: "outbound" })).toHaveLength(1);

    // Remove link
    await updateNote.execute({ id: "a", links: { remove: [{ target: "b", relationship: "mentions" }] } });
    expect(await store.getLinks("a", { direction: "outbound" })).toHaveLength(0);
  });

  it("update-note removes wikilink brackets when removing wikilink-type link", async () => {
    await store.createNote("Target", { id: "target", path: "People/Alice" });
    const source = await store.createNote("See [[People/Alice]] for details", { id: "source" });
    await store.createLink("source", "target", "wikilink");

    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = await updateNote.execute({
      id: "source",
      links: { remove: [{ target: "target", relationship: "wikilink" }] },
    }) as any;
    expect(result.content).toBe("See People/Alice for details");
  });

  it("update-note batch mode works", async () => {
    const a = await store.createNote("A", { id: "a" });
    const b = await store.createNote("B", { id: "b" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = await updateNote.execute({
      notes: [
        { id: "a", content: "A updated" },
        { id: "b", tags: { add: ["pinned"] } },
      ],
    }) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("A updated");
    expect((await store.getNote("b"))!.tags).toContain("pinned");
  });

  it("update-note resolves note by path", async () => {
    await store.createNote("Test", { path: "Projects/README" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = await updateNote.execute({ id: "Projects/README", content: "Updated" }) as any;
    expect(result.content).toBe("Updated");
  });

  it("update-note accepts if_updated_at when it matches current updated_at", async () => {
    const note = await store.createNote("First");
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const first = await updateNote.execute({ id: note.id, content: "Second" }) as any;
    expect(first.content).toBe("Second");
    expect(first.updatedAt).toBeTruthy();

    const second = await updateNote.execute({
      id: note.id,
      content: "Third",
      if_updated_at: first.updatedAt,
    }) as any;
    expect(second.content).toBe("Third");
  });

  it("update-note rejects if_updated_at mismatch with conflict error", async () => {
    const note = await store.createNote("First");
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const after = await updateNote.execute({ id: note.id, content: "Second" }) as any;

    // Simulate a stale client that has the pre-update timestamp (or something else).
    const staleTimestamp = "2020-01-01T00:00:00.000Z";
    expect(staleTimestamp).not.toBe(after.updatedAt);

    let err: any;
    try {
      await updateNote.execute({
        id: note.id,
        content: "Third",
        if_updated_at: staleTimestamp,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe("CONFLICT");
    expect(err.note_id).toBe(note.id);
    expect(err.current_updated_at).toBe(after.updatedAt);
    expect(err.expected_updated_at).toBe(staleTimestamp);

    // Note unchanged
    expect((await store.getNote(note.id))!.content).toBe("Second");
  });

  it("update-note if_updated_at conflicts for a never-updated note when caller expects a value", async () => {
    const note = await store.createNote("First");
    expect(note.updatedAt).toBeUndefined();
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    let err: any;
    try {
      await updateNote.execute({
        id: note.id,
        content: "Second",
        if_updated_at: "2020-01-01T00:00:00.000Z",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe("CONFLICT");
    expect(err.current_updated_at).toBeNull();
  });

  it("update-note batch aborts on first conflict without touching subsequent items", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Bump a's updated_at so any stale if_updated_at conflicts.
    const bumped = await updateNote.execute({ id: "a", content: "A bumped" }) as any;
    expect(bumped.updatedAt).toBeTruthy();

    let err: any;
    try {
      await updateNote.execute({
        notes: [
          { id: "a", content: "A new", if_updated_at: "2020-01-01T00:00:00.000Z" },
          { id: "b", content: "B new" },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("CONFLICT");

    // a was not modified by this call; b was not touched.
    expect((await store.getNote("a"))!.content).toBe("A bumped");
    expect((await store.getNote("b"))!.content).toBe("B");
  });

  it("update-note is atomic under concurrent if_updated_at — exactly one winner", async () => {
    // Fires two updates with the same if_updated_at via `Promise.allSettled`.
    // bun:sqlite is synchronous, so these interleave at JS microtask
    // boundaries rather than in true parallel — but that's the production
    // concurrency model (one node, event-loop scheduling). The guarantee
    // comes from the atomic conditional UPDATE in notes.ts: exactly one of
    // the two statements can match `AND updated_at IS ?`. Without that
    // atomicity both would commit and silently destroy one write — the
    // scenario if_updated_at exists to prevent.
    const note = await store.createNote("seed");
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Establish a known updated_at the two callers both read.
    const seed = await updateNote.execute({ id: note.id, content: "seed-v1" }) as any;
    expect(seed.updatedAt).toBeTruthy();

    const results = await Promise.allSettled([
      updateNote.execute({ id: note.id, content: "racer-A", if_updated_at: seed.updatedAt }),
      updateNote.execute({ id: note.id, content: "racer-B", if_updated_at: seed.updatedAt }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason as any;
    expect(err?.code).toBe("CONFLICT");

    // The winner's content is what ended up persisted.
    const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    const persisted = await store.getNote(note.id);
    expect(persisted!.content).toBe(winner.content);
    expect(["racer-A", "racer-B"]).toContain(persisted!.content);
  });

  it("update-note with links.remove rolls back link deletion when if_updated_at conflicts", async () => {
    await store.createNote("Target", { id: "target", path: "People/Alice" });
    const source = await store.createNote("See [[People/Alice]] for details", {
      id: "source",
    });
    await store.createLink("source", "target", "wikilink");

    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Bump so a stale if_updated_at conflicts; and capture state after bump.
    await updateNote.execute({ id: "source", content: "See [[People/Alice]] for details" });
    const preConflictLinks = await store.getLinks("source", { direction: "outbound" });
    expect(preConflictLinks).toHaveLength(1);

    let err: any;
    try {
      await updateNote.execute({
        id: "source",
        links: { remove: [{ target: "target", relationship: "wikilink" }] },
        if_updated_at: "2020-01-01T00:00:00.000Z",
      });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("CONFLICT");

    // The link must still exist — if it had been removed before the
    // conflict check, this would be 0.
    const postConflictLinks = await store.getLinks("source", { direction: "outbound" });
    expect(postConflictLinks).toHaveLength(1);
    expect((await store.getNote("source"))!.content).toBe("See [[People/Alice]] for details");
  });

  it("query-notes single note by id", async () => {
    const note = await store.createNote("Hello", { path: "test/note" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: note.id }) as any;
    expect(result.content).toBe("Hello");
    expect(result.path).toBe("test/note");
  });

  it("query-notes single note by path", async () => {
    await store.createNote("By Path", { path: "Projects/README" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: "Projects/README" }) as any;
    expect(result.content).toBe("By Path");
  });

  it("query-notes by tag", async () => {
    await store.createNote("Test", { tags: ["daily"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ tag: ["daily"] }) as any[];
    expect(result).toHaveLength(1);
  });

  it("query-notes list defaults to no content (index mode)", async () => {
    const content = "This is the note body.";
    await store.createNote(content, { tags: ["daily"], path: "Notes/test", metadata: { status: "draft" } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ tag: ["daily"] }) as any[];
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.content).toBeUndefined();
    expect(entry.id).toBeTruthy();
    expect(entry.path).toBe("Notes/test");
    expect(entry.byteSize).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("query-notes list with include_content: true returns full content", async () => {
    await store.createNote("Full body", { tags: ["daily"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ tag: ["daily"], include_content: true }) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Full body");
  });

  it("query-notes index mode truncates preview and counts utf-8 bytes", async () => {
    const longContent = "line one\nline two has\tlots    of   whitespace\n" + "x".repeat(300) + " ✨✨✨";
    await store.createNote(longContent, { tags: ["long"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ tag: ["long"] }) as any[];
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.byteSize).toBe(Buffer.byteLength(longContent, "utf8"));
    expect(entry.byteSize).toBeGreaterThan(longContent.length);
    expect(entry.preview.length).toBeLessThanOrEqual(120);
    expect(entry.preview.includes("\n")).toBe(false);
  });

  it("query-notes index mode does not split astral-plane surrogate pairs", async () => {
    const emoji = "😀";
    const longContent = emoji.repeat(130);
    await store.createNote(longContent, { tags: ["astral"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ tag: ["astral"] }) as any[];
    expect(result).toHaveLength(1);
    const preview = result[0].preview as string;
    const codePoints = Array.from(preview);
    expect(codePoints.length).toBeLessThanOrEqual(120);
    for (const cp of codePoints) {
      expect(cp).toBe(emoji);
    }
  });

  it("query-notes honors filters (date range, path_prefix, limit, offset)", async () => {
    await store.createNote("A", { tags: ["keep"], path: "Projects/a", created_at: "2025-03-05T00:00:00.000Z" });
    await store.createNote("B", { tags: ["keep"], path: "Projects/b", created_at: "2025-03-10T00:00:00.000Z" });
    await store.createNote("C", { tags: ["keep"], path: "Other/c",    created_at: "2025-03-15T00:00:00.000Z" });
    await store.createNote("D", { tags: ["keep"], path: "Projects/d", created_at: "2025-04-02T00:00:00.000Z" });

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    // date range filter
    const inMarch = await query.execute({
      date_from: "2025-03-01",
      date_to: "2025-04-01",
      sort: "asc",
    }) as any[];
    expect(inMarch).toHaveLength(3);
    expect(inMarch.every((n) => n.content === undefined)).toBe(true);

    // path_prefix filter
    const projects = await query.execute({ path_prefix: "Projects" }) as any[];
    expect(projects).toHaveLength(3);
    expect(projects.every((n) => n.path!.startsWith("Projects"))).toBe(true);

    // limit + offset
    const page = await query.execute({
      path_prefix: "Projects",
      sort: "asc",
      limit: 2,
      offset: 1,
    }) as any[];
    expect(page).toHaveLength(2);
  });

  it("query-notes full-text search works", async () => {
    await store.createNote("Flagstaff trail");
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ search: "Flagstaff" }) as any[];
    expect(result).toHaveLength(1);
  });

  it("query-notes with include_links enriches results", async () => {
    await store.createNote("A", { id: "a", path: "alpha" });
    await store.createNote("B", { id: "b", path: "beta" });
    await store.createLink("a", "b", "mentions");
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: "a", include_links: true }) as any;
    expect(result.links).toBeDefined();
    expect(result.links).toHaveLength(1);
  });

  it("query-notes include_metadata: true returns all metadata (single)", async () => {
    await store.createNote("Body", { metadata: { summary: "short", status: "draft", priority: 1 } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: (await store.queryNotes({}))[0]!.id, include_metadata: true }) as any;
    expect(result.metadata).toEqual({ summary: "short", status: "draft", priority: 1 });
  });

  it("query-notes include_metadata: false strips metadata (single)", async () => {
    await store.createNote("Body", { metadata: { summary: "short", status: "draft" } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: (await store.queryNotes({}))[0]!.id, include_metadata: false }) as any;
    expect(result.metadata).toBeUndefined();
    expect(result.content).toBe("Body"); // other fields unaffected
  });

  it("query-notes include_metadata: string[] returns only specified fields (single)", async () => {
    await store.createNote("Body", { metadata: { summary: "short", status: "draft", priority: 1 } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: (await store.queryNotes({}))[0]!.id, include_metadata: ["summary"] }) as any;
    expect(result.metadata).toEqual({ summary: "short" });
  });

  it("query-notes include_metadata: false strips metadata (list)", async () => {
    await store.createNote("A", { tags: ["meta-test"], metadata: { summary: "a" } });
    await store.createNote("B", { tags: ["meta-test"], metadata: { summary: "b" } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ tag: "meta-test", include_metadata: false }) as any[];
    expect(result).toHaveLength(2);
    for (const n of result) {
      expect(n.metadata).toBeUndefined();
    }
  });

  it("query-notes include_metadata: string[] filters fields (list)", async () => {
    await store.createNote("A", { tags: ["meta-filter"], metadata: { summary: "a", status: "ok", extra: true } });
    await store.createNote("B", { tags: ["meta-filter"], metadata: { summary: "b", extra: false } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ tag: "meta-filter", include_metadata: ["summary", "status"] }) as any[];
    expect(result).toHaveLength(2);
    const a = result.find((n: any) => n.metadata?.summary === "a");
    const b = result.find((n: any) => n.metadata?.summary === "b");
    expect(a.metadata).toEqual({ summary: "a", status: "ok" });
    expect(b.metadata).toEqual({ summary: "b" }); // status absent → omitted
  });

  it("query-notes include_metadata: string[] with no matching fields returns undefined metadata", async () => {
    await store.createNote("A", { tags: ["no-match-meta"], metadata: { summary: "a" } });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ tag: "no-match-meta", include_metadata: ["nonexistent"] }) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].metadata).toBeUndefined();
  });

  it("query-notes near param scopes results to graph neighborhood", async () => {
    await store.createNote("Center", { id: "center" });
    await store.createNote("Near", { id: "near", tags: ["t"] });
    await store.createNote("Far", { id: "far", tags: ["t"] });
    await store.createLink("center", "near", "mentions");
    // "far" is not linked to "center"

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ tag: "t", near: { note_id: "center", depth: 1 } }) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("near");
  });

  it("delete-note accepts path", async () => {
    await store.createNote("To delete", { path: "Temp/note" });
    const tools = generateMcpTools(store);
    const deleteTool = tools.find((t) => t.name === "delete-note")!;
    const result = await deleteTool.execute({ id: "Temp/note" }) as any;
    expect(result.deleted).toBe(true);
    expect(await store.getNoteByPath("Temp/note")).toBeNull();
  });

  it("delete-tag with zero notes removes tag from list", async () => {
    await store.createNote("Test", { tags: ["ephemeral"] });
    await store.untagNote((await store.queryNotes({})).find((n) => n.tags?.includes("ephemeral"))!.id, ["ephemeral"]);
    const before = await store.listTags();
    expect(before.some((t) => t.name === "ephemeral")).toBe(true);

    const result = await store.deleteTag("ephemeral");
    expect(result).toEqual({ deleted: true, notes_untagged: 0 });

    const after = await store.listTags();
    expect(after.some((t) => t.name === "ephemeral")).toBe(false);
  });

  it("delete-tag with N notes untags all but preserves notes", async () => {
    const n1 = await store.createNote("A", { tags: ["doomed"] });
    const n2 = await store.createNote("B", { tags: ["doomed", "keeper"] });

    const result = await store.deleteTag("doomed");
    expect(result).toEqual({ deleted: true, notes_untagged: 2 });

    expect(await store.getNote(n1.id)).not.toBeNull();
    expect(await store.getNote(n2.id)).not.toBeNull();
    expect((await store.getNote(n1.id))!.tags).not.toContain("doomed");
    expect((await store.getNote(n2.id))!.tags).not.toContain("doomed");
    expect((await store.getNote(n2.id))!.tags).toContain("keeper");
    expect((await store.listTags()).some((t) => t.name === "doomed")).toBe(false);
  });

  it("delete-tag nonexistent returns deleted: false", async () => {
    const result = await store.deleteTag("never-existed");
    expect(result).toEqual({ deleted: false, notes_untagged: 0 });
  });

  it("delete-tag MCP tool works", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    await createNote.execute({ content: "Test", tags: ["mcp-tag"] });

    const deleteTool = tools.find((t) => t.name === "delete-tag")!;
    const result = await deleteTool.execute({ tag: "mcp-tag" }) as any;
    expect(result.deleted).toBe(true);
    expect(result.notes_untagged).toBe(1);

    const listTool = tools.find((t) => t.name === "list-tags")!;
    const tags = await listTool.execute({}) as any[];
    expect(tags.some((t: any) => t.name === "mcp-tag")).toBe(false);
  });

  it("list-tags single tag detail with schema", async () => {
    await store.createNote("Test", { tags: ["person"] });
    await store.upsertTagSchema("person", {
      description: "A person",
      fields: { name: { type: "string" } },
    });
    const tools = generateMcpTools(store);
    const listTags = tools.find((t) => t.name === "list-tags")!;
    const result = await listTags.execute({ tag: "person" }) as any;
    expect(result.name).toBe("person");
    expect(result.count).toBe(1);
    expect(result.description).toBe("A person");
    expect(result.fields.name.type).toBe("string");
  });

  it("list-tags include_schema returns schemas for all tags", async () => {
    await store.createNote("A", { tags: ["person"] });
    await store.createNote("B", { tags: ["project"] });
    await store.upsertTagSchema("person", { description: "A person" });
    const tools = generateMcpTools(store);
    const listTags = tools.find((t) => t.name === "list-tags")!;
    const result = await listTags.execute({ include_schema: true }) as any[];
    const person = result.find((t: any) => t.name === "person");
    expect(person.description).toBe("A person");
    const project = result.find((t: any) => t.name === "project");
    expect(project.description).toBeNull();
  });

  it("update-tag creates schema if not exists", async () => {
    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    const result = await updateTag.execute({
      tag: "person",
      description: "A person",
      fields: { name: { type: "string" } },
    }) as any;
    expect(result.tag).toBe("person");
    expect(result.description).toBe("A person");
  });

  it("update-tag merges fields with existing", async () => {
    await store.upsertTagSchema("person", {
      description: "A person",
      fields: { name: { type: "string" } },
    });
    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    const result = await updateTag.execute({
      tag: "person",
      fields: { age: { type: "integer" } },
    }) as any;
    expect(result.fields.name.type).toBe("string");
    expect(result.fields.age.type).toBe("integer");
  });

  it("find-path works with ID/path resolution", async () => {
    await store.createNote("A", { id: "a", path: "People/Alice" });
    await store.createNote("B", { id: "b" });
    await store.createNote("C", { id: "c", path: "Projects/X" });
    await store.createLink("a", "b", "mentions");
    await store.createLink("b", "c", "related-to");

    const tools = generateMcpTools(store);
    const findPath = tools.find((t) => t.name === "find-path")!;
    const result = await findPath.execute({ source: "People/Alice", target: "Projects/X" }) as any;
    expect(result).not.toBeNull();
    expect(result.path).toEqual(["a", "b", "c"]);
    expect(result.relationships).toEqual(["mentions", "related-to"]);
  });

  it("create-note via store triggers wikilink sync", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;

    await store.createNote("Target", { path: "Target Note" });
    const source = await createNote.execute({ content: "See [[Target Note]]" }) as any;

    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links.some((l) => l.relationship === "wikilink")).toBe(true);
  });

  it("create-note with schema tag auto-populates defaults", async () => {
    await store.upsertTagSchema("person", {
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

    const result = await createNote.execute({ content: "Alice", tags: ["person"] }) as any;
    const fresh = await query.execute({ id: result.id }) as any;
    expect(fresh.metadata.first_appeared).toBe("");
    expect(fresh.metadata.active).toBe(false);
    expect(fresh.metadata.priority).toBe(0);
    expect(fresh.metadata.status).toBe("active");
  });
});
