/**
 * API client surface. Two narrow tests: the public-list 404→empty path,
 * and the per-vault detail auth-error shape. The fetch surface is mocked
 * via `vi.stubGlobal`; restoreMocks in setup.ts wipes the stub between
 * tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setTokenForTest, clearToken } from "./auth.ts";
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
  afterEach(() => {
    clearToken();
  });

  it("rejects with HttpError(401) when no token is cached", async () => {
    _setTokenForTest(null);

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
          stats: { notes: 12, tags: 3, attachments: 1, links: 4 },
        }),
        { status: 200 },
      );
    });

    const detail = await getVaultDetail("work");

    expect(detail.name).toBe("work");
    expect(detail.stats.notes).toBe(12);
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
