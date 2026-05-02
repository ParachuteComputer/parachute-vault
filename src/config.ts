/**
 * Configuration management for Parachute Vault.
 *
 * Directory layout:
 *   ~/.parachute/                 — ecosystem root (shared with sibling services)
 *     services.json               — CLI-owned manifest (services-manifest.ts)
 *     well-known/                 — CLI-owned (.well-known serving)
 *     vault/                      — everything vault owns
 *       .env
 *       config.yaml               — global server config
 *       start.sh / server-path    — daemon wrapper + pointer (daemon.ts)
 *       logs/
 *         vault.log / vault.err   — daemon stdout/stderr (matches
 *                                   `~/.parachute/<svc>/logs/<svc>.log` — the
 *                                   CLI lifecycle convention from PR #83)
 *       data/                     — per-vault SQLite data (Postgres-style:
 *                                   named `data/` rather than `vaults/` so it
 *                                   doesn't read as doubled)
 *         {name}/
 *           vault.db              — SQLite database
 *           vault.yaml            — per-vault config (description, api_keys, …)
 *           assets/               — per-vault attachments
 *
 * Pre-0.3 installs put vault state directly under `~/.parachute/`; on startup
 * we auto-migrate those paths into `vault/` (see `migrateFromLegacyLayout`).
 * Pre-filesystem-hygiene 0.3 installs put per-vault state under
 * `vault/vaults/` and daemon logs flat in `vault/`; those are moved into
 * `data/` and `logs/` by `migrateVaultInternalLayout` on startup.
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from "fs";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Paths
//
// Historical note: the exported `CONFIG_DIR`, `DATA_DIR`, etc. used to be
// `const` captured at module load. That made tests flaky: anything setting
// `process.env.PARACHUTE_HOME` after import would be ignored, and when `bun
// test` shares one process across files, whichever test loaded first froze
// the path for the rest. Internal read/write now go through the `*Path()`
// getters so `PARACHUTE_HOME` is re-read per call. The top-level constants
// are kept for backward-compat (other modules import them) and reflect the
// value at load time.
//
// `configDirPath()` is the ecosystem root — shared with sibling services
// (channel, scribe, …) and with the CLI's `services.json` + `well-known/`.
// `vaultHomePath()` is the vault-scoped subdir; all vault-owned files live
// under it.
// ---------------------------------------------------------------------------

function configDirPath(): string {
  return process.env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
}

function vaultHomePath(): string {
  return join(configDirPath(), "vault");
}

function dataDirPath(): string {
  return join(vaultHomePath(), "data");
}

function logsDirPath(): string {
  return join(vaultHomePath(), "logs");
}

function globalConfigPath(): string {
  return join(vaultHomePath(), "config.yaml");
}

function envFilePath(): string {
  return join(vaultHomePath(), ".env");
}

export const CONFIG_DIR = configDirPath();
export const VAULT_HOME = join(CONFIG_DIR, "vault");
export const DATA_DIR = join(VAULT_HOME, "data");
export const LOGS_DIR = join(VAULT_HOME, "logs");
export const GLOBAL_CONFIG_PATH = join(VAULT_HOME, "config.yaml");
export const ENV_PATH = join(VAULT_HOME, ".env");
export const LOG_PATH = join(LOGS_DIR, "vault.log");
export const ERR_PATH = join(LOGS_DIR, "vault.err");
export const DEFAULT_PORT = 1940;
export const ASSETS_DIR = join(VAULT_HOME, "assets");

// Filesystem sentinel for graceful shutdown. `parachute-vault stop` writes
// this file; the running server polls for it and exits cleanly when it
// appears. Resolved per-call so PARACHUTE_HOME overrides (tests, Docker)
// match between writer and reader.
export function stopSignalPath(): string {
  return join(vaultHomePath(), "stop.signal");
}

export function vaultDir(name: string): string {
  return join(dataDirPath(), name);
}

export function vaultDbPath(name: string): string {
  return join(vaultDir(name), "vault.db");
}

export function vaultConfigPath(name: string): string {
  return join(vaultDir(name), "vault.yaml");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyScope = "read" | "write";

export interface StoredKey {
  id: string;
  label: string;
  key_hash: string;
  scope: KeyScope;
  created_at: string;
  last_used_at?: string;
}

export interface TagFieldSchema {
  type: string;
  description?: string;
  enum?: string[];
}

export interface TagSchema {
  description?: string;
  fields?: Record<string, TagFieldSchema>;
}

export interface VaultConfig {
  name: string;
  description?: string;
  api_keys: StoredKey[];
  created_at: string;
  tag_schemas?: Record<string, TagSchema>;
  /** Tag name that marks a note as publicly viewable. Default: "published". */
  published_tag?: string;
  /**
   * What to do with the audio file on disk once the worker is done with it.
   * - `"keep"` (default): leave the file on disk.
   * - `"until_transcribed"`: unlink once the transcript lands successfully;
   *   on failure the file is kept so the user can retry or re-upload.
   * - `"never"`: unlink whenever the worker reaches a terminal state
   *   (`done` OR `failed`). Audio is discarded even if transcription
   *   failed — users who opt in accept that losing a bad transcription
   *   also loses the source audio.
   *
   * In every mode the attachment row (including any stored transcript) is
   * preserved; only the file on disk is affected.
   */
  audio_retention?: "keep" | "until_transcribed" | "never";
  /**
   * Transcription worker settings for this vault. Today only `context` is
   * honored — a list of context predicates the worker attaches to each
   * transcription POST so scribe sees person/project context alongside the
   * audio. Same shape as triggers' `action.include_context`.
   */
  transcription?: {
    context?: TriggerIncludeContext[];
  };
}

// ---------------------------------------------------------------------------
// Trigger configuration
// ---------------------------------------------------------------------------

export interface TriggerWhen {
  /** Note must have ALL of these tags. */
  tags?: string[];
  /** If true, note.content must be non-empty. If false, must be empty. */
  has_content?: boolean;
  /** Note.metadata must NOT have any of these keys set (non-null). */
  missing_metadata?: string[];
  /** Note.metadata must have ALL of these keys set (non-null). */
  has_metadata?: string[];
}

/**
 * How the trigger sends data to the webhook.
 *
 * - `"json"` (default): POST `{ trigger, event, note }` as JSON. Response is
 *   the standard webhook response `{ content?, metadata?, attachments? }`.
 * - `"attachment"`: Read the first audio attachment from the vault assets dir,
 *   POST it as multipart/form-data (`file` field). Response is `{ text }`.
 *   Used for Whisper-compatible transcription services.
 * - `"content"`: POST `{ model?, voice?, input: note.content }` as JSON.
 *   Response is binary audio bytes. Used for OpenAI-compatible TTS services.
 */
