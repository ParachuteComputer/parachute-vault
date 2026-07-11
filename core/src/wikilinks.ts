import { Database } from "bun:sqlite";
import type { Note } from "./types.js";
import * as linkOps from "./links.js";
import { getNote, findNotesByTitle, extractH1Title } from "./notes.js";
import { chunkForInClause } from "./sql-in.js";
import { transaction } from "./txn.js";
import type { QueryWarning } from "./query-warnings.js";

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
 * 4. **Title fallback** (additive) — only tried when #2/#3 found NO
 *    candidates at all (a clean miss, not an ambiguous one). Matches the
 *    note whose H1 title (first `# ` line in its content, see
 *    {@link findNotesByTitle}) equals the target, case-insensitively.
 *    Resolves only when EXACTLY one note has that title; 2+ matches is
 *    ambiguous and stays unresolved rather than guessing. Rescues links
 *    into a note whose displayed title differs from its path/basename —
 *    the top source of silently-broken wikilinks.
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
  if (basename.length > 1) return null; // ambiguous basename — don't fall through to title

  // 4. Title fallback — only reached on a clean miss (0 basename
  // candidates). See the doc comment above for the ambiguity policy.
  const byTitle = findNotesByTitle(db, target);
  if (byTitle.length === 1) return byTitle[0]!.id;

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

  // 4. Title fallback — only reached on a clean basename miss (0
  // candidates), mirroring resolveWikilink.
  const byTitle = findNotesByTitle(db, target);
  if (byTitle.length === 1) {
    const match = byTitle[0]!;
    return { resolved: true, note_id: match.id, path: match.path ?? undefined, candidates: [] };
  }
  if (byTitle.length > 1) {
    return {
      resolved: false,
      ambiguous: true,
      candidates: byTitle.map((r) => ({ note_id: r.id, path: r.path ?? "" })),
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

/** One note's dangling outbound link, as surfaced on a note read (vault#555). */
export interface BrokenLink {
  target: string;
  relationship: string;
}

/**
 * Batch-fetch each note's pending `unresolved_wikilinks` rows — the
 * `include_broken_links` surfacing on `query-notes` / `GET /notes`. ONE
 * query for the whole page (mirrors `getLinksHydratedForNotes`'s batching),
 * not one per note. Returns a map with an entry (possibly `[]`) for every
 * requested id whenever the table exists; when the table has never been
 * created (no note in this vault has ever had a broken link) every id maps
 * to `[]` without a query attempt.
 */
export function getUnresolvedLinksForNotes(db: Database, noteIds: string[]): Map<string, BrokenLink[]> {
  const result = new Map<string, BrokenLink[]>(noteIds.map((id) => [id, []]));
  if (noteIds.length === 0) return result;

  const rows: { source_id: string; target_path: string; relationship: string }[] = [];
  try {
    ensureRelationshipColumn(db);
    for (const chunk of chunkForInClause(noteIds)) {
      const placeholders = chunk.map(() => "?").join(", ");
      rows.push(...db.prepare(
        `SELECT source_id, target_path, relationship FROM unresolved_wikilinks WHERE source_id IN (${placeholders})`,
      ).all(...chunk) as typeof rows);
    }
  } catch {
    // Table doesn't exist — every id already maps to [] above.
    return result;
  }

  for (const row of rows) {
    result.get(row.source_id)?.push({ target: row.target_path, relationship: row.relationship || WIKILINK_REL });
  }
  return result;
}

/** Single-note convenience wrapper around {@link getUnresolvedLinksForNotes}. */
export function getUnresolvedLinksForNote(db: Database, noteId: string): BrokenLink[] {
  return getUnresolvedLinksForNotes(db, [noteId]).get(noteId) ?? [];
}

// ---------------------------------------------------------------------------
// Sync — maintain wikilink-based links for a note
// ---------------------------------------------------------------------------

const WIKILINK_REL = "wikilink";

/**
 * Deduplicate parsed wikilinks by target (case-insensitively) — the same
 * target mentioned multiple times in a note's content resolves to ONE
 * link/warning, not one per mention. Shared by {@link syncWikilinks} (which
 * mutates links/the pending-resolution table) and
 * {@link getContentWikilinkWarnings} (which only reads) so the two can't
 * drift on which targets they consider.
 */
function dedupeWikilinkTargets(parsed: ParsedWikilink[]): Map<string, ParsedWikilink> {
  const targetMap = new Map<string, ParsedWikilink>();
  for (const wl of parsed) {
    const key = wl.target.toLowerCase();
    if (!targetMap.has(key)) {
      targetMap.set(key, wl);
    }
  }
  return targetMap;
}

/** One target's ambiguity — surfaced target string + how many notes it matched. */
export interface AmbiguousWikilinkTarget {
  target: string;
  count: number;
}

/**
 * Sync wikilink-based links for a note.
 * Parses content for [[wikilinks]], resolves targets, creates/removes links.
 *
 * Returns counts of changes made. `unresolved` is content wikilinks whose
 * target matched NO note (queued into `unresolved_wikilinks` for lazy
 * backfill — see {@link resolveUnresolvedWikilinks}). `ambiguous` (vault#570)
 * is content wikilinks whose target matched ≥2 notes — these are NEITHER
 * linked NOR queued: a future note being created can't retroactively
 * resolve an ambiguity between two notes that ALREADY exist, and queuing it
 * would risk the pending-resolution sweep later linking to an arbitrary
 * THIRD same-named note rather than reporting the collision. The caller
 * (MCP `create-note`/`update-note`, REST `POST`/`PATCH /notes`) surfaces
 * `ambiguous` as an `ambiguous_link` warning naming the target + match
 * count, distinct from `unresolved`'s `unresolved_link`.
 */
export function syncWikilinks(
  db: Database,
  noteId: string,
  content: string,
): { added: number; removed: number; unresolved: string[]; ambiguous: AmbiguousWikilinkTarget[] } {
  const targetMap = dedupeWikilinkTargets(parseWikilinks(content));

  // Resolve each unique target
  const resolvedLinks = new Map<string, { targetId: string; wl: ParsedWikilink }>();
  const unresolved: string[] = [];
  const ambiguous: AmbiguousWikilinkTarget[] = [];

  for (const [key, wl] of targetMap) {
    const detail = resolveWikilinkDetailed(db, wl.target);
    if (detail.resolved) {
      // Don't create self-links — silently skipped, same as before.
      if (detail.note_id !== noteId) {
        resolvedLinks.set(detail.note_id!, { targetId: detail.note_id!, wl });
      }
    } else if (detail.ambiguous) {
      ambiguous.push({ target: wl.target, count: detail.candidates.length });
    } else {
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

  // Store unresolved wikilinks for later resolution. Ambiguous targets are
  // deliberately NOT queued here — see the doc comment above.
  syncUnresolvedWikilinks(db, noteId, unresolved);

  return { added, removed, unresolved, ambiguous };
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

  // The rebuild is a 4-statement DDL sequence (RENAME → CREATE → INSERT…
  // SELECT → DROP) that MUST be atomic (wire + generalist review, vault#555
  // — same class as W7's migrateToV25 must-fix). A crash between RENAME and
  // CREATE would leave NO `unresolved_wikilinks` table at all (breaking every
  // subsequent wikilink/structured-link write); a crash between CREATE and
  // INSERT would strand every pending forward-ref row in the orphaned
  // `_pre_v555` table permanently — silent data loss — because the guard
  // above (`relationship` column present) flips true the moment CREATE
  // commits, so a retry would skip the backfill.
  const migrate = (): void => {
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
  };

  // Nesting guard: this heal runs from `ensureUnresolvedTable` /
  // `resolveUnresolvedWikilinks`, which are themselves reached from
  // `store.createNote`/`updateNote` — and a BATCH create/update wraps those
  // in `transactionAsync` (an already-open transaction). The txn seam is
  // single-level by design (see core/src/txn.ts — a nested `BEGIN IMMEDIATE`
  // throws "cannot start a transaction within a transaction"), so when a
  // transaction is already active the DDL is ALREADY covered by that
  // transaction's atomicity and we run it directly; only when idle do we open
  // our own. `db.inTransaction` is bun:sqlite's active-transaction flag; a
  // backend that doesn't expose it (a DO-SQLite Store) reads `undefined`
  // (falsy) and takes the `transaction()` path — which for that backend
  // delegates to its native `transactionSync`. (Immaterial in practice: a
  // fresh DO deployment is created with the v555 schema directly, so this
  // legacy heal never fires there.)
  if (db.inTransaction) {
    migrate();
  } else {
    transaction(db, migrate);
  }
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
 * (vault#555) that point to a given note. Called when a note is created or
 * its path changes. Each pending row materializes with ITS OWN relationship
 * (a structured link queued via {@link queueUnresolvedLink} backfills with
 * the caller's original relationship, not "wikilink").
 *
 * Deferred resolution now covers all four legs of
 * {@link resolveWikilinkDetailed}: exact path, basename, H1 title, and the
 * explicit `path.ext` form. (Caveat: the candidate pre-filter below matches the
 * title/ext legs via SQL `COLLATE NOCASE`, which case-folds ASCII only — a
 * non-ASCII title differing from the target only in letter case is missed at
 * the candidate stage and re-heals on the source's next save instead. Rare;
 * tracked as a follow-up.) Before this, the sweep matched a pending row to
 * the new note by PATH TEXT ONLY (`target_path = path OR path LIKE
 * '%/'||target_path`) — so a `[[John Doe]]` that resolved at write time via
 * the H1-title fallback (its note's displayed title differs from its path,
 * e.g. `people/jdoe`), or a `[[Foo.csv]]` that resolved via the extension
 * leg, silently never re-healed on a delete→recreate (the exact LB6 gap) and
 * more broadly never backfilled when the target note was created AFTER the
 * referencing note. Each candidate pending row is now VERIFIED through
 * `resolveWikilinkDetailed` against the current DB — a row is healed only
 * when its target string actually resolves to THIS note. An AMBIGUOUS target
 * (≥2 notes now share the path/title) resolves to neither and stays queued,
 * identical to write-time's "don't guess" contract — this also closes the
 * pre-existing asymmetry where the path-only sweep would link an ambiguous
 * `[[Foo]]` to whichever colliding note happened to be created.
 *
 * Returns the number of links resolved.
 */
export function resolveUnresolvedWikilinks(
  db: Database,
  notePath: string,
  noteId: string,
): number {
  ensureRelationshipColumn(db);

  // The newly-created / newly-repathed note supplies the two resolution keys
  // the pending row's `target_path` (a bare path/basename string) can't carry
  // on its own: the note's H1 title (title-fallback leg) and its extension
  // (explicit `path.ext` leg). `getNote` is one indexed PK lookup; the title
  // is parsed from content in JS (no separate query).
  const note = getNote(db, noteId);
  const h1Title = note?.content ? extractH1Title(note.content) : null;
  const pathDotExt = note?.extension ? `${notePath}.${note.extension}` : null;

  let rows: { source_id: string; target_path: string; relationship: string }[];
  try {
    // Candidate pre-filter: every pending row whose `target_path` COULD
    // resolve to this note under any resolveWikilinkDetailed leg — exact
    // path, basename (target is the last path segment), H1 title, or the
    // `path.ext` form. A `null` bind (no H1 heading / no extension) makes its
    // clause never match (`target_path = NULL` is NULL, i.e. falsy in SQL).
    // The verify step below is what enforces correctness; this clause only
    // BOUNDS how many rows reach the (title-fallback-scanning) resolver.
    rows = db.prepare(`
      SELECT source_id, target_path, relationship FROM unresolved_wikilinks
      WHERE target_path = ? COLLATE NOCASE
         OR ? LIKE '%/' || target_path
         OR target_path = ? COLLATE NOCASE
         OR target_path = ? COLLATE NOCASE
    `).all(notePath, notePath, h1Title, pathDotExt) as typeof rows;
  } catch {
    return 0; // Table doesn't exist
  }

  if (rows.length === 0) return 0;

  let resolved = 0;
  for (const row of rows) {
    if (row.source_id === noteId) continue; // Skip self-links

    // Verify against the SAME resolver write-time uses, so deferred
    // resolution can't diverge from it: heal a pending row ONLY when its
    // target string actually resolves to THIS note now. A miss or an
    // ambiguous result leaves the row queued (surfaced as a visible broken
    // link, and re-tried on the next matching note create).
    const detail = resolveWikilinkDetailed(db, row.target_path);
    if (!detail.resolved || detail.note_id !== noteId) continue;

    const relationship = row.relationship || WIKILINK_REL;
    linkOps.createLink(db, row.source_id, noteId, relationship);
    resolved++;

    // Remove exactly this pending row — a source may have BOTH a wikilink and
    // a structured-link forward-ref pending against the same target_path
    // (distinct relationships), so scope the delete to all three PK columns.
    db.prepare(
      "DELETE FROM unresolved_wikilinks WHERE source_id = ? AND target_path = ? AND relationship = ?",
    ).run(row.source_id, row.target_path, relationship);
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
 * tool docs; wikilinks never carry a raw ID), then the SAME path/basename/
 * title resolution `[[wikilinks]]` use ({@link resolveWikilink}: explicit
 * extension, exact path, basename, then H1-title fallback on a clean miss).
 */
export function resolveLinkTarget(db: Database, idOrPath: string): string | null {
  const detail = resolveLinkTargetDetailed(db, idOrPath);
  return detail.resolved ? detail.note_id! : null;
}

/**
 * Detailed counterpart to {@link resolveLinkTarget} — same ID-then-path/
 * basename resolution order, but surfaces AMBIGUOUS (≥2 path/basename
 * matches, vault#570) as a distinct outcome instead of collapsing it into
 * the same `null` a genuine miss returns. An ID lookup is never ambiguous
 * (the `id` column is the primary key), so ambiguity can only arise from
 * the path/basename fallback — {@link resolveWikilinkDetailed}.
 */
export function resolveLinkTargetDetailed(db: Database, idOrPath: string): WikilinkResolution {
  const byId = db.prepare("SELECT id, path FROM notes WHERE id = ?").get(idOrPath) as { id: string; path: string | null } | null;
  if (byId) {
    return { resolved: true, note_id: byId.id, path: byId.path ?? undefined, candidates: [] };
  }
  return resolveWikilinkDetailed(db, idOrPath);
}

/**
 * Resolve a structured-link `target` (create-note/update-note `links`) to
 * its full {@link Note} — same ID-or-path/title semantics as `[[wikilinks]]`
 * via {@link resolveLinkTarget}. Used for `links.remove`, where the
 * bracket-cleanup step needs the target's `path`, not just its ID.
 * `links.add` resolution goes through {@link resolveOrQueueLink} instead
 * (it also queues a forward-ref on a miss). Single home for both the MCP
 * tool layer (core/src/mcp.ts) and the REST handler layer (src/routes.ts) —
 * vault#555 generalist review, was duplicated verbatim in both.
 */
export function resolveStructuredLinkNote(db: Database, target: string): Note | null {
  const id = resolveLinkTarget(db, target);
  return id ? getNote(db, id) : null;
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

/** Outcome of {@link resolveOrQueueLink} — a discriminated union so callers can't confuse "queued" with "ambiguous" (vault#570; both used to collapse to the same `null`). */
export type ResolveOrQueueOutcome =
  | { status: "resolved"; note_id: string }
  | { status: "ambiguous"; candidates: { note_id: string; path: string }[] }
  | { status: "queued" };

/**
 * Drop any pending forward-ref queued for `sourceId` under `relationship`,
 * regardless of the (stale) `target_path` it names. Used by the
 * `reference`-field auto-link sync (core/src/store.ts's
 * `syncReferenceFieldLinks`, vault#typed-reference-field) before re-resolving
 * a changed field value — without this, a field that used to point at an
 * unresolved target and is then changed to a different (or removed) value
 * would leave the OLD forward-ref queued forever, since
 * {@link queueUnresolvedLink}'s primary key includes `target_path` and a
 * changed value queues under a NEW key rather than replacing the old row.
 * Safe no-op when the table doesn't exist yet.
 */
export function clearQueuedLink(db: Database, sourceId: string, relationship: string): void {
  try {
    db.prepare(
      "DELETE FROM unresolved_wikilinks WHERE source_id = ? AND relationship = ?",
    ).run(sourceId, relationship);
  } catch {
    // Table may not exist yet — nothing to clear.
  }
}

/**
 * Resolve a structured link NOW, or queue it for lazy resolution when the
 * target doesn't exist yet — mirroring the wikilink forward-ref contract
 * (a target created later, in this same batch or a future call, backfills
 * the edge automatically via {@link resolveUnresolvedWikilinks}).
 *
 * Returns a {@link ResolveOrQueueOutcome}:
 *   - `"resolved"` — the edge should be created against `note_id` now.
 *   - `"ambiguous"` (vault#570) — the target matched ≥2 notes (e.g. two
 *     notes sharing an H1 title). NEITHER linked nor queued — see
 *     {@link syncWikilinks}'s doc comment for why queuing an ambiguous
 *     target would be wrong. Callers MUST surface a distinct
 *     `ambiguous_link` warning naming the target + `candidates.length`.
 *   - `"queued"` — the target matched NO note; queued for lazy backfill.
 *     Callers MUST surface an `unresolved_link` warning naming the target.
 *
 * The write itself never fails on either non-`"resolved"` outcome — silence
 * is never the fallback (vault#555 — "the API should never silently do the
 * wrong thing").
 */
export function resolveOrQueueLink(
  db: Database,
  sourceId: string,
  target: string,
  relationship: string,
): ResolveOrQueueOutcome {
  const detail = resolveLinkTargetDetailed(db, target);
  if (detail.resolved) return { status: "resolved", note_id: detail.note_id! };
  if (detail.ambiguous) return { status: "ambiguous", candidates: detail.candidates };
  queueUnresolvedLink(db, sourceId, target, relationship);
  return { status: "queued" };
}

/**
 * Content-wikilink counterpart of the `unresolved_link`/`ambiguous_link`
 * warnings structured `links` already produce via {@link resolveOrQueueLink}
 * (vault#570 — content-parsed `[[wikilinks]]` to a missing target used to
 * fire NO write-time warning at all, even though the equivalent structured
 * `links` entry did). READ-ONLY: does not mutate `unresolved_wikilinks` or
 * create/remove any link — that mutation already happened inside
 * {@link syncWikilinks} (called from `Store.createNote`/`updateNote`).
 * Callers invoke this AFTER the note's content is committed, passing the
 * SAME `noteId`/`content` pair, to recompute the identical per-target
 * classification for the response's `warnings` array — single source of
 * truth is {@link resolveWikilinkDetailed}, so this can't drift from what
 * `syncWikilinks` actually did. Mirrors `syncWikilinks`'s target selection
 * exactly: same lowercase-target dedupe key (via
 * {@link dedupeWikilinkTargets}), same self-link skip (a wikilink resolving
 * to the note's own id is neither linked nor warned about).
 */
export function getContentWikilinkWarnings(
  db: Database,
  noteId: string,
  content: string,
): QueryWarning[] {
  const targetMap = dedupeWikilinkTargets(parseWikilinks(content));
  const warnings: QueryWarning[] = [];

  for (const [, wl] of targetMap) {
    const detail = resolveWikilinkDetailed(db, wl.target);
    if (detail.resolved) continue; // resolved (incl. self-link) — nothing to warn about
    if (detail.ambiguous) {
      warnings.push({
        code: "ambiguous_link",
        message: `wikilink target "${wl.target}" matched ${detail.candidates.length} notes — ambiguous, no link created. Use a more specific path, [[Target.ext]], or the note's ID to disambiguate.`,
        target: wl.target,
        relationship: WIKILINK_REL,
        candidate_count: detail.candidates.length,
      });
    } else {
      warnings.push({
        code: "unresolved_link",
        message: `wikilink target "${wl.target}" did not resolve to any note — queued and will backfill automatically if a matching note is created later.`,
        target: wl.target,
        relationship: WIKILINK_REL,
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Delete-time re-queue (LB6) — a deleted note's INBOUND wikilink edges must
// come back to life if a note is later recreated at the same path/title.
// ---------------------------------------------------------------------------

/**
 * Before a note is deleted, re-queue every INBOUND `wikilink`-relationship
 * edge pointing at it into `unresolved_wikilinks`, so that recreating a note
 * matching the original `[[target]]` text (same path, basename, H1 title, or
 * `path.ext` form — anything {@link resolveWikilinkDetailed} would have
 * matched) auto-heals the edge via {@link resolveUnresolvedWikilinks} — which
 * now verifies each pending row through that same resolver — exactly as if
 * the link had never resolved in the first place.
 *
 * Without this, `deleteNote`'s `DELETE FROM notes` cascades the `links` row
 * away (FK `ON DELETE CASCADE`) but leaves `unresolved_wikilinks` untouched —
 * a note recreated at the deleted note's path never gets linked back to,
 * because nothing is pending resolution for it. Only a re-save of the
 * SOURCE note (which reparses its own content from scratch) would recover
 * it; a fresh `[[Foo]]` reference elsewhere would work, but the ORIGINAL
 * source note's edge stayed dead despite its unchanged `[[Foo]]` text.
 *
 * MUST be called BEFORE the note row is deleted — it needs both the `links`
 * row (about to cascade away) and, per source, the CURRENT content (to
 * recover the raw `[[target]]` text the resolver actually matched on: a
 * resolved link's row retains the target NOTE id, not the original bracket
 * text, and title-fallback / basename resolution mean that text can differ
 * from the deleted note's own path).
 *
 * Scope: only `relationship = "wikilink"` inbound edges are re-queued.
 * Explicit typed `links` (structured `links: [{target, relationship}]`
 * entries, vault#555) are left alone — those are hand-authored associations
 * the caller owns, not content-derived, so silently resurrecting them as a
 * forward-ref on an unrelated future note would be surprising. A source
 * that links to itself is never queued (wikilinks never create self-links,
 * so no such inbound row can exist) and is skipped defensively anyway.
 */
export function requeueInboundWikilinksForDelete(db: Database, noteId: string): void {
  let inbound: { source_id: string }[];
  try {
    inbound = db.prepare(
      "SELECT DISTINCT source_id FROM links WHERE target_id = ? AND relationship = ?",
    ).all(noteId, WIKILINK_REL) as { source_id: string }[];
  } catch {
    return; // links table missing (shouldn't happen post-schema-init, but never block a delete on this)
  }
  if (inbound.length === 0) return;

  // Cheap string pre-filter (perf): a wikilink can only have resolved to the
  // note being deleted if its raw target text equals one of THIS note's own
  // resolution keys — its path, basename, H1 title, or `path.ext` form (the
  // four legs {@link resolveWikilinkDetailed} matches on; every leg produces a
  // target string equal to one of these, so the key set is a complete
  // necessary-condition superset). Computed ONCE, then each source wikilink's
  // target is gated on set membership BEFORE the expensive resolver call
  // (whose title-fallback leg scans every note's content). Without this, a hub
  // note with hundreds of inbound sources would fire hundreds of full-vault
  // scans in one delete. The resolver still CONFIRMS each survivor — the
  // pre-filter narrows, it doesn't decide.
  const deleted = getNote(db, noteId);
  const keys = new Set<string>();
  const addKey = (s: string | null | undefined): void => {
    const k = s?.trim().toLowerCase();
    if (k) keys.add(k);
  };
  if (deleted?.path) {
    addKey(deleted.path);
    const slash = deleted.path.lastIndexOf("/");
    addKey(slash >= 0 ? deleted.path.slice(slash + 1) : deleted.path); // basename
    if (deleted.extension) addKey(`${deleted.path}.${deleted.extension}`);
  }
  if (deleted?.content) addKey(extractH1Title(deleted.content));
  if (keys.size === 0) return; // no key any wikilink could have matched on

  for (const { source_id } of inbound) {
    if (source_id === noteId) continue; // defensive — wikilinks never self-link

    const source = getNote(db, source_id);
    if (!source || !source.content) continue;

    const targetMap = dedupeWikilinkTargets(parseWikilinks(source.content));
    for (const [, wl] of targetMap) {
      // Skip the resolver unless this target text could match the deleted
      // note by one of its resolution keys (necessary-condition pre-filter).
      if (!keys.has(wl.target.trim().toLowerCase())) continue;
      const detail = resolveWikilinkDetailed(db, wl.target);
      if (detail.resolved && detail.note_id === noteId) {
        queueUnresolvedLink(db, source_id, wl.target, WIKILINK_REL);
      }
    }
  }
}
