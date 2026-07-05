/**
 * Live-query WebSocket binding — the SELF-HOST (Bun.serve) integration
 * (WS-hibernation migration, 2026-07-04; contract
 * `parachute-cloud/workers/vault/docs/live-query-ws.md`).
 *
 * The cloud door runs this logic inside a per-vault Durable Object with
 * Hibernatable WebSockets; the self-host door runs it in the single long-lived
 * `Bun.serve` process (`server.ts`). Same wire contract, minus hibernation — a
 * self-run Bun box has no per-connection duration bill, so a socket just lives
 * in memory (free): no attachment / rehydration / eviction / sweep, no
 * lifetime cap. Per-socket state lives on `ws.data` and is mutated in place.
 *
 * ## Where the pieces live
 *   - `ws-subscribe.ts` — the PURE half (close codes, query validation, chunked
 *     snapshot, message parsing, verb-rank) shared byte-shaped with cloud.
 *   - `subscriptions.ts` — the transport-agnostic manager + `WsSink`
 *     (`{ type, ...data }`), the sole live-transport sink since Phase 5.
 *   - this module — the Bun.serve upgrade decision + `open`/`message`/`close`
 *     handlers + the per-vault live-socket registry (the WS cap).
 *
 * ## First-message auth (fork 2, ratified)
 * The socket is accepted pre-auth; the FIRST message must be
 * `{"type":"auth","token"}` (browsers can't header-auth a WebSocket and the hub
 * ws-bridge drops subprotocols). Auth reuses the FULL self-host auth seam by
 * synthesizing a `Bearer` request — the WS token validates exactly as an HTTP
 * `Authorization` header would (operator bearer / hub JWT / legacy YAML keys /
 * dropped pvt_* → 401). A pending socket that never auths within ~10s is closed
 * 4408. Re-auth on the open socket (client re-sends `auth` on token refresh) may
 * only narrow-or-equal the granted verb (a widen → 4403); no re-snapshot.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Store } from "../core/src/types.ts";
import type { VaultConfig } from "./config.ts";
import { readVaultConfig } from "./config.ts";
import { getVaultStore } from "./vault-store.ts";
import { authenticateVaultRequest, type AuthResult } from "./auth.ts";
import { hasScopeForVault } from "./scopes.ts";
import { expandTokenTagScope, filterNotesByTagScope } from "./tag-scope.ts";
import { buildLiveMatcher } from "./live-match.ts";
import {
  subscriptionManager,
  WsSink,
  type SubscriptionHandle,
  type SubscriptionManager,
} from "./subscriptions.ts";
import {
  MAX_WS_SUBSCRIPTIONS,
  WS_AUTH_DEADLINE_MS,
  WS_CLOSE,
  buildSnapshotFrames,
  parseClientMessage,
  sameTagScope,
  subscriptionCapResponse,
  urlFromQuery,
  validateWsSubscribeQuery,
  vaultVerbRank,
} from "./ws-subscribe.ts";

/** Per-connection state on `ws.data`. Mutated in place (no hibernation). */
export interface SubscribeWsData {
  vaultName: string;
  /** Raw query string incl. leading `?` (e.g. `?tag=watch`). */
  rawQuery: string;
  state: "pending" | "ready";
  /** Granted scopes recorded at auth (the re-auth narrow-or-equal check). */
  grantedScopes: string[];
  /** Granted tag-scope (`scoped_tags`) recorded at auth. The live matcher's
   *  tag-scope is frozen at initial auth, so a re-auth that changes this is
   *  refused (4403) rather than silently keeping the old scope. */
  grantedTagScope: string[] | null;
  /** Manager handle once the sub is live (null while pending). */
  handle: SubscriptionHandle | null;
  /** Pending-auth deadline timer (cleared on auth success / close). */
  authTimer: ReturnType<typeof setTimeout> | null;
}

/** Upgrade decision returned to `server.ts`'s fetch. */
export type WsUpgradeVerdict =
  | { kind: "upgraded" }
  | { kind: "response"; response: Response }
  | { kind: "pass" };

