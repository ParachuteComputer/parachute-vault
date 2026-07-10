# Parachute Vault HTTP API

A flat reference for the Parachute Vault REST surface. Intended for humans
*and* agents building tools that read or write a vault over HTTP.

All endpoints serve JSON. Every per-vault resource lives under a vault-scoped
root:

- `/vault/{name}/api/...` — the REST surface for one vault
- `/vault/{name}/mcp[/*]` — the MCP endpoint (not covered here; see
  `core/src/mcp.ts`)
- `/vault/{name}/.well-known/oauth-{protected-resource,authorization-server}`
  — OAuth discovery; both documents forward to the hub as the authorization
  server. See [`docs/auth-model.md`](./auth-model.md). (The matching
  `/vault/{name}/oauth/{register,authorize,token}` endpoints were retired
  in vault 0.4.x — workstream E — and now return `410 Gone`. Hub is the
  issuer; install it to drive the OAuth flow.)
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
  `?path_prefix=Projects`. This matches the MCP tool-arg convention, so one
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
| Hub-issued JWT | three dot-separated base64url segments | minted by `parachute-hub` after an OAuth flow, or via `parachute auth mint-token` / `parachute-vault mcp-install --mint` | resource-narrowed (`vault:<name>:<verb>`); broad `vault:<verb>` claims are rejected. Also carries a `vault_scope` claim — see below. |
| Server-wide operator token | `VAULT_AUTH_TOKEN` env var | set by the operator at boot | implicit `vault:admin` against every vault |
| Legacy `pvk_*` YAML key | bcrypt-hashed in `config.yaml` / `vault.yaml` `api_keys` | pre-0.3 deployments | mapped onto the modern scope set on the fly; emits a deprecation log line |

The legacy `permission: "full" \| "read"` column and unscoped vault.yaml /
config.yaml `pvk_*` api_keys still resolve for back-compat — they're mapped
onto the modern scope set on the fly and emit a deprecation log line. New
deployments should use the hub-JWT path (`parachute auth mint-token`).

> **`pvt_*` tokens were dropped at 0.5.0 (vault#282 Stage 2).** Vault no
> longer mints or accepts the vault-local opaque token; a `pvt_`-prefixed
> bearer now gets a `401` pointing you at the hub. Use a hub-issued JWT
> instead.

### Scopes

Every authenticated request resolves a `{vault, verb}` pair against the
token's scope list. Verbs and inheritance:

| Required verb | Triggered by | Inherited from |
|---|---|---|
| `read` | `GET`, `HEAD`, `OPTIONS` on `/api/*` | `write`, `admin` |
| `write` | `POST`, `PATCH`, `PUT`, `DELETE` on `/api/*` | `admin` |
| `admin` | `/.parachute/config` (read), `/.parachute/mirror` (read+write) | — |

A grant satisfies a (vault, verb) request if either:

- the granted scope is broad (`vault:<verb>` — only from a legacy `pvk_*`
  YAML key or `VAULT_AUTH_TOKEN`, resolved against the requesting vault), or
- the granted scope is narrowed and names this vault
  (`vault:<this-vault>:<verb>` — what hub JWTs carry).

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
  score?: number;  // vault#551 — search results ONLY; higher = more relevant, see "Full-text search" below
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
  score?: number;    // vault#551 — search results ONLY, carried onto the lean shape too (search's default response IS NoteIndex[])
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
prior `updated_at` as `meta[updated_at][gte]`) miss or double-count at the
millisecond boundary; cursors eliminate the bookkeeping.

