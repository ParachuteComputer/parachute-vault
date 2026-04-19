import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BunStore } from "./vault-store.ts";
import { startTranscriptionWorker } from "./transcription-worker.ts";
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
  retention?: "keep" | "until_transcribed";
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
