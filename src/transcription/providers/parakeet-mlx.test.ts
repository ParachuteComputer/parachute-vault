import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ParakeetMlxProvider,
  buildParakeetMlxArgs,
  looksLikeFfmpegMissing,
} from "./parakeet-mlx.ts";
import type { SpawnRunner, SubprocessResult } from "./transcribe-cpp.ts";
import { TranscriptionError } from "../../../core/src/transcription/provider.ts";

/**
 * Conformance tests for the `parakeet-mlx` local provider (scribe-fold
 * Phase 2b). The subprocess is mocked so no real binary runs; the temp
 * input/output files are REAL (in a per-test tmp dir) so the output-discovery
 * logic — including scribe's proven "the tool may name the .txt after its own
 * stem" fallback and the ffmpeg-missing exit-0 mask — is exercised for real.
 */

const AUDIO = new Uint8Array([1, 2, 3, 4]);

const tmpDirs: string[] = [];
function freshTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pk-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A spawn mock that records argv and lets the test act on the out dir. */
function recordingSpawn(
  handler: (cmd: string[]) => SubprocessResult,
): { spawn: SpawnRunner; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnRunner = async (cmd) => {
    calls.push(cmd);
    return handler(cmd);
  };
  return { spawn, calls };
}

/** Extract the --output-dir value from a recorded argv. */
function outDirOf(cmd: string[]): string {
  return cmd[cmd.indexOf("--output-dir") + 1]!;
}

const ok: SubprocessResult = { exitCode: 0, stdout: "", stderr: "" };

