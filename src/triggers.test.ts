import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { buildPredicate, registerTriggers } from "./triggers.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import type { Note, Store, Attachment } from "../core/src/types.ts";
import type { TriggerConfig } from "./config.ts";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "test-1",
    content: "hello world",
    tags: [],
    metadata: {},
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildPredicate", () => {
  it("matches when all conditions are met", () => {
    const pred = buildPredicate(
      { tags: ["reader"], has_content: true, missing_metadata: ["audio_rendered_at"] },
      "tts_reader",
    );
    const note = makeNote({ tags: ["reader"], content: "some text" });
    expect(pred(note)).toBe(true);
  });

  it("rejects when pending marker is set", () => {
    const pred = buildPredicate({ tags: ["reader"] }, "tts_reader");
    const note = makeNote({
      tags: ["reader"],
      metadata: { tts_reader_pending_at: "2025-01-01" },
    });
    expect(pred(note)).toBe(false);
  });

  it("rejects when rendered marker is set", () => {
    const pred = buildPredicate({ tags: ["reader"] }, "tts_reader");
    const note = makeNote({
      tags: ["reader"],
      metadata: { tts_reader_rendered_at: "2025-01-01" },
    });
    expect(pred(note)).toBe(false);
  });

  it("rejects when required tag is missing", () => {
    const pred = buildPredicate({ tags: ["reader"] }, "tts_reader");
    const note = makeNote({ tags: ["other"] });
    expect(pred(note)).toBe(false);
  });

  it("rejects when has_content=true and content is empty", () => {
    const pred = buildPredicate({ has_content: true }, "test");
    expect(pred(makeNote({ content: "" }))).toBe(false);
    expect(pred(makeNote({ content: "   " }))).toBe(false);
  });

  it("rejects when has_content=false and content is present", () => {
    const pred = buildPredicate({ has_content: false }, "test");
    expect(pred(makeNote({ content: "hello" }))).toBe(false);
  });

  it("matches has_content=false when content is empty", () => {
    const pred = buildPredicate({ has_content: false }, "test");
    expect(pred(makeNote({ content: "" }))).toBe(true);
  });

  it("rejects when missing_metadata key is present", () => {
    const pred = buildPredicate({ missing_metadata: ["done"] }, "test");
    const note = makeNote({ metadata: { done: true } });
    expect(pred(note)).toBe(false);
  });

  it("matches when missing_metadata key is absent", () => {
    const pred = buildPredicate({ missing_metadata: ["done"] }, "test");
    const note = makeNote({ metadata: {} });
    expect(pred(note)).toBe(true);
  });

  it("rejects when has_metadata key is absent", () => {
    const pred = buildPredicate({ has_metadata: ["source"] }, "test");
    const note = makeNote({ metadata: {} });
    expect(pred(note)).toBe(false);
  });

  it("matches when has_metadata key is present", () => {
    const pred = buildPredicate({ has_metadata: ["source"] }, "test");
    const note = makeNote({ metadata: { source: "voice" } });
    expect(pred(note)).toBe(true);
  });

  it("requires all tags to match", () => {
    const pred = buildPredicate({ tags: ["reader", "important"] }, "test");
    expect(pred(makeNote({ tags: ["reader"] }))).toBe(false);
    expect(pred(makeNote({ tags: ["reader", "important"] }))).toBe(true);
  });
});

