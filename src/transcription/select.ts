/**
 * Transcription provider selection + `transcribe-cpp` path resolution
 * (scribe-fold Phase 2a).
 *
 * Vault now ships TWO transcription providers behind the Phase 1
 * `TranscriptionProvider` seam:
 *
 *   - `scribe-http` — the remote/compat provider (the DEFAULT; existing scribe
 *     installs are unchanged);
 *   - `transcribe-cpp` — a local, no-Python provider that subprocesses the
 *     prebuilt `transcribe-cli` (opt-in via `transcription install` + config).
 *
 * The active provider is chosen by the `TRANSCRIPTION_PROVIDER` env var
 * (persisted in `~/.parachute/vault/.env`), resolved here so the worker boot
 * (`server.ts`) and the capability flag (`capability.ts`) agree on one source
 * of truth. Unset ⇒ `scribe-http`, so no config change means no behavior
 * change.
 *
 * The `transcribe-cli` binary + GGUF model live under
 * `$PARACHUTE_HOME/transcription/` (parallel to the vault's other ecosystem
 * state), written there by `transcription install`. Paths are resolved
 * per-call so `PARACHUTE_HOME` overrides (tests, Docker) apply.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

export const TRANSCRIPTION_PROVIDERS = ["scribe-http", "transcribe-cpp"] as const;
export type TranscriptionProviderName = (typeof TRANSCRIPTION_PROVIDERS)[number];

/**
 * Resolve the configured provider name. `TRANSCRIPTION_PROVIDER` selects it;
 * unset (or blank) ⇒ `scribe-http` (the behavior-preserving default). An
 * unrecognized value warns once and falls back to `scribe-http` rather than
 * failing boot — a typo shouldn't take transcription offline hard.
 */
export function resolveTranscriptionProviderName(
  env: NodeJS.ProcessEnv = process.env,
  logger: { warn?: (...args: unknown[]) => void } = console,
): TranscriptionProviderName {
  const raw = env.TRANSCRIPTION_PROVIDER?.trim();
  if (!raw) return "scribe-http";
  if ((TRANSCRIPTION_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as TranscriptionProviderName;
  }
  logger.warn?.(
    `[transcribe] unknown TRANSCRIPTION_PROVIDER="${raw}" — falling back to scribe-http. ` +
      `Valid values: ${TRANSCRIPTION_PROVIDERS.join(", ")}.`,
  );
  return "scribe-http";
}

/** The ecosystem root (shared with `config.ts`'s `configDirPath`), per-call so
 * `PARACHUTE_HOME` overrides apply in tests / Docker. */
function ecosystemRoot(env: NodeJS.ProcessEnv): string {
  return env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
}

/** The cache dir for transcribe-cpp's binary + models: `<root>/transcription/`. */
export function transcriptionHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ecosystemRoot(env), "transcription");
}

/** Resolved filesystem locations for the transcribe-cpp install. */
export interface TranscribeCppPaths {
  /** `<root>/transcription/`. */
  dir: string;
  /** `<dir>/bin/`. */
  binDir: string;
  /** The `transcribe-cli` binary path (env `TRANSCRIBE_CPP_BIN` overrides). */
  binPath: string;
  /** `<dir>/models/`. */
  modelsDir: string;
  /** `<dir>/install.json` — the install manifest. */
  manifestPath: string;
  /**
   * The active GGUF model path, or `undefined` when nothing is installed.
   * Env `TRANSCRIBE_CPP_MODEL` overrides; otherwise resolved from the
   * manifest's `modelFile` under `modelsDir`.
   */
  modelPath: string | undefined;
}

/** Persisted `install.json` shape (written by `transcription install`). */
export interface TranscribeCppManifest {
  version: string;
  asset: string;
  /** Binary filename under `bin/` (usually "transcribe-cli"). */
  binFile: string;
  /** Model id (e.g. "whisper-small.en"). */
  model: string;
  /** GGUF filename under `models/`. */
  modelFile: string;
  os: string;
  arch: string;
  ram_gb: number;
  installedAt: string;
}

/**
 * Resolve the transcribe-cpp binary + model paths. Env overrides
 * (`TRANSCRIBE_CPP_BIN`, `TRANSCRIBE_CPP_MODEL`) win; otherwise the binary is
 * `<dir>/bin/transcribe-cli` and the model comes from the install manifest.
 */
export function resolveTranscribeCppPaths(
  env: NodeJS.ProcessEnv = process.env,
): TranscribeCppPaths {
  const dir = transcriptionHomeDir(env);
  const binDir = join(dir, "bin");
  const modelsDir = join(dir, "models");
  const manifestPath = join(dir, "install.json");

  const binPath = env.TRANSCRIBE_CPP_BIN?.trim() || join(binDir, "transcribe-cli");

  let modelPath = env.TRANSCRIBE_CPP_MODEL?.trim() || undefined;
  if (!modelPath) {
    const manifest = readManifest(manifestPath);
    if (manifest?.modelFile) modelPath = join(modelsDir, manifest.modelFile);
  }

  return { dir, binDir, binPath, modelsDir, manifestPath, modelPath };
}

/** Read + parse the install manifest, or `null` when absent/unreadable. */
export function readManifest(manifestPath: string): TranscribeCppManifest | null {
  try {
    if (!existsSync(manifestPath)) return null;
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as TranscribeCppManifest;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Cheap, spawn-free readiness check: the binary AND a model both exist on disk.
 * Used by the worker-boot gate (`server.ts`) and the provider's `available()`.
 */
export function transcribeCppInstalled(
  paths: TranscribeCppPaths = resolveTranscribeCppPaths(),
): boolean {
  return existsSync(paths.binPath) && !!paths.modelPath && existsSync(paths.modelPath);
}
