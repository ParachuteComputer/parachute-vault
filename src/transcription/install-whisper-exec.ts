/**
 * Executing a {@link WhisperInstallPlan}.
 *
 * The planner decides; this does. Kept separate so every decision stays
 * testable without a network, and so the one genuinely irreversible-feeling
 * step — spawning a package manager — sits in a small, obvious place.
 *
 * ## The verification step is the point
 *
 * The provider this replaces was activated by an install verb that never
 * checked whether what it configured could run. That is precisely how
 * `TRANSCRIPTION_PROVIDER=transcribe-cpp` came to point at a CLI that has
 * never shipped, and why local transcription silently did nothing for anyone
 * who "installed" it.
 *
 * So {@link verifyTranscription} generates a real WAV, runs the real CLI
 * against the real model, and requires a real exit code. `TRANSCRIPTION_
 * PROVIDER` flips only after that passes. An install that cannot transcribe is
 * a failed install, and it says so at install time rather than silently at the
 * operator's first voice memo.
 */

import { existsSync, mkdirSync, renameSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { downloadTo } from "./download.ts";
import type { WhisperInstallPlan } from "./install-whisper-cpp.ts";
import { binaryNameFor } from "./resolve-binary.ts";
import { defaultSpawnRunner, type SpawnRunner } from "./providers/transcribe-cpp.ts";

export interface ExecDeps {
  spawn?: SpawnRunner;
  download?: (url: string, dest: string) => Promise<void>;
  existsImpl?: (p: string) => boolean;
  log?: (line: string) => void;
}

export interface StepResult {
  ok: boolean;
  /** What happened, for the operator. */
  message: string;
}

/**
 * Ensure the CLI binaries exist.
 *
 * `already-present` is a no-op by design — re-running install shouldn't drag a
 * package manager through a reinstall, and an operator who installed
 * whisper.cpp themselves has already solved this.
 */
export async function ensureBinaries(
  plan: WhisperInstallPlan,
  deps: ExecDeps = {},
): Promise<StepResult> {
  const spawn = deps.spawn ?? defaultSpawnRunner;
  const exists = deps.existsImpl ?? existsSync;
  const log = deps.log ?? (() => {});

  switch (plan.binary.kind) {
    case "already-present":
      return { ok: true, message: `${binaryNameFor(plan.model.engine)} already installed at ${plan.binary.path}` };

    case "unsupported":
      return { ok: false, message: plan.binary.reason };

    case "homebrew": {
      // Probe brew first so a box without it gets an honest refusal rather
      // than an opaque exit 127 from the install attempt.
      const probe = await spawn(["brew", "--version"], { timeoutMs: 30_000 });
      if (probe.exitCode !== 0) {
        return {
          ok: false,
          message:
            "Homebrew isn't installed, and it's the only way to get whisper.cpp's CLIs on macOS " +
            "(upstream ships no macOS CLI tarball — the macOS artifact is an xcframework for " +
            "embedding). Install Homebrew from https://brew.sh, then re-run this. Or build " +
            "whisper.cpp yourself and set WHISPER_CPP_BIN_DIR.",
        };
      }
      log(`Running: brew install ${plan.binary.formula} …`);
      const res = await spawn(["brew", "install", plan.binary.formula], { timeoutMs: 900_000 });
      if (res.exitCode !== 0) {
        return { ok: false, message: `brew install ${plan.binary.formula} failed: ${tail(res.stderr)}` };
      }
      return { ok: true, message: `Installed ${plan.binary.formula} (whisper-cli + parakeet-cli)` };
    }

    case "tarball": {
      const download = deps.download ?? downloadTo;
      mkdirSync(plan.binDir, { recursive: true });
      const marker = join(plan.binDir, binaryNameFor(plan.model.engine));
      if (exists(marker)) {
        return { ok: true, message: `Binaries already present in ${plan.binDir}` };
      }
      const tmp = join(plan.binDir, `.${plan.binary.assetName}.part`);
      log(`Downloading ${plan.binary.assetName} …`);
      await download(plan.binary.url, tmp);
      // Extract with --strip-components=1: the tarball nests everything under
      // `whisper-bin-ubuntu-<arch>/`, and we want the binaries and their
      // shared objects side by side in binDir so the loader finds them.
      const res = await spawn(["tar", "xzf", tmp, "-C", plan.binDir, "--strip-components=1"], {
        timeoutMs: 300_000,
      });
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      if (res.exitCode !== 0) {
        return { ok: false, message: `extracting ${plan.binary.assetName} failed: ${tail(res.stderr)}` };
      }
      if (!exists(marker)) {
        return {
          ok: false,
          message: `${plan.binary.assetName} extracted but ${binaryNameFor(plan.model.engine)} isn't in ${plan.binDir}`,
        };
      }
      await spawn(["chmod", "+x", marker], { timeoutMs: 30_000 });
      return { ok: true, message: `Installed whisper.cpp binaries to ${plan.binDir}` };
    }
  }
}

/**
 * Ensure the model file is on disk.
 *
 * Downloads to a `.part` and renames on success, so an interrupted install
 * never leaves a truncated file that looks complete to the readiness probe —
 * which would present as a mystery CLI failure at the first transcription
 * rather than an obvious missing download.
 */
export async function ensureModel(
  plan: WhisperInstallPlan,
  deps: ExecDeps = {},
): Promise<StepResult> {
  const exists = deps.existsImpl ?? existsSync;
  const download = deps.download ?? downloadTo;
  const log = deps.log ?? (() => {});

  if (exists(plan.modelPath)) {
    return { ok: true, message: `Model already downloaded (${plan.model.label})` };
  }
  mkdirSync(dirOf(plan.modelPath), { recursive: true });
  const part = `${plan.modelPath}.part`;
  log(`Downloading ${plan.model.label} (${plan.model.sizeMb} MB) …`);
  await download(plan.model.url, part);
  renameSync(part, plan.modelPath);
  return { ok: true, message: `Downloaded ${plan.model.label} to ${plan.modelPath}` };
}

/**
 * Prove the install can actually transcribe.
 *
 * Generates a one-second silent 16 kHz mono WAV in-process (no ffmpeg needed —
 * the CLIs take WAV directly, and this sidesteps making verification depend on
 * a second tool) and runs the real CLI against the real model. We assert on the
 * EXIT CODE, not on transcript content: silence legitimately produces no text,
 * and a model that loads and runs cleanly is what we're checking.
 */
export async function verifyTranscription(
  plan: WhisperInstallPlan,
  binPath: string,
  deps: ExecDeps = {},
): Promise<StepResult> {
  const spawn = deps.spawn ?? defaultSpawnRunner;
  const log = deps.log ?? (() => {});
  // Scratch, so it belongs in tmp — NOT beside the models, where a leftover
  // from an interrupted run would sit next to real downloads forever.
  const wav = join(tmpdir(), `parachute-verify-${process.pid}-16k-mono.wav`);
  try {
    await Bun.write(wav, silentWav16kMono(1));
    log("Verifying the install can transcribe …");
    const args =
      plan.model.engine === "whisper"
        ? [binPath, "-m", plan.modelPath, "-f", wav, "-np", "-nt"]
        : [binPath, "-m", plan.modelPath, "-f", wav, "-np"];
    const res = await spawn(args, { timeoutMs: 300_000 });
    if (res.exitCode !== 0) {
      return {
        ok: false,
        message:
          `${binaryNameFor(plan.model.engine)} could not run the model (exit ${res.exitCode}). ` +
          `This usually means a truncated download or a model/binary mismatch: ${tail(res.stderr)}`,
      };
    }
    return { ok: true, message: "Verified — the model loads and transcribes." };
  } finally {
    try {
      const { unlinkSync } = await import("fs");
      unlinkSync(wav);
    } catch {
      /* best effort */
    }
  }
}

/**
 * A minimal valid RIFF/WAVE file: `seconds` of 16-bit PCM silence at 16 kHz
 * mono — exactly the shape both CLIs want.
 *
 * Written by hand rather than shelling ffmpeg so verification doesn't depend
 * on the very tool whose absence we're trying to report clearly elsewhere.
 */
export function silentWav16kMono(seconds: number): Uint8Array {
  const sampleRate = 16000;
  const samples = Math.max(1, Math.floor(sampleRate * seconds));
  const dataBytes = samples * 2; // 16-bit mono
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  // Samples stay zero — silence.
  return new Uint8Array(buf);
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
}

function tail(s: string, lines = 3): string {
  return s.trim().split("\n").slice(-lines).join(" | ").slice(0, 400);
}
