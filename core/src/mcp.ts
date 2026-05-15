import { Database } from "bun:sqlite";
import type { Store, Note } from "./types.js";
import * as noteOps from "./notes.js";
import { filterMetadata, MAX_BATCH_SIZE, validateExtension, ExtensionValidationError } from "./notes.js";
import * as linkOps from "./links.js";
import * as tagSchemaOps from "./tag-schemas.js";
import type { TagFieldSchema } from "./tag-schemas.js";
import * as indexedFieldOps from "./indexed-fields.js";
import {
  expandContent,
  DEFAULT_EXPAND_DEPTH,
  MAX_EXPAND_DEPTH,
  type ExpandContext,
  type ExpandMode,
} from "./expand.js";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => unknown | Promise<unknown>;
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
 * Generate the consolidated MCP tools for a vault. Post-v17 surface (9):
 * query-notes, create-note, update-note, delete-note, list-tags, update-tag,
 * delete-tag, find-path, vault-info.
 */
export function generateMcpTools(store: Store): McpToolDef[] {
  const db: Database = (store as any).db;

  return [

    // =====================================================================
    // 1. query-notes — the universal read tool
    // =====================================================================
    {
      name: "query-notes",
      description: `Query notes. Returns notes matching the given filters.

- **Single note**: pass \`id\` (accepts note ID or path, e.g., "Projects/README")
- **Filter**: pass \`tag\`, \`path\`, \`path_prefix\`, \`search\`, \`metadata\`, date range
- **Graph neighborhood**: pass \`near\` to scope results to notes within N hops of an anchor note
- **No filters**: returns all notes (paginated)

Defaults: include_content=true for single note, false for lists. include_links=false. tag_match="any".

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
          order_by: { type: "string", description: "Sort by an indexed metadata field instead of `created_at`. Field must be declared `indexed: true`; errors otherwise. Direction is taken from `sort` (default 'asc'); `created_at` is appended as a stable tiebreaker." },
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
          include_content: { type: "boolean", description: "Include note content (default: true for single, false for list)" },
          include_metadata: {
            oneOf: [
              { type: "boolean" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Control metadata in response: true (all, default), false (none), or array of field names to include",
          },
          include_links: { type: "boolean", description: "Include inbound + outbound links per note (default: false)" },
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
          ? { db, mode: expandMode, expanded: new Set() }
          : null;

        // --- Single note by ID/path ---
        if (params.id) {
          const note = resolveNote(db, params.id as string);
          if (!note) return { error: "Note not found", id: params.id };
          const includeContent = params.include_content !== false; // default true for single
          let result: any = includeContent ? { ...note } : noteOps.toNoteIndex(note);
          if (expandCtx && includeContent && typeof result.content === "string") {
            // Mark the top-level note as already expanded so it can't recursively inline itself.
            expandCtx.expanded.add(note.id);
            result.content = expandContent(result.content, expandCtx, expandDepth);
          }
          result = filterMetadata(result, params.include_metadata as boolean | string[] | undefined);
          if (params.include_links) {
            result.links = linkOps.getLinksHydrated(db, note.id);
          }
          if (params.include_attachments) {
            result.attachments = await store.getAttachments(note.id);
          }
          return result;
        }

        // --- Build near-scope (graph-filtered set of allowed IDs) ---
        let nearScope: Set<string> | null = null;
        if (params.near) {
          const near = params.near as { note_id: string; depth?: number; relationship?: string };
          const anchor = resolveNote(db, near.note_id);
          if (!anchor) return { error: "Anchor note not found", note_id: near.note_id };
          const depth = Math.min(near.depth ?? 2, 5);
          const traversed = linkOps.traverseLinks(db, anchor.id, {
            max_depth: depth,
            relationship: near.relationship,
          });
          nearScope = new Set([anchor.id, ...traversed.map((t) => t.noteId)]);
        }

        // --- Full-text search ---
        let results: Note[];
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
          // Route through `store.queryNotes` (not `noteOps.queryNotes`) so
          // tag-hierarchy expansion fires for MCP callers the same as for
          // HTTP REST callers — `tag: "manual"` matches descendants declared
          // via `_tags/*` config notes. The previous direct-noteOps call
          // bypassed the wrapper and silently dropped hierarchy expansion.
          results = await store.queryNotes({
            tags,
            tagMatch: (params.tag_match as "all" | "any") ?? (tags && tags.length > 1 ? "any" : undefined),
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
            dateFrom: params.date_from as string | undefined,
            dateTo: params.date_to as string | undefined,
            dateFilter: params.date_filter as
              | { field?: string; from?: string; to?: string }
              | undefined,
            sort: params.sort as "asc" | "desc" | undefined,
            orderBy: params.order_by as string | undefined,
            limit: (params.limit as number) ?? 50,
            offset: params.offset as number | undefined,
          });
        }

        // For full-text search the post-filter is still the right shape — FTS
        // owns its own ranked LIMIT and we just narrow to the neighborhood
        // afterwards. Structured queries already pushed `ids` into SQL above.
        if (nearScope && params.search) {
          results = results.filter((n) => nearScope!.has(n.id));
        }

        // --- Format output ---
        const includeContent = params.include_content === true; // default false for list
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

        // --- Apply metadata filtering ---
        if (includeMetadata !== undefined && includeMetadata !== true) {
          output = output.map((n: any) => filterMetadata(n, includeMetadata));
        }

        // --- Hydrate links/attachments per note if requested ---
        if (params.include_links || params.include_attachments) {
          const enrichedOut: any[] = [];
          for (const n of output as any[]) {
            const enriched: any = { ...n };
            if (params.include_links) enriched.links = linkOps.getLinksHydrated(db, n.id);
            if (params.include_attachments) enriched.attachments = await store.getAttachments(n.id);
            enrichedOut.push(enriched);
          }
          return enrichedOut;
        }

        return output;
      },
    },

    // =====================================================================
    // 2. create-note — single or batch
    // =====================================================================
    {
      name: "create-note",
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
            const note = await store.createNote(item.content as string ?? "", {
              path: item.path as string | undefined,
              tags: item.tags as string[] | undefined,
              metadata: item.metadata as Record<string, unknown> | undefined,
              created_at: item.created_at as string | undefined,
              ...(extension !== undefined ? { extension } : {}),
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

        // Apply tag schema effects
        for (const note of created) {
          if (note.tags && note.tags.length > 0) {
            await applySchemaDefaults(store, db, [note.id], note.tags);
          }
        }

        // Re-read after schema-default population so the response reflects the
        // final on-disk state, then attach `validation_status` from any
        // tag's `fields` declaration that applies to this note.
        const final = created.map((n) => attachValidationStatus(store, db, n));
        return batch ? final : final[0];
      },
    },

    // =====================================================================
    // 3. update-note — single or batch, absorbs tag/untag + link add/remove
    // =====================================================================
    {
      name: "update-note",
      description: `Update one or more notes. Accepts ID or path. Supports content, path, metadata updates plus tag and link mutations.

- Three content-modification modes (mutually exclusive):
  - \`content\` — full replace.
  - \`append\` / \`prepend\` — atomic concatenation at the SQL layer. Multiple agents appending to the same note never overwrite each other. No separator is added; include trailing/leading whitespace yourself if needed. May be combined with each other.
  - \`content_edit: { old_text, new_text }\` — surgical find-and-replace. \`old_text\` must occur exactly once; zero or multiple matches return an error. Add surrounding context to disambiguate.
- \`tags: { add: ["x"], remove: ["y"] }\` — add/remove tags
- \`links: { add: [{ target, relationship }], remove: [{ target, relationship }] }\` — add/remove links
- When removing a wikilink-type link, \`[[brackets]]\` are also removed from content.
- For batch: pass a \`notes\` array, each with an \`id\` field.
- **Optimistic concurrency is required by default.** Pass \`if_updated_at\` with the \`updated_at\` value you last read — the update is rejected with a conflict error if the note has changed since. Re-read, reconcile, and retry. To skip the safety check (e.g. bulk migration), pass \`force: true\` instead; the update then runs unconditionally. \`append\` / \`prepend\` only updates are exempt from the precondition (no-conflict-by-design).
- **Idempotent upsert via \`if_missing: "create"\`** — when the note doesn't exist, create it from this same payload (content/path/tags/metadata become the create fields; OC precondition skipped — nothing to conflict with). Response carries \`created: true\`. Useful for nightly sync loops that don't know ahead of time whether the note exists. Default \`"fail"\` (current behavior — missing note errors). See vault#309.
- \`include_content\` (default \`true\`) — set \`false\` to receive a lean index shape (\`id\`, \`path\`, \`createdAt\`, \`updatedAt\`, \`tags\`, \`metadata\`, \`byteSize\`, \`preview\`) instead of full content. Useful for agents making frequent small edits to large notes (e.g. via \`append\` or \`content_edit\`) where re-receiving the body is the dominant cost. \`validation_status\` is preserved on the lean shape when present.`,
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
          metadata: { type: "object", description: "Metadata to merge (keys are merged, not replaced wholesale)" },
          created_at: { type: "string", description: "New created_at timestamp" },
          if_updated_at: { type: "string", description: "Optimistic concurrency check: the updated_at value you last read. Rejects with a conflict error if the note has been modified since. Required unless `force: true` is set or the call is `append`/`prepend`-only." },
          force: { type: "boolean", description: "Override the required `if_updated_at` check and run the update unconditionally. Use only for bulk migrations or scripted writes where concurrency is known-safe." },
          if_missing: { type: "string", enum: ["fail", "create"], description: "What to do when the note (by `id`/path) doesn't exist. `\"fail\"` (default) — error, current behavior. `\"create\"` — create the note from this same payload (content/path/tags/metadata become the create fields; the response carries `created: true`). Skips the `if_updated_at` precondition on the create branch (nothing to conflict with). Idempotent for sync loops that don't know ahead of time whether the note exists. See vault#309." },
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
                force: { type: "boolean", description: "Override the required `if_updated_at` check for this item." },
                if_missing: { type: "string", enum: ["fail", "create"], description: "Per-item: see top-level `if_missing` docs. Each batch item carries its own setting." },
                tags: { type: "object" },
                links: { type: "object" },
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
              };
              const content = (item.content as string | undefined) ?? "";
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
          if (!isAppendOnly && item.if_updated_at === undefined && item.force !== true) {
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
            // Merge metadata (don't replace wholesale)
            const existing = (note.metadata as Record<string, unknown>) ?? {};
            updates.metadata = { ...existing, ...(item.metadata as Record<string, unknown>) };
          }
          if (item.created_at !== undefined) updates.created_at = item.created_at;
          if (item.if_updated_at !== undefined) updates.if_updated_at = item.if_updated_at as string;

          let result: Note;
          if (Object.keys(updates).length > 0) {
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
          if (includeContent) return { ...validated, created } as Note & { created: boolean };
          const lean: any = noteOps.toNoteIndex(validated);
          const vs = (validated as any).validation_status;
          if (vs !== undefined) lean.validation_status = vs;
          lean.created = created;
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
      description: "Create or update a tag's identity row: description, indexed-field schemas, typed-link relationships, and hierarchy parents. If the tag doesn't exist, it's created. Fields are merged (new keys added, existing keys replaced); relationships and parent_names are replaced wholesale when provided. Pass null for fields/relationships/parent_names to clear that column. See parachute-patterns/patterns/tag-data-model.md.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Tag name" },
          description: { type: "string", description: "Human-readable description of what this tag means" },
          fields: {
            type: "object",
            description: 'Metadata fields notes with this tag should have. E.g., { "status": { "type": "string", "enum": ["active", "archived"] } }',
            additionalProperties: {
              type: "object",
              properties: {
                type: { type: "string", description: "Field type: string, boolean, integer" },
                description: { type: "string" },
                enum: { type: "array", items: { type: "string" }, description: "Allowed values (first is default)" },
                indexed: { type: "boolean", description: "When true, a generated column + index are maintained on notes.metadata.<field>, making it queryable via metadata operator objects and order_by. Global: all tags declaring the field must agree on both type and indexed." },
              },
              required: ["type"],
            },
          },
          relationships: {
            type: "object",
            description: 'Typed-link declarations. Each value declares { target_tag, cardinality, description? }. Cardinality is one of: one | optional | many | many-required. Phase 1: informational, not enforced at write time. E.g., { "lives_in": { "target_tag": "place", "cardinality": "one" } }',
            additionalProperties: {
              type: "object",
              properties: {
                target_tag: { type: "string", description: "Tag the relationship points at" },
                cardinality: { type: "string", enum: ["one", "optional", "many", "many-required"], description: "How many targets this relationship may have" },
                description: { type: "string", description: "Why this relationship exists; surfaced to AI clients" },
              },
              required: ["target_tag", "cardinality"],
            },
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

        // ---- fields: shallow-merge into existing (preserves prior keys).
        const incomingFields = (params.fields as Record<string, TagFieldSchema> | undefined) ?? {};
        const mergedFields: Record<string, TagFieldSchema> = {
          ...(existing?.fields ?? {}),
          ...incomingFields,
        };

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

        // ---- relationships: replace wholesale when provided. Validate
        // shape + cardinality vocabulary before persisting so a malformed
        // payload can't leave the row in an inconsistent state.
        let relationshipsPatch: Record<string, tagSchemaOps.TagRelationship> | null | undefined;
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
        const result = await store.upsertTagRecord(tag, {
          ...(descriptionPatch !== undefined ? { description: descriptionPatch } : {}),
          ...(fieldsPatch !== undefined ? { fields: fieldsPatch } : {}),
          ...(relationshipsPatch !== undefined ? { relationships: relationshipsPatch } : {}),
          ...(parentNamesPatch !== undefined ? { parent_names: parentNamesPatch } : {}),
        });

        // ---- Reconcile indexed-field lifecycle for this tag.
        const priorIndexed = new Set(
          Object.entries(existing?.fields ?? {})
            .filter(([, v]) => v.indexed === true)
            .map(([k]) => k),
        );
        const nextIndexed = new Set(
          Object.entries(mergedFields)
            .filter(([, v]) => v.indexed === true)
            .map(([k]) => k),
        );
        for (const fieldName of nextIndexed) {
          const spec = mergedFields[fieldName]!;
          const mapped = indexedFieldOps.mapFieldType(spec.type)!;
          indexedFieldOps.declareField(db, fieldName, mapped, tag);
        }
        for (const fieldName of priorIndexed) {
          if (!nextIndexed.has(fieldName)) {
            indexedFieldOps.releaseField(db, fieldName, tag);
          }
        }

        return result;
      },
    },

    // =====================================================================
    // 7. delete-tag — delete tag + schema from all notes
    // =====================================================================
    {
      name: "delete-tag",
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
        // Release any indexed fields this tag declared before the row
        // drops. releaseField drops the generated column + index when the
        // declarer set empties.
        const schema = tagSchemaOps.getTagSchema(db, tag);
        if (schema?.fields) {
          for (const [fieldName, spec] of Object.entries(schema.fields)) {
            if (spec.indexed === true) {
              indexedFieldOps.releaseField(db, fieldName, tag);
            }
          }
        }
        // Drop the row outright — description/fields/relationships/parents
        // travel with it. (No more sidecar table to clear separately.)
        return await store.deleteTag(tag);
      },
    },

    // =====================================================================
    // 8. find-path — BFS between two notes
    // =====================================================================
    {
      name: "find-path",
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

  ];
}

// ---------------------------------------------------------------------------
// Tag schema effects — auto-populate defaults when tags are applied
// ---------------------------------------------------------------------------

async function applySchemaDefaults(store: Store, db: Database, noteIds: string[], tags: string[]): Promise<void> {
  const schemas = tagSchemaOps.getTagSchemaMap(db);
  if (Object.keys(schemas).length === 0) return;

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
  if (Object.keys(defaults).length === 0) return;

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
  }
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

// Re-exported for backward compat; defined in notes.ts alongside the
// conditional-UPDATE implementation that raises it. AmbiguousPathError
// joins the set (vault#331 N2) so external callers can `instanceof`
// it without crossing module boundaries.
export { ConflictError, PathConflictError, AmbiguousPathError, MAX_BATCH_SIZE } from "./notes.js";

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

