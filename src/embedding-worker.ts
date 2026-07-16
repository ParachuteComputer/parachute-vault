/**
 * Embed-on-write worker (semantic search MVP — EXPERIMENTAL).
 *
 * Event-driven happy path + a sweep safety net — structurally the same
 * shape as `transcription-worker.ts`, simplified (no retry/backoff state
 * machine; a failed embed just leaves the chunk stale for the next edit
 * or sweep pass to retry):
 *
 *   - **Event path (hot):** a note create/update dispatches the
 *     `HookRegistry`'s "created"/"updated" event. `registerEmbeddingHook`
 *     calls `worker.kick(vault, note)`, which chunks the note
 *     (`chunkNoteContent`), diffs against existing `note_vectors` rows
 *     (`planStaleness`), prunes anything obsolete (the note shrank, or the
 *     model changed), and embeds ONLY the stale chunks. A no-op edit
 *     (identical content, same model) makes ZERO provider calls — the
 *     freshness gate short-circuits before the network/CPU work.
 *   - **Sweep path (backfill + safety net):** every `sweepIntervalMs`,
 *     walks each vault's notes lacking a fresh vector for the active
 *     model (`getNotesPendingEmbedding`) and embeds them. This is what
 *     actually drains the v27 migration's implicit backfill (the
 *     migration itself does no embedding — see `schema.ts`'s
 *     `migrateToV27` doc comment) and catches anything a dropped hook
 *     dispatch or a mid-backfill restart left behind.
 *
 * Concurrency: the event path rides `HookRegistry`'s own
 * `HOOK_CONCURRENCY` cap for free (the handler IS the capped unit of
 * work). The sweep processes its candidate list SEQUENTIALLY — simple,
 * safe, and matches the real per-note embed latency the P0 eval measured
 * (roughly 1–5 notes/sec depending on model); a bulk backfill of a few
 * thousand notes finishes in minutes, not hours, and never spawns
 * unbounded parallel provider calls.
 */

import type { Store, Note } from "../core/src/types.ts";
import type { HookRegistry, NoteHookPayload } from "../core/src/hooks.ts";
import type { EmbeddingProvider } from "../core/src/embedding/provider.ts";
import { chunkNoteContent } from "../core/src/embedding/chunker.ts";
import { planStaleness, contentHash } from "../core/src/embedding/staleness.ts";
import { getNoteVectorRows, deleteObsoleteVectorRows, upsertNoteVector, getNotesPendingEmbedding } from "../core/src/embedding/vectors.ts";
import { normalize } from "../core/src/embedding/vector-codec.ts";

/** Mirrors transcription-worker's safety-net cadence. */
const DEFAULT_SWEEP_MS = 30_000;

export interface EmbeddingWorkerOpts {
  /**
   * `undefined` when `EMBEDDINGS_ENABLED=false` (the off switch — see
   * `src/embedding/select.ts`). The worker is still constructed and
   * started either way (simpler wiring in `server.ts`, always one
   * lifecycle to manage) — `embedNote`/`sweepOnce` just no-op when there's
   * no provider to invoke, which is the entire "drain no-ops" contract.
   */
  provider: EmbeddingProvider | undefined;
  /** Every vault name currently open (mirrors the transcription worker's `vaultList`). */
  vaultList: () => string[];
  /** Resolve (or open) a vault's `Store` by name. */
  getStore: (name: string) => Store;
  /** Sweep cadence (ms). Default 30s. */
  sweepIntervalMs?: number;
  logger?: { error: (...args: unknown[]) => void; log?: (...args: unknown[]) => void };
}

export class EmbeddingWorker {
  private readonly provider: EmbeddingProvider | undefined;
  private readonly vaultList: () => string[];
  private readonly getStore: (name: string) => Store;
  private readonly sweepIntervalMs: number;
  private readonly logger: { error: (...args: unknown[]) => void; log?: (...args: unknown[]) => void };
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(opts: EmbeddingWorkerOpts) {
    this.provider = opts.provider;
    this.vaultList = opts.vaultList;
    this.getStore = opts.getStore;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    this.logger = opts.logger ?? console;
  }

