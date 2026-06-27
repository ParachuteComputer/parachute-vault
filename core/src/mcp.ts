import { Database } from "bun:sqlite";
import type { Store, Note } from "./types.js";
import * as noteOps from "./notes.js";
import { filterMetadata, MAX_BATCH_SIZE, validateExtension, ExtensionValidationError } from "./notes.js";
import { QueryError } from "./query-operators.js";
import { TAG_EXPAND_MODES, type TagExpandMode } from "./tag-hierarchy.js";
import * as linkOps from "./links.js";
import * as tagSchemaOps from "./tag-schemas.js";
import type { TagFieldSchema } from "./tag-schemas.js";
import * as indexedFieldOps from "./indexed-fields.js";
import {
  SchemaValidationError,
  strictViolations,
  type ValidationWarning,
} from "./schema-defaults.js";
import {
  expandContent,
  DEFAULT_EXPAND_DEPTH,
  MAX_EXPAND_DEPTH,
  type ExpandContext,
  type ExpandMode,
} from "./expand.js";
import {
  parseContentRange,
  applyContentRange,
  contentRangeRequiresContent,
  MIN_CONTENT_LENGTH,
} from "./content-range.js";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => unknown | Promise<unknown>;
  /**
   * Minimum scope verb the caller must hold for THIS vault to see + invoke
   * the tool. `read` for pure queries, `write` for mutations, `admin` for
   * operator-only surfaces (`prune-schema` in core; `manage-token` in the
   * server layer). The MCP HTTP layer filters
   * `tools/list` by this field and verb-gates `tools/call` against it; the
   * filter is the primary defense, the inner gate is defense-in-depth.
   *
   * Pre-v19 unstamped tools default to `write` at the dispatch layer so a
   * future addition that forgets to stamp this gets the safer treatment.
   */
  requiredVerb: "read" | "write" | "admin";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a note identifier — tries ID first, then case-insensitive
 * path match. Works everywhere a note reference is accepted.
 *
 * Path-with-extension form (vault#330 S1): a trailing `.<ext>` matching
 * the extension pattern (`/^[a-z0-9]{1,16}$/i`) is parsed as
 * `(path, extension)` to disambiguate notes that share a path
 * differing only by extension. Mirrors the wikilink ambiguity policy
 * from vault#328.
 *
 * On ambiguous path with no extension hint, `getNoteByPath` throws
 * `AmbiguousPathError` — `resolveNote` propagates it so MCP / REST
 * handlers can surface a clear 4xx rather than picking arbitrarily.
 */
function resolveNote(db: Database, idOrPath: string): Note | null {
  // Try ID match first (fast, indexed)
  const byId = noteOps.getNote(db, idOrPath);
  if (byId) return byId;
  // Path-with-extension form: `Tabular/budget.csv` → (path="Tabular/
  // budget", extension="csv"). Only kicks in when the suffix looks
  // like an extension AND a `(path, ext)` row exists. Fall through to
  // the no-extension lookup if not (so `Recipe.v2` where `v2` isn't a
  // real extension still finds Recipe.v2 by exact-path).
  const extMatch = idOrPath.match(/^(.*)\.([a-z0-9]{1,16})$/i);
  if (extMatch) {
    const explicit = noteOps.getNoteByPath(db, extMatch[1]!, extMatch[2]!);
    if (explicit) return explicit;
  }
  return noteOps.getNoteByPath(db, idOrPath);
}

function requireNote(db: Database, idOrPath: string): Note {
  const note = resolveNote(db, idOrPath);
  if (!note) throw new Error(`Note not found: "${idOrPath}"`);
  return note;
}

/**
 * Remove [[wikilink]] brackets from note content for a specific target.
 * Handles [[Target]], [[Target|alias]], [[Target#section]].
 */
function removeWikilinkBrackets(content: string, targetPath: string): string {
  // Match [[TargetPath...]] with optional alias/anchor, replace with display text
  const escaped = targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // [[Target|alias]] → alias
  content = content.replace(
    new RegExp(`\\[\\[${escaped}\\|([^\\]]+)\\]\\]`, "gi"),
    "$1",
  );
  // [[Target#section]] → Target#section (just remove brackets)
  content = content.replace(
    new RegExp(`\\[\\[${escaped}(#[^\\]]+)?\\]\\]`, "gi"),
    `${targetPath}$1`,
  );
  return content;
}

// ---------------------------------------------------------------------------
// Tool generation
// ---------------------------------------------------------------------------

/**
 * Options for {@link generateMcpTools}.
 *
 * `expandVisibility` (vault security review) is an OPTIONAL per-note
 * visibility predicate threaded into the wikilink-expansion context for
 * `query-notes`. When provided, `expand_links` inlining leaves any wikilink
 * whose target fails the predicate UNRESOLVED — so a tag-scoped MCP session
 * can't inline out-of-scope note content during expansion (the filtering
 * happens DURING expansion, not after). Core stays scope-unaware: it
 * receives a plain `(note) => boolean` closure and never imports the
 * server's tag-scope module. Omitted (every internal / unscoped caller) →
 * expansion behaves exactly as before.
 */
export interface GenerateMcpToolsOpts {
  /**
   * Write-attribution context (vault#298) stamped onto every note written
   * through these tools. `actor` is the principal (JWT `sub` / operator
   * label); `via` is the interface the write arrived through (here, always an
   * MCP session — the server-side wrapper derives `mcp` or a more specific
   * `agent:<id>` / `surface:<name>` when the token's claims reveal it). The
   * core tools pass it straight into `store.createNote` / `store.updateNote`.
   * Omitted (internal / unattributed callers) → writes leave attribution NULL.
   */
  writeContext?: { actor?: string | null; via?: string | null };
  /**
   * Strict-schema enforcement controls (vault#299 Part A). By default every
   * write through these tools enforces `strict:true` field constraints — a
   * violation throws `SchemaValidationError` and the note is NOT written.
   *
   *   `strictBypass: true` — the caller holds the migration-bypass scope
   *     (`vault:migrate`); skip enforcement so non-conforming notes can be
   *     migrated/backfilled. Every bypassed write that WOULD have been
   *     rejected calls `onStrictBypass` for logging (the audit-log table,
   *     #300, is deferred — we log to the daemon's structured log for now).
   *   `onStrictBypass` — invoked once per bypassed write with the would-be
   *     violations plus the actor/via from `writeContext`. Server-layer
   *     supplies a structured logger; core stays log-sink-agnostic.
   */
  strictBypass?: boolean;
  onStrictBypass?: (info: {
    actor: string | null;
    via: string | null;
    path?: string | null;
    tags?: string[];
    violations: ValidationWarning[];
  }) => void;
  expandVisibility?: (note: Note) => boolean;
  /**
   * `nearTraversable` (vault#439) is an OPTIONAL per-note predicate threaded
   * into the `near[]` graph BFS. When provided, the traversal refuses to walk
   * THROUGH any note that fails the predicate — making a tag-scoped `near[]`
   * query symmetric with `find-path` (scope is a wall, not a sieve). Core
   * stays scope-unaware: it receives a plain `(noteId) => boolean` closure.
   * Omitted (unscoped / internal callers) → the full graph is walked.
   */
  nearTraversable?: (noteId: string) => boolean;
}

/**
 * Generate the consolidated MCP tools for a vault. Surface (10):
 * query-notes, create-note, update-note, delete-note, list-tags, update-tag,
 * delete-tag, find-path, vault-info, prune-schema (admin).
 */
export function generateMcpTools(store: Store, opts?: GenerateMcpToolsOpts): McpToolDef[] {
  const db: Database = store.db;
  const expandVisibility = opts?.expandVisibility;
  const nearTraversable = opts?.nearTraversable;
  // Write-attribution (vault#298) — captured once at tool-generation time
  // (a fresh tool set is generated per MCP request, so this is request-scoped)
  // and folded into every create/update the tools perform.
  const writeActor = opts?.writeContext?.actor ?? null;
  const writeVia = opts?.writeContext?.via ?? null;
  const strictBypass = opts?.strictBypass === true;
  const onStrictBypass = opts?.onStrictBypass;

  /**
   * Pre-write strict-schema gate (vault#299 Part A). Validate the PROSPECTIVE
   * note shape (final tags + merged metadata) against the resolved schemas.
   * - No strict violations → no-op (the write proceeds; advisory warnings
   *   still surface later via `attachValidationStatus`).
   * - Strict violations + no bypass → throw `SchemaValidationError` (single
   *   error, all per-field violations) so nothing is written.
   * - Strict violations + bypass → log via `onStrictBypass` and proceed.
   * Called immediately before `store.createNote` / `store.updateNote` so a
   * rejection leaves the note untouched.
   */
  const enforceStrict = (shape: {
    path?: string | null;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): void => {
    enforceStrictWrite(store, shape, {
      bypass: strictBypass,
      onBypass: onStrictBypass
        ? (violations) =>
            onStrictBypass({
              actor: writeActor,
              via: writeVia,
              path: shape.path ?? null,
              tags: shape.tags,
              violations,
            })
        : undefined,
    });
  };

  return [

    // =====================================================================
    // 1. query-notes — the universal read tool
    // =====================================================================
    {
      name: "query-notes",
      requiredVerb: "read",
      description: `Query notes. Returns notes matching the given filters.

- **Single note**: pass \`id\` (accepts note ID or path, e.g., "Projects/README")
- **Filter**: pass \`tag\`, \`path\`, \`path_prefix\`, \`search\`, \`metadata\`, date range
- **Graph neighborhood**: pass \`near\` to scope results to notes within N hops of an anchor note
- **No filters**: returns all notes (paginated)

Defaults: include_content=true for single note, false for lists. include_links=false. tag_match="any".

Large notes: pass \`content_offset\` / \`content_length\` (UTF-8 bytes) for a bounded read of note content — the response carries the slice plus \`content_total_length\` and \`content_next_offset\` (null when complete). Loop, feeding \`content_next_offset\` back as \`content_offset\`, to read a note too large for one response.

Link expansion: pass \`expand_links: true\` to inline [[wikilinks]] from returned content. Tune with \`expand_depth\` (1–3, default 1) and \`expand_mode\` ("full" inlines full content, "summary" inlines only metadata.summary). Expansions are deduplicated across the query and cycle-guarded.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Get one note by ID or path" },
          tag: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Filter by tag(s)",
          },
          tag_match: { type: "string", enum: ["any", "all"], description: "How to match multiple tags: 'any' (OR, default) or 'all' (AND)" },
          expand: {
            type: "string",
            enum: ["subtypes", "namespace", "both", "exact"],
            description: "How each `tag` expands. 'subtypes' (DEFAULT): the tag plus its declared parent_names descendants — the semantic is-a axis (e.g. tag:entity also matches person/work). 'namespace': the tag plus everything filed under it by NAME (tag:entity also matches entity/archived) — the lexical filing axis. 'both': union of the two. 'exact': only the literal tag, no expansion. Omit for 'subtypes' (current behavior).",
          },
          exclude_tags: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Exclude notes with these tag(s). Accepts a single tag or an array. Aliases `excludeTags` and `exclude_tag` are also accepted. If multiple alias forms are provided, `exclude_tags` takes precedence (then `excludeTags`, then `exclude_tag`).",
          },
          // The runtime alias-fallback chain accepts these too. Declared
          // here so schema-introspecting clients (Claude, MCP clients
          // that surface tool schemas) see them as valid inputs rather
          // than thinking the canonical is the only option.
          excludeTags: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Alias for `exclude_tags` (camelCase). Same shape and semantics — pick whichever is more natural for your client.",
          },
          exclude_tag: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Alias for `exclude_tags` (singular). Same shape and semantics — accepts a single tag or an array.",
          },
          has_tags: { type: "boolean", description: "Presence filter: true = only notes with at least one tag; false = only untagged notes. Ignored when `tag` is set." },
          has_links: { type: "boolean", description: "Presence filter: true = only notes with at least one inbound or outbound link; false = only orphaned notes (no links in either direction)." },
          path: { type: "string", description: "Exact path match (case-insensitive)" },
          path_prefix: { type: "string", description: "Path prefix match (e.g., 'Projects/')" },
          extension: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Filter by file extension (vault#328). Pass a single extension (e.g. \"csv\") or an array (e.g. [\"csv\", \"yaml\", \"json\"]). Notes default to \"md\"; case-insensitive match.",
          },
          search: { type: "string", description: "Full-text search query" },
          metadata: {
            type: "object",
            description: "Filter by metadata values. Each value is either a primitive (exact match, scans JSON) or an operator object: `{eq|ne|gt|gte|lt|lte|in|not_in|exists: value}`. Operator objects require the field to be declared `indexed: true` in a tag schema — they route through the backing B-tree index. Multiple operators on one field AND together (e.g. `{gt: 5, lt: 10}`). `in`/`not_in` take arrays; `exists` takes a boolean.",
          },
          created_by: { type: "string", description: "Write-attribution filter (vault#298): only notes whose FIRST write was attributed to this principal (a JWT subject, or an operator/token label). Exact match; indexed. Legacy/unattributed notes (NULL) never match." },
          last_updated_by: { type: "string", description: "Write-attribution filter (vault#298): only notes whose MOST RECENT write was attributed to this principal. Exact match; indexed." },
          created_via: { type: "string", description: "Write-attribution filter (vault#298): only notes FIRST written through this interface/channel — e.g. `mcp`, `surface:<name>`, `agent:<id>`, `operator`, `api`. Exact match; indexed." },
          last_updated_via: { type: "string", description: "Write-attribution filter (vault#298): only notes whose MOST RECENT write came through this interface/channel. Exact match; indexed." },
          order_by: { type: "string", description: "Sort by an indexed metadata field instead of `created_at`. Field must be declared `indexed: true`; errors otherwise. The special value `link_count` sorts by link DEGREE (both-directions raw row count) — no declaration needed — matching the `include_link_count` field for every note. Direction is taken from `sort` (default 'asc'); `created_at` is appended as a stable tiebreaker." },
          date_from: { type: "string", description: "Start date (ISO, inclusive). Filters on `created_at` (vault ingestion time). Shorthand for `date_filter: { field: 'created_at', from }`." },
          date_to: { type: "string", description: "End date (ISO, exclusive). Filters on `created_at` (vault ingestion time). Shorthand for `date_filter: { field: 'created_at', to }`." },
          date_filter: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field to filter on. Defaults to `created_at` (vault ingestion time). `updated_at` is also recognized as a real column — use it for incremental rebuilds (\"what changed since X\"). Any other field must be declared `indexed: true` in a tag schema — same contract as metadata operator queries and `order_by`." },
              from: { type: "string", description: "Inclusive lower bound (ISO date)." },
              to: { type: "string", description: "Exclusive upper bound (ISO date)." },
            },
            description: "Generalized date-range filter. Use this when the date that matters is the *content* date (e.g. an email's received date, a meeting's scheduled date) rather than the vault ingestion time, or when paging by `updated_at` for incremental rebuilds. Mutually exclusive with the top-level `date_from` / `date_to` shorthand.",
          },
          near: {
            type: "object",
            properties: {
              note_id: { type: "string", description: "Anchor note ID or path" },
              depth: { type: "number", description: "Max hops from anchor (default 2, max 5)" },
              relationship: { type: "string", description: "Only follow links with this relationship" },
            },
            required: ["note_id"],
            description: "Scope results to notes within N hops of an anchor note",
          },
          sort: { type: "string", enum: ["asc", "desc"], description: "Sort by created_at" },
          limit: { type: "number", description: "Max results (default 50)" },
          offset: { type: "number", description: "Pagination offset (default 0)" },
          cursor: {
            type: "string",
            description:
              "Opaque cursor for 'since last checked' agent loops (vault#313). First call: omit. The response will include `next_cursor` — pass it on the subsequent call to receive only notes created or updated since the prior page. The cursor binds to the query's filters (tag, path, metadata, etc.); changing them between calls returns a structured `cursor_query_mismatch` error. Pagination via cursor orders results by `updated_at ASC` and is mutually exclusive with `order_by` and `sort: \"desc\"`. The response shape switches to `{notes, next_cursor}` when this parameter is present.",
          },
          include_content: { type: "boolean", description: "Include note content (default: true for single, false for list)" },
          content_offset: {
            type: "number",
            description:
              "Byte offset (UTF-8) into note content to start reading from (default 0). For reading a note too large for one response: pass the previous response's `content_next_offset` here to continue. An offset landing mid-codepoint is aligned DOWN to the codepoint's leading byte (chained `content_next_offset` values are always aligned); the effective start is echoed back as `content_offset` on the response. Requires content in the response — errors when combined with include_content=false (or a list query without include_content=true).",
          },
          content_length: {
            type: "number",
            description:
              `Maximum bytes (UTF-8) of note content to return (minimum ${MIN_CONTENT_LENGTH}). When this or content_offset is set, the returned \`content\` is the byte slice and the response gains \`content_offset\` (effective start), \`content_total_length\` (full content size in bytes), and \`content_next_offset\` (pass back as content_offset to continue; null when the slice reaches the end). Slices end on a UTF-8 codepoint boundary, so a slice may be up to 3 bytes under the budget — never over. Concatenating the slices from offset 0 through content_next_offset=null reconstructs the content byte-for-byte. On list queries the same window applies to each note's content independently. When expand_links=true the range applies to the returned (expanded) content.`,
          },
          include_metadata: {
            oneOf: [
              { type: "boolean" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Control metadata in response: true (all, default), false (none), or array of field names to include",
          },
          include_links: { type: "boolean", description: "Include inbound + outbound links per note (default: false)" },
          include_link_count: {
            type: "boolean",
            description:
              "Include the note's link DEGREE as a `linkCount` field, without hauling the link objects (default: false). Degree is a raw row count: outbound (source) + inbound (target). A self-loop counts as 2. Cheap COUNT over indexes; batched once per request. For a tag-scoped token, `linkCount` is the raw degree and MAY include edges to notes the token can't see — only the number leaks, not the neighbor.",
          },
          link_count_direction: {
            type: "string",
            enum: ["both", "outbound", "inbound"],
            description:
              "Which edges `include_link_count` counts: both (default), outbound only (source_id), or inbound only (target_id). order_by=link_count always uses the both-directions degree.",
          },
          include_attachments: { type: "boolean", description: "Include attachment records (default: false)" },
          expand_links: { type: "boolean", description: "Inline [[wikilinks]] in returned content (default: false). Has no effect if content is not included (e.g., default list mode with include_content=false); wikilinks inside fenced or inline code are not expanded." },
          expand_depth: { type: "number", description: "Recursion depth for link expansion (default 1, max 3). Only meaningful in 'full' mode — 'summary' mode does not recurse." },
          expand_mode: { type: "string", enum: ["full", "summary"], description: "Expansion rendering: 'full' inlines the linked note's content, 'summary' inlines only metadata.summary. Default: 'full'." },
        },
      },
      execute: async (params) => {
        // --- Link expansion config (shared across single + list paths) ---
        const expandLinks = params.expand_links === true;
        const expandMode = (params.expand_mode as ExpandMode) ?? "full";
        const expandDepth = Math.max(
          0,
          Math.min(
            (params.expand_depth as number | undefined) ?? DEFAULT_EXPAND_DEPTH,
            MAX_EXPAND_DEPTH,
          ),
        );
        const expandCtx: ExpandContext | null = expandLinks
          ? {
              db,
              mode: expandMode,
              expanded: new Set(),
              // Tag-scope confidentiality (security review): when a visibility
              // predicate was injected, wikilinks to out-of-scope notes are
              // left unresolved DURING inlining — never embedded. Unscoped
              // callers pass no predicate and inlining is unchanged.
              ...(expandVisibility ? { isVisible: expandVisibility } : {}),
            }
          : null;

        // --- Content range (bounded reads for large notes) ---
        // Validates loudly: bad values throw QueryError here, before any
        // query work. Null when neither param is present — response shape
        // stays byte-identical to the no-pagination behavior.
        const contentRange = parseContentRange(params.content_offset, params.content_length);

        // --- Single note by ID/path ---
        if (params.id) {
          const note = resolveNote(db, params.id as string);
          if (!note) return { error: "Note not found", id: params.id };
          const includeContent = params.include_content !== false; // default true for single
          // Range params are meaningless on a content-less shape — error
          // rather than silently ignore (same loud-validation policy as
          // `expand`).
          if (contentRange && !includeContent) throw contentRangeRequiresContent();
          let result: any = includeContent ? { ...note } : noteOps.toNoteIndex(note);
          if (expandCtx && includeContent && typeof result.content === "string") {
            // Mark the top-level note as already expanded so it can't recursively inline itself.
            expandCtx.expanded.add(note.id);
            result.content = expandContent(result.content, expandCtx, expandDepth);
          }
          // Range applies to the FINAL returned content — after wikilink
          // expansion — so the window the client pages through is the same
          // document it would have received unpaged.
          if (contentRange && includeContent) applyContentRange(result, contentRange);
          result = filterMetadata(result, params.include_metadata as boolean | string[] | undefined);
          if (params.include_links) {
            result.links = linkOps.getLinksHydrated(db, note.id);
          }
          if (params.include_attachments) {
            result.attachments = await store.getAttachments(note.id);
          }
          // linkCount injected after filterMetadata on purpose — same as
          // links/attachments above; filterMetadata only touches `metadata`.
          if (params.include_link_count) {
            const dir = normalizeLinkCountDirection(params.link_count_direction);
            result.linkCount = linkOps.getLinkCounts(db, [note.id], dir).get(note.id) ?? 0;
          }
          return result;
        }

        // --- Build near-scope (graph-filtered set of allowed IDs) ---
        //
        // Tag-scope policy for `near[]` (vault#439 — hop-guard, symmetric with
        // find-path): when the session is tag-scoped the server injects a
        // `nearTraversable` predicate (mcp-tools.ts), and the BFS refuses to
        // walk THROUGH out-of-scope notes — scope is a wall, not a sieve. So a
        // token scoped to ["work"] can't reach an in-scope note at depth 2 via
        // a #personal intermediary at depth 1. Core stays scope-unaware: it
        // only invokes the injected closure. Unscoped sessions pass no
        // predicate → the FULL graph is walked exactly as before. The
        // `applyTagScopeWrappers` result-filter still runs afterward (defense
        // in depth), but the wall makes it redundant for `near[]`.
        let nearScope: Set<string> | null = null;
        if (params.near) {
          const near = params.near as { note_id: string; depth?: number; relationship?: string };
          const anchor = resolveNote(db, near.note_id);
          if (!anchor) return { error: "Anchor note not found", note_id: near.note_id };
          const depth = Math.min(near.depth ?? 2, 5);
          const traversed = linkOps.traverseLinks(db, anchor.id, {
            max_depth: depth,
            relationship: near.relationship,
            isTraversable: nearTraversable,
          });
          nearScope = new Set([anchor.id, ...traversed.map((t) => t.noteId)]);
        }

        // --- Cursor mode (vault#313) ---
        // When the caller passes `cursor`, the response shape switches to
        // `{notes, next_cursor}` and `queryNotesPaged` handles the keyset
        // pagination. Cursor mode is incompatible with full-text search
        // (FTS owns its own ordering — relevance, not updated_at) and
        // graph-neighborhood scoping (`near` would have to rebuild the
        // neighborhood every call to be cursor-stable; we punt for now).
        // Both surface as INVALID_QUERY rather than silently returning
        // wrong rows.
        const cursorMode = typeof params.cursor === "string" && params.cursor.length > 0;
        if (cursorMode && params.search) {
          throw new QueryError(
            `cursor is incompatible with full-text search — FTS has its own ordering. Use date_filter on updated_at for since-last-checked search.`,
            "INVALID_QUERY",
          );
        }
        if (cursorMode && params.near) {
          throw new QueryError(
            `cursor is incompatible with near (graph neighborhood). Resolve the neighborhood first, then iterate with cursor + ids.`,
            "INVALID_QUERY",
          );
        }
        // Tag-expansion axis (vault tag `expand` axis). Validate loudly so a
        // typo'd value doesn't silently fall back to the default.
        let expand: TagExpandMode | undefined;
        if (params.expand !== undefined && params.expand !== null) {
          if (typeof params.expand !== "string" || !(TAG_EXPAND_MODES as readonly string[]).includes(params.expand)) {
            throw new QueryError(
              `invalid \`expand\` value ${JSON.stringify(params.expand)} — must be one of ${TAG_EXPAND_MODES.map((m) => `"${m}"`).join(", ")}. Omit for the default ("subtypes").`,
              "INVALID_QUERY",
            );
          }
          expand = params.expand as TagExpandMode;
        }

        // --- Full-text search ---
        let results: Note[];
        let nextCursor: string | null = null;
        if (params.search) {
          // Normalize tag param
          const tags = normalizeTags(params.tag);
          // Route through `store.searchNotes` (not `noteOps.searchNotes`) so
          // tag-hierarchy expansion fires for MCP callers the same as for
          // HTTP REST callers — `tag: "manual"` matches descendants declared
          // via `_tags/*` config notes. Mirrors the structured-query fix
          // from #214; same class of bypass bug (tracked as #227).
          results = await store.searchNotes(params.search as string, {
            tags,
            limit: (params.limit as number) ?? 50,
            expand,
          });
        } else {
          // --- Structured query ---
          const tags = normalizeTags(params.tag);
          // Accept canonical `exclude_tags` plus camelCase / singular aliases.
          // LLM callers frequently pick the wrong name (training-data drift
          // toward camelCase across MCP tools) and the JSON-RPC layer drops
          // unknown keys silently; aliasing here closes the silent-no-op gap.
          const excludeTagsRaw = params.exclude_tags ?? params.excludeTags ?? params.exclude_tag;
          const excludeTags = normalizeTags(excludeTagsRaw);
          // Route through `store.queryNotes`/`queryNotesPaged` (not the raw
          // `noteOps` exports) so tag-hierarchy expansion fires for MCP
          // callers the same as for HTTP REST callers — `tag: "manual"`
          // matches descendants declared via `_tags/*` config notes. The
          // previous direct-noteOps call bypassed the wrapper and silently
          // dropped hierarchy expansion.
          const queryOpts = {
            tags,
            tagMatch: (params.tag_match as "all" | "any") ?? (tags && tags.length > 1 ? "any" : undefined),
            expand,
            excludeTags,
            hasTags: params.has_tags as boolean | undefined,
            hasLinks: params.has_links as boolean | undefined,
            path: params.path as string | undefined,
            pathPrefix: params.path_prefix as string | undefined,
            extension: params.extension as string | string[] | undefined,
            // Push the near-scope into the SQL WHERE so that LIMIT and ORDER
            // BY apply to the neighborhood. Without this, queryNotes would
            // fetch the first `limit` notes by created_at and then post-
            // filter to the few in-scope ones — which silently empties the
            // result whenever the neighborhood lies outside that prefix.
            ids: nearScope ? [...nearScope] : undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
            // Write-attribution filters (vault#298): "who wrote / via what."
            createdBy: params.created_by as string | undefined,
            lastUpdatedBy: params.last_updated_by as string | undefined,
            createdVia: params.created_via as string | undefined,
            lastUpdatedVia: params.last_updated_via as string | undefined,
            dateFrom: params.date_from as string | undefined,
            dateTo: params.date_to as string | undefined,
            dateFilter: params.date_filter as
              | { field?: string; from?: string; to?: string }
              | undefined,
            sort: params.sort as "asc" | "desc" | undefined,
            orderBy: params.order_by as string | undefined,
            limit: (params.limit as number) ?? 50,
            offset: params.offset as number | undefined,
            cursor: cursorMode ? (params.cursor as string) : undefined,
          };
          if (cursorMode) {
            const page = await store.queryNotesPaged(queryOpts);
            results = page.notes;
            nextCursor = page.next_cursor;
          } else {
            results = await store.queryNotes(queryOpts);
          }
        }

        // For full-text search the post-filter is still the right shape — FTS
        // owns its own ranked LIMIT and we just narrow to the neighborhood
        // afterwards. Structured queries already pushed `ids` into SQL above.
        if (nearScope && params.search) {
          results = results.filter((n) => nearScope!.has(n.id));
        }

        // --- Format output ---
        const includeContent = params.include_content === true; // default false for list
        // Range params require content in the response — on lists that
        // means an explicit include_content=true (the lean default carries
        // no content to slice). Error rather than silently ignore.
        if (contentRange && !includeContent) throw contentRangeRequiresContent();
        const includeMetadata = params.include_metadata as boolean | string[] | undefined;
        let output: any[] = includeContent ? results.map((n) => ({ ...n })) : results.map(noteOps.toNoteIndex);

        // --- Expand wikilinks inline (only meaningful when content is present) ---
        if (expandCtx && includeContent) {
          // Mark all top-level notes as already expanded so they can't inline each other.
          for (const n of output) expandCtx.expanded.add(n.id);
          for (const n of output) {
            if (typeof n.content === "string") {
              n.content = expandContent(n.content, expandCtx, expandDepth);
            }
          }
        }

        // --- Content range (per-note, post-expansion) ---
        // The same byte window applies to EACH note's content independently
        // — the primary use is a single large note, but list mode keeps the
        // simple per-note semantic (every note reports its own
        // content_total_length / content_next_offset).
        if (contentRange && includeContent) {
          for (const n of output) applyContentRange(n, contentRange);
        }

        // --- Apply metadata filtering ---
        if (includeMetadata !== undefined && includeMetadata !== true) {
          output = output.map((n: any) => filterMetadata(n, includeMetadata));
        }

        // --- Opt-in link degree (vault feedback #4) ---
        // ONE batch count over all result ids (NOT per-note), so the field
        // stays O(2 index scans) per request regardless of page size.
        // Injected on the same objects the enrichment loop copies below.
        // Ordering: runs AFTER the filterMetadata pass above on purpose —
        // filterMetadata only touches the `metadata` key, so linkCount
        // survives. Don't casually swap the order.
        if (params.include_link_count) {
          const dir = normalizeLinkCountDirection(params.link_count_direction);
          const counts = linkOps.getLinkCounts(db, output.map((n: any) => n.id), dir);
          for (const n of output) n.linkCount = counts.get(n.id) ?? 0;
        }

        // --- Hydrate links/attachments per note if requested ---
        if (params.include_links || params.include_attachments) {
          // Links hydrate for the WHOLE page in a constant number of
          // queries (see getLinksHydratedForNotes) — the per-note variant
          // cost (1 link query + 1 summary query + N tag queries) × page
          // size. 2026-06-10 perf measurements.
          const linksByNote = params.include_links
            ? linkOps.getLinksHydratedForNotes(db, (output as any[]).map((n: any) => n.id))
            : null;
          const enrichedOut: any[] = [];
          for (const n of output as any[]) {
            const enriched: any = { ...n };
            if (linksByNote) enriched.links = linksByNote.get(n.id) ?? [];
            if (params.include_attachments) enriched.attachments = await store.getAttachments(n.id);
            enrichedOut.push(enriched);
          }
          // Cursor mode wraps the list in `{notes, next_cursor}` so callers can
          // chain calls without tracking a watermark client-side. Legacy
          // callers (no `cursor` param) still get the flat array.
          if (cursorMode) return { notes: enrichedOut, next_cursor: nextCursor };
          return enrichedOut;
        }

        if (cursorMode) return { notes: output, next_cursor: nextCursor };
        return output;
      },
    },

    // =====================================================================
    // 2. create-note — single or batch
    // =====================================================================
    {
      name: "create-note",
      requiredVerb: "write",
      description: `Create one or more notes. Pass a single note's fields directly, or pass a \`notes\` array for batch creation. Each note accepts content, path, metadata, tags, links, and created_at.`,
      inputSchema: {
        type: "object",
        properties: {
          // Single note fields
          content: { type: "string", description: "Note content (markdown). Wikilinks like [[Target]] auto-resolve." },
          path: { type: "string", description: "Note path (e.g., 'Projects/README')" },
          extension: { type: "string", description: "File extension (vault#328). Default \"md\". Use \"csv\"/\"yaml\"/\"json\"/\"mdx\"/etc. for non-markdown notes. Lowercase alphanumeric, 1–16 chars; no '.' or '/'. The \"parachute\" prefix is reserved." },
          metadata: { type: "object", description: "Metadata fields" },
          tags: { type: "array", items: { type: "string" }, description: "Tags to apply" },
          links: {
            type: "array",
            items: {
              type: "object",
              properties: {
                target: { type: "string", description: "Target note ID or path" },
                relationship: { type: "string", description: "Relationship type (e.g., mentions, related-to)" },
              },
              required: ["target", "relationship"],
            },
            description: "Links to create from this note",
          },
          created_at: { type: "string", description: "ISO timestamp (defaults to now)" },
          // Batch
          notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                path: { type: "string" },
                extension: { type: "string", description: "File extension (vault#328). See top-level docs." },
                metadata: { type: "object" },
                tags: { type: "array", items: { type: "string" } },
                links: { type: "array" },
                created_at: { type: "string" },
              },
              required: ["content"],
            },
            description: "Array of notes for batch creation",
          },
        },
      },
      execute: async (params) => {
        const batch = params.notes as any[] | undefined;
        const items = batch ?? [params];

        if (items.length > MAX_BATCH_SIZE) {
          throw new BatchTooLargeError(items.length);
        }

        const created: Note[] = [];
        // Wrap multi-item batches in a SQLite transaction so a mid-batch
        // failure rolls back every prior insert — see #236. This guards
        // anything thrown from store.createNote / createLink (path
        // conflict, etc.). Single-item calls skip the wrap to avoid
        // colliding with concurrent callers on the shared bun:sqlite
        // connection.
        const batched = items.length > 1;
        if (batched) db.exec("BEGIN");
        try {
          for (const item of items) {
            // Validate extension up front (vault#328). Throwing here while
            // we're inside the BEGIN block on a batch rolls back the
            // transaction in the outer catch — the same behavior as a
            // path conflict mid-batch.
            const extension = item.extension !== undefined
              ? validateExtension(item.extension)
              : undefined;
            // Strict-schema gate (vault#299) — reject before any write so a
            // mid-batch violation rolls back via the outer BEGIN/ROLLBACK.
            enforceStrict({
              path: item.path as string | undefined,
              tags: item.tags as string[] | undefined,
              metadata: item.metadata as Record<string, unknown> | undefined,
            });
            const note = await store.createNote(item.content as string ?? "", {
              path: item.path as string | undefined,
              tags: item.tags as string[] | undefined,
              metadata: item.metadata as Record<string, unknown> | undefined,
              created_at: item.created_at as string | undefined,
              ...(extension !== undefined ? { extension } : {}),
              // Write-attribution (vault#298) — same actor/via for every item
              // in a batch (the whole call came from one authenticated session).
              actor: writeActor,
              via: writeVia,
            });

            // Create explicit links (not wikilinks — those are automatic)
            if (item.links) {
              for (const link of item.links as { target: string; relationship: string }[]) {
                const target = resolveNote(db, link.target);
                if (target) {
                  await store.createLink(note.id, target.id, link.relationship);
                }
              }
            }

            created.push(noteOps.getNote(db, note.id) ?? note);
          }
          if (batched) db.exec("COMMIT");
        } catch (e) {
          if (batched) db.exec("ROLLBACK");
          throw e;
        }

        // Apply tag schema effects, then re-read the notes whose metadata was
        // actually default-filled so the response reflects the final on-disk
        // state (the `created` entries were read before `applySchemaDefaults`
        // ran, so default-filled metadata isn't on them yet). This mirrors the
        // update-note path, which already re-reads post-defaults. The re-read
        // is batched (`getNotes` = one `WHERE id IN (...)`) and skipped
        // entirely when no defaults were applied, so the common no-defaults
        // path adds zero extra reads.
        const mutatedIds = new Set<string>();
        for (const note of created) {
          if (note.tags && note.tags.length > 0) {
            for (const id of await applySchemaDefaults(store, db, [note.id], note.tags)) {
              mutatedIds.add(id);
            }
          }
        }
        const refreshed =
          mutatedIds.size === 0
            ? created
            : (() => {
                const byId = new Map(
                  noteOps.getNotes(db, [...mutatedIds]).map((n) => [n.id, n]),
                );
                return created.map((n) => byId.get(n.id) ?? n);
              })();

        // Attach `validation_status` from any tag's `fields` declaration that
        // applies to this note, against the post-defaults state.
        const final = refreshed.map((n) => attachValidationStatus(store, db, n));
        return batch ? final : final[0];
      },
    },

    // =====================================================================
    // 3. update-note — single or batch, absorbs tag/untag + link add/remove
    // =====================================================================
    {
      name: "update-note",
      requiredVerb: "write",
      description: `Update one or more notes. Accepts ID or path. Supports content, path, metadata updates plus tag and link mutations.

- Three content-modification modes (mutually exclusive):
  - \`content\` — full replace.
  - \`append\` / \`prepend\` — atomic concatenation at the SQL layer. Multiple agents appending to the same note never overwrite each other. No separator is added; include trailing/leading whitespace yourself if needed. May be combined with each other.
  - \`content_edit: { old_text, new_text }\` — surgical find-and-replace. \`old_text\` must occur exactly once; zero or multiple matches return an error. Add surrounding context to disambiguate.
- \`tags: { add: ["x"], remove: ["y"] }\` — add/remove tags
- \`links: { add: [{ target, relationship }], remove: [{ target, relationship }] }\` — add/remove links
- When removing a wikilink-type link, \`[[brackets]]\` are also removed from content.
- For batch: pass a \`notes\` array, each with an \`id\` field.
- **Optimistic concurrency is required by default.** Pass \`if_updated_at\` with the \`updated_at\` value you last read — the update is rejected with a conflict error if the note has changed since. Re-read, reconcile, and retry. To skip the safety check (e.g. bulk migration), pass \`force: true\` instead; the update then runs unconditionally. \`force\` only waives the *requirement to supply* \`if_updated_at\` — if you pass both, the precondition you supplied still applies and a mismatch returns a conflict error. \`append\` / \`prepend\` only updates are exempt from the precondition (no-conflict-by-design).
- **Idempotent upsert via \`if_missing: "create"\`** — when the note doesn't exist, create it from this same payload (content/path/tags/metadata become the create fields; OC precondition skipped — nothing to conflict with). Response carries \`created: true\`. Useful for nightly sync loops that don't know ahead of time whether the note exists. Default \`"fail"\` (current behavior — missing note errors). See vault#309.
- \`include_content\` (default \`true\`) — set \`false\` to receive a lean index shape (\`id\`, \`path\`, \`createdAt\`, \`updatedAt\`, \`createdBy\`, \`createdVia\`, \`lastUpdatedBy\`, \`lastUpdatedVia\`, \`tags\`, \`metadata\`, \`byteSize\`, \`preview\`) instead of full content. Useful for agents making frequent small edits to large notes (e.g. via \`append\` or \`content_edit\`) where re-receiving the body is the dominant cost. \`validation_status\` is preserved on the lean shape when present.

Write-attribution (vault#298): every result carries \`createdBy\`/\`createdVia\` (the principal + interface of the first write) and \`lastUpdatedBy\`/\`lastUpdatedVia\` (the most recent write). NULL on notes written before attribution existed. Filter on them with \`created_by\`/\`last_updated_by\`/\`created_via\`/\`last_updated_via\`.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID or path" },
          content: { type: "string", description: "New content (full replace). Mutually exclusive with `append`/`prepend` and `content_edit`." },
          append: { type: "string", description: "Text to append to the end of the note. Atomic at the SQL layer — concurrent appends are safe. Mutually exclusive with `content` and `content_edit`. No precondition required." },
          prepend: { type: "string", description: "Text to prepend to the start of the note. Atomic at the SQL layer. Mutually exclusive with `content` and `content_edit`. May combine with `append`. No precondition required." },
          content_edit: {
            type: "object",
            properties: {
              old_text: { type: "string", description: "Exact text to find. Must match exactly once in the note's current content." },
              new_text: { type: "string", description: "Replacement text." },
            },
            required: ["old_text", "new_text"],
            description: "Find-and-replace one occurrence. Errors if `old_text` is not found or matches multiple locations. Mutually exclusive with `content` and `append`/`prepend`.",
          },
          path: { type: "string", description: "New path" },
          extension: { type: "string", description: "Change the note's file extension (vault#328). Allowed but caller-owned — you're responsible for content validity if you switch a non-empty note's extension. Lowercase alphanumeric, 1–16 chars; \"parachute\" prefix reserved." },
          metadata: { type: "object", description: "Metadata to merge (keys are merged, not replaced wholesale). A value of `null` deletes that key (RFC 7386 merge-patch) — e.g. `{\"new_key\": \"v\", \"old_key\": null}` renames in one call. Omitting a key preserves its existing value." },
          created_at: { type: "string", description: "New created_at timestamp" },
          if_updated_at: { type: "string", description: "Optimistic concurrency check: the updated_at value you last read. Rejects with a conflict error if the note has been modified since. Required unless `force: true` is set or the call is `append`/`prepend`-only." },
          force: { type: "boolean", description: "Waive the *requirement to supply* `if_updated_at` and run the update unconditionally. Use only for bulk migrations or scripted writes where concurrency is known-safe. Note: this does not override an `if_updated_at` you actually pass — if you supply both, the precondition still applies and a mismatch returns a conflict error." },
          if_missing: { type: "string", enum: ["fail", "create"], description: "What to do when the note (by `id`/path) doesn't exist. `\"fail\"` (default) — error, current behavior. `\"create\"` — create the note from this same payload (content/path/tags/metadata become the create fields; the response carries `created: true`). Skips the `if_updated_at` precondition on the create branch (nothing to conflict with). Idempotent for sync loops that don't know ahead of time whether the note exists. See vault#309." },
          state_transition: {
            type: "object",
            properties: {
              field: { type: "string", description: "Metadata field to transition." },
              from: { description: "Required current value. The transition only commits if the field currently equals this. A missing field is a conflict; pass `null` to match a field that is absent or explicitly null." },
              to: { description: "New value to set when the `from` precondition holds." },
            },
            required: ["field", "from", "to"],
            description: "Atomic compare-and-set state transition (vault#299). If the metadata `field` currently equals `from`, set it to `to` and commit; otherwise the write is rejected with a `transition_conflict` error (a missing field counts as a conflict; `from: null` matches absent-or-null). A transition-ONLY update needs no `if_updated_at`/`force` — the compare-and-set is the precondition. Combinable with other field updates (they land in the same atomic UPDATE), but a combined call still needs `if_updated_at`/`force` for the OTHER fields — the CAS only guards the transitioned field. Use this to advance a state machine race-safely in one round trip instead of read → check → conditional update.",
          },
          tags: {
            type: "object",
            properties: {
              add: { type: "array", items: { type: "string" } },
              remove: { type: "array", items: { type: "string" } },
            },
            description: "Tags to add/remove",
          },
          links: {
            type: "object",
            properties: {
              add: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    target: { type: "string", description: "Target note ID or path" },
                    relationship: { type: "string" },
                  },
                  required: ["target", "relationship"],
                },
              },
              remove: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    target: { type: "string", description: "Target note ID or path" },
                    relationship: { type: "string" },
                  },
                  required: ["target", "relationship"],
                },
              },
            },
            description: "Links to add/remove",
          },
          include_content: {
            type: "boolean",
            description: "Response shape opt-out. Default `true` (returns the full Note with content). Set `false` to receive the lean index shape (drops `content`, adds `byteSize` and a whitespace-collapsed `preview`). `validation_status` is preserved on the lean shape when present. Applies uniformly to single and batch responses.",
          },
          include_links: {
            type: "boolean",
            description: "Echo the note's hydrated inbound + outbound links on the response (vault feedback #8). Links are *also* echoed automatically whenever the update itself mutated links (`links.add`/`links.remove`), so you rarely need to set this — its purpose is to fetch the current link set on an update that didn't touch links. Default: `false` (and absent from the response unless mutated or requested). Mirrors `query-notes`'s `include_links`. This top-level flag applies to the single-note form only; for a batch, set `include_links` on each note object in `notes` (a top-level `include_links` is ignored when `notes` is present).",
          },
          // Batch
          notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                append: { type: "string" },
                prepend: { type: "string" },
                content_edit: {
                  type: "object",
                  properties: {
                    old_text: { type: "string" },
                    new_text: { type: "string" },
                  },
                  required: ["old_text", "new_text"],
                },
                path: { type: "string" },
                extension: { type: "string", description: "Change the note's file extension (vault#328). See top-level docs." },
                metadata: { type: "object" },
                created_at: { type: "string" },
                if_updated_at: { type: "string", description: "Optimistic concurrency check for this item; rejects with a conflict error if the note has been modified since. Required unless `force: true` is set on this item or the item is `append`/`prepend`-only." },
                force: { type: "boolean", description: "Waive the *requirement to supply* `if_updated_at` for this item. Does not override an `if_updated_at` you actually pass — a supplied precondition still applies and a mismatch conflicts." },
                if_missing: { type: "string", enum: ["fail", "create"], description: "Per-item: see top-level `if_missing` docs. Each batch item carries its own setting." },
                state_transition: {
                  type: "object",
                  properties: {
                    field: { type: "string" },
                    from: {},
                    to: {},
                  },
                  required: ["field", "from", "to"],
                  description: "Per-item compare-and-set state transition (vault#299). See top-level `state_transition` docs.",
                },
                tags: { type: "object" },
                links: { type: "object" },
                include_links: { type: "boolean", description: "Per-item: echo hydrated links on this item's response (vault feedback #8). Also implied when this item mutates links." },
              },
              required: ["id"],
            },
            description: "Array of note updates for batch",
          },
        },
      },
      execute: async (params) => {
        const batch = params.notes as any[] | undefined;
        const items = batch ?? [params];

        if (items.length > MAX_BATCH_SIZE) {
          throw new BatchTooLargeError(items.length);
        }

        const updated: Note[] = [];
        // Track which note IDs were freshly created via `if_missing: "create"`
        // so the response can carry `created: true|false` per-note. The
        // sync-loop caller (Gitcoin Brain et al) reads this to know which
        // path fired without doing a separate query. vault#309.
        const createdIds = new Set<string>();
        // Track which note IDs should echo hydrated links on the response.
        // A note qualifies when this request mutated its links
        // (`links.add`/`links.remove`) OR the caller set `include_links`.
        // vault feedback #8 — previously the update response omitted links
        // entirely, forcing a re-query just to confirm a link the caller had
        // just added/removed. Per-item on batch. Note IDs (not item indices)
        // key this so the create-on-missing branch, which assigns the id
        // late, can register correctly.
        const echoLinkIds = new Set<string>();
        // Wrap multi-item batches in a SQLite transaction so any mid-batch
        // failure (precondition error, content_edit miss, ConflictError, …)
        // rolls back every prior mutation in the batch — see #236.
        // Single-item calls skip the wrap so concurrent callers don't
        // collide on the shared bun:sqlite connection.
        const batched = items.length > 1;
        if (batched) db.exec("BEGIN");
        try {
        for (const item of items) {
          // Try ID-then-path resolve. If not found AND
          // `if_missing: "create"` is set, fall through to the create
          // branch using this same item's payload. Otherwise mirror the
          // existing `requireNote` behavior (throw "Note not found").
          // vault#309.
          const resolved = resolveNote(db, item.id as string);
          if (!resolved) {
            if (item.if_missing === "create") {
              // Treat the update payload as a create payload. Minimum:
              // content OR a path/id (something the createNote-empty-row
              // invariant accepts). createNote enforces its own
              // not-both-empty check — we leave that to the Store and
              // surface any error to the caller verbatim.
              //
              // Field mapping (mirrors the create-note tool surface):
              //   - `item.id` → both the note's `id` AND a fallback
              //     `path` when `item.path` isn't set. Treating `id` as
              //     the path-or-id lookup key matches Gitcoin's nightly
              //     sync shape where the canonical key is a path string
              //     like "Inbox/2026-05-13-meeting". If the caller
              //     supplied an opaque ULID as `id` and no `path`, we
              //     still create with that as `id` (path stays null).
              //   - `item.content` / `item.path` / `item.tags` /
              //     `item.metadata` / `item.created_at` → forwarded.
              //   - `if_updated_at` / `force` / `content_edit` /
              //     `append` / `prepend` are update-only — silently
              //     ignored on the create branch. (Content-edit on a
              //     non-existent note is a nonsense combination; the
              //     caller's intent on missing-note is "create the
              //     row", not "patch in this section".)
              //   - `links.remove` is also ignored on create (nothing
              //     to remove on a fresh note).
              //   - `links.add` IS applied below — the drift sync can
              //     declare typed links at upsert time and have them
              //     materialize alongside the create. See vault#320
              //     reviewer F1 — the prior comment claimed all
              //     `links` were ignored, but `links.add` was already
              //     processed and used by Gitcoin's sync; the
              //     misleading wording is fixed here so a future
              //     reader doesn't trust it and break the workflow.
              const idOrPath = item.id as string;
              // Heuristic: if `path` isn't set AND the `id` looks like a
              // path (contains "/" or doesn't match a typical opaque-id
              // shape), use it as the path too. Otherwise treat it as a
              // pure id. The shared `id` field for update is ID-or-path
              // already (see `resolveNote`), so this preserves the
              // caller's intent.
              const idLooksLikePath = idOrPath.includes("/") || !/^[A-Za-z0-9_-]+$/.test(idOrPath);
              const explicitPath = typeof item.path === "string" ? item.path as string : undefined;
              // Validate extension before reaching the Store — same
              // contract as the create-note tool.
              const createExt = item.extension !== undefined
                ? validateExtension(item.extension)
                : undefined;
              const createOpts: Parameters<Store["createNote"]>[1] = {
                ...(idLooksLikePath ? { path: explicitPath ?? idOrPath } : { id: idOrPath, ...(explicitPath !== undefined ? { path: explicitPath } : {}) }),
                ...(item.tags && Array.isArray((item.tags as any).add)
                  ? { tags: (item.tags as any).add as string[] }
                  : Array.isArray(item.tags)
                    ? { tags: item.tags as string[] }
                    : {}),
                ...(item.metadata !== undefined ? { metadata: item.metadata as Record<string, unknown> } : {}),
                ...(item.created_at !== undefined ? { created_at: item.created_at as string } : {}),
                ...(createExt !== undefined ? { extension: createExt } : {}),
                // Write-attribution (vault#298) — the if_missing:"create" upsert
                // branch is still a CREATE, so it must stamp the same actor/via
                // as the create-note tool + the REST upsert-create path. Without
                // this an MCP-driven upsert-create wrote NULL attribution.
                actor: writeActor,
                via: writeVia,
              };
              const content = (item.content as string | undefined) ?? "";
              // Strict-schema gate (vault#299) — the if_missing:"create"
              // branch is still a create, so it enforces too. Tags come from
              // createOpts (already normalized from the {add} dict / array).
              enforceStrict({
                path: createOpts.path ?? undefined,
                tags: createOpts.tags,
                metadata: createOpts.metadata,
              });
              const created = await store.createNote(content, createOpts);
              await applySchemaDefaults(store, db, [created.id], created.tags ?? []);
              // Apply links.add if the caller declared any.
              const linksAdd = (item.links as any)?.add as { target: string; relationship: string; metadata?: Record<string, unknown> }[] | undefined;
              if (linksAdd) {
                for (const link of linksAdd) {
                  const target = resolveNote(db, link.target);
                  if (target) await store.createLink(created.id, target.id, link.relationship, link.metadata);
                }
              }
              const fresh = noteOps.getNote(db, created.id) ?? created;
              updated.push(fresh);
              createdIds.add(fresh.id);
              // Echo links if this create-on-missing declared `links.add`
              // (the only link op honored on create) or asked explicitly.
              if (linksAdd !== undefined || item.include_links === true) {
                echoLinkIds.add(fresh.id);
              }
              continue;
            }
            // Fallthrough: not-found + no if_missing → existing error
            // contract. Match `requireNote`'s message shape so existing
            // callers see no behavior change.
            throw new Error(`Note not found: "${item.id}"`);
          }
          const note = resolved;

          // --- Validate mutual exclusion of content modes ---
          const hasContent = item.content !== undefined;
          const hasAppendPrepend = item.append !== undefined || item.prepend !== undefined;
          const hasContentEdit = item.content_edit !== undefined;
          const contentModes = (hasContent ? 1 : 0) + (hasAppendPrepend ? 1 : 0) + (hasContentEdit ? 1 : 0);
          if (contentModes > 1) {
            throw new Error(
              `update-note: \`content\`, \`append\`/\`prepend\`, and \`content_edit\` are mutually exclusive — pick one mode of content update for note "${note.id}".`,
            );
          }

          // --- Safety-by-default: refuse mutations without a precondition ---
          // The caller must either echo the note's last-seen `updated_at`
          // (`if_updated_at`) so the conditional UPDATE can catch lost
          // writes, or explicitly opt out with `force: true`. This runs
          // *before* any DB writes so a rejection leaves the note untouched.
          //
          // Append/prepend-only updates are exempt: they're SQL-atomic
          // concatenations that can't lose data on a stale read, so the
          // precondition would be ceremony for no benefit. Tag and link
          // mutations are *not* exempt — they're idempotent set-ops at
          // the SQL layer but still represent a non-content change the
          // caller should have observed before re-asserting (#201).
          const isAppendOnly = hasAppendPrepend
            && !hasContent
            && !hasContentEdit
            && item.path === undefined
            && item.metadata === undefined
            && item.created_at === undefined
            && item.tags === undefined
            && item.links === undefined;
          // A state_transition is itself a compare-and-set precondition
          // (vault#299 Part B) — a transition-only update doesn't need
          // `if_updated_at`/`force`, the CAS guards the lost-write window.
          const isTransitionOnly = item.state_transition !== undefined
            && !hasContent
            && !hasAppendPrepend
            && !hasContentEdit
            && item.path === undefined
            && item.metadata === undefined
            && item.created_at === undefined
            && item.tags === undefined
            && item.links === undefined;
          if (!isAppendOnly && !isTransitionOnly && item.if_updated_at === undefined && item.force !== true) {
            throw new PreconditionRequiredError(note.id, note.path ?? null);
          }

          // --- Resolve content_edit into a full content string ---
          // We do the find-and-replace at the JS level (read note.content,
          // validate occurrence count, replace). The race window between
          // this read and the UPDATE is closed by `if_updated_at` for
          // strict callers; without it, content_edit is fail-closed —
          // a stale read where someone else removed `old_text` produces
          // a "not found" error instead of silently overwriting.
          let contentOverride = item.content as string | undefined;
          if (hasContentEdit) {
            const ce = item.content_edit as { old_text: string; new_text: string };
            if (typeof ce?.old_text !== "string" || typeof ce?.new_text !== "string") {
              throw new Error(
                "update-note: `content_edit` requires { old_text: string, new_text: string }.",
              );
            }
            const idx = note.content.indexOf(ce.old_text);
            if (idx < 0) {
              throw new Error(
                `update-note content_edit: \`old_text\` not found in note "${note.id}". The note may have been edited — re-read and retry.`,
              );
            }
            const second = note.content.indexOf(ce.old_text, idx + 1);
            if (second >= 0) {
              throw new Error(
                `update-note content_edit: \`old_text\` matches multiple times in note "${note.id}" — must match exactly once. Add surrounding context to disambiguate.`,
              );
            }
            contentOverride = note.content.slice(0, idx) + ce.new_text + note.content.slice(idx + ce.old_text.length);
          }

          // --- Plan bracket cleanup for wikilink removals (no DB writes yet) ---
          // We compute the cleaned content so we can do the core UPDATE first
          // (with if_updated_at atomically) before any link deletions. If the
          // UPDATE fails on a conflict, nothing has been mutated.
          const linksRemove = (item.links as any)?.remove as { target: string; relationship: string }[] | undefined;
          const resolvedLinksToRemove: { targetId: string; relationship: string }[] = [];
          if (linksRemove) {
            for (const link of linksRemove) {
              const target = resolveNote(db, link.target);
              if (!target) continue;
              resolvedLinksToRemove.push({ targetId: target.id, relationship: link.relationship });
              if (link.relationship === "wikilink" && target.path) {
                // Wikilink-removal bracket cleanup operates on the prospective
                // *full* content. Coexists with content_edit; would fight
                // append/prepend (which leave existing content untouched at
                // the JS layer), so we pre-materialize the would-be content
                // for those callers and switch to a `content`-style update.
                const currentContent = contentOverride
                  ?? (hasAppendPrepend
                    ? (item.prepend as string ?? "") + note.content + (item.append as string ?? "")
                    : note.content);
                const cleaned = removeWikilinkBrackets(currentContent, target.path);
                if (cleaned !== currentContent) {
                  contentOverride = cleaned;
                }
              }
            }
          }

          // --- Core update (content, path, metadata, created_at + concurrency check) ---
          const updates: any = {};
          if (contentOverride !== undefined) {
            updates.content = contentOverride;
          } else if (hasAppendPrepend) {
            // No content_edit and no wikilink-removal pre-materialization —
            // route the append/prepend down to the SQL-atomic path.
            if (item.append !== undefined) updates.append = item.append;
            if (item.prepend !== undefined) updates.prepend = item.prepend;
          }
          if (item.path !== undefined) updates.path = item.path;
          if (item.extension !== undefined) {
            updates.extension = validateExtension(item.extension);
          }
          if (item.metadata !== undefined) {
            // Merge metadata (RFC 7386: keys are merged, incoming `null`
            // removes the key rather than persisting a literal null —
            // vault#478/#479). Mirrors the REST PATCH path.
            updates.metadata = noteOps.mergeMetadata(
              note.metadata as Record<string, unknown> | null | undefined,
              item.metadata as Record<string, unknown>,
            );
          }
          if (item.created_at !== undefined) updates.created_at = item.created_at;
          if (item.if_updated_at !== undefined) updates.if_updated_at = item.if_updated_at as string;
          // Compare-and-set state transition (vault#299 Part B). Combinable
          // with other field updates — it folds into the same atomic UPDATE.
          const stItem = item.state_transition as { field?: unknown; from?: unknown; to?: unknown } | undefined;
          if (stItem !== undefined) {
            if (typeof stItem.field !== "string" || stItem.field.length === 0) {
              throw new Error(
                `update-note: \`state_transition.field\` must be a non-empty string (note "${note.id}").`,
              );
            }
            updates.state_transition = { field: stItem.field, from: stItem.from, to: stItem.to };
          }

          // --- Strict-schema gate (vault#299 Part A) ---
          // Validate the PROSPECTIVE shape (final tags + merged metadata,
          // including a state_transition's `to`) before the write so a
          // rejection leaves the note untouched.
          {
            const removeSet = new Set<string>((item.tags as any)?.remove ?? []);
            const projectedTags = new Set<string>((note.tags ?? []).filter((t) => !removeSet.has(t)));
            for (const t of ((item.tags as any)?.add as string[] | undefined) ?? []) projectedTags.add(t);
            const baseMeta = updates.metadata ?? ((note.metadata as Record<string, unknown>) ?? {});
            const projectedMeta = stItem !== undefined
              ? { ...baseMeta, [stItem.field as string]: stItem.to }
              : baseMeta;
            enforceStrict({ path: note.path, tags: [...projectedTags], metadata: projectedMeta });
          }

          let result: Note;
          if (Object.keys(updates).length > 0) {
            // Write-attribution (vault#298): stamp the most-recent-write
            // columns on the same UPDATE that bumps `updated_at`. Only set when
            // there's a real change to write (the empty-updates branch below
            // leaves attribution untouched, symmetric with not bumping
            // updated_at on a no-op).
            updates.actor = writeActor;
            updates.via = writeVia;
            // store.updateNote routes through noteOps.updateNote, which runs
            // the UPDATE (with optional `AND updated_at IS ?`) atomically and
            // throws ConflictError on mismatch. No mutations have happened
            // yet, so a throw here leaves the note untouched.
            result = await store.updateNote(note.id, updates);
          } else {
            result = note;
          }

          // --- Remove links (after core UPDATE so a conflict leaves them intact) ---
          for (const { targetId, relationship } of resolvedLinksToRemove) {
            await store.deleteLink(note.id, targetId, relationship);
          }

          // --- Tags ---
          const tagsOp = item.tags as { add?: string[]; remove?: string[] } | undefined;
          if (tagsOp?.add?.length) {
            await store.tagNote(note.id, tagsOp.add);
            await applySchemaDefaults(store, db, [note.id], tagsOp.add);
          }
          if (tagsOp?.remove?.length) {
            await store.untagNote(note.id, tagsOp.remove);
          }

          // --- Add links ---
          const linksAdd = (item.links as any)?.add as { target: string; relationship: string; metadata?: Record<string, unknown> }[] | undefined;
          if (linksAdd) {
            for (const link of linksAdd) {
              const target = resolveNote(db, link.target);
              if (target) {
                await store.createLink(note.id, target.id, link.relationship, link.metadata);
              }
            }
          }

          // Echo links if this update mutated them (`links.add`/`links.remove`)
          // or the caller asked explicitly. vault feedback #8.
          const linkMutated = (item.links as any)?.add !== undefined || (item.links as any)?.remove !== undefined;
          if (linkMutated || item.include_links === true) {
            echoLinkIds.add(note.id);
          }

          // Re-read for final state
          updated.push(noteOps.getNote(db, note.id) ?? result);
        }
          if (batched) db.exec("COMMIT");
        } catch (e) {
          if (batched) db.exec("ROLLBACK");
          throw e;
        }

        // Response shape: full Note (back-compat default) or lean NoteIndex
        // (#285 friction point 2.response — opt-out for callers making
        // frequent small edits to large notes). `validation_status` from
        // `tags.fields` is preserved across either shape. `created: true|false`
        // (vault#309) is attached to every response so callers using
        // `if_missing: "create"` can tell which branch fired without a
        // separate query. `false` for the (overwhelmingly common) update
        // path; `true` only when this call took the create-on-missing
        // branch.
        const includeContent = params.include_content !== false;
        const final = updated.map((n) => {
          const validated = attachValidationStatus(store, db, n);
          const created = createdIds.has(n.id);
          // Echo hydrated links when this note was flagged for it (mutated
          // its links or `include_links` was set). Additive key, present only
          // when triggered — mirrors the GET / query-notes shape exactly via
          // the shared `linkOps.getLinksHydrated` call. vault feedback #8.
          const echoLinks = echoLinkIds.has(n.id);
          if (includeContent) {
            const full: any = { ...validated, created };
            if (echoLinks) full.links = linkOps.getLinksHydrated(db, n.id);
            return full as Note & { created: boolean };
          }
          const lean: any = noteOps.toNoteIndex(validated);
          const vs = (validated as any).validation_status;
          if (vs !== undefined) lean.validation_status = vs;
          lean.created = created;
          // Carry the link echo across the lean conversion — `toNoteIndex`
          // drops unknown fields.
          if (echoLinks) lean.links = linkOps.getLinksHydrated(db, n.id);
          return lean;
        });
        return batch ? final : final[0];
      },
    },

    // =====================================================================
    // 4. delete-note
    // =====================================================================
    {
      name: "delete-note",
      // `write` — same destructive verb as update-note. Aaron's call
      // 2026-05-27: "delete- in write; right now the only admin gated
      // thing is tokens." Reserving `admin` for "operator-only
      // capabilities" (token mgmt + future config writes). A future
      // finer-grained model might split `vault:write:no-delete` for
      // genuinely append-only callers — gating WITHIN write rather
      // than promoting deletes out of it.
      requiredVerb: "write",
      description: "Permanently delete a note and all its tags and links. Accepts ID or path.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID or path" },
        },
        required: ["id"],
      },
      execute: async (params) => {
        const note = requireNote(db, params.id as string);
        await store.deleteNote(note.id);
        return { deleted: true, id: note.id };
      },
    },

    // =====================================================================
    // 5. list-tags — with optional single-tag detail + schema
    // =====================================================================
    {
      name: "list-tags",
      requiredVerb: "read",
      description: `List tags with usage counts. Pass \`tag\` to get a single tag's full record (description, fields, relationships, parent_names, timestamps). Pass \`include_schema: true\` to include the full record for every tag.`,
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Get details for a single tag" },
          include_schema: { type: "boolean", description: "Include full tag record (description, fields, relationships, parent_names, timestamps) for each tag (default: false)" },
        },
      },
      execute: (params) => {
        const singleTag = params.tag as string | undefined;

        if (singleTag) {
          const allTags = noteOps.listTags(db);
          const found = allTags.find((t) => t.name === singleTag);
          const record = tagSchemaOps.getTagRecord(db, singleTag);
          return {
            name: singleTag,
            count: found?.count ?? 0,
            description: record?.description ?? null,
            fields: record?.fields ?? null,
            relationships: record?.relationships ?? null,
            parent_names: record?.parent_names ?? null,
            created_at: record?.created_at ?? null,
            updated_at: record?.updated_at ?? null,
          };
        }

        const tags = noteOps.listTags(db);
        if (params.include_schema) {
          const records = new Map(
            tagSchemaOps.listTagRecords(db).map((r) => [r.tag, r] as const),
          );
          return tags.map((t) => {
            const r = records.get(t.name);
            return {
              ...t,
              description: r?.description ?? null,
              fields: r?.fields ?? null,
              relationships: r?.relationships ?? null,
              parent_names: r?.parent_names ?? null,
              created_at: r?.created_at ?? null,
              updated_at: r?.updated_at ?? null,
            };
          });
        }
        return tags;
      },
    },

    // =====================================================================
    // 6. update-tag — create/update tag description + schema fields
    // =====================================================================
    {
      name: "update-tag",
      requiredVerb: "write",
      description: "Create or update a tag's identity row: description, indexed-field schemas, relationship-vocabulary map, and hierarchy parents. If the tag doesn't exist, it's created. Fields are merged (new keys added, existing keys replaced); relationships and parent_names are replaced wholesale when provided. Pass null for fields/relationships/parent_names to clear that column. See parachute-patterns/patterns/tag-data-model.md.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Tag name" },
          description: { type: "string", description: "Human-readable description of what this tag means" },
          fields: {
            type: "object",
            description: 'Metadata fields notes with this tag should have. E.g., { "status": { "type": "string", "enum": ["active", "archived"], "strict": true } }. Constraints are ADVISORY by default (violations surface as validation_status warnings; the write still succeeds). Mark a field `strict: true` to ENFORCE all its constraints — type + enum + required + cardinality flip to hard write rejections (vault#299).',
            additionalProperties: {
              type: "object",
              properties: {
                type: { type: "string", description: "Field type: string, boolean, integer, number, array, object" },
                description: { type: "string" },
                enum: { type: "array", items: { type: "string" }, description: "Allowed values (first is default)" },
                indexed: { type: "boolean", description: "When true, a generated column + index are maintained on notes.metadata.<field>, making it queryable via metadata operator objects and order_by. Global: all tags declaring the field must agree on both type and indexed." },
                strict: { type: "boolean", description: "vault#299. Default false (advisory). When true, ALL of this field's declared constraints (type + enum + required + cardinality) are ENFORCED — a violating write is rejected with a schema_validation error, not just warned. All-or-nothing per field; free-form fields on a strict tag simply leave strict off." },
                required: { type: "boolean", description: "vault#299. The field must be present + non-null on a note with this tag. Advisory unless `strict: true`." },
                cardinality: { type: "string", enum: ["one", "many"], description: "vault#299. 'one' (scalar, default) or 'many' (array). Advisory unless `strict: true`." },
              },
              required: ["type"],
            },
          },
          relationships: {
            type: "object",
            description: 'Opaque relationship-vocabulary map: keys are relationship names, values are arbitrary JSON the declaring app interprets. Vault stores and returns the values verbatim and does NOT enforce any inner shape — only that this is a JSON object (a map), not an array or primitive. Replaces any prior map wholesale when provided; pass null to clear. The historical typed shape { "lives_in": { "target_tag": "place", "cardinality": "one" } } is still a valid value, as is any app-defined shape e.g. { "works-on": { "from": "person", "to": "project" } }.',
            additionalProperties: true,
          },
          parent_names: {
            type: "array",
            items: { type: "string" },
            description: "Tag names this tag is a child of, for the query-time hierarchy. Replaces any prior parent list. Pass [] (empty array) or null to clear. E.g., parent_names: [\"manual\", \"note\"] makes this tag a descendant of both.",
          },
        },
        required: ["tag"],
      },
      execute: async (params) => {
        const tag = params.tag as string;
        const existing = tagSchemaOps.getTagRecord(db, tag);

        // ---- fields: three-way semantics, distinguishing `null` from
        // `undefined` (do NOT collapse with `?? {}` — that silently turns an
        // explicit clear-all into a no-op, the gitcoin orphaned-fields bug).
        //   - undefined  → no change. Preserve every existing field; declare
        //                  nothing new. mergedFields === existing.fields.
        //   - null       → clear ALL of this tag's field schemas.
        //                  mergedFields = {} so the diff below releases every
        //                  indexed field this tag exclusively declares.
        //   - object     → shallow-merge into existing (preserves prior keys).
        const incomingFields =
          params.fields === null || params.fields === undefined
            ? {}
            : (params.fields as Record<string, TagFieldSchema>);
        const mergedFields: Record<string, TagFieldSchema> =
          params.fields === null
            ? {}
            : { ...(existing?.fields ?? {}), ...incomingFields };

        // Validate cross-tag consistency on fields being (re)declared in this
        // call. `type` and `indexed` are global — all declarers must agree.
        const otherSchemas = tagSchemaOps
          .listTagSchemas(db)
          .filter((s) => s.tag !== tag);
        for (const [fieldName, spec] of Object.entries(incomingFields)) {
          const incomingIndexed = spec.indexed === true;
          for (const other of otherSchemas) {
            const otherSpec = other.fields?.[fieldName];
            if (!otherSpec) continue;
            if (otherSpec.type !== spec.type) {
              throw new Error(
                `field "${fieldName}" type conflict: tag "${tag}" declares "${spec.type}"; tag "${other.tag}" declares "${otherSpec.type}". Types must agree across all declarers.`,
              );
            }
            if ((otherSpec.indexed === true) !== incomingIndexed) {
              throw new Error(
                `field "${fieldName}" indexed-flag conflict: tag "${tag}" sets indexed=${incomingIndexed}; tag "${other.tag}" sets indexed=${otherSpec.indexed === true}. Must match across all declarers — change them atomically or not at all.`,
              );
            }
          }
          if (incomingIndexed) {
            const mapped = indexedFieldOps.mapFieldType(spec.type);
            if (!mapped) {
              throw new Error(
                `field "${fieldName}" has unsupported type "${spec.type}" for indexing (supported: string, integer, boolean)`,
              );
            }
            indexedFieldOps.validateFieldName(fieldName);
          }
        }

        // ---- relationships: replace wholesale when provided. `relationships`
        // is an opaque vocabulary map (relationship-name → arbitrary JSON the
        // app interprets). Validate only that it's a JSON object (a map), then
        // persist verbatim — no inner-shape enforcement.
        let relationshipsPatch: tagSchemaOps.TagRelationshipMap | null | undefined;
        if (params.relationships === null) {
          relationshipsPatch = null;
        } else if (params.relationships !== undefined) {
          relationshipsPatch = tagSchemaOps.validateRelationships(params.relationships);
        }

        // ---- parent_names: replace wholesale when provided. Empty array
        // collapses to null (clear) — a tag with `parent_names = []` and
        // a tag with `parent_names = null` are indistinguishable at the
        // hierarchy layer.
        let parentNamesPatch: string[] | null | undefined;
        if (params.parent_names === null) {
          parentNamesPatch = null;
        } else if (params.parent_names !== undefined) {
          if (!Array.isArray(params.parent_names)) {
            throw new Error("parent_names must be an array of tag names");
          }
          const cleaned = (params.parent_names as unknown[])
            .filter((p): p is string => typeof p === "string" && p.length > 0);
          parentNamesPatch = cleaned.length > 0 ? cleaned : null;
        }

        // ---- Persist via the store wrapper so the hierarchy cache is
        // invalidated when parent_names is touched.
        const fieldsPatch = Object.keys(mergedFields).length > 0
          ? mergedFields
          : (params.fields !== undefined ? null : undefined);
        const descriptionPatch =
          params.description === undefined ? undefined : (params.description as string);
        // The indexed-field lifecycle (declareField for added indexed fields,
        // releaseField for removed ones, with the co-declaration guard) is
        // reconciled inside store.upsertTagRecord — the single chokepoint all
        // callers (MCP, REST PUT /tags/:name, import) share — so it can't be
        // bypassed. The cross-tag validation above stays here to surface a
        // clean error before persisting. See the gitcoin orphaned-fields bug.
        const result = await store.upsertTagRecord(tag, {
          ...(descriptionPatch !== undefined ? { description: descriptionPatch } : {}),
          ...(fieldsPatch !== undefined ? { fields: fieldsPatch } : {}),
          ...(relationshipsPatch !== undefined ? { relationships: relationshipsPatch } : {}),
          ...(parentNamesPatch !== undefined ? { parent_names: parentNamesPatch } : {}),
        });

        return result;
      },
    },

    // =====================================================================
    // 7. delete-tag — delete tag + schema from all notes
    // =====================================================================
    {
      name: "delete-tag",
      // `write` — Aaron's call 2026-05-27: admin reserved for token
      // mgmt + future config writes; deletes are write-tier mutations.
      // See delete-note rationale.
      requiredVerb: "write",
      description: "Delete a tag, remove it from all notes, and delete its schema. Notes themselves are NOT deleted — just untagged.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Tag name to delete" },
        },
        required: ["tag"],
      },
      execute: async (params) => {
        const tag = params.tag as string;
        // Drop the row outright — description/fields/relationships/parents
        // travel with it. (No more sidecar table to clear separately.)
        // Indexed-field release is handled inside store.deleteTag →
        // noteOps.deleteTag so every entry point (MCP, REST, import sweep)
        // releases consistently with the co-declaration guard. See the
        // gitcoin orphaned-fields bug report.
        return await store.deleteTag(tag);
      },
    },

    // =====================================================================
    // 8. find-path — BFS between two notes
    // =====================================================================
    {
      name: "find-path",
      requiredVerb: "read",
      description: "Find the shortest path between two notes in the link graph. Accepts IDs or paths. Returns the chain of note IDs and relationships, or null if no path exists.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Starting note ID or path" },
          target: { type: "string", description: "Destination note ID or path" },
          max_depth: { type: "number", description: "Max path length (default 5)" },
        },
        required: ["source", "target"],
      },
      execute: (params) => {
        const source = requireNote(db, params.source as string);
        const target = requireNote(db, params.target as string);
        return linkOps.findPath(db, source.id, target.id, {
          max_depth: Math.min((params.max_depth as number) ?? 5, 10),
        });
      },
    },

    // =====================================================================
    // 9. vault-info — get/update vault description + stats
    // =====================================================================
    {
      name: "vault-info",
      // `read` so vault:read callers can fetch stats. The
      // description-update branch performs an inner write-check (see
      // overrideVaultInfo in src/mcp-tools.ts) — do not promote this to
      // `write` or read-only callers lose the stats projection.
      requiredVerb: "read",
      description: "Get a comprehensive vault projection: name, description, tags-with-schemas (own + effective parents/fields per #270 inheritance), indexed metadata fields catalog, and query hints. Pass `include_stats: true` to add note/tag/link counts and the monthly distribution. Pass `description` to update the vault description (changes how AI agents behave in future sessions). Call this anytime mid-session to refresh schema context.",
      inputSchema: {
        type: "object",
        properties: {
          include_stats: { type: "boolean", description: "Include note count, tag count, attachment/link counts, and the monthly note distribution (default: false)" },
          description: { type: "string", description: "If provided, updates the vault description" },
        },
      },
      // execute is overridden in mcp-tools.ts where vault config is available
      execute: () => {
        // This is a placeholder — vault-info needs access to vault config,
        // which is only available in the server layer (mcp-tools.ts).
        return { error: "vault-info must be configured by the server layer" };
      },
    },

    // =====================================================================
    // 10. prune-schema — drop orphaned indexed-field columns
    // =====================================================================
    {
      name: "prune-schema",
      // `admin` — a destructive schema-maintenance op, same tier as
      // manage-token. Operator-only; hidden from read/write sessions.
      requiredVerb: "admin",
      description:
        "Drop orphaned indexed-field columns + indexes whose declaring tags no longer exist (the result of a deleted tag never releasing its fields). Dry-run by default — returns the drop plan without mutating. Pass `apply: true` to execute. A field co-declared by a still-live tag is never dropped; only the dead declarers are trimmed from its set. Generated columns are derived from notes.metadata JSON, so a drop loses only the index, never source data — declare the field again to rebuild it.",
      inputSchema: {
        type: "object",
        properties: {
          apply: {
            type: "boolean",
            description: "Execute the prune. Default false (dry-run — report what would be dropped without changing anything).",
          },
        },
      },
      execute: async (params) => {
        const apply = params.apply === true;
        const plan = await store.pruneIndexedFields({ dryRun: !apply });
        const dropped = plan.filter((p) => p.dropped);
        const trimmed = plan.filter((p) => !p.dropped);
        return {
          dry_run: !apply,
          fields_dropped: dropped.map((p) => ({ field: p.field, dead_declarers: p.deadDeclarers })),
          fields_trimmed: trimmed.map((p) => ({ field: p.field, dead_declarers: p.deadDeclarers })),
          summary: apply
            ? `pruned ${dropped.length} orphaned field(s); trimmed dead declarers on ${trimmed.length} co-declared field(s)`
            : `would prune ${dropped.length} orphaned field(s); would trim dead declarers on ${trimmed.length} co-declared field(s) — pass apply:true to execute`,
        };
      },
    },

  ];
}

