/**
 * The `#reader` → audio hook.
 *
 * Vault-specific concerns only: attachment storage, the two-phase marker
 * discipline, and the manual-recovery retry semantics. The actual TTS
 * pipeline (provider resolution, markdown preprocessing, encoding) lives in
 * `parachute-narrate` and is injected into this hook at registration time.
 *
 * See `parachute-narrate`'s CLAUDE.md for the pipeline; this file documents
 * the vault-side integration contract.
 *
 * ## Two-phase marker (unchanged from the pre-narrate shape)
 *
 *   1. On entry: write `metadata.audio_pending_at = <now>` synchronously.
 *      The predicate excludes notes with EITHER `audio_rendered_at` OR
 *      `audio_pending_at` set, so a concurrent update cannot start a second
 *      run while this one is in flight.
 *   2. On success: replace `audio_pending_at` with `audio_rendered_at`
 *      (and record `audio_voice` + `audio_provider`) in the same update.
 *   3. On failure: leave `audio_pending_at` set. The note is now "stuck"
 *      and will not retry automatically. Clear the field manually to re-run.
 *
 * Why not clear on failure? Clearing `audio_pending_at` is itself a note
 * mutation, which re-dispatches the hook. The predicate would match, the
 * handler would re-run, the provider would fail again, and we'd be in an
 * infinite retry loop. Leaving the pending marker set keeps the note
 * quiescent until a human decides what to do.
 *
 * ## Empty-after-preprocess
 *
 * A note containing only a fenced code block, only an HTML blob, etc. has
 * non-empty raw content but produces empty text after `markdownToSpeech`.
 * We detect that BEFORE calling `narrate.synthesize` (which would throw)
 * and mark the note as rendered-with-skip-reason so the hook doesn't retry.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { Note, Store } from "../core/src/types.ts";
import type { HookRegistry } from "../core/src/hooks.ts";

/**
 * The subset of the `parachute-narrate` module surface the hook actually
 * uses. Declared here so tests can stub it with a plain object and so this
 * file doesn't need a hard type import on the optional dependency.
 */
export interface NarrateModule {
  synthesize(
    text: string,
    opts?: { voice?: string },
  ): Promise<{
    audio: Buffer;
    mime: "audio/ogg";
    voice: string | undefined;
    provider: string;
  }>;
  markdownToSpeech(text: string): string;
  // Error classes — referenced via `instanceof err instanceof narrate.NarrateEmptyInputError`
  // so we can distinguish "empty input" from "no provider" without substring
  // matching on error messages.
  NarrateEmptyInputError: new (...args: never[]) => Error;
  NarrateNoProviderError: new (...args: never[]) => Error;
}

