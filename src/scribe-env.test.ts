import { describe, test, expect } from "bun:test";
import { resolveScribeAuthToken } from "./scribe-env.ts";

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
