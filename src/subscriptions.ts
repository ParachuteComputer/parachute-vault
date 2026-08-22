/**
 * Live-query subscription registry — fans out post-commit note events to live
 * WebSocket subscriptions (originally an SSE fan-out — design
 * `design/2026-06-08-live-query-sse.md`; the SSE transport was removed in
 * Phase 5 of the WS-hibernation migration).
 *
 * A second consumer of the post-commit hook dispatcher (`core/src/hooks.ts`),
 * alongside the durable webhook-trigger sink. Where a trigger survives across
 * connections (wakes an offline session), a subscription is ephemeral —
 * connection-scoped, driving a live UI. Same event source, same predicate,
 * different durability.
 *
 * ## The live transport: WebSocket (WS-hibernation migration)
 *
 * The manager is transport-agnostic: it emits abstract `(event, data)` tuples
 * and a {@link SubscriptionSink} renders them for its wire.
 *   - {@link WsSink} renders a WebSocket message `{ type: event, ...data }`. The
 *     inner payload (`note` / `id` / `notes`) is pinned byte-for-byte against the
 *     shared frame-corpus fixture and is congruent with the cloud door
 *     (`parachute-cloud/workers/vault/src/live/subscriptions.ts`). See
 *     `parachute-cloud/workers/vault/docs/live-query-ws.md`.
 *
 * WebSocket is the SOLE live transport as of Phase 5 — the earlier SSE binding
 * was removed once cached notes-ui bundles converged, and polling (client-side)
 * is the floor beneath live. All subscriptions share ONE process-wide
 * {@link SubscriptionManager}. Self-host has no hibernation (a self-run Bun box
 * has no per-connection duration bill) — the WS binding gives bidirectionality +
 * contract-congruence with cloud, nothing more. The Bun.serve WS integration
 * lives in `ws-server.ts` + `ws-subscribe.ts`.
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
import { toNoteIndex } from "../core/src/notes.ts";
import { getVaultNameForStore } from "./vault-store.ts";
import { noteWithinTagScope, scrubNoteTagsByScope } from "./tag-scope.ts";
import type { LiveMatcher } from "./live-match.ts";

/** Default per-vault concurrent-subscription cap. Over it → 503. */
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_VAULT = 100;

/**
 * Default bound on a single subscription's pending (unflushed) event buffer.
 * If a slow client lets the buffer grow past this, the stream is closed — it
 * reconnects and re-snapshots rather than the server growing memory unbounded.
 * Only enforced for flush-tracking sinks (SSE); the WS transport delegates
 * outgoing-buffer bounds to the Bun runtime.
 */
export const DEFAULT_MAX_BUFFERED_EVENTS = 1000;

/**
 * The abstract sink an event is rendered to. The manager calls `send(event,
 * data)`; each transport formats for its wire. Returns `false` when the sink is
 * gone (the manager then drops the subscription).
 */
export interface SubscriptionSink {
  send(event: string, data: unknown): boolean;
  /** Close the underlying stream/socket (teardown). Idempotent. */
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
  /** When true, `upsert` payloads carry the lean `NoteIndex` projection
   *  (`toNoteIndex`) instead of the full `Note` — for a subscription that opted
   *  into `include_content=false` (list views). `remove` is unaffected (already
   *  a thin `{id}` ref); the initial snapshot is projected at the route. */
  readonly lean: boolean;
  /** SSE tracks unflushed frames to bound memory; WS delegates to the runtime. */
  readonly tracksFlush: boolean;
  /** Whether this sub counts against the per-vault manager cap (SSE) — the WS
   *  transport enforces its own cap via the live-socket count at upgrade. */
  readonly countsTowardCap: boolean;
  /** Pending unflushed frame count (backpressure bound; SSE only). */
  buffered: number;
  readonly maxBuffered: number;
  closed: boolean;
}

/** WebSocket message: `{ type: <event>, ...data }` — the event name becomes the
 *  `type` discriminator and the inner payload (`note` / `id` / `notes`)
 *  serializes as-is. The ONE place WS bytes are formatted. */
export function wsFrame(event: string, data: unknown): string {
  const body = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return JSON.stringify({ type: event, ...body });
}

/** Minimal structural shape of a Bun `ServerWebSocket` (or a test double) that
 *  {@link WsSink} needs — keeps this module free of a hard Bun-server import. */
