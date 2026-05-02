/**
 * Auth helper for the vault admin SPA.
 *
 * Vault doesn't run its own session-cookie surface (unlike hub). Instead the
 * SPA expects a hub-issued JWT carrying a `vault:<name>:admin` scope — the
 * canonical token shape per scope-narrowing-and-audience. The token reaches
 * the SPA via URL fragment (`#token=…`), which the hub will append when its
 * directory page renders the "Manage" link to vault's managementUrl.
 *
 * Flow:
 *   1. Hub renders "Manage" → navigates to `<vault-origin>/admin/#token=<jwt>`.
 *   2. SPA bootstrap calls `captureTokenFromFragment()`, which reads the
 *      fragment, stashes the token in module-scoped state, and rewrites the
 *      URL with `history.replaceState` so a refresh / copy-paste / screenshot
 *      can't leak it.
 *   3. API calls in `lib/api.ts` read the cached token via `getToken()` and
 *      send it as `Authorization: Bearer <jwt>`.
 *
 * Storage: module-scoped variable, NEVER `localStorage` / `sessionStorage`.
 * Page snapshots can't carry it past a refresh, and the XSS surface is the
 * narrowest possible. Trade-off: a page reload without re-entering through
 * the hub leaves the SPA in an unauthenticated state — the operator goes
 * back to the hub directory and clicks "Manage" again. Phase B may bake in
 * a refresh path; Phase A keeps the contract minimal.
 */

let cachedToken: string | null = null;

/**
 * Read `#token=<jwt>` from `window.location.hash`, store it in module
 * state, and clean the hash off the visible URL. Idempotent — safe to call
 * multiple times. Called once at SPA bootstrap before React mounts so the
 * first render already has the token in hand.
 */
export function captureTokenFromFragment(): void {
  // Tests run without a window (jsdom provides one but it's worth being
  // defensive — captureTokenFromFragment is the FIRST thing main.tsx runs).
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get("token");
  if (!token) return;
  cachedToken = token;
  // Strip `#token=...` from the address bar without triggering navigation.
  // Preserve any other fragment params (none today, but keep the door open).
  params.delete("token");
  const remaining = params.toString();
  const newHash = remaining.length > 0 ? `#${remaining}` : "";
  const newUrl = `${window.location.pathname}${window.location.search}${newHash}`;
  window.history.replaceState(null, "", newUrl);
}

/** Read the current token. `null` when the SPA was loaded without one. */
export function getToken(): string | null {
  return cachedToken;
}

/** Drop the cached token. Used by tests; production has no sign-out yet. */
export function clearToken(): void {
  cachedToken = null;
}

/** Test seam: replace the cached token directly. */
export function _setTokenForTest(token: string | null): void {
  cachedToken = token;
}
