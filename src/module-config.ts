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
 *   - audio_retention:      per-vault enum, backed by VaultConfig.audio_retention.
 *   - port:                 GlobalConfig.port, exposed read-only.
 *   - autoTranscribe.*:     vault↔scribe handoff (vault#353, design 2026-05-21
 *                           Part 2). Three nested fields per design Q4:
 *       - enabled:          boolean toggle, default true when scribe is
 *                           reachable (persisted in
 *                           GlobalConfig.auto_transcribe.enabled). Default
 *                           flipped from off → on so installing scribe is
 *                           the only opt-in signal needed.
 *       - scribeUrl:        readOnly — resolved per-process from
 *                           `~/.parachute/services.json` via
 *                           `scribe-discovery.ts`. Operators can't point at an
 *                           arbitrary scribe; the discovery layer is the gate.
 *       - scribeBearer:     writeOnly — sourced from SCRIBE_AUTH_TOKEN env var.
 *                           Hub install generates one at first boot
 *                           (see scribe-env.ts:ensureScribeBearer); manual
 *                           rotation is via `parachute-vault config set`.
 *   - scribe_url / scribe_token (deprecated): kept under their legacy names
 *                           through one release for the hub admin SPA's prior
 *                           render path; new code should read autoTranscribe.*.
 */

import type { VaultConfig, GlobalConfig } from "./config.ts";
import { resolveScribeUrl } from "./scribe-discovery.ts";

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
              "Master toggle. Default on — audio uploads transcribe automatically when scribe is reachable. Set to false to disable. Global — persisted in `GlobalConfig.auto_transcribe.enabled` and applies to every vault on this server. Per-vault control is a future enhancement when multi-vault deployments need it.",
          },
          scribeUrl: {
            type: "string",
            format: "uri",
            readOnly: true,
            title: "Scribe URL",
            description:
              "URL of the scribe service. Auto-populated from `~/.parachute/services.json` at vault startup (or from the SCRIBE_URL env var when set). Read-only — operators can't point at an arbitrary scribe.",
          },
          scribeBearer: {
            type: "string",
            writeOnly: true,
            title: "Scribe auth bearer",
            description:
              "Shared bearer for the vault→scribe loopback contract. Hub install generates one at first boot. Write-only — never returned by GET.",
          },
        },
      },
      // Legacy aliases kept for back-compat with callers that read the
      // pre-vault#353 shape. New consumers should read `autoTranscribe.*`.
      scribe_url: {
        type: "string",
        format: "uri",
        title: "Scribe URL (deprecated alias)",
        description:
          "Legacy alias for `autoTranscribe.scribeUrl`. Will be removed in a future release.",
        readOnly: true,
        deprecated: true,
      },
      scribe_token: {
        type: "string",
        title: "Scribe auth token (deprecated alias)",
        description:
          "Legacy alias for `autoTranscribe.scribeBearer`. Will be removed in a future release.",
        writeOnly: true,
        deprecated: true,
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
 * Effective config values, with `writeOnly` fields stripped. `scribeBearer`
 * (and its legacy alias `scribe_token`) are declared `writeOnly` and never
 * returned, even when set in the environment.
 */
export function buildConfigValues(
  vaultConfig: VaultConfig,
  globalConfig: GlobalConfig,
  env: { SCRIBE_URL?: string | undefined } = process.env as { SCRIBE_URL?: string },
): Record<string, unknown> {
  // Resolve scribe URL through the discovery layer so the GET shape reflects
  // what the worker will actually use (services.json > SCRIBE_URL > unset).
  // Pass env through so the test harness's override is honored.
  const scribeUrl = resolveScribeUrl(env as NodeJS.ProcessEnv) ?? "";
  return {
    audio_retention: vaultConfig.audio_retention ?? "keep",
    autoTranscribe: {
      // Match shouldAutoTranscribe's `?? true` so the admin SPA displays
      // the same value runtime uses. An unset config row shows `true`
      // because that's what vault will actually do on the next audio upload.
      enabled: globalConfig.auto_transcribe?.enabled ?? true,
      scribeUrl,
    },
    // Legacy alias mirrors `autoTranscribe.scribeUrl` so hubs reading the
    // pre-vault#353 shape don't regress.
    scribe_url: scribeUrl,
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
