# Parachute Vault HTTP API

A flat reference for the Parachute Vault HTTP surface. Intended for humans *and*
agents building tools that read or write a vault over HTTP.

All endpoints serve JSON. The same vault is reachable at two roots:

- `/api/...` — the server's default vault
- `/vaults/{name}/api/...` — any named vault on this server

Use whichever is convenient. Examples below use the default `/api` root.

## Quick start — render a graph in 5 lines

```js
const res = await fetch("http://localhost:1940/api/graph", {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const { notes, links, tags, meta } = await res.json();
// notes: lightweight NoteIndex[] — id, path, tags, createdAt, byteSize, preview
// links: Link[]                 — sourceId, targetId, relationship, metadata
// Hand this to d3-force, cytoscape, sigma.js, etc.
```

That's the whole happy path. Everything else in this doc is detail.

## Conventions

- **Response payloads are camelCase**: `createdAt`, `sourceId`, `mimeType`,
  `totalNotes`.
- **Request payloads are camelCase**: you `POST {sourceId, targetId, ...}` and
  get the same shape back.
- **Query params are snake_case**: `?include_content=true`, `?tag_match=any`,
  `?date_from=2025-01-01`. This matches the MCP tool-arg convention, so one
  concept ports cleanly between HTTP and MCP.
- **Timestamps are ISO-8601** UTC strings (e.g. `2026-04-07T15:30:00.000Z`).
- **No envelope**. Responses are the data itself (`{...}` or `[...]`), not
  wrapped in `{data: ...}`. Error responses are `{error: "...", message?: "..."}`.

## Authentication

Pass your API key as either:

```
Authorization: Bearer <key>
X-API-Key: <key>
```

Every request is authenticated — localhost and remote traffic go through the
same path, there is no bypass. Local dev feels friction-free because you can
hand the CLI-generated API key to your script without exposing it to the
network, not because the auth check is skipped.

Keys have a **scope**:

- `write` — full access
- `read`  — `GET`/`HEAD`/`OPTIONS` only; writes return `403 Forbidden`

