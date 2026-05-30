import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import { initSchema } from "./schema.js";
import { decodeCursor } from "./cursor.js";

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

  // ---- PathConflictError: typed 409 on duplicate path (#126) ----

  it("createNote throws PathConflictError when path is taken (#126)", async () => {
    await store.createNote("First", { path: "Inbox/note" });
    let caught: any;
    try {
      await store.createNote("Second", { path: "Inbox/note" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe("PATH_CONFLICT");
    expect(caught.path).toBe("Inbox/note");
  });

  it("createNote on path collision does not insert the second note (#126)", async () => {
    await store.createNote("First", { id: "a", path: "Inbox/note" });
    try {
      await store.createNote("Second", { id: "b", path: "Inbox/note" });
    } catch {}
    expect(await store.getNote("b")).toBeNull();
  });

  it("updateNote throws PathConflictError when renaming onto an existing path (#126)", async () => {
    const a = await store.createNote("First", { path: "a" });
    await store.createNote("Second", { path: "b" });
    let caught: any;
    try {
      await store.updateNote(a.id, { path: "b", if_updated_at: a.createdAt });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe("PATH_CONFLICT");
    expect(caught.path).toBe("b");
  });

  it("updateNote with no path collision still succeeds (#126 — no false positives)", async () => {
    const a = await store.createNote("First", { path: "a" });
    await store.createNote("Second", { path: "b" });
    const updated = await store.updateNote(a.id, { path: "c", if_updated_at: a.createdAt });
    expect(updated.path).toBe("c");
  });

  it("updateNote with no path field is unaffected by the path-conflict guard (#126)", async () => {
    const a = await store.createNote("First", { path: "a" });
    const updated = await store.updateNote(a.id, { content: "edited", if_updated_at: a.createdAt });
    expect(updated.content).toBe("edited");
    expect(updated.path).toBe("a");
  });

  // -------------------------------------------------------------------------
  // Empty content is a valid state (vault#323)
  // -------------------------------------------------------------------------
  // Skeleton notes, drafts saved before content, organizing-only notes,
  // capture-then-fill flows. The earlier #213 guard rejected `content +
  // path both absent` — we no longer enforce it because real vaults
  // legitimately carry such rows and the round-trip import has to accept
  // them.

  it("createNote accepts empty content with no path", async () => {
    const n = await store.createNote("");
    expect(n.content).toBe("");
    expect(n.path).toBeUndefined();
  });

  it("createNote accepts whitespace-only content with no path", async () => {
    const n = await store.createNote("   ");
    expect(n.content).toBe("   ");
  });

  it("createNote empty-content note is queryable + survives round-trip", async () => {
    const created = await store.createNote("", { metadata: { kind: "skeleton" } });
    const fetched = await store.getNote(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe("");
    expect(fetched!.metadata).toMatchObject({ kind: "skeleton" });
  });

  it("createNote accepts content-only (un-pathed jot)", async () => {
    const n = await store.createNote("just a jot");
    expect(n.content).toBe("just a jot");
    expect(n.path).toBeUndefined();
  });

  it("createNote accepts path-only (wikilink placeholder / _schemas/* shape)", async () => {
    const n = await store.createNote("", { path: "wiki/placeholder" });
    expect(n.content).toBe("");
    expect(n.path).toBe("wiki/placeholder");
  });

  it("updateNote allows clearing both content and path", async () => {
    const n = await store.createNote("body", { path: "p" });
    const updated = await store.updateNote(n.id, {
      content: "",
      path: "",
      if_updated_at: n.createdAt,
    });
    expect(updated.content).toBe("");
    expect(updated.path).toBeUndefined();
  });

  it("updateNote allows clearing content when path is already null", async () => {
    const n = await store.createNote("body");
    const updated = await store.updateNote(n.id, {
      content: "",
      if_updated_at: n.createdAt,
    });
    expect(updated.content).toBe("");
  });

  it("updateNote allows clearing content when path is set (or being set)", async () => {
    const n = await store.createNote("body", { path: "p" });
    const updated = await store.updateNote(n.id, { content: "", if_updated_at: n.createdAt });
    expect(updated.content).toBe("");
    expect(updated.path).toBe("p");
  });

  it("updateNote with metadata-only update against a (legacy) empty row passes", async () => {
    // Tag/metadata-only updates don't touch content or path, so they don't
    // trigger the new guard — important so any pre-existing empty rows
    // (from before #213) can still be cleaned up via metadata operations.
    const n = await store.createNote("seed", { path: "x" });
    // Simulate a legacy row by directly clearing content via SQL (bypasses
    // the guard); this mirrors what an old data row could look like.
    db.prepare("UPDATE notes SET content = '', path = NULL WHERE id = ?").run(n.id);
    const updated = await store.updateNote(n.id, {
      metadata: { tag: "cleanup" },
      if_updated_at: n.createdAt,
    });
    expect(updated.metadata).toMatchObject({ tag: "cleanup" });
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

// ---- Extension (vault#328 Phase 1: DB + Store) ----
//
// Three pinned behaviors:
//   1. Migrations and inserts default to "md" — every existing row keeps
//      its meaning after the v17 → v18 ALTER TABLE.
//   2. Explicit extension on createNote persists end-to-end.
//   3. queryNotes filters by extension (single string + array shapes).

describe("notes.extension (vault#328)", async () => {
  it("defaults to 'md' when not specified on createNote", async () => {
    const note = await store.createNote("hello world");
    expect(note.extension).toBe("md");
    const fetched = await store.getNote(note.id);
    expect(fetched!.extension).toBe("md");
  });

  it("persists explicit extension on createNote", async () => {
    const note = await store.createNote("month,income\n2026-01,12000", {
      path: "Tabular/budget",
      extension: "csv",
    });
    expect(note.extension).toBe("csv");
    const fetched = await store.getNote(note.id);
    expect(fetched!.extension).toBe("csv");
  });

  it("backfills 'md' on existing rows after v17 → v18 migration", () => {
    // Build a v17-shape vault by hand: create the notes table WITHOUT the
    // `extension` column, insert a row, then run initSchema and assert
    // the migration backfills "md".
    const raw = new Database(":memory:");
    raw.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        content TEXT DEFAULT '',
        path TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `);
    raw.prepare(
      "INSERT INTO notes (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("legacy", "old content", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");

    initSchema(raw); // applies v18 ALTER TABLE

    const row = raw.prepare("SELECT extension FROM notes WHERE id = ?").get("legacy") as {
      extension: string;
    };
    expect(row.extension).toBe("md");
  });

  it("updateNote changes extension on existing note", async () => {
    const note = await store.createNote("hello", { path: "Foo" });
    expect(note.extension).toBe("md");
    const updated = await store.updateNote(note.id, { extension: "mdx" });
    expect(updated.extension).toBe("mdx");
    const fetched = await store.getNote(note.id);
    expect(fetched!.extension).toBe("mdx");
  });

  it("queryNotes filters by extension (single string)", async () => {
    await store.createNote("md note A", { path: "a", extension: "md" });
    await store.createNote("csv note", { path: "b", extension: "csv" });
    await store.createNote("md note B", { path: "c" }); // default md
    const csv = await store.queryNotes({ extension: "csv" });
    expect(csv).toHaveLength(1);
    expect(csv[0]!.path).toBe("b");
    const md = await store.queryNotes({ extension: "md" });
    expect(md).toHaveLength(2);
    expect(md.map((n) => n.path).sort()).toEqual(["a", "c"]);
  });

  it("queryNotes filters by extension (array — IN clause)", async () => {
    await store.createNote("md note", { path: "a" });
    await store.createNote("csv note", { path: "b", extension: "csv" });
    await store.createNote("yaml note", { path: "c", extension: "yaml" });
    await store.createNote("json note", { path: "d", extension: "json" });
    const results = await store.queryNotes({ extension: ["csv", "yaml", "json"] });
    expect(results).toHaveLength(3);
    const paths = results.map((n) => n.path).sort();
    expect(paths).toEqual(["b", "c", "d"]);
  });

  it("queryNotes extension filter is case-insensitive", async () => {
    await store.createNote("csv note", { path: "b", extension: "csv" });
    // Caller-supplied case shouldn't matter — stored as "csv", looked up as "CSV".
    const results = await store.queryNotes({ extension: "CSV" });
    expect(results).toHaveLength(1);
  });

  it("updateNote extension-only collision throws PathConflictError (vault#329 F1)", async () => {
    // Two notes share `Foo` differing only by extension — legal under
    // v18's composite (path, extension) uniqueness. Flip the md note's
    // extension to "csv": that would collide with the existing csv
    // row. The catch in updateNote must surface PATH_CONFLICT (not a
    // raw SQLiteError) since the composite index fires UNIQUE on
    // extension-only updates just like it does on path-only updates.
    const md = await store.createNote("# md note", { path: "Foo", id: "foo-md" });
    await store.createNote("a,b\n1,2", { path: "Foo", extension: "csv", id: "foo-csv" });
    expect(
      store.updateNote(md.id, { extension: "csv" }),
    ).rejects.toMatchObject({ code: "PATH_CONFLICT", path: "Foo" });
  });

  it("getNoteByPath throws AmbiguousPathError when path matches multiple extensions (vault#330 S1)", async () => {
    await store.createNote("# md", { path: "Foo", id: "foo-md" });
    await store.createNote("a,b\n1,2", { path: "Foo", extension: "csv", id: "foo-csv" });
    expect(store.getNoteByPath("Foo")).rejects.toMatchObject({
      code: "AMBIGUOUS_PATH",
      path: "Foo",
    });
  });

  it("getNoteByPath returns the right note when extension is passed (vault#330 S1)", async () => {
    await store.createNote("# md", { path: "Foo", id: "foo-md" });
    await store.createNote("a,b\n1,2", { path: "Foo", extension: "csv", id: "foo-csv" });
    const md = await store.getNoteByPath("Foo", "md");
    const csv = await store.getNoteByPath("Foo", "csv");
    expect(md!.id).toBe("foo-md");
    expect(csv!.id).toBe("foo-csv");
  });

  it("getNoteByPath returns single match unchanged when no ambiguity (vault#330 S1 back-compat)", async () => {
    await store.createNote("# only", { path: "Foo", id: "only" });
    const note = await store.getNoteByPath("Foo");
    expect(note!.id).toBe("only");
  });

  it("getNoteByPath returns null for unknown path (vault#330 S1 back-compat)", async () => {
    const note = await store.getNoteByPath("DoesNotExist");
    expect(note).toBeNull();
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
    expect(result).toMatchObject({ renamed: 2, sub_tags_renamed: 0 });

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
    expect(result).toMatchObject({ renamed: 0, sub_tags_renamed: 0 });
    const tags = await store.listTags();
    expect(tags.some((t) => t.name === "doomed")).toBe(false);
    expect(tags.some((t) => t.name === "archived")).toBe(true);
  });

  it("returns target_exists without mutating when new_name already in use", async () => {
    await store.createNote("A", { tags: ["old"] });
    await store.createNote("B", { tags: ["new"] });

    const result = await store.renameTag("old", "new");
    expect(result).toMatchObject({ error: "target_exists", conflicting: ["new"] });

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
    expect(result).toMatchObject({ renamed: 0, sub_tags_renamed: 0 });
    expect((await store.listTags()).find((t) => t.name === "voice")!.count).toBe(1);
  });
});

// ---- Tag rename cascade (vault#240 + #247) ----

describe("renameTag cascade (vault#240 + #247)", async () => {
  it("1. rewrites note bodies with #tag references", async () => {
    const note = await store.createNote(
      "Today's #task is important. Also see #task/work and the #other tag.",
      { tags: ["task"] },
    );

    const result = await store.renameTag("task", "todo");
    expect(result).toMatchObject({ renamed: 1, notes_rewritten: 1 });

    const fresh = await store.getNote(note.id);
    expect(fresh!.content).toContain("#todo");
    expect(fresh!.content).not.toContain("#task ");
    expect(fresh!.content).toContain("#other"); // untouched
  });

  it("2. cascades sub-tags recursively (task → todo, task/work → todo/work, task/work/client → todo/work/client)", async () => {
    await store.createNote("a", { tags: ["task"] });
    await store.createNote("b", { tags: ["task/work"] });
    await store.createNote("c", { tags: ["task/work/client"] });

    const result = await store.renameTag("task", "todo");
    expect(result).toMatchObject({ renamed: 3, sub_tags_renamed: 2 });

    const tags = (await store.listTags()).map((t) => t.name).sort();
    expect(tags).toContain("todo");
    expect(tags).toContain("todo/work");
    expect(tags).toContain("todo/work/client");
    expect(tags.some((t) => t.startsWith("task"))).toBe(false);
  });

  it("3. rewrites parent_names refs in OTHER tag rows (closes #247)", async () => {
    await store.upsertTagRecord("task", { description: "tasks" });
    await store.upsertTagRecord("voice", {
      parent_names: ["manual", "task"],
    });

    const result = await store.renameTag("task", "todo");
    expect(result).toMatchObject({ renamed: 0, parent_refs_updated: 1 });

    const voice = await store.getTagRecord("voice");
    expect(voice?.parent_names).toEqual(["manual", "todo"]);
  });

  it("4. rewrites tokens.scoped_tags JSON arrays", async () => {
    await store.upsertTagRecord("task", {});
    await store.upsertTagRecord("project", {});

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tokens (token_hash, label, permission, scopes, scoped_tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("h_one", "tok-1", "full", "vault:read", JSON.stringify(["task"]), now);
    db.prepare(
      `INSERT INTO tokens (token_hash, label, permission, scopes, scoped_tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("h_two", "tok-2", "full", "vault:read", JSON.stringify(["project"]), now);

    const result = await store.renameTag("task", "todo");
    expect(result).toMatchObject({ tokens_updated: 1 });

    const refreshed = db
      .prepare("SELECT token_hash, scoped_tags FROM tokens ORDER BY token_hash")
      .all() as { token_hash: string; scoped_tags: string }[];
    expect(JSON.parse(refreshed[0]!.scoped_tags)).toEqual(["todo"]);
    // Untouched.
    expect(JSON.parse(refreshed[1]!.scoped_tags)).toEqual(["project"]);
  });

  it("5. rewrites #tag and [[_tags/...]] references in note bodies (incl. sub-tags)", async () => {
    await store.upsertTagRecord("task/work", {});
    await store.upsertTagRecord("task", {});
    const a = await store.createNote(
      "#task is important #task/work and a wikilink: [[_tags/task]]",
      { tags: ["task"] },
    );

    const result = await store.renameTag("task", "todo");
    expect(result.renamed).toBeGreaterThan(0);
    if ("notes_rewritten" in result) expect(result.notes_rewritten).toBe(1);

    const fresh = await store.getNote(a.id);
    expect(fresh!.content).toContain("#todo is important");
    expect(fresh!.content).toContain("#todo/work");
    expect(fresh!.content).toContain("[[_tags/todo]]");
    expect(fresh!.content).not.toContain("#task ");
    expect(fresh!.content).not.toContain("[[_tags/task]");
  });

  it("6. pre-flight collision aborts without mutation when target exists", async () => {
    await store.createNote("t", { tags: ["task"] });
    await store.createNote("p", { tags: ["project"] });

    const result = await store.renameTag("task", "project");
    expect(result).toMatchObject({ error: "target_exists", conflicting: ["project"] });

    // Both tags still present, untouched counts.
    const tags = await store.listTags();
    expect(tags.find((t) => t.name === "task")?.count).toBe(1);
    expect(tags.find((t) => t.name === "project")?.count).toBe(1);
  });

  it("7. transactional rollback leaves the original state intact on mid-cascade failure", async () => {
    await store.createNote("a", { tags: ["task"] });
    await store.createNote("b", { tags: ["task/work"] });

    // Inject failure: drop the tags table mid-transaction by intercepting
    // the JSON cascade pass. Easiest reliable hook: corrupt the
    // tokens.scoped_tags column with a value that will fail the JSON
    // cascade's UPDATE (use a token_hash that violates a constraint when
    // the cascade rewrites it). Simpler: spy on noteOps via monkey-patch.
    //
    // We use the simplest reliable approach: a row lock conflict. Two
    // statements writing the same row in a deferred transaction would
    // require two connections; instead we drop a required table at the
    // SQL layer to force a SQL error on a downstream UPDATE inside the
    // cascade. Restore after the test.
    const originalDeleteTag = (db as any).prepare;
    let dropOnce = false;
    (db as any).prepare = function (sql: string) {
      // Force the tag-row pass to fail on the DELETE step by dropping
      // the tags table out from under it after the first INSERT.
      if (!dropOnce && sql.startsWith("DELETE FROM tags WHERE name = ?")) {
        dropOnce = true;
        const stmt = originalDeleteTag.call(this, sql);
        const wrapped = {
          run: (...args: any[]) => {
            (db as any).prepare = originalDeleteTag;
            throw new Error("synthetic mid-cascade failure");
          },
        };
        return wrapped;
      }
      return originalDeleteTag.call(this, sql);
    };

    let threw = false;
    try {
      await store.renameTag("task", "todo");
    } catch {
      threw = true;
    }
    (db as any).prepare = originalDeleteTag;
    expect(threw).toBe(true);

    // Original state intact: task tags still present, todo absent.
    const tags = (await store.listTags()).map((t) => t.name);
    expect(tags).toContain("task");
    expect(tags).toContain("task/work");
    expect(tags).not.toContain("todo");
    expect(tags).not.toContain("todo/work");
  });

  it("8. invalidates hierarchy + schema caches after rename", async () => {
    await store.upsertTagRecord("task", {
      fields: { status: { type: "string" } },
    });
    await store.upsertTagRecord("task/work", { parent_names: ["task"] });
    await store.createNote("a", { tags: ["task/work"] });

    // Prime the caches by querying via the hierarchy-aware path.
    await store.queryNotes({ tags: ["task"] });

    await store.renameTag("task", "todo");

    // queryNotes via the new tag must find the note that's now tagged
    // todo/work (descendant of todo via parent_names rewrite).
    const found = await store.queryNotes({ tags: ["todo"] });
    expect(found.length).toBe(1);

    // validateNoteAgainstSchemas must surface fields under the new tag —
    // proves the schema-config cache was busted (otherwise the resolver
    // would still be keyed on `task`).
    const status = store.validateNoteAgainstSchemas({
      tags: ["todo"],
      metadata: { status: 123 },
    });
    expect(status?.warnings.some((w) => w.reason === "type_mismatch")).toBe(true);
  });

  it("9. self-rename is a structured no-op when the source exists", async () => {
    await store.createNote("a", { tags: ["task"] });
    const result = await store.renameTag("task", "task");
    expect(result).toMatchObject({ renamed: 0, sub_tags_renamed: 0 });
    expect((await store.listTags()).find((t) => t.name === "task")?.count).toBe(1);
  });

  it("10. preserves transitive inheritance through the cascade (manual extends note; voice extends manual; renaming manual → instruction keeps voice's effective fields)", async () => {
    await store.upsertTagRecord("note", {
      fields: { topic: { type: "string" } },
    });
    await store.upsertTagRecord("manual", {
      fields: { author: { type: "string" } },
      parent_names: ["note"],
    });
    await store.upsertTagRecord("voice", {
      parent_names: ["manual"],
    });

    const result = await store.renameTag("manual", "instruction");
    expect(result.renamed).toBe(0); // no notes
    if ("parent_refs_updated" in result) expect(result.parent_refs_updated).toBe(1);

    // Voice's parent_names now references `instruction` (the renamed parent).
    const voice = await store.getTagRecord("voice");
    expect(voice?.parent_names).toEqual(["instruction"]);

    // Voice's effective fields still inherit through instruction → note.
    const status = store.validateNoteAgainstSchemas({
      tags: ["voice"],
      metadata: { topic: 123, author: "ok" },
    });
    expect(status?.warnings.some((w) => w.field === "topic" && w.reason === "type_mismatch")).toBe(
      true,
    );
  });

  it("11. rewrites indexed_fields.declarer_tags JSON arrays (#275 fold N3)", async () => {
    // Drive through the update-tag MCP tool — it owns indexed-field
    // lifecycle (see mcp.ts §update-tag); store.upsertTagRecord does
    // not populate the `indexed_fields` table.
    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    await updateTag.execute({
      tag: "task",
      fields: { status: { type: "string", indexed: true } },
    });
    await updateTag.execute({
      tag: "project",
      fields: { status: { type: "string", indexed: true } },
    });

    const beforeRow = db
      .prepare("SELECT declarer_tags FROM indexed_fields WHERE field = ?")
      .get("status") as { declarer_tags: string };
    expect(JSON.parse(beforeRow.declarer_tags).sort()).toEqual(["project", "task"]);

    const result = await store.renameTag("task", "todo");
    expect(result).toMatchObject({ indexed_field_declarers_updated: 1 });

    const afterRow = db
      .prepare("SELECT declarer_tags FROM indexed_fields WHERE field = ?")
      .get("status") as { declarer_tags: string };
    const declarers = JSON.parse(afterRow.declarer_tags) as string[];
    expect(declarers).toContain("todo");
    expect(declarers).toContain("project");
    expect(declarers).not.toContain("task");
  });

  it("12. rewrites `_tags/<path>` config-note paths via rewriteTagConfigPath (#275 fold N3)", async () => {
    await store.upsertTagRecord("old", {});
    const root = await store.createNote("root config", { path: "_tags/old" });
    const sub = await store.createNote("sub config", { path: "_tags/old/nested/leaf" });

    const result = await store.renameTag("old", "new");
    expect(result).toMatchObject({ paths_renamed: 2 });

    const rootFresh = await store.getNote(root.id);
    expect(rootFresh?.path).toBe("_tags/new");

    const subFresh = await store.getNote(sub.id);
    expect(subFresh?.path).toBe("_tags/new/nested/leaf");
  });

  it("14. sub-tag discovery escapes LIKE wildcards — `task_` rename doesn't pull `taskX/sub` into the cascade (#275 re-review)", async () => {
    // Pre-fold: the discovery query was `LIKE 'task_/%'` which matches
    // `taskX/sub` because `_` is a single-char wildcard. `taskX/sub`
    // would then enter `renames` and get rewritten to `<new>/sub` — a
    // write the caller never asked for.
    await store.upsertTagRecord("task_", {});
    await store.upsertTagRecord("taskX/sub", {});
    const stray = await store.createNote("stray", { tags: ["taskX/sub"] });

    const result = await store.renameTag("task_", "todo_");
    // Only the actual root rename — no spurious sub-tag pulled in.
    expect(result).toMatchObject({ sub_tags_renamed: 0 });

    expect(await store.getTagRecord("task_")).toBeNull();
    expect(await store.getTagRecord("todo_")).toBeTruthy();

    // `taskX/sub` is untouched: row still present, the note tagged with
    // it still carries the original tag.
    expect(await store.getTagRecord("taskX/sub")).toBeTruthy();
    expect((await store.getNote(stray.id))!.tags).toEqual(["taskX/sub"]);
  });

  it("13. LIKE wildcard escape — a tag literally named `task_` doesn't false-match `taskX` (#275 fold N1)", async () => {
    // `task_` and `taskX` are unrelated tags. Pre-fold N1 the LIKE
    // pre-filter would have considered `taskX` rows as candidates for
    // `task_`'s rewrite (LIKE `%"task_"%` matches `"taskX"` in JSON
    // because `_` is a single-char wildcard). The cascade's downstream
    // remapJsonArray would have rejected the row, so no data
    // corruption — but the wasted scan + bad hygiene is what fold N1
    // closes. This test pins the behavior end-to-end.
    await store.upsertTagRecord("task_", {});
    await store.upsertTagRecord("taskX", {});
    await store.upsertTagRecord("voice", {
      parent_names: ["taskX"],
    });

    await store.renameTag("task_", "renamed_task");

    // taskX-rooted parent_names must be untouched — the escape stops
    // taskX from being a candidate for the `task_` rewrite.
    const voice = await store.getTagRecord("voice");
    expect(voice?.parent_names).toEqual(["taskX"]);
    // Sanity: the actual rename did happen.
    expect(await store.getTagRecord("task_")).toBeNull();
    expect(await store.getTagRecord("renamed_task")).toBeTruthy();
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
    expect(result.attachmentCount).toBe(0);
    expect(result.topTags[0].tag).toBe("x");
    expect(result.topTags[0].count).toBe(2);
    expect(result.notesByMonth).toHaveLength(2);
    expect(result.earliestNote!.createdAt).toBe("2025-05-01T00:00:00.000Z");
    expect(result.latestNote!.createdAt).toBe("2025-06-01T00:00:00.000Z");
  });

  it("getVaultStats counts attachments", async () => {
    const n1 = await store.createNote("one");
    const n2 = await store.createNote("two");
    await store.addAttachment(n1.id, "/tmp/a1.mp3", "audio/mp3");
    await store.addAttachment(n1.id, "/tmp/i1.png", "image/png");
    await store.addAttachment(n2.id, "/tmp/a2.mp3", "audio/mp3");

    const result = await store.getVaultStats();
    expect(result.attachmentCount).toBe(3);
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

  // ---- Generalized date_filter (vault#215) ----
  //
  // The legacy `dateFrom` / `dateTo` always filter on `n.created_at` (vault
  // ingestion time). The new `dateFilter: { field, from, to }` shape lets a
  // caller filter on any *content* date — an email's received date, a
  // meeting's scheduled date — by pointing `field` at an indexed metadata
  // field. `field` defaults to `created_at`, in which case the SQL is
  // identical to the legacy path.
  describe("dateFilter (generalized)", () => {
    async function declareEmailDate() {
      const { declareField } = await import("./indexed-fields.js");
      declareField(db, "email_date", "TEXT", "email");
    }

    it("dateFilter with no field defaults to created_at (matches the legacy shorthand)", async () => {
      await store.createNote("A", { created_at: "2026-01-15T00:00:00.000Z" });
      await store.createNote("B", { created_at: "2026-02-15T00:00:00.000Z" });
      await store.createNote("C", { created_at: "2026-03-15T00:00:00.000Z" });

      const results = await store.queryNotes({
        dateFilter: { from: "2026-02-01", to: "2026-03-01" },
      });
      expect(results.map((n) => n.content)).toEqual(["B"]);
    });

    it("dateFilter on an indexed metadata field filters on content date, not ingestion date", async () => {
      await declareEmailDate();
      // Ingestion order doesn't match email_date order — that's the whole
      // point: the bug was that `dateFrom` returned rows by ingestion time.
      await store.createNote("recently-synced old email", {
        metadata: { email_date: "2025-12-01T00:00:00.000Z" },
      });
      await store.createNote("recently-synced new email", {
        metadata: { email_date: "2026-04-25T00:00:00.000Z" },
      });
      await store.createNote("recently-synced ancient", {
        metadata: { email_date: "2024-08-15T00:00:00.000Z" },
      });

      const results = await store.queryNotes({
        dateFilter: { field: "email_date", from: "2026-04-01", to: "2026-05-01" },
      });
      expect(results.map((n) => n.content)).toEqual(["recently-synced new email"]);
    });

    it("dateFilter on a non-indexed field rejects with FIELD_NOT_INDEXED", async () => {
      await store.createNote("X", { metadata: { meeting_date: "2026-04-25T00:00:00.000Z" } });
      // Note: not declared via declareField, so the field has no generated
      // column. The error mirrors the metadata-operator + order_by gate.
      try {
        await store.queryNotes({
          dateFilter: { field: "meeting_date", from: "2026-04-01" },
        });
        throw new Error("expected QueryError");
      } catch (err: any) {
        expect(err.name).toBe("QueryError");
        expect(err.code).toBe("FIELD_NOT_INDEXED");
        expect(err.message).toContain("meeting_date");
      }
    });

    it("dateFilter combined with top-level dateFrom rejects with INVALID_QUERY", async () => {
      await declareEmailDate();
      try {
        await store.queryNotes({
          dateFrom: "2026-01-01",
          dateFilter: { field: "email_date", from: "2026-04-01" },
        });
        throw new Error("expected QueryError");
      } catch (err: any) {
        expect(err.name).toBe("QueryError");
        expect(err.code).toBe("INVALID_QUERY");
        expect(err.message).toMatch(/cannot combine/i);
      }
    });

    it("dateFilter with only `from` is open-ended on the upper bound", async () => {
      await declareEmailDate();
      await store.createNote("old", { metadata: { email_date: "2025-01-01T00:00:00.000Z" } });
      await store.createNote("middle", { metadata: { email_date: "2026-04-15T00:00:00.000Z" } });
      await store.createNote("new", { metadata: { email_date: "2026-05-01T00:00:00.000Z" } });

      const results = await store.queryNotes({
        dateFilter: { field: "email_date", from: "2026-04-01" },
      });
      expect(results.map((n) => n.content).sort()).toEqual(["middle", "new"]);
    });

    it("dateFilter with explicit field='created_at' routes to the legacy SQL path", async () => {
      // The implicit-default case is covered above; this asserts the explicit
      // form behaves identically — no indexed-field gate, same n.created_at SQL.
      await store.createNote("A", { created_at: "2026-01-15T00:00:00.000Z" });
      await store.createNote("B", { created_at: "2026-02-15T00:00:00.000Z" });
      await store.createNote("C", { created_at: "2026-03-15T00:00:00.000Z" });

      const results = await store.queryNotes({
        dateFilter: { field: "created_at", from: "2026-02-01", to: "2026-03-01" },
      });
      expect(results.map((n) => n.content)).toEqual(["B"]);
    });

    it("query-notes accepts date_filter on an indexed metadata field (vault#215)", async () => {
      await declareEmailDate();
      await store.createNote("old email", {
        metadata: { email_date: "2025-12-01T00:00:00.000Z" },
      });
      await store.createNote("recent email", {
        metadata: { email_date: "2026-04-25T00:00:00.000Z" },
      });

      const tools = generateMcpTools(store);
      const query = tools.find((t) => t.name === "query-notes")!;
      const results = await query.execute({
        date_filter: { field: "email_date", from: "2026-04-01", to: "2026-05-01" },
        include_content: true,
      }) as any[];
      expect(results.map((n) => n.content)).toEqual(["recent email"]);
    });

    // ---- updated_at filter (vault#285 friction point 1.5) ----
    //
    // Incremental-rebuild flows ask "what changed since X." Like `created_at`,
    // `updated_at` is a real column on `notes` (no indexed-field gate), but
    // it tracks the *last write* rather than ingestion time. SSGs paginate
    // against it; sync clients use it as a high-watermark cursor.
    it("dateFilter on updated_at routes to the n.updated_at column (vault#285 1.5)", async () => {
      // Two notes; only one is later modified. The filter should pick up the
      // modification time, not the original creation time.
      const a = await store.createNote("untouched", { created_at: "2026-01-15T00:00:00.000Z" });
      const b = await store.createNote("modified-later", { created_at: "2026-01-20T00:00:00.000Z" });
      // Mutate b to bump its updated_at into a window that excludes a.
      await store.updateNote(b.id, { append: " edit" });

      // Pin each note's updated_at deterministically so the assertion isn't
      // racing real wall-clock writes from the test harness.
      db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
        .run("2026-01-15T00:00:00.000Z", a.id);
      db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
        .run("2026-04-25T00:00:00.000Z", b.id);

      const results = await store.queryNotes({
        dateFilter: { field: "updated_at", from: "2026-04-01" },
      });
      expect(results.map((n) => n.content)).toEqual(["modified-later edit"]);
    });

    it("dateFilter on updated_at requires no indexed-field declaration", async () => {
      // `updated_at` is a recognized real column — must not hit the
      // requireIndexedField gate that fires for arbitrary metadata fields.
      await store.createNote("x");
      // Should not throw.
      const results = await store.queryNotes({
        dateFilter: { field: "updated_at", from: "1970-01-01" },
      });
      expect(Array.isArray(results)).toBe(true);
    });

    it("dateFilter on updated_at honors the upper-bound exclusive `to`", async () => {
      const a = await store.createNote("inside-window");
      const b = await store.createNote("after-window");
      db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
        .run("2026-04-25T00:00:00.000Z", a.id);
      db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
        .run("2026-05-15T00:00:00.000Z", b.id);

      const results = await store.queryNotes({
        dateFilter: { field: "updated_at", from: "2026-04-01", to: "2026-05-01" },
      });
      expect(results.map((n) => n.content)).toEqual(["inside-window"]);
    });
  });

  it("sorts ascending and descending", async () => {
    await store.createNote("First", { id: "first" });
    await store.createNote("Second", { id: "second" });

    const asc = await store.queryNotes({ sort: "asc" });
    expect(asc[0].content).toBe("First");

    const desc = await store.queryNotes({ sort: "desc" });
    expect(desc[0].content).toBe("Second");
  });

  // ---- Cursor pagination (vault#313) ----
  //
  // Opaque cursors for "since last checked" agent loops. The cursor binds
  // to the query's filters via sha256 of the result-set-affecting params;
  // a mismatched cursor raises CursorError. Pagination is keyset on
  // (updated_at, id) so two notes sharing a millisecond don't get skipped
  // or doubled across the page boundary.
  describe("cursor pagination", () => {
    // Helper: pin a note's updated_at to a known value so cursor math
    // doesn't race wall-clock writes from the test harness.
    function pinUpdatedAt(id: string, iso: string) {
      db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(iso, id);
    }

    it("first call returns notes + a next_cursor string", async () => {
      await store.createNote("A", { id: "na" });
      await store.createNote("B", { id: "nb" });
      const page = await store.queryNotesPaged({ tags: [], limit: 50 });
      expect(page.notes.length).toBe(2);
      expect(typeof page.next_cursor).toBe("string");
      expect(page.next_cursor.length).toBeGreaterThan(0);
    });

    it("subsequent call with cursor returns only newer notes", async () => {
      const a = await store.createNote("first", { id: "p1" });
      pinUpdatedAt(a.id, "2026-04-01T00:00:00.000Z");
      const b = await store.createNote("second", { id: "p2" });
      pinUpdatedAt(b.id, "2026-04-02T00:00:00.000Z");

      const page1 = await store.queryNotesPaged({});
      // Both notes returned, cursor advances to "second"'s watermark.
      expect(page1.notes.map((n) => n.id).sort()).toEqual(["p1", "p2"]);

      // No new writes yet — second call should be empty.
      const page2 = await store.queryNotesPaged({ cursor: page1.next_cursor });
      expect(page2.notes).toHaveLength(0);

      // Now write a new note; third call should return only it.
      const c = await store.createNote("third", { id: "p3" });
      pinUpdatedAt(c.id, "2026-04-03T00:00:00.000Z");
      const page3 = await store.queryNotesPaged({ cursor: page2.next_cursor });
      expect(page3.notes.map((n) => n.id)).toEqual(["p3"]);
    });

    it("next_cursor is always returned, even on an empty result page", async () => {
      // No notes at all — first call returns empty array but still a cursor.
      const page = await store.queryNotesPaged({});
      expect(page.notes).toHaveLength(0);
      expect(typeof page.next_cursor).toBe("string");
      expect(page.next_cursor.length).toBeGreaterThan(0);

      // Decode it: empty-page sentinel watermark is millis 0 + empty id.
      const decoded = decodeCursor(page.next_cursor);
      expect(decoded.last_updated_at).toBe(0);
      expect(decoded.last_id).toBe("");
    });

    it("cursor with stale query_hash raises CursorError (cursor_query_mismatch)", async () => {
      await store.createNote("a", { tags: ["x"], id: "qm1" });
      await store.createNote("b", { tags: ["y"], id: "qm2" });

      const page1 = await store.queryNotesPaged({ tags: ["x"] });
      expect(page1.notes.map((n) => n.id)).toEqual(["qm1"]);

      // Reuse the cursor with a different query — must reject loudly.
      try {
        await store.queryNotesPaged({ tags: ["y"], cursor: page1.next_cursor });
        throw new Error("expected CursorError");
      } catch (err: any) {
        expect(err.name).toBe("CursorError");
        expect(err.code).toBe("cursor_query_mismatch");
      }
    });

    it("cursor with malformed payload raises CursorError (cursor_invalid)", async () => {
      try {
        await store.queryNotesPaged({ cursor: "not-a-real-cursor-!!!" });
        throw new Error("expected CursorError");
      } catch (err: any) {
        expect(err.name).toBe("CursorError");
        expect(err.code).toBe("cursor_invalid");
      }
    });

    it("tiebreaker: two notes at the same updated_at use id as the secondary sort key", async () => {
      const ts = "2026-04-15T00:00:00.000Z";
      const a = await store.createNote("alpha", { id: "tb-a" });
      const b = await store.createNote("beta", { id: "tb-b" });
      const c = await store.createNote("gamma", { id: "tb-c" });
      pinUpdatedAt(a.id, ts);
      pinUpdatedAt(b.id, ts);
      pinUpdatedAt(c.id, ts);

      // Page 1 with limit=2: should return a + b (id-ascending tiebreaker).
      const page1 = await store.queryNotesPaged({ limit: 2 });
      expect(page1.notes.map((n) => n.id)).toEqual(["tb-a", "tb-b"]);

      // Page 2 with the cursor: should return c (id > "tb-b" at same ms).
      // Note: c is queried with the same query_hash since limit is
      // excluded from the hash inputs by design.
      const page2 = await store.queryNotesPaged({ limit: 2, cursor: page1.next_cursor });
      expect(page2.notes.map((n) => n.id)).toEqual(["tb-c"]);
    });

    it("cursor advances correctly when notes share a millisecond on the page boundary", async () => {
      // Two notes share the exact updated_at the cursor was minted at.
      // The keyset predicate must include the larger-id one but NOT
      // duplicate the cursor's own note.
      const ts = "2026-04-15T12:34:56.789Z";
      const a = await store.createNote("first-at-ts", { id: "ms-a" });
      pinUpdatedAt(a.id, ts);

      const page1 = await store.queryNotesPaged({ limit: 50 });
      expect(page1.notes.map((n) => n.id)).toEqual(["ms-a"]);

      // Now write a note that lands at the EXACT same updated_at (race
      // window between pages). Its id sorts AFTER "ms-a".
      const b = await store.createNote("second-at-same-ts", { id: "ms-b" });
      pinUpdatedAt(b.id, ts);

      const page2 = await store.queryNotesPaged({ cursor: page1.next_cursor });
      // Must NOT include "ms-a" (we already saw it), MUST include "ms-b"
      // (its id sorts after the cursor's last_id at the same timestamp).
      expect(page2.notes.map((n) => n.id)).toEqual(["ms-b"]);
    });

    it("cursor invariance across reboots: a serialized cursor still resumes correctly", async () => {
      // Cursors are self-contained — they don't reference any server-side
      // state. Simulate a reboot by tearing down the DB+store and replaying
      // the same data; the cursor minted on instance #1 must work against
      // instance #2 with the same query.
      const a1 = await store.createNote("note-1", { id: "reboot-1", path: "n1" });
      pinUpdatedAt(a1.id, "2026-04-01T00:00:00.000Z");
      const a2 = await store.createNote("note-2", { id: "reboot-2", path: "n2" });
      pinUpdatedAt(a2.id, "2026-04-02T00:00:00.000Z");

      const page1 = await store.queryNotesPaged({ limit: 1 });
      expect(page1.notes.map((n) => n.id)).toEqual(["reboot-1"]);
      const cursor = page1.next_cursor;

      // Simulate a process restart with a fresh DB seeded the same way.
      db.close();
      db = new Database(":memory:");
      store = new SqliteStore(db);
      const a1b = await store.createNote("note-1", { id: "reboot-1", path: "n1" });
      pinUpdatedAt(a1b.id, "2026-04-01T00:00:00.000Z");
      const a2b = await store.createNote("note-2", { id: "reboot-2", path: "n2" });
      pinUpdatedAt(a2b.id, "2026-04-02T00:00:00.000Z");

      // The cursor is opaque-but-portable: encodes only millis + id + hash,
      // none of which depend on server-side session state.
      const page2 = await store.queryNotesPaged({ limit: 1, cursor });
      expect(page2.notes.map((n) => n.id)).toEqual(["reboot-2"]);
    });

    it("cursor mode rejects sort: desc (descending iteration would skip new writes)", async () => {
      await store.createNote("a");
      const page = await store.queryNotesPaged({});
      try {
        await store.queryNotesPaged({ cursor: page.next_cursor, sort: "desc" });
        throw new Error("expected QueryError");
      } catch (err: any) {
        expect(err.name).toBe("QueryError");
        expect(err.code).toBe("INVALID_QUERY");
        expect(err.message.toLowerCase()).toContain("ascending");
      }
    });

    it("cursor mode rejects orderBy (mutually exclusive with updated_at keyset)", async () => {
      const { declareField } = await import("./indexed-fields.js");
      declareField(db, "priority", "INTEGER", "task");
      await store.createNote("a", { metadata: { priority: 1 } });
      const page = await store.queryNotesPaged({});
      try {
        await store.queryNotesPaged({ cursor: page.next_cursor, orderBy: "priority" });
        throw new Error("expected QueryError");
      } catch (err: any) {
        expect(err.name).toBe("QueryError");
        expect(err.code).toBe("INVALID_QUERY");
        expect(err.message.toLowerCase()).toContain("order_by");
      }
    });

    it("cursor + tag filter: only notes matching the filter advance the watermark", async () => {
      // Cursor pagination composes with the rest of the query — the
      // watermark tracks the last note that matched the filter, not the
      // last note in the vault.
      const a = await store.createNote("task-1", { tags: ["task"], id: "ct-1" });
      pinUpdatedAt(a.id, "2026-04-01T00:00:00.000Z");
      const b = await store.createNote("not-a-task", { tags: ["other"], id: "ct-2" });
      pinUpdatedAt(b.id, "2026-04-02T00:00:00.000Z");
      const c = await store.createNote("task-2", { tags: ["task"], id: "ct-3" });
      pinUpdatedAt(c.id, "2026-04-03T00:00:00.000Z");

      const page1 = await store.queryNotesPaged({ tags: ["task"] });
      expect(page1.notes.map((n) => n.id).sort()).toEqual(["ct-1", "ct-3"]);

      const page2 = await store.queryNotesPaged({
        tags: ["task"],
        cursor: page1.next_cursor,
      });
      expect(page2.notes).toHaveLength(0);
    });

    it("query_hash is stable across key-order permutations of the same query", async () => {
      // Two semantically-equivalent queries differing only in JS object key
      // order must produce the same cursor binding — otherwise an SDK that
      // reshuffles parameters between calls would silently invalidate the
      // cursor.
      const { computeQueryHash } = await import("./cursor.js");
      const h1 = computeQueryHash({
        tags: ["a", "b"],
        path: "Projects",
        metadata: { status: "open" },
      });
      const h2 = computeQueryHash({
        metadata: { status: "open" },
        path: "Projects",
        tags: ["a", "b"],
      });
      expect(h1).toBe(h2);

      // ...and tag-array order is irrelevant (different SDKs may sort).
      const h3 = computeQueryHash({
        tags: ["b", "a"],
        path: "Projects",
        metadata: { status: "open" },
      });
      expect(h3).toBe(h1);
    });

    it("MCP query-notes: cursor mode returns {notes, next_cursor} envelope", async () => {
      await store.createNote("a", { id: "mcp-a" });
      await store.createNote("b", { id: "mcp-b" });

      const tools = generateMcpTools(store);
      const query = tools.find((t) => t.name === "query-notes")!;

      // First call without cursor returns flat array (legacy shape).
      const firstResult = await query.execute({}) as unknown;
      expect(Array.isArray(firstResult)).toBe(true);

      // Get a cursor by minting one ourselves via the store.
      const seed = await store.queryNotesPaged({});

      // Second call with cursor returns the wrapped envelope.
      const envelope = await query.execute({ cursor: seed.next_cursor }) as any;
      expect(envelope).toHaveProperty("notes");
      expect(envelope).toHaveProperty("next_cursor");
      expect(Array.isArray(envelope.notes)).toBe(true);
      // No new writes since seed → empty page, cursor still advances.
      expect(envelope.notes).toHaveLength(0);
      expect(typeof envelope.next_cursor).toBe("string");
    });
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
  it("generates the consolidated tool set", () => {
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
    // prune-schema (admin) — drops orphaned indexed-field columns whose
    // declaring tags are gone. The gitcoin orphaned-fields fix.
    expect(names).toContain("prune-schema");
    // Six note-schema tools (list/update/delete-note-schema +
    // list/set/delete-schema-mapping) retired in v17 — the standalone
    // note_schemas + schema_mappings subsystem was a parallel path to
    // tags.fields with zero operator usage. See vault#267.
    expect(names).not.toContain("list-note-schemas");
    expect(names).not.toContain("update-note-schema");
    expect(names).not.toContain("delete-note-schema");
    expect(names).not.toContain("list-schema-mappings");
    expect(names).not.toContain("set-schema-mapping");
    expect(names).not.toContain("delete-schema-mapping");
    // synthesize-notes retired in v17 — replicable with query-notes(near=) +
    // find-path + agent-side aggregation. See vault#268.
    expect(names).not.toContain("synthesize-notes");
    expect(tools).toHaveLength(10);
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

  it("create-note accepts extension field (vault#328)", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = await createNote.execute({
      content: "month,income\n2026-01,12000",
      path: "Tabular/budget",
      extension: "csv",
    }) as any;
    expect(result.extension).toBe("csv");
  });

  it("create-note defaults extension to 'md' when omitted (vault#328)", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = await createNote.execute({ content: "plain markdown" }) as any;
    expect(result.extension).toBe("md");
  });

  it("create-note rejects invalid extension (uppercase, dot, reserved) (vault#328)", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    // Uppercase
    expect(createNote.execute({ content: "x", extension: "CSV" })).rejects.toThrow(/invalid extension/);
    // Dot
    expect(createNote.execute({ content: "x", extension: "csv.bak" })).rejects.toThrow(/invalid extension/);
    // Slash
    expect(createNote.execute({ content: "x", extension: "foo/bar" })).rejects.toThrow(/invalid extension/);
    // Reserved "parachute" prefix (lowercase — the pattern check passes,
    // so the reserved-prefix guard is what fires).
    expect(createNote.execute({ content: "x", extension: "parachute" })).rejects.toThrow(/reserved/);
    expect(createNote.execute({ content: "x", extension: "parachutex" })).rejects.toThrow(/reserved/);
    // Too long (>16)
    expect(createNote.execute({ content: "x", extension: "a".repeat(17) })).rejects.toThrow(/invalid extension/);
    // Empty
    expect(createNote.execute({ content: "x", extension: "" })).rejects.toThrow(/non-empty/);
  });

  it("update-note changes extension (vault#328)", async () => {
    const note = await store.createNote("hi", { path: "Foo" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = await updateNote.execute({ id: note.id, extension: "mdx", force: true }) as any;
    expect(result.extension).toBe("mdx");
  });

  it("update-note validates extension on update branch (vault#328)", async () => {
    const note = await store.createNote("hi", { path: "Foo" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    expect(
      updateNote.execute({ id: note.id, extension: "BAD", force: true }),
    ).rejects.toThrow(/invalid extension/);
  });

  it("update-note if_missing=create honors extension (vault#328)", async () => {
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = await updateNote.execute({
      id: "Tabular/new-budget",
      content: "month,total\n2026-02,9000",
      extension: "csv",
      if_missing: "create",
    }) as any;
    expect(result.created).toBe(true);
    expect(result.extension).toBe("csv");
  });

  it("query-notes filters by extension (vault#328)", async () => {
    await store.createNote("md note", { path: "a" });
    await store.createNote("csv note", { path: "b", extension: "csv" });
    await store.createNote("yaml note", { path: "c", extension: "yaml" });
    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;

    // Single extension
    const csv = await queryNotes.execute({ extension: "csv", include_content: true }) as any[];
    expect(csv).toHaveLength(1);
    expect(csv[0].path).toBe("b");

    // Array shape
    const both = await queryNotes.execute({ extension: ["csv", "yaml"], include_content: true }) as any[];
    expect(both).toHaveLength(2);
    expect(both.map((n) => n.path).sort()).toEqual(["b", "c"]);
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

  // ---- include_content response-shape opt-out (vault#285 friction point 2.response) ----
  //
  // Default behavior is unchanged: full Note is returned with `content`.
  // Setting `include_content: false` swaps in the lean NoteIndex shape
  // (drops content, adds byteSize + preview). Cuts the response cost on
  // small-edit / large-note workflows.
  describe("update-note include_content", () => {
    it("defaults to full Note (back-compat)", async () => {
      const note = await store.createNote("Original body", { path: "x" });
      const tools = generateMcpTools(store);
      const updateNote = tools.find((t) => t.name === "update-note")!;
      const result = await updateNote.execute({
        id: note.id,
        content: "Replaced body",
        force: true,
      }) as any;
      expect(result.content).toBe("Replaced body");
      // Index-only fields must NOT appear on the back-compat shape.
      expect(result.byteSize).toBeUndefined();
      expect(result.preview).toBeUndefined();
    });

    it("include_content: false returns the lean NoteIndex shape", async () => {
      const longBody = "a".repeat(5_000);
      const note = await store.createNote(longBody, { path: "big-note" });
      const tools = generateMcpTools(store);
      const updateNote = tools.find((t) => t.name === "update-note")!;
      const result = await updateNote.execute({
        id: note.id,
        append: " edit",
        include_content: false,
      }) as any;
      // No content payload — that's the whole point of the opt-out.
      expect(result.content).toBeUndefined();
      // Index fields present.
      expect(typeof result.byteSize).toBe("number");
      expect(result.byteSize).toBe(5_000 + 5); // original + " edit"
      expect(typeof result.preview).toBe("string");
      expect(result.preview.length).toBeGreaterThan(0);
      expect(result.id).toBe(note.id);
      expect(result.path).toBe("big-note");
      expect(result.updatedAt).toBeTruthy();
    });

    it("include_content: false applies uniformly across batch responses", async () => {
      await store.createNote("A", { id: "a", path: "a" });
      await store.createNote("B", { id: "b", path: "b" });
      const tools = generateMcpTools(store);
      const updateNote = tools.find((t) => t.name === "update-note")!;
      const result = await updateNote.execute({
        include_content: false,
        notes: [
          { id: "a", content: "A v2", force: true },
          { id: "b", append: " v2" },
        ],
      }) as any[];
      expect(result).toHaveLength(2);
      for (const item of result) {
        expect(item.content).toBeUndefined();
        expect(typeof item.byteSize).toBe("number");
        expect(typeof item.preview).toBe("string");
      }
    });

    it("include_content: false preserves validation_status when present", async () => {
      // Declare a tag schema with an indexed `priority` field that constrains
      // values; then write a note whose metadata violates the schema, so
      // attachValidationStatus has something to surface.
      await store.upsertTagSchema("task", {
        description: "tasks",
        fields: {
          priority: { type: "string", enum: ["low", "med", "high"], indexed: false },
        },
      });
      await store.createNote("a task", { id: "t1", tags: ["task"] });
      const tools = generateMcpTools(store);
      const updateNote = tools.find((t) => t.name === "update-note")!;
      const result = await updateNote.execute({
        id: "t1",
        metadata: { priority: "URGENT" }, // not in enum — generates a warning
        include_content: false,
        force: true,
      }) as any;
      expect(result.content).toBeUndefined();
      expect(result.validation_status).toBeTruthy();
      expect(Array.isArray(result.validation_status.warnings)).toBe(true);
      expect(result.validation_status.warnings.length).toBeGreaterThan(0);
    });
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

  it("update-note append concatenates to end without precondition", async () => {
    const note = await store.createNote("first line\n", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // No if_updated_at and no force — append-only is precondition-exempt.
    const result = await updateNote.execute({ id: note.id, append: "second line\n" }) as any;
    expect(result.content).toBe("first line\nsecond line\n");

    const persisted = await store.getNote(note.id);
    expect(persisted!.content).toBe("first line\nsecond line\n");
  });

  it("update-note prepend concatenates to start without precondition", async () => {
    const note = await store.createNote("body", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const result = await updateNote.execute({ id: note.id, prepend: "header\n" }) as any;
    expect(result.content).toBe("header\nbody");
  });

  it("update-note prepend on frontmatter-led content injects after closing --- (#203)", async () => {
    const original = "---\ntitle: Foo\ntags: [bar]\n---\nbody line 1\n";
    const note = await store.createNote(original, { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const result = await updateNote.execute({ id: note.id, prepend: "preamble\n" }) as any;
    // Frontmatter still at byte 0 — parsers expecting `---\n` will find it.
    expect(result.content.startsWith("---\ntitle: Foo\ntags: [bar]\n---\n")).toBe(true);
    // Prepend lands immediately after the closing fence, before the body.
    expect(result.content).toBe(
      "---\ntitle: Foo\ntags: [bar]\n---\npreamble\nbody line 1\n",
    );
  });

  it("update-note prepend on content lacking frontmatter injects at byte 0", async () => {
    const note = await store.createNote("# Heading\nbody\n", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const result = await updateNote.execute({ id: note.id, prepend: "preamble\n" }) as any;
    expect(result.content).toBe("preamble\n# Heading\nbody\n");
  });

  it("update-note append+prepend in one call lands both contributions", async () => {
    const note = await store.createNote("middle", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const result = await updateNote.execute({
      id: note.id,
      prepend: "[start] ",
      append: " [end]",
    }) as any;
    expect(result.content).toBe("[start] middle [end]");
  });

  it("update-note rejects content + append in same call", async () => {
    const note = await store.createNote("body", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    let err: any;
    try {
      await updateNote.execute({ id: note.id, content: "new", append: "more", force: true });
    } catch (e) {
      err = e;
    }
    expect(err?.message).toMatch(/mutually exclusive/);
  });

  it("update-note rejects content + content_edit in same call", async () => {
    const note = await store.createNote("hello world", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    let err: any;
    try {
      await updateNote.execute({
        id: note.id,
        content: "replace",
        content_edit: { old_text: "hello", new_text: "hi" },
        force: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err?.message).toMatch(/mutually exclusive/);
  });

  it("update-note rejects append + content_edit in same call", async () => {
    const note = await store.createNote("hello world", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    let err: any;
    try {
      await updateNote.execute({
        id: note.id,
        append: " more",
        content_edit: { old_text: "hello", new_text: "hi" },
      });
    } catch (e) {
      err = e;
    }
    expect(err?.message).toMatch(/mutually exclusive/);
  });

  it("update-note append still requires precondition when combined with other fields", async () => {
    const note = await store.createNote("body", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // append + metadata is NOT precondition-exempt — metadata mutation
    // can lose data on a stale read, so the safety gate stays in.
    let err: any;
    try {
      await updateNote.execute({ id: note.id, append: " more", metadata: { x: 1 } });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("PRECONDITION_REQUIRED");
  });

  it("update-note append is atomic under concurrent calls — both lands", async () => {
    const note = await store.createNote("seed:", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Two concurrent appends. SQL-level concat means both contributions
    // land — neither overwrites the other.
    const results = await Promise.all([
      updateNote.execute({ id: note.id, append: " A" }),
      updateNote.execute({ id: note.id, append: " B" }),
    ]);
    expect(results).toHaveLength(2);

    const persisted = await store.getNote(note.id);
    // Final content is one of "seed: A B" or "seed: B A" — the order
    // depends on which write got the lock first, but both contributions
    // are present.
    expect(persisted!.content === "seed: A B" || persisted!.content === "seed: B A").toBe(true);
  });

  it("update-note append updates updated_at and respects if_updated_at when supplied", async () => {
    const note = await store.createNote("seed", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // With if_updated_at — succeeds because we're using the right token.
    const ok = await updateNote.execute({ id: note.id, append: " A", if_updated_at: note.updatedAt }) as any;
    expect(ok.content).toBe("seed A");
    expect(ok.updatedAt).not.toBe(note.updatedAt);

    // Stale token — conflict.
    let err: any;
    try {
      await updateNote.execute({ id: note.id, append: " B", if_updated_at: note.updatedAt });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("CONFLICT");
  });

  it("update-note append parses new wikilinks introduced via append", async () => {
    const target = await store.createNote("Alice's note", { id: "alice", path: "People/Alice" });
    const source = await store.createNote("intro\n", { id: "src" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    await updateNote.execute({ id: source.id, append: "see [[People/Alice]]" });

    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links.some((l) => l.targetId === target.id && l.relationship === "wikilink")).toBe(true);
  });

  it("update-note content_edit replaces a single occurrence", async () => {
    const note = await store.createNote("hello world", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const result = await updateNote.execute({
      id: note.id,
      content_edit: { old_text: "hello", new_text: "hi" },
      if_updated_at: note.updatedAt,
    }) as any;
    expect(result.content).toBe("hi world");
  });

  it("update-note content_edit errors when old_text is not found", async () => {
    const note = await store.createNote("hello world", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    let err: any;
    try {
      await updateNote.execute({
        id: note.id,
        content_edit: { old_text: "missing", new_text: "x" },
        if_updated_at: note.updatedAt,
      });
    } catch (e) {
      err = e;
    }
    expect(err?.message).toMatch(/not found/);
    // Note must be untouched.
    const persisted = await store.getNote(note.id);
    expect(persisted!.content).toBe("hello world");
  });

  it("update-note content_edit errors when old_text matches multiple times", async () => {
    const note = await store.createNote("hello hello", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    let err: any;
    try {
      await updateNote.execute({
        id: note.id,
        content_edit: { old_text: "hello", new_text: "hi" },
        if_updated_at: note.updatedAt,
      });
    } catch (e) {
      err = e;
    }
    expect(err?.message).toMatch(/matches multiple times|exactly once/);
    const persisted = await store.getNote(note.id);
    expect(persisted!.content).toBe("hello hello");
  });

  it("update-note content_edit requires precondition by default", async () => {
    const note = await store.createNote("hello world", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    let err: any;
    try {
      await updateNote.execute({
        id: note.id,
        content_edit: { old_text: "hello", new_text: "hi" },
      });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("PRECONDITION_REQUIRED");
  });

  it("update-note content_edit conflicts when if_updated_at is stale", async () => {
    const note = await store.createNote("hello world", { id: "n1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Bump the note so a stale token will conflict at the SQL layer.
    await updateNote.execute({ id: note.id, content: "hello world", force: true });

    let err: any;
    try {
      await updateNote.execute({
        id: note.id,
        content_edit: { old_text: "hello", new_text: "hi" },
        if_updated_at: "2020-01-01T00:00:00.000Z",
      });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("CONFLICT");
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

  it("query-notes near returns neighborhood even when limit is small and unrelated notes were created first (#130)", async () => {
    // Repro of #130: anchor + linked notes get crowded out by unrelated notes
    // when the query runs ORDER BY created_at LIMIT 5 BEFORE the
    // neighborhood filter. With the SQL-pushed ids filter, LIMIT applies to
    // the neighborhood, not the whole notes table.
    //
    // Seed: 10 unrelated notes created first, THEN the anchor + 2 linked
    // notes. With limit=5 and ORDER BY created_at ASC, the unrelated ten
    // would fill the slate and the in-neighborhood notes would never appear.
    for (let i = 0; i < 10; i++) {
      await store.createNote(`Unrelated ${i}`, { id: `unrelated-${i}` });
    }
    await store.createNote("Anchor", { id: "anchor" });
    await store.createNote("Outbound target", { id: "outbound" });
    await store.createNote("Inbound source", { id: "inbound" });
    await store.createLink("anchor", "outbound", "wikilink");
    await store.createLink("inbound", "anchor", "wikilink");

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({
      near: { note_id: "anchor", depth: 2 },
      limit: 5,
    }) as any[];

    const ids = result.map((n: any) => n.id).sort();
    expect(ids).toEqual(["anchor", "inbound", "outbound"]);
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

  // ---- query-notes input-shape tolerance (vault#214) ----
  //
  // The MCP framework drops top-level keys not in the inputSchema without
  // raising — so an LLM caller passing the wrong field name gets a silent
  // no-op rather than an error. We accept canonical + camelCase + singular
  // aliases so the most common LLM mistakes still apply the filter, and
  // we mirror the `tag` param's string-or-array shape so a single excluded
  // tag doesn't need a wrapping array.

  it("query-notes accepts `excludeTags` (camelCase alias)", async () => {
    await store.createNote("a", { tags: ["email"] });
    await store.createNote("b", { tags: ["email", "urgent"] });
    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const r = await queryNotes.execute({ tag: "email", excludeTags: ["urgent"], include_content: true }) as any[];
    expect(r).toHaveLength(1);
    expect(r[0].content).toBe("a");
  });

  it("query-notes accepts `exclude_tag` (singular alias)", async () => {
    await store.createNote("a", { tags: ["email"] });
    await store.createNote("b", { tags: ["email", "urgent"] });
    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const r = await queryNotes.execute({ tag: "email", exclude_tag: "urgent", include_content: true }) as any[];
    expect(r).toHaveLength(1);
    expect(r[0].content).toBe("a");
  });

  it("query-notes `exclude_tags` accepts a single string (mirrors `tag`)", async () => {
    await store.createNote("a", { tags: ["email"] });
    await store.createNote("b", { tags: ["email", "urgent"] });
    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const r = await queryNotes.execute({ tag: "email", exclude_tags: "urgent", include_content: true }) as any[];
    expect(r).toHaveLength(1);
    expect(r[0].content).toBe("a");
  });

  it("query-notes canonical `exclude_tags: [...]` still works (regression)", async () => {
    await store.createNote("a", { tags: ["email"] });
    await store.createNote("b", { tags: ["email", "urgent"] });
    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const r = await queryNotes.execute({ tag: "email", exclude_tags: ["urgent"], include_content: true }) as any[];
    expect(r).toHaveLength(1);
    expect(r[0].content).toBe("a");
  });

  it("query-notes routes through store.queryNotes so tag-hierarchy expansion fires", async () => {
    // `voice` and `text` declare "manual" as their parent via the v14
    // tags.parent_names column. A query for `tag: "manual"` should match
    // notes tagged with either child — that expansion only happens when
    // the call goes through `store.queryNotes`, not `noteOps.queryNotes`
    // directly.
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    await store.upsertTagRecord("text", { parent_names: ["manual"] });
    await store.createNote("voice memo", { tags: ["voice"] });
    await store.createNote("text memo", { tags: ["text"] });
    await store.createNote("unrelated", { tags: ["other"] });

    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const r = await queryNotes.execute({ tag: "manual", include_content: true }) as any[];
    expect(r).toHaveLength(2);
    expect(r.map((n) => n.content).sort()).toEqual(["text memo", "voice memo"]);
  });

  it("query-notes FTS path routes through store.searchNotes so tag-hierarchy expansion fires (vault#227)", async () => {
    // Same fixture shape as the structured-query hierarchy test above, but
    // exercising the search branch. Pre-fix the FTS path called
    // `noteOps.searchNotes` directly and silently dropped descendant matches —
    // `tag: "manual"` would only return notes literally tagged #manual, not
    // notes tagged with the declared children #voice / #text.
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    await store.upsertTagRecord("text", { parent_names: ["manual"] });
    await store.createNote("voice handoff notes", { tags: ["voice"] });
    await store.createNote("text handoff notes", { tags: ["text"] });
    await store.createNote("unrelated handoff", { tags: ["other"] });

    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const r = await queryNotes.execute({ search: "handoff", tag: "manual", include_content: true }) as any[];
    expect(r).toHaveLength(2);
    expect(r.map((n) => n.content).sort()).toEqual(["text handoff notes", "voice handoff notes"]);
    expect(r.map((n) => n.content)).not.toContain("unrelated handoff");
  });

  it("query-notes does not mutate caller's params object across repeated calls", async () => {
    // normalizeTags returns a defensive copy of array inputs so the downstream
    // store layer can sort/dedupe without touching the caller's reference.
    // Without the copy, a caller reusing the same params object would see its
    // exclude_tags array reordered (or worse) on the second call.
    await store.createNote("a", { tags: ["email"] });
    await store.createNote("b", { tags: ["email", "urgent"] });
    await store.createNote("c", { tags: ["email", "spam"] });

    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const params = { tag: "email", exclude_tags: ["urgent", "spam"], include_content: true };

    const r1 = await queryNotes.execute(params) as any[];
    expect(params.exclude_tags).toEqual(["urgent", "spam"]);

    const r2 = await queryNotes.execute(params) as any[];
    expect(params.exclude_tags).toEqual(["urgent", "spam"]);

    expect(r1.map((n) => n.content).sort()).toEqual(["a"]);
    expect(r2.map((n) => n.content).sort()).toEqual(["a"]);
  });

  // ---- empty-note acceptance (vault#323) + batch-cap MCP ----

  it("create-note accepts bare empty content with no path", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = await createNote.execute({ content: "" }) as any;
    expect(result).toBeTruthy();
    const note = Array.isArray(result) ? result[0] : result;
    expect(note.content).toBe("");
    const fetched = await store.getNote(note.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe("");
  });

  it("create-note batch with mixed empty + content entries succeeds end-to-end", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = await createNote.execute({
      notes: [
        { content: "first" },
        { content: "" },
        { content: "third" },
      ],
    }) as any[];
    expect(result).toHaveLength(3);
    expect(result.map((n) => n.content)).toEqual(["first", "", "third"]);
  });

  it("create-note batch over MAX_BATCH_SIZE rejects with BATCH_TOO_LARGE", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const notes = Array.from({ length: 501 }, (_, i) => ({ content: `n${i}` }));
    let err: any;
    try {
      await createNote.execute({ notes });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("BATCH_TOO_LARGE");
    expect(err.limit).toBe(500);
    expect(err.got).toBe(501);
  });

  it("update-note batch over MAX_BATCH_SIZE rejects with BATCH_TOO_LARGE", async () => {
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const notes = Array.from({ length: 501 }, (_, i) => ({
      id: `id${i}`,
      content: "x",
      force: true,
    }));
    let err: any;
    try {
      await updateNote.execute({ notes });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("BATCH_TOO_LARGE");
    expect(err.limit).toBe(500);
    expect(err.got).toBe(501);
  });

  it("create-note batch where mid-item triggers PATH_CONFLICT rolls back prefix items (#236)", async () => {
    // The empty-note pre-walk (#213) catches `{}` before any DB write; a
    // path-conflict can only surface on the actual INSERT, mid-loop. Without
    // the BEGIN/COMMIT wrap the prefix items would have already landed.
    await store.createNote("seed", { path: "taken-236" });
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const beforeIds = (await store.queryNotes({})).map((n) => n.id).sort();

    let err: any;
    try {
      await createNote.execute({
        notes: [
          { content: "ok-1", path: "fresh-236-1" },
          { content: "ok-2", path: "fresh-236-2" },
          { content: "boom", path: "taken-236" },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();

    // The two prefix items must NOT have been created — atomic rollback.
    const afterIds = (await store.queryNotes({})).map((n) => n.id).sort();
    expect(afterIds).toEqual(beforeIds);
    expect(await store.queryNotes({ path: "fresh-236-1" })).toHaveLength(0);
    expect(await store.queryNotes({ path: "fresh-236-2" })).toHaveLength(0);
  });

  it("update-note batch rolls back prefix tag mutation when a later item path-conflicts (#236)", async () => {
    await store.createNote("A", { id: "a236" });
    await store.createNote("B", { id: "b236" });
    await store.createNote("C", { id: "c236", path: "occupied-236" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const aBefore = await store.getNote("a236");

    let err: any;
    try {
      await updateNote.execute({
        notes: [
          // Item 0 mutates a236's content + adds a tag. force=true skips
          // the if_updated_at precondition.
          { id: "a236", content: "A mutated", force: true, tags: { add: ["should-rollback"] } },
          // Item 1 tries to take a path already owned by c236 — PATH_CONFLICT.
          { id: "b236", path: "occupied-236", force: true },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("PATH_CONFLICT");

    // Item 0's tag-add + content change must be rolled back — the batch
    // transaction reverted them when item 1 path-conflicted (#236).
    const aAfter = await store.getNote("a236");
    expect(aAfter!.content).toBe(aBefore!.content);
    expect(aAfter!.tags ?? []).not.toContain("should-rollback");
  });

  it("update-note batch rolls back prefix mutation when a later item if_updated_at-conflicts (#261)", async () => {
    // The companion to the PATH_CONFLICT test above. Item 1's stale
    // `if_updated_at` must surface as a ConflictError so the batch's
    // BEGIN/COMMIT wrap can roll back item 0's mutation.
    //
    // Pre-fix (vault#261): `noteOps.updateNote` checked `res.changes === 0`
    // to detect the precondition miss. Inside this multi-statement batch
    // transaction, `.changes` reported a stale non-zero value from prior
    // writes, so the conflict was silently missed and item 0's mutation
    // committed with item 1 ignored.
    //
    // Post-fix: the conditional UPDATE uses `RETURNING id` and detects the
    // miss directly from row presence. ConflictError fires; batch rolls back.
    //
    // Standalone bun:sqlite repro is pending — six attempted reductions
    // (basic txn, async/microtask, prepared-statement reuse, mcp-loop
    // mirror, hook-dispatch mirror, syncWikilinks-style writes) failed to
    // hit the .changes-stale path outside the full BunStore plumbing. The
    // bug surfaces only through `BunStore.updateNote` → hook dispatch.
    // See vault#261 for the audit trail.
    await store.createNote("A", { id: "a261" });
    await store.createNote("B", { id: "b261" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const aBefore = await store.getNote("a261");

    let err: any;
    try {
      await updateNote.execute({
        notes: [
          // Item 0 mutates a261's content + adds a tag (force, no precondition).
          { id: "a261", content: "A mutated", force: true, tags: { add: ["should-rollback"] } },
          // Item 1 has a stale if_updated_at on b261 — should ConflictError.
          { id: "b261", content: "B should-not-land", if_updated_at: "2020-01-01T00:00:00.000Z" },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("CONFLICT");

    // Item 0's tag-add + content change must be rolled back.
    const aAfter = await store.getNote("a261");
    expect(aAfter!.content).toBe(aBefore!.content);
    expect(aAfter!.tags ?? []).not.toContain("should-rollback");
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

// ---------------------------------------------------------------------------
// Tag hierarchy via tags.parent_names (post-v14, patterns/tag-data-model.md)
// ---------------------------------------------------------------------------

describe("tag hierarchy (tags.parent_names)", async () => {
  it("query for parent tag returns notes tagged with declared child", async () => {
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    await store.createNote("voice note", { tags: ["voice"] });
    await store.createNote("text note", { tags: ["text"] });

    const results = await store.queryNotes({ tags: ["manual"] });
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("voice note");
  });

  it("expands transitively across multiple levels", async () => {
    await store.upsertTagRecord("manual", { parent_names: ["note"] });
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    await store.createNote("voice note", { tags: ["voice"] });
    await store.createNote("manual-only note", { tags: ["manual"] });
    await store.createNote("note-only note", { tags: ["note"] });

    // #note matches all three (note + manual + voice).
    const noteResults = await store.queryNotes({ tags: ["note"] });
    expect(noteResults.length).toBe(3);

    // #manual matches voice + manual-only, not note-only.
    const manualResults = await store.queryNotes({ tags: ["manual"] });
    expect(manualResults.map((n) => n.content).sort()).toEqual([
      "manual-only note",
      "voice note",
    ]);
  });

  it("query for child does not match parent-tagged notes", async () => {
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    await store.createNote("voice note", { tags: ["voice"] });
    await store.createNote("manual-only note", { tags: ["manual"] });

    const results = await store.queryNotes({ tags: ["voice"] });
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("voice note");
  });

  it("supports multiple parents (diamond inheritance)", async () => {
    await store.upsertTagRecord("voice-meeting", { parent_names: ["voice", "meeting"] });
    await store.createNote("vm", { tags: ["voice-meeting"] });
    await store.createNote("v", { tags: ["voice"] });
    await store.createNote("m", { tags: ["meeting"] });

    expect((await store.queryNotes({ tags: ["voice"] })).length).toBe(2); // v + vm
    expect((await store.queryNotes({ tags: ["meeting"] })).length).toBe(2); // m + vm
  });

  it("hierarchy is invalidated when parent_names is set", async () => {
    await store.createNote("voice note", { tags: ["voice"] });
    // Before the parents are declared, #manual matches nothing.
    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(0);

    await store.upsertTagRecord("voice", { parent_names: ["manual"] });

    // After upsert, the cache invalidates and the next query expands.
    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(1);
  });

  it("hierarchy is invalidated when parent_names is repointed", async () => {
    await store.createNote("voice note", { tags: ["voice"] });
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(1);

    // Repoint the parent.
    await store.upsertTagRecord("voice", { parent_names: ["audio"] });

    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(0);
    expect((await store.queryNotes({ tags: ["audio"] })).length).toBe(1);
  });

  it("hierarchy is invalidated when parent_names is cleared", async () => {
    await store.createNote("voice note", { tags: ["voice"] });
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(1);

    await store.upsertTagRecord("voice", { parent_names: null });
    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(0);
  });

  it("hierarchy is invalidated when a parent tag is deleted", async () => {
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    await store.createNote("voice note", { tags: ["voice"] });
    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(1);

    // Drop the child tag — the row holding the parent_names declaration
    // disappears, so the hierarchy edge goes with it.
    await store.deleteTag("voice");
    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(0);
  });

  it("tagMatch=any flattens all expansions across input tags", async () => {
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    await store.createNote("v", { tags: ["voice"] });
    await store.createNote("p", { tags: ["project"] });
    await store.createNote("o", { tags: ["other"] });

    const results = await store.queryNotes({
      tags: ["manual", "project"],
      tagMatch: "any",
    });
    expect(results.map((n) => n.content).sort()).toEqual(["p", "v"]);
  });

  it("tagMatch=all (default) requires each input tag's expanded set to be present", async () => {
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    // Note has both #voice (which satisfies #manual via expansion) AND #project.
    await store.createNote("vp", { tags: ["voice", "project"] });
    await store.createNote("p-only", { tags: ["project"] });

    const results = await store.queryNotes({
      tags: ["manual", "project"], // default tagMatch=all
    });
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("vp");
  });

  it("tolerates a cycle without infinite-looping", async () => {
    await store.upsertTagRecord("a", { parent_names: ["b"] });
    await store.upsertTagRecord("b", { parent_names: ["a"] });
    await store.createNote("note-a", { tags: ["a"] });

    // Both a and b should resolve without hanging; both reach the same set {a, b}.
    expect((await store.queryNotes({ tags: ["a"] })).length).toBe(1);
    expect((await store.queryNotes({ tags: ["b"] })).length).toBe(1);
  });

  it("malformed parent_names JSON is ignored silently", async () => {
    // Stuff a malformed value into the column directly to simulate an
    // out-of-band write. The resolver should drop it without throwing.
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    (store as any).db.prepare("UPDATE tags SET parent_names = ? WHERE name = ?")
      .run("not valid json {{{", "voice");
    // Force cache reload.
    (store as any)._tagHierarchy = null;
    await store.createNote("v", { tags: ["voice"] });

    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(0);
    expect((await store.queryNotes({ tags: ["voice"] })).length).toBe(1);
  });

  it("a tag with no parent_names is a hierarchy no-op", async () => {
    await store.upsertTagRecord("voice", { description: "voice notes" });
    await store.createNote("v", { tags: ["voice"] });
    await store.createNote("m", { tags: ["manual"] });

    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(1);
    expect((await store.queryNotes({ tags: ["voice"] })).length).toBe(1);
  });

  it("legacy `_tags/<name>` notes left in place do not affect the hierarchy", async () => {
    // Post-v14, the resolver reads tags.parent_names — not notes. A leftover
    // `_tags/*` note from a pre-v14 vault is harmless historical record.
    await store.createNote("legacy", {
      path: "_tags/voice",
      metadata: { parents: ["manual"] },
    });
    await store.createNote("voice note", { tags: ["voice"] });

    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Schema validation — driven by `tags.fields` (post-v17, vault#267)
// ---------------------------------------------------------------------------
// Originally written against the `_schemas/<name>` + `_schema_defaults`
// notes-as-config convention (issue #177); rewritten for vault#246 against
// the standalone `note_schemas` + `schema_mappings` tables; rewritten again
// for vault#267 against `tags.fields` after the standalone subsystem retired.
// The validation surface is intentionally smaller now — schemas are tag-axis
// only (no path_prefix) and advisory only (no `required` concept).

describe("schema validation (tags.fields)", async () => {
  it("returns no validation_status when no tag declares fields", async () => {
    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({ content: "plain note" }) as any;
    expect(result.validation_status).toBeUndefined();
  });

  it("returns no validation_status when no tag on the note declares fields", async () => {
    // A different tag has fields, but the note isn't tagged with it.
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "string" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({ content: "plain note", tags: ["other"] }) as any;
    expect(result.validation_status).toBeUndefined();
  });

  it("validation passes (empty warnings) when fields match types", async () => {
    await store.upsertTagSchema("task", {
      fields: {
        priority: { type: "string", enum: ["high", "medium", "low"] },
        done: { type: "boolean" },
      },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "ok",
      tags: ["task"],
      metadata: { priority: "high", done: false },
    }) as any;

    expect(result.validation_status.schemas).toEqual(["task"]);
    expect(result.validation_status.warnings).toEqual([]);
  });

  it("type_mismatch warning when a field's value is the wrong type", async () => {
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "string" }, done: { type: "boolean" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["task"],
      metadata: { priority: "high", done: "yes" }, // wrong: should be boolean
    }) as any;

    expect(result.validation_status.warnings.length).toBe(1);
    expect(result.validation_status.warnings[0].reason).toBe("type_mismatch");
    expect(result.validation_status.warnings[0].field).toBe("done");
  });

  it("enum_mismatch warning when a field's value is outside the declared enum", async () => {
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "string", enum: ["high", "medium", "low"] } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["task"],
      metadata: { priority: "ULTRA" },
    }) as any;

    expect(result.validation_status.warnings[0].reason).toBe("enum_mismatch");
  });

  it("validation never blocks the write — note exists with warnings attached", async () => {
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "boolean" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["task"],
      metadata: { priority: "high" }, // wrong type, but the write still lands
    }) as any;

    expect(result.id).toBeTruthy();
    expect(result.validation_status.warnings.length).toBe(1);

    const fetched = await store.getNote(result.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe("x");
  });

  it("update-note also surfaces validation_status", async () => {
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "string", enum: ["high", "low"] } },
    });
    const note = await store.createNote("body", { tags: ["task"], metadata: { priority: "high" } });

    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-note")!;
    const result = await update.execute({
      id: note.id,
      metadata: { priority: "ULTRA" },
      if_updated_at: note.updatedAt,
    }) as any;

    expect(result.validation_status.warnings[0].reason).toBe("enum_mismatch");
  });

  it("cache invalidates when a tag schema is updated", async () => {
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "boolean" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    let result = await create.execute({
      content: "x",
      tags: ["task"],
      metadata: { priority: "high" },
    }) as any;
    expect(result.validation_status.warnings[0].field).toBe("priority");
    expect(result.validation_status.warnings[0].reason).toBe("type_mismatch");

    // Re-declare with a string type; cache must reflect the change.
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "string" } },
    });
    result = await create.execute({
      content: "y",
      tags: ["task"],
      metadata: { priority: "high" },
    }) as any;
    expect(result.validation_status.warnings).toEqual([]);
  });

  it("cache invalidates when a tag schema is deleted", async () => {
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "boolean" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    let result = await create.execute({
      content: "x",
      tags: ["task"],
      metadata: { priority: "high" },
    }) as any;
    expect(result.validation_status.warnings.length).toBe(1);

    await store.deleteTagSchema("task");

    result = await create.execute({
      content: "y",
      tags: ["task"],
      metadata: { priority: "high" },
    }) as any;
    expect(result.validation_status).toBeUndefined();
  });

  it("multiple tag schemas combine warnings", async () => {
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "string" } },
    });
    await store.upsertTagSchema("project", {
      fields: { status: { type: "string", enum: ["active", "done"] } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["task", "project"],
      metadata: { priority: 7, status: "WIP" }, // bad: wrong type, bad enum
    }) as any;

    expect(result.validation_status.schemas.sort()).toEqual(["project", "task"]);
    expect(result.validation_status.warnings.length).toBe(2);
  });

  it("legacy `_schemas/<name>` notes are inert post-v17", async () => {
    // The notes still write/read fine — they're just no longer interpreted
    // as schema config. Nothing in tags.fields → no validation.
    await store.createNote("", {
      path: "_schemas/task",
      metadata: { fields: { priority: { type: "string" } } },
    });
    await store.createNote("", {
      path: "_schema_defaults",
      metadata: { tags: { task: "task" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({ content: "x", tags: ["task"] }) as any;
    expect(result.validation_status).toBeUndefined();
  });

  // vault#310 — integer type validation. JSON has no separate integer
  // type, so a JSON number with zero fractional part (`5`, `5.0`) must
  // pass an `integer`-typed field. Pre-fix, the validator had no
  // `"integer"` case at all — falling through the switch returned
  // undefined and every integer-typed field warned `type_mismatch` on
  // legitimate values. Gitcoin Brain's drift detector emits JSON for
  // diffs; every `kpi: 3` triggered the false-positive and buried the
  // real warnings.

  it("integer-typed field: JSON integer (5) passes (vault#310)", async () => {
    await store.upsertTagSchema("kpi", { fields: { count: { type: "integer" } } });
    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["kpi"],
      metadata: { count: 5 },
    }) as any;
    expect(result.validation_status?.warnings ?? []).toEqual([]);
  });

  it("integer-typed field: JSON `5.0` (zero-fractional) passes (vault#310)", async () => {
    // 5.0 is the canonical Gitcoin shape — JSON.parse decodes the
    // emitted JSON number as a JS Number; the JS Number for `5.0` is
    // identical to `5` so Number.isInteger reports true. This is the
    // load-bearing assertion for the Gitcoin drift-detector use case.
    await store.upsertTagSchema("kpi", { fields: { count: { type: "integer" } } });
    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["kpi"],
      metadata: { count: 5.0 },
    }) as any;
    expect(result.validation_status?.warnings ?? []).toEqual([]);
  });

  it("integer-typed field: JSON `5.5` (non-zero fractional) warns type_mismatch (vault#310)", async () => {
    await store.upsertTagSchema("kpi", { fields: { count: { type: "integer" } } });
    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["kpi"],
      metadata: { count: 5.5 },
    }) as any;
    expect(result.validation_status.warnings.length).toBe(1);
    expect(result.validation_status.warnings[0].reason).toBe("type_mismatch");
    expect(result.validation_status.warnings[0].field).toBe("count");
  });

  it("integer-typed field: string `\"5\"` warns type_mismatch (no string→number coercion) (vault#310)", async () => {
    await store.upsertTagSchema("kpi", { fields: { count: { type: "integer" } } });
    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["kpi"],
      metadata: { count: "5" },
    }) as any;
    expect(result.validation_status.warnings.length).toBe(1);
    expect(result.validation_status.warnings[0].reason).toBe("type_mismatch");
  });

  it("integer-typed field: edge `5.0000000000001` warns type_mismatch (vault#310)", async () => {
    await store.upsertTagSchema("kpi", { fields: { count: { type: "integer" } } });
    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["kpi"],
      metadata: { count: 5.0000000000001 },
    }) as any;
    expect(result.validation_status.warnings.length).toBe(1);
    expect(result.validation_status.warnings[0].reason).toBe("type_mismatch");
  });

  it("integer-typed field: boolean warns type_mismatch (vault#310)", async () => {
    // Pin that boolean is rejected (Number.isInteger(true) returns
    // false, but extra coverage in case anyone "improves" the check
    // with a looser predicate later).
    await store.upsertTagSchema("kpi", { fields: { count: { type: "integer" } } });
    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["kpi"],
      metadata: { count: true },
    }) as any;
    expect(result.validation_status.warnings.length).toBe(1);
    expect(result.validation_status.warnings[0].reason).toBe("type_mismatch");
  });

  // Note on NaN/Infinity: those values pass through
  // JSON.stringify as `null`, then the validator's null short-circuit
  // (schema-defaults.ts:327 — "value === null → skip") filters them out
  // before reaching the type check. We can't observe them in
  // validation_status from this layer; a dedicated unit test against
  // `valueMatchesType` would catch the case at the inner boundary.
  // Pinned at the next layer down:

  it("valueMatchesType('integer', ...) rejects NaN / Infinity (vault#310)", async () => {
    // Reach the unexported helper indirectly via validateNote on a
    // hand-built resolved-schemas + metadata where the value is the
    // actual NaN/Infinity (no JSON round-trip).
    const { validateNote, loadSchemaConfig } = await import("./schema-defaults.js");
    // Seed via the public surface, then load the resolved schemas
    // snapshot.
    await store.upsertTagSchema("k", { fields: { c: { type: "integer" } } });
    const resolved = loadSchemaConfig((store as any).db);
    expect(validateNote(resolved, { tags: ["k"], metadata: { c: Number.NaN } })?.warnings[0]?.reason)
      .toBe("type_mismatch");
    expect(validateNote(resolved, { tags: ["k"], metadata: { c: Number.POSITIVE_INFINITY } })?.warnings[0]?.reason)
      .toBe("type_mismatch");
  });
});

// ---------------------------------------------------------------------------
// update-note `if_missing: "create"` — idempotent upsert (vault#309)
// ---------------------------------------------------------------------------

describe("update-note if_missing=create (vault#309)", async () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = new SqliteStore(new Database(":memory:"));
  });

  it("creates the note when missing + carries created: true", async () => {
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-note")!;
    const result = await update.execute({
      id: "Inbox/2026-05-13-meeting",
      content: "agenda body",
      tags: ["meeting"],
      metadata: { priority: "high" },
      if_missing: "create",
    }) as any;
    expect(result.created).toBe(true);
    expect(result.path).toBe("Inbox/2026-05-13-meeting");
    expect(result.content).toBe("agenda body");
    expect(result.tags).toContain("meeting");
    expect(result.metadata?.priority).toBe("high");

    // And the row landed.
    const fetched = await store.getNoteByPath("Inbox/2026-05-13-meeting");
    expect(fetched).not.toBeNull();
  });

  it("updates the note when present + carries created: false", async () => {
    await store.createNote("original", { path: "p", metadata: { v: 1 } });
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-note")!;
    const result = await update.execute({
      id: "p",
      content: "updated body",
      metadata: { v: 2 },
      if_missing: "create",
      force: true, // bypass OC since this is an unconditional update
    }) as any;
    expect(result.created).toBe(false);
    expect(result.content).toBe("updated body");
    expect(result.metadata?.v).toBe(2);
  });

  it("without if_missing, missing note errors (current behavior — back-compat)", async () => {
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-note")!;
    await expect(update.execute({
      id: "nope",
      content: "x",
      force: true,
    })).rejects.toThrow(/Note not found/);
  });

  it("create branch applies tag-schema defaults when the new tag declares fields", async () => {
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "string", enum: ["high", "low"] } },
    });
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-note")!;
    const result = await update.execute({
      id: "Inbox/new-task",
      content: "do the thing",
      tags: ["task"],
      if_missing: "create",
    }) as any;
    expect(result.created).toBe(true);
    // Schema defaults populated metadata.priority on insert.
    expect(result.metadata?.priority).toBeDefined();
  });

  it("create branch surfaces validation warnings just like create-note", async () => {
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "string", enum: ["high", "low"] } },
    });
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-note")!;
    const result = await update.execute({
      id: "Inbox/bad-task",
      content: "x",
      tags: ["task"],
      metadata: { priority: "ULTRA" },
      if_missing: "create",
    }) as any;
    expect(result.created).toBe(true);
    expect(result.validation_status?.warnings?.[0]?.reason).toBe("enum_mismatch");
  });

  it("idempotent: second call with same id + same content updates without error", async () => {
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-note")!;
    const first = await update.execute({
      id: "Inbox/sync-target",
      content: "v1",
      if_missing: "create",
    }) as any;
    expect(first.created).toBe(true);

    const second = await update.execute({
      id: "Inbox/sync-target",
      content: "v2",
      if_missing: "create",
      force: true,
    }) as any;
    expect(second.created).toBe(false);
    expect(second.content).toBe("v2");

    // Only one row exists.
    const all = await store.queryNotes({ limit: 100 });
    expect(all.filter((n) => n.path === "Inbox/sync-target")).toHaveLength(1);
  });

  // vault#321 F3 — schema-conflict warning surfaces on the create
  // branch. The branch reuses `attachValidationStatus` so the
  // conflict-detection logic should fire, but pre-fold it wasn't
  // pinned. Two tags directly applied to the new note, each
  // declaring the same field with conflicting specs → schema_conflict
  // warning (the existing `resolveNoteSchemas` walk produces this for
  // both inheritance chains AND multi-tag direct application).
  it("schema-conflict warning surfaces on create branch (vault#321 F3)", async () => {
    await store.upsertTagSchema("kpi", {
      fields: { count: { type: "integer" } },
    });
    await store.upsertTagSchema("metric", {
      fields: { count: { type: "string" } }, // conflicting spec
    });
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-note")!;
    const result = await update.execute({
      id: "Inbox/conflicting-tags",
      content: "x",
      tags: ["kpi", "metric"],
      metadata: { count: 5 },
      if_missing: "create",
    }) as any;
    expect(result.created).toBe(true);
    const conflict = result.validation_status.warnings.find(
      (w: any) => w.reason === "schema_conflict",
    );
    expect(conflict).toBeDefined();
    expect(conflict.field).toBe("count");
    // First-tag-wins precedence (kpi → integer). The loser_schema
    // field names metric.
    expect(conflict.schema).toBe("kpi");
    expect(conflict.loser_schema).toBe("metric");
  });

  // vault#321 F4 — links.add on the create branch is applied. The
  // implementation at mcp.ts:644-650 was present pre-fold; this
  // test pins it so a future regression breaking Gitcoin's
  // upsert-with-typed-links workflow goes red.
  it("links.add applied on create branch (vault#321 F4)", async () => {
    // Two pre-existing target notes the new source links to.
    await store.createNote("A", { id: "t-mcp-a-321", path: "Targets/A-mcp" });
    await store.createNote("B", { id: "t-mcp-b-321", path: "Targets/B-mcp" });

    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-note")!;
    const result = await update.execute({
      id: "Inbox/mcp-source-321",
      content: "source body",
      if_missing: "create",
      links: {
        add: [
          { target: "t-mcp-a-321", relationship: "derived-from" },
          { target: "Targets/B-mcp", relationship: "responds-to", metadata: { weight: 5 } },
        ],
      },
    }) as any;
    expect(result.created).toBe(true);

    const sourceId = result.id as string;
    const outboundLinks = await store.getLinks(sourceId, { direction: "outbound" });
    const derivedFrom = outboundLinks.find((l) => l.relationship === "derived-from");
    expect(derivedFrom).toBeDefined();
    expect(derivedFrom!.targetId).toBe("t-mcp-a-321");

    const respondsTo = outboundLinks.find((l) => l.relationship === "responds-to");
    expect(respondsTo).toBeDefined();
    expect(respondsTo!.targetId).toBe("t-mcp-b-321");
    expect(respondsTo!.metadata).toEqual({ weight: 5 });
  });
});

// ---------------------------------------------------------------------------
// Schema inheritance via parent_names + `_default` universal parent — vault#270
// ---------------------------------------------------------------------------

describe("schema inheritance via parent_names (vault#270)", async () => {
  it("single-parent: child inherits parent's fields", async () => {
    await store.upsertTagRecord("work", {
      fields: { project: { type: "string" } },
    });
    await store.upsertTagRecord("task", {
      parent_names: ["work"],
      fields: { priority: { type: "string" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["task"],
      metadata: { priority: 7, project: 42 }, // both wrong type
    }) as any;

    expect(result.validation_status.warnings.length).toBe(2);
    const fields = result.validation_status.warnings.map((w: any) => w.field).sort();
    expect(fields).toEqual(["priority", "project"]);
  });

  it("multi-parent: child gets union of parents' fields", async () => {
    await store.upsertTagRecord("work", {
      fields: { project: { type: "string" } },
    });
    await store.upsertTagRecord("publication", {
      fields: { venue: { type: "string" } },
    });
    await store.upsertTagRecord("paper", {
      parent_names: ["work", "publication"],
      fields: { title: { type: "string" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["paper"],
      metadata: { title: 1, project: 2, venue: 3 }, // all wrong type
    }) as any;

    expect(result.validation_status.warnings.length).toBe(3);
    const fields = result.validation_status.warnings.map((w: any) => w.field).sort();
    expect(fields).toEqual(["project", "title", "venue"]);
  });

  it("diamond: A→B, A→C, B→D, C→D — D's field appears once", async () => {
    await store.upsertTagRecord("D", {
      fields: { d_field: { type: "string" } },
    });
    await store.upsertTagRecord("B", { parent_names: ["D"] });
    await store.upsertTagRecord("C", { parent_names: ["D"] });
    await store.upsertTagRecord("A", { parent_names: ["B", "C"] });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["A"],
      metadata: { d_field: 999 }, // wrong type
    }) as any;

    expect(result.validation_status.warnings.length).toBe(1);
    expect(result.validation_status.warnings[0].field).toBe("d_field");
    expect(result.validation_status.warnings[0].schema).toBe("D");
  });

  it("cycle: A→B, B→A — no infinite loop, both fields visible", async () => {
    await store.upsertTagRecord("A", {
      parent_names: ["B"],
      fields: { a_field: { type: "string" } },
    });
    await store.upsertTagRecord("B", {
      parent_names: ["A"],
      fields: { b_field: { type: "string" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["A"],
      metadata: { a_field: 1, b_field: 2 }, // both wrong type
    }) as any;

    expect(result.validation_status.warnings.length).toBe(2);
    const fields = result.validation_status.warnings.map((w: any) => w.field).sort();
    expect(fields).toEqual(["a_field", "b_field"]);
  });

  it("override: child's spec wins over parent's for the same field name", async () => {
    await store.upsertTagRecord("parent_tag", {
      fields: { status: { type: "string", enum: ["a", "b"] } },
    });
    await store.upsertTagRecord("child_tag", {
      parent_names: ["parent_tag"],
      fields: { status: { type: "string", enum: ["x", "y"] } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["child_tag"],
      metadata: { status: "x" }, // valid under child, invalid under parent
    }) as any;

    // Child's spec wins → "x" passes the enum check.
    const enumWarnings = result.validation_status.warnings.filter(
      (w: any) => w.reason === "enum_mismatch",
    );
    expect(enumWarnings.length).toBe(0);
    // The conflict surfaces as a schema_conflict warning whose `schema` field
    // names the *winning* tag (child).
    const conflict = result.validation_status.warnings.find(
      (w: any) => w.reason === "schema_conflict",
    );
    expect(conflict).toBeDefined();
    expect(conflict.field).toBe("status");
    expect(conflict.schema).toBe("child_tag");
  });

  it("conflict warning: two parents declare same field with different specs, first wins", async () => {
    await store.upsertTagRecord("task", {
      fields: { status: { type: "string", enum: ["todo", "doing", "done"] } },
    });
    await store.upsertTagRecord("publication", {
      fields: { status: { type: "string", enum: ["draft", "published"] } },
    });
    // parent_names order = ["task", "publication"] → task wins.
    await store.upsertTagRecord("article_task", {
      parent_names: ["task", "publication"],
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["article_task"],
      metadata: { status: "todo" }, // valid under task (winner), invalid under publication
    }) as any;

    const conflict = result.validation_status.warnings.find(
      (w: any) => w.reason === "schema_conflict",
    );
    expect(conflict).toBeDefined();
    expect(conflict.field).toBe("status");
    expect(conflict.schema).toBe("task"); // winner
    // No enum_mismatch — the value is valid under task's enum.
    const enumMismatch = result.validation_status.warnings.find(
      (w: any) => w.reason === "enum_mismatch",
    );
    expect(enumMismatch).toBeUndefined();
  });

  it("`_default` universal parent: untagged note picks up `_default`'s schema", async () => {
    await store.upsertTagRecord("_default", {
      fields: { author: { type: "string" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "untagged note",
      metadata: { author: 42 }, // wrong type
    }) as any;

    expect(result.validation_status.schemas).toEqual(["_default"]);
    expect(result.validation_status.warnings.length).toBe(1);
    expect(result.validation_status.warnings[0].field).toBe("author");
  });

  it("`_default` universal parent: tagged note gets `_default` + its tag schema", async () => {
    await store.upsertTagRecord("_default", {
      fields: { author: { type: "string" } },
    });
    await store.upsertTagRecord("task", {
      fields: { priority: { type: "string" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["task"],
      metadata: { author: 1, priority: 2 }, // both wrong type
    }) as any;

    expect(result.validation_status.warnings.length).toBe(2);
    const schemas = new Set(
      result.validation_status.warnings.map((w: any) => w.schema),
    );
    expect(schemas.has("_default")).toBe(true);
    expect(schemas.has("task")).toBe(true);
  });

  it("`_default` query expansion: query-notes { tag: '_default' } returns every note", async () => {
    await store.upsertTagRecord("_default", { description: "universal parent" });
    const a = await store.createNote("alpha", { tags: ["task"] });
    const b = await store.createNote("beta", { tags: ["project"] });
    const g = await store.createNote("gamma"); // untagged

    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ tag: "_default" }) as any;

    expect(result.length).toBe(3);
    const ids = (result as { id: string }[]).map((n) => n.id).sort();
    expect(ids).toEqual([a.id, b.id, g.id].sort());
  });

  it("missing parent: non-existent name in parent_names is silently skipped", async () => {
    await store.upsertTagRecord("task", {
      parent_names: ["nonexistent_tag"],
      fields: { priority: { type: "string" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["task"],
      metadata: { priority: 999 }, // wrong type
    }) as any;

    // No error. task's own field still validates.
    expect(result.validation_status.warnings.length).toBe(1);
    expect(result.validation_status.warnings[0].field).toBe("priority");
  });

  it("`_default` deleted mid-session: cache invalidates, default behavior goes away", async () => {
    await store.upsertTagRecord("_default", {
      fields: { author: { type: "string" } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    let result = await create.execute({
      content: "x",
      metadata: { author: 42 }, // wrong type
    }) as any;
    expect(result.validation_status.warnings.length).toBe(1);

    await store.deleteTag("_default");

    result = await create.execute({
      content: "y",
      metadata: { author: 42 },
    }) as any;
    expect(result.validation_status).toBeUndefined();
  });

  it("`_default` + `tagMatch: 'any'` drops the tag filter entirely (every note matches)", async () => {
    // Folded from PR #272 review (N1). With OR-semantics, `_default` matches
    // everything → the disjunction collapses regardless of what else is in
    // the list. Pre-fold this would have narrowed to `task`-tagged notes.
    await store.upsertTagRecord("_default", { description: "universal parent" });
    const a = await store.createNote("alpha", { tags: ["task"] });
    const b = await store.createNote("beta", { tags: ["project"] });
    const g = await store.createNote("gamma"); // untagged

    const results = await store.queryNotes({ tags: ["_default", "task"], tagMatch: "any" });
    const ids = results.map((n) => n.id).sort();
    expect(ids).toEqual([a.id, b.id, g.id].sort());
  });

  it("`_default` + `tagMatch: 'all'` drops only `_default` from the AND-set", async () => {
    // Symmetric guard for N1: AND-semantics should NOT collapse — `_default`
    // is universally satisfied so it can be dropped, but other tags still
    // narrow the result set.
    await store.upsertTagRecord("_default", { description: "universal parent" });
    const a = await store.createNote("alpha", { tags: ["task"] });
    await store.createNote("beta", { tags: ["project"] });
    await store.createNote("gamma"); // untagged

    const results = await store.queryNotes({ tags: ["_default", "task"], tagMatch: "all" });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(a.id);
  });

  it("`searchNotes` with `_default` returns matches from every note (including untagged)", async () => {
    // Folded from PR #272 review (N2). FTS-backed search now short-circuits
    // the tag filter when `_default` is requested, matching `queryNotes`.
    await store.upsertTagRecord("_default", { description: "universal parent" });
    const a = await store.createNote("findme alpha", { tags: ["task"] });
    const b = await store.createNote("findme beta"); // untagged

    const results = await store.searchNotes("findme", { tags: ["_default"] });
    const ids = results.map((n) => n.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("`schema_conflict` warning carries structured `loser_schema`", async () => {
    // Folded from PR #272 review (N3). Agents shouldn't have to regex
    // `message` to find the overridden tag — surface it structurally.
    await store.upsertTagRecord("task", {
      fields: { status: { type: "string", enum: ["todo", "done"] } },
    });
    await store.upsertTagRecord("publication", {
      fields: { status: { type: "string", enum: ["draft", "published"] } },
    });
    await store.upsertTagRecord("article_task", {
      parent_names: ["task", "publication"],
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["article_task"],
      metadata: { status: "todo" },
    }) as any;

    const conflict = result.validation_status.warnings.find(
      (w: any) => w.reason === "schema_conflict",
    );
    expect(conflict).toBeDefined();
    expect(conflict.schema).toBe("task"); // winner
    expect(conflict.loser_schema).toBe("publication"); // overridden
  });

  it("non-conflict warnings (type/enum mismatch) don't carry `loser_schema`", async () => {
    // Symmetric guard for N3: `loser_schema` is only meaningful for
    // schema_conflict; absent on type/enum mismatches.
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "string", enum: ["high", "low"] } },
    });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      content: "x",
      tags: ["task"],
      metadata: { priority: "ULTRA" },
    }) as any;

    expect(result.validation_status.warnings[0].reason).toBe("enum_mismatch");
    expect(result.validation_status.warnings[0].loser_schema).toBeUndefined();
  });

  it("invalidates schema cache when only parent_names changes (no fields touched)", async () => {
    // Regression guard: pre-vault#270, parent_names changes only invalidated
    // the hierarchy cache. Now they must also invalidate the schema cache,
    // since inheritance walks parent chains at validation time.
    await store.upsertTagRecord("base", {
      fields: { tier: { type: "string" } },
    });
    await store.upsertTagRecord("derived", { description: "starts orphaned" });

    const tools = generateMcpTools(store);
    const create = tools.find((t) => t.name === "create-note")!;
    let result = await create.execute({
      content: "x",
      tags: ["derived"],
      metadata: { tier: 1 },
    }) as any;
    expect(result.validation_status).toBeUndefined();

    // Wire up inheritance — fields *not* touched, only parent_names.
    await store.upsertTagRecord("derived", { parent_names: ["base"] });

    result = await create.execute({
      content: "y",
      tags: ["derived"],
      metadata: { tier: 1 }, // wrong type per base.tier
    }) as any;
    expect(result.validation_status.warnings.length).toBe(1);
    expect(result.validation_status.warnings[0].field).toBe("tier");
    expect(result.validation_status.warnings[0].schema).toBe("base");
  });
});

describe("expandTagsWithDescendants (tag-scoped tokens — patterns/tag-scoped-tokens.md)", async () => {
  it("returns the union of root + every descendant per tags.parent_names", async () => {
    await store.upsertTagRecord("health/food", { parent_names: ["health"] });
    await store.upsertTagRecord("health/food/breakfast", { parent_names: ["health/food"] });
    await store.upsertTagRecord("work", { description: "work things" });

    const expanded = await store.expandTagsWithDescendants(["health"]);
    expect(expanded.has("health")).toBe(true);
    expect(expanded.has("health/food")).toBe(true);
    expect(expanded.has("health/food/breakfast")).toBe(true);
    expect(expanded.has("work")).toBe(false);
  });

  it("returns an empty set for an empty input (no allowlist = nothing to expand)", async () => {
    const expanded = await store.expandTagsWithDescendants([]);
    expect(expanded.size).toBe(0);
  });

  it("includes the root verbatim even when the tag has no declared descendants", async () => {
    await store.createNote("solo", { tags: ["loner"] });
    const expanded = await store.expandTagsWithDescendants(["loner"]);
    expect([...expanded]).toEqual(["loner"]);
  });

  it("unions descendants from multiple roots", async () => {
    await store.upsertTagRecord("health/food", { parent_names: ["health"] });
    await store.upsertTagRecord("work/standup", { parent_names: ["work"] });
    const expanded = await store.expandTagsWithDescendants(["health", "work"]);
    expect(expanded.has("health")).toBe(true);
    expect(expanded.has("health/food")).toBe(true);
    expect(expanded.has("work")).toBe(true);
    expect(expanded.has("work/standup")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tag record API — patterns/tag-data-model.md
// ---------------------------------------------------------------------------

describe("tag record API (patterns/tag-data-model.md)", async () => {
  it("upsertTagRecord persists description + fields + relationships + parent_names", async () => {
    await store.upsertTagRecord("project", {
      description: "long-running deliverable",
      fields: { status: { type: "string", enum: ["active", "shipped"] } },
      relationships: {
        owned_by: { target_tag: "person", cardinality: "one", description: "DRI" },
      },
      parent_names: ["work"],
    });
    const r = await store.getTagRecord("project");
    expect(r?.description).toBe("long-running deliverable");
    expect(r?.fields?.status?.type).toBe("string");
    expect(r?.relationships?.owned_by?.target_tag).toBe("person");
    expect(r?.relationships?.owned_by?.cardinality).toBe("one");
    expect(r?.parent_names).toEqual(["work"]);
    expect(r?.created_at).toBeDefined();
    expect(r?.updated_at).toBeDefined();
  });

  it("upsertTagRecord preserves columns left undefined in the patch", async () => {
    await store.upsertTagRecord("project", {
      description: "first",
      fields: { status: { type: "string" } },
      parent_names: ["work"],
    });
    await store.upsertTagRecord("project", { description: "second" });
    const r = await store.getTagRecord("project");
    expect(r?.description).toBe("second");
    expect(r?.fields?.status?.type).toBe("string");
    expect(r?.parent_names).toEqual(["work"]);
  });

  it("upsertTagRecord clears a column when patch passes null", async () => {
    await store.upsertTagRecord("project", {
      description: "deliverable",
      parent_names: ["work"],
    });
    await store.upsertTagRecord("project", { parent_names: null });
    const r = await store.getTagRecord("project");
    expect(r?.description).toBe("deliverable");
    expect(r?.parent_names).toBeUndefined();
  });

  it("listTagRecords returns every tag row, sorted by name", async () => {
    await store.upsertTagRecord("zebra", { description: "z" });
    await store.upsertTagRecord("alpha", { description: "a" });
    const records = await store.listTagRecords();
    const names = records.map((r) => r.tag);
    const idxAlpha = names.indexOf("alpha");
    const idxZebra = names.indexOf("zebra");
    expect(idxAlpha).toBeGreaterThanOrEqual(0);
    expect(idxZebra).toBeGreaterThan(idxAlpha);
  });

  it("update-tag MCP rejects an invalid cardinality", async () => {
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-tag")!;
    await expect(
      update.execute({
        tag: "project",
        relationships: {
          owned_by: { target_tag: "person", cardinality: "bogus" },
        },
      }),
    ).rejects.toThrow(/cardinality/);
  });

  it("update-tag MCP accepts every cardinality in the named vocabulary", async () => {
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-tag")!;
    for (const card of ["one", "optional", "many", "many-required"]) {
      await update.execute({
        tag: `tag-${card}`,
        relationships: {
          rel: { target_tag: "other", cardinality: card },
        },
      });
      const r = await store.getTagRecord(`tag-${card}`);
      expect(r?.relationships?.rel?.cardinality).toBe(card);
    }
  });

  it("update-tag MCP rejects a relationship missing target_tag", async () => {
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-tag")!;
    await expect(
      update.execute({
        tag: "project",
        relationships: { owned_by: { cardinality: "one" } },
      }),
    ).rejects.toThrow(/target_tag/);
  });

  it("update-tag MCP sets parent_names and the hierarchy invalidates", async () => {
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-tag")!;

    await store.createNote("v note", { tags: ["voice"] });
    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(0);

    await update.execute({
      tag: "voice",
      parent_names: ["manual"],
    });

    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(1);
  });

  it("update-tag MCP empty parent_names array clears the column", async () => {
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-tag")!;
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    await update.execute({ tag: "voice", parent_names: [] });
    const r = await store.getTagRecord("voice");
    expect(r?.parent_names).toBeUndefined();
  });

  it("list-tags MCP single-tag detail includes relationships + parent_names", async () => {
    await store.upsertTagRecord("project", {
      description: "p",
      relationships: { owned_by: { target_tag: "person", cardinality: "one" } },
      parent_names: ["work"],
    });
    const tools = generateMcpTools(store);
    const listTags = tools.find((t) => t.name === "list-tags")!;
    const result = await listTags.execute({ tag: "project" }) as any;
    expect(result.relationships?.owned_by?.target_tag).toBe("person");
    expect(result.parent_names).toEqual(["work"]);
    expect(result.created_at).toBeDefined();
  });

  it("list-tags MCP include_schema returns relationships + parent_names per tag", async () => {
    await store.upsertTagRecord("project", {
      relationships: { owned_by: { target_tag: "person", cardinality: "one" } },
      parent_names: ["work"],
    });
    await store.createNote("p note", { tags: ["project"] });
    const tools = generateMcpTools(store);
    const listTags = tools.find((t) => t.name === "list-tags")!;
    const all = await listTags.execute({ include_schema: true }) as any[];
    const project = all.find((t) => t.name === "project")!;
    expect(project.relationships?.owned_by?.target_tag).toBe("person");
    expect(project.parent_names).toEqual(["work"]);
  });

  it("renameTag carries description + fields + relationships + parent_names onto the new row", async () => {
    await store.upsertTagRecord("old-name", {
      description: "before",
      fields: { status: { type: "string" } },
      relationships: { owned_by: { target_tag: "person", cardinality: "one" } },
      parent_names: ["work"],
    });
    const result = await store.renameTag("old-name", "new-name");
    expect("renamed" in result).toBe(true);

    const renamed = await store.getTagRecord("new-name");
    expect(renamed?.description).toBe("before");
    expect(renamed?.fields?.status?.type).toBe("string");
    expect(renamed?.relationships?.owned_by?.target_tag).toBe("person");
    expect(renamed?.parent_names).toEqual(["work"]);

    const old = await store.getTagRecord("old-name");
    expect(old).toBeNull();
  });

  it("deleteTag drops the identity row + invalidates the hierarchy", async () => {
    await store.upsertTagRecord("voice", {
      description: "voice notes",
      parent_names: ["manual"],
    });
    await store.createNote("v", { tags: ["voice"] });
    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(1);

    await store.deleteTag("voice");
    expect((await store.queryNotes({ tags: ["manual"] })).length).toBe(0);
    expect(await store.getTagRecord("voice")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Schema migration v13 → v14 — patterns/tag-data-model.md
// ---------------------------------------------------------------------------

describe("schema migration v13 → v14", async () => {
  it("backfills tags.parent_names from `_tags/<name>` notes", async () => {
    // Simulate a pre-v14 vault by writing a `_tags/<name>` note + the
    // legacy tag_schemas row directly via a fresh DB at v13 shape.
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");

    // Build the v13 shape inline: tags(name PK only), separate tag_schemas
    // table, plus a notes row at `_tags/voice`.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE notes (
      id TEXT PRIMARY KEY, content TEXT DEFAULT '', path TEXT,
      metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT
    )`);
    db.exec(`CREATE TABLE tags (name TEXT PRIMARY KEY)`);
    db.exec(`CREATE TABLE tag_schemas (
      tag_name TEXT PRIMARY KEY REFERENCES tags(name) ON DELETE CASCADE,
      description TEXT, fields TEXT
    )`);

    db.prepare("INSERT INTO tags (name) VALUES (?)").run("voice");
    db.prepare("INSERT INTO tag_schemas (tag_name, description, fields) VALUES (?, ?, ?)")
      .run("voice", "voice notes", '{"recorded_at":{"type":"string"}}');
    db.prepare(`INSERT INTO notes (id, path, metadata, created_at) VALUES (?, ?, ?, ?)`)
      .run("n1", "_tags/voice", JSON.stringify({ parents: ["manual"] }), new Date().toISOString());

    // Now run initSchema — it should add the v14 columns, copy schema +
    // hierarchy data onto the tags row, and drop tag_schemas.
    const { initSchema } = await import("./schema.ts");
    initSchema(db);

    // tag_schemas should be gone.
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tag_schemas'",
    ).get();
    expect(tableExists).toBeNull();

    // tags row should carry the migrated fields.
    const row = db.prepare(
      "SELECT name, description, fields, parent_names FROM tags WHERE name = 'voice'",
    ).get() as any;
    expect(row.description).toBe("voice notes");
    expect(JSON.parse(row.fields).recorded_at.type).toBe("string");
    expect(JSON.parse(row.parent_names)).toEqual(["manual"]);

    // The `_tags/voice` note is left in place as harmless historical record.
    const note = db.prepare("SELECT id FROM notes WHERE path = '_tags/voice'").get();
    expect(note).toBeDefined();

    db.close();
  });

  it("is idempotent — running initSchema twice is a no-op the second time", async () => {
    const { Database } = await import("bun:sqlite");
    const { initSchema } = await import("./schema.ts");
    const db = new Database(":memory:");
    initSchema(db);
    db.prepare(`
      INSERT INTO tags (name, description, parent_names, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "voice",
      "voice notes",
      JSON.stringify(["manual"]),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    // Second run must not throw, must not perturb the row, must not
    // reintroduce tag_schemas.
    initSchema(db);

    const row = db.prepare("SELECT description, parent_names FROM tags WHERE name = 'voice'").get() as any;
    expect(row.description).toBe("voice notes");
    expect(JSON.parse(row.parent_names)).toEqual(["manual"]);

    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tag_schemas'",
    ).get();
    expect(tableExists).toBeNull();
    db.close();
  });

  // vault#248 — the migration body is wrapped in BEGIN IMMEDIATE / COMMIT
  // with a try/catch ROLLBACK. A crash mid-migration must leave the DB in
  // its pre-migration state (NOT half-migrated), and a retry must converge
  // to the same final state as a clean run. The transaction wrap is what
  // makes that guarantee — the `hasColumn` / `hasTable` idempotency guards
  // are belt-and-suspenders, not load-bearing.
  it("crash mid-migration rolls back to pre-migration state, then retry succeeds", async () => {
    const { Database } = await import("bun:sqlite");
    const { initSchema } = await import("./schema.ts");

    const db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE notes (
      id TEXT PRIMARY KEY, content TEXT DEFAULT '', path TEXT,
      metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT
    )`);
    db.exec(`CREATE TABLE tags (name TEXT PRIMARY KEY)`);
    db.exec(`CREATE TABLE tag_schemas (
      tag_name TEXT PRIMARY KEY REFERENCES tags(name) ON DELETE CASCADE,
      description TEXT, fields TEXT
    )`);

    db.prepare("INSERT INTO tags (name) VALUES (?)").run("voice");
    db.prepare("INSERT INTO tag_schemas (tag_name, description, fields) VALUES (?, ?, ?)")
      .run("voice", "voice notes", '{"recorded_at":{"type":"string"}}');
    db.prepare(`INSERT INTO notes (id, path, metadata, created_at) VALUES (?, ?, ?, ?)`)
      .run("n1", "_tags/voice", JSON.stringify({ parents: ["manual"] }), new Date().toISOString());

    // Patch db.exec to simulate a crash on the final DROP TABLE step. That's
    // the right injection point: every ALTER + data copy has already landed
    // inside the transaction, so a successful rollback proves the wrap
    // covers the full migration body — not just the tail.
    const origExec = db.exec.bind(db);
    let crashOnDrop: boolean = true;
    (db as any).exec = function (sql: string) {
      if (crashOnDrop && sql.includes("DROP TABLE tag_schemas")) {
        throw new Error("simulated crash mid-migration");
      }
      return origExec(sql);
    };

    expect(() => initSchema(db)).toThrow("simulated crash mid-migration");

    // Pre-migration shape: tag_schemas table still exists with its row,
    // tags table back to (name) only — none of the v14 columns landed,
    // `_tags/voice` note untouched, schema_version row not yet written.
    const tagSchemasStill = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tag_schemas'",
    ).get();
    expect(tagSchemasStill).toBeTruthy();
    const schemaRow = db.prepare(
      "SELECT description, fields FROM tag_schemas WHERE tag_name = 'voice'",
    ).get() as any;
    expect(schemaRow.description).toBe("voice notes");

    const tagsCols = db.prepare("PRAGMA table_info(tags)").all() as { name: string }[];
    const colNames = tagsCols.map((c) => c.name).sort();
    expect(colNames).toEqual(["name"]);

    const note = db.prepare("SELECT path, metadata FROM notes WHERE id = 'n1'").get() as any;
    expect(note.path).toBe("_tags/voice");
    expect(JSON.parse(note.metadata).parents).toEqual(["manual"]);

    // No lingering open transaction — a SELECT after rollback succeeds, and
    // a fresh BEGIN IMMEDIATE doesn't fail with "cannot start a transaction
    // within a transaction".
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");

    // Retry: drop the crash injection, run initSchema again. It must
    // converge to the same final post-v14 state as a clean run.
    crashOnDrop = false;
    initSchema(db);

    const tableGone = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tag_schemas'",
    ).get();
    expect(tableGone).toBeNull();
    const post = db.prepare(
      "SELECT description, fields, parent_names FROM tags WHERE name = 'voice'",
    ).get() as any;
    expect(post.description).toBe("voice notes");
    expect(JSON.parse(post.fields).recorded_at.type).toBe("string");
    expect(JSON.parse(post.parent_names)).toEqual(["manual"]);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Schema migration v16 → v17 — vault#267 (note_schemas + schema_mappings rip)
// ---------------------------------------------------------------------------

describe("schema migration v16 → v17", async () => {
  // Build a v16-shape DB with the standalone note_schemas + schema_mappings
  // tables and a couple of rows, then run initSchema again. The v17 migration
  // should drop both tables.
  async function buildV16ShapeWithLegacyTables(): Promise<Database> {
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");

    // Create the v16-era schema fragments by hand. We can't call the post-v17
    // initSchema to do this — SCHEMA_SQL no longer creates the dropped
    // tables. Build them manually here so the migration test exercises the
    // "upgrading from v16" path.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`CREATE TABLE note_schemas (
      name TEXT PRIMARY KEY,
      description TEXT,
      fields TEXT,
      required TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);
    db.exec(`CREATE TABLE schema_mappings (
      schema_name TEXT NOT NULL REFERENCES note_schemas(name) ON DELETE CASCADE,
      match_kind TEXT NOT NULL CHECK (match_kind IN ('path_prefix', 'tag')),
      match_value TEXT NOT NULL,
      PRIMARY KEY (schema_name, match_kind, match_value)
    )`);
    db.exec("CREATE INDEX idx_schema_mappings_match ON schema_mappings(match_kind, match_value)");

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO note_schemas (name, description, fields, required, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("task", "A task", '{"priority":{"type":"string"}}', '["priority"]', now, now);
    db.prepare(
      "INSERT INTO note_schemas (name, created_at, updated_at) VALUES (?, ?, ?)",
    ).run("journal-entry", now, now);
    db.prepare(
      "INSERT INTO schema_mappings (schema_name, match_kind, match_value) VALUES (?, ?, ?)",
    ).run("task", "tag", "task");
    db.prepare(
      "INSERT INTO schema_mappings (schema_name, match_kind, match_value) VALUES (?, ?, ?)",
    ).run("journal-entry", "path_prefix", "journal/");

    return db;
  }

  it("drops note_schemas + schema_mappings tables on upgrade", async () => {
    const db = await buildV16ShapeWithLegacyTables();
    const { initSchema } = await import("./schema.ts");
    initSchema(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('note_schemas','schema_mappings')",
    ).all() as { name: string }[];
    expect(tables).toEqual([]);

    db.close();
  });

  it("idempotent — running on an already-v17 vault is a no-op", async () => {
    const { Database } = await import("bun:sqlite");
    const { initSchema } = await import("./schema.ts");
    const db = new Database(":memory:");
    initSchema(db); // First run: fresh v17 shape.

    // Sanity: the dropped tables don't exist on a fresh vault.
    let tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('note_schemas','schema_mappings')",
    ).all() as { name: string }[];
    expect(tables).toEqual([]);

    // Second run shouldn't crash and the tables stay absent.
    initSchema(db);
    tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('note_schemas','schema_mappings')",
    ).all() as { name: string }[];
    expect(tables).toEqual([]);

    db.close();
  });

  it("preserves notes + tags + tokens across the rip", async () => {
    const db = await buildV16ShapeWithLegacyTables();

    // Bring the rest of the schema up to v16 baseline so notes/tags/tokens
    // exist, then re-run initSchema (which finishes the v17 migration).
    const { initSchema } = await import("./schema.ts");
    initSchema(db);

    // Populate some unrelated state and re-run; nothing else should move.
    await import("./store.ts").then(async ({ SqliteStore }) => {
      const s = new SqliteStore(db);
      await s.createNote("hello", { id: "n1", tags: ["task"] });
      await s.upsertTagRecord("task", { description: "still here" });
    });
    initSchema(db);

    const note = db.prepare("SELECT id, content FROM notes WHERE id = ?").get("n1") as any;
    expect(note?.content).toBe("hello");
    const tag = db.prepare("SELECT description FROM tags WHERE name = ?").get("task") as any;
    expect(tag?.description).toBe("still here");

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Schema migration v15 → v16 — vault#257 (tokens.vault_name binding)
// ---------------------------------------------------------------------------

describe("schema migration v15 → v16", async () => {
  // vault#257 — the v16 migration body (ALTER TABLE ADD COLUMN + CREATE
  // INDEX) is wrapped in BEGIN IMMEDIATE / COMMIT with a try/catch
  // ROLLBACK, mirroring the v14/v15 wrap shape from vault#251. The
  // individual statements are atomic in SQLite, so the wrap is mostly
  // belt-and-suspenders for THIS migration — but the test mirrors v14's
  // crash-rollback shape so anyone touching migrations finds the same
  // regression-pin pattern across versions.
  it("crash mid-migration rolls back to pre-v16 state, then retry succeeds", async () => {
    const { Database } = await import("bun:sqlite");
    const { initSchema } = await import("./schema.ts");

    // Build the full post-v16 shape, plant a row, then drop the v16
    // additions so initSchema's migrateToV16 fires on the next call.
    const db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    initSchema(db);

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO tokens (token_hash, label, created_at, vault_name) VALUES (?, ?, ?, ?)",
    ).run("sha256:abc123def456", "pre-existing", now, "work");

    db.exec("DROP INDEX IF EXISTS idx_tokens_vault_name");
    db.exec("ALTER TABLE tokens DROP COLUMN vault_name");

    // Pre-condition: the column is gone but the row is still there
    // (DROP COLUMN strips the column from existing rows).
    const preCols = db.prepare("PRAGMA table_info(tokens)").all() as { name: string }[];
    expect(preCols.map((c) => c.name)).not.toContain("vault_name");
    const preRow = db.prepare("SELECT label FROM tokens WHERE token_hash = ?")
      .get("sha256:abc123def456") as { label: string } | null;
    expect(preRow?.label).toBe("pre-existing");

    // Patch db.exec to crash on CREATE INDEX — the second statement inside
    // the v16 transaction body. Crashing here proves the wrap covers the
    // post-ALTER state, not just the tail. The injection deliberately
    // doesn't match BEGIN/COMMIT/ROLLBACK so the catch's ROLLBACK still
    // runs through the patched exec.
    const origExec = db.exec.bind(db);
    let crashOnIndex: boolean = true;
    (db as any).exec = function (sql: string) {
      if (crashOnIndex && sql.includes("CREATE INDEX") && sql.includes("idx_tokens_vault_name")) {
        throw new Error("simulated crash mid-v16-migration");
      }
      return origExec(sql);
    };

    expect(() => initSchema(db)).toThrow("simulated crash mid-v16-migration");

    // Pre-v16 shape after rollback: vault_name column must not exist; the
    // pre-existing row must be untouched.
    const colsAfterRollback = db.prepare("PRAGMA table_info(tokens)").all() as { name: string }[];
    expect(colsAfterRollback.map((c) => c.name)).not.toContain("vault_name");
    const idxAfterRollback = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tokens_vault_name'",
    ).get();
    expect(idxAfterRollback).toBeNull();
    const rowAfterRollback = db.prepare("SELECT label FROM tokens WHERE token_hash = ?")
      .get("sha256:abc123def456") as { label: string } | null;
    expect(rowAfterRollback?.label).toBe("pre-existing");

    // No lingering open transaction — a fresh BEGIN IMMEDIATE + ROLLBACK
    // doesn't fail with "cannot start a transaction within a transaction".
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");

    // Retry: drop the crash injection, run initSchema again. Must converge
    // to post-v16 shape (column added, index created, lenient NULL backfill
    // on the pre-existing row per the migration spec).
    crashOnIndex = false;
    initSchema(db);

    const colsPost = db.prepare("PRAGMA table_info(tokens)").all() as { name: string }[];
    expect(colsPost.map((c) => c.name)).toContain("vault_name");
    const idxPost = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tokens_vault_name'",
    ).get();
    expect(idxPost).toBeTruthy();
    const rowPost = db.prepare("SELECT label, vault_name FROM tokens WHERE token_hash = ?")
      .get("sha256:abc123def456") as { label: string; vault_name: string | null };
    expect(rowPost.label).toBe("pre-existing");
    expect(rowPost.vault_name).toBeNull();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Tag-scope auth post-v14 — patterns/tag-scoped-tokens.md
// ---------------------------------------------------------------------------

describe("tag-scope auth (post-v14 hierarchy)", async () => {
  it("token allowlisted for `health` matches descendants declared via parent_names", async () => {
    await store.upsertTagRecord("health/food", { parent_names: ["health"] });
    await store.upsertTagRecord("health/food/breakfast", { parent_names: ["health/food"] });

    const expanded = await store.expandTagsWithDescendants(["health"]);
    expect(expanded.has("health")).toBe(true);
    expect(expanded.has("health/food")).toBe(true);
    expect(expanded.has("health/food/breakfast")).toBe(true);
  });

  it("orphan sub-tag fallback: token for `health` still sees `#health/food` even with no declared hierarchy", async () => {
    // Per patterns/tag-scoped-tokens.md §Storage details, the auth check
    // also splits on '/' and matches the root verbatim against the raw
    // allowlist. This survives the v14 source-of-truth swap because the
    // fallback lives in src/tag-scope.ts, not in the resolver.
    const { noteWithinTagScope } = await import("../../src/tag-scope.ts");
    const note = { id: "x", content: "", createdAt: "", tags: ["health/food"] };
    const allowed = await store.expandTagsWithDescendants(["health"]);
    // No declared hierarchy — the expansion returns just `health`.
    expect(allowed.has("health/food")).toBe(false);
    // But the string-form fallback still matches.
    expect(noteWithinTagScope(note, allowed, ["health"])).toBe(true);
  });
});

// ---- Vault projection (vault#271) ----

describe("vault projection (vault#271)", async () => {
  it("projects tags-with-schemas with effective inheritance", async () => {
    const { buildVaultProjection } = await import("./vault-projection.ts");

    // Universal `_default` parent declares `created_by`.
    await store.upsertTagRecord("_default", {
      fields: { created_by: { type: "string", description: "Origin agent" } },
    });
    // `person` declares `email` and inherits `created_by`.
    await store.upsertTagRecord("person", {
      description: "A person",
      fields: { email: { type: "string", indexed: true } },
    });
    // `employee` extends `person` — should inherit BOTH `email` and `created_by`.
    await store.upsertTagRecord("employee", {
      description: "Person who works here",
      fields: { title: { type: "string" } },
      parent_names: ["person"],
    });

    const projection = buildVaultProjection(db);

    const byName = Object.fromEntries(projection.tags.map((t) => [t.name, t]));

    // _default appears (has fields).
    expect(byName._default).toBeTruthy();
    expect(byName._default.parents).toEqual([]);
    expect(byName._default.effective_parents).toEqual([]);

    // person inherits _default's universal field.
    expect(byName.person.parents).toEqual([]);
    expect(byName.person.effective_parents).toEqual(["_default"]);
    expect(Object.keys(byName.person.effective_fields).sort()).toEqual([
      "created_by",
      "email",
    ]);
    // own fields stay separate
    expect(Object.keys(byName.person.fields ?? {})).toEqual(["email"]);

    // employee walks person → _default.
    expect(byName.employee.parents).toEqual(["person"]);
    expect(byName.employee.effective_parents).toEqual(["person", "_default"]);
    expect(Object.keys(byName.employee.effective_fields).sort()).toEqual([
      "created_by",
      "email",
      "title",
    ]);
  });

  it("catalogs indexed fields across declarers", async () => {
    const { buildVaultProjection } = await import("./vault-projection.ts");

    // Indexed-field lifecycle is owned by the update-tag MCP tool, not
    // store.upsertTagRecord — go through the tool so the indexed_fields
    // table actually gets populated.
    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    await updateTag.execute({
      tag: "task",
      fields: { status: { type: "string", indexed: true } },
    });
    await updateTag.execute({
      tag: "project",
      fields: {
        status: { type: "string", indexed: true },
        priority: { type: "integer", indexed: true },
      },
    });

    const projection = buildVaultProjection(db);
    const byName = Object.fromEntries(projection.indexed_fields.map((f) => [f.name, f]));

    expect(byName.status).toBeTruthy();
    expect(byName.status.type).toBe("string");
    expect(byName.status.tags.sort()).toEqual(["project", "task"]);

    expect(byName.priority).toBeTruthy();
    expect(byName.priority.type).toBe("integer");
    expect(byName.priority.tags).toEqual(["project"]);
  });

  it("includes the static query-hint catalog", async () => {
    const { buildVaultProjection, QUERY_HINTS } = await import("./vault-projection.ts");
    const projection = buildVaultProjection(db);
    expect(projection.query_hints.length).toBe(QUERY_HINTS.length);
    expect(projection.query_hints.some((h) => h.startsWith("query-notes { tag:"))).toBe(true);
    expect(projection.query_hints.some((h) => h.includes("near:"))).toBe(true);
  });

  it("includes stats only when requested", async () => {
    const { buildVaultProjection } = await import("./vault-projection.ts");
    await store.createNote("a", { tags: ["x"] });
    await store.createNote("b", { tags: ["x", "y"] });

    const without = buildVaultProjection(db);
    expect(without.stats).toBeUndefined();

    const withStats = buildVaultProjection(db, { includeStats: true });
    expect(withStats.stats).toBeTruthy();
    expect(withStats.stats!.totalNotes).toBe(2);
    expect(withStats.stats!.tagCount).toBe(2);
  });

  it("degrades gracefully on an empty vault", async () => {
    const { buildVaultProjection } = await import("./vault-projection.ts");
    const projection = buildVaultProjection(db);
    expect(projection.tags).toEqual([]);
    expect(projection.indexed_fields).toEqual([]);
    // Query hints are static — present even on a blank vault.
    expect(projection.query_hints.length).toBeGreaterThan(0);
  });

  it("renders a markdown brief listing tags-with-schemas and indexed fields", async () => {
    const { buildVaultProjection, projectionToMarkdown } = await import(
      "./vault-projection.ts"
    );

    await store.createNote("a", { tags: ["person"] });
    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    await updateTag.execute({
      tag: "person",
      description: "A person",
      fields: { email: { type: "string", indexed: true } },
    });

    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({
      vaultName: "test",
      description: "My vault",
      projection,
    });

    expect(md).toContain('You are connected to Parachute Vault "test"');
    expect(md).toContain("My vault");
    expect(md).toContain("1 tag with schemas: person");
    expect(md).toContain("Indexed metadata fields");
    expect(md).toContain("email");
    expect(md).toContain("#person");
    expect(md).toContain("vault-info");
    expect(md).toContain("list-tags { include_schema: true }");
    // Scripting pointer (closes the "points nowhere" gap): the brief routes an
    // agent to the HTTP API + the public guide, with the vault name baked into
    // the copy-paste mint command.
    expect(md).toContain("## Scripting & automation");
    expect(md).toContain("https://parachute.computer/scripting/");
    expect(md).toContain("parachute auth mint-token --scope vault:test:read --ephemeral");
  });

  it("markdown brief degrades gracefully when no schemas declared", async () => {
    const { buildVaultProjection, projectionToMarkdown } = await import(
      "./vault-projection.ts"
    );

    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({
      vaultName: "fresh",
      description: null,
      projection,
    });

    expect(md).toContain('Parachute Vault "fresh"');
    expect(md).toContain("No tag schemas declared");
    expect(md).toContain("No indexed metadata fields");
    expect(md).toContain("Querying");
  });

  it("markdown brief stays under ~5K tokens for a 50-tags-with-schemas vault", async () => {
    const { buildVaultProjection, projectionToMarkdown } = await import(
      "./vault-projection.ts"
    );

    for (let i = 0; i < 50; i++) {
      await store.upsertTagRecord(`schema_tag_${i}`, {
        description: `Description for tag ${i} — covers what this tag is used for in the vault.`,
        fields: {
          [`field_${i}_a`]: { type: "string", indexed: i % 3 === 0 },
          [`field_${i}_b`]: { type: "integer" },
        },
      });
    }

    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({
      vaultName: "big",
      description: "Big test vault",
      projection,
    });

    // Rough token approximation: 1 token ≈ 4 chars. Budget: 5K tokens.
    const approxTokens = md.length / 4;
    expect(approxTokens).toBeLessThan(5000);
  });
});
