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

/** Matches the JSON-RPC prefix the MCP SDK's `McpError` constructor bakes
 *  into `.message` itself (not just `.toString()`) — e.g.
 *  `"MCP error -32602: the actual message"`. */
const MCP_ERROR_PREFIX_RE = /^MCP error -?\d+:\s*/;

/**
 * Build a JSON-RPC `McpError` for a domain error, in ONE place (vault#555
 * fix 6 — was 15 duplicated `new McpError(...)` call sites below, each a
 * chance to drift). Two things this fixes over the old inline construction:
 *
 * 1. **No double-wrap.** The MCP SDK's `McpError` constructor bakes
 *    `"MCP error <code>: "` into `.message` ITSELF. If the message being
 *    wrapped ALREADY carries that prefix (a message forwarded verbatim
 *    from another MCP-speaking service, or a stale caller that read
 *    `err.message` off an already-formed `McpError` instead of re-throwing
 *    it — see the `err instanceof McpError` guard at the top of the catch
 *    block below, which is the PRIMARY fix for that exact case), naively
 *    constructing `new McpError(code, message, data)` doubles it:
 *    `"MCP error -32602: MCP error -32602: ..."`. This strips any
 *    pre-existing prefix before building the new one, so the message is
 *    single-prefixed no matter how many times a message string passes
 *    through this function.
 * 2. **`error_type` in the human-readable message too** (optional polish,
 *    vault#555) — a string-reading human (not just a JSON-parsing agent
 *    keying off `data.error_type`) sees `[error_type] message` rather than
 *    a bare message with no clue which structured category it belongs to.
 *
 * `data.error_type` fidelity was never actually broken — it was always
 * threaded correctly through the JSON-RPC `data` field; only the
 * human-readable `message` string could double-prefix.
 */
export function mcpDomainError(
  code: ErrorCode,
  rawMessage: string,
  data: Record<string, unknown>,
): McpError {
  const cleanMessage = rawMessage.replace(MCP_ERROR_PREFIX_RE, "");
  const errorType = typeof data.error_type === "string" ? data.error_type : undefined;
  const humanMessage = errorType ? `[${errorType}] ${cleanMessage}` : cleanMessage;
  return new McpError(code, humanMessage, data);
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
    () => generateScopedMcpTools(vaultName, auth, callerBearer ?? null, req),
    `parachute-vault/${vaultName}`,
    vaultName,
    auth,
    instruction,
  );
}

/** Exported for direct testing (vault#555 fix 6) — lets a test inject a
 *  synthetic failing tool to exercise the `err instanceof McpError` guard
 *  without needing a real domain error class to construct one naturally. */
