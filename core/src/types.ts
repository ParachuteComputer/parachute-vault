import type { Database } from "bun:sqlite";
import type { TagFieldSchema, TagRelationship, TagRelationshipMap, TagRecord } from "./tag-schemas.js";
import type { PrunedField } from "./indexed-fields.js";
import type { TagExpandMode, TagHierarchy } from "./tag-hierarchy.js";
import type { SearchMode } from "./search-query.js";
import type { ValidationStatus } from "./schema-defaults.js";
import type { ConformanceReport } from "./conformance.js";
import type { FindPathResult } from "./links.js";
import type { DoctorReport, DoctorScanOpts } from "./doctor.js";

// ---- Re-exports ----

export type { TagFieldSchema, TagRelationship, TagRelationshipMap, TagRecord } from "./tag-schemas.js";
export type { PrunedField } from "./indexed-fields.js";
export type { TagExpandMode, TagHierarchy } from "./tag-hierarchy.js";
export type { ConformanceReport } from "./conformance.js";
export type { FindPathResult } from "./links.js";
export type { DoctorReport, DoctorFinding, DoctorFindingType, DoctorSeverity, DoctorScanOpts } from "./doctor.js";

// ---- Note ----

export interface Note {
  id: string;
  content: string;
  path?: string;
  /**
   * File extension (sans dot). Defaults to `"md"`. Controls the
   * serialized file suffix on export — `.md`/`.mdx` carry frontmatter
   * inline; `.csv`/`.yaml`/`.json`/etc. carry their metadata in a
   * sidecar at `.parachute/notes-meta/<id>.yaml`. See vault#328 +
   * `core/src/portable-md.ts:supportsInlineFrontmatter`.
   */
  extension?: string;
  /**
   * Always present on notes read back from the store — NULL/`"{}"`/
   * unparseable metadata all collapse to `{}` rather than an absent key
   * (mirrors `tags`, which is likewise always `[]`). Optional here only so
   * write-input shapes (`createNote`/`updateNote` options) can share this
   * type without forcing every caller to pass an empty object.
   */
  metadata?: Record<string, unknown>;
  createdAt: string; // ISO-8601
  updatedAt?: string;
  /**
   * Write-attribution (vault#298) — two axes of provenance, both nullable.
   * `*By` is the principal (a JWT `sub`, or an operator / `token:<id>` label);
   * `*Via` is the interface the write arrived through (`mcp`, `surface:<name>`,
   * `agent:<id>`, `operator`/`cli`, `api`). The `created*` pair is set once at
   * create; the `lastUpdated*` pair tracks the most recent mutating write. NULL
   * = unknown / written before attribution existed (legacy rows) or by a path
   * that carried no context — distinct from any real principal.
   */
  createdBy?: string | null;
  createdVia?: string | null;
  lastUpdatedBy?: string | null;
  lastUpdatedVia?: string | null;
  tags?: string[];
  links?: Link[];
  /**
   * Opt-in link degree (raw row count, both directions by default). Present
   * only when the caller requests it via `include_link_count` (REST/MCP).
   * Surfaced the same way `links`/`attachments` are — an extra key injected
   * onto the response after the base shape. See `getLinkCounts` in links.ts
   * for the exact degree semantics (self-loop = 2 under `both`).
   */
  linkCount?: number;
  /**
   * Full-text search relevance score (vault#551 WS2C — ranking legibility).
   * ONLY present on results from `search=`/`query-notes{search}` — every
   * other read path (structured `queryNotes`, `getNoteById`, ...) leaves
   * this `undefined`. Higher is more relevant — the sign-flipped weighted
   * `bm25(notes_fts, SEARCH_WEIGHT_PATH, SEARCH_WEIGHT_CONTENT)` value (raw
   * SQLite bm25 is negative-is-better; flipped here so external callers get
   * the more intuitive "bigger number wins" convention). Meaningful only
   * for RELATIVE comparison within one result set — the absolute magnitude
   * has no fixed scale and isn't comparable across different queries. When
   * an explicit `sort: "asc"|"desc"` overrides relevance ordering, `score`
   * is still computed and returned (for legibility) even though it no
   * longer determines the result order.
   */
  score?: number;
}

// ---- Link ----

