import type Database from "better-sqlite3";
import type { Store, Note, Link, Attachment, QueryOpts } from "./types.js";
import { initSchema } from "./schema.js";
import { seedBuiltins } from "./seed.js";
import * as noteOps from "./notes.js";
import * as linkOps from "./links.js";

/**
 * SQLite-backed Store implementation.
 */
export class SqliteStore implements Store {
  constructor(public readonly db: Database.Database) {
    initSchema(db);
    seedBuiltins(db);
  }

  // ---- Notes ----

  createNote(content: string, opts?: { id?: string; path?: string; tags?: string[] }): Note {
    return noteOps.createNote(this.db, content, opts);
  }

  getNote(id: string): Note | null {
    return noteOps.getNote(this.db, id);
  }

  updateNote(id: string, updates: { content?: string; path?: string }): Note {
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

  createLink(sourceId: string, targetId: string, relationship: string): Link {
    return linkOps.createLink(this.db, sourceId, targetId, relationship);
  }

  deleteLink(sourceId: string, targetId: string, relationship: string): void {
    linkOps.deleteLink(this.db, sourceId, targetId, relationship);
  }

  getLinks(noteId: string, opts?: { direction?: "outbound" | "inbound" | "both" }): Link[] {
    return linkOps.getLinks(this.db, noteId, opts);
  }

  // ---- Attachments ----

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
