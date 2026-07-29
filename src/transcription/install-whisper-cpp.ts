/**
 * `parachute-vault transcription install` for the whisper.cpp provider.
 *
 * Split into a PURE planner and a thin executor. The planner takes the host's
 * platform/arch/RAM and the operator's flags and answers "what would happen" —
 * no network, no writes — so `--dry-run` and the tests exercise the whole
 * decision matrix without downloading a byte.
 *
 * ## How the binaries arrive, per platform
 *
 * **macOS** — Homebrew, and only Homebrew. whisper.cpp publishes release
 * tarballs for Linux and Windows but NOT macOS (the macOS artifact is an
 * `.xcframework`, which is for embedding in an app, not a CLI to spawn). The
 * formula is bottled for arm64 Tahoe/Sequoia/Sonoma, so `brew install
 * whisper-cpp` is a fast binary download rather than a source build. With no
 * brew on the box we refuse and say so plainly — pretending to have another
 * route would just fail later and more confusingly.
 *
 * **Linux** — the release tarball, extracted into our own managed directory
 * (`<root>/transcription/bin`) rather than anywhere system-wide. The tarball
 * carries `whisper-cli`, `parakeet-cli`, and the `libggml*`/`libwhisper` shared
 * objects they link against, so the whole set moves together and we never
 * fight a distro's package manager.
 *
 * ## Why it verifies before declaring success
 *
 * The provider this replaces was configured by an install verb that never
 * checked whether the thing it configured could run — which is exactly how
 * `TRANSCRIPTION_PROVIDER=transcribe-cpp` came to point at a CLI that has
 * never existed. So the last step here actually SPAWNS the CLI against a
 * generated test clip and reads the transcript back. `TRANSCRIPTION_PROVIDER`
 * flips only after that passes. An install that can't transcribe is an install
 * that failed, and it should say so at install time rather than silently at
 * the first voice memo.
 */

import { totalmem } from "os";
import { join } from "path";
import {
  DEFAULT_MODEL_ID,
  findModel,
  pickDefaultModel,
  type TranscriptionModel,
} from "./models.ts";
import { binaryNameFor, managedBinDir, managedModelDir } from "./resolve-binary.ts";

/** whisper.cpp release the Linux tarballs are pulled from. */
export const WHISPER_CPP_VERSION = "1.9.1";

/** How the CLI binaries get onto this box. */
export type BinaryStrategy =
  | { kind: "homebrew"; formula: string }
  | { kind: "tarball"; url: string; assetName: string }
  | { kind: "already-present"; path: string }
  | { kind: "unsupported"; reason: string };

export interface WhisperInstallPlan {
  platform: string;
  arch: string;
  totalRamGb: number;
  /** The model to fetch + activate. */
  model: TranscriptionModel;
  /** Whether the operator named the model explicitly (skips the RAM warning). */
  modelExplicit: boolean;
  /** How to obtain `whisper-cli` / `parakeet-cli`. */
  binary: BinaryStrategy;
  /** Absolute destination for the model file. */
  modelPath: string;
  /** Directory binaries land in (tarball strategy) or are found in. */
  binDir: string;
  /** True when the plan can proceed. */
  supported: boolean;
  /** Set when the box has less RAM than the chosen model wants. */
  ramWarning?: string;
}

export interface PlanDeps {
  platform?: string;
  arch?: string;
  totalRamBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** Existing binary probe — lets the plan report "already present". */
  resolveExisting?: (engine: "whisper" | "parakeet") => string | undefined;
}

/**
 * Decide how to get the binaries for this host.
 *
 * `already-present` short-circuits everything: an operator who ran `brew
 * install whisper-cpp` themselves, or who is re-running install, shouldn't
 * trigger another package-manager round trip.
 */
