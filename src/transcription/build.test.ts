import { describe, test, expect } from "bun:test";
import { join } from "path";
import {
  buildTranscribeCli,
  buildCompileCommand,
  detectCompiler,
  compilerInstallHint,
  cliSourceUrl,
  CLI_SOURCE_FILES,
  CXX_CANDIDATES,
  TRANSCRIBE_CPP_SOURCE_REF,
  type BuildCliDeps,
  type CompileResult,
} from "./build.ts";

/**
 * transcribe-cli build tests (scribe-fold Phase 2b). Pure recipe shape +
 * fully-mocked orchestration — NO network, NO real compiler (the real compile
 * is exercised only by the install-time live verify). Covers the toolchain-
 * absent, fetch-failure, compile-failure, and success branches, and the
 * "never leave a half-built binary" invariant.
 */

describe("detectCompiler", () => {
  test("returns the first candidate found (c++ preferred)", () => {
    const which = (c: string) => (c === "c++" ? "/usr/bin/c++" : null);
    expect(detectCompiler(which)).toBe("/usr/bin/c++");
  });
  test("falls through to a later candidate when earlier ones are absent", () => {
    const which = (c: string) => (c === "g++" ? "/usr/bin/g++" : null);
    expect(detectCompiler(which)).toBe("/usr/bin/g++");
  });
  test("returns null when NO compiler is on PATH", () => {
    expect(detectCompiler(() => null)).toBeNull();
    expect(detectCompiler(() => undefined)).toBeNull();
  });
  test("probes the documented candidate order", () => {
    expect([...CXX_CANDIDATES]).toEqual(["c++", "clang++", "g++"]);
  });
});

describe("compilerInstallHint", () => {
  test("macOS → xcode-select", () => {
    expect(compilerInstallHint("darwin")).toContain("xcode-select --install");
  });
  test("linux → build-essential / gcc-c++", () => {
    const h = compilerInstallHint("linux");
    expect(h).toContain("build-essential");
    expect(h).toContain("gcc-c++");
  });
  test("other → generic compiler hint", () => {
    expect(compilerInstallHint("win32")).toContain("c++/clang++/g++");
  });
});

describe("cliSourceUrl + CLI_SOURCE_FILES", () => {
  test("URL pins the exact v0.1.1 source ref", () => {
    const url = cliSourceUrl("examples/cli/main.cpp");
    expect(url).toContain("raw.githubusercontent.com/handy-computer/transcribe.cpp");
    expect(url).toContain(TRANSCRIBE_CPP_SOURCE_REF);
    expect(url.endsWith("/examples/cli/main.cpp")).toBe(true);
  });
  test("source set covers the CLI + WAV loader + public header", () => {
    expect(CLI_SOURCE_FILES).toContain("examples/cli/main.cpp");
    expect(CLI_SOURCE_FILES).toContain("examples/common/wav.cpp");
    expect(CLI_SOURCE_FILES).toContain("examples/common/wav.h");
    expect(CLI_SOURCE_FILES).toContain("examples/common/dr_wav.h");
    expect(CLI_SOURCE_FILES).toContain("include/transcribe.h");
    // headers main.cpp includes directly
    expect(CLI_SOURCE_FILES).toContain("include/transcribe/parakeet.h");
    expect(CLI_SOURCE_FILES).toContain("include/transcribe/whisper.h");
    expect(CLI_SOURCE_FILES).toContain("include/transcribe/voxtral_realtime.h");
  });
});

describe("buildCompileCommand — the proven recipe shape", () => {
  const base = {
    compiler: "/usr/bin/c++",
    srcDir: "/root/.parachute/transcription/.src",
    libsDir: "/root/.parachute/transcription/libs",
    outPath: "/root/.parachute/transcription/bin/transcribe-cli",
  };

  test("macOS → @loader_path/../libs rpath", () => {
    const cmd = buildCompileCommand({ ...base, platform: "darwin" });
    expect(cmd[0]).toBe("/usr/bin/c++");
    expect(cmd).toContain("-std=c++17");
    expect(cmd).toContain(`-I${join(base.srcDir, "include")}`);
    expect(cmd).toContain(`-I${join(base.srcDir, "examples", "common")}`);
    expect(cmd).toContain(join(base.srcDir, "examples", "cli", "main.cpp"));
    expect(cmd).toContain(join(base.srcDir, "examples", "common", "wav.cpp"));
    expect(cmd).toContain(`-L${base.libsDir}`);
    expect(cmd).toContain("-ltranscribe");
    expect(cmd).toContain("-Wl,-rpath,@loader_path/../libs");
    // output is the final -o <path>
    expect(cmd[cmd.length - 2]).toBe("-o");
    expect(cmd[cmd.length - 1]).toBe(base.outPath);
  });

  test("Linux → $ORIGIN/../libs rpath (literal — passed to argv, not a shell)", () => {
    const cmd = buildCompileCommand({ ...base, platform: "linux" });
    expect(cmd).toContain("-Wl,-rpath,$ORIGIN/../libs");
    expect(cmd).not.toContain("-Wl,-rpath,@loader_path/../libs");
  });
});

