/**
 * Token-capture round trips. The fragment-strip is the load-bearing bit —
 * a token left in `window.location.hash` would leak via copy-paste and
 * `history.pushState` is the only reliable way to clean it without
 * reloading.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setTokenForTest, captureTokenFromFragment, clearToken, getToken } from "./auth.ts";

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
