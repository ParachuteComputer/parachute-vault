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
  // Override the store the worker sees (race-injection tests wrap `store`).
  store?: Store;
  logger?: { error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
}) {
  const workerStore = opts.store ?? (store as unknown as Store);
  return startTranscriptionWorker({
    vaultList: () => ["default"],
    getStore: () => workerStore,
    scribeUrl: "http://scribe.test",
    resolveAssetsDir: () => assetsRoot,
    getAudioRetention: () => opts.retention ?? "keep",
    pollIntervalMs: 10_000_000, // never auto-fire; tests drive ticks manually
    maxAttempts: opts.maxAttempts ?? 3,
    fetchImpl: opts.fetchImpl,
    logger: opts.logger ?? silentLogger,
  });
}

/**
 * Wrap a store so the first `interfereTimes` `updateNote` calls carrying an
 * `if_updated_at` precondition fire `userEdit()` (a concurrent user write that
 * bumps `updated_at`) just before delegating — forcing the precondition stale
 * exactly that many times. Non-OC writes (and the last-resort no-precondition
 * write) pass straight through. Drives the vault#435 worker race tests.
 *
 * NOTE: duplicated in src/vault.test.ts (routes-layer race tests) — keep in sync.
 */
function withRace(
  base: Store,
  interfereTimes: number,
  userEdit: () => Promise<void>,
): Store {
  let fired = 0;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "updateNote") {
        return async (id: string, updates: any) => {
          if (updates?.if_updated_at !== undefined && fired < interfereTimes) {
            fired++;
            // bun:sqlite stamps `updated_at` at ms granularity. Sleep so the
            // concurrent user write lands at a strictly-greater timestamp than
            // the precondition the worker captured — making the conflict
            // deterministic rather than racing inside the same millisecond.
            await new Promise((r) => setTimeout(r, 5));
            await userEdit();
          }
          return (target as any).updateNote(id, updates);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Store;
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

  test("injected provider (scribe-fold 2a): worker routes audio→text through it, not scribe-http", async () => {
    const note = await store.createNote(
      "# 🎙️ Voice memo\n\n_Transcript pending._\n",
      { id: "n1cpp", metadata: { transcribe_stub: true } },
    );
    seedAudio("memos/cpp.webm");
    await store.addAttachment(note.id, "memos/cpp.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    // A fake local provider (stands in for transcribe-cpp). If the worker used
    // it, the note gets this text; a `fetchImpl` that throws proves scribe-http
    // was NOT called.
    let called = 0;
    const provider = {
      name: "transcribe-cpp",
      available: async () => ({ ok: true }),
      transcribe: async () => {
        called++;
        return { text: "local transcript" };
      },
    };
    const worker = startTranscriptionWorker({
      vaultList: () => ["default"],
      getStore: () => store as unknown as Store,
      resolveAssetsDir: () => assetsRoot,
      provider,
      fetchImpl: (() => {
        throw new Error("scribe-http must not be called when a provider is injected");
      }) as unknown as typeof fetch,
      pollIntervalMs: 10_000_000,
      logger: silentLogger,
    });
    try {
      expect(await worker.tick()).toBe(1);
    } finally {
      await worker.stop();
    }

    expect(called).toBe(1);
    const updated = await store.getNote("n1cpp");
    expect(updated!.content).toBe("# 🎙️ Voice memo\n\nlocal transcript\n");
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
    // Voice memos have a path in production, so the empty-content path is
    // legitimate (paired with the stub marker, the worker fills the body
    // when the transcript lands). The Store's empty-note invariant (#213)
    // requires content OR path; this is the path-only case.
    await store.createNote("", {
      id: "n3",
      path: "memos/n3",
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

  test("terminal failure with stub=true → note shows 'Transcription unavailable' and stub is cleared", async () => {
    // Mirrors Lens's voice-memo stub shape: note with placeholder body and
    // transcribe_stub marker, attachment pre-loaded near the retry limit.
    await store.createNote(
      "# 🎙️ Voice memo\n\n_Transcript pending._\n",
      { id: "unavail1", metadata: { transcribe_stub: true } },
    );
    seedAudio("memos/unavail1.webm");
    await store.addAttachment("unavail1", "memos/unavail1.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_attempts: 2,
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ error: "scribe down hard", status: 500 }]),
      maxAttempts: 3,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const note = await store.getNote("unavail1");
    expect(note!.content).toBe("# 🎙️ Voice memo\n\n_Transcription unavailable._\n");
    expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();

    const [att] = await store.getAttachments("unavail1");
    expect(att!.metadata?.transcribe_status).toBe("failed");
    expect(att!.metadata?.transcribe_error).toContain("scribe down hard");
  });

  test("audio-not-found with stub=true → note shows 'Transcription unavailable' and stub is cleared", async () => {
    await store.createNote(
      "# 🎙️ Voice memo\n\n_Transcript pending._\n",
      { id: "unavail2", metadata: { transcribe_stub: true } },
    );
    // No seedAudio — the file is deliberately missing.
    await store.addAttachment("unavail2", "memos/gone.webm", "audio/webm", {
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

    // Scribe was never called — audio-missing check short-circuits before
    // the network call, same as before. What's new is the note rewrite.
    expect(called).toBe(0);

    const note = await store.getNote("unavail2");
    expect(note!.content).toBe("# 🎙️ Voice memo\n\n_Transcription unavailable._\n");
    expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();

    const [att] = await store.getAttachments("unavail2");
    expect(att!.metadata?.transcribe_status).toBe("failed");
    expect(att!.metadata?.transcribe_error).toContain("audio file not found");
  });

  test("terminal failure with stub=false → note content is NOT touched", async () => {
    // User edited the note after upload, which cleared the stub marker.
    // Worker must not clobber their edit even though transcription failed.
    await store.createNote("my own words", { id: "unavail3" });
    seedAudio("memos/unavail3.webm");
    await store.addAttachment("unavail3", "memos/unavail3.webm", "audio/webm", {
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

    const note = await store.getNote("unavail3");
    expect(note!.content).toBe("my own words");

    const [att] = await store.getAttachments("unavail3");
    expect(att!.metadata?.transcribe_status).toBe("failed");
  });

  test("FIFO: oldest pending is processed first", async () => {
    // Seed the placeholder body so the transcript patches in place (the real
    // capture shape); ordering is what this test verifies.
    await store.createNote("_Transcript pending._", { id: "f1", metadata: { transcribe_stub: true } });
    await store.createNote("_Transcript pending._", { id: "f2", metadata: { transcribe_stub: true } });
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

// ---------------------------------------------------------------------------
// Optimistic concurrency on the worker's note writes (vault#435).
//
// The worker patches the memo note in two read-modify-write cycles — the
// success path (replace the placeholder/marker with the transcript) and the
// failure path (`applyFailureMarker`). Without an `if_updated_at` precondition
// a user edit landing between read and write is silently clobbered (the
// static-write/stale-read class of vault#208). These tests inject a concurrent
// user PATCH right before the worker's OC write to assert:
//   (a) the user's edit is NOT clobbered,
//   (b) the worker RE-APPLIES the transcript/marker correctly on fresh content,
//   (c) the double-conflict policy (worker = resilient): last-resort apply when
//       still safe, safe-skip otherwise — never crash the sweep.
// ---------------------------------------------------------------------------
describe("transcription worker — optimistic concurrency (vault#435)", () => {
  test("success patch: single race → re-applies transcript onto the user's fresh content", async () => {
    // Placeholder body so the transcript would normally surgical-replace in
    // place. The user appends a line mid-flight; the worker's first OC write
    // conflicts, it re-reads, and the surgical replace lands on the FRESH
    // content — preserving the user's append.
    await store.createNote(
      "# memo\n\n_Transcript pending._\n",
      { id: "oc-succ-1", metadata: { transcribe_stub: true } },
    );
    seedAudio("memos/ocs1.webm");
    await store.addAttachment("oc-succ-1", "memos/ocs1.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const raceStore = withRace(store as unknown as Store, 1, async () => {
      await store.updateNote("oc-succ-1", { append: "\n\nUSER EDIT" });
    });
    const worker = makeWorker({
      store: raceStore,
      fetchImpl: mkFetchMock([{ text: "the transcript" }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const note = await store.getNote("oc-succ-1");
    // (b) transcript replaced the placeholder in place; (a) user edit survives.
    expect(note!.content).toBe("# memo\n\nthe transcript\n\n\nUSER EDIT");
    expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();
    const [att] = await store.getAttachments("oc-succ-1");
    expect(att.metadata?.transcribe_status).toBe("done");
    expect(att.metadata?.transcript).toBe("the transcript");
  });

  test("failure marker: single race → re-applies marker onto the user's fresh content", async () => {
    // maxAttempts=1 so a single scribe failure is terminal → applyFailureMarker.
    await store.createNote(
      "# memo\n\n_Transcript pending._\n",
      { id: "oc-fail-1", metadata: { transcribe_stub: true } },
    );
    seedAudio("memos/ocf1.webm");
    await store.addAttachment("oc-fail-1", "memos/ocf1.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const raceStore = withRace(store as unknown as Store, 1, async () => {
      await store.updateNote("oc-fail-1", { append: "\n\nUSER EDIT" });
    });
    const worker = makeWorker({
      store: raceStore,
      maxAttempts: 1,
      fetchImpl: mkFetchMock([{ error: "scribe down", status: 500 }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const note = await store.getNote("oc-fail-1");
    // (b) marker replaced the placeholder in place; (a) user edit survives.
    expect(note!.content).toBe("# memo\n\n_Transcription unavailable._\n\n\nUSER EDIT");
    expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();
    const [att] = await store.getAttachments("oc-fail-1");
    expect(att.metadata?.transcribe_status).toBe("failed");
  });

  test("double conflict + still safe → last-resort apply (append path stays applicable)", async () => {
    // No placeholder in the body → the transform takes the APPEND branch, which
    // is always safe against fresh content. Interfere on BOTH the first write
    // and the retry write → the worker falls back to the precondition-less
    // last-resort apply (safe because the stub survives + append is safe).
    await store.createNote(
      "user prose with no marker",
      { id: "oc-dbl-safe", metadata: { transcribe_stub: true } },
    );
    seedAudio("memos/ocd1.webm");
    await store.addAttachment("oc-dbl-safe", "memos/ocd1.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    let edits = 0;
    const raceStore = withRace(store as unknown as Store, 2, async () => {
      edits++;
      await store.updateNote("oc-dbl-safe", { append: ` e${edits}` });
    });
    const worker = makeWorker({
      store: raceStore,
      fetchImpl: mkFetchMock([{ text: "TRANSCRIPT" }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const note = await store.getNote("oc-dbl-safe");
    // (a) both user appends survive; (c) transcript still appended (last-resort).
    expect(note!.content).toBe("user prose with no marker e1 e2\n\nTRANSCRIPT");
    expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();
  });

  test("double conflict + unsafe (user cleared the stub) → safe-skip, note untouched", async () => {
    // The racing user edit clears `transcribe_stub` → the last-resort safety
    // gate refuses to blind-write. The worker skips the note write entirely
    // and the user's content is left exactly as they left it. The attachment
    // transcript is still recorded (we never throw work away).
    await store.createNote(
      "# memo\n\n_Transcript pending._\n",
      { id: "oc-dbl-skip", metadata: { transcribe_stub: true } },
    );
    seedAudio("memos/ocd2.webm");
    await store.addAttachment("oc-dbl-skip", "memos/ocd2.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    let edit = 0;
    const raceStore = withRace(store as unknown as Store, 2, async () => {
      edit++;
      // Second interference clears the stub (user opts out mid-flight).
      if (edit >= 2) {
        await store.updateNote("oc-dbl-skip", {
          content: "I took this note over",
          metadata: {},
        });
      } else {
        await store.updateNote("oc-dbl-skip", { append: " edit1" });
      }
    });
    const worker = makeWorker({
      store: raceStore,
      fetchImpl: mkFetchMock([{ text: "WOULD CLOBBER" }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const note = await store.getNote("oc-dbl-skip");
    // (c) safe-skip: the worker did NOT overwrite the user's takeover content.
    expect(note!.content).toBe("I took this note over");
    expect(note!.content).not.toContain("WOULD CLOBBER");
    // Transcript still durable on the attachment row.
    const [att] = await store.getAttachments("oc-dbl-skip");
    expect(att.metadata?.transcribe_status).toBe("done");
    expect(att.metadata?.transcript).toBe("WOULD CLOBBER");
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
    // Placeholder body so the transcript patches in place (real capture shape).
    await hookedStore.createNote("_Transcript pending._", { id: "h1", metadata: { transcribe_stub: true } });
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

// ---------------------------------------------------------------------------
// vault#353 — auto-origin path: materialize <attachment-path>.transcript.md
// notes on success AND on terminal failure (so the retry endpoint has a
// surface to act on). The legacy `transcribe_stub`-patching path remains
// unchanged; these tests pin the new behavior for attachments stamped with
// `transcribe_origin: "auto"`.
// ---------------------------------------------------------------------------

describe("transcription worker — auto-origin (vault#353)", () => {
  test("success: materializes <path>.transcript with frontmatter + body", async () => {
    const owner = await store.createNote("# Voice memo\n", { id: "auto-1" });
    seedAudio("memos/auto-1.webm");
    await store.addAttachment(owner.id, "memos/auto-1.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_origin: "auto",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "this is the spoken text" }]),
    });
    try {
      const processed = await worker.tick();
      expect(processed).toBe(1);
    } finally {
      await worker.stop();
    }

    // The transcript note exists, with the expected shape.
    const transcript = await store.getNoteByPath("memos/auto-1.webm.transcript");
    expect(transcript).not.toBeNull();
    expect(transcript!.content).toBe("this is the spoken text");
    expect(transcript!.tags).toContain("transcript");
    expect((transcript!.metadata as any)?.transcript_status).toBe("complete");
    expect((transcript!.metadata as any)?.transcript_of).toBe("memos/auto-1.webm");
    expect(typeof (transcript!.metadata as any)?.transcript_duration_ms).toBe("number");

    // Source note is NOT touched (no stub patching on auto-origin).
    const sourceNote = await store.getNote("auto-1");
    expect(sourceNote!.content).toBe("# Voice memo\n");

    // Attachment row also reflects success — sweep + retry hit the same row.
    const [att] = await store.getAttachments(owner.id);
    expect(att.metadata?.transcribe_status).toBe("done");
  });

  test("missing_provider 400: terminal failure on first try → failed transcript note", async () => {
    const owner = await store.createNote("# Voice memo\n", { id: "auto-mp" });
    seedAudio("memos/auto-mp.webm");
    await store.addAttachment(owner.id, "memos/auto-mp.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_origin: "auto",
    });

    // Custom fetchImpl that returns the structured 400 missing_provider
    // payload (scribe#47 shape).
    const fetchImpl: typeof fetch = (async () => {
      return new Response(
        JSON.stringify({
          error: "no transcription provider configured",
          error_code: "missing_provider",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const worker = makeWorker({ fetchImpl, maxAttempts: 5 });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const transcript = await store.getNoteByPath("memos/auto-mp.webm.transcript");
    expect(transcript).not.toBeNull();
    expect(transcript!.content).toBe("");
    expect((transcript!.metadata as any)?.transcript_status).toBe("failed");
    expect((transcript!.metadata as any)?.transcript_error).toContain("missing_provider");

    // 4xx is terminal — attempts tracked but status went straight to failed,
    // not parked in pending with backoff.
    const [att] = await store.getAttachments(owner.id);
    expect(att.metadata?.transcribe_status).toBe("failed");
    expect((att.metadata as any)?.transcribe_error_code).toBe("missing_provider");
  });

  test("5xx timeout: retries with backoff (NOT terminal on first failure)", async () => {
    const owner = await store.createNote("# Voice memo\n", { id: "auto-503" });
    seedAudio("memos/auto-503.webm");
    await store.addAttachment(owner.id, "memos/auto-503.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_origin: "auto",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ error: "upstream timeout", status: 503 }]),
      maxAttempts: 3,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    // 5xx is retriable — attachment goes back to pending with backoff.
    // The transcript note is NOT materialized yet (the failure isn't terminal
    // and we don't want to surface intermediate failures to the user).
    const [att] = await store.getAttachments(owner.id);
    expect(att.metadata?.transcribe_status).toBe("pending");
    expect(att.metadata?.transcribe_backoff_until).toBeTruthy();

    const transcript = await store.getNoteByPath("memos/auto-503.webm.transcript");
    expect(transcript).toBeNull();
  });

  test("audio gone: terminal failure → failed transcript note materialized", async () => {
    const owner = await store.createNote("# Voice memo\n", { id: "auto-gone" });
    // No seedAudio call — the file is missing.
    await store.addAttachment(owner.id, "memos/auto-gone.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_origin: "auto",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "should never run" }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const transcript = await store.getNoteByPath("memos/auto-gone.webm.transcript");
    expect(transcript).not.toBeNull();
    expect((transcript!.metadata as any)?.transcript_status).toBe("failed");
    expect((transcript!.metadata as any)?.transcript_error).toBe("audio file not found");
  });

  test("legacy stub flow unchanged: no transcript note materialized for transcribe_stub-only", async () => {
    await store.createNote(
      "# Voice\n\n_Transcript pending._\n",
      { id: "legacy-1", metadata: { transcribe_stub: true } },
    );
    seedAudio("memos/legacy-1.webm");
    await store.addAttachment("legacy-1", "memos/legacy-1.webm", "audio/webm", {
      transcribe_status: "pending",
      // Legacy path: NO transcribe_origin: "auto".
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "stub-patched" }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    // The note body was patched in place (legacy behavior).
    const note = await store.getNote("legacy-1");
    expect(note!.content).toBe("# Voice\n\nstub-patched\n");

    // No transcript note was created.
    const transcript = await store.getNoteByPath("memos/legacy-1.webm.transcript");
    expect(transcript).toBeNull();
  });

  test("retry path: failed transcript is overwritten in place on success", async () => {
    const owner = await store.createNote("# Voice memo\n", { id: "auto-retry" });
    seedAudio("memos/auto-retry.webm");
    await store.addAttachment(owner.id, "memos/auto-retry.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_origin: "auto",
    });

    // Pass 1: missing_provider failure → failed transcript note materialized.
    const fetch400: typeof fetch = (async () => {
      return new Response(
        JSON.stringify({ error: "missing", error_code: "missing_provider" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const worker1 = makeWorker({ fetchImpl: fetch400 });
    try { await worker1.tick(); } finally { await worker1.stop(); }

    const failed = await store.getNoteByPath("memos/auto-retry.webm.transcript");
    expect(failed).not.toBeNull();
    const failedId = failed!.id;
    expect((failed!.metadata as any)?.transcript_status).toBe("failed");

    // Pass 2: re-enqueue by flipping the attachment back to pending (this is
    // what the retry endpoint does) + give scribe a successful response.
    const [att] = await store.getAttachments(owner.id);
    await store.setAttachmentMetadata(att.id, {
      ...(att.metadata ?? {}),
      transcribe_status: "pending",
      transcribe_origin: "auto",
    });
    const worker2 = makeWorker({
      fetchImpl: mkFetchMock([{ text: "second time's the charm" }]),
    });
    try { await worker2.tick(); } finally { await worker2.stop(); }

    const success = await store.getNoteByPath("memos/auto-retry.webm.transcript");
    expect(success).not.toBeNull();
    // Same note id — updated in place, not a fresh row.
    expect(success!.id).toBe(failedId);
    expect(success!.content).toBe("second time's the charm");
    expect((success!.metadata as any)?.transcript_status).toBe("complete");
    expect((success!.metadata as any)?.transcript_error).toBeUndefined();
  });

  test("concurrent uploads: 5 audio files yield 5 transcript notes (no path collision)", async () => {
    const owners: string[] = [];
    for (let i = 0; i < 5; i++) {
      const note = await store.createNote(`# Voice ${i}\n`, { id: `concurrent-${i}` });
      owners.push(note.id);
      seedAudio(`memos/concurrent-${i}.webm`);
      await store.addAttachment(note.id, `memos/concurrent-${i}.webm`, "audio/webm", {
        transcribe_status: "pending",
        transcribe_origin: "auto",
      });
    }

    // Same transcript body to each. The worker drains FIFO.
    const worker = makeWorker({
      fetchImpl: mkFetchMock([
        { text: "transcript-0" },
        { text: "transcript-1" },
        { text: "transcript-2" },
        { text: "transcript-3" },
        { text: "transcript-4" },
      ]),
    });
    try {
      const processed = await worker.tick();
      expect(processed).toBe(5);
    } finally {
      await worker.stop();
    }

    // 5 transcript notes — one per audio file. The bodies map to FIFO order;
    // we just assert each note exists with `complete` status.
    for (let i = 0; i < 5; i++) {
      const t = await store.getNoteByPath(`memos/concurrent-${i}.webm.transcript`);
      expect(t).not.toBeNull();
      expect((t!.metadata as any)?.transcript_status).toBe("complete");
    }
  });
});

// ---------------------------------------------------------------------------
// finding F — never destroy content on the legacy in-body memo path. These
// fixtures carry the `![[<audio>]]` embed (the REAL production capture shape
// from recorder.ts memoNoteContent), which the pre-existing failure tests all
// omitted — which is why the data-loss branch went uncaught.
// ---------------------------------------------------------------------------

describe("transcription worker — legacy in-body memo content safety (finding F)", () => {
  // Canonical capture body: header + _Recorded_ + placeholder + ![[embed]].
  const captureBody = (audio: string) =>
    `# 🎙️ Voice memo\n\n_Recorded sometime._\n\n_Transcript pending._\n\n![[${audio}]]\n`;

  test("failure with placeholder present → marker replaces placeholder, embed intact", async () => {
    await store.createNote(captureBody("memos/f1.webm"), {
      id: "f-marker-1",
      metadata: { transcribe_stub: true },
    });
    seedAudio("memos/f1.webm");
    await store.addAttachment("f-marker-1", "memos/f1.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_attempts: 2,
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ error: "scribe down", status: 500 }]),
      maxAttempts: 3,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const note = await store.getNote("f-marker-1");
    expect(note!.content).toBe(
      "# 🎙️ Voice memo\n\n_Recorded sometime._\n\n_Transcription unavailable._\n\n![[memos/f1.webm]]\n",
    );
    // Embed survives — the whole point.
    expect(note!.content).toContain("![[memos/f1.webm]]");
    expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();
  });

  test("failure with placeholder ABSENT (user-edited body + embed) → marker APPENDED, content preserved", async () => {
    // The data-loss regression: user edited the note while pending, removing
    // the _Transcript pending._ placeholder but keeping their text + the
    // embed. The old code full-replaced the body with the bare marker here,
    // destroying both. Now we append.
    const editedBody = "# 🎙️ My trip notes\n\nWent to the coast today.\n\n![[memos/f2.webm]]\n";
    await store.createNote(editedBody, {
      id: "f-marker-2",
      metadata: { transcribe_stub: true },
    });
    seedAudio("memos/f2.webm");
    await store.addAttachment("f-marker-2", "memos/f2.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_attempts: 2,
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ error: "scribe down", status: 500 }]),
      maxAttempts: 3,
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const note = await store.getNote("f-marker-2");
    // User text + embed preserved; marker appended.
    expect(note!.content).toBe(`${editedBody}\n\n_Transcription unavailable._`);
    expect(note!.content).toContain("Went to the coast today.");
    expect(note!.content).toContain("![[memos/f2.webm]]");
    expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();
  });

  test("double terminal failure → exactly one marker (idempotent, no stacking)", async () => {
    // First failure writes the marker + clears the stub. Re-arm the stub and
    // fail again — the marker must NOT stack. (Re-arming models a retry that
    // fails again.)
    await store.createNote(captureBody("memos/f3.webm"), {
      id: "f-marker-3",
      metadata: { transcribe_stub: true },
    });
    seedAudio("memos/f3.webm");
    await store.addAttachment("f-marker-3", "memos/f3.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_attempts: 2,
    });

    const worker1 = makeWorker({
      fetchImpl: mkFetchMock([{ error: "down", status: 500 }]),
      maxAttempts: 3,
    });
    try { await worker1.tick(); } finally { await worker1.stop(); }

    // Re-arm stub + reset attachment to pending (what a retry does), then fail again.
    const note1 = await store.getNote("f-marker-3");
    await store.updateNote("f-marker-3", {
      metadata: { ...((note1!.metadata as any) ?? {}), transcribe_stub: true },
      skipUpdatedAt: true,
    });
    const [att] = await store.getAttachments("f-marker-3");
    await store.setAttachmentMetadata(att.id, {
      ...(att.metadata ?? {}),
      transcribe_status: "pending",
      transcribe_attempts: 2,
    });

    const worker2 = makeWorker({
      fetchImpl: mkFetchMock([{ error: "down again", status: 500 }]),
      maxAttempts: 3,
    });
    try { await worker2.tick(); } finally { await worker2.stop(); }

    const note = await store.getNote("f-marker-3");
    const occurrences = note!.content.split("_Transcription unavailable._").length - 1;
    expect(occurrences).toBe(1);
    expect(note!.content).toContain("![[memos/f3.webm]]");
  });

  test("success with placeholder absent (stub set) → transcript appended, content preserved", async () => {
    // Mirror of the failure-append case, on the success path. User edited the
    // note (cleared the placeholder) but kept the stub. The old code
    // full-replaced the body with the bare transcript; now we append.
    const editedBody = "# 🎙️ My trip notes\n\nWent to the coast today.\n\n![[memos/f4.webm]]\n";
    await store.createNote(editedBody, {
      id: "f-success-1",
      metadata: { transcribe_stub: true },
    });
    seedAudio("memos/f4.webm");
    await store.addAttachment("f-success-1", "memos/f4.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "the spoken transcript" }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const note = await store.getNote("f-success-1");
    expect(note!.content).toBe(`${editedBody}\n\nthe spoken transcript`);
    expect(note!.content).toContain("Went to the coast today.");
    expect(note!.content).toContain("![[memos/f4.webm]]");
    expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();
  });

  test("first-try success with placeholder present + embed → transcript replaces placeholder in place", async () => {
    // Pins the canonical first-try-success shape the retry round-trip must match.
    await store.createNote(captureBody("memos/f5.webm"), {
      id: "f-success-2",
      metadata: { transcribe_stub: true },
    });
    seedAudio("memos/f5.webm");
    await store.addAttachment("f-success-2", "memos/f5.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: "the spoken words" }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const note = await store.getNote("f-success-2");
    expect(note!.content).toBe(
      "# 🎙️ Voice memo\n\n_Recorded sometime._\n\nthe spoken words\n\n![[memos/f5.webm]]\n",
    );
  });

  test("transcript containing `$&` round-trips byte-identical (no String.replace injection) — first-try success", async () => {
    // Regression: String.replace with a STRING replacement treats `$&` etc. as
    // special. A transcript with `$&` must land verbatim in the body, not as
    // the matched marker text.
    const dollarTranscript = "it matched $& exactly, and $1 too, plus $` and $'";
    await store.createNote(captureBody("memos/f6.webm"), {
      id: "f-dollar-1",
      metadata: { transcribe_stub: true },
    });
    seedAudio("memos/f6.webm");
    await store.addAttachment("f-dollar-1", "memos/f6.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({
      fetchImpl: mkFetchMock([{ text: dollarTranscript }]),
    });
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const note = await store.getNote("f-dollar-1");
    expect(note!.content).toBe(
      `# 🎙️ Voice memo\n\n_Recorded sometime._\n\n${dollarTranscript}\n\n![[memos/f6.webm]]\n`,
    );
    // Belt-and-suspenders: the literal `$&` must be present verbatim.
    expect(note!.content).toContain("it matched $& exactly");
  });

  test("transcript containing `$&` round-trips byte-identical on the RETRY path (marker → transcript)", async () => {
    // Same injection guard, but exercised on the retry surgical-replace: the
    // transcript replaces `_Transcription unavailable._` in place.
    const dollarTranscript = "retry text with $& and $0 and $$ literal";
    await store.createNote(captureBody("memos/f7.webm"), {
      id: "f-dollar-2",
      metadata: { transcribe_stub: true },
    });
    seedAudio("memos/f7.webm");
    await store.addAttachment("f-dollar-2", "memos/f7.webm", "audio/webm", {
      transcribe_status: "pending",
      transcribe_attempts: 2, // one more failure → terminal at maxAttempts=3
    });

    // Phase 1: terminal failure → marker replaces placeholder.
    const worker1 = makeWorker({
      fetchImpl: mkFetchMock([{ error: "down", status: 500 }]),
      maxAttempts: 3,
    });
    try { await worker1.tick(); } finally { await worker1.stop(); }
    const failed = await store.getNote("f-dollar-2");
    expect(failed!.content).toContain("_Transcription unavailable._");

    // Re-arm stub + reset attachment (what the retry route does).
    await store.updateNote("f-dollar-2", {
      metadata: { ...((failed!.metadata as any) ?? {}), transcribe_stub: true },
      skipUpdatedAt: true,
    });
    const [att] = await store.getAttachments("f-dollar-2");
    await store.setAttachmentMetadata(att.id, {
      ...(att.metadata ?? {}),
      transcribe_status: "pending",
    });

    // Phase 2: success with a `$&`-bearing transcript → replaces the marker.
    const worker2 = makeWorker({
      fetchImpl: mkFetchMock([{ text: dollarTranscript }]),
    });
    try { await worker2.tick(); } finally { await worker2.stop(); }

    const note = await store.getNote("f-dollar-2");
    expect(note!.content).toBe(
      `# 🎙️ Voice memo\n\n_Recorded sometime._\n\n${dollarTranscript}\n\n![[memos/f7.webm]]\n`,
    );
    expect(note!.content).toContain("retry text with $& and $0 and $$ literal");
  });
});

// ---------------------------------------------------------------------------
// voice W2 — segmented recordings. The app slices a long recording into
// ~10-min segments, each linked as its own attachment on ONE note carrying a
// client-set `segment_index` (0-based). The legacy in-body path targets that
// part's markers — `_Transcript pending (part N)._` / `_Transcription
// unavailable (part N)._`, N = segment_index + 1 — so each transcript lands in
// its own pre-allocated slot regardless of completion order. Marker strings
// are a BYTE-EXACT cross-door + cross-repo contract (the cloud worker ships
// the identical text), so these assertions pin the exact bytes.
// ---------------------------------------------------------------------------

describe("transcription worker — segmented recordings (voice W2)", () => {
  test("three parts completing OUT OF ORDER (2 ok, 0 fails, 1 ok) each land in their own slot", async () => {
    // One note, three pre-allocated part slots + the shared stub opt-in.
    const body =
      "# 🎙️ Voice memo\n\n" +
      "_Transcript pending (part 1)._\n\n" +
      "_Transcript pending (part 2)._\n\n" +
      "_Transcript pending (part 3)._\n";
    await store.createNote(body, { id: "seg-note", metadata: { transcribe_stub: true } });

    seedAudio("memos/seg0.webm");
    seedAudio("memos/seg1.webm");
    seedAudio("memos/seg2.webm");
    const seg0 = await store.addAttachment("seg-note", "memos/seg0.webm", "audio/webm", {
      transcribe_status: "pending",
      segment_index: 0,
    });
    const seg1 = await store.addAttachment("seg-note", "memos/seg1.webm", "audio/webm", {
      transcribe_status: "pending",
      segment_index: 1,
    });
    const seg2 = await store.addAttachment("seg-note", "memos/seg2.webm", "audio/webm", {
      transcribe_status: "pending",
      segment_index: 2,
    });

    // Complete part 3 (segment_index 2) FIRST — success.
    const w2 = makeWorker({ fetchImpl: mkFetchMock([{ text: "part three text" }]) });
    try { await w2.kick("default", seg2); } finally { await w2.stop(); }

    // Then part 1 (segment_index 0) — terminal failure (maxAttempts=1).
    const w0 = makeWorker({
      fetchImpl: mkFetchMock([{ error: "scribe down", status: 500 }]),
      maxAttempts: 1,
    });
    try { await w0.kick("default", seg0); } finally { await w0.stop(); }

    // Finally part 2 (segment_index 1) — success.
    const w1 = makeWorker({ fetchImpl: mkFetchMock([{ text: "part two text" }]) });
    try { await w1.kick("default", seg1); } finally { await w1.stop(); }

    const note = await store.getNote("seg-note");
    // Each part landed in its own slot: part 1 → failure marker, part 2/3 →
    // their transcripts, despite completing 3 → 1 → 2.
    expect(note!.content).toBe(
      "# 🎙️ Voice memo\n\n" +
      "_Transcription unavailable (part 1)._\n\n" +
      "part two text\n\n" +
      "part three text\n",
    );
    // Shared stub SURVIVES — sibling parts each needed the gate open; a
    // per-part clear (the un-segmented behavior) would have blocked parts 2 & 3.
    expect((note!.metadata as any)?.transcribe_stub).toBe(true);

    // Attachment rows reflect their individual outcomes.
    const atts = await store.getAttachments("seg-note");
    const byIndex = Object.fromEntries(atts.map((a) => [a.metadata?.segment_index, a]));
    expect(byIndex[0]!.metadata?.transcribe_status).toBe("failed");
    expect(byIndex[1]!.metadata?.transcribe_status).toBe("done");
    expect(byIndex[1]!.metadata?.transcript).toBe("part two text");
    expect(byIndex[2]!.metadata?.transcribe_status).toBe("done");
    expect(byIndex[2]!.metadata?.transcript).toBe("part three text");
  });

  test("un-segmented attachment → BARE markers, one-shot stub cleared (regression pin)", async () => {
    // No `segment_index` → byte-for-byte the pre-W2 behavior: replace the bare
    // placeholder, clear the stub. A stray `(part N)` marker in the body is
    // left untouched (the bare path never targets part markers).
    await store.createNote(
      "# 🎙️ Voice memo\n\n_Transcript pending._\n\n_Transcript pending (part 2)._\n",
      { id: "unseg-note", metadata: { transcribe_stub: true } },
    );
    seedAudio("memos/unseg.webm");
    const att = await store.addAttachment("unseg-note", "memos/unseg.webm", "audio/webm", {
      transcribe_status: "pending",
    });

    const worker = makeWorker({ fetchImpl: mkFetchMock([{ text: "bare transcript" }]) });
    try { await worker.kick("default", att); } finally { await worker.stop(); }

    const note = await store.getNote("unseg-note");
    // Bare marker replaced; the part-2 marker is NOT touched by the bare path.
    expect(note!.content).toBe(
      "# 🎙️ Voice memo\n\nbare transcript\n\n_Transcript pending (part 2)._\n",
    );
    // One-shot stub cleared, exactly as today.
    expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();
  });

  test("malformed segment_index falls back to bare markers (contract: integer ≥ 0)", async () => {
    // A non-integer / negative `segment_index` must NOT fabricate a `(part N)`
    // marker — it degrades to the bare path (fully backward compatible).
    await store.createNote(
      "# 🎙️ Voice memo\n\n_Transcript pending._\n",
      { id: "seg-bad", metadata: { transcribe_stub: true } },
    );
    seedAudio("memos/segbad.webm");
    const att = await store.addAttachment("seg-bad", "memos/segbad.webm", "audio/webm", {
      transcribe_status: "pending",
      segment_index: -1, // invalid → bare path
    });

    const worker = makeWorker({ fetchImpl: mkFetchMock([{ text: "fallback transcript" }]) });
    try { await worker.kick("default", att); } finally { await worker.stop(); }

    const note = await store.getNote("seg-bad");
    expect(note!.content).toBe("# 🎙️ Voice memo\n\nfallback transcript\n");
    expect((note!.metadata as any)?.transcribe_stub).toBeUndefined();
  });

  test("segmented part whose marker was edited away → transcript appended (graceful fallback)", async () => {
    // The user rewrote part 2's slot by hand, removing its pending marker.
    // Mirror the un-segmented replace-or-append policy scoped to the part:
    // with neither of part 2's markers present, append the transcript
    // (no `(part N)` prefix) rather than destroying the user's edit.
    const editedBody =
      "# 🎙️ Voice memo\n\n" +
      "_Transcript pending (part 1)._\n\n" +
      "User rewrote part two by hand.\n";
    await store.createNote(editedBody, { id: "seg-edit", metadata: { transcribe_stub: true } });
    seedAudio("memos/segedit.webm");
    const seg1 = await store.addAttachment("seg-edit", "memos/segedit.webm", "audio/webm", {
      transcribe_status: "pending",
      segment_index: 1, // part 2
    });

    const worker = makeWorker({ fetchImpl: mkFetchMock([{ text: "the real part two" }]) });
    try { await worker.kick("default", seg1); } finally { await worker.stop(); }

    const note = await store.getNote("seg-edit");
    // Part 2's transcript appended; the user's edit + part 1's pending slot
    // both survive untouched.
    expect(note!.content).toBe(`${editedBody}\n\nthe real part two`);
    expect(note!.content).toContain("User rewrote part two by hand.");
    expect(note!.content).toContain("_Transcript pending (part 1)._");
    // Segmented → shared stub preserved (part 1 still needs the gate open).
    expect((note!.metadata as any)?.transcribe_stub).toBe(true);
  });
});
