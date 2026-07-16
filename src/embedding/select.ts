/**
 * Embedding provider selection (semantic search MVP — two-tier self-host
 * shape, Aaron-ratified). Mirrors `src/transcription/select.ts`'s
 * env-driven resolution pattern.
 *
 * Two tiers, config wins over the bundled floor:
 *
 *   - **Config upgrade** (`external-api.ts`): `EMBEDDING_API_URL` set (in
 *     `~/.parachute/vault/.env`, the same bring-your-own-endpoint pattern
 *     as `PARACHUTE_GITHUB_*`) → the OpenAI-compatible client, pointed at
 *     it. Covers a local Ollama (`ollama pull bge-m3`, fully private) and
 *     any hosted `/v1/embeddings` endpoint. `EMBEDDING_MODEL` names the
 *     model the endpoint should embed with; `EMBEDDING_API_KEY` is a
 *     bearer token, when the endpoint needs one.
 *   - **Bundled floor** (`onnx-transformers.ts`): no env at all → the
 *     zero-config default, `bge-small-en-v1.5` (q8 ONNX) running
 *     in-process. This is what makes semantic search work on a fresh
 *     install with no operator action.
 *
 * `EMBEDDING_MODEL` alone (no `EMBEDDING_API_URL`) has no effect — it only
 * shapes the config-upgrade tier. Resolved per-call (not cached here) so
 * `PARACHUTE_HOME`/env overrides apply in tests exactly like every other
 * env-driven selector in this codebase; the ONE shared runtime instance
 * (so the bundled model loads at most once per process) is cached at the
 * call site — see `src/vault-store.ts`'s `getSharedEmbeddingProvider`.
 */

import type { EmbeddingProvider } from "../../core/src/embedding/provider.ts";
import { ExternalApiEmbeddingProvider } from "./external-api.ts";
import { OnnxTransformersEmbeddingProvider } from "./onnx-transformers.ts";

/** Default model requested from the config-upgrade tier when `EMBEDDING_MODEL` is unset. Matches the plan's recommended quality default (Ollama `bge-m3`). */
export const DEFAULT_EXTERNAL_EMBEDDING_MODEL = "bge-m3";

export interface EmbeddingApiConfig {
  url?: string;
  apiKey?: string;
  model?: string;
}

/** Read the `EMBEDDING_API_URL`/`EMBEDDING_API_KEY`/`EMBEDDING_MODEL` env trio. Blank/whitespace-only values are treated as absent. */
export function resolveEmbeddingApiConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingApiConfig {
  return {
    url: env.EMBEDDING_API_URL?.trim() || undefined,
    apiKey: env.EMBEDDING_API_KEY?.trim() || undefined,
    model: env.EMBEDDING_MODEL?.trim() || undefined,
  };
}

/**
 * Build the provider the current config selects. Pure factory (no
 * caching, no I/O beyond what the provider's own constructor does — which
 * is none; both providers lazy-load/lazy-connect on first `embed()`), so
 * it's cheap to call repeatedly in tests. Production callers should go
 * through the shared singleton (`getSharedEmbeddingProvider`) instead of
 * calling this directly, so the bundled ONNX model — when selected —
 * loads at most once per process.
 */
export function buildEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const config = resolveEmbeddingApiConfig(env);
  if (config.url) {
    return new ExternalApiEmbeddingProvider({
      url: config.url,
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_EXTERNAL_EMBEDDING_MODEL,
    });
  }
  return new OnnxTransformersEmbeddingProvider();
}
