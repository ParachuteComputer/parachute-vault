/**
 * Owner-password storage + verification.
 *
 * **Vestigial after vault#XXX (workstream E of the UX audit, 2026-05-25).**
 * The owner password used to authenticate the vault's standalone OAuth
 * consent page (the one rendered by the now-deleted `src/oauth.ts`). With
 * hub required and consent moved to the hub, the password no longer
 * protects anything inside vault. The module is kept because:
 *
 *   1. Hub's `expose public` preflight reads `owner_password_hash` /
 *      `totp_secret` from vault's `config.yaml` to score auth posture
 *      (`parachute-hub/src/vault/auth-status.ts`). Removing the YAML
 *      surface in lockstep would turn every install's preflight
 *      score into "wide-open" until hub ships its own posture check.
 *   2. The CLI `set-password` / `2fa enroll` commands keep working for
 *      operators on the legacy posture mid-migration.
 *
 * Retirement is tracked as a follow-up; this file should go away once
 * the hub-side preflight is updated to score hub credentials instead of
 * vault credentials.
 *
 * The per-IP `RateLimiter` (formerly in this file) was deleted alongside
 * the consent page — there's no traffic to limit on a route that no
 * longer exists.
 *
 * Password hashing uses Bun.password (bcrypt, cost 12 by default).
 */

import { readGlobalConfig, writeGlobalConfig } from "./config.ts";

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 12;

// ---------------------------------------------------------------------------
// Password storage
// ---------------------------------------------------------------------------

/** Read the stored bcrypt hash, or null if none set (or set to empty string). */
export function getOwnerPasswordHash(): string | null {
  const hash = readGlobalConfig().owner_password_hash;
  if (typeof hash !== "string" || hash.length === 0) return null;
  return hash;
}

/** Whether a password has been set. */
export function hasOwnerPassword(): boolean {
  return getOwnerPasswordHash() !== null;
}

/** Validate password strength. Returns error message or null. */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/** Hash and store the owner password. Throws on weak passwords. */
export async function setOwnerPassword(password: string): Promise<void> {
  const err = validatePasswordStrength(password);
  if (err) throw new Error(err);

  const hash = await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: BCRYPT_COST,
  });

  const config = readGlobalConfig();
  config.owner_password_hash = hash;
  writeGlobalConfig(config);
}

/** Remove the stored password (disables password-based consent auth). */
export function clearOwnerPassword(): void {
  const config = readGlobalConfig();
  delete config.owner_password_hash;
  writeGlobalConfig(config);
}

/** Verify a provided password against the given hash. */
export async function verifyOwnerPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

