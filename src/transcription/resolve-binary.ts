/**
 * Where the whisper.cpp CLIs live, on a box we didn't install.
 *
 * The binaries arrive by more than one route and we should find them however
 * they got there, because "it's installed but Parachute can't see it" is the
 * worst version of this failure — the operator did the work and got told no.
 *
 * The ladder, first hit wins:
 *
 *   1. **`WHISPER_CPP_BIN_DIR`** — explicit operator override. Always wins;
 *      an operator who set it has a reason.
 *   2. **`<PARACHUTE_HOME>/transcription/bin/`** — where `transcription
 *      install` puts the Linux release tarball's binaries. Ours, so we check
 *      it before anything system-wide.
 *   3. **Homebrew prefix** — `brew install whisper-cpp` is the macOS path and
 *      lands in `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin`
 *      (Intel). Checked explicitly rather than relying on PATH because a
 *      launchd-supervised daemon does NOT inherit a login shell's PATH, so
 *      `whisper-cli` can be perfectly installed and still invisible to the
 *      running vault. That's the single most likely way this breaks on a Mac.
 *   4. **`PATH`** — the ordinary case on Linux, and the escape hatch for any
 *      packaging we didn't anticipate.
 *
 * Returns absolute paths, never bare names, so the spawn can't be re-resolved
 * against a different PATH than the one we probed.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";
import type { TranscriptionEngine } from "./models.ts";

/** Binary name for an engine. */
export function binaryNameFor(engine: TranscriptionEngine): string {
  return engine === "whisper" ? "whisper-cli" : "parakeet-cli";
}

/** Homebrew prefixes worth probing, most likely first. */
const BREW_PREFIXES = ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"] as const;

export interface ResolveBinaryDeps {
  env?: NodeJS.ProcessEnv;
  existsImpl?: (p: string) => boolean;
}

/** The ecosystem root, mirroring `config.ts`'s resolution. */
function ecosystemRoot(env: NodeJS.ProcessEnv): string {
  return env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
}

/** Where `transcription install` writes downloaded binaries. */
export function managedBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ecosystemRoot(env), "transcription", "bin");
}

/** Where `transcription install` writes downloaded models. */
export function managedModelDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ecosystemRoot(env), "transcription", "models");
}

/**
 * Every directory the ladder will probe, in order. Exported so the install
 * verb and the admin UI can SHOW the operator where we looked — a "not found"
 * that lists the searched paths is debuggable; one that doesn't isn't.
 */
export function candidateBinDirs(deps: ResolveBinaryDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const dirs: string[] = [];

  const override = env.WHISPER_CPP_BIN_DIR?.trim();
  if (override) dirs.push(override);

  dirs.push(managedBinDir(env));

  for (const prefix of BREW_PREFIXES) dirs.push(join(prefix, "bin"));

  for (const p of (env.PATH ?? "").split(delimiter)) {
    const t = p.trim();
    if (t.length > 0) dirs.push(t);
  }

  // Dedupe, preserving order.
  return [...new Set(dirs)];
}

/**
 * Resolve a CLI to an absolute path, or `undefined` when it isn't anywhere we
 * look. See the module header for the ladder and why brew is probed explicitly.
 */
export function resolveCliBinary(
  engine: TranscriptionEngine,
  deps: ResolveBinaryDeps = {},
): string | undefined {
  const exists = deps.existsImpl ?? existsSync;
  const name = binaryNameFor(engine);
  for (const dir of candidateBinDirs(deps)) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Resolve `ffmpeg` the same way. Same launchd-PATH problem, same fix. */
export function resolveFfmpeg(deps: ResolveBinaryDeps = {}): string | undefined {
  const exists = deps.existsImpl ?? existsSync;
  for (const dir of candidateBinDirs(deps)) {
    const candidate = join(dir, "ffmpeg");
    if (exists(candidate)) return candidate;
  }
  return undefined;
}
