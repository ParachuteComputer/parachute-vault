/**
 * MCP JSON-RPC error mapping — no double-wrap (vault#555 fix 6).
 *
 * Verified at code: the catch block in `handleMcp` read `err.message` and
 * fed it into a fresh `new McpError(...)`. The MCP SDK's `McpError`
 * constructor bakes `"MCP error <code>: "` into `.message` ITSELF (not just
 * `.toString()`) — confirmed directly against the SDK below. So an already-
 * formed `McpError` reaching that catch block (or a plain error whose
 * `.message` happens to already carry that prefix — e.g. forwarded verbatim
 * from another MCP-speaking service) got double-prefixed:
 * `"MCP error -32602: MCP error -32602: ..."`. The structured
 * `data.error_type` was always correct — only the human-readable `message`
 * string could double.
 *
 * `handleMcp` (the underlying dispatcher `handleScopedMcp` wraps) is
 * exported specifically so a test can inject a synthetic failing tool and
 * exercise the exact catch-block path without needing a real domain error
 * class that happens to throw an `McpError` naturally (none of core's tools
 * do — `McpError` is only ever constructed inside `mcp-http.ts` itself).
 */
import { describe, test, expect } from "bun:test";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { handleMcp, mcpDomainError } from "./mcp-http.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import type { AuthResult } from "./auth.ts";

function toolsWith(execute: (params: Record<string, unknown>) => unknown): () => McpToolDef[] {
  return () => [
    {
      name: "boom",
      description: "throws whatever `execute` throws",
      inputSchema: { type: "object", properties: {} },
      requiredVerb: "read",
      execute,
    },
  ];
}

function fullAuth(): AuthResult {
  return {
    permission: "full",
    scopes: ["vault:v:read", "vault:v:write", "vault:v:admin"],
    legacyDerived: false,
    scoped_tags: null,
    vault_name: null,
    caller_jti: null,
    actor: "test-user",
    via: "api",
  };
}

async function callBoom(execute: (params: Record<string, unknown>) => unknown): Promise<any> {
  const req = new Request("http://localhost:1940/vault/v/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    }),
  });
  const res = await handleMcp(req, toolsWith(execute), "test-server", "v", fullAuth(), "");
  return res.json();
}

describe("MCP SDK McpError — confirms the mechanics this fix depends on", () => {
  test("the SDK bakes the JSON-RPC prefix into .message itself, not just .toString()", () => {
    const err = new McpError(ErrorCode.InvalidParams, "bad stuff happened", { error_type: "invalid_query" });
    expect(err.message).toBe("MCP error -32602: bad stuff happened");
    // Naive re-wrap (the pre-fix behavior) doubles it — this is the exact
    // bug, reproduced directly against the SDK class.
    const naiveRewrap = new McpError(ErrorCode.InvalidParams, err.message, { error_type: "invalid_query" });
    expect(naiveRewrap.message).toBe("MCP error -32602: MCP error -32602: bad stuff happened");
  });
});

describe("mcpDomainError — single source of truth for the JSON-RPC mapping (vault#555 fix 6)", () => {
  test("a plain message gets the error_type token prepended (optional polish)", () => {
    const err = mcpDomainError(ErrorCode.InvalidParams, "bad stuff happened", { error_type: "invalid_query" });
    expect(err.message).toBe("MCP error -32602: [invalid_query] bad stuff happened");
    expect(err.data).toEqual({ error_type: "invalid_query" });
  });

  test("a message that ALREADY carries the JSON-RPC prefix is not doubled", () => {
    const err = mcpDomainError(ErrorCode.InvalidParams, "MCP error -32602: bad stuff happened", {
      error_type: "invalid_query",
    });
    expect(err.message).toBe("MCP error -32602: [invalid_query] bad stuff happened");
    expect(err.message).not.toContain("MCP error -32602: MCP error");
  });

  test("no error_type in data — message passes through without a bracketed token", () => {
    const err = mcpDomainError(ErrorCode.InternalError, "something broke", {});
    expect(err.message).toBe("MCP error -32603: something broke");
  });
});

describe("handleMcp JSON-RPC error mapping — end to end (vault#555 fix 6)", () => {
  test("a tool throwing an ALREADY-formed McpError passes through unchanged — no double prefix, data preserved verbatim", async () => {
    const inner = new McpError(ErrorCode.InvalidRequest, "conflict: note was modified", {
      error_type: "conflict",
      note_id: "abc123",
      hint: "re-read and retry",
    });
    const body = await callBoom(() => {
      throw inner;
    });
    expect(body.error.code).toBe(ErrorCode.InvalidRequest);
    // Single prefix — NOT "MCP error -32600: MCP error -32600: ...".
    expect(body.error.message).toBe("MCP error -32600: conflict: note was modified");
    expect((body.error.message.match(/MCP error/g) ?? []).length).toBe(1);
    // data.error_type fidelity preserved exactly — nothing re-derived.
    expect(body.error.data).toEqual({
      error_type: "conflict",
      note_id: "abc123",
      hint: "re-read and retry",
    });
  });

  test("a plain domain error (never wrapped) is mapped once, with the error_type token in the human message", async () => {
    const body = await callBoom(() => {
      throw Object.assign(new Error("something went wrong"), { error_type: "invalid_query", field: "limit" });
    });
    expect(body.error.message).toBe("MCP error -32602: [invalid_query] something went wrong");
    expect((body.error.message.match(/MCP error/g) ?? []).length).toBe(1);
    expect(body.error.data.error_type).toBe("invalid_query");
    expect(body.error.data.field).toBe("limit");
  });

  test("invalid_query forwards how_to (vault#617 bun/cloud symmetry)", async () => {
    const body = await callBoom(() => {
      throw Object.assign(new Error("size_bytes must be a positive number"), {
        error_type: "invalid_query",
        field: "size_bytes",
        how_to: "pass the exact byte length of the file you're about to upload",
      });
    });
    expect(body.error.data.error_type).toBe("invalid_query");
    expect(body.error.data.how_to).toBe("pass the exact byte length of the file you're about to upload");
  });

  test("a truly unknown error (no error_type anywhere) falls through to the unstructured isError text, not a thrown McpError", async () => {
    const body = await callBoom(() => {
      throw new Error("plain unstructured failure");
    });
    // No JSON-RPC `error` — the tool result carries isError: true instead.
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("plain unstructured failure");
  });
});