export interface Link {
  sourceId: string;
  targetId: string;
  relationship: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ---- Attachment ----

export interface Attachment {
  id: string;
  noteId: string;
  path: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ---- Vault Stats ----

export interface VaultStats {
  totalNotes: number;
  earliestNote: { id: string; createdAt: string } | null;
  latestNote: { id: string; createdAt: string } | null;
  notesByMonth: { month: string; count: number }[];
  topTags: { tag: string; count: number }[];
  tagCount: number;
  attachmentCount: number;
  linkCount: number;
  /**
   * Total bytes of all note content, computed as the sum of the UTF-8 byte
   * length of every note's `content`. The SQL uses `LENGTH(CAST(content AS
   * BLOB))` deliberately: SQLite's bare `LENGTH(text)` returns the number of
   * *characters*, not bytes, so a note full of multibyte UTF-8 (emoji, CJK,
   * accents) would undercount its true on-disk/on-wire footprint. Casting to
   * BLOB forces `LENGTH` to count raw bytes. This is the logical content size,
   * not the physical DB-file size (see `usage.ts:dbBytes` for the latter).
   */
  contentBytes: number;
}

// ---- Vault Map (front-door structural orientation) ----

/** One counted bucket in a `VaultMap` — a tag name or a top-level path segment. */
export interface VaultMapEntry {
  name: string;
  count: number;
}

/**
 * Compact structural map of a vault: counts only, no content. Designed so a
 * fresh reader (human or AI) orients in ONE `vault-info` call without also
 * needing `include_stats: true` — see `getVaultMap` (core/src/notes.ts) for
 * the SQL and the scope-aware `tagFilter` contract.
 */
export interface VaultMap {
  /** Total notes in scope (all notes when unfiltered). */
  total_notes: number;
  /** Every tag currently carried by at least one in-scope note, with its membership count. Sorted by count desc, then name. */
  tags: VaultMapEntry[];
  /**
   * Every top-level path segment (the text before the first `/`, or the
   * whole path when it has none) among in-scope notes that HAVE a path, with
   * its note count. Sorted by count desc, then name.
   */
  path_buckets: VaultMapEntry[];
  /** In-scope notes with no `path` set — excluded from `path_buckets` (nothing to bucket). */
  unfiled_notes: number;
}

// ---- Query Options ----

export interface QueryOpts {
  tags?: string[];
  tagMatch?: "all" | "any"; // "all" = must have ALL tags (default), "any" = must have ANY tag
  /**
   * Tag-expansion axis (vault tag `expand` axis — design
   * `design/2026-06-09-tag-expand-axis.md`). Selects how each `tags` entry
   * expands:
   * - `"subtypes"` (DEFAULT): tag ∪ `parent_names` descendants. Today's
   *   semantic is-a behavior, unchanged. `_default` universal magic fires here.
   * - `"namespace"`: tag ∪ lexically name-prefixed `tag/*` (the filing axis).
   * - `"both"`: union of subtypes + namespace.
   * - `"exact"`: the literal tag only, no expansion.
   * Absent → `"subtypes"` → byte-identical to pre-axis behavior.
   */
  expand?: TagExpandMode;
  excludeTags?: string[];
  // Presence filters. `true` → has at least one; `false` → has none.
  // When `tags` is also set, `hasTags` is ignored (the tag filter already constrains the set).
  // `hasLinks` checks both directions — inbound or outbound counts as "has links".
  hasTags?: boolean;
  hasLinks?: boolean;
  /**
   * Presence filter on the `unresolved_wikilinks` table (vault#555):
   * `true` → only notes with at least one dangling outbound link (a
   * `[[wikilink]]` or structured `links` target that never resolved to a
   * note); `false` → only notes with none. Safe on a vault where the
   * `unresolved_wikilinks` table has never been created (no note has ever
   * had a broken link) — `true` matches nothing, `false` is a no-op.
   */
  hasBrokenLinks?: boolean;
  path?: string;        // exact path match (case-insensitive)
  pathPrefix?: string;  // e.g., "Projects/Parachute" matches "Projects/Parachute/README"
  /**
   * Filter by file extension. Pass a single extension (e.g. `"csv"`) or
   * an array (e.g. `["csv", "yaml", "json"]`). Extension is compared
   * lower-case. Notes default to `"md"` so `extension: "md"` matches
   * the existing markdown corpus. See vault#328.
   */
  extension?: string | string[];
  // Restrict results to a specific set of note IDs. The MCP `near` query uses
  // this to push graph-neighborhood scoping into the SQL WHERE clause so that
  // LIMIT and ORDER BY apply to the filtered set, not the whole notes table.
  // Empty array → no rows match (avoids `IN ()` syntax error).
  ids?: string[];
  // Per-field metadata filter. Each value is either a primitive (exact
  // match, today's behavior) or an operator object — `{ eq, ne, gt, gte, lt,
  // lte, in, not_in, exists }` — which routes through the generated column
  // for the field. Operator queries require the field to be declared
  // `indexed: true` in a tag schema; undeclared fields error loudly.
  metadata?: Record<string, unknown>;
  // Write-attribution filters (vault#298). Exact-match on the indexed
  // attribution columns — "what did Mathilda write" (`createdBy`/`lastUpdatedBy`)
  // or "what came in via the meeting-ingest surface"
  // (`createdVia`/`lastUpdatedVia`). Each is an exact string match; multiple
  // AND together with the rest of the filter set.
  createdBy?: string;
  lastUpdatedBy?: string;
  createdVia?: string;
  lastUpdatedVia?: string;
  // Legacy shorthand: filters on `n.created_at` (vault ingestion time).
  // Equivalent to `dateFilter: { field: "created_at", from, to }`. Kept
  // as the common path; specifying both this and `dateFilter` rejects.
  dateFrom?: string;    // ISO date
  dateTo?: string;      // ISO date
  // Generalized date range. `field` defaults to `created_at`; `updated_at`
  // is also a recognized real column (the incremental-rebuild path —
  // vault#285 1.5). Any other field must be declared `indexed: true` in a
  // tag schema (so the SQL hits a real B-tree index, same contract as
  // `metadata` operator queries and `orderBy`). Use this to filter on a
  // *content* date — an email's received date, a meeting's scheduled
  // date — rather than the ingestion timestamp, or on `updated_at` to ask
  // "what changed since X."
  dateFilter?: {
    field?: string;
    from?: string;
    to?: string;
  };
  sort?: "asc" | "desc";
  // Sort by an indexed metadata field instead of `created_at`. Must be
  // declared `indexed: true`; errors loudly otherwise. Direction is taken
  // from `sort` (default "asc") and `created_at` is appended as a stable
  // tiebreaker.
  //
  // The pseudo-field `link_count` is special-cased (no indexed-field
  // declaration needed): it sorts by link DEGREE — the both-directions
  // raw row count — using the same directional-sum definition as the
  // `linkCount` response field, so the sort key equals the field value for
  // every note (self-loops included). See `queryNotes`/`getLinkCounts`.
  //
  // The pseudo-field `updated_at` is also special-cased (vault#585): it
  // orders on the integer `notes.updated_at_ms` mirror column (vault#586),
  // NOT the TEXT `updated_at`, with `id` appended as the tiebreaker instead
  // of `created_at` — a TEXT sort mis-orders non-canonical stored timestamps
  // (space-form / offset / no-`Z`) the same way the pre-v26 cursor keyset
  // did. `created_at` itself has no ms mirror and is not special-cased here
  // (its default/no-`orderBy` sort still reads the TEXT column).
  orderBy?: string;
  limit?: number;
  offset?: number;
  /**
   * Opaque cursor for "since last checked" agent loops (vault#313).
   * When passed, the engine decodes it, verifies its `query_hash` matches
   * the current query (mismatch → CursorError `cursor_query_mismatch`),
   * and adds a keyset predicate that returns only rows newer than the
   * cursor's `updated_at`/`id` watermark. Forces `orderBy = updated_at`
   * (with `id` as a stable tiebreaker) so the watermark math is sound.
   *
   * Cursors are minted by `queryNotesPaged` (engine) and surfaced via
   * the `query-notes` MCP tool's `next_cursor` field; callers should
   * treat the string as opaque.
   */
  cursor?: string;
  /**
   * Aggregation / rollup mode (top new-feature ask from a UX round). When
   * present, `aggregateNotes` applies every OTHER filter on this `QueryOpts`
   * (tags, metadata, date range, write-attribution, ids, ...) exactly as
   * `queryNotes` would, then groups the matching notes and returns
   * `[{group, value}]` instead of note rows. `cursor` / `orderBy` / `sort` /
   * `limit` / `offset` are ignored in aggregate mode — a rollup returns one
   * row per group, not a paginated note list.
   */
  aggregate?: AggregateSpec;
  /**
   * Semantic-search MVP (EXPERIMENTAL — `SEMANTIC-MVP-PLAN.md`). Free text
   * to rank notes by MEANING rather than keyword. Requires `semantic:
   * true` and is mutually exclusive with `search` (structurally the same
   * "text in → ranked notes with a score out" shape as `search`, but
   * routed through `note_vectors` cosine similarity instead of FTS5
   * bm25). Every other filter on this `QueryOpts` (tags, metadata, date
   * range, path, ...) narrows the candidate set FIRST, exactly like
   * `search` — see `core/src/notes.ts:semanticSearchNotes`.
   */
  nearText?: string;
  /**
   * Opt into vector ranking. `true` requires `nearText`; omitting it (or
   * passing `false`) is a plain structured/keyword query, byte-identical
   * to pre-semantic-search behavior. See `nearText`.
   */
  semantic?: boolean;
}

/**
 * Result of a semantic-search scan (EXPERIMENTAL — see
 * `QueryOpts.nearText`/`semantic`). Returned by
 * `core/src/notes.ts:semanticSearchNotes` and `Store.semanticSearch`.
 */
export interface SemanticSearchResult {
  /** Notes ranked by cosine similarity (best matching chunk per note), highest first. Each carries `.score`. */
  notes: Note[];
  /**
   * Count of candidate notes (post structured-filter, pre-rank) with NO
   * vector row yet for the active embedding model — the `embeddings_pending`
   * signal. A note with SOME but not all chunks embedded still counts as
   * "has a vector" here (coarse-but-honest: it can be ranked, just not on
   * its full content yet) — see the doc comment on `semanticSearchNotes`.
   */
  pendingCount: number;
  /** Total candidate notes considered, after structured filters, before ranking/limit. */
  totalCandidates: number;
}

/**
 * Aggregation / rollup spec — `QueryOpts.aggregate`. Mirrored by the
 * `query-notes` MCP tool's `aggregate` param and the REST
 * `?aggregate[group_by]=…&aggregate[op]=…&aggregate[field]=…` params.
 */
export interface AggregateSpec {
  /**
   * What to group by: an indexed metadata field name (declared
   * `indexed: true` in a tag schema — same FIELD_NOT_INDEXED contract
   * `metadata` operator queries and `order_by` use), or the special value
   * `"tag"` to group by tag membership. Under `"tag"`, a note carrying N of
   * the tags in the (filtered) result set contributes to N separate groups
   * — this is a membership rollup, not a partition.
   */
  group_by: string;
  /** `"count"` — number of matching notes per group. `"sum"` — sum of `field` per group. */
  op: "count" | "sum";
  /**
   * Required when `op` is `"sum"`; ignored for `"count"`. Must be an
   * indexed metadata field with SQLite storage type `INTEGER` (i.e. declared
   * `type: "integer"` or `type: "boolean"` — the only indexable numeric
   * shapes; a plain `type: "number"` field is never indexable, see
   * `mapFieldType`, and a `TEXT`-backed field can't be summed).
   */
  field?: string;
}

/**
 * One rollup row from `aggregateNotes`. `group` is the group_by value (the
 * tag name under `group_by: "tag"`, or the indexed field's stored value) —
 * `null` collects notes where the group_by field is absent/unset (SQL NULL
 * groups together, standard GROUP BY behavior). `value` is the count/sum.
 */
export interface AggregateRow {
  group: string | number | boolean | null;
  value: number;
}

/**
 * Cursor-paginated query result (vault#313). Returned by
 * `queryNotesPaged`/`storeQueryNotesPaged`. `next_cursor` always advances —
 * even on an empty result page — so an agent loop can persist a single
 * watermark and keep polling.
 */
export interface QueryNotesPage {
  notes: Note[];
  next_cursor: string;
}

/** Note summary — everything except content. Used in link results. */
export interface NoteSummary {
  id: string;
  path?: string;
  extension?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  tags?: string[];
  /** Opt-in link degree (see `Note.linkCount`). */
  linkCount?: number;
}

/**
 * Lean note index entry — summary + byteSize + single-line preview.
 * Used by query-notes (index mode), GET /notes (list default), and /graph.
 */
export interface NoteIndex {
  id: string;
  path?: string;
  extension?: string;
  createdAt: string;
  updatedAt?: string;
  /** Write-attribution (vault#298) — carried on the lean shape too so "who
   *  touched what" is answerable without re-fetching full content. See `Note`. */
  createdBy?: string | null;
  createdVia?: string | null;
  lastUpdatedBy?: string | null;
  lastUpdatedVia?: string | null;
  tags?: string[];
  /** Always present (`{}` when empty) — see `Note.metadata`. */
  metadata?: Record<string, unknown>;
  byteSize: number;
  preview: string;
  /** Derived from the first non-empty line of content (title axis, ratified
   *  2026-07-17) — NEVER stored, computed fresh at read time by
   *  `computeDisplayTitle`. `null` when content has no non-empty line.
   *  Surfaces decide how to render a `null` title (e.g. a timestamp/path
   *  fallback); core just reports the honest content-derived value. */
  displayTitle: string | null;
  /** Opt-in link degree (see `Note.linkCount`). */
  linkCount?: number;
  /** Full-text search relevance score (see `Note.score`). Carried onto the
   *  lean shape too — search's default response IS the lean `NoteIndex[]`
   *  (`include_content` is opt-in), so `score` would be invisible in the
   *  common case if it only lived on the full `Note` shape. */
  score?: number;
}

/** Link with hydrated note summaries. */
export interface HydratedLink extends Link {
  sourceNote?: NoteSummary;
  targetNote?: NoteSummary;
}

// ---- Store Interface ----

export interface Store {
  /**
   * The underlying `bun:sqlite` handle. Exposed (read-only) so callers that
   * need to run a raw query the Store interface doesn't surface — e.g. the
   * token-table reverse-lookups in routes.ts and MCP tool generation in
   * mcp.ts — can reach it without an `(store as any).db` cast. The concrete
   * `Store` class declares this as `public readonly db: Database`. See vault#242.
   */
  readonly db: Database;

