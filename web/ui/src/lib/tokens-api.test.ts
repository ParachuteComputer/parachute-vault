/**
 * Tokens REST client — hub-JWT surface (vault#282 Stage 2 removed the legacy
 * pvt_* read/revoke client).
 *
 * `mintHubToken` / `listHubTokens` / `revokeHubToken` hit hub's `/api/auth/*`
 * registry with the host-admin bearer. The host-admin token is minted lazily
 * from `/admin/host-admin-token`, so the mock fetch routes that URL to a fresh
 * bearer and the `/api/auth/*` URLs to the registry shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToken } from "./auth.ts";
import { clearHostAdminToken } from "./host-admin-auth.ts";
import { HttpError } from "./api.ts";
import {
  listHubTokens,
  mintHubToken,
  revokeHubToken,
} from "./tokens-api.ts";

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

/** Standard host-admin mint response for `/admin/host-admin-token`. */
function hostAdminMint(token = "host.admin.jwt"): Response {
  return new Response(
    JSON.stringify({
      token,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      scopes: ["parachute:host:admin", "parachute:host:auth"],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  clearHostAdminToken();
  clearToken();
});

afterEach(() => {
  clearHostAdminToken();
  clearToken();
  vi.restoreAllMocks();
});

describe("mintHubToken", () => {
  it("POSTs the SINGULAR scope string per verb, with subject + expires_in", async () => {
    const calls = mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      return new Response(
        JSON.stringify({
          jti: "j_new",
          token: "vault.scoped.jwt",
          scope: "vault:work:write",
          expires_at: new Date(Date.now() + 90 * 86400_000).toISOString(),
        }),
        { status: 200 },
      );
    });

    const result = await mintHubToken("work", {
      verb: "write",
      label: "ci",
      scopedTags: [],
      ttlDays: 90,
    });

    // Reveal field is `token` (banner works unchanged) + the jti round-trips.
    expect(result.token).toBe("vault.scoped.jwt");
    expect(result.jti).toBe("j_new");

    const mintCall = calls.find((c) => c.url === "/api/auth/mint-token");
    expect(mintCall?.method).toBe("POST");
    expect(mintCall?.auth).toBe("Bearer host.admin.jwt");
    expect(mintCall?.contentType).toBe("application/json");
    const parsed = JSON.parse(mintCall!.body!);
    // SINGULAR `scope` string, not a `scopes` array.
    expect(parsed.scope).toBe("vault:work:write");
    expect(parsed).not.toHaveProperty("scopes");
    expect(parsed.subject).toBe("ci");
    expect(parsed.expires_in).toBe(90 * 86400);
    // Audience auto-derives server-side — we omit it.
    expect(parsed).not.toHaveProperty("audience");
  });

  it("uses the admin verb in the scope string", async () => {
    const calls = mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      return new Response(
        JSON.stringify({ jti: "j", token: "t", scope: "vault:work:admin", expires_at: null }),
        { status: 200 },
      );
    });

    await mintHubToken("work", { verb: "admin", label: "x", scopedTags: [], ttlDays: 30 });

    const parsed = JSON.parse(calls.find((c) => c.url === "/api/auth/mint-token")!.body!);
    expect(parsed.scope).toBe("vault:work:admin");
    expect(parsed.expires_in).toBe(30 * 86400);
  });

  it("adds permissions.scoped_tags when tags are selected", async () => {
    const calls = mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      return new Response(
        JSON.stringify({
          jti: "j",
          token: "t",
          scope: "vault:work:read",
          permissions: { scoped_tags: ["work", "health"] },
          expires_at: null,
        }),
        { status: 200 },
      );
    });

    await mintHubToken("work", {
      verb: "read",
      label: "scoped",
      scopedTags: ["work", "health"],
      ttlDays: 180,
    });

    const parsed = JSON.parse(calls.find((c) => c.url === "/api/auth/mint-token")!.body!);
    expect(parsed.permissions).toEqual({ scoped_tags: ["work", "health"] });
  });

  it("OMITS permissions entirely when no tags selected (vault C0 fail-closes on empty)", async () => {
    const calls = mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      return new Response(
        JSON.stringify({ jti: "j", token: "t", scope: "vault:work:read", expires_at: null }),
        { status: 200 },
      );
    });

    await mintHubToken("work", { verb: "read", label: "unscoped", scopedTags: [], ttlDays: 90 });

    const parsed = JSON.parse(calls.find((c) => c.url === "/api/auth/mint-token")!.body!);
    expect(parsed).not.toHaveProperty("permissions");
  });

  it("surfaces the server message on a 400 (e.g. expires_in too large)", async () => {
    mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      return new Response(
        JSON.stringify({ error: "invalid_request", error_description: "expires_in exceeds 365d cap" }),
        { status: 400 },
      );
    });

    await expect(
      mintHubToken("work", { verb: "read", label: "x", scopedTags: [], ttlDays: 9999 }),
    ).rejects.toMatchObject({ status: 400, message: "expires_in exceeds 365d cap" });
  });
});

