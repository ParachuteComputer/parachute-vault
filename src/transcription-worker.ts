/**
 * Event-driven transcription with a safety-net sweep.
 *
 * ## Shape (event-driven happy path, timer-driven failure path)
 *
 * - **Event path (hot):** `POST /api/notes/:id/attachments` with
 *   `{transcribe: true}` writes `attachment.metadata.transcribe_status =
 *   "pending"` via `store.addAttachment`, which dispatches an
 *   `attachment:created` hook. A handler registered via
 *   `registerTranscriptionHook` calls `worker.kick()` on the owning vault,
 *   so the cycle begins in the microtask after the HTTP response returns —
 *   upload latency is not gated on transcription latency.
 * - **Sweep path (safety net):** Every `pollIntervalMs` (default 30s), the
 *   worker lists pending attachments across all vaults and runs them. This
 *   catches items queued during a server restart, items whose backoff just
 *   elapsed, and anything that got orphaned by a dropped hook dispatch.
 *
 * The DB remains the queue — `metadata.transcribe_status = "pending"` is
 * the source of truth; the hook is a shortcut for cache warmth.
 *
 * ## What the worker does per pending attachment
 *
 * 1. Read the audio file from the vault's assets dir.
 * 2. POST it as multipart/form-data to `SCRIBE_URL/v1/audio/transcriptions`
 *    (Whisper API shape). Response is `{ text: string }`.
 * 3. On success:
 *    - If `note.metadata.transcribe_stub === true`, replace the
 *      `_Transcript pending._` placeholder (or a prior `_Transcription
 *      unavailable._` failure marker, on a retry) with the transcript. If
 *      neither marker is present (user edited the note while pending),
 *      APPEND the transcript rather than overwriting the body. Clear the
 *      stub marker.
 *    - Mark `attachment.metadata.transcribe_status = "done"` and record
 *      `transcript` + `transcribe_done_at`.
 *    - If the vault's `audio_retention` is `"until_transcribed"`, unlink
 *      the audio file on disk (the attachment row stays, so the transcript
 *      metadata is still addressable).
 * 4. On failure:
 *    - Up to `maxAttempts` retries with exponential backoff encoded as
 *      `transcribe_backoff_until`. Status stays `"pending"`; the sweep
 *      skips ones whose backoff hasn't expired.
 *    - After `maxAttempts`, flip status to `"failed"` with `transcribe_error`.
 *
 * ## Concurrency
 *
 * FIFO across all vaults. Hook-driven and sweep-driven paths race on the
 * same attachment if an upload arrives just before a sweep runs; an
 * in-memory `inFlight` set dedupes within the process so we don't double-
 * POST to scribe. Cross-process guarantees still live in the DB — a sweep
 * on another process would see `transcribe_status = "pending"` and try
 * again, which scribe and the metadata writes handle idempotently.
 */

import { join, normalize } from "path";
import { existsSync, readFileSync, unlinkSync } from "fs";
import type { Store, Attachment, Note } from "../core/src/types.ts";
import type { HookRegistry } from "../core/src/hooks.ts";
import { fetchContextEntries, type ContextPayload } from "./context.ts";
import type { TriggerIncludeContext } from "./config.ts";
import { upsertTranscriptNote } from "./transcript-note.ts";
import {
  TranscriptionError,
  type TranscriptionProvider,
} from "../core/src/transcription/provider.ts";
import { ScribeHttpProvider } from "./transcription/providers/scribe-http.ts";

/**
 * The in-body transcription markers.
 *
 * The BARE markers are the un-segmented default; voice W2 (segmented
 * recordings) targets per-part variants built by `markersFor`. Both are a
 * BYTE-EXACT cross-door + cross-repo contract — the cloud Workers-AI
 * transcription path ships the identical strings, and the notes-ui status
 * chip (parachute-surface TranscriptionStatus.tsx) keys off the failure
 * marker's exact copy. Don't change any of this text without a coordinated
 * change in both places. A friendlier "retry available" copy + chip
 * affordance is a tracked parachute-surface follow-up.
 *
 * Owning the failure marker here (it used to be written by Lens's now-removed
 * scribe client) means a failed upload stops reading "Transcript pending"
 * forever regardless of which client uploaded the audio.
 */
