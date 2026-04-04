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
  getScribeStatus,
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
  case "serve":
    await cmdServe();
    break;
  case "status":
    await cmdStatus();
    break;
  case "restart":
    await cmdRestart();
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

  // 3. Ensure assets directory exists
  mkdirSync(ASSETS_DIR, { recursive: true });

  // 4. Create .env with sensible defaults if it doesn't exist
  if (!existsSync(ENV_PATH)) {
    writeEnvFile({
      PORT: String(globalConfig.port || DEFAULT_PORT),
    });
    console.log("  Created ~/.parachute/.env");
  }

  // 4. Install launchd daemon
  console.log("\nInstalling daemon...");
  await installAgent();
  console.log(`  Listening on http://0.0.0.0:${globalConfig.port || DEFAULT_PORT}`);

  // 5. Install MCP (single HTTP entry for all vaults)
  installMcpConfig();
  console.log(`  MCP server added to ~/.claude.json`);

  // 6. Check scribe
  loadEnvFile();
  const scribe = await getScribeStatus();
  if (scribe.available) {
    console.log(`\nTranscription: ${scribe.activeTranscriber} (via parachute-scribe)`);
    console.log(`  Cleanup: ${scribe.activeCleaner}`);
  } else {
    console.log("\nTranscription: not available");
    console.log("  Install parachute-scribe to enable: bun add parachute-scribe");
  }

  // 7. Summary
  console.log("\n---");
  if (globalApiKey) {
    console.log(`\nGlobal API key: ${globalApiKey}`);
    console.log("  Grants access to all vaults (for unified /mcp endpoint).");
  }
  if (apiKey) {
    console.log(`\nVault API key (default): ${apiKey}`);
    console.log("  Grants access to the 'default' vault only.");
  }
  if (globalApiKey || apiKey) {
    console.log("\nSave these — they will not be shown again.");
  }
  console.log(`\nConfig:   ${CONFIG_DIR}`);
  console.log(`Server:   http://0.0.0.0:${globalConfig.port || DEFAULT_PORT}`);
  console.log(`\nNext steps:`);
  console.log(`  parachute vault status        — check everything is running`);
  console.log(`  parachute vault config        — view/edit configuration`);
  console.log(`  parachute vault create <name> — create another vault`);
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

    console.log();
    console.log("Transcription (which engine transcribes audio):");
    console.log("  TRANSCRIBE_PROVIDER  — parakeet-mlx, groq, openai");
    console.log("  GROQ_API_KEY         — for Groq transcription");
    console.log("  OPENAI_API_KEY       — for OpenAI transcription");
    console.log();
    console.log("Cleanup (which LLM cleans up transcripts):");
    console.log("  CLEANUP_PROVIDER     — claude, openai, gemini, groq, ollama, custom, none");
    console.log("  ANTHROPIC_API_KEY    — for Claude cleanup");
    console.log("  OPENAI_API_KEY       — for OpenAI cleanup");
    console.log("  GEMINI_API_KEY       — for Gemini cleanup");
    console.log("  OLLAMA_MODEL         — Ollama model (default: llama3.1)");
    console.log("  OLLAMA_URL           — Ollama server URL");
    console.log("  CLEANUP_URL          — custom OpenAI-compatible endpoint");
    console.log("  CLEANUP_API_KEY      — custom endpoint API key");
    console.log("  CLEANUP_MODEL        — override model for any provider");
    console.log();
    console.log("Example:");
    console.log("  parachute vault config set CLEANUP_PROVIDER claude");
    console.log("  parachute vault config set ANTHROPIC_API_KEY sk-ant-...");
    console.log("  parachute vault restart");
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

async function cmdServe() {
  await import("./server.ts");
}

async function cmdRestart() {
  console.log("Restarting daemon...");
  await restartAgent();
  console.log("Done.");
}

async function cmdStatus() {
  loadEnvFile();
  const loaded = await isAgentLoaded();
  const vaults = listVaults();
  const globalConfig = readGlobalConfig();
  const scribe = await getScribeStatus();

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

  // Transcription
  console.log();
  if (scribe.available) {
    console.log(`  Transcription:  ${scribe.activeTranscriber}`);
    console.log(`  Cleanup:        ${scribe.activeCleaner}`);
    console.log(`  Providers:      ${scribe.transcription.join(", ")}`);
  } else {
    console.log(`  Transcription:  not available`);
    console.log(`                  bun add parachute-scribe to enable`);
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

function installMcpConfig() {
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

  // Single HTTP MCP entry
  config.mcpServers["parachute-vault"] = {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
  };

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

Keys:
  parachute vault keys                     List all API keys
  parachute vault keys create              Create a global key
  parachute vault keys create --vault work Create a per-vault key
  parachute vault keys create --read-only  Create a read-only key
  parachute vault keys create --label phone  Set a label
  parachute vault keys revoke <key-id>     Revoke a key

Config:
  parachute vault config                   Show current configuration
  parachute vault config set <key> <val>   Set a config value
  parachute vault config unset <key>       Remove a config value

Server:
  parachute vault serve                    Run server (foreground)
  parachute vault restart                  Restart the daemon
`);
}
