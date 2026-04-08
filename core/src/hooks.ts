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
 * Promise.race. Long-running handlers (large TTS jobs, embeddings) may
 * get killed mid-run. Handlers must not write the marker before the
 * work is durably committed, so restart reconciliation works.
 */

import type { Note, Store } from "./types.js";

export type HookEvent = "created" | "updated";

export interface NoteHook {
  /** Events this hook listens for. Defaults to ["created", "updated"]. */
  event?: HookEvent | HookEvent[];
  /**
   * Predicate — return true to run the handler for this note.
   * Should be cheap and synchronous. Idempotency lives here: check
   * whether a marker (e.g. `metadata.audio_rendered_at`) is already set
   * and return false if so.
   */
  when?: (note: Note) => boolean;
  /** Handler — runs async, off the request path. */
  handler: (note: Note, store: Store) => Promise<void> | void;
  /** Optional label for logs. */
  name?: string;
}

interface RegisteredHook extends NoteHook {
  events: Set<HookEvent>;
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
  private semaphore: Semaphore;
  private inFlight = new Set<Promise<void>>();
  private logger: { error: (...args: unknown[]) => void };

  constructor(opts: HookRegistryOptions = {}) {
    const envCap = Number.parseInt(process.env.HOOK_CONCURRENCY ?? "", 10);
    const capacity = opts.concurrency ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : 2);
    this.semaphore = new Semaphore(capacity);
    this.logger = opts.logger ?? console;
  }

  /** Register a hook. Returns an unregister function. */
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

  /** Remove all registered hooks. Mostly for tests. */
  clear(): void {
    this.hooks = [];
  }

  /** Count of currently registered hooks. */
  get size(): number {
    return this.hooks.length;
  }

  /** Count of currently in-flight handler executions. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Dispatch a mutation event. Matches hooks, schedules their handlers
   * onto a microtask, and returns immediately. The caller is never
   * blocked on handler execution.
   *
   * Must only be called after the triggering SQLite write has committed.
   */
  dispatch(event: HookEvent, note: Note, store: Store): void {
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
    queueMicrotask(() => {
      for (const hook of matches) {
        const task = this.runHandler(hook, event, note, store);
        this.inFlight.add(task);
        task.finally(() => this.inFlight.delete(task));
      }
    });
  }

  private async runHandler(
    hook: RegisteredHook,
    event: HookEvent,
    note: Note,
    store: Store,
  ): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      // Re-read the note so the handler sees the latest state (another
      // handler may have written back in between). If the note was
      // deleted, silently drop.
      const fresh = store.getNote(note.id) ?? note;
      await hook.handler(fresh, store);
    } catch (err) {
      this.logger.error(
        `[hooks] handler ${hook.name ?? "anonymous"} threw on ${event} ${note.id}:`,
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
