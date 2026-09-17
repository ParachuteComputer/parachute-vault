import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findModel } from "./transcription/models.ts";
import { classifyAutoTranscribe, shouldAutoTranscribe, noProviderErrorFor,
  NO_PROVIDER_ERROR, warnNoTranscriptionProvider, _resetNoProviderWarnForTest } from "./auto-transcribe.ts";
import { getTranscriptionWorker, getTranscriptionWorkerProvider, setTranscriptionWorker } from "./transcription-registry.ts";

const config = (enabled?: boolean) => () => ({ port: 1940, auto_transcribe: { enabled } }) as any;
const ready = () => ({ ready: true, localProvider: "whisper-cpp" });
const absent = () => ({ ready: false, localProvider: null });

describe("automatic transcription eligibility", () => {
  for (const mime of ["audio/wav", "audio/mp4", "audio/webm", "AUDIO/WAV"]) {
    test(`ready worker accepts ${mime}`, () => {
      expect(shouldAutoTranscribe(mime, { readGlobalConfigImpl: config(), providerStateImpl: ready })).toBe(true);
    });
  }
  for (const mime of ["image/png", "video/mp4", "application/pdf", "", null as any]) {
    test(`non-audio ${mime} never probes readiness`, () => {
      expect(classifyAutoTranscribe(mime, { providerStateImpl: () => { throw Error("unexpected probe"); } }).kind).toBe("not-audio");
    });
  }
  for (const global of [undefined, true, false]) {
    for (const vault of [undefined, true, false]) {
      for (const override of [undefined, true, false]) {
        test(`precedence global=${global} vault=${vault} override=${override}`, () => {
          const enabled = override ?? vault ?? global ?? true;
          const d = classifyAutoTranscribe("audio/wav", { readGlobalConfigImpl: config(global),
            perVaultEnabled: vault, enabledOverride: override, providerStateImpl: ready });
          expect(d.kind).toBe(enabled ? "transcribe" : "disabled");
        });
      }
    }
  }
  test("disabled bypasses readiness entirely", () => {
    expect(classifyAutoTranscribe("audio/wav", { perVaultEnabled: false,
      providerStateImpl: () => { throw Error("unexpected probe"); } }).kind).toBe("disabled");
  });
  for (const local of [null, "whisper-cpp"]) {
    test(`not ready remains unavailable with installed=${local}`, () => {
      expect(classifyAutoTranscribe("audio/wav", { readGlobalConfigImpl: config(),
        providerStateImpl: () => ({ ready: false, localProvider: local }) })).toEqual({ kind: "unavailable", localProvider: local });
    });
  }
  test("unavailable is false, not an enqueue", () => {
    expect(shouldAutoTranscribe("audio/wav", { readGlobalConfigImpl: config(), providerStateImpl: absent })).toBe(false);
  });
});

test("real gate requires a matching registered worker; stale URL cannot enable a missing local worker", () => {
  const previous = { provider: process.env.TRANSCRIPTION_PROVIDER, url: process.env.SCRIBE_URL };
  const worker = getTranscriptionWorker();
  const provider = getTranscriptionWorkerProvider();
  const fake = { stop: async () => {}, tick: async () => 0, kick: async () => {} };
  try {
    process.env.TRANSCRIPTION_PROVIDER = "transcribe-cpp";
    process.env.SCRIBE_URL = "http://stale.invalid";
    setTranscriptionWorker(null);
    expect(classifyAutoTranscribe("audio/wav", { perVaultEnabled: true }).kind).toBe("unavailable");
    setTranscriptionWorker(fake, "scribe-http");
    expect(classifyAutoTranscribe("audio/wav", { perVaultEnabled: true }).kind).toBe("unavailable");
    setTranscriptionWorker(fake, "transcribe-cpp");
    expect(classifyAutoTranscribe("audio/wav", { perVaultEnabled: true }).kind).toBe("transcribe");
    process.env.TRANSCRIPTION_PROVIDER = "scribe-http";
    expect(classifyAutoTranscribe("audio/wav", { perVaultEnabled: true }).kind).toBe("unavailable");
    setTranscriptionWorker(fake, "scribe-http");
    expect(classifyAutoTranscribe("audio/wav", { perVaultEnabled: true }).kind).toBe("transcribe");
  } finally {
    setTranscriptionWorker(worker, provider);
    if (previous.provider === undefined) delete process.env.TRANSCRIPTION_PROVIDER;
    else process.env.TRANSCRIPTION_PROVIDER = previous.provider;
    if (previous.url === undefined) delete process.env.SCRIBE_URL;
    else process.env.SCRIBE_URL = previous.url;
  }
});

