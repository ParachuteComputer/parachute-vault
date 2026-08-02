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
  NO_PROVIDER_ERROR,
  noProviderErrorFor,
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

/**
 * The `unavailable` error must be TRUE, not merely actionable.
 *
 * Found live: a box with `TRANSCRIPTION_PROVIDER=whisper-cpp`, `parakeet-cli`
 * on PATH, the model downloaded, and `[transcribe] worker started →
 * whisper-cpp` in the same boot log was writing "no transcription provider
 * configured — set TRANSCRIPTION_PROVIDER to a local provider" onto its
 * attachments. Every clause of that is false there, and the fix it prescribes
 * is a 400 MB re-download that changes nothing.
 *
 * The decision is deliberately unchanged — `unavailable` stays `unavailable`,
 * because this path resolves a scribe URL and nothing else. Only the sentence
 * moves.
 */
describe("the unavailable message tells the truth about the local install", () => {
  const audio = "audio/webm";
  const noScribe = () => undefined;

  test("nothing runnable locally → the original message, unchanged", () => {
    // The fresh-install case the old string was written for, and it is still
    // exactly right there. Byte-identical so a fresh install sees no churn.
    const d = classifyAutoTranscribe(audio, {
      perVaultEnabled: true,
      getCachedScribeUrlImpl: noScribe,
      localProviderImpl: () => null,
    });
    expect(d.kind).toBe("unavailable");
    expect(noProviderErrorFor(d.kind === "unavailable" ? d.localProvider : null)).toBe(
      NO_PROVIDER_ERROR,
    );
  });

  test("a runnable local provider → a message that does not contradict the box", () => {
    const d = classifyAutoTranscribe(audio, {
      perVaultEnabled: true,
      getCachedScribeUrlImpl: noScribe,
      localProviderImpl: () => "whisper-cpp",
    });
    expect(d.kind).toBe("unavailable");
    const msg = noProviderErrorFor(d.kind === "unavailable" ? d.localProvider : null);

    // The three false claims the old string made on such a box.
    expect(msg).not.toContain("no transcription provider configured");
    expect(msg).not.toContain("set TRANSCRIPTION_PROVIDER to a local provider");
    expect(msg).not.toContain("transcription install");
    // And what it must say instead: the local install is fine, this path just
    // doesn't read it, and don't go reinstalling anything.
    expect(msg).toContain("whisper-cpp");
    expect(msg).toContain("SCRIBE_URL");
    expect(msg).toMatch(/does not consult it/);
    expect(msg).toMatch(/Reinstalling whisper-cpp will not change this/);
  });

  test("the decision itself is untouched — this diff moves no behaviour", () => {
    // Same inputs, both local-provider states: still `unavailable` either way.
    // If this ever diverges, the change stopped being diagnostic-only and
    // started deciding what gets transcribed.
    for (const local of [null, "whisper-cpp"]) {
      expect(
        classifyAutoTranscribe(audio, {
          perVaultEnabled: true,
          getCachedScribeUrlImpl: noScribe,
          localProviderImpl: () => local,
        }).kind,
      ).toBe("unavailable");
    }
    // And a reachable scribe still wins outright, local install or not.
    expect(
      classifyAutoTranscribe(audio, {
        perVaultEnabled: true,
        getCachedScribeUrlImpl: () => "http://127.0.0.1:1943",
        localProviderImpl: () => "whisper-cpp",
      }).kind,
    ).toBe("transcribe");
  });

  test("an installed provider with ffmpeg missing STILL gets the honest message", () => {
    // The trap that cost a rewrite: `snap.ready` also demands ffmpeg, so
    // gating on readiness would have left the very box that reported this bug
    // on the old, wrong string — it has the provider installed and no ffmpeg.
    // "no transcription provider configured" is false there regardless of
    // ffmpeg, so the discriminator is INSTALLED, not READY.
    const msg = noProviderErrorFor("whisper-cpp");
    expect(msg).not.toBe(NO_PROVIDER_ERROR);
    // And it must not over-claim in the other direction: with ffmpeg missing
    // the install is present but not necessarily working, so the message says
    // requests are ROUTED to it and points at status for the real state.
    expect(msg).toMatch(/routed to it/);
    expect(msg).toContain("transcription status");
    expect(msg).not.toMatch(/is fine/);
  });

  test("the provider NAME is not the discriminator — the fresh-install trap", () => {
    // `resolveTranscriptionProviderName` returns "whisper-cpp" on a box where
    // nothing is set up at all, because that is the default when no scribe URL
    // resolves. Keying off the name would tell a fresh-install operator their
    // whisper-cpp install is fine when they have never installed one. The
    // discriminator is RUNNABILITY, and null must produce the old message.
    expect(noProviderErrorFor(null)).toBe(NO_PROVIDER_ERROR);
    expect(noProviderErrorFor("whisper-cpp")).not.toBe(NO_PROVIDER_ERROR);
  });
});
