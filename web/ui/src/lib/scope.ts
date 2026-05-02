/**
 * Client-side JWT scope inspection.
 *
 * **Not** a verifier — signature, issuer, audience, and expiry are checked
 * by the vault server (`src/auth.ts` → `src/hub-jwt.ts` → scope-guard). The
 * server is the trust boundary; this util only decides whether to *render*
 * the mutate UI (mint, revoke). A client that lies about its scopes still
 * has its requests rejected at the API.
 *
 * Why this matters: Phase A's only auth state was "have token / don't have
 * token". Phase B introduces tokens UI with mint + revoke, both of which
 * require `vault:<name>:admin`. A read-scoped JWT shouldn't see the buttons
 * — it should see a read-only list with a banner explaining what's needed.
 *
 * Inheritance follows the same `admin ⊇ write ⊇ read` rule scope-guard
 * encodes server-side; for *admin* checks the rule is trivial (only admin
 * grants admin), but the helper is named generically so a future call site
 * checking write/read works without a second util.
 */
import { getToken } from "./auth.ts";

/** Decode the payload of a JWT without verifying its signature. Returns
 * `null` on any malformed input. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const json = atob(padded + padding);
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Pull the scopes claim off a JWT. Accepts the OAuth-canonical
 * space-separated `scope` string; falls back to the array-shaped `scopes`
 * claim some legacy paths emit. Anything else → empty list. */
export function scopesFromJwt(token: string | null): string[] {
  if (!token) return [];
  const claims = decodeJwtPayload(token);
  if (!claims) return [];
  const scope = claims["scope"];
  if (typeof scope === "string" && scope.length > 0) {
    return scope.split(/\s+/).filter((s) => s.length > 0);
  }
  const scopes = claims["scopes"];
  if (Array.isArray(scopes)) {
    return scopes.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  return [];
}

/** True iff the cached token grants admin on the named vault. Hub-issued
 * tokens use the narrowed `vault:<name>:admin` shape per
 * scope-narrowing-and-audience. Broad `vault:admin` is rejected by the
 * server's hub-JWT gate and we mirror that here so the UI gate matches. */
export function hasAdminScope(vaultName: string): boolean {
  const scopes = scopesFromJwt(getToken());
  return scopes.includes(`vault:${vaultName}:admin`);
}

/**
 * Hub origin where the cached JWT was issued. Pulled from the `iss` claim
 * (RFC 7519 §4.1.1) — the hub sets it via `setIssuer()` during token mint
 * and pins the value to its own origin (see parachute-hub/src/jwt-sign.ts).
 *
 * Used to construct cross-origin links from the vault SPA back to hub
 * surfaces (e.g. the permissions UI at `/hub/permissions`). Pulling from
 * the token avoids needing a separate runtime-config endpoint or hub
 * coordination — the data's already in hand.
 *
 * Returns `null` when no token is cached, the token is malformed, or the
 * `iss` claim isn't a string. Callers fall back to "managed on hub" copy
 * without a link in that case.
 */
export function getIssuerOrigin(): string | null {
  const token = getToken();
  if (!token) return null;
  const claims = decodeJwtPayload(token);
  if (!claims) return null;
  const iss = claims["iss"];
  if (typeof iss !== "string" || iss.length === 0) return null;
  return iss.replace(/\/$/, "");
}
