/**
 * TOTP 2FA + single-use backup codes for the OAuth consent page.
 *
 * Layers on top of the owner password in `owner-auth.ts`: when 2FA is
 * enrolled, consent requires password + (TOTP code OR one backup code).
 *
 * - Secret: 20 random bytes, base32-encoded. Stored as a string in
 *   `config.yaml` under `totp_secret`.
 * - TOTP: SHA-1, 6 digits, 30s period. Validation accepts ±1 window
 *   (≈90s effective tolerance) to account for clock drift.
 * - Backup codes: 6 codes, 8 characters each (alphanumeric, lowercased).
 *   Stored bcrypt-hashed (cost 10). Each code is single-use: on successful
 *   verification, its hash is removed from the list.
 */
import * as OTPAuth from "otpauth";
import { createHash } from "node:crypto";
import { readGlobalConfig, writeGlobalConfig } from "./config.ts";

const BCRYPT_COST = 10;
const BACKUP_CODE_COUNT = 6;
const BACKUP_CODE_LENGTH = 8;
const TOTP_ISSUER = "Parachute Vault";

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

function makeTotp(secretBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/** Read the stored TOTP secret (base32), or null if 2FA is not enrolled. */
export function getTotpSecret(): string | null {
  const s = readGlobalConfig().totp_secret;
  if (typeof s !== "string" || s.length === 0) return null;
  return s;
}

export function hasTotpEnrolled(): boolean {
  return getTotpSecret() !== null;
}

export interface EnrollmentResult {
  /** Base32-encoded secret (show to user for manual entry). */
  secret: string;
  /** otpauth:// URL (encode as QR code for authenticator apps). */
  otpauthUrl: string;
  /** One-time backup codes in plaintext. Show once; never retrievable. */
  backupCodes: string[];
}

/**
 * Generate a fresh TOTP secret + backup codes and persist them.
 * Overwrites any existing enrollment.
 */
export async function enrollTotp(label = "owner"): Promise<EnrollmentResult> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const totp = makeTotp(secret, label);
  const { codes, hashes } = await generateBackupCodes();

  const config = readGlobalConfig();
  config.totp_secret = secret;
  config.backup_codes = hashes;
  writeGlobalConfig(config);

  return {
    secret,
    otpauthUrl: totp.toString(),
    backupCodes: codes,
  };
}

/** Remove the TOTP enrollment and all backup codes. */
export function disableTotp(): void {
  const config = readGlobalConfig();
  delete config.totp_secret;
  delete config.backup_codes;
  writeGlobalConfig(config);
}

/**
 * In-memory cache of recently-used TOTP codes to prevent replay within
 * the ±1 acceptance window. Key = "secret:counter"; value = expiry timestamp.
 * Bounded: entries auto-expire ~2 minutes after the code's window closes.
 */
const usedTotpCounters = new Map<string, number>();

/** Drop entries whose window has passed. Called on every verify. */
function gcUsedTotp(now: number): void {
  for (const [k, exp] of usedTotpCounters) {
    if (exp < now) usedTotpCounters.delete(k);
  }
}

/**
 * Verify a TOTP code against the given secret.
 * Accepts ±1 window (prev/current/next 30s period). A given (secret, counter)
 * is single-use within its acceptance lifetime — replays are rejected.
 *
 * `markUsed`: set false in tests that want to verify the same code twice.
 * Defaults to true in production.
 */
export function verifyTotpCode(secretBase32: string, code: string, markUsed = true): boolean {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  try {
    const totp = makeTotp(secretBase32, "owner");
    const delta = totp.validate({ token: trimmed, window: 1 });
    if (delta === null) return false;

    const now = Date.now();
    gcUsedTotp(now);
    const counter = Math.floor(now / 30_000) + delta;
    // Hash the secret so the in-memory replay cache never holds the plaintext
    // TOTP secret as a map key (defense in depth against heap dumps / logs).
    const secretHash = createHash("sha256").update(secretBase32).digest("hex");
    const key = `${secretHash}:${counter}`;
    if (usedTotpCounters.has(key)) return false;
    if (markUsed) {
      // Expire the entry a bit after the outer edge of the acceptance window.
      usedTotpCounters.set(key, now + 120_000);
    }
    return true;
  } catch {
    return false;
  }
}

/** Test-only: reset the replay-protection cache. */
export function _resetTotpReplayCache(): void {
  usedTotpCounters.clear();
}

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------

function randomBackupCode(): string {
  // Lowercase alphanumeric minus ambiguous (0,o,1,l). Read-aloud friendly.
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(BACKUP_CODE_LENGTH));
  let out = "";
  for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/** Generate a fresh set of backup codes + their bcrypt hashes. */
export async function generateBackupCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = randomBackupCode();
    codes.push(code);
    hashes.push(await Bun.password.hash(code, { algorithm: "bcrypt", cost: BCRYPT_COST }));
  }
  return { codes, hashes };
}

/** Rotate: replace stored backup codes with a fresh set. Returns the plaintext codes. */
export async function regenerateBackupCodes(): Promise<string[]> {
  const { codes, hashes } = await generateBackupCodes();
  const config = readGlobalConfig();
  config.backup_codes = hashes;
  writeGlobalConfig(config);
  return codes;
}

export function getBackupCodeCount(): number {
  return readGlobalConfig().backup_codes?.length ?? 0;
}

/**
 * Serialize backup-code verification so two concurrent consent POSTs can't
 * both consume the same code (TOCTOU between verify-await and config write).
 * Bun is single-threaded but bcrypt verify yields the event loop.
 */
let backupCodeMutex: Promise<unknown> = Promise.resolve();

/**
 * Verify a backup code; if it matches, consume it (remove from the stored
 * list) and return true. Single-use, and safe against concurrent requests.
 */
export async function verifyAndConsumeBackupCode(code: string): Promise<boolean> {
  const normalized = code.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalized) return false;

  // Chain behind any in-flight verification.
  const run = backupCodeMutex.then(() => doVerifyAndConsume(normalized));
  backupCodeMutex = run.catch(() => {}); // keep chain alive even if one throws
  return run;
}

async function doVerifyAndConsume(normalized: string): Promise<boolean> {
  // Re-read hashes at the start of this critical section so we see consumes
  // from prior mutex holders.
  const config = readGlobalConfig();
  const hashes = config.backup_codes;
  if (!hashes || hashes.length === 0) return false;

  for (let i = 0; i < hashes.length; i++) {
    try {
      if (await Bun.password.verify(normalized, hashes[i]!)) {
        // Consume: splice from the snapshot we verified against and persist.
        config.backup_codes = hashes.filter((_, j) => j !== i);
        writeGlobalConfig(config);
        return true;
      }
    } catch {
      // Corrupt hash — skip.
    }
  }
  return false;
}
