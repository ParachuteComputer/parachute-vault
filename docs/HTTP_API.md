# Parachute Vault HTTP API

A flat reference for the Parachute Vault REST surface. Intended for humans
*and* agents building tools that read or write a vault over HTTP.

All endpoints serve JSON. Every per-vault resource lives under a vault-scoped
root:

- `/vault/{name}/api/...` — the REST surface for one vault
- `/vault/{name}/mcp[/*]` — the MCP endpoint (not covered here; see
  `core/src/mcp.ts`)
- `/vault/{name}/oauth/{register,authorize,token}` and the matching
  `.well-known/*` documents — OAuth 2.1 + PKCE + DCR. See
  [`docs/auth-model.md`](./auth-model.md).
- `/vault/{name}/view/{idOrPath}` — auth-aware HTML rendering of published
  notes.

A fresh install creates a vault named `default`, so `/vault/default/api/...`
is the baseline URL for single-vault deployments. There is no unscoped
`/api/...` fallback — a request must name the vault it targets. Examples
below assume `default` for brevity.

> **URL change.** Prior to vault 0.4.x, the API also accepted
> `/api/...` (unscoped) and `/vaults/{name}/api/...` (plural). Both shapes
> have been removed; clients must re-authenticate and point at the
> `/vault/{name}/...` (singular) URLs.

## Quick start — render a graph in 5 lines

```js
// Fetch every note + every link as one payload, shape it for a force layout.
const res = await fetch("http://localhost:1940/vault/default/api/notes?format=graph&include_links=true", {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const { nodes, edges } = await res.json();
// nodes: { id, path, tags }[]
// edges: { source, target, relationship }[]
// Hand this to d3-force, cytoscape, sigma.js, etc.
```

That's the whole happy path. Everything else in this doc is detail.

## Conventions

- **Response payloads are camelCase**: `createdAt`, `sourceId`, `mimeType`,
  `totalNotes`.
- **Request bodies are mixed**: top-level keys mostly use snake_case
  (`if_missing`, `if_updated_at`, `include_content`) for parity with the MCP
  tool surface, but a few legacy fields (`createdAt`, `mimeType`) accept
  both. When in doubt, snake_case is the contract.
- **Query params are snake_case**: `?include_content=true`, `?tag_match=any`,
  `?date_from=2025-01-01`. This matches the MCP tool-arg convention, so one
  concept ports cleanly between HTTP and MCP.
- **Timestamps are ISO-8601** UTC strings (e.g. `2026-04-07T15:30:00.000Z`).
- **No envelope**. Successful responses are the data itself (`{...}` or
  `[...]`), not wrapped in `{data: ...}`. Errors use a structured shape with
  at least `error` (a short code) and `message` (human-readable text). Many
  4xx responses additionally carry `error_type` (snake_case canonical name)
  and context fields (`path`, `note_id`, `current_updated_at`, …).
- **CORS**: every endpoint sends `Access-Control-Allow-Origin: *` so static
  sites on any origin can call the API. Writes still require a valid token.

## Authentication

Pass a credential as either:

```
Authorization: Bearer <token>
X-API-Key: <token>
?key=<token>                 # query-param fallback, accepted everywhere
```

The query-param fallback exists for URL-only auth clients (Claude Web's
MCP transport, shareable `/view/...` links). Header forms are preferred
everywhere else — query strings end up in access logs.

Three credential types are accepted, in checking order:

| Type | Format | Provenance | Scope claim shape |
|---|---|---|---|
| Hub-issued JWT | three dot-separated base64url segments | minted by `parachute-hub` after an OAuth flow | resource-narrowed (`vault:<name>:<verb>`); broad `vault:<verb>` claims are rejected. Also carries a `vault_scope` claim — see below. |
| Server-wide operator token | `VAULT_AUTH_TOKEN` env var | set by the operator at boot | implicit `vault:admin` against every vault |
| Vault-pinned `pvt_*` token | `pvt_` followed by base64url, stored hashed in the vault's tokens table | minted via `POST /vault/<name>/tokens` or the CLI | explicit scope list (broad `vault:read` / `vault:write` / `vault:admin`); pinned to the issuing vault and rejected at any other |

