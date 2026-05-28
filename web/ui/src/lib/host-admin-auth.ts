/**
 * Host-admin auth helper for the vault admin SPA's tokens page.
 *
 * Background — the auth-unification arc. The tokens page used to mint
 * deprecated `pvt_*` vault-DB tokens via the per-vault REST surface
 * (`POST /vault/<name>/tokens`), authed with the vault-admin JWT that
 * `auth.ts:mintFromHubSession` caches. As of this step the page mints
 * **hub JWTs** instead, via hub's `/api/auth/*` registry endpoints
 * (`mint-token` / `tokens` / `revoke-token`).
 *
 * Those endpoints require a bearer carrying `parachute:host:auth` — the
 * LIST endpoint hard-requires it, which the vault-admin token
 * (`vault:<name>:admin`) doesn't hold. So this module mints a SEPARATE
 * **host-admin** bearer from hub's session-cookie-gated
 * `GET /admin/host-admin-token` and uses it uniformly for all three token
 * operations. We deliberately keep one bearer for the whole tokens-page
 * surface rather than splitting mint/revoke (vault-admin, would work via
 * attenuation) from list (host-admin, required) — a single auth model is
 * simpler to reason about.
 *
 * This is INTENTIONALLY a parallel cache to `auth.ts`'s vault-admin token.
 * Other SPA pages (vault detail, mirror config, the legacy-tokens list in
 * this same page) still depend on the vault-admin bearer via
 * `api.ts:authedFetch` / `_authedFetch`; we must not clobber it. The two
 * bearers coexist: vault-admin talks to `/vault/<name>/*`, host-admin
 * talks to hub's `/api/auth/*` + `/vaults` admin surface.
 *
 * Storage: module-scoped variable, NEVER `localStorage` / `sessionStorage`
 * — same posture as the vault-admin token. The host-admin JWT is even more
 * sensitive (it carries `parachute:host:admin` + `parachute:host:auth`), so
 * keeping it in memory with the narrowest XSS surface matters more here.
 *
 * The endpoint mints a 10-minute TTL token; we cache it + its absolute
 * expiry and rely on `hostAdminAuthedFetch`'s 401-retry to re-mint when it
 * lapses (the tokens page is interactive and short-lived enough that the
 * proactive-timer machinery `auth.ts` carries for the vault-admin token
 * isn't worth duplicating here).
 */
import { getIssuerOrigin } from "./scope.ts";

/** Cached host-admin JWT. `null` when none minted yet / cleared on 401. */
let cachedHostAdminToken: string | null = null;
/** Absolute expiry, ms since epoch. `null` when no token cached or the
 *  mint response carried no parseable `expires_at`. */
let cachedHostAdminExpiresAtMs: number | null = null;

/**
 * Result of an attempted host-admin token mint. Callers branch on `kind`:
 *   - `ok` — bearer in hand.
 *   - `auth-required` — 401 (no hub session) / 404. Render the sign-in
 *     banner; the operator needs to sign in at the hub.
 *   - `forbidden` — 403 `not_admin`. The signed-in account is a friend, not
 *     the hub admin. The caller redirects to the issuer's `/account/` home.
 *   - `network-error` — transient (5xx / fetch reject / parse failure).
 */
export type HostAdminResult =
  | { kind: "ok"; token: string }
  | { kind: "auth-required"; status: number }
  | { kind: "forbidden" }
  | { kind: "network-error"; message: string };

interface HostAdminMintBody {
  token?: string;
  /** ISO timestamp — hub returns absolute expiry. */
  expires_at?: string;
  scopes?: string[];
}

