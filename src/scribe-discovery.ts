/**
 * Service discovery for the scribe transcription module.
 *
 * Per the 2026-05-21 vault↔scribe design (Part 2, design question 2), vault
 * locates scribe via `~/.parachute/services.json` — the canonical hub-
 * maintained registry. This module is the single read site so the
 * resolution rule lives in one place.
 *
 * Resolution order (first hit wins):
 *
 *   1. `SCRIBE_URL` env var (operator override; useful for tests, Docker
 *      compose, and any deploy where scribe runs at a non-loopback host).
 *   2. Entry `name === "parachute-scribe"` in `~/.parachute/services.json`
 *      → construct `http://127.0.0.1:<port>`.
 *   3. `undefined` (auto-transcribe stays a no-op).
 *
 * The bearer token resolution stays in `./scribe-env.ts:resolveScribeAuthToken`.
 * Service discovery is just about WHERE scribe lives; AUTH is a separate
 * concern with its own env-var precedence (SCRIBE_AUTH_TOKEN over the legacy
 * SCRIBE_TOKEN). When the v0.7 hub-issued-JWT path lands, the bearer source
 * changes but the URL source stays the same — one file, one concern.
 *
 * v0.6 deploy is single-container (hub-as-supervisor) so loopback is fine.
 * v0.7 cloud-multi-container will grow an `origin` field on the services.json
 * entry; this resolver will honor it without API changes — `port` becomes
 * a fallback when `origin` isn't set, no breaking change for v0.6 callers.
 */

import { readManifest, ServicesManifestError } from "./services-manifest.ts";

/**
 * Resolve the scribe base URL (no trailing slash) by consulting the env-var
 * override first, then services.json. Returns `undefined` when scribe isn't
 * configured — callers MUST treat that as "auto-transcribe disabled."
 *
 * The `env` + `readManifestImpl` parameters are injection seams for tests;
 * production callers omit them and pick up `process.env` + the real
 * `~/.parachute/services.json`.
 */
export function resolveScribeUrl(
  env: NodeJS.ProcessEnv = process.env,
  readManifestImpl: typeof readManifest = readManifest,
  logger: { warn?: (...args: unknown[]) => void } = console,
): string | undefined {
  const override = env.SCRIBE_URL?.trim();
  if (override) return override.replace(/\/$/, "");

  let manifest;
  try {
    manifest = readManifestImpl();
  } catch (err) {
    if (err instanceof ServicesManifestError) {
      logger.warn?.(`[scribe-discovery] services.json unreadable: ${err.message}`);
    } else {
      logger.warn?.(`[scribe-discovery] services.json read failed: ${err}`);
    }
    return undefined;
  }
  const entry = manifest.services.find((s) => s.name === "parachute-scribe");
  if (!entry) return undefined;
  // v0.6 loopback shape; v0.7 will add an explicit `origin` field on the
  // service entry which wins over loopback when present.
  const origin = (entry as { origin?: string }).origin;
  if (typeof origin === "string" && origin.trim()) {
    return origin.trim().replace(/\/$/, "");
  }
  return `http://127.0.0.1:${entry.port}`;
}

/**
 * Process-lifetime cache. Computed at first call (typically during server
 * boot), reused for every subsequent transcription request. Operators who
 * change the scribe URL via `services.json` (re-install of scribe with a
 * different port) need to restart vault; we deliberately don't watch the
 * file because the v0.6 deploy model has a single restart-on-change story.
 *
 * Tests should pass an explicit `env` + `readManifestImpl` to `resolveScribeUrl`
 * directly to bypass the cache.
 */
let cachedScribeUrl: string | undefined | null = null;

export function getCachedScribeUrl(): string | undefined {
  if (cachedScribeUrl === null) {
    cachedScribeUrl = resolveScribeUrl();
  }
  return cachedScribeUrl;
}

export function clearScribeUrlCache(): void {
  cachedScribeUrl = null;
}
