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

  test("skips when enabled is unset (no auto_transcribe block in config)", () => {
    expect(shouldAutoTranscribe("audio/wav", {
      readGlobalConfigImpl: readGlobalConfig(undefined),
      getCachedScribeUrlImpl: scribePresent,
    })).toBe(false);
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
});
