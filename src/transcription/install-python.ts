/**
 * Runnable install routine for the Python-based local transcription providers
 * (parakeet-mlx / onnx-asr) — scribe-fold Phase 2b.
 *
 * Ported from scribe's proven `src/install-backend.ts` (apt system deps +
 * venv + warm-pull + re-verify; idempotent; non-fatal), adapted to vault's
 * conventions:
 *
 *   - **Managed venv under PARACHUTE_HOME.** The package installs into
 *     `<root>/transcription/venv/` and vault resolves the binary by ABSOLUTE
 *     path (see `select.ts`), so there's no "add the venv to your PATH"
 *     caveat and the whole install sandboxes under `PARACHUTE_HOME`. (Scribe
 *     preferred `uv tool install` with a `~/.venvs` fallback — the venv-only
 *     strategy here is the deliberate deviation; an operator's own on-PATH
 *     install still wins via the `select.ts` resolution ladder.)
 *   - **Total-RAM tiers, not free-RAM.** The ratified table (and Phase 2a's
 *     `install.ts`) gates on TOTAL RAM — a 2GB box shouldn't pick a 4GB
 *     provider just because it's momentarily idle. The onnx-asr 4GB floor IS
 *     the scribe#82 fix (Parakeet peak RAM exceeds 2GB on meeting-length
 *     audio; scribe auto-installed it at 2GB and OOMed).
 *   - **Honest activation stays in the CLI.** This module reports a runnable
 *     binary (or not); the caller flips `TRANSCRIPTION_PROVIDER` only when
 *     one exists (PRs #532/#533 precedent).
 *
 * Design contract (unchanged from scribe):
 *
 *   - **Non-fatal + idempotent.** Re-running is safe: a present binary is a
 *     no-op success; apt/pip of present packages is a no-op; the model
 *     warm-pull is best-effort. Every failure mode is a structured step, and
 *     `installPythonBackend` never throws.
 *   - **Privilege split.** pip runs user-level in the venv; apt is
 *     system-level — `sudo` when not root, and when neither is available we
 *     instruct rather than fail opaquely.
 *   - **Injected runner.** Every subprocess + platform probe goes through the
 *     `PythonInstallDeps` seam so tests exercise the tier guards, apt/venv
 *     logic, and idempotency WITHOUT installing anything.
 */

import { existsSync } from "fs";
import { join } from "path";
import {
  DEFAULT_ONNX_ASR_MODEL,
  DEFAULT_PARAKEET_MLX_MODEL,
  pythonVenvDir,
  resolveOnnxAsrBin,
  resolveParakeetMlxBin,
} from "./select.ts";
import { detectTotalRamBytes } from "./install.ts";
import { NOMINAL_SLACK_GB } from "./tiers.ts";

const GB = 2 ** 30;

export type PythonProviderName = "parakeet-mlx" | "onnx-asr";

/** Install spec per python provider — the single source of truth for the
 *  pip target, platform gates, and the ratified RAM floors. */
export interface PythonProviderSpec {
  provider: PythonProviderName;
  /** Binary the package installs (and the venv/PATH resolution target). */
  bin: string;
  /** pip install target, extras included. */
  pipTarget: string;
  /** OS restriction, when the provider only runs on one platform. */
  platform?: "darwin" | "linux";
  /** CPU-arch restriction (parakeet-mlx is MLX → Apple Silicon only). */
  arch?: "arm64";
  /** Ratified total-RAM floor, GB. `--force` bypasses; platform gates don't. */
  minRamGb: number;
  /** Default model id (env/manifest can override; see select.ts). */
  defaultModel: string;
  /** Approx model download footprint, MB (for the confirm prompt). */
  approxDiskMb: number;
  /** Human peak-RAM note (for the confirm prompt). */
  peakRamNote: string;
  /** Why the RAM floor sits where it does — printed on refusal. */
  ramFloorRationale: string;
}

