/**
 * Audio encoding helpers.
 *
 * Unifies audio storage on OGG Opus (48 kbps, mono, VOIP profile). Input can
 * be any format ffmpeg understands; output is a standalone .ogg file.
 *
 * Why Opus:
 * - A 15-minute Kokoro TTS WAV is ~33MB. Same audio as 48 kbps Opus is ~500KB
 *   (60x smaller).
 * - The Flutter client re-downloads each attachment on every note open
 *   (parachute-daily#64), so shrinking file size dramatically improves UX.
 * - Opus is natively supported on Android + iOS — our actual target
 *   platforms. We do not optimize for macOS playback.
 *
 * ffmpeg is a hard dependency. Callers (see `registerTtsHook` in
 * `tts-provider.ts`) should probe for it at registration time via
 * `assertFfmpegAvailable()` so missing-binary errors surface loudly up front
 * rather than as silent per-note failures later.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target Opus bitrate. 48 kbps is the sweet spot for speech. */
export const OPUS_BITRATE = "48k";

/** Output MIME for encoded audio. */
export const OPUS_MIME = "audio/ogg";

/** Output file extension. */
export const OPUS_EXT = ".ogg";

// ---------------------------------------------------------------------------
// Extension mapping for temp input file
// ---------------------------------------------------------------------------

/**
 * Track mime types we've already warned about for this process so an unknown
 * provider mime doesn't spam the logs on every call. Module-scoped on
 * purpose — survives across calls within a single process.
 */
const warnedUnknownMimes = new Set<string>();

/**
 * Pick a reasonable input extension for the temp file we pass to ffmpeg.
 * ffmpeg probes content so the extension is mostly cosmetic, but some
 * demuxers behave slightly better with a matching suffix.
 *
 * Unknown mimes fall through to `.bin`, which ffmpeg handles fine via its
 * content probe. We log a one-time warning per unrecognized mime so that if
 * a TTS provider starts emitting something new we have a breadcrumb rather
 * than silent `.bin` fallthrough forever.
 */
function mimeToInputExt(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower === "audio/wav" || lower === "audio/x-wav" || lower === "audio/wave") return ".wav";
  if (lower === "audio/mpeg" || lower === "audio/mp3") return ".mp3";
  if (lower === "audio/ogg") return ".ogg";
  if (lower === "audio/webm") return ".webm";
  if (lower === "audio/mp4" || lower === "audio/aac" || lower === "audio/x-m4a") return ".m4a";
  if (lower === "audio/flac") return ".flac";
  if (!warnedUnknownMimes.has(lower)) {
    warnedUnknownMimes.add(lower);
    console.warn(
      `[audio-encoding] unknown input mime "${mime}"; falling back to .bin (ffmpeg will probe the content). ` +
        `If this is a legitimate format, add it to mimeToInputExt in src/audio-encoding.ts.`,
    );
  }
  return ".bin";
}

/** For tests: reset the warned-mimes set. */
export function __resetWarnedMimesForTests(): void {
  warnedUnknownMimes.clear();
}

// ---------------------------------------------------------------------------
// ffmpeg availability
// ---------------------------------------------------------------------------

let ffmpegAvailableCache: boolean | null = null;

/**
 * Probe for ffmpeg on PATH by running `ffmpeg -version`. Cached so repeated
 * calls are cheap. Returns true on success, false if the binary is missing
 * or the invocation fails.
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailableCache !== null) return ffmpegAvailableCache;
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    const code = await proc.exited;
    ffmpegAvailableCache = code === 0;
  } catch {
    ffmpegAvailableCache = false;
  }
  return ffmpegAvailableCache;
}

/** For tests: reset the availability cache. */
export function __resetFfmpegCacheForTests(): void {
  ffmpegAvailableCache = null;
}

/**
 * Assert ffmpeg is on PATH. Throws a clear error if not. Call this once at
 * TTS hook registration so missing binaries fail loud at startup, not
 * silently at runtime.
 */
export async function assertFfmpegAvailable(): Promise<void> {
  if (!(await isFfmpegAvailable())) {
    throw new Error(
      "ffmpeg not found on PATH. ffmpeg is required for OGG Opus audio " +
        "encoding in the TTS hook. Install it (e.g. `brew install ffmpeg`, " +
        "`apt install ffmpeg`) and restart the vault server.",
    );
  }
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/**
 * Encode an in-memory audio buffer to OGG Opus at 48 kbps mono. Writes the
 * input to a temp file, spawns ffmpeg, reads the output back, cleans up.
 *
 * Throws if ffmpeg exits non-zero or the output file is empty.
 *
 * The flags mirror the command documented on issue #43:
 *   ffmpeg -y -i <in> -c:a libopus -b:a 48k -ac 1 -vbr on -application voip \
 *     -f ogg <out.ogg>
 *
 * - `-application voip` tunes the encoder for speech at low bitrates.
 * - `-ac 1` forces mono. Kokoro is mono anyway; ElevenLabs mp3 is stereo but
 *   mono is fine for speech and halves the bitrate budget.
 */
export async function encodeOggOpus(input: Buffer, inputMime: string): Promise<Buffer> {
  const workDir = mkdtempSync(join(tmpdir(), "opus-encode-"));
  const inPath = join(workDir, `in${mimeToInputExt(inputMime)}`);
  const outPath = join(workDir, "out.ogg");

  try {
    writeFileSync(inPath, input);

    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-i",
        inPath,
        "-c:a",
        "libopus",
        "-b:a",
        OPUS_BITRATE,
        "-ac",
        "1",
        "-vbr",
        "on",
        "-application",
        "voip",
        "-f",
        "ogg",
        outPath,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      },
    );

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    // Drain stdout so the pipe doesn't back up.
    try {
      await new Response(proc.stdout).text();
    } catch {
      // ignore
    }

    if (exitCode !== 0) {
      throw new Error(
        `ffmpeg exited with code ${exitCode} while encoding to OGG Opus. stderr: ${stderr.slice(0, 1000)}`,
      );
    }

    let out: Buffer;
    try {
      out = Buffer.from(readFileSync(outPath));
    } catch {
      throw new Error(
        `ffmpeg reported success but output file ${outPath} was not created. stderr: ${stderr.slice(0, 500)}`,
      );
    }

    if (out.byteLength === 0) {
      throw new Error("ffmpeg produced an empty OGG Opus file");
    }

    // Sanity check: OGG streams begin with the magic bytes "OggS".
    if (out.byteLength < 4 || out.toString("ascii", 0, 4) !== "OggS") {
      throw new Error(
        "ffmpeg output is not a valid OGG stream (missing OggS magic bytes)",
      );
    }

    return out;
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