export interface SubscribeWsDeps {
  /** Resolve a vault's store. Defaults to the process-wide `getVaultStore`. */
  getStore?: (vaultName: string) => Store;
  /** Read a vault's config. Defaults to `readVaultConfig`. */
  getVaultConfig?: (vaultName: string) => VaultConfig | null;
  /** The subscription manager. Defaults to the process-wide singleton. */
  manager?: SubscriptionManager;
  /**
   * Authenticate a synthesized Bearer request. Defaults to
   * `authenticateVaultRequest` (the full self-host auth seam). Injectable so
   * tests can drive every close-code path (401 → 4401, 403 → 4403) without a
   * live hub JWKS.
   */
  authenticate?: (
    req: Request,
    vaultConfig: VaultConfig,
  ) => Promise<{ error: Response } | AuthResult>;
  /** Per-vault concurrent WS-subscription cap. Defaults to
   *  {@link MAX_WS_SUBSCRIPTIONS}; tests set it low to exercise the 503. */
  maxSubscriptions?: number;
  /** Pending-auth deadline (ms). Defaults to {@link WS_AUTH_DEADLINE_MS};
   *  tests set it low to exercise the 4408 close without a 10s wait. */
  authDeadlineMs?: number;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** True iff the request is a WebSocket upgrade. */
export function isWebSocketUpgrade(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

const SUBSCRIBE_PATH = /^\/vault\/([^/]+)\/api\/subscribe$/;

/**
 * The self-host live-query WebSocket binding: an upgrade-decision function
 * (called from `server.ts`'s fetch BEFORE the normal route pipeline) plus the
 * `Bun.serve` `websocket` handlers. Both share the per-vault live-socket
 * registry (closure state) that enforces the WS cap.
 */
export function createSubscribeWsBinding(deps: SubscribeWsDeps = {}): {
  tryUpgrade: (req: Request, server: Server<SubscribeWsData>, path: string) => WsUpgradeVerdict;
  handlers: WebSocketHandler<SubscribeWsData>;
} {
  const getStore = deps.getStore ?? getVaultStore;
  const getVaultConfig = deps.getVaultConfig ?? readVaultConfig;
  const manager = deps.manager ?? subscriptionManager;
  const authenticate = deps.authenticate ?? authenticateVaultRequest;
  const maxSubscriptions = deps.maxSubscriptions ?? MAX_WS_SUBSCRIPTIONS;
  const authDeadlineMs = deps.authDeadlineMs ?? WS_AUTH_DEADLINE_MS;

  // Per-vault live sockets (pending + ready) — the WS cap counts over these,
  // mirroring the cloud door's `getWebSockets()` live count. A pending socket
  // that never auths self-heals off this set via the ~10s deadline close.
  const liveSockets = new Map<string, Set<ServerWebSocket<SubscribeWsData>>>();
  const liveCount = (vaultName: string): number => liveSockets.get(vaultName)?.size ?? 0;
  const addLiveSocket = (vaultName: string, ws: ServerWebSocket<SubscribeWsData>): void => {
    let set = liveSockets.get(vaultName);
    if (!set) {
      set = new Set();
      liveSockets.set(vaultName, set);
    }
    set.add(ws);
  };
  const removeLiveSocket = (vaultName: string, ws: ServerWebSocket<SubscribeWsData>): void => {
    const set = liveSockets.get(vaultName);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) liveSockets.delete(vaultName);
  };

  const clearAuthTimer = (ws: ServerWebSocket<SubscribeWsData>): void => {
    if (ws.data.authTimer) {
      clearTimeout(ws.data.authTimer);
      ws.data.authTimer = null;
    }
  };

  /** Drop a socket's manager subscription + registry slot (idempotent). */
  const cleanupSocket = (ws: ServerWebSocket<SubscribeWsData>): void => {
    clearAuthTimer(ws);
    removeLiveSocket(ws.data.vaultName, ws);
    if (ws.data.handle) {
      ws.data.handle.close();
      ws.data.handle = null;
    }
  };

  /** Close a socket with an explicit application code, then tear down its sub
   *  IMMEDIATELY (so no further event fans out to the closing socket). The
   *  `close` handler re-runs cleanup idempotently. */
  const closeWs = (ws: ServerWebSocket<SubscribeWsData>, code: number, reason: string): void => {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing / closed */
    }
    cleanupSocket(ws);
  };

  const closeCodeForAuthError = (res: Response): number =>
    res.status === 403 ? WS_CLOSE.FORBIDDEN : WS_CLOSE.UNAUTHORIZED;

