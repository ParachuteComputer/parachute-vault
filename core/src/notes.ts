import { Database } from "bun:sqlite";
import type { Note, NoteIndex, QueryOpts, VaultStats } from "./types.js";
import { normalizePath } from "./paths.js";

let idCounter = 0;

/** Generate a timestamp-based ID: YYYY-MM-DD-HH-MM-SS-ffffff */
export function generateId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const micro = now.getMilliseconds() * 1000 + (idCounter++ % 1000);
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    pad(micro, 6),
  ].join("-");
}

export function createNote(
  db: Database,
  content: string,
  opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string },
): Note {
  const id = opts?.id ?? generateId();
  const createdAt = opts?.created_at ?? new Date().toISOString();
  const metadata = opts?.metadata ? JSON.stringify(opts.metadata) : "{}";
  const path = normalizePath(opts?.path);

  // `updated_at` is set to `created_at` on insert so a client whose optimistic
  // concurrency check falls back to `createdAt` on a never-updated note
  // (the common shape: `note.updatedAt ?? note.createdAt`) matches the stored
  // value. Hook-style writes with `skipUpdatedAt` preserve this; real user
  // edits bump it strictly upward, so `updated_at > created_at` still means
  // "user-touched since creation."
  db.prepare(
    `INSERT INTO notes (id, content, path, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, content, path, metadata, createdAt, createdAt);

  if (opts?.tags && opts.tags.length > 0) {
    tagNote(db, id, opts.tags);
  }

  return getNote(db, id)!;
}

export function getNote(db: Database, id: string): Note | null {
  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  if (!row) return null;

  const note = rowToNote(row);
  note.tags = getNoteTags(db, note.id);
  return note;
}

export function getNoteByPath(db: Database, path: string): Note | null {
  const row = db.prepare("SELECT * FROM notes WHERE path = ?").get(path) as NoteRow | undefined;
  if (!row) return null;

  const note = rowToNote(row);
  note.tags = getNoteTags(db, note.id);
  return note;
}

export function getNotes(db: Database, ids: string[]): Note[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT * FROM notes WHERE id IN (${placeholders}) ORDER BY created_at`,
  ).all(...ids) as NoteRow[];
  return rows.map((row) => {
    const note = rowToNote(row);
    note.tags = getNoteTags(db, note.id);
    return note;
  });
}

/**
 * Thrown by `updateNote` when an `if_updated_at` precondition does not match
 * the note's current `updated_at`. The SELECT+check+UPDATE happens as one
 * atomic conditional UPDATE so two concurrent callers cannot both pass the
 * check and both commit.
 */
export class ConflictError extends Error {
  code = "CONFLICT" as const;
  note_id: string;
  current_updated_at: string | null;
  expected_updated_at: string;

  constructor(noteId: string, current: string | null, expected: string) {
    super(
      `conflict: note "${noteId}" has been modified (current updated_at=${current ?? "null"}, expected=${expected})`,
    );
    this.name = "ConflictError";
    this.note_id = noteId;
    this.current_updated_at = current;
    this.expected_updated_at = expected;
  }
}

