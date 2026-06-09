/**
 * Live-query subscription registry (live-query SSE — design
 * `design/2026-06-08-live-query-sse.md`).
 *
 * A second consumer of the post-commit hook dispatcher (`core/src/hooks.ts`),
 * alongside the durable webhook-trigger sink. Where a trigger survives across
 * connections (wakes an offline session), a subscription is ephemeral —
 * connection-scoped, driving a live UI. Same event source, same predicate,
 * different durability.
 *
 * ## How fan-out works
 *
 * All vault stores share the process-wide `defaultHookRegistry`
 * (`vault-store.ts`). We register exactly ONE broad hook per event type
 * (`created`/`updated`/`deleted`) — with NO `when` filter, because a
 * subscription must see EVERY mutation to detect a note LEAVING its set (a
 * `when` that pre-filters to the query would hide the just-left-the-set
 * update). On each event the manager:
 *
 *   1. resolves the event's vault from the store handle
 *      (`getVaultNameForStore`) — the shared registry fires for all vaults;
 *   2. iterates only the subscriptions on THAT vault;
 *   3. created/updated → `matcher.match(note) && noteWithinTagScope(...)` ?
 *      emit `upsert{note}` : (updated only) emit `remove{id}` (left-the-set,
 *      idempotent on the client);
 *   4. deleted → broadcast `remove{id}` to all that vault's subs (the delete
 *      payload is a thin `{id, path?}` ref — no tags/metadata — so it can't
 *      be scope-matched; see the design's "Auth / scope intersection" §).
 *
 * O(writes × subscriptions). At vault scale (hundreds of notes, single-digit
 * open tabs) this is free; documented ceiling, not a silent cap.
 *
 * ## Security: scope intersection (load-bearing)
 *
 * A subscription MUST NOT emit a note its token can't read. Every `upsert`
 * passes BOTH the subscription predicate AND `noteWithinTagScope(note,
 * allowed, rawRoots)` — the SAME check the REST notes path uses. The scope
 * check is ANDed with the predicate and is not bypassable by query shape.
 * The snapshot is separately scope-filtered at the route via
 * `filterNotesByTagScope`.
 */

import type { Note, Store } from "../core/src/types.ts";
import type { DeletedNoteRef, HookEvent, NoteHookPayload } from "../core/src/hooks.ts";
import { defaultHookRegistry } from "../core/src/hooks.ts";
import { getVaultNameForStore } from "./vault-store.ts";
import { noteWithinTagScope } from "./tag-scope.ts";
import type { LiveMatcher } from "./live-match.ts";

/** Default per-vault concurrent-subscription cap. Over it → 503. */
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_VAULT = 100;

/**
 * Default bound on a single subscription's pending (unflushed) event buffer.
 * If a slow client lets the buffer grow past this, the stream is closed — it
 * reconnects and re-snapshots rather than the server growing memory unbounded.
 */
export const DEFAULT_MAX_BUFFERED_EVENTS = 1000;

/** A serialized SSE frame ready to write to the wire. */
type SseFrame = string;

export interface SubscriptionSink {
  /** Enqueue a serialized SSE frame. Returns false if the sink is closed. */
  write(frame: SseFrame): boolean;
  /** Close the underlying stream (teardown). Idempotent. */
  close(): void;
}

interface Subscription {
  readonly vaultName: string;
  readonly matcher: LiveMatcher;
  /** Expanded tag-scope allowlist (null = unscoped). */
  readonly tagScopeAllowed: Set<string> | null;
  /** Raw root-tag allowlist (null = unscoped) — `noteWithinTagScope` arg. */
  readonly tagScopeRaw: string[] | null;
  readonly sink: SubscriptionSink;
  /** Pending unflushed frame count (backpressure bound). */
  buffered: number;
  readonly maxBuffered: number;
  closed: boolean;
}

