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
 * The `transcribe-cli` binary, GGUF model, and runtime shared libraries live
 * under `$PARACHUTE_HOME/transcription/` (parallel to the vault's other
 * ecosystem state), written there by `transcription install`. NOTE:
 * transcribe.cpp v0.1.1 ships a *library*, not a prebuilt CLI, so after an
 * install the `libs/` + `models/` are present but `bin/transcribe-cli` may be
 * absent until a CLI is built or `TRANSCRIBE_CPP_BIN` is set — the readiness
 * checks below gate on the binary existing. Paths are resolved per-call so
 * `PARACHUTE_HOME` overrides (tests, Docker) apply.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

export const TRANSCRIPTION_PROVIDERS = [
  "scribe-http",
  "transcribe-cpp",
  "parakeet-mlx",
  "onnx-asr",
] as const;
export type TranscriptionProviderName = (typeof TRANSCRIPTION_PROVIDERS)[number];

/**
 * Default models for the Python-based local providers (scribe-fold Phase 2b —
 * the ratified RAM-tier table, 2026-07-03).
 *
 *   - parakeet-mlx drives the `parakeet-mlx` CLI (MLX, Apple Silicon); the
 *     model is an mlx-community HuggingFace repo fetched into the HF cache on
 *     first use (~2.5GB).
 *   - onnx-asr drives the `onnx-asr` CLI (ONNX Runtime, CPU); the model id is
 *     onnx-asr's own registry name for NVIDIA Parakeet TDT 0.6b v3 (int8 ONNX,
 *     ~670MB), fetched on first use / warm-pulled at install.
 */
export const DEFAULT_PARAKEET_MLX_MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
export const DEFAULT_ONNX_ASR_MODEL = "nemo-parakeet-tdt-0.6b-v3";

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
  /** The `transcribe-cli` binary path (env `TRANSCRIBE_CPP_BIN` overrides).
   *  May not exist on disk — v0.1.1 ships a library, not a CLI. */
  binPath: string;
  /** `<dir>/libs/` — the extracted runtime shared libraries (libtranscribe +
   *  libggml) the CLI links against. */
  libsDir: string;
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
  /** Runtime shared-library filenames extracted under `libs/` (libtranscribe +
   *  libggml). v0.1.1 ships these instead of a CLI. */
  libFiles?: string[];
  /** When the `transcribe-cli` was built from source at install, the pinned
   *  upstream source ref it was compiled from. Absent when no CLI was built
   *  (build skipped/failed, or an operator-supplied `TRANSCRIBE_CPP_BIN`). */
  binBuiltFrom?: string;
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
  const libsDir = join(dir, "libs");
  const modelsDir = join(dir, "models");
  const manifestPath = join(dir, "install.json");

  const binPath = env.TRANSCRIBE_CPP_BIN?.trim() || join(binDir, "transcribe-cli");

  let modelPath = env.TRANSCRIBE_CPP_MODEL?.trim() || undefined;
  if (!modelPath) {
    const manifest = readManifest(manifestPath);
    if (manifest?.modelFile) modelPath = join(modelsDir, manifest.modelFile);
  }

  return { dir, binDir, binPath, libsDir, modelsDir, manifestPath, modelPath };
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
 * Cheap, spawn-free readiness check: a runnable `transcribe-cli` binary AND a
 * model both exist on disk. Used by the worker-boot gate (`server.ts`) and
 * mirrors the provider's `available()`. Because v0.1.1 ships a library (no CLI),
 * this stays `false` after an install until a CLI is built or
 * `TRANSCRIBE_CPP_BIN` points at one — so the worker never starts only to
 * terminal-fail every item.
 */
export function transcribeCppInstalled(
  paths: TranscribeCppPaths = resolveTranscribeCppPaths(),
): boolean {
  return existsSync(paths.binPath) && !!paths.modelPath && existsSync(paths.modelPath);
}

