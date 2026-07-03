/**
 * Install planning for the `transcribe-cpp` local transcription provider
 * (scribe-fold Phase 2a).
 *
 * This module is the PURE decision layer for `parachute-vault transcription
 * install`: given the host OS/arch and total RAM, which prebuilt
 * `transcribe-cli` release asset and which GGUF model should we fetch? It has
 * NO side effects (no network, no fs writes) so the CLI's `--dry-run`/plan path
 * — and the tests — exercise the full selection matrix without downloading a
 * byte.
 *
 * ## Why transcribe.cpp, and why the SUBPROCESS path
 *
 * Ratified 2026-07-03 (Aaron): adopt **transcribe.cpp**
 * (github.com/handy-computer/transcribe.cpp — CJ Pais / Mozilla.ai, MIT,
 * "llama.cpp for STT") as the recommended low-RAM / no-Python local provider,
 * ahead of whisper.cpp. Its in-process N-API/TypeScript binding crashes on Bun,
 * so we drive a `transcribe-cli` as a subprocess instead — structurally like
 * the `scribe-http` provider but local. See `providers/transcribe-cpp.ts`.
 *
 * ## What v0.1.1 actually ships (live-verified 2026-07-03)
 *
 * IMPORTANT: the v0.1.1 macOS/Linux release tarballs contain a **library** —
 * `libtranscribe.{dylib,so}` + `libggml*.{dylib,so}` + `contract.json` +
 * licenses — and **NO prebuilt `transcribe-cli` executable** (the CLI is
 * build-from-source in v0.1.1). So the install verb fetches the tarball for its
 * runtime shared libraries, downloads the GGUF model, and then honestly reports
 * the CLI-acquisition gap: activate transcribe-cpp only when a runnable CLI is
 * available (`TRANSCRIBE_CPP_BIN`, or a binary a future asset includes, or one
 * built from source against these libs). GGUF models ARE published under the
 * handy-computer HuggingFace org and download normally.
 *
 * ## The RAM-tier matrix (scribe#82 fix)
 *
 * scribe#82: today scribe auto-installs Parakeet-0.6b at 2GB and OOMs on long
 * audio. The floor here is the fix — Parakeet is gated to ≥4GB; 2–4GB gets
 * whisper-small, 1–2GB whisper-tiny, and <1GB is refused (steer to the
 * scribe-http remote provider). Model picks below are the quantized GGUF
 * variants published under the handy-computer HuggingFace org.
 */

import { existsSync, readFileSync } from "fs";
import { totalmem } from "os";

/**
 * Pinned upstream release. The prebuilt `transcribe-cli` bundles + the GGUF
 * model quants are pulled from this tag. Bump deliberately (a newer CLI may
 * change flags/output) — the provider's arg + output parsing is validated
 * against this version.
 */
export const TRANSCRIBE_CPP_VERSION = "0.1.1";

const RELEASE_BASE = `https://github.com/handy-computer/transcribe.cpp/releases/download/v${TRANSCRIBE_CPP_VERSION}`;
const HF_BASE = "https://huggingface.co/handy-computer";

const GB = 2 ** 30;

/** A concrete GGUF model choice: where to fetch it and its rough footprint. */
export interface ModelChoice {
  /** Human/config id (e.g. "whisper-tiny.en"). Used for `--model` + the manifest. */
  name: string;
  /** HuggingFace repo under handy-computer. */
  repo: string;
  /** The GGUF filename within the repo (a quantized variant). */
  file: string;
  /** Full resolve URL for the GGUF. */
  url: string;
  /** Approx on-disk size of the GGUF, MB (for the "footprint" print). */
  approxSizeMb: number;
  /** Approx peak process RAM while transcribing, GB — the tier gate rationale. */
  approxRuntimeGb: number;
  /** Short human quality/latency note surfaced in the plan. */
  note: string;
}

function model(
  name: string,
  repo: string,
  file: string,
  approxSizeMb: number,
  approxRuntimeGb: number,
  note: string,
): ModelChoice {
  return { name, repo, file, url: `${HF_BASE}/${repo}/resolve/main/${file}`, approxSizeMb, approxRuntimeGb, note };
}

