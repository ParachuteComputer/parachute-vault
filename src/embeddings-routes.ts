/**
 * HTTP surface for the semantic-search (embeddings) opt-in toggle.
 *
 *   GET  /vault/<name>/.parachute/embeddings — read the persisted setting +
 *                                              the running/effective/env state
 *   PUT  /vault/<name>/.parachute/embeddings — flip the persisted setting
 *
 * The 0.7.3 fast-follow: 0.7.3 shipped the persisted `embeddings_enabled`
 * config.yaml setting + `resolveEmbeddingsEnabled` (env override → persisted
 * → off), but the ONLY way to flip it was hand-editing config.yaml or setting
 * an env var. This module gives the vault admin SPA a real toggle over that
 * setting.
 *
 * URL note: same reasoning as `mirror-routes.ts` — the admin SPA's static
 * bundle owns `/vault/<name>/admin/*` (vault#252), so the API surface lives
 * under the `.parachute/` module-protocol namespace (sibling to
 * `.parachute/config`, `.parachute/mirror`, `.parachute/usage`).
 *
 * Auth: `vault:admin`, gated upstream in `routing.ts` (this module is the
 * after-auth handler). `embeddings_enabled` is host-global config that affects
 * every vault on the server, but it's reached through the same per-vault admin
 * surface every other settings page uses; the UI copy names the host-wide
 * scope.
 *
 * **Activation is restart-to-apply, not hot.** The embedding provider is
 * resolved ONCE at boot (`getSharedEmbeddingProvider`) and captured into every
 * open store (`Store.embeddingProvider` + `embeddingDisabledReason`, baked at
 * construction) and into the embedding worker (`EmbeddingWorker.provider`, a
 * private readonly field). Re-resolving the provider mid-run would mean
 * mutating readonly fields across the worker AND every already-open store AND
 * resetting a deliberately-once module memo — not clean. So this endpoint
 * PERSISTS the setting and reports `restart_required` when the persisted
 * change hasn't taken effect in the running process yet. Hot-reconfigure is a
 * possible follow-up.
 *
 * **The `EMBEDDINGS_ENABLED` env var still wins.** It's the low-level override
 * (`true`/`1` on, `false`/`0` off, else defer). When it's forcing a value the
 * snapshot carries `env_override` so the UI can flag that the persisted toggle
 * is advisory until the env var is removed — the toggle never lies about
 * what's actually in force.
 */

import { readGlobalConfig, writeGlobalConfig } from "./config.ts";
import { embeddingsEnabledEnvOverride, resolveEmbeddingsEnabled } from "./embedding/select.ts";
import { isSharedEmbeddingProviderActive } from "./vault-store.ts";

/**
 * Approximate size of the bundled ONNX model (`bge-small-en-v1.5`, q8) that
 * lazy-downloads on the FIRST embed after enabling. Surfaced so the UI can
 * warn before the operator flips the switch. (The npm dependency ships ~270MB
 * of runtime, but the model weights fetched on first use are ~34MB.)
 */
export const EMBEDDING_MODEL_DOWNLOAD_MB = 34;

const CORS = { "Access-Control-Allow-Origin": "*" } as const;

/**
 * The wire shape the admin SPA reads/writes. Both GET and PUT return this so
 * the SPA reuses one decoder.
 */
export interface EmbeddingsSettingsSnapshot {
  /**
   * The persisted `embeddings_enabled` in config.yaml — the value the toggle
   * reflects. `false` when unset (semantic search is opt-in, default off).
   */
  enabled: boolean;
  /**
   * The `EMBEDDINGS_ENABLED` env override, tri-state: `true` (forced on),
   * `false` (forced off), or `null` (no env var — defers to `enabled`). When
   * non-null the env var wins over the persisted setting.
   */
  env_override: boolean | null;
  /**
   * Convenience flag: `true` exactly when `env_override` is non-null. The UI
   * shows an advisory banner ("an env var is forcing this") when set.
   */
  env_forced: boolean;
  /**
   * What a fresh boot would resolve: env override, else persisted, else off.
   * This is the state the running process will land in on next restart.
   */
  effective: boolean;
  /**
   * Whether semantic search is LIVE in the running process right now (the
   * boot-resolved provider is present). Distinct from `effective`: a flip of
   * the persisted setting changes `effective` immediately but not `active`.
   */
  active: boolean;
  /**
   * `true` when `active !== effective` — the operator's intended state is
   * persisted but the running process hasn't picked it up. Restart to apply.
   */
  restart_required: boolean;
  /** First-enable model-download size hint (MB) for the UI copy. */
  model_download_mb: number;
}

/**
 * Build the snapshot from the persisted setting + env + running state. Pure
 * over its inputs (env + persisted + active) so it's unit-testable without a
 * live server; the `active` reading is injected (defaults to the real
 * process-shared provider state).
 */
export function buildEmbeddingsSnapshot(opts?: {
  env?: NodeJS.ProcessEnv;
  persistedEnabled?: boolean;
  active?: boolean;
}): EmbeddingsSettingsSnapshot {
  const env = opts?.env ?? process.env;
  const persisted = opts?.persistedEnabled ?? false;
  const active = opts?.active ?? isSharedEmbeddingProviderActive();
  const override = embeddingsEnabledEnvOverride(env);
  const effective = resolveEmbeddingsEnabled(env, persisted);
  return {
    enabled: persisted,
    env_override: override ?? null,
    env_forced: override !== undefined,
    effective,
    active,
    restart_required: active !== effective,
    model_download_mb: EMBEDDING_MODEL_DOWNLOAD_MB,
  };
}

/**
 * `GET /vault/<name>/.parachute/embeddings` — return the current settings
 * snapshot. Always 200 (auth enforced upstream). `activeOverride` is a test
 * seam; production passes nothing and the running provider state is read.
 */
export function handleEmbeddingsGet(activeOverride?: boolean): Response {
  const persisted = readGlobalConfig().embeddings_enabled;
  const snapshot = buildEmbeddingsSnapshot({ persistedEnabled: persisted, active: activeOverride });
  return Response.json(snapshot, { headers: CORS });
}

/**
 * `PUT /vault/<name>/.parachute/embeddings` — persist a new
 * `embeddings_enabled` value. Body: `{ "enabled": boolean }`.
 *
 * Reuses the config write path (`writeGlobalConfig` — never hand-rolls YAML),
 * so the serialize logic that already knows how to persist `embeddings_enabled`
 * is the single source of truth. Persists even when the env var is forcing a
 * value (the operator's persisted intent is recorded; the env override still
 * wins for `effective`/`active`, and the snapshot says so). Returns the same
 * shape as GET, reflecting the new persisted value + the unchanged running
 * state (so `restart_required` is honest right after the write).
 */
export async function handleEmbeddingsPut(req: Request, activeOverride?: boolean): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return Response.json(
      { error: "Invalid JSON body", message: (err as Error).message ?? String(err) },
      { status: 400 },
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json(
      { error: "Invalid body", field: "enabled", message: "Expected a JSON object { enabled: boolean }." },
      { status: 400 },
    );
  }
  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled !== "boolean") {
    return Response.json(
      { error: "Invalid body", field: "enabled", message: "`enabled` must be a boolean." },
      { status: 400 },
    );
  }

  const config = readGlobalConfig();
  config.embeddings_enabled = enabled;
  writeGlobalConfig(config);

  const snapshot = buildEmbeddingsSnapshot({ persistedEnabled: enabled, active: activeOverride });
  return Response.json(snapshot, { headers: CORS });
}
