/**
 * Tests for the `#capture` → transcription hook (vault-side integration).
 *
 * The transcription pipeline itself lives in `@openparachute/scribe`. These tests
 * stub the scribe module so they cover only what vault owns: the tag
 * predicate, two-phase marker discipline, content writeback, skip-on-empty
 * behavior, and the failure path that leaves notes in `transcript_pending_at`.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SqliteStore } from "../core/src/store.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import { registerTranscriptionHook, type ScribeModule } from "./transcription-hook.ts";

const silentLogger = { error: () => {}, info: () => {} };

/** Wait for queued dispatches + in-flight handlers to settle. */
async function settle(hooks: HookRegistry): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await hooks.drain();
  await Promise.resolve();
  await Promise.resolve();
  await hooks.drain();
}

/**
 * Stub scribe module. `transcribe` returns deterministic text and captures
 * the call args for assertion.
 */
function stubScribe(
  calls: Array<{ fileName: string; provider?: string; cleanup?: string }>,
  overrides: { transcript?: string; fail?: boolean } = {},
): ScribeModule {
  return {
    async transcribe(audio, opts) {
      calls.push({
        fileName: audio.name,
        provider: opts?.provider,
        cleanup: opts?.cleanup,
      });
      if (overrides.fail) {
        throw new Error("transcription failed");
      }
      return overrides.transcript ?? "This is the transcribed text.";
    },
  };
}

/** Write a fake audio file into the assets dir and add an attachment for it. */
function addAudioAttachment(
  store: SqliteStore,
  noteId: string,
  assetsBase: string,
  filename = "recording.ogg",
  mimeType = "audio/ogg",
): void {
  const dir = join(assetsBase, "audio");
  mkdirSync(dir, { recursive: true });
  const relativePath = `audio/${filename}`;
  writeFileSync(join(assetsBase, relativePath), Buffer.from("OggS-fake-audio-data"));
  store.addAttachment(noteId, relativePath, mimeType);
}

