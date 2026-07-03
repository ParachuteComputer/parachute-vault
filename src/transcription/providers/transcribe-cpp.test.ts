import { describe, test, expect } from "bun:test";
import {
  TranscribeCppProvider,
  buildTranscribeArgs,
  buildFfmpegArgs,
  parseTranscribeCliOutput,
  type SpawnRunner,
  type SubprocessResult,
} from "./transcribe-cpp.ts";
import { TranscriptionError } from "../../../core/src/transcription/provider.ts";

/**
 * Conformance tests for the `transcribe-cpp` local provider (scribe-fold
 * Phase 2a). The subprocess (`Bun.spawn`) is mocked so no real binary runs and
 * no bytes are downloaded — we pin the argv shape, the WAV/transcode decision,
 * the stdout parse, and the terminal-vs-retriable error mapping the worker
 * depends on.
 */

const AUDIO = new Uint8Array([1, 2, 3, 4]);

/** A spawn mock that records every argv and returns canned results per call. */
function recordingSpawn(results: SubprocessResult[] | ((cmd: string[]) => SubprocessResult)): {
  spawn: SpawnRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  const spawn: SpawnRunner = async (cmd) => {
    calls.push(cmd);
    if (typeof results === "function") return results(cmd);
    return results[Math.min(i++, results.length - 1)]!;
  };
  return { spawn, calls };
}

const ok = (stdout: string): SubprocessResult => ({ exitCode: 0, stdout, stderr: "" });

/**
 * A real `transcribe-cli` v0.1.1 stdout report (macOS arm64, whisper-tiny.en).
 * The transcript is the single `text:` line; library `[info]`/`[debug]` logs go
 * to STDERR (not shown here). Build one with a given `text:` value.
 */
function cliReport(text: string): string {
  return [
    "audio: test.wav",
    "  samples:    48422",
    "  duration:   3.026 s",
    "  sample rate 16000 Hz mono float32",
    "model: /models/whisper-tiny.en-Q5_K_M.gguf -> ok",
    "  backend:    MTL0",
    "  name:       Whisper Tiny (English)",
    "  license:    apache-2.0",
    "  max audio:  unbounded (long audio chunked internally)",
    "run: ok",
    `text: ${text}`,
    "segments: 1",
    `  [   0.00 ->    3.00] ${text}`,
    "  realtime:   9x (332.1 ms for 3.0 s)",
    "",
  ].join("\n");
}

