/**
 * Per-vault API key authentication for the multi-vault server.
 *
 * Each vault has its own set of API keys stored in vault.yaml.
 * Auth is checked per-request based on the vault being accessed.
 */

import { readVaultConfig, writeVaultConfig, verifyKey } from "./config.ts";
import type { VaultConfig } from "./config.ts";

/**
 * Validate an API key against a vault's stored keys.
 * Returns the matched key ID or null if invalid.
 */
export function validateVaultKey(
  vaultConfig: VaultConfig,
  providedKey: string,
): string | null {
  for (const stored of vaultConfig.api_keys) {
    if (verifyKey(providedKey, stored.key_hash)) {
      // Update last_used_at (fire-and-forget)
      stored.last_used_at = new Date().toISOString();
      try {
        writeVaultConfig(vaultConfig);
      } catch {}
      return stored.id;
    }
  }
  return null;
}

/**
 * Extract API key from request headers.
 * Supports both Bearer token and X-API-Key header.
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
  // Bun.serve() binds to 127.0.0.1 — all connections are local
  return true;
}

/**
 * Authenticate a request for a specific vault.
 * Localhost bypasses auth. Remote requires a valid API key.
 * Returns null if authorized, or an error Response if not.
 */
export function authenticateRequest(
  req: Request,
  vaultConfig: VaultConfig,
): Response | null {
  // Localhost bypasses auth
  if (isLocalhost(req)) return null;

  const key = extractApiKey(req);
  if (!key) {
    return Response.json(
      { error: "Unauthorized", message: "API key required" },
      { status: 401 },
    );
  }

  const keyId = validateVaultKey(vaultConfig, key);
  if (!keyId) {
    return Response.json(
      { error: "Unauthorized", message: "Invalid API key" },
      { status: 401 },
    );
  }

  return null;
}