describe("listHubTokens", () => {
  it("client-filters to only this vault's vault:<name>:* rows", async () => {
    mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      return new Response(
        JSON.stringify({
          tokens: [
            {
              jti: "j1",
              user_id: null,
              subject: "ci",
              client_id: "parachute-hub",
              scopes: ["vault:work:write"],
              expires_at: "2026-09-01T00:00:00Z",
              revoked_at: null,
              created_at: "2026-05-01T00:00:00Z",
              created_via: "cli_mint",
              permissions: null,
            },
            {
              // Different vault — must be filtered out.
              jti: "j2",
              user_id: null,
              subject: "other",
              client_id: "parachute-hub",
              scopes: ["vault:other:admin"],
              expires_at: "2026-09-01T00:00:00Z",
              revoked_at: null,
              created_at: "2026-05-01T00:00:00Z",
              created_via: "cli_mint",
              permissions: null,
            },
            {
              // Host-admin row — also filtered out.
              jti: "j3",
              user_id: "u1",
              subject: null,
              client_id: "parachute-hub-spa",
              scopes: ["parachute:host:admin", "parachute:host:auth"],
              expires_at: "2026-09-01T00:00:00Z",
              revoked_at: null,
              created_at: "2026-05-01T00:00:00Z",
              created_via: "oauth_refresh",
              permissions: null,
            },
          ],
          next_cursor: null,
        }),
        { status: 200 },
      );
    });

    const tokens = await listHubTokens("work");

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.jti).toBe("j1");
    expect(tokens[0]?.label).toBe("ci");
    expect(tokens[0]?.scopes).toEqual(["vault:work:write"]);
  });

  it("requests ?revoked=all and sends the host-admin bearer", async () => {
    const calls = mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      return new Response(JSON.stringify({ tokens: [], next_cursor: null }), { status: 200 });
    });

    await listHubTokens("work");

    const listCall = calls.find((c) => c.url.startsWith("/api/auth/tokens"));
    expect(listCall?.url).toContain("revoked=all");
    expect(listCall?.auth).toBe("Bearer host.admin.jwt");
  });

  it("follows next_cursor and accumulates ALL pages before filtering", async () => {
    let listPage = 0;
    const calls = mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      if (call.url.startsWith("/api/auth/tokens")) {
        listPage++;
        if (call.url.includes("cursor=")) {
          // Page 2 — final page, carries the matching vault row.
          return new Response(
            JSON.stringify({
              tokens: [
                {
                  jti: "page2-work",
                  user_id: null,
                  subject: "second-page-token",
                  client_id: "parachute-hub",
                  scopes: ["vault:work:admin"],
                  expires_at: "2026-09-01T00:00:00Z",
                  revoked_at: null,
                  created_at: "2026-04-01T00:00:00Z",
                  created_via: "cli_mint",
                  permissions: null,
                },
              ],
              next_cursor: null,
            }),
            { status: 200 },
          );
        }
        // Page 1 — only an unrelated vault, plus a cursor to page 2.
        return new Response(
          JSON.stringify({
            tokens: [
              {
                jti: "page1-other",
                user_id: null,
                subject: "x",
                client_id: "parachute-hub",
                scopes: ["vault:other:read"],
                expires_at: "2026-09-01T00:00:00Z",
                revoked_at: null,
                created_at: "2026-05-01T00:00:00Z",
                created_via: "cli_mint",
                permissions: null,
              },
            ],
            next_cursor: "CURSOR_TO_PAGE_2",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${call.url}`);
    });

    const tokens = await listHubTokens("work");

    // The matching row lives on PAGE 2 — single-page filtering would miss it.
    expect(listPage).toBe(2);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.jti).toBe("page2-work");
    expect(tokens[0]?.label).toBe("second-page-token");
    // The cursor from page 1 was threaded into the page-2 request.
    const page2Call = calls.find((c) => c.url.includes("cursor="));
    expect(page2Call?.url).toContain("cursor=CURSOR_TO_PAGE_2");
  });

  it("reads permissions.scoped_tags as a parsed object (no JSON.parse) and maps revoked rows", async () => {
    mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      return new Response(
        JSON.stringify({
          tokens: [
            {
              jti: "j-scoped",
              user_id: null,
              subject: "scoped-token",
              client_id: "parachute-hub",
              scopes: ["vault:work:read"],
              expires_at: "2026-09-01T00:00:00Z",
              revoked_at: "2026-05-10T00:00:00Z",
              created_at: "2026-05-01T00:00:00Z",
              created_via: "cli_mint",
              // permissions is already a PARSED object on the wire.
              permissions: { scoped_tags: ["health"] },
            },
          ],
          next_cursor: null,
        }),
        { status: 200 },
      );
    });

    const tokens = await listHubTokens("work");

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.scoped_tags).toEqual(["health"]);
    expect(tokens[0]?.revoked_at).toBe("2026-05-10T00:00:00Z");
  });
});

describe("revokeHubToken", () => {
  it("POSTs { jti } (not { id }) with the host-admin bearer", async () => {
    const calls = mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      return new Response(
        JSON.stringify({ jti: "j_abc", revoked_at: "2026-05-10T00:00:00Z" }),
        { status: 200 },
      );
    });

    await revokeHubToken("j_abc");

    const revokeCall = calls.find((c) => c.url === "/api/auth/revoke-token");
    expect(revokeCall?.method).toBe("POST");
    expect(revokeCall?.auth).toBe("Bearer host.admin.jwt");
    const parsed = JSON.parse(revokeCall!.body!);
    expect(parsed).toEqual({ jti: "j_abc" });
    expect(parsed).not.toHaveProperty("id");
  });

  it("is idempotent — re-revoking an already-revoked jti resolves (200)", async () => {
    mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      // Server returns the existing revoked_at + 200 for an already-revoked jti.
      return new Response(
        JSON.stringify({ jti: "j_abc", revoked_at: "2026-05-09T00:00:00Z" }),
        { status: 200 },
      );
    });

    await expect(revokeHubToken("j_abc")).resolves.toBeUndefined();
  });
});

describe("HttpError propagation", () => {
  it("listHubTokens surfaces a non-ok registry response", async () => {
    mockFetch(async (call) => {
      if (call.url === "/admin/host-admin-token") return hostAdminMint();
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    });

    await expect(listHubTokens("work")).rejects.toBeInstanceOf(HttpError);
  });
});
