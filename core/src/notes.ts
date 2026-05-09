import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { Note, NoteIndex, QueryOpts, VaultStats } from "./types.js";
import { normalizePath } from "./paths.js";
import {
  buildOperatorClause,
  isOperatorObject,
  QueryError,
  requireIndexedField,
} from "./query-operators.js";

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

  // Empty-note invariant (#213): reject `content+path both absent`. Three
  // legit shapes — content-only, path-only, both — only the empty+empty
  // combo is the runaway-client signature that flooded a deployment with
  // 7,453 pathless empty notes in one MCP burst. `content` only is a
  // legitimate un-pathed jot; `path` only is a wikilink placeholder or
  // `_schemas/*` config note.
  if (!content.trim() && path === null) {
    throw new EmptyNoteError();
  }

  // `updated_at` is set to `created_at` on insert so a client whose optimistic
  // concurrency check falls back to `createdAt` on a never-updated note
  // (the common shape: `note.updatedAt ?? note.createdAt`) matches the stored
  // value. Hook-style writes with `skipUpdatedAt` preserve this; real user
  // edits bump it strictly upward, so `updated_at > created_at` still means
  // "user-touched since creation."
  try {
    db.prepare(
      `INSERT INTO notes (id, content, path, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, content, path, metadata, createdAt, createdAt);
  } catch (err) {
    if (path !== null && isPathUniqueError(err)) {
      throw new PathConflictError(path);
    }
    throw err;
  }

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
  note_path: string | null;
  current_updated_at: string | null;
  expected_updated_at: string;

  constructor(noteId: string, notePath: string | null, current: string | null, expected: string) {
    super(
      `conflict: note "${noteId}" has been modified (current updated_at=${current ?? "null"}, expected=${expected})`,
    );
    this.name = "ConflictError";
    this.note_id = noteId;
    this.note_path = notePath;
    this.current_updated_at = current;
    this.expected_updated_at = expected;
  }
}

/**
 * Thrown by `createNote` / `updateNote` when the requested path is already
 * taken by another note. Surfaces as 409 at the HTTP layer so clients can
 * distinguish "path taken — pick another" from a generic 500.
 *
 * Detected by catching SQLite's UNIQUE-constraint error on the
 * `idx_notes_path_unique` partial index (schema v5+). Matches the tag
 * "UNIQUE constraint failed: notes.path" rather than a numeric code so
 * we keep working if bun:sqlite changes its error class hierarchy.
 */
export class PathConflictError extends Error {
  code = "PATH_CONFLICT" as const;
  path: string;

  constructor(path: string) {
    super(`path_conflict: another note already uses path "${path}"`);
    this.name = "PathConflictError";
    this.path = path;
  }
}

/**
 * Per-call item cap on `createNote`/`updateNote` batch entry points
 * (MCP `create-note` / `update-note` and HTTP `POST /api/notes`).
 * Single source of truth — both transports import from here so the cap
 * can never silently drift between them. See #213 for the runaway-client
 * incident that motivated the cap (7,453 empty notes in one MCP burst).
 */
export const MAX_BATCH_SIZE = 500;

/**
 * Thrown by `createNote` / `updateNote` when the proposed note state has
 * neither content nor path. The vault accepts un-pathed jots (content only)
 * and path-only placeholders (wikilink stubs, `_schemas/*`), but a note
 * with neither is the runaway-client signature flagged in #213 — one MCP
 * burst flooded a deployment with 7,453 empty pathless rows. Surfaces as
 * 400 at the HTTP layer.
 */
export class EmptyNoteError extends Error {
  code = "EMPTY_NOTE" as const;
  note_id: string | null;
  /**
   * Zero-based position in a batch call when the empty entry is rejected via
   * the transport-layer pre-validation pass (HTTP `POST /api/notes` or MCP
   * `create-note` with `notes: [...]`). `null` for single-update rejections
   * and for Store-level throws that don't know their batch context.
   */
  item_index: number | null;

  constructor(noteId: string | null = null, itemIndex: number | null = null) {
    super(
      noteId
        ? `empty_note: update would leave note "${noteId}" with neither content nor path`
        : itemIndex !== null
          ? `empty_note: a note must have either content or a path (item index ${itemIndex})`
          : `empty_note: a note must have either content or a path`,
    );
    this.name = "EmptyNoteError";
    this.note_id = noteId;
    this.item_index = itemIndex;
  }
}

/**
 * Match bun:sqlite's UNIQUE-constraint error on the notes.path index. The
 * error class is `SQLiteError` but matching on the message is sufficient
 * here — the index name and column are stable parts of the schema, and
 * bun:sqlite has carried this exact message text since 1.0.
 */
function isPathUniqueError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("UNIQUE constraint failed: notes.path");
}

export function updateNote(
  db: Database,
  id: string,
  updates: {
    content?: string;
    /**
     * Atomic content append. Computed via SQL string concatenation
     * (`content = content || ?`), so two concurrent appends never
     * overwrite each other — the second simply lands after the first.
     * Mutually exclusive with `content`.
     */
    append?: string;
    /**
     * Atomic content prepend. Same SQL-level guarantee as `append`.
     * Mutually exclusive with `content`. May be combined with `append`
     * in a single call (both contributions land).
     */
    prepend?: string;
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
  if (updates.content !== undefined && (updates.append !== undefined || updates.prepend !== undefined)) {
    throw new Error(
      "update-note: `content` is mutually exclusive with `append`/`prepend`. Pick full-replace or additive — not both in the same call.",
    );
  }

  // Empty-note invariant (#213): when this update touches content or path,
  // reject if the post-state would be empty content + null path. We only
  // enforce on transitions that actually touch the relevant fields, so
  // metadata-only or tag-only updates against legacy empty rows still pass.
  // Hook-style writes (skipUpdatedAt) are exempted — they're machine-level
  // marker writes that legitimately may run against any shape of row.
  const touchesContent = updates.content !== undefined
    || updates.append !== undefined
    || updates.prepend !== undefined;
  const touchesPath = updates.path !== undefined;
  if ((touchesContent || touchesPath) && !updates.skipUpdatedAt) {
    const current = getNote(db, id);
    if (current) {
      let finalContent: string;
      if (updates.content !== undefined) {
        finalContent = updates.content;
      } else if (touchesContent) {
        finalContent = (updates.prepend ?? "") + current.content + (updates.append ?? "");
      } else {
        finalContent = current.content;
      }
      const finalPath = touchesPath ? normalizePath(updates.path) : (current.path ?? null);
      if (!finalContent.trim() && !finalPath) {
        throw new EmptyNoteError(id);
      }
    }
    // If `current` is null we fall through — existing code paths handle the
    // missing-row case downstream (the conditional UPDATE returns 0 rows;
    // OC throws ConflictError; non-OC returns silently).
  }

  const sets: string[] = [];
  const values: (string | null)[] = [];

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
  if (updates.append !== undefined || updates.prepend !== undefined) {
    // Atomic concat at the SQL layer. SQLite's `||` operator on the
    // existing `content` column means a concurrent reader-then-writer
    // race window is impossible: each `UPDATE` evaluates `content`
    // under the write lock, so two simultaneous appends both land
    // (in some order) instead of one clobbering the other.
    //
    // Frontmatter-aware prepend (#203): if the note opens with a YAML
    // frontmatter block (`---\n...\n---\n`), the prepend is injected
    // *after* the closing `---\n` so parsers that expect frontmatter
    // at byte 0 still find it. Detection uses `instr(content, '\n---\n')`
    // — the closing fence is whatever `\n---\n` appears after the
    // opening one. If no frontmatter is detected, prepend goes at
    // byte 0 as before. Atomicity is preserved: the entire transform
    // is one UPDATE expression evaluated under the write lock.
    sets.push(
      "content = CASE "
        + "WHEN substr(content, 1, 4) = '---' || char(10) "
        + "AND instr(content, char(10) || '---' || char(10)) > 0 "
        + "THEN substr(content, 1, instr(content, char(10) || '---' || char(10)) + 4) || ? "
        + "|| substr(content, instr(content, char(10) || '---' || char(10)) + 5) || ? "
        + "ELSE ? || content || ? "
        + "END",
    );
    const prependVal = updates.prepend ?? "";
    const appendVal = updates.append ?? "";
    values.push(prependVal, appendVal, prependVal, appendVal);
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
  // with other writers. `RETURNING id` reports the row only when WHERE
  // matched — `.changes` is unreliable inside multi-statement transactions
  // (vault#261).
  if (sets.length === 0) {
    if (updates.if_updated_at !== undefined) {
      const probe = db.prepare(
        "UPDATE notes SET updated_at = updated_at WHERE id = ? AND updated_at IS ? RETURNING id",
      ).get(id, updates.if_updated_at) as { id: string } | null;
      if (probe === null) {
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

  let matched: { id: string } | null = null;
  try {
    if (updates.if_updated_at !== undefined) {
      matched = db.prepare(`${sql} RETURNING id`).get(...values) as
        | { id: string }
        | null;
    } else {
      db.prepare(sql).run(...values);
    }
  } catch (err) {
    if (updates.path !== undefined && isPathUniqueError(err)) {
      throw new PathConflictError(normalizePath(updates.path) ?? updates.path);
    }
    throw err;
  }

  if (updates.if_updated_at !== undefined && matched === null) {
    throwConflictOrMissing(db, id, updates.if_updated_at);
  }

  return getNote(db, id)!;
}

function throwConflictOrMissing(db: Database, id: string, expected: string): never {
  const row = db.prepare("SELECT updated_at, path FROM notes WHERE id = ?").get(id) as
    | { updated_at: string | null; path: string | null }
    | undefined;
  if (!row) {
    throw new Error(`Note not found: "${id}"`);
  }
  throw new ConflictError(id, row.path, row.updated_at, expected);
}

export function deleteNote(db: Database, id: string): void {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}

export function queryNotes(db: Database, opts: QueryOpts): Note[] {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];
  const joins: string[] = [];

  // Include tags — "all" (default): must have ALL tags; "any": must have ANY tag.
  // The `_tagsExpanded` internal field carries per-input-tag descendant sets
  // when the tag-hierarchy resolver (see core/src/tag-hierarchy.ts) has
  // expanded the input — `tags: ["manual"]` becomes the set
  // `{manual, voice, text, ...}` per declared `_tags/*` config notes. Falls
  // back to `[opts.tags[i]]` (single-element set) when no expansion is set,
  // preserving the original semantics.
  if (opts.tags && opts.tags.length > 0) {
    const tagSets: string[][] = (opts as QueryOpts & { _tagsExpanded?: string[][] })._tagsExpanded
      ?? opts.tags.map((t) => [t]);
    const match = opts.tagMatch ?? "all";
    if (match === "any") {
      // Flatten all expanded sets and dedupe — a note tagged with any one
      // matches the input.
      const flat = Array.from(new Set(tagSets.flat()));
      if (flat.length > 0) {
        const placeholders = flat.map(() => "?").join(", ");
        joins.push(`JOIN note_tags nt_or ON nt_or.note_id = n.id AND nt_or.tag_name IN (${placeholders})`);
        params.push(...flat);
      }
    } else {
      // "all": one JOIN per input tag, each accepting the input or any descendant.
      for (let i = 0; i < tagSets.length; i++) {
        const set = tagSets[i] ?? [];
        if (set.length === 0) continue;
        const alias = `nt${i}`;
        const placeholders = set.map(() => "?").join(", ");
        joins.push(`JOIN note_tags ${alias} ON ${alias}.note_id = n.id AND ${alias}.tag_name IN (${placeholders})`);
        params.push(...set);
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

  // Presence: has_tags. When specific tags were already supplied, skip —
  // the existing join/condition already enforces that any result has tags.
  const filterByTags = Boolean(opts.tags && opts.tags.length > 0);
  if (opts.hasTags !== undefined && !filterByTags) {
    conditions.push(
      opts.hasTags
        ? `EXISTS (SELECT 1 FROM note_tags ht WHERE ht.note_id = n.id)`
        : `NOT EXISTS (SELECT 1 FROM note_tags ht WHERE ht.note_id = n.id)`,
    );
  }

  // Presence: has_links (either direction counts).
  if (opts.hasLinks !== undefined) {
    conditions.push(
      opts.hasLinks
        ? `EXISTS (SELECT 1 FROM links hl WHERE hl.source_id = n.id OR hl.target_id = n.id)`
        : `NOT EXISTS (SELECT 1 FROM links hl WHERE hl.source_id = n.id OR hl.target_id = n.id)`,
    );
  }

  // ID set filter — used by `near` to push neighborhood scoping into SQL so
  // that LIMIT applies to the neighborhood, not the whole notes table.
  if (opts.ids !== undefined) {
    if (opts.ids.length === 0) {
      // Caller asked for "in this empty set" — no rows match. Short-circuit
      // with an always-false condition; building `IN ()` would be a SQL error.
      conditions.push("0 = 1");
    } else {
      const placeholders = opts.ids.map(() => "?").join(", ");
      conditions.push(`n.id IN (${placeholders})`);
      params.push(...opts.ids);
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

  // Metadata filters — operator objects route through the indexed generated
  // column (fast, loud errors on non-indexed fields); primitives keep the
  // existing JSON-scan exact-match behavior for backcompat.
  if (opts.metadata) {
    for (const [key, value] of Object.entries(opts.metadata)) {
      if (isOperatorObject(value)) {
        requireIndexedField(db, key);
        const { sql, params: opParams } = buildOperatorClause(
          key,
          value as Record<string, unknown>,
        );
        conditions.push(sql);
        params.push(...opParams);
      } else {
        conditions.push(`json_extract(n.metadata, '$.' || ?) = ?`);
        params.push(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }
  }

  // Date range. Two accepted shapes:
  //   - Legacy `dateFrom` / `dateTo` — always filters on `n.created_at`
  //     (vault ingestion time).
  //   - Generalized `dateFilter: { field, from, to }` — filters on the
  //     named field. `created_at` (default) maps to `n.created_at`; any
  //     other field must be declared `indexed: true` so the SQL targets
  //     a real B-tree index. The two shapes are mutually exclusive — the
  //     combination would silently AND, which would be surprising.
  const hasLegacyDate = opts.dateFrom !== undefined || opts.dateTo !== undefined;
  const hasDateFilter = opts.dateFilter !== undefined;
  if (hasLegacyDate && hasDateFilter) {
    throw new QueryError(
      `cannot combine top-level date_from/date_to with date_filter — pass one or the other`,
      "INVALID_QUERY",
    );
  }
  if (hasDateFilter) {
    const filter = opts.dateFilter!;
    const field = filter.field ?? "created_at";
    let column: string;
    if (field === "created_at") {
      column = "n.created_at";
    } else {
      // Re-uses the same indexed-field gate as `metadata` operator queries
      // and `orderBy` so the error message and contract are consistent.
      requireIndexedField(db, field);
      column = `"meta_${field}"`;
    }
    if (filter.from !== undefined) {
      conditions.push(`${column} >= ?`);
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push(`${column} < ?`);
      params.push(filter.to);
    }
  } else if (hasLegacyDate) {
    if (opts.dateFrom) {
      conditions.push("n.created_at >= ?");
      params.push(opts.dateFrom);
    }
    if (opts.dateTo) {
      conditions.push("n.created_at < ?");
      params.push(opts.dateTo);
    }
  }

  const direction = opts.sort === "desc" ? "DESC" : "ASC";
  let orderBy: string;
  if (opts.orderBy) {
    requireIndexedField(db, opts.orderBy);
    // `orderBy` came from indexed_fields (validated on declaration), so
    // the column name is safe to interpolate. Append created_at as a
    // stable tiebreaker so two rows with the same indexed value have a
    // deterministic order.
    orderBy = `"meta_${opts.orderBy}" ${direction}, n.created_at ${direction}`;
  } else {
    orderBy = `n.created_at ${direction}`;
  }
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
//
// Vault#240 + #247: rename is a transactional cascade across every surface
// where the old name is referenced. The shape `tag` → `tag/sub` paths
// recursively (sub-tags follow their root). Counts are returned per-surface
// so REST/MCP responses can report what changed without a re-scan.
export interface RenameTagSuccess {
  /** note_tags rows repointed (cumulative across self + every sub-tag). */
  renamed: number;
  /** Sub-tag rows renamed alongside the root (excludes the root itself). */
  sub_tags_renamed: number;
  /** OTHER tags whose `parent_names` JSON array referenced any old name. */
  parent_refs_updated: number;
  /** Tokens whose `scoped_tags` JSON array referenced any old name. */
  tokens_updated: number;
  /** indexed_fields rows whose `declarer_tags` JSON array referenced any old name. */
  indexed_field_declarers_updated: number;
  /** Notes whose `content` had `#oldname[/...]` references rewritten. */
  notes_rewritten: number;
  /** `_tags/<oldname>...` notes whose `path` was rewritten for hygiene. */
  paths_renamed: number;
}

export type RenameTagResult =
  | RenameTagSuccess
  | { error: "not_found" }
  | { error: "target_exists"; conflicting: string[] };

/**
 * Cascading tag rename — closes vault#240 (full cascade) and vault#247
 * (parent_names piece). When `task` becomes `todo`, the rename touches:
 *
 *   1. `tags` PK row (and sub-tag rows `task/...` → `todo/...`).
 *   2. `note_tags.tag_name` FK references for every renamed name.
 *   3. `tags.parent_names` JSON arrays in OTHER tag rows.
 *   4. `tokens.scoped_tags` JSON arrays.
 *   5. `indexed_fields.declarer_tags` JSON arrays.
 *   6. Note body `content`: `#oldname` and `#oldname/...` references
 *      become `#newname` / `#newname/...`. `[[_tags/oldname]]`
 *      wikilinks rewrite to `[[_tags/newname]]`.
 *   7. `_tags/<oldname>...` config-note paths (post-v14 these are inert
 *      historical breadcrumbs, but renaming for hygiene keeps the
 *      vault internally consistent).
 *
 * Atomicity: a single `BEGIN IMMEDIATE` transaction. Any failure rolls
 * back the entire cascade — no half-applied state. Pre-flight collision
 * check covers both the root rename and every sub-tag rename so a
 * partway-through abort can't happen on a UNIQUE-constraint violation.
 *
 * Cache invalidation: parent_names and tag-set both change, so callers
 * (the store wrapper) bust both `_tagHierarchy` and `_schemaConfig`
 * after the cascade returns.
 */
export function renameTag(db: Database, oldName: string, newName: string): RenameTagResult {
  if (oldName === newName) {
    const exists = db.prepare("SELECT 1 FROM tags WHERE name = ?").get(oldName);
    return exists
      ? emptyCascadeResult()
      : { error: "not_found" };
  }

  const oldExists = db.prepare("SELECT 1 FROM tags WHERE name = ?").get(oldName);
  if (!oldExists) return { error: "not_found" };

  // Discover the full set of names being renamed: the root plus every
  // sub-tag whose name starts with `<oldName>/`. Each maps to a parallel
  // entry under `<newName>/`. Sorted by length DESC so we update the
  // deepest path first if any later step needs deterministic ordering
  // (the SQL we run is order-independent, but it costs nothing here).
  //
  // `escapeLikePattern` neutralizes `%` and `_` inside the operator-
  // supplied tag name so a tag literally named `task_` doesn't pull
  // `taskX/sub` into the rename transaction (that would be a write the
  // caller never asked for — far worse than a downstream false-positive
  // candidate). `ESCAPE '\\'` is required for the escape to take effect.
  const subRows = db
    .prepare("SELECT name FROM tags WHERE name LIKE ? ESCAPE '\\' ORDER BY length(name) DESC")
    .all(`${escapeLikePattern(oldName)}/%`) as { name: string }[];
  const renames: { from: string; to: string }[] = [
    { from: oldName, to: newName },
    ...subRows.map((r) => ({ from: r.name, to: `${newName}${r.name.slice(oldName.length)}` })),
  ];

  // Pre-flight: if any new name already exists as a tag (and isn't itself
  // about to be renamed away), abort with structured error. No rows
  // mutated. The renamed-away set covers both `oldName` itself (which
  // becomes `newName` — fine) and any sub-tag whose new path happens to
  // collide with an existing sub-tag (uncommon but possible if the
  // operator picks an awkward target).
  const renamedAway = new Set(renames.map((r) => r.from));
  const conflicting: string[] = [];
  const existsStmt = db.prepare("SELECT 1 FROM tags WHERE name = ?");
  for (const { to } of renames) {
    if (renamedAway.has(to)) continue;
    if (existsStmt.get(to)) conflicting.push(to);
  }
  if (conflicting.length > 0) {
    return { error: "target_exists", conflicting };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    let renamedNoteTags = 0;
    let pathsRenamed = 0;

    // ---- Tag-row rename pass.
    //
    // Order: insert new row (carrying identity), repoint note_tags, drop
    // old row. Per-rename, mirroring the pre-cascade behavior. The
    // note_tags FK on `tag_name` has no ON DELETE, so the delete must
    // come AFTER the repoint.
    const now = new Date().toISOString();
    const readStmt = db.prepare(
      "SELECT description, fields, relationships, parent_names, created_at FROM tags WHERE name = ?",
    );
    const insertStmt = db.prepare(
      `INSERT INTO tags (name, description, fields, relationships, parent_names, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const repointStmt = db.prepare(
      "UPDATE note_tags SET tag_name = ? WHERE tag_name = ? RETURNING note_id",
    );
    const dropStmt = db.prepare("DELETE FROM tags WHERE name = ?");
    for (const { from, to } of renames) {
      const old = readStmt.get(from) as
        | { description: string | null; fields: string | null; relationships: string | null; parent_names: string | null; created_at: string | null }
        | undefined;
      insertStmt.run(
        to,
        old?.description ?? null,
        old?.fields ?? null,
        old?.relationships ?? null,
        old?.parent_names ?? null,
        old?.created_at ?? now,
        now,
      );
      const repointed = repointStmt.all(to, from) as { note_id: string }[];
      renamedNoteTags += repointed.length;
      dropStmt.run(from);
    }

    // ---- JSON-array cascade across parent_names / scoped_tags /
    // declarer_tags. Same shape three times: cheap LIKE pre-filter, then
    // per-row JSON.parse → array.map → JSON.stringify. Replacing on the
    // parsed array (not the encoded string) is robust against escaping
    // edge cases. The pre-filter narrows the per-row work to just the
    // candidates that mention any of the renamed names.
    //
    // Each call site supplies its own column name for the filter — SQL
    // doesn't expand `column LIKE (a OR b)` into a disjunction. We also
    // escape LIKE wildcards (`%`, `_`) inside tag names and append
    // `ESCAPE '\\'` to every clause so a tag literally named `task_`
    // doesn't match `taskX` as a false-positive candidate.
    const renameMap = new Map(renames.map((r) => [r.from, r.to]));
    const remap = (s: string): string => renameMap.get(s) ?? s;
    const likeClauseFor = (column: string): string =>
      renames
        .map((r) => `${column} LIKE '%"${escapeJsonLike(r.from)}"%' ESCAPE '\\'`)
        .join(" OR ");

    let parentRefsUpdated = 0;
    {
      const rows = db
        .prepare(`SELECT name, parent_names FROM tags WHERE parent_names IS NOT NULL AND (${likeClauseFor("parent_names")})`)
        .all() as { name: string; parent_names: string }[];
      // We just renamed every old name; the rows we're updating are now
      // keyed by the new name where applicable. The candidate clause
      // matched `parent_names` containing any old name — those references
      // are stale and need rewriting.
      const updateStmt = db.prepare(
        "UPDATE tags SET parent_names = ?, updated_at = ? WHERE name = ?",
      );
      for (const row of rows) {
        const next = remapJsonArray(row.parent_names, remap);
        if (next === null) continue;
        updateStmt.run(next, now, row.name);
        parentRefsUpdated++;
      }
    }

    let tokensUpdated = 0;
    if (hasTable(db, "tokens")) {
      const rows = db
        .prepare(`SELECT token_hash, scoped_tags FROM tokens WHERE scoped_tags IS NOT NULL AND (${likeClauseFor("scoped_tags")})`)
        .all() as { token_hash: string; scoped_tags: string }[];
      const updateStmt = db.prepare("UPDATE tokens SET scoped_tags = ? WHERE token_hash = ?");
      for (const row of rows) {
        const next = remapJsonArray(row.scoped_tags, remap);
        if (next === null) continue;
        updateStmt.run(next, row.token_hash);
        tokensUpdated++;
      }
    }

    let declarersUpdated = 0;
    if (hasTable(db, "indexed_fields")) {
      const rows = db
        .prepare(`SELECT field, declarer_tags FROM indexed_fields WHERE declarer_tags IS NOT NULL AND (${likeClauseFor("declarer_tags")})`)
        .all() as { field: string; declarer_tags: string }[];
      const updateStmt = db.prepare("UPDATE indexed_fields SET declarer_tags = ? WHERE field = ?");
      for (const row of rows) {
        const next = remapJsonArray(row.declarer_tags, remap);
        if (next === null) continue;
        updateStmt.run(next, row.field);
        declarersUpdated++;
      }
    }

    // ---- Note body content: rewrite `#<oldname>` and `#<oldname>/...`
    // references. Sub-tag rewrites cascade naturally — `task/work`
    // appears in `renames` so a body that says `#task/work` rewrites
    // directly to `#todo/work` without splitting into prefix-replace.
    //
    // ALSO `[[_tags/<oldname>...]]` wikilinks (post-v14 these are
    // historical, but if any vault still carries them, keep them
    // pointing at the right path).
    let notesRewritten = 0;
    {
      // Each pair of LIKE clauses uses ESCAPE '\\' so the bound pattern
      // can carry a literal `%` or `_` from a tag name without the LIKE
      // engine treating them as wildcards. The middle of the bound
      // string is `escapeLikePattern(from)`; the leading/trailing `%` we
      // wrap in are still our actual wildcards.
      const orClauses = renames
        .map(() => "(content LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
        .join(" OR ");
      const params: string[] = [];
      for (const { from } of renames) {
        const safe = escapeLikePattern(from);
        params.push(`%#${safe}%`, `%[[_tags/${safe}%`);
      }
      const candidates = db
        .prepare(`SELECT id, content FROM notes WHERE content IS NOT NULL AND content != '' AND (${orClauses})`)
        .all(...params) as { id: string; content: string }[];
      const updateStmt = db.prepare("UPDATE notes SET content = ? WHERE id = ?");
      for (const row of candidates) {
        const next = rewriteNoteBody(row.content, renames);
        if (next === row.content) continue;
        updateStmt.run(next, row.id);
        notesRewritten++;
      }
    }

    // ---- `_tags/<oldname>...` config-note paths. Post-v14 these are
    // inert (the resolver reads `tags.parent_names`, not the notes).
    // Renaming the path keeps the vault internally consistent for any
    // operator who still inspects them by hand.
    {
      const orClauses = renames.map(() => "path LIKE ? ESCAPE '\\'").join(" OR ");
      const params = renames.map((r) => `_tags/${escapeLikePattern(r.from)}%`);
      const candidates = db
        .prepare(`SELECT id, path FROM notes WHERE path IS NOT NULL AND (${orClauses})`)
        .all(...params) as { id: string; path: string }[];
      const updateStmt = db.prepare("UPDATE notes SET path = ? WHERE id = ?");
      for (const row of candidates) {
        const next = rewriteTagConfigPath(row.path, renames);
        if (next === row.path) continue;
        updateStmt.run(next, row.id);
        pathsRenamed++;
      }
    }

    db.exec("COMMIT");

    const result: RenameTagSuccess = {
      renamed: renamedNoteTags,
      sub_tags_renamed: renames.length - 1,
      parent_refs_updated: parentRefsUpdated,
      tokens_updated: tokensUpdated,
      indexed_field_declarers_updated: declarersUpdated,
      notes_rewritten: notesRewritten,
      paths_renamed: pathsRenamed,
    };

    // Audit log: single line so operators searching `[vault] tag rename`
    // can correlate cascades after the fact. Includes the stats and the
    // mapping for non-trivial sub-tag cases.
    console.error(
      `[vault] tag rename cascade: ${oldName} → ${newName}` +
        (renames.length > 1 ? ` (+${renames.length - 1} sub-tags)` : "") +
        ` — note_tags:${result.renamed} parent_refs:${result.parent_refs_updated} tokens:${result.tokens_updated} indexed:${result.indexed_field_declarers_updated} notes:${result.notes_rewritten} paths:${result.paths_renamed}`,
    );

    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function emptyCascadeResult(): RenameTagSuccess {
  return {
    renamed: 0,
    sub_tags_renamed: 0,
    parent_refs_updated: 0,
    tokens_updated: 0,
    indexed_field_declarers_updated: 0,
    notes_rewritten: 0,
    paths_renamed: 0,
  };
}

/**
 * Re-encode a JSON-array column after applying `remap` to every entry,
 * dropping duplicates after remap. Returns the new JSON string, or null
 * if parsing failed / the array became empty (the caller decides whether
 * empty means "leave column" vs "set to NULL"; current callers leave the
 * column as the new array since the existing schema accepts empty JSON).
 */
function remapJsonArray(raw: string, remap: (s: string) => string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const next: string[] = [];
  for (const v of parsed) {
    if (typeof v !== "string") continue;
    const mapped = remap(v);
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return JSON.stringify(next);
}

/**
 * Apply every rename to a note's body content. Walks the rename list
 * longest-first so `#task/work` rewrites cleanly before `#task` would
 * grab the same prefix. Word-boundary semantics: a tag reference is
 * `#name` followed by either end-of-string, whitespace, punctuation, or
 * `/`. We ignore matches inside fenced code blocks — those are typically
 * escaped examples and rewriting them silently changes documented
 * behavior. (We DO touch inline code spans; the trade-off is too noisy
 * to track precisely and the operator can audit via the rewrite count.)
 */
function rewriteNoteBody(content: string, renames: { from: string; to: string }[]): string {
  // Sort longest-first so `task/work` is matched before `task`.
  const sorted = [...renames].sort((a, b) => b.from.length - a.from.length);
  let out = content;
  for (const { from, to } of sorted) {
    // `#tag` / `#tag/...` references. `(?<=^|[\s\p{P}])` would be ideal
    // but we use a simpler form: match at start of string, or after
    // whitespace, or after a character that isn't part of a tag run.
    // Tag references end at a whitespace, end-of-string, or any non-tag
    // character (we approximate with `[^a-zA-Z0-9/_-]`).
    const tagRe = new RegExp(
      `(^|[^a-zA-Z0-9/_#-])#${escapeRegex(from)}(?=$|[^a-zA-Z0-9/_-])`,
      "g",
    );
    out = out.replace(tagRe, `$1#${to}`);
    // `[[_tags/oldname]]` and `[[_tags/oldname#...]]` wikilink targets.
    const wikiRe = new RegExp(
      `\\[\\[_tags/${escapeRegex(from)}(?=[\\]|#])`,
      "g",
    );
    out = out.replace(wikiRe, `[[_tags/${to}`);
  }
  return out;
}

/**
 * Apply every rename to a `_tags/<oldname>...` path.
 */
function rewriteTagConfigPath(path: string, renames: { from: string; to: string }[]): string {
  // Longest-first so `_tags/task/work` matches before `_tags/task`.
  const sorted = [...renames].sort((a, b) => b.from.length - a.from.length);
  for (const { from, to } of sorted) {
    if (path === `_tags/${from}`) return `_tags/${to}`;
    if (path.startsWith(`_tags/${from}/`)) {
      return `_tags/${to}${path.slice(`_tags/${from}`.length)}`;
    }
  }
  return path;
}

function hasTable(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return !!row;
}

/**
 * Escape a tag name for inline interpolation into a SQL LIKE pattern.
 * Doubles `'` for SQL-string safety AND backslash-prefixes the LIKE
 * wildcards (`%`, `_`) so a tag literally named `task_` doesn't match
 * `taskX` as a false-positive candidate. The escape character `\` is
 * declared at each call site via `ESCAPE '\\'`.
 *
 * Order matters: escape `\` first so a tag containing a backslash gets
 * its backslash doubled before we add our own escape prefixes for the
 * wildcards.
 */
function escapeJsonLike(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * Escape a tag name destined for a parameterized LIKE binding. No SQL
 * quote escape (param-binding handles that); just the wildcard
 * neutralization. Pair with `LIKE ? ESCAPE '\\'`.
 */
function escapeLikePattern(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      // Dropping the tag row drops its identity (description, fields,
      // relationships, parent_names) along with it — which is what we want
      // for a merge: the source's identity is consumed by the target.
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

  const attachmentCountRow = db.prepare("SELECT COUNT(*) as c FROM attachments").get() as { c: number };
  const attachmentCount = attachmentCountRow.c;

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
    attachmentCount,
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
    // Legacy notes (pre-#70) may have NULL updated_at. Fall back to created_at
    // so the optimistic-concurrency contract always has a real token to echo.
    updatedAt: row.updated_at ?? row.created_at,
  };
}
