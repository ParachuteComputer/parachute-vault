import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { Note, NoteIndex, QueryOpts, QueryNotesPage, VaultStats } from "./types.js";
import { normalizePath } from "./paths.js";
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
  isoToMillis,
  millisToIso,
  type CursorPayload,
  type QueryHashInputs,
} from "./cursor.js";
import { getIndexedField, releaseField } from "./indexed-fields.js";
import { stripTagHash } from "./tag-hierarchy.js";

let idCounter = 0;

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

/** Generate a timestamp-based ID: YYYY-MM-DD-HH-MM-SS-ffffff */
export function generateId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const micro = now.getMilliseconds() * 1000 + (idCounter++ % 1000);
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    pad(micro, 6),
  ].join("-");
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
  try {
    db.prepare(
      `INSERT INTO notes (id, content, path, metadata, created_at, updated_at, extension, created_by, created_via, last_updated_by, last_updated_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, content, path, metadata, createdAt, createdAt, extension, actor, via, actor, via);
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

export function getNotes(db: Database, ids: string[]): Note[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT * FROM notes WHERE id IN (${placeholders}) ORDER BY created_at`,
  ).all(...ids) as NoteRow[];
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
  const values: (string | null)[] = [];

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

export function queryNotes(db: Database, opts: QueryOpts): Note[] {
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

  // ID set filter — used by `near` to push neighborhood scoping into SQL so
  // that LIMIT applies to the neighborhood, not the whole notes table.
  if (opts.ids !== undefined) {
    if (opts.ids.length === 0) {
      // Caller asked for "in this empty set" — no rows match. Short-circuit
      // with an always-false condition; building `IN ()` would be a SQL error.
      conditions.push("0 = 1");
    } else {
      const placeholders = opts.ids.map(() => "?").join(", ");
      conditions.push(`n.id IN (${placeholders})`);
      params.push(...opts.ids);
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
      column = "n.updated_at";
    } else {
      // Re-uses the same indexed-field gate as `metadata` operator queries
      // and `orderBy` so the error message and contract are consistent.
      requireIndexedField(db, field);
      column = `"meta_${field}"`;
    }
    if (filter.from !== undefined) {
      conditions.push(`${column} >= ?`);
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push(`${column} < ?`);
      params.push(filter.to);
    }
  } else if (hasLegacyDate) {
    if (opts.dateFrom) {
      conditions.push("n.created_at >= ?");
      params.push(opts.dateFrom);
    }
    if (opts.dateTo) {
      conditions.push("n.created_at < ?");
      params.push(opts.dateTo);
    }
  }

  // ---- Cursor predicate (vault#313) ----
  //
  // When a cursor is present, decode it, verify its query_hash matches the
  // current query, and add a keyset predicate of the form:
  //
  //   (updated_at > last_updated_at)
  //     OR (updated_at = last_updated_at AND id > last_id)
  //
  // The cursor also forces ORDER BY n.updated_at ASC, n.id ASC so the
  // watermark math is sound — paginating by updated_at while ordering
  // by created_at would skip rows whose update timestamp differs from
  // their creation timestamp. `orderBy` and `sort: "desc"` are mutually
  // exclusive with cursor mode (a "since last checked" loop wants
  // ascending updated_at, full stop); we reject with INVALID_QUERY so
  // callers don't silently get a broken iteration.
  let cursorPayload: CursorPayload | null = null;
  if (opts.cursor) {
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
    cursorPayload = decodeCursor(opts.cursor);
    const expectedHash = computeQueryHash(toQueryHashInputs(opts));
    if (cursorPayload.query_hash !== expectedHash) {
      throw new CursorError(
        `cursor was minted for a different query — drop the cursor and restart iteration`,
        "cursor_query_mismatch",
      );
    }
    // Translate the millis watermark back to an ISO string for the SQL
    // comparison. SQLite's `n.updated_at` is TEXT in canonical ISO form
    // (the store's `toISOString()` output), and ISO timestamps sort
    // lexicographically in the same order as their millisecond epochs
    // when they all use the same canonical form — which every timestamp
    // vault mints does. Cursors minted on heterogeneous timestamps
    // (e.g. an import that preserved unusual formatting) are still
    // safe: we round-trip the cursor's millis through `new Date()`'s
    // canonical ISO so the comparison is apples-to-apples.
    const cursorIso = millisToIso(cursorPayload.last_updated_at);
    conditions.push(
      "(n.updated_at > ? OR (n.updated_at = ? AND n.id > ?))",
    );
    params.push(cursorIso, cursorIso, cursorPayload.last_id);
  }

  const direction = opts.sort === "desc" ? "DESC" : "ASC";
  let orderBy: string;
  if (opts.cursor) {
    // Cursor mode forces a deterministic keyset order. `id` is the
    // tiebreaker — without it, two notes sharing an `updated_at` would
    // be at the mercy of SQLite's row order and the next page could
    // miss or duplicate one.
    orderBy = "n.updated_at ASC, n.id ASC";
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
  const idSql = `
    SELECT n.id FROM notes n
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const idRows = db.prepare(idSql).all(...params) as { id: string }[];
  return fetchNotesByIdsOrdered(db, idRows.map((r) => r.id));
}

/** Chunk size for IN-list queries — comfortably under SQLite's conservative
 *  999 bound-variable floor (older builds), matching getLinkCounts. */
const IN_CHUNK = 900;

/**
 * Fetch full note rows for `ids`, preserving the input order, with tags
 * hydrated via ONE batched query per chunk (not one per note). Ids not
 * found (deleted between phases) are silently dropped.
 */
function fetchNotesByIdsOrdered(db: Database, ids: string[]): Note[] {
  if (ids.length === 0) return [];
  const rowsById = new Map<string, NoteRow>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
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
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
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
  const notes = queryNotes(db, opts);
  const queryHash = computeQueryHash(toQueryHashInputs(opts));

  // Watermark math: pick the larger of (last returned row, prior cursor
  // watermark, sentinel). When the page is empty, fall back to the prior
  // cursor's watermark — see the JSDoc rationale above.
  let lastUpdatedAt = 0;
  let lastId = "";
  if (opts.cursor) {
    // Re-decode (we already validated in queryNotes); this is cheap.
    const prior = decodeCursor(opts.cursor);
    lastUpdatedAt = prior.last_updated_at;
    lastId = prior.last_id;
  }
  if (notes.length > 0) {
    // queryNotes with a cursor orders by (updated_at ASC, id ASC), so
    // the last note in the array is the new watermark. When no cursor
    // was passed, the SQL is ordered by created_at; we still want the
    // cursor to advance to the MAX (updated_at, id) of this page so
    // the next call resumes correctly. Compute the max explicitly.
    for (const note of notes) {
      const updatedIso = note.updatedAt ?? note.createdAt;
      const ms = isoToMillis(updatedIso);
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

export function searchNotes(
  db: Database,
  query: string,
  opts?: { tags?: string[]; limit?: number },
): Note[] {
  const limit = typeof opts?.limit === "number" ? opts.limit : 50;

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
        SELECT n.* FROM notes n
        JOIN notes_fts fts ON fts.rowid = n.rowid
        WHERE notes_fts MATCH ?
          AND n.id IN (SELECT note_id FROM note_tags WHERE tag_name IN (${tagPlaceholders}))
        ORDER BY rank
        LIMIT ?
      `).all(query, ...searchTags, limit) as NoteRow[];
      return notesWithTags(db, rows);
    } catch {
      return [];
    }
    }
  }

  try {
    const rows = db.prepare(`
      SELECT n.* FROM notes n
      JOIN notes_fts fts ON fts.rowid = n.rowid
      WHERE notes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as NoteRow[];
    return notesWithTags(db, rows);
  } catch {
    return [];
  }
}

/** Map rows → Notes with tags hydrated in one batched query. */
function notesWithTags(db: Database, rows: NoteRow[]): Note[] {
  const notes = rows.map(rowToNote);
  const tagsById = getNoteTagsForNotes(db, notes.map((n) => n.id));
  for (const note of notes) note.tags = tagsById.get(note.id) ?? [];
  return notes;
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

export function listTags(db: Database): { name: string; count: number }[] {
  const rows = db.prepare(`
    SELECT t.name, COUNT(nt.note_id) as count
    FROM tags t
    LEFT JOIN note_tags nt ON nt.tag_name = t.name
    GROUP BY t.name
    ORDER BY t.name
  `).all() as { name: string; count: number }[];
  return rows;
}

export function deleteTag(db: Database, name: string): { deleted: boolean; notes_untagged: number } {
  const row = db.prepare("SELECT fields FROM tags WHERE name = ?").get(name) as
    | { fields: string | null }
    | null;
  if (!row) return { deleted: false, notes_untagged: 0 };

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

  return { deleted: true, notes_untagged: notesUntagged };
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

  db.exec("BEGIN IMMEDIATE");
  try {
    let renamedNoteTags = 0;
    let pathsRenamed = 0;

    // ---- Tag-row rename pass.
    //
    // Order: insert new row (carrying identity), repoint note_tags, drop
    // old row. Per-rename, mirroring the pre-cascade behavior. The
    // note_tags FK on `tag_name` has no ON DELETE, so the delete must
    // come AFTER the repoint.
    const now = new Date().toISOString();
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
      const updateStmt = db.prepare("UPDATE notes SET content = ? WHERE id = ?");
      for (const row of candidates) {
        const next = rewriteNoteBody(row.content, renames);
        if (next === row.content) continue;
        updateStmt.run(next, row.id);
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
      const updateStmt = db.prepare("UPDATE notes SET path = ? WHERE id = ?");
      for (const row of candidates) {
        const next = rewriteTagConfigPath(row.path, renames);
        if (next === row.path) continue;
        updateStmt.run(next, row.id);
        pathsRenamed++;
      }
    }

    db.exec("COMMIT");

    const result: RenameTagSuccess = {
      renamed: renamedNoteTags,
      sub_tags_renamed: renames.length - 1,
      parent_refs_updated: parentRefsUpdated,
      tokens_updated: tokensUpdated,
      indexed_field_declarers_updated: declarersUpdated,
      notes_rewritten: notesRewritten,
      paths_renamed: pathsRenamed,
    };

    // Audit log: single line so operators searching `[vault] tag rename`
    // can correlate cascades after the fact. Includes the stats and the
    // mapping for non-trivial sub-tag cases.
    console.error(
      `[vault] tag rename cascade: ${oldName} → ${newName}` +
        (renames.length > 1 ? ` (+${renames.length - 1} sub-tags)` : "") +
        ` — note_tags:${result.renamed} parent_refs:${result.parent_refs_updated} tokens:${result.tokens_updated} indexed:${result.indexed_field_declarers_updated} notes:${result.notes_rewritten} paths:${result.paths_renamed}`,
    );

    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
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

  db.exec("BEGIN");
  try {
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

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

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

  db.exec("BEGIN");
  try {
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
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return results;
}

export function batchTag(db: Database, noteIds: string[], tags: string[]): number {
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const insertNoteTag = db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_name) VALUES (?, ?)");
  // Canonical-bare-tag guard (vault#XXX) — batchTag has its own SQL (does NOT
  // funnel through tagNote), so it strips leading `#` independently.
  const bareTags = tags.map(stripTagHash).filter((t) => t !== "");
  let count = 0;

  db.exec("BEGIN");
  try {
    for (const tag of bareTags) {
      insertTag.run(tag);
    }
    for (const noteId of noteIds) {
      for (const tag of bareTags) {
        insertNoteTag.run(noteId, tag);
        count++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return count;
}

export function batchUntag(db: Database, noteIds: string[], tags: string[]): number {
  const stmt = db.prepare("DELETE FROM note_tags WHERE note_id = ? AND tag_name = ?");
  // Mirror batchTag's bare-tag normalization so removing `#tag` deletes the
  // bare row.
  const bareTags = tags.map(stripTagHash).filter((t) => t !== "");
  let count = 0;

  db.exec("BEGIN");
  try {
    for (const noteId of noteIds) {
      for (const tag of bareTags) {
        stmt.run(noteId, tag);
        count++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

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
