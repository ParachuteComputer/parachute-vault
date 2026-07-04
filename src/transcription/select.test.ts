import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  resolveTranscriptionProviderName,
  resolveTranscribeCppPaths,
  transcribeCppInstalled,
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
  test("unset → scribe-http (behavior-preserving default)", () => {
    expect(resolveTranscriptionProviderName({}, silent)).toBe("scribe-http");
  });
  test("blank → scribe-http", () => {
    expect(resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "  " }, silent)).toBe("scribe-http");
  });
  test("explicit transcribe-cpp", () => {
    expect(resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "transcribe-cpp" }, silent)).toBe(
      "transcribe-cpp",
    );
  });
  test("explicit parakeet-mlx / onnx-asr (scribe-fold Phase 2b)", () => {
    expect(resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "parakeet-mlx" }, silent)).toBe(
      "parakeet-mlx",
    );
    expect(resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "onnx-asr" }, silent)).toBe(
      "onnx-asr",
    );
  });
  test("explicit scribe-http", () => {
    expect(resolveTranscriptionProviderName({ TRANSCRIPTION_PROVIDER: "scribe-http" }, silent)).toBe(
      "scribe-http",
    );
  });
  test("unknown value → warns + falls back to scribe-http", () => {
    let warned = false;
    const name = resolveTranscriptionProviderName(
      { TRANSCRIPTION_PROVIDER: "whisper-magic" },
      { warn: () => (warned = true) },
    );
    expect(name).toBe("scribe-http");
    expect(warned).toBe(true);
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
