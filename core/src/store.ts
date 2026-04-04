import { Database } from "bun:sqlite";
import type { Store, Note, Link, Attachment, QueryOpts } from "./types.js";
import { initSchema } from "./schema.js";
import { seedBuiltins } from "./seed.js";
import * as noteOps from "./notes.js";
import * as linkOps from "./links.js";

/**
 * SQLite-backed Store implementation.
 */
export class SqliteStore implements Store {
  constructor(public readonly db: Database) {
    initSchema(db);
    seedBuiltins(db);
  }

  // ---- Notes ----

  createNote(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string }): Note {
    return noteOps.createNote(this.db, content, opts);
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
    return noteOps.updateNote(this.db, id, updates);
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
