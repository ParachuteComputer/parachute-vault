# Transcription provider seam — the scribe-fold (Phase 1)

**Status:** Phase 1 shipped (this PR). Phases 2–3 planned.
**Ratified:** 2026-07-03 (Aaron) — scribe folds into vault as a built-in transcription feature.
**Repo:** parachute-vault (`0.6.5-rc.5`).

## Why

Transcription is a first-class thing a Parachute vault does: you drop a voice
memo, you get text. Today that text comes from a *separate* committed-core
module — `parachute-scribe`, a whisper-compatible worker vault reaches over
loopback HTTP (`services.json` discovery → `POST /v1/audio/transcriptions`).
That split made sense when transcription was experimental; it now costs a
second installed module, a shared bearer to provision, and a second thing that
can be "not installed" when a user just wants to talk to their notes.

Aaron's call (2026-07-03): fold scribe into vault. Vault owns transcription;
the audio→text step becomes a swappable **provider**. Remote whisper endpoints,
local ASR, and the cloud's metered Workers-AI backend all become
implementations of one interface — vault's queue/retry/transcript-note
machinery is written once and reused across all of them.

## The seam

```
core/src/transcription/provider.ts        ← runtime-agnostic interface (this PR)
  TranscriptionProvider {
    name
    transcribe({ audio: Uint8Array, filename, mimeType, context? }) → { text, audioSeconds? }
    available() → { ok, reason? }
  }
  TranscriptionError { code?, httpStatus?, retriable }   ← terminal-vs-retry contract

src/transcription/providers/scribe-http.ts ← the whisper-compatible provider (this PR)
src/transcription/capability.ts            ← landing capability flag (this PR)
```

The interface lives in `core/` (not `src/`) so **both** runtimes can implement
it without dragging in Bun/Node APIs: the Bun vault today, and the cloud vault
DO (Cloudflare Workers-AI) tomorrow. `audio` crosses the boundary as a
`Uint8Array` — both runtimes have it; the provider decides how to ship the
bytes. Core has no package `exports` map, so consumers import the src subpath
directly (`../core/src/transcription/provider.ts`), matching `seed-packs.ts`.

The worker owns everything that is *not* audio→text — queueing, the DB-as-queue
`transcribe_status` state machine, exponential backoff, the OC-guarded
transcript/marker note writes, `transcribe_origin` auto-vs-legacy branching,
and `audio_retention`. It measures the **wall-clock** request time itself
(`transcribe_duration_ms`). `audioSeconds` on the result is a separate,
provider-reported *content* duration — unused by self-host, the metering hook
for cloud.

### Error contract (why `retriable` is load-bearing)

The worker's terminal-vs-retry decision is the one thing a provider must get
right. A `TranscriptionError` with `retriable: false` (a 4xx the operator must
fix — no provider configured, bad auth) fails immediately with no backoff; a
`retriable: true` one (5xx, transient upstream) backs off and retries. Anything
else — a plain `Error` from a dropped socket, a timeout, a malformed 200 — is
treated as retriable. `code` (e.g. `missing_provider`) is surfaced verbatim on
the transcript note's `transcript_error` and the attachment's
`transcribe_error_code` so callers branch on a stable string.

## Phase 1 (this PR) — non-breaking seam, behavior preserved

- **Define** `TranscriptionProvider` + `TranscriptionError` in core.
- **Extract** today's `callScribe` into `ScribeHttpProvider` — a *byte-for-byte*
  port. Same discovery (`SCRIBE_URL` / `services.json`), same endpoint, same
  auth header, same context part, same error mapping. This is BOTH the default
  provider for existing installs AND the migration bridge to any remote
  whisper-compatible endpoint.
- **Rewire** `transcription-worker.ts`: the audio→text call goes through
  `provider.transcribe()`; when no provider is injected the worker builds the
  scribe-http one from the same `scribeUrl`/`scribeToken`/`timeoutMs`/`fetchImpl`
  it was already handed. **Every existing scribe install transcribes
  identically** — the full worker suite (42 tests) passes unchanged.
- **Capability flag**: `GET /vault/<name>/api/vault` gains
  `transcription: { enabled, provider? }`, where `enabled` iff a provider is
  configured AND `available()`. This is the field the Notes surface gates its
  microphone on — distinct from the `auto_transcribe.enabled` *policy* toggle
  (which defaults on even with no reachable provider). `minutes_remaining` is
  omitted: a cloud/plan concern, and self-host is unmetered.

**Non-breaking guarantee.** No config changes, no committed-core changes, no
hub changes, no wire changes. Scribe installs keep working exactly as before,
through the compat provider.

## Phase 2 (planned) — local backends behind the interface

Move local-ASR backends (and any cleanup of the standalone scribe worker
process) behind `TranscriptionProvider`, so a vault can transcribe with no
second module at all. This is where the `services.json`-based `scribe-http`
provider stops being the *only* path. Introduces provider selection config.

## Phase 3 (planned) — retire the standalone module + committed-core shift

Fold completes: the standalone `parachute-scribe` module is retired (or reduced
to a thin provider shim), the committed-core line is redrawn, and hub's
install/offer surfaces drop scribe as a separately-installed module.

## Migration coordination (parachute-patterns)

Per the workspace migration discipline, a **committed-core / canonical-install
shift ships a `parachute-patterns/migrations/2026-07-XX-scribe-fold-into-vault.md`
propagation checklist** — but that lands with **Phase 2/3**, when the fold
actually touches the committed-core line and hub's install surfaces.

**Phase 1 changes none of that**: it's an internal, non-breaking seam. Scribe
**remains committed-core** until the fold completes. This design doc plus the
PR body are the record for Phase 1; the full migration file is a Phase 2/3
deliverable.
