import { Database } from "bun:sqlite";
import * as linkOps from "./links.js";

// ---------------------------------------------------------------------------
// Parser — extract [[wikilinks]] from markdown content
// ---------------------------------------------------------------------------

export interface ParsedWikilink {
  /** Raw match text (e.g., "[[Note Name|Display]]") */
  raw: string;
  /** Target path/name (e.g., "Note Name") */
  target: string;
  /** Display text if aliased (e.g., "Display") */
  display?: string;
  /** Section anchor (e.g., "Heading" from [[Note#Heading]]) */
  anchor?: string;
  /** Block reference (e.g., "block-id" from [[Note#^block-id]]) */
  blockRef?: string;
  /** Whether this is an embed (![[...]]) */
  embed: boolean;
}

/**
 * Parse all [[wikilinks]] from markdown content.
 *
 * Handles:
 *   [[Target]]
 *   [[Target|Display Text]]
 *   [[Target#Heading]]
 *   [[Target#^block-id]]
 *   [[Target#Heading|Display]]
 *   ![[Target]] (embeds)
 *
 * Ignores wikilinks inside code blocks and inline code.
 */
export function parseWikilinks(content: string): ParsedWikilink[] {
  // Strip code blocks and inline code to avoid false matches
  const stripped = stripCode(content);

  const results: ParsedWikilink[] = [];
  // Match !?[[...]] — non-greedy, no newlines inside
  const regex = /(!)?\[\[([^\[\]\n]+?)\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(stripped)) !== null) {
    const embed = match[1] === "!";
    const inner = match[2]!;

    // Split on | for display text: [[target|display]]
    const pipeIdx = inner.indexOf("|");
    let targetPart: string;
    let display: string | undefined;
    if (pipeIdx !== -1) {
      targetPart = inner.slice(0, pipeIdx);
      display = inner.slice(pipeIdx + 1);
    } else {
      targetPart = inner;
    }

    // Split on # for anchor: [[target#heading]] or [[target#^block-id]]
    let target: string;
    let anchor: string | undefined;
    let blockRef: string | undefined;
    const hashIdx = targetPart.indexOf("#");
    if (hashIdx !== -1) {
      target = targetPart.slice(0, hashIdx);
      const fragment = targetPart.slice(hashIdx + 1);
      if (fragment.startsWith("^")) {
        blockRef = fragment.slice(1);
      } else {
        anchor = fragment;
      }
    } else {
      target = targetPart;
    }

    target = target.trim();
    if (!target) continue;

    results.push({
      raw: match[0],
      target,
      display: display?.trim(),
      anchor,
      blockRef,
      embed,
    });
  }

  return results;
}

/**
 * Strip fenced code blocks and inline code from content.
 * Replaces them with spaces to preserve string positions.
 */
function stripCode(content: string): string {
  // Replace fenced code blocks (``` ... ```)
  let result = content.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
  // Replace inline code (` ... `)
  result = result.replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));
  return result;
}

// ---------------------------------------------------------------------------
// Resolution — match wikilink targets to notes by path
// ---------------------------------------------------------------------------

/**
 * Resolve a wikilink target to a note ID.
 *
 * Resolution order:
 * 1. Exact path match (case-insensitive)
 * 2. Basename match — target matches the last segment of a path
 *    (e.g., "README" matches "Projects/Parachute/README")
 *    Only if there's exactly one match (ambiguous = unresolved)
 */
export function resolveWikilink(db: Database, target: string): string | null {
  // 1. Exact match (case-insensitive)
  const exact = db.prepare(
    "SELECT id FROM notes WHERE path = ? COLLATE NOCASE",
  ).get(target) as { id: string } | undefined;
  if (exact) return exact.id;

  // 2. Basename match — last path segment equals target
  // e.g., target "README" matches path "Projects/Parachute/README"
  const basename = db.prepare(`
    SELECT id FROM notes
    WHERE path IS NOT NULL
      AND (
        path = ? COLLATE NOCASE
        OR path LIKE ? COLLATE NOCASE
      )
  `).all(target, `%/${target}`) as { id: string }[];

  if (basename.length === 1) return basename[0]!.id;

  // Ambiguous or no match
  return null;
}

