/**
 * Auth helper for the vault admin SPA.
 *
 * Vault doesn't run its own session-cookie surface (unlike hub). Instead the
 * SPA expects a hub-issued JWT carrying a `vault:<name>:admin` scope — the
 * canonical token shape per scope-narrowing-and-audience. The token reaches
 * the SPA via URL fragment (`#token=…`) when the operator clicks "Manage"
 * in the hub directory.
 *
 * Phase A (vault#219) was fragment-then-in-memory only — a page reload
 * scrubbed the fragment and dropped the cached token, leaving the SPA in
 * an "Open this page from the hub's directory" empty state. Aaron hits
 * that papercut every time he refreshes a vault admin page.
 *
 * Phase B (this file, vault PR for "silent auth refresh") makes the SPA
 * self-heal: when there's no cached token, we GET
 * `/admin/vault-admin-token/<name>` against the hub (same-origin via hub's
 * `/vault/<name>/*` proxy, session cookie auto-attached). On 200 we cache
 * the freshly-minted JWT + its absolute expiry and proactively re-mint at
 * 80% of TTL so a long-running admin session never hits the 10-minute
 * wall mid-work. On 401/403/404 we fall back to the empty state — the
 * banner copy now says "sign in to the hub" since that's what actually
 * unblocks the operator, with a poll-on-banner-display that auto-recovers
 * once the cookie's there.
 *
 * Storage: module-scoped variable, NEVER `localStorage` / `sessionStorage`.
 * Page snapshots can't carry it past a refresh (the silent-refresh path
 * is the refresh story), and the XSS surface is the narrowest possible.
 */

let cachedToken: string | null = null;
/** Absolute expiry, ms since epoch. `null` when no token cached, or when
 *  the mint response didn't carry an `expires_at` (we then treat the token
 *  as opaque-but-usable and rely on 401-retry to refresh). */
let cachedExpiresAtMs: number | null = null;

/** Proactive refresh timer handle. `null` when the timer isn't scheduled. */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Vault name to use for proactive refreshes. Set when a token is cached. */
let activeVaultName: string | null = null;
/** Listeners installed for tab-visibility integration; tracked so we can
 *  detach them in tests (and theoretically a future sign-out path). */
let visibilityListenerInstalled = false;

/**
 * Refresh at 80% of TTL — gives us a 20% safety margin before the token
 * actually expires. For the canonical 10-minute hub mint that's a refresh
 * at 8 minutes, leaving 2 minutes of slack if the refresh fails.
 */
const REFRESH_FRACTION = 0.8;

/**
 * Floor on the proactive refresh delay. Below this we treat the token as
 * effectively-expired and refresh immediately (still on the next
 * microtask via setTimeout(0)).
 */
const MIN_REFRESH_DELAY_MS = 1000;

/**
 * Retry the proactive refresh once after this delay if the first attempt
 * fails. We don't let proactive failures surface as the auth-required
 * banner — the existing token is still valid for ~20% of its TTL when
 * the refresh fired, so let the next 401 trigger an interactive recovery
 * instead.
 */
const PROACTIVE_RETRY_DELAY_MS = 30_000;

/**
 * Read `#token=<jwt>` from `window.location.hash`, store it in module
 * state, and clean the hash off the visible URL. Idempotent — safe to call
 * multiple times. Called once at SPA bootstrap before React mounts so the
 * first render already has the token in hand.
 *
 * Note: when a fragment token is captured we don't know its TTL (the hub
 * doesn't surface `expires_at` in the fragment payload — only the JWT
 * itself). We leave `cachedExpiresAtMs` null and let the silent-refresh
 * on 401 path replace it with a fresh mint that carries a known expiry.
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
  cachedExpiresAtMs = null;
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

/** Drop the cached token + tear down the proactive timer. Used by tests
 *  and the silent-refresh helpers below; production has no sign-out yet. */
export function clearToken(): void {
  cachedToken = null;
  cachedExpiresAtMs = null;
  activeVaultName = null;
  cancelRefreshTimer();
}

/** Test seam: replace the cached token directly. */
export function _setTokenForTest(token: string | null): void {
  cachedToken = token;
  cachedExpiresAtMs = null;
}

/** Test seam: cancel any pending proactive timer. Tests using fake timers
 *  call this in `afterEach` so a timer scheduled by one test doesn't leak
 *  into the next. */
export function _cancelRefreshTimerForTest(): void {
  cancelRefreshTimer();
}

/** Test seam: read the current expiry (ms since epoch) for assertion. */
export function _getExpiresAtMsForTest(): number | null {
  return cachedExpiresAtMs;
}