**Bootstrap (vault#550).** `cursor` is keyed on PRESENCE, not on having a
real value yet — pass `?cursor=` (present, empty) on the FIRST call to
opt into the envelope with no watermark. `?cursor=` and an omitted `cursor`
param are different things: omitting `cursor` entirely stays a plain flat
array with no pagination and no way to resume (today's non-cursor
behavior, unchanged); `?cursor=` is "I want to paginate, starting now."
(Before 0.7.0-rc.2 the first call could never obtain a cursor at all — the
route only wrapped the response in `{notes, next_cursor}` when a cursor
param was ALREADY present, so there was no way to get the first one. This
is the fix.)

**Format.** Opaque. Treat as a black box — base64url over an internal
shape, self-contained, survives process restarts. Cursors bind to the query
that produced them (sha256 over the result-set-affecting filters: tags,
path, metadata, date filters), so reusing a cursor against a different
query returns `400 cursor_query_mismatch` rather than silently wrong rows.

**Incompatible parameters.** Cursor mode rejects:

- `sort=desc` — descending iteration would skip newly-written rows.
- `order_by=<other>` — incompatible with the updated_at keyset.
- `search=` (full-text) — cursor pagination needs a stable keyset; FTS5
  ranking (or, under an explicit `sort`, `created_at` ordering — see
  [Full-text search](#endpoints) below) isn't cursor-stable the way
  `(updated_at, id)` is.
- `near[note_id]=` (graph neighborhood) — neighborhoods aren't
  cursor-stable.

All four return `400` with `code: "INVALID_QUERY"`.

**Cycle.**

```
# First call — bootstrap with an EMPTY cursor, not an omitted one
GET /vault/default/api/notes?cursor=&limit=50
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
{ "error": "...", "code": "cursor_invalid" }          // malformed / bad hash — message now states the bootstrap flow (vault#550)
{ "error": "...", "code": "cursor_query_mismatch" }   // filters changed; drop cursor + restart
```

`dateFilter` remains the lower-level primitive for absolute date ranges —
cursors and date filters coexist (cursor = "since last checked", dateFilter
= "between X and Y").

## Honest queries — warnings channel + structured invalids (vault#550)

Ratified principle: if the vault can still answer the question asked,
answer it and attach a warning; if it would answer a DIFFERENT question,
return a structured named error. Silence is never the third option.

**Warnings channel (additive).** `GET /vault/{name}/api/notes` — both the
structured-query path and (as of vault#551) `search=` — can return
`warnings: [{code, message, ...}]` when something about the request looks
like a mistake but the query still ran and the result is still meaningful.
Warning codes today:

- `unknown_tag` — a `tag=` filter names a tag with no identity row, no
  notes carrying it, and (given the request's `expand` axis) no expansion
  members either. Carries `tag` and, when a close match exists,
  `did_you_mean` (case variant, prefix relationship, or small edit
  distance against the vault's real tag catalog). Capped at **8 per
  query** — past the cap a single `warnings_truncated` entry (carrying
  `suppressed` + `limit`) reports how many were dropped, so a garbage
  `tags` array can't inflate the response or the header unboundedly.
  Structured-query only.
- `removed_param` — the flat `date_field` / `date_from` / `date_to` query
  params (removed at 0.6.4, see below) are present. Carries `param`. One
  entry per removed param present. Structured-query only.
- `empty_search` (vault#551) — `search=` carried no literal content: blank/
  whitespace-only, or (in the default literal `search_mode`, where a
  manually-typed `"` is ordinary content and control bytes are separators)
  nothing but quote/whitespace/control characters. The query short-circuits
  to `[]` without ever calling FTS5, rather than risking a syntax error on a
  degenerate escaped phrase. `search=` only.
- `ignored_param` (vault#551) — a param was passed that has no effect given
  the rest of the request. Today's only case: `search_mode=` without
  `search=` (the mode only shapes how `search` text becomes an FTS5 query).
  Carries `param`. Structured-query only (by construction — this fires
  precisely because `search=` was absent).
- `search_did_you_mean` (vault#551 WS2B, schema v25) — `search=` returned
  ZERO results and a spelling suggestion cleared the similarity bar
  (edit-distance against the FTS5 vocabulary + tag names). Carries `query`
  and `did_you_mean`. `search=` only, only on a zero-result query, and only
  for UNSCOPED sessions (the suggestion is computed vault-wide — see below).
- `unresolved_link` (vault#555) — a structured `links` entry on
  `POST /notes` or `PATCH /notes/{id}` (mirrored by MCP `create-note` /
  `update-note`) didn't resolve to any note. Carries `target` and
  `relationship`. **Write path, not the query path above** — see "Structured
  `links` resolution" below for where this attaches on the response.

**Surfacing differs by response shape** (compat-preserving — this is why
it's additive, not a breaking wire-shape change):

- **Bare-array responses** (no `cursor` param, e.g. the plain
  `GET /notes?tag=...` list — this includes `search=`, which is always a
  bare `Note[]`, never an envelope) keep the bare-array body — a code
  consumer doing `for (const note of await res.json())` is unaffected —
  but gain a response header, `X-Parachute-Warnings`, set only when
  there's something to say: `encodeURIComponent(JSON.stringify(warnings))`.
  Percent-encoded because header VALUES are ASCII/Latin1-only while warning
  `message` text may not be; decode with `decodeURIComponent` then
  `JSON.parse`.
- **Envelope responses** (cursor mode, `{notes, next_cursor}`; also
  `{nodes, edges}` for `?format=graph`) carry `warnings` INLINE in the body
  when non-empty, in addition to the same header.

Tag-scoped tokens never see `unknown_tag`/`did_you_mean` or
`search_did_you_mean` — all are computed against the full vault-wide tag
catalog / FTS5 vocabulary, and surfacing them to a scoped session would
leak an out-of-scope tag's or note's name/existence across the scope
boundary (this codebase's standing "no leak" stance — see
[`docs/contracts/tag-scoped-tokens.md`](./contracts/tag-scoped-tokens.md)).
`removed_param` carries no tag information and is unaffected by scope.

**Structured invalids (400, `error_type: "invalid_query"`).** Three cases
that used to silently mean something OTHER than what was typed now error
loudly instead, each carrying `{error_type, field, got, hint}` alongside
the existing `error`/`code`:

- `limit` negative or non-numeric — SQLite treats a negative `LIMIT` as
  "no limit," so `?limit=-1` used to silently return EVERYTHING.
- `offset` negative or non-numeric.
- an unparseable value in a bracket date filter
  (`?meta[created_at][gte]=not-a-date`) — used to bind straight into a
  lexicographic string comparison against real ISO timestamps and quietly
  match nothing, or everything, depending on how the garbage happened to
  sort.
- `search_mode` set to anything other than `literal` / `advanced`.

```json
{
  "error": "invalid limit: -1 — must be a non-negative integer ...",
  "code": "INVALID_QUERY",
  "error_type": "invalid_query",
  "field": "limit",
  "got": "-1",
  "hint": "pass a non-negative integer, or omit for the default"
}
```

The MCP `query-notes` tool call surfaces the identical `error_type` (via a
structured JSON-RPC error) for the same cases — see the tool description
for `limit`/`offset`/`date_filter`/`search_mode`.

**Structured invalids (400, `error_type: "invalid_search_syntax"`, vault#551).**
A DISTINCT `error_type` from `invalid_query` above — this one is specifically
about `search_mode: "advanced"` raw FTS5 syntax that FTS5 itself rejected
(an unbalanced quote, a dangling boolean operator, ...). Before vault#551
every FTS5 syntax error — in EITHER search mode — was silently swallowed
into `[]`. **Literal mode (the default) cannot produce this error:** the
query text is escaped, phrase-quoted, and control-character-sanitized
(NUL and other C0/DEL bytes become token separators) *before* FTS5 ever
sees it, so no user input can reach the FTS5 parser as syntax. As a
belt-and-suspenders guarantee, if a literal-mode query somehow still made
FTS5 throw (a vault bug), it surfaces as this same structured error — never
a raw `SQLiteError` 500. Advanced mode is where a syntax error is a normal,
caller-fixable outcome:

```json
{
  "error": "invalid search syntax: fts5: syntax error near \".\"",
  "code": "INVALID_QUERY",
  "error_type": "invalid_search_syntax",
  "field": "search",
  "got": "18.6",
  "hint": "FTS5 rejected this as advanced query syntax (fts5: syntax error near \".\"). Fix the syntax, or omit search_mode:\"advanced\" for literal (punctuation-safe) search."
}
```

**Wrapped column-filter hint (vault#551 WS2B item 4).** A bare leading
`-token` in advanced mode (e.g. `search_mode=advanced&search=-espresso`)
misparses — FTS5's `NOT`/`-` is a BINARY operator, so a lone `-token` with
nothing to its left gets read as `column:term` filter syntax and fails
looking for a column literally named after your token. The raw FTS5
message (`no such column: espresso`) is confusing on its own — the `hint`
is rewritten for this specific pattern instead of forwarding it verbatim:

```json
{
  "error": "invalid search syntax: no such column: espresso",
  "code": "INVALID_QUERY",
  "error_type": "invalid_search_syntax",
  "field": "search",
  "got": "-espresso",
  "hint": "FTS5 read part of this query as column-filter syntax (\"column:term\") or as a leading \"-\" with no term to its left — NOT/\"-\" is a BINARY operator in FTS5 (\"good -bad\", not \"-bad\" alone). Indexed columns are \"path\" and \"content\". Add a preceding positive term before a NOT, quote the phrase to search it literally, or use search_mode:\"literal\" (the default) to skip advanced syntax entirely."
}
```

The MCP `query-notes` tool call surfaces the identical `error_type` (via a
structured JSON-RPC error, `src/mcp-http.ts`).

## Error taxonomy — `error_type` contract table (vault#554, Wave 4)

Every error body an agent or client can receive — REST 4xx/5xx JSON and MCP
JSON-RPC error `data` — carries a stable `error_type` string, additive to
whatever transport-specific fields already existed (`error`, `code`, HTTP
status). Structured fields beyond `error_type` follow one vocabulary:
`field` (which input), `expected`/`got` (what was wrong), `hint` (how to
fix it), plus error-specific extras (`violations`, `candidates`, ...).
**Agents branch on `error_type` alone** — the prose in `error`/`message` is
for humans and may be reworded across releases; `error_type` strings and
HTTP statuses are wire contract and do not change without a migration.

On MCP, every error below arrives as a JSON-RPC error whose `data` field
carries the same shape (`src/mcp-http.ts`'s domain-error mapping); on REST,
as the JSON response body at the listed HTTP status. Where a row lists two
statuses, REST and MCP intentionally differ only in HTTP-status framing —
the `error_type` and fields are identical.

### Write-path conflicts (optimistic concurrency, path, schema)

| `error_type` | HTTP | Key fields | Meaning |
|---|---|---|---|
| `conflict` | 409 | `note_id`, `path`, `current_updated_at`, `your_updated_at` | `if_updated_at` didn't match the note's current `updated_at` — someone else wrote first. Re-read and retry, or `force: true`. |
| `transition_conflict` | 409 | `note_id`, `path`, `field`, `expected_from`, `to`, `current` | `state_transition`'s compare-and-set: the field's CURRENT value didn't equal `from`. Distinct vocabulary from `conflict` — a value mismatch, not a stale `updated_at` token. |
| `path_conflict` | 409 | `path` | The requested `path` is already taken by another note (UNIQUE constraint). |
| `ambiguous_path` | 409 | `path`, `candidates` | The `{idOrPath}` (or a `source`/`target`/note reference) matched more than one note sharing a path but differing extension. Pass `extension` to disambiguate, or use the candidate's ID. |
| `schema_validation` | 422 | `violations[]` (`{field, reason, message, strict}`) | One or more `strict: true` field constraints were violated — **or** an `indexed: true` field's TYPE was violated (vault#553 Decision A: an indexed field's type is a query contract, enforced unconditionally, independent of that field's own `strict` flag — a `type_mismatch` violation carries `strict: true` either way). Carries EVERY violation in one response — nothing was written. |
| `precondition_required` | 428 | `note_id`, `path` | A mutating update needs `if_updated_at` or `force: true` and got neither. Append/prepend-only and transition-only updates are exempt. |
| `batch_too_large` | 413 | `limit`, `got` | A batch `create-note`/`update-note`/`POST /notes` exceeded the 500-item cap. |
| `invalid_extension` | 400 | `extension`, `reason` | The `extension` field failed validation (empty, uppercase, contains `.`/`/`, reserved `parachute` prefix, ...). |

### Content-edit branch (`content`/`append`/`content_edit` on update-note)

| `error_type` | HTTP | Key fields | Meaning |
|---|---|---|---|
| `mutually_exclusive` | 400 | `hint` | More than one of `content`, `append`/`prepend`, `content_edit` was passed — pick exactly one content-update mode. |
| `invalid_content_edit` | 400 | `field: "content_edit"` | `content_edit` isn't `{old_text: string, new_text: string}`. |
| `content_edit_not_found` | 422 | `field: "content_edit.old_text"` | `old_text` doesn't occur in the note's current content — it may have been edited since you last read it. |
| `content_edit_ambiguous` | 409 | `field: "content_edit.old_text"` | `old_text` matches more than once — add surrounding context so it matches exactly once. |
| `invalid_state_transition` | 400 | `field: "state_transition.field"` | `state_transition.field` must be a non-empty string. |

### Tag schema (`update-tag` / `PUT /api/tags/{name}`)

| `error_type` | HTTP | Key fields | Meaning |
|---|---|---|---|
| `tag_field_conflict` | 422 | `tag`, `violations[]` (`{field, reason, message, other_tag?}`) | One or more fields in this call conflict with another tag's declaration, OR a field's declared `default` doesn't conform to its own `type`/`enum` (vault#553 Decision B). Carries EVERY conflicting field in one response (vault#553) and states explicitly that **no changes were applied**. `reason` is `type_conflict` (NON-indexed incoming fields only — see `invalid_indexed_field` for the both-indexed case), `indexed_flag_conflict`, or `invalid_default` (own-field — no `other_tag`); `other_tag` names the conflicting declarer for the cross-tag reasons. **Tag-scope generalization:** for a tag-scoped session, a violation whose conflicting declarer is outside the token's allowlist is generalized — the write is still rejected, but the message names no tag and reveals no declared type/flag, and `other_tag` is omitted. In-scope declarers keep full detail. |
| `invalid_indexed_field` | 400 | (message only) | An indexed-field declaration failed: an unsupported type for indexing (only string/integer/boolean), an invalid identifier (must match `[A-Za-z_][A-Za-z0-9_]{0,62}`), or a cross-tag TYPE conflict where the incoming field is itself `indexed: true` (the pre-existing vault#478 contract — this case stays 400 here rather than joining `tag_field_conflict`'s 422). **Tag-scope generalization:** the cross-declarer message names the other declarer tag(s) + their storage type; for a tag-scoped session with any out-of-scope declarer, the message is generalized (no tag names, no existing type) — same status, same `error_type`. |
| `invalid_field_default` | 400 | `field` | vault#553 Decision B: a field's declared `default` doesn't match its own `type` (or isn't one of its own `enum` values). Own-field error — REST's single-violation fail-fast path via `store.upsertTagRecord`'s pre-validate (mirrors `invalid_indexed_field`'s posture); MCP's `update-tag` tool normally reports the SAME defect bundled as `tag_field_conflict`'s `invalid_default` reason instead (its own-field checks run first — see that row). |
| `invalid_relationships` | 400 | (message only) | `relationships` isn't a JSON object, or isn't JSON-serializable. |
| `invalid_parent_names` | 400 | `field: "parent_names"` | `parent_names` isn't an array of tag-name strings. |
| `tag_not_found` | 404 | `tag`, `did_you_mean?` | The named tag has no identity row AND no notes carrying it. `did_you_mean` (a close match) is present only when found AND — for a tag-scoped session — itself in-scope. |
| `tag_in_use_by_tokens` | 409 | `tag`, `referenced_by[]` | Deleting or merging away this tag would orphan a tag-scoped token's allowlist. Revoke or re-mint the token(s) first. |
| `target_exists` | 409 | `target`, `conflicting` | `POST /tags/{name}/rename`'s `new_name` (or a sub-tag of it) already exists — use `POST /tags/merge` instead. |
| `tag_referenced_as_parent` | 409 | `tag`, `referencing_tags[]` | vault#552: `DELETE /tags/{name}` refused because another tag's `parent_names` still names this one — deleting would silently orphan that reference. Pass `?cascade=true` or `?detach=true` (synonyms — either strips the stale reference from every referencing tag's `parent_names`; neither deletes the referencing tags) to proceed. **Tag-scope generalization:** `referencing_tags` entries outside the caller's allowlist are replaced with a generic label — the delete stays refused either way (referential integrity is scope-independent). |
| `parent_cycle` | 409 | `tag`, `cycle[]` | vault#552: `PUT /tags/{name}`'s `parent_names` would create a cycle in the hierarchy (a direct A↔B, a longer transitive chain, or a bare self-parent). `cycle` is the offending path (e.g. `["A", "B", "A"]`). Nothing is persisted. **Tag-scope generalization:** a hop in `cycle` outside the caller's allowlist is replaced with a generic label; the caller's own tag (`tag`) is always in-scope and never redacted. |

### Query / search validation

| `error_type` | HTTP | Key fields | Meaning |
|---|---|---|---|
| `invalid_query` | 400 | `field`, `got`, `hint`, `code` | A structured-query or bracket-filter param is malformed: bad `limit`/`offset`, an unparseable date, an unknown `expand`/`search_mode` value, an incompatible `cursor`+`search`/`near` combo, a bracket-filter shape error, an unindexed field in an operator query, and other `QueryError` throws. `code` carries the finer-grained legacy vocabulary (`INVALID_QUERY`, `FIELD_NOT_INDEXED`, `UNKNOWN_OPERATOR`, `INVALID_OPERATOR_VALUE`, ...) for callers that already keyed on it. |
| `invalid_search_syntax` | 400 | `field: "search"`, `got`, `hint` | `search_mode: "advanced"` raw FTS5 syntax that FTS5 itself rejected. Distinct from `invalid_query` — literal mode (the default) cannot produce this, since the query is escaped before FTS5 ever sees it. |
| `cursor_invalid` | 400 | (message only) | The `cursor` string is malformed, not base64url, not JSON, or fails schema validation. Restart iteration with a fresh (empty) cursor. |
| `cursor_query_mismatch` | 400 | (message only) | The `cursor` was minted for a different query (its embedded hash doesn't match this call's filters). Drop the cursor and restart. |

### Not found / method / transport

| `error_type` | HTTP | Key fields | Meaning |
|---|---|---|---|
| `not_found` | 404 | `id?`/`note_id?` (varies by endpoint) | Generic resource-not-found: a note, an anchor/source/target note reference, a vault, or (for a tag-scoped session) a note outside the token's allowlist — 404, never 403, so scope boundaries don't leak existence. |
| `method_not_allowed` | 405 | — | The HTTP method isn't supported on this route. |
| `invalid_json` | 400 | — | The request body failed to parse as JSON. |
| `invalid_request` | 400 | `field?`, `hint?` | A required param/field is missing or the wrong shape (e.g. `find-path`'s `source`/`target`, tag-merge's `sources`/`target`). |
| `missing_required_field` | 400 | `field?`, `hint?` | A specific named field is required and absent (e.g. attachment `path`/`mimeType`, storage upload `file`). |
| `tag_scope_violation` | 403 (REST) / forbidden (MCP) | `scoped_tags` | A tag-scoped token attempted a write outside its allowlist. |
| `internal_error` | 500 | — | An invariant the server expected to hold didn't (e.g. a just-created note not found on immediate re-read). Rare; file an issue if seen. |

### Vault config (`PATCH /api/vault`)

| `error_type` | HTTP | Key fields | Meaning |
|---|---|---|---|
| `invalid_audio_retention` | 400 | `field`, `got`, `hint` | `config.audio_retention` isn't one of `keep`, `until_transcribed`, `never`. |
| `invalid_auto_transcribe` | 400 | `field`, `got`, `hint` | `config.auto_transcribe.enabled` isn't a boolean. |

### Storage upload/serve

| `error_type` | HTTP | Key fields | Meaning |
|---|---|---|---|
| `file_too_large` | 413 | `limit`, `got` | Upload exceeds the 100MB cap. |
| `blocked_upload_extension` | 400 | `extension` | The extension is on the active-content blocklist (`.html`, `.svg`, `.js`, `.css`, ...) — same-origin XSS surface if served back. |
| `invalid_path` | 403 | — | The requested storage path resolves outside the vault's assets directory (traversal guard). |

### Transcription retry (`POST /notes/{idOrPath}/retry-transcription`)

| `error_type` | HTTP | Meaning |
|---|---|---|
| `not_failed` | 400 | The transcript note's status isn't `"failed"` — only failed transcripts can be retried. |
| `missing_attachment_id` | 400 | The transcript note has no `transcript_attachment_id` to locate the original audio. |
| `attachment_missing` | 404 | The original audio attachment row no longer exists. |
| `audio_missing` | 404 | The original audio file no longer exists on disk (already unlinked, e.g. by retention policy). |
| `no_failed_attachment` | 400 | (legacy in-body memo) The note has no audio attachment with a failed transcription to retry. |

## Content range — bounded reads for large notes

MCP responses are size-limited: a 100KB transcript can't come back from one
`query-notes` call, and a remote MCP client has no `curl | head -c` escape
hatch. `content_offset` / `content_length` page through note *content* in
byte windows (orthogonal to `cursor`, which pages through note *lists*):

```
GET /vault/{name}/api/notes/{id}?content_offset=0&content_length=65536
→ { ..., "content": "<first ≤64KB>",
       "content_offset": 0,            // effective start (see alignment below)
       "content_total_length": 118034, // full size, UTF-8 bytes
       "content_next_offset": 65530 }  // pass back as content_offset; null when done
```

Loop until `content_next_offset` is `null`; concatenating the slices
reconstructs the content byte-for-byte (the reassembly invariant is pinned
by a property test).

**Unit + alignment.** The unit is **UTF-8 bytes** (same as `byteSize` on the
lean `NoteIndex`). Slices always end on a codepoint boundary *within* the
budget — never over `content_length`, but up to 3 bytes under when a
multi-byte character straddles the cut (which is why the example above
resumes at 65530, not 65536). An offset landing mid-codepoint (only possible
when you compute offsets by hand — chained `content_next_offset` values are
always aligned) is aligned **down** to the codepoint's leading byte so no
bytes are skipped; the effective start is echoed back as `content_offset`.

**Rules.**

- `content_offset` ≥ 0 (default 0); `content_length` ≥ 4 (the largest UTF-8
  codepoint, so every window makes progress). Invalid values → `400
  INVALID_QUERY`.
- Range params require content in the response. With
  `include_content=false` — or a list query left on its lean default — they
  error (`400 INVALID_QUERY`) rather than silently no-op.
- An offset at/past the end returns `content: ""` with
  `content_next_offset: null` (graceful loop termination, e.g. when the
  note shrank between calls).
- On **list** queries (with `include_content=true`) the same window applies
  to each note's content independently — every note reports its own
  `content_total_length` / `content_next_offset`. The primary use is a
  single large note.
- With `expand=true` (wikilink inlining) the range applies to the returned
  (expanded) content.
- Without range params, responses are byte-identical to the pre-pagination
  shape — no new fields appear.

The MCP face is identical: `query-notes` takes `content_offset` /
`content_length` as tool params and returns the same response fields.

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
above. Each result carries `validation_status` when any tag it carries
declares `fields` (vault#555 — additive, absent entirely for a vault that
declares no tag schemas; same attachment rule as create/update responses,
now extended to reads).

Query params:

- **Output shape**
  - `include_content=true|false` — return `Note[]` (full body) instead of
    the default lean `NoteIndex[]`.
  - `content_offset=N&content_length=M` — byte window over each returned
    note's content (requires `include_content=true` here; the lean default
    has no content to slice). See "Content range — bounded reads for large
    notes" above for units, alignment, and the response fields
    (`content_total_length`, `content_next_offset`).
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
  - **Bracket-style** (the query-string date filter): `meta[created_at][gte]=ISO`,
    `meta[updated_at][lt]=ISO`, etc. Composes with arbitrary metadata
    filters through the same grammar. Only `gte` (inclusive lower) and `lt`
    (exclusive upper) are accepted on the `created_at` / `updated_at` columns.
  - **Removed (vault#288)**: the flat `date_field` / `date_from` / `date_to`
    query params (and the legacy bare `date_from`/`date_to` shape) were removed
    in 0.6.4 and are now silently ignored — a request that passes only flat date
    params comes back unfiltered. Use bracket-style. (The MCP `query-notes`
    `date_from` / `date_to` shorthand is a separate, supported convenience and
    is unaffected.) Since vault#550, passing any of them now ALSO surfaces a
    `removed_param` entry on the [warnings channel](#honest-queries--warnings-channel--structured-invalids-vault550) — still ignored, no longer silent.
  - An unparseable value on either bound (`meta[created_at][gte]=not-a-date`)
    is a `400 invalid_query` (vault#550) — see the warnings-channel section.

- **Metadata filters (bracket-style)**

  | Pattern | Meaning |
  |---|---|
  | `meta[field]=value` | shorthand for `eq` (routes through `json_extract`) |
  | `meta[field][eq|ne|gt|gte|lt|lte]=value` | comparison ops |
  | `meta[field][exists]=true|false` | presence check |
  | `meta[field][in]=a,b,c` or `meta[field][in][]=a&meta[field][in][]=b` | set membership |
  | `meta[field][not_in]=...` | set non-membership |

  Mixing shorthand and operator form on the same field is rejected.

- **Metadata filters (JSON alias)**
  - `metadata=<json>` — the JSON-object form of the same filter, e.g.
    `metadata={"status":{"eq":"open"},"priority":{"gte":3}}`. This is
    **symmetric with the nested `metadata` object the MCP `query-notes` tool
    takes** — paste the same object you'd send over MCP, URL-encoded.
    Shorthand equality works too: `metadata={"status":"open"}` lowers through
    the `json_extract` fallback. JSON preserves real number/boolean types, so
    `{"priority":{"gte":3}}` compares numerically.
  - **Not both.** Pass metadata filters as *either* the JSON `metadata=` param
    *or* the bracket `meta[field][op]=` form, not both — supplying both is a
    `400 INVALID_QUERY` (we won't silently pick a winner). The `metadata=`
    alias does compose with bracket *date* filters (`meta[created_at][gte]=…`),
    which are a separate axis.

- **Full-text search** (vault#551 — literal-by-default)
  - `search=query` — switches to FTS mode. Returns a bare array (lean
    `NoteIndex[]` by default, `Note[]` with `include_content=true` — same
    lean/full-shape default as the structured-query path). Optional `tag=`
    filters compose. `limit` defaults to 50. Incompatible with `cursor`.
  - **Literal by default.** Your query text is escaped and phrase-quoted
    before it reaches FTS5: control bytes (NUL and other C0/DEL characters)
    are sanitized to token separators, then split on whitespace, each token
    wrapped in `"..."` with internal `"` doubled, joined with spaces
    (implicit AND). This is the fix for ordinary punctuation silently
    returning `[]` — `search=didn't`, `search=eleven-day capping delay`,
    and `search=18.6` all now find their matches; before vault#551 the bare
    hyphen was parsed as an FTS5 NOT-operator and the apostrophe/decimal
    point broke the FTS5 parse outright. Because every input is sanitized +
    escaped before FTS5 sees it, literal mode can never surface an FTS5
    syntax error (a residual parser error would surface *structured*, never
    a 500 — see [`invalid_search_syntax`](#honest-queries--warnings-channel--structured-invalids-vault550) above).
  - `search_mode=advanced` opts back into RAW FTS5 query syntax — the
    pre-vault#551 behavior, unchanged: boolean operators (`AND`/`OR`/`NOT`),
    manual phrase quoting (`"exact phrase"`), and prefix matching
    (`term*`) are honored as syntax. A malformed advanced query now throws
    a structured `400 invalid_search_syntax` (see above) instead of
    silently returning `[]`. `search_mode` values other than
    `literal`/`advanced` are `400 invalid_query`; passing `search_mode`
    without `search` is a no-op that surfaces an `ignored_param` warning.
  - **Breaking change / migration.** A caller who relied on raw FTS5 syntax
    working under the DEFAULT `search=` (no `search_mode`) — e.g. manual
    phrase quoting to force an exact match, boolean operators, prefix `*`
    — must add `search_mode=advanced` to keep that exact behavior. A
    manually-quoted phrase like `search="exact phrase"` still finds the
    same content under the new literal default (the embedded quote
    characters get escaped as content, and FTS5's tokenizer strips
    punctuation from BOTH the query and the indexed content the same way,
    so the match usually survives) — but is no longer being honored as
    phrase SYNTAX, which matters if you were relying on the phrase
    boundary specifically (e.g. `word1 word2*` prefix matching only inside
    the phrase).
  - **`sort` under search.** Default stays FTS5 relevance ranking
    (unchanged). An EXPLICIT `sort=asc` or `sort=desc` switches ordering to
    `created_at` instead — previously `sort` was silently ignored under
    `search=` (the REST doc used to claim "FTS owns its own ordering";
    that's now honored, not assumed).
  - **`empty_search` warning.** A query that's blank, whitespace-only, or
    (in literal mode) nothing but quote/whitespace/control characters
    short-circuits to `[]` with an `empty_search` warning instead of
    risking an FTS5 syntax error on a degenerate escaped phrase. See the
    warnings channel above.

- **Recall + ranking legibility** (vault#551 WS2B/C, schema v25 — Wave 7 of
  the Reliability & Usability Program; the title/path-indexing fix and the
  `did_you_mean` finding below both came out of the program's interim
  ground-truth-verified harness round, not the original 32-probe scorecard)
  - **Title (`path`) is now indexed, alongside `content`.** Before v25,
    `search=` only matched a note's BODY — a note's title/path was
    completely unsearchable, which was both a plain recall gap (users
    naturally expect a title match to be findable) and made "bias ranking
    toward title" impossible (there was nothing to bias). `search=` now
    matches a term appearing in EITHER the path or the content.
  - **Title matches rank far above body-only mentions.** The two indexed
    columns carry different bm25 weights (10:1, path:content) — a
    dedicated note whose title contains the search term outranks another
    note that merely references it once in passing body text. This is the
    fix for a repeatedly-observed harness finding: a clearly-on-topic
    dedicated note buried at position #3–4 behind incidental mentions.
  - **`score` field.** Every search result (`Note` or `NoteIndex` — carried
    onto the lean shape too, since search's default response IS
    `NoteIndex[]`) now carries a `score: number`. Higher is more relevant;
    the number is only meaningful as a RELATIVE comparison within one
    result set (different queries have no shared scale). Absent on every
    non-search response.
  - **Porter stemming.** The FTS5 tokenizer is now `porter unicode61`
    (previously bare `unicode61`) — regular English affixes match across
    forms: `search=firefighter` finds "firefighters", `search=microbe`
    finds "microbes". This does NOT cover irregular plurals with a
    consonant change (`wolf`/`wolves`, `knife`/`knives` — Porter is a
    suffix-stripping algorithm, not a dictionary) or synonyms
    (microbes/bacteria) — both out of scope for this wave; a genuinely
    irregular or synonymous term needs to be searched for directly.
  - **`search_did_you_mean` warning.** A search that returns ZERO results
    computes a cheap spelling suggestion (edit-distance against the FTS5
    index's own vocabulary, plus the vault's tag names) and, when one
    clears the similarity bar, returns a `search_did_you_mean` warning
    (`{code, message, query, did_you_mean}`) alongside the honest `[]` —
    e.g. `search=Vasqez` → `did_you_mean: "vasquez"`. Mirrors the tag
    `did_you_mean` above. Only computed on the already-rare zero-result
    path (never on the hot "found something" path), and only for UNSCOPED
    sessions — the suggestion is computed against the whole vault's
    vocabulary regardless of any tag-scoped token's allowlist, so
    surfacing it to a scoped caller would leak an out-of-scope note's
    content across the scope boundary (same "no leak" stance as
    `unknown_tag`/`did_you_mean` above). A suggestion occasionally reads as
    a STEMMED form (`propoli` rather than `propolis`) rather than the
    original dictionary word — the FTS5 vocabulary is the post-stemming
    index, not a separate dictionary; an accepted tradeoff rather than
    maintaining a second unstemmed index just for spelling suggestions.
  - **Known tokenizer limitations (documented, not fixed — not worth
    fighting FTS5's tokenizer for):**
    - A fused decimal+unit token like `3.14mm` is ONE token to the
      tokenizer — `search=3.14` will NOT find content containing
      `3.14mm`. Search for the fused form itself, or a word boundary
      around it, instead.
    - Emoji and other non-alphanumeric symbol characters are dropped by
      the tokenizer entirely — they're not indexed and can't be searched
      for.
  - **Advanced-mode column-filter errors are wrapped.** `search_mode:
    "advanced"` raw FTS5 syntax can misparse a leading bare `-token` (NOT
    is a BINARY operator in FTS5 — `x -y`, not `-y` alone) as
    column-filter syntax (`column:term`), producing a raw
    `no such column: <token>` error that reads as if a column named after
    your search term was expected. The `invalid_search_syntax` `hint` now
    detects this pattern and explains the actual two likely causes (a
    leading `-` with no left-hand term, or a literal `column:` filter
    naming something other than `path`/`content`) instead of surfacing the
    bare FTS5 internals.
  - **Startup migration (schema v25).** Existing vaults get a one-time,
    idempotent startup pass (`migrateToV25`) that rebuilds `notes_fts` from
    its pre-v25 single-column (`content` only) shape into the two-column
    `path`+`content` shape with porter stemming, then repopulates it from
    every existing note. A fresh vault (created at v25+) gets the new shape
    directly from schema creation and never runs the rebuild. No note data
    is touched — this only rebuilds a derived search index, not `notes`
    itself.

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
  - `limit=N` — default 50. Must be a non-negative integer; `limit=-1` or a
    non-numeric value is a `400 invalid_query` (vault#550) — a negative
    limit used to silently mean "unlimited" (SQLite semantics leaking
    through).
  - `offset=N` — default 0. Same non-negative-integer validation.

- **Wikilink expansion**
  - `expand=true&depth=2` — recursively inline `[[wikilink]]` targets into
    the returned content. `include_content=true` is required to see the
    effect.

Error shapes notable to callers:

- `400 INVALID_QUERY` — non-indexed `order_by`, unknown operator, cursor +
  incompatible param, a malformed `metadata=` JSON alias (parse failure, or a
  non-object value), or supplying both the `metadata=` alias and bracket
  `meta[...]` forms, etc.
- `400 invalid_query` (vault#550) — negative/non-numeric `limit` or `offset`,
  an unparseable date value in a bracket date filter, or (vault#551) an
  unrecognized `search_mode` value. Carries `{error_type, field, got, hint}`
  — see the [warnings channel](#honest-queries--warnings-channel--structured-invalids-vault550)
  section.
- `400 invalid_search_syntax` (vault#551) — `search_mode=advanced` raw FTS5
  syntax that FTS5 itself rejected. Same `{error_type, field, got, hint}`
  shape, distinct `error_type` from `invalid_query` above.
- `400 cursor_invalid` / `400 cursor_query_mismatch` — see cursor section.
- `409 ambiguous_path` — `id=<path>` resolved to more than one note. Body
  carries `path` + `candidates: NoteIndex[]`. Re-issue with the exact id of
  the intended candidate.

Response may also carry a `warnings` field / `X-Parachute-Warnings` header —
see [Honest queries](#honest-queries--warnings-channel--structured-invalids-vault550) above.

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

**Structured `links` resolution (vault#555).** A `links` entry's `target`
resolves with the SAME semantics as a `[[wikilink]]` — ID match first, then
exact path, then basename/title (e.g. `target: "Alice"` resolves a note
filed at `People/Alice`) — NOT path-only as before. The `relationship` you
pass is preserved verbatim (wikilinks always use `"wikilink"`; a structured
link carries whatever you named). Two forward-ref cases are handled without
dropping the edge:

- **Same batch.** A `links` entry pointing at a note created LATER in the
  same `notes` array (POST) resolves once every note in the batch exists —
  order doesn't matter.
- **Later call.** A target that doesn't exist yet anywhere is queued (same
  `unresolved_wikilinks` machinery `[[wikilinks]]` already use) and
  backfills automatically the moment a matching note is created, in this
  vault, by any client. The response carries an `unresolved_link` warning
  (see the [warnings channel](#honest-queries--warnings-channel--structured-invalids-vault550)
  above) naming the `target` and `relationship` so the caller knows the edge
  isn't live yet — it's never silently dropped.
- **Genuinely unresolvable** (typo, or a target that will never exist)
  looks identical to the "later call" case on the wire — the write still
  queues it. Use `GET /vault/{name}/api/unresolved-wikilinks` to audit what's
  pending across the vault (rows now carry a `relationship` field alongside
  `source_id`/`target_path`).

#### `GET /vault/{name}/api/notes/{idOrPath}` — `vault:read`
Returns the full `Note` (defaults to `include_content=true` for point
reads). `?include_content=false` returns a `NoteIndex`. Carries
`validation_status` when any tag on the note declares `fields` (vault#555 —
previously this signal was visible ONLY on the one-time create/update write
response; every subsequent read showed nothing even for an advisory
violation like an out-of-enum value on a non-strict field). Same shape and
attachment rule as the structured-query list below.

> **Percent-encode slashes in `{idOrPath}`.** This route (and the `PATCH` /
> `DELETE` siblings below) resolves a note by id-or-path; a literal `/` in a
> path must be percent-encoded as `%2F` (e.g.
> `GET .../api/notes/Projects%2FFoo`) so it isn't parsed as a route separator.
> The same applies to path-valued query params like `?path=Projects%2FFoo`.

Folding options:

- `include_links=true` — append outbound links as a `links` field.
- `include_attachments=true` — append attachments as an `attachments` field.
- `include_metadata=...` — same allowlist as the list endpoint.
- `expand=true&depth=N` — inline `[[wikilink]]` targets.
- `content_offset=N&content_length=M` — bounded read of a large note's
  content in byte windows; the response gains `content_offset` /
  `content_total_length` / `content_next_offset`. See "Content range —
  bounded reads for large notes" above.

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
  "force": true,                                     // bypass the *requirement* for if_updated_at
  "if_missing": "create",                            // vault#309 — upsert
  "include_content": false                           // optional lean response
}
```

**Optimistic concurrency.** Updates require `if_updated_at` (the
`updatedAt` you last read for this note) unless `force: true`. Missing both
returns `428 Precondition Required`. Pure append/prepend updates (no
content/metadata/path/tags/links) are exempt — concatenation is
no-conflict-by-design.

If you supply both `if_updated_at` and `force: true`, the precondition
still applies — `if_updated_at` wins and a mismatch returns `409 conflict`.
`force` only waives the requirement to supply `if_updated_at`; it does not
override one you actually passed. To update unconditionally, omit
`if_updated_at` and send `force: true` alone.

**`updated_at` bumps on every real mutation (vault#555).** A `tags`-only or
`links`-only update bumps `updated_at` exactly like a `content`/`path`/
`metadata` change does — this held true when the request carried
`if_updated_at` even before this fix, but a `force: true` tags/links-only
update used to skip the underlying `UPDATE notes` entirely and leave
`updated_at` frozen, making the mutation invisible to cursor pagination
(which orders by `updated_at`) and any `updated_at`-based sync filter. Tag
rename/merge cascades that rewrite note `content` (`#oldtag` → `#newtag`
references) bump the rewritten notes' `updated_at` too, for the same reason.

**Batch `force`/`if_updated_at` defaults (MCP `update-note` only, vault#554).**
REST `PATCH` is single-note; the MCP `update-note` tool additionally accepts
a top-level `notes` array for batch updates. A top-level `force` and/or
`if_updated_at` alongside `notes` applies as the DEFAULT for every item that
doesn't set its own — e.g. `{force: true, notes: [{id: "a", content: "..."},
{id: "b", content: "...", if_updated_at: "..."}]}` forces item "a" but item
"b"'s own `if_updated_at` still applies (and wins). Before this fix the
top-level fields were silently ignored in a batch call — every item without
its OWN `force`/`if_updated_at` threw `428 precondition_required` regardless
of a top-level `force: true`.

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

Error shapes (`error_type` — see the "Error taxonomy" section above for the full field contract):

- `409 conflict` — `if_updated_at` mismatched. Body carries
  `current_updated_at`, `your_updated_at`, `path`, `note_id`, `hint`.
- `409 path_conflict` — UNIQUE(path) tripped on a rename.
- `409 ambiguous_path` — `{idOrPath}` matched multiple notes.
- `409 content_edit_ambiguous` — `content_edit.old_text` matched twice.
- `422 content_edit_not_found` — `content_edit.old_text` not found.
- `400 mutually_exclusive` — caller passed more than one content mode.
- `400 invalid_content_edit` — `content_edit` isn't `{old_text, new_text}`.
- `400 invalid_state_transition` — `state_transition.field` isn't a non-empty string.
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
body with the transcript (or, on a retry, the `_Transcription
unavailable._` failure marker). If neither marker is present — the user
edited the note while transcription was pending — the worker **appends**
the transcript rather than overwriting the body, so the user's edits and
the `![[<audio>]]` embed are never destroyed. A user edit clearing
`transcribe_stub` before the transcript arrives opts out of the overwrite
entirely. On terminal failure the worker writes `_Transcription
unavailable._` the same way (surgical replace of the placeholder, or
append if it's gone — never a full-body replace); a failed legacy memo can
be retried via `/retry-transcription` (legacy in-body form) below.

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
Re-enqueues the original audio attachment for a failed transcription. Two
target shapes are accepted, distinguished by whether the target note carries
`transcript_status` frontmatter. Returns 202 on success:

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

**Auto-flow form (Path B, vault#353).** The target is a
`<audio>.transcript.md` note with `transcript_status: failed` frontmatter.
The audio is located via `transcript_attachment_id`; `transcribe_origin:
"auto"` is preserved so a retried success overwrites the transcript note in
place (note id preserved across retries). Shipped in 0.4.8-rc.1 (design Q5).

Auto-flow error branches:

- `400 not_failed` — transcript already succeeded; nothing to retry.
- `400 missing_attachment_id` — transcript note lacks
  `transcript_attachment_id` (likely written by an older vault version).
- `404 attachment_missing` — original audio attachment row has been
  deleted.
- `404 audio_missing` — original audio file no longer exists on disk
  (e.g. `audio_retention: never` already unlinked it).

**Legacy in-body form (Path A).** The target is the voice-memo note itself
— no `transcript_status` frontmatter. The note directly owns the audio
attachment whose transcription failed; on failure the worker had replaced
the `_Transcript pending._` placeholder with a `_Transcription unavailable._`
marker (leaving the `![[<audio>]]` embed intact). This form finds the note's
own attachment with `transcribe_status: failed`, resets it to `pending`
**preserving `transcribe_origin: "legacy"`** (forcing `"auto"` would switch
to the sibling-transcript-note shape and orphan the in-body embed), and
**re-stamps `transcribe_stub: true`** on the note. The stub re-arm is
required: the worker's legacy success path only writes the transcript back
into the body when the note carries `transcribe_stub`, and that flag was
cleared when the failure marker was written. On a successful retry the
transcript replaces the `_Transcription unavailable._` marker in place,
yielding the same body a first-try success would have produced.

Legacy-form error branch:

- `400 no_failed_attachment` — the target note has no `transcript_status`
  frontmatter and owns no audio attachment with a failed transcription, so
  there's nothing to retry.
- `404 audio_missing` — the failed attachment's audio file no longer exists
  on disk.

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
{
  "path": ["note-a", "note-b", "note-c"],
  "relationships": ["mentions", "related-to"],
  "nodes": [
    { "id": "note-a", "path": "People/Alice" },
    { "id": "note-b", "path": null },
    { "id": "note-c", "path": "Projects/X" }
  ],
  "edges": [
    { "source": "note-a", "target": "note-b", "relationship": "mentions", "sourcePath": "People/Alice", "targetPath": null },
    { "source": "note-b", "target": "note-c", "relationship": "related-to", "sourcePath": null, "targetPath": "Projects/X" }
  ]
}
```

`path` (note IDs, source → target) and `relationships` (`relationships[i]`
connects `path[i]` to `path[i+1]`) are the original shape. `nodes` and
`edges` (vault#550, additive) hydrate each id with the note's own `path`
field — `nodes` mirrors `path[]` one-for-one; `edges` is a self-contained
hop list for rendering the chain without cross-referencing `nodes`. The
MCP `find-path` tool returns the identical shape.

Tag-scoped tokens see `null` when any intermediate hop is outside the
allowlist — a reachable target via an out-of-scope hop is not a permitted
answer.

### Tags

#### `GET /vault/{name}/api/tags` — `vault:read`
List all tags. Returns `[{name, count, expanded_count}]` by default;
`?include_schema=true` folds each tag's identity row (description, fields,
relationships, parent_names, created_at, updated_at) into the response.
`count` is notes carrying the EXACT tag; `expanded_count` (vault#550) is
distinct notes matching the tag OR any transitive descendant under the
default (subtypes) expansion — the number that makes a parent tag whose
notes are all tagged with a more specific child read as non-empty instead
of reporting `count: 0`.

#### `GET /vault/{name}/api/tags?tag=<name>` — `vault:read`
Single-tag detail (full identity record).

```json
{
  "name": "project",
  "count": 12,
  "expanded_count": 19,
  "description": "...",
  "fields": { ... },
  "relationships": { ... },
  "parent_names": [...],
  "created_at": "...",
  "updated_at": "..."
}
```

**404 `tag_not_found` (vault#550).** When the name has no identity row AND
no note carries it (directly or via expansion) — a typo, or a tag from a
different vault — this now 404s instead of synthesizing an all-null 200:

```json
{ "error": "Tag not found", "error_type": "tag_not_found", "tag": "projcet", "did_you_mean": "project" }
```

`did_you_mean` is present only when a close match exists (case variant,
prefix relationship, or small edit distance). A tag with an identity row
but zero notes is still a legitimate 200 (declaring a tag via `update-tag`
before using it is fine) — the 404 only fires when NEITHER an identity row
NOR any membership exists. The MCP `list-tags` tool returns the same
`{error, error_type: "tag_not_found", tag, did_you_mean?}` shape (as a
returned object, not a thrown error) for a nonexistent `tag` param.

Tag-scoped tokens: an out-of-scope name (whether the tag exists or not)
gets the bare `tag_not_found` with **no** `did_you_mean` and no record
fields — same "no leak" stance as note reads; and for an in-scope miss,
`did_you_mean` only surfaces suggestions inside the token's allowlist.
Enforced on both REST (handler early-return + scoped candidate pool) and
MCP (the `list-tags` scope wrapper — also closes the pre-#550 full-record
leak for existing out-of-scope tags, vault#560).

#### `GET /vault/{name}/api/tags/{name}` — `vault:read`
Same as the `?tag=` query — single-tag detail by path, same 404 shape.

#### `PUT /vault/{name}/api/tags/{name}` — `vault:write`
Upsert a tag's identity row. Body accepts any combination of:

```json
{
  "description": "string | null",
  "fields": { "<field>": { "type": "string", "enum": [...], ... } } | null,
  "relationships": {                                 // opaque map (relName → arbitrary JSON); never a top-level array; | null clears
    "<relName>": <any JSON-serializable value>
  },
  "parent_names": ["parent-tag", ...] | null
}
```

Omitted keys are preserved; explicit `null` clears. `fields` merges into
the existing schema (mirrors MCP `update-tag`).

**Typed indexes — indexed⇒strict, explicit defaults, honest types (vault#553,
0.7.0).** Two BREAKING changes to `fields.<field>`:

- **`indexed: true` ⇒ the field's TYPE is always enforced.** A write whose
  value's type contradicts the declared indexed type (e.g. a string into an
  indexed `integer` field) is now **rejected** with `422 schema_validation`
  — independent of that field's own `strict` flag. Before 0.7.0 this was
  only an advisory `validation_status` warning, and the accepted bad value
  would poison range queries (`gt`/`gte`/`lt`/`lte`) on that field via
  SQLite's TEXT-sorts-above-INTEGER affinity ordering (the root cause
  #553 tracks). Every OTHER constraint on an indexed field (enum/required/
  cardinality) is still governed by `strict` as before — **`indexed: true`
  guarantees TYPE, not enum-domain** (vault#555). An indexed field with an
  `enum` declared but `strict` unset still accepts an out-of-enum value: it's
  stored, fully queryable (`eq`/`in`/range operators all work normally — the
  index doesn't care about enum membership), and surfaces an advisory
  `enum_mismatch` warning in `validation_status.warnings`. Mark the field
  `strict: true` too if you want an out-of-enum value hard-rejected instead.
- **`default` is now the ONLY way to backfill a field.** `fields.<field>.default`
  (new, optional, typed per the field's own `type`/`enum` — a non-conforming
  value is rejected with `invalid_field_default`/`tag_field_conflict`
  `invalid_default`) is written onto a note that gains this tag without
  setting the field. A field with NO `default` stays genuinely absent — this
  is what makes `metadata: { <field>: { exists: false } }` trustworthy.
  Before 0.7.0, an unset field silently backfilled to the first `enum` value
  or a type zero-value (`0`/`false`/`""`), making "never set" indistinguishable
  from "explicitly set to the default." **Blast radius:** this only changes
  FUTURE writes — notes already backfilled under the old behavior keep their
  values; no migration touches them.
- **Honest type list.** `type` accepts all six of `string`/`boolean`/`integer`/
  `number`/`array`/`object` for storage and advisory validation, but only
  `string`/`integer`/`boolean` are INDEXABLE — declaring `indexed: true`
  with `number`/`array`/`object` is rejected (`unsupported_indexed_type` /
  `invalid_indexed_field`, unchanged behavior from before 0.7.0 — only the
  DOCUMENTED type list was dishonest, not the enforcement).

**Startup migration (schema v24).** Existing vaults get a one-time,
idempotent startup pass (`migrateToV24`) that reuses `doctor`'s
`mixed_type_indexed_field` detector: a poisoned value that can be coerced
losslessly (a clean numeric string into an integer-indexed field, a
`"true"`/`"false"` string into a boolean-indexed field, a number into a
string-indexed field) is rewritten in place; anything else (e.g. `"hello"`
in an integer field) is LEFT UNTOUCHED — the migration never deletes or
nulls note data — and continues to surface via `GET /api/doctor`'s
`mixed_type_indexed_field` finding for deliberate operator cleanup.

**`relationships` shape.** An **opaque vocabulary map** (vault#431): a JSON
object whose keys are relationship names and whose values are arbitrary
JSON the declaring app interprets. Vault does **not** enforce any inner
structure — it stores and returns the values verbatim. Any
JSON-serializable value is accepted, e.g. the Weaver-style structural-link
shape:

```json
{
  "relationships": {
    "works-on": { "from": "person", "to": "project" }
  }
}
```

The older typed `{ target_tag, cardinality }` shape is a **recommended
convention** that's still accepted (it's just a valid opaque value), so
existing typed declarations keep working:

```json
{
  "relationships": {
    "works-on": {
      "target_tag": "project",
      "cardinality": "many",
      "description": "projects this person contributes to"
    }
  }
}
```

Only the top-level shape is validated. A payload is **rejected with `400`
and `error_type: invalid_relationships`** (the `error` field carries the
specific violation) when it is a top-level array, a top-level primitive,
has an empty-string key, or is not JSON-serializable. Explicit `null`
**clears** the field (it is not rejected). Inner values — including ones
missing `target_tag` or `cardinality`, or with a `cardinality` outside the
old vocabulary — are **no longer** rejected; they persist verbatim.

**`fields` cross-tag validation (vault#553/#554).** `type` and `indexed`
must agree across every tag that declares the same field. Declaring one or
more fields that conflict with another tag's declaration in the SAME call
is **rejected with `422` and `error_type: "tag_field_conflict"`**, carrying
EVERY conflicting field in one response — not just the first — plus a
`violations: [{field, reason, message, other_tag?}]` array (`reason` is
`type_conflict` or `indexed_flag_conflict`; `other_tag` names the
conflicting declarer) and a `message` stating explicitly that no changes
were applied. Nothing is persisted before this check runs, so the tag's
existing fields are always left exactly as they were on rejection.

Two case families stay on the pre-existing `400 invalid_indexed_field`
path instead (unchanged wire contract): the SOLO, single-tag errors (an
unsupported type for indexing, or an invalid field identifier —
vault#478), and a cross-tag TYPE conflict where the incoming field is
itself `indexed: true` (that combination already returned 400 before
vault#554 via the indexed-field engine's cross-declarer check, and keeps
doing so — only the previously-silent cases, non-indexed type conflicts
and indexed-flag conflicts, are the new 422). The MCP `update-tag` tool
reports the same split via structured JSON-RPC errors.

**Tag-scope generalization (both error shapes).** For a tag-scoped
session, the write is still rejected when the conflict is with an
out-of-scope tag — schema integrity is scope-independent — but the
response must not leak that tag: a `tag_field_conflict` violation whose
conflicting declarer is outside the token's allowlist is generalized (no
tag name, no declared type/flag, `other_tag` omitted), and the
`invalid_indexed_field` cross-declarer message is likewise generalized
when any declarer is out of scope. In-scope declarers keep full detail;
unscoped callers always see full detail.

**`parent_names` cycle guard (vault#552).** A `parent_names` write that
would create a cycle (a direct A↔B, a longer transitive chain, or a bare
self-parent) is **rejected with `409` and `error_type: "parent_cycle"`**,
carrying `{ tag, cycle: [...] }` (the offending path). Traversal elsewhere
(`getTagDescendants`) was already cycle-safe — a visited-set stops it
looping forever — but the write itself was previously dishonest about
creating one; this closes that gap. Nothing is persisted on rejection. The
MCP `update-tag` tool reports the same shape via a structured JSON-RPC
error. See the error taxonomy table above for the full field contract,
including the tag-scope generalization.

#### `DELETE /vault/{name}/api/tags/{name}` — `vault:write`
Removes the tag, its identity row, and untags every note. Returns the
delete result — `{ deleted: true, notes_untagged: number, parent_refs_detached?: number }`.
Refused with `409 tag_in_use_by_tokens` if any tag-scoped token references
this tag — revoke or re-mint the tokens first.

**Referential integrity (vault#552).** Also refused — with `409` and
`error_type: "tag_referenced_as_parent"`, carrying `{ tag, referencing_tags: [...] }`
— when another tag's `parent_names` still names this one; deleting would
silently orphan that reference (the exact class of bug a manual
retag→delete dance produces — see `rename-tag` below). Pass
`?cascade=true` or `?detach=true` (query params — **synonyms**: either one
strips the stale reference from every referencing tag's `parent_names` in
the same transaction as the delete; neither deletes the referencing tags
themselves) to proceed anyway. Default (neither flag) is refuse. See the
error taxonomy table above for the tag-scope generalization on
`referencing_tags`.

#### `POST /vault/{name}/api/tags/{name}/rename` — `vault:write`
Body: `{ "new_name": string }`. Atomically renames the tag across EVERY
surface that references it in a single transaction: the `tags` row,
`note_tags`, OTHER tags' `parent_names`, tag-scoped tokens' allowlists,
indexed-field declarer lists, inline `#tag` mentions in note bodies, and
`_tags/<name>` config-note paths. Sub-tags rename recursively (`task` →
`todo` also renames `task/work` → `todo/work`).

Returns the full cascade report: `{ renamed, sub_tags_renamed, parent_refs_updated, tokens_updated, indexed_field_declarers_updated, notes_rewritten, paths_renamed }`
(`renamed` is the `note_tags` rows rewritten, cumulative across the root +
every sub-tag).

Errors:

- `404 not_found` — source tag does not exist.
- `409 target_exists` — `new_name` (or one of its sub-tags) is already a
  tag. Caller should `POST /tags/merge` instead if combining the two tags
  is the intent.

**Does NOT rewrite metadata.** A metadata value that happens to equal the
old tag name (e.g. `metadata.epic: "task"`) is left untouched — rename's
cascade is structural (tags/note_tags/parent_names/tokens/content), not a
blind string search-and-replace over arbitrary metadata values. The
`doctor` scan's `dead_tag_metadata_reference` finding flags this drift
class heuristically after the fact.

**MCP parity (vault#552).** Exposed as the `rename-tag` MCP tool —
`{ old_name (aliases: from, tag), new_name (alias: to) }` — delegating to
the SAME `store.renameTag` this endpoint calls; same cascade, same error
shapes (`tag_not_found` / `target_exists` as structured JSON-RPC errors).
Tag-scoped callers: both `old_name` and `new_name` must be in the caller's
allowlist.

#### `POST /vault/{name}/api/tags/merge` — `vault:write`
Body: `{ "sources": string[], "target": string }`. Retags every note
carrying any of the `sources` tags with `target`, then drops the source
tags (and their identity rows — description/fields/relationships/parent_names)
in a single transaction. `target`'s own schema is preserved (sources'
schemas are consumed, not merged field-by-field).

`target` is created if it doesn't exist yet. Sources that don't exist are
recorded with count `0`. Duplicate sources are deduped; `target` appearing
in `sources` is a no-op for that entry.

Returns `{ "merged": { [source]: count }, "target": string }`.

Refused with `409 tag_in_use_by_tokens` if any source tag is referenced by
a tag-scoped token.

**MCP parity (vault#552).** Exposed as the `merge-tags` MCP tool —
`{ sources: string[], target: string }` — delegating to the SAME
`store.mergeTags` this endpoint calls, including the same token-reference
guard. Tag-scoped callers: every source AND the target must be in the
caller's allowlist.

#### `GET /vault/{name}/api/doctor` — `vault:admin`
Read-only integrity scan across the tag/metadata taxonomy (vault#552) —
run after any bulk tag reorg (rename/merge/delete/subtree move) to confirm
nothing leaked. Admin-tier regardless of method (this is a whole-vault
diagnostic, same tier as the MCP `doctor` tool and `prune-schema`), gated
BEFORE the generic read/write scope check — same dispatch shape as
`/api/triggers`.

Never mutates. Returns `{ findings: [...], summary: string, scanned_at: string }`,
where each finding is `{ type, severity, subject, detail, remedy, heuristic? }`:

- `dangling_parent_name` (`warning`) — a `parent_names` entry naming a tag
  with no identity row.
- `parent_names_cycle` (`error`) — a tag reaching itself through its
  declared ancestor chain (surfaces pre-existing/pre-guard cyclic data;
  see the `parent_cycle` write-time guard above).
- `mixed_type_indexed_field` (`error`) — a note's `metadata.<field>` value
  has a JSON type disagreeing with the field's declared indexed sqlite
  type. Reuses the SAME detector the `migrateToV24` startup migration runs
  on every boot (schema v24, vault#553 Decision D) — post-0.7.0 this finding
  surfaces only the genuinely NON-coercible leftovers (a migration already
  auto-coerced everything it could losslessly convert on upgrade); a note
  listed here needs deliberate operator cleanup (backfill the value, or
  relax the field's declared type via `update-tag`).
- `orphaned_indexed_field_declarer` (`warning`/`info`) — an indexed field
  naming a dead declarer tag; overlaps `prune-schema`, which is the
  suggested remedy.
- `dead_tag_metadata_reference` (`info`, always carries `heuristic: true`)
  — a metadata value that looks like a stale reference to a
  renamed/merged/deleted tag, inferred from sibling notes using the same
  metadata key with values that ARE live tags. Never certain — vault keeps
  no tag-rename history.

**Tag-scope.** A tag-scoped admin token's scan covers only in-scope
tags/fields/notes — the report is re-run with the caller's expanded
allowlist rather than filtered after the fact, so aggregate `summary`
counts never reflect out-of-scope activity.

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

### Token management — minting lives on the hub

The per-vault `/vault/{name}/tokens` REST surface (the old `GET` list,
`POST` mint, `DELETE` revoke of `pvt_*` tokens) was **removed at 0.5.0**
(vault#282 Stage 2 — vault is a pure hub resource-server). A request to
`/vault/{name}/tokens` now falls through to the catch-all `404`.

Mint and revoke vault access tokens on the hub instead:

- `parachute auth mint-token --scope vault:<name>:<verb>` — mint a scoped
  hub JWT for scripts.
- `parachute-vault mcp-install --mint` — mint + wire a JWT into an MCP
  client config in one step.
- The admin SPA's **Tokens** page — mint / list / revoke from the browser.

Hub JWTs are audience-bound (`aud=vault.<name>`) and scope-narrowed; vault
validates each one against the hub's JWKS per-request and stores nothing.
See [`docs/auth-model.md`](./auth-model.md) for the full validation
contract.

### Maintenance

#### `GET /vault/{name}/api/unresolved-wikilinks` — `vault:read`
List `[[wikilink]]`s AND pending structured `links` forward-refs (vault#555)
that don't currently resolve to any note. `?limit=N` (default 50). Each row
carries `source_id`, `source_path`, `target_path`, and `relationship`
(`"wikilink"` for content-parsed `[[targets]]`; the caller's own
relationship string for a structured-link forward-ref queued by
`create-note`/`update-note`/`POST /notes`/`PATCH /notes/{id}`).

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

Returns `{path, size, mimeType}` with status `201` on success. A file
larger than the 100MB limit is rejected with `413`.

#### `GET /vault/{name}/api/storage/{date}/{filename}` — `vault:read`
Serves the uploaded file bytes with the matching `Content-Type`. Path is
sandboxed under the vault's assets dir; traversal attempts return `403`.
The `{date}/{filename}` slash may be sent either literally or
`%2F`-encoded — both forms resolve to the same file. (Note the contrast
with the single-note routes, which **require** `%2F` for a slash inside an
id/path segment.)

With a **tag-scoped** token, the serve is additionally gated by the owning
note's tag scope: the requested storage path is reverse-looked-up to its
owning attachment row(s) → note(s), and the bytes are served only if at
least one owning note is in scope. The serve returns `404` in **both**
failure cases — when no attachment row owns the path (owner-less) and when
an owning note exists but falls outside the token's scope. The same `404`
either way keeps the endpoint from acting as an existence oracle. Unscoped
tokens keep the path-only behavior.

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
  (OAuth, hub JWT, `pvk_*` / vault.yaml back-compat), discovery, session
  cookies, rate limiting.
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