describe("registerTriggers — dispatch modes", () => {
  let webhookServer: ReturnType<typeof Bun.serve>;
  let webhookPort: number;
  let lastRequest: { method: string; url: string; headers: Headers; body: unknown; formData?: FormData } | null = null;
  let webhookHandler: (req: Request) => Response | Promise<Response>;

  beforeAll(() => {
    webhookHandler = () => Response.json({});
    webhookServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const contentType = req.headers.get("Content-Type") ?? "";
        if (contentType.includes("json")) {
          lastRequest = { method: req.method, url: url.pathname, headers: req.headers, body: await req.json() };
        } else if (contentType.includes("multipart")) {
          const formData = await req.formData();
          lastRequest = { method: req.method, url: url.pathname, headers: req.headers, body: null, formData };
        } else {
          lastRequest = { method: req.method, url: url.pathname, headers: req.headers, body: await req.text() };
        }
        return webhookHandler(req);
      },
    });
    webhookPort = webhookServer.port;
  });

  afterAll(() => {
    webhookServer?.stop(true);
  });

  function makeMockStore(note: Note, attachments: Attachment[] = []): Store {
    const notes = new Map<string, Note>();
    notes.set(note.id, { ...note });
    const attachmentStore = new Map<string, Attachment[]>();
    attachmentStore.set(note.id, [...attachments]);

    return {
      getNote: (id: string) => notes.get(id) ?? null,
      updateNote: (id: string, updates: Record<string, unknown>) => {
        const n = notes.get(id);
        if (!n) throw new Error(`note ${id} not found`);
        if (updates.content !== undefined) n.content = updates.content as string;
        if (updates.metadata !== undefined) n.metadata = updates.metadata as Record<string, unknown>;
        notes.set(id, n);
        return n;
      },
      getAttachments: (id: string) => attachmentStore.get(id) ?? [],
      addAttachment: (noteId: string, path: string, mimeType: string, meta?: Record<string, unknown>) => {
        const att: Attachment = { id: crypto.randomUUID(), noteId, path, mimeType, metadata: meta, createdAt: new Date().toISOString() };
        const existing = attachmentStore.get(noteId) ?? [];
        existing.push(att);
        attachmentStore.set(noteId, existing);
        return att;
      },
    } as unknown as Store;
  }

  it("send=json dispatches full note payload (default behavior)", async () => {
    const hooks = new HookRegistry();
    const note = makeNote({ id: "n1", content: "hello", tags: ["test"] });
    const store = makeMockStore(note);

    webhookHandler = () => Response.json({ metadata: { processed: true } });

    registerTriggers(hooks, [{
      name: "json_test",
      when: { tags: ["test"] },
      action: { webhook: `http://127.0.0.1:${webhookPort}/hook` },
    }], { error: () => {}, info: () => {} });

    await hooks.dispatch("created", note, store);
    // Give async handler time to complete
    await new Promise(r => setTimeout(r, 50));

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.method).toBe("POST");
    const body = lastRequest!.body as Record<string, unknown>;
    expect(body.trigger).toBe("json_test");
    expect((body.note as Record<string, unknown>).content).toBe("hello");
  });

  it("send=attachment sends multipart form-data with audio file", async () => {
    const hooks = new HookRegistry();
    const note = makeNote({ id: "n2", content: "", tags: ["capture"] });

    // Create a temp audio file
    const tmpDir = `/tmp/trigger-test-${Date.now()}`;
    const { mkdirSync, writeFileSync } = await import("fs");
    mkdirSync(`${tmpDir}/2026-04-11`, { recursive: true });
    writeFileSync(`${tmpDir}/2026-04-11/recording.wav`, Buffer.from("fake-wav-bytes"));

    const attachment: Attachment = {
      id: "att-1",
      noteId: "n2",
      path: "2026-04-11/recording.wav",
      mimeType: "audio/wav",
      createdAt: "2025-01-01T00:00:00Z",
    };
    const store = makeMockStore(note, [attachment]);

    // Mock getVaultNameForStore and assetsDir to use our tmp dir
    const originalAssetsDir = process.env.ASSETS_DIR;
    process.env.ASSETS_DIR = tmpDir;

    webhookHandler = () => Response.json({ text: "transcribed content" });

    registerTriggers(hooks, [{
      name: "attachment_test",
      when: { tags: ["capture"], has_content: false },
      action: {
        webhook: `http://127.0.0.1:${webhookPort}/transcribe`,
        send: "attachment",
      },
    }], { error: () => {}, info: () => {} });

    await hooks.dispatch("created", note, store);
    await new Promise(r => setTimeout(r, 50));

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.formData).toBeDefined();
    const file = lastRequest!.formData!.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("recording.wav");

    // Verify note content was updated
    const updated = store.getNote("n2");
    expect(updated?.content).toBe("transcribed content");

    // Cleanup
    if (originalAssetsDir) process.env.ASSETS_DIR = originalAssetsDir;
    else delete process.env.ASSETS_DIR;
    const { rmSync } = await import("fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("send=content sends TTS input and saves audio response as attachment", async () => {
    const hooks = new HookRegistry();
    const note = makeNote({ id: "n3", content: "Hello world", tags: ["reader"] });
    const store = makeMockStore(note);

    const tmpDir = `/tmp/trigger-test-tts-${Date.now()}`;
    const { mkdirSync } = await import("fs");
    mkdirSync(tmpDir, { recursive: true });

    const originalAssetsDir = process.env.ASSETS_DIR;
    process.env.ASSETS_DIR = tmpDir;

    const fakeAudio = Buffer.from("fake-ogg-opus-audio");
    webhookHandler = () => new Response(fakeAudio, {
      headers: {
        "Content-Type": "audio/ogg",
        "X-TTS-Provider": "kokoro",
        "X-TTS-Voice": "af_heart",
      },
    });

    registerTriggers(hooks, [{
      name: "content_test",
      when: { tags: ["reader"], has_content: true },
      action: {
        webhook: `http://127.0.0.1:${webhookPort}/speech`,
        send: "content",
      },
    }], { error: () => {}, info: () => {} });

    await hooks.dispatch("created", note, store);
    await new Promise(r => setTimeout(r, 50));

    expect(lastRequest).not.toBeNull();
    const body = lastRequest!.body as Record<string, unknown>;
    expect(body.input).toBe("Hello world");

    // Verify attachment was created
    const attachments = store.getAttachments("n3");
    expect(attachments.length).toBe(1);
    expect(attachments[0].mimeType).toBe("audio/ogg");

    // Verify metadata includes provider info
    const updated = store.getNote("n3");
    const meta = updated?.metadata as Record<string, unknown>;
    expect(meta.tts_provider).toBe("kokoro");
    expect(meta.tts_voice).toBe("af_heart");
    expect(meta.content_test_rendered_at).toBeDefined();

    // Cleanup
    if (originalAssetsDir) process.env.ASSETS_DIR = originalAssetsDir;
    else delete process.env.ASSETS_DIR;
    const { rmSync } = await import("fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("send=attachment skips when no audio attachment exists", async () => {
    const hooks = new HookRegistry();
    const note = makeNote({ id: "n4", content: "", tags: ["capture"] });
    const store = makeMockStore(note);

    registerTriggers(hooks, [{
      name: "skip_test",
      when: { tags: ["capture"], has_content: false },
      action: {
        webhook: `http://127.0.0.1:${webhookPort}/transcribe`,
        send: "attachment",
      },
    }], { error: () => {}, info: () => {} });

    await hooks.dispatch("created", note, store);
    await new Promise(r => setTimeout(r, 50));

    const updated = store.getNote("n4");
    const meta = updated?.metadata as Record<string, unknown>;
    expect(meta.skip_test_skipped_reason).toBe("no audio attachment found");
  });

  it("send=content skips when note content is empty", async () => {
    const hooks = new HookRegistry();
    // Note: predicate has_content would normally filter this, but test the dispatch guard
    const note = makeNote({ id: "n5", content: "", tags: ["reader"] });
    const store = makeMockStore(note);

    registerTriggers(hooks, [{
      name: "empty_test",
      when: { tags: ["reader"] }, // no has_content filter — tests the dispatch guard
      action: {
        webhook: `http://127.0.0.1:${webhookPort}/speech`,
        send: "content",
      },
    }], { error: () => {}, info: () => {} });

    await hooks.dispatch("created", note, store);
    await new Promise(r => setTimeout(r, 50));

    const updated = store.getNote("n5");
    const meta = updated?.metadata as Record<string, unknown>;
    expect(meta.empty_test_skipped_reason).toBe("note has no content to synthesize");
  });
});

