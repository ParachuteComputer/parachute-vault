import { Database } from "bun:sqlite";
import type { Note } from "./types.js";
import * as linkOps from "./links.js";
import { getNote, findNotesByTitle, extractH1Title } from "./notes.js";
import { chunkForInClause } from "./sql-in.js";
import { pathTitle } from "./paths.js";
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

/**
 * Rewrite the TARGET portion of `[[wikilinks]]` in `content`, in place.
 *
 * `rename` is called with each bracket's parsed target (trimmed, exactly as
 * {@link parseWikilinks} would report it) and returns the replacement target
 * string, or `null`/`undefined` to leave that bracket alone. Everything else
 * about the bracket survives verbatim — the `!` embed marker, a `|display`
 * alias, a `#Heading` anchor, a `#^block-ref`, and any surrounding text.
 *
 * Brackets inside fenced/inline code are skipped, because {@link stripCode}
 * is applied before matching — same as the parser. That is deliberate: a
 * `[[link]]` in a code fence is not a link (it is never parsed, never
 * resolved, never given a `links` row), so a rename must not silently edit
 * someone's sample text. The pre-vault#708 cascade rewrote those too, via a
 * blind content-wide regex.
 */
export function rewriteWikilinkTargets(
  content: string,
  rename: (target: string) => string | null | undefined,
): string {
  const stripped = stripCode(content);
  const regex = /(!)?\[\[([^\[\]\n]+?)\]\]/g;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(stripped)) !== null) {
    const inner = match[2]!;
    // Target part = everything before the first `#` (anchor/block-ref) or
    // `|` (display alias), whichever comes first. Matches how
    // `parseWikilinks` splits, for every ordering of the two.
    let boundary = inner.length;
    const hashIdx = inner.indexOf("#");
    const pipeIdx = inner.indexOf("|");
    if (hashIdx !== -1) boundary = Math.min(boundary, hashIdx);
    if (pipeIdx !== -1) boundary = Math.min(boundary, pipeIdx);
    const targetPart = inner.slice(0, boundary);
    const target = targetPart.trim();
    if (!target) continue;

    const next = rename(target);
    if (!next || next === targetPart) continue;

    // `stripCode` preserves offsets, so the match indices address `content`.
    const start = match.index;
    const end = start + match[0].length;
    const innerStart = start + (match[1] ? 3 : 2);
    out += content.slice(last, innerStart) + next + content.slice(innerStart + boundary, end);
    last = end;
  }

  return last === 0 ? content : out + content.slice(last);
}

/**
 * How a wikilink target names a note PATH — the shapes
 * {@link resolveWikilink} can match a path by, in its resolution order.
 * `null` means the target is not a path-derived name for `path` at all (e.g.
 * it resolved through the H1-title fallback, which a repath doesn't affect).
 *
 * Used by the rename cascade (vault#708) to rewrite a bracket into the SAME
 * shape it already had rather than forcing every reference to a full path.
 */
export type WikilinkPathForm =
  | { form: "path" }
  | { form: "title" }
  | { form: "path-ext"; ext: string };

export function wikilinkPathForm(target: string, path: string): WikilinkPathForm | null {
  const lower = target.toLowerCase();
  const title = pathTitle(path);
  // Order mirrors `resolveWikilink`: a literal path wins over the
  // explicit-extension reading of the same string (`Recipe.v2`).
  if (lower === path.toLowerCase()) return { form: "path" };
  if (lower === title.toLowerCase()) return { form: "title" };
  // Only the FULL-path `.ext` form exists: `resolveWikilink`'s
  // explicit-extension rule matches on `(path, extension)`, so a
  // basename+ext bracket (`[[Data.csv]]` for `move/Data`) never resolved in
  // the first place and is not this cascade's to repair.
  const extMatch = target.match(/^(.*)\.([a-z0-9]{1,16})$/i);
  if (extMatch && extMatch[1]!.toLowerCase() === path.toLowerCase()) {
    return { form: "path-ext", ext: extMatch[2]! };
  }
  return null;
}

/**
 * The candidate replacement texts for a bracket of `form` after the note
 * moved to `newPath`, most-preferred first. The caller picks the first one
 * that resolves back to the renamed note (see `Store.cascadeRename`):
 * a basename bracket stays a basename bracket unless the new basename would
 * now be ambiguous (or collide across extensions), in which case it widens
 * to the full path.
 */