/** Outcome of the EXECUTED runnable probe (`probeTranscribeCliRunnable`). */
export interface RunnableProbeResult {
  ok: boolean;
  /** Why the probe failed, for the `runnable: no (<reason>)` print. */
  reason?: string;
}

/**
 * EXECUTED runnable probe: actually launch `transcribe-cli --help` and check
 * the exit code. Cheap (no model load, no inference — upstream's `--help`
 * prints usage and exits 0) but honest where a stat can't be: it catches a
 * binary whose shared libraries don't resolve (broken/missing `libs/`, a bad
 * rpath), a wrong-arch or corrupt binary, and a missing exec bit — all cases
 * where `existsSync` says "yes" while every real run fails (the vault#534
 * honesty bug: Linux installs reported `runnable: yes` while the CLI exited 1
 * on every transcription).
 *
 * Deliberately NOT used by the per-request capability gate or the provider's
 * `available()` (both are documented spawn-free); this is for the human-paced
 * paths — `transcription status` and the install verb's activation check.
 */
export async function probeTranscribeCliRunnable(
  binPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<RunnableProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([binPath, "--help"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  } catch (err) {
    return {
      ok: false,
      reason: `could not launch ${binPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL"); // diagnostic probe — no graceful shutdown to preserve
  }, timeoutMs);
  try {
    const exitCode = await proc.exited;
    if (timedOut) return { ok: false, reason: `--help did not exit within ${timeoutMs}ms` };
    // stderr normally EOFs at exit; the race guards against a wrapper-script
    // binary whose orphaned grandchild still holds the pipe open.
    const stderr = await Promise.race([
      new Response(proc.stderr as ReadableStream).text(),
      new Promise<string>((resolve) => setTimeout(resolve, 2_000, "")),
    ]);
    const detail = stderr.trim().split("\n")[0]?.slice(0, 200);
    if (proc.signalCode) {
      // e.g. macOS dyld aborts with SIGABRT when a linked dylib is missing.
      return { ok: false, reason: `--help died on ${proc.signalCode}${detail ? `: ${detail}` : ""}` };
    }
    if (exitCode !== 0) {
      return { ok: false, reason: `--help exited ${exitCode}${detail ? `: ${detail}` : ""}` };
    }
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Python-based local providers (parakeet-mlx / onnx-asr) — scribe-fold 2b
// ---------------------------------------------------------------------------

/**
 * The dedicated venv `transcription install` creates for the Python-based
 * providers: `<root>/transcription/venv/`. A deliberate deviation from
 * scribe's installer (which preferred `uv tool install` + a `~/.venvs`
 * fallback and then had to caveat "add the venv to your PATH"): vault resolves
 * the venv binary by ABSOLUTE path, so the daemon needs no PATH surgery and
 * the whole install is sandboxed under `PARACHUTE_HOME` (tests, Docker).
 */
export function pythonVenvDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(transcriptionHomeDir(env), "venv");
}

/** `<root>/transcription/install-python.json` — the python-provider install manifest. */
export function pythonManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(transcriptionHomeDir(env), "install-python.json");
}

/** Persisted manifest for a python-provider install (written by `transcription install`). */
export interface PythonInstallManifest {
  /** Which provider this install set up ("parakeet-mlx" | "onnx-asr"). */
  provider: string;
  /** The pip install target (e.g. "onnx-asr[cpu,hub]"). */
  pipTarget: string;
  /** Resolved binary path at install time. */
  bin: string;
  /** The venv the package landed in ("" when the binary came from PATH). */
  venv: string;
  /** Model id the provider was configured with. */
  model: string;
  os: string;
  arch: string;
  ram_gb: number;
  installedAt: string;
}

/** Read + parse the python install manifest, or `null` when absent/unreadable. */
export function readPythonManifest(
  manifestPath: string = pythonManifestPath(),
): PythonInstallManifest | null {
  try {
    if (!existsSync(manifestPath)) return null;
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as PythonInstallManifest;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Injection seams for binary resolution (tests stub the fs + PATH probes). */
export interface BinResolveDeps {
  existsImpl?: (p: string) => boolean;
  whichImpl?: (bin: string) => string | null;
}

/**
 * Resolve a python-provider binary. Ladder (first hit wins):
 *
 *   1. an explicit env override (`PARAKEET_MLX_BIN` / `ONNX_ASR_BIN`) —
 *      returned verbatim, existence-checked by the caller (mirrors
 *      `TRANSCRIBE_CPP_BIN`'s contract);
 *   2. the managed venv binary `<root>/transcription/venv/bin/<bin>` when it
 *      exists (vault's own install — deterministic under the daemon);
 *   3. a PATH-installed binary via `Bun.which` (an operator's own
 *      `uv tool install` / pipx install keeps working).
 *
 * Returns `undefined` when nothing is found — the provider reports itself
 * unavailable and the worker-boot gate stays closed.
 */
function resolvePythonBin(
  envVar: string,
  bin: string,
  env: NodeJS.ProcessEnv,
  deps: BinResolveDeps,
): string | undefined {
  const override = env[envVar]?.trim();
  if (override) return override;
  const exists = deps.existsImpl ?? existsSync;
  const which = deps.whichImpl ?? ((b: string) => Bun.which(b));
  const venvBin = join(pythonVenvDir(env), "bin", bin);
  if (exists(venvBin)) return venvBin;
  return which(bin) ?? undefined;
}

/** Resolve the `parakeet-mlx` binary (env `PARAKEET_MLX_BIN` → venv → PATH). */
export function resolveParakeetMlxBin(
  env: NodeJS.ProcessEnv = process.env,
  deps: BinResolveDeps = {},
): string | undefined {
  return resolvePythonBin("PARAKEET_MLX_BIN", "parakeet-mlx", env, deps);
}

/** Resolve the `onnx-asr` binary (env `ONNX_ASR_BIN` → venv → PATH). */
export function resolveOnnxAsrBin(
  env: NodeJS.ProcessEnv = process.env,
  deps: BinResolveDeps = {},
): string | undefined {
  return resolvePythonBin("ONNX_ASR_BIN", "onnx-asr", env, deps);
}

/** Model resolution: env override → install manifest → ratified default. */
function resolvePythonModel(
  envVar: string,
  provider: string,
  fallback: string,
  env: NodeJS.ProcessEnv,
): string {
  const override = env[envVar]?.trim();
  if (override) return override;
  const manifest = readPythonManifest(pythonManifestPath(env));
  if (manifest?.provider === provider && manifest.model) return manifest.model;
  return fallback;
}

/** The parakeet-mlx model id (`PARAKEET_MLX_MODEL` → manifest → default v3). */
export function resolveParakeetMlxModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePythonModel("PARAKEET_MLX_MODEL", "parakeet-mlx", DEFAULT_PARAKEET_MLX_MODEL, env);
}

/** The onnx-asr model id (`ONNX_ASR_MODEL` → manifest → default parakeet v3 int8). */
export function resolveOnnxAsrModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePythonModel("ONNX_ASR_MODEL", "onnx-asr", DEFAULT_ONNX_ASR_MODEL, env);
}

/**
 * Cheap, spawn-free readiness check for a python provider: a resolved binary
 * that exists on disk. (The MODEL is fetched into the HF cache on first use —
 * there is no cheap on-disk check for it, so readiness is binary-only,
 * matching the providers' `available()`.) Used by the worker-boot gate and
 * `transcription status`.
 */
export function parakeetMlxInstalled(
  env: NodeJS.ProcessEnv = process.env,
  deps: BinResolveDeps = {},
): boolean {
  const bin = resolveParakeetMlxBin(env, deps);
  return !!bin && (deps.existsImpl ?? existsSync)(bin);
}

/** See `parakeetMlxInstalled`. */
export function onnxAsrInstalled(
  env: NodeJS.ProcessEnv = process.env,
  deps: BinResolveDeps = {},
): boolean {
  const bin = resolveOnnxAsrBin(env, deps);
  return !!bin && (deps.existsImpl ?? existsSync)(bin);
}