describe("registerTriggers — validation", () => {
  it("skips triggers with invalid webhook URLs", () => {
    const hooks = new HookRegistry();
    const errors: string[] = [];
    const logger = {
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
      info: () => {},
    };

    registerTriggers(hooks, [
      {
        name: "bad-url",
        when: { tags: ["test"] },
        action: { webhook: "not-a-url" },
      },
      {
        name: "bad-scheme",
        when: { tags: ["test"] },
        action: { webhook: "ftp://example.com/hook" },
      },
      {
        name: "good",
        when: { tags: ["test"] },
        action: { webhook: "http://localhost:8080/hook" },
      },
    ], logger);

    expect(hooks.size).toBe(1); // only "good" registered
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain("bad-url");
    expect(errors[1]).toContain("bad-scheme");
  });

  it("registers triggers with send/response modes", () => {
    const hooks = new HookRegistry();
    const infos: string[] = [];
    const logger = {
      error: () => {},
      info: (...args: unknown[]) => infos.push(args.map(String).join(" ")),
    };

    registerTriggers(hooks, [
      {
        name: "tts",
        when: { tags: ["reader"] },
        action: { webhook: "http://localhost:3100/v1/audio/speech", send: "content" },
      },
      {
        name: "transcribe",
        when: { tags: ["capture"] },
        action: { webhook: "http://localhost:3200/v1/audio/transcriptions", send: "attachment" },
      },
    ], logger);

    expect(hooks.size).toBe(2);
    expect(infos.some(s => s.includes("send=content"))).toBe(true);
    expect(infos.some(s => s.includes("send=attachment"))).toBe(true);
  });
});