/**
 * The selectable models, keyed by `--model` id. Quantized (Q5_K_M / Q8_0)
 * variants keep the footprint honest for the low-RAM tiers. Only models
 * actually published under handy-computer are listed — whisper-base is NOT
 * on that org, so the 2–4GB tier uses whisper-small.
 */
export const MODELS: Record<string, ModelChoice> = {
  "whisper-tiny.en": model(
    "whisper-tiny.en",
    "whisper-tiny.en-gguf",
    "whisper-tiny.en-Q5_K_M.gguf",
    42,
    0.4,
    "fastest, lowest quality — English only",
  ),
  "whisper-small.en": model(
    "whisper-small.en",
    "whisper-small.en-gguf",
    "whisper-small.en-Q5_K_M.gguf",
    190,
    1.3,
    "good quality/speed balance — English only",
  ),
  "parakeet-tdt-0.6b-v3": model(
    "parakeet-tdt-0.6b-v3",
    "parakeet-tdt-0.6b-v3-gguf",
    "parakeet-tdt-0.6b-v3-Q8_0.gguf",
    660,
    3.5,
    "highest quality (NVIDIA Parakeet) — needs headroom for long audio",
  ),
};

/**
 * RAM tiers, richest-first. A host with `total RAM >= minGb` gets `model`.
 * Below the smallest tier (<1GB) local transcription is refused and the
 * operator is steered to the scribe-http remote provider.
 *
 * The Parakeet floor at 4GB is the scribe#82 fix: it used to auto-install at
 * 2GB and OOM on long audio.
 */
export const RAM_TIERS: ReadonlyArray<{ minGb: number; model: string }> = [
  { minGb: 4, model: "parakeet-tdt-0.6b-v3" },
  { minGb: 2, model: "whisper-small.en" },
  { minGb: 1, model: "whisper-tiny.en" },
];

/** The lowest RAM (bytes) at which we'll still install a local model. */
export const MIN_LOCAL_RAM_BYTES = 1 * GB;

/**
 * Pick the tier-appropriate model for `totalRamBytes`, or `null` when there
 * isn't enough RAM to run any local model (steer to remote). Selection is by
 * TOTAL RAM (not free) — a 2GB box shouldn't pick a 4GB model just because it's
 * momentarily idle.
 */
export function selectModelForRam(totalRamBytes: number): ModelChoice | null {
  const gb = totalRamBytes / GB;
  for (const tier of RAM_TIERS) {
    if (gb >= tier.minGb) return MODELS[tier.model]!;
  }
  return null;
}

/** A release asset: its filename + full download URL. */
export interface AssetChoice {
  asset: string;
  url: string;
}

/**
 * Does `name` look like a shared library we keep from the release tarball?
 * transcribe.cpp v0.1.1's macOS/Linux assets ship `libtranscribe.{dylib,so}` +
 * `libggml*.{dylib,so}` (the ggml runtime the CLI links against) — NOT a
 * prebuilt `transcribe-cli`. The install verb extracts these so a
 * build-from-source or `TRANSCRIBE_CPP_BIN` CLI can link against them.
 */
export function isSharedLibFile(name: string): boolean {
  return /\.(dylib|so)(\.\d+)*$/i.test(name);
}

/**
 * Map a Node `platform`/`arch` to the matching `transcribe-native` release
 * asset, or `null` when no asset exists for the host (→ steer to the scribe-http
 * remote provider). Asset names follow the upstream
 * `transcribe-native-<version>-<platform>-<backend>.tar.gz` convention. NOTE: in
 * v0.1.1 this asset is a **library** bundle (see the module header), not a
 * prebuilt CLI.
 *
 * `arch` is Node's `os.arch()` value: `"x64"` / `"arm64"`.
 */
