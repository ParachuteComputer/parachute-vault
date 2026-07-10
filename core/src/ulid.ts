/**
 * ULID generator (vault#ulid-ids) — monotonic, lexicographically
 * time-sortable, Crockford base32, opaque, collision-resistant identifiers.
 *
 * Spec: https://github.com/ulid/spec
 *
 *   - 48-bit millisecond timestamp, encoded as the first 10 Crockford
 *     base32 characters (most-significant digit first).
 *   - 80-bit randomness, encoded as the remaining 16 characters.
 *   - 26 characters total.
 *
 * Monotonicity: when two IDs are minted within the SAME millisecond, the
 * random component of the second is the first's incremented by 1
 * (odometer-style carry across base32 digits) rather than re-rolled, so
 * lexicographic string order matches generation order even at IDgen rates
 * far above 1kHz. This mirrors the reference `ulid` package's
 * `monotonicFactory`.
 *
 * This is a small, dependency-light, hand-rolled implementation rather than
 * a pull of the `ulid` npm package — the algorithm is short enough (~60
 * lines) that inlining it avoids a new supply-chain dependency for what is,
 * cryptographically, just "48 bits of time + 80 bits of randomness, base32
 * encoded."
 *
 * Randomness source: `crypto.getRandomValues` (Web Crypto — available as a
 * global in Bun), not `Math.random`. This module is runtime application
 * code (invoked from note/attachment creation), not a workflow/sandbox
 * script, so Web Crypto is available; it's also simply better randomness
 * than `Math.random` for anything used as a public, collision-resistant
 * identifier.
 */

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE = CROCKFORD_BASE32.length; // 32
const TIME_LEN = 10; // 10 chars * 5 bits = 50 bits, enough for the 48-bit timestamp
const RANDOM_LEN = 16; // 16 chars * 5 bits = 80 bits
const TIME_MAX = 2 ** 48 - 1;

/** Encode a non-negative integer as a fixed-length Crockford base32 string. */
function encodeTime(time: number, length: number): string {
  let t = time;
  let str = "";
  for (let i = length; i > 0; i--) {
    const mod = t % BASE;
    str = CROCKFORD_BASE32[mod]! + str;
    t = (t - mod) / BASE;
  }
  return str;
}

/** Draw `length` cryptographically-random Crockford base32 characters. */
function randomChars(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let str = "";
  for (let i = 0; i < length; i++) {
    // Each byte (0-255) mod 32 introduces a slight bias (256 isn't a
    // multiple of 32... actually 256 = 8*32, so this is exactly uniform).
    str += CROCKFORD_BASE32[bytes[i]! % BASE];
  }
  return str;
}

/**
 * Increment a Crockford base32 string by 1, odometer-style: rightmost digit
 * first, carrying leftward on overflow. Used to derive the next monotonic
 * ID within the same millisecond.
 *
 * Throws if every digit is already the max ('Z') — i.e. the full 80-bit
 * random space has been exhausted within a single millisecond. That would
 * require minting 2^80 (~1.2e24) IDs in under a millisecond, several orders
 * of magnitude beyond any realistic write rate; this is a defensive bound,
 * not a real-world concern.
 */
function incrementBase32(str: string): string {
  const chars = str.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const idx = CROCKFORD_BASE32.indexOf(chars[i]!);
    if (idx < BASE - 1) {
      chars[i] = CROCKFORD_BASE32[idx + 1]!;
      return chars.join("");
    }
    chars[i] = CROCKFORD_BASE32[0]!;
  }
  throw new Error("ULID random component overflow — 2^80 IDs minted within a single millisecond");
}

// Monotonic state, process-local (matches generateId()'s prior idCounter
// approach — a single vault process is the unit of monotonicity; a cursor's
// tiebreaker doesn't require cross-process ordering, just a stable total
// order per id string).
let lastTime = 0;
let lastRandom = "";

/**
 * Generate a monotonic ULID. See module doc for the algorithm.
 *
 * Exported separately from `generateId()` (in notes.ts) so it's testable in
 * isolation (monotonicity, format, charset) without pulling in the Store.
 */
export function generateUlid(): string {
  const now = Math.min(Date.now(), TIME_MAX);
  if (now <= lastTime && lastRandom) {
    // Same (or earlier — clock skew) millisecond as the last mint: keep
    // `lastTime` as-is and bump the random component to preserve strict
    // monotonicity.
    lastRandom = incrementBase32(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars(RANDOM_LEN);
  }
  return encodeTime(lastTime, TIME_LEN) + lastRandom;
}

/** 26-char Crockford base32 (`0-9A-HJKMNP-TV-Z`, case-insensitive by spec — we always emit uppercase). */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
