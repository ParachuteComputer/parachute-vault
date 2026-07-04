/**
 * RAM/arch/OS tier selection for `transcription install` (scribe-fold
 * Phase 2b — the ratified tier table, 2026-07-03).
 *
 * This is the PURE decision layer for the install verb's AUTO-DEFAULT: given
 * host facts (OS, arch, total RAM), which local provider should this box run?
 * No side effects — the CLI probes the host, prints the pick + footprint, and
 * the operator confirms or overrides with `--provider`/`--model`.
 *
 * ## The ratified table
 *
 *   | Host                        | Default                                    |
 *   |-----------------------------|--------------------------------------------|
 *   | macOS Apple Silicon, 8GB+   | parakeet-mlx (parakeet-tdt-0.6b-v3;        |
 *   |                             |   ~2.5GB disk, ~2.5–3GB peak)              |
 *   | Linux 4GB+                  | onnx-asr (parakeet-0.6b int8; ~670MB disk, |
 *   |                             |   ~1.2–2GB+ peak)                          |
 *   | Linux ~2GB                  | transcribe-cpp + whisper-small GGUF — NOT  |
 *   |                             |   Parakeet (scribe#82: Parakeet peak RAM   |
 *   |                             |   exceeds 2GB on meeting-length audio)     |
 *   | Linux ~1GB                  | REMOTE (scribe-http) by default; local     |
 *   |                             |   whisper-tiny only as explicit opt-in     |
 *   | Below floor / unknown host  | remote guidance — never force local        |
 *
 * Hosts the table doesn't name fall back to transcribe-cpp with its own
 * Phase 2a RAM tiers (e.g. Intel macs; a hypothetical <8GB Apple-Silicon
 * box) — that matrix already carries the scribe#82 Parakeet-at-4GB floor.
 *
 * ## Nominal-RAM slack
 *
 * Tier boundaries are NOMINAL sizes ("a 4GB droplet"), but the kernel/firmware
 * reserve memory before userspace sees it — a nominal-4GB Linux box reports
 * ~3.6–3.9GB via MemTotal. `NOMINAL_SLACK_GB` absorbs that so the box the
 * table targets actually lands in its tier. The 1GB remote floor uses a
 * smaller slack: below-floor boxes must steer remote, never get a local
 * install forced on them.
 */

import {
  MODELS,
  selectAsset,
  selectModelForRam,
  type ModelChoice,
} from "./install.ts";
import { DEFAULT_ONNX_ASR_MODEL, DEFAULT_PARAKEET_MLX_MODEL } from "./select.ts";

const GB = 2 ** 30;

/** Kernel/firmware reservation tolerance on nominal tier boundaries. */
export const NOMINAL_SLACK_GB = 0.4;

/** Slack at the 1GB remote floor (a nominal-1GB box reports ~0.94–0.97GB). */
const FLOOR_SLACK_GB = 0.1;

/** A provider name the tier table can select. */
export type TierProviderName = "parakeet-mlx" | "onnx-asr" | "transcribe-cpp" | "scribe-http";

/** The resolved tier pick for a host. */
export interface TierPlan {
  /** The tier-default provider for this host. */
  provider: TierProviderName;
  platform: string;
  arch: string;
  /** Detected total RAM, GB (rounded to 1dp) for the human print. */
  totalRamGb: number;
  /**
   * Model id for the pick: an HF repo (parakeet-mlx), an onnx-asr registry
   * name, or a transcribe-cpp GGUF id from `MODELS`. Absent for scribe-http.
   */
  model?: string;
  /** Approx download footprint, MB (model + runtime), for the confirm prompt. */
  approxDiskMb?: number;
  /** Human peak-RAM note for the confirm prompt. */
  peakRamNote?: string;
  /** One-line rationale for the pick (printed to the operator). */
  reason: string;
  /**
   * Set on the remote-default tier when a local install is still POSSIBLE as
   * an explicit opt-in (Linux ~1GB → transcribe-cpp + whisper-tiny). The CLI
   * prints it as guidance; it is never auto-installed.
   */
  localOptIn?: { provider: "transcribe-cpp"; model: string; note: string };
}

/** Host facts the tier decision needs. */
export interface TierInput {
  /** Node `os.platform()` value ("darwin" / "linux" / …). */
  platform: string;
  /** Node `os.arch()` value ("arm64" / "x64" / …). */
  arch: string;
  /** Detected total physical RAM in bytes. */
  totalRamBytes: number;
}

