/**
 * The whisper-cpp provider.
 *
 * Mostly driven through the `spawn` seam so no binary runs — but the last
 * block is a LIVE test that shells the real `parakeet-cli`/`whisper-cli` and
 * transcribes real audio when they're installed. That block is what actually
 * proves the argv shape and the stdout contract against whisper.cpp itself;
 * every mocked test above it is only as true as the fixtures. It skips
 * cleanly on a machine without the binaries so CI stays green.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TranscriptionError } from "../../../core/src/transcription/provider.ts";
import { resolveCliBinary, resolveFfmpeg } from "../resolve-binary.ts";
import {
  buildCliArgs,
  buildFfmpegArgs,
  parseCliOutput,
  WhisperCppProvider,
  type WhisperCppProviderOpts,
} from "./whisper-cpp.ts";
import type { SpawnRunner } from "./transcribe-cpp.ts";

const AUDIO = new Uint8Array([1, 2, 3, 4]);

/**
 * A provider wired to a scripted spawn; both paths "exist" by default.
 *
 * `whichImpl` is stubbed because `available()` now also requires ffmpeg, and
 * the default `ffmpegPath` is the bare name `"ffmpeg"` resolved on PATH. Left
 * un-stubbed these tests would pass on a dev box with ffmpeg installed and fail
 * in a CI container without it — the exact green-locally/red-in-CI trap.
 */
function makeProvider(
  spawn: SpawnRunner,
  over: Partial<WhisperCppProviderOpts> = {},
): WhisperCppProvider {
  return new WhisperCppProvider({
    binPath: "/bin/parakeet-cli",
    engine: "parakeet",
    modelPath: "/models/m.bin",
    spawn,
    existsImpl: () => true,
    whichImpl: () => "/usr/bin/ffmpeg",
    tmpDir: tmpdir(),
    ...over,
  });
}

/** Scripted runner: ffmpeg call first, CLI call second. */
function scripted(ffmpeg: Partial<{ exitCode: number; stderr: string }>, cli: Partial<{ exitCode: number; stdout: string; stderr: string }>): SpawnRunner {
  let n = 0;
  return async () => {
    n += 1;
    if (n === 1) return { exitCode: ffmpeg.exitCode ?? 0, stdout: "", stderr: ffmpeg.stderr ?? "" };
    return { exitCode: cli.exitCode ?? 0, stdout: cli.stdout ?? "", stderr: cli.stderr ?? "" };
  };
}

describe("buildCliArgs", () => {
  test("parakeet: -np, no -nt (it has no such flag)", () => {
    const a = buildCliArgs("parakeet", "/b/parakeet-cli", "/m.bin", "/a.wav");
    expect(a).toEqual(["/b/parakeet-cli", "-m", "/m.bin", "-f", "/a.wav", "-np"]);
    expect(a).not.toContain("-nt");
  });

  test("whisper: adds -nt, or every line arrives timestamp-wrapped", () => {
    const a = buildCliArgs("whisper", "/b/whisper-cli", "/m.bin", "/a.wav");
    expect(a).toEqual(["/b/whisper-cli", "-m", "/m.bin", "-f", "/a.wav", "-np", "-nt"]);
  });
});

describe("buildFfmpegArgs", () => {
  test("always forces 16 kHz mono — an incoming WAV's rate can't be trusted", () => {
    const a = buildFfmpegArgs("ffmpeg", "/in.webm", "/out.wav");
    expect(a).toContain("-ar");
    expect(a[a.indexOf("-ar") + 1]).toBe("16000");
    expect(a).toContain("-ac");
    expect(a[a.indexOf("-ac") + 1]).toBe("1");
    expect(a).toContain("-nostdin");
  });
});

describe("parseCliOutput", () => {
  test("trims the leading whitespace both CLIs emit", () => {
    expect(parseCliOutput("\n And so my fellow Americans.\n")).toBe(
      "And so my fellow Americans.",
    );
  });
  test("empty stdout → empty string", () => {
    expect(parseCliOutput("   \n  ")).toBe("");
  });
});

describe("availability", () => {
  test("missing binary names the binary AND how to get it", async () => {
    const p = makeProvider(scripted({}, {}), { existsImpl: (x) => x !== "/bin/parakeet-cli" });
    const a = await p.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/parakeet-cli/);
    expect(a.reason).toMatch(/transcription install|brew install/);
  });

  test("missing model is reported as a DIFFERENT problem than a missing binary", async () => {
    const p = makeProvider(scripted({}, {}), { existsImpl: (x) => x !== "/models/m.bin" });
    const a = await p.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/model file/);
    expect(a.reason).not.toMatch(/parakeet-cli binary/);
  });

  test("both present → ok", async () => {
    expect((await makeProvider(scripted({}, {})).available()).ok).toBe(true);
  });

  // ffmpeg is a hard requirement — `transcribe()` always transcodes to 16 kHz
  // mono WAV first, so a box without it can never transcribe anything. Leaving
  // it out of `available()` made the vault landing advertise a working mic that
  // failed on every recording.
  test("missing ffmpeg is reported as its own problem, distinct from binary/model", async () => {
    const p = makeProvider(scripted({}, {}), { whichImpl: () => null });
    const a = await p.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/ffmpeg/);
    expect(a.reason).not.toMatch(/parakeet-cli binary/);
    expect(a.reason).not.toMatch(/model file/);
  });

  test("an ABSOLUTE ffmpegPath is stat'd, not resolved on PATH", async () => {
    const p = makeProvider(scripted({}, {}), {
      ffmpegPath: "/opt/custom/ffmpeg",
      existsImpl: (x) => x !== "/opt/custom/ffmpeg",
      whichImpl: () => "/usr/bin/ffmpeg", // PATH has one; the configured path does not exist
    });
    const a = await p.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/ffmpeg/);
  });

  // The regression this probe could easily have introduced: the constructor
  // defaults ffmpegPath to the BARE name "ffmpeg". Stat'ing that would always
  // miss and report every default-constructed provider unavailable.
  test("the bare-name default resolves on PATH rather than being stat'd", async () => {
    const p = makeProvider(scripted({}, {}), {
      existsImpl: (x) => x === "/bin/parakeet-cli" || x === "/models/m.bin",
      whichImpl: (cmd) => (cmd === "ffmpeg" ? "/usr/bin/ffmpeg" : null),
    });
    expect((await p.available()).ok).toBe(true);
  });
});

