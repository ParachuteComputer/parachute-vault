/**
 * `parakeet-mlx` — the local Apple-Silicon transcription provider
 * (scribe-fold Phase 2b).
 *
 * Turns audio into text by subprocessing the `parakeet-mlx` CLI
 * (github.com/senstella/parakeet-mlx — NVIDIA Parakeet on Apple's MLX,
 * macOS/Apple-Silicon only). Ported from scribe's proven
 * `src/transcribe/parakeet-mlx.ts`; structurally a sibling of the
 * `transcribe-cpp` provider (same SpawnRunner seam, same terminal-vs-retriable
 * error contract).
 *
 * ## The audio path
 *
 * `parakeet-mlx` decodes the input itself (shelling to ffmpeg internally for
 * non-WAV audio), so unlike transcribe-cpp we do NOT pre-transcode — the raw
 * capture bytes are written to a temp file and handed over directly:
 *
 *   parakeet-mlx <audio> --output-format txt --output-dir <tmpout> [--model <id>]
 *
 * The transcript comes back as a `.txt` file in the output dir — named after
 * the input file's stem, though some versions use their own stem, so we fall
 * back to "any .txt in the dir" (scribe's proven fallback).
 *
 * ## The ffmpeg-missing mask (scribe's classic silent failure)
 *
 * parakeet-mlx shells to ffmpeg internally and, when ffmpeg is missing,
 * prints the error then **exits 0** with no output file — the exitCode gate
 * never fires. The signature in the combined stdout+stderr is the only
 * signal, so "no output + ffmpeg-missing signature" maps to a terminal
 * `ffmpeg_missing` error the operator can actually fix (ported from scribe's
 * `looksLikeFfmpegMissing`).
 *
 * ## Error mapping (mirrors transcribe-cpp)
 *
 *   - binary not installed → non-retriable `missing_provider` (never spawns).
 *   - launch failure (127) → non-retriable `missing_provider`.
 *   - non-zero exit → RETRIABLE `parakeet_mlx_error` (transient resource blip
 *     backs off; a deterministic failure still terminates after maxAttempts).
 *   - exit 0 + no output + ffmpeg signature → non-retriable `ffmpeg_missing`.
 *   - exit 0 + no output otherwise / empty transcript → plain `Error`
 *     (retriable via the worker).
 *
 * NOTE on first use: the model (~2.5GB for parakeet-tdt-0.6b-v3) downloads
 * into the HuggingFace cache on the first transcription. A slow first run may
 * hit the subprocess timeout; the download resumes on the worker's retry.
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { writeFile, readFile, rm } from "fs/promises";
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

/** Model download on first use + MLX inference can be slow; generous default. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Detect an ffmpeg-missing signature in a tool's combined stdout+stderr.
 * Ported verbatim from scribe's `transcribe/backend-error.ts`: tolerant by
 * design — requires the co-occurrence of an `ffmpeg` mention with a "not
 * installed / not found / no such file" phrasing anywhere in the output
 * (e.g. `[Errno 2] No such file or directory: 'ffmpeg'`).
 */
const FFMPEG_TOKEN = /ffmpeg/i;
const NOT_PRESENT = /not (?:installed|found)|no such file/i;

export function looksLikeFfmpegMissing(combinedOutput: string): boolean {
  if (!combinedOutput) return false;
  return FFMPEG_TOKEN.test(combinedOutput) && NOT_PRESENT.test(combinedOutput);
}

export interface ParakeetMlxProviderOpts {
  /** Path to the `parakeet-mlx` binary. Undefined ⇒ unavailable + terminal. */
  binPath?: string;
  /** HF model repo id passed as `--model`. Undefined ⇒ the CLI's own default. */
  model?: string;
  /** Per-transcription timeout (ms). Default 600s. */
  timeoutMs?: number;
  /** Subprocess runner (tests inject a mock). Default `defaultSpawnRunner`. */
  spawn?: SpawnRunner;
  /** Existence probe (tests inject). Default `fs.existsSync`. */
  existsImpl?: (p: string) => boolean;
  /** Scratch dir for the temp audio + output files. Default `os.tmpdir()`. */
  tmpDir?: string;
}

/**
 * Build the `parakeet-mlx` argv. Scribe's proven invocation:
 *   `parakeet-mlx <audio> --output-format txt --output-dir <dir>`
 * plus an optional `--model <hf-repo>` (the ratified default is
 * mlx-community/parakeet-tdt-0.6b-v3). Exported so a test pins the shape.
 */
