/**
 * Tests for the TTS provider interface and the #reader → audio hook.
 *
 * Uses a mock TtsProvider — never hits ElevenLabs. The goal here is to
 * prove the wiring (hook predicate, two-phase marker, attachment write,
 * failure path), not the cloud API.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SqliteStore } from "../core/src/store.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import {
  getTtsProvider,
  registerTtsHook,
  type TtsProvider,
  type TtsSynthesisResult,
} from "./tts-provider.ts";

const silentLogger = { error: () => {}, info: () => {} };

/** Wait for queued dispatches + in-flight handlers to settle. */
async function settle(hooks: HookRegistry): Promise<void> {
  // Let queueMicrotask-scheduled dispatches enqueue their tasks.
  await Promise.resolve();
  await Promise.resolve();
  await hooks.drain();
  // The handler itself re-enters updateNote (phase 1 + phase 2), which
  // re-dispatches more microtasks. Drain again to catch those.
  await Promise.resolve();
  await Promise.resolve();
  await hooks.drain();
}

/** Mock provider that always succeeds with a deterministic payload. */
function mockProvider(capturedCalls: Array<{ text: string; voice?: string }>): TtsProvider {
  return {
    name: "mock",
    async synthesize(text, opts): Promise<TtsSynthesisResult> {
      capturedCalls.push({ text, voice: opts?.voice });
      return {
        audio: Buffer.from("fake-audio-bytes"),
        mime: "audio/mpeg",
      };
    },
  };
}

