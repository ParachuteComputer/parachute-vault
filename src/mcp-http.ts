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
 * Every MCP session is scoped to one vault via `/vault/{name}/mcp`.
 * The vault's description is sent as the MCP server instruction, and
 * read-only keys see a filtered tool list.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { generateScopedMcpTools, getServerInstruction } from "./mcp-tools.ts";
import type { AuthResult } from "./auth.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import { hasScopeForVault } from "./scopes.ts";
import type { VaultVerb } from "./scopes.ts";

/**
 * Required verb for each MCP tool. Tools that mutate note/tag state require
 * write; pure query tools need read. `vault-info` is listed as read because
 * read-only callers can fetch stats — the description-update branch inside
 * vault-info performs its own secondary write check (see `overrideVaultInfo`
 * in mcp-tools.ts). Do not assume the outer gate alone protects the inner
 * branch.
 */
const TOOL_REQUIRED_VERB: Record<string, VaultVerb> = {
  "query-notes": "read",
  "list-tags": "read",
  "find-path": "read",
  "synthesize-notes": "read",
  "vault-info": "read",
  "create-note": "write",
  "update-note": "write",
  "delete-note": "write",
  "update-tag": "write",
  "delete-tag": "write",
};

function requiredVerbForTool(toolName: string): VaultVerb {
  // Default-deny: unknown tools require write. Keeps accidental reads of
  // a not-yet-mapped mutation tool from slipping past.
  return TOOL_REQUIRED_VERB[toolName] ?? "write";
}

/** Handle scoped MCP at /vault/{name}/mcp (single vault). */
export async function handleScopedMcp(req: Request, vaultName: string, auth: AuthResult): Promise<Response> {
  const instruction = getServerInstruction(vaultName);
  return handleMcp(req, () => generateScopedMcpTools(vaultName, auth), `parachute-vault/${vaultName}`, vaultName, auth, instruction);
}

async function handleMcp(
  req: Request,
  getTools: () => McpToolDef[],
  serverName: string,
  vaultName: string,
  auth: AuthResult,
  instruction: string,
): Promise<Response> {
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

  // Filter the advertised tool list to what the caller's scopes actually
  // permit for THIS vault. Callers without write don't see mutation tools at
  // all — matches the prior behavior of the read/full permission model but
  // now driven by per-vault scope inheritance.
  const visibleTools = mcpTools.filter((t) =>
    hasScopeForVault(auth.scopes, vaultName, requiredVerbForTool(t.name)),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const neededVerb = requiredVerbForTool(name);
    if (!hasScopeForVault(auth.scopes, vaultName, neededVerb)) {
      return {
        content: [{
          type: "text" as const,
          text: `Forbidden: tool '${name}' requires the 'vault:${neededVerb}' scope (or 'vault:${vaultName}:${neededVerb}'). Granted scopes: ${auth.scopes.join(" ") || "(none)"}.`,
        }],
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
      const result = await tool.execute((args ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      // Domain errors from the core tools (conflict, missing precondition) get
      // surfaced as JSON-RPC errors with a structured `data` field so an
      // agent can key off `data.error_type` and the concurrency tokens.
      // Everything else falls through to an in-band tool error with
      // `isError: true` — legible but unstructured.
      const message = err instanceof Error ? err.message : "Unknown error";
      const e = err as {
        code?: string;
        note_id?: string;
        note_path?: string | null;
        current_updated_at?: string | null;
        expected_updated_at?: string;
      };
      if (e?.code === "CONFLICT") {
        throw new McpError(ErrorCode.InvalidRequest, message, {
          error_type: "conflict",
          current_updated_at: e.current_updated_at ?? null,
          your_updated_at: e.expected_updated_at,
          path: e.note_path ?? null,
          note_id: e.note_id,
        });
      }
      if (e?.code === "PRECONDITION_REQUIRED") {
        throw new McpError(ErrorCode.InvalidParams, message, {
          error_type: "precondition_required",
          note_id: e.note_id,
          path: e.note_path ?? null,
        });
      }
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}
