/**
 * API client surface. Three narrow tests:
 *   - `listVaultNames` public-list 404→empty path
 *   - `getVaultDetail` auth-error shape
 *   - the silent-refresh single-retry on 401 path inside `_authedFetch`
 *
 * The fetch surface is mocked via `vi.stubGlobal`; restoreMocks in
 * setup.ts wipes the stub between tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _cancelRefreshTimerForTest, _setTokenForTest, clearToken } from "./auth.ts";
import { HttpError, getVaultDetail, listVaultNames } from "./api.ts";

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("listVaultNames", () => {
  beforeEach(() => {
    _setTokenForTest(null);
  });
  afterEach(() => {
    clearToken();
  });

  it("returns the vault names from the public endpoint", async () => {
    mockFetch(async () => new Response(JSON.stringify({ vaults: ["work", "home"] }), { status: 200 }));

    const names = await listVaultNames();

    expect(names).toEqual(["work", "home"]);
  });

  it("returns an empty list when discovery is disabled (404)", async () => {
    mockFetch(async () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 }));

    const names = await listVaultNames();

    expect(names).toEqual([]);
  });

  it("throws HttpError on a non-404 failure", async () => {
    mockFetch(async () => new Response("boom", { status: 500 }));

    await expect(listVaultNames()).rejects.toBeInstanceOf(HttpError);
  });
});

describe("getVaultDetail", () => {
  beforeEach(() => {
    _cancelRefreshTimerForTest();
  });

  afterEach(() => {
    clearToken();
    _cancelRefreshTimerForTest();
  });

  it("rejects with HttpError(401) when no cached token + silent refresh fails", async () => {
    _setTokenForTest(null);
    // Mock fetch so the silent-refresh call to `/admin/vault-admin-token`
    // returns 401 — there's no hub session to recover from.
    mockFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/admin/vault-admin-token/")) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
      }
      // Shouldn't reach the vault detail endpoint if the silent refresh
      // failed.
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(getVaultDetail("work")).rejects.toMatchObject({
      name: "HttpError",
      status: 401,
    });
  });

  it("sends the cached token as a Bearer header and returns the response body", async () => {
    _setTokenForTest("jwt-here");
    const calls: Array<{ url: string; auth: string | null }> = [];
    mockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") });
      return new Response(
        JSON.stringify({
          name: "work",
          description: null,
          createdAt: "2026-04-01T00:00:00Z",
          stats: { totalNotes: 12, tagCount: 3, attachmentCount: 1, linkCount: 4 },
        }),
        { status: 200 },
      );
    });

    const detail = await getVaultDetail("work");

    expect(detail.name).toBe("work");
    expect(detail.stats.totalNotes).toBe(12);
    expect(calls[0]?.url).toBe("/vault/work/");
    expect(calls[0]?.auth).toBe("Bearer jwt-here");
  });

  it("surfaces server error messages on non-2xx responses", async () => {
    _setTokenForTest("jwt-here");
    mockFetch(async () =>
      new Response(JSON.stringify({ error: "Forbidden", message: "scope mismatch" }), { status: 403 }),
    );

    await expect(getVaultDetail("work")).rejects.toMatchObject({
      name: "HttpError",
      status: 403,
      message: "scope mismatch",
    });
  });
});

describe("authedFetch single-retry on 401", () => {
  // Cut 3 — when a stale Bearer comes back 401 mid-session, the fetch
  // wrapper silently mints a fresh one and retries once. Verifies via
  // the `getVaultDetail` surface (which routes through `_authedFetch`).
  beforeEach(() => {
    _cancelRefreshTimerForTest();
  });

  afterEach(() => {
    clearToken();
    _cancelRefreshTimerForTest();
  });

  it("retries the request once on 401 with a freshly-minted token", async () => {
    _setTokenForTest("stale.jwt");
    const calls: Array<{ url: string; auth: string | null }> = [];
    let detailCallCount = 0;
    mockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") });
      if (url.startsWith("/admin/vault-admin-token/")) {
        return new Response(
          JSON.stringify({
            token: "fresh.jwt",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            scopes: ["vault:work:admin"],
          }),
          { status: 200 },
        );
      }
      // First detail call → 401 (stale token). Second → 200.
      detailCallCount += 1;
      if (detailCallCount === 1) {
        return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      }
      return new Response(
        JSON.stringify({
          name: "work",
          description: null,
          createdAt: "2026-04-01T00:00:00Z",
          stats: { totalNotes: 1, tagCount: 0, attachmentCount: 0, linkCount: 0 },
        }),
        { status: 200 },
      );
    });

    const detail = await getVaultDetail("work");

    expect(detail.name).toBe("work");
    // Three calls: detail-401 → mint-200 → detail-200.
    expect(calls.length).toBe(3);
    expect(calls[0]?.auth).toBe("Bearer stale.jwt");
    expect(calls[1]?.url).toBe("/admin/vault-admin-token/work");
    expect(calls[2]?.auth).toBe("Bearer fresh.jwt");
  });

  it("throws the original 401 when both the first request AND the silent refresh fail", async () => {
    _setTokenForTest("stale.jwt");
    mockFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/admin/vault-admin-token/")) {
        // Silent refresh fails — operator has no hub session.
        return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
      }
      // Original request returns 401.
      return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
    });

    await expect(getVaultDetail("work")).rejects.toMatchObject({
      name: "HttpError",
      status: 401,
    });
  });

  it("does not retry on non-401 errors (preserves 403, 404, 5xx semantics)", async () => {
    _setTokenForTest("good.jwt");
    let detailCallCount = 0;
    mockFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/admin/vault-admin-token/")) {
        throw new Error("silent refresh should not fire on 403");
      }
      detailCallCount += 1;
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    });

    await expect(getVaultDetail("work")).rejects.toMatchObject({
      name: "HttpError",
      status: 403,
    });
    expect(detailCallCount).toBe(1);
  });
});
