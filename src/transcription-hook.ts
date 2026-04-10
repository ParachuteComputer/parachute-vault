/**
 * The `#capture` → transcription hook.
 *
 * Mirrors the shape of `tts-hook.ts`. When a note tagged `#capture` arrives
 * with an audio attachment and empty content, we transcribe the audio via
 * `parachute-scribe` and write the transcript into `note.content`.
 *
 * ## Two-phase marker
 *
 *   1. On entry: write `metadata.transcript_pending_at = <now>` synchronously.
 *      The predicate excludes notes with EITHER `transcript_rendered_at` OR
 *      `transcript_pending_at` set, preventing re-entry.
 *   2. On success: replace `transcript_pending_at` with `transcript_rendered_at`.
 *   3. On failure: leave `transcript_pending_at` set. The note is "stuck"
 *      and will not retry automatically. Clear the field manually to re-run.
 *
 * ## Cascade behavior
 *
 * Writing `note.content` is a note mutation that re-dispatches hooks. If the
 * note is also tagged `#reader`, the TTS hook will fire (the note now has
 * content + reader tag + no `audio_rendered_at`). This is intentional —
 * voice memo → auto-transcribe → auto-narrate is the dream pipeline.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { Note, Store } from "../core/src/types.ts";
import type { HookRegistry } from "../core/src/hooks.ts";

/**
 * The subset of the `parachute-scribe` module surface the hook uses.
 * Declared here so tests can stub it with a plain object.
 */
export interface ScribeModule {
  transcribe(audio: File, opts?: { provider?: string; cleanup?: string }): Promise<string>;
}

export interface RegisterTranscriptionHookOptions {
  /** Injected scribe module (pass the result of `await import("parachute-scribe")`). */
  scribe: ScribeModule;
  /**
   * Resolve the vault assets directory for a given store. Called once per
   * handler invocation so the hook can work with multiple vaults.
   */
  resolveAssetsDir: (store: Store) => string;
  /** Optional logger override. */
  logger?: { error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  /** Transcription provider override (from env TRANSCRIBE_PROVIDER). */
  transcribeProvider?: string;
  /** Cleanup provider override (from env CLEANUP_PROVIDER). */
  cleanupProvider?: string;
}

/**
 * Register the `#capture` → transcription hook on a HookRegistry.
 * Returns the unregister function from `HookRegistry.onNote`.
 */
export function registerTranscriptionHook(
  hooks: HookRegistry,
  opts: RegisterTranscriptionHookOptions,
): () => void {
  const logger = opts.logger ?? console;
  const scribe = opts.scribe;

  return hooks.onNote({
    name: "transcribe-capture",
    event: ["created", "updated"],
    when: (note: Note) => {
      if (!note.tags?.includes("capture")) return false;
      const meta = note.metadata as Record<string, unknown> | undefined;
      if (meta?.transcript_rendered_at) return false;
      if (meta?.transcript_pending_at) return false;
      // Only fire when content is empty/whitespace — the audio IS the content
      if (note.content && note.content.trim().length > 0) return false;
      return true;
    },
    handler: async (note: Note, store: Store) => {
      const existingMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};

      // Handler-side re-check (same race-window protection as tts-hook).
      if (existingMeta.transcript_pending_at || existingMeta.transcript_rendered_at) {
        return;
      }

      // Check for audio attachments
      const attachments = store.getAttachments(note.id);
      const audioAttachment = attachments.find((a) => a.mimeType.startsWith("audio/"));
      if (!audioAttachment) {
        return;
      }

      const pendingAt = new Date().toISOString();

      // Phase 1: claim the note
      try {
        store.updateNote(note.id, {
          metadata: { ...existingMeta, transcript_pending_at: pendingAt },
          skipUpdatedAt: true,
        });
      } catch (err) {
        logger.error(
          `[transcription-hook] failed to claim note ${note.id} (could not write transcript_pending_at):`,
          err,
        );
        throw err;
      }

      // Read the audio file from the assets directory
      let audioBuffer: Buffer;
      try {
        const assetsPath = opts.resolveAssetsDir(store);
        const filePath = join(assetsPath, audioAttachment.path);
        audioBuffer = readFileSync(filePath) as Buffer;
      } catch (err) {
        logger.error(
          `[transcription-hook] failed to read audio file for note ${note.id}; note left in transcript_pending_at state:`,
          err,
        );
        throw err;
      }

      // Construct a File object (scribe's transcribe expects File)
      const audioFile = new File([audioBuffer], audioAttachment.path.split("/").pop() ?? "recording.ogg", {
        type: audioAttachment.mimeType,
      });

      // Transcribe
      let transcript: string;
      try {
        transcript = await scribe.transcribe(audioFile, {
          provider: opts.transcribeProvider,
          cleanup: opts.cleanupProvider,
        });
      } catch (err) {
        logger.error(
          `[transcription-hook] scribe.transcribe failed for note ${note.id}; note left in transcript_pending_at state (manual recovery required):`,
          err,
        );
        throw err;
      }

      // Handle empty transcription
      if (!transcript || !transcript.trim()) {
        try {
          const freshSkip = store.getNote(note.id);
          const freshSkipMeta = (freshSkip?.metadata as Record<string, unknown> | undefined) ?? existingMeta;
          const { transcript_pending_at: _dropSkip, ...restSkipMeta } = freshSkipMeta;
          store.updateNote(note.id, {
            metadata: {
              ...restSkipMeta,
              transcript_rendered_at: new Date().toISOString(),
              transcript_skipped_reason: "empty transcription result",
            },
            skipUpdatedAt: true,
          });
        } catch (err) {
          logger.error(
            `[transcription-hook] failed to mark note ${note.id} as transcript-skipped:`,
            err,
          );
        }
        return;
      }

      // Phase 2: write transcript to content and update markers
      try {
        const fresh = store.getNote(note.id);
        const freshMeta = (fresh?.metadata as Record<string, unknown> | undefined) ?? existingMeta;
        const { transcript_pending_at: _drop, ...restMeta } = freshMeta;
        store.updateNote(note.id, {
          content: transcript,
          metadata: {
            ...restMeta,
            transcript_rendered_at: new Date().toISOString(),
            transcript_provider: opts.transcribeProvider,
          },
          skipUpdatedAt: true,
        });
      } catch (err) {
        logger.error(
          `[transcription-hook] failed to write transcript for note ${note.id}:`,
          err,
        );
        throw err;
      }
    },
  });
}
