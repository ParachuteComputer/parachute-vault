/**
 * Tests for the `#reader` → audio hook (vault-side integration).
 *
 * The TTS pipeline itself (providers, markdown preprocessing, encoding)
 * lives in `@openparachute/narrate` and has its own tests there. These tests
 * stub the narrate module so they cover only what vault owns: the tag
 * predicate, two-phase marker discipline, attachment write, skip-on-empty
 * behavior, and the failure path that leaves notes in `audio_pending_at`.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SqliteStore } from "../core/src/store.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import { registerTtsHook, type NarrateModule } from "./tts-hook.ts";

const silentLogger = { error: () => {}, info: () => {} };

/** Wait for queued dispatches + in-flight handlers to settle. */
async function settle(hooks: HookRegistry): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await hooks.drain();
  // The handler itself re-enters updateNote (phase 1 + phase 2), which
  // re-dispatches more microtasks. Drain again to catch those.
  await Promise.resolve();
  await Promise.resolve();
  await hooks.drain();
}

// No-op narrate error classes — the hook never catches typed errors from
// narrate (it only uses markdownToSpeech + synthesize), but the interface
// now requires these constructors. Define local shims so the TypeScript
// shape matches without pulling in @openparachute/narrate directly.
class StubNarrateEmptyInputError extends Error {
  constructor(...args: unknown[]) {
    super((args[0] as string | undefined) ?? "empty");
  }
}
class StubNarrateNoProviderError extends Error {
  constructor(...args: unknown[]) {
    super((args[0] as string | undefined) ?? "no provider");
  }
}

/**
 * Stub narrate module. `synthesize` returns deterministic OggS-prefixed
 * bytes and captures the call args for assertion. `markdownToSpeech` is a
 * trivial tag/syntax stripper that's sufficient for the hook's empty-input
 * guard — the real preprocessor lives in narrate.
 */