const BARE_PENDING = "_Transcript pending._";
const BARE_UNAVAILABLE = "_Transcription unavailable._";

/** Escape a literal string for safe embedding in a `RegExp`. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The pending + terminal-failure markers for an attachment, honoring
 * `segment_index` (voice W2 — segmented recordings). `undefined` yields the
 * bare markers (fully backward compatible — un-segmented flows are byte-
 * unchanged). An integer ≥ 0 yields this part's markers, with the human-
 * facing part number N = segment_index + 1 (1-based, decimal):
 *   `_Transcript pending (part N)._` / `_Transcription unavailable (part N)._`
 */
function markersFor(segmentIndex: number | undefined): { pending: string; unavailable: string } {
  if (segmentIndex === undefined) return { pending: BARE_PENDING, unavailable: BARE_UNAVAILABLE };
  const n = segmentIndex + 1;
  return {
    pending: `_Transcript pending (part ${n})._`,
    unavailable: `_Transcription unavailable (part ${n})._`,
  };
}

/**
 * A valid segment index (integer ≥ 0) off attachment metadata, else
 * `undefined` — the un-segmented path. Client-set at link time; anything that
 * isn't a non-negative integer falls back to the bare markers rather than
 * fabricating a `(part N)`.
 */
function segmentIndexOf(meta: { segment_index?: unknown }): number | undefined {
  const raw = meta.segment_index;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}

/**
 * Default sweep cadence (ms). The sweep is the safety net for backoff-
 * queued items, items that arrived while the server was down, or dispatches
 * that got dropped — not the hot path. Fresh uploads land in single-digit
 * ms via the `attachment:created` hook (see `registerTranscriptionHook`).
 *
 * Operators can override this with the `TRANSCRIPTION_SWEEP_MS` env var
 * (read at `startTranscriptionWorker()` time, not module load, so values
 * in `~/.parachute/vault/.env` apply — ES module import happens before
 * `loadEnvFile()` in server.ts). Per-caller override via the
 * `pollIntervalMs` opt wins over both.
 */
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

export type AudioRetention = "keep" | "until_transcribed" | "never";