export interface RegisterTtsHookOptions {
  /** Injected narrate module (pass the result of `await import("parachute-narrate")`). */
  narrate: NarrateModule;
  /** Voice id to pass to the provider (usually env.TTS_VOICE or equivalent). */
  voice?: string;
  /**
   * Resolve the vault assets directory for a given store. Called once per
   * handler invocation so the hook can work with multiple vaults.
   */
  resolveAssetsDir: (store: Store) => string;
  /** Optional logger override. */
  logger?: { error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
}

/**
 * Register the `#reader` → audio hook on a HookRegistry. Returns the
 * unregister function from `HookRegistry.onNote`.
 */
export function registerTtsHook(
  hooks: HookRegistry,
  opts: RegisterTtsHookOptions,
): () => void {
  const logger = opts.logger ?? console;
  const narrate = opts.narrate;

  return hooks.onNote({
    name: "tts-reader",
    event: ["created", "updated"],
    when: (note: Note) => {
      if (!note.tags?.includes("reader")) return false;
      const meta = note.metadata as Record<string, unknown> | undefined;
      if (meta?.audio_rendered_at) return false;
      if (meta?.audio_pending_at) return false;
      if (!note.content || note.content.trim().length === 0) return false;
      return true;
    },
    handler: async (note: Note, store: Store) => {
      const existingMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};

      // Handler-side re-check. The hook-registry predicate runs at dispatch
      // time, but two synchronous mutations back-to-back can both snapshot
      // matches before either handler's phase-1 write lands — the semaphore
      // is global, not per-note. Re-checking here on the freshly-read note
      // closes that window.
      if (existingMeta.audio_pending_at || existingMeta.audio_rendered_at) {
        return;
      }

      const pendingAt = new Date().toISOString();

      // Phase 1: claim the note synchronously so a concurrent update cannot
      // double-schedule synthesis. This write re-dispatches the hook, but
      // the predicate now excludes the note because audio_pending_at is set.
      try {
        store.updateNote(note.id, {
          metadata: { ...existingMeta, audio_pending_at: pendingAt },
          skipUpdatedAt: true,
        });
      } catch (err) {
        logger.error(
          `[tts-hook] failed to claim note ${note.id} (could not write audio_pending_at):`,
          err,
        );
        throw err;
      }

      // Empty-after-preprocess guard — check BEFORE calling narrate so we
      // can mark the note as skipped rather than stuck. Narrate throws on
      // empty input, but we want a distinct outcome (skipped, not failed)
      // because there is no "manual recovery" for a fundamentally
      // unspeakable note.
      const speechText = narrate.markdownToSpeech(note.content);
      if (!speechText || !speechText.trim()) {
        try {
          store.updateNote(note.id, {
            metadata: {
              ...existingMeta,
              audio_pending_at: undefined,
              audio_rendered_at: new Date().toISOString(),
              audio_skipped_reason: "empty after markdown preprocessing",
            },
            skipUpdatedAt: true,
          });
        } catch (err) {
          logger.error(
            `[tts-hook] failed to mark note ${note.id} as audio-skipped:`,
            err,
          );
        }
        return;
      }

      // Narrate handles preprocess → provider → encode. Since we already
      // ran `markdownToSpeech` above (for the skip-guard), pass the raw
      // note content through again — narrate is idempotent on already-
      // plain text, and running its full pipeline keeps the edge cases
      // (e.g. future provider-specific normalization) owned in one place.
      let result: Awaited<ReturnType<NarrateModule["synthesize"]>>;
      try {
        result = await narrate.synthesize(note.content, { voice: opts.voice });
      } catch (err) {
        logger.error(
          `[tts-hook] narrate.synthesize failed for note ${note.id}; note left in audio_pending_at state (manual recovery required):`,
          err,
        );
        // Deliberately leave audio_pending_at set. See header for reasoning.
        throw err;
      }

      // Persist the encoded audio file under <assets>/tts/<date>/<noteId>-<ts>.ogg.
      let relativePath: string;
      try {
        const assets = opts.resolveAssetsDir(store);
        const date = pendingAt.split("T")[0];
        const dir = join(assets, "tts", date);
        mkdirSync(dir, { recursive: true });
        const filename = `${note.id}-${Date.now()}.ogg`;
        const absPath = join(dir, filename);
        writeFileSync(absPath, result.audio);
        relativePath = `tts/${date}/${filename}`;
      } catch (err) {
        logger.error(
          `[tts-hook] failed to write audio file for note ${note.id}; note left in audio_pending_at state:`,
          err,
        );
        throw err;
      }

      // Phase 2: attach the audio and mark the note as rendered. Read the
      // latest metadata first so we don't clobber concurrent edits.
      try {
        store.addAttachment(note.id, relativePath, result.mime, {
          source: "tts",
          provider: result.provider,
          voice: opts.voice,
          size_bytes: result.audio.length,
        });

        const fresh = store.getNote(note.id);
        const freshMeta = (fresh?.metadata as Record<string, unknown> | undefined) ?? existingMeta;
        const { audio_pending_at: _drop, ...restMeta } = freshMeta;
        store.updateNote(note.id, {
          metadata: {
            ...restMeta,
            audio_rendered_at: new Date().toISOString(),
            audio_voice: opts.voice,
            audio_provider: result.provider,
          },
          skipUpdatedAt: true,
        });
      } catch (err) {
        logger.error(
          `[tts-hook] failed to attach/mark audio for note ${note.id}:`,
          err,
        );
        throw err;
      }
    },
  });
}
