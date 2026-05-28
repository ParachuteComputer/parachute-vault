import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { HookRegistry, type DeletedNoteRef, type DeletedAttachmentRef } from "./hooks.js";
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

// ---------------------------------------------------------------------------
// New event types — deleted notes, tag mutations, deleted attachments
// (vault#XXX — event-driven git-mirror foundation)
// ---------------------------------------------------------------------------

describe("HookRegistry — deleted note events", () => {
  let db: Database;
  let hooks: HookRegistry;
  let store: SqliteStore;
  beforeEach(() => {
    db = new Database(":memory:");
    hooks = new HookRegistry({ concurrency: 4, logger: silentLogger });
    store = new SqliteStore(db, { hooks });
  });

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await hooks.drain();
  }

  it("default subscription doesn't include 'deleted'", async () => {
    // Existing hooks pre-deleted-event don't suddenly start receiving
    // delete shapes they weren't typed for.
    const fired: string[] = [];
    hooks.onNote({
      handler: (note) => {
        fired.push(note.id);
      },
    });

    const note = await store.createNote("hi");
    await settle();
    fired.length = 0;
    await store.deleteNote(note.id);
    await settle();
    expect(fired).toEqual([]);
  });

  it("explicit 'deleted' subscription receives DeletedNoteRef on store.deleteNote", async () => {
    const seen: Array<{ event: string; id: string; path?: string }> = [];
    hooks.onNote({
      event: "deleted",
      handler: (payload, _store, event) => {
        // payload here is a DeletedNoteRef (we subscribed to deleted only).
        const ref = payload as DeletedNoteRef;
        seen.push({ event: event ?? "deleted", id: ref.id, path: ref.path });
      },
    });

    const note = await store.createNote("doomed", { path: "to-delete" });
    await settle();
    await store.deleteNote(note.id);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe("deleted");
    expect(seen[0]!.id).toBe(note.id);
    expect(seen[0]!.path).toBe("to-delete");
  });

  it("DeletedNoteRef has no metadata/tags/content (predicate authors take note)", async () => {
    const observedPayloads: unknown[] = [];
    hooks.onNote({
      event: "deleted",
      handler: (payload) => {
        observedPayloads.push(payload);
      },
    });
    const n = await store.createNote("with tags", { tags: ["one", "two"], metadata: { color: "blue" } });
    await settle();
    await store.deleteNote(n.id);
    await settle();
    expect(observedPayloads).toHaveLength(1);
    const p = observedPayloads[0] as Record<string, unknown>;
    expect(p.id).toBe(n.id);
    // Strictly minimal shape — no full Note fields leak through.
    expect(p.content).toBeUndefined();
    expect(p.metadata).toBeUndefined();
    expect(p.tags).toBeUndefined();
  });

  it("array events allow subscribing to created+updated+deleted in one hook", async () => {
    const events: string[] = [];
    hooks.onNote({
      event: ["created", "updated", "deleted"],
      handler: (_n, _s, ev) => {
        events.push(ev ?? "?");
      },
    });
    const n = await store.createNote("lifecycle");
    await settle();
    await store.updateNote(n.id, { content: "v2" });
    await settle();
    await store.deleteNote(n.id);
    await settle();
    expect(events).toEqual(["created", "updated", "deleted"]);
  });

  it("predicate on a deleted event receives DeletedNoteRef and can filter on path", async () => {
    const fired: string[] = [];
    hooks.onNote({
      event: "deleted",
      when: (payload) => {
        const ref = payload as DeletedNoteRef;
        return ref.path?.startsWith("keep/") === true;
      },
      handler: (payload) => {
        fired.push((payload as DeletedNoteRef).id);
      },
    });
    const a = await store.createNote("a", { path: "keep/one" });
    const b = await store.createNote("b", { path: "skip/two" });
    await settle();
    await store.deleteNote(a.id);
    await store.deleteNote(b.id);
    await settle();
    expect(fired).toEqual([a.id]);
  });
});

