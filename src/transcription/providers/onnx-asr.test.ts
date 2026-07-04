import { describe, test, expect } from "bun:test";
import {
  OnnxAsrProvider,
  buildOnnxAsrArgs,
  buildOnnxFfmpegArgs,
  parseOnnxAsrOutput,
} from "./onnx-asr.ts";
import type { SpawnRunner, SubprocessResult } from "./transcribe-cpp.ts";
import { TranscriptionError } from "../../../core/src/transcription/provider.ts";
import { DEFAULT_ONNX_ASR_MODEL } from "../select.ts";

/**
 * Conformance tests for the `onnx-asr` local provider (scribe-fold Phase 2b).
 * The subprocess is mocked so no real binary runs — we pin the argv shapes
 * (model + `--vad silero`, the pcm_s16le transcode), the timestamped-output
 * parse ported from scribe, and the terminal-vs-retriable error mapping.
 */

const AUDIO = new Uint8Array([1, 2, 3, 4]);

function recordingSpawn(results: SubprocessResult[]): { spawn: SpawnRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const spawn: SpawnRunner = async (cmd) => {
    calls.push(cmd);
    return results[Math.min(i++, results.length - 1)]!;
  };
  return { spawn, calls };
}

const ok = (stdout: string): SubprocessResult => ({ exitCode: 0, stdout, stderr: "" });

