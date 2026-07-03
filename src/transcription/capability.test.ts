import { describe, test, expect } from "bun:test";
import { resolveTranscriptionCapability } from "./capability.ts";
import { ScribeHttpProvider } from "./providers/scribe-http.ts";
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
});
