/**
 * `onnx-asr` — the local Linux-tier transcription provider
 * (scribe-fold Phase 2b).
 *
 * Turns audio into text by subprocessing the `onnx-asr` CLI
 * (github.com/istupakov/onnx-asr — ONNX Runtime ASR, CPU-friendly). Ported
 * from scribe's proven `src/transcribe/onnx-asr.ts`; structurally a sibling
 * of the `transcribe-cpp` provider (same SpawnRunner seam, same
 * terminal-vs-retriable error contract). The ratified default model is
 * `nemo-parakeet-tdt-0.6b-v3` (int8 ONNX, ~670MB, fetched into the HF cache
 * on first use / warm-pulled at install).
 *
 * ## The audio path
 *
 * onnx-asr only accepts WAV, so we ALWAYS transcode through
 * `ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le` first. (Scribe passed a `.wav`
 * input straight through; we transcode even those — the transcribe-cpp
 * live-verify taught us an incoming WAV's sample rate can't be trusted, and
 * re-encoding a WAV is harmless.) Then:
 *
 *   onnx-asr <model> --vad silero <wav>
 *
 * `--vad silero` chunks audio longer than Parakeet's ~20s context window —
 * required for meeting-length audio (scribe's proven flag).
 *
 * ## Reading the output
 *
 * With `--vad`, stdout is timestamped lines like `[  0.0,  3.2]: text`; we
 * strip the timestamps and join. Untimestamped output (short clips / future
 * CLI changes) passes through unchanged. See `parseOnnxAsrOutput`.
 *
 * ## Error mapping (mirrors transcribe-cpp)
 *
 *   - binary not installed → non-retriable `missing_provider` (never spawns).
 *   - ffmpeg not found (127) → non-retriable `ffmpeg_missing`.
 *   - ffmpeg transcode non-zero exit → non-retriable `transcode_failed`.
 *   - `onnx-asr` launch failure (127) → non-retriable `missing_provider`.
 *   - `onnx-asr` non-zero exit → RETRIABLE `onnx_asr_error`.
 *   - empty stdout → plain `Error` (retriable via the worker).
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  TranscriptionError,
  type TranscriptionProvider,
  type TranscribeInput,
  type TranscribeResult,
  type ProviderAvailability,
} from "../../../core/src/transcription/provider.ts";
import { defaultSpawnRunner, type SpawnRunner } from "./transcribe-cpp.ts";
import { DEFAULT_ONNX_ASR_MODEL } from "../select.ts";

/** First-use model download + CPU inference can be slow; generous default. */
const DEFAULT_TIMEOUT_MS = 600_000;

export interface OnnxAsrProviderOpts {
  /** Path to the `onnx-asr` binary. Undefined ⇒ unavailable + terminal. */
  binPath?: string;
  /** onnx-asr model id (default: the ratified parakeet-tdt-0.6b-v3). */
  model?: string;
  /** ffmpeg binary (default "ffmpeg"; resolved on PATH). */
  ffmpegPath?: string;
  /** Per-transcription timeout (ms). Default 600s. */
  timeoutMs?: number;
  /** Subprocess runner (tests inject a mock). Default `defaultSpawnRunner`. */
  spawn?: SpawnRunner;
  /** Existence probe (tests inject). Default `fs.existsSync`. */
  existsImpl?: (p: string) => boolean;
  /** Scratch dir for the temp audio/wav files. Default `os.tmpdir()`. */
  tmpDir?: string;
}

/**
 * Build the `onnx-asr` argv. Scribe's proven invocation:
 *   `onnx-asr <model> --vad silero <wav>`
 * Exported so a test pins the shape.
 */
export function buildOnnxAsrArgs(binPath: string, model: string, wavPath: string): string[] {
  return [binPath, model, "--vad", "silero", wavPath];
}

/**
 * Build the ffmpeg transcode argv → 16kHz mono PCM-s16le WAV (onnx-asr's
 * input contract; `pcm_s16le` is scribe's proven codec pick). Exported for
 * tests.
 */
export function buildOnnxFfmpegArgs(
  ffmpegPath: string,
  inputPath: string,
  wavPath: string,
): string[] {
  return [
    ffmpegPath,
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ];
}

/**
 * Extract the transcript from onnx-asr's stdout. With `--vad silero` the
 * output is timestamped lines (`[  0.0,  3.2]: text`); we strip the
 * timestamp prefix per line and join with spaces. Lines without the prefix
 * pass through unchanged, so untimestamped output (short clips) still parses.
 * Returns "" for empty/blank stdout. Exported for tests.
 */