export function wikilinkRenameCandidates(
  form: WikilinkPathForm,
  newPath: string,
  noteExtension: string | null | undefined,
): string[] {
  const newTitle = pathTitle(newPath);
  const ext = noteExtension || "md";
  switch (form.form) {
    case "path":
      return [newPath, `${newPath}.${ext}`];
    case "title":
      return [newTitle, newPath, `${newPath}.${ext}`];
    case "path-ext":
      return [`${newPath}.${form.ext}`];
  }
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

/**
 * The `ambiguous_wikilinks` rows that are BROKEN in a tag-scoped reader's own
 * sub-vault — every candidate invisible to it — shaped as
 * {@link UnresolvedWikilink} so `/unresolved-wikilinks` can report them
 * alongside the genuinely-unresolved ones (vault#239).
 *
 * Without this the admin listing is the third face of the same delete-time
 * oracle `getUnresolvedLinksForNotes` closes on the note surfaces: the row
 * only appears there once the last invisible candidate is deleted and
 * `refreshAmbiguousLinks` demotes it. Callers are expected to apply their own
 * source-note tag-scope filter afterwards, exactly as they do for the base
 * listing. Scanned under the same `limit` slice as
 * {@link listUnresolvedWikilinks}; `[]` when the table has never been created
 * (and never called at all for an unscoped reader, whose answer is the
 * persisted tables as-is).
 */
export function listZeroVisibleAmbiguousAsUnresolved(
  db: Database,
  visible: (noteId: string) => boolean,
  limit = 50,
): UnresolvedWikilink[] {
  let rows: { source_id: string; target_path: string; relationship: string }[];
  try {
    rows = db.prepare(
      "SELECT source_id, target_path, relationship FROM ambiguous_wikilinks ORDER BY source_id LIMIT ?",
    ).all(limit) as typeof rows;
  } catch {
    return []; // Table doesn't exist — nothing has ever been ambiguous here.
  }
  const out: UnresolvedWikilink[] = [];
  for (const r of rows) {
    const relationship = r.relationship || WIKILINK_REL;
    if (visibleResolutionCount(db, r.target_path, relationship, visible) > 0) continue;
    const note = db.prepare("SELECT path FROM notes WHERE id = ?").get(r.source_id) as { path: string | null } | null;
    out.push({
      source_id: r.source_id,
      source_path: note?.path ?? undefined,
      target_path: r.target_path,
      relationship,
    });
  }
  return out;
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
 * requested id.
 *
 * `visible` (vault#239) is an OPTIONAL per-candidate-note predicate, injected
 * by the server layer for a TAG-SCOPED reader — the SAME closure the
 * ambiguity surface uses, because "which of this target's candidates can the
 * reader see" is one question with two answers. Core stays scope-unaware; it
 * only invokes the closure.
 *
 * When it is supplied, the persisted `ambiguous_wikilinks` rows are folded in
 * too, as broken, whenever NONE of their candidates is visible: such a target
 * matches nothing in the reader's sub-vault, which is what "broken" means.
 * Without that, `refreshAmbiguousLinks`' delete-time demotion into
 * `unresolved_wikilinks` is the only thing that ever makes the note broken —
 * so the answer moves when notes the reader cannot see are deleted, which is
 * an oracle for exactly the cross-scope naming collision
 * {@link getAmbiguousLinksForNotes} narrows away.
 *
 * Cost: one extra query plus one re-resolution per ambiguous row, and only
 * for scoped readers — the same profile the ambiguity surface accepts, on a
 * table that is rare by nature. An unscoped reader does no extra work.
 */
export function getUnresolvedLinksForNotes(
  db: Database,
  noteIds: string[],
  visible?: (noteId: string) => boolean,
): Map<string, BrokenLink[]> {
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
    // Table doesn't exist — no note in this vault has ever had a link go
    // unresolved. NOT an early return: a tag-scoped reader can still have
    // broken references whose rows live in `ambiguous_wikilinks` (vault#239),
    // and this is the common case for them — a vault where every collision
    // was ambiguous vault-wide never creates `unresolved_wikilinks` at all.
    rows.length = 0;
  }

  const seen = new Set<string>();
  for (const row of rows) {
    const relationship = row.relationship || WIKILINK_REL;
    seen.add(`${row.source_id}\u0000${relationship}\u0000${row.target_path.toLowerCase()}`);
    result.get(row.source_id)?.push({ target: row.target_path, relationship });
  }

  // vault#239 — a target whose candidates are ALL invisible to this reader
  // is broken in the reader's sub-vault, whichever table its row happens to
  // live in right now. Without this the note only becomes "broken" once the
  // last invisible candidate is DELETED and `refreshAmbiguousLinks` demotes
  // the row into `unresolved_wikilinks` — a timing oracle for exactly the
  // cross-scope naming collision `getAmbiguousLinksForNotes` narrows away.
  // No-op (and no extra query) for an unscoped reader.
  if (visible) {
    for (const row of readAmbiguousRows(db, noteIds)) {
      const relationship = row.relationship || WIKILINK_REL;
      if (visibleResolutionCount(db, row.target_path, relationship, visible) > 0) continue;
      const key = `${row.source_id}\u0000${relationship}\u0000${row.target_path.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.get(row.source_id)?.push({ target: row.target_path, relationship });
    }
  }
  return result;
}

/** Single-note convenience wrapper around {@link getUnresolvedLinksForNotes}. */
export function getUnresolvedLinksForNote(
  db: Database,
  noteId: string,
  visible?: (noteId: string) => boolean,
): BrokenLink[] {
  return getUnresolvedLinksForNotes(db, [noteId], visible).get(noteId) ?? [];
}

/**
 * Narrow a page of notes by the `has_broken_links` filter as a TAG-SCOPED
 * reader should see it — the vault#239 twin of
 * {@link narrowByVisibleAmbiguity}, and the reason
 * {@link sqlHasBrokenLinks} lifts the SQL filter entirely under scope: the
 * `unresolved_wikilinks` EXISTS test is neither a superset NOR a subset of
 * the right answer (it MISSES a note whose only candidates are invisible,
 * and it INCLUDES nothing it shouldn't), so neither polarity can be pushed
 * down and both are re-decided here on the reader's own sub-vault.
 *
 * Page-shortening is the same effect `filterNotesByTagScope` already has on
 * every scoped read. No-op when `wanted` is undefined or no predicate is
 * injected (unscoped).
 */
export function narrowByVisibleBrokenness<T extends { id: string }>(
  db: Database,
  notes: T[],
  wanted: boolean | undefined,
  visible: ((noteId: string) => boolean) | undefined,
): T[] {
  if (wanted === undefined || !visible || notes.length === 0) return notes;
  const byNote = getUnresolvedLinksForNotes(db, notes.map((n) => n.id), visible);
  return notes.filter((n) => ((byNote.get(n.id)?.length ?? 0) > 0) === wanted);
}

/**
 * The `hasBrokenLinks` value to push into SQL for a reader that will be
 * narrowed by {@link narrowByVisibleBrokenness} afterwards. Unlike
 * {@link sqlHasAmbiguousLinks} — where `true` survives because every
 * truly-ambiguous note also has a persisted row — BOTH polarities are lifted
 * under scope, because a note can be broken in the reader's sub-vault while
 * having no `unresolved_wikilinks` row at all (vault#239). Identity for
 * unscoped readers. Shared by both doors so REST and MCP cannot drift.
 */
export function sqlHasBrokenLinks(
  wanted: boolean | undefined,
  scoped: boolean,
): boolean | undefined {
  return scoped ? undefined : wanted;
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
 * count, distinct from `unresolved`'s `unresolved_link`. Each ambiguous
 * target is ALSO persisted to `ambiguous_wikilinks` (vault#581) so the
 * collision stays queryable after the write, symmetric with how
 * `unresolved_wikilinks` backs `has_broken_links`/`include_broken_links`.
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
  // deliberately NOT queued into `unresolved_wikilinks` — see the doc comment
  // above — but they ARE recorded in their own `ambiguous_wikilinks` table
  // (vault#581) so a later audit can find them via
  // `has_ambiguous_links`/`include_ambiguous_links` instead of only seeing
  // the transient write-time warning.
  syncUnresolvedWikilinks(db, noteId, unresolved);
  syncAmbiguousWikilinks(db, noteId, ambiguous);

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
 *
 * Also the body of `migrateToV28` (vault#567 item 2): boot runs this once
 * via `initSchema` so a pre-#555 2-column table is healed before the first
 * wikilink touch. Gated the existing way — no table → return; column
 * present → return; only the 2-column shape rebuilds. Does NOT create the
 * table on vaults that never queued an unresolved link (lazy creation
 * stays). The per-touch calls below become a no-op after v28.
 */
export function ensureRelationshipColumn(db: Database): void {
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
 * Deferred resolution covers all four legs of
 * {@link resolveWikilinkDetailed} (exact path, basename, H1 title, explicit
 * `path.ext`) plus, for structured-link pending rows, the ID leg of
 * {@link resolveLinkTargetDetailed} (vault#591). Verify picks the resolver
 * by `row.relationship` so a wikilink row cannot heal via ID. (Caveat: the
 * candidate pre-filter below matches the title/ext legs via SQL
 * `COLLATE NOCASE`, which case-folds ASCII only — a non-ASCII title
 * differing from the target only in letter case is missed at the candidate
 * stage and re-heals on the source's next save instead. Rare; tracked as a
 * follow-up.) Before this, the sweep matched a pending row to the new note
 * by PATH TEXT ONLY (`target_path = path OR path LIKE '%/'||target_path`)
 * — so a `[[John Doe]]` that resolved at write time via the H1-title
 * fallback (its note's displayed title differs from its path, e.g.
 * `people/jdoe`), or a `[[Foo.csv]]` that resolved via the extension leg,
 * silently never re-healed on a delete→recreate (the exact LB6 gap) and
 * more broadly never backfilled when the target note was created AFTER the
 * referencing note. An AMBIGUOUS target (≥2 notes now share the
 * path/title) resolves to neither and stays queued, identical to
 * write-time's "don't guess" contract — this also closes the pre-existing
 * asymmetry where the path-only sweep would link an ambiguous `[[Foo]]` to
 * whichever colliding note happened to be created.
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
    // resolve to this note under any resolveLinkTargetDetailed leg — exact
    // path, basename (target is the last path segment), H1 title, the
    // `path.ext` form, or a raw note ID (vault#591: typed `reference` fields
    // and ID-form structured links). A `null` bind (no H1 heading / no
    // extension) makes its clause never match (`target_path = NULL` is NULL,
    // i.e. falsy in SQL). The verify step below is what enforces correctness;
    // this clause only BOUNDS how many rows reach the resolver.
    rows = db.prepare(`
      SELECT source_id, target_path, relationship FROM unresolved_wikilinks
      WHERE target_path = ? COLLATE NOCASE
         OR ? LIKE '%/' || target_path
         OR target_path = ? COLLATE NOCASE
         OR target_path = ? COLLATE NOCASE
         OR target_path = ?
    `).all(notePath, notePath, h1Title, pathDotExt, noteId) as typeof rows;

    // vault#589: SQLite COLLATE NOCASE is ASCII-only. `[[CAFÉ]]` vs H1
    // `café` is excluded by the SQL pre-filter even though
    // findNotesByTitle folds with JS toLowerCase. Union remaining pending
    // rows whose target Unicode-folds equal to the H1; verify still
    // decides. The path.ext fold is omitted: write-time's extension leg
    // also uses COLLATE NOCASE on path, so a unicode-only path.ext miss
    // would fail verify too. (`[[FOO.CSV]]` vs `foo.csv` is ASCII and
    // already caught by the SQL clause.)
    if (h1Title) {
      const all = db.prepare(
        "SELECT source_id, target_path, relationship FROM unresolved_wikilinks",
      ).all() as typeof rows;
      const seen = new Set(rows.map((r) => `${r.source_id}\0${r.target_path}\0${r.relationship}`));
      const h1 = h1Title.toLowerCase();
      for (const row of all) {
        const key = `${row.source_id}\0${row.target_path}\0${row.relationship}`;
        if (seen.has(key)) continue;
        if (row.target_path.toLowerCase() === h1) {
          rows.push(row);
          seen.add(key);
        }
      }
    }
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
    // Resolver is picked by relationship (vault#591): wikilink rows go
    // through resolveWikilinkDetailed (write-time has no ID leg).
    // Structured-link rows go through resolveLinkTargetDetailed
    // (ID-then-path). A shared ID-first resolver over-heals `[[foo591]]`
    // against a later note with that id, and lets a decoy whose id equals
    // the bracket text steal a pending wikilink from a later titled note.
    const relationship = row.relationship || WIKILINK_REL;
    const detail = relationship === WIKILINK_REL
      ? resolveWikilinkDetailed(db, row.target_path)
      : resolveLinkTargetDetailed(db, row.target_path);
    if (!detail.resolved || detail.note_id !== noteId) continue;
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
// Ambiguous links (vault#581) — the queryable twin of `unresolved_wikilinks`
//
// An ambiguous target (≥2 notes match) is deliberately never linked and never
// queued for backfill (see {@link syncWikilinks}). Before #581 that meant it
// existed ONLY in the create/update response's transient `ambiguous_link`
// warning: `has_broken_links` didn't match the note (`unresolved_wikilinks`
// held no row for it), so a later audit couldn't surface the collision at all
// — asymmetric with the unresolved-link story. These helpers persist it in its
// own lazily-created table, which backs the `has_ambiguous_links` /
// `include_ambiguous_links` filters on `query-notes` / `GET /notes`.
//
// Kept in a SEPARATE table rather than folded into `unresolved_wikilinks` on
// purpose: the two states mean different things to a caller ("nothing there
// yet, will heal itself when the note arrives" vs. "too many things there,
// disambiguate the reference"), the backfill sweep must never treat an
// ambiguous row as pending-resolution, and folding them would have silently
// widened what `has_broken_links: true` returns for every existing caller.
//
// Like `unresolved_wikilinks`, the table lives outside `SCHEMA_SQL` and is
// created lazily on first write — a vault where no link has ever been
// ambiguous never grows it, and no schema-version bump is needed.
// ---------------------------------------------------------------------------

/** One note's ambiguous outbound link, as surfaced on a note read (vault#581). */
export interface AmbiguousLink {
  target: string;
  relationship: string;
  /** How many notes the target matched at the time it was last evaluated. */
  candidate_count: number;
}

/**
 * Ensure the ambiguous_wikilinks table exists. Called lazily — only when we
 * actually have an ambiguous link. Same shape as `unresolved_wikilinks`
 * (3-column PK, `ON DELETE CASCADE` so deleting the SOURCE note drops its
 * rows) plus the match count the write-time warning already carries.
 */
export function ensureAmbiguousTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ambiguous_wikilinks (
      source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      target_path TEXT NOT NULL COLLATE NOCASE,
      relationship TEXT NOT NULL DEFAULT '${WIKILINK_REL}',
      candidate_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_id, target_path, relationship)
    )
  `);
}

/**
 * Replace this note's `relationship = "wikilink"` ambiguous rows with the
 * targets a fresh content parse just found ambiguous. Scoped to wikilink-kind
 * rows only, exactly like {@link syncUnresolvedWikilinks} — a content
 * re-parse must not clobber ambiguous STRUCTURED-link rows recorded for this
 * note by {@link queueAmbiguousLink} (a different relationship, same table).
 */
function syncAmbiguousWikilinks(
  db: Database,
  noteId: string,
  ambiguous: AmbiguousWikilinkTarget[],
): void {
  if (ambiguous.length === 0) {
    // Clean up any old wikilink-kind ambiguous entries for this note (the
    // `[[Dup]]` was edited out, or one of the colliding notes went away and
    // the target now resolves).
    try {
      db.prepare("DELETE FROM ambiguous_wikilinks WHERE source_id = ? AND relationship = ?").run(noteId, WIKILINK_REL);
    } catch {
      // Table may not exist yet — that's fine.
    }
    return;
  }

  ensureAmbiguousTable(db);
  db.prepare("DELETE FROM ambiguous_wikilinks WHERE source_id = ? AND relationship = ?").run(noteId, WIKILINK_REL);
  const insert = db.prepare(
    "INSERT OR REPLACE INTO ambiguous_wikilinks (source_id, target_path, relationship, candidate_count) VALUES (?, ?, ?, ?)",
  );
  for (const entry of ambiguous) {
    insert.run(noteId, entry.target, WIKILINK_REL, entry.count);
  }
}

/**
 * Record a structured link (or typed `reference` field value) whose target
 * matched ≥2 notes. `INSERT OR REPLACE` so a re-write with a different match
 * count refreshes rather than keeping a stale one. Called from
 * {@link resolveOrQueueLink}, the single funnel every structured-link write
 * path goes through.
 */
export function queueAmbiguousLink(
  db: Database,
  sourceId: string,
  targetPath: string,
  relationship: string,
  candidateCount: number,
): void {
  ensureAmbiguousTable(db);
  db.prepare(
    "INSERT OR REPLACE INTO ambiguous_wikilinks (source_id, target_path, relationship, candidate_count) VALUES (?, ?, ?, ?)",
  ).run(sourceId, targetPath, relationship, candidateCount);
}

/**
 * Ambiguous-table twin of {@link clearQueuedLink} — drop every ambiguous row
 * for `sourceId` under `relationship`, whatever (stale) target it names. Used
 * by the scalar `reference`-field sync before re-resolving a changed value.
 * Safe no-op when the table doesn't exist yet.
 */
export function clearAmbiguousLink(db: Database, sourceId: string, relationship: string): void {
  try {
    db.prepare(
      "DELETE FROM ambiguous_wikilinks WHERE source_id = ? AND relationship = ?",
    ).run(sourceId, relationship);
  } catch {
    // Table may not exist yet — nothing to clear.
  }
}

/**
 * Ambiguous-table twin of {@link clearQueuedLinkTarget} — drop exactly ONE
 * row, scoped by `targetPath` as well, so a `cardinality: "many"` reference
 * field losing one element doesn't blanket-clear the others' rows.
 * Safe no-op when the table doesn't exist yet.
 */
export function clearAmbiguousLinkTarget(
  db: Database,
  sourceId: string,
  relationship: string,
  targetPath: string,
): void {
  try {
    db.prepare(
      "DELETE FROM ambiguous_wikilinks WHERE source_id = ? AND relationship = ? AND target_path = ? COLLATE NOCASE",
    ).run(sourceId, relationship, targetPath);
  } catch {
    // Table may not exist yet — nothing to clear.
  }
}

/**
 * Batch-fetch each note's ambiguous outbound links — the
 * `include_ambiguous_links` surfacing on `query-notes` / `GET /notes`. ONE
 * query for the whole page (mirrors {@link getUnresolvedLinksForNotes}), not
 * one per note. Every requested id gets an entry (possibly `[]`); when the
 * table has never been created every id maps to `[]` without a query attempt.
 *
 * `visible` (vault#581 auth review) is an OPTIONAL per-candidate-note
 * predicate, injected by the server layer for a TAG-SCOPED reader. Core
 * stays scope-unaware — it only invokes the closure — exactly like
 * `nearTraversable` / `expandVisibility` / `aggregateVisibility` on the MCP
 * tool layer.
 *
 * Why it's needed: `candidate_count` is derived VAULT-WIDE by
 * {@link resolveWikilinkDetailed}, so the stored `2` on a `[[Dup]]` whose
 * candidates are one `#work` and one `#personal` note tells a `work`-scoped
 * reader that a second `Dup` exists somewhere it cannot see. Unlike
 * `broken_links` — which is safe by construction, since "unresolved" can
 * only mean *matched nothing* and therefore can't fingerprint anything —
 * an ambiguous row exists ONLY because ≥2 notes matched, and the count
 * quantifies exactly that.
 *
 * So when `visible` is supplied, the persisted count is NOT trusted: each
 * row's target is re-resolved and its candidates narrowed to the ones the
 * reader can see. A row is reported only when ≥2 VISIBLE candidates remain,
 * and `candidate_count` is the visible count. That is precisely the answer
 * an unscoped reader would get on a vault containing only the visible notes
 * — the same "answer on the visible sub-vault" rule vault#674 (`.tags`
 * scrubbing) and vault#675 (out-of-scope query tags match nothing) chose,
 * rather than refusing the request. It also incidentally hides a row that
 * has gone stale (its target resolves cleanly again but no sweep has
 * touched it yet), since that too collapses to <2 candidates.
 *
 * Cost: one re-resolution per persisted row, and only for scoped readers.
 * Ambiguous rows are rare by nature (each is a genuine naming collision),
 * and a page with none does no extra work at all.
 */
interface AmbiguousRow {
  source_id: string;
  target_path: string;
  relationship: string;
  candidate_count: number;
}

/**
 * Read the persisted `ambiguous_wikilinks` rows for a set of source notes,
 * batched under the bound-param cap. `[]` when the table has never been
 * created. Shared by the ambiguity surface and the vault#239 brokenness
 * surface so the two read the same rows the same way.
 */
function readAmbiguousRows(db: Database, noteIds: string[]): AmbiguousRow[] {
  const rows: AmbiguousRow[] = [];
  try {
    for (const chunk of chunkForInClause(noteIds)) {
      const placeholders = chunk.map(() => "?").join(", ");
      rows.push(...db.prepare(
        `SELECT source_id, target_path, relationship, candidate_count FROM ambiguous_wikilinks WHERE source_id IN (${placeholders})`,
      ).all(...chunk) as AmbiguousRow[]);
    }
  } catch {
    return []; // Table doesn't exist — nothing has ever been ambiguous here.
  }
  return rows;
}

/**
 * How many notes this target resolves to IN THE READER'S OWN SUB-VAULT — the
 * single place both scoped link surfaces decide what a reference means for a
 * tag-scoped reader, so they cannot drift:
 *
 *   - `>= 2` → ambiguous for this reader ({@link getAmbiguousLinksForNotes})
 *   - `0`    → broken for this reader ({@link getUnresolvedLinksForNotes})
 *   - `1`    → resolves cleanly; neither surface reports it
 *
 * A row that has gone stale (its target resolves to exactly one note again,
 * but no sweep has touched it yet) resolves through the SAME resolver its
 * write path used, so `resolved` has to be honoured explicitly — a resolved
 * `WikilinkResolution` carries an EMPTY `candidates` array, which would
 * otherwise read as "0 visible", i.e. broken.
 */
function visibleResolutionCount(
  db: Database,
  targetPath: string,
  relationship: string,
  visible: (noteId: string) => boolean,
): number {
  const detail = relationship === WIKILINK_REL
    ? resolveWikilinkDetailed(db, targetPath)
    : resolveLinkTargetDetailed(db, targetPath);
  if (detail.resolved) return detail.note_id && visible(detail.note_id) ? 1 : 0;
  return detail.candidates.filter((c) => visible(c.note_id)).length;
}

export function getAmbiguousLinksForNotes(
  db: Database,
  noteIds: string[],
  visible?: (noteId: string) => boolean,
): Map<string, AmbiguousLink[]> {
  const result = new Map<string, AmbiguousLink[]>(noteIds.map((id) => [id, []]));
  if (noteIds.length === 0) return result;

  const rows = readAmbiguousRows(db, noteIds);

  for (const row of rows) {
    const relationship = row.relationship || WIKILINK_REL;
    let candidateCount = row.candidate_count;
    if (visible) {
      candidateCount = visibleResolutionCount(db, row.target_path, relationship, visible);
      if (candidateCount < 2) continue; // not ambiguous in the reader's sub-vault
    }
    result.get(row.source_id)?.push({
      target: row.target_path,
      relationship,
      candidate_count: candidateCount,
    });
  }
  return result;
}

/** Single-note convenience wrapper around {@link getAmbiguousLinksForNotes}. */
export function getAmbiguousLinksForNote(
  db: Database,
  noteId: string,
  visible?: (noteId: string) => boolean,
): AmbiguousLink[] {
  return getAmbiguousLinksForNotes(db, [noteId], visible).get(noteId) ?? [];
}

/**
 * Narrow a page of notes by the vault#581 `has_ambiguous_links` filter as a
 * TAG-SCOPED reader should see it. Core's SQL filter counts a persisted row
 * regardless of whether the reader can see the notes that collided, so on
 * its own it is an oracle: a scoped caller could sweep its whole in-scope
 * corpus and enumerate cross-scope naming collisions.
 *
 * The server layer therefore asks core for a SUPERSET and applies the real
 * predicate here:
 *   - `wanted === true` — the SQL filter is kept (every truly-ambiguous note
 *     also has a row, so `EXISTS` is a superset) and this drops the notes
 *     whose rows collapse to <2 visible candidates.
 *   - `wanted === false` — the SQL filter is LIFTED (it would have excluded
 *     notes that are not ambiguous in the reader's sub-vault, and a
 *     post-filter cannot add rows back), and this keeps only notes with no
 *     surviving row.
 *
 * Page-shortening is the same effect `filterNotesByTagScope` already has on
 * every scoped read — the page is narrowed after core drew it, so a scoped
 * page can come back shorter than `limit` while more results remain.
 * No-op when `wanted` is undefined or no predicate is injected (unscoped).
 */
export function narrowByVisibleAmbiguity<T extends { id: string }>(
  db: Database,
  notes: T[],
  wanted: boolean | undefined,
  visible: ((noteId: string) => boolean) | undefined,
): T[] {
  if (wanted === undefined || !visible || notes.length === 0) return notes;
  const byNote = getAmbiguousLinksForNotes(db, notes.map((n) => n.id), visible);
  return notes.filter((n) => ((byNote.get(n.id)?.length ?? 0) > 0) === wanted);
}

/**
 * The `hasAmbiguousLinks` value to push into SQL for a reader that will be
 * narrowed by {@link narrowByVisibleAmbiguity} afterwards. `true` stays (it
 * is a superset); `false` is lifted to `undefined` (it is not). Identity for
 * unscoped readers. Shared by both doors so REST and MCP cannot drift on
 * which polarity is safe to push down.
 */
export function sqlHasAmbiguousLinks(
  wanted: boolean | undefined,
  scoped: boolean,
): boolean | undefined {
  return scoped && wanted === false ? undefined : wanted;
}

/**
 * Every string a `[[wikilink]]` / structured-link target could have used to
 * match `note` — its path, its basename, its `path.ext` form, and its H1
 * title: the four legs {@link resolveWikilinkDetailed} matches on, so this is
 * a complete necessary-condition superset. Lower-cased and trimmed. Shared by
 * {@link requeueInboundWikilinksForDelete}'s pre-filter and
 * {@link refreshAmbiguousLinks}'s scope so the two can't drift on what
 * "targets this note" means.
 */
export function noteResolutionKeys(note: Pick<Note, "path" | "extension" | "content"> | null | undefined): string[] {
  const keys = new Set<string>();
  const addKey = (s: string | null | undefined): void => {
    const k = s?.trim().toLowerCase();
    if (k) keys.add(k);
  };
  if (note?.path) {
    addKey(note.path);
    const slash = note.path.lastIndexOf("/");
    addKey(slash >= 0 ? note.path.slice(slash + 1) : note.path); // basename
    if (note.extension) addKey(`${note.path}.${note.extension}`);
  }
  if (note?.content) addKey(extractH1Title(note.content));
  return [...keys];
}

/** {@link noteResolutionKeys} for a bare path string (no note row to read) — used for a note's OLD path after a rename. */
export function pathResolutionKeys(path: string | null | undefined, extension?: string | null): string[] {
  if (!path) return [];
  const keys = [path];
  const slash = path.lastIndexOf("/");
  keys.push(slash >= 0 ? path.slice(slash + 1) : path);
  if (extension) keys.push(`${path}.${extension}`);
  return keys.map((k) => k.trim().toLowerCase()).filter(Boolean);
}

/**
 * Re-evaluate every persisted ambiguous row whose target is one of `keys` —
 * the self-healing counterpart of {@link resolveUnresolvedWikilinks}, and the
 * reason `has_ambiguous_links` can't go stale when the collision is cleaned
 * up. Called AFTER a note is created, deleted, or repathed, with that note's
 * {@link noteResolutionKeys} (plus the OLD path's keys on a rename), so the
 * scan is bounded to rows that note could possibly have been a candidate for.
 *
 * Each surviving row is re-run through the SAME resolver its write path used
 * (picked by `relationship`, exactly as the unresolved sweep does), and lands
 * in one of three places:
 *
 *   - resolves to exactly one note now (a candidate was deleted or renamed
 *     away) → the link is created and the row is dropped. The reference is
 *     no longer ambiguous, so it must stop being reported as such.
 *   - still ambiguous → the row stays; `candidate_count` is refreshed if the
 *     number of colliding notes changed.
 *   - matches nothing now (every candidate is gone) → the row moves to
 *     `unresolved_wikilinks`, i.e. it becomes an ordinary BROKEN link that
 *     `has_broken_links` reports and the normal backfill can later heal.
 *
 * Returns the number of rows changed. No-op (one bounded SELECT, or none at
 * all when the table has never been created) on a vault with no ambiguity.
 */
export function refreshAmbiguousLinks(db: Database, keys: (string | null | undefined)[]): number {
  const normalized = [...new Set(
    keys.map((k) => k?.trim().toLowerCase()).filter((k): k is string => Boolean(k)),
  )];
  if (normalized.length === 0) return 0;

  let rows: { source_id: string; target_path: string; relationship: string; candidate_count: number }[];
  try {
    // `keys` is at most a handful of strings (one note's resolution keys,
    // optionally plus an old path's), so this stays well under the bound-param
    // cap that `chunkForInClause` guards elsewhere.
    const clauses = normalized.map(() => "target_path = ? COLLATE NOCASE").join(" OR ");
    rows = db.prepare(
      `SELECT source_id, target_path, relationship, candidate_count FROM ambiguous_wikilinks WHERE ${clauses}`,
    ).all(...normalized) as typeof rows;
  } catch {
    return 0; // Table doesn't exist — nothing has ever been ambiguous here.
  }
  if (rows.length === 0) return 0;

  const drop = db.prepare(
    "DELETE FROM ambiguous_wikilinks WHERE source_id = ? AND target_path = ? AND relationship = ?",
  );
  const bumpCount = db.prepare(
    "UPDATE ambiguous_wikilinks SET candidate_count = ? WHERE source_id = ? AND target_path = ? AND relationship = ?",
  );

  let changed = 0;
  for (const row of rows) {
    const relationship = row.relationship || WIKILINK_REL;
    const detail = relationship === WIKILINK_REL
      ? resolveWikilinkDetailed(db, row.target_path)
      : resolveLinkTargetDetailed(db, row.target_path);

    if (detail.resolved) {
      // Wikilinks never self-link (write-time skips them), so guard here too.
      if (detail.note_id !== row.source_id) {
        linkOps.createLink(db, row.source_id, detail.note_id!, relationship);
      }
      drop.run(row.source_id, row.target_path, relationship);
      changed++;
    } else if (detail.ambiguous) {
      if (detail.candidates.length !== row.candidate_count) {
        bumpCount.run(detail.candidates.length, row.source_id, row.target_path, relationship);
        changed++;
      }
    } else {
      drop.run(row.source_id, row.target_path, relationship);
      queueUnresolvedLink(db, row.source_id, row.target_path, relationship);
      changed++;
    }
  }
  return changed;
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
 * Drop exactly ONE pending forward-ref — scoped by `targetPath` in addition
 * to `sourceId`/`relationship` (the full `unresolved_wikilinks` primary
 * key). Used by the `cardinality:"many"` reference-field array sync
 * (core/src/store.ts's `syncReferenceFieldLinks`) when a SPECIFIC array
 * element is removed from a field's value: unlike the scalar path (which
 * owns the ENTIRE relationship namespace and can safely clear every queued
 * row via {@link clearQueuedLink}), an array field can have MULTIPLE
 * pending forward-refs under the same relationship at once (one per
 * unresolved element) — blanket-clearing all of them on a single element's
 * removal would silently drop the other still-pending elements' queue rows.
 * Safe no-op when the table doesn't exist yet or nothing is queued for this
 * exact (source, target, relationship) triple.
 */
export function clearQueuedLinkTarget(
  db: Database,
  sourceId: string,
  relationship: string,
  targetPath: string,
): void {
  try {
    db.prepare(
      "DELETE FROM unresolved_wikilinks WHERE source_id = ? AND relationship = ? AND target_path = ? COLLATE NOCASE",
    ).run(sourceId, relationship, targetPath);
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
 *     notes sharing an H1 title). NEITHER linked nor queued for backfill —
 *     see {@link syncWikilinks}'s doc comment for why queuing an ambiguous
 *     target into `unresolved_wikilinks` would be wrong — but recorded in
 *     `ambiguous_wikilinks` (vault#581) so it stays queryable after the
 *     write. Callers MUST surface a distinct `ambiguous_link` warning
 *     naming the target + `candidates.length`.
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
  if (detail.ambiguous) {
    // vault#581 — record the collision so it survives the response. Every
    // structured-link write path (MCP create/update-note, REST POST/PATCH,
    // typed `reference` fields) funnels through here, so persisting once
    // here covers all of them and can't drift from the warning.
    queueAmbiguousLink(db, sourceId, target, relationship, detail.candidates.length);
    return { status: "ambiguous", candidates: detail.candidates };
  }
  // Not ambiguous (any more): drop a stale row this exact (source, target,
  // relationship) may have left behind on an earlier write.
  clearAmbiguousLinkTarget(db, sourceId, relationship, target);
  if (detail.resolved) return { status: "resolved", note_id: detail.note_id! };
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
  // necessary-condition superset — {@link noteResolutionKeys} owns that key
  // set, shared with the vault#581 ambiguity sweep). Computed ONCE, then each
  // source wikilink's target is gated on set membership BEFORE the resolver call
  // (whose title-fallback leg scans every note's content). Without this, a hub
  // note with hundreds of inbound sources would fire hundreds of full-vault
  // scans in one delete. The resolver still CONFIRMS each survivor — the
  // pre-filter narrows, it doesn't decide.
  const deleted = getNote(db, noteId);
  const keys = new Set(noteResolutionKeys(deleted));
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