let db: Database;
let hooks: HookRegistry;
let store: SqliteStore;
let tmpDir: string;
let assetsBase: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `tts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  assetsBase = join(tmpDir, "assets");
  mkdirSync(assetsBase, { recursive: true });

  db = new Database(join(tmpDir, "test.db"));
  hooks = new HookRegistry({ concurrency: 4, logger: silentLogger });
  store = new SqliteStore(db, { hooks });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getTtsProvider factory", () => {
  test("returns null when TTS_PROVIDER is unset", () => {
    expect(getTtsProvider({})).toBeNull();
  });

  test("returns null when TTS_PROVIDER=none", () => {
    expect(getTtsProvider({ TTS_PROVIDER: "none" })).toBeNull();
  });

  test("returns null when elevenlabs selected without API key", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(getTtsProvider({ TTS_PROVIDER: "elevenlabs" })).toBeNull();
    } finally {
      console.warn = warn;
    }
  });

  test("returns elevenlabs provider when configured", () => {
    const provider = getTtsProvider({
      TTS_PROVIDER: "elevenlabs",
      ELEVENLABS_API_KEY: "sk-test",
    });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("elevenlabs");
  });

  test("returns null for unknown providers", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(getTtsProvider({ TTS_PROVIDER: "bogus" })).toBeNull();
    } finally {
      console.warn = warn;
    }
  });
});

describe("registerTtsHook — #reader → audio", () => {
  test("fires for a #reader note, attaches audio, sets marker", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      provider: mockProvider(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("Hello reader", { tags: ["reader"] });
    await settle(hooks);

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ text: "Hello reader", voice: "test-voice" });

    const fresh = store.getNote(note.id);
    expect(fresh).not.toBeNull();
    const meta = fresh!.metadata as Record<string, unknown>;
    expect(meta.audio_rendered_at).toBeTruthy();
    expect(meta.audio_voice).toBe("test-voice");
    expect(meta.audio_provider).toBe("mock");
    expect(meta.audio_pending_at).toBeUndefined();

    const attachments = store.getAttachments(note.id);
    expect(attachments.length).toBe(1);
    expect(attachments[0].mimeType).toBe("audio/mpeg");
    expect(attachments[0].path.startsWith("tts/")).toBe(true);
    expect(attachments[0].path.endsWith(".mp3")).toBe(true);

    const absPath = join(assetsBase, attachments[0].path);
    expect(existsSync(absPath)).toBe(true);
    expect(readFileSync(absPath).toString()).toBe("fake-audio-bytes");
  });

  test("does not fire for notes without the #reader tag", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      provider: mockProvider(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("No tag", { tags: ["other"] });
    await settle(hooks);

    expect(calls.length).toBe(0);
    expect(store.getAttachments(note.id).length).toBe(0);
  });

  test("does not re-fire when audio_rendered_at is already set", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      provider: mockProvider(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("Already rendered", {
      tags: ["reader"],
      metadata: { audio_rendered_at: "2025-01-01T00:00:00Z" },
    });
    await settle(hooks);
    expect(calls.length).toBe(0);

    // Mutating the note should still not re-fire.
    store.updateNote(note.id, { content: "edited" });
    await settle(hooks);
    expect(calls.length).toBe(0);
    expect(store.getAttachments(note.id).length).toBe(0);
  });

  test("clearing audio_rendered_at re-runs synthesis on next update", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      provider: mockProvider(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("First pass", { tags: ["reader"] });
    await settle(hooks);
    expect(calls.length).toBe(1);
    expect(store.getAttachments(note.id).length).toBe(1);

    // Clear the marker and mutate — second synthesis should fire.
    const meta = store.getNote(note.id)!.metadata as Record<string, unknown>;
    const { audio_rendered_at: _r, audio_voice: _v, audio_provider: _p, ...rest } = meta;
    store.updateNote(note.id, { metadata: rest, content: "Second pass" });
    await settle(hooks);

    expect(calls.length).toBe(2);
    expect(calls[1].text).toBe("Second pass");
    expect(store.getAttachments(note.id).length).toBe(2);

    const fresh = store.getNote(note.id)!;
    const freshMeta = fresh.metadata as Record<string, unknown>;
    expect(freshMeta.audio_rendered_at).toBeTruthy();
    expect(freshMeta.audio_pending_at).toBeUndefined();
  });

  test("provider failure leaves note stuck in audio_pending_at (no retry loop)", async () => {
    let callCount = 0;
    const provider: TtsProvider = {
      name: "mock-fail",
      async synthesize(): Promise<TtsSynthesisResult> {
        callCount++;
        throw new Error("boom");
      },
    };
    registerTtsHook(hooks, {
      provider,
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("Will fail", { tags: ["reader"] });
    await settle(hooks);

    // Provider called exactly once — the pending marker prevents retry.
    expect(callCount).toBe(1);

    const fresh = store.getNote(note.id)!;
    expect(fresh.content).toBe("Will fail");
    expect(fresh.tags).toContain("reader");

    const meta = fresh.metadata as Record<string, unknown>;
    expect(meta.audio_rendered_at).toBeUndefined();
    // Pending marker stays set — this is the "stuck" state that requires
    // manual recovery. Deliberate, not a bug. See tts-provider.ts header.
    expect(meta.audio_pending_at).toBeTruthy();

    expect(store.getAttachments(note.id).length).toBe(0);

    // A subsequent mutation should NOT re-fire the hook (pending still set).
    store.updateNote(note.id, { content: "still failing" });
    await settle(hooks);
    expect(callCount).toBe(1);

    // Manual recovery: clearing pending and mutating DOES re-fire.
    const meta2 = store.getNote(note.id)!.metadata as Record<string, unknown>;
    const { audio_pending_at: _drop, ...rest } = meta2;
    store.updateNote(note.id, { metadata: rest });
    await settle(hooks);
    expect(callCount).toBe(2);
  });

  test("skips notes with empty content", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      provider: mockProvider(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("", { tags: ["reader"] });
    await settle(hooks);
    expect(calls.length).toBe(0);
    expect(store.getAttachments(note.id).length).toBe(0);
  });

  test("two synchronous mutations in the same tick do not double-synthesize", async () => {
    // This is the harder race: both mutations land back-to-back without an
    // await between them, so both `dispatch()` calls snapshot matches
    // before either handler's phase-1 write has had a chance to run. Only
    // the handler-side re-check (not the dispatch-time predicate) can
    // close this window.
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      provider: mockProvider(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("First write", { tags: ["reader"] });
    // No await here — the second mutation lands in the same sync tick as
    // the first dispatch's match capture.
    store.updateNote(note.id, { content: "Second write, same tick" });
    await settle(hooks);

    expect(calls.length).toBe(1);
    expect(store.getAttachments(note.id).length).toBe(1);
  });

  test("does not double-synthesize under two-phase marker with a slow provider", async () => {
    // Simulate the race: the provider takes a tick, and we mutate the note
    // while the handler is mid-flight. The second mutation should NOT
    // trigger a second synthesis because audio_pending_at is already set.
    const calls: Array<{ text: string; voice?: string }> = [];
    const slowProvider: TtsProvider = {
      name: "slow",
      async synthesize(text, opts) {
        calls.push({ text, voice: opts?.voice });
        await new Promise((r) => setTimeout(r, 20));
        return { audio: Buffer.from("slow-audio"), mime: "audio/mpeg" };
      },
    };
    registerTtsHook(hooks, {
      provider: slowProvider,
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("Race me", { tags: ["reader"] });
    // Let the handler start (claim the pending marker) before mutating.
    await Promise.resolve();
    await Promise.resolve();
    // Mutate while synthesis is running.
    store.updateNote(note.id, { content: "Race me harder" });
    await settle(hooks);

    expect(calls.length).toBe(1);
    expect(store.getAttachments(note.id).length).toBe(1);
  });
});
