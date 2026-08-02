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
import { buildTranscriptionSnapshot } from "./transcription-routes.ts";

/**
 * The name of a local provider that is INSTALLED on this box, or null.
 *
 * Delegates to the same snapshot `transcription status` and the admin SPA
 * answer from, so these surfaces share one implementation and cannot drift.
 *
 * Keyed on `binary.path`, deliberately, NOT on `snap.ready`. Readiness also
 * demands ffmpeg, so it varies box to box in a way this message shouldn't: a
 * machine with the provider installed but ffmpeg missing is still a machine
 * where "no transcription provider configured — set TRANSCRIPTION_PROVIDER to
 * a local provider" is false. `installed` answers the question the sentence
 * actually asks, and answers it the same way everywhere.
 * (Caught by running the real probe rather than the injected one — the unit
 * tests inject `localProviderImpl` and would never have shown the difference.)
 *
 * Errors swallow to null: a broken probe must degrade to the old, flat message,
 * never take down an attachment upload.
 */
function installedLocalProvider(): string | null {
  try {
    const snap = buildTranscriptionSnapshot();
    if (snap.provider === "scribe-http") return null;
    return snap.binary.path ? snap.provider : null;
  } catch {
    return null;
  }
}

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
  return classifyAutoTranscribe(mimeType, opts).kind === "transcribe";
}

/**
 * Why an audio attachment is (or isn't) being transcribed. The three outcomes
 * are NOT interchangeable, which is the whole point of this type:
 *
 *   - `transcribe`  — enqueue it.
 *   - `disabled`    — the operator turned auto-transcribe off. Silence is
 *                     correct: they asked for nothing to happen.
 *   - `unavailable` — auto-transcribe is ON, but no provider is reachable.
 *                     This is a MISCONFIGURATION, and silence is wrong.
 *
 * vault#643: `shouldAutoTranscribe` collapsed the last two into `false`, so a
 * box with transcription enabled and no reachable provider accepted audio,
 * transcribed nothing, wrote no marker, logged nothing, and left an attachment
 * indistinguishable from a plain upload. Observed on a fresh install: the
 * provider resolves to `scribe-http` by default, nothing sets `SCRIBE_URL`, and
 * voice memos silently never transcribe.
 *
 * The hosted door already gets this right — `workers/vault/src/vault-do.ts`
 * marks a terminal state ("voice not enabled for this plan", "monthly voice
 * limit reached") rather than skipping quietly, precisely so the operator never
 * faces an eternal spinner. This brings self-host to the same posture.
 */
export type AutoTranscribeDecision =
  | { kind: "transcribe" }
  | { kind: "not-audio" }
  | { kind: "disabled" }
  /**
   * `localProvider` names a local provider INSTALLED on this box (its binary
   * resolves), or null when there is nothing local here.
   *
   * Installation, deliberately, and not the configured provider NAME. The name
   * is a trap: `resolveTranscriptionProviderName` returns `whisper-cpp` on a
   * box where nothing at all is set up, because that is the default when no
   * scribe URL resolves. Keying the message off the name would tell a
   * fresh-install operator their whisper-cpp install is present when they have
   * never installed one — trading one false sentence for another.
   *
   * It does NOT change the decision: `unavailable` is `unavailable` either way,
   * because this path resolves a scribe URL and nothing else. It exists purely
   * so the error can be true. See `noProviderErrorFor`.
   */
  | { kind: "unavailable"; localProvider: string | null };

/** The full decision behind `shouldAutoTranscribe`. Same inputs, more answer. */
export function classifyAutoTranscribe(
  mimeType: string,
  opts: {
    readGlobalConfigImpl?: typeof readGlobalConfig;
    getCachedScribeUrlImpl?: () => string | undefined;
    perVaultEnabled?: boolean;
    enabledOverride?: boolean;
    /**
     * Injectable, same shape as the two impls above. Returns the name of a
     * local provider installed here, or null. Defaults to the shared
     * transcription snapshot.
     */
    localProviderImpl?: () => string | null;
  } = {},
): AutoTranscribeDecision {
  if (typeof mimeType !== "string" || !mimeType.toLowerCase().startsWith("audio/")) {
    return { kind: "not-audio" };
  }
  const enabled = opts.enabledOverride
    ?? opts.perVaultEnabled
    ?? (opts.readGlobalConfigImpl ?? readGlobalConfig)().auto_transcribe?.enabled
    ?? true;
  if (!enabled) return { kind: "disabled" };
  const url = (opts.getCachedScribeUrlImpl ?? getCachedScribeUrl)();
  if (!url || !url.trim()) {
    // Still unavailable — this path reads a scribe URL and nothing else, and
    // that is deliberately unchanged here. We only ask whether something local
    // would run, so the message can name the real situation instead of telling
    // an operator to do what they have already done.
    return {
      kind: "unavailable",
      localProvider: (opts.localProviderImpl ?? installedLocalProvider)(),
    };
  }
  return { kind: "transcribe" };
}

