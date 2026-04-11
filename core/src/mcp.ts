import { Database } from "bun:sqlite";
import type { Store } from "./types.js";
import * as notes from "./notes.js";
import * as links from "./links.js";
import { resolveWikilinkDetailed, listUnresolvedWikilinks } from "./wikilinks.js";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => unknown;
}

/**
 * Generate MCP tools for a vault.
 *
 * Accepts a Store so that create/update/delete operations go through
 * the store's hooks (wikilink sync, path normalization, etc.).
 * Read-only operations use the db directly for efficiency.
 */
export function generateMcpTools(storeOrDb: Store | Database): McpToolDef[] {
  // Support both Store and raw Database for backwards compat (tests)
  const store: Store | null = 'createNote' in storeOrDb ? storeOrDb as Store : null;
  const db: Database = store ? (store as any).db : storeOrDb as Database;
  return [
    {
      name: "get-note",
      description: "Get a note by ID or path. Use this to look up a specific note when you have its ID (e.g., from link results) or its path (e.g., 'Projects/Parachute/README').",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID" },
          path: { type: "string", description: "Note path (e.g., 'Projects/Parachute/README')" },
          ids: { type: "array", items: { type: "string" }, description: "Multiple note IDs to fetch at once" },
        },
      },
      execute: (params) => {
        if (params.ids) {
          return notes.getNotes(db, params.ids as string[]);
        }
        if (params.path) {
          const note = notes.getNoteByPath(db, params.path as string);
          if (!note) return { error: "Note not found", path: params.path };
          return note;
        }
        if (params.id) {
          const note = notes.getNote(db, params.id as string);
          if (!note) return { error: "Note not found", id: params.id };
          return note;
        }
        return { error: "Provide id, path, or ids" };
      },
    },
    {
      name: "create-note",
      description: `Create a new note with optional tags, path, and metadata. Path works like a filesystem (e.g., 'Projects/Parachute/README'). Metadata is a JSON object for structured properties (e.g., { "status": "draft", "priority": "high" }).`,
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Note content (markdown)" },
          tags: { type: "array", items: { type: "string" }, description: "Tags to apply" },
          path: { type: "string", description: "Optional path/name (e.g., 'Grocery List', 'Blog/My Post')" },
          metadata: { type: "object", description: "Structured metadata (e.g., { status: 'draft', priority: 'high' })" },
          created_at: { type: "string", description: "ISO-8601 timestamp (defaults to now). Use when the note was taken at a different time than when it's being created." },
        },
        required: ["content"],
      },
      execute: (params) => {
        const fn = store ? store.createNote.bind(store) : (c: string, o?: any) => notes.createNote(db, c, o);
        return fn(params.content as string, {
          tags: params.tags as string[] | undefined,
          path: params.path as string | undefined,
          metadata: params.metadata as Record<string, unknown> | undefined,
          created_at: params.created_at as string | undefined,
        });
      },
    },
    {
      name: "update-note",
      description: "Update a note's content, path, metadata, or created_at.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID" },
          content: { type: "string", description: "New content" },
          path: { type: "string", description: "New path/name" },
          metadata: { type: "object", description: "New metadata (replaces existing)" },
          created_at: { type: "string", description: "New created_at timestamp (ISO 8601)" },
        },
        required: ["id"],
      },
      execute: (params) => {
        const fn = store ? store.updateNote.bind(store) : (id: string, u: any) => notes.updateNote(db, id, u);
        return fn(params.id as string, {
          content: params.content as string | undefined,
          path: params.path as string | undefined,
          metadata: params.metadata as Record<string, unknown> | undefined,
          created_at: params.created_at as string | undefined,
        });
      },
    },
    {
      name: "delete-note",
      description: "Permanently delete a note and all its tags and links.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID" },
        },
        required: ["id"],
      },
      execute: (params) => {
        if (store) {
          store.deleteNote(params.id as string);
        } else {
          notes.deleteNote(db, params.id as string);
        }
        return { deleted: true };
      },
    },
    {
      name: "read-notes",
      description: `Read notes, filtered by tags, path prefix, metadata, and/or date range. Use path_prefix to browse like a filesystem. Use metadata to filter by structured properties (e.g., { "status": "in-progress" }). Set include_content: false to get a lightweight index (metadata + preview + byteSize) instead of full content — useful for planning batched reads over large date ranges.`,
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
          tag_match: { type: "string", enum: ["all", "any"], description: "How to match tags: 'all' = must have ALL (default), 'any' = must have ANY" },
          exclude_tags: { type: "array", items: { type: "string" }, description: "Exclude notes with these tags" },
          path_prefix: { type: "string", description: "Filter by path prefix (e.g., 'Projects/Parachute')" },
          metadata: { type: "object", description: "Filter by metadata values (exact match per key)" },
          date_from: { type: "string", description: "Start date (ISO, inclusive)" },
          date_to: { type: "string", description: "End date (ISO, exclusive — use the day after your range)" },
          sort: { type: "string", enum: ["asc", "desc"], description: "Sort by created_at" },
          limit: { type: "number", description: "Max results (default 100)" },
          offset: { type: "number", description: "Skip this many results (for pagination, default 0)" },
          include_content: { type: "boolean", description: "Include full note content (default true). Set false for an index-mode response: each note becomes { id, path, createdAt, updatedAt, tags, metadata, byteSize, preview } with no content field." },
        },
      },
      execute: (params) => {
        const results = notes.queryNotes(db, {
          tags: params.tags as string[] | undefined,
          tagMatch: params.tag_match as "all" | "any" | undefined,
          excludeTags: params.exclude_tags as string[] | undefined,
          pathPrefix: params.path_prefix as string | undefined,
          metadata: params.metadata as Record<string, unknown> | undefined,
          dateFrom: params.date_from as string | undefined,
          dateTo: params.date_to as string | undefined,
          sort: params.sort as "asc" | "desc" | undefined,
          limit: params.limit as number | undefined,
          offset: params.offset as number | undefined,
        });
        if (params.include_content === false) {
          return results.map(notes.toNoteIndex);
        }
        return results;
      },
    },
    {
      name: "search-notes",
      description: "Full-text search across all notes.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tag filter" },
          limit: { type: "number", default: 20 },
        },
        required: ["query"],
      },
      execute: (params) => notes.searchNotes(db, params.query as string, {
        tags: params.tags as string[] | undefined,
        limit: params.limit as number | undefined,
      }),
    },
    {
      name: "tag-note",
      description: "Add tags to a note. Tags are created automatically if they don't exist.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID" },
          tags: { type: "array", items: { type: "string" }, description: "Tags to add" },
        },
        required: ["id", "tags"],
      },
      execute: (params) => {
        notes.tagNote(db, params.id as string, params.tags as string[]);
        return { tagged: true };
      },
    },
    {
      name: "untag-note",
      description: "Remove tags from a note.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID" },
          tags: { type: "array", items: { type: "string" }, description: "Tags to remove" },
        },
        required: ["id", "tags"],
      },
      execute: (params) => {
        notes.untagNote(db, params.id as string, params.tags as string[]);
        return { untagged: true };
      },
    },
    {
      name: "create-link",
      description: "Create a directed link between two notes (e.g., mentions, quotes, related-to). Optional metadata for context (e.g., { confidence: 0.9, context: 'mentioned in meeting' }).",
      inputSchema: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "Source note ID" },
          target_id: { type: "string", description: "Target note ID" },
          relationship: { type: "string", description: "Relationship type (e.g., mentions, related-to)" },
          metadata: { type: "object", description: "Optional link metadata" },
        },
        required: ["source_id", "target_id", "relationship"],
      },
      execute: (params) => links.createLink(
        db,
        params.source_id as string,
        params.target_id as string,
        params.relationship as string,
        params.metadata as Record<string, unknown> | undefined,
      ),
    },
    {
      name: "delete-link",
      description: "Delete a link between two notes.",
      inputSchema: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "Source note ID" },
          target_id: { type: "string", description: "Target note ID" },
          relationship: { type: "string", description: "Relationship type" },
        },
        required: ["source_id", "target_id", "relationship"],
      },
      execute: (params) => {
        links.deleteLink(
          db,
          params.source_id as string,
          params.target_id as string,
          params.relationship as string,
        );
        return { deleted: true };
      },
    },
    {
      name: "get-links",
      description: "List links in the vault. Returns bare link edges ({sourceId, targetId, relationship, metadata, createdAt}) — no hydration. Omit `id` to list every link (optionally filtered by `relationship`). Pass `id` to get links touching that note (with `direction`: outbound, inbound, both). Pair with get-note when you need the connected notes' content.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID. If omitted, returns all links in the vault." },
          direction: { type: "string", enum: ["outbound", "inbound", "both"], default: "both", description: "Only meaningful when `id` is provided." },
          relationship: { type: "string", description: "Filter to links with this relationship type." },
        },
      },
      execute: (params) => links.listLinks(db, {
        noteId: params.id as string | undefined,
        direction: params.direction as "outbound" | "inbound" | "both" | undefined,
        relationship: params.relationship as string | undefined,
      }),
    },
    {
      name: "list-tags",
      description: "List all tags with usage counts.",
      inputSchema: { type: "object", properties: {} },
      execute: () => notes.listTags(db),
    },
    {
      name: "delete-tag",
      description: "Delete a tag and remove it from all notes. Notes themselves are NOT deleted — just untagged. Use this to clean up unused or obsolete tags.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Tag name to delete" },
        },
        required: ["tag"],
      },
      execute: (params) => {
        const fn = store ? store.deleteTag.bind(store) : (name: string) => notes.deleteTag(db, name);
        return fn(params.tag as string);
      },
    },
    {
      name: "get-graph",
      description: "Get the whole vault as a graph in one call: {notes, links, tags, meta}. Default returns lean note indexes (id, path, tags, createdAt, updatedAt, metadata, byteSize, preview) — no content. Pass include_content: true to include full content on each note. Optional tag filter (tags + tag_match + exclude_tags) restricts notes to a subgraph; links are filtered to edges between notes in the subgraph. Useful for rendering visualizations, exports, or bird's-eye analysis.",
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" }, description: "Optional: only include notes with these tags" },
          tag_match: { type: "string", enum: ["all", "any"], description: "How to match tags (default: all)" },
          exclude_tags: { type: "array", items: { type: "string" }, description: "Exclude notes with these tags" },
          include_content: { type: "boolean", description: "Include full note content instead of the lean index shape (default false)" },
        },
      },
      execute: (params) => {
        const hasTagFilter = (params.tags as string[] | undefined)?.length
          || (params.exclude_tags as string[] | undefined)?.length;
        const filteredNotes = notes.queryNotes(db, {
          tags: params.tags as string[] | undefined,
          tagMatch: params.tag_match as "all" | "any" | undefined,
          excludeTags: params.exclude_tags as string[] | undefined,
          limit: 1_000_000,
        });
        const includeContent = params.include_content === true;
        const outNotes = includeContent ? filteredNotes : filteredNotes.map(notes.toNoteIndex);

        // Links: if no tag filter, return all links in the vault.
        // Otherwise, only edges between notes in the filtered set.
        let outLinks = links.listLinks(db);
        if (hasTagFilter) {
          const ids = new Set(filteredNotes.map((n) => n.id));
          outLinks = outLinks.filter((l) => ids.has(l.sourceId) && ids.has(l.targetId));
        }

        const totalRow = db.prepare("SELECT COUNT(*) as c FROM notes").get() as { c: number };
        const linkRow = db.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number };

        return {
          notes: outNotes,
          links: outLinks,
          tags: notes.listTags(db),
          meta: {
            totalNotes: totalRow.c,
            totalLinks: linkRow.c,
            filteredNotes: outNotes.length,
            filteredLinks: outLinks.length,
            includeContent,
          },
        };
      },
    },
    {
      name: "get-vault-stats",
      description: "Get a birds-eye view of the vault: total note count, earliest/latest note, note distribution by month, top tags, and tag count. Read-only, cheap aggregation. Call once at the start of a session to orient before doing vault-wide work (monthly summaries, reviews, trend tracking). For filtered queries use read-notes; for a full tag list use list-tags.",
      inputSchema: { type: "object", properties: {} },
      execute: () => notes.getVaultStats(db),
    },

    // ---- Bulk Operations ----

    {
      name: "create-notes",
      description: `Create multiple notes in one call. Much more efficient than calling create-note repeatedly. Each note accepts the same fields as create-note: content (required), path, tags, metadata, and created_at (ISO timestamp; supports backdating for imports).`,
      inputSchema: {
        type: "object",
        properties: {
          notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "Note content (markdown)" },
                tags: { type: "array", items: { type: "string" }, description: "Tags to apply" },
                path: { type: "string", description: "Optional path/name" },
                metadata: { type: "object", description: "Optional metadata object (JSON-serializable)" },
                created_at: { type: "string", description: "Optional ISO timestamp; defaults to now if omitted" },
              },
              required: ["content"],
            },
            description: "Array of notes to create",
          },
        },
        required: ["notes"],
      },
      execute: (params) => notes.createNotes(db, params.notes as any[]),
    },
    {
      name: "batch-tag",
      description: "Add tags to multiple notes at once. More efficient than tagging one at a time.",
      inputSchema: {
        type: "object",
        properties: {
          note_ids: { type: "array", items: { type: "string" }, description: "Note IDs to tag" },
          tags: { type: "array", items: { type: "string" }, description: "Tags to add" },
        },
        required: ["note_ids", "tags"],
      },
      execute: (params) => {
        const count = notes.batchTag(db, params.note_ids as string[], params.tags as string[]);
        return { tagged: true, count };
      },
    },
    {
      name: "batch-untag",
      description: "Remove tags from multiple notes at once.",
      inputSchema: {
        type: "object",
        properties: {
          note_ids: { type: "array", items: { type: "string" }, description: "Note IDs to untag" },
          tags: { type: "array", items: { type: "string" }, description: "Tags to remove" },
        },
        required: ["note_ids", "tags"],
      },
      execute: (params) => {
        const count = notes.batchUntag(db, params.note_ids as string[], params.tags as string[]);
        return { untagged: true, count };
      },
    },

    // ---- Deeper Link Queries ----

    {
      name: "traverse-links",
      description: "Traverse the link graph from a note. Returns all notes reachable within N hops, with their path, tags, and metadata. Useful for exploring knowledge clusters.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Starting note ID" },
          max_depth: { type: "number", description: "Maximum hops to traverse (default 2, max 5)" },
          relationship: { type: "string", description: "Optional: only follow links with this relationship type" },
        },
        required: ["id"],
      },
      execute: (params) => links.traverseLinks(db, params.id as string, {
        max_depth: Math.min((params.max_depth as number) ?? 2, 5),
        relationship: params.relationship as string | undefined,
      }),
    },
    {
      name: "find-path",
      description: "Find the shortest path between two notes in the link graph. Returns the chain of note IDs and relationships connecting them, or null if no path exists.",
      inputSchema: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "Starting note ID" },
          target_id: { type: "string", description: "Target note ID" },
          max_depth: { type: "number", description: "Maximum path length to search (default 5)" },
        },
        required: ["source_id", "target_id"],
      },
      execute: (params) => links.findPath(
        db,
        params.source_id as string,
        params.target_id as string,
        { max_depth: Math.min((params.max_depth as number) ?? 5, 10) },
      ),
    },

    // ---- Wikilink Tools ----

    {
      name: "resolve-wikilink",
      description: "Resolve a [[wikilink]] target to a note. Returns the matched note (resolved), multiple candidates (ambiguous), or empty (unresolved). Uses the same resolution logic as vault's write-time wikilink sync.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Wikilink target (e.g., 'Mickey', 'Projects/Atlas')" },
        },
        required: ["target"],
      },
      execute: (params) => resolveWikilinkDetailed(db, params.target as string),
    },
    {
      name: "list-unresolved-wikilinks",
      description: "List wikilinks that couldn't be resolved to any note. Useful for graph health audits and finding broken links.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (default 50)" },
        },
      },
      execute: (params) => listUnresolvedWikilinks(db, (params.limit as number) ?? 50),
    },

  ];
}

