import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import { initSchema } from "./schema.js";

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
    // updated_at is bumped to "now" by the update path. Can't strictly
    // differ from note.updatedAt (same-ms collision possible) but must be
    // monotonically non-decreasing from the prior value.
    expect(updated.updatedAt).toBeTruthy();
    expect(updated.updatedAt! >= note.updatedAt!).toBe(true);
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

  it("sets updatedAt === createdAt on insert", async () => {
    const note = await store.createNote("Fresh");
    expect(note.updatedAt).toBe(note.createdAt);
    const fetched = (await store.getNote(note.id))!;
    expect(fetched.updatedAt).toBe(fetched.createdAt);
  });

  it("create-insert updatedAt respects an explicit created_at", async () => {
    const note = await store.createNote("Imported", {
      created_at: "2024-02-14T09:30:00.000Z",
    });
    expect(note.createdAt).toBe("2024-02-14T09:30:00.000Z");
    expect(note.updatedAt).toBe("2024-02-14T09:30:00.000Z");
  });

  it("fresh note: if_updated_at with createdAt as the token succeeds", async () => {
    // Regression guard: clients that pass `updatedAt ?? createdAt` as the
    // OC token used to hit a CONFLICT on the very first edit because stored
    // `updated_at` was NULL. Insert-time backfill removes that class of
    // spurious conflict.
    const note = await store.createNote("First");
    const updated = await store.updateNote(note.id, {
      content: "Second",
      if_updated_at: note.createdAt,
    });
    expect(updated.content).toBe("Second");
    expect(updated.updatedAt).toBeTruthy();
    expect(updated.updatedAt).not.toBe(note.createdAt);
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

// ---- Backfill migration: legacy rows with NULL updated_at ----

describe("updated_at backfill on init", async () => {
  it("backfills updated_at = created_at for pre-existing NULL rows", () => {
    const raw = new Database(":memory:");
    initSchema(raw); // create tables

    // Simulate a legacy row (pre-fix insert path left updated_at NULL).
    raw.prepare(
      "INSERT INTO notes (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("legacy", "old", "2024-01-01T00:00:00.000Z", null);
    const before = raw.prepare("SELECT updated_at FROM notes WHERE id = ?").get("legacy") as {
      updated_at: string | null;
    };
    expect(before.updated_at).toBeNull();

    // Re-run init: migration should backfill without touching the row otherwise.
    initSchema(raw);
    const after = raw.prepare("SELECT created_at, updated_at FROM notes WHERE id = ?").get(
      "legacy",
    ) as { created_at: string; updated_at: string };
    expect(after.updated_at).toBe(after.created_at);
    expect(after.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("leaves rows whose updated_at is already set untouched", () => {
    const raw = new Database(":memory:");
    initSchema(raw);

    raw.prepare(
      "INSERT INTO notes (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("edited", "content", "2024-01-01T00:00:00.000Z", "2024-06-15T12:00:00.000Z");

    initSchema(raw); // migration is idempotent

    const row = raw.prepare("SELECT created_at, updated_at FROM notes WHERE id = ?").get(
      "edited",
    ) as { created_at: string; updated_at: string };
    expect(row.created_at).toBe("2024-01-01T00:00:00.000Z");
    expect(row.updated_at).toBe("2024-06-15T12:00:00.000Z");
  });

  it("is a no-op for a fresh vault with zero notes", () => {
    const raw = new Database(":memory:");
    initSchema(raw);
    initSchema(raw);
    const count = raw.prepare("SELECT COUNT(*) as c FROM notes").get() as { c: number };
    expect(count.c).toBe(0);
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

// ---- Tag rename + merge ----

describe("renameTag", async () => {
  it("retags every note and drops the old tag", async () => {
    const n1 = await store.createNote("A", { tags: ["voice"] });
    const n2 = await store.createNote("B", { tags: ["voice", "keeper"] });

    const result = await store.renameTag("voice", "memo");
    expect(result).toEqual({ renamed: 2 });

    expect((await store.getNote(n1.id))!.tags).toEqual(["memo"]);
    expect((await store.getNote(n2.id))!.tags?.sort()).toEqual(["keeper", "memo"]);
    const tags = await store.listTags();
    expect(tags.some((t) => t.name === "voice")).toBe(false);
    expect(tags.find((t) => t.name === "memo")!.count).toBe(2);
  });

  it("carries the schema row onto the new tag name", async () => {
    await store.createNote("A", { tags: ["voice"] });
    await store.upsertTagSchema("voice", {
      description: "Voice memos",
      fields: { transcribed: { type: "boolean" } },
    });

    await store.renameTag("voice", "memo");

    expect(await store.getTagSchema("voice")).toBeNull();
    const schema = await store.getTagSchema("memo");
    expect(schema?.description).toBe("Voice memos");
    expect(schema?.fields?.transcribed.type).toBe("boolean");
  });

  it("renames an unused tag (zero notes)", async () => {
    await store.createNote("A", { tags: ["doomed"] });
    await store.untagNote((await store.queryNotes({}))[0].id, ["doomed"]);

    const result = await store.renameTag("doomed", "archived");
    expect(result).toEqual({ renamed: 0 });
    const tags = await store.listTags();
    expect(tags.some((t) => t.name === "doomed")).toBe(false);
    expect(tags.some((t) => t.name === "archived")).toBe(true);
  });

  it("returns target_exists without mutating when new_name already in use", async () => {
    await store.createNote("A", { tags: ["old"] });
    await store.createNote("B", { tags: ["new"] });

    const result = await store.renameTag("old", "new");
    expect(result).toEqual({ error: "target_exists" });

    // No bleed — both tags still present with their original counts.
    const tags = await store.listTags();
    expect(tags.find((t) => t.name === "old")!.count).toBe(1);
    expect(tags.find((t) => t.name === "new")!.count).toBe(1);
  });

  it("returns not_found when source tag does not exist", async () => {
    const result = await store.renameTag("nope", "something");
    expect(result).toEqual({ error: "not_found" });
  });

  it("same-name rename is a no-op on an existing tag", async () => {
    await store.createNote("A", { tags: ["voice"] });
    const result = await store.renameTag("voice", "voice");
    expect(result).toEqual({ renamed: 0 });
    expect((await store.listTags()).find((t) => t.name === "voice")!.count).toBe(1);
  });
});

describe("mergeTags", async () => {
  it("retags every note from every source onto target and drops sources", async () => {
    const n1 = await store.createNote("A", { tags: ["v1"] });
    const n2 = await store.createNote("B", { tags: ["v2"] });
    const n3 = await store.createNote("C", { tags: ["v1", "v2"] });

    const result = await store.mergeTags(["v1", "v2"], "voice");
    expect(result.target).toBe("voice");
    expect(result.merged).toEqual({ v1: 2, v2: 2 });

    expect((await store.getNote(n1.id))!.tags).toEqual(["voice"]);
    expect((await store.getNote(n2.id))!.tags).toEqual(["voice"]);
    expect((await store.getNote(n3.id))!.tags).toEqual(["voice"]);
    const tags = await store.listTags();
    expect(tags.some((t) => t.name === "v1")).toBe(false);
    expect(tags.some((t) => t.name === "v2")).toBe(false);
    expect(tags.find((t) => t.name === "voice")!.count).toBe(3);
  });

  it("creates target if it does not exist", async () => {
    await store.createNote("A", { tags: ["old"] });
    const result = await store.mergeTags(["old"], "brand-new");
    expect(result).toEqual({ merged: { old: 1 }, target: "brand-new" });
    expect((await store.listTags()).find((t) => t.name === "brand-new")!.count).toBe(1);
  });

  it("leaves target's schema intact; drops sources' schemas", async () => {
    await store.createNote("A", { tags: ["v1"] });
    await store.createNote("B", { tags: ["voice"] });
    await store.upsertTagSchema("v1", { description: "legacy" });
    await store.upsertTagSchema("voice", { description: "the keeper" });

    await store.mergeTags(["v1"], "voice");

    expect(await store.getTagSchema("v1")).toBeNull();
    expect((await store.getTagSchema("voice"))!.description).toBe("the keeper");
  });

  it("dedups duplicate sources in the request", async () => {
    await store.createNote("A", { tags: ["v1"] });
    const result = await store.mergeTags(["v1", "v1"], "voice");
    // A duplicated source counts once — not twice.
    expect(result.merged).toEqual({ v1: 1 });
  });

  it("silently skips target when it appears in sources", async () => {
    await store.createNote("A", { tags: ["v1", "voice"] });
    const result = await store.mergeTags(["v1", "voice"], "voice");
    // voice is target; it should drop out of sources, not be deleted.
    expect(result.merged).toEqual({ v1: 1 });
    expect((await store.listTags()).some((t) => t.name === "voice")).toBe(true);
  });

  it("records 0 for sources that do not exist", async () => {
    await store.createNote("A", { tags: ["real"] });
    const result = await store.mergeTags(["real", "ghost"], "voice");
    expect(result.merged).toEqual({ real: 1, ghost: 0 });
  });

  it("is idempotent on notes that already have the target tag", async () => {
    // Both source and target tags present on the same note. Merge must not
    // blow up on the INSERT OR IGNORE into note_tags.
    const note = await store.createNote("A", { tags: ["v1", "voice"] });
    const result = await store.mergeTags(["v1"], "voice");
    expect(result.merged).toEqual({ v1: 1 });
    expect((await store.getNote(note.id))!.tags).toEqual(["voice"]);
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
    expect(stats.linkCount).toBe(0);
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
    expect(stats).toHaveProperty("linkCount");
  });

  it("counts resolved wikilinks in linkCount", async () => {
    await store.createNote("Target A", { path: "alpha" });
    await store.createNote("Target B", { path: "beta" });
    await store.createNote("Refs both [[alpha]] and [[beta]]", { path: "hub" });
    await store.createNote("Refs alpha only [[alpha]]", { path: "solo" });

    const stats = await store.getVaultStats();
    expect(stats.linkCount).toBe(3);
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

  it("has_tags=false returns only untagged notes", async () => {
    await store.createNote("Tagged", { tags: ["daily"] });
    await store.createNote("Plain");

    const results = await store.queryNotes({ hasTags: false });
    expect(results.map((n) => n.content).sort()).toEqual(["Plain"]);
  });

  it("has_tags=true returns only tagged notes", async () => {
    await store.createNote("Tagged", { tags: ["daily"] });
    await store.createNote("Plain");

    const results = await store.queryNotes({ hasTags: true });
    expect(results.map((n) => n.content).sort()).toEqual(["Tagged"]);
  });

  it("has_tags is ignored when `tags` is also provided (tag filter wins)", async () => {
    await store.createNote("A", { tags: ["daily"] });
    await store.createNote("B");

    // tags:["daily"] already constrains to tagged notes; has_tags is a no-op.
    const truthy = await store.queryNotes({ tags: ["daily"], hasTags: true });
    expect(truthy.map((n) => n.content)).toEqual(["A"]);

    // `has_tags: false` would contradict `tags` — but tag filter wins, so "A" still returns.
    const falsy = await store.queryNotes({ tags: ["daily"], hasTags: false });
    expect(falsy.map((n) => n.content)).toEqual(["A"]);
  });

  it("has_links=false returns orphaned notes (no inbound or outbound links)", async () => {
    const a = await store.createNote("A", { id: "ha" });
    const b = await store.createNote("B", { id: "hb" });
    await store.createNote("Orphan", { id: "ho" });
    await store.createLink(a.id, b.id, "mentions");

    const orphans = await store.queryNotes({ hasLinks: false });
    expect(orphans.map((n) => n.content).sort()).toEqual(["Orphan"]);
  });

  it("has_links=true returns notes with any link (inbound or outbound)", async () => {
    const a = await store.createNote("Source", { id: "la" });
    const b = await store.createNote("Target", { id: "lb" });
    await store.createNote("Orphan", { id: "lo" });
    await store.createLink(a.id, b.id, "mentions");

    // Both Source (outbound) and Target (inbound) should appear.
    const linked = await store.queryNotes({ hasLinks: true });
    expect(linked.map((n) => n.content).sort()).toEqual(["Source", "Target"]);
  });

  it("composes has_tags + has_links (untagged and orphaned)", async () => {
    const a = await store.createNote("Tagged+linked", { tags: ["x"], id: "ca" });
    const b = await store.createNote("Plain+linked", { id: "cb" });
    await store.createNote("Tagged+orphan", { tags: ["x"], id: "cc" });
    await store.createNote("Plain+orphan", { id: "cd" });
    await store.createLink(a.id, b.id, "mentions");

    const loners = await store.queryNotes({ hasTags: false, hasLinks: false });
    expect(loners.map((n) => n.content)).toEqual(["Plain+orphan"]);
  });

  it("has_tags=false composes with exclude_tags as a no-op (untagged notes have no tags to exclude)", async () => {
    await store.createNote("Tagged", { tags: ["archived"] });
    await store.createNote("Plain");

    const results = await store.queryNotes({ hasTags: false, excludeTags: ["archived"] });
    expect(results.map((n) => n.content)).toEqual(["Plain"]);
  });

  // ---- Operator objects + order_by on indexed metadata fields ----

  describe("metadata operators + order_by", () => {
    async function seedIndexedPriorities() {
      const { declareField } = await import("./indexed-fields.js");
      declareField(db, "priority", "INTEGER", "project");
      declareField(db, "status", "TEXT", "project");
    }

    it("eq operator on indexed field matches primitive exactly", async () => {
      await seedIndexedPriorities();
      await store.createNote("high", { metadata: { priority: 5 } });
      await store.createNote("low", { metadata: { priority: 1 } });

      const results = await store.queryNotes({ metadata: { priority: { eq: 5 } } });
      expect(results.map((n) => n.content)).toEqual(["high"]);
    });

    it("ne operator returns non-matching rows AND rows without the field", async () => {
      await seedIndexedPriorities();
      await store.createNote("has-1", { metadata: { priority: 1 } });
      await store.createNote("has-2", { metadata: { priority: 2 } });
      await store.createNote("missing"); // no priority at all

      const results = await store.queryNotes({ metadata: { priority: { ne: 1 } } });
      expect(results.map((n) => n.content).sort()).toEqual(["has-2", "missing"]);
    });

    it("gt / gte / lt / lte compose into range queries on one field", async () => {
      await seedIndexedPriorities();
      for (const p of [1, 2, 3, 4, 5]) {
        await store.createNote(`p${p}`, { metadata: { priority: p } });
      }
      const range = await store.queryNotes({ metadata: { priority: { gte: 2, lt: 5 } } });
      expect(range.map((n) => n.content).sort()).toEqual(["p2", "p3", "p4"]);
    });

    it("in and not_in take arrays; empty in returns no rows, empty not_in returns all", async () => {
      await seedIndexedPriorities();
      await store.createNote("a", { metadata: { status: "active" } });
      await store.createNote("b", { metadata: { status: "exploring" } });
      await store.createNote("c", { metadata: { status: "done" } });

      const inResult = await store.queryNotes({ metadata: { status: { in: ["active", "exploring"] } } });
      expect(inResult.map((n) => n.content).sort()).toEqual(["a", "b"]);

      const notInResult = await store.queryNotes({ metadata: { status: { not_in: ["done"] } } });
      // "done" excluded; rows with status=null (none here) would also pass.
      expect(notInResult.map((n) => n.content).sort()).toEqual(["a", "b"]);

      const emptyIn = await store.queryNotes({ metadata: { status: { in: [] } } });
      expect(emptyIn).toHaveLength(0);
    });

    it("exists: true / false distinguishes present vs absent field", async () => {
      await seedIndexedPriorities();
      await store.createNote("has", { metadata: { priority: 3 } });
      await store.createNote("missing");

      const has = await store.queryNotes({ metadata: { priority: { exists: true } } });
      expect(has.map((n) => n.content)).toEqual(["has"]);

      const missing = await store.queryNotes({ metadata: { priority: { exists: false } } });
      expect(missing.map((n) => n.content)).toEqual(["missing"]);
    });

    it("order_by sorts by the indexed field; sort='desc' reverses direction", async () => {
      await seedIndexedPriorities();
      await store.createNote("p3", { metadata: { priority: 3 } });
      await store.createNote("p1", { metadata: { priority: 1 } });
      await store.createNote("p2", { metadata: { priority: 2 } });

      const asc = await store.queryNotes({ orderBy: "priority" });
      expect(asc.map((n) => n.content)).toEqual(["p1", "p2", "p3"]);

      const desc = await store.queryNotes({ orderBy: "priority", sort: "desc" });
      expect(desc.map((n) => n.content)).toEqual(["p3", "p2", "p1"]);
    });

    it("operator objects compose with tag and exclude_tags filters", async () => {
      await seedIndexedPriorities();
      await store.createNote("p5-project", { tags: ["project"], metadata: { priority: 5 } });
      await store.createNote("p3-project", { tags: ["project"], metadata: { priority: 3 } });
      await store.createNote("p5-other", { tags: ["other"], metadata: { priority: 5 } });

      const results = await store.queryNotes({
        tags: ["project"],
        metadata: { priority: { gte: 4 } },
      });
      expect(results.map((n) => n.content)).toEqual(["p5-project"]);
    });

    it("primitive metadata values keep working (backcompat, scan JSON)", async () => {
      // Note: priority is NOT declared indexed here — primitive match still
      // goes through json_extract and doesn't require an index.
      await store.createNote("match", { metadata: { kind: "draft" } });
      await store.createNote("other", { metadata: { kind: "final" } });

      const results = await store.queryNotes({ metadata: { kind: "draft" } });
      expect(results.map((n) => n.content)).toEqual(["match"]);
    });

    it("operator on a non-indexed field throws FIELD_NOT_INDEXED", async () => {
      await store.createNote("x", { metadata: { foo: "bar" } });
      expect(
        store.queryNotes({ metadata: { foo: { eq: "bar" } } }),
      ).rejects.toThrow(/not indexed/);
    });

    it("order_by on a non-indexed field throws FIELD_NOT_INDEXED", async () => {
      await store.createNote("x", { metadata: { foo: 1 } });
      expect(store.queryNotes({ orderBy: "foo" })).rejects.toThrow(/not indexed/);
    });

    it("unknown operator throws UNKNOWN_OPERATOR with supported-op list", async () => {
      await seedIndexedPriorities();
      expect(
        store.queryNotes({ metadata: { priority: { bogus: 5 } as any } }),
      ).rejects.toThrow(/unknown operator "bogus"/);
    });

    it("in/not_in without an array value throws INVALID_OPERATOR_VALUE", async () => {
      await seedIndexedPriorities();
      expect(
        store.queryNotes({ metadata: { priority: { in: 5 } as any } }),
      ).rejects.toThrow(/expects an array/);
    });
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

  it("deleteAttachment removes row and reports orphaned path", async () => {
    const note = await store.createNote("Has attachment");
    const att = await store.addAttachment(note.id, "2026-04-18/pic.png", "image/png");

    const result = await store.deleteAttachment(note.id, att.id);
    expect(result).toEqual({ deleted: true, path: "2026-04-18/pic.png", orphaned: true });
    expect(await store.getAttachments(note.id)).toHaveLength(0);
  });

  it("deleteAttachment returns deleted:false for nonexistent id", async () => {
    const note = await store.createNote("x");
    const result = await store.deleteAttachment(note.id, "does-not-exist");
    expect(result).toEqual({ deleted: false, path: null, orphaned: false });
  });

  it("deleteAttachment is scoped to noteId (cross-note attempt is a no-op)", async () => {
    const a = await store.createNote("A");
    const b = await store.createNote("B");
    const attA = await store.addAttachment(a.id, "files/a.png", "image/png");

    const result = await store.deleteAttachment(b.id, attA.id);
    expect(result.deleted).toBe(false);
    expect(await store.getAttachments(a.id)).toHaveLength(1);
  });

  it("deleteAttachment reports orphaned:false when a sibling attachment shares the path", async () => {
    const a = await store.createNote("A");
    const b = await store.createNote("B");
    const attA = await store.addAttachment(a.id, "shared/pic.png", "image/png");
    await store.addAttachment(b.id, "shared/pic.png", "image/png");

    const result = await store.deleteAttachment(a.id, attA.id);
    expect(result).toEqual({ deleted: true, path: "shared/pic.png", orphaned: false });
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
    const result = await updateNote.execute({ id: note.id, created_at: newDate, force: true }) as any;
    expect(result.createdAt).toBe(newDate);
    expect(result.content).toBe("Test");
  });

  it("update-note tool merges metadata", async () => {
    const note = await store.createNote("Test", { metadata: { existing: "value" } });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = await updateNote.execute({ id: note.id, metadata: { importance: "high" }, force: true }) as any;
    expect(result.metadata).toEqual({ existing: "value", importance: "high" });
  });

  it("update-note tags add/remove works", async () => {
    const note = await store.createNote("Test");
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Add tags
    await updateNote.execute({ id: note.id, tags: { add: ["pinned", "daily"] }, force: true });
    expect((await store.getNote(note.id))!.tags).toContain("pinned");
    expect((await store.getNote(note.id))!.tags).toContain("daily");

    // Remove tags
    await updateNote.execute({ id: note.id, tags: { remove: ["pinned"] }, force: true });
    expect((await store.getNote(note.id))!.tags).not.toContain("pinned");
    expect((await store.getNote(note.id))!.tags).toContain("daily");
  });

  it("update-note links add/remove works", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Add link
    await updateNote.execute({ id: "a", links: { add: [{ target: "b", relationship: "mentions" }] }, force: true });
    expect(await store.getLinks("a", { direction: "outbound" })).toHaveLength(1);

    // Remove link
    await updateNote.execute({ id: "a", links: { remove: [{ target: "b", relationship: "mentions" }] }, force: true });
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
      force: true,
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
        { id: "a", content: "A updated", force: true },
        { id: "b", tags: { add: ["pinned"] }, force: true },
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
    const result = await updateNote.execute({ id: "Projects/README", content: "Updated", force: true }) as any;
    expect(result.content).toBe("Updated");
  });

  it("update-note accepts if_updated_at when it matches current updated_at", async () => {
    const note = await store.createNote("First");
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const first = await updateNote.execute({ id: note.id, content: "Second", force: true }) as any;
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

    const after = await updateNote.execute({ id: note.id, content: "Second", force: true }) as any;

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

  it("update-note if_updated_at conflicts when the caller's timestamp doesn't match", async () => {
    const note = await store.createNote("First");
    // A fresh note has updatedAt === createdAt. Sending a
    // mismatching timestamp must still be rejected as a conflict.
    expect(note.updatedAt).toBe(note.createdAt);
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
    expect(err.current_updated_at).toBe(note.createdAt);
  });

  it("create-note returns updatedAt equal to createdAt on fresh notes", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = await createNote.execute({ content: "Hello" }) as any;
    expect(result.updatedAt).toBeTruthy();
    expect(result.updatedAt).toBe(result.createdAt);
  });

  it("update-note requires if_updated_at or force (precondition-required)", async () => {
    const note = await store.createNote("Test", { path: "Inbox/x" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    let err: any;
    try {
      await updateNote.execute({ id: note.id, content: "changed" });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("PRECONDITION_REQUIRED");
    expect(err.note_id).toBe(note.id);
    expect(err.note_path).toBe("Inbox/x");
    expect((await store.getNote(note.id))!.content).toBe("Test");
  });

  it("update-note force:true bypasses precondition and mutates unconditionally", async () => {
    const note = await store.createNote("First");
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = await updateNote.execute({ id: note.id, content: "Second", force: true }) as any;
    expect(result.content).toBe("Second");
  });

  it("update-note conflict error surfaces note_path", async () => {
    const note = await store.createNote("First", { path: "Inbox/y" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    await updateNote.execute({ id: note.id, content: "Second", force: true });

    let err: any;
    try {
      await updateNote.execute({
        id: note.id,
        content: "Third",
        if_updated_at: "2020-01-01T00:00:00.000Z",
      });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("CONFLICT");
    expect(err.note_path).toBe("Inbox/y");
  });

  it("update-note batch aborts on first conflict without touching subsequent items", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Bump a's updated_at so any stale if_updated_at conflicts.
    const bumped = await updateNote.execute({ id: "a", content: "A bumped", force: true }) as any;
    expect(bumped.updatedAt).toBeTruthy();

    let err: any;
    try {
      await updateNote.execute({
        notes: [
          { id: "a", content: "A new", if_updated_at: "2020-01-01T00:00:00.000Z" },
          { id: "b", content: "B new", force: true },
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
    const seed = await updateNote.execute({ id: note.id, content: "seed-v1", force: true }) as any;
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
    await updateNote.execute({ id: "source", content: "See [[People/Alice]] for details", force: true });
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
    // updatedAt is the optimistic-concurrency token. Callers can't arm a
    // followup update without it, so it must always come back from a
    // single-note fetch.
    expect(result.updatedAt).toBeTruthy();
    expect(result.updatedAt).toBe(note.updatedAt);
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

  it("query-notes has_tags=false surfaces untagged notes", async () => {
    await store.createNote("Tagged", { tags: ["daily"] });
    await store.createNote("Plain");
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ has_tags: false, include_content: true }) as any[];
    expect(result.map((n) => n.content)).toEqual(["Plain"]);
  });

  it("query-notes has_links=false surfaces orphaned notes", async () => {
    const a = await store.createNote("Source", { id: "mq-a" });
    const b = await store.createNote("Target", { id: "mq-b" });
    await store.createNote("Orphan", { id: "mq-o" });
    await store.createLink(a.id, b.id, "mentions");

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ has_links: false, include_content: true }) as any[];
    expect(result.map((n) => n.content)).toEqual(["Orphan"]);
  });

  it("query-notes metadata operator query routes through the indexed column", async () => {
    const { declareField } = await import("./indexed-fields.js");
    declareField(db, "priority", "INTEGER", "project");
    await store.createNote("high", { metadata: { priority: 5 } });
    await store.createNote("mid", { metadata: { priority: 3 } });
    await store.createNote("low", { metadata: { priority: 1 } });

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({
      metadata: { priority: { gte: 3 } },
      include_content: true,
    }) as any[];
    expect(result.map((n) => n.content).sort()).toEqual(["high", "mid"]);
  });

  it("query-notes order_by + sort=desc surfaces highest-priority first", async () => {
    const { declareField } = await import("./indexed-fields.js");
    declareField(db, "priority", "INTEGER", "project");
    await store.createNote("p2", { metadata: { priority: 2 } });
    await store.createNote("p5", { metadata: { priority: 5 } });
    await store.createNote("p1", { metadata: { priority: 1 } });

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({
      order_by: "priority",
      sort: "desc",
      include_content: true,
    }) as any[];
    expect(result.map((n) => n.content)).toEqual(["p5", "p2", "p1"]);
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

// ---- query-notes link expansion ----

describe("query-notes link expansion", async () => {
  it("expands a single [[wikilink]] inline in full mode by default", async () => {
    await store.createNote("# Who I Am\nI teach Taiji.", { path: "Statements/Who" });
    await store.createNote(
      "Canon:\nSee [[Statements/Who]] for identity.",
      { path: "Canon" },
    );
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({
      id: "Canon",
      expand_links: true,
    }) as any;

    expect(result.content).toContain('<expanded path="Statements/Who" mode="full">');
    expect(result.content).toContain("I teach Taiji.");
    expect(result.content).toContain("</expanded>");
  });

  it("summary mode inlines only metadata.summary, not full content", async () => {
    await store.createNote(
      "# Long canonical statement\n\n(Many paragraphs of detail follow...)",
      { path: "Statements/Philosophy", metadata: { summary: "Unforced / wu wei." } },
    );
    await store.createNote("Overview: [[Statements/Philosophy]]", { path: "Index" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({
      id: "Index",
      expand_links: true,
      expand_mode: "summary",
    }) as any;

    expect(result.content).toContain('mode="summary"');
    expect(result.content).toContain("Unforced / wu wei.");
    expect(result.content).not.toContain("Many paragraphs of detail");
  });

  it("deduplicates: a linked note expanded once, subsequent references marked", async () => {
    await store.createNote("target body", { path: "Target" });
    await store.createNote(
      "First [[Target]], then [[Target]] again.",
      { path: "Source" },
    );
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({
      id: "Source",
      expand_links: true,
    }) as any;

    // Exactly one <expanded> block.
    const openCount = (result.content.match(/<expanded /g) ?? []).length;
    expect(openCount).toBe(1);
    expect(result.content).toContain("(expanded above)");
  });

  it("cycle guard: A→B→A does not expand A inside B", async () => {
    await store.createNote("A body with [[B]] reference.", { path: "A" });
    await store.createNote("B body with [[A]] reference.", { path: "B" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({
      id: "A",
      expand_links: true,
      expand_depth: 3,
    }) as any;

    // A appears as the container but should only be expanded once (in the top-level note).
    // B is expanded inside A; inside B, the [[A]] reference should NOT re-expand A.
    const expandedOpens = (result.content.match(/<expanded path="(A|B)" mode="full">/g) ?? []).length;
    expect(expandedOpens).toBe(1); // only B is expanded; A is the top note, never re-expanded
    expect(result.content).toContain("(expanded above)"); // B's reference to A becomes the marker
  });

  it("expand_depth=1 (default) expands top-level wikilinks but not nested ones", async () => {
    await store.createNote("leaf content", { path: "Leaf" });
    await store.createNote("middle body with [[Leaf]] inside", { path: "Middle" });
    await store.createNote("root references [[Middle]]", { path: "Root" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({ id: "Root", expand_links: true }) as any;

    expect(result.content).toContain('<expanded path="Middle"');
    // Middle's content is inlined, including its raw [[Leaf]] reference — but Leaf is NOT expanded.
    expect(result.content).toContain("[[Leaf]]");
    expect(result.content).not.toContain('<expanded path="Leaf"');
  });

  it("expand_depth=2 recurses one additional level", async () => {
    await store.createNote("leaf content", { path: "Leaf" });
    await store.createNote("middle [[Leaf]] inside", { path: "Middle" });
    await store.createNote("root references [[Middle]]", { path: "Root" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({
      id: "Root",
      expand_links: true,
      expand_depth: 2,
    }) as any;

    expect(result.content).toContain('<expanded path="Middle"');
    expect(result.content).toContain('<expanded path="Leaf"');
    expect(result.content).toContain("leaf content");
  });

  it("expand_depth is clamped to MAX_EXPAND_DEPTH (3)", async () => {
    await store.createNote("level-4", { path: "L4" });
    await store.createNote("level-3 [[L4]]", { path: "L3" });
    await store.createNote("level-2 [[L3]]", { path: "L2" });
    await store.createNote("level-1 [[L2]]", { path: "L1" });
    await store.createNote("root [[L1]]", { path: "Root" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    // Request depth=99 — should clamp to 3, so L4 is NOT expanded.
    const result = await query.execute({
      id: "Root",
      expand_links: true,
      expand_depth: 99,
    }) as any;

    expect(result.content).toContain('<expanded path="L1"');
    expect(result.content).toContain('<expanded path="L2"');
    expect(result.content).toContain('<expanded path="L3"');
    expect(result.content).not.toContain('<expanded path="L4"');
    expect(result.content).toContain("[[L4]]"); // raw, beyond clamp
  });

  it("leaves unresolved [[wikilinks]] unchanged", async () => {
    await store.createNote("root mentions [[DoesNotExist]]", { path: "Root" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({ id: "Root", expand_links: true }) as any;
    expect(result.content).toBe("root mentions [[DoesNotExist]]");
  });

  it("expand_links: false (default) leaves content untouched", async () => {
    await store.createNote("target body", { path: "Target" });
    await store.createNote("before [[Target]] after", { path: "Source" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({ id: "Source" }) as any;
    expect(result.content).toBe("before [[Target]] after");
    expect(result.content).not.toContain("<expanded");
  });

  it("list queries expand per-note and dedup across the result", async () => {
    await store.createNote("shared body", { path: "Shared" });
    await store.createNote(
      "first note references [[Shared]]",
      { path: "A", tags: ["list-test"] },
    );
    await store.createNote(
      "second note also references [[Shared]]",
      { path: "B", tags: ["list-test"] },
    );
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({
      tag: ["list-test"],
      include_content: true,
      expand_links: true,
      sort: "asc",
    }) as any[];

    expect(result).toHaveLength(2);
    const expandedBlocks = result
      .map((n) => (n.content.match(/<expanded /g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(expandedBlocks).toBe(1); // shared note expanded exactly once total
    const withMarker = result.find((n) => n.content.includes("(expanded above)"));
    expect(withMarker).toBeTruthy();
  });

  it("self-reference does not expand (note can't inline itself)", async () => {
    await store.createNote("I reference [[Self]] in my own body.", { path: "Self" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({ id: "Self", expand_links: true }) as any;
    expect(result.content).not.toContain("<expanded");
    expect(result.content).toContain("(expanded above)");
  });

  it("handles [[Target|alias]] and [[Target#anchor]] wikilink forms", async () => {
    await store.createNote("target body", { path: "Target" });
    await store.createNote(
      "See [[Target|the target]] or [[Target#section]].",
      { path: "Source" },
    );
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({ id: "Source", expand_links: true }) as any;
    // Both references resolve to same target — first expands, second marked.
    const openCount = (result.content.match(/<expanded /g) ?? []).length;
    expect(openCount).toBe(1);
    expect(result.content).toContain("(expanded above)");
  });

  it("does not expand wikilinks inside fenced code blocks", async () => {
    await store.createNote("target body", { path: "Target" });
    await store.createNote(
      "Example code:\n```\n[[Target]]\n```\nAnd a real link: [[Target]].",
      { path: "Src" },
    );
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({ id: "Src", expand_links: true }) as any;

    // The fenced [[Target]] stays verbatim; the real one gets expanded exactly once.
    const expandedOpens = (result.content.match(/<expanded /g) ?? []).length;
    expect(expandedOpens).toBe(1);
    expect(result.content).toContain("```\n[[Target]]\n```");
  });

  it("does not expand wikilinks inside inline code", async () => {
    await store.createNote("target body", { path: "Target" });
    await store.createNote(
      "Pass `[[Target]]` to render a link. A real one: [[Target]].",
      { path: "Src" },
    );
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({ id: "Src", expand_links: true }) as any;
    const expandedOpens = (result.content.match(/<expanded /g) ?? []).length;
    expect(expandedOpens).toBe(1);
    expect(result.content).toContain("`[[Target]]`");
  });

  it("expand_depth=0 is a no-op (no expansion performed)", async () => {
    await store.createNote("target body", { path: "Target" });
    await store.createNote("see [[Target]]", { path: "Src" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({
      id: "Src",
      expand_links: true,
      expand_depth: 0,
    }) as any;
    expect(result.content).toBe("see [[Target]]");
  });

  it("expand_links=true is a silent no-op when include_content=false", async () => {
    await store.createNote("target body", { path: "Target" });
    await store.createNote("see [[Target]]", { path: "Src", tags: ["silent"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    // List mode defaults to include_content=false; expansion has nothing to
    // operate on, so the result is the standard lean/index shape.
    const result = await query.execute({ tag: ["silent"], expand_links: true }) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].content).toBeUndefined();
    expect(result[0].preview).toBeTruthy();
  });

  it("expand_mode=summary with no metadata.summary renders empty body inline", async () => {
    await store.createNote("unsummarized body", { path: "Plain" });
    await store.createNote("see [[Plain]]", { path: "Src" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;

    const result = await query.execute({
      id: "Src",
      expand_links: true,
      expand_mode: "summary",
    }) as any;
    expect(result.content).toContain('mode="summary"');
    // Summary is empty — we still get the block but with nothing between delimiters.
    expect(result.content).not.toContain("unsummarized body");
  });
});