function provider(
  spawn: SpawnRunner,
  tmpDir: string,
  opts: Partial<{ existsImpl: (p: string) => boolean; model: string; binPath: string | undefined }> = {},
) {
  return new ParakeetMlxProvider({
    binPath: "binPath" in opts ? opts.binPath : "/venv/bin/parakeet-mlx",
    model: opts.model,
    spawn,
    tmpDir,
    // Binary existence is stubbed; output-file discovery uses the REAL fs.
    existsImpl: opts.existsImpl ?? ((p) => (p.includes("parakeet-mlx") ? true : existsSync(p))),
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildParakeetMlxArgs", () => {
  test("matches scribe's proven invocation: <bin> <audio> --output-format txt --output-dir <dir>", () => {
    expect(buildParakeetMlxArgs("/bin/parakeet-mlx", "/a.webm", "/out")).toEqual([
      "/bin/parakeet-mlx",
      "/a.webm",
      "--output-format",
      "txt",
      "--output-dir",
      "/out",
    ]);
  });

  test("appends --model when a model id is set", () => {
    const args = buildParakeetMlxArgs("/bin/pk", "/a.wav", "/out", "mlx-community/parakeet-tdt-0.6b-v3");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("mlx-community/parakeet-tdt-0.6b-v3");
  });
});

describe("looksLikeFfmpegMissing (ported from scribe backend-error.ts)", () => {
  test("classic python ENOENT traceback", () => {
    expect(looksLikeFfmpegMissing("[Errno 2] No such file or directory: 'ffmpeg'")).toBe(true);
  });
  test("shell not-found phrasing", () => {
    expect(looksLikeFfmpegMissing("ffmpeg: command not found")).toBe(true);
  });
  test("multi-line co-occurrence matches", () => {
    expect(looksLikeFfmpegMissing("error decoding audio\nffmpeg is required\nnot installed on PATH")).toBe(true);
  });
  test("ffmpeg mentioned without a missing phrasing → false", () => {
    expect(looksLikeFfmpegMissing("ffmpeg version 6.0 Copyright")).toBe(false);
  });
  test("empty output → false", () => {
    expect(looksLikeFfmpegMissing("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// available() — cheap, no spawn
// ---------------------------------------------------------------------------

describe("ParakeetMlxProvider.available", () => {
  test("name is stable 'parakeet-mlx'", () => {
    expect(provider(recordingSpawn(() => ok).spawn, freshTmp()).name).toBe("parakeet-mlx");
  });

  test("ok:true when the binary exists — and NEVER spawns", async () => {
    const { spawn, calls } = recordingSpawn(() => ok);
    const p = provider(spawn, freshTmp());
    expect(await p.available()).toEqual({ ok: true });
    expect(calls.length).toBe(0);
  });

  test("ok:false with an actionable reason when the binary is missing", async () => {
    const { spawn, calls } = recordingSpawn(() => ok);
    const p = provider(spawn, freshTmp(), { existsImpl: () => false });
    const avail = await p.available();
    expect(avail.ok).toBe(false);
    expect(avail.reason).toContain("transcription install");
    expect(calls.length).toBe(0);
  });

  test("unconfigured (no binPath) → ok:false, no throw", async () => {
    const p = provider(recordingSpawn(() => ok).spawn, freshTmp(), { binPath: undefined });
    expect((await p.available()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transcribe() — happy paths
// ---------------------------------------------------------------------------

describe("ParakeetMlxProvider.transcribe — happy path", () => {
  test("hands the raw audio file over (no pre-transcode) and reads <stem>.txt", async () => {
    const tmp = freshTmp();
    const { spawn, calls } = recordingSpawn((cmd) => {
      // Simulate the tool writing the transcript named after the input stem.
      const outDir = outDirOf(cmd);
      const stem = cmd[1]!.split("/").pop()!.replace(/\.webm$/, "");
      writeFileSync(join(outDir, `${stem}.txt`), "hello from parakeet\n");
      return ok;
    });
    const p = provider(spawn, tmp);
    const res = await p.transcribe({ audio: AUDIO, filename: "memo.webm", mimeType: "audio/webm" });

    expect(res.text).toBe("hello from parakeet");
    // Exactly ONE spawn — parakeet-mlx decodes internally; no ffmpeg pre-pass.
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe("/venv/bin/parakeet-mlx");
    expect(calls[0]![1]).toMatch(/\.webm$/); // the raw input, not a transcoded wav
    expect(calls[0]).toContain("--output-format");
    expect(calls[0]).toContain("txt");
  });

  test("falls back to any .txt when the tool uses its own output stem", async () => {
    const tmp = freshTmp();
    const { spawn } = recordingSpawn((cmd) => {
      writeFileSync(join(outDirOf(cmd), "some-other-stem.txt"), "  fallback transcript  ");
      return ok;
    });
    const p = provider(spawn, tmp);
    const res = await p.transcribe({ audio: AUDIO, filename: "a.m4a", mimeType: "audio/mp4" });
    expect(res.text).toBe("fallback transcript");
  });

  test("passes --model when configured", async () => {
    const tmp = freshTmp();
    const { spawn, calls } = recordingSpawn((cmd) => {
      writeFileSync(join(outDirOf(cmd), "x.txt"), "t");
      return ok;
    });
    const p = provider(spawn, tmp, { model: "mlx-community/parakeet-tdt-0.6b-v3" });
    await p.transcribe({ audio: AUDIO, filename: "a.wav", mimeType: "audio/wav" });
    expect(calls[0]).toContain("--model");
    expect(calls[0]).toContain("mlx-community/parakeet-tdt-0.6b-v3");
  });

  test("cleans up the temp input + output dir afterwards", async () => {
    const tmp = freshTmp();
    let seenOutDir = "";
    const { spawn, calls } = recordingSpawn((cmd) => {
      seenOutDir = outDirOf(cmd);
      writeFileSync(join(seenOutDir, "x.txt"), "t");
      return ok;
    });
    await provider(spawn, tmp).transcribe({ audio: AUDIO, filename: "a.wav", mimeType: "audio/wav" });
    expect(existsSync(calls[0]![1]!)).toBe(false);
    expect(existsSync(seenOutDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transcribe() — error mapping
// ---------------------------------------------------------------------------

describe("ParakeetMlxProvider.transcribe — error mapping", () => {
  async function catchErr(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (err) {
      return err;
    }
    throw new Error("expected transcribe() to throw");
  }

  test("binary missing → non-retriable missing_provider, NEVER spawns", async () => {
    const { spawn, calls } = recordingSpawn(() => ok);
    const p = provider(spawn, freshTmp(), { existsImpl: () => false });
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.code).toBe("missing_provider");
    expect(err.retriable).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("launch failure (127) → non-retriable missing_provider", async () => {
    const { spawn } = recordingSpawn(() => ({ exitCode: 127, stdout: "", stderr: "gone" }));
    const p = provider(spawn, freshTmp());
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err.code).toBe("missing_provider");
    expect(err.retriable).toBe(false);
  });

  test("non-zero exit → RETRIABLE parakeet_mlx_error", async () => {
    const { spawn } = recordingSpawn(() => ({ exitCode: 1, stdout: "", stderr: "boom" }));
    const p = provider(spawn, freshTmp());
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.code).toBe("parakeet_mlx_error");
    expect(err.retriable).toBe(true);
  });

  test("exit 0 + no output + ffmpeg signature → non-retriable ffmpeg_missing (the scribe mask)", async () => {
    // parakeet-mlx shells to ffmpeg internally; when ffmpeg is missing it
    // prints the error then EXITS 0 with no output file. The signature in the
    // combined output is the only signal.
    const { spawn } = recordingSpawn(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "[Errno 2] No such file or directory: 'ffmpeg'",
    }));
    const p = provider(spawn, freshTmp());
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as TranscriptionError;
    expect(err).toBeInstanceOf(TranscriptionError);
    expect(err.code).toBe("ffmpeg_missing");
    expect(err.retriable).toBe(false);
  });

  test("exit 0 + no output, no ffmpeg signature → plain Error (retriable via worker)", async () => {
    const { spawn } = recordingSpawn(() => ({ exitCode: 0, stdout: "done?", stderr: "" }));
    const p = provider(spawn, freshTmp());
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" }),
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TranscriptionError);
    expect(err.message).toContain("no transcript output");
  });

  test("empty transcript file → plain Error (retriable via worker)", async () => {
    const { spawn } = recordingSpawn((cmd) => {
      writeFileSync(join(outDirOf(cmd), "x.txt"), "   \n ");
      return ok;
    });
    const p = provider(spawn, freshTmp());
    const err = (await catchErr(() =>
      p.transcribe({ audio: AUDIO, filename: "a.wav", mimeType: "audio/wav" }),
    )) as Error;
    expect(err).not.toBeInstanceOf(TranscriptionError);
    expect(err.message).toContain("no transcript text");
  });
});