  /**
   * Run `fn` inside a single atomic write transaction (commit on return,
   * rollback on throw). The transaction seam (see core/src/txn.ts): the
   * bun backend implements it as `BEGIN IMMEDIATE … COMMIT`, a future
   * Durable-Object backend as `ctx.storage.transactionSync`. Synchronous —
   * `fn` must not await. Nesting is unsupported (matches raw-SQLite BEGIN).
   */
  transaction<T>(fn: () => T): T;

  // Notes. `actor` / `via` carry write-attribution (vault#298) — the
  // principal + interface stamped onto created_by/created_via (and mirrored
  // into the last_updated_* pair on create). Omitted → attribution NULL.
  createNote(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string; extension?: string; actor?: string | null; via?: string | null }): Promise<Note>;
  getNote(id: string): Promise<Note | null>;
  /**
   * Look up a note by path. Pass `extension` to disambiguate when
   * multiple notes share a path differing only by extension (post-
   * vault#328). When omitted and >1 row matches, throws
   * `AmbiguousPathError` instead of silently picking one. See
   * vault#330 S1.
   */
  getNoteByPath(path: string, extension?: string): Promise<Note | null>;
  getNotes(ids: string[]): Promise<Note[]>;
  updateNote(id: string, updates: { content?: string; append?: string; prepend?: string; path?: string; extension?: string; metadata?: Record<string, unknown>; created_at?: string; skipUpdatedAt?: boolean; actor?: string | null; via?: string | null; if_updated_at?: string; tagsForSchemaResolution?: string[] }): Promise<Note>;
  /**
   * Set a note's `created_at` and `updated_at` explicitly. Import-only:
   * used by the portable-md round-trip path to restore timestamps from
   * the export bytes. The regular `updateNote` either bumps `updated_at`
   * to wall-clock-now or (with `skipUpdatedAt: true`) leaves it
   * untouched — neither shape lets the importer write a specific
   * historical timestamp. Bypasses hooks. See vault#308 PR 2.
   */
  restoreNoteTimestamps(id: string, createdAt: string, updatedAt: string): Promise<void>;
  /**
   * Sync wikilinks for every note in the vault. Cheap O(n) walk; used
   * after bulk-imports to rebuild link rows from `[[brackets]]` in
   * content. Returns counts for caller logging.
   */
  syncAllWikilinks(): Promise<{ synced: number; totalAdded: number; totalRemoved: number }>;
  deleteNote(id: string): Promise<void>;
  queryNotes(opts: QueryOpts): Promise<Note[]>;
  /**
   * Cursor-paginated `queryNotes` (vault#313). Returns the same notes plus
   * an opaque `next_cursor` string the caller can pass on the next call
   * to resume from the watermark of the LAST returned row. The cursor is
   * always present in the response — even on an empty page — so an
   * agent loop can persist a single watermark and keep polling.
   */
  queryNotesPaged(opts: QueryOpts): Promise<QueryNotesPage>;
  /**
   * Aggregation / rollup query. Applies every OTHER filter in `opts` (tags,
   * metadata, date range, write-attribution, `ids`, ...) exactly as
   * `queryNotes` would, then groups by `opts.aggregate.group_by` ("tag" or
   * an indexed metadata field) and returns `[{group, value}]` — one row per
   * group, count or sum per `opts.aggregate.op`. `cursor`/`orderBy`/`sort`/
   * `limit`/`offset` on `opts` are ignored. Throws `QueryError` (code
   * `FIELD_NOT_INDEXED`) when `group_by`/`field` isn't a declared indexed
   * field, or `INVALID_QUERY` for a malformed `aggregate` spec (missing
   * `field` on a `"sum"`, a non-numeric `field`, ...).
   */
  aggregateNotes(opts: QueryOpts): Promise<AggregateRow[]>;
  /**
   * `mode` (vault#551 — literal-by-default): "literal" (default) escapes +
   * phrase-quotes the query so FTS5 punctuation syntax (hyphen = NOT, an
   * apostrophe/period breaking the parse, ...) is treated as ordinary
   * content. "advanced" passes `query` through to FTS5 raw (pre-#551
   * behavior) for callers who want boolean/phrase/prefix operators — a
   * syntax error in that mode throws (`error_type: "invalid_search_syntax"`)
   * rather than silently returning `[]`. `sort` (vault#551): omitted stays
   * FTS5 relevance ranking (default); an explicit "asc"/"desc" switches to
   * `created_at` ordering. See `core/src/search-query.ts`.
   *
   * Every other `QueryOpts` filter (excludeTags, dateFrom/dateFilter, path,
   * metadata, …) composes the same way `queryNotes` / `semanticSearch` do
   * (vault#647). Unspecified `tagMatch` defaults to `"any"` so historical
   * FTS tag semantics (a single IN (...)) stay put.
   */
  searchNotes(query: string, opts?: QueryOpts & { mode?: SearchMode }): Promise<Note[]>;
  /**
   * Semantic search (EXPERIMENTAL — see `QueryOpts.nearText`/`semantic`).
   * The one invocation point for the store's `EmbeddingProvider`: embeds
   * `nearText`, ranks notes by cosine similarity over `note_vectors`
   * (best chunk per note), and applies every other filter on `opts`
   * (tags/metadata/dates/...) first, exactly like `queryNotes`. Throws a
   * structured `QueryError` (`error_type: "semantic_unavailable"`) when no
   * provider is configured or the configured one isn't ready — never a
   * silent fallback to keyword search.
   */
  semanticSearch(nearText: string, opts?: QueryOpts): Promise<SemanticSearchResult>;