// ---------------------------------------------------------------------------
// Tag schema effects — auto-populate defaults when tags are applied
// ---------------------------------------------------------------------------

/**
 * Fill schema-declared default values into the metadata of the given notes
 * for any field they omitted. Returns the IDs of the notes whose metadata was
 * actually written — callers use this to re-read ONLY the mutated notes (and
 * to skip the re-read entirely when nothing changed). The common no-schema /
 * no-defaults path returns an empty array.
 *
 * vault#299: this runs AFTER the create write (so AFTER the strict gate) and
 * intentionally does NOT re-run `enforceStrict`. Defaults are always
 * conforming by construction — `defaultForField` returns the first enum value
 * / the type's zero-value, so a default can never violate type/enum. And a
 * `required` strict field is already caught at the pre-write gate, so a note
 * that would need a default to satisfy `required` never reaches this filler
 * (the create was rejected first). Don't add a defaults path that could
 * inject a violating value without re-gating.
 */
async function applySchemaDefaults(store: Store, db: Database, noteIds: string[], tags: string[]): Promise<string[]> {
  const schemas = tagSchemaOps.getTagSchemaMap(db);
  if (Object.keys(schemas).length === 0) return [];

  const defaults: Record<string, unknown> = {};
  for (const tag of tags) {
    const schema = schemas[tag];
    if (!schema?.fields) continue;
    for (const [field, fieldSchema] of Object.entries(schema.fields)) {
      if (!(field in defaults)) {
        defaults[field] = defaultForField(fieldSchema);
      }
    }
  }
  if (Object.keys(defaults).length === 0) return [];

  const mutated: string[] = [];
  for (const noteId of noteIds) {
    const note = noteOps.getNote(db, noteId);
    if (!note) continue;
    const existing = (note.metadata as Record<string, unknown>) ?? {};
    const missing: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(defaults)) {
      if (!(field in existing)) {
        missing[field] = value;
      }
    }
    if (Object.keys(missing).length === 0) continue;
    await store.updateNote(noteId, {
      metadata: { ...existing, ...missing },
      skipUpdatedAt: true,
    });
    mutated.push(noteId);
  }
  return mutated;
}

