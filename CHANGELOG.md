# Changelog

All notable changes to Parachute Vault are documented here.

This project loosely follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [0.7.5-rc.7] - 2026-07-29

**Audio that can't be transcribed now says so (#643).**

On a fresh install, voice memos silently never transcribed. The transcription
provider resolves to `scribe-http` by default, nothing sets `SCRIBE_URL`, and
`shouldAutoTranscribe` collapsed "the operator turned this off" and "nothing is
configured to do this" into the same `false`. So audio was accepted, nothing was
enqueued, no marker was written, no status was set, and the attachment came back
indistinguishable from a plain file upload. The only hint was a boot-time
`console.log` reading "worker disabled", which states a fact about the worker
and never names the consequence.

The hosted door already gets this right — it marks a terminal state ("voice not
enabled for this plan", "monthly voice limit reached") rather than skipping
quietly, so an operator never faces an eternal spinner. This is the self-hosted
twin of that posture.

- `classifyAutoTranscribe` replaces the boolean with four honest outcomes:
  `transcribe` / `not-audio` / `disabled` / `unavailable`. **`disabled` stays
  silent** — the operator asked for nothing to happen, and dressing that up as a
  failure would be its own bug. `unavailable` is the misconfiguration.
- An `unavailable` upload records `transcribe_status: "failed"` plus an
  actionable `transcribe_error` naming both routes out (a local provider via
  `transcription install`, or `SCRIBE_URL`), on both the REST and
  upload-ticket paths.
- The boot line is now a `warn` that names the consequence — "audio attachments
  will be accepted but never transcribed" — reports the resolved provider, and
  says how to silence it if transcription genuinely isn't wanted.
- The per-upload warning is throttled to once a minute, so importing a hundred
  memos yields one actionable line rather than a hundred.

`shouldAutoTranscribe` is unchanged in behaviour and remains a thin boolean view
of the classifier, pinned by a test.

> rc.2 is #633 (admin-SPA auth honesty), open in parallel. A rebase interleaves
> the two entries; they touch no common source.
## [0.7.5-rc.6] - 2026-07-29

**The admin SPA no longer tells a signed-in operator they're signed out (#642).**

Found live: a box whose scope-guard couldn't reach its revocation list rejected
every hub-issued JWT with `revocation_unavailable`. Vault's routes map that 401
straight to `SignInBanner`, so a fully-signed-in operator was told **"You're not
signed in to the hub."** Signing in again could never help — and the recovery
poll made it worse, because it tested the token MINT (which worked fine) rather
than the request that was failing: mint ok → reload → 401 → banner → mint ok →
… every five seconds, forever.

The banner now probes the mint before it commits to any copy. A mint that
succeeds *proves* the session is fine, so the failure gets named for what it is
— the server rejecting a token we can obtain on demand — the server's own
message is shown verbatim (the only written record of the cause), the useless
sign-in CTA is dropped, and the retry backs off to 30s since only the server
healing can change the outcome. A genuinely signed-out operator sees exactly
what they saw before, including the 5s recovery poll.

Pairs with `@openparachute/scope-guard` 0.5.1, which fixes the underlying
revocation-origin hairpin that produced the 401.
## [0.7.5-rc.5] - 2026-07-29

**`transcription install` now produces a setup that works — and proves it.**

Builds on rc.4's whisper.cpp provider. With no `--provider`, install now takes
the whisper.cpp path: pick a model for the box, obtain the CLIs, download the
model, **verify**, then activate.

The verification step is the point. The provider this replaces was activated by
an install verb that never checked whether what it configured could run — which
is exactly how `TRANSCRIPTION_PROVIDER=transcribe-cpp` came to point at a CLI
that has never shipped, and why local transcription silently did nothing for
everyone who "installed" it. Install now generates a real 16 kHz mono WAV, runs
the real CLI against the real model, and flips `TRANSCRIPTION_PROVIDER` **only
if that succeeds**. An install that can't transcribe is a failed install, and it
says so at install time rather than silently at the first voice memo.

- **macOS** → Homebrew (`brew install whisper-cpp`, one formula giving both
  `whisper-cli` and `parakeet-cli`). Upstream ships no macOS CLI tarball, so
  when brew is absent we refuse and explain, rather than emitting an opaque
  exit 127.
- **Linux** → the release tarball extracted into `<root>/transcription/bin`,
  binaries and their shared objects together, no distro package manager
  involved.
- **Already installed** short-circuits both — re-running never drags a package
  manager through a reinstall.
- Model downloads land on a `.part` and rename on success, so an interrupted
  install can't leave a truncated file that passes the readiness probe and then
  fails mysteriously at the first transcription.
- A 2 GB VPS now gets Parakeet rather than being stepped down to Whisper Tiny —
  the q4 weights are 339 MB and fit comfortably; the old floor bought headroom
  the box didn't need at a large accuracy cost.
- Non-interactive-safe: without a TTY, install requires `--yes` instead of
  blocking forever on a prompt nothing will answer.
- Missing ffmpeg is called out at the end with the exact per-platform command,
  since transcoding is required and its absence otherwise surfaces much later.

## [0.7.5-rc.4] - 2026-07-29

**A local transcription provider that actually runs.**

The 2026-07-03 ratification adopted transcribe.cpp as the local provider, on
the assumption a `transcribe-cli` binary would ship. It never did. v0.1.3
(2026-07-12, latest) still publishes only `libtranscribe.{dylib,so}` +
`libggml*` + `contract.json` — the CLI is build-from-source — and its N-API
binding crashes on Bun, so the in-process route is closed too. Four weeks and
three releases after the ratification, `transcription install` still could not
produce a runnable setup.

whisper.cpp ships what transcribe.cpp doesn't: **prebuilt CLIs on both
platforms**. `brew install whisper-cpp` (bottled for arm64 macOS) installs
BOTH `whisper-cli` and `parakeet-cli`; the Linux release tarballs carry the
same two. Models are prebuilt too, so nothing is converted and no Python is
involved anywhere.

- **New `whisper-cpp` provider.** The chosen MODEL decides which CLI runs, so
  an operator never thinks about binaries.
- **Parakeet is the recommended model.** It beats Whisper large-v3 on the Open
  ASR Leaderboard (6.32% vs 7.44% avg WER) at ~⅓ the parameters, runs faster,
  and — the property that matters for voice memos — **doesn't hallucinate
  during silence**, Whisper's best-known failure mode. Whisper models stay in
  the catalog for languages outside Parakeet's 25.
- **A real catalog** (`models.ts`): 7 models from 74 MB to 1549 MB, every URL
  and size verified live against HuggingFace, with a RAM-aware default picker
  that steps down rather than handing a 1.5 GB model to a 1 GB box.
- **Binary resolution that survives launchd** (`resolve-binary.ts`): explicit
  override → our managed dir → Homebrew prefixes → PATH. Homebrew is probed
  explicitly because a launchd-supervised vault does NOT inherit a login
  shell's PATH — on macOS that is the single most likely way this breaks, and
  "I installed it and it still says not configured" is the worst failure
  available.
- **Failures name the missing piece**, its size, the fix, and where we looked.

ffmpeg remains required despite `parakeet-cli` advertising flac/mp3/ogg/wav:
browser voice capture is webm/opus, which is on neither CLI's list, and
`whisper-cli` strictly wants 16 kHz mono WAV. Audio is always transcoded — one
path, no format sniffing.

`transcribe-cpp` is left in place for now (unreachable in practice, since its
CLI doesn't exist) and retires in a follow-up alongside the default flip.

## [0.7.5-rc.1] - 2026-07-29

**Importing a real vault from git actually works now.** Two changes, one story:
the import flow assumed vaults were small and assumed you wanted push-back.

- **Import is an async job (#640)** — `POST .../mirror/import` now returns
  `202 { job_id }` and the work continues server-side; poll
  `GET .../mirror/import/<job_id>` for stage, live `git --progress` output, and
  the outcome. The old shape ran the whole clone-and-import inside the request,
  which could never work at scale: hub fronts the vault with
  `Bun.serve({ idleTimeout: 255 })`, so anything past ~4 minutes died in the
  proxy regardless. The **60-second clone timeout is gone** — it was a symptom
  of that ceiling, and it made any vault bigger than a demo fail with
  `git clone timed out after 60s`. A clone is now bounded by a **stall** timeout
  (10 minutes with no progress output) rather than wall-clock, because "big" and
  "broken" are different conditions and only the second one should be killed.
  The admin SPA shows the stage, git's own progress line, and elapsed time, and
  survives a page reload or a second tab by attaching to the running job.
  Scripted callers that need the old synchronous response can pass
  `{ "wait": true }`.

- **Import no longer arms backup by itself (#641)** — `enable_sync` now defaults
  to **false**. It defaulted to true (#416), which meant importing a repo
  silently turned that repo into this vault's push target: the safe intent
  (pull a copy onto a new box) required noticing and unchecking a box, while the
  consequential one (repoint backup, possibly at a repo another machine already
  pushes to) was what you got by not reading carefully. It also made the
  credential question incoherent — operators reasonably refused to supply a
  token to *read* a private repo because supplying it appeared to arm a write.
  The import form now states which credential it will use, says plainly that a
  one-time read-only PAT is enough and that **you don't need to configure backup
  in order to import**, and only mentions push-back if you opt in.

## [0.7.4] - 2026-07-28

**Stable promotion of the 0.7.4 line (3 commits over 0.7.3).** Promotes rc.1–rc.2
to `@latest`. Two user-facing changes:

- **`segment_index` self-host parity (#630)** — a segmented voice recording (one
  note carrying several audio parts, each transcribing into its own
  `_Transcript pending (part N)._` marker) silently lost all but one part's
  transcript on self-host. The REST and MCP attach paths never read
  `segment_index` off the request body, so every part resolved to the same
  unnumbered marker: the last writer won, the other markers were left stranded in
  the note, and the recovered transcripts sat unreachable in attachment metadata.
  Both doors now read it, matching the hosted door's shape. **Long voice memos
  keep all of their transcript.**
- **Admin-UI toggle for embeddings (#624)** — semantic search shipped opt-in and
  default-off in 0.7.3; operators can now turn it on from the self-host settings
  page instead of editing config by hand.

Also: CLAUDE.md slimmed to purpose + gotchas (#625, docs-only).

No schema migration — `SCHEMA_VERSION` stays at 27, unchanged since 0.7.3.

## [0.7.4-rc.2] - 2026-07-28

**`segment_index` self-host parity fix (voice W2 two-door bug).** A segmented
voice recording (multiple audio parts on one note, each transcribing into its
own `_Transcript pending (part N)._` marker) was silently losing all but one
part's transcript on self-host: the door never read `segment_index` off the
attachment POST body at all, so every part fell back to the shared bare
`_Transcript pending._` marker, the replace missed, transcripts appended out
of order, and completing one part cleared the shared `transcribe_stub` —
locking the other parts out entirely. Cloud already had this right
(`workers/vault/src/rest/notes.ts`); this is the self-host twin catching up.
Companion fix `parachute-app#126` corrects the OTHER half — the client was
nesting `segment_index` under a `metadata` object no door reads at top level;
top level is the one agreed shape going forward, nested is not newly
supported. **Either half alone leaves the bug live.**

- **`POST /notes/:id/attachments`** (`src/routes.ts`) now reads a top-level
  `segment_index`, validated exactly like cloud (`typeof === "number"`,
  `Number.isInteger`, `>= 0`), and includes it on the attachment's metadata
  when valid. A malformed value doesn't error the request — it silently falls
  back to the un-segmented bare markers, matching cloud's own fallback.
- **Ticket-mint parity** (`request-attachment-upload`, `core/src/mcp.ts` +
  `core/src/mcp-manifest.ts` + `core/src/attachment/tickets.ts` +
  `src/attachment-tickets.ts`): the same validated `segment_index` now threads
  through an agent's ticket-based upload too, for consistency between the two
  attachment-creation paths (the app's own segmented-voice flow doesn't use
  this path today, but any MCP client minting a segmented upload now gets the
  same correct behavior).
- **New end-to-end test** (`src/vault.test.ts`) drives the real REST endpoint
  with a top-level `segment_index` on two attachments and runs the
  transcription worker to confirm each part's marker resolves independently,
  out of completion order — the door's full loop, not just metadata storage.
  It does NOT prove the app's real request body actually reaches this state;
  that join has no test yet, filed as vault#629.

## [0.7.4-rc.1] - 2026-07-22

**Admin-UI toggle for semantic search (0.7.3 fast-follow).** 0.7.3 made
semantic search opt-in with a persisted `embeddings_enabled` config.yaml
setting, but the only way to flip it was hand-editing config or setting an env
var. This adds a real toggle over that setting to the vault admin SPA, so an
operator turns semantic search on from the UI.

- **New endpoint** `GET|PUT /vault/<name>/.parachute/embeddings` (`vault:admin`)
  — reads/writes the persisted `embeddings_enabled` through the existing config
  write path (`writeGlobalConfig`, no hand-rolled YAML). The snapshot reports
  `enabled` (persisted), `active` (live in the running process), `effective`
  (what a restart would produce), `restart_required` (the gap), and
  `env_override`/`env_forced` (when `EMBEDDINGS_ENABLED` is forcing a value).
- **New admin-SPA page** under a vault's detail → "Semantic search". A toggle
  with copy warning that enabling triggers a one-time model download (~34MB) on
  first embed + embeds-on-write, and that the setting is host-wide.
- **Activation is restart-to-apply, not hot.** The embedding provider is
  resolved once at boot and captured into every store + the embedding worker,
  so a flip persists the setting and the UI shows a "restart the vault to
  apply" banner rather than pretending to hot-activate. Hot-reconfigure is a
  possible follow-up.
- **`EMBEDDINGS_ENABLED` env still wins** as the low-level override; when it's
  forcing a value the UI shows an advisory banner so the toggle never lies
  about what's actually in force.

## [0.7.3] - 2026-07-22

**Stable promotion of the 0.7.3 line (16 commits over 0.7.2).** Promotes the
rc.1–rc.15 work to `@latest`. Highlights: **semantic search** (`query-notes`
`near_text`, embed-on-write, per-section chunking, a two-tier self-host
provider) — now **opt-in, default off** (see below); **attachment tickets**
(agent upload/download via short-lived capability URLs) + a read-attachment
model lane with REST Range support; **canonical root `/mcp`** with
token-derived vault dispatch; **computed `display_title`** on list shapes
with lexical title-boost ranking (frontmatter-aware); the **`starter-ontology`
seed pack** (view/archived/pinned/capture meta tags) with re-apply that
preserves user-edited descriptions; a **`date` field type** for meta-tag
schemas; **per-segment transcript slots** (segmented voice recordings);
`expand_mode:"summary"` lede fallback; lean live-query snapshots; and the
pure-data MCP tool manifest extraction.

Two things for consumers to note at the stable line:

- **Semantic search is now OPT-IN (default off).** With it off there is no
  embedding provider, no embed-on-write hook, no backfill sweep, and no model
  download; `query-notes { semantic: true }` returns an honest
  `semantic_unavailable`. Enable with `EMBEDDINGS_ENABLED=true` (env override)
  or the persisted `embeddings_enabled: true` in `config.yaml`, then restart.
  `@huggingface/transformers` + `onnxruntime-node` (~270MB) remain a hard
  dependency so enabling is a pure config flip. See
  [UPGRADING.md](./UPGRADING.md#072--073--semantic-search-opt-in--note_vectors-schema).
- **One response-shape reminder (within the pre-existing vault#550 contract):**
  a non-cursor `query-notes` may return a bare array **or** a `{ notes,
  warnings }` envelope — programmatic MCP consumers must handle both.

Automatic `v26 → v27` `note_vectors` schema migration on first boot (additive,
transactional, no backfill). No other operator action required.

## [0.7.3-rc.15] - 2026-07-20

**MCP tool manifest — pure-data extraction (front-of-house Wave 0).** The
inert foundation for an account-level front-of-house MCP layer: the tool
set's *metadata* (name, description, inputSchema, scope verb, inclusion
condition) is now a pure-data manifest both the vault and a future
identity-worker / hub layer can import. ZERO wire or behavior change — a
byte-identical refactor, pinned.

- **`core/src/mcp-manifest.ts`** (new) — `MCP_TOOL_MANIFEST`, an ordered
  array of `{name, description, inputSchema, requiredVerb, condition}` for
  all 16 tools (13 `core` + 2 `attachment-tickets` + 1 `attachment-bytes`).
  No store, no closures, no execution — data only. Its transitive import
  graph is deliberately free of `bun:sqlite` (and every `bun:`/`node:`
  runtime builtin) so it loads under Cloudflare workerd via the same
  `file:../../../parachute-vault/core` dep the vault worker already uses;
  the front-of-house layer can enumerate/verb-filter the tool set without
  ever touching the store code.
- **`generateMcpTools`** (`core/src/mcp.ts`) now BUILDS its tool set by
  iterating the manifest and zipping each entry with a store-bound
  `execute` closure (keyed by tool name), rather than carrying the
  metadata inline. The manifest is the single source of
  name/description/inputSchema/verb; `generateMcpTools` only adds behavior.
  Conditional tools are gated by their `condition` exactly as before —
  ticket tools present only with an `attachmentTickets` seam,
  `read-attachment` only with an `attachmentBytes` seam.
- **`core/src/content-range-constants.ts`** (new) — `MIN_CONTENT_LENGTH`
  extracted here (dependency-free) so the manifest can reference it in a
  tool description without pulling `bun:sqlite` in through
  `content-range.ts`; the latter re-exports it, so every existing importer
  is unchanged.
- **Pin** (`core/src/mcp-manifest.test.ts`) — asserts the emitted tool set
  is byte-for-byte the manifest (name/description/inputSchema/verb, in
  order, gated by condition), the ordered name/verb/condition contract
  matches what `main` emitted at extraction time, and — with a positive
  control over `mcp.ts` — that the manifest's transitive import closure
  reaches no `bun:sqlite`. Fails the moment the manifest and the built
  tools drift.

## A note on versioning between launch (0.2.4) and 0.4.5

CHANGELOG entries between `0.2.4` and `0.4.5` narrate development work,
but not every entry corresponds to a published version on npm. The
entries starting at `0.3.6-rc.1` (2026-04-26) chronicle internal RC
version bumps in `package.json` during active development; only a subset
were pushed to the npm registry:

| Listed in CHANGELOG                       | Actually published to npm                    |
| ----------------------------------------- | -------------------------------------------- |
| `0.3.6-rc.1` through `0.3.6-rc.39`        | `0.3.0-rc.1`, `0.3.0`, `0.3.1`, `0.3.3`      |
| `0.4.0-rc.1`, `rc.2`, `0.4.0` stable      | `0.4.0` only                                 |
| `0.4.1` chain through `0.4.2`             | (none published)                             |
| `0.4.3-rc.1`, `rc.2`, `0.4.3` stable      | `0.4.3` only                                 |
| `0.4.4-rc.1` through `rc.14` + stable     | `0.4.4-rc.11`, `rc.12`, `rc.14` only         |
| `0.4.5-rc.1`, `rc.2`, `0.4.5` stable      | `0.4.5` only                                 |

Most beta users running an `npm install`-style upgrade between launch
and 0.4.5 ended up on one of: `0.2.4` (no upgrade), `0.3.0`, `0.3.1`,
`0.3.3`, `0.4.0`, `0.4.3`, or `0.4.5`. The "0.3.6" series in the
chronological CHANGELOG below never had a corresponding npm version.

The versioning discipline now codified in
[`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md)
(Rule 2 — RC versioning) was instituted as a response to this drift,
around the 0.4.4 cycle. Going forward each CHANGELOG entry on a
code-touching PR bumps the `rc.N` suffix and gets published to npm
under the `@rc` dist-tag; stable promotes drop the suffix and publish
to `@latest`.

## [0.7.3-rc.14] - 2026-07-20

**Lean live-query snapshots for list subscriptions (perf).** A live-query
subscription's initial snapshot (and its live `upsert` events) shipped the
COMPLETE matching set as FULL `Note` objects — every note body in the set — even
for an unfiltered all-notes list view. So subscribing the notes list transferred
every note's content over the wire, where the REST list path already returns the
lean `NoteIndex` shape (`byteSize` + `preview` + `displayTitle` + tags/metadata,
no body). This closes that gap on the live path.

- **`include_content` on the subscribe query** (`src/ws-subscribe.ts`) — a
  subscriber opts into the lean wire shape by passing `include_content=false` on
  the `GET /vault/<name>/api/subscribe` query (the SAME knob the REST list route
  reads). Unlike the REST list route (which defaults lean), a subscription
  defaults to `true` — FULL notes — so every already-deployed subscriber
  (cached notes-ui bundles, surface-client) keeps receiving byte-identical
  full-note snapshots/upserts. List views opt into lean; the single-note view
  leaves it default → full.
- **Lean snapshot + upserts** (`src/ws-server.ts`, `src/subscriptions.ts`) —
  when a subscription is lean, the chunked snapshot frames and every live
  `upsert` carry the `toNoteIndex` projection (the identical shape REST lists
  return, so a client that renders REST lists renders these frames unchanged)
  rather than the full `Note`. Projection happens AFTER the tag-scope filter.
  `remove` events are unaffected (already a thin `{id}` ref). `buildSnapshotFrames`
  is now shape-agnostic (`Note | NoteIndex`).
- This is a WIRE-CONTRACT addition on the live protocol — additive and
  backward-compatible (default unchanged). The cloud door's live twin
  (`parachute-cloud workers/vault`) mirrors this for door parity as a sequenced
  follow-up, and the app opts its list subscriptions into lean separately. This
  PR fixes the CONTENT bloat (the large win); snapshot windowing (honoring
  `limit` so a list snapshot is 50, not all-N) is a larger separate follow-up.

## [0.7.3-rc.11] - 2026-07-17

**`read-attachment` — model-lane byte reads (Wave 2, bun door) + REST
`Range`.** Ratified design (Attachments for Agents, rev 2): the runtime
lane (Wave 1, tickets, rc.7) moves bytes without ever touching the model;
this wave is the complementary model lane — a new MCP tool that lets the
model actually *see* an attachment's content, dispatched by mime family
so the shape stays honest about what each type can and can't do. Two
ratified amendments over the spec stand: `attach-file` (inline
base64/text write) stays cut — tickets remain the only write path; and
this wave is result-side read only.

- **`read-attachment`** (`core/src/mcp.ts`) — new MCP tool, present ONLY
  when a door wires an `AttachmentBytesProvider` (D10, same "tools
  omitted when unwired" posture as the ticket tools). Resolves the
  attachment, tag-scope-checks its owning note (uniform `not_found`, same
  no-oracle posture as the ticket tools), then dispatches on the
  attachment's EFFECTIVE mime type — extension lookup in the shared
  `ATTACHMENT_MIME_TYPES` map first (the same discipline the REST
  byte-serve route uses), then the row's own `mime_type`, then
  `application/octet-stream`:
  - **text** (`text/*` + a small allowlist — `application/json`,
    `application/ndjson`/`x-ndjson`, `application/yaml`/`x-yaml`; `text/csv`
    and `text/markdown` are already `text/*`) — a byte-windowed `content`
    slice using the EXACT `query-notes` pagination contract
    (`content`/`content_offset`/`content_total_length`/`content_next_offset`).
    Default window 65,536 bytes (64 KiB); hard max 262,144 (256 KiB) per
    call. Does a BOUNDED positional read — never the whole file — via a
    new `alignByteWindow` in `core/src/content-range.ts`, the byte-level
    counterpart to `sliceContentRange` for when loading a multi-hundred-MB
    attachment into memory to slice a string is exactly what the design
    forbids.
  - **image** (`image/*`; SVG can't exist — blocked at upload) — a REAL
    MCP `{type:"image"}` content block the model can see, alongside the
    row-JSON text block. Capped at 4 MiB raw (`MAX_ATTACHMENT_IMAGE_BYTES`,
    `core/src/attachment/bytes-provider.ts`), checked via `stat()` BEFORE
    any bytes are read — an over-cap image never touches `readRange` at
    all, refusing with `image_too_large` (`size`, `max_bytes`, `how_to` →
    a download ticket). Range params on an image → `invalid_query` (images
    don't page).
  - **audio/video** — never bytes, ever. Returns a transcript pointer:
    `{attachment_id, transcribe_status, note_id, transcript_note?}` built
    entirely from metadata the transcription pipeline already stamps
    (`transcribe_status: pending|done|failed`) plus an OPTIONAL
    `resolveTranscriptNote` hook a door can implement (bun: resolves the
    `<path>.transcript` sibling note; a door without one — e.g. cloud,
    whose transcript lives in the owning note's body — falls back to
    `note_id` alone). No `transcribe_status` at all (never requested) →
    `audio_bytes_not_supported` with a `how_to` pointing at `transcribe:
    true` or a download ticket.
  - **other binary** (PDF, zip, docx, …) — honest
    `unsupported_attachment_type` refusal (`mime_type`, `size`, `how_to` →
    download ticket); extraction is a v2 concern. Stats first, so a row
    whose bytes are ALSO gone gets `attachment_binary_missing` instead —
    the more accurate refusal.
  - **missing binary** (row outlived bytes — e.g. an `audio_retention`
    eviction after a successful transcription) — `attachment_binary_missing`
    on the text/image/other-binary paths (audio never touches bytes, so
    it's immune by construction).
- **`core/src/attachment/bytes-provider.ts`** — the `AttachmentBytesProvider`
  seam: `stat` + a bounded `readRange`, plus the optional
  `resolveTranscriptNote` hook. Deliberately narrow — all POLICY (mime
  dispatch, size caps, range validation, tag-scope) lives in the tool
  itself, mirroring the ticket seam's division.
- **`src/attachment-bytes.ts`** (bun's Wave 2 implementation) —
  `createFsAttachmentBytesProvider`, a stateless per-session factory (no
  shared singleton needed — unlike tickets, there's no cross-request state).
  `readRange` uses `Bun.file(path).slice(start, end)` — a bounded,
  positional read — never `readFileSync`.
- **`core/src/mcp.ts`: `McpToolDef.resultContent`** — the one wrapper
  change the design called for. An optional `(result) => McpContentBlock[]`
  override; every tool without it keeps the universal single-text-block
  default. `read-attachment`'s image branch is the only current user
  (`src/mcp-http.ts`'s `CallTool` handler now prefers it when present, ~5
  lines).
- **REST `Range` (206)** on the existing byte-serve route (`GET
  /storage/<path>`, `src/routes.ts`) — the REST twin of MCP's
  `content_offset` (D9). A new `parseByteRangeHeader` honors a single
  `Range: bytes=a-b` header (`bytes=a-`, `bytes=-b` suffix ranges; a
  MALFORMED or multi-range header falls back to `null` → the full 200
  response, not an error). A syntactically-valid-but-UNSATISFIABLE range
  (e.g. `bytes=999999999-` past EOF) is NOT handled by this fallback in
  practice — live-verified against a real `Bun.serve` socket (not the
  in-process test harness): Bun's native range handling on a `Response`
  body backed by `Bun.file()` intercepts satisfiable-shaped-but-out-of-
  bounds ranges and returns **416 Range Not Satisfiable** itself, before
  `parseByteRangeHeader`'s `null` return would otherwise fall through to
  the full-200 branch. This is RFC 7233-correct behavior — kept as-is;
  `parseByteRangeHeader`'s own `null` return for that case is effectively
  moot at the `Bun.serve` layer (the in-process test harness used by
  `storage.test.ts` calls `handleStorage` directly, bypassing `Bun.serve`
  entirely, so it can't observe the 416 — see that test's comment). The
  whole-file `readFileSync` this route used is gone on BOTH the ranged
  (206) and full (200) paths — replaced with `Bun.file(filePath)`, a
  bounded/streamed read that fixes the standing memory smell of buffering
  a large attachment (e.g. a 90 MB video) entirely in memory. Same
  confinement + tag-scope guards, byte-identical.
- **`core/src/mcp.ts` / `src/mcp-http.ts` error-field forwarding** — the
  generic `error_type` catch-all now also forwards `size`/`max_bytes`/
  `mime_type` when present (the `read-attachment` refusal fields), same
  forward-when-present discipline `how_to`/`limit`/`got`/`extension`
  already had.
- **Discoverability** — `attachmentsInstructionBlock()`
  (`core/src/vault-projection.ts`) gains a `readEnabled` flag and a new
  sentence teaching `read-attachment` (present only when the seam is
  wired), folded into the same connect-time brief the ticket tools use.

### Rider: attachment-ticket sweep (vault#612)

`InProcessAttachmentTicketProvider` (`src/attachment-tickets.ts`) gains
`sweepExpired()` — drops every unspent ticket whose TTL has elapsed.
`take()` already enforces expiry AT SPEND TIME (a stale ticket can never
be successfully spent), so this is purely a memory-hygiene backstop: an
agent that mints and then abandons the flow (a curl that never runs)
would otherwise sit in the process-wide `Map` forever. `startAttachmentTicketSweep`
/ `stopAttachmentTicketSweep` run it on a 30s interval (`.unref()`'d, same
cadence family as `EmbeddingWorker`'s default sweep) — wired into
`src/server.ts` alongside the embedding worker's own start/stop.

### Tests

`core/src/content-range.test.ts` — `parseAttachmentContentRange` (default
window, explicit length within/above/below bounds) and `alignByteWindow`
(matches `sliceContentRange` byte-for-byte under a SIMULATED bounded read,
never splits a codepoint, and a reassembly-property test chaining
`content_next_offset` through bounded reads reproduces arbitrary
mixed-width unicode content exactly). `src/read-attachment.test.ts` — full
end-to-end through the real `tools/call` path: every mime-family behavior
above, a range-paging round-trip on a >256 KiB multi-byte-UTF-8 file, the
image block's two-content-block shape + base64 fidelity + cap refusal,
every `transcribe_status` value (including a resolved vs. unresolved
sibling transcript note), PDF/zip refusal shape, `attachment_binary_missing`
for text/image/PDF rows with no bytes on disk, tag-scope uniform-404, and
the read-tier visibility check. `src/storage.test.ts` — `parseByteRangeHeader`
unit coverage (satisfiable/suffix/open-ended/unsatisfiable/malformed/
multi-range) and a `storage GET Range support` suite (206 shape, a
paging-reassembly round-trip through the real route, malformed/multi-range
→ 200 fallback as the in-process harness observes it — see the live-416
note above for what a real `Bun.serve` does instead on an unsatisfiable
range, tag-scope interaction). `src/attachment-tickets.test.ts` — the
vault#612 sweep (isolated-instance drop/keep + exact-boundary `<` vs `<=`,
shared-provider delegation via unique ids, and a real short-interval
timer actually dropping an expired ticket) plus two new discoverability
pins for `readEnabled`. Existing MCP tool-count/tool-list pins in
`src/vault.test.ts` updated for the new tool — the unscoped/no-opt-in
base count stays 13 (`read-attachment` is opt-in, like the ticket tools);
the scoped-session (opt-in-wired) pins move: read-tier 6→7, read+write
10→11, admin 16→17.

## [0.7.3-rc.10] - 2026-07-17

**`expand_mode: "summary"` falls back to the note's lede when
`metadata.summary` is absent.** Machinery half of a soft convention from
Aaron/Adam's-AI dialogue (2026-07-17, not formally ratified): summaries
work better as visible CONTENT — a note's opening paragraph — than as
hidden metadata, because visible text gets corrected by the notes that
reference it while a hidden `metadata.summary` rots unnoticed. This PR
doesn't validate that convention or force it; it just makes
`query-notes`' summary-mode link expansion reward it when a note
happens to follow it, without changing behavior for notes that already
carry `metadata.summary`.

- `computeLede` (`core/src/notes.ts`, new): derives a note's lede — the
  first non-empty paragraph AFTER its title line (a run of consecutive
  non-blank lines, whitespace-collapsed, capped at 400 code points on a
  code-point boundary). Shares its title-line rule, including the
  leading-frontmatter skip, with `computeDisplayTitle` via an extracted
  `skipLeadingFrontmatter` helper — the two functions agree on where a
  note's title ends. Returns `null` for a title-only note (no paragraph
  to report) rather than repeating the title as a fake lede.
- `core/src/expand.ts`'s `summaryText` now falls back to `computeLede`
  when `metadata.summary` is absent or blank. `metadata.summary`, when
  present, still wins — no behavior change for existing summary-bearing
  notes (e.g. Aaron's vault).
- `query-notes`' `expand_mode` parameter description documents the
  fallback in one place (the MCP tool schema).
- Tests: `core/src/lede.test.ts` (new) — paragraph-after-title
  derivation, multi-line paragraph collapsing, whitespace collapsing,
  title-only → null, frontmatter-block skip (including title
  immediately after frontmatter with no blank line), length cap +
  Unicode code-point-safe truncation; `core/src/core.test.ts` — the
  `expand_mode: "summary"` MCP path: fallback fires when
  `metadata.summary` is absent, `metadata.summary` still wins when both
  exist, fallback respects a leading frontmatter block, and the
  pre-existing title-only/no-lede case still renders an empty summary
  block (renamed from "no metadata.summary" to "no metadata.summary AND
  no lede" — it was only ever exercising the title-only case, not the
  general "no metadata.summary" case this PR adds).

### Added

- `core/src/notes.ts`: `computeLede` + `LEDE_MAX_LEN` — derives a note's
  opening paragraph after its title line, for use as a fallback when a
  note has no `metadata.summary`.

### Changed

- `core/src/expand.ts`: `expand_mode: "summary"` link expansion falls
  back to `computeLede` when `metadata.summary` is absent; unaffected
  when `metadata.summary` is present.
## [0.7.3-rc.9] - 2026-07-17

**Docs catch-up — CLAUDE.md + HTTP_API.md + README against six same-day
releases (rc.3–rc.8).** No code change. Corrects drift that had accumulated
across `date` field type (#604), the `starter-ontology` seed pack (#605),
seed-pack re-apply preserving hand-edited descriptions (#606), computed
`displayTitle` + search title-boost (#608), attachment tickets (#611), and
the frontmatter-skip follow-up (#610):

- `CLAUDE.md`: the "MCP Tools" count was a stale flat "13, +1 server-layer."
  Restated honestly as 13 core (unconditional) + 2 conditionally-appended
  attachment-ticket tools (present whenever a door wires an
  `attachmentTickets` seam — always true on bun's own server) + `manage-token`
  at the server layer — 16 total on a fully-provisioned admin session. Added
  the `date` field type and computed `displayTitle` to the Data Model section,
  and folded the four seed packs (`welcome`/`getting-started`/
  `surface-starter`/`starter-ontology`, the last opt-in) into the "Bare
  primitives" design-decision bullet.
- `docs/HTTP_API.md`: new "Attachment tickets" section documenting
  `PUT|POST /vault/{name}/tickets/{id}` and `GET /vault/{name}/tickets/{id}`
  — the no-auth, ticket-is-the-credential spend routes that sit deliberately
  outside the authed `/api` and `/mcp` trees. The MCP tool-tier table gains
  `request-attachment-upload`/`request-attachment-download` with a footnote
  on their conditional presence. `date` field type and `displayTitle` were
  already documented correctly by #604/#608 themselves — verified, not
  rewritten.
- `README.md`: the "MCP tools (9)" section and "9 tools" bullet were already
  stale before today's six releases (missing `rename-tag`/`merge-tags`/
  `prune-schema`/`doctor`/`manage-token` from a much earlier pass) —
  corrected alongside the same-day drift rather than left inconsistent next
  to the freshly-fixed counts elsewhere. Quickstart `bun` commands spot-checked
  against `package.json`'s `bin` entry and `src/cli.ts`'s `init` case — accurate,
  unchanged.

Version bump only to keep the rc-per-PR convention (docs-only PRs #584 and
#540 both took one) — assumes this is the next PR to land after rc.8;
whichever merges second renumbers.

## [0.7.3-rc.8] - 2026-07-17

**`computeDisplayTitle` skips a leading frontmatter block.** Follow-up
from #608's review: content that literally *starts* with a YAML
frontmatter block (`---\ntitle: X\n---\n# Real Title`) derived the
literal string `"---"` as its display title instead of the real one.
Normal ingestion strips frontmatter into `metadata` before create, so
this only bites direct MCP/REST creates that paste raw
frontmatter-bearing text — a misuse path, but a cheap fix under the
ratified "title = first line" model: the first line of the DOCUMENT is
not the first line of its delimiter.

- `computeDisplayTitle` (`core/src/notes.ts`) now detects a leading
  `---` line and, if a matching closing `---` is found within a bounded
  scan (the first 100 lines), derives the title from the first
  non-empty line AFTER the closing fence instead. An unterminated
  opening `---` (no closing fence within the scan window) falls back to
  the pre-existing behavior — deriving from line 0 — so a note whose
  real first line is literally `---` (e.g. a markdown horizontal rule)
  isn't mangled. A note whose entire content is a closed frontmatter
  block (nothing meaningful after it) derives `null`, same as any other
  note with no non-empty line.
- The search title-boost (`titleMatchesAllTerms` in the same file) calls
  `computeDisplayTitle` directly — it inherits the fix automatically, no
  separate change needed.
- Tests: `core/src/display-title.test.ts` — closed-frontmatter skip
  (single field and multi-field/blank-line variants), unterminated `---`
  fallback, whole-content-is-frontmatter → null (with and without a
  trailing newline, and with trailing blank lines), bounded-scan-window
  miss falls back, byte-identical regression pin on non-frontmatter
  content; `core/src/search-title-boost.test.ts` — a frontmatter-led note
  still boosts to the front on its real (post-frontmatter) title.

### Fixed

- `core/src/notes.ts`: `computeDisplayTitle` no longer derives `"---"`
  as the display title for content that opens with a closed YAML
  frontmatter block.
## [0.7.3-rc.7] - 2026-07-17

**Attachment tickets — agent upload/download via short-lived capability
URLs (Wave 0 + Wave 1, bun door).** Ratified design (Attachments for
Agents, rev 2, 2026-07-17): MCP tool arguments are model-emitted, so a
base64 upload through a tool call spends ~1 token per 2.5–3 bytes —
lossy, expensive, effectively impossible past a few hundred KB. The
runtime lane closes this without ever putting bytes through the model:
two new MCP tools mint a short-lived, single-use, capability-in-URL
ticket; a runtime with a shell spends it directly against a bare HTTP
endpoint outside the authed API tree. Three Aaron-ratified amendments
over the spec's original numbers: TTL defaults to 10 minutes (not 120s)
with 10s/MiB size scaling and a 30-minute hard cap; the inline
base64 `attach-file` tool is cut entirely (tickets are the only write
path); inline reads (`read-attachment`, text/image result-side) are
deferred to Wave 2.

- **`request-attachment-upload` / `request-attachment-download`**
  (`core/src/mcp.ts`) — new MCP tools, present ONLY when a door wires an
  `AttachmentTicketProvider` (D10, "tools omitted when unwired" — an
  agent never sees an affordance the runtime can't back). Upload mint
  resolves the target note, tag-scope-checks it, sanitizes the filename's
  extension against the shared blocklist, enforces `size_bytes <= 100
  MiB` (mirrors REST's own cap), infers `mime_type` from the extension
  when omitted, and returns `{method, url, headers, expires_at,
  max_bytes, curl_example}` — `curl_example` is a literal, ready-to-run
  string (discoverability-by-tool-result). Download mint resolves the
  attachment (tag-scoped via its owning note), returns the same envelope
  shape with `mime_type`/`size_bytes` when known.
- **`core/src/attachment/tickets.ts`** — the wire-shape-defining seam:
  `AttachmentTicket` record shape, the deliberately-dumb
  `AttachmentTicketProvider` interface (`put`/`take` — a single-use KV,
  no policy; ALL policy runs at mint in the tools themselves so doors
  can't drift), `computeTicketTtlMs` (10 min base + 10s/MiB, 30 min cap),
  `generateTicketId` (256-bit, Web Crypto `getRandomValues`).
- **`core/src/attachment/policy.ts`** — the extension blocklist + MIME
  lookup used by both REST upload and ticket mint, moved out of
  `src/routes.ts` into core as the single shared source ("shared
  BLOCKED_EXTENSIONS") so a blocked extension can never diverge between
  the two upload doors into a vault. `src/routes.ts` now imports these
  constants rather than declaring its own — REST behavior is unchanged
  (same Set/Record, just relocated).
- **`src/attachment-tickets.ts`** (bun's Wave 1 implementation) —
  `InProcessAttachmentTicketProvider`, a process-wide `Map` (not
  per-vault — ticket ids are already globally unguessable). A daemon
  restart drops every outstanding ticket; acceptable at a ≤30-minute TTL,
  documented at the call site. `handleTicketSpend` streams an upload to
  `assetsDir` with the existing server-generated `<date>/<ts>-<uuid><ext>`
  discipline and registers the attachment row (+ transcribe pipeline,
  mirroring the REST `POST /notes/:id/attachments` decision exactly) in
  the same spend — one step, not REST's two; a download spend streams the
  file back with the same path-confinement + `nosniff` discipline as the
  existing byte-serve route.
- **`/vault/<name>/tickets/<id>`** (`src/routing.ts`) — the bare spend
  route, dispatched BEFORE `authenticateVaultRequest` (deliberately — the
  ticket IS the credential; a bearer-less `curl` must be able to spend
  it). PUT or POST spends an upload ticket; GET spends a download ticket.
- **Wave 0 discoverability** — `attachmentsInstructionBlock()`
  (`core/src/vault-projection.ts`) folded into the connect-time markdown
  brief (`projectionToMarkdown` → `getServerInstruction`), teaching both
  the ticket tools and the REST fallback recipe every session.
- **Errors as JIT docs** — every new refusal (mint validation, spend
  size-cap, spend not-found) carries a `how_to` field alongside the
  existing `error_type`/`field`. The MCP error-mapping backstop in
  `src/mcp-http.ts` (the generic `error_type` catch-all) now forwards
  `how_to`/`limit`/`got`/`extension` when present — previously it
  silently truncated any `structuredError()` call down to
  `error_type`/`field`/`hint`, which would have dropped these on the
  ticket tools' errors specifically.

**Security posture:** capability-in-URL is safe to place in a shell
command (history, process list, proxy logs) because a ticket is
single-use (atomic delete-on-take — no oracle on spent/expired/unknown,
all three collapse to the same 404), short-lived (10–30 min, scaled by
declared size), and scoped to exactly one upload slot or one
attachment's bytes. Mint inherits everything the minting MCP call
already proved (token verification, per-vault scope, tag scope) — the
ticket is an *attenuation* of that authority, never an escalation. IDs
are 256-bit random (Web Crypto). No new credential class, no R2/S3
presigned URLs — bun's ticket state is an in-process map; the wire
shape (`AttachmentTicketProvider`, TTL formula, error taxonomy) is
pinned in core so a future cloud mirror can't drift on it.

**What the cloud mirror needs** (next PR, `parachute-cloud`): a
`AttachmentTicketProvider` implementation persisting to the vault's
Durable Object (`ctx.storage`, atomic delete-on-take under
`transactionSync` — DO's single-writer model makes single-use
race-free by construction), the same `/tickets/<id>` spend route
wired into the Worker's fetch handler (before its own auth), the mint
tools' policy extended with the full gate ladder against DECLARED size
(frozen → `plan_required`, Entry → `attachments_not_included`, cap →
`storage_cap_exceeded`) so an agent learns before curling, and
`attachmentsInstructionBlock({ ticketsEnabled: true })` appended to
`workers/vault/src/mcp.ts`'s `serverInstruction` once wired. Until that
PR lands, cloud's tool list simply omits both ticket tools (D10) — no
behavior change on that door from this PR.

### Tests

`core/src/attachment/tickets.test.ts` (TTL scaling + cap, id
uniqueness/shape), `core/src/attachment/policy.test.ts` (extension
sanitize, blocklist, MIME lookup, active-type invariant),
`core/src/attachment-tickets-tool.test.ts` (tools omitted when unwired;
mint validation errors incl. `how_to`; size cap; blocked extension;
tag-scope uniform-404 for both tools), `src/attachment-tickets.test.ts`
(end-to-end mint→spend for both directions through the real MCP +
routing layers: single-use/second-spend-404, size-cap 413 incl. a
Content-Length-only pre-check, expiry 404, wrong-vault-scope 404,
upload→row+transcribe+`transcribe_stub`, download streaming + byte
equality + path-confinement, connect-time instructions presence).
Existing MCP tool-count/tool-list pins in `src/vault.test.ts` updated
for the two new tools (13 → 15 core tools; read-tier 5→6, read+write
8→10, admin 14→16).

## [0.7.3-rc.6] - 2026-07-17

**Title axis — computed `displayTitle` + search title-boost.** Ratified
model (2026-07-17): a note's title IS its first line, derived from content,
never stored. Two engine pieces land here:

- **`displayTitle` on list shapes.** `toNoteIndex` (the same layer that
  computes `preview`/`byteSize`) now derives `displayTitle`: the first
  non-empty line of content, leading markdown heading marker (`#`–`######`)
  and whitespace stripped, truncated to 120 code points; `null` when
  content has no non-empty line. Free — every caller already has the full
  note's content in hand by this layer (queryNotes's phase-1 id-only
  ordering step is followed by a phase-2 full-row fetch before
  `toNoteIndex` ever runs), so this adds no new content reads on the
  `include_content=false` hot path. Lands on the `query-notes` MCP tool's
  list mode and the REST `GET /notes` (and other list-shape) responses —
  both inherit from the shared core `toNoteIndex`/`NoteIndex`. The hosted
  door's REST notes handler (`parachute-cloud`'s `workers/vault/src/rest/
  notes.ts`) already imports `toNoteIndex` from `@openparachute/core`
  (currently a local `file:` path dependency in that repo, not an npm
  pin) — it inherits `displayTitle` at its next core refresh + deploy, no
  code change needed there.
- **Search title-boost.** Literal-mode `search=` results whose
  `displayTitle` contains every query term are post-ranked ahead of
  body-only matches — an in-memory re-rank of the already-fetched result
  page (`applySearchTitleBoost`/`boostTitleMatches` in `core/src/notes.ts`),
  not a `notes_fts` schema migration. This is a SEPARATE axis from the
  existing `SEARCH_WEIGHT_PATH` bm25 weighting (vault#551) — that one
  boosts by note `path`, a different concept from the ratified title
  (first line of *content*). Skipped under an explicit `sort=asc`/`desc`
  (caller wants chronological order) and under `search_mode=advanced` (raw
  FTS5 syntax isn't safely tokenizable into boost "terms" — see
  `extractLiteralBoostTerms`'s doc comment in `core/src/search-query.ts`).
  Stable: notes in the same tier (both title-match, or both not) keep
  their existing relative order.
- Semantic search (`near_text`) is untouched — out of scope by design, so
  its eval baseline doesn't churn.

### Added

- `core/src/notes.ts`: `computeDisplayTitle`, `DISPLAY_TITLE_MAX_LEN`;
  `NoteIndex.displayTitle` (`core/src/types.ts`); `boostTitleMatches`,
  `titleMatchesAllTerms`, `applySearchTitleBoost` (wired into both
  `searchNotes` return paths, tagged and untagged).
- `core/src/search-query.ts`: `extractLiteralBoostTerms` — lowercase
  whitespace-tokenization of raw literal-mode search text for the boost,
  intentionally separate from `buildLiteralSearchQuery`'s FTS5-escaping
  tokens (strips literal quote characters a caller typed; doesn't attempt
  FTS5-tokenizer parity — a heuristic re-rank signal, not a second index).
- Tests: `core/src/display-title.test.ts` (derivation: first non-empty
  line, heading-marker stripping, truncation, code-point-safe truncation,
  null-on-empty; list-shape presence via MCP `query-notes`),
  `core/src/search-title-boost.test.ts` (title-match-outranks-body-match,
  ALL-terms-required for the boost tier, stable tie order, explicit-sort
  and advanced-mode opt-outs), `extractLiteralBoostTerms` cases in
  `core/src/search-query.test.ts`, REST `GET /notes` lean-shape
  `displayTitle` presence/null cases in `src/vault.test.ts`. Adjusted the
  `search-fts-v25.test.ts` path-vs-body ranking fixture (`legacy-1`) to a
  multi-line body so its single-line-content coincidentally containing the
  query term doesn't collide with the new content-title axis — see the
  inline comment there for why.
## [0.7.3-rc.5] - 2026-07-17

**Seed-pack re-apply preserves user-edited tag descriptions.** Aaron-ratified
2026-07-17: `applySeedPack` (`core/src/seed-packs.ts`) used to unconditionally
overwrite a tag's `description` on every re-apply — a user's hand-tuned
constitution (e.g. an edited `#archived` or `#capture` description) got
silently reverted the next time a pack landed (default create-time seed,
`add-pack`, or the cloud vault DO's equivalent path). New contract: a pack
writes a tag's description only when (a) the tag has no prior description
(brand-new tag, or an existing bare row nothing ever described), or (b) the
prior description is still byte-identical to the pack's own text — i.e.
genuinely unmodified. The instant a description differs from the pack's
current text, it's treated as a deliberate edit and is left alone on every
future re-apply.

- `ApplySeedPackResult` gains `preservedTagDescriptions: string[]` — the
  subset of `tags` whose description write was skipped this run.
  `fields` / `parent_names` / `relationships` are unaffected by this change —
  they keep upserting unconditionally (more entangled with schema-validation
  side effects; description-only is the ratified scope for this pass).
- `parachute-vault add-pack`'s report now distinguishes the two outcomes:
  `~ tag   <name> (upserted)` vs `~ tag   <name> (kept user description)`.
- **Known, accepted tradeoff**: the comparison is against the pack's CURRENT
  canonical text only, not any prior version. If a pack's description changes
  upstream, an un-edited vault reads as "matches the OLD text, therefore
  edited" and keeps the old text too — same outcome as a genuine hand edit.
  Constitutions aren't security patches that must propagate to every vault; a
  future `doctor`-style scan can surface "description drifted from the
  current pack text" as an informational finding without the applier having
  to guess intent.
- Tests: re-apply after a user edit preserves + reports it; re-apply of an
  untouched description still upserts; a fresh tag still gets seeded; the
  `capture` byte-identity anchor against `NOTES_REQUIRED_TAGS` holds under
  either pack apply order (`welcome` then `starter-ontology`, and reverse); a
  CLI-level test pins the new `(kept user description)` report line.

### Fixed

- `core/src/seed-packs.ts`: `applySeedPack` no longer clobbers a hand-edited
  tag description on re-apply.

### Added

- `ApplySeedPackResult.preservedTagDescriptions`.
- `src/cli.ts`: `add-pack` reports `(kept user description)` vs `(upserted)`.

## [0.7.3-rc.4] - 2026-07-16

**`starter-ontology` seed pack (opt-in).** From the 2026-07-16 design
dialogue (Letter 1, Q5: "yes — tiny, opinionated, removable"): a fourth
named pack, `core/src/seed-packs.ts`, adding exactly four starter tags —
`view`, `archived`, `pinned`, `capture` — with constitution-style
descriptions (plain, warm, non-prescriptive: they describe the DEFAULT
convention and invite each vault to adapt it) plus four seed `#view` notes
mirroring the app's default pages (All notes, Recent, Pinned, Archive), so
"default app pages are shipped views" has its data half from day one.

- **"Meta tag" naming.** `view` is the one tag here that carries a schema —
  the ratified user-facing term for that is now **meta tag** (a tag with a
  schema), and `VIEW_TAG`'s description names itself as one. `archived`,
  `pinned`, and `capture` are plain tags — no fields, just a taught
  convention.
- **`view`'s schema**: `kind` (`list | board | calendar | gallery`, default
  `"list"` — an unrecognized or absent kind should degrade to list rather
  than fail), `query` (the saved query — a JSON string of query-notes
  params), `lane_by` (board lanes, optional), `date_field` (the date-typed
  field a calendar plots against, optional — pairs with the `date` field
  type added in 0.7.3-rc.3). A `#view` note IS a saved view: metadata
  carries the machine-readable definition, the body is prose for people —
  so any surface can render it and any agent can write one.
- **`archived`**: out of the flow of the present — default views exclude it
  unless a view's own query asks for it back. **`pinned`**: surfaced first
  as its own partition, not a sort — reintroduced with these ratified
  semantics after the old sort-first `#pinned` was dropped as vestigial
  (rc.18 / PR #547); this pack never stamps it onto an existing note, and
  ships a `Pinned` view that actually surfaces it. **`capture`** is reused
  verbatim (same object reference) from `NOTES_REQUIRED_TAGS` — notes-ui's
  connect-time schema audit compares its description byte-for-byte, so the
  pack must never be able to drift that string regardless of apply order.
- **Seed views are authored explicitly, not magically**: `All notes` and
  `Recent` write `exclude_tags: ["archived"]` into their own query rather
  than leaning on a surface-side default; `Recent` adds `order_by:
  "updated_at", sort: "desc"`; `Pinned` queries `tag: "pinned"`; `Archive`
  queries `tag: "archived"` with no exclusion — the deliberate exception.
- **Deliberately opt-in.** `src/onboarding-seed.ts`'s default materialization
  (`welcomePack()` + `GETTING_STARTED_PACK`) is untouched — a fresh-vault UX
  change needs its own decision. Available today via `parachute-vault
  add-pack starter-ontology` or a console affordance; the pack existing
  makes shipping it by default later a one-line flip.

### Added

- `core/src/seed-packs.ts`: `VIEW_TAG`, `ARCHIVED_TAG`, `PINNED_TAG`,
  `STARTER_ONTOLOGY_PACK`, the four `*_VIEW_PATH` constants, and
  `VIEWS_PATH_PREFIX`; `"starter-ontology"` added to `SEED_PACK_NAMES` /
  `getSeedPack`.
- Tests: tag order + schema shape, the capture byte/reference-equality pin
  against `NOTES_REQUIRED_TAGS`, seed-view query JSON validity and content
  (exclude_tags / order_by / tag filters per view), no-dangling-wikilinks,
  and the registry listing.

## [0.7.3-rc.3] - 2026-07-16

**`date` field type.** Meta-tag schemas gain `date` alongside `string`/
`number`/`integer`/`boolean`/`array`/`object`/`reference` — an ISO-8601
date (`"2026-07-09"`) or full RFC3339 timestamp (`"2026-07-09T00:00:00.000Z"`).
Motivation: date-ish fields (e.g. a `meeting` tag's `meeting_date`) could
only be declared `type: "string"` with "ISO date" explained in prose, so
nothing could programmatically discover date-candidate fields for
calendar-view UIs. Validated with the SAME parser `date_filter`'s
`updated_at` bound already uses (`core/src/cursor.ts`'s `timestampToMs`) —
one ISO-parsing implementation, not two. Indexable (`indexed: true`) — an
indexed `date` field stores TEXT, so `gt`/`gte`/`lt`/`lte`,
`date_filter: { field }`, and `order_by` all fall out of the EXISTING
string-indexed-field machinery with no new SQL path. `list-tags`/
`vault-info`'s indexed-field catalog and `update-tag`'s response carry the
type through unchanged (nothing filters unknown/newer types out).

**Offset normalization (write-time, review fix).** A raw TEXT compare only
sorts ISO-8601 timestamps correctly when every stored value shares the SAME
offset representation — `timestampToMs` correctly VALIDATES an explicit
`±HH:MM` offset, but persisting it verbatim let a mixed-offset vault
silently mis-order/mis-filter (`"...+02:00"` sorting after `"...Z"` even
when the actual instant is earlier — the same bug class `updated_at` got a
dedicated ms-mirror column for, vault#585/#586, that hadn't yet extended to
user-declared `date` fields). `create-note`/`update-note` now rewrite any
FULL timestamp on a `date`-typed field to canonical UTC (`Z`-suffixed,
millisecond precision) before writing — normalize, not reject, matching the
existing "paths are normalized on write" precedent (rejecting offsets would
defeat the type's own calendar-integration motivation). A bare
`YYYY-MM-DD` value has no offset and is left untouched.

**Two follow-up fixes from delta review (round 2).** (1) A tag-add +
date-metadata combo in the SAME `update-note`/`create-note if_exists:update`
call skipped normalization — both handlers issue `store.tagNote` (the
actual tag mutation) AFTER the core `UPDATE` (deliberate: a `ConflictError`
from the guarded UPDATE must leave the note fully untouched), so
`normalizeDateFields` was resolving the schema against the note's STALE
pre-write tag set and never saw a `date` field newly declared by the tag
being added. Fixed by threading the PROJECTED final tag set (already
computed for the strict-schema gate) into `store.updateNote` as a new
`tagsForSchemaResolution` override, so both the tag-add AND the metadata
normalization land in the SAME atomic write. (2) `normalizeDateFields` used
to mutate its input `metadata` object in place — `core/` is a published
library, and a direct embedder holding a reference to the object they
passed in would see it change out from under them. Now copy-on-write:
returns the SAME reference when nothing needs rewriting, a lazily-allocated
shallow copy the first time a field actually needs rewriting. Every call
site reassigns its local binding from the return value rather than relying
on the old side effect.

**Backward compatible by construction.** `date` is opt-in per schema edit —
every existing `type: "string"` date field remains valid forever, no
migration, no data change. Schema edits are never retroactive: tightening
an existing field from `string` to `date` does NOT revalidate notes already
written under the old contract — only the field's NEXT write is checked
against the new type (the same sharp edge `strict`/`required`/enum
tightening already carries — see `core/src/conformance.ts`'s pre-check).

### Added

- `date` added to `VALID_FIELD_TYPES` (`core/src/tag-schemas.ts`) and to
  `indexed-fields.ts`'s `TYPE_MAP` (→ `TEXT`) — the recognized-type
  vocabulary and the indexable subset both grow by one.
- `defaultMatchesType` (tag-schemas.ts) and `valueMatchesType`
  (schema-defaults.ts) both gain a `"date"` case, reusing `cursor.ts`'s
  `timestampToMs` — a `default` or a note's metadata value on a `date`
  field is validated identically to every other typed field (advisory
  `type_mismatch` by default; hard rejection under `strict: true` or
  `indexed: true`, per the existing vault#553 Decision A rule).
- `core/src/conformance.ts`'s pre-tighten violation counter now recognizes
  `type: "date"` (previously dropped the type check for any type outside
  its narrower whitelist).
- `schema-defaults.ts:normalizeDateFields` — the offset-normalization fix,
  copy-on-write (round 2). Wired into every write path that reaches the DB:
  `store.createNote`, `store.updateNote` (covers merge-patch too — the
  merge already happened upstream by the time `store.updateNote` sees it),
  `store.createNotes` (bulk), and `store.createNoteRaw` (the legacy
  Obsidian importer).
- `store.updateNote`'s `updates` gains an optional `tagsForSchemaResolution`
  override (round 2) — lets a caller that's ALSO adding a tag in the same
  logical update pass the PROJECTED final tag set for schema resolution,
  instead of the note's stale pre-write tags. Wired at both mcp.ts call
  sites that combine tags + metadata in one item: `update-note`'s single-
  item handler and `create-note`'s `if_exists: "update"`/`"replace"`
  batch-upsert branch.
- Tests: type acceptance/rejection (both ISO forms), `default` validation,
  `type_mismatch` advisory + strict + indexed-forced-strict enforcement,
  `gt`/`gte`/`lt`/`lte` + `order_by` + `date_filter` on a schema-declared
  indexed `date` field, the no-retroactive-revalidation schema-edit
  compat guarantee, indexed-field-catalog introspection carry-through, the
  reviewer's exact mixed-offset repro as a regression test (offset + `Z`
  values sort/filter correctly post-normalization; write-then-read proves
  the stored/returned value is canonical `Z`-form; bare-date passthrough
  pinned), the round-2 tag-add + date-metadata combo (both call sites,
  sanity-checked to fail without the fix before landing), and a
  no-mutation pin on `store.createNote`/`updateNote`'s caller-supplied
  metadata object.

## [0.7.3-rc.2] - 2026-07-16

**Semantic search — EXPERIMENTAL.** Find notes by MEANING, not keyword —
`query-notes { near_text: "...", semantic: true }` (MCP) / `GET
/notes?near_text=...&semantic=true` (REST). Shipped in ONE PR, both doors
at once: the shared engine + self-host provider land here; the cloud
Workers-AI twin (C2) follows. Ratified 2026-07-16 after a P0 real-corpus
eval (Aaron's 3,467-note vault): best model 64.3% hit@10 on
meaning-only-recall queries vs. 7.1% for keyword search — semantic finds
what keyword search structurally can't. See `SEMANTIC-MVP-PLAN.md` /
`RESULTS.md` for the full evidence and the go decision.

Loudly experimental: documented as such in the MCP tool description and
this entry — the wire shape may change while quality is validated.

### Added

- **The seam** — `core/src/embedding/provider.ts`'s `EmbeddingProvider`
  interface (`embed`/`available`, `EmbeddingError`), a verbatim clone of the
  shipped `TranscriptionProvider` seam. Core stays dependency-pure — no
  model library lives in `core/`.
- **Per-section chunking** (`core/src/embedding/chunker.ts`) — pulled
  forward from "full-phase" into this MVP's scope (Aaron-ratified) after P0
  found whole-note embedding was the dominant miss cause on long, multi-
  topic morning-pages notes. Splits on markdown headings, then paragraphs,
  targeting ~450 tokens/chunk (chars/4 approximation, documented); tiny
  fragments merge into a neighbor so recall isn't fragmented. A short note
  is a single degenerate chunk — byte-equivalent in spirit to whole-note v1.
- **Schema v27** — `note_vectors` table (PK `(note_id, chunk_ix)`, `model` +
  `content_hash` freshness gate, `ON DELETE CASCADE`) + its stale-scan
  index. `migrateToV27` is pure schema, zero data movement — every
  pre-existing note's absent vector rows are ALREADY the "needs embedding"
  signal the async drain reads; the migration never calls a provider.
- **The scan + store wrapper** — `core/src/notes.ts:semanticSearchNotes`
  (structured filters narrow the candidate set FIRST, then brute-force
  cosine — stored vectors are L2-normalized so ranking is a dot product;
  best-CHUNK-per-note, note-level results); `Store.semanticSearch` is the
  one place a provider is ever invoked.
- **Wire:** `QueryOpts.nearText`/`semantic`; MCP `query-notes` `near_text`/
  `semantic` params (mutually exclusive with `search`/`aggregate`/`cursor`);
  REST `?near_text=&semantic=` on `GET /notes`. `semantic_unavailable`
  structured error (MCP: thrown `QueryError`; REST: 503) when no provider is
  configured/ready; `embeddings_pending` warning (with counts) on a
  mid-backfill vault — results are still real, just possibly incomplete.
  **Never a silent keyword fallback** — a caller always knows whether it got
  meaning or nothing. `GET /api/vault` gains `embeddings: {enabled,
  provider?, model?}` (transcription-capability precedent).
- **Two-tier self-host provider** (Aaron-ratified shape): **bundled floor**
  (`src/embedding/onnx-transformers.ts`) — `bge-small-en-v1.5` (q8 ONNX,
  34MB — P0 confirmed genuinely bundle-sized) via `@huggingface/
  transformers`, zero-config, lazy-loaded on first use, lazy-fails to
  `unavailable` rather than crashing if the runtime ever misbehaves.
  **Config upgrade** (`src/embedding/external-api.ts`) — an
  OpenAI-compatible `/v1/embeddings` client reading `EMBEDDING_API_URL`/
  `EMBEDDING_API_KEY`/`EMBEDDING_MODEL` (covers a local Ollama running
  `bge-m3`, the recommended quality tier — fully private, `ollama pull
  bge-m3` + three env lines). Config wins over the floor when present.
- **Embed-on-write + backfill** (`src/embedding-worker.ts`) — an `onNote`
  hook embeds a note's stale chunks after every create/update (a no-op edit
  makes ZERO provider calls — the content-hash freshness gate short-
  circuits first); a background sweep drains the backfill for pre-existing
  notes and catches anything a dropped dispatch left behind. Rides the
  existing `HookRegistry`/`HOOK_CONCURRENCY` cap — a bulk import can't spawn
  unbounded parallel embed calls.
- **`scripts/eval-semantic.ts`** — the P0 spike's harness, graduated into a
  permanent regression eval. Now a thin REST client against a live vault's
  real `near_text`/`semantic` endpoint (the product does the embedding now,
  not the script) scored against a query set of the shape
  `{id, class, query, target_ids, note?}`. The shipped
  `scripts/fixtures/eval-semantic-queries.json` is a SYNTHETIC example
  fixture, not a real query set — a real one is a meaning-summary of
  private note content and must stay local, never ride a public repo; bring
  your own file with real note ids and pass its path as the CLI arg — hit@5/
  hit@10/MRR per class, plus the plan's "classes 1+2 combined hit@10"
  verdict number.
- **Off switch** — `EMBEDDINGS_ENABLED=false` (mirrors the `EMBEDDINGS_ENABLED`
  wrangler var C2 plans for the cloud door) short-circuits BOTH self-host
  tiers: `buildEmbeddingProvider` resolves to no provider at all, the
  `embeddings` capability reports `enabled: false`, `semantic: true` throws
  `semantic_unavailable`, and the embed-on-write drain simply has nothing to
  invoke (no-op, not an error).
- **A mid-`embed()` failure now maps to `semantic_unavailable` too** (MCP
  `QueryError` / REST 503), not a raw unstructured 500 — `available()` is
  only a cheap readiness probe (never a real network/model round-trip), so
  a provider whose actual first `embed()` call fails (e.g. the bundled ONNX
  floor's lazy model load blowing up) previously surfaced as an uncaught
  error. `Store.semanticSearch` now catches any embed()-time failure and
  reports it honestly, same shape as "no provider configured."
- **Blank/whitespace-only notes are excluded from the embed pipeline** —
  they have nothing embeddable, so both the staleness plan (chunker output
  is filtered before it reaches the provider) and the backfill sweep's
  candidate query now skip them. Without this, a blank note would stay
  "pending" forever (never gets a vector row) and the sweep would re-select
  it — and re-call the provider with empty input — every `sweepIntervalMs`.

### Notes

- **`package.json` gains `trustedDependencies: ["onnxruntime-node",
  "protobufjs"]`** — required for the bundled floor provider's native ONNX
  Runtime binary postinstall to run on a fresh `bun install` without a
  manual `bun pm trust` step. Verified working end-to-end under bun 1.3.13
  (both the isolated dependency and, live, a fresh vault install reporting
  `embeddings: {enabled: true, provider: "onnx-transformers"}` with zero
  operator action).
- Portability is unaffected: vectors are derived data, never exported, never
  in portable-md — a door switch or re-import just re-embeds.
- Cloud twin (C2, Workers AI) and the live quality re-measurement on
  Aaron's real vault (V2-live) follow in separate PRs/ops steps.

## [0.7.3-rc.1] - 2026-07-16

**Cross-door contract-consistency fixes (V1 of the vault↔cloud contract-drift
brief).** Five findings from a read-only drift audit comparing this door
against parachute-cloud's REST port, each closed here in shared `core/` (so
both doors inherit the fix) or `src/` where door-specific.

### Fixed

- **`metadata` is now always present on the wire, never an absent key** —
  `core/src/notes.ts` `rowToNote` collapsed a NULL/`"{}"`/unparseable
  `metadata` column to `undefined`, which `JSON.stringify` then drops
  entirely from the response. A note with no metadata now reads back with
  `metadata: {}` instead — matching `tags`, which has always been
  unconditionally present (`[]`). This was a real third-party crash: a
  client assuming `note.metadata` exists breaks the moment it hits a
  metadata-less note. **Wire-visible change** — additive (a key that used
  to be absent is now present-and-empty), but flagged since it changes
  observable response shape on a door with real users. Covers REST
  (single/list/search), MCP `query-notes`, and the underlying
  create/update/get paths (all funnel through `rowToNote`).
- **`?search=x&offset=N` now warns instead of silently returning page 1** —
  full-text search has no offset parameter at all (FTS5 ranks by relevance,
  not a stable row order), so `offset` alongside `search` was a silent
  no-op on both REST and MCP. It now surfaces an `ignored_param` warning via
  the existing warnings channel (`X-Parachute-Warnings` / MCP inline
  `warnings`) — results are unchanged; the structured-query path's real
  offset support is unaffected. A hard-400 upgrade was considered and
  deliberately deferred (behavior-visible on a real-users surface).
- **Bearer scheme casing is now RFC 7235 case-insensitive** — `Authorization:
  bearer <token>` / `BeArEr <token>` now authenticate identically to the
  canonical `Bearer`. The auth-scheme token itself is case-insensitive per
  spec; only the credentials that follow stay case-sensitive.
- **Scribe (transcription) discovery no longer requires a vault restart to
  notice scribe** — `src/scribe-discovery.ts`'s URL cache was
  process-lifetime (computed once at first call, reused forever). Scribe
  installing, moving, or starting after vault has already booted was
  invisible until the next restart. Replaced with a 30s TTL: cheap enough
  to redo (an env read + a `services.json` stat) that steady-state cost is
  negligible, while a scribe appearing mid-process is picked up within the
  TTL window with no restart.
- **Unsorted list queries that hit their `limit` now carry a `truncated`
  warning** — the REST/MCP structured-query default order is `created_at
  ASC` (oldest first) with no `?cursor=`; hitting the limit with no
  pagination signal silently truncates the NEWEST notes with zero
  indication anything was cut. A `results.length === limit` non-cursor list
  now warns (`"N = limit rows returned; there may be more. Pass ?cursor= to
  page, or sort=desc for newest-first."`) via the same warnings channel.
  Cursor-mode queries are exempt (`next_cursor` is already the honest
  signal). This is a heuristic, not a precise "more rows exist" guarantee —
  it can't distinguish "exactly `limit` rows exist" from "capped, more
  follow" without a lookahead query, and the message says "may," not "are."
  The REST default-sort flip to `desc` is a separate, deliberately deferred
  breaking-adjacent change. **MCP consumers note:** warnings ride the
  pre-existing `{notes, warnings}` envelope on non-cursor `query-notes`
  (the #550 three-variant contract) — previously rare, this envelope is now
  ROUTINE, arriving whenever a default page fills (any `limit`-sized result,
  e.g. 50 notes on a ≥50-note vault). Programmatic MCP consumers that
  assume a bare array will hit it immediately; handle both variants. REST
  is unaffected (warnings stay in the `X-Parachute-Warnings` header; body
  shape unchanged).

See the contracts-brief PR description for full file:line evidence per
item. A matching mirror + conformance-pin PR lands in parachute-cloud
(C1) once this reaches `@rc`.

## [0.7.2] - 2026-07-11

**Round-4 reliability release — promoted to `@latest`.** Consolidates rc.1–rc.7
(a bug-hunt → fix → real-agent-harness arc), each detailed below. Headline
fixes, all with regression tests and confirmed working in a persona-harness
round (Sonnet-5 agents doing real work, every claim verified against REST):

- **Cursor pagination no longer skips notes on aged/imported vaults** (P0) — the
  `(updated_at, id)` keyset moved onto an integer `updated_at_ms` mirror (rc.2);
  `date_filter`/`order_by`/`export --since` follow (rc.6).
- **Import/export data-integrity** — `--blow-away` import is atomic; note paths
  with NUL/`..` are rejected and can't brick an export; duplicate-id imports are
  reported, not silently dropped (rc.3).
- **Wikilink resilience** — deleting then recreating a target re-heals inbound
  `[[links]]` across all four resolution legs (path/basename/title/extension);
  malformed requests return a clean 400, not a 500 (rc.4).
- **Typed reference fields** — `cardinality:"many"` arrays build real graph
  links, and declaring a reference field backfills links for notes that already
  carry the value (rc.5).
- **Transport** — malformed uploads return 400; an explicit request-body ceiling
  (rc.7).

Onboarding-guide polish (from the harness): the seeded Getting Started guide now
tells a connecting AI to **capture a first note from what the person already
said before asking for more** (a first session shouldn't end with an empty
vault), and to **prefer tag-specific field names** (field names are global
across the vault, so a shared `rating` across tags with different types
collides).

No manual migration — schema upgrades (through v26) run automatically on first
boot. See `UPGRADING.md` for the 0.7.1 → 0.7.2 notes.

## [0.7.2-rc.7] - 2026-07-11

**Fix (low-severity transport robustness): the two leftovers from rc.4's
request-body hardening (#590), tracked as #588.**

### Fixed

- **`POST /upload` with a malformed or non-multipart body now returns a
  clean `400`, never a generic `500`.** `req.formData()` was called
  uncaught — a bad multipart boundary, a truncated body, or a body sent
  with a non-multipart `Content-Type` threw past the handler into the
  server's generic top-level catch, the same `{"error": "Internal server
  error"}`-with-no-`error_type` gap rc.4 fixed for `req.json()` on the
  JSON-bodied routes. It's now caught and returns `400 invalid_request`
  (the existing "wrong/unusable request-body shape" taxonomy entry — no new
  `error_type` introduced). A well-formed multipart body missing the `file`
  field keeps its existing `400 missing_required_field`; a normal upload is
  unaffected.

- **`Bun.serve` now sets `maxRequestBodySize` explicitly (120MB), instead of
  relying on Bun's unconfigured 128MB default.** The JSON-body cap
  (`MAX_JSON_BODY_BYTES`, 10MB) checks `Content-Length` before parsing, but
  a chunked request with no `Content-Length` header falls through to the
  post-parse backstop — which still means the transport buffered the whole
  body into memory first. The only thing standing between that and Bun's
  default ceiling was an accident of Bun's default happening to exceed
  `MAX_UPLOAD_BYTES`, not a deliberate configured limit. `MAX_REQUEST_BODY_BYTES`
  (`src/routes.ts`) is now `MAX_UPLOAD_BYTES` (100MB, the `/upload`
  app-level cap) + 20MB headroom for multipart overhead, and is wired
  explicitly into the `Bun.serve(...)` config in `src/server.ts` — a
  legitimate max-size attachment upload is never capped below its own
  app-level limit, and the transport now rejects an oversized chunked body
  before it fully buffers rather than depending on an unstated default.

## [0.7.2-rc.6] - 2026-07-11

**Fix (P1 correctness): date-range filtering, sorting, and incremental
export by update-time are now correct on imported/aged vaults** — closes
#585, the round-4 follow-up to rc.2's cursor fix (#586). rc.2 gave the
cursor keyset a single integer source of truth (`notes.updated_at_ms`)
because the TEXT `updated_at` column is stored **verbatim** on import —
non-canonical forms like space-separated `2024-11-02 14:30:00`, a `+02:00`
offset, or a missing `Z` sort/compare WRONG lexicographically. Three other
`updated_at` consumers were still comparing that TEXT column directly and
are fixed here the same way:

- **`date_filter: { field: "updated_at" }` range queries** now compare the
  integer `updated_at_ms` mirror instead of the TEXT column. A bound
  (`from`/`to`) is converted to milliseconds with the same UTC-correct
  parser the cursor uses before binding, so a range query against a
  non-canonical `updated_at` no longer mis-includes or mis-excludes rows
  around the boundary. `date_filter` on `created_at` is unaffected — it has
  no ms mirror and keeps its existing (canonical-timestamp-only) TEXT
  compare.
- **`order_by: "updated_at"` now works, and is correct from day one.**
  Previously `updated_at` (like `created_at`) was rejected outright with
  `FIELD_NOT_INDEXED` — a real column, not a declared-indexed metadata
  field, so it never reached a sort at all (this was documented,
  intentional behavior, not a silent mis-sort — see the REST/MCP doc-audit
  entry below). It's now a pseudo-field, alongside the existing
  `order_by: "link_count"`: no `indexed: true` declaration needed, ordered
  on `updated_at_ms` with `id` as the stable tiebreaker.
- **`export --since <iso>` (incremental export) now compares by ms**
  instead of a TEXT `>=` on the stored `updated_at`, so a poll/watch cycle
  against an aged/imported vault no longer silently drops or double-ships
  notes around the `--since` boundary.

Every write path already kept `updated_at_ms` in lockstep with `updated_at`
(rc.2) — this release is purely about pointing the three remaining readers
at the column that's already been the source of truth since rc.2. No schema
change, no migration; `updated_at`, note IDs, and every response shape are
unchanged.

Docs updated for contract accuracy: `docs/HTTP_API.md` and the `query-notes`
MCP tool description no longer say `order_by=updated_at` errors — it's now
a documented, working pseudo-field like `link_count`.

## [0.7.2-rc.5] - 2026-07-10

**Typed reference fields grow up: one-to-many links + retroactive backfill**
— closes gaps #2 and #3 from `docs/design/typed-reference-field.md` (round-4
bug hunt, LB8). `type: "reference"` schema fields were shipped for the
single-target case only; this closes the two gaps that made a multi-target
or declared-after-the-fact reference field silently lie about the graph.

### Fixed

- **`cardinality: "many"` reference fields now build real graph links.** A
  field declared `{ type: "reference", cardinality: "many" }` (e.g.
  `collaborators: ["carol", "dave"]`) was stored and indexed like any other
  metadata, but the auto-link sync's `typeof value === "string"` guard
  silently skipped every array value — the note read as connected in its
  metadata but had zero edges in the graph. Array values now get ONE link
  per element (same `relationship` = the field name, one row per resolved
  target — the `links` table's own `UNIQUE(source_id, target_id,
  relationship)` naturally handles duplicate elements resolving to the same
  target). Updating the array **reconciles** the edges to match the new
  value: it resolves the whole new array to a set of target notes, drops
  every edge that's no longer among them, and (re-)creates the rest — an
  unchanged element keeps its original `created_at`. Reconciling on resolved
  targets (not on the raw strings) means the tricky cases come out right: a
  dropped element whose target was renamed since still gets its stale edge
  cleaned up; and two entries that point at the same note (say a path and
  its title) keep the shared edge as long as one of them survives. An
  element with no matching note yet queues exactly like a scalar reference
  and backfills automatically the moment a matching note is created; an
  ambiguous element (matches ≥2 notes) is neither linked nor guessed at,
  same as the scalar contract. A self-referencing element creates a
  self-loop link, matching the (unguarded) scalar behavior.

- **The spurious `type_mismatch` warning on valid `cardinality: "many"`
  reference writes is gone.** Validation's `reference` type check only ever
  accepted a bare string, so every conforming array write — exactly what
  `cardinality: "many"` asks for — fired a self-contradictory
  `"'collaborators' should be reference, got array"` warning. The type
  check now validates per-element (every array entry must be a string) when
  `cardinality: "many"` is declared, instead of rejecting the array shape
  outright.

- **`update-tag` backfills links for notes that already carry a reference
  value — for the whole tag, and re-declaring heals.** Previously, a tag
  gaining a `type: "reference"` declaration AFTER notes already had matching
  metadata values left those notes unlinked — only a future write touching
  the field would sync it. `update-tag` (and REST's `PUT /api/tags/:name`,
  the same underlying chokepoint) now walks **every** note carrying the tag
  or a descendant and creates the missing links for the declared reference
  field(s) — scalar or array, resolved or queued-for-backfill. Two things
  make this trustworthy at scale: the walk is **unbounded** (an earlier cut
  silently stopped at the first 100 notes, so a large tag stayed
  half-linked), and it fires for **any** reference field in the tag's
  schema — so **re-declaring an already-reference field HEALS** notes whose
  links were never built (e.g. a vault upgraded from before one-to-many
  links worked), which is exactly what the upgrade guide tells operators to
  do. The backfill is purely **additive and idempotent** — it only ever
  creates missing links, never deletes, so re-running it (or declaring an
  unrelated field) never churns or drops an already-correct edge — and it
  runs in the **same transaction** as the schema write, so if the walk fails
  the schema change rolls back and a retry starts clean rather than leaving
  a reference field whose links silently never built. Scoped to the field(s)
  the call declared reference, so declaring a reference field on one tag
  never disturbs an unrelated reference field on another tag the note also
  carries.

## [0.7.2-rc.4] - 2026-07-10

**Runtime-robustness hardening** — four fixes (two P1, two minor) from the
round-4 bug hunt, continuing rc.3's data-integrity pass. These are about a
vault staying honest and recoverable during ordinary agent use — deleting
and recreating notes, malformed requests, self-referential taxonomy data,
and a confusing dead-end error message.

### Fixed

- **A deleted-then-recreated note now re-links to everything that pointed at
  it.** If note A contained `[[Foo]]`, Foo was created (the link resolved),
  then Foo was **deleted and recreated**, A's link used to stay permanently
  dead — even though A's `[[Foo]]` text never changed. Deleting a note only
  dropped the `links` row (via the database's cascade); nothing told the
  wikilink system "this edge is pending again," so recreating Foo had
  nothing to resolve against. Only re-saving A itself (forcing a fresh
  content parse) recovered the link. Deleting a note now re-queues every
  inbound `[[wikilink]]` edge that pointed at it as pending, so recreating a
  note that the original `[[link]]` resolves to auto-heals the edge exactly
  as if it had never resolved — matching the documented "unresolved links
  auto-resolve when the target is created" contract. This covers path,
  basename, H1 **title**, and the `[[Foo.csv]]` **extension** form — because
  deferred resolution now runs each pending link through the *same* resolver
  used when a note is saved. (One rare edge remains: a non-ASCII title
  differing only in letter case re-heals on the source note's next save
  rather than on the target's recreate.)
  (That closes a pre-existing gap beyond delete/recreate: a `[[John Doe]]`
  that resolves by a note's H1 title, or a `[[budget.csv]]` by extension,
  now also backfills correctly when its target is created *after* the
  referencing note.) An ambiguous target (two notes now share the path or
  title) stays a visible broken link rather than resolving to a guess.
  Hand-authored typed `links` (not content-parsed wikilinks) are left
  untouched, by design.

- **Malformed or wrong-shaped request bodies now get a clean `400`, never a
  generic `500` or a silently-created blank note.** Several REST write
  routes (`POST /notes`, `POST /notes/:id/attachments`, `PATCH
  /notes/:idOrPath`, `PUT /tags/:name`, `PATCH /vault-info`) parsed the
  request body with a bare, uncaught `req.json()` — malformed JSON threw
  past the handler into the server's generic top-level catch, returning
  `{"error": "Internal server error"}` with no `error_type` an agent could
  branch on (unlike the already-hardened `/tags/merge` and
  `/tags/:name/rename` routes, which returned a clean `400`). Worse, a
  syntactically-valid but wrong-shaped body — `null`, a bare number, or an
  empty array — either threw a raw `TypeError` or sailed through as
  `undefined`, silently creating a blank note or a no-op update. Every one of
  these routes now shares one hardened body parser: **unparseable** JSON
  returns `400 invalid_json`; a **wrong-shape** body (valid JSON that isn't
  the expected object) returns `400 invalid_request` (the same taxonomy the
  `/tags/merge` shape errors use); and a request body over 10MB is rejected
  with `413 payload_too_large` instead of reaching the store unbounded
  (closing a memory-DoS class — a single oversized `content` field used to
  sail straight through).

- **`doctor` now catches a tag that lists itself as its own parent.** The
  taxonomy-integrity scan's cycle check missed the degenerate case of a tag
  whose `parent_names` names itself directly (`X → X`) — reachable only
  through guard-bypassing data (a direct database write or an import), since
  normal tag writes already reject this. The scan now flags this bare
  self-reference the same as any other cycle.

- **A clearer error when you try to sum a decimal field.** Declaring an
  indexed field as `type: "number"` (a float) and then trying to `sum` it in
  an `aggregate` query, filter it with an operator, or `order_by` it used to
  fail with the generic "declare `indexed: true`" hint — advice that's
  **impossible to follow** for a `number` field, since only `integer`/
  `boolean` fields can ever be indexed. The error now says so directly and
  points at the real fix: store the value as an integer (e.g. cents instead
  of dollars) and index that field instead.

## [0.7.2-rc.3] - 2026-07-10

**Data-integrity hardening** — three import/export/path fixes from the
round-4 bug hunt. Each targets a way a single bad note or a mid-restore
failure could lose or corrupt data.

### Fixed

- **Blow-away import is now atomic — a failed restore no longer empties
  your vault.** `parachute-vault import --blow-away` (the disaster-recovery
  path) wipes the target vault before replaying the export. Previously the
  wipe and the replay ran with **no enclosing transaction**: if any note
  failed to replay partway through (two exported files claiming the same
  `path`, a malformed record, a crash), the vault was left **wiped and only
  partially restored — the originals gone for good.** The wipe + the entire
  replay now run inside **one transaction**, so any mid-replay failure rolls
  back to the exact pre-import vault. (Additive, non-blow-away imports were
  never destructive and are unchanged.) Under the hood the transaction seam
  (`core/src/txn.ts`) gained SAVEPOINT-based re-entrancy so the replay's own
  transactional writes compose inside the outer wrap.

- **Notes with illegal paths are rejected instead of silently breaking
  export.** A note path containing a **NUL byte** or a **`..` segment** is
  now refused at write time (REST + MCP `create`/`update`) with a clear
  `invalid_path` validation error (HTTP `400`). A NUL-in-path note used to
  slip the export's path-traversal guard and then crash the file write —
  **aborting the entire vault export for every note**, so any write-capable
  token could permanently break backup/export for everyone. As a belt for
  vaults that already hold such a row, the export sink now **skips an
  unwritable file with a warning + a skipped-note stat** rather than
  aborting the whole export. (Legitimate paths — including ones containing
  dots or characters like `:`/`?` — are unaffected; only NUL and `..` are
  rejected.)

- **Duplicate-id imports are reported, not silently dropped.** When two
  files in a portable-md export declared the **same note `id`**, the import
  silently kept the last one and discarded the first (data loss folded into
  the "updated N" count); a whitespace-only id was accepted as a real key.
  The import now keeps the **first** of any id collision (deterministic —
  files are walked in sorted path order), **skips and reports** the
  duplicate and any blank/whitespace-only id via a new `skipped_duplicate_ids`
  stat (surfaced in the CLI import summary and the mirror import result),
  and warns per file.

## [0.7.2-rc.2] - 2026-07-10

**Fix (P0 correctness): aged/imported vaults silently skipped notes in cursor
pagination — fixed.** The `query-notes` cursor (the "what changed since I last
polled" agent-memory primitive) ordered its keyset three different ways that
only agreed when every `updated_at` was a canonical `.toISOString()` string.
Import preserves frontmatter timestamps verbatim, so vaults that were imported
or carry aged rows commonly hold non-canonical `updated_at` (space-separated
`2024-11-02 14:30:00`, a `+02:00` offset, or a missing `Z`) — and under those,
the three orderings diverged: notes were silently skipped, offset-form rows
could re-deliver in a loop, and an unparseable timestamp could 400 the whole
walk. A paginating client could miss a large fraction of its notes with no
error.

The fix makes cursor ordering a single integer: a new **`updated_at_ms`**
column on `notes` is the one source of truth the keyset walk-order, boundary
predicate, and watermark all read, so they can no longer disagree.

- **Schema v26 migration (`migrateToV26`).** Adds `notes.updated_at_ms
  INTEGER`, a `(updated_at_ms, id)` index, and backfills every existing row
  from its `updated_at` with a **UTC-correct** parse (the previous watermark
  read space-form timestamps in *local* time — a whole-hours error). A
  genuinely unparseable value falls back to the row's `created_at`, then to a
  stable sentinel — never NULL, never a throw. The ALTER + backfill run in one
  transaction (crash-safe: a partial backfill rolls back and re-runs cleanly on
  the next boot). The backfill is **self-healing** — it runs whenever any row
  carries a NULL `updated_at_ms`, not only when the column is first added, so a
  schema-v2-era upgrade (whose `INSERT…SELECT` leaves the column NULL) is
  repaired rather than left permanently invisible to the keyset.
- **Opaque + backward-compatible.** `updated_at_ms` is an internal ordering
  key; note IDs, `updated_at`, and every response shape are unchanged.
  Cursors already encoded their watermark in milliseconds, so **cursors minted
  before this release keep resuming correctly** — no client action needed.
- Every write path (create, update, import/restore, tag-rename cascades)
  now maintains `updated_at_ms` in lockstep with `updated_at`.

## [0.7.2-rc.1] - 2026-07-10

**Scope-honest onboarding.** The seeded "Getting Started" guide and the
default vault description (`core/src/seed-packs.ts`) were written before the
0.7.1 permissions re-tier and still told a connecting AI it could `update-tag`,
`delete-tag`, and rewrite the vault description under `write` scope — all now
`admin`. A `write`-scoped agent (the "author content, don't restructure" grant
0.7.1 exists to make meaningful) would follow the guide and hit opaque
`Unknown tool` walls. This corrects the facts and makes the guide
scope-aware:

- The "Core moves" tool list is now grouped by the scope each tool needs
  (read / write / admin), so the guide no longer misrepresents what a
  non-admin token can call.
- A new **"What your scope allows"** section names the three tiers and tells
  the agent what to do when a tool is above its tier — surface the gap to the
  person ("I can add notes, but reorganizing your tags needs admin") instead
  of failing silently. Turns the tool-catalog's no-leak filtering from a dead
  end into a graceful elevation prompt.
- The schema-declaration and "close the loop: describe the vault" steps, and
  both default descriptions, now flag their `admin`-scope requirement inline.

Seed content only — create-time and idempotent, so existing vaults are
unaffected (their already-seeded guide is agent-editable). No schema or wire
change.

## [0.7.1] - 2026-07-10

**Launch integration** of eight feature branches (#572–#579) into one
release — ULIDs, MCP scope re-tier + REST-door completion, search/doctor
polish, the `vault-info` front door, aggregation, typed reference fields,
title-fallback link resolution, and honest link warnings. All eight touch
overlapping surface (`core/src/wikilinks.ts`, `core/src/store.ts`,
`core/src/mcp.ts`) and are reconciled here into one coherent whole rather
than eight sequential PRs — see the PR description for the reconciliation
approach on the two highest-risk overlaps (the wikilinks resolution chain,
and `resolveOrQueueLink`'s discriminated-union return type vs. the
reference-field auto-linker that was written against its old signature).

### Breaking — re-tier read/write/admin across BOTH doors (MCP + REST)

Deliberate, ratified scope-model change: content-authorship (`write`) is now
separate from structure/taxonomy/schema-curation (`admin`). No new scope —
the `read`/`write`/`admin` vocabulary is unchanged, only which tier each
tool/endpoint requires moves, and — new in this integration — the MCP and
REST doors are made to **agree** on every one of these moves (previously
only MCP was re-tiered, leaving REST on the old, looser tier — a real gap:
a `vault:write` token could rename/merge/delete/update a tag over REST
while MCP already refused it).

- **`update-tag`, `delete-tag`, `rename-tag`, `merge-tags` (MCP) and
  `PUT`/`DELETE /api/tags/<name>`, `POST /api/tags/merge`,
  `POST /api/tags/<name>/rename` (REST): `write` → `admin`.** These
  define a tag's schema (description, indexed-field types, relationship
  vocabulary, hierarchy parents) or restructure the tag graph across every
  note carrying it — structure, not content. **BREAKING:** a token holding
  only `vault:write` that used to be able to rename/merge/delete/update a
  tag now gets `insufficient_scope` (REST: `403` with
  `required_scope:"vault:admin"`; MCP: the tool disappears from
  `tools/list` and `tools/call` returns `Unknown tool`) and needs
  `vault:admin`. `create-note`/`update-note`/`delete-note` and
  `POST`/`PATCH`/`DELETE /api/notes` are unaffected — content authorship
  stays `write` on both doors. The REST-side gate lives in the generic
  method→verb scope check in `src/routing.ts` (an `isTagSchemaMutation`
  carve-out alongside the pre-existing `isReadOnlyPost` one for
  `/tags/<name>/conformance`, which stays `read`).
- **`vault-info`'s description-update branch (MCP): `write` → `admin`.**
  The tool's own `requiredVerb` stays `read` (so read-only callers keep the
  stats/map projection), but the inner scope check performed when a caller
  passes `description` (`overrideVaultInfo` in `src/mcp-tools.ts`) now
  requires `vault:admin` — writing the vault's own description/config is
  curation, the same tier as the tag-schema tools above, not content.
  **BREAKING:** a `vault:write`-only caller passing `description` now gets
  `Forbidden` (previously succeeded). REST's `PATCH /api/vault` config-write
  path is unaffected by this specific branch (already gated elsewhere).
- **`doctor` (MCP tool) and `GET /api/doctor` (REST): `admin` → `read`.**
  It's a read-only, tag-scope-restricted diagnostic (already re-run against
  the caller's tag allowlist — `applyTagScopeWrappers` in
  `src/mcp-tools.ts` for MCP, the `doctorTagScope` threaded into
  `handleDoctor` for REST) — read-scoped monitoring/tending jobs need to be
  able to run it without an admin credential, on either door. A
  `vault:read` token can now call `doctor` over MCP AND `GET /api/doctor`
  over REST (previously `Forbidden` on both, then only fixed on MCP by the
  source branch — this integration completes the REST side, which is the
  security-completeness fix called out in the PR description). The REST
  gate moved from a hardcoded `admin` check in the early
  "`/api/doctor` dispatched before the generic gate" block in
  `src/routing.ts` to the same block, now checking `read`.
- **`prune-schema` and `manage-token` are unchanged** — both stay `admin`
  on MCP (destructive schema maintenance / token minting, operator-only;
  no REST equivalent exists for either).

Updated: MCP tool descriptions + inline scope comments (`core/src/mcp.ts`,
`src/mcp-tools.ts`), REST scope gate + doc comments (`src/routing.ts`),
`docs/auth-model.md` (scope vocabulary, the per-vault endpoint table now
listing the tag-mutation/doctor rows individually instead of a lumped
`POST/PUT/DELETE → write` row), and `docs/HTTP_API.md` (the four tag-schema
endpoint headers, the `/api/doctor` header, and the MCP tool → verb table —
the REST/MCP `doctor` divergence noted in earlier drafts of this PR is now
**resolved**, not just documented).

Tests: MCP — 7 in `src/vault.test.ts`'s `tools/list`/`tools/call`
scope-tier suite (`vault:write` can `create-note` but is denied
`rename-tag`/`merge-tags`/`delete-tag`/`update-tag`; `vault:read` can run
`doctor`; `vault:write` is denied the `vault-info` description write;
`vault:admin` can do all of the above), plus tool-count assertions (read
tier: 5 tools incl. `doctor`; write tier: 8 cumulative; admin tier: 14
total). REST — 5 new in `src/routing.test.ts`'s "scope enforcement on
`/api/*`" describe block, mirroring the MCP suite exactly: a `vault:write`
token can `POST /api/notes` but is denied `PUT`/`DELETE /api/tags/<name>`,
`POST /api/tags/merge`, and `POST /api/tags/<name>/rename` (each `403` with
`required_scope:"vault:admin"`, and the tag itself is left untouched); a
`vault:read` token can `GET /api/doctor` (`200`, `{findings, summary}`); a
`vault:admin` token can do all of the above; a `vault:write` token can
still `GET /api/doctor` via `write ⊇ read` inheritance; a `vault:read`
token is denied `PUT /api/tags/<name>`.

### Added

- **Aggregation / rollup queries — `group_by` + count/sum** (top
  new-feature ask from a UX round). `query-notes`'s
  `aggregate: {group_by, op, field?}` (MCP) and
  `GET /notes?aggregate[group_by]=…&aggregate[op]=…&aggregate[field]=…`
  (REST) apply every OTHER filter (tag, metadata, date range,
  write-attribution, ...) exactly as a normal query would, then group the
  matching notes and return `[{group, value}]` instead of note rows.
  `group_by` is either the special value `"tag"` (group by tag membership —
  a note carrying N of the matched tags contributes to N groups) or an
  indexed metadata field — same `FIELD_NOT_INDEXED` contract
  `meta[field][op]=` operators and `order_by` use. `op: "sum"` requires a
  second indexed NUMERIC field (`type: "integer"`/`"boolean"`; a bare
  `type: "number"` field is never indexed and can't be summed). A note
  missing the `group_by` value collects into one `{group: null, ...}` row
  rather than being silently dropped. Mutually exclusive with
  `search`/`near`/`cursor`. Tag-scoped tokens see the rollup computed only
  over notes they can see — AND, under `group_by: "tag"`, group NAMES are
  scrubbed to the allowlist too, closing a leak class the naive
  note-level narrowing alone would have missed: a note visible via one tag
  but also carrying an out-of-scope co-tag can't surface that co-tag as a
  group. Core (`core/src/notes.ts`, `store.ts`'s new `aggregateNotes`)
  computes the rollup via SQL `GROUP BY` over the shared filter-condition
  builder extracted from `queryNotes`; server-layer scope enforcement
  mirrors the `expandVisibility`/`nearTraversable` predicate-injection
  pattern (MCP) and the existing `filterNotesByTagScope` post-query filter
  (REST). See `docs/HTTP_API.md`'s "Aggregation / rollup" section. Tests:
  `core/src/aggregate.test.ts`, `src/aggregate-routes.test.ts`,
  `src/mcp-query-notes-aggregate-scope.test.ts`.

- **Typed reference field — indexed value + auto-link.** A new tag-schema
  field type, `type: "reference"`, collapses a pattern builders were
  hand-syncing: an indexed string value AND a structured `links` edge to
  the same target, kept in agreement by hand. Declaring a field
  `type: "reference"` makes it dual-write: the value is stored + validated
  exactly like `string` (an id/path/title), and `create-note`/`update-note`
  (both MCP and REST — the shared `core/src/store.ts` write-path
  chokepoint, `syncReferenceFieldLinks`) additionally resolve that value to
  a note and maintain a graph `links` edge from this note to it,
  `relationship` = the field name — reusing the same id/path/title
  resolution and lazy forward-ref queueing that structured `links` entries
  use (`resolveOrQueueLink`). Changing the field's value re-points the
  link; clearing it drops the link; an unchanged value is left untouched
  (no DB churn on unrelated writes). An ambiguous resolution (≥2 matching
  notes — see the title-fallback and honest-link-warnings entries below)
  is treated the same as a miss: no link created, nothing queued. Declare
  `indexed: true` alongside `type: "reference"` for a B-tree index over the
  raw value (operator queries `eq`/`in`/...); a plain metadata-equality
  filter already works on any field regardless of `indexed`. Scalar values
  only in this release — see `docs/design/typed-reference-field.md` for
  the full design and known gaps (no inline `unresolved_link` warning yet
  on the reference-field write path itself, `cardinality: "many"`
  reference arrays don't link, no retroactive backfill when a tag gains
  the declaration). Tests: `core/src/core.test.ts`'s reference-field
  suite, `core/src/indexed-fields.test.ts`,
  `core/src/contract-typed-index.test.ts`, `src/contract-errors.test.ts`.

- **Title-fallback resolution for `[[wikilinks]]`, structured `links`, and
  note-id lookup.** Top friction from a UX round: a note's H1 title (its
  `# Heading`) commonly differs from its path/basename, so a natural
  `[[Some Title]]` link — or `query-notes { id: "Some Title" }` — silently
  broke even though a human reading the note would call it exactly that.
  Additive, last-resort fallback: exact id/path/basename resolution is
  unchanged and always wins first; only on a CLEAN miss (zero candidates,
  not an ambiguous one) do we try matching the note whose first `# `
  content line equals the target, case-insensitively. Resolves only when
  EXACTLY one note carries that title — two-or-more is **ambiguous** (see
  the honest-link-warnings entry below), never a silent guess, mirroring
  the existing basename-ambiguity policy (vault#328).
  - New in `core/src/notes.ts`: `extractH1Title` (first `"# "` line in a
    note's content) and `findNotesByTitle`/`getNoteByTitle` (title →
    note(s), case-insensitive, full-content scan — a fallback path reached
    only after the cheap indexed lookups already missed).
  - `core/src/wikilinks.ts`: `resolveWikilink`/`resolveWikilinkDetailed` try
    the title match as step 4, after explicit-extension, exact-path, and
    basename all miss cleanly — a ≥2-title-match returns `ambiguous: true`
    from `resolveWikilinkDetailed`, never a silent resolve.
    `resolveLinkTarget`/`resolveLinkTargetDetailed`/`resolveStructuredLinkNote`/
    `resolveOrQueueLink` (structured `links` resolution) inherit the
    title-fallback (and its ambiguity handling) for free since they all
    delegate to `resolveWikilinkDetailed`.
  - `core/src/mcp.ts` and `src/routes.ts`: the shared `resolveNote(id/path)`
    helper each transport uses for `query-notes`/`update-note`/`delete-note`
    `id`, `find-path` anchors, and REST
    `GET`/`PATCH`/`DELETE /api/notes/:idOrPath` now falls through to the
    title match after id and path/extension both miss.
  - Docs: `docs/HTTP_API.md` and the relevant MCP tool descriptions
    (`query-notes`/`update-note`/`delete-note` `id`, `links[].target`,
    `find-path` source/target) describe the four-step order
    (id → path[.ext] → basename → title-fallback-on-clean-miss).
  - Tests: `core/src/core.test.ts`'s title-fallback suite,
    `core/src/wikilinks.test.ts` (H1 extraction, single vs. ambiguous title
    match, id/path/basename always winning first, the four-step order end
    to end).

- **Honest unresolved + ambiguous link warnings** (issue #570, P3 polish
  from the rc.9 convergence harness round).
  - **Content `[[wikilinks]]` to a missing target now warn
    (`unresolved_link`) — closing an asymmetry with structured `links`.**
    Before this fix, a `[[wikilink]]` whose target didn't exist queued into
    `unresolved_wikilinks` (same as a structured `links` miss) but fired NO
    write-time warning — the pending state was only discoverable later via
    `has_broken_links`/`include_broken_links` or
    `GET /vault/{name}/api/unresolved-wikilinks`. `create-note`/`update-note`
    (MCP) and `POST`/`PATCH /notes` (REST) now attach an `unresolved_link`
    warning for a content-wikilink miss identical in shape to the existing
    structured-link one (`target`, `relationship: "wikilink"`), and it
    stays out of the response entirely when a call doesn't touch content (a
    tags/links-only update never re-surfaces a warning about content it
    didn't write). New `core/src/wikilinks.ts` export
    `getContentWikilinkWarnings(db, noteId, content)` — read-only, single
    source of truth is `resolveWikilinkDetailed` (the same resolver
    `syncWikilinks` itself now uses), so it can't drift from what the write
    actually did. Batch-aware: a content wikilink to a note created LATER
    in the same batch resolves silently (forward-ref), same timing as
    structured `links`.
  - **A target matching ≥2 notes gets a distinct `ambiguous_link` warning
    instead of the misleading `unresolved_link` "did not resolve to any
    note."** Applies to BOTH a content `[[wikilink]]` and a structured
    `links` entry (one shared resolver — now also feeding the
    title-fallback and typed-reference-field features above). Carries
    `target`, `relationship`, and `candidate_count` (the match count —
    never the candidates' ids/paths, so the warning can't be used to
    enumerate which notes collided). **No edge is created** and the target
    is explicitly **not queued** into `unresolved_wikilinks` either: a
    future note being created can't retroactively resolve an ambiguity
    between two notes that already exist, and queuing it risked the
    lazy-resolution sweep (`resolveUnresolvedWikilinks`) later linking to
    an arbitrary THIRD same-titled note rather than reporting the
    collision. `core/src/wikilinks.ts`: `resolveWikilinkDetailed`/
    `resolveLinkTargetDetailed` are now the single resolution path for
    both content and structured links, INCLUDING the title fallback above
    and the reference-field auto-linker; `resolveOrQueueLink` returns a
    discriminated `{status: "resolved"|"ambiguous"|"queued", ...}` outcome
    (was `string | null`, which couldn't distinguish "ambiguous" from
    "genuinely missing" — both collapsed to `null`); `syncWikilinks` gains
    an `ambiguous` field alongside the existing `added`/`removed`/
    `unresolved` counts.
  - **Scope stance (unchanged, verified).** `unresolved_link`/
    `ambiguous_link` describe the CALLER's own note's own outgoing link
    (named by the caller), not a vault-wide vocabulary scan — unlike
    `unknown_tag`/`did_you_mean`/`search_did_you_mean` (which tag-scoped
    sessions never see), these warnings are NOT stripped for a tag-scoped
    session, matching the existing structured-link `unresolved_link`
    behavior exactly.
  - Core-vs-handler split: `core/src/wikilinks.ts` (resolver + warning
    derivation, shared), `core/src/mcp.ts` (`create-note`/`update-note`
    tools), `src/routes.ts` (independent REST reimplementation of the same
    contract). `docs/HTTP_API.md` updated: the warnings-channel table
    gains `ambiguous_link` and an updated `unresolved_link` entry; the
    "Structured `links` resolution" section states the shared-resolver
    contract and the ambiguous case explicitly.
  - Tests: 6 new in `core/src/core.test.ts`, 11 new in
    `core/src/wikilinks.test.ts`, 5 new in `src/vault.test.ts` (REST
    parity), 4 new in `src/mcp-link-warnings-scope.test.ts` (tag-scope
    stance).

- **`vault-info` gains a `map` field — the front door** — ALWAYS present,
  no flag required. `{ total_notes, tags: [{name, count}], path_buckets:
  [{name, count}], unfiled_notes }`: every tag currently carried by at
  least one note with its membership count (uncapped, unlike
  `stats.topTags`'s top-20), every top-level path segment (the text before
  the first `/`, or the whole path when it has none) among notes that HAVE
  a path with how many notes live under it, and how many notes carry no
  path at all (excluded from `path_buckets`; `unfiled_notes` + every
  bucket's count == `total_notes`). A 2026-07-09 UX round on cold-start
  vaults found the gap: a fresh reader with no prior context had no single
  cheap call that says "here's the shape of this vault" —
  `vault-info`'s existing catalog covered only tags-*with-schemas*, and the
  deeper `getVaultStats` distribution required an extra
  `include_stats: true` round trip and returned more than orientation
  needs. Three cheap grouped-`COUNT` SQL queries — no content, no
  full-table scan — new `getVaultMap` in `core/src/notes.ts`, wired into
  the shared `buildVaultProjection` (`core/src/vault-projection.ts`) so
  both the MCP `vault-info` tool and `GET /vault/{name}/api/vault` return
  the identical shape. `include_stats: true` still adds the deeper
  `VaultStats` distribution alongside `map`, not instead of it.
  Scope-aware: a tag-scoped token's `map` covers only notes reachable
  through an in-scope tag — path-bucket counts RE-RUN the grouped-count
  query restricted to the caller's allowlist rather than filtering an
  unscoped result (per-note tag membership can't be reconstructed from a
  tag-name allowlist over a precomputed rollup); an allowlist matching
  zero tags returns an explicit all-zero map, never the full vault. Getting
  Started (`core/src/seed-packs.ts`) gains a front-door convention: the
  tool-list bullet mentions the always-present `map`; the "if this vault
  already has content" orientation step leads with plain `vault-info`
  before reaching for `include_stats`; a new "A few shapes worth reusing"
  bullet recommends maintaining one human-legible "Map" note (once a vault
  grows past a few dozen notes) as the "why" companion to `vault-info`'s
  auto-computed "what's there" counts. Tests: 9 new in
  `core/src/core.test.ts`, 7 new in `src/vault.test.ts` (3 MCP + 4 REST).

### Changed

- **New note/attachment IDs are ULIDs, not timestamp-format strings —
  existing IDs are NOT migrated.** `generateId()` (`core/src/notes.ts`)
  previously returned `YYYY-MM-DD-HH-MM-SS-ffffff`; it now returns a
  26-character Crockford-base32 [ULID](https://github.com/ulid/spec)
  (48-bit ms timestamp + 80-bit randomness), monotonic within the same
  millisecond so lexicographic order matches generation order under bursty
  writes. Every `generateId()` call site is unchanged — this is a pure
  change to what the single ID source returns, not a new codepath. New
  `core/src/ulid.ts`: a small, dependency-light, hand-rolled generator
  using `crypto.getRandomValues` (Web Crypto, available in Bun) rather
  than `Math.random` — no new npm dependency added.
- **Old timestamp-format IDs are untouched and stay valid forever —
  mixed-format IDs coexist by design.** No migration runs, no backfill,
  nothing rewrites existing rows. A vault's `notes.id`/`attachments.id`
  columns are (and will remain indefinitely) a mix of the old timestamp
  shape and the new ULID shape; every codepath that touches `id` treats it
  as an opaque string (equality, prefix/path resolution, or the cursor's
  `(updated_at, id)` string-compare tiebreaker) — none of which cares
  about the id's internal format.
- **Audit: nothing in the codebase parses a note ID to recover its
  creation time.** Full-codebase grep for id-slicing/splitting/
  date-parsing turned up zero hits outside test fixtures. The only places
  `id` participates in ordering are all `created_at`/`updated_at`-primary
  with `id` as a stable secondary tiebreaker — correct and format-agnostic
  behavior that needed no change. `generateId()`'s doc comment now states
  the invariant explicitly (id format must never be assumed, and nothing
  may derive time from it — use `created_at`).
- Tests: 11 new — `core/src/ulid.test.ts` (format, charset, monotonic
  ordering, no duplicates across 5000 calls) and `core/src/core.test.ts`'s
  `describe("ULID ids for new notes (existing IDs unchanged)")` (new notes
  get ULID-format ids; an explicit old-format id round-trips through
  create/read/link; mixed old-timestamp-format + new-ULID ids sharing one
  `updated_at` paginate via cursor with no miss or duplicate).

### Fixed

- **`search_did_you_mean` now suggests a real surface word, not a porter
  stem** (issue #570). `computeSearchDidYouMean` (`core/src/query-warnings.ts`)
  drew its candidate pool from `notes_fts_vocab` — the porter-STEMMED FTS5
  vocabulary — so a zero-result search's suggestion sometimes read as a
  truncated fragment a user would never type ("cactu" for "cactus"). The
  stemmed vocabulary is still used to find the closest CANDIDATE, but a
  stemmed candidate is no longer returned verbatim: new `resolveSurfaceForm`
  maps it back to a real dictionary word via the matching note's own
  unstemmed text. Irregular cases fall back to the raw stem, same as
  before this fix — never worse.
- **`doctor`'s `dead_tag_metadata_reference` heuristic no longer
  false-positives on schema-declared enum values** (issue #570).
  `scanDeadTagMetadataReferences` (`core/src/doctor.ts`) flags a metadata
  value that matches no live tag when sibling notes' values under the same
  key ARE live tags — but a schema-declared ENUM field whose values merely
  *coincide* with an unrelated live tag name used to drag the enum's OTHER
  legitimate values into a false "stale tag reference" finding. The scan
  now collects every metadata key declared as an enum field on ANY tag
  schema and skips it entirely — an enum is a closed, schema-governed
  vocabulary; drift there already surfaces as `enum_mismatch` validation.
- Docs: `docs/HTTP_API.md` (`search_did_you_mean`'s stemming caveat,
  `dead_tag_metadata_reference`'s enum-skip behavior). Tests: 2 new —
  `src/contract-search.test.ts`, `core/src/contract-taxonomy.test.ts`.

### Gates

Combined, post-integration: `bun run typecheck` clean; `bun test ./core/src/`
1126 pass / 0 fail (35 files); `bun test ./src/` 2206 pass / 1 skip
(pre-existing opt-in `VAULT_SCALE_BENCH` bench suite, unrelated) / 0 fail
(90 files). One integration-only fix folded in: `core/src/core.test.ts`'s
ULID mixed-format cursor-pagination test bootstrapped its first page
without `cursor: ""` (the documented bootstrap contract), which orders
that page by `created_at` instead of `updated_at` and can produce a
watermark that skips rows once real keyset pagination takes over on page 2
— a timing-dependent flake (whether `created_at` ties across the fixture's
notes) surfaced only when run alongside other suites in the same process,
not a defect in `queryNotesPaged` itself. Fixed to bootstrap correctly;
verified stable across repeated runs, isolated and combined.

## [0.7.0] - 2026-07-10

The `0.7.0-rc.1` through `rc.9` chain (below) promotes to stable — the
**Reliability & Usability Program** (umbrella #556, issues #550–#555). Origin:
a 2026-07-09 nine-persona deep test (9 sandboxed agents, 8 fresh vaults, ~230
notes, every claim independently reproduced against the REST API). Verdict:
the storage/concurrency core was already trustworthy — zero server errors,
zero corruption, zero lost writes — while the failure modes concentrated at
the query/taxonomy/error boundaries. Ten waves (rc.1 tests-first, rc.2–rc.9
fixes) closed every finding; a second interim persona-harness round against
the live rc.7 build (rc.8) and an ergonomics/contract-truth pass (rc.9) round
out the train. This entry summarizes by theme; full per-fix detail (code
paths, review folds, exact test counts) lives in the `rc.1`–`rc.9` entries
below — nothing here supersedes them.

### Added

- **Honest query boundary (#550).** A `warnings` channel on `query-notes` /
  `GET /notes` (`unknown_tag` + `did_you_mean`, `removed_param`,
  `empty_search`, `search_did_you_mean`, `ignored_param`, `warnings_truncated`)
  surfaced via REST envelope/`X-Parachute-Warnings` header and MCP's wrapped
  response; structured `invalid_query` errors for bad `limit`/`offset`/date
  filters; cursor bootstrap on an empty-string `cursor` (was previously
  unreachable); `expanded_count` on `list-tags`; `find-path` `nodes`/`edges`
  hydration.
- **Taxonomy integrity (#552).** `rename-tag`/`merge-tags` exposed as MCP
  tools (REST parity); `delete-tag` referential-integrity guard
  (`tag_referenced_as_parent`, with `cascade`/`detach` opt-outs); a
  write-time parent-cycle guard (`parent_cycle`) on `update-tag`; a new
  read-only `vault doctor` scan (MCP tool + `GET /api/doctor`) reporting
  dangling parent references, hierarchy cycles, mixed-type indexed fields,
  orphaned indexed-field declarers, and heuristic dead tag-metadata
  references.
- **Structured error taxonomy (#554).** `error_type` added to ~60 previously
  bare REST error bodies (404s, 405s, malformed JSON, content-edit branch,
  query/cursor/tag validation, and more); full MCP domain-error mapping so
  only genuinely-unknown errors fall through to the unstructured text
  fallback; `update-tag` now collects and reports every invalid field in one
  call instead of failing fast on the first; batch `update-note` honors a
  top-level `force`/`if_updated_at` as a per-item default.
- **Typed indexes (#553).** `migrateToV24` (schema v23→24) losslessly coerces
  existing typed-index poison (a clean numeric string → its number, `"true"`/
  `"false"` → the boolean, etc.) and leaves genuinely non-coercible values in
  place for `doctor` to surface — never deletes or nulls note data.
- **Search recall + ranking (#551).** `migrateToV25` (schema v24→25) rebuilds
  `notes_fts` to index `path` (title) alongside `content`, adds Porter
  stemming, and repopulates from every existing note — all inside one
  transaction (crash-safe, idempotent). bm25 title-weighted `score` on every
  search result; `search_did_you_mean` on a zero-result search.
- **Ergonomics (#555).** `create-note`/`POST /notes` gains `if_exists:
  "error"|"ignore"|"update"|"replace"` for idempotent upsert-on-path-conflict
  (race-closed, not just sequential-safe); `has_broken_links`/
  `include_broken_links` surface dangling wikilink/structured-link targets
  via the `unresolved_wikilinks` table; batch `create-note`/`POST /notes`
  gains a compact `summary: true` response shape; structured `links` now
  resolve exactly like `[[wikilinks]]` (basename/title match + lazy
  forward-ref queueing, same-batch forward-refs included).
- **Contract test suite (rc.1).** Six new test files encode every
  nine-persona finding as an executable contract before any production code
  changed — correct-today behavior locked in as a passing test, broken
  behavior as a `test.todo` naming the tracking issue. All flipped to real
  assertions across rc.2–rc.9.

### Changed

- `updated_at` now bumps on every real mutation, including tags-only /
  links-only `update-note`/`PATCH` calls (previously left frozen when the
  content/metadata `updates` object was empty), `renameTag`'s inline
  content/path rewrites, and `if_exists:"update"` with only tags/links
  changed — closes a class of cursor-polling / `updated_at`-sync gaps.
  `validation_status` now surfaces on reads (`query-notes`, `GET /notes`),
  not just writes.
- MCP tool descriptions (all 13 core-generated tools + `manage-token`) and
  the corresponding `docs/HTTP_API.md` REST sections audited line-by-line
  against actual behavior; several description-only drifts fixed (no
  behavior changes) — see the rc.9 entry for the full list.
- `docs/HTTP_API.md` gained a "Guarantees" section documenting verified
  strong contracts (commit-order under concurrent writers, compare-and-set
  `state_transition`, RFC 7386 metadata merge, never-silent-overwrite create
  races).

### Breaking

- **Search is literal-by-default (#551, rc.3).** `search=` no longer parses
  as raw FTS5 syntax — ordinary punctuation (`didn't`, `18.6`, a bare
  hyphen) now matches as content instead of being misparsed as query syntax.
  A caller relying on raw FTS5 syntax (manual phrase quoting for adjacency,
  boolean operators, prefix `*`) must add `search_mode: "advanced"` to keep
  that exact behavior.
- **Indexed fields reject type-mismatched writes (#553, rc.6).** A write
  whose value's type contradicts an `indexed: true` field's declared type is
  now rejected outright (`422 schema_validation`), independent of the
  field's own `strict` flag — previously only an advisory `type_mismatch`
  warning, and the poisoned value could silently corrupt range queries via
  SQLite's type-affinity sort order. `migrateToV24` (below) cleans up
  existing poison on upgrade.
- **Enum/default backfill is explicit-`default:`-only (#553, rc.6).** The
  old implicit "first enum value / type zero-value" backfill on schema
  application is retired. Only a declared `fields.<field>.default` backfills
  an unset field now — so `metadata: { field: { exists: false } }` is
  finally trustworthy ("never set" vs. "explicitly set to the default" are
  now distinguishable). Future writes only; notes already backfilled under
  the old behavior keep their values.
- **`PUT /api/tags/:name` single-bad-default now 422, was 400 (#553/#555,
  rc.8).** A single invalid `default:` used to fail fast with `400
  invalid_field_default`, silently dropping any other violation in the same
  call. It's now bundled into the collect-all `422 tag_field_conflict`
  response (`violations: [{field, reason: "invalid_default", message}]`),
  matching MCP's already-bundled reporting. Re-key on the 422 + `violations[]`.
- **`GET /api/tags/{name}` on a nonexistent tag now 404, was 200 (#550,
  rc.2).** Previously synthesized an all-null 200 body for a tag with no
  identity row and no notes; now returns a structured `tag_not_found` 404
  (`did_you_mean` when a close match exists).

See [UPGRADING.md](./UPGRADING.md) for the full 0.6.x → 0.7.0 operator
migration guide, including the automatic schema migrations
(`migrateToV24`/`migrateToV25`) and the `unresolved_wikilinks` lazy
self-heal.

### Known limitations / follow-ups

- **0.7.x polish backlog:** tracked at issue #570.
- **@latest-promotion gate:** the hosted door's DO-SQLite backend must run
  the FTS5 v25 spike (parachute-cloud#114) — confirming
  `tokenize='porter unicode61'` and the two-column external-content FTS5
  shape behave identically on Cloudflare's SQLite build — before the hosted
  door pulls this core. Self-hosted (hub/bun) deploys are unaffected; this
  gate is cloud-only and does not block this stable tag.

## [0.7.0-rc.9] - 2026-07-10

### Added — Ergonomics + contract truth (Wave 8b of the Reliability & Usability Program, WS6, #555, umbrella #556)

Additive/ergonomic-only wave — no breaking changes, `if_exists` defaults preserve today's `path_conflict` behavior exactly.

- **`create-note` `if_exists` — idempotent upsert on a path conflict.** New `if_exists: "error"|"ignore"|"update"|"replace"` (default `"error"` — unchanged behavior) on `create-note` (MCP) / `POST /notes` (REST), single and batch. `"ignore"` returns the existing note completely untouched (no mutation, no schema-default backfill) with `existed: true` — the idempotent-retry primitive that closes both the concurrency-tester create-race gap and the agent-memory crash-replay duplicate-side-effect ask in one primitive. `"update"` merges the incoming payload into the existing note (content full-replace if provided, metadata RFC-7386 merged, tags/links additive-union) — mirrors `update-note`'s own semantics. `"replace"` wholesale-overwrites content/metadata (PUT semantics — an omitted field becomes its empty default, not left alone) while keeping id/createdAt and staying additive on tags/links. Race-closed, not just sequential-safe: an INSERT attempt that hits `path_conflict` (a real concurrent writer, not just a pre-check) falls back to the SAME collision-handling branch a proactive check would have taken, keyed off the winning row — a genuine multi-writer create-race resolves to a clean idempotent result instead of an error one side has to retry by hand. `existed` is attached ONLY when an item's own `if_exists` was set to `ignore`/`update`/`replace` — the default `"error"` mode's response shape is byte-identical to before this feature. Batch-aware, per-item (matches `if_missing`'s existing contract on `update-note` — no top-level-to-item inheritance).
- **SECURITY (auth-review CRITICAL, folded pre-merge): `if_exists` is no longer a tag-scope bypass — including under a concurrent-INSERT race.** As first shipped, `if_exists` resolved the target `path` VAULT-WIDE inside scope-unaware core, then returned (`ignore`) / updated / replaced whatever it found — while the only scope gate checked the INCOMING item's own tags, never the resolved existing note. A token scoped to tag `public` could therefore READ (`if_exists:"ignore"`) or OVERWRITE (`update`/`replace`) a note carrying only an out-of-scope tag `secret`, just by naming its path (live exploit reproduced on-disk). Fixed at the scope-aware server layer, keeping core scope-unaware. **REST**: a `noteWithinTagScope` guard at the top of `applyExistingNote` — both the proactive and race-backstop resolution sites funnel through it. **MCP**: an `ifExistsVisible` per-note predicate (same closure pattern as the existing `expandVisibility`/`nearTraversable` scope predicates threaded into core) is injected from `src/mcp-tools.ts` and consulted INSIDE core's `applyExistingNote`, so it covers BOTH the proactive check AND core's concurrent-INSERT race backstop (`core/src/mcp.ts`) with one guard. This is the load-bearing fix: a wrapper-only pre-check (the initial patch) closed the sequential case but left the race-backstop TOCTOU open — auth re-check proved it reachable, leaking a "TOP SECRET RACE PAYLOAD" note to a `public`-scoped caller when both existence checks miss and the real INSERT loses to a concurrent writer's out-of-scope note. An out-of-scope hit is treated as a `path_conflict` — the path is taken, but invisible to this caller — throwing before any read or mutation, byte-identical to a genuine conflict (leaks nothing about *why*). Holds for `ignore`/`update`/`replace`; no-op for unscoped tokens; core stays scope-unaware (only invokes the injected closure). Regression tests on BOTH transports (sequential AND the monkeypatched race path) assert the secret payload never appears in the response AND the out-of-scope note is byte-for-byte unchanged (verified via `store.getNote`); each confirmed to go RED with the guard removed.
- **SECURITY-adjacent correctness (generalist-review CRITICAL, folded pre-merge): `if_exists:"update"` with ONLY tags/links changed now bumps `updated_at`.** Same W8 fix-2 bug class the regular PATCH path already fixed: a tags-only or links-only update left the `updates` object empty, so gating `store.updateNote` on `updates` alone skipped it entirely — the tag/link genuinely mutated (`store.tagNote`) but `updated_at` stayed frozen, breaking cursor polling (`ORDER BY updated_at`) and every `updated_at`-based sync. Both `applyExistingNote` implementations (core + REST) now gate the UPDATE on `Object.keys(updates).length > 0 || incomingTags.length > 0 || !!item.links`, mirroring the existing `hasTagMutation||hasLinkMutation` pattern. `"replace"` always sets content+metadata, so it was never affected.
- **Broken-link surfacing — dangling wikilinks/structured links are queryable and readable.** A `[[wikilink]]` or structured `links` target that never resolved to a note used to be invisible — silently dropped with no signal it existed anywhere outside the one-time `unresolved_link` write warning. New `has_broken_links: true|false` presence filter on `query-notes`/`GET /notes` (backed by the existing `unresolved_wikilinks` table — safe on a vault where the table has never been created: `true` matches nothing, `false` is a no-op, no "no such table" error). New `include_broken_links: true` param surfaces a note's pending targets as `broken_links: [{target, relationship}]` on both single-note and list reads (MCP + REST), batched per page (one query, not N). New `core/src/wikilinks.ts` exports `getUnresolvedLinksForNote`/`getUnresolvedLinksForNotes`.
- **`create-note` batch `summary` — compact response for large batches.** New `summary: true` on a batch (`notes` array) `create-note`/`POST /notes` call returns `{created, ids, failed}` instead of N full note objects — `created` counts brand-new inserts (excludes `if_exists` collisions), `ids` lists every resulting id in order, `failed` is reserved for future partial-batch-failure reporting (always `[]` today — a batch create is all-or-nothing, same with or without `summary`). Ignored on a single-note call.
- **MCP tool description audit (contract truth).** Every MCP tool description (all 13 core-generated tools + `manage-token`), the real `vault-info` behavior (overridden at the server layer), and the corresponding REST sections in `docs/HTTP_API.md` traced line-by-line against actual behavior. Two REAL BUGS in the REST docs (code was already correct — docs-only fixes): `GET /notes`'s `sort=` was documented as ordering by `updated_at` (actually `created_at` outside cursor mode — `updated_at` ordering is cursor-mode-only, and even then `sort=desc` is rejected outright); `order_by=created_at|updated_at` was listed as a valid example (both are native columns, not indexed metadata fields, so both actually 400 `FIELD_NOT_INDEXED` — only a declared `indexed: true` metadata field or the special `link_count` value works). One drift repeated at 3 locations: `include_links=true` was documented as folding OUTBOUND links only; it's actually BOTH directions (inbound + outbound) — matches what the MCP tool descriptions already said correctly. Fixed in `core/src/mcp.ts`: `vault-info`'s shipped description was silent about the always-present `coordinates` field and the conditional `getting_started` pointer (the server-layer override only replaces `.execute`, never `.description`), and silent about needing the `vault:write` scope to update `description` despite the tool's outer `read` gate; `delete-tag`'s description omitted its `tag_in_use_by_tokens` refusal (present in code, and already documented on `merge-tags`' identical guard); `doctor`'s description didn't mention its `{findings, summary, scanned_at}` response envelope; `create-note`'s batch-item schema incorrectly marked `content` as `required` (never enforced — an empty-content batch item has always succeeded). Fixed in `src/mcp-tools.ts`: `manage-token`'s `mint`/`revoke` response sketches omitted real additive fields (`scopes`/`scoped_tags`/`vault_name` on mint; `already_revoked` on revoke). No behavior changed anywhere in this bullet — every fix aligns a description to already-correct code.
- **Documented the VERIFIED strong contracts as a new "Guarantees" section (`docs/HTTP_API.md`).** Real, ground-truth-verified properties of this vault that were previously undocumented selling points: `append`/`prepend`'s commit-order guarantee under concurrent writers (atomic, no precondition needed); `state_transition`'s real compare-and-set semantics (not read-then-write); metadata updates MERGE, never clobber untouched fields (RFC 7386); `path_conflict` on a create race — never a silent overwrite; the `if_updated_at` conflict shape (`current_updated_at`/`your_updated_at`) is a full diagnostic, not a bare 409.
- **Getting Started gains the conventions testers independently reinvented (`core/src/seed-packs.ts`).** New "A few shapes worth reusing" subsection: a journaling shape (`#journal` tag, indexed `entry_date`, `mood` enum), the agent-memory pattern (`#thread` + `#message` notes, the crash-replay-safety recipe using the new `if_exists: "ignore"`), and a one-liner on search (literal by default, `search_mode: "advanced"` for FTS syntax). Kept tight — three short bullets, not a rewrite.
- **Small doc P3s.** Documented that the `exists` metadata operator requires the field to be `indexed: true` (same rule as every other operator — only the plain-shorthand `eq` fallback works unindexed). Reconciled `vault-info`'s stats `tagCount` (`COUNT(DISTINCT tag_name)` over note-tag memberships — excludes zero-membership tags) against `list-tags`'/`GET /tags`'s row count (a `LEFT JOIN` off the `tags` identity table — includes them) in both `docs/HTTP_API.md` and the MCP tool descriptions; not a bug in either, two different questions.
- **`find-path`'s `{id, path}` node hydration (issue #555's "find-path returns paths" item) — already shipped.** Confirmed already delivered in vault#550 (rc.2) before this issue was filed: `find-path`'s `nodes`/`edges` fields already hydrate every id with its `path`. No code change needed; noted here so the issue checklist item isn't mistaken for outstanding work.

Core-vs-handler split: every item above touches both `core/` (the shared MCP-tool logic + `wikilinks.ts`/`notes.ts`/`types.ts`/`cursor.ts` primitives) and `src/routes.ts` (an independent REST-layer reimplementation of the same `if_exists`/`summary`/broken-link contract, sharing the same core primitives — `store.createNote`/`updateNote`/`tagNote`/`getNoteByPath`, `mergeMetadata`, `applySchemaDefaults`, `getUnresolvedLinksFor{Note,Notes}` — so MCP and REST can't drift). Docs-only items (Getting Started, the tagCount reconciliation, the P3s) don't touch `src/`. The two security must-fixes respect the same seam: REST enforcement lives in `src/routes.ts`'s `applyExistingNote` (scope-aware); MCP enforcement is an `ifExistsVisible` predicate injected from `src/mcp-tools.ts` into core's `applyExistingNote` (core stays scope-unaware, only invoking the closure — same pattern as `expandVisibility`/`nearTraversable`), so both the proactive and race-backstop sites are covered. The `updated_at` gate is fixed identically in both `applyExistingNote` copies.

Tests: 56 new tests across `core/src/core.test.ts` (30 — `if_exists` × 4 modes + batch + strict-schema-projected-shape + the two tags-only/links-only `updated_at`-bump regressions, `has_broken_links`/`include_broken_links` × single/list/no-table-yet/backfill-on-later-create, `summary`), `core/src/seed-packs.test.ts` (1 — the new Getting Started subsection), `src/vault.test.ts` (25 — REST parity for `if_exists`/`summary`/`has_broken_links`/`include_broken_links` + the two REST `updated_at` tripwires, plus the tag-scope-bypass security regressions on BOTH MCP and REST including the monkeypatched concurrent-INSERT RACE path — each confirmed RED with its guard removed). Gates: `bun run typecheck` clean; `bun test ./src/` 2152 pass / 1 skip / 0 fail; `bun test ./core/src/` 1042 pass / 0 fail. Known flake: mirror-routes "two PUTs" #558 (unrelated, not encountered this run).

Deviation from the issue text: #555's ergonomics checklist wrote `if_exists: error|ignore|append|replace`; the actual mode is `"update"`, not `"append"` (the issue's own description — "merge the incoming content/metadata/tags/links into the existing note (like update-note)" — only makes sense as "update," and the orchestrator's mission brief already specified `"update"`; treated as a typo in the source issue, not a deviation from spec).

Race-backstop caveat: the `if_exists` create-race fallback (an INSERT that hits `path_conflict` re-resolves the winning row and applies the SAME collision branch a proactive check would have) is implemented and code-reviewed, but not exercised by a literal concurrent-writers test — bun:sqlite is single-connection/single-threaded per process, so a genuine INSERT race can't be constructed in an in-process unit test (same limitation `core/src/contract-concurrency.test.ts` already documents and works around via sequential-not-parallel tests for its own concurrency contracts). The sequential case (create, then a second `if_exists` call against the same path) IS covered end-to-end and exercises the identical `applyExistingNote` code path via the proactive check.

## [0.7.0-rc.8] - 2026-07-10

### Fixed — Honest-behavior correctness fixes (Wave 8 of the Reliability & Usability Program, #555, umbrella #556)

Six independent correctness/honesty fixes surfaced by 8 sandboxed persona-testers on the live 0.7.0-rc.7 build, all ground-truth-verified by the orchestrator before this PR — theme: **the API should never silently do the wrong thing.**

- **Structured `links` now resolve exactly like `[[wikilinks]]` — basename/title match + lazy forward-refs (fix 1).** A structured `links: [{target, relationship}]` entry on `create-note`/`update-note` (and REST `POST`/`PATCH /notes`) used to resolve by exact path only — no basename/title fallback, no forward-ref queueing — silently dropping the edge whenever the equivalent `[[wikilink]]` would have resolved. `core/src/wikilinks.ts` gains `resolveLinkTarget` (ID, then the same exact-path/basename resolution `[[wikilinks]]` use) and `resolveOrQueueLink` (resolve now, or queue for lazy resolution via `unresolved_wikilinks` — extended with a `relationship` column so a structured link's caller-supplied relationship survives instead of hardcoding `"wikilink"`). A same-batch forward-ref (item 0 links to item 1's path, created later in the same `create-note` batch) now resolves in a second pass after every note in the batch exists; a target that still doesn't resolve is queued (backfills automatically when a matching note is created, by any client) and surfaces an `unresolved_link` warning naming the target — never silently dropped. Self-healing migration rebuilds a pre-existing `unresolved_wikilinks` table onto the new 3-column PK on first touch. Shared implementation — both `core/src/mcp.ts` and `src/routes.ts` call the same functions.
- **`updated_at` now bumps on every real mutation (fix 2).** A tags-only or links-only `update-note`/`PATCH` call with `force: true` (no `if_updated_at`) used to leave `updated_at` frozen — the mcp/REST layer's `updates` object stayed empty, so `store.updateNote` was never even called, breaking cursor polling (`ORDER BY updated_at`) and `updated_at`-based sync filters. `renameTag`'s inline content-rewrite (`#oldtag`→`#newtag` in note bodies) and its `_tags/<oldname>...` path-rewrite also now bump `updated_at` on the rewritten notes (both used a raw `UPDATE notes SET content = ?` / `SET path = ?` that never touched it). Deliberately NOT touched: the bulk note_tags repoint inside `renameTag`/`mergeTags` — a taxonomy-level rename doesn't change a note's own content, and bumping potentially thousands of notes' `updated_at` in one op would flood cursor consumers with no real signal.
- **`validation_status` now surfaces on reads too, not just create/update writes (fix 3).** `query-notes` (single-id and list) and REST `GET /notes` (single and list) never attached `validation_status` at all — a caller reading a note back after write (e.g. to confirm an out-of-enum value on an indexed field is findable via `eq`) saw nothing, contradicting "advisory violations surface as warnings." Both surfaces now attach it exactly like create/update already do, in-memory against the cached schema config (no extra DB round-trips).
- **Enum-membership violations on indexed fields now warn correctly (fix 3, continued).** Investigated the literal repro (indexed non-strict enum field accepting an out-of-enum value with NO warning) extensively — the enum check itself was already correct at write time in every scenario tested; the real, verified gap was the read-path attachment above. `docs/contracts/tag-data-model.md` and `docs/HTTP_API.md` now explicitly document that `indexed: true` guarantees TYPE, not enum-domain — add `strict: true` to enforce enum membership as a hard rejection.
- **`update-tag` rejects unrecognized field types (fix 4).** `update-tag{fields:{weird:{type:"frobnicator"}}}` used to be accepted and persisted verbatim, no error — the only existing type check (`mapFieldType`) ran solely on `indexed: true` fields. New error_type `invalid_field_type` (400 standalone / bundled into `tag_field_conflict`'s new `invalid_type` reason in the common path) names the field, the bad type, and the valid set (`string`/`number`/`integer`/`boolean`/`array`/`object`).
- **`update-tag` reports every invalid field in one call, not just the first (fix 5).** REST's `PUT /api/tags/:name` was fail-fast for `invalid_field_default` (a single-violation 400 that silently dropped every other bad field in the same call) — now bundled with `invalid_field_type` and any cross-tag conflicts into one `tag_field_conflict` 422, mirroring the existing W4 collect-all pattern. Scope-scrub preserved by construction: both new violation reasons are own-field checks with no `other_tag`, so nothing to scrub. **BREAKING (REST wire):** a `PUT /api/tags/:name` client pinned to **400 `invalid_field_default`** for the single-bad-default case now gets **422 `tag_field_conflict`** (the bad default appears in `violations[]` as reason `invalid_default`). This is intentional — it aligns REST with MCP's already-bundled reporting. Re-key on the 422 + `violations[]`; the 400 `invalid_field_default` path is now unreachable from REST/MCP (retained only as a defense-in-depth backstop for direct `store.upsertTagRecord` callers).
- **`validation_status` scope-scrub on reads (fix 3, auth-review fold).** The new read-path `validation_status` (and the pre-existing write-path one) is scrubbed for tag-scoped callers so an out-of-scope co-tag's schema shape (field name / type / enum) can't leak via a note the caller can otherwise see (the #560 leak class). Centralized in `scrubValidationStatusByScope` (src/tag-scope.ts), applied at the MCP `query-notes` wrapper and REST `GET /notes[/{id}]`. Unscoped callers unchanged.
- **Crash-safe `unresolved_wikilinks` migration (fix 1, wire-review fold).** The self-healing rebuild that adds the `relationship` column now runs inside a transaction (nesting-guarded via `db.inTransaction`, since a batch write already holds one) so an interruption mid-rebuild rolls back to the intact original table rather than losing pending forward-ref rows or the table itself — same discipline as W7's `migrateToV25`. Load-bearing interruption test added.
- **MCP JSON-RPC error messages no longer double-prefix (fix 6).** `src/mcp-http.ts`'s domain-error mapping read a caught error's `.message` and fed it into a fresh `McpError` — the SDK's `McpError` constructor bakes `"MCP error <code>: "` into `.message` itself, so an already-formed `McpError` reaching that catch block got double-prefixed (`"MCP error -32602: MCP error -32602: ..."`). Every domain error now maps through one function, `mcpDomainError` (replacing 15 duplicated call sites), with a top-of-catch `err instanceof McpError` guard that re-throws an already-correct error unchanged. Optional polish: the human-readable message now also carries the `error_type` token (`"[invalid_query] ..."`). `data.error_type` fidelity was never actually broken by the bug.
- **Investigated (not a bug): batch/parallel `content_edit` with a shared `old_text`.** A tester reported update-note batch/parallel calls failing 7/8 with "old_text not found" when items share the same `content_edit.old_text`. Not reproducible against different notes (20x repeated in-memory trials, zero failures, both MCP and REST) — root-caused why it structurally can't race (no shared mutable state, no `await` between the content read and the search). Found and documented the scenario that DOES reproduce the exact symptom: N calls sharing `old_text` against the SAME note, which is correct behavior (the first call consumes the only occurrence) — most plausibly what the original report actually hit via a test-harness variable bug. No fix applied.

Core-vs-handler split: fixes 1/2/3/4/5 touch both `core/` (the shared resolution/validation logic) and `src/` (the REST handler port) so MCP and REST stay identical; fix 6 is `src/`-only (core never imports the MCP SDK); fix 7 is test-only (no production code changed).

Docs: `docs/HTTP_API.md` (warnings channel, structured-links resolution semantics, `updated_at` bump guarantee, `validation_status` on reads, the `tag_field_conflict`/`invalid_field_default`/`invalid_field_type` error-taxonomy rows, the MCP double-prefix fix), `docs/contracts/tag-data-model.md` (indexed-vs-enum clarification). New MCP tool-description copy on `create-note`/`update-note`/`update-tag`/`query-notes`.

Tests: 34 new tests across `core/src/core.test.ts`, `core/src/wikilinks.test.ts` (existing suite, unaffected), `src/vault.test.ts`, `src/contract-errors.test.ts`, `src/tag-field-conflict-scope.test.ts`, and new `src/mcp-http.test.ts` (7 tests). Full gate green: `bun run typecheck` clean; `bun test ./src/` 2124 pass / 1 skip / 0 fail (one intermittent failure on the first of two runs — the documented mirror-routes "two PUTs" #558 flake, confirmed unrelated by a clean re-run); `bun test ./core/src/` 1009 pass / 0 fail.

These fixes came from the interim persona-harness round (8 sandboxed personas against the live rc.7 build) rather than the original 32-probe scorecard — see #555/#556 for the full harness writeup.

## [0.7.0-rc.7] - 2026-07-10

### Added — Search recall + ranking legibility (Wave 7 of the Reliability & Usability Program, WS2B/C, #551)

- **Title/path indexing — the biggest single recall gap in the search stack (interim-harness finding, ground-truth-verified before this PR).** `search=` used to match ONLY a note's body `content` — a note's title/path was completely unsearchable, both a plain recall gap on its own (users naturally expect a title match to be findable) and a blocker for any title-biased ranking (nothing was indexed to bias). `notes_fts` (`core/src/schema.ts`) now indexes `path` and `content` as two separate FTS5 columns; `search=` matches a term in EITHER. The three sync triggers (previously firing only on `UPDATE OF content`) now fire on `UPDATE OF content, path` — a path-only rename (content untouched) used to be silently invisible to the index and is now kept in sync.
- **`migrateToV25` — schema v24→25, notes_fts rebuild (`core/src/schema.ts`).** A one-time, idempotent startup migration that runs the ENTIRE sequence — DROP + recreate `notes_fts` (external-content FTS5 tables can't `ALTER ... ADD COLUMN`) in the new path+content shape with `tokenize='porter unicode61'`, DROP + recreate the three sync triggers, AND repopulate the index from every existing note (`SELECT rowid, path, content FROM notes` → one `INSERT` per row) — inside **one `transaction`**, so it's strictly all-or-nothing (generalist review fold, #565). A crash partway through with the DDL committed but the index empty would otherwise be unrecoverable: the recreated table already carries the `path` column, so the idempotency guard would report "done" and never retry, leaving search permanently empty. Wrapping the whole thing means a rollback restores the pre-v25 single-column shape (no `path`), so the guard correctly re-detects "not migrated" and the next boot re-runs it cleanly — correct-by-construction. Guarded by `hasColumn(db, "notes_fts", "path")` (the shared `PRAGMA table_info` helper, reused rather than a bespoke copy) so a fresh vault — already created with the v25 shape directly by `SCHEMA_SQL` — never runs the rebuild; an already-migrated vault re-running `initSchema` is a no-op. No note data is touched, only the derived search index. **Cross-runtime flag for the wire reviewer:** DROP/CREATE VIRTUAL TABLE, the trigger definitions, and the repopulation SELECT/INSERT are standard FTS5 + SQL — no bun-only functions — but the two-column external-content shape, `tokenize='porter unicode61'`, and (separately, for `search_did_you_mean` below) the lazily-created `fts5vocab` table are new usage for this codebase and unverified against Cloudflare DO SQLite's FTS5 build specifically (the hosted async Store backend isn't shipped yet — the DO-SQLite verdict is a stable-promotion gate, tracked cloud#114, not a merge blocker for this rc).
- **bm25 title weighting + a legible `score` field (WS2C).** `notes_fts`'s two columns are weighted 10:1 (`SEARCH_WEIGHT_PATH`/`SEARCH_WEIGHT_CONTENT`, `core/src/search-query.ts`) so a dedicated note whose TITLE contains the search term outranks another note that merely mentions it once in passing body text — the fix for a repeatedly-observed harness finding (a clearly-on-topic dedicated note buried at position #3–4 behind incidental mentions). Every search result (`Note`/`NoteIndex` — carried onto the LEAN shape too, since search's default response IS `NoteIndex[]`) now carries `score: number` (sign-flipped weighted bm25, higher = more relevant, relative within one result set only; absent on every non-search response). `sort:"asc"/"desc"` still overrides relevance ordering exactly as before (#551 WS2A); `score` is still computed and returned even when `sort` wins.
- **Porter stemming (WS2B recall).** The FTS5 tokenizer is now `porter unicode61` (previously bare `unicode61`) — regular English affixes match across forms (`firefighter`/`firefighters`, `microbe`/`microbes`). Does NOT cover irregular plurals with a consonant change (`wolf`/`wolves`) — a Porter limitation, not a bug, documented rather than worked around; synonyms (microbes/bacteria) stay explicitly out of scope for this wave per #551.
- **`search_did_you_mean` warning — zero-result search suggestion (WS2B, mirrors the tag `did_you_mean`).** `core/src/query-warnings.ts`'s new `computeSearchDidYouMean` runs ONLY after a search already returned zero rows (never on the hot "found something" path): a lazily-created, best-effort `fts5vocab('row')` table over `notes_fts` supplies the candidate vocabulary (length-windowed per token, no result-count cap — a frequency-ordered `LIMIT` would bias toward common words, backwards for a name/typo lookup), unioned with the vault's tag names, scored by the SAME `suggestSimilarTag` edit-distance function the tag `did_you_mean` already uses. The whole function is wrapped in try/catch and degrades to "no suggestion" on any failure. Scope-unaware by construction (the FTS5 vocabulary spans the whole vault) — MCP is safe for free (`applyTagScopeWrappers`'s `query-notes` wrapper already strips the entire `warnings` array for a scoped session); REST gates the call explicitly behind `tagScope.allowed === null`, mirroring `collectUnknownTagWarnings`'s existing gate. A suggestion occasionally reads as a STEMMED form (`propoli` rather than `propolis`) since the FTS5 vocabulary is the post-stemming index — an accepted tradeoff over maintaining a second unstemmed index just for spelling suggestions.
- **Advanced-mode column-filter errors are wrapped (WS2B item 4, interim-harness finding).** `search_mode:"advanced"` raw FTS5 syntax can misparse a leading bare `-token` (NOT is a BINARY operator in FTS5 — `x -y`, not `-y` alone) as column-filter syntax, producing a raw `no such column: <token>` error that reads as if a column literally named after the search term was expected. `core/src/notes.ts`'s `searchSyntaxError` now detects this pattern (`/no such column:/i` against the FTS5 error text) and substitutes a caller-actionable hint naming the actual two likely causes and the real indexed columns (`path`/`content`), instead of forwarding the confusing internals verbatim.
- **Minor tokenizer edges — documented, not fought (WS2B item 4, your-judgment items).** A fused decimal+unit token (`3.14mm`) is one token to the tokenizer — `search=3.14` won't find it; not worth a custom tokenizer for one edge case. Emoji and other symbol characters are dropped by the tokenizer entirely (unindexed, unsearchable). Both documented in `docs/HTTP_API.md` rather than engineered around.
- **Core-vs-handler split.** Almost entirely `core/`: `schema.ts` (the migration + SCHEMA_SQL shape), `search-query.ts` (the weight constants), `query-warnings.ts` (`computeSearchDidYouMean`/`searchDidYouMeanWarning`), `notes.ts` (`searchNotes`'s weighted SQL + score threading + the wrapped hint), `types.ts` (`score` on `Note`/`NoteIndex`), `mcp.ts` (tool description + did_you_mean wiring, scope-unaware by architecture). The only `src/` (Bun-server-only) change is `routes.ts`'s explicit `tagScope.allowed === null` gate on the did_you_mean call — REST enforces tag-scope inline (no post-hoc wrapper to strip it automatically the way MCP has). The cloud runtime inherits everything except the REST-specific gate automatically once it imports `core/` directly.
- **Preserves every #551 WS2A behavior** (literal-by-default, `search_mode:"advanced"`, honored `sort`, structured `invalid_search_syntax`, NUL/control sanitization, `empty_search` warning) — no regressions; every existing `src/contract-search.test.ts` test (27) passes unchanged, plus 33 new tests across three files (title indexing, ranking, score, stemming, did_you_mean × scope, the wrapped hint, migration + crash-recovery, REST + MCP parity).
- **Tests.** New `core/src/search-fts-v25.test.ts` (18 tests): fresh-vault v25 shape, a hand-built v24-shaped legacy vault migrated via `initSchema` (title newly searchable, body search unregressed, stemming, title-outranks-body with `score` asserted, a no-path legacy row surviving the rebuild, an FTS5 `integrity-check` pass, migration idempotency on both a freshly-migrated and an already-v25 vault), a **mid-migration interruption test** (#565 must-fix — drives the exact rebuild DDL through the same `transaction` seam and throws before repopulation, asserts the rollback restored the v24 single-column shape at `schema_version` 24 rather than a committed-empty v25 table, then that a clean `initSchema` fully recovers search — never the silent-empty state), and the sync triggers (no-path insert, path-only update now synced, delete clears both columns). `src/contract-search.test.ts` gained 13 tests (8 REST + 5 MCP-parity). `src/mcp-query-notes-search-scope.test.ts` gained 2 tests (#565 NIT 1 — MCP `did_you_mean` tag-scope suppression + an unscoped control proving the suggestion is suppressed by scope, not simply absent).
- **Docs.** `docs/HTTP_API.md`: `score` added to the `Note`/`NoteIndex` shape blocks, a new "Recall + ranking legibility" subsection under Full-text search (title indexing, ranking, `score`, stemming + its documented limitation, `search_did_you_mean`, the tokenizer edges, the wrapped hint), `search_did_you_mean` added to the warnings-channel code list and the scope-leak-prevention note, a wrapped-hint example added to the `invalid_search_syntax` section, and a new "Startup migration (schema v25)" note. `core/src/mcp.ts`'s `query-notes` tool description and the `search` field schema updated to match.

## [0.7.0-rc.6] - 2026-07-10

### Added / Changed — BREAKING

- **Typed indexes you can trust — indexed⇒strict writes, explicit-default enum backfill, `migrateToV24` poison coercion (Wave 6 of the Reliability & Usability Program, WS4, #553 — the last P1).** Root cause fixed: indexed metadata columns accepted type garbage. A write of `metadata.n = "four"` to an indexed integer field used to succeed with only an advisory `type_mismatch` warning; the poisoned row's generated column then matched `{gt: 100}`-style range queries via SQLite's TEXT-sorts-above-INTEGER type-affinity ordering — one sloppy write silently poisoned every range query on that field forever.
  - **BREAKING — Decision A: `indexed: true` ⇒ the field's TYPE is always enforced (`core/src/schema-defaults.ts`).** A write whose value's type contradicts the declared indexed type is now REJECTED (`422 schema_validation`, the same shape `strict:true` violations already use), independent of the field's own `strict` flag — a type-mismatched write on an indexed field can no longer land at all. Every OTHER constraint on an indexed field (enum/required/cardinality) stays governed by `strict` exactly as before; non-indexed fields keep the unchanged advisory-warning behavior. Wired through the ONE shared chokepoint (`enforceStrictWrite`/`validateNote`) both REST (`PATCH`/`POST` batch, `src/routes.ts`) and MCP (create/update-note, single + batch + `if_missing:"create"`) already funnel through — no per-transport duplication. `type_mismatch` messages now also name the OBSERVED type (`'field' should be integer (tag 'x'), got string`), not just the expected one.
  - **BREAKING — Decision B: enum/field backfill is explicit-`default:`-only (`core/src/tag-schemas.ts`, `core/src/mcp.ts`).** New optional `fields.<field>.default` (typed per the field's own `type`/`enum` — a non-conforming default is rejected as a tag-schema error: `invalid_field_default`, 400, on REST's fail-fast `store.upsertTagRecord` pre-validate; bundled as `tag_field_conflict`'s new `invalid_default` reason on MCP's `update-tag`, which collects every violation before persisting). `defaultForField`/`applySchemaDefaults` now return/apply ONLY an explicit `default` — the old implicit "first enum value / type zero-value" backfill is retired, so `metadata: { field: { exists: false } }` is finally trustworthy: "never set" and "explicitly set to the default" are distinguishable. **Blast radius: future writes only** — notes already backfilled under the old behavior keep their values; no migration touches them (the enum-default change has no data-shape to fix, only new-write behavior to change).
  - **Decision C: honest type list.** `update-tag`'s field-type description (`core/src/mcp.ts`) and `docs/HTTP_API.md` now say clearly that all six types (`string`/`boolean`/`integer`/`number`/`array`/`object`) are accepted for storage/advisory validation, but only `string`/`integer`/`boolean` are INDEXABLE — the enforcement (`unsupported_indexed_type`/`invalid_indexed_field`) was already correct; only the advertised description was dishonest.
  - **Decision D: `migrateToV24` — schema v23→24, typed-index poison coercion (`core/src/schema.ts`).** A one-time, idempotent startup migration that reuses `doctor`'s `mixed_type_indexed_field` detector (`findMixedTypeIndexedFieldNotes`, newly extracted+exported from `core/src/doctor.ts` — ONE detection query backs both the doctor finding and this migration). For every declared indexed field and every note whose value's JSON type disagrees with the field's declared sqlite storage class: **coerces losslessly** where an exact round-trip conversion exists (a clean numeric string → its number, `"true"`/`"false"` → the boolean, a number/boolean → its string form — each gated on an exact `String↔Number`/`String↔Boolean` round-trip so nothing is silently truncated), and **leaves everything else in place** (a non-numeric string in an integer field, any array/object value) — **the migration NEVER deletes or nulls note data**; non-coercible values remain visible via `doctor`'s `mixed_type_indexed_field` finding for deliberate operator cleanup. Rewrites happen at the JS level (`SELECT metadata` → `JSON.parse` → mutate one field → `JSON.stringify` → single-row `UPDATE`, 2 bound params) rather than SQL `json_set`, keeping the migration portable to a narrower json1 surface — **cross-runtime flag for the wire reviewer: confirm DO SQLite compatibility** (detection still uses `json_extract`/`json_type`/`json_valid`, the same functions the indexed generated columns already depend on everywhere in this codebase, so this isn't a NEW cross-runtime risk — only the coercion write path is new). Never batches a bounded-IN query, so it can't approach SQLite's parameter ceiling regardless of poison volume.
  - **Core-vs-handler split.** This PR is almost entirely `core/`: `schema-defaults.ts` (Decision A), `tag-schemas.ts` (Decision B validation + new `InvalidFieldDefaultError`), `store.ts` (Decision B pre-validate chokepoint), `mcp.ts` (Decision B backfill logic + Decision C description text — both newly EXPORTED so `src/routes.ts` can import instead of carrying its OWN byte-identical duplicate, which it did pre-#553), `doctor.ts` (detector extraction), `schema.ts` (the migration itself). The only `src/` (Bun-server-only) changes are: deleting `routes.ts`'s now-redundant `applySchemaDefaults`/`defaultForField` copies in favor of the core import, and a new REST catch branch mapping `InvalidFieldDefaultError` → `400 invalid_field_default`. **The cloud runtime, which imports `core/` directly and never touches `src/routes.ts`, inherits Decisions A/B/C/D automatically** with zero handler-side code — the only thing a cloud implementer needs to independently verify is the `migrateToV24` cross-runtime flag above.
  - **Docs (`docs/HTTP_API.md`, `docs/contracts/tag-data-model.md`).** New `invalid_field_default` error-taxonomy row; `schema_validation`'s row updated to name the indexed-type escalation; `tag_field_conflict`'s row gains the `invalid_default` reason; new prose under `PUT /api/tags/{name}` covering all three breaking/non-breaking decisions + the migration; the doctor `mixed_type_indexed_field` finding description updated to reflect that `migrateToV24` now runs first and the finding surfaces only genuine leftovers; a stale "writes are never blocked" line in `tag-data-model.md` (predating both vault#299 and this PR) corrected. The onboarding "Getting Started" seed content (`core/src/seed-packs.ts`) — real AI-facing product documentation seeded into every new vault — rewritten to teach explicit `default:` and indexed⇒strict instead of the retired implicit-backfill behavior.
  - **Todos flipped (`core/src/contract-typed-index.test.ts`).** All three #553 `test.todo` entries replaced with real tests (indexed-type rejection on create AND update, plus a range-query-never-poisoned lock-in, plus an advisory-stays-advisory control for non-indexed fields; unset-enum-stays-absent + `exists:false` correctness, plus an explicit-default-still-backfills control, plus a bad-default-rejected control; the honest type-list description + behavioral unindexable-type-rejected/storage-only-accepted controls). New migration test block: a poisoned fixture indexed AFTER notes already existed (real-data-like — a coercible numeric string, a coercible boolean string, a genuinely non-coercible string, and an already-clean value on the SAME field, all in one fixture), a TEXT-target number coercion, an array-value left-in-place case, and a re-run idempotency assertion.
  - **Existing-test fallout from the breaking backfill change.** Every test that asserted the old implicit enum[0]/zero-value backfill (`core/src/core.test.ts`, `src/vault.test.ts`, `src/onboarding-seed.test.ts`) updated to either declare an explicit `default` (where the test's actual intent was "does backfill work/re-read correctly") or assert genuine absence (where the test's actual intent was "schema application populates metadata," now split into an absence test + a with-default test). `core/src/attribution.test.ts`'s two hardcoded `SCHEMA_VERSION === 23` pins — stale the moment ANY later PR bumps the version further — loosened to `>= 23` / compared against the live `SCHEMA_VERSION` constant instead.

## [0.7.0-rc.5] - 2026-07-09

### Added

- **Taxonomy integrity — rename/merge MCP tools, delete + cycle guards, `vault doctor` (Wave 5 of the Reliability & Usability Program, WS3, #552).** Root cause fixed: tags are name-strings with no referential integrity. There was no rename primitive, so a rename was create-new + retag + delete-old — and children's `parent_names` silently kept pointing at the old name (the renamed-away tag stayed a live query surface via subtype expansion while `list-tags` reported it at count 0; the new tag missed every child-tagged note). Separately, metadata values that happened to equal a tag name (e.g. `metadata.epic: "task"`) drifted silently through a rename with zero signal.
  - **`rename-tag` and `merge-tags` exposed as MCP tools (`core/src/mcp.ts`) — the engine + REST endpoints already existed (vault#240/#247); this is MCP surface parity, not new logic.** Both delegate to the SAME `store.renameTag`/`store.mergeTags` the REST routes use — identical cascade, identical error shapes. `merge-tags` gained the same tag-scoped-token reference guard `DELETE /tags/{name}` already had (`applyTagDependencyGuards` in `src/mcp-tools.ts`, previously delete-only — the doc comment already said "(future) tag-merge"). Tag-scoped callers: `rename-tag` requires both `old_name` and `new_name` in the allowlist; `merge-tags` requires every source AND the target.
  - **Referential integrity on delete (`core/src/notes.ts` `deleteTag`).** Previously dropped a tag unconditionally, even when another tag's `parent_names` referenced it — orphaning the child's hierarchy edge. Now refuses with new `error_type: "tag_referenced_as_parent"` (`{tag, referencing_tags}`, 409 on REST, in-band on MCP — same shape as the pre-existing `tag_in_use_by_tokens` guard) unless the caller passes `cascade` or `detach` (query params on REST DELETE; body flags on MCP — both **synonyms**: either strips the stale reference from every referencing tag's `parent_names` in the same transaction as the delete; neither deletes the referencing tags). Default (neither flag) is refuse. Whole operation is transactional. Tag-scope: `referencing_tags` entries outside a scoped caller's allowlist are generalized (`scrubReferencingTagsByScope`, `src/tag-scope.ts`) — the delete stays refused either way, since referential integrity is scope-independent.
  - **Cycle guard on `parent_names` writes (`core/src/tag-schemas.ts` `upsertTagRecord`, new `ParentCycleError`).** An adversary-confirmed A→B then B→A (or a bare self-parent) previously wrote successfully — traversal (`getTagDescendants`) was already cycle-safe (a visited-set stops it looping), but the write itself was dishonest about creating one. Now rejected with new `error_type: "parent_cycle"` (`{tag, cycle: [...]}`, 409 on REST, structured JSON-RPC on MCP) BEFORE any row is touched. New `findParentCycle` + a small BFS path-reconstruction helper in `core/src/tag-hierarchy.ts` (alongside the pre-existing `findHierarchyCycles`, which the `doctor` scan below reuses for pre-existing data). Applies to `upsertTagRecord` — the single chokepoint both `PUT /api/tags/{name}` and MCP `update-tag` already funnel through — so both inherit it identically. Tag-scope: out-of-scope hops in `cycle` are generalized (`scrubParentCycleError`); the caller's own tag is always in-scope and never redacted.
  - **`vault doctor` read-only integrity scan — new `core/src/doctor.ts`, MCP admin tool `doctor`, `GET /api/doctor` (admin-gated, dispatched before the generic read/write gate — same shape as `/api/triggers`).** Reports (never auto-fixes) `{type, severity, subject, detail, remedy, heuristic?}` findings: `dangling_parent_name` (a `parent_names` entry naming a tag with no identity row), `parent_names_cycle` (reuses `findHierarchyCycles` — surfaces pre-existing/pre-guard cyclic data the write-time guard above can't retroactively fix), `mixed_type_indexed_field` (a note's indexed-field metadata value has a JSON type disagreeing with the field's declared sqlite type — the WS4 typed-index migration's poison precursor; the finding shape is intentionally reusable as that migration's pre-flight check), `orphaned_indexed_field_declarer` (overlaps `prune-schema`, which is the suggested remedy), and `dead_tag_metadata_reference` (HEURISTIC, always `heuristic: true` — a metadata value matching no live tag, inferred from sibling notes using the same metadata key with values that ARE live tags; the PM's `metadata.epic` drift class — never certain, since vault keeps no tag-rename history). Tag-scope: a scoped admin token's scan is re-run with the caller's expanded allowlist (not filtered after the fact), so `summary` counts never leak out-of-scope activity.
  - **`Store.deleteTag` / `Store.upsertTagRecord` / new `Store.doctor`** — all three the single chokepoint both REST and MCP funnel through, so the guards can't be bypassed by either transport. `Store.deleteTag`'s return type is now a discriminated union (`{deleted, notes_untagged, parent_refs_detached?}` | `{error: "tag_referenced_as_parent", referencing_tags}`) — additive, existing success-path callers are unaffected.
  - **Docs (`docs/HTTP_API.md`):** new error-taxonomy rows for `tag_referenced_as_parent` and `parent_cycle`; `DELETE`/`PUT`/`POST .../rename`/`POST .../merge` tag endpoints document the new guards + MCP parity; new `GET /api/doctor` section.
  - Flipped all five #552 `test.todo` entries in `core/src/contract-taxonomy.test.ts` into real tests (rename-tag cascades parent_names — the gardener's exact bug; rename target_exists/tag_not_found; merge-tags; delete refused-then-cascade/detach; parent_cycle direct + self-parent; doctor reports each finding type on a seeded-broken fixture, plus a clean-vault control). New `src/tag-integrity-scope.test.ts` (scrub-function unit tests — the two new guards' offending nodes are, by construction, always within the caller's own expanded allowlist under the current hierarchy-based tag-scope model, so the scrub is defense-in-depth tested directly rather than via a contrived end-to-end scenario) and `src/tag-integrity-mcp.test.ts` (rename/merge tag-scope gating, delete cascade/detach pass-through, doctor's admin-gate + tag-scope filtering on both MCP and REST). Two pre-existing `core/src/core.test.ts` tests that built a live A↔B cycle via `store.upsertTagRecord` (to test traversal safety) now seed the cycle via a direct DB write instead, since the write-time guard rejects that path — traversal-safety intent preserved.
  - **Review folds (same rc.5):** (1) **Import no longer aborts on a cycle** — `importVault`'s schema-restore loop (`core/src/portable-md.ts`) now catches `ParentCycleError` per schema file, drops that tag's `parent_names` + records it in the new `ImportStats.skipped_schema_parents`, and continues; the tag itself (description/fields/relationships) still lands. An OLD export carrying a mutual-cycle fixture (accepted before the guard shipped) imports successfully. This was DESTRUCTIVE on a blow-away replace: step 1 wipes the vault, so an uncaught throw in step 2 left the vault EMPTY with no rollback. Surfaced as a warning through `src/mirror-import.ts` (replace-mode) too. (2) **Blow-away no longer leaves stale tag rows** — the blow-away tag sweep now passes `{cascade: true}` to `store.deleteTag`; without it, a namespace parent (`task`, which `listTagRecords` returns before its child `task/work` under `ORDER BY name`) was silently refused (`deleteTag` RETURNS `tag_referenced_as_parent` now, doesn't throw) and its row survived the "clean slate." (3+4) **Doctor scope leaks** — `scanMixedTypeIndexedFields` filtered its (vault-wide) note query, mismatch count, exemplars, and "Declared by" list through the in-scope predicate (a scoped caller could see an out-of-scope declarer tag name + note id); `scanDeadTagMetadataReferences` now computes the example live-tag value from in-scope notes only (it leaked an out-of-scope tag name as the `e.g.` example). Shared `makeNoteInScope` helper. (5) **`parent_cycle` REST body** — the `PUT /tags/:name` 409 now carries a `message` key (human sentence) with `error` set to the short code `"ParentCycle"`, matching every sibling 409 in the file; parachute-surface's shared `VaultClient` reads `body.message`, so without it a real cycle conflict rendered the wrong hardcoded "Note was edited elsewhere" text. New tests: import-of-cyclic-export (plain + blow-away-not-left-empty), blow-away-leaves-no-stale-rows (`core/src/portable-md.test.ts`); doctor scope no-leak + unscoped positive-control for both `mixed_type_indexed_field` and `dead_tag_metadata_reference` (`core/src/doctor-scope.test.ts`); `parent_cycle`/`tag_referenced_as_parent` 409 `message`-key assertions (`src/tag-integrity-mcp.test.ts`).

## [0.7.0-rc.4] - 2026-07-09

### Added

- **Structured error taxonomy — `error_type` everywhere, complete update-tag reporting, batch `force` defaults (Wave 4 of the Reliability & Usability Program, WS5, #554).** Root cause fixed: errors were prose strings inside generic MCP error codes, or bare `{error, message}` REST bodies with no machine-checkable field at all — an agent couldn't branch on failure class without regex-matching human prose.
  - **REST sweep (`src/routes.ts`).** Every error body that previously lacked `error_type` now carries one (~60 call sites: generic 404s → `not_found`, 405s → `method_not_allowed`, malformed-JSON → `invalid_json`, the PATCH `content_edit` branch's `mutually_exclusive`/`invalid_content_edit`/`content_edit_not_found`/`content_edit_ambiguous`/`invalid_state_transition`, bracket-filter and structured-query validation errors → `invalid_query`, cursor errors → `cursor_invalid`/`cursor_query_mismatch`, tag/vault/storage/retry-transcription errors, and more). Existing `error_type` values (`path_conflict`, `conflict`, `schema_validation`, `precondition_required`, `transition_conflict`, `ambiguous_path`, `batch_too_large`, `invalid_extension`, `tag_in_use_by_tokens`, `invalid_relationships`, `invalid_indexed_field`, `invalid_query`, `invalid_search_syntax`, `tag_not_found`, `cursor_invalid`, `cursor_query_mismatch`) are unchanged — this is additive naming hygiene, not a rename. `hint` added throughout, including the four core write-path errors (`conflict`, `schema_validation`, `precondition_required`, `path_conflict`).
  - **MCP domain-error mapping (`src/mcp-http.ts`).** Extended the JSON-RPC error-data mapping to cover every thrown domain error class, not just the four that already had dedicated branches: `QueryError` now generalizes to ALL instances (not just the ones that pre-set `error_type`, defaulting to `invalid_query`), plus new branches for `CursorError`, `PathConflictError`, `AmbiguousPathError`, `ExtensionValidationError`, `BatchTooLargeError`, and the new `TagFieldConflictError`. A generic `error_type`-keyed catch-all closes the remaining gap for validation-leaf errors built with a new `structuredError()` helper (`core/src/mcp.ts`) — so only a TRULY unknown error still falls through to the unstructured `isError: true` text fallback. `core/src/mcp.ts`'s two inline `{error: ...}` soft returns (query-notes single-note/anchor not-found) and `src/mcp-tools.ts`'s three (wrapper-layer not-found) gained `error_type: "not_found"` too.
  - **Contract table (`docs/HTTP_API.md`).** New "Error taxonomy" section: every `error_type` in the codebase, its HTTP status, key fields, and one-line meaning, organized by write-path conflicts, content-edit branch, tag schema, query/search validation, not-found/method/transport, storage, and transcription retry.
  - **`update-tag` reports ALL invalid fields, states no changes applied (#553 messaging).** Cross-tag field conflicts (`type` or `indexed` disagreeing across declarers) used to throw on the FIRST offending field and silently drop the rest — two testers independently assumed the tag's other, valid fields had landed. New `core/src/tag-schemas.ts` `collectCrossTagFieldViolations`/`collectTagFieldViolations` + `TagFieldConflictError` collect every violation into one response (`error_type: "tag_field_conflict"`, 422, `violations: [{field, reason, message}]`, message states explicitly "no changes were applied") — shared by the MCP `update-tag` tool (all four checks: cross-tag type/indexed-flag PLUS unsupported-indexed-type/invalid-field-name) and REST `PUT /api/tags/{name}` (cross-tag checks only, deliberately — REST's pre-existing single-violation `IndexedFieldError` → 400 `invalid_indexed_field` contract for a solo bad field name, vault#478, is unchanged and still tested).
  - **Batch `update-note` honors a top-level `force`/`if_updated_at` as a per-item DEFAULT (#554).** Previously `items = batch ?? [params]` never merged the top-level fields into batch items at all — a caller passing `{force: true, notes: [...]}` had it silently ignored, and every item without its OWN `force`/`if_updated_at` still threw `precondition_required` (a gardener-reported round-trip cost). Now the top-level value applies to any item that doesn't set its own; an item's own `force`/`if_updated_at` still wins when present. Documented in the MCP tool description and `docs/HTTP_API.md`.
  - **Carry-forward tests from prior waves' reviews (test-only, no behavior change):** the MCP `list-tags` scope wrapper's second scrub branch — a queried tag in-scope only via a child's `parent_names`, hollow (no identity row, no direct notes), where core's vault-wide `did_you_mean` would otherwise leak an out-of-scope decoy (`src/mcp-list-tags-scope.test.ts`); a combined tag-scoped-token × `search` test sweeping every `search_mode` × `sort` combination, asserting out-of-scope notes never appear (`src/mcp-query-notes-search-scope.test.ts`, new file).
  - Flipped both #554 `test.todo` entries in `src/contract-errors.test.ts` and the #553 update-tag-messaging `test.todo` in `core/src/contract-typed-index.test.ts` into real assertions; one #553 test (`core/src/indexed-fields.test.ts`) updated to expect the new `TagFieldConflictError` shape instead of a bare `IndexedFieldError` from the MCP tool's old first-violation-only throw.
  - **Review folds (same rc.4):** (1) **Tag-scope scrub on cross-tag conflict errors** (auth-and-scope review, proven live on both surfaces) — core's cross-tag validation scans every tag's schema, so a tag-scoped caller updating its own in-scope tag received violations NAMING an out-of-scope tag + its declared type. The write is still rejected (integrity is scope-independent), but a violation whose conflicting declarer is outside the allowlist is now generalized: no tag name, no declared type/flag, the new structured `other_tag` field omitted (`scrubTagFieldViolationsByScope` in src/tag-scope.ts; threaded through the MCP update-tag scope wrapper and REST `PUT /api/tags/{name}`'s `tagScope`). The same leak through the `invalid_indexed_field` door (declareField's cross-declarer message names declarer tags + storage type) is scrubbed by `scrubIndexedFieldConflictError` — same 400, same error_type, generalized prose; `IndexedFieldError` gained structured `field`/`declarer_tags` for the purpose. In-scope declarers keep full detail; unscoped callers unchanged. (2) **Wire-contract floor: both-indexed type conflicts stay 400** (wire review) — the new 422 pre-check had intercepted a case that already errored on main (`declareField`'s cross-declarer sqlite-type check → 400 `invalid_indexed_field`); `collectCrossTagFieldViolations` now SKIPS the type-conflict check for incoming `indexed: true` fields so that case keeps its established 400, while the genuinely-new rejections (non-indexed type conflicts, indexed-flag conflicts — both silent 200s on main) stay 422. Pinned by regression tests on both surfaces. (3) **Docs:** added the `invalid_audio_retention` + `invalid_auto_transcribe` rows (both 400, `PATCH /api/vault`) that this same PR introduced but the error-taxonomy table omitted.

## [0.7.0-rc.3] - 2026-07-09

### Changed

- **Search — literal-by-default, `search_mode:"advanced"` for raw FTS5 syntax (Wave 3 of the Reliability & Usability Program, WS2A, #551).** Root cause fixed: `search` used to be bound straight to SQLite FTS5 as raw query syntax, so ordinary punctuation was silently parsed as syntax instead of matched as content — `search: "didn't"`, `"eleven-day capping delay"`, and `"18.6"` all returned `[]` against notes containing the exact text (a bare hyphen = FTS5 NOT; an apostrophe/decimal point broke the parse outright), and the FTS5 syntax error was swallowed into an empty array either way.
  - **Literal by default.** New `core/src/search-query.ts` (shared by REST and MCP, and by the hosted door on rebuild via the `file:` core dependency): sanitizes control bytes (NUL and other C0/DEL characters) to token separators, splits the query on whitespace, wraps each token in `"..."` with internal `"` doubled (FTS5 phrase escaping), joins with spaces (implicit AND). Punctuation-safe by construction — the tokenizer that indexes content is the same one that parses a quoted phrase, so escaped tokens land on identical boundaries.
  - **`search_mode: "advanced"`** (MCP param; REST `?search_mode=advanced`) opts back into raw FTS5 syntax — the pre-#551 behavior, unchanged (boolean AND/OR/NOT, manual phrase quoting, prefix `*`). A malformed advanced query now throws a structured `400`/JSON-RPC error (`error_type: "invalid_search_syntax"`, carrying `field`/`got`/`hint`) instead of silently returning `[]`. An unrecognized `search_mode` value, or `search_mode` passed without `search`, is validated the same way `expand` is (`invalid_query` / an `ignored_param` warning respectively).
  - **`sort` honored under search.** Default stays FTS5 relevance ranking; an EXPLICIT `sort: "asc"|"desc"` now switches to `created_at` ordering (previously silently ignored — the REST doc claimed "FTS owns its own ordering," which is now true only absent an explicit `sort`). Implemented once in `core/src/notes.ts` `searchNotes` so both doors share it.
  - **`empty_search` warning.** A `search` string that's blank, whitespace-only, or (in literal mode) nothing but quote characters short-circuits to `[]` with an `empty_search` warning instead of risking a degenerate FTS5 phrase erroring or matching nothing for confusing reasons.
  - **Breaking change (rides the 0.7.0 train, migration: `search_mode:"advanced"`).** A caller relying on raw FTS5 syntax under the default `search=` — manual phrase quoting to force exact-adjacency matching, boolean operators, prefix `*` — must add `search_mode: "advanced"` to keep that exact behavior. Manually-quoted phrases usually still find the same content under the new literal default (FTS5's tokenizer strips the embedded `"` characters the same way it strips other punctuation from both the query and the indexed content), but the ADJACENCY guarantee of phrase syntax is no longer honored as syntax in the default mode — only as content.
  - Docs: `docs/HTTP_API.md`'s Full-text search section, warnings-channel section, and structured-invalids section rewritten for `search_mode`/`empty_search`/`ignored_param`/`invalid_search_syntax`; corrected an adjacent stale claim that `search=` always returns full `Note[]` (it's lean `NoteIndex[]` by default, same as the structured-query path, matching current code). The MCP `query-notes` tool description gained matching `search`/`search_mode`/`sort` documentation.
  - Six #551 `test.todo` entries in `src/contract-search.test.ts` flipped to real assertions (unquoted `didn't`/`eleven-day capping delay`/`18.6` now match; `search_mode:"advanced"` preserves raw boolean/prefix syntax; `sort` changes order under search; malformed advanced syntax structurally errors while the same string in literal mode degrades honestly). Added coverage for the escaping function (`core/src/search-query.test.ts`), tag-scoped literal search, `empty_search`/`ignored_param` warnings, MCP `search_mode` validation/parity, and confirmed `search_mode` doesn't bypass the pre-existing live-subscription `search=` rejection (`ws-subscribe.test.ts`). Three PASSING contracts that manually quoted their search string (pinning raw-phrase-syntax semantics) moved to `search_mode: "advanced"` — their result sets are unchanged, but their INTENT (proving phrase adjacency is honored as syntax) is now accurate only under advanced mode.
  - **Review folds (same rc.3):** (1) **NUL-byte crash fixed** — a control byte (NUL / any C0 / DEL) inside a literal-mode token used to reach FTS5's C-string parser as `SQLiteError: unterminated string` and rethrow raw → unstructured 500 (REST) / generic `isError` (MCP), contradicting the "literal mode cannot throw" guarantee. `buildLiteralSearchQuery` now sanitizes control bytes to token separators *before* FTS5 (a mid-token control splits the token; both halves stay searchable), and the literal-mode "unreachable" catch converts any residual FTS5 throw into the same structured `invalid_search_syntax` error rather than a raw rethrow (belt: sanitization; suspenders: honest error if the invariant ever breaks). Tests: NUL-in-token, NUL-only, control-split, other C0/DEL, and an end-to-end REST assertion that `search=hello%00world` returns 200 (not 500). (2) **Deterministic sort tiebreaker** — sort-under-search now appends `, n.id <dir>` to the `created_at` ordering (matching `queryNotes`), so two notes at the same millisecond return in stable order both directions; pinned by a same-timestamp two-note test.

## [0.7.0-rc.2] - 2026-07-09

### Added

- **Honest query boundary — warnings channel, structured invalids, cursor
  bootstrap, tags 404, expanded_count, find-path hydration (Wave 2 of the
  Reliability & Usability Program, WS1, #550).** Every #550 finding is now
  a real fix instead of a `test.todo` — the full list:
  - **Warnings channel (additive).** Structured-query `GET /notes` (REST)
    and `query-notes` (MCP) now collect `warnings: [{code, message, ...}]`:
    `unknown_tag` (a `tag=` filter that matches nothing directly OR via
    expansion and has no identity row — carries `did_you_mean` when a close
    match exists) and `removed_param` (the flat `date_field`/`date_from`/
    `date_to` REST params, silently ignored since 0.6.4, now say so). REST
    bare-array responses keep their shape and gain an
    `X-Parachute-Warnings` header (percent-encoded JSON — header values are
    ASCII-only, warning text isn't); envelope responses (cursor mode,
    `?format=graph`) carry `warnings` inline too. MCP wraps as
    `{notes, warnings}` when non-empty, composing with the cursor envelope
    (`{notes, next_cursor, warnings}`). Tag-scoped sessions never see
    `unknown_tag`/`did_you_mean` — both resolve against the full vault-wide
    tag catalog, which would leak an out-of-scope tag's name across the
    scope boundary otherwise (REST skips the computation when scoped; MCP's
    tag-scope wrapper strips `warnings` from a scoped response).
  - **Structured invalids.** `limit`/`offset` negative or non-numeric, and
    an unparseable date value in a bracket date filter
    (`meta[created_at][gte]=not-a-date`), now 400 with
    `error_type: "invalid_query"` + `{field, got, hint}` — REST and MCP
    both, from one shared validator in `core/src/notes.ts:queryNotes`. A
    malformed cursor's `cursor_invalid` message now states the bootstrap
    flow explicitly instead of just "this is broken."
  - **Cursor bootstrap (the P1).** `cursor` is now keyed on PRESENCE, not
    truthiness — `?cursor=` / `cursor: ""` engages the `{notes,
    next_cursor}` envelope on the FIRST call (no watermark yet); an
    OMITTED `cursor` stays today's plain flat array. Before this fix
    `if (cursorParam)` (REST) / `params.cursor.length > 0` (MCP) treated an
    empty string exactly like "no cursor," so a documented bootstrap flow
    (`core/src/mcp.ts`'s `query-notes` description) was never actually
    reachable — the first call could never obtain a cursor.
  - **Tags 404.** `GET /api/tags/{name}` and `GET /api/tags?tag=<name>`
    (REST) and `list-tags({tag})` (MCP) now return a structured
    `tag_not_found` (404 for REST; a returned error object for MCP,
    matching the existing note-not-found convention) instead of
    synthesizing an all-null 200, when a tag has no identity row AND no
    notes carry it. `did_you_mean` names a close match when one exists,
    restricted to the caller's allowlist for a tag-scoped session.
  - **`expanded_count`.** `list-tags` (REST + MCP) now reports
    `expanded_count` alongside the literal `count` — distinct notes
    matching the tag OR any subtypes-axis descendant, computed in one pass
    over `note_tags` (no N+1 per tag) via
    `core/src/tag-hierarchy.ts:computeExpandedTagCounts`. Fixes a parent
    tag whose notes are all tagged with a more specific child reporting
    `count: 0`.
  - **find-path hydration (additive).** `find-path` (REST + MCP) gains
    `nodes: [{id, path}]` (mirrors `path[]`, hydrated) and
    `edges: [{source, target, relationship, sourcePath, targetPath}]`
    (self-contained hop list) alongside the original `path`/`relationships`
    shape, unchanged.
  - Wire-shape changes are all additive except the cursor-bootstrap
    behavioral fix (a `?cursor=`/`cursor: ""` call that previously got a
    flat array now gets an envelope) and the tags 404 (previously 200).
    Both are called out per the umbrella issue's compat note ("limit/date/
    cursor errors behavioral; tags 404 breaking-lite — rides the 0.7.0
    train").
  - **Review folds (same rc):** (1) the MCP `list-tags` single-tag path is
    now tag-scope enforced in the server wrapper (`src/mcp-tools.ts`) — an
    out-of-scope name returns bare `tag_not_found` with no record fields
    and no `did_you_mean` (also closes vault#560's pre-existing
    full-record leak for existing out-of-scope tags), and an in-scope
    miss drops any suggestion outside the allowlist; (2) `unknown_tag`
    warnings reuse the store's cached tag hierarchy and skip the
    `note_tags` membership query entirely when every input tag has an
    identity row (the common case costs ~nothing); (3) `unknown_tag`
    warnings are capped at 8 per query with a `warnings_truncated`
    marker (`suppressed` + `limit`) so a garbage tags array can't inflate
    the `X-Parachute-Warnings` header unboundedly; (4) `?format=graph`
    now carries `warnings` inline in the `{nodes, edges}` body (docs said
    so; code only set the header); (5) the live-subscription cursor guard
    (`cursor: ""` rejected, omitted accepted) is now pinned by tests;
    (6) the admin SPA's `getTagRecord` returns null on the new 404
    (TOCTOU: tag deleted between list load and click) and the schema
    editor degrades to the pre-#550 empty-record view instead of the
    generic error banner.

## [0.7.0-rc.1] - 2026-07-09

### Added

- **Contract test suite for the Reliability & Usability Program (issues
  #550–#556).** The 2026-07-09 nine-persona deep test (9 sandboxed agents,
  8 fresh vaults, ~230 notes, every claim independently reproduced against
  the REST API) verdict: the storage/concurrency core is trustworthy —
  zero server errors, zero corruption, zero lost writes — while the
  failure modes concentrate at the query/taxonomy/error boundaries. This
  PR is "tests before fixes" (program phase 1): six new test files encode
  every finding as an executable contract before any production code
  changes. Behavior that is correct today gets a normal passing test,
  locking it in as contract (search literal-quoting, the tag `expand`
  axis, `delete-tag`/`renameTag` cascades, well-typed indexed-field range
  queries, the merge-patch metadata contract, `path_conflict`/`conflict`/
  `schema_validation`/`precondition_required` structured errors, and the
  append/if_updated_at/state_transition concurrency guarantees). Behavior
  that is confirmed broken gets a `test.todo("#NNN: …")` entry naming the
  target behavior and the tracking issue, so later waves flip each one to
  a real passing test against an already-red baseline:
  `src/contract-search.test.ts` (#551),
  `src/contract-honest-queries.test.ts` (#550),
  `src/contract-errors.test.ts` (#554),
  `core/src/contract-taxonomy.test.ts` (#552),
  `core/src/contract-typed-index.test.ts` (#553),
  `core/src/contract-concurrency.test.ts` (no todos — pure lock-in of
  verified strengths, #555). No production source changed in this PR.

## [0.6.4-rc.7] - 2026-06-27

### Removed

- **BREAKING: the flat HTTP date-filter query params are removed (vault#288).**
  `?date_field=…&date_from=…&date_to=…` (targeted) and the legacy bare
  `?date_from=…&date_to=…` (implicit `created_at`) are no longer parsed on
  `GET /notes` (or the shared `/subscribe` route) — they are now **silently
  ignored**. A request that passes only the flat shape comes back **unfiltered**
  (not an error), so external callers relying on the flat params will get more
  rows than before. Migrate to the bracket-style filter, which is functionally
  complete (full half-open range): `date_field=created_at&date_from=X&date_to=Y`
  → `meta[created_at][gte]=X&meta[created_at][lt]=Y`. The deprecation shipped in
  0.4.3. **Unaffected:** the bracket-style `meta[...]` date filter and the MCP
  `query-notes` `date_from` / `date_to` shorthand (a separate, supported MCP
  convenience for `date_filter: { field: 'created_at', … }`).

## [0.6.2-rc.1] - 2026-06-23

### Changed

- **`parachute-vault init` no longer writes the Claude Code MCP config
  (`~/.claude.json`) by default — it's opt-in now.** This aligns the install
  code with the updated website messaging (the site no longer claims "Claude
  Code is auto-configured"). init's job is to get the operator to the web setup
  wizard and SURFACE the self-serve connection info, not to silently write a
  config file as a side effect. The post-install summary now (1) leads with the
  web setup wizard URL (`<hub-origin>/admin/setup`), and (2) always surfaces the
  connector URL (`<hub-origin>/vault/<name>/mcp`) plus a ready-to-paste
  `claude mcp add --transport http parachute-vault <url>` command — so a Claude
  Code user opts in by copy-paste. Opt into the auto-write with
  `parachute-vault init --configure-claude-code` (aliases `--mcp-install`,
  `--mcp`); `--no-mcp` remains the explicit "don't." Previously init prompted
  default-yes in a TTY and defaulted to **yes** when non-interactive (piped
  installs), so the new default is a behavior change for both paths — the
  connect info is printed for copy-paste instead. The standalone
  `parachute-vault mcp-install` command is unchanged and remains the canonical
  explicit opt-in path.

## [0.6.1] - 2026-06-12

### Added

- **Guided GitHub App install flow for the mirror "Back up to GitHub"
  surface (#481, #484).** The shared Parachute GitHub App's `client_id` now
  ships as the build default (#481), and the connect flow understands
  GitHub-App semantics — authorization and installation are separate steps
  (#480): an install probe (`GET /user/installations`) detects
  authorized-but-not-installed and links to the app's install page, the
  repo picker unions installation repos so org repos appear, linking a
  repo turns history on for pre-#440 vaults (#483), and bring-your-own-app
  is a documented override pair (`PARACHUTE_GITHUB_CLIENT_ID` +
  `PARACHUTE_GITHUB_APP_SLUG` — set both or neither).
- **Content range / pagination — bounded reads for large notes (Benjamin's
  spec).** `query-notes` (MCP) and the REST `GET /notes` family (point read,
  `?id=`, structured list, search) accept `content_offset` (default 0) +
  `content_length` (byte budget, min 4). When either is set, the returned
  `content` is a byte slice and the response gains `content_offset`
  (effective start), `content_total_length`, and `content_next_offset`
  (`null` when complete) — so MCP clients can read notes too large to
  return in one response by looping `content_next_offset` back in as
  `content_offset`. Unit is UTF-8 bytes; slices always end on a codepoint
  boundary *within* the budget (never over; up to 3 bytes under when a
  multi-byte character straddles the cut), and an offset landing
  mid-codepoint aligns down to the codepoint's leading byte, so
  concatenating the slices reconstructs the content byte-for-byte (pinned
  by a property test). On list queries the same window applies to each
  note's content independently; with `expand_links=true` the range applies
  to the expanded content. Range params on a content-less shape
  (`include_content=false`, or a list left on its lean default) error
  loudly (`INVALID_QUERY` / 400) rather than silently no-op. Responses
  without range params are byte-identical to before. (#486)

### Performance (query path — the 2026-06-10 measurements)

- **Tag/list queries no longer materialize every candidate row.**
  `queryNotes` expressed tag membership as `JOIN note_tags` + `SELECT
  DISTINCT n.*`, which forced every candidate's full row (content included)
  through a temp B-tree before LIMIT applied — cost scaled with rows
  *scanned*, not returned (limit 5 ≈ limit 80). Tag membership is now a
  semijoin (`n.id IN (SELECT note_id FROM note_tags …)`), DISTINCT is gone,
  and the query runs as a two-phase "deferred join": phase 1 selects only
  the page of ids, phase 2 fetches full rows for ≤ limit ids and hydrates
  tags in one batched query instead of one per note. 20k-member tag scan:
  158ms → 23ms; the per-returned-note tag N+1 is gone everywhere
  (`queryNotes`, `searchNotes`, `getNotes`).
- **Plain `{field: value}` metadata equality rides the index when the field
  is indexed.** Previously only the operator form (`{field: {eq: v}}`) used
  the generated column; the plain form paid a full-table `json_extract`
  scan on the very same field. Plain equality now prepends an indexed
  prefilter conjunct while keeping the original `json_extract` clause as a
  residual predicate — result-identical to the scan by construction (pinned
  by a twin-field property test over edge values: numbers, null, nested
  objects, numeric-looking strings). Zero-match worst case at 25k notes:
  28.7ms → 0.04ms.
- **`include_links` hydration is batched per page.** The MCP and REST list
  paths called `getLinksHydrated` per note — 1 link query + 1 summary query
  + one tag query *per linked note*, per result. New
  `getLinksHydratedForNotes` hydrates the whole page in a constant number
  of queries (two indexed IN-scans over `links` per chunk + one summary
  fetch + one batched tag lookup); link-summary hydration inside
  `traverseLinks`/`near` also drops its per-summary tag N+1.
- **Schema v22: composite index `notes(updated_at, id)`.** Cursor keyset
  pagination (vault#313) and `date_filter` on `updated_at` were full table
  scans + sorts; the keyset poll now seeks straight to the watermark.
  25k-note cursor poll: 378ms → 0.4ms. The v22 migration runs automatically
  at first boot on 0.6.1. (#485)

## [0.6.0] - 2026-06-09

Shipped without a changelog roll — this entry is backfilled. The block
below is what had accumulated in `Unreleased` at tag time; the release
also carried the hub-module boundary wave (`/vault/admin` multi-vault
home, reserved-name validators — PR #473). Per-PR detail lives in git
history.

### Fixed

- **JWKS hairpin through the public Cloudflare tunnel (vault#464).** Vault now
  fetches the hub's JWKS from the **local** hub (loopback
  `http://127.0.0.1:1939`) by default instead of from the public `iss` origin,
  so a co-located vault no longer hairpins the keys fetch out through the
  Cloudflare tunnel and back to the same box after `parachute expose` (which
  timed out the first MCP-over-public auth). `iss` is still validated against
  `PARACHUTE_HUB_ORIGIN`; a vault on a separate box from its hub overrides the
  fetch origin with the new `PARACHUTE_HUB_JWKS_ORIGIN` env var. Bumps
  `@openparachute/scope-guard` → `0.4.1-rc.1` for the `jwksOrigin` seam.
  (#465)

## [0.5.2] - 2026-06-06

The `0.5.2-rc.1` through `rc.5` chain promoted to stable. This entry was
backfilled retroactively from the [GitHub Release notes](https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.5.2);
per-rc detail lives in GitHub Releases / git history.

### Changed (lifecycle & init — the hub-as-supervisor alignment)

- **Hub-aware init.** `parachute-vault init` guidance branches on hub
  presence — no more circular "install the hub and re-run" advice when the
  hub itself spawned the init, and accurate connectivity copy under
  hub-as-issuer (#445).
- **Autostart defaults off under a hub supervisor.** Init no longer
  registers a competing launchd/systemd daemon when a hub manages the
  lifecycle — closing the port-1940 race behind `EADDRINUSE` crash-loops and
  `unexpected "iss"` token rejections ([parachute-hub#580](https://github.com/ParachuteComputer/parachute-hub/issues/580)).
  Standalone installs still register a daemon; explicit
  `--autostart` / `--no-autostart` always win.
- **Honest admin banner.** Signed-in non-admin users see "vault management is
  restricted to the hub admin" with a link to their account home, instead of
  a misleading "you're not signed in" loop (#451, PR #452).
- The "Blocked 1 postinstall" warning on `bun add -g` is gone
  ([parachute-hub#568](https://github.com/ParachuteComputer/parachute-hub/issues/568)).

### Fixed (security & data)

- **Tag-scope confidentiality.** Closed `expand_links` / wikilink content +
  metadata leaks across tag-scope boundaries (#438).
- **OAuth-first create.** `vault create` no longer auto-mints a shared
  `vault:admin` token (#442/#443).
- Per-vault **usage endpoint** for data-footprint monitoring (#437).
- New vaults default to an **internal live mirror** (version history on from
  day one; opt-out via `default_mirror`) (#440).
- Transcription safety: memo content is never destroyed and legacy in-body
  memos are retried (#434); optimistic concurrency on memo re-stamps (#436).

### Added / Changed (API)

- `GET /api/notes` accepts a `?metadata=<json>` filter alias (previously
  silently dropped) (#426).
- Updates echo hydrated links on the response (REST + MCP) (#429).
- Opt-in `link_count` field + `order_by=link_count` (#430).
- Tag `relationships` is an opaque vocabulary map (#428/#431).
- Storage GET accepts `%2F`-encoded slashes in serve paths (#433).

### Changed (UI)

- Backup UI leads with version-history-on + "Back up to GitHub"; presets and
  raw fields tucked under Advanced (#447).

### Upgrading from ≤0.5.1

If vault previously ran as its own daemon, remove the old unit once (see the
[hub 0.6.4 release notes](https://github.com/ParachuteComputer/parachute-hub/releases/tag/v0.6.4)
for the exact commands) and let the hub supervisor own the lifecycle.

## [0.5.1] - 2026-05-31

The `rc.1` / `rc.2` chain, plus one post-rc.2 fix (#424), promoted to stable.
Backfilled retroactively; per-rc detail in GitHub Releases / git history.

### Fixed

- **Obsidian import alignment.** Aligned the CLI Obsidian parser's behavior
  with the Notes-UI web importer so the two import paths agree on a shared
  behavior contract (#424).
- **Browser MCP CORS.** Expose `WWW-Authenticate` (and `Mcp-Session-Id`) via
  CORS so browser-based MCP clients can read the auth-challenge headers (#421).

### Changed

- The MCP connect-time brief now points at the public scripting guide so
  agents are oriented toward the HTTP API / scripting path (#422).

## [0.5.0] - 2026-05-29

The `0.5.0-rc.1` through `rc.5` chain promoted to stable. The BREAKING `pvt_*`
removal is documented in the `0.5.0-rc.1` entry below; this entry completes the
chain (rc.2–rc.5). Backfilled retroactively; per-rc detail in GitHub Releases /
git history.

### Fixed

- **CORS `PUT` allowed.** Added `PUT` to `Access-Control-Allow-Methods` so the
  Notes tag/schema setup flow works from the browser (#419).
- **Per-vault OAuth discovery advertises resource-narrowed scopes** —
  follow-on to the vault#282 resource-server work (#417).
- **Friendly git-not-installed error** for import + sync, instead of a raw
  failure, when `git` is missing (#415).

### Added

- **Auto-enable sync to the imported repo.** Importing from a git repo now
  enables sync to that repo by default (opt-out) (#416).

See the `0.5.0-rc.1` entry below for the BREAKING `pvt_*` token removal that
headlines this release.

## [0.5.0-rc.1] - 2026-05-28

### Removed (BREAKING — vault#282 Stage 2)

- **`pvt_*` opaque tokens are dropped.** Vault is now a pure hub
  resource-server: it no longer mints or validates `pvt_*` vault-DB tokens. A
  `pvt_*`-prefixed bearer now **fails closed with 401** on both the per-vault
  and global (`/vaults`) auth surfaces. The surviving auth paths are
  hub-issued JWTs, the `VAULT_AUTH_TOKEN` server-wide operator bearer, and
  legacy `vault.yaml` / `config.yaml` api_keys.
- Removed the REST `POST|GET|DELETE /vault/<name>/tokens` module (pure
  resource-server — minting is hub's job).
- Removed `parachute-vault tokens create` (mint a hub JWT via
  `parachute-vault mcp-install` or `parachute auth mint-token` instead).
  `tokens list` / `tokens revoke` remain for cleaning up vestigial pre-0.5.0
  rows.
- Removed `mcp-install --legacy-pat` and the interactive walkthrough's
  "legacy" auth choice. Without a hub, `mcp-install` falls back to pasting an
  existing bearer (`--token`) or `VAULT_AUTH_TOKEN`.
- Removed the SPA "Legacy tokens" (pvt_*) read/revoke panel.
- Dropped the dead store functions `generateToken`, `createToken`,
  `resolveToken`, `ResolvedToken`, `listMcpMintedTokens`, `softRevokeMcpToken`
  and the Stage-1 `warnPvtDeprecationOnce` deprecation-warning machinery.

### Changed

- **Fresh-vault first credential.** `parachute-vault create` / `init` now mint
  a hub JWT (`vault:<name>:admin`) when a hub is reachable (operator.token +
  hub origin — the same path `mcp-install --mint` uses). With no hub reachable
  they issue no token and print guidance (install the hub, or set
  `VAULT_AUTH_TOKEN`). The `create --json` `token` field stays a string (a hub
  JWT, or `""` with a new `token_guidance` field in the standalone case).
- `/auth/status` `auth_modes` now reports `["hub_jwt"]`.

### Kept (data migration)

- The `tokens` table is **not** dropped — it's left inert as the legacy-YAML
  import landing zone (`migrateVaultKeys`) and a future-cosmetic-drop target,
  matching the `oauth_clients` / `oauth_codes` precedent. Existing `pvt_*` rows
  stay in place (harmless; nothing validates them). No schema migration ships
  for the DROP.

See [UPGRADING.md](./UPGRADING.md) (pvt_* removal section) and
[parachute-patterns/migrations/2026-05-28-pvt-token-drop.md](https://github.com/ParachuteComputer/parachute-patterns/blob/main/migrations/2026-05-28-pvt-token-drop.md).

## [0.4.8-rc.10] - 2026-05-26

### Fixed

- **`selfRegister` now derives `health` from the primary vault path instead of hardcoding the manifest template (#369).** Pre-fix, `selfRegister` wrote `health: manifest.health` verbatim — where `manifest.health` is the placeholder template `/vault/default/health` from `.parachute/module.json`. The `paths` array was already built dynamically via `buildVaultServicePaths`, so a vault named anything other than `default` (caught in the wild on a Render rebuild walkthrough with a vault named `vault`) produced `paths: ["/vault/vault"]` paired with `health: "/vault/default/health"`. Hub's per-module health probe targets the configured `health` URL and 404'd on every probe even when the vault was healthy. Health is now `paths[0] + "/health"`. The change-detection comparison was updated to compare against the derived value so idempotent re-registers don't log spurious "changed" lines.

## [0.4.8-rc.9] - 2026-05-25

### Added

- **Vault declares `uiUrl: "/admin/"` in `.parachute/module.json` (workstream C of the UX audit).** Vault now ships the multi-instance form of `uiUrl` per the just-merged [patterns/module-ui-declaration.md](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/module-ui-declaration.md) flip (vault#367). Hub's well-known fan-out (hub#371) prepends each instance's mount path so `/vault/<name>/admin/` surfaces as a discovery tile per vault. Replaces the previously-hardcoded "Browse Vault" tile in hub.ts; the operator surface is now data-driven from this declaration.

### Removed (BREAKING)

- **Retired vault's standalone OAuth issuer (workstream E of the UX audit; Aaron's decision 2026-05-25).** Vault is OAuth resource-server-only now; the hub is required to drive any browser-based OAuth flow. Concrete changes:
  - Deleted `src/oauth.ts` (the DCR + authorize + token + consent-page surface) and `src/oauth.test.ts` (~3.1k lines combined). The end-to-end OAuth-flow tests in `src/auth.test.ts` were also retired.
  - `/vault/<name>/oauth/{register,authorize,token}` now returns `410 Gone` with a `protected_resource_metadata` pointer so disoriented clients can rediscover the new issuer.
  - The per-IP rate limiter on the consent POST was retired (no traffic to limit on a route that no longer exists).
  - The discovery endpoints `/vault/<name>/.well-known/oauth-{protected-resource,authorization-server}` (both path-append and path-insert RFC 8414/9728 shapes) stay live, but the metadata they return now unconditionally forwards every authorization-server endpoint to the hub origin (resolved via `PARACHUTE_HUB_ORIGIN`, defaulting to the canonical `http://127.0.0.1:1939` loopback).
  - **Behavior change — discovery is now unconditionally hub-rooted.** Pre-PR, the authorization-server metadata branched on whether `PARACHUTE_HUB_ORIGIN` matched the incoming request's origin: a loopback-probing client got loopback-rooted metadata back, an external probe got hub-rooted metadata. Post-PR, the AS metadata is **always** hub-origin — the request-derived issuer URL is no longer honored. Only the PRM `resource` URL still respects `x-forwarded-*` headers (it identifies *this vault*, not the issuer). This affects loopback-probing scripts that expected the discovery doc to mirror the probed origin, and operators behind a reverse proxy who had relied on the prior request-origin-matching branch.
  - Discovery moved to a new `src/oauth-discovery.ts` (~90 lines, was the only thing keeping `oauth.ts` around).
  - The `oauth_clients` + `oauth_codes` SQLite tables are left in place (harmless when empty; cleanup is a future migration so operators upgrading from a hot-write vault don't lose pending rows mid-upgrade).
  - The CLI commands `parachute-vault set-password` and `parachute-vault 2fa *` are kept as compat surfaces — they still write to the legacy YAML fields (`owner_password_hash`, `totp_secret`) because hub's `parachute expose public` posture-check reads them — but they print a deprecation warning and no longer gate any auth flow inside vault. Retirement of those YAML fields is a follow-up issue tracked alongside hub's posture-check rewrite.

  The visible motivation: vault's consent page rendered with `#0066cc` blue + Helvetica + an owner-token field that looked like a different product, on a configuration that hub-as-portal was supposed to obsolete. The audit (`parachute-hub/AUDIT-UI-UX.md` §2.4 + §6 Q1) flagged it as "the worst of both"; Aaron chose retirement over reskin.

  See [`UPGRADING.md`](./UPGRADING.md#workstream-e--standalone-oauth-retired) for the operator-facing migration guidance. Vault data, the `tokens` table, CLI-minted `pvt_*` tokens, and hub-issued-JWT validation are all unchanged — only the browser-based OAuth handshake moved to the hub.

## [0.4.8-rc.8] - 2026-05-25

### Fixed

- Unblock Linux release CI for the `web/ui/dist` shipping fix (rc.7 was burned — release CI failed at the test gate before publish; rc.8 re-issues the same payload with the test fixes below). Two pre-existing Linux-only test bugs that had never surfaced because vault tests had never run on Linux until vault#361's tag-triggered workflow landed:
  - **`runBackup` wrote the tarball into the directory it was reading.** `assembleTarball` runs `tar -czf <out> -C <stagingDir> <entries>` where `entries = readdirSync(stagingDir)`. The prior layout put the output at `stagingDir/__out__/<name>.tar.gz`, so `__out__` was in `entries` and tar enumerated the subdir while also writing to it. GNU tar (Linux) treats "file changed as we read it" as fatal; BSD tar (macOS) tolerates the race. Fix: write the tarball to a sibling tempdir, completely outside tar's input set. Affects 3 backup integration tests + 1 `vault backup` CLI test.
  - **`seedVaultWithNotes` polluted `process.env.HOME` without restoring it.** The helper sets HOME so the deferred re-import of `vault-store.ts` reads the test's isolated PARACHUTE_HOME. It never restored either env var, so the polluted value leaked into `resolveInstallTarget` tests in the same process — that function reads `process.env.HOME` directly (Bun caches `os.homedir()` at process start). Fix: capture HOME/PARACHUTE_HOME at module load, restore in afterEach of every describe that calls `seedVaultWithNotes`. Affects 2 install-target tests.

  Closes vault#363.

## [0.4.8-rc.7] - 2026-05-25

### Fixed

- Ship the built admin SPA bundle (`web/ui/dist/`) in the published npm tarball. Previously, any vault installed via `bun add -g @openparachute/vault` (e.g. hub's supervised vault on cloud deploys) hit a 503 on `/vault/<name>/admin/*`: "vault admin SPA bundle not found — run `bun run build` in web/ui/ to produce dist/". The 503 came from `src/admin-spa.ts` finding no `web/ui/dist/` on disk because `package.json` `files:` never shipped the SPA bundle and there was no build hook. PR adds `web/ui/dist` to `files:`, a `build:spa` script, a `postinstall` (gated on `web/ui/` existing — no-op for npm-installed consumers), and a `prepack` so the SPA always rebuilds before publish. Mirrors hub's pattern. Closes vault#362.

## [0.4.8-rc.6] - 2026-05-23

### Removed

- Dropped `kind` field from the `/.parachute/info` runtime endpoint response. Companion to vault#359's module.json drop — kind is no longer part of vault's external contract. Closes part of hub#340.

## [0.4.8-rc.5] - 2026-05-23

### Removed

- Dropped `kind` field from `.parachute/module.json`. Hub's validator made the field optional in hub#327; this PR completes the cleanup per hub#330 Phase B (kind retirement). No behavior change — vault was never branched-on by kind.

### Changed

- `VaultModuleManifest.kind` is now optional (mirrors hub#327's posture). The required-field check on `health` was split out of the prior combined `health`/`kind` validation. Legacy manifests still ship-and-parse fine; new manifests omit the field. Deprecation note added in the type docstring.
- `self-register.test.ts` fixture dropped `kind` to match the new canonical manifest shape.

## [0.4.8-rc.4] - 2026-05-21

feat(vault): enable WAL mode for multi-process SQLite concurrency (#326).

The vault SQLite database now runs in **WAL** (write-ahead logging) journal
mode by default. Before this change `journal_mode` defaulted to the SQLite
classic `DELETE` rollback journal — fine for a single-process daemon, but
incompatible with concurrent multi-process access patterns. `parachute-runner`
polling `tag:job` while the user writes notes through the running daemon is
exactly that pattern, and `vault#323`'s `daemon-busy` guard on `import` was
the symptom: a second connection couldn't get past the writer's lock.

Under WAL: a single writer plus an arbitrary number of concurrent readers
all see consistent snapshots. The new `applyConnectionPragmas` helper in
`core/src/schema.ts` is invoked on every Database open via the existing
`initSchema` entry point and the refactored `openVaultDb` — it sets:

  - `PRAGMA journal_mode = WAL`
  - `PRAGMA synchronous = NORMAL` (safe + recommended pairing per SQLite docs)
  - `PRAGMA wal_autocheckpoint = 1000` (explicit default — 1000 pages ≈ 4MB)
  - `PRAGMA foreign_keys = ON`

It also verifies WAL actually took effect (capturing the return value of
the `PRAGMA journal_mode = WAL` statement) and logs a one-time `[vault]
WAL mode could not be enabled` warning when an underlying filesystem (NFS,
some FUSE / Docker volume drivers) silently refuses the WAL flip. Operators
on those filesystems retain single-writer semantics and now know it.

**Backwards compatibility**: existing vaults created in DELETE journal mode
are migrated to WAL on next open by SQLite itself — no data migration, no
schema bump. **Backup compatibility**: `parachute-vault backup` already
uses `VACUUM INTO` (WAL-safe by design), so the snapshot/restore path is
unchanged. Manual hand-copies of `vault.db` should now also copy the
`vault.db-wal` and `vault.db-shm` sidecars if the database is open and
in-flight — documented in `README.md`.

Long-term followup tracked at vault#326 is the **single-writer** rail
(option 2 in the original issue): route the CLI's write-side commands
through the daemon's HTTP/MCP surface when the daemon is running, so two
processes never compete for the writer slot. This PR delivers option 1
(the read-side win) so multi-reader patterns like `parachute-runner` work
today; the writer-routing piece stays on the roadmap.

## [0.4.8-rc.3] - 2026-05-21

feat(vault): self-register manifest + installDir at startup (#266).

POC for retiring `parachute-hub`'s `FIRST_PARTY_FALLBACKS[vault]` vendored
manifest. Hub currently ships a hard-coded `VAULT_FALLBACK` block in
`service-spec.ts` because (a) bun-link dev mode never runs the hub install
path so `installDir` isn't stamped on the services.json row, and (b) v0.5
vault didn't ship its own `.parachute/module.json` so hub had no manifest
to read at lifecycle time. The endgame — every first-party module
self-registers its manifest + installDir on startup, hub's vendored
fallbacks retire one by one — starts here.

### What ships

- **`src/module-manifest.ts`** — narrow reader for the package's own
  `.parachute/module.json`. Resolves the package root via
  `import.meta.url` (works for both `bun src/cli.ts` dev runs and the
  published-package `parachute-vault` binary). Validates only the fields
  vault stamps onto services.json today (name, manifestName, displayName,
  tagline, kind, port, paths, health, stripPrefix); full validation is
  hub's job at install time.
- **`src/self-register.ts`** — boot-time self-registration. Reads the
  local manifest + computes installDir (the directory containing
  `package.json` + `.parachute/module.json`) and upserts a row into
  `~/.parachute/services.json` carrying both. Idempotent: re-runs report
  `changed: false` when nothing actually shifts. Routed through the
  existing merge-preserving `upsertService` so hub-stamped fields on the
  row (e.g. `installDir` from `parachute-hub#84`, anything future)
  survive each self-registration pass.
- **`src/server.ts` boot wires** `selfRegister({ version: pkg.version })`
  right after the vault auto-creation block. Failure modes (manifest
  missing, services.json unreadable, write failure) log a warning and
  continue — boot must not fail on bookkeeping.
- **CLI registration paths converge** — `cmdInit` and `cmdCreate`
  previously called `upsertService` directly with a hand-built entry that
  omitted displayName/tagline/stripPrefix/installDir. Both now route
  through `selfRegister` so the row from `parachute-vault init` matches
  the row from server boot. Drops two `upsertService` call sites and the
  duplicated `buildVaultServicePaths` (the helper moves into
  `self-register.ts` as the canonical implementation).

### Design choice — filesystem-direct rather than HTTP

In v0.6 (single-container, hub-as-supervisor) hub and vault share the
same filesystem; writing directly to `services.json` with the existing
merge-preserving `upsertService` is the simplest shape that works today
without growing a hub-side endpoint. v0.7 (multi-container cloud) will
need a hub `POST /api/modules/self-register` so a module on a different
container can register without filesystem access to the operator's
`~/.parachute/`. That endpoint is filed as a separate hub follow-up;
this PR's `selfRegister` function is forward-compatible — it's the
single seam that would swap from filesystem to HTTP transport.

### Forward-compatibility with hub's vendored fallback

`FIRST_PARTY_FALLBACKS[vault]` in hub remains in place until every
first-party module ships self-registration reliably (notes, scribe,
runner have their own follow-up issues). The fallback is additive today:
hub reads vault's `installDir` from the self-registered row when
present, and falls back to the vendored manifest only when the row is
missing — which is exactly the state a fresh `bun add @openparachute/vault`
produces before vault has booted once.

## [0.4.8-rc.2] - 2026-05-21

feat(vault): query-notes opaque cursor for since-last-checked agent loops (#313).

Agent loops (Gitcoin Brain, parachute-runner, any "give me what's new"
polling consumer) previously had to track an `updated_at` watermark
client-side and pass it back as `date_filter: { field: "updated_at",
from: <iso> }`. Brittle — wall-clock races at the millisecond boundary
could miss or double-count rows, and every consumer reinvented the
watermark bookkeeping.

`query-notes` now accepts an optional `cursor` parameter. The response
shape switches to `{notes, next_cursor}`; the cursor is opaque
(base64url-encoded JSON internally) and self-contained, so it survives
process restarts and works across deployments. Pass the `next_cursor`
back on the next call to receive only notes created or updated since
the prior page.

### What ships

- **New `cursor: string` parameter** on the `query-notes` MCP tool and
  the `GET /vault/<name>/api/notes` REST endpoint. When present, switches
  the response to `{notes, next_cursor}` and routes through a new
  `Store.queryNotesPaged()` method backed by keyset pagination on
  `(updated_at, id)` — the id is a tiebreaker for the rare two-notes-at-
  the-same-millisecond case so neither row is skipped nor doubled across
  page boundaries.
- **Cursor binds to the query** via sha256 of the result-set-affecting
  filters (tag, path, metadata, date filters, etc. — `limit`/`offset` and
  output-shape params are excluded). Reusing a cursor on a different
  query raises a structured `400 cursor_query_mismatch` rather than
  silently returning wrong rows.
- **`next_cursor` is always present**, even on an empty result page —
  the watermark advances only when actual rows are returned, so a
  polling agent can persist a single string and keep calling without
  special-casing the empty case.
- **Backwards compatible.** Existing callers (no `cursor` param) get
  the legacy flat-array shape; nothing changes for them. `dateFilter`
  remains the lower-level primitive for absolute date ranges — cursor
  and dateFilter coexist (cursor is "since last checked," dateFilter is
  "between X and Y").
- **Engine-level constraints**: cursor mode rejects `sort: desc` (a
  descending iteration would skip newly-written rows) and `order_by`
  (incompatible with the updated_at keyset). MCP-level: cursor is also
  rejected with full-text `search` (FTS has its own ordering) and
  `near` (graph neighborhoods aren't cursor-stable). All four return
  `400 INVALID_QUERY` so the agent loop fails loud rather than silent.

### Engineering notes

`core/src/cursor.ts` is the canonical home for the codec — `encodeCursor`,
`decodeCursor`, `computeQueryHash` (with stable key-order canonicalization
so SDK-side reshuffling doesn't invalidate cursors), plus the
`CursorError` class with `cursor_invalid` / `cursor_query_mismatch`
codes. Tests pin the codec in `core/src/cursor.test.ts`; integration
against `queryNotesPaged` lives in `core/src/core.test.ts` under
`describe("cursor pagination")`. HTTP plumbing tests in
`src/vault.test.ts` under `HTTP /notes` exercise the wrapped envelope,
the structured 400s, and an end-to-end resume across calls.

## [0.4.8-rc.1] — 2026-05-21

feat(vault): auto-transcribe voice uploads via scribe (vault#353).

Part 2 of the [vault↔scribe connection design](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-scribe-config-and-vault-scribe-connect.md)
(site#52). When an audio attachment lands in a vault — via Notes capture,
the REST API, or any other write path — and the operator has enabled
auto-transcribe, vault forwards the audio to scribe asynchronously and
materializes the result as a sibling `<attachment-path>.transcript.md`
note. Failures (no provider configured, scribe down, timeout) surface as
the same transcript note with `transcript_status: failed` plus the cause
in `transcript_error`. The original audio attachment is never deleted by
this path — it's preserved for retry.

### What ships

- **Inline audio-detect on attachment write.** `POST /vault/<name>/api/notes/<id>/attachments`
  inspects the incoming `mime_type`; when it starts with `audio/` AND
  `auto_transcribe.enabled === true` AND scribe is discoverable, the
  attachment is stamped with `transcribe_status: pending` +
  `transcribe_origin: "auto"`. The existing transcription worker picks it
  up via the `attachment:created` hook (single-digit-ms event-driven path)
  or the 30s sweep (safety net).
- **Service discovery via `~/.parachute/services.json`** (`scribe-discovery.ts`).
  Vault locates scribe by reading the canonical hub-maintained registry
  on first call; the `SCRIBE_URL` env var still wins when set. Cached
  for process lifetime; restart vault to pick up a re-registered scribe.
- **Bearer generation at first boot** (`scribe-env.ts:ensureScribeBearer`).
  When neither `SCRIBE_AUTH_TOKEN` nor the legacy `SCRIBE_TOKEN` is set,
  vault generates a 32-byte base64url bearer and persists it to
  `~/.parachute/vault/.env`. Idempotent — subsequent boots see the
  existing value and don't rotate. Operators are expected to mirror the
  generated bearer into scribe's `SCRIBE_AUTH_TOKEN`; without that
  mirror, transcription fails gracefully with a 401 captured on the
  transcript note.
- **Transcript-note materialization** (`transcript-note.ts`). The
  worker's auto-origin path writes a note at `<attachment-path>.transcript`
  with frontmatter linking back to the original audio:

  ```yaml
  title: Transcript of <filename>
  transcript_of: <attachment-path>
  transcript_attachment_id: <attachment id>
  transcript_status: complete | failed
  transcript_duration_ms: <ms>
  transcript_error: <cause — failed only>
  ```

  Body is the transcript text on success, empty on failure. Tags are
  `[transcript, capture]`. A typed link `transcript_of` is also
  materialized so vault graph queries surface the relation without
  walking frontmatter.
- **Retry endpoint.** `POST /vault/<name>/api/notes/<note-id>/retry-transcription`
  re-enqueues the original audio attachment by flipping its
  `transcribe_status` back to `pending` and kicking the worker.
  Validates the target is a failed transcript note, surfaces clear
  error branches (`invalid_target`, `not_failed`,
  `missing_attachment_id`, `attachment_missing`, `audio_missing`).
  202 on success. The same transcript note is overwritten in place;
  the note id is preserved across retries.
- **Config schema grows `autoTranscribe.*`** (`module-config.ts`). Three
  fields per the design's Q4:
  - `autoTranscribe.enabled` — boolean toggle, default false. Persisted
    in `~/.parachute/vault/config.yaml` under the new `auto_transcribe`
    block.
  - `autoTranscribe.scribeUrl` — readOnly. Effective value resolved
    per-process via `scribe-discovery.ts` (services.json or env override).
  - `autoTranscribe.scribeBearer` — writeOnly. Never returned by GET.
    Sourced from `SCRIBE_AUTH_TOKEN`.

  Legacy `scribe_url` / `scribe_token` are kept as deprecated aliases
  for one release so existing hub admin SPA renders don't regress.

### What's deferred to v0.7

- **Hub-issued JWT replaces the shared bearer.** The loopback shared
  secret is the v0.6 stepping stone per design Q2. Vault swaps the
  bearer for a hub-minted JWT with scope `scribe:transcribe` when
  hub-as-issuer lands; scribe's existing `hub-jwt.ts` validation seam
  is already in place. No wire-shape change — only the token contents.
- **Live-tail of transcription progress** (websocket / SSE from scribe).
  Today's flow is fire-and-write-when-done.
- **Audio retention `until_transcribed` polish.** Today's worker already
  honors the retention enum; no change needed for v0.6.
- **Auto-retry on transient 5xx with backoff cap.** Already implemented
  for the legacy worker path — extends naturally to auto-origin in a
  future PR.

### Versioning

`0.4.8-rc.1`. New rc chain for a feature PR (per governance Rule 2 —
RC versioning at the target stable, not as separate patches).

## [0.4.7-rc.3] — 2026-05-21

fix(vault): `mcp-install` admin-scope path no longer round-trips to hub
mint-token (which rejects it by policy).

### Symptom

Running `parachute vault mcp-install`, picking the `admin` option in the
interactive auth prompt, surfaced:

```
Hub mint-token rejected (HTTP 400, invalid_scope): scope vault:default:admin
is not requestable via mint-token; use OAuth flow or operator rotation
```

The mint-token endpoint has always rejected `vault:<name>:admin` — per-vault
admin is non-requestable by hub policy (see
[`parachute-hub/src/scope-explanations.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/scope-explanations.ts)'s
`VAULT_ADMIN_RE` + `api-mint-token.ts`'s non-requestable guard). It's mintable
only through the session-cookie-gated `/admin/vault-admin-token/<name>` SPA
endpoint. Vault's `mcp-install` flow shipped this latent bug since vault#291
introduced the `--mint` mode; it stayed latent until an operator exercised
the admin branch.

### Fixed

- **Interactive flow auto-routes `admin` → `legacy-pat`.** Picking "admin"
  at the auth prompt now mints a vault-DB `pvt_*` with full admin
  permissions (the right shape for a local MCP entry needing schema
  management) and prints a one-line explanation of the auto-route so the
  switch isn't silent. Prompt help text updated to telegraph the routing
  upfront.

- **Flag-driven `--mint --scope vault:admin` rejected pre-flight.** The
  combination errors out with an actionable remediation before any
  operator-token / hub-origin check, pointing at
  `--legacy-pat --scope vault:admin` (the working path) and naming the
  admin SPA at `<hub>/admin/vaults/<name>` for operators who'd rather use
  the browser path. The rejection happens locally — no hub round-trip.

- **Docs + help text.** The `mcp-install` function docstring, the inline
  `--legacy-pat` description in `parachute-vault --help`, and the
  interactive prompt's help block all now say "admin requires
  --legacy-pat" explicitly. Removes the trap where the help text listed
  `vault:admin` as a `--scope` choice with no caveat.

### Tests

- `src/mcp-install-interactive.test.ts` — the existing
  `"typing 'admin' produces vault:admin mint"` test was inverted: it
  pinned the buggy behavior. Replaced with a regression test that
  asserts (a) `mode === "legacy-pat"`, (b) `scope === "vault:admin"`,
  and (c) the user-facing explanation appears in the captured log.
- `src/mcp-install.test.ts` — new
  `"rejects --mint --scope vault:admin pre-flight"` test exercising
  Aaron's exact CLI invocation. Pins the remediation message wording
  (`--legacy-pat --scope vault:admin`) and verifies the reject fires
  *before* the operator-token / hub-origin checks (no "Hub unreachable"
  / "No hub origin configured" leak when the operator wasn't going to
  reach the hub anyway).

## [0.4.7-rc.2] — 2026-05-21

fix(vault): export detects case-collision on case-insensitive filesystems
(closes [#327](https://github.com/ParachuteComputer/parachute-vault/issues/327)).

The original 0.4.5-rc.2 fix landed silent auto-disambiguation —
`Journal/Foo.md` and `Journal/foo.md` would both export on macOS APFS
default, but the second note got an `__<id-short>` filename suffix with
no signal printed to the operator. The "silent" half of "silent note loss"
wasn't actually solved — operators with case-colliding vaults still had
no way to notice without poring through the typed `ExportStats` return.

This rc closes the gap two ways:

### Added

- **CLI surfaces case-collision auto-disambiguation explicitly.** When
  `parachute-vault export` lands on a case-insensitive filesystem and
  detects collisions, every disambiguated path now prints to stderr with
  a `Warning:` prefix + a one-line summary count + a pointer to the new
  `--strict-case-collision` flag and #327. Watch mode prints a per-cycle
  `[watch] case-collision: N disambiguated path(s) this cycle` line, so
  the moment a new collision appears in a running mirror loop, the
  operator sees it.

- **`--strict-case-collision` CLI flag + `failOnCaseCollision: boolean`
  on `ExportOptions`** — opt-in fail-fast. When set, the export pre-
  scans the (already-loaded) note list for lowercased-path conflicts
  before any write lands on disk and throws a typed `CaseCollisionError`
  naming every colliding path + the actionable instruction
  ("Rename one of them in the vault before re-exporting, or run from a
  case-sensitive filesystem"). N-way collisions
  (`Foo.md` + `foo.md` + `FOO.md`) and multi-group collisions
  (independent `(Bar, bar)` + `(Baz, baz)` pairs) both surface in a
  single error so the operator fixes the whole set in one pass — no
  paint-by-numbers re-export cycle.

- **`CaseCollisionError` exported from `core/src/portable-md.ts`** with
  a `collisions: Array<Array<{ note_id, path, extension }>>` field for
  programmatic callers. The CLI catches it in both single-shot and
  watch-initial paths, prints the actionable message, and exits non-zero
  so scripts catch failures deterministically.

### Decision: default remains auto-disambiguate; strict mode is opt-in

The 0.4.5 fix's auto-disambiguation path is preserved as the default
because (a) it's lossless — both notes land on disk with the canonical
path intact in frontmatter and round-trip cleanly through import, and
(b) hard-failing every cycle would block the new vault-sync mirror
loop ([#348](https://github.com/ParachuteComputer/parachute-vault/issues/348))
the moment a colliding pair appears, with no path forward but rolling
back the feature. Strict mode is the one-shot CLI flow's escape hatch
when the operator wants to be forced to fix the source-of-truth.

### Tests

Seven new tests under `core/src/portable-md.test.ts` →
`describe("case-collision detection (vault#327)")`:

- `failOnCaseCollision` throws `CaseCollisionError` with both paths +
  the actionable instruction enumerated in `.message`.
- `failOnCaseCollision` is a no-op when the FS is case-sensitive (probe
  override forces the path).
- `failOnCaseCollision` is a no-op on case-insensitive FS when nothing
  collides (single-note pre-scan walks clean).
- Three-way collision lists all three paths in the error.
- Two independent collision groups both surface.
- Directory-level case difference (`Notes/foo` vs `notes/foo`) is
  detected by the lowercased-path key.
- Default (no opt-in) still auto-disambiguates — back-compat contract
  pinned.

### Suite

- `bun test ./core/src/` — 536 pass (+7 over `rc.1`), 0 fail
- `bun test ./src/` — 1086 pass (unchanged), 0 fail
- `bun run typecheck` — clean
- `bunx biome check src/ core/src/` — clean

## [0.4.7-rc.1] — 2026-05-20

Phase A1 of the vault-sync arc — the persistent, vault-managed counterpart
to the manual `parachute-vault export --watch --git-commit` CLI mode that
shipped in `0.4.6` (#346). Vault now reads a `mirror:` block from
`config.yaml` at boot, bootstraps an internal or external git mirror per
the operator's choice, and (optionally) runs the export-watch loop
in-process — no external cron, no separate shell loop, no manual restart
after a config change. See the design doc:
[`parachute.computer/design/2026-05-20-vault-as-git-projection.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-20-vault-as-git-projection.md).

The CLI primitive from #346 is unchanged; this rc adds the persistent
form alongside it.

### Added

- **`mirror:` block in `config.yaml`** — eight fields (`enabled`,
  `location`, `external_path`, `watch`, `auto_commit`, `auto_push`,
  `commit_template`, `interval_seconds`). Default `enabled: false` so
  vaults upgrading across this PR boundary see zero behavior change
  until they explicitly opt in. Parsed alongside the existing top-level
  keys via the same hand-rolled YAML conventions as `triggers:` /
  `backup:`. Implementation: `src/mirror-config.ts`.

- **Boot-time mirror lifecycle** — when `mirror.enabled: true`, the
  vault server resolves the path, bootstraps an internal mirror if
  needed (`mkdir` + `git init` + initial commit), runs an initial
  full export to bring the mirror to current state, and (if
  `watch: true`) arms an in-process polling loop that re-exports +
  optionally commits on every interval. The watch loop reuses the
  `runGitCommitCycle` helper from #346 — same commit shape, same
  skip rules for `.parachute/`-only churn. Implementation:
  `src/mirror-manager.ts`.

- **Two mirror-location modes**:
  - `internal` → `~/.parachute/vault/data/<vault>/mirror/`. Vault-
    managed; recreated automatically if missing on next boot.
    Bootstrap refuses to clobber a pre-existing non-empty, non-git
    directory — operator chooses cleanup explicitly.
  - `external` → operator-picked path; must exist and be a git repo
    before vault attempts a write. Designed for Obsidian / GitHub /
    shared backups.

- **`GET /vault/<name>/.parachute/mirror`** — admin-gated read of the
  persisted mirror config + the runtime status (resolved path, watch
  status, last export timestamp, last commit sha, most recent error).
  Returns defaults when no `mirror:` block has been written yet so
  the future hub admin SPA always renders against a consistent shape.

- **`PUT /vault/<name>/.parachute/mirror`** — admin-gated update of
  the mirror config. Validates JSON shape + (when `enabled: true`)
  the external path exists and is a git repository. Atomic write to
  `config.yaml`, then in-process restart of the watch loop with the
  new shape — no vault restart needed. Disable-only `{enabled:
  false}` PUTs skip the path validation so an operator can disable
  a mirror whose path has gone missing. Errors are 400 with
  actionable messages naming the offending field.

- **`MirrorManager` lifecycle controller** — singleton per-process
  with `start` / `stop` / `reload` / `runNow` semantics, status
  tracking, and shutdown drain wired into the existing
  `SIGINT`/`SIGTERM` handlers. Dependency-injected `runExport`,
  `firstChangedNoteTitle`, `readMirrorConfig`, `writeMirrorConfig`
  for unit-testability — tests instantiate the manager directly
  without spawning a vault server.

- **URL note** — the design doc names the endpoint `/admin/mirror`,
  but `/vault/<name>/admin/*` is already mounted to the admin SPA's
  static-file bundle (#252). The mirror API lives under
  `.parachute/mirror` instead, sibling to the existing
  `.parachute/config` + `.parachute/info` per the module-protocol
  convention. The hub Phase A2 SPA (future PR) will call this URL
  directly.

### Out of scope for Phase A1

- Hub admin SPA page for configuring mirrors — Phase A2, future PR.
- Bidirectional sync (Architecture B from the design doc) — deferred
  pending demand signal.
- UI history surface in the vault SPA — Phase A1.5 or A2.

## [0.4.6] — 2026-05-20

Stable release covering the multi-user companion + Gitcoin Brain enablement. Cumulative changes since `0.4.5`:

- **`PARACHUTE_VAULT_NAME` env var** (#342): first-boot vault naming via env var. Replaces the hardcoded "default" so hub's wizard can thread the operator's typed vault name through to vault. Length-validated (2-32 chars).
- **`vault_scope` claim consumer** (#344): vault now enforces the `vault_scope` claim from hub-issued JWTs. A token with `vault_scope: ["aaron"]` reaching `/vault/bob/*` returns 403. Defense-in-depth at the resource server for multi-user Phase 1.
- **`parachute-vault mcp-config <name>` CLI** (#345): emits the inline MCP config JSON for `claude -p` runners. Eliminates per-script boilerplate.
- **`mcp-install --dry-run`** (#345): probe `mcp-install` without writing.
- **Doc fixes** (#345): mcp-install recommends `--install-scope user` for headless flows; README notes the Accept-header requirement for the local MCP endpoint.
- **`parachute-vault export --watch + --git-commit`** (#346): live mirror of vault to a markdown directory with optional auto-commit + auto-push. Enables Aaron's Gitcoin Brain vault-as-git-projection workflow.
- **Standalone `render.yaml` deprecated** (#342): per the v0.6 option-A architecture, vault doesn't deploy standalone. The file is retained for advanced users with a clarifying comment.

See individual rc entries below for full detail.

## [0.4.6-rc.6] — 2026-05-20

Aaron's Gitcoin Brain build wants vault as the system of record and a git
mirror as the auto-history projection — same shape as the `vault-portable-
export` cookbook's "git-as-projection" recipe, but live instead of cron-
driven. This rc folds the two missing primitives directly into the CLI so
the operator wires one command, not a cron + a webhook + a shell script.

### Added

- **`parachute-vault export <dir> --watch [--interval <seconds>]`** — stay
  alive after the initial export, re-export incrementally on every vault
  write. Detection is polling on `updated_at >= cursor` (vault writes are
  HTTP-mediated; the bun:sqlite DB is opaque to filesystem watchers, so
  polling is the simplest robust signal). Default interval 5s. Each cycle
  prints a tight status line — `[watch] exported N notes (cursor: ISO)` or
  `[watch] no changes`. Graceful shutdown on SIGINT/SIGTERM
  (`[watch] stopping watch`, exit 0).

- **`parachute-vault export <dir> --git-commit [--git-message-template <t>] [--git-push]`**
  — after each export, `git add -A` + `git commit -m <rendered-template>`
  in `<dir>`. Repo must already be initialized (fails fast with `git init`
  guidance, not after sitting in a watch loop emitting the same error every
  interval). Template variables: `{{date}}`, `{{notes_changed}}`,
  `{{plural}}` (empty when notes_changed === 1), `{{first_note_title}}`,
  `{{vault_name}}`. Default template:
  `export: {{date}} ({{notes_changed}} note{{plural}})`. Empty commits
  skipped; pure `.parachute/vault.yaml` `exported_at` churn (no real note
  changes) is detected and skipped too, so a watch loop doesn't grow a
  commit every interval. `--git-push` is non-fatal on failure — a network
  blip warns but doesn't kill the loop.

- **Combined `--watch --git-commit`** — the canonical Aaron-Gitcoin-Brain
  setup. Vault writes flow through to git history automatically with no
  cron, no webhook, no shell glue:

  ```bash
  parachute-vault export ~/projections/team-brain --watch --git-commit --git-push
  ```

  Drop that command in a launchd plist (or `parachute start`-style
  supervisor) and the git mirror tracks the vault.

### Implementation notes

- No new deps. `git add/commit/push` are shelled out via `Bun.spawn`.
  Helpers live in `src/export-watch.ts` (`renderCommitMessage`,
  `shouldCommit`, `runGitCommitCycle`, …) so they're unit-testable without
  spawning the full CLI.
- Watch loop uses `setInterval` with an in-flight guard so a slow cycle
  doesn't stack tasks. Cursor is captured *before* each export runs, so a
  write that lands mid-export is picked up next cycle (cost: at most one
  re-exported note when `updated_at` equals the cursor — `>=` semantics).
- Tests cover the pure helpers, the git shell helpers against real
  throwaway repos, and three CLI end-to-end scenarios:
  initial-export-only-on-idle, write-triggers-re-export, and the combined
  watch+git-commit happy path.

### Cookbook

The `parachute-vault export` recipe in
`parachute-patterns/cookbook/vault-portable-export.md` now has the
"live projection" idiom alongside the existing cron-driven version. The
git-projection design doc on parachute.computer goes long on when to
reach for which.

## [0.4.6-rc.5] — 2026-05-20

Three small wins surfaced while Aaron was wiring the Gitcoin Brain
runner (vault-as-job-substrate; a Python loop spawning
`claude -p --mcp-config '<json>'` against a vault). Each was per-script
boilerplate or a subtle footgun — folded into the CLI here.

### Added

- **`parachute-vault mcp-config <vault-name>`** — emits the JSON shape
  consumed by `claude -p --mcp-config '<json>'` to stdout. The runner
  pattern:

  ```bash
  export PARACHUTE_VAULT_TOKEN=pvt_...
  claude -p --mcp-config "$(parachute-vault mcp-config gitcoin)" \
            --strict-mcp-config ...
  ```

  Flags: `--token <bearer>` (alternative to `PARACHUTE_VAULT_TOKEN`);
  `--base-url <url>` (override the auto-detected origin, useful for
  tailnet-exposed hubs); `--env-vars` (emit the template form with
  `${PARACHUTE_HUB_URL}` and `${PARACHUTE_VAULT_TOKEN}` placeholders —
  safe to commit; shell-expanded at runtime). With no token and no
  `--env-vars`, exits 1 with a clear error: runners get a fail-fast,
  no surprise auto-minting. Literal mode verifies the vault exists
  locally; `--env-vars` mode is shape-only and works offline.

  The synthesizer lives in `mcp-install.ts:buildMcpConfigJson` so
  third-party tools that import vault as a library can reuse the
  shape. Tests in `mcp-config.test.ts` cover both modes + token
  precedence + base-url override + the no-token / unknown-vault
  error paths.

- **`mcp-install --dry-run`** — prints the write that would happen
  (target file, install scope, project key when local, entry key,
  resolved MCP URL, auth mode) without touching disk or hitting the
  hub for a mint. Aaron hit the inverse case: probing `mcp-install`
  was creating an empty `projects[<cwd>]` entry in `~/.claude.json`
  as a side effect. `--dry-run` is the deliberate "tell me what
  you'd do" path for scripts wiring up runners. Skips the
  operator-token check and the hub round-trip entirely — the point
  is "no side effects, including network."

### Changed

- **`mcp-install` success message + help text recommend
  `--install-scope user` for headless flows.** Local-scope MCP entries
  (under `projects[<cwd>].mcpServers` — the default since vault#290)
  are visible to interactive `claude` from the install directory but
  do **not** propagate to `claude -p` subprocesses spawned by scripts,
  even from the same directory and even with
  `--setting-sources user,project,local`. Operators wiring up runners
  need user-scope. The success-line heads-up on local installs now
  says so; the README cookbook has a "headless flows" subsection with
  the full explanation.

- **README — Troubleshooting: 406 on manual `curl` to
  `/vault/<name>/mcp`.** The MCP HTTP transport requires both
  `application/json` and `text/event-stream` in the `Accept` header
  (it negotiates between JSON response and the SSE streaming variant).
  Claude Code's `--mcp-config` http transport sets this automatically;
  the symptom only shows up when probing the endpoint by hand. Added
  a short troubleshooting entry with the working `curl` invocation.

## [0.4.6-rc.4] — 2026-05-20

Hub multi-user Phase 1 PR 5 — consumer-side adoption of the new
`vault_scope` claim hub mints on every JWT (per
[`2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/)).

### Added

- **`authenticateHubJwt` consumes the `vault_scope` claim** via
  scope-guard's new `enforceVaultScope` helper and refuses cross-vault
  access at the consumer with a **403 + `error_type:
  "vault_scope_mismatch"`** response. A token whose `vault_scope`
  claim names a different vault than the URL targets is rejected
  before any vault data is read. Defense-in-depth: hub's mint path
  (PR 4 / parachute-hub#283) already narrows scopes to the user's
  `assigned_vault`, and the existing audience strict-check + broad-
  scope rejection are the primary gates. The new claim adds a second
  pin against the case where a token-mint bug, manual edit, or
  third-party RS not enforcing the scope-string vocabulary correctly
  produces scope strings naming the wrong vault. Five new tests in
  `auth-hub-jwt.test.ts` cover the matching-pin happy path, the cross-
  vault attempt (403), admin tokens (`vault_scope: []`), pre-PR-4
  tokens (claim absent → unrestricted back-compat), and the ordering
  invariant that broad-scope rejection takes precedence over
  vault_scope_mismatch.

### Changed

- **`@openparachute/scope-guard` dep bumped from `^0.2.0` to
  `^0.3.0-rc.1`.** The 0.3.0 minor adds `HubJwtClaims.vaultScope:
  string[]` (parsed from the JWT's `vault_scope` claim; surfaces as
  `[]` when absent / malformed / explicitly empty) and the
  `enforceVaultScope(claims, requestVaultName)` helper. See
  [parachute-hub#285](https://github.com/ParachuteComputer/parachute-hub/pull/285)
  for the library release.

  **Install order**: scope-guard `0.3.0-rc.1` must publish to npm
  before `bun install` here will succeed. The lockfile auto-updates on
  first post-publish install; CI install fails until then.

## [0.4.6-rc.3] — 2026-05-20

Two small items bundled as one cohesive PR:

- **`PARACHUTE_VAULT_NAME` first-boot env var** — companion fix for the
  hub first-boot wizard (hub#267). When the server starts with zero
  vaults on disk and `PARACHUTE_VAULT_NAME` is set to a valid name, the
  auto-created vault uses that name instead of `"default"`. Validation
  reuses `validateVaultName` so the env var, the `--vault-name` flag,
  and hub's wizard all share one rule (lowercase alphanumeric +
  hyphens/underscores, `list` reserved). Invalid values trigger a
  warning and fall back to `"default"` rather than aborting first boot.
  First-boot log lines call out which path was taken:
  `[vault first-boot] using PARACHUTE_VAULT_NAME=<name>` or
  `[vault first-boot] using default name (no PARACHUTE_VAULT_NAME set)`.
- **Standalone `render.yaml` deprecated as primary path** (closes
  vault#341, Option A). The file stays in tree for the operators who
  specifically want vault as its own Render service, but the
  `render.yaml` header and the README's Deployment → Cloud platforms
  section now point the typical v0.6 user at the hub-managed Render
  deploy (`https://parachute.computer/deploy/render/`).

## [0.4.6-rc.2] — 2026-05-18

Fold reviewer nits on PR #340:

- **server.ts** — log `VAULT_AUTH_TOKEN` active state at startup
  (`[auth] VAULT_AUTH_TOKEN set — server-wide operator bearer active`),
  parallel to the existing `[transcribe]` boot signal. Operator gets a
  bare-minimum visible confirmation the gate is armed.
- **render.yaml** — comment that Render injects `$PORT` at runtime; the
  hardcoded `1940` value is the fallback for local `docker run`
  invocations.

## [0.4.6-rc.1] — 2026-05-18

Phase 1 of the v0.6 Render self-host arc (closes vault#339). Lands the
container-shape primitives vault needs to run as a sibling Render
service alongside hub:

- **Dockerfile + .dockerignore** — two-stage build mirroring
  parachute-hub's shape: `oven/bun:1.3-alpine` base, runtime stage with
  `tini` for SIGTERM forwarding, runs as non-root `bun` (uid 1000) with
  pre-chowned `/parachute` mount point. Build context pruned to
  runtime essentials; tests, docs, and the web/ui SPA tree are
  excluded.
- **render.yaml Blueprint** — one `web` service on the `starter` plan
  (persistent disks aren't available on Render's free tier), persistent
  disk mounted at `/parachute` so vault state survives container
  restarts. Health probe at `/health`. Env vars wired: `PARACHUTE_HOME`,
  `PORT`, `VAULT_BIND=0.0.0.0`, `VAULT_AUTH_TOKEN` (sync: false),
  `TRUST_PROXY=1`, optional `SCRIBE_URL`.
- **`VAULT_AUTH_TOKEN` server-wide operator bearer** — when the env
  var is set, a request with `Authorization: Bearer <value>` matching
  the env var (constant-time compare) authenticates as full/admin
  against any vault on the server. The minimum cross-container auth
  shape: hub (sibling Render container) uses this stable bearer to
  call vault's HTTP surface. When the env var is unset, vault's
  existing token surface (per-vault DB tokens, hub-issued JWTs, legacy
  YAML keys) is unchanged — full backwards compat for local
  self-hosters and `bun link` dev. The end-state hub-issued-JWT-only
  shape stays on the roadmap at vault#282.
- **`/health` invariant pinned** — always returns 200 regardless of
  `VAULT_AUTH_TOKEN` config so Render's health probe + Docker
  `HEALTHCHECK` stay green even before the operator has wired a
  bearer. The response shape (vault names leaked only to authed
  callers) is unchanged.

Deliberately deferred to follow-up PRs / issues:

- Multi-token operator model (one shared bearer fits the v0.6
  closed-beta; per-user operator tokens land alongside hub#258).
- Full hub-issued JWT integration on every endpoint — already shipped
  for the per-vault routes, but the operator-channel use case
  intentionally keeps a simpler shared-bearer path until the JWT-only
  endgame at vault#282.
- Building the admin SPA (`web/ui/dist`) into the container image. The
  503 fallback in `src/admin-spa.ts` covers the missing-bundle case
  and the operator-facing UI lives on hub for v0.6.

Gates on this PR:
- `bun test ./src`: 957 pass, 0 fail (was 941 pre-change).
- `bun run typecheck`: clean.

## [0.4.5] — 2026-05-15

0.4.5 closes the substrate cycle that started with the launch &
ecosystem-fit phase in late April 2026 — the load-bearing phase where
vault stopped being a self-contained server and became a pure OAuth
resource server inside the Parachute Computer ecosystem (URL migration,
CLI rename, filesystem restructure, hub-issued JWT validation, scope
enforcement, indexed metadata fields, atomic tag rename/merge,
server-side transcription). Across roughly four weeks, vault moved
from a working single-host prototype into a substrate-grade module
that round-trips losslessly to git, handles non-markdown content as
first-class, and lives behind a hub that issues, scopes, and revokes
its tokens. Stable promotes from `0.4.5-rc.2` after real-vault smoke
validation on a 2296-note default vault (zero silent loss,
byte-equivalent round-trip across markdown + CSV + sidecar). Same code
as rc.2; only the version suffix drops.

**Coming from 0.2.4?** See [UPGRADING.md](./UPGRADING.md) for the
operator migration guide — the direct upgrade is correctness-safe
(schema and filesystem migrations auto-run on first post-upgrade
boot), and the active-change list is short: CLI rename, URL prefix,
token audience binding, and one priv-esc audit.

Headline arc since 0.4.4:

- **File-extension support** (vault#328) — non-markdown notes as
  first-class citizens. CSV / YAML / JSON / MDX / .txt / etc. carry an
  `extension` field; metadata is inline for frontmatter-compatible
  formats (.md, .mdx) or in `.parachute/notes-meta/<id>.yaml` sidecars
  otherwise. Wikilinks to ambiguous bare paths (`[[Foo]]` when both
  `Foo.md` and `Foo.csv` exist) are refused; use the explicit form.
  Path uniqueness is now `(path, extension)`.
- **Sync ergonomics** (vault#309, vault#310, vault#321) — `update-note
  if_missing: "create"` saves the query-then-create round trip on
  every missing-note sync. JSON int coercion accepts `5.0` for
  integer-typed fields. REST + MCP create-branch link handling is now
  symmetric.
- **Case-collision auto-disambiguation** (vault#327) — exports probe
  filesystem case-sensitivity; on case-insensitive disks (macOS APFS,
  Windows NTFS), colliding notes get on-disk filename suffixes while
  canonical paths in frontmatter stay unchanged. Cross-FS replay
  recovers via three-tier sidecar resolution.
- **AmbiguousPathError** — distinct from `PathConflictError`. Carries
  a `candidates` array listing matching `(path, extension)` pairs.
  REST returns 409 with `error_type: "ambiguous_path"`. Three handlers
  (`handleNotes`, `handleFindPath`, `handleViewNote`) share an
  `ambiguousPathResponse` helper.
- **Sidecar leftover tracking** — orphan sidecars (sidecar present,
  content file missing on import) land in `ImportStats.skipped_sidecars`.
- **Empty notes are a valid state** (vault#323) — dropped the
  `EMPTY_NOTE` guard. Skeleton notes, drafts saved-before-content, and
  organizing-only notes all create + round-trip cleanly.

## [0.4.5-rc.2] — 2026-05-15

0.4.5 cleanup — closes known limitations from rc.1 ship. Four commits
under "0.4.5 cleanup": one substantive (vault#327), three follow-ups
from the vault#328 reviewer (vault#330 S1/S2/F3). 0.4.5 stable
promotes from rc.2.

### fix(export): case-collision detection + auto-disambiguation (vault#327)

Aaron's real default vault on macOS APFS had two notes whose paths
differed only by case silently collapsing into one file on export.
The fix:

- Probe filesystem case-sensitivity at export time
  (`probeCaseSensitive`: write a hidden tempfile with a lowercase
  name, test whether the uppercase variant is reachable). Cleans up
  its tempfile; defaults to conservative true (case-sensitive,
  matches today's behavior) on probe failure.
- On case-insensitive FS, build a lowercased `(path, ext)` index
  during the export walk. Collisions auto-disambiguate to
  `<path>__<id-prefix>.<ext>` — deterministic across runs (note IDs
  are stable, timestamp-prefixed).
- Note's stored `path` (in inline frontmatter + sidecar) stays
  canonical. Only on-disk filename is munged. Import recovers
  truth from frontmatter/sidecar.
- `ExportStats.case_insensitive_fs` + `disambiguated_paths` audit
  trail.
- Import handles both shapes: exact-case canonical match → first
  remaining bucket entry → id-prefix fallback for disambiguated
  filenames. `sidecarByKey` is now multi-value Map<key, sidecar[]>
  so case-collided sidecars coexist.
- `caseSensitiveOverride: boolean` test seam.

### fix(notes): getNoteByPath ambiguity-aware (vault#330 S1)

`getNoteByPath` was non-deterministic under v18 — two same-path-
different-extension notes would resolve to one in SQLite's undefined
row order. Aligns the path-as-key contract with the wikilink
ambiguity policy: `(path, extension)` is the uniqueness tuple
everywhere.

- `getNoteByPath(path, extension?)` signature. >1 row with no
  extension hint → throws new `AmbiguousPathError`
  (`code=AMBIGUOUS_PATH` + `candidates: [{id, extension}, ...]`).
- MCP `resolveNote` + REST `resolveNote` both parse trailing
  `.<ext>` as `(path, extension)` — same explicit-extension form
  as wikilinks. Falls through to the ambiguity-throwing lookup
  when no hint is supplied.
- REST handlers convert `AmbiguousPathError` to structured 409 with
  `error_type=ambiguous_path` + candidates array.

### fix(import): drain orphaned sidecars into ImportStats.skipped_sidecars (vault#330 S2)

The PR2 import flow built `sidecarByIdLeftover` but never iterated
it — the comment promising stale-sidecar warnings was a lie. This
makes the comment honest:

- After the content-file walk, iterate leftover sidecars and record
  each in `ImportStats.skipped_sidecars` (sidecar_id, expected_path,
  expected_extension, reason).
- `console.warn` per entry so CLI / log scrapers can surface the gap.
- Common cause: operator removed a content file by hand without
  deleting the matching sidecar.

### refactor(portable-md): unify the frontmatter/sidecar key-emit loop (vault#330 F3)

`toPortableMarkdown` and `toSidecarYaml` had identical per-key emit
loops with subtly different trailing-newline behaviors. Extracted
`emitFrontmatterKeys(fm)` so both call paths share one source of
truth. Pure refactor — round-trip test still pins byte-equivalence.

## [0.4.5-rc.1] — 2026-05-15

File-extension support — vault#328. Substrate-side feature enabling
notes whose content is NOT markdown (CSV, YAML, JSON, MDX, plaintext,
etc.) as first-class. Markdown stays the default; every existing row
keeps its meaning. Three commits under the vault#328 theme.

### feat(db): add extension column to notes, default 'md' (vault#328)

Schema v17 → v18: `ALTER TABLE notes ADD COLUMN extension TEXT NOT
NULL DEFAULT 'md'`, and widen the path-uniqueness index from `(path)`
to `(path, extension)` so two notes can share a path differing only by
extension (e.g. `Recipes/pasta.md` + `Recipes/pasta.csv`).

Backward-compat by construction — every existing row defaults to "md",
so the new composite-index uniqueness collapses to the v5 "(path WHERE
NOT NULL) is unique" behavior on existing data.

Threaded `extension` through `Note`/`NoteSummary`/`NoteIndex`, the
`Store` interface (`createNote` / `updateNote` / `createNoteRaw`),
`BulkNoteInput`, and `QueryOpts.extension` (single string or array,
case-insensitive `LOWER(n.extension) IN (...)` SQL).

Tests: 7 new in `core/src/core.test.ts` covering default 'md',
explicit persist, v18 migration backfills legacy NULL → 'md',
`updateNote` changes extension, query filter (single + array shapes),
case-insensitive match.

### feat(api): extension field on create-note + update-note + query-notes (vault#328)

MCP and REST surfaces gain a symmetric `extension` field:

- **MCP `create-note`**: optional `extension` on single + batch shapes.
- **MCP `update-note`**: optional `extension`; same validation on both
  the update branch AND the `if_missing: "create"` branch.
- **MCP `query-notes`**: `extension` filter accepts a single string or
  an array.
- **REST `POST /notes`** + **`PATCH /notes/:id`** (incl.
  `if_missing=create` branch): symmetric `extension` field, validation,
  400 `invalid_extension` on bad input with structured
  `error_type`/`extension`/`reason`.
- **REST `GET /notes`**: `?extension=csv` (single) or
  `?extension=csv&extension=yaml` / `?extension=csv,yaml` (array).

Validation: `/^[a-z0-9]{1,16}$/` + reserved `parachute` prefix guard.
Single source of truth at
`core/src/notes.ts:validateExtension`, imported by both transports so
the contract can't drift.

Tests: 7 MCP + 9 REST integration tests — default, persist, validation
rejections (uppercase, dot, slash, reserved prefix, too long, empty),
update branch, `if_missing=create` branch, GET filter (single + array).

### feat(export): non-markdown content with sidecar metadata + .mdx as frontmatter-compatible (vault#328)

`core/src/portable-md.ts:supportsInlineFrontmatter(ext)` predicate
splits extensions into two buckets:

- **Frontmatter-compatible** (`md`, `mdx`): metadata as inline YAML
  frontmatter at top of content file. Today's behavior, extended to
  `.mdx` (YAML frontmatter works in MDX identically — and Aaron's
  planning to use MDX in some notes).
- **Sidecar-required** (`csv`, `yaml`, `json`, anything else): metadata
  in `.parachute/notes-meta/<note-id>.yaml`. Content file holds the
  raw bytes — no frontmatter prepend.

Export emits one sidecar per non-frontmatter-compat note; new
`ExportStats.sidecars` counter pins the count. Sidecar path-traversal
guard symmetric with the attachments path: the sidecar lives under
`.parachute/notes-meta/`, period.

Import builds a `(path, extension) → sidecar` index from the
`.parachute/notes-meta/` directory at the top of the import pass.
Walks every content file (not just `.md` — new `walkContentFiles`
helper) and, for each, parses inline frontmatter (frontmatter-compat
extensions) or looks up the sidecar (non-frontmatter-compat). Orphaned
content files (no matching sidecar) are skipped with a warning rather
than crashing.

`toPortableMarkdown` now returns raw content for sidecar-required
extensions (no synthetic `---` frontmatter prepend). New
`toSidecarYaml` emits the metadata-only bytes for the sidecar.
`portableExportFilePath` honors the note's `extension` (was hardcoded
`.md`).

**Wikilink ambiguity policy** (vault#328 edge case 3): when two notes
share a path differing only by extension (`Foo.md` + `Foo.csv`),
`[[Foo]]` is refused (returns null from `resolveWikilink`) and
recorded as unresolved. `[[Foo.md]]` / `[[Foo.csv]]` resolve
unambiguously to their respective notes via the new explicit-extension
form. The extension-recognition pattern in the wikilink parser mirrors
`EXTENSION_PATTERN` in `core/src/notes.ts` so the two share the same
notion of "this looks like an extension."

Frontmatter `extension` field is OMITTED for `md` (the default) so
pre-vault#328 markdown-only exports produce byte-identical bytes
before and after the upgrade. The sidecar always includes `extension`
(the field is the sidecar's reason for existing).

Tests: 10 new in `core/src/portable-md.test.ts` —
`supportsInlineFrontmatter` true/false matrix, `toPortableMarkdown`
extension awareness (md, mdx, csv), `toSidecarYaml` shape, full
round-trip integration over csv/yaml/json/mdx/empty-content/.md
(export → blow-away import → byte-equiv re-export), orphan-content-
file rejection, wikilink ambiguity refuse + explicit-extension
resolve.

## [0.4.4-rc.14] — 2026-05-15

Round-trip import unblocker — vault#323. Aaron's real default vault
(2290 notes / 12 schemas / 298 attachments) tripped two distinct bugs
on the round-trip import smoke that gates the @latest stable
promotion of `0.4.4`. Three commits, all under vault#323.

### fix(notes): drop EMPTY_NOTE guard — empty content is a valid state (vault#323)

The earlier #213 guard rejected `content + path both absent` from
createNote and updateNote, plus pre-validators in MCP and REST that
short-circuited the same shape with 400 EmptyNoteError. Real vaults
have empty-content notes (skeletons, drafts, organizing notes,
capture-then-fill flows); export emits them fine but the import then
rejected every one — blocking the round-trip.

Design call (Aaron, 2026-05-13): empty notes are a valid state.

Dropped:
- `EmptyNoteError` class + Store-level throw in createNote/updateNote
  (core/src/notes.ts).
- MCP create-note pre-walk that rejected empty entries with item_index
  (core/src/mcp.ts), plus the `EmptyNoteError` re-export.
- REST POST /notes pre-walk + the 400-on-EMPTY_NOTE error mappers in
  POST and PATCH handlers (src/routes.ts).

Tests flipped (core/src/core.test.ts + src/vault.test.ts): empty-
content creates and clears now succeed end-to-end across Store, MCP,
and REST. Batch atomicity (#236) and MAX_BATCH_SIZE (separate
runaway-client protection) are untouched.

### fix(cli): detect running daemon on import, refuse with clear error (vault#323)

`parachute-vault import` opens its own bun:sqlite connection. When a
daemon was already running on the configured port, the first
createNote contended for the writer lock and hit SQLITE_BUSY —
leaving the target vault partially replayed. The error trace
surfaced nothing actionable.

cmdImport now probes `checkHealth(port)` after verifying the vault
and before touching the database. `healthy` or `unhealthy` (port
bound, any HTTP response) prints a clear error pointing at the
workaround and exits 1:

  error: vault daemon is running on port <port>; stop it first with:
    parachute stop vault
  the import requires exclusive write access to the SQLite database.

A proper WAL / concurrent-writer story is a separate follow-up.

Integration test in src/import-daemon-busy.test.ts asserts both
branches.

### test(import): empty-content round-trip in integration suite (vault#323)

Added an empty-content note (`01HX004`, `path: "Inbox/skeleton"`,
tagged `project`) to the round-trip fixture in
`core/src/portable-md.test.ts`. The test now exports → blow-away
import → re-export → byte-equivalent over a fixture that includes
the shape vault#323 was hitting. Pre-fix, importPortableVault threw
on the empty-content create; post-fix, the skeleton survives the
round-trip with content/path/tags intact. Pins the regression so a
future paternalistic guard re-introduction breaks CI before it ships.

## [0.4.4-rc.13] — 2026-05-13

`if_missing` tighten-up — vault#321 follow-ups from the vault#320 review.
Three commits, all under the "if_missing tighten-up" theme. Closes
vault#321 (F2 + F3 + F4 sub-issues).

### fix(api): REST PATCH if_missing=create applies links.add (vault#321 F2)

Cross-surface inconsistency: MCP's create-on-missing branch processed
`links.add` (let drift sync declare typed links at upsert time); REST
PATCH `/notes/:id`'s create-on-missing branch didn't process `links`
at all. Gitcoin would have tripped on this migrating MCP → REST.

REST now mirrors MCP exactly:
- `links.add` applied — drift sync materializes typed links alongside
  the create.
- `links.remove` ignored (nothing to remove on a fresh note).
- Missing target notes skip silently.
- Resolves target via `resolveNote(store, link.target)` — same
  id-or-path lookup as the update path.

Two new REST integration tests (vault.test.ts):
- `links.add` creates typed-link rows (id-target + path-target both
  resolve; metadata round-trips).
- Missing target → silent skip.

### test(api): schema-conflict warning surfaces on if_missing=create branch (vault#321 F3)

The `attachValidationStatus` path handles schema conflicts (two tags
declaring the same field with conflicting types) but the create branch
of `if_missing="create"` reused that path without exercising the case
in a test. Now pinned on BOTH surfaces for symmetry:

- MCP test in core.test.ts.
- REST test in vault.test.ts.

Both confirm a `schema_conflict` warning surfaces in
`validation_status.warnings` when two directly-applied tags declare
the same field with conflicting specs. First-tag-wins precedence
(`schema` = winner, `loser_schema` = the dropped declaration).

### test(mcp): links.add applied on if_missing=create branch (vault#321 F4)

`core/src/mcp.ts:644-650` applies `links.add` on the create branch.
Code was there pre-fold but untested — a future regression breaking
Gitcoin's upsert-with-typed-links workflow would have slipped through.
Now pinned: MCP `update-note` + `if_missing: "create"` + `links.add`
payload → assert link rows materialize with the right targets +
relationships + metadata.

### Gates

- `bun test` (root) → 1416 pass / 3 skip / 0 fail (was 1411; +5 tests)
- `bun test ./src/` → 926 pass / 0 fail (was 923; +3 REST tests: 2 F2 + 1 F3)
- `bun test ./core/src/` → 490 pass / 0 fail (was 488; +2 MCP tests: 1 F3 + 1 F4)
- `bunx tsc --noEmit` clean

## [0.4.4-rc.12] — 2026-05-13

Gitcoin sync ergonomics — bundled two-commit PR. Both close real
friction points from `from_parachute_round_2.md`, queued as the
priorities after vault#308.

### feat(api): `if_missing: "create"` on update-note (closes vault#309)

Pre-fix, Gitcoin's nightly drift-detector loop had to either
query-first-then-create on 404 (1 extra round trip per item, ~500/night)
or accept that "update" semantics weren't safe when the note might not
exist. Now `update-note` accepts an optional `if_missing` field:

- **MCP `update-note`** — new `if_missing: "fail" | "create"` param
  (default `"fail"`, current behavior). On `"create"`: if the note
  doesn't exist (`resolveNote` returns null), treat the update payload
  as a create payload (content/path/tags/metadata become the create
  fields; `if_updated_at` precondition skipped since there's nothing
  to conflict with).
- **REST `PATCH /api/notes/:idOrPath`** — same `if_missing` field in
  the JSON body. Mirrors MCP semantics.
- **Response carries `created: true | false`** on every update-note
  response (both branches). Sync loops read this to know which path
  fired without a separate query.
- **Idempotent**: repeated calls with the same id + payload produce
  the same vault state (first call creates with `created: true`,
  subsequent calls update with `created: false`).
- **Tag-schema defaults + validation_status** fire on the create
  branch identically to `create-note` (the create-path reuses the
  same `applySchemaDefaults` + `attachValidationStatus` recipe).

ID-vs-path heuristic on the create branch: if the `id` field looks
path-shaped (contains `/` or doesn't match `^[A-Za-z0-9_-]+$`) and
`path` isn't explicitly set, use `id` as the path. Otherwise treat as
opaque id. Matches Gitcoin's sync shape where canonical keys are
`Inbox/2026-05-13-meeting`-style paths.

Tests:
- `core/src/core.test.ts`: 6 new MCP tests (create-when-missing,
  update-when-present, no-if_missing-errors, schema-defaults apply,
  validation_status surfaces, idempotency).
- `src/vault.test.ts`: 4 new REST tests (mirror of MCP cases +
  response-shape pin for the additive `created: false` field).

### fix(schema): coerce JSON number → integer when fractional is zero (closes vault#310)

Pre-fix, every integer-typed metadata field warned `type_mismatch` on
legitimate values because the validator had no `"integer"` case at
all — falling through the switch returned `undefined` and the
`if (spec.type && !valueMatchesType(...))` gate fired. Gitcoin's drift
detector emits JSON for diffs (and JSON has no separate integer type),
so every `kpi: 3` triggered a false-positive and buried the real
warnings in the noise floor.

- `SchemaField.type` union extended with `"integer"`.
- `valueMatchesType` adds an `"integer"` case using
  `Number.isInteger(value)`: accepts `5` and `5.0` (zero fractional);
  rejects `5.5`, `"5"` (string — no string→number coercion),
  `5.0000000000001` (edge non-zero fractional), `NaN`, `Infinity`.
- The Gitcoin shape (JSON-decoded integer arriving as JS Number with
  zero fractional part) now passes validation cleanly.

Tests in `core/src/core.test.ts`:
- Happy path: `5`, `5.0`, boolean rejection.
- Strict path: `5.5`, `"5"`, `5.0000000000001`.
- Inner-boundary: `valueMatchesType` rejects `NaN`/`Infinity` directly
  (the outer null-short-circuit at the validator level filters them
  before they reach the type check after JSON.stringify normalization).

### Gates

- `bun test` (root) → 1411 pass / 3 skip / 0 fail (was 1394; +17 tests)
- `bun test ./src/` → 923 pass / 0 fail (was 919; +4 REST tests)
- `bun test ./core/src/` → 488 pass / 0 fail (was 475; +6 MCP if_missing + 7 int coercion)
- `bunx tsc --noEmit` clean

## [0.4.4-rc.11] — 2026-05-13

Portable markdown knowledge-base format — PR 2 of 2 (closes vault#308 +
folds vault#318). Closes the remaining two lossy gaps from PR 1
(attachments + import) and pins the load-bearing byte-equivalent
round-trip invariant.

### Added — export

- `core/src/portable-md.ts` `exportVaultToDir` now copies attachment
  binaries to `<outDir>/.parachute/attachments/<id>/<basename>`
  when `opts.assetsDir` is set (the CLI wires this via
  `src/routes.ts:assetsDir(vault)`; core stays pure — no dep on
  server-side path resolution).
- Attachment refs in note frontmatter preserve the **original
  vault-internal path** (relative to `assetsDir`). The sidecar
  location is derived from `att.id` so it's deterministic across
  renames and different export runs.
- `ExportStats` extended (folds vault#318): adds `attachments`,
  `skipped_traversal`, `skipped_notes`, `skipped_attachments`.
  Programmatic consumers (PR 2 importer; future drift sidecars)
  no longer have to log-scrape.

### Added — import

- `core/src/portable-md.ts` `importPortableVault(store, opts)` —
  reads a portable-md export back into a vault. Upsert by frontmatter
  `id`: existing notes updated in place, new ones created.
- `--blow-away` flag — the disaster-recovery path: wipe the target
  vault first (delete all notes + tags; cascade-deletes flow through
  FKs), then replay from the export. CLI gates this behind a confirm
  prompt unless `--yes` is set. Returns `notes_wiped` count.
- Tag schemas restored from `.parachute/schemas/<tag>.yaml` before
  notes (so any tag a note carries can validate against its schema).
- Typed links replayed after all notes exist (forward-ref safe).
  Skipped links surface in `ImportStats.skipped_links` with the
  reason.
- Attachment binaries restored from
  `.parachute/attachments/<exported-id>/<basename>` to
  `<assetsDir>/<frontmatter-path>` when `opts.assetsDir` is set.
  Path-traversal guards on both ends.
- `--dry-run` counts would-create / would-update without writing.
- `Store.restoreNoteTimestamps(id, createdAt, updatedAt)` —
  import-only setter that writes both timestamps explicitly. Regular
  `updateNote` either bumps `updated_at` to wall-clock-now or leaves
  it untouched; neither lets the importer write a historical
  timestamp. Used so the round-trip preserves notes where
  `created_at ≠ updated_at`.
- `Store.syncAllWikilinks` lifted into the `Store` interface (was on
  `BunSqliteStore` only). The importer calls it once at the end to
  rebuild wikilink rows from `[[brackets]]` in content.

### CLI

- `parachute-vault import <dir>` autodetects portable-md vs legacy
  Obsidian via the presence of `.parachute/vault.yaml`. Lossless path
  takes over when present; legacy obsidian parser handles the rest.
  `--format <name>` and `--obsidian` flags retained as no-op hints.
- `parachute-vault import <dir> --blow-away [--yes] [--dry-run]` —
  the disaster-recovery path.
- `parachute-vault export <dir>` now wires `assetsDir(vault)` so
  attachment binaries are copied alongside the markdown. Output
  shows `notes / schemas / attachments` counts.

### Tests

- 8 new import tests covering: not-a-portable-md error path, upsert by
  id (new + existing), `--blow-away`, schema restoration, typed-link
  replay, missing-target skip, dry-run no-writes.
- **Round-trip byte-equivalent integration test** (PR 2 P3, the
  load-bearing pin for the format's whole pitch): realistic vault
  (multiple notes, schema-carrying tags, typed link, multi-line
  metadata, divergent created_at/updated_at) → export → blow-away
  import → re-export → recursively compare every file's bytes.
  Drift triggers a diff hint in console.error before the test fails,
  so future regressions are debuggable.

### Known limitation

- **Attachment IDs are re-minted on import.** `addAttachment` generates
  a fresh id; the Store interface doesn't yet expose a
  `restoreAttachment(id, ...)` import-only path. Frontmatter refs still
  resolve by `(note_id, path)` tuple, but a round-trip with
  attachments present produces byte-different `attachments[].id`
  values between original and re-export. The note-level round-trip
  test exercises this. Filed as a future enhancement; landing it
  requires the parallel surface to `restoreNoteTimestamps`.

### Reviewer fold (vault#319 F1 + F2 + F3)

- **F1 (safety)** — `--blow-away` confirm now defaults NO (was YES).
  Every other destructive confirm in the CLI defaults NO; a
  distracted Enter-press no longer wipes a vault. One-char fix.
- **F2 (doc)** — Pinned upsert merge policy in a comment block at
  `importPortableVault`'s update branch. Non-blow-away imports
  **always replace** content + tags, but **upsert-by-field** for
  metadata + path (absent fields preserve the vault's existing
  values). To force a clean replace-by-id, use `--blow-away`.
- **F3 (coverage)** — Folded the missing attachment-import tests:
  - Bytes survive vault → export → fresh-vault import (different
    `assetsDir`). Non-utf8 distinctive bytes verify the buffer
    round-trips honestly through the filesystem.
  - Adversarial frontmatter `attachments[].path` that resolves
    outside the destination `assetsDir` is skipped + recorded in
    `ImportStats.skipped_attachments` with a `path-traversal`
    reason; the would-be escape file never lands.

### Gates

- `bun test` (root) → 1394 pass / 3 skip / 0 fail (was 1392; +2 F3 tests)
- `bun test ./src/` → 919 pass / 0 fail (unchanged)
- `bun test ./core/src/` → 475 pass / 0 fail (was 473; +2 F3 tests)
- `bunx tsc --noEmit` clean

## [0.4.4-rc.10] — 2026-05-13

vault#317 reviewer fold — three critical bugs in the rc.9 portable-md
export. All caught before merge.

### Fixed

- **F1 (silent corruption)** — Multi-line strings in `metadata`
  silently truncated. The pre-fold `needsQuote` didn't detect embedded
  newlines, so a `metadata` value like `"line1\nline2"` got
  single-quoted and emitted across two physical YAML lines; the
  line-oriented parser then read line 0 as `'line1` (unclosed quote)
  and the second line as garbage. Vault metadata legitimately carries
  multi-line strings (transcripts, descriptions, body-as-metadata).
  Fix: `needsQuote` now detects `\n\r\t\v\f` and `\x00-\x08\x0e-\x1f`;
  `quoteString` switches to the **double-quoted** form with escape
  sequences (`\\n`, `\\xNN`) so the whole value stays on one physical
  line. `unquote` decodes the same escapes on parse. Pinned by two
  round-trip tests in `portable-md.test.ts`.
- **F2 (tautology test)** — The rc.9 "byte-identical re-emit"
  idempotency test called `toPortableMarkdown` twice on the same
  in-memory object and compared. That proves nothing about
  round-tripping through the on-disk bytes. The CHANGELOG claim was
  load-bearing for the format's whole pitch ("clean git diffs") and
  the test didn't prove it. Fix: parse the emitted markdown back
  through `parseFrontmatter`, reconstruct a `PortableNote`, re-emit,
  compare bytes. That's the real invariant.
- **F3 (path traversal)** — `exportVaultToDir` did
  `join(outDir, relPath)` without verifying the resolved path stayed
  under `outDir`. A note with `path: "../../escape"` would write
  outside the export directory. Self-inflicted at the vault level
  (operator owns the data) but a real surprise for programmatic
  callers (e.g. ingest from external systems). Fix: resolve both
  paths absolute, assert `candidate === root || candidate.startsWith(root + sep)`.
  Refuses the write with a `console.warn` rather than aborting the
  whole export — partial export is more useful than no export.
  Pinned by two tests (escape attempt skipped; nested path inside
  outDir permitted).

### Polished

- **F4** — `notetoPortable` renamed to `noteToPortable` (camelCase
  typo).
- **F5** — Added a code comment on the 1M-note bulk-load ceiling in
  `exportVaultToDir`. Cursor / streaming for very-large vaults is a
  PR 2 follow-up.
- **F6** — `unquote` now decodes the double-quoted YAML escapes the
  emitter produces (`\\\\`, `\\"`, `\\n`, `\\r`, `\\t`, `\\v`, `\\f`,
  `\\xNN`). TODO comment notes that YAML 1.2 defines additional
  escapes (`\\0`, `\\u<4hex>`, etc.) that the emitter never produces
  but legacy `.yaml` files might — to add when a real case lands.

### Gates

- `bun test` (root) → 1384 pass / 3 skip / 0 fail (was 1380; +4 fold tests)
- `bun test ./src/` → 919 pass / 0 fail (unchanged)
- `bun test ./core/src/` → 465 pass / 0 fail (was 461; +4 fold tests)
- `bunx tsc --noEmit` clean

## [0.4.4-rc.9] — 2026-05-13

Portable markdown knowledge-base export — PR 1 of 2 (closes part of
vault#308; PR 2 follows with attachments + `--blow-away` import for
full round-trip disaster recovery).

The current export at `core/src/obsidian.ts` produces Obsidian-
compatible markdown — but the format isn't Obsidian-specific. Markdown
+ frontmatter + folder hierarchy is the de-facto knowledge-base
interchange format, consumed by Obsidian, Logseq, Foam, Quartz,
Dendron, and most markdown-shaped static-site generators. Anchoring
the function name to the format (rather than to one consumer) opens
the door as other consumers adopt it. The legacy export is also
lossy: no IDs, no typed-link relationships, no tag schemas, no
attachments, no idempotency guarantee. Gitcoin Brain's vault-as-
primary + git-as-projection architecture (and any operator using
vault-as-primary) needs lossless round-trip.

### Added

- `core/src/portable-md.ts` — canonical home for the format.
  - `toPortableMarkdown(note)` — emits a fixed top-level frontmatter
    key order (`id` → `path` → `tags` → `metadata` → `links` →
    `attachments` → `created_at` → `updated_at`) with alpha-sorted
    keys in nested objects. Re-exporting an unchanged vault produces
    byte-identical files.
  - `exportVaultToDir(store, opts)` — writes
    `<dir>/.parachute/vault.yaml`, `.parachute/schemas/<tag>.yaml`
    per schema-carrying tag, and `<note.path>.md` per note.
  - Typed-link relationships (non-wikilink) serialized in the
    `links:` frontmatter block. Wikilinks stay in the content (their
    `[[brackets]]` are the source of truth).
  - Note IDs preserved in frontmatter (`id:` is the first key,
    durable across renames).
  - Hand-rolled YAML emitter — no new dep; strict string quoting
    for values that would round-trip as different types
    (`'true'`, `'42'`, `'null'`).
- CLI: `parachute-vault export <dir> [--since <iso>]`. The
  `--since` flag filters notes to those with `updated_at >= iso`,
  for incremental git-projection cadences.

### Changed

- `core/src/obsidian.ts` — now a back-compat shim. Re-exports the
  parser helpers (`parseFrontmatter`, `extractInlineTags`,
  `walkMarkdownFiles`) from `portable-md.ts`. The legacy lossy
  `toObsidianMarkdown` / `exportFilePath` are retained (marked
  `@deprecated`) for callers that intentionally want the flat
  frontmatter shape. All existing tests against `obsidian.ts` pass
  unchanged.

### Tests

- `core/src/portable-md.test.ts` — 32 tests covering:
  - YAML emitter (alpha-sort, scalar quoting, idempotency).
  - Frontmatter key order (fixed top-level, alpha-sorted nested).
  - `exportVaultToDir` (vault.yaml + schemas/<tag>.yaml + per-note
    .md files, with `--since` filter).
  - Byte-identical re-export of unchanged vault (idempotency pin).
  - Wikilinks excluded from `links:` block.

### Format change (callers that store the legacy `toObsidianMarkdown` output)

The new portable-md frontmatter shape **nests metadata** under a
`metadata:` block, where the legacy obsidian export flattened
metadata keys at the top level. Operators using the legacy
`parachute-vault export` for one-shot Obsidian copies will see a
shape change after upgrading to `parachute-vault export` (now the
new portable-md emitter). The legacy `toObsidianMarkdown` function
is still callable for callers that import it directly; the CLI
moves to the new format. Export output is *projection*, not
authoritative state — regeneratable, so the migration cost is
re-running the export.

### Coming in PR 2

- Attachments export/import (file copy under `.parachute/attachments/`).
- `parachute-vault import <dir> --blow-away` for disaster recovery.
- Full round-trip byte-equivalence test (vault → export → blow-away
  → import → vault state byte-equivalent).
- Cookbook entry for webhook-driven nightly git projection.

### Gates

- `bun test` (root) → 1380 pass / 3 skip / 0 fail
- `bun test ./src/` → 919 pass / 0 fail (unchanged)
- `bun test ./core/src/` → 461 pass / 0 fail (was 429; +32)
- `bunx tsc --noEmit` clean

## [0.4.4-rc.8] — 2026-05-12

HTTP create/update now attach `validation_status` — symmetry with MCP
(closes vault#287).

The MCP `create-note` and `update-note` tools wrap their responses in
`attachValidationStatus`: when a tag on the note declares `fields` (a
type / enum schema) on its `tags` row, the response carries a
`validation_status` block with the resolved schemas and any warnings
(type mismatch, enum mismatch). HTTP `POST /api/notes` and `PATCH
/api/notes/:id` did not — HTTP consumers of schema-validated vaults
had no signal that their write triggered a warning. They had to
re-read the note, cross-reference its tags, and replay validation
client-side. Defeats one of the load-bearing reasons validation runs
at write time.

### Changed

- `attachValidationStatus` is now exported from `core/src/mcp.ts` so
  both transports use the same recipe (single source of truth).
- HTTP `PATCH /api/notes/:idOrPath` attaches `validation_status` to
  the response, on both the default full-Note shape and the lean
  (`include_content: false`) shape. The lean-shape preservation
  mirrors the MCP recipe at `core/src/mcp.ts:751` — `toNoteIndex`
  drops unknown fields, so the field is re-attached after the
  conversion.
- HTTP `POST /api/notes` (single + batch) attaches
  `validation_status` to each created note. Mirrors the MCP
  `create-note` attach site at `core/src/mcp.ts:451`.

### Behavior

- No change for vaults without tag schemas: `attachValidationStatus`
  returns the note unchanged when no tag on it declares fields.
- No change for MCP — the validation-status surface was already
  there.
- HTTP consumers using tag schemas now see `validation_status` on
  every write response, matching the MCP contract.

### Tests

- 6 new tests in `src/vault.test.ts`:
  - PATCH attaches `enum_mismatch` warning on a schema-violating
    metadata update.
  - PATCH preserves `validation_status` on `include_content: false`
    (lean shape).
  - PATCH omits `validation_status` when no tag declares fields
    (back-compat).
  - POST attaches `type_mismatch` warning on schema-violating
    create.
  - POST batch attaches per-note `validation_status` (mixed
    valid/invalid entries each carry their own status).
  - POST omits `validation_status` when no tag declares fields.

### Gates

- `bun test` (root) → 1348 pass / 3 skip / 0 fail
- `bun test ./src/` → 919 pass / 0 fail (was 913)
- `bun test ./core/src/` → 429 pass / 0 fail
- `bunx tsc --noEmit` clean

## [0.4.4-rc.7] — 2026-05-12

`buildMcpEntryPlan` ⇄ `installMcpConfig` — close the URL invariant on the
writer side (vault#302, follow-up to vault#301).

vault#301 introduced `buildMcpEntryPlan` as the shared seam for the
preview ⇄ writer entry-key + URL invariant. But `entryKey` was the only
half closed: `installMcpConfig` still called `chooseMcpUrl(vaultName,
port)` directly inside the writer, reading `process.env` rather than the
`env` threaded through `InstallContext`. In production both branches
read `process.env`, so they agreed by accident — a future change that
introduced a non-process-env source (tests with in-memory env, alternate
config paths, anything using `InstallContext.env` differently) would
silently diverge between preview and writer.

### Internal

- `InstallMcpConfigOpts` now requires `url` from the caller. The
  writer is a pure file-writer; the URL decision lives in
  `buildMcpEntryPlan` alone.
- `installMcpConfig` returns `void` (was `{ url, source }`). Both
  call-sites already have `url` and `source` from
  `buildMcpEntryPlan`'s output — no need to round-trip.
- `executeMcpInstall` destructures `{ entryKey, url, source }` from
  `buildMcpEntryPlan` and passes `url` to `installMcpConfig`.
- The `init --add-mcp` bootstrap path (cli.ts:521) goes through
  `buildMcpEntryPlan` too, so init and `mcp-install` share the same
  URL-computation seam — a future URL-shape change can't drift
  between the two.
- `chooseMcpUrl` is no longer imported by `cli.ts` (only used inside
  `buildMcpEntryPlan` now).

### Tests

- `src/mcp-install.test.ts`: new end-to-end test pins that the URL on
  disk matches `buildMcpEntryPlan({ env: { PARACHUTE_HUB_ORIGIN: ... } })`
  for a non-default hub origin. A regression that reintroduces the
  direct `chooseMcpUrl` call inside `installMcpConfig` would drop the
  caller's env and read `process.env` — this test goes red on that
  shape.

### Gates

- `bun test` (root) → 1342 pass / 3 skip / 0 fail
- `bun test ./src/` → 913 pass / 0 fail (was 912)
- `bun test ./core/src/` → 429 pass / 0 fail
- `bunx tsc --noEmit` clean

No operator-visible behavior change.

## [0.4.4-rc.6] — 2026-05-12

`bun test` from the repo root now returns green (vault#294).

The 27 failures in `web/ui/` tests on `main` were misdiagnosed as a
`vi.mock` version incompatibility. Root cause: `bun test` walks the
entire repo for `*.test.*` files, including `web/ui/`'s React SPA
tests. Those tests import `vitest` and use `vi.mock("path")` in the
single-arg auto-stub form, which `bun:test` rejects with
`TypeError: mock(module, fn) requires a function`. The SPA tests are
written for vitest 4.x (its declared `npm test` runner) and pass
cleanly there — they were never broken; `bun test` was just trying to
run them with the wrong runner.

### Fix

- `bunfig.toml` adds `pathIgnorePatterns = ["web/ui/**"]` under
  `[test]`. `bun test` from the repo root now stops at the
  server + core boundary; the React SPA's tests stay green under
  their canonical `vitest run` command.

### Docs

- `CLAUDE.md` "Running" section documents the two-runner split
  explicitly: `bun test` for server + core, `bunx vitest run` (from
  `web/ui/`) for the SPA. Future contributors won't trip over the
  same mis-diagnosis.

### Gates

- `bun test` from repo root → 1341 pass / 3 skip / 0 fail (was
  1362 pass / 3 skip / 27 fail / 2 errors).
- `bun test ./src/` → 912 pass / 0 fail (unchanged).
- `bun test ./core/src/` → 429 pass / 0 fail (unchanged).
- `cd web/ui && bunx vitest run` → 61 pass / 0 fail (unchanged —
  always green under vitest).

No code change. Configuration + docs only.

## [0.4.4-rc.5] — 2026-05-12

`parachute-vault uninstall --skip-daemon` test-isolation flag (vault#296).

The CLI's `uninstall` command calls `uninstallAgent()`, which targets the
hardcoded launchd label `computer.parachute.vault`. That label ignores
`PARACHUTE_HOME`, so a naive subprocess test of `uninstall --yes` on a
developer's machine would `launchctl bootout` the real registered
daemon. We previously dodged this by avoiding subprocess tests entirely
for the uninstall flow — but that left the full path (wrapper removal,
MCP cleanup, ordering, exit codes) untested.

### Added

- Undocumented `--skip-daemon` flag on `parachute-vault uninstall`.
  Bypasses the launchd / systemd / backup-agent uninstall calls;
  everything else (wrapper removal, MCP cleanup, optional wipe) runs
  as normal. Tests use this to exercise the full flow against a
  sandbox `PARACHUTE_HOME` without touching real operator state.
  Intentionally absent from `usage()` — humans should never need it,
  and surfacing it would invite "I'll just skip the daemon step"
  misuse that leaves an orphaned daemon firing on a missing wrapper.

### Tests

- End-to-end uninstall coverage in `src/mcp-install.test.ts`:
  - wrapper + server-path pointer + MCP entry removed; daemon skip
    surfaces in stdout for CI log audit.
  - `--skip-daemon` alone leaves user data alone (no accidental wipe).
  - `--skip-daemon --wipe --yes` composes correctly — destructive
    path still removes vault data + .env.

### Docs

- Convention documented in `CLAUDE.md` under "Running".

No operator-visible behavior change in the default uninstall path.

## [0.4.4-rc.4] — 2026-05-12

`mcp-install` preview-accuracy regression pin (vault#293 follow-up to vault#292).

The interactive walkthrough's preview render and the writer
(`executeMcpInstall` → `installMcpConfig`) used to compute the entry
key and URL independently — identical by coincidence of template
strings. A future change to either path could silently mislead: the
operator confirms one JSON shape, a different shape lands on disk.

### Internal

- Extract `buildMcpEntryPlan` in `src/mcp-install.ts` as the single
  source of truth for `(entryKey, url)`. Both the preview render and
  the writer call it.
- Thread `port` + `env` through `InstallContext` so the preview
  resolves the URL through `chooseMcpUrl` (the same path the writer
  uses) rather than rebuilding the string from `${ctx.hubOrigin}/…`.
- Thread `existingEntryKey` from `InstallDecision` into
  `executeMcpInstall` so the writer keys the new entry at the same
  slot the preview promised when the walkthrough is updating an
  existing entry (instead of synthesizing a fresh key).
- Un-skip the F3 preview-accuracy test from vault#292 and replace it
  with a smaller-seam test: direct unit tests on `buildMcpEntryPlan`
  in `mcp-install.test.ts` (entry-key formula: singular vs per-vault
  vs update-existing; URL source: hub-origin vs loopback fallback),
  plus two walkthrough tests in `mcp-install-interactive.test.ts`
  that capture the preview's logged JSON and assert it matches
  `buildMcpEntryPlan(decision)`. Faster + sturdier than the previous
  walkthrough+spawn shape; no subprocess, no temp filesystem.

No operator-visible behavior change.

## [0.4.4-rc.3] — 2026-05-11

Two `parachute-vault mcp-install` fixes from real dogfood feedback —
operator ran the walkthrough from a plain directory (no `.git`, no
`package.json`) intending a directory-private install, and the
walkthrough decided unilaterally for them. Both fixes restore "always
let the operator pick the scope."

### Fix 1 — Add the `local` install scope

Claude Code has three MCP scopes; vault previously only supported two.
All three are now first-class:

| Scope | Where the entry lives | Visibility |
|---|---|---|
| `user` | `~/.claude.json` top-level `mcpServers` | every project, every directory |
| `local` | `~/.claude.json` under `projects[<absolute-cwd>].mcpServers` | private to this machine, scoped to this directory |
| `project` | `<cwd>/.mcp.json` | checked into the repo, shared with the team |

`local` matches Claude Code's own `claude mcp add --scope local` default
and is the right shape when the operator wants vault available in this
working directory only, without committing the entry to the repo or
exposing it from every other project.

Surfaces:

- New `--install-scope local` flag.
- Walkthrough's install-location prompt now offers all three scopes
  (see Fix 2).
- `parachute-vault doctor` reads local entries from `~/.claude.json`
  under `projects[<cwd>].mcpServers`.
- `parachute-vault uninstall` cleans local entries from every project
  slot it finds (not just the current `cwd`'s), so a single uninstall
  removes the vault server regardless of which directory the operator
  ran the install from.

### Fix 2 — Drop the marker gate; always prompt for install scope

The interactive walkthrough's install-location step used to silently
auto-pick **user** scope when no project markers (`.git`, `package.json`,
…) were detected — the operator never saw the prompt. The premise was
wrong: Claude Code reads `./.mcp.json` (project scope) and
`projects[<cwd>]` (local scope) regardless of git/package markers.
Skipping the prompt buried the operator's actual intent.

The walkthrough now always prompts with the three scopes laid out. The
default *tilts* on the marker signal — present → `project`, absent →
`local` — but the operator always sees and can override the choice.

### Breaking — non-interactive default changed from `user` to `local`

`parachute-vault mcp-install` with no `--install-scope` flag previously
wrote to `~/.claude.json` top-level (user scope). It now writes to
`~/.claude.json` under `projects[<absolute-cwd>].mcpServers` (local
scope). This mirrors Claude Code's own `claude mcp add` default. Two
things to know:

- **Scripted installs**: pass `--install-scope user` explicitly to keep
  the prior global-install behavior. (We recommend doing this in any
  automation that runs `mcp-install` non-interactively — the operator-
  intent prompt isn't there to surface the change.)
- **Non-interactive `local` install** prints a one-line consequence
  callout on stdout — "Installed locally for this directory only. To
  install globally, re-run with `--install-scope user`." — so a
  first-time operator who hits the new default doesn't wonder why
  vault works only from one directory.

### Tests

10 new tests across `src/mcp-install.test.ts` and
`src/mcp-install-interactive.test.ts`:

- `local` scope writer round-trip (writes to `~/.claude.json` under
  `projects[<cwd>]`, preserves pre-existing top-level entries and
  pre-existing sibling MCP servers).
- `--install-scope local` CLI flag accepted; default-when-no-flag
  changed to `local`; new default writes to the projects-keyed slot.
- Walkthrough always prompts for scope (no marker-gate skip);
  default-tilt logic (markers → `project`, no markers → `local`);
  operator can override either default.
- `detectExistingEntries` recognises local entries (and ignores
  local entries at *other* cwds).

## [0.4.4-rc.2] — 2026-05-11

Interactive default for `parachute-vault mcp-install`. Bare invocation
(no flags, TTY stdin) now walks the operator through a short, contextual
conversation instead of executing silent defaults. Each prompt picks a
smart default informed by ambient context — number of vaults, hub
reachability, project-directory detection, existing entries — and shows
the reason for the default so the operator can override informedly. The
final preview shows the actual JSON the install will write before any
network call or filesystem mutation.

### What changes for the operator

- **Bare `mcp-install`** (TTY, no flags) → walkthrough.
- **Any install-shaping flag** (`--mint` / `--token` / `--legacy-pat` /
  `--scope` / `--install-scope` / `--vault` / `--client`) → existing
  non-interactive path. Flag-passing semantics: "I know what I want."
- **Piped / CI stdin + no flags** → existing non-interactive defaults
  (`--mint`, `vault:read`, user-scope, default vault). Skips prompts
  rather than hanging on stdin no one can answer.

### Walkthrough shape

Each step has a smart default; pressing Enter accepts it. The default is
auto-selected when the choice is obvious:

1. **Vault target.** Skipped when there's exactly one vault, or when an
   existing entry already pins it. With 2+ vaults, prompts and defaults
   to `default_vault`.
2. **Install location.** Defaults to project-scope (`./.mcp.json`) when
   CWD has project markers (`.git`, `package.json`, `pyproject.toml`,
   `Cargo.toml`, `go.mod`, `deno.json`, `.parachute`); otherwise to
   user-scope (`~/.claude.json`). Project-marker detection is shallow —
   only the supplied directory, not its ancestors. Skipped when updating
   an existing entry.
3. **Auth mode + scope.** When hub-mint is available (hub origin
   configured + operator.token present), prompts with `mint` default and
   `vault:read` scope (least-privilege); accepts `write` / `admin` to
   widen, `paste` to use an existing bearer, or `legacy` to fall back to
   `pvt_*`. When hub-mint isn't available, prompts paste vs legacy
   directly with a one-line explanation of why mint is off.
4. **Preview + confirm.** Renders the exact JSON shape that will be
   written (with a `<hub-jwt>` placeholder for the bearer). The live
   mint runs *after* the confirm — a cancellation skips the network
   call entirely.

### Existing-entry detection

When the walkthrough finds a pre-existing parachute-vault entry at
`~/.claude.json` or `./.mcp.json`, it leads with "I see Parachute Vault
is already installed at X. Update it (recommended)?" — accepting the
default pins both install location and entry key from the existing entry,
skipping later prompts that would re-pick them. Operators can decline to
get the fresh-pick flow.

### Internals

- New module `src/mcp-install-interactive.ts` with `runInteractiveInstall`
  + an `InteractiveIO` seam (production wires to `prompt.ts`, tests mock).
- New helpers in `src/mcp-install.ts`: `detectInstallContext`,
  `detectProjectContext`, `detectExistingEntries`. Pure functions —
  test-driveable without monkey-patching globals.
- `cmdMcpInstall` refactored: dispatch front (TTY + flag-presence checks)
  → either flag path or interactive front-end; shared `executeMcpInstall`
  backend acquires bearer and writes (called by both paths).
- `resolveInstallTarget` now prefers `process.env.HOME` over cached
  `os.homedir()` so in-process HOME overrides apply (tests, exotic
  chrooting). `homedir()` remains the fallback.

### Tests

39 new tests across two files:

- `src/mcp-install-interactive.test.ts` (31 tests) — decision-tree
  coverage via `InteractiveIO` mock: single/multi-vault, project /
  non-project context, hub-reachable / not, existing-entry-leads-with-
  update, scope widening to write/admin, paste/legacy fallthrough, help
  reprompt, invalid-input retry, final-confirm abort, empty-vault-list
  bail. Plus context-detection helpers (`detectProjectContext`,
  `detectExistingEntries`, `detectInstallContext`) with positive +
  negative cases.
- `src/mcp-install.test.ts` (2 new tests) — subprocess-level dispatch:
  non-TTY no-flag falls through to flag-driven defaults (doesn't hang
  on prompts); any flag bypasses interactive.

All gates pass. Typecheck clean.

### Deferred from F3 (vault#292 review)

Preview-accuracy cross-check (preview entry-key/URL must match what
`executeMcpInstall` writes) was attempted in
`describe.skip("preview accuracy …")`. The initial in-process walkthrough
+ `Bun.spawnSync` shape looped on `askPersistent` when the inline mock's
coarse default-branch heuristic didn't match a prompt's default. Skipped
for this PR; the equivalence is worth pinning at a smaller seam (extract
shared entry-key/URL builder, pin it directly) rather than driving the
full walkthrough through ad-hoc IO. Tracked as a vault#292 follow-up.

### Out of scope (Phase C — still deferred)

- Cross-client support (Cursor, Claude Desktop, Codex, Zed, Goose, Cline).
- Client auto-detection.
- Token-masking on paste (decided against — security theater; most client
  configs store tokens in plain text anyway).

## [0.4.4-rc.1] — 2026-05-11

Rework `parachute-vault mcp-install` (Phase A + B of the install-flow audit).
Hub-mint becomes the canonical install path; `pvt_*` becomes the explicit
`--legacy-pat` opt-in. New flag surface gives operators control over auth
source, scope, install location, and target vault.

### New CLI shape

```
parachute-vault mcp-install
  [--mint | --token <bearer> | --legacy-pat]    # auth mode (mutually exclusive)
  [--scope vault:read|vault:write|vault:admin]  # default: vault:read
  [--install-scope user|project]                # default: user (~/.claude.json)
  [--vault <name>]                              # default: default_vault
  [--client claude-code]                        # only claude-code wired up
```

### Behavior changes

- **Default is now `--mint`** — install reads `~/.parachute/operator.token`,
  POSTs to `<hub>/api/auth/mint-token` with the requested scope, and writes
  the returned scope-narrow JWT into `Authorization: Bearer …`. Aligns with
  the hub-as-AS direction settled in vault#212. Requires the operator token
  + a configured hub origin; both failure modes have specific remediation
  messages.
- **`--token <bearer>`** — paste an existing bearer (any shape: hub JWT,
  `pvt_*`, legacy YAML key) instead of minting. Skips all token-mint logic.
- **`--legacy-pat`** — mints a vault-DB `pvt_*` token. Preserved for
  self-hosted-without-hub setups. Prints a deprecation notice on stderr;
  the canonical path going forward is hub-mint.
- **`--scope vault:read|vault:write|vault:admin`** — narrows the minted
  token's scope. Default `vault:read` (least-privilege). For `--mint`,
  expands to `vault:<vault-name>:<verb>` so the JWT can't be re-used
  against other vaults on the same hub. For `--legacy-pat`, narrows the
  on-disk token's scope set.
- **`--install-scope user|project`** — `user` writes `~/.claude.json` (old
  behavior); `project` writes `./.mcp.json` in CWD (Claude Code's
  project-local config). Doctor checks both locations now.
- **`--vault <name>`** — targets a specific vault; the entry is keyed as
  `parachute-vault-<name>` so multi-vault installs coexist. Without
  `--vault`, the singular `parachute-vault` slot is used (one install
  per file, default).

### Internals

- `installMcpConfig(apiKey?)` signature → `installMcpConfig(opts)` with
  `targetPath` / `entryKey` / `vaultName` / `bearer` fields. Init's
  bootstrap path continues to mint a `pvt_*` so a fresh standalone install
  still works without a hub; operators with a hub re-run `mcp-install`
  (now defaulting to hub-mint) to upgrade.
- `removeMcpConfig` cleans both `~/.claude.json` and `./.mcp.json` and
  honors the new `parachute-vault-<name>` per-vault keys (plus the legacy
  `parachute-vault/<name>` slash-form for backward cleanup).
- `readMcpEntry` (doctor) checks both target files, prefers user-level,
  and accepts singular + per-vault entry keys. Reports which file +
  entry-key the check matched.
- New helpers in `src/mcp-install.ts`: `chooseHubOrigin` (bare origin for
  hub API calls), `readOperatorToken` (reads `~/.parachute/operator.token`),
  `mintHubJwt` (test-seamed fetch wrapper for the mint-token endpoint),
  `resolveInstallTarget` (user/project file resolver).

### Tests

26 new tests in `src/mcp-install.test.ts` cover: hub-mint happy path with
mocked fetch, every API/network failure mode, operator-token read paths,
install-target resolution, every flag-parsing rejection (mutually
exclusive auth modes, bad `--scope`, bad `--install-scope`, bad
`--client`), missing operator token, no-hub-configured, end-to-end
`--token` / `--legacy-pat` / `--install-scope project` / `--vault <name>` /
overwrite-existing-bearer. Doctor tests updated for the new check-name
shape that includes the source file + entry key. 1281/1281 pass.

### Out of scope (Phase C — deferred)

- **Cross-client support** (Cursor, Claude Desktop, Codex, Zed, Goose,
  Cline) — `--client` flag accepts only `claude-code` and rejects others
  with a "Phase C" message so the surface is documented but not yet
  pluralized.
- **Client auto-detection** (probe installed clients, suggest defaults).
- **Interactive picker** when run from a TTY without explicit flags.

## [0.4.3] — 2026-05-10

Two release cuts (`0.4.3-rc.1` and `0.4.3-rc.2`) ship together as `0.4.3`
on `@latest`. Release-RC detail is preserved in the entries below; this
heading is the operator-facing summary.

Theme: closing the high-priority friction points from the [vault#285
field-input evaluation](https://github.com/ParachuteComputer/parachute-vault/issues/285).
Two PRs landed under the rc chain:

- **vault#286 (rc.1)** — `updated_at` filter (1.5) + `update-note`
  response-shape opt-out (2.response). Two small additive enhancements;
  no behavior change for existing callers.
- **vault#289 (rc.2)** — bracket-style HTTP metadata filter (1.3) with
  bridge for `created_at` / `updated_at` and a deprecation path for the
  flat date params. Closes the largest HTTP-side surface gap.

### Read path

- **`dateFilter` recognizes `updated_at`** (1.5 / vault#286). SSG
  incremental-rebuild flows ask "what changed since X" via
  `dateFilter: { field: "updated_at", from: lastBuildISO }`. No
  indexed-field declaration required — `updated_at` is a real column on
  `notes` and joins `created_at` as a recognized exemption from the
  indexed-field gate.
- **HTTP bracket-style metadata filter** (1.3 / vault#289). Exposes
  vault's full engine operator set — `eq` / `ne` / `gt` / `gte` / `lt` /
  `lte` / `in` / `not_in` / `exists` — to HTTP consumers via
  `?meta[field][op]=value`. Bracket-style is the canonical shape going
  forward; the flat `date_field=…&date_from=…&date_to=…` form is
  deprecated (planned removal in a later 0.x, tracked at vault#288).

### Write path

- **`update-note` response-shape opt-out** (2.response / vault#286). New
  `include_content` parameter (default `true`). Set `false` and the
  response swaps the full `Note` for the lean `NoteIndex` shape (drops
  `content`, keeps `byteSize` / `preview` / `validation_status`).
  Order-of-magnitude smaller responses on big notes — the workflow that
  surfaced the friction.

### Discoverability

- **Cookbook section in `README.md`.** Patterns for path-subtree queries,
  sort-by-metadata, preview-only listings, incremental rebuilds, the new
  bracket-meta filter, surgical `content_edit`, atomic `append`, and the
  Funnel pointer for CI access. Distilled from the field-input thread.

### Out of scope (still deferred)

- **1.6 URL-safe slug** — design pending (stability under rename, derive
  from id vs path); deferred until a renderer concretely needs it.
- **Tunable preview length** — the 120-char default has held; revisit
  when a real consumer hits a wall.
- **Section / diff / line-range edits on `update-note`** — speculative
  given that `content_edit` + `append` cover the originating workflow.
- **OR composition across metadata filters** — engine doesn't expose OR
  through the `metadata` shape; future engine-level decision.

## [0.4.3-rc.2] — 2026-05-10

Closes the HTTP-side gap in vault's metadata-filter surface (vault#285
friction point 1.3). The engine has always supported the full operator set —
`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`/`not_in`/`exists` — and MCP exposes it.
Until this release, the HTTP route declared the surface "not practical in
query params" and dropped it entirely. Bracket-style filtering plumbs it
through with a consistent shape.

### Read path

- **Bracket-style metadata filter on `GET /notes` (vault#285 friction point 1.3).**
  Uses the Stripe / JSON:API / Strapi convention:

  ```
  ?meta[field][op]=value                 # eq, ne, gt, gte, lt, lte
  ?meta[field]=value                     # shorthand for eq (JSON-scan fallback;
                                         # no indexed-field declaration required)
  ?meta[field][in][]=v1&meta[field][in][]=v2   # array form
  ?meta[field][in]=v1,v2                 # comma-separated form
  ?meta[field][exists]=true              # presence check (true|false only)
  ```

  Multiple `meta[...]` params AND together. Same-field operators (e.g.
  `meta[score][gte]=5&meta[score][lt]=10`) merge into one operator object.
  Hand-rolled parser in `src/routes.ts` — vault doesn't ship the `qs`
  dependency, and the grammar is small enough that one regex + a couple of
  buckets is cleaner than pulling in a parser library.

- **Bridge for `created_at` / `updated_at` columns.** Bracket-style also
  accepts the real date columns:

  ```
  ?meta[created_at][gte]=2026-04-01
  ?meta[updated_at][gte]=2026-04-01
  ?meta[created_at][lt]=2026-05-01
  ```

  These route through `dateFilter` (not through `metadata`) because they're
  real columns on `notes`, not metadata fields — same exemption as the
  existing flat-param path. Only `gte` (→ inclusive `from`) and `lt` (→
  exclusive `to`) are accepted on these fields; other operators reject with
  a guiding error that names the supported ops. Matches the dateFilter
  contract exactly — `>= from AND < to` is half-open by design.

- **Tag-authorizes-index gate flows through.** Operator queries on a metadata
  field still require the field to be declared `indexed: true` in some tag
  schema (the engine's existing contract at
  `core/src/indexed-fields.ts:1-17`). Bracket-style errors surface as
  HTTP 400 with `code: "FIELD_NOT_INDEXED"`. Shorthand `?meta[field]=value`
  is the exception: it uses the json_extract fallback path and doesn't
  require an index, mirroring the engine's existing primitive-equality
  semantics.

### Deprecation

- **Flat date params are deprecated.** `?date_field=`, `?date_from=`,
  `?date_to=` (and the legacy bare-`date_from`/`date_to` shape) remain
  functional through the 0.5.x line — no behavior change for existing
  consumers — but bracket-style is canonical going forward. Planned removal
  in a later 0.x; tracked at vault#288. On overlap (a request that supplies both
  forms), bracket wins.

### Parser hardening (review folds on initial implementation)

The parser holds invariants that the engine doesn't enforce on its side,
because by the time bad input reaches the engine the parser has already
flattened things. Three classes of silent-data-loss caught in review:

- **Cross-column date filter rejection.** A request mixing
  `meta[created_at][gte]=…` and `meta[updated_at][lt]=…` previously
  flattened both onto a single column (whichever was parsed second won),
  silently applying one column's bound against the wrong column. Now
  rejects with INVALID_QUERY.
- **Shorthand-vs-operator on the same field is mutually exclusive.**
  `meta[field]=v` and `meta[field][gt]=w` in the same request used to
  silently stomp each other based on URL parameter order (insertion-order
  iteration). Both directions now reject with INVALID_QUERY.
- **`[]` array syntax is gated to `in` / `not_in`.** `meta[field][eq][]=v`
  is a shape error rather than a "happens to be an array passed to a
  scalar operator" — now caught at the parser layer with a clear message
  rather than via a generic engine-side INVALID_OPERATOR_VALUE.

Also: refactored the array-bucket keying from `${field}|${op}` string concat
to a nested `Map<field, Map<op, values>>` so field-name characters can't
collide with the delimiter.

### Test plan

- 23 new HTTP tests in `src/vault.test.ts` covering: every operator, both
  array forms, shorthand equality, compound AND on one field and across
  fields, the `created_at`/`updated_at` bridge, deprecation precedence
  (bracket wins), every rejection path (unsupported date-column op,
  non-boolean `exists`, non-indexed field, unknown operator), and the
  three silent-data-loss guards (cross-column date, shorthand+operator
  mix in both orderings, `[]` on non-array operator).
- 1255/1255 tests pass.

### Out of scope

- OR composition across `metadata` filters — the engine's `metadata` shape
  doesn't expose OR; left for a future engine-level decision.
- CLI bracket-style — CLI uses the MCP shape directly; not affected.
- Bumping the operator set on date columns past `gte`/`lt` — would require
  engine-side work and the half-open contract is intentional. Document
  rather than expand.

## [0.4.3-rc.1] — 2026-05-10

Two small additive enhancements distilled from the field-input evaluation in
vault#285. Neither changes existing behavior; both are opt-in conveniences for
agents and SSGs already hitting vault's query and write surfaces.

### Read path

- **`dateFilter` recognizes `updated_at` (vault#285 friction point 1.5).**
  Today `dateFilter.field` accepted only `created_at` or an indexed metadata
  field. `updated_at` joins them as a recognized real column — no indexed-field
  declaration required, no schema setup. Unblocks the incremental-rebuild
  pattern an SSG (or any syncing consumer) reaches for: ask vault "what
  changed since my last build" via
  `dateFilter: { field: "updated_at", from: lastBuildISO }`. Same API across
  MCP (`date_filter.field`) and HTTP (`?date_field=updated_at&date_from=…`).
  No B-tree index on `updated_at` today; a sequential scan is fine for the
  current sizes (file an issue if a real workload ever shows it).

### Write path

- **`update-note` response-shape opt-out (vault#285 friction point 2.response).**
  `update-note` accepts a new `include_content: boolean` parameter. Default
  is `true` for back-compat — existing callers see no change. Set to `false`
  and the response swaps the full `Note` for the lean `NoteIndex` shape
  (`id`, `path`, `createdAt`, `updatedAt`, `tags`, `metadata`, `byteSize`,
  `preview`); `validation_status` is preserved when present. Cuts the
  response cost on the agent workflow that motivated this — frequent
  `append` / `content_edit` edits to large notes — by an order of magnitude
  for big notes. Exposed via MCP `update-note` and HTTP `PATCH /notes/:id`.

### Notes on what stayed put

The wider vault#285 evaluation surfaced six other friction points. None ship
here; the framing is "small additive only, defer design choices":

- **1.1 path_prefix** — already shipped end-to-end (MCP + HTTP + storage).
- **1.2 sort by metadata** — already shipped via `order_by` on indexed fields.
- **1.3 metadata-value filters on HTTP REST** — engine + MCP have it; the
  HTTP query-string syntax is a design choice still pending.
- **1.4 tunable preview length** — `NoteIndex` already returns a 120-char
  preview; a knob is deferred until concretely needed.
- **1.6 URL-safe slug** — design pending (stability under rename, derive
  from id vs path); deferred until a renderer needs it.
- **1.7 Tailscale Funnel** — already documented in README §"Remote access
  via Tailscale Funnel."
- **Section 2 section/diff/line-range edits** — speculative; the
  `append`/`prepend`/`content_edit` primitives that already shipped in
  #200 cover the originating workflow; the response-side cost is what
  this release closes.

## [0.4.2] — 2026-05-10

Six release cuts (`0.4.1-rc.1` through `0.4.1-rc.6`) ship together as
`0.4.2` on `@latest`. Release-RC detail is preserved in the entries
below for granular history; this entry is the operator-facing summary.

### Auth

- **Hub revocation enforcement (hub#212 Phase 4, PR #281).** Hub-issued
  JWTs are checked against the hub's revocation list on every request.
  Bumps `@openparachute/scope-guard` from `^0.1.0` to `^0.2.0`. Revoked
  jtis are rejected with a `401`; client-facing messages for
  revocation-related codes (`revoked`, `revocation_unavailable`) are
  sanitized — full diagnostic stays in the server-side audit log via
  `console.warn`. The existing `pvt_*` opaque-token path is untouched.

### Schema & tags

- **Tag schema inheritance + `_default` universal parent (closes #270,
  rc.2).** A child tag's effective fields = its own ∪ all ancestors'
  (recursive walk, cycle-safe). Multi-inheritance via `parent_names`;
  conflict resolution is first-in-walk wins with a new
  `schema_conflict` advisory warning. A tag named `_default` is the
  implicit universal parent of every note (tagged or not).
- **Tag rename cascade (closes #240, #247, rc.4).** `renameTag(old,
  new)` now rewrites every surface where the old name was referenced
  — tags, sub-tags, `note_tags`, `parent_names` JSON arrays,
  `tokens.scoped_tags`, `indexed_fields.declarer_tags`, note body
  references (`#oldname` / `[[_tags/oldname]]`), and `_tags/<old>`
  config-note paths — in a single `BEGIN IMMEDIATE` transaction.
  **Breaking** for callers that relied on the old
  `tag_in_use_by_tokens` 409 on `POST /api/tags/:name/rename`; the
  cascade now rewrites token allowlists transparently and returns
  `200` with per-surface counts.
- **Migration v17: retire `note_schemas` + `schema_mappings` (closes
  #267, rc.1).** The parallel validation subsystem had zero rows in
  real vaults; the tables drop along with 6 MCP tools
  (`list-note-schemas`, `update-note-schema`, `delete-note-schema`,
  `list-schema-mappings`, `set-schema-mapping`,
  `delete-schema-mapping`) and `/api/note-schemas` REST endpoints.
  `tags.fields` is now the sole schema surface.

### vault-info

- **`vault-info` projection + structured connect-time MCP instruction
  (closes #271, rc.3).** Returns a comprehensive schema description —
  schema-bearing tags with effective inheritance, `indexed_fields`
  catalog, `query_hints` array — that an agent can use to self-orient.
  The MCP `initialize` response carries a markdown projection rendered
  from the same state. Filtered by tag-scoped tokens so the JSON tool
  and the connect-time brief stay in lockstep with the rest of the
  scope-aware surface. Token budget verified under ~5K at 50
  schema-bearing tags.
- **Stats line distinguishes note-usage from schema-bearing tag count
  (closes #274, rc.5).** Was `100 tags`; now `100 tags total, 5 with
  schemas`. Closes the ambiguity an agent or operator hit when many
  ad-hoc tags lived alongside few schema-bearing ones.

### Removed

- **`synthesize-notes` MCP tool retired (closes #268, rc.1).** The
  retirement is part of the same audit-driven cleanup as `note_schemas`
  removal — surfaces that weren't earning their keep.

### Migration notes

- Schema v17 runs idempotently on first boot of `0.4.2`. Existing
  `note_schemas` and `schema_mappings` rows drop; the data lived in
  parallel to `tags.fields` and was unused in real vaults.
- API callers that relied on the `tag_in_use_by_tokens` 409 from
  `POST /api/tags/:name/rename` will need to adapt — the cascade now
  rewrites token allowlists transparently and returns `200` with
  cascade stats. Existing callers using `result.renamed` continue to
  work; field semantics are unchanged.
- `schema_conflict` is a new `ValidationWarning.reason` value
  (rc.2). Strict-enum deserialization may see this on cross-ancestor
  field disagreement; the warning is advisory and safely ignorable by
  clients that don't recognize it.
- **`_default`-scoped auth tokens grant full-vault access.** Tag-scoped
  tokens compute their effective tag set via descendant expansion;
  because `_default` is the universal parent, expanding it returns the
  full tag list. Don't mint `_default`-scoped tokens thinking they
  restrict to a "default-only" tag.

## [0.4.1-rc.6] — 2026-05-10

### Changed

- **Hub-issued JWTs are now checked against the hub's revocation list on
  every request (hub#212 Phase 4).** Bumps `@openparachute/scope-guard`
  from `^0.1.0` to `^0.2.0`. The new version's `validateHubJwt` consults
  `<hub-origin>/.well-known/parachute-revocation.json` after sig/iss/aud/
  expiry pass; revoked jtis surface as `HubJwtError(code: "revoked")` and
  are rejected at `authenticateVaultRequest` with a 401. Without this,
  Aaron could revoke a token via the hub's mint API but vault would still
  honor it — this PR closes that gap from vault's side.

  The existing `pvt_*` opaque-token path is untouched. Phase 6 deprecates
  `pvt_*` separately.

  Failure semantics (live in scope-guard's revocation cache; vault just
  consumes the outcome):
  - 60s TTL matches the hub's `Cache-Control: max-age=60` on the endpoint.
  - Fail-open with last-good cache during a hub outage — a revoked token
    may be accepted up to ~60s past revocation when the hub is unreachable,
    matching the published convergence target.
  - Fail-closed only on first-fetch-failure (cold start, no last-good).
    Surfaces as `HubJwtError(code: "revocation_unavailable")` so operators
    can tell "list couldn't load" from "this token has been retired."

  Client-facing 401s for **all revocation-related codes** are sanitized:
  - `code: "revoked"` → client gets `"token has been revoked"`; the jti
    goes to the server-side audit log via `console.warn`.
  - `code: "revocation_unavailable"` → client gets
    `"token cannot be validated: revocation list unavailable"`; the
    implementation-detail phrasing (`"no last-good cache"`) goes to the
    server-side audit log.

  Sets the inheritable pattern across vault/scribe/agent: revocation
  diagnostics live in operator audit logs, never in the response body.
  Other failure modes (signature, audience, expired, etc.) forward the
  diagnostic message as before — they carry no jti and no implementation
  internals.

### Internal

- Test fixtures in `auth-hub-jwt.test.ts`, `hub-jwt.test.ts`, and
  `tokens-routes.test.ts` extended to serve `/.well-known/parachute-revocation.json`
  alongside the existing `/.well-known/jwks.json` mock. Default response
  is an empty list; `auth-hub-jwt.test.ts` adds explicit cases for revoked
  jtis, mixed-list happy path, and cold-start unreachable.

  scope-guard's own unit suite covers the cache mechanics (TTL refresh,
  fail-open with last-good, single-flight) — vault's tests pin the
  wire-up, the 401 response shapes, and the audit-log invariant
  (`console.warn` spy in the revoked-jti and cold-start cases asserts
  the full diagnostic routes server-side even though the client message
  is sanitized).

### Versioning note

Continues the `0.4.1-rc.N` chain (rc.5 → rc.6) per the pre-1.0 rule —
patch number bumps only on Aaron-confirmed releases.

## [0.4.1-rc.5] — 2026-05-09

### Fixed

- **`vault-info` connect-time stats line distinguishes note-usage tag
  count from schema-bearing count (closes #274).** Pre-fix, the line
  read `2280 notes, 100 tags` — conflating "tags any note carries"
  with "tags with schema declarations." An agent reading "100 tags"
  next to "5 tags with schemas" had to infer the relationship; in
  practice, vaults with many ad-hoc tags and few schema-bearing tags
  read the line as if every tag had a schema.

  New shape: `2280 notes, 100 tags total, 5 with schemas`. The
  schema-bearing count is dropped when zero (so an empty vault still
  reads cleanly as `0 notes, 0 tags total`). Pluralization preserved
  per the rc.3 fix.

  No JSON-schema change to `vault-info` — the stats object still
  carries `tagCount` (driven by `note_tags`) unchanged. The fix is
  purely in `projectionToMarkdown`.

## [0.4.1-rc.4] — 2026-05-09

### Added

- **Tag rename cascade (closes #240, #247).** `renameTag(old, new)` now
  rewrites every surface where the old name was referenced, in a single
  `BEGIN IMMEDIATE` transaction:

  1. `tags` PK row — and recursively for sub-tag rows whose name starts
     with `<old>/`.
  2. `note_tags.tag_name` FK references for every renamed name.
  3. `tags.parent_names` JSON arrays in OTHER tag rows (vault#247's
     specific piece — the inheritance resolver from #270 is now
     load-bearing on this integrity).
  4. `tokens.scoped_tags` JSON arrays — the rename→token cascade
     replaces the previous fail-closed 409 (`tag_in_use_by_tokens`) on
     `POST /api/tags/:name/rename`.

     > **Breaking** for API consumers who relied on that 409 to detect
     > token-referenced tags as rename-blockers. The cascade now
     > rewrites those tokens' allowlists transparently and returns 200
     > with cascade stats.
  5. `indexed_fields.declarer_tags` JSON arrays.
  6. Note body `content`: `#oldname` and `#oldname/...` references
     rewrite to `#newname` / `#newname/...`. `[[_tags/oldname]]`
     wikilinks rewrite to `[[_tags/newname]]`.
  7. `_tags/<oldname>...` config-note paths rewrite to `_tags/<newname>...`
     for vault hygiene (post-v14 these are inert breadcrumbs).

  Pre-flight collision check covers root + every sub-tag path so a
  partway-through abort can't happen on a UNIQUE-constraint violation.
  `target_exists` errors now carry a `conflicting: string[]` listing
  the colliding names.

  Return shape is augmented with per-surface counts:
  `{ renamed, sub_tags_renamed, parent_refs_updated, tokens_updated,
  indexed_field_declarers_updated, notes_rewritten, paths_renamed }`.
  REST `POST /api/tags/:name/rename` returns this shape on success.
  Existing callers using `result.renamed` continue to work; the field
  semantics are unchanged (count of `note_tags` rows repointed,
  cumulative across self + sub-tags).

  The store invalidates both `_tagHierarchy` and `_schemaConfig`
  caches after the cascade since parent_names and the tag set both
  change.

  Audit log: a single `[vault] tag rename cascade: <old> → <new>` line
  is emitted to stderr per cascade for forensic correlation.

### Fixed (folded from PR #275 review)

- **LIKE wildcards (`%`, `_`) inside tag names are now escaped at every
  pre-filter call site.** Pre-fold, a tag literally named `task_` would
  produce `LIKE '%"task_"%'` — and SQLite's LIKE engine treats `_` as
  "any single character," so `taskX` rows surfaced as false-positive
  candidates. The downstream JSON-array remap rejected the row so no
  data corruption — but the wasted scan + bad hygiene was worth
  closing. Each call site now uses `ESCAPE '\\'` paired with a
  pre-escaped pattern.
- **`indexed_fields.declarer_tags` filter gains an `IS NOT NULL`
  guard** to match the consistency of the parent_names + scoped_tags
  filters.

### Fixed (folded from PR #275 re-review)

- **Sub-tag discovery query escapes LIKE wildcards (load-bearing).**
  The upstream discovery query that populates the `renames` list
  (`SELECT name FROM tags WHERE name LIKE ? ORDER BY length(name) DESC`)
  was missed in the prior fold pass. With raw `oldName`, a tag named
  `task_` produced `LIKE 'task_/%'` which matches `taskX/sub` (because
  `_` is a single-char wildcard) — `taskX/sub` would have entered the
  rename transaction and been rewritten to `<new>/sub`, a write the
  caller never requested. Worse than downstream false-positives
  because this is what *populates* the rename set, not just a
  candidate filter. Now uses `escapeLikePattern(oldName)` + `ESCAPE
  '\\'`. Pinned by test #14.

### Notes

- **`name TEXT PRIMARY KEY` stays.** Aaron green-lit the multi-table
  cascade cost over a stable-ID rewrite (2026-05-09). The cascade is
  the load-bearing surface that makes natural-key tag identity
  workable across the schema.
- **Surfaces NOT touched.** Indexed-metadata column names derive from
  field names, not tag names, so `meta_<field>` stays stable across a
  tag rename. Cross-vault rename federation is out of scope.

## [0.4.1-rc.3] — 2026-05-09

### Added

- **`vault-info` projection + structured connect-time MCP instruction
  (closes #271).** `vault-info` now returns a comprehensive vault
  description that an agent can use to self-orient: `name`, `description`,
  `tags` (schema-bearing tag records with own `fields`/`parents` plus
  resolved `effective_fields`/`effective_parents` from the #270
  inheritance walk), `indexed_fields` catalog (one entry per
  `indexed_fields` row, listing every declarer tag), and a static
  `query_hints` array describing the `query-notes` interface. Stats
  remain gated by `include_stats: true` — when set, the existing
  `getVaultStats` shape is appended unchanged.

  The MCP `initialize` response now carries a markdown projection
  rendered from the same vault state (rather than just vault name +
  description). Agents see the schema landscape, the indexed-field
  catalog, and the query-hint catalog at session start, plus explicit
  pointers to call `vault-info` (full refresh) or `list-tags
  { include_schema: true }` (tag-only refresh) mid-session if state
  shifts. Token budget verified: under ~5K tokens at 50
  tags-with-schemas; ~600 for typical small vaults.

  Tool count stays at 9 — the projection rides on the existing
  `vault-info` surface; no new MCP tool added.

  Effective inheritance is computed by reusing #270's
  `resolveNoteSchemas` walk for each tag, so the per-tag projection's
  `effective_*` fields match runtime validation precedence (first-in-walk
  wins; `_default` is the implicit universal parent). Per-tag descriptions
  are surfaced in `vault-info` JSON only — the connect-time markdown
  brief lists tag *names* to keep the token budget tight.

### Fixed (folded from PR #273 review)

- **`vault-info` honors tag-scoped tokens (JSON tool + connect-time
  markdown).** Pre-fold, a token scoped to `task` got the full vault's
  `tags` catalog and `indexed_fields` table (every declarer surfaced).
  Now `vault-info` filters both arrays to entries an in-scope tag
  contributes to, and drops out-of-scope declarer names from each
  `indexed_fields` entry's `tags` field. The connect-time markdown brief
  rendered by `getServerInstruction` (sent via MCP `initialize`) is
  filtered to the token's allowlist via the same shared helper, so the
  JSON tool and the markdown brief stay in lockstep. Symmetric with the
  existing `list-tags` tag-scope wrapper. Aggregate stats (counts,
  monthly distribution) continue to flow through unchanged — pre-#271
  behavior.

## [0.4.1-rc.2] — 2026-05-09

### Added

- **Tag schema inheritance via `parent_names` + `_default` universal parent
  (closes #270).** A tag's `parent_names` column already drove query
  expansion (a query for `#manual` matched any descendant). It now also
  drives **schema inheritance**: a child tag's effective `fields` map = its
  own ∪ all ancestors' (recursive walk, cycle-safe). Multi-inheritance is
  supported — list multiple parents in `parent_names`.

  A tag named `_default` is treated as the implicit universal parent of
  every note, tagged or not. Its `fields` declarations apply everywhere.
  Modeling: magic at resolve time only — `tags.parent_names` is never
  auto-mutated. Removable by deleting the `_default` tag row. The
  symmetric query expansion: `query-notes { tag: "_default" }` returns
  every note in the vault (including untagged).

  Conflict resolution for multi-inheritance is **first-in-walk wins**:
  the child's own `fields` take precedence over inherited specs; among
  parents, earlier entries in `parent_names` outrank later ones. When
  ancestors disagree on a field's spec, the loser surfaces as a
  `schema_conflict` advisory warning on `validation_status` — no write
  blocking, consistent with the rest of the schema-validation model.
  Each `schema_conflict` warning carries `schema` (winner) and
  `loser_schema` (overridden) as structured fields so agents can resolve
  the disagreement without parsing `message`.

  Cache hygiene: the schema-config cache invalidates on `parent_names`
  changes (in addition to the existing `fields` mutations) since
  inheritance now walks parent chains.

### Notes

- **`schema_conflict` is a new `ValidationWarning.reason` value.** Existing
  reasons (`type_mismatch`, `enum_mismatch`) are unchanged. Downstream
  clients with strict-enum deserialization compiled against pre-`0.4.1-rc.2`
  `@openparachute/vault` types may see an unrecognized value if they hit
  vault rows where multiple ancestors declare the same field with diverging
  specs. The warning is advisory — clients can safely ignore unknown
  `reason` values.
- **`_default`-scoped auth tokens grant full-vault access.** Tag-scoped
  tokens (see `patterns/tag-scoped-tokens.md`) compute their effective tag
  set by expanding each input tag through `getTagDescendants`. Because
  `_default` is the universal parent of every tag, expanding it returns
  the full tag list — so a token scoped to `_default` is functionally
  equivalent to an unscoped token. **Do not mint `_default`-scoped tokens
  thinking they restrict to a "default-only" tag.** The semantic is
  intended (it's symmetric with the schema-inheritance model), but the
  wide blast radius is worth flagging explicitly.

### Fixed (folded from PR #272 review)

- **`tagMatch: "any"` + `_default` now drops the tag filter entirely.**
  Pre-fold, an `any`-match query like `tag: ["_default", "task"]` would
  strip `_default` and narrow to `task`-tagged notes only — wrong, since
  the OR-semantics with `_default` (which matches everything) should
  collapse to "every note." The `all`-match behavior (drop `_default`
  from the AND-set, keep the rest) was already correct and is unchanged.
- **`searchNotes` honors `_default` filter-strip.** The FTS-backed search
  path now short-circuits the tag filter when `_default` is requested,
  matching `queryNotes` semantics so untagged notes are reachable from
  search.

## [0.4.1-rc.1] — 2026-05-09

Audit-driven cleanup. The vault MCP surface had two subsystems that
weren't earning their keep — both retired in this RC.

### Removed

- **`note_schemas` + `schema_mappings` + 6 MCP tools (closes #267).** The
  v15 standalone validation subsystem turned out to be a parallel path to
  `tags.fields` with zero rows in the operator vault. Schema migration
  v17 drops both tables wholesale and the six MCP tools they backed
  (`list-note-schemas`, `update-note-schema`, `delete-note-schema`,
  `list-schema-mappings`, `set-schema-mapping`, `delete-schema-mapping`)
  retire alongside. REST endpoints under `/api/note-schemas` go away
  too. Validation now reads `tags.fields` exclusively — same shape
  (`{ type, enum, description }` per field), tag-axis only, advisory
  warnings only. The standalone `required` field-list concept retires
  with the table; declarations are guidance, not enforcement.

  *Migration note.* If your vault used path-prefix-mapped schemas (e.g.
  `match_kind: 'path_prefix'`), file an issue against vault#267
  describing the use case. Tag-mapped schemas continue working as
  `tags.fields` (unchanged for the operator). The migration logs a
  warning naming any dropped schemas/mappings if rows existed so the
  operator can re-create on `tags.fields` if needed.

  *Pre-v15 vault upgrade caveat.* A vault created before v15 shipped
  that never upgraded to v15 will skip the `_schemas/*` notes-as-config
  port path when migrating to v17 (the v14→v15 step ran the port; v17
  drops the destination tables). Any `_schemas/*` config notes in such
  a vault remain as harmless data but are no longer interpreted by
  validation. Operators with such vaults can recreate schemas on
  `tags.fields` directly via `update-tag`.

- **`synthesize-notes` MCP tool (closes #268).** 229 LOC + 160 test LOC,
  zero production invocations. Replicable with `query-notes(near={...})`
  + `find-path` + agent-side aggregation.

  *Migration note.* Agents wanting a ranked-neighborhood view can
  compose `query-notes(near={ note_id, depth: 2 })` + `find-path` +
  their own aggregation. If the optimization (one call vs. multiple)
  becomes load-bearing for a real use case, file an issue.

### Surface

- **MCP tool count: 16 → 9.** Remaining tools: `query-notes`,
  `create-note`, `update-note`, `delete-note`, `list-tags`, `update-tag`,
  `delete-tag`, `find-path`, `vault-info`.

## [0.4.0] — 2026-05-05

First minor bump since `0.3.3` on `@latest`. The work that accumulated across
the `0.3.6-rc.*` line plus the two `0.4.0-rc.*` cuts ships together. Release-RC
detail is preserved in the entries below for granular history; this entry is
the operator-facing summary.

### Schema

- **v14 — single-row tag identity (#244, #245).** Tag schemas (description,
  fields, relationships, parent_names) are columns on `tags` rather than
  `_tags/<name>` notes. One name = one row.
- **v15 — `note_schemas` + `schema_mappings` (#249).** Retire `_schemas/*` notes
  for first-class tables; clearer ownership, cheaper queries.
- **v16 — per-vault token storage (#258).** `tokens.vault_name` column +
  `idx_tokens_vault_name`. Legacy `NULL`-bound rows continue to authenticate as
  server-wide for back-compat; new mints default to vault-bound.

All three migrations idempotent under `BEGIN IMMEDIATE` / `COMMIT` /
`ROLLBACK` (#251 pinned the v14 wrap; v15 + v16 follow the same shape).

### Admin SPA

- **Scaffold + Phase A/B/C — vault detail, tokens, permissions** (#218 chain,
  #222, others). Per-vault dashboard is now a real surface — no more
  shell-only token administration.
- **Per-vault mount at `/vault/<name>/admin/`** (#252, #254, #255, #256).
  SPA boots under a runtime basename matching the mount; `module.json`'s
  `managementUrl` carries a trailing slash so hub-issued JWT fragments survive
  the click-through (browsers drop `#fragment` across 301s).

### Auth

- **Cross-vault token rejection at the auth boundary** (#258). When a `pvt_*`
  resolves to a different `vault_name` than the request's vault, `403` with
  both names in the message. Closes the implicit cross-vault listing surface.
- **JWT audience: per-vault `aud: vault.<name>`** (was hardcoded `"hub"`).
  Hub-issued JWTs scope-bind to the vault they were minted for, so a token
  for `vault.work` can't be replayed at `vault.personal`.
- **`config.yaml` scope-field parsing fix (priv-esc)** (#233). Pre-fix,
  legacy `permissions` keys silently inflated effective scope.

### Correctness

- **Batch operations transactionally atomic (vault#236, PR #260).**
  Multi-item batch entry points (`POST /api/notes`, `create-note`,
  `update-note`) wrap loops in `BEGIN` / `COMMIT` / `ROLLBACK`. A mid-batch
  failure no longer leaves prefix items written. Single-item paths skip the
  wrap to avoid colliding with concurrent callers on the shared bun:sqlite
  connection.
- **`.changes`-based conflict detection migrated to `RETURNING`
  (vault#261, PR #262).** Inside a multi-statement transaction with
  intervening writes, `Statement.run().changes` could carry stale values,
  silently bypassing the `if_updated_at` precondition check. Six sites
  migrated to detect row presence via SQLite's `RETURNING` clause.

### Smaller fixes worth naming

- `query-notes` routes FTS through `store.searchNotes` (#231) and accepts
  camelCase / singular aliases (#224); generalized `date_filter` on indexed
  metadata (#230).
- Empty-note pre-validation + 500-cap batches (#235, vault#213) — closes the
  "7,453 empty pathless rows in one MCP burst" runaway-client surface.
- Tag-scoped tokens Phase 1 (#241).
- `cli init` autostart opt-out via `--no-autostart` (#207, #211).
- `parachute-vault create` re-registers vaults in `services.json` (#209).
- `bun run typecheck` canonical script (#232).
- Hub-issued scope-guard adoption (#212) — common scope-narrowing primitive
  shared with `parachute-hub`.
- `web/ui` per-vault mount routing fixes (#252, #253, #254 — see SPA section).

### Migration notes

- Schema v14, v15, v16 run in sequence on first boot of `0.4.0`. Each is
  idempotent and self-rolls-back on failure.
- Existing tokens minted before v16 carry `vault_name = NULL` and
  authenticate as server-wide. New mints default to vault-bound; pass
  `--all` to `tokens create` to opt back into a server-wide mint (warning
  printed).
- Hub-issued JWTs with the old `aud: "hub"` claim continue to validate
  during the rolling-update window; new mints emit per-vault `aud`.

### Closed without code change

- vault#102 (publish `@openparachute/core` to npm) — `core/` ships bundled
  in the vault tarball; no external consumer needs the standalone package.

## [0.4.0-rc.2] — 2026-05-04

A correctness fix on top of rc.1. The atomicity wrap landed in rc.1 made a
latent bun:sqlite quirk reachable through `if_updated_at`-based optimistic
concurrency; this RC migrates conflict / existence detection off
`Statement.run().changes` to `UPDATE...RETURNING` / `DELETE...RETURNING`
across every site that reads it.

### Fixed

- **vault#261 — `.changes`-based conflict detection migrated to
  `RETURNING`.** Inside a multi-statement transaction with intervening
  writes, `Statement.run().changes` could carry stale values, silently
  skipping the `if_updated_at` precondition check in `noteOps.updateNote`.
  Six sites migrated to detect row presence via SQLite's `RETURNING` clause
  instead of row-count: `core/src/notes.ts` (main + sets-empty conditional
  UPDATE, `renameTag` count), `core/src/note-schemas.ts` (`deleteNoteSchema`,
  `deleteSchemaMapping`), `src/token-store.ts` (`revokeToken`).

### Tests

- `core/src/core.test.ts` — MCP `update-note` batch where item 1's stale
  `if_updated_at` triggers a `ConflictError`: assert item 0's prefix
  mutation rolled back. Pre-fix this test silently passes (the bug class);
  post-fix it asserts the conflict surfaces and the batch unwinds.

## [0.4.0-rc.1] — 2026-05-04

Release-prep cut for the `0.4.0` `@latest` publish. The minor bump signals
the meaningful surface change accumulated across 39 RCs on `0.3.6`: admin
SPA mounted per-vault, per-vault token storage with cross-vault binding,
schema migrations through v16, and the auth-boundary rewrite. This RC
itself folds one correctness fix — vault#236 — and clears housekeeping.

### Fixed

- **vault#236 — batch operations are now transactionally atomic.** Wrap
  multi-item batch loops in `BEGIN` / `COMMIT` / `ROLLBACK` at the three
  public batch entry points (`src/routes.ts` `POST /api/notes`,
  `core/src/mcp.ts` `create-note`, `core/src/mcp.ts` `update-note`). Mirrors
  the existing `core/src/notes.ts:createNotes` pattern. Without this, a
  mid-batch failure (path conflict, conditional-update conflict) left the
  prefix items already written. Single-item calls skip the wrap so
  concurrent callers don't collide on the shared bun:sqlite connection —
  single-note paths are already atomic at the store layer.

### Tests

- `src/vault.test.ts` — HTTP `POST /notes` batch where mid-item triggers
  `PATH_CONFLICT`: assert nothing from the prefix lands.
- `core/src/core.test.ts` — MCP `create-note` batch + `update-note` batch
  with mid-batch `PATH_CONFLICT`: assert prefix items rolled back.

### Closed without code change

- vault#102 (publish `@openparachute/core` to npm) — mooted; `core/` is
  bundled into the vault tarball via `package.json` `files`. No external
  consumer needs the standalone publish today; revisit if that changes.

## [0.3.6-rc.39] — 2026-05-04

vault#257 — per-vault token storage migration. Tokens now bind to the vault they were minted from, and cross-vault use is rejected at the auth layer. Pre-v16 tokens carry a `NULL` `vault_name` and remain server-wide (legacy compatibility), so existing deployments keep working unchanged; new mints default to vault-bound. The cross-vault leak surface was small in practice (per-vault DBs already scope storage; only `authenticateGlobalRequest` at `/mcp` iterated across vaults), but the explicit `vault_name` column closes the gap with defense-in-depth at every per-vault auth path.

### Changed

- **Schema v15 → v16: `tokens` table grows `vault_name TEXT` + `idx_tokens_vault_name` index.** `core/src/schema.ts:migrateToV16` runs an idempotent `ALTER TABLE … ADD COLUMN` inside `BEGIN IMMEDIATE` / `COMMIT` (ROLLBACK on failure) — same shape as v14/v15 from vault#251. Lenient backfill: existing rows get `NULL` (= legacy server-wide). New rows default to the minting vault's name. Index keeps the per-vault `WHERE vault_name = ? OR vault_name IS NULL` filter cheap on large token sets.
- **`src/auth.ts:authenticateVaultRequest` rejects cross-vault token use with 403.** When a `pvt_*` resolves to `vault_name = <other>` and the request is for `<this>`, the response is `403 Unauthorized` with a message naming both vaults. `NULL`-bound (legacy) tokens still pass — the migration is additive, not breaking. Hub-issued JWTs continue to use `vault:<name>:<verb>` scope narrowing as the audience-binding mechanism (JWTs aren't per-token-DB rows, so `vault_name` doesn't apply).
- **`src/token-store.ts` surfaces `vault_name` end-to-end.** `Token` and `ResolvedToken` carry the field; `createToken` accepts an optional `vault_name` (default null = server-wide); `listTokens` accepts `{ vaultName }` and filters with `WHERE vault_name = ? OR vault_name IS NULL` so legacy NULL-bound rows remain visible alongside the bound set.
- **`src/tokens-routes.ts` per-vault endpoints filter by `vault_name`.** `GET /vault/<name>/tokens` returns vault-bound + legacy NULL-bound rows; `POST` mints with `vault_name = <name>`; `DELETE` only revokes rows that belong to the calling vault (or are NULL-bound). The implicit cross-vault listing surface in the SPA is now closed at the route layer, not just the SPA layer.
- **`src/cli.ts tokens` gains `--vault <name>` and `--all` flags.** `tokens list --vault <name>` mirrors the SPA's per-vault filter from the command line. `tokens create --all` is the explicit opt-in for a server-wide mint (prints a warning since that's no longer the default); `tokens create --vault <name>` binds explicitly; `tokens create` with neither defaults to the active vault. List output annotates legacy rows with `[server-wide]` so operators can spot pre-v16 tokens at a glance.
- **`web/ui/src/lib/tokens-api.ts:TokenSummary` adds `vault_name: string | null`.** The SPA's wire-shape interface mirrors the server's `tokens-routes.ts` response. `web/ui/src/routes/VaultTokens.tsx` renders a `server-wide` badge next to NULL-bound rows so legacy tokens are visually distinct from per-vault mints — matches the issue's UI guidance.

### Tests

- `src/token-store.test.ts` — new `per-vault binding (v16)` describe (3 cases): NULL when `vault_name` omitted, binding when set, `listTokens({ vaultName })` returns vault-bound + legacy NULL but excludes other-vault-bound rows. Doubles as a v16-migration pin since the test creates fresh DBs through `initSchema` (current SCHEMA_VERSION) and operates on the new column.
- `src/auth.test.ts` — new `auth — cross-vault isolation` describe (3 cases): cross-vault binding rejects 403, matched binding accepts, NULL-bound legacy tokens still authenticate.
- `src/tokens-routes.test.ts` — new v16 list-filter case: plants a token in another vault's DB and a legacy NULL-bound row in the calling vault's DB; asserts the foreign-vault row is excluded from the response, the legacy row is present, and the response surfaces the new `vault_name` field.
- `web/ui/src/routes/VaultTokens.test.tsx` — fixture migrated to include `vault_name: "work"` so the typecheck pins the field's presence on the wire.

## [0.3.6-rc.38] — 2026-05-04

vault#252 third follow-up — fix the empty-stats render Aaron caught after rc.37 unblocked the auth flow. The Stats section on the per-vault detail page rendered all four labels (Notes / Tags / Attachments / Links) but the values next to them were blank. Two contributing bugs: the SPA's `VaultStats` interface used short names (`notes`, `tags`, `attachments`, `links`) that don't exist in the wire payload, and the server-side `VaultStats` had no attachment count at all. Every read coerced `undefined` → `""` and rendered blank.

### Changed

- **`core/src/types.ts:VaultStats` adds `attachmentCount: number`.** Single `SELECT COUNT(*) FROM attachments` in `core/src/notes.ts:getVaultStats`. Cheap query against a small table — same shape as the existing `tagCount` / `linkCount` adjacent counters. Non-breaking addition: `vault-info` MCP tool, `/api/vault?include_stats=true`, and the bare `/vault/<name>/` detail endpoint all surface the new field automatically. Fills the gap between the documented four-stat UI and the previously-three-stat server payload.
- **`web/ui/src/lib/api.ts:VaultStats` field names align with the server.** `notes` → `totalNotes`, `tags` → `tagCount`, `attachments` → `attachmentCount`, `links` → `linkCount`. The wire payload's keys are the canonical source — the SPA used to shadow them with shorter names, which silently failed. New JSDoc documents the contract: SPA's interface mirrors `core/src/types.ts:VaultStats` byte-for-byte for the fields it reads.
- **`web/ui/src/routes/VaultDetail.tsx` reads the wire-shape field names directly.** No transform layer — the server returns what the SPA renders, so a future field rename trips the typechecker, not the user.

### Tests

- `core/src/core.test.ts` — new `getVaultStats counts attachments` case (creates two notes, attaches three files across them, asserts `attachmentCount === 3`); existing `getVaultStats returns correct stats` case extended to assert `attachmentCount === 0` for the no-attachments baseline.
- `web/ui/src/App.test.tsx` — new `renders the actual stat counts from the wire payload` case under per-vault mount: mocks `getVaultDetail` with `{totalNotes: 12, tagCount: 3, attachmentCount: 1, linkCount: 4}` and asserts every value renders. Explicit regression pin against the field-name drift that motivated this fix; future rename on either side trips this test.
- `web/ui/src/lib/api.test.ts` — fixture migrated to wire-shape names (was the source of the silent drift — the test passed even when the SPA was reading nonexistent keys, because the test fixture matched the SPA's reads, not the server's writes).

## [0.3.6-rc.37] — 2026-05-04

vault#252 second follow-up — fix the actual root cause of Aaron's no-token error after rc.36 closed the URL-doubling bug. Browsers drop URL fragments when following a 301 redirect (RFC 7231 says SHOULD preserve, but Chrome/Firefox/Safari behavior is inconsistent in practice — WebKit historically drops, Chrome sometimes preserves). The hub-issued JWT travels in `#token=…`, so the redirect rc.35 added (`/vault/<name>/admin` → `/vault/<name>/admin/`) was dropping the token before the SPA could capture it. The SPA then booted unauthenticated and rendered the no-token error — even though the operator clicked through hub correctly.

### Fixed

- **`.parachute/module.json` `managementUrl: "/admin"` → `"/admin/"`.** Hub's `resolveManagementUrl` (parachute-hub `web/ui/src/lib/api.ts`) joins the per-vault module URL with this string verbatim. With the trailing slash the canonical click target is `/vault/<name>/admin/` directly — no redirect, no fragment loss, browser preserves `#token=…` end-to-end. The server-side 301 from rc.35 stays as defense-in-depth (covers manual URL typing and old bookmarks), but it's no longer load-bearing for the hub flow. Establishes the contract: SPA-style `managementUrl`s should end with `/` so the URL the operator's browser sees is the same URL the server serves.

### Tests

- `src/admin-spa.test.ts` (2 new) — pin the hub↔vault `managementUrl` contract: (a) `module.json`'s `managementUrl` ends with `/`, (b) the canonical hub-emitted URL (per-vault module URL joined with `managementUrl` à la `resolveManagementUrl`) serves the SPA shell with status 200 and no `Location` header. The "no Location header" assertion is the explicit regression pin — if a future change re-introduces a 301 on the canonical form, fragments would silently drop again.

## [0.3.6-rc.36] — 2026-05-04

vault#252 follow-up — fix URL doubling under per-vault mount. The rc.35 SPA used `<Navigate to="/vault/<name>" replace />` from the `/` route to jump operators landing at `/vault/<name>/admin/` straight to the vault detail page. Under React Router v6 with `<BrowserRouter basename="/vault/<name>/admin">`, paths in `<Navigate to>` and `<Link to>` are basename-relative absolute paths — so the redirect resolved to `/vault/<name>/admin/vault/<name>` (basename + path), and the operator landed on a doubled URL with no matching route, falling through to the auth-required shell. The redirect was the wrong shape: the SPA needs different routes per mount mode, not a clever redirect.

### Fixed

- **`web/ui/src/App.tsx` switches the route table on mount mode instead of redirecting.** When `getMountedVaultName()` returns a name (per-vault mount), the route table is `{ "/" → VaultDetail, "/tokens" → VaultTokens }` with the mounted vault name passed as a prop. When it returns null (legacy `/admin/*` or stand-alone), the table is the original picker tree (`{ "/" → VaultsList, "/vault/:name" → VaultDetail, "/vault/:name/tokens" → VaultTokens }`). No `<Navigate>` anywhere — the route table answers the URL directly. Nav-bar's vault-name link points at `/` under per-vault mount (was `/vault/<name>` — the same doubling).
- **`VaultDetail` and `VaultTokens` accept an optional `vaultName` prop, fall back to `useParams()`.** Per-vault mount passes the prop straight through (no `:name` segment exists under `basename="/vault/<name>/admin"`); stand-alone reads it from the URL params. The presence of the prop also picks the inner-Link shape — `/tokens` vs `/vault/<name>/tokens` from VaultDetail's Manage section, `/` vs `/vault/<name>` for VaultTokens's "← Vault detail" back-link. Picking the wrong shape re-introduces the doubled-URL bug, so the choice is local to where the link is emitted.
- **Back-to-vaults links suppressed under per-vault mount.** The hub doesn't proxy `/vaults/list`, so a "← Back to vaults" link under per-vault mount would land on a broken picker. The auth-required banner already directs the operator back to the hub directory; that's the actual remediation path.

### Tests

- `web/ui/src/App.test.tsx` (new) — 8 cases pinning the mount-mode split: per-vault mount renders `VaultDetail` directly at `/` (no redirect, no doubled URL), emits the Tokens link as `/tokens` (NOT `/vault/<name>/tokens`), and renders `VaultTokens` at `/tokens`; stand-alone mount keeps the picker-then-detail tree with the full `/vault/<name>` shape. The Tokens-link href assertion is the explicit regression pin — under `<BrowserRouter basename="/vault/<name>/admin">` the wrong shape would re-introduce the bug.

## [0.3.6-rc.35] — 2026-05-03

vault#252 — remount the admin SPA from origin-rooted `/admin/*` to per-vault `/vault/<name>/admin/*` so it's reachable through hub's `/vault/<name>/*` proxy. The hub doesn't proxy origin-rooted paths, which left an operator clicking "Manage Vault" on the hub directory landing on a 401-walled vault metadata endpoint instead of the SPA. Three layers move in lockstep — the server's static-file dispatch, the React Router runtime basename, and Vite's asset-base — so the same compiled bundle works at any per-vault mount without a rebuild.

### Changed

- **`src/admin-spa.ts:isAdminSpaPath` regex + `serveAdminSpa` strip.** New mount regex `/^\/vault\/([^/]+)\/admin(?=\/|$)/` matches `/vault/<name>/admin` and any subpath under it (assets, client-routed paths). The strip-prefix collapses to `pathname.replace(MOUNT_RE, "")` so `/vault/foo/admin/assets/x.js` maps to `/assets/x.js` against the same `dist/` directory. Bare `/vault/<name>/admin-foo` and `/vault/<name>` (the metadata endpoint) explicitly do not trigger the SPA — only the mount root and its true subpaths. Routing test `/vault/<name>/api/notes` still reaches the per-vault API (regression pin).
- **`src/routing.ts` admin-spa dispatch must fire BEFORE per-vault dispatch.** Already the case, but the comment block now spells out why — the per-vault auth wall would otherwise short-circuit static-asset responses with a 401 JSON body. The legacy origin-rooted `/admin/*` no longer matches anything; falls through to the catch-all 404. Hub's directory page links to `/vault/<name>/admin#token=…` post-hub#162-realignment.
- **`web/ui/src/lib/mount.ts` (new): runtime basename detection.** `getMountedVaultName()` extracts `<name>` from `window.location.pathname`; `getBasename()` returns the matching React Router basename (`/vault/<name>/admin`, with percent-encoding preserved so it matches the URL byte-for-byte). Legacy fallback to `/admin` for dev served at the old mount; empty string for stand-alone root. Mirrors hub#173's dual-mount basename detection on the hub side.
- **`web/ui/src/main.tsx` BrowserRouter basename pulled from `getBasename()`.** No longer reads `import.meta.env.BASE_URL` since the build base is now relative — and the runtime mount is per-vault anyway, which can't be baked at build time.
- **`web/ui/src/App.tsx` redirects `/` to `/vault/<name>` when mounted under a specific vault.** The generic vault picker (`VaultsList`) calls `/vaults/list`, which hub doesn't proxy — so when reached via the hub proxy the picker would show an empty/erroring list. Per-vault mount jumps straight to the detail page using `<Navigate to="/vault/<name>" replace />`. Nav-bar label switches to the vault name (`<code>boulder</code>`) under per-vault mount instead of the generic "Vaults" link. Legacy `/admin/*` and stand-alone root mounts still get the picker.
- **`web/ui/vite.config.ts` `base: "./"` (was `/admin/`).** Asset URLs resolve relative to wherever `index.html` was served, so the same bundle works at any `/vault/<name>/admin/` mount without a rebuild. `VITE_BASE_PATH` override still works for stand-alone dev (`VITE_BASE_PATH=/`).
- **`web/ui/scripts/verify-base.mjs` asserts `./assets/` (was `/admin/assets/`).** Same drift check, adapted to the new relative-base contract; the override skip-condition now matches `VITE_BASE_PATH=./`.
- **`web/ui/CLAUDE.md` mount-aware contract section + lib/auth.ts JSDoc** updated to document the per-vault mount, runtime basename detection, and the new "Manage" link shape (`<hub-origin>/vault/<name>/admin#token=…`).

### Fixed

- **`serveAdminSpa` redirects bare `/vault/<name>/admin` → `/vault/<name>/admin/` (301).** Browsers resolve relative URLs against the **directory** of the current document, not the document URL itself — so Vite's `./assets/index-abc.js` resolves correctly only when the SPA is loaded with a trailing slash. Hub's `resolveManagementUrl` (`web/ui/src/lib/api.ts`) generates the bare form (strip trailing slash, append `/admin`), which means without this canonicalization the SPA bundle's asset URLs would resolve to `/vault/<name>/assets/...` and 404 against the per-vault auth wall — the SPA would never boot. Same shape the notes-server uses for its `--mount` canonicalization. Reviewer-caught blocker on the initial #252 push; the redirect ships in the same PR. New regression test in `admin-spa.test.ts` pins the 301 + Location header so future refactors can't silently regress the asset-resolution contract.

### Tests

- `src/admin-spa.test.ts` — 8 new cases for the per-vault regex (matches `/vault/<name>/admin[/...]`, rejects `/vault/<name>/admin-foo`, `/vault/<name>`, origin-rooted `/admin/*`, percent-encoded vault names strip cleanly).
- `src/routing.test.ts` — 7 new cases for the dispatch (per-vault SPA mount fires before per-vault dispatch, even when the vault doesn't exist — the SPA shell is static; POST 405; `/vault/<name>/admin-foo` falls through to per-vault auth wall; legacy `/admin/*` returns 404; `/vault/<name>/api/notes` regression pin).
- `web/ui/src/lib/mount.test.ts` — 11 new cases covering vault-name extraction (per-vault mount, deep client-routed paths, percent-decoded names), null cases (legacy `/admin/`, stand-alone root, per-vault metadata path, `/vault/<name>/admin-foo`), and basename construction (preserves percent-encoding for byte-for-byte React Router matching).

## [0.3.6-rc.34] — 2026-05-04

vault#248 — wrap the v13 → v14 migration in an explicit `BEGIN IMMEDIATE / COMMIT` transaction so a crash mid-migration leaves the DB in either pre-v14 or post-v14 state, never half-migrated. Surfaced during review of vault#245: every step in `migrateToV14` is individually idempotent (ALTER TABLE adds are guarded by `hasColumn`, data copies are upsert-and-update, the final `DROP TABLE tag_schemas` is guarded by `hasTable`), but the failure mode wasn't specified — a future reader could remove the guards thinking "we have transactions now." Wrapping the body makes the guarantee explicit; the idempotent guards become belt-and-suspenders.

### Fixed

- **`migrateToV14` body wrapped in `BEGIN IMMEDIATE / COMMIT` with try/catch ROLLBACK.** Mirrors the v15 transaction wrap that landed in rc.32. The early-return guard (`if (!hasTable(db, "tags")) return`) stays outside the envelope — if there's no `tags` table at all, there's nothing to roll back. Inside: ALTERs, two data copies (`tag_schemas` → `tags`; `_tags/<name>` notes → `tags.parent_names`), the timestamp backfill, and the final `DROP TABLE tag_schemas` all live inside one envelope; a thrown exception in any step rolls back the whole migration. Modern SQLite (3.6+ via bun:sqlite) supports DDL inside transactions, so ALTER and DROP both honor the rollback. New regression test (`crash mid-migration rolls back to pre-migration state, then retry succeeds`) injects a throw on `DROP TABLE tag_schemas`, asserts the DB returns to pre-v13 shape (tag_schemas table present with rows intact, tags has `(name)` only, `_tags/voice` note untouched), then drops the injection and re-runs `initSchema` — convergence to the same final post-v14 state as a clean run.

## [0.3.6-rc.33] — 2026-05-03

vault#249 reviewer-fold pass: tighten the auth boundary on the new `/api/note-schemas` (+ matching MCP tools) so tag-scoped tokens can't enumerate or write `tag`-kind `schema_mappings` outside their allowlist, fix the `migrateToV15` short-circuit to use `||` instead of `&&` (a vault with schemas but zero mappings is a valid state — the buggy condition re-scanned `_schema_defaults` on every boot), and refresh the `resolveApplicableSchemas` JSDoc to point at `note_schemas` instead of the retired `_schemas/<name>` convention. No data shape or version-bump trigger; rc.33 carries the reviewer feedback only.

### Fixed

- **`handleNoteSchemas` threads `tagScope` through every read and write.** Mirrors the `handleTags` precedent (vault#241): list/get of `schema_mappings` filters `tag`-kind rows whose `match_value` falls outside the token's expanded allowlist (path_prefix mappings carry no tag-axis information and stay visible). `POST` and `DELETE` on `/api/note-schemas/:name/mappings` reject out-of-scope `tag` writes with the standard `403 {error_type: "tag_scope_violation"}` envelope. The MCP wrappers in `src/mcp-tools.ts` get matching guards on `list-note-schemas`, `set-schema-mapping`, and `delete-schema-mapping` so the auth boundary is consistent across HTTP and MCP. The string-form fallback in patterns/tag-scoped-tokens.md §Storage details is honored end-to-end via `tagsWithinScope([match_value], allowed, raw)`.
- **`migrateToV15` short-circuit `hasSchemas && hasMappings` → `hasSchemas || hasMappings`.** A vault that has schemas but no mappings (or — structurally impossible today, but defensively correct — mappings but no schemas) is a valid post-v15 state. The previous `&&` would re-scan `_schemas/*` and `_schema_defaults` notes on every boot when one table was empty, even though `INSERT OR IGNORE` made the result safe. One-character fix; new regression test asserts the migration no-ops when `note_schemas` is non-empty and `schema_mappings` is empty.
- **`resolveApplicableSchemas` JSDoc refresh.** Comment said "names that don't have a backing `_schemas/<name>` definition are dropped" (pre-v15 vocabulary). Updated to "names that don't have a row in `note_schemas`."

## [0.3.6-rc.32] — 2026-05-03

`_schemas/*` notes-as-config retirement — closes the convention-vs-table loop that the rc.31 tag-identity reshape opened. Two new SQLite tables — `note_schemas` (definition: name, description, fields JSON, required JSON, timestamps) and `schema_mappings` (binding: schema_name FK, match_kind ∈ {`path_prefix`, `tag`}, match_value, composite PK, ON DELETE CASCADE) — replace the `_schemas/<name>` and `_schema_defaults` notes-as-config convention. Validation (`validation_status` on create-note / update-note responses) is unchanged in behavior; the resolver just reads from the new tables instead of scanning notes. Authoring moves to a proper API: six new MCP tools (`list-note-schemas`, `update-note-schema`, `delete-note-schema`, `list-schema-mappings`, `set-schema-mapping`, `delete-schema-mapping`) and a matching REST surface (`/api/note-schemas[/:name]` + nested `/mappings`). The legacy notes are LEFT IN PLACE post-v15 — inert (no resolver reads them), preserved as audit trail. Schema bumped 14 → 15.

### Added

- **`note_schemas` and `schema_mappings` tables (schema v15).** `note_schemas` is the definition row: `name TEXT PRIMARY KEY, description TEXT, fields TEXT` (JSON object keyed by field name, each value `{type, enum?, description?}` — same shape the legacy `_schemas/<name>.metadata` carried), `required TEXT` (JSON array of field names that must be present, or NULL when no field is required), `created_at TEXT, updated_at TEXT`. `schema_mappings` is the binding row: `schema_name TEXT NOT NULL REFERENCES note_schemas(name) ON DELETE CASCADE, match_kind TEXT CHECK (match_kind IN ('path_prefix','tag')), match_value TEXT NOT NULL, PRIMARY KEY (schema_name, match_kind, match_value)`. The composite PK makes `setSchemaMapping` idempotent — re-setting the same triple is a no-op. ON DELETE CASCADE means `deleteNoteSchema('foo')` automatically clears every `(foo, *, *)` mapping, so the two tables stay coherent without a separate cleanup step. Index `idx_schema_mappings_match` on `(match_kind, match_value)` keeps validation lookups O(log n) as the mapping table grows.
- **`note-schemas.ts` CRUD module + Store interface.** Seven typed entry points on `Store`: `listNoteSchemas()`, `getNoteSchema(name)`, `upsertNoteSchema(name, patch)` (partial-upsert mirroring `upsertTagRecord` — undefined preserves, null clears, empty `required: []` collapses to null), `deleteNoteSchema(name)`, `listSchemaMappings(opts?)` (filter by `schema_name` and/or `match_kind`), `setSchemaMapping(schema, kind, value)`, `deleteSchemaMapping(schema, kind, value)`. The schema-config cache (`BunSqliteStore._schemaConfig`) is invalidated synchronously inside the writers so reads after writes always see the post-write state — invalidation moved off the note-write hook (where it was a stale O(write) tax for vaults that never used `_schemas/*`) onto the table-write hook.
- **MCP authoring surface — six new tools.** `list-note-schemas` (with optional `name` for single-fetch + nested mappings, or `include_mappings: true` to inline mappings on every entry), `update-note-schema` (partial-upsert; routes through `store.upsertNoteSchema` so the cache invalidates), `delete-note-schema` (drops the row; FK CASCADE clears mappings), `list-schema-mappings` (filter by `schema_name` and/or `match_kind`), `set-schema-mapping` (validates `match_kind` against `MAPPING_KINDS = ['path_prefix','tag']` at the boundary), `delete-schema-mapping`. Tool count goes 10 → 16. Same shape as `update-tag` / `delete-tag` for consistency.
- **REST authoring surface — `/api/note-schemas`.** `GET /api/note-schemas[?include_mappings=true]` lists all schemas (optionally inlining each schema's mappings); `GET /api/note-schemas/:name` returns a single schema with its mappings (404 when missing); `PUT /api/note-schemas/:name` partial-upserts (auto-creates the row if missing, accepts `description`/`fields`/`required`, returns the post-write row); `DELETE /api/note-schemas/:name` drops the schema (FK CASCADE clears mappings). Mappings are nested under `:name`: `GET /api/note-schemas/:name/mappings` lists, `POST /api/note-schemas/:name/mappings` adds (body `{match_kind, match_value}`; returns 201; pre-validates the FK as 404 rather than letting SQLite throw 500 on a missing schema), `DELETE /api/note-schemas/:name/mappings?match_kind=...&match_value=...` removes (query parameters, not URL segments — `match_value` for `path_prefix` mappings can contain slashes, which would break path-segment routing). Bad `match_kind` returns `400 {error_type: "invalid_match_kind"}`.
- **`loadSchemaConfig` resolver swapped from notes-scan to table-scan.** `core/src/schema-defaults.ts` now queries `note_schemas` + `schema_mappings` instead of scanning `_schemas/<name>` and `_schema_defaults` notes; the same `ResolvedSchemas` shape is returned, so `resolveApplicableSchemas` and `validateMetadata` are untouched. `SCHEMA_CONFIG_PREFIX = "_schemas/"` and `SCHEMA_DEFAULTS_PATH = "_schema_defaults"` remain exported for any historical caller that still references them, but no resolver code reads notes-as-config post-v15.

### Storage / migration

- **Schema bumped 14 → 15.** The two new tables are `CREATE TABLE IF NOT EXISTS` so a fresh vault picks them up directly; existing vaults get the same `IF NOT EXISTS` adds plus a one-shot data fold. `migrateToV15(db)` short-circuits when the destination tables already have data (no re-scan on every boot), wraps the fold in `BEGIN IMMEDIATE / COMMIT / ROLLBACK` so a crash mid-migration leaves the DB in pre-v15 or post-v15 state (never partial — stronger guarantee than v14, where the missing transaction is the subject of vault#248), then: (1) copies every `_schemas/<name>` note's `metadata.{description, fields, required}` into a `note_schemas` row keyed by the path suffix; (2) copies the `_schema_defaults` note's `metadata.path_prefixes` and `metadata.tags` into matching `schema_mappings` rows. When a `_schema_defaults` mapping references a schema name that has no `_schemas/<name>` definition, an `INSERT OR IGNORE` stub `note_schemas` row is auto-created so the FK on `schema_mappings.schema_name` holds. The legacy notes are **left in place** post-v15 — inert (no resolver reads them) and preserved as audit trail; users can delete them at their convenience. Verified safe on byte-identical copies of three production vault DBs: default (0 `_schemas/*`, no `_schema_defaults` — no-op fold, idempotent), techne (same), boulder (same). All three idempotent on second `initSchema` call. Note counts unchanged across the migration in every case.
- **Cache-invalidation hook moved off note writes.** Pre-v15 the `BunSqliteStore` invalidated `_schemaConfig` on every `_schemas/<name>` or `_schema_defaults` note write; post-v15 the same hook fires on `upsertNoteSchema` / `setSchemaMapping` / `deleteNoteSchema` / `deleteSchemaMapping` instead. Vaults that never use schemas pay zero invalidation tax on the note-write path.

### Deferred

- **Renaming a `_schemas/<name>` note no longer carries the schema with it.** The legacy convention had path-rename semantics for free (a Finder-style move of a `_schemas/foo` note to `_schemas/bar` would rename the schema); the new authoring surface has explicit `update-note-schema` + `delete-note-schema`. Acceptable for v15 — the rename use case is rare and surfaces clearly in the new API. If demand emerges, a future `rename-note-schema` MCP/REST verb can land additively.

## [0.3.6-rc.31] — 2026-05-03

Tag identity reshape — Phase 1 per `parachute-patterns/patterns/tag-data-model.md` (#29). The `tags` table goes from a name-only enrolment row to the single source of truth for everything *about* a tag: description, indexed metadata field schema, typed-link declarations (relationships), parent tag(s), and timestamps. The hierarchy resolver swaps from reading `_tags/<name>` notes-as-config to reading `tags.parent_names` directly, retiring the sidecar-note convention without rewriting history (the legacy `_tags/*` notes are left in place as a harmless audit trail). The `tag_schemas` sidecar table is dropped; its rows fold into the `tags` row of the same name. `update-tag` (MCP) and `PUT /api/tags/:name` (REST) now accept the full record shape — partial upsert, undefined preserves, null clears. `list-tags` and `GET /api/tags` return the full record on every entry. `_schemas/*` notes-as-config retirement is explicitly deferred to vault#246; the `_schema_defaults.path_prefix` shape isn't 1:1 with what `tags` carries today, so collapsing it warrants its own design pass.

### Added

- **`tags` table carries the full tag record (schema v14).** Six new columns layered onto the existing `(name)` row: `description TEXT`, `fields TEXT` (JSON array of `{name, type, indexed?, description?}` schema entries — same shape as the old `tag_schemas.fields_json`), `relationships TEXT` (JSON object keyed by relationship name, each value `{target_tag, cardinality, description?}` — Phase 1 informational, no enforcement yet), `parent_names TEXT` (JSON array of parent tag names — the hierarchy declaration), `created_at TEXT`, `updated_at TEXT`. Cardinality vocabulary is a closed set: `"one" | "optional" | "many" | "many-required"` — named, AI-legible, validated at the API boundary. The single-row identity model lets `update-tag` patch any subset of fields without touching the rest; clearing a field is `null`, omitting it preserves the prior value, and an empty `parent_names` array collapses to `null` so hierarchy enforcement stays consistent (no-parents and unset-parents are the same case).
- **`upsertTagRecord(tag, patch)` on `Store` — partial upsert with hierarchy-cache invalidation.** `Store.listTagRecords()`, `Store.getTagRecord(tag)`, and `Store.upsertTagRecord(tag, patch)` are the new tag-record API on the store interface. The upsert handles row creation (auto-creates the tag if absent, mirroring how `note_tags` already auto-creates), partial patching (only the fields named in `patch` are written), and timestamps (`created_at` set on insert, `updated_at` on every write). When `patch.parent_names !== undefined`, the in-memory `_tagHierarchy` cache is invalidated so the next `loadTagHierarchy()` reflects the change — same invalidation hook is wired on `deleteTag`, `renameTag`, and `mergeTags` so any path that mutates parent-bearing rows stays coherent. The schema-only facade (`listTagSchemas`, `getTagSchema`, `upsertTagSchema`, `deleteTagSchema`) routes through the same row — a `deleteTagSchema` clears the schema columns but preserves the row, since tag identity persists independent of whether anyone has declared a schema.
- **`update-tag` MCP + `PUT /vault/<name>/api/tags/:name` accept the full record shape.** Both surfaces gain `relationships?: Record<string, {target_tag, cardinality, description?}>` and `parent_names?: string[] | null` alongside the existing `description?` and `fields?`. Validation is at the boundary: `validateRelationships(raw)` throws a user-readable error on malformed shape (non-object value, missing `target_tag`, unknown cardinality) — MCP returns the standard `isError: true` envelope, REST returns `400 {error, error_type: "invalid_relationships"}` with the same message. `parent_names` is accepted as an array of strings (collapsed to `null` when empty) or explicit `null` to clear. Partial-patch semantics: omitting a field preserves it, `null` clears, an array/object replaces. `delete-tag` (MCP + REST) no longer makes a redundant schema-clear call — dropping the `tags` row is the single operation now.
- **`list-tags` MCP + `GET /vault/<name>/api/tags` return the full record.** Each entry now includes `description`, `fields`, `relationships`, `parent_names`, `created_at`, `updated_at` alongside `name` and `noteCount`. Single-tag fetch (`GET /api/tags/:name`) returns the same shape. The `noteCount` aggregation is unchanged. Tag-scoped tokens still filter the list to the allowlist root + descendants — the swap to `tags.parent_names` for hierarchy resolution preserves the same `expandTagsWithDescendants` behavior on the read path, with a regression test pinning the post-v14 expansion against the v13 expansion result.

### Storage / migration

- **Schema bumped 13 → 14.** Migration is additive `ALTER TABLE tags ADD COLUMN <col> <type>` for each of the six new columns (idempotent via `hasColumn` introspection — re-running the migration on an already-v14 DB is a no-op), followed by a one-shot data fold: `tag_schemas` rows copy their `description` and `fields_json` into the matching `tags` row (creating the row if absent), `_tags/<name>` notes copy `metadata.parents` into `tags.parent_names` (creating the row if absent), `created_at` is backfilled from the legacy sources where available, and finally `DROP TABLE tag_schemas`. The `_tags/*` notes themselves are **left in place** — they are inert after v14 (no resolver reads them) and serve as a historical audit trail; users can delete them at their convenience or wait for vault#246's `_schemas/*` retirement work to sweep both. Verified safe on byte-identical copies of three production vault DBs: default vault (10 schemas → 10 tag rows with description, 4 with fields, hierarchy preserved; 28ms), techne (clean baseline, no v13 sidecars to migrate; 2.7ms), boulder (clean baseline; 16ms). All three idempotent on second `initSchema` call. Tag counts and note counts unchanged across the migration in every case.
- **Hierarchy resolver swap from `_tags/<name>` notes to `tags.parent_names` column.** `loadTagHierarchy` in `core/src/tag-hierarchy.ts` now queries `SELECT name, parent_names FROM tags WHERE parent_names IS NOT NULL` and parses the JSON array into the in-memory `Map<child, parents[]>` — same `TagHierarchy` shape, same `getTagDescendants` public API, same in-memory cache (lazy-built per process, invalidated on writes that touch parents). `TAG_CONFIG_PREFIX = "_tags/"` remains exported as a constant for any historical caller that still references it, but no resolver code reads notes-as-config anymore. The string-form sub-tag fallback for tag-scoped tokens (per tag-scoped-tokens.md §Storage) coexists with `parent_names` as before — schema-driven matches still win first, the string-form fallback only runs when the expanded set misses, so a token allowlisted for `health` continues to see `#health/food` whether or not anyone has declared the hierarchy.

### Deferred

- **`_schemas/*` notes-as-config retirement → vault#246.** The investigation surfaced a counterexample: `_schema_defaults` carries `path_prefix` (a default-tag-by-path-prefix declaration), which has no clean column on the `tags` row — collapsing it would either mean a new generic `defaults` table or a redesign of how default-tagging is declared. Out of scope for this reshape; tracked as vault#246 for a focused design pass.

## [0.3.6-rc.30] — 2026-05-03

Tag-scoped tokens land — Phase 1 per `parachute-patterns/patterns/tag-scoped-tokens.md` (#24, merged 2026-05-02). A `pvt_*` token can now carry an immutable root-tag allowlist; once set, the token only sees and writes notes whose tags (after `_tags/<name>` hierarchy expansion) intersect that allowlist. Mint, REST, and MCP all enforce the allowlist; the admin SPA gains a tag-picker on the mint form. Use case: per-purpose paraclaw bots — a `#health` Claw, a `#work` Claw — slicing one vault rather than spinning up separate vaults per surface.

### Added

- **`tokens.scoped_tags TEXT NULL` on the per-vault tokens DB (schema v13).** Migration is additive; all existing rows pick up `NULL` (= unscoped, current behavior). The column stores a JSON-encoded array of root tag names, validated at the API boundary — no schemaless mush in SQLite. `core/src/store.ts` exposes a new async `expandTagsWithDescendants(tags: string[]): Promise<Set<string>>` that walks the existing `_tags/<name>` hierarchy cache and returns `{root} ∪ descendants(root)` for each input — call-sites just intersect with a note's actual tag set, no per-tag `rootOf` walk needed at the boundary. The token-store layer (`src/token-store.ts`) parses, persists, and surfaces `scoped_tags` on `Token`, `ResolvedToken`, and `AuthResult`; legacy code paths and hub-issued JWTs always carry `scoped_tags: null` (per the pattern doc — tag-scope is a vault-internal concern, not an OAuth claim).
- **REST: tag-scope enforcement on every `/vault/<name>/api/*` read and write.** `src/routing.ts` computes a per-request `TagScopeCtx` from `auth.scoped_tags` (lazy: only built when the token actually carries a scope) and threads it into `handleNotes`, `handleTags`, and `handleFindPath`. Read paths filter results to the allowlist (single-by-id, single-by-path, search, structured query, near-anchor, attachments list, tag list, tag detail). Out-of-scope reads return `404` rather than `403` — same "no existence leak" stance the pattern doc names. Write paths gate at create/update/delete: `POST /api/notes` pre-validates the entire batch atomically (mirrors the `#213` empty-note guard), `PATCH` projects the post-update tag set before allowing the write, `DELETE` rejects out-of-scope ids as 404. Tag operations (`POST /tags/merge`, `POST /tags/:name/rename`, `PUT /tags/:name`, `DELETE /tags/:name`) require every involved tag — sources + target, old + new — to be inside the allowlist.
- **MCP: tool-execute wrappers in `src/mcp-tools.ts` (`applyTagScopeWrappers`).** The 10 vault tools see the same allowlist semantics as REST. Read tools — `query-notes`, `list-tags`, `find-path`, `synthesize-notes` — wrap their `execute()` to filter results (single-note returns, list returns, neighbor lists, path hops). Write tools — `create-note` (single + batch), `update-note`, `delete-note`, `update-tag`, `delete-tag` — wrap to gate on the prospective tag set; tag operations gate on the tag name itself. Wrappers are no-ops when `auth.scoped_tags === null`, preserving identical pre-tag-scope behavior for unscoped sessions. Out-of-scope reads return the standard `{error: "Note not found", id}` shape; write rejections return `{error: "Forbidden", error_type: "tag_scope_violation", message, scoped_tags}` — same envelope as the REST 403.
- **Mint endpoint accepts `tags?: string[]` with subset validation (`POST /vault/<name>/tokens`).** When present, every entry must be a non-empty string with no `/` (root tags only — sub-tags reach via `_tags/<name>` at enforcement time) and exist in the vault's tag list. The minted allowlist must be a subset of the caller's: a tag-scoped admin minting outside their allowlist returns `403 tag_scope_violation`, and a tag-scoped admin omitting `tags` entirely returns `403` (cannot widen to unscoped — explicit > implicit at a security boundary). Unscoped admins retain back-compat: omitting `tags` mints an unscoped token. The list endpoint (`GET /vault/<name>/tokens`) surfaces `scoped_tags` on each entry.
- **SPA tag-picker on the mint form (`web/ui/src/routes/VaultTokens.tsx`).** The mint form fetches root tags from `/vault/<name>/api/tags` (filtered to entries without `/`), renders a checkbox list, and posts the selection as `tags`. When nothing is selected the field is omitted (= unscoped, server back-compat). When the vault has no root tags yet, the picker shows "No root tags in this vault yet — token will see the full vault." Each token row in the list now displays `scoped_tags` as `#tag` pills next to the scope set.

### Storage / migration

- **Schema bumped 12 → 13.** Migration is `ALTER TABLE tokens ADD COLUMN scoped_tags TEXT` on every per-vault DB. Existing rows are untouched (= unscoped). Verified safe on byte-identical copies of three production vault DBs — idempotent, all existing tokens migrated cleanly with `NULL scoped_tags`.

### Fixed (post-PR fold)

- **Orphan sub-tag fail-open: a token allowlisted for `health` now sees `#health/food` even when no `_tags/health/food` schema declares the hierarchy.** The Phase 1 enforcement only matched via the schema-driven `expandTagsWithDescendants` set, which fails closed for the common case where a sub-tag exists in the wild without an explicit `_tags/<sub>` config note. `noteWithinTagScope` and `tagsWithinScope` now take a third parameter, the raw root allowlist, and check `tagOnNote.split("/")[0] ∈ rawRoots` as a fallback. Schema-driven matches still win first (cheap `Set.has`); the string-form fallback only runs when the expanded set misses. Mirrors patterns#26's §Storage canonical contract.
- **Tag-delete, tag-merge, and tag-rename now fail closed (409) when a tag-scoped token references the doomed tag.** Previously a successful `DELETE /vault/<name>/api/tags/:name` (or a `POST /api/tags/merge` consuming the source, or a `POST /api/tags/:name/rename` away from the referenced name) would silently orphan the token's allowlist — the row would still match the tag string but no notes would carry it. New `findTokensReferencingTag(db, tag)` helper walks the tokens table; the REST DELETE handler, the `/tags/merge` handler (per source), the REST `/tags/:name/rename` handler, and the MCP `delete-tag` wrapper return `{error: "TagInUseByTokens", error_type: "tag_in_use_by_tokens", tag, referenced_by: [{id, label}, ...]}` with a `409`. The MCP wrapper runs unconditionally (not gated on the deleter being scoped) — any token deleting a referenced tag is the orphan case. Operator must revoke or re-mint the offending tokens before retrying. The rename guard is a Phase-1 interim — vault#240 will replace it with an automatic cascade per patterns#26 §Lifecycle.

## [0.3.6-rc.1] — 2026-04-26

Vault becomes a pure OAuth resource server: hub-issued JWTs are now accepted alongside legacy `pvt_*` opaque tokens. RC track — promotion to `@latest` follows validation against a real hub.

### Added

- **Hub-issued JWT validation alongside `pvt_*` tokens.** Vault now dual-validates bearer tokens. Tokens whose first three characters are `eyJ` (the base64url encoding of a JWT header's `{"`) route through the new `src/hub-jwt.ts` validator: `jose.createRemoteJWKSet` fetches the hub's `/.well-known/jwks.json` (cached 5min, with a 30s cooldown between failed fetches), `jwtVerify` checks the RS256 signature and claims, and the `iss` claim MUST equal the configured hub origin — the load-bearing trust check that prevents anyone from minting a token against any RSA key. The hub origin comes from `PARACHUTE_HUB_ORIGIN` (set by the hub's `expose` / `start` flow when vault runs behind it) with a `http://127.0.0.1:1939` loopback fallback for dev. The JWT's `scope` claim becomes the granted scopes; `permission` is derived for back-compat with code paths that still branch on `permission` (MCP tool gating, view auth). Audience is parsed but accepted broadly today — the hub issues `aud="operator"` for operator tokens and `aud=<client_id>` for user OAuth tokens, both legitimate vault callers; tightening to a strict allow-list is reserved for the post-cli#59 scope-guard work. Existing `pvt_*` callers (CLI-created tokens, OAuth-minted access tokens, legacy YAML keys) continue to work unchanged — JWT-shaped tokens commit to JWT validation (no fallthrough to `pvt_*` lookup on failure, since a malformed JWT was never going to be a valid local token), and non-JWT tokens follow the existing per-vault DB → vault.yaml → config.yaml resolution chain. `legacyDerived` is `false` for JWT-issued scopes — they're explicit, never inferred. Companion to the hub's Phase B JWKS plumbing; together they make hub-as-issuer Phase B2 functional end-to-end.



The rename-aware release. The upstream hub repo was renamed `parachute-cli` → `parachute-hub` and its npm package `@openparachute/cli` → `@openparachute/hub` on 2026-04-26; this release refreshes vault's docs and inline comments to match. No functional changes — `parachute-vault` binary, schemas, source code, and on-disk layout are unchanged. Promoted directly to `@latest` so new installs land on docs that match the current ecosystem naming.

### Changed

- **Stale `@openparachute/cli` / `parachute-cli` references updated to `@openparachute/hub` / `parachute-hub`** in `src/cli.ts` (one source comment, two usage-help blocks) and the `[Unreleased]` CHANGELOG entries that named the forthcoming dispatcher by its old name. Bin name (`parachute-vault`), the `parachute vault <cmd>` alias, and every code path are unchanged.

### Added

- **Vault is now the scribe context provider: triggers + worker can enrich transcription POSTs with vault notes.** Two surfaces, one shape. (1) Every trigger's `action` gains an `include_context` list — `[{tag, exclude_tag?, include_metadata?}]` — whose predicates pre-fetch matching notes at fire time. `send: "attachment"` attaches them as a multipart `context` JSON part (`{entries: [{name, ...metadata}]}`); `send: "json"` inlines the same payload under a top-level `context` field. `send: "content"` (TTS-out) ignores context. (2) The dedicated transcription worker gains the same surface via a per-vault `transcription.context` section in `vault.yaml`; the worker attaches the resulting `context` multipart part to each scribe POST. In both paths the `name` is the note path's basename (stem) and only whitelisted `include_metadata` keys are surfaced — unrelated metadata (including secrets a vault might carry) never leaks. Fetch failures are isolated per-predicate and logged, so a single bad tag can't block a whole fire or tick. Existing configs without `include_context` / `transcription.context` see no behavior change. (Scribe will drop its own vault client in a follow-up — vault is now the single reader.)
- **`SCRIBE_AUTH_TOKEN` env var — canonical name for the scribe bearer token.** Matches the CLI's install-time auto-wire. `SCRIBE_TOKEN` is retained as a deprecated alias for one release: when only the legacy name is set, the worker reads it and logs a one-time boot warning. Both unset means no `Authorization` header is sent (back-compat with loopback-trust deployments). When a webhook trigger points at the same host as `SCRIBE_URL` while the dedicated worker is enabled, vault now logs a soft-deprecation warning at boot — the trigger's `missing_metadata` guard keeps it idempotent, but running both against the same scribe endpoint is noise and the worker is the preferred path.
- **`PARACHUTE_HUB_ORIGIN` env var — vault can advertise a hub as the OAuth issuer.** When set (e.g. `https://hub.example`) *and* the incoming request arrives via the hub origin (matched against `X-Forwarded-Host` / request `Host`), vault's authorization-server metadata publishes `issuer = $HUB` and rewrites the `authorization_endpoint`, `token_endpoint`, and `registration_endpoint` to `${HUB}/oauth/{authorize,token,register}`; protected-resource metadata lists the hub as the authorization server; and the token response includes `iss = $HUB`. When the same vault is reached via a non-matching origin (typically direct loopback, `http://127.0.0.1:<port>/...`), the discovery document describes *that* origin instead — `issuer = <origin>/vault/<name>` and vault-rooted endpoints — so RFC 8414 §2 issuer/origin consistency holds on both views concurrently. The CLI is responsible for routing `${HUB}/oauth/*` to the vault's internal `/vault/<name>/oauth/*` endpoints at the reverse-proxy layer. Phase 0 of the hub-as-OAuth-issuer design; future phases will introduce per-service scope enforcement. When the env is unset, behavior is unchanged — vault advertises itself as the issuer for every request.
- **Token response includes a `services` catalog.** `POST /vault/<name>/oauth/token` now includes a `services` object alongside `access_token`, sourced from `~/.parachute/services.json` (the CLI-owned manifest). Each entry's `paths[0]` is rewritten into an absolute URL rooted at the origin the client used to reach vault — hub origin for tokens minted via the hub reverse proxy, vault request origin otherwise — so clients get externally-reachable URLs for the same origin they're already talking to, not internal paths or a mismatched host. Shape: `{vault: {url: "...", version: "0.3.0"}, notes: {url: "...", version: "0.1.0"}}`. Additive field — older clients that don't expect it ignore the key. Unreadable manifest logs a warning and returns an empty catalog rather than failing the token exchange.
- **`parachute-vault mcp-install` picks the URL matching vault's advertised issuer.** The URL written into `~/.claude.json` previously always pointed at loopback (`http://127.0.0.1:<port>/vault/<name>/mcp`). Now it prefers, in order: `PARACHUTE_HUB_ORIGIN` env (hub-rooted URL), then `~/.parachute/expose-state.json`'s `canonicalFqdn` when an active tailnet/public exposure is configured (`https://<fqdn>/vault/<name>/mcp`), then the loopback fallback. This is the visible behavior Aaron hit: with a hub exposure live, strict MCP clients (Claude Code) were hitting a loopback URL whose discovery issuer pointed at the hub — the command now writes a URL that matches the discovery issuer for that origin. Logs which URL was chosen and why.
- **`scopes_supported` publishes the final vault-scoped shape.** Discovery metadata now advertises `["vault:read", "vault:write", "full", "read"]` — the new names alongside the legacy ones for back-compat with 0.2.x clients. Vault does not yet *enforce* per-scope distinctions (all tokens continue to grant full-or-read access); this just publishes the shape so hub/CLI tooling can plan for the Phase 2 enforcement cutover.
- **Scope enforcement at the HTTP and MCP boundary (`vault:read`, `vault:write`, `vault:admin`).** Tokens now carry an OAuth-standard whitespace-separated `scopes` string on the row (schema v12), and every request is gated by the scope required for its target. HTTP: `GET/HEAD/OPTIONS /vault/<name>/api/*` requires `vault:read`; `POST/PATCH/PUT/DELETE` requires `vault:write`; `GET /vault/<name>/.parachute/config` requires `vault:admin` (flipping from public — hub keeps working loopback via the admin-scoped token minted at setup). Inheritance is `admin ⊇ write ⊇ read`, so a single higher-scoped token still works everywhere below it. MCP: tools are partitioned (`query-notes`, `list-tags`, `find-path`, `vault-info` → `vault:read`; `create-note`, `update-note`, `delete-note`, `update-tag`, `delete-tag` → `vault:write`) — read-only tokens only see the read tools in `tools/list`, and a direct `tools/call` of a mutation tool returns an error naming the missing scope rather than silently succeeding. Forbidden responses carry `{error_type: "insufficient_scope", required_scope, granted_scopes}` so agents can diagnose without tracing. OAuth token responses now emit the OAuth-standard `scope` string (`"vault:read vault:write vault:admin"` for full-access consent) instead of the legacy `"full"`/`"read"` shorthand; the consent page radio buttons are unchanged. `parachute-vault tokens create --read` is now enforcement-real: the token it mints is rejected on writes with 403. Back-compat: pre-v12 rows (NULL `scopes` column) continue to work for one release by falling back to `legacyPermissionToScopes(permission)`; on first use they log a one-time deprecation warning, and the shim will be removed after the next release. `vault:<name>:<verb>` is accepted as a synonym for `vault:<verb>` today (Phase 2+ per-vault narrowing is reserved but not yet enforced). Additive migration — no data rewrite, no client churn on the hot path.
- **`kind: "api"` on `/vault/<name>/.parachute/info`.** The service-info card now includes a `kind` field so the hub can render API services (no browser UI, JSON at root) differently from frontend services (launch-in-tab). Additive to the locked card shape; versioned hub renderers that don't know about `kind` will keep treating the card as a default tile.
- **`GET /vault/<name>/.parachute/config/schema` + `/.parachute/config` — module configuration endpoints.** Phase 2 of the module architecture: every module exposes a JSON Schema (draft-07) describing its configurable settings, and a paired endpoint returning the current effective values. Hub reads both and renders a configuration form without any hub-side knowledge of vault's settings. The schema describes `audio_retention` (enum, per-vault), `scribe_url` (uri, env-backed until Phase 3), `scribe_token` (`writeOnly` — never returned by GET), and `port` (read-only informational, from global config). The config endpoint returns effective values with `writeOnly` fields stripped; the token never appears in any response. Both endpoints are public during Phase 0–2 while the hub is loopback-only; the `vault:admin` scope will gate `/config` once scope enforcement lands in Phase 3. `PUT /.parachute/config` is explicitly Phase 3 — non-GET methods return 405 so clients that already speak the full contract discover the gap.

### Fixed

- **OAuth discovery issuer is now origin-aware, not globally hub-rooted (RFC 8414 §2).** The Phase 0 seam previously published `issuer = $PARACHUTE_HUB_ORIGIN` for every discovery request — so a client fetching `/.well-known/oauth-authorization-server` via `http://127.0.0.1:<port>/...` would get back `issuer: https://hub.example`, an origin mismatch that strict RFC 8414 clients (including Claude Code's MCP OAuth SDK) reject. The same vault now concurrently exposes two self-consistent issuer views: tokens minted and discovery served over the hub reverse-proxy origin return `issuer = $HUB`; requests that arrive directly on any other origin (loopback in practice) return `issuer = <origin>/vault/<name>` with vault-rooted endpoints. Match is against the incoming request's base URL (honoring `X-Forwarded-Host` / `X-Forwarded-Proto`). The token response's `iss` claim follows the same resolution, so tokens minted on one origin validate against that origin's discovery doc. Companion to the `mcp-install` URL picker above — together they close the RFC 8414 violation without per-origin configuration.
- **Optimistic concurrency made safe-by-default and legible end-to-end.** Four bundled fixes so an agent client can never accidentally clobber a concurrent write and always has the token + structured error needed to recover. (1) `update-note` now **requires** `if_updated_at` (or an explicit `force: true` override) — previous behavior allowed unconditional writes when the field was omitted, which is exactly the footgun the field exists to prevent. MCP returns a JSON-RPC `InvalidParams` error with `data: {error_type: "precondition_required", note_id, path}`; REST returns 428 Precondition Required with the same body shape. `force: true` is the documented escape hatch for bulk migrations and scripted writes where concurrency is known-safe. (2) Conflict errors now carry a structured shape — `{error_type: "conflict", current_updated_at, your_updated_at, path, note_id}` — surfaced in the MCP error `data` field and the REST 409 body. Clients can branch on `error_type` and immediately re-arm a retry with `current_updated_at` rather than parsing the human-readable message. REST 409 is additive: new fields sit alongside the previous `{error: "conflict", expected_updated_at}` shape so existing lens clients keep working. (3) `query-notes` single-note fetches (by `id` or `path`) now return `updatedAt` — previously only `createdAt` came back, which left the caller with no concurrency token to arm a subsequent `update-note`. (4) `create-note` returns `updatedAt` on fresh notes (same value as `createdAt`, matching the insert-time invariant from PR #70), so a client that creates and immediately updates can thread the token through without a second fetch. Existing in-band `isError: true` tool results remain the fallback for unstructured errors.
- **OAuth discovery served at RFC 8414 §3.1 / RFC 9728 §3 path-insertion URLs for the `/vault/<name>/` URL shape.** For a resource at `/vault/<name>/mcp`, the spec-mandated metadata URLs are `/.well-known/oauth-authorization-server/vault/<name>[/mcp]` and `/.well-known/oauth-protected-resource/vault/<name>[/mcp]` — path-insertion, with `.well-known` above the issuer path — not the path-append `/vault/<name>/.well-known/<type>` shape that the 0.3 URL migration shipped alone. Strict clients including Claude Code's MCP OAuth SDK probe only the insertion form; without these routes they 404 on discovery and can't complete the authorization handshake. PR #124 originally implemented this for the pre-migration `/vaults/<name>/` URL shape; the `/vaults/` → `/vault/` rename in the breaking URL migration dropped the insertion routes and this restores them. Both URL shapes now return deep-equal JSON via the shared handlers, so mixed-toolchain clients can't observe drift. Unknown-vault requests on the insertion form return 404 rather than phantom metadata.

### Changed

- **Filesystem hygiene inside `~/.parachute/vault/`: `vaults/` → `data/`, and logs moved into `logs/`.** Two internal moves with the same target-wins, idempotent, auto-migrating shape as the 0.3 ecosystem-root move. Per-vault SQLite state now lives at `~/.parachute/vault/data/<name>/` (was `vaults/<name>/`) — matches the Postgres/Redis convention and avoids the doubled "vault/vaults" path. Daemon logs now live at `~/.parachute/vault/logs/vault.log` and `~/.parachute/vault/logs/vault.err` (were flat in `~/.parachute/vault/`) — matches the `~/.parachute/<svc>/logs/<svc>.log` convention the CLI uses for every sibling service. On first post-upgrade run the vault auto-migrates `vault/vaults/` → `vault/data/` and `vault/vault.log`/`vault.err` → `vault/logs/`, logging each move to stderr. Target-wins on conflict: if both `vault/data/` and `vault/vaults/` exist (or both log locations), the new one is kept and the legacy copy is left in place with a warning. No user action required — any `parachute-vault` invocation triggers the migration. Note: vault does not use `~/.parachute/tokens.db` (no code references it), so it is not part of this move; the CLI will archive that file separately.

### Added

- **`GET /vault/<name>/.parachute/info` + `/.parachute/icon.svg` for the CLI hub page.** Two public (no auth), CORS-`*` endpoints so the ecosystem-root hub rendered by the CLI can aggregate service cards. `info` returns a locked card shape — `name`, `displayName`, `tagline`, `version` (from `package.json`), `iconUrl` — and `icon.svg` returns a small placeholder monogram inline. Zero PII, read-only. Non-GET methods return 405.

### Changed

- **Vault state moved from `~/.parachute/` into `~/.parachute/vault/`.** The ecosystem root (`~/.parachute/`) now hosts multiple sibling services — `services.json` and `well-known/` stay at the root (CLI-owned), and everything vault owns (`.env`, `config.yaml`, `vault.log`, `vault.err`, `start.sh`, `server-path`, `vaults/`, `assets/`, `backup-last.json`, top-level `*.db` snapshots) has moved under `~/.parachute/vault/`. `PARACHUTE_HOME` still points at the ecosystem root; the vault subdir is derived as `${PARACHUTE_HOME}/vault`. On first post-upgrade run, any legacy paths still at the root are auto-migrated into `vault/` — the CLI logs each moved path to stderr and the migration is idempotent (double-runs are a no-op). If a legacy path and its new counterpart both exist, the new one wins and the legacy copy is left in place with a warning so users can inspect before removing. The launchd plist + systemd unit both point `WorkingDirectory` at the new `vault/` subdir, and the generated `start.sh` wrapper now sources `~/.parachute/vault/.env`. No user action is required — running any `parachute-vault` command (including `doctor` and `url`) triggers the migration.

### Added

- **`query-notes` gains operator objects on `metadata` fields and top-level `order_by`.** Metadata values can now be operator objects — `{metadata: {priority: {gte: 3, lt: 10}, status: {in: ["open", "in_progress"]}}}` — instead of only exact-match scalars. Supported operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `exists` (boolean). Multiple ops on one field compose as AND. `order_by: "<field>"` sorts results by a metadata field, using the existing `sort` param (`asc` / `desc`) for direction and appending `created_at` as a stable tiebreaker. Both paths require the field to be declared `indexed: true` in some tag schema (via `update-tag`) — operator queries and `order_by` route through the `meta_<field>` generated column + B-tree index shipped in the previous release, so they stay O(log n) instead of O(notes). Errors are loud: unknown operator → `UNKNOWN_OPERATOR`; non-indexed field → `FIELD_NOT_INDEXED`; type-mismatched operator value (`in` expecting array, `exists` expecting boolean) → `INVALID_OPERATOR_VALUE`; REST returns 400 with `{error, code}`. `ne` preserves "unset AND differs" semantics via `(col IS NULL OR col <> ?)` so rows missing the field aren't silently excluded. Empty `in: []` contradicts; empty `not_in: []` is a no-op — both avoid SQLite's `IN ()` syntax error. Existing primitive-value metadata filters (`{metadata: {status: "open"}}`) still JSON-exact-match and work on un-indexed fields; the shape of the value — scalar vs. object — picks the path. REST exposes `order_by` via the `order_by` query param on `GET /vault/<name>/api/notes`.
- **`query-notes` gains `has_tags` and `has_links` presence filters.** Two new booleans on the `query-notes` MCP tool and the `GET /vault/<name>/api/notes` REST endpoint: `has_tags` (true = tagged-only, false = untagged-only) and `has_links` (true = notes with any inbound or outbound link, false = orphans in either direction). Composable with each other and with existing filters; `has_tags: false, has_links: false` returns the true loners. When `tag` is already set, `has_tags` is ignored — the tag filter is strictly narrower and wins. Implemented as correlated `EXISTS` / `NOT EXISTS` subqueries against `note_tags` and `links`, which lets SQLite use the existing indexes and stay O(rows) rather than O(rows × tags).

### Changed

- **Breaking: every vault-touching route moved to `/vault/<name>/...`; unscoped routes removed.** There is one URL shape for every client, same layout whether you have one vault or ten. The API lives at `/vault/<name>/api/...`, MCP at `/vault/<name>/mcp`, OAuth at `/vault/<name>/oauth/{register,authorize,token}`, discovery at `/vault/<name>/.well-known/oauth-*`, published notes at `/vault/<name>/view/:id`. The old unscoped `/api`, `/mcp`, `/oauth/*`, `/view/*` paths — and the previous `/vaults/<name>/...` prefix — are gone; requests to them return 404. Cross-vault endpoints (`GET /vaults`, `GET /vaults/list`, `GET /health`) are unchanged. The unified MCP endpoint that fanned tool calls across vaults via a `vault` param has been dropped — each MCP session now pins to one vault by the URL and the `list-vaults` tool is no longer exposed. A new `WWW-Authenticate: Bearer resource_metadata="..."` header decorates every MCP 401 so OAuth-capable clients can discover the right authorization server directly from the challenge (RFC 9728).

#### Upgrading from 0.2.x

- **Claude Code**: run `parachute-vault mcp-install` (or re-run `parachute-vault init`) to rewrite `~/.claude.json` with the new `/vault/<name>/mcp` URL. Existing `pvt_` tokens are kept; no re-auth needed.
- **Claude Desktop / Parachute Daily / any OAuth client**: remove the integration and add it back pointing at `https://<your-host>/vault/<name>/mcp`. The OAuth handshake will re-run and mint a fresh per-vault token. Pasted bearer-token integrations need only the URL updated.
- **curl / scripts**: rewrite hardcoded URLs. Old `/api/notes` → `/vault/default/api/notes`; old `/vaults/work/api/...` → `/vault/work/api/...`; old unscoped `/mcp` → `/vault/default/mcp`. Tokens keep working.
- **Published-note permalinks**: `/view/<id>` and `/vaults/<name>/view/<id>` now 404. Update to `/vault/<name>/view/<id>`.

### Fixed

- **Fresh notes now have `updated_at = created_at` instead of `NULL`.** Clients that fall back to `createdAt` when computing an optimistic-concurrency token (the common `updatedAt ?? createdAt` pattern, used by the Lens editor) were being rejected with a `409 CONFLICT` on the very first edit of a just-created note, because the stored `updated_at IS NULL` never matched the sent timestamp. The insert path now writes both columns at once; a one-time idempotent migration backfills `updated_at = created_at` for any existing rows with `NULL`. Rows that already had a real `updated_at` are untouched. Hook-style writes with `skipUpdatedAt` continue to preserve the column, so `updated_at > created_at` still means "user-touched since creation."

### Changed

- **CLI renamed: `parachute` → `parachute-vault`.** The published `@openparachute/vault` package now exposes its binary as `parachute-vault`, freeing the `parachute` name for the forthcoming `@openparachute/hub` dispatcher that will front this service alongside sibling Parachute Computer services. Direct invocations become `parachute-vault init`, `parachute-vault status`, etc. Users installing the upcoming dispatcher can keep typing `parachute vault <cmd>` — the dispatcher forwards to `parachute-vault <cmd>` transparently. The CLI's own arg-parser still accepts a leading `vault` prefix (`parachute-vault vault init` works), so existing launchd / systemd wrappers that hardcode the full form continue to work across the upgrade.

### Added

- **`update-tag` field specs gain `indexed: boolean`; declared-indexed fields get a generated column + B-tree index on `notes`.** When any tag schema declares a field with `indexed: true`, vault adds a VIRTUAL generated column `meta_<field>` computed from `json_extract(notes.metadata, '$."<field>"')` and indexes it. The tag authorizes the index; the index is universal across all notes, not partitioned by tag — so once `#project` declares `status: indexed`, any note with `status` in its metadata is indexed regardless of tags. `type` and `indexed` are global — all declarers must agree; mismatches at `update-tag` throw a loud error naming the conflicting tag. `description` and `enum` remain per-tag. A new `indexed_fields` table (`field`, `sqlite_type`, `declarer_tags` JSON) is the single source of truth; the column + index drop when the last declarer releases the flag or is removed via `delete-tag`. Type map: `string`→TEXT, `integer`/`boolean`→INTEGER. Field names are restricted to `[A-Za-z_][A-Za-z0-9_]{0,62}` for SQL-identifier safety. Indexes are rebuilt idempotently from `indexed_fields` on every vault init. The query surface — operator objects on `metadata` and `order_by` — lands separately; this release just puts the indexes in place.
- **`parachute-vault init` registers the service in `~/.parachute/services.json`.** An `upsertService` call writes `{name: "parachute-vault", port, paths: ["/vault/<default_vault>"], health: "/health", version}` into the shared manifest that the `@openparachute/hub` dispatcher consumes for discovery, health probes, and routing. `paths[0]` is the canonical mount point — the hub uses it to build the `.well-known/parachute.json` URL and for `parachute expose`. When no default vault is set (multi-vault, no fallback), `paths` falls back to `["/"]` and the operator is expected to fix the config. The write is upsert-by-name and preserves entries from other services (notes, scribe, channel) that share the file. Malformed-manifest errors are logged and init proceeds — the manifest is advisory, not a blocker.
- **Atomic tag rename + merge endpoints.** `POST /api/tags/{name}/rename` with `{new_name}` rewrites the tag across `tags`, `note_tags`, and the schema row in a single transaction; `POST /api/tags/merge` with `{sources, target}` retags every note carrying any source tag onto the target (creating it if missing), preserves the target's schema, and drops the sources. Rename returns `409 {error: "target_exists"}` when `new_name` is already a tag, pointing clients at the merge endpoint instead of the previous N+1 client-side PATCH stopgap.
- **Server-side transcription on attachment upload.** `POST /api/notes/{id}/attachments` now accepts `{transcribe: true}`. The attachment is stamped with `transcribe_status: "pending"` and the note with `transcribe_stub: true`. A background worker (enabled by setting `SCRIBE_URL` / optional `SCRIBE_TOKEN` in the server environment) drains the queue FIFO, POSTs the audio to `${SCRIBE_URL}/v1/audio/transcriptions`, and on success replaces the `_Transcript pending._` placeholder (or the whole body, if absent) with the transcript. If the user cleared the stub marker before the transcript arrived, the note is left alone — but the transcript is still recorded on the attachment. Retries use exponential backoff up to three attempts before flipping to `transcribe_status: "failed"`. The queue is the `attachments` table, so a restart resumes pending work. Per-vault `audio_retention: "until_transcribed"` (in `vault.yaml`) unlinks the audio file after success while keeping the attachment row (and transcript) addressable; `"keep"` (default) preserves the file.
- **Audio retention API: `GET` + `PATCH /api/vault` expose `config.audio_retention`.** The previously file-only setting is now mutable at runtime without hand-editing `vault.yaml`. `GET` reports the active mode (defaulting to `"keep"` for vaults created before the setting existed); `PATCH {config: {audio_retention: ...}}` sets it and validates against the allowed set `"keep"` / `"until_transcribed"` / `"never"`. The new `"never"` mode unlinks audio on *any* terminal state — including failure — for users who want to guarantee no audio persists after processing, trading off the ability to retry a failed transcription. The file is still kept during mid-queue retries so in-flight attempts have something to send. Invalid modes return `400 {error: "invalid_audio_retention"}`.

## [0.2.4] — 2026-04-18

### Added

- `link_count` surfaced in the vault stats response (REST + MCP `vault-info`), matching the existing note and tag counts.

## [0.2.3] — 2026-04-17

### Fixed

- **OAuth discovery endpoints now served at RFC-compliant path-insertion URLs (`/.well-known/oauth-authorization-server/{path}`) in addition to the existing path-append form.** Restores Claude Code's MCP OAuth SDK compatibility, which follows RFC 8414 §3.1 and RFC 9728 §3 strictly and probes only the path-insertion shape. Before 0.2.3, the SDK's AS-metadata fetch 404'd, leaving it without a `registration_endpoint` and cascading into a 404 on the `/register` fallback. Both scoped forms now work: `/.well-known/oauth-authorization-server/vaults/<name>` and the longer `/.well-known/oauth-authorization-server/vaults/<name>/mcp`; same shapes on `/.well-known/oauth-protected-resource/...`. Path-append routes (`/vaults/<name>/.well-known/<type>`) are unchanged so lax clients keep working.

## [0.2.2] — 2026-04-17

### Fixed

- **`start.sh` daemon wrapper no longer crashes on user shell profiles that reference unbound variables.** The generated wrapper ran `source ~/.zprofile` and `source ~/.zshrc` under `set -u`, so a zsh plugin framework or any conditional profile setup that touched an unset variable would abort the wrapper with exit 1. The `2>/dev/null` redirect swallowed the error, launchd saw repeated exit 1s, and the daemon silently refused to start with an empty `vault.err`. The wrapper now brackets the profile-source lines with `set +u` / `set -u` so -u is only active for code the wrapper owns. Run `parachute vault init` once on 0.2.2 to rewrite `~/.parachute/start.sh` — the rewrite is idempotent.

### Added

- **`parachute --version` / `parachute -v` / `parachute version`** print the installed package version to stdout. Works at the root and with the `vault` prefix (`parachute vault --version`, etc.). Reads from the installed `package.json` at module load, not a hardcoded string.

## [0.2.1] — 2026-04-17

### Fixed

- OAuth discovery now works against Claude Code's MCP SDK (and any other strict RFC 9728 client): 401 responses from the MCP endpoint carry a `WWW-Authenticate: Bearer resource_metadata="…"` header pointing at the scoped or unscoped protected-resource metadata document, matching the URL the client actually hit. Previously, clients with no pointer fell back to probing the root `/.well-known/oauth-protected-resource`, got `resource: <base>/mcp`, and rejected any connection to `/vaults/<name>/mcp` as a resource mismatch.

## [0.2.0] — 2026-04-17

First tagged public release. Ships the auth, backup, and onboarding surface the project needs for first-wave users.

### Authentication

- **OAuth 2.1 + PKCE** with Dynamic Client Registration (RFC 7591). Claude Desktop, Parachute Daily, and any OAuth-capable MCP client can connect with no manual token paste — user clicks "Add integration", browser opens to the vault's consent page, done.
- **Owner password** (bcrypt-hashed, min 12 characters) for the OAuth consent page. Prompt fires at `vault init`; manage later with `parachute vault set-password` / `--clear`.
- **TOTP 2FA with single-use backup codes**. `parachute vault 2fa enroll` prints a QR and one-time backup codes; `status` / `disable` / `backup-codes` subcommands for lifecycle.
- **Per-vault OAuth scope** — discovery at `/vaults/{name}/.well-known/oauth-authorization-server` returns vault-scoped endpoints. Tokens minted there authenticate only against that vault.
- **Cross-vault substitution blocked**: an OAuth code issued for one vault cannot be redeemed at another vault's token endpoint (schema-enforced via a `vault_name` column on `oauth_codes`).
- **Honest token response**: `/oauth/token` returns `{ access_token, token_type, scope, vault }` so the client knows which vault it just connected to.
- **Two permission tiers**: `full` (CRUD + delete + token management) and `read` (query / list / find-path / vault-info). Tokens default to `full`; pass `--read` to `tokens create` for read-only.
- **Token CLI**: `parachute vault tokens` (list), `tokens create [--vault] [--read] [--expires <N{h|d|w|m|y}>] [--label]`, `tokens revoke <id> [--vault]`. Tokens are SHA-256 hashed at rest.
- **Query-param auth for `/view`**: `?key=pvt_...` works alongside `Authorization: Bearer` and `X-API-Key` headers, convenient for browsers.

### Backup

- **`parachute vault backup`** — one-shot snapshot: atomic `VACUUM INTO` of every vault's `vault.db`, plus `config.yaml` and each vault's `vault.yaml`, bundled as a timestamped `.tar.gz`. Safe under concurrent reads/writes.
- **Scheduled runs** via `parachute vault backup --schedule hourly|daily|weekly|manual` (macOS launchd). Linux systemd-timer support is a follow-up; wire cron yourself for now.
- **`backup status`** shows schedule, last run, destinations, next run, and per-destination tier breakdown.
- **Tiered (grandfather-father-son) retention**. Default: `daily: 7 / weekly: 4 / monthly: 12 / yearly: null` (unbounded). Set any tier to `0` to disable. Local-timezone bucketing.
- **Pluggable destinations**. `local` (any filesystem path — iCloud Drive, external disk, rsync/Syncthing folder) ships in 0.2.0. `s3`, `rsync`, and `cloud` destinations designed but not yet implemented.
- **`vault uninstall` tears down the backup agent too** on macOS, so scheduled backups don't keep firing on a removed install.

### Reliability

- **`parachute vault doctor`** — diagnostic suite covering server-path pointer, wrapper script, launchd agent (macOS) / systemd service (Linux), bun-on-PATH, MCP entry in `~/.claude.json` (presence + URL port match + reachability), port-collision (free / ours / foreign via `lsof` or `ss`), and — when scheduled backups are configured — backup agent + per-destination writability. Exits 1 on any `fail`.
- **`vault status`** is healthcheck-aware and reports live daemon state, not just service registration.
- **`vault restart`** blocks until `/health` returns 200, with a sensible budget and progress indicator.
- **Path-resilient `start.sh`** — the wrapper launchd/systemd executes embeds an absolute `bun` path + points at `~/.parachute/server-path`, which resolves to the current repo location. Move the repo, re-run `vault init`, and the daemon follows you.
- **Idempotent `vault init`** — safe to re-run after a folder move or config edit; refreshes the pointer, wrapper, and service registration without touching user data.
- **Graceful shutdown**: in-flight webhook triggers get a 5 s drain window before the daemon exits on SIGTERM/SIGINT.

### Multi-vault

- **Public `GET /vaults/list`** — unauthenticated discovery endpoint returning only vault names (no descriptions, timestamps, counts, or keys). Lets a client populate a vault picker before OAuth. Operators who want to hide vault existence can set `discovery: disabled` in `~/.parachute/config.yaml` to make the endpoint return 404.
- **Single-vault auto-default** — when the server has exactly one vault, the unscoped `/mcp`, `/api/*`, and `/oauth/*` paths transparently resolve to it regardless of its name. A lone vault named `journal` works at `/mcp` with no vault-in-URL needed.
- **Vault-management CLI**: `parachute vault create <name>`, `list` (alias `ls`), `remove <name> --yes` (alias `rm`).
- **Automatic `default_vault` management** — `vault create` promotes a new vault to default when none is set or the configured default points at a missing vault. `vault remove` promotes the sole survivor when you delete the default and one vault remains.

### Install / uninstall

- **`vault uninstall`** — removes the daemon registration, the `start.sh` wrapper, the `~/.parachute/server-path` pointer, and the `parachute-vault` entry in `~/.claude.json`. On macOS, tears down both the main vault agent and the backup agent. Preserves all user data.
- **`vault uninstall --wipe`** — additionally removes `vaults/`, `.env`, `config.yaml`, `vault.log`, and `vault.err` after a second interactive confirm (default NO).
- **`vault uninstall --yes --wipe`** — scripted destructive path. Skips both confirms and prints an ISO-timestamped audit line to stdout naming the target paths.
- **`vault url`** prints the local server URL in a script-friendly form.

### API / primitives

- **Optimistic concurrency on `update-note`** via an `if_updated_at` parameter. When supplied and it doesn't match the note's current `updated_at`, the update is rejected (MCP: `ConflictError`; HTTP: 409). Batch updates fail fast on the first conflict.
- **Link expansion on `query-notes`** — new `expand_links` / `expand_depth` (0–3) / `expand_mode` (`"full"` | `"summary"`) parameters inline `[[wikilink]]` targets directly into the returned content. Works on the MCP tool and the HTTP routes (single-note, search, and structured-list).
- **9 composable MCP tools** (was 30): `query-notes`, `create-note`, `update-note`, `delete-note`, `list-tags`, `update-tag`, `delete-tag`, `find-path`, `vault-info`. Every note parameter accepts either an ID or a path.
- **Webhook triggers** — declarative config-driven webhooks fire on note mutations matching tag / metadata predicates. Three send modes: `json` (general), `attachment` (Whisper-compatible transcription), `content` (OpenAI-compatible TTS).

### Documentation

- Entirely overhauled onboarding path: OAuth walkthrough, doctor + troubleshooting, first-run narrative (what `vault init` does on disk), multi-vault subsection, Tailscale Funnel walkthrough, prerequisites block.
- Honest token-shape documentation (`pvt_` is modern; `pvk_` is legacy and still accepted).
- README tells the truth about what `vault init` writes to `~/.claude.json` — a vault-scoped URL with a baked-in `pvt_` bearer, not OAuth.

### Removed

- **Semantic / vector search** — the embeddings path (`sqlite-vec`, `semantic-search` tool, embedding-provider setup wizard, `/api/ingest` endpoint). Full-text search via `query-notes` `search=` remains.
- **`parachute vault keys` subcommand** — superseded by `parachute vault tokens`. Legacy `pvk_...` keys in `config.yaml` are still honored at runtime.

### For contributors

- **Async `Store` interface**, renamed to `BunSqliteStore`. Paves the way for Durable Object SQLite and R2 blob backends (in flight).
- **`src/routing.ts`** extracted from `src/server.ts` so the request dispatcher is unit-testable without spinning up `Bun.serve()`.
- **`core/src/test-preload.ts`** isolates `PARACHUTE_HOME` for tests so `bun test` never touches a user's real `~/.parachute/`.
- Test suite at release cut: **538 passing / 0 failing / 3 skipped** across 22 files (541 tests total).

[0.2.3]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.3
[0.2.2]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.2
[0.2.1]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.1
[0.2.0]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.0
