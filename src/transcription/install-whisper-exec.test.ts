/**
 * The install executor.
 *
 * Driven through the spawn/download seams so no package manager runs and
 * nothing is fetched. The behaviours worth pinning are the ones that decide
 * whether an operator ends up with a working install or a convincing-looking
 * broken one: refusing when brew is absent instead of emitting exit 127,
 * never trusting a partial download, and failing the whole install when
 * verification can't transcribe.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { planWhisperInstall } from "./install-whisper-cpp.ts";
import {
  ensureBinaries,
  ensureModel,
  silentWav16kMono,
  verifyTranscription,
} from "./install-whisper-exec.ts";
import type { SpawnRunner } from "./providers/transcribe-cpp.ts";

const GB = 1024 * 1024 * 1024;
const env = { PARACHUTE_HOME: "/ph" } as NodeJS.ProcessEnv;

const macPlan = () =>
  planWhisperInstall(undefined, { platform: "darwin", arch: "arm64", totalRamBytes: 16 * GB, env });
const tmpHomes: string[] = [];
/** A Linux plan rooted in a real temp dir — the executor genuinely mkdirs. */
const linuxPlan = () => {
  const home = mkdtempSync(join(tmpdir(), "wcpp-install-"));
  tmpHomes.push(home);
  return planWhisperInstall(undefined, {
    platform: "linux",
    arch: "x64",
    totalRamBytes: 8 * GB,
    env: { PARACHUTE_HOME: home } as NodeJS.ProcessEnv,
  });
};