/** A provider whose binary + model both "exist", with an injected spawn. */
function provider(spawn: SpawnRunner, opts: Partial<{ existsImpl: (p: string) => boolean }> = {}) {
  return new TranscribeCppProvider({
    binPath: "/tc/bin/transcribe-cli",
    modelPath: "/tc/models/whisper-tiny.en-Q5_K_M.gguf",
    ffmpegPath: "ffmpeg",
    spawn,
    existsImpl: opts.existsImpl ?? (() => true),
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildTranscribeArgs", () => {
  test("matches upstream usage: transcribe-cli -m <model> <wav>", () => {
    expect(buildTranscribeArgs("/bin/transcribe-cli", "/m.gguf", "/a.wav")).toEqual([
      "/bin/transcribe-cli",
      "-m",
      "/m.gguf",
      "/a.wav",
    ]);
  });
});

describe("buildFfmpegArgs", () => {
  test("transcodes to 16kHz mono WAV", () => {
    const args = buildFfmpegArgs("ffmpeg", "/in.webm", "/out.wav");
    expect(args).toContain("-ar");
    expect(args[args.indexOf("-ar") + 1]).toBe("16000");
    expect(args).toContain("-ac");
    expect(args[args.indexOf("-ac") + 1]).toBe("1");
    expect(args[args.length - 1]).toBe("/out.wav");
  });
});

describe("parseTranscribeCliOutput", () => {
  test("extracts exactly the `text:` line from the real v0.1.1 report", () => {
    const report = cliReport("Hello parachute. Testing transcribe CPP.");
    expect(parseTranscribeCliOutput(report)).toBe("Hello parachute. Testing transcribe CPP.");
  });
  test("ignores the indented per-segment line (starts with a bracket, not `text:`)", () => {
    // The segment line repeats the transcript but is indented + bracketed; only
    // the column-0 `text:` line is the transcript, and we return it once.
    const report = cliReport("just once");
    expect(parseTranscribeCliOutput(report)).toBe("just once");
  });
  test("the `(empty)` no-result sentinel maps to \"\"", () => {
    expect(parseTranscribeCliOutput(cliReport("(empty)"))).toBe("");
  });
  test("no `text:` line at all → empty string", () => {
    expect(parseTranscribeCliOutput("audio: test.wav\nrun: ok\nsegments: 0\n")).toBe("");
  });
  test("empty / whitespace stdout → empty string", () => {
    expect(parseTranscribeCliOutput("   \n  ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// available() — cheap, no spawn
// ---------------------------------------------------------------------------

describe("TranscribeCppProvider.available", () => {
  test("name is stable 'transcribe-cpp'", () => {
    expect(provider(recordingSpawn([]).spawn).name).toBe("transcribe-cpp");
  });

  test("ok:true when binary + model exist — and NEVER spawns", async () => {
    const { spawn, calls } = recordingSpawn([]);
    const p = provider(spawn);
    expect(await p.available()).toEqual({ ok: true });
    expect(calls.length).toBe(0); // no subprocess on the hot path
  });

  test("ok:false with reason when the binary is missing", async () => {
    const { spawn, calls } = recordingSpawn([]);
    const p = provider(spawn, { existsImpl: (path) => !path.includes("transcribe-cli") });
    const avail = await p.available();
    expect(avail.ok).toBe(false);
    expect(avail.reason).toContain("transcribe-cli");
    expect(calls.length).toBe(0);
  });

  test("ok:false when the model is missing", async () => {
    const { spawn } = recordingSpawn([]);
    const p = provider(spawn, { existsImpl: (path) => !path.endsWith(".gguf") });
    expect((await p.available()).ok).toBe(false);
  });

  test("dylib-only install (model exists, no runnable CLI) → ok:false (honesty)", async () => {
    // v0.1.1 ships a library, not a CLI: libs + model land on disk but no
    // transcribe-cli. available() must gate on the binary so the capability
    // flag reports enabled:false rather than a capability we can't deliver.
    const { spawn } = recordingSpawn([]);
    const p = provider(spawn, { existsImpl: (path) => path.endsWith(".gguf") }); // only the model exists
    const avail = await p.available();
    expect(avail.ok).toBe(false);
    expect(avail.reason).toContain("transcribe-cli");
  });

  test("unconfigured (no binPath) → ok:false, no throw", async () => {
    const p = new TranscribeCppProvider({});
    expect((await p.available()).ok).toBe(false);
  });

  test("caches the once-true result (no repeated existsSync after ok)", async () => {
    let calls = 0;
    const p = provider(recordingSpawn([]).spawn, {
      existsImpl: () => {
        calls++;
        return true;
      },
    });
    await p.available();
    const afterFirst = calls;
    await p.available();
    expect(calls).toBe(afterFirst); // second call short-circuits the cache
  });
});

// ---------------------------------------------------------------------------
// transcribe() — happy paths
// ---------------------------------------------------------------------------

describe("TranscribeCppProvider.transcribe — happy path", () => {
  test("non-WAV input transcodes via ffmpeg THEN runs transcribe-cli", async () => {
    const { spawn, calls } = recordingSpawn([ok(""), ok(cliReport("the transcript"))]);
    const p = provider(spawn);
    const res = await p.transcribe({ audio: AUDIO, filename: "memo.webm", mimeType: "audio/webm" });

    expect(res.text).toBe("the transcript");
    expect(calls.length).toBe(2);
    // First call: ffmpeg transcode to 16kHz mono WAV.
    expect(calls[0]![0]).toBe("ffmpeg");
    expect(calls[0]).toContain("16000");
    // Second call: transcribe-cli -m <model> <wav>.
    expect(calls[1]![0]).toBe("/tc/bin/transcribe-cli");
    expect(calls[1]![1]).toBe("-m");
    expect(calls[1]![2]).toBe("/tc/models/whisper-tiny.en-Q5_K_M.gguf");
    expect(calls[1]![3]).toMatch(/\.16k\.wav$/);
  });

  test("WAV input ALSO transcodes (strict 16kHz — we can't trust its rate)", async () => {
    // Regression for the live-verified bug: a 44.1kHz .wav made transcribe-cli
    // exit 1. We now ALWAYS run ffmpeg first, even for a .wav → two spawns, and
    // the CLI reads the 16k .wav ffmpeg produced (not the raw input).
    const { spawn, calls } = recordingSpawn([ok(""), ok(cliReport("wav text"))]);
    const p = provider(spawn);
    const res = await p.transcribe({ audio: AUDIO, filename: "clip.wav", mimeType: "audio/wav" });

    expect(res.text).toBe("wav text");
    expect(calls.length).toBe(2);
    expect(calls[0]![0]).toBe("ffmpeg");
    expect(calls[0]).toContain("16000");
    expect(calls[0]).toContain("1"); // -ac 1 mono
    expect(calls[1]![0]).toBe("/tc/bin/transcribe-cli");
    expect(calls[1]![3]).toMatch(/\.16k\.wav$/);
  });
});

// ---------------------------------------------------------------------------
// transcribe() — error mapping
// ---------------------------------------------------------------------------

describe("TranscribeCppProvider.transcribe — error mapping", () => {
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
    const p = provider(spawn, { existsImpl: (path) => !path.includes("transcribe-cli") });
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.code).toBe("missing_provider");
    expect(err.retriable).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("model missing → non-retriable missing_provider", async () => {
    const { spawn } = recordingSpawn([ok("nope")]);
    const p = provider(spawn, { existsImpl: (path) => !path.endsWith(".gguf") });
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err.code).toBe("missing_provider");
    expect(err.retriable).toBe(false);
  });

  test("ffmpeg not found (exit 127) → non-retriable ffmpeg_missing", async () => {
    const { spawn } = recordingSpawn([{ exitCode: 127, stdout: "", stderr: "not found" }]);
    const p = provider(spawn);
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err.code).toBe("ffmpeg_missing");
    expect(err.retriable).toBe(false);
  });

  test("ffmpeg transcode failure (non-127) → non-retriable transcode_failed", async () => {
    const { spawn } = recordingSpawn([{ exitCode: 1, stdout: "", stderr: "bad input" }]);
    const p = provider(spawn);
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err.code).toBe("transcode_failed");
    expect(err.retriable).toBe(false);
  });

  test("transcribe-cli non-zero exit → RETRIABLE transcribe_cli_error", async () => {
    // ffmpeg succeeds; transcribe-cli then fails with a generic exit code.
    const { spawn } = recordingSpawn([ok(""), { exitCode: 2, stdout: "", stderr: "decode error" }]);
    const p = provider(spawn);
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.wav", mimeType: "audio/wav" }),
    )) as TranscriptionError;
    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.code).toBe("transcribe_cli_error");
    expect(err.retriable).toBe(true);
  });

  test("transcribe-cli launch failure (127) → non-retriable missing_provider", async () => {
    const { spawn } = recordingSpawn([ok(""), { exitCode: 127, stdout: "", stderr: "gone" }]);
    const p = provider(spawn);
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.wav", mimeType: "audio/wav" }),
    )) as TranscriptionError;
    expect(err.code).toBe("missing_provider");
    expect(err.retriable).toBe(false);
  });

  test("`text: (empty)` no-result → plain Error (retriable via worker), not TranscriptionError", async () => {
    // ffmpeg ok; transcribe-cli returns its (empty) sentinel → parses to "".
    const { spawn } = recordingSpawn([ok(""), ok(cliReport("(empty)"))]);
    const p = provider(spawn);
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.wav", mimeType: "audio/wav" }),
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TranscriptionError);
    expect(err.message).toContain("no transcript text");
  });
});
