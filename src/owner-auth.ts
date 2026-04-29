/**
 * Owner authentication for the OAuth consent page.
 *
 * The "owner" is the person who set up this vault — identified by a password
 * stored globally in config.yaml (owner_password_hash). The password is used
 * to prove ownership when authorizing third-party OAuth clients.
 *
 * Password hashing uses Bun.password (bcrypt, cost 12 by default) — no deps.
 *
 * Rate limiting is per-IP, in-memory. Acceptable for v1: resets on restart,
 * doesn't handle multi-process deployments. Tighten later if needed.
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

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number | null;
}

/**
 * Per-IP rate limiter for consent-page attempts.
 *
 * Policy:
 *   - Up to MAX_FAILURES failed attempts within WINDOW_MS → lockout
 *   - Lockout lasts LOCKOUT_MS
 *   - A successful attempt clears the IP's counter
 *   - Hard cap on entry count — when full, the oldest insertion is evicted
 *     before a new one is recorded. Prevents memory exhaustion via IP /
 *     client_id enumeration (#93).
 */
export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 60_000,
    private readonly lockoutMs = 15 * 60_000,
    private readonly maxEntries = 10_000,
  ) {}

  /**
   * Check whether an IP is currently allowed to attempt auth.
   * Returns `{ allowed: false, retryAfterSec }` if locked out.
   */
  check(ip: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const entry = this.entries.get(ip);
    if (!entry) return { allowed: true };

    const now = Date.now();
    if (entry.lockedUntil && entry.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
    }

    // Expired lockout or old window — reset and allow
    if (entry.lockedUntil && entry.lockedUntil <= now) {
      this.entries.delete(ip);
      return { allowed: true };
    }
    if (now - entry.firstFailureAt > this.windowMs) {
      this.entries.delete(ip);
      return { allowed: true };
    }

    return { allowed: true };
  }

  /** Record a failed attempt. Triggers lockout if threshold reached. */
  recordFailure(ip: string): void {
    const now = Date.now();
    const entry = this.entries.get(ip);

    if (!entry || now - entry.firstFailureAt > this.windowMs) {
      this.evictIfFull();
      this.entries.set(ip, {
        failures: 1,
        firstFailureAt: now,
        lockedUntil: null,
      });
      return;
    }

    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = now + this.lockoutMs;
    }
  }

  /** Record a successful attempt. Clears the IP's counter. */
  recordSuccess(ip: string): void {
    this.entries.delete(ip);
  }

  /** For tests: drop all state. */
  reset(): void {
    this.entries.clear();
  }

  /** Current entry count — exposed for tests + observability. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Evict the oldest insertion(s) until size < maxEntries. Map preserves
   * insertion order, so `keys().next().value` is the oldest. We re-insert
   * on window-rollover (delete + new set), so insertion order tracks
   * recency-of-failure closely enough for FIFO eviction.
   */
  private evictIfFull(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Singleton rate limiter — kept for back-compat with callers that don't pass
 * through per-vault routing. Fresh callers should prefer
 * `getAuthorizeRateLimiter(vaultName)` so traffic on one vault's consent flow
 * doesn't lock out IPs on another vault's consent flow (#93).
 */
export const authorizeRateLimit = new RateLimiter();

/**
 * Per-vault rate limiter registry. The vault count is admin-bounded (vaults
 * are created via CLI, not by clients) so this Map can grow only with operator
 * action — no attacker-driven growth path. Each instance carries the
 * default 10,000-entry IP cap, scoped to its vault (#93).
 */
const vaultAuthorizeRateLimiters = new Map<string, RateLimiter>();

/** Lazily get-or-create the rate limiter for a given vault. */
export function getAuthorizeRateLimiter(vaultName: string): RateLimiter {
  let limiter = vaultAuthorizeRateLimiters.get(vaultName);
  if (!limiter) {
    limiter = new RateLimiter();
    vaultAuthorizeRateLimiters.set(vaultName, limiter);
  }
  return limiter;
}

/** For tests: drop all per-vault limiters. */
export function resetVaultAuthorizeRateLimiters(): void {
  vaultAuthorizeRateLimiters.clear();
}