afterEach(() => {
  for (const h of tmpHomes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** A spawn that answers per-command from a lookup. */
function spawnFor(map: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>): SpawnRunner {
  return async (cmd) => {
    const key = Object.keys(map).find((k) => cmd.join(" ").includes(k));
    const r = key ? map[key]! : {};
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

describe("ensureBinaries — macOS", () => {
  test("no Homebrew → honest refusal, and brew install is never attempted", async () => {
    // The alternative is an opaque exit 127 the operator has to decode.
    let attempted = false;
    const spawn: SpawnRunner = async (cmd) => {
      if (cmd[1] === "install") attempted = true;
      return { exitCode: cmd[1] === "--version" ? 1 : 0, stdout: "", stderr: "" };
    };
    const r = await ensureBinaries(macPlan(), { spawn });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Homebrew isn't installed/);
    expect(r.message).toMatch(/brew\.sh/);
    // And it explains WHY there's no alternative, so this doesn't read as laziness.
    expect(r.message).toMatch(/no macOS CLI tarball|xcframework/);
    expect(attempted).toBe(false);
  });

  test("brew present → installs the formula", async () => {
    const r = await ensureBinaries(macPlan(), { spawn: spawnFor({}) });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/whisper-cli \+ parakeet-cli/);
  });

  test("a failing brew install surfaces brew's own stderr", async () => {
    const r = await ensureBinaries(macPlan(), {
      spawn: spawnFor({ "brew install": { exitCode: 1, stderr: "No available formula" } }),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No available formula/);
  });
});

describe("ensureBinaries — Linux", () => {
  test("downloads + extracts, then confirms the binary really landed", async () => {
    const seen: string[] = [];
    // Model the real sequence: the binary is ABSENT before extraction and
    // present after. A flat `true` would short-circuit at the already-present
    // check and never download at all.
    let extracted = false;
    const r = await ensureBinaries(linuxPlan(), {
      spawn: async (cmd) => {
        if (cmd[0] === "tar") extracted = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      download: async (url) => {
        seen.push(url);
      },
      existsImpl: (p) => extracted && p.endsWith("parakeet-cli"),
    });
    expect(r.ok).toBe(true);
    expect(seen[0]).toContain("whisper-bin-ubuntu-x64.tar.gz");
  });

  test("extraction that doesn't produce the binary is a FAILURE, not a shrug", async () => {
    // Otherwise the install reports success and the first transcription is
    // the thing that discovers the truth.
    const r = await ensureBinaries(linuxPlan(), {
      spawn: spawnFor({}),
      download: async () => {},
      existsImpl: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/isn't in/);
  });

  test("a tar failure surfaces tar's stderr", async () => {
    const r = await ensureBinaries(linuxPlan(), {
      spawn: spawnFor({ tar: { exitCode: 2, stderr: "unexpected EOF" } }),
      download: async () => {},
      existsImpl: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/unexpected EOF/);
  });
});

describe("ensureBinaries — short circuits", () => {
  test("already-present skips every package manager", async () => {
    let spawned = false;
    const plan = planWhisperInstall(undefined, {
      platform: "darwin",
      arch: "arm64",
      totalRamBytes: 16 * GB,
      env,
      resolveExisting: () => "/opt/homebrew/bin/parakeet-cli",
    });
    const r = await ensureBinaries(plan, {
      spawn: async () => {
        spawned = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(r.ok).toBe(true);
    expect(spawned).toBe(false);
  });

  test("an unsupported host fails with the planner's reason", async () => {
    const plan = planWhisperInstall(undefined, {
      platform: "freebsd",
      arch: "x64",
      totalRamBytes: 8 * GB,
      env,
    });
    const r = await ensureBinaries(plan, { spawn: spawnFor({}) });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/WHISPER_CPP_BIN_DIR/);
  });
});

describe("ensureModel", () => {
  test("an existing model isn't re-downloaded", async () => {
    let downloads = 0;
    const r = await ensureModel(linuxPlan(), {
      existsImpl: () => true,
      download: async () => {
        downloads += 1;
      },
    });
    expect(r.ok).toBe(true);
    expect(downloads).toBe(0);
  });

  test("downloads to a .part first — a truncated file must never look complete", async () => {
    // A half-file at the real path would pass the readiness probe and then
    // fail mysteriously at the first transcription.
    const targets: string[] = [];
    await ensureModel(linuxPlan(), {
      existsImpl: () => false,
      download: async (_url, dest) => {
        targets.push(dest);
        // Materialise it so the rename can succeed.
        await Bun.write(dest, "x");
      },
    }).catch(() => {});
    expect(targets[0]).toMatch(/\.part$/);
  });
});

describe("verifyTranscription", () => {
  test("a clean exit means verified", async () => {
    const r = await verifyTranscription(linuxPlan(), "/bin/parakeet-cli", { spawn: spawnFor({}) });
    expect(r.ok).toBe(true);
  });

  test("a non-zero exit FAILS the install and names the likely cause", async () => {
    const r = await verifyTranscription(linuxPlan(), "/bin/parakeet-cli", {
      spawn: spawnFor({ "parakeet-cli": { exitCode: 1, stderr: "failed to load model" } }),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/truncated download or a model\/binary mismatch/);
    expect(r.message).toMatch(/failed to load model/);
  });

  test("engine picks the flags — whisper needs -nt, parakeet has no such flag", async () => {
    let seen: string[] = [];
    const capture: SpawnRunner = async (cmd) => {
      seen = cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await verifyTranscription(
      planWhisperInstall("whisper-base.en", { platform: "linux", arch: "x64", totalRamBytes: 8 * GB, env }),
      "/bin/whisper-cli",
      { spawn: capture },
    );
    expect(seen).toContain("-nt");

    await verifyTranscription(linuxPlan(), "/bin/parakeet-cli", { spawn: capture });
    expect(seen).not.toContain("-nt");
  });
});

describe("silentWav16kMono", () => {
  test("is a valid RIFF/WAVE header at 16 kHz mono 16-bit", () => {
    // Hand-built so verification doesn't depend on ffmpeg — the very tool
    // whose absence we're trying to report clearly elsewhere.
    const wav = silentWav16kMono(1);
    const dv = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(24, true)).toBe(16000); // sample rate
    expect(dv.getUint16(34, true)).toBe(16); // bits
    expect(wav.length).toBe(44 + 16000 * 2);
  });

  test("a zero/negative duration still yields a structurally valid file", () => {
    expect(silentWav16kMono(0).length).toBeGreaterThan(44);
  });
});
