import { describe, test, expect } from "bun:test";
import { selectDefaultProvider, NOMINAL_SLACK_GB, type TierPlan } from "./tiers.ts";
import { DEFAULT_ONNX_ASR_MODEL, DEFAULT_PARAKEET_MLX_MODEL } from "./select.ts";

/**
 * The ratified RAM/arch/OS tier matrix (scribe-fold Phase 2b, 2026-07-03).
 * Pure decision layer — no host probes, no network. The load-bearing
 * invariants:
 *
 *   - macOS Apple Silicon 8GB+ → parakeet-mlx
 *   - Linux 4GB+ → onnx-asr
 *   - Linux ~2GB → transcribe-cpp with a SMALL WHISPER GGUF, never a Parakeet
 *     variant (scribe#82: Parakeet peak RAM exceeds 2GB on meeting-length
 *     audio → OOM)
 *   - Linux ~1GB → remote default, tiny local model only as explicit opt-in
 *   - below floor / unknown host → remote guidance, never a forced local pick
 */

const GB = 2 ** 30;

function pick(platform: string, arch: string, gb: number): TierPlan {
  return selectDefaultProvider({ platform, arch, totalRamBytes: gb * GB });
}

/** True when the plan's model is any Parakeet variant. */
function isParakeet(plan: TierPlan): boolean {
  return !!plan.model && /parakeet/i.test(plan.model);
}

describe("selectDefaultProvider — macOS Apple Silicon", () => {
  test("darwin/arm64 8GB → parakeet-mlx (ratified default)", () => {
    const plan = pick("darwin", "arm64", 8);
    expect(plan.provider).toBe("parakeet-mlx");
    expect(plan.model).toBe(DEFAULT_PARAKEET_MLX_MODEL);
    expect(plan.approxDiskMb).toBe(2500);
  });

  test("darwin/arm64 16GB → parakeet-mlx", () => {
    expect(pick("darwin", "arm64", 16).provider).toBe("parakeet-mlx");
  });

  test("darwin/arm64 just under 8GB nominal (7.7GB reported) → still parakeet-mlx (slack)", () => {
    expect(pick("darwin", "arm64", 8 - NOMINAL_SLACK_GB).provider).toBe("parakeet-mlx");
  });

  test("darwin/arm64 well under 8GB → transcribe-cpp fallback, NOT parakeet-mlx", () => {
    const plan = pick("darwin", "arm64", 6);
    expect(plan.provider).toBe("transcribe-cpp");
  });

  test("darwin/x64 (Intel — no MLX) 16GB → transcribe-cpp fallback, never parakeet-mlx", () => {
    const plan = pick("darwin", "x64", 16);
    expect(plan.provider).toBe("transcribe-cpp");
  });
});

describe("selectDefaultProvider — Linux", () => {
  test("linux/x64 4GB → onnx-asr (ratified default)", () => {
    const plan = pick("linux", "x64", 4);
    expect(plan.provider).toBe("onnx-asr");
    expect(plan.model).toBe(DEFAULT_ONNX_ASR_MODEL);
    expect(plan.approxDiskMb).toBe(670);
  });

  test("linux/x64 8GB → onnx-asr, NOT parakeet-mlx (MLX is Apple-only)", () => {
    expect(pick("linux", "x64", 8).provider).toBe("onnx-asr");
  });

  test("linux/arm64 4GB → onnx-asr", () => {
    expect(pick("linux", "arm64", 4).provider).toBe("onnx-asr");
  });

  test("nominal-4GB box reporting 3.8GB (kernel reservation) → still onnx-asr (slack)", () => {
    expect(pick("linux", "x64", 3.8).provider).toBe("onnx-asr");
  });

  test("linux 3.4GB (below the 4GB tier even with slack) → transcribe-cpp small whisper", () => {
    const plan = pick("linux", "x64", 3.4);
    expect(plan.provider).toBe("transcribe-cpp");
    expect(plan.model).toBe("whisper-small.en");
  });
});