export interface WsLike {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

/** WebSocket sink: renders `(event, data)` to a `{ type, ...data }` message and
 *  sends it on the socket. `sendRaw` is for pre-formatted frames (the chunked
 *  snapshot the WS binding builds directly). A send on a dead socket returns
 *  false → the manager drops the sub. */
export class WsSink implements SubscriptionSink {
  constructor(private readonly ws: WsLike) {}
  send(event: string, data: unknown): boolean {
    return this.sendRaw(wsFrame(event, data));
  }
  sendRaw(frame: string): boolean {
    try {
      this.ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }
  close(): void {
    try {
      this.ws.close(1011, "subscription closed");
    } catch {
      /* already closing/closed */
    }
  }
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
    /** Opt into the lean `NoteIndex` upsert shape (default false = full `Note`).
     *  Set for a list subscription that requested `include_content=false`. */
    lean?: boolean;
    /** SSE (default true) tracks unflushed frames; WS passes false. */
    tracksFlush?: boolean;
    /** SSE (default true) counts against the per-vault manager cap; WS passes
     *  false — the WS transport caps via the live-socket count at upgrade. */
    countsTowardCap?: boolean;
  }): SubscriptionHandle | null {
    const countsTowardCap = args.countsTowardCap ?? true;
    const current = this.countForVault(args.vaultName);
    if (countsTowardCap && current >= this.maxPerVault) return null;

    this.ensureHooks();

    const sub: Subscription = {
      vaultName: args.vaultName,
      matcher: args.matcher,
      tagScopeAllowed: args.tagScopeAllowed,
      tagScopeRaw: args.tagScopeRaw,
      sink: args.sink,
      lean: args.lean ?? false,
      tracksFlush: args.tracksFlush ?? true,
      countsTowardCap,
      buffered: 0,
      maxBuffered: args.maxBuffered ?? DEFAULT_MAX_BUFFERED_EVENTS,
      closed: false,
    };
    this.subs.add(sub);
    if (countsTowardCap) this.perVaultCount.set(args.vaultName, current + 1);

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
    if (sub.countsTowardCap) {
      const n = this.perVaultCount.get(sub.vaultName) ?? 0;
      if (n <= 1) this.perVaultCount.delete(sub.vaultName);
      else this.perVaultCount.set(sub.vaultName, n - 1);
    }
    try {
      sub.sink.close();
    } catch {
      /* sink may already be torn down */
    }
  }

  /** Emit an `(event, data)` tuple to one subscription, enforcing the buffer
   *  bound for flush-tracking (SSE) sinks. */
  private emit(sub: Subscription, event: string, data: unknown): void {
    if (sub.closed) return;
    if (sub.tracksFlush && sub.buffered >= sub.maxBuffered) {
      // Backpressure: client can't keep up. Close → it reconnects + re-snapshots.
      this.remove(sub);
      return;
    }
    const ok = sub.sink.send(event, data);
    if (!ok) {
      this.remove(sub);
      return;
    }
    if (sub.tracksFlush) sub.buffered++;
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
        this.emit(sub, "remove", { id: ref.id });
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
        // A lean subscription (list view, `include_content=false`) carries the
        // same `NoteIndex` projection REST lists return — never the full body.
        //
        // vault#568 — then scrub `.tags` to this subscriber's in-scope subset.
        // A live event is a read: a `mine`-scoped socket watching a co-tagged
        // note must not receive `project-manhattan` in the payload any more
        // than `GET /api/notes/:id` would hand it over. Order matters twice:
        // the matcher and the scope gate above both read the FULL tag set (a
        // live predicate must evaluate against what's actually stored), and
        // the scrub is NON-MUTATING — `note` is ONE payload fanned out to
        // every subscriber in this loop, each with its own allowlist, so
        // mutating it would cross-contaminate the next subscriber's frame.
        this.emit(sub, "upsert", {
          note: scrubNoteTagsByScope(
            sub.lean ? toNoteIndex(note) : note,
            sub.tagScopeAllowed,
            sub.tagScopeRaw,
          ),
        });
      } else if (event === "updated" && inScope) {
        // Left the set (predicate no longer true) BUT still within this
        // token's scope, so the sub could have held it — idempotent remove
        // (client drops the id if held, no-op otherwise). When the note is
        // OUT of scope the sub never had it; emitting would leak its id, so
        // we stay silent.
        this.emit(sub, "remove", { id: note.id });
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

/** Process-wide manager — shared like `defaultHookRegistry`. */
export const subscriptionManager = new SubscriptionManager();
