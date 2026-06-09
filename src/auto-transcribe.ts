/**
 * Auto-transcribe trigger decision (vault#353, design 2026-05-21 Part 2).
 *
 * One pure function: given an attachment's mime-type + the operator's
 * settings + whether scribe is reachable, decide whether to enqueue the
 * attachment for the transcription worker. Lives in its own module so the
 * attachment-write code path (`routes.ts`) and the retry endpoint share the
 * same gate without duplicating logic.
 */

import { readGlobalConfig } from "./config.ts";
import { getCachedScribeUrl } from "./scribe-discovery.ts";

/**
 * Pre-vault#353 callers passed `transcribe: true` explicitly on the
 * attachment POST. The auto-transcribe path inlines the decision: if the
 * upload is an audio mime-type AND the toggle is on AND scribe is reachable,
 * the worker is enqueued. This function is the single decision site.
 *
 * Returns `true` only when ALL three conditions hold:
 *   1. mime-type starts with `audio/` (case-insensitive).
 *   2. The resolved auto-transcribe toggle is not `false`. Resolution is
 *      **per-vault → global → true**:
 *        - `perVaultEnabled` (the owning vault's own `auto_transcribe.enabled`)
 *          wins when set — this is what makes scribe's "link to vault X" affect
 *          only X, not the whole server.
 *        - else the server-wide `globalConfig.auto_transcribe?.enabled`.
 *        - else `true` (default ON — once scribe is reachable, audio
 *          transcribes without a separate config step). Operators who want it
 *          OFF set `auto_transcribe.enabled: false` explicitly (per-vault or
 *          globally).
 *      `enabledOverride`, when present, hard-overrides the whole chain (used
 *      by the explicit caller-opt-in path).
 *   3. Scribe is discoverable (services.json entry OR SCRIBE_URL env).
 *
 * The three conditions are independent guards: a single `false` is sufficient
 * to skip enqueuing. The audio stays as a regular attachment in that case.
 */
export function shouldAutoTranscribe(
  mimeType: string,
  opts: {
    /** Injection seam for tests — defaults to live globals. */
    readGlobalConfigImpl?: typeof readGlobalConfig;
    getCachedScribeUrlImpl?: () => string | undefined;
    /**
     * The owning vault's per-vault `auto_transcribe.enabled` (vault.yaml).
     * Takes precedence over the global toggle when set, so enabling/disabling
     * one vault doesn't move the rest. `undefined` (the vault left it unset)
     * falls through to the global toggle.
     */
    perVaultEnabled?: boolean;
    /**
     * Hard override of the entire per-vault→global→true chain. Used by the
     * explicit caller-opt-in path; not part of the normal precedence ladder.
     */
    enabledOverride?: boolean;
  } = {},
): boolean {
  if (typeof mimeType !== "string" || !mimeType.toLowerCase().startsWith("audio/")) {
    return false;
  }
  const enabled = opts.enabledOverride
    ?? opts.perVaultEnabled
    ?? (opts.readGlobalConfigImpl ?? readGlobalConfig)().auto_transcribe?.enabled
    ?? true;
  if (!enabled) return false;
  const url = (opts.getCachedScribeUrlImpl ?? getCachedScribeUrl)();
  if (!url || !url.trim()) return false;
  return true;
}
