/**
 * Tests for the multi-vault system using bun:sqlite.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync } from "fs";
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

describe("BunStore", () => {
  test("creates and retrieves a note", () => {
    const note = store.createNote("Hello world");
    expect(note.id).toBeTruthy();
    expect(note.content).toBe("Hello world");

    const fetched = store.getNote(note.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe("Hello world");
  });

  test("creates note with tags", () => {
    const note = store.createNote("Tagged note", { tags: ["daily", "pinned"] });
    expect(note.tags).toContain("daily");
    expect(note.tags).toContain("pinned");
  });

  test("creates note with path", () => {
    const note = store.createNote("Doc note", { path: "blog/first-post" });
    expect(note.path).toBe("blog/first-post");
  });

  test("updates a note", () => {
    const note = store.createNote("Original");
    const updated = store.updateNote(note.id, { content: "Updated" });
    expect(updated.content).toBe("Updated");
    expect(updated.updatedAt).toBeTruthy();
  });

  test("user updates bump updatedAt", () => {
    const note = store.createNote("Original");
    expect(note.updatedAt).toBeUndefined();
    const updated = store.updateNote(note.id, { content: "Edited by user" });
    expect(updated.updatedAt).toBeTruthy();
  });

  test("skipUpdatedAt preserves updatedAt (hook-style writes)", async () => {
    // Hook writes (e.g., the reader-audio hook's metadata markers) must not
    // count as user activity. See issue #44 — hook writes were bumping
    // updatedAt and wrecking Daily's reader sort.
    const note = store.createNote("Content");
    expect(note.updatedAt).toBeUndefined();

    // Fresh note: a machine write must not set updatedAt.
    store.updateNote(note.id, {
      metadata: { audio_pending_at: "2026-04-09T10:00:00.000Z" },
      skipUpdatedAt: true,
    });
    let fetched = store.getNote(note.id)!;
    expect(fetched.updatedAt).toBeUndefined();
    expect((fetched.metadata as { audio_pending_at?: string } | undefined)?.audio_pending_at).toBe(
      "2026-04-09T10:00:00.000Z",
    );

    // Now a real user edit bumps it.
    await new Promise((r) => setTimeout(r, 5));
    store.updateNote(note.id, { content: "User edit" });
    fetched = store.getNote(note.id)!;
    const userTs = fetched.updatedAt;
    expect(userTs).toBeTruthy();

    // A subsequent machine write must not overwrite the user's timestamp.
    await new Promise((r) => setTimeout(r, 5));
    store.updateNote(note.id, {
      metadata: {
        ...(fetched.metadata as Record<string, unknown>),
        audio_rendered_at: "2026-04-09T10:05:00.000Z",
      },
      skipUpdatedAt: true,
    });
    fetched = store.getNote(note.id)!;
    expect(fetched.updatedAt).toBe(userTs!);
    expect((fetched.metadata as { audio_rendered_at?: string } | undefined)?.audio_rendered_at).toBe(
      "2026-04-09T10:05:00.000Z",
    );
  });

  test("deletes a note", () => {
    const note = store.createNote("To delete");
    store.deleteNote(note.id);
    expect(store.getNote(note.id)).toBeNull();
  });

  test("queries notes by tag", () => {
    store.createNote("A", { tags: ["daily"] });
    store.createNote("B", { tags: ["doc"] });
    store.createNote("C", { tags: ["daily", "pinned"] });

    const daily = store.queryNotes({ tags: ["daily"] });
    expect(daily.length).toBe(2);
  });

  test("queries with exclude tags", () => {
    store.createNote("A", { tags: ["daily"] });
    store.createNote("B", { tags: ["daily", "archived"] });

    const active = store.queryNotes({ tags: ["daily"], excludeTags: ["archived"] });
    expect(active.length).toBe(1);
    expect(active[0].content).toBe("A");
  });

  test("full-text search", () => {
    store.createNote("The quick brown fox");
    store.createNote("A lazy dog");

    const results = store.searchNotes("fox");
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("fox");
  });

  test("tags and untags notes", () => {
    const note = store.createNote("Taggable");
    store.tagNote(note.id, ["important"]);
    let fetched = store.getNote(note.id)!;
    expect(fetched.tags).toContain("important");

    store.untagNote(note.id, ["important"]);
    fetched = store.getNote(note.id)!;
    expect(fetched.tags).not.toContain("important");
  });

  test("lists tags with counts", () => {
    store.createNote("A", { tags: ["daily"] });
    store.createNote("B", { tags: ["daily"] });
    store.createNote("C", { tags: ["doc"] });

    const tags = store.listTags();
    const daily = tags.find((t) => t.name === "daily");
    expect(daily?.count).toBe(2);
    const doc = tags.find((t) => t.name === "doc");
    expect(doc?.count).toBe(1);
  });

  test("creates and queries links", () => {
    const a = store.createNote("Note A");
    const b = store.createNote("Note B");

    const link = store.createLink(a.id, b.id, "related-to");
    expect(link.sourceId).toBe(a.id);
    expect(link.targetId).toBe(b.id);
    expect(link.relationship).toBe("related-to");

    const outbound = store.getLinks(a.id, { direction: "outbound" });
    expect(outbound.length).toBe(1);

    const inbound = store.getLinks(b.id, { direction: "inbound" });
    expect(inbound.length).toBe(1);

    store.deleteLink(a.id, b.id, "related-to");
    expect(store.getLinks(a.id).length).toBe(0);
  });

  test("attachments", () => {
    const note = store.createNote("With attachment");
    const att = store.addAttachment(note.id, "/path/to/file.png", "image/png");
    expect(att.noteId).toBe(note.id);

    const atts = store.getAttachments(note.id);
    expect(atts.length).toBe(1);
    expect(atts[0].mimeType).toBe("image/png");
  });

  test("starts with no tags", () => {
    const tags = store.listTags();
    expect(tags.length).toBe(0);
  });

  test("gets note by path", () => {
    store.createNote("README content", { path: "Projects/Parachute/README" });
    const note = store.getNoteByPath("Projects/Parachute/README");
    expect(note).not.toBeNull();
    expect(note!.content).toBe("README content");
    expect(note!.path).toBe("Projects/Parachute/README");
  });

  test("gets multiple notes by IDs", () => {
    const a = store.createNote("A");
    const b = store.createNote("B");
    const c = store.createNote("C");

    const fetched = store.getNotes([a.id, c.id]);
    expect(fetched.length).toBe(2);
    expect(fetched.map((n) => n.content)).toContain("A");
    expect(fetched.map((n) => n.content)).toContain("C");
  });

  test("queries by path prefix", () => {
    store.createNote("Root README", { path: "README" });
    store.createNote("Project README", { path: "Projects/Parachute/README" });
    store.createNote("Project Notes", { path: "Projects/Parachute/Notes" });
    store.createNote("Other", { path: "Other/Stuff" });

    const results = store.queryNotes({ pathPrefix: "Projects/Parachute" });
    expect(results.length).toBe(2);
    expect(results.map((n) => n.path)).toContain("Projects/Parachute/README");
    expect(results.map((n) => n.path)).toContain("Projects/Parachute/Notes");
  });
});

describe("metadata", () => {
  test("creates note with metadata", () => {
    const note = store.createNote("Meeting notes", {
      path: "Meetings/standup",
      metadata: { status: "draft", priority: "high", attendees: ["alice", "bob"] },
    });
    expect(note.metadata).toBeDefined();
    expect(note.metadata!.status).toBe("draft");
    expect(note.metadata!.priority).toBe("high");
    expect(note.metadata!.attendees).toEqual(["alice", "bob"]);
  });

  test("updates note metadata", () => {
    const note = store.createNote("Doc", { metadata: { status: "draft" } });
    const updated = store.updateNote(note.id, { metadata: { status: "published", version: 2 } });
    expect(updated.metadata!.status).toBe("published");
    expect(updated.metadata!.version).toBe(2);
  });

  test("queries notes by metadata", () => {
    store.createNote("Draft 1", { metadata: { status: "draft" } });
    store.createNote("Draft 2", { metadata: { status: "draft" } });
    store.createNote("Published", { metadata: { status: "published" } });

    const drafts = store.queryNotes({ metadata: { status: "draft" } });
    expect(drafts.length).toBe(2);

    const published = store.queryNotes({ metadata: { status: "published" } });
    expect(published.length).toBe(1);
    expect(published[0].content).toBe("Published");
  });

  test("notes without metadata return undefined metadata", () => {
    const note = store.createNote("Plain note");
    expect(note.metadata).toBeUndefined();
  });

  test("creates link with metadata", () => {
    const a = store.createNote("A");
    const b = store.createNote("B");
    const link = store.createLink(a.id, b.id, "related-to", {
      confidence: 0.9,
      context: "mentioned in meeting",
    });
    expect(link.metadata).toBeDefined();
    expect(link.metadata!.confidence).toBe(0.9);
    expect(link.metadata!.context).toBe("mentioned in meeting");
  });

  test("hydrated links include note metadata", () => {
    const a = store.createNote("A", { metadata: { type: "project" } });
    const b = store.createNote("B", { metadata: { type: "task" } });
    store.createLink(a.id, b.id, "contains");

    const links = getLinksHydrated(db, a.id);
    expect(links[0].sourceNote?.metadata?.type).toBe("project");
    expect(links[0].targetNote?.metadata?.type).toBe("task");
  });
});

describe("bulk operations", () => {
  test("creates multiple notes at once", () => {
    const notes = store.createNotes([
      { content: "Note 1", tags: ["daily"] },
      { content: "Note 2", tags: ["doc"] },
      { content: "Note 3" },
    ]);
    expect(notes.length).toBe(3);
    expect(notes[0].tags).toContain("daily");
    expect(notes[1].tags).toContain("doc");
  });

  test("createNotes accepts per-note metadata and created_at (mixed batch)", () => {
    const notes = store.createNotes([
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

  test("createNotes preserves per-note metadata isolation across many notes", () => {
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
    const notes = store.createNotes(inputs);
    expect(notes.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(notes[i].path).toBe(`Journal/2024-06-${String(i + 1).padStart(2, "0")}`);
      expect(notes[i].metadata?.index).toBe(i);
      expect(notes[i].metadata?.tana_path).toBe(`daily/2024-06-${i + 1}.md`);
      expect(notes[i].createdAt).toBe(`2024-06-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`);
      expect(notes[i].tags).toContain("captured");
    }
  });

  test("createNotes is backwards compatible — omitted metadata/created_at use defaults", () => {
    const before = new Date().toISOString();
    const notes = store.createNotes([
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

  test("batch tags multiple notes", () => {
    const a = store.createNote("A");
    const b = store.createNote("B");
    const c = store.createNote("C");

    store.batchTag([a.id, b.id, c.id], ["important", "review"]);

    expect(store.getNote(a.id)!.tags).toContain("important");
    expect(store.getNote(b.id)!.tags).toContain("review");
    expect(store.getNote(c.id)!.tags).toContain("important");
  });

  test("batch untags multiple notes", () => {
    const a = store.createNote("A", { tags: ["daily", "pinned"] });
    const b = store.createNote("B", { tags: ["daily", "pinned"] });

    store.batchUntag([a.id, b.id], ["pinned"]);

    expect(store.getNote(a.id)!.tags).toContain("daily");
    expect(store.getNote(a.id)!.tags).not.toContain("pinned");
    expect(store.getNote(b.id)!.tags).not.toContain("pinned");
  });
});

describe("deeper link queries", () => {
  test("traverses links multi-hop", () => {
    const a = store.createNote("A");
    const b = store.createNote("B");
    const c = store.createNote("C");
    const d = store.createNote("D");

    store.createLink(a.id, b.id, "related-to");
    store.createLink(b.id, c.id, "related-to");
    store.createLink(c.id, d.id, "related-to");

    // 1 hop from A: should find B
    const hop1 = store.traverseLinks(a.id, { max_depth: 1 });
    expect(hop1.length).toBe(1);
    expect(hop1[0].noteId).toBe(b.id);

    // 2 hops from A: should find B and C
    const hop2 = store.traverseLinks(a.id, { max_depth: 2 });
    expect(hop2.length).toBe(2);
    const ids2 = hop2.map((n) => n.noteId);
    expect(ids2).toContain(b.id);
    expect(ids2).toContain(c.id);

    // 3 hops from A: should find B, C, and D
    const hop3 = store.traverseLinks(a.id, { max_depth: 3 });
    expect(hop3.length).toBe(3);
  });

  test("traverses with relationship filter", () => {
    const a = store.createNote("A");
    const b = store.createNote("B");
    const c = store.createNote("C");

    store.createLink(a.id, b.id, "mentions");
    store.createLink(a.id, c.id, "related-to");

    const mentions = store.traverseLinks(a.id, { max_depth: 1, relationship: "mentions" });
    expect(mentions.length).toBe(1);
    expect(mentions[0].noteId).toBe(b.id);
  });

  test("finds path between notes", () => {
    const a = store.createNote("A");
    const b = store.createNote("B");
    const c = store.createNote("C");

    store.createLink(a.id, b.id, "related-to");
    store.createLink(b.id, c.id, "mentions");

    const result = store.findPath(a.id, c.id);
    expect(result).not.toBeNull();
    expect(result!.path).toEqual([a.id, b.id, c.id]);
    expect(result!.relationships).toEqual(["related-to", "mentions"]);
  });

  test("get-links returns hydrated note summaries", () => {
    const a = store.createNote("Note A", { path: "a", tags: ["important"] });
    const b = store.createNote("Note B", { path: "b" });
    store.createLink(a.id, b.id, "related-to");

    const result = getLinksHydrated(db, a.id);
    expect(result.length).toBe(1);
    expect(result[0].targetNote?.path).toBe("b");
    expect(result[0].sourceNote?.path).toBe("a");
    expect(result[0].sourceNote?.tags).toContain("important");
  });

  test("returns null when no path exists", () => {
    const a = store.createNote("A");
    const b = store.createNote("B");
    // No link between them

    const result = store.findPath(a.id, b.id);
    expect(result).toBeNull();
  });
});

describe("MCP tools", () => {
  test("generates all 9 core tools", () => {
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
  });

  test("query-notes by id works", () => {
    const tools = generateMcpTools(store);
    const note = store.createNote("By ID", { path: "test/note" });

    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ id: note.id }) as any;
    expect(result.content).toBe("By ID");
    expect(result.path).toBe("test/note");
  });

  test("query-notes by path works", () => {
    const tools = generateMcpTools(store);
    store.createNote("By Path", { path: "Projects/README" });

    const query = tools.find((t) => t.name === "query-notes")!;
    const result = query.execute({ id: "Projects/README" }) as any;
    expect(result.content).toBe("By Path");
  });

  test("create-note tool works via execute", () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = createNote.execute({ content: "MCP note", tags: ["daily"] }) as any;
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

describe("unified MCP wrapper", () => {
  test("vault-info routes through vault param", async () => {
    const { generateUnifiedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig, writeGlobalConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `unified-stats-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
      description: "Test vault",
    });
    writeGlobalConfig({ port: 1940, default_vault: vaultName });

    const vaultStore = getVaultStore(vaultName);
    vaultStore.createNote("alpha", { tags: ["x", "y"] });
    vaultStore.createNote("beta", { tags: ["x"] });

    const tools = generateUnifiedMcpTools();
    const vaultInfo = tools.find((t) => t.name === "vault-info");
    expect(vaultInfo).toBeTruthy();

    const result = vaultInfo!.execute({ vault: vaultName, include_stats: true }) as any;
    expect(result.name).toBe(vaultName);
    expect(result.description).toBe("Test vault");
    expect(result.stats.totalNotes).toBe(2);
    expect(result.stats.tagCount).toBe(2);

    closeAllStores();
  });

  test("list-tags with schema works through unified wrapper", async () => {
    const { generateUnifiedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig, writeGlobalConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tag-schema-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });
    writeGlobalConfig({ port: 1940, default_vault: vaultName });

    const vaultStore = getVaultStore(vaultName);
    vaultStore.createNote("A", { tags: ["person"] });
    vaultStore.upsertTagSchema("person", {
      description: "A person",
      fields: { name: { type: "string", description: "Full name" } },
    });

    const tools = generateUnifiedMcpTools();

    // list-tags with tag param for single tag detail
    const listTags = tools.find((t) => t.name === "list-tags")!;
    const detail = listTags.execute({ vault: vaultName, tag: "person" }) as any;
    expect(detail.name).toBe("person");
    expect(detail.count).toBe(1);
    expect(detail.description).toBe("A person");
    expect(detail.fields.name.type).toBe("string");

    closeAllStores();
  });

  test("create-note with schema tag auto-populates defaults", async () => {
    const { generateUnifiedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig, writeGlobalConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `schema-create-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });
    writeGlobalConfig({ port: 1940, default_vault: vaultName });

    const vaultStore = getVaultStore(vaultName);
    vaultStore.upsertTagSchema("person", {
      description: "A person",
      fields: {
        first_appeared: { type: "string", description: "When" },
        relationship: { type: "string", description: "How" },
      },
    });

    const tools = generateUnifiedMcpTools();
    const createNote = tools.find((t) => t.name === "create-note")!;
    const queryNotes = tools.find((t) => t.name === "query-notes")!;

    // Create a note tagged person with no metadata — defaults auto-populated
    const result = createNote.execute({
      vault: vaultName,
      content: "Alice",
      tags: ["person"],
    }) as any;
    expect(result.content).toBe("Alice");

    // Verify defaults were written
    const fresh = queryNotes.execute({ vault: vaultName, id: result.id }) as any;
    expect(fresh.metadata.first_appeared).toBe("");
    expect(fresh.metadata.relationship).toBe("");

    // Create with explicit metadata — preserved
    const result2 = createNote.execute({
      vault: vaultName,
      content: "Bob",
      tags: ["person"],
      metadata: { first_appeared: "2024-01", relationship: "friend" },
    }) as any;
    const fresh2 = queryNotes.execute({ vault: vaultName, id: result2.id }) as any;
    expect(fresh2.metadata.first_appeared).toBe("2024-01");
    expect(fresh2.metadata.relationship).toBe("friend");

    closeAllStores();
  });

  test("update-note tags.add with schema auto-populates defaults", async () => {
    const { generateUnifiedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig, writeGlobalConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores: close } = await import("./vault-store.ts");

    const vaultName = `schema-defaults-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });
    writeGlobalConfig({ port: 1940, default_vault: vaultName });

    const vaultStore = getVaultStore(vaultName);
    vaultStore.upsertTagSchema("person", {
      description: "A person",
      fields: {
        first_appeared: { type: "string", description: "When" },
        relationship: { type: "string", description: "How" },
      },
    });
    vaultStore.upsertTagSchema("project", {
      description: "A project",
      fields: {
        status: { type: "string", enum: ["active", "completed", "abandoned"], description: "Status" },
        active: { type: "boolean", description: "Is active" },
        priority: { type: "integer", description: "Priority level" },
      },
    });
    const tools = generateUnifiedMcpTools();
    const createNote = tools.find((t) => t.name === "create-note")!;
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const queryNotes = tools.find((t) => t.name === "query-notes")!;

    // Create a note, then add #person tag via update-note
    const note = createNote.execute({ vault: vaultName, content: "Alice" }) as any;
    updateNote.execute({ vault: vaultName, id: note.id, tags: { add: ["person"] } });
    const after = queryNotes.execute({ vault: vaultName, id: note.id }) as any;
    expect(after.metadata.first_appeared).toBe("");
    expect(after.metadata.relationship).toBe("");

    // Tag note that already has partial metadata — only missing fields populated
    const note2 = createNote.execute({
      vault: vaultName,
      content: "Bob",
      metadata: { first_appeared: "2023-11" },
    }) as any;
    updateNote.execute({ vault: vaultName, id: note2.id, tags: { add: ["person"] } });
    const after2 = queryNotes.execute({ vault: vaultName, id: note2.id }) as any;
    expect(after2.metadata.first_appeared).toBe("2023-11"); // preserved
    expect(after2.metadata.relationship).toBe(""); // added

    // Tag with #project — enum defaults to first value, boolean to false, integer to 0
    const note4 = createNote.execute({ vault: vaultName, content: "My Project" }) as any;
    updateNote.execute({ vault: vaultName, id: note4.id, tags: { add: ["project"] } });
    const after4 = queryNotes.execute({ vault: vaultName, id: note4.id }) as any;
    expect(after4.metadata.status).toBe("active");
    expect(after4.metadata.active).toBe(false);
    expect(after4.metadata.priority).toBe(0);

    // Multiple schema tags at once — all defaults merged
    const note5 = createNote.execute({ vault: vaultName, content: "Multi" }) as any;
    updateNote.execute({ vault: vaultName, id: note5.id, tags: { add: ["person", "project"] } });
    const after5 = queryNotes.execute({ vault: vaultName, id: note5.id }) as any;
    expect(after5.metadata.first_appeared).toBe("");
    expect(after5.metadata.relationship).toBe("");
    expect(after5.metadata.status).toBe("active");
    expect(after5.metadata.active).toBe(false);

    close();
  });

  test("update-note tags.add auto-populate does not bump updatedAt", async () => {
    const { generateUnifiedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig, writeGlobalConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores: close } = await import("./vault-store.ts");

    const vaultName = `schema-noupdate-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });
    writeGlobalConfig({ port: 1940, default_vault: vaultName });

    const vaultStore = getVaultStore(vaultName);
    vaultStore.upsertTagSchema("person", {
      description: "A person",
      fields: { name: { type: "string" } },
    });

    const tools = generateUnifiedMcpTools();
    const createNote = tools.find((t) => t.name === "create-note")!;
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const queryNotes = tools.find((t) => t.name === "query-notes")!;

    const note = createNote.execute({ vault: vaultName, content: "Test" }) as any;
    const originalUpdatedAt = note.updatedAt;
    updateNote.execute({ vault: vaultName, id: note.id, tags: { add: ["person"] } });
    const after = queryNotes.execute({ vault: vaultName, id: note.id }) as any;
    expect(after.updatedAt).toBe(originalUpdatedAt);
    expect(after.metadata.name).toBe("");

    close();
  });
});

describe("auth permissions", () => {
  test("read permission allows read tools", () => {
    const { isToolAllowed } = require("./auth.ts");
    expect(isToolAllowed("query-notes", "read")).toBe(true);
    expect(isToolAllowed("list-tags", "read")).toBe(true);
    expect(isToolAllowed("find-path", "read")).toBe(true);
    expect(isToolAllowed("vault-info", "read")).toBe(true);
    expect(isToolAllowed("list-vaults", "read")).toBe(true);
  });

  test("read permission blocks write and admin tools", () => {
    const { isToolAllowed } = require("./auth.ts");
    expect(isToolAllowed("create-note", "read")).toBe(false);
    expect(isToolAllowed("update-note", "read")).toBe(false);
    expect(isToolAllowed("delete-note", "read")).toBe(false);
    expect(isToolAllowed("update-tag", "read")).toBe(false);
    expect(isToolAllowed("delete-tag", "read")).toBe(false);
  });

  test("write permission allows read + write tools but not admin-only", () => {
    const { isToolAllowed } = require("./auth.ts");
    expect(isToolAllowed("create-note", "write")).toBe(true);
    expect(isToolAllowed("update-note", "write")).toBe(true);
    expect(isToolAllowed("update-tag", "write")).toBe(true);
    expect(isToolAllowed("query-notes", "write")).toBe(true);
    // delete-note and delete-tag are admin-only
    expect(isToolAllowed("delete-note", "write")).toBe(false);
    expect(isToolAllowed("delete-tag", "write")).toBe(false);
  });

  test("admin permission allows everything", () => {
    const { isToolAllowed } = require("./auth.ts");
    expect(isToolAllowed("create-note", "admin")).toBe(true);
    expect(isToolAllowed("delete-note", "admin")).toBe(true);
    expect(isToolAllowed("delete-tag", "admin")).toBe(true);
    expect(isToolAllowed("query-notes", "admin")).toBe(true);
  });

  test("read permission allows GET but not POST/PATCH/DELETE", () => {
    const { isMethodAllowed } = require("./auth.ts");
    expect(isMethodAllowed("GET", "read")).toBe(true);
    expect(isMethodAllowed("HEAD", "read")).toBe(true);
    expect(isMethodAllowed("POST", "read")).toBe(false);
    expect(isMethodAllowed("PATCH", "read")).toBe(false);
    expect(isMethodAllowed("DELETE", "read")).toBe(false);
  });

  test("write permission allows GET/POST/PATCH but not DELETE", () => {
    const { isMethodAllowed } = require("./auth.ts");
    expect(isMethodAllowed("GET", "write")).toBe(true);
    expect(isMethodAllowed("POST", "write")).toBe(true);
    expect(isMethodAllowed("PATCH", "write")).toBe(true);
    expect(isMethodAllowed("DELETE", "write")).toBe(false);
  });

  test("admin permission allows all methods", () => {
    const { isMethodAllowed } = require("./auth.ts");
    expect(isMethodAllowed("GET", "admin")).toBe(true);
    expect(isMethodAllowed("POST", "admin")).toBe(true);
    expect(isMethodAllowed("DELETE", "admin")).toBe(true);
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

describe("HTTP /notes", () => {
  test("GET /notes defaults to lean index (no content field)", async () => {
    store.createNote("one content", { path: "a", tags: ["t"] });
    store.createNote("two content", { path: "b", tags: ["t"] });
    const res = await handleNotes(mkReq("GET", "/notes"), store, "");
    const body = await res.json() as any[];
    expect(body).toHaveLength(2);
    expect(body[0]).not.toHaveProperty("content");
    expect(body[0]).toHaveProperty("byteSize");
    expect(body[0]).toHaveProperty("preview");
  });

  test("GET /notes?include_content=true returns full notes", async () => {
    store.createNote("full body", { path: "a" });
    const res = await handleNotes(mkReq("GET", "/notes?include_content=true"), store, "");
    const body = await res.json() as any[];
    expect(body[0].content).toBe("full body");
  });

  test("GET /notes?search=fox full-text search", async () => {
    store.createNote("The quick brown fox");
    store.createNote("A lazy dog");
    const res = await handleNotes(mkReq("GET", "/notes?search=fox"), store, "");
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
  });

  test("GET /notes?search=fox&include_metadata=false strips metadata from search results", async () => {
    store.createNote("The quick brown fox", { metadata: { summary: "animal" } });
    const res = await handleNotes(mkReq("GET", "/notes?search=fox&include_metadata=false"), store, "");
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].metadata).toBeUndefined();
  });

  test("GET /notes/:id defaults to full content", async () => {
    const n = store.createNote("hello", { id: "x" });
    const res = await handleNotes(mkReq("GET", "/notes/x"), store, "/x");
    const body = await res.json() as any;
    expect(body.content).toBe("hello");
  });

  test("GET /notes/:id?include_content=false returns lean shape", async () => {
    store.createNote("hello", { id: "x" });
    const res = await handleNotes(mkReq("GET", "/notes/x?include_content=false"), store, "/x");
    const body = await res.json() as any;
    expect(body).not.toHaveProperty("content");
    expect(body.byteSize).toBe(5);
    expect(body.preview).toBe("hello");
  });

  test("GET /notes?include_metadata=false strips metadata from list", async () => {
    store.createNote("a", { tags: ["m"], metadata: { summary: "hello", status: "ok" } });
    store.createNote("b", { tags: ["m"], metadata: { summary: "world" } });
    const res = await handleNotes(mkReq("GET", "/notes?tag=m&include_metadata=false"), store, "");
    const body = await res.json() as any[];
    expect(body).toHaveLength(2);
    for (const n of body) {
      expect(n.metadata).toBeUndefined();
    }
  });

  test("GET /notes?include_metadata=summary,status returns only those fields", async () => {
    store.createNote("a", { tags: ["mf"], metadata: { summary: "hello", status: "ok", extra: true } });
    const res = await handleNotes(mkReq("GET", "/notes?tag=mf&include_metadata=summary,status"), store, "");
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].metadata).toEqual({ summary: "hello", status: "ok" });
  });

  test("GET /notes/:id?include_metadata=false strips metadata from single note", async () => {
    store.createNote("hello", { id: "xm", metadata: { summary: "s" } });
    const res = await handleNotes(mkReq("GET", "/notes/xm?include_metadata=false"), store, "/xm");
    const body = await res.json() as any;
    expect(body.metadata).toBeUndefined();
    expect(body.content).toBe("hello");
  });

  test("GET /notes/:id?include_metadata=summary returns only specified fields", async () => {
    store.createNote("hello", { id: "xm2", metadata: { summary: "s", status: "draft" } });
    const res = await handleNotes(mkReq("GET", "/notes/xm2?include_metadata=summary"), store, "/xm2");
    const body = await res.json() as any;
    expect(body.metadata).toEqual({ summary: "s" });
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

  test("POST /notes/:id/attachments accepts mimeType (camelCase) in body", async () => {
    const n = store.createNote("x", { id: "x" });
    const res = await handleNotes(
      mkReq("POST", "/notes/x/attachments", { path: "files/a.png", mimeType: "image/png" }),
      store,
      "/x/attachments",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.mimeType).toBe("image/png");
  });
});

describe("HTTP GET /notes?format=graph", () => {
  test("returns nodes and edges for linked notes", async () => {
    const a = store.createNote("A", { id: "a", path: "People/Alice", tags: ["person"] });
    const b = store.createNote("B", { id: "b", path: "People/Bob", tags: ["person"] });
    const c = store.createNote("C", { id: "c", path: "Projects/X" });
    store.createLink("a", "b", "knows");
    store.createLink("a", "c", "works-on");

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
    store.createNote("A", { id: "a" });
    store.createNote("B", { id: "b" });
    store.createLink("a", "b", "ref");

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
    const a = store.createNote("A", { id: "a", path: "People/Mickey" });
    const b = store.createNote("B", { id: "b" });
    const c = store.createNote("C", { id: "c" });
    const d = store.createNote("D", { id: "d" }); // not connected
    store.createLink("a", "b", "knows");
    store.createLink("b", "c", "knows");

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
    const a = store.createNote("A", { id: "a" });
    const b = store.createNote("B", { id: "b" });
    const c = store.createNote("C", { id: "c" });
    store.createLink("a", "b", "ref");
    store.createLink("b", "c", "ref");

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

describe("HTTP PATCH /notes/:idOrPath (update)", () => {
  test("PATCH updates content and merges metadata", async () => {
    const note = store.createNote("original", { id: "x", metadata: { a: 1 } });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { content: "updated", metadata: { b: 2 } }),
      store,
      "/x",
    );
    const body = await res.json() as any;
    expect(body.content).toBe("updated");
    expect(body.metadata).toEqual({ a: 1, b: 2 });
  });

  test("PATCH adds/removes tags", async () => {
    store.createNote("x", { id: "x", tags: ["old"] });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { tags: { add: ["new"], remove: ["old"] } }),
      store,
      "/x",
    );
    const body = await res.json() as any;
    expect(body.tags).toContain("new");
    expect(body.tags).not.toContain("old");
  });

  test("PATCH adds/removes links", async () => {
    store.createNote("a", { id: "a" });
    store.createNote("b", { id: "b" });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/a", { links: { add: [{ target: "b", relationship: "mentions" }] } }),
      store,
      "/a",
    );
    expect(res.status).toBe(200);
    const links = store.getLinks("a", { direction: "outbound" });
    expect(links).toHaveLength(1);

    // Remove
    await handleNotes(
      mkReq("PATCH", "/notes/a", { links: { remove: [{ target: "b", relationship: "mentions" }] } }),
      store,
      "/a",
    );
    expect(store.getLinks("a", { direction: "outbound" })).toHaveLength(0);
  });

  test("PATCH resolves note by path", async () => {
    store.createNote("x", { path: "Projects/README" });
    const res = await handleNotes(
      mkReq("PATCH", `/notes/${encodeURIComponent("Projects/README")}`, { content: "updated" }),
      store,
      `/${encodeURIComponent("Projects/README")}`,
    );
    const body = await res.json() as any;
    expect(body.content).toBe("updated");
  });

  test("DELETE resolves note by path", async () => {
    store.createNote("x", { path: "Temp/note" });
    const res = await handleNotes(
      mkReq("DELETE", `/notes/${encodeURIComponent("Temp/note")}`),
      store,
      `/${encodeURIComponent("Temp/note")}`,
    );
    const body = await res.json() as any;
    expect(body.deleted).toBe(true);
    expect(store.getNoteByPath("Temp/note")).toBeNull();
  });
});

describe("HTTP /tags", () => {
  test("GET /tags lists all tags", async () => {
    store.createNote("A", { tags: ["daily"] });
    store.createNote("B", { tags: ["daily", "pinned"] });
    const res = await handleTags(mkReq("GET", "/tags"), store);
    const body = await res.json() as any[];
    const daily = body.find((t: any) => t.name === "daily");
    expect(daily.count).toBe(2);
  });

  test("GET /tags?tag=name returns single tag detail with schema", async () => {
    store.createNote("A", { tags: ["person"] });
    store.upsertTagSchema("person", { description: "A person", fields: { name: { type: "string" } } });
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

  test("DELETE /tags/:name removes tag and schema", async () => {
    store.createNote("A", { tags: ["doomed"] });
    store.upsertTagSchema("doomed", { description: "will be deleted" });
    const res = await handleTags(mkReq("DELETE", "/tags/doomed"), store, "/doomed");
    const body = await res.json() as any;
    expect(body.deleted).toBe(true);
    expect(store.listTags().some((t) => t.name === "doomed")).toBe(false);
  });
});

describe("HTTP /find-path", () => {
  test("finds path between two notes", async () => {
    store.createNote("a", { id: "a" });
    store.createNote("b", { id: "b" });
    store.createNote("c", { id: "c" });
    store.createLink("a", "b", "mentions");
    store.createLink("b", "c", "related-to");
    const res = handleFindPath(mkReq("GET", "/find-path?source=a&target=c"), store);
    const body = await res.json() as any;
    expect(body.path).toEqual(["a", "b", "c"]);
    expect(body.relationships).toEqual(["mentions", "related-to"]);
  });

  test("returns null when no path exists", async () => {
    store.createNote("a", { id: "a" });
    store.createNote("b", { id: "b" });
    const res = handleFindPath(mkReq("GET", "/find-path?source=a&target=b"), store);
    const body = await res.json() as any;
    expect(body).toBeNull();
  });

  test("requires source and target params", async () => {
    const res = handleFindPath(mkReq("GET", "/find-path?source=a"), store);
    expect(res.status).toBe(400);
  });
});

describe("stateless MCP transport", () => {
  test("tools/call works without prior initialize handshake", async () => {
    const { handleUnifiedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig, writeGlobalConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `stateless-mcp-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });
    writeGlobalConfig({ port: 1940, default_vault: vaultName });

    const vaultStore = getVaultStore(vaultName);
    vaultStore.createNote("test note", { tags: ["daily"] });

    // Direct tools/call — no initialize, no session header
    const req = new Request("http://localhost:1940/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "vault-info", arguments: { vault: vaultName, include_stats: true } },
      }),
    });

    const res = await handleUnifiedMcp(req, "write");
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.result).toBeDefined();
    const content = JSON.parse(body.result.content[0].text);
    expect(content.stats.totalNotes).toBe(1);

    closeAllStores();
  });

  test("tools/list works without prior initialize handshake", async () => {
    const { handleUnifiedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig, writeGlobalConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `stateless-list-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });
    writeGlobalConfig({ port: 1940, default_vault: vaultName });

    const req = new Request("http://localhost:1940/mcp", {
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

    const res = await handleUnifiedMcp(req, "write");
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.result.tools).toBeDefined();
    expect(body.result.tools.length).toBeGreaterThan(0);
    const toolNames = body.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("create-note");
    expect(toolNames).toContain("vault-info");

    closeAllStores();
  });

  test("initialize still works for clients that send it", async () => {
    const { handleUnifiedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig, writeGlobalConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `stateless-init-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });
    writeGlobalConfig({ port: 1940, default_vault: vaultName });

    const req = new Request("http://localhost:1940/mcp", {
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

    const res = await handleUnifiedMcp(req, "write");
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo.name).toBe("parachute-vault");
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

