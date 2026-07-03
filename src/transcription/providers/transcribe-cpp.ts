/**
 * `transcribe-cpp` — the local, no-Python transcription provider
 * (scribe-fold Phase 2a).
 *
 * Turns audio into text by subprocessing the prebuilt `transcribe-cli` from
 * transcribe.cpp (github.com/handy-computer/transcribe.cpp — CJ Pais /
 * Mozilla.ai, MIT). transcribe.cpp's in-process N-API binding crashes on Bun,
 * so we drive the CLI as a subprocess — structurally like the `scribe-http`
 * provider, but local. It's the recommended low-RAM / no-Python provider,
 * opt-in via `parachute-vault transcription install` + `TRANSCRIPTION_PROVIDER`.
 *
 * ## The audio path
 *
 * `transcribe-cli` requires **16kHz mono WAV** input. Incoming capture audio is
 * usually webm/m4a, so a non-WAV blob is transcoded via `ffmpeg` first
 * (`-ar 16000 -ac 1`). Already-WAV input is passed straight through (we trust
 * the caller's WAV is usable; the surface's captures go through ffmpeg anyway).
 * The install verb prints an ffmpeg hint when it's missing; here a missing
 * ffmpeg surfaces as a terminal `ffmpeg_missing` error the operator must fix.
 *
 * ## Error mapping (mirrors scribe-http's terminal-vs-retriable contract)
 *
 *   - binary / model not installed → non-retriable `missing_provider` (operator
 *     runs `transcription install`); never spawns.
 *   - ffmpeg not found → non-retriable `ffmpeg_missing`.
 *   - ffmpeg transcode non-zero exit → non-retriable `transcode_failed`
 *     (a re-run on the same undecodable blob won't help).
 *   - `transcribe-cli` non-zero exit → RETRIABLE `transcribe_cli_error` (could
 *     be a transient resource blip; the worker backs off, and a deterministic
 *     failure still terminates after maxAttempts).
 *   - empty/unparseable stdout → plain `Error` (retriable via the worker),
 *     matching scribe-http's "missing text field".
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

/** transcribe-cli can be slow on CPU for long audio; generous default. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Result of running a subprocess: exit code + captured streams (as text). */
export interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Injection seam for the subprocess call. Production uses `defaultSpawnRunner`
 * (Bun.spawn); tests pass a mock so no real binary runs. A launch failure
 * (binary not found) resolves to `exitCode: 127` rather than throwing, so the
 * provider maps it to a friendly terminal error.
 */
export type SpawnRunner = (
  cmd: string[],
  opts?: { timeoutMs?: number },
) => Promise<SubprocessResult>;

/** Production spawn runner over `Bun.spawn`. */
export const defaultSpawnRunner: SpawnRunner = async (cmd, opts) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    // ENOENT etc. — the binary couldn't be launched at all.
    return { exitCode: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
  let timedOut = false;
  const timer = opts?.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs)
    : null;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (timedOut) {
      return { exitCode: 124, stdout, stderr: `${stderr}\n[transcribe-cli timed out]` };
    }
    return { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export interface TranscribeCppProviderOpts {
  /** Path to the `transcribe-cli` binary. Undefined ⇒ unavailable + terminal. */
  binPath?: string;
  /** Path to the GGUF model. Undefined ⇒ unavailable + terminal. */
  modelPath?: string;
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
 * Decide whether the input is already a WAV we can feed straight to
 * `transcribe-cli`. Non-WAV goes through ffmpeg. Exported for tests.
 */
export function looksLikeWav(filename: string, mimeType: string): boolean {
  return /\.wav$/i.test(filename) || /(?:^|\/)(x-)?wav$/i.test(mimeType.split(";")[0]!.trim());
}

/**
 * Build the `transcribe-cli` argv. Upstream usage:
 *   `transcribe-cli -m <model.gguf> <audio.wav>`
 * (model via `-m`, audio as a positional). Exported so a test pins the shape.
 */
export function buildTranscribeArgs(binPath: string, modelPath: string, wavPath: string): string[] {
  return [binPath, "-m", modelPath, wavPath];
}

/** Build the ffmpeg transcode argv → 16kHz mono WAV. Exported for tests. */
export function buildFfmpegArgs(ffmpegPath: string, inputPath: string, wavPath: string): string[] {
  return [ffmpegPath, "-nostdin", "-y", "-i", inputPath, "-ar", "16000", "-ac", "1", wavPath];
}

/**
 * Parse `transcribe-cli` stdout into a transcript string. Robust to:
 *   - a JSON object with a `text` field;
 *   - whisper-style timestamped lines (`[00:00:00.000 --> ...]  text`);
 *   - plain text.
 * Returns "" when nothing transcript-like is present (caller treats "" as a
 * retriable empty-output failure). Exported for tests.
 */
export function parseTranscribeCliOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  // JSON envelope?
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown };
      if (typeof parsed.text === "string") return parsed.text.trim();
    } catch {
      // not JSON — fall through to line parsing
    }
  }

  // Strip leading whisper-style timestamp brackets from each line, drop blanks.
  const lines = trimmed
    .split("\n")
    .map((line) => line.replace(/^\s*\[[0-9:.\s>\-]+\]\s*/, "").trim())
    .filter((line) => line.length > 0);
  return lines.join(" ").trim();
}

