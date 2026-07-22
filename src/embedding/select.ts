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
 * **Opt-in gate (0.7.3, Aaron-ratified):** semantic search is OFF by
 * default. `buildEmbeddingProvider` returns a provider ONLY when the
 * feature is explicitly enabled — otherwise it returns `undefined` and
 * BOTH tiers are short-circuited. The enable signal is resolved with a
 * two-level precedence (see `resolveEmbeddingsEnabled`):
 *
 *   1. **`EMBEDDINGS_ENABLED` env var** — the low-level override. `true`/`1`
 *      forces ON, `false`/`0` forces OFF, anything else (incl. unset)
 *      defers to the persisted setting. Mirrors the cloud wrangler var.
 *   2. **Persisted `embeddings_enabled`** (config.yaml, wired in by the
 *      caller — see `getSharedEmbeddingProvider`) — the self-host settings
 *      toggle, so an operator can turn semantic search on without editing
 *      the env file. Defaults OFF when unset.
 *
 * A caller wired against an `undefined` provider (see
 * `Store.embeddingProvider`) reports the `embeddings` capability as
 * disabled and `semanticSearch` throws `semantic_unavailable` — the exact
 * same honest-failure path as "no provider configured" (never a silent
 * keyword fallback). The embed-on-write drain simply has nothing to
 * invoke, so it no-ops — no hook work, no backfill sweep, and (because the
 * ~270MB `@huggingface/transformers` import is dynamic and only happens
 * inside a real `embed()` call) no model download until a user opts in.
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
 * Parse `EMBEDDINGS_ENABLED` as an explicit tri-state OVERRIDE of the
 * persisted config setting (all matches case-insensitive + trimmed):
 *
 *   - `"true"` / `"1"`  → `true`  (force semantic search ON)
 *   - `"false"` / `"0"` → `false` (force it OFF)
 *   - unset / blank / anything unrecognized → `undefined` (no opinion —
 *     defer to the persisted `embeddings_enabled` setting)
 *
 * Returning `undefined` (rather than guessing) for an unrecognized value is
 * what lets the env var be a true override: only an explicit true/false
 * short-circuits the persisted setting.
 */
export function embeddingsEnabledEnvOverride(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const raw = env.EMBEDDINGS_ENABLED?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

/**
 * The effective enabled state for semantic search. Env override wins; else
 * the persisted config setting; else OFF — semantic search is opt-in as of
 * 0.7.3. Pure so both the provider factory and the "why is it off" hint
 * derive from the same rule.
 */
export function resolveEmbeddingsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  persistedEnabled?: boolean,
): boolean {
  return embeddingsEnabledEnvOverride(env) ?? persistedEnabled ?? false;
}

/**
 * Build the provider the current config selects, or `undefined` when
 * semantic search is not enabled (see `resolveEmbeddingsEnabled` — env
 * override, else the persisted `embeddings_enabled` setting, else OFF).
 * Pure factory (no caching, no I/O beyond what the provider's own
 * constructor does — which is none; both providers lazy-load/lazy-connect
 * on first `embed()`), so it's cheap to call repeatedly in tests.
 * Production callers should go through the shared singleton
 * (`getSharedEmbeddingProvider`) instead of calling this directly, so the
 * bundled ONNX model — when selected — loads at most once per process, and
 * so the persisted setting is threaded in.
 */
export function buildEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { persistedEnabled?: boolean },
): EmbeddingProvider | undefined {
  if (!resolveEmbeddingsEnabled(env, opts?.persistedEnabled)) return undefined;
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
