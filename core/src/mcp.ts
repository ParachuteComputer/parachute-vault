import { Database } from "bun:sqlite";
import type { Store } from "./types.js";
import * as notes from "./notes.js";
import * as links from "./links.js";

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
      description: "Update a note's content, path, or metadata.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID" },
          content: { type: "string", description: "New content" },
          path: { type: "string", description: "New path/name" },
          metadata: { type: "object", description: "New metadata (replaces existing)" },
        },
        required: ["id"],
      },
      execute: (params) => {
        const fn = store ? store.updateNote.bind(store) : (id: string, u: any) => notes.updateNote(db, id, u);
        return fn(params.id as string, {
          content: params.content as string | undefined,
          path: params.path as string | undefined,
          metadata: params.metadata as Record<string, unknown> | undefined,
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
      description: `Read notes, filtered by tags, path prefix, metadata, and/or date range. Use path_prefix to browse like a filesystem. Use metadata to filter by structured properties (e.g., { "status": "in-progress" }).`,
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
        },
      },
      execute: (params) => notes.queryNotes(db, {
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
      }),
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
      description: "Get links for a note. Returns connected notes with their path, tags, and metadata. Use include_content to also get note content.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID" },
          direction: { type: "string", enum: ["outbound", "inbound", "both"], default: "both" },
          include_content: { type: "boolean", description: "Include full note content in results (default false)" },
        },
        required: ["id"],
      },
      execute: (params) => {
        const hydrated = links.getLinksHydrated(db, params.id as string, {
          direction: params.direction as "outbound" | "inbound" | "both" | undefined,
        });
        if (params.include_content) {
          // Fetch full notes for content
          const noteIds = new Set<string>();
          for (const link of hydrated) {
            noteIds.add(link.sourceId);
            noteIds.add(link.targetId);
          }
          const fullNotes = new Map<string, any>();
          for (const note of notes.getNotes(db, [...noteIds])) {
            fullNotes.set(note.id, note);
          }
          return hydrated.map((link) => ({
            ...link,
            sourceNote: fullNotes.get(link.sourceId) ?? link.sourceNote,
            targetNote: fullNotes.get(link.targetId) ?? link.targetNote,
          }));
        }
        return hydrated;
      },
    },
    {
      name: "list-tags",
      description: "List all tags with usage counts.",
      inputSchema: { type: "object", properties: {} },
      execute: () => notes.listTags(db),
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
      description: `Create multiple notes in one call. Much more efficient than calling create-note repeatedly.`,
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

  ];
}

