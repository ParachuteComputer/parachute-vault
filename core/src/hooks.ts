/**
 * Async note-mutation hook infrastructure (#37).
 *
 * Lightweight in-process pub/sub over note mutations. Features register
 * handlers via `HookRegistry.onNote` at startup; the store fires them
 * after each mutation commits, out-of-band, capped by HOOK_CONCURRENCY.
 *
 * Design notes:
 * - In-process only. No external queue, no DB table. If the process
 *   crashes mid-handler, the work is dropped — reconciliation is the
 *   responsibility of the predicate (idempotency markers in metadata).
 * - Dispatch is strictly post-commit. The store calls `dispatch()` only
 *   after the SQLite write has returned, so handlers can safely read
 *   and update the same note without deadlocking the transaction.
 * - Concurrency cap is global across all hooks (a bulk import should
 *   not be able to spawn 1000 parallel TTS jobs). Configured via
 *   HOOK_CONCURRENCY env var (default 2).
 * - Failures are logged, not retried. Retries happen naturally on the
 *   next mutation when the predicate still matches (i.e. the marker
 *   wasn't written because the handler failed).
 * - The API matches the proposal in the issue. Predicates are sync
 *   functions on the note; handlers are async and receive the note
 *   plus a `Store`-like interface so they can read/update/attach.
 *
 * ## Sharp edges for handler authors
 *
 * **1. Write your idempotency marker BEFORE any slow async work.**
 * The predicate is re-evaluated on every dispatch. If your handler
 * awaits a 30-second TTS call before writing the marker, a concurrent
 * update to the same note during those 30 seconds will re-match the
 * predicate and start a second handler run. The semaphore is global,
 * not per-note, so it won't save you. Write the marker synchronously
 * at the top of the handler, or — if the marker has to wait until
 * the work actually succeeds — accept that duplicate runs are possible
 * and make the handler idempotent in some other way.
 *
 * **2. No per-note serialization.** Two different hooks whose
 * predicates match the same note run concurrently (up to the global
 * cap). Last write wins if both touch the same fields.
 *
 * **3. Shutdown drain is a hard cut.** `drain()` on SIGINT/SIGTERM
 * waits for in-flight handlers, but the server wraps it in a 5-second
 * Promise.race. Long-running handlers (webhook triggers) may
 * get killed mid-run. Handlers must not write the marker before the
 * work is durably committed, so restart reconciliation works.
 */

import type { Note, Store, Attachment } from "./types.js";

/**
 * Note-mutation events. `"created"` and `"updated"` carry the full post-write
 * `Note`; `"deleted"` carries only `{ id, path }` — the row is gone by
 * dispatch time, so handlers can't re-read it. Down-stream consumers (e.g.
 * the git-mirror) match by id/path and react (remove file, etc.). Predicate
 * authors writing a `when(note)` for `"deleted"` should rely on `note.id` /
 * `note.path` only; everything else is undefined for the deleted shape.
 */
export type HookEvent = "created" | "updated" | "deleted";

/**
 * Minimal identity payload for a deleted note. The row is gone by dispatch
 * time, so handlers can't go back to the store for the rest. Path is
 * optional because notes without a path are legal (e.g. fragments captured
 * via API without a target slot).
 */
export interface DeletedNoteRef {
  id: string;
  path?: string;
}

/**
 * What a hook handler receives. For `"created"` / `"updated"` it's the full
 * `Note` row; for `"deleted"` only the id/path remain. This union keeps the
 * common predicates (path-prefix gates, tag checks for non-deleted shapes)
 * working unchanged while making the "deleted has less" reality type-safe.
 */
export type NoteHookPayload = Note | DeletedNoteRef;

export interface NoteHook {
  /** Events this hook listens for. Defaults to ["created", "updated"]. */
  event?: HookEvent | HookEvent[];
  /**
   * Predicate — return true to run the handler for this note.
   * Should be cheap and synchronous. Idempotency lives here: check
   * whether a marker (e.g. `metadata.audio_rendered_at`) is already set
   * and return false if so.
   *
   * For `"deleted"` events the payload is a `DeletedNoteRef` — only
   * `id` / `path` are populated; tag/metadata/content fields are
   * undefined. Predicates that read those fields effectively skip
   * the deleted shape unless they handle the narrower payload.
   */
  when?: (note: NoteHookPayload) => boolean;
  /**
   * Handler — runs async, off the request path. Third arg is the event
   * type. For `"deleted"` the payload is a `DeletedNoteRef`, not a full
   * `Note` — the row is gone by dispatch time, so the store can't be
   * queried for it. Handlers needing more context should stash it ahead
   * of time on the note's `metadata` and read off the predicate / the
   * tracking shape rather than re-querying.
   */
  handler: (
    note: NoteHookPayload,
    store: Store,
    event?: HookEvent,
  ) => Promise<void> | void;
  /** Optional label for logs. */
  name?: string;
}

