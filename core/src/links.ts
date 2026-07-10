import { Database } from "bun:sqlite";
import type { Link, NoteSummary, HydratedLink } from "./types.js";
import { getNoteTagsForNotes } from "./notes.js";
import { chunkForInClause } from "./sql-in.js";

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

/**
 * Delete every outbound link from `sourceId` carrying `relationship`,
 * regardless of target. Used by the `reference`-field auto-link sync
 * (core/src/store.ts's `syncReferenceFieldLinks`, vault#typed-reference-field)
 * to re-establish "this field's link" as a single source of truth: rather
 * than tracking the PRIOR resolved target to delete exactly one edge, the
 * sync clears every edge under the field's relationship name and recreates
 * at most one from the field's current value. This is safe because a
 * `reference` field's relationship name is field-owned — a hand-authored
 * `links` entry using the SAME relationship name on the SAME note is
 * expected to be superseded by the field, not preserved alongside it.
 */
export function deleteLinksBySourceRelationship(
  db: Database,
  sourceId: string,
  relationship: string,
): void {
  db.prepare(
    "DELETE FROM links WHERE source_id = ? AND relationship = ?",
  ).run(sourceId, relationship);
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

function getNoteSummaries(db: Database, noteIds: string[]): Map<string, NoteSummary> {
  const map = new Map<string, NoteSummary>();
  if (noteIds.length === 0) return map;
  const ids = [...new Set(noteIds)];
  const rows: SummaryRow[] = [];
  // Chunk under the DO 100-bound-param cap (see sql-in.ts).
  for (const chunk of chunkForInClause(ids)) {
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(...db.prepare(
      `SELECT id, path, metadata, created_at, updated_at FROM notes WHERE id IN (${placeholders})`,
    ).all(...chunk) as SummaryRow[]);
  }
  // ONE batched tag lookup for every summary on the page — this used to be
  // a per-summary query, which made hydrating a well-linked note cost
  // O(linked notes) round-trips (2026-06-10 perf measurements).
  const tagsById = getNoteTagsForNotes(db, rows.map((r) => r.id));
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      path: row.path ?? undefined,
      metadata: parseMetadata(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
      tags: tagsById.get(row.id) ?? [],
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
  return hydrateLinks(db, links);
}

/** Attach source/target note summaries to a set of links (batched). */
function hydrateLinks(db: Database, links: Link[]): HydratedLink[] {
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

/**
 * Batch variant of `getLinksHydrated` for the `include_links` enrichment
 * loops (MCP query-notes list path, REST GET /api/notes): hydrates links for
 * a whole PAGE of notes in a constant number of queries — two indexed
 * IN-list scans over `links` per chunk, one summary fetch, one batched tag
 * lookup — instead of (1 link query + 1 summary query + N tag queries) per
 * note. See the 2026-06-10 perf measurements (include_links scaled
 * per-returned-note).
 *
 * Returns a map keyed by every requested note id (empty array when the note
 * has no links). Each note's list contains links touching it in either
 * direction, ordered created_at DESC — same contract as the single-note
 * `getLinksHydrated`. A link between two notes that are BOTH on the page
 * appears in both notes' lists, exactly as the per-note calls produced.
 */
export function getLinksHydratedForNotes(
  db: Database,
  noteIds: string[],
): Map<string, HydratedLink[]> {
  const result = new Map<string, HydratedLink[]>();
  if (noteIds.length === 0) return result;
  const ids = [...new Set(noteIds)];
  for (const id of ids) result.set(id, []);

  // Collect every link touching any requested note, deduped on the
  // (source, target, relationship) primary key so a link whose endpoints
  // are both on the page is fetched once.
  const rowsByKey = new Map<string, LinkRow>();
  // Chunk under the DO 100-bound-param cap (see sql-in.ts).
  for (const chunk of chunkForInClause(ids)) {
    const placeholders = chunk.map(() => "?").join(", ");
    for (const column of ["source_id", "target_id"] as const) {
      const rows = db.prepare(
        `SELECT * FROM links WHERE ${column} IN (${placeholders})`,
      ).all(...chunk) as LinkRow[];
      for (const row of rows) {
        rowsByKey.set(`${row.source_id}|${row.target_id}|${row.relationship}`, row);
      }
    }
  }

  // Stable sort newest-first to mirror the single-note SQL's
  // ORDER BY created_at DESC (ISO timestamps sort lexicographically).
  const links = [...rowsByKey.values()]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .map(rowToLink);

  const hydrated = hydrateLinks(db, links);
  for (const link of hydrated) {
    result.get(link.sourceId)?.push(link);
    if (link.targetId !== link.sourceId) result.get(link.targetId)?.push(link);
  }
  return result;
}

/**
 * Batch link-degree counter (vault feedback #4).
 *
 * Returns the link **degree** (raw row count) for each requested note id,
 * never materializing link rows. Degree is defined as a sum of two
 * directional row counts:
 *
 *   - `outbound` = `COUNT(*) FROM links WHERE source_id = id`
 *   - `inbound`  = `COUNT(*) FROM links WHERE target_id = id`
 *   - `both`     = outbound + inbound   (default)
 *
 * It is a **row count**, matching `getVaultStats.linkCount` (notes.ts):
 * two typed links A→B (different `relationship`) count as 2, and a
 * **self-loop** (source_id == target_id) counts as **degree 2** under
 * `both` — once via the outbound query, once via the inbound query.
 *
 * ⚠️ This directional-sum definition MUST stay identical to the
 * `order_by=link_count` sort key in `queryNotes` (notes.ts), which uses
 * `(SELECT COUNT(*) ... source_id=n.id) + (SELECT COUNT(*) ... target_id=n.id)`.
 * A single `COUNT(*) ... WHERE source_id=id OR target_id=id` would count a
 * self-loop ONCE and diverge — do NOT use that shape here.
 *
 * Each direction is one grouped query over an existing B-tree index
 * (`idx_links_source` / `idx_links_target`), so the whole page costs at
 * most two index scans regardless of page size. The IN-list is chunked to
 * stay under SQLite's bound-variable limit on very large pages.
 *
 * Returns 0 for ids with no links (every requested id is present in the map).
 */
export function getLinkCounts(
  db: Database,
  noteIds: string[],
  direction: "both" | "outbound" | "inbound" = "both",
): Map<string, number> {
  const counts = new Map<string, number>();
  if (noteIds.length === 0) return counts;

  // Dedupe so a repeated id doesn't inflate the IN-list or get summed twice
  // when the same chunk runs the outbound + inbound grouped queries.
  const ids = [...new Set(noteIds)];
  for (const id of ids) counts.set(id, 0);

  const wantOutbound = direction === "outbound" || direction === "both";
  const wantInbound = direction === "inbound" || direction === "both";

  // Chunk under the Cloudflare Durable Object SQLite 100-bound-param cap
  // (bun:sqlite tolerates 999+, DO SQLite rejects >100). See sql-in.ts.
  for (const chunk of chunkForInClause(ids)) {
    const placeholders = chunk.map(() => "?").join(", ");

    if (wantOutbound) {
      const rows = db.prepare(
        `SELECT source_id AS id, COUNT(*) AS c FROM links
         WHERE source_id IN (${placeholders}) GROUP BY source_id`,
      ).all(...chunk) as { id: string; c: number }[];
      for (const row of rows) {
        counts.set(row.id, (counts.get(row.id) ?? 0) + row.c);
      }
    }

    if (wantInbound) {
      const rows = db.prepare(
        `SELECT target_id AS id, COUNT(*) AS c FROM links
         WHERE target_id IN (${placeholders}) GROUP BY target_id`,
      ).all(...chunk) as { id: string; c: number }[];
      for (const row of rows) {
        counts.set(row.id, (counts.get(row.id) ?? 0) + row.c);
      }
    }
  }

  return counts;
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
 *
 * `isTraversable` (vault#439) is an OPTIONAL per-note predicate. When
 * provided, a neighbor that fails the predicate is treated as a WALL: it is
 * neither added to the results nor pushed onto the frontier, so the BFS
 * cannot reach further notes THROUGH it. This makes a tag-scoped traversal
 * symmetric with `find-path` (which guards every hop) — scope acts as a wall,
 * not a sieve. Omitted (every unscoped / internal caller) → the full graph is
 * walked exactly as before. Core stays scope-unaware: it receives a plain
 * `(noteId) => boolean` closure and never imports the server's tag-scope
 * module. The anchor `noteId` is never passed through the predicate — the
 * caller is responsible for confirming the anchor is in scope before calling.
 */
export function traverseLinks(
  db: Database,
  noteId: string,
  opts?: { max_depth?: number; relationship?: string; isTraversable?: (noteId: string) => boolean },
): TraversalNode[] {
  const maxDepth = opts?.max_depth ?? 2;
  const relFilter = opts?.relationship;
  const isTraversable = opts?.isTraversable;
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
          // Wall (vault#439): an out-of-scope neighbor is marked visited (so
          // it isn't re-evaluated) but is NOT added to the frontier or the
          // results — the BFS can't traverse THROUGH it to reach notes beyond.
          if (isTraversable && !isTraversable(row.target_id)) continue;
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
          // Wall (vault#439): see the outbound branch above.
          if (isTraversable && !isTraversable(row.source_id)) continue;
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

/** Hydrated find-path result — see `hydratePathResult` for field semantics. */
export interface FindPathResult {
  /** Note IDs, source → target (unchanged shape — back-compat). */
  path: string[];
  /** relationships[i] is the edge connecting path[i] to path[i+1] (unchanged shape). */
  relationships: string[];
  /**
   * Hydrated companion to `path[]` (vault#550, additive): one entry per
   * node, in the same order, carrying the note's `path` field alongside
   * its `id` — so a caller doesn't have to round-trip each id through a
   * separate note fetch just to render a human-legible chain.
   */
  nodes: { id: string; path: string | null }[];
  /**
   * Hydrated companion to `relationships[]` (vault#550, additive): each
   * hop as a self-contained `{source, target, relationship}` edge plus
   * both endpoints' note `path`, so a graph-rendering client can draw the
   * chain without cross-referencing `nodes`.
   */
  edges: {
    source: string;
    target: string;
    relationship: string;
    sourcePath: string | null;
    targetPath: string | null;
  }[];
}

/**
 * Hydrate a raw BFS result (`path` ids + `relationships`) with each node's
 * note `path` field, in ONE batched query (not one fetch per hop). `path`
 * and `relationships` pass through byte-identical to before this existed —
 * `nodes`/`edges` are pure additions.
 */
function hydratePathResult(db: Database, path: string[], relationships: string[]): FindPathResult {
  const pathById = new Map<string, string | null>();
  for (const chunk of chunkForInClause(path)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.prepare(`SELECT id, path FROM notes WHERE id IN (${placeholders})`).all(...chunk) as
      { id: string; path: string | null }[];
    for (const row of rows) pathById.set(row.id, row.path);
  }

  const nodes = path.map((id) => ({ id, path: pathById.get(id) ?? null }));
  const edges: FindPathResult["edges"] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const source = path[i]!;
    const target = path[i + 1]!;
    edges.push({
      source,
      target,
      relationship: relationships[i] ?? "",
      sourcePath: pathById.get(source) ?? null,
      targetPath: pathById.get(target) ?? null,
    });
  }

  return { path, relationships, nodes, edges };
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
): FindPathResult | null {
  const maxDepth = opts?.max_depth ?? 5;

  if (sourceId === targetId) {
    return hydratePathResult(db, [sourceId], []);
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
          return hydratePathResult(db, path, relationships);
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
