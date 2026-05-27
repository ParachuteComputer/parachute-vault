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
 *   1. Hub renders "Manage" → navigates to
 *      `<hub-origin>/vault/<name>/admin/#token=<jwt>` (vault#252 per-vault
 *      mount; the bundle is reachable through hub's `/vault/<name>/*`
 *      proxy).
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

/**
 * Fallback bootstrap path: when the SPA loads at `/vault/<name>/admin/`
 * without a `#token=...` fragment (i.e. the operator clicked the vault tile
 * on hub's discovery page, or refreshed an authenticated tab), attempt to
 * mint a token from the hub-issued session cookie.
 *
 * The hub exposes `GET /admin/vault-admin-token/<name>` for exactly this
 * trade: it reads the `parachute_hub_session` cookie, verifies the operator
 * is the first admin, and returns a short-lived `vault:<name>:admin` JWT.
 * Same-origin fetch carries the cookie automatically (hub serves both `/`
 * and `/vault/<name>/admin/` from the same origin via its reverse proxy).
 *
 * Behavior:
 *   - On 200: cache the token (same module-scoped slot
 *     `captureTokenFromFragment` writes to). Subsequent `getToken()` calls
 *     return it.
 *   - On 401/403/404 or network error: leave the cache empty. The SPA
 *     proceeds to its existing `auth-required` empty state, which tells
 *     the operator to open the page from hub's directory. (404 should be
 *     impossible — the operator wouldn't have a tile to click for a vault
 *     that isn't installed — but treat it the same as 401 for safety.)
 *
 * Why fragment-first, cookie-second: the `Manage` button mints via fragment
 * because it doesn't depend on the SPA's mount being same-origin with the
 * token issuer. The cookie fallback works only when hub and the SPA share
 * an origin, which is the canonical owner-operated deploy shape but not
 * universal. Keep both paths — they're complementary, not redundant.
 *
 * Idempotent — safe to call multiple times, only sets the cache on a fresh
 * successful mint.
 */
export async function tryMintTokenFromHubSession(vaultName: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (cachedToken) return;
  try {
    const res = await fetch(
      `/admin/vault-admin-token/${encodeURIComponent(vaultName)}`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
      },
    );
    if (!res.ok) return;
    const body = (await res.json()) as { token?: string };
    if (typeof body.token === "string" && body.token.length > 0) {
      cachedToken = body.token;
    }
  } catch (_e) {
    // Network / CORS / parse error — silent fallback to the existing
    // auth-required empty state. The SPA still renders; the operator gets
    // a clear message to open from the hub directory.
  }
}