describe("transcribe — error taxonomy", () => {
  test("not ready → terminal missing_provider, and never spawns", async () => {
    let spawned = false;
    const p = makeProvider(
      async () => {
        spawned = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { existsImpl: () => false },
    );
    await expect(p.transcribe({ audio: AUDIO, mimeType: "audio/webm" } as never)).rejects.toThrow(
      TranscriptionError,
    );
    expect(spawned).toBe(false);
  });

  test("ffmpeg missing (127) → TERMINAL, with an install hint", async () => {
    const p = makeProvider(scripted({ exitCode: 127 }, {}));
    let caught: TranscriptionError | undefined;
    try {
      await p.transcribe({ audio: AUDIO, mimeType: "audio/webm" } as never);
    } catch (e) {
      caught = e as TranscriptionError;
    }
    expect(caught?.code).toBe("ffmpeg_missing");
    expect(caught?.retriable).toBe(false);
    expect(caught?.message).toMatch(/brew install ffmpeg|apt install ffmpeg/);
  });

  test("undecodable audio → TERMINAL transcode_failed (a retry can't help)", async () => {
    const p = makeProvider(scripted({ exitCode: 1, stderr: "moov atom not found" }, {}), {
      // wav never materialises
      existsImpl: (x) => !x.endsWith(".wav"),
    });
    let caught: TranscriptionError | undefined;
    try {
      await p.transcribe({ audio: AUDIO, mimeType: "audio/webm" } as never);
    } catch (e) {
      caught = e as TranscriptionError;
    }
    expect(caught?.code).toBe("transcode_failed");
    expect(caught?.retriable).toBe(false);
  });

  test("CLI non-zero → RETRIABLE (could be a transient resource blip)", async () => {
    const p = makeProvider(scripted({}, { exitCode: 3, stderr: "out of memory" }));
    let caught: TranscriptionError | undefined;
    try {
      await p.transcribe({ audio: AUDIO, mimeType: "audio/webm" } as never);
    } catch (e) {
      caught = e as TranscriptionError;
    }
    expect(caught?.code).toBe("whisper_cli_error");
    expect(caught?.retriable).toBe(true);
  });

  test("empty transcript → plain retriable Error", async () => {
    const p = makeProvider(scripted({}, { stdout: "   " }));
    await expect(
      p.transcribe({ audio: AUDIO, mimeType: "audio/webm" } as never),
    ).rejects.toThrow(/no text/i);
  });

  test("success returns the trimmed transcript", async () => {
    const p = makeProvider(scripted({}, { stdout: "\n Hello there.\n" }));
    const r = await p.transcribe({ audio: AUDIO, mimeType: "audio/webm" } as never);
    expect(r.text).toBe("Hello there.");
  });
});

// ---------------------------------------------------------------------------
// LIVE — shells the real binaries. Skipped when they aren't installed.
//
// Everything above is only as true as its fixtures. This is the block that
// proves the argv shape and the stdout contract against whisper.cpp itself.
// ---------------------------------------------------------------------------
const liveBin = resolveCliBinary("parakeet") ?? resolveCliBinary("whisper");
const liveFfmpeg = resolveFfmpeg();
const liveEngine = resolveCliBinary("parakeet") ? "parakeet" : "whisper";
/** A real ggml model, if the operator running tests happens to have one. */
const liveModel = [
  join(tmpdir(), "pk.bin"),
  join(tmpdir(), "ggml-base.en.bin"),
].find((p) => existsSync(p));

const canRunLive = Boolean(liveBin && liveFfmpeg && liveModel);

describe.skipIf(!canRunLive)("LIVE — real whisper.cpp binary", () => {
  test("transcribes real audio end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wcpp-live-"));
    try {
      // A short silent WAV is enough to prove the pipeline runs and the
      // contract holds; we assert on mechanics, not on transcript content.
      const provider = new WhisperCppProvider({
        binPath: liveBin,
        engine: liveEngine as "parakeet" | "whisper",
        modelPath: liveModel,
        ffmpegPath: liveFfmpeg,
        tmpDir: dir,
        timeoutMs: 120_000,
      });
      expect((await provider.available()).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
