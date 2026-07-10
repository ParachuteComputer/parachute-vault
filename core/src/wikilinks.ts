import { Database } from "bun:sqlite";
import * as linkOps from "./links.js";
import { chunkForInClause } from "./sql-in.js";

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
 * 1. **Explicit-extension target**: `[[Foo.csv]]` matches the note with
 *    `path: "Foo"` AND `extension: "csv"` (vault#328). Lets a reader
 *    disambiguate when multiple notes share a path differing only by
 *    extension. The trailing `.<ext>` must match a known
 *    alphanumeric pattern (1–16 chars) — otherwise the dot is treated
 *    as part of the path string and falls through to the existing
 *    rules.
 * 2. Exact path match (case-insensitive) — multiple matches resolve to
 *    a single note when only ONE extension is in play; if `Foo.md` and
 *    `Foo.csv` both exist, the link refuses to resolve and the caller
 *    sees an unresolved-wikilink entry (vault#328 ambiguity policy).
 * 3. Basename match — target matches the last segment of a path
 *    (e.g., "README" matches "Projects/Parachute/README"). Same
 *    cross-extension ambiguity policy as #2.
 */
export function resolveWikilink(db: Database, target: string): string | null {
  // 1. Explicit extension form: `[[path.ext]]` where `.ext` is a
  // pattern-matching tail (lowercase alphanumeric, 1–16 chars).
  // Mirrors EXTENSION_PATTERN in core/src/notes.ts so the wikilink
  // parser and the API surface share the same notion of "this looks
  // like an extension."
  const extMatch = target.match(/^(.*)\.([a-z0-9]{1,16})$/i);
  if (extMatch) {
    const pathPart = extMatch[1]!;
    const extPart = extMatch[2]!.toLowerCase();
    const explicit = db.prepare(
      "SELECT id FROM notes WHERE path = ? COLLATE NOCASE AND LOWER(extension) = ?",
    ).get(pathPart, extPart) as { id: string } | null;
    if (explicit) return explicit.id;
    // No match for explicit (path, ext) — fall through to the looser
    // rules so a literal note named `Recipe.v2` (where `v2` isn't an
    // extension on a real note) can still resolve under exact-path
    // match.
  }

  // 2. Exact match (case-insensitive). When multiple notes share a path
  // (post-vault#328 this happens when `Foo.md` and `Foo.csv` both
  // exist, since path is stored extension-less), refuse to resolve.
  const exact = db.prepare(
    "SELECT id FROM notes WHERE path = ? COLLATE NOCASE",
  ).all(target) as { id: string }[];
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) {
    // Ambiguous — refuse-and-require-explicit-extension policy
    // (vault#328). Returning null routes through the existing
    // unresolved-wikilinks workflow, so the reader (or the indexer)
    // sees the conflict.
    return null;
  }

  // 3. Basename match — last path segment equals target.
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
 * Mirrors `resolveWikilink`'s resolution order, including the explicit-
 * extension form `[[Foo.csv]]` introduced by vault#328.
 */
export function resolveWikilinkDetailed(db: Database, target: string): WikilinkResolution {
  // 1. Explicit-extension form: `[[path.ext]]`.
  const extMatch = target.match(/^(.*)\.([a-z0-9]{1,16})$/i);
  if (extMatch) {
    const pathPart = extMatch[1]!;
    const extPart = extMatch[2]!.toLowerCase();
    const explicit = db.prepare(
      "SELECT id, path FROM notes WHERE path = ? COLLATE NOCASE AND LOWER(extension) = ?",
    ).get(pathPart, extPart) as { id: string; path: string } | null;
    if (explicit) {
      return { resolved: true, note_id: explicit.id, path: explicit.path, candidates: [] };
    }
  }

  // 2. Exact path match (case-insensitive). Multiple matches → ambiguous.
  const exact = db.prepare(
    "SELECT id, path, extension FROM notes WHERE path = ? COLLATE NOCASE",
  ).all(target) as { id: string; path: string; extension: string }[];
  if (exact.length === 1) {
    return { resolved: true, note_id: exact[0]!.id, path: exact[0]!.path, candidates: [] };
  }
  if (exact.length > 1) {
    return {
      resolved: false,
      ambiguous: true,
      candidates: exact.map((r) => ({ note_id: r.id, path: r.path })),
    };
  }

  // 3. Basename match
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
  /**
   * Link relationship this pending entry will materialize as once
   * resolved. `"wikilink"` for content-parsed `[[targets]]`; the
   * caller's own relationship string for structured `links` forward-refs
   * (vault#555). Always present post-migration; defaults to `"wikilink"`
   * for rows written before the column existed.
   */
  relationship: string;
}

/**
 * List unresolved wikilinks across the vault.
 */
export function listUnresolvedWikilinks(db: Database, limit = 50): { unresolved: UnresolvedWikilink[]; count: number } {
  ensureRelationshipColumn(db);
  let total: number;
  let rows: { source_id: string; target_path: string; relationship: string }[];
  try {
    total = (db.prepare("SELECT COUNT(*) as c FROM unresolved_wikilinks").get() as { c: number }).c;
    rows = db.prepare(
      "SELECT source_id, target_path, relationship FROM unresolved_wikilinks ORDER BY source_id LIMIT ?",
    ).all(limit) as { source_id: string; target_path: string; relationship: string }[];
  } catch {
    // Table doesn't exist yet
    return { unresolved: [], count: 0 };
  }

  // Hydrate source paths
  if (rows.length === 0) return { unresolved: [], count: total };

  const sourceIds = [...new Set(rows.map((r) => r.source_id))];
  // Chunk under the DO 100-bound-param cap (see sql-in.ts) — with a large
  // `limit` this hydrates >100 source ids in one IN-list otherwise.
  const pathRows: { id: string; path: string | null }[] = [];
  for (const chunk of chunkForInClause(sourceIds)) {
    const placeholders = chunk.map(() => "?").join(", ");
    pathRows.push(...db.prepare(
      `SELECT id, path FROM notes WHERE id IN (${placeholders})`,
    ).all(...chunk) as { id: string; path: string | null }[]);
  }
  const pathMap = new Map(pathRows.map((r) => [r.id, r.path]));

  const unresolved: UnresolvedWikilink[] = rows.map((r) => ({
    source_id: r.source_id,
    source_path: pathMap.get(r.source_id) ?? undefined,
    target_path: r.target_path,
    relationship: r.relationship || WIKILINK_REL,
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
 * Self-heal the `relationship` column onto a pre-vault#555
 * `unresolved_wikilinks` table. An `ALTER TABLE ADD COLUMN` alone can't
 * widen the PRIMARY KEY, which would let a structured link (non-"wikilink"
 * relationship) queued against the same (source, target_path) as an
 * existing pending wikilink silently collide and get dropped by `INSERT OR
 * IGNORE`. So on a table that predates the column, this rebuilds it with
 * the 3-column PK (source_id, target_path, relationship) and backfills
 * every existing row as `relationship = 'wikilink'` (the only kind that
 * could have been queued before this fix). No-op on a fresh table (created
 * directly with the new schema by {@link ensureUnresolvedTable}) or one
 * already migrated. `PRAGMA table_info` on a nonexistent table returns zero
 * rows rather than throwing, so this is safe to call unconditionally,
 * including from read paths that don't want to create the table lazily.
 */
function ensureRelationshipColumn(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(unresolved_wikilinks)").all() as { name: string }[];
  if (cols.length === 0) return; // table doesn't exist — nothing to heal
  if (cols.some((c) => c.name === "relationship")) return; // already migrated

  db.exec("ALTER TABLE unresolved_wikilinks RENAME TO unresolved_wikilinks_pre_v555");
  db.exec(`
    CREATE TABLE unresolved_wikilinks (
      source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      target_path TEXT NOT NULL COLLATE NOCASE,
      relationship TEXT NOT NULL DEFAULT '${WIKILINK_REL}',
      PRIMARY KEY (source_id, target_path, relationship)
    )
  `);
  db.exec(`
    INSERT INTO unresolved_wikilinks (source_id, target_path, relationship)
    SELECT source_id, target_path, '${WIKILINK_REL}' FROM unresolved_wikilinks_pre_v555
  `);
  db.exec("DROP TABLE unresolved_wikilinks_pre_v555");
}

/**
 * Ensure the unresolved_wikilinks table exists.
 * Called lazily — only when we actually have unresolved links.
 */
export function ensureUnresolvedTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unresolved_wikilinks (
      source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      target_path TEXT NOT NULL COLLATE NOCASE,
      relationship TEXT NOT NULL DEFAULT '${WIKILINK_REL}',
      PRIMARY KEY (source_id, target_path, relationship)
    )
  `);
  ensureRelationshipColumn(db);
}

/**
 * Update unresolved wikilinks for a note. Scoped to `relationship =
 * "wikilink"` rows only (vault#555) — a content re-parse must not clobber
 * pending STRUCTURED-link forward-refs queued for this note via
 * {@link queueUnresolvedLink} (a different relationship, same table).
 */
function syncUnresolvedWikilinks(
  db: Database,
  noteId: string,
  unresolvedPaths: string[],
): void {
  if (unresolvedPaths.length === 0) {
    // Clean up any old wikilink-kind unresolved entries for this note
    try {
      db.prepare("DELETE FROM unresolved_wikilinks WHERE source_id = ? AND relationship = ?").run(noteId, WIKILINK_REL);
    } catch {
      // Table may not exist yet — that's fine
    }
    return;
  }

  ensureUnresolvedTable(db);

  // Replace wikilink-kind unresolved entries for this note only
  db.prepare("DELETE FROM unresolved_wikilinks WHERE source_id = ? AND relationship = ?").run(noteId, WIKILINK_REL);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO unresolved_wikilinks (source_id, target_path, relationship) VALUES (?, ?, ?)",
  );
  for (const path of unresolvedPaths) {
    insert.run(noteId, path, WIKILINK_REL);
  }
}

/**
 * Try to resolve pending wikilinks AND pending structured-link forward-refs
 * (vault#555) that point to a given path. Called when a note is created or
 * its path changes. Each pending row materializes with ITS OWN relationship
 * (a structured link queued via {@link queueUnresolvedLink} backfills with
 * the caller's original relationship, not "wikilink").
 *
 * Returns the number of links resolved.
 */
export function resolveUnresolvedWikilinks(
  db: Database,
  notePath: string,
  noteId: string,
): number {
  ensureRelationshipColumn(db);
  let rows: { source_id: string; relationship: string }[];
  try {
    rows = db.prepare(`
      SELECT source_id, relationship FROM unresolved_wikilinks
      WHERE target_path = ? COLLATE NOCASE
         OR ? LIKE '%/' || target_path
    `).all(notePath, notePath) as { source_id: string; relationship: string }[];
  } catch {
    return 0; // Table doesn't exist
  }

  if (rows.length === 0) return 0;

  let resolved = 0;
  for (const row of rows) {
    if (row.source_id === noteId) continue; // Skip self-links

    const relationship = row.relationship || WIKILINK_REL;
    linkOps.createLink(db, row.source_id, noteId, relationship);
    resolved++;

    // Remove the unresolved entry (this exact relationship only — a
    // source may have BOTH a wikilink and a structured-link forward-ref
    // pending against the same target_path).
    db.prepare(
      "DELETE FROM unresolved_wikilinks WHERE source_id = ? AND relationship = ? AND (target_path = ? COLLATE NOCASE OR ? LIKE '%/' || target_path)",
    ).run(row.source_id, relationship, notePath, notePath);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Structured links — same resolution + lazy forward-ref semantics as
// [[wikilinks]] (vault#555). A structured `links: [{target, relationship}]`
// entry (create-note/update-note) used to resolve by exact path only, with
// no basename fallback and no forward-ref queueing — silently dropping the
// edge whenever the equivalent `[[wikilink]]` would have resolved. These
// helpers give both the MCP tool layer (core/src/mcp.ts) and the REST
// handler layer (src/routes.ts) one shared implementation so they can't
// drift.
// ---------------------------------------------------------------------------

/**
 * Resolve a structured-link `target` — an ID or a path/title — to a note
 * ID. ID lookup first (structured links accept "note ID or path" per the
 * tool docs; wikilinks never carry a raw ID), then the SAME path/basename
 * resolution `[[wikilinks]]` use ({@link resolveWikilink}: explicit
 * extension, exact path, basename).
 */
export function resolveLinkTarget(db: Database, idOrPath: string): string | null {
  const byId = db.prepare("SELECT id FROM notes WHERE id = ?").get(idOrPath) as { id: string } | null;
  if (byId) return byId.id;
  return resolveWikilink(db, idOrPath);
}

/** Queue a structured-link forward-ref for lazy resolution. */
export function queueUnresolvedLink(
  db: Database,
  sourceId: string,
  targetPath: string,
  relationship: string,
): void {
  ensureUnresolvedTable(db);
  db.prepare(
    "INSERT OR IGNORE INTO unresolved_wikilinks (source_id, target_path, relationship) VALUES (?, ?, ?)",
  ).run(sourceId, targetPath, relationship);
}

/**
 * Resolve a structured link NOW, or queue it for lazy resolution when the
 * target doesn't exist yet — mirroring the wikilink forward-ref contract
 * (a target created later, in this same batch or a future call, backfills
 * the edge automatically via {@link resolveUnresolvedWikilinks}). Returns
 * the resolved note ID, or `null` when queued. Callers MUST surface an
 * `unresolved_link` warning naming the target when this returns `null` —
 * the write itself never fails, but silence is never the fallback
 * (vault#555 — "the API should never silently do the wrong thing").
 */
export function resolveOrQueueLink(
  db: Database,
  sourceId: string,
  target: string,
  relationship: string,
): string | null {
  const resolvedId = resolveLinkTarget(db, target);
  if (resolvedId) return resolvedId;
  queueUnresolvedLink(db, sourceId, target, relationship);
  return null;
}
