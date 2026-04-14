/**
 * Cloudflare Durable Objects SQLite-backed `Store` implementation.
 *
 * Consumes `ctx.storage.sql` (and `ctx.storage.transactionSync`) via a
 * minimal adapter, so all of the ops helpers in `notes.ts`, `links.ts`,
 * `wikilinks.ts`, `schema.ts`, and `tag-schemas.ts` run unchanged on both
 * bun:sqlite and DO SQLite.
 *
 * Import this file from Workers code only — it has no `bun:sqlite` runtime
 * dependency. Self-hosted code paths should import `./store.js` instead.
 *
 * Attachments are not yet supported on this store; the methods throw. R2
 * integration is tracked separately.
 */

import type { Store, Note, Link, Attachment, QueryOpts } from "./types.js";
import type { SqlDb, SqlStatement, SqlRunResult } from "./sql-db.js";
import { splitSqlStatements } from "./sql-db.js";
import { initSchema } from "./schema.js";
import * as noteOps from "./notes.js";
import * as linkOps from "./links.js";
import * as tagSchemaOps from "./tag-schemas.js";
import { syncWikilinks, resolveUnresolvedWikilinks } from "./wikilinks.js";
import { pathTitle } from "./paths.js";
import { HookRegistry } from "./hooks.js";

// ---------------------------------------------------------------------------
// Minimal structural types for the DO storage surface we use.
//
// We deliberately avoid depending on `@cloudflare/workers-types` at compile
// time so the package ships without pulling that type graph into self-hosted
// builds. Callers that have the real types can pass `ctx.storage` directly —
// it structurally satisfies this interface.
// ---------------------------------------------------------------------------

export interface DoSqlCursor<T = Record<string, unknown>> {
  toArray(): T[];
  readonly rowsWritten: number;
}

export interface DoSqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): DoSqlCursor<T>;
}

export interface DoDurableObjectStorage {
  readonly sql: DoSqlStorage;
  transactionSync<T>(closure: () => T): T;
}

// ---------------------------------------------------------------------------
// DoSqliteAdapter — wraps `ctx.storage` into the shared `SqlDb` interface.
// ---------------------------------------------------------------------------

class DoSqlStatement implements SqlStatement {
  constructor(private readonly sql: DoSqlStorage, private readonly query: string) {}

  get<T = unknown>(...params: unknown[]): T | undefined {
    const rows = this.sql.exec<T>(this.query, ...params).toArray();
    return rows.length > 0 ? rows[0] : undefined;
  }

  all<T = unknown>(...params: unknown[]): T[] {
    return this.sql.exec<T>(this.query, ...params).toArray();
  }

  run(...params: unknown[]): SqlRunResult {
    const cursor = this.sql.exec(this.query, ...params);
    // Force execution by materializing (DO cursors are lazy).
    cursor.toArray();
    return { changes: cursor.rowsWritten, lastInsertRowid: 0 };
  }
}

export class DoSqliteAdapter implements SqlDb {
  constructor(public readonly storage: DoDurableObjectStorage) {}

  prepare(sql: string): SqlStatement {
    return new DoSqlStatement(this.storage.sql, sql);
  }

  /**
   * Execute one or more statements. Multi-statement SQL is split by
   * `splitSqlStatements` since DO's `sql.exec` only accepts a single
   * statement per call. `PRAGMA` statements are skipped — DO SQLite doesn't
   * support them and the WAL/foreign-keys pragmas our schema uses aren't
   * meaningful on DO storage (which is already transactional).
   */
  exec(sql: string): void {
    for (const stmt of splitSqlStatements(sql)) {
      if (/^\s*PRAGMA\b/i.test(stmt)) continue;
      this.storage.sql.exec(stmt);
    }
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

// ---------------------------------------------------------------------------
// DoSqliteStore
// ---------------------------------------------------------------------------

export class DoSqliteStore implements Store {
  public readonly hooks: HookRegistry;
  public readonly sqlDb: SqlDb;

  constructor(storage: DoDurableObjectStorage, opts?: { hooks?: HookRegistry }) {
    this.sqlDb = new DoSqliteAdapter(storage);
    initSchema(this.sqlDb);
    this.hooks = opts?.hooks ?? new HookRegistry();
  }

  // ---- Notes ----

  async createNote(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string }): Promise<Note> {
    const note = noteOps.createNote(this.sqlDb, content, opts);
    if (content) syncWikilinks(this.sqlDb, note.id, content);
    if (note.path) resolveUnresolvedWikilinks(this.sqlDb, note.path, note.id);
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

  private cascadeRename(oldPath: string, newPath: string): void {
    const oldTitle = pathTitle(oldPath);
    const newTitle = pathTitle(newPath);

    const candidates = this.sqlDb.prepare(`
      SELECT id, content FROM notes
      WHERE content LIKE ? OR content LIKE ?
    `).all<{ id: string; content: string }>(`%[[${oldPath}%`, `%[[${oldTitle}%`);

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

  // ---- Bulk ----

  async createNotes(inputs: noteOps.BulkNoteInput[]): Promise<Note[]> {
    const notes = noteOps.createNotes(this.sqlDb, inputs);
    for (const note of notes) this.hooks.dispatch("created", note, this);
    return notes;
  }

  async batchTag(noteIds: string[], tags: string[]): Promise<number> {
    return noteOps.batchTag(this.sqlDb, noteIds, tags);
  }

  async batchUntag(noteIds: string[], tags: string[]): Promise<number> {
    return noteOps.batchUntag(this.sqlDb, noteIds, tags);
  }

  // ---- Graph ----

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

  // ---- Attachments ----
  // R2 integration is tracked in a follow-up PR. Self-hosted filesystem
  // attachments are not portable to Workers, so these throw for now.

  async addAttachment(_noteId: string, _filePath: string, _mimeType: string, _metadata?: Record<string, unknown>): Promise<Attachment> {
    throw new Error("attachments are not yet supported on DoSqliteStore");
  }

  async getAttachments(_noteId: string): Promise<Attachment[]> {
    throw new Error("attachments are not yet supported on DoSqliteStore");
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