interface RegisteredHook extends NoteHook {
  events: Set<HookEvent>;
}

/**
 * Attachment-mutation events. `"created"` carries the full attachment;
 * `"deleted"` carries only `{ id, note_id, path }` (the row is gone by
 * dispatch time, same shape rule as deleted notes).
 *
 * Consumers (transcription worker, git-mirror) subscribe here to react to
 * lifecycle changes without polling. Keeping attachments separate from
 * notes means a `NoteHook` predicate doesn't have to learn a second
 * argument shape.
 */
export type AttachmentHookEvent = "created" | "deleted";

/**
 * Identity payload for a deleted attachment. The DB row is gone by
 * dispatch time, so handlers can only react to id/note_id/path; metadata
 * and timestamps are not preserved.
 */
export interface DeletedAttachmentRef {
  id: string;
  noteId: string;
  path: string;
}

/** Union over what an attachment hook handler may receive. */
export type AttachmentHookPayload = Attachment | DeletedAttachmentRef;

export interface AttachmentHook {
  /** Events this hook listens for. Defaults to ["created"]. */
  event?: AttachmentHookEvent | AttachmentHookEvent[];
  /**
   * Sync predicate. Same idempotency contract as `NoteHook.when`. For
   * `"deleted"` the payload is a `DeletedAttachmentRef` — predicates
   * relying on `metadata` / `createdAt` will see `undefined`.
   */
  when?: (attachment: AttachmentHookPayload) => boolean;
  /**
   * Handler — runs async, off the request path. For `"deleted"` the
   * payload is a `DeletedAttachmentRef`, not a full `Attachment`.
   */
  handler: (
    attachment: AttachmentHookPayload,
    store: Store,
    event?: AttachmentHookEvent,
  ) => Promise<void> | void;
  /** Optional label for logs. */
  name?: string;
}

interface RegisteredAttachmentHook extends AttachmentHook {
  events: Set<AttachmentHookEvent>;
}

/**
 * Tag-mutation events. `"upserted"` fires on tag-record create/update
 * (description, fields, relationships, parent_names — any mutation that
 * could change the schema sidecar that the git-mirror writes). `"deleted"`
 * fires when the tag row is removed.
 *
 * Why this exists: the export sidecars at `.parachute/schemas/<tag>.yaml`
 * are part of the mirror's output. Without a tag-mutation event the mirror
 * has no signal that those files might need to change.
 */
export type TagHookEvent = "upserted" | "deleted";

export interface TagHook {
  /** Events this hook listens for. Defaults to ["upserted", "deleted"]. */
  event?: TagHookEvent | TagHookEvent[];
  /** Sync predicate keyed on the tag name. */
  when?: (tag: string) => boolean;
  /** Handler — runs async, off the request path. */
  handler: (
    tag: string,
    store: Store,
    event?: TagHookEvent,
  ) => Promise<void> | void;
  /** Optional label for logs. */
  name?: string;
}

interface RegisteredTagHook extends TagHook {
  events: Set<TagHookEvent>;
}

/**
 * Tiny async semaphore — FIFO waiters, no dependencies.
 * Used to cap concurrent handler execution across all hooks.
 */
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = Math.max(1, capacity);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.available--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export interface HookRegistryOptions {
  /** Concurrency cap for handler execution. Defaults to HOOK_CONCURRENCY env var, then 2. */
  concurrency?: number;
  /** Logger. Defaults to console. */
  logger?: { error: (...args: unknown[]) => void };
}

export class HookRegistry {
  private hooks: RegisteredHook[] = [];
  private attachmentHooks: RegisteredAttachmentHook[] = [];
  private tagHooks: RegisteredTagHook[] = [];
  private semaphore: Semaphore;
  private inFlight = new Set<Promise<void>>();
  private logger: { error: (...args: unknown[]) => void };