describe("selectDefaultProvider — the 2GB-not-Parakeet floor (scribe#82)", () => {
  test("linux 2GB → transcribe-cpp whisper-small.en — NEVER a Parakeet variant", () => {
    const plan = pick("linux", "x64", 2);
    expect(plan.provider).toBe("transcribe-cpp");
    expect(plan.model).toBe("whisper-small.en");
    expect(isParakeet(plan)).toBe(false);
    expect(plan.reason).toContain("scribe#82");
  });

  test("nominal-2GB box reporting 1.9GB → still the whisper-small tier (slack), not tiny/remote", () => {
    const plan = pick("linux", "x64", 1.9);
    expect(plan.provider).toBe("transcribe-cpp");
    expect(plan.model).toBe("whisper-small.en");
  });

  test("the whole 2–4GB Linux band never defaults to any Parakeet variant", () => {
    for (const gb of [1.7, 2, 2.5, 3, 3.5]) {
      const plan = pick("linux", "x64", gb);
      expect(isParakeet(plan)).toBe(false);
      expect(plan.provider).not.toBe("onnx-asr");
      expect(plan.provider).not.toBe("parakeet-mlx");
    }
  });

  // Regression for the double-applied-slack bug (reviewer, PR #537): the
  // transcribe-cpp fallback used to add NOMINAL_SLACK_GB a SECOND time before
  // install.ts's 4GB Parakeet-GGUF floor, so a real-3.6GB Darwin box picked a
  // ~3.5GB-peak Parakeet model (~0.1GB headroom — the scribe#82 OOM class).
  // Slack belongs to tier-entry boundaries only, never to model-floor checks.
  test("darwin/x64 in the 3.6–3.9GB band → whisper-small.en, NEVER a Parakeet variant", () => {
    for (const gb of [3.6, 3.8, 3.9]) {
      const plan = pick("darwin", "x64", gb);
      expect(plan.provider).toBe("transcribe-cpp");
      expect(plan.model).toBe("whisper-small.en");
      expect(isParakeet(plan)).toBe(false);
    }
  });

  test("darwin/arm64 in the 3.6–3.9GB band → whisper-small.en, NEVER a Parakeet variant", () => {
    for (const gb of [3.6, 3.9]) {
      const plan = pick("darwin", "arm64", gb);
      expect(plan.provider).toBe("transcribe-cpp");
      expect(plan.model).toBe("whisper-small.en");
      expect(isParakeet(plan)).toBe(false);
    }
  });

  test("darwin just over a TRUE 4GB → the un-inflated Phase 2a pick (parakeet GGUF)", () => {
    // At a genuine ≥4GB, install.ts's own matrix governs — same model an
    // explicit `--provider transcribe-cpp` install would choose.
    for (const [arch, gb] of [["x64", 4], ["x64", 4.1], ["arm64", 4]] as const) {
      const plan = pick("darwin", arch, gb);
      expect(plan.provider).toBe("transcribe-cpp");
      expect(plan.model).toBe("parakeet-tdt-0.6b-v3");
    }
  });
});

describe("selectDefaultProvider — the ~1GB remote tier", () => {
  test("linux 1GB → scribe-http by default (never a forced local install)", () => {
    const plan = pick("linux", "x64", 1);
    expect(plan.provider).toBe("scribe-http");
  });

  test("linux 1GB carries the explicit whisper-tiny local opt-in", () => {
    const plan = pick("linux", "x64", 1);
    expect(plan.localOptIn).toBeDefined();
    expect(plan.localOptIn!.provider).toBe("transcribe-cpp");
    expect(plan.localOptIn!.model).toBe("whisper-tiny.en");
  });

  test("nominal-1GB box reporting 0.95GB → still the opt-in tier", () => {
    expect(pick("linux", "x64", 0.95).localOptIn).toBeDefined();
  });

  test("linux 1.4GB (below the 2GB tier) → remote default + tiny opt-in", () => {
    const plan = pick("linux", "x64", 1.4);
    expect(plan.provider).toBe("scribe-http");
    expect(plan.localOptIn?.model).toBe("whisper-tiny.en");
  });
});

describe("selectDefaultProvider — below floor / unknown hosts", () => {
  test("linux 0.5GB → remote guidance with NO local opt-in", () => {
    const plan = pick("linux", "x64", 0.5);
    expect(plan.provider).toBe("scribe-http");
    expect(plan.localOptIn).toBeUndefined();
  });

  test("unknown platform (win32) → remote guidance regardless of RAM", () => {
    const plan = pick("win32", "x64", 32);
    expect(plan.provider).toBe("scribe-http");
    expect(plan.localOptIn).toBeUndefined();
    expect(plan.reason).toContain("win32");
  });

  test("unknown arch (linux/riscv64) → remote guidance", () => {
    expect(pick("linux", "riscv64", 8).provider).toBe("scribe-http");
  });
});

describe("selectDefaultProvider — plan shape", () => {
  test("carries the host facts for the human print", () => {
    const plan = pick("linux", "x64", 4);
    expect(plan.platform).toBe("linux");
    expect(plan.arch).toBe("x64");
    expect(plan.totalRamGb).toBe(4);
    expect(plan.reason.length).toBeGreaterThan(0);
  });

  test("rounds detected RAM to 1dp", () => {
    expect(selectDefaultProvider({ platform: "linux", arch: "x64", totalRamBytes: 3.84 * GB }).totalRamGb).toBe(3.8);
  });
});
