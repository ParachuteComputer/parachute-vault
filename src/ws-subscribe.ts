/**
 * Live-query WebSocket binding — the SELF-HOST (Bun) transport for
 * `GET /vault/<name>/api/subscribe` with an `Upgrade: websocket` header
 * (WS-hibernation migration, 2026-07-04; decision
 * `Decisions/2026-07-04-live-query-ws-hibernation`, contract
 * `parachute-cloud/workers/vault/docs/live-query-ws.md`).
 *
 * This module is the PURE, transport-agnostic half — close codes, query
 * validation (the SAME rejects as the SSE route), chunked-snapshot framing,
 * first-message-auth parsing, and the re-auth verb-rank check. The Bun.serve
 * integration (accept / open / message / close, the per-vault socket registry
 * + cap, the auth deadline) lives in `ws-server.ts`; it needs the running
 * `server` + the live sockets.
 *
 * ## Why WS on self-host (no hibernation)
 * Both doors speak ONE subscription contract. The cloud door adds Cloudflare
 * Hibernatable WebSockets (an idle-but-open socket evicts the DO → ~$0 idle);
 * the self-host door does NOT — a self-run Bun box has no per-connection
 * duration bill, so the socket simply lives in memory (free). No
 * attachment / rehydration / eviction / sweep, no lifetime cap. The wire
 * contract — message `type` discriminators, first-message auth, close codes
 * 4400/4401/4403/4408, client-driven ping/pong, chunked snapshot `done`
 * flag, inner payload byte-identical to the SSE `data:` body — is identical.
 *
 * ## First-message auth (design fork 2, ratified)
 * Browsers can't set headers on a WebSocket and the hub ws-bridge drops
 * subprotocols, so auth is the FIRST socket message (`{"type":"auth","token"}`).
 * The socket is accepted pre-auth (bounded by the per-vault cap + a ~10s
 * pending-auth deadline) and no data flows until auth succeeds. Close codes are
 * visible to browser JS: 4400 protocol, 4401 unauthorized/expired/revoked,
 * 4403 scope, 4408 auth-timeout.
 */
import type { Note, QueryOpts } from "../core/src/types.ts";
import { parseNotesQueryOpts } from "./routes.ts";
import { unsupportedSubscriptionReason } from "./live-match.ts";
import { hasScopeForVault, type VaultVerb } from "./scopes.ts";

/** Per-vault concurrent WS-subscription cap (mirrors the SSE cap). Enforced at
 *  upgrade via the live-socket count — over it → 503.
 *
 *  This cap is SEPARATE from the SSE route's per-vault manager cap (also 100) —
 *  WS subs register with `countsTowardCap:false`, so worst case a vault holds up
 *  to 200 concurrent live connections (100 SSE + 100 WS). Intentional on
 *  self-host (no per-connection billing, so no reason to contend one budget);
 *  the two caps converge to one when SSE retires (migration Phase 5). */
export const MAX_WS_SUBSCRIPTIONS = 100;

/** A pending (accepted-but-unauthed) socket must send `{type:"auth"}` within
 *  this window; the deadline timer closes stragglers (4408). Self-host uses a
 *  plain per-socket timer — there is no hibernation to defeat with it. */
export const WS_AUTH_DEADLINE_MS = 10_000;

/** Conservative per-frame byte budget for chunked snapshots — well under the
 *  ~1 MiB WebSocket message ceiling. A single note larger than this still ships
 *  as its own one-note chunk (documented residual — note bodies are markdown,
 *  ~never > 1 MiB). Matched to the cloud door so a snapshot chunks identically. */
export const SNAPSHOT_CHUNK_BYTES = 512 * 1024;

/** Secondary snapshot-chunk bound (note count) so many tiny notes still split. */
export const SNAPSHOT_CHUNK_MAX_NOTES = 200;

/** Application close codes (3000–4999 app-defined range), surfaced to browser JS
 *  so surface-client can branch (Phase 2). Byte-identical to the cloud door. */
export const WS_CLOSE = {
  /** Malformed frame / protocol violation / non-auth first message. */
  PROTOCOL: 4400,
  /** Auth failed, token expired, or revoked. */
  UNAUTHORIZED: 4401,
  /** Scope mismatch, or a re-auth that would WIDEN scope. */
  FORBIDDEN: 4403,
  /** Accepted socket never authed within {@link WS_AUTH_DEADLINE_MS}. */
  AUTH_TIMEOUT: 4408,
} as const;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * Validate a subscribe query for the WS path — the SAME rejects as the SSE
 * route (`subscribe.ts`): `search` / `near` / `cursor` / `has_links` / date
 * filters can't be evaluated against a single changed note. The 400 bodies +
 * `UNSUPPORTED_SUBSCRIPTION_QUERY` code are byte-identical to the SSE route (and
 * to the cloud door) so all three agree. Returns a ready 400 Response on
 * rejection, else the parsed `QueryOpts`.
 */
