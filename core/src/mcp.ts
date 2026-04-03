import type Database from "better-sqlite3";
import * as notes from "./notes.js";
import * as links from "./links.js";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => unknown;
}

/**
 * Tag descriptions included in MCP tool descriptions so the AI
 * knows what tags are available and what they mean.
 */
const TAG_DOCS = `Built-in tags:
  #daily — user-captured content (voice memos, typed notes)
  #doc — persistent documents (blog drafts, grocery lists, reference notes)
  #digest — AI/system-created content for the user to consume
  #pinned — kept prominent (applies to any note)
  #archived — user is done with this (applies to any note)
  #voice — note was transcribed from voice
Users may create additional tags. Apply them as instructed.`;

/**
 * Generate hardcoded MCP tools for the Parachute Daily system.
 */
export function generateMcpTools(db: Database.Database): McpToolDef[] {
  return [
    {
      name: "create-note",
      description: `Create a new note with optional tags and path. ${TAG_DOCS}`,
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Note content (markdown)" },
          tags: { type: "array", items: { type: "string" }, description: "Tags to apply" },
          path: { type: "string", description: "Optional path/name (e.g., 'Grocery List', 'Blog/My Post')" },
        },
        required: ["content"],
      },
      execute: (params) => notes.createNote(db, params.content as string, {
        tags: params.tags as string[] | undefined,
        path: params.path as string | undefined,
      }),
    },
    {
      name: "update-note",
      description: "Update an existing note's content or path.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID" },
          content: { type: "string", description: "New content" },
          path: { type: "string", description: "New path/name" },
        },
        required: ["id"],
      },
      execute: (params) => notes.updateNote(db, params.id as string, {
        content: params.content as string | undefined,
        path: params.path as string | undefined,
      }),
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
        notes.deleteNote(db, params.id as string);
        return { deleted: true };
      },
    },
    {
      name: "read-notes",
      description: `Read notes, optionally filtered by tags and date range. ${TAG_DOCS}`,
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" }, description: "Filter by tags (AND)" },
          exclude_tags: { type: "array", items: { type: "string" }, description: "Exclude notes with these tags" },
          date_from: { type: "string", description: "Start date (ISO, inclusive)" },
          date_to: { type: "string", description: "End date (ISO, exclusive — use the day after your range)" },
          sort: { type: "string", enum: ["asc", "desc"], description: "Sort by created_at" },
          limit: { type: "number", description: "Max results (default 100)" },
          offset: { type: "number", description: "Skip this many results (for pagination, default 0)" },
        },
      },
      execute: (params) => notes.queryNotes(db, {
        tags: params.tags as string[] | undefined,
        excludeTags: params.exclude_tags as string[] | undefined,
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
      description: "Create a directed link between two notes (e.g., mentions, quotes, related-to).",
      inputSchema: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "Source note ID" },
          target_id: { type: "string", description: "Target note ID" },
          relationship: { type: "string", description: "Relationship type (e.g., mentions, related-to)" },
        },
        required: ["source_id", "target_id", "relationship"],
      },
      execute: (params) => links.createLink(
        db,
        params.source_id as string,
        params.target_id as string,
        params.relationship as string,
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
      description: "Get links for a note. Returns connected notes.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID" },
          direction: { type: "string", enum: ["outbound", "inbound", "both"], default: "both" },
        },
        required: ["id"],
      },
      execute: (params) => links.getLinks(db, params.id as string, {
        direction: params.direction as "outbound" | "inbound" | "both" | undefined,
      }),
    },
    {
      name: "list-tags",
      description: "List all tags with usage counts.",
      inputSchema: { type: "object", properties: {} },
      execute: () => notes.listTags(db),
    },
  ];
}

/**
 * Format tool definitions for MCP protocol listing (without execute function).
 */
export function listMcpTools(db: Database.Database): Omit<McpToolDef, "execute">[] {
  return generateMcpTools(db).map(({ execute, ...rest }) => rest);
}