export type TriggerSendMode = "json" | "attachment" | "content";

/**
 * A single `include_context` entry — a query over the vault whose matching
 * notes are serialized as context entries and included alongside the primary
 * webhook payload. See `src/context.ts` for the fetch + serialization rules.
 */
export interface TriggerIncludeContext {
  /** Tag the note must carry. Required. */
  tag: string;
  /** If set, notes also carrying this tag are excluded. */
  exclude_tag?: string;
  /** Metadata keys to surface on each resulting entry. */
  include_metadata?: string[];
}

export interface TriggerAction {
  /** URL to POST the webhook payload to. */
  webhook: string;
  /** Timeout in ms for the webhook call. Default 60000. */
  timeout?: number;
  /** How to send data to the webhook. Default "json". */
  send?: TriggerSendMode;
  /**
   * If present, the trigger pre-fetches the matching vault notes at fire
   * time and attaches them as a `context` JSON part (send=attachment) or a
   * top-level `context` field (send=json). send=content ignores this.
   */
  include_context?: TriggerIncludeContext[];
}

export interface TriggerConfig {
  /** Human-readable name, also used as the metadata prefix for markers. */
  name: string;
  /** Which hook events to listen for. Default ["created", "updated"]. */
  events?: Array<"created" | "updated">;
  /** Predicate — all conditions must be true. */
  when: TriggerWhen;
  /** What to do when the predicate matches. */
  action: TriggerAction;
}

export interface GlobalConfig {
  port: number;
  default_vault?: string;
  api_keys?: StoredKey[];
  triggers?: TriggerConfig[];
  /** Bcrypt hash of the vault owner's password for OAuth consent. */
  owner_password_hash?: string;
  /** Base32-encoded TOTP secret for 2FA on OAuth consent. */
  totp_secret?: string;
  /** Bcrypt hashes of single-use backup codes for 2FA recovery. */
  backup_codes?: string[];
  /**
   * Controls the public `GET /vaults/list` endpoint.
   * - `"enabled"` (default): returns vault names (no other metadata).
   * - `"disabled"`: returns 404, hiding vault existence from unauthenticated
   *   callers.
   */
  discovery?: "enabled" | "disabled";
  /**
   * Whether `parachute-vault init` registers the daemon with launchd / systemd
   * (which then auto-starts on boot AND auto-restarts on crash). Defaults to
   * `true` (preserve historical behavior). When `false`, init skips daemon
   * registration AND removes any prior registration — for CI, dev sandboxes,
   * Docker/K8s setups, or environments where another supervisor manages the
   * process. The user is expected to run `parachute-vault serve` manually or
   * point their own supervisor at it.
   */
  autostart?: boolean;
  /** Backup configuration: schedule, retention, destinations. */
  backup?: BackupConfig;
}

// ---------------------------------------------------------------------------
// Backup configuration
// ---------------------------------------------------------------------------

export type BackupSchedule = "hourly" | "daily" | "weekly" | "manual";

/**
 * Discriminated union over destination kinds. For the MVP we ship `local`
 * only; `s3`, `rsync`, and `cloud` kinds will be added as additional variants
 * without breaking existing configs. Unknown kinds are preserved verbatim so
 * a forward-rolled config edited by a newer CLI isn't silently downgraded by
 * an older CLI rewriting the file.
 */
export interface LocalBackupDestination {
  kind: "local";
  /** Absolute or `~/`-prefixed path. `~/` is expanded at use-time. */
  path: string;
}

export type BackupDestination = LocalBackupDestination;

/**
 * Tiered (grandfather-father-son) retention policy. After each backup we keep
 * the union of four tier queries:
 *
 *   daily   — the N most recent snapshots (unconditionally).
 *   weekly  — one snapshot per ISO week, for the N most recent such weeks.
 *   monthly — one snapshot per calendar month, for the N most recent months.
 *   yearly  — one snapshot per calendar year; `null` means keep every year
 *             (never prune by age — the long-tail archive).
 *
 * A tier set to 0 is disabled (it contributes no keepers, but the other tiers
 * still apply). All bucketing uses the local timezone so calendar alignment
 * matches the user's expectations, not UTC.
 */
export interface RetentionPolicy {
  /** Keep the last N daily snapshots. 0 disables the daily tier. */
  daily: number;
  /** Keep the last snapshot from each of the last N ISO weeks. 0 disables. */
  weekly: number;
  /** Keep the last snapshot from each of the last N months. 0 disables. */
  monthly: number;
  /**
   * Keep the last snapshot from each of the last N years. `null` or `undefined`
   * means unbounded — keep one snapshot per year, forever, across the full
   * history. 0 disables the yearly tier entirely.
   */
  yearly: number | null;
}

export interface BackupConfig {
  /** How often the scheduler fires. "manual" = scheduler is not registered. */
  schedule: BackupSchedule;
  /** Tiered retention policy — grandfather/father/son. */
  retention: RetentionPolicy;
  /** Pluggable destinations. Runs in order; a destination error logs + continues. */
  destinations: BackupDestination[];
}

export function defaultRetentionPolicy(): RetentionPolicy {
  // Defaults balance "I want to roll back yesterday's accidental delete"
  // against "my iCloud folder shouldn't blow up in a year." The yearly tier
  // is unbounded by default — the whole point of the tiered policy is that
  // one-per-year is cheap forever.
  return { daily: 7, weekly: 4, monthly: 12, yearly: null };
}

export function defaultBackupConfig(): BackupConfig {
  return {
    schedule: "manual",
    retention: defaultRetentionPolicy(),
    destinations: [],
  };
}

// ---------------------------------------------------------------------------
// YAML helpers (minimal, no deps)
// ---------------------------------------------------------------------------

