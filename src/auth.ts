/**
 * Authentication and authorization for the vault server.
 *
 * Token-based auth with three permission levels:
 *   - "admin" — full access (CRUD + delete + token management)
 *   - "write" — read + create/update notes
 *   - "read"  — read-only (query, list, find-path, vault-info)
 *
 * Tokens can be scoped:
 *   - vault: NULL (global) or a specific vault name
 *   - scope_tag: filter results to notes with that tag
 *   - scope_path_prefix: filter results to notes under that path
 *
 * Backward compatibility: still checks config.yaml API keys as a fallback.
 * Those keys resolve as admin tokens with no scope.
 */

import { readGlobalConfig, writeVaultConfig, writeGlobalConfig, verifyKey } from "./config.ts";
import type { VaultConfig, StoredKey, KeyScope } from "./config.ts";
import { getTokenDb, resolveToken } from "./token-store.ts";
import type { TokenPermission, ResolvedToken } from "./token-store.ts";

/** Result of a successful auth check. */
export interface AuthResult {
  permission: TokenPermission;
  scope_tag: string | null;
  scope_path_prefix: string | null;
}

/** Read-only tools (allowed for "read" permission). */
const READ_TOOLS = new Set([
  "query-notes",
  "list-tags",
  "find-path",
  "vault-info",
  "list-vaults",
]);

/** Write tools (allowed for "write" and "admin" permission). */
const WRITE_TOOLS = new Set([
  "create-note",
  "update-note",
  "update-tag",
]);

/** Check if a tool call is allowed for a given permission level. */
export function isToolAllowed(toolName: string, permission: TokenPermission): boolean {
  if (permission === "admin") return true;
  if (permission === "write") return READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName);
  return READ_TOOLS.has(toolName);
}


/** Read-only HTTP methods. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Write HTTP methods (not DELETE). */
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT"]);

/** Check if an HTTP method is allowed for a given permission level. */
export function isMethodAllowed(method: string, permission: TokenPermission): boolean {
  if (permission === "admin") return true;
  if (permission === "write") return READ_METHODS.has(method) || WRITE_METHODS.has(method);
  return READ_METHODS.has(method);
}

/**
 * Extract API key/token from request headers.
 */
export function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return req.headers.get("x-api-key");
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
 * Try resolving a token from the tokens DB.
 */
function tryTokenAuth(providedKey: string, vaultName?: string): AuthResult | null {
  try {
    const db = getTokenDb();
    const resolved = resolveToken(db, providedKey);
    if (!resolved) return null;

    // Check vault scope: global tokens (vault=NULL) can access any vault,
    // vault-scoped tokens can only access their vault
    if (resolved.vault !== null && vaultName !== undefined && resolved.vault !== vaultName) {
      return null;
    }

    return {
      permission: resolved.permission,
      scope_tag: resolved.scope_tag,
      scope_path_prefix: resolved.scope_path_prefix,
    };
  } catch {
    // Token DB not available — fall through to legacy auth
    return null;
  }
}

/**
 * Authenticate for a specific vault.
 * Tries token DB first, then falls back to legacy YAML keys.
 */
export function authenticateVaultRequest(
  req: Request,
  vaultConfig: VaultConfig,
): { error: Response } | AuthResult {
  const key = extractApiKey(req);
  if (!key) {
    return { error: Response.json({ error: "Unauthorized", message: "API key required" }, { status: 401 }) };
  }

  // Try token DB first
  const tokenAuth = tryTokenAuth(key, vaultConfig.name);
  if (tokenAuth) return tokenAuth;

  // Legacy: check per-vault keys
  const vaultKey = validateKey(vaultConfig.api_keys, key);
  if (vaultKey) {
    try { writeVaultConfig(vaultConfig); } catch {}
    return {
      permission: vaultKey.scope === "read" ? "read" : "admin",
      scope_tag: null,
      scope_path_prefix: null,
    };
  }

  // Legacy: check global keys
  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys) {
    const globalKey = validateKey(globalConfig.api_keys, key);
    if (globalKey) {
      try { writeGlobalConfig(globalConfig); } catch {}
      return {
        permission: globalKey.scope === "read" ? "read" : "admin",
        scope_tag: null,
        scope_path_prefix: null,
      };
    }
  }

  return { error: Response.json({ error: "Unauthorized", message: "Invalid API key" }, { status: 401 }) };
}

/**
 * Authenticate for the unified /mcp endpoint.
 * Tries token DB first (global tokens only), then falls back to legacy global keys.
 */
export function authenticateGlobalRequest(
  req: Request,
): { error: Response } | AuthResult {
  const key = extractApiKey(req);
  if (!key) {
    return { error: Response.json({ error: "Unauthorized", message: "API key required" }, { status: 401 }) };
  }

  // Try token DB (global tokens only — vault=NULL)
  try {
    const db = getTokenDb();
    const resolved = resolveToken(db, key);
    if (resolved && resolved.vault === null) {
      return {
        permission: resolved.permission,
        scope_tag: resolved.scope_tag,
        scope_path_prefix: resolved.scope_path_prefix,
      };
    }
  } catch {}


  // Legacy: check global keys
  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys) {
    const matched = validateKey(globalConfig.api_keys, key);
    if (matched) {
      try { writeGlobalConfig(globalConfig); } catch {}
      return {
        permission: matched.scope === "read" ? "read" : "admin",
        scope_tag: null,
        scope_path_prefix: null,
      };
    }
  }

  return { error: Response.json({ error: "Unauthorized", message: "Invalid API key" }, { status: 401 }) };
}
