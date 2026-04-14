import { Database } from "bun:sqlite";
import type { Store, Note, Link, Attachment, QueryOpts } from "./types.js";
import { initSchema } from "./schema.js";
import * as noteOps from "./notes.js";
import * as linkOps from "./links.js";
import * as tagSchemaOps from "./tag-schemas.js";
import { syncWikilinks, resolveUnresolvedWikilinks } from "./wikilinks.js";
import { pathTitle } from "./paths.js";
import { HookRegistry } from "./hooks.js";
import { BunSqliteAdapter, type SqlDb } from "./sql-db.js";
import * as attachmentOps from "./attachments.js";
import type { BlobStore } from "./blob-store.js";

/**
 * bun:sqlite-backed Store implementation. Internally everything is
 * synchronous; the public Store API is async so the same interface
 * can back an async runtime (e.g. Cloudflare Durable Objects SQLite).
 */
export class BunSqliteStore implements Store {
  public readonly hooks: HookRegistry;
  /** Adapter that satisfies the shared `SqlDb` contract. Used internally and
   *  by external code that wants to call the ops helpers directly. */
  public readonly sqlDb: SqlDb;
  public readonly blobStore?: BlobStore;

  constructor(public readonly db: Database, opts?: { hooks?: HookRegistry; blobStore?: BlobStore }) {
    this.sqlDb = new BunSqliteAdapter(db);
    initSchema(this.sqlDb);
    this.hooks = opts?.hooks ?? new HookRegistry();
    this.blobStore = opts?.blobStore;
  }

  // ---- Notes ----