export function validateWsSubscribeQuery(url: URL): { error: Response } | { queryOpts: QueryOpts } {
  if (url.searchParams.get("search")) {
    return {
      error: json(
        {
          error:
            "search (full-text) is not supported for live subscriptions — FTS can't be evaluated against a single changed note. Drop `search` or poll GET /notes?search=.",
          code: "UNSUPPORTED_SUBSCRIPTION_QUERY",
        },
        400,
      ),
    };
  }
  if (url.searchParams.get("near[note_id]")) {
    return {
      error: json(
        {
          error:
            "near (graph neighborhood) is not supported for live subscriptions — BFS can't be evaluated against a single changed note. Drop `near` or poll GET /notes?near[note_id]=.",
          code: "UNSUPPORTED_SUBSCRIPTION_QUERY",
        },
        400,
      ),
    };
  }

  const parsed = parseNotesQueryOpts(url);
  if (parsed.error) return { error: parsed.error };
  const queryOpts = parsed.queryOpts!;

  const unsupported = unsupportedSubscriptionReason(queryOpts);
  if (unsupported) {
    return { error: json({ error: unsupported, code: "UNSUPPORTED_SUBSCRIPTION_QUERY" }, 400) };
  }
  return { queryOpts };
}

/** 503 body for the per-vault WS-subscription cap (mirrors the SSE 503). */
export function subscriptionCapResponse(): Response {
  return json(
    {
      error:
        "subscription cap reached for this vault — too many concurrent live subscriptions. Retry shortly or close idle streams.",
      code: "SUBSCRIPTION_CAP_REACHED",
    },
    503,
  );
}

/** Reconstruct a URL carrying `q` (the raw stored query string incl. leading
 *  `?`) so the shared parser can run. Host/path are irrelevant — only
 *  `searchParams` is read. */
export function urlFromQuery(q: string): URL {
  const u = new URL("https://ws.local/vault/_/api/subscribe");
  u.search = q ?? "";
  return u;
}

/**
 * Frame a snapshot into one or more `{type:"snapshot", notes, done}` messages,
 * each under the WS message ceiling. ALWAYS emits at least one frame (an empty
 * set → a single `done:true` frame) so the client's snapshot handler fires
 * exactly once per (re)connect. The consumer concatenates `notes` across frames
 * until `done:true`, then replaces its set (the SSE self-correcting-reconnect
 * semantics). Byte-shaped identically to the cloud door's `buildSnapshotFrames`.
 */
export function buildSnapshotFrames(notes: Note[]): string[] {
  const frames: string[] = [];
  const enc = new TextEncoder();
  let batch: Note[] = [];
  let batchBytes = 0;
  for (const note of notes) {
    const noteBytes = enc.encode(JSON.stringify(note)).byteLength + 1; // +1 ~ comma
    if (batch.length > 0 && (batchBytes + noteBytes > SNAPSHOT_CHUNK_BYTES || batch.length >= SNAPSHOT_CHUNK_MAX_NOTES)) {
      frames.push(JSON.stringify({ type: "snapshot", notes: batch, done: false }));
      batch = [];
      batchBytes = 0;
    }
    batch.push(note);
    batchBytes += noteBytes;
  }
  frames.push(JSON.stringify({ type: "snapshot", notes: batch, done: true }));
  return frames;
}

/** A parsed client message (auth / re-auth / other / malformed). */
export type ParsedClientMessage =
  | { kind: "auth"; token: string }
  | { kind: "other"; type: string | undefined }
  | { kind: "malformed" };

/** Parse a client WS message. The literal `ping` keepalive is handled by the
 *  server BEFORE this (answered `pong`), so only JSON objects reach here. */
export function parseClientMessage(message: string | ArrayBuffer | Uint8Array): ParsedClientMessage {
  let text: string;
  if (typeof message === "string") text = message;
  else {
    try {
      text = new TextDecoder().decode(message);
    } catch {
      return { kind: "malformed" };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed" };
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "auth") {
    if (typeof obj.token !== "string" || obj.token.length === 0) return { kind: "malformed" };
    return { kind: "auth", token: obj.token };
  }
  return { kind: "other", type: typeof obj.type === "string" ? obj.type : undefined };
}

const VERB_RANK: Record<VaultVerb, number> = { read: 0, write: 1, admin: 2 };

/**
 * The highest verb a scope set grants for `vaultName` (0/1/2, or -1 for none).
 * The WS re-auth check: a token refresh on an open socket may narrow-or-equal
 * the granted verb, never widen it (a widen → 4403). Mirrors the cloud door's
 * `vaultVerbRank`.
 */
export function vaultVerbRank(scopes: string[], vaultName: string): number {
  if (hasScopeForVault(scopes, vaultName, "admin")) return VERB_RANK.admin;
  if (hasScopeForVault(scopes, vaultName, "write")) return VERB_RANK.write;
  if (hasScopeForVault(scopes, vaultName, "read")) return VERB_RANK.read;
  return -1;
}

/**
 * True iff two tag-scope allowlists (`scoped_tags`) are the SAME restriction —
 * both unscoped (`null`), or the same set of root tags (order/dupe-insensitive).
 *
 * The WS re-auth check: unlike the SSE route (a token refresh means a fresh
 * reconnect that re-derives tag-scope on the initial-connect path), a WS socket
 * persists across a token refresh. Its live matcher + tag-scope are FROZEN at
 * initial auth and NOT re-derived per message, so a re-auth that changed the
 * tag-scope — a narrowed/revoked/differently-scoped agent token — would keep
 * receiving events for the ORIGINAL (possibly wider) scope. Tag-scoped tokens
 * are a load-bearing per-agent isolation boundary
 * (docs/contracts/tag-scoped-tokens.md), so a re-auth whose tag-scope differs in
 * ANY way is refused (4403) → the client reconnects fresh and re-derives scope
 * via the correct initial-connect path. Verb narrowing (same scope, extended
 * expiry) passes unchanged.
 */
export function sameTagScope(a: string[] | null, b: string[] | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}
