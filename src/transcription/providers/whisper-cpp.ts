/**
 * `whisper-cpp` — the local, no-Python transcription provider.
 *
 * Drives whisper.cpp's prebuilt CLIs as a subprocess: `parakeet-cli` for
 * Parakeet models, `whisper-cli` for Whisper ones. Which binary runs is derived
 * from the chosen model's `engine` (see `../models.ts`), so an operator picks a
 * MODEL and never has to think about binaries.
 *
 * Replaces the `transcribe-cpp` provider, whose CLI never shipped — see the
 * `models.ts` header for that history. Structurally this is the same shape:
 * transcode → subprocess → parse → map errors. What changed is that the binary
 * on the other end actually exists.
 *
 * ## The audio path — ffmpeg is still required
 *
 * `parakeet-cli` advertises flac/mp3/ogg/wav, which looks like it removes the
 * ffmpeg dependency. It doesn't, for the case that matters: browser voice
 * capture produces **webm/opus**, which is on neither CLI's list. And
 * `whisper-cli` strictly wants 16 kHz mono WAV — a 44.1 kHz WAV exits non-zero.
 *
 * So we ALWAYS transcode through `ffmpeg -ar 16000 -ac 1` first, even when the
 * input is already `.wav`, because an incoming WAV's sample rate can't be
 * trusted. One path, no format sniffing, no class of bug where a particular
 * recorder's output silently fails.
 *
 * ## Reading the output
 *
 * Both CLIs, run with `-np` (no prints), write the bare transcript to STDOUT
 * and their backend chatter to STDERR. `whisper-cli` additionally needs `-nt`
 * to suppress the `[00:00:00.000 --> ...]` timestamp prefixes. Verified against
 * whisper.cpp 1.9.1: stdout is the transcript with leading whitespace and
 * nothing else, so parsing is a trim.
 *
 * ## Error mapping (same terminal-vs-retriable contract as scribe-http)
 *
 *   - binary / model missing → non-retriable `missing_provider`; never spawns.
 *   - ffmpeg not found → non-retriable `ffmpeg_missing`.
 *   - ffmpeg non-zero → non-retriable `transcode_failed` (a re-run on the same
 *     undecodable blob won't help).
 *   - CLI non-zero → RETRIABLE `whisper_cli_error` (could be a transient
 *     resource blip; a deterministic failure still terminates after
 *     maxAttempts).
 *   - empty stdout → plain `Error` (retriable), matching scribe-http's
 *     "missing text field".
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  TranscriptionError,
  type ProviderAvailability,
  type TranscribeInput,
  type TranscribeResult,
  type TranscriptionProvider,
} from "../../../core/src/transcription/provider.ts";
import type { TranscriptionEngine } from "../models.ts";
import { defaultSpawnRunner, type SpawnRunner } from "./transcribe-cpp.ts";

/** Local CPU inference on long audio can be slow; generous default. */
const DEFAULT_TIMEOUT_MS = 600_000;

export interface WhisperCppProviderOpts {
  /** Path to `parakeet-cli` or `whisper-cli`. Undefined ⇒ unavailable. */
  binPath?: string;
  /** Which CLI `binPath` is — decides the argv shape. */
  engine: TranscriptionEngine;
  /** Path to the ggml model `.bin`. Undefined ⇒ unavailable. */
  modelPath?: string;
  /** ffmpeg binary (default "ffmpeg", resolved on PATH). */
  ffmpegPath?: string;
  /** Per-transcription timeout (ms). Default 600s. */
  timeoutMs?: number;
  /** Subprocess runner (tests inject a mock). */
  spawn?: SpawnRunner;
  /** Existence probe (tests inject). */
  existsImpl?: (p: string) => boolean;
  /** Scratch dir for temp audio. Default `os.tmpdir()`. */
  tmpDir?: string;
}

/**
 * Build the CLI argv for a transcription.
 *
 * `-np` silences backend logs on both. `whisper-cli` also needs `-nt` or every
 * line arrives wrapped in `[00:00:00.000 --> 00:00:11.000]` timestamps.
 * `parakeet-cli` has no `-nt` flag and doesn't print timestamps by default.
 * Exported so a test pins the shape per engine.
 */
export function buildCliArgs(
  engine: TranscriptionEngine,
  binPath: string,
  modelPath: string,
  wavPath: string,
): string[] {
  const base = [binPath, "-m", modelPath, "-f", wavPath, "-np"];
  return engine === "whisper" ? [...base, "-nt"] : base;
}

/** Build the ffmpeg transcode argv → 16 kHz mono WAV. Exported for tests. */
export function buildFfmpegArgs(
  ffmpegPath: string,
  inputPath: string,
  wavPath: string,
): string[] {
  return [ffmpegPath, "-nostdin", "-y", "-i", inputPath, "-ar", "16000", "-ac", "1", wavPath];
}