/** Parse an ISO timestamp to ms-since-epoch; `null` on invalid input. */
function parseExpiresAt(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Mint a fresh host-admin bearer from the hub session cookie.
 *
 * Same-origin GET against `/admin/host-admin-token` — the
 * `parachute_hub_session` cookie auto-attaches because the SPA is served
 * same-origin-as-hub through hub's `/vault/<name>/*` proxy (vault#252).
 * Mirrors `auth.ts:mintFromHubSession`'s shape, but:
 *   - no vault-name segment (host-admin tokens carry no per-vault pin);
 *   - 403 is surfaced as a distinct `forbidden` kind so the caller can do
 *     the friend-account → `/account/` redirect (the host-admin endpoint
 *     gates on first-admin identity, unlike the vault-admin endpoint).
 */
async function mintHostAdminToken(): Promise<HostAdminResult> {
  if (typeof window === "undefined") {
    return { kind: "network-error", message: "no window" };
  }
  let res: Response;
  try {
    res = await fetch("/admin/host-admin-token", {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
  } catch (err) {
    return { kind: "network-error", message: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 403) {
    // Friend account (signed in but not the hub admin). Distinct from
    // 401/404 — the operator can't unblock by signing in, they're the
    // wrong identity. Caller redirects to the issuer's account home.
    return { kind: "forbidden" };
  }
  if (res.status === 401 || res.status === 404) {
    return { kind: "auth-required", status: res.status };
  }
  if (!res.ok) {
    return { kind: "network-error", message: `hub returned ${res.status}` };
  }
  let body: HostAdminMintBody;
  try {
    body = (await res.json()) as HostAdminMintBody;
  } catch (err) {
    return {
      kind: "network-error",
      message: err instanceof Error ? err.message : "could not parse host-admin mint response",
    };
  }
  if (typeof body.token !== "string" || body.token.length === 0) {
    return { kind: "network-error", message: "host-admin mint response missing token" };
  }
  cachedHostAdminToken = body.token;
  cachedHostAdminExpiresAtMs = body.expires_at ? parseExpiresAt(body.expires_at) : null;
  return { kind: "ok", token: body.token };
}

/**
 * Ensure a usable host-admin bearer, minting silently if needed.
 *
 * Returns the cached token when one is in hand and not past its known
 * expiry; otherwise hits the mint endpoint. The token registry endpoints'
 * 401-retry (see `hostAdminAuthedFetch`) covers the case where the cached
 * token lapses between our clock check and the actual request.
 */
export async function ensureHostAdminToken(): Promise<HostAdminResult> {
  if (cachedHostAdminToken) {
    if (cachedHostAdminExpiresAtMs === null || cachedHostAdminExpiresAtMs > Date.now()) {
      return { kind: "ok", token: cachedHostAdminToken };
    }
    // Past expiry — drop + re-mint.
    cachedHostAdminToken = null;
    cachedHostAdminExpiresAtMs = null;
  }
  return mintHostAdminToken();
}

/** Drop the cached host-admin bearer. Used by the 401-retry path + tests. */
export function clearHostAdminToken(): void {
  cachedHostAdminToken = null;
  cachedHostAdminExpiresAtMs = null;
}

/** Test seam: read the current host-admin token directly. */
export function _getHostAdminTokenForTest(): string | null {
  return cachedHostAdminToken;
}

/** Test seam: read the cached expiry (ms since epoch) for assertion. */
export function _getHostAdminExpiresAtMsForTest(): number | null {
  return cachedHostAdminExpiresAtMs;
}

/**
 * Error carrying both an HTTP-ish status and a `kind` so the tokens-page
 * route can branch: `auth-required` → sign-in banner, `forbidden` →
 * `/account/` redirect, everything else → error banner.
 *
 * Mirrors `api.ts:HttpError` but adds the auth-disposition so the host-admin
 * surface's three failure modes survive the throw boundary.
 */
export class HostAdminError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly disposition: "auth-required" | "forbidden" | "network-error" | "http",
  ) {
    super(message);
    this.name = "HostAdminError";
  }
}

interface HostAdminFetchInit extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
}

/**
 * Bearer-authed fetch against hub's `/api/auth/*` surface using the
 * host-admin token, with a single silent-refresh retry on 401.
 *
 * Mirrors `api.ts:authedFetch` (the vault-admin equivalent) but threads
 * `ensureHostAdminToken` instead. On the first 401 we clear the cached
 * token (forcing a fresh mint rather than handing back a
 * stale-but-not-expired-by-our-clock token) and retry once. A failed
 * refresh throws `HostAdminError` with the right disposition so the route
 * renders the matching empty state.
 *
 * Returns the `Response` for the caller to inspect — body parsing lives at
 * the callsites (heterogenous shapes), same as `api.ts`.
 */
export async function hostAdminAuthedFetch(
  url: string,
  init: HostAdminFetchInit = {},
): Promise<Response> {
  let token: string;
  const ensured = await ensureHostAdminToken();
  if (ensured.kind !== "ok") {
    throw resultToError(ensured);
  }
  token = ensured.token;

  const { headers: extraHeaders, ...rest } = init;
  const buildHeaders = (bearer: string): Record<string, string> => ({
    accept: "application/json",
    ...(extraHeaders ?? {}),
    authorization: `Bearer ${bearer}`,
  });

  const res = await fetch(url, { ...rest, headers: buildHeaders(token) });
  if (res.status !== 401) return res;
  // 401 → one silent refresh + retry. Clear first so `ensureHostAdminToken`
  // is forced to hit the mint endpoint.
  clearHostAdminToken();
  const refreshed = await ensureHostAdminToken();
  if (refreshed.kind !== "ok") {
    throw resultToError(refreshed);
  }
  return fetch(url, { ...rest, headers: buildHeaders(refreshed.token) });
}

/** Map a non-ok mint result to a `HostAdminError` for the throw boundary. */
function resultToError(result: Exclude<HostAdminResult, { kind: "ok" }>): HostAdminError {
  if (result.kind === "forbidden") {
    return new HostAdminError(403, "host-admin token mint forbidden — not the hub admin", "forbidden");
  }
  if (result.kind === "auth-required") {
    return new HostAdminError(
      result.status,
      "no host-admin session — sign in to the hub to manage tokens",
      "auth-required",
    );
  }
  return new HostAdminError(0, result.message, "network-error");
}

/**
 * Redirect a friend account to the hub's `/account/` home. Called by the
 * tokens page when it catches a `forbidden` host-admin result — the
 * operator is signed in but isn't the hub admin, so token management isn't
 * theirs to reach. We send them to their account home on the issuer origin
 * (decoded from the vault-admin JWT's `iss` claim, which the SPA already
 * holds). Falls back to a relative `/account/` when no issuer is known.
 */
export function redirectToAccountHome(): void {
  if (typeof window === "undefined") return;
  const issuer = getIssuerOrigin();
  window.location.href = issuer ? `${issuer}/account/` : "/account/";
}