// ---------------------------------------------------------------------------
// Silent refresh
// ---------------------------------------------------------------------------

/**
 * Result of an attempted silent refresh. Callers branch on the `kind` to
 * decide whether to render the auth-required banner (`auth-required`),
 * show a transient retry button (`network-error`), or proceed with the
 * fresh token (`ok`).
 */
export type RefreshResult =
  | { kind: "ok"; token: string }
  | { kind: "auth-required"; status: number }
  | { kind: "network-error"; message: string };

interface MintResponseBody {
  token?: string;
  /** ISO timestamp — the hub returns absolute, not relative. */
  expires_at?: string;
  scopes?: string[];
}

/**
 * Call hub's session-cookie-gated mint endpoint. Returns the parsed result
 * shape so callers can decide what to render. On success, caches the token
 * + expiry and (re)arms the proactive refresh timer.
 *
 * Same-origin fetch carries the `parachute_hub_session` cookie because the
 * hub proxies `/vault/<name>/*` to the vault backend, so the SPA's origin
 * is the hub origin (vault#252 per-vault mount). No CORS preflight, no
 * Authorization header needed — the cookie IS the auth.
 */
async function mintFromHubSession(vaultName: string): Promise<RefreshResult> {
  if (typeof window === "undefined") {
    return { kind: "network-error", message: "no window" };
  }
  let res: Response;
  try {
    res = await fetch(`/admin/vault-admin-token/${encodeURIComponent(vaultName)}`, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "network-error", message };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { kind: "auth-required", status: res.status };
  }
  if (!res.ok) {
    // 5xx or other unexpected — hub is reachable but failing. Treat as a
    // transient network condition; the caller surfaces a retry button
    // rather than the "sign in" banner.
    return { kind: "network-error", message: `hub returned ${res.status}` };
  }
  let body: MintResponseBody;
  try {
    body = (await res.json()) as MintResponseBody;
  } catch (err) {
    return {
      kind: "network-error",
      message: err instanceof Error ? err.message : "could not parse mint response",
    };
  }
  if (typeof body.token !== "string" || body.token.length === 0) {
    return { kind: "network-error", message: "mint response missing token" };
  }
  cachedToken = body.token;
  cachedExpiresAtMs = body.expires_at ? parseExpiresAt(body.expires_at) : null;
  activeVaultName = vaultName;
  scheduleProactiveRefresh();
  installVisibilityListenerOnce();
  return { kind: "ok", token: body.token };
}

/** Parse the ISO timestamp from the hub's mint response into ms since
 *  epoch. Returns `null` for invalid input — callers treat that the same
 *  as a missing field (no proactive timer, rely on 401-retry). */
function parseExpiresAt(iso: string): number | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return ms;
}

/**
 * Ensure the SPA has a usable token, refreshing silently if needed.
 *
 * - If a token is cached and not within the proactive-refresh window
 *   (defined as: known-expiry past, or no expiry known but token exists),
 *   return it as-is.
 * - Otherwise hit the hub mint endpoint. Successful mint → return the new
 *   token; otherwise return the failure result for the caller to render.
 *
 * Callers: bootstrap (main.tsx), the API fetch wrapper on 401 retry, and
 * the banner's poll loop. Each surface treats the result kinds the same:
 * `ok` proceeds, `auth-required` surfaces the sign-in banner,
 * `network-error` surfaces a retry button.
 */
export async function ensureToken(vaultName: string): Promise<RefreshResult> {
  // If we already have a token AND we don't believe it's expired, hand it
  // back without a network call. (When `cachedExpiresAtMs` is null we trust
  // the token until a 401 says otherwise — the fragment-bootstrap path
  // doesn't carry an expiry hint.)
  if (cachedToken) {
    if (cachedExpiresAtMs === null || cachedExpiresAtMs > Date.now()) {
      // Side-effect: a fragment-only token still benefits from the
      // proactive timer once we learn its expiry — but only on the first
      // mint, which is what `mintFromHubSession` arms. Don't arm here.
      return { kind: "ok", token: cachedToken };
    }
    // Cached token is past its expiry. Drop it and re-mint below.
    cachedToken = null;
    cachedExpiresAtMs = null;
    cancelRefreshTimer();
  }
  return mintFromHubSession(vaultName);
}

/**
 * Fallback bootstrap path: when the SPA loads at `/vault/<name>/admin/`
 * without a `#token=...` fragment (page refresh after the fragment got
 * scrubbed; or operator clicked the vault tile on hub's discovery page),
 * attempt to mint a token from the hub-issued session cookie.
 *
 * Kept as a thin wrapper around `ensureToken` for back-compat with
 * `main.tsx`'s bootstrap callsite. Doesn't surface failure modes — the
 * SPA's route components run `ensureToken` themselves and render the
 * banner accordingly.
 */
