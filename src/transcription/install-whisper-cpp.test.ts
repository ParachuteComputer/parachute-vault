/**
 * The whisper.cpp install planner.
 *
 * Pure, so the whole host matrix is exercised without downloading anything.
 * The cases that matter are the ones where a wrong answer is expensive: a
 * platform with no prebuilt binaries must REFUSE with instructions rather than
 * half-install, and an already-installed binary must short-circuit rather than
 * triggering another package-manager round trip.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_ID } from "./models.ts";
import {
  describeWhisperPlan,
  planBinaryStrategy,
  planWhisperInstall,
  WHISPER_CPP_VERSION,
} from "./install-whisper-cpp.ts";

const GB = 1024 * 1024 * 1024;
const env = { PARACHUTE_HOME: "/ph" } as NodeJS.ProcessEnv;

describe("planBinaryStrategy", () => {
  test("macOS → Homebrew (upstream ships no macOS CLI tarball)", () => {
    const s = planWhisperInstall(undefined, {
      platform: "darwin",
      arch: "arm64",
      totalRamBytes: 16 * GB,
      env,
    }).binary;
    expect(s.kind).toBe("homebrew");
    expect(s.kind === "homebrew" && s.formula).toBe("whisper-cpp");
  });

  test("macOS Intel also gets Homebrew — the formula covers both arches", () => {
    const s = planWhisperInstall(undefined, {
      platform: "darwin",
      arch: "x64",
      totalRamBytes: 16 * GB,
      env,
    }).binary;
    expect(s.kind).toBe("homebrew");
  });

  test("Linux x64 → the x64 release tarball, pinned to a version", () => {
    const s = planWhisperInstall(undefined, {
      platform: "linux",
      arch: "x64",
      totalRamBytes: 8 * GB,
      env,
    }).binary;
    expect(s.kind).toBe("tarball");
    if (s.kind === "tarball") {
      expect(s.assetName).toBe("whisper-bin-ubuntu-x64.tar.gz");
      expect(s.url).toContain(`v${WHISPER_CPP_VERSION}`);
    }
  });

  test("Linux arm64 → the arm64 tarball", () => {
    const s = planWhisperInstall(undefined, {
      platform: "linux",
      arch: "arm64",
      totalRamBytes: 8 * GB,
      env,
    }).binary;
    expect(s.kind === "tarball" && s.assetName).toBe("whisper-bin-ubuntu-arm64.tar.gz");
  });

  test("an exotic Linux arch REFUSES with a pointer at the override", () => {
    const s = planWhisperInstall(undefined, {
      platform: "linux",
      arch: "riscv64",
      totalRamBytes: 8 * GB,
      env,
    }).binary;
    expect(s.kind).toBe("unsupported");
    expect(s.kind === "unsupported" && s.reason).toMatch(/WHISPER_CPP_BIN_DIR/);
  });

  test("an unknown platform refuses rather than half-installing", () => {
    const plan = planWhisperInstall(undefined, {
      platform: "freebsd",
      arch: "x64",
      totalRamBytes: 8 * GB,
      env,
    });
    expect(plan.supported).toBe(false);
    expect(plan.binary.kind).toBe("unsupported");
  });

  test("an already-installed binary short-circuits every package manager", () => {
    const plan = planWhisperInstall(undefined, {
      platform: "darwin",
      arch: "arm64",
      totalRamBytes: 16 * GB,
      env,
      resolveExisting: () => "/opt/homebrew/bin/parakeet-cli",
    });
    expect(plan.binary.kind).toBe("already-present");
    expect(plan.supported).toBe(true);
  });
});

describe("model selection", () => {
  test("a capable box gets the recommended Parakeet", () => {
    const p = planWhisperInstall(undefined, {
      platform: "linux",
      arch: "x64",
      totalRamBytes: 8 * GB,
      env,
    });
    expect(p.model.id).toBe(DEFAULT_MODEL_ID);
    expect(p.modelExplicit).toBe(false);
  });

  test("a 2 GB VPS still gets Parakeet, not a step down to Whisper Tiny", () => {
    // The common cheap-VPS tier. Parakeet q4 is 339 MB and comfortably fits;
    // dropping to Whisper Tiny here would be a large accuracy loss for
    // headroom the box didn't need.
    const p = planWhisperInstall(undefined, {
      platform: "linux",
      arch: "x64",
      totalRamBytes: 2 * GB,
      env,
    });
    expect(p.model.engine).toBe("parakeet");
  });

  test("a 1 GB box steps down rather than swapping itself to death", () => {
    const p = planWhisperInstall(undefined, {
      platform: "linux",
      arch: "x64",
      totalRamBytes: 1 * GB,
      env,
    });
    expect(p.model.sizeMb).toBeLessThan(150);
  });

  test("an explicit model is honoured over the RAM pick, with a warning", () => {
    const p = planWhisperInstall("whisper-large-v3-turbo", {
      platform: "linux",
      arch: "x64",
      totalRamBytes: 2 * GB,
      env,
    });
    expect(p.model.id).toBe("whisper-large-v3-turbo");
    expect(p.modelExplicit).toBe(true);
    // Honoured, but the operator is told what they're in for.
    expect(p.ramWarning).toBeTruthy();
    expect(p.ramWarning).toMatch(/may swap or run slowly/);
  });

  test("no warning when the box comfortably fits the model", () => {
    const p = planWhisperInstall(undefined, {
      platform: "linux",
      arch: "x64",
      totalRamBytes: 32 * GB,
      env,
    });
    expect(p.ramWarning).toBeUndefined();
  });

  test("an unknown model id is refused, NOT silently defaulted", () => {
    // Silently installing something else would leave the operator convinced
    // they're running a model they aren't.
    const p = planWhisperInstall("whisper-enormous", {
      platform: "linux",
      arch: "x64",
      totalRamBytes: 8 * GB,
      env,
    });
    expect(p.supported).toBe(false);
    expect(p.binary.kind === "unsupported" && p.binary.reason).toMatch(/unknown model id/);
  });

  test("paths honour PARACHUTE_HOME", () => {
    const p = planWhisperInstall(undefined, {
      platform: "linux",
      arch: "x64",
      totalRamBytes: 8 * GB,
      env,
    });
    expect(p.modelPath.startsWith("/ph/transcription/models/")).toBe(true);
    expect(p.binDir).toBe("/ph/transcription/bin");
  });
});

describe("describeWhisperPlan", () => {
  test("names the model, its size, and where it goes", () => {
    const out = describeWhisperPlan(
      planWhisperInstall(undefined, {
        platform: "linux",
        arch: "x64",
        totalRamBytes: 8 * GB,
        env,
      }),
    ).join("\n");
    expect(out).toMatch(/Parakeet/);
    expect(out).toMatch(/396 MB/);
    expect(out).toMatch(/\/ph\/transcription\/models/);
  });

  test("an unsupported host explains itself rather than printing a plan", () => {
    const out = describeWhisperPlan(
      planWhisperInstall(undefined, {
        platform: "freebsd",
        arch: "x64",
        totalRamBytes: 8 * GB,
        env,
      }),
    ).join("\n");
    expect(out).toMatch(/UNSUPPORTED/);
    expect(out).toMatch(/WHISPER_CPP_BIN_DIR/);
  });

  test("the macOS line tells you what brew actually gives you", () => {
    const out = describeWhisperPlan(
      planWhisperInstall(undefined, {
        platform: "darwin",
        arch: "arm64",
        totalRamBytes: 16 * GB,
        env,
      }),
    ).join("\n");
    expect(out).toMatch(/brew install whisper-cpp/);
    expect(out).toMatch(/whisper-cli \+ parakeet-cli/);
  });
});
