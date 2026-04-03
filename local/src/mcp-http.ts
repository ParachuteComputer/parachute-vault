/**
 * Streamable HTTP MCP transport for the Parachute Daily server.
 *
 * Mounts at /mcp on the existing Hono app. Uses the same auth middleware
 * (localhost bypasses, remote requires API key) and the same 11 MCP tools
 * from @parachute/core.
 *
 * Uses the raw Server class (not McpServer) to register tools with plain
 * JSON Schema — avoids the Zod requirement in McpServer.tool().
 */

import { Hono } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { generateMcpTools } from "@parachute/core";
import type { Database } from "better-sqlite3";
import crypto from "node:crypto";

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
}

/** Active sessions keyed by session ID. */
const sessions = new Map<string, Session>();

/**
 * Create a Hono sub-app that serves MCP over Streamable HTTP.
 */
export function mcpRoutes(db: Database): Hono {
  const app = new Hono();
  const mcpTools = generateMcpTools(db);

  function createSession(): Session {
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
      { name: "parachute-daily", version: "0.2.0" },
      { capabilities: { tools: {} } },
    );

    // List all tools
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: mcpTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));

    // Execute a tool
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
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
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

  app.all("/", async (c) => {
    // Route to existing session if present
    const sessionId = c.req.header("mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      return existing.transport.handleRequest(c.req.raw);
    }

    // New session
    const session = createSession();
    await session.server.connect(session.transport);
    return session.transport.handleRequest(c.req.raw);
  });

  return app;
}