/**
 * Pick the tier-default provider for a host. Pure — see the module header for
 * the ratified table. The scribe#82 invariant this encodes: **no Parakeet
 * variant is ever the default below 4GB** (and on Linux, below-4GB boxes get
 * transcribe-cpp whisper models or the remote steer — never onnx-asr).
 */
export function selectDefaultProvider(input: TierInput): TierPlan {
  const { platform, arch, totalRamBytes } = input;
  const gb = totalRamBytes / GB;
  const base = { platform, arch, totalRamGb: Math.round(gb * 10) / 10 };

  // macOS Apple Silicon, 8GB+ → parakeet-mlx (MLX uses the GPU/unified memory;
  // the best quality/speed on this hardware).
  if (platform === "darwin" && arch === "arm64" && gb >= 8 - NOMINAL_SLACK_GB) {
    return {
      ...base,
      provider: "parakeet-mlx",
      model: DEFAULT_PARAKEET_MLX_MODEL,
      approxDiskMb: 2500,
      peakRamNote: "~2.5–3GB peak while transcribing",
      reason: "Apple Silicon with 8GB+ RAM — parakeet-mlx (MLX) is the best local quality/speed here.",
    };
  }

  // Linux 4GB+ → onnx-asr (Parakeet int8 ONNX — the proven scribe Linux
  // path). Arch-gated: onnxruntime publishes wheels for x64/arm64 only.
  if (platform === "linux" && (arch === "x64" || arch === "arm64") && gb >= 4 - NOMINAL_SLACK_GB) {
    return {
      ...base,
      provider: "onnx-asr",
      model: DEFAULT_ONNX_ASR_MODEL,
      approxDiskMb: 670,
      peakRamNote: "~1.2–2GB+ peak while transcribing (meeting-length audio uses the high end)",
      reason: "Linux with 4GB+ RAM — onnx-asr runs Parakeet (int8 ONNX) comfortably at this size.",
    };
  }

  // transcribe-cpp fallback tiers — only where a release asset exists for the
  // host. Covers Linux ~2GB (whisper-small — NOT Parakeet, scribe#82) and the
  // hosts the ratified table doesn't name (Intel macs etc.), reusing the
  // Phase 2a RAM matrix (which already floors Parakeet-GGUF at 4GB).
  const asset = selectAsset(platform, arch);
  if (asset && gb >= 2 - NOMINAL_SLACK_GB) {
    // Model pick: slack belongs to TIER-ENTRY boundaries, never to model-floor
    // checks. The 4GB Parakeet-GGUF floor is checked against the UN-INFLATED
    // RAM (adding slack here once picked a ~3.5GB-peak model for a real-3.6GB
    // Intel Mac — ~0.1GB headroom, the scribe#82 OOM class resurrected).
    // Below a true 4GB, the ratified "~2GB → small whisper" row covers the
    // whole band (entry already vetted ≥ ~2GB nominal above).
    const model: ModelChoice =
      gb >= 4
        ? (selectModelForRam(totalRamBytes) ?? MODELS["whisper-small.en"]!)
        : MODELS["whisper-small.en"]!;
    return {
      ...base,
      provider: "transcribe-cpp",
      model: model.name,
      approxDiskMb: model.approxSizeMb,
      peakRamNote: `~${model.approxRuntimeGb}GB peak while transcribing`,
      reason:
        gb < 4
          ? `~${base.totalRamGb}GB RAM — a small whisper GGUF via transcribe-cpp fits; Parakeet's peak RAM exceeds 2GB on meeting-length audio (scribe#82).`
          : `${platform}/${arch} isn't a parakeet-mlx/onnx-asr tier host — transcribe-cpp with a RAM-tier GGUF is the local default.`,
    };
  }

  // Linux ~1GB (and any asset-supported host just above the floor) → remote
  // by default; whisper-tiny via transcribe-cpp only as an explicit opt-in.
  if (asset && gb >= 1 - FLOOR_SLACK_GB) {
    return {
      ...base,
      provider: "scribe-http",
      reason: `only ~${base.totalRamGb}GB RAM — a remote provider is the reliable default at this size.`,
      localOptIn: {
        provider: "transcribe-cpp",
        model: "whisper-tiny.en",
        note: "a tiny local model is possible but slow/low-quality: `transcription install --provider transcribe-cpp --model whisper-tiny.en`",
      },
    };
  }

  // Below the floor, or a host with no local runtime at all → remote guidance.
  return {
    ...base,
    provider: "scribe-http",
    reason: asset
      ? `only ~${base.totalRamGb}GB RAM — below the 1GB local floor; use a remote provider.`
      : `no local transcription runtime for ${platform}/${arch} — use a remote provider.`,
  };
}
