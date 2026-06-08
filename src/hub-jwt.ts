/**
 * Hub-issued JWT validation. Vault as resource server: trusts tokens that the
 * hub signs against keys we fetch from the hub's `/.well-known/jwks.json`.
 *
 * The trust kernel — JWKS fetch + verify, issuer pin, audience strict-check,
 * RFC 7519 string-or-array `aud` handling — lives in the shared
 * `@openparachute/scope-guard` library so vault, scribe, and paraclaw can't
 * silently drift on the worst place to drift. This file is the vault-side
 * adapter: hub-origin resolution (env-var precedence + loopback fallback),
 * a process-wide guard instance, and re-exports preserving the public
 * surface every existing call site already imports.
 *
 * Vault#169 / hub-as-issuer Phase B2; vault#TBD / scope-guard adoption.
 */
import {
  createScopeGuard,
  HubJwtError,
  type HubJwtClaims,
  looksLikeJwt,
  type ValidateHubJwtOptions,
} from "@openparachute/scope-guard";

const DEFAULT_HUB_LOOPBACK = "http://127.0.0.1:1939";

/**
 * Resolve the hub origin used to validate the token's `iss` claim. Strips a
 * trailing slash so we get a single canonical form.
 *
 * Order: env var → loopback fallback. We deliberately don't read
 * `~/.parachute/services.json` — the hub is the dispatcher, not a registered
 * service in that file. If a deployment exposes the hub on a non-default
 * origin, the env var is the contract.
 *
 * `parachute expose` pins `PARACHUTE_HUB_ORIGIN` to the PUBLIC FQDN so the
 * `iss` we validate against matches what the hub stamps on the tokens it
 * mints — keep using this origin for iss-validation. The JWKS *fetch* origin
 * is resolved separately by `getJwksOrigin()`; see vault#464.
 */
export function getHubOrigin(): string {
  const env = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (env && env.length > 0) return env;
  return DEFAULT_HUB_LOOPBACK;
}

/**
 * Resolve the origin used to FETCH the hub's JWKS — kept distinct from
 * `getHubOrigin()` (the iss-validation origin) per vault#464.
 *
 * Vault is co-located with its hub (the hub supervises vault on the same box,
 * the common deploy). After `parachute expose --cloudflare`, `getHubOrigin()`
 * is the public Cloudflare FQDN. If we fetched JWKS from that public origin we
 * would hairpin out through the tunnel and back to the same box — a round-trip
 * that times out (hard fail under Docker NAT-loopback, slow/flaky on a real
 * VPS) and 401s the first MCP connect after expose. So we always read keys
 * from the LOCAL hub on loopback instead.
 *
 * Order: `PARACHUTE_HUB_JWKS_ORIGIN` override → loopback default. The override
 * exists for the rare non-co-located case — a vault running on a DIFFERENT box
 * than its hub sets `PARACHUTE_HUB_JWKS_ORIGIN` to the hub's reachable
 * internal address. Trailing-slash-stripped, matching `getHubOrigin()`.
 */
export function getJwksOrigin(): string {
  const env = process.env.PARACHUTE_HUB_JWKS_ORIGIN?.replace(/\/$/, "");
  if (env && env.length > 0) return env;
  return DEFAULT_HUB_LOOPBACK;
}

// Process-wide guard. The resolver form lets tests flip
// `PARACHUTE_HUB_ORIGIN` / `PARACHUTE_HUB_JWKS_ORIGIN` between cases — the lib
// re-resolves on every `validateHubJwt` and `resetJwksCache` call so the
// env-var change picks up without a server restart. JWKS cache (5min/30s
// defaults) lives inside the guard, shared across requests.
//
// The iss/jwks split (vault#464): `hubOrigin` validates the token's `iss`
// (public FQDN post-expose, via PARACHUTE_HUB_ORIGIN); `jwksOrigin` fetches
// the keys from the local hub (loopback by default, via
// PARACHUTE_HUB_JWKS_ORIGIN). Co-located vault never egresses to read its own
// hub's keys, so no tunnel hairpin.
const guard = createScopeGuard({
  hubOrigin: () => getHubOrigin(),
  jwksOrigin: () => getJwksOrigin(),
});

/**
 * Verify a presented JWT against the hub's JWKS. Throws `HubJwtError` on any
 * failure (bad signature, wrong issuer, expired, missing kid, JWKS
 * unreachable, audience mismatch). On success returns the surfaced claims
 * plus the parsed scope list.
 *
 * Trust model:
 *   - `iss` MUST equal the configured hub origin. Without this, anyone could
 *     mint a token against any RSA key and pass verification.
 *   - `aud` is strict-checked against `opts.expectedAudience` when provided
 *     — the resource-server backstop for per-vault binding.
 *
 * Scope-shape policy (e.g. "hub-issued tokens may not carry broad
 * `vault:<verb>` scopes") is enforced one layer up in `authenticateHubJwt`,
 * not here — this function stays focused on JWT-level concerns.
 *
 * The returned `HubJwtClaims` carries the native `permissions` claim
 * (scope-guard ≥0.4.0-rc.2 parses + surfaces it; `undefined` when absent or
 * not a JSON object). Tag-scope enforcement reads `permissions.scoped_tags`
 * in `authenticateHubJwt` — see auth-unification arc C0.
 *
 * jti policy: scope-guard's `createScopeGuard` defaults `allowMissingJti:
 * false` (per hub#218 / scope-guard #322), so a hub JWT lacking a `jti`
 * claim is rejected here. Vault doesn't opt out — every hub mint stamps a
 * jti, and revocation can't be enforced on tokens we can't index.
 */
export async function validateHubJwt(
  token: string,
  opts: ValidateHubJwtOptions = {},
): Promise<HubJwtClaims> {
  return guard.validateHubJwt(token, opts);
}

/**
 * Reset the cached JWKS getter. Tests use this to switch origins between
 * cases; production callers shouldn't need it (origin is process-stable).
 */
export function resetJwksCache(): void {
  guard.resetJwksCache();
}

/**
 * Reset the cached revocation list. Tests use this to start from a clean
 * fail-closed state between cases; production callers shouldn't need it
 * (the cache refreshes itself on TTL expiry).
 */
export function resetRevocationCache(): void {
  guard.resetRevocationCache();
}

export { HubJwtError, looksLikeJwt };
export type { HubJwtClaims, ValidateHubJwtOptions };
