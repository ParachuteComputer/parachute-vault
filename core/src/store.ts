import { Database } from "bun:sqlite";
import type { Store, Note, Link, Attachment, QueryOpts } from "./types.js";
import { initSchema } from "./schema.js";
import * as noteOps from "./notes.js";
import * as linkOps from "./links.js";
import { syncWikilinks, resolveUnresolvedWikilinks } from "./wikilinks.js";
import { normalizePath, pathTitle } from "./paths.js";

/**
 * SQLite-backed Store implementation.
 */
export class SqliteStore implements Store {
  constructor(public readonly db: Database) {
    initSchema(db);
  }

  // ---- Notes ----

  createNote(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string }): Note {
    const note = noteOps.createNote(this.db, content, opts);

    // Auto-sync wikilinks from content
    if (content) {
      syncWikilinks(this.db, note.id, content);
    }

    // If this note has a path, resolve any pending wikilinks targeting it
    if (note.path) {
      resolveUnresolvedWikilinks(this.db, note.path, note.id);
    }

    return note;
  }

  getNote(id: string): Note | null {
    return noteOps.getNote(this.db, id);
  }

  getNoteByPath(path: string): Note | null {
    return noteOps.getNoteByPath(this.db, path);
  }

  getNotes(ids: string[]): Note[] {
    return noteOps.getNotes(this.db, ids);
  }

  updateNote(id: string, updates: { content?: string; path?: string; metadata?: Record<string, unknown> }): Note {
    // Capture old path before update for rename cascading
    let oldPath: string | undefined;
    if (updates.path !== undefined) {
      const existing = noteOps.getNote(this.db, id);
      oldPath = existing?.path;
    }

    const note = noteOps.updateNote(this.db, id, updates);

    // Re-sync wikilinks if content changed
    if (updates.content !== undefined) {
      syncWikilinks(this.db, id, updates.content);
    }

    // If path changed, cascade rename through wikilinks in other notes
    if (updates.path !== undefined && note.path) {
      if (oldPath && oldPath !== note.path) {
        this.cascadeRename(oldPath, note.path);
      }
      resolveUnresolvedWikilinks(this.db, note.path, id);
    }

    return note;
  }

  /**
   * When a note is renamed, update [[wikilinks]] in other notes that referenced the old path.
   * Matches both full path and basename references.
   */
  private cascadeRename(oldPath: string, newPath: string): void {
    const oldTitle = pathTitle(oldPath);
    const newTitle = pathTitle(newPath);

    // Find notes whose content contains a likely wikilink to the old path
    // Search for both the full old path and just the old basename
    const candidates = this.db.prepare(`
      SELECT id, content FROM notes
      WHERE content LIKE ? OR content LIKE ?
    `).all(`%[[${oldPath}%`, `%[[${oldTitle}%`) as { id: string; content: string }[];

    for (const row of candidates) {
      let updated = row.content;

      // Replace [[OldPath...]] with [[NewPath...]] (preserving aliases and anchors)
      updated = updated.replace(
        new RegExp(`\\[\\[${escapeRegex(oldPath)}([#|\\]])`, "g"),
        `[[${newPath}$1`,
      );

      // Replace [[OldTitle...]] with [[NewTitle...]] (basename references)
      // Only if old title !== new title and old title !== old path (avoid double-replace)
      if (oldTitle !== newTitle && oldTitle !== oldPath) {
        updated = updated.replace(
          new RegExp(`\\[\\[${escapeRegex(oldTitle)}([#|\\]])`, "g"),
          `[[${newTitle}$1`,
        );
      }

      if (updated !== row.content) {
        // Call noteOps directly (not this.updateNote) to avoid recursive cascading.
        // Only content changes here, so path normalization/cascading aren't needed.
        noteOps.updateNote(this.db, row.id, { content: updated });
        syncWikilinks(this.db, row.id, updated);
      }
    }
  }

  deleteNote(id: string): void {
    noteOps.deleteNote(this.db, id);
  }

  queryNotes(opts: QueryOpts): Note[] {
    return noteOps.queryNotes(this.db, opts);
  }

  searchNotes(query: string, opts?: { tags?: string[]; limit?: number }): Note[] {
    return noteOps.searchNotes(this.db, query, opts);
  }

  // ---- Tags ----

  tagNote(noteId: string, tags: string[]): void {
    noteOps.tagNote(this.db, noteId, tags);
  }

  untagNote(noteId: string, tags: string[]): void {
    noteOps.untagNote(this.db, noteId, tags);
  }

  listTags(): { name: string; count: number }[] {
    return noteOps.listTags(this.db);
  }

  // ---- Links ----

  createLink(sourceId: string, targetId: string, relationship: string, metadata?: Record<string, unknown>): Link {
    return linkOps.createLink(this.db, sourceId, targetId, relationship, metadata);
  }

  deleteLink(sourceId: string, targetId: string, relationship: string): void {
    linkOps.deleteLink(this.db, sourceId, targetId, relationship);
  }

  getLinks(noteId: string, opts?: { direction?: "outbound" | "inbound" | "both" }): Link[] {
    return linkOps.getLinks(this.db, noteId, opts);
  }

  // ---- Bulk Operations ----

  createNotes(inputs: { content: string; id?: string; path?: string; tags?: string[] }[]): Note[] {
    return noteOps.createNotes(this.db, inputs);
  }

  batchTag(noteIds: string[], tags: string[]): number {
    return noteOps.batchTag(this.db, noteIds, tags);
  }

  batchUntag(noteIds: string[], tags: string[]): number {
    return noteOps.batchUntag(this.db, noteIds, tags);
  }

  // ---- Deeper Link Queries ----

  traverseLinks(noteId: string, opts?: { max_depth?: number; relationship?: string }) {
    return linkOps.traverseLinks(this.db, noteId, opts);
  }

  findPath(sourceId: string, targetId: string, opts?: { max_depth?: number }) {
    return linkOps.findPath(this.db, sourceId, targetId, opts);
  }

  // ---- Batch Wikilink Sync ----

  /**
   * Create a note without triggering wikilink sync.
   * Use this during bulk imports, then call syncAllWikilinks() after.
   */
  createNoteRaw(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string }): Note {
    return noteOps.createNote(this.db, content, opts);
  }

  /**
   * Sync wikilinks for all notes in the vault.
   * Efficient for bulk imports — call once after importing all notes.
   */
  syncAllWikilinks(): { synced: number; totalAdded: number; totalRemoved: number } {
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

  addAttachment(noteId: string, filePath: string, mimeType: string, metadata?: Record<string, unknown>): Attachment {
    const id = noteOps.generateId();
    const now = new Date().toISOString();
    const metadataJson = metadata ? JSON.stringify(metadata) : "{}";
    this.db.prepare(
      "INSERT INTO attachments (id, note_id, path, mime_type, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, noteId, filePath, mimeType, metadataJson, now);

    return { id, noteId, path: filePath, mimeType, metadata, createdAt: now };
  }

  getAttachments(noteId: string): Attachment[] {
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
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