  // Tags
  tagNote(noteId: string, tags: string[]): Promise<void>;
  untagNote(noteId: string, tags: string[]): Promise<void>;
  /**
   * Expand a set of tag names to the union of `{tag} ∪ descendants(tag)` for
   * each input, using the `_tags/<name>` config-note hierarchy. Always
   * includes each input tag in the result. Used by tag-scoped tokens to
   * compute the effective allowlisted tag-set at auth time.
   */
  expandTagsWithDescendants(tags: string[]): Promise<Set<string>>;
  /**
   * Mode-aware tag expansion (vault tag `expand` axis). Expands each input tag
   * along the selected axis and returns the union:
   * - `"subtypes"` (default): `{tag} ∪ parent_names-descendants` — identical to
   *   `expandTagsWithDescendants` (which is a thin shim over this).
   * - `"namespace"`: `{tag} ∪ lexically name-prefixed tag/*`.
   * - `"both"`: union of the two.
   * - `"exact"`: `{tag}` only.
   * Always includes each input tag. Used by the live-query matcher to lower the
   * IDENTICAL expansion the snapshot query engine uses for the same `expand`.
   */
  expandTags(tags: string[], mode?: TagExpandMode): Promise<Set<string>>;
  /**
   * The store's cached tag hierarchy (invalidated on tag/parent_names
   * writes). Sync, like `db` and `transaction`. Exposed (vault#550 fold)
   * so per-query consumers — the `unknown_tag` warning collector — reuse
   * the cache instead of re-scanning the `tags` table per request. Treat
   * the returned object as READ-ONLY shared state.
   */
  getTagHierarchy(): TagHierarchy;
  /**
   * `expanded_count` (vault#550): distinct notes matching the tag OR any
   * transitive descendant under the DEFAULT (subtypes) expansion axis,
   * alongside the literal `count`. See `core/src/tag-hierarchy.ts:computeExpandedTagCounts`.
   */
  listTags(): Promise<{ name: string; count: number; expanded_count: number }[]>;
  /**
   * Delete a tag. Refused (vault#552) when another tag's `parent_names`
   * still references it — pass `cascade` or `detach` (synonyms; either
   * strips the stale reference from the referencing tags' `parent_names`
   * in the same transaction) to proceed anyway. Notes are never deleted,
   * only untagged.
   */
  deleteTag(
    name: string,
    opts?: { cascade?: boolean; detach?: boolean },
  ): Promise<
    | { deleted: boolean; notes_untagged: number; parent_refs_detached?: number }
    | { error: "tag_referenced_as_parent"; referencing_tags: string[] }
  >;
  renameTag(
    oldName: string,
    newName: string,
  ): Promise<
    | {
        renamed: number;
        sub_tags_renamed: number;
        parent_refs_updated: number;
        tokens_updated: number;
        indexed_field_declarers_updated: number;
        notes_rewritten: number;
        paths_renamed: number;
      }
    | { error: "not_found" }
    | { error: "target_exists"; conflicting: string[] }
  >;
  mergeTags(
    sources: string[],
    target: string,
  ): Promise<{ merged: Record<string, number>; target: string }>;

