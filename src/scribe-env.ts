/**
 * Env-var plumbing for the scribe integration (transcription worker + triggers).
 *
 * Lives in its own module so the boot-time token resolution in server.ts is
 * testable without running the rest of server.ts (which has side effects:
 * triggers, auto-init, Bun.serve). Keep this module pure and dependency-free
 * (except for the `node:crypto` import used by bearer generation).
 */

import { randomBytes } from "node:crypto";

/**
 * Resolve the scribe auth token. `SCRIBE_AUTH_TOKEN` is the canonical name
 * (matches the CLI's install-time auto-wire); `SCRIBE_TOKEN` is a legacy alias
 * kept for one release — when only the legacy name is set, we warn once so
 * users notice and rename.
 *
 * Returns `undefined` when neither is set; callers must treat that as "no
 * Authorization header" (back-compat with loopback-trust deployments).
 */
export function resolveScribeAuthToken(
  env: NodeJS.ProcessEnv = process.env,
  logger: { warn: (...args: unknown[]) => void } = console,
): string | undefined {
  const canonical = env.SCRIBE_AUTH_TOKEN;
  if (canonical) return canonical;
  const legacy = env.SCRIBE_TOKEN;
  if (legacy) {
    logger.warn(
      "[transcribe] SCRIBE_TOKEN is deprecated; rename to SCRIBE_AUTH_TOKEN. " +
      "The legacy name will stop being read in the next release.",
    );
    return legacy;
  }
  return undefined;
}

/**
 * Generate a fresh shared bearer for the vault↔scribe loopback contract
 * (design 2026-05-21 Part 2, design question 2). 32 random bytes → base64url
 * encoded. The operator (or hub install) writes the result into vault's
 * `~/.parachute/vault/.env` as `SCRIBE_AUTH_TOKEN` AND into scribe's config
 * (via env propagation or the scribe admin endpoint).
 *
 * Generation is callable as a pure function so install code, tests, and any
 * future "rotate scribe bearer" admin endpoint share the same length +
 * encoding without copy-paste.
 */
export function generateScribeBearer(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Ensure a scribe bearer exists in the vault .env. Idempotent: if a value
 * (canonical or legacy) is already set, returns `{ created: false, token: ... }`
 * without touching the file. Otherwise generates a fresh bearer, persists it
 * to the .env via the provided writer, and returns `{ created: true, token }`.
 *
 * The `envReader` + `envWriter` parameters are injection seams for tests; the
 * production caller (`cli.ts` init flow) passes `readEnvFile` + `setEnvVar`.
 */
export function ensureScribeBearer(
  envReader: () => Record<string, string>,
  envWriter: (key: string, value: string) => void,
): { created: boolean; token: string } {
  const env = envReader();
  const existing = env.SCRIBE_AUTH_TOKEN ?? env.SCRIBE_TOKEN;
  if (existing && existing.trim()) {
    return { created: false, token: existing };
  }
  const token = generateScribeBearer();
  envWriter("SCRIBE_AUTH_TOKEN", token);
  return { created: true, token };
}