  /**
   * (Re-)embed one note's stale chunks. Cheap-first: chunking + the
   * staleness diff are pure CPU, no provider call; obsolete-row pruning is
   * a plain DELETE. Only when at least one chunk is genuinely stale does
   * this reach the provider — and if the provider reports itself
   * unavailable, this returns without erroring (the chunk stays stale;
   * the next edit or sweep pass retries once a provider is configured).
   *
   * No provider at all (`EMBEDDINGS_ENABLED=false`) → no-op, immediately —
   * the drain contract's off switch (see `EmbeddingWorkerOpts.provider`).
   *
   * Empty-content chunks (a blank note, or a note whose content is only
   * whitespace) are filtered out of the staleness plan before it reaches
   * the provider — an empty chunk is never meaningfully embeddable, and
   * without this filter a blank note would re-enter `getNotesPendingEmbedding`
   * every sweep forever (nothing to write makes it "pending" again next
   * pass), hammering a provider that may reject empty input outright.
   */
  async embedNote(store: Store, note: Note): Promise<void> {
    if (!this.provider) return; // off switch — see EmbeddingWorkerOpts.provider
    if (typeof note.content !== "string") return;
    const db = store.db;
    const chunks = chunkNoteContent(note.content).filter((c) => c.text.trim().length > 0);
    const existing = getNoteVectorRows(db, note.id);
    const plan = planStaleness(existing, chunks, this.provider.model);

    // Cheap sync write — prunes ghost chunks from a shrunk note or a model
    // change BEFORE any embed call, so a concurrent semantic search never
    // ranks against stale content. See core/src/embedding/staleness.ts.
    // An empty note's chunks were just filtered to [] above, so this also
    // prunes any leftover rows from before the note went empty.
    deleteObsoleteVectorRows(db, note.id, plan.obsoleteIxs);

    if (plan.stale.length === 0) return; // no-op edit (or nothing embeddable) — zero provider calls

    const avail = await this.provider.available();
    if (!avail.ok) return; // not configured/ready — leave stale, retried later

    try {
      const { vectors } = await this.provider.embed({ texts: plan.stale.map((c) => c.text) });
      for (let i = 0; i < plan.stale.length; i++) {
        const chunk = plan.stale[i]!;
        const vector = vectors[i];
        if (!vector) continue; // defensive: provider returned fewer vectors than requested
        upsertNoteVector(db, note.id, chunk, normalize(vector), this.provider.model, contentHash(chunk.text));
      }
    } catch (err) {
      this.logger.error(`[embedding] embed failed for note ${note.id}:`, err);
      // Leave stale — idempotent: the next edit (or the sweep) re-derives
      // the same plan and retries.
    }
  }

  /** Event-path entry point — called from the registered `onNote` hook. */
  async kick(vaultName: string, note: Note): Promise<void> {
    const store = this.getStore(vaultName);
    await this.embedNote(store, note);
  }

  /**
   * One backfill/safety-net pass across every open vault. Returns counts
   * for caller logging. Re-entrancy guarded (`sweeping`) — a slow pass
   * (a big vault, a slow provider) never overlaps with the next timer tick.
   * No provider at all → no-op immediately (same off switch as `embedNote`).
   *
   * L1 (reviewer): no per-note lock between this sweep and a concurrent
   * `embedNote` triggered by the event-path hook for the SAME note — by
   * design, matching `HookRegistry`'s own documented "no per-note
   * serialization, last write wins" contract. Worst case is a transient
   * window where a stored vector reflects a slightly-stale version; it
   * self-heals on the NEXT edit (or the next sweep pass), since
   * `planStaleness` re-diffs against the note's CURRENT content_hash every
   * time, never trusting a prior run's result.
   */
  async sweepOnce(): Promise<{ processed: number; vaults: number }> {
    if (!this.provider) return { processed: 0, vaults: 0 }; // off switch
    if (this.sweeping) return { processed: 0, vaults: 0 };
    this.sweeping = true;
    try {
      let processed = 0;
      const vaults = this.vaultList();
      for (const vaultName of vaults) {
        const store = this.getStore(vaultName);
        const pending = getNotesPendingEmbedding(store.db, this.provider.model);
        for (const row of pending) {
          const note = await store.getNote(row.id);
          if (!note) continue; // deleted between the scan and now
          await this.embedNote(store, note);
          processed++;
        }
      }
      return { processed, vaults: vaults.length };
    } finally {
      this.sweeping = false;
    }
  }

  /** Start the recurring sweep. No-op if already started. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweepOnce().catch((err) => this.logger.error("[embedding] sweep failed:", err));
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the recurring sweep. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Register the embed-on-write hook. No `when` predicate (unlike
 * `registerTranscriptionHook`'s `transcribe_status === "pending"` check)
 * — a `NoteHook` predicate only receives the note payload, not the store,
 * so it has no way to cheaply consult `note_vectors`. Instead every
 * create/update dispatches the handler, and `embedNote`'s OWN
 * content-hash diff (checked first, before any provider call) is what
 * makes a no-op edit cost nothing — the same end result, just checked one
 * layer in. `HookRegistry`'s concurrency cap still bounds how many of
 * these run at once.
 */
export function registerEmbeddingHook(
  registry: HookRegistry,
  worker: EmbeddingWorker,
  resolveVault: (store: Store) => string | undefined,
  logger: { error: (...args: unknown[]) => void } = console,
): () => void {
  return registry.onNote({
    name: "embedding-on-write",
    event: ["created", "updated"],
    handler: async (payload: NoteHookPayload, store: Store) => {
      const vault = resolveVault(store);
      if (!vault) {
        logger.error(
          `[embedding] could not resolve vault for note ${(payload as Note).id}; sweep will pick it up`,
        );
        return;
      }
      await worker.kick(vault, payload as Note);
    },
  });
}
