import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BunStore } from "./vault-store.ts";
import { startTranscriptionWorker, registerTranscriptionHook } from "./transcription-worker.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import { SqliteStore } from "../core/src/store.ts";
import type { Store } from "../core/src/types.ts";

let db: Database;
let store: BunStore;
let tmpDir: string;
let assetsRoot: string;

const silentLogger = { error: () => {}, info: () => {} };

beforeEach(() => {
  tmpDir = join(tmpdir(), `transcribe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  assetsRoot = join(tmpDir, "assets");
  mkdirSync(assetsRoot, { recursive: true });
  db = new Database(join(tmpDir, "test.db"));
  store = new BunStore(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkFetchMock(responses: Array<{ text: string } | { error: string; status?: number }>): typeof fetch {
  let i = 0;
  return (async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if ("error" in r) {
      return new Response(r.error, { status: r.status ?? 500 });
    }
    return new Response(JSON.stringify({ text: r.text }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function seedAudio(relPath: string): string {
  const full = join(assetsRoot, relPath);
  mkdirSync(join(full, "..").toString(), { recursive: true });
  writeFileSync(full, Buffer.from([1, 2, 3, 4]));
  return full;
}

function makeWorker(opts: {
  fetchImpl: typeof fetch;
  retention?: "keep" | "until_transcribed" | "never";
  maxAttempts?: number;
}) {
  return startTranscriptionWorker({
    vaultList: () => ["default"],
    getStore: () => store as unknown as Store,
    scribeUrl: "http://scribe.test",
    resolveAssetsDir: () => assetsRoot,
    getAudioRetention: () => opts.retention ?? "keep",
    pollIntervalMs: 10_000_000, // never auto-fire; tests drive ticks manually
    maxAttempts: opts.maxAttempts ?? 3,
    fetchImpl: opts.fetchImpl,
    logger: silentLogger,
  });
}

describe("transcription worker", () => {
  test("happy path: replaces _Transcript pending._ and clears stub marker", async () => {
    const note = await store.createNote(
      "# 🎙️ Voice memo\n\n_Transcript pending._\n",
      { id: "n1", metadata: { transcribe_stub: true } },
    );
    seedAudio("memos/a.webm");
    await store.addAttachment(note.id, "memos/a.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "hello world transcript" }]),
    });
    try {
      const processed = await worker.tick();
      expect(processed).toBe(1);
    } finally {
      await worker.stop();
    }

    const updated = await store.getNote("n1");
    expect(updated!.content).toBe("# 🎙️ Voice memo\n\nhello world transcript\n");
    expect((updated!.metadata as any)?.transcribe_stub).toBeUndefined();

    const [att] = await store.getAttachments("n1");
    expect(att.metadata?.transcribe_status).toBe("done");
    expect(att.metadata?.transcript).toBe("hello world transcript");
  });

  test("no-clobber: stub flag absent → does not touch note content", async () => {
    await store.createNote("my own edit", { id: "n2" });
    seedAudio("memos/b.webm");
    await store.addAttachment("n2", "memos/b.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "would clobber" }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const updated = await store.getNote("n2");
    expect(updated!.content).toBe("my own edit");
    const [att] = await store.getAttachments("n2");
    // Transcript still captured on the attachment — we don't throw work away,
    // we just don't overwrite the note the user explicitly edited.
    expect(att.metadata?.transcribe_status).toBe("done");
    expect(att.metadata?.transcript).toBe("would clobber");
  });

  test("no placeholder: replaces full body when stub is set", async () => {
    await store.createNote("", {
      id: "n3",
      metadata: { transcribe_stub: true },
    });
    seedAudio("memos/c.webm");
    await store.addAttachment("n3", "memos/c.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "bare transcript" }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const updated = await store.getNote("n3");
    expect(updated!.content).toBe("bare transcript");
  });

  test("retry on failure: status stays pending with backoff + attempts bumped", async () => {
    await store.createNote("stub", {
      id: "n4",
      metadata: { transcribe_stub: true },
    });
    seedAudio("memos/d.webm");
    await store.addAttachment("n4", "memos/d.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ error: "scribe down", status: 503 }]),
      maxAttempts: 3,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const [att] = await store.getAttachments("n4");
    expect(att.metadata?.transcribe_status).toBe("pending");
    expect(att.metadata?.transcribe_attempts).toBe(1);
    expect(att.metadata?.transcribe_backoff_until).toBeTruthy();
    expect(att.metadata?.transcribe_error).toContain("503");
  });

  test("gives up after maxAttempts → status failed", async () => {
    await store.createNote("stub", {
      id: "n5",
      metadata: { transcribe_stub: true },
    });
    seedAudio("memos/e.webm");
    // Simulate already 2 attempts done — one more failure flips to failed
    // when maxAttempts=3.
    await store.addAttachment("n5", "memos/e.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_attempts: 2,
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ error: "boom", status: 500 }]),
      maxAttempts: 3,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const [att] = await store.getAttachments("n5");
    expect(att.metadata?.transcribe_status).toBe("failed");
    expect(att.metadata?.transcribe_attempts).toBe(3);
    expect(att.metadata?.transcribe_error).toContain("boom");
  });

  test("FIFO: oldest pending is processed first", async () => {
    await store.createNote("s", { id: "f1", metadata: { transcribe_stub: true } });
    await store.createNote("s", { id: "f2", metadata: { transcribe_stub: true } });
    seedAudio("memos/first.webm");
    seedAudio("memos/second.webm");
    await store.addAttachment("f1", "memos/first.webm", "audio/webm", {
      transcribe_status: "pending",
    });
    // Ensure a distinct created_at — bun:sqlite stores ISO timestamps at ms
    // granularity, so sleep briefly.
    await new Promise((r) => setTimeout(r, 5));
    await store.addAttachment("f2", "memos/second.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const calls: string[] = [];
    const worker = makeWorker({
      fetchImpl: (async () => {
        calls.push("call");
        return new Response(JSON.stringify({ text: `t${calls.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const n1 = await store.getNote("f1");
    const n2 = await store.getNote("f2");
    expect(n1!.content).toBe("t1");
    expect(n2!.content).toBe("t2");
  });

  test("backoff gate skips attachments whose backoff has not elapsed", async () => {
    await store.createNote("s", { id: "b1", metadata: { transcribe_stub: true } });
    seedAudio("memos/b1.webm");
    const future = new Date(Date.now() + 60_000).toISOString();
    await store.addAttachment("b1", "memos/b1.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_attempts: 1,
      transcribe_backoff_until: future,
    });

    let called = 0;
    const worker = makeWorker({
      fetchImpl: (async () => {
        called++;
        return new Response(JSON.stringify({ text: "x" }), { status: 200 });
      }) as typeof fetch,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    expect(called).toBe(0);
    const [att] = await store.getAttachments("b1");
    expect(att.metadata?.transcribe_status).toBe("pending");
  });

  test("retention=until_transcribed unlinks the audio file after success", async () => {
    await store.createNote("s", { id: "r1", metadata: { transcribe_stub: true } });
    const full = seedAudio("memos/r1.webm");
    await store.addAttachment("r1", "memos/r1.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "t" }]),
      retention: "until_transcribed",
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    expect(existsSync(full)).toBe(false);
    // Attachment row preserved — transcript still addressable.
    const [att] = await store.getAttachments("r1");
    expect(att.metadata?.transcribe_status).toBe("done");
    expect(att.metadata?.transcript).toBe("t");
  });

  test("retention=never unlinks the audio file after success", async () => {
    await store.createNote("s", { id: "rn1", metadata: { transcribe_stub: true } });
    const full = seedAudio("memos/rn1.webm");
    await store.addAttachment("rn1", "memos/rn1.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "t" }]),
      retention: "never",
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    expect(existsSync(full)).toBe(false);
    const [att] = await store.getAttachments("rn1");
    expect(att.metadata?.transcribe_status).toBe("done");
    expect(att.metadata?.transcript).toBe("t");
  });

  test("retention=never unlinks the audio file after terminal failure", async () => {
    await store.createNote("s", { id: "rn2", metadata: { transcribe_stub: true } });
    const full = seedAudio("memos/rn2.webm");
    // Pre-seed attempts=2 so a single tick with maxAttempts=3 is terminal.
    await store.addAttachment("rn2", "memos/rn2.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_attempts: 2,
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ error: "boom", status: 500 }]),
      retention: "never",
      maxAttempts: 3,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const [att] = await store.getAttachments("rn2");
    expect(att.metadata?.transcribe_status).toBe("failed");
    // The whole point of "never": audio gone even when transcription failed.
    expect(existsSync(full)).toBe(false);
  });

  test("retention=never keeps the audio file during non-terminal retry", async () => {
    await store.createNote("s", { id: "rn3", metadata: { transcribe_stub: true } });
    const full = seedAudio("memos/rn3.webm");
    // attempts=0 so a single failure is retry-pending, not terminal.
    await store.addAttachment("rn3", "memos/rn3.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ error: "transient", status: 503 }]),
      retention: "never",
      maxAttempts: 3,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const [att] = await store.getAttachments("rn3");
    expect(att.metadata?.transcribe_status).toBe("pending");
    // File must remain for the retry to have something to send.
    expect(existsSync(full)).toBe(true);
  });

  test("retention=keep leaves the audio file in place after success", async () => {
    await store.createNote("s", { id: "k1", metadata: { transcribe_stub: true } });
    const full = seedAudio("memos/k1.webm");
    await store.addAttachment("k1", "memos/k1.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "t" }]),
      retention: "keep",
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    expect(existsSync(full)).toBe(true);
  });

  test("missing audio file → flips to failed, no infinite retry", async () => {
    await store.createNote("s", { id: "m1", metadata: { transcribe_stub: true } });
    await store.addAttachment("m1", "memos/not-there.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    let called = 0;
    const worker = makeWorker({
      fetchImpl: (async () => {
        called++;
        return new Response("x", { status: 200 });
      }) as typeof fetch,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    expect(called).toBe(0);
    const [att] = await store.getAttachments("m1");
    expect(att.metadata?.transcribe_status).toBe("failed");
    expect(att.metadata?.transcribe_error).toContain("audio file not found");
  });
});

describe("transcription worker — auth + context", () => {
  test("attaches multipart context part when getContextPredicates returns entries", async () => {
    await store.createNote("stub", { id: "ctx1", metadata: { transcribe_stub: true } });
    seedAudio("memos/ctx1.webm");
    await store.addAttachment("ctx1", "memos/ctx1.webm", "audio/webm", {
      transcribe_status: "pending",
    });
    // Seed a context note the worker will fetch via queryNotes.
    await store.createNote("", {
      id: "p1",
      path: "People/Aaron.md",
      tags: ["person"],
      metadata: { summary: "founder", aliases: ["AG"] },
    });

    let captured: { headers: Headers; form: FormData } | null = null;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as unknown as FormData;
      captured = { headers: new Headers(init?.headers as HeadersInit), form };
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const worker = startTranscriptionWorker({
      vaultList: () => ["default"],
      getStore: () => store as unknown as Store,
      scribeUrl: "http://scribe.test",
      resolveAssetsDir: () => assetsRoot,
      getContextPredicates: () => [
        { tag: "person", include_metadata: ["summary", "aliases"] },
      ],
      pollIntervalMs: 10_000_000,
      fetchImpl,
      logger: silentLogger,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    expect(captured).not.toBeNull();
    const part = captured!.form.get("context");
    expect(part).toBeInstanceOf(Blob);
    const body = JSON.parse(await (part as Blob).text());
    expect(body.entries).toEqual([
      { name: "Aaron", summary: "founder", aliases: ["AG"] },
    ]);
  });

  test("sends Bearer header when scribeToken is set", async () => {
    await store.createNote("stub", { id: "auth1", metadata: { transcribe_stub: true } });
    seedAudio("memos/auth1.webm");
    await store.addAttachment("auth1", "memos/auth1.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    let capturedAuth: string | null = null;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedAuth = new Headers(init?.headers as HeadersInit).get("authorization");
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    }) as typeof fetch;

    const worker = startTranscriptionWorker({
      vaultList: () => ["default"],
      getStore: () => store as unknown as Store,
      scribeUrl: "http://scribe.test",
      scribeToken: "shh-secret",
      resolveAssetsDir: () => assetsRoot,
      pollIntervalMs: 10_000_000,
      fetchImpl,
      logger: silentLogger,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    expect(capturedAuth).toBe("Bearer shh-secret");
  });

  test("omits Authorization header when scribeToken is unset (loopback back-compat)", async () => {
    await store.createNote("stub", { id: "auth2", metadata: { transcribe_stub: true } });
    seedAudio("memos/auth2.webm");
    await store.addAttachment("auth2", "memos/auth2.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    let capturedAuth: string | null | undefined = undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedAuth = new Headers(init?.headers as HeadersInit).get("authorization");
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    }) as typeof fetch;

    const worker = startTranscriptionWorker({
      vaultList: () => ["default"],
      getStore: () => store as unknown as Store,
      scribeUrl: "http://scribe.test",
      resolveAssetsDir: () => assetsRoot,
      pollIntervalMs: 10_000_000,
      fetchImpl,
      logger: silentLogger,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    // Headers#get returns null when absent — this is how we confirm no header was set.
    expect(capturedAuth).toBeNull();
  });

  test("no context attached when getContextPredicates is undefined (no regression)", async () => {
    await store.createNote("stub", { id: "np1", metadata: { transcribe_stub: true } });
    seedAudio("memos/np1.webm");
    await store.addAttachment("np1", "memos/np1.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    let capturedForm: FormData | null = null;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedForm = init?.body as unknown as FormData;
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    }) as typeof fetch;

    const worker = startTranscriptionWorker({
      vaultList: () => ["default"],
      getStore: () => store as unknown as Store,
      scribeUrl: "http://scribe.test",
      resolveAssetsDir: () => assetsRoot,
      pollIntervalMs: 10_000_000,
      fetchImpl,
      logger: silentLogger,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    expect(capturedForm).not.toBeNull();
    expect(capturedForm!.get("context")).toBeNull();
    expect(capturedForm!.get("file")).not.toBeNull();
  });
});

describe("store.listAttachmentsByTranscribeStatus", () => {
  test("returns only matching status, oldest first", async () => {
    await store.createNote("s", { id: "q1" });
    await store.addAttachment("q1", "a.webm", "audio/webm", { transcribe_status: "done" });
    await new Promise((r) => setTimeout(r, 5));
    await store.addAttachment("q1", "b.webm", "audio/webm", { transcribe_status: "pending" });
    await new Promise((r) => setTimeout(r, 5));
    await store.addAttachment("q1", "c.webm", "audio/webm", { transcribe_status: "pending" });
    await store.addAttachment("q1", "d.webm", "audio/webm"); // no status

    const pending = await store.listAttachmentsByTranscribeStatus("pending");
    expect(pending).toHaveLength(2);
    expect(pending[0]!.path).toBe("b.webm");
    expect(pending[1]!.path).toBe("c.webm");

    const done = await store.listAttachmentsByTranscribeStatus("done");
    expect(done).toHaveLength(1);
    expect(done[0]!.path).toBe("a.webm");
  });
});

describe("transcription worker — hook-driven", () => {
  // These tests use a private HookRegistry so they don't collide with
  // defaultHookRegistry state or other test files.
  let hooks: HookRegistry;
  let hookedStore: SqliteStore;
  let hookedDb: Database;

  beforeEach(() => {
    hookedDb = new Database(":memory:");
    hooks = new HookRegistry({ concurrency: 4, logger: silentLogger });
    hookedStore = new SqliteStore(hookedDb, { hooks });
  });

  afterEach(() => {
    hookedDb.close();
  });

  test("attachment:created event triggers a cycle before the sweep fires", async () => {
    await hookedStore.createNote("stub", { id: "h1", metadata: { transcribe_stub: true } });
    seedAudio("memos/h1.webm");

    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response(JSON.stringify({ text: "hook-path" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const worker = startTranscriptionWorker({
      vaultList: () => ["default"],
      getStore: () => hookedStore as unknown as Store,
      scribeUrl: "http://scribe.test",
      resolveAssetsDir: () => assetsRoot,
      // Sweep would never fire within the test window — we prove the hook
      // path is what drives processing.
      pollIntervalMs: 10_000_000,
      fetchImpl,
      logger: silentLogger,
    });
    registerTranscriptionHook(hooks, worker, () => "default");

    try {
      const start = Date.now();
      await hookedStore.addAttachment("h1", "memos/h1.webm", "audio/webm", {
        transcribe_status: "pending",
      });

      // Poll for completion rather than sleep-and-hope — `queueMicrotask` +
      // semaphore acquire + a faked fetch round-trip is well under 50ms but
      // not zero.
      const deadline = start + 500;
      while (Date.now() < deadline) {
        const [att] = await hookedStore.getAttachments("h1");
        if (att?.metadata?.transcribe_status === "done") break;
        await new Promise((r) => setTimeout(r, 5));
      }
      const elapsed = Date.now() - start;

      expect(callCount).toBe(1);
      expect(elapsed).toBeLessThan(500);

      const [att] = await hookedStore.getAttachments("h1");
      expect(att!.metadata?.transcribe_status).toBe("done");
      expect(att!.metadata?.transcript).toBe("hook-path");

      const note = await hookedStore.getNote("h1");
      expect(note!.content).toBe("hook-path");
    } finally {
      await worker.stop();
      await hooks.drain();
    }
  });

  test("sweep still catches a backoff-queued item after its backoff elapses", async () => {
    await hookedStore.createNote("stub", { id: "h2", metadata: { transcribe_stub: true } });
    seedAudio("memos/h2.webm");

    // Seed an attachment already in backoff, but with a backoff window that
    // has already elapsed — the sweep should pick it up on the next tick.
    // The hook is registered below, AFTER this insert, so the dispatch at
    // addAttachment time has no subscribers and the event-driven path is
    // never taken. What drives the completion is `worker.tick()` alone.
    const past = new Date(Date.now() - 1_000).toISOString();
    await hookedStore.addAttachment("h2", "memos/h2.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_attempts: 1,
      transcribe_backoff_until: past,
    });

    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ text: "sweep-recovered" }), { status: 200 });
    }) as unknown as typeof fetch;

    const worker = startTranscriptionWorker({
      vaultList: () => ["default"],
      getStore: () => hookedStore as unknown as Store,
      scribeUrl: "http://scribe.test",
      resolveAssetsDir: () => assetsRoot,
      pollIntervalMs: 10_000_000,
      fetchImpl,
      logger: silentLogger,
    });
    // Hook is registered but won't fire (no new addAttachment inside this
    // test window). The sweep is what we're exercising.
    registerTranscriptionHook(hooks, worker, () => "default");

    try {
      const processed = await worker.tick();
      expect(processed).toBe(1);
      expect(calls).toBe(1);

      const [att] = await hookedStore.getAttachments("h2");
      expect(att!.metadata?.transcribe_status).toBe("done");
      expect(att!.metadata?.transcript).toBe("sweep-recovered");
    } finally {
      await worker.stop();
      await hooks.drain();
    }
  });

  test("back-compat: pending status set without dispatching a hook is picked up by the sweep", async () => {
    // Simulate a row inserted by something other than the hooked store —
    // e.g., a restart resumes with a pre-existing pending attachment, or a
    // migration/backfill that writes directly. The sweep must still drain
    // it even though no `attachment:created` event was dispatched.
    await hookedStore.createNote("stub", { id: "h3", metadata: { transcribe_stub: true } });
    seedAudio("memos/h3.webm");

    // Insert the attachment directly via raw SQL so no hook dispatches.
    const now = new Date().toISOString();
    hookedDb
      .prepare(
        "INSERT INTO attachments (id, note_id, path, mime_type, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "att-h3",
        "h3",
        "memos/h3.webm",
        "audio/webm",
        JSON.stringify({ transcribe_status: "pending" }),
        now,
      );

    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ text: "back-compat-sweep" }), { status: 200 });
    }) as unknown as typeof fetch;

    const worker = startTranscriptionWorker({
      vaultList: () => ["default"],
      getStore: () => hookedStore as unknown as Store,
      scribeUrl: "http://scribe.test",
      resolveAssetsDir: () => assetsRoot,
      pollIntervalMs: 10_000_000,
      fetchImpl,
      logger: silentLogger,
    });
    registerTranscriptionHook(hooks, worker, () => "default");

    try {
      // No hook fires — row was inserted via raw SQL. Prove the hook is idle.
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toBe(0);

      // Sweep tick drains it.
      const processed = await worker.tick();
      expect(processed).toBe(1);
      expect(calls).toBe(1);

      const [att] = await hookedStore.getAttachments("h3");
      expect(att!.metadata?.transcribe_status).toBe("done");
      expect(att!.metadata?.transcript).toBe("back-compat-sweep");
    } finally {
      await worker.stop();
      await hooks.drain();
    }
  });
});