/** Build a deps object with call-recording mocks; overrides win. */
function mkDeps(over: Partial<BuildCliDeps> = {}): BuildCliDeps & {
  calls: { fetch: number; compile: number; removed: string[] };
} {
  const calls = { fetch: 0, compile: 0, removed: [] as string[] };
  const deps: BuildCliDeps = {
    platform: "darwin",
    which: (c) => (c === "c++" ? "/usr/bin/c++" : null),
    fetchSource: async () => {
      calls.fetch++;
    },
    compile: async (): Promise<CompileResult> => {
      calls.compile++;
      return { exitCode: 0, stderr: "" };
    },
    exists: () => true,
    removeBin: (p) => {
      calls.removed.push(p);
    },
    ...over,
  };
  return Object.assign(deps, { calls });
}

const INPUT = { srcDir: "/t/.src", libsDir: "/t/libs", binPath: "/t/bin/transcribe-cli" };

describe("buildTranscribeCli — orchestration branches", () => {
  test("SUCCESS: fetch → compile ok → binary exists ⇒ { ok:true }", async () => {
    const deps = mkDeps();
    const r = await buildTranscribeCli(INPUT, deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.binPath).toBe(INPUT.binPath);
      expect(r.compiler).toBe("/usr/bin/c++");
      expect(r.command).toContain("-ltranscribe");
    }
    expect(deps.calls.fetch).toBe(1);
    expect(deps.calls.compile).toBe(1);
    // removed once pre-compile (never compile over a stale binary), not again on success
    expect(deps.calls.removed).toEqual([INPUT.binPath]);
  });

  test("TOOLCHAIN ABSENT: no compiler ⇒ { ok:false, stage:'toolchain' }, no fetch/compile", async () => {
    const deps = mkDeps({ which: () => null });
    const r = await buildTranscribeCli(INPUT, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("toolchain");
      expect(r.message).toContain("no C++ compiler");
      expect(r.message).toContain("xcode-select"); // darwin hint embedded
    }
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.compile).toBe(0);
  });

  test("FETCH FAILURE: fetchSource throws ⇒ { ok:false, stage:'fetch' }, no compile", async () => {
    const deps = mkDeps({
      fetchSource: async () => {
        throw new Error("network down");
      },
    });
    const r = await buildTranscribeCli(INPUT, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("fetch");
      expect(r.message).toContain("network down");
      expect(r.message).toContain(TRANSCRIBE_CPP_SOURCE_REF);
    }
    expect(deps.calls.compile).toBe(0);
  });

  test("COMPILE FAILURE (nonzero exit): keeps provider + surfaces stderr + command; removes half-built binary", async () => {
    const deps = mkDeps({
      compile: async () => ({ exitCode: 1, stderr: "main.cpp:9: fatal error: transcribe.h not found" }),
    });
    const r = await buildTranscribeCli(INPUT, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("compile");
      expect(r.message).toContain("transcribe.h not found");
      expect(r.command).toContain("-ltranscribe");
    }
    // removeBin called twice: pre-compile guard + post-failure cleanup (never leave a half-built binary)
    expect(deps.calls.removed).toEqual([INPUT.binPath, INPUT.binPath]);
  });

  test("COMPILE 'succeeds' but output missing ⇒ { ok:false, stage:'compile' } + cleanup", async () => {
    const deps = mkDeps({ exists: () => false });
    const r = await buildTranscribeCli(INPUT, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("compile");
    expect(deps.calls.removed).toEqual([INPUT.binPath, INPUT.binPath]);
  });
});
