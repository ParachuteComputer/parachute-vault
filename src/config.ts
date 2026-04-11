/**
 * Configuration management for Parachute Vault.
 *
 * Directory layout:
 *   ~/.parachute/
 *     config.yaml          — global server config
 *     vault.log / vault.err — daemon logs
 *     vaults/
 *       {name}/
 *         vault.db          — SQLite database
 *         vault.yaml        — per-vault config (description, tool_hints, api_keys)
 */

import { homedir } from "os";
import { join } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const CONFIG_DIR = process.env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
export const VAULTS_DIR = join(CONFIG_DIR, "vaults");
export const GLOBAL_CONFIG_PATH = join(CONFIG_DIR, "config.yaml");
export const ENV_PATH = join(CONFIG_DIR, ".env");
export const LOG_PATH = join(CONFIG_DIR, "vault.log");
export const ERR_PATH = join(CONFIG_DIR, "vault.err");
export const DEFAULT_PORT = 1940;
export const ASSETS_DIR = join(CONFIG_DIR, "assets");

export function vaultDir(name: string): string {
  return join(VAULTS_DIR, name);
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
}

export interface GlobalConfig {
  port: number;
  default_vault?: string;
  api_keys?: StoredKey[];
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

  return config;
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
// Directory management
// ---------------------------------------------------------------------------

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(VAULTS_DIR, { recursive: true });
}

export function ensureConfigDirSync(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(VAULTS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Global config
// ---------------------------------------------------------------------------

export function readGlobalConfig(): GlobalConfig {
  try {
    if (existsSync(GLOBAL_CONFIG_PATH)) {
      const yaml = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
      const portMatch = yaml.match(/^port:\s*(\d+)/m);
      const defaultVaultMatch = yaml.match(/^default_vault:\s*(\S+)/m);
      const config: GlobalConfig = {
        port: portMatch ? parseInt(portMatch[1], 10) : DEFAULT_PORT,
        default_vault: defaultVaultMatch?.[1],
      };

      // Parse global api_keys
      const keyBlocks = yaml.split(/\n\s+-\s+id:\s+/).slice(1);
      if (keyBlocks.length > 0) {
        config.api_keys = [];
        for (const block of keyBlocks) {
          const idMatch = block.match(/^(\S+)/);
          const labelMatch = block.match(/label:\s*(.+)/);
          const hashMatch = block.match(/key_hash:\s*(\S+)/);
          const createdAtMatch = block.match(/created_at:\s*"?([^"\n]+)"?/);
          const lastUsedMatch = block.match(/last_used_at:\s*"?([^"\n]+)"?/);
          if (idMatch && hashMatch) {
            config.api_keys.push({
              id: idMatch[1],
              label: (labelMatch?.[1] ?? "default").trim(),
              key_hash: hashMatch[1],
              created_at: createdAtMatch?.[1] ?? new Date().toISOString(),
              last_used_at: lastUsedMatch?.[1],
            });
          }
        }
      }

      return config;
    }
  } catch {}
  return { port: DEFAULT_PORT };
}

export function writeGlobalConfig(config: GlobalConfig): void {
  ensureConfigDirSync();
  const lines = [`port: ${config.port}`];
  if (config.default_vault) lines.push(`default_vault: ${config.default_vault}`);

  if (config.api_keys && config.api_keys.length > 0) {
    lines.push("api_keys:");
    for (const key of config.api_keys) {
      lines.push(`  - id: ${key.id}`);
      lines.push(`    label: ${key.label}`);
      lines.push(`    key_hash: ${key.key_hash}`);
      lines.push(`    created_at: "${key.created_at}"`);
      if (key.last_used_at) {
        lines.push(`    last_used_at: "${key.last_used_at}"`);
      }
    }
  }

  writeFileSync(GLOBAL_CONFIG_PATH, lines.join("\n") + "\n");
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
// Environment file (~/.parachute/.env)
// ---------------------------------------------------------------------------

/**
 * Read the .env file as key-value pairs.
 */
export function readEnvFile(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    if (!existsSync(ENV_PATH)) return env;
    const content = readFileSync(ENV_PATH, "utf-8");
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
    "# Managed by: parachute vault config",
    "",
  ];
  for (const [key, val] of Object.entries(env)) {
    if (val.includes(" ") || val.includes('"')) {
      lines.push(`${key}="${val}"`);
    } else {
      lines.push(`${key}=${val}`);
    }
  }
  writeFileSync(ENV_PATH, lines.join("\n") + "\n");
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
// Scribe status
// ---------------------------------------------------------------------------

export async function getScribeStatus(): Promise<{
  available: boolean;
  transcription: string[];
  cleanup: string[];
  activeTranscriber: string;
  activeCleaner: string;
}> {
  try {
    const scribe = await import("@openparachute/scribe");
    const providers = scribe.availableProviders();
    return {
      available: true,
      transcription: providers.transcription,
      cleanup: providers.cleanup,
      activeTranscriber: process.env.TRANSCRIBE_PROVIDER ?? "parakeet-mlx",
      activeCleaner: process.env.CLEANUP_PROVIDER ?? "none",
    };
  } catch {
    return {
      available: false,
      transcription: [],
      cleanup: [],
      activeTranscriber: "none",
      activeCleaner: "none",
    };
  }
}

// ---------------------------------------------------------------------------
// Vault listing
// ---------------------------------------------------------------------------

export function listVaults(): string[] {
  try {
    if (!existsSync(VAULTS_DIR)) return [];
    const entries = Bun.spawnSync(["ls", VAULTS_DIR]).stdout.toString().trim();
    if (!entries) return [];
    return entries.split("\n").filter((name) => {
      return existsSync(vaultConfigPath(name));
    });
  } catch {
    return [];
  }
}
