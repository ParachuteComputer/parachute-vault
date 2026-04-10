/**
 * API key authentication for the vault server.
 *
 * Two scopes:
 *   - Global keys (in config.yaml): access unified /mcp and all vaults
 *   - Per-vault keys (in vault.yaml): access that vault's /vaults/{name}/mcp and API
 *
 * Key permissions:
 *   - scope: "write" — full access (default)
 *   - scope: "read"  — read-only (blocked from create/update/delete operations)
 *
 * Localhost bypasses auth for both.
 */

import { readVaultConfig, readGlobalConfig, writeVaultConfig, writeGlobalConfig, verifyKey } from "./config.ts";
import type { VaultConfig, GlobalConfig, StoredKey, KeyScope } from "./config.ts";

/** Result of a successful auth check. */
export interface AuthResult {
  keyId: string;
  scope: KeyScope;
}

/** Read-only tools (allowed for scope: "read"). */
const READ_TOOLS = new Set([
  "get-note",
  "read-notes",
  "search-notes",
  "get-links",
  "traverse-links",
  "find-path",
  "list-tags",
  "list-vaults",
  "get-vault-description",
  "get-vault-stats",
  "list-unresolved-wikilinks",
]);

/** Check if a tool call is allowed for a given scope. */
export function isToolAllowed(toolName: string, scope: KeyScope): boolean {
  if (scope === "write") return true;
  return READ_TOOLS.has(toolName);
}

/** Read-only HTTP methods. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Check if an HTTP method is allowed for a given scope. */
export function isMethodAllowed(method: string, scope: KeyScope): boolean {
  if (scope === "write") return true;
  return READ_METHODS.has(method);
}

/**
 * Extract API key from request headers.
 */
export function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return req.headers.get("x-api-key");
}

/** Check if a request originates from localhost. */
export function isLocalhost(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    return first === "127.0.0.1" || first === "::1" || first === "::ffff:127.0.0.1";
  }
  return true;
}

/**
 * Validate a key against a list of stored keys.
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
 * Accepts per-vault keys OR global keys.
 * Returns null (allowed) or error Response.
 * Sets x-key-scope header on success for downstream use.
 */
export function authenticateVaultRequest(
  req: Request,
  vaultConfig: VaultConfig,
): { error: Response } | { scope: KeyScope } {
  if (isLocalhost(req)) return { scope: "write" };

  const key = extractApiKey(req);
  if (!key) {
    return { error: Response.json({ error: "Unauthorized", message: "API key required" }, { status: 401 }) };
  }

  // Check per-vault keys first
  const vaultKey = validateKey(vaultConfig.api_keys, key);
  if (vaultKey) {
    try { writeVaultConfig(vaultConfig); } catch {}
    return { scope: vaultKey.scope ?? "write" };
  }

  // Check global keys
  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys) {
    const globalKey = validateKey(globalConfig.api_keys, key);
    if (globalKey) {
      try { writeGlobalConfig(globalConfig); } catch {}
      return { scope: globalKey.scope ?? "write" };
    }
  }

  return { error: Response.json({ error: "Unauthorized", message: "Invalid API key" }, { status: 401 }) };
}

/**
 * Authenticate for the unified /mcp endpoint.
 * Accepts global keys only.
 */
export function authenticateGlobalRequest(
  req: Request,
): { error: Response } | { scope: KeyScope } {
  if (isLocalhost(req)) return { scope: "write" };

  const key = extractApiKey(req);
  if (!key) {
    return { error: Response.json({ error: "Unauthorized", message: "API key required" }, { status: 401 }) };
  }

  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys) {
    const matched = validateKey(globalConfig.api_keys, key);
    if (matched) {
      try { writeGlobalConfig(globalConfig); } catch {}
      return { scope: matched.scope ?? "write" };
    }
  }

  return { error: Response.json({ error: "Unauthorized", message: "Invalid API key" }, { status: 401 }) };
}
