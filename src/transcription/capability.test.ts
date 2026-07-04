import { describe, test, expect, afterEach } from "bun:test";
import { resolveTranscriptionCapability, defaultTranscriptionProvider } from "./capability.ts";
import { ScribeHttpProvider } from "./providers/scribe-http.ts";
import { TranscribeCppProvider } from "./providers/transcribe-cpp.ts";
import type { TranscriptionProvider } from "../../core/src/transcription/provider.ts";

/**
 * Capability-flag tests (scribe-fold Phase 1). The vault landing surfaces
 * `transcription: { enabled, provider? }`; `enabled` iff a provider is
 * configured AND available. Notes gates its mic on this.
 */

/** A minimal fake provider so tests don't depend on live scribe discovery. */
function fakeProvider(available: boolean, name = "fake"): TranscriptionProvider {
  return {
    name,
    available: async () => (available ? { ok: true } : { ok: false, reason: "off" }),
    transcribe: async () => ({ text: "" }),
  };
}

describe("resolveTranscriptionCapability", () => {
  test("enabled:true + provider name when the provider is available", async () => {
    const cap = await resolveTranscriptionCapability(fakeProvider(true, "scribe-http"));
    expect(cap).toEqual({ enabled: true, provider: "scribe-http" });
  });

  test("enabled:false + no provider name when the provider is unavailable", async () => {
    const cap = await resolveTranscriptionCapability(fakeProvider(false));
    expect(cap).toEqual({ enabled: false });
    expect(cap.provider).toBeUndefined();
  });

  test("no provider configured (scribe-http with no URL) resolves to disabled, no throw", async () => {
    // The "no provider configured" path: a scribe-http provider whose URL is
    // undefined reports unavailable rather than throwing, so the landing never
    // crashes when scribe is absent.
    const cap = await resolveTranscriptionCapability(new ScribeHttpProvider({ url: undefined }));
    expect(cap.enabled).toBe(false);
    expect(cap.provider).toBeUndefined();
  });

  test("a configured scribe-http provider resolves to enabled: scribe-http", async () => {
    const cap = await resolveTranscriptionCapability(new ScribeHttpProvider({ url: "http://scribe.test" }));
    expect(cap).toEqual({ enabled: true, provider: "scribe-http" });
  });

  test("never omits minutes_remaining as an unmetered self-host concern", async () => {
    const cap = await resolveTranscriptionCapability(fakeProvider(true));
    expect("minutes_remaining" in cap).toBe(false);
  });

  test("a transcribe-cpp provider (installed) resolves to enabled: transcribe-cpp", async () => {
    // existsImpl stubs the binary + model as present so available() is ok
    // without touching disk.
    const p = new TranscribeCppProvider({
      binPath: "/tc/transcribe-cli",
      modelPath: "/tc/model.gguf",
      existsImpl: () => true,
    });
    const cap = await resolveTranscriptionCapability(p);
    expect(cap).toEqual({ enabled: true, provider: "transcribe-cpp" });
  });

  test("a transcribe-cpp provider (not installed) resolves to disabled", async () => {
    const p = new TranscribeCppProvider({ binPath: "/tc/transcribe-cli", modelPath: "/tc/model.gguf", existsImpl: () => false });
    const cap = await resolveTranscriptionCapability(p);
    expect(cap.enabled).toBe(false);
    expect(cap.provider).toBeUndefined();
  });
});

/**
 * `defaultTranscriptionProvider` honors `TRANSCRIPTION_PROVIDER` so the
 * capability flag reflects whichever provider is configured (scribe-fold 2a).
 */
describe("defaultTranscriptionProvider — provider selection", () => {
  const saved = process.env.TRANSCRIPTION_PROVIDER;
  afterEach(() => {
    if (saved === undefined) delete process.env.TRANSCRIPTION_PROVIDER;
    else process.env.TRANSCRIPTION_PROVIDER = saved;
  });

  test("default (unset) → the scribe-http provider", () => {
    delete process.env.TRANSCRIPTION_PROVIDER;
    expect(defaultTranscriptionProvider().name).toBe("scribe-http");
  });

  test("TRANSCRIPTION_PROVIDER=transcribe-cpp → the transcribe-cpp provider", () => {
    process.env.TRANSCRIPTION_PROVIDER = "transcribe-cpp";
    expect(defaultTranscriptionProvider().name).toBe("transcribe-cpp");
  });

  test("TRANSCRIPTION_PROVIDER=parakeet-mlx → the parakeet-mlx provider (2b)", () => {
    process.env.TRANSCRIPTION_PROVIDER = "parakeet-mlx";
    expect(defaultTranscriptionProvider().name).toBe("parakeet-mlx");
  });

  test("TRANSCRIPTION_PROVIDER=onnx-asr → the onnx-asr provider (2b)", () => {
    process.env.TRANSCRIPTION_PROVIDER = "onnx-asr";
    expect(defaultTranscriptionProvider().name).toBe("onnx-asr");
  });

  test("an unconfigured python provider resolves to disabled (no throw)", async () => {
    // No venv/PATH binary in a fresh env → available() is ok:false and the
    // landing capability is {enabled:false} rather than a crash.
    process.env.TRANSCRIPTION_PROVIDER = "parakeet-mlx";
    const prevBin = process.env.PARAKEET_MLX_BIN;
    process.env.PARAKEET_MLX_BIN = "/definitely/not/a/real/parakeet-mlx";
    try {
      const cap = await resolveTranscriptionCapability(defaultTranscriptionProvider());
      expect(cap.enabled).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.PARAKEET_MLX_BIN;
      else process.env.PARAKEET_MLX_BIN = prevBin;
    }
  });
});
