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
import type { Store, Attachment } from "../core/src/types.ts";
import type { HookRegistry } from "../core/src/hooks.ts";
import { appendContextPart, fetchContextEntries, type ContextPayload } from "./context.ts";
import type { TriggerIncludeContext } from "./config.ts";
import { upsertTranscriptNote } from "./transcript-note.ts";

/** Placeholder pattern written by the voice-memo capture stub. */
const TRANSCRIPT_PLACEHOLDER = /_Transcript pending\._/;

/**
 * Body written when transcription reaches a terminal failure (maxAttempts
 * exhausted, or the audio file is missing). This used to be written by
 * Lens's now-removed scribe client; owning it here means a failed upload
 * stops reading "Transcript pending" forever regardless of which client
 * uploaded the audio.
 *
 * NOTE: the notes-ui status chip (parachute-surface TranscriptionStatus.tsx)
 * keys off this exact string, so don't change the copy without a coordinated
 * change there. A friendlier "retry available" copy + chip affordance is a
 * tracked parachute-surface follow-up.
 */
const TRANSCRIPT_UNAVAILABLE = "_Transcription unavailable._";

/**
 * On a successful (re)transcription of a legacy in-body memo, the transcript
 * replaces whichever marker is currently in the body — the original
 * `_Transcript pending._` on a first-try success, OR `_Transcription
 * unavailable._` if a prior attempt failed and we're now retrying. Matching
 * both means a retried success lands in the same spot a first-try success
 * would, preserving the surrounding capture body (the `![[memo]]` embed,
 * the `_Recorded …_` line, the header).
 */
const TRANSCRIPT_SUCCESS_TARGET = /_Transcript pending\._|_Transcription unavailable\._/;

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
  /** Scribe base URL (no trailing slash). */
  scribeUrl: string;
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
  [k: string]: unknown;
}

/**
 * Structured error thrown when scribe returns a 4xx with a recognized
 * `error_code` — we surface the code on the transcript note's frontmatter
 * so callers can branch on stable strings instead of regex-matching message
 * text. Today the canonical code is `missing_provider` (scribe#47).
 */
