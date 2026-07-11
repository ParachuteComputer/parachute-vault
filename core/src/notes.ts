import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { Note, NoteIndex, QueryOpts, QueryNotesPage, VaultStats, VaultMap, AggregateSpec, AggregateRow } from "./types.js";
import { normalizePath } from "./paths.js";
import { transaction } from "./txn.js";
import {
  buildOperatorClause,
  isOperatorObject,
  QueryError,
  requireIndexedField,
} from "./query-operators.js";
import {
  CURSOR_VERSION,
  CursorError,
  computeQueryHash,
  decodeCursor,
  encodeCursor,
  timestampToMs,
  type CursorPayload,
  type QueryHashInputs,
} from "./cursor.js";
import { getIndexedField, releaseField } from "./indexed-fields.js";
import { computeExpandedTagCounts, loadTagHierarchy, stripTagHash } from "./tag-hierarchy.js";
import { chunkForInClause, IN_VIA_JSON_EACH, jsonEachParam } from "./sql-in.js";
import {
  buildLiteralSearchQuery,
  SEARCH_WEIGHT_PATH,
  SEARCH_WEIGHT_CONTENT,
  type SearchMode,
} from "./search-query.js";
import { generateUlid } from "./ulid.js";

/**
 * Write-attribution context (vault#298) — the two axes of provenance threaded
 * from the authenticated request down into every note write.
 *
 *   actor — WHO: the principal the write is attributed to (a JWT `sub`, or an
 *           operator / `token:<id>` label for non-JWT auth). Lands in
 *           `created_by` on the first write and `last_updated_by` on every
 *           write.
 *   via   — VIA WHAT: the interface/channel the write arrived through
 *           (`mcp`, `surface:<name>`, `agent:<id>`, `operator`/`cli`, `api`).
 *           Lands in `created_via` / `last_updated_via` symmetrically.
 *
 * Both are independently optional — an internal/import write may carry
 * neither, and a non-JWT operator write carries an `actor`/`via` pair without
 * a `sub`. `undefined` (or a missing context) means "don't write this column,"
 * so legacy callers and importers leave attribution NULL rather than
 * fabricating it.
 */
export interface WriteContext {
  actor?: string | null;
  via?: string | null;
}

