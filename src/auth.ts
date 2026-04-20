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
import { getVaultStore } from "./vault-store.ts";
import { hasScope, legacyPermissionToScopes, SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE } from "./scopes.ts";

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
  };
}

/**
 * Guard: does the authenticated request carry the required scope?
 * Uses `hasScope` inheritance: admin ⊇ write ⊇ read.
 */
export function requireScope(auth: AuthResult, required: string): boolean {
  return hasScope(auth.scopes, required);
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
 * Checks the vault's token DB first, then falls back to legacy YAML keys.
 */
export function authenticateVaultRequest(
  req: Request,
  vaultConfig: VaultConfig,
  vaultDb?: Database,
): { error: Response } | AuthResult {
  const key = extractApiKey(req);
  if (!key) {
    return { error: Response.json({ error: "Unauthorized", message: "API key required" }, { status: 401 }) };
  }

  // Try vault's token DB first
  if (vaultDb) {
    try {
      const resolved = resolveToken(vaultDb, key);
      if (resolved) {
        if (resolved.legacyDerived) {
          warnLegacyOnce(`vault-token:${vaultConfig.name ?? ""}`, "vault token without scopes column");
        }
        return {
          permission: resolved.permission,
          scopes: resolved.scopes,
          legacyDerived: resolved.legacyDerived,
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
 * Authenticate for the unified /mcp endpoint.
 * Checks legacy global config.yaml keys first, then falls back to checking
 * each vault's token DB. This allows OAuth-minted pvt_ tokens to work on
 * the unified endpoint.
 */
export function authenticateGlobalRequest(
  req: Request,
): { error: Response } | AuthResult {
  const key = extractApiKey(req);
  if (!key) {
    return { error: Response.json({ error: "Unauthorized", message: "API key required" }, { status: 401 }) };
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
  // authenticate against the unified /mcp endpoint.
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
        };
      }
    } catch {
      // Skip vaults that can't be opened
    }
  }

  return { error: Response.json({ error: "Unauthorized", message: "Invalid API key" }, { status: 401 }) };
}
