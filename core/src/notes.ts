import { Database } from "bun:sqlite";
import type { Note, QueryOpts, VaultStats } from "./types.js";
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

  db.prepare(
    `INSERT INTO notes (id, content, path, metadata, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, content, path, metadata, createdAt);

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

export function updateNote(
  db: Database,
  id: string,
  updates: { content?: string; path?: string; metadata?: Record<string, unknown> },
): Note {
  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];

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

  values.push(id);
  db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(...values);

  return getNote(db, id)!;
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
  const total_notes = totalRow.c;

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

  const tagCountRow = db.prepare("SELECT COUNT(*) as c FROM tags").get() as { c: number };
  const tag_count = tagCountRow.c;

  return {
    total_notes,
    earliest_note: earliestRow
      ? { id: earliestRow.id, created_at: earliestRow.created_at }
      : null,
    latest_note: latestRow
      ? { id: latestRow.id, created_at: latestRow.created_at }
      : null,
    notes_by_month: monthRows,
    top_tags: topTagRows,
    tag_count,
  };
}

// ---- Bulk Operations ----

export interface BulkNoteInput {
  content: string;
  id?: string;
  path?: string;
  tags?: string[];
}

export function createNotes(db: Database, inputs: BulkNoteInput[]): Note[] {
  const results: Note[] = [];
  const insertNote = db.prepare(
    "INSERT INTO notes (id, content, path, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const insertNoteTag = db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_name) VALUES (?, ?)");

  db.exec("BEGIN");
  try {
    for (const input of inputs) {
      const id = input.id ?? generateId();
      const now = new Date().toISOString();
      insertNote.run(id, input.content, input.path ?? null, now);

      if (input.tags && input.tags.length > 0) {
        for (const tag of input.tags) {
          insertTag.run(tag);
          insertNoteTag.run(id, tag);
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Fetch all created notes with tags
  for (const input of inputs) {
    const id = input.id ?? undefined;
    // For notes without explicit IDs, we need to find them
    // Since we're in a batch, fetch by content order
  }

  // Simpler: just re-query them all
  // We know the IDs if provided, otherwise query recent
  const ids = inputs.map((input) => input.id).filter(Boolean) as string[];
  if (ids.length === inputs.length) {
    // All had explicit IDs
    for (const id of ids) {
      results.push(getNote(db, id)!);
    }
  } else {
    // Some auto-generated — query recent notes by count
    const rows = db.prepare(
      `SELECT * FROM notes ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(inputs.length) as NoteRow[];
    for (const row of rows.reverse()) {
      const note = rowToNote(row);
      note.tags = getNoteTags(db, note.id);
      results.push(note);
    }
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
