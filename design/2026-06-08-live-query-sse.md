# Live-query SSE — vault realtime subscriptions (MVP)

**Status:** design → build (2026-06-08)
**Scope:** parachute-vault. Additive. No schema change.

## What

A client opens an SSE stream for a query and receives:
1. a **snapshot** of the notes currently matching, then
2. **live events** as notes are created / updated / deleted, so the matching set
   stays current without polling.

This is the Supabase-realtime analog for the vault. Motivating consumer: a
surface rendering a chat thread of `#channel-message` notes for one channel —
subscribe once, render live, no polling, no dependency on the channel daemon's
own SSE. But the primitive is general: any surface that today polls
(`query-notes` on a timer) can subscribe instead.

## Why it's small

The vault already has the event source. Every mutation funnels through the
post-commit hook dispatcher (`core/src/hooks.ts`); the trigger system is already
a consumer of it (`src/triggers.ts`). A live subscription is **a second consumer
of the same dispatcher** — an ephemeral, connection-scoped sink alongside the
durable webhook sink. Nothing new is invented; we add a sink.

Framing that pays off later: an event is an event; sinks differ by durability.
A webhook trigger survives across connections (wakes an offline session). A live
subscription lives only while the socket is open (drives a UI). Same predicate,
same fire point.

## Endpoint

```
GET /vault/<name>/api/subscribe?<query params>
Accept: text/event-stream
```

- **Query params:** the *same* parsing as the notes-list query
  (`handleNotes` GET), restricted to the live-evaluable subset (below).
- **Auth:** `vault:<name>:read`, via `authenticateVaultRequest`. Token may be a
  header (`Authorization: Bearer …` / `X-API-Key`) **or** the existing `?key=`
  query param — EventSource can't set headers, so `?key=` is the SSE path. No
  new auth plumbing; `?key=` already flows through `extractToken`.
- **Response:** `text/event-stream`, a `ReadableStream` body (Bun-native).

### SSE wire format

```
event: snapshot
data: {"notes":[ <Note>, ... ]}

event: upsert
data: {"note": <Note>}

event: remove
data: {"id":"<note-id>"}

: keepalive        ← comment line every ~25s, defeats idle-proxy timeouts
```

- `snapshot` — sent once on connect (and on reconnect; see below).
- `upsert` — a create, or an update whose **new** state matches the query.
- `remove` — an update whose new state **no longer** matches (left the set), or
  a delete. Idempotent: the client ensures the id is absent from its set; if it
  never had the id, it's a no-op.

## Predicate parity (the careful part)

Two evaluators must agree for the same query:

- **Snapshot** uses the existing query engine (`core/src/notes.ts queryNotes` via
  `handleNotes`) — full SQL, indexed columns.
- **Live** uses a new **in-process matcher** that evaluates the same `QueryOpts`
  against a single in-memory note (no DB) — because the changed note is already
  in hand from the hook.

**Supported (both):** `tags` (with hierarchy/descendant expansion — same
expansion the query engine uses), `excludeTags`, `path`, `pathPrefix`,
`extension`, and metadata operators (`eq/ne/gt/gte/lt/lte/in/not_in/exists`)
evaluated directly against `note.metadata`. This covers the channel case
(`tag=#channel-message` ∧ `metadata.channel == "<name>"`).

**Rejected for subscriptions (MVP):** `search` (FTS) and `near` (graph BFS) —
not cheaply evaluable against a single note. A subscribe request using them
returns **400** with a clear message. (Future: predicate/query unification —
see below — would let triggers and subscriptions share the full language.)

**Consistency contract (test-enforced):** for any supported query, a note that
the snapshot query returns MUST be one the live matcher accepts, and vice-versa.
Tests assert `snapshotSet(q) ≡ {n : liveMatcher(q, n)}` over a seeded corpus.

## Auth / scope intersection (security-load-bearing)