  // Vault stats (aggregate, read-only)
  getVaultStats(opts?: { topTagsLimit?: number }): Promise<VaultStats>;

  // Links
  createLink(sourceId: string, targetId: string, relationship: string, metadata?: Record<string, unknown>): Promise<Link>;
  deleteLink(sourceId: string, targetId: string, relationship: string): Promise<void>;
  getLinks(noteId: string, opts?: { direction?: "outbound" | "inbound" | "both" }): Promise<Link[]>;
  listLinks(opts?: { noteId?: string; direction?: "outbound" | "inbound" | "both"; relationship?: string }): Promise<Link[]>;

  // Bulk operations
  createNotes(inputs: { content: string; id?: string; path?: string; tags?: string[] }[]): Promise<Note[]>;
  batchTag(noteIds: string[], tags: string[]): Promise<number>;
  batchUntag(noteIds: string[], tags: string[]): Promise<number>;

  // Deeper link queries
  traverseLinks(noteId: string, opts?: { max_depth?: number; relationship?: string }): Promise<{ noteId: string; depth: number; relationship: string; direction: "outbound" | "inbound" }[]>;
  findPath(sourceId: string, targetId: string, opts?: { max_depth?: number }): Promise<FindPathResult | null>;

  // Tag schemas — schema-only facade (description + fields). Back-compat
  // surface for v13-and-earlier callers; reads/writes route through the
  // post-v14 `tags` row directly.
  listTagSchemas(): Promise<{ tag: string; description?: string; fields?: Record<string, { type: string; description?: string; enum?: string[]; indexed?: boolean }> }[]>;
  getTagSchema(tag: string): Promise<{ tag: string; description?: string; fields?: Record<string, { type: string; description?: string; enum?: string[]; indexed?: boolean }> } | null>;
  upsertTagSchema(tag: string, schema: { description?: string; fields?: Record<string, { type: string; description?: string; enum?: string[]; indexed?: boolean }> }): Promise<{ tag: string; description?: string; fields?: Record<string, { type: string; description?: string; enum?: string[]; indexed?: boolean }> }>;
  deleteTagSchema(tag: string): Promise<boolean>;
  getTagSchemaMap(): Promise<Record<string, { description?: string; fields?: Record<string, { type: string; description?: string; enum?: string[]; indexed?: boolean }> }>>;

