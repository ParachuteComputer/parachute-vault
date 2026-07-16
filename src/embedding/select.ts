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
 * **Off switch:** `EMBEDDINGS_ENABLED=false` short-circuits BOTH tiers —
 * `buildEmbeddingProvider` returns `undefined` regardless of what else is
 * configured. Mirrors the `EMBEDDINGS_ENABLED` wrangler var C2 (cloud)
 * plans for the same gate. A caller wired against an `undefined` provider
 * (see `Store.embeddingProvider`) reports the `embeddings` capability as
 * disabled and `semanticSearch` throws `semantic_unavailable` — the exact
 * same honest-failure path as "no provider configured" (never a silent
 * keyword fallback). The embed-on-write drain simply has nothing to
 * invoke, so it no-ops.
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
 * `true` only when `EMBEDDINGS_ENABLED` is explicitly the literal string
 * `"false"` (case-insensitive, trimmed) — the off switch. Every other
 * value, INCLUDING unset, is "enabled": the feature defaults ON (the
 * bundled floor tier makes that safe — zero-config still works), and this
 * var exists to opt OUT, not to opt in.
 */
export function embeddingsExplicitlyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EMBEDDINGS_ENABLED?.trim().toLowerCase() === "false";
}

/**
 * Build the provider the current config selects, or `undefined` when
 * `EMBEDDINGS_ENABLED=false` (see the off-switch doc above). Pure factory
 * (no caching, no I/O beyond what the provider's own constructor does —
 * which is none; both providers lazy-load/lazy-connect on first
 * `embed()`), so it's cheap to call repeatedly in tests. Production
 * callers should go through the shared singleton
 * (`getSharedEmbeddingProvider`) instead of calling this directly, so the
 * bundled ONNX model — when selected — loads at most once per process.
 */
export function buildEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | undefined {
  if (embeddingsExplicitlyDisabled(env)) return undefined;
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