function serializeVaultConfig(config: VaultConfig): string {
  const lines: string[] = [];
  lines.push(`name: ${config.name}`);
  if (config.description) {
    lines.push(`description: |`);
    for (const line of config.description.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  lines.push(`created_at: "${config.created_at}"`);
  if (config.published_tag) {
    lines.push(`published_tag: ${config.published_tag}`);
  }
  if (config.audio_retention) {
    lines.push(`audio_retention: ${config.audio_retention}`);
  }

  if (config.transcription?.context?.length) {
    lines.push("transcription:");
    lines.push("  context:");
    for (const entry of config.transcription.context) {
      lines.push(`    - tag: ${entry.tag}`);
      if (entry.exclude_tag) {
        lines.push(`      exclude_tag: ${entry.exclude_tag}`);
      }
      if (entry.include_metadata?.length) {
        lines.push(`      include_metadata: [${entry.include_metadata.map((v) => `"${v}"`).join(", ")}]`);
      }
    }
  }

  lines.push("api_keys:");
  for (const key of config.api_keys) {
    lines.push(`  - id: ${key.id}`);
    lines.push(`    label: ${key.label}`);
    lines.push(`    scope: ${key.scope ?? "write"}`);
    lines.push(`    key_hash: ${key.key_hash}`);
    lines.push(`    created_at: "${key.created_at}"`);
    if (key.last_used_at) {
      lines.push(`    last_used_at: "${key.last_used_at}"`);
    }
  }

  if (config.tag_schemas && Object.keys(config.tag_schemas).length > 0) {
    lines.push("tag_schemas:");
    for (const [tag, schema] of Object.entries(config.tag_schemas)) {
      lines.push(`  ${tag}:`);
      if (schema.description) {
        lines.push(`    description: "${schema.description}"`);
      }
      if (schema.fields && Object.keys(schema.fields).length > 0) {
        lines.push("    fields:");
        for (const [field, fieldSchema] of Object.entries(schema.fields)) {
          lines.push(`      ${field}:`);
          lines.push(`        type: ${fieldSchema.type}`);
          if (fieldSchema.description) {
            lines.push(`        description: "${fieldSchema.description}"`);
          }
          if (fieldSchema.enum) {
            lines.push(`        enum: [${fieldSchema.enum.map((v) => `"${v}"`).join(", ")}]`);
          }
        }
      }
    }
  }

  return lines.join("\n") + "\n";
}

function parseVaultConfig(yaml: string, name: string): VaultConfig {
  const config: VaultConfig = {
    name,
    api_keys: [],
    created_at: new Date().toISOString(),
  };

  const nameMatch = yaml.match(/^name:\s*(.+)/m);
  if (nameMatch) config.name = nameMatch[1].trim();

  const createdMatch = yaml.match(/^created_at:\s*"?([^"\n]+)"?/m);
  if (createdMatch) config.created_at = createdMatch[1];

  const pubTagMatch = yaml.match(/^published_tag:\s*(\S+)/m);
  if (pubTagMatch) config.published_tag = pubTagMatch[1];

  const retentionMatch = yaml.match(/^audio_retention:\s*(\S+)/m);
  if (retentionMatch) {
    const v = retentionMatch[1];
    if (v === "keep" || v === "until_transcribed" || v === "never") config.audio_retention = v;
  }

  // Parse description (block scalar)
  const descMatch = yaml.match(/^description:\s*\|\s*\n((?:\s{2}.+\n?)+)/m);
  if (descMatch) {
    config.description = descMatch[1]
      .split("\n")
      .map((l) => l.replace(/^\s{2}/, ""))
      .join("\n")
      .trim();
  } else {
    const descSimple = yaml.match(/^description:\s*(.+)/m);
    if (descSimple) config.description = descSimple[1].trim().replace(/^"(.*)"$/, "$1");
  }

  // Parse api_keys
  const keyBlocks = yaml.split(/\n\s+-\s+id:\s+/).slice(1);
  for (const block of keyBlocks) {
    const idMatch = block.match(/^(\S+)/);
    const labelMatch = block.match(/label:\s*(.+)/);
    const scopeMatch = block.match(/scope:\s*(\S+)/);
    const hashMatch = block.match(/key_hash:\s*(\S+)/);
    const createdAtMatch = block.match(/created_at:\s*"?([^"\n]+)"?/);
    const lastUsedMatch = block.match(/last_used_at:\s*"?([^"\n]+)"?/);

    if (idMatch && hashMatch) {
      config.api_keys.push({
        id: idMatch[1],
        label: (labelMatch?.[1] ?? "default").trim(),
        scope: (scopeMatch?.[1] as KeyScope) ?? "write",
        key_hash: hashMatch[1],
        created_at: createdAtMatch?.[1] ?? new Date().toISOString(),
        last_used_at: lastUsedMatch?.[1],
      });
    }
  }

  // Parse tag_schemas
  config.tag_schemas = parseTagSchemas(yaml);

  // Parse transcription.context (same shape as triggers' include_context)
  const transcriptionContext = parseTranscriptionContext(yaml);
  if (transcriptionContext) {
    config.transcription = { context: transcriptionContext };
  }

  return config;
}

/**
 * Parse the `transcription: { context: [...] }` section from vault.yaml.
 * Shape matches triggers' `action.include_context` so callers can reuse the
 * same `ContextPredicate` helpers from src/context.ts.
 */
function parseTranscriptionContext(yaml: string): TriggerIncludeContext[] | undefined {
  const startMatch = yaml.match(/^transcription:\s*$/m);
  if (!startMatch) return undefined;

  const startIdx = (startMatch.index ?? 0) + startMatch[0].length;
  const lines = yaml.slice(startIdx).split("\n");

  const entries: TriggerIncludeContext[] = [];
  let inContext = false;
  let current: TriggerIncludeContext | null = null;

  const pushCurrent = () => {
    if (current && current.tag) entries.push(current);
    current = null;
  };

  for (const line of lines) {
    // Stop at next top-level key.
    if (line.match(/^\S/) && line.trim().length > 0) break;
    if (line.trim().length === 0) continue;

    const trimmed = line.trim();

    if (trimmed === "context:") { inContext = true; continue; }
    if (!inContext) continue;

    const itemStart = trimmed.match(/^-\s+(\w+):\s*(.*)$/);
    if (itemStart) {
      pushCurrent();
      current = { tag: "" };
      applyContextField(current, itemStart[1], itemStart[2]);
      continue;
    }
    const fieldMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (fieldMatch && current) {
      applyContextField(current, fieldMatch[1], fieldMatch[2]);
      continue;
    }
  }

  pushCurrent();
  return entries.length > 0 ? entries : undefined;
}

/**
 * Parse the tag_schemas section from vault.yaml.
 * Uses line-by-line indent tracking since the main parser is hand-rolled.
 */