export function updateNote(
  db: Database,
  id: string,
  updates: {
    content?: string;
    path?: string;
    metadata?: Record<string, unknown>;
    created_at?: string;
    skipUpdatedAt?: boolean;
    /**
     * Optimistic concurrency token. When provided, the UPDATE runs with an
     * additional `AND updated_at IS ?` clause; if no row is affected and the
     * note still exists, a `ConflictError` is thrown.
     */
    if_updated_at?: string;
  },
): Note {
  const sets: string[] = [];
  const values: unknown[] = [];

  // Hooks and other machine-level writers pass `skipUpdatedAt: true` so
  // their metadata markers don't look like user activity. See issue #44.
  if (!updates.skipUpdatedAt) {
    let now = new Date().toISOString();
    // OC contract: the new updated_at must be strictly greater than the
    // caller's if_updated_at so a subsequent OC reader can distinguish
    // pre- from post-update state. Without this, two writes landing in the
    // same wall-clock millisecond would produce identical timestamps and
    // let a second OC writer see the first writer's work as "unchanged."
    // Comparison is lexicographic on ISO 8601 strings — valid because
    // `.toISOString()` always emits fixed-width UTC (`...Z`).
    if (updates.if_updated_at !== undefined && now <= updates.if_updated_at) {
      now = new Date(new Date(updates.if_updated_at).getTime() + 1).toISOString();
    }
    sets.push("updated_at = ?");
    values.push(now);
  }

  if (updates.content !== undefined) {
    sets.push("content = ?");
    values.push(updates.content);
  }
  if (updates.path !== undefined) {
    sets.push("path = ?");
    values.push(normalizePath(updates.path));
  }
  if (updates.metadata !== undefined) {
    sets.push("metadata = ?");
    values.push(JSON.stringify(updates.metadata));
  }
  if (updates.created_at !== undefined) {
    sets.push("created_at = ?");
    values.push(updates.created_at);
  }

  // No-op: no SET fields. If a caller still passed `if_updated_at`, we
  // need to validate the precondition; a conditional UPDATE that sets
  // updated_at to itself does exactly that atomically — even a no-net-
  // change UPDATE takes the write lock in WAL mode, so it still serializes
  // with other writers and `.changes` reflects whether the WHERE matched.
  if (sets.length === 0) {
    if (updates.if_updated_at !== undefined) {
      const probe = db.prepare(
        "UPDATE notes SET updated_at = updated_at WHERE id = ? AND updated_at IS ?",
      ).run(id, updates.if_updated_at);
      if (probe.changes === 0) {
        throwConflictOrMissing(db, id, updates.if_updated_at);
      }
    }
    return getNote(db, id)!;
  }

  values.push(id);
  let sql = `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`;
  if (updates.if_updated_at !== undefined) {
    sql += " AND updated_at IS ?";
    values.push(updates.if_updated_at);
  }

  const res = db.prepare(sql).run(...values);

  if (updates.if_updated_at !== undefined && res.changes === 0) {
    throwConflictOrMissing(db, id, updates.if_updated_at);
  }

  return getNote(db, id)!;
}

function throwConflictOrMissing(db: Database, id: string, expected: string): never {
  const row = db.prepare("SELECT updated_at FROM notes WHERE id = ?").get(id) as
    | { updated_at: string | null }
    | undefined;
  if (!row) {
    throw new Error(`Note not found: "${id}"`);
  }
  throw new ConflictError(id, row.updated_at, expected);
}

export function deleteNote(db: Database, id: string): void {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}

export function queryNotes(db: Database, opts: QueryOpts): Note[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const joins: string[] = [];

  // Include tags — "all" (default): must have ALL tags; "any": must have ANY tag
  if (opts.tags && opts.tags.length > 0) {
    const match = opts.tagMatch ?? "all";
    if (match === "any") {
      const placeholders = opts.tags.map(() => "?").join(", ");
      joins.push(`JOIN note_tags nt_or ON nt_or.note_id = n.id AND nt_or.tag_name IN (${placeholders})`);
      params.push(...opts.tags);
    } else {
      for (let i = 0; i < opts.tags.length; i++) {
        const alias = `nt${i}`;
        joins.push(`JOIN note_tags ${alias} ON ${alias}.note_id = n.id AND ${alias}.tag_name = ?`);
        params.push(opts.tags[i]);
      }
    }
  }

  // Exclude tags
  if (opts.excludeTags && opts.excludeTags.length > 0) {
    for (const tag of opts.excludeTags) {
      conditions.push(`NOT EXISTS (SELECT 1 FROM note_tags ex WHERE ex.note_id = n.id AND ex.tag_name = ?)`);
      params.push(tag);
    }
  }

  // Exact path match (case-insensitive)
  if (opts.path) {
    conditions.push("n.path = ? COLLATE NOCASE");
    params.push(opts.path);
  }

  // Path prefix
  if (opts.pathPrefix) {
    conditions.push("n.path LIKE ?");
    params.push(opts.pathPrefix + "%");
  }

  // Metadata filters
  if (opts.metadata) {
    for (const [key, value] of Object.entries(opts.metadata)) {
      conditions.push(`json_extract(n.metadata, '$.' || ?) = ?`);
      params.push(key, typeof value === "string" ? value : JSON.stringify(value));
    }
  }

  // Date range
  if (opts.dateFrom) {
    conditions.push("n.created_at >= ?");
    params.push(opts.dateFrom);
  }
  if (opts.dateTo) {
    conditions.push("n.created_at < ?");
    params.push(opts.dateTo);
  }

  const orderBy = `n.created_at ${opts.sort === "desc" ? "DESC" : "ASC"}`;
  const limit = typeof opts.limit === "number" ? opts.limit : 100;
  const offset = typeof opts.offset === "number" ? opts.offset : 0;

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT DISTINCT n.* FROM notes n
    ${joins.join("\n")}
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as NoteRow[];
  return rows.map((row) => {
    const note = rowToNote(row);
    note.tags = getNoteTags(db, note.id);
    return note;
  });
}

