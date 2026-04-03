import type Database from "better-sqlite3";
import type { Note, QueryOpts } from "./types.js";

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
  db: Database.Database,
  content: string,
  opts?: { id?: string; path?: string; tags?: string[] },
): Note {
  const id = opts?.id ?? generateId();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO notes (id, content, path, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, content, opts?.path ?? null, now);

  if (opts?.tags && opts.tags.length > 0) {
    tagNote(db, id, opts.tags);
  }

  return getNote(db, id)!;
}

export function getNote(db: Database.Database, id: string): Note | null {
  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  if (!row) return null;

  const note = rowToNote(row);
  note.tags = getNoteTags(db, id);
  return note;
}

export function updateNote(
  db: Database.Database,
  id: string,
  updates: { content?: string; path?: string },
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
    values.push(updates.path);
  }

  values.push(id);
  db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(...values);

  return getNote(db, id)!;
}

export function deleteNote(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}

export function queryNotes(db: Database.Database, opts: QueryOpts): Note[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const joins: string[] = [];

  // Include tags
  if (opts.tags && opts.tags.length > 0) {
    for (let i = 0; i < opts.tags.length; i++) {
      const alias = `nt${i}`;
      joins.push(`JOIN note_tags ${alias} ON ${alias}.note_id = n.id AND ${alias}.tag_name = ?`);
      params.push(opts.tags[i]);
    }
  }

  // Exclude tags
  if (opts.excludeTags && opts.excludeTags.length > 0) {
    for (const tag of opts.excludeTags) {
      conditions.push(`NOT EXISTS (SELECT 1 FROM note_tags ex WHERE ex.note_id = n.id AND ex.tag_name = ?)`);
      params.push(tag);
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
  db: Database.Database,
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

export function tagNote(db: Database.Database, noteId: string, tags: string[]): void {
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const insertNoteTag = db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_name) VALUES (?, ?)");

  for (const tag of tags) {
    insertTag.run(tag);
    insertNoteTag.run(noteId, tag);
  }
}

export function untagNote(db: Database.Database, noteId: string, tags: string[]): void {
  const stmt = db.prepare("DELETE FROM note_tags WHERE note_id = ? AND tag_name = ?");
  for (const tag of tags) {
    stmt.run(noteId, tag);
  }
}

export function getNoteTags(db: Database.Database, noteId: string): string[] {
  const rows = db.prepare(
    "SELECT tag_name FROM note_tags WHERE note_id = ? ORDER BY tag_name",
  ).all(noteId) as { tag_name: string }[];
  return rows.map((r) => r.tag_name);
}

export function listTags(db: Database.Database): { name: string; count: number }[] {
  const rows = db.prepare(`
    SELECT t.name, COUNT(nt.note_id) as count
    FROM tags t
    LEFT JOIN note_tags nt ON nt.tag_name = t.name
    GROUP BY t.name
    ORDER BY t.name
  `).all() as { name: string; count: number }[];
  return rows;
}

// ---- Internal ----

interface NoteRow {
  id: string;
  content: string;
  path: string | null;
  created_at: string;
  updated_at: string | null;
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    content: row.content,
    path: row.path ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  };
}
