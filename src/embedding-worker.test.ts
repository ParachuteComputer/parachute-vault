import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import { EmbeddingWorker, registerEmbeddingHook } from "./embedding-worker.ts";
import { getNoteVectorRows } from "../core/src/embedding/vectors.ts";
import type { EmbeddingProvider, EmbedInput, EmbedResult, ProviderAvailability } from "../core/src/embedding/provider.ts";

const MODEL = "test-model";
const silentLogger = { error: () => {} };

class FakeProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly model = MODEL;
  readonly dims = 4;
  available_ = true;
  reason_: string | undefined;
  calls: string[][] = [];
  failNext = false;

  async embed(input: EmbedInput): Promise<EmbedResult> {
    this.calls.push([...input.texts]);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated provider failure");
    }
    return {
      vectors: input.texts.map((_, i) => new Float32Array([1, 0, 0, i])),
      model: this.model,
      dims: this.dims,
    };
  }

  async available(): Promise<ProviderAvailability> {
    return this.available_ ? { ok: true } : { ok: false, reason: this.reason_ };
  }
}

let db: Database;
let store: SqliteStore;
let provider: FakeProvider;
let worker: EmbeddingWorker;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
  provider = new FakeProvider();
  worker = new EmbeddingWorker({
    provider,
    vaultList: () => ["default"],
    getStore: () => store,
    logger: silentLogger,
  });
});

describe("EmbeddingWorker.embedNote", () => {
  it("embeds a fresh note's chunk(s) and writes note_vectors", async () => {
    const note = await store.createNote("hello world", { path: "n" });
    await worker.embedNote(store, note);
    const rows = getNoteVectorRows(db, note.id);
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe(MODEL);
    expect(provider.calls.length).toBe(1);
  });

  it("a no-op re-embed (identical content) makes ZERO provider calls", async () => {
    const note = await store.createNote("hello world", { path: "n" });
    await worker.embedNote(store, note);
    expect(provider.calls.length).toBe(1);

    await worker.embedNote(store, note); // same content, same model
    expect(provider.calls.length).toBe(1); // unchanged — freshness gate short-circuited
  });

  it("an edited note gets re-embedded (content_hash changed)", async () => {
    let note = await store.createNote("original content", { path: "n" });
    await worker.embedNote(store, note);
    expect(provider.calls.length).toBe(1);

    note = await store.updateNote(note.id, { content: "changed content" });
    await worker.embedNote(store, note);
    expect(provider.calls.length).toBe(2);
    expect(provider.calls[1]).toEqual(["changed content"]);
  });

  it("leaves the chunk stale (no throw) when the provider is unavailable", async () => {
    provider.available_ = false;
    provider.reason_ = "not configured";
    const note = await store.createNote("hello world", { path: "n" });
    await expect(worker.embedNote(store, note)).resolves.toBeUndefined();
    expect(getNoteVectorRows(db, note.id)).toEqual([]);
    expect(provider.calls.length).toBe(0);
  });

  it("swallows an embed() failure (logs, doesn't throw) — retried on the next call", async () => {
    provider.failNext = true;
    const note = await store.createNote("hello world", { path: "n" });
    await expect(worker.embedNote(store, note)).resolves.toBeUndefined();
    expect(getNoteVectorRows(db, note.id)).toEqual([]);

    // Next attempt succeeds (failNext was consumed).
    await worker.embedNote(store, note);
    expect(getNoteVectorRows(db, note.id).length).toBe(1);
  });

  it("prunes obsolete chunks when a note shrinks, without needing a provider call", async () => {
    // Force a multi-chunk note via a tiny targetChars indirectly isn't
    // exposed here, so simulate a shrink by manually seeding an extra
    // stale chunk row the current (single-chunk) content no longer covers.
    const note = await store.createNote("short note", { path: "n" });
    await worker.embedNote(store, note);
    expect(getNoteVectorRows(db, note.id).length).toBe(1);

    db.prepare(
      `INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 1, ?, 4, ?, 'stale', ?)`,
    ).run(note.id, new Uint8Array(16), MODEL, new Date().toISOString());
    expect(getNoteVectorRows(db, note.id).length).toBe(2);

    await worker.embedNote(store, note); // content unchanged at ix 0 -> no provider call, but ix 1 gets pruned
    const rows = getNoteVectorRows(db, note.id);
    expect(rows.map((r) => r.chunk_ix)).toEqual([0]);
  });

  it("M1: no-ops (no throw, zero provider calls) when the worker has no provider at all (EMBEDDINGS_ENABLED=false)", async () => {
    const offWorker = new EmbeddingWorker({
      provider: undefined,
      vaultList: () => ["default"],
      getStore: () => store,
      logger: silentLogger,
    });
    const note = await store.createNote("hello world", { path: "n" });
    await expect(offWorker.embedNote(store, note)).resolves.toBeUndefined();
    expect(getNoteVectorRows(db, note.id)).toEqual([]);
    expect(provider.calls.length).toBe(0); // the shared FakeProvider from beforeEach was never touched
  });

  it("M3: a blank note makes zero provider calls and writes no vector rows", async () => {
    const note = await store.createNote("", { path: "blank" });
    await worker.embedNote(store, note);
    expect(provider.calls.length).toBe(0);
    expect(getNoteVectorRows(db, note.id)).toEqual([]);
  });

  it("M3: a whitespace-only note makes zero provider calls", async () => {
    const note = await store.createNote("   \n\t  ", { path: "whitespace" });
    await worker.embedNote(store, note);
    expect(provider.calls.length).toBe(0);
    expect(getNoteVectorRows(db, note.id)).toEqual([]);
  });

  it("M3: a note that's edited down to blank prunes its old vector rows (no ghost match survives)", async () => {
    const note = await store.createNote("real content", { path: "n" });
    await worker.embedNote(store, note);
    expect(getNoteVectorRows(db, note.id).length).toBe(1);

    const emptied = await store.updateNote(note.id, { content: "" });
    await worker.embedNote(store, emptied);
    expect(getNoteVectorRows(db, note.id)).toEqual([]);
  });
});

