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

export const CONFIG_DIR = join(homedir(), ".parachute");
export const VAULTS_DIR = join(CONFIG_DIR, "vaults");
export const GLOBAL_CONFIG_PATH = join(CONFIG_DIR, "config.yaml");
export const LOG_PATH = join(CONFIG_DIR, "vault.log");
export const ERR_PATH = join(CONFIG_DIR, "vault.err");
export const DEFAULT_PORT = 1941;

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

export interface StoredKey {
  id: string;
  label: string;
  key_hash: string;
  created_at: string;
  last_used_at?: string;
}

export interface VaultConfig {
  name: string;
  description?: string;
  tool_hints?: Record<string, string>;
  api_keys: StoredKey[];
  created_at: string;
}

export interface GlobalConfig {
  port: number;
  default_vault?: string;
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

  if (config.tool_hints && Object.keys(config.tool_hints).length > 0) {
    lines.push("tool_hints:");
    for (const [key, val] of Object.entries(config.tool_hints)) {
      lines.push(`  ${key}: "${val}"`);
    }
  }

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

  // Parse tool_hints
  const hintsSection = yaml.match(/^tool_hints:\n((?:\s{2}\S.+\n?)+)/m);
  if (hintsSection) {
    config.tool_hints = {};
    const hintLines = hintsSection[1].split("\n");
    for (const line of hintLines) {
      const m = line.match(/^\s{2}(\S+):\s*"?([^"\n]+)"?/);
      if (m) config.tool_hints[m[1]] = m[2];
    }
  }

  // Parse api_keys
  const keyBlocks = yaml.split(/\n\s+-\s+id:\s+/).slice(1);
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

  return config;
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
      return {
        port: portMatch ? parseInt(portMatch[1], 10) : DEFAULT_PORT,
        default_vault: defaultVaultMatch?.[1],
      };
    }
  } catch {}
  return { port: DEFAULT_PORT };
}

export function writeGlobalConfig(config: GlobalConfig): void {
  ensureConfigDirSync();
  const lines = [`port: ${config.port}`];
  if (config.default_vault) lines.push(`default_vault: ${config.default_vault}`);
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