export function searchNotes(
  db: Database,
  query: string,
  opts?: { tags?: string[]; limit?: number },
): Note[] {
  const limit = typeof opts?.limit === "number" ? opts.limit : 50;

  if (opts?.tags && opts.tags.length > 0) {
    try {
      const tagPlaceholders = opts.tags.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT DISTINCT n.* FROM notes n
        JOIN notes_fts fts ON fts.rowid = n.rowid
        JOIN note_tags nt ON nt.note_id = n.id AND nt.tag_name IN (${tagPlaceholders})
        WHERE notes_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(...opts.tags, query, limit) as NoteRow[];
      return rows.map((row) => {
        const note = rowToNote(row);
        note.tags = getNoteTags(db, note.id);
        return note;
      });
    } catch {
      return [];
    }
  }

  try {
    const rows = db.prepare(`
      SELECT n.* FROM notes n
      JOIN notes_fts fts ON fts.rowid = n.rowid
      WHERE notes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as NoteRow[];
    return rows.map((row) => {
      const note = rowToNote(row);
      note.tags = getNoteTags(db, note.id);
      return note;
    });
  } catch {
    return [];
  }
}

// ---- Tag Operations ----

export function tagNote(db: Database, noteId: string, tags: string[]): void {
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const insertNoteTag = db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_name) VALUES (?, ?)");

  for (const tag of tags) {
    insertTag.run(tag);
    insertNoteTag.run(noteId, tag);
  }
}

export function untagNote(db: Database, noteId: string, tags: string[]): void {
  const stmt = db.prepare("DELETE FROM note_tags WHERE note_id = ? AND tag_name = ?");
  for (const tag of tags) {
    stmt.run(noteId, tag);
  }
}

export function getNoteTags(db: Database, noteId: string): string[] {
  const rows = db.prepare(
    "SELECT tag_name FROM note_tags WHERE note_id = ? ORDER BY tag_name",
  ).all(noteId) as { tag_name: string }[];
  return rows.map((r) => r.tag_name);
}

export function listTags(db: Database): { name: string; count: number }[] {
  const rows = db.prepare(`
    SELECT t.name, COUNT(nt.note_id) as count
    FROM tags t
    LEFT JOIN note_tags nt ON nt.tag_name = t.name
    GROUP BY t.name
    ORDER BY t.name
  `).all() as { name: string; count: number }[];
  return rows;
}

export function deleteTag(db: Database, name: string): { deleted: boolean; notes_untagged: number } {
  const exists = db.prepare("SELECT 1 FROM tags WHERE name = ?").get(name);
  if (!exists) return { deleted: false, notes_untagged: 0 };

  const countRow = db.prepare("SELECT COUNT(*) as c FROM note_tags WHERE tag_name = ?").get(name) as { c: number };
  const notesUntagged = countRow.c;

  db.prepare("DELETE FROM note_tags WHERE tag_name = ?").run(name);
  db.prepare("DELETE FROM tags WHERE name = ?").run(name);

  return { deleted: true, notes_untagged: notesUntagged };
}

// The UNIQUE PRIMARY KEY on tags.name means rename-to-existing is ambiguous:
// do you drop the source, or retag-and-drop? Callers must pick — rename errors
// out; mergeTags explicitly retags.
export type RenameTagResult =
  | { renamed: number }
  | { error: "not_found" }
  | { error: "target_exists" };

export function renameTag(db: Database, oldName: string, newName: string): RenameTagResult {
  if (oldName === newName) {
    const exists = db.prepare("SELECT 1 FROM tags WHERE name = ?").get(oldName);
    return exists ? { renamed: 0 } : { error: "not_found" };
  }

  const oldExists = db.prepare("SELECT 1 FROM tags WHERE name = ?").get(oldName);
  if (!oldExists) return { error: "not_found" };

  const newExists = db.prepare("SELECT 1 FROM tags WHERE name = ?").get(newName);
  if (newExists) return { error: "target_exists" };

  db.exec("BEGIN");
  try {
    // Order matters: the note_tags FK points at tags(name), and tag_schemas'
    // FK cascades on delete. Seed the new row, move the schema + note_tags
    // onto it, then drop the old row.
    db.prepare("INSERT INTO tags (name) VALUES (?)").run(newName);
    db.prepare("UPDATE tag_schemas SET tag_name = ? WHERE tag_name = ?").run(newName, oldName);
    const updated = db.prepare("UPDATE note_tags SET tag_name = ? WHERE tag_name = ?").run(newName, oldName);
    db.prepare("DELETE FROM tags WHERE name = ?").run(oldName);
    db.exec("COMMIT");
    return { renamed: Number(updated.changes) };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function mergeTags(
  db: Database,
  sources: string[],
  target: string,
): { merged: Record<string, number>; target: string } {
  // Dedup + drop target-in-sources (self-merge is a no-op).
  const uniqueSources = Array.from(new Set(sources)).filter((s) => s !== target);

  const merged: Record<string, number> = {};

  db.exec("BEGIN");
  try {
    // Target might not exist yet. Seed it so INSERT OR IGNORE into note_tags
    // can reference it; leave any existing schema on target untouched.
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(target);

    const retagStmt = db.prepare(
      "INSERT OR IGNORE INTO note_tags (note_id, tag_name) SELECT note_id, ? FROM note_tags WHERE tag_name = ?",
    );
    const deleteNoteTagsStmt = db.prepare("DELETE FROM note_tags WHERE tag_name = ?");
    const deleteTagStmt = db.prepare("DELETE FROM tags WHERE name = ?");
    const countStmt = db.prepare("SELECT COUNT(*) as c FROM note_tags WHERE tag_name = ?");

    for (const source of uniqueSources) {
      const exists = db.prepare("SELECT 1 FROM tags WHERE name = ?").get(source);
      if (!exists) {
        merged[source] = 0;
        continue;
      }
      const before = (countStmt.get(source) as { c: number }).c;
      retagStmt.run(target, source);
      deleteNoteTagsStmt.run(source);
      // tag_schemas has ON DELETE CASCADE from tags(name), so dropping the
      // tag row also drops its schema — which is what we want for a merge.
      deleteTagStmt.run(source);
      merged[source] = before;
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { merged, target };
}

// ---- Lean note index shape ----

/** Max code points in a NoteIndex preview. */
export const NOTE_INDEX_PREVIEW_LEN = 120;

/**
 * Convert a full Note into its lean index shape:
 * drops `content`, adds `byteSize` and a whitespace-collapsed `preview`.
 * Shared between the `query-notes` MCP tool, HTTP /notes endpoints, and /graph.
 */
export function toNoteIndex(note: Note): NoteIndex {
  const content = note.content ?? "";
  const byteSize = Buffer.byteLength(content, "utf8");
  // Collapse whitespace for a readable single-line preview
  const collapsed = content.replace(/\s+/g, " ").trim();
  // Iterate by Unicode code points so we don't split surrogate pairs
  // (e.g. astral-plane emoji) mid-character.
  const codePoints = Array.from(collapsed);
  const preview = codePoints.length > NOTE_INDEX_PREVIEW_LEN
    ? codePoints.slice(0, NOTE_INDEX_PREVIEW_LEN).join("")
    : collapsed;
  return {
    id: note.id,
    path: note.path,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    tags: note.tags,
    metadata: note.metadata,
    byteSize,
    preview,
  };
}

// ---- Metadata field filtering ----

/**
 * Filter metadata on a note/index result based on an include_metadata param.
 * - true / undefined → return as-is (all metadata)
 * - false → strip metadata entirely
 * - string[] → return only those keys (empty array = no filtering)
 */
export function filterMetadata(obj: any, includeMetadata: boolean | string[] | undefined): any {
  if (includeMetadata === undefined || includeMetadata === true) return obj;
  if (includeMetadata === false) {
    const { metadata, ...rest } = obj;
    return rest;
  }
  // Array of field names — empty array means no filtering (treat as "all")
  const fields = includeMetadata as string[];
  if (fields.length === 0 || !obj.metadata) return obj;
  const filtered = Object.fromEntries(
    Object.entries(obj.metadata).filter(([k]) => fields.includes(k)),
  );
  return { ...obj, metadata: Object.keys(filtered).length > 0 ? filtered : undefined };
}

// ---- Vault stats (aggregate situational awareness) ----

/**
 * Compute aggregate vault statistics for session-start situational awareness.
 *
 * All computation is done via SQL aggregation — no full-table scans into memory.
 * Safe to call on large vaults. Read-only.
 */
export function getVaultStats(
  db: Database,
  opts?: { topTagsLimit?: number },
): VaultStats {
  const topTagsLimit = opts?.topTagsLimit ?? 20;

  const totalRow = db.prepare("SELECT COUNT(*) as c FROM notes").get() as { c: number };
  const totalNotes = totalRow.c;

  const earliestRow = db.prepare(
    "SELECT id, created_at FROM notes ORDER BY created_at ASC, id ASC LIMIT 1",
  ).get() as { id: string; created_at: string } | undefined;

  const latestRow = db.prepare(
    "SELECT id, created_at FROM notes ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get() as { id: string; created_at: string } | undefined;

  const monthRows = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count
    FROM notes
    WHERE created_at IS NOT NULL
    GROUP BY month
    ORDER BY month ASC
  `).all() as { month: string; count: number }[];

  const topTagRows = db.prepare(`
    SELECT tag_name AS tag, COUNT(*) AS count
    FROM note_tags
    GROUP BY tag_name
    ORDER BY count DESC, tag_name ASC
    LIMIT ?
  `).all(topTagsLimit) as { tag: string; count: number }[];

  const tagCountRow = db.prepare("SELECT COUNT(DISTINCT tag_name) as c FROM note_tags").get() as { c: number };
  const tagCount = tagCountRow.c;

  const linkCountRow = db.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number };
  const linkCount = linkCountRow.c;

  return {
    totalNotes,
    earliestNote: earliestRow
      ? { id: earliestRow.id, createdAt: earliestRow.created_at }
      : null,
    latestNote: latestRow
      ? { id: latestRow.id, createdAt: latestRow.created_at }
      : null,
    notesByMonth: monthRows,
    topTags: topTagRows,
    tagCount,
    linkCount,
  };
}