describe("EmbeddingWorker.kick", () => {
  it("resolves the store and embeds", async () => {
    const note = await store.createNote("hello", { path: "n" });
    await worker.kick("default", note);
    expect(getNoteVectorRows(db, note.id).length).toBe(1);
  });
});

describe("EmbeddingWorker.sweepOnce", () => {
  it("backfills every note lacking a fresh vector under the active model", async () => {
    const a = await store.createNote("note a", { path: "a" });
    const b = await store.createNote("note b", { path: "b" });
    const result = await worker.sweepOnce();
    expect(result.processed).toBe(2);
    expect(result.vaults).toBe(1);
    expect(getNoteVectorRows(db, a.id).length).toBe(1);
    expect(getNoteVectorRows(db, b.id).length).toBe(1);
  });

  it("a second sweep is a no-op once every note is embedded", async () => {
    await store.createNote("note a", { path: "a" });
    const first = await worker.sweepOnce();
    expect(first.processed).toBe(1);

    provider.calls = [];
    const second = await worker.sweepOnce();
    expect(second.processed).toBe(0); // nothing left pending
    expect(provider.calls.length).toBe(0);
  });

  it("is re-entrant-safe — a sweep already in flight short-circuits a concurrent call", async () => {
    await store.createNote("note a", { path: "a" });
    const p1 = worker.sweepOnce();
    const p2 = worker.sweepOnce(); // should short-circuit to {processed:0, vaults:0} immediately
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r2).toEqual({ processed: 0, vaults: 0 });
    expect(r1.processed).toBe(1);
  });

  it("M1: no-ops immediately when the worker has no provider (off switch)", async () => {
    const offWorker = new EmbeddingWorker({
      provider: undefined,
      vaultList: () => ["default"],
      getStore: () => store,
      logger: silentLogger,
    });
    await store.createNote("note a", { path: "a" });
    const result = await offWorker.sweepOnce();
    expect(result).toEqual({ processed: 0, vaults: 0 });
  });

  it("M3: a mix of blank and real notes only processes the real ones — the sweep never gets stuck re-selecting the blank one", async () => {
    const real = await store.createNote("real content", { path: "real" });
    await store.createNote("", { path: "blank" });
    await store.createNote("   ", { path: "whitespace" });

    const first = await worker.sweepOnce();
    expect(first.processed).toBe(1); // only the real note
    expect(getNoteVectorRows(db, real.id).length).toBe(1);

    // A second pass finds nothing left pending — the blank notes never
    // enter getNotesPendingEmbedding, so they can't loop the sweep forever.
    provider.calls = [];
    const second = await worker.sweepOnce();
    expect(second.processed).toBe(0);
    expect(provider.calls.length).toBe(0);
  });

  it("L4: end-to-end — a blank note present in the vault never leaves a phantom embeddings_pending after the sweep", async () => {
    const real = await store.createNote("real content about something", { path: "real" });
    await store.createNote("", { path: "blank" });

    await worker.sweepOnce(); // embeds `real`; skips `blank` (never a candidate)
    expect(getNoteVectorRows(db, real.id).length).toBe(1);

    // A second store over the SAME db, this one wired with the provider
    // (the shared `store` fixture above intentionally has none — this
    // suite tests the worker's direct DB effects, not semanticSearch) —
    // exercises the real Store.semanticSearch pendingCount path against
    // what the worker actually left behind.
    const searchStore = new SqliteStore(db, { embeddingProvider: provider });
    // Before the L4 fix, semanticSearchNotes' own candidate query counted
    // the blank note as a "pending" candidate forever (it has no vector
    // and never will), so pendingCount would report 1 here, permanently,
    // even after every EMBEDDABLE note in the vault is fully drained.
    const result = await searchStore.semanticSearch("something");
    expect(result.totalCandidates).toBe(1); // only the real note is a candidate
    expect(result.pendingCount).toBe(0);
  });
});