describe("HookRegistry — tag events", () => {
  let db: Database;
  let hooks: HookRegistry;
  let store: SqliteStore;
  beforeEach(() => {
    db = new Database(":memory:");
    hooks = new HookRegistry({ concurrency: 4, logger: silentLogger });
    store = new SqliteStore(db, { hooks });
  });

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await hooks.drain();
  }

  it("upsertTagRecord dispatches 'upserted'", async () => {
    const seen: Array<{ tag: string; event: string }> = [];
    hooks.onTag({
      handler: (tag, _store, event) => {
        seen.push({ tag, event: event ?? "?" });
      },
    });
    await store.upsertTagRecord("project", { description: "a project" });
    await settle();
    expect(seen).toEqual([{ tag: "project", event: "upserted" }]);
  });

  it("upsertTagSchema dispatches 'upserted'", async () => {
    const seen: string[] = [];
    hooks.onTag({
      event: "upserted",
      handler: (tag) => {
        seen.push(tag);
      },
    });
    await store.upsertTagSchema("meeting", {
      fields: { duration: { type: "number" } },
    });
    await settle();
    expect(seen).toEqual(["meeting"]);
  });

  it("deleteTag dispatches 'deleted' only when the tag actually existed", async () => {
    const seen: string[] = [];
    hooks.onTag({
      event: "deleted",
      handler: (tag) => {
        seen.push(tag);
      },
    });
    const note = await store.createNote("tagged", { tags: ["mytag"] });
    await settle();

    // Delete the tag — fires.
    await store.deleteTag("mytag");
    await settle();
    expect(seen).toEqual(["mytag"]);

    // Delete a tag that doesn't exist — no fire.
    await store.deleteTag("never-existed");
    await settle();
    expect(seen).toEqual(["mytag"]);
    void note; // silence unused
  });

  it("renameTag dispatches deleted(old) + upserted(new)", async () => {
    const events: Array<{ tag: string; event: string }> = [];
    hooks.onTag({
      handler: (tag, _store, event) => {
        events.push({ tag, event: event ?? "?" });
      },
    });
    await store.createNote("tagged", { tags: ["old-name"] });
    await settle();
    await store.renameTag("old-name", "new-name");
    await settle();
    // Order is implementation-defined; assert the set instead.
    expect(events).toContainEqual({ tag: "old-name", event: "deleted" });
    expect(events).toContainEqual({ tag: "new-name", event: "upserted" });
  });

  it("mergeTags dispatches deleted for each source + upserted for target", async () => {
    const events: Array<{ tag: string; event: string }> = [];
    hooks.onTag({
      handler: (tag, _store, event) => {
        events.push({ tag, event: event ?? "?" });
      },
    });
    await store.createNote("a", { tags: ["src1"] });
    await store.createNote("b", { tags: ["src2"] });
    await settle();
    events.length = 0;
    await store.mergeTags(["src1", "src2"], "target");
    await settle();
    expect(events).toContainEqual({ tag: "src1", event: "deleted" });
    expect(events).toContainEqual({ tag: "src2", event: "deleted" });
    expect(events).toContainEqual({ tag: "target", event: "upserted" });
  });

  it("deleteTagSchema fires 'deleted' for the schema slot", async () => {
    const seen: string[] = [];
    hooks.onTag({
      event: "deleted",
      handler: (tag) => {
        seen.push(tag);
      },
    });
    await store.upsertTagSchema("foo", { description: "x" });
    await settle();
    const ok = await store.deleteTagSchema("foo");
    await settle();
    expect(ok).toBe(true);
    expect(seen).toEqual(["foo"]);
  });

  it("predicate filters tag events by name", async () => {
    const seen: string[] = [];
    hooks.onTag({
      when: (tag) => tag.startsWith("_"),
      handler: (tag) => {
        seen.push(tag);
      },
    });
    await store.upsertTagRecord("public-tag", { description: "x" });
    await store.upsertTagRecord("_private-tag", { description: "y" });
    await settle();
    expect(seen).toEqual(["_private-tag"]);
  });
});

describe("HookRegistry — deleted attachment events", () => {
  let db: Database;
  let hooks: HookRegistry;
  let store: SqliteStore;
  beforeEach(() => {
    db = new Database(":memory:");
    hooks = new HookRegistry({ concurrency: 4, logger: silentLogger });
    store = new SqliteStore(db, { hooks });
  });

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await hooks.drain();
  }

  it("deleteAttachment dispatches 'deleted' with DeletedAttachmentRef", async () => {
    const seen: DeletedAttachmentRef[] = [];
    hooks.onAttachment({
      event: "deleted",
      handler: (payload) => {
        seen.push(payload as DeletedAttachmentRef);
      },
    });
    const note = await store.createNote("with-att");
    const att = await store.addAttachment(note.id, "audio/voice.m4a", "audio/mp4");
    await settle();
    await store.deleteAttachment(note.id, att.id);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(att.id);
    expect(seen[0]!.noteId).toBe(note.id);
    expect(seen[0]!.path).toBe("audio/voice.m4a");
  });

  it("default attachment subscription doesn't include 'deleted' (back-compat)", async () => {
    const fired: string[] = [];
    hooks.onAttachment({
      handler: (att) => {
        // payload is Attachment | DeletedAttachmentRef; we know default
        // events doesn't include deleted, so this only sees created.
        fired.push(att.id);
      },
    });
    const note = await store.createNote("hi");
    const att = await store.addAttachment(note.id, "f.txt", "text/plain");
    await settle();
    fired.length = 0;
    await store.deleteAttachment(note.id, att.id);
    await settle();
    expect(fired).toEqual([]);
  });

  it("non-existent attachment delete does not dispatch", async () => {
    const fired: string[] = [];
    hooks.onAttachment({
      event: "deleted",
      handler: (a) => fired.push(a.id),
    });
    const note = await store.createNote("hi");
    await settle();
    const result = await store.deleteAttachment(note.id, "never-existed-id");
    await settle();
    expect(result.deleted).toBe(false);
    expect(fired).toEqual([]);
  });
});
