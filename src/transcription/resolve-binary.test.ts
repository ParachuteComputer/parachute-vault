/**
 * Binary resolution across the routes whisper.cpp actually arrives by.
 *
 * The case worth the most care is Homebrew: a launchd-supervised vault does
 * NOT inherit a login shell's PATH, so on macOS `whisper-cli` is routinely
 * installed and simultaneously invisible to the running daemon. Probing brew's
 * prefixes explicitly is what stops "I installed it and it still says not
 * configured" — the worst failure available here, because the operator did the
 * work and got told no.
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  binaryNameFor,
  candidateBinDirs,
  managedBinDir,
  managedModelDir,
  resolveCliBinary,
  resolveFfmpeg,
} from "./resolve-binary.ts";

/** An existsImpl that only knows about an explicit allow-list. */
function only(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

describe("binaryNameFor", () => {
  test("maps engine → CLI name", () => {
    expect(binaryNameFor("whisper")).toBe("whisper-cli");
    expect(binaryNameFor("parakeet")).toBe("parakeet-cli");
  });
});

describe("candidateBinDirs — the ladder", () => {
  const env = { PARACHUTE_HOME: "/ph", PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv;

  test("managed dir precedes brew, which precedes PATH", () => {
    const dirs = candidateBinDirs({ env });
    expect(dirs.indexOf("/ph/transcription/bin")).toBeLessThan(dirs.indexOf("/opt/homebrew/bin"));
    expect(dirs.indexOf("/opt/homebrew/bin")).toBeLessThan(dirs.indexOf("/usr/bin"));
  });

  test("an explicit override leads everything", () => {
    const dirs = candidateBinDirs({ env: { ...env, WHISPER_CPP_BIN_DIR: "/custom" } });
    expect(dirs[0]).toBe("/custom");
  });

  test("brew prefixes are probed even when absent from PATH — the launchd case", () => {
    // A launchd-supervised daemon gets a minimal PATH with no /opt/homebrew.
    const dirs = candidateBinDirs({ env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv });
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/usr/local/bin");
  });

  test("no duplicates, order preserved", () => {
    const dirs = candidateBinDirs({
      env: { PATH: "/usr/bin:/opt/homebrew/bin:/usr/bin" } as NodeJS.ProcessEnv,
    });
    expect(dirs.length).toBe(new Set(dirs).size);
  });

  test("an empty PATH doesn't produce empty-string dirs", () => {
    const dirs = candidateBinDirs({ env: { PATH: "" } as NodeJS.ProcessEnv });
    expect(dirs).not.toContain("");
  });
});

describe("resolveCliBinary", () => {
  const env = { PARACHUTE_HOME: "/ph", PATH: "/usr/bin" } as NodeJS.ProcessEnv;

  test("finds a brew-installed binary a bare PATH lookup would miss", () => {
    const got = resolveCliBinary("parakeet", {
      env,
      existsImpl: only("/opt/homebrew/bin/parakeet-cli"),
    });
    expect(got).toBe("/opt/homebrew/bin/parakeet-cli");
  });

  test("our managed install wins over a brew one", () => {
    const got = resolveCliBinary("whisper", {
      env,
      existsImpl: only("/ph/transcription/bin/whisper-cli", "/opt/homebrew/bin/whisper-cli"),
    });
    expect(got).toBe("/ph/transcription/bin/whisper-cli");
  });

  test("the override beats everything", () => {
    const got = resolveCliBinary("whisper", {
      env: { ...env, WHISPER_CPP_BIN_DIR: "/custom" },
      existsImpl: only("/custom/whisper-cli", "/ph/transcription/bin/whisper-cli"),
    });
    expect(got).toBe("/custom/whisper-cli");
  });

  test("returns an ABSOLUTE path, never a bare name", () => {
    const got = resolveCliBinary("parakeet", { env, existsImpl: only("/usr/bin/parakeet-cli") });
    // A bare name would be re-resolved against the spawn's PATH, which may
    // differ from the one we probed.
    expect(got?.startsWith("/")).toBe(true);
  });

  test("undefined when genuinely absent", () => {
    expect(resolveCliBinary("whisper", { env, existsImpl: () => false })).toBeUndefined();
  });

  test("engine selects the binary — a whisper install doesn't satisfy parakeet", () => {
    const deps = { env, existsImpl: only("/usr/bin/whisper-cli") };
    expect(resolveCliBinary("whisper", deps)).toBe("/usr/bin/whisper-cli");
    expect(resolveCliBinary("parakeet", deps)).toBeUndefined();
  });
});

describe("resolveFfmpeg", () => {
  test("uses the same ladder, so a brew ffmpeg is found under launchd too", () => {
    const got = resolveFfmpeg({
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      existsImpl: only("/opt/homebrew/bin/ffmpeg"),
    });
    expect(got).toBe("/opt/homebrew/bin/ffmpeg");
  });
});

describe("managed paths honour PARACHUTE_HOME", () => {
  test("bin + model dirs sit under the ecosystem root", () => {
    const env = { PARACHUTE_HOME: "/custom/root" } as NodeJS.ProcessEnv;
    expect(managedBinDir(env)).toBe(join("/custom/root", "transcription", "bin"));
    expect(managedModelDir(env)).toBe(join("/custom/root", "transcription", "models"));
  });
});