/** Normalize an attribution value: empty/whitespace → null (never store ""). */
function attrValue(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * Generate a new note/attachment ID.
 *
 * As of vault#ulid-ids this returns a ULID (see `ulid.ts`) — monotonic,
 * lexicographically time-sortable, Crockford base32, opaque, and
 * collision-resistant. Previously this returned a timestamp-format ID
 * (`YYYY-MM-DD-HH-MM-SS-ffffff`).
 *
 * IMPORTANT: existing notes are NOT migrated. Old timestamp-format IDs
 * stay exactly as they are — only newly-generated IDs use the ULID
 * format, so a vault's `id` column is (and must remain) a mix of both
 * shapes indefinitely. Nothing may assume a uniform id format, and
 * nothing may parse a note's ID to recover its creation time — that's
 * what the `created_at` column is for. The cursor-pagination tiebreaker
 * (`cursor.ts`) treats `id` as an opaque, stable string for ordering
 * ties only, which holds for any id format.
 */
export function generateId(): string {
  return generateUlid();
}

export function createNote(
  db: Database,
  content: string,
  opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string; extension?: string; actor?: string | null; via?: string | null },
): Note {
  const id = opts?.id ?? generateId();
  const createdAt = opts?.created_at ?? new Date().toISOString();
  const metadata = opts?.metadata ? JSON.stringify(opts.metadata) : "{}";
  const path = normalizePath(opts?.path);
  // `extension` defaults to "md" so existing callers see no change.
  // Validation happens at the API surface (MCP/REST) — the Store accepts
  // whatever the caller passed; importer paths trust the export's shape.
  const extension = opts?.extension ?? "md";

  // Write-attribution (vault#298). On CREATE both axes land in the
  // `created_*` columns AND mirror into `last_updated_*` — the first write IS
  // the most-recent write, so a never-updated note reports the same author on
  // both. NULL when the caller passed no attribution (internal/import writes),
  // never an empty string.
  const actor = attrValue(opts?.actor);
  const via = attrValue(opts?.via);

  // Empty content is a valid state (vault#323): skeleton notes, drafts
  // saved before content, organizing-only notes, capture-then-fill flows.
  // The earlier #213 guard rejected `content + path both absent`; we no
  // longer enforce it because real vaults legitimately carry such rows
  // and the round-trip import has to accept them.

  // `updated_at` is set to `created_at` on insert so a client whose optimistic
  // concurrency check falls back to `createdAt` on a never-updated note
  // (the common shape: `note.updatedAt ?? note.createdAt`) matches the stored
  // value. Hook-style writes with `skipUpdatedAt` preserve this; real user
  // edits bump it strictly upward, so `updated_at > created_at` still means
  // "user-touched since creation."
  //
  // `updated_at_ms` (vault#586) is the integer keyset-ordering mirror of
  // `updated_at`. Derived from the SAME `createdAt` value with the UTC-correct
  // `timestampToMs`; a `null` (unparseable caller-supplied `created_at`, e.g.
  // via `createNoteRaw` during import) falls back to wall-clock now so a fresh
  // row never lands with a NULL keyset key. Import's `restoreNoteTimestamps`
  // overwrites both columns from the exported bytes immediately after.
  const updatedAtMs = timestampToMs(createdAt) ?? Date.now();
  try {
    db.prepare(
      `INSERT INTO notes (id, content, path, metadata, created_at, updated_at, updated_at_ms, extension, created_by, created_via, last_updated_by, last_updated_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, content, path, metadata, createdAt, createdAt, updatedAtMs, extension, actor, via, actor, via);
  } catch (err) {
    if (path !== null && isPathUniqueError(err)) {
      throw new PathConflictError(path);
    }
    throw err;
  }

  if (opts?.tags && opts.tags.length > 0) {
    tagNote(db, id, opts.tags);
  }

  return getNote(db, id)!;
}

export function getNote(db: Database, id: string): Note | null {
  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | null;
  if (!row) return null;

  const note = rowToNote(row);
  note.tags = getNoteTags(db, note.id);
  return note;
}

/**
 * Look up a note by `path`. When `extension` is provided, the lookup
 * matches the `(path, extension)` tuple — exactly one row, since v18's
 * composite uniqueness index makes that combo unique. When `extension`
 * is omitted:
 *
 *   - 0 matches → return null (back-compat).
 *   - 1 match → return it (back-compat).
 *   - >1 match → throw `AmbiguousPathError` (vault#330 S1). Caller
 *     must pass `extension` explicitly to disambiguate. Mirrors the
 *     wikilink ambiguity policy from vault#328 edge case 3 —
 *     path-as-key lookup is "(path, extension) tuple" everywhere.
 *
 * Path match is case-insensitive (`COLLATE NOCASE`) — matches the v5
 * uniqueness contract and how wikilinks resolve.
 */
export function getNoteByPath(db: Database, path: string, extension?: string): Note | null {
  if (extension !== undefined) {
    const row = db.prepare(
      "SELECT * FROM notes WHERE path = ? COLLATE NOCASE AND LOWER(extension) = ?",
    ).get(path, extension.toLowerCase()) as NoteRow | null;
    if (!row) return null;
    const note = rowToNote(row);
    note.tags = getNoteTags(db, note.id);
    return note;
  }

  // No extension given. The composite-unique index lets two rows share
  // a path differing only by extension, so we have to look at all matches
  // before returning.
  const rows = db.prepare(
    "SELECT * FROM notes WHERE path = ? COLLATE NOCASE",
  ).all(path) as NoteRow[];
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const note = rowToNote(rows[0]!);
    note.tags = getNoteTags(db, note.id);
    return note;
  }
  throw new AmbiguousPathError(
    path,
    rows.map((r) => ({ id: r.id, extension: r.extension ?? "md" })),
  );
}

/**
 * Extract a note's "H1 title" — the first line in `content` that starts
 * with a literal `"# "` (a level-1 Markdown heading; `"## "`+ don't match
 * because `^#[ \t]` fails at that line's start once a second `#` follows
 * the first). Returns null when no such line exists, or the text after
 * the marker is blank once trimmed.
 */
export function extractH1Title(content: string): string | null {
  const match = content.match(/^#[ \t]+(.+)$/m);
  if (!match) return null;
  const title = match[1]!.trim();
  return title.length > 0 ? title : null;
}

/**
 * Find every note whose H1 title (see {@link extractH1Title}) equals
 * `title`, case-insensitively (matches the COLLATE NOCASE policy every
 * other path/basename lookup in this file uses). Used as the title-fallback
 * step for wikilink/id/path resolution — a target that misses on
 * id/path/basename gets one more chance against notes whose displayed
 * title differs from their path.
 *
 * This is a full-content scan: no index exists on "first heading line," so
 * every note's content is read once and matched in JS. Acceptable because
 * every call site reaches this ONLY after the cheap indexed lookups (id,
 * path, basename) have already missed — a rare fallback path, not the hot
 * resolution route.
 */
export function findNotesByTitle(db: Database, title: string): { id: string; path: string | null }[] {
  const needle = title.trim().toLowerCase();
  if (!needle) return [];
  const rows = db.prepare("SELECT id, path, content FROM notes").all() as {
    id: string;
    path: string | null;
    content: string;
  }[];
  const matches: { id: string; path: string | null }[] = [];
  for (const row of rows) {
    const h1 = extractH1Title(row.content);
    if (h1 && h1.toLowerCase() === needle) {
      matches.push({ id: row.id, path: row.path });
    }
  }
  return matches;
}

/**
 * Title-fallback lookup: resolve `title` to a note ONLY when exactly one
 * note in the vault carries that H1 title (see {@link findNotesByTitle}).
 * Zero matches or 2+ matches (ambiguous) both return null — "don't guess"
 * mirrors the existing basename-ambiguity policy (vault#328). Callers use
 * this as the LAST resort after id and path/basename resolution have
 * already missed; exact id/path matches always win first.
 */
export function getNoteByTitle(db: Database, title: string): Note | null {
  const matches = findNotesByTitle(db, title);
  if (matches.length !== 1) return null;
  return getNote(db, matches[0]!.id);
}

export function getNotes(db: Database, ids: string[]): Note[] {
  if (ids.length === 0) return [];
  // Dedupe before chunking: a duplicate id straddling two chunk boundaries
  // would otherwise be fetched (and returned) twice, unlike the old single
  // IN-list which returned each matching row once regardless of duplicate
  // params. Matches getNoteTagsForNotes / getNoteSummaries.
  const uniqueIds = [...new Set(ids)];
  // Chunk under the DO 100-bound-param cap (see sql-in.ts). Each chunk is its
  // own IN-list query; results are merged and re-sorted by created_at (with id
  // as a deterministic tiebreak) to preserve the single-statement ORDER BY.
  const rows: NoteRow[] = [];
  for (const chunk of chunkForInClause(uniqueIds)) {
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(...db.prepare(
      `SELECT * FROM notes WHERE id IN (${placeholders})`,
    ).all(...chunk) as NoteRow[]);
  }
  rows.sort((a, b) =>
    a.created_at < b.created_at ? -1
    : a.created_at > b.created_at ? 1
    : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return notesWithTags(db, rows);
}

/**
 * Thrown by `updateNote` when an `if_updated_at` precondition does not match
 * the note's current `updated_at`. The SELECT+check+UPDATE happens as one
 * atomic conditional UPDATE so two concurrent callers cannot both pass the
 * check and both commit.
 */
export class ConflictError extends Error {
  code = "CONFLICT" as const;
  note_id: string;
  note_path: string | null;
  current_updated_at: string | null;
  expected_updated_at: string;

  constructor(noteId: string, notePath: string | null, current: string | null, expected: string) {
    super(
      `conflict: note "${noteId}" has been modified (current updated_at=${current ?? "null"}, expected=${expected})`,
    );
    this.name = "ConflictError";
    this.note_id = noteId;
    this.note_path = notePath;
    this.current_updated_at = current;
    this.expected_updated_at = expected;
  }
}

/**
 * Thrown by `updateNote` when a `state_transition` precondition fails: the
 * named metadata field's current value does not equal `from` (a missing field
 * counts as a mismatch). Distinct from `ConflictError` (vault#299 settled lead
 * #3) — a state-transition conflict is about a VALUE not matching, not a
 * stale `updated_at` token, so it carries its own `transition_conflict` code
 * and the from/to/current triple rather than the if_updated_at vocabulary.
 *
 * The check + set is one atomic conditional UPDATE (`... WHERE
 * json_extract(metadata,'$.field') IS ?`), so two racing transitioners can't
 * both observe `from` and both commit — exactly one wins, the other gets this.
 */
export class TransitionConflictError extends Error {
  code = "TRANSITION_CONFLICT" as const;
  note_id: string;
  note_path: string | null;
  field: string;
  expected_from: unknown;
  to: unknown;
  current: unknown;

  constructor(
    noteId: string,
    notePath: string | null,
    field: string,
    from: unknown,
    to: unknown,
    current: unknown,
  ) {
    super(
      `transition_conflict: note "${noteId}" field "${field}" is ${JSON.stringify(
        current ?? null,
      )}, expected ${JSON.stringify(from)} to transition to ${JSON.stringify(to)}`,
    );
    this.name = "TransitionConflictError";
    this.note_id = noteId;
    this.note_path = notePath;
    this.field = field;
    this.expected_from = from;
    this.to = to;
    this.current = current;
  }
}

/**
 * Thrown by `createNote` / `updateNote` when the requested path is already
 * taken by another note. Surfaces as 409 at the HTTP layer so clients can
 * distinguish "path taken — pick another" from a generic 500.
 *
 * Detected by catching SQLite's UNIQUE-constraint error on the
 * `idx_notes_path_unique` partial index (schema v5+). Matches the tag
 * "UNIQUE constraint failed: notes.path" rather than a numeric code so
 * we keep working if bun:sqlite changes its error class hierarchy.
 */
export class PathConflictError extends Error {
  code = "PATH_CONFLICT" as const;
  // Stable error_type (vault#554) — additive; mirrors the `error_type` REST
  // has hardcoded in its json response since #126. Lets the generic MCP
  // domain-error mapping (src/mcp-http.ts) pick this class up without a
  // bespoke branch, the same way REST's catch already does explicitly.
  error_type = "path_conflict" as const;
  path: string;

  constructor(path: string) {
    super(`path_conflict: another note already uses path "${path}"`);
    this.name = "PathConflictError";
    this.path = path;
  }
}

/**
 * Thrown by `getNoteByPath` when the caller looked up a path that has
 * multiple notes (post-vault#328: same path, different extensions),
 * without specifying which extension to disambiguate. Aligns the
 * path-as-key lookup contract with the wikilink ambiguity policy
 * (vault#328 edge case 3): refuse-and-require-explicit-extension.
 *
 * Surfaces structured fields so callers (MCP `resolveNote`, REST
 * path-as-id handlers) can convert to a clear 409 / 4xx with the list
 * of candidate extensions. See vault#330 S1.
 */
export class AmbiguousPathError extends Error {
  code = "AMBIGUOUS_PATH" as const;
  // Stable error_type (vault#554) — see PathConflictError's comment.
  error_type = "ambiguous_path" as const;
  path: string;
  candidates: { id: string; extension: string }[];

  constructor(path: string, candidates: { id: string; extension: string }[]) {
    const list = candidates.map((c) => c.extension).join(", ");
    super(`ambiguous_path: "${path}" matches ${candidates.length} notes (extensions: ${list}); pass \`extension\` to disambiguate`);
    this.name = "AmbiguousPathError";
    this.path = path;
    this.candidates = candidates;
  }
}

/**
 * Per-call item cap on `createNote`/`updateNote` batch entry points
 * (MCP `create-note` / `update-note` and HTTP `POST /api/notes`).
 * Single source of truth — both transports import from here so the cap
 * can never silently drift between them. See #213 for the runaway-client
 * incident that motivated the cap (7,453 empty notes in one MCP burst).
 */
export const MAX_BATCH_SIZE = 500;

/**
 * Validate a caller-supplied file extension (vault#328). Rules:
 *   1. Non-empty, lowercase alphanumeric only.
 *   2. Length 1–16 — long enough for "markdown" etc., short enough to
 *      bound on-disk filename length.
 *   3. No dot/slash/uppercase — those would create path-encoding
 *      ambiguity or collide with filesystem separators.
 *   4. Reserved: anything matching /^parachute/i is refused because the
 *      `.parachute/` sidecar dir convention owns that namespace; a note
 *      with extension `parachute` would write to `<path>.parachute`
 *      which is ambiguous with a directory entry.
 *
 * Throws `ExtensionValidationError` on failure. Both MCP and REST
 * surfaces import this so the contract can never drift between them.
 */
export const EXTENSION_PATTERN = /^[a-z0-9]{1,16}$/;

export class ExtensionValidationError extends Error {
  code = "INVALID_EXTENSION" as const;
  // Stable error_type (vault#554) — see PathConflictError's comment.
  error_type = "invalid_extension" as const;
  extension: string;
  reason: string;

  constructor(extension: string, reason: string) {
    super(`invalid extension "${extension}": ${reason}`);
    this.name = "ExtensionValidationError";
    this.extension = extension;
    this.reason = reason;
  }
}

export function validateExtension(extension: unknown): string {
  if (typeof extension !== "string") {
    throw new ExtensionValidationError(
      String(extension),
      `must be a string (got ${typeof extension})`,
    );
  }
  if (extension.length === 0) {
    throw new ExtensionValidationError(
      extension,
      "must be non-empty; omit the field entirely to default to 'md'",
    );
  }
  if (!EXTENSION_PATTERN.test(extension)) {
    throw new ExtensionValidationError(
      extension,
      `must match ${EXTENSION_PATTERN.source} (lowercase alphanumeric, 1–16 chars; no '.', '/', or uppercase)`,
    );
  }
  // Reserved namespace: anything that starts with "parachute" collides
  // with the .parachute/ sidecar directory convention. The pattern check
  // above already enforces lowercase, so a literal prefix match is exact.
  if (extension.startsWith("parachute")) {
    throw new ExtensionValidationError(
      extension,
      "the 'parachute' prefix is reserved for the .parachute/ sidecar dir",
    );
  }
  return extension;
}

/**
 * Thrown by {@link validatePath} when a caller-supplied note `path` can never
 * round-trip safely (vault#589 / FIX 2). Carries a stable `error_type`
 * (`invalid_path`) so REST's catch and the generic MCP domain-error mapping
 * (`src/mcp-http.ts`) both surface a clean 400 — same shape rule as
 * `ExtensionValidationError`.
 */
export class PathValidationError extends Error {
  code = "INVALID_PATH" as const;
  error_type = "invalid_path" as const;
  path: string;
  reason: string;

  constructor(path: string, reason: string) {
    super(`invalid_path: "${path}" ${reason}`);
    this.name = "PathValidationError";
    this.path = path;
    this.reason = reason;
  }
}

/**
 * Reject a caller-supplied note path that can never round-trip safely
 * (vault#589 / FIX 2). Two rules, both enforced at the WRITE surface only
 * (REST + MCP create/update, exactly where `validateExtension` sits):
 *
 *   1. **No NUL byte** — never valid in a filename. A NUL-in-path note keeps
 *      its resolved target inside the export root (so it slips the traversal
 *      guard), then uncaught-throws `writeFileSync`, aborting the ENTIRE vault
 *      export for everyone. Rejecting NUL at write is the primary fix; the
 *      export sink's per-file try/catch (portable-md.ts) is the belt for rows
 *      that predate this guard.
 *   2. **No `..` path segment** — traversal-shaped. Export guard-skips such a
 *      note (silently un-round-trippable) and it has no legitimate use as a
 *      vault note path.
 *
 * A `null`/empty-after-normalize path is fine — notes need no path. Reads /
 * queries never call this, so a lookup by a `..`/NUL path degrades to
 * not-found rather than throwing. The Store itself still trusts internal /
 * importer writes (mirrors the `validateExtension` split). Throws
 * `PathValidationError`.
 */
export function validatePath(path: unknown): void {
  if (path === null || path === undefined) return;
  if (typeof path !== "string") return; // non-string: not a path; caller's shape check owns it
  // NUL check on the RAW value — `normalizePath` strips NUL, so this must run
  // before normalization to actually reject rather than silently clean.
  if (path.includes("\0")) {
    throw new PathValidationError(path, "contains a NUL byte");
  }
  const normalized = normalizePath(path);
  if (normalized === null) return;
  if (normalized.split("/").some((seg) => seg === "..")) {
    throw new PathValidationError(path, "contains a '..' path segment (path traversal)");
  }
}

/**
 * Match bun:sqlite's UNIQUE-constraint error on the notes path index.
 * Post-vault#328 the unique index is composite `(path, extension)`, so
 * the message text is "UNIQUE constraint failed: notes.path,
 * notes.extension". Pre-v18 (legacy `(path)` index) emitted just
 * "notes.path". Match on the common prefix to cover both.
 */
function isPathUniqueError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("UNIQUE constraint failed: notes.path");
}

export function updateNote(
  db: Database,
  id: string,
  updates: {
    content?: string;
    /**
     * Atomic content append. Computed via SQL string concatenation
     * (`content = content || ?`), so two concurrent appends never
     * overwrite each other — the second simply lands after the first.
     * Mutually exclusive with `content`.
     */
    append?: string;
    /**
     * Atomic content prepend. Same SQL-level guarantee as `append`.
     * Mutually exclusive with `content`. May be combined with `append`
     * in a single call (both contributions land).
     */
    prepend?: string;
    path?: string;
    extension?: string;
    metadata?: Record<string, unknown>;
    created_at?: string;
    skipUpdatedAt?: boolean;
    /**
     * Write-attribution (vault#298). When set, the most-recent-write columns
     * `last_updated_by` / `last_updated_via` are bumped to this principal /
     * channel as part of the same UPDATE. Gated on the same condition as
     * `updated_at` — a `skipUpdatedAt` machine write doesn't claim authorship,
     * symmetric with not bumping the timestamp. `created_*` is never touched by
     * an update (it's set-once at create). Omitted → attribution left as-is.
     */
    actor?: string | null;
    via?: string | null;
    /**
     * Optimistic concurrency token. When provided, the UPDATE runs with an
     * additional `AND updated_at IS ?` clause; if no row is affected and the
     * note still exists, a `ConflictError` is thrown.
     */
    if_updated_at?: string;
    /**
     * Compare-and-set state transition (vault#299 Part B). Atomically: if the
     * named metadata field currently equals `from`, set it to `to` and commit;
     * otherwise throw `TransitionConflictError` (a missing field is a
     * conflict). The check rides the same conditional UPDATE — an additional
     * `AND json_extract(metadata,'$.<field>') IS ?` clause — so two racing
     * transitioners can't both pass. Combinable with `metadata` (other field
     * updates merge alongside the transition) and `if_updated_at` (both
     * preconditions must hold). `from`/`to` are JSON scalars (string / number /
     * boolean / null).
     */
    state_transition?: { field: string; from: unknown; to: unknown };
  },
): Note {
  if (updates.content !== undefined && (updates.append !== undefined || updates.prepend !== undefined)) {
    throw new Error(
      "update-note: `content` is mutually exclusive with `append`/`prepend`. Pick full-replace or additive — not both in the same call.",
    );
  }

  // Empty content is a valid state (vault#323) — see createNote. The
  // matching guard that used to reject updates clearing both content
  // and path has been removed.

  const sets: string[] = [];
  // `updated_at_ms` binds as a number (INTEGER column), so the value list
  // carries numbers alongside strings/nulls (vault#586).
  const values: (string | number | null)[] = [];

  // Hooks and other machine-level writers pass `skipUpdatedAt: true` so
  // their metadata markers don't look like user activity. See issue #44.
  if (!updates.skipUpdatedAt) {
    let now = new Date().toISOString();
    // OC contract: the new updated_at must be strictly greater than the
    // caller's if_updated_at so a subsequent OC reader can distinguish
    // pre- from post-update state. Without this, two writes landing in the
    // same wall-clock millisecond would produce identical timestamps and
    // let a second OC writer see the first writer's work as "unchanged."
    // Comparison is lexicographic on ISO 8601 strings — valid because
    // `.toISOString()` always emits fixed-width UTC (`...Z`).
    if (updates.if_updated_at !== undefined && now <= updates.if_updated_at) {
      now = new Date(new Date(updates.if_updated_at).getTime() + 1).toISOString();
    }
    sets.push("updated_at = ?");
    values.push(now);
    // `updated_at_ms` (vault#586) rides the SAME gate as `updated_at` — the
    // integer keyset-ordering mirror must move in lockstep with the string.
    // `now` is canonical `.toISOString()`, so `timestampToMs` never returns
    // null here; the fallback is belt-and-suspenders.
    sets.push("updated_at_ms = ?");
    values.push(timestampToMs(now) ?? Date.now());

    // Write-attribution (vault#298): the most-recent-write columns ride the
    // SAME gate as `updated_at`. A `skipUpdatedAt` machine write doesn't bump
    // the timestamp, so it doesn't claim authorship either. Set unconditionally
    // within this branch (even to NULL) so a write that arrives without
    // attribution honestly records "unknown author for the latest edit" rather
    // than leaving a stale prior principal — the latest writer wasn't them.
    sets.push("last_updated_by = ?");
    values.push(attrValue(updates.actor));
    sets.push("last_updated_via = ?");
    values.push(attrValue(updates.via));
  }

  if (updates.content !== undefined) {
    sets.push("content = ?");
    values.push(updates.content);
  }
  if (updates.append !== undefined || updates.prepend !== undefined) {
    // Atomic concat at the SQL layer. SQLite's `||` operator on the
    // existing `content` column means a concurrent reader-then-writer
    // race window is impossible: each `UPDATE` evaluates `content`
    // under the write lock, so two simultaneous appends both land
    // (in some order) instead of one clobbering the other.
    //
    // Frontmatter-aware prepend (#203): if the note opens with a YAML
    // frontmatter block (`---\n...\n---\n`), the prepend is injected
    // *after* the closing `---\n` so parsers that expect frontmatter
    // at byte 0 still find it. Detection uses `instr(content, '\n---\n')`
    // — the closing fence is whatever `\n---\n` appears after the
    // opening one. If no frontmatter is detected, prepend goes at
    // byte 0 as before. Atomicity is preserved: the entire transform
    // is one UPDATE expression evaluated under the write lock.
    sets.push(
      "content = CASE "
        + "WHEN substr(content, 1, 4) = '---' || char(10) "
        + "AND instr(content, char(10) || '---' || char(10)) > 0 "
        + "THEN substr(content, 1, instr(content, char(10) || '---' || char(10)) + 4) || ? "
        + "|| substr(content, instr(content, char(10) || '---' || char(10)) + 5) || ? "
        + "ELSE ? || content || ? "
        + "END",
    );
    const prependVal = updates.prepend ?? "";
    const appendVal = updates.append ?? "";
    values.push(prependVal, appendVal, prependVal, appendVal);
  }
  if (updates.path !== undefined) {
    sets.push("path = ?");
    values.push(normalizePath(updates.path));
  }
  if (updates.extension !== undefined) {
    // Allowed but documented as caller-owned (vault#328 edge case 1):
    // the Store accepts whatever the API surface validated, including
    // changing extension on a non-empty note. The caller is responsible
    // for content validity post-change.
    sets.push("extension = ?");
    values.push(updates.extension);
  }
  // State-transition (vault#299 Part B). The `to` value must land in the
  // metadata field. Two sub-cases keep the metadata write consistent:
  //   - caller ALSO passed `metadata` (the MCP/REST layer merges before
  //     calling): fold `to` into that object so the single `metadata = ?`
  //     SET carries it. The transition value wins over a merged value for
  //     the same field — the transition is the authoritative state write.
  //   - caller passed NO `metadata`: use SQL `json_set` so the field is
  //     updated in place without a read-merge-write (keeps it atomic).
  // The atomic GUARD (current value == from) is appended to the WHERE below.
  const st = updates.state_transition;
  if (st !== undefined && updates.metadata !== undefined) {
    (updates.metadata as Record<string, unknown>)[st.field] = st.to;
  }
  if (updates.metadata !== undefined) {
    sets.push("metadata = ?");
    values.push(JSON.stringify(updates.metadata));
  } else if (st !== undefined) {
    // No metadata payload — set the single field via json_set. The path is
    // bound as a parameter (mirrors the json_extract pattern elsewhere); the
    // value is bound as a JSON-typed argument via `json(?)` so booleans /
    // numbers / null land as their JSON types, not stringified text.
    sets.push(`metadata = json_set(COALESCE(metadata, '{}'), ?, json(?))`);
    values.push(`$.${jsonPathKey(st.field)}`, JSON.stringify(st.to));
  }
  if (updates.created_at !== undefined) {
    sets.push("created_at = ?");
    values.push(updates.created_at);
  }

  // No-op: no SET fields. If a caller still passed `if_updated_at` (and no
  // state_transition — that always pushes a metadata SET above), we
  // need to validate the precondition; a conditional UPDATE that sets
  // updated_at to itself does exactly that atomically — even a no-net-
  // change UPDATE takes the write lock in WAL mode, so it still serializes
  // with other writers. `RETURNING id` reports the row only when WHERE
  // matched — `.changes` is unreliable inside multi-statement transactions
  // (vault#261).
  if (sets.length === 0) {
    if (updates.if_updated_at !== undefined) {
      const probe = db.prepare(
        "UPDATE notes SET updated_at = updated_at WHERE id = ? AND updated_at IS ? RETURNING id",
      ).get(id, updates.if_updated_at) as { id: string } | null;
      if (probe === null) {
        throwConflictOrMissing(db, id, updates.if_updated_at);
      }
    }
    return getNote(db, id)!;
  }

  values.push(id);
  let sql = `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`;
  if (updates.if_updated_at !== undefined) {
    sql += " AND updated_at IS ?";
    values.push(updates.if_updated_at);
  }
  // State-transition guard (vault#299 Part B): the atomic compare. The UPDATE
  // only fires when the stored field currently equals `from`; otherwise zero
  // rows match and we raise TransitionConflictError below. `IS` (not `=`) so
  // a `from: null` correctly matches a stored JSON null / missing field, and
  // a non-null `from` never matches a NULL/missing field (= conflict).
  if (st !== undefined) {
    sql += ` AND json_extract(metadata, ?) IS json_extract(json(?), '$')`;
    values.push(`$.${jsonPathKey(st.field)}`, JSON.stringify(st.from));
  }

  // A value-conditional WHERE (if_updated_at OR state_transition) needs
  // RETURNING to distinguish "matched + updated" from "no match" — `.changes`
  // is unreliable inside transactions (vault#261).
  const conditional = updates.if_updated_at !== undefined || st !== undefined;
  let matched: { id: string } | null = null;
  try {
    if (conditional) {
      matched = db.prepare(`${sql} RETURNING id`).get(...values) as
        | { id: string }
        | null;
    } else {
      db.prepare(sql).run(...values);
    }
  } catch (err) {
    // Post-vault#328 the unique index is composite (path, extension), so
    // an extension-only update can also trip UNIQUE — widen the catch to
    // surface those as structured PATH_CONFLICT instead of a raw 500.
    if (isPathUniqueError(err)) {
      const conflictPath = updates.path !== undefined
        ? (normalizePath(updates.path) ?? updates.path)
        : ((db.prepare("SELECT path FROM notes WHERE id = ?").get(id) as { path: string | null } | null)?.path ?? "<unknown>");
      throw new PathConflictError(conflictPath);
    }
    throw err;
  }

  if (conditional && matched === null) {
    // No row matched. Disambiguate the cause, checking the if_updated_at
    // precondition first (it's the cheaper, pre-existing contract), then the
    // state-transition value, then not-found.
    const row = db.prepare("SELECT updated_at, path, metadata FROM notes WHERE id = ?").get(id) as
      | { updated_at: string | null; path: string | null; metadata: string | null }
      | null;
    if (!row) throw new Error(`Note not found: "${id}"`);
    if (updates.if_updated_at !== undefined && row.updated_at !== updates.if_updated_at) {
      throw new ConflictError(id, row.path, row.updated_at, updates.if_updated_at);
    }
    if (st !== undefined) {
      // if_updated_at (if any) matched, so the mismatch is the transition.
      let current: unknown;
      try {
        const meta = row.metadata ? JSON.parse(row.metadata) : {};
        current = (meta as Record<string, unknown>)[st.field];
      } catch {
        current = undefined;
      }
      throw new TransitionConflictError(id, row.path, st.field, st.from, st.to, current);
    }
    // if_updated_at-only path that fell through (timestamp matched but row
    // vanished mid-flight): preserve the prior contract.
    throwConflictOrMissing(db, id, updates.if_updated_at!);
  }

  return getNote(db, id)!;
}

/**
 * Build the dotted JSON-path key fragment for a metadata field name. Field
 * names that contain characters JSON-path treats specially (`.`, `[`, `"`,
 * etc.) are double-quoted; simple identifiers pass through bare. Mirrors the
 * SQLite JSON1 path grammar.
 */
function jsonPathKey(field: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return field;
  return `"${field.replace(/"/g, '\\"')}"`;
}

function throwConflictOrMissing(db: Database, id: string, expected: string): never {
  const row = db.prepare("SELECT updated_at, path FROM notes WHERE id = ?").get(id) as
    | { updated_at: string | null; path: string | null }
    | null;
  if (!row) {
    throw new Error(`Note not found: "${id}"`);
  }
  throw new ConflictError(id, row.path, row.updated_at, expected);
}

export function deleteNote(db: Database, id: string): void {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}

/**
 * Validate `limit`/`offset` before any query work (vault#550). A negative
 * `limit` used to leak SQLite's "negative LIMIT means unlimited" semantics
 * straight through to the caller — silently returning EVERYTHING when the
 * caller almost certainly meant "no limit I typed by mistake." A
 * non-numeric value (a bad MCP param type, or a REST caller that slipped
 * past `parseNotesQueryOpts`'s own stricter check) used to silently fall
 * back to the default via `typeof opts.limit === "number" ? opts.limit :
 * 100` below — also silent-wrong. This is the single choke point BOTH
 * transports funnel through (`store.queryNotes` / `store.queryNotesPaged`
 * call this via `queryNotes`), so REST and MCP get identical validation
 * for free.
 */
function validateLimitOffset(opts: QueryOpts): void {
  if (opts.limit !== undefined) {
    if (typeof opts.limit !== "number" || !Number.isFinite(opts.limit) || !Number.isInteger(opts.limit) || opts.limit < 0) {
      throw new QueryError(
        `invalid limit: ${JSON.stringify(opts.limit)} — must be a non-negative integer (a negative LIMIT silently means "unlimited" in SQLite semantics, which is almost never what was intended). Omit for the default of 50.`,
        "INVALID_QUERY",
        {
          error_type: "invalid_query",
          field: "limit",
          got: opts.limit,
          hint: "pass a non-negative integer, or omit for the default",
        },
      );
    }
  }
  if (opts.offset !== undefined) {
    if (typeof opts.offset !== "number" || !Number.isFinite(opts.offset) || !Number.isInteger(opts.offset) || opts.offset < 0) {
      throw new QueryError(
        `invalid offset: ${JSON.stringify(opts.offset)} — must be a non-negative integer.`,
        "INVALID_QUERY",
        {
          error_type: "invalid_query",
          field: "offset",
          got: opts.offset,
          hint: "pass a non-negative integer, or omit for the default of 0",
        },
      );
    }
  }
}

/**
 * Validate an ISO-8601 date-filter value before it's bound into a SQL
 * comparison (vault#550). `n.created_at` / `n.updated_at` are TEXT columns
 * compared lexicographically; an unparseable value used to bind straight
 * through and silently match "nothing" or "everything" depending on how it
 * happened to sort against real ISO strings, rather than erroring. Applies
 * uniformly to BOTH `dateFilter` (bracket-style REST / MCP `date_filter`)
 * and the legacy `dateFrom`/`dateTo` shorthand (MCP `date_from`/`date_to`,
 * still supported) — both flow through this same function, so both get the
 * same loud validation from one place.
 */
function validateIsoDateValue(field: string, value: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new QueryError(
      `invalid date value for "${field}": ${JSON.stringify(value)} — must be an ISO-8601 date/timestamp (e.g. "2026-07-09" or "2026-07-09T00:00:00.000Z").`,
      "INVALID_QUERY",
      {
        error_type: "invalid_query",
        field,
        got: value,
        hint: "pass an ISO-8601 date or timestamp",
      },
    );
  }
}

/**
 * Build the shared WHERE-clause conditions + bound params for the filter
 * surface both `queryNotes` and `aggregateNotes` apply: tag membership
 * (include/exclude/presence), link/broken-link presence, id-set scoping,
 * exact path / path-prefix / extension, write-attribution, metadata
 * (operator + plain-equality), and date range. Does NOT include the
 * cursor-keyset predicate, ORDER BY, or LIMIT/OFFSET — those are
 * query-shape concerns specific to `queryNotes`'s paginated-list contract
 * and don't apply to an aggregate rollup (which spans every matching row,
 * not a page of them). Extracted so aggregation reuses the EXACT filter
 * semantics a normal query applies, rather than risking the two drifting
 * apart.
 */
function buildFilterConditions(db: Database, opts: QueryOpts): { conditions: string[]; params: SQLQueryBindings[] } {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  // Include tags — "all" (default): must have ALL tags; "any": must have ANY tag.
  // The `_tagsExpanded` internal field carries per-input-tag descendant sets
  // when the tag-hierarchy resolver (see core/src/tag-hierarchy.ts) has
  // expanded the input — `tags: ["manual"]` becomes the set
  // `{manual, voice, text, ...}` per declared `_tags/*` config notes. Falls
  // back to `[opts.tags[i]]` (single-element set) when no expansion is set,
  // preserving the original semantics.
  //
  // Membership is expressed as a SEMIJOIN (`n.id IN (SELECT note_id ...)`),
  // not a `JOIN note_tags`. A JOIN multiplies rows when a note carries
  // several matching tags, which forced `SELECT DISTINCT n.*` — and that
  // DISTINCT materialized every candidate's FULL row (content included)
  // into a temp B-tree before LIMIT could apply, making large-tag queries
  // cost O(candidates × row size) regardless of limit. The IN-subquery
  // rides idx_note_tags_tag, produces each note id at most once, and lets
  // the whole query drop DISTINCT. See the 2026-06-10 perf measurements.
  if (opts.tags && opts.tags.length > 0) {
    // Canonical-bare-tag guard (vault#XXX) backstop for direct-core callers
    // that bypass BunSqliteStore.normalizeQueryTags (the store normalizes +
    // hierarchy-expands before reaching here; this protects the raw noteOps
    // entry point and tests). `_tagsExpanded`, when present, was already built
    // from bare names by the store, so prefer it; otherwise strip the literal
    // tags. No-op on already-bare input.
    const tagSets: string[][] = (opts as QueryOpts & { _tagsExpanded?: string[][] })._tagsExpanded
      ?? opts.tags.map((t) => [stripTagHash(t)]);
    const match = opts.tagMatch ?? "all";
    if (match === "any") {
      // Flatten all expanded sets and dedupe — a note tagged with any one
      // matches the input.
      const flat = Array.from(new Set(tagSets.flat()));
      if (flat.length > 0) {
        const placeholders = flat.map(() => "?").join(", ");
        conditions.push(`n.id IN (SELECT note_id FROM note_tags WHERE tag_name IN (${placeholders}))`);
        params.push(...flat);
      }
    } else {
      // "all": one membership clause per input tag, each accepting the
      // input or any descendant.
      for (const set of tagSets) {
        if (!set || set.length === 0) continue;
        const placeholders = set.map(() => "?").join(", ");
        conditions.push(`n.id IN (SELECT note_id FROM note_tags WHERE tag_name IN (${placeholders}))`);
        params.push(...set);
      }
    }
  }

  // Exclude tags — bare-tag guard backstop (see tags block above).
  if (opts.excludeTags && opts.excludeTags.length > 0) {
    for (const rawTag of opts.excludeTags) {
      const tag = stripTagHash(rawTag);
      if (tag === "") continue;
      conditions.push(`NOT EXISTS (SELECT 1 FROM note_tags ex WHERE ex.note_id = n.id AND ex.tag_name = ?)`);
      params.push(tag);
    }
  }

  // Presence: has_tags. When specific tags were already supplied, skip —
  // the existing join/condition already enforces that any result has tags.
  const filterByTags = Boolean(opts.tags && opts.tags.length > 0);
  if (opts.hasTags !== undefined && !filterByTags) {
    conditions.push(
      opts.hasTags
        ? `EXISTS (SELECT 1 FROM note_tags ht WHERE ht.note_id = n.id)`
        : `NOT EXISTS (SELECT 1 FROM note_tags ht WHERE ht.note_id = n.id)`,
    );
  }

  // Presence: has_links (either direction counts).
  if (opts.hasLinks !== undefined) {
    conditions.push(
      opts.hasLinks
        ? `EXISTS (SELECT 1 FROM links hl WHERE hl.source_id = n.id OR hl.target_id = n.id)`
        : `NOT EXISTS (SELECT 1 FROM links hl WHERE hl.source_id = n.id OR hl.target_id = n.id)`,
    );
  }

  // Presence: has_broken_links (vault#555) — a dangling outbound wikilink or
  // structured `links` target that never resolved. The `unresolved_wikilinks`
  // table is created lazily (see wikilinks.ts:ensureUnresolvedTable) only when
  // a link actually goes unresolved — a vault where nothing ever has won't
  // have the table at all. Check existence first rather than reference it
  // unconditionally: a read-only query filter shouldn't have the side effect
  // of creating a table, and a bare `EXISTS`/`NOT EXISTS` against a missing
  // table would throw "no such table" instead of the correct empty answer.
  if (opts.hasBrokenLinks !== undefined) {
    const unresolvedTableExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'unresolved_wikilinks'",
    ).get() !== null;
    if (!unresolvedTableExists) {
      // No table yet means no note has ever had a broken link:
      // hasBrokenLinks:true matches nothing; hasBrokenLinks:false is a
      // no-op (every note already qualifies) — add no condition at all.
      if (opts.hasBrokenLinks) conditions.push("0 = 1");
    } else {
      conditions.push(
        opts.hasBrokenLinks
          ? `EXISTS (SELECT 1 FROM unresolved_wikilinks ubl WHERE ubl.source_id = n.id)`
          : `NOT EXISTS (SELECT 1 FROM unresolved_wikilinks ubl WHERE ubl.source_id = n.id)`,
      );
    }
  }

  // ID set filter — used by `near` to push neighborhood scoping into SQL so
  // that LIMIT applies to the neighborhood, not the whole notes table.
  if (opts.ids !== undefined) {
    if (opts.ids.length === 0) {
      // Caller asked for "in this empty set" — no rows match. Short-circuit
      // with an always-false condition; building `IN ()` would be a SQL error.
      conditions.push("0 = 1");
    } else {
      // Bind the id-set as ONE json_each param, not one `?` per id: this IN is
      // embedded in a paginated statement (shared ORDER BY / LIMIT / OFFSET),
      // so it can't be chunked, and `near` neighborhoods routinely exceed the
      // DO 100-bound-param cap. json_each keeps the whole set at a single
      // bound param. See sql-in.ts.
      conditions.push(`n.id IN ${IN_VIA_JSON_EACH}`);
      params.push(jsonEachParam(opts.ids));
    }
  }

  // Exact path match (case-insensitive)
  if (opts.path) {
    conditions.push("n.path = ? COLLATE NOCASE");
    params.push(opts.path);
  }

  // Path prefix
  if (opts.pathPrefix) {
    conditions.push("n.path LIKE ?");
    params.push(opts.pathPrefix + "%");
  }

  // Extension filter (vault#328). Single string → exact match; array → IN
  // clause. Compared lower-case so a caller passing "CSV" still hits rows
  // stored as "csv". An empty array is a no-op (no filter applied) rather
  // than a "no rows match" short-circuit — matches the spirit of the
  // existing `tags: []` behavior.
  if (opts.extension !== undefined) {
    const exts = Array.isArray(opts.extension) ? opts.extension : [opts.extension];
    const cleaned = exts
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .map((e) => e.toLowerCase());
    if (cleaned.length === 1) {
      conditions.push("LOWER(n.extension) = ?");
      params.push(cleaned[0]!);
    } else if (cleaned.length > 1) {
      const placeholders = cleaned.map(() => "?").join(", ");
      conditions.push(`LOWER(n.extension) IN (${placeholders})`);
      params.push(...cleaned);
    }
  }

  // Write-attribution filters (vault#298). Exact match on the indexed
  // attribution columns. Each rides its own B-tree (idx_notes_<col>), so
  // "everything Mathilda wrote" / "everything via the meeting-ingest surface"
  // is a seek, not a scan. NULL columns never match a non-null filter value
  // (SQL `=` is unknown against NULL), so legacy/unattributed rows are
  // correctly excluded from an attribution query.
  if (opts.createdBy !== undefined) {
    conditions.push("n.created_by = ?");
    params.push(opts.createdBy);
  }
  if (opts.lastUpdatedBy !== undefined) {
    conditions.push("n.last_updated_by = ?");
    params.push(opts.lastUpdatedBy);
  }
  if (opts.createdVia !== undefined) {
    conditions.push("n.created_via = ?");
    params.push(opts.createdVia);
  }
  if (opts.lastUpdatedVia !== undefined) {
    conditions.push("n.last_updated_via = ?");
    params.push(opts.lastUpdatedVia);
  }

  // Metadata filters — operator objects route through the indexed generated
  // column (fast, loud errors on non-indexed fields); primitives keep the
  // existing JSON-scan exact-match behavior for backcompat.
  //
  // Plain-equality fast path (2026-06-10 perf measurements): when the field
  // happens to be indexed, a plain `{field: value}` equality used to pay the
  // same full-table json_extract scan as a non-indexed field — 280× slower
  // than the operator form `{field: {eq: value}}` ON THE SAME column. We now
  // prepend an indexed-prefilter conjunct (`"meta_<field>" = ?`) so the
  // B-tree narrows the candidates, while KEEPING the original json_extract
  // clause as a residual predicate. The conjunction is result-identical to
  // the scan by construction: any row the scan matches also satisfies the
  // prefilter (the generated column is the same json_extract under the
  // column's type affinity), and rows where the affinity-converted column
  // matches but the raw extraction doesn't (e.g. JSON number 5 vs query
  // string "5") are excluded by the residual — exactly as the scan excluded
  // them. Pinned by query-plain-eq-routing.test.ts.
  if (opts.metadata) {
    for (const [key, value] of Object.entries(opts.metadata)) {
      if (isOperatorObject(value)) {
        requireIndexedField(db, key);
        const { sql, params: opParams } = buildOperatorClause(
          key,
          value as Record<string, unknown>,
        );
        conditions.push(sql);
        params.push(...opParams);
      } else {
        const bound = typeof value === "string" ? value : JSON.stringify(value);
        // `getIndexedField` returning a row proves `key` was validated by
        // FIELD_NAME_RE at declaration time, so interpolating the column
        // name is safe — same justification as buildOperatorClause.
        if (getIndexedField(db, key)) {
          conditions.push(`("meta_${key}" = ? AND json_extract(n.metadata, '$.' || ?) = ?)`);
          params.push(bound, key, bound);
        } else {
          conditions.push(`json_extract(n.metadata, '$.' || ?) = ?`);
          params.push(key, bound);
        }
      }
    }
  }

  // Date range. Two accepted shapes:
  //   - Legacy `dateFrom` / `dateTo` — always filters on `n.created_at`
  //     (vault ingestion time).
  //   - Generalized `dateFilter: { field, from, to }` — filters on the
  //     named field. `created_at` (default) and `updated_at` map to the
  //     real columns on `notes`; any other field must be declared
  //     `indexed: true` so the SQL targets a real B-tree index. The two
  //     shapes are mutually exclusive — the combination would silently
  //     AND, which would be surprising.
  //
  // `updated_at` enables incremental-rebuild flows (vault#285 1.5): an
  // SSG or syncer asks "what changed since my last build" via
  // `dateFilter: { field: "updated_at", from: lastBuildISO }`. There's
  // no B-tree on `updated_at` today; a sequential scan is acceptable up
  // to ~tens of thousands of notes. Add an index if the scan ever shows
  // up in a real workload.
  const hasLegacyDate = opts.dateFrom !== undefined || opts.dateTo !== undefined;
  const hasDateFilter = opts.dateFilter !== undefined;
  if (hasLegacyDate && hasDateFilter) {
    throw new QueryError(
      `cannot combine top-level date_from/date_to with date_filter — pass one or the other`,
      "INVALID_QUERY",
    );
  }
  if (hasDateFilter) {
    const filter = opts.dateFilter!;
    const field = filter.field ?? "created_at";
    let column: string;
    if (field === "created_at") {
      column = "n.created_at";
    } else if (field === "updated_at") {
      // NOTE (vault#586 follow-up): this range filter compares the TEXT
      // `updated_at`, which is inconsistent on non-canonical rows the same way
      // the cursor keyset was pre-v26. Cursor pagination moved to the integer
      // `updated_at_ms` column; `date_filter`/`order_by`/export `--since` still
      // read the string and are tracked separately. Behavior unchanged here.
      column = "n.updated_at";
    } else {
      // Re-uses the same indexed-field gate as `metadata` operator queries
      // and `orderBy` so the error message and contract are consistent.
      requireIndexedField(db, field);
      column = `"meta_${field}"`;
    }
    if (filter.from !== undefined) {
      validateIsoDateValue(field === "created_at" ? "date_filter.from" : `date_filter.from (${field})`, filter.from);
      conditions.push(`${column} >= ?`);
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      validateIsoDateValue(field === "created_at" ? "date_filter.to" : `date_filter.to (${field})`, filter.to);
      conditions.push(`${column} < ?`);
      params.push(filter.to);
    }
  } else if (hasLegacyDate) {
    if (opts.dateFrom) {
      validateIsoDateValue("date_from", opts.dateFrom);
      conditions.push("n.created_at >= ?");
      params.push(opts.dateFrom);
    }
    if (opts.dateTo) {
      validateIsoDateValue("date_to", opts.dateTo);
      conditions.push("n.created_at < ?");
      params.push(opts.dateTo);
    }
  }

  return { conditions, params };
}

/**
 * `_outUpdatedAtMs` (internal, vault#586) — when supplied, the phase-1 page
 * query writes each returned id's integer `updated_at_ms` keyset key into it.
 * Only `queryNotesPaged` passes it, to derive the cursor watermark from the
 * SAME statement that determined page membership + order (one consistent
 * snapshot — see the call site). Ordinary callers omit it and are unaffected;
 * it never touches the returned `Note` shape.
 */
export function queryNotes(db: Database, opts: QueryOpts, _outUpdatedAtMs?: Map<string, number>): Note[] {
  validateLimitOffset(opts);
  const { conditions, params } = buildFilterConditions(db, opts);

  // ---- Cursor predicate (vault#313; keyset column vault#586) ----
  //
  // Cursor mode is keyed on PRESENCE of `opts.cursor`, not truthiness
  // (vault#550 bootstrap fix). `cursor: ""` is the bootstrap call — "I want
  // to paginate, I don't have a watermark yet" — and must still force the
  // keyset ORDER BY below so the FIRST page is taken in the same order
  // subsequent pages will be. `opts.cursor === undefined` is the only way
  // to opt OUT of cursor mode entirely (the legacy flat-array shape).
  // Before this fix, `if (opts.cursor)` treated an empty string exactly
  // like "no cursor" — the caller's bootstrap intent silently vanished and
  // the first page came back in `created_at` order instead of the
  // keyset order the SECOND page (a real cursor) would use,
  // so naive "did I see this note already" comparisons could skip or
  // duplicate rows across the boundary.
  //
  // The keyset orders on the integer `n.updated_at_ms` column (vault#586),
  // NOT the TEXT `n.updated_at`. That column is the single source of truth
  // for cursor ordering: walk-order, the boundary predicate below, and the
  // watermark in `queryNotesPaged` all read the SAME integer, so they can't
  // diverge the way three separate readings of `updated_at` did on
  // aged/imported vaults whose timestamps aren't canonical `.toISOString()`
  // (space-form / offset / no-`Z`) — under which TEXT-lex order, an ISO
  // boundary string, and a `Date.parse` watermark disagreed and silently
  // skipped or re-delivered rows.
  //
  // When a REAL (non-empty) cursor is present, decode it, verify its
  // query_hash matches the current query, and add a keyset predicate of
  // the form:
  //
  //   (updated_at_ms > last_updated_at)
  //     OR (updated_at_ms = last_updated_at AND id > last_id)
  //
  // The cursor payload's `last_updated_at` is ALREADY a millisecond epoch
  // (see cursor.ts) — the same units as the column — so it binds directly
  // with no ISO round-trip. This is also why existing client cursors keep
  // working unchanged across the upgrade: the encoded watermark was always
  // ms. The cursor forces ORDER BY n.updated_at_ms ASC, n.id ASC so the
  // watermark math is sound — paginating by update time while ordering by
  // created_at would skip rows whose update differs from their creation.
  // `orderBy` and `sort: "desc"` are mutually exclusive with cursor mode (a
  // "since last checked" loop wants ascending update order, full stop); we
  // reject with INVALID_QUERY so callers don't silently get a broken
  // iteration.
  const cursorMode = opts.cursor !== undefined;
  let cursorPayload: CursorPayload | null = null;
  if (cursorMode) {
    if (opts.orderBy) {
      throw new QueryError(
        `cursor and order_by are mutually exclusive — cursor pagination forces order by updated_at`,
        "INVALID_QUERY",
      );
    }
    if (opts.sort === "desc") {
      throw new QueryError(
        `cursor pagination requires ascending sort by updated_at — descending sort with a cursor would skip newly-written rows`,
        "INVALID_QUERY",
      );
    }
    if (opts.cursor !== "") {
      cursorPayload = decodeCursor(opts.cursor!);
      const expectedHash = computeQueryHash(toQueryHashInputs(opts));
      if (cursorPayload.query_hash !== expectedHash) {
        throw new CursorError(
          `cursor was minted for a different query — drop the cursor and restart iteration`,
          "cursor_query_mismatch",
        );
      }
      // The cursor's `last_updated_at` is a millisecond epoch (cursor.ts) —
      // the SAME units as the integer `n.updated_at_ms` column — so it binds
      // straight into the keyset predicate with no ISO round-trip. Ordering
      // and boundary now read one numeric column, so heterogeneous /
      // non-canonical `updated_at` TEXT (space-form, offset, no-`Z`) can no
      // longer make the walk and the watermark disagree.
      const cursorMs = cursorPayload.last_updated_at;
      conditions.push(
        "(n.updated_at_ms > ? OR (n.updated_at_ms = ? AND n.id > ?))",
      );
      params.push(cursorMs, cursorMs, cursorPayload.last_id);
    }
    // else: bootstrap call (`cursor === ""`) — no watermark yet, no
    // predicate to add, but the ORDER BY below still switches to the
    // keyset order so this first page is consistent with every page after
    // it.
  }

  const direction = opts.sort === "desc" ? "DESC" : "ASC";
  let orderBy: string;
  if (cursorMode) {
    // Cursor mode forces a deterministic keyset order on the integer
    // `updated_at_ms` column (vault#586), matching the boundary predicate
    // above and the `idx_notes_updated_ms` index. `id` is the tiebreaker —
    // without it, two notes sharing an `updated_at_ms` would be at the mercy
    // of SQLite's row order and the next page could miss or duplicate one.
    orderBy = "n.updated_at_ms ASC, n.id ASC";
  } else if (opts.orderBy === "link_count") {
    // `link_count` is a pseudo-field — like `created_at`/`updated_at` in the
    // dateFilter block above, it bypasses `requireIndexedField` (it's not a
    // metadata column). Sort by link DEGREE using the SAME directional-sum
    // definition as the `linkCount` response field (see `getLinkCounts` in
    // links.ts): two correlated COUNT subqueries summed. This MUST stay a
    // sum of two directional counts — a single
    // `COUNT(*) ... WHERE source_id=n.id OR target_id=n.id` would count a
    // self-loop ONCE (degree 1) and DIVERGE from the field's degree-2. Both
    // subqueries ride the existing `idx_links_source` / `idx_links_target`
    // B-trees. `created_at` stays the stable tiebreaker.
    //
    // Always the both-directions degree — inbound-only ordering is a future
    // extension and is not built here.
    //
    // Perf caveat: these are correlated subqueries, evaluated once per
    // candidate row. At small-to-moderate vault sizes (tens of thousands of
    // notes) that's fine — each subquery is an O(log n) index probe. At very
    // large vault sizes the per-row scan cost grows; the upgrade path is a
    // maintained `link_count` counter column on `notes`, incremented in
    // `createLink` and decremented in `deleteLink`, then ordered directly.
    // NOT built now — flagged so a future contributor sees the lever.
    orderBy =
      `((SELECT COUNT(*) FROM links WHERE source_id = n.id) ` +
      `+ (SELECT COUNT(*) FROM links WHERE target_id = n.id)) ${direction}, ` +
      `n.created_at ${direction}`;
  } else if (opts.orderBy) {
    requireIndexedField(db, opts.orderBy);
    // `orderBy` came from indexed_fields (validated on declaration), so
    // the column name is safe to interpolate. Append created_at as a
    // stable tiebreaker so two rows with the same indexed value have a
    // deterministic order.
    orderBy = `"meta_${opts.orderBy}" ${direction}, n.created_at ${direction}, n.id ${direction}`;
  } else {
    // id tiebreaker: same-millisecond inserts get deterministic relative
    // order — load-bearing now that the two-phase page fetch makes
    // pagination ordering the contract (#485 review nit).
    orderBy = `n.created_at ${direction}, n.id ${direction}`;
  }
  const limit = typeof opts.limit === "number" ? opts.limit : 100;
  const offset = typeof opts.offset === "number" ? opts.offset : 0;

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Two-phase "deferred join" page fetch (2026-06-10 perf measurements).
  //
  // Phase 1 selects ONLY `n.id` — the ORDER BY temp B-tree (when one is
  // needed) holds narrow id/sort-key entries instead of full note rows, so
  // sort/materialization cost no longer scales with content size. With the
  // tag semijoin above there is no row multiplication, so no DISTINCT.
  //
  // Phase 2 fetches full rows for just the page (≤ limit ids) and re-orders
  // to the phase-1 order; tags are hydrated in ONE batched query instead of
  // one query per returned note.
  // Phase 1 also selects `n.updated_at_ms` (vault#586) so a paging caller can
  // read the keyset key from the SAME statement that applied the keyset order
  // — the watermark then comes from one consistent snapshot, immune to a
  // cross-process writer bumping a page row's ms between two separate reads.
  const idSql = `
    SELECT n.id, n.updated_at_ms FROM notes n
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const idRows = db.prepare(idSql).all(...params) as { id: string; updated_at_ms: number | null }[];
  if (_outUpdatedAtMs) {
    for (const r of idRows) {
      if (r.updated_at_ms !== null && r.updated_at_ms !== undefined) {
        _outUpdatedAtMs.set(r.id, r.updated_at_ms);
      }
    }
  }
  return fetchNotesByIdsOrdered(db, idRows.map((r) => r.id));
}

/**
 * Aggregation / rollup query (top new-feature ask from a UX round — see
 * `QueryOpts.aggregate` / `AggregateSpec` in types.ts). Applies the SAME
 * filter surface `queryNotes` does — via the shared `buildFilterConditions`:
 * tags, exclude-tags, presence filters, `ids`, path/extension, write-
 * attribution, metadata, date range — BEFORE grouping, so aggregating over a
 * filtered query rolls up exactly the notes that query would have listed.
 *
 * Tag-scope is NOT enforced here — core stays scope-unaware, same division
 * every other core query surface keeps. A tag-scoped caller narrows via
 * `opts.ids` to a pre-computed visible-note-id set (see `src/mcp-tools.ts`'s
 * `aggregateVisibility` wiring for MCP and `src/routes.ts`'s REST aggregate
 * branch — both filter to visible notes FIRST, then pass the resulting ids
 * in here, exactly like a normal query's `near` neighborhood scoping does).
 *
 * `group_by: "tag"` groups by tag MEMBERSHIP, not partition: implemented as
 * a JOIN against `note_tags`, so a note carrying N of the tags present in
 * the filtered result set contributes to N separate group rows (the
 * existing filter conditions, which reference `n.*`, compose unchanged
 * against the join). Any other `group_by` value must be a declared
 * `indexed: true` metadata field — reuses `requireIndexedField`, the same
 * FIELD_NOT_INDEXED contract `metadata` operator queries and `order_by`
 * use — and groups by its generated `meta_<field>` column.
 *
 * `op: "sum"` requires `field` — another indexed field whose declared
 * storage type is `INTEGER` (the only indexable numeric shape; a bare
 * `type: "number"` schema field is never indexed — see
 * `indexed-fields.ts`'s `TYPE_MAP` — and a `TEXT`-backed field can't be
 * summed). `op: "count"` ignores `field`.
 *
 * A note whose group_by value is absent/null collects into one
 * `{group: null, ...}` row — standard SQL `GROUP BY` behavior, not silently
 * dropped.
 */
export function aggregateNotes(db: Database, opts: QueryOpts): AggregateRow[] {
  const spec = opts.aggregate;
  if (!spec) {
    throw new QueryError(
      `aggregateNotes requires opts.aggregate`,
      "INVALID_QUERY",
      {
        error_type: "invalid_query",
        field: "aggregate",
        hint: `pass { group_by, op } — group_by is an indexed metadata field or "tag"; op is "count" or "sum"`,
      },
    );
  }
  if (typeof spec.group_by !== "string" || spec.group_by.length === 0) {
    throw new QueryError(
      `aggregate.group_by is required — an indexed metadata field name, or "tag"`,
      "INVALID_QUERY",
      {
        error_type: "invalid_query",
        field: "aggregate.group_by",
        got: spec.group_by,
        hint: `pass an indexed metadata field name, or "tag"`,
      },
    );
  }
  if (spec.op !== "count" && spec.op !== "sum") {
    throw new QueryError(
      `invalid aggregate.op: ${JSON.stringify(spec.op)} — must be "count" or "sum"`,
      "INVALID_QUERY",
      { error_type: "invalid_query", field: "aggregate.op", got: spec.op, hint: `pass "count" or "sum"` },
    );
  }
  if (spec.op === "sum" && (typeof spec.field !== "string" || spec.field.length === 0)) {
    throw new QueryError(
      `aggregate.field is required when aggregate.op is "sum"`,
      "INVALID_QUERY",
      {
        error_type: "invalid_query",
        field: "aggregate.field",
        hint: "pass the indexed numeric metadata field to sum",
      },
    );
  }

  const { conditions, params } = buildFilterConditions(db, opts);

  const groupByTag = spec.group_by === "tag";
  let groupExpr: string;
  let fromClause: string;
  if (groupByTag) {
    groupExpr = "nt.tag_name";
    fromClause = "FROM notes n JOIN note_tags nt ON nt.note_id = n.id";
  } else {
    // `group_by` came from indexed_fields (validated via FIELD_NAME_RE at
    // declaration time), so interpolating the column name is safe — same
    // justification `orderBy`/`buildOperatorClause` use.
    requireIndexedField(db, spec.group_by);
    groupExpr = `"meta_${spec.group_by}"`;
    fromClause = "FROM notes n";
  }

  let valueExpr: string;
  if (spec.op === "count") {
    valueExpr = "COUNT(*)";
  } else {
    const fieldInfo = requireIndexedField(db, spec.field!);
    if (fieldInfo.sqliteType !== "INTEGER") {
      throw new QueryError(
        `aggregate.field "${spec.field}" is not numeric (declared sqlite type ${fieldInfo.sqliteType}) — "sum" requires a field declared type: "integer" or "boolean" in its tag schema`,
        "INVALID_QUERY",
        {
          error_type: "invalid_query",
          field: "aggregate.field",
          got: spec.field,
          hint: `sum requires a numeric indexed field (type: "integer"/"boolean"); "${spec.field}" is declared a non-numeric type`,
        },
      );
    }
    valueExpr = `SUM("meta_${spec.field}")`;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT ${groupExpr} AS group_key, ${valueExpr} AS value
    ${fromClause}
    ${whereClause}
    GROUP BY ${groupExpr}
    ORDER BY ${groupExpr}
  `;
  const rows = db.prepare(sql).all(...params) as { group_key: string | number | null; value: number | null }[];
  return rows.map((r) => ({ group: r.group_key, value: r.value ?? 0 }));
}

/**
 * Fetch full note rows for `ids`, preserving the input order, with tags
 * hydrated via ONE batched query per chunk (not one per note). Ids not
 * found (deleted between phases) are silently dropped.
 */
function fetchNotesByIdsOrdered(db: Database, ids: string[]): Note[] {
  if (ids.length === 0) return [];
  const rowsById = new Map<string, NoteRow>();
  // Chunk under the DO 100-bound-param cap (see sql-in.ts) — a single export
  // page (EXPORT_BATCH_SIZE=500) or a large query result exceeds it otherwise.
  for (const chunk of chunkForInClause(ids)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.prepare(
      `SELECT * FROM notes WHERE id IN (${placeholders})`,
    ).all(...chunk) as NoteRow[];
    for (const row of rows) rowsById.set(row.id, row);
  }
  const notes: Note[] = [];
  for (const id of ids) {
    const row = rowsById.get(id);
    if (row) notes.push(rowToNote(row));
  }
  const tagsById = getNoteTagsForNotes(db, notes.map((n) => n.id));
  for (const note of notes) note.tags = tagsById.get(note.id) ?? [];
  return notes;
}

/**
 * Batched tag lookup: tags for many notes in one IN-list query per chunk.
 * Per-note arrays are sorted by tag_name — identical to `getNoteTags`.
 * Every requested id is present in the map (empty array when untagged).
 */
export function getNoteTagsForNotes(db: Database, noteIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (noteIds.length === 0) return map;
  const ids = [...new Set(noteIds)];
  for (const id of ids) map.set(id, []);
  // Chunk under the DO 100-bound-param cap (see sql-in.ts).
  for (const chunk of chunkForInClause(ids)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.prepare(
      `SELECT note_id, tag_name FROM note_tags WHERE note_id IN (${placeholders}) ORDER BY tag_name`,
    ).all(...chunk) as { note_id: string; tag_name: string }[];
    for (const row of rows) map.get(row.note_id)!.push(row.tag_name);
  }
  return map;
}

/**
 * Extract the result-set-affecting subset of `QueryOpts` for cursor hashing.
 *
 * `cursor`, `limit`, `offset`, `_tagsExpanded` (internal cache key) are
 * excluded — they don't change which rows match, just how many or how
 * the iteration advances. See `core/src/cursor.ts` for the rationale.
 */
function toQueryHashInputs(opts: QueryOpts): QueryHashInputs {
  return {
    tags: opts.tags,
    tagMatch: opts.tagMatch,
    excludeTags: opts.excludeTags,
    hasTags: opts.hasTags,
    hasLinks: opts.hasLinks,
    hasBrokenLinks: opts.hasBrokenLinks,
    path: opts.path,
    pathPrefix: opts.pathPrefix,
    extension: opts.extension,
    ids: opts.ids,
    metadata: opts.metadata,
    createdBy: opts.createdBy,
    lastUpdatedBy: opts.lastUpdatedBy,
    createdVia: opts.createdVia,
    lastUpdatedVia: opts.lastUpdatedVia,
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
    dateFilter: opts.dateFilter,
    sort: opts.sort,
    orderBy: opts.orderBy,
  };
}

/**
 * Cursor-paginated wrapper around `queryNotes` (vault#313).
 *
 * Always returns `{ notes, next_cursor }`. `next_cursor` advances even on
 * an empty result page — the caller can persist a single watermark and
 * keep polling without special-casing the empty-page condition. The
 * empty-page cursor's `last_updated_at` is the larger of:
 *   - the prior cursor's `last_updated_at` (when `opts.cursor` was set), or
 *   - the prior cursor's `last_updated_at` (defaults to 0 when not).
 *
 * Holding the watermark at the prior value on an empty page is the
 * conservative choice: if a note is written between this call and the
 * next at a timestamp BEFORE wall-clock-now (clock skew, batch import
 * with explicit `created_at`), advancing the watermark to `now()` would
 * skip it. The watermark advances only when actual rows are returned.
 *
 * First-call semantics (`opts.cursor` absent): query_hash is computed
 * from the result-set-affecting opts and bound into the minted cursor.
 * If zero rows match, the returned cursor encodes
 * `last_updated_at = 0, last_id = ""` so the next call returns
 * everything written since (the keyset predicate
 * `updated_at > 0 OR (updated_at = 0 AND id > "")` matches every row
 * with a non-null `updated_at` greater than the unix epoch).
 */
export function queryNotesPaged(db: Database, opts: QueryOpts): QueryNotesPage {
  // Capture each page row's integer keyset key (vault#586) from the SAME
  // phase-1 statement that ordered + sliced the page — one consistent
  // snapshot, so the watermark can't leapfrog rows a cross-process writer
  // bumps between reads. This replaces a separate post-query round-trip.
  const updatedAtMsById = new Map<string, number>();
  const notes = queryNotes(db, opts, updatedAtMsById);
  const queryHash = computeQueryHash(toQueryHashInputs(opts));

  // Watermark math: pick the larger of (last returned row, prior cursor
  // watermark, sentinel). When the page is empty, fall back to the prior
  // cursor's watermark — see the JSDoc rationale above.
  let lastUpdatedAt = 0;
  let lastId = "";
  // `opts.cursor === ""` is the bootstrap call (vault#550) — there's no
  // prior watermark to decode, so it takes the same 0/"" sentinel path as
  // `opts.cursor === undefined`. Only a REAL (non-empty) cursor gets
  // re-decoded here.
  if (opts.cursor !== undefined && opts.cursor !== "") {
    // Re-decode (we already validated in queryNotes); this is cheap.
    const prior = decodeCursor(opts.cursor);
    lastUpdatedAt = prior.last_updated_at;
    lastId = prior.last_id;
  }
  if (notes.length > 0) {
    // Advance the watermark to the page's MAX (updated_at_ms, id) using the
    // keyset keys captured in the phase-1 snapshot above (vault#586) — the
    // SAME integer `updated_at_ms` the walk-order used, from the SAME read.
    // Using the snapshot, rather than re-deriving ms from each note's
    // `updatedAt` string or re-reading the column, is what keeps walk-order
    // and watermark from diverging: a row whose backfilled column and
    // non-canonical `updated_at` TEXT disagree would otherwise re-parse to a
    // different ms here and skip or re-deliver at the boundary. No throw — a
    // NULL key (shouldn't occur post-migrateToV26) reads as 0. When a cursor
    // is in effect the SQL already returns rows in (updated_at_ms, id) order
    // so the last row IS the max; the explicit max also covers the
    // created_at-ordered no-cursor path.
    for (const note of notes) {
      const ms = updatedAtMsById.get(note.id) ?? 0;
      if (ms > lastUpdatedAt || (ms === lastUpdatedAt && note.id > lastId)) {
        lastUpdatedAt = ms;
        lastId = note.id;
      }
    }
  }

  const next_cursor = encodeCursor({
    v: CURSOR_VERSION,
    last_updated_at: lastUpdatedAt,
    last_id: lastId,
    query_hash: queryHash,
  });

  return { notes, next_cursor };
}

/**
 * Turn a thrown FTS5 MATCH error into the structured `invalid_search_syntax`
 * shape (vault#551, WS2A item 2). ALWAYS structured, never a raw rethrow —
 * a raw `SQLiteError` escaping to the transport is an unstructured 500
 * (REST) / generic `isError` text (MCP), which is exactly the swallowed-
 * failure class this wave is closing.
 *
 * The two modes carry different hints:
 *   - advanced: the caller passed raw FTS5 syntax that FTS5 rejected — tell
 *     them to fix it or drop back to literal.
 *   - literal: escaping + control-char sanitization
 *     (`buildLiteralSearchQuery`) make every input syntactically valid
 *     FTS5, so this is unreachable by construction — the belt-and-suspenders
 *     structured error (rather than a raw rethrow) means that IF the
 *     invariant is ever broken it still surfaces as an honest error, not a
 *     500. Signals a vault bug worth reporting.
 */
/**
 * FTS5's own error text for a syntax mistake is written for someone who
 * already knows FTS5's grammar — "no such column: espresso" for a bare
 * leading `-espresso` (NOT with no left-hand term — FTS5's `-`/`NOT` is a
 * BINARY operator, so a lone `-token` with nothing before it gets
 * misparsed as `column:term` filter syntax and fails looking for a column
 * named after the token) is confusing/leaky rather than actionable: it
 * reads as if a column literally named "espresso" was expected, which
 * exposes FTS5-internal parsing behavior instead of explaining the actual
 * mistake (vault#551 WS2B item 4 — interim harness finding). Detected
 * generically off the FTS5 error text (`/no such column:/i`) rather than
 * re-parsing the query ourselves, since the SAME message also covers the
 * other real cause (an explicit `column:term` filter naming a column that
 * isn't one of `notes_fts`'s declared columns, `path`/`content`) — the hint
 * below covers both without claiming to know which one happened.
 */
function advancedModeColumnHint(causeMessage: string): string | null {
  if (!/no such column:/i.test(causeMessage)) return null;
  return (
    `FTS5 read part of this query as column-filter syntax ("column:term") or as a ` +
    `leading "-" with no term to its left — NOT/"-" is a BINARY operator in FTS5 ` +
    `("good -bad", not "-bad" alone). Indexed columns are "path" and "content". ` +
    `Add a preceding positive term before a NOT, quote the phrase to search it ` +
    `literally, or use search_mode:"literal" (the default) to skip advanced syntax entirely.`
  );
}

function searchSyntaxError(rawQuery: string, err: unknown, mode: SearchMode): QueryError {
  const causeMessage = err instanceof Error ? err.message : String(err);
  const columnHint = mode === "advanced" ? advancedModeColumnHint(causeMessage) : null;
  const hint =
    columnHint ??
    (mode === "advanced"
      ? `FTS5 rejected this as advanced query syntax (${causeMessage}). Fix the syntax, or omit search_mode:"advanced" for literal (punctuation-safe) search.`
      : `FTS5 rejected the escaped literal query (${causeMessage}) — this should be impossible after literal-mode escaping + control-char sanitization; please report it as a vault bug.`);
  return new QueryError(`invalid search syntax: ${causeMessage}`, "INVALID_QUERY", {
    error_type: "invalid_search_syntax",
    field: "search",
    got: rawQuery,
    hint,
  });
}

export function searchNotes(
  db: Database,
  query: string,
  opts?: { tags?: string[]; limit?: number; mode?: SearchMode; sort?: "asc" | "desc" },
): Note[] {
  const limit = typeof opts?.limit === "number" ? opts.limit : 50;
  // Literal-by-default (vault#551): escape the caller's text so FTS5's own
  // query syntax (hyphen = NOT, apostrophe/period = tokenizer breakage,
  // etc.) is treated as ordinary content, not syntax. `search_mode:
  // "advanced"` opts back into raw FTS5 query syntax — today's pre-#551
  // behavior, unchanged — for callers who want boolean/phrase/prefix
  // operators.
  const mode: SearchMode = opts?.mode ?? "literal";
  let ftsQuery: string;
  if (mode === "literal") {
    const built = buildLiteralSearchQuery(query);
    // "Only whitespace/quotes" (vault#551 edge case): the caller (store.ts /
    // the REST + MCP entry points) is expected to short-circuit this case
    // itself (with an `empty_search` warning) before ever reaching here —
    // this is a defensive fallback for any direct-core caller that skips
    // that check.
    if (built.isEmpty) return [];
    ftsQuery = built.query;
  } else {
    ftsQuery = query;
  }

  // Weighted bm25 relevance expression (vault#551 WS2C, schema v25):
  // `notes_fts` now indexes `path` (title, column 0) then `content` (body,
  // column 1) — SEARCH_WEIGHT_PATH/SEARCH_WEIGHT_CONTENT bias ranking so a
  // title match outranks a passing body mention. Raw SQLite bm25 is
  // negative-is-better; `-1.0 * bm25(...)` flips it so bigger is more
  // relevant (see `Note.score`'s doc comment for the external contract).
  // The weights are our own numeric constants (not user input) interpolated
  // directly — bm25()'s weight arguments are positional per-column
  // multipliers, not general SQL expressions callers can influence.
  const scoreExpr = `(-1.0 * bm25(notes_fts, ${SEARCH_WEIGHT_PATH}, ${SEARCH_WEIGHT_CONTENT}))`;

  // `sort` honored under search (vault#551 WS2A item 3): default stays FTS5
  // relevance (the weighted `score` expression); an EXPLICIT
  // `sort: "asc"|"desc"` switches to `created_at` ordering. Checked against
  // the literal string values (not truthiness) so an absent `sort` can
  // never accidentally match a branch. `n.id ${direction}` is appended as a
  // deterministic tiebreaker in every branch — two notes at the same
  // created_at millisecond (structured-sort branches) OR with an
  // identical weighted score (relevance branch — much more likely than
  // with unweighted `rank`, since many notes share "zero path matches")
  // would otherwise return in arbitrary/unstable order.
  const orderBy =
    opts?.sort === "asc"
      ? "n.created_at ASC, n.id ASC"
      : opts?.sort === "desc"
        ? "n.created_at DESC, n.id DESC"
        : "score DESC, n.id ASC";

  if (opts?.tags && opts.tags.length > 0) {
    // Canonical-bare-tag guard backstop (vault#XXX) for direct-core callers.
    const searchTags = opts.tags.map(stripTagHash).filter((t) => t !== "");
    if (searchTags.length === 0) {
      // All tag filters collapsed to empty — fall through to the untagged
      // search path below (no tag constraint).
      opts = { ...opts, tags: undefined };
    } else {
    try {
      // Tag membership as a semijoin — same rationale as queryNotes: a
      // `JOIN note_tags` multiplies rows for multi-tagged notes and forced
      // DISTINCT over full rows. The FTS join itself is 1:1 on rowid.
      const tagPlaceholders = searchTags.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT n.*, ${scoreExpr} AS score FROM notes n
        JOIN notes_fts fts ON fts.rowid = n.rowid
        WHERE notes_fts MATCH ?
          AND n.id IN (SELECT note_id FROM note_tags WHERE tag_name IN (${tagPlaceholders}))
        ORDER BY ${orderBy}
        LIMIT ?
      `).all(ftsQuery, ...searchTags, limit) as (NoteRow & { score: number })[];
      return notesWithTags(db, rows, scoresById(rows));
    } catch (err) {
      // Surface EVERY FTS5 error structured, never a raw rethrow (vault#551):
      // advanced mode expects it (the caller passed raw syntax); literal
      // mode should never reach it (escaping + control-char sanitization
      // make the query valid) but if the invariant breaks we still want an
      // honest error, not an unstructured 500. A QueryError we threw
      // ourselves (empty-limit validation, etc.) is re-raised untouched.
      if (err instanceof QueryError) throw err;
      throw searchSyntaxError(query, err, mode);
    }
    }
  }

  try {
    const rows = db.prepare(`
      SELECT n.*, ${scoreExpr} AS score FROM notes n
      JOIN notes_fts fts ON fts.rowid = n.rowid
      WHERE notes_fts MATCH ?
      ORDER BY ${orderBy}
      LIMIT ?
    `).all(ftsQuery, limit) as (NoteRow & { score: number })[];
    return notesWithTags(db, rows, scoresById(rows));
  } catch (err) {
    if (err instanceof QueryError) throw err;
    throw searchSyntaxError(query, err, mode);
  }
}

/**
 * Map rows → Notes with tags hydrated in one batched query. `scores`
 * (vault#551 WS2C) is an optional id → weighted-bm25-score map, attached
 * onto each returned `Note.score` when present — ONLY `searchNotes`'s two
 * callers pass it; every other caller (plain `queryNotes`, `getNotesByIds`,
 * ...) omits it and gets byte-identical output to before `score` existed.
 */
function notesWithTags(db: Database, rows: NoteRow[], scores?: Map<string, number>): Note[] {
  const notes = rows.map(rowToNote);
  const tagsById = getNoteTagsForNotes(db, notes.map((n) => n.id));
  for (const note of notes) {
    note.tags = tagsById.get(note.id) ?? [];
    if (scores) {
      const s = scores.get(note.id);
      if (s !== undefined) note.score = s;
    }
  }
  return notes;
}

/** Build an id → score map from search result rows carrying a `score` column. */
function scoresById(rows: (NoteRow & { score: number })[]): Map<string, number> {
  return new Map(rows.map((r) => [r.id, r.score]));
}

// ---- Tag Operations ----

export function tagNote(db: Database, noteId: string, tags: string[]): void {
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const insertNoteTag = db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_name) VALUES (?, ?)");

  // Canonical-bare-tag guard (vault#XXX): strip any leading `#` so the
  // `#`-decorated form a client may pass (the agent module stored
  // `#agent/message/inbound` verbatim) lands on the same bare row everyone
  // else queries. This is the single write chokepoint — createNote /
  // updateNote / batch / MCP add-tags / REST / import / transcript all funnel
  // through store.tagNote → here.
  for (const raw of tags) {
    const tag = stripTagHash(raw);
    if (tag === "") continue;
    insertTag.run(tag);
    insertNoteTag.run(noteId, tag);
  }
}

export function untagNote(db: Database, noteId: string, tags: string[]): void {
  const stmt = db.prepare("DELETE FROM note_tags WHERE note_id = ? AND tag_name = ?");
  // Mirror tagNote's normalization so removing `#tag` deletes the bare row.
  for (const raw of tags) {
    const tag = stripTagHash(raw);
    if (tag === "") continue;
    stmt.run(noteId, tag);
  }
}

export function getNoteTags(db: Database, noteId: string): string[] {
  const rows = db.prepare(
    "SELECT tag_name FROM note_tags WHERE note_id = ? ORDER BY tag_name",
  ).all(noteId) as { tag_name: string }[];
  return rows.map((r) => r.tag_name);
}

/**
 * List every declared tag with its literal `count` (notes carrying that
 * EXACT tag name) and its `expanded_count` (vault#550) — distinct notes
 * matching the tag OR any transitive descendant under the DEFAULT
 * (subtypes) expansion axis. `expanded_count` is what surfaces a parent
 * tag as non-empty even when every one of its notes is actually tagged
 * with a more specific child tag — `count` alone reports 0 for that
 * parent, which reads as "this tag is dead" when it's really just a
 * rollup label. See `computeExpandedTagCounts` for the single-pass
 * (no N+1) computation.
 */
export function listTags(db: Database): { name: string; count: number; expanded_count: number }[] {
  const rows = db.prepare(`
    SELECT t.name, COUNT(nt.note_id) as count
    FROM tags t
    LEFT JOIN note_tags nt ON nt.tag_name = t.name
    GROUP BY t.name
    ORDER BY t.name
  `).all() as { name: string; count: number }[];

  const h = loadTagHierarchy(db);
  const expandedCounts = computeExpandedTagCounts(db, h);
  return rows.map((r) => ({ ...r, expanded_count: expandedCounts.get(r.name) ?? 0 }));
}

/** Options accepted by {@link deleteTag} (vault#552). */
export interface DeleteTagOpts {
  /**
   * Proceed with the delete even though another tag's `parent_names`
   * references this one — strip the reference from every referencing tag's
   * `parent_names` array as part of the same transaction. Accepted as a
   * synonym of `detach` (both name the identical repair: remove the stale
   * reference, never delete the referencing tag itself); offered as two
   * flags because operators reach for either word depending on whether
   * they're thinking "cascade the delete" or "detach the children."
   */
  cascade?: boolean;
  /** Synonym of `cascade` — see above. */
  detach?: boolean;
}

export type DeleteTagResult =
  | { deleted: boolean; notes_untagged: number; parent_refs_detached?: number }
  | { error: "tag_referenced_as_parent"; referencing_tags: string[] };

/**
 * Delete a tag: drop its identity row, untag every note carrying it, and
 * release any indexed fields it exclusively declared. Notes themselves are
 * NEVER deleted — only untagged.
 *
 * Referential integrity (vault#552): if another tag's `parent_names` array
 * names `name`, deleting it would silently orphan that reference — the
 * child tag's hierarchy edge would point at a name with no identity row
 * (the exact "renamed-away tag remains a live query surface" class of bug
 * the gardener found, one hop over from rename). Refuse by default with
 * `{ error: "tag_referenced_as_parent", referencing_tags }`; pass
 * `opts.cascade` or `opts.detach` (either — see {@link DeleteTagOpts}) to
 * proceed, stripping `name` from every referencing tag's `parent_names` in
 * the same transaction as the delete.
 */
export function deleteTag(db: Database, name: string, opts?: DeleteTagOpts): DeleteTagResult {
  const row = db.prepare("SELECT fields FROM tags WHERE name = ?").get(name) as
    | { fields: string | null }
    | null;
  if (!row) return { deleted: false, notes_untagged: 0 };

  // Referential-integrity guard: who names `name` as a parent? Reuses the
  // SAME parent_names parsing loadTagHierarchy uses everywhere else in the
  // hierarchy (rather than a bespoke LIKE scan) so "who references this
  // tag" answers identically here as it does for query expansion.
  const hierarchy = loadTagHierarchy(db);
  const referencing = Array.from(hierarchy.childrenOf.get(name) ?? []);
  if (referencing.length > 0 && !opts?.cascade && !opts?.detach) {
    return { error: "tag_referenced_as_parent", referencing_tags: referencing.sort() };
  }

  return transaction(db, (): DeleteTagResult => {
    // Strip the stale reference from every referencing tag's parent_names
    // BEFORE dropping this tag's own row — order doesn't matter for
    // correctness (different rows), but doing the repair first means a
    // mid-transaction failure never leaves the identity row gone with
    // dangling references still pointing at it.
    let parentRefsDetached = 0;
    if (referencing.length > 0) {
      const readStmt = db.prepare("SELECT parent_names FROM tags WHERE name = ?");
      const updateStmt = db.prepare("UPDATE tags SET parent_names = ?, updated_at = ? WHERE name = ?");
      const now = new Date().toISOString();
      for (const refTag of referencing) {
        const r = readStmt.get(refTag) as { parent_names: string | null } | null;
        if (!r?.parent_names) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(r.parent_names); } catch { continue; }
        if (!Array.isArray(parsed)) continue;
        const next = (parsed as unknown[]).filter((p) => p !== name);
        if (next.length === parsed.length) continue;
        updateStmt.run(next.length > 0 ? JSON.stringify(next) : null, now, refTag);
        parentRefsDetached++;
      }
    }

    const countRow = db.prepare("SELECT COUNT(*) as c FROM note_tags WHERE tag_name = ?").get(name) as { c: number };
    const notesUntagged = countRow.c;

    // Release any indexed fields this tag declared BEFORE the row drops.
    // `releaseField` only drops the generated column + index when this tag is
    // the last live declarer (co-declaration guard) — a field co-declared by
    // another live tag keeps its column and just loses this tag from the set.
    // This lives in the store-level delete (not the MCP layer) so every caller
    // — MCP delete-tag, the REST DELETE /tags/:name route, the import
    // blow-away sweep — releases consistently. See the gitcoin orphaned-fields
    // bug report.
    if (row.fields) {
      try {
        const fields = JSON.parse(row.fields) as Record<string, { indexed?: boolean }>;
        for (const [fieldName, spec] of Object.entries(fields)) {
          if (spec?.indexed === true) {
            releaseField(db, fieldName, name);
          }
        }
      } catch {
        // Malformed fields JSON — nothing to release; proceed with the delete.
      }
    }

    db.prepare("DELETE FROM note_tags WHERE tag_name = ?").run(name);
    db.prepare("DELETE FROM tags WHERE name = ?").run(name);

    return {
      deleted: true,
      notes_untagged: notesUntagged,
      ...(parentRefsDetached > 0 ? { parent_refs_detached: parentRefsDetached } : {}),
    };
  });
}

// The UNIQUE PRIMARY KEY on tags.name means rename-to-existing is ambiguous:
// do you drop the source, or retag-and-drop? Callers must pick — rename errors
// out; mergeTags explicitly retags.
//
// Vault#240 + #247: rename is a transactional cascade across every surface
// where the old name is referenced. The shape `tag` → `tag/sub` paths
// recursively (sub-tags follow their root). Counts are returned per-surface
// so REST/MCP responses can report what changed without a re-scan.
export interface RenameTagSuccess {
  /** note_tags rows repointed (cumulative across self + every sub-tag). */
  renamed: number;
  /** Sub-tag rows renamed alongside the root (excludes the root itself). */
  sub_tags_renamed: number;
  /** OTHER tags whose `parent_names` JSON array referenced any old name. */
  parent_refs_updated: number;
  /** Tokens whose `scoped_tags` JSON array referenced any old name. */
  tokens_updated: number;
  /** indexed_fields rows whose `declarer_tags` JSON array referenced any old name. */
  indexed_field_declarers_updated: number;
  /** Notes whose `content` had `#oldname[/...]` references rewritten. */
  notes_rewritten: number;
  /** `_tags/<oldname>...` notes whose `path` was rewritten for hygiene. */
  paths_renamed: number;
}

export type RenameTagResult =
  | RenameTagSuccess
  | { error: "not_found" }
  | { error: "target_exists"; conflicting: string[] };

/**
 * Cascading tag rename — closes vault#240 (full cascade) and vault#247
 * (parent_names piece). When `task` becomes `todo`, the rename touches:
 *
 *   1. `tags` PK row (and sub-tag rows `task/...` → `todo/...`).
 *   2. `note_tags.tag_name` FK references for every renamed name.
 *   3. `tags.parent_names` JSON arrays in OTHER tag rows.
 *   4. `tokens.scoped_tags` JSON arrays.
 *   5. `indexed_fields.declarer_tags` JSON arrays.
 *   6. Note body `content`: `#oldname` and `#oldname/...` references
 *      become `#newname` / `#newname/...`. `[[_tags/oldname]]`
 *      wikilinks rewrite to `[[_tags/newname]]`.
 *   7. `_tags/<oldname>...` config-note paths (post-v14 these are inert
 *      historical breadcrumbs, but renaming for hygiene keeps the
 *      vault internally consistent).
 *
 * Atomicity: a single `BEGIN IMMEDIATE` transaction. Any failure rolls
 * back the entire cascade — no half-applied state. Pre-flight collision
 * check covers both the root rename and every sub-tag rename so a
 * partway-through abort can't happen on a UNIQUE-constraint violation.
 *
 * Cache invalidation: parent_names and tag-set both change, so callers
 * (the store wrapper) bust both `_tagHierarchy` and `_schemaConfig`
 * after the cascade returns.
 */
export function renameTag(db: Database, oldName: string, newName: string): RenameTagResult {
  // Normalize the TARGET so a rename can never create a `#`-prefixed tag. The
  // SOURCE (`oldName`) is left LITERAL on purpose — it's the transitional escape
  // hatch that lets the `#legacy/*` → `legacy/*` data migration find the
  // `#`-prefixed rows. (Renaming TO a `#`-name is the thing we're preventing.)
  newName = stripTagHash(newName);
  if (oldName === newName) {
    const exists = db.prepare("SELECT 1 FROM tags WHERE name = ?").get(oldName);
    return exists
      ? emptyCascadeResult()
      : { error: "not_found" };
  }

  const oldExists = db.prepare("SELECT 1 FROM tags WHERE name = ?").get(oldName);
  if (!oldExists) return { error: "not_found" };

  // Discover the full set of names being renamed: the root plus every
  // sub-tag whose name starts with `<oldName>/`. Each maps to a parallel
  // entry under `<newName>/`. Sorted by length DESC so we update the
  // deepest path first if any later step needs deterministic ordering
  // (the SQL we run is order-independent, but it costs nothing here).
  //
  // `escapeLikePattern` neutralizes `%` and `_` inside the operator-
  // supplied tag name so a tag literally named `task_` doesn't pull
  // `taskX/sub` into the rename transaction (that would be a write the
  // caller never asked for — far worse than a downstream false-positive
  // candidate). `ESCAPE '\\'` is required for the escape to take effect.
  const subRows = db
    .prepare("SELECT name FROM tags WHERE name LIKE ? ESCAPE '\\' ORDER BY length(name) DESC")
    .all(`${escapeLikePattern(oldName)}/%`) as { name: string }[];
  const renames: { from: string; to: string }[] = [
    { from: oldName, to: newName },
    ...subRows.map((r) => ({ from: r.name, to: `${newName}${r.name.slice(oldName.length)}` })),
  ];

  // Pre-flight: if any new name already exists as a tag (and isn't itself
  // about to be renamed away), abort with structured error. No rows
  // mutated. The renamed-away set covers both `oldName` itself (which
  // becomes `newName` — fine) and any sub-tag whose new path happens to
  // collide with an existing sub-tag (uncommon but possible if the
  // operator picks an awkward target).
  const renamedAway = new Set(renames.map((r) => r.from));
  const conflicting: string[] = [];
  const existsStmt = db.prepare("SELECT 1 FROM tags WHERE name = ?");
  for (const { to } of renames) {
    if (renamedAway.has(to)) continue;
    if (existsStmt.get(to)) conflicting.push(to);
  }
  if (conflicting.length > 0) {
    return { error: "target_exists", conflicting };
  }

  const result = transaction(db, (): RenameTagSuccess => {
    let renamedNoteTags = 0;
    let pathsRenamed = 0;

    // ---- Tag-row rename pass.
    //
    // Order: insert new row (carrying identity), repoint note_tags, drop
    // old row. Per-rename, mirroring the pre-cascade behavior. The
    // note_tags FK on `tag_name` has no ON DELETE, so the delete must
    // come AFTER the repoint.
    const now = new Date().toISOString();
    // Integer keyset mirror of `now` for the note `updated_at_ms` bumps in the
    // content/path rewrite passes below (vault#586). `now` is canonical, so
    // `timestampToMs` never returns null here.
    const nowMs = timestampToMs(now) ?? Date.now();
    const readStmt = db.prepare(
      "SELECT description, fields, relationships, parent_names, created_at FROM tags WHERE name = ?",
    );
    const insertStmt = db.prepare(
      `INSERT INTO tags (name, description, fields, relationships, parent_names, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const repointStmt = db.prepare(
      "UPDATE note_tags SET tag_name = ? WHERE tag_name = ? RETURNING note_id",
    );
    const dropStmt = db.prepare("DELETE FROM tags WHERE name = ?");
    for (const { from, to } of renames) {
      const old = readStmt.get(from) as
        | { description: string | null; fields: string | null; relationships: string | null; parent_names: string | null; created_at: string | null }
        | null;
      insertStmt.run(
        to,
        old?.description ?? null,
        old?.fields ?? null,
        old?.relationships ?? null,
        old?.parent_names ?? null,
        old?.created_at ?? now,
        now,
      );
      const repointed = repointStmt.all(to, from) as { note_id: string }[];
      renamedNoteTags += repointed.length;
      dropStmt.run(from);
    }

    // ---- JSON-array cascade across parent_names / scoped_tags /
    // declarer_tags. Same shape three times: cheap LIKE pre-filter, then
    // per-row JSON.parse → array.map → JSON.stringify. Replacing on the
    // parsed array (not the encoded string) is robust against escaping
    // edge cases. The pre-filter narrows the per-row work to just the
    // candidates that mention any of the renamed names.
    //
    // Each call site supplies its own column name for the filter — SQL
    // doesn't expand `column LIKE (a OR b)` into a disjunction. We also
    // escape LIKE wildcards (`%`, `_`) inside tag names and append
    // `ESCAPE '\\'` to every clause so a tag literally named `task_`
    // doesn't match `taskX` as a false-positive candidate.
    const renameMap = new Map(renames.map((r) => [r.from, r.to]));
    const remap = (s: string): string => renameMap.get(s) ?? s;
    const likeClauseFor = (column: string): string =>
      renames
        .map((r) => `${column} LIKE '%"${escapeJsonLike(r.from)}"%' ESCAPE '\\'`)
        .join(" OR ");

    let parentRefsUpdated = 0;
    {
      const rows = db
        .prepare(`SELECT name, parent_names FROM tags WHERE parent_names IS NOT NULL AND (${likeClauseFor("parent_names")})`)
        .all() as { name: string; parent_names: string }[];
      // We just renamed every old name; the rows we're updating are now
      // keyed by the new name where applicable. The candidate clause
      // matched `parent_names` containing any old name — those references
      // are stale and need rewriting.
      const updateStmt = db.prepare(
        "UPDATE tags SET parent_names = ?, updated_at = ? WHERE name = ?",
      );
      for (const row of rows) {
        const next = remapJsonArray(row.parent_names, remap);
        if (next === null) continue;
        updateStmt.run(next, now, row.name);
        parentRefsUpdated++;
      }
    }

    let tokensUpdated = 0;
    if (hasTable(db, "tokens")) {
      const rows = db
        .prepare(`SELECT token_hash, scoped_tags FROM tokens WHERE scoped_tags IS NOT NULL AND (${likeClauseFor("scoped_tags")})`)
        .all() as { token_hash: string; scoped_tags: string }[];
      const updateStmt = db.prepare("UPDATE tokens SET scoped_tags = ? WHERE token_hash = ?");
      for (const row of rows) {
        const next = remapJsonArray(row.scoped_tags, remap);
        if (next === null) continue;
        updateStmt.run(next, row.token_hash);
        tokensUpdated++;
      }
    }

    let declarersUpdated = 0;
    if (hasTable(db, "indexed_fields")) {
      const rows = db
        .prepare(`SELECT field, declarer_tags FROM indexed_fields WHERE declarer_tags IS NOT NULL AND (${likeClauseFor("declarer_tags")})`)
        .all() as { field: string; declarer_tags: string }[];
      const updateStmt = db.prepare("UPDATE indexed_fields SET declarer_tags = ? WHERE field = ?");
      for (const row of rows) {
        const next = remapJsonArray(row.declarer_tags, remap);
        if (next === null) continue;
        updateStmt.run(next, row.field);
        declarersUpdated++;
      }
    }

    // ---- Note body content: rewrite `#<oldname>` and `#<oldname>/...`
    // references. Sub-tag rewrites cascade naturally — `task/work`
    // appears in `renames` so a body that says `#task/work` rewrites
    // directly to `#todo/work` without splitting into prefix-replace.
    //
    // ALSO `[[_tags/<oldname>...]]` wikilinks (post-v14 these are
    // historical, but if any vault still carries them, keep them
    // pointing at the right path).
    let notesRewritten = 0;
    {
      // Each pair of LIKE clauses uses ESCAPE '\\' so the bound pattern
      // can carry a literal `%` or `_` from a tag name without the LIKE
      // engine treating them as wildcards. The middle of the bound
      // string is `escapeLikePattern(from)`; the leading/trailing `%` we
      // wrap in are still our actual wildcards.
      const orClauses = renames
        .map(() => "(content LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
        .join(" OR ");
      const params: string[] = [];
      for (const { from } of renames) {
        const safe = escapeLikePattern(from);
        params.push(`%#${safe}%`, `%[[_tags/${safe}%`);
      }
      const candidates = db
        .prepare(`SELECT id, content FROM notes WHERE content IS NOT NULL AND content != '' AND (${orClauses})`)
        .all(...params) as { id: string; content: string }[];
      // vault#555 fix 2 — this content rewrite is a real persisted-state
      // change (the note's `#oldtag` references literally became
      // `#newtag`) and must bump `updated_at` like any other content
      // write, or a cursor/sync-poll loop never sees it. Shares the one
      // `now` timestamp for the whole cascade (same convention as the
      // tag-row rename pass above). `updated_at_ms` moves with it (vault#586)
      // so the cursor keyset actually surfaces the rewrite.
      const updateStmt = db.prepare("UPDATE notes SET content = ?, updated_at = ?, updated_at_ms = ? WHERE id = ?");
      for (const row of candidates) {
        const next = rewriteNoteBody(row.content, renames);
        if (next === row.content) continue;
        updateStmt.run(next, now, nowMs, row.id);
        notesRewritten++;
      }
    }

    // ---- `_tags/<oldname>...` config-note paths. Post-v14 these are
    // inert (the resolver reads `tags.parent_names`, not the notes).
    // Renaming the path keeps the vault internally consistent for any
    // operator who still inspects them by hand.
    {
      const orClauses = renames.map(() => "path LIKE ? ESCAPE '\\'").join(" OR ");
      const params = renames.map((r) => `_tags/${escapeLikePattern(r.from)}%`);
      const candidates = db
        .prepare(`SELECT id, path FROM notes WHERE path IS NOT NULL AND (${orClauses})`)
        .all(...params) as { id: string; path: string }[];
      // vault#555 fix 2 — same reasoning as the content rewrite above: a
      // path rewrite is a real persisted-state change. `updated_at_ms` moves
      // with `updated_at` (vault#586).
      const updateStmt = db.prepare("UPDATE notes SET path = ?, updated_at = ?, updated_at_ms = ? WHERE id = ?");
      for (const row of candidates) {
        const next = rewriteTagConfigPath(row.path, renames);
        if (next === row.path) continue;
        updateStmt.run(next, now, nowMs, row.id);
        pathsRenamed++;
      }
    }

    return {
      renamed: renamedNoteTags,
      sub_tags_renamed: renames.length - 1,
      parent_refs_updated: parentRefsUpdated,
      tokens_updated: tokensUpdated,
      indexed_field_declarers_updated: declarersUpdated,
      notes_rewritten: notesRewritten,
      paths_renamed: pathsRenamed,
    };
  });

  // Audit log: single line so operators searching `[vault] tag rename`
  // can correlate cascades after the fact. Includes the stats and the
  // mapping for non-trivial sub-tag cases.
  console.error(
    `[vault] tag rename cascade: ${oldName} → ${newName}` +
      (renames.length > 1 ? ` (+${renames.length - 1} sub-tags)` : "") +
      ` — note_tags:${result.renamed} parent_refs:${result.parent_refs_updated} tokens:${result.tokens_updated} indexed:${result.indexed_field_declarers_updated} notes:${result.notes_rewritten} paths:${result.paths_renamed}`,
  );

  return result;
}

function emptyCascadeResult(): RenameTagSuccess {
  return {
    renamed: 0,
    sub_tags_renamed: 0,
    parent_refs_updated: 0,
    tokens_updated: 0,
    indexed_field_declarers_updated: 0,
    notes_rewritten: 0,
    paths_renamed: 0,
  };
}

/**
 * Re-encode a JSON-array column after applying `remap` to every entry,
 * dropping duplicates after remap. Returns the new JSON string, or null
 * if parsing failed / the array became empty (the caller decides whether
 * empty means "leave column" vs "set to NULL"; current callers leave the
 * column as the new array since the existing schema accepts empty JSON).
 */
function remapJsonArray(raw: string, remap: (s: string) => string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const next: string[] = [];
  for (const v of parsed) {
    if (typeof v !== "string") continue;
    const mapped = remap(v);
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return JSON.stringify(next);
}

/**
 * Apply every rename to a note's body content. Walks the rename list
 * longest-first so `#task/work` rewrites cleanly before `#task` would
 * grab the same prefix. Word-boundary semantics: a tag reference is
 * `#name` followed by either end-of-string, whitespace, punctuation, or
 * `/`. We ignore matches inside fenced code blocks — those are typically
 * escaped examples and rewriting them silently changes documented
 * behavior. (We DO touch inline code spans; the trade-off is too noisy
 * to track precisely and the operator can audit via the rewrite count.)
 */
function rewriteNoteBody(content: string, renames: { from: string; to: string }[]): string {
  // Sort longest-first so `task/work` is matched before `task`.
  const sorted = [...renames].sort((a, b) => b.from.length - a.from.length);
  let out = content;
  for (const { from, to } of sorted) {
    // `#tag` / `#tag/...` references. `(?<=^|[\s\p{P}])` would be ideal
    // but we use a simpler form: match at start of string, or after
    // whitespace, or after a character that isn't part of a tag run.
    // Tag references end at a whitespace, end-of-string, or any non-tag
    // character (we approximate with `[^a-zA-Z0-9/_-]`).
    const tagRe = new RegExp(
      `(^|[^a-zA-Z0-9/_#-])#${escapeRegex(from)}(?=$|[^a-zA-Z0-9/_-])`,
      "g",
    );
    out = out.replace(tagRe, `$1#${to}`);
    // `[[_tags/oldname]]` and `[[_tags/oldname#...]]` wikilink targets.
    const wikiRe = new RegExp(
      `\\[\\[_tags/${escapeRegex(from)}(?=[\\]|#])`,
      "g",
    );
    out = out.replace(wikiRe, `[[_tags/${to}`);
  }
  return out;
}

/**
 * Apply every rename to a `_tags/<oldname>...` path.
 */
function rewriteTagConfigPath(path: string, renames: { from: string; to: string }[]): string {
  // Longest-first so `_tags/task/work` matches before `_tags/task`.
  const sorted = [...renames].sort((a, b) => b.from.length - a.from.length);
  for (const { from, to } of sorted) {
    if (path === `_tags/${from}`) return `_tags/${to}`;
    if (path.startsWith(`_tags/${from}/`)) {
      return `_tags/${to}${path.slice(`_tags/${from}`.length)}`;
    }
  }
  return path;
}

function hasTable(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return !!row;
}

/**
 * Escape a tag name for inline interpolation into a SQL LIKE pattern.
 * Doubles `'` for SQL-string safety AND backslash-prefixes the LIKE
 * wildcards (`%`, `_`) so a tag literally named `task_` doesn't match
 * `taskX` as a false-positive candidate. The escape character `\` is
 * declared at each call site via `ESCAPE '\\'`.
 *
 * Order matters: escape `\` first so a tag containing a backslash gets
 * its backslash doubled before we add our own escape prefixes for the
 * wildcards.
 */
function escapeJsonLike(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * Escape a tag name destined for a parameterized LIKE binding. No SQL
 * quote escape (param-binding handles that); just the wildcard
 * neutralization. Pair with `LIKE ? ESCAPE '\\'`.
 */
function escapeLikePattern(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mergeTags(
  db: Database,
  sources: string[],
  target: string,
): { merged: Record<string, number>; target: string } {
  // Normalize the TARGET so a merge can never create a `#`-prefixed tag. SOURCES
  // stay LITERAL so `#legacy/*` rows can be merged away (same carve-out as rename).
  target = stripTagHash(target);
  // Dedup + drop target-in-sources (self-merge is a no-op).
  const uniqueSources = Array.from(new Set(sources)).filter((s) => s !== target);

  const merged: Record<string, number> = {};

  transaction(db, () => {
    // Target might not exist yet. Seed it so INSERT OR IGNORE into note_tags
    // can reference it; leave any existing schema on target untouched.
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(target);

    const retagStmt = db.prepare(
      "INSERT OR IGNORE INTO note_tags (note_id, tag_name) SELECT note_id, ? FROM note_tags WHERE tag_name = ?",
    );
    const deleteNoteTagsStmt = db.prepare("DELETE FROM note_tags WHERE tag_name = ?");
    const deleteTagStmt = db.prepare("DELETE FROM tags WHERE name = ?");
    const countStmt = db.prepare("SELECT COUNT(*) as c FROM note_tags WHERE tag_name = ?");

    for (const source of uniqueSources) {
      const exists = db.prepare("SELECT 1 FROM tags WHERE name = ?").get(source);
      if (!exists) {
        merged[source] = 0;
        continue;
      }
      const before = (countStmt.get(source) as { c: number }).c;
      retagStmt.run(target, source);
      deleteNoteTagsStmt.run(source);
      // Dropping the tag row drops its identity (description, fields,
      // relationships, parent_names) along with it — which is what we want
      // for a merge: the source's identity is consumed by the target.
      deleteTagStmt.run(source);
      merged[source] = before;
    }
  });

  return { merged, target };
}

// ---- Lean note index shape ----

/** Max code points in a NoteIndex preview. */
export const NOTE_INDEX_PREVIEW_LEN = 120;

/**
 * Convert a full Note into its lean index shape:
 * drops `content`, adds `byteSize` and a whitespace-collapsed `preview`.
 * Shared between the `query-notes` MCP tool, HTTP /notes endpoints, and /graph.
 */
export function toNoteIndex(note: Note): NoteIndex {
  const content = note.content ?? "";
  const byteSize = Buffer.byteLength(content, "utf8");
  // Collapse whitespace for a readable single-line preview
  const collapsed = content.replace(/\s+/g, " ").trim();
  // Iterate by Unicode code points so we don't split surrogate pairs
  // (e.g. astral-plane emoji) mid-character.
  const codePoints = Array.from(collapsed);
  const preview = codePoints.length > NOTE_INDEX_PREVIEW_LEN
    ? codePoints.slice(0, NOTE_INDEX_PREVIEW_LEN).join("")
    : collapsed;
  return {
    id: note.id,
    path: note.path,
    extension: note.extension,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    createdBy: note.createdBy ?? null,
    createdVia: note.createdVia ?? null,
    lastUpdatedBy: note.lastUpdatedBy ?? null,
    lastUpdatedVia: note.lastUpdatedVia ?? null,
    tags: note.tags,
    metadata: note.metadata,
    byteSize,
    preview,
    ...(note.score !== undefined ? { score: note.score } : {}),
  };
}

// ---- Metadata field filtering ----

/**
 * Filter metadata on a note/index result based on an include_metadata param.
 * - true / undefined → return as-is (all metadata)
 * - false → strip metadata entirely
 * - string[] → return only those keys (empty array = no filtering)
 */
export function filterMetadata(obj: any, includeMetadata: boolean | string[] | undefined): any {
  if (includeMetadata === undefined || includeMetadata === true) return obj;
  if (includeMetadata === false) {
    const { metadata, ...rest } = obj;
    return rest;
  }
  // Array of field names — empty array means no filtering (treat as "all")
  const fields = includeMetadata as string[];
  if (fields.length === 0 || !obj.metadata) return obj;
  const filtered = Object.fromEntries(
    Object.entries(obj.metadata).filter(([k]) => fields.includes(k)),
  );
  return { ...obj, metadata: Object.keys(filtered).length > 0 ? filtered : undefined };
}

/**
 * Shallow-merge an incoming metadata patch onto a note's existing metadata,
 * with RFC 7386 (JSON Merge Patch) null-as-delete semantics — the canonical
 * merge for every metadata write surface (REST `PATCH /api/notes`, MCP
 * `update-note`, batch).
 *
 * An incoming value of `null` is a DELETE tombstone: the key is removed from
 * the result rather than persisted as a literal JSON `null`. This is the only
 * way to remove a metadata key through the API — under a plain
 * `{ ...existing, ...incoming }` merge, omission can't delete (it preserves the
 * prior value) and `null` used to persist literally, leaving no removal path.
 * Now key renames are pure-API: `{ new_key: "v", "old-key": null }` adds the
 * new key and drops the old one in one PATCH. See vault#478 / #479.
 *
 * Shallow by design — top-level keys only, matching the existing wholesale
 * top-level merge. A nested object value replaces its key wholesale (we do not
 * recurse), so an incoming `null` removes the whole key regardless of depth.
 * Compat: storing a literal null is no longer possible via this path; the
 * boulder migration confirmed zero callers relied on that (vault#478). A caller
 * that genuinely needs an absent-vs-null distinction should model it with a
 * sentinel string, not a JSON null.
 */
export function mergeMetadata(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---- Vault stats (aggregate situational awareness) ----

/**
 * Compute aggregate vault statistics for session-start situational awareness.
 *
 * All computation is done via SQL aggregation — no full-table scans into memory.
 * Safe to call on large vaults. Read-only.
 */
export function getVaultStats(
  db: Database,
  opts?: { topTagsLimit?: number },
): VaultStats {
  const topTagsLimit = opts?.topTagsLimit ?? 20;

  const totalRow = db.prepare("SELECT COUNT(*) as c FROM notes").get() as { c: number };
  const totalNotes = totalRow.c;

  const earliestRow = db.prepare(
    "SELECT id, created_at FROM notes ORDER BY created_at ASC, id ASC LIMIT 1",
  ).get() as { id: string; created_at: string } | null;

  const latestRow = db.prepare(
    "SELECT id, created_at FROM notes ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get() as { id: string; created_at: string } | null;

  const monthRows = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count
    FROM notes
    WHERE created_at IS NOT NULL
    GROUP BY month
    ORDER BY month ASC
  `).all() as { month: string; count: number }[];

  const topTagRows = db.prepare(`
    SELECT tag_name AS tag, COUNT(*) AS count
    FROM note_tags
    GROUP BY tag_name
    ORDER BY count DESC, tag_name ASC
    LIMIT ?
  `).all(topTagsLimit) as { tag: string; count: number }[];

  const tagCountRow = db.prepare("SELECT COUNT(DISTINCT tag_name) as c FROM note_tags").get() as { c: number };
  const tagCount = tagCountRow.c;

  const attachmentCountRow = db.prepare("SELECT COUNT(*) as c FROM attachments").get() as { c: number };
  const attachmentCount = attachmentCountRow.c;

  const linkCountRow = db.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number };
  const linkCount = linkCountRow.c;

  // Total content bytes. CAST(content AS BLOB) forces SQLite's LENGTH() to
  // count UTF-8 BYTES rather than characters (bare LENGTH on TEXT returns a
  // char count, which undercounts multibyte content). COALESCE because SUM
  // over zero rows is NULL. See VaultStats.contentBytes for the rationale.
  const contentBytesRow = db
    .prepare("SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) as b FROM notes")
    .get() as { b: number };
  const contentBytes = contentBytesRow.b;

  return {
    totalNotes,
    earliestNote: earliestRow
      ? { id: earliestRow.id, createdAt: earliestRow.created_at }
      : null,
    latestNote: latestRow
      ? { id: latestRow.id, createdAt: latestRow.created_at }
      : null,
    notesByMonth: monthRows,
    topTags: topTagRows,
    tagCount,
    attachmentCount,
    linkCount,
    contentBytes,
  };
}

// ---- Vault map (front-door structural orientation) ----

/** Shared bucket-expression for the top-level path segment: the text before
 *  the first `/`, or the whole path when it has none. Applied to whichever
 *  `path` column reference the caller substitutes in (`path` or `n.path`). */
function pathBucketExpr(pathCol: string): string {
  return `CASE WHEN instr(${pathCol}, '/') > 0 THEN substr(${pathCol}, 1, instr(${pathCol}, '/') - 1) ELSE ${pathCol} END`;
}

/**
 * Compute the compact structural map `vault-info` surfaces for one-call
 * orientation: total note count, every tag currently carried by at least one
 * note with its membership count, and every top-level path "bucket" (the
 * first `/`-delimited segment of `path`) with its note count — plus a count
 * of notes with no path at all (excluded from `path_buckets`, nothing to
 * bucket). Counts only, no content; three grouped-COUNT queries, safe on
 * large vaults.
 *
 * `opts.tagFilter`, when the KEY IS PRESENT, restricts every count to notes
 * reachable through that exact tag-name set (an `IN`-clause join through
 * `note_tags`) — the scope-aware path a tag-scoped caller's already-expanded
 * allowlist takes (server layer; core stays scope-unaware, it just filters
 * by the plain tag-name list it's given). An empty array is a valid,
 * meaningful filter — "nothing is in scope" — and short-circuits to an
 * all-zero map WITHOUT falling through to the unfiltered/full-vault query;
 * only OMITTING `tagFilter` entirely computes the vault-wide map.
 */
export function getVaultMap(
  db: Database,
  opts?: { tagFilter?: string[] },
): VaultMap {
  const hasFilter = opts !== undefined && opts.tagFilter !== undefined;
  const tagFilter = opts?.tagFilter ?? [];

  if (hasFilter && tagFilter.length === 0) {
    return { total_notes: 0, tags: [], path_buckets: [], unfiled_notes: 0 };
  }

  if (hasFilter) {
    const placeholders = tagFilter.map(() => "?").join(",");

    const totalRow = db
      .prepare(`SELECT COUNT(DISTINCT note_id) as c FROM note_tags WHERE tag_name IN (${placeholders})`)
      .get(...tagFilter) as { c: number };

    const tagRows = db
      .prepare(
        `SELECT tag_name AS name, COUNT(*) AS count
         FROM note_tags
         WHERE tag_name IN (${placeholders})
         GROUP BY tag_name
         ORDER BY count DESC, name ASC`,
      )
      .all(...tagFilter) as { name: string; count: number }[];

    const bucketRows = db
      .prepare(
        `SELECT ${pathBucketExpr("n.path")} AS name, COUNT(DISTINCT n.id) AS count
         FROM notes n
         JOIN note_tags nt ON nt.note_id = n.id
         WHERE nt.tag_name IN (${placeholders}) AND n.path IS NOT NULL
         GROUP BY name
         ORDER BY count DESC, name ASC`,
      )
      .all(...tagFilter) as { name: string; count: number }[];

    const unfiledRow = db
      .prepare(
        `SELECT COUNT(DISTINCT n.id) as c
         FROM notes n
         JOIN note_tags nt ON nt.note_id = n.id
         WHERE nt.tag_name IN (${placeholders}) AND n.path IS NULL`,
      )
      .get(...tagFilter) as { c: number };

    return {
      total_notes: totalRow.c,
      tags: tagRows,
      path_buckets: bucketRows,
      unfiled_notes: unfiledRow.c,
    };
  }

  const totalRow = db.prepare("SELECT COUNT(*) as c FROM notes").get() as { c: number };

  const tagRows = db
    .prepare(
      `SELECT tag_name AS name, COUNT(*) AS count
       FROM note_tags
       GROUP BY tag_name
       ORDER BY count DESC, name ASC`,
    )
    .all() as { name: string; count: number }[];

  const bucketRows = db
    .prepare(
      `SELECT ${pathBucketExpr("path")} AS name, COUNT(*) AS count
       FROM notes
       WHERE path IS NOT NULL
       GROUP BY name
       ORDER BY count DESC, name ASC`,
    )
    .all() as { name: string; count: number }[];

  const unfiledRow = db
    .prepare("SELECT COUNT(*) as c FROM notes WHERE path IS NULL")
    .get() as { c: number };

  return {
    total_notes: totalRow.c,
    tags: tagRows,
    path_buckets: bucketRows,
    unfiled_notes: unfiledRow.c,
  };
}

// ---- Bulk Operations ----

export interface BulkNoteInput {
  content: string;
  id?: string;
  path?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  extension?: string;
  /** Write-attribution (vault#298) — see WriteContext. Per-item so a batch can
   *  carry the same actor/via on every row. */
  actor?: string | null;
  via?: string | null;
}

export function createNotes(db: Database, inputs: BulkNoteInput[]): Note[] {
  const results: Note[] = [];

  transaction(db, () => {
    for (const input of inputs) {
      results.push(
        createNote(db, input.content, {
          id: input.id,
          path: input.path,
          tags: input.tags,
          metadata: input.metadata,
          created_at: input.created_at,
          extension: input.extension,
          actor: input.actor,
          via: input.via,
        }),
      );
    }
  });

  return results;
}

export function batchTag(db: Database, noteIds: string[], tags: string[]): number {
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const insertNoteTag = db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_name) VALUES (?, ?)");
  // Canonical-bare-tag guard (vault#XXX) — batchTag has its own SQL (does NOT
  // funnel through tagNote), so it strips leading `#` independently.
  const bareTags = tags.map(stripTagHash).filter((t) => t !== "");
  let count = 0;

  transaction(db, () => {
    for (const tag of bareTags) {
      insertTag.run(tag);
    }
    for (const noteId of noteIds) {
      for (const tag of bareTags) {
        insertNoteTag.run(noteId, tag);
        count++;
      }
    }
  });

  return count;
}

export function batchUntag(db: Database, noteIds: string[], tags: string[]): number {
  const stmt = db.prepare("DELETE FROM note_tags WHERE note_id = ? AND tag_name = ?");
  // Mirror batchTag's bare-tag normalization so removing `#tag` deletes the
  // bare row.
  const bareTags = tags.map(stripTagHash).filter((t) => t !== "");
  let count = 0;

  transaction(db, () => {
    for (const noteId of noteIds) {
      for (const tag of bareTags) {
        stmt.run(noteId, tag);
        count++;
      }
    }
  });

  return count;
}

// ---- Internal ----

interface NoteRow {
  id: string;
  content: string;
  path: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string | null;
  extension: string | null;
  // Write-attribution (vault#298). All four nullable — NULL on legacy rows and
  // on writes that carried no attribution context. A v22 vault reading these
  // before its migration runs would see them absent on the row object
  // (`SELECT *` simply omits non-existent columns); `?? null` normalizes.
  created_by?: string | null;
  created_via?: string | null;
  last_updated_by?: string | null;
  last_updated_via?: string | null;
}

function rowToNote(row: NoteRow): Note {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata && row.metadata !== "{}") {
    try { metadata = JSON.parse(row.metadata); } catch {}
  }
  return {
    id: row.id,
    content: row.content,
    path: row.path ?? undefined,
    // `extension` is NOT NULL DEFAULT 'md' in v18+, but rows under a v17
    // migration window might briefly read as NULL. Fall back to "md" so
    // callers never see a missing extension.
    extension: row.extension ?? "md",
    metadata,
    createdAt: row.created_at,
    // Legacy notes (pre-#70) may have NULL updated_at. Fall back to created_at
    // so the optimistic-concurrency contract always has a real token to echo.
    updatedAt: row.updated_at ?? row.created_at,
    // Write-attribution (vault#298). NULL passes through verbatim — a missing
    // author is meaningful ("pre-attribution / unknown"), so we don't coerce
    // to a placeholder. `?? null` collapses both SQL NULL and an absent column
    // (pre-migration read) to the same `null`.
    createdBy: row.created_by ?? null,
    createdVia: row.created_via ?? null,
    lastUpdatedBy: row.last_updated_by ?? null,
    lastUpdatedVia: row.last_updated_via ?? null,
  };
}