export function planBinaryStrategy(
  model: TranscriptionModel,
  deps: PlanDeps = {},
): BinaryStrategy {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  const existing = deps.resolveExisting?.(model.engine);
  if (existing) return { kind: "already-present", path: existing };

  if (platform === "darwin") {
    // No macOS CLI tarball exists upstream — the macOS artifact is an
    // xcframework for embedding, not a spawnable binary. Homebrew is the path.
    return { kind: "homebrew", formula: "whisper-cpp" };
  }

  if (platform === "linux") {
    const assetArch = arch === "arm64" || arch === "aarch64" ? "arm64" : arch === "x64" ? "x64" : null;
    if (!assetArch) {
      return {
        kind: "unsupported",
        reason: `no prebuilt whisper.cpp binaries for linux/${arch} — build whisper.cpp yourself and point WHISPER_CPP_BIN_DIR at the result`,
      };
    }
    const assetName = `whisper-bin-ubuntu-${assetArch}.tar.gz`;
    return {
      kind: "tarball",
      assetName,
      url: `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}/${assetName}`,
    };
  }

  return {
    kind: "unsupported",
    reason: `${platform} isn't supported for automatic install — install whisper.cpp yourself and point WHISPER_CPP_BIN_DIR at the directory holding ${binaryNameFor(model.engine)}`,
  };
}

/**
 * Build the full plan. Pure — safe to call for `--dry-run`.
 *
 * `modelId` undefined means "pick for this box": `pickDefaultModel` steps down
 * from the recommended Parakeet on a machine that can't comfortably hold it.
 * An explicitly-named model is honoured even when it's a stretch for the RAM,
 * with a warning — the operator may know something we don't.
 */
export function planWhisperInstall(
  modelId: string | undefined,
  deps: PlanDeps = {},
): WhisperInstallPlan {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const totalRamBytes = deps.totalRamBytes ?? totalmem();
  const totalRamMb = Math.round(totalRamBytes / 1024 / 1024);
  const env = deps.env ?? process.env;

  const explicit = modelId !== undefined;
  const model = explicit
    ? findModel(modelId)
    : pickDefaultModel(totalRamMb);

  if (!model) {
    // Unknown id — surface it as unsupported rather than silently defaulting,
    // so a typo doesn't quietly install something else.
    const fallback = findModel(DEFAULT_MODEL_ID)!;
    return {
      platform,
      arch,
      totalRamGb: Math.round((totalRamMb / 1024) * 10) / 10,
      model: fallback,
      modelExplicit: true,
      binary: { kind: "unsupported", reason: `unknown model id "${modelId}"` },
      modelPath: join(managedModelDir(env), fallback.filename),
      binDir: managedBinDir(env),
      supported: false,
    };
  }

  const binary = planBinaryStrategy(model, deps);
  const ramWarning =
    totalRamMb < model.minRamMb
      ? `${model.label} wants about ${Math.round(model.minRamMb / 1024)} GB of RAM and this box reports ${Math.round((totalRamMb / 1024) * 10) / 10} GB — it may swap or run slowly.`
      : undefined;

  return {
    platform,
    arch,
    totalRamGb: Math.round((totalRamMb / 1024) * 10) / 10,
    model,
    modelExplicit: explicit,
    binary,
    modelPath: join(managedModelDir(env), model.filename),
    binDir:
      binary.kind === "already-present"
        ? binary.path.slice(0, binary.path.lastIndexOf("/"))
        : managedBinDir(env),
    supported: binary.kind !== "unsupported",
    ramWarning,
  };
}

/** Human-readable plan, shared by `--dry-run` and the real run. */
export function describeWhisperPlan(plan: WhisperInstallPlan): string[] {
  const lines: string[] = [];
  lines.push(`Host:   ${plan.platform}/${plan.arch}, ${plan.totalRamGb} GB RAM`);
  lines.push(`Model:  ${plan.model.label} (${plan.model.sizeMb} MB)`);
  lines.push(`        ${plan.model.note}`);
  lines.push(`        → ${plan.modelPath}`);

  switch (plan.binary.kind) {
    case "already-present":
      lines.push(`Engine: ${binaryNameFor(plan.model.engine)} already installed at ${plan.binary.path}`);
      break;
    case "homebrew":
      lines.push(`Engine: brew install ${plan.binary.formula}  (installs whisper-cli + parakeet-cli)`);
      break;
    case "tarball":
      lines.push(`Engine: download ${plan.binary.assetName}`);
      lines.push(`        → ${plan.binDir}`);
      break;
    case "unsupported":
      lines.push(`Engine: UNSUPPORTED — ${plan.binary.reason}`);
      break;
  }
  if (plan.ramWarning) lines.push(`Note:   ${plan.ramWarning}`);
  return lines;
}
