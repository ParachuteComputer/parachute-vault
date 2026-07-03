import { describe, test, expect } from "bun:test";
import {
  planInstall,
  selectModelForRam,
  selectAsset,
  isSharedLibFile,
  MODELS,
  TRANSCRIBE_CPP_VERSION,
} from "./install.ts";

/**
 * Install-planning tests (scribe-fold Phase 2a). Pure selection logic — the
 * RAM-tier matrix (scribe#82 fix), the OS/arch → asset mapping, and the full
 * plan. No network, no fs.
 */

const GB = 2 ** 30;

describe("selectModelForRam — the tier matrix", () => {
  test("<1GB → refuse (null; steer to remote)", () => {
    expect(selectModelForRam(0.5 * GB)).toBeNull();
    expect(selectModelForRam(0)).toBeNull();
  });

  test("1–2GB → whisper-tiny.en", () => {
    expect(selectModelForRam(1 * GB)!.name).toBe("whisper-tiny.en");
    expect(selectModelForRam(1.9 * GB)!.name).toBe("whisper-tiny.en");
  });

  test("2–4GB → whisper-small.en (NOT Parakeet — the scribe#82 floor fix)", () => {
    expect(selectModelForRam(2 * GB)!.name).toBe("whisper-small.en");
    expect(selectModelForRam(3.9 * GB)!.name).toBe("whisper-small.en");
    // The scribe#82 regression: 2GB must NOT pick parakeet (it OOMs there).
    expect(selectModelForRam(2 * GB)!.name).not.toContain("parakeet");
  });

  test("≥4GB → parakeet-tdt-0.6b-v3", () => {
    expect(selectModelForRam(4 * GB)!.name).toBe("parakeet-tdt-0.6b-v3");
    expect(selectModelForRam(16 * GB)!.name).toBe("parakeet-tdt-0.6b-v3");
  });

  test("boundaries are inclusive at the tier floor", () => {
    expect(selectModelForRam(1 * GB)!.name).toBe("whisper-tiny.en");
    expect(selectModelForRam(2 * GB)!.name).toBe("whisper-small.en");
    expect(selectModelForRam(4 * GB)!.name).toBe("parakeet-tdt-0.6b-v3");
  });
});

describe("selectAsset — OS/arch → prebuilt release asset", () => {
  test("linux x64", () => {
    const a = selectAsset("linux", "x64")!;
    expect(a.asset).toBe(`transcribe-native-${TRANSCRIBE_CPP_VERSION}-linux-x86_64-cpu-vulkan.tar.gz`);
    expect(a.url).toContain("releases/download");
  });
  test("linux arm64", () => {
    expect(selectAsset("linux", "arm64")!.asset).toContain("linux-aarch64");
  });
  test("macos arm64 → metal", () => {
    expect(selectAsset("darwin", "arm64")!.asset).toContain("macos-arm64-metal");
  });
  test("macos x64", () => {
    expect(selectAsset("darwin", "x64")!.asset).toContain("macos-x86_64");
  });
  test("unsupported platform/arch → null", () => {
    expect(selectAsset("win32", "x64")).toBeNull();
    expect(selectAsset("linux", "riscv64")).toBeNull();
    expect(selectAsset("freebsd", "x64")).toBeNull();
  });
});

describe("planInstall", () => {
  test("supported host: asset + tier model + footprint", () => {
    const plan = planInstall({ platform: "linux", arch: "x64", totalRamBytes: 8 * GB });
    expect(plan.supported).toBe(true);
    expect(plan.asset!.asset).toContain("linux-x86_64");
    expect(plan.model!.name).toBe("parakeet-tdt-0.6b-v3");
    expect(plan.footprintMb).toBe(MODELS["parakeet-tdt-0.6b-v3"]!.approxSizeMb);
    expect(plan.totalRamGb).toBe(8);
  });

  test("2GB box picks whisper-small, not parakeet (scribe#82)", () => {
    const plan = planInstall({ platform: "linux", arch: "arm64", totalRamBytes: 2 * GB });
    expect(plan.supported).toBe(true);
    expect(plan.model!.name).toBe("whisper-small.en");
  });

  test("<1GB → refused with a remote steer (not a hard 'unsupported')", () => {
    const plan = planInstall({ platform: "linux", arch: "x64", totalRamBytes: 0.5 * GB });
    expect(plan.supported).toBe(false);
    expect(plan.refused).toBe(true);
    expect(plan.asset).toBeDefined(); // platform IS supported; RAM isn't
    expect(plan.reason).toContain("scribe-http");
  });

  test("unsupported platform → not supported, steer to remote, no asset", () => {
    const plan = planInstall({ platform: "win32", arch: "x64", totalRamBytes: 16 * GB });
    expect(plan.supported).toBe(false);
    expect(plan.refused).toBeUndefined();
    expect(plan.asset).toBeUndefined();
    expect(plan.reason).toContain("scribe-http");
  });

  test("--model override wins over the RAM tier", () => {
    const plan = planInstall({
      platform: "darwin",
      arch: "arm64",
      totalRamBytes: 16 * GB,
      overrideModel: "whisper-tiny.en",
    });
    expect(plan.supported).toBe(true);
    expect(plan.model!.name).toBe("whisper-tiny.en");
  });

  test("--model override with an unknown id → not supported, lists valid models", () => {
    const plan = planInstall({
      platform: "linux",
      arch: "x64",
      totalRamBytes: 8 * GB,
      overrideModel: "whisper-huge",
    });
    expect(plan.supported).toBe(false);
    expect(plan.reason).toContain("whisper-tiny.en");
  });

  test("override lets a 1GB box request a big model (operator's call)", () => {
    const plan = planInstall({
      platform: "linux",
      arch: "x64",
      totalRamBytes: 1 * GB,
      overrideModel: "parakeet-tdt-0.6b-v3",
    });
    expect(plan.supported).toBe(true);
    expect(plan.model!.name).toBe("parakeet-tdt-0.6b-v3");
  });
});

describe("MODELS registry", () => {
  test("each model has a resolvable HuggingFace URL + a gguf file", () => {
    for (const m of Object.values(MODELS)) {
      expect(m.file).toMatch(/\.gguf$/);
      expect(m.url).toContain("huggingface.co/handy-computer");
      expect(m.url).toContain(m.file);
      expect(m.approxSizeMb).toBeGreaterThan(0);
    }
  });

  test("whisper-tiny.en footprint reflects the real Q5_K_M size (~42MB)", () => {
    // Live-verified: whisper-tiny.en-Q5_K_M.gguf is 44,135,072 B ≈ 42MB (was 35).
    expect(MODELS["whisper-tiny.en"]!.approxSizeMb).toBe(42);
  });
});

describe("isSharedLibFile — what we keep from the v0.1.1 library tarball", () => {
  test("matches macOS + Linux shared libs (incl. versioned .so)", () => {
    expect(isSharedLibFile("libtranscribe.dylib")).toBe(true);
    expect(isSharedLibFile("libggml-metal.dylib")).toBe(true);
    expect(isSharedLibFile("libtranscribe.so")).toBe(true);
    expect(isSharedLibFile("libggml.so.1")).toBe(true);
    expect(isSharedLibFile("libggml.so.0.9.4")).toBe(true);
  });
  test("rejects non-libs (the CLI, manifests, licenses)", () => {
    expect(isSharedLibFile("transcribe-cli")).toBe(false);
    expect(isSharedLibFile("contract.json")).toBe(false);
    expect(isSharedLibFile("LICENSE")).toBe(false);
    expect(isSharedLibFile("model.gguf")).toBe(false);
  });
});
