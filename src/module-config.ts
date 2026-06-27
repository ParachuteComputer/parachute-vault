/**
 * Module configuration endpoints (Phase 2 of the module architecture).
 *
 * Every Parachute module exposes two paired endpoints:
 *
 *   GET /.parachute/config/schema  — JSON Schema (draft-07) describing the
 *                                    module's configurable shape. Hub renders
 *                                    a form from this schema. No auth.
 *   GET /.parachute/config         — current effective values, with
 *                                    `writeOnly` fields excluded. No auth for
 *                                    now (hub is loopback-only through
 *                                    Phase 0–2); gated by `vault:admin` scope
 *                                    once scope enforcement lands in Phase 3.
 *
 * PUT /.parachute/config is Phase 3 — not implemented here.
 *
 * Scope boundary (vault#478): `GET /.parachute/config` is gated by
 * `vault:<name>:admin` — admin over *your* vault only — so it describes and
 * returns ONLY per-vault config, never daemon-GLOBAL settings.
 *
 * Fields currently described:
 *   - audio_retention:      per-vault enum, backed by VaultConfig.audio_retention.
 *   - autoTranscribe.enabled: per-vault toggle (vault#353). Reports the value
 *                           THIS vault will use, resolving per-vault override
 *                           (VaultConfig.auto_transcribe.enabled) → server
 *                           default (GlobalConfig.auto_transcribe.enabled) →
 *                           true. The inherited fallback is the per-vault
 *                           truth, not a leak of the global setting.
 *
 * Deliberately NOT exposed here (daemon-global → operator-only surface):
 *   - port:                 GlobalConfig.port (deployment-wide listen port).
 *   - autoTranscribe.scribeUrl / scribe_url: discovery-resolved per-process.
 *   - autoTranscribe.scribeBearer / scribe_token: shared SCRIBE_AUTH_TOKEN.
 */

import type { VaultConfig, GlobalConfig } from "./config.ts";

export interface ModuleConfigSchema {
  $schema: string;
  type: "object";
  title: string;
  description: string;
  properties: Record<string, unknown>;
}

export function buildConfigSchema(): ModuleConfigSchema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    title: "Vault configuration",
    description:
      "Settings that control vault's runtime behavior. Hub renders this schema into a configuration form.",
    properties: {
      audio_retention: {
        type: "string",
        enum: ["keep", "until_transcribed", "never"],
        default: "keep",
        title: "Audio retention",
        description:
          "What to do with audio attachments after transcription. `keep` leaves the file on disk; `until_transcribed` unlinks on successful transcribe (keeps on failure for retry); `never` unlinks on any terminal state (including failure — no retries).",
      },
      autoTranscribe: {
        type: "object",
        title: "Auto-transcribe voice uploads",
        description:
          "When enabled, audio attachments (mime-type prefix `audio/`) are automatically sent to scribe and the resulting transcript lands as a sibling `<attachment-path>.transcript.md` note. Scribe must be reachable for transcription to succeed; failures are recorded as a transcript note with `transcript_status: failed`.",
        properties: {
          enabled: {
            type: "boolean",
            default: true,
            title: "Enable auto-transcription",
            description:
              "Per-vault toggle. Default on — audio uploads transcribe automatically when scribe is reachable. Set to false to disable for THIS vault. Resolves per-vault override → server default → on, so leaving it unset inherits the deployment default.",
          },
        },
      },
      // NOTE (vault#478): daemon-GLOBAL fields (the listen `port`, the
      // discovery-resolved scribe URL, the shared scribe bearer) are
      // deliberately NOT described here. This endpoint is gated by
      // `vault:<name>:admin` — admin over *your* vault only — so it neither
      // describes nor returns deployment-wide settings. Those live behind the
      // operator-only surface (CLI / global config).
    },
  };
}

/**
 * Effective config values for ONE vault. The shared scribe bearer is
 * daemon-global and never returned (see the scope boundary below).
 *
 * Scope boundary (vault#478): the `GET /vault/<name>/.parachute/config`
 * endpoint is gated by `vault:<name>:admin` — "admin over *your* vault only".
 * It must therefore return ONLY per-vault config, never daemon-GLOBAL settings
 * (the listen `port`, the discovery-resolved scribe URL, the server-wide
 * auto-transcribe default). Those describe the whole deployment, not this
 * vault, and leaking them across the per-vault admin boundary matters once a
 * shared multi-vault daemon hands admin-on-one-vault to a beta signup. They
 * live behind the operator-only surface (the CLI / global config), not here.
 *
 * `autoTranscribe.enabled` IS per-vault: it reports the value THIS vault will
 * actually use, resolving per-vault override → global default → true (mirrors
 * `shouldAutoTranscribe`). That's a per-vault effective value, not the raw
 * daemon-global toggle — reporting it doesn't leak the global setting (an
 * unset vault simply inherits, which is the per-vault truth).
 */
export function buildConfigValues(
  vaultConfig: VaultConfig,
  globalConfig: GlobalConfig,
): Record<string, unknown> {
  return {
    audio_retention: vaultConfig.audio_retention ?? "keep",
    autoTranscribe: {
      // Per-vault effective value: this vault's own override wins; otherwise it
      // inherits the server default; otherwise true. Same ladder as
      // shouldAutoTranscribe, so the admin SPA shows what this vault will do.
      enabled:
        vaultConfig.auto_transcribe?.enabled
        ?? globalConfig.auto_transcribe?.enabled
        ?? true,
    },
  };
}

export function handleConfigSchema(): Response {
  return Response.json(buildConfigSchema(), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

export function handleConfig(
  vaultConfig: VaultConfig,
  globalConfig: GlobalConfig,
): Response {
  return Response.json(buildConfigValues(vaultConfig, globalConfig), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
