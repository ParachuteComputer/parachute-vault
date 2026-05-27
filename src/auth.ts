/**
 * Authentication and authorization for the vault server.
 *
 * Token-based auth with two permission levels:
 *   - "full" — unrestricted access (CRUD + delete + token management)
 *   - "read" — read-only (query, list, find-path, vault-info)
 *
 * Tokens live in each vault's SQLite database (tokens table, schema v7).
 *
 * Backward compatibility: config.yaml API keys are still checked as a fallback.
 * Those keys resolve as full-access tokens. Legacy "admin" and "write" values
 * in the DB are normalized to "full" at read time.
 *
 * The unified /mcp endpoint uses only legacy global config.yaml keys, since
 * tokens are per-vault and the unified endpoint spans all vaults.
 */

import { readGlobalConfig, writeVaultConfig, writeGlobalConfig, verifyKey, listVaults, readVaultConfig } from "./config.ts";
import type { VaultConfig, StoredKey } from "./config.ts";
import { resolveToken } from "./token-store.ts";
import type { TokenPermission } from "./token-store.ts";
import type { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getVaultStore } from "./vault-store.ts";
import {
  findBroadVaultScopes,
  hasScope,
  hasScopeForVault,
  legacyPermissionToScopes,
  SCOPE_ADMIN,
  SCOPE_READ,
  SCOPE_WRITE,
} from "./scopes.ts";
import { enforceVaultScope } from "@openparachute/scope-guard";
import { HubJwtError, looksLikeJwt, validateHubJwt } from "./hub-jwt.ts";

/**
 * Server-wide operator bearer token, sourced from the `VAULT_AUTH_TOKEN`
 * environment variable.
 *
 * Read dynamically per request (not cached at import time) so test seams
 * that mutate `process.env.VAULT_AUTH_TOKEN` work without re-importing.
 * In production the env var is set at container start and doesn't change.
 *
 * Empty / whitespace-only values are treated as unset — the operator
 * either commits to bearer auth or doesn't, no degraded "empty token
 * always matches" failure mode.
 */
function getServerWideAuthToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.VAULT_AUTH_TOKEN;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Constant-time string equality. Returns false when lengths differ
 * (timingSafeEqual throws on length mismatch; we want a quiet false).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * If `VAULT_AUTH_TOKEN` is set and the provided bearer matches it
 * (constant-time), return a full-admin AuthResult that's accepted by
 * every vault on the server.
 *
 * The operator-channel auth shape for non-loopback deploys (Render,
 * sibling-container setups, vault#339). Hub uses this to call vault
 * across a container boundary; end-user OAuth tokens still take the
 * per-vault hub-JWT / pvt_* paths below. See `docs/auth-model.md` §2.
 *
 * Scope set is broad (`vault:admin`) — the env-var bearer is an
 * operator credential, not a user credential. Tag-scoping doesn't
 * apply; we represent it as unscoped (`scoped_tags: null`).
 */
function tryServerWideAuth(
  providedKey: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthResult | null {
  const configured = getServerWideAuthToken(env);
  if (configured === null) return null;
  if (!constantTimeEquals(providedKey, configured)) return null;
  return {
    permission: "full",
    scopes: [SCOPE_ADMIN, SCOPE_WRITE, SCOPE_READ],
    legacyDerived: false,
    scoped_tags: null,
    vault_name: null,
    // No stable session id for the env-var operator token — every request
    // is the operator-bearer, not a minted session. manage-token's session
    // pin is a no-op for this caller (it'd still mint, but list/revoke
    // would see no other operator mints; that's fine — env-var-bearer is
    // explicitly the operator-channel, not a user surface).
    caller_jti: null,
  };
}

/** Result of a successful auth check. */
export interface AuthResult {
  permission: TokenPermission;
  /** OAuth-standard scopes granted to this token. */
  scopes: string[];
  /**
   * True iff scopes were derived from a legacy permission value (no `vault:*`
   * scopes stored on the token row or legacy YAML key). Callers should log a
   * one-time deprecation warning when they encounter `legacyDerived: true`.
   */
  legacyDerived: boolean;
  /**
   * Tag-allowlist (root tag names) for tag-scoped tokens. NULL = unscoped
   * (current full-vault behavior). Hub-issued JWTs and legacy YAML keys
   * always have null — tag scoping is a per-token vault-DB attribute, not
   * an OAuth-claim concern. See patterns/tag-scoped-tokens.md.
   */
  scoped_tags: string[] | null;
  /**
   * Per-vault binding (v16). Non-null = token can only authenticate against
   * this vault. authenticateVaultRequest enforces the match before this
   * result returns; callers downstream can read it for additional scoping
   * (e.g. cross-vault filtering at the unified /mcp endpoint). NULL =
   * legacy / server-wide / hub JWT — no per-vault binding. See vault#257.
   */
  vault_name: string | null;
  /**
   * Session identifier (v19). For `pvt_*` tokens this is the display id
   * (`t_<hashprefix>`) of the presented token. For hub JWTs it's the
   * `jti` claim, when present. NULL for legacy YAML keys / server-wide
   * env-var tokens / hub JWTs without a `jti`. Used by the manage-token
   * MCP tool to stamp child tokens with `parent_jti` so list/revoke can
   * scope to this session's mints. See vault#376.
   */
  caller_jti: string | null;
}

/**
 * Convert a legacy "read" | "full" permission into scopes + the legacyDerived
 * flag. Used for legacy YAML key authentication paths and for tokens whose
 * `scopes` column is still NULL.
 */
function legacyAuthResult(permission: TokenPermission): AuthResult {
  return {
    permission,
    scopes: legacyPermissionToScopes(permission),
    legacyDerived: true,
    scoped_tags: null,
    vault_name: null,
    caller_jti: null,
  };
}

// One-shot deprecation warning tracker, keyed by token hash / legacy label so
// we don't spam the log on every request.
const warnedLegacyTokens = new Set<string>();

/**
 * Log a one-time deprecation warning for legacy-derived auth results.
 * Safe to call on every request — dedupes internally by cache key.
 */
export function warnLegacyOnce(cacheKey: string, context: string): void {
  if (warnedLegacyTokens.has(cacheKey)) return;
  warnedLegacyTokens.add(cacheKey);
  console.warn(
    `[scopes] legacy permission-based auth used (${context}); migrate to vault:read / vault:write / vault:admin scopes. This compat shim will be removed after the next release.`,
  );
}

/** Read-only tools (the only tools allowed for "read" permission). */
const READ_TOOLS = new Set([
  "query-notes",
  "list-tags",
  "find-path",
  "vault-info",
]);

/** Check if a tool call is allowed for a given permission level. */
export function isToolAllowed(toolName: string, permission: TokenPermission): boolean {
  if (permission === "full") return true;
  return READ_TOOLS.has(toolName);
}

/** Read-only HTTP methods. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Check if an HTTP method is allowed for a given permission level. */
export function isMethodAllowed(method: string, permission: TokenPermission): boolean {
  if (permission === "full") return true;
  return READ_METHODS.has(method);
}

/**
 * Extract API key/token from request.
 * Priority: Authorization header → X-API-Key header → ?key= query param.
 */
export function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return xApiKey;
  // Query param fallback — enables URL-only auth for MCP clients (e.g. Claude Web)
  const url = new URL(req.url);
  return url.searchParams.get("key");
}

/**
 * Validate a key against a list of stored keys (legacy YAML-based auth).
 * Returns the matched key or null.
 */
function validateKey(keys: StoredKey[], providedKey: string): StoredKey | null {
  for (const stored of keys) {
    if (verifyKey(providedKey, stored.key_hash)) {
      stored.last_used_at = new Date().toISOString();
      return stored;
    }
  }
  return null;
}

/**
 * Authenticate for a specific vault.
 *
 * Token shape decides the path:
 *   - JWT-shaped (`eyJ…`) → validate against the hub's JWKS. JWT-shaped tokens
 *     commit to JWT validation; we don't fall through to `pvt_*` lookup on
 *     failure, since a malformed JWT was never going to be a valid local
 *     token anyway.
 *   - Anything else → try the vault's token DB, then legacy YAML keys.
 *
 * Dual-validate window: both paths are live during this release cycle so
 * existing `pvt_*` callers continue to work. A follow-up issue retires the
 * legacy path.
 */
export async function authenticateVaultRequest(
  req: Request,
  vaultConfig: VaultConfig,
  vaultDb?: Database,
): Promise<{ error: Response } | AuthResult> {
  const key = extractApiKey(req);
  if (!key) {
    return { error: Response.json({ error: "Unauthorized", message: "API key required" }, { status: 401 }) };
  }

  // Server-wide operator token (vault#339). When VAULT_AUTH_TOKEN is set,
  // a matching bearer authenticates as full/admin against any vault. This
  // is the cross-container path for Render / sibling-service deployments
  // where hub talks to vault over HTTP. Checked first so it short-circuits
  // both JWT validation and per-vault DB lookups — the operator token is
  // a credential the operator opts into, not one we'd ever fall through.
  const serverWide = tryServerWideAuth(key);
  if (serverWide !== null) return serverWide;

  // JWT path: hub-issued tokens. Trust pinned to the hub origin via `iss`
  // verification inside validateHubJwt; signature checked against hub's JWKS.
  // Audience strict-checked against `vault.<name>` so a token stamped for
  // one vault can't reach another. `vault_scope` claim additionally checked
  // against `vaultConfig.name` so a per-user vault pin refuses cross-vault
  // access even if a scope-string somehow named the wrong vault (multi-user
  // Phase 1 defense-in-depth — see hub#283 + scope-guard 0.3.0).
  if (looksLikeJwt(key)) {
    return await authenticateHubJwt(key, {
      expectedAudience: `vault.${vaultConfig.name}`,
      vaultName: vaultConfig.name,
    });
  }

  // Try vault's token DB first
  if (vaultDb) {
    try {
      const resolved = resolveToken(vaultDb, key);
      if (resolved) {
        // Per-vault binding (v16): tokens minted via /vault/<name>/tokens
        // carry vault_name = <name>. Reject if presented at a different
        // vault. NULL = legacy / server-wide; accept anywhere. The DB
        // lookup itself already filters by per-vault DB scoping (resolve
        // only succeeds if the token row lives in this vault's DB), so
        // a mismatch here would only happen if a token row was copied
        // across vault DBs out-of-band — defense-in-depth.
        if (resolved.vault_name !== null && resolved.vault_name !== vaultConfig.name) {
          return {
            error: Response.json(
              {
                error: "Unauthorized",
                message: `token is bound to vault '${resolved.vault_name}'; cannot be used against vault '${vaultConfig.name}'`,
              },
              { status: 403 },
            ),
          };
        }
        if (resolved.legacyDerived) {
          warnLegacyOnce(`vault-token:${vaultConfig.name ?? ""}`, "vault token without scopes column");
        }
        return {
          permission: resolved.permission,
          scopes: resolved.scopes,
          legacyDerived: resolved.legacyDerived,
          scoped_tags: resolved.scoped_tags,
          vault_name: resolved.vault_name,
          caller_jti: resolved.jti,
        };
      }
    } catch {
      // Token table might not exist yet — fall through to legacy auth
    }
  }

  // Legacy: check per-vault keys from vault.yaml
  const vaultKey = validateKey(vaultConfig.api_keys, key);
  if (vaultKey) {
    try { writeVaultConfig(vaultConfig); } catch {}
    warnLegacyOnce(`yaml-vault:${vaultKey.key_hash}`, "vault.yaml api_keys");
    return legacyAuthResult(vaultKey.scope === "read" ? "read" : "full");
  }

  // Legacy: check global keys from config.yaml
  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys) {
    const globalKey = validateKey(globalConfig.api_keys, key);
    if (globalKey) {
      try { writeGlobalConfig(globalConfig); } catch {}
      warnLegacyOnce(`yaml-global:${globalKey.key_hash}`, "config.yaml api_keys");
      return legacyAuthResult(globalKey.scope === "read" ? "read" : "full");
    }
  }

  return { error: Response.json({ error: "Unauthorized", message: "Invalid API key" }, { status: 401 }) };
}

