/**
 * Auto-transcribe gating decisions (vault#353).
 *
 * Three independent guards: mime-type prefix, enabled toggle, scribe URL
 * present. Pure function — exercise the truth table.
 */

import { describe, test, expect } from "bun:test";
import {
  _resetNoProviderWarnForTest,
  classifyAutoTranscribe,
  shouldAutoTranscribe,
  warnNoTranscriptionProvider,
} from "./auto-transcribe.ts";

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

// ---------------------------------------------------------------------------
// vault#643 — "disabled" and "unavailable" are not the same answer.
//
// `shouldAutoTranscribe` collapsed both into `false`, so a box with
// auto-transcribe ON and no reachable provider accepted audio, transcribed
// nothing, wrote no marker, and logged nothing. The attachment was
// indistinguishable from a plain upload.
//
// That is the DEFAULT state of a fresh install: the provider resolves to
// `scribe-http`, nothing sets SCRIBE_URL, and voice memos silently never
// transcribe. The hosted door already marks a terminal state rather than
// skipping quietly (workers/vault/src/vault-do.ts — "voice not enabled for
// this plan" / "monthly voice limit reached"); this is the self-host twin.
// ---------------------------------------------------------------------------
describe("classifyAutoTranscribe (vault#643)", () => {
  const audio = "audio/webm";
  const withProvider = () => "http://127.0.0.1:1943";
  const noProvider = () => undefined;

  test("non-audio → not-audio, whatever else is true", () => {
    expect(
      classifyAutoTranscribe("image/png", { getCachedScribeUrlImpl: withProvider }).kind,
    ).toBe("not-audio");
  });

  test("operator turned it off → disabled (silence is CORRECT here)", () => {
    expect(
      classifyAutoTranscribe(audio, {
        perVaultEnabled: false,
        getCachedScribeUrlImpl: withProvider,
      }).kind,
    ).toBe("disabled");
  });

  test("enabled + no provider → unavailable, NOT disabled — the whole point", () => {
    expect(
      classifyAutoTranscribe(audio, {
        perVaultEnabled: true,
        getCachedScribeUrlImpl: noProvider,
      }).kind,
    ).toBe("unavailable");
  });

  test("a blank provider URL is unavailable, not a provider", () => {
    expect(
      classifyAutoTranscribe(audio, {
        perVaultEnabled: true,
        getCachedScribeUrlImpl: () => "   ",
      }).kind,
    ).toBe("unavailable");
  });

  test("the default (no toggle set) with no provider is unavailable — the fresh-install case", () => {
    expect(
      classifyAutoTranscribe(audio, {
        readGlobalConfigImpl: (() => ({})) as never,
        getCachedScribeUrlImpl: noProvider,
      }).kind,
    ).toBe("unavailable");
  });

  test("enabled + provider → transcribe", () => {
    expect(
      classifyAutoTranscribe(audio, {
        perVaultEnabled: true,
        getCachedScribeUrlImpl: withProvider,
      }).kind,
    ).toBe("transcribe");
  });

  test("shouldAutoTranscribe stays a faithful boolean view of the classifier", () => {
    for (const opts of [
      { perVaultEnabled: false, getCachedScribeUrlImpl: withProvider },
      { perVaultEnabled: true, getCachedScribeUrlImpl: noProvider },
      { perVaultEnabled: true, getCachedScribeUrlImpl: withProvider },
    ]) {
      expect(shouldAutoTranscribe(audio, opts)).toBe(
        classifyAutoTranscribe(audio, opts).kind === "transcribe",
      );
    }
  });
});

describe("warnNoTranscriptionProvider throttle (vault#643)", () => {
  test("warns once per window — a bulk import gets one line, not a hundred", () => {
    _resetNoProviderWarnForTest();
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => seen.push(String(args[0]));
    try {
      let now = 1_000_000;
      const clock = () => now;
      for (let i = 0; i < 50; i++) warnNoTranscriptionProvider(clock);
      expect(seen.length).toBe(1);
      expect(seen[0]).toMatch(/no transcription provider configured/i);
      // Past the window → one more.
      now += 61_000;
      warnNoTranscriptionProvider(clock);
      expect(seen.length).toBe(2);
    } finally {
      console.warn = orig;
      _resetNoProviderWarnForTest();
    }
  });
});
