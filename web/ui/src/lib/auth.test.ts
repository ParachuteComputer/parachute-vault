/**
 * Token-capture round trips. The fragment-strip is the load-bearing bit —
 * a token left in `window.location.hash` would leak via copy-paste and
 * `history.pushState` is the only reliable way to clean it without
 * reloading.
 *
 * Phase B (silent refresh) extends with:
 *   - `ensureToken` happy path + fallback semantics
 *   - proactive refresh timer fires at 80% of TTL
 *   - visibilitychange pauses + resumes the timer
 *   - mint endpoint response shape (token + expires_at)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _cancelRefreshTimerForTest,
  _getExpiresAtMsForTest,
  _resetVisibilityListenerForTest,
  _setTokenForTest,
  captureTokenFromFragment,
  clearToken,
  ensureToken,
  getToken,
  tryMintTokenFromHubSession,
} from "./auth.ts";

describe("captureTokenFromFragment", () => {
  beforeEach(() => {
    _setTokenForTest(null);
    window.history.replaceState(null, "", "/admin/");
  });

  afterEach(() => {
    clearToken();
    window.history.replaceState(null, "", "/admin/");
  });

  it("captures token from hash and strips it from the URL", () => {
    window.history.replaceState(null, "", "/admin/#token=abc.def.ghi");

    captureTokenFromFragment();

    expect(getToken()).toBe("abc.def.ghi");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/admin/");
  });

  it("preserves other fragment params alongside the stripped token", () => {
    window.history.replaceState(null, "", "/admin/#token=jwt&theme=dark");

    captureTokenFromFragment();

    expect(getToken()).toBe("jwt");
    // URLSearchParams may reorder; just check `token` is gone and the rest
    // is preserved.
    expect(window.location.hash).toBe("#theme=dark");
  });

  it("is a no-op when the hash is empty", () => {
    window.history.replaceState(null, "", "/admin/vault/work");

    captureTokenFromFragment();

    expect(getToken()).toBeNull();
    expect(window.location.pathname).toBe("/admin/vault/work");
  });

  it("is a no-op when the hash carries no token param", () => {
    window.history.replaceState(null, "", "/admin/#section=stats");

    captureTokenFromFragment();

    expect(getToken()).toBeNull();
    expect(window.location.hash).toBe("#section=stats");
  });
});

describe("tryMintTokenFromHubSession", () => {
  // The vault SPA boots without a token whenever the operator clicked a
  // surface that doesn't pre-mint one — notably hub's discovery-page vault
  // tile (rendered as a plain anchor from `module.json:uiUrl`), or the
  // operator just hit Cmd+R. Bypass path: same-origin GET against the
  // hub's session-gated mint endpoint.
  beforeEach(() => {
    _setTokenForTest(null);
    _cancelRefreshTimerForTest();
  });

  afterEach(() => {
    clearToken();
    _cancelRefreshTimerForTest();
    vi.restoreAllMocks();
  });

  it("stashes the token returned by the hub session-mint endpoint on 200", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "minted.jwt.abc",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          scopes: ["vault:work:admin"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await tryMintTokenFromHubSession("work");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/admin/vault-admin-token/work",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(getToken()).toBe("minted.jwt.abc");
  });

  it("leaves the token unset on 401 (operator has no hub session)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );

    await tryMintTokenFromHubSession("work");

    expect(getToken()).toBeNull();
  });

  it("leaves the token unset on 403 (signed-in but not the hub admin)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not_admin" }), { status: 403 }),
    );

    await tryMintTokenFromHubSession("work");

    expect(getToken()).toBeNull();
  });

  it("leaves the token unset on 404 (vault not installed on this hub)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    );

    await tryMintTokenFromHubSession("work");

    expect(getToken()).toBeNull();
  });

  it("swallows network errors silently (no throw)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));

    await expect(tryMintTokenFromHubSession("work")).resolves.toBeUndefined();
    expect(getToken()).toBeNull();
  });

  it("URL-encodes the vault name segment", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ token: "x.y.z", expires_at: new Date(Date.now() + 600_000).toISOString(), scopes: [] }),
        { status: 200 },
      ),
    );

    await tryMintTokenFromHubSession("name with spaces");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/admin/vault-admin-token/name%20with%20spaces",
      expect.anything(),
    );
  });

  it("is a no-op when a token is already cached (fragment path won — don't reset to a stale mint)", async () => {
    _setTokenForTest("from-fragment.jwt");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await tryMintTokenFromHubSession("work");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getToken()).toBe("from-fragment.jwt");
  });

  it("leaves the token unset when the 200 body has no `token` field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ expires_at: new Date(Date.now() + 600_000).toISOString() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await tryMintTokenFromHubSession("work");

    expect(getToken()).toBeNull();
  });
});

describe("ensureToken", () => {
  // The silent-refresh entrypoint. Three return shapes: `ok` (cached or
  // freshly-minted token in hand), `auth-required` (401/403/404 from hub
  // — operator needs to sign in), `network-error` (transient hub
  // unreachable — caller renders retry).
  beforeEach(() => {
    _setTokenForTest(null);
    _cancelRefreshTimerForTest();
  });

  afterEach(() => {
    clearToken();
    _cancelRefreshTimerForTest();
    vi.restoreAllMocks();
  });

  it("returns the cached token without a network call when one is in hand", async () => {
    _setTokenForTest("cached.jwt");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await ensureToken("work");

    expect(result).toEqual({ kind: "ok", token: "cached.jwt" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mints a fresh token on 200 and caches it + the expiry", async () => {
    const futureIso = new Date(Date.now() + 600_000).toISOString();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ token: "fresh.jwt", expires_at: futureIso, scopes: [] }),
        { status: 200 },
      ),
    );

    const result = await ensureToken("work");

    expect(result).toEqual({ kind: "ok", token: "fresh.jwt" });
    expect(getToken()).toBe("fresh.jwt");
    expect(_getExpiresAtMsForTest()).toBe(Date.parse(futureIso));
  });

  it("returns auth-required (status 401) when hub has no session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );

    const result = await ensureToken("work");

    expect(result).toEqual({ kind: "auth-required", status: 401 });
    expect(getToken()).toBeNull();
  });

  it("returns auth-required (status 403) when operator isn't the first admin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not_admin" }), { status: 403 }),
    );

    const result = await ensureToken("work");

    expect(result).toEqual({ kind: "auth-required", status: 403 });
  });

  it("returns auth-required (status 404) when the vault isn't on this hub", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    );

    const result = await ensureToken("work");

    expect(result).toEqual({ kind: "auth-required", status: 404 });
  });

  it("returns network-error on transient hub failure (5xx) — not the banner path", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream error", { status: 503 }),
    );

    const result = await ensureToken("work");

    expect(result.kind).toBe("network-error");
  });

  it("returns network-error on fetch reject (DNS / offline)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));

    const result = await ensureToken("work");

    expect(result.kind).toBe("network-error");
  });

  it("re-mints when the cached token is past its expiry", async () => {
    _setTokenForTest("stale.jwt");
    // The test seam doesn't write expiry, so set it via a successful
    // first mint then advance time.
    const pastIso = new Date(Date.now() - 1000).toISOString();
    const futureIso = new Date(Date.now() + 600_000).toISOString();
    // First mint: write a past expiry so the second `ensureToken` call
    // sees the cached token as expired.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: "first.jwt", expires_at: pastIso, scopes: [] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: "second.jwt", expires_at: futureIso, scopes: [] }),
          { status: 200 },
        ),
      );

    // Clear the test-seam token; rely on the mint to set it (so expiry
    // gets recorded).
    _setTokenForTest(null);
    const first = await ensureToken("work");
    expect(first).toEqual({ kind: "ok", token: "first.jwt" });

    const second = await ensureToken("work");
    expect(second).toEqual({ kind: "ok", token: "second.jwt" });
    expect(getToken()).toBe("second.jwt");
  });
});

describe("proactive refresh timer", () => {
  // Cut 2 — the timer fires at 80% of TTL so a long-running admin session
  // never hits the 10-minute wall mid-work. Uses vitest fake timers so we
  // can advance ms-by-ms without sleeping.
  beforeEach(() => {
    vi.useFakeTimers();
    _setTokenForTest(null);
    _cancelRefreshTimerForTest();
  });

  afterEach(() => {
    _cancelRefreshTimerForTest();
    vi.useRealTimers();
    clearToken();
    vi.restoreAllMocks();
  });

  it("schedules a refresh at 80% of the mint TTL", async () => {
    const ttlMs = 600_000; // 10 minutes
    const futureIso = new Date(Date.now() + ttlMs).toISOString();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ token: "first.jwt", expires_at: futureIso, scopes: [] }),
        { status: 200 },
      ),
    );

    await ensureToken("work");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getToken()).toBe("first.jwt");

    // Re-arm fetch for the proactive refresh. Wait for any pending
    // microtasks so the new resolved value is the one the timer picks up.
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "refreshed.jwt",
          expires_at: new Date(Date.now() + 2 * ttlMs).toISOString(),
          scopes: [],
        }),
        { status: 200 },
      ),
    );

    // Advance to just BEFORE the 80%-TTL mark — refresh shouldn't have
    // fired yet.
    await vi.advanceTimersByTimeAsync(ttlMs * 0.8 - 1000);
    expect(getToken()).toBe("first.jwt");

    // Cross the 80% threshold.
    await vi.advanceTimersByTimeAsync(2000);
    expect(getToken()).toBe("refreshed.jwt");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not fire the timer when no expiry is known (fragment-only token)", async () => {
    // A fragment-supplied token has no associated expiry — we rely on
    // 401-retry, not the proactive timer.
    _setTokenForTest("fragment.jwt");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await ensureToken("work");

    // Advance well past any reasonable TTL.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getToken()).toBe("fragment.jwt");
  });
});

describe("visibilitychange pause/resume", () => {
  // The proactive timer should pause when the tab is hidden so we don't
  // hammer the hub once per 8 minutes for a tab the operator never opens
  // again. Resume on `visible` re-arms a fresh timer.
  let visibilityState: "visible" | "hidden" = "visible";

  beforeEach(() => {
    vi.useFakeTimers();
    _setTokenForTest(null);
    _cancelRefreshTimerForTest();
    _resetVisibilityListenerForTest();
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
  });

  afterEach(() => {
    _cancelRefreshTimerForTest();
    vi.useRealTimers();
    clearToken();
    vi.restoreAllMocks();
  });

  it("cancels the proactive timer when the tab goes hidden, re-arms on visible", async () => {
    const ttlMs = 600_000;
    const futureIso = new Date(Date.now() + ttlMs).toISOString();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ token: "first.jwt", expires_at: futureIso, scopes: [] }),
        { status: 200 },
      ),
    );

    await ensureToken("work");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Hide the tab. The visibility listener should cancel the pending
    // proactive timer.
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));

    // Even after the 80%-TTL window, no refresh fires while hidden.
    await vi.advanceTimersByTimeAsync(ttlMs * 0.9);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Return to visible. The listener re-arms the timer with the
    // remaining lifetime. To prove it re-arms (rather than firing
    // immediately), check that no extra call happened on resume itself
    // — but a subsequent advance does trigger one. (We're already past
    // the 80% mark, so the next arm uses a clamped MIN delay of 1000ms.)
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Re-arm the second response for the proactive refresh.
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "second.jwt",
          expires_at: new Date(Date.now() + ttlMs).toISOString(),
          scopes: [],
        }),
        { status: 200 },
      ),
    );

    // The re-armed timer schedules at 80% of the *remaining* lifetime
    // (not 80% of the original TTL — the timer doesn't track the
    // issued-at). After being hidden for 90% of the original TTL, the
    // remaining 10% is 60s; 80% of that is 48s. Advance past it.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(getToken()).toBe("second.jwt");
  });
});