export const PYTHON_PROVIDERS: Record<PythonProviderName, PythonProviderSpec> = {
  "parakeet-mlx": {
    provider: "parakeet-mlx",
    bin: "parakeet-mlx",
    pipTarget: "parakeet-mlx",
    platform: "darwin",
    arch: "arm64",
    minRamGb: 8,
    defaultModel: DEFAULT_PARAKEET_MLX_MODEL,
    approxDiskMb: 2500,
    peakRamNote: "~2.5–3GB peak while transcribing",
    ramFloorRationale:
      "parakeet-mlx peaks at ~2.5–3GB while transcribing; below 8GB total, use transcribe-cpp instead (`transcription install`).",
  },
  "onnx-asr": {
    provider: "onnx-asr",
    bin: "onnx-asr",
    pipTarget: "onnx-asr[cpu,hub]",
    minRamGb: 4,
    defaultModel: DEFAULT_ONNX_ASR_MODEL,
    approxDiskMb: 670,
    peakRamNote: "~1.2–2GB+ peak while transcribing (meeting-length audio uses the high end)",
    ramFloorRationale:
      "Parakeet's peak RAM exceeds 2GB on meeting-length audio (scribe#82) — below 4GB total, use transcribe-cpp with a small whisper model instead (`transcription install`).",
  },
};

/** Outcome of one subprocess step. */
export type RunResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Injectable side-effect seam. Defaults run real subprocesses / read real
 * platform state; tests inject stubs so nothing is actually installed.
 */
export interface PythonInstallDeps {
  /** Run a command, capturing exit code + output. Never throws. */
  run: (cmd: string[]) => Promise<RunResult>;
  /** PATH lookup. */
  which: (bin: string) => string | null;
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  /** Detected total physical RAM in bytes. */
  totalRamBytes: number;
  /** Effective uid; `0` means root. */
  uid: () => number;
  /** Environment (for bin resolution + PARACHUTE_HOME). */
  env: NodeJS.ProcessEnv;
  /** Existence probe. */
  existsImpl: (p: string) => boolean;
  /** Sink for human-readable progress lines. */
  log: (line: string) => void;
}

/** Real subprocess runner — captures output, never throws. */
const defaultRun: PythonInstallDeps["run"] = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    // ENOENT / spawn failure → a reportable step failure, not a throw.
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 127, stdout: "", stderr: message };
  }
};

/** Build the default (real-side-effect) deps. */
export function buildDefaultPythonDeps(): PythonInstallDeps {
  return {
    run: defaultRun,
    which: (bin) => Bun.which(bin),
    platform: process.platform,
    arch: process.arch,
    totalRamBytes: detectTotalRamBytes(),
    uid: () => (typeof process.getuid === "function" ? process.getuid() : 0),
    env: process.env,
    existsImpl: existsSync,
    log: (line) => console.log(line),
  };
}

export type PythonInstallStep = {
  name: string;
  status: "ok" | "skipped" | "failed" | "refused";
  detail: string;
};

/** Result of an install run. */
export interface PythonInstallOutcome {
  /** True when a runnable binary was verified at the end. */
  ok: boolean;
  provider: PythonProviderName;
  /** Ordered step log (machine-readable companion to the human `log`). */
  steps: PythonInstallStep[];
  /** One-line summary for the caller. */
  summary: string;
  /** The resolved runnable binary, when `ok`. The caller activates off this. */
  binPath?: string;
  /** The venv the package landed in ("" when the binary came from PATH/env). */
  venv?: string;
}

export interface PythonInstallOptions {
  provider: PythonProviderName;
  /** Bypass the RAM floor (operator override). Platform gates are never bypassed. */
  force?: boolean;
  /** Skip the (slow) model warm-pull. */
  skipModel?: boolean;
  /** Model id to warm-pull. Defaults to the spec's defaultModel. */
  model?: string;
}

