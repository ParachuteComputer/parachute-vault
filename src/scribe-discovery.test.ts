/**
 * Tests for vault's scribe service-discovery (vault#353).
 *
 * Single decision site for "where does scribe live": env override, then
 * `~/.parachute/services.json`. The cache layer is exercised separately
 * so the resolution rule stays unit-testable without filesystem state.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { resolveScribeUrl, clearScribeUrlCache } from "./scribe-discovery.ts";

function mkManifest(services: Array<{ name: string; port: number; origin?: string }>): typeof import("./services-manifest.ts").readManifest {
  return () => ({
    services: services.map((s) => ({
      name: s.name,
      port: s.port,
      paths: [`/${s.name}`],
      health: "/health",
      version: "0.0.0-test",
      ...(s.origin ? { origin: s.origin } : {}),
    })) as any,
  });
}

beforeEach(() => {
  clearScribeUrlCache();
});

describe("resolveScribeUrl", () => {
  test("returns SCRIBE_URL env var (overrides services.json)", () => {
    const env = { SCRIBE_URL: "http://example.test:9999" } as NodeJS.ProcessEnv;
    const manifest = mkManifest([{ name: "parachute-scribe", port: 1943 }]);
    expect(resolveScribeUrl(env, manifest)).toBe("http://example.test:9999");
  });

  test("strips trailing slash from SCRIBE_URL env var", () => {
    const env = { SCRIBE_URL: "http://example.test:9999/" } as NodeJS.ProcessEnv;
    const manifest = mkManifest([]);
    expect(resolveScribeUrl(env, manifest)).toBe("http://example.test:9999");
  });

  test("falls back to services.json parachute-scribe entry", () => {
    const env = {} as NodeJS.ProcessEnv;
    const manifest = mkManifest([{ name: "parachute-scribe", port: 1943 }]);
    expect(resolveScribeUrl(env, manifest)).toBe("http://127.0.0.1:1943");
  });

  test("honors explicit `origin` on the service entry (v0.7 shape)", () => {
    const env = {} as NodeJS.ProcessEnv;
    const manifest = mkManifest([
      { name: "parachute-scribe", port: 1943, origin: "https://scribe.cloud.example.com" },
    ]);
    expect(resolveScribeUrl(env, manifest)).toBe("https://scribe.cloud.example.com");
  });

  test("returns undefined when no env override AND no scribe entry", () => {
    const env = {} as NodeJS.ProcessEnv;
    const manifest = mkManifest([{ name: "parachute-vault", port: 1940 }]);
    expect(resolveScribeUrl(env, manifest)).toBeUndefined();
  });

  test("returns undefined when manifest read throws", () => {
    const env = {} as NodeJS.ProcessEnv;
    const calls: unknown[][] = [];
    const logger = { warn: (...args: unknown[]) => calls.push(args) };
    const manifest = (() => { throw new Error("boom"); }) as unknown as Parameters<typeof resolveScribeUrl>[1];
    expect(resolveScribeUrl(env, manifest, logger)).toBeUndefined();
    expect(calls.length).toBe(1);
  });

  test("trims whitespace-only SCRIBE_URL as unset", () => {
    const env = { SCRIBE_URL: "   " } as NodeJS.ProcessEnv;
    const manifest = mkManifest([{ name: "parachute-scribe", port: 1943 }]);
    // Whitespace-only env falls through to services.json.
    expect(resolveScribeUrl(env, manifest)).toBe("http://127.0.0.1:1943");
  });
});