export class TranscribeCppProvider implements TranscriptionProvider {
  readonly name = "transcribe-cpp";

  private readonly binPath: string | undefined;
  private readonly modelPath: string | undefined;
  private readonly ffmpegPath: string;
  private readonly timeoutMs: number;
  private readonly spawn: SpawnRunner;
  private readonly existsImpl: (p: string) => boolean;
  private readonly tmpDir: string;
  /** Once available, stays available for this process — avoids re-statting. */
  private cachedAvailable = false;

  constructor(opts: TranscribeCppProviderOpts = {}) {
    this.binPath = opts.binPath;
    this.modelPath = opts.modelPath;
    this.ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawn = opts.spawn ?? defaultSpawnRunner;
    this.existsImpl = opts.existsImpl ?? existsSync;
    this.tmpDir = opts.tmpDir ?? tmpdir();
  }

  /**
   * Cheap readiness probe — binary + model both present on disk. NEVER spawns
   * (it gates the capability flag on every `/api/vault` GET). Memoizes the
   * once-true result so repeated landing reads don't re-stat.
   */
  async available(): Promise<ProviderAvailability> {
    if (this.cachedAvailable) return { ok: true };
    if (!this.binPath || !this.existsImpl(this.binPath)) {
      return {
        ok: false,
        reason: "transcribe-cli not installed (run `parachute-vault transcription install`)",
      };
    }
    if (!this.modelPath || !this.existsImpl(this.modelPath)) {
      return {
        ok: false,
        reason: "no GGUF model installed (run `parachute-vault transcription install`)",
      };
    }
    this.cachedAvailable = true;
    return { ok: true };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (!this.binPath || !this.existsImpl(this.binPath)) {
      throw new TranscriptionError("transcribe-cli not installed", {
        code: "missing_provider",
        retriable: false,
      });
    }
    if (!this.modelPath || !this.existsImpl(this.modelPath)) {
      throw new TranscriptionError("no GGUF model installed for transcribe-cpp", {
        code: "missing_provider",
        retriable: false,
      });
    }

    const id = randomUUID();
    const inExt = extFor(input.filename, input.mimeType);
    const inputPath = join(this.tmpDir, `parachute-tc-${id}.${inExt}`);
    const cleanup: string[] = [inputPath];

    try {
      await writeFile(inputPath, input.audio);

      // Resolve the WAV `transcribe-cli` will read — transcode non-WAV first.
      let wavPath: string;
      if (looksLikeWav(input.filename, input.mimeType)) {
        wavPath = inputPath;
      } else {
        wavPath = join(this.tmpDir, `parachute-tc-${id}.16k.wav`);
        cleanup.push(wavPath);
        const ff = await this.spawn(buildFfmpegArgs(this.ffmpegPath, inputPath, wavPath), {
          timeoutMs: this.timeoutMs,
        });
        if (ff.exitCode !== 0) {
          const missing = ff.exitCode === 127;
          throw new TranscriptionError(
            missing
              ? "ffmpeg not found — install it to transcode non-WAV audio for transcribe-cpp (apt install ffmpeg / brew install ffmpeg)"
              : `ffmpeg transcode failed (exit ${ff.exitCode}): ${ff.stderr.trim().slice(0, 500)}`,
            { code: missing ? "ffmpeg_missing" : "transcode_failed", retriable: false },
          );
        }
      }

      const res = await this.spawn(buildTranscribeArgs(this.binPath, this.modelPath, wavPath), {
        timeoutMs: this.timeoutMs,
      });
      if (res.exitCode !== 0) {
        // Launch failure (127) means the binary vanished under us despite the
        // existsSync above — terminal. Any other non-zero is retriable so a
        // transient resource blip backs off; a deterministic failure still
        // terminates after the worker's maxAttempts.
        if (res.exitCode === 127) {
          throw new TranscriptionError(`transcribe-cli could not be launched: ${res.stderr.trim()}`, {
            code: "missing_provider",
            retriable: false,
          });
        }
        throw new TranscriptionError(
          `transcribe-cli exited ${res.exitCode}: ${res.stderr.trim().slice(0, 500)}`,
          { code: "transcribe_cli_error", retriable: true },
        );
      }

      const text = parseTranscribeCliOutput(res.stdout);
      if (!text) {
        // Empty/unparseable — plain Error is treated as retriable by the worker.
        throw new Error("transcribe-cli produced no transcript text");
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
