import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  resolveTranscriptionProviderName,
  resolveTranscribeCppPaths,
  transcribeCppInstalled,
  probeTranscribeCliRunnable,
  readManifest,
  transcriptionHomeDir,
  pythonVenvDir,
  pythonManifestPath,
  readPythonManifest,
  resolveParakeetMlxBin,
  resolveOnnxAsrBin,
  resolveParakeetMlxModel,
  resolveOnnxAsrModel,
  parakeetMlxInstalled,
  onnxAsrInstalled,
  DEFAULT_PARAKEET_MLX_MODEL,
  DEFAULT_ONNX_ASR_MODEL,
} from "./select.ts";

/**
 * Provider-selection + path-resolution tests (scribe-fold Phase 2a). All env is
 * passed explicitly so the shared bun-test process isn't polluted.
 */

const silent = { warn: () => {} };

describe("resolveTranscriptionProviderName", () => {
  // Scribe presence is injected in every case. Left to production resolution it
  // would read the developer's real ~/.parachute/services.json, so "unset" would
  // resolve differently on a box that happens to have scribe installed — the
  // test would pass for the wrong reason on one machine and fail on another.
  const noScribe = { scribeConfiguredImpl: () => false };
  const withScribe = { scribeConfiguredImpl: () => true };

  test("unset + no scribe → whisper-cpp (the local default)", () => {
    // The default a fresh box gets. `scribe-http` used to win here and was
    // unreachable, so audio was accepted and never transcribed.
    expect(resolveTranscriptionProviderName({}, silent, noScribe)).toBe("whisper-cpp");
  });

  test("unset + a reachable scribe → scribe-http (a working box keeps working)", () => {
    // The safety property of the flip. These operators configured scribe by
    // NOT configuring anything, so "unset" can't be read as "wants local" —
    // flipping unconditionally would take transcription away from them.
    expect(resolveTranscriptionProviderName({}, silent, withScribe)).toBe("scribe-http");
  });

  test("blank → same default resolution as unset", () => {
    expect(resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "  " }, silent, noScribe)).toBe(
      "whisper-cpp",
    );
    expect(resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "  " }, silent, withScribe)).toBe(
      "scribe-http",
    );
  });

  test("an EXPLICIT scribe-http is honored even with no scribe reachable", () => {
    // Explicit config always wins over the probe: the operator may be about to
    // start scribe, or point SCRIBE_URL somewhere that's briefly down. Silently
    // overriding a stated choice is its own bug.
    expect(
      resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "scribe-http" }, silent, noScribe),
    ).toBe("scribe-http");
  });

  test("an EXPLICIT whisper-cpp is honored even when scribe IS reachable", () => {
    expect(
      resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "whisper-cpp" }, silent, withScribe),
    ).toBe("whisper-cpp");
  });

  test("explicit transcribe-cpp", () => {
    expect(
      resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "transcribe-cpp" }, silent, noScribe),
    ).toBe("transcribe-cpp");
  });

  test("explicit parakeet-mlx / onnx-asr (scribe-fold Phase 2b)", () => {
    expect(
      resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "parakeet-mlx" }, silent, noScribe),
    ).toBe("parakeet-mlx");
    expect(
      resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "onnx-asr" }, silent, noScribe),
    ).toBe("onnx-asr");
  });

  test("unknown value → warns + falls back to the DEFAULT, not to scribe-http", () => {
    // The fallback follows the same rule as unset, so a typo on a box with no
    // scribe lands on the provider that can actually run rather than a dead one.
    let warned = "";
    const name = resolveTranscriptionProviderName(
      { TRANSCRIPTION_PROVIDER: "whisper-magic" },
      { warn: (...a: unknown[]) => (warned = a.join(" ")) },
      noScribe,
    );
    expect(name).toBe("whisper-cpp");
    // The warning must name what it fell back TO, or the operator can't tell
    // which provider is actually running.
    expect(warned).toContain("whisper-magic");
    expect(warned).toContain("whisper-cpp");
  });

  test("unknown value on a scribe box falls back to scribe-http", () => {
    let warned = "";
    const name = resolveTranscriptionProviderName(
      { TRANSCRIPTION_PROVIDER: "whisper-magic" },
      { warn: (...a: unknown[]) => (warned = a.join(" ")) },
      withScribe,
    );
    expect(name).toBe("scribe-http");
    expect(warned).toContain("scribe-http");
  });

  test("the scribe probe is consulted ONLY when there's no explicit provider", () => {
    // Cheap guard against a regression that makes every capability check stat
    // services.json — this runs on the per-upload path.
    let probes = 0;
    const counting = { scribeConfiguredImpl: () => (probes++, false) };
    resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "whisper-cpp" }, silent, counting);
    expect(probes).toBe(0);
    resolveTranscriptionProviderName({}, silent, counting);
    expect(probes).toBe(1);
  });
});

