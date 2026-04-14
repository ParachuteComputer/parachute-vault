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
      const result = await tool.execute((args ?? {}) as Record<string, unknown>);
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