function sseEvent(event: string, data: unknown): SseFrame {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SubscriptionManager {
  private subs = new Set<Subscription>();
  private perVaultCount = new Map<string, number>();
  private hooksRegistered = false;
  private unregisters: Array<() => void> = [];
  private readonly maxPerVault: number;
  private readonly resolveVault: (store: Store) => string | undefined;

  constructor(
    private readonly registry = defaultHookRegistry,
    opts: { maxPerVault?: number; resolveVault?: (store: Store) => string | undefined } = {},
  ) {
    this.maxPerVault = opts.maxPerVault ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_VAULT;
    // Resolve the event's vault from the store handle. Defaults to the
    // process-wide WeakMap (vault-store.ts); injectable for tests that build
    // a store directly without going through `getVaultStore`.
    this.resolveVault = opts.resolveVault ?? getVaultNameForStore;
  }

  /** Active subscription count for a vault (for the cap check + tests). */
  countForVault(vaultName: string): number {
    return this.perVaultCount.get(vaultName) ?? 0;
  }

  /** The configured per-vault concurrent-subscription cap. */
  get maxSubscriptionsPerVault(): number {
    return this.maxPerVault;
  }

  /** True iff a new subscription on this vault would be under the cap. */
  hasCapacity(vaultName: string): boolean {
    return this.countForVault(vaultName) < this.maxPerVault;
  }

  /** Total active subscriptions (tests / diagnostics). */
  get size(): number {
    return this.subs.size;
  }

  /**
   * Register a subscription. Returns the handle, or `null` if the vault is at
   * its concurrent-subscription cap (the route maps null → 503). The caller
   * is responsible for sending the initial `snapshot` frame BEFORE calling
   * this — registration only wires the live stream so no live event can be
   * missed between snapshot and registration (the caller registers
   * synchronously after computing the snapshot; hook dispatch is deferred to
   * a microtask, so a same-tick write can't slip in front of registration).
   */
  register(args: {
    vaultName: string;
    matcher: LiveMatcher;
    tagScopeAllowed: Set<string> | null;
    tagScopeRaw: string[] | null;
    sink: SubscriptionSink;
    maxBuffered?: number;
  }): SubscriptionHandle | null {
    const current = this.countForVault(args.vaultName);
    if (current >= this.maxPerVault) return null;

    this.ensureHooks();

    const sub: Subscription = {
      vaultName: args.vaultName,
      matcher: args.matcher,
      tagScopeAllowed: args.tagScopeAllowed,
      tagScopeRaw: args.tagScopeRaw,
      sink: args.sink,
      buffered: 0,
      maxBuffered: args.maxBuffered ?? DEFAULT_MAX_BUFFERED_EVENTS,
      closed: false,
    };
    this.subs.add(sub);
    this.perVaultCount.set(args.vaultName, current + 1);

    return {
      /** Note that a previously-buffered frame flushed to the wire. */
      flushed: () => {
        if (sub.buffered > 0) sub.buffered--;
      },
      close: () => this.remove(sub),
    };
  }

  private remove(sub: Subscription): void {
    if (sub.closed) return;
    sub.closed = true;
    this.subs.delete(sub);
    const n = this.perVaultCount.get(sub.vaultName) ?? 0;
    if (n <= 1) this.perVaultCount.delete(sub.vaultName);
    else this.perVaultCount.set(sub.vaultName, n - 1);
    try {
      sub.sink.close();
    } catch {
      /* sink may already be torn down */
    }
  }

  /**
   * Send a keepalive comment to every open subscription (the route's timer
   * calls this). A `:` comment defeats idle-proxy timeouts; it's not an event
   * so it never counts against the buffer bound.
   */
  keepaliveAll(): void {
    for (const sub of this.subs) {
      if (sub.closed) continue;
      const ok = sub.sink.write(":\n\n");
      if (!ok) this.remove(sub);
    }
  }

  /** Emit a frame to one subscription, enforcing the buffer bound. */
  private emit(sub: Subscription, frame: SseFrame): void {
    if (sub.closed) return;
    if (sub.buffered >= sub.maxBuffered) {
      // Backpressure: client can't keep up. Close → it reconnects + re-snapshots.
      this.remove(sub);
      return;
    }
    const ok = sub.sink.write(frame);
    if (!ok) {
      this.remove(sub);
      return;
    }
    sub.buffered++;
  }

  /** Lazily register the three broad hooks (once per manager). */
  private ensureHooks(): void {
    if (this.hooksRegistered) return;
    this.hooksRegistered = true;
    const onNoteEvent = (event: HookEvent) => (payload: NoteHookPayload, store: Store) => {
      this.dispatch(event, payload, store);
    };
    // NO `when` — a subscription must see all events to detect set-exit.
    this.unregisters.push(
      this.registry.onNote({ name: "live-subscribe:created", event: "created", handler: onNoteEvent("created") }),
      this.registry.onNote({ name: "live-subscribe:updated", event: "updated", handler: onNoteEvent("updated") }),
      this.registry.onNote({ name: "live-subscribe:deleted", event: "deleted", handler: onNoteEvent("deleted") }),
    );
  }

  /**
   * Core fan-out. `payload` is the full `Note` for created/updated (re-read
   * fresh by the hook runner) or a `DeletedNoteRef` for deleted.
   */
  private dispatch(event: HookEvent, payload: NoteHookPayload, store: Store): void {
    const vaultName = this.resolveVault(store);
    if (!vaultName) return; // store not tracked → can't scope; drop safely
    if (this.subs.size === 0) return;

    for (const sub of this.subs) {
      if (sub.closed) continue;
      if (sub.vaultName !== vaultName) continue;

      if (event === "deleted") {
        // Thin ref ({id, path?}) — un-scope-matchable. Broadcast remove{id};
        // the client ignores ids it never held. Documented low-sensitivity
        // existence leak (see design §scope-intersection).
        const ref = payload as DeletedNoteRef;
        this.emit(sub, sseEvent("remove", { id: ref.id }));
        continue;
      }

      // created / updated: full Note in hand. Compute scope ONCE and gate
      // BOTH the upsert and the left-the-set remove on it — emitting a
      // `remove{id}` for an out-of-scope note would leak its UUID to a token
      // that could never have held it (M2).
      const note = payload as Note;
      const inScope = noteWithinTagScope(note, sub.tagScopeAllowed, sub.tagScopeRaw);
      const matches = sub.matcher.match(note) && inScope;

      if (matches) {
        this.emit(sub, sseEvent("upsert", { note }));
      } else if (event === "updated" && inScope) {
        // Left the set (predicate no longer true) BUT still within this
        // token's scope, so the sub could have held it — idempotent remove
        // (client drops the id if held, no-op otherwise). When the note is
        // OUT of scope the sub never had it; emitting would leak its id, so
        // we stay silent.
        this.emit(sub, sseEvent("remove", { id: note.id }));
      }
      // created that doesn't match → nothing (it was never in the set).
    }
  }

  /** Tear down all hooks + close all streams. For shutdown / tests. */
  shutdown(): void {
    for (const u of this.unregisters) u();
    this.unregisters = [];
    this.hooksRegistered = false;
    for (const sub of Array.from(this.subs)) this.remove(sub);
  }
}

export interface SubscriptionHandle {
  /** Decrement the pending-frame counter when a frame flushes to the wire. */
  flushed: () => void;
  /** Unregister + close. Called on stream cancel/close. Idempotent. */
  close: () => void;
}

/** Serialize a snapshot frame (exported for the route + tests). */
export function snapshotFrame(notes: Note[]): SseFrame {
  return sseEvent("snapshot", { notes });
}

/** Process-wide manager — shared like `defaultHookRegistry`. */
export const subscriptionManager = new SubscriptionManager();
