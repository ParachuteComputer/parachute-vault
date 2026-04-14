/**
 * Tests for TOTP 2FA + backup codes (src/two-factor.ts).
 *
 * Uses PARACHUTE_HOME override so enrollment/regeneration touches a tmp dir
 * instead of the user's real ~/.parachute. Must set env BEFORE importing
 * config-dependent modules.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as OTPAuth from "otpauth";

const testDir = join(tmpdir(), `vault-2fa-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.PARACHUTE_HOME = testDir;

const {
  enrollTotp,
  disableTotp,
  hasTotpEnrolled,
  verifyTotpCode,
  regenerateBackupCodes,
  getBackupCodeCount,
  verifyAndConsumeBackupCode,
  getTotpSecret,
  _resetTotpReplayCache,
} = await import("./two-factor.ts");

const { readGlobalConfig, writeGlobalConfig } = await import("./config.ts");

beforeEach(() => {
  // Fresh per-test state
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  writeGlobalConfig({ port: 1940 });
  _resetTotpReplayCache();
});

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

describe("TOTP verification", () => {
  test("accepts the current code", () => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const totp = new OTPAuth.TOTP({
      issuer: "Parachute Vault",
      label: "owner",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const code = totp.generate();
    expect(verifyTotpCode(secret, code)).toBe(true);
  });

  test("accepts prev/next window (±30s drift)", () => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const totp = new OTPAuth.TOTP({
      issuer: "Parachute Vault",
      label: "owner",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const now = Date.now();
    const prev = totp.generate({ timestamp: now - 30_000 });
    const next = totp.generate({ timestamp: now + 30_000 });
    expect(verifyTotpCode(secret, prev)).toBe(true);
    expect(verifyTotpCode(secret, next)).toBe(true);
  });

  test("rejects a code from 2 windows away", () => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const totp = new OTPAuth.TOTP({
      issuer: "Parachute Vault",
      label: "owner",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const farCode = totp.generate({ timestamp: Date.now() - 120_000 });
    expect(verifyTotpCode(secret, farCode)).toBe(false);
  });

  test("rejects replay of the same code within its window", () => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const totp = new OTPAuth.TOTP({
      issuer: "Parachute Vault",
      label: "owner",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const code = totp.generate();
    expect(verifyTotpCode(secret, code)).toBe(true);
    // Same code in same window — rejected
    expect(verifyTotpCode(secret, code)).toBe(false);
  });

  test("markUsed=false leaves the code available for re-verification", () => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const totp = new OTPAuth.TOTP({
      issuer: "Parachute Vault",
      label: "owner",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const code = totp.generate();
    expect(verifyTotpCode(secret, code, false)).toBe(true);
    expect(verifyTotpCode(secret, code, false)).toBe(true);
    // But once markUsed is the default, it's consumed.
    expect(verifyTotpCode(secret, code)).toBe(true);
    expect(verifyTotpCode(secret, code)).toBe(false);
  });

  test("rejects malformed codes", () => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    expect(verifyTotpCode(secret, "abc123")).toBe(false);
    expect(verifyTotpCode(secret, "12345")).toBe(false);
    expect(verifyTotpCode(secret, "1234567")).toBe(false);
    expect(verifyTotpCode(secret, "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

describe("enrollment lifecycle", () => {
  test("enroll generates secret + 6 backup codes and persists them", async () => {
    expect(hasTotpEnrolled()).toBe(false);
    const result = await enrollTotp();

    expect(result.secret).toMatch(/^[A-Z2-7]+$/);
    expect(result.otpauthUrl).toStartWith("otpauth://totp/");
    expect(result.backupCodes).toHaveLength(6);
    expect(new Set(result.backupCodes).size).toBe(6); // unique
    for (const c of result.backupCodes) {
      expect(c).toMatch(/^[a-z2-9]{8}$/);
    }

    expect(hasTotpEnrolled()).toBe(true);
    expect(getTotpSecret()).toBe(result.secret);
    expect(getBackupCodeCount()).toBe(6);
  });

  test("enroll is round-trippable via config reload", async () => {
    const result = await enrollTotp();
    // Force-reload from disk
    const fresh = readGlobalConfig();
    expect(fresh.totp_secret).toBe(result.secret);
    expect(fresh.backup_codes).toHaveLength(6);
  });

  test("disable removes secret and backup codes", async () => {
    await enrollTotp();
    disableTotp();
    expect(hasTotpEnrolled()).toBe(false);
    expect(getTotpSecret()).toBeNull();
    expect(getBackupCodeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------

describe("backup codes", () => {
  test("valid code verifies and is consumed", async () => {
    const result = await enrollTotp();
    const code = result.backupCodes[0];

    expect(await verifyAndConsumeBackupCode(code)).toBe(true);
    expect(getBackupCodeCount()).toBe(5);
    // Second use fails
    expect(await verifyAndConsumeBackupCode(code)).toBe(false);
    expect(getBackupCodeCount()).toBe(5);
  });

  test("invalid code does not consume any", async () => {
    await enrollTotp();
    expect(await verifyAndConsumeBackupCode("nope1234")).toBe(false);
    expect(getBackupCodeCount()).toBe(6);
  });

  test("case-insensitive / whitespace-tolerant", async () => {
    const result = await enrollTotp();
    const code = result.backupCodes[2];
    // Uppercase with spaces
    expect(await verifyAndConsumeBackupCode(`  ${code.toUpperCase()}  `)).toBe(true);
  });

  test("regenerate invalidates old codes", async () => {
    const result = await enrollTotp();
    const oldCode = result.backupCodes[0];
    const newCodes = await regenerateBackupCodes();
    expect(newCodes).toHaveLength(6);
    expect(getBackupCodeCount()).toBe(6);
    expect(await verifyAndConsumeBackupCode(oldCode)).toBe(false);
    expect(await verifyAndConsumeBackupCode(newCodes[0])).toBe(true);
  });

  test("concurrent consumption of the same code — only one wins", async () => {
    const result = await enrollTotp();
    const code = result.backupCodes[0];
    // Kick off two verify calls in parallel; serialization via the mutex
    // should prevent both from succeeding.
    const [a, b] = await Promise.all([
      verifyAndConsumeBackupCode(code),
      verifyAndConsumeBackupCode(code),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(getBackupCodeCount()).toBe(5);
  });

  test("concurrent consumption of distinct codes — both win", async () => {
    const result = await enrollTotp();
    const [a, b] = await Promise.all([
      verifyAndConsumeBackupCode(result.backupCodes[0]),
      verifyAndConsumeBackupCode(result.backupCodes[1]),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(getBackupCodeCount()).toBe(4);
  });

  test("all codes consumable exactly once", async () => {
    const result = await enrollTotp();
    for (const code of result.backupCodes) {
      expect(await verifyAndConsumeBackupCode(code)).toBe(true);
    }
    expect(getBackupCodeCount()).toBe(0);
  });
});