describe("registerEmbeddingHook", () => {
  it("kicks the worker on note created/updated via the HookRegistry", async () => {
    const hooks = new HookRegistry({ concurrency: 4, logger: silentLogger });
    const hookedStore = new SqliteStore(db, { hooks });
    registerEmbeddingHook(hooks, worker, () => "default", silentLogger);

    const note = await hookedStore.createNote("hooked content", { path: "n" });
    // Let the microtask-deferred dispatch + handler run.
    await Promise.resolve();
    await Promise.resolve();
    await hooks.drain();

    expect(getNoteVectorRows(db, note.id).length).toBe(1);
  });

  it("logs (doesn't throw) when the vault can't be resolved", async () => {
    const hooks = new HookRegistry({ concurrency: 4, logger: silentLogger });
    const hookedStore = new SqliteStore(db, { hooks });
    let loggedError: unknown;
    registerEmbeddingHook(hooks, worker, () => undefined, { error: (msg) => { loggedError = msg; } });

    await hookedStore.createNote("content", { path: "n" });
    await Promise.resolve();
    await Promise.resolve();
    await hooks.drain();

    expect(loggedError).toBeTruthy();
  });

  it("M1: a note create/update through the hook is a harmless no-op when the worker has no provider", async () => {
    const offWorker = new EmbeddingWorker({
      provider: undefined,
      vaultList: () => ["default"],
      getStore: () => store,
      logger: silentLogger,
    });
    const hooks = new HookRegistry({ concurrency: 4, logger: silentLogger });
    const hookedStore = new SqliteStore(db, { hooks });
    registerEmbeddingHook(hooks, offWorker, () => "default", silentLogger);

    const note = await hookedStore.createNote("hooked content", { path: "n" });
    await Promise.resolve();
    await Promise.resolve();
    await hooks.drain();

    expect(getNoteVectorRows(db, note.id)).toEqual([]);
  });
});
