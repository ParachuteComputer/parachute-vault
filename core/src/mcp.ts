import { Database } from "bun:sqlite";
import type { Store, Note } from "./types.js";
import * as noteOps from "./notes.js";
import { filterMetadata } from "./notes.js";
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
 * Resolve a note identifier — tries ID first, then case-insensitive path match.
 * Works everywhere a note reference is accepted.
 */
function resolveNote(db: Database, idOrPath: string): Note | null {
  // Try ID match first (fast, indexed)
  const byId = noteOps.getNote(db, idOrPath);
  if (byId) return byId;
  // Fallback to path match
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
 * Generate the 9 consolidated MCP tools for a vault.
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
          exclude_tags: { type: "array", items: { type: "string" }, description: "Exclude notes with these tags" },
          has_tags: { type: "boolean", description: "Presence filter: true = only notes with at least one tag; false = only untagged notes. Ignored when `tag` is set." },
          has_links: { type: "boolean", description: "Presence filter: true = only notes with at least one inbound or outbound link; false = only orphaned notes (no links in either direction)." },
          path: { type: "string", description: "Exact path match (case-insensitive)" },
          path_prefix: { type: "string", description: "Path prefix match (e.g., 'Projects/')" },
          search: { type: "string", description: "Full-text search query" },
          metadata: {
            type: "object",
            description: "Filter by metadata values. Each value is either a primitive (exact match, scans JSON) or an operator object: `{eq|ne|gt|gte|lt|lte|in|not_in|exists: value}`. Operator objects require the field to be declared `indexed: true` in a tag schema — they route through the backing B-tree index. Multiple operators on one field AND together (e.g. `{gt: 5, lt: 10}`). `in`/`not_in` take arrays; `exists` takes a boolean.",
          },
          order_by: { type: "string", description: "Sort by an indexed metadata field instead of `created_at`. Field must be declared `indexed: true`; errors otherwise. Direction is taken from `sort` (default 'asc'); `created_at` is appended as a stable tiebreaker." },
          date_from: { type: "string", description: "Start date (ISO, inclusive)" },
          date_to: { type: "string", description: "End date (ISO, exclusive)" },
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
          results = noteOps.searchNotes(db, params.search as string, {
            tags,
            limit: (params.limit as number) ?? 50,
          });
        } else {
          // --- Structured query ---
          const tags = normalizeTags(params.tag);
          results = noteOps.queryNotes(db, {
            tags,
            tagMatch: (params.tag_match as "all" | "any") ?? (tags && tags.length > 1 ? "any" : undefined),
            excludeTags: params.exclude_tags as string[] | undefined,
            hasTags: params.has_tags as boolean | undefined,
            hasLinks: params.has_links as boolean | undefined,
            path: params.path as string | undefined,
            pathPrefix: params.path_prefix as string | undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
            dateFrom: params.date_from as string | undefined,
            dateTo: params.date_to as string | undefined,
            sort: params.sort as "asc" | "desc" | undefined,
            orderBy: params.order_by as string | undefined,
            limit: (params.limit as number) ?? 50,
            offset: params.offset as number | undefined,
          });
        }

        // --- Apply near-scope filter ---
        if (nearScope) {
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

        const created: Note[] = [];
        for (const item of items) {
          const note = await store.createNote(item.content as string ?? "", {
            path: item.path as string | undefined,
            tags: item.tags as string[] | undefined,
            metadata: item.metadata as Record<string, unknown> | undefined,
            created_at: item.created_at as string | undefined,
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

        // Apply tag schema effects
        for (const note of created) {
          if (note.tags && note.tags.length > 0) {
            await applySchemaDefaults(store, db, [note.id], note.tags);
          }
        }

        return batch ? created : created[0];
      },
    },

    // =====================================================================
    // 3. update-note — single or batch, absorbs tag/untag + link add/remove
    // =====================================================================
    {
      name: "update-note",
      description: `Update one or more notes. Accepts ID or path. Supports content, path, metadata updates plus tag and link mutations.

- \`tags: { add: ["x"], remove: ["y"] }\` — add/remove tags
- \`links: { add: [{ target, relationship }], remove: [{ target, relationship }] }\` — add/remove links
- When removing a wikilink-type link, \`[[brackets]]\` are also removed from content.
- For batch: pass a \`notes\` array, each with an \`id\` field.
- **Optimistic concurrency is required by default.** Pass \`if_updated_at\` with the \`updated_at\` value you last read — the update is rejected with a conflict error if the note has changed since. Re-read, reconcile, and retry. To skip the safety check (e.g. bulk migration), pass \`force: true\` instead; the update then runs unconditionally.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID or path" },
          content: { type: "string", description: "New content" },
          path: { type: "string", description: "New path" },
          metadata: { type: "object", description: "Metadata to merge (keys are merged, not replaced wholesale)" },
          created_at: { type: "string", description: "New created_at timestamp" },
          if_updated_at: { type: "string", description: "Optimistic concurrency check: the updated_at value you last read. Rejects with a conflict error if the note has been modified since. Required unless `force: true` is set." },
          force: { type: "boolean", description: "Override the required `if_updated_at` check and run the update unconditionally. Use only for bulk migrations or scripted writes where concurrency is known-safe." },
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
          // Batch
          notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                path: { type: "string" },
                metadata: { type: "object" },
                created_at: { type: "string" },
                if_updated_at: { type: "string", description: "Optimistic concurrency check for this item; rejects with a conflict error if the note has been modified since. Required unless `force: true` is set on this item." },
                force: { type: "boolean", description: "Override the required `if_updated_at` check for this item." },
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

        const updated: Note[] = [];
        for (const item of items) {
          const note = requireNote(db, item.id as string);

          // --- Safety-by-default: refuse mutations without a precondition ---
          // The caller must either echo the note's last-seen `updated_at`
          // (`if_updated_at`) so the conditional UPDATE can catch lost
          // writes, or explicitly opt out with `force: true`. This runs
          // *before* any DB writes so a rejection leaves the note untouched.
          if (item.if_updated_at === undefined && item.force !== true) {
            throw new PreconditionRequiredError(note.id, note.path ?? null);
          }

          // --- Plan bracket cleanup for wikilink removals (no DB writes yet) ---
          // We compute the cleaned content so we can do the core UPDATE first
          // (with if_updated_at atomically) before any link deletions. If the
          // UPDATE fails on a conflict, nothing has been mutated.
          let contentOverride = item.content as string | undefined;
          const linksRemove = (item.links as any)?.remove as { target: string; relationship: string }[] | undefined;
          const resolvedLinksToRemove: { targetId: string; relationship: string }[] = [];
          if (linksRemove) {
            for (const link of linksRemove) {
              const target = resolveNote(db, link.target);
              if (!target) continue;
              resolvedLinksToRemove.push({ targetId: target.id, relationship: link.relationship });
              if (link.relationship === "wikilink" && target.path) {
                const currentContent = contentOverride ?? note.content;
                const cleaned = removeWikilinkBrackets(currentContent, target.path);
                if (cleaned !== currentContent) {
                  contentOverride = cleaned;
                }
              }
            }
          }

          // --- Core update (content, path, metadata, created_at + concurrency check) ---
          const updates: any = {};
          if (contentOverride !== undefined) updates.content = contentOverride;
          if (item.path !== undefined) updates.path = item.path;
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

        return batch ? updated : updated[0];
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
      description: `List tags with usage counts. Pass \`tag\` to get a single tag's details including its schema (description + fields). Pass \`include_schema: true\` to include schemas for all tags.`,
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Get details for a single tag" },
          include_schema: { type: "boolean", description: "Include schema (description + fields) for each tag (default: false)" },
        },
      },
      execute: (params) => {
        const singleTag = params.tag as string | undefined;

        if (singleTag) {
          // Single tag detail
          const allTags = noteOps.listTags(db);
          const found = allTags.find((t) => t.name === singleTag);
          const schema = tagSchemaOps.getTagSchema(db, singleTag);
          return {
            name: singleTag,
            count: found?.count ?? 0,
            description: schema?.description ?? null,
            fields: schema?.fields ?? null,
          };
        }

        // All tags
        const tags = noteOps.listTags(db);
        if (params.include_schema) {
          const schemas = tagSchemaOps.getTagSchemaMap(db);
          return tags.map((t) => ({
            ...t,
            description: schemas[t.name]?.description ?? null,
            fields: schemas[t.name]?.fields ?? null,
          }));
        }
        return tags;
      },
    },

    // =====================================================================
    // 6. update-tag — create/update tag description + schema fields
    // =====================================================================
    {
      name: "update-tag",
      description: "Create or update a tag's description and schema fields. If the tag doesn't exist, it's created. Fields are merged — new keys are added, existing keys are replaced.",
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
        },
        required: ["tag"],
      },
      execute: (params) => {
        const tag = params.tag as string;
        const existing = tagSchemaOps.getTagSchema(db, tag);
        const incomingFields = (params.fields as Record<string, TagFieldSchema> | undefined) ?? {};
        const mergedFields: Record<string, TagFieldSchema> = {
          ...(existing?.fields ?? {}),
          ...incomingFields,
        };

        // Validate cross-tag consistency on fields being (re)declared in this
        // call. `type` and `indexed` are global — all declarers must agree.
        // `description` and `enum` are per-tag, so we don't compare them.
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

        // Persist the schema first, then reconcile indexing lifecycle. An
        // error here would leave the on-disk schema untouched, matching
        // prior behavior.
        const result = tagSchemaOps.upsertTagSchema(db, tag, {
          description: (params.description as string | undefined) ?? existing?.description,
          fields: Object.keys(mergedFields).length > 0 ? mergedFields : undefined,
        });

        // Diff indexed state for this tag: what it indexed before vs. now.
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
        // Release any indexed fields this tag declared before the schema
        // row disappears. releaseField drops the generated column + index
        // when the declarer set empties.
        const schema = tagSchemaOps.getTagSchema(db, tag);
        if (schema?.fields) {
          for (const [fieldName, spec] of Object.entries(schema.fields)) {
            if (spec.indexed === true) {
              indexedFieldOps.releaseField(db, fieldName, tag);
            }
          }
        }
        // Delete schema first (FK cascade would handle it, but be explicit)
        tagSchemaOps.deleteTagSchema(db, tag);
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
      description: "Get vault description and optionally stats (note/tag/link counts, distribution). Pass `description` to update the vault description (changes how AI agents behave in future sessions).",
      inputSchema: {
        type: "object",
        properties: {
          include_stats: { type: "boolean", description: "Include note count, tag count, distribution by month (default: false)" },
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
// Helpers
// ---------------------------------------------------------------------------

function normalizeTags(tag: unknown): string[] | undefined {
  if (!tag) return undefined;
  if (Array.isArray(tag)) return tag;
  return [tag as string];
}

// Re-exported for backward compat; defined in notes.ts alongside the
// conditional-UPDATE implementation that raises it.
export { ConflictError } from "./notes.js";

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