/** Resolve the provider's binary via select.ts's ladder against these deps. */
function resolveBin(spec: PythonProviderSpec, deps: PythonInstallDeps): string | undefined {
  const resolveDeps = { existsImpl: deps.existsImpl, whichImpl: deps.which };
  return spec.provider === "parakeet-mlx"
    ? resolveParakeetMlxBin(deps.env, resolveDeps)
    : resolveOnnxAsrBin(deps.env, resolveDeps);
}

/**
 * Install + verify a python transcription provider. Pure orchestration over
 * the injected `deps`; returns a structured outcome and never throws.
 */
export async function installPythonBackend(
  deps: PythonInstallDeps,
  opts: PythonInstallOptions,
): Promise<PythonInstallOutcome> {
  const spec = PYTHON_PROVIDERS[opts.provider];
  const steps: PythonInstallStep[] = [];
  const record = (s: PythonInstallStep): PythonInstallStep => {
    steps.push(s);
    return s;
  };
  const fail = (summary: string): PythonInstallOutcome => ({
    ok: false,
    provider: spec.provider,
    steps,
    summary,
  });

  // --- Platform / arch gates (never bypassed — the runtime can't exist) -----
  if (spec.platform && spec.platform !== deps.platform) {
    const detail = `${spec.provider} only runs on ${spec.platform}; this host is ${deps.platform}. Run \`transcription install\` (no --provider) for this host's tier default.`;
    deps.log(detail);
    record({ name: "platform-guard", status: "refused", detail });
    return fail(detail);
  }
  if (spec.arch && spec.arch !== deps.arch) {
    const detail = `${spec.provider} needs ${spec.arch} (Apple Silicon); this host is ${deps.platform}/${deps.arch}. Run \`transcription install\` (no --provider) for this host's tier default.`;
    deps.log(detail);
    record({ name: "platform-guard", status: "refused", detail });
    return fail(detail);
  }
  record({ name: "platform-guard", status: "ok", detail: `${deps.platform}/${deps.arch} supported.` });

  // --- RAM floor (ratified tiers; --force bypasses with a loud warning) -----
  const totalGb = Math.round((deps.totalRamBytes / GB) * 10) / 10;
  if (totalGb < spec.minRamGb - NOMINAL_SLACK_GB) {
    if (opts.force) {
      const detail = `--force: proceeding below the ${spec.minRamGb}GB floor (${totalGb}GB detected). ${spec.ramFloorRationale}`;
      deps.log(`⚠  ${detail}`);
      record({ name: "ram-guard", status: "skipped", detail });
    } else {
      const detail = `only ${totalGb}GB RAM detected — ${spec.provider} needs ~${spec.minRamGb}GB. ${spec.ramFloorRationale} (--force overrides.)`;
      deps.log(detail);
      record({ name: "ram-guard", status: "refused", detail });
      return fail(detail);
    }
  } else {
    record({
      name: "ram-guard",
      status: "ok",
      detail: `${totalGb}GB total RAM ≥ the ${spec.minRamGb}GB ${spec.provider} floor.`,
    });
  }

  deps.log(`Installing local transcription provider: ${spec.provider} (${spec.pipTarget})`);

  // --- System deps (python3 + ffmpeg) ---------------------------------------
  if (deps.platform === "linux") {
    const aptStep = await ensureLinuxSystemDeps(deps);
    record(aptStep);
    if (aptStep.status === "failed") {
      return fail(`System dependency install failed: ${aptStep.detail}`);
    }
  } else {
    // macOS: python3 ships with the CLT; ffmpeg is a brew concern we check +
    // instruct rather than drive blindly (scribe's proven split).
    if (deps.which("python3") === null) {
      const detail =
        "python3 not found. Install the Xcode Command Line Tools (`xcode-select --install`) or `brew install python3`, then re-run.";
      record({ name: "system-deps", status: "failed", detail });
      return fail(detail);
    }
    record({
      name: "system-deps",
      status: deps.which("ffmpeg") === null ? "skipped" : "ok",
      detail:
        deps.which("ffmpeg") === null
          ? "python3 present. ffmpeg is missing (needed to decode non-WAV capture audio) — install it with `brew install ffmpeg`."
          : "python3 + ffmpeg present.",
    });
  }

  // --- Python package into the managed venv ---------------------------------
  const pkgStep = await ensureVenvPackage(deps, spec);
  record(pkgStep);
  if (pkgStep.status === "failed") {
    return fail(`Package install failed: ${pkgStep.detail}`);
  }

  // --- Warm-pull the model (onnx-asr only; best-effort, never fatal) --------
  if (opts.skipModel) {
    record({ name: "model-warm-pull", status: "skipped", detail: "Skipped by request." });
  } else {
    record(await warmPullModel(deps, spec, opts.model ?? spec.defaultModel));
  }

  // --- Verify: a runnable binary via the same ladder the daemon uses --------
  const binPath = resolveBin(spec, deps);
  const runnable = !!binPath && deps.existsImpl(binPath);
  const venv = pythonVenvDir(deps.env);
  if (!runnable) {
    const detail = `install ran but no runnable \`${spec.bin}\` was found (looked at ${join(venv, "bin", spec.bin)} and PATH).`;
    record({ name: "verify", status: "failed", detail });
    return fail(`${spec.provider} install did not produce a runnable binary. ${detail}`);
  }
  record({ name: "verify", status: "ok", detail: `runnable binary at ${binPath}.` });

  const summary = `${spec.provider} installed and verified runnable (${binPath}).`;
  deps.log(summary);
  return {
    ok: true,
    provider: spec.provider,
    steps,
    summary,
    binPath,
    venv: binPath!.startsWith(venv) ? venv : "",
  };
}

