/**
 * Vault store management — opens and caches per-vault SQLite stores.
 *
 * Uses core's schema, seed, and operations with a bun:sqlite compat wrapper.
 */

import { initSchema } from "../core/src/schema.ts";
import { seedBuiltins } from "../core/src/seed.ts";
import * as noteOps from "../core/src/notes.ts";
import * as linkOps from "../core/src/links.ts";
import type { Store, Note, Link, Attachment, QueryOpts } from "../core/src/types.ts";
import { openVaultDb, type CompatDatabase } from "./db.ts";

/**
 * BunStore: implements the core Store interface using bun:sqlite
 * via CompatDatabase.
 */
export class BunStore implements Store {
  public readonly db: CompatDatabase;

  constructor(db: CompatDatabase) {
    this.db = db;
    initSchema(db as any);
    seedBuiltins(db as any);
  }

  createNote(content: string, opts?: { id?: string; path?: string; tags?: string[] }): Note {
    return noteOps.createNote(this.db as any, content, opts);
  }

  getNote(id: string): Note | null {
    return noteOps.getNote(this.db as any, id);
  }

  updateNote(id: string, updates: { content?: string; path?: string }): Note {
    return noteOps.updateNote(this.db as any, id, updates);
  }

  deleteNote(id: string): void {
    noteOps.deleteNote(this.db as any, id);
  }

  queryNotes(opts: QueryOpts): Note[] {
    return noteOps.queryNotes(this.db as any, opts);
  }

  searchNotes(query: string, opts?: { tags?: string[]; limit?: number }): Note[] {
    return noteOps.searchNotes(this.db as any, query, opts);
  }

  tagNote(noteId: string, tags: string[]): void {
    noteOps.tagNote(this.db as any, noteId, tags);
  }

  untagNote(noteId: string, tags: string[]): void {
    noteOps.untagNote(this.db as any, noteId, tags);
  }

  listTags(): { name: string; count: number }[] {
    return noteOps.listTags(this.db as any);
  }

  createLink(sourceId: string, targetId: string, relationship: string): Link {
    return linkOps.createLink(this.db as any, sourceId, targetId, relationship);
  }

  deleteLink(sourceId: string, targetId: string, relationship: string): void {
    linkOps.deleteLink(this.db as any, sourceId, targetId, relationship);
  }

  getLinks(noteId: string, opts?: { direction?: "outbound" | "inbound" | "both" }): Link[] {
    return linkOps.getLinks(this.db as any, noteId, opts);
  }

  addAttachment(noteId: string, filePath: string, mimeType: string): Attachment {
    const id = noteOps.generateId();
    const now = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO attachments (id, note_id, path, mime_type, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, noteId, filePath, mimeType, now);
    return { id, noteId, path: filePath, mimeType, createdAt: now };
  }

  getAttachments(noteId: string): Attachment[] {
    const rows = this.db.prepare(
      "SELECT * FROM attachments WHERE note_id = ? ORDER BY created_at",
    ).all(noteId) as { id: string; note_id: string; path: string; mime_type: string; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      noteId: r.note_id,
      path: r.path,
      mimeType: r.mime_type,
      createdAt: r.created_at,
    }));
  }
}

/** Cache of open vault stores. */
const stores = new Map<string, BunStore>();

/** Get or create a BunStore for a vault. */
export function getVaultStore(name: string): BunStore {
  let store = stores.get(name);
  if (!store) {
    const db = openVaultDb(name);
    store = new BunStore(db);
    stores.set(name, store);
  }
  return store;
}

/** Close all open stores. */
export function closeAllStores(): void {
  for (const [, store] of stores) {
    store.db.close();
  }
  stores.clear();
}
