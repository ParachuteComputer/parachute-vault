/**
 * Live-query SSE subscribe route (live-query SSE — design
 * `design/2026-06-08-live-query-sse.md`).
 *
 *   GET /vault/<name>/api/subscribe?<query params>
 *
 * Sends an `event: snapshot` of the currently-matching (scoped) notes, then
 * live `upsert`/`remove` events as notes change. Auth + tag-scope are already
 * resolved by the caller (routing.ts) and threaded in — the same `?key=` /
 * header credential and the same `tagScope` the notes path uses. This route
 * adds NO new auth plumbing.
 *
 * The query string is parsed by the SAME `parseNotesQueryOpts` the structured
 * notes-query branch uses, so the snapshot predicate and the live matcher
 * evaluate an identical `QueryOpts`. `search` (FTS) and `near` (graph BFS) are
 * not evaluable against a single in-memory note, so a subscribe request using
 * them is rejected with 400 BEFORE any stream opens.
 */

import type { Store, QueryOpts } from "../core/src/types.ts";
import { parseNotesQueryOpts, type TagScopeCtx } from "./routes.ts";
import { filterNotesByTagScope } from "./tag-scope.ts";
import { buildLiveMatcher, unsupportedSubscriptionReason } from "./live-match.ts";
import {
  snapshotFrame,
  subscriptionManager,
  type SubscriptionManager,
  type SubscriptionSink,
} from "./subscriptions.ts";

/** Keepalive interval — `:` comment every ~25s to defeat idle-proxy timeouts. */
const KEEPALIVE_MS = 25_000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * Handle `GET /api/subscribe`. `vaultName` + `tagScope` come from routing.ts
 * (auth already validated; tag-scope already expanded). `manager` is injectable
 * for tests; defaults to the process-wide singleton.
 */