export async function tryMintTokenFromHubSession(vaultName: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (cachedToken) return;
  // Swallow the result — `ensureToken` already cached the token on success
  // and the SPA's auth-required empty state handles the failure path. We
  // don't want a bootstrap-time network error to throw.
  await mintFromHubSession(vaultName).catch(() => {
    /* silent — handled downstream */
  });
}

// ---------------------------------------------------------------------------
// Proactive refresh
// ---------------------------------------------------------------------------

/**
 * Schedule the next proactive refresh based on the cached expiry. Cancels
 * any existing timer first so we never have two pending. No-op when:
 *   - no expiry is known (fragment-only token; we'll refresh on 401),
 *   - the tab is hidden (we install a visibility listener that re-arms on
 *     `visibilitychange`),
 *   - the active vault name isn't set (defensive — shouldn't happen post-mint).
 *
 * The fire-time is `expires_at - now` * REFRESH_FRACTION. For a 10-minute
 * token that's 8 minutes; the remaining 2 minutes are slack if the
 * refresh fails (we retry once after 30s, then give up and let the next
 * 401 trigger an interactive recovery).
 */
function scheduleProactiveRefresh(): void {
  cancelRefreshTimer();
  if (cachedExpiresAtMs === null || activeVaultName === null) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    // Don't fire timers while hidden — saves the API call and the
    // visibility listener will re-arm us on the next `visible` event.
    return;
  }
  const now = Date.now();
  const lifetimeRemaining = cachedExpiresAtMs - now;
  if (lifetimeRemaining <= 0) {
    // Already expired — let the next ensureToken / 401-retry handle it.
    return;
  }
  const delay = Math.max(Math.floor(lifetimeRemaining * REFRESH_FRACTION), MIN_REFRESH_DELAY_MS);
  refreshTimer = setTimeout(() => {
    void runProactiveRefresh();
  }, delay);
}

/** Cancel + null out the proactive refresh timer. */
function cancelRefreshTimer(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Fire a proactive refresh. Called by the timer. On success → cached
 * token replaced + next timer armed. On failure → log + try once more
 * after a short delay; if that fails too, do nothing (the existing
 * token is still valid for ~20% of its TTL, and the next 401 from an
 * API call will trigger an interactive recovery).
 */
async function runProactiveRefresh(): Promise<void> {
  refreshTimer = null;
  if (activeVaultName === null) return;
  const result = await mintFromHubSession(activeVaultName);
  if (result.kind === "ok") return;
  // First-attempt failure → one retry after PROACTIVE_RETRY_DELAY_MS.
  // We don't surface the banner here — the existing token is still
  // valid, and an interactive 401 from a real API call will trigger
  // the user-visible recovery path.
  if (typeof console !== "undefined") {
    console.warn("[vault-admin-spa] proactive token refresh failed; will retry once", result);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (activeVaultName === null) return;
    void mintFromHubSession(activeVaultName).catch(() => {
      /* terminal — give up and let the next 401 recover */
    });
  }, PROACTIVE_RETRY_DELAY_MS);
}

/**
 * Wire `document.visibilitychange` so the proactive timer pauses while
 * the tab is hidden and resumes when it becomes visible again. Idempotent
 * — installed once on the first successful mint, never removed (a future
 * sign-out path could detach it, but there isn't one today).
 *
 * Why we care: a 10-minute mint refreshes every 8 minutes. An operator
 * who alt-tabs away for an hour would otherwise fire ~7 unnecessary
 * mint calls against the hub. Pause + re-arm gives us a single mint on
 * return instead.
 */
function installVisibilityListenerOnce(): void {
  if (visibilityListenerInstalled) return;
  if (typeof document === "undefined") return;
  visibilityListenerInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      cancelRefreshTimer();
      return;
    }
    // Tab just became visible. If we have an active vault + a cached
    // token + expiry, re-arm the timer based on remaining lifetime. If
    // the token's already expired (operator was away longer than the
    // TTL), fire a refresh immediately so the next interaction has a
    // usable token in hand.
    if (activeVaultName === null) return;
    if (cachedExpiresAtMs !== null && cachedExpiresAtMs <= Date.now()) {
      void mintFromHubSession(activeVaultName).catch(() => {
        /* silent — interactive 401-retry covers the failure path */
      });
      return;
    }
    scheduleProactiveRefresh();
  });
}

/** Test seam: simulate a freshly-installed visibility listener fresh. */
export function _resetVisibilityListenerForTest(): void {
  visibilityListenerInstalled = false;
}