function defaultForField(field: { type: string; enum?: string[] }): unknown {
  if (field.enum && field.enum.length > 0) return field.enum[0];
  switch (field.type) {
    case "boolean": return false;
    case "integer": return 0;
    default: return "";
  }
}

// ---------------------------------------------------------------------------
// `tags.fields` validation — surface validation_status on create/update
// ---------------------------------------------------------------------------

/**
 * Attach a `validation_status` field to the response when at least one tag
 * on the note declares `fields` on its `tags` row. Validation is advisory
 * only — writes are never blocked. The agent receives warnings (type
 * mismatch, enum mismatch) so it can self-correct on the next turn.
 *
 * Returns the note unchanged when no tag declares fields, so callers
 * without any tag schemas see no behavior change.
 *
 * Exported so both transports (MCP `update-note` here, HTTP `PATCH
 * /api/notes/:id` in `src/routes.ts`) attach the same status field by
 * the same recipe — see vault#287 for the asymmetry that motivated
 * exposing it.
 */
/**
 * Pre-write strict-schema gate (vault#299 Part A). Shared by both write
 * transports (MCP tools here, REST PATCH/POST in `src/routes.ts`) so the
 * enforcement contract can't drift between them — the same recipe the
 * `validation_status` attachment shares via `attachValidationStatus`.
 *
 * Validates the PROSPECTIVE note shape (final tags + merged metadata) against
 * the resolved schemas and:
 *   - no strict violations → no-op, the write proceeds.
 *   - violations + `bypass:false` → throw `SchemaValidationError` (one error,
 *     all per-field violations — settled lead #1). Caller writes nothing.
 *   - violations + `bypass:true` → invoke `onBypass(violations)` (migration
 *     scope) and return; the caller proceeds with the non-conforming write.
 *
 * Returns the would-be violations (empty when none) so a caller can inspect
 * them; the throw / bypass decision is already made internally.
 */
