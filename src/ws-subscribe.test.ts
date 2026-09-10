/**
 * Live-query WebSocket binding — RAW Bun WS-client integration test
 * (WS-hibernation migration Phase 3, self-host door). Spins up a real
 * `Bun.serve` wired with the production `createSubscribeWsBinding` handlers +
 * upgrade decision, then drives a REAL `new WebSocket(...)` client through the
 * wire contract: first-message auth handshake, chunked snapshot, single-writer
 * live upsert/remove, ping/pong, the close codes (4400/4401/4403/4408),
 * re-auth narrow-or-equal, and the per-vault cap.
 *
 * This is the self-host proof that the SERVER speaks the contract. The
 * raw-client-THROUGH-the-hub-bridge check (the risky proxy seam) is a separate
 * live verification recorded in the PR body; the full browser E2E is Phase 4.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import type { VaultConfig } from "./config.ts";
import type { AuthResult } from "./auth.ts";
import { SubscriptionManager } from "./subscriptions.ts";
import { createSubscribeWsBinding, isWebSocketUpgrade, type SubscribeWsData } from "./ws-server.ts";

const VAULT = "testvault";

let db: Database;
let hooks: HookRegistry;
let store: SqliteStore;
let manager: SubscriptionManager;
let servers: Array<ReturnType<typeof Bun.serve>> = [];

const vaultConfig = { name: VAULT, created_at: new Date().toISOString(), api_keys: [] } as unknown as VaultConfig;

/** A stub auth seam keyed on the Bearer token, exercising every close-code path
 *  without a live hub JWKS. Mirrors the AuthResult the real seam returns. */
async function fakeAuth(req: Request, _cfg: VaultConfig): Promise<{ error: Response } | AuthResult> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const mk = (scopes: string[], scoped_tags: string[] | null = null): AuthResult => ({
    permission: "full",
    scopes,
    legacyDerived: false,
    scoped_tags,
    vault_name: null,
    caller_jti: null,
    actor: "test",
    via: "api",
  });
  switch (token) {
    case "admin":
      return mk(["vault:admin", "vault:write", "vault:read"]);
    case "good":
    case "readonly":
      return mk(["vault:read"]);
    case "noscope":
      return mk([]); // authenticates but grants no read → 4403
    case "scoped-eng":
    case "scoped-eng-2": // same tag-scope as scoped-eng (a normal refresh)
      return mk(["vault:read"], ["work/eng"]);
    case "scoped-sales":
      return mk(["vault:read"], ["work/sales"]); // a DIFFERENT tag-scope
    case "forbidden":
      return { error: Response.json({ error: "Forbidden" }, { status: 403 }) };
    default:
      return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
}

