import type Database from "better-sqlite3";
import type { Link } from "./types.js";

export function createLink(
  db: Database.Database,
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
  db: Database.Database,
  sourceId: string,
  targetId: string,
  relationship: string,
): void {
  db.prepare(
    "DELETE FROM links WHERE source_id = ? AND target_id = ? AND relationship = ?",
  ).run(sourceId, targetId, relationship);
}

export function getLinks(
  db: Database.Database,
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
