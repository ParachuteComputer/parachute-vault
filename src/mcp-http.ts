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
 * Required verb for an MCP tool. Reads `tool.requiredVerb` from the tool
 * metadata — every core tool stamps this (vault#376) so the filter is data,
 * not a side-table that can drift. The discovery + dispatch paths below
 * call this with the tool object so a future tool that forgets to stamp
 * falls into the default-deny branch.
 *
 * Default-deny: unknown tools require `write`. Keeps accidental reads of
 * a not-yet-mapped mutation tool from slipping past. (`admin` would be
 * safer-still but would refuse vault-info-style read tools to write-scope
 * callers; `write` is the right middle ground.)
 */
function requiredVerbForTool(tool: { requiredVerb?: VaultVerb }): VaultVerb {
  return tool.requiredVerb ?? "write";
}

/**
 * Handle scoped MCP at /vault/{name}/mcp (single vault).
 *
 * `callerBearer` is the RAW credential the session presented (from
 * `extractApiKey`). It's threaded into `generateScopedMcpTools` so the
 * manage-token tool can forward it to hub's mint-token attenuation proxy
 * (vault#403, MGT). NULL when the request carried no bearer (auth would have
 * already rejected) — the tool treats a missing/non-JWT bearer as
 * non-forwardable and returns a clear error on mint.
 */
export async function handleScopedMcp(
  req: Request,
  vaultName: string,
  auth: AuthResult,
  callerBearer?: string | null,
): Promise<Response> {
  // Auth flows through to getServerInstruction so the connect-time
  // markdown brief is filtered by `scoped_tags` — symmetric with the
  // JSON `vault-info` wrapper.
  const instruction = await getServerInstruction(vaultName, auth);
  return handleMcp(
    req,
    () => generateScopedMcpTools(vaultName, auth, callerBearer ?? null),
    `parachute-vault/${vaultName}`,
    vaultName,
    auth,
    instruction,
  );
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
  // now driven by per-vault scope inheritance. With manage-token (vault#376)
  // requiring `admin`, callers without admin don't see it at all — the AI
  // never knows it could mint child tokens, eliminating that escalation
  // vector by listing.
  const visibleTools = mcpTools.filter((t) =>
    hasScopeForVault(auth.scopes, vaultName, requiredVerbForTool(t)),
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

    // Dispatch against the FILTERED tool list — tools the caller can't see
    // in `tools/list` also can't be called explicitly. This matches the
    // user-visible contract: "excluded tools throw 'tool not found' if
    // called explicitly" (vault#376 spec). It also avoids leaking the
    // existence of admin-only tools (manage-token) to write-scope sessions
    // via differential error messages.
    const tool = visibleTools.find((t) => t.name === name);
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
        field?: string;
        expected_from?: unknown;
        to?: unknown;
        current?: unknown;
        violations?: unknown;
        error_type?: string;
        got?: unknown;
        hint?: string;
      };
      // Honest-queries validation errors (vault#550) — `limit`/`offset`/date
      // values that are structurally invalid rather than merely "no
      // results." Gated on `error_type === "invalid_query"` specifically
      // (not `code === "INVALID_QUERY"` broadly) so long-standing QueryError
      // throws WITHOUT this field (FIELD_NOT_INDEXED, UNKNOWN_OPERATOR, the
      // various cursor/near/search incompatibility errors, ...) keep their
      // existing unstructured `isError: true` fallback — only the NEW #550
      // call sites that explicitly set `error_type` opt into this shape.
      if (e?.error_type === "invalid_query") {
        throw new McpError(ErrorCode.InvalidParams, message, {
          error_type: "invalid_query",
          field: e.field,
          got: e.got,
          hint: e.hint,
        });
      }
      if (e?.code === "CONFLICT") {
        throw new McpError(ErrorCode.InvalidRequest, message, {
          error_type: "conflict",
          current_updated_at: e.current_updated_at ?? null,
          your_updated_at: e.expected_updated_at,
          path: e.note_path ?? null,
          note_id: e.note_id,
        });
      }
      // State-transition compare-and-set conflict (vault#299 Part B) — a
      // DISTINCT vocabulary from `conflict` (settled lead #3): the value
      // didn't match, not the updated_at token.
      if (e?.code === "TRANSITION_CONFLICT") {
        throw new McpError(ErrorCode.InvalidRequest, message, {
          error_type: "transition_conflict",
          note_id: e.note_id,
          path: e.note_path ?? null,
          field: e.field,
          expected_from: e.expected_from,
          to: e.to,
          current: e.current ?? null,
        });
      }
      // Strict-schema rejection (vault#299 Part A) — one error carrying ALL
      // per-field violations (settled lead #1).
      if (e?.code === "SCHEMA_VALIDATION") {
        throw new McpError(ErrorCode.InvalidParams, message, {
          error_type: "schema_validation",
          violations: e.violations ?? [],
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