  constructor(opts: HookRegistryOptions = {}) {
    const envCap = Number.parseInt(process.env.HOOK_CONCURRENCY ?? "", 10);
    const capacity = opts.concurrency ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : 2);
    this.semaphore = new Semaphore(capacity);
    this.logger = opts.logger ?? console;
  }

  /**
   * Register a note-mutation hook. Returns an unregister function.
   *
   * The default event set is `["created", "updated"]` — explicit
   * `event: "deleted"` (or include it in the array) is required to
   * subscribe to deletions. This keeps existing hooks that pre-date the
   * `"deleted"` event from suddenly receiving a payload shape
   * (`DeletedNoteRef`) they weren't typed for.
   */
  onNote(hook: NoteHook): () => void {
    const events = new Set<HookEvent>(
      Array.isArray(hook.event)
        ? hook.event
        : hook.event
          ? [hook.event]
          : (["created", "updated"] as HookEvent[]),
    );
    const entry: RegisteredHook = { ...hook, events };
    this.hooks.push(entry);
    return () => {
      const idx = this.hooks.indexOf(entry);
      if (idx >= 0) this.hooks.splice(idx, 1);
    };
  }

  /**
   * Register an attachment-mutation hook. Returns an unregister function.
   *
   * The default event set is `["created"]` only (matches the historical
   * shape pre-deletion-events). Subscribe to `"deleted"` explicitly when
   * the handler needs to react to attachment removal.
   */
  onAttachment(hook: AttachmentHook): () => void {
    const events = new Set<AttachmentHookEvent>(
      Array.isArray(hook.event)
        ? hook.event
        : hook.event
          ? [hook.event]
          : (["created"] as AttachmentHookEvent[]),
    );
    const entry: RegisteredAttachmentHook = { ...hook, events };
    this.attachmentHooks.push(entry);
    return () => {
      const idx = this.attachmentHooks.indexOf(entry);
      if (idx >= 0) this.attachmentHooks.splice(idx, 1);
    };
  }

  /**
   * Register a tag-mutation hook. Returns an unregister function. Default
   * event set is both `"upserted"` and `"deleted"` — symmetric with the
   * sole consumer's needs (the git-mirror reacts to either to refresh its
   * schema sidecars).
   */
  onTag(hook: TagHook): () => void {
    const events = new Set<TagHookEvent>(
      Array.isArray(hook.event)
        ? hook.event
        : hook.event
          ? [hook.event]
          : (["upserted", "deleted"] as TagHookEvent[]),
    );
    const entry: RegisteredTagHook = { ...hook, events };
    this.tagHooks.push(entry);
    return () => {
      const idx = this.tagHooks.indexOf(entry);
      if (idx >= 0) this.tagHooks.splice(idx, 1);
    };
  }

  /** Remove all registered hooks. Mostly for tests. */
  clear(): void {
    this.hooks = [];
    this.attachmentHooks = [];
    this.tagHooks = [];
  }

  /** Count of currently registered hooks (notes + attachments + tags). */
  get size(): number {
    return this.hooks.length + this.attachmentHooks.length + this.tagHooks.length;
  }

  /** Count of currently in-flight handler executions. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Dispatch a note-mutation event. Matches hooks, schedules their
   * handlers onto a microtask, and returns immediately. The caller is
   * never blocked on handler execution.
   *
   * Must only be called after the triggering SQLite write has committed.
   *
   * For `"deleted"` the `note` argument is a `DeletedNoteRef` ({ id,
   * path }) — the row is gone, so the runtime can't re-read it before
   * dispatching to handlers. For `"created"` / `"updated"` the full
   * `Note` is expected; `runHandler` will re-read from the store for
   * non-deleted events to pick up the latest committed state.
   */
  dispatch(event: HookEvent, note: NoteHookPayload, store: Store): void {
    if (this.hooks.length === 0) return;

    // Snapshot matches synchronously so subsequent hook registration
    // changes don't affect this dispatch.
    const matches: RegisteredHook[] = [];
    for (const hook of this.hooks) {
      if (!hook.events.has(event)) continue;
      try {
        if (hook.when && !hook.when(note)) continue;
      } catch (err) {
        this.logger.error(
          `[hooks] predicate threw for ${hook.name ?? "anonymous"} on note ${note.id}:`,
          err,
        );
        continue;
      }
      matches.push(hook);
    }
    if (matches.length === 0) return;

    // Defer to a microtask so we unwind the caller's stack (and its
    // SQLite transaction, if any) before handlers run.
    //
    // Caveat (vault#589): under an ASYNC transaction that spans awaits (the
    // atomic blow-away import wrapped in `transactionAsync`), the connection
    // stays open across the microtask boundary. A handler that writes to the
    // store BEFORE its first real `await` would `SAVEPOINT`-join that open
    // transaction (rolled back with it). Every handler here is audited safe —
    // it defers real work behind an `await` (semaphore acquire) and does no
    // synchronous store write — but the invariant lives in txn.ts's header
    // ("shared-connection invariant"), not just this comment; keep it true.
    queueMicrotask(() => {
      for (const hook of matches) {
        const task = this.runHandler(hook, event, note, store);
        this.inFlight.add(task);
        task.finally(() => this.inFlight.delete(task));
      }
    });
  }

  /**
   * Dispatch an attachment-mutation event. Same post-commit/microtask
   * contract as `dispatch()` for notes. For `"deleted"` the payload is
   * a `DeletedAttachmentRef`; for `"created"` it's the full `Attachment`.
   */
  dispatchAttachment(
    event: AttachmentHookEvent,
    attachment: AttachmentHookPayload,
    store: Store,
  ): void {
    if (this.attachmentHooks.length === 0) return;

    const matches: RegisteredAttachmentHook[] = [];
    for (const hook of this.attachmentHooks) {
      if (!hook.events.has(event)) continue;
      try {
        if (hook.when && !hook.when(attachment)) continue;
      } catch (err) {
        this.logger.error(
          `[hooks] predicate threw for ${hook.name ?? "anonymous"} on attachment ${attachment.id}:`,
          err,
        );
        continue;
      }
      matches.push(hook);
    }
    if (matches.length === 0) return;

    queueMicrotask(() => {
      for (const hook of matches) {
        const task = this.runAttachmentHandler(hook, event, attachment, store);
        this.inFlight.add(task);
        task.finally(() => this.inFlight.delete(task));
      }
    });
  }

  /**
   * Dispatch a tag-mutation event. Same post-commit / microtask contract
   * as the note + attachment dispatchers. `tag` is the bare tag name; the
   * git-mirror handler matches on it to identify which `.parachute/schemas/<tag>.yaml`
   * sidecar to rewrite or remove.
   */
  dispatchTag(event: TagHookEvent, tag: string, store: Store): void {
    if (this.tagHooks.length === 0) return;

    const matches: RegisteredTagHook[] = [];
    for (const hook of this.tagHooks) {
      if (!hook.events.has(event)) continue;
      try {
        if (hook.when && !hook.when(tag)) continue;
      } catch (err) {
        this.logger.error(
          `[hooks] predicate threw for ${hook.name ?? "anonymous"} on tag ${tag}:`,
          err,
        );
        continue;
      }
      matches.push(hook);
    }
    if (matches.length === 0) return;

    queueMicrotask(() => {
      for (const hook of matches) {
        const task = this.runTagHandler(hook, event, tag, store);
        this.inFlight.add(task);
        task.finally(() => this.inFlight.delete(task));
      }
    });
  }

  private async runHandler(
    hook: RegisteredHook,
    event: HookEvent,
    note: NoteHookPayload,
    store: Store,
  ): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      // For non-deleted events, re-read the note so the handler sees the
      // latest committed state (another handler may have written back
      // between dispatch and this acquisition). For "deleted" events the
      // row is gone — pass the DeletedNoteRef payload straight through.
      let payload: NoteHookPayload = note;
      if (event !== "deleted") {
        const fresh = await store.getNote(note.id);
        if (fresh) payload = fresh;
        // If the note was deleted between dispatch and re-read, fall
        // back to the dispatch-time payload — same shape as before; the
        // handler can sense the disappearance via its own predicate.
      }
      await hook.handler(payload, store, event);
    } catch (err) {
      this.logger.error(
        `[hooks] handler ${hook.name ?? "anonymous"} threw on ${event} ${note.id}:`,
        err,
      );
    } finally {
      release();
    }
  }

  private async runAttachmentHandler(
    hook: RegisteredAttachmentHook,
    event: AttachmentHookEvent,
    attachment: AttachmentHookPayload,
    store: Store,
  ): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      // Symmetric with runHandler: re-read for non-deleted events,
      // pass straight through on delete.
      let payload: AttachmentHookPayload = attachment;
      if (event !== "deleted") {
        const fresh = await store.getAttachment(attachment.id);
        if (fresh) payload = fresh;
      }
      await hook.handler(payload, store, event);
    } catch (err) {
      this.logger.error(
        `[hooks] attachment handler ${hook.name ?? "anonymous"} threw on ${event} ${attachment.id}:`,
        err,
      );
    } finally {
      release();
    }
  }

  private async runTagHandler(
    hook: RegisteredTagHook,
    event: TagHookEvent,
    tag: string,
    store: Store,
  ): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      await hook.handler(tag, store, event);
    } catch (err) {
      this.logger.error(
        `[hooks] tag handler ${hook.name ?? "anonymous"} threw on ${event} ${tag}:`,
        err,
      );
    } finally {
      release();
    }
  }

  /**
   * Wait for all currently in-flight handlers to settle. Best-effort
   * drain for graceful shutdown. New hooks dispatched during the drain
   * are also awaited.
   */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.inFlight));
    }
  }
}

/**
 * Module-level default registry. Most consumers (server, CLI) share
 * this one instance; tests can construct their own for isolation.
 */
export const defaultHookRegistry = new HookRegistry();
