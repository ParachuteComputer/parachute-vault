/**
 * Transcript-note materialization for the vault↔scribe auto-transcribe path
 * (vault#353, design 2026-05-21 Part 2, design question 3).
 *
 * When the transcription worker resolves an audio attachment, it asks this
 * module to create (or update) a sibling `<attachment-path>.transcript.md`
 * note. The note's frontmatter links back to the original audio attachment
 * via `transcript_of`, lets vault graph queries surface the relation, and
 * captures success / failure state in a single uniform shape.
 *
 * Design Q3's exact shape:
 *
 *   ---
 *   title: Transcript of <attachment-name>
 *   tags: [transcript, capture]
 *   created_at: <iso>
 *   transcript_of: <attachment-path>
 *   transcript_status: complete | failed
 *   transcript_provider: <name or unset>
 *   transcript_duration_ms: <wall-clock ms>
 *   transcript_error: <error-message — failed only>
 *   ---
 *
 *   <transcript text — empty body when failed>
 *
 * The `transcript_status` values are uniform: `complete` for success and
 * `failed` for any terminal failure (provider missing, scribe 5xx, timeout,
 * etc.). The cause is in `transcript_error`. This matches the design's
 * "same failure substrate" stance — no first-boot-specific branch, just
 * different error strings.
 *
 * ## Retry semantics
 *
 * When the retry endpoint re-runs transcription on an already-failed
 * transcript note, the same note is updated in place — `transcript_of`,
 * `path`, and `id` all stay constant. Callers identify the transcript by
 * note path (`<attachment-path>.transcript.md`) and call `upsertTranscriptNote`
 * to overwrite. The transcript-of relation is materialized as both a
 * frontmatter scalar AND a vault link (via `links.add` on create) so graph
 * queries can find it without parsing frontmatter.
 */

import type { Store, Note } from "../core/src/types.ts";

export type TranscriptStatus = "complete" | "failed";

export interface TranscriptNoteInput {
  /**
   * Path of the source audio attachment (relative to the vault assets dir).
   * Used to derive the transcript note's path and the `transcript_of`
   * frontmatter scalar.
   */
  attachmentPath: string;
  /**
   * Attachment row id of the source audio. Stamped onto the transcript note
   * frontmatter (`transcript_attachment_id`) so the retry endpoint can find
   * the original audio in one DB lookup without walking links or paths.
   */
  attachmentId: string;
  /**
   * The note that owns the audio attachment. The transcript-of relation
   * (vault link) is established to this note so graph queries can find the
   * transcript from either side.
   */
  attachmentNoteId: string;
  /** Outcome — `complete` (transcript text available) or `failed`. */
  status: TranscriptStatus;
  /**
   * Transcript body. Required when `status === "complete"`; ignored otherwise.
   * Failure transcript notes have an empty body — the error string is in
   * frontmatter, not in the note body, so failures don't read like content.
   */
  text?: string;
  /** Error cause for `status === "failed"`. Required for failed status. */
  error?: string;
  /** Scribe-reported provider (e.g. "groq", "whisper"). Optional. */
  provider?: string;
  /** Wall-clock duration of the scribe call. Optional; 0 if unknown. */
  durationMs?: number;
  /** Created-at override (defaults to `new Date()`). */
  createdAt?: Date;
}

/**
 * Compute the canonical transcript-note path for an audio attachment.
 *
 * Example: `inbox/Voice 2026-05-21 09-13.m4a` → `inbox/Voice 2026-05-21 09-13.m4a.transcript`
 *
 * The `.md` extension is implicit in the vault path normalization (paths are
 * stored without `.md` per vault convention; on export to portable markdown,
 * `.md` is appended).
 */
export function transcriptPathFor(attachmentPath: string): string {
  return `${attachmentPath}.transcript`;
}

/**
 * Build the body+metadata for a transcript note from the worker's input.
 * Pure — no Store calls — so unit tests can assert shape without a DB.
 * Exposed for tests and for any future caller that wants to materialize a
 * transcript note independently of the worker.
 */
export function buildTranscriptNote(input: TranscriptNoteInput): {
  path: string;
  content: string;
  metadata: Record<string, unknown>;
  tags: string[];
  createdAt: string;
} {
  const created = (input.createdAt ?? new Date()).toISOString();
  const filename = input.attachmentPath.split("/").pop() ?? input.attachmentPath;
  const metadata: Record<string, unknown> = {
    title: `Transcript of ${filename}`,
    transcript_of: input.attachmentPath,
    transcript_attachment_id: input.attachmentId,
    transcript_status: input.status,
  };
  if (input.provider) metadata.transcript_provider = input.provider;
  if (typeof input.durationMs === "number") {
    metadata.transcript_duration_ms = input.durationMs;
  }
  if (input.status === "failed") {
    metadata.transcript_error = input.error ?? "unknown error";
  }
  const body = input.status === "complete" ? (input.text ?? "") : "";
  return {
    path: transcriptPathFor(input.attachmentPath),
    content: body,
    metadata,
    tags: ["transcript", "capture"],
    createdAt: created,
  };
}

/**
 * Create or update the transcript note at `<attachmentPath>.transcript.md`.
 *
 * - If no note exists at that path, creates one with the standard shape,
 *   establishes a `transcript_of` link to the attachment-owning note, and
 *   returns the new note.
 * - If a transcript note already exists (retry path), overwrites its content
 *   + metadata in place, preserves the existing note id, and returns the
 *   updated note. Links are NOT re-created — the existing relation survives.
 *
 * Errors from the Store (path collision with a non-transcript note, etc.)
 * bubble up; the worker catches them and logs.
 */
export async function upsertTranscriptNote(
  store: Store,
  input: TranscriptNoteInput,
): Promise<Note> {
  const built = buildTranscriptNote(input);
  const existing = await store.getNoteByPath(built.path);
  if (existing) {
    await store.updateNote(existing.id, {
      content: built.content,
      metadata: built.metadata,
      // Preserve the original created_at; the retry doesn't reset it.
      skipUpdatedAt: false,
    });
    // Re-apply tags via tagNote — updateNote() doesn't accept a tags field
    // (the engine treats tag mutation as a separate op). tagNote upserts
    // existing tags (no duplicates), so it's safe to call even when tags
    // are unchanged from the prior write.
    await store.tagNote(existing.id, built.tags);
    const updated = await store.getNote(existing.id);
    return updated ?? existing;
  }
  const created = await store.createNote(built.content, {
    path: built.path,
    tags: built.tags,
    metadata: built.metadata,
    created_at: built.createdAt,
  });
  // Materialize the transcript-of relation as a typed link too, so graph
  // queries (find-path, neighborhood) surface the transcript without
  // walking frontmatter. The relation is named "transcript_of" so it
  // matches the frontmatter scalar; if the target note has been deleted
  // by the time we get here (race during retry), skip silently — the
  // frontmatter scalar still carries the relation for query-by-path.
  try {
    await store.createLink(created.id, input.attachmentNoteId, "transcript_of");
  } catch {
    // Target may be missing or the link constraint may reject — failure
    // here doesn't invalidate the transcript itself, which is still
    // queryable via the `transcript_of` frontmatter scalar + path.
  }
  return created;
}