function parseTagSchemas(yaml: string): Record<string, TagSchema> | undefined {
  const startMatch = yaml.match(/^tag_schemas:\s*$/m);
  if (!startMatch) return undefined;

  const startIdx = (startMatch.index ?? 0) + startMatch[0].length;
  const lines = yaml.slice(startIdx).split("\n");

  const schemas: Record<string, TagSchema> = {};
  let currentTag: string | null = null;
  let currentField: string | null = null;

  for (const line of lines) {
    // Stop at next top-level key (no indent)
    if (line.match(/^\S/) && line.trim().length > 0) break;
    if (line.trim().length === 0) continue;

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

    if (indent === 2) {
      // Tag name (e.g., "  person:")
      const tagMatch = line.match(/^\s{2}(\S+):\s*$/);
      if (tagMatch) {
        currentTag = tagMatch[1];
        currentField = null;
        schemas[currentTag] = {};
      }
    } else if (indent === 4 && currentTag) {
      // Tag-level property (description, fields:)
      const descMatch = line.match(/^\s{4}description:\s*"?([^"]*)"?\s*$/);
      if (descMatch) {
        schemas[currentTag].description = descMatch[1];
        continue;
      }
      const fieldsMatch = line.match(/^\s{4}fields:\s*$/);
      if (fieldsMatch) {
        schemas[currentTag].fields = schemas[currentTag].fields ?? {};
        currentField = null;
      }
    } else if (indent === 6 && currentTag && schemas[currentTag].fields !== undefined) {
      // Field name (e.g., "      first_appeared:")
      const fieldMatch = line.match(/^\s{6}(\S+):\s*$/);
      if (fieldMatch) {
        currentField = fieldMatch[1];
        schemas[currentTag].fields![currentField] = { type: "string" };
      }
    } else if (indent === 8 && currentTag && currentField && schemas[currentTag].fields) {
      // Field property (type, description, enum)
      const typeMatch = line.match(/^\s{8}type:\s*(\S+)/);
      if (typeMatch) {
        schemas[currentTag].fields![currentField].type = typeMatch[1];
        continue;
      }
      const fdescMatch = line.match(/^\s{8}description:\s*"?([^"]*)"?\s*$/);
      if (fdescMatch) {
        schemas[currentTag].fields![currentField].description = fdescMatch[1];
        continue;
      }
      const enumMatch = line.match(/^\s{8}enum:\s*\[([^\]]*)\]/);
      if (enumMatch) {
        schemas[currentTag].fields![currentField].enum = enumMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/^"(.*)"$/, "$1"));
      }
    }
  }

  return Object.keys(schemas).length > 0 ? schemas : undefined;
}

// ---------------------------------------------------------------------------
// Trigger YAML parsing
// ---------------------------------------------------------------------------

function parseYamlList(val: string): string[] {
  // Parse "[a, b, c]" → ["a", "b", "c"]
  const inner = val.replace(/^\[/, "").replace(/\]$/, "");
  return inner.split(",").map((s) => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

/**
 * Apply a single "key: value" line to the include_context item being built.
 * Shared between triggers and vault-config transcription.context (same shape).
 */
function applyContextField(
  item: TriggerIncludeContext,
  key: string,
  raw: string,
): void {
  const value = raw.trim();
  if (key === "tag") { item.tag = value.replace(/^"(.*)"$/, "$1"); return; }
  if (key === "exclude_tag") { item.exclude_tag = value.replace(/^"(.*)"$/, "$1"); return; }
  if (key === "include_metadata") {
    const listMatch = value.match(/^\[([^\]]*)\]/);
    if (listMatch) item.include_metadata = parseYamlList(listMatch[1]);
    return;
  }
}

function parseTriggers(yaml: string): TriggerConfig[] | undefined {
  const startMatch = yaml.match(/^triggers:\s*$/m);
  if (!startMatch) return undefined;

  const startIdx = (startMatch.index ?? 0) + startMatch[0].length;
  const lines = yaml.slice(startIdx).split("\n");

  const triggers: TriggerConfig[] = [];
  let current: Partial<TriggerConfig> | null = null;
  // Track which section we're in by the last seen section header
  let section: "top" | "when" | "action" | "include_context" = "top";
  // When inside include_context, track the item currently being parsed.
  let currentContext: TriggerIncludeContext | null = null;

  const pushContextItem = () => {
    if (currentContext && current?.action) {
      current.action.include_context = current.action.include_context ?? [];
      current.action.include_context.push(currentContext);
    }
    currentContext = null;
  };

  for (const line of lines) {
    // Stop at next top-level key
    if (line.match(/^\S/) && line.trim().length > 0) break;
    if (line.trim().length === 0) continue;

    const trimmed = line.trim();

    // New trigger item: "- name: ..."
    const nameMatch = trimmed.match(/^-\s+name:\s*(.+)/);
    if (nameMatch) {
      pushContextItem();
      if (current?.name) {
        if (current.action?.webhook) {
          triggers.push(current as TriggerConfig);
        } else {
          console.warn(`[config] trigger "${current.name}" has no webhook URL — skipping`);
        }
      }
      current = { name: nameMatch[1].trim(), when: {}, action: undefined as unknown as TriggerAction };
      section = "top";
      continue;
    }

    if (!current) continue;

    // Section headers — detect by key name regardless of indent
    if (trimmed === "when:") { pushContextItem(); section = "when"; continue; }
    if (trimmed === "action:") { pushContextItem(); section = "action"; continue; }
    if (trimmed === "include_context:") {
      // Entering the nested list under action:.
      if (!current.action) current.action = { webhook: "" } as TriggerAction;
      current.action.include_context = current.action.include_context ?? [];
      section = "include_context";
      currentContext = null;
      continue;
    }

    // Top-level trigger field
    const eventsMatch = trimmed.match(/^events:\s*\[([^\]]*)\]/);
    if (eventsMatch) {
      current.events = parseYamlList(eventsMatch[1]) as Array<"created" | "updated">;
      continue;
    }

    // When fields
    if (section === "when") {
      const tagsMatch = trimmed.match(/^tags:\s*\[([^\]]*)\]/);
      if (tagsMatch) { current.when!.tags = parseYamlList(tagsMatch[1]); continue; }
      const hasContentMatch = trimmed.match(/^has_content:\s*(true|false)/);
      if (hasContentMatch) { current.when!.has_content = hasContentMatch[1] === "true"; continue; }
      const missingMetaMatch = trimmed.match(/^missing_metadata:\s*\[([^\]]*)\]/);
      if (missingMetaMatch) { current.when!.missing_metadata = parseYamlList(missingMetaMatch[1]); continue; }
      const hasMetaMatch = trimmed.match(/^has_metadata:\s*\[([^\]]*)\]/);
      if (hasMetaMatch) { current.when!.has_metadata = parseYamlList(hasMetaMatch[1]); continue; }
    }

    // Action fields
    if (section === "action") {
      const webhookMatch = trimmed.match(/^webhook:\s*(.+)/);
      if (webhookMatch) {
        current.action = { ...(current.action ?? {}), webhook: webhookMatch[1].trim() } as TriggerAction;
        continue;
      }
      const timeoutMatch = trimmed.match(/^timeout:\s*(\d+)/);
      if (timeoutMatch && current.action) {
        current.action.timeout = parseInt(timeoutMatch[1], 10);
        continue;
      }
      const sendMatch = trimmed.match(/^send:\s*(\S+)/);
      if (sendMatch && current.action) {
        current.action.send = sendMatch[1] as TriggerAction["send"];
        continue;
      }
    }

    // include_context list items: "- tag: X" starts a new item; subsequent
    // indented lines set fields on it.
    if (section === "include_context") {
      const itemStart = trimmed.match(/^-\s+(\w+):\s*(.*)$/);
      if (itemStart) {
        pushContextItem();
        currentContext = { tag: "" };
        applyContextField(currentContext, itemStart[1], itemStart[2]);
        continue;
      }
      const fieldMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (fieldMatch && currentContext) {
        applyContextField(currentContext, fieldMatch[1], fieldMatch[2]);
        continue;
      }
    }
  }

  pushContextItem();

  // Push the last trigger
  if (current?.name) {
    if (current.action?.webhook) {
      triggers.push(current as TriggerConfig);
    } else {
      console.warn(`[config] trigger "${current.name}" has no webhook URL — skipping`);
    }
  }

  return triggers.length > 0 ? triggers : undefined;
}

