/**
 * Tests for the multi-vault system using bun:sqlite.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BunStore } from "./vault-store.ts";
import { generateVaultMcpTools } from "./mcp-tools.ts";
import type { VaultConfig } from "./config.ts";

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

  test("returns null when no path exists", () => {
    const a = store.createNote("A");
    const b = store.createNote("B");
    // No link between them

    const result = store.findPath(a.id, b.id);
    expect(result).toBeNull();
  });
});

describe("MCP tools", () => {
  test("generates all 16 tools", () => {
    const config: VaultConfig = {
      name: "test",
      api_keys: [],
      created_at: new Date().toISOString(),
    };
    const tools = generateVaultMcpTools(db, config);
    expect(tools.length).toBe(16);

    const names = tools.map((t) => t.name);
    expect(names).toContain("create-note");
    expect(names).toContain("create-notes");
    expect(names).toContain("batch-tag");
    expect(names).toContain("batch-untag");
    expect(names).toContain("traverse-links");
    expect(names).toContain("find-path");
    expect(names).toContain("list-tags");
    // No template-specific tools — templates are just notes tagged #template
  });

  test("enriches descriptions with vault hints", () => {
    const config: VaultConfig = {
      name: "work",
      description: "Work knowledge base",
      tool_hints: {
        "create-note": "Always tag work notes with #work",
      },
      api_keys: [],
      created_at: new Date().toISOString(),
    };
    const tools = generateVaultMcpTools(db, config);
    const createNote = tools.find((t) => t.name === "create-note")!;
    expect(createNote.description).toContain("[Vault: work]");
    expect(createNote.description).toContain("Work knowledge base");
    expect(createNote.description).toContain("Always tag work notes with #work");
  });

  test("create-note tool works via execute", () => {
    const config: VaultConfig = {
      name: "test",
      api_keys: [],
      created_at: new Date().toISOString(),
    };
    const tools = generateVaultMcpTools(db, config);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = createNote.execute({ content: "MCP note", tags: ["daily"] }) as any;
    expect(result.content).toBe("MCP note");
    expect(result.tags).toContain("daily");
  });

});
