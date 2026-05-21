import { describe, test, expect } from "bun:test";
import { resolveScribeAuthToken, generateScribeBearer, ensureScribeBearer } from "./scribe-env.ts";

function captureWarn() {
  const calls: unknown[][] = [];
  return { logger: { warn: (...args: unknown[]) => calls.push(args) }, calls };
}

describe("resolveScribeAuthToken", () => {
  test("returns SCRIBE_AUTH_TOKEN when set (canonical)", () => {
    const { logger, calls } = captureWarn();
    const token = resolveScribeAuthToken(
      { SCRIBE_AUTH_TOKEN: "canonical-v1" } as NodeJS.ProcessEnv,
      logger,
    );
    expect(token).toBe("canonical-v1");
    // Canonical path is silent — no deprecation warning.
    expect(calls.length).toBe(0);
  });

  test("prefers canonical over legacy when both set", () => {
    const { logger, calls } = captureWarn();
    const token = resolveScribeAuthToken(
      { SCRIBE_AUTH_TOKEN: "new", SCRIBE_TOKEN: "old" } as NodeJS.ProcessEnv,
      logger,
    );
    expect(token).toBe("new");
    expect(calls.length).toBe(0);
  });

  test("falls back to SCRIBE_TOKEN with deprecation warning", () => {
    const { logger, calls } = captureWarn();
    const token = resolveScribeAuthToken(
      { SCRIBE_TOKEN: "legacy-v0" } as NodeJS.ProcessEnv,
      logger,
    );
    expect(token).toBe("legacy-v0");
    expect(calls.length).toBe(1);
    expect(String(calls[0][0])).toContain("SCRIBE_TOKEN is deprecated");
    expect(String(calls[0][0])).toContain("SCRIBE_AUTH_TOKEN");
  });

  test("returns undefined when neither is set (loopback back-compat)", () => {
    const { logger, calls } = captureWarn();
    const token = resolveScribeAuthToken({} as NodeJS.ProcessEnv, logger);
    expect(token).toBeUndefined();
    expect(calls.length).toBe(0);
  });
});

describe("generateScribeBearer (vault#353)", () => {
  test("returns 32-byte base64url string (~43 chars, no padding)", () => {
    const bearer = generateScribeBearer();
    // 32 bytes base64url-encoded = 43 chars (no `=` padding in base64url).
    expect(bearer.length).toBe(43);
    expect(bearer).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("each call yields a unique value", () => {
    const a = generateScribeBearer();
    const b = generateScribeBearer();
    expect(a).not.toBe(b);
  });
});

describe("ensureScribeBearer (vault#353)", () => {
  test("generates + persists a bearer when neither env var is set", () => {
    const env: Record<string, string> = {};
    const writes: Array<[string, string]> = [];
    const { created, token } = ensureScribeBearer(
      () => ({ ...env }),
      (k, v) => writes.push([k, v]),
    );
    expect(created).toBe(true);
    expect(token.length).toBe(43);
    expect(writes).toEqual([["SCRIBE_AUTH_TOKEN", token]]);
  });

  test("preserves existing SCRIBE_AUTH_TOKEN (idempotent)", () => {
    const env: Record<string, string> = { SCRIBE_AUTH_TOKEN: "already-set" };
    const writes: Array<[string, string]> = [];
    const { created, token } = ensureScribeBearer(
      () => ({ ...env }),
      (k, v) => writes.push([k, v]),
    );
    expect(created).toBe(false);
    expect(token).toBe("already-set");
    expect(writes.length).toBe(0);
  });

  test("preserves legacy SCRIBE_TOKEN without rewriting it", () => {
    const env: Record<string, string> = { SCRIBE_TOKEN: "legacy" };
    const writes: Array<[string, string]> = [];
    const { created, token } = ensureScribeBearer(
      () => ({ ...env }),
      (k, v) => writes.push([k, v]),
    );
    expect(created).toBe(false);
    expect(token).toBe("legacy");
    expect(writes.length).toBe(0);
  });

  test("treats whitespace-only env value as unset (generates fresh)", () => {
    const env: Record<string, string> = { SCRIBE_AUTH_TOKEN: "   " };
    const writes: Array<[string, string]> = [];
    const { created, token } = ensureScribeBearer(
      () => ({ ...env }),
      (k, v) => writes.push([k, v]),
    );
    expect(created).toBe(true);
    expect(token.length).toBe(43);
    expect(writes[0]?.[0]).toBe("SCRIBE_AUTH_TOKEN");
  });
});