// ---------------------------------------------------------------------------
// Backup YAML parsing / serialization
// ---------------------------------------------------------------------------

/**
 * Parse the `backup:` section. Returns undefined if no section is present so
 * callers can tell "user hasn't configured backups" apart from "user asked
 * for the default (schedule: manual, empty destinations)."
 *
 * Shape:
 *   backup:
 *     schedule: daily
 *     retention:
 *       daily: 7
 *       weekly: 4
 *       monthly: 12
 *       yearly: null       # or omit for unbounded; 0 disables the tier
 *     destinations:
 *       - kind: local
 *         path: ~/Library/Mobile Documents/com~apple~CloudDocs/parachute-backups
 */
function parseBackup(yaml: string): BackupConfig | undefined {
  const startMatch = yaml.match(/^backup:\s*$/m);
  if (!startMatch) return undefined;

  const startIdx = (startMatch.index ?? 0) + startMatch[0].length;
  const lines = yaml.slice(startIdx).split("\n");

  const backup: BackupConfig = defaultBackupConfig();
  let section: "top" | "retention" | "destinations" = "top";
  let currentDest: Partial<BackupDestination> & { kind?: string } = {};
  let hasDest = false;
  // Track whether the user supplied a retention block at all. If they did,
  // we start from a clean slate (all tiers default 0, yearly null) so that
  // an explicit partial policy overrides defaults rather than merging with
  // them — predictable semantics beat magical merging.
  let retentionSeen = false;

  const pushDest = () => {
    if (!hasDest) return;
    // For the MVP we only ship `local`. Unknown/malformed destination kinds
    // are skipped rather than rejected: a forward-rolled config authored by
    // a newer CLI mustn't break backup for the features this CLI does
    // understand. The backup command itself warns about skipped kinds.
    if (currentDest.kind === "local" && typeof currentDest.path === "string") {
      backup.destinations.push({ kind: "local", path: currentDest.path });
    }
    currentDest = {};
    hasDest = false;
  };

  for (const line of lines) {
    // Stop at next top-level key.
    if (line.match(/^\S/) && line.trim().length > 0) break;
    if (line.trim().length === 0) continue;

    const trimmed = line.trim();

    // A 2-space-indented line starting a new sub-section closes the previous
    // section. The only 2-space keys under `backup:` today are `schedule`,
    // `retention`, and `destinations`, so we key off indent depth here.
    const indent = line.match(/^ */)?.[0].length ?? 0;

    if (indent === 2) {
      if (/^retention:\s*$/.test(trimmed)) {
        section = "retention";
        retentionSeen = true;
        // Zero-out tiers so partially specified blocks don't silently merge
        // with defaults in surprising ways.
        backup.retention = { daily: 0, weekly: 0, monthly: 0, yearly: 0 };
        continue;
      }
      if (/^destinations:\s*$/.test(trimmed)) {
        pushDest();
        section = "destinations";
        continue;
      }
      // Any other 2-space top field terminates the current sub-section.
      if (section !== "top") {
        pushDest();
        section = "top";
      }
    }

    if (section === "top" && indent === 2) {
      const schedMatch = trimmed.match(/^schedule:\s*(\S+)/);
      if (schedMatch) {
        const v = schedMatch[1];
        if (v === "hourly" || v === "daily" || v === "weekly" || v === "manual") {
          backup.schedule = v;
        }
        continue;
      }
    }

    if (section === "retention" && indent === 4) {
      const tierMatch = trimmed.match(/^(daily|weekly|monthly|yearly):\s*(\S+)/);
      if (tierMatch) {
        const tier = tierMatch[1] as keyof RetentionPolicy;
        const raw = tierMatch[2].trim();
        // "null" / "~" / "unbounded" all mean "keep every year" for the
        // yearly tier. For the other tiers they'd be meaningless; we
        // silently treat them as disabled (0) rather than erroring.
        if (raw === "null" || raw === "~" || raw === "unbounded") {
          if (tier === "yearly") backup.retention.yearly = null;
          // Other tiers stay at 0.
          continue;
        }
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 0) {
          backup.retention[tier] = n as never;
        }
        continue;
      }
    }

    if (section === "destinations") {
      // Start of a new list item: "- kind: local" or just "- kind:"
      const itemMatch = trimmed.match(/^-\s+(\w+):\s*(.*)$/);
      if (itemMatch) {
        pushDest();
        hasDest = true;
        currentDest = {};
        (currentDest as Record<string, string>)[itemMatch[1]] = itemMatch[2].trim();
        continue;
      }
      // Continuation line inside the current list item.
      const fieldMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (fieldMatch && hasDest) {
        (currentDest as Record<string, string>)[fieldMatch[1]] = fieldMatch[2].trim();
        continue;
      }
    }
  }
  pushDest();

  // If the user left retention out entirely, fall back to the shipped default.
  if (!retentionSeen) {
    backup.retention = defaultRetentionPolicy();
  }

  return backup;
}

