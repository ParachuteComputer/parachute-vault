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
import { requireScope } from "./auth.ts";
import type { AuthResult } from "./auth.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import { SCOPE_READ, SCOPE_WRITE } from "./scopes.ts";

/**
 * Required scope for each MCP tool. Tools that mutate note/tag state require
 * `vault:write`; pure query tools need `vault:read`. `vault-info` is read at
 * the contract level — it does have an optional description-update branch,
 * but that path requires the caller to already hold `vault:write`, which is
 * enforced by inheritance when we call through.
 */
const TOOL_REQUIRED_SCOPE: Record<string, string> = {
  "query-notes": SCOPE_READ,
  "list-tags": SCOPE_READ,
  "find-path": SCOPE_READ,
  "vault-info": SCOPE_READ,
  "create-note": SCOPE_WRITE,
  "update-note": SCOPE_WRITE,
  "delete-note": SCOPE_WRITE,
  "update-tag": SCOPE_WRITE,
  "delete-tag": SCOPE_WRITE,
};

function requiredScopeForTool(toolName: string): string {
  // Default-deny: unknown tools require write. Keeps accidental reads of
  // a not-yet-mapped mutation tool from slipping past.
  return TOOL_REQUIRED_SCOPE[toolName] ?? SCOPE_WRITE;
}

/** Handle scoped MCP at /vault/{name}/mcp (single vault). */
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
  // permit. Callers without `vault:write` don't see mutation tools at all —
  // matches the prior behavior of the read/full permission model but is now
  // driven by scope inheritance.
  const visibleTools = mcpTools.filter((t) =>
    requireScope(auth, requiredScopeForTool(t.name)),
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

    const neededScope = requiredScopeForTool(name);
    if (!requireScope(auth, neededScope)) {
      return {
        content: [{
          type: "text" as const,
          text: `Forbidden: tool '${name}' requires the '${neededScope}' scope. Granted scopes: ${auth.scopes.join(" ") || "(none)"}.`,
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