  // Indexed-field lifecycle — generated columns + indexes on `notes` derived
  // from tag-declared `indexed: true` fields. See core/src/indexed-fields.ts.

  /**
   * Prune orphaned `indexed_fields` declarers — declarer tags with no `tags`
   * row. Fields left with no live declarer are dropped wholesale; co-declared
   * fields keep their column and lose only the dead declarers. `dryRun`
   * (default true) returns the plan without mutating.
   */
  pruneIndexedFields(opts?: { dryRun?: boolean }): Promise<PrunedField[]>;
  /**
   * Replay `declareField` for every `indexed: true` field across all current
   * tag records, materializing the backing columns + indexes. Idempotent —
   * used by the import path so a fresh import has the same columns a live
   * vault would. Returns the count of (tag, field) declarations replayed.
   */
  reconcileDeclaredIndexes(): Promise<number>;

  /**
   * Read-only taxonomy/metadata integrity scan (vault#552). Never mutates —
   * every finding carries a suggested `remedy` the caller applies
   * deliberately. See `core/src/doctor.ts` for the finding-type catalog.
   */
  doctor(opts?: DoctorScanOpts): Promise<DoctorReport>;

  // Tag records — full v14 identity row (description + fields + typed
  // relationships + parent_names + timestamps). See
  // docs/contracts/tag-data-model.md.
  listTagRecords(): Promise<TagRecord[]>;
  getTagRecord(tag: string): Promise<TagRecord | null>;
  /**
   * Partial upsert. Any patch field left undefined is preserved; pass
   * null to clear. Touching `parent_names` invalidates the tag-hierarchy
   * cache. Returns the post-write row.
   */
  upsertTagRecord(
    tag: string,
    patch: {
      description?: string | null;
      fields?: Record<string, TagFieldSchema> | null;
      relationships?: TagRelationshipMap | null;
      parent_names?: string[] | null;
    },
  ): Promise<TagRecord>;

