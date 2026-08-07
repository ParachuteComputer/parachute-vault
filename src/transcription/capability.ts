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
import { ParakeetMlxProvider } from "./providers/parakeet-mlx.ts";
import { OnnxAsrProvider } from "./providers/onnx-asr.ts";
import { WhisperCppProvider } from "./providers/whisper-cpp.ts";
import { getCachedScribeUrl } from "../scribe-discovery.ts";
import { resolveScribeAuthToken } from "../scribe-env.ts";
import { findModel } from "./models.ts";
import { managedModelDir, resolveCliBinary, resolveFfmpeg } from "./resolve-binary.ts";
import { join } from "path";
import {
  resolveTranscriptionProviderName,
  resolveTranscriptionModelId,
  resolveTranscribeCppPaths,
  resolveParakeetMlxBin,
  resolveParakeetMlxModel,
  resolveOnnxAsrBin,
  resolveOnnxAsrModel,
} from "./select.ts";

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
 *   - `whisper-cpp` → the local whisper.cpp CLIs and the DEFAULT provider on a
 *     box with no reachable scribe. The model id decides which CLI
 *     (`parakeet-cli` / `whisper-cli`); `available()` is `false` until
 *     `transcription install` has put both a binary and the model in place.
 *   - `transcribe-cpp` → the local provider, resolving the installed binary +
 *     GGUF model paths; `available()` is `false` until `transcription install`
 *     has run.
 *   - `parakeet-mlx` / `onnx-asr` (scribe-fold Phase 2b) → the Python-based
 *     local providers, resolving the binary via env override → managed venv →
 *     PATH; `available()` is `false` until a runnable binary exists.
 *   - `scribe-http` (default) → the remote provider (URL from
 *     `SCRIBE_URL`/services.json, bearer from `SCRIBE_AUTH_TOKEN`). When scribe
 *     isn't discoverable the URL is undefined and it reports itself unavailable
 *     rather than throwing.
 */
export function defaultTranscriptionProvider(): TranscriptionProvider {
  const name = resolveTranscriptionProviderName();
  if (name === "whisper-cpp") {
    // Mirrors the worker's construction in `server.ts` so the capability flag
    // and the thing that actually transcribes agree. An unknown model id, a
    // missing binary or a missing model file all resolve to `undefined` here,
    // and `WhisperCppProvider.available()` reports not-ok for each — the flag
    // goes false without throwing, which is the landing's contract.
    const model = findModel(resolveTranscriptionModelId());
    return new WhisperCppProvider({
      binPath: model ? resolveCliBinary(model.engine) : undefined,
      engine: model?.engine ?? "whisper",
      modelPath: model ? join(managedModelDir(), model.filename) : undefined,
      ffmpegPath: resolveFfmpeg(),
    });
  }
  if (name === "transcribe-cpp") {
    const paths = resolveTranscribeCppPaths();
    return new TranscribeCppProvider({ binPath: paths.binPath, modelPath: paths.modelPath });
  }
  if (name === "parakeet-mlx") {
    return new ParakeetMlxProvider({
      binPath: resolveParakeetMlxBin(),
      model: resolveParakeetMlxModel(),
    });
  }
  if (name === "onnx-asr") {
    return new OnnxAsrProvider({
      binPath: resolveOnnxAsrBin(),
      model: resolveOnnxAsrModel(),
    });
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