function serializeBackup(backup: BackupConfig): string[] {
  const lines: string[] = [];
  lines.push("backup:");
  lines.push(`  schedule: ${backup.schedule}`);
  lines.push("  retention:");
  lines.push(`    daily: ${backup.retention.daily}`);
  lines.push(`    weekly: ${backup.retention.weekly}`);
  lines.push(`    monthly: ${backup.retention.monthly}`);
  // `null` is serialized as the YAML literal `null` so round-trips preserve
  // "unbounded." Numbers render as-is, including 0 (disabled).
  lines.push(`    yearly: ${backup.retention.yearly === null ? "null" : backup.retention.yearly}`);
  if (backup.destinations.length > 0) {
    lines.push("  destinations:");
    for (const dest of backup.destinations) {
      lines.push(`    - kind: ${dest.kind}`);
      // Paths may contain ~, spaces, and `.` — the whole line being on its
      // own key line means we don't need to quote unless the value begins
      // with a YAML-special character. Quoting defensively keeps the
      // hand-rolled parser happy under future path-with-colons pressure.
      if ("path" in dest) {
        const needsQuote = /[:#]/.test(dest.path);
        lines.push(`      path: ${needsQuote ? `"${dest.path}"` : dest.path}`);
      }
    }
  } else {
    lines.push("  destinations: []");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Directory management
// ---------------------------------------------------------------------------

export function ensureConfigDirSync(): void {
  mkdirSync(configDirPath(), { recursive: true });
  migrateFromLegacyLayout();
  mkdirSync(vaultHomePath(), { recursive: true });
  migrateVaultInternalLayout();
  mkdirSync(dataDirPath(), { recursive: true });
  mkdirSync(logsDirPath(), { recursive: true });
}

/**
 * Move vault-owned state from the legacy root layout (`~/.parachute/.env`,
 * `~/.parachute/vaults/`, …) into `~/.parachute/vault/`. Fresh installs see
 * nothing to migrate and exit quickly; double-calls are a no-op.
 *
 * Per-path move policy: if a legacy path exists AND the target under `vault/`
 * does not, rename the legacy path into place. If both exist, the target
 * wins — we don't overwrite a user's manually-migrated state — and the
 * legacy path is left alone with a warning logged. Each moved path is
 * announced on stdout so users notice when vault relocates their files.
 */
export function migrateFromLegacyLayout(): void {
  const root = configDirPath();
  const dest = vaultHomePath();

  // Pre-0.3 installs targeted flat names at root (`vaults`, `vault.log`);
  // we now land those directly under their current canonical subdirs
  // (`data/`, `logs/`) so upgrading users skip the intermediate shape that
  // `migrateVaultInternalLayout` would otherwise correct on a second pass.
  const candidates: Array<[string, string]> = [
    [".env", ".env"],
    ["config.yaml", "config.yaml"],
    ["vault.log", "logs/vault.log"],
    ["vault.err", "logs/vault.err"],
    ["start.sh", "start.sh"],
    ["server-path", "server-path"],
    ["vaults", "data"],
    ["assets", "assets"],
  ];

  const present: Array<[string, string]> = [];
  for (const [from, to] of candidates) {
    const src = join(root, from);
    if (existsSync(src)) present.push([from, to]);
  }
  if (present.length === 0) return;

  mkdirSync(dest, { recursive: true });

  const moved: string[] = [];
  const skipped: string[] = [];
  for (const [from, to] of present) {
    const src = join(root, from);
    const dst = join(dest, to);
    if (existsSync(dst)) {
      skipped.push(from);
      continue;
    }
    // Target may live in a subdir (logs/, data/); ensure parent exists
    // before renameSync, which is strict about target parent existence.
    const parent = join(dst, "..");
    mkdirSync(parent, { recursive: true });
    try {
      renameSync(src, dst);
      moved.push(from);
    } catch (err) {
      console.warn(formatMigrationFailure(src, dst, err));
    }
  }

  // Log to stderr — migration is operational/audit output, and keeping
  // stdout clean lets callers that pipe stdout (the CLI, spawned child
  // processes, JSON-consuming shells) run without interference.
  if (moved.length > 0) {
    console.error(
      `[parachute-vault] migrated to new layout: moved ${moved.map((p) => join(root, p)).join(", ")} → ${dest}/`,
    );
  }
  if (skipped.length > 0) {
    console.error(
      `[parachute-vault] left legacy paths in place (target already exists under vault/): ${skipped.map((p) => join(root, p)).join(", ")}. Remove the legacy copies once you've confirmed the vault/ copies are current.`,
    );
  }
}

/**
 * Format a migration-rename failure warning. If the underlying error is
 * EXDEV (cross-device rename — `PARACHUTE_HOME` straddles a mount, a common
 * shape in Docker with bind-mounts or multi-disk dev setups), the raw error
 * message is opaque. Surface the likely cause and note that vault continues
 * on the legacy layout rather than exiting.
 */
export function formatMigrationFailure(src: string, dst: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  if (code === "EXDEV") {
    return `[parachute-vault] migration failed for ${src} → ${dst}: likely because PARACHUTE_HOME crosses a mount boundary (EXDEV). Vault will continue on the legacy layout; move the file manually to complete the upgrade.`;
  }
  return `[parachute-vault] failed to migrate ${src} → ${dst}: ${msg}`;
}

/**
 * Tidies the layout *inside* `vault/` for installs upgrading across the
 * filesystem-hygiene refactor:
 *
 *   vault/vaults/   → vault/data/         (matches Postgres/Redis convention;
 *                                          avoids the doubled "vault/vaults")
 *   vault/vault.log → vault/logs/vault.log
 *   vault/vault.err → vault/logs/vault.err
 *
 * Same target-wins, idempotent, rename-only policy as
 * `migrateFromLegacyLayout`. Runs every boot — once the moves have
 * happened, subsequent calls are pure existence checks that exit fast.
 *
 * If `vault/` doesn't exist yet (never booted before), this returns
 * immediately — `ensureConfigDirSync` creates the fresh layout right after.
 */
export function migrateVaultInternalLayout(): void {
  const vaultHome = vaultHomePath();
  if (!existsSync(vaultHome)) return;

  // vault/vaults/ → vault/data/
  const legacyData = join(vaultHome, "vaults");
  const newData = dataDirPath();
  if (existsSync(legacyData)) {
    if (existsSync(newData)) {
      console.error(
        `[parachute-vault] both ${legacyData}/ and ${newData}/ exist — using data/, leaving vaults/ in place. Remove the legacy copy once you've confirmed data/ is current.`,
      );
    } else {
      try {
        renameSync(legacyData, newData);
        console.error(`[parachute-vault] migrated ${legacyData}/ → ${newData}/`);
      } catch (err) {
        console.warn(formatMigrationFailure(`${legacyData}/`, `${newData}/`, err));
      }
    }
  }

  // vault/{vault.log,vault.err} → vault/logs/{vault.log,vault.err}
  const logsDir = logsDirPath();
  const logsMoved: string[] = [];
  const logsSkipped: string[] = [];
  for (const name of ["vault.log", "vault.err"]) {
    const src = join(vaultHome, name);
    if (!existsSync(src)) continue;
    const dst = join(logsDir, name);
    if (existsSync(dst)) {
      logsSkipped.push(name);
      continue;
    }
    mkdirSync(logsDir, { recursive: true });
    try {
      renameSync(src, dst);
      logsMoved.push(name);
    } catch (err) {
      console.warn(formatMigrationFailure(src, dst, err));
    }
  }
  if (logsMoved.length > 0) {
    console.error(
      `[parachute-vault] migrated ${logsMoved.map((n) => join(vaultHome, n)).join(", ")} → ${logsDir}/`,
    );
  }
  if (logsSkipped.length > 0) {
    console.error(
      `[parachute-vault] left legacy log files in place (target already exists under logs/): ${logsSkipped.map((n) => join(vaultHome, n)).join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Global config
// ---------------------------------------------------------------------------

export function readGlobalConfig(): GlobalConfig {
  try {
    const gcPath = globalConfigPath();
    if (existsSync(gcPath)) {
      const yaml = readFileSync(gcPath, "utf-8");
      const portMatch = yaml.match(/^port:\s*(\d+)/m);
      const defaultVaultMatch = yaml.match(/^default_vault:\s*(\S+)/m);
      const passwordHashMatch = yaml.match(/^owner_password_hash:\s*"([^"]+)"/m);
      const totpSecretMatch = yaml.match(/^totp_secret:\s*"([^"]+)"/m);
      const discoveryMatch = yaml.match(/^discovery:\s*(enabled|disabled)/m);
      const autostartMatch = yaml.match(/^autostart:\s*(true|false)/m);
      const config: GlobalConfig = {
        port: portMatch ? parseInt(portMatch[1], 10) : DEFAULT_PORT,
        default_vault: defaultVaultMatch?.[1],
        owner_password_hash: passwordHashMatch?.[1],
        totp_secret: totpSecretMatch?.[1],
      };
      if (discoveryMatch) {
        config.discovery = discoveryMatch[1] as "enabled" | "disabled";
      }
      if (autostartMatch) {
        config.autostart = autostartMatch[1] === "true";
      }

      // Parse backup_codes: a YAML list of quoted bcrypt hashes under
      //   backup_codes:
      //     - "hash1"
      //     - "hash2"
      const backupStart = yaml.match(/^backup_codes:\s*$/m);
      if (backupStart) {
        const after = yaml.slice((backupStart.index ?? 0) + backupStart[0].length);
        const lines = after.split("\n");
        const codes: string[] = [];
        for (const line of lines) {
          if (line.match(/^\S/) && line.trim().length > 0) break; // next top-level key
          const m = line.match(/^\s+-\s+"([^"]+)"/);
          if (m) codes.push(m[1]);
        }
        if (codes.length > 0) config.backup_codes = codes;
      }

      // Parse global api_keys
      const keyBlocks = yaml.split(/\n\s+-\s+id:\s+/).slice(1);
      if (keyBlocks.length > 0) {
        config.api_keys = [];
        for (const block of keyBlocks) {
          const idMatch = block.match(/^(\S+)/);
          const labelMatch = block.match(/label:\s*(.+)/);
          const scopeMatch = block.match(/scope:\s*(\S+)/);
          const hashMatch = block.match(/key_hash:\s*(\S+)/);
          const createdAtMatch = block.match(/created_at:\s*"?([^"\n]+)"?/);
          const lastUsedMatch = block.match(/last_used_at:\s*"?([^"\n]+)"?/);
          if (idMatch && hashMatch) {
            config.api_keys.push({
              id: idMatch[1],
              label: (labelMatch?.[1] ?? "default").trim(),
              scope: (scopeMatch?.[1] as KeyScope) ?? "write",
              key_hash: hashMatch[1],
              created_at: createdAtMatch?.[1] ?? new Date().toISOString(),
              last_used_at: lastUsedMatch?.[1],
            });
          }
        }
      }

      // Parse triggers
      config.triggers = parseTriggers(yaml);

      // Parse backup section
      config.backup = parseBackup(yaml);

      return config;
    }
  } catch {}
  return { port: DEFAULT_PORT };
}

export function writeGlobalConfig(config: GlobalConfig): void {
  ensureConfigDirSync();
  const lines = [`port: ${config.port}`];
  if (config.default_vault) lines.push(`default_vault: ${config.default_vault}`);
  if (config.discovery) lines.push(`discovery: ${config.discovery}`);
  if (config.autostart !== undefined) lines.push(`autostart: ${config.autostart}`);
  if (config.owner_password_hash) {
    lines.push(`owner_password_hash: "${config.owner_password_hash}"`);
  }
  if (config.totp_secret) {
    lines.push(`totp_secret: "${config.totp_secret}"`);
  }
  if (config.backup_codes && config.backup_codes.length > 0) {
    lines.push("backup_codes:");
    for (const hash of config.backup_codes) {
      lines.push(`  - "${hash}"`);
    }
  }

  if (config.api_keys && config.api_keys.length > 0) {
    lines.push("api_keys:");
    for (const key of config.api_keys) {
      lines.push(`  - id: ${key.id}`);
      lines.push(`    label: ${key.label}`);
      lines.push(`    scope: ${key.scope ?? "write"}`);
      lines.push(`    key_hash: ${key.key_hash}`);
      lines.push(`    created_at: "${key.created_at}"`);
      if (key.last_used_at) {
        lines.push(`    last_used_at: "${key.last_used_at}"`);
      }
    }
  }

  if (config.triggers && config.triggers.length > 0) {
    lines.push("triggers:");
    for (const trigger of config.triggers) {
      lines.push(`  - name: ${trigger.name}`);
      if (trigger.events) {
        lines.push(`    events: [${trigger.events.join(", ")}]`);
      }
      lines.push("    when:");
      if (trigger.when.tags?.length) {
        lines.push(`      tags: [${trigger.when.tags.join(", ")}]`);
      }
      if (trigger.when.has_content !== undefined) {
        lines.push(`      has_content: ${trigger.when.has_content}`);
      }
      if (trigger.when.missing_metadata?.length) {
        lines.push(`      missing_metadata: [${trigger.when.missing_metadata.join(", ")}]`);
      }
      if (trigger.when.has_metadata?.length) {
        lines.push(`      has_metadata: [${trigger.when.has_metadata.join(", ")}]`);
      }
      lines.push("    action:");
      lines.push(`      webhook: ${trigger.action.webhook}`);
      if (trigger.action.send && trigger.action.send !== "json") {
        lines.push(`      send: ${trigger.action.send}`);
      }
      if (trigger.action.timeout) {
        lines.push(`      timeout: ${trigger.action.timeout}`);
      }
      if (trigger.action.include_context?.length) {
        lines.push("      include_context:");
        for (const entry of trigger.action.include_context) {
          lines.push(`        - tag: ${entry.tag}`);
          if (entry.exclude_tag) {
            lines.push(`          exclude_tag: ${entry.exclude_tag}`);
          }
          if (entry.include_metadata?.length) {
            lines.push(`          include_metadata: [${entry.include_metadata.map((v) => `"${v}"`).join(", ")}]`);
          }
        }
      }
    }
  }

  if (config.backup) {
    lines.push(...serializeBackup(config.backup));
  }

  // 0600 — owner read/write only. This file may contain the bcrypt password
  // hash and plaintext TOTP secret; it must not be world- or group-readable.
  writeFileSync(globalConfigPath(), lines.join("\n") + "\n", { mode: 0o600 });
  // writeFileSync's `mode` only applies on file creation, so chmod an existing
  // file explicitly in case it was written by an older version at 0644.
  try { chmodSync(globalConfigPath(), 0o600); } catch {}
}

// ---------------------------------------------------------------------------
// Vault config
// ---------------------------------------------------------------------------

export function readVaultConfig(name: string): VaultConfig | null {
  const configPath = vaultConfigPath(name);
  try {
    if (existsSync(configPath)) {
      return parseVaultConfig(readFileSync(configPath, "utf-8"), name);
    }
  } catch {}
  return null;
}

export function writeVaultConfig(config: VaultConfig): void {
  const dir = vaultDir(config.name);
  mkdirSync(dir, { recursive: true });
  const configPath = vaultConfigPath(config.name);
  writeFileSync(configPath, serializeVaultConfig(config));
}

// ---------------------------------------------------------------------------
// Key operations
// ---------------------------------------------------------------------------

export function hashKey(key: string): string {
  return "sha256:" + crypto.createHash("sha256").update(key).digest("hex");
}

export function verifyKey(providedKey: string, storedHash: string): boolean {
  const computed = hashKey(providedKey);
  if (computed.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
}

export function generateApiKey(): { fullKey: string; keyId: string } {
  const random = crypto.randomBytes(32).toString("base64url").slice(0, 32);
  return {
    fullKey: `pvk_${random}`,
    keyId: `k_${random.slice(0, 12)}`,
  };
}

// ---------------------------------------------------------------------------
// Environment file (~/.parachute/vault/.env)
// ---------------------------------------------------------------------------

/**
 * Read the .env file as key-value pairs.
 */
export function readEnvFile(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const p = envFilePath();
    if (!existsSync(p)) return env;
    const content = readFileSync(p, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  } catch {}
  return env;
}

/**
 * Write the .env file from key-value pairs.
 */
export function writeEnvFile(env: Record<string, string>): void {
  ensureConfigDirSync();
  const lines: string[] = [
    "# Parachute Vault configuration",
    "# Managed by: parachute-vault config",
    "",
  ];
  for (const [key, val] of Object.entries(env)) {
    if (val.includes(" ") || val.includes('"')) {
      lines.push(`${key}="${val}"`);
    } else {
      lines.push(`${key}=${val}`);
    }
  }
  writeFileSync(envFilePath(), lines.join("\n") + "\n");
}

/**
 * Set a single env var in the .env file.
 */
export function setEnvVar(key: string, value: string): void {
  const env = readEnvFile();
  env[key] = value;
  writeEnvFile(env);
}

/**
 * Remove an env var from the .env file.
 */
export function unsetEnvVar(key: string): void {
  const env = readEnvFile();
  delete env[key];
  writeEnvFile(env);
}

/**
 * Load .env file into process.env (for server startup).
 */
export function loadEnvFile(): void {
  const env = readEnvFile();
  for (const [key, val] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Vault listing
// ---------------------------------------------------------------------------

export function listVaults(): string[] {
  try {
    const dir = dataDirPath();
    if (!existsSync(dir)) return [];
    const entries = Bun.spawnSync(["ls", dir]).stdout.toString().trim();
    if (!entries) return [];
    return entries.split("\n").filter((name) => {
      return existsSync(vaultConfigPath(name));
    });
  } catch {
    return [];
  }
}

/**
 * Resolve the vault that tooling-level defaults (e.g. the `parachute-vault`
 * MCP entry the CLI writes into `~/.claude.json`) should target. HTTP routing
 * is vault-scoped — `/vault/<name>/...` is the only URL shape — so this helper
 * is no longer on the request path; it just picks the one vault the CLI wires
 * up by default.
 *
 * Resolution order:
 *  1. If `default_vault` is set in config.yaml AND that vault exists → use it.
 *  2. Else if exactly one vault exists → use that vault regardless of its name.
 *  3. Otherwise → return `null` (multi-vault deployment with no/bad default;
 *     the caller should surface an explicit error rather than guess).
 *
 * Notes:
 *  - If `default_vault` points to a deleted vault, step 2 still kicks in so
 *    operators aren't stranded after `vault remove`.
 *  - The name "default" has no special meaning here; it's just whatever
 *    `vault init` happens to create on first run.
 */
export function resolveDefaultVault(): string | null {
  const globalConfig = readGlobalConfig();
  const vaults = listVaults();
  if (globalConfig.default_vault && vaults.includes(globalConfig.default_vault)) {
    return globalConfig.default_vault;
  }
  if (vaults.length === 1) {
    return vaults[0];
  }
  return null;
}
