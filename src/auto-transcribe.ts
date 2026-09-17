/** Automatic uploads follow the selected, wired transcription worker (#751). */
import { readGlobalConfig } from "./config.ts";
import { buildTranscriptionSnapshot } from "./transcription-routes.ts";
import { getTranscriptionWorkerProvider } from "./transcription-registry.ts";

type ProviderState = { ready: boolean; localProvider: string | null };
function providerState(): ProviderState {
  try {
    const snapshot = buildTranscriptionSnapshot();
    return {
      ready: snapshot.active && snapshot.ready &&
        getTranscriptionWorkerProvider() === snapshot.provider,
      // The snapshot's binary field describes whisper.cpp tools, not every
      // provider. Do not use it to claim a Python/transcribe-cpp install exists.
      localProvider: snapshot.provider === "whisper-cpp" && snapshot.binary.path
        ? snapshot.provider : null,
    };
  } catch {
    // A failed readiness probe must not break attachment upload.
    return { ready: false, localProvider: null };
  }
}
type AutoTranscribeOptions = {
  readGlobalConfigImpl?: typeof readGlobalConfig;
  /** Test seam; production uses the registered worker and shared status probe. */
  providerStateImpl?: () => ProviderState;
  /** Per-vault → global → true; explicit caller overrides still win. */
  perVaultEnabled?: boolean;
  enabledOverride?: boolean;
};
export type AutoTranscribeDecision =
  | { kind: "transcribe" }
  | { kind: "not-audio" }
  | { kind: "disabled" }
  | { kind: "unavailable"; localProvider: string | null };

export function classifyAutoTranscribe(
  mimeType: string,
  opts: AutoTranscribeOptions = {},
): AutoTranscribeDecision {
  if (typeof mimeType !== "string" || !mimeType.toLowerCase().startsWith("audio/")) {
    return { kind: "not-audio" };
  }
  const enabled = opts.enabledOverride ?? opts.perVaultEnabled ??
    (opts.readGlobalConfigImpl ?? readGlobalConfig)().auto_transcribe?.enabled ?? true;
  if (!enabled) return { kind: "disabled" };
  const state = (opts.providerStateImpl ?? providerState)();
  return state.ready
    ? { kind: "transcribe" }
    : { kind: "unavailable", localProvider: state.localProvider };
}
export function shouldAutoTranscribe(mimeType: string, opts: AutoTranscribeOptions = {}): boolean {
  return classifyAutoTranscribe(mimeType, opts).kind === "transcribe";
}
export const NO_PROVIDER_ERROR =
  "no transcription provider configured or ready — check `parachute-vault transcription status` " +
  "and TRANSCRIPTION_PROVIDER. For local transcription use `parachute-vault transcription install`. " +
  "For an explicitly selected legacy remote provider, check its SCRIBE_URL and worker status. " +
  "The standalone Scribe service is retired.";
export function noProviderErrorFor(localProvider: string | null): string {
  if (!localProvider) return NO_PROVIDER_ERROR;
  return `auto-transcribe is unavailable: a local ${localProvider} binary is installed, ` +
    "but the selected worker is not active and ready. Check `parachute-vault transcription status` " +
    "for missing model/runtime dependencies or a required server restart. " +
    "A binary alone does not establish readiness; reinstalling it is not necessarily the fix.";
}
const NO_PROVIDER_WARN_INTERVAL_MS = 60_000;
let lastNoProviderWarnAt = 0;
export function warnNoTranscriptionProvider(now: () => number = Date.now): void {
  const t = now();
  if (t - lastNoProviderWarnAt < NO_PROVIDER_WARN_INTERVAL_MS) return;
  lastNoProviderWarnAt = t;
  console.warn(`[transcribe] audio attachment accepted but ${NO_PROVIDER_ERROR}`);
}
export function _resetNoProviderWarnForTest(): void { lastNoProviderWarnAt = 0; }
