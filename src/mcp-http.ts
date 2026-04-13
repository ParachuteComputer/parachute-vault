/**
 * Streamable HTTP MCP transport — stateless mode.
 *
 * Each request gets a fresh transport+server pair with no session ID
 * generator. The SDK skips session validation when sessionIdGenerator
 * is undefined, so clients can send `tools/call` or `tools/list`
 * directly without a prior `initialize` handshake.
 *
 * This means server restarts never break existing MCP clients — the
 * root cause of vault#56. The `initialize` method still works if a
 * client sends it (the Server class handles it natively).
 *
 * Two modes:
 *   /mcp              — unified, all vaults via `vault` param + list-vaults
 *   /vaults/{name}/mcp — scoped to one vault, no vault param
 *
 * Vault description is sent as the MCP server instruction.
 * Read-only keys see fewer tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { generateUnifiedMcpTools, generateScopedMcpTools, getServerInstruction } from "./mcp-tools.ts";
import { isToolAllowed } from "./auth.ts";
import type { AuthResult } from "./auth.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import type { TokenPermission } from "./token-store.ts";
import * as linkOps from "../core/src/links.ts";
import * as noteOps from "../core/src/notes.ts";
import { getVaultStore } from "./vault-store.ts";
import { readGlobalConfig } from "./config.ts";

/** Handle unified MCP at /mcp (all vaults). */
export async function handleUnifiedMcp(req: Request, auth: AuthResult): Promise<Response> {
  const instruction = getServerInstruction();
  return handleMcp(req, () => generateUnifiedMcpTools(), "parachute-vault", auth, instruction);
}

/** Handle scoped MCP at /vaults/{name}/mcp (single vault). */
export async function handleScopedMcp(req: Request, vaultName: string, auth: AuthResult): Promise<Response> {
  const instruction = getServerInstruction(vaultName);
  return handleMcp(req, () => generateScopedMcpTools(vaultName), `parachute-vault/${vaultName}`, auth, instruction);
}

async function handleMcp(
  req: Request,
  getTools: () => McpToolDef[],
  serverName: string,
  auth: AuthResult,
  instruction: string,
): Promise<Response> {
  const { permission } = auth;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = new Server(
    { name: serverName, version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: instruction,
    },
  );

  const mcpTools = getTools();

  // For read-only keys, only list readable tools
  const visibleTools = permission === "read"
    ? mcpTools.filter((t) => isToolAllowed(t.name, "read"))
    : mcpTools;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!isToolAllowed(name, permission)) {
      return {
        content: [{ type: "text" as const, text: `Forbidden: insufficient permissions to call ${name}` }],
        isError: true,
      };
    }

    const tool = mcpTools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const scopedArgs = applyScopeToArgs(name, (args ?? {}) as Record<string, unknown>, auth);
      let result: unknown;

      // find-path needs special handling: BFS must be scope-constrained
      if (name === "find-path" && (auth.scope_tag || auth.scope_path_prefix)) {
        result = executeScopedFindPath(scopedArgs, auth);
      } else {
        result = tool.execute(scopedArgs);
      }

      result = applyScopeToResult(name, result, auth);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}

// ---------------------------------------------------------------------------
// Scope enforcement — inject token scope into MCP tool args and results
// ---------------------------------------------------------------------------

/**
 * Before executing a tool, narrow the query parameters to the token's scope.
 * For query-notes: merge scope_tag into tag filter, scope_path_prefix into path_prefix.
 */
