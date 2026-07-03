/**
 * Transcription capability flag (scribe-fold Phase 1).
 *
 * The vault landing (`GET /vault/<name>/api/vault`) surfaces a `transcription`
 * capability so a surface (Notes) can gate its microphone affordance on
 * whether transcription is actually possible — distinct from the
 * `auto_transcribe.enabled` POLICY toggle (which defaults on even when no
 * provider is reachable). `enabled` is true only when a provider is configured
 * AND its `available()` probe passes.
 *
 * `minutes_remaining` is deliberately omitted: it's a cloud/plan concern, and
 * self-host is unmetered. The cloud voice build, whose Workers-AI provider
 * implements the same `TranscriptionProvider` interface, will add metering at
 * that layer.
 */

import type { TranscriptionProvider } from "../../core/src/transcription/provider.ts";
import { ScribeHttpProvider } from "./providers/scribe-http.ts";
import { TranscribeCppProvider } from "./providers/transcribe-cpp.ts";
import { getCachedScribeUrl } from "../scribe-discovery.ts";
import { resolveScribeAuthToken } from "../scribe-env.ts";
import { resolveTranscriptionProviderName, resolveTranscribeCppPaths } from "./select.ts";

export interface TranscriptionCapability {
  /** True when a provider is configured AND available. Notes gates the mic on this. */
  enabled: boolean;
  /** The active provider's name (e.g. "scribe-http"). Omitted when disabled. */
  provider?: string;
}

/**
 * Build the default provider from live per-process config, honoring
 * `TRANSCRIPTION_PROVIDER` (scribe-fold Phase 2a) so the capability flag
 * reflects whichever provider is actually configured:
 *
 *   - `transcribe-cpp` → the local provider, resolving the installed binary +
 *     GGUF model paths; `available()` is `false` until `transcription install`
 *     has run.
 *   - `scribe-http` (default) → the remote provider (URL from
 *     `SCRIBE_URL`/services.json, bearer from `SCRIBE_AUTH_TOKEN`). When scribe
 *     isn't discoverable the URL is undefined and it reports itself unavailable
 *     rather than throwing.
 */
export function defaultTranscriptionProvider(): TranscriptionProvider {
  if (resolveTranscriptionProviderName() === "transcribe-cpp") {
    const paths = resolveTranscribeCppPaths();
    return new TranscribeCppProvider({ binPath: paths.binPath, modelPath: paths.modelPath });
  }
  return new ScribeHttpProvider({
    url: getCachedScribeUrl(),
    token: resolveScribeAuthToken(),
  });
}

/**
 * Resolve the transcription capability for the vault landing. `enabled` is the
 * provider's `available()` result; `provider` is its name when enabled. A
 * "no provider configured" deployment resolves cleanly to `{ enabled: false }`
 * (no throw), so the landing never crashes when scribe is absent.
 *
 * The `provider` arg is an injection seam for tests + a future explicit
 * provider selection; production omits it and uses the default scribe-http
 * provider built from live config.
 */
export async function resolveTranscriptionCapability(
  provider: TranscriptionProvider = defaultTranscriptionProvider(),
): Promise<TranscriptionCapability> {
  const avail = await provider.available();
  if (!avail.ok) return { enabled: false };
  return { enabled: true, provider: provider.name };
}