export function parseOnnxAsrOutput(stdout: string): string {
  const lines = stdout
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  return lines
    .map((l) => l.replace(/^\[\s*[\d.]+,\s*[\d.]+\]:\s*/, "").trim())
    .filter((l) => l.length > 0)
    .join(" ")
    .trim();
}

export class OnnxAsrProvider implements TranscriptionProvider {
  readonly name = "onnx-asr";

  private readonly binPath: string | undefined;
  private readonly model: string;
  private readonly ffmpegPath: string;
  private readonly timeoutMs: number;
  private readonly spawn: SpawnRunner;
  private readonly existsImpl: (p: string) => boolean;
  private readonly tmpDir: string;
  /** Once available, stays available for this process — avoids re-statting. */
  private cachedAvailable = false;

  constructor(opts: OnnxAsrProviderOpts = {}) {
    this.binPath = opts.binPath;
    this.model = opts.model ?? DEFAULT_ONNX_ASR_MODEL;
    this.ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawn = opts.spawn ?? defaultSpawnRunner;
    this.existsImpl = opts.existsImpl ?? existsSync;
    this.tmpDir = opts.tmpDir ?? tmpdir();
  }

  /**
   * Cheap readiness probe — a runnable `onnx-asr` binary on disk. NEVER
   * spawns. The MODEL is not checked (HF cache, downloads on first use), so
   * binary presence is the honest cheap signal. Memoizes the once-true result.
   */
  async available(): Promise<ProviderAvailability> {
    if (this.cachedAvailable) return { ok: true };
    if (!this.binPath || !this.existsImpl(this.binPath)) {
      return {
        ok: false,
        reason:
          "onnx-asr is not installed (run `parachute-vault transcription install`, or set ONNX_ASR_BIN)",
      };
    }
    this.cachedAvailable = true;
    return { ok: true };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (!this.binPath || !this.existsImpl(this.binPath)) {
      throw new TranscriptionError("onnx-asr not installed", {
        code: "missing_provider",
        retriable: false,
      });
    }

    const id = randomUUID();
    const inExt = extFor(input.filename, input.mimeType);
    const inputPath = join(this.tmpDir, `parachute-ox-${id}.${inExt}`);
    const wavPath = join(this.tmpDir, `parachute-ox-${id}.16k.wav`);
    const cleanup: string[] = [inputPath, wavPath];

    try {
      await writeFile(inputPath, input.audio);

      // ALWAYS transcode to 16kHz mono s16le WAV — even an incoming .wav,
      // whose sample rate we can't trust (see the module header).
      const ff = await this.spawn(buildOnnxFfmpegArgs(this.ffmpegPath, inputPath, wavPath), {
        timeoutMs: this.timeoutMs,
      });
      if (ff.exitCode !== 0) {
        const missing = ff.exitCode === 127;
        throw new TranscriptionError(
          missing
            ? "ffmpeg not found — install it to transcode audio to 16kHz mono WAV for onnx-asr (apt install ffmpeg / brew install ffmpeg)"
            : `ffmpeg transcode failed (exit ${ff.exitCode}): ${ff.stderr.trim().slice(0, 500)}`,
          { code: missing ? "ffmpeg_missing" : "transcode_failed", retriable: false },
        );
      }

      const res = await this.spawn(buildOnnxAsrArgs(this.binPath, this.model, wavPath), {
        timeoutMs: this.timeoutMs,
      });
      if (res.exitCode !== 0) {
        if (res.exitCode === 127) {
          throw new TranscriptionError(`onnx-asr could not be launched: ${res.stderr.trim()}`, {
            code: "missing_provider",
            retriable: false,
          });
        }
        throw new TranscriptionError(
          `onnx-asr exited ${res.exitCode}: ${res.stderr.trim().slice(0, 500)}`,
          { code: "onnx_asr_error", retriable: true },
        );
      }

      const text = parseOnnxAsrOutput(res.stdout);
      if (!text) {
        // Empty/unparseable — plain Error is treated as retriable by the worker.
        throw new Error("onnx-asr produced no transcript text");
      }
      return { text };
    } finally {
      await Promise.all(cleanup.map((p) => unlink(p).catch(() => {})));
    }
  }
}

/** Choose a temp-file extension from the filename or mime type. */
function extFor(filename: string, mimeType: string): string {
  const fromName = filename.split(".").pop();
  if (fromName && fromName.length <= 5 && /^[a-z0-9]+$/i.test(fromName)) return fromName.toLowerCase();
  const sub = mimeType.split("/")[1]?.split(";")[0]?.trim();
  if (sub && /^[a-z0-9]+$/i.test(sub)) return sub.toLowerCase();
  return "bin";
}
