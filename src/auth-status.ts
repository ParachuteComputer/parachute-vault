/**
 * Public auth-state probe — read-only summary that lets a first-contact
 * client decide which token to mint before doing anything authenticated.
 *
 * Mirrors the consumer shape that `parachute-hub/src/vault/auth-status.ts`
 * already computes by snooping vault's filesystem; this endpoint replaces
 * that out-of-process coupling with an in-process read.
 *
 * What gets exposed:
 *   - `initialized` — at least one vault exists
 *   - `auth_modes`  — accepted bearer formats. As of 0.6.0 (vault#282 Stage 2)
 *     vault is a pure hub resource-server: the only first-class user
 *     credential is a hub-issued JWT, so this is `["hub_jwt"]`. (The
 *     server-wide VAULT_AUTH_TOKEN operator bearer + legacy YAML api_keys
 *     still authenticate, but they're operator/legacy channels, not the
 *     advertised first-contact mode.)
 *   - `vaults`      — list of `{ name, url }` for client-side dispatch
 *   - `hasOwnerPassword`, `hasTotp` — OAuth consent prerequisites
 *   - `hasTokens`   — boolean | null. Probes the vestigial `tokens` table for
 *     any leftover pre-0.6.0 rows (the table is kept inert as the YAML-import
 *     landing zone + a future-cosmetic-drop target). `null` ≈ "we couldn't
 *     read all DBs, don't trust this answer"; `true`/`false` are honest yes/no.
 *
 * What is deliberately NOT exposed: token counts, hashes, descriptions,
 * timestamps, owner-password hash, totp secret, backup codes. The endpoint
 * is unauthenticated — anything sensitive belongs behind /vaults or
 * /vault/<name>/.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { listVaults, readGlobalConfig, vaultDbPath } from "./config.ts";

export interface AuthStatusResponse {
  initialized: boolean;
  auth_modes: "hub_jwt"[];
  vaults: { name: string; url: string }[];
  hasOwnerPassword: boolean;
  hasTotp: boolean;
  hasTokens: boolean | null;
}

/**
 * Probe a single vault's `tokens` table for *existence* (not count). We open
 * the DB read-only and `LIMIT 1` so we never block a writer or fight for a
 * lock. Any failure (missing DB, schema drift, lock contention) is the
 * caller's signal to degrade `hasTokens` to `null`.
 */
function vaultHasTokens(dbPath: string): boolean {
  // Readonly handle — no pragma application here. Journal mode is a
  // persistent DB-header setting written by the first writer (the daemon's
  // BunSqliteStore via openVaultDb), so this probe sees WAL automatically
  // and is safe under concurrent writes.
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT 1 FROM tokens LIMIT 1").get();
    return row !== null && row !== undefined;
  } finally {
    db.close();
  }
}

function readTokenPresence(vaultNames: string[]): boolean | null {
  if (vaultNames.length === 0) return false;
  let any = false;
  for (const name of vaultNames) {
    const dbPath = vaultDbPath(name);
    if (!existsSync(dbPath)) continue;
    try {
      if (vaultHasTokens(dbPath)) {
        any = true;
        // Don't early-return — keep probing so a later locked DB still
        // surfaces as `null` rather than a misleading `true`.
      }
    } catch {
      return null;
    }
  }
  return any;
}

export function buildAuthStatus(): AuthStatusResponse {
  const globalConfig = readGlobalConfig();
  const vaultNames = listVaults();
  return {
    initialized: vaultNames.length > 0,
    auth_modes: ["hub_jwt"],
    vaults: vaultNames.map((name) => ({ name, url: `/vault/${name}` })),
    hasOwnerPassword: typeof globalConfig.owner_password_hash === "string"
      && globalConfig.owner_password_hash.length > 0,
    hasTotp: typeof globalConfig.totp_secret === "string"
      && globalConfig.totp_secret.length > 0,
    hasTokens: readTokenPresence(vaultNames),
  };
}
