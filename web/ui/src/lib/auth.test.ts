/**
 * Token-capture round trips. The fragment-strip is the load-bearing bit —
 * a token left in `window.location.hash` would leak via copy-paste and
 * `history.pushState` is the only reliable way to clean it without
 * reloading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _setTokenForTest,
  captureTokenFromFragment,
  clearToken,
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
  // tile (rendered as a plain anchor from `module.json:uiUrl`). Bypass
  // path: same-origin GET against the hub's session-gated mint endpoint.
  beforeEach(() => {
    _setTokenForTest(null);
  });

  afterEach(() => {
    clearToken();
    vi.restoreAllMocks();
  });

  it("stashes the token returned by the hub session-mint endpoint on 200", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "minted.jwt.abc",
          expires_at: "2026-01-01T00:00:00.000Z",
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

  it("swallows network errors silently (no throw)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));

    await expect(tryMintTokenFromHubSession("work")).resolves.toBeUndefined();
    expect(getToken()).toBeNull();
  });

  it("URL-encodes the vault name segment", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: "x.y.z", expires_at: "2026", scopes: [] }), {
        status: 200,
      }),
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
      new Response(JSON.stringify({ expires_at: "2026" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await tryMintTokenFromHubSession("work");

    expect(getToken()).toBeNull();
  });
});
