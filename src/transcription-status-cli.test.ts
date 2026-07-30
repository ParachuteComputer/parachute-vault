/**
 * `transcription status` — that it reports the ACTIVE provider honestly.
 *
 * Found live: a box with a working whisper-cpp install (binary, model, and
 * ffmpeg all present, transcribing fine) was told
 *
 *   ⚠ provider is whisper-cpp but no runnable whisper-cpp install was found —
 *     transcription is offline until one is available
 *
 * The command predates whisper-cpp (vault#635) and never grew a branch for it,
 * so the `activeRunnable` disjunction simply omitted it and could only ever
 * evaluate false. A status command that reports working software as broken is
 * worse than no status command — it sends someone to re-install a 400 MB model
 * to fix nothing.
 *
 * The fix shares `buildTranscriptionSnapshot` with the admin SPA's page, so
 * these tests pin the property that actually prevents recurrence: the CLI and
 * the UI answer "is transcription working" from ONE implementation.
 */

import { describe, expect, test } from "bun:test";
import { buildTranscriptionSnapshot } from "./transcription-routes.ts";
import { TRANSCRIPTION_PROVIDERS } from "./transcription/select.ts";

describe("every provider the CLI can resolve is one status knows about", () => {
  test("the provider list has no member without a readiness story", () => {
    // The regression in one assertion: whisper-cpp was resolvable as the active
    // provider while nothing computed its readiness. Any future provider added
    // to TRANSCRIPTION_PROVIDERS has to be handled too.
    const handled = new Set([
      "scribe-http",
      "whisper-cpp",
      "transcribe-cpp",
      "parakeet-mlx",
      "onnx-asr",
    ]);
    for (const p of TRANSCRIPTION_PROVIDERS) {
      expect(handled.has(p)).toBe(true);
    }
  });
});

describe("the snapshot is the single source of truth", () => {
  test("readiness comes back as a decidable boolean with a reason when false", () => {
    const snap = buildTranscriptionSnapshot({
      active: false,
      resolveBinaryImpl: () => undefined,
      resolveFfmpegImpl: () => undefined,
      existsImpl: () => false,
    });
    expect(typeof snap.ready).toBe("boolean");
    expect(snap.ready).toBe(false);
    // A false readiness must always carry something actionable, or the CLI has
    // nothing honest to print.
    expect(snap.reason).toBeTruthy();
    expect(snap.fix_command).toBeTruthy();
  });

  test("a fully-present whisper-cpp install reports ready, with paths to print", () => {
    const prev = process.env.TRANSCRIPTION_PROVIDER;
    process.env.TRANSCRIPTION_PROVIDER = "whisper-cpp";
    try {
      const snap = buildTranscriptionSnapshot({
        active: true,
        resolveBinaryImpl: () => "/opt/homebrew/bin/parakeet-cli",
        resolveFfmpegImpl: () => "/opt/homebrew/bin/ffmpeg",
        existsImpl: () => true,
      });
      expect(snap.provider).toBe("whisper-cpp");
      expect(snap.ready).toBe(true);
      expect(snap.reason).toBeNull();
      // These are exactly what the CLI prints — a ready snapshot must carry
      // them or the output degrades to "yes" with no evidence.
      expect(snap.binary.path).toBe("/opt/homebrew/bin/parakeet-cli");
      expect(snap.ffmpeg.path).toBe("/opt/homebrew/bin/ffmpeg");
      expect(snap.model?.installed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TRANSCRIPTION_PROVIDER;
      else process.env.TRANSCRIPTION_PROVIDER = prev;
    }
  });

  test("a missing binary still reports WHERE it looked — the launchd trap", () => {
    // What makes "NOT FOUND" actionable on macOS, where the binary is often
    // installed but invisible to a launchd-supervised vault.
    const snap = buildTranscriptionSnapshot({
      active: false,
      resolveBinaryImpl: () => undefined,
      resolveFfmpegImpl: () => "/usr/bin/ffmpeg",
      existsImpl: () => true,
    });
    expect(snap.binary.path).toBeNull();
    expect(snap.binary.searched.length).toBeGreaterThan(0);
  });
});

describe("what `transcription status` must not claim", () => {
  test("readiness never depends on the in-process worker registry", () => {
    // A one-shot CLI process has no transcription worker — `active` is
    // structurally false there. Keying the headline off it would print
    // "ready, but the worker isn't running yet" on every healthy box, which is
    // the same class of lie the command was just fixed for.
    const installed = {
      resolveBinaryImpl: () => "/opt/homebrew/bin/parakeet-cli",
      resolveFfmpegImpl: () => "/opt/homebrew/bin/ffmpeg",
      existsImpl: () => true,
    };
    const prev = process.env.TRANSCRIPTION_PROVIDER;
    process.env.TRANSCRIPTION_PROVIDER = "whisper-cpp";
    try {
      // `ready` is identical whether or not a worker happens to be live; only
      // `active` differs. The CLI reports the former.
      const withWorker = buildTranscriptionSnapshot({ ...installed, active: true });
      const without = buildTranscriptionSnapshot({ ...installed, active: false });
      expect(withWorker.ready).toBe(true);
      expect(without.ready).toBe(true);
      expect(without.active).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TRANSCRIPTION_PROVIDER;
      else process.env.TRANSCRIPTION_PROVIDER = prev;
    }
  });
});
