/**
 * Env-var plumbing for the scribe integration (transcription worker + triggers).
 *
 * Lives in its own module so the boot-time token resolution in server.ts is
 * testable without running the rest of server.ts (which has side effects:
 * triggers, auto-init, Bun.serve). Keep this module pure and dependency-free.
 */

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
