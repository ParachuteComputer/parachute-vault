import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { HookRegistry } from "./hooks.js";
import type { Note } from "./types.js";

let db: Database;
let hooks: HookRegistry;
let store: SqliteStore;

/** Silent logger so expected-error tests don't spam output. */
const silentLogger = { error: () => {}, warn: () => {} };

beforeEach(() => {
  db = new Database(":memory:");
  hooks = new HookRegistry({ concurrency: 4, logger: silentLogger });
  store = new SqliteStore(db, { hooks });
});

/** Wait for all hook dispatches queued on the microtask loop and any
 *  currently in-flight handlers to settle. */
async function settle(): Promise<void> {
  // Let queueMicrotask-scheduled dispatches enqueue their tasks.
  await Promise.resolve();
  await Promise.resolve();
  await hooks.drain();
}

describe("HookRegistry", () => {
  it("fires registered hook on createNote", async () => {
    const fired: string[] = [];
    hooks.onNote({
      event: "created",
      handler: (note) => {
        fired.push(note.id);
      },
    });

    const note = store.createNote("hello");
    expect(fired).toEqual([]); // async — not yet
    await settle();
    expect(fired).toEqual([note.id]);
  });

  it("fires registered hook on updateNote", async () => {
    const fired: Array<{ event: string; id: string }> = [];
    hooks.onNote({
      event: "updated",
      handler: (note) => {
        fired.push({ event: "updated", id: note.id });
      },
    });

    const note = store.createNote("hello");
    await settle();
    expect(fired).toEqual([]); // we only subscribed to updated

    store.updateNote(note.id, { content: "world" });
    await settle();
    expect(fired).toEqual([{ event: "updated", id: note.id }]);
  });

  it("fires for bulk createNotes after transaction commits", async () => {
    const fired: string[] = [];
    hooks.onNote({
      handler: (note) => {
        fired.push(note.id);
      },
    });

    const notes = store.createNotes([
      { content: "a", id: "a1" },
      { content: "b", id: "b1" },
      { content: "c", id: "c1" },
    ]);
    await settle();
    expect(fired.sort()).toEqual(["a1", "b1", "c1"]);
    expect(notes.length).toBe(3);
  });

  it("respects predicate — does not fire for non-matching notes", async () => {
    const fired: string[] = [];
    hooks.onNote({
      when: (note) => (note.tags ?? []).includes("reader"),
      handler: (note) => {
        fired.push(note.id);
      },
    });

    const skipped = store.createNote("plain", { tags: ["journal"] });
    const matched = store.createNote("reader-note", { tags: ["reader"] });
    await settle();

    expect(fired).toEqual([matched.id]);
    expect(fired).not.toContain(skipped.id);
  });

  it("does not fire on read paths (getNote, getNotes, queryNotes)", async () => {
    const fired: string[] = [];
    hooks.onNote({
      handler: (note) => {
        fired.push(note.id);
      },
    });

    const note = store.createNote("one");
    await settle();
    expect(fired).toEqual([note.id]);

    fired.length = 0;
    store.getNote(note.id);
    store.getNotes([note.id]);
    store.queryNotes({});
    await settle();
    expect(fired).toEqual([]);
  });

  it("idempotency: handler writing a marker does not re-fire itself", async () => {
    let handlerCalls = 0;
    hooks.onNote({
      event: ["created", "updated"],
      when: (note) => !note.metadata?.processed_at,
      handler: async (note, s) => {
        handlerCalls++;
        s.updateNote(note.id, {
          metadata: { ...(note.metadata ?? {}), processed_at: new Date().toISOString() },
        });
      },
    });

    const note = store.createNote("work me");
    await settle();
    // The handler ran once for "created"; its updateNote triggered an
    // "updated" dispatch, but the predicate excluded it because the
    // marker is now set. So exactly one call.
    expect(handlerCalls).toBe(1);

    const refreshed = store.getNote(note.id)!;
    expect(refreshed.metadata?.processed_at).toBeTruthy();
  });

  it("handler failure is logged but does not crash or affect the mutation", async () => {
    const errors: unknown[] = [];
    const localHooks = new HookRegistry({
      concurrency: 2,
      logger: { error: (...args) => errors.push(args) },
    });
    const localDb = new Database(":memory:");
    const localStore = new SqliteStore(localDb, { hooks: localHooks });

    localHooks.onNote({
      name: "boom",
      handler: async () => {
        throw new Error("kaboom");
      },
    });

    const note = localStore.createNote("survive");
    expect(note.id).toBeTruthy();
    // Original mutation still persisted
    expect(localStore.getNote(note.id)?.content).toBe("survive");

    await Promise.resolve();
    await Promise.resolve();
    await localHooks.drain();
    expect(errors.length).toBe(1);
  });

  it("concurrency cap: HOOK_CONCURRENCY=1 serializes handler execution", async () => {
    const localHooks = new HookRegistry({ concurrency: 1, logger: silentLogger });
    const localDb = new Database(":memory:");
    const localStore = new SqliteStore(localDb, { hooks: localHooks });

    let running = 0;
    let maxConcurrent = 0;
    const releasers: Array<() => void> = [];

    localHooks.onNote({
      handler: async () => {
        running++;
        if (running > maxConcurrent) maxConcurrent = running;
        await new Promise<void>((resolve) => releasers.push(resolve));
        running--;
      },
    });

    localStore.createNote("a");
    localStore.createNote("b");
    localStore.createNote("c");

    // Let dispatch microtasks enqueue tasks and the semaphore start one.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));

    expect(maxConcurrent).toBe(1);
    expect(running).toBe(1);
    expect(releasers.length).toBe(1);

    // Release them one at a time and verify only one runs at once.
    while (releasers.length > 0) {
      const next = releasers.shift()!;
      next();
      await new Promise((r) => setTimeout(r, 10));
    }

    await localHooks.drain();
    expect(maxConcurrent).toBe(1);
  });

  it("unregister stops hook from firing", async () => {
    const fired: string[] = [];
    const off = hooks.onNote({
      handler: (note) => {
        fired.push(note.id);
      },
    });

    store.createNote("first");
    await settle();
    expect(fired.length).toBe(1);

    off();
    store.createNote("second");
    await settle();
    expect(fired.length).toBe(1);
  });

  it("multiple hooks all fire for a matching note", async () => {
    const order: string[] = [];
    hooks.onNote({ name: "one", handler: () => void order.push("one") });
    hooks.onNote({ name: "two", handler: () => void order.push("two") });

    store.createNote("both");
    await settle();
    expect(order.sort()).toEqual(["one", "two"]);
  });

  it("drain waits for in-flight handlers", async () => {
    let done = false;
    hooks.onNote({
      handler: async () => {
        await new Promise((r) => setTimeout(r, 20));
        done = true;
      },
    });
    store.createNote("slow");
    // Let dispatch schedule
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    await hooks.drain();
    expect(done).toBe(true);
  });
});
