/**
 * Tokens REST client. Tests cover the auth gate (no cached token → 401), the
 * shape of the GET / POST / DELETE calls (URL, method, headers), and the
 * server-error surfacing path that matches `getVaultDetail`'s behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { _setTokenForTest, clearToken } from "./auth.ts";
import { HttpError } from "./api.ts";
import { listTokens, mintToken, revokeToken } from "./tokens-api.ts";

interface Call {
  url: string;
  method: string;
  auth: string | null;
  contentType: string | null;
  body: string | null;
}

function mockFetch(impl: (call: Call) => Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        auth: headers.get("authorization"),
        contentType: headers.get("content-type"),
        body: typeof init?.body === "string" ? init.body : null,
      };
      calls.push(call);
      return impl(call);
    }),
  );
  return calls;
}

describe("tokens-api auth gate", () => {
  afterEach(() => {
    clearToken();
  });

  it("listTokens throws HttpError(401) when no token is cached", async () => {
    _setTokenForTest(null);
    await expect(listTokens("work")).rejects.toMatchObject({
      name: "HttpError",
      status: 401,
    });
  });

  it("mintToken throws HttpError(401) when no token is cached", async () => {
    _setTokenForTest(null);
    await expect(mintToken("work", { label: "test" })).rejects.toBeInstanceOf(HttpError);
  });

  it("revokeToken throws HttpError(401) when no token is cached", async () => {
    _setTokenForTest(null);
    await expect(revokeToken("work", "t_abc")).rejects.toBeInstanceOf(HttpError);
  });
});

describe("listTokens", () => {
  afterEach(() => {
    clearToken();
  });

  it("hits the right URL with the cached token and returns body.tokens", async () => {
    _setTokenForTest("jwt-here");
    const calls = mockFetch(async () =>
      new Response(
        JSON.stringify({
          tokens: [
            {
              id: "t_abc123",
              label: "ci",
              permission: "full",
              scopes: ["vault:work:write"],
              expires_at: null,
              created_at: "2026-05-01T00:00:00Z",
              last_used_at: null,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const tokens = await listTokens("work");

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.label).toBe("ci");
    expect(calls[0]?.url).toBe("/vault/work/tokens");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.auth).toBe("Bearer jwt-here");
  });
});

describe("mintToken", () => {
  afterEach(() => {
    clearToken();
  });

  it("POSTs label + scopes as JSON, returns the plaintext token", async () => {
    _setTokenForTest("jwt-here");
    const calls = mockFetch(async () =>
      new Response(
        JSON.stringify({
          id: "t_new",
          token: "pvt_secret_value",
          label: "ci",
          permission: "full",
          scopes: ["vault:work:write"],
          expires_at: null,
          created_at: "2026-05-02T00:00:00Z",
          last_used_at: null,
        }),
        { status: 201 },
      ),
    );

    const result = await mintToken("work", { label: "ci", scopes: ["vault:work:write"] });

    expect(result.token).toBe("pvt_secret_value");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.contentType).toBe("application/json");
    const parsed = calls[0]?.body ? JSON.parse(calls[0].body) : {};
    expect(parsed).toEqual({ label: "ci", scopes: ["vault:work:write"] });
  });

  it("omits empty fields from the request body", async () => {
    _setTokenForTest("jwt-here");
    const calls = mockFetch(async () =>
      new Response(JSON.stringify({ id: "t_x", token: "pvt_x", label: "API token", permission: "full", scopes: [], expires_at: null, created_at: "x", last_used_at: null }), { status: 201 }),
    );

    await mintToken("work", {});

    const parsed = calls[0]?.body ? JSON.parse(calls[0].body) : null;
    expect(parsed).toEqual({});
  });

  it("surfaces the server message on a 400 (e.g. scope rejected)", async () => {
    _setTokenForTest("jwt-here");
    mockFetch(async () =>
      new Response(
        JSON.stringify({ error: "Bad Request", message: "scope rejected", rejected: ["vault:other:write"] }),
        { status: 400 },
      ),
    );

    await expect(mintToken("work", { scopes: ["vault:other:write"] })).rejects.toMatchObject({
      status: 400,
      message: "scope rejected",
    });
  });
});

describe("revokeToken", () => {
  afterEach(() => {
    clearToken();
  });

  it("DELETEs the right URL with the cached token", async () => {
    _setTokenForTest("jwt-here");
    const calls = mockFetch(async () =>
      new Response(JSON.stringify({ revoked: true }), { status: 200 }),
    );

    await revokeToken("work", "t_abc123");

    expect(calls[0]?.url).toBe("/vault/work/tokens/t_abc123");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.auth).toBe("Bearer jwt-here");
  });
});