/** sudo-if-needed prefix: `[]` when root, `["sudo"]` otherwise (when sudo exists). */
function sudoPrefix(deps: PythonInstallDeps): {
  prefix: string[];
  haveRoot: boolean;
  haveSudo: boolean;
} {
  const haveRoot = deps.uid() === 0;
  const haveSudo = deps.which("sudo") !== null;
  return { prefix: haveRoot ? [] : haveSudo ? ["sudo"] : [], haveRoot, haveSudo };
}

/**
 * Ensure python3 (+venv +pip) and ffmpeg on Debian/Ubuntu via apt. Idempotent:
 * already-present binaries skip apt entirely; apt itself no-ops on installed
 * packages. Needs root or sudo; instructs when neither is available. Ported
 * from scribe's `ensureLinuxSystemDeps`.
 */
async function ensureLinuxSystemDeps(deps: PythonInstallDeps): Promise<PythonInstallStep> {
  const pyOk = deps.which("python3") !== null;
  const ffOk = deps.which("ffmpeg") !== null;
  if (pyOk && ffOk) {
    return { name: "system-deps", status: "skipped", detail: "python3 + ffmpeg already present." };
  }

  const apt = deps.which("apt-get") ?? deps.which("apt");
  if (apt === null) {
    return {
      name: "system-deps",
      status: "failed",
      detail:
        "No apt found and python3/ffmpeg missing. Install them with your package manager, then re-run.",
    };
  }

  const { prefix, haveRoot, haveSudo } = sudoPrefix(deps);
  if (!haveRoot && !haveSudo) {
    return {
      name: "system-deps",
      status: "failed",
      detail:
        "Need root or sudo to apt-install python3/python3-venv/ffmpeg. Re-run as root, or run: `sudo apt-get install -y python3 python3-venv python3-pip ffmpeg`, then re-run this command.",
    };
  }

  const pkgs = ["python3", "python3-venv", "python3-pip", "ffmpeg"];
  deps.log(`Installing system deps via apt: ${pkgs.join(" ")} …`);
  // `apt-get update` is best-effort — a transient mirror failure shouldn't
  // abort if the cache is already warm; report and continue.
  const update = await deps.run([...prefix, "apt-get", "update"]);
  if (update.exitCode !== 0) {
    deps.log(`apt-get update returned ${update.exitCode} (continuing): ${update.stderr.trim()}`);
  }
  const install = await deps.run([...prefix, "apt-get", "install", "-y", ...pkgs]);
  if (install.exitCode !== 0) {
    return {
      name: "system-deps",
      status: "failed",
      detail: `apt-get install failed (exit ${install.exitCode}): ${install.stderr.trim() || install.stdout.trim()}`,
    };
  }
  return { name: "system-deps", status: "ok", detail: `Installed: ${pkgs.join(", ")}.` };
}