/**
 * Validate a JWT-shaped bearer and convert the result into an `AuthResult`.
 * The token's scope claim becomes the granted scopes; permission is derived
 * for back-compat with code paths that still branch on `permission` (MCP
 * tool gating, view auth). `legacyDerived` is `false` — JWT-issued scopes
 * are explicit, never inferred.
 *
 * Scope-shape policy: hub-issued tokens MUST carry resource-narrowed
 * `vault:<name>:<verb>` scopes. Broad `vault:<verb>` scopes are rejected
 * here — Phase B2 settled that hub tokens always name the resource. Per-
 * vault audience enforcement happens inside `validateHubJwt` via
 * `opts.expectedAudience`.
 *
 * Per-user vault-pin enforcement (multi-user Phase 1 PR 5): when
 * `opts.vaultName` is set, the token's `vault_scope` claim is checked
 * against it via scope-guard's `enforceVaultScope`. Non-admin tokens
 * (`vault_scope: [<assigned_vault>]`) refuse cross-vault access with a
 * 403 + `vault_scope_mismatch` error code. Admin tokens (`vault_scope:
 * []`) and pre-PR-4 tokens (claim absent → surfaced as `[]`) pass
 * unchanged. The 403 (not 401) signals "your credential is valid but
 * doesn't grant access to this vault" — distinct from authentication
 * failures upstream. See hub#283 + scope-guard 0.3.0 for the mint side.
 */