A subscription MUST NOT emit a note the token can't read. Tag-scoped tokens
(`src/tag-scope.ts`; the vault#438 leak class) make this mandatory, not optional.

- On connect: expand the token's `scoped_tags` →
  `expandTokenTagScope(store, auth.scoped_tags)` → an allowlist (`null` =
  unscoped).
- **Snapshot:** reuse the existing `filterNotesByTagScope` already applied in the
  notes path — the snapshot is the scoped query result, nothing new.
- **Live, every event:** before emitting `upsert`, the changed note must pass
  **both** the subscription predicate **and** `noteWithinTagScope(note,
  allowlist)`. The scope check is ANDed with the predicate; it is not optional
  and not bypassable by query shape.
- `remove` on **update-left-set:** the note is in hand → scope-filter it; only
  emit to subscriptions whose scope could have seen it.
- `remove` on **hard delete:** the delete payload is intentionally thin
  (`{id, path?}`, no tags/metadata — `core/src/store.ts`), so it can't be
  scope-matched. MVP broadcasts `remove{id}` to all subscriptions; the client
  ignores ids it doesn't hold. The only leak is the *existence* of a deletion of
  an opaque uuid (no content/tags/path) to a client that couldn't see the note —
  low-sensitivity, documented, and closed later by the change-feed (which can
  store tags-at-delete for scope-filtering).

## Reconnection (MVP: snapshot-on-reconnect, no change-feed)

No `Last-Event-ID` replay in v1. On reconnect the client re-subscribes and gets
a fresh `snapshot`, which is self-correcting: the snapshot reflects current
state, so any inserts/updates/deletes missed while disconnected are reconciled
by replacing the set. The only thing lost is transient event granularity, which
a chat UI doesn't need. (Future: an append-only change-feed table
`(seq, note_id, op, ts, tags)` enables cursored replay + scope-filterable delete
events.)

## Fan-out, limits, backpressure

- **Fan-out:** one registered hook per event type; on each write, iterate active
  subscriptions and match each in-process — O(writes × subscriptions). At vault
  scale (hundreds of notes, single-digit open tabs) this is free. Documented
  ceiling, not a silent cap.
- **Subscription cap:** a configurable max concurrent subscriptions per vault
  (default 100) → `503` over it, bounding memory.
- **Backpressure:** per-subscription bounded send buffer. If a client can't keep
  up past the bound, close its stream (it reconnects + re-snapshots). Never grow
  unbounded.
- **Keepalive:** `:` comment every ~25s so the hub reverse-proxy and intermediary
  timeouts don't kill an idle stream. (SSE survives the hub proxy — proven by
  channel.)

## Out of scope (named, not silently dropped)

- Cursored replay / `Last-Event-ID` (needs change-feed table).
- Scope-filterable hard-delete events (needs change-feed).
- `search` / `near` live predicates (needs predicate/query unification).
- Building this into `surface-render` so every surface gets it free — separate,
  downstream, once the endpoint is stable.

## Test plan

- **Snapshot correctness** — seeded corpus, subscribe, assert snapshot == scoped
  query result.
- **Live insert/update/delete** — create/update/delete after connect, assert the
  right `upsert`/`remove` arrives (hook dispatch is deferred — await microtask).
- **Set-transition** — update a matching note so it no longer matches → `remove`;
  update a non-matching note so it now matches → `upsert`.
- **Scope intersection (the important one)** — a tag-scoped token MUST NOT
  receive snapshot notes or live events outside its scope; assert a note tagged
  outside the allowlist never reaches the stream on insert/update.
- **Predicate parity** — `snapshotSet(q) ≡ liveMatcher(q)` over the corpus for
  each supported predicate shape; `search`/`near` → 400.
- **Backpressure / cap** — over-cap subscribe → 503; documented buffer bound
  closes a stuck stream.
- `bun test ./src` + `bun run typecheck` both green (typecheck matters — Bun is
  lenient on strict-mode tsc rules CI enforces).
