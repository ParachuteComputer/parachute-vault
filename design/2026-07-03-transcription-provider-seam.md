# Transcription provider seam — the scribe-fold (Phase 1)

**Status:** Phase 1 shipped (vault#529). Phase 2a shipped (vault#530); provider contract corrected against a live v0.1.1 run (this PR). Phases 2b–3 planned.
**Ratified:** 2026-07-03 (Aaron) — scribe folds into vault as a built-in transcription feature; adopt transcribe.cpp (subprocess) as the recommended local provider.
**Repo:** parachute-vault (`0.6.5-rc.7`).

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

src/transcription/providers/scribe-http.ts    ← the whisper-compatible remote provider (Phase 1)
src/transcription/providers/transcribe-cpp.ts ← the local subprocess provider (Phase 2a)
src/transcription/select.ts                   ← TRANSCRIPTION_PROVIDER selection + transcribe-cpp paths (Phase 2a)
src/transcription/install.ts                  ← install planning + the RAM-tier matrix (Phase 2a)
src/transcription/capability.ts               ← landing capability flag, provider-aware (Phase 1 + 2a)
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

## Phase 2a (this PR) — the `transcribe-cpp` local provider + RAM-tier install

Move the FIRST local-ASR backend behind `TranscriptionProvider`, so a vault can
transcribe with no second module at all. This is where the `services.json`-based
`scribe-http` provider stops being the *only* path. Non-breaking: the default
provider stays `scribe-http`; transcribe-cpp is opt-in.

### Why transcribe.cpp (CJ Pais / Mozilla.ai)

Ratified 2026-07-03 (Aaron): adopt **transcribe.cpp**
([github.com/handy-computer/transcribe.cpp](https://github.com/handy-computer/transcribe.cpp)
— CJ Pais / Mozilla.ai, MIT, "llama.cpp for STT") as the recommended low-RAM,
no-Python local provider, **ahead of whisper.cpp**. It publishes GGUF models on
HuggingFace (`handy-computer/*`) and per-platform release tarballs, and needs no
Python toolchain. `scribe-http` stays as the remote / compat fallback.

### What v0.1.1 actually ships — library, not CLI (live-verified 2026-07-03)

A live run on a real Mac (transcribe.cpp `v0.1.1`, macOS arm64 M4,
whisper-tiny.en-Q5_K_M) corrected **two** assumptions this design originally
made:

1. **The release tarball is a LIBRARY, not a prebuilt CLI.** The v0.1.1
   macOS/Linux `transcribe-native-*` assets contain `libtranscribe.{dylib,so}` +
   `libggml*.{dylib,so}` + `contract.json` + licenses — and **no
   `transcribe-cli` executable**. The CLI is *build-from-source* in v0.1.1
   (`examples/cli/main.cpp` + `examples/common/wav.cpp`). So `transcription
   install` fetches the tarball for its **runtime shared libraries**, downloads
   the GGUF model, and then **honestly reports the CLI-acquisition gap**: it
   activates transcribe-cpp (flips `TRANSCRIPTION_PROVIDER`) only when a runnable
   CLI is actually present — otherwise it leaves the current provider unchanged
   and prints the gap. `available()` + the worker-boot gate both require the
   binary to exist, so the capability flag reports `enabled:false` rather than a
   capability we can't deliver.
2. **The transcript is a single `text:` line on stdout.** `transcribe-cli`
   prints a human report to STDOUT (`audio:`/`model:`/`run:` lines, then
   `text: <transcript>`, then per-segment lines) and sends its library
   `[info]`/`[debug]` logs to STDERR. The parser scans for the column-0 `text:`
   line and returns it; `text: (empty)` is the no-result sentinel → `""`. (The
   earlier parser concatenated every stdout line into silent garbage.)

**Binary acquisition — the plan.** The clean path is a **prebuilt
`transcribe-cli` per platform in upstream releases** — that's the concrete
**UPSTREAM ASK to CJ Pais / handy-computer** and a natural collaboration item.
Interim, if we don't wait for upstream, we can **build the CLI at install** —
compiling `examples/cli/main.cpp` + `examples/common/wav.cpp` against the
prebuilt `libtranscribe` dylib is proven to work (~127KB, a tiny compile, no
ggml rebuild). Until either lands, an operator points `TRANSCRIBE_CPP_BIN` at a
CLI they built. transcribe-cpp therefore stays **opt-in and unpromoted** until
binary acquisition is solved.

### Why the SUBPROCESS path (not the N-API binding)

transcribe.cpp ships an in-process N-API / TypeScript binding
(`bindings/typescript`), but it **crashes on Bun**. So the provider drives a
`transcribe-cli` as a **subprocess** (`Bun.spawn`) — structurally the same as
`scribe-http` (spawn/POST → parse → map errors), but local. The CLI contract we
pin (validated against release `v0.1.1`):

```
transcribe-cli -m <model.gguf> <audio.wav>     # STRICT 16kHz mono WAV in; report on stdout
```

`transcribe-cli` **strictly** requires **16kHz mono WAV** and rejects other
sample rates (a 44.1kHz `.wav` exits non-zero). So we **ALWAYS** transcode the
incoming audio through `ffmpeg -ar 16000 -ac 1` first — **even an incoming
`.wav`**, whose sample rate we can't trust (the earlier "pass already-WAV
straight through" wasted the worker's retries on such files). `available()` is a
spawn-free `existsSync` of binary+model (it gates the capability flag on every
`/api/vault` GET), memoized once-true. When the CLI runs against our prebuilt
dylibs it must find them at runtime — `DYLD_LIBRARY_PATH` (macOS) /
`LD_LIBRARY_PATH` (Linux) point at the extracted `libs/`. Error mapping mirrors
scribe-http's terminal-vs-retriable contract: `missing_provider` /
`ffmpeg_missing` / `transcode_failed` are terminal (operator must act); a
`transcribe-cli` non-zero exit is retriable (transient blip → backoff; a
deterministic failure still terminates after maxAttempts); empty / `(empty)`
stdout is a plain `Error` (retriable).

### Provider selection

`TRANSCRIPTION_PROVIDER` (env, persisted in `~/.parachute/vault/.env`) selects
the active provider — `scribe-http` (unset/default) or `transcribe-cpp`. One
resolver (`src/transcription/select.ts`) is the single source of truth shared by
the worker boot (`server.ts`) and the capability flag (`capability.ts`), so both
agree. The worker's queue/backoff/retry/transcript-note/retention logic is
untouched — it just gets a different `provider`.

### The RAM-tier install (`parachute-vault transcription install`) — the scribe#82 fix

scribe#82: today scribe auto-installs Parakeet-0.6b at 2GB and **OOMs on long
audio**. The install verb's tier floor is the fix — it detects OS/arch + total
RAM (`/proc/meminfo` on Linux, else `os.totalmem()`) and picks:

| Total RAM | Model | GGUF (quant) | ~download | ~peak RAM |
|---|---|---|---|---|
| **≥ 4 GB** | `parakeet-tdt-0.6b-v3` | Q8_0 | ~660 MB | ~3.5 GB |
| **2 – 4 GB** | `whisper-small.en` | Q5_K_M | ~190 MB | ~1.3 GB |
| **1 – 2 GB** | `whisper-tiny.en` | Q5_K_M | ~42 MB | ~0.4 GB |
| **< 1 GB** | *(refuse)* | — | — | steer to `scribe-http` remote |

**Parakeet is gated to ≥4GB** (was auto-installing at 2GB) — the floor fix.
`--model <id>` overrides the tier pick; `--provider scribe-http` flips config
back with no download; `--dry-run` prints the plan without fetching (the path
tests exercise — no network). The verb downloads the matching release asset
(`transcribe-native-<v>-<platform>-<backend>.tar.gz`), extracts its runtime
shared libraries into `libs/`, downloads the model GGUF, and writes
`install.json` — all into `~/.parachute/transcription/`. It flips
`TRANSCRIPTION_PROVIDER=transcribe-cpp` **only when a runnable `transcribe-cli`
exists** (`TRANSCRIBE_CPP_BIN` or one placed from the asset); on the v0.1.1
library-only reality it instead reports the CLI-acquisition gap and leaves the
current provider untouched (see "What v0.1.1 actually ships" above). ffmpeg is
hinted (not hard-required) — the always-on transcode path checks at runtime.

### Non-breaking guarantee (Phase 2a)

Default provider stays `scribe-http`. No config change ⇒ no behavior change;
existing scribe-http installs transcribe identically. The full bun suite stays
green (2662 baseline + the Phase-2a additions).

## Phase 2b (planned) — absorb scribe's own local backends

Absorb scribe's `parakeet-mlx` / `onnx-asr` backends behind the same interface
(so macOS gets the MLX-accelerated Parakeet path, not just the GGUF CPU/Metal
one), then a cleanup pass over the standalone scribe worker process. This PR
deliberately does **not** touch those — Phase 2a is the transcribe.cpp provider
+ install + tier selection only.

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