export function enforceStrictWrite(
  store: Store,
  shape: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> },
  opts?: { bypass?: boolean; onBypass?: (violations: ValidationWarning[]) => void },
): ValidationWarning[] {
  const status = store.validateNoteAgainstSchemas(shape);
  const violations = strictViolations(status);
  if (violations.length === 0) return [];
  if (opts?.bypass !== true) throw new SchemaValidationError(violations);
  opts.onBypass?.(violations);
  return violations;
}

export function attachValidationStatus(store: Store, _db: Database, note: Note): Note {
  // Short-circuit cheaply: when no tag declares fields, the resolver
  // returns null without us paying a re-read of the note.
  const status = store.validateNoteAgainstSchemas({
    path: note.path,
    tags: note.tags,
    metadata: note.metadata as Record<string, unknown> | undefined,
  });
  if (!status) return note;
  return { ...note, validation_status: status } as Note & { validation_status: typeof status };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeTags(tag: unknown): string[] | undefined {
  if (!tag) return undefined;
  // Defensive copy: callers downstream sometimes mutate the array (sort,
  // splice, push for hierarchy expansion). Returning a fresh array keeps
  // the original `params` object untouched.
  if (Array.isArray(tag)) return [...tag];
  return [tag as string];
}

/**
 * Coerce the `link_count_direction` MCP param to a known value, defaulting
 * to "both" (matches the REST `parseLinkCountDirection` fallback). A typo
 * silently degrades to the documented default rather than erroring.
 */
function normalizeLinkCountDirection(v: unknown): "both" | "outbound" | "inbound" {
  if (v === "outbound" || v === "inbound") return v;
  return "both";
}

// Re-exported for backward compat; defined in notes.ts alongside the
// conditional-UPDATE implementation that raises it. AmbiguousPathError
// joins the set (vault#331 N2) so external callers can `instanceof`
// it without crossing module boundaries.
export { ConflictError, PathConflictError, AmbiguousPathError, TransitionConflictError, MAX_BATCH_SIZE } from "./notes.js";
// vault#299: strict-schema enforcement error, re-exported alongside the other
// write-path domain errors so external callers can `instanceof` it without
// crossing module boundaries.
export { SchemaValidationError } from "./schema-defaults.js";

/**
 * Thrown by the `update-note` MCP tool (and the REST PATCH handler) when a
 * caller tries to mutate a note without either an `if_updated_at` token or
 * an explicit `force: true` opt-out. The `if_updated_at` requirement is the
 * safety-by-default posture — we'd rather refuse an ambiguous write than
 * silently overwrite someone else's edit.
 */
export class PreconditionRequiredError extends Error {
  code = "PRECONDITION_REQUIRED" as const;
  note_id: string;
  note_path: string | null;

  constructor(noteId: string, notePath: string | null) {
    super(
      `precondition required: update-note rejects an item without \`if_updated_at\` (read the note's updated_at and echo it) or \`force: true\` (explicit override). note="${noteId}"`,
    );
    this.name = "PreconditionRequiredError";
    this.note_id = noteId;
    this.note_path = notePath;
  }
}

/**
 * Thrown by `create-note` / `update-note` when a batch exceeds
 * `MAX_BATCH_SIZE` (re-exported from `./notes.js` — single source of truth).
 * Bounds the blast radius of a runaway client — see #213, where one MCP
 * burst created 7,453 empty notes in minutes. Surfaces as 413 at the HTTP
 * layer.
 */
export class BatchTooLargeError extends Error {
  code = "BATCH_TOO_LARGE" as const;
  limit: number;
  got: number;

  constructor(got: number) {
    super(`batch_too_large: max ${MAX_BATCH_SIZE} notes per call, got ${got}`);
    this.name = "BatchTooLargeError";
    this.limit = MAX_BATCH_SIZE;
    this.got = got;
  }
}

