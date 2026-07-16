/**
 * Tests for vault's scribe service-discovery (vault#353).
 *
 * Single decision site for "where does scribe live": env override, then
 * `~/.parachute/services.json`. The cache layer is exercised separately
 * so the resolution rule stays unit-testable without filesystem state.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { resolveScribeUrl, getCachedScribeUrl, clearScribeUrlCache } from "./scribe-discovery.ts";

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

describe("getCachedScribeUrl (vault contracts-brief V1.5 — TTL, not process-lifetime)", () => {
  // A manifest fn that counts calls, so tests can prove whether the cache
  // actually skipped a re-read (rather than just asserting the RESULT,
  // which would pass even if the cache silently didn't cache at all).
  function mkCountingManifest(port: number): { impl: typeof import("./services-manifest.ts").readManifest; calls: () => number } {
    let calls = 0;
    const impl = (() => {
      calls++;
      return {
        services: [
          { name: "parachute-scribe", port, paths: ["/parachute-scribe"], health: "/health", version: "0.0.0-test" },
        ],
      };
    }) as unknown as typeof import("./services-manifest.ts").readManifest;
    return { impl, calls: () => calls };
  }

  test("within the TTL window, repeated calls reuse the cached value (manifest read once)", () => {
    const env = {} as NodeJS.ProcessEnv;
    const { impl, calls } = mkCountingManifest(1943);
    let t = 1_000_000;
    const now = () => t;

    expect(getCachedScribeUrl(env, impl, console, now)).toBe("http://127.0.0.1:1943");
    t += 1_000; // well inside the 30s TTL
    expect(getCachedScribeUrl(env, impl, console, now)).toBe("http://127.0.0.1:1943");
    expect(calls()).toBe(1);
  });

  test("after the TTL expires, the next call re-resolves — a scribe that appeared mid-process is picked up without a restart", () => {
    const env = {} as NodeJS.ProcessEnv;
    // First manifest: no scribe registered yet.
    let manifestCalls = 0;
    let portToReturn: number | null = null;
    const impl = (() => {
      manifestCalls++;
      return {
        services: portToReturn === null
          ? []
          : [{ name: "parachute-scribe", port: portToReturn, paths: ["/parachute-scribe"], health: "/health", version: "0.0.0-test" }],
      };
    }) as unknown as typeof import("./services-manifest.ts").readManifest;
    let t = 1_000_000;
    const now = () => t;

    // Nothing registered yet — vault boots before scribe.
    expect(getCachedScribeUrl(env, impl, console, now)).toBeUndefined();

    // Scribe installs and registers itself mid-process — still within TTL,
    // so the stale "undefined" is what a caller sees (this is the bound the
    // TTL accepts, not the bug being fixed).
    portToReturn = 1943;
    t += 1_000;
    expect(getCachedScribeUrl(env, impl, console, now)).toBeUndefined();
    expect(manifestCalls).toBe(1); // still cached — didn't re-read

    // TTL elapses — next probe re-reads and picks up the now-live scribe,
    // with no vault restart in between.
    t += 30_000;
    expect(getCachedScribeUrl(env, impl, console, now)).toBe("http://127.0.0.1:1943");
    expect(manifestCalls).toBe(2);
  });

  test("clearScribeUrlCache forces a fresh resolve even within the TTL window", () => {
    const env = {} as NodeJS.ProcessEnv;
    const { impl, calls } = mkCountingManifest(1943);
    const now = () => 1_000_000;

    expect(getCachedScribeUrl(env, impl, console, now)).toBe("http://127.0.0.1:1943");
    clearScribeUrlCache();
    expect(getCachedScribeUrl(env, impl, console, now)).toBe("http://127.0.0.1:1943");
    expect(calls()).toBe(2);
  });
});
