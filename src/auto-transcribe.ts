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
 *   2. `globalConfig.auto_transcribe?.enabled === true`.
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
    /** Allow per-call enabled override — used by the explicit-opt-in path. */
    enabledOverride?: boolean;
  } = {},
): boolean {
  if (typeof mimeType !== "string" || !mimeType.toLowerCase().startsWith("audio/")) {
    return false;
  }
  const enabled = opts.enabledOverride
    ?? (opts.readGlobalConfigImpl ?? readGlobalConfig)().auto_transcribe?.enabled
    ?? false;
  if (!enabled) return false;
  const url = (opts.getCachedScribeUrlImpl ?? getCachedScribeUrl)();
  if (!url || !url.trim()) return false;
  return true;
}
