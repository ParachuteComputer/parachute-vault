import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { HookRegistry } from "./hooks.js";
import type { Note } from "./types.js";

let db: Database;
let hooks: HookRegistry;
let store: SqliteStore;

/** Silent logger so expected-error tests don't spam output. */
const silentLogger = { error: () => {} };

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

describe("HookRegistry", async () => {
  it("fires registered hook on createNote", async () => {
    const fired: string[] = [];
    hooks.onNote({
      event: "created",
      handler: (note) => {
        fired.push(note.id);
      },
    });

    const note = await store.createNote("hello");
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

    const note = await store.createNote("hello");
    await settle();
    expect(fired).toEqual([]); // we only subscribed to updated

    await store.updateNote(note.id, { content: "world" });
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

    const notes = await store.createNotes([
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

    const skipped = await store.createNote("plain", { tags: ["journal"] });
    const matched = await store.createNote("reader-note", { tags: ["reader"] });
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

    const note = await store.createNote("one");
    await settle();
    expect(fired).toEqual([note.id]);

    fired.length = 0;
    await store.getNote(note.id);
    await store.getNotes([note.id]);
    await store.queryNotes({});
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

    const note = await store.createNote("work me");
    await settle();
    // The handler ran once for "created"; its updateNote triggered an
    // "updated" dispatch, but the predicate excluded it because the
    // marker is now set. So exactly one call.
    expect(handlerCalls).toBe(1);

    const refreshed = (await store.getNote(note.id))!;
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

    const note = await localStore.createNote("survive");
    expect(note.id).toBeTruthy();
    // Original mutation still persisted
    expect((await localStore.getNote(note.id))?.content).toBe("survive");

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

    await localStore.createNote("a");
    await localStore.createNote("b");
    await localStore.createNote("c");

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

    await store.createNote("first");
    await settle();
    expect(fired.length).toBe(1);

    off();
    await store.createNote("second");
    await settle();
    expect(fired.length).toBe(1);
  });

  it("multiple hooks all fire for a matching note", async () => {
    const order: string[] = [];
    hooks.onNote({ name: "one", handler: () => void order.push("one") });
    hooks.onNote({ name: "two", handler: () => void order.push("two") });

    await store.createNote("both");
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
    await store.createNote("slow");
    // Let dispatch schedule
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    await hooks.drain();
    expect(done).toBe(true);
  });

  it("logs and skips a hook whose predicate throws; other hooks still run", async () => {
    const errors: unknown[] = [];
    const loggingHooks = new HookRegistry({
      concurrency: 4,
      logger: { error: (...args) => errors.push(args) },
    });
    const loggingStore = new SqliteStore(new Database(":memory:"), { hooks: loggingHooks });
    let goodFired = 0;

    loggingHooks.onNote({
      name: "throwing-predicate",
      when: () => {
        throw new Error("predicate boom");
      },
      handler: () => {
        throw new Error("should not reach here");
      },
    });
    loggingHooks.onNote({
      name: "good",
      handler: () => {
        goodFired++;
      },
    });

    await loggingStore.createNote("hi");
    await Promise.resolve();
    await Promise.resolve();
    await loggingHooks.drain();

    // The good hook ran.
    expect(goodFired).toBe(1);
    // The throwing predicate was logged.
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const joined = errors.map((a) => JSON.stringify(a)).join(" ");
    expect(joined).toContain("predicate");
  });
});

describe("HookRegistry — HOOK_CONCURRENCY env var parsing", async () => {
  const original = process.env.HOOK_CONCURRENCY;
  const restore = () => {
    if (original === undefined) delete process.env.HOOK_CONCURRENCY;
    else process.env.HOOK_CONCURRENCY = original;
  };

  it("defaults to 2 when HOOK_CONCURRENCY is unset", () => {
    delete process.env.HOOK_CONCURRENCY;
    const r = new HookRegistry();
    // Acquire 3 in sequence — first 2 should resolve immediately, third should wait.
    let resolvedCount = 0;
    const pending: Array<Promise<() => void>> = [];
    for (let i = 0; i < 3; i++) {
      const p = (r as unknown as { semaphore: { acquire: () => Promise<() => void> } }).semaphore.acquire();
      p.then(() => resolvedCount++);
      pending.push(p);
    }
    return Promise.resolve().then(() => {
      expect(resolvedCount).toBe(2);
      restore();
    });
  });

  it("falls back to default when HOOK_CONCURRENCY is NaN / empty / negative", () => {
    for (const bad of ["", "abc", "0", "-5", "NaN"]) {
      process.env.HOOK_CONCURRENCY = bad;
      const r = new HookRegistry();
      // Should not throw; registry is usable.
      r.onNote({ handler: () => {} });
      expect(r.size).toBe(1);
    }
    restore();
  });

  it("honors HOOK_CONCURRENCY=1 from env", async () => {
    process.env.HOOK_CONCURRENCY = "1";
    const r = new HookRegistry({ logger: silentLogger });
    const s = new SqliteStore(new Database(":memory:"), { hooks: r });

    let concurrent = 0;
    let maxConcurrent = 0;
    const releasers: Array<() => void> = [];
    r.onNote({
      handler: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((resolve) => releasers.push(resolve));
        concurrent--;
      },
    });

    await s.createNote("a");
    await s.createNote("b");
    await s.createNote("c");
    await Promise.resolve();
    await Promise.resolve();
    // Release them one at a time and let each drain through the semaphore.
    while (releasers.length > 0) {
      releasers.shift()!();
      await new Promise((r) => setTimeout(r, 1));
    }
    await r.drain();
    expect(maxConcurrent).toBe(1);
    restore();
  });
});