/**
 * The `transcribe_error` written when auto-transcribe is on but no provider is
 * reachable AND nothing local is configured. Deliberately actionable — the
 * operator needs to know which of the two things to do, not just that something
 * went wrong.
 *
 * Correct only when the resolved provider is `scribe-http`. On a box that HAS a
 * local provider this sentence is false in the most expensive way — see
 * `noProviderErrorFor`.
 */
export const NO_PROVIDER_ERROR =
  "no transcription provider configured — set TRANSCRIPTION_PROVIDER to a local " +
  "provider (see `parachute-vault transcription install`), or point SCRIBE_URL at " +
  "a transcription service";

/**
 * The `transcribe_error` for an `unavailable` decision, told truthfully.
 *
 * Found live: a box with `TRANSCRIPTION_PROVIDER=whisper-cpp`, `parakeet-cli` on
 * PATH, the model downloaded, and `[transcribe] worker started → whisper-cpp` in
 * the same boot was writing `NO_PROVIDER_ERROR` onto its attachments — telling
 * the operator to set the variable they had set and install the provider that
 * was already running. Same failure mode as the `transcription status` bug
 * (#643): a diagnostic that lies during the exact task it exists for, and this
 * one sends someone to re-download a 400 MB model to fix nothing.
 *
 * The asymmetry is real and worth naming in the message rather than hiding:
 * `server.ts` starts a local worker with no scribe URL anywhere in the branch,
 * but this path resolves ONLY a scribe URL. So a local provider genuinely does
 * serve explicit `transcribe: true` requests while genuinely being invisible
 * here. An operator who is not told that will reasonably conclude their install
 * is broken.
 *
 * Deliberately NOT a fix for the asymmetry itself — teaching this path to see
 * local providers changes what gets transcribed, which is a behaviour question
 * and not this diff's to answer.
 */
export function noProviderErrorFor(localProvider: string | null): string {
  if (!localProvider) return NO_PROVIDER_ERROR;
  return (
    `auto-transcribe found no reachable provider: it resolves only a scribe URL ` +
    `(SCRIBE_URL, or a \`parachute-scribe\` entry in services.json), and neither is set. ` +
    `A local ${localProvider} install IS present here and explicit transcription requests ` +
    `are routed to it — this path does not consult it. Reinstalling ${localProvider} will ` +
    `not change this. To auto-transcribe uploads, point SCRIBE_URL at a transcription ` +
    `service; otherwise request transcription explicitly on the attachment. ` +
    `\`parachute-vault transcription status\` reports the local install's own state.`
  );
}

/** Throttle for {@link warnNoTranscriptionProvider}. */
const NO_PROVIDER_WARN_INTERVAL_MS = 60_000;
let lastNoProviderWarnAt = 0;

/**
 * Warn (at most once a minute) that audio is arriving with nowhere to send it.
 *
 * Throttled because it fires per-upload: a bulk import of a hundred voice
 * memos should produce one actionable line, not a hundred. Silence was the old
 * behaviour and it is what made this invisible — a box can accept audio for
 * months and never say that transcription isn't wired up.
 */
export function warnNoTranscriptionProvider(now: () => number = Date.now): void {
  const t = now();
  if (t - lastNoProviderWarnAt < NO_PROVIDER_WARN_INTERVAL_MS) return;
  lastNoProviderWarnAt = t;
  console.warn(`[transcribe] audio attachment accepted but ${NO_PROVIDER_ERROR}.`);
}

/** Test seam: forget the throttle window. */
export function _resetNoProviderWarnForTest(): void {
  lastNoProviderWarnAt = 0;
}
