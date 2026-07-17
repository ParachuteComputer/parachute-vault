/**
 * `AttachmentBytesProvider` — the model-lane (Wave 2) byte-access seam.
 * Mirrors `AttachmentTicketProvider` (`./tickets.ts`): a per-door
 * implementation binds this to its own storage (bun: local fs, see
 * `src/attachment-bytes.ts`; a future cloud implementation: ranged R2 GETs
 * through the vault DO). Core stays storage-unaware — the `read-attachment`
 * tool (`core/src/mcp.ts`) calls only through this interface, so bun and a
 * future cloud implementation can never drift on the read contract.
 *
 * Deliberately narrow: stat + a bounded positional read, plus one optional
 * hook for the audio transcript pointer. All POLICY (mime-family dispatch,
 * size caps, range validation, tag-scope) lives in the `read-attachment`
 * tool itself — same division as the ticket seam (`GenerateMcpToolsOpts`'s
 * doc comment in `core/src/mcp.ts`).
 *
 * D10 (attachments-for-agents design): "tools omitted when unwired" — a
 * door that hasn't wired this seam simply never passes `attachmentBytes` to
 * `generateMcpTools`, so `read-attachment` is absent from `tools/list`
 * entirely, not merely erroring on call.
 */

import type { Attachment } from "../types.js";

/**
 * 4 MiB raw-bytes cap on the image branch of `read-attachment` (D3): the
 * largest honest budget under Claude's ~5 MB image API limit, with room for
 * base64 blow-up (~5.6 MiB on the wire) and DO-transient headroom on a
 * future cloud implementation. Enforced BEFORE a read is attempted — the
 * tool calls `stat()` first and refuses over-cap without ever calling
 * `readRange()`.
 */
export const MAX_ATTACHMENT_IMAGE_BYTES = 4 * 1024 * 1024;

export interface AttachmentBytesProvider {
  /**
   * Byte size of the attachment's stored bytes, or `null` when the row
   * exists but its bytes don't — e.g. an `audio_retention` eviction after a
   * successful transcription (`src/transcription-worker.ts` unlinks the
   * file on `until_transcribed` / `never` retention), or any other
   * out-of-band loss. Drives the `attachment_binary_missing` refusal.
   */
  stat(attachment: Attachment): Promise<{ size: number } | null>;
  /**
   * Read the half-open byte range `[start, end)`. Bounded by construction —
   * callers never ask for the whole file when only a window is needed (the
   * text path); the image path DOES read start-to-end, but only after
   * `stat()` has already confirmed the file is under
   * {@link MAX_ATTACHMENT_IMAGE_BYTES}. `start`/`end` are always within
   * `[0, size]` as reported by a prior `stat()` call on the same attachment
   * — implementations don't need to re-clamp defensively, though doing so
   * costs nothing.
   */
  readRange(attachment: Attachment, start: number, end: number): Promise<Uint8Array>;
  /**
   * OPTIONAL: resolve the sibling transcript note for a completed
   * audio/video transcription (bun: `<attachment-path>.transcript`, see
   * `transcriptPathFor` in `src/transcript-note.ts`). Omitted by a door
   * whose transcript instead lives in the owning note's body (the design's
   * cloud path, D... — no separate sibling note to point at) — the
   * `read-attachment` audio branch falls back to `note_id` alone (the
   * owning note) in that case, per the design's "on cloud the transcript
   * lives in the owning note's body, so `note_id` is the pointer."
   */
  resolveTranscriptNote?(attachment: Attachment): Promise<{ id: string; path: string } | null>;
}