export interface TranscriptionWorkerOpts {
  /** Vault names to scan each cycle. */
  vaultList: () => string[];
  /** Get a store for a vault name. */
  getStore: (name: string) => Store;
  /**
   * Scribe base URL (no trailing slash). Only used to build the default
   * `scribe-http` provider when no `provider` is injected — a `transcribe-cpp`
   * (or any injected) provider needs no scribe URL, so this is optional.
   */
  scribeUrl?: string;
  /** Optional bearer token for scribe. */
  scribeToken?: string;
  /** Resolve the assets root for a vault name. */
  resolveAssetsDir: (vault: string) => string;
  /** Per-vault audio retention. Default "keep". */
  getAudioRetention?: (vault: string) => AudioRetention;
  /**
   * Per-vault context predicates for enriching the scribe POST. When present,
   * the worker runs each predicate against the vault store and attaches the
   * resulting entries as a `context` multipart part. Matches triggers'
   * `action.include_context` so scribe sees the same shape via either path.
   * Returning `undefined` or `[]` means no context is attached.
   */
  getContextPredicates?: (vault: string) => TriggerIncludeContext[] | undefined;
  pollIntervalMs?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Transcription provider (scribe-fold Phase 1). When omitted, a behavior-
   * preserving `scribe-http` provider is built from `scribeUrl` / `scribeToken`
   * / `timeoutMs` / `fetchImpl` — reproducing exactly the former `callScribe`.
   * Phase 2+ (local-ASR backends, the cloud Workers-AI provider) inject one
   * here; the worker's queue/backoff/retry/transcript-note/retention logic is
   * unchanged regardless.
   */
  provider?: TranscriptionProvider;
  logger?: { info?: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export interface TranscriptionWorker {
  /** Stop the loop and wait for in-flight work to finish. */
  stop(): Promise<void>;
  /** Run one poll cycle now. Returns number of attachments processed. */
  tick(): Promise<number>;
  /**
   * Process a single attachment immediately. Called by the
   * `attachment:created` hook to short-circuit the sweep wait.
   *
   * Safe to race with `tick()` — an in-memory `inFlight` guard dedupes
   * same-attachment requests within this process. The handler returns
   * once processing finishes (or is skipped as a dup / backoff / non-
   * pending status). Errors are logged and swallowed so a thrown hook
   * handler never crashes the dispatcher.
   */
  kick(vault: string, attachment: Attachment): Promise<void>;
}

interface PendingMeta {
  transcribe_status?: string;
  transcribe_attempts?: number;
  transcribe_backoff_until?: string;
  transcribe_requested_at?: string;
  transcribe_error?: string;
  transcript?: string;
  transcribe_done_at?: string;
  /**
   * Marker stamped by the attachment-write code path (vault#353) when the
   * audio attachment was queued via the auto-transcribe pipeline (mime-type
   * matched `audio/*` AND `autoTranscribe.enabled === true`). When set to
   * `"auto"`, the worker materializes a `<attachment-path>.transcript.md`
   * note on terminal states (success OR failure) so the transcript surface
   * is uniform regardless of outcome. Absent or set to `"legacy"`, the
   * worker preserves the original stub-patching behavior (Lens flow).
   */
  transcribe_origin?: "auto" | "legacy";
  /**
   * Voice W2 (segmented recordings): a client-set 0-based index marking this
   * attachment as one segment of a longer recording sliced into ~10-min parts,
   * all linked on ONE note. When present, the legacy in-body path targets this
   * part's markers (`… (part N)._`, N = segment_index + 1) rather than the bare
   * ones — making per-part ordering structurally guaranteed. See `markersFor`.
   */
  segment_index?: number;
  [k: string]: unknown;
}

/**
 * Start the worker loop. Returns a handle with `stop()` + `tick()`.
 * Tests should build the worker and call `tick()` directly; production
 * calls `start()` implicitly by constructing the worker.
 */
export function startTranscriptionWorker(opts: TranscriptionWorkerOpts): TranscriptionWorker {
  const logger = opts.logger ?? console;
  const fetchImpl = opts.fetchImpl ?? fetch;
  // Precedence: opts.pollIntervalMs > TRANSCRIPTION_SWEEP_MS env > DEFAULT_POLL_MS.
  // Reading env here (not at module scope) means `~/.parachute/vault/.env`
  // values loaded by server.ts still apply, matching how SCRIBE_URL works.
  const envPoll = Number(process.env.TRANSCRIPTION_SWEEP_MS);
  const defaultPollMs = Number.isFinite(envPoll) && envPoll > 0 ? envPoll : DEFAULT_POLL_MS;
  const pollMs = opts.pollIntervalMs ?? defaultPollMs;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retentionFor = opts.getAudioRetention ?? (() => "keep" as const);

  // Resolve the transcription provider (scribe-fold Phase 1). Default: the
  // behavior-preserving `scribe-http` provider built from the same
  // scribeUrl/token/timeout/fetch the worker was already constructed with —
  // so existing installs transcribe byte-identically. Callers may inject a
  // different provider without touching any of the queue/retry logic below.
  const provider: TranscriptionProvider = opts.provider ?? new ScribeHttpProvider({
    url: opts.scribeUrl,
    token: opts.scribeToken,
    timeoutMs,
    fetchImpl,
  });

  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * In-process dedupe: holds attachment IDs currently being worked. The
   * event-driven `kick()` path can race the sweep on the same attachment
   * when an upload lands moments before a tick starts. Without this guard
   * both paths would fetch the audio and POST to scribe twice.
   */
  const inFlightAttachments = new Set<string>();

  /**
   * Apply a surgical note transform under optimistic concurrency (vault#435).
   *
   * The worker's marker/transcript writes are read-modify-write cycles
   * (`getNote` → transform → `updateNote`). Without a precondition, a user
   * edit landing between the read and the write is silently clobbered —
   * the same static-write/stale-read class as vault#208.
   *
   * `transform(note)` returns the surgical update to apply (`content` and/or
   * `metadata`), or `null` when the fresh state means there's nothing to do
   * (e.g. the stub was cleared, or the marker is already present — the
   * idempotency guards from #434 live inside the transform, so they re-run
   * against whatever we re-read). The transform MUST be pure w.r.t. the note
   * it's handed — it's invoked once per read, and re-invoked on the fresh
   * read after a conflict.
   *
   * Policy on conflict (worker = resilient, never crash the sweep):
   *   1. First write conflicts → re-read, re-run the transform against fresh
   *      content, write with the fresh precondition.
   *   2. Second write also conflicts → fall back to a precondition-less write
   *      ONLY when `safeWithoutPrecondition(freshNote)` says the transform is
   *      still safe against the latest content (e.g. the surgical-replace
   *      target is still present, or an append is always-safe). Otherwise
   *      skip + log — better to leave the note as the user last left it than
   *      to blind-overwrite a third concurrent edit.
   *
   * All errors are logged + swallowed: a note-write failure must not mask the
   * attachment-level result we already recorded, nor crash the sweep.
   */
  async function applyNoteTransformWithOC(
    store: Store,
    noteId: string,
    op: string,
    transform: (note: Note) => { content?: string; metadata?: Record<string, unknown> } | null,
    safeWithoutPrecondition: (note: Note) => boolean,
  ): Promise<void> {
    try {
      const note = await store.getNote(noteId);
      if (!note) return;
      const update = transform(note);
      if (update === null) return;

      try {
        await store.updateNote(note.id, {
          ...update,
          skipUpdatedAt: true,
          if_updated_at: note.updatedAt,
        });
        return;
      } catch (err: any) {
        if (!err || err.code !== "CONFLICT") throw err;
      }

      // Conflict — a user edit landed between read and write. Re-read,
      // re-apply the same surgical transform against the fresh content, and
      // write with the fresh precondition.
      const fresh = await store.getNote(noteId);
      if (!fresh) return;
      const reUpdate = transform(fresh);
      if (reUpdate === null) return;

      try {
        await store.updateNote(fresh.id, {
          ...reUpdate,
          skipUpdatedAt: true,
          if_updated_at: fresh.updatedAt,
        });
        return;
      } catch (err: any) {
        if (!err || err.code !== "CONFLICT") throw err;
      }

      // Double conflict (a third edit raced the retry). Last resort: apply
      // without a precondition ONLY if the transform is still safe against
      // the latest content. Otherwise skip — don't clobber the user.
      const latest = await store.getNote(noteId);
      if (!latest) return;
      if (!safeWithoutPrecondition(latest)) {
        logger.error(
          `[transcribe] ${op}: note ${noteId} kept changing under us (double conflict); skipping to avoid clobbering a concurrent edit`,
        );
        return;
      }
      const finalUpdate = transform(latest);
      if (finalUpdate === null) return;
      await store.updateNote(latest.id, {
        ...finalUpdate,
        skipUpdatedAt: true,
      });
    } catch (err) {
      logger.error(`[transcribe] ${op}: failed to apply to note ${noteId}:`, err);
    }
  }

  async function processOne(vault: string, attachment: Attachment): Promise<void> {
    // Dedupe: another path (sweep vs hook kick, or a duplicate dispatch)
    // is already working this attachment. Drop — its result is durable
    // in the DB, and the sweep will re-pick anything that truly needs it.
    if (inFlightAttachments.has(attachment.id)) return;
    inFlightAttachments.add(attachment.id);
    try {
      await processOneLocked(vault, attachment);
    } finally {
      inFlightAttachments.delete(attachment.id);
    }
  }

  /**
   * On a terminal failure (maxAttempts exhausted, or audio file missing),
   * record the "unavailable" marker on the note — otherwise the voice memo
   * sits reading "Transcript pending" forever. Only touches the note when
   * `transcribe_stub === true`, clears the stub marker, uses `skipUpdatedAt`
   * so the note's modification time still reflects user intent. Errors
   * are logged and swallowed so a note-write failure doesn't mask the
   * attachment failure we're trying to record.
   *
   * Body policy (finding F — never destroy content):
   *   - Pending marker PRESENT → surgical replace of the pending marker with
   *     the failure marker. The `![[memo]]` embed + any surrounding text
   *     survive. For a segmented attachment (`segment_index` set) this is the
   *     per-part `_Transcript pending (part N)._`; otherwise the bare marker.
   *   - Failure marker ALREADY PRESENT → no-op (idempotent; a double-terminal-
   *     failure must not stack markers).
   *   - Otherwise (pending marker absent — the user edited the note while it
   *     was pending) → APPEND `\n\n` + failure marker to the existing content.
   *     The old code full-replaced the body here, destroying the embed AND the
   *     user's edits. We append instead so nothing is lost. If the content is
   *     empty, the marker alone becomes the body (avoids a leading blank line).
   */
  async function applyFailureMarker(
    store: Store,
    noteId: string,
    segmentIndex: number | undefined,
  ): Promise<void> {
    // Bare markers by default; this segment's `(part N)` markers when the
    // attachment carries a `segment_index` (voice W2). String-search replace
    // targets the FIRST occurrence (a canonical body holds exactly one), and
    // the includes-guard below keeps a repeated terminal failure from stacking.
    const { pending, unavailable } = markersFor(segmentIndex);
    // OC-guarded (vault#435): the read-transform-write below is re-run against
    // fresh content on a conflict so a concurrent user edit isn't clobbered.
    // The transform is pure w.r.t. the note it's handed; the stub-set and
    // marker-already-present idempotency guards re-evaluate on the re-read.
    await applyNoteTransformWithOC(
      store,
      noteId,
      "apply-failure-marker",
      (note) => {
        const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
        if (noteMeta.transcribe_stub !== true) return null;

        let body: string;
        if (note.content.includes(pending)) {
          // Function replacer so the search string is treated literally and the
          // (fixed) failure marker is inserted verbatim.
          body = note.content.replace(pending, () => unavailable);
        } else if (note.content.includes(unavailable)) {
          // Marker already present — nothing to do. Clear the stub and
          // return without rewriting the body so we don't stack markers.
          body = note.content;
        } else {
          body = note.content.length > 0
            ? `${note.content}\n\n${unavailable}`
            : unavailable;
        }
        // Segmented: the stub is SHARED across this note's parts — keep it set
        // so sibling parts still resolve their own slots. Return content only
        // (leave note metadata untouched). Un-segmented: clear the one-shot
        // stub as before (byte-unchanged).
        if (segmentIndex !== undefined) return { content: body };
        const { transcribe_stub: _drop, ...restMeta } = noteMeta;
        return { content: body, metadata: restMeta };
      },
      // Last-resort (double-conflict) safety: only blind-write while the note
      // still carries the stub opt-in. If a racing edit cleared it, the user
      // opted out — skip rather than re-stamp the marker. The body transform
      // itself is non-destructive (surgical replace / no-op / append).
      (note) => ((note.metadata as Record<string, unknown> | undefined)?.transcribe_stub === true),
    );
  }

  /**
   * On a terminal failure for an attachment with `transcribe_origin: "auto"`,
   * write (or update) a `<attachment-path>.transcript.md` note with
   * `transcript_status: failed` so the user has a queryable record of the
   * failure and a target for the retry endpoint. Best-effort: any error
   * materializing the transcript note is logged, never propagated — the
   * attachment metadata write is the durable record of failure.
   */
  async function writeFailureTranscriptNote(
    store: Store,
    attachment: Attachment,
    errMsg: string,
    errorCode: string | undefined,
    durationMs: number | undefined,
  ): Promise<void> {
    try {
      await upsertTranscriptNote(store, {
        attachmentPath: attachment.path,
        attachmentId: attachment.id,
        attachmentNoteId: attachment.noteId,
        status: "failed",
        error: errorCode ? `${errorCode}: ${errMsg}` : errMsg,
        durationMs,
      });
    } catch (err) {
      logger.error(
        `[transcribe] failed to write failure transcript note for attachment ${attachment.id}:`,
        err,
      );
    }
  }

  async function processOneLocked(vault: string, attachment: Attachment): Promise<void> {
    const store = opts.getStore(vault);
    // Re-read metadata — the in-memory `attachment` may be stale (the hook
    // path hands us the row from just after insert; a concurrent completion
    // in another path may have already flipped status). Skip if not pending.
    const fresh = (await store.getAttachment(attachment.id)) ?? attachment;
    const meta: PendingMeta = { ...(fresh.metadata ?? {}) };
    if (meta.transcribe_status !== "pending") return;

    const attempts = (meta.transcribe_attempts as number | undefined) ?? 0;
    // Whether to materialize a transcript note (vault#353 auto-transcribe path)
    // vs. the legacy stub-patching path (Lens flow). Auto-write notes also
    // surface failures so the user can retry from the transcript note.
    const isAutoOrigin = meta.transcribe_origin === "auto";
    // Voice W2: when this attachment is one segment of a longer recording
    // (client-set `segment_index`), the legacy in-body path targets this
    // part's markers instead of the bare ones. Undefined for un-segmented
    // attachments — byte-unchanged behavior. Only the legacy path consults it;
    // the auto/transcript-note path is untouched (segments are a memo concern).
    const segmentIndex = segmentIndexOf(meta);

    // Honor backoff — we re-check here in case another tick queued this
    // attachment between the listing and now.
    if (meta.transcribe_backoff_until) {
      const until = Date.parse(String(meta.transcribe_backoff_until));
      if (Number.isFinite(until) && until > Date.now()) return;
    }

    const assetsRoot = opts.resolveAssetsDir(vault);
    const filePath = normalize(join(assetsRoot, attachment.path));
    if (!filePath.startsWith(normalize(assetsRoot)) || !existsSync(filePath)) {
      // Audio gone — nothing to transcribe. Mark failed so we don't loop.
      await store.setAttachmentMetadata(attachment.id, {
        ...meta,
        transcribe_status: "failed",
        transcribe_error: "audio file not found",
      });
      if (isAutoOrigin) {
        await writeFailureTranscriptNote(store, attachment, "audio file not found", undefined, undefined);
      } else {
        await applyFailureMarker(store, attachment.noteId, segmentIndex);
      }
      return;
    }

    // Fetch context predicates for this vault. Errors are logged inside
    // fetchContextEntries — we always have a payload (possibly empty) to
    // pass through, so a bad predicate doesn't block transcription.
    let context: ContextPayload | null = null;
    const predicates = opts.getContextPredicates?.(vault);
    if (predicates && predicates.length) {
      context = await fetchContextEntries(store, predicates, logger);
    }

    let scribeResult: { text: string; durationMs: number };
    try {
      // Read the audio + call the provider inside this try so a read failure
      // (a race deleting the file between existsSync and read) is handled the
      // same way as a transcription failure — as a retriable error — exactly
      // as the former `callScribe` (which read the file internally) did. The
      // worker owns the wall-clock timing (`durationMs`); the provider owns
      // only the audio→text step.
      const audio = readFileSync(filePath);
      const startedAt = Date.now();
      const result = await provider.transcribe({
        audio,
        filename: attachment.path.split("/").pop() ?? "audio",
        mimeType: attachment.mimeType,
        context,
      });
      scribeResult = { text: result.text, durationMs: Date.now() - startedAt };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const apiErr = err instanceof TranscriptionError ? err : null;
      // A non-retriable provider error (a 4xx the operator must fix — no
      // provider configured, bad auth) is terminal immediately. Re-POSTing the
      // same audio would keep failing; retries don't help. This is the
      // "graceful first-boot path" from design Q5.
      const nonRetriable = apiErr !== null && !apiErr.retriable;
      const nextAttempts = attempts + 1;
      const terminal = nonRetriable || nextAttempts >= maxAttempts;

      if (terminal) {
        if (nonRetriable) {
          logger.error(`[transcribe] non-retriable provider error on attachment ${attachment.id} (status ${apiErr!.httpStatus ?? "n/a"}${apiErr!.code ? `, ${apiErr!.code}` : ""}):`, errMsg);
        } else {
          logger.error(`[transcribe] giving up on attachment ${attachment.id} after ${nextAttempts} attempts:`, errMsg);
        }
        await store.setAttachmentMetadata(attachment.id, {
          ...meta,
          transcribe_status: "failed",
          transcribe_attempts: nextAttempts,
          transcribe_error: errMsg,
          ...(apiErr?.code ? { transcribe_error_code: apiErr.code } : {}),
        });
        if (isAutoOrigin) {
          await writeFailureTranscriptNote(store, attachment, errMsg, apiErr?.code, undefined);
        } else {
          await applyFailureMarker(store, attachment.noteId, segmentIndex);
        }
        // retention=never drops the audio on any terminal state, including
        // failure. The user opted in to "I don't want the audio kept around
        // regardless of outcome" — honor it.
        if (retentionFor(vault) === "never") {
          unlinkIfSafe(filePath, assetsRoot, logger);
        }
        return;
      }
      // Exponential backoff: 30s, 2m, 8m, ...
      const backoffMs = 30_000 * Math.pow(4, nextAttempts - 1);
      const backoffUntil = new Date(Date.now() + backoffMs).toISOString();
      logger.error(`[transcribe] attachment ${attachment.id} attempt ${nextAttempts} failed; retrying at ${backoffUntil}:`, errMsg);
      await store.setAttachmentMetadata(attachment.id, {
        ...meta,
        transcribe_status: "pending",
        transcribe_attempts: nextAttempts,
        transcribe_backoff_until: backoffUntil,
        transcribe_error: errMsg,
      });
      return;
    }

    const { text: transcript, durationMs } = scribeResult;

    // Auto-origin success: materialize the transcript note (vault#353). The
    // note's path is `<attachment-path>.transcript.md`, its frontmatter links
    // back to the audio attachment via `transcript_of`.
    if (isAutoOrigin) {
      try {
        await upsertTranscriptNote(store, {
          attachmentPath: attachment.path,
          attachmentId: attachment.id,
          attachmentNoteId: attachment.noteId,
          status: "complete",
          text: transcript,
          durationMs,
        });
      } catch (err) {
        // Note write failure doesn't invalidate the transcript — it's still
        // stored on the attachment row below. Log + continue so retention
        // still applies and the attachment row reflects success.
        logger.error(`[transcribe] failed to write transcript note for attachment ${attachment.id}:`, err);
      }
    } else {
      // Legacy stub-patching path (voice memo flow). Only acts when the note
      // still carries the `transcribe_stub` opt-in — a user edit clearing it
      // before the transcript arrives opts out of the overwrite. OC-guarded
      // (vault#435): re-applied against fresh content on a conflict so a
      // concurrent user edit isn't clobbered.
      //
      // Success replaces whichever of THIS part's markers is present (bare, or
      // `(part N)` when segmented). Built with no `/g` flag so `.replace`
      // swaps only the FIRST match — a canonical capture body holds exactly
      // one marker per part; alternation preserves positional-first semantics
      // (a retried success replaces the failure marker where a first-try
      // success replaced the pending one) so byte-for-byte matching today's
      // un-segmented behavior.
      const { pending, unavailable } = markersFor(segmentIndex);
      const successTarget = new RegExp(`${escapeRegExp(pending)}|${escapeRegExp(unavailable)}`);
      await applyNoteTransformWithOC(
        store,
        attachment.noteId,
        "apply-transcript",
        (note) => {
          const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
          if (noteMeta.transcribe_stub !== true) return null;
          // Body policy (finding F — never destroy content):
          //   - pending OR failure marker present → surgical replace in place.
          //     The embed + surrounding capture body survive.
          //   - neither present (user edited the note while pending) → APPEND
          //     the transcript instead of full-replacing the body, so the
          //     user's edits + the `![[memo]]` embed are preserved. The old
          //     code full-replaced here, which destroyed both.
          let body: string;
          if (successTarget.test(note.content)) {
            // Function replacer, NOT a string — speech-to-text is arbitrary
            // user content, and String.replace treats `$&`, `$\``, `$'`,
            // `$1`-`$9` as special patterns in a string replacement. A
            // transcript containing `$&` would otherwise inject the matched
            // marker text into the body. `() => transcript` returns the text
            // verbatim.
            body = note.content.replace(successTarget, () => transcript);
          } else {
            body = note.content.length > 0
              ? `${note.content}\n\n${transcript}`
              : transcript;
          }
          // Segmented: the stub is SHARED across this note's parts — keep it
          // set so sibling parts still resolve their own slots. Return content
          // only (leave note metadata untouched). Un-segmented: clear the
          // one-shot stub as before (byte-unchanged).
          if (segmentIndex !== undefined) return { content: body };
          const { transcribe_stub: _drop, ...restMeta } = noteMeta;
          return { content: body, metadata: restMeta };
        },
        // Last-resort (double-conflict) safety: only blind-write while the
        // stub opt-in survives. A racing edit that cleared it opts out.
        (note) => ((note.metadata as Record<string, unknown> | undefined)?.transcribe_stub === true),
      );
    }

    // Always record the transcript on the attachment, even if the note
    // already moved on — the transcript is otherwise discarded.
    const doneMeta: PendingMeta = {
      ...meta,
      transcribe_status: "done",
      transcribe_attempts: attempts + 1,
      transcribe_done_at: new Date().toISOString(),
      transcribe_duration_ms: durationMs,
      transcript,
    };
    delete doneMeta.transcribe_backoff_until;
    delete doneMeta.transcribe_error;
    delete doneMeta.transcribe_error_code;
    await store.setAttachmentMetadata(attachment.id, doneMeta);

    // Retention: drop the file but keep the row so the transcript stays
    // addressable. "until_transcribed" and "never" both unlink on success.
    const retention = retentionFor(vault);
    if (retention === "until_transcribed" || retention === "never") {
      unlinkIfSafe(filePath, assetsRoot, logger);
    }
  }

  function unlinkIfSafe(
    filePath: string,
    assetsRoot: string,
    logger: { error: (...args: unknown[]) => void },
  ): void {
    try {
      if (filePath.startsWith(normalize(assetsRoot)) && existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch (err) {
      logger.error(`[transcribe] retention unlink failed for ${filePath}:`, err);
    }
  }

  async function tick(): Promise<number> {
    let processed = 0;
    for (const vault of opts.vaultList()) {
      const store = opts.getStore(vault);
      let pending: Attachment[];
      try {
        pending = await store.listAttachmentsByTranscribeStatus("pending", 50);
      } catch (err) {
        logger.error(`[transcribe] list failed for vault "${vault}":`, err);
        continue;
      }

      for (const attachment of pending) {
        if (stopped) return processed;
        // Backoff gate — skip without touching.
        const meta = (attachment.metadata as PendingMeta | undefined) ?? {};
        if (meta.transcribe_backoff_until) {
          const until = Date.parse(String(meta.transcribe_backoff_until));
          if (Number.isFinite(until) && until > Date.now()) continue;
        }
        try {
          await processOne(vault, attachment);
          processed++;
        } catch (err) {
          logger.error(`[transcribe] unexpected error on attachment ${attachment.id}:`, err);
        }
      }
    }
    return processed;
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      inflight = tick().catch((err) => {
        logger.error("[transcribe] tick error:", err);
      }).then(() => {
        schedule();
      });
    }, pollMs);
  }

  schedule();

  async function kick(vault: string, attachment: Attachment): Promise<void> {
    if (stopped) return;
    try {
      await processOne(vault, attachment);
    } catch (err) {
      logger.error(`[transcribe] kick error on attachment ${attachment.id}:`, err);
    }
  }

  return {
    async stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      await inflight;
    },
    tick,
    kick,
  };
}

/**
 * Wire the transcription worker up as an `attachment:created` hook. This
 * is the event-driven fast path — when a new attachment is inserted with
 * `transcribe_status = "pending"`, the hook fires within a microtask and
 * the worker begins processing without waiting for the next sweep.
 *
 * `resolveVault(store)` maps the store handle delivered to the hook back
 * to its vault name (needed so the worker can resolve the assets dir,
 * retention policy, and context predicates). Returns an unregister
 * function so tests can tear down cleanly.
 */
export function registerTranscriptionHook(
  registry: HookRegistry,
  worker: TranscriptionWorker,
  resolveVault: (store: Store) => string | undefined,
  logger: { error: (...args: unknown[]) => void } = console,
): () => void {
  return registry.onAttachment({
    name: "transcription-kickoff",
    event: "created",
    when: (att) => {
      // Only "created" payloads reach this predicate (we don't subscribe
      // to "deleted"), so `metadata` is populated. The union widening
      // post-deletion-events just means we narrow here defensively.
      const meta = (att as Attachment).metadata as { transcribe_status?: string } | undefined;
      return meta?.transcribe_status === "pending";
    },
    handler: async (payload, store) => {
      const attachment = payload as Attachment;
      const vault = resolveVault(store);
      if (!vault) {
        logger.error(
          `[transcribe] could not resolve vault for attachment ${attachment.id}; sweep will pick it up`,
        );
        return;
      }
      await worker.kick(vault, attachment);
    },
  });
}

/**
 * Re-export the structured provider error so tests + callers can
 * `instanceof`-check for terminal-failure semantics. The scribe HTTP call
 * itself now lives in `src/transcription/providers/scribe-http.ts` behind the
 * `TranscriptionProvider` seam (scribe-fold Phase 1).
 */
export { TranscriptionError };