function applyScopeToArgs(
  toolName: string,
  args: Record<string, unknown>,
  auth: AuthResult,
): Record<string, unknown> {
  if (!auth.scope_tag && !auth.scope_path_prefix) return args;

  if (toolName === "query-notes") {
    const scoped = { ...args };

    // Merge scope_tag into tag filter
    if (auth.scope_tag) {
      const existing = scoped.tag;
      if (!existing) {
        scoped.tag = auth.scope_tag;
      } else if (Array.isArray(existing)) {
        if (!existing.includes(auth.scope_tag)) {
          scoped.tag = [...existing, auth.scope_tag];
        }
        // Force "all" match so scope tag is always required
        scoped.tag_match = "all";
      } else {
        if (existing !== auth.scope_tag) {
          scoped.tag = [existing as string, auth.scope_tag];
          scoped.tag_match = "all";
        }
      }
    }

    // Narrow path_prefix to scope
    if (auth.scope_path_prefix && !scoped.id) {
      const requested = scoped.path_prefix as string | undefined;
      if (!requested || !requested.startsWith(auth.scope_path_prefix)) {
        scoped.path_prefix = auth.scope_path_prefix;
      }
      // If requested path is already inside scope, keep it (more specific)
    }

    return scoped;
  }

  if (toolName === "find-path") {
    // find-path: scope enforcement happens in result filtering (post-execute)
    return args;
  }

  return args;
}

/**
 * After executing a tool, filter the result if needed.
 * For single-note query-notes by ID: verify the note is in scope.
 * For find-path: verify both endpoints are in scope.
 */
function applyScopeToResult(
  toolName: string,
  result: unknown,
  auth: AuthResult,
): unknown {
  if (!auth.scope_tag && !auth.scope_path_prefix) return result;

  if (toolName === "query-notes") {
    // Single-note result (has an `id` field, not an array)
    if (result && typeof result === "object" && !Array.isArray(result) && "id" in result) {
      const note = result as { id: string; tags?: string[]; path?: string; error?: string };
      if (note.error) return result; // already an error
      if (!noteInScope(note, auth)) {
        return { error: "Note not found", id: note.id };
      }
    }
    return result;
  }

  return result;
}

/**
 * Check if a note (from MCP result) passes the token's scope filter.
 */
function noteInScope(
  note: { tags?: string[]; path?: string },
  auth: AuthResult,
): boolean {
  if (auth.scope_tag && !note.tags?.includes(auth.scope_tag)) return false;
  if (auth.scope_path_prefix) {
    if (!note.path || !note.path.startsWith(auth.scope_path_prefix)) return false;
  }
  return true;
}

/**
 * Execute find-path with scope-constrained BFS.
 * Resolves the vault from args, builds a nodeFilter from auth scope,
 * and delegates to linkOps.findPath with the filter.
 */
function executeScopedFindPath(
  args: Record<string, unknown>,
  auth: AuthResult,
): unknown {
  const vaultName = (args.vault as string) ?? readGlobalConfig().default_vault ?? "default";
  const store = getVaultStore(vaultName);
  const db = store.db;

  const sourceIdOrPath = args.source as string;
  const targetIdOrPath = args.target as string;
  if (!sourceIdOrPath || !targetIdOrPath) {
    throw new Error("source and target are required");
  }

  // Resolve source and target, checking scope
  const sourceNote = noteOps.getNote(db, sourceIdOrPath) ?? noteOps.getNoteByPath(db, sourceIdOrPath);
  if (!sourceNote) throw new Error(`Note not found: "${sourceIdOrPath}"`);
  if (!noteInScope(sourceNote, auth)) throw new Error(`Note not found: "${sourceIdOrPath}"`);

  const targetNote = noteOps.getNote(db, targetIdOrPath) ?? noteOps.getNoteByPath(db, targetIdOrPath);
  if (!targetNote) throw new Error(`Note not found: "${targetIdOrPath}"`);
  if (!noteInScope(targetNote, auth)) throw new Error(`Note not found: "${targetIdOrPath}"`);

  const maxDepth = Math.min((args.max_depth as number) ?? 5, 10);

  // BFS only through in-scope notes
  const nodeFilter = (noteId: string) => {
    const note = noteOps.getNote(db, noteId);
    return note ? noteInScope(note, auth) : false;
  };

  return linkOps.findPath(db, sourceNote.id, targetNote.id, { max_depth: maxDepth, nodeFilter });
}