function makeServer(overrides: Parameters<typeof createSubscribeWsBinding>[0] = {}) {
  const binding = createSubscribeWsBinding({
    getStore: () => store,
    getVaultConfig: () => vaultConfig,
    manager,
    authenticate: fakeAuth,
    ...overrides,
  });
  const server = Bun.serve({
    port: 0,
    websocket: binding.handlers,
    fetch(req, server) {
      const url = new URL(req.url);
      if (isWebSocketUpgrade(req)) {
        const verdict = binding.tryUpgrade(req, server, url.pathname);
        if (verdict.kind === "upgraded") return undefined;
        if (verdict.kind === "response") return verdict.response;
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { server, binding };
}

/** Raw WS client handle. */
function connect(port: number, path: string) {
  const ws = new WebSocket(`ws://localhost:${port}${path}`);
  const queue: any[] = [];
  const waiters: Array<(m: any) => void> = [];
  let closeInfo: { code: number; reason: string } | null = null;
  const closeWaiters: Array<(c: { code: number; reason: string }) => void> = [];
  let opened = false;
  const openWaiters: Array<() => void> = [];

  ws.addEventListener("open", () => {
    opened = true;
    openWaiters.splice(0).forEach((r) => r());
  });
  ws.addEventListener("message", (e: MessageEvent) => {
    let m: any;
    try {
      m = JSON.parse(e.data as string);
    } catch {
      m = e.data;
    }
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  ws.addEventListener("close", (e: CloseEvent) => {
    closeInfo = { code: e.code, reason: e.reason };
    closeWaiters.splice(0).forEach((w) => w(closeInfo!));
  });
  ws.addEventListener("error", () => {
    /* a failed handshake surfaces as error → close; swallow */
  });

  const nextMessage = (ms = 3000): Promise<any> => {
    const q = queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws message timeout")), ms);
      waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  };

  return {
    ws,
    ready: (): Promise<void> => (opened ? Promise.resolve() : new Promise((r) => openWaiters.push(r))),
    send: (obj: unknown) => ws.send(typeof obj === "string" ? obj : JSON.stringify(obj)),
    nextMessage,
    /** Read snapshot frame(s) until done:true. Returns concatenated notes + frame count. */
    readSnapshot: async (ms = 3000): Promise<{ notes: any[]; frames: number }> => {
      const notes: any[] = [];
      let frames = 0;
      for (;;) {
        const m = await nextMessage(ms);
        expect(m.type).toBe("snapshot");
        notes.push(...m.notes);
        frames++;
        if (m.done) return { notes, frames };
      }
    },
    waitClose: (ms = 3000): Promise<{ code: number; reason: string }> => {
      if (closeInfo) return Promise.resolve(closeInfo);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws close timeout")), ms);
        closeWaiters.push((c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
    },
    close: () => ws.close(),
  };
}

/** Let deferred hook dispatch + handlers run. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 15));
}

beforeEach(() => {
  db = new Database(":memory:");
  hooks = new HookRegistry({ concurrency: 4, logger: { error() {} } });
  store = new SqliteStore(db, { hooks });
  manager = new SubscriptionManager(hooks, { resolveVault: () => VAULT });
  servers = [];
});

afterEach(async () => {
  for (const s of servers) s.stop(true);
  await settle();
  manager.shutdown();
  db.close();
});

describe("WS live-query — handshake + snapshot", () => {
  it("authenticates via first message and receives the scoped snapshot", async () => {
    await store.createNote("hello", { tags: ["chat"] });
    await store.createNote("nope", { tags: ["other"] });
    const { server } = makeServer();

    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "good" });

    const snap = await h.readSnapshot();
    expect(snap.frames).toBe(1);
    expect(snap.notes.length).toBe(1);
    expect(snap.notes[0].content).toBe("hello");
    h.close();
  });

  it("delivers a chunked snapshot the client reassembles (> chunk-max notes)", async () => {
    for (let i = 0; i < 205; i++) await store.createNote(`n${i}`, { tags: ["chat"] });
    const { server } = makeServer();

    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "good" });

    const snap = await h.readSnapshot();
    expect(snap.frames).toBeGreaterThan(1); // chunked across the 200-note bound
    expect(snap.notes.length).toBe(205);
    h.close();
  });
});

describe("WS live-query — live events", () => {
  it("emits upsert on a matching insert after ready", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "good" });
    await h.readSnapshot();

    await store.createNote("live one", { tags: ["chat"] });
    const m = await h.nextMessage();
    expect(m.type).toBe("upsert");
    expect(m.note.content).toBe("live one");
    h.close();
  });

  it("emits remove on delete", async () => {
    const note = await store.createNote("doomed", { tags: ["chat"] });
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "good" });
    await h.readSnapshot();

    await store.deleteNote(note.id);
    const m = await h.nextMessage();
    expect(m.type).toBe("remove");
    expect(m.id).toBe(note.id);
    h.close();
  });

  it("does NOT push an insert that doesn't match the query", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "good" });
    await h.readSnapshot();

    await store.createNote("irrelevant", { tags: ["other"] });
    await settle();
    // No frame should have arrived — a nextMessage would time out. Prove it via
    // a matching insert landing as the NEXT (and only) message.
    await store.createNote("matches", { tags: ["chat"] });
    const m = await h.nextMessage();
    expect(m.type).toBe("upsert");
    expect(m.note.content).toBe("matches");
    h.close();
  });
});

describe("WS live-query — ping/pong liveness", () => {
  it("answers the literal ping with pong, subscription intact", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "good" });
    await h.readSnapshot();

    h.send("ping");
    const pong = await h.nextMessage();
    expect(pong).toBe("pong");

    // Subscription still live after the ping.
    await store.createNote("after ping", { tags: ["chat"] });
    const m = await h.nextMessage();
    expect(m.type).toBe("upsert");
    h.close();
  });
});

describe("WS live-query — close codes", () => {
  it("bad token → 4401", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "wrong" });
    expect((await h.waitClose()).code).toBe(4401);
  });

  it("auth error 403 → 4403", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "forbidden" });
    expect((await h.waitClose()).code).toBe(4403);
  });

  it("authenticates but lacks read scope → 4403", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "noscope" });
    expect((await h.waitClose()).code).toBe(4403);
  });

  it("non-auth first message → 4400", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "upsert", note: {} });
    expect((await h.waitClose()).code).toBe(4400);
  });

  it("malformed first message → 4400", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send("not-json-garbage");
    expect((await h.waitClose()).code).toBe(4400);
  });

  it("pending socket that never auths → 4408", async () => {
    const { server } = makeServer({ authDeadlineMs: 150 });
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    // Send nothing — the deadline timer must close us.
    expect((await h.waitClose(2000)).code).toBe(4408);
  });
});

describe("WS live-query — tag-scope isolation (per-agent boundary)", () => {
  it("a tag-scoped token receives ONLY in-scope notes (snapshot + live)", async () => {
    await store.createNote("eng note", { tags: ["shared", "work/eng"] });
    await store.createNote("sales note", { tags: ["shared", "work/sales"] });
    const { server } = makeServer();
    // Unfiltered subscription: `shared` is OUT of this token's scope, and
    // since vault#675 a scoped token can no longer subscribe BY an
    // out-of-scope tag (it matches nothing, exactly like a nonexistent
    // tag). This test is about the RESULT filter, so it drops the tag
    // filter rather than probing across the scope boundary.
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe`);
    await h.ready();
    h.send({ type: "auth", token: "scoped-eng" }); // scoped to work/eng

    const snap = await h.readSnapshot();
    expect(snap.notes.map((n: any) => n.content)).toEqual(["eng note"]); // sales filtered out

    // Live: an out-of-scope insert is SILENT; the next in-scope insert arrives.
    await store.createNote("sales live", { tags: ["shared", "work/sales"] });
    await settle();
    await store.createNote("eng live", { tags: ["shared", "work/eng"] });
    const m = await h.nextMessage();
    expect(m.type).toBe("upsert");
    expect(m.note.content).toBe("eng live");
    h.close();
  });

  it("re-auth with a CHANGED tag-scope → 4403 (forces a clean reconnect)", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=shared`);
    await h.ready();
    h.send({ type: "auth", token: "scoped-eng" });
    await h.readSnapshot();
    h.send({ type: "auth", token: "scoped-sales" }); // ["work/sales"] ≠ ["work/eng"]
    expect((await h.waitClose()).code).toBe(4403);
  });

  it("re-auth that DROPS tag-scoping (scoped → unscoped, same verb) → 4403", async () => {
    // The load-bearing case: verb-rank is unchanged (read→read), so ONLY the
    // tag-scope delta check catches this widen-the-scope-without-changing-verb.
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=shared`);
    await h.ready();
    h.send({ type: "auth", token: "scoped-eng" });
    await h.readSnapshot();
    h.send({ type: "auth", token: "readonly" }); // scoped_tags null, still vault:read
    expect((await h.waitClose()).code).toBe(4403);
  });

  it("re-auth with the SAME tag-scope stays ready (normal refresh)", async () => {
    const { server } = makeServer();
    // Unfiltered, for the same reason as the isolation test above: since
    // vault#675 a scoped token subscribing BY the out-of-scope `shared`
    // matches nothing, which would mask the live delivery this asserts.
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe`);
    await h.ready();
    h.send({ type: "auth", token: "scoped-eng" });
    await h.readSnapshot();
    h.send({ type: "auth", token: "scoped-eng-2" }); // identical ["work/eng"]
    await settle();
    // Still live + still correctly scoped: an in-scope write arrives, out-of-scope stays silent.
    await store.createNote("sales after refresh", { tags: ["shared", "work/sales"] });
    await settle();
    await store.createNote("eng after refresh", { tags: ["shared", "work/eng"] });
    const m = await h.nextMessage();
    expect(m.type).toBe("upsert");
    expect(m.note.content).toBe("eng after refresh");
    h.close();
  });
});

describe("WS live-query — vault#675: subscribing BY an out-of-scope tag is not an oracle", () => {
  /**
   * The one-shot query oracle (REST/MCP, covered in
   * `tag-scope-query-tag.test.ts`) has a live twin: subscribe to
   * `?tag=<guessed name>` and watch whether frames arrive. A note tagged
   * `["shared","work/eng"]` is admitted to a `work/eng` token via `work/eng`,
   * so pre-fix it landed in the snapshot of a `?tag=shared` subscription and
   * confirmed that `shared` exists. Post-fix an out-of-scope subscription tag
   * matches nothing — the same treatment a nonexistent tag gets.
   */
  it("out-of-scope subscription tag → empty snapshot AND no live frames, while an in-scope control socket sees the write", async () => {
    await store.createNote("eng note", { tags: ["shared", "work/eng"] });
    const { server } = makeServer();

    // The probe: names a tag outside its allowlist.
    const probe = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=shared`);
    await probe.ready();
    probe.send({ type: "auth", token: "scoped-eng" });
    const snap = await probe.readSnapshot();
    expect(snap.notes).toEqual([]); // pre-fix: ["eng note"] — the oracle

    // The control: same token, same corpus, no cross-scope tag named.
    const control = connect(server.port, `/vault/${VAULT}/api/subscribe`);
    await control.ready();
    control.send({ type: "auth", token: "scoped-eng" });
    expect((await control.readSnapshot()).notes.map((n: any) => n.content)).toEqual(["eng note"]);

    // One write, both sockets live. The control receiving it is what makes
    // the probe's silence evidence rather than a race.
    await store.createNote("eng live", { tags: ["shared", "work/eng"] });
    const m = await control.nextMessage();
    expect(m.type).toBe("upsert");
    expect(m.note.content).toBe("eng live");
    await expect(probe.nextMessage(200)).rejects.toThrow(/timeout/);

    probe.close();
    control.close();
  });

  it("UNSCOPED control — an unscoped subscription to the same tag is unaffected", async () => {
    await store.createNote("eng note", { tags: ["shared", "work/eng"] });
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=shared`);
    await h.ready();
    h.send({ type: "auth", token: "good" }); // no scoped_tags

    expect((await h.readSnapshot()).notes.map((n: any) => n.content)).toEqual(["eng note"]);
    h.close();
  });

  it("an IN-SCOPE subscription tag still matches — snapshot and live", async () => {
    await store.createNote("eng note", { tags: ["shared", "work/eng"] });
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=work/eng`);
    await h.ready();
    h.send({ type: "auth", token: "scoped-eng" });

    expect((await h.readSnapshot()).notes.map((n: any) => n.content)).toEqual(["eng note"]);
    await store.createNote("eng live", { tags: ["work/eng"] });
    const m = await h.nextMessage();
    expect(m.type).toBe("upsert");
    expect(m.note.content).toBe("eng live");
    h.close();
  });
});

describe("WS live-query — re-auth (narrow-or-equal)", () => {
  it("a narrowing re-auth keeps the socket open", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "admin" }); // rank 2
    await h.readSnapshot();

    h.send({ type: "auth", token: "readonly" }); // rank 0 — narrow, allowed
    await settle();
    // Still live: a matching write arrives as an upsert (not a close).
    await store.createNote("still live", { tags: ["chat"] });
    const m = await h.nextMessage();
    expect(m.type).toBe("upsert");
    h.close();
  });

  it("a widening re-auth → 4403", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "readonly" }); // rank 0
    await h.readSnapshot();

    h.send({ type: "auth", token: "admin" }); // rank 2 — widen, refused
    expect((await h.waitClose()).code).toBe(4403);
  });
});

describe("WS live-query — bad query + cap", () => {
  it("rejects an unsupported query at upgrade with a 400 (never opens a socket)", async () => {
    const { server } = makeServer();
    // A raw fetch upgrade with a rejected query gets the byte-identical 400.
    const res = await fetch(`http://localhost:${server.port}/vault/${VAULT}/api/subscribe?search=hi`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "x", "Sec-WebSocket-Version": "13" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
  });

  // vault#551 — literal-by-default search + `search_mode` are a
  // snapshot/REST-only concept (escaping happens in `core/src/notes.ts`
  // `searchNotes`, which the live matcher never calls). `search` itself
  // stays categorically unsupported for live subscriptions regardless of
  // mode — confirms `search_mode` doesn't accidentally open a bypass.
  it("rejects an unsupported query with search_mode present too — search_mode doesn't bypass the search rejection", async () => {
    const { server } = makeServer();
    const res = await fetch(`http://localhost:${server.port}/vault/${VAULT}/api/subscribe?search=hi&search_mode=advanced`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "x", "Sec-WebSocket-Version": "13" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
  });

  it("refuses over the per-vault cap (503) and self-heals when a socket closes", async () => {
    const { binding } = makeServer({ maxSubscriptions: 2 });
    const fakeWs = (): { data: SubscribeWsData; close(): void; send(): void } => ({
      data: {
        vaultName: VAULT,
        rawQuery: "",
        state: "pending",
        grantedScopes: [],
        grantedTagScope: null,
        handle: null,
        authTimer: null,
      },
      close() {},
      send() {},
    });
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    binding.handlers.open(ws1 as any);
    binding.handlers.open(ws2 as any);

    const req = new Request(`http://x/vault/${VAULT}/api/subscribe?tag=chat`, { headers: { upgrade: "websocket" } });
    const fakeServer = { upgrade: () => true } as any;
    const full = binding.tryUpgrade(req, fakeServer, `/vault/${VAULT}/api/subscribe`);
    expect(full.kind).toBe("response");
    expect((full as { response: Response }).response.status).toBe(503);

    // Free a slot → the next upgrade is admitted.
    binding.handlers.close!(ws1 as any, 1000, "", true);
    const ok = binding.tryUpgrade(req, fakeServer, `/vault/${VAULT}/api/subscribe`);
    expect(ok.kind).toBe("upgraded");
  });
});

describe("WS live-query — lean list subscriptions (include_content=false)", () => {
  it("ships the lean NoteIndex snapshot shape — no bodies, has preview/displayTitle/byteSize", async () => {
    await store.createNote("# Title line\n\nbody paragraph here", { tags: ["chat"] });
    const { server } = makeServer();

    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat&include_content=false`);
    await h.ready();
    h.send({ type: "auth", token: "good" });

    const snap = await h.readSnapshot();
    expect(snap.notes.length).toBe(1);
    const n = snap.notes[0];
    // Lean shape = what REST lists return: no `content`, but the index fields.
    expect(n.content).toBeUndefined();
    expect(typeof n.byteSize).toBe("number");
    expect(typeof n.preview).toBe("string");
    expect(n.displayTitle).toBe("Title line");
    expect(n.tags).toEqual(["chat"]);
    h.close();
  });

  it("a default subscription still ships FULL notes (regression: note-view path unchanged)", async () => {
    await store.createNote("full body content", { tags: ["chat"] });
    const { server } = makeServer();

    // No include_content param → full content (the byte-unchanged default).
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat`);
    await h.ready();
    h.send({ type: "auth", token: "good" });

    const snap = await h.readSnapshot();
    expect(snap.notes[0].content).toBe("full body content");
    // Full Note carries no lean-only fields.
    expect(snap.notes[0].byteSize).toBeUndefined();
    expect(snap.notes[0].preview).toBeUndefined();
    h.close();
  });

  it("emits a LEAN upsert on a matching insert", async () => {
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat&include_content=false`);
    await h.ready();
    h.send({ type: "auth", token: "good" });
    await h.readSnapshot();

    await store.createNote("live lean note", { tags: ["chat"] });
    const m = await h.nextMessage();
    expect(m.type).toBe("upsert");
    expect(m.note.content).toBeUndefined();
    expect(m.note.displayTitle).toBe("live lean note");
    expect(typeof m.note.byteSize).toBe("number");
    h.close();
  });

  it("emits a LEAN upsert when a note in the set CHANGES (live-update correctness)", async () => {
    const note = await store.createNote("before", { tags: ["chat"] });
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat&include_content=false`);
    await h.ready();
    h.send({ type: "auth", token: "good" });
    await h.readSnapshot();

    await store.updateNote(note.id, { content: "after edit" });
    const m = await h.nextMessage();
    expect(m.type).toBe("upsert");
    expect(m.note.id).toBe(note.id);
    expect(m.note.content).toBeUndefined();
    expect(m.note.displayTitle).toBe("after edit");
    h.close();
  });

  it("still emits a thin remove{id} under a lean subscription", async () => {
    const note = await store.createNote("doomed lean", { tags: ["chat"] });
    const { server } = makeServer();
    const h = connect(server.port, `/vault/${VAULT}/api/subscribe?tag=chat&include_content=false`);
    await h.ready();
    h.send({ type: "auth", token: "good" });
    await h.readSnapshot();

    await store.deleteNote(note.id);
    const m = await h.nextMessage();
    expect(m.type).toBe("remove");
    expect(m.id).toBe(note.id);
    h.close();
  });
});
