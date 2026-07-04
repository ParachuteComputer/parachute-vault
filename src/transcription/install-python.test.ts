import { describe, test, expect } from "bun:test";
import { join } from "path";
import {
  PYTHON_PROVIDERS,
  installPythonBackend,
  type PythonInstallDeps,
  type PythonProviderName,
  type RunResult,
} from "./install-python.ts";
import { pythonVenvDir } from "./select.ts";

/**
 * Install-routine tests for the python providers (scribe-fold Phase 2b) —
 * every subprocess/platform probe goes through the injected deps, so the tier
 * guards, apt/venv logic, warm-pull, and idempotency are exercised WITHOUT
 * installing anything. Ported discipline from scribe's install-backend tests.
 */

const GB = 2 ** 30;
const HOME = "/test-home";

type DepsOverrides = Partial<Omit<PythonInstallDeps, "run" | "which" | "existsImpl">> & {
  run?: (cmd: string[]) => Promise<RunResult>;
  /** Binaries "on PATH". */
  path?: Record<string, string>;
  /** Files that "exist" on disk. */
  files?: Set<string>;
};

function makeDeps(over: DepsOverrides = {}): { deps: PythonInstallDeps; runs: string[][]; logs: string[] } {
  const runs: string[][] = [];
  const logs: string[] = [];
  const files = over.files ?? new Set<string>();
  const path = over.path ?? {};
  const deps: PythonInstallDeps = {
    run: async (cmd) => {
      runs.push(cmd);
      if (over.run) return over.run(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    which: (bin) => path[bin] ?? null,
    platform: over.platform ?? "linux",
    arch: over.arch ?? "x64",
    totalRamBytes: over.totalRamBytes ?? 8 * GB,
    uid: over.uid ?? (() => 1000),
    env: over.env ?? { PARACHUTE_HOME: HOME },
    existsImpl: (p) => files.has(p),
    log: (line) => logs.push(line),
  };
  return { deps, runs, logs };
}

const venvBin = (bin: string) => join(pythonVenvDir({ PARACHUTE_HOME: HOME }), "bin", bin);

/** Deps for a happy-path Linux onnx-asr install: python3+ffmpeg present, and
 *  the venv binary "appears" after the pip run. */
function linuxHappyDeps(provider: PythonProviderName = "onnx-asr") {
  const spec = PYTHON_PROVIDERS[provider];
  const files = new Set<string>();
  const { deps, runs, logs } = makeDeps({
    path: { python3: "/usr/bin/python3", ffmpeg: "/usr/bin/ffmpeg", sudo: "/usr/bin/sudo" },
    files,
    run: async (cmd) => {
      // pip install → the venv binary materializes.
      if (cmd.some((c) => c.endsWith("/pip"))) files.add(venvBin(spec.bin));
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  return { deps, runs, logs, files };
}

// ---------------------------------------------------------------------------
// Platform / arch gates (never bypassed)
// ---------------------------------------------------------------------------

describe("installPythonBackend — platform gates", () => {
  test("parakeet-mlx on Linux → refused (darwin-only), even with --force", async () => {
    const { deps, runs } = makeDeps({ platform: "linux" });
    const out = await installPythonBackend(deps, { provider: "parakeet-mlx", force: true });
    expect(out.ok).toBe(false);
    expect(out.steps[0]!.status).toBe("refused");
    expect(out.summary).toContain("darwin");
    expect(runs.length).toBe(0); // nothing ran
  });

  test("parakeet-mlx on Intel mac (darwin/x64) → refused (Apple Silicon only)", async () => {
    const { deps } = makeDeps({ platform: "darwin", arch: "x64", totalRamBytes: 32 * GB });
    const out = await installPythonBackend(deps, { provider: "parakeet-mlx", force: true });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("arm64");
  });

  test("onnx-asr has no platform gate (installable on macOS too)", async () => {
    const files = new Set<string>([venvBin("onnx-asr")]); // already installed → skips pip
    const { deps } = makeDeps({
      platform: "darwin",
      arch: "arm64",
      files,
      path: { python3: "/usr/bin/python3", ffmpeg: "/opt/ffmpeg" },
    });
    const out = await installPythonBackend(deps, { provider: "onnx-asr", skipModel: true });
    expect(out.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RAM floors (the ratified tiers; --force bypasses)
// ---------------------------------------------------------------------------

describe("installPythonBackend — RAM floors", () => {
  test("onnx-asr below 4GB → refused with the scribe#82 rationale", async () => {
    const { deps } = makeDeps({ totalRamBytes: 2 * GB });
    const out = await installPythonBackend(deps, { provider: "onnx-asr" });
    expect(out.ok).toBe(false);
    const ram = out.steps.find((s) => s.name === "ram-guard")!;
    expect(ram.status).toBe("refused");
    expect(ram.detail).toContain("scribe#82");
  });

  test("parakeet-mlx below 8GB → refused, steers to transcribe-cpp", async () => {
    const { deps } = makeDeps({ platform: "darwin", arch: "arm64", totalRamBytes: 4 * GB });
    const out = await installPythonBackend(deps, { provider: "parakeet-mlx" });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("transcribe-cpp");
  });

  test("nominal-4GB box reporting 3.8GB → passes the onnx-asr floor (slack)", async () => {
    const { deps } = linuxHappyDeps();
    deps.totalRamBytes = 3.8 * GB;
    const out = await installPythonBackend(deps, { provider: "onnx-asr", skipModel: true });
    expect(out.steps.find((s) => s.name === "ram-guard")!.status).toBe("ok");
    expect(out.ok).toBe(true);
  });

  test("--force bypasses the RAM floor with a loud warning step", async () => {
    const { deps, files } = linuxHappyDeps();
    deps.totalRamBytes = 2 * GB;
    void files;
    const out = await installPythonBackend(deps, { provider: "onnx-asr", force: true, skipModel: true });
    expect(out.ok).toBe(true);
    const ram = out.steps.find((s) => s.name === "ram-guard")!;
    expect(ram.status).toBe("skipped");
    expect(ram.detail).toContain("--force");
  });
});

// ---------------------------------------------------------------------------
// System deps (apt on Linux; instruct on macOS)
// ---------------------------------------------------------------------------

describe("installPythonBackend — system deps", () => {
  test("Linux with python3+ffmpeg present → apt skipped entirely", async () => {
    const { deps, runs } = linuxHappyDeps();
    const out = await installPythonBackend(deps, { provider: "onnx-asr", skipModel: true });
    expect(out.steps.find((s) => s.name === "system-deps")!.status).toBe("skipped");
    expect(runs.some((r) => r.includes("apt-get"))).toBe(false);
  });

  test("Linux missing ffmpeg, non-root with sudo → sudo apt-get install", async () => {
    const files = new Set<string>();
    const { deps, runs } = makeDeps({
      path: { python3: "/usr/bin/python3", sudo: "/usr/bin/sudo", "apt-get": "/usr/bin/apt-get" },
      files,
      run: async (cmd) => {
        if (cmd.some((c) => c.endsWith("/pip"))) files.add(venvBin("onnx-asr"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const out = await installPythonBackend(deps, { provider: "onnx-asr", skipModel: true });
    expect(out.ok).toBe(true);
    const aptInstall = runs.find((r) => r.includes("install") && r.includes("apt-get"))!;
    expect(aptInstall[0]).toBe("sudo");
    expect(aptInstall).toContain("ffmpeg");
    expect(aptInstall).toContain("python3-venv");
  });

  test("Linux as root → apt without sudo", async () => {
    const files = new Set<string>();
    const { deps, runs } = makeDeps({
      uid: () => 0,
      path: { python3: "/usr/bin/python3", "apt-get": "/usr/bin/apt-get" },
      files,
      run: async (cmd) => {
        if (cmd.some((c) => c.endsWith("/pip"))) files.add(venvBin("onnx-asr"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await installPythonBackend(deps, { provider: "onnx-asr", skipModel: true });
    const aptInstall = runs.find((r) => r.includes("install") && r.includes("apt-get"))!;
    expect(aptInstall[0]).toBe("apt-get");
  });

  test("Linux, deps missing, no root and no sudo → failed step with the exact command to run", async () => {
    const { deps } = makeDeps({ path: { "apt-get": "/usr/bin/apt-get" } });
    const out = await installPythonBackend(deps, { provider: "onnx-asr" });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("sudo apt-get install");
  });

  test("a transient apt-get update failure does NOT abort (install still runs)", async () => {
    const files = new Set<string>();
    const { deps } = makeDeps({
      path: { python3: "/usr/bin/python3", sudo: "/usr/bin/sudo", "apt-get": "/usr/bin/apt-get" },
      files,
      run: async (cmd) => {
        if (cmd.includes("update")) return { exitCode: 100, stdout: "", stderr: "mirror down" };
        if (cmd.some((c) => c.endsWith("/pip"))) files.add(venvBin("onnx-asr"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const out = await installPythonBackend(deps, { provider: "onnx-asr", skipModel: true });
    expect(out.ok).toBe(true);
  });

  test("macOS missing ffmpeg → instruct (skipped step naming brew), never drives brew", async () => {
    const files = new Set<string>([venvBin("parakeet-mlx")]);
    const { deps, runs } = makeDeps({
      platform: "darwin",
      arch: "arm64",
      totalRamBytes: 16 * GB,
      path: { python3: "/usr/bin/python3" },
      files,
    });
    const out = await installPythonBackend(deps, { provider: "parakeet-mlx" });
    const sys = out.steps.find((s) => s.name === "system-deps")!;
    expect(sys.status).toBe("skipped");
    expect(sys.detail).toContain("brew install ffmpeg");
    expect(runs.some((r) => r[0] === "brew")).toBe(false);
  });

  test("macOS missing python3 entirely → failed with an actionable fix", async () => {
    const { deps } = makeDeps({ platform: "darwin", arch: "arm64", totalRamBytes: 16 * GB });
    const out = await installPythonBackend(deps, { provider: "parakeet-mlx" });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("python3");
  });
});

// ---------------------------------------------------------------------------
// venv + pip + idempotency
// ---------------------------------------------------------------------------

describe("installPythonBackend — venv package install", () => {
  test("happy path: venv created under PARACHUTE_HOME, pip installs the extras target", async () => {
    const { deps, runs } = linuxHappyDeps();
    const out = await installPythonBackend(deps, { provider: "onnx-asr", skipModel: true });
    expect(out.ok).toBe(true);
    expect(out.binPath).toBe(venvBin("onnx-asr"));
    expect(out.venv).toBe(pythonVenvDir({ PARACHUTE_HOME: HOME }));
    const mkVenv = runs.find((r) => r[0] === "python3" && r.includes("venv"))!;
    expect(mkVenv[3]).toBe(pythonVenvDir({ PARACHUTE_HOME: HOME }));
    const pip = runs.find((r) => r[0]?.endsWith("/pip"))!;
    expect(pip).toContain("onnx-asr[cpu,hub]");
  });

  test("idempotent: an already-runnable binary skips venv+pip entirely", async () => {
    const files = new Set<string>([venvBin("onnx-asr")]);
    const { deps, runs } = makeDeps({
      path: { python3: "/usr/bin/python3", ffmpeg: "/usr/bin/ffmpeg" },
      files,
    });
    const out = await installPythonBackend(deps, { provider: "onnx-asr", skipModel: true });
    expect(out.ok).toBe(true);
    expect(out.steps.find((s) => s.name === "package")!.status).toBe("skipped");
    expect(runs.some((r) => r[0] === "python3")).toBe(false);
  });

  test("an operator's own PATH install counts as runnable (no venv forced)", async () => {
    const files = new Set<string>(["/usr/local/bin/parakeet-mlx"]);
    const { deps } = makeDeps({
      platform: "darwin",
      arch: "arm64",
      totalRamBytes: 16 * GB,
      path: { python3: "/usr/bin/python3", ffmpeg: "/opt/ffmpeg", "parakeet-mlx": "/usr/local/bin/parakeet-mlx" },
      files,
    });
    const out = await installPythonBackend(deps, { provider: "parakeet-mlx" });
    expect(out.ok).toBe(true);
    expect(out.binPath).toBe("/usr/local/bin/parakeet-mlx");
    expect(out.venv).toBe(""); // not vault's venv
  });

  test("pip failure → failed step, non-fatal outcome (no throw)", async () => {
    const { deps } = makeDeps({
      path: { python3: "/usr/bin/python3", ffmpeg: "/usr/bin/ffmpeg" },
      run: async (cmd) =>
        cmd[0]?.endsWith("/pip")
          ? { exitCode: 1, stdout: "", stderr: "no matching distribution" }
          : { exitCode: 0, stdout: "", stderr: "" },
    });
    const out = await installPythonBackend(deps, { provider: "onnx-asr" });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("pip install onnx-asr[cpu,hub] failed");
  });

  test("venv creation failure names python3-venv", async () => {
    const { deps } = makeDeps({
      path: { python3: "/usr/bin/python3", ffmpeg: "/usr/bin/ffmpeg" },
      run: async (cmd) =>
        cmd[0] === "python3"
          ? { exitCode: 1, stdout: "", stderr: "ensurepip missing" }
          : { exitCode: 0, stdout: "", stderr: "" },
    });
    const out = await installPythonBackend(deps, { provider: "onnx-asr" });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("python3-venv");
  });
});

// ---------------------------------------------------------------------------
// Model warm-pull (best-effort) + verify
// ---------------------------------------------------------------------------

describe("installPythonBackend — warm-pull + verify", () => {
  test("onnx-asr warm-pulls the ratified model via `<bin> <model> --help`", async () => {
    const { deps, runs } = linuxHappyDeps();
    const out = await installPythonBackend(deps, { provider: "onnx-asr" });
    expect(out.ok).toBe(true);
    const pull = runs.find((r) => r.includes("--help"))!;
    expect(pull[0]).toBe(venvBin("onnx-asr"));
    expect(pull[1]).toBe("nemo-parakeet-tdt-0.6b-v3");
  });

  test("a warm-pull failure is non-fatal (model lazy-loads on first transcription)", async () => {
    const files = new Set<string>();
    const { deps } = makeDeps({
      path: { python3: "/usr/bin/python3", ffmpeg: "/usr/bin/ffmpeg" },
      files,
      run: async (cmd) => {
        if (cmd.some((c) => c.endsWith("/pip"))) files.add(venvBin("onnx-asr"));
        if (cmd.includes("--help")) return { exitCode: 1, stdout: "", stderr: "offline" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const out = await installPythonBackend(deps, { provider: "onnx-asr" });
    expect(out.ok).toBe(true);
    expect(out.steps.find((s) => s.name === "model-warm-pull")!.status).toBe("skipped");
  });

  test("parakeet-mlx never warm-pulls (model downloads on first use)", async () => {
    const files = new Set<string>([venvBin("parakeet-mlx")]);
    const { deps, runs } = makeDeps({
      platform: "darwin",
      arch: "arm64",
      totalRamBytes: 16 * GB,
      path: { python3: "/usr/bin/python3", ffmpeg: "/opt/ffmpeg" },
      files,
    });
    const out = await installPythonBackend(deps, { provider: "parakeet-mlx" });
    expect(out.ok).toBe(true);
    expect(out.steps.find((s) => s.name === "model-warm-pull")!.status).toBe("skipped");
    expect(runs.some((r) => r.includes("--help"))).toBe(false);
  });

  test("HONEST verify: pip 'succeeds' but no binary appears → ok:false, no activation signal", async () => {
    // The honest-install rule (PRs #532/#533): never report ok without a
    // runnable binary — the CLI only flips TRANSCRIPTION_PROVIDER on ok.
    const { deps } = makeDeps({
      path: { python3: "/usr/bin/python3", ffmpeg: "/usr/bin/ffmpeg" },
    });
    const out = await installPythonBackend(deps, { provider: "onnx-asr", skipModel: true });
    expect(out.ok).toBe(false);
    expect(out.binPath).toBeUndefined();
    expect(out.steps.find((s) => s.name === "verify")!.status).toBe("failed");
  });
});