export async function handleSubscribe(
  req: Request,
  store: Store,
  vaultName: string,
  tagScope: TagScopeCtx,
  manager: SubscriptionManager = subscriptionManager,
): Promise<Response> {
  if (req.method !== "GET") {
    return json({ error: "Method not allowed", message: "subscribe is GET-only" }, 405);
  }

  const url = new URL(req.url);

  // Reject the un-live-evaluable query shapes up front (before any stream).
  if (url.searchParams.get("search")) {
    return json(
      {
        error: "search (full-text) is not supported for live subscriptions — FTS can't be evaluated against a single changed note. Drop `search` or poll GET /notes?search=.",
        code: "UNSUPPORTED_SUBSCRIPTION_QUERY",
      },
      400,
    );
  }
  if (url.searchParams.get("near[note_id]")) {
    return json(
      {
        error: "near (graph neighborhood) is not supported for live subscriptions — BFS can't be evaluated against a single changed note. Drop `near` or poll GET /notes?near[note_id]=.",
        code: "UNSUPPORTED_SUBSCRIPTION_QUERY",
      },
      400,
    );
  }

  const parsed = parseNotesQueryOpts(url);
  if (parsed.error) return parsed.error;
  const queryOpts = parsed.queryOpts!;

  // Belt-and-suspenders: reject cursor (paging) too — meaningless for a live set.
  const unsupported = unsupportedSubscriptionReason(queryOpts);
  if (unsupported) {
    return json({ error: unsupported, code: "UNSUPPORTED_SUBSCRIPTION_QUERY" }, 400);
  }

  // Build the in-process matcher (resolves tag descendants once, same
  // hierarchy the snapshot query uses) — may throw QueryError on a malformed
  // metadata filter shape; surface as 400, same as the notes path.
  let matcher;
  try {
    matcher = await buildLiveMatcher(store, queryOpts);
  } catch (e: any) {
    if (e && e.name === "QueryError") {
      return json({ error: e.message, code: e.code ?? "INVALID_QUERY" }, 400);
    }
    throw e;
  }

  // Snapshot: the scoped query result. queryNotes throws QueryError on e.g. a
  // non-indexed metadata operator field — surface as 400 (no stream opened).
  //
  // Strip paging (M3): the live matcher ignores limit/offset, so a default
  // limit:50 would truncate the snapshot while live events deliver the full
  // set — snapshot ⊊ live. The snapshot must be the COMPLETE matching set.
  // queryNotes defaults an ABSENT limit to 100 (not unlimited), so pass a
  // large sentinel to fetch every matching row.
  const SNAPSHOT_UNBOUNDED = Number.MAX_SAFE_INTEGER;
  const snapshotOpts: QueryOpts = { ...queryOpts, limit: SNAPSHOT_UNBOUNDED, offset: undefined };
  let snapshotNotes;
  try {
    const raw = await store.queryNotes(snapshotOpts);
    snapshotNotes = filterNotesByTagScope(raw, tagScope.allowed, tagScope.raw);
  } catch (e: any) {
    if (e && e.name === "QueryError") {
      return json({ error: e.message, code: e.code ?? "INVALID_QUERY" }, 400);
    }
    throw e;
  }

  // Cap check BEFORE opening a stream so we can return a real 503. (The
  // in-`start` re-check below only guards the rare interleave race where two
  // subscribes pass this check before either registers.)
  if (!manager.hasCapacity(vaultName)) {
    return json(
      {
        error: "subscription cap reached for this vault — too many concurrent live subscriptions. Retry shortly or close idle streams.",
        code: "SUBSCRIPTION_CAP_REACHED",
      },
      503,
    );
  }

  // ---- Build the SSE stream ----
  //
  // A pull ReadableStream with an internal frame queue. The manager's sink
  // writes frames into the queue; `pull` drains them to the controller and
  // notifies the manager (so the backpressure counter decrements). When the
  // client disconnects, `cancel` fires → we unregister the subscription and
  // clear the keepalive timer.
  let handle: { flushed: () => void; close: () => void } | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const queue: string[] = [];
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  const encoder = new TextEncoder();

  const flushQueue = () => {
    if (!controllerRef || cancelled) return;
    while (queue.length > 0) {
      const frame = queue.shift()!;
      try {
        controllerRef.enqueue(encoder.encode(frame));
      } catch {
        // Controller closed underneath us — stop.
        cancelled = true;
        return;
      }
      handle?.flushed();
    }
  };

  const sink: SubscriptionSink = {
    write(frame: string): boolean {
      if (cancelled) return false;
      queue.push(frame);
      flushQueue();
      return true;
    },
    close(): void {
      if (cancelled) return;
      cancelled = true;
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      try {
        controllerRef?.close();
      } catch {
        /* already closed */
      }
    },
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // 1. Snapshot first — written into the queue and flushed on this tick.
      queue.push(snapshotFrame(snapshotNotes));

      // 2. Register the live subscription. Hook dispatch is deferred to a
      //    microtask, and we register synchronously here within start(), so no
      //    live event can slip in front of the snapshot. Over-cap → 503; we
      //    can't return a Response from inside the stream, so the cap is also
      //    checked below before constructing the Response. (Re-check here for
      //    the race where two subscribes interleave.)
      handle = manager.register({
        vaultName,
        matcher,
        tagScopeAllowed: tagScope.allowed,
        tagScopeRaw: tagScope.raw,
        sink,
      });
      if (!handle) {
        // Lost the cap race. Emit nothing further and close; the pre-check
        // below normally catches this, so this path is rare.
        flushQueue();
        try {
          controller.close();
        } catch {
          /* noop */
        }
        cancelled = true;
        return;
      }

      flushQueue();

      // 3. Keepalive comments.
      keepalive = setInterval(() => {
        if (cancelled) return;
        sink.write(":\n\n");
      }, KEEPALIVE_MS);
    },
    pull() {
      flushQueue();
    },
    cancel() {
      cancelled = true;
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      handle?.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defeat nginx-style proxy buffering of the event stream.
      "X-Accel-Buffering": "no",
    },
  });
}
