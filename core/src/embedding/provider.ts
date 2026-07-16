/**
 * Embedding provider seam (semantic-search MVP, V2).
 *
 * An `EmbeddingProvider` is the single, runtime-agnostic contract for
 * turning text into a dense vector. It exists so the semantic-search scan
 * doesn't hard-code a model or an HTTP call — the store resolves a
 * provider and calls `embed()`, and the provider owns HOW text becomes a
 * vector.
 *
 * ## Why this lives in core (not src)
 *
 * The interface must be importable from BOTH runtimes without dragging in
 * Bun- or Node-only APIs, or any model library:
 *
 *   - the Bun vault (`src/embedding/onnx-transformers.ts` — the bundled
 *     floor provider — and `src/embedding/external-api.ts` — the
 *     OpenAI-compatible config upgrade);
 *   - the cloud vault (a future Cloudflare Workers-AI provider implemented
 *     against THIS interface, mirroring `transcription/workers-ai.ts`).
 *
 * So it is pure types + one dependency-free error class — no `fetch`, no
 * ONNX/transformers import, no Node-only builtin. Core has no package
 * `exports` map, so consumers import the subpath directly
 * (`../core/src/embedding/provider.ts`), the same convention as
 * `core/src/transcription/provider.ts`, which this file mirrors verbatim.
 *
 * ## The fold (context)
 *
 * Ratified 2026-07-16 (Aaron: GO on the semantic-search MVP, per
 * `SEMANTIC-MVP-PLAN.md` — P0's real-corpus eval cleared the "keep
 * building" bar). This seam is the shared contract both doors implement;
 * see `core/src/embedding/chunker.ts` for the per-note chunking this feeds,
 * and `core/src/notes.ts:semanticSearchNotes` for the consumer.
 */

/** Batch-first input — a provider embeds many texts in one call (backfill). */
export interface EmbedInput {
  texts: string[];
}

/** What a provider returns for a batch: one vector per input text, same order. */
export interface EmbedResult {
  /** One vector per `EmbedInput.texts` entry, same order/length. */
  vectors: Float32Array[];
  /** The model identifier that produced these vectors (recorded per-row in `note_vectors`). */
  model: string;
  /** Vector dimensionality — every vector in `vectors` has this length. */
  dims: number;
}

/** Provider readiness probe result. */
export interface ProviderAvailability {
  /** True when the provider can service `embed()` calls right now. */
  ok: boolean;
  /** Human-readable cause when `ok` is false (e.g. "no embedding provider configured"). */
  reason?: string;
}

/**
 * The embedding contract. Implementations own the text→vector step; the
 * store owns resolving which provider is active, chunking, freshness
 * gating, and the cosine scan — none of which belong here.
 */
export interface EmbeddingProvider {
  /** Stable provider identifier, surfaced on the capability flag (e.g. "onnx-transformers", "external-api", "workers-ai"). */
  readonly name: string;
  /** Model identifier this provider produces vectors with (e.g. "bge-small-en-v1.5"). Recorded on every `note_vectors` row so a model change is detectable. */
  readonly model: string;
  /** Vector dimensionality this provider's model produces. */
  readonly dims: number;
  /** Turn a batch of texts into vectors (or throw — see `EmbeddingError` for the retry contract). */
  embed(input: EmbedInput): Promise<EmbedResult>;
  /**
   * Cheap, side-effect-free readiness check. MUST NOT perform an actual
   * embedding or a network round-trip unless that is genuinely cheap — it
   * gates the `embeddings` capability flag on the vault landing.
   */
  available(): Promise<ProviderAvailability>;
}

/**
 * Structured, provider-agnostic embedding failure.
 *
 * Mirrors `TranscriptionError` exactly (see
 * `core/src/transcription/provider.ts`): `retriable` decides whether the
 * caller retries with backoff (a transient upstream failure) or gives up
 * immediately (a config problem the operator must fix). `code` is a
 * stable machine string (e.g. `missing_provider`) so callers branch on it
 * instead of regex-matching message text.
 */
export class EmbeddingError extends Error {
  /** Stable machine code (e.g. "missing_provider"), when the provider supplied one. */
  readonly code?: string;
  /** Upstream HTTP status, when the failure came from an HTTP provider. */
  readonly httpStatus?: number;
  /** Whether retrying the same input could plausibly succeed. */
  readonly retriable: boolean;
  constructor(
    message: string,
    opts: { code?: string; httpStatus?: number; retriable: boolean },
  ) {
    super(message);
    this.name = "EmbeddingError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retriable = opts.retriable;
  }
}
