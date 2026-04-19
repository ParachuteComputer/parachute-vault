import { Database } from "bun:sqlite";
import type { Store, Note, Link, Attachment, QueryOpts } from "./types.js";
import { initSchema } from "./schema.js";
import * as noteOps from "./notes.js";
import * as linkOps from "./links.js";
import * as tagSchemaOps from "./tag-schemas.js";
import { syncWikilinks, resolveUnresolvedWikilinks } from "./wikilinks.js";
import { pathTitle } from "./paths.js";
import { HookRegistry } from "./hooks.js";

/**
 * bun:sqlite-backed Store implementation. Internally everything is
 * synchronous; the public Store API is async so the same interface
 * can back an async runtime (e.g. Cloudflare Durable Objects SQLite).
 */
export class BunSqliteStore implements Store {
  public readonly hooks: HookRegistry;

  constructor(public readonly db: Database, opts?: { hooks?: HookRegistry }) {
    initSchema(db);
    this.hooks = opts?.hooks ?? new HookRegistry();
  }

  // ---- Notes ----

  async createNote(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string }): Promise<Note> {
    const note = noteOps.createNote(this.db, content, opts);

    if (content) {
      syncWikilinks(this.db, note.id, content);
    }

    if (note.path) {
      resolveUnresolvedWikilinks(this.db, note.path, note.id);
    }

    this.hooks.dispatch("created", note, this);

    return note;
  }

  async getNote(id: string): Promise<Note | null> {
    return noteOps.getNote(this.db, id);
  }

  async getNoteByPath(path: string): Promise<Note | null> {
    return noteOps.getNoteByPath(this.db, path);
  }

  async getNotes(ids: string[]): Promise<Note[]> {
    return noteOps.getNotes(this.db, ids);
  }

  async updateNote(
    id: string,
    updates: {
      content?: string;
      path?: string;
      metadata?: Record<string, unknown>;
      created_at?: string;
      skipUpdatedAt?: boolean;
      if_updated_at?: string;
    },
  ): Promise<Note> {
    let oldPath: string | undefined;
    if (updates.path !== undefined) {
      const existing = noteOps.getNote(this.db, id);
      oldPath = existing?.path;
    }

    const note = noteOps.updateNote(this.db, id, updates);

    if (updates.content !== undefined) {
      syncWikilinks(this.db, id, updates.content);
    }

    if (updates.path !== undefined && note.path) {
      if (oldPath && oldPath !== note.path) {
        this.cascadeRename(oldPath, note.path);
      }
      resolveUnresolvedWikilinks(this.db, note.path, id);
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

    const candidates = this.db.prepare(`
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
        noteOps.updateNote(this.db, row.id, { content: updated });
        syncWikilinks(this.db, row.id, updated);
      }
    }
  }

  async deleteNote(id: string): Promise<void> {
    noteOps.deleteNote(this.db, id);
  }

  async queryNotes(opts: QueryOpts): Promise<Note[]> {
    return noteOps.queryNotes(this.db, opts);
  }

  async searchNotes(query: string, opts?: { tags?: string[]; limit?: number }): Promise<Note[]> {
    return noteOps.searchNotes(this.db, query, opts);
  }

  // ---- Tags ----

  async tagNote(noteId: string, tags: string[]): Promise<void> {
    noteOps.tagNote(this.db, noteId, tags);
  }

  async untagNote(noteId: string, tags: string[]): Promise<void> {
    noteOps.untagNote(this.db, noteId, tags);
  }

  async listTags(): Promise<{ name: string; count: number }[]> {
    return noteOps.listTags(this.db);
  }

  async deleteTag(name: string): Promise<{ deleted: boolean; notes_untagged: number }> {
    return noteOps.deleteTag(this.db, name);
  }

  async renameTag(oldName: string, newName: string): Promise<noteOps.RenameTagResult> {
    return noteOps.renameTag(this.db, oldName, newName);
  }

  async mergeTags(
    sources: string[],
    target: string,
  ): Promise<{ merged: Record<string, number>; target: string }> {
    return noteOps.mergeTags(this.db, sources, target);
  }

  // ---- Vault Stats ----

  async getVaultStats(opts?: { topTagsLimit?: number }) {
    return noteOps.getVaultStats(this.db, opts);
  }

  // ---- Links ----

  async createLink(sourceId: string, targetId: string, relationship: string, metadata?: Record<string, unknown>): Promise<Link> {
    return linkOps.createLink(this.db, sourceId, targetId, relationship, metadata);
  }

  async deleteLink(sourceId: string, targetId: string, relationship: string): Promise<void> {
    linkOps.deleteLink(this.db, sourceId, targetId, relationship);
  }

  async getLinks(noteId: string, opts?: { direction?: "outbound" | "inbound" | "both" }): Promise<Link[]> {
    return linkOps.getLinks(this.db, noteId, opts);
  }

  async listLinks(opts?: { noteId?: string; direction?: "outbound" | "inbound" | "both"; relationship?: string }): Promise<Link[]> {
    return linkOps.listLinks(this.db, opts);
  }

  // ---- Bulk Operations ----

  async createNotes(inputs: noteOps.BulkNoteInput[]): Promise<Note[]> {
    const notes = noteOps.createNotes(this.db, inputs);
    for (const note of notes) {
      this.hooks.dispatch("created", note, this);
    }
    return notes;
  }

  async batchTag(noteIds: string[], tags: string[]): Promise<number> {
    return noteOps.batchTag(this.db, noteIds, tags);
  }

  async batchUntag(noteIds: string[], tags: string[]): Promise<number> {
    return noteOps.batchUntag(this.db, noteIds, tags);
  }

  // ---- Deeper Link Queries ----

  async traverseLinks(noteId: string, opts?: { max_depth?: number; relationship?: string }) {
    return linkOps.traverseLinks(this.db, noteId, opts);
  }

  async findPath(sourceId: string, targetId: string, opts?: { max_depth?: number }) {
    return linkOps.findPath(this.db, sourceId, targetId, opts);
  }

  // ---- Tag Schemas ----

  async listTagSchemas() {
    return tagSchemaOps.listTagSchemas(this.db);
  }

  async getTagSchema(tag: string) {
    return tagSchemaOps.getTagSchema(this.db, tag);
  }

  async upsertTagSchema(tag: string, schema: { description?: string; fields?: Record<string, tagSchemaOps.TagFieldSchema> }) {
    return tagSchemaOps.upsertTagSchema(this.db, tag, schema);
  }

  async deleteTagSchema(tag: string) {
    return tagSchemaOps.deleteTagSchema(this.db, tag);
  }

  async getTagSchemaMap() {
    return tagSchemaOps.getTagSchemaMap(this.db);
  }

  // ---- Batch Wikilink Sync ----

  /**
   * Create a note without triggering wikilink sync.
   * Use this during bulk imports, then call syncAllWikilinks() after.
   */
  async createNoteRaw(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string }): Promise<Note> {
    return noteOps.createNote(this.db, content, opts);
  }

  /**
   * Sync wikilinks for all notes in the vault.
   * Efficient for bulk imports — call once after importing all notes.
   */
  async syncAllWikilinks(): Promise<{ synced: number; totalAdded: number; totalRemoved: number }> {
    const allNotes = noteOps.queryNotes(this.db, { limit: 1000000 });
    let synced = 0;
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const note of allNotes) {
      if (!note.content) continue;
      const result = syncWikilinks(this.db, note.id, note.content);
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
    const id = noteOps.generateId();
    const now = new Date().toISOString();
    const metadataJson = metadata ? JSON.stringify(metadata) : "{}";
    this.db.prepare(
      "INSERT INTO attachments (id, note_id, path, mime_type, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, noteId, filePath, mimeType, metadataJson, now);

    return { id, noteId, path: filePath, mimeType, metadata, createdAt: now };
  }

  async getAttachments(noteId: string): Promise<Attachment[]> {
    const rows = this.db.prepare(
      "SELECT * FROM attachments WHERE note_id = ? ORDER BY created_at",
    ).all(noteId) as { id: string; note_id: string; path: string; mime_type: string; metadata: string | null; created_at: string }[];

    return rows.map((r) => {
      let metadata: Record<string, unknown> | undefined;
      if (r.metadata && r.metadata !== "{}") {
        try { metadata = JSON.parse(r.metadata); } catch {}
      }
      return {
        id: r.id,
        noteId: r.note_id,
        path: r.path,
        mimeType: r.mime_type,
        metadata,
        createdAt: r.created_at,
      };
    });
  }

  async deleteAttachment(
    noteId: string,
    attachmentId: string,
  ): Promise<{ deleted: boolean; path: string | null; orphaned: boolean }> {
    // Scope by noteId so a token authorized for note A can't delete note B's attachments.
    const row = this.db.prepare(
      "SELECT path FROM attachments WHERE id = ? AND note_id = ?",
    ).get(attachmentId, noteId) as { path: string } | undefined;
    if (!row) return { deleted: false, path: null, orphaned: false };

    this.db.prepare("DELETE FROM attachments WHERE id = ? AND note_id = ?").run(attachmentId, noteId);

    // Orphan check: caller uses this to decide whether to unlink the file on disk.
    const other = this.db.prepare(
      "SELECT 1 FROM attachments WHERE path = ? LIMIT 1",
    ).get(row.path);
    return { deleted: true, path: row.path, orphaned: !other };
  }

  async getAttachment(attachmentId: string): Promise<Attachment | null> {
    const row = this.db.prepare(
      "SELECT * FROM attachments WHERE id = ?",
    ).get(attachmentId) as { id: string; note_id: string; path: string; mime_type: string; metadata: string | null; created_at: string } | undefined;
    if (!row) return null;
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata && row.metadata !== "{}") {
      try { metadata = JSON.parse(row.metadata); } catch {}
    }
    return {
      id: row.id,
      noteId: row.note_id,
      path: row.path,
      mimeType: row.mime_type,
      metadata,
      createdAt: row.created_at,
    };
  }

  /**
   * Replace the attachment's metadata JSON blob. The caller passes the full
   * merged object — this is a set, not a patch, so partial-field updates
   * don't silently drop other keys.
   */
  async setAttachmentMetadata(attachmentId: string, metadata: Record<string, unknown>): Promise<void> {
    const json = JSON.stringify(metadata);
    this.db.prepare("UPDATE attachments SET metadata = ? WHERE id = ?").run(json, attachmentId);
  }

  /**
   * Return attachments whose metadata.transcribe_status matches the given
   * status, oldest first (FIFO). Used by the transcription worker to drain
   * the queue. `status = "pending"` is the queue; `"failed"` feeds a retry
   * sweep; `"done"` is only useful for tests and diagnostics.
   */
  async listAttachmentsByTranscribeStatus(
    status: "pending" | "failed" | "done",
    limit = 50,
  ): Promise<Attachment[]> {
    const rows = this.db.prepare(
      `SELECT * FROM attachments
       WHERE json_extract(metadata, '$.transcribe_status') = ?
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(status, limit) as { id: string; note_id: string; path: string; mime_type: string; metadata: string | null; created_at: string }[];

    return rows.map((r) => {
      let metadata: Record<string, unknown> | undefined;
      if (r.metadata && r.metadata !== "{}") {
        try { metadata = JSON.parse(r.metadata); } catch {}
      }
      return {
        id: r.id,
        noteId: r.note_id,
        path: r.path,
        mimeType: r.mime_type,
        metadata,
        createdAt: r.created_at,
      };
    });
  }
}

/** @deprecated Renamed to `BunSqliteStore` to make the runtime split explicit. Kept as an alias for backward compatibility. */
export const SqliteStore = BunSqliteStore;
/** @deprecated Renamed to `BunSqliteStore`. */
export type SqliteStore = BunSqliteStore;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