  async createNote(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string }): Promise<Note> {
    const note = noteOps.createNote(this.sqlDb, content, opts);

    if (content) {
      syncWikilinks(this.sqlDb, note.id, content);
    }

    if (note.path) {
      resolveUnresolvedWikilinks(this.sqlDb, note.path, note.id);
    }

    this.hooks.dispatch("created", note, this);

    return note;
  }

  async getNote(id: string): Promise<Note | null> {
    return noteOps.getNote(this.sqlDb, id);
  }

  async getNoteByPath(path: string): Promise<Note | null> {
    return noteOps.getNoteByPath(this.sqlDb, path);
  }

  async getNotes(ids: string[]): Promise<Note[]> {
    return noteOps.getNotes(this.sqlDb, ids);
  }

  async updateNote(id: string, updates: { content?: string; path?: string; metadata?: Record<string, unknown>; created_at?: string; skipUpdatedAt?: boolean }): Promise<Note> {
    let oldPath: string | undefined;
    if (updates.path !== undefined) {
      const existing = noteOps.getNote(this.sqlDb, id);
      oldPath = existing?.path;
    }

    const note = noteOps.updateNote(this.sqlDb, id, updates);

    if (updates.content !== undefined) {
      syncWikilinks(this.sqlDb, id, updates.content);
    }

    if (updates.path !== undefined && note.path) {
      if (oldPath && oldPath !== note.path) {
        this.cascadeRename(oldPath, note.path);
      }
      resolveUnresolvedWikilinks(this.sqlDb, note.path, id);
    }

    this.hooks.dispatch("updated", note, this);

    return note;
  }

  /**
   * When a note is renamed, update [[wikilinks]] in other notes that referenced the old path.
   * Matches both full path and basename references.
   */
  private cascadeRename(oldPath: string, newPath: string): void {
    const oldTitle = pathTitle(oldPath);
    const newTitle = pathTitle(newPath);

    const candidates = this.sqlDb.prepare(`
      SELECT id, content FROM notes
      WHERE content LIKE ? OR content LIKE ?
    `).all(`%[[${oldPath}%`, `%[[${oldTitle}%`) as { id: string; content: string }[];

    for (const row of candidates) {
      let updated = row.content;

      updated = updated.replace(
        new RegExp(`\\[\\[${escapeRegex(oldPath)}([#|\\]])`, "g"),
        `[[${newPath}$1`,
      );

      if (oldTitle !== newTitle && oldTitle !== oldPath) {
        updated = updated.replace(
          new RegExp(`\\[\\[${escapeRegex(oldTitle)}([#|\\]])`, "g"),
          `[[${newTitle}$1`,
        );
      }

      if (updated !== row.content) {
        noteOps.updateNote(this.sqlDb, row.id, { content: updated });
        syncWikilinks(this.sqlDb, row.id, updated);
      }
    }
  }

  async deleteNote(id: string): Promise<void> {
    noteOps.deleteNote(this.sqlDb, id);
  }

  async queryNotes(opts: QueryOpts): Promise<Note[]> {
    return noteOps.queryNotes(this.sqlDb, opts);
  }

  async searchNotes(query: string, opts?: { tags?: string[]; limit?: number }): Promise<Note[]> {
    return noteOps.searchNotes(this.sqlDb, query, opts);
  }

  // ---- Tags ----

  async tagNote(noteId: string, tags: string[]): Promise<void> {
    noteOps.tagNote(this.sqlDb, noteId, tags);
  }

  async untagNote(noteId: string, tags: string[]): Promise<void> {
    noteOps.untagNote(this.sqlDb, noteId, tags);
  }

  async listTags(): Promise<{ name: string; count: number }[]> {
    return noteOps.listTags(this.sqlDb);
  }

  async deleteTag(name: string): Promise<{ deleted: boolean; notes_untagged: number }> {
    return noteOps.deleteTag(this.sqlDb, name);
  }

  // ---- Vault Stats ----

  async getVaultStats(opts?: { topTagsLimit?: number }) {
    return noteOps.getVaultStats(this.sqlDb, opts);
  }

  // ---- Links ----

  async createLink(sourceId: string, targetId: string, relationship: string, metadata?: Record<string, unknown>): Promise<Link> {
    return linkOps.createLink(this.sqlDb, sourceId, targetId, relationship, metadata);
  }

  async deleteLink(sourceId: string, targetId: string, relationship: string): Promise<void> {
    linkOps.deleteLink(this.sqlDb, sourceId, targetId, relationship);
  }

  async getLinks(noteId: string, opts?: { direction?: "outbound" | "inbound" | "both" }): Promise<Link[]> {
    return linkOps.getLinks(this.sqlDb, noteId, opts);
  }

  async listLinks(opts?: { noteId?: string; direction?: "outbound" | "inbound" | "both"; relationship?: string }): Promise<Link[]> {
    return linkOps.listLinks(this.sqlDb, opts);
  }

  // ---- Bulk Operations ----

  async createNotes(inputs: noteOps.BulkNoteInput[]): Promise<Note[]> {
    const notes = noteOps.createNotes(this.sqlDb, inputs);
    for (const note of notes) {
      this.hooks.dispatch("created", note, this);
    }
    return notes;
  }

  async batchTag(noteIds: string[], tags: string[]): Promise<number> {
    return noteOps.batchTag(this.sqlDb, noteIds, tags);
  }

  async batchUntag(noteIds: string[], tags: string[]): Promise<number> {
    return noteOps.batchUntag(this.sqlDb, noteIds, tags);
  }

  // ---- Deeper Link Queries ----

  async traverseLinks(noteId: string, opts?: { max_depth?: number; relationship?: string }) {
    return linkOps.traverseLinks(this.sqlDb, noteId, opts);
  }

  async findPath(sourceId: string, targetId: string, opts?: { max_depth?: number }) {
    return linkOps.findPath(this.sqlDb, sourceId, targetId, opts);
  }

  // ---- Tag Schemas ----

  async listTagSchemas() {
    return tagSchemaOps.listTagSchemas(this.sqlDb);
  }

  async getTagSchema(tag: string) {
    return tagSchemaOps.getTagSchema(this.sqlDb, tag);
  }

  async upsertTagSchema(tag: string, schema: { description?: string; fields?: Record<string, tagSchemaOps.TagFieldSchema> }) {
    return tagSchemaOps.upsertTagSchema(this.sqlDb, tag, schema);
  }

  async deleteTagSchema(tag: string) {
    return tagSchemaOps.deleteTagSchema(this.sqlDb, tag);
  }

  async getTagSchemaMap() {
    return tagSchemaOps.getTagSchemaMap(this.sqlDb);
  }

  // ---- Batch Wikilink Sync ----

  /**
   * Create a note without triggering wikilink sync.
   * Use this during bulk imports, then call syncAllWikilinks() after.
   */
  async createNoteRaw(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string }): Promise<Note> {
    return noteOps.createNote(this.sqlDb, content, opts);
  }

  /**
   * Sync wikilinks for all notes in the vault.
   * Efficient for bulk imports — call once after importing all notes.
   */
  async syncAllWikilinks(): Promise<{ synced: number; totalAdded: number; totalRemoved: number }> {
    const allNotes = noteOps.queryNotes(this.sqlDb, { limit: 1000000 });
    let synced = 0;
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const note of allNotes) {
      if (!note.content) continue;
      const result = syncWikilinks(this.sqlDb, note.id, note.content);
      if (result.added > 0 || result.removed > 0) {
        synced++;
        totalAdded += result.added;
        totalRemoved += result.removed;
      }
    }

    return { synced, totalAdded, totalRemoved };
  }

  // ---- Attachments ----

  async addAttachment(noteId: string, filePath: string, mimeType: string, metadata?: Record<string, unknown>): Promise<Attachment> {
    return attachmentOps.addAttachment(this.sqlDb, noteId, filePath, mimeType, metadata);
  }

  async getAttachments(noteId: string): Promise<Attachment[]> {
    return attachmentOps.getAttachments(this.sqlDb, noteId);
  }

  // ---- Blob I/O ----

  async putBlob(key: string, data: ArrayBuffer | Uint8Array | Blob, opts?: { mimeType?: string }): Promise<void> {
    await this.requireBlobStore().put(key, data, opts);
  }

  async getBlob(key: string) {
    return this.requireBlobStore().get(key);
  }

  async deleteBlob(key: string): Promise<void> {
    await this.requireBlobStore().delete(key);
  }

  private requireBlobStore(): BlobStore {
    if (!this.blobStore) throw new Error("BunSqliteStore was constructed without a BlobStore");
    return this.blobStore;
  }
}

/** @deprecated Renamed to `BunSqliteStore` to make the runtime split explicit. Kept as an alias for backward compatibility. */
export const SqliteStore = BunSqliteStore;
/** @deprecated Renamed to `BunSqliteStore`. */
export type SqliteStore = BunSqliteStore;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
