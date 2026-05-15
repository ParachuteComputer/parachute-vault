/**
 * Tests for the multi-vault system using bun:sqlite.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BunStore } from "./vault-store.ts";
import { generateMcpTools } from "../core/src/mcp.ts";
import { getLinksHydrated } from "../core/src/links.ts";
import { handleNotes, handleTags, handleFindPath, handleVault } from "./routes.ts";
import { extractApiKey } from "./auth.ts";

let db: Database;
let store: BunStore;
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `vault-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  db = new Database(join(tmpDir, "test.db"));
  store = new BunStore(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("BunStore", async () => {
  test("creates and retrieves a note", async () => {
    const note = await store.createNote("Hello world");
    expect(note.id).toBeTruthy();
    expect(note.content).toBe("Hello world");

    const fetched = await store.getNote(note.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe("Hello world");
  });

  test("creates note with tags", async () => {
    const note = await store.createNote("Tagged note", { tags: ["daily", "pinned"] });
    expect(note.tags).toContain("daily");
    expect(note.tags).toContain("pinned");
  });

  test("creates note with path", async () => {
    const note = await store.createNote("Doc note", { path: "blog/first-post" });
    expect(note.path).toBe("blog/first-post");
  });

  test("updates a note", async () => {
    const note = await store.createNote("Original");
    const updated = await store.updateNote(note.id, { content: "Updated" });
    expect(updated.content).toBe("Updated");
    expect(updated.updatedAt).toBeTruthy();
  });

  test("user updates bump updatedAt", async () => {
    const note = await store.createNote("Original");
    expect(note.updatedAt).toBe(note.createdAt);
    const updated = await store.updateNote(note.id, { content: "Edited by user" });
    expect(updated.updatedAt).toBeTruthy();
    // Must be monotonically non-decreasing — and strictly greater when the
    // caller passed if_updated_at (tested elsewhere). Same-millisecond
    // collisions are possible here since no if_updated_at is supplied.
    expect(updated.updatedAt! >= note.createdAt).toBe(true);
  });

  test("skipUpdatedAt preserves updatedAt (hook-style writes)", async () => {
    // Hook writes (e.g., the reader-audio hook's metadata markers) must not
    // count as user activity. See issue #44 — hook writes were bumping
    // updatedAt and wrecking Daily's reader sort. Fresh notes have
    // `updatedAt === createdAt`; a hook write must leave it at that value so
    // `updatedAt > createdAt` remains the correct "user-touched" signal.
    const note = await store.createNote("Content");
    expect(note.updatedAt).toBe(note.createdAt);

    // Fresh note: a machine write must not advance updatedAt past createdAt.
    await store.updateNote(note.id, {
      metadata: { audio_pending_at: "2026-04-09T10:00:00.000Z" },
      skipUpdatedAt: true,
    });
    let fetched = (await store.getNote(note.id))!;
    expect(fetched.updatedAt).toBe(note.createdAt);
    expect((fetched.metadata as { audio_pending_at?: string } | undefined)?.audio_pending_at).toBe(
      "2026-04-09T10:00:00.000Z",
    );

    // Now a real user edit bumps it.
    await new Promise((r) => setTimeout(r, 5));
    await store.updateNote(note.id, { content: "User edit" });
    fetched = (await store.getNote(note.id))!;
    const userTs = fetched.updatedAt;
    expect(userTs).toBeTruthy();

    // A subsequent machine write must not overwrite the user's timestamp.
    await new Promise((r) => setTimeout(r, 5));
    await store.updateNote(note.id, {
      metadata: {
        ...(fetched.metadata as Record<string, unknown>),
        audio_rendered_at: "2026-04-09T10:05:00.000Z",
      },
      skipUpdatedAt: true,
    });
    fetched = (await store.getNote(note.id))!;
    expect(fetched.updatedAt).toBe(userTs!);
    expect((fetched.metadata as { audio_rendered_at?: string } | undefined)?.audio_rendered_at).toBe(
      "2026-04-09T10:05:00.000Z",
    );
  });

  test("deletes a note", async () => {
    const note = await store.createNote("To delete");
    await store.deleteNote(note.id);
    expect(await store.getNote(note.id)).toBeNull();
  });

  test("queries notes by tag", async () => {
    await store.createNote("A", { tags: ["daily"] });
    await store.createNote("B", { tags: ["doc"] });
    await store.createNote("C", { tags: ["daily", "pinned"] });

    const daily = await store.queryNotes({ tags: ["daily"] });
    expect(daily.length).toBe(2);
  });

  test("queries with exclude tags", async () => {
    await store.createNote("A", { tags: ["daily"] });
    await store.createNote("B", { tags: ["daily", "archived"] });

    const active = await store.queryNotes({ tags: ["daily"], excludeTags: ["archived"] });
    expect(active.length).toBe(1);
    expect(active[0].content).toBe("A");
  });

  test("full-text search", async () => {
    await store.createNote("The quick brown fox");
    await store.createNote("A lazy dog");

    const results = await store.searchNotes("fox");
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("fox");
  });

  test("tags and untags notes", async () => {
    const note = await store.createNote("Taggable");
    await store.tagNote(note.id, ["important"]);
    let fetched = (await store.getNote(note.id))!;
    expect(fetched.tags).toContain("important");

    await store.untagNote(note.id, ["important"]);
    fetched = (await store.getNote(note.id))!;
    expect(fetched.tags).not.toContain("important");
  });

  test("lists tags with counts", async () => {
    await store.createNote("A", { tags: ["daily"] });
    await store.createNote("B", { tags: ["daily"] });
    await store.createNote("C", { tags: ["doc"] });

    const tags = await store.listTags();
    const daily = tags.find((t) => t.name === "daily");
    expect(daily?.count).toBe(2);
    const doc = tags.find((t) => t.name === "doc");
    expect(doc?.count).toBe(1);
  });

  test("creates and queries links", async () => {
    const a = await store.createNote("Note A");
    const b = await store.createNote("Note B");

    const link = await store.createLink(a.id, b.id, "related-to");
    expect(link.sourceId).toBe(a.id);
    expect(link.targetId).toBe(b.id);
    expect(link.relationship).toBe("related-to");

    const outbound = await store.getLinks(a.id, { direction: "outbound" });
    expect(outbound.length).toBe(1);

    const inbound = await store.getLinks(b.id, { direction: "inbound" });
    expect(inbound.length).toBe(1);

    await store.deleteLink(a.id, b.id, "related-to");
    expect((await store.getLinks(a.id)).length).toBe(0);
  });

  test("attachments", async () => {
    const note = await store.createNote("With attachment");
    const att = await store.addAttachment(note.id, "/path/to/file.png", "image/png");
    expect(att.noteId).toBe(note.id);

    const atts = await store.getAttachments(note.id);
    expect(atts.length).toBe(1);
    expect(atts[0].mimeType).toBe("image/png");
  });

  test("starts with no tags", async () => {
    const tags = await store.listTags();
    expect(tags.length).toBe(0);
  });

  test("gets note by path", async () => {
    await store.createNote("README content", { path: "Projects/Parachute/README" });
    const note = await store.getNoteByPath("Projects/Parachute/README");
    expect(note).not.toBeNull();
    expect(note!.content).toBe("README content");
    expect(note!.path).toBe("Projects/Parachute/README");
  });

  test("gets multiple notes by IDs", async () => {
    const a = await store.createNote("A");
    const b = await store.createNote("B");
    const c = await store.createNote("C");

    const fetched = await store.getNotes([a.id, c.id]);
    expect(fetched.length).toBe(2);
    expect(fetched.map((n) => n.content)).toContain("A");
    expect(fetched.map((n) => n.content)).toContain("C");
  });

  test("queries by path prefix", async () => {
    await store.createNote("Root README", { path: "README" });
    await store.createNote("Project README", { path: "Projects/Parachute/README" });
    await store.createNote("Project Notes", { path: "Projects/Parachute/Notes" });
    await store.createNote("Other", { path: "Other/Stuff" });

    const results = await store.queryNotes({ pathPrefix: "Projects/Parachute" });
    expect(results.length).toBe(2);
    expect(results.map((n) => n.path)).toContain("Projects/Parachute/README");
    expect(results.map((n) => n.path)).toContain("Projects/Parachute/Notes");
  });
});

describe("metadata", async () => {
  test("creates note with metadata", async () => {
    const note = await store.createNote("Meeting notes", {
      path: "Meetings/standup",
      metadata: { status: "draft", priority: "high", attendees: ["alice", "bob"] },
    });
    expect(note.metadata).toBeDefined();
    expect(note.metadata!.status).toBe("draft");
    expect(note.metadata!.priority).toBe("high");
    expect(note.metadata!.attendees).toEqual(["alice", "bob"]);
  });

  test("updates note metadata", async () => {
    const note = await store.createNote("Doc", { metadata: { status: "draft" } });
    const updated = await store.updateNote(note.id, { metadata: { status: "published", version: 2 } });
    expect(updated.metadata!.status).toBe("published");
    expect(updated.metadata!.version).toBe(2);
  });

  test("queries notes by metadata", async () => {
    await store.createNote("Draft 1", { metadata: { status: "draft" } });
    await store.createNote("Draft 2", { metadata: { status: "draft" } });
    await store.createNote("Published", { metadata: { status: "published" } });

    const drafts = await store.queryNotes({ metadata: { status: "draft" } });
    expect(drafts.length).toBe(2);

    const published = await store.queryNotes({ metadata: { status: "published" } });
    expect(published.length).toBe(1);
    expect(published[0].content).toBe("Published");
  });

  test("notes without metadata return undefined metadata", async () => {
    const note = await store.createNote("Plain note");
    expect(note.metadata).toBeUndefined();
  });

  test("creates link with metadata", async () => {
    const a = await store.createNote("A");
    const b = await store.createNote("B");
    const link = await store.createLink(a.id, b.id, "related-to", {
      confidence: 0.9,
      context: "mentioned in meeting",
    });
    expect(link.metadata).toBeDefined();
    expect(link.metadata!.confidence).toBe(0.9);
    expect(link.metadata!.context).toBe("mentioned in meeting");
  });

  test("hydrated links include note metadata", async () => {
    const a = await store.createNote("A", { metadata: { type: "project" } });
    const b = await store.createNote("B", { metadata: { type: "task" } });
    await store.createLink(a.id, b.id, "contains");

    const links = getLinksHydrated(db, a.id);
    expect(links[0].sourceNote?.metadata?.type).toBe("project");
    expect(links[0].targetNote?.metadata?.type).toBe("task");
  });
});

describe("bulk operations", async () => {
  test("creates multiple notes at once", async () => {
    const notes = await store.createNotes([
      { content: "Note 1", tags: ["daily"] },
      { content: "Note 2", tags: ["doc"] },
      { content: "Note 3" },
    ]);
    expect(notes.length).toBe(3);
    expect(notes[0].tags).toContain("daily");
    expect(notes[1].tags).toContain("doc");
  });

  test("createNotes accepts per-note metadata and created_at (mixed batch)", async () => {
    const notes = await store.createNotes([
      { content: "Plain", tags: ["daily"] },
      {
        content: "With metadata",
        path: "Imports/with-meta",
        metadata: { source: "tana-import", tana_type: "flow" },
      },
      {
        content: "With backdated created_at",
        path: "Imports/backdated",
        metadata: { source: "tana-import" },
        created_at: "2020-01-15T12:00:00.000Z",
      },
    ]);
    expect(notes.length).toBe(3);

    // Plain note: no source metadata, recent createdAt
    expect(notes[0].metadata?.source).toBeUndefined();
    expect(notes[0].tags).toContain("daily");

    // Metadata-only note: metadata flows through, createdAt is recent
    expect(notes[1].metadata?.source).toBe("tana-import");
    expect(notes[1].metadata?.tana_type).toBe("flow");
    expect(notes[1].path).toBe("Imports/with-meta");

    // Backdated note: createdAt honored exactly
    expect(notes[2].createdAt).toBe("2020-01-15T12:00:00.000Z");
    expect(notes[2].metadata?.source).toBe("tana-import");
  });

  test("createNotes preserves per-note metadata isolation across many notes", async () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      content: `Day ${i}`,
      path: `Journal/2024-06-${String(i + 1).padStart(2, "0")}`,
      tags: ["captured"],
      metadata: {
        source: "tana-import",
        tana_path: `daily/2024-06-${i + 1}.md`,
        index: i,
      },
      created_at: `2024-06-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));
    const notes = await store.createNotes(inputs);
    expect(notes.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(notes[i].path).toBe(`Journal/2024-06-${String(i + 1).padStart(2, "0")}`);
      expect(notes[i].metadata?.index).toBe(i);
      expect(notes[i].metadata?.tana_path).toBe(`daily/2024-06-${i + 1}.md`);
      expect(notes[i].createdAt).toBe(`2024-06-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`);
      expect(notes[i].tags).toContain("captured");
    }
  });

  test("createNotes is backwards compatible — omitted metadata/created_at use defaults", async () => {
    const before = new Date().toISOString();
    const notes = await store.createNotes([
      { content: "Just content" },
      { content: "Content + tags", tags: ["x"] },
    ]);
    const after = new Date().toISOString();
    expect(notes[0].metadata?.source).toBeUndefined();
    expect(notes[1].metadata?.source).toBeUndefined();
    // createdAt defaults to "now" — should fall in [before, after]
    expect(notes[0].createdAt >= before).toBe(true);
    expect(notes[0].createdAt <= after).toBe(true);
  });

  test("batch tags multiple notes", async () => {
    const a = await store.createNote("A");
    const b = await store.createNote("B");
    const c = await store.createNote("C");

    await store.batchTag([a.id, b.id, c.id], ["important", "review"]);

    expect((await store.getNote(a.id))!.tags).toContain("important");
    expect((await store.getNote(b.id))!.tags).toContain("review");
    expect((await store.getNote(c.id))!.tags).toContain("important");
  });

  test("batch untags multiple notes", async () => {
    const a = await store.createNote("A", { tags: ["daily", "pinned"] });
    const b = await store.createNote("B", { tags: ["daily", "pinned"] });

    await store.batchUntag([a.id, b.id], ["pinned"]);

    expect((await store.getNote(a.id))!.tags).toContain("daily");
    expect((await store.getNote(a.id))!.tags).not.toContain("pinned");
    expect((await store.getNote(b.id))!.tags).not.toContain("pinned");
  });
});

describe("deeper link queries", async () => {
  test("traverses links multi-hop", async () => {
    const a = await store.createNote("A");
    const b = await store.createNote("B");
    const c = await store.createNote("C");
    const d = await store.createNote("D");

    await store.createLink(a.id, b.id, "related-to");
    await store.createLink(b.id, c.id, "related-to");
    await store.createLink(c.id, d.id, "related-to");

    // 1 hop from A: should find B
    const hop1 = await store.traverseLinks(a.id, { max_depth: 1 });
    expect(hop1.length).toBe(1);
    expect(hop1[0].noteId).toBe(b.id);

    // 2 hops from A: should find B and C
    const hop2 = await store.traverseLinks(a.id, { max_depth: 2 });
    expect(hop2.length).toBe(2);
    const ids2 = hop2.map((n) => n.noteId);
    expect(ids2).toContain(b.id);
    expect(ids2).toContain(c.id);

    // 3 hops from A: should find B, C, and D
    const hop3 = await store.traverseLinks(a.id, { max_depth: 3 });
    expect(hop3.length).toBe(3);
  });

  test("traverses with relationship filter", async () => {
    const a = await store.createNote("A");
    const b = await store.createNote("B");
    const c = await store.createNote("C");

    await store.createLink(a.id, b.id, "mentions");
    await store.createLink(a.id, c.id, "related-to");

    const mentions = await store.traverseLinks(a.id, { max_depth: 1, relationship: "mentions" });
    expect(mentions.length).toBe(1);
    expect(mentions[0].noteId).toBe(b.id);
  });

  test("finds path between notes", async () => {
    const a = await store.createNote("A");
    const b = await store.createNote("B");
    const c = await store.createNote("C");

    await store.createLink(a.id, b.id, "related-to");
    await store.createLink(b.id, c.id, "mentions");

    const result = await store.findPath(a.id, c.id);
    expect(result).not.toBeNull();
    expect(result!.path).toEqual([a.id, b.id, c.id]);
    expect(result!.relationships).toEqual(["related-to", "mentions"]);
  });

  test("get-links returns hydrated note summaries", async () => {
    const a = await store.createNote("Note A", { path: "a", tags: ["important"] });
    const b = await store.createNote("Note B", { path: "b" });
    await store.createLink(a.id, b.id, "related-to");

    const result = getLinksHydrated(db, a.id);
    expect(result.length).toBe(1);
    expect(result[0].targetNote?.path).toBe("b");
    expect(result[0].sourceNote?.path).toBe("a");
    expect(result[0].sourceNote?.tags).toContain("important");
  });

  test("returns null when no path exists", async () => {
    const a = await store.createNote("A");
    const b = await store.createNote("B");
    // No link between them

    const result = await store.findPath(a.id, b.id);
    expect(result).toBeNull();
  });
});

describe("MCP tools", async () => {
  test("generates the consolidated tool set", () => {
    const tools = generateMcpTools(store);
    expect(tools.length).toBe(9);

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
    // Six note-schema MCP tools (list/update/delete-note-schema +
    // list/set/delete-schema-mapping) retired in v17 — vault#267.
    expect(names).not.toContain("list-note-schemas");
    expect(names).not.toContain("set-schema-mapping");
    // synthesize-notes retired in v17 — vault#268.
    expect(names).not.toContain("synthesize-notes");
  });

  test("query-notes by id works", async () => {
    const tools = generateMcpTools(store);
    const note = await store.createNote("By ID", { path: "test/note" });

    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: note.id }) as any;
    expect(result.content).toBe("By ID");
    expect(result.path).toBe("test/note");
  });

  test("query-notes by path works", async () => {
    const tools = generateMcpTools(store);
    await store.createNote("By Path", { path: "Projects/README" });

    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: "Projects/README" }) as any;
    expect(result.content).toBe("By Path");
  });

  test("create-note tool works via execute", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = await createNote.execute({ content: "MCP note", tags: ["daily"] }) as any;
    expect(result.content).toBe("MCP note");
    expect(result.tags).toContain("daily");
  });

  test("every tool has inputSchema and execute", () => {
    const tools = generateMcpTools(store);
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.execute).toBeFunction();
    }
  });
});

describe("scoped MCP wrapper", async () => {
  test("vault-info returns the vault's stats", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `scoped-stats-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
      description: "Test vault",
    });

    const vaultStore = getVaultStore(vaultName);
    await vaultStore.createNote("alpha", { tags: ["x", "y"] });
    await vaultStore.createNote("beta", { tags: ["x"] });

    const tools = generateScopedMcpTools(vaultName);
    const vaultInfo = tools.find((t) => t.name === "vault-info");
    expect(vaultInfo).toBeTruthy();

    const result = await vaultInfo!.execute({ include_stats: true }) as any;
    expect(result.name).toBe(vaultName);
    expect(result.description).toBe("Test vault");
    expect(result.stats.totalNotes).toBe(2);
    expect(result.stats.tagCount).toBe(2);

    closeAllStores();
  });

  test("vault-info projection includes tags-with-schemas + indexed_fields + query_hints (vault#271)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `proj-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
      description: "vault for #271",
    });

    const vaultStore = getVaultStore(vaultName);
    await vaultStore.upsertTagRecord("_default", {
      fields: { created_by: { type: "string", description: "Origin" } },
    });

    // Indexed-field lifecycle is owned by the update-tag MCP tool — go
    // through the tool, not the store, so indexed_fields gets populated.
    const tools = generateScopedMcpTools(vaultName);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    await updateTag.execute({
      tag: "person",
      description: "A person",
      fields: { email: { type: "string", indexed: true } },
    });
    await updateTag.execute({
      tag: "employee",
      description: "Employee",
      fields: { title: { type: "string" } },
      parent_names: ["person"],
    });

    const vaultInfo = tools.find((t) => t.name === "vault-info")!;
    const result = await vaultInfo.execute({}) as any;

    expect(result.name).toBe(vaultName);
    expect(result.description).toBe("vault for #271");

    // tags array — only schema-bearing rows, with effective inheritance
    const byName = Object.fromEntries(
      (result.tags as any[]).map((t) => [t.name, t]),
    );
    expect(byName.person).toBeTruthy();
    expect(byName.person.effective_parents).toEqual(["_default"]);
    expect(Object.keys(byName.person.effective_fields).sort()).toEqual([
      "created_by",
      "email",
    ]);
    expect(byName.employee.effective_parents).toEqual(["person", "_default"]);
    expect(Object.keys(byName.employee.effective_fields).sort()).toEqual([
      "created_by",
      "email",
      "title",
    ]);

    // indexed_fields catalog
    const indexed = result.indexed_fields as any[];
    const emailEntry = indexed.find((f) => f.name === "email");
    expect(emailEntry).toBeTruthy();
    expect(emailEntry.type).toBe("string");
    expect(emailEntry.tags).toEqual(["person"]);

    // query_hints — static catalog, present even without include_stats
    expect(Array.isArray(result.query_hints)).toBe(true);
    expect((result.query_hints as string[]).length).toBeGreaterThan(0);

    // stats omitted unless requested
    expect(result.stats).toBeUndefined();

    const withStats = await vaultInfo.execute({ include_stats: true }) as any;
    expect(withStats.stats).toBeTruthy();

    closeAllStores();
  });

  test("getServerInstruction renders projection markdown for a populated vault (vault#271)", async () => {
    const { getServerInstruction } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");

    const vaultName = `instr-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
      description: "Working notebook for the daily team.",
    });

    const vaultStore = getVaultStore(vaultName);
    await vaultStore.createNote("A", { tags: ["person"] });

    const tools = generateScopedMcpTools(vaultName);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    await updateTag.execute({
      tag: "person",
      description: "A person",
      fields: { email: { type: "string", indexed: true } },
    });

    const md = await getServerInstruction(vaultName);

    expect(md).toContain(`Parachute Vault "${vaultName}"`);
    expect(md).toContain("Working notebook for the daily team.");
    // vault#274: stats line distinguishes total tag count (note-usage)
    // from schema-bearing count. One note tagged `person`, one tag
    // overall, that one tag has a schema → "1 tag total, 1 with schemas".
    expect(md).toContain("1 note, 1 tag total, 1 with schemas");
    expect(md).toContain("1 tag with schemas: person");
    expect(md).toContain("Indexed metadata fields");
    expect(md).toContain("email");
    expect(md).toContain("#person");
    expect(md).toContain("Querying");
    expect(md).toContain("vault-info");
    expect(md).toContain("list-tags { include_schema: true }");

    closeAllStores();
  });

  test("getServerInstruction degrades gracefully on an empty vault (vault#271)", async () => {
    const { getServerInstruction } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `instr-empty-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    const md = await getServerInstruction(vaultName);

    expect(md).toContain(`Parachute Vault "${vaultName}"`);
    // vault#274: empty vault — no schemas, so the suffix is omitted.
    // 0 is plural per English convention. The not.toContain guard
    // pins that "with schemas" doesn't leak through anywhere — when
    // schemas exist it appears in two places (stats suffix + the
    // tags-with-schemas list line); on an empty vault both branches
    // are unreachable, so the phrase shouldn't appear at all.
    expect(md).toContain("0 notes, 0 tags total");
    expect(md).not.toContain("with schemas");
    expect(md).toContain("No tag schemas declared");
    expect(md).toContain("No indexed metadata fields");
    // Refresh hints surface both pointers so the agent knows where to look.
    expect(md).toContain("vault-info");
    expect(md).toContain("list-tags");

    closeAllStores();
  });

  test("getServerInstruction stays under ~5K tokens at 50 tags-with-schemas (vault#271)", async () => {
    const { getServerInstruction } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `instr-big-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
      description: "Stress-test fixture for the connect-time projection size.",
    });

    const vaultStore = getVaultStore(vaultName);
    for (let i = 0; i < 50; i++) {
      await vaultStore.upsertTagRecord(`schema_tag_${i}`, {
        description: `Description for tag ${i} — covers a meaningful chunk of the vault's domain.`,
        fields: {
          [`field_${i}_a`]: { type: "string" },
          [`field_${i}_b`]: { type: "integer" },
        },
      });
    }

    const md = await getServerInstruction(vaultName);
    // Rough token approximation: 1 token ≈ 4 chars. Budget: 5K tokens.
    const approxTokens = md.length / 4;
    expect(approxTokens).toBeLessThan(5000);

    closeAllStores();
  });

  test("getServerInstruction filters projection by tag-scoped allowlist (vault#271 fold 5)", async () => {
    const { getServerInstruction, generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `instr-scoped-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
      description: "Scoped session brief.",
    });

    // Seed three schema-bearing tags. Cross-declarer indexed `status`
    // exercises the same shape the JSON wrapper test pinned: scoped to
    // `task`, the brief should mention `status` via `task` but never
    // surface `project` or `person`.
    const tools = generateScopedMcpTools(vaultName);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    await updateTag.execute({
      tag: "task",
      description: "A task",
      fields: { status: { type: "string", indexed: true } },
    });
    await updateTag.execute({
      tag: "project",
      description: "A project",
      fields: { status: { type: "string", indexed: true } },
    });
    await updateTag.execute({
      tag: "person",
      description: "A person",
      fields: { email: { type: "string", indexed: true } },
    });

    const auth = {
      permission: "full" as const,
      scopes: ["vault:read", "vault:write", "vault:admin"],
      legacyDerived: false,
      scoped_tags: ["task"],
    };
    const md = await getServerInstruction(vaultName, auth as any);

    // Allowlisted tag surfaces; out-of-scope tags do not. Use word-boundary
    // regex — the static refresh-pointer text mentions "full projection"
    // which contains the substring "project".
    expect(md).toMatch(/\btask\b/);
    expect(md).not.toMatch(/\bproject\b/);
    expect(md).not.toMatch(/\bperson\b/);

    // Indexed-field catalog: `status` survives (declared by `task`);
    // `email` (person-only) is filtered out entirely.
    expect(md).toMatch(/\bstatus\b/);
    expect(md).not.toMatch(/\bemail\b/);

    // Aggregate stats line still flows through unchanged — counts are
    // pre-existing leak surface (per the rc.3 design discussion).
    expect(md).toMatch(/\d+ note/);

    closeAllStores();
  });

  test("getServerInstruction passes the full projection through for unscoped tokens (vault#271 fold 5)", async () => {
    const { getServerInstruction, generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `instr-unscoped-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });

    const tools = generateScopedMcpTools(vaultName);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    await updateTag.execute({
      tag: "task",
      description: "A task",
      fields: { status: { type: "string" } },
    });
    await updateTag.execute({
      tag: "project",
      description: "A project",
      fields: { priority: { type: "integer" } },
    });

    // No `auth` arg → no scoping applied, full projection rendered.
    const md = await getServerInstruction(vaultName);
    expect(md).toContain("task");
    expect(md).toContain("project");
    expect(md).toContain("tags with schemas");
    // Same for explicit auth with `scoped_tags: null`.
    const mdNullScoped = await getServerInstruction(vaultName, {
      permission: "full",
      scopes: ["vault:read"],
      legacyDerived: false,
      scoped_tags: null,
    } as any);
    expect(mdNullScoped).toContain("task");
    expect(mdNullScoped).toContain("project");

    closeAllStores();
  });

  test("MCP initialize response carries scope-filtered instructions for tag-scoped tokens (vault#271 fold 5)", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `init-scoped-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });

    // Same fixture shape as the unit test, but driven through the actual
    // `handleScopedMcp` initialize path the MCP client invokes at session
    // start. The reviewer asked for an integration assertion on the
    // `instructions` field carried in the `initialize` response.
    const tools = generateScopedMcpTools(vaultName);
    const updateTag = tools.find((t) => t.name === "update-tag")!;
    await updateTag.execute({
      tag: "task",
      description: "A task",
      fields: { status: { type: "string" } },
    });
    await updateTag.execute({
      tag: "project",
      description: "A project",
      fields: { priority: { type: "integer" } },
    });

    const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }),
    });

    const res = await handleScopedMcp(req, vaultName, {
      permission: "full",
      scopes: ["vault:read", "vault:write", "vault:admin"],
      legacyDerived: false,
      scoped_tags: ["task"],
    } as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const instructions: string = body.result.instructions;
    expect(instructions).toBeTruthy();
    // Word-boundary match — the static refresh text mentions "full
    // projection" which would false-trigger a substring check.
    expect(instructions).toMatch(/\btask\b/);
    expect(instructions).not.toMatch(/\bproject\b/);

    closeAllStores();
  });

  test("list-tags with schema returns per-tag detail", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tag-schema-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    const vaultStore = getVaultStore(vaultName);
    await vaultStore.createNote("A", { tags: ["person"] });
    await vaultStore.upsertTagSchema("person", {
      description: "A person",
      fields: { name: { type: "string", description: "Full name" } },
    });

    const tools = generateScopedMcpTools(vaultName);

    // list-tags with tag param for single tag detail
    const listTags = tools.find((t) => t.name === "list-tags")!;
    const detail = await listTags.execute({ tag: "person" }) as any;
    expect(detail.name).toBe("person");
    expect(detail.count).toBe(1);
    expect(detail.description).toBe("A person");
    expect(detail.fields.name.type).toBe("string");

    closeAllStores();
  });

  test("create-note with schema tag auto-populates defaults", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `schema-create-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    const vaultStore = getVaultStore(vaultName);
    await vaultStore.upsertTagSchema("person", {
      description: "A person",
      fields: {
        first_appeared: { type: "string", description: "When" },
        relationship: { type: "string", description: "How" },
      },
    });

    const tools = generateScopedMcpTools(vaultName);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const queryNotes = tools.find((t) => t.name === "query-notes")!;

    // Create a note tagged person with no metadata — defaults auto-populated
    const result = await createNote.execute({
      content: "Alice",
      tags: ["person"],
    }) as any;
    expect(result.content).toBe("Alice");

    // Verify defaults were written
    const fresh = await queryNotes.execute({ id: result.id }) as any;
    expect(fresh.metadata.first_appeared).toBe("");
    expect(fresh.metadata.relationship).toBe("");

    // Create with explicit metadata — preserved
    const result2 = await createNote.execute({
      content: "Bob",
      tags: ["person"],
      metadata: { first_appeared: "2024-01", relationship: "friend" },
    }) as any;
    const fresh2 = await queryNotes.execute({ id: result2.id }) as any;
    expect(fresh2.metadata.first_appeared).toBe("2024-01");
    expect(fresh2.metadata.relationship).toBe("friend");

    closeAllStores();
  });

  test("update-note tags.add with schema auto-populates defaults", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores: close } = await import("./vault-store.ts");

    const vaultName = `schema-defaults-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    const vaultStore = getVaultStore(vaultName);
    await vaultStore.upsertTagSchema("person", {
      description: "A person",
      fields: {
        first_appeared: { type: "string", description: "When" },
        relationship: { type: "string", description: "How" },
      },
    });
    await vaultStore.upsertTagSchema("project", {
      description: "A project",
      fields: {
        status: { type: "string", enum: ["active", "completed", "abandoned"], description: "Status" },
        active: { type: "boolean", description: "Is active" },
        priority: { type: "integer", description: "Priority level" },
      },
    });
    const tools = generateScopedMcpTools(vaultName);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const queryNotes = tools.find((t) => t.name === "query-notes")!;

    // Create a note, then add #person tag via update-note
    const note = await createNote.execute({ content: "Alice" }) as any;
    await updateNote.execute({ id: note.id, tags: { add: ["person"] }, force: true });
    const after = await queryNotes.execute({ id: note.id }) as any;
    expect(after.metadata.first_appeared).toBe("");
    expect(after.metadata.relationship).toBe("");

    // Tag note that already has partial metadata — only missing fields populated
    const note2 = await createNote.execute({
      content: "Bob",
      metadata: { first_appeared: "2023-11" },
    }) as any;
    await updateNote.execute({ id: note2.id, tags: { add: ["person"] }, force: true });
    const after2 = await queryNotes.execute({ id: note2.id }) as any;
    expect(after2.metadata.first_appeared).toBe("2023-11"); // preserved
    expect(after2.metadata.relationship).toBe(""); // added

    // Tag with #project — enum defaults to first value, boolean to false, integer to 0
    const note4 = await createNote.execute({ content: "My Project" }) as any;
    await updateNote.execute({ id: note4.id, tags: { add: ["project"] }, force: true });
    const after4 = await queryNotes.execute({ id: note4.id }) as any;
    expect(after4.metadata.status).toBe("active");
    expect(after4.metadata.active).toBe(false);
    expect(after4.metadata.priority).toBe(0);

    // Multiple schema tags at once — all defaults merged
    const note5 = await createNote.execute({ content: "Multi" }) as any;
    await updateNote.execute({ id: note5.id, tags: { add: ["person", "project"] }, force: true });
    const after5 = await queryNotes.execute({ id: note5.id }) as any;
    expect(after5.metadata.first_appeared).toBe("");
    expect(after5.metadata.relationship).toBe("");
    expect(after5.metadata.status).toBe("active");
    expect(after5.metadata.active).toBe(false);

    close();
  });

  // -- tag-scoped MCP wrappers (patterns/tag-scoped-tokens.md) ------------
  //
  // These pin the behavior of `applyTagScopeWrappers` in mcp-tools.ts: each
  // wrapped tool's execute() honors the auth's scoped_tags allowlist. The
  // unscoped path (auth.scoped_tags === null) remains identical to the
  // baseline scoped MCP tests above; here we only assert the *scoped*
  // path's deltas.

  function authForTags(tags: string[]) {
    return {
      scopes: ["vault:read", "vault:write", "vault:admin"],
      legacyDerived: false,
      scoped_tags: tags,
    } as const;
  }

  test("scoped query-notes filters list to in-scope notes only", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-query-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.createNote("h", { tags: ["health"] });
    await store.createNote("w", { tags: ["work"] });

    const tools = generateScopedMcpTools(vaultName, authForTags(["health"]) as any);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({}) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.every((n: any) => n.tags.includes("health"))).toBe(true);
    expect(result.find((n: any) => n.content === "w")).toBeUndefined();

    closeAllStores();
  });

  test("scoped query-notes by id 404s on out-of-scope note", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-byid-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    const w = await store.createNote("w", { tags: ["work"] });

    const tools = generateScopedMcpTools(vaultName, authForTags(["health"]) as any);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: w.id }) as any;
    expect(result.error).toBe("Note not found");
    expect(result.id).toBe(w.id);

    closeAllStores();
  });

  test("scoped list-tags filters to allowlisted root + descendants", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-tags-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.upsertTagRecord("health/food", { parent_names: ["health"] });
    await store.createNote("h", { tags: ["health"] });
    await store.createNote("hf", { tags: ["health/food"] });
    await store.createNote("w", { tags: ["work"] });

    const tools = generateScopedMcpTools(vaultName, authForTags(["health"]) as any);
    const listTags = tools.find((t) => t.name === "list-tags")!;
    const result = await listTags.execute({}) as any[];
    const names = result.map((t) => t.name);
    expect(names).toContain("health");
    expect(names).toContain("health/food");
    expect(names).not.toContain("work");

    closeAllStores();
  });

  test("scoped vault-info filters projection.tags + indexed_fields to the allowlist (vault#271 fold)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-vault-info-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });

    // Seed two schema-bearing tags. `task` and `project` BOTH declare a
    // shared indexed `status` field — this exercises the cross-declarer
    // case the reviewer called out: a token scoped to `task` should see
    // `status` (because task is a declarer) but the entry's `tags` array
    // must list only `task`, not `project`.
    const unscopedTools = generateScopedMcpTools(vaultName);
    const updateTag = unscopedTools.find((t) => t.name === "update-tag")!;
    await updateTag.execute({
      tag: "task",
      description: "A task",
      fields: { status: { type: "string", indexed: true } },
    });
    await updateTag.execute({
      tag: "project",
      description: "A project",
      fields: {
        status: { type: "string", indexed: true },
        priority: { type: "integer", indexed: true },
      },
    });

    // Now mint scoped tools, scoped to `task` only.
    const tools = generateScopedMcpTools(vaultName, authForTags(["task"]) as any);
    const vaultInfo = tools.find((t) => t.name === "vault-info")!;
    const result = await vaultInfo.execute({}) as any;

    // tags array: only `task`, not `project`.
    const tagNames = (result.tags as { name: string }[]).map((t) => t.name);
    expect(tagNames).toContain("task");
    expect(tagNames).not.toContain("project");

    // indexed_fields: `status` survives (task is a declarer), `priority`
    // dropped entirely (only project declared it).
    const indexedNames = (result.indexed_fields as { name: string }[]).map((f) => f.name);
    expect(indexedNames).toContain("status");
    expect(indexedNames).not.toContain("priority");

    // Cross-declarer attribution leak: `status` lists declarer tags. The
    // scoped response must show only `task`, never the out-of-scope
    // `project`.
    const status = (result.indexed_fields as { name: string; tags: string[] }[]).find(
      (f) => f.name === "status",
    )!;
    expect(status.tags).toEqual(["task"]);

    // Top-level passthrough sanity: name, description, and query_hints are
    // not tag-scoped surfaces — they must still flow through.
    expect(result.name).toBe(vaultName);
    expect(Array.isArray(result.query_hints)).toBe(true);
    expect((result.query_hints as string[]).length).toBeGreaterThan(0);

    closeAllStores();
  });

  test("unscoped vault-info still sees the full projection (vault#271 fold)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-vault-info-unscoped-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });

    const tools0 = generateScopedMcpTools(vaultName);
    const updateTag = tools0.find((t) => t.name === "update-tag")!;
    await updateTag.execute({ tag: "task", description: "T", fields: { status: { type: "string", indexed: true } } });
    await updateTag.execute({ tag: "project", description: "P", fields: { status: { type: "string", indexed: true } } });

    // No `auth` and no `scoped_tags` — unscoped path must remain
    // identical to pre-fold behavior (full projection).
    const tools = generateScopedMcpTools(vaultName);
    const result = await tools.find((t) => t.name === "vault-info")!.execute({}) as any;
    const tagNames = (result.tags as { name: string }[]).map((t) => t.name);
    expect(tagNames.sort()).toEqual(["project", "task"]);
    const status = (result.indexed_fields as { name: string; tags: string[] }[]).find((f) => f.name === "status")!;
    expect(status.tags.sort()).toEqual(["project", "task"]);

    closeAllStores();
  });

  test("scoped create-note rejects a note whose tags fall outside the allowlist", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-create-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    getVaultStore(vaultName);

    const tools = generateScopedMcpTools(vaultName, authForTags(["health"]) as any);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({ content: "denied", tags: ["work"] }) as any;
    expect(result.error).toBe("Forbidden");
    expect(result.error_type).toBe("tag_scope_violation");
    expect(result.scoped_tags).toEqual(["health"]);

    closeAllStores();
  });

  test("scoped create-note batch rejects atomically when any note is out of scope", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-batch-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);

    const tools = generateScopedMcpTools(vaultName, authForTags(["health"]) as any);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({
      notes: [
        { content: "ok", tags: ["health"] },
        { content: "no", tags: ["work"] },
      ],
    }) as any;
    expect(result.error).toBe("Forbidden");
    // Atomic — neither write should have landed.
    expect((await store.listTags()).length).toBe(0);

    closeAllStores();
  });

  test("scoped delete-note 404s on an out-of-scope note (no leak)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-del-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    const w = await store.createNote("w", { tags: ["work"] });

    const tools = generateScopedMcpTools(vaultName, authForTags(["health"]) as any);
    const del = tools.find((t) => t.name === "delete-note")!;
    const result = await del.execute({ id: w.id }) as any;
    expect(result.error).toBe("Note not found");
    // Untouched.
    expect(await store.getNote(w.id)).toBeTruthy();

    closeAllStores();
  });

  test("scoped update-tag/delete-tag refuse to touch out-of-scope tags", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-tagop-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.createNote("w", { tags: ["work"] });

    const tools = generateScopedMcpTools(vaultName, authForTags(["health"]) as any);
    const update = tools.find((t) => t.name === "update-tag")!;
    const del = tools.find((t) => t.name === "delete-tag")!;

    const updateRes = await update.execute({ tag: "work", description: "denied" }) as any;
    expect(updateRes.error).toBe("Forbidden");
    expect(updateRes.error_type).toBe("tag_scope_violation");

    const delRes = await del.execute({ tag: "work" }) as any;
    expect(delRes.error).toBe("Forbidden");

    // The `work` tag is still attached to its note.
    expect((await store.listTags()).find((t) => t.name === "work")).toBeTruthy();

    closeAllStores();
  });

  // -- Q6: orphan sub-tag fail-open via string-form root ------------------

  test("scoped query-notes sees orphan sub-tag via string-form root (no schema)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-orphan-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    // No `_tags/health/food` schema is created — the hierarchy is implicit.
    const orphan = await store.createNote("orphan", { tags: ["health/food"] });

    const tools = generateScopedMcpTools(vaultName, authForTags(["health"]) as any);
    const query = tools.find((t) => t.name === "query-notes")!;

    const res = await query.execute({ id: orphan.id }) as any;
    // String-form fallback: `health/food` → root `health` → in allowlist.
    expect(res.error).toBeUndefined();
    expect(res.id).toBe(orphan.id);

    closeAllStores();
  });

  test("scoped create-note allows orphan sub-tag via string-form root", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-orphan-write-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    getVaultStore(vaultName);

    const tools = generateScopedMcpTools(vaultName, authForTags(["health"]) as any);
    const create = tools.find((t) => t.name === "create-note")!;

    const res = await create.execute({ content: "ok", tags: ["health/food"] }) as any;
    expect(res.error).toBeUndefined();
    expect(res.id).toBeDefined();

    closeAllStores();
  });

  // -- Q5: MCP delete-tag dependency check -------------------------------

  test("MCP delete-tag returns tag_in_use_by_tokens when a tag-scoped token references the tag", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");
    const { generateToken, createToken } = await import("./token-store.ts");

    const vaultName = `tagscope-dep-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.createNote("h", { tags: ["health"] });

    // Mint a tag-scoped token that references "health".
    const { fullToken } = generateToken();
    createToken(store.db, fullToken, {
      label: "health-claw",
      permission: "read",
      scopes: ["vault:read"],
      scoped_tags: ["health"],
    });

    // Unscoped admin attempts to delete `health` via MCP — should 409.
    const tools = generateScopedMcpTools(vaultName);
    const del = tools.find((t) => t.name === "delete-tag")!;
    const res = await del.execute({ tag: "health" }) as any;
    expect(res.error).toBe("TagInUseByTokens");
    expect(res.error_type).toBe("tag_in_use_by_tokens");
    expect(res.tag).toBe("health");
    expect(res.referenced_by?.length).toBe(1);
    expect(res.referenced_by?.[0]?.label).toBe("health-claw");

    // Tag is still attached to its note.
    expect((await store.listTags()).find((t) => t.name === "health")).toBeTruthy();

    closeAllStores();
  });

  test("MCP delete-tag proceeds when no token references the tag", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-nodep-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.createNote("h", { tags: ["health"] });

    const tools = generateScopedMcpTools(vaultName);
    const del = tools.find((t) => t.name === "delete-tag")!;
    const res = await del.execute({ tag: "health" }) as any;
    expect(res.error).toBeUndefined();

    closeAllStores();
  });

  test("update-note tags.add auto-populate does not bump updatedAt", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores: close } = await import("./vault-store.ts");

    const vaultName = `schema-noupdate-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    const vaultStore = getVaultStore(vaultName);
    await vaultStore.upsertTagSchema("person", {
      description: "A person",
      fields: { name: { type: "string" } },
    });

    const tools = generateScopedMcpTools(vaultName);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const queryNotes = tools.find((t) => t.name === "query-notes")!;

    const note = await createNote.execute({ content: "Test" }) as any;
    const originalUpdatedAt = note.updatedAt;
    await updateNote.execute({ id: note.id, tags: { add: ["person"] }, force: true });
    const after = await queryNotes.execute({ id: note.id }) as any;
    expect(after.updatedAt).toBe(originalUpdatedAt);
    expect(after.metadata.name).toBe("");

    close();
  });
});

describe("auth permissions", () => {
  test("read permission allows read-only tools", () => {
    const { isToolAllowed } = require("./auth.ts");
    expect(isToolAllowed("query-notes", "read")).toBe(true);
    expect(isToolAllowed("list-tags", "read")).toBe(true);
    expect(isToolAllowed("find-path", "read")).toBe(true);
    expect(isToolAllowed("vault-info", "read")).toBe(true);
  });

  test("read permission blocks mutation tools", () => {
    const { isToolAllowed } = require("./auth.ts");
    expect(isToolAllowed("create-note", "read")).toBe(false);
    expect(isToolAllowed("update-note", "read")).toBe(false);
    expect(isToolAllowed("delete-note", "read")).toBe(false);
    expect(isToolAllowed("update-tag", "read")).toBe(false);
    expect(isToolAllowed("delete-tag", "read")).toBe(false);
  });

  test("full permission allows all tools", () => {
    const { isToolAllowed } = require("./auth.ts");
    expect(isToolAllowed("create-note", "full")).toBe(true);
    expect(isToolAllowed("update-note", "full")).toBe(true);
    expect(isToolAllowed("delete-note", "full")).toBe(true);
    expect(isToolAllowed("update-tag", "full")).toBe(true);
    expect(isToolAllowed("delete-tag", "full")).toBe(true);
    expect(isToolAllowed("query-notes", "full")).toBe(true);
  });

  test("read permission allows GET but not POST/PATCH/DELETE", () => {
    const { isMethodAllowed } = require("./auth.ts");
    expect(isMethodAllowed("GET", "read")).toBe(true);
    expect(isMethodAllowed("HEAD", "read")).toBe(true);
    expect(isMethodAllowed("POST", "read")).toBe(false);
    expect(isMethodAllowed("PATCH", "read")).toBe(false);
    expect(isMethodAllowed("DELETE", "read")).toBe(false);
  });

  test("full permission allows all methods", () => {
    const { isMethodAllowed } = require("./auth.ts");
    expect(isMethodAllowed("GET", "full")).toBe(true);
    expect(isMethodAllowed("POST", "full")).toBe(true);
    expect(isMethodAllowed("PATCH", "full")).toBe(true);
    expect(isMethodAllowed("DELETE", "full")).toBe(true);
  });
});

// ---- HTTP route handlers ----

const BASE = "http://localhost/api";

function mkReq(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return new Request(`${BASE}${path}`, init);
}

describe("HTTP /notes", async () => {
  test("GET /notes defaults to lean index (no content field)", async () => {
    await store.createNote("one content", { path: "a", tags: ["t"] });
    await store.createNote("two content", { path: "b", tags: ["t"] });
    const res = await handleNotes(mkReq("GET", "/notes"), store, "");
    const body = await res.json() as any[];
    expect(body).toHaveLength(2);
    expect(body[0]).not.toHaveProperty("content");
    expect(body[0]).toHaveProperty("byteSize");
    expect(body[0]).toHaveProperty("preview");
  });

  test("GET /notes?include_content=true returns full notes", async () => {
    await store.createNote("full body", { path: "a" });
    const res = await handleNotes(mkReq("GET", "/notes?include_content=true"), store, "");
    const body = await res.json() as any[];
    expect(body[0].content).toBe("full body");
  });

  test("GET /notes?search=fox full-text search", async () => {
    await store.createNote("The quick brown fox");
    await store.createNote("A lazy dog");
    const res = await handleNotes(mkReq("GET", "/notes?search=fox"), store, "");
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
  });

  test("GET /notes?has_tags=false returns only untagged notes", async () => {
    await store.createNote("tagged", { tags: ["x"], path: "t" });
    await store.createNote("plain", { path: "p" });
    const res = await handleNotes(mkReq("GET", "/notes?has_tags=false&include_content=true"), store, "");
    const body = await res.json() as any[];
    expect(body.map((n) => n.content)).toEqual(["plain"]);
  });

  // ---- updated_at filter via date_field (vault#285 friction point 1.5) ----
  //
  // HTTP plumbing routes `date_field=updated_at&date_from=…` straight to
  // the core `dateFilter` resolver, which now recognizes `updated_at` as
  // a real column. Smoke-tests the end-to-end HTTP path; the engine-side
  // semantics are exercised in core.test.ts.
  test("GET /notes?date_field=updated_at filters by last-write time", async () => {
    const a = await store.createNote("untouched", { id: "ua", path: "ua" });
    const b = await store.createNote("modified", { id: "ub", path: "ub" });
    // Bump b's updated_at into the test window, leave a's at its createdAt.
    db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
      .run("2026-01-15T00:00:00.000Z", a.id);
    db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
      .run("2026-04-25T00:00:00.000Z", b.id);

    const res = await handleNotes(
      mkReq("GET", "/notes?date_field=updated_at&date_from=2026-04-01&include_content=true"),
      store,
      "",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body.map((n) => n.content)).toEqual(["modified"]);
  });

  test("GET /notes?has_links=false returns only orphaned notes", async () => {
    const a = await store.createNote("src", { id: "qa" });
    const b = await store.createNote("tgt", { id: "qb" });
    await store.createNote("orphan", { id: "qo" });
    await store.createLink(a.id, b.id, "mentions");
    const res = await handleNotes(mkReq("GET", "/notes?has_links=false&include_content=true"), store, "");
    const body = await res.json() as any[];
    expect(body.map((n) => n.content)).toEqual(["orphan"]);
  });

  test("GET /notes?search=fox&include_metadata=false strips metadata from search results", async () => {
    await store.createNote("The quick brown fox", { metadata: { summary: "animal" } });
    const res = await handleNotes(mkReq("GET", "/notes?search=fox&include_metadata=false"), store, "");
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].metadata).toBeUndefined();
  });

  test("GET /notes/:id defaults to full content", async () => {
    const n = await store.createNote("hello", { id: "x" });
    const res = await handleNotes(mkReq("GET", "/notes/x"), store, "/x");
    const body = await res.json() as any;
    expect(body.content).toBe("hello");
  });

  test("GET /notes/:id?include_content=false returns lean shape", async () => {
    await store.createNote("hello", { id: "x" });
    const res = await handleNotes(mkReq("GET", "/notes/x?include_content=false"), store, "/x");
    const body = await res.json() as any;
    expect(body).not.toHaveProperty("content");
    expect(body.byteSize).toBe(5);
    expect(body.preview).toBe("hello");
  });

  test("GET /notes?include_metadata=false strips metadata from list", async () => {
    await store.createNote("a", { tags: ["m"], metadata: { summary: "hello", status: "ok" } });
    await store.createNote("b", { tags: ["m"], metadata: { summary: "world" } });
    const res = await handleNotes(mkReq("GET", "/notes?tag=m&include_metadata=false"), store, "");
    const body = await res.json() as any[];
    expect(body).toHaveLength(2);
    for (const n of body) {
      expect(n.metadata).toBeUndefined();
    }
  });

  test("GET /notes?include_metadata=summary,status returns only those fields", async () => {
    await store.createNote("a", { tags: ["mf"], metadata: { summary: "hello", status: "ok", extra: true } });
    const res = await handleNotes(mkReq("GET", "/notes?tag=mf&include_metadata=summary,status"), store, "");
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].metadata).toEqual({ summary: "hello", status: "ok" });
  });

  test("GET /notes/:id?include_metadata=false strips metadata from single note", async () => {
    await store.createNote("hello", { id: "xm", metadata: { summary: "s" } });
    const res = await handleNotes(mkReq("GET", "/notes/xm?include_metadata=false"), store, "/xm");
    const body = await res.json() as any;
    expect(body.metadata).toBeUndefined();
    expect(body.content).toBe("hello");
  });

  test("GET /notes/:id?include_metadata=summary returns only specified fields", async () => {
    await store.createNote("hello", { id: "xm2", metadata: { summary: "s", status: "draft" } });
    const res = await handleNotes(mkReq("GET", "/notes/xm2?include_metadata=summary"), store, "/xm2");
    const body = await res.json() as any;
    expect(body.metadata).toEqual({ summary: "s" });
  });

  test("GET /notes/:id?expand_links=true inlines wikilink content", async () => {
    await store.createNote("target body", { path: "Target" });
    await store.createNote("see [[Target]]", { id: "src", path: "Src" });
    const res = await handleNotes(
      mkReq("GET", "/notes/src?expand_links=true"),
      store,
      "/src",
    );
    const body = await res.json() as any;
    expect(body.content).toContain('<expanded path="Target" mode="full">');
    expect(body.content).toContain("target body");
  });

  test("GET /notes/:id?expand_links=true&expand_mode=summary inlines metadata.summary only", async () => {
    await store.createNote("long body", {
      path: "T",
      metadata: { summary: "short" },
    });
    await store.createNote("see [[T]]", { id: "sx", path: "Sx" });
    const res = await handleNotes(
      mkReq("GET", "/notes/sx?expand_links=true&expand_mode=summary"),
      store,
      "/sx",
    );
    const body = await res.json() as any;
    expect(body.content).toContain('mode="summary"');
    expect(body.content).toContain("short");
    expect(body.content).not.toContain("long body");
  });

  test("GET /notes?tag=&include_content=true&expand_links=true expands per-note with cross-note dedup", async () => {
    await store.createNote("shared body", { path: "Shared" });
    await store.createNote("first [[Shared]]", { path: "A", tags: ["el"] });
    await store.createNote("second [[Shared]]", { path: "B", tags: ["el"] });
    const res = await handleNotes(
      mkReq("GET", "/notes?tag=el&include_content=true&expand_links=true&sort=asc"),
      store,
      "",
    );
    const body = await res.json() as any[];
    expect(body).toHaveLength(2);
    const expandedBlocks = body
      .map((n: any) => (n.content.match(/<expanded /g) ?? []).length)
      .reduce((a: number, b: number) => a + b, 0);
    expect(expandedBlocks).toBe(1);
    const withMarker = body.find((n: any) => n.content.includes("(expanded above)"));
    expect(withMarker).toBeTruthy();
  });

  test("POST /notes accepts createdAt (camelCase) in body", async () => {
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "hi", createdAt: "2025-01-01T00:00:00.000Z" }),
      store,
      "",
    );
    const body = await res.json() as any;
    expect(body.createdAt).toBe("2025-01-01T00:00:00.000Z");
  });

  // ---- Extension field (vault#328) ----

  test("POST /notes accepts extension and persists it", async () => {
    const res = await handleNotes(
      mkReq("POST", "/notes", {
        content: "month,total\n2026-01,9000",
        path: "Tabular/budget",
        extension: "csv",
      }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.extension).toBe("csv");
    const fetched = await store.getNote(body.id);
    expect(fetched!.extension).toBe("csv");
  });

  test("POST /notes defaults extension to 'md' when omitted", async () => {
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "plain", path: "p" }),
      store,
      "",
    );
    const body = await res.json() as any;
    expect(body.extension).toBe("md");
  });

  test("POST /notes rejects invalid extension with 400 invalid_extension", async () => {
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "x", extension: "CSV" }),
      store,
      "",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("invalid_extension");
    expect(body.extension).toBe("CSV");
  });

  test("POST /notes rejects reserved 'parachute' prefix with 400", async () => {
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "x", extension: "parachute" }),
      store,
      "",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("invalid_extension");
    expect(body.reason).toMatch(/reserved/);
  });

  test("PATCH /notes/:id changes extension", async () => {
    const note = await store.createNote("hi", { id: "ext-patch", path: "p" });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/ext-patch", {
        extension: "mdx",
        if_updated_at: note.updatedAt,
      }),
      store,
      "/ext-patch",
    );
    expect(res.status).toBe(200);
    const fetched = await store.getNote("ext-patch");
    expect(fetched!.extension).toBe("mdx");
  });

  test("PATCH /notes/:id rejects invalid extension with 400", async () => {
    const note = await store.createNote("hi", { id: "ext-bad", path: "p" });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/ext-bad", {
        extension: "foo.bar",
        if_updated_at: note.updatedAt,
      }),
      store,
      "/ext-bad",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("invalid_extension");
  });

  test("GET /notes?extension=csv filters by extension", async () => {
    await store.createNote("md note", { path: "a" });
    await store.createNote("csv note", { path: "b", extension: "csv" });
    await store.createNote("yaml note", { path: "c", extension: "yaml" });
    const res = await handleNotes(
      mkReq("GET", "/notes?extension=csv&include_content=true"),
      store,
      "",
    );
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].path).toBe("b");
  });

  test("GET /notes?extension=csv&extension=yaml filters by array of extensions", async () => {
    await store.createNote("md note", { path: "a" });
    await store.createNote("csv note", { path: "b", extension: "csv" });
    await store.createNote("yaml note", { path: "c", extension: "yaml" });
    const res = await handleNotes(
      mkReq("GET", "/notes?extension=csv&extension=yaml&include_content=true"),
      store,
      "",
    );
    const body = await res.json() as any[];
    expect(body).toHaveLength(2);
    expect(body.map((n) => n.path).sort()).toEqual(["b", "c"]);
  });

  test("PATCH /notes/:id if_missing=create honors extension", async () => {
    const idOrPath = encodeURIComponent("Tabular/new-budget");
    const res = await handleNotes(
      mkReq("PATCH", `/notes/${idOrPath}`, {
        content: "month,total\n2026-02,1000",
        extension: "csv",
        if_missing: "create",
      }),
      store,
      `/${idOrPath}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.created).toBe(true);
    expect(body.extension).toBe("csv");
  });

  test("GET /notes?id=<path> returns 409 ambiguous_path when path matches multiple extensions (vault#330 S1)", async () => {
    await store.createNote("# md", { path: "Foo", id: "foo-md" });
    await store.createNote("a,b\n1,2", { path: "Foo", extension: "csv", id: "foo-csv" });
    const res = await handleNotes(
      mkReq("GET", "/notes?id=Foo"),
      store,
      "",
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error_type).toBe("ambiguous_path");
    expect(body.path).toBe("Foo");
    expect(body.candidates).toHaveLength(2);
  });

  test("GET /notes?id=Foo.csv resolves the explicit-extension form (vault#330 S1)", async () => {
    await store.createNote("# md", { path: "Foo", id: "foo-md" });
    await store.createNote("a,b\n1,2", { path: "Foo", extension: "csv", id: "foo-csv" });
    const res = await handleNotes(
      mkReq("GET", "/notes?id=Foo.csv"),
      store,
      "",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe("foo-csv");
  });

  test("POST /notes/:id/attachments accepts mimeType (camelCase) in body", async () => {
    const n = await store.createNote("x", { id: "x" });
    const res = await handleNotes(
      mkReq("POST", "/notes/x/attachments", { path: "files/a.png", mimeType: "image/png" }),
      store,
      "/x/attachments",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.mimeType).toBe("image/png");
  });

  describe("POST /notes/:id/attachments with transcribe flag", async () => {
    test("transcribe: true seeds pending status and marks note as stub", async () => {
      await store.createNote("# 🎙️ Voice memo\n\n_Transcript pending._", { id: "v1" });
      const res = await handleNotes(
        mkReq("POST", "/notes/v1/attachments", {
          path: "memos/memo-1.webm",
          mimeType: "audio/webm",
          transcribe: true,
        }),
        store,
        "/v1/attachments",
      );
      expect(res.status).toBe(201);
      const att = await res.json() as any;
      expect(att.metadata?.transcribe_status).toBe("pending");
      expect(att.metadata?.transcribe_requested_at).toBeTruthy();

      const note = await store.getNote("v1");
      expect((note!.metadata as any)?.transcribe_stub).toBe(true);
    });

    test("transcribe: false (default) leaves metadata empty and note untouched", async () => {
      await store.createNote("note body", { id: "v2" });
      const res = await handleNotes(
        mkReq("POST", "/notes/v2/attachments", {
          path: "memos/memo-2.webm",
          mimeType: "audio/webm",
        }),
        store,
        "/v2/attachments",
      );
      expect(res.status).toBe(201);
      const att = await res.json() as any;
      expect(att.metadata?.transcribe_status).toBeUndefined();

      const note = await store.getNote("v2");
      expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();
    });

    test("transcribe: true preserves other note metadata", async () => {
      await store.createNote("body", { id: "v3", metadata: { summary: "keep me" } });
      await handleNotes(
        mkReq("POST", "/notes/v3/attachments", {
          path: "memos/memo-3.webm",
          mimeType: "audio/webm",
          transcribe: true,
        }),
        store,
        "/v3/attachments",
      );
      const note = await store.getNote("v3");
      const meta = note!.metadata as any;
      expect(meta?.summary).toBe("keep me");
      expect(meta?.transcribe_stub).toBe(true);
    });
  });

  describe("DELETE /notes/:id/attachments/:attId", async () => {
    test("happy path: 204, DB row gone, storage file unlinked", async () => {
      const assetsRoot = join(tmpDir, "assets");
      mkdirSync(join(assetsRoot, "2026-04-18"), { recursive: true });
      const relPath = "2026-04-18/shot.png";
      const filePath = join(assetsRoot, relPath);
      writeFileSync(filePath, Buffer.from([1, 2, 3]));
      process.env.ASSETS_DIR = assetsRoot;

      const n = await store.createNote("x", { id: "n1" });
      const att = await store.addAttachment(n.id, relPath, "image/png");

      const res = await handleNotes(
        mkReq("DELETE", `/notes/n1/attachments/${att.id}`),
        store,
        `/n1/attachments/${att.id}`,
        "default",
      );
      expect(res.status).toBe(204);
      expect((await store.getAttachments(n.id)).length).toBe(0);
      expect(existsSync(filePath)).toBe(false);

      delete process.env.ASSETS_DIR;
    });

    test("404 when attachment does not exist", async () => {
      await store.createNote("x", { id: "n2" });
      const res = await handleNotes(
        mkReq("DELETE", "/notes/n2/attachments/nonexistent"),
        store,
        "/n2/attachments/nonexistent",
        "default",
      );
      expect(res.status).toBe(404);
    });

    test("second delete is idempotent (404)", async () => {
      const n = await store.createNote("x", { id: "n3" });
      const att = await store.addAttachment(n.id, "files/a.png", "image/png");
      const first = await handleNotes(
        mkReq("DELETE", `/notes/n3/attachments/${att.id}`),
        store,
        `/n3/attachments/${att.id}`,
      );
      expect(first.status).toBe(204);
      const second = await handleNotes(
        mkReq("DELETE", `/notes/n3/attachments/${att.id}`),
        store,
        `/n3/attachments/${att.id}`,
      );
      expect(second.status).toBe(404);
    });

    test("cross-note delete attempt returns 404 and leaves record intact", async () => {
      const a = await store.createNote("a", { id: "na" });
      const b = await store.createNote("b", { id: "nb" });
      const attA = await store.addAttachment(a.id, "files/a.png", "image/png");

      const res = await handleNotes(
        mkReq("DELETE", `/notes/nb/attachments/${attA.id}`),
        store,
        `/nb/attachments/${attA.id}`,
      );
      expect(res.status).toBe(404);
      expect((await store.getAttachments(a.id)).length).toBe(1);
    });

    test("file survives first delete when a sibling attachment still references it", async () => {
      const assetsRoot = join(tmpDir, "assets");
      mkdirSync(join(assetsRoot, "shared"), { recursive: true });
      const relPath = "shared/pic.png";
      const filePath = join(assetsRoot, relPath);
      writeFileSync(filePath, Buffer.from([9]));
      process.env.ASSETS_DIR = assetsRoot;

      const a = await store.createNote("a", { id: "sa" });
      const b = await store.createNote("b", { id: "sb" });
      const attA = await store.addAttachment(a.id, relPath, "image/png");
      const attB = await store.addAttachment(b.id, relPath, "image/png");

      await handleNotes(
        mkReq("DELETE", `/notes/sa/attachments/${attA.id}`),
        store,
        `/sa/attachments/${attA.id}`,
        "default",
      );
      expect(existsSync(filePath)).toBe(true);

      await handleNotes(
        mkReq("DELETE", `/notes/sb/attachments/${attB.id}`),
        store,
        `/sb/attachments/${attB.id}`,
        "default",
      );
      expect(existsSync(filePath)).toBe(false);

      delete process.env.ASSETS_DIR;
    });

    test("method not allowed on /attachments/:attId returns 405", async () => {
      const n = await store.createNote("x", { id: "nm" });
      const att = await store.addAttachment(n.id, "files/a.png", "image/png");
      const res = await handleNotes(
        mkReq("PATCH", `/notes/nm/attachments/${att.id}`),
        store,
        `/nm/attachments/${att.id}`,
      );
      expect(res.status).toBe(405);
    });
  });

  // -------------------------------------------------------------------------
  // Empty content is a valid state (vault#323)
  // -------------------------------------------------------------------------
  // Skeleton notes, drafts, organizing-only notes, and capture-then-fill
  // flows all legitimately produce empty-content rows. The earlier #213
  // guard rejected `content + path both absent` — we no longer enforce
  // it because real vaults carry such rows and the round-trip import
  // has to accept them.

  describe("empty content is valid (vault#323)", async () => {
    test("POST bare {} body → 201", async () => {
      const res = await handleNotes(mkReq("POST", "/notes", {}), store, "");
      expect(res.status).toBe(201);
    });

    test("POST batch with mixed empty + content entries → 201, all created", async () => {
      const beforeCount = (await store.queryNotes({ path: "ok-1" })).length;
      const res = await handleNotes(
        mkReq("POST", "/notes", { notes: [{ path: "ok-1" }, {}, { content: "third" }] }),
        store,
        "",
      );
      expect(res.status).toBe(201);
      const afterCount = (await store.queryNotes({ path: "ok-1" })).length;
      expect(afterCount).toBe(beforeCount + 1);
    });

    test("POST single content-only (path absent) → 201", async () => {
      const res = await handleNotes(
        mkReq("POST", "/notes", { content: "un-pathed jot" }),
        store,
        "",
      );
      expect(res.status).toBe(201);
    });

    test("POST single path-only (content absent) → 201", async () => {
      const res = await handleNotes(
        mkReq("POST", "/notes", { path: "wiki/placeholder" }),
        store,
        "",
      );
      expect(res.status).toBe(201);
    });

    test("PATCH that clears both content and path → 200", async () => {
      await store.createNote("starts with content", { id: "ep1" });
      const updated = await store.getNote("ep1");
      const res = await handleNotes(
        mkReq("PATCH", "/notes/ep1", {
          content: "",
          path: "",
          if_updated_at: updated!.updatedAt,
        }),
        store,
        "/ep1",
      );
      expect(res.status).toBe(200);
    });

    test("PATCH that clears content but preserves path → 200", async () => {
      await store.createNote("body", { id: "ep2", path: "p2" });
      const updated = await store.getNote("ep2");
      const res = await handleNotes(
        mkReq("PATCH", "/notes/ep2", {
          content: "",
          if_updated_at: updated!.updatedAt,
        }),
        store,
        "/ep2",
      );
      expect(res.status).toBe(200);
    });
  });

  describe("batch atomicity (#236)", async () => {
    test("POST batch where mid-item triggers PATH_CONFLICT → 409, NOTHING created", async () => {
      // A path-conflict only surfaces on the actual INSERT, mid-loop. Without
      // the BEGIN/COMMIT wrap the prefix would have already landed by then.
      await store.createNote("existing", { path: "taken" });
      const beforeIds = (await store.queryNotes({})).map((n) => n.id).sort();

      const res = await handleNotes(
        mkReq("POST", "/notes", {
          notes: [
            { content: "ok-1", path: "fresh-1" },
            { content: "ok-2", path: "fresh-2" },
            { content: "boom", path: "taken" },
            { content: "ok-3", path: "fresh-3" },
          ],
        }),
        store,
        "",
      );
      expect(res.status).toBe(409);
      const body = await res.json() as any;
      expect(body.error_type).toBe("path_conflict");

      // The two prefix items must NOT have been created — atomic rollback.
      const afterIds = (await store.queryNotes({})).map((n) => n.id).sort();
      expect(afterIds).toEqual(beforeIds);
      expect(await store.queryNotes({ path: "fresh-1" })).toHaveLength(0);
      expect(await store.queryNotes({ path: "fresh-2" })).toHaveLength(0);
    });
  });

  describe("batch cap (#213)", async () => {
    test("POST with 501-item batch → 413 BatchTooLarge", async () => {
      const oversized = Array.from({ length: 501 }, (_, i) => ({ content: `n${i}` }));
      const res = await handleNotes(
        mkReq("POST", "/notes", { notes: oversized }),
        store,
        "",
      );
      expect(res.status).toBe(413);
      const body = await res.json() as any;
      expect(body.error_type).toBe("batch_too_large");
      expect(body.error).toBe("BatchTooLarge");
      expect(body.limit).toBe(500);
    });

    test("POST with exactly 500-item batch → 201 (boundary)", async () => {
      const exactly500 = Array.from({ length: 500 }, (_, i) => ({ content: `n${i}` }));
      const res = await handleNotes(
        mkReq("POST", "/notes", { notes: exactly500 }),
        store,
        "",
      );
      expect(res.status).toBe(201);
      const body = await res.json() as any[];
      expect(body).toHaveLength(500);
    });
  });

  // ---- Bracket-style metadata filter (vault#285 friction point 1.3) ----
  //
  // Exposes vault's engine-level metadata-value filtering to HTTP REST
  // callers (today: only MCP). Uses `meta[field][op]=value` (Stripe /
  // JSON:API / Strapi convention). The HTTP layer translates to the engine's
  // existing `metadata` filter; engine semantics + gates are unchanged.
  // Bridges `created_at` / `updated_at` through `dateFilter`.
  describe("bracket-style metadata filter", () => {
    async function declareIndexed() {
      const { declareField } = await import("../core/src/indexed-fields.ts");
      declareField(db, "priority", "INTEGER", "project");
      declareField(db, "status", "TEXT", "project");
    }

    test("shorthand `?meta[field]=value` does exact equality (JSON scan, no indexed gate)", async () => {
      // Deliberately NOT calling declareIndexed — shorthand should work on
      // any field via the json_extract fallback at core/src/notes.ts:504-507.
      await store.createNote("matches", { metadata: { kind: "draft" } });
      await store.createNote("other", { metadata: { kind: "final" } });
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[kind]=draft&include_content=true"),
        store,
        "",
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any[];
      expect(body.map((n) => n.content)).toEqual(["matches"]);
    });

    test("eq operator on indexed field", async () => {
      await declareIndexed();
      await store.createNote("p5", { metadata: { priority: 5 } });
      await store.createNote("p1", { metadata: { priority: 1 } });
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[priority][eq]=5&include_content=true"),
        store,
        "",
      );
      const body = await res.json() as any[];
      expect(body.map((n) => n.content)).toEqual(["p5"]);
    });

    test("ne operator returns non-matching rows plus rows without the field", async () => {
      await declareIndexed();
      await store.createNote("has-1", { metadata: { priority: 1 } });
      await store.createNote("has-2", { metadata: { priority: 2 } });
      await store.createNote("missing");
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[priority][ne]=1&include_content=true"),
        store,
        "",
      );
      const body = await res.json() as any[];
      expect(body.map((n) => n.content).sort()).toEqual(["has-2", "missing"]);
    });

    test("gt / gte / lt / lte compose into a range query on one field", async () => {
      await declareIndexed();
      for (const p of [1, 2, 3, 4, 5]) {
        await store.createNote(`p${p}`, { metadata: { priority: p } });
      }
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[priority][gte]=2&meta[priority][lt]=5&include_content=true"),
        store,
        "",
      );
      const body = await res.json() as any[];
      expect(body.map((n) => n.content).sort()).toEqual(["p2", "p3", "p4"]);
    });

    test("in array form: `?meta[field][in][]=v1&meta[field][in][]=v2`", async () => {
      await declareIndexed();
      await store.createNote("a", { metadata: { status: "active" } });
      await store.createNote("b", { metadata: { status: "exploring" } });
      await store.createNote("c", { metadata: { status: "done" } });
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[status][in][]=active&meta[status][in][]=exploring&include_content=true"),
        store,
        "",
      );
      const body = await res.json() as any[];
      expect(body.map((n) => n.content).sort()).toEqual(["a", "b"]);
    });

    test("in comma form: `?meta[field][in]=v1,v2`", async () => {
      await declareIndexed();
      await store.createNote("a", { metadata: { status: "active" } });
      await store.createNote("b", { metadata: { status: "exploring" } });
      await store.createNote("c", { metadata: { status: "done" } });
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[status][in]=active,exploring&include_content=true"),
        store,
        "",
      );
      const body = await res.json() as any[];
      expect(body.map((n) => n.content).sort()).toEqual(["a", "b"]);
    });

    test("not_in via comma form", async () => {
      await declareIndexed();
      await store.createNote("a", { metadata: { status: "active" } });
      await store.createNote("b", { metadata: { status: "done" } });
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[status][not_in]=done&include_content=true"),
        store,
        "",
      );
      const body = await res.json() as any[];
      expect(body.map((n) => n.content)).toEqual(["a"]);
    });

    test("exists: true / false distinguishes present vs absent field", async () => {
      await declareIndexed();
      await store.createNote("has", { metadata: { priority: 3 } });
      await store.createNote("missing");

      const hasRes = await handleNotes(
        mkReq("GET", "/notes?meta[priority][exists]=true&include_content=true"),
        store,
        "",
      );
      const hasBody = await hasRes.json() as any[];
      expect(hasBody.map((n) => n.content)).toEqual(["has"]);

      const missingRes = await handleNotes(
        mkReq("GET", "/notes?meta[priority][exists]=false&include_content=true"),
        store,
        "",
      );
      const missingBody = await missingRes.json() as any[];
      expect(missingBody.map((n) => n.content)).toEqual(["missing"]);
    });

    test("exists with non-boolean value rejects with INVALID_OPERATOR_VALUE", async () => {
      await declareIndexed();
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[priority][exists]=yes"),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("INVALID_OPERATOR_VALUE");
    });

    test("compound filter across two fields ANDs together", async () => {
      await declareIndexed();
      await store.createNote("hit", { metadata: { priority: 5, status: "active" } });
      await store.createNote("priority-only", { metadata: { priority: 5, status: "done" } });
      await store.createNote("status-only", { metadata: { priority: 1, status: "active" } });
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[priority][gte]=4&meta[status][eq]=active&include_content=true"),
        store,
        "",
      );
      const body = await res.json() as any[];
      expect(body.map((n) => n.content)).toEqual(["hit"]);
    });

    test("operator query on a non-indexed field returns 400 with FIELD_NOT_INDEXED", async () => {
      // Don't declare the field — the engine's indexed-field gate should fire.
      await store.createNote("x", { metadata: { mood: "great" } });
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[mood][eq]=great"),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("FIELD_NOT_INDEXED");
    });

    test("unknown operator returns 400 with UNKNOWN_OPERATOR", async () => {
      await declareIndexed();
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[priority][bogus]=5"),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("UNKNOWN_OPERATOR");
    });

    // ---- Bridge: created_at / updated_at via brackets route to dateFilter ----
    test("`meta[created_at][gte]=…` routes to dateFilter (same result as flat date_field)", async () => {
      await store.createNote("old", { created_at: "2026-01-15T00:00:00.000Z" });
      await store.createNote("new", { created_at: "2026-04-15T00:00:00.000Z" });

      const bracketRes = await handleNotes(
        mkReq("GET", "/notes?meta[created_at][gte]=2026-04-01&include_content=true"),
        store,
        "",
      );
      const bracketBody = await bracketRes.json() as any[];
      const flatRes = await handleNotes(
        mkReq("GET", "/notes?date_field=created_at&date_from=2026-04-01&include_content=true"),
        store,
        "",
      );
      const flatBody = await flatRes.json() as any[];
      expect(bracketBody.map((n) => n.content)).toEqual(["new"]);
      expect(bracketBody.map((n) => n.content)).toEqual(flatBody.map((n) => n.content));
    });

    test("`meta[updated_at][gte]=…` routes to dateFilter on n.updated_at", async () => {
      const a = await store.createNote("untouched");
      const b = await store.createNote("modified");
      db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
        .run("2026-01-15T00:00:00.000Z", a.id);
      db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
        .run("2026-04-25T00:00:00.000Z", b.id);
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[updated_at][gte]=2026-04-01&include_content=true"),
        store,
        "",
      );
      const body = await res.json() as any[];
      expect(body.map((n) => n.content)).toEqual(["modified"]);
    });

    test("`meta[created_at][lt]=…` maps to dateFilter's exclusive upper bound", async () => {
      await store.createNote("inside", { created_at: "2026-04-15T00:00:00.000Z" });
      await store.createNote("on-boundary", { created_at: "2026-05-01T00:00:00.000Z" });
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[created_at][lt]=2026-05-01&include_content=true"),
        store,
        "",
      );
      const body = await res.json() as any[];
      // "on-boundary" excluded because `< to` is half-open by design.
      expect(body.map((n) => n.content)).toEqual(["inside"]);
    });

    test("unsupported date-column operator (e.g. gt) rejects with a guiding error", async () => {
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[created_at][gt]=2026-01-01"),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("INVALID_QUERY");
      // Error must call out the supported ops so callers can self-correct.
      expect(body.error).toContain("gte");
      expect(body.error).toContain("lt");
    });

    test("`meta[created_at]=…` (shorthand, no operator) rejects with a guiding error", async () => {
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[created_at]=2026-01-01"),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("INVALID_QUERY");
      expect(body.error).toContain("operator");
    });

    // ---- Mutually-exclusive shapes that would silently corrupt input ----

    test("bracket-date filter spanning created_at AND updated_at in one request rejects (vault#289 F1)", async () => {
      // Before this guard, the parser flattened both columns onto a single
      // `dateBucket.field`, so the second column silently won and the first
      // column's bound was applied against the wrong column.
      const res = await handleNotes(
        mkReq(
          "GET",
          "/notes?meta[created_at][gte]=2026-04-01&meta[updated_at][lt]=2026-06-01",
        ),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("INVALID_QUERY");
      expect(body.error).toContain("cannot span");
      expect(body.error).toContain("created_at");
      expect(body.error).toContain("updated_at");
    });

    test("two bracket-date params on the same column compose into a range (regression)", async () => {
      // The F1 guard must reject *different* columns only — same-column
      // gte+lt is the canonical range case and must keep working.
      await store.createNote("in-window", { created_at: "2026-04-15T00:00:00.000Z" });
      await store.createNote("after-window", { created_at: "2026-05-15T00:00:00.000Z" });
      await store.createNote("before-window", { created_at: "2026-03-15T00:00:00.000Z" });
      const res = await handleNotes(
        mkReq(
          "GET",
          "/notes?meta[created_at][gte]=2026-04-01&meta[created_at][lt]=2026-05-01&include_content=true",
        ),
        store,
        "",
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any[];
      expect(body.map((n) => n.content)).toEqual(["in-window"]);
    });

    test("shorthand-then-operator on the same field rejects (vault#289 F2)", async () => {
      // `URLSearchParams` iteration is insertion-order. Before this guard,
      // shorthand wrote `metadata[field] = primitive`, then the operator
      // handler called `metaOpBucket` which overwrote it with a fresh op
      // object — the shorthand was silently dropped.
      await declareIndexed();
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[priority]=5&meta[priority][gte]=3"),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("INVALID_QUERY");
      expect(body.error).toContain("mix shorthand and operator");
    });

    test("operator-then-shorthand on the same field rejects (vault#289 F2, reverse order)", async () => {
      // Reverse insertion order. Before this guard, the operator was set
      // first, then the shorthand wrote `metadata[field] = primitive` and
      // clobbered the op bucket — operator silently dropped.
      await declareIndexed();
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[priority][gte]=3&meta[priority]=5"),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("INVALID_QUERY");
      expect(body.error).toContain("mix shorthand and operator");
    });

    test("`[]` array form on a non-array operator rejects at the parser layer (vault#289 F4)", async () => {
      // `meta[field][eq][]=value` is a shape error — `eq` takes a scalar.
      // The engine would also catch this (the value would be an array
      // SQLite can't bind), but the parser-level error names the issue
      // more precisely: "use single-value form for `eq`."
      const res = await handleNotes(
        mkReq("GET", "/notes?meta[priority][eq][]=5"),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("INVALID_OPERATOR_VALUE");
      expect(body.error).toContain("array form");
      expect(body.error).toContain("in");
      expect(body.error).toContain("not_in");
    });

    // ---- Precedence on overlap ----
    test("when both flat and bracket date params overlap, bracket wins", async () => {
      await store.createNote("old", { created_at: "2026-01-15T00:00:00.000Z" });
      await store.createNote("new", { created_at: "2026-04-15T00:00:00.000Z" });
      // Bracket says "from 2026-04-01"; flat says "from 2020-01-01". If
      // flat won, both notes would match. The bracket-wins precedence is
      // verified by getting back only the post-April note.
      const res = await handleNotes(
        mkReq(
          "GET",
          "/notes?meta[created_at][gte]=2026-04-01&date_field=created_at&date_from=2020-01-01&include_content=true",
        ),
        store,
        "",
      );
      const body = await res.json() as any[];
      expect(body.map((n) => n.content)).toEqual(["new"]);
    });
  });
});

describe("HTTP GET /notes?format=graph", async () => {
  test("returns nodes and edges for linked notes", async () => {
    const a = await store.createNote("A", { id: "a", path: "People/Alice", tags: ["person"] });
    const b = await store.createNote("B", { id: "b", path: "People/Bob", tags: ["person"] });
    const c = await store.createNote("C", { id: "c", path: "Projects/X" });
    await store.createLink("a", "b", "knows");
    await store.createLink("a", "c", "works-on");

    const res = await handleNotes(
      mkReq("GET", "/notes?format=graph&include_links=true"),
      store,
      "",
    );
    const body = await res.json() as any;
    expect(body.nodes).toHaveLength(3);
    expect(body.edges).toHaveLength(2);
    // Nodes have id, path, tags
    const alice = body.nodes.find((n: any) => n.id === "a");
    expect(alice.path).toBe("People/Alice");
    expect(alice.tags).toEqual(["person"]);
    // Edges have source, target, relationship
    expect(body.edges).toContainEqual({ source: "a", target: "b", relationship: "knows" });
    expect(body.edges).toContainEqual({ source: "a", target: "c", relationship: "works-on" });
  });

  test("returns empty edges when include_links is not set", async () => {
    await store.createNote("A", { id: "a" });
    await store.createNote("B", { id: "b" });
    await store.createLink("a", "b", "ref");

    const res = await handleNotes(
      mkReq("GET", "/notes?format=graph"),
      store,
      "",
    );
    const body = await res.json() as any;
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(0);
  });

  test("composes with near param for subgraph", async () => {
    const a = await store.createNote("A", { id: "a", path: "People/Mickey" });
    const b = await store.createNote("B", { id: "b" });
    const c = await store.createNote("C", { id: "c" });
    const d = await store.createNote("D", { id: "d" }); // not connected
    await store.createLink("a", "b", "knows");
    await store.createLink("b", "c", "knows");

    const res = await handleNotes(
      mkReq("GET", "/notes?format=graph&include_links=true&near[note_id]=People/Mickey&near[depth]=2"),
      store,
      "",
    );
    const body = await res.json() as any;
    // a, b, c are within 2 hops; d is not
    expect(body.nodes).toHaveLength(3);
    expect(body.nodes.map((n: any) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(body.edges).toHaveLength(2);
  });

  test("near with depth=1 limits subgraph", async () => {
    const a = await store.createNote("A", { id: "a" });
    const b = await store.createNote("B", { id: "b" });
    const c = await store.createNote("C", { id: "c" });
    await store.createLink("a", "b", "ref");
    await store.createLink("b", "c", "ref");

    const res = await handleNotes(
      mkReq("GET", "/notes?format=graph&include_links=true&near[note_id]=a&near[depth]=1"),
      store,
      "",
    );
    const body = await res.json() as any;
    // Only a and b within 1 hop
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0]).toEqual({ source: "a", target: "b", relationship: "ref" });
  });
});

describe("HTTP PATCH /notes/:idOrPath (update)", async () => {
  test("PATCH updates content and merges metadata", async () => {
    const note = await store.createNote("original", { id: "x", metadata: { a: 1 } });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { content: "updated", metadata: { b: 2 }, force: true }),
      store,
      "/x",
    );
    const body = await res.json() as any;
    expect(body.content).toBe("updated");
    expect(body.metadata).toEqual({ a: 1, b: 2 });
  });

  test("PATCH adds/removes tags", async () => {
    await store.createNote("x", { id: "x", tags: ["old"] });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { tags: { add: ["new"], remove: ["old"] }, force: true }),
      store,
      "/x",
    );
    const body = await res.json() as any;
    expect(body.tags).toContain("new");
    expect(body.tags).not.toContain("old");
  });

  test("PATCH adds/removes links", async () => {
    await store.createNote("a", { id: "a" });
    await store.createNote("b", { id: "b" });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/a", { links: { add: [{ target: "b", relationship: "mentions" }] }, force: true }),
      store,
      "/a",
    );
    expect(res.status).toBe(200);
    const links = await store.getLinks("a", { direction: "outbound" });
    expect(links).toHaveLength(1);

    // Remove
    await handleNotes(
      mkReq("PATCH", "/notes/a", { links: { remove: [{ target: "b", relationship: "mentions" }] }, force: true }),
      store,
      "/a",
    );
    expect(await store.getLinks("a", { direction: "outbound" })).toHaveLength(0);
  });

  test("PATCH resolves note by path", async () => {
    await store.createNote("x", { path: "Projects/README" });
    const res = await handleNotes(
      mkReq("PATCH", `/notes/${encodeURIComponent("Projects/README")}`, { content: "updated", force: true }),
      store,
      `/${encodeURIComponent("Projects/README")}`,
    );
    const body = await res.json() as any;
    expect(body.content).toBe("updated");
  });

  test("PATCH with matching if_updated_at succeeds", async () => {
    const note = await store.createNote("first", { id: "x" });
    // First bump — sets updated_at
    const first = await handleNotes(
      mkReq("PATCH", "/notes/x", { content: "second", force: true }),
      store,
      "/x",
    );
    const firstBody = await first.json() as any;
    expect(firstBody.updatedAt).toBeTruthy();

    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { content: "third", if_updated_at: firstBody.updatedAt }),
      store,
      "/x",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.content).toBe("third");
  });

  test("PATCH with stale if_updated_at returns 409 and does not modify note", async () => {
    await store.createNote("first", { id: "x", path: "Inbox/x" });
    await handleNotes(mkReq("PATCH", "/notes/x", { content: "second", force: true }), store, "/x");
    const current = await store.getNote("x");

    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", {
        content: "third",
        if_updated_at: "2020-01-01T00:00:00.000Z",
      }),
      store,
      "/x",
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    // New structured shape
    expect(body.error_type).toBe("conflict");
    expect(body.path).toBe("Inbox/x");
    expect(body.your_updated_at).toBe("2020-01-01T00:00:00.000Z");
    // Legacy fields retained for compat
    expect(body.error).toBe("conflict");
    expect(body.note_id).toBe("x");
    expect(body.current_updated_at).toBe(current!.updatedAt);
    expect(body.expected_updated_at).toBe("2020-01-01T00:00:00.000Z");

    // Unchanged
    expect((await store.getNote("x"))!.content).toBe("second");
  });

  test("PATCH without if_updated_at or force returns 428 and does not modify note", async () => {
    await store.createNote("first", { id: "x", path: "Inbox/x" });

    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { content: "second" }),
      store,
      "/x",
    );
    expect(res.status).toBe(428);
    const body = await res.json() as any;
    expect(body.error_type).toBe("precondition_required");
    expect(body.note_id).toBe("x");
    expect(body.path).toBe("Inbox/x");

    // Unchanged
    expect((await store.getNote("x"))!.content).toBe("first");
  });

  test("PATCH append without precondition succeeds (no-conflict-by-design)", async () => {
    await store.createNote("seed:", { id: "x" });

    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { append: " A" }),
      store,
      "/x",
    );
    expect(res.status).toBe(200);
    expect((await store.getNote("x"))!.content).toBe("seed: A");
  });

  test("PATCH append + tags without precondition is rejected (#201)", async () => {
    // The append-only exemption is justified by SQL-atomic concat. Tag
    // mutations don't share that property — they're idempotent, but the
    // caller should still observe the prior state before re-asserting.
    await store.createNote("seed:", { id: "x", path: "Inbox/x" });

    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { append: " A", tags: { add: ["important"] } }),
      store,
      "/x",
    );
    expect(res.status).toBe(428);
    const body = await res.json() as any;
    expect(body.error_type).toBe("precondition_required");
    // Unchanged on rejection.
    expect((await store.getNote("x"))!.content).toBe("seed:");
  });

  test("PATCH content_edit replaces a single occurrence", async () => {
    const note = await store.createNote("hello world", { id: "x" });

    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", {
        content_edit: { old_text: "hello", new_text: "hi" },
        if_updated_at: note.updatedAt,
      }),
      store,
      "/x",
    );
    expect(res.status).toBe(200);
    expect((await store.getNote("x"))!.content).toBe("hi world");
  });

  test("PATCH content_edit returns 422 when old_text is not found (#202)", async () => {
    // 404 misleadingly read as "note doesn't exist"; 422 says "request is
    // valid, but old_text doesn't apply to the current content."
    const note = await store.createNote("hello world", { id: "x" });

    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", {
        content_edit: { old_text: "missing", new_text: "x" },
        if_updated_at: note.updatedAt,
      }),
      store,
      "/x",
    );
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toBe("unprocessable_content");
    expect((await store.getNote("x"))!.content).toBe("hello world");
  });

  test("PATCH content_edit returns 409 on multiple matches", async () => {
    const note = await store.createNote("hi hi", { id: "x" });

    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", {
        content_edit: { old_text: "hi", new_text: "hello" },
        if_updated_at: note.updatedAt,
      }),
      store,
      "/x",
    );
    expect(res.status).toBe(409);
    expect((await store.getNote("x"))!.content).toBe("hi hi");
  });

  test("PATCH rejects content + append combination with 400", async () => {
    await store.createNote("seed", { id: "x" });

    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { content: "new", append: "more", force: true }),
      store,
      "/x",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("mutually_exclusive");
  });

  test("DELETE resolves note by path", async () => {
    await store.createNote("x", { path: "Temp/note" });
    const res = await handleNotes(
      mkReq("DELETE", `/notes/${encodeURIComponent("Temp/note")}`),
      store,
      `/${encodeURIComponent("Temp/note")}`,
    );
    const body = await res.json() as any;
    expect(body.deleted).toBe(true);
    expect(await store.getNoteByPath("Temp/note")).toBeNull();
  });

  test("POST /notes returns 409 path_conflict when path already exists (#126)", async () => {
    await store.createNote("first", { path: "Inbox/note" });
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "second", path: "Inbox/note" }),
      store,
      "",
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error_type).toBe("path_conflict");
    expect(body.error).toBe("path_conflict");
    expect(body.path).toBe("Inbox/note");
  });

  test("POST /notes path_conflict — second note never lands in DB (#126)", async () => {
    await store.createNote("first", { path: "Inbox/note" });
    const before = (await store.queryNotes({})).length;
    await handleNotes(
      mkReq("POST", "/notes", { content: "second", path: "Inbox/note" }),
      store,
      "",
    );
    expect((await store.queryNotes({})).length).toBe(before);
  });

  test("PATCH /notes returns 409 path_conflict when renaming onto existing path (#126)", async () => {
    const a = await store.createNote("first", { id: "a", path: "alpha" });
    await store.createNote("second", { id: "b", path: "beta" });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/a", { path: "beta", if_updated_at: a.createdAt }),
      store,
      "/a",
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error_type).toBe("path_conflict");
    expect(body.path).toBe("beta");
    // Source note unchanged
    expect((await store.getNote("a"))!.path).toBe("alpha");
  });

  // ---- include_content response-shape opt-out (vault#285 friction point 2.response) ----
  test("PATCH defaults to returning the full Note (back-compat)", async () => {
    await store.createNote("body", { id: "x" });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { content: "updated", force: true }),
      store,
      "/x",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.content).toBe("updated");
    expect(body.byteSize).toBeUndefined();
    expect(body.preview).toBeUndefined();
  });

  test("PATCH with include_content: false returns the lean NoteIndex shape", async () => {
    const longBody = "x".repeat(2_000);
    await store.createNote(longBody, { id: "big", path: "big" });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/big", { append: " edit", include_content: false }),
      store,
      "/big",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.content).toBeUndefined();
    expect(typeof body.byteSize).toBe("number");
    expect(body.byteSize).toBe(2_000 + 5);
    expect(typeof body.preview).toBe("string");
    expect(body.id).toBe("big");
    expect(body.path).toBe("big");
  });

  // vault#287 — HTTP must match MCP on validation_status attachment.
  // Pre-#287 fix: MCP `update-note` attached validation_status; HTTP
  // PATCH didn't. HTTP consumers using schema-validated vaults had no
  // way to see schema warnings without re-reading + replaying validation
  // client-side. These tests pin the symmetry on both response shapes
  // (`include_content: true` and `false`) and confirm the no-schema
  // case still returns no validation_status (advisory only — never
  // forced onto vaults that don't declare fields).

  test("PATCH attaches validation_status with enum_mismatch warning when tag schema is violated", async () => {
    await store.upsertTagSchema("task287patch", {
      fields: { priority: { type: "string", enum: ["high", "low"] } },
    });
    const note = await store.createNote("body", {
      id: "p287a",
      tags: ["task287patch"],
      metadata: { priority: "high" },
    });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/p287a", {
        metadata: { priority: "ULTRA" },
        if_updated_at: note.updatedAt,
      }),
      store,
      "/p287a",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // The write still lands — validation is advisory.
    expect(body.metadata.priority).toBe("ULTRA");
    // …but the response carries the warning so the HTTP caller knows.
    expect(body.validation_status).toBeTruthy();
    expect(body.validation_status.schemas).toContain("task287patch");
    expect(body.validation_status.warnings.length).toBeGreaterThan(0);
    expect(body.validation_status.warnings[0].reason).toBe("enum_mismatch");
    expect(body.validation_status.warnings[0].field).toBe("priority");
  });

  test("PATCH preserves validation_status on the lean (include_content: false) response", async () => {
    await store.upsertTagSchema("task287lean", {
      fields: { priority: { type: "string", enum: ["high", "low"] } },
    });
    const note = await store.createNote("body", {
      id: "p287b",
      tags: ["task287lean"],
      metadata: { priority: "high" },
    });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/p287b", {
        metadata: { priority: "ULTRA" },
        include_content: false,
        if_updated_at: note.updatedAt,
      }),
      store,
      "/p287b",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Lean shape: no `content`, has `byteSize` + `preview`.
    expect(body.content).toBeUndefined();
    expect(typeof body.byteSize).toBe("number");
    // …and validation_status survives the lean conversion.
    expect(body.validation_status).toBeTruthy();
    expect(body.validation_status.warnings[0].reason).toBe("enum_mismatch");
  });

  test("PATCH omits validation_status when no tag on the note declares fields", async () => {
    // No tag schemas configured for this note — the response should look
    // exactly like the pre-#287 shape (no validation_status). The behavior-
    // unchanged guarantee for callers that don't use tag schemas.
    await store.createNote("body", { id: "p287c", tags: ["plain"] });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/p287c", { content: "updated", force: true }),
      store,
      "/p287c",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.content).toBe("updated");
    expect(body.validation_status).toBeUndefined();
  });
});

describe("HTTP POST /notes — validation_status attachment (vault#287)", async () => {
  // Mirror of the PATCH cases for create. The MCP create-note path
  // attaches validation_status; HTTP POST must match (vault#287).

  test("POST attaches validation_status with type_mismatch warning", async () => {
    await store.upsertTagSchema("task287post", {
      fields: { done: { type: "boolean" } },
    });
    const res = await handleNotes(
      mkReq("POST", "/notes", {
        content: "x",
        tags: ["task287post"],
        metadata: { done: "yes" }, // wrong type
      }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBeTruthy();
    expect(body.validation_status).toBeTruthy();
    expect(body.validation_status.warnings[0].reason).toBe("type_mismatch");
    expect(body.validation_status.warnings[0].field).toBe("done");
  });

  test("POST batch attaches validation_status per-note", async () => {
    await store.upsertTagSchema("task287batch", {
      fields: { priority: { type: "string", enum: ["high", "low"] } },
    });
    const res = await handleNotes(
      mkReq("POST", "/notes", {
        notes: [
          { content: "good", tags: ["task287batch"], metadata: { priority: "high" } },
          { content: "bad", tags: ["task287batch"], metadata: { priority: "ULTRA" } },
        ],
      }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any[];
    expect(body).toHaveLength(2);
    expect(body[0].validation_status.warnings).toEqual([]);
    expect(body[1].validation_status.warnings[0].reason).toBe("enum_mismatch");
  });

  test("POST omits validation_status when no tag declares fields (back-compat)", async () => {
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "no schema here", tags: ["plain287"] }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBeTruthy();
    expect(body.validation_status).toBeUndefined();
  });
});

// vault#309 — HTTP PATCH /notes/:id with if_missing: "create" mirrors
// the MCP update-note path. Sync loops (Gitcoin Brain et al) use this
// for idempotent upsert without a separate query-first round trip.

describe("HTTP PATCH /notes/:idOrPath if_missing=create (vault#309)", async () => {
  test("missing note + if_missing=create creates and returns created: true", async () => {
    const res = await handleNotes(
      mkReq("PATCH", `/notes/${encodeURIComponent("Inbox/m309a")}`, {
        content: "agenda body",
        tags: ["meeting309"],
        metadata: { priority: "high" },
        if_missing: "create",
      }),
      store,
      `/${encodeURIComponent("Inbox/m309a")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.created).toBe(true);
    expect(body.path).toBe("Inbox/m309a");
    expect(body.content).toBe("agenda body");
    expect(body.tags).toContain("meeting309");
    expect(body.metadata.priority).toBe("high");
    // And the row landed.
    expect(await store.getNoteByPath("Inbox/m309a")).not.toBeNull();
  });

  test("existing note + if_missing=create updates and returns created: false", async () => {
    await store.createNote("original", { path: "m309b", metadata: { v: 1 } });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/m309b", {
        content: "updated body",
        metadata: { v: 2 },
        if_missing: "create",
        force: true,
      }),
      store,
      "/m309b",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.created).toBe(false);
    expect(body.content).toBe("updated body");
    expect(body.metadata.v).toBe(2);
  });

  test("missing note without if_missing returns 404 (back-compat)", async () => {
    const res = await handleNotes(
      mkReq("PATCH", "/notes/m309c-nope", {
        content: "x",
        force: true,
      }),
      store,
      "/m309c-nope",
    );
    expect(res.status).toBe(404);
  });

  test("regular update path now also carries created: false (response shape extended)", async () => {
    await store.createNote("body", { path: "m309d" });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/m309d", {
        content: "new body",
        force: true,
      }),
      store,
      "/m309d",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.created).toBe(false);
  });

  // vault#321 F2 — REST create-on-missing branch applies links.add.
  // MCP's create branch already did; REST was missing the
  // link-creation pass entirely. Cross-surface inconsistency Gitcoin
  // would trip on if they migrated from MCP to REST. The new pass
  // mirrors MCP exactly (links.add applied, links.remove ignored,
  // missing targets skip silently).
  test("if_missing=create + links.add creates typed-link rows (vault#321 F2)", async () => {
    // Two pre-existing target notes (different ids + paths) so the
    // source can fan out to both.
    await store.createNote("target A", { id: "t-a-321", path: "Targets/A" });
    await store.createNote("target B", { id: "t-b-321", path: "Targets/B" });

    const res = await handleNotes(
      mkReq("PATCH", `/notes/${encodeURIComponent("Inbox/source-321")}`, {
        content: "source body",
        if_missing: "create",
        links: {
          add: [
            { target: "t-a-321", relationship: "derived-from" },
            { target: "Targets/B", relationship: "responds-to", metadata: { weight: 5 } },
          ],
        },
      }),
      store,
      `/${encodeURIComponent("Inbox/source-321")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.created).toBe(true);

    // Link rows exist + resolved targets correctly. We look up by the
    // source's note id (the body returned by the create branch).
    const sourceId = body.id as string;
    const outboundLinks = await store.getLinks(sourceId, { direction: "outbound" });
    const derivedFrom = outboundLinks.find((l) => l.relationship === "derived-from");
    expect(derivedFrom).toBeDefined();
    expect(derivedFrom!.targetId).toBe("t-a-321");

    const respondsTo = outboundLinks.find((l) => l.relationship === "responds-to");
    expect(respondsTo).toBeDefined();
    expect(respondsTo!.targetId).toBe("t-b-321");
    expect(respondsTo!.metadata).toEqual({ weight: 5 });
  });

  test("if_missing=create + links.add silently skips when target does not exist (vault#321 F2)", async () => {
    // Mirrors MCP: missing target → silent skip, no error. Sync loops
    // that declare links to not-yet-imported notes shouldn't abort
    // the whole upsert.
    const res = await handleNotes(
      mkReq("PATCH", `/notes/${encodeURIComponent("Inbox/source-missing-321")}`, {
        content: "x",
        if_missing: "create",
        links: { add: [{ target: "does-not-exist", relationship: "derived-from" }] },
      }),
      store,
      `/${encodeURIComponent("Inbox/source-missing-321")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.created).toBe(true);
    // The note is created. No links resolved.
    const links = await store.getLinks(body.id, { direction: "outbound" });
    expect(links.filter((l) => l.relationship === "derived-from")).toHaveLength(0);
  });

  // vault#321 F3 — schema-conflict warning on REST create branch
  // (mirror of the MCP test in core.test.ts). Same conflict-detection
  // path runs on both surfaces via attachValidationStatus, but we pin
  // both ends explicitly so a regression on either side surfaces
  // immediately.
  test("schema-conflict warning surfaces on REST create branch (vault#321 F3)", async () => {
    await store.upsertTagSchema("kpi-rest-321", {
      fields: { count: { type: "integer" } },
    });
    await store.upsertTagSchema("metric-rest-321", {
      fields: { count: { type: "string" } }, // conflicting
    });
    const res = await handleNotes(
      mkReq("PATCH", `/notes/${encodeURIComponent("Inbox/conflict-321")}`, {
        content: "x",
        if_missing: "create",
        tags: ["kpi-rest-321", "metric-rest-321"],
        metadata: { count: 5 },
      }),
      store,
      `/${encodeURIComponent("Inbox/conflict-321")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.created).toBe(true);
    const conflict = body.validation_status.warnings.find(
      (w: any) => w.reason === "schema_conflict",
    );
    expect(conflict).toBeDefined();
    expect(conflict.field).toBe("count");
    expect(conflict.schema).toBe("kpi-rest-321");
    expect(conflict.loser_schema).toBe("metric-rest-321");
  });
});

describe("HTTP /tags", async () => {
  test("GET /tags lists all tags", async () => {
    await store.createNote("A", { tags: ["daily"] });
    await store.createNote("B", { tags: ["daily", "pinned"] });
    const res = await handleTags(mkReq("GET", "/tags"), store);
    const body = await res.json() as any[];
    const daily = body.find((t: any) => t.name === "daily");
    expect(daily.count).toBe(2);
  });

  test("GET /tags?tag=name returns single tag detail with schema", async () => {
    await store.createNote("A", { tags: ["person"] });
    await store.upsertTagSchema("person", { description: "A person", fields: { name: { type: "string" } } });
    const res = await handleTags(mkReq("GET", "/tags?tag=person"), store);
    const body = await res.json() as any;
    expect(body.name).toBe("person");
    expect(body.count).toBe(1);
    expect(body.description).toBe("A person");
    expect(body.fields.name.type).toBe("string");
  });

  test("PUT /tags/:name upserts schema", async () => {
    const res = await handleTags(
      mkReq("PUT", "/tags/person", { description: "A person", fields: { name: { type: "string" } } }),
      store,
      "/person",
    );
    const body = await res.json() as any;
    expect(body.tag).toBe("person");
    expect(body.description).toBe("A person");
  });

  test("PUT /tags/:name returns 400 with error_type: invalid_relationships on bad shape", async () => {
    const res = await handleTags(
      mkReq("PUT", "/tags/person", {
        relationships: { mentions: { target_tag: "topic", cardinality: "infinite" } },
      }),
      store,
      "/person",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("invalid_relationships");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  test("DELETE /tags/:name removes tag and schema", async () => {
    await store.createNote("A", { tags: ["doomed"] });
    await store.upsertTagSchema("doomed", { description: "will be deleted" });
    const res = await handleTags(mkReq("DELETE", "/tags/doomed"), store, "/doomed");
    const body = await res.json() as any;
    expect(body.deleted).toBe(true);
    expect((await store.listTags()).some((t) => t.name === "doomed")).toBe(false);
  });

  test("POST /tags/:name/rename retags every note in one shot", async () => {
    const n1 = await store.createNote("A", { tags: ["voice"] });
    const n2 = await store.createNote("B", { tags: ["voice", "keeper"] });
    const res = await handleTags(
      mkReq("POST", "/tags/voice/rename", { new_name: "memo" }),
      store,
      "/voice/rename",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ renamed: 2, sub_tags_renamed: 0 });
    expect((await store.getNote(n1.id))!.tags).toEqual(["memo"]);
    expect((await store.getNote(n2.id))!.tags?.sort()).toEqual(["keeper", "memo"]);
  });

  test("POST /tags/:name/rename returns 409 target_exists when new_name is taken", async () => {
    await store.createNote("A", { tags: ["old"] });
    await store.createNote("B", { tags: ["new"] });
    const res = await handleTags(
      mkReq("POST", "/tags/old/rename", { new_name: "new" }),
      store,
      "/old/rename",
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe("target_exists");
    expect(body.target).toBe("new");
    // Hint at the remediation so clients don't reinvent merge client-side.
    expect(body.message).toMatch(/merge/i);
  });

  test("POST /tags/:name/rename returns 404 when source tag does not exist", async () => {
    const res = await handleTags(
      mkReq("POST", "/tags/ghost/rename", { new_name: "phantom" }),
      store,
      "/ghost/rename",
    );
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe("not_found");
  });

  test("POST /tags/:name/rename rejects empty/missing new_name with 400", async () => {
    const res = await handleTags(
      mkReq("POST", "/tags/anything/rename", { new_name: "" }),
      store,
      "/anything/rename",
    );
    expect(res.status).toBe(400);
  });

  test("POST /tags/merge combines multiple sources into target", async () => {
    await store.createNote("A", { tags: ["v1"] });
    await store.createNote("B", { tags: ["v2"] });
    await store.createNote("C", { tags: ["v1", "v2"] });

    const res = await handleTags(
      mkReq("POST", "/tags/merge", { sources: ["v1", "v2"], target: "voice" }),
      store,
      "/merge",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.target).toBe("voice");
    expect(body.merged).toEqual({ v1: 2, v2: 2 });

    const tags = await store.listTags();
    expect(tags.find((t: any) => t.name === "voice")!.count).toBe(3);
    expect(tags.some((t: any) => t.name === "v1")).toBe(false);
    expect(tags.some((t: any) => t.name === "v2")).toBe(false);
  });

  test("POST /tags/merge dedupes duplicate sources", async () => {
    await store.createNote("A", { tags: ["v1"] });
    const res = await handleTags(
      mkReq("POST", "/tags/merge", { sources: ["v1", "v1"], target: "voice" }),
      store,
      "/merge",
    );
    const body = await res.json() as any;
    expect(body.merged).toEqual({ v1: 1 });
  });

  test("POST /tags/merge creates the target tag if missing", async () => {
    await store.createNote("A", { tags: ["legacy"] });
    const res = await handleTags(
      mkReq("POST", "/tags/merge", { sources: ["legacy"], target: "fresh" }),
      store,
      "/merge",
    );
    expect(res.status).toBe(200);
    const tags = await store.listTags();
    expect(tags.find((t: any) => t.name === "fresh")!.count).toBe(1);
  });

  test("POST /tags/merge rejects bad body with 400", async () => {
    const res = await handleTags(
      mkReq("POST", "/tags/merge", { sources: "v1", target: "voice" }),
      store,
      "/merge",
    );
    expect(res.status).toBe(400);
  });

  test("POST /tags/merge rejects non-POST with 405", async () => {
    const res = await handleTags(mkReq("GET", "/tags/merge"), store, "/merge");
    expect(res.status).toBe(405);
  });
});


describe("HTTP /find-path", async () => {
  test("finds path between two notes", async () => {
    await store.createNote("a", { id: "a" });
    await store.createNote("b", { id: "b" });
    await store.createNote("c", { id: "c" });
    await store.createLink("a", "b", "mentions");
    await store.createLink("b", "c", "related-to");
    const res = await handleFindPath(mkReq("GET", "/find-path?source=a&target=c"), store);
    const body = await res.json() as any;
    expect(body.path).toEqual(["a", "b", "c"]);
    expect(body.relationships).toEqual(["mentions", "related-to"]);
  });

  test("returns null when no path exists", async () => {
    await store.createNote("a", { id: "a" });
    await store.createNote("b", { id: "b" });
    const res = await handleFindPath(mkReq("GET", "/find-path?source=a&target=b"), store);
    const body = await res.json() as any;
    expect(body).toBeNull();
  });

  test("requires source and target params", async () => {
    const res = await handleFindPath(mkReq("GET", "/find-path?source=a"), store);
    expect(res.status).toBe(400);
  });
});

describe("stateless MCP transport", async () => {
  test("tools/call works without prior initialize handshake", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `stateless-mcp-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    const vaultStore = getVaultStore(vaultName);
    await vaultStore.createNote("test note", { tags: ["daily"] });

    // Direct tools/call — no initialize, no session header
    const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "vault-info", arguments: { include_stats: true } },
      }),
    });

    const res = await handleScopedMcp(req, vaultName, {
      permission: "full",
      scopes: ["vault:read", "vault:write", "vault:admin"],
      legacyDerived: false,
      scoped_tags: null,
    });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.result).toBeDefined();
    const content = JSON.parse(body.result.content[0].text);
    expect(content.stats.totalNotes).toBe(1);

    closeAllStores();
  });

  test("tools/list works without prior initialize handshake", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `stateless-list-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    const res = await handleScopedMcp(req, vaultName, {
      permission: "full",
      scopes: ["vault:read", "vault:write", "vault:admin"],
      legacyDerived: false,
      scoped_tags: null,
    });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.result.tools).toBeDefined();
    expect(body.result.tools.length).toBeGreaterThan(0);
    const toolNames = body.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("create-note");
    expect(toolNames).toContain("vault-info");

    closeAllStores();
  });

  test("tools/list with vault:read scope only advertises read-only tools", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `scope-list-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    const res = await handleScopedMcp(req, vaultName, {
      permission: "read",
      scopes: ["vault:read"],
      legacyDerived: false,
      scoped_tags: null,
    });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const toolNames: string[] = body.result.tools.map((t: any) => t.name);
    // Read-only tools are visible
    expect(toolNames).toContain("query-notes");
    expect(toolNames).toContain("list-tags");
    expect(toolNames).toContain("find-path");
    expect(toolNames).toContain("vault-info");
    // Mutation tools are hidden — filter applied before advertising
    expect(toolNames).not.toContain("create-note");
    expect(toolNames).not.toContain("update-note");
    expect(toolNames).not.toContain("delete-note");
    expect(toolNames).not.toContain("update-tag");
    expect(toolNames).not.toContain("delete-tag");

    closeAllStores();
  });

  test("tools/call of vault-info with description arg and vault:read scope is refused", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig, readVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `scope-vault-info-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
      description: "original description",
    });

    const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "vault-info",
          arguments: { description: "hijacked description" },
        },
      }),
    });

    const res = await handleScopedMcp(req, vaultName, {
      permission: "read",
      scopes: ["vault:read"],
      legacyDerived: false,
      scoped_tags: null,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // The tool call must surface as an error (isError: true) and mention
    // the required scope — the inner guard fired even though the outer tool
    // gate allowed read-only callers through for stats.
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("vault:write");

    // And critically: the vault description must NOT have been mutated.
    const cfg = readVaultConfig(vaultName);
    expect(cfg?.description).toBe("original description");

    closeAllStores();
  });

  test("tools/call of vault-info with description arg and vault:write scope is allowed", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig, readVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `scope-vault-info-write-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
      description: "original",
    });

    const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "vault-info",
          arguments: { description: "updated via write scope" },
        },
      }),
    });

    const res = await handleScopedMcp(req, vaultName, {
      permission: "full",
      scopes: ["vault:read", "vault:write"],
      legacyDerived: false,
      scoped_tags: null,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.result.isError).toBeFalsy();
    expect(readVaultConfig(vaultName)?.description).toBe("updated via write scope");

    closeAllStores();
  });

  test("tools/call of create-note with vault:read scope is refused (not silently allowed)", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `scope-call-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create-note", arguments: { content: "nope" } },
      }),
    });

    const res = await handleScopedMcp(req, vaultName, {
      permission: "read",
      scopes: ["vault:read"],
      legacyDerived: false,
      scoped_tags: null,
    });
    expect(res.status).toBe(200); // JSON-RPC envelope is 200 even for tool errors
    const body = await res.json() as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("vault:write");

    closeAllStores();
  });

  test("initialize still works for clients that send it", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `stateless-init-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }),
    });

    const res = await handleScopedMcp(req, vaultName, {
      permission: "full",
      scopes: ["vault:read", "vault:write", "vault:admin"],
      legacyDerived: false,
      scoped_tags: null,
    });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo.name).toBe(`parachute-vault/${vaultName}`);
    expect(body.result.capabilities.tools).toBeDefined();

    closeAllStores();
  });
});

describe("extractApiKey", () => {
  test("extracts from Authorization: Bearer header", () => {
    const req = new Request("http://localhost/api/notes", {
      headers: { Authorization: "Bearer pvt_abc123" },
    });
    expect(extractApiKey(req)).toBe("pvt_abc123");
  });

  test("extracts from X-API-Key header", () => {
    const req = new Request("http://localhost/api/notes", {
      headers: { "X-API-Key": "pvk_xyz789" },
    });
    expect(extractApiKey(req)).toBe("pvk_xyz789");
  });

  test("extracts from ?key= query parameter", () => {
    const req = new Request("http://localhost/mcp?key=pvt_querykey");
    expect(extractApiKey(req)).toBe("pvt_querykey");
  });

  test("prefers Authorization header over query param", () => {
    const req = new Request("http://localhost/mcp?key=pvt_query", {
      headers: { Authorization: "Bearer pvt_header" },
    });
    expect(extractApiKey(req)).toBe("pvt_header");
  });

  test("prefers X-API-Key header over query param", () => {
    const req = new Request("http://localhost/mcp?key=pvt_query", {
      headers: { "X-API-Key": "pvk_header" },
    });
    expect(extractApiKey(req)).toBe("pvk_header");
  });

  test("prefers Authorization header over X-API-Key header", () => {
    const req = new Request("http://localhost/api/notes", {
      headers: { Authorization: "Bearer pvt_bearer", "X-API-Key": "pvk_xapi" },
    });
    expect(extractApiKey(req)).toBe("pvt_bearer");
  });

  test("returns null when no key provided", () => {
    const req = new Request("http://localhost/api/notes");
    expect(extractApiKey(req)).toBeNull();
  });
});

describe("handleVault: audio_retention", async () => {
  function mkVaultReq(method: string, body?: unknown): Request {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    return new Request(`${BASE}/vault`, init);
  }

  test("GET returns config.audio_retention defaulting to 'keep' when unset", async () => {
    const cfg = { name: "default" } as { name: string; audio_retention?: string };
    const res = await handleVault(mkReq("GET", "/vault"), store, cfg as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe("default");
    expect(body.config.audio_retention).toBe("keep");
  });

  test("GET reflects the currently stored value", async () => {
    const cfg = { name: "default", audio_retention: "until_transcribed" };
    const res = await handleVault(mkReq("GET", "/vault"), store, cfg as any);
    const body = await res.json() as any;
    expect(body.config.audio_retention).toBe("until_transcribed");
  });

  test("PATCH sets audio_retention and invokes persist", async () => {
    const cfg: { name: string; audio_retention?: string } = { name: "default" };
    let persisted = 0;
    const res = await handleVault(
      mkVaultReq("PATCH", { config: { audio_retention: "until_transcribed" } }),
      store,
      cfg as any,
      () => { persisted++; },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.config.audio_retention).toBe("until_transcribed");
    expect(cfg.audio_retention).toBe("until_transcribed");
    expect(persisted).toBe(1);
  });

  test("PATCH accepts 'never'", async () => {
    const cfg: { name: string; audio_retention?: string } = { name: "default" };
    const res = await handleVault(
      mkVaultReq("PATCH", { config: { audio_retention: "never" } }),
      store,
      cfg as any,
      () => {},
    );
    expect(res.status).toBe(200);
    expect(cfg.audio_retention).toBe("never");
  });

  test("PATCH rejects invalid modes with 400 and does not mutate", async () => {
    const cfg: { name: string; audio_retention?: string } = {
      name: "default",
      audio_retention: "keep",
    };
    let persisted = 0;
    const res = await handleVault(
      mkVaultReq("PATCH", { config: { audio_retention: "forever" } }),
      store,
      cfg as any,
      () => { persisted++; },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("invalid_audio_retention");
    expect(cfg.audio_retention).toBe("keep");
    expect(persisted).toBe(0);
  });

  test("PATCH with only description leaves audio_retention alone", async () => {
    const cfg: { name: string; description?: string; audio_retention?: string } = {
      name: "default",
      audio_retention: "until_transcribed",
    };
    const res = await handleVault(
      mkVaultReq("PATCH", { description: "new desc" }),
      store,
      cfg as any,
      () => {},
    );
    expect(res.status).toBe(200);
    expect(cfg.description).toBe("new desc");
    expect(cfg.audio_retention).toBe("until_transcribed");
  });

  test("PATCH with empty body is a no-op that still returns current state", async () => {
    const cfg: { name: string; audio_retention?: string } = {
      name: "default",
      audio_retention: "never",
    };
    let persisted = 0;
    const res = await handleVault(
      mkVaultReq("PATCH", {}),
      store,
      cfg as any,
      () => { persisted++; },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.config.audio_retention).toBe("never");
    expect(persisted).toBe(0);
  });
});