let db: Database;
let hooks: HookRegistry;
let store: SqliteStore;
let tmpDir: string;
let assetsBase: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `transcription-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("registerTranscriptionHook — #capture → transcription", () => {
  test("fires for a #capture note with audio attachment and empty content", async () => {
    const calls: Array<{ fileName: string; provider?: string; cleanup?: string }> = [];
    registerTranscriptionHook(hooks, {
      scribe: stubScribe(calls),
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
      transcribeProvider: "groq",
      cleanupProvider: "claude",
    });

    const note = store.createNote("", { tags: ["capture"] });
    addAudioAttachment(store, note.id, assetsBase);

    // Trigger an update so the hook sees the attachment
    store.updateNote(note.id, { content: "" });
    await settle(hooks);

    expect(calls.length).toBe(1);
    expect(calls[0].provider).toBe("groq");
    expect(calls[0].cleanup).toBe("claude");

    const fresh = store.getNote(note.id);
    expect(fresh).not.toBeNull();
    expect(fresh!.content).toBe("This is the transcribed text.");
    const meta = fresh!.metadata as Record<string, unknown>;
    expect(meta.transcript_rendered_at).toBeTruthy();
    expect(meta.transcript_provider).toBe("groq");
    expect(meta.transcript_pending_at).toBeUndefined();
  });

  test("hook writes do not bump updatedAt (issue #44)", async () => {
    const calls: Array<{ fileName: string }> = [];
    registerTranscriptionHook(hooks, {
      scribe: stubScribe(calls),
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("", { tags: ["capture"] });
    addAudioAttachment(store, note.id, assetsBase);
    store.updateNote(note.id, { content: "", skipUpdatedAt: true });
    await settle(hooks);

    const fresh = store.getNote(note.id);
    expect(fresh!.updatedAt).toBeUndefined();
    const meta = fresh!.metadata as Record<string, unknown>;
    expect(meta.transcript_rendered_at).toBeTruthy();
  });

  test("does not fire for notes without the #capture tag", async () => {
    const calls: Array<{ fileName: string }> = [];
    registerTranscriptionHook(hooks, {
      scribe: stubScribe(calls),
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("", { tags: ["other"] });
    addAudioAttachment(store, note.id, assetsBase);
    store.updateNote(note.id, { content: "" });
    await settle(hooks);

    expect(calls.length).toBe(0);
  });

  test("does not fire when note has non-empty content", async () => {
    const calls: Array<{ fileName: string }> = [];
    registerTranscriptionHook(hooks, {
      scribe: stubScribe(calls),
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("Already has content", { tags: ["capture"] });
    addAudioAttachment(store, note.id, assetsBase);
    store.updateNote(note.id, { content: "Already has content" });
    await settle(hooks);

    expect(calls.length).toBe(0);
  });

  test("does not fire when note has no audio attachment", async () => {
    const calls: Array<{ fileName: string }> = [];
    registerTranscriptionHook(hooks, {
      scribe: stubScribe(calls),
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("", { tags: ["capture"] });
    // No audio attachment added
    store.updateNote(note.id, { content: "" });
    await settle(hooks);

    expect(calls.length).toBe(0);
  });

  test("does not re-fire when transcript_rendered_at is already set", async () => {
    const calls: Array<{ fileName: string }> = [];
    registerTranscriptionHook(hooks, {
      scribe: stubScribe(calls),
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("", {
      tags: ["capture"],
      metadata: { transcript_rendered_at: "2025-01-01T00:00:00Z" },
    });
    addAudioAttachment(store, note.id, assetsBase);
    store.updateNote(note.id, { content: "" });
    await settle(hooks);

    expect(calls.length).toBe(0);
  });

  test("scribe failure leaves note stuck in transcript_pending_at (no retry loop)", async () => {
    let callCount = 0;
    const failingScribe: ScribeModule = {
      async transcribe() {
        callCount++;
        throw new Error("provider exploded");
      },
    };
    registerTranscriptionHook(hooks, {
      scribe: failingScribe,
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("", { tags: ["capture"] });
    addAudioAttachment(store, note.id, assetsBase);
    store.updateNote(note.id, { content: "" });
    await settle(hooks);

    expect(callCount).toBe(1);

    const fresh = store.getNote(note.id)!;
    const meta = fresh.metadata as Record<string, unknown>;
    expect(meta.transcript_rendered_at).toBeUndefined();
    expect(meta.transcript_pending_at).toBeTruthy();

    // A subsequent mutation should NOT re-fire (pending still set).
    store.updateNote(note.id, { content: "", skipUpdatedAt: true });
    await settle(hooks);
    expect(callCount).toBe(1);
  });

  test("empty transcription result marks note as skipped, not stuck", async () => {
    const calls: Array<{ fileName: string }> = [];
    registerTranscriptionHook(hooks, {
      scribe: stubScribe(calls, { transcript: "" }),
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("", { tags: ["capture"] });
    addAudioAttachment(store, note.id, assetsBase);
    store.updateNote(note.id, { content: "" });
    await settle(hooks);

    expect(calls.length).toBe(1);

    const fresh = store.getNote(note.id)!;
    const meta = fresh.metadata as Record<string, unknown>;
    expect(meta.transcript_pending_at).toBeUndefined();
    expect(meta.transcript_rendered_at).toBeTruthy();
    expect(meta.transcript_skipped_reason).toBe("empty transcription result");
    expect(fresh.content).toBe("");
  });

  test("clearing transcript_rendered_at re-runs transcription on next update", async () => {
    const calls: Array<{ fileName: string }> = [];
    registerTranscriptionHook(hooks, {
      scribe: stubScribe(calls),
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("", { tags: ["capture"] });
    addAudioAttachment(store, note.id, assetsBase);
    store.updateNote(note.id, { content: "" });
    await settle(hooks);
    expect(calls.length).toBe(1);

    // Clear markers and content to re-trigger
    const meta = store.getNote(note.id)!.metadata as Record<string, unknown>;
    const { transcript_rendered_at: _r, transcript_provider: _p, ...rest } = meta;
    store.updateNote(note.id, { metadata: rest, content: "" });
    await settle(hooks);

    expect(calls.length).toBe(2);
    const freshMeta = store.getNote(note.id)!.metadata as Record<string, unknown>;
    expect(freshMeta.transcript_rendered_at).toBeTruthy();
    expect(freshMeta.transcript_pending_at).toBeUndefined();
  });

  test("two synchronous mutations in the same tick do not double-transcribe", async () => {
    const calls: Array<{ fileName: string }> = [];
    registerTranscriptionHook(hooks, {
      scribe: stubScribe(calls),
      resolveAssetsDir: () => assetsBase,
      logger: silentLogger,
    });

    const note = store.createNote("", { tags: ["capture"] });
    addAudioAttachment(store, note.id, assetsBase);
    // Two mutations, same tick
    store.updateNote(note.id, { content: "" });
    store.updateNote(note.id, { content: "  " }); // whitespace-only still counts as empty
    await settle(hooks);

    expect(calls.length).toBe(1);
  });
});