function stubNarrate(
  calls: Array<{ text: string; voice?: string }>,
  overrides: Partial<NarrateModule> = {},
): NarrateModule {
  return {
    async synthesize(text, opts) {
      calls.push({ text, voice: opts?.voice });
      return {
        audio: Buffer.concat([Buffer.from("OggS"), Buffer.from("-stub:"), Buffer.from(text)]),
        mime: "audio/ogg",
        voice: opts?.voice,
        provider: "stub",
      };
    },
    markdownToSpeech(text) {
      // Minimal preprocessor for the tests: strip fenced code blocks and
      // markdown syntax so the "only a code block" case returns empty,
      // mirroring narrate's real behavior on that input.
      const stripped = text
        .replace(/```[\s\S]*?```/g, "")
        .replace(/[#*[\]()]/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .trim();
      return stripped;
    },
    NarrateEmptyInputError: StubNarrateEmptyInputError,
    NarrateNoProviderError: StubNarrateNoProviderError,
    ...overrides,
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

describe("registerTtsHook — #reader → audio", () => {
  test("fires for a #reader note, attaches audio, sets marker", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      narrate: stubNarrate(calls),
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
    expect(meta.audio_provider).toBe("stub");
    expect(meta.audio_pending_at).toBeUndefined();

    const attachments = store.getAttachments(note.id);
    expect(attachments.length).toBe(1);
    expect(attachments[0].mimeType).toBe("audio/ogg");
    expect(attachments[0].path.startsWith("tts/")).toBe(true);
    expect(attachments[0].path.endsWith(".ogg")).toBe(true);

    const absPath = join(assetsBase, attachments[0].path);
    expect(existsSync(absPath)).toBe(true);
    const bytes = readFileSync(absPath);
    // Must start with the OGG magic bytes.
    expect(bytes.toString("ascii", 0, 4)).toBe("OggS");
  });

  test("hook writes do not bump updatedAt (issue #44)", async () => {
    // Hook metadata writes are machine-level enrichment, not user edits.
    // They must not count as "recent activity" — anything sorting by
    // updatedAt (e.g. parachute-daily's reader list) would otherwise show
    // notes re-ordered by when their audio finished rendering, not by any
    // user action.
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      narrate: stubNarrate(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("Hello reader", { tags: ["reader"] });
    expect(note.updatedAt).toBeUndefined();
    await settle(hooks);

    // After the full two-phase hook run, updatedAt must still be untouched.
    const fresh = store.getNote(note.id);
    expect(fresh!.updatedAt).toBeUndefined();
    // ...but the marker metadata the hook writes IS persisted.
    const meta = fresh!.metadata as Record<string, unknown>;
    expect(meta.audio_rendered_at).toBeTruthy();
  });

  test("passes raw note content through to narrate (narrate owns preprocessing)", async () => {
    // The hook's empty-input guard uses `narrate.markdownToSpeech` only
    // to detect unspeakable notes. For speakable notes, the raw content
    // flows through to `narrate.synthesize`, which runs its own
    // preprocessing. This test pins that contract.
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      narrate: stubNarrate(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const raw = "# Title\n\n**Bold** text and [link](https://example.com).";
    store.createNote(raw, { tags: ["reader"] });
    await settle(hooks);

    expect(calls.length).toBe(1);
    // The stub captures whatever the hook passed. The hook passes the raw
    // note content, not the stripped version, because narrate's own
    // pipeline will strip it. (The stub doesn't re-strip; it just echoes.)
    expect(calls[0].text).toBe(raw);
  });

  test("note with only a code block is marked rendered-with-skip-reason, not stuck", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      narrate: stubNarrate(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("```python\nprint('hi')\n```", {
      tags: ["reader"],
    });
    await settle(hooks);

    // Narrate.synthesize was NOT called — the hook's pre-check caught it.
    expect(calls.length).toBe(0);

    // But the note is marked rendered (with a skip reason) so the hook
    // doesn't keep retrying.
    const fresh = store.getNote(note.id);
    const meta = fresh!.metadata as Record<string, unknown>;
    expect(meta.audio_pending_at).toBeUndefined();
    expect(meta.audio_rendered_at).toBeTruthy();
    expect(meta.audio_skipped_reason).toBe("empty after markdown preprocessing");

    expect(store.getAttachments(note.id).length).toBe(0);
  });

  test("does not fire for notes without the #reader tag", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      narrate: stubNarrate(calls),
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
      narrate: stubNarrate(calls),
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

    store.updateNote(note.id, { content: "edited" });
    await settle(hooks);
    expect(calls.length).toBe(0);
    expect(store.getAttachments(note.id).length).toBe(0);
  });

  test("clearing audio_rendered_at re-runs synthesis on next update", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      narrate: stubNarrate(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("First pass", { tags: ["reader"] });
    await settle(hooks);
    expect(calls.length).toBe(1);
    expect(store.getAttachments(note.id).length).toBe(1);

    const meta = store.getNote(note.id)!.metadata as Record<string, unknown>;
    const { audio_rendered_at: _r, audio_voice: _v, audio_provider: _p, ...rest } = meta;
    store.updateNote(note.id, { metadata: rest, content: "Second pass" });
    await settle(hooks);

    expect(calls.length).toBe(2);
    expect(calls[1].text).toBe("Second pass");
    expect(store.getAttachments(note.id).length).toBe(2);

    const freshMeta = store.getNote(note.id)!.metadata as Record<string, unknown>;
    expect(freshMeta.audio_rendered_at).toBeTruthy();
    expect(freshMeta.audio_pending_at).toBeUndefined();
  });

  test("narrate failure leaves note stuck in audio_pending_at (no retry loop)", async () => {
    let callCount = 0;
    const failingNarrate: NarrateModule = {
      async synthesize() {
        callCount++;
        throw new Error("boom");
      },
      markdownToSpeech: (t) => t,
      NarrateEmptyInputError: StubNarrateEmptyInputError,
      NarrateNoProviderError: StubNarrateNoProviderError,
    };
    registerTtsHook(hooks, {
      narrate: failingNarrate,
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("Will fail", { tags: ["reader"] });
    await settle(hooks);

    expect(callCount).toBe(1);

    const fresh = store.getNote(note.id)!;
    const meta = fresh.metadata as Record<string, unknown>;
    expect(meta.audio_rendered_at).toBeUndefined();
    expect(meta.audio_pending_at).toBeTruthy();
    expect(store.getAttachments(note.id).length).toBe(0);

    // A subsequent mutation should NOT re-fire (pending still set).
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
      narrate: stubNarrate(calls),
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
    const calls: Array<{ text: string; voice?: string }> = [];
    registerTtsHook(hooks, {
      narrate: stubNarrate(calls),
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("First write", { tags: ["reader"] });
    // No await — second mutation lands in the same sync tick.
    store.updateNote(note.id, { content: "Second write, same tick" });
    await settle(hooks);

    expect(calls.length).toBe(1);
    expect(store.getAttachments(note.id).length).toBe(1);
  });

  test("does not double-synthesize under two-phase marker with a slow narrate", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    const slowNarrate: NarrateModule = {
      async synthesize(text, opts) {
        calls.push({ text, voice: opts?.voice });
        await new Promise((r) => setTimeout(r, 20));
        return {
          audio: Buffer.concat([Buffer.from("OggS"), Buffer.from("-slow")]),
          mime: "audio/ogg",
          voice: opts?.voice,
          provider: "slow",
        };
      },
      markdownToSpeech: (t) => t,
      NarrateEmptyInputError: StubNarrateEmptyInputError,
      NarrateNoProviderError: StubNarrateNoProviderError,
    };
    registerTtsHook(hooks, {
      narrate: slowNarrate,
      voice: "test-voice",
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("Race me", { tags: ["reader"] });
    // Let the handler start (claim the pending marker) before mutating.
    await Promise.resolve();
    await Promise.resolve();
    store.updateNote(note.id, { content: "Race me harder" });
    await settle(hooks);

    expect(calls.length).toBe(1);
    expect(store.getAttachments(note.id).length).toBe(1);
  });
});
