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
import { buildVaultProjection } from "../core/src/vault-projection.ts";
import { handleNotes, handleTags, handleFindPath, handleVault, handleUnresolvedWikilinks, MAX_JSON_BODY_BYTES } from "./routes.ts";
import { expandTokenTagScope } from "./tag-scope.ts";
import type { TagScopeCtx } from "./routes.ts";
import { extractApiKey } from "./auth.ts";
import { startTranscriptionWorker } from "./transcription-worker.ts";
import { setTranscriptionWorker } from "./transcription-registry.ts";
import type { Store } from "../core/src/types.ts";

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

  test("notes without metadata return metadata: {} (vault V1.1 — not an absent key)", async () => {
    const note = await store.createNote("Plain note");
    expect(note.metadata).toEqual({});
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
    expect(tools.length).toBe(13);

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
    // prune-schema (admin) — drops orphaned indexed-field columns.
    expect(names).toContain("prune-schema");
    // rename-tag / merge-tags (vault#552) — MCP parity with the pre-existing
    // REST engine.
    expect(names).toContain("rename-tag");
    expect(names).toContain("merge-tags");
    // doctor (admin, vault#552) — read-only taxonomy/metadata integrity scan.
    expect(names).toContain("doctor");
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

  // FIX 2 (vault#589) — the MCP door rejects illegal paths too. The core tool
  // throws a `PathValidationError` (error_type invalid_path) exactly like
  // ExtensionValidationError; mcp-http.ts's generic error_type mapping turns it
  // into a structured domain error at the transport. Assert the MCP tool path
  // itself refuses the write (parity with the REST-door tests below).
  test("create-note MCP tool rejects a '..' path with error_type invalid_path", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    let thrown: any;
    try {
      await createNote.execute({ content: "x", path: "../escape" });
    } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    expect(thrown.error_type).toBe("invalid_path");
    expect(thrown.code).toBe("INVALID_PATH");
    // Nothing written.
    expect(await store.getNoteByPath("escape")).toBeNull();
  });

  test("create-note MCP tool rejects a NUL path with error_type invalid_path", async () => {
    const NUL = String.fromCharCode(0);
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    let thrown: any;
    try {
      await createNote.execute({ content: "x", path: `bad${NUL}path` });
    } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    expect(thrown.error_type).toBe("invalid_path");
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

    // The GAP-3 coordinates block reads PARACHUTE_HUB_ORIGIN; another test FILE
    // in a shared `bun test ./src` run may have left it set (cross-file env
    // pollution — e.g. hub-jwt.test.ts). Pin loopback so the coordinates
    // assertion below is deterministic regardless of file order; restore after.
    const prevHubOrigin = process.env.PARACHUTE_HUB_ORIGIN;
    delete process.env.PARACHUTE_HUB_ORIGIN;

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

    // GAP 3 — coordinates block: the vault states its own NAME + REST/MCP URL
    // templates so a surface-builder doesn't reconstruct them from the
    // connector config. No public hub origin in this test fixture → loopback →
    // `<hub-origin>` placeholder templates, `base_url` null.
    const coords = result.coordinates as Record<string, unknown>;
    expect(coords.name).toBe(vaultName);
    expect(coords.rest_api).toBe(`<hub-origin>/vault/${vaultName}/api`);
    expect(coords.mcp).toBe(`<hub-origin>/vault/${vaultName}/mcp`);
    expect(coords.base_url).toBeNull();

    // stats omitted unless requested
    expect(result.stats).toBeUndefined();

    const withStats = await vaultInfo.execute({ include_stats: true }) as any;
    expect(withStats.stats).toBeTruthy();

    if (prevHubOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
    else process.env.PARACHUTE_HUB_ORIGIN = prevHubOrigin;
    closeAllStores();
  });

  test("vault-info includes a compact structural map WITHOUT include_stats (front-door)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `map-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });

    const vaultStore = getVaultStore(vaultName);
    await vaultStore.createNote("a", { tags: ["person"], path: "People/Alice" });
    await vaultStore.createNote("b", { tags: ["person"] }); // no path

    const tools = generateScopedMcpTools(vaultName);
    const vaultInfo = tools.find((t) => t.name === "vault-info")!;

    // No `include_stats` flag — the map must still be present (that's the
    // whole point: orient in ONE call, no flag needed).
    const result = await vaultInfo.execute({}) as any;
    expect(result.stats).toBeUndefined();
    expect(result.map).toBeTruthy();
    expect(result.map.total_notes).toBe(2);
    expect(result.map.tags).toEqual([{ name: "person", count: 2 }]);
    expect(result.map.path_buckets).toEqual([{ name: "People", count: 1 }]);
    expect(result.map.unfiled_notes).toBe(1);

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

  test("create-note with schema tag applies explicit defaults; undeclared fields stay absent (vault#553 Decision B)", async () => {
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
        first_appeared: { type: "string", description: "When", default: "unknown" },
        relationship: { type: "string", description: "How" }, // no default — stays absent
      },
    });

    const tools = generateScopedMcpTools(vaultName);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const queryNotes = tools.find((t) => t.name === "query-notes")!;

    // Create a note tagged person with no metadata — the EXPLICIT default
    // auto-populates; the field with no `default` stays absent.
    const result = await createNote.execute({
      content: "Alice",
      tags: ["person"],
    }) as any;
    expect(result.content).toBe("Alice");

    const fresh = await queryNotes.execute({ id: result.id }) as any;
    expect(fresh.metadata.first_appeared).toBe("unknown");
    expect(fresh.metadata.relationship).toBeUndefined();

    // Create with explicit metadata — preserved (overrides the default).
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

  test("update-note tags.add with schema applies explicit defaults; undeclared fields stay absent (vault#553 Decision B)", async () => {
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
        first_appeared: { type: "string", description: "When", default: "unknown" },
        relationship: { type: "string", description: "How" }, // no default — stays absent
      },
    });
    await vaultStore.upsertTagSchema("project", {
      description: "A project",
      fields: {
        status: { type: "string", enum: ["active", "completed", "abandoned"], description: "Status", default: "active" },
        active: { type: "boolean", description: "Is active", default: false },
        priority: { type: "integer", description: "Priority level" }, // no default — stays absent
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
    expect(after.metadata.first_appeared).toBe("unknown");
    expect(after.metadata.relationship).toBeUndefined();

    // Tag note that already has partial metadata — only missing fields WITH a
    // declared default get populated; the field with no default stays absent.
    const note2 = await createNote.execute({
      content: "Bob",
      metadata: { first_appeared: "2023-11" },
    }) as any;
    await updateNote.execute({ id: note2.id, tags: { add: ["person"] }, force: true });
    const after2 = await queryNotes.execute({ id: note2.id }) as any;
    expect(after2.metadata.first_appeared).toBe("2023-11"); // preserved
    expect(after2.metadata.relationship).toBeUndefined(); // no default — stays absent

    // Tag with #project — declared defaults land; `priority` (no default) stays absent.
    const note4 = await createNote.execute({ content: "My Project" }) as any;
    await updateNote.execute({ id: note4.id, tags: { add: ["project"] }, force: true });
    const after4 = await queryNotes.execute({ id: note4.id }) as any;
    expect(after4.metadata.status).toBe("active");
    expect(after4.metadata.active).toBe(false);
    expect(after4.metadata.priority).toBeUndefined();

    // Multiple schema tags at once — all EXPLICIT defaults merged.
    const note5 = await createNote.execute({ content: "Multi" }) as any;
    await updateNote.execute({ id: note5.id, tags: { add: ["person", "project"] }, force: true });
    const after5 = await queryNotes.execute({ id: note5.id }) as any;
    expect(after5.metadata.first_appeared).toBe("unknown");
    expect(after5.metadata.relationship).toBeUndefined();
    expect(after5.metadata.status).toBe("active");
    expect(after5.metadata.active).toBe(false);

    close();
  });

  // -- tag-scoped MCP wrappers (docs/contracts/tag-scoped-tokens.md) ------------
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

  test("scoped vault-info's map covers only notes reachable through an in-scope tag (front-door)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-vault-info-map-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });

    const store0 = getVaultStore(vaultName);
    await store0.createNote("a", { tags: ["work"], path: "Work/One" });
    await store0.createNote("b", { tags: ["work"] }); // no path
    await store0.createNote("c", { tags: ["personal"], path: "Personal/Two" });

    // Scoped to `work` only.
    const tools = generateScopedMcpTools(vaultName, authForTags(["work"]) as any);
    const result = await tools.find((t) => t.name === "vault-info")!.execute({}) as any;

    expect(result.map.total_notes).toBe(2); // a, b — "c" (personal) excluded
    expect(result.map.tags).toEqual([{ name: "work", count: 2 }]);
    expect(result.map.path_buckets).toEqual([{ name: "Work", count: 1 }]);
    expect(result.map.unfiled_notes).toBe(1);

    closeAllStores();
  });

  test("scoped vault-info with an allowlist matching nothing returns an all-zero map, not the full vault", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-vault-info-map-empty-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });

    const store0 = getVaultStore(vaultName);
    await store0.createNote("a", { tags: ["work"], path: "Work/One" });

    // Scoped to a tag that doesn't exist in this vault at all.
    const tools = generateScopedMcpTools(vaultName, authForTags(["nonexistent"]) as any);
    const result = await tools.find((t) => t.name === "vault-info")!.execute({}) as any;

    expect(result.map).toEqual({ total_notes: 0, tags: [], path_buckets: [], unfiled_notes: 0 });

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

  // -- Q6 through the MCP TRANSPORT (vault#325 Part 2) --------------------
  //
  // The two tests above call `tool.execute()` directly — that exercises the
  // tag-scope WRAPPER but bypasses `handleScopedMcp`: the JSON-RPC transport,
  // the `hasScopeForVault` tool-visibility gate, and the tools/call dispatch.
  // The HTTP-layer twin lives in `routing.test.ts` (Q6 read-path). What was
  // missing — and what this pins — is the orphan-sub-tag fail-open driven
  // through the actual MCP `tools/call` path a real client hits. Same fixture
  // as the HTTP test (`#health/food` with no `_tags/health/food` schema,
  // token allowlisted for `health`), different transport.

  test("MCP query-notes (tools/call) sees orphan sub-tag via string-form root (vault#325 Part 2)", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `mcp-orphan-query-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    // No `_tags/health/food` schema — this is the orphan case. The hierarchy
    // is implicit, so authorization must fall back to the string-form root.
    const orphan = await store.createNote("orphan", { tags: ["health/food"] });

    const auth = {
      permission: "read" as const,
      scopes: ["vault:read"],
      legacyDerived: false,
      scoped_tags: ["health"],
    };

    // The URL is inert here — handleScopedMcp hands it to the SDK
    // transport, which only reads the body; the `vaultName` route wiring
    // is exercised by routing.test.ts, not this transport-level test. The
    // `accept` header is load-bearing: `enableJsonResponse` returns JSON
    // only when text/event-stream is also acceptable, else it streams SSE.
    const callReq = (id: number, name: string, args: Record<string, unknown>) =>
      new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });

    // Fetch the orphan by id through the MCP transport with a token scoped
    // to ["health"]. The orphan is tagged `health/food` (no schema) → the
    // string-form fallback resolves the root `health` → in allowlist → the
    // note must come back rather than 404/forbidden.
    const res = await handleScopedMcp(callReq(1, "query-notes", { id: orphan.id }), vaultName, auth as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // tools/call returns content[].text with the JSON-stringified tool result.
    expect(body.result?.isError).toBeFalsy();
    const text: string = body.result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.id).toBe(orphan.id);
    expect(parsed.tags).toContain("health/food");

    // Control: a token scoped to a DIFFERENT root must NOT see the orphan
    // through the same transport — proves the green result above is the
    // fail-open fallback firing, not scoping being inert.
    const denied = {
      permission: "read" as const,
      scopes: ["vault:read"],
      legacyDerived: false,
      scoped_tags: ["work"],
    };
    const resDenied = await handleScopedMcp(
      callReq(2, "query-notes", { id: orphan.id }),
      vaultName,
      denied as any,
    );
    expect(resDenied.status).toBe(200);
    const deniedBody = (await resDenied.json()) as any;
    const deniedText: string = deniedBody.result.content[0].text;
    const deniedParsed = JSON.parse(deniedText);
    // Out-of-scope single-note fetch fails closed: the wrapper replaces the
    // note body with `{ error: "Note not found" }` (no content/tags leak).
    // This proves the `health`-scoped green result above is the fail-open
    // string-form fallback firing, not the wrapper being a no-op.
    expect(deniedParsed.error).toBe("Note not found");
    expect(deniedParsed.content).toBeUndefined();
    expect(deniedParsed.tags).toBeUndefined();

    closeAllStores();
  });

  // -- Q5: MCP delete-tag dependency check -------------------------------

  test("MCP delete-tag returns tag_in_use_by_tokens when a vestigial tag-scoped token row references the tag", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-dep-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.createNote("h", { tags: ["health"] });

    // Seed a vestigial tag-scoped row referencing "health" (raw INSERT —
    // vault no longer mints these post-0.5.0, but findTokensReferencingTag
    // still guards the tag-delete path against leftover rows). vault#282.
    store.db
      .prepare(
        "INSERT INTO tokens (token_hash, label, permission, scoped_tags, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        `sha256:health-claw-${Math.random().toString(36).slice(2)}`,
        "health-claw",
        "read",
        JSON.stringify(["health"]),
        new Date().toISOString(),
      );

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

  // vault#555 fix 2 REVISED this test's contract. Pre-fix-2 a tags-only
  // `update-note` (here, adding a tag that ALSO triggers a schema-default
  // backfill) did NOT bump `updated_at` — this test asserted that. Fix 2
  // makes ANY tag mutation bump `updated_at` (so cursor/sync loops see it);
  // the separate defaults backfill still rides `skipUpdatedAt: true` and
  // doesn't itself bump. Net: the tag add bumps updatedAt exactly once, and
  // the default still lands. (The old assertion passed only by
  // create+update landing in the same millisecond — a latent flake fix 2
  // turned into a real contradiction; caught on a review re-run.)
  test("update-note tags.add bumps updatedAt AND still applies the schema default (vault#555 fix 2)", async () => {
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
    // vault#553 Decision B: backfill is explicit-`default`-only — declare
    // one so this still exercises an actual defaults-write.
    await vaultStore.upsertTagSchema("person", {
      description: "A person",
      fields: { name: { type: "string", default: "unknown" } },
    });

    const tools = generateScopedMcpTools(vaultName);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const queryNotes = tools.find((t) => t.name === "query-notes")!;

    const note = await createNote.execute({ content: "Test" }) as any;
    const originalUpdatedAt = note.updatedAt;
    await new Promise((r) => setTimeout(r, 5)); // deterministic ms gap
    await updateNote.execute({ id: note.id, tags: { add: ["person"] }, force: true });
    const after = await queryNotes.execute({ id: note.id }) as any;
    // Fix 2: the tag mutation bumped updatedAt.
    expect(after.updatedAt).not.toBe(originalUpdatedAt);
    expect(new Date(after.updatedAt) > new Date(originalUpdatedAt)).toBe(true);
    // The schema default still backfilled.
    expect(after.metadata.name).toBe("unknown");

    close();
  });

  // -- tag-scope confidentiality: expand_links + include_links (security
  //    review) -----------------------------------------------------------
  //
  // These pin the MCP side of the expand_links / include_links leaks. A
  // tag-scoped session must NOT inline out-of-scope note content via
  // expand_links, and must NOT hydrate out-of-scope neighbor summaries via
  // include_links. The unscoped path must remain fully functional. They
  // MUST fail if the predicate / link-scrub is removed.

  test("MCP expand_links does NOT inline out-of-scope wikilinked content", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-expand-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    // Out-of-scope #personal note holds the secret; in-scope #work note links it.
    await store.createNote("SECRET PERSONAL BODY", { path: "Secret", tags: ["personal"] });
    const work = await store.createNote("intro [[Secret]]", { path: "Work", tags: ["work"] });

    const tools = generateScopedMcpTools(vaultName, authForTags(["work"]) as any);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({
      id: work.id,
      include_content: true,
      expand_links: true,
    }) as any;

    expect(result.content).not.toContain("SECRET PERSONAL BODY");
    // Wikilink stays literal — indistinguishable from not-found.
    expect(result.content).toContain("[[Secret]]");

    closeAllStores();
  });

  test("MCP expand_links multi-hop (depth>1) does not leak out-of-scope content", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-expand-deep-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.createNote("DEEP PERSONAL SECRET", { path: "Deep", tags: ["personal"] });
    await store.createNote("mid [[Deep]]", { path: "Mid", tags: ["work"] });
    const top = await store.createNote("top [[Mid]]", { path: "Top", tags: ["work"] });

    const tools = generateScopedMcpTools(vaultName, authForTags(["work"]) as any);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({
      id: top.id,
      include_content: true,
      expand_links: true,
      expand_depth: 3,
    }) as any;

    // In-scope Mid inlines; out-of-scope Deep never does, at any depth.
    expect(result.content).toContain("mid");
    expect(result.content).not.toContain("DEEP PERSONAL SECRET");

    closeAllStores();
  });

  test("UNSCOPED MCP expand_links still inlines wikilinked content (regression)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-expand-unscoped-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.createNote("PERSONAL BODY", { path: "Secret", tags: ["personal"] });
    const work = await store.createNote("intro [[Secret]]", { path: "Work", tags: ["work"] });

    // No auth → unscoped session. Expansion must behave exactly as before.
    const tools = generateScopedMcpTools(vaultName);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({
      id: work.id,
      include_content: true,
      expand_links: true,
    }) as any;

    expect(result.content).toContain("PERSONAL BODY");

    closeAllStores();
  });

  test("MCP include_links strips out-of-scope NEIGHBOR summaries", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-incl-links-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    const secret = await store.createNote("secret", { path: "Secret", tags: ["personal"] });
    const work = await store.createNote("work", { path: "Work", tags: ["work"] });
    await store.createLink(work.id, secret.id, "references");

    const tools = generateScopedMcpTools(vaultName, authForTags(["work"]) as any);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: work.id, include_links: true }) as any;

    const links = (result.links ?? []) as any[];
    // No surviving link may reference the out-of-scope note's id/path.
    const serialized = JSON.stringify(links);
    expect(serialized).not.toContain(secret.id);
    expect(serialized).not.toContain("Secret");

    closeAllStores();
  });

  test("UNSCOPED MCP include_links still hydrates the full neighbor (regression)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-incl-links-unscoped-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    const secret = await store.createNote("secret", { path: "Secret", tags: ["personal"] });
    const work = await store.createNote("work", { path: "Work", tags: ["work"] });
    await store.createLink(work.id, secret.id, "references");

    const tools = generateScopedMcpTools(vaultName);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: work.id, include_links: true }) as any;

    const links = (result.links ?? []) as any[];
    expect(links.length).toBe(1);
    expect(JSON.stringify(links)).toContain(secret.id);

    closeAllStores();
  });

  // vault#555 auth review — validation_status must not leak an out-of-scope
  // co-tag's schema shape (field name / type / enum) to a scoped caller
  // (the #560 leak class). A note the caller CAN see (in-scope tag) may also
  // carry an out-of-scope tag whose schema it violates.
  test("MCP query-notes scrubs out-of-scope tag schema from validation_status; only the in-scope tag's warning survives", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-vs-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    // In-scope tag "work" declares a field the note violates; out-of-scope
    // "project-manhattan" declares a SECRET field/enum the note also violates.
    await store.upsertTagSchema("work", { fields: { priority: { type: "string", enum: ["hi", "lo"] } } });
    await store.upsertTagSchema("project-manhattan", { fields: { codeword: { type: "string", enum: ["fizzbuzz"] } } });
    const note = await store.createNote("co-tagged", {
      path: "CoTagged",
      tags: ["work", "project-manhattan"],
      metadata: { priority: "URGENT", codeword: "leaked" },
    });

    const tools = generateScopedMcpTools(vaultName, authForTags(["work"]) as any);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: note.id }) as any;

    // The out-of-scope tag's SCHEMA SHAPE — the leak fix 3 introduced and
    // this scrub closes — must appear nowhere in the whole response.
    // `fizzbuzz` (its enum value) exists ONLY in project-manhattan's schema,
    // so its total absence proves no schema-shape leak. (`codeword` is also
    // a key in the note's OWN metadata, visible to anyone who can read the
    // note, so it's not a schema-shape indicator.)
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("fizzbuzz");
    // The tag NAME must be gone from validation_status specifically. NOTE:
    // it still appears in the note's `.tags` array — that's PRE-EXISTING
    // scoped-read behavior (noteWithinTagScope has never scrubbed a returned
    // note's tag set), independent of fix 3, and out of scope for this fix.
    expect(JSON.stringify(result.validation_status)).not.toContain("project-manhattan");

    // The in-scope tag's own warning DOES survive.
    const vs = result.validation_status;
    expect(vs).toBeTruthy();
    expect(vs.schemas).toEqual(["work"]);
    expect(vs.warnings).toHaveLength(1);
    expect(vs.warnings[0].schema).toBe("work");
    expect(vs.warnings[0].field).toBe("priority");

    closeAllStores();
  });

  test("UNSCOPED query-notes still surfaces BOTH co-tags' validation_status (regression)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-vs-unscoped-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.upsertTagSchema("work", { fields: { priority: { type: "string", enum: ["hi", "lo"] } } });
    await store.upsertTagSchema("project-manhattan", { fields: { codeword: { type: "string", enum: ["fizzbuzz"] } } });
    const note = await store.createNote("co-tagged", {
      path: "CoTagged",
      tags: ["work", "project-manhattan"],
      metadata: { priority: "URGENT", codeword: "leaked" },
    });

    const tools = generateScopedMcpTools(vaultName); // unscoped
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = await query.execute({ id: note.id }) as any;
    const vs = result.validation_status;
    expect(vs.schemas.sort()).toEqual(["project-manhattan", "work"]);
    expect(vs.warnings).toHaveLength(2);

    closeAllStores();
  });

  // vault#555 auth-review CRITICAL: `if_exists` must NOT let a scoped MCP
  // session read/update/replace an out-of-scope note by naming its path.
  // The create-note wrapper pre-resolves the path and throws path_conflict on
  // an out-of-scope hit (byte-identical to a genuine conflict). Each assertion
  // MUST fail without the wrapper guard.
  test('scoped create-note if_exists:"ignore" does NOT return an out-of-scope note (throws path_conflict)', async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-ifexists-ignore-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.createNote("SECRET MCP PAYLOAD", { path: "Secret", tags: ["personal"] });

    const tools = generateScopedMcpTools(vaultName, authForTags(["work"]) as any);
    const create = tools.find((t) => t.name === "create-note")!;
    // in-scope incoming tag passes the item-tag pre-check; the OUT-OF-SCOPE
    // existing note at this path must still be blocked.
    await expect(
      create.execute({ content: "attempted read", path: "Secret", tags: ["work"], if_exists: "ignore" }),
    ).rejects.toThrow(/path_conflict/);

    closeAllStores();
  });

  test('scoped create-note if_exists:"update"/"replace" does NOT mutate an out-of-scope note', async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-ifexists-mutate-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    const secret = await store.createNote("ORIGINAL SECRET", { path: "Secret", tags: ["personal"], metadata: { keep: "me" } });

    const tools = generateScopedMcpTools(vaultName, authForTags(["work"]) as any);
    const create = tools.find((t) => t.name === "create-note")!;

    await expect(
      create.execute({ content: "OVERWRITE", path: "Secret", tags: ["work"], metadata: { injected: true }, if_exists: "update" }),
    ).rejects.toThrow(/path_conflict/);
    await expect(
      create.execute({ content: "REPLACE", path: "Secret", tags: ["work"], if_exists: "replace" }),
    ).rejects.toThrow(/path_conflict/);

    // Ground truth: the out-of-scope note is untouched by both attempts.
    const onDisk = (await store.getNote(secret.id))!;
    expect(onDisk.content).toBe("ORIGINAL SECRET");
    expect(onDisk.metadata).toEqual({ keep: "me" });
    expect(onDisk.tags).toEqual(["personal"]);

    closeAllStores();
  });

  test("scoped create-note if_exists against an IN-scope note works normally (guard doesn't over-block)", async () => {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `tagscope-ifexists-inscope-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    const existing = await store.createNote("WORK BODY", { path: "MyWork", tags: ["work"] });

    const tools = generateScopedMcpTools(vaultName, authForTags(["work"]) as any);
    const create = tools.find((t) => t.name === "create-note")!;
    const result = await create.execute({ content: "x", path: "MyWork", tags: ["work"], if_exists: "ignore" }) as any;
    expect(result.existed).toBe(true);
    expect(result.id).toBe(existing.id);
    expect(result.content).toBe("WORK BODY");

    closeAllStores();
  });

  // vault#555 auth-review CRITICAL (RACE PATH — the incomplete-first-fix gap).
  // The wrapper pre-check + core's proactive getNoteByPath can BOTH miss a note
  // that a concurrent writer INSERTs, after which core's race backstop
  // re-resolves the (now-existing, out-of-scope) winner and calls
  // applyExistingNote on it. Without the in-core `ifExistsVisible` guard the
  // out-of-scope content leaks / the note is mutated. We reproduce the exact
  // TOCTOU by monkeypatching store.createNote to (a) create the out-of-scope
  // note itself (simulating the concurrent winner) and (b) throw
  // PathConflictError — driving execution straight into the backstop. Both
  // assertions MUST fail without the in-core guard.
  async function raceVault(mode: "ignore" | "update" | "replace") {
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");
    const { PathConflictError } = await import("../core/src/notes.ts");

    const vaultName = `tagscope-ifexists-race-${mode}-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);

    // Monkeypatch createNote so the target path is created by a "concurrent
    // writer" with an OUT-OF-SCOPE tag, then the real INSERT loses the race.
    const origCreate = store.createNote.bind(store);
    let raced = false;
    (store as any).createNote = async (content: string, opts: any) => {
      if (opts?.path === "Secret" && !raced) {
        raced = true;
        await origCreate("TOP SECRET RACE PAYLOAD", { path: "Secret", tags: ["personal"] });
        throw new PathConflictError("Secret");
      }
      return origCreate(content, opts);
    };

    const tools = generateScopedMcpTools(vaultName, authForTags(["work"]) as any);
    const create = tools.find((t) => t.name === "create-note")!;
    return { store, create, closeAllStores };
  }

  test('scoped create-note if_exists:"ignore" RACE backstop does NOT leak out-of-scope content', async () => {
    const { store, create, closeAllStores } = await raceVault("ignore");
    await expect(
      create.execute({ content: "attempted", path: "Secret", tags: ["work"], if_exists: "ignore" }),
    ).rejects.toThrow(/path_conflict/);
    // The concurrently-created out-of-scope note is byte-unchanged and its
    // payload never reached the caller (the throw carries only the path).
    const onDisk = (await store.getNoteByPath("Secret"))!;
    expect(onDisk.content).toBe("TOP SECRET RACE PAYLOAD");
    expect(onDisk.tags).toEqual(["personal"]);
    closeAllStores();
  });

  test('scoped create-note if_exists:"update" RACE backstop does NOT mutate the out-of-scope note', async () => {
    const { store, create, closeAllStores } = await raceVault("update");
    await expect(
      create.execute({ content: "OVERWRITE", path: "Secret", tags: ["work"], metadata: { injected: true }, if_exists: "update" }),
    ).rejects.toThrow(/path_conflict/);
    const onDisk = (await store.getNoteByPath("Secret"))!;
    expect(onDisk.content).toBe("TOP SECRET RACE PAYLOAD"); // unmutated
    expect(onDisk.metadata ?? {}).toEqual({});
    expect(onDisk.tags).toEqual(["personal"]);
    closeAllStores();
  });

  test('scoped create-note if_exists:"replace" RACE backstop does NOT mutate the out-of-scope note', async () => {
    const { store, create, closeAllStores } = await raceVault("replace");
    await expect(
      create.execute({ content: "REPLACE", path: "Secret", tags: ["work"], if_exists: "replace" }),
    ).rejects.toThrow(/path_conflict/);
    const onDisk = (await store.getNoteByPath("Secret"))!;
    expect(onDisk.content).toBe("TOP SECRET RACE PAYLOAD"); // unmutated
    expect(onDisk.tags).toEqual(["personal"]);
    closeAllStores();
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

  // ---- search path honors the `expand` axis (vault tag `expand` axis) ----
  //
  // Corpus: all three notes share the FTS term "fox". Tags separate the two
  // axes — `person` is a declared subtype of `entity` (parent_names) but NOT
  // name-prefixed; `entity/archived` is name-prefixed but NOT a subtype. So
  // search(tag=entity) returns DIFFERENT sets per `expand` mode, proving the
  // search branch threads it (regression for the "validated then dropped" bug).
  async function seedSearchAxisCorpus() {
    await store.upsertTagRecord("entity", { description: "entity root" });
    await store.upsertTagRecord("person", { parent_names: ["entity"] });
    await store.upsertTagRecord("entity/archived", {});
    await store.createNote("fox literal", { tags: ["entity"], path: "s-entity" });
    await store.createNote("fox subtype", { tags: ["person"], path: "s-person" });
    await store.createNote("fox filed", { tags: ["entity/archived"], path: "s-archived" });
  }

  test("GET /notes?search=fox&tag=entity — absent expand ≡ subtypes (descendants, no namespaced sibling)", async () => {
    await seedSearchAxisCorpus();
    const absent = await (await handleNotes(mkReq("GET", "/notes?search=fox&tag=entity&include_content=true"), store, "")).json() as any[];
    const sub = await (await handleNotes(mkReq("GET", "/notes?search=fox&tag=entity&expand=subtypes&include_content=true"), store, "")).json() as any[];
    const absentSet = new Set(absent.map((n) => n.content));
    expect(new Set(sub.map((n) => n.content))).toEqual(absentSet);
    // entity (literal) + person (subtype); NOT entity/archived.
    expect(absentSet).toEqual(new Set(["fox literal", "fox subtype"]));
  });

  test("GET /notes?search=fox&tag=entity&expand=namespace — lexical tag/* only, NOT subtype sibling", async () => {
    await seedSearchAxisCorpus();
    const res = await handleNotes(mkReq("GET", "/notes?search=fox&tag=entity&expand=namespace&include_content=true"), store, "");
    const body = await res.json() as any[];
    // entity (literal) + entity/archived (name-prefixed); NOT person (subtype).
    expect(new Set(body.map((n) => n.content))).toEqual(new Set(["fox literal", "fox filed"]));
  });

  test("GET /notes?search=fox&tag=entity&expand=exact — literal tag only", async () => {
    await seedSearchAxisCorpus();
    const res = await handleNotes(mkReq("GET", "/notes?search=fox&tag=entity&expand=exact&include_content=true"), store, "");
    const body = await res.json() as any[];
    expect(body.map((n) => n.content)).toEqual(["fox literal"]);
  });

  test("GET /notes?search=...&expand=bogus → 400 INVALID_QUERY (search branch validates too)", async () => {
    await store.createNote("fox here");
    const res = await handleNotes(mkReq("GET", "/notes?search=fox&expand=bogus"), store, "");
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe("INVALID_QUERY");
    expect(body.error).toContain("expand");
  });

  test("GET /notes?has_tags=false returns only untagged notes", async () => {
    await store.createNote("tagged", { tags: ["x"], path: "t" });
    await store.createNote("plain", { path: "p" });
    const res = await handleNotes(mkReq("GET", "/notes?has_tags=false&include_content=true"), store, "");
    const body = await res.json() as any[];
    expect(body.map((n) => n.content)).toEqual(["plain"]);
  });

  // ---- updated_at filter via bracket date (vault#285 friction point 1.5) ----
  //
  // HTTP plumbing routes `meta[updated_at][gte]=…` straight to the core
  // `dateFilter` resolver, which recognizes `updated_at` as a real column.
  // Smoke-tests the end-to-end HTTP path; the engine-side semantics are
  // exercised in core.test.ts. (The flat `date_field=updated_at&date_from=…`
  // shape was removed in 0.6.4 — vault#288 — bracket-style is the only
  // query-string date filter.)
  test("GET /notes?meta[updated_at][gte]=… filters by last-write time", async () => {
    const a = await store.createNote("untouched", { id: "ua", path: "ua" });
    const b = await store.createNote("modified", { id: "ub", path: "ub" });
    // Bump b's updated_at into the test window, leave a's at its createdAt.
    // Pin BOTH `updated_at` and `updated_at_ms` — mirrors production
    // (vault#586: every real write keeps them in lockstep) — the vault#585
    // fix compares the ms mirror, not the TEXT column.
    db.prepare("UPDATE notes SET updated_at = ?, updated_at_ms = ? WHERE id = ?")
      .run("2026-01-15T00:00:00.000Z", Date.parse("2026-01-15T00:00:00.000Z"), a.id);
    db.prepare("UPDATE notes SET updated_at = ?, updated_at_ms = ? WHERE id = ?")
      .run("2026-04-25T00:00:00.000Z", Date.parse("2026-04-25T00:00:00.000Z"), b.id);

    const res = await handleNotes(
      mkReq("GET", "/notes?meta[updated_at][gte]=2026-04-01&include_content=true"),
      store,
      "",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body.map((n) => n.content)).toEqual(["modified"]);
  });

  // ---- Cursor pagination (vault#313) ----
  //
  // Opaque cursors for since-last-checked agent loops. The full engine
  // semantics live in core.test.ts; these tests pin the HTTP plumbing:
  // wrapped {notes, next_cursor} envelope when ?cursor= is set, structured
  // 400s on bad cursor, and end-to-end resume across calls.
  test("GET /notes?cursor=... returns {notes, next_cursor} envelope", async () => {
    await store.createNote("a", { id: "cur-rest-a" });
    await store.createNote("b", { id: "cur-rest-b" });
    db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
      .run("2026-04-01T00:00:00.000Z", "cur-rest-a");
    db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
      .run("2026-04-02T00:00:00.000Z", "cur-rest-b");

    // Mint a starting cursor via the store (we don't expose a "first cursor"
    // endpoint — the first call's response carries the cursor). Simulate
    // the first call by querying without a cursor and reading
    // next_cursor from a follow-up call shape.
    const seed = await store.queryNotesPaged({});
    const cursor = seed.next_cursor;

    // No new writes after seed → second call is empty but still returns
    // an envelope.
    const res = await handleNotes(
      mkReq("GET", `/notes?cursor=${encodeURIComponent(cursor)}`),
      store,
      "",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toHaveProperty("notes");
    expect(body).toHaveProperty("next_cursor");
    expect(Array.isArray(body.notes)).toBe(true);
    expect(body.notes).toHaveLength(0);
    expect(typeof body.next_cursor).toBe("string");
  });

  test("GET /notes (no cursor) returns legacy flat-array shape", async () => {
    await store.createNote("a", { id: "noCur-a" });
    const res = await handleNotes(mkReq("GET", "/notes"), store, "");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /notes?cursor=<stale> returns 400 cursor_query_mismatch", async () => {
    await store.createNote("a", { tags: ["x"], id: "cm-a" });
    await store.createNote("b", { tags: ["y"], id: "cm-b" });
    const seed = await store.queryNotesPaged({ tags: ["x"] });

    // Reuse on a different tag — engine raises cursor_query_mismatch.
    const res = await handleNotes(
      mkReq("GET", `/notes?tag=y&cursor=${encodeURIComponent(seed.next_cursor)}`),
      store,
      "",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe("cursor_query_mismatch");
  });

  test("GET /notes?cursor=<garbage> returns 400 cursor_invalid", async () => {
    const res = await handleNotes(
      mkReq("GET", `/notes?cursor=not-a-real-cursor`),
      store,
      "",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe("cursor_invalid");
  });

  test("GET /notes?cursor=...&near[note_id]=x rejects with INVALID_QUERY", async () => {
    const a = await store.createNote("anchor", { id: "n1" });
    const seed = await store.queryNotesPaged({});
    const res = await handleNotes(
      mkReq("GET", `/notes?cursor=${encodeURIComponent(seed.next_cursor)}&near[note_id]=${a.id}`),
      store,
      "",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe("INVALID_QUERY");
  });

  test("GET /notes?cursor=...&search=... rejects with INVALID_QUERY (vault#355 reviewer)", async () => {
    // REST used to silently drop the cursor and route into the FTS branch.
    // MCP rejects this combo explicitly at core/src/mcp.ts — REST now does
    // the same. Surface parity, no silent corruption.
    await store.createNote("the quick brown fox", { id: "s1" });
    const seed = await store.queryNotesPaged({});
    const res = await handleNotes(
      mkReq("GET", `/notes?cursor=${encodeURIComponent(seed.next_cursor)}&search=fox`),
      store,
      "",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe("INVALID_QUERY");
  });

  test("GET /notes?cursor=...&sort=desc rejects with INVALID_QUERY", async () => {
    // Descending iteration with a watermark cursor would skip newly-written
    // rows. queryNotesPaged surfaces this as a QueryError; the REST handler
    // catches and translates to 400. Asserts the surface parity with MCP
    // even though the guard sits at the core layer.
    await store.createNote("a", { id: "sd-a" });
    const seed = await store.queryNotesPaged({});
    const res = await handleNotes(
      mkReq("GET", `/notes?cursor=${encodeURIComponent(seed.next_cursor)}&sort=desc`),
      store,
      "",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe("INVALID_QUERY");
  });

  test("GET /notes?cursor=...&order_by=... rejects with INVALID_QUERY", async () => {
    // Cursor pagination forces order by updated_at; order_by is mutually
    // exclusive. Same surface-parity assertion as the sort=desc test.
    await store.createNote("a", { id: "ob-a" });
    const seed = await store.queryNotesPaged({});
    const res = await handleNotes(
      mkReq("GET", `/notes?cursor=${encodeURIComponent(seed.next_cursor)}&order_by=created_at`),
      store,
      "",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe("INVALID_QUERY");
  });

  test("GET /notes?search=fox (without cursor) still works after the cursor+search guard", async () => {
    // Sanity check: the cursor+search guard must not regress plain FTS.
    await store.createNote("the quick brown fox", { id: "ss-a" });
    const res = await handleNotes(mkReq("GET", "/notes?search=fox"), store, "");
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("ss-a");
  });

  test("GET /notes?cursor=... resumes correctly across calls (end-to-end)", async () => {
    // Three notes spread across distinct updated_at watermarks. First
    // call returns the first batch, second call (with cursor) returns
    // only the note written after the cursor was minted.
    const a = await store.createNote("first", { id: "e2e-a" });
    db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
      .run("2026-04-01T00:00:00.000Z", a.id);
    const b = await store.createNote("second", { id: "e2e-b" });
    db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
      .run("2026-04-02T00:00:00.000Z", b.id);

    const seed = await store.queryNotesPaged({});
    expect(seed.notes.map((n) => n.id).sort()).toEqual(["e2e-a", "e2e-b"]);

    // Write a third note that lands AFTER the cursor's watermark.
    const c = await store.createNote("third", { id: "e2e-c" });
    db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
      .run("2026-04-03T00:00:00.000Z", c.id);

    const res = await handleNotes(
      mkReq("GET", `/notes?cursor=${encodeURIComponent(seed.next_cursor)}&include_content=true`),
      store,
      "",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.notes.map((n: any) => n.id)).toEqual(["e2e-c"]);
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

  // ---- Title-fallback resolution (additive — id/path/basename still win first) ----

  test("GET /notes/:idOrPath resolves via H1 title when id and path both miss", async () => {
    await store.createNote("# My Great Note\n\nBody.", { path: "Inbox/2026-07-10-xyz" });
    const enc = encodeURIComponent("My Great Note");
    const res = await handleNotes(mkReq("GET", `/notes/${enc}`), store, `/${enc}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.path).toBe("Inbox/2026-07-10-xyz");
  });

  test("GET /notes/:idOrPath exact path still wins over a same-named title on another note", async () => {
    const byPath = await store.createNote("Path note", { path: "My Great Note" });
    await store.createNote("# My Great Note\n\nOther body.", { path: "Inbox/other" });
    const enc = encodeURIComponent("My Great Note");
    const res = await handleNotes(mkReq("GET", `/notes/${enc}`), store, `/${enc}`);
    const body = await res.json() as any;
    expect(body.id).toBe(byPath.id);
    expect(body.content).toBe("Path note");
  });

  test("GET /notes/:idOrPath stays 404 when 2+ notes share the same H1 title", async () => {
    await store.createNote("# Dup Note\n\nA.", { path: "Inbox/dup-a" });
    await store.createNote("# Dup Note\n\nB.", { path: "Inbox/dup-b" });
    const enc = encodeURIComponent("Dup Note");
    const res = await handleNotes(mkReq("GET", `/notes/${enc}`), store, `/${enc}`);
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error_type).toBe("not_found");
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

  // vault#316 — the HTTP POST path re-reads each note AFTER
  // `applySchemaDefaults`, so the response metadata carries the just-written
  // defaults (mirrors the MCP create-note path). Before the fix the response
  // mapped over the pre-defaults in-memory objects, so default-filled
  // metadata was missing from `POST /api/notes` responses.
  test("POST /notes response reflects post-applySchemaDefaults state (vault#316)", async () => {
    // vault#553 Decision B: backfill is explicit-`default`-only — declare one
    // so this test still exercises the post-defaults re-read mechanism.
    await store.upsertTagSchema("task", {
      fields: { priority: { type: "string", enum: ["high", "low"], default: "high" } },
    });

    // Single: default lands in the returned metadata and agrees with disk.
    const single = await handleNotes(
      mkReq("POST", "/notes", { content: "do the thing", path: "Inbox/task-1", tags: ["task"] }),
      store,
      "",
    );
    expect(single.status).toBe(201);
    const singleBody = await single.json() as any;
    expect(singleBody.metadata?.priority).toBe("high"); // explicit schema default
    const onDisk = await store.getNoteByPath("Inbox/task-1");
    expect((onDisk!.metadata as any)?.priority).toBe("high");

    // Batch: each entry is re-read post-defaults too, in input order.
    const batch = await handleNotes(
      mkReq("POST", "/notes", {
        notes: [
          { content: "a", path: "Inbox/task-2", tags: ["task"] },
          { content: "b", path: "Inbox/task-3", tags: ["task"] },
        ],
      }),
      store,
      "",
    );
    expect(batch.status).toBe(201);
    const batchBody = await batch.json() as any[];
    expect(batchBody.map((n) => n.path)).toEqual(["Inbox/task-2", "Inbox/task-3"]);
    expect(batchBody[0].metadata?.priority).toBe("high");
    expect(batchBody[1].metadata?.priority).toBe("high");
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

  // FIX 2 (vault#589) — a note path with a NUL byte or a `..` segment is
  // rejected at the write surface (400 invalid_path), never persisted. A
  // NUL-in-path note otherwise slips the export traversal guard and then
  // aborts the entire vault export; a `..` note is silently un-round-trippable.
  test("POST /notes rejects a NUL-byte path with 400 invalid_path (not 201)", async () => {
    const NUL = String.fromCharCode(0);
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "x", path: `bad${NUL}path` }),
      store,
      "",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("invalid_path");
    // Nothing was written.
    expect(await store.getNoteByPath("bad")).toBeNull();
  });

  test("POST /notes rejects a '..' path with 400 invalid_path", async () => {
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "x", path: "../escape" }),
      store,
      "",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("invalid_path");
  });

  test("POST /notes still accepts a legitimate path with dots (regression)", async () => {
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "ok", path: "Projects/v1.2/notes" }),
      store,
      "",
    );
    expect(res.status).toBeLessThan(400);
    const body = await res.json() as any;
    expect(body.path).toBe("Projects/v1.2/notes");
  });

  test("PATCH /notes/:id rejects a '..' path with 400 invalid_path", async () => {
    const note = await store.createNote("hi", { id: "path-bad", path: "p" });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/path-bad", {
        path: "../../etc/passwd",
        if_updated_at: note.updatedAt,
      }),
      store,
      "/path-bad",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("invalid_path");
    // The note's original path is untouched.
    expect((await store.getNote("path-bad"))!.path).toBe("p");
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
    test("`meta[created_at][gte]=…` routes to dateFilter", async () => {
      await store.createNote("old", { created_at: "2026-01-15T00:00:00.000Z" });
      await store.createNote("new", { created_at: "2026-04-15T00:00:00.000Z" });

      const bracketRes = await handleNotes(
        mkReq("GET", "/notes?meta[created_at][gte]=2026-04-01&include_content=true"),
        store,
        "",
      );
      const bracketBody = await bracketRes.json() as any[];
      expect(bracketBody.map((n) => n.content)).toEqual(["new"]);
    });

    // ---- Removed: flat date params are now ignored (vault#288, breaking) ----
    // The flat `date_field` / `date_from` / `date_to` query params were
    // removed in 0.6.4. A request that passes ONLY the flat shape is no
    // longer date-filtered — it comes back unfiltered. Use bracket-style
    // (`meta[created_at][gte]=…`) instead. (The MCP `date_from`/`date_to`
    // shorthand is a separate, supported path and is unaffected.)
    test("flat date params (date_field/date_from/date_to) are ignored", async () => {
      await store.createNote("old", { created_at: "2026-01-15T00:00:00.000Z" });
      await store.createNote("new", { created_at: "2026-04-15T00:00:00.000Z" });

      const targetedRes = await handleNotes(
        mkReq("GET", "/notes?date_field=created_at&date_from=2026-04-01&include_content=true"),
        store,
        "",
      );
      const targetedBody = await targetedRes.json() as any[];
      expect(targetedRes.status).toBe(200);
      // Both notes returned — the flat param did not filter.
      expect(targetedBody.map((n) => n.content).sort()).toEqual(["new", "old"]);

      const bareRes = await handleNotes(
        mkReq("GET", "/notes?date_from=2026-04-01&include_content=true"),
        store,
        "",
      );
      const bareBody = await bareRes.json() as any[];
      expect(bareRes.status).toBe(200);
      expect(bareBody.map((n) => n.content).sort()).toEqual(["new", "old"]);
    });

    test("`meta[updated_at][gte]=…` routes to dateFilter on n.updated_at", async () => {
      const a = await store.createNote("untouched");
      const b = await store.createNote("modified");
      // Pin BOTH columns (vault#585/#586 — see the identical note above).
      db.prepare("UPDATE notes SET updated_at = ?, updated_at_ms = ? WHERE id = ?")
        .run("2026-01-15T00:00:00.000Z", Date.parse("2026-01-15T00:00:00.000Z"), a.id);
      db.prepare("UPDATE notes SET updated_at = ?, updated_at_ms = ? WHERE id = ?")
        .run("2026-04-25T00:00:00.000Z", Date.parse("2026-04-25T00:00:00.000Z"), b.id);
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

    // ---- Bracket applies; co-passed flat params are ignored (vault#288) ----
    test("bracket date filter applies even when removed flat params are also passed", async () => {
      await store.createNote("old", { created_at: "2026-01-15T00:00:00.000Z" });
      await store.createNote("new", { created_at: "2026-04-15T00:00:00.000Z" });
      // Bracket says "from 2026-04-01"; the (removed) flat params say "from
      // 2020-01-01". The flat params are now inert, so only the bracket
      // filter applies — back comes only the post-April note. (Pre-0.6.4
      // this exercised bracket-wins precedence; flat is now simply ignored.)
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

    // ---- JSON `metadata=<json>` alias (symmetric with the MCP nested obj) ----
    //
    // Before this alias, a `?metadata={...}` param was silently dropped: the
    // bracket grammar never matched it, `queryOpts.metadata` stayed undefined,
    // and the query returned ALL tag-matching notes — a silent wrong result.

    test("alias `metadata={field:{op:value}}` filters on an indexed field", async () => {
      await declareIndexed();
      await store.createNote("open-1", { metadata: { status: "open" } });
      await store.createNote("open-2", { metadata: { status: "open" } });
      await store.createNote("closed", { metadata: { status: "closed" } });
      const q = encodeURIComponent(JSON.stringify({ status: { eq: "open" } }));
      const res = await handleNotes(
        mkReq("GET", `/notes?metadata=${q}&include_content=true`),
        store,
        "",
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any[];
      expect(body.map((n) => n.content).sort()).toEqual(["open-1", "open-2"]);
    });

    test("alias shorthand equality `metadata={field:value}` works via json_extract fallback", async () => {
      // No declareIndexed — shorthand routes through the engine's json_extract
      // exact-match path, no indexed declaration required.
      await store.createNote("matches", { metadata: { status: "open" } });
      await store.createNote("other", { metadata: { status: "closed" } });
      const q = encodeURIComponent(JSON.stringify({ status: "open" }));
      const res = await handleNotes(
        mkReq("GET", `/notes?metadata=${q}&include_content=true`),
        store,
        "",
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any[];
      expect(body.map((n) => n.content)).toEqual(["matches"]);
    });

    test("alias and bracket form return identical results for the same indexed-field operator query", async () => {
      await declareIndexed();
      for (const p of [1, 2, 3, 4, 5]) {
        await store.createNote(`p${p}`, { metadata: { priority: p } });
      }
      // JSON preserves the real number type 3; bracket form passes "3" as a
      // string. Both must coerce to the same range result against the INTEGER
      // indexed column — this guards the type-coercion edge.
      const aliasQ = encodeURIComponent(JSON.stringify({ priority: { gte: 3 } }));
      const aliasRes = await handleNotes(
        mkReq("GET", `/notes?metadata=${aliasQ}&include_content=true`),
        store,
        "",
      );
      const bracketRes = await handleNotes(
        mkReq("GET", "/notes?meta[priority][gte]=3&include_content=true"),
        store,
        "",
      );
      const aliasBody = await aliasRes.json() as any[];
      const bracketBody = await bracketRes.json() as any[];
      expect(aliasBody.map((n) => n.content).sort()).toEqual(["p3", "p4", "p5"]);
      expect(aliasBody.map((n) => n.content).sort()).toEqual(
        bracketBody.map((n) => n.content).sort(),
      );
    });

    test("malformed JSON in `metadata=` rejects with 400 INVALID_QUERY", async () => {
      const res = await handleNotes(
        mkReq("GET", "/notes?metadata=" + encodeURIComponent("{not json")),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("INVALID_QUERY");
      expect(body.error).toContain("JSON object");
    });

    test("non-object `metadata=` JSON (array) rejects with 400 INVALID_QUERY", async () => {
      const res = await handleNotes(
        mkReq("GET", "/notes?metadata=" + encodeURIComponent(JSON.stringify(["status"]))),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("INVALID_QUERY");
    });

    test("primitive-scalar `metadata=` JSON (number / bare string) rejects with 400 INVALID_QUERY", async () => {
      // `metadata=42` and `metadata="open"` are valid JSON but not objects —
      // both fall through the non-object branch.
      for (const raw of ["42", JSON.stringify("open")]) {
        const res = await handleNotes(
          mkReq("GET", "/notes?metadata=" + encodeURIComponent(raw)),
          store,
          "",
        );
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.code).toBe("INVALID_QUERY");
      }
    });

    test("empty-object alias `metadata={}` is treated as absent and composes with a bracket filter", async () => {
      // `{}` carries no filter intent — it must neither set a metadata filter
      // NOR trip the both-forms 400 guard. So `metadata={}` + a bracket
      // metadata filter is a 200 filtered by the bracket form only.
      await declareIndexed();
      await store.createNote("hi", { metadata: { priority: 5 } });
      await store.createNote("lo", { metadata: { priority: 1 } });
      const res = await handleNotes(
        mkReq("GET", "/notes?metadata=" + encodeURIComponent("{}") + "&meta[priority][gte]=3&include_content=true"),
        store,
        "",
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any[];
      expect(body.map((n) => n.content)).toEqual(["hi"]);
    });

    test("both `metadata=` alias AND `meta[...]` bracket params present rejects with 400 INVALID_QUERY", async () => {
      await declareIndexed();
      const q = encodeURIComponent(JSON.stringify({ status: { eq: "open" } }));
      const res = await handleNotes(
        mkReq("GET", `/notes?metadata=${q}&meta[priority][gte]=3`),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("INVALID_QUERY");
      expect(body.error).toContain("not both");
    });

    test("regression: previously-silently-dropped `?metadata={status:{eq:pending}}` now actually filters", async () => {
      await declareIndexed();
      await store.createNote("pending-1", { metadata: { status: "pending" } });
      await store.createNote("pending-2", { metadata: { status: "pending" } });
      await store.createNote("done", { metadata: { status: "done" } });
      const q = encodeURIComponent(JSON.stringify({ status: { eq: "pending" } }));
      const res = await handleNotes(
        mkReq("GET", `/notes?metadata=${q}&include_content=true`),
        store,
        "",
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any[];
      // Before the fix this returned ALL three notes (filter dropped). Now it
      // returns only the two pending ones.
      expect(body.map((n) => n.content).sort()).toEqual(["pending-1", "pending-2"]);
    });

    test("alias with an unknown operator surfaces the engine's 400 UNKNOWN_OPERATOR", async () => {
      await declareIndexed();
      const q = encodeURIComponent(JSON.stringify({ priority: { bogus: 5 } }));
      const res = await handleNotes(
        mkReq("GET", `/notes?metadata=${q}`),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.code).toBe("UNKNOWN_OPERATOR");
    });
  });

  // -------------------------------------------------------------------------
  // POST /notes/:id/retry-transcription — vault#353 design Q5.
  //
  // The endpoint re-enqueues a failed transcript by flipping the matching
  // attachment back to `transcribe_status: pending`. The worker (or sweep)
  // picks it up. These tests exercise the request shape + error branches;
  // the actual re-transcription is covered in transcription-worker.test.ts's
  // auto-origin section.
  // -------------------------------------------------------------------------
  describe("POST /notes/:id/retry-transcription", async () => {
    async function seedFailedTranscript(opts: {
      audioPath?: string;
      noteId?: string;
      transcriptId?: string;
      omitAttachmentId?: boolean;
    } = {}): Promise<{ owner: { id: string }; attachmentId: string; transcriptId: string; audioPath: string }> {
      const audioPath = opts.audioPath ?? `${opts.noteId ?? "src"}/voice.webm`;
      const ownerId = opts.noteId ?? "src-note";
      const owner = await store.createNote("# Voice\n", { id: ownerId });
      const att = await store.addAttachment(owner.id, audioPath, "audio/webm", {
        transcribe_status: "failed",
        transcribe_origin: "auto",
        transcribe_error: "no transcription provider configured",
      });
      // Seed the failed transcript note exactly as the worker would have.
      const transcriptMeta: Record<string, unknown> = {
        transcript_of: audioPath,
        transcript_status: "failed",
        transcript_error: "missing_provider: no transcription provider configured",
      };
      if (!opts.omitAttachmentId) transcriptMeta.transcript_attachment_id = att.id;
      await store.createNote("", {
        id: opts.transcriptId ?? "transcript-1",
        path: `${audioPath}.transcript`,
        tags: ["transcript", "capture"],
        metadata: transcriptMeta,
      });
      // Audio file present on disk so the retry doesn't 404 on audio_missing.
      const assetsRoot = join(tmpDir, "assets");
      mkdirSync(join(assetsRoot, audioPath.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(assetsRoot, audioPath), Buffer.from([1, 2, 3]));
      process.env.ASSETS_DIR = assetsRoot;
      return { owner: { id: ownerId }, attachmentId: att.id, transcriptId: opts.transcriptId ?? "transcript-1", audioPath };
    }

    test("happy path: flips attachment to pending and returns 202", async () => {
      const { attachmentId, transcriptId } = await seedFailedTranscript();
      const res = await handleNotes(
        mkReq("POST", `/notes/${transcriptId}/retry-transcription`),
        store,
        `/${transcriptId}/retry-transcription`,
        "default",
      );
      expect(res.status).toBe(202);
      const body = await res.json() as any;
      expect(body.status).toBe("queued");
      expect(body.attachment_id).toBe(attachmentId);
      expect(body.transcript_note_id).toBe(transcriptId);

      // Attachment metadata reset.
      const att = await store.getAttachment(attachmentId);
      expect(att?.metadata?.transcribe_status).toBe("pending");
      expect(att?.metadata?.transcribe_origin).toBe("auto");
      // Stale failure state cleared.
      expect(att?.metadata?.transcribe_error).toBeUndefined();
      expect(att?.metadata?.transcribe_attempts).toBeUndefined();

      delete process.env.ASSETS_DIR;
    });

    test("404 when transcript note doesn't exist", async () => {
      const res = await handleNotes(
        mkReq("POST", "/notes/no-such-id/retry-transcription"),
        store,
        "/no-such-id/retry-transcription",
        "default",
      );
      expect(res.status).toBe(404);
    });

    test("400 no_failed_attachment when target is a regular note with no failed audio", async () => {
      // A note without `transcript_status` frontmatter is treated as a
      // possible legacy in-body memo (finding F). With no attachment carrying
      // a failed transcription there's nothing to retry → no_failed_attachment.
      await store.createNote("regular note", { id: "regular" });
      const res = await handleNotes(
        mkReq("POST", "/notes/regular/retry-transcription"),
        store,
        "/regular/retry-transcription",
        "default",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe("no_failed_attachment");
    });

    test("400 not_failed when transcript already succeeded", async () => {
      const audioPath = "memo/done.webm";
      const owner = await store.createNote("voice", { id: "src-done" });
      const att = await store.addAttachment(owner.id, audioPath, "audio/webm");
      await store.createNote("the spoken words", {
        id: "transcript-done",
        path: `${audioPath}.transcript`,
        metadata: {
          transcript_of: audioPath,
          transcript_attachment_id: att.id,
          transcript_status: "complete",
        },
      });
      const res = await handleNotes(
        mkReq("POST", "/notes/transcript-done/retry-transcription"),
        store,
        "/transcript-done/retry-transcription",
        "default",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe("not_failed");
      expect(body.transcript_status).toBe("complete");
    });

    test("400 missing_attachment_id when frontmatter lacks the id", async () => {
      await seedFailedTranscript({
        transcriptId: "transcript-no-id",
        noteId: "src-no-id",
        omitAttachmentId: true,
      });
      const res = await handleNotes(
        mkReq("POST", "/notes/transcript-no-id/retry-transcription"),
        store,
        "/transcript-no-id/retry-transcription",
        "default",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe("missing_attachment_id");
      delete process.env.ASSETS_DIR;
    });

    test("404 attachment_missing when the attachment row no longer exists", async () => {
      const owner = await store.createNote("voice", { id: "src-stale" });
      await store.createNote("", {
        id: "transcript-stale",
        path: "memo/stale.webm.transcript",
        metadata: {
          transcript_of: "memo/stale.webm",
          transcript_attachment_id: "deleted-attachment-id",
          transcript_status: "failed",
          transcript_error: "missing_provider",
        },
      });
      const res = await handleNotes(
        mkReq("POST", "/notes/transcript-stale/retry-transcription"),
        store,
        "/transcript-stale/retry-transcription",
        "default",
      );
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toBe("attachment_missing");
    });

    test("405 on GET (must POST)", async () => {
      await seedFailedTranscript({
        transcriptId: "transcript-405",
        noteId: "src-405",
        audioPath: "memo/405.webm",
      });
      const res = await handleNotes(
        mkReq("GET", "/notes/transcript-405/retry-transcription"),
        store,
        "/transcript-405/retry-transcription",
        "default",
      );
      expect(res.status).toBe(405);
      delete process.env.ASSETS_DIR;
    });

    // -----------------------------------------------------------------------
    // Legacy in-body memo retry (finding F). The target is the memo note
    // itself (no `transcript_status` frontmatter); it directly owns a failed
    // audio attachment. The request must reset the attachment preserving
    // `transcribe_origin: "legacy"` and re-arm `transcribe_stub: true` so the
    // worker's legacy success path will write the transcript back into the
    // body. End-to-end re-transcription is covered in
    // transcription-worker.test.ts.
    // -----------------------------------------------------------------------
    async function seedLegacyFailedMemo(opts: {
      noteId?: string;
      audioPath?: string;
      withFile?: boolean;
    } = {}): Promise<{ noteId: string; attachmentId: string; audioPath: string }> {
      const noteId = opts.noteId ?? "legacy-memo";
      const audioPath = opts.audioPath ?? `${noteId}/voice.webm`;
      // The capture body after a terminal failure: marker replaced the
      // placeholder, embed intact, stub cleared by the worker.
      const note = await store.createNote(
        `# 🎙️ Voice memo\n\n_Recorded sometime._\n\n_Transcription unavailable._\n\n![[${audioPath}]]\n`,
        { id: noteId },
      );
      const att = await store.addAttachment(note.id, audioPath, "audio/webm", {
        transcribe_status: "failed",
        // legacy origin is the default (undefined); leave it off to model the
        // genuine legacy capture shape.
        transcribe_error: "scribe down",
        transcribe_attempts: 3,
      });
      const assetsRoot = join(tmpDir, "assets");
      if (opts.withFile !== false) {
        mkdirSync(join(assetsRoot, audioPath.split("/").slice(0, -1).join("/")), { recursive: true });
        writeFileSync(join(assetsRoot, audioPath), Buffer.from([1, 2, 3]));
      }
      process.env.ASSETS_DIR = assetsRoot;
      return { noteId, attachmentId: att.id, audioPath };
    }

    test("legacy in-body memo: 202, resets attachment (legacy origin) + re-arms stub", async () => {
      const { noteId, attachmentId, audioPath } = await seedLegacyFailedMemo();
      const res = await handleNotes(
        mkReq("POST", `/notes/${noteId}/retry-transcription`),
        store,
        `/${noteId}/retry-transcription`,
        "default",
      );
      expect(res.status).toBe(202);
      const body = await res.json() as any;
      expect(body.status).toBe("queued");
      expect(body.attachment_id).toBe(attachmentId);
      expect(body.attachment_path).toBe(audioPath);
      expect(body.transcript_note_id).toBe(noteId);

      // Attachment reset to pending, legacy origin preserved (NOT flipped to
      // auto — that would orphan the in-body embed), failure state cleared.
      const att = await store.getAttachment(attachmentId);
      expect(att?.metadata?.transcribe_status).toBe("pending");
      expect(att?.metadata?.transcribe_origin).toBe("legacy");
      expect(att?.metadata?.transcribe_error).toBeUndefined();
      expect(att?.metadata?.transcribe_attempts).toBeUndefined();

      // Stub re-armed on the note — without this the worker's legacy success
      // path early-returns and never writes the transcript back.
      const updated = await store.getNote(noteId);
      expect((updated!.metadata as any)?.transcribe_stub).toBe(true);
      // Body untouched by the retry request itself (embed + marker intact).
      expect(updated!.content).toContain(`![[${audioPath}]]`);
      expect(updated!.content).toContain("_Transcription unavailable._");

      delete process.env.ASSETS_DIR;
    });

    test("legacy in-body memo: 404 audio_missing when the file is gone", async () => {
      const { noteId } = await seedLegacyFailedMemo({
        noteId: "legacy-gone",
        withFile: false,
      });
      const res = await handleNotes(
        mkReq("POST", `/notes/${noteId}/retry-transcription`),
        store,
        `/${noteId}/retry-transcription`,
        "default",
      );
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toBe("audio_missing");
      delete process.env.ASSETS_DIR;
    });

    test("legacy in-body memo: end-to-end retry round-trip (capture → fail → retry → success)", async () => {
      // Start from the CANONICAL capture body (recorder.ts memoNoteContent
      // shape): header + _Recorded_ + _Transcript pending._ + ![[embed]],
      // with transcribe_stub: true.
      const audioPath = "e2e/voice.webm";
      const captureBody =
        "# 🎙️ Voice memo\n\n_Recorded sometime._\n\n_Transcript pending._\n\n![[e2e/voice.webm]]\n";
      await store.createNote(captureBody, {
        id: "e2e-memo",
        metadata: { transcribe_stub: true },
      });
      const att = await store.addAttachment("e2e-memo", audioPath, "audio/webm", {
        transcribe_status: "pending",
        transcribe_attempts: 2, // one more failure flips to terminal at maxAttempts=3
      });
      const assetsRoot = join(tmpDir, "assets");
      mkdirSync(join(assetsRoot, "e2e"), { recursive: true });
      writeFileSync(join(assetsRoot, audioPath), Buffer.from([1, 2, 3]));
      process.env.ASSETS_DIR = assetsRoot;

      // What a first-try success would have produced (for the final assert).
      const firstTrySuccessBody =
        "# 🎙️ Voice memo\n\n_Recorded sometime._\n\nthe spoken words\n\n![[e2e/voice.webm]]\n";

      // --- Phase 1: terminal failure. Worker writes the marker in place,
      // preserving the embed, and clears the stub.
      let fetchMode: "fail" | "succeed" = "fail";
      const fetchImpl = (async () => {
        if (fetchMode === "fail") {
          return new Response("scribe down", { status: 500 });
        }
        return new Response(JSON.stringify({ text: "the spoken words" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const worker = startTranscriptionWorker({
        vaultList: () => ["default"],
        getStore: () => store as unknown as Store,
        scribeUrl: "http://scribe.test",
        resolveAssetsDir: () => process.env.ASSETS_DIR!,
        pollIntervalMs: 10_000_000,
        maxAttempts: 3,
        fetchImpl,
        logger: { error: () => {}, info: () => {} },
      });
      setTranscriptionWorker(worker);
      try {
        await worker.tick();

        const failedNote = await store.getNote("e2e-memo");
        // Marker replaced the placeholder in place; embed + surrounding body intact.
        expect(failedNote!.content).toBe(
          "# 🎙️ Voice memo\n\n_Recorded sometime._\n\n_Transcription unavailable._\n\n![[e2e/voice.webm]]\n",
        );
        expect((failedNote!.metadata as any)?.transcribe_stub).toBeUndefined();
        const failedAtt = await store.getAttachment(att.id);
        expect(failedAtt?.metadata?.transcribe_status).toBe("failed");

        // --- Phase 2: retry via the legacy route form (POST on the memo note).
        // Deregister the worker so the retry is "sweep-only" — that lets us
        // observe the reset + stub re-arm deterministically before the worker
        // picks the row back up (otherwise the route's fire-and-forget kick
        // would race our assertions and complete the success in-line).
        setTranscriptionWorker(null);
        fetchMode = "succeed";
        const retryRes = await handleNotes(
          mkReq("POST", "/notes/e2e-memo/retry-transcription"),
          store,
          "/e2e-memo/retry-transcription",
          "default",
        );
        expect(retryRes.status).toBe(202);
        expect((await retryRes.json() as any).worker).toBe("sweep-only");

        // Attachment back to pending + legacy origin; stub re-armed on the note.
        const pendingAtt = await store.getAttachment(att.id);
        expect(pendingAtt?.metadata?.transcribe_status).toBe("pending");
        expect(pendingAtt?.metadata?.transcribe_origin).toBe("legacy");
        const rearmed = await store.getNote("e2e-memo");
        expect((rearmed!.metadata as any)?.transcribe_stub).toBe(true);

        // --- Phase 3: worker succeeds on the retry (sweep tick). Transcript
        // replaces the _Transcription unavailable._ marker IN PLACE; embed
        // preserved; final body is byte-identical to a first-try success.
        setTranscriptionWorker(worker);
        await worker.tick();
        const success = await store.getNote("e2e-memo");
        expect(success!.content).toBe(firstTrySuccessBody);
        expect(success!.content).toContain("![[e2e/voice.webm]]");
        expect((success!.metadata as any)?.transcribe_stub).toBeUndefined();
        const doneAtt = await store.getAttachment(att.id);
        expect(doneAtt?.metadata?.transcribe_status).toBe("done");
        expect(doneAtt?.metadata?.transcript).toBe("the spoken words");
      } finally {
        await worker.stop();
        setTranscriptionWorker(null);
        delete process.env.ASSETS_DIR;
      }
    });

    // ---- Optimistic concurrency on the stub re-stamp (vault#435) ----------
    // The retry endpoint does a read-transform-write on the memo note to
    // re-arm `transcribe_stub: true`. Without an `if_updated_at` precondition,
    // a user edit landing between the read (`resolveNote`) and this write is
    // silently clobbered — the static-write/stale-read class of vault#208.
    //
    // We inject a store wrapper that fires a concurrent USER edit immediately
    // before the route's first OC `updateNote` runs, making its precondition
    // stale. The route must NOT clobber the user's edit; it must re-read and
    // re-apply the metadata-only re-stamp against fresh content.

    /**
     * Wrap a store so the first `N` `updateNote` calls carrying an
     * `if_updated_at` precondition fire `userEdit()` (a concurrent user write
     * that bumps `updated_at`) just before delegating — forcing the precondition
     * stale exactly `interfereTimes` times. Non-OC writes pass through.
     *
     * NOTE: duplicated in src/transcription-worker.test.ts (worker-layer race
     * tests) — keep in sync.
     */
    function withRace(
      base: Store,
      interfereTimes: number,
      userEdit: () => Promise<void>,
    ): Store {
      let fired = 0;
      return new Proxy(base, {
        get(target, prop, receiver) {
          if (prop === "updateNote") {
            return async (id: string, updates: any) => {
              if (updates?.if_updated_at !== undefined && fired < interfereTimes) {
                fired++;
                // bun:sqlite stamps `updated_at` at ms granularity. Sleep so
                // the concurrent user write lands at a strictly-greater
                // timestamp than the precondition the route captured — making
                // the conflict deterministic rather than racing inside the
                // same millisecond.
                await new Promise((r) => setTimeout(r, 5));
                await userEdit();
              }
              return (target as any).updateNote(id, updates);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as Store;
    }

    test("OC: single race → user edit survives, stub still re-armed (no clobber)", async () => {
      const { noteId, attachmentId } = await seedLegacyFailedMemo({ noteId: "race-1" });

      // One interference: the very first OC write conflicts; the route re-reads
      // and re-applies against the user's new content.
      const raceStore = withRace(store, 1, async () => {
        // User appends a line to the body while the retry is in flight.
        await store.updateNote(noteId, { append: "\n\nMY EDIT WHILE PENDING" });
      });

      const res = await handleNotes(
        mkReq("POST", `/notes/${noteId}/retry-transcription`),
        raceStore,
        `/${noteId}/retry-transcription`,
        "default",
      );
      // (a) User edit NOT clobbered + (c) re-stamp succeeded on retry → 202.
      expect(res.status).toBe(202);

      const after = await store.getNote(noteId);
      // (a) The user's concurrent edit survives.
      expect(after!.content).toContain("MY EDIT WHILE PENDING");
      // Original capture body also intact (re-stamp is metadata-only).
      expect(after!.content).toContain("_Transcription unavailable._");
      // (c) Stub re-armed despite the race.
      expect((after!.metadata as any)?.transcribe_stub).toBe(true);

      const att = await store.getAttachment(attachmentId);
      expect(att?.metadata?.transcribe_status).toBe("pending");
      expect(att?.metadata?.transcribe_origin).toBe("legacy");

      delete process.env.ASSETS_DIR;
    });

    test("OC: double race → 409 (user-facing request can retry)", async () => {
      const { noteId } = await seedLegacyFailedMemo({ noteId: "race-2" });

      // Interfere on BOTH the first write and the retry write → the route
      // exhausts its single retry and surfaces 409.
      const raceStore = withRace(store, 2, async () => {
        await store.updateNote(noteId, { append: " x" });
      });

      const res = await handleNotes(
        mkReq("POST", `/notes/${noteId}/retry-transcription`),
        raceStore,
        `/${noteId}/retry-transcription`,
        "default",
      );
      // (c) Double-conflict policy for a user-facing endpoint: 409.
      expect(res.status).toBe(409);
      const body = await res.json() as any;
      expect(body.error_type).toBe("conflict");
      expect(body.note_id).toBe(noteId);

      // The note was never clobbered — the user's two appends are both present.
      const after = await store.getNote(noteId);
      expect(after!.content).toContain(" x x");

      delete process.env.ASSETS_DIR;
    });

    test("OC: happy path unchanged when no race occurs", async () => {
      // With zero interference the OC write lands first-try, byte-identical to
      // the pre-#435 behavior — guards against the precondition breaking the
      // common path.
      const { noteId } = await seedLegacyFailedMemo({ noteId: "race-0" });
      const res = await handleNotes(
        mkReq("POST", `/notes/${noteId}/retry-transcription`),
        store,
        `/${noteId}/retry-transcription`,
        "default",
      );
      expect(res.status).toBe(202);
      const after = await store.getNote(noteId);
      expect((after!.metadata as any)?.transcribe_stub).toBe(true);
      delete process.env.ASSETS_DIR;
    });
  });
});

// ---------------------------------------------------------------------------
// REST transport hardening — malformed/wrong-shape/oversize JSON bodies
// (LB7). Before the fix: malformed JSON on POST /notes, POST
// /notes/:id/attachments, and PUT /tags/:name threw past the handler into
// server.ts's generic top-level catch — a 500 with no `error_type` (LB7a),
// unlike the already-hardened /tags/merge and /tags/:name/rename routes,
// which returned a clean 400 `invalid_json`. A syntactically-valid but
// wrong-shape body (`null`, `42`, `[]`) either threw a TypeError deep in the
// handler or sailed through property access as `undefined`, silently
// creating a blank note / no-op update (LB7b). And nothing capped request
// body size, so an oversized `content` field reached the store unbounded
// (LB7c). Every assertion here MUST fail without the fix (parseJsonBody).
// ---------------------------------------------------------------------------
describe("REST transport hardening — malformed/wrong-shape/oversize JSON bodies (LB7)", async () => {
  /** Raw (non-JSON.stringify'd) request body — for malformed-JSON cases mkReq can't express. */
  function mkRawReq(method: string, path: string, rawBody: string): Request {
    return new Request(`${BASE}${path}`, {
      method,
      body: rawBody,
      headers: { "Content-Type": "application/json" },
    });
  }

  describe("malformed JSON -> clean 400 invalid_json, not a 500 (LB7a)", () => {
    test("POST /notes", async () => {
      const res = await handleNotes(mkRawReq("POST", "/notes", "{not valid json"), store, "");
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error_type).toBe("invalid_json");
    });

    test("POST /notes/:id/attachments", async () => {
      await store.createNote("x", { id: "att-malformed" });
      const res = await handleNotes(
        mkRawReq("POST", "/notes/att-malformed/attachments", "{not valid json"),
        store,
        "/att-malformed/attachments",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error_type).toBe("invalid_json");
    });

    test("PATCH /notes/:idOrPath", async () => {
      await store.createNote("x", { id: "patch-malformed" });
      const res = await handleNotes(
        mkRawReq("PATCH", "/notes/patch-malformed", "{not valid json"),
        store,
        "/patch-malformed",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error_type).toBe("invalid_json");
    });

    test("PUT /tags/:name — parity with the already-hardened /tags/merge shape", async () => {
      const res = await handleTags(mkRawReq("PUT", "/tags/malformed", "{not valid json"), store, "/malformed");
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error_type).toBe("invalid_json");
    });

    test("PATCH /vault-info", async () => {
      const cfg = { name: "default" } as { name: string };
      const res = await handleVault(mkRawReq("PATCH", "/vault", "{not valid json"), store, cfg as any);
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error_type).toBe("invalid_json");
    });
  });

  // Wrong-SHAPE bodies parse fine as JSON but aren't the object a route
  // expects — the taxonomy calls that `invalid_request` (parallel to
  // /tags/merge's sources/target shape errors), NOT `invalid_json` (which is
  // reserved for a genuine parse failure, asserted in the LB7a block above).
  describe("wrong-shape (but syntactically valid) JSON body -> 400 invalid_request, not 500 or a silent blank write (LB7b)", () => {
    test("POST /notes with a `null` body -> 400 invalid_request, not a 500 TypeError", async () => {
      const res = await handleNotes(mkReq("POST", "/notes", null), store, "");
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error_type).toBe("invalid_request");
    });

    test("POST /notes with a bare number body -> 400 invalid_request, not a silently-created blank note", async () => {
      const res = await handleNotes(mkReq("POST", "/notes", 42), store, "");
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error_type).toBe("invalid_request");
      const after = await (await handleNotes(mkReq("GET", "/notes"), store, "")).json() as any[];
      expect(after).toHaveLength(0); // no blank note landed
    });

    test("POST /notes with a bare array body -> 400 invalid_request, not a silently-created blank note", async () => {
      const res = await handleNotes(mkReq("POST", "/notes", []), store, "");
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error_type).toBe("invalid_request");
      const after = await (await handleNotes(mkReq("GET", "/notes"), store, "")).json() as any[];
      expect(after).toHaveLength(0);
    });

    test("POST /notes with notes: \"not-an-array\" -> 400 invalid_request, not per-character blank notes", async () => {
      const res = await handleNotes(mkReq("POST", "/notes", { notes: "oops" }), store, "");
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error_type).toBe("invalid_request");
      expect(body.field).toBe("notes");
      const after = await (await handleNotes(mkReq("GET", "/notes"), store, "")).json() as any[];
      expect(after).toHaveLength(0);
    });

    test("POST /notes with a non-object item inside notes[] -> 400 invalid_request", async () => {
      const res = await handleNotes(
        mkReq("POST", "/notes", { notes: [{ content: "ok", path: "ok-one" }, 42] }),
        store,
        "",
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error_type).toBe("invalid_request");
      const after = await (await handleNotes(mkReq("GET", "/notes"), store, "")).json() as any[];
      expect(after).toHaveLength(0); // the whole batch is rejected, not a partial write
    });
  });

  describe("oversize request body -> 413, not an unbounded write (LB7c)", () => {
    test("POST /notes with an oversized content field is rejected", async () => {
      const huge = "x".repeat(MAX_JSON_BODY_BYTES + 1024);
      const res = await handleNotes(mkReq("POST", "/notes", { content: huge, path: "huge-note" }), store, "");
      expect(res.status).toBe(413);
      const body = await res.json() as any;
      expect(body.error_type).toBe("payload_too_large");
      const stored = await store.getNoteByPath("huge-note");
      expect(stored).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// REST tag-scope confidentiality (security review). expand_links must not
// inline out-of-scope wikilinked content; include_links must not hydrate
// out-of-scope neighbor summaries; unresolved-wikilinks must not surface
// out-of-scope source rows. Unscoped path stays fully functional. Each
// security assertion MUST fail without the fix.
// ---------------------------------------------------------------------------
describe("HTTP tag-scope confidentiality (security review)", async () => {
  // Build a TagScopeCtx the same way routing.ts does, so handlers see the
  // exact shape a real tag-scoped request produces.
  async function scopeCtx(roots: string[]): Promise<TagScopeCtx> {
    return { allowed: await expandTokenTagScope(store, roots), raw: roots };
  }
  const NO_SCOPE: TagScopeCtx = { allowed: null, raw: null };

  test("expand_links does NOT inline out-of-scope wikilinked content", async () => {
    await store.createNote("SECRET PERSONAL BODY", { path: "Secret", tags: ["personal"] });
    const work = await store.createNote("intro [[Secret]]", { path: "Work", tags: ["work"] });

    const res = await handleNotes(
      mkReq("GET", `/notes?id=${work.id}&include_content=true&expand_links=true`),
      store,
      "",
      "v",
      await scopeCtx(["work"]),
    );
    const body = await res.json() as any;
    expect(body.content).not.toContain("SECRET PERSONAL BODY");
    expect(body.content).toContain("[[Secret]]"); // literal — like not-found
  });

  test("UNSCOPED expand_links still inlines content (regression)", async () => {
    await store.createNote("PERSONAL BODY", { path: "Secret", tags: ["personal"] });
    const work = await store.createNote("intro [[Secret]]", { path: "Work", tags: ["work"] });

    const res = await handleNotes(
      mkReq("GET", `/notes?id=${work.id}&include_content=true&expand_links=true`),
      store,
      "",
      "v",
      NO_SCOPE,
    );
    const body = await res.json() as any;
    expect(body.content).toContain("PERSONAL BODY");
  });

  test("expand_links multi-hop (depth>1) does not leak out-of-scope content", async () => {
    await store.createNote("DEEP PERSONAL SECRET", { path: "Deep", tags: ["personal"] });
    await store.createNote("mid [[Deep]]", { path: "Mid", tags: ["work"] });
    const top = await store.createNote("top [[Mid]]", { path: "Top", tags: ["work"] });

    const res = await handleNotes(
      mkReq("GET", `/notes?id=${top.id}&include_content=true&expand_links=true&expand_depth=3`),
      store,
      "",
      "v",
      await scopeCtx(["work"]),
    );
    const body = await res.json() as any;
    expect(body.content).toContain("mid");
    expect(body.content).not.toContain("DEEP PERSONAL SECRET");
  });

  test("include_links strips out-of-scope NEIGHBOR summaries", async () => {
    const secret = await store.createNote("secret", { path: "Secret", tags: ["personal"] });
    const work = await store.createNote("work", { path: "Work", tags: ["work"] });
    await store.createLink(work.id, secret.id, "references");

    const res = await handleNotes(
      mkReq("GET", `/notes?id=${work.id}&include_links=true`),
      store,
      "",
      "v",
      await scopeCtx(["work"]),
    );
    const body = await res.json() as any;
    const serialized = JSON.stringify(body.links ?? []);
    expect(serialized).not.toContain(secret.id);
    expect(serialized).not.toContain("Secret");
  });

  test("UNSCOPED include_links hydrates the full neighbor (regression)", async () => {
    const secret = await store.createNote("secret", { path: "Secret", tags: ["personal"] });
    const work = await store.createNote("work", { path: "Work", tags: ["work"] });
    await store.createLink(work.id, secret.id, "references");

    const res = await handleNotes(
      mkReq("GET", `/notes?id=${work.id}&include_links=true`),
      store,
      "",
      "v",
      NO_SCOPE,
    );
    const body = await res.json() as any;
    expect((body.links ?? []).length).toBe(1);
    expect(JSON.stringify(body.links)).toContain(secret.id);
  });

  test("unresolved-wikilinks surfaces only in-scope source rows", async () => {
    // #personal source with a dangling wikilink → out-of-scope row.
    await store.createNote("p [[NoSuchPersonal]]", { path: "P", tags: ["personal"] });
    // #work source with a dangling wikilink → in-scope row.
    await store.createNote("w [[NoSuchWork]]", { path: "W", tags: ["work"] });

    const res = handleUnresolvedWikilinks(
      mkReq("GET", "/unresolved-wikilinks"),
      store,
      await scopeCtx(["work"]),
    );
    const body = await res.json() as any;
    const targets = (body.unresolved as any[]).map((r) => r.target_path);
    expect(targets).toContain("NoSuchWork");
    expect(targets).not.toContain("NoSuchPersonal");
    expect(body.count).toBe(1);
  });

  test("UNSCOPED unresolved-wikilinks surfaces every row (regression)", async () => {
    await store.createNote("p [[NoSuchPersonal]]", { path: "P", tags: ["personal"] });
    await store.createNote("w [[NoSuchWork]]", { path: "W", tags: ["work"] });

    const res = handleUnresolvedWikilinks(
      mkReq("GET", "/unresolved-wikilinks"),
      store,
      NO_SCOPE,
    );
    const body = await res.json() as any;
    const targets = (body.unresolved as any[]).map((r) => r.target_path);
    expect(targets).toContain("NoSuchWork");
    expect(targets).toContain("NoSuchPersonal");
  });

  // vault#555 auth-review CRITICAL: `if_exists` must NOT become a tag-scope
  // bypass. A scoped token naming an out-of-scope note's PATH must not read
  // (ignore), update, or replace it — treat it as a path_conflict (path taken,
  // invisible to this caller). Each assertion MUST fail without the guard in
  // applyExistingNote.
  test('if_exists:"ignore" does NOT return an out-of-scope note by path (POST /notes)', async () => {
    await store.createNote("SECRET WORK PAYLOAD", { path: "Secret", tags: ["personal"] });

    const res = await handleNotes(
      mkReq("POST", "/notes", {
        content: "attempted read",
        path: "Secret",
        tags: ["work"], // in-scope incoming tag — passes the item-tag pre-check
        if_exists: "ignore",
      }),
      store,
      "",
      "v",
      await scopeCtx(["work"]),
    );
    // Path is taken but invisible to this caller → 409 path_conflict, and the
    // secret content appears NOWHERE in the response.
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain("SECRET WORK PAYLOAD");
    expect(JSON.parse(text).error_type).toBe("path_conflict");
  });

  test('if_exists:"update" does NOT mutate an out-of-scope note by path (POST /notes)', async () => {
    const secret = await store.createNote("ORIGINAL SECRET", { path: "Secret", tags: ["personal"], metadata: { keep: "me" } });

    const res = await handleNotes(
      mkReq("POST", "/notes", {
        content: "OVERWRITE ATTEMPT",
        path: "Secret",
        tags: ["work"],
        metadata: { injected: true },
        if_exists: "update",
      }),
      store,
      "",
      "v",
      await scopeCtx(["work"]),
    );
    expect(res.status).toBe(409);
    // Ground truth: the out-of-scope note is byte-for-byte unchanged.
    const onDisk = (await store.getNote(secret.id))!;
    expect(onDisk.content).toBe("ORIGINAL SECRET");
    expect(onDisk.metadata).toEqual({ keep: "me" });
    expect(onDisk.tags).toEqual(["personal"]); // "work" never applied
  });

  test('if_exists:"replace" does NOT mutate an out-of-scope note by path (POST /notes)', async () => {
    const secret = await store.createNote("ORIGINAL SECRET", { path: "Secret", tags: ["personal"], metadata: { a: 1 } });

    const res = await handleNotes(
      mkReq("POST", "/notes", {
        content: "REPLACE ATTEMPT",
        path: "Secret",
        tags: ["work"],
        if_exists: "replace",
      }),
      store,
      "",
      "v",
      await scopeCtx(["work"]),
    );
    expect(res.status).toBe(409);
    const onDisk = (await store.getNote(secret.id))!;
    expect(onDisk.content).toBe("ORIGINAL SECRET");
    expect(onDisk.metadata).toEqual({ a: 1 });
  });

  test("UNSCOPED if_exists:ignore still returns the existing note (regression — guard is scope-gated)", async () => {
    const existing = await store.createNote("PLAIN BODY", { path: "Plain", tags: ["work"] });
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "x", path: "Plain", if_exists: "ignore" }),
      store,
      "",
      "v",
      NO_SCOPE,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.existed).toBe(true);
    expect(body.id).toBe(existing.id);
    expect(body.content).toBe("PLAIN BODY");
  });

  test("in-scope if_exists:ignore against an in-scope note works normally (guard doesn't over-block)", async () => {
    const existing = await store.createNote("WORK BODY", { path: "MyWork", tags: ["work"] });
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "x", path: "MyWork", tags: ["work"], if_exists: "ignore" }),
      store,
      "",
      "v",
      await scopeCtx(["work"]),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.existed).toBe(true);
    expect(body.id).toBe(existing.id);
    expect(body.content).toBe("WORK BODY");
  });

});

describe("HTTP /notes include_link_count + order_by=link_count (vault feedback #4)", async () => {
  // Mirrors the MCP-surface tests in core/src/link-count.test.ts on the
  // same fixtures so REST and MCP agree on the degree semantics.
  async function seed() {
    await store.createNote("Hub", { id: "hub", path: "hub", tags: ["t"] });
    await store.createNote("Leaf", { id: "leaf", path: "leaf", tags: ["t"] });
    await store.createNote("Self", { id: "self", path: "self", tags: ["t"] });
    await store.createLink("hub", "leaf", "a"); // hub out 1, leaf in 1
    await store.createLink("leaf", "hub", "b"); // hub in 1, leaf out 1 => both degree 2
    await store.createLink("self", "self", "loop"); // self-loop => degree 2
  }

  test("list mode: include_link_count injects linkCount (both directions)", async () => {
    await seed();
    const res = await handleNotes(mkReq("GET", "/notes?include_link_count=true"), store, "");
    const body = (await res.json()) as any[];
    const byId = Object.fromEntries(body.map((n) => [n.id, n]));
    expect(byId.hub.linkCount).toBe(2);
    expect(byId.leaf.linkCount).toBe(2);
    expect(byId.self.linkCount).toBe(2); // self-loop = 2
  });

  test("absent flag → no linkCount key (no behavior change)", async () => {
    await seed();
    const res = await handleNotes(mkReq("GET", "/notes"), store, "");
    const body = (await res.json()) as any[];
    expect(body.every((n) => !("linkCount" in n))).toBe(true);
  });

  test("note with 0 links → linkCount: 0", async () => {
    await store.createNote("Lonely", { id: "lonely", path: "lonely" });
    const res = await handleNotes(mkReq("GET", "/notes?include_link_count=true"), store, "");
    const body = (await res.json()) as any[];
    expect(body.find((n) => n.id === "lonely").linkCount).toBe(0);
  });

  test("single-note (?id=) mode: include_link_count → correct degree", async () => {
    await seed();
    const res = await handleNotes(mkReq("GET", "/notes?id=self&include_link_count=true"), store, "");
    const body = (await res.json()) as any;
    expect(body.linkCount).toBe(2);
  });

  test("single-note (/notes/:id) mode: include_link_count → correct degree", async () => {
    await seed();
    const res = await handleNotes(mkReq("GET", "/notes/self?include_link_count=true"), store, "/self");
    const body = (await res.json()) as any;
    expect(body.linkCount).toBe(2);
  });

  test("link_count_direction outbound / inbound variants", async () => {
    await seed();
    const out = await handleNotes(
      mkReq("GET", "/notes?id=hub&include_link_count=true&link_count_direction=outbound"),
      store,
      "",
    );
    expect(((await out.json()) as any).linkCount).toBe(1); // hub→leaf
    const inb = await handleNotes(
      mkReq("GET", "/notes?id=hub&include_link_count=true&link_count_direction=inbound"),
      store,
      "",
    );
    expect(((await inb.json()) as any).linkCount).toBe(1); // leaf→hub
  });

  test("unrecognized link_count_direction falls back to both (REST parseLinkCountDirection)", async () => {
    await seed();
    // hub: both=2, outbound=1, inbound=1. A bogus value must degrade to
    // `both` (2), distinct from either directional value (1).
    const res = await handleNotes(
      mkReq("GET", "/notes?id=hub&include_link_count=true&link_count_direction=sideways"),
      store,
      "",
    );
    expect(((await res.json()) as any).linkCount).toBe(2);
  });

  test("FTS branch: search + include_link_count → results carry linkCount", async () => {
    // The full-text-search branch is a separate return path from the
    // structured query; exercise the flag there explicitly.
    await store.createNote("quokka sighting near the hub", { id: "fts-hub", path: "fts-hub" });
    await store.createNote("a quokka friend", { id: "fts-friend", path: "fts-friend" });
    await store.createLink("fts-hub", "fts-friend", "a"); // hub out1, friend in1
    await store.createLink("fts-friend", "fts-hub", "b"); // hub in1 => hub degree 2
    const res = await handleNotes(
      mkReq("GET", "/notes?search=quokka&include_link_count=true"),
      store,
      "",
    );
    const body = (await res.json()) as any[];
    const byId = Object.fromEntries(body.map((n) => [n.id, n]));
    expect(byId["fts-hub"].linkCount).toBe(2);
    expect(byId["fts-friend"].linkCount).toBe(2);
  });

  test("FTS branch: absent flag → no linkCount key", async () => {
    await store.createNote("quokka sighting near the hub", { id: "fts-hub", path: "fts-hub" });
    await store.createLink("fts-hub", "fts-hub", "loop");
    const res = await handleNotes(mkReq("GET", "/notes?search=quokka"), store, "");
    const body = (await res.json()) as any[];
    expect(body.every((n) => !("linkCount" in n))).toBe(true);
  });

  test("order_by=link_count desc: field value == sort key for every note", async () => {
    // Distinct degrees so the ordering is unambiguous: big=3, mid=2, small=0.
    await store.createNote("Big", { id: "big", path: "big" });
    await store.createNote("Mid", { id: "mid", path: "mid" });
    await store.createNote("Small", { id: "small", path: "small" });
    await store.createLink("big", "mid", "a"); // big out1, mid in1
    await store.createLink("big", "small", "b"); // big out2, small in1
    await store.createLink("mid", "big", "c"); // big in1 => big degree 3; mid out1 => mid degree 2
    // small degree 1 (in from big). Adjust: make small degree 0 by removing
    // — instead assert monotonic + field==sortkey, which is the real invariant.

    const res = await handleNotes(
      mkReq("GET", "/notes?order_by=link_count&sort=desc&include_link_count=true"),
      store,
      "",
    );
    const body = (await res.json()) as any[];
    const seq = body.map((n) => n.linkCount as number);
    // The injected field equals the sort key, so the sequence is non-increasing.
    expect(seq).toEqual([...seq].sort((a, b) => b - a));
    expect(body[0].id).toBe("big"); // degree 3 — the most-connected note
    expect(body[0].linkCount).toBe(3);
  });

  test("order_by=link_count: self-loop note ranks by its degree-2 field value", async () => {
    await store.createNote("Selfy", { id: "selfy", path: "selfy" });
    await store.createNote("Plain", { id: "plain", path: "plain" });
    await store.createNote("Zero", { id: "zero", path: "zero" });
    await store.createLink("selfy", "selfy", "loop"); // degree 2
    await store.createLink("zero", "plain", "ref"); // plain in1, zero out1

    const res = await handleNotes(
      mkReq("GET", "/notes?order_by=link_count&sort=desc&include_link_count=true"),
      store,
      "",
    );
    const body = (await res.json()) as any[];
    expect(body[0].id).toBe("selfy"); // degree 2 outranks the degree-1 notes
    expect(body[0].linkCount).toBe(2); // field == the sort key that put it first
    const byId = Object.fromEntries(body.map((n) => [n.id, n]));
    expect(byId.plain.linkCount).toBe(1);
    expect(byId.zero.linkCount).toBe(1);
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

  test("PATCH metadata null DELETES the key (RFC 7386), not a literal null (vault#478/#479)", async () => {
    await store.createNote("doc", { id: "x", metadata: { keep: "yes", drop: "old", n: 3 } });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { metadata: { drop: null }, force: true }),
      store,
      "/x",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Key removed entirely — must NOT survive as a literal JSON null.
    expect(body.metadata).not.toHaveProperty("drop");
    expect(body.metadata).toEqual({ keep: "yes", n: 3 });
    // Persisted state matches the response (round-trips).
    const fresh = await store.getNote("x");
    expect(fresh!.metadata).not.toHaveProperty("drop");
    expect(fresh!.metadata).toEqual({ keep: "yes", n: 3 });
  });

  test("PATCH metadata key-rename in one call: set new, null-delete old (vault#478)", async () => {
    await store.createNote("doc", { id: "x", metadata: { "old-key": "v", stable: true } });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/x", { metadata: { new_key: "v", "old-key": null }, force: true }),
      store,
      "/x",
    );
    const body = await res.json() as any;
    expect(body.metadata).not.toHaveProperty("old-key");
    expect(body.metadata).toEqual({ new_key: "v", stable: true });
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

  // vault#555 fix 2 — a tags-only (or links-only) PATCH with `force: true`
  // (no `if_updated_at`) used to leave `updated_at` frozen: `updates` had no
  // core fields, so `store.updateNote` was never called at all.
  test("PATCH tags-only/links-only with force:true bumps updated_at", async () => {
    await store.createNote("x", { id: "x", tags: ["old"] });
    await store.createNote("y", { id: "y" });
    const before = (await store.getNote("x"))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));

    const tagsRes = await handleNotes(
      mkReq("PATCH", "/notes/x", { tags: { add: ["new"] }, force: true }),
      store,
      "/x",
    );
    const tagsBody = await tagsRes.json() as any;
    expect(tagsBody.updatedAt).not.toBe(before);
    expect(new Date(tagsBody.updatedAt) > new Date(before)).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    const linksRes = await handleNotes(
      mkReq("PATCH", "/notes/x", { links: { add: [{ target: "y", relationship: "mentions" }] }, force: true }),
      store,
      "/x",
    );
    const linksBody = await linksRes.json() as any;
    expect(new Date(linksBody.updatedAt) > new Date(tagsBody.updatedAt)).toBe(true);
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

  // vault feedback #8 — the update response now echoes hydrated links when
  // the request mutated links OR `?include_links=true` is passed, so callers
  // no longer have to re-GET to confirm a link they just added/removed.
  test("PATCH links.add echoes hydrated links on the response", async () => {
    await store.createNote("a", { id: "a" });
    await store.createNote("b", { id: "b", path: "People/Bob", tags: ["person"] });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/a", { links: { add: [{ target: "b", relationship: "mentions" }] }, force: true }),
      store,
      "/a",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.links)).toBe(true);
    expect(body.links).toHaveLength(1);
    const link = body.links[0];
    expect(link.sourceId).toBe("a");
    expect(link.targetId).toBe("b");
    expect(link.relationship).toBe("mentions");
    // Hydrated shape matches GET / query-notes: targetNote summary present.
    expect(link.targetNote.id).toBe("b");
    expect(link.targetNote.path).toBe("People/Bob");
    expect(link.targetNote.tags).toEqual(["person"]);
  });

  test("PATCH links.remove echoes the post-removal link set", async () => {
    await store.createNote("a", { id: "a" });
    await store.createNote("b", { id: "b" });
    await store.createNote("c", { id: "c" });
    await store.createLink("a", "b", "mentions");
    await store.createLink("a", "c", "mentions");
    const res = await handleNotes(
      mkReq("PATCH", "/notes/a", { links: { remove: [{ target: "b", relationship: "mentions" }] }, force: true }),
      store,
      "/a",
    );
    const body = await res.json() as any;
    expect(Array.isArray(body.links)).toBe(true);
    expect(body.links).toHaveLength(1);
    expect(body.links[0].targetId).toBe("c");
  });

  // vault#555 — REST PATCH links.add gets the same basename/title
  // resolution + lazy forward-ref queueing as the MCP update-note tool
  // (both surfaces share core/wikilinks.ts's resolveOrQueueLink).
  test("PATCH links.add resolves by BASENAME and warns+queues when unresolvable", async () => {
    await store.createNote("a", { id: "a" });
    await store.createNote("Bob's note", { path: "People/Bob" });
    const byTitle = await handleNotes(
      mkReq("PATCH", "/notes/a", { links: { add: [{ target: "Bob", relationship: "knows" }] }, force: true }),
      store,
      "/a",
    );
    expect(byTitle.status).toBe(200);
    const byTitleBody = await byTitle.json() as any;
    expect(byTitleBody.warnings).toBeUndefined();
    expect(await store.getLinks("a", { direction: "outbound" })).toHaveLength(1);

    const unresolved = await handleNotes(
      mkReq("PATCH", "/notes/a", { links: { add: [{ target: "Not Yet Real", relationship: "wants" }] }, force: true }),
      store,
      "/a",
    );
    const unresolvedBody = await unresolved.json() as any;
    expect(unresolvedBody.warnings).toBeDefined();
    expect(unresolvedBody.warnings[0].code).toBe("unresolved_link");
    expect(unresolvedBody.warnings[0].target).toBe("Not Yet Real");

    const target = await store.createNote("arrived", { path: "Not Yet Real" });
    const links = await store.getLinks("a", { direction: "outbound" });
    expect(links.some((l) => l.targetId === target.id && l.relationship === "wants")).toBe(true);
  });

  // vault#555 — POST /notes batch: a link to a note created LATER in the
  // same batch must resolve (forward-ref), matching MCP create-note.
  test("POST /notes batch: a link to a note created LATER in the same batch resolves (forward-ref)", async () => {
    const res = await handleNotes(
      mkReq("POST", "/notes", {
        notes: [
          { path: "RestA", content: "links to RestB", links: [{ target: "RestB", relationship: "knows" }] },
          { path: "RestB", content: "the target" },
        ],
      }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any[];
    const a = body.find((n: any) => n.path === "RestA");
    expect(a.warnings).toBeUndefined();
    const links = await store.getLinks(a.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0]!.relationship).toBe("knows");
  });

  // vault#570 — content-parsed [[wikilinks]] to a missing target used to
  // fire NO write-time warning over REST either, mirroring the MCP fix.
  test("POST /notes with a content [[wikilink]] to a missing target: warns (unresolved_link)", async () => {
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "See [[Nowhere REST]] for details." }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.warnings).toBeDefined();
    expect(body.warnings[0].code).toBe("unresolved_link");
    expect(body.warnings[0].target).toBe("Nowhere REST");
    expect(await store.getLinks(body.id, { direction: "outbound" })).toHaveLength(0);
  });

  // vault#570 — a target matching ≥2 notes is a distinct situation from a
  // genuine miss: `ambiguous_link`, not `unresolved_link`, and no edge.
  test("POST /notes with a content [[wikilink]] to an AMBIGUOUS target: ambiguous_link, no edge", async () => {
    await store.createNote("A", { path: "Folder1/RestDup" });
    await store.createNote("B", { path: "Folder2/RestDup" });
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "See [[RestDup]] for details." }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.warnings).toBeDefined();
    expect(body.warnings[0].code).toBe("ambiguous_link");
    expect(body.warnings[0].target).toBe("RestDup");
    expect(body.warnings[0].candidate_count).toBe(2);
    expect(await store.getLinks(body.id, { direction: "outbound" })).toHaveLength(0);
  });

  // vault#570 — a structured `links` entry against an ambiguous target gets
  // the same treatment over REST (shared core implementation).
  test("POST /notes with a structured link to an AMBIGUOUS target: ambiguous_link, no edge", async () => {
    await store.createNote("A", { path: "Folder1/RestDup2" });
    await store.createNote("B", { path: "Folder2/RestDup2" });
    const res = await handleNotes(
      mkReq("POST", "/notes", {
        content: "no wikilinks here",
        links: [{ target: "RestDup2", relationship: "knows" }],
      }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.warnings).toBeDefined();
    expect(body.warnings[0].code).toBe("ambiguous_link");
    expect(body.warnings[0].candidate_count).toBe(2);
    expect(await store.getLinks(body.id, { direction: "outbound" })).toHaveLength(0);
  });

  test("PATCH content update with a [[wikilink]] to a missing target: warns (unresolved_link)", async () => {
    await store.createNote("plain", { id: "patchable", path: "PatchableRest" });
    const res = await handleNotes(
      mkReq("PATCH", "/notes/patchable", { content: "now references [[Not Yet Real REST]]", force: true }),
      store,
      "/patchable",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.warnings).toBeDefined();
    expect(body.warnings[0].code).toBe("unresolved_link");
    expect(body.warnings[0].target).toBe("Not Yet Real REST");

    // A tags-only follow-up PATCH must not re-surface the warning.
    const tagOnly = await handleNotes(
      mkReq("PATCH", "/notes/patchable", { tags: { add: ["x"] }, force: true }),
      store,
      "/patchable",
    );
    const tagOnlyBody = await tagOnly.json() as any;
    expect(tagOnlyBody.warnings).toBeUndefined();
  });

  // vault#570 — `if_missing: "create"` is a distinct create-shaped code
  // path in routes.ts (separate from POST /notes); it needs the same fix.
  test("PATCH if_missing:create with a [[wikilink]] to a missing target: warns (unresolved_link)", async () => {
    const res = await handleNotes(
      mkReq("PATCH", "/notes/brand-new-rest", {
        if_missing: "create",
        content: "See [[Nowhere Upsert REST]].",
      }),
      store,
      "/brand-new-rest",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.created).toBe(true);
    expect(body.warnings).toBeDefined();
    expect(body.warnings[0].code).toBe("unresolved_link");
    expect(body.warnings[0].target).toBe("Nowhere Upsert REST");
  });

  test("PATCH without a link mutation or flag does NOT include links", async () => {
    await store.createNote("a", { id: "a" });
    await store.createNote("b", { id: "b" });
    await store.createLink("a", "b", "mentions");
    const res = await handleNotes(
      mkReq("PATCH", "/notes/a", { content: "updated", force: true }),
      store,
      "/a",
    );
    const body = await res.json() as any;
    expect(body.content).toBe("updated");
    expect(body).not.toHaveProperty("links");
  });

  test("PATCH ?include_links=true echoes current links even without a mutation", async () => {
    await store.createNote("a", { id: "a" });
    await store.createNote("b", { id: "b" });
    await store.createLink("a", "b", "mentions");
    const res = await handleNotes(
      mkReq("PATCH", "/notes/a?include_links=true", { content: "updated", force: true }),
      store,
      "/a",
    );
    const body = await res.json() as any;
    expect(body.content).toBe("updated");
    expect(Array.isArray(body.links)).toBe(true);
    expect(body.links).toHaveLength(1);
    expect(body.links[0].targetId).toBe("b");
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

  // vault#555 fix 7 (INVESTIGATE) — a tester reported "old_text not found"
  // failing 7/8 for batch/parallel content_edit calls sharing the same
  // old_text. Not reproducible against DIFFERENT notes (see
  // core/src/core.test.ts's matching investigation for the full writeup
  // and the "SAME note" control that DOES reproduce "1 succeeds, 7 fail" —
  // correct behavior, likely what the original report actually hit). REST
  // parity check here: N parallel PATCH requests, same old_text, different
  // notes, all succeed.
  test("PATCH parallel: N concurrent content_edit calls with the SAME old_text on DIFFERENT notes all succeed", async () => {
    const N = 8;
    const notes = [];
    for (let i = 0; i < N; i++) {
      notes.push(await store.createNote(`prefix TARGET_TEXT suffix-${i}`, { path: `rest-ce-${i}` }));
    }

    const results = await Promise.all(
      notes.map((n) =>
        handleNotes(
          mkReq("PATCH", `/notes/${n.id}`, {
            content_edit: { old_text: "TARGET_TEXT", new_text: "REPLACED" },
            force: true,
          }),
          store,
          `/${n.id}`,
        ),
      ),
    );
    for (const res of results) {
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < N; i++) {
      const fresh = await store.getNote(notes[i]!.id);
      expect(fresh!.content).toBe(`prefix REPLACED suffix-${i}`);
    }
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

// vault#555 fix 3 — validation_status used to be visible ONLY on the
// one-time create/update WRITE response; a caller reading the note back
// (GET single note, or the structured-query list) saw nothing at all,
// contradicting "advisory violations surface as warnings" for an
// enum_mismatch on a non-strict (even indexed) field.
describe("HTTP GET /notes — validation_status on reads (vault#555)", async () => {
  test("GET /notes/:id surfaces validation_status (enum_mismatch on an indexed field)", async () => {
    const res0 = await handleTags(
      mkReq("PUT", "/tags/widget555", { fields: { status: { type: "string", enum: ["a", "b"], indexed: true } } }),
      store,
      "/widget555",
    );
    expect(res0.status).toBe(200);
    const created = await store.createNote("x", { tags: ["widget555"], metadata: { status: "bogus" } });

    const res = await handleNotes(mkReq("GET", `/notes/${created.id}`), store, `/${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.validation_status?.warnings?.[0]?.reason).toBe("enum_mismatch");
    expect(body.validation_status.warnings[0].field).toBe("status");
  });

  test("GET /notes (structured query list) surfaces validation_status per note", async () => {
    await store.upsertTagSchema("task555list", {
      fields: { priority: { type: "string", enum: ["high", "low"] } },
    });
    await store.createNote("x", { tags: ["task555list"], metadata: { priority: "ULTRA" } });

    const res = await handleNotes(mkReq("GET", "/notes?tag=task555list"), store, "");
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].validation_status?.warnings?.[0]?.reason).toBe("enum_mismatch");
  });

  test("GET /notes/:id and list both omit validation_status when no tag declares fields", async () => {
    const note = await store.createNote("plain", { tags: ["plain555"] });
    const single = await handleNotes(mkReq("GET", `/notes/${note.id}`), store, `/${note.id}`);
    const singleBody = await single.json() as any;
    expect(singleBody.validation_status).toBeUndefined();

    const list = await handleNotes(mkReq("GET", "/notes?tag=plain555"), store, "");
    const listBody = await list.json() as any[];
    expect(listBody[0].validation_status).toBeUndefined();
  });

  // vault#555 auth review — REST parity for the validation_status scope
  // scrub (the #560 leak class). A scoped caller reading a note co-tagged
  // with an out-of-scope tag must not learn that tag's schema shape.
  test("GET /notes/:id and list scrub out-of-scope co-tag schema from validation_status for a scoped caller", async () => {
    await store.upsertTagSchema("workrs", { fields: { priority: { type: "string", enum: ["hi", "lo"] } } });
    await store.upsertTagSchema("manhattanrs", { fields: { codeword: { type: "string", enum: ["fizzbuzz"] } } });
    const note = await store.createNote("co-tagged", {
      path: "CoTaggedRS",
      tags: ["workrs", "manhattanrs"],
      metadata: { priority: "URGENT", codeword: "leaked" },
    });
    const scope = { allowed: new Set(["workrs"]), raw: ["workrs"] };

    // Single GET — `fizzbuzz` (the out-of-scope enum value) exists only in
    // manhattanrs's schema, so its absence proves no schema-shape leak. The
    // tag name is scrubbed from validation_status (still in `.tags` —
    // pre-existing, out of scope; see the MCP counterpart test).
    const single = await handleNotes(mkReq("GET", `/notes/${note.id}`), store, `/${note.id}`, undefined, scope);
    const singleBody = await single.json() as any;
    expect(JSON.stringify(singleBody)).not.toContain("fizzbuzz");
    expect(JSON.stringify(singleBody.validation_status)).not.toContain("manhattanrs");
    expect(singleBody.validation_status.schemas).toEqual(["workrs"]);
    expect(singleBody.validation_status.warnings).toHaveLength(1);
    expect(singleBody.validation_status.warnings[0].field).toBe("priority");

    // List GET
    const list = await handleNotes(mkReq("GET", "/notes?tag=workrs&include_content=true"), store, "", undefined, scope);
    const listBody = await list.json() as any[];
    expect(JSON.stringify(listBody)).not.toContain("fizzbuzz");
    const target = listBody.find((n) => n.id === note.id);
    expect(JSON.stringify(target.validation_status)).not.toContain("manhattanrs");
    expect(target.validation_status.schemas).toEqual(["workrs"]);
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

// vault#555 — HTTP POST /notes with if_exists: idempotent upsert on a path
// conflict. Mirrors the MCP create-note tool's if_exists contract exactly
// (independent REST-layer reimplementation, same core primitives).
describe("HTTP POST /notes — if_exists (vault#555)", async () => {
  test("default (no if_exists) still 409s — back-compat", async () => {
    await store.createNote("first", { path: "Inbox/rest-dup" });
    const res = await handleNotes(
      mkReq("POST", "/notes", { content: "second", path: "Inbox/rest-dup" }),
      store,
      "",
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error_type).toBe("path_conflict");
  });

  test('if_exists:"ignore" returns 201 with the existing note untouched + existed:true', async () => {
    const first = await store.createNote("original", { path: "Inbox/rest-ignore", metadata: { v: 1 } });
    const res = await handleNotes(
      mkReq("POST", "/notes", {
        content: "attempted overwrite",
        path: "Inbox/rest-ignore",
        metadata: { v: 2 },
        if_exists: "ignore",
      }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.existed).toBe(true);
    expect(body.id).toBe(first.id);
    expect(body.content).toBe("original");
    expect(body.metadata?.v).toBe(1);
  });

  test('if_exists:"update" full-replaces content and RFC-7386-merges metadata', async () => {
    await store.createNote("v1", { path: "Inbox/rest-update", metadata: { a: 1, b: 2 } });
    const res = await handleNotes(
      mkReq("POST", "/notes", {
        content: "v2",
        path: "Inbox/rest-update",
        metadata: { b: null, c: 3 },
        if_exists: "update",
      }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.existed).toBe(true);
    expect(body.content).toBe("v2");
    expect(body.metadata).toEqual({ a: 1, c: 3 });
  });

  test('if_exists:"replace" wholesale-overwrites content + metadata, keeps id/createdAt', async () => {
    const first = await store.createNote("v1", { path: "Inbox/rest-replace", metadata: { a: 1, b: 2 } });
    const res = await handleNotes(
      mkReq("POST", "/notes", {
        content: "v2",
        path: "Inbox/rest-replace",
        metadata: { c: 3 },
        if_exists: "replace",
      }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.existed).toBe(true);
    expect(body.id).toBe(first.id);
    expect(body.createdAt).toBe(first.createdAt);
    expect(body.content).toBe("v2");
    expect(body.metadata).toEqual({ c: 3 });
  });

  test("plain POST (no if_exists) sees zero response-shape change", async () => {
    const res = await handleNotes(mkReq("POST", "/notes", { content: "plain" }), store, "");
    const body = await res.json() as any;
    expect("existed" in body).toBe(false);
  });

  test("batch: if_exists is per-item — a top-level default is NOT inherited", async () => {
    await store.createNote("existing", { path: "Inbox/rest-batch-conflict" });
    const res = await handleNotes(
      mkReq("POST", "/notes", {
        if_exists: "ignore",
        notes: [{ content: "conflict", path: "Inbox/rest-batch-conflict" }],
      }),
      store,
      "",
    );
    expect(res.status).toBe(409);
  });

  test("summary:true returns {created, ids, failed} for a batch", async () => {
    await store.createNote("pre-existing", { path: "Inbox/rest-sum-existing" });
    const res = await handleNotes(
      mkReq("POST", "/notes", {
        summary: true,
        notes: [
          { content: "fresh", path: "Inbox/rest-sum-fresh", if_exists: "ignore" },
          { content: "ignored", path: "Inbox/rest-sum-existing", if_exists: "ignore" },
        ],
      }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.created).toBe(1);
    expect(body.ids).toHaveLength(2);
    expect(body.failed).toEqual([]);
  });

  test("summary is ignored on a single-note POST", async () => {
    const res = await handleNotes(mkReq("POST", "/notes", { content: "solo", summary: true }), store, "");
    const body = await res.json() as any;
    expect(body.content).toBe("solo");
    expect(body.created).toBeUndefined();
  });

  // vault#555 CRITICAL 2 (REST tripwire — the generalist-flagged coverage gap:
  // the core-side tests didn't guard the REST gate, so reverting routes.ts's
  // gate alone left all tests green). REST parity of the two core tests.
  test('if_exists:"update" with ONLY tags added still advances updated_at (POST /notes)', async () => {
    const first = await store.createNote("body", { path: "rest-tagonly", tags: ["alpha"] });
    const before = first.updatedAt!;
    await new Promise((r) => setTimeout(r, 5));

    const res = await handleNotes(
      mkReq("POST", "/notes", { path: "rest-tagonly", tags: ["beta"], if_exists: "update" }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.existed).toBe(true);
    expect(body.tags?.sort()).toEqual(["alpha", "beta"]);
    const after = (await store.getNote(first.id))!.updatedAt!;
    expect(after > before).toBe(true);
  });

  test('if_exists:"update" with ONLY links added still advances updated_at (POST /notes)', async () => {
    await store.createNote("target", { id: "rest-tgt-linkonly", path: "Targets/rest-linkonly" });
    const first = await store.createNote("body", { path: "rest-linkonly", tags: ["alpha"] });
    const before = first.updatedAt!;
    await new Promise((r) => setTimeout(r, 5));

    const res = await handleNotes(
      mkReq("POST", "/notes", {
        path: "rest-linkonly",
        links: [{ target: "rest-tgt-linkonly", relationship: "relates-to" }],
        if_exists: "update",
      }),
      store,
      "",
    );
    expect(res.status).toBe(201);
    const after = (await store.getNote(first.id))!.updatedAt!;
    expect(after > before).toBe(true);
  });
});

// vault#555 — has_broken_links / include_broken_links on GET /notes.
describe("HTTP GET /notes — has_broken_links / include_broken_links (vault#555)", async () => {
  test("has_broken_links=true filters to notes with a dangling wikilink", async () => {
    await store.createNote("[[Nowhere]]", { path: "rest-broken" });
    await store.createNote("clean", { path: "rest-clean" });
    const res = await handleNotes(mkReq("GET", "/notes?has_broken_links=true&include_content=true"), store, "");
    const body = await res.json() as any[];
    expect(body.map((n) => n.path)).toEqual(["rest-broken"]);
  });

  test("has_broken_links=false excludes them", async () => {
    await store.createNote("[[Nowhere]]", { path: "rest-broken2" });
    await store.createNote("clean", { path: "rest-clean2" });
    const res = await handleNotes(mkReq("GET", "/notes?has_broken_links=false&include_content=true"), store, "");
    const body = await res.json() as any[];
    expect(body.map((n) => n.path)).toEqual(["rest-clean2"]);
  });

  test("include_broken_links on a single note surfaces {target, relationship}", async () => {
    await store.createNote("[[Ghost]]", { path: "rest-single-broken" });
    const res = await handleNotes(mkReq("GET", "/notes?id=rest-single-broken&include_broken_links=true"), store, "");
    const body = await res.json() as any;
    expect(body.broken_links).toEqual([{ target: "Ghost", relationship: "wikilink" }]);
  });

  test("include_broken_links in list mode is batched per note", async () => {
    await store.createNote("[[Ghost A]]", { path: "rest-list-a" });
    await store.createNote("clean", { path: "rest-list-b" });
    const res = await handleNotes(mkReq("GET", "/notes?include_broken_links=true&include_content=true"), store, "");
    const body = await res.json() as any[];
    const byPath = new Map(body.map((n: any) => [n.path, n.broken_links]));
    expect(byPath.get("rest-list-a")).toEqual([{ target: "Ghost A", relationship: "wikilink" }]);
    expect(byPath.get("rest-list-b")).toEqual([]);
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

  // Cross-repo guard for the parachute-agent #agent/thread upsert seam: a single-threaded
  // thread note lives at a SLASH path (e.g. "Threads/<channel>/<name>") and the agent
  // module addresses it as ONE URL segment via encodeURIComponent (so `/`→`%2F`). The
  // full round-trip it relies on — GET an existing note by the encoded-slash path
  // (readThreadNote read-back) then PATCH-update it by the same encoded-slash path
  // (if_missing:create upsert, turn 2) — must resolve to the decoded path, or the agent's
  // turn_count/usage aggregates silently reset every turn. This proves the route resolves
  // the encoded slash on GET + PATCH-update of an EXISTING note (4505 above only covers
  // create). See parachute-agent#110.
  test("encoded-slash path round-trips: GET read-back + PATCH-update resolve a %2F path (the #agent/thread upsert seam)", async () => {
    const enc = encodeURIComponent("Threads/eng/eng");
    expect(enc).toBe("Threads%2Feng%2Feng"); // no literal slash — one URL segment.

    // Turn 1 — PATCH if_missing:create by the encoded-slash path → CREATES.
    const create = await handleNotes(
      mkReq("PATCH", `/notes/${enc}`, {
        content: "## Summary\n\nturn 1",
        tags: ["#agent/thread"],
        metadata: { turn_count: "1", status: "ok" },
        if_missing: "create",
        force: true,
      }),
      store,
      `/${enc}`,
    );
    expect(create.status).toBe(200);
    expect((await create.json() as any).created).toBe(true);

    // Read-back — GET by the SAME encoded-slash path resolves the created note (NOT 404).
    const get = await handleNotes(mkReq("GET", `/notes/${enc}`), store, `/${enc}`);
    expect(get.status).toBe(200);
    const got = await get.json() as any;
    expect(got.path).toBe("Threads/eng/eng");
    expect(got.metadata.turn_count).toBe("1");

    // Turn 2 — PATCH if_missing:create by the SAME encoded-slash path → UPDATES in place.
    const update = await handleNotes(
      mkReq("PATCH", `/notes/${enc}`, {
        content: "## Summary\n\nturn 2",
        metadata: { turn_count: "2", status: "ok" },
        if_missing: "create",
        force: true,
      }),
      store,
      `/${enc}`,
    );
    expect(update.status).toBe(200);
    expect((await update.json() as any).created).toBe(false); // updated, NOT a second note.

    // Exactly ONE note at the decoded path, updated (the upsert worked end-to-end).
    const final = await store.getNoteByPath("Threads/eng/eng");
    expect(final).not.toBeNull();
    expect(String(final!.metadata.turn_count)).toBe("2");
    expect(final!.content).toContain("turn 2");
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

  // P1 regression (vault#398 review) — the REST PUT path calls
  // store.upsertTagRecord directly. Before the lifecycle was centralized in
  // the store, PUT {fields:null} or an indexed:false toggle left the
  // generated column orphaned (the MCP path released, REST didn't). Assert
  // via the same PRAGMA table_xinfo / buildVaultProjection introspection the
  // core lifecycle tests use.
  function notesMetaCols(): string[] {
    return (db.prepare("PRAGMA table_xinfo(notes)").all() as { name: string }[])
      .map((r) => r.name)
      .filter((n) => n.startsWith("meta_"));
  }

  test("PUT /tags/:name with a bad indexed-field name returns 400 + leaves schema unchanged (vault#478)", async () => {
    // kebab-case indexed field violates [A-Za-z0-9_]. Pre-fix this persisted
    // the declaration then 500'd on index creation, leaving a tag claiming an
    // index the engine couldn't build (the "lying schema" loop).
    const res = await handleTags(
      mkReq("PUT", "/tags/meeting", { fields: { "meeting-type": { type: "string", indexed: true } } }),
      store,
      "/meeting",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("invalid_indexed_field");
    expect(body.error).toMatch(/invalid field name/);

    // Schema is untouched — no poisoned field declared.
    const record = await store.getTagRecord("meeting");
    expect(record?.fields?.["meeting-type"]).toBeUndefined();
    // No orphan/lying index: neither the generated column nor an indexed_fields row.
    expect(notesMetaCols()).not.toContain("meta_meeting-type");
    expect(buildVaultProjection(db).indexed_fields.map((f) => f.name)).not.toContain("meeting-type");
  });

  test("PUT /tags/:name {fields:null} drops the orphaned generated column", async () => {
    // Declare an indexed field via REST PUT — column materializes.
    await handleTags(
      mkReq("PUT", "/tags/project", { fields: { status: { type: "string", indexed: true } } }),
      store,
      "/project",
    );
    expect(notesMetaCols()).toContain("meta_status");
    expect(buildVaultProjection(db).indexed_fields.map((f) => f.name)).toContain("status");

    // Clear all fields via REST PUT {fields:null} — column must drop.
    const res = await handleTags(
      mkReq("PUT", "/tags/project", { fields: null }),
      store,
      "/project",
    );
    expect(res.status).toBe(200);
    expect(notesMetaCols()).not.toContain("meta_status");
    const idxs = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notes'").all() as { name: string }[]).map((r) => r.name);
    expect(idxs).not.toContain("idx_meta_status");
    expect(buildVaultProjection(db).indexed_fields.map((f) => f.name)).not.toContain("status");
  });

  test("PUT /tags/:name indexed:false toggle drops the generated column", async () => {
    await handleTags(
      mkReq("PUT", "/tags/project", { fields: { status: { type: "string", indexed: true } } }),
      store,
      "/project",
    );
    expect(notesMetaCols()).toContain("meta_status");

    // Re-PUT the same field with indexed:false — REST merges, so the field
    // stays in the schema but loses its index → column drops.
    const res = await handleTags(
      mkReq("PUT", "/tags/project", { fields: { status: { type: "string", indexed: false } } }),
      store,
      "/project",
    );
    expect(res.status).toBe(200);
    expect(notesMetaCols()).not.toContain("meta_status");
    expect(buildVaultProjection(db).indexed_fields.map((f) => f.name)).not.toContain("status");
  });

  test("PUT /tags/:name respects the co-declaration guard (keeps column for a live co-declarer)", async () => {
    await handleTags(
      mkReq("PUT", "/tags/asset", { fields: { aspect_ratio: { type: "string", indexed: true } } }),
      store,
      "/asset",
    );
    await handleTags(
      mkReq("PUT", "/tags/storyboard", { fields: { aspect_ratio: { type: "string", indexed: true } } }),
      store,
      "/storyboard",
    );
    // Clear asset's fields — storyboard still declares aspect_ratio → keep.
    await handleTags(mkReq("PUT", "/tags/asset", { fields: null }), store, "/asset");
    expect(notesMetaCols()).toContain("meta_aspect_ratio");
    expect(buildVaultProjection(db).indexed_fields.map((f) => f.name)).toContain("aspect_ratio");
  });

  // ---- relationships is an opaque vocabulary map (vault#428) ----
  // PUT persists the value verbatim with no inner-shape enforcement; GET
  // returns it byte-for-byte. Only a top-level non-map (array/primitive)
  // or non-serializable input is rejected with invalid_relationships.

  test("PUT /tags/:name persists the opaque vocabulary map; GET returns it verbatim (vault#428)", async () => {
    const vocab = {
      "works-on": { from: "person", to: "project" },
      "member-of": { from: "person", to: "organization" },
      "partner-of": { from: "person", to: "person" },
      "based-at": { from: "project", to: "place" },
    };
    const put = await handleTags(
      mkReq("PUT", "/tags/person", { relationships: vocab }),
      store,
      "/person",
    );
    expect(put.status).toBe(200);

    const get = await handleTags(mkReq("GET", "/tags/person"), store, "/person");
    expect(get.status).toBe(200);
    const body = await get.json() as any;
    // Byte-for-byte: serialize both sides and compare exactly.
    expect(JSON.stringify(body.relationships)).toBe(JSON.stringify(vocab));
    expect(body.relationships).toEqual(vocab);
  });

  test("PUT /tags/:name still accepts the historical typed relationships shape (backwards-compat)", async () => {
    const typed = { owned_by: { target_tag: "person", cardinality: "one", description: "DRI" } };
    const put = await handleTags(
      mkReq("PUT", "/tags/project", { relationships: typed }),
      store,
      "/project",
    );
    expect(put.status).toBe(200);
    const get = await handleTags(mkReq("GET", "/tags/project"), store, "/project");
    const body = await get.json() as any;
    expect(body.relationships).toEqual(typed);
  });

  test("PUT /tags/:name round-trips nested arbitrary relationship values verbatim", async () => {
    const vocab = { rel: { from: "a", to: "b", note: "freeform", weight: 3, tags: ["x", "y"] } };
    const put = await handleTags(
      mkReq("PUT", "/tags/thing", { relationships: vocab }),
      store,
      "/thing",
    );
    expect(put.status).toBe(200);
    const get = await handleTags(mkReq("GET", "/tags/thing"), store, "/thing");
    const body = await get.json() as any;
    expect(body.relationships).toEqual(vocab);
  });

  test("PUT /tags/:name returns 400 invalid_relationships for a top-level array", async () => {
    const res = await handleTags(
      mkReq("PUT", "/tags/person", { relationships: ["not", "a", "map"] }),
      store,
      "/person",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("invalid_relationships");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  test("PUT /tags/:name returns 400 invalid_relationships for a top-level primitive", async () => {
    const res = await handleTags(
      mkReq("PUT", "/tags/person", { relationships: "just-a-string" as unknown as Record<string, unknown> }),
      store,
      "/person",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("invalid_relationships");
  });

  test("PUT /tags/:name returns 400 invalid_relationships for an empty relationship key", async () => {
    const res = await handleTags(
      mkReq("PUT", "/tags/person", { relationships: { "": { from: "a", to: "b" } } }),
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

  test("returns 409 ambiguous_path when source path is ambiguous (vault#331 N1)", async () => {
    // Two notes share path "Foo" differing by extension. handleFindPath's
    // resolveNote(source) would otherwise non-deterministically pick
    // one; post-#331 it throws AmbiguousPathError and the handler's
    // catch surfaces a structured 409 (same shape as handleNotes).
    await store.createNote("# md", { id: "foo-md", path: "Foo" });
    await store.createNote("a,b\n1,2", { id: "foo-csv", path: "Foo", extension: "csv" });
    await store.createNote("target", { id: "target" });
    const res = await handleFindPath(
      mkReq("GET", "/find-path?source=Foo&target=target"),
      store,
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error_type).toBe("ambiguous_path");
    expect(body.path).toBe("Foo");
    expect(body.candidates).toHaveLength(2);
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
    // `doctor` moved admin → read (re-tier): a read-only, tag-scope-
    // restricted diagnostic, visible to a plain vault:read session.
    expect(toolNames).toContain("doctor");
    // Mutation tools are hidden — filter applied before advertising
    expect(toolNames).not.toContain("create-note");
    expect(toolNames).not.toContain("update-note");
    expect(toolNames).not.toContain("delete-note");
    // Tag-schema/taxonomy tools moved write → admin (re-tier): hidden from
    // a vault:read (and, per the next describe block, a plain vault:write)
    // session — they now need vault:admin.
    expect(toolNames).not.toContain("update-tag");
    expect(toolNames).not.toContain("delete-tag");
    expect(toolNames).not.toContain("rename-tag");
    expect(toolNames).not.toContain("merge-tags");
    // Admin tools (vault#376) are hidden too
    expect(toolNames).not.toContain("manage-token");
    // Read tier is exactly 5 tools (doctor added by the re-tier).
    expect(toolNames.length).toBe(5);

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
    expect(body.result.content[0].text).toContain("vault:admin");

    // And critically: the vault description must NOT have been mutated.
    const cfg = readVaultConfig(vaultName);
    expect(cfg?.description).toBe("original description");

    closeAllStores();
  });

  test("tools/call of vault-info with description arg and vault:write scope is refused (re-tier: description-write now needs admin)", async () => {
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
    // Was `isError: false` pre-re-tier — a plain vault:write session could
    // update the vault's own description. Now needs vault:admin.
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("vault:admin");
    expect(readVaultConfig(vaultName)?.description).toBe("original");

    closeAllStores();
  });

  test("tools/call of vault-info with description arg and vault:admin scope is allowed", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig, readVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `scope-vault-info-admin-${Date.now()}`;
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
          arguments: { description: "updated via admin scope" },
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
    expect(body.result.isError).toBeFalsy();
    expect(readVaultConfig(vaultName)?.description).toBe("updated via admin scope");

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
    // Post-vault#376: hidden tools surface as "Unknown tool" rather than
    // a verb-specific Forbidden — see mcp-http.ts dispatch-against-
    // visibleTools rationale. The contract is: tools not in tools/list
    // also can't be called explicitly. (Differential errors would leak
    // the existence of admin-only tools to write-scope sessions.)
    expect(body.result.content[0].text).toContain("Unknown tool");
    expect(body.result.content[0].text).toContain("create-note");

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

// ===========================================================================
// vault#376 — Change 1: scope-filtered tool listing across all three tiers
// ===========================================================================

describe("MCP tools/list scope tiers (vault#376)", () => {
  async function listToolNames(scopes: string[], scopedTags: string[] | null = null, vaultPrefix = "scope-tier") {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `${vaultPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    const res = await handleScopedMcp(req, vaultName, {
      permission: scopes.includes("vault:write") || scopes.includes("vault:admin") ? "full" : "read",
      scopes,
      legacyDerived: false,
      scoped_tags: scopedTags,
    } as any);
    const body = await res.json() as any;
    const names: string[] = body.result.tools.map((t: any) => t.name);
    closeAllStores();
    return names;
  }

  test("vault:read sees exactly the 5 read tools (doctor moved admin → read)", async () => {
    const names = await listToolNames(["vault:read"]);
    expect(new Set(names)).toEqual(
      new Set(["query-notes", "list-tags", "find-path", "vault-info", "doctor"]),
    );
    expect(names.length).toBe(5);
  });

  test("vault:read + vault:write sees the 8 read+write tools (tag-schema tools moved write → admin)", async () => {
    const names = await listToolNames(["vault:read", "vault:write"]);
    expect(new Set(names)).toEqual(
      new Set([
        "query-notes",
        "list-tags",
        "find-path",
        "vault-info",
        "doctor",
        "create-note",
        "update-note",
        "delete-note",
      ]),
    );
    expect(names.length).toBe(8);
    expect(names).not.toContain("manage-token");
    // Re-tier (this PR): update-tag/delete-tag/rename-tag/merge-tags are now
    // admin-tier — structure/taxonomy curation, not content authorship.
    // Only delete-note (content) stays write-tier.
    expect(names).not.toContain("update-tag");
    expect(names).not.toContain("delete-tag");
    expect(names).not.toContain("rename-tag");
    expect(names).not.toContain("merge-tags");
    expect(names).toContain("delete-note");
  });

  test("vault:admin sees all 14 tools including manage-token + prune-schema + the tag-schema tools", async () => {
    const names = await listToolNames(["vault:read", "vault:write", "vault:admin"]);
    expect(names).toContain("manage-token");
    expect(names).toContain("prune-schema");
    expect(names).toContain("doctor");
    expect(names).toContain("update-tag");
    expect(names).toContain("delete-tag");
    expect(names).toContain("rename-tag");
    expect(names).toContain("merge-tags");
    expect(names.length).toBe(14);
  });

  test("legacy-derived full token sees all 14 tools (back-compat)", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `legacy-token-${Date.now()}`;
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    // Legacy permission-derived token: legacyDerived=true, scopes carry the
    // full admin set per `legacyPermissionToScopes("full")`. Compat shim
    // means the operator's existing pvt_* tokens minted pre-scope-column
    // see the full admin surface (including manage-token + prune-schema).
    const res = await handleScopedMcp(req, vaultName, {
      permission: "full",
      scopes: ["vault:read", "vault:write", "vault:admin"],
      legacyDerived: true,
      scoped_tags: null,
    } as any);
    const body = await res.json() as any;
    const names: string[] = body.result.tools.map((t: any) => t.name);
    expect(names.length).toBe(14);
    expect(names).toContain("manage-token");
    expect(names).toContain("prune-schema");
    expect(names).toContain("doctor");
    closeAllStores();
  });

  test("excluded tools surface as 'Unknown tool' if called explicitly", async () => {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `hidden-call-${Date.now()}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });

    // Write-scope session calling manage-token (admin-only): should look
    // like the tool doesn't exist, not "Forbidden: requires vault:admin".
    // Differential messages would leak the admin tool's existence.
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
        params: { name: "manage-token", arguments: { action: "list" } },
      }),
    });

    const res = await handleScopedMcp(req, vaultName, {
      permission: "full",
      scopes: ["vault:read", "vault:write"],
      legacyDerived: false,
      scoped_tags: null,
    } as any);
    const body = await res.json() as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Unknown tool");
    expect(body.result.content[0].text).toContain("manage-token");
    expect(body.result.content[0].text).not.toContain("vault:admin");
    closeAllStores();
  });
});

// ===========================================================================
// Write/admin re-tier — schema/taxonomy-curation tools moved write → admin,
// doctor moved admin → read. Content-authorship (write) is now separate from
// structure/taxonomy/schema-curation (admin). No new scope — same
// read/write/admin vocabulary, only which tier each tool requires moves.
// ===========================================================================

describe("MCP write/admin re-tier — scope enforcement at the tools/call layer", () => {
  async function callTool(
    vaultName: string,
    scopes: string[],
    name: string,
    args: Record<string, unknown>,
  ): Promise<any> {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const res = await handleScopedMcp(req, vaultName, {
      permission: scopes.includes("vault:write") || scopes.includes("vault:admin") ? "full" : "read",
      scopes,
      legacyDerived: false,
      scoped_tags: null,
    } as any);
    return res.json();
  }

  test("vault:write CAN create-note but is DENIED rename-tag/merge-tags/delete-tag/update-tag (now admin-tier)", async () => {
    const { writeVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `retier-write-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore(vaultName);
    await store.createNote("seed", { tags: ["mine"] });

    const WRITE = ["vault:read", "vault:write"];

    // Allowed: content authorship.
    const create = await callTool(vaultName, WRITE, "create-note", { content: "hello", tags: ["mine"] });
    expect(create.result?.isError).toBeFalsy();

    // Denied: each now requires vault:admin, not vault:write.
    const rename = await callTool(vaultName, WRITE, "rename-tag", { old_name: "mine", new_name: "mine2" });
    expect(rename.result?.isError).toBe(true);
    expect(rename.result.content[0].text).toContain("Unknown tool");

    const merge = await callTool(vaultName, WRITE, "merge-tags", { sources: ["mine"], target: "mine2" });
    expect(merge.result?.isError).toBe(true);
    expect(merge.result.content[0].text).toContain("Unknown tool");

    const del = await callTool(vaultName, WRITE, "delete-tag", { tag: "mine" });
    expect(del.result?.isError).toBe(true);
    expect(del.result.content[0].text).toContain("Unknown tool");

    const upd = await callTool(vaultName, WRITE, "update-tag", { tag: "mine", description: "hijacked" });
    expect(upd.result?.isError).toBe(true);
    expect(upd.result.content[0].text).toContain("Unknown tool");

    // Untouched — the denied calls above never reached core. "mine" already
    // has a bare identity row (auto-inserted when the seed note was tagged),
    // but its description is still unset — update-tag never ran.
    expect((await store.getTagRecord("mine"))?.description ?? null).toBeNull();
    const stillThere = await store.listTags();
    expect(stillThere.some((t) => t.name === "mine")).toBe(true);

    closeAllStores();
  });

  test("vault:read CAN run doctor (now read-tier)", async () => {
    const { writeVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `retier-read-doctor-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString() });

    const result = await callTool(vaultName, ["vault:read"], "doctor", {});
    expect(result.result?.isError).toBeFalsy();
    const report = JSON.parse(result.result.content[0].text);
    expect(report.findings).toBeDefined();
    expect(report.summary).toBeDefined();

    closeAllStores();
  });

  test("vault:write is DENIED the vault-info description write (now admin-tier)", async () => {
    const { writeVaultConfig, readVaultConfig } = await import("./config.ts");
    const { closeAllStores } = await import("./vault-store.ts");

    const vaultName = `retier-write-vaultinfo-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString(), description: "orig" });

    const result = await callTool(vaultName, ["vault:read", "vault:write"], "vault-info", { description: "nope" });
    expect(result.result?.isError).toBe(true);
    expect(result.result.content[0].text).toContain("vault:admin");
    expect(readVaultConfig(vaultName)?.description).toBe("orig");

    closeAllStores();
  });

  test("vault:admin CAN do all of the above — create-note, rename/merge/delete/update-tag, doctor, and the vault-info description write", async () => {
    const { writeVaultConfig, readVaultConfig } = await import("./config.ts");
    const { getVaultStore, closeAllStores } = await import("./vault-store.ts");

    const vaultName = `retier-admin-${Date.now()}`;
    writeVaultConfig({ name: vaultName, api_keys: [], created_at: new Date().toISOString(), description: "orig" });
    const store = getVaultStore(vaultName);
    await store.upsertTagRecord("a", {});
    await store.upsertTagRecord("b", {});
    await store.createNote("seed", { tags: ["a"] });

    const ADMIN = ["vault:read", "vault:write", "vault:admin"];

    const create = await callTool(vaultName, ADMIN, "create-note", { content: "hello", tags: ["a"] });
    expect(create.result?.isError).toBeFalsy();

    const upd = await callTool(vaultName, ADMIN, "update-tag", { tag: "a", description: "updated" });
    expect(upd.result?.isError).toBeFalsy();

    const doctor = await callTool(vaultName, ADMIN, "doctor", {});
    expect(doctor.result?.isError).toBeFalsy();

    const vinfo = await callTool(vaultName, ADMIN, "vault-info", { description: "updated via admin" });
    expect(vinfo.result?.isError).toBeFalsy();
    expect(readVaultConfig(vaultName)?.description).toBe("updated via admin");

    const merge = await callTool(vaultName, ADMIN, "merge-tags", { sources: ["b"], target: "a" });
    expect(merge.result?.isError).toBeFalsy();

    const del = await callTool(vaultName, ADMIN, "delete-tag", { tag: "a" });
    expect(del.result?.isError).toBeFalsy();

    closeAllStores();
  });
});

// ===========================================================================
// vault#376 — Change 2: manage-token mint/revoke/list
// ===========================================================================

describe("manage-token MCP tool (vault#403, MGT — hub-JWT attenuation proxy)", () => {
  // A JWT-shaped bearer the session presents; the manage-token mint path only
  // forwards JWT-shaped credentials, so tests must thread one through.
  const JWT_BEARER = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.sig";

  // --- Hub fetch stub --------------------------------------------------------
  // mintAction/revokeAction call mintHubJwt/revokeHubJwt, which use global
  // fetch (no fetchImpl seam on that path). Each test installs a stub that
  // records the requests and returns a canned hub response. We capture every
  // call so assertions can inspect the URL / Authorization header / body.
  let realFetch: typeof globalThis.fetch;
  let hubCalls: Array<{ url: string; init: RequestInit | undefined; body: any }>;
  let mintSeq: number;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    hubCalls = [];
    mintSeq = 0;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Install a hub stub that mints a fresh jti per mint + idempotent revoke. */
  function installHubStub(opts?: { revokeFails?: "network" | "api-error" }) {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      let body: any = undefined;
      try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch {}
      hubCalls.push({ url, init, body });
      if (url.endsWith("/api/auth/mint-token")) {
        const jti = `hub_jti_${++mintSeq}`;
        const ttl = typeof body?.expires_in === "number" ? body.expires_in : 900;
        return new Response(
          JSON.stringify({
            jti,
            token: `eyJ.minted.${jti}`,
            expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
            scope: body?.scope ?? "",
            ...(body?.permissions ? { permissions: body.permissions } : {}),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/auth/revoke-token")) {
        if (opts?.revokeFails === "network") throw new Error("connection refused");
        if (opts?.revokeFails === "api-error") {
          return new Response(
            JSON.stringify({ error: "insufficient_scope", error_description: "bearer lacks parachute:host:auth" }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ jti: body?.jti, revoked_at: new Date().toISOString() }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof globalThis.fetch;
  }

  async function callTool(
    vaultName: string,
    auth: any,
    toolName: string,
    args: Record<string, unknown>,
    callerBearer: string | null = JWT_BEARER,
  ) {
    const { handleScopedMcp } = await import("./mcp-http.ts");
    const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        ...(callerBearer ? { authorization: `Bearer ${callerBearer}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
    const res = await handleScopedMcp(req, vaultName, auth, callerBearer);
    const body = await res.json() as any;
    if (body.result?.content?.[0]?.text) {
      try {
        return { isError: !!body.result.isError, parsed: JSON.parse(body.result.content[0].text), raw: body };
      } catch {
        return { isError: !!body.result.isError, parsed: null, raw: body, text: body.result.content[0].text };
      }
    }
    return { isError: false, parsed: null, raw: body };
  }

  async function setupAdminSession(prefix: string, scopedTags: string[] | null = null) {
    const { writeVaultConfig } = await import("./config.ts");
    const vaultName = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
    });
    // Stable caller_jti so the session-pinned ledger can attribute mints.
    // Scopes carry the resource-narrowed admin scope so validateMintedScopes +
    // the visibility filter pass for THIS vault.
    const auth: any = {
      permission: "full",
      scopes: [`vault:${vaultName}:read`, `vault:${vaultName}:write`, `vault:${vaultName}:admin`],
      legacyDerived: false,
      scoped_tags: scopedTags,
      vault_name: vaultName,
      caller_jti: `t_session${Math.random().toString(36).slice(2, 12)}`,
    };
    return { vaultName, auth };
  }

  test("mint proxies to hub mint-token with caller bearer + narrowed scope + ttl", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("mint-proxy");
    const { closeAllStores } = await import("./vault-store.ts");
    const { parsed } = await callTool(vaultName, auth, "manage-token", {
      action: "mint",
      scope: "vault:read",
    });
    expect(parsed.action).toBe("mint");
    // Token is now a hub JWT (not pvt_*); jti is hub's returned jti.
    expect(parsed.token).toMatch(/^eyJ\.minted\./);
    expect(parsed.jti).toBe("hub_jti_1");
    expect(parsed.scopes).toEqual([`vault:${vaultName}:read`]);
    expect(parsed.vault_name).toBe(vaultName);
    // One hub mint-token call carrying the caller bearer + narrowed scope.
    const mint = hubCalls.find((c) => c.url.endsWith("/api/auth/mint-token"));
    expect(mint).toBeDefined();
    const headers = new Headers(mint!.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${JWT_BEARER}`);
    expect(mint!.body.scope).toBe(`vault:${vaultName}:read`);
    expect(mint!.body.expires_in).toBe(900);
    expect(mint!.body.permissions).toBeUndefined(); // unscoped caller
    closeAllStores();
  });

  test("mint with custom TTL=3600 forwards expires_in=3600", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("mint-max");
    const { closeAllStores } = await import("./vault-store.ts");
    await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:read", ttl_seconds: 3600 });
    const mint = hubCalls.find((c) => c.url.endsWith("/api/auth/mint-token"));
    expect(mint!.body.expires_in).toBe(3600);
    closeAllStores();
  });

  test("tag-scoped caller's mint includes permissions.scoped_tags", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("mint-scoped", ["task", "project"]);
    const { closeAllStores } = await import("./vault-store.ts");
    const { parsed } = await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:read" });
    expect(parsed.scoped_tags).toEqual(["task", "project"]);
    const mint = hubCalls.find((c) => c.url.endsWith("/api/auth/mint-token"));
    expect(mint!.body.permissions).toEqual({ scoped_tags: ["task", "project"] });
    closeAllStores();
  });

  test("mint with TTL=0 is rejected locally (no hub call)", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("mint-zero");
    const { closeAllStores } = await import("./vault-store.ts");
    const { parsed } = await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:read", ttl_seconds: 0 });
    expect(parsed.error).toBe("invalid_request");
    expect(hubCalls.length).toBe(0);
    closeAllStores();
  });

  test("mint with TTL=3601 is rejected locally (over the 3600 cap)", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("mint-over");
    const { closeAllStores } = await import("./vault-store.ts");
    const { parsed } = await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:read", ttl_seconds: 3601 });
    expect(parsed.error).toBe("invalid_request");
    expect(hubCalls.length).toBe(0);
    closeAllStores();
  });

  test("cross-vault / over-scope request is rejected locally (no hub call)", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("mint-subset");
    const { closeAllStores } = await import("./vault-store.ts");
    const { parsed } = await callTool(vaultName, auth, "manage-token", {
      action: "mint",
      scope: "vault:other-vault:write",
    });
    expect(parsed.error).toBe("forbidden");
    expect(parsed.rejected).toBeDefined();
    expect(hubCalls.length).toBe(0);
    closeAllStores();
  });

  test("non-forwardable session (no JWT bearer) → clear mint error, no hub call", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("mint-nonfwd");
    const { closeAllStores } = await import("./vault-store.ts");
    // Env-var operator path: caller_jti present but the presented credential
    // is a non-JWT secret → mint must refuse with a hub-JWT-required message.
    const { parsed } = await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:read" }, "operator-env-secret");
    expect(parsed.error).toBe("forbidden");
    expect(parsed.message).toContain("hub-JWT session");
    expect(hubCalls.length).toBe(0);
    closeAllStores();
  });

  test("revoke own minted jti posts to hub revoke-token + idempotent second revoke", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("revoke-idem");
    const { closeAllStores } = await import("./vault-store.ts");
    const mint = await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:read" });
    const jti = mint.parsed.jti;
    const first = await callTool(vaultName, auth, "manage-token", { action: "revoke", jti });
    expect(first.parsed.ok).toBe(true);
    expect(first.parsed.already_revoked).toBe(false);
    // First revoke posted to hub revoke-token with the caller bearer + jti.
    const revoke = hubCalls.find((c) => c.url.endsWith("/api/auth/revoke-token"));
    expect(revoke).toBeDefined();
    expect(revoke!.body.jti).toBe(jti);
    expect(new Headers(revoke!.init?.headers).get("authorization")).toBe(`Bearer ${JWT_BEARER}`);
    // Second revoke is idempotent and does NOT re-hit hub (already revoked locally).
    const revokeCallsBefore = hubCalls.filter((c) => c.url.endsWith("/api/auth/revoke-token")).length;
    const second = await callTool(vaultName, auth, "manage-token", { action: "revoke", jti });
    expect(second.parsed.ok).toBe(true);
    expect(second.parsed.already_revoked).toBe(true);
    const revokeCallsAfter = hubCalls.filter((c) => c.url.endsWith("/api/auth/revoke-token")).length;
    expect(revokeCallsAfter).toBe(revokeCallsBefore);
    closeAllStores();
  });

  test("cannot revoke another session's jti (session-pinned)", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("revoke-other");
    const { closeAllStores, getVaultStore } = await import("./vault-store.ts");
    const { recordMcpMintLedger } = await import("./token-store.ts");
    // Seed a ledger row attributed to a DIFFERENT session.
    const store = getVaultStore(vaultName);
    recordMcpMintLedger(store.db, {
      jti: "hub_jti_other",
      parentJti: "t_othersession",
      vaultName,
      label: "other",
      scopes: [`vault:${vaultName}:read`],
      scopedTags: null,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    const { parsed } = await callTool(vaultName, auth, "manage-token", { action: "revoke", jti: "hub_jti_other" });
    // Not in THIS session's ledger → idempotent ok=true, but NO hub revoke call.
    expect(parsed.ok).toBe(true);
    expect(hubCalls.filter((c) => c.url.endsWith("/api/auth/revoke-token")).length).toBe(0);
    closeAllStores();
  });

  test("list returns this session's hub-JWT mints, not other sessions'", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("list-session");
    const { closeAllStores, getVaultStore } = await import("./vault-store.ts");
    const { recordMcpMintLedger } = await import("./token-store.ts");

    const m1 = await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:read", description: "alpha" });
    const m2 = await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:read", description: "beta" });

    // Seed another session's ledger row — must NOT appear in this list.
    const store = getVaultStore(vaultName);
    recordMcpMintLedger(store.db, {
      jti: "hub_jti_foreign",
      parentJti: "t_othersession",
      vaultName,
      label: "other-session-mint",
      scopes: [`vault:${vaultName}:read`],
      scopedTags: null,
      expiresAt: null,
    });

    const { parsed } = await callTool(vaultName, auth, "manage-token", { action: "list" });
    expect(parsed.action).toBe("list");
    const jtis = parsed.tokens.map((t: any) => t.jti);
    expect(jtis).toContain(m1.parsed.jti);
    expect(jtis).toContain(m2.parsed.jti);
    expect(jtis).not.toContain("hub_jti_foreign");
    expect(parsed.tokens.length).toBe(2);
    closeAllStores();
  });

  test("ledger row records parent_jti + hub jti for the minting session", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("ledger");
    const { closeAllStores, getVaultStore } = await import("./vault-store.ts");
    const { parsed } = await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:read" });
    const store = getVaultStore(vaultName);
    const row = store.db.prepare(
      "SELECT jti, parent_jti, vault_name FROM mcp_mint_ledger WHERE jti = ?",
    ).get(parsed.jti) as { jti: string; parent_jti: string; vault_name: string };
    expect(row.jti).toBe(parsed.jti);
    expect(row.parent_jti).toBe(auth.caller_jti);
    expect(row.vault_name).toBe(vaultName);
    closeAllStores();
  });

  // hub#454 made `vault:<N>:admin` sufficient to revoke an in-authority jti
  // (capability attenuation, symmetric to mint), so the hub round-trip is now
  // the expected-SUCCESS path. This asserts the success contract end-to-end:
  // the caller's `vault:<N>:admin` bearer is forwarded, hub returns 200, and
  // the local ledger row is flipped to revoked.
  test("revoke success path: caller's vault:admin bearer revokes at hub + marks ledger (hub#454)", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("revoke-success");
    const { closeAllStores, getVaultStore } = await import("./vault-store.ts");
    const mint = await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:admin" });
    const jti = mint.parsed.jti;

    const res = await callTool(vaultName, auth, "manage-token", { action: "revoke", jti });
    expect(res.parsed.ok).toBe(true);
    expect(res.parsed.already_revoked).toBe(false);
    expect(res.parsed.error).toBeUndefined();

    // Hub revoke-token was called with the caller's vault:admin bearer + jti.
    const revoke = hubCalls.find((c) => c.url.endsWith("/api/auth/revoke-token"));
    expect(revoke).toBeDefined();
    expect(revoke!.body.jti).toBe(jti);
    expect(new Headers(revoke!.init?.headers).get("authorization")).toBe(`Bearer ${JWT_BEARER}`);

    // Local ledger row is now marked revoked.
    const store = getVaultStore(vaultName);
    const row = store.db.prepare(
      "SELECT revoked_at FROM mcp_mint_ledger WHERE jti = ?",
    ).get(jti) as { revoked_at: string | null };
    expect(row.revoked_at).not.toBeNull();
    closeAllStores();
  });

  test("caller_jti: null session → list returns empty", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("null-list");
    const { closeAllStores } = await import("./vault-store.ts");
    // Env-var operator / legacy session: no stable session id.
    auth.caller_jti = null;
    const { parsed } = await callTool(vaultName, auth, "manage-token", { action: "list" });
    expect(parsed.action).toBe("list");
    expect(parsed.tokens).toEqual([]);
    closeAllStores();
  });

  test("caller_jti: null session → revoke returns not_found, no hub call", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("null-revoke");
    const { closeAllStores } = await import("./vault-store.ts");
    auth.caller_jti = null;
    const { parsed } = await callTool(vaultName, auth, "manage-token", { action: "revoke", jti: "hub_jti_anything" });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("not_found");
    expect(hubCalls.filter((c) => c.url.endsWith("/api/auth/revoke-token")).length).toBe(0);
    closeAllStores();
  });

  test("list isolation across vaults: vault-A session never sees a vault-B ledger row", async () => {
    installHubStub();
    const { vaultName, auth } = await setupAdminSession("list-vault-iso");
    const { closeAllStores, getVaultStore } = await import("./vault-store.ts");
    const { recordMcpMintLedger } = await import("./token-store.ts");

    // Mint one in THIS (vault-A) session.
    const m1 = await callTool(vaultName, auth, "manage-token", { action: "mint", scope: "vault:read" });

    // Seed a ledger row attributed to the SAME parent_jti but a DIFFERENT
    // vault — the list query scopes on (parent_jti, vault_name), so this
    // foreign-vault row must not leak into vault-A's list.
    const store = getVaultStore(vaultName);
    recordMcpMintLedger(store.db, {
      jti: "hub_jti_vaultB",
      parentJti: auth.caller_jti, // same session id, different vault
      vaultName: `${vaultName}-OTHER`,
      label: "vault-B mint",
      scopes: [`vault:${vaultName}-OTHER:read`],
      scopedTags: null,
      expiresAt: null,
    });

    const { parsed } = await callTool(vaultName, auth, "manage-token", { action: "list" });
    const jtis = parsed.tokens.map((t: any) => t.jti);
    expect(jtis).toContain(m1.parsed.jti);
    expect(jtis).not.toContain("hub_jti_vaultB");
    expect(parsed.tokens.length).toBe(1);
    closeAllStores();
  });

  // INSERT OR IGNORE (not OR REPLACE): a duplicate jti record (a hub jti
  // collision — shouldn't happen) must NOT overwrite the existing row, because
  // that would silently reset a previously-set revoked_at and resurrect a
  // revoked token.
  test("recordMcpMintLedger duplicate jti preserves the existing row's revoked_at", async () => {
    const { vaultName, auth } = await setupAdminSession("ledger-dup");
    const { closeAllStores, getVaultStore } = await import("./vault-store.ts");
    const { recordMcpMintLedger, markMcpMintLedgerRevoked, findMcpMintLedgerEntry } =
      await import("./token-store.ts");
    const store = getVaultStore(vaultName);

    recordMcpMintLedger(store.db, {
      jti: "hub_jti_dup",
      parentJti: auth.caller_jti,
      vaultName,
      label: "first",
      scopes: [`vault:${vaultName}:read`],
      scopedTags: null,
      expiresAt: null,
    });
    // Revoke it (sets revoked_at).
    markMcpMintLedgerRevoked(store.db, "hub_jti_dup", auth.caller_jti, vaultName);
    const before = findMcpMintLedgerEntry(store.db, "hub_jti_dup", auth.caller_jti, vaultName);
    expect(before!.revoked_at).not.toBeNull();

    // A second record with the same jti must be IGNORED — revoked_at survives.
    recordMcpMintLedger(store.db, {
      jti: "hub_jti_dup",
      parentJti: auth.caller_jti,
      vaultName,
      label: "second (collision)",
      scopes: [`vault:${vaultName}:read`],
      scopedTags: null,
      expiresAt: null,
    });
    const after = findMcpMintLedgerEntry(store.db, "hub_jti_dup", auth.caller_jti, vaultName);
    expect(after!.revoked_at).toBe(before!.revoked_at); // unchanged, not reset to NULL
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

  // RFC 7235: the auth-scheme token is case-insensitive (V1.4). A client
  // sending `bearer`/`BEARER`/`BeArEr` must authenticate identically to
  // one sending the canonical `Bearer` — only the credentials that follow
  // the scheme are case-sensitive, and those come through verbatim.
  test("extracts from a lowercase `bearer` scheme (RFC 7235 case-insensitivity)", () => {
    const req = new Request("http://localhost/api/notes", {
      headers: { Authorization: "bearer pvt_abc123" },
    });
    expect(extractApiKey(req)).toBe("pvt_abc123");
  });

  test("extracts from a mixed-case `BeArEr` scheme", () => {
    const req = new Request("http://localhost/api/notes", {
      headers: { Authorization: "BeArEr pvt_abc123" },
    });
    expect(extractApiKey(req)).toBe("pvt_abc123");
  });

  test("the token itself stays case-sensitive — only the scheme is folded", () => {
    const req = new Request("http://localhost/api/notes", {
      headers: { Authorization: "bearer PvT_MixedCase123" },
    });
    expect(extractApiKey(req)).toBe("PvT_MixedCase123");
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

describe("handleVault: auto_transcribe (per-vault)", async () => {
  function mkVaultReq(method: string, body?: unknown): Request {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    return new Request(`${BASE}/vault`, init);
  }

  test("GET reflects the per-vault auto_transcribe.enabled when set", async () => {
    const cfg = { name: "vaultA", auto_transcribe: { enabled: false } };
    const res = await handleVault(mkReq("GET", "/vault"), store, cfg as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // The vault's OWN value wins over global — per-vault → global → true.
    expect(body.config.auto_transcribe.enabled).toBe(false);
  });

  test("GET reflects per-vault true override even if global is off", async () => {
    const cfg = { name: "vaultA", auto_transcribe: { enabled: true } };
    const res = await handleVault(mkReq("GET", "/vault"), store, cfg as any);
    const body = await res.json() as any;
    expect(body.config.auto_transcribe.enabled).toBe(true);
  });

  test("PATCH writes auto_transcribe to THIS vault's config object (per-vault)", async () => {
    const cfg: { name: string; auto_transcribe?: { enabled?: boolean } } = { name: "vaultA" };
    let persisted = 0;
    const res = await handleVault(
      mkVaultReq("PATCH", { config: { auto_transcribe: { enabled: true } } }),
      store,
      cfg as any,
      () => { persisted++; },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.config.auto_transcribe.enabled).toBe(true);
    // Persisted onto the per-vault config object (writeVaultConfig path),
    // NOT a server-wide global — this is the field the worker reads per-vault.
    expect(cfg.auto_transcribe?.enabled).toBe(true);
    expect(persisted).toBe(1);

    // GET round-trips the persisted per-vault value.
    const getRes = await handleVault(mkReq("GET", "/vault"), store, cfg as any);
    const getBody = await getRes.json() as any;
    expect(getBody.config.auto_transcribe.enabled).toBe(true);
  });

  test("enabling vault X does NOT affect vault Y (genuinely per-vault)", async () => {
    const vaultX: { name: string; auto_transcribe?: { enabled?: boolean } } = { name: "vaultX" };
    const vaultY: { name: string; auto_transcribe?: { enabled?: boolean } } = { name: "vaultY" };

    // Link scribe to X only.
    await handleVault(
      mkVaultReq("PATCH", { config: { auto_transcribe: { enabled: true } } }),
      store,
      vaultX as any,
      () => {},
    );

    expect(vaultX.auto_transcribe?.enabled).toBe(true);
    // Y is untouched — no global toggle was flipped, so Y still has no
    // per-vault override (the old global-write behavior would have moved Y too).
    expect(vaultY.auto_transcribe).toBeUndefined();
  });

  test("PATCH accepts auto_transcribe.enabled=false", async () => {
    const cfg: { name: string; auto_transcribe?: { enabled?: boolean } } = {
      name: "vaultA",
      auto_transcribe: { enabled: true },
    };
    const res = await handleVault(
      mkVaultReq("PATCH", { config: { auto_transcribe: { enabled: false } } }),
      store,
      cfg as any,
      () => {},
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.config.auto_transcribe.enabled).toBe(false);
    expect(cfg.auto_transcribe?.enabled).toBe(false);
  });

  test("PATCH rejects a non-boolean enabled with 400 and does not mutate or persist", async () => {
    const cfg: { name: string; auto_transcribe?: { enabled?: boolean } } = {
      name: "vaultA",
      auto_transcribe: { enabled: true },
    };
    let persisted = 0;
    const res = await handleVault(
      mkVaultReq("PATCH", { config: { auto_transcribe: { enabled: "yes" } } }),
      store,
      cfg as any,
      () => { persisted++; },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("invalid_auto_transcribe");
    // Unchanged — the bad write never landed.
    expect(cfg.auto_transcribe?.enabled).toBe(true);
    expect(persisted).toBe(0);
  });

  test("PATCH rejects auto_transcribe missing enabled with 400", async () => {
    const cfg = { name: "vaultA" } as { name: string };
    let persisted = 0;
    const res = await handleVault(
      mkVaultReq("PATCH", { config: { auto_transcribe: {} } }),
      store,
      cfg as any,
      () => { persisted++; },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("invalid_auto_transcribe");
    expect(persisted).toBe(0);
  });

  test("auto_transcribe and audio_retention can be set in one PATCH (single persist)", async () => {
    const cfg: { name: string; audio_retention?: string; auto_transcribe?: { enabled?: boolean } } = {
      name: "vaultA",
    };
    let persisted = 0;
    const res = await handleVault(
      mkVaultReq("PATCH", {
        config: { audio_retention: "until_transcribed", auto_transcribe: { enabled: true } },
      }),
      store,
      cfg as any,
      () => { persisted++; },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.config.audio_retention).toBe("until_transcribed");
    expect(body.config.auto_transcribe.enabled).toBe(true);
    expect(cfg.audio_retention).toBe("until_transcribed");
    expect(cfg.auto_transcribe?.enabled).toBe(true);
    // Both fields persisted in one writeVaultConfig call.
    expect(persisted).toBe(1);
  });

});

describe("handleVault: transcription capability (scribe-fold Phase 1)", async () => {
  test("GET surfaces transcription: { enabled, provider } when a provider is available", async () => {
    const cfg = { name: "default" } as { name: string };
    const res = await handleVault(
      mkReq("GET", "/vault"),
      store,
      cfg as any,
      undefined,
      async () => ({ enabled: true, provider: "scribe-http" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.transcription).toEqual({ enabled: true, provider: "scribe-http" });
  });

  test("GET surfaces transcription.enabled=false when no provider is available (no crash)", async () => {
    const cfg = { name: "default" } as { name: string };
    const res = await handleVault(
      mkReq("GET", "/vault"),
      store,
      cfg as any,
      undefined,
      async () => ({ enabled: false }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.transcription).toEqual({ enabled: false });
    expect(body.transcription.provider).toBeUndefined();
  });

  test("capability is a distinct axis from the auto_transcribe policy toggle", async () => {
    // A vault with auto_transcribe.enabled=true but NO provider available still
    // reports transcription.enabled=false — the mic should be gated on
    // capability, not policy.
    const cfg = { name: "default", auto_transcribe: { enabled: true } };
    const res = await handleVault(
      mkReq("GET", "/vault"),
      store,
      cfg as any,
      undefined,
      async () => ({ enabled: false }),
    );
    const body = await res.json() as any;
    expect(body.config.auto_transcribe.enabled).toBe(true);
    expect(body.transcription.enabled).toBe(false);
  });
});

describe("handleVault: front-door structural map", async () => {
  test("GET always includes `map` — no ?include_stats needed", async () => {
    await store.createNote("a", { tags: ["person"], path: "People/Alice" });
    await store.createNote("b", { tags: ["person"] }); // no path

    const cfg = { name: "default" } as { name: string };
    const res = await handleVault(mkReq("GET", "/vault"), store, cfg as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.stats).toBeUndefined();
    expect(body.map).toBeTruthy();
    expect(body.map.total_notes).toBe(2);
    expect(body.map.tags).toEqual([{ name: "person", count: 2 }]);
    expect(body.map.path_buckets).toEqual([{ name: "People", count: 1 }]);
    expect(body.map.unfiled_notes).toBe(1);
  });

  test("?include_stats=true adds stats ALONGSIDE map, not instead of it", async () => {
    await store.createNote("a", { tags: ["person"] });
    const cfg = { name: "default" } as { name: string };
    const res = await handleVault(mkReq("GET", "/vault?include_stats=true"), store, cfg as any);
    const body = await res.json() as any;
    expect(body.stats).toBeTruthy();
    expect(body.map).toBeTruthy();
  });

  test("a tag-scoped caller's map covers only notes reachable through an in-scope tag", async () => {
    await store.createNote("a", { tags: ["work"], path: "Work/One" });
    await store.createNote("b", { tags: ["work"] }); // no path
    await store.createNote("c", { tags: ["personal"], path: "Personal/Two" });

    const cfg = { name: "default" } as { name: string };
    const scope: TagScopeCtx = { allowed: await expandTokenTagScope(store, ["work"]), raw: ["work"] };
    const res = await handleVault(mkReq("GET", "/vault"), store, cfg as any, undefined, undefined, scope);
    const body = await res.json() as any;

    expect(body.map.total_notes).toBe(2); // a, b — "c" (personal) excluded
    expect(body.map.tags).toEqual([{ name: "work", count: 2 }]);
    expect(body.map.path_buckets).toEqual([{ name: "Work", count: 1 }]);
    expect(body.map.unfiled_notes).toBe(1);
  });

  test("a tag-scoped caller whose allowlist matches nothing gets an all-zero map, not the full vault", async () => {
    await store.createNote("a", { tags: ["work"], path: "Work/One" });

    const cfg = { name: "default" } as { name: string };
    const scope: TagScopeCtx = { allowed: await expandTokenTagScope(store, ["nonexistent"]), raw: ["nonexistent"] };
    const res = await handleVault(mkReq("GET", "/vault"), store, cfg as any, undefined, undefined, scope);
    const body = await res.json() as any;

    expect(body.map).toEqual({ total_notes: 0, tags: [], path_buckets: [], unfiled_notes: 0 });
  });
});

