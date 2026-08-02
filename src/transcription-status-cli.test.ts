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

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
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

/**
 * The command must report the CONFIG FILE, not its own process environment.
 *
 * Found live (UniOps, 2026-08-02): a box whose `.env` said `whisper-cpp` was
 * told `scribe-http` — the retired service — while `status` was the very tool
 * being used to diagnose why transcription was dead. Same class as the bug at
 * the top of this file: the daemon loads `~/.parachute/vault/.env` at boot
 * (`server.ts` → `loadEnvFile()`), a one-shot CLI process never did, and every
 * resolver underneath reads `process.env`.
 *
 * These spawn the real CLI because that is where the defect lived — the
 * resolvers were always correct when handed the right env; nothing but a
 * process boundary reproduces it. No in-test `Bun.serve` is involved, so
 * `Bun.spawnSync` is fine here (CLAUDE.md, "Subprocess tests + Bun.serve").
 *
 * Each case sets a value that DIFFERS from the fallback. A test using a value
 * the fallback happens to produce would pass without the fix — which is
 * precisely how this shipped: on an unconfigured box the default agrees with
 * the file, so the command looked right until someone changed something.
 */
describe("`transcription status` reads ~/.parachute/vault/.env", () => {
  const CLI = resolve(import.meta.dir, "cli.ts");
  const homes: string[] = [];

  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  /** A temp PARACHUTE_HOME whose `vault/.env` holds exactly these lines. */
  function homeWithEnv(lines: string[]): string {
    const home = mkdtempSync(join(tmpdir(), "pv-transcription-env-"));
    homes.push(home);
    mkdirSync(join(home, "vault"), { recursive: true });
    writeFileSync(join(home, "vault", ".env"), `${lines.join("\n")}\n`);
    return home;
  }

  /** Run `transcription status` with the file's values ONLY on disk. */
  function status(home: string): string {
    // Strip the inherited values so the child cannot pass by reading the
    // parent's environment — the file is the only source in play.
    const env: Record<string, string | undefined> = { ...process.env, PARACHUTE_HOME: home };
    for (const k of [
      "TRANSCRIPTION_PROVIDER",
      "TRANSCRIPTION_MODEL",
      "WHISPER_CPP_BIN_DIR",
      "SCRIBE_URL",
      "PARACHUTE_HUB_ORIGIN",
    ]) {
      delete env[k];
    }
    const proc = Bun.spawnSync({
      cmd: ["bun", CLI, "transcription", "status"],
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    return new TextDecoder().decode(proc.stdout);
  }

  test("the provider comes from the file, not the fallback default", () => {
    // `scribe-http` is never the fallback on a box with no scribe in
    // services.json — the default there is whisper-cpp. So this asserts the
    // file was read rather than that two paths coincided.
    const out = status(homeWithEnv(["TRANSCRIPTION_PROVIDER=scribe-http", "SCRIBE_URL=http://127.0.0.1:1943"]));
    expect(out).toContain("scribe-http");
    expect(out).not.toContain("(whisper-cpp)");
  });

  test("the model comes from the file", () => {
    const out = status(homeWithEnv(["TRANSCRIPTION_PROVIDER=whisper-cpp", "TRANSCRIPTION_MODEL=whisper-tiny.en"]));
    expect(out).toContain("Whisper Tiny (English)");
    expect(out).not.toContain("Parakeet TDT 0.6b v3");
  });

  test("a binary-dir override in the file is honored — the false 'not found'", () => {
    // The sharpest symptom: an installed, working binary reported missing
    // because the `.env` override naming its directory never reached the
    // resolver. This is the `runnable: no` line UniOps flagged as suspect.
    const home = homeWithEnv([]);
    const bin = join(home, "fakebin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, "parakeet-cli");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    chmodSync(exe, 0o755);
    writeFileSync(
      join(home, "vault", ".env"),
      `TRANSCRIPTION_PROVIDER=whisper-cpp\nWHISPER_CPP_BIN_DIR=${bin}\n`,
    );
    const out = status(home);
    expect(out).toContain(exe);
    expect(out).not.toContain("parakeet-cli   not found");
  });
});
