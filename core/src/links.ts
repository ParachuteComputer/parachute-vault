import { Database } from "bun:sqlite";
import type { Link, NoteSummary, HydratedLink } from "./types.js";
import { getNoteTags } from "./notes.js";

export function createLink(
  db: Database,
  sourceId: string,
  targetId: string,
  relationship: string,
  metadata?: Record<string, unknown>,
): Link {
  const now = new Date().toISOString();
  const metadataJson = metadata ? JSON.stringify(metadata) : "{}";

  db.prepare(
    `INSERT OR IGNORE INTO links (source_id, target_id, relationship, metadata, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sourceId, targetId, relationship, metadataJson, now);

  const row = db.prepare(
    `SELECT * FROM links WHERE source_id = ? AND target_id = ? AND relationship = ?`,
  ).get(sourceId, targetId, relationship) as LinkRow;
  return rowToLink(row);
}

export function deleteLink(
  db: Database,
  sourceId: string,
  targetId: string,
  relationship: string,
): void {
  db.prepare(
    "DELETE FROM links WHERE source_id = ? AND target_id = ? AND relationship = ?",
  ).run(sourceId, targetId, relationship);
}

export function getLinks(
  db: Database,
  noteId: string,
  opts?: { direction?: "outbound" | "inbound" | "both" },
): Link[] {
  return listLinks(db, { noteId, direction: opts?.direction });
}

/**
 * List links with optional filters.
 * - If `noteId` is provided: restricts to links touching that note
 *   (respects `direction`: outbound, inbound, or both).
 * - If `relationship` is provided: restricts to links of that type.
 * - Without filters: returns every link in the vault.
 *
 * Returns bare `Link[]` (no hydration). Callers that need note details
 * should pair the result with `getNote` / `getNotes`.
 */
export function listLinks(
  db: Database,
  opts?: {
    noteId?: string;
    direction?: "outbound" | "inbound" | "both";
    relationship?: string;
  },
): Link[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (opts?.noteId) {
    const direction = opts.direction ?? "both";
    if (direction === "outbound") {
      conditions.push("source_id = ?");
      params.push(opts.noteId);
    } else if (direction === "inbound") {
      conditions.push("target_id = ?");
      params.push(opts.noteId);
    } else {
      conditions.push("(source_id = ? OR target_id = ?)");
      params.push(opts.noteId, opts.noteId);
    }
  }

  if (opts?.relationship) {
    conditions.push("relationship = ?");
    params.push(opts.relationship);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM links ${where} ORDER BY created_at DESC`;
  const rows = db.prepare(sql).all(...params) as LinkRow[];
  return rows.map(rowToLink);
}

// ---- Note Summaries (for hydrated results) ----

interface SummaryRow {
  id: string;
  path: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string | null;
}

function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw || raw === "{}") return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function getNoteSummary(db: Database, noteId: string): NoteSummary | undefined {
  const row = db.prepare(
    "SELECT id, path, metadata, created_at, updated_at FROM notes WHERE id = ?",
  ).get(noteId) as SummaryRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    path: row.path ?? undefined,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    tags: getNoteTags(db, row.id),
  };
}