async function authenticateHubJwt(
  token: string,
  opts: { expectedAudience: string | null; vaultName?: string },
): Promise<{ error: Response } | AuthResult> {
  try {
    const claims = await validateHubJwt(token, { expectedAudience: opts.expectedAudience });
    const broad = findBroadVaultScopes(claims.scopes);
    if (broad.length > 0) {
      return {
        error: Response.json(
          {
            error: "Unauthorized",
            message: `hub JWT carries broad vault scope(s): ${broad.join(" ")}. Hub-issued tokens must use resource-narrowed scopes (vault:<name>:<verb>).`,
          },
          { status: 401 },
        ),
      };
    }
    // Defense-in-depth vault-pin check (multi-user Phase 1 PR 5). Runs
    // AFTER the broad-scope check — a malformed token gets the more-
    // descriptive scope-shape error rather than a generic pin-mismatch.
    // When `vaultName` is unset (no per-vault binding known at this
    // call site), the check is skipped — the audience strict-check
    // inside validateHubJwt is the primary pin in that case.
    if (opts.vaultName !== undefined && !enforceVaultScope(claims, opts.vaultName)) {
      // Invariant: by the contract of `enforceVaultScope`, the false
      // branch requires `claims.vaultScope.length > 0` — an empty
      // `vaultScope` always returns true. The defensive assertion
      // pins that so a future refactor can't slip an empty-scope
      // request into this branch (which would render an empty
      // parenthesised list in the message and break the diagnostic).
      // Body shape: client gets `required_vault` + a message naming
      // the conflict. The token's pinned vault is intentionally NOT
      // echoed back — the attacker holds the token (and can decode
      // claims locally), so the message would only leak the pin to a
      // legitimate operator looking at a 403 log line. They already
      // know which user they assigned where; the required_vault is
      // the actionable piece.
      if (claims.vaultScope.length === 0) {
        throw new Error(
          "unreachable: enforceVaultScope returned false on an empty vaultScope",
        );
      }
      return {
        error: Response.json(
          {
            error: "Forbidden",
            error_type: "vault_scope_mismatch",
            message: `token's vault_scope (${claims.vaultScope.join(", ")}) does not include the requested vault '${opts.vaultName}'`,
            required_vault: opts.vaultName,
          },
          { status: 403 },
        ),
      };
    }
    const permission: TokenPermission =
      hasScope(claims.scopes, SCOPE_WRITE) || hasScope(claims.scopes, SCOPE_ADMIN)
        ? "full"
        : "read";
    return {
      permission,
      scopes: claims.scopes,
      legacyDerived: false,
      scoped_tags: null,
      vault_name: null,
      // claims.jti is `undefined` when the issuer didn't stamp one. Pass it
      // through verbatim — manage-token's session-pin will be null in that
      // case, and list/revoke from that session sees no mints.
      caller_jti: claims.jti ?? null,
    };
  } catch (err) {
    if (err instanceof HubJwtError) {
      // Revocation-related codes get sanitized client messages: server-side
      // audit log carries the full diagnostic (jti for `revoked`,
      // implementation-detail phrasing for `revocation_unavailable`); the
      // unauthenticated caller gets a code-shaped sentence with no internals.
      // This is the inheritable pattern across vault/scribe/agent — keep all
      // revocation-related diagnostics server-side. Other HubJwtError codes
      // (signature, audience, expired, etc.) carry generic messages and are
      // forwarded as-is; the existing test suite pins those exact strings.
      if (err.code === "revoked") {
        console.warn(`[auth] hub JWT rejected: ${err.message}`);
        return {
          error: Response.json(
            { error: "Unauthorized", message: "token has been revoked" },
            { status: 401 },
          ),
        };
      }
      if (err.code === "revocation_unavailable") {
        console.warn(`[auth] hub JWT rejected: ${err.message}`);
        return {
          error: Response.json(
            {
              error: "Unauthorized",
              message: "token cannot be validated: revocation list unavailable",
            },
            { status: 401 },
          ),
        };
      }
      return { error: Response.json({ error: "Unauthorized", message: err.message }, { status: 401 }) };
    }
    // Unknown failure shape — surface the message but stay 401.
    const msg = err instanceof Error ? err.message : "JWT validation failed";
    return { error: Response.json({ error: "Unauthorized", message: msg }, { status: 401 }) };
  }
}