describe("transcriptionHomeDir + resolveTranscribeCppPaths — PARACHUTE_HOME + overrides", () => {
  test("honors PARACHUTE_HOME", () => {
    const dir = transcriptionHomeDir({ PARACHUTE_HOME: "/custom/home" });
    expect(dir).toBe(join("/custom/home", "transcription"));
  });

  test("default binPath/modelsDir under the transcription dir", () => {
    const paths = resolveTranscribeCppPaths({ PARACHUTE_HOME: "/h" });
    expect(paths.binPath).toBe(join("/h", "transcription", "bin", "transcribe-cli"));
    expect(paths.modelsDir).toBe(join("/h", "transcription", "models"));
    expect(paths.manifestPath).toBe(join("/h", "transcription", "install.json"));
  });

  test("TRANSCRIBE_CPP_BIN + TRANSCRIBE_CPP_MODEL env overrides win", () => {
    const paths = resolveTranscribeCppPaths({
      PARACHUTE_HOME: "/h",
      TRANSCRIBE_CPP_BIN: "/opt/tc",
      TRANSCRIBE_CPP_MODEL: "/models/custom.gguf",
    });
    expect(paths.binPath).toBe("/opt/tc");
    expect(paths.modelPath).toBe("/models/custom.gguf");
  });

  test("model path resolves from the install manifest when no env override", () => {
    const home = mkTmpHome();
    writeManifest(home, { modelFile: "whisper-small.en-Q5_K_M.gguf", model: "whisper-small.en" });
    const paths = resolveTranscribeCppPaths({ PARACHUTE_HOME: home });
    expect(paths.modelPath).toBe(join(home, "transcription", "models", "whisper-small.en-Q5_K_M.gguf"));
  });

  test("no manifest, no env → modelPath undefined", () => {
    const home = mkTmpHome();
    expect(resolveTranscribeCppPaths({ PARACHUTE_HOME: home }).modelPath).toBeUndefined();
  });
});

describe("transcribeCppInstalled", () => {
  test("true only when both binary AND model exist on disk", () => {
    const home = mkTmpHome();
    const tcDir = join(home, "transcription");
    mkdirSync(join(tcDir, "bin"), { recursive: true });
    mkdirSync(join(tcDir, "models"), { recursive: true });
    // Neither present yet.
    expect(transcribeCppInstalled(resolveTranscribeCppPaths({ PARACHUTE_HOME: home }))).toBe(false);

    // Binary only → still false.
    writeFileSync(join(tcDir, "bin", "transcribe-cli"), "#!/bin/sh\n");
    writeManifest(home, { modelFile: "m.gguf", model: "whisper-tiny.en" });
    expect(transcribeCppInstalled(resolveTranscribeCppPaths({ PARACHUTE_HOME: home }))).toBe(false);

    // Model too → true.
    writeFileSync(join(tcDir, "models", "m.gguf"), "gguf");
    expect(transcribeCppInstalled(resolveTranscribeCppPaths({ PARACHUTE_HOME: home }))).toBe(true);
  });
});

