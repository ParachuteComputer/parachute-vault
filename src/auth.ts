/**
 * API key authentication for the vault server.
 *
 * Two scopes:
 *   - Global keys (in config.yaml): access unified /mcp and all vaults
 *   - Per-vault keys (in vault.yaml): access that vault's /vaults/{name}/mcp and API
 *
 * Localhost bypasses auth for both.
 */

import { readVaultConfig, readGlobalConfig, writeVaultConfig, writeGlobalConfig, verifyKey } from "./config.ts";
import type { VaultConfig, GlobalConfig, StoredKey } from "./config.ts";

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
 * Returns the matched key ID or null.
 */
function validateKey(keys: StoredKey[], providedKey: string): string | null {
  for (const stored of keys) {
    if (verifyKey(providedKey, stored.key_hash)) {
      stored.last_used_at = new Date().toISOString();
      return stored.id;
    }
  }
  return null;
}

/**
 * Authenticate for a specific vault.
 * Accepts per-vault keys OR global keys.
 */
export function authenticateVaultRequest(
  req: Request,
  vaultConfig: VaultConfig,
): Response | null {
  if (isLocalhost(req)) return null;

  const key = extractApiKey(req);
  if (!key) {
    return Response.json(
      { error: "Unauthorized", message: "API key required" },
      { status: 401 },
    );
  }

  // Check per-vault keys first
  if (validateKey(vaultConfig.api_keys, key)) {
    try { writeVaultConfig(vaultConfig); } catch {}
    return null;
  }

  // Check global keys
  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys && validateKey(globalConfig.api_keys, key)) {
    try { writeGlobalConfig(globalConfig); } catch {}
    return null;
  }

  return Response.json(
    { error: "Unauthorized", message: "Invalid API key" },
    { status: 401 },
  );
}

/**
 * Authenticate for the unified /mcp endpoint.
 * Accepts global keys only.
 */
export function authenticateGlobalRequest(req: Request): Response | null {
  if (isLocalhost(req)) return null;

  const key = extractApiKey(req);
  if (!key) {
    return Response.json(
      { error: "Unauthorized", message: "API key required" },
      { status: 401 },
    );
  }

  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys && validateKey(globalConfig.api_keys, key)) {
    try { writeGlobalConfig(globalConfig); } catch {}
    return null;
  }

  return Response.json(
    { error: "Unauthorized", message: "Invalid API key" },
    { status: 401 },
  );
}
