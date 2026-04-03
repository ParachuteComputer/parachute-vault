/**
 * Streamable HTTP MCP transport — single unified endpoint.
 *
 * Mounted at /mcp. All vaults accessible through the `vault` parameter
 * on each tool. Uses the raw Server class with JSON Schema (no Zod).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { generateUnifiedMcpTools } from "./mcp-tools.ts";
import crypto from "node:crypto";

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
}

const sessions = new Map<string, Session>();

/**
 * Handle an MCP HTTP request.
 */
export async function handleMcpHttp(req: Request): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id");
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (existing) {
    return existing.transport.handleRequest(req);
  }

  const session = createSession();
  await session.server.connect(session.transport);
  return session.transport.handleRequest(req);
}

function createSession(): Session {
  // Generate tools fresh for each session (picks up vault changes)
  const mcpTools = generateUnifiedMcpTools();

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, session);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });

  const server = new Server(
    { name: "parachute-vault", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = mcpTools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = tool.execute((args ?? {}) as Record<string, unknown>);
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

  const session: Session = { transport, server };
  return session;
}