The legacy `permission: "full" \| "read"` column and unscoped vault.yaml /
config.yaml api_keys still resolve for back-compat — they're mapped onto the
modern scope set on the fly and emit a deprecation log line. New deployments
should use the JWT path; new local tooling should use `pvt_*`. Scheduled for
removal in v0.6.0 (vault#282).

### Scopes

Every authenticated request resolves a `{vault, verb}` pair against the
token's scope list. Verbs and inheritance:

| Required verb | Triggered by | Inherited from |
|---|---|---|
| `read` | `GET`, `HEAD`, `OPTIONS` on `/api/*` | `write`, `admin` |
| `write` | `POST`, `PATCH`, `PUT`, `DELETE` on `/api/*` | `admin` |
| `admin` | `/tokens/*`, `/.parachute/config` (read), `/.parachute/mirror` (read+write); also `DELETE /api/notes/{id}` server-level enforcement | — |

A grant satisfies a (vault, verb) request if either:

- the granted scope is broad (`vault:<verb>` from a `pvt_*` token resolved
  against the requesting vault), or
- the granted scope is narrowed and names this vault
  (`vault:<this-vault>:<verb>`).

`vault:<other-vault>:<verb>` never satisfies; broad scopes inside hub-issued
JWTs are rejected at validation.

### `vault_scope` claim (hub JWTs)

Hub-issued JWTs additionally carry a `vault_scope: string[]` claim — the set
of vault names this token's holder may reach. `[]` means "any vault"
(admin); a non-empty array is a hard pin. The check runs defense-in-depth
after audience verification: a token with `vault_scope: ["alice-vault"]`
presented to `/vault/bob-vault/api/...` is refused with:

```
HTTP/1.1 403 Forbidden
{
  "error": "Forbidden",
  "error_type": "vault_scope_mismatch",
  "message": "token's vault_scope (alice-vault) does not include the requested vault 'bob-vault'",
  "required_vault": "bob-vault"
}
```

See [`docs/auth-model.md`](./auth-model.md) for the full OAuth flow,
discovery shape, and credential storage details.

### Insufficient-scope response

A token that authenticates but doesn't carry the required verb gets a 403
with a structured envelope:

```json
{
  "error": "Forbidden",
  "error_type": "insufficient_scope",
  "message": "This endpoint requires the 'vault:write' scope (or 'vault:default:write').",
  "required_scope": "vault:write",
  "granted_scopes": ["vault:read"]
}
```

## The shapes

### `Note`

```ts
{
  id: string;
  content: string;
  path?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  tags?: string[];
  validation_status?: ValidationStatus;  // present when any tag declares fields
}
```

### `NoteIndex` (lean shape)

Returned by list endpoints by default. Same as `Note` minus `content`, plus
`byteSize` and a one-line `preview` (~120 code points, whitespace
collapsed).

```ts
{
  id: string;
  path?: string;
  createdAt: string;
  updatedAt?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  byteSize: number;  // UTF-8 bytes of the full content
  preview: string;   // first ~120 chars, single line
}
```

### `Link`

```ts
{
  sourceId: string;
  targetId: string;
  relationship: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
```

### `Attachment`

```ts
{
  id: string;
  note_id: string;
  path: string;          // vault-relative; resolve under /storage to fetch bytes
  mime_type: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}
```

### `VaultStats`

```ts
{
  totalNotes: number;
  earliestNote: { id: string; createdAt: string } | null;
  latestNote:   { id: string; createdAt: string } | null;
  notesByMonth: { month: string; count: number }[];  // e.g. "2026-04"
  topTags:      { tag: string; count: number }[];
  tagCount:     number;
}
```

## Defaults: lean lists, fat point reads

- **List endpoints** (`GET /notes`) default to `NoteIndex[]`. The common case
  is viz/listing, which doesn't need the full body of every note.
- **Point reads** (`GET /notes/{id}`) default to the full `Note`. If you
  asked for one specific thing by ID, you probably want its content.

Both shapes can be forced either way with `?include_content=true|false`.

## Cursor pagination — the "since last checked" pattern

`GET /vault/{name}/api/notes?cursor=<opaque>` switches the response to
`{notes, next_cursor}` and routes through keyset pagination on
`(updated_at, id)`. Shipped in 0.4.8 (vault#313) for agent loops that need
to walk newly-written rows without losing the millisecond-tie edge.

**When to use.** Agent loops, `parachute-runner` polling, "give me what's
new since my last call" patterns. Wall-clock watermarks (passing back a
prior `updated_at` as `date_from`) miss or double-count at the millisecond
boundary; cursors eliminate the bookkeeping.

**Format.** Opaque. Treat as a black box — base64url over an internal
shape, self-contained, survives process restarts. Cursors bind to the query
that produced them (sha256 over the result-set-affecting filters: tags,
path, metadata, date filters), so reusing a cursor against a different
query returns `400 cursor_query_mismatch` rather than silently wrong rows.

**Incompatible parameters.** Cursor mode rejects:

- `sort=desc` — descending iteration would skip newly-written rows.
- `order_by=<other>` — incompatible with the updated_at keyset.
- `search=` (full-text) — FTS owns its own ordering (relevance).
- `near[note_id]=` (graph neighborhood) — neighborhoods aren't
  cursor-stable.

All four return `400` with `code: "INVALID_QUERY"`.

**Cycle.**

```
# First call — no cursor yet
GET /vault/default/api/notes?limit=50
→ 200 {
    "notes": [...],
    "next_cursor": "eyJxaCI6IjU3OS4uLiIsInUiOiIyMDI2LTA1LTIxVDA4OjAwOjAwLjAwMFoiLCJpIjoibm90ZS00MiJ9"
  }

# Persist next_cursor; on next iteration pass it back
GET /vault/default/api/notes?cursor=eyJxaC...
→ 200 {
    "notes": [],          # nothing new
    "next_cursor": "eyJxaC..."   # watermark unchanged
  }

# A note lands somewhere
POST /vault/default/api/notes  { content: "..." }

# Next call returns it; next_cursor advances
GET /vault/default/api/notes?cursor=eyJxaC...
→ 200 {
    "notes": [{ "id": "note-43", "updatedAt": "2026-05-21T08:01:23.456Z", ... }],
    "next_cursor": "eyJxaC2..."
  }
```

`next_cursor` is **always present**, even on an empty page — the watermark
only advances when rows were returned, so a polling client can persist a
single string and keep calling without special-casing the empty case.

**Error shapes.**

```json
{ "error": "...", "code": "cursor_invalid" }          // malformed / bad hash
{ "error": "...", "code": "cursor_query_mismatch" }   // filters changed; drop cursor + restart
```

`dateFilter` remains the lower-level primitive for absolute date ranges —
cursors and date filters coexist (cursor = "since last checked", dateFilter
= "between X and Y").

## Endpoints

The rest of this section documents every endpoint reachable on the REST
surface. Auth scope and HTTP method are noted on each.

### Server-level (cross-vault)

#### `GET /health` — no auth (vault names elided)
Liveness ping. Unauthenticated callers get `{status: "ok"}`; authenticated
callers also get `{vaults: string[]}`.

#### `GET /auth/status` — no auth
Tells a first-contact client what auth shapes the server accepts: whether
there's an owner password set, TOTP enrolled, vaults configured, and
whether any tokens exist (`hasTokens`: `boolean | null`). Used by the hub
and the Notes PWA's connect flow. Honors the global `discovery: disabled`
flag (returns 404 when discovery is off).

#### `GET /vaults/list` — no auth
Public vault-name discovery. Honors `discovery: disabled` (returns 404
when off).

```json
{ "vaults": ["default", "work"] }
```

#### `GET /vaults` — `vault:read` (any vault)
Vault metadata for every vault on the server.

```json
{
  "vaults": [
    { "name": "default", "description": "...", "created_at": "2026-..." }
  ]
}
```

### Per-vault landing

#### `GET /vault/{name}` — `vault:<name>:read`
Single-vault landing payload — name, description, createdAt, and stats in
one round trip.

```json
{
  "name": "default",
  "description": "My knowledge graph",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "stats": { "totalNotes": 617, "topTags": [...], "notesByMonth": [...], ... }
}
```

#### `GET /vault/{name}/.parachute/info` — no auth
Service-info card the hub fans out to render module tiles.

#### `GET /vault/{name}/.parachute/icon.svg` — no auth
Module-tile icon.

#### `GET /vault/{name}/.parachute/config/schema` — no auth
JSON Schema (draft-07) describing this vault's configurable shape — what
the hub admin SPA renders as a form. Includes `audio_retention`,
`autoTranscribe.*`, `port`, and the deprecated `scribe_url` / `scribe_token`
aliases.

#### `GET /vault/{name}/.parachute/config` — `vault:<name>:admin`
Current effective config values, with `writeOnly` fields (`scribeBearer`,
`scribe_token`) stripped. Shape mirrors the schema.

```json
{
  "audio_retention": "keep",
  "autoTranscribe": {
    "enabled": false,
    "scribeUrl": "http://127.0.0.1:1941"
  },
  "scribe_url": "http://127.0.0.1:1941",
  "port": 1940
}
```

### Notes

#### `GET /vault/{name}/api/notes` — `vault:read`
Query notes. Returns `NoteIndex[]` by default (lean shape). Many filter
modes coexist; the canonical query body is sketched in the cursor section
above.

Query params:

- **Output shape**
  - `include_content=true|false` — return `Note[]` (full body) instead of
    the default lean `NoteIndex[]`.
  - `include_links=true` — fold each note's outbound links into the result
    rows.
  - `include_attachments=true` — fold each note's attachments into the
    result rows.
  - `include_metadata=...` — comma-separated allowlist of metadata keys;
    other keys are stripped.
  - `format=graph` — reshape into `{nodes, edges}` for force-layout
    visualizations. Pairs with `include_links=true` to populate `edges`.

- **Selection by id / path**
  - `id=<id-or-path>` — fetch a single note. (Equivalent to
    `GET /api/notes/{id}` for the bare-fetch case but allows folding into
    the same response shape.)
  - `ids=a,b,c` — multi-fetch. Practical limit ~50 IDs due to URL length;
    for larger batches call multiple times.

- **Tag / link / structural filters**
  - `tag=foo&tag=bar` — repeat to pass multiple.
  - `tag_match=all|any` — default `all` (or `any` when more than one tag
    is supplied without an explicit `tag_match`).
  - `exclude_tag=foo` — exclude notes carrying this tag.
  - `has_tags=true|false`, `has_links=true|false`.
  - `path=foo/bar` — exact path match.
  - `path_prefix=foo/` — startswith.
  - `extension=md&extension=csv` — filter by file extension (vault#328).

- **Date filters**
  - **Canonical (bracket-style)**: `meta[created_at][gte]=ISO`,
    `meta[updated_at][lt]=ISO`, etc. Composes with arbitrary metadata
    filters through the same grammar.
  - **Flat (deprecated)**: `date_field=created_at&date_from=ISO&date_to=ISO`
    and the legacy two-param `date_from=ISO&date_to=ISO` (implicit
    `created_at`). Still functional through 0.5.x; removal in 0.6.0
    (vault#288). Bracket-style wins on overlap.

- **Metadata filters (bracket-style)**

  | Pattern | Meaning |
  |---|---|
  | `meta[field]=value` | shorthand for `eq` (routes through `json_extract`) |
  | `meta[field][eq|ne|gt|gte|lt|lte]=value` | comparison ops |
  | `meta[field][exists]=true|false` | presence check |
  | `meta[field][in]=a,b,c` or `meta[field][in][]=a&meta[field][in][]=b` | set membership |
  | `meta[field][not_in]=...` | set non-membership |

  Mixing shorthand and operator form on the same field is rejected.

- **Full-text search**
  - `search=query` — switches to FTS mode. Returns `Note[]` (full shape),
    not `NoteIndex[]`. Optional `tag=` filters compose. `limit` defaults to
    50. Incompatible with `cursor`.

- **Cursor pagination** (see [Cursor pagination](#cursor-pagination--the-since-last-checked-pattern))
  - `cursor=<opaque>` — switches response to `{notes, next_cursor}`.

- **Graph-neighborhood scope**
  - `near[note_id]=<id>` — restrict results to the graph neighborhood of
    this anchor.
  - `near[depth]=N` — default 2, capped at 5.
  - `near[relationship]=cites` — restrict the walked edges.

- **Sort + paging**
  - `sort=asc|desc` — by `updated_at`. Default `asc`.
  - `order_by=created_at|updated_at|...` — explicit column.
  - `limit=N` — default 50.
  - `offset=N` — default 0.

- **Wikilink expansion**
  - `expand=true&depth=2` — recursively inline `[[wikilink]]` targets into
    the returned content. `include_content=true` is required to see the
    effect.

Error shapes notable to callers:

- `400 INVALID_QUERY` — non-indexed `order_by`, unknown operator, cursor +
  incompatible param, etc.
- `400 cursor_invalid` / `400 cursor_query_mismatch` — see cursor section.
- `409 ambiguous_path` — `id=<path>` resolved to more than one note. Body
  carries `path` + `candidates: NoteIndex[]`. Re-issue with the exact id of
  the intended candidate.

#### `POST /vault/{name}/api/notes` — `vault:write`
Create a note, or a batch.

Single:

```json
{
  "content": "...",                // required (defaults to "" for an empty note)
  "id": "optional-client-id",
  "path": "Projects/Foo",
  "tags": ["a", "b"],
  "metadata": { "status": "draft" },
  "createdAt": "2026-04-07T...",
  "extension": "md",
  "links": [
    { "target": "<id-or-path>", "relationship": "cites" }
  ]
}
```

Batch (atomic — mid-batch failure rolls every prior insert back):

```json
{ "notes": [ {...}, {...} ] }
```

Returns the created `Note` (single) or `Note[]` (batch). `201 Created`.

Batch cap (vault#213): 500 notes per request. Exceeding it returns:

```
HTTP/1.1 413
{ "error_type": "batch_too_large", "limit": 500, ... }
```

Error shapes:

- `409 path_conflict` — UNIQUE(path) tripped; body carries `path`.
- `400 invalid_extension` — extension validation failed (vault#328); body
  carries `extension`, `reason`.

#### `GET /vault/{name}/api/notes/{idOrPath}` — `vault:read`
Returns the full `Note` (defaults to `include_content=true` for point
reads). `?include_content=false` returns a `NoteIndex`.

Folding options:

- `include_links=true` — append outbound links as a `links` field.
- `include_attachments=true` — append attachments as an `attachments` field.
- `include_metadata=...` — same allowlist as the list endpoint.
- `expand=true&depth=N` — inline `[[wikilink]]` targets.

#### `PATCH /vault/{name}/api/notes/{idOrPath}` — `vault:write`
Update content, path, metadata, extension, tags, or links. The body
supports three mutually-exclusive content modes:

```json
{
  "content": "new full body",                        // mode 1: full replace
  "append":  "trailing text",                        // mode 2: SQL-atomic concat
  "prepend": "leading text",                         //         (no precondition)
  "content_edit": { "old_text": "...", "new_text": "..." },  // mode 3: single-match replace

  "path": "new/path",
  "extension": "md",
  "metadata": { "status": "done" },                  // shallow merge with existing

  "tags": { "add": ["a"], "remove": ["b"] },         // set semantics
  "links": {
    "add":    [{ "target": "<id-or-path>", "relationship": "cites", "metadata": {} }],
    "remove": [{ "target": "<id-or-path>", "relationship": "cites" }]
  },

  "if_updated_at": "2026-05-20T...",                 // optimistic concurrency
  "force": true,                                     // bypass if_updated_at
  "if_missing": "create",                            // vault#309 — upsert
  "include_content": false                           // optional lean response
}
```

**Optimistic concurrency.** Updates require `if_updated_at` (the
`updatedAt` you last read for this note) unless `force: true`. Missing both
returns `428 Precondition Required`. Pure append/prepend updates (no
content/metadata/path/tags/links) are exempt — concatenation is
no-conflict-by-design.

**`if_missing: "create"` (vault#309 — shipped 0.4.5).** When the target
note doesn't exist, treat the PATCH body as a create. Useful for sync
loops that want one endpoint for both branches; the response carries
`created: true` (false on the update branch) so the caller can branch
without a second lookup. The create branch returns `200`, not `201` — the
response is "the note as it now exists", same contract as the update
path. `links.add` is applied on the create branch (mirrors MCP), `links.remove`
is ignored.

**Response shape.** Defaults to the full `Note` plus `validation_status`
(when any tag declares fields) plus `created: true|false`.
`include_content: false` returns the lean `NoteIndex` shape with the same
attached fields.

Error shapes:

- `409 conflict` — `if_updated_at` mismatched. Body carries
  `current_updated_at`, `your_updated_at`, `path`, `note_id`.
- `409 path_conflict` — UNIQUE(path) tripped on a rename.
- `409 ambiguous_path` — `{idOrPath}` matched multiple notes.
- `409 ambiguous` — `content_edit.old_text` matched twice.
- `422 unprocessable_content` — `content_edit.old_text` not found.
- `400 mutually_exclusive` — caller passed more than one content mode.
- `400 invalid_extension` — extension validation failed.

#### `DELETE /vault/{name}/api/notes/{idOrPath}` — `vault:write`
Returns `{deleted: true, id}`.

#### `POST /vault/{name}/api/notes/{idOrPath}/attachments` — `vault:write`
Body: `{"path": "files/a.png", "mimeType": "image/png", "transcribe"?: boolean}`.

There are **two transcription paths**; both feed the same worker but
differ in how the transcript surface is materialized.

**Path A — explicit caller opt-in (`transcribe: true`).** Legacy flow,
used by the Notes voice-memo client. Server queues a transcription job:
`attachment.metadata.transcribe_status = "pending"` is set, and
`note.metadata.transcribe_stub = true` is written as the opt-in to
overwrite content when the transcript lands. On success the worker
replaces the literal `_Transcript pending._` placeholder in the note
body with the transcript (or the whole body if the placeholder is
absent). A user edit clearing `transcribe_stub` before the transcript
arrives opts out of the overwrite.

**Path B — auto-transcribe (vault#353, shipped 0.4.8-rc.1).** When
`mimeType` starts with `audio/` AND `autoTranscribe.enabled === true` AND
scribe is discoverable, the attachment is queued automatically — no caller
flag needed. Instead of patching the source note, the worker materializes
a sibling `<attachment-path>.transcript.md` note with frontmatter:

```yaml
title: Transcript of <filename>
tags: [transcript, capture]
transcript_of: <attachment-path>
transcript_attachment_id: <id>
transcript_status: complete | failed
transcript_duration_ms: <ms>
transcript_error: <cause — failed only>
```

On success the transcript text is the note body. On failure (no provider
configured, scribe down, timeout) the same note is written with
`transcript_status: failed`, empty body, and the cause in
`transcript_error`. The original audio attachment is never deleted by this
path — operators can retry via `/retry-transcription` below.

Across both paths, `attachment.metadata.transcribe_status` becomes `"done"`
and `transcript`, `transcribe_done_at`, `transcribe_duration_ms` are
recorded on the attachment row, so the transcript is always addressable
from the attachment side too. The worker retries 5xx / network errors with
exponential backoff (up to three attempts); 4xx errors with structured
`error_code` (e.g. `missing_provider`) are treated as terminal.

The queue lives in the DB (`attachments` table), so a server restart
resumes pending work without replay.

#### `GET /vault/{name}/api/notes/{idOrPath}/attachments` — `vault:read`
Returns `Attachment[]`.

#### `DELETE /vault/{name}/api/notes/{idOrPath}/attachments/{attId}` — `vault:write`
Returns `204 No Content`. The attachment record is removed and the
underlying storage file is unlinked when no other attachment still
references the same path (orphan-check). Returns `404` if the attachment
doesn't exist or belongs to a different note. Idempotent: a second delete
of the same id returns `404`.

#### `POST /vault/{name}/api/notes/{idOrPath}/retry-transcription` — `vault:write`
Re-enqueues the original audio attachment for a transcript note whose
`transcript_status` is `failed`. Shipped in 0.4.8-rc.1 (vault#353,
design Q5). Returns 202 on success:

```json
{
  "status": "queued",
  "attachment_id": "<id>",
  "attachment_path": "<path>",
  "transcript_note_id": "<id>",
  "worker": "kicked" | "sweep-only"
}
```

`worker: "kicked"` means an in-process worker was woken; `"sweep-only"`
means no worker is registered this boot and the 30s sweep will pick up
the row. Either way the row is updated.

Error branches:

- `400 invalid_target` — target note has no `transcript_status` frontmatter
  (not a transcript note).
- `400 not_failed` — transcript already succeeded; nothing to retry.
- `400 missing_attachment_id` — transcript note lacks
  `transcript_attachment_id` (likely written by an older vault version).
- `404 attachment_missing` — original audio attachment row has been
  deleted.
- `404 audio_missing` — original audio file no longer exists on disk
  (e.g. `audio_retention: never` already unlinked it).

The same transcript note is overwritten in place; the note id is preserved
across retries.

### Graph queries

There is **no separate `/api/graph` or `/api/links` endpoint**. Both shapes
are derived projections of the notes endpoint:

- **`?format=graph` on `GET /api/notes`** returns `{nodes, edges}` instead
  of a flat list. Combine with `include_links=true` to populate `edges`.
  Filter parameters (`tag=`, `path_prefix=`, `near[...]`, etc.) all apply
  before the graph is shaped.
- **`?include_links=true` on `GET /api/notes` or `GET /api/notes/{id}`**
  folds outbound `Link[]` (hydrated) into each result row.
- **Link mutations** go through `PATCH /api/notes/{id}` with `links.add` /
  `links.remove`.

#### `GET /vault/{name}/api/find-path?source=...&target=...` — `vault:read`
BFS shortest path through the link graph between two notes (by id or
path). Optional `max_depth=N` (default 5, capped at 10).

Returns either `null` (no path) or:

```json
{ "path": ["note-a", "note-b", "note-c"], "edges": [...] }
```

Tag-scoped tokens see `null` when any intermediate hop is outside the
allowlist — a reachable target via an out-of-scope hop is not a permitted
answer.

### Tags

#### `GET /vault/{name}/api/tags` — `vault:read`
List all tags. Returns `[{name, count}]` by default; `?include_schema=true`
folds each tag's identity row (description, fields, relationships,
parent_names, created_at, updated_at) into the response.

#### `GET /vault/{name}/api/tags?tag=<name>` — `vault:read`
Single-tag detail (full identity record).

```json
{
  "name": "project",
  "count": 12,
  "description": "...",
  "fields": { ... },
  "relationships": { ... },
  "parent_names": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

#### `GET /vault/{name}/api/tags/{name}` — `vault:read`
Same as the `?tag=` query — single-tag detail by path.

#### `PUT /vault/{name}/api/tags/{name}` — `vault:write`
Upsert a tag's identity row. Body accepts any combination of:

```json
{
  "description": "string | null",
  "fields": { "<field>": { "type": "string", "enum": [...], ... } } | null,
  "relationships": { "<name>": { "cardinality": "one|many", "target_tags": [...] } } | null,
  "parent_names": ["parent-tag", ...] | null
}
```

Omitted keys are preserved; explicit `null` clears. `fields` merges into
the existing schema (mirrors MCP `update-tag`).

#### `DELETE /vault/{name}/api/tags/{name}` — `vault:write`
Removes the tag, its identity row, and untags every note. Returns the
delete result. Refused with `409 tag_in_use_by_tokens` if any tag-scoped
token references this tag — revoke or re-mint the tokens first.

#### `POST /vault/{name}/api/tags/{name}/rename` — `vault:write`
Body: `{ "new_name": string }`. Atomically renames the tag across the
`tags`, `note_tags`, and `tag_schemas` tables in a single transaction; the
rename also cascades into tag-scoped tokens' allowlists.

Returns `{ "renamed": number }` — the number of `note_tags` rows
rewritten.

Errors:

- `404 not_found` — source tag does not exist.
- `409 target_exists` — `new_name` (or one of its sub-tags) is already a
  tag. Caller should `POST /tags/merge` instead if combining the two tags
  is the intent.

#### `POST /vault/{name}/api/tags/merge` — `vault:write`
Body: `{ "sources": string[], "target": string }`. Retags every note
carrying any of the `sources` tags with `target`, then drops the source
tags (and their schemas) in a single transaction. `target`'s own schema is
preserved.

`target` is created if it doesn't exist yet. Sources that don't exist are
recorded with count `0`. Duplicate sources are deduped; `target` appearing
in `sources` is a no-op for that entry.

Returns `{ "merged": { [source]: count }, "target": string }`.

Refused with `409 tag_in_use_by_tokens` if any source tag is referenced by
a tag-scoped token.

### Vault config

#### `GET /vault/{name}/api/vault` — `vault:read`
Returns the vault's identity plus a nested `config` block for mutable
settings.

```json
{
  "name": "default",
  "description": "My knowledge graph",
  "config": {
    "audio_retention": "keep"
  }
}
```

`?include_stats=true` folds the same `VaultStats` shape into the response
under `stats`.

#### `PATCH /vault/{name}/api/vault` — `vault:write`
Update the description and/or nested `config` fields. Only the fields you
pass are changed; omitted fields are left alone.

```json
{
  "description": "new description",
  "config": { "audio_retention": "until_transcribed" }
}
```

Response echoes the full vault payload (same shape as `GET`).

##### `config.audio_retention`

Controls what the transcription worker does with the audio file on disk
once it reaches a terminal state. The attachment row (including any
recorded transcript) is always preserved — only the file on disk is
affected.

| Value | Behavior |
|---|---|
| `"keep"` (default) | Never unlink. The original audio stays on disk indefinitely. |
| `"until_transcribed"` | Unlink on successful transcription. On failure the file is kept so you can retry or re-upload. |
| `"never"` | Unlink on any terminal state — **including failure**. Users who opt in accept that losing a bad transcription also loses the source audio. |

Validation: `audio_retention` must be exactly one of those three strings.
Any other value returns `400 invalid_audio_retention`. Vaults created
before this setting existed read back as `"keep"`.

### Mirror config (vault-sync Phase A1)

The mirror endpoints expose the persistent `mirror:` block in
`config.yaml` and the in-process watch lifecycle — shipped in 0.4.7-rc.1
(vault#346 follow-up).

#### `GET /vault/{name}/.parachute/mirror` — `vault:<name>:admin`
Returns the current persisted config + runtime status:

```json
{
  "config": {
    "enabled": false,
    "location": "internal" | "external",
    "external_path": "/abs/path" | null,
    "watch": true,
    "auto_commit": true,
    "auto_push": false,
    "commit_template": "vault: ${count} note(s) updated",
    "interval_seconds": 60
  },
  "status": {
    "resolved_path": "/.../mirror",
    "watching": true,
    "last_export_at": "ISO",
    "last_commit_sha": "abc123",
    "last_error": null
  }
}
```

Returns 503 when the mirror manager hasn't initialized yet (fresh deploy,
boot error).

#### `PUT /vault/{name}/.parachute/mirror` — `vault:<name>:admin`
Update the mirror config. Atomic write to `config.yaml`, then in-process
restart of the watch loop with the new shape — no vault restart needed.

- `enabled=true` + `location=external` requires `external_path` to exist
  and be a git repo. Failure returns `400` naming the offending field.
- `enabled=false` PUTs skip path validation so an operator can disable a
  mirror whose path has gone missing.

### Token management

#### `GET /vault/{name}/tokens` — `vault:<name>:admin`
List `pvt_*` tokens scoped to this vault (plus any legacy server-wide
tokens, which authenticate cross-vault by design). Metadata only — no
plaintext, no hash.

```json
{
  "tokens": [
    {
      "id": "t_abc012345678",
      "label": "Daily sync",
      "permission": "full",
      "scopes": ["vault:read", "vault:write"],
      "scoped_tags": null,
      "vault_name": "default",
      "expires_at": null,
      "created_at": "2026-...",
      "last_used_at": "2026-..."
    }
  ]
}
```

#### `POST /vault/{name}/tokens` — `vault:<name>:admin`
Mint a new `pvt_*` token. Body:

```json
{
  "label": "Daily sync",
  "scopes": ["vault:read", "vault:write"],          // or "scope": "vault:read vault:write"
  "tags": ["project-a", "project-b"] | null,        // optional tag allowlist
  "expires_at": "2026-12-31T00:00:00.000Z" | null
}
```

Returns the plaintext token **exactly once**:

```json
{
  "id": "t_abc012345678",
  "token": "pvt_...",
  "label": "...",
  "scopes": [...],
  "scoped_tags": [...] | null,
  "vault_name": "default",
  "expires_at": null,
  "created_at": "..."
}
```

Defense-in-depth: the caller cannot mint a scope they don't already hold,
and a tag-scoped caller cannot mint an unscoped token. Failed checks
return `400` (with `rejected: [...]`) or `403` (with `error_type:
"tag_scope_violation"`).

#### `DELETE /vault/{name}/tokens/{id}` — `vault:<name>:admin`
Revoke a token. `{id}` is the `t_…` display id from the list. Returns
`{revoked: true}` on success; `404` if no token matches; `403` if the
token is bound to a different vault.

### Maintenance

#### `GET /vault/{name}/api/unresolved-wikilinks` — `vault:read`
List `[[wikilink]]`s in note content that don't currently resolve to any
note. `?limit=N` (default 50).

#### `GET /vault/{name}/api/health` — `vault:read`
Per-vault liveness ping. `{status: "ok", vault: "<name>"}`.

### Published notes (HTML)

#### `GET /vault/{name}/view/{idOrPath}` — auth-aware
Renders a single note as clean HTML. Unauthenticated requests see only
notes tagged with the configured `published_tag` (default `publish`) or
carrying `metadata.published === true`. A valid API key (header, query
param `?key=`, or session cookie via the consent flow) unlocks private
notes.

The legacy `/public/{noteId}` URL 301-redirects here.

### Storage

#### `POST /vault/{name}/api/storage/upload` — `vault:write`
Multipart form upload.

- `file` — required, ≤100MB.
- Allowed extensions: `.wav .mp3 .m4a .ogg .webm .png .jpg .jpeg .gif
  .webp .pdf .mp4`. `.svg` and `.html` are explicitly disallowed (XSS).

Returns `{path, size, mimeType}` (201).

#### `GET /vault/{name}/api/storage/{date}/{filename}` — `vault:read`
Serves the uploaded file bytes with the matching `Content-Type`. Path is
sandboxed under the vault's assets dir; traversal attempts return `403`.

### MCP

`GET|POST /vault/{name}/mcp[/*]` — Streaming HTTP transport. Auth is by
the same credentials as REST (Bearer / X-API-Key). Per-tool scope is
enforced inside the MCP layer; the same `vault:read` / `vault:write` /
`vault:admin` shape applies. See `core/src/mcp.ts` for the tool surface.

## See also

- [`core/src/mcp.ts`](../core/src/mcp.ts) — MCP tools mirror most REST
  reads. Tools use the same snake_case arg names and the same
  `include_content: true|false` lean/fat convention. The two surfaces are
  designed to stay in lockstep.
- [`docs/auth-model.md`](./auth-model.md) — full credential layering
  (OAuth, JWT, pvt_*, vault.yaml back-compat), discovery, session cookies,
  rate limiting.
- [`CHANGELOG.md`](../CHANGELOG.md) — canonical version history. Notable
  recent entries:
  - 0.4.8 — WAL mode (#326), cursor pagination (#313), auto-transcribe
    (#353), self-register (#266).
  - 0.4.7 — vault-sync Phase A1 / mirror endpoints (#346 follow-up),
    case-collision strict mode (#327).
  - 0.4.5 — `if_missing: "create"` on PATCH (#309).
- [`parachute.computer/design/2026-04-20-module-architecture.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-04-20-module-architecture.md)
  — module protocol (info / config / services.json / `.well-known`).
- [`parachute.computer/design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md)
  — OAuth-issuer architecture (the hub mints the JWTs that land here).
- [`parachute.computer/design/2026-05-21-scribe-config-and-vault-scribe-connect.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-scribe-config-and-vault-scribe-connect.md)
  — vault↔scribe handoff (the design behind auto-transcribe).
