/**
 * Transcription provider seam (scribe-fold Phase 1).
 *
 * A `TranscriptionProvider` is the single, runtime-agnostic contract for
 * turning an audio blob into text. It exists so vault's transcription worker
 * doesn't hard-code "POST to scribe" — the worker resolves a provider and
 * calls `transcribe()`, and the provider owns HOW the bytes become text.
 *
 * ## Why this lives in core (not src)
 *
 * The interface must be importable from BOTH runtimes without dragging in
 * Bun- or Node-only APIs:
 *
 *   - the Bun vault (`src/transcription/providers/scribe-http.ts` — the
 *     whisper-compatible remote provider that reproduces today's scribe call);
 *   - the cloud vault (a future Cloudflare Workers-AI provider implemented
 *     against THIS interface for the metered voice build).
 *
 * So it is pure types + one dependency-free error class — no `fs`, no
 * `FormData` serialization, no `fetch`. `audio` arrives as a `Uint8Array`
 * (both runtimes have it); a provider decides how to ship it. Core has no
 * package `exports` map, so consumers import the src subpath directly
 * (`../core/src/transcription/provider.ts`), the same convention as
 * `core/src/seed-packs.ts`.
 *
 * ## The fold (context)
 *
 * Ratified 2026-07-03 (Aaron): scribe folds into vault as a built-in
 * transcription feature. Phase 1 (this seam) is behavior-preserving — the
 * default `scribe-http` provider does EXACTLY what today's `callScribe` did,
 * so existing scribe installs keep working unchanged. Phase 2 moves local-ASR
 * backends behind the same interface. See
 * `design/2026-07-03-transcription-provider-seam.md`.
 */

/**
 * A single context entry attached alongside the audio (person/project notes,
 * etc.). Structurally identical to `src/context.ts`'s `ContextEntry` — the
 * same shape scribe already consumes over the `context` multipart part — so a
 * `ContextPayload` produced there is assignable here without conversion. The
 * interface stays runtime-agnostic: a provider decides whether/how to
 * serialize it.
 */
export interface TranscriptionContextEntry {
  /** Note path basename, or note id if no path. */
  name: string;
  /** Whitelisted metadata fields carried through from the vault query. */
  [key: string]: unknown;
}

/** The `{ entries: [...] }` context blob a provider may forward with the audio. */
export interface TranscriptionContext {
  entries: TranscriptionContextEntry[];
}

/** The audio + descriptors handed to a provider for one transcription. */
export interface TranscribeInput {
  /** Raw audio bytes. Both runtimes expose `Uint8Array`; a `Buffer` is one. */
  audio: Uint8Array;
  /** Original filename (used for the multipart `file` part / provider hints). */
  filename: string;
  /** MIME type of the audio (e.g. `audio/webm`). */
  mimeType: string;
  /**
   * Optional vault-provided context (person/project notes) to forward with the
   * audio so the provider/model can use it. `null`/`undefined` means none.
   */
  context?: TranscriptionContext | null;
}

/** What a provider returns on a successful transcription. */
export interface TranscribeResult {
  /** The transcript text. */
  text: string;
  /**
   * Duration of the transcribed AUDIO in seconds, when the provider reports it.
   * This is a metered/plan concern (the cloud voice build will decrement a
   * minutes balance by it); self-host providers that don't measure it leave it
   * unset. NOT the wall-clock request time — the worker measures that itself.
   */
  audioSeconds?: number;
}

/** Provider readiness probe result. */
export interface ProviderAvailability {
  /** True when the provider can service `transcribe()` calls right now. */
  ok: boolean;
  /** Human-readable cause when `ok` is false (e.g. "no scribe URL configured"). */
  reason?: string;
}

/**
 * The transcription contract. Implementations own the audio→text step; the
 * worker owns queueing, backoff/retry, transcript-note materialization, and
 * retention — none of which belong here.
 */
export interface TranscriptionProvider {
  /** Stable provider identifier, surfaced on the capability flag (e.g. "scribe-http"). */
  readonly name: string;
  /** Turn audio into text (or throw — see `TranscriptionError` for the retry contract). */
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  /**
   * Cheap, side-effect-free readiness check. MUST NOT perform the actual
   * transcription or a network round-trip unless that is genuinely cheap —
   * it gates the capability flag on the vault landing, called on config reads.
   */
  available(): Promise<ProviderAvailability>;
}

/**
 * Structured, provider-agnostic transcription failure.
 *
 * The worker's terminal-vs-retry decision keys off `retriable`: a
 * non-retriable error (a 4xx the operator must fix — no provider configured,
 * bad auth) fails immediately with no backoff; a retriable one (5xx, transient
 * upstream) is retried with exponential backoff. `code` is a stable machine
 * string (e.g. `missing_provider`) surfaced on the transcript note's
 * frontmatter and the attachment's `transcribe_error_code` so callers branch
 * on it instead of regex-matching message text.
 *
 * Providers throw this for structured failures; a plain `Error` (network drop,
 * timeout, malformed response) is treated as retriable by the worker.
 */
export class TranscriptionError extends Error {
  /** Stable machine code (e.g. "missing_provider"), when the provider supplied one. */
  readonly code?: string;
  /** Upstream HTTP status, when the failure came from an HTTP provider. */
  readonly httpStatus?: number;
  /** Whether retrying the same audio could plausibly succeed. */
  readonly retriable: boolean;
  constructor(
    message: string,
    opts: { code?: string; httpStatus?: number; retriable: boolean },
  ) {
    super(message);
    this.name = "TranscriptionError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retriable = opts.retriable;
  }
}
