/**
 * Host-admin auth helper — the separate bearer the tokens page mints from
 * hub's session-cookie-gated `/admin/host-admin-token` to call the
 * `/api/auth/*` registry endpoints.
 *
 * Covered:
 *   - `ensureHostAdminToken` — 200 caches; cached returned without a network
 *     call; 401/404 → auth-required; 403 → forbidden; 5xx → network-error;
 *     expiry → re-mint.
 *   - `hostAdminAuthedFetch` — sends the bearer; 401-retry re-mints + retries;
 *     a failed refresh throws `HostAdminError` with the right disposition.
 *   - `redirectToAccountHome` — 403 → `<issuer>/account/`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setTokenForTest, clearToken } from "./auth.ts";
import {
  HostAdminError,
  _getHostAdminTokenForTest,
  clearHostAdminToken,
  ensureHostAdminToken,
  hostAdminAuthedFetch,
  redirectToAccountHome,
} from "./host-admin-auth.ts";

function mintResponse(token = "ha.jwt", ttlMs = 600_000): Response {
  return new Response(
    JSON.stringify({
      token,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
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

describe("ensureHostAdminToken", () => {
  it("mints on 200 and caches the token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mintResponse());

    const result = await ensureHostAdminToken();

    expect(result).toEqual({ kind: "ok", token: "ha.jwt" });
    expect(_getHostAdminTokenForTest()).toBe("ha.jwt");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/admin/host-admin-token",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("returns the cached token without a second network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mintResponse());
    await ensureHostAdminToken();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const again = await ensureHostAdminToken();

    expect(again).toEqual({ kind: "ok", token: "ha.jwt" });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // still 1 — served from cache.
  });

  it("returns auth-required on 401 (no hub session)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );

    const result = await ensureHostAdminToken();

    expect(result).toEqual({ kind: "auth-required", status: 401 });
    expect(_getHostAdminTokenForTest()).toBeNull();
  });

  it("returns auth-required on 404 (vault not on this hub)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    );

    const result = await ensureHostAdminToken();

    expect(result).toEqual({ kind: "auth-required", status: 404 });
  });

  it("returns forbidden on 403 (friend account, not the hub admin)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not_admin" }), { status: 403 }),
    );

    const result = await ensureHostAdminToken();

    expect(result).toEqual({ kind: "forbidden" });
    expect(_getHostAdminTokenForTest()).toBeNull();
  });

  it("returns network-error on 5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream", { status: 503 }));

    const result = await ensureHostAdminToken();

    expect(result.kind).toBe("network-error");
  });

  it("re-mints when the cached token is past its expiry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mintResponse("first.jwt", -1000)) // already expired
      .mockResolvedValueOnce(mintResponse("second.jwt", 600_000));

    const first = await ensureHostAdminToken();
    expect(first).toEqual({ kind: "ok", token: "first.jwt" });

    // Cached token's expiry is in the past → next call re-mints.
    const second = await ensureHostAdminToken();
    expect(second).toEqual({ kind: "ok", token: "second.jwt" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("hostAdminAuthedFetch", () => {
  it("attaches the host-admin bearer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/admin/host-admin-token") return mintResponse();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await hostAdminAuthedFetch("/api/auth/tokens");

    expect(res.ok).toBe(true);
    const apiCall = fetchSpy.mock.calls.find(([u]) => String(u) === "/api/auth/tokens");
    const headers = new Headers((apiCall![1] as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer ha.jwt");
  });

  it("on 401 clears the cached token, re-mints, and retries once", async () => {
    let mintCount = 0;
    let apiCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/admin/host-admin-token") {
        mintCount++;
        return mintResponse(`mint-${mintCount}`);
      }
      apiCount++;
      // First API hit 401s (stale token); the retry (with the re-minted
      // bearer) succeeds.
      return apiCount === 1
        ? new Response("unauthorized", { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await hostAdminAuthedFetch("/api/auth/tokens");

    expect(res.status).toBe(200);
    expect(mintCount).toBe(2); // initial mint + re-mint on 401.
    expect(apiCount).toBe(2); // original + retry.
  });

  it("throws HostAdminError(auth-required) when the (re)mint can't get a session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );

    await expect(hostAdminAuthedFetch("/api/auth/tokens")).rejects.toMatchObject({
      name: "HostAdminError",
      disposition: "auth-required",
    });
  });

  it("throws HostAdminError(forbidden) when the operator is a friend account", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not_admin" }), { status: 403 }),
    );

    const err = await hostAdminAuthedFetch("/api/auth/tokens").catch((e) => e);
    expect(err).toBeInstanceOf(HostAdminError);
    expect((err as HostAdminError).disposition).toBe("forbidden");
  });
});

describe("redirectToAccountHome", () => {
  // Capture the REAL `window.location` property descriptor so we can restore
  // it byte-for-byte after each test. Replacing `window.location` with a stub
  // and then rebuilding it from a string leaks a non-jsdom Location into
  // sibling suites that share the worker (caused a flaky VaultMirror failure
  // when the run order put it after this block). Precise restore avoids that.
  const originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, "location");

  function stubLocationHref(): string[] {
    const assigned: string[] = [];
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        set href(v: string) {
          assigned.push(v);
        },
        get href() {
          return assigned[assigned.length - 1] ?? "";
        },
      } as unknown as Location,
    });
    return assigned;
  }

  afterEach(() => {
    if (originalLocationDescriptor) {
      Object.defineProperty(window, "location", originalLocationDescriptor);
    }
  });

  it("redirects to <issuer>/account/ using the JWT issuer origin", () => {
    // The vault-admin JWT carries the `iss` claim getIssuerOrigin reads.
    // Build a token whose payload has iss=https://hub.example.com.
    const payload = btoa(JSON.stringify({ iss: "https://hub.example.com/" }));
    _setTokenForTest(`h.${payload}.s`);

    const assigned = stubLocationHref();
    redirectToAccountHome();

    expect(assigned[0]).toBe("https://hub.example.com/account/");
  });

  it("falls back to a relative /account/ when no issuer is known", () => {
    _setTokenForTest(null);

    const assigned = stubLocationHref();
    redirectToAccountHome();

    expect(assigned[0]).toBe("/account/");
  });
});
