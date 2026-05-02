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
 * Fields currently described:
 *   - audio_retention: per-vault enum, backed by VaultConfig.audio_retention.
 *   - scribe_url:      env var SCRIBE_URL (read-only for now — there is no
 *                      yaml slot yet, so PUT won't come online until Phase 3).
 *   - scribe_token:    env var SCRIBE_TOKEN, writeOnly (never returned).
 *   - port:            GlobalConfig.port, exposed read-only so the hub can
 *                      display it without round-tripping through /health.
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
      scribe_url: {
        type: "string",
        format: "uri",
        title: "Scribe URL",
        description:
          "URL of the Scribe service for transcription. Empty disables the background worker. Currently sourced from the SCRIBE_URL env var; a PUT slot lands in Phase 3.",
        readOnly: true,
      },
      scribe_token: {
        type: "string",
        title: "Scribe auth token",
        description:
          "Optional bearer token for Scribe. Stored in the SCRIBE_TOKEN env var today. Write-only — never returned by GET.",
        writeOnly: true,
      },
      port: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        title: "HTTP port",
        description: "Port the vault server listens on. Set at init time; changing requires a restart.",
        readOnly: true,
      },
    },
  };
}

/**
 * Effective config values, with `writeOnly` fields stripped. `scribe_token` is
 * declared `writeOnly` and is never returned here, even when SCRIBE_TOKEN is
 * set in the environment.
 */
export function buildConfigValues(
  vaultConfig: VaultConfig,
  globalConfig: GlobalConfig,
  env: { SCRIBE_URL?: string | undefined } = process.env as { SCRIBE_URL?: string },
): Record<string, unknown> {
  return {
    audio_retention: vaultConfig.audio_retention ?? "keep",
    scribe_url: env.SCRIBE_URL ?? "",
    port: globalConfig.port,
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