function getNoteSummaries(db: Database, noteIds: string[]): Map<string, NoteSummary> {
  const map = new Map<string, NoteSummary>();
  if (noteIds.length === 0) return map;
  const placeholders = noteIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT id, path, metadata, created_at, updated_at FROM notes WHERE id IN (${placeholders})`,
  ).all(...noteIds) as SummaryRow[];
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      path: row.path ?? undefined,
      metadata: parseMetadata(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
      tags: getNoteTags(db, row.id),
    });
  }
  return map;
}

/**
 * Get links for a note with hydrated note summaries.
 * Always includes note path/tags. Optionally includes content.
 */
export function getLinksHydrated(
  db: Database,
  noteId: string,
  opts?: { direction?: "outbound" | "inbound" | "both"; include_content?: boolean },
): HydratedLink[] {
  const links = getLinks(db, noteId, opts);

  // Collect all note IDs we need to hydrate
  const noteIds = new Set<string>();
  for (const link of links) {
    noteIds.add(link.sourceId);
    noteIds.add(link.targetId);
  }

  const summaries = getNoteSummaries(db, [...noteIds]);

  return links.map((link) => ({
    ...link,
    sourceNote: summaries.get(link.sourceId),
    targetNote: summaries.get(link.targetId),
  }));
}

// ---- Deeper Link Queries ----

export interface TraversalNode {
  noteId: string;
  depth: number;
  relationship: string;
  direction: "outbound" | "inbound";
  note?: NoteSummary;
}

/**
 * Traverse the link graph from a starting note up to `maxDepth` hops.
 * Returns all reachable notes with their depth and how they were reached.
 */
export function traverseLinks(
  db: Database,
  noteId: string,
  opts?: { max_depth?: number; relationship?: string },
): TraversalNode[] {
  const maxDepth = opts?.max_depth ?? 2;
  const relFilter = opts?.relationship;
  const visited = new Set<string>([noteId]);
  const results: TraversalNode[] = [];
  let frontier = [noteId];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      // Outbound links
      let outbound: LinkRow[];
      if (relFilter) {
        outbound = db.prepare(
          "SELECT * FROM links WHERE source_id = ? AND relationship = ?",
        ).all(currentId, relFilter) as LinkRow[];
      } else {
        outbound = db.prepare(
          "SELECT * FROM links WHERE source_id = ?",
        ).all(currentId) as LinkRow[];
      }

      for (const row of outbound) {
        if (!visited.has(row.target_id)) {
          visited.add(row.target_id);
          nextFrontier.push(row.target_id);
          results.push({
            noteId: row.target_id,
            depth,
            relationship: row.relationship,
            direction: "outbound",
          });
        }
      }

      // Inbound links
      let inbound: LinkRow[];
      if (relFilter) {
        inbound = db.prepare(
          "SELECT * FROM links WHERE target_id = ? AND relationship = ?",
        ).all(currentId, relFilter) as LinkRow[];
      } else {
        inbound = db.prepare(
          "SELECT * FROM links WHERE target_id = ?",
        ).all(currentId) as LinkRow[];
      }

      for (const row of inbound) {
        if (!visited.has(row.source_id)) {
          visited.add(row.source_id);
          nextFrontier.push(row.source_id);
          results.push({
            noteId: row.source_id,
            depth,
            relationship: row.relationship,
            direction: "inbound",
          });
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  // Hydrate with note summaries
  const noteIds = results.map((r) => r.noteId);
  const summaries = getNoteSummaries(db, noteIds);
  for (const result of results) {
    result.note = summaries.get(result.noteId);
  }

  return results;
}

/**
 * Find a path between two notes in the link graph.
 * Returns the sequence of note IDs from source to target, or null if no path exists.
 */
export function findPath(
  db: Database,
  sourceId: string,
  targetId: string,
  opts?: { max_depth?: number },
): { path: string[]; relationships: string[] } | null {
  const maxDepth = opts?.max_depth ?? 5;

  if (sourceId === targetId) {
    return { path: [sourceId], relationships: [] };
  }

  // BFS from source
  const visited = new Map<string, { parent: string; relationship: string }>();
  visited.set(sourceId, { parent: "", relationship: "" });
  let frontier = [sourceId];

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      // Check all neighbors (both directions)
      const outbound = db.prepare(
        "SELECT * FROM links WHERE source_id = ?",
      ).all(currentId) as LinkRow[];

      const inbound = db.prepare(
        "SELECT * FROM links WHERE target_id = ?",
      ).all(currentId) as LinkRow[];

      const neighbors: { id: string; rel: string }[] = [
        ...outbound.map((r) => ({ id: r.target_id, rel: r.relationship })),
        ...inbound.map((r) => ({ id: r.source_id, rel: r.relationship })),
      ];

      for (const neighbor of neighbors) {
        if (visited.has(neighbor.id)) continue;
        visited.set(neighbor.id, { parent: currentId, relationship: neighbor.rel });
        nextFrontier.push(neighbor.id);

        if (neighbor.id === targetId) {
          // Reconstruct path
          const path: string[] = [];
          const relationships: string[] = [];
          let current = targetId;
          while (current !== sourceId) {
            path.unshift(current);
            const entry = visited.get(current)!;
            relationships.unshift(entry.relationship);
            current = entry.parent;
          }
          path.unshift(sourceId);
          return { path, relationships };
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return null;
}

// ---- Internal ----

interface LinkRow {
  source_id: string;
  target_id: string;
  relationship: string;
  metadata: string | null;
  created_at: string;
}

function rowToLink(row: LinkRow): Link {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata && row.metadata !== "{}") {
    try { metadata = JSON.parse(row.metadata); } catch {}
  }
  return {
    sourceId: row.source_id,
    targetId: row.target_id,
    relationship: row.relationship,
    metadata,
    createdAt: row.created_at,
  };
}