/**
 * Authenticate for the unified /mcp endpoint.
 * Checks legacy global config.yaml keys first, then falls back to checking
 * each vault's token DB. This allows OAuth-minted pvt_ tokens to work on
 * the unified endpoint.
 */
export async function authenticateGlobalRequest(
  req: Request,
): Promise<{ error: Response } | AuthResult> {
  const key = extractApiKey(req);
  if (!key) {
    return { error: Response.json({ error: "Unauthorized", message: "API key required" }, { status: 401 }) };
  }

  // Server-wide operator token (vault#339). When VAULT_AUTH_TOKEN is set,
  // a matching bearer authenticates as full/admin on cross-vault routes
  // (/vaults metadata listing, /health detail). Checked first so a
  // container-host operator-channel call doesn't depend on any per-vault
  // DB lookup.
  const serverWide = tryServerWideAuth(key);
  if (serverWide !== null) return serverWide;

  // Hub-issued JWTs are always vault-bound (aud=vault.<name>). The unified
  // /vaults / /health surface spans every vault and has no single audience to
  // strict-check against, so JWTs aren't accepted here. Cross-vault listing
  // for hub-authenticated callers will land alongside the `parachute:host:*`
  // scope namespace; until then, callers wanting `/vaults` from a JWT
  // context use a per-vault token at `/vault/<name>` and rely on services.json
  // for the broader catalog.
  if (looksLikeJwt(key)) {
    return {
      error: Response.json(
        {
          error: "Unauthorized",
          message:
            "Hub-issued JWTs are vault-bound; use /vault/<name>/* endpoints. Cross-vault routes accept legacy config.yaml keys or per-vault tokens.",
        },
        { status: 401 },
      ),
    };
  }

  // Legacy: check global keys from config.yaml
  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys) {
    const matched = validateKey(globalConfig.api_keys, key);
    if (matched) {
      try { writeGlobalConfig(globalConfig); } catch {}
      warnLegacyOnce(`yaml-global:${matched.key_hash}`, "config.yaml api_keys");
      return legacyAuthResult(matched.scope === "read" ? "read" : "full");
    }
  }

  // Fall through to vault token DBs — check each vault for the token.
  // This enables OAuth-minted pvt_ tokens and CLI-created tokens to
  // authenticate against the unified /mcp endpoint. The token's vault
  // binding (if any) is propagated via AuthResult.vault_name; downstream
  // handlers that operate on a specific vault are responsible for
  // checking that binding matches their target. The unified surface
  // itself doesn't reject here — a vault-bound token authenticating to
  // call back into its own vault via /mcp is legitimate.
  for (const vaultName of listVaults()) {
    try {
      const store = getVaultStore(vaultName);
      const resolved = resolveToken(store.db, key);
      if (resolved) {
        if (resolved.legacyDerived) {
          warnLegacyOnce(`vault-token:${vaultName}`, "vault token without scopes column");
        }
        return {
          permission: resolved.permission,
          scopes: resolved.scopes,
          legacyDerived: resolved.legacyDerived,
          scoped_tags: resolved.scoped_tags,
          vault_name: resolved.vault_name,
          caller_jti: resolved.jti,
        };
      }
    } catch {
      // Skip vaults that can't be opened
    }
  }

  return { error: Response.json({ error: "Unauthorized", message: "Invalid API key" }, { status: 401 }) };
}
