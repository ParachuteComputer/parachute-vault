/**
 * Vector embeddings for semantic search via sqlite-vec.
 *
 * Provides:
 *   - Vec0 virtual table management
 *   - Insert/update/delete embeddings
 *   - KNN search with optional tag/date filters
 *   - Hybrid search (FTS5 + vector)
 */

import { Database } from "bun:sqlite";
import type { Note } from "./types.js";
import { getNoteTags } from "./notes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmbedFn = (text: string) => Promise<number[]>;

export interface SemanticSearchOpts {
  tags?: string[];
  tagMatch?: "all" | "any";
  excludeTags?: string[];
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export interface SemanticSearchResult {
  note: Note;
  distance: number;
  score: number; // 0-1 normalized similarity
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/** Track which db instances have vec loaded. */
const vecLoadedDbs = new WeakSet<Database>();
/** Whether the sqlite-vec package is available at all. */
let vecPackageAvailable: boolean | null = null;

/**
 * On macOS, Apple's system SQLite disables extension loading.
 * Call this BEFORE opening any databases to use Homebrew's SQLite instead.
 */
export function useHomebrewSQLiteIfNeeded(): boolean {
  if (process.platform !== "darwin") return true; // Linux/Windows: fine as-is
  try {
    const { existsSync } = require("fs");
    const brewPath = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
    if (existsSync(brewPath)) {
      Database.setCustomSQLite(brewPath);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Load the sqlite-vec extension into a database. Safe to call multiple times per db.
 * Returns true if vec is available, false if not installed.
 */
export function loadVecExtension(db: Database): boolean {
  if (vecLoadedDbs.has(db)) return true;
  if (vecPackageAvailable === false) return false;
  try {
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(db);
    vecLoadedDbs.add(db);
    vecPackageAvailable = true;
    return true;
  } catch {
    vecPackageAvailable = false;
    return false;
  }
}

/**
 * Initialize the vec0 virtual table for note embeddings.
 * Must call loadVecExtension first.
 *
 * If the table exists with different dimensions (model change),
 * drops and recreates it (embeddings need to be regenerated anyway).
 */
export function initEmbeddingsTable(db: Database, dimensions: number): void {
  // Track embedding config
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Check for dimension mismatch
  const existing = db.prepare(
    "SELECT value FROM embedding_config WHERE key = 'dimensions'",
  ).get() as { value: string } | undefined;

  if (existing && parseInt(existing.value, 10) !== dimensions) {
    // Model changed — drop old embeddings (they're incompatible)
    db.exec("DROP TABLE IF EXISTS vec_notes");
    db.exec("DELETE FROM embedding_meta");
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_notes USING vec0(
      note_id TEXT PRIMARY KEY,
      embedding float[${dimensions}]
    )
  `);

  // Track embedding metadata (model used, when embedded)
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_meta (
      note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL
    )
  `);

  // Store current dimensions
  db.prepare(
    "INSERT OR REPLACE INTO embedding_config (key, value) VALUES ('dimensions', ?)",
  ).run(String(dimensions));
}

// ---------------------------------------------------------------------------
// Embedding operations
// ---------------------------------------------------------------------------

/**
 * Store an embedding for a note.
 */
export function upsertEmbedding(
  db: Database,
  noteId: string,
  embedding: number[],
  model: string,
): void {
  const vec = serializeVec(embedding);

  // Delete existing if present (vec0 doesn't support UPSERT)
  db.prepare("DELETE FROM vec_notes WHERE note_id = ?").run(noteId);
  db.prepare("INSERT INTO vec_notes (note_id, embedding) VALUES (?, ?)").run(noteId, vec);

  // Update metadata
  db.prepare(`
    INSERT OR REPLACE INTO embedding_meta (note_id, model, embedded_at)
    VALUES (?, ?, ?)
  `).run(noteId, model, new Date().toISOString());
}

/**
 * Delete embedding for a note.
 */
export function deleteEmbedding(db: Database, noteId: string): void {
  db.prepare("DELETE FROM vec_notes WHERE note_id = ?").run(noteId);
  db.prepare("DELETE FROM embedding_meta WHERE note_id = ?").run(noteId);
}

/**
 * Check which notes need embedding (new or updated since last embed).
 */
export function getUnembeddedNoteIds(db: Database): string[] {
  const rows = db.prepare(`
    SELECT n.id FROM notes n
    LEFT JOIN embedding_meta em ON em.note_id = n.id
    WHERE em.note_id IS NULL
       OR em.embedded_at < n.updated_at  -- notes updated since last embed
       -- Notes with NULL updated_at that are already embedded are fine (never changed)
    ORDER BY n.created_at
  `).all() as { id: string }[];
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Semantic KNN search. Returns notes ranked by vector similarity.
 *
 * Filters are pushed into SQL where possible — tag/date filters use a
 * post-KNN JOIN so only matching notes are returned. This means searching
 * "over just my reader notes" actually works efficiently.
 */
export function semanticSearch(
  db: Database,
  queryEmbedding: number[],
  opts?: SemanticSearchOpts,
): SemanticSearchResult[] {
  const limit = opts?.limit ?? 20;
  const vec = serializeVec(queryEmbedding);
  const hasFilters = !!(opts?.tags?.length || opts?.excludeTags?.length || opts?.dateFrom || opts?.dateTo);

  // Fetch more candidates when filtering (need headroom for post-filter)
  const fetchLimit = hasFilters ? limit * 5 : limit;

  // Build the filtered query with SQL-level JOINs
  const { sql, params } = buildFilteredVecQuery(fetchLimit, limit, opts);

  const rows = db.prepare(sql).all(vec, ...params) as {
    note_id: string;
    distance: number;
  }[];

  if (rows.length === 0) return [];

  // Hydrate and score — use 1/(1+d) for stable, batch-independent scoring
  const results: SemanticSearchResult[] = [];

  for (const row of rows) {
    const note = hydrateNote(db, row.note_id);
    if (!note) continue;

    results.push({
      note,
      distance: row.distance,
      score: 1 / (1 + row.distance),
    });
  }

  return results;
}

/**
 * Build a vec0 KNN query with SQL-level filters.
 * Uses subquery pattern: KNN first (vec0 requires LIMIT in its query),
 * then JOIN with notes/tags to filter.
 */
function buildFilteredVecQuery(
  fetchLimit: number,
  resultLimit: number,
  opts?: SemanticSearchOpts,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const joins: string[] = [];
  const conditions: string[] = [];

  // Tag includes
  if (opts?.tags && opts.tags.length > 0) {
    const match = opts.tagMatch ?? "all";
    if (match === "any") {
      const placeholders = opts.tags.map(() => "?").join(", ");
      joins.push(`JOIN note_tags nt_inc ON nt_inc.note_id = sub.note_id AND nt_inc.tag_name IN (${placeholders})`);
      params.push(...opts.tags);
    } else {
      for (let i = 0; i < opts.tags.length; i++) {
        const alias = `nt_inc${i}`;
        joins.push(`JOIN note_tags ${alias} ON ${alias}.note_id = sub.note_id AND ${alias}.tag_name = ?`);
        params.push(opts.tags[i]);
      }
    }
  }

  // Tag excludes
  if (opts?.excludeTags && opts.excludeTags.length > 0) {
    for (const tag of opts.excludeTags) {
      conditions.push(`NOT EXISTS (SELECT 1 FROM note_tags ex WHERE ex.note_id = sub.note_id AND ex.tag_name = ?)`);
      params.push(tag);
    }
  }

  // Date filters
  if (opts?.dateFrom) {
    joins.push("JOIN notes n_date ON n_date.id = sub.note_id");
    conditions.push("n_date.created_at >= ?");
    params.push(opts.dateFrom);
    if (opts?.dateTo) {
      conditions.push("n_date.created_at < ?");
      params.push(opts.dateTo);
    }
  } else if (opts?.dateTo) {
    joins.push("JOIN notes n_date ON n_date.id = sub.note_id");
    conditions.push("n_date.created_at < ?");
    params.push(opts.dateTo);
  }

  params.push(resultLimit);

  const hasPostFilter = joins.length > 0 || conditions.length > 0;

  if (!hasPostFilter) {
    return {
      sql: `
        SELECT v.note_id, v.distance
        FROM vec_notes v
        WHERE v.embedding MATCH ?
        ORDER BY v.distance
        LIMIT ?
      `,
      params: [resultLimit],
    };
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return {
    sql: `
      SELECT DISTINCT sub.note_id, sub.distance FROM (
        SELECT v.note_id, v.distance
        FROM vec_notes v
        WHERE v.embedding MATCH ?
        ORDER BY v.distance
        LIMIT ${fetchLimit}
      ) sub
      ${joins.join("\n")}
      ${whereClause}
      ORDER BY sub.distance
      LIMIT ?
    `,
    params,
  };
}

/**
 * Hybrid search: combine FTS5 keyword results with vector similarity.
 * Returns notes that match either/both, ranked by combined score.
 */
export function hybridSearch(
  db: Database,
  query: string,
  queryEmbedding: number[],
  opts?: SemanticSearchOpts & { keywordWeight?: number; vectorWeight?: number },
): SemanticSearchResult[] {
  const limit = opts?.limit ?? 20;
  const kw = opts?.keywordWeight ?? 0.3;
  const vw = opts?.vectorWeight ?? 0.7;

  // Get keyword results
  const ftsResults = new Map<string, number>();
  try {
    const ftsRows = db.prepare(`
      SELECT n.id, rank FROM notes n
      JOIN notes_fts fts ON fts.rowid = n.rowid
      WHERE notes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit * 2) as { id: string; rank: number }[];

    // Normalize FTS ranks (rank is negative, closer to 0 = better)
    const minRank = Math.min(...ftsRows.map((r) => r.rank), -0.001);
    for (const row of ftsRows) {
      ftsResults.set(row.id, row.rank / minRank); // 0-1, higher = better match
    }
  } catch {
    // FTS might fail on invalid query syntax — continue with vector only
  }

  // Get vector results
  const vecResults = semanticSearch(db, queryEmbedding, { ...opts, limit: limit * 2 });
  const vecMap = new Map<string, number>();
  for (const r of vecResults) {
    vecMap.set(r.note.id, r.score);
  }

  // Combine scores
  const combined = new Map<string, { note: Note; score: number; distance: number }>();

  for (const r of vecResults) {
    const ftsScore = ftsResults.get(r.note.id) ?? 0;
    const vecScore = r.score;
    combined.set(r.note.id, {
      note: r.note,
      score: kw * ftsScore + vw * vecScore,
      distance: r.distance,
    });
  }

  // Add FTS-only results (not in vector results)
  for (const [noteId, ftsScore] of ftsResults) {
    if (!combined.has(noteId)) {
      const note = hydrateNote(db, noteId);
      if (note && passesTagFilter(note, opts)) {
        combined.set(noteId, {
          note,
          score: kw * ftsScore,
          distance: Infinity,
        });
      }
    }
  }

  // Sort by combined score descending
  return [...combined.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      note: r.note,
      distance: r.distance,
      score: r.score,
    }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeVec(embedding: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(embedding).buffer);
}

interface NoteRow {
  id: string;
  content: string;
  path: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string | null;
}

function hydrateNote(db: Database, noteId: string): Note | null {
  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as NoteRow | undefined;
  if (!row) return null;

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
    tags: getNoteTags(db, row.id),
  };
}

function passesTagFilter(note: Note, opts?: SemanticSearchOpts): boolean {
  if (!opts) return true;

  if (opts.tags && opts.tags.length > 0) {
    const noteTags = new Set(note.tags ?? []);
    const match = opts.tagMatch ?? "all";
    if (match === "all") {
      if (!opts.tags.every((t) => noteTags.has(t))) return false;
    } else {
      if (!opts.tags.some((t) => noteTags.has(t))) return false;
    }
  }

  if (opts.excludeTags && opts.excludeTags.length > 0) {
    const noteTags = new Set(note.tags ?? []);
    if (opts.excludeTags.some((t) => noteTags.has(t))) return false;
  }

  return true;
}