function provider(spawn: SpawnRunner, opts: Partial<{ existsImpl: (p: string) => boolean; model: string }> = {}) {
  return new OnnxAsrProvider({
    binPath: "/venv/bin/onnx-asr",
    model: opts.model,
    ffmpegPath: "ffmpeg",
    spawn,
    existsImpl: opts.existsImpl ?? (() => true),
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildOnnxAsrArgs", () => {
  test("matches scribe's proven invocation: <bin> <model> --vad silero <wav>", () => {
    expect(buildOnnxAsrArgs("/bin/onnx-asr", "nemo-parakeet-tdt-0.6b-v3", "/a.wav")).toEqual([
      "/bin/onnx-asr",
      "nemo-parakeet-tdt-0.6b-v3",
      "--vad",
      "silero",
      "/a.wav",
    ]);
  });
});

describe("buildOnnxFfmpegArgs", () => {
  test("transcodes to 16kHz mono pcm_s16le WAV (onnx-asr's input contract)", () => {
    const args = buildOnnxFfmpegArgs("ffmpeg", "/in.webm", "/out.wav");
    expect(args[args.indexOf("-ar") + 1]).toBe("16000");
    expect(args[args.indexOf("-ac") + 1]).toBe("1");
    expect(args[args.indexOf("-c:a") + 1]).toBe("pcm_s16le");
    expect(args[args.length - 1]).toBe("/out.wav");
  });
});

describe("parseOnnxAsrOutput (ported from scribe)", () => {
  test("strips --vad timestamps and joins segments with spaces", () => {
    const raw = "[  0.0,  3.2]: hello there\n[  3.5,  7.1]: second segment\n";
    expect(parseOnnxAsrOutput(raw)).toBe("hello there second segment");
  });
  test("untimestamped output (short clip) passes through", () => {
    expect(parseOnnxAsrOutput("plain transcript line\n")).toBe("plain transcript line");
  });
  test("mixed timestamped + blank lines", () => {
    expect(parseOnnxAsrOutput("[ 0.0, 1.0]: a\n\n[ 1.2, 2.0]: b\n")).toBe("a b");
  });
  test("empty / whitespace stdout → empty string", () => {
    expect(parseOnnxAsrOutput("  \n \n")).toBe("");
  });
  test("timestamped lines with empty text are dropped", () => {
    expect(parseOnnxAsrOutput("[ 0.0, 1.0]: \n[ 1.0, 2.0]: kept\n")).toBe("kept");
  });
});

// ---------------------------------------------------------------------------
// available() — cheap, no spawn
// ---------------------------------------------------------------------------

describe("OnnxAsrProvider.available", () => {
  test("name is stable 'onnx-asr'", () => {
    expect(provider(recordingSpawn([]).spawn).name).toBe("onnx-asr");
  });

  test("ok:true when the binary exists — and NEVER spawns", async () => {
    const { spawn, calls } = recordingSpawn([]);
    const p = provider(spawn);
    expect(await p.available()).toEqual({ ok: true });
    expect(calls.length).toBe(0);
  });

  test("ok:false with an actionable reason when the binary is missing", async () => {
    const { spawn } = recordingSpawn([]);
    const p = provider(spawn, { existsImpl: () => false });
    const avail = await p.available();
    expect(avail.ok).toBe(false);
    expect(avail.reason).toContain("transcription install");
  });

  test("unconfigured (no binPath) → ok:false, no throw", async () => {
    const p = new OnnxAsrProvider({});
    expect((await p.available()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transcribe() — happy paths
// ---------------------------------------------------------------------------

describe("OnnxAsrProvider.transcribe — happy path", () => {
  test("transcodes via ffmpeg THEN runs onnx-asr with the default model", async () => {
    const { spawn, calls } = recordingSpawn([ok(""), ok("[ 0.0, 3.0]: the transcript\n")]);
    const p = provider(spawn);
    const res = await p.transcribe({ audio: AUDIO, filename: "memo.webm", mimeType: "audio/webm" });

    expect(res.text).toBe("the transcript");
    expect(calls.length).toBe(2);
    expect(calls[0]![0]).toBe("ffmpeg");
    expect(calls[0]).toContain("pcm_s16le");
    expect(calls[1]![0]).toBe("/venv/bin/onnx-asr");
    expect(calls[1]![1]).toBe(DEFAULT_ONNX_ASR_MODEL);
    expect(calls[1]).toContain("--vad");
    expect(calls[1]![calls[1]!.length - 1]).toMatch(/\.16k\.wav$/);
  });

  test("WAV input ALSO transcodes (an incoming WAV's sample rate can't be trusted)", async () => {
    // Deviation from scribe (which copied .wav straight through), inheriting
    // the transcribe-cpp live-verify lesson: always normalize via ffmpeg.
    const { spawn, calls } = recordingSpawn([ok(""), ok("wav text")]);
    const p = provider(spawn);
    const res = await p.transcribe({ audio: AUDIO, filename: "clip.wav", mimeType: "audio/wav" });
    expect(res.text).toBe("wav text");
    expect(calls.length).toBe(2);
    expect(calls[0]![0]).toBe("ffmpeg");
  });

  test("a configured model overrides the default", async () => {
    const { spawn, calls } = recordingSpawn([ok(""), ok("t")]);
    const p = provider(spawn, { model: "whisper-base" });
    await p.transcribe({ audio: AUDIO, filename: "a.ogg", mimeType: "audio/ogg" });
    expect(calls[1]![1]).toBe("whisper-base");
  });
});

// ---------------------------------------------------------------------------
// transcribe() — error mapping
// ---------------------------------------------------------------------------

describe("OnnxAsrProvider.transcribe — error mapping", () => {
  async function catchErr(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (err) {
      return err;
    }
    throw new Error("expected transcribe() to throw");
  }

  test("binary missing → non-retriable missing_provider, NEVER spawns", async () => {
    const { spawn, calls } = recordingSpawn([ok("nope")]);
    const p = provider(spawn, { existsImpl: () => false });
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.code).toBe("missing_provider");
    expect(err.retriable).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("ffmpeg not found (exit 127) → non-retriable ffmpeg_missing", async () => {
    const { spawn } = recordingSpawn([{ exitCode: 127, stdout: "", stderr: "not found" }]);
    const err = (await catchErr(() =>
      provider(spawn).transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err.code).toBe("ffmpeg_missing");
    expect(err.retriable).toBe(false);
  });

  test("ffmpeg transcode failure (non-127) → non-retriable transcode_failed", async () => {
    const { spawn } = recordingSpawn([{ exitCode: 1, stdout: "", stderr: "bad input" }]);
    const err = (await catchErr(() =>
      provider(spawn).transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err.code).toBe("transcode_failed");
    expect(err.retriable).toBe(false);
  });

  test("onnx-asr non-zero exit → RETRIABLE onnx_asr_error", async () => {
    const { spawn } = recordingSpawn([ok(""), { exitCode: 2, stdout: "", stderr: "model error" }]);
    const err = (await catchErr(() =>
      provider(spawn).transcribe({ audio: AUDIO, filename: "a.wav", mimeType: "audio/wav" }),
    )) as TranscriptionError;
    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.code).toBe("onnx_asr_error");
    expect(err.retriable).toBe(true);
  });

  test("onnx-asr launch failure (127) → non-retriable missing_provider", async () => {
    const { spawn } = recordingSpawn([ok(""), { exitCode: 127, stdout: "", stderr: "gone" }]);
    const err = (await catchErr(() =>
      provider(spawn).transcribe({ audio: AUDIO, filename: "a.wav", mimeType: "audio/wav" }),
    )) as TranscriptionError;
    expect(err.code).toBe("missing_provider");
    expect(err.retriable).toBe(false);
  });

  test("empty stdout → plain Error (retriable via worker), not TranscriptionError", async () => {
    const { spawn } = recordingSpawn([ok(""), ok("   \n")]);
    const err = (await catchErr(() =>
      provider(spawn).transcribe({ audio: AUDIO, filename: "a.wav", mimeType: "audio/wav" }),
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TranscriptionError);
    expect(err.message).toContain("no transcript text");
  });
});