  /**
   * Conformance check (vault#283) — count existing notes carrying `tag`
   * (descendants included) that would violate the PROPOSED field spec, so a
   * tightening edit (strict / required / narrowed enum / changed type) can
   * warn before save. Pure read. `proposedFields` is the full merged field
   * map the operator intends to save; only those fields are checked.
   */
  countTagConformance(
    tag: string,
    proposedFields: Record<string, TagFieldSchema>,
    opts?: { sampleLimit?: number },
  ): Promise<ConformanceReport>;

  // Schema validation (post-v17: backed by `tags.fields` only — the
  // standalone note_schemas + schema_mappings subsystem retired in v17, see
  // vault#267). Post vault#270 the resolver walks `parent_names` so a note's
  // effective fields include all ancestors' declarations (first-in-walk wins
  // on conflict, surfaced as `schema_conflict` warnings); a tag named
  // `_default` is the implicit universal parent. Returns null when no
  // ancestor declares any fields. The underlying resolver is in-memory after
  // the first lazy load.
  validateNoteAgainstSchemas(note: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> }): ValidationStatus | null;

  // Attachments
  addAttachment(noteId: string, path: string, mimeType: string, metadata?: Record<string, unknown>): Promise<Attachment>;
  getAttachments(noteId: string): Promise<Attachment[]>;
  getAttachment(attachmentId: string): Promise<Attachment | null>;
  /**
   * Reverse-lookup attachment rows by their vault-internal relative `path`
   * (`<date>/<filename>`). Returns every row sharing that path (a single
   * on-disk asset can be referenced by >1 row). Used by the raw
   * `/api/storage/<date>/<file>` serve path to map a requested file back to
   * its owning note(s) for tag-scope enforcement.
   */
  getAttachmentsByPath(path: string): Promise<Attachment[]>;
  setAttachmentMetadata(attachmentId: string, metadata: Record<string, unknown>): Promise<void>;
  deleteAttachment(noteId: string, attachmentId: string): Promise<{ deleted: boolean; path: string | null; orphaned: boolean }>;
  listAttachmentsByTranscribeStatus(status: "pending" | "failed" | "done", limit?: number): Promise<Attachment[]>;
}