A read-only key is the right thing to hand to a visualizer or static-site
generator.

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
}
```

### `NoteIndex` (lean shape)

Returned by list endpoints by default. Same as `Note` minus `content`, plus
`byteSize` and a one-line `preview` (120 code points, whitespace collapsed).

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

- **List endpoints** (`GET /notes`, `GET /graph`) default to `NoteIndex`. The
  common case is viz/listing, which doesn't need the full body of every note.
- **Point reads** (`GET /notes/:id`) default to the full `Note`. If you asked
  for one specific thing by ID, you probably want its content.

Both shapes can be forced either way with `?include_content=true|false`.

## Endpoints

### Server-level

#### `GET /health`
Returns `{status: "ok", vaults: string[]}`. No auth required.

#### `GET /vaults`
List all vaults on the server.
```json
{
  "vaults": [
    { "name": "default", "description": "...", "created_at": "..." }
  ]
}
```

#### `GET /vaults/{name}`
Single-vault landing payload — name, description, createdAt, and stats in one
round trip. Useful for a viz site's home page.
```json
{
  "name": "default",
  "description": "My knowledge graph",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "stats": { "totalNotes": 617, "topTags": [...], "notesByMonth": [...], ... }
}
```

### Notes

#### `GET /notes`
Query notes. Returns `NoteIndex[]` by default.

Query params:
- `include_content=true` — return full `Note[]` instead.
- `ids=a,b,c` — fetch specific notes by ID. Practical limit ~50 IDs due to
  URL length; for larger batches call multiple times.
- `tag=foo&tag=bar` — filter by tags (repeat param to pass multiple).
- `tag_match=all|any` — default `all`.
- `exclude_tag=foo` — exclude notes with this tag.
- `date_from=ISO` — inclusive lower bound on `createdAt`.
- `date_to=ISO` — exclusive upper bound.
- `sort=asc|desc` — by `createdAt`. Default `asc`.
- `limit=N` — default 100.
- `offset=N` — default 0.

#### `POST /notes`
Create a note. Body:
```json
{
  "content": "...",            // required
  "id": "optional-client-id",
  "path": "Projects/Foo",
  "tags": ["a", "b"],
  "metadata": { "status": "draft" },
  "createdAt": "2026-04-07T..."
}
```
Returns the created `Note`, `201 Created`.

#### `GET /notes/{id}`
Returns the full `Note`. `?include_content=false` returns a `NoteIndex`.

#### `PATCH /notes/{id}`
Update content, path, or metadata. Body:
```json
{ "content": "new body", "path": "new/path", "metadata": {...} }
```

#### `DELETE /notes/{id}`
Returns `{deleted: true}`.

#### `POST /notes/{id}/tags`, `DELETE /notes/{id}/tags`
Body: `{"tags": ["a", "b"]}`.

#### `POST /notes/{id}/attachments`
Body: `{"path": "files/a.png", "mimeType": "image/png", "transcribe"?: boolean}`.

When `transcribe: true` and the file is audio, the server queues a
transcription job: `attachment.metadata.transcribe_status = "pending"` is
set, and `note.metadata.transcribe_stub = true` is written as the opt-in to
overwrite content when the transcript lands. A background worker (enabled
by setting `SCRIBE_URL` on the server) drains the queue FIFO, one at a
time, calling `${SCRIBE_URL}/v1/audio/transcriptions` with the audio as
multipart `file` and expecting `{ text: string }` back.

On success:
- If `note.metadata.transcribe_stub === true`, the worker replaces the
  literal `_Transcript pending._` placeholder in the note body with the
  transcript, or the whole body if the placeholder is absent. The stub
  marker is cleared. A user edit clearing `transcribe_stub` before the
  transcript arrives opts out of the overwrite.
- `attachment.metadata.transcribe_status` becomes `"done"` and
  `transcript` + `transcribe_done_at` are recorded on the attachment even
  when the note opted out, so the transcript is always addressable.

On failure, the worker retries with exponential backoff up to three
attempts before setting `transcribe_status = "failed"` and capturing
`transcribe_error`.

The queue lives in the DB (`attachments` table), so a server restart
resumes pending work without replay.

#### `GET /notes/{id}/attachments`
Returns `Attachment[]`.

#### `DELETE /notes/{id}/attachments/{attId}`
Returns `204 No Content`. The attachment record is removed and the underlying
storage file is unlinked when no other attachment still references the same
path (orphan-check). Returns `404` if the attachment doesn't exist or belongs
to a different note. Idempotent: a second delete of the same id returns `404`.

### Links

#### `GET /links`
List edges. Polymorphic — filters compose freely.

Query params:
- `note_id=abc` — only edges touching this note.
- `direction=outbound|inbound|both` — only meaningful with `note_id`.
  Default `both`.
- `relationship=cites` — only edges of this type.

Returns bare `Link[]` — no hydration. If you need the connected notes'
details, pair the result with `GET /notes?ids=...`.

Examples:
```
GET /links                              # everything
GET /links?note_id=abc                  # all edges touching note abc
GET /links?note_id=abc&direction=outbound
GET /links?relationship=cites           # vault-wide, by type
```

#### `POST /links`
Body:
```json
{ "sourceId": "a", "targetId": "b", "relationship": "cites", "metadata": {...} }
```

#### `DELETE /links`
Body:
```json
{ "sourceId": "a", "targetId": "b", "relationship": "cites" }
```

### Graph

#### `GET /graph`
One-shot knowledge graph payload for visualization.

```json
{
  "notes": [ /* NoteIndex[] by default, Note[] if include_content=true */ ],
  "links": [ /* Link[] */ ],
  "tags":  [ { "name": "...", "count": 12 } ],
  "meta": {
    "totalNotes": 617,
    "totalLinks": 1234,
    "filteredNotes": 617,
    "filteredLinks": 1234,
    "includeContent": false
  }
}
```

Query params:
- `include_content=true` — fatten each note to include full content.
- `tag=foo&tag=bar` — filter to a subgraph (only notes with these tags, and
  only links where **both** endpoints are in the subset).
- `tag_match=all|any` — default `all`.
- `exclude_tag=foo`.

`meta.totalNotes` / `meta.totalLinks` always reflect the full vault;
`filteredNotes` / `filteredLinks` reflect the response.

### Search

#### `GET /search?q=query`
Full-text search. Returns `Note[]` (full shape).

Query params:
- `q=...` — required.
- `tag=foo` — optional tag filter (repeatable).
- `limit=N` — default 50.

### Tags

#### `GET /tags`
Returns `[{name, count}]`.

#### `POST /tags/{name}/rename`
Body: `{ "new_name": string }`. Atomically renames the tag across `tags`,
`note_tags`, and `tag_schemas` in a single transaction.

Returns `{ "renamed": number }` on success — the number of note-tag rows
rewritten.

Errors:
- `404 { "error": "not_found" }` — source tag does not exist.
- `409 { "error": "target_exists", "target": string, "message": "..." }` —
  `new_name` is already a tag. The client should call `POST /tags/merge`
  instead if combining the two tags is the intent.

#### `POST /tags/merge`
Body: `{ "sources": string[], "target": string }`. Retags every note carrying
any of the `sources` tags with `target`, then drops the source tags (and
their schemas) in a single transaction. `target`'s own schema is preserved.

`target` is created if it doesn't exist yet. Sources that don't exist are
recorded with count `0`. Duplicate sources are deduped; `target` appearing
in `sources` is a no-op for that entry.

Returns `{ "merged": { [source]: count }, "target": string }`.

### Vault stats

You usually want `GET /vaults/{name}` which bundles stats with vault metadata.
If you only need the stats, call `GET /vaults/{name}` and read `.stats`.

### Vault config

#### `GET /api/vault`
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

#### `PATCH /api/vault`
Update the description and/or nested `config` fields. Only the fields you
pass are changed; omitted fields are left alone.

```json
{
  "description": "new description",
  "config": { "audio_retention": "until_transcribed" }
}
```

Response echoes the full vault payload (same shape as `GET /api/vault`).

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
Any other value returns `400 { "error": "invalid_audio_retention" }`.
Vaults created before this setting existed read back as `"keep"`.

### Storage

#### `POST /storage/upload`
Multipart form:
- `file` — required, audio/image, ≤100MB

Returns `{path, size, mimeType}`.

#### `GET /storage/{date}/{filename}`
Serves the uploaded file.

## CORS

The server sends permissive CORS headers (`Access-Control-Allow-Origin: *`)
so a static site on any origin can fetch the API. Writes still require a
valid API key.

## Pairing with MCP

Every read endpoint here has a matching MCP tool over `/mcp`
(unified) or `/vaults/{name}/mcp` (scoped):

| HTTP                      | MCP tool            |
|---------------------------|---------------------|
| `GET /notes`              | `read-notes`        |
| `GET /notes?ids=...`      | `get-note` (ids)    |
| `GET /notes/{id}`         | `get-note`          |
| `GET /links`              | `get-links`         |
| `GET /graph`              | `get-graph`         |
| `GET /vaults/{name}`      | `get-vault-stats` + `get-vault-description` |
| `GET /tags`               | `list-tags`         |
| `GET /search?q=`          | `search-notes`      |

The MCP tools use the same lean-vs-fat convention (`include_content: true|false`)
and the same snake_case arg names as the HTTP query params.