test("diagnostics distinguish installed from ready without reviving Scribe", () => {
  expect(noProviderErrorFor(null)).toBe(NO_PROVIDER_ERROR);
  expect(NO_PROVIDER_ERROR).toContain("transcription status");
  expect(NO_PROVIDER_ERROR).toContain("standalone Scribe service is retired");
  const message = noProviderErrorFor("whisper-cpp");
  expect(message).toContain("binary is installed");
  expect(message).toContain("not active and ready");
  expect(message).toContain("transcription status");
  expect(message).not.toContain("point SCRIBE_URL");
  expect(message).not.toContain("resolves only a scribe URL");
});

test("whisper-cpp real readiness requires model plus matching active worker, without Scribe", () => {
  const keys = ["PARACHUTE_HOME", "WHISPER_CPP_BIN_DIR", "TRANSCRIPTION_PROVIDER", "TRANSCRIPTION_MODEL", "SCRIBE_URL"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), "auto-whisper-"));
  const oldWorker = getTranscriptionWorker();
  const oldProvider = getTranscriptionWorkerProvider();
  try {
    process.env.PARACHUTE_HOME = home;
    process.env.WHISPER_CPP_BIN_DIR = join(home, "bin");
    process.env.TRANSCRIPTION_PROVIDER = "whisper-cpp";
    process.env.TRANSCRIPTION_MODEL = "whisper-base.en";
    delete process.env.SCRIBE_URL;
    mkdirSync(join(home, "bin"));
    // Snapshot checks presence only; these are never executed.
    writeFileSync(join(home, "bin", "whisper-cli"), "fixture");
    writeFileSync(join(home, "bin", "ffmpeg"), "fixture");
    const worker = { stop: async () => {}, tick: async () => 0, kick: async () => {} };
    setTranscriptionWorker(worker, "whisper-cpp");
    expect(classifyAutoTranscribe("audio/wav", { perVaultEnabled: true }).kind).toBe("unavailable");
    const models = join(home, "transcription", "models");
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, findModel("whisper-base.en")!.filename), "fixture");
    expect(classifyAutoTranscribe("audio/wav", { perVaultEnabled: true }).kind).toBe("transcribe");
    setTranscriptionWorker(null);
    expect(classifyAutoTranscribe("audio/wav", { perVaultEnabled: true }).kind).toBe("unavailable");
  } finally {
    setTranscriptionWorker(oldWorker, oldProvider);
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("missing-provider warning is throttled and resets", () => {
  const previous = console.warn;
  const messages: unknown[] = [];
  console.warn = (...args) => { messages.push(args); };
  try {
    _resetNoProviderWarnForTest();
    warnNoTranscriptionProvider(() => 60_000);
    warnNoTranscriptionProvider(() => 60_001);
    expect(messages).toHaveLength(1);
    warnNoTranscriptionProvider(() => 120_000);
    expect(messages).toHaveLength(2);
    _resetNoProviderWarnForTest();
    warnNoTranscriptionProvider(() => 120_001);
    expect(messages).toHaveLength(3);
  } finally { console.warn = previous; _resetNoProviderWarnForTest(); }
});
