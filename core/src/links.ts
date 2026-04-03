import { Database } from "bun:sqlite";
import type { Link } from "./types.js";

export function createLink(
  db: Database,
  sourceId: string,
  targetId: string,
  relationship: string,
): Link {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT OR IGNORE INTO links (source_id, target_id, relationship, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sourceId, targetId, relationship, now);

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
  const direction = opts?.direction ?? "both";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (direction === "outbound" || direction === "both") {
    conditions.push("source_id = ?");
    params.push(noteId);
  }
  if (direction === "inbound" || direction === "both") {
    conditions.push("target_id = ?");
    params.push(noteId);
  }

  const sql = `SELECT * FROM links WHERE (${conditions.join(" OR ")}) ORDER BY created_at DESC`;
  const rows = db.prepare(sql).all(...params) as LinkRow[];
  return rows.map(rowToLink);
}

// ---- Deeper Link Queries ----

export interface TraversalNode {
  noteId: string;
  depth: number;
  relationship: string;
  direction: "outbound" | "inbound";
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
  created_at: string;
}

function rowToLink(row: LinkRow): Link {
  return {
    sourceId: row.source_id,
    targetId: row.target_id,
    relationship: row.relationship,
    createdAt: row.created_at,
  };
}