export function buildParakeetMlxArgs(
  binPath: string,
  audioPath: string,
  outDir: string,
  model?: string,
): string[] {
  const args = [binPath, audioPath, "--output-format", "txt", "--output-dir", outDir];
  if (model) args.push("--model", model);
  return args;
}

export class ParakeetMlxProvider implements TranscriptionProvider {
  readonly name = "parakeet-mlx";

  private readonly binPath: string | undefined;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private readonly spawn: SpawnRunner;
  private readonly existsImpl: (p: string) => boolean;
  private readonly tmpDir: string;
  /** Once available, stays available for this process — avoids re-statting. */
  private cachedAvailable = false;

  constructor(opts: ParakeetMlxProviderOpts = {}) {
    this.binPath = opts.binPath;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawn = opts.spawn ?? defaultSpawnRunner;
    this.existsImpl = opts.existsImpl ?? existsSync;
    this.tmpDir = opts.tmpDir ?? tmpdir();
  }

  /**
   * Cheap readiness probe — a runnable `parakeet-mlx` binary on disk. NEVER
   * spawns (it gates the capability flag on every `/api/vault` GET). The
   * MODEL is not checked: it lives in the HF cache and downloads on first
   * use, so binary presence is the honest cheap signal. Memoizes the
   * once-true result so repeated landing reads don't re-stat.
   */
  async available(): Promise<ProviderAvailability> {
    if (this.cachedAvailable) return { ok: true };
    if (!this.binPath || !this.existsImpl(this.binPath)) {
      return {
        ok: false,
        reason:
          "parakeet-mlx is not installed (run `parachute-vault transcription install` on this Mac, or set PARAKEET_MLX_BIN)",
      };
    }
    this.cachedAvailable = true;
    return { ok: true };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (!this.binPath || !this.existsImpl(this.binPath)) {
      throw new TranscriptionError("parakeet-mlx not installed", {
        code: "missing_provider",
        retriable: false,
      });
    }

    const id = randomUUID();
    const inExt = extFor(input.filename, input.mimeType);
    const stem = `parachute-pk-${id}`;
    const inputPath = join(this.tmpDir, `${stem}.${inExt}`);
    const outDir = join(this.tmpDir, `${stem}-out`);

    try {
      await writeFile(inputPath, input.audio);
      mkdirSync(outDir, { recursive: true });

      const res = await this.spawn(
        buildParakeetMlxArgs(this.binPath, inputPath, outDir, this.model),
        { timeoutMs: this.timeoutMs },
      );
      const combined = `${res.stdout}\n${res.stderr}`;

      if (res.exitCode !== 0) {
        if (res.exitCode === 127) {
          throw new TranscriptionError(
            `parakeet-mlx could not be launched: ${res.stderr.trim()}`,
            { code: "missing_provider", retriable: false },
          );
        }
        throw new TranscriptionError(
          `parakeet-mlx exited ${res.exitCode}: ${res.stderr.trim().slice(0, 500)}`,
          { code: "parakeet_mlx_error", retriable: true },
        );
      }

      // Find the transcript: <stem>.txt, else any .txt the tool wrote (some
      // versions name outputs after their own stem — scribe's proven fallback).
      const expected = join(outDir, `${stem}.txt`);
      let outFile: string | undefined = this.existsImpl(expected) ? expected : undefined;
      if (!outFile) {
        const txts = safeListTxt(outDir);
        if (txts.length > 0) outFile = join(outDir, txts[0]!);
      }

      if (!outFile) {
        // No output AND exit 0 — the classic ffmpeg-missing mask. Promote to a
        // terminal, actionable error instead of an opaque retry loop.
        if (looksLikeFfmpegMissing(combined)) {
          throw new TranscriptionError(
            "parakeet-mlx needs `ffmpeg` to decode this audio, but ffmpeg isn't installed or isn't on the daemon's PATH (brew install ffmpeg)",
            { code: "ffmpeg_missing", retriable: false },
          );
        }
        // Plain Error is treated as retriable by the worker.
        throw new Error("parakeet-mlx produced no transcript output");
      }

      const text = (await readFile(outFile, "utf8")).trim();
      if (!text) {
        throw new Error("parakeet-mlx produced no transcript text");
      }
      return { text };
    } finally {
      await Promise.all([
        rm(inputPath, { force: true }).catch(() => {}),
        rm(outDir, { recursive: true, force: true }).catch(() => {}),
      ]);
    }
  }
}

/** List `.txt` files in a dir, tolerating a dir the tool never created. */
function safeListTxt(dir: string): string[] {
  try {
    return (readdirSync(dir) as string[]).filter((f) => f.endsWith(".txt"));
  } catch {
    return [];
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
