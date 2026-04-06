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
 */
export function initEmbeddingsTable(db: Database, dimensions: number): void {
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
       OR em.embedded_at < n.updated_at
    ORDER BY n.created_at
  `).all() as { id: string }[];
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Semantic KNN search. Returns notes ranked by vector similarity.
 */
export function semanticSearch(
  db: Database,
  queryEmbedding: number[],
  opts?: SemanticSearchOpts,
): SemanticSearchResult[] {
  const limit = opts?.limit ?? 20;
  const vec = serializeVec(queryEmbedding);

  // Fetch more candidates than needed so we can filter
  const fetchLimit = limit * 3;

  const rows = db.prepare(`
    SELECT v.note_id, v.distance
    FROM vec_notes v
    WHERE v.embedding MATCH ?
    ORDER BY v.distance
    LIMIT ?
  `).all(vec, fetchLimit) as { note_id: string; distance: number }[];

  if (rows.length === 0) return [];

  // Hydrate notes and apply filters
  const results: SemanticSearchResult[] = [];
  const maxDist = rows[rows.length - 1]?.distance || 1;

  for (const row of rows) {
    const note = hydrateNote(db, row.note_id);
    if (!note) continue;

    // Apply tag filters
    if (!passesTagFilter(note, opts)) continue;

    // Apply date filters
    if (opts?.dateFrom && note.createdAt < opts.dateFrom) continue;
    if (opts?.dateTo && note.createdAt >= opts.dateTo) continue;

    // Normalize distance to 0-1 similarity score
    const score = maxDist > 0 ? 1 - (row.distance / (maxDist * 1.5)) : 1;

    results.push({
      note,
      distance: row.distance,
      score: Math.max(0, Math.min(1, score)),
    });

    if (results.length >= limit) break;
  }

  return results;
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
