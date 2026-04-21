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
 *      `_Transcript pending._` placeholder with the transcript, or the
 *      whole note body if the placeholder is absent. Clear the stub marker.
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

/** Placeholder pattern written by Lens's voice-memo stub. */
const TRANSCRIPT_PLACEHOLDER = /_Transcript pending\._/;

/**
 * Body written when transcription reaches a terminal failure (maxAttempts
 * exhausted, or the audio file is missing). This used to be written by
 * Lens's now-removed scribe client; owning it here means a failed upload
 * stops reading "Transcript pending" forever regardless of which client
 * uploaded the audio.
 */
const TRANSCRIPT_UNAVAILABLE = "_Transcription unavailable._";

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
   * swap the stub placeholder for the "unavailable" marker — otherwise
   * Lens's voice memo sits reading "Transcript pending" forever. Mirrors
   * the success-path note write in shape: only touches the note when
   * `transcribe_stub === true`, clears the stub marker, uses `skipUpdatedAt`
   * so the note's modification time still reflects user intent. Errors
   * are logged and swallowed so a note-write failure doesn't mask the
   * attachment failure we're trying to record.
   */
  async function applyFailureMarker(store: Store, noteId: string): Promise<void> {
    const note = await store.getNote(noteId);
    if (!note) return;
    const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
    if (noteMeta.transcribe_stub !== true) return;

    const body = TRANSCRIPT_PLACEHOLDER.test(note.content)
      ? note.content.replace(TRANSCRIPT_PLACEHOLDER, TRANSCRIPT_UNAVAILABLE)
      : TRANSCRIPT_UNAVAILABLE;
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

  async function processOneLocked(vault: string, attachment: Attachment): Promise<void> {
    const store = opts.getStore(vault);
    // Re-read metadata — the in-memory `attachment` may be stale (the hook
    // path hands us the row from just after insert; a concurrent completion
    // in another path may have already flipped status). Skip if not pending.
    const fresh = (await store.getAttachment(attachment.id)) ?? attachment;
    const meta: PendingMeta = { ...(fresh.metadata ?? {}) };
    if (meta.transcribe_status !== "pending") return;

    const attempts = (meta.transcribe_attempts as number | undefined) ?? 0;

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
      await applyFailureMarker(store, attachment.noteId);
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

    let transcript: string;
    try {
      transcript = await callScribe({
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
      const nextAttempts = attempts + 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (nextAttempts >= maxAttempts) {
        logger.error(`[transcribe] giving up on attachment ${attachment.id} after ${nextAttempts} attempts:`, errMsg);
        await store.setAttachmentMetadata(attachment.id, {
          ...meta,
          transcribe_status: "failed",
          transcribe_attempts: nextAttempts,
          transcribe_error: errMsg,
        });
        await applyFailureMarker(store, attachment.noteId);
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

    // Success. Apply to note if the caller still wants us to.
    const note = await store.getNote(attachment.noteId);
    if (note) {
      const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
      if (noteMeta.transcribe_stub === true) {
        const body = TRANSCRIPT_PLACEHOLDER.test(note.content)
          ? note.content.replace(TRANSCRIPT_PLACEHOLDER, transcript)
          : transcript;
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

    // Always record the transcript on the attachment, even if the note
    // already moved on — the transcript is otherwise discarded.
    const doneMeta: PendingMeta = {
      ...meta,
      transcribe_status: "done",
      transcribe_attempts: attempts + 1,
      transcribe_done_at: new Date().toISOString(),
      transcript,
    };
    delete doneMeta.transcribe_backoff_until;
    delete doneMeta.transcribe_error;
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
    when: (att) =>
      (att.metadata as { transcribe_status?: string } | undefined)
        ?.transcribe_status === "pending",
    handler: async (attachment, store) => {
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

async function callScribe(args: {
  url: string;
  token?: string;
  filePath: string;
  filename: string;
  mimeType: string;
  context: ContextPayload | null;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
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
      throw new Error(`scribe returned ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    const result = await resp.json() as { text?: string };
    if (typeof result.text !== "string") {
      throw new Error("scribe response missing text field");
    }
    return result.text;
  } finally {
    clearTimeout(timer);
  }
}