/** Result of a detailed wikilink resolution. */
export interface WikilinkResolution {
  resolved: boolean;
  note_id?: string;
  path?: string;
  ambiguous?: boolean;
  candidates: { note_id: string; path: string }[];
}

/**
 * Resolve a wikilink target with full detail — single match, ambiguous, or unresolved.
 */
export function resolveWikilinkDetailed(db: Database, target: string): WikilinkResolution {
  // 1. Exact match (case-insensitive)
  const exact = db.prepare(
    "SELECT id, path FROM notes WHERE path = ? COLLATE NOCASE",
  ).get(target) as { id: string; path: string } | undefined;
  if (exact) {
    return { resolved: true, note_id: exact.id, path: exact.path, candidates: [] };
  }

  // 2. Basename match
  const basename = db.prepare(`
    SELECT id, path FROM notes
    WHERE path IS NOT NULL
      AND (
        path = ? COLLATE NOCASE
        OR path LIKE ? COLLATE NOCASE
      )
  `).all(target, `%/${target}`) as { id: string; path: string }[];

  if (basename.length === 1) {
    return { resolved: true, note_id: basename[0]!.id, path: basename[0]!.path, candidates: [] };
  }

  if (basename.length > 1) {
    return {
      resolved: false,
      ambiguous: true,
      candidates: basename.map((r) => ({ note_id: r.id, path: r.path })),
    };
  }

  return { resolved: false, ambiguous: false, candidates: [] };
}

/** Entry from the unresolved_wikilinks table. */
export interface UnresolvedWikilink {
  source_id: string;
  source_path?: string;
  target_path: string;
}

/**
 * List unresolved wikilinks across the vault.
 */
export function listUnresolvedWikilinks(db: Database, limit = 50): { unresolved: UnresolvedWikilink[]; count: number } {
  let total: number;
  let rows: { source_id: string; target_path: string }[];
  try {
    total = (db.prepare("SELECT COUNT(*) as c FROM unresolved_wikilinks").get() as { c: number }).c;
    rows = db.prepare(
      "SELECT source_id, target_path FROM unresolved_wikilinks ORDER BY source_id LIMIT ?",
    ).all(limit) as { source_id: string; target_path: string }[];
  } catch {
    // Table doesn't exist yet
    return { unresolved: [], count: 0 };
  }

  // Hydrate source paths
  if (rows.length === 0) return { unresolved: [], count: total };

  const sourceIds = [...new Set(rows.map((r) => r.source_id))];
  const placeholders = sourceIds.map(() => "?").join(", ");
  const pathRows = db.prepare(
    `SELECT id, path FROM notes WHERE id IN (${placeholders})`,
  ).all(...sourceIds) as { id: string; path: string | null }[];
  const pathMap = new Map(pathRows.map((r) => [r.id, r.path]));

  const unresolved: UnresolvedWikilink[] = rows.map((r) => ({
    source_id: r.source_id,
    source_path: pathMap.get(r.source_id) ?? undefined,
    target_path: r.target_path,
  }));

  return { unresolved, count: total };
}

// ---------------------------------------------------------------------------
// Sync — maintain wikilink-based links for a note
// ---------------------------------------------------------------------------

const WIKILINK_REL = "wikilink";

/**
 * Sync wikilink-based links for a note.
 * Parses content for [[wikilinks]], resolves targets, creates/removes links.
 *
 * Returns counts of changes made.
 */