class ScribeApiError extends Error {
  readonly errorCode?: string;
  readonly httpStatus: number;
  readonly retriable: boolean;
  constructor(message: string, opts: { errorCode?: string; httpStatus: number; retriable: boolean }) {
    super(message);
    this.name = "ScribeApiError";
    this.errorCode = opts.errorCode;
    this.httpStatus = opts.httpStatus;
    this.retriable = opts.retriable;
  }
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
   *   - Placeholder PRESENT → surgical replace of `_Transcript pending._`
   *     with the marker. The `![[memo]]` embed + any surrounding text survive.
   *   - Marker ALREADY PRESENT → no-op (idempotent; a double-terminal-failure
   *     must not stack markers).
   *   - Otherwise (placeholder absent — the user edited the note while it was
   *     pending) → APPEND `\n\n` + marker to the existing content. The old
   *     code full-replaced the body here, destroying the embed AND the user's
   *     edits. We append instead so nothing is lost. If the content is empty,
   *     the marker alone becomes the body (avoids a leading blank line).
   */
  async function applyFailureMarker(store: Store, noteId: string): Promise<void> {
    const note = await store.getNote(noteId);
    if (!note) return;
    const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
    if (noteMeta.transcribe_stub !== true) return;

    let body: string;
    if (TRANSCRIPT_PLACEHOLDER.test(note.content)) {
      body = note.content.replace(TRANSCRIPT_PLACEHOLDER, TRANSCRIPT_UNAVAILABLE);
    } else if (note.content.includes(TRANSCRIPT_UNAVAILABLE)) {
      // Marker already present — nothing to do. Clear the stub (below) and
      // return without rewriting the body so we don't stack markers.
      body = note.content;
    } else {
      body = note.content.length > 0
        ? `${note.content}\n\n${TRANSCRIPT_UNAVAILABLE}`
        : TRANSCRIPT_UNAVAILABLE;
    }
    const { transcribe_stub: _drop, ...restMeta } = noteMeta;
    try {
      await store.updateNote(note.id, {
        content: body,
        metadata: restMeta,
        skipUpdatedAt: true,
      });
    } catch (err) {
      logger.error(`[transcribe] failed to apply failure marker to note ${note.id}:`, err);
    }
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
        await applyFailureMarker(store, attachment.noteId);
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
      scribeResult = await callScribe({
        url: opts.scribeUrl,
        token: opts.scribeToken,
        filePath,
        filename: attachment.path.split("/").pop() ?? "audio",
        mimeType: attachment.mimeType,
        context,
        timeoutMs,
        fetchImpl,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const apiErr = err instanceof ScribeApiError ? err : null;
      // 4xx with structured error code → terminal immediately. Re-POSTing the
      // same audio at a scribe with no provider configured (or that rejects
      // our bearer) will keep failing — the operator has to act, retries don't
      // help. This is the "graceful first-boot path" from design Q5.
      const nonRetriable = apiErr !== null && !apiErr.retriable;
      const nextAttempts = attempts + 1;
      const terminal = nonRetriable || nextAttempts >= maxAttempts;

      if (terminal) {
        if (nonRetriable) {
          logger.error(`[transcribe] non-retriable scribe error on attachment ${attachment.id} (status ${apiErr!.httpStatus}${apiErr!.errorCode ? `, ${apiErr!.errorCode}` : ""}):`, errMsg);
        } else {
          logger.error(`[transcribe] giving up on attachment ${attachment.id} after ${nextAttempts} attempts:`, errMsg);
        }
        await store.setAttachmentMetadata(attachment.id, {
          ...meta,
          transcribe_status: "failed",
          transcribe_attempts: nextAttempts,
          transcribe_error: errMsg,
          ...(apiErr?.errorCode ? { transcribe_error_code: apiErr.errorCode } : {}),
        });
        if (isAutoOrigin) {
          await writeFailureTranscriptNote(store, attachment, errMsg, apiErr?.errorCode, undefined);
        } else {
          await applyFailureMarker(store, attachment.noteId);
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
      // before the transcript arrives opts out of the overwrite.
      const note = await store.getNote(attachment.noteId);
      if (note) {
        const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
        if (noteMeta.transcribe_stub === true) {
          // Body policy (finding F — never destroy content):
          //   - placeholder OR failure-marker present → surgical replace in
          //     place (a retried success replaces the `_Transcription
          //     unavailable._` marker, landing exactly where a first-try
          //     success would). The embed + surrounding capture body survive.
          //   - neither present (user edited the note while pending) → APPEND
          //     the transcript instead of full-replacing the body, so the
          //     user's edits + the `![[memo]]` embed are preserved. The old
          //     code full-replaced here, which destroyed both.
          let body: string;
          if (TRANSCRIPT_SUCCESS_TARGET.test(note.content)) {
            body = note.content.replace(TRANSCRIPT_SUCCESS_TARGET, transcript);
          } else {
            body = note.content.length > 0
              ? `${note.content}\n\n${transcript}`
              : transcript;
          }
          const { transcribe_stub: _drop, ...restMeta } = noteMeta;
          try {
            await store.updateNote(note.id, {
              content: body,
              metadata: restMeta,
              skipUpdatedAt: true,
            });
          } catch (err) {
            logger.error(`[transcribe] failed to apply transcript to note ${note.id}:`, err);
          }
        }
      }
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
 * Call scribe's `POST /v1/audio/transcriptions` with the audio file + optional
 * context part. Returns the transcript text plus the wall-clock duration of
 * the request, so the worker can surface `transcript_duration_ms` on the
 * transcript note.
 *
 * Failure modes (encoded as throws):
 *   - 4xx with a JSON body carrying `error_code`: throws `ScribeApiError`
 *     with the code (`missing_provider` etc.). Treated as a non-retriable
 *     terminal failure — re-POSTing the same audio at the same broken scribe
 *     would just fail the same way; the operator has to act.
 *   - 4xx without `error_code` (auth, malformed multipart): throws
 *     `ScribeApiError` with the body text. Non-retriable.
 *   - 5xx, network error, or timeout: throws a plain `Error`. Retriable —
 *     the worker's backoff path picks it up.
 *   - 200 with missing/invalid `text` field: throws a plain `Error`.
 *     Retriable (could be a transient provider-output glitch).
 */
async function callScribe(args: {
  url: string;
  token?: string;
  filePath: string;
  filename: string;
  mimeType: string;
  context: ContextPayload | null;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<{ text: string; durationMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const startedAt = Date.now();
  try {
    const fileBuffer = readFileSync(args.filePath);
    const file = new File([fileBuffer], args.filename, { type: args.mimeType });
    const form = new FormData();
    form.append("file", file);
    if (args.context) appendContextPart(form, args.context);

    const endpoint = `${args.url.replace(/\/$/, "")}/v1/audio/transcriptions`;
    const headers: Record<string, string> = {};
    if (args.token) headers["Authorization"] = `Bearer ${args.token}`;

    const resp = await args.fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      // Try to extract structured error_code from JSON body (scribe#47).
      let errorCode: string | undefined;
      let errorMessage: string | undefined;
      try {
        const parsed = JSON.parse(body) as { error?: string; error_code?: string; message?: string };
        if (typeof parsed.error_code === "string") errorCode = parsed.error_code;
        if (typeof parsed.error === "string") errorMessage = parsed.error;
        else if (typeof parsed.message === "string") errorMessage = parsed.message;
      } catch {
        // Not JSON — leave errorCode undefined; the raw body becomes the message.
      }
      // 4xx is terminal (re-POSTing the same audio at the same broken scribe
      // will just fail again). 5xx is retriable — provider hiccup, will likely
      // succeed on backoff.
      const retriable = resp.status >= 500;
      const message = errorMessage
        ?? (errorCode ? `scribe ${errorCode}` : `scribe returned ${resp.status}: ${body}`);
      throw new ScribeApiError(message, {
        errorCode,
        httpStatus: resp.status,
        retriable,
      });
    }
    const result = await resp.json() as { text?: string };
    if (typeof result.text !== "string") {
      throw new Error("scribe response missing text field");
    }
    return { text: result.text, durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-export the structured error type so tests + callers can `instanceof`-check
 * for terminal-failure semantics.
 */
export { ScribeApiError };