/**
 * Install the provider's python package into the managed venv. Idempotent: a
 * binary already resolvable (env override / venv / PATH) skips the install.
 */
async function ensureVenvPackage(
  deps: PythonInstallDeps,
  spec: PythonProviderSpec,
): Promise<PythonInstallStep> {
  const existing = resolveBin(spec, deps);
  if (existing && deps.existsImpl(existing)) {
    return {
      name: "package",
      status: "skipped",
      detail: `\`${spec.bin}\` already runnable at ${existing} — nothing to install.`,
    };
  }

  const venv = pythonVenvDir(deps.env);
  const pip = join(venv, "bin", "pip");

  // Create the venv (idempotent: re-running `python3 -m venv` on an existing
  // venv is harmless).
  const mk = await deps.run(["python3", "-m", "venv", venv]);
  if (mk.exitCode !== 0) {
    return {
      name: "package",
      status: "failed",
      detail: `Could not create venv at ${venv} (exit ${mk.exitCode}): ${mk.stderr.trim() || mk.stdout.trim()}. Is python3-venv installed?`,
    };
  }

  deps.log(`Installing ${spec.pipTarget} into ${venv} via pip (this can take a few minutes) …`);
  const install = await deps.run([pip, "install", spec.pipTarget]);
  if (install.exitCode !== 0) {
    return {
      name: "package",
      status: "failed",
      detail: `pip install ${spec.pipTarget} failed (exit ${install.exitCode}): ${install.stderr.trim().slice(-800) || install.stdout.trim().slice(-800)}`,
    };
  }
  return {
    name: "package",
    status: "ok",
    detail: `Installed ${spec.pipTarget} into ${venv} (binary: ${join(venv, "bin", spec.bin)}).`,
  };
}

/**
 * Warm-pull the model so the first real transcription isn't a long cold
 * download. onnx-asr only — parakeet-mlx fetches its model implicitly on
 * first use and has no separate pull verb (scribe's proven split).
 * Best-effort: always `ok`/`skipped`, never `failed`.
 *
 * FRAGILE (inherited from scribe): assumes `onnx-asr <model> --help` triggers
 * the model fetch+cache without an audio file. Worst case is a silent no-op —
 * the model still lazy-loads on the first transcription — but verify against
 * the real onnx-asr CLI when bumping it.
 */
async function warmPullModel(
  deps: PythonInstallDeps,
  spec: PythonProviderSpec,
  model: string,
): Promise<PythonInstallStep> {
  if (spec.provider !== "onnx-asr") {
    return {
      name: "model-warm-pull",
      status: "skipped",
      detail: `${spec.provider} downloads its model (~${spec.approxDiskMb}MB) on first transcription — no separate warm-pull.`,
    };
  }
  const bin = resolveBin(spec, deps) ?? join(pythonVenvDir(deps.env), "bin", spec.bin);
  deps.log(`Warm-pulling model ${model} (~${spec.approxDiskMb}MB one-time download) …`);
  const r = await deps.run([bin, model, "--help"]);
  if (r.exitCode === 0) {
    return { name: "model-warm-pull", status: "ok", detail: `Model ${model} cached.` };
  }
  return {
    name: "model-warm-pull",
    status: "skipped",
    detail: `Could not warm-pull ${model} now (exit ${r.exitCode}); it will download on the first transcription.`,
  };
}
