/**
 * Hub-issued JWT validation. Vault as resource server: trusts tokens that the
 * hub signs against keys we fetch from the hub's `/.well-known/jwks.json`.
 *
 * Two halves:
 *   - Origin resolution. The hub's URL comes from `PARACHUTE_HUB_ORIGIN` (set
 *     by the hub's `expose` / `start` flow when vault runs behind it). Falls
 *     back to `http://127.0.0.1:1939` for loopback dev. We only resolve once
 *     per process — a server restart picks up an env change.
 *   - JWKS fetch + verify. `jose.createRemoteJWKSet` does the fetching, kid
 *     lookup, and rotation handling. Tokens MUST have `iss = <hub origin>` —
 *     the load-bearing trust check; without it, anyone could forge tokens
 *     against any RSA key. `aud` is strict-checked against
 *     `opts.expectedAudience` when provided (per-vault binding); RFC 7519
 *     `aud` may be a string or string[], and either shape is supported.
 *
 * Vault#169 / hub-as-issuer Phase B2.
 */
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from "jose";
import { parseScopes } from "./scopes.ts";

const DEFAULT_HUB_LOOPBACK = "http://127.0.0.1:1939";

/**
 * Resolve the hub origin used to fetch JWKS and validate `iss`. Strips a
 * trailing slash so we get a single canonical form.
 *
 * Order: env var → loopback fallback. We deliberately don't read
 * `~/.parachute/services.json` — the hub is the dispatcher, not a registered
 * service in that file. If a deployment exposes the hub on a non-default
 * origin, the env var is the contract.
 */
export function getHubOrigin(): string {
  const env = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (env && env.length > 0) return env;
  return DEFAULT_HUB_LOOPBACK;
}

/**
 * A presented bearer token is JWT-shaped iff it begins with `eyJ` — the
 * base64url encoding of `{"` from a `{"alg":...}` JSON header. Cheap
 * pre-check so we don't try to verify `pvt_` tokens as JWTs.
 */
export function looksLikeJwt(token: string): boolean {
  return token.startsWith("eyJ");
}

/** Subset of claims we surface to callers. Everything else is dropped. */
export interface HubJwtClaims {
  sub: string;
  /** Parsed `scope` claim (whitespace-separated → array, normalized). */
  scopes: string[];
  /** Audience — operator | client_id | module-name. Surfaced for logging. */
  aud: string | undefined;
  /** Token id. Surfaced for logging / future revocation lookups. */
  jti: string | undefined;
  /** Client id from the `client_id` claim, if present. */
  clientId: string | undefined;
}

export class HubJwtError extends Error {
  override name = "HubJwtError";
}

// jose's createRemoteJWKSet returns a getter that internally caches keys with
// a configurable TTL. One getter per origin — recreated only on origin change
// (rare; survives across requests). Module-scoped so retries / kid lookups
// reuse the same in-flight fetches.
type JwksGetter = ReturnType<typeof createRemoteJWKSet>;
let cachedGetter: JwksGetter | null = null;
let cachedOrigin: string | null = null;

function getJwksGetter(origin: string): JwksGetter {
  if (cachedGetter && cachedOrigin === origin) return cachedGetter;
  cachedGetter = createRemoteJWKSet(new URL(`${origin}/.well-known/jwks.json`), {
    // 5min cache — keys rarely rotate but DO rotate. Matches hub's signing-key
    // overlap window expectation.
    cacheMaxAge: 5 * 60 * 1000,
    // 30s cooldown between failed fetches. Prevents thundering-herd if the
    // hub is briefly down: we serve cached keys when possible, and the
    // cooldown bounds the retry rate.
    cooldownDuration: 30 * 1000,
  });
  cachedOrigin = origin;
  return cachedGetter;
}

/**
 * Reset the cached JWKS getter. Tests use this to switch origins between
 * cases; production callers shouldn't need it (origin is process-stable).
 */
export function resetJwksCache(): void {
  cachedGetter = null;
  cachedOrigin = null;
}

export interface ValidateHubJwtOptions {
  /**
   * If set, strict-check the JWT `aud` claim against this exact value. Used
   * by the per-vault auth path: each request derives the expected audience
   * from the URL (`vault.<name>`) and rejects tokens stamped for a different
   * vault. Pass `null` (or omit) to skip — only callers that lack a single
   * resource binding (e.g. cross-vault routes) should skip.
   *
   * The `aud` strict-check is the resource-server backstop. Even if scope
   * narrowing slips somewhere upstream, `aud=vault.work` cannot reach
   * `/vault/personal/*` because the audience-mismatch reject fires first.
   */
  expectedAudience?: string | null;
}

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
 */
export async function validateHubJwt(
  token: string,
  opts: ValidateHubJwtOptions = {},
): Promise<HubJwtClaims> {
  const origin = getHubOrigin();
  const getter = getJwksGetter(origin);

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, getter, {
      issuer: origin,
      // We strict-check audience ourselves below when `expectedAudience` is
      // provided. Letting jose do it would also work, but keeping the check
      // local lets us shape a clearer error message and centralize the
      // "vault.<name>" derivation rule in one place.
    });
    payload = verified.payload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HubJwtError(`hub JWT verification failed: ${msg}`);
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new HubJwtError("hub JWT missing required `sub` claim");
  }

  // RFC 7519 §4.1.3: `aud` may be a string OR an array of strings. We unify
  // into an array internally and check membership; surfacing back to callers
  // collapses to a single representative value (the matched one when an
  // expectation was supplied, else the first array element).
  const audRaw = payload.aud;
  const auds: string[] =
    typeof audRaw === "string"
      ? [audRaw]
      : Array.isArray(audRaw)
        ? audRaw.filter((a): a is string => typeof a === "string")
        : [];

  if (opts.expectedAudience != null) {
    if (!auds.includes(opts.expectedAudience)) {
      const got = auds.length === 0 ? "(missing)" : auds.join(", ");
      throw new HubJwtError(
        `hub JWT audience mismatch: expected "${opts.expectedAudience}", got "${got}"`,
      );
    }
  }
  const aud: string | undefined =
    opts.expectedAudience != null ? opts.expectedAudience : auds[0];

  const scopeRaw = (payload as { scope?: unknown }).scope;
  const scopes =
    typeof scopeRaw === "string" ? parseScopes(scopeRaw) : [];

  const jti = typeof payload.jti === "string" ? payload.jti : undefined;
  const clientIdRaw = (payload as { client_id?: unknown }).client_id;
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw : undefined;

  return { sub: payload.sub, scopes, aud, jti, clientId };
}
