/**
 * Auto-transcribe gating decisions (vault#353).
 *
 * Three independent guards: mime-type prefix, enabled toggle, scribe URL
 * present. Pure function — exercise the truth table.
 */

import { describe, test, expect } from "bun:test";
import { shouldAutoTranscribe } from "./auto-transcribe.ts";

function readGlobalConfig(enabled: boolean | undefined) {
  return () => ({
    port: 1940,
    ...(enabled !== undefined ? { auto_transcribe: { enabled } } : {}),
  }) as any;
}

describe("shouldAutoTranscribe", () => {
  const scribePresent = () => "http://127.0.0.1:1943";
  const scribeAbsent = () => undefined;

  test("triggers on audio/* mime-type when enabled + scribe reachable", () => {
    expect(shouldAutoTranscribe("audio/wav", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(true);
  });

  test("triggers on audio/mp4 (m4a)", () => {
    expect(shouldAutoTranscribe("audio/mp4", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(true);
  });

  test("triggers on audio/webm", () => {
    expect(shouldAutoTranscribe("audio/webm", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(true);
  });

  test("triggers case-insensitively (AUDIO/WAV)", () => {
    expect(shouldAutoTranscribe("AUDIO/WAV", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(true);
  });

  test("skips non-audio mime-types (image/png, application/pdf, video/mp4)", () => {
    expect(shouldAutoTranscribe("image/png", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(false);
    expect(shouldAutoTranscribe("application/pdf", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(false);
    expect(shouldAutoTranscribe("video/mp4", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(false);
  });

  test("skips when enabled is false (default off)", () => {
    expect(shouldAutoTranscribe("audio/wav", {
      readGlobalConfigImpl: readGlobalConfig(false),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(false);
  });

  test("fires when enabled is unset — unset config means ON", () => {
    // Default behavior (no `auto_transcribe` block in config) is opt-out:
    // once an operator has scribe reachable, audio attachments transcribe
    // automatically. Operators wanting it OFF set
    // `auto_transcribe.enabled: false` explicitly. Previously default-off;
    // flipped to default-on so installing scribe is the only opt-in signal.
    expect(shouldAutoTranscribe("audio/wav", {
      readGlobalConfigImpl: readGlobalConfig(undefined),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(true);
  });

  test("skips when scribe URL is undefined (no services.json entry, no env)", () => {
    expect(shouldAutoTranscribe("audio/wav", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribeAbsent,
    })).toBe(false);
  });

  test("skips when scribe URL is empty string", () => {
    expect(shouldAutoTranscribe("audio/wav", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: () => "",
    })).toBe(false);
  });

  test("skips on garbage mime-type input", () => {
    expect(shouldAutoTranscribe("", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(false);
    expect(shouldAutoTranscribe("not-a-mime", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(false);
  });

  test("respects enabledOverride when present", () => {
    expect(shouldAutoTranscribe("audio/wav", {
      readGlobalConfigImpl: readGlobalConfig(false),
      getCachedScribeUrlImpl: scribePresent,
      enabledOverride: true,
    })).toBe(true);
    expect(shouldAutoTranscribe("audio/wav", {
      readGlobalConfigImpl: readGlobalConfig(true),
      getCachedScribeUrlImpl: scribePresent,
      enabledOverride: false,
    })).toBe(false);
  });

  describe("per-vault precedence (per-vault → global → true)", () => {
    test("per-vault true wins even when global is false", () => {
      expect(shouldAutoTranscribe("audio/wav", {
        readGlobalConfigImpl: readGlobalConfig(false),
        getCachedScribeUrlImpl: scribePresent,
        perVaultEnabled: true,
      })).toBe(true);
    });

    test("per-vault false wins even when global is true", () => {
      // The whole point: linking scribe to vault X (perVault true) elsewhere
      // must not force-on a vault that set its own false.
      expect(shouldAutoTranscribe("audio/wav", {
        readGlobalConfigImpl: readGlobalConfig(true),
        getCachedScribeUrlImpl: scribePresent,
        perVaultEnabled: false,
      })).toBe(false);
    });

    test("per-vault unset falls back to global", () => {
      expect(shouldAutoTranscribe("audio/wav", {
        readGlobalConfigImpl: readGlobalConfig(true),
        getCachedScribeUrlImpl: scribePresent,
        perVaultEnabled: undefined,
      })).toBe(true);
      expect(shouldAutoTranscribe("audio/wav", {
        readGlobalConfigImpl: readGlobalConfig(false),
        getCachedScribeUrlImpl: scribePresent,
        perVaultEnabled: undefined,
      })).toBe(false);
    });

    test("both per-vault and global unset falls back to true (no regression)", () => {
      expect(shouldAutoTranscribe("audio/wav", {
        readGlobalConfigImpl: readGlobalConfig(undefined),
        getCachedScribeUrlImpl: scribePresent,
        perVaultEnabled: undefined,
      })).toBe(true);
    });

    test("enabledOverride still hard-overrides the per-vault value", () => {
      // The explicit caller-opt-in path beats everything.
      expect(shouldAutoTranscribe("audio/wav", {
        readGlobalConfigImpl: readGlobalConfig(true),
        getCachedScribeUrlImpl: scribePresent,
        perVaultEnabled: false,
        enabledOverride: true,
      })).toBe(true);
    });
  });
});