  /**
   * First auth on a pending socket. On success: build the matcher + tag-scope +
   * snapshot (all awaited), then SYNCHRONOUSLY flip → ready, register, and flush
   * the chunked snapshot (no await between register and flush, so a deferred
   * hook dispatch can't slip a live event ahead of the snapshot — the SSE
   * ordering). Failure → 4401 (auth) / 4403 (scope) / 4400 (bad query).
   */
  async function authenticatePendingSocket(ws: ServerWebSocket<SubscribeWsData>, token: string): Promise<void> {
    const { vaultName, rawQuery } = ws.data;
    const vaultConfig = getVaultConfig(vaultName);
    if (!vaultConfig) {
      closeWs(ws, WS_CLOSE.PROTOCOL, "vault not found");
      return;
    }
    let store: Store;
    try {
      store = getStore(vaultName);
    } catch {
      closeWs(ws, WS_CLOSE.PROTOCOL, "vault not available");
      return;
    }

    // Reuse the FULL self-host auth seam via a synthesized Bearer request.
    const authReq = new Request(`http://ws.local/vault/${vaultName}/api/subscribe${rawQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const auth = await authenticate(authReq, vaultConfig);
    if ("error" in auth) {
      closeWs(ws, closeCodeForAuthError(auth.error), "auth failed");
      return;
    }
    // Subscribe is a READ operation (admin ⊇ write ⊇ read).
    if (!hasScopeForVault(auth.scopes, vaultName, "read")) {
      closeWs(ws, WS_CLOSE.FORBIDDEN, "insufficient scope");
      return;
    }

    // Query was validated at upgrade; re-validate from the stored raw string.
    const validated = validateWsSubscribeQuery(urlFromQuery(rawQuery));
    if ("error" in validated) {
      closeWs(ws, WS_CLOSE.PROTOCOL, "invalid subscription query");
      return;
    }

    let tagScopeAllowed: Set<string> | null;
    let matcher;
    let snapshotNotes;
    try {
      tagScopeAllowed = await expandTokenTagScope(store, auth.scoped_tags);
      matcher = await buildLiveMatcher(store, validated.queryOpts);
      // Snapshot = the COMPLETE scoped matching set — strip paging so snapshot ⊇ live.
      const raw = await store.queryNotes({
        ...validated.queryOpts,
        limit: Number.MAX_SAFE_INTEGER,
        offset: undefined,
      });
      snapshotNotes = filterNotesByTagScope(raw, tagScopeAllowed, auth.scoped_tags);
    } catch {
      closeWs(ws, WS_CLOSE.PROTOCOL, "snapshot query failed");
      return;
    }
    const frames = buildSnapshotFrames(snapshotNotes);

    // --- SYNCHRONOUS from here (no await) so no write interleaves between
    //     register and the snapshot flush.
    clearAuthTimer(ws);
    ws.data.state = "ready";
    ws.data.grantedScopes = auth.scopes;
    ws.data.grantedTagScope = auth.scoped_tags;
    const handle = manager.register({
      vaultName,
      matcher,
      tagScopeAllowed,
      tagScopeRaw: auth.scoped_tags,
      sink: new WsSink(ws),
      tracksFlush: false,
      countsTowardCap: false,
    });
    if (!handle) {
      closeWs(ws, WS_CLOSE.PROTOCOL, "could not register subscription");
      return;
    }
    ws.data.handle = handle;

    const sink = new WsSink(ws);
    for (const frame of frames) if (!sink.sendRaw(frame)) break;
  }

  /**
   * Re-auth on an open socket (client re-sends `auth` on token refresh):
   * re-validate + enforce narrow-or-equal scope (a WIDEN → 4403), then update
   * the recorded scopes. NO re-snapshot, NO re-register — the matcher + socket
   * are unchanged (the self-host socket lives in memory regardless of exp; the
   * re-auth check exists for wire-contract congruence with the cloud door).
   *
   * The live matcher's TAG-scope is frozen at initial auth (not re-derived per
   * message), so a re-auth whose tag-scope differs in ANY way is refused (4403).
   * The client reconnects fresh → the initial-connect path re-derives scope
   * correctly. This closes a WS-only per-agent-isolation gap the SSE route can't
   * have (SSE reconnects re-derive scope every time). See `sameTagScope`.
   */
  async function reauthReadySocket(ws: ServerWebSocket<SubscribeWsData>, token: string): Promise<void> {
    const { vaultName, grantedScopes, grantedTagScope, rawQuery } = ws.data;
    const vaultConfig = getVaultConfig(vaultName);
    if (!vaultConfig) {
      closeWs(ws, WS_CLOSE.PROTOCOL, "vault not found");
      return;
    }
    const authReq = new Request(`http://ws.local/vault/${vaultName}/api/subscribe${rawQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const auth = await authenticate(authReq, vaultConfig);
    if ("error" in auth) {
      closeWs(ws, closeCodeForAuthError(auth.error), "re-auth failed");
      return;
    }
    if (vaultVerbRank(auth.scopes, vaultName) > vaultVerbRank(grantedScopes, vaultName)) {
      closeWs(ws, WS_CLOSE.FORBIDDEN, "re-auth widens scope");
      return;
    }
    // Tag-scope delta → force a clean reconnect (which re-derives scope). A
    // narrowed/revoked/differently-scoped token must NOT keep the frozen matcher.
    if (!sameTagScope(auth.scoped_tags, grantedTagScope)) {
      closeWs(ws, WS_CLOSE.FORBIDDEN, "re-auth changes tag scope");
      return;
    }
    ws.data.grantedScopes = auth.scopes;
  }

  function tryUpgrade(req: Request, server: Server<SubscribeWsData>, path: string): WsUpgradeVerdict {
    const match = path.match(SUBSCRIBE_PATH);
    if (!match) return { kind: "pass" };
    const vaultName = match[1]!;

    // WS upgrades are GET.
    if (req.method !== "GET") {
      return { kind: "response", response: json({ error: "Method not allowed", message: "subscribe is GET-only" }, 405) };
    }
    if (!getVaultConfig(vaultName)) {
      return { kind: "response", response: json({ error: "Vault not found", vault: vaultName }, 404) };
    }

    const url = new URL(req.url);
    // Same query rejects as the SSE route (byte-identical 400 body).
    const validated = validateWsSubscribeQuery(url);
    if ("error" in validated) return { kind: "response", response: validated.error };

    // Per-vault WS cap (over the live sockets) — pending sockets count, and
    // self-heal off the set via the ~10s auth-deadline close.
    if (liveCount(vaultName) >= maxSubscriptions) {
      return { kind: "response", response: subscriptionCapResponse() };
    }

    const data: SubscribeWsData = {
      vaultName,
      rawQuery: url.search,
      state: "pending",
      grantedScopes: [],
      grantedTagScope: null,
      handle: null,
      authTimer: null,
    };
    const ok = server.upgrade(req, { data });
    if (ok) return { kind: "upgraded" };
    // Not a valid WS handshake (missing Sec-WebSocket-* headers).
    return {
      kind: "response",
      response: json({ error: "Expected a WebSocket upgrade request" }, 426),
    };
  }

  const handlers: WebSocketHandler<SubscribeWsData> = {
    open(ws) {
      addLiveSocket(ws.data.vaultName, ws);
      // Pending-auth deadline: an accepted socket that never auths is closed
      // 4408. `unref` so the timer never holds the process (or a test) open.
      const timer = setTimeout(() => {
        if (ws.data.state === "pending") closeWs(ws, WS_CLOSE.AUTH_TIMEOUT, "auth timeout");
      }, authDeadlineMs);
      (timer as { unref?: () => void }).unref?.();
      ws.data.authTimer = timer;
    },

    async message(ws, message) {
      // Client-driven liveness: the literal `ping` string → `pong`. Never JSON,
      // so it short-circuits before `parseClientMessage`.
      if (typeof message === "string" && message === "ping") {
        try {
          ws.send("pong");
        } catch {
          /* socket gone */
        }
        return;
      }

      const parsed = parseClientMessage(message as string | Uint8Array);
      if (parsed.kind === "malformed") {
        closeWs(ws, WS_CLOSE.PROTOCOL, "malformed message");
        return;
      }

      if (ws.data.state === "pending") {
        if (parsed.kind !== "auth") {
          closeWs(ws, WS_CLOSE.PROTOCOL, "expected auth message");
          return;
        }
        await authenticatePendingSocket(ws, parsed.token);
      } else if (parsed.kind === "auth") {
        await reauthReadySocket(ws, parsed.token);
      }
      // Any other message on a ready socket: ignored (forward-compat).
    },

    close(ws) {
      cleanupSocket(ws);
    },
  };

  return { tryUpgrade, handlers };
}