export async function handleMcp(
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
      // The one wrapper change (attachments-for-agents design, Wave 2):
      // `resultContent`, when a tool defines it, decides the MCP content
      // blocks instead of the universal single-text-block default —
      // `read-attachment`'s image branch is the only current user (needs a
      // REAL {type:"image"} block alongside the row-JSON text block).
      const content = tool.resultContent
        ? tool.resultContent(result)
        : [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
      return { content };
    } catch (err) {
      // vault#555 fix 6 — never re-wrap an already-formed McpError. Passing
      // the SAME instance straight through is strictly correct (no
      // information lost — `.message` AND `.data.error_type` are already
      // exactly right) and is the primary fix for the double-prefix bug
      // ("MCP error -32602: MCP error -32602: ..."): every branch below
      // reads `err.message` and feeds it into a NEW McpError, which would
      // double the SDK's baked-in "MCP error <code>: " prefix if `err` were
      // already one. See `mcpDomainError`'s doc comment for the belt-and-
      // suspenders half of this fix (stripping a pre-existing prefix from a
      // plain message too).
      if (err instanceof McpError) throw err;

      // Domain errors from the core tools (conflict, missing precondition,
      // path collisions, batch caps, cursor/query validation, tag-field
      // conflicts, ...) get surfaced as JSON-RPC errors with a structured
      // `data` field so an agent can key off `data.error_type` and any
      // error-specific fields (concurrency tokens, violations, candidates,
      // ...). vault#554: every domain error class is mapped below, either by
      // a dedicated branch (full field fidelity) or the generic `error_type`
      // catch-all near the end. Only a TRULY unknown error (no `error_type`
      // anywhere on it) falls through to the in-band `isError: true` text.
      const message = err instanceof Error ? err.message : "Unknown error";
      const e = err as {
        name?: string;
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
        path?: string;
        candidates?: unknown;
        extension?: string;
        reason?: string;
        limit?: number;
        tag?: string;
        cycle?: unknown;
        referencing_tags?: unknown;
        /** Attachment-tickets design (§2c "errors as JIT docs") — a short, imperative next-step, distinct from the older free-form `hint`. */
        how_to?: string;
        /** `read-attachment` (Wave 2) refusals — `image_too_large` / `unsupported_attachment_type` carry the attachment's actual byte size. */
        size?: number;
        /** `read-attachment` `image_too_large` — the 4 MiB cap it exceeded. */
        max_bytes?: number;
        /** `read-attachment` `unsupported_attachment_type` — the mime type that couldn't be read. */
        mime_type?: string;
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
        throw mcpDomainError(ErrorCode.InvalidParams, message, {
          error_type: "invalid_query",
          field: e.field,
          got: e.got,
          hint: e.hint,
          ...(e.how_to !== undefined ? { how_to: e.how_to } : {}),
        });
      }
      // Advanced-mode full-text search syntax error (vault#551) — a
      // raw-passthrough FTS5 query that FTS5 itself rejected. Same shape as
      // `invalid_query` (field/got/hint) but a DISTINCT `error_type` so a
      // caller can tell "your search_mode:\"advanced\" syntax is malformed"
      // apart from "your query PARAMS are malformed."
      if (e?.error_type === "invalid_search_syntax") {
        throw mcpDomainError(ErrorCode.InvalidParams, message, {
          error_type: "invalid_search_syntax",
          field: e.field,
          got: e.got,
          hint: e.hint,
        });
      }
      if (e?.code === "CONFLICT") {
        throw mcpDomainError(ErrorCode.InvalidRequest, message, {
          error_type: "conflict",
          current_updated_at: e.current_updated_at ?? null,
          your_updated_at: e.expected_updated_at,
          path: e.note_path ?? null,
          note_id: e.note_id,
          hint: "re-read the note (query-notes) and re-apply your change against its current updated_at, or pass force: true to overwrite",
        });
      }
      // State-transition compare-and-set conflict (vault#299 Part B) — a
      // DISTINCT vocabulary from `conflict` (settled lead #3): the value
      // didn't match, not the updated_at token.
      if (e?.code === "TRANSITION_CONFLICT") {
        throw mcpDomainError(ErrorCode.InvalidRequest, message, {
          error_type: "transition_conflict",
          note_id: e.note_id,
          path: e.note_path ?? null,
          field: e.field,
          expected_from: e.expected_from,
          to: e.to,
          current: e.current ?? null,
          hint: "re-read the note's current value for this field and retry the transition from its actual current state",
        });
      }
      // Strict-schema rejection (vault#299 Part A) — one error carrying ALL
      // per-field violations (settled lead #1).
      if (e?.code === "SCHEMA_VALIDATION") {
        throw mcpDomainError(ErrorCode.InvalidParams, message, {
          error_type: "schema_validation",
          violations: e.violations ?? [],
          hint: "fix every field listed in violations and retry — none of this write was applied",
        });
      }
      if (e?.code === "PRECONDITION_REQUIRED") {
        throw mcpDomainError(ErrorCode.InvalidParams, message, {
          error_type: "precondition_required",
          note_id: e.note_id,
          path: e.note_path ?? null,
          hint: "re-read the note, pass its updated_at as if_updated_at, or pass force: true to skip the check",
        });
      }
      // Any other QueryError (vault#554) — FIELD_NOT_INDEXED, UNKNOWN_OPERATOR,
      // INVALID_OPERATOR_VALUE, and the various cursor/near/search
      // incompatibility throws that predate the vault#550/#551 `error_type`
      // convention (which is why they weren't caught by the two branches
      // above). Falls back to `error_type: "invalid_query"` — the umbrella
      // REST already uses for this whole error class — so these no longer
      // fall through to the unstructured `isError: true` text.
      if (e?.name === "QueryError") {
        throw mcpDomainError(ErrorCode.InvalidParams, message, {
          error_type: e.error_type ?? "invalid_query",
          code: e.code,
          field: e.field,
          got: e.got,
          hint: e.hint,
        });
      }
      // Malformed / stale opaque cursor (vault#313, vault#554) — was
      // entirely unmapped here before (REST already returns `{error, code}`
      // — no `error_type` either; both surfaces get one now). `code` is
      // already the exact `error_type` vocabulary: "cursor_invalid" or
      // "cursor_query_mismatch".
      if (e?.name === "CursorError" && typeof e.code === "string") {
        throw mcpDomainError(ErrorCode.InvalidParams, message, {
          error_type: e.code,
        });
      }
      // Path-rename/create collision (vault#126, vault#554) — schema's
      // UNIQUE(path) tripped. Mirrors REST's 409 `path_conflict` shape.
      if (e?.code === "PATH_CONFLICT") {
        throw mcpDomainError(ErrorCode.InvalidRequest, message, {
          error_type: "path_conflict",
          path: e.path,
        });
      }
      // A path lookup matched more than one note (vault#330 S1, vault#554) —
      // mirrors REST's 409 `ambiguous_path` shape (candidates = the
      // disambiguating extensions).
      if (e?.code === "AMBIGUOUS_PATH") {
        throw mcpDomainError(ErrorCode.InvalidRequest, message, {
          error_type: "ambiguous_path",
          path: e.path,
          candidates: e.candidates,
        });
      }
      // Bad `extension` value (vault#328, vault#554) — mirrors REST's 400
      // `invalid_extension` shape.
      if (e?.code === "INVALID_EXTENSION") {
        throw mcpDomainError(ErrorCode.InvalidParams, message, {
          error_type: "invalid_extension",
          extension: e.extension,
          reason: e.reason,
        });
      }
      // Batch cap exceeded (#213, vault#554) — mirrors REST's 413
      // `batch_too_large` shape.
      if (e?.code === "BATCH_TOO_LARGE") {
        throw mcpDomainError(ErrorCode.InvalidRequest, message, {
          error_type: "batch_too_large",
          limit: e.limit,
          got: e.got,
        });
      }
      // update-tag cross-tag field conflicts (vault#553/#554) — carries
      // EVERY violation in one response (see `TagFieldConflictError`).
      if (e?.code === "TAG_FIELD_CONFLICT") {
        throw mcpDomainError(ErrorCode.InvalidParams, message, {
          error_type: "tag_field_conflict",
          tag: e.tag,
          violations: e.violations ?? [],
        });
      }
      // parent_names cycle guard (vault#552) — `update-tag`'s write would
      // close a cycle. Mirrors REST's 409 `parent_cycle` shape; the tool
      // wrapper (src/mcp-tools.ts) scope-scrubs `cycle` before this throw
      // for a tag-scoped caller, same as TAG_FIELD_CONFLICT above.
      if (e?.code === "PARENT_CYCLE") {
        throw mcpDomainError(ErrorCode.InvalidRequest, message, {
          error_type: "parent_cycle",
          tag: e.tag,
          cycle: e.cycle ?? [],
        });
      }
      // Generic catch-all (vault#554): any remaining error that carries a
      // stable `error_type` — either a domain error class that stamps it as
      // an instance property (IndexedFieldError, and the classes handled by
      // dedicated branches above as defense-in-depth) or a validation leaf
      // built with `structuredError()` in core/src/mcp.ts (mutually_exclusive,
      // invalid_content_edit, content_edit_not_found, content_edit_ambiguous,
      // invalid_state_transition, invalid_parent_names, invalid_relationships,
      // not_found, ...). This is the backstop that makes "nothing falls
      // through to the unstructured isError text except a TRULY unknown
      // error" true by construction: only errors nobody tagged with
      // `error_type` still hit the fallback below.
      if (typeof e?.error_type === "string") {
        throw mcpDomainError(ErrorCode.InvalidParams, message, {
          error_type: e.error_type,
          field: e.field,
          hint: e.hint,
          // Forwarded when present (undefined keys are fine — JSON-RPC
          // `data` just omits them) so a `structuredError()` call site that
          // stamps extra fields — `limit`/`got`/`extension` (size/type
          // refusals) or `how_to` (attachment-tickets' JIT-docs field, §2c)
          // — isn't silently truncated down to error_type/field/hint by
          // this backstop.
          ...(e.limit !== undefined ? { limit: e.limit } : {}),
          ...(e.got !== undefined ? { got: e.got } : {}),
          ...(e.extension !== undefined ? { extension: e.extension } : {}),
          ...(e.how_to !== undefined ? { how_to: e.how_to } : {}),
          // read-attachment (Wave 2) refusal fields — same forward-when-present
          // discipline as the ticket fields just above.
          ...(e.size !== undefined ? { size: e.size } : {}),
          ...(e.max_bytes !== undefined ? { max_bytes: e.max_bytes } : {}),
          ...(e.mime_type !== undefined ? { mime_type: e.mime_type } : {}),
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
