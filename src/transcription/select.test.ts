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
