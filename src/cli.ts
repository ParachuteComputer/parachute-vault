#!/usr/bin/env bun

/**
 * Parachute Vault CLI.
 *
 * Usage:
 *   parachute vault init                    — set up everything, one command
 *   parachute vault create <name>           — create a new vault
 *   parachute vault list                    — list all vaults
 *   parachute vault mcp-install <name>      — add vault MCP to ~/.claude.json
 *   parachute vault remove <name>           — remove a vault
 *   parachute vault config                  — show all config
 *   parachute vault config set <key> <val>  — set a config value
 *   parachute vault config unset <key>      — remove a config value
 *   parachute vault serve                   — run the server (foreground)
 *   parachute vault status                  — show full status
 */

import { resolve } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";
import {
  ensureConfigDirSync,
  readVaultConfig,
  writeVaultConfig,
  readGlobalConfig,
  writeGlobalConfig,
  readEnvFile,
  writeEnvFile,
  setEnvVar,
  unsetEnvVar,
  loadEnvFile,
  listVaults,
  vaultDir,
  generateApiKey,
  hashKey,
  DEFAULT_PORT,
  CONFIG_DIR,
  ASSETS_DIR,
  ENV_PATH,
} from "./config.ts";
import type { VaultConfig } from "./config.ts";
import { installAgent, uninstallAgent, isAgentLoaded, restartAgent } from "./launchd.ts";
import { installSystemdService, restartSystemdService, isSystemdAvailable, isServiceActive } from "./systemd.ts";
import { confirm, ask, choose } from "./prompt.ts";
import { generateToken, createToken, listTokens, revokeToken, migrateVaultKeys } from "./token-store.ts";
import type { TokenPermission } from "./token-store.ts";
import { getVaultStore } from "./vault-store.ts";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

// Support both `parachute vault <cmd>` and `parachute <cmd>` patterns
let command: string;
let cmdArgs: string[];