export function selectAsset(platform: string, arch: string): AssetChoice | null {
  const v = TRANSCRIBE_CPP_VERSION;
  let asset: string | null = null;
  if (platform === "linux") {
    if (arch === "x64") asset = `transcribe-native-${v}-linux-x86_64-cpu-vulkan.tar.gz`;
    else if (arch === "arm64") asset = `transcribe-native-${v}-linux-aarch64-cpu-vulkan.tar.gz`;
  } else if (platform === "darwin") {
    if (arch === "arm64") asset = `transcribe-native-${v}-macos-arm64-metal.tar.gz`;
    else if (arch === "x64") asset = `transcribe-native-${v}-macos-x86_64-cpu.tar.gz`;
  }
  if (!asset) return null;
  return { asset, url: `${RELEASE_BASE}/${asset}` };
}

/** The resolved install plan — what `transcription install` would fetch. */
export interface InstallPlan {
  /** True when a binary + model were selected and the install can proceed. */
  supported: boolean;
  /** Host platform (Node `os.platform()`). */
  platform: string;
  /** Host arch (Node `os.arch()`). */
  arch: string;
  /** Detected total RAM, GB (rounded to 1dp) for the human print. */
  totalRamGb: number;
  /** Set when `supported` is false: why, and (for refused) the remote steer. */
  reason?: string;
  /**
   * True when the host COULD run a binary but has too little RAM for any
   * model (<1GB) — distinct from an unsupported platform. Steer to remote.
   */
  refused?: boolean;
  /** The prebuilt binary asset (present whenever the platform is supported). */
  asset?: AssetChoice;
  /** The chosen GGUF model (absent when refused/unsupported). */
  model?: ModelChoice;
  /** Approx total download footprint, MB (model GGUF; the binary is small). */
  footprintMb?: number;
}

export interface PlanInput {
  platform: string;
  arch: string;
  totalRamBytes: number;
  /** Operator `--model <id>` override; must key into `MODELS`. */
  overrideModel?: string;
}

/**
 * Resolve the full install plan from host facts. Pure — the CLI prints this on
 * the `--dry-run`/plan path and only fetches when the operator confirms.
 *
 * Order of refusal:
 *   1. Unsupported platform/arch (no prebuilt) → `supported:false`, steer remote.
 *   2. `--model` override naming an unknown model → `supported:false`.
 *   3. RAM below the 1GB floor with no override → `supported:false, refused:true`.
 */
export function planInstall(input: PlanInput): InstallPlan {
  const { platform, arch, totalRamBytes, overrideModel } = input;
  const totalRamGb = Math.round((totalRamBytes / GB) * 10) / 10;
  const base = { platform, arch, totalRamGb };

  const asset = selectAsset(platform, arch);
  if (!asset) {
    return {
      ...base,
      supported: false,
      reason: `no transcribe.cpp release asset for ${platform}/${arch}. Use the scribe-http remote provider (set TRANSCRIPTION_PROVIDER=scribe-http and point at a scribe install).`,
    };
  }

  let chosen: ModelChoice | null;
  if (overrideModel) {
    chosen = MODELS[overrideModel] ?? null;
    if (!chosen) {
      return {
        ...base,
        supported: false,
        asset,
        reason: `unknown model "${overrideModel}". Choose one of: ${Object.keys(MODELS).join(", ")}.`,
      };
    }
  } else {
    chosen = selectModelForRam(totalRamBytes);
    if (!chosen) {
      return {
        ...base,
        supported: false,
        refused: true,
        asset,
        reason: `only ${totalRamGb}GB RAM detected — local transcription needs at least 1GB. Use the scribe-http remote provider instead (set TRANSCRIPTION_PROVIDER=scribe-http).`,
      };
    }
  }

  return {
    ...base,
    supported: true,
    asset,
    model: chosen,
    footprintMb: chosen.approxSizeMb,
  };
}

/**
 * Detect total physical RAM in bytes. Prefers `/proc/meminfo` on Linux (the
 * source `os.totalmem()` reads there anyway, but reading it directly is the
 * explicit contract) and falls back to `os.totalmem()` everywhere else.
 */
export function detectTotalRamBytes(): number {
  try {
    if (process.platform === "linux" && existsSync("/proc/meminfo")) {
      const m = readFileSync("/proc/meminfo", "utf8").match(/MemTotal:\s+(\d+)\s+kB/);
      if (m && m[1]) return parseInt(m[1], 10) * 1024;
    }
  } catch {
    // fall through to os.totalmem()
  }
  return totalmem();
}