export function syncWikilinks(
  db: Database,
  noteId: string,
  content: string,
): { added: number; removed: number; unresolved: string[] } {
  const parsed = parseWikilinks(content);

  // Deduplicate by target (same target mentioned multiple times = one link)
  const targetMap = new Map<string, ParsedWikilink>();
  for (const wl of parsed) {
    const key = wl.target.toLowerCase();
    if (!targetMap.has(key)) {
      targetMap.set(key, wl);
    }
  }

  // Resolve each unique target
  const resolvedLinks = new Map<string, { targetId: string; wl: ParsedWikilink }>();
  const unresolved: string[] = [];

  for (const [key, wl] of targetMap) {
    const targetId = resolveWikilink(db, wl.target);
    if (targetId && targetId !== noteId) {
      // Don't create self-links
      resolvedLinks.set(targetId, { targetId, wl });
    } else if (!targetId) {
      unresolved.push(wl.target);
    }
  }

  // Get existing wikilink links from this note
  const existing = linkOps.getLinks(db, noteId, { direction: "outbound" })
    .filter((l) => l.relationship === WIKILINK_REL);

  const existingTargets = new Set(existing.map((l) => l.targetId));
  const desiredTargets = new Set(resolvedLinks.keys());

  // Add new links
  let added = 0;
  for (const [targetId, { wl }] of resolvedLinks) {
    if (!existingTargets.has(targetId)) {
      const metadata: Record<string, unknown> = {};
      if (wl.display) metadata.display = wl.display;
      if (wl.anchor) metadata.anchor = wl.anchor;
      if (wl.blockRef) metadata.block_ref = wl.blockRef;
      if (wl.embed) metadata.embed = true;

      linkOps.createLink(
        db,
        noteId,
        targetId,
        WIKILINK_REL,
        Object.keys(metadata).length > 0 ? metadata : undefined,
      );
      added++;
    }
  }

  // Remove stale links (wikilinks that were removed from content)
  let removed = 0;
  for (const link of existing) {
    if (!desiredTargets.has(link.targetId)) {
      linkOps.deleteLink(db, noteId, link.targetId, WIKILINK_REL);
      removed++;
    }
  }

  // Store unresolved wikilinks for later resolution
  syncUnresolvedWikilinks(db, noteId, unresolved);

  return { added, removed, unresolved };
}

// ---------------------------------------------------------------------------
// Unresolved wikilinks — pending resolution when target notes are created
// ---------------------------------------------------------------------------

/**
 * Ensure the unresolved_wikilinks table exists.
 * Called lazily — only when we actually have unresolved links.
 */
export function ensureUnresolvedTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unresolved_wikilinks (
      source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      target_path TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (source_id, target_path)
    )
  `);
}

/**
 * Update unresolved wikilinks for a note.
 */
function syncUnresolvedWikilinks(
  db: Database,
  noteId: string,
  unresolvedPaths: string[],
): void {
  if (unresolvedPaths.length === 0) {
    // Clean up any old unresolved entries for this note
    try {
      db.prepare("DELETE FROM unresolved_wikilinks WHERE source_id = ?").run(noteId);
    } catch {
      // Table may not exist yet — that's fine
    }
    return;
  }

  ensureUnresolvedTable(db);

  // Replace all unresolved entries for this note
  db.prepare("DELETE FROM unresolved_wikilinks WHERE source_id = ?").run(noteId);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO unresolved_wikilinks (source_id, target_path) VALUES (?, ?)",
  );
  for (const path of unresolvedPaths) {
    insert.run(noteId, path);
  }
}

/**
 * Try to resolve pending wikilinks that point to a given path.
 * Called when a note is created or its path changes.
 *
 * Returns the number of links resolved.
 */
export function resolveUnresolvedWikilinks(
  db: Database,
  notePath: string,
  noteId: string,
): number {
  let rows: { source_id: string }[];
  try {
    rows = db.prepare(`
      SELECT source_id FROM unresolved_wikilinks
      WHERE target_path = ? COLLATE NOCASE
         OR ? LIKE '%/' || target_path
    `).all(notePath, notePath) as { source_id: string }[];
  } catch {
    return 0; // Table doesn't exist
  }

  if (rows.length === 0) return 0;

  let resolved = 0;
  for (const row of rows) {
    if (row.source_id === noteId) continue; // Skip self-links

    // Create the wikilink
    linkOps.createLink(db, row.source_id, noteId, WIKILINK_REL);
    resolved++;

    // Remove the unresolved entry
    db.prepare(
      "DELETE FROM unresolved_wikilinks WHERE source_id = ? AND (target_path = ? COLLATE NOCASE OR ? LIKE '%/' || target_path)",
    ).run(row.source_id, notePath, notePath);
  }

  return resolved;
}