if (args[0] === "vault") {
  command = args[1] ?? "help";
  cmdArgs = args.slice(2);
} else {
  command = args[0] ?? "help";
  cmdArgs = args.slice(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

switch (command) {
  case "init":
    await cmdInit();
    break;
  case "create":
    cmdCreate(cmdArgs);
    break;
  case "list":
  case "ls":
    cmdList();
    break;
  case "mcp-install":
    cmdMcpInstall(cmdArgs);
    break;
  case "remove":
  case "rm":
    cmdRemove(cmdArgs);
    break;
  case "config":
    await cmdConfig(cmdArgs);
    break;
  case "keys":
    cmdKeys(cmdArgs);
    break;
  case "tokens":
    cmdTokens(cmdArgs);
    break;
  case "serve":
    await cmdServe();
    break;
  case "status":
    await cmdStatus();
    break;
  case "restart":
    await cmdRestart();
    break;
  case "import":
    await cmdImport(cmdArgs);
    break;
  case "export":
    await cmdExport(cmdArgs);
    break;
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdInit() {
  ensureConfigDirSync();

  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";
  const isFirstRun = !existsSync(ENV_PATH);

  console.log("Parachute Vault — self-hosted knowledge graph\n");

  // 1. Create default vault if none exist
  const vaults = listVaults();
  let apiKey: string | undefined;
  if (vaults.length === 0) {
    console.log("Creating default vault...");
    apiKey = createVault("default");
    console.log("  Created vault: default");
  } else {
    console.log(`Found ${vaults.length} existing vault(s)`);
  }

  // 2. Write global config + global API key
  const globalConfig = readGlobalConfig();
  if (!globalConfig.default_vault) {
    globalConfig.default_vault = "default";
  }
  let globalApiKey: string | undefined;
  if (!globalConfig.api_keys || globalConfig.api_keys.length === 0) {
    const { fullKey, keyId } = generateApiKey();
    globalConfig.api_keys = [{
      id: keyId,
      label: "default",
      scope: "write",
      key_hash: hashKey(fullKey),
      created_at: new Date().toISOString(),
    }];
    globalApiKey = fullKey;
  }
  writeGlobalConfig(globalConfig);

  // 2b. Migrate existing keys into per-vault token tables
  for (const v of listVaults()) {
    const vc = readVaultConfig(v);
    if (!vc) continue;
    const store = getVaultStore(v);
    migrateVaultKeys(store.db, vc.api_keys, globalConfig.api_keys);
  }

  // 3. Ensure assets directory exists
  mkdirSync(ASSETS_DIR, { recursive: true });

  // 4. Create .env with sensible defaults if it doesn't exist
  const envVars: Record<string, string> = {};
  if (isFirstRun) {
    envVars.PORT = String(globalConfig.port || DEFAULT_PORT);
  }

  // 5. Write env file (first run only)
  if (isFirstRun) {
    writeEnvFile(envVars);
    console.log();
  }

  // 6. Install daemon (platform-aware)
  console.log("Installing daemon...");
  if (isMac) {
    await installAgent();
  } else if (isLinux && isSystemdAvailable()) {
    await installSystemdService();
  } else {
    console.log("  Auto-start not available on this platform.");
    console.log("  Run manually: bun src/server.ts");
    console.log("  Or use Docker: docker compose up -d");
  }
  console.log(`  Listening on http://0.0.0.0:${globalConfig.port || DEFAULT_PORT}`);

  // 7. Install MCP for Claude Code (with API key for auth)
  const mcpKey = globalApiKey ?? apiKey;
  installMcpConfig(mcpKey);
  console.log(`  MCP server added to ~/.claude.json`);

  // 8. Summary
  console.log("\n---");
  const port = globalConfig.port || DEFAULT_PORT;
  if (globalApiKey) {
    console.log(`\nYour API key: ${globalApiKey}`);
    console.log("  Use this in Claude Desktop, curl, or any client.");
    console.log("  Pass via: Authorization: Bearer <key>");
    console.log("  Or via:   X-API-Key: <key>");
  }
  if (apiKey && apiKey !== globalApiKey) {
    console.log(`\nVault API key (default): ${apiKey}`);
    console.log("  Grants access to the 'default' vault only.");
  }
  if (globalApiKey || apiKey) {
    console.log("\nSave these — they will not be shown again.");
  }

  console.log(`\nConfig:   ${CONFIG_DIR}`);
  console.log(`Server:   http://0.0.0.0:${port}`);

  console.log(`\nUsage examples:`);
  console.log(`  curl http://localhost:${port}/health`);
  if (mcpKey) {
    console.log(`  curl -H "Authorization: Bearer ${mcpKey}" http://localhost:${port}/api/notes`);
  }

  console.log(`\nNext steps:`);
  console.log(`  parachute vault status            check everything is running`);
  console.log(`  parachute vault config             view/edit configuration`);
}

function cmdCreate(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: parachute vault create <name>");
    process.exit(1);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error("Vault name must contain only letters, numbers, hyphens, and underscores.");
    process.exit(1);
  }

  const existing = readVaultConfig(name);
  if (existing) {
    console.error(`Vault "${name}" already exists.`);
    process.exit(1);
  }

  ensureConfigDirSync();
  const key = createVault(name);

  console.log(`Vault "${name}" created.`);
  console.log(`  Path: ${vaultDir(name)}`);
  console.log(`  API key: ${key}`);
  console.log(`  Save this — it will not be shown again.`);
  console.log();
  console.log(`To add MCP to Claude: parachute vault mcp-install ${name}`);
}

function cmdList() {
  const vaults = listVaults();
  if (vaults.length === 0) {
    console.log("No vaults. Run: parachute vault init");
    return;
  }

  for (const name of vaults) {
    const config = readVaultConfig(name);
    const keys = config?.api_keys.length ?? 0;
    const desc = config?.description ? ` — ${config.description}` : "";
    console.log(`  ${name}${desc}  (${keys} key${keys !== 1 ? "s" : ""})`);
  }
}

function cmdMcpInstall(_args: string[]) {
  installMcpConfig();
  console.log(`Added MCP server "parachute-vault" to ~/.claude.json`);
  console.log(`All vaults accessible via the 'vault' parameter on each tool.`);
}

function cmdRemove(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: parachute vault remove <name>");
    process.exit(1);
  }

  const config = readVaultConfig(name);
  if (!config) {
    console.error(`Vault "${name}" not found.`);
    process.exit(1);
  }

  const force = args.includes("--yes") || args.includes("-y");
  if (!force) {
    console.log(`This will permanently delete vault "${name}" and all its data.`);
    console.log(`  Path: ${vaultDir(name)}`);
    console.log(`\nTo confirm: parachute vault remove ${name} --yes`);
    return;
  }

  rmSync(vaultDir(name), { recursive: true, force: true });
  console.log(`Vault "${name}" removed.`);
}

async function cmdConfig(args: string[]) {
  const subcmd = args[0];

  // parachute vault config — show current config
  if (!subcmd) {
    loadEnvFile();
    const env = readEnvFile();
    const globalConfig = readGlobalConfig();

    console.log("Parachute Vault Configuration");
    console.log(`  Config dir: ${CONFIG_DIR}`);
    console.log(`  Env file:   ${ENV_PATH}`);
    console.log(`  Port:       ${globalConfig.port}`);
    console.log();

    if (Object.keys(env).length === 0) {
      console.log("  No env vars set. Use: parachute vault config set <key> <value>");
    } else {
      for (const [key, val] of Object.entries(env)) {
        // Mask sensitive values
        const display = key.includes("KEY") || key.includes("SECRET")
          ? val.slice(0, 8) + "..."
          : val;
        console.log(`  ${key}=${display}`);
      }
    }

    return;
  }

  // parachute vault config set <key> <value>
  if (subcmd === "set") {
    const key = args[1];
    const value = args.slice(2).join(" ");
    if (!key || !value) {
      console.error("Usage: parachute vault config set <key> <value>");
      process.exit(1);
    }
    setEnvVar(key, value);
    console.log(`Set ${key}=${key.includes("KEY") ? value.slice(0, 8) + "..." : value}`);
    console.log("Restart the daemon to apply: parachute vault restart");
    return;
  }

  // parachute vault config unset <key>
  if (subcmd === "unset") {
    const key = args[1];
    if (!key) {
      console.error("Usage: parachute vault config unset <key>");
      process.exit(1);
    }
    unsetEnvVar(key);
    console.log(`Removed ${key}`);
    console.log("Restart the daemon to apply: parachute vault restart");
    return;
  }

  console.error(`Unknown config command: ${subcmd}`);
  console.error("Usage: parachute vault config [set <key> <value> | unset <key>]");
  process.exit(1);
}

function cmdKeys(args: string[]) {
  const subcmd = args[0];

  // parachute vault keys — list all keys
  if (!subcmd || subcmd === "list") {
    const globalConfig = readGlobalConfig();
    const vaults = listVaults();

    // Global keys
    const globalKeys = globalConfig.api_keys ?? [];
    if (globalKeys.length > 0) {
      console.log("Global keys (access all vaults):");
      for (const key of globalKeys) {
        const scope = key.scope === "read" ? " [read-only]" : "";
        const lastUsed = key.last_used_at ? ` (last used: ${key.last_used_at})` : "";
        console.log(`  ${key.id}  ${key.label}${scope}${lastUsed}`);
      }
      console.log();
    }

    // Per-vault keys
    for (const name of vaults) {
      const config = readVaultConfig(name);
      if (!config || config.api_keys.length === 0) continue;
      console.log(`Vault "${name}" keys:`);
      for (const key of config.api_keys) {
        const scope = key.scope === "read" ? " [read-only]" : "";
        const lastUsed = key.last_used_at ? ` (last used: ${key.last_used_at})` : "";
        console.log(`  ${key.id}  ${key.label}${scope}${lastUsed}`);
      }
      console.log();
    }

    if (globalKeys.length === 0 && vaults.every((v) => (readVaultConfig(v)?.api_keys.length ?? 0) === 0)) {
      console.log("No keys found. Create one: parachute vault keys create");
    }
    return;
  }

  // parachute vault keys create [--vault <name>] [--read-only] [--label <label>]
  if (subcmd === "create") {
    const vaultFlag = args.indexOf("--vault");
    const vaultName = vaultFlag !== -1 ? args[vaultFlag + 1] : undefined;
    const readOnly = args.includes("--read-only");
    const labelFlag = args.indexOf("--label");
    const label = labelFlag !== -1 ? args[labelFlag + 1] : "default";

    const { fullKey, keyId } = generateApiKey();
    const stored: import("./config.ts").StoredKey = {
      id: keyId,
      label: label ?? "default",
      scope: readOnly ? "read" : "write",
      key_hash: hashKey(fullKey),
      created_at: new Date().toISOString(),
    };

    if (vaultName) {
      // Per-vault key
      const config = readVaultConfig(vaultName);
      if (!config) {
        console.error(`Vault "${vaultName}" not found.`);
        process.exit(1);
      }
      config.api_keys.push(stored);
      writeVaultConfig(config);
      console.log(`Created ${readOnly ? "read-only " : ""}key for vault "${vaultName}":`);
    } else {
      // Global key
      const globalConfig = readGlobalConfig();
      if (!globalConfig.api_keys) globalConfig.api_keys = [];
      globalConfig.api_keys.push(stored);
      writeGlobalConfig(globalConfig);
      console.log(`Created ${readOnly ? "read-only " : ""}global key:`);
    }

    console.log(`  ID:    ${keyId}`);
    console.log(`  Key:   ${fullKey}`);
    console.log(`  Scope: ${readOnly ? "read" : "write"}`);
    console.log(`  Label: ${label}`);
    console.log();
    console.log("Save this key — it will not be shown again.");
    return;
  }

  // parachute vault keys revoke <key-id>
  if (subcmd === "revoke") {
    const keyId = args[1];
    if (!keyId) {
      console.error("Usage: parachute vault keys revoke <key-id>");
      process.exit(1);
    }

    // Check global keys
    const globalConfig = readGlobalConfig();
    if (globalConfig.api_keys) {
      const idx = globalConfig.api_keys.findIndex((k) => k.id === keyId);
      if (idx !== -1) {
        const removed = globalConfig.api_keys.splice(idx, 1)[0];
        writeGlobalConfig(globalConfig);
        console.log(`Revoked global key: ${keyId} (${removed.label})`);
        return;
      }
    }

    // Check per-vault keys
    for (const name of listVaults()) {
      const config = readVaultConfig(name);
      if (!config) continue;
      const idx = config.api_keys.findIndex((k) => k.id === keyId);
      if (idx !== -1) {
        const removed = config.api_keys.splice(idx, 1)[0];
        writeVaultConfig(config);
        console.log(`Revoked key from vault "${name}": ${keyId} (${removed.label})`);
        return;
      }
    }

    console.error(`Key "${keyId}" not found.`);
    process.exit(1);
  }

  console.error(`Unknown keys command: ${subcmd}`);
  console.error("Usage: parachute vault keys [create | revoke <id>]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Tokens — parachute vault tokens [create | list | revoke]
// ---------------------------------------------------------------------------

function cmdTokens(args: string[]) {
  const subcmd = args[0];

  // parachute vault tokens — list all tokens (across all vaults)
  if (!subcmd || subcmd === "list") {
    const vaults = listVaults();
    let anyTokens = false;

    for (const vaultName of vaults) {
      const vc = readVaultConfig(vaultName);
      if (!vc) continue;
      const store = getVaultStore(vaultName);
      // Ensure legacy keys are migrated
      const globalCfg = readGlobalConfig();
      migrateVaultKeys(store.db, vc.api_keys, globalCfg.api_keys);

      const tokens = listTokens(store.db);
      if (tokens.length === 0) continue;
      anyTokens = true;

      console.log(`Vault "${vaultName}" tokens:`);
      for (const t of tokens) {
        const scope = formatScope(t);
        const expiry = t.expires_at ? ` (expires: ${t.expires_at})` : "";
        const lastUsed = t.last_used_at ? ` (last used: ${t.last_used_at})` : "";
        console.log(`  ${t.id}  ${t.label}  [${t.permission}]${scope}${expiry}${lastUsed}`);
      }
      console.log();
    }

    if (!anyTokens) {
      console.log("No tokens found. Create one: parachute vault tokens create --vault <name>");
    }
    return;
  }

  // parachute vault tokens create --vault <name> [--permission admin|write|read]
  //   [--scope-tag <tag>] [--scope-path-prefix <prefix>] [--expires <duration>] [--label <label>]
  if (subcmd === "create") {
    const vaultFlag = args.indexOf("--vault");
    const vaultName = vaultFlag !== -1 ? args[vaultFlag + 1] : null;
    if (!vaultName) {
      console.error("--vault is required. Tokens are per-vault.");
      console.error("Usage: parachute vault tokens create --vault <name> [--permission admin|write|read]");
      process.exit(1);
    }

    const vc = readVaultConfig(vaultName);
    if (!vc) {
      console.error(`Vault "${vaultName}" not found.`);
      process.exit(1);
    }

    const permFlag = args.indexOf("--permission");
    const permission = (permFlag !== -1 ? args[permFlag + 1] : "admin") as TokenPermission;
    if (!["admin", "write", "read"].includes(permission)) {
      console.error(`Invalid permission: ${permission}. Must be admin, write, or read.`);
      process.exit(1);
    }

    const scopeTagFlag = args.indexOf("--scope-tag");
    const scopeTag = scopeTagFlag !== -1 ? args[scopeTagFlag + 1] : null;

    const scopePathFlag = args.indexOf("--scope-path-prefix");
    const scopePath = scopePathFlag !== -1 ? args[scopePathFlag + 1] : null;

    const expiresFlag = args.indexOf("--expires");
    let expiresAt: string | null = null;
    if (expiresFlag !== -1) {
      const dur = args[expiresFlag + 1];
      expiresAt = parseDuration(dur);
      if (!expiresAt) {
        console.error(`Invalid duration: ${dur}. Use format like 7d, 30d, 24h, 1y.`);
        process.exit(1);
      }
    }

    const labelFlag = args.indexOf("--label");
    const label = labelFlag !== -1 ? args[labelFlag + 1] : "default";

    const store = getVaultStore(vaultName);
    const { fullToken } = generateToken();
    createToken(store.db, fullToken, {
      label,
      permission,
      scope_tag: scopeTag,
      scope_path_prefix: scopePath,
      expires_at: expiresAt,
    });

    console.log(`Created token for vault "${vaultName}":`);
    console.log(`  Token:      ${fullToken}`);
    console.log(`  Permission: ${permission}`);
    if (scopeTag) console.log(`  Scope tag:  ${scopeTag}`);
    if (scopePath) console.log(`  Scope path: ${scopePath}`);
    if (expiresAt) console.log(`  Expires:    ${expiresAt}`);
    console.log(`  Label:      ${label}`);
    console.log();
    console.log("Save this token — it will not be shown again.");
    return;
  }

  // parachute vault tokens revoke <token-id> --vault <name>
  if (subcmd === "revoke") {
    const tokenId = args[1];
    if (!tokenId) {
      console.error("Usage: parachute vault tokens revoke <token-id> --vault <name>");
      process.exit(1);
    }

    const vaultFlag = args.indexOf("--vault");
    const vaultName = vaultFlag !== -1 ? args[vaultFlag + 1] : null;
    if (!vaultName) {
      console.error("--vault is required. Tokens are per-vault.");
      process.exit(1);
    }

    const vc = readVaultConfig(vaultName);
    if (!vc) {
      console.error(`Vault "${vaultName}" not found.`);
      process.exit(1);
    }

    const store = getVaultStore(vaultName);
    if (revokeToken(store.db, tokenId)) {
      console.log(`Revoked token: ${tokenId}`);
    } else {
      console.error(`Token "${tokenId}" not found in vault "${vaultName}".`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown tokens command: ${subcmd}`);
  console.error("Usage: parachute vault tokens [create | list | revoke <id>]");
  process.exit(1);
}

function formatScope(t: { scope_tag: string | null; scope_path_prefix: string | null }): string {
  const parts: string[] = [];
  if (t.scope_tag) parts.push(`tag:${t.scope_tag}`);
  if (t.scope_path_prefix) parts.push(`path:${t.scope_path_prefix}`);
  return parts.length > 0 ? ` {${parts.join(", ")}}` : "";
}

function parseDuration(dur: string): string | null {
  const match = dur.match(/^(\d+)(h|d|w|m|y)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();
  switch (unit) {
    case "h": now.setHours(now.getHours() + n); break;
    case "d": now.setDate(now.getDate() + n); break;
    case "w": now.setDate(now.getDate() + n * 7); break;
    case "m": now.setMonth(now.getMonth() + n); break;
    case "y": now.setFullYear(now.getFullYear() + n); break;
    default: return null;
  }
  return now.toISOString();
}

async function cmdServe() {
  await import("./server.ts");
}

async function cmdRestart() {
  console.log("Restarting daemon...");
  if (process.platform === "darwin") {
    await restartAgent();
  } else if (isSystemdAvailable()) {
    await restartSystemdService();
  } else {
    console.error("No daemon manager available. Restart manually or use Docker.");
    process.exit(1);
  }
  console.log("Done.");
}

async function cmdStatus() {
  loadEnvFile();
  let loaded: boolean;
  if (process.platform === "darwin") {
    loaded = await isAgentLoaded();
  } else if (isSystemdAvailable()) {
    loaded = await isServiceActive();
  } else {
    // Check if server responds on the port
    try {
      const resp = await fetch(`http://127.0.0.1:${readGlobalConfig().port || DEFAULT_PORT}/health`);
      loaded = resp.ok;
    } catch { loaded = false; }
  }
  const vaults = listVaults();
  const globalConfig = readGlobalConfig();

  console.log("Parachute Vault\n");

  // Server
  console.log(`  Server:   ${loaded ? "running" : "stopped"} on port ${globalConfig.port}`);
  console.log(`  Config:   ${CONFIG_DIR}`);

  // Vaults
  console.log(`  Vaults:   ${vaults.length}`);
  for (const name of vaults) {
    const config = readVaultConfig(name);
    const desc = config?.description ? ` — ${config.description}` : "";
    console.log(`            ${name}${desc}`);
  }

  // Triggers
  console.log();
  if (globalConfig.triggers?.length) {
    console.log(`  Triggers:   ${globalConfig.triggers.length}`);
    for (const t of globalConfig.triggers) {
      console.log(`              ${t.name} → ${t.action.webhook}`);
    }
  } else {
    console.log(`  Triggers:   none configured`);
  }

  // Quick health check if daemon is running
  if (loaded) {
    try {
      const resp = await fetch(`http://127.0.0.1:${globalConfig.port}/health`);
      if (resp.ok) {
        console.log(`\n  Health:   ok`);
      }
    } catch {
      console.log(`\n  Health:   daemon loaded but not responding`);
    }
  }
}

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

async function cmdImport(args: string[]) {
  // Parse flags
  let format = "obsidian";
  let vaultName = "default";
  let sourcePath = "";
  let dryRun = false;

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format") {
      format = args[++i];
    } else if (args[i] === "--vault") {
      vaultName = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--obsidian") {
      format = "obsidian";
    } else {
      positional.push(args[i]);
    }
  }
  sourcePath = positional[0] ?? "";

  if (!sourcePath) {
    console.error("Usage: parachute vault import <path> [--vault <name>] [--dry-run]");
    console.error("\nImports an Obsidian vault into Parachute Vault.");
    console.error("\nOptions:");
    console.error("  --vault <name>   Target vault (default: 'default')");
    console.error("  --dry-run        Show what would be imported without importing");
    process.exit(1);
  }

  const { resolve: resolvePath } = await import("path");
  const fullPath = resolvePath(sourcePath);

  if (!existsSync(fullPath)) {
    console.error(`Path not found: ${fullPath}`);
    process.exit(1);
  }

  // Verify vault exists
  const config = readVaultConfig(vaultName);
  if (!config) {
    console.error(`Vault "${vaultName}" not found. Run: parachute vault create ${vaultName}`);
    process.exit(1);
  }

  const { parseObsidianVault } = await import("../core/src/obsidian.ts");
  const { getVaultStore } = await import("./vault-store.ts");

  console.log(`Parsing Obsidian vault: ${fullPath}`);
  const { notes, errors } = parseObsidianVault(fullPath);

  if (errors.length > 0) {
    console.error(`\n${errors.length} file(s) failed to parse:`);
    for (const err of errors.slice(0, 10)) {
      console.error(`  ${err.path}: ${err.error}`);
    }
    if (errors.length > 10) console.error(`  ... and ${errors.length - 10} more`);
  }

  console.log(`Found ${notes.length} notes`);

  // Collect all unique tags
  const allTags = new Set<string>();
  for (const note of notes) {
    for (const tag of note.tags) allTags.add(tag);
  }
  console.log(`Tags: ${allTags.size} unique (${[...allTags].slice(0, 10).join(", ")}${allTags.size > 10 ? "..." : ""})`);

  if (dryRun) {
    console.log("\n[Dry run] Would import:");
    for (const note of notes.slice(0, 20)) {
      const tagStr = note.tags.length > 0 ? ` [${note.tags.join(", ")}]` : "";
      console.log(`  ${note.path}${tagStr}`);
    }
    if (notes.length > 20) console.log(`  ... and ${notes.length - 20} more`);
    return;
  }

  // Import into vault — use createNoteRaw to skip per-note wikilink sync,
  // then do a single pass after all notes are imported (much faster for large vaults).
  const store = getVaultStore(vaultName);
  let imported = 0;
  let skipped = 0;

  for (const note of notes) {
    // Skip if a note with this path already exists
    const existing = store.getNoteByPath(note.path);
    if (existing) {
      skipped++;
      continue;
    }

    // Build metadata from frontmatter (excluding tags, already extracted)
    const metadata = Object.keys(note.frontmatter).length > 0 ? note.frontmatter : undefined;

    store.createNoteRaw(note.content, {
      path: note.path,
      tags: note.tags.length > 0 ? note.tags : undefined,
      metadata: metadata as Record<string, unknown>,
    });
    imported++;
  }

  // Single-pass wikilink sync after all notes exist
  console.log(`\nImported ${imported} notes into vault "${vaultName}"`);
  if (skipped > 0) console.log(`Skipped ${skipped} notes (path already exists)`);

  if (imported > 0) {
    const linkResult = store.syncAllWikilinks();
    console.log(`Resolved ${linkResult.totalAdded} wikilinks across ${linkResult.synced} notes.`);
  }
}

async function cmdExport(args: string[]) {
  let vaultName = "default";
  let outputPath = "";

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault") {
      vaultName = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  outputPath = positional[0] ?? "";

  if (!outputPath) {
    console.error("Usage: parachute vault export <output-path> [--vault <name>]");
    console.error("\nExports a Parachute Vault as Obsidian-compatible markdown files.");
    process.exit(1);
  }

  const { resolve: resolvePath } = await import("path");
  const { mkdirSync: mkdir, writeFileSync: writeFile } = await import("fs");
  const { join, dirname } = await import("path");
  const fullPath = resolvePath(outputPath);

  const config = readVaultConfig(vaultName);
  if (!config) {
    console.error(`Vault "${vaultName}" not found.`);
    process.exit(1);
  }

  const { toObsidianMarkdown, exportFilePath } = await import("../core/src/obsidian.ts");
  const { getVaultStore } = await import("./vault-store.ts");

  const store = getVaultStore(vaultName);
  const notes = store.queryNotes({ limit: 100000, sort: "asc" });

  console.log(`Exporting ${notes.length} notes from vault "${vaultName}" to ${fullPath}`);
  mkdir(fullPath, { recursive: true });

  let exported = 0;
  for (const note of notes) {
    const filePath = exportFilePath(note);
    const fullFilePath = join(fullPath, filePath);
    const dir = dirname(fullFilePath);
    mkdir(dir, { recursive: true });

    const markdown = toObsidianMarkdown(note);
    writeFile(fullFilePath, markdown);
    exported++;
  }

  console.log(`Exported ${exported} notes as markdown files.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createVault(name: string): string {
  const { fullKey, keyId } = generateApiKey();
  const config: VaultConfig = {
    name,
    api_keys: [
      {
        id: keyId,
        label: "default",
        scope: "write",
        key_hash: hashKey(fullKey),
        created_at: new Date().toISOString(),
      },
    ],
    created_at: new Date().toISOString(),
  };
  writeVaultConfig(config);
  return fullKey;
}

function installMcpConfig(apiKey?: string) {
  const claudeJsonPath = resolve(homedir(), ".claude.json");
  let config: any = {};
  if (existsSync(claudeJsonPath)) {
    try {
      config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    } catch {}
  }

  if (!config.mcpServers) config.mcpServers = {};

  const globalConfig = readGlobalConfig();
  const port = globalConfig.port || DEFAULT_PORT;

  // Clean up old per-vault stdio entries
  for (const key of Object.keys(config.mcpServers)) {
    if (key.startsWith("parachute-vault/")) {
      delete config.mcpServers[key];
    }
  }

  // Single HTTP MCP entry with API key for auth
  const mcpEntry: Record<string, unknown> = {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
  };
  if (apiKey) {
    mcpEntry.headers = { Authorization: `Bearer ${apiKey}` };
  }
  config.mcpServers["parachute-vault"] = mcpEntry;

  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");
}

function removeMcpConfig() {
  const claudeJsonPath = resolve(homedir(), ".claude.json");
  if (!existsSync(claudeJsonPath)) return;
  try {
    const config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    delete config.mcpServers?.["parachute-vault"];
    // Also clean up any old per-vault entries
    for (const key of Object.keys(config.mcpServers ?? {})) {
      if (key.startsWith("parachute-vault/")) {
        delete config.mcpServers[key];
      }
    }
    writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");
  } catch {}
}

function usage() {
  console.log(`
Parachute Vault — self-hosted knowledge graph

Setup:
  parachute vault init                     Set up everything (one command)
  parachute vault status                   Check what's running

Vaults:
  parachute vault create <name>            Create a new vault
  parachute vault list                     List all vaults
  parachute vault remove <name> [--yes]    Remove a vault
  parachute vault mcp-install              Add vault MCP to Claude

Keys (legacy):
  parachute vault keys                     List all API keys
  parachute vault keys create              Create a global key
  parachute vault keys revoke <key-id>     Revoke a key

Tokens (recommended):
  parachute vault tokens                   List all tokens (all vaults)
  parachute vault tokens create --vault <name>     Create an admin token
  parachute vault tokens create --vault <name> --permission read  Read-only token
  parachute vault tokens create --vault <name> --scope-tag publish  Tag-scoped
  parachute vault tokens create --vault <name> --scope-path-prefix Projects/
  parachute vault tokens create --vault <name> --expires 30d  Expiring token
  parachute vault tokens revoke <token-id> --vault <name>  Revoke a token

Config:
  parachute vault config                   Show current configuration
  parachute vault config set <key> <val>   Set a config value
  parachute vault config unset <key>       Remove a config value

Import/Export:
  parachute vault import <path>            Import an Obsidian vault
  parachute vault import <path> --dry-run  Preview import without writing
  parachute vault export <path>            Export vault as Obsidian markdown

Server:
  parachute vault serve                    Run server (foreground)
  parachute vault restart                  Restart the daemon
`);
}
