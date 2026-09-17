import { test, expect } from "bun:test";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, defaultHookRegistry } from "./vault-store.ts";
import { handleNotes } from "./routes.ts";
import { handleScopedMcp } from "./mcp-http.ts";
import { route } from "./routing.ts";
import { registerTranscriptionHook } from "./transcription-worker.ts";
import { getTranscriptionWorker, getTranscriptionWorkerProvider, setTranscriptionWorker } from "./transcription-registry.ts";

// Fake the wired worker, not module imports or real ASR. Exercise both upload
// doors and the actual attachment-created hook without network/subprocess work.
for (const door of ["rest", "ticket"] as const) {
  for (const mode of ["local", "remote", "missing", "mismatch", "unready", "disabled", "explicit", "non-audio"] as const) {
    test(`${door}: ${mode} automatic worker eligibility`, async () => {
      const previous = { provider: process.env.TRANSCRIPTION_PROVIDER, url: process.env.SCRIBE_URL, model: process.env.TRANSCRIPTION_MODEL, assets: process.env.ASSETS_DIR };
      const oldWorker = getTranscriptionWorker();
      const oldProvider = getTranscriptionWorkerProvider();
      const vault = `auto-worker-${crypto.randomUUID()}`;
      const kicks: string[] = [];
      const worker = { stop: async () => {}, tick: async () => 0,
        kick: async (_vault: string, attachment: { id: string }) => { kicks.push(attachment.id); } };
      writeVaultConfig({ name: vault, api_keys: [], created_at: new Date().toISOString(),
        auto_transcribe: { enabled: mode !== "disabled" && mode !== "explicit" } });
      const store = getVaultStore(vault);
      const unregister = registerTranscriptionHook(defaultHookRegistry, worker, (s) => s === store ? vault : undefined);
      try {
        // Sibling files may set a process-global storage root. These uploads
        // belong only to this unique vault, not that shared test directory.
        delete process.env.ASSETS_DIR;
        process.env.TRANSCRIPTION_PROVIDER = mode === "remote" ? "scribe-http" : mode === "unready" ? "whisper-cpp" : "transcribe-cpp";
        // A stale URL must never make an absent/mismatched local worker ready.
        if (mode === "local") delete process.env.SCRIBE_URL;
        else process.env.SCRIBE_URL = "http://unused.invalid";
        if (mode === "unready") process.env.TRANSCRIPTION_MODEL = "not-a-real-model";
        setTranscriptionWorker(mode === "missing" ? null : worker,
          mode === "mismatch" ? "scribe-http" : process.env.TRANSCRIPTION_PROVIDER);
        const note = await store.createNote("original body", { path: "memo" });
        const mime = mode === "non-audio" ? "image/png" : "audio/wav";
        let response: Response;
        if (door === "rest") {
          response = await handleNotes(new Request(`http://localhost/notes/${note.id}/attachments`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: "memos/audio.wav", mimeType: mime,
              ...(mode === "explicit" ? { transcribe: true } : {}) }),
          }), store, `/${note.id}/attachments`, vault);
        } else {
          const mint = await handleScopedMcp(new Request(`http://localhost/vault/${vault}/mcp`, {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
              name: "request-attachment-upload", arguments: { note: note.id, filename: "memo.wav", size_bytes: 4,
                mime_type: mime, ...(mode === "explicit" ? { transcribe: true } : {}) },
            } }),
          }), vault, { permission: "full", scopes: ["vault:read", "vault:write"], legacyDerived: false, scoped_tags: null } as any);
          const rpc = await mint.json() as any;
          expect(rpc.error).toBeUndefined();
          const ticket = JSON.parse(rpc.result.content[0].text);
          const req = new Request(ticket.url, { method: "PUT", headers: { "content-type": mime }, body: new Uint8Array([1, 2, 3, 4]) });
          response = await route(req, new URL(req.url).pathname);
        }
        expect(response.status).toBe(201);
        const attachment = await response.json() as any;
        await defaultHookRegistry.drain();
        const eligible = ["local", "remote", "explicit"].includes(mode);
        const unavailable = ["missing", "mismatch", "unready"].includes(mode);
        expect(attachment.metadata?.transcribe_status).toBe(eligible ? "pending" : unavailable ? "failed" : undefined);
        expect(kicks).toEqual(eligible ? [attachment.id] : []);
        if (unavailable) expect(attachment.metadata.transcribe_error).toContain("transcription status");
        if (eligible || unavailable) expect(attachment.metadata.transcribe_origin).toBe(mode === "explicit" ? "legacy" : "auto");
        const current = await store.getNote(note.id);
        expect(current!.content).toBe("original body");
        if (mode !== "explicit") expect((current!.metadata as any)?.transcribe_stub).toBeUndefined();
      } finally {
        await defaultHookRegistry.drain();
        unregister();
        setTranscriptionWorker(oldWorker, oldProvider);
        for (const [key, value] of [["TRANSCRIPTION_PROVIDER", previous.provider], ["SCRIBE_URL", previous.url], ["TRANSCRIPTION_MODEL", previous.model], ["ASSETS_DIR", previous.assets]] as const) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    });
  }
}
