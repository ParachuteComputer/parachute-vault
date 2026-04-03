#!/usr/bin/env bun
/**
 * Parachute Vault CLI.
 *
 * Usage:
 *   parachute vault init              — initialize ~/.parachute, seed default vault, install daemon
 *   parachute vault create <name>     — create a new vault
 *   parachute vault list              — list all vaults
 *   parachute vault mcp-install <name> — add vault MCP to ~/.claude.json
 *   parachute vault remove <name>     — remove a vault
 *   parachute vault serve             — run the server (foreground)
 */

import { resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";
import {
  ensureConfigDirSync,
  readVaultConfig,
  writeVaultConfig,
  readGlobalConfig,
  writeGlobalConfig,
  listVaults,
  vaultDir,
  vaultConfigPath,
  generateApiKey,
  hashKey,
  DEFAULT_PORT,
  CONFIG_DIR,
  VAULTS_DIR,
} from "./config.ts";
import type { VaultConfig } from "./config.ts";
import { installAgent, uninstallAgent, isAgentLoaded } from "./launchd.ts";

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
  case "serve":
    await cmdServe();
    break;
  case "status":
    await cmdStatus();
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

  // Create default vault if none exist
  const vaults = listVaults();
  if (vaults.length === 0) {
    console.log("Creating default vault...");
    const key = createVault("default", "Default vault");
    console.log(`  Vault: default`);
    console.log(`  API key: ${key}`);
    console.log(`  Save this key — it will not be shown again.`);
    console.log();
  }

  // Write global config
  const globalConfig = readGlobalConfig();
  if (!globalConfig.default_vault) {
    globalConfig.default_vault = "default";
    writeGlobalConfig(globalConfig);
  }

  // Install launchd agent
  console.log("Installing launchd agent...");
  await installAgent();
  console.log(`  Label: computer.parachute.vault`);
  console.log(`  Server: http://127.0.0.1:${globalConfig.port}`);
  console.log();

  // Install MCP for default vault
  const defaultVault = globalConfig.default_vault ?? "default";
  installMcpConfig(defaultVault);
  console.log(`Added MCP server "parachute-vault" to ~/.claude.json`);
  console.log();
  console.log("Parachute Vault initialized.");
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
  const description = args.slice(1).join(" ") || undefined;
  const key = createVault(name, description);

  console.log(`Vault "${name}" created.`);
  console.log(`  Path: ${vaultDir(name)}`);
  console.log(`  API key: ${key}`);
  console.log(`  Save this key — it will not be shown again.`);
  console.log();
  console.log(`To add MCP to Claude: parachute vault mcp-install ${name}`);
}

function cmdList() {
  const vaults = listVaults();
  if (vaults.length === 0) {
    console.log("No vaults found. Run: parachute vault init");
    return;
  }

  console.log("Vaults:\n");
  for (const name of vaults) {
    const config = readVaultConfig(name);
    const keys = config?.api_keys.length ?? 0;
    const desc = config?.description ? ` — ${config.description}` : "";
    console.log(`  ${name}${desc}`);
    console.log(`    Path: ${vaultDir(name)}`);
    console.log(`    Keys: ${keys}`);
    console.log(`    Created: ${config?.created_at ?? "unknown"}`);
    console.log();
  }
}

function cmdMcpInstall(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: parachute vault mcp-install <name>");
    process.exit(1);
  }

  const config = readVaultConfig(name);
  if (!config) {
    console.error(`Vault "${name}" not found. Run: parachute vault create ${name}`);
    process.exit(1);
  }

  installMcpConfig(name);
  console.log(`Added MCP server "parachute-vault/${name}" to ~/.claude.json`);
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

  // Check for --yes / -y flag
  const force = args.includes("--yes") || args.includes("-y");
  if (!force) {
    console.log(`This will permanently delete vault "${name}" and all its data.`);
    console.log(`  Path: ${vaultDir(name)}`);
    console.log(`\nTo confirm, run: parachute vault remove ${name} --yes`);
    return;
  }

  rmSync(vaultDir(name), { recursive: true, force: true });

  // Remove from ~/.claude.json
  removeMcpConfig(name);

  console.log(`Vault "${name}" removed.`);
}

async function cmdServe() {
  // Import and run the server directly
  await import("./server.ts");
}

async function cmdStatus() {
  const loaded = await isAgentLoaded();
  const vaults = listVaults();
  const globalConfig = readGlobalConfig();

  console.log("Parachute Vault Status\n");
  console.log(`  Config: ${CONFIG_DIR}`);
  console.log(`  Port: ${globalConfig.port}`);
  console.log(`  Daemon: ${loaded ? "running" : "stopped"}`);
  console.log(`  Vaults: ${vaults.length}`);

  if (vaults.length > 0) {
    console.log();
    for (const name of vaults) {
      const config = readVaultConfig(name);
      console.log(`    ${name} (${config?.api_keys.length ?? 0} keys)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createVault(name: string, description?: string): string {
  const { fullKey, keyId } = generateApiKey();
  const config: VaultConfig = {
    name,
    description,
    api_keys: [
      {
        id: keyId,
        label: "default",
        key_hash: hashKey(fullKey),
        created_at: new Date().toISOString(),
      },
    ],
    created_at: new Date().toISOString(),
  };
  writeVaultConfig(config);
  return fullKey;
}

function installMcpConfig(vaultName: string) {
  const claudeJsonPath = resolve(homedir(), ".claude.json");
  let config: any = {};
  if (existsSync(claudeJsonPath)) {
    try {
      config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    } catch {}
  }

  if (!config.mcpServers) config.mcpServers = {};

  const mcpStdioPath = resolve(dirname(import.meta.path), "mcp-stdio.ts");
  const bunPath = Bun.which("bun") || resolve(homedir(), ".bun", "bin", "bun");

  config.mcpServers[`parachute-vault/${vaultName}`] = {
    command: bunPath,
    args: [mcpStdioPath, vaultName],
  };

  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");
}

function removeMcpConfig(vaultName: string) {
  const claudeJsonPath = resolve(homedir(), ".claude.json");
  if (!existsSync(claudeJsonPath)) return;
  try {
    const config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    if (config.mcpServers?.[`parachute-vault/${vaultName}`]) {
      delete config.mcpServers[`parachute-vault/${vaultName}`];
      writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");
    }
  } catch {}
}

function usage() {
  console.log(`
Parachute Vault — Agent-native knowledge graph

Usage:
  parachute vault init                  Initialize Parachute Vault
  parachute vault create <name> [desc]  Create a new vault
  parachute vault list                  List all vaults
  parachute vault mcp-install <name>    Add vault MCP to ~/.claude.json
  parachute vault remove <name> [--yes] Remove a vault
  parachute vault serve                 Run the server (foreground)
  parachute vault status                Show status
  parachute vault help                  Show this help
`);
}