describe("probeTranscribeCliRunnable — EXECUTED, not stat'd (vault#534)", () => {
  // Tiny real shell scripts stand in for transcribe-cli: the probe's whole
  // point is that it actually runs the binary, so mocks would test nothing.
  function script(home: string, body: string): string {
    const p = join(home, "fake-cli");
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  test("exit 0 ⇒ ok", async () => {
    const bin = script(mkTmpHome(), "exit 0");
    expect(await probeTranscribeCliRunnable(bin)).toEqual({ ok: true });
  });

  test("nonzero exit ⇒ not ok, reason carries the exit code + first stderr line", async () => {
    // Mirrors the vault#534 Linux failure shape: binary present + launches,
    // but errors out (there: empty ggml backend registry, exit 1).
    const bin = script(mkTmpHome(), 'echo "whisper: failed to initialize CPU backend" >&2\nexit 1');
    const r = await probeTranscribeCliRunnable(bin);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("exited 1");
    expect(r.reason).toContain("failed to initialize CPU backend");
  });

  test("unlaunchable binary (missing) ⇒ not ok with a reason", async () => {
    const r = await probeTranscribeCliRunnable(join(mkTmpHome(), "no-such-cli"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  test("hang ⇒ not ok after the timeout", async () => {
    const bin = script(mkTmpHome(), "sleep 30");
    const r = await probeTranscribeCliRunnable(bin, { timeoutMs: 250 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("250ms");
  });
});

describe("readManifest", () => {
  test("returns null for a missing/unreadable manifest", () => {
    expect(readManifest(join(tmpdir(), "does-not-exist-xyz.json"))).toBeNull();
  });
  test("parses a written manifest", () => {
    const home = mkTmpHome();
    writeManifest(home, { model: "whisper-tiny.en", modelFile: "t.gguf" });
    const m = readManifest(join(home, "transcription", "install.json"));
    expect(m?.model).toBe("whisper-tiny.en");
  });
});

// --- python providers (parakeet-mlx / onnx-asr) — scribe-fold Phase 2b ------

describe("python provider bin resolution (env → venv → PATH)", () => {
  const noHit = { existsImpl: () => false, whichImpl: () => null };

  test("pythonVenvDir lives under the transcription home", () => {
    expect(pythonVenvDir({ PARACHUTE_HOME: "/h" })).toBe(join("/h", "transcription", "venv"));
  });

  test("env override wins and is returned verbatim (existence is the caller's check)", () => {
    expect(resolveParakeetMlxBin({ PARACHUTE_HOME: "/h", PARAKEET_MLX_BIN: "/opt/pk" }, noHit)).toBe("/opt/pk");
    expect(resolveOnnxAsrBin({ PARACHUTE_HOME: "/h", ONNX_ASR_BIN: "/opt/ox" }, noHit)).toBe("/opt/ox");
  });

  test("managed venv binary beats PATH", () => {
    const venvPk = join("/h", "transcription", "venv", "bin", "parakeet-mlx");
    const bin = resolveParakeetMlxBin(
      { PARACHUTE_HOME: "/h" },
      { existsImpl: (p) => p === venvPk, whichImpl: () => "/usr/local/bin/parakeet-mlx" },
    );
    expect(bin).toBe(venvPk);
  });

  test("falls back to PATH when no venv binary exists", () => {
    const bin = resolveOnnxAsrBin(
      { PARACHUTE_HOME: "/h" },
      { existsImpl: () => false, whichImpl: (b) => (b === "onnx-asr" ? "/usr/local/bin/onnx-asr" : null) },
    );
    expect(bin).toBe("/usr/local/bin/onnx-asr");
  });

  test("nothing anywhere → undefined (provider reports unavailable)", () => {
    expect(resolveParakeetMlxBin({ PARACHUTE_HOME: "/h" }, noHit)).toBeUndefined();
    expect(resolveOnnxAsrBin({ PARACHUTE_HOME: "/h" }, noHit)).toBeUndefined();
  });
});

describe("parakeetMlxInstalled / onnxAsrInstalled", () => {
  test("true only when the resolved binary exists on disk", () => {
    const home = mkTmpHome();
    const env = { PARACHUTE_HOME: home };
    expect(parakeetMlxInstalled(env, { whichImpl: () => null })).toBe(false);
    expect(onnxAsrInstalled(env, { whichImpl: () => null })).toBe(false);

    const binDir = join(home, "transcription", "venv", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "onnx-asr"), "#!/bin/sh\n");
    expect(onnxAsrInstalled(env, { whichImpl: () => null })).toBe(true);
    expect(parakeetMlxInstalled(env, { whichImpl: () => null })).toBe(false);
  });

  test("an env override pointing at a missing file is NOT installed (honesty)", () => {
    const home = mkTmpHome();
    expect(
      onnxAsrInstalled({ PARACHUTE_HOME: home, ONNX_ASR_BIN: "/nope/onnx-asr" }, { whichImpl: () => null }),
    ).toBe(false);
  });
});

describe("python model resolution (env → manifest → ratified default)", () => {
  test("defaults are the ratified v3 models", () => {
    const home = mkTmpHome();
    expect(resolveParakeetMlxModel({ PARACHUTE_HOME: home })).toBe(DEFAULT_PARAKEET_MLX_MODEL);
    expect(resolveOnnxAsrModel({ PARACHUTE_HOME: home })).toBe(DEFAULT_ONNX_ASR_MODEL);
  });

  test("env overrides win", () => {
    const home = mkTmpHome();
    expect(resolveParakeetMlxModel({ PARACHUTE_HOME: home, PARAKEET_MLX_MODEL: "mlx-community/custom" })).toBe(
      "mlx-community/custom",
    );
    expect(resolveOnnxAsrModel({ PARACHUTE_HOME: home, ONNX_ASR_MODEL: "whisper-base" })).toBe("whisper-base");
  });

  test("the install manifest's model applies to ITS provider only", () => {
    const home = mkTmpHome();
    const tcDir = join(home, "transcription");
    mkdirSync(tcDir, { recursive: true });
    writeFileSync(
      join(tcDir, "install-python.json"),
      JSON.stringify({ provider: "onnx-asr", model: "manifest-model" }),
    );
    expect(resolveOnnxAsrModel({ PARACHUTE_HOME: home })).toBe("manifest-model");
    // A parakeet lookup ignores an onnx manifest.
    expect(resolveParakeetMlxModel({ PARACHUTE_HOME: home })).toBe(DEFAULT_PARAKEET_MLX_MODEL);
  });
});

describe("readPythonManifest", () => {
  test("returns null for a missing manifest", () => {
    const home = mkTmpHome();
    expect(readPythonManifest(pythonManifestPath({ PARACHUTE_HOME: home }))).toBeNull();
  });
  test("parses a written manifest", () => {
    const home = mkTmpHome();
    const tcDir = join(home, "transcription");
    mkdirSync(tcDir, { recursive: true });
    writeFileSync(
      join(tcDir, "install-python.json"),
      JSON.stringify({ provider: "parakeet-mlx", model: "m", pipTarget: "parakeet-mlx" }),
    );
    const m = readPythonManifest(pythonManifestPath({ PARACHUTE_HOME: home }));
    expect(m?.provider).toBe("parakeet-mlx");
  });
});

// --- helpers ---------------------------------------------------------------

const tmpHomes: string[] = [];
afterEach(() => {
  for (const h of tmpHomes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function mkTmpHome(): string {
  const home = join(tmpdir(), `tc-select-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  tmpHomes.push(home);
  return home;
}

function writeManifest(home: string, fields: Record<string, unknown>): void {
  const tcDir = join(home, "transcription");
  mkdirSync(tcDir, { recursive: true });
  writeFileSync(join(tcDir, "install.json"), JSON.stringify(fields));
}