/**
 * Extract the transcript from CLI stdout.
 *
 * With `-np` both binaries emit the bare transcript and nothing else, so this
 * is a trim. It stays a named function rather than an inline `.trim()` because
 * it is the contract with an external binary: if a future whisper.cpp adds a
 * banner to stdout, this is the one place that has to learn about it, and the
 * test that pins it is the one that fails.
 */
export function parseCliOutput(stdout: string): string {
  return stdout.trim();
}

export class WhisperCppProvider implements TranscriptionProvider {
  readonly name = "whisper-cpp";

  private readonly binPath: string | undefined;
  private readonly engine: TranscriptionEngine;
  private readonly modelPath: string | undefined;
  private readonly ffmpegPath: string;
  private readonly timeoutMs: number;
  private readonly spawn: SpawnRunner;
  private readonly existsImpl: (p: string) => boolean;
  private readonly tmpDir: string;
  /** Once available, stays available for this process — avoids re-statting. */
  private cachedAvailable = false;

  constructor(opts: WhisperCppProviderOpts) {
    this.binPath = opts.binPath;
    this.engine = opts.engine;
    this.modelPath = opts.modelPath;
    this.ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawn = opts.spawn ?? defaultSpawnRunner;
    this.existsImpl = opts.existsImpl ?? existsSync;
    this.tmpDir = opts.tmpDir ?? tmpdir();
  }

  /**
   * Ready iff both the CLI and the model are on disk. Reports WHICH is missing
   * — "not installed" is not an actionable message when there are two things
   * it could mean and different fixes for each.
   */
  async available(): Promise<ProviderAvailability> {
    if (this.cachedAvailable) return { ok: true };
    const missing: string[] = [];
    if (!this.binPath || !this.existsImpl(this.binPath)) {
      missing.push(
        `the ${this.engine === "whisper" ? "whisper-cli" : "parakeet-cli"} binary ` +
          "(install it with `parachute-vault transcription install`, or `brew install whisper-cpp` on macOS)",
      );
    }
    if (!this.modelPath || !this.existsImpl(this.modelPath)) {
      missing.push("the model file (`parachute-vault transcription install` downloads it)");
    }
    if (missing.length > 0) {
      return { ok: false, reason: `whisper-cpp is not ready — missing ${missing.join(" and ")}` };
    }
    this.cachedAvailable = true;
    return { ok: true };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const avail = await this.available();
    if (!avail.ok) {
      throw new TranscriptionError(avail.reason ?? "whisper-cpp is not ready", {
        code: "missing_provider",
        retriable: false,
      });
    }
    // Non-null after `available()`.
    const binPath = this.binPath as string;
    const modelPath = this.modelPath as string;

    const stem = join(this.tmpDir, `parachute-stt-${randomUUID()}`);
    const srcPath = `${stem}.src`;
    const wavPath = `${stem}.wav`;

    try {
      await writeFile(srcPath, input.audio);

      // --- transcode -------------------------------------------------------
      const ff = await this.spawn(buildFfmpegArgs(this.ffmpegPath, srcPath, wavPath), {
        timeoutMs: this.timeoutMs,
      });
      if (ff.exitCode === 127) {
        throw new TranscriptionError(
          "ffmpeg was not found. Audio has to be transcoded to 16 kHz mono WAV before " +
            "transcription — install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`).",
          { code: "ffmpeg_missing", retriable: false },
        );
      }
      if (ff.exitCode !== 0 || !this.existsImpl(wavPath)) {
        throw new TranscriptionError(
          `ffmpeg could not decode this audio (exit ${ff.exitCode}): ${tail(ff.stderr)}`,
          { code: "transcode_failed", retriable: false },
        );
      }

      // --- transcribe ------------------------------------------------------
      const run = await this.spawn(buildCliArgs(this.engine, binPath, modelPath, wavPath), {
        timeoutMs: this.timeoutMs,
      });
      if (run.exitCode !== 0) {
        throw new TranscriptionError(
          `${this.engine === "whisper" ? "whisper-cli" : "parakeet-cli"} exited ${run.exitCode}: ${tail(run.stderr)}`,
          { code: "whisper_cli_error", retriable: true },
        );
      }
      const text = parseCliOutput(run.stdout);
      if (text.length === 0) {
        // Retriable, matching scribe-http's missing-text behaviour: an empty
        // result on a genuinely silent clip terminates after maxAttempts
        // anyway, and a transient blip gets its retry.
        throw new Error("transcription produced no text");
      }
      return { text };
    } finally {
      await Promise.all([
        unlink(srcPath).catch(() => {}),
        unlink(wavPath).catch(() => {}),
      ]);
    }
  }
}

/** Last few lines of a stream, for error messages that stay readable. */
function tail(s: string, lines = 3): string {
  const parts = s.trim().split("\n");
  return parts.slice(-lines).join(" | ").slice(0, 500);
}