// ---- Bulk Operations ----

export interface BulkNoteInput {
  content: string;
  id?: string;
  path?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export function createNotes(db: Database, inputs: BulkNoteInput[]): Note[] {
  const results: Note[] = [];

  db.exec("BEGIN");
  try {
    for (const input of inputs) {
      results.push(
        createNote(db, input.content, {
          id: input.id,
          path: input.path,
          tags: input.tags,
          metadata: input.metadata,
          created_at: input.created_at,
        }),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return results;
}

export function batchTag(db: Database, noteIds: string[], tags: string[]): number {
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const insertNoteTag = db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_name) VALUES (?, ?)");
  let count = 0;

  db.exec("BEGIN");
  try {
    for (const tag of tags) {
      insertTag.run(tag);
    }
    for (const noteId of noteIds) {
      for (const tag of tags) {
        insertNoteTag.run(noteId, tag);
        count++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return count;
}

export function batchUntag(db: Database, noteIds: string[], tags: string[]): number {
  const stmt = db.prepare("DELETE FROM note_tags WHERE note_id = ? AND tag_name = ?");
  let count = 0;

  db.exec("BEGIN");
  try {
    for (const noteId of noteIds) {
      for (const tag of tags) {
        stmt.run(noteId, tag);
        count++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return count;
}

// ---- Internal ----

interface NoteRow {
  id: string;
  content: string;
  path: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string | null;
}

function rowToNote(row: NoteRow): Note {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata && row.metadata !== "{}") {
    try { metadata = JSON.parse(row.metadata); } catch {}
  }
  return {
    id: row.id,
    content: row.content,
    path: row.path ?? undefined,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  };
}
