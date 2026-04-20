#!/usr/bin/env bun

/**
 * Parachute Vault CLI.
 *
 * Usage:
 *   parachute-vault init                    — set up everything, one command
 *   parachute-vault create <name>           — create a new vault
 *   parachute-vault list                    — list all vaults
 *   parachute-vault mcp-install <name>      — add vault MCP to ~/.claude.json
 *   parachute-vault remove <name>           — remove a vault
 *   parachute-vault config                  — show all config
 *   parachute-vault config set <key> <val>  — set a config value
 *   parachute-vault config unset <key>      — remove a config value
 *   parachute-vault serve                   — run the server (foreground)
 *   parachute-vault status                  — show full status
 */

import { resolve } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";
// JSON import — resolved at module load, works for both dev runs
// (`bun src/cli.ts …`) and the published package (`bunx @openparachute/vault`)
// because package.json ships at the root next to src/.
import pkg from "../package.json" with { type: "json" };
import {
  ensureConfigDirSync,
  migrateFromLegacyLayout,
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
  DEFAULT_PORT,
  CONFIG_DIR,
  ASSETS_DIR,
  ENV_PATH,
  LOG_PATH,
  ERR_PATH,
  GLOBAL_CONFIG_PATH,
} from "./config.ts";
import type { VaultConfig } from "./config.ts";
import { DATA_DIR } from "./config.ts";
import { installAgent, uninstallAgent, isAgentLoaded, restartAgent } from "./launchd.ts";
import { chooseMcpUrl } from "./mcp-install.ts";
import {
  runBackup,
  readLastBackup,
  nextRunEstimate,
  updateBackupConfig,
  expandTilde,
  checkDestinationWritable,
  tierTally,
} from "./backup.ts";
import {
  installBackupAgent,
  uninstallBackupAgent,
  isBackupAgentLoaded,
  BACKUP_PLIST_PATH,
} from "./backup-launchd.ts";
import { defaultBackupConfig } from "./config.ts";
import type { BackupSchedule } from "./config.ts";
import { installSystemdService, uninstallSystemdService, restartSystemdService, isSystemdAvailable, isServiceActive } from "./systemd.ts";
import { checkHealth, waitForHealthy, tailFile } from "./health.ts";
import type { HealthResult } from "./health.ts";
import {
  WRAPPER_PATH,
  SERVER_PATH_FILE,
  readServerPathPointer,
  removeDaemonWrapper,
  resolveServerPath,
} from "./daemon.ts";
import { confirm, ask, askPassword, choose } from "./prompt.ts";
import { generateToken, createToken, listTokens, revokeToken, migrateVaultKeys } from "./token-store.ts";
import type { TokenPermission } from "./token-store.ts";
import { getVaultStore } from "./vault-store.ts";
import { upsertService, ServicesManifestError } from "./services-manifest.ts";
import {
  hasOwnerPassword,
  setOwnerPassword,
  clearOwnerPassword,
  validatePasswordStrength,
  getOwnerPasswordHash,
  verifyOwnerPassword,
} from "./owner-auth.ts";
import {
  enrollTotp,
  disableTotp,
  hasTotpEnrolled,
  regenerateBackupCodes,
  getBackupCodeCount,
  verifyTotpCode,
  verifyAndConsumeBackupCode,
  getTotpSecret,
} from "./two-factor.ts";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

// Support both `parachute-vault <cmd>` and `parachute <cmd>` patterns
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

// Pre-0.3 installs kept vault state directly under ~/.parachute/. Run the
// migration unconditionally so any command (including read-only ones like
// `doctor` and `url`) picks up the relocated state on first post-upgrade run.
// No-op when no legacy paths exist. Skipped for `help` and `version`, which
// are expected to produce *only* their documented output — and because scripts
// piping `parachute-vault --version` shouldn't get migration chatter on stderr.
const SKIP_MIGRATION = new Set(["help", "--help", "-h", "version", "--version", "-v"]);
if (!SKIP_MIGRATION.has(command)) {
  migrateFromLegacyLayout();
}

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
  case "tokens":
    cmdTokens(cmdArgs);
    break;
  case "set-password":
    await cmdSetPassword(cmdArgs);
    break;
  case "2fa":
    await cmd2fa(cmdArgs);
    break;
  case "serve":
    await cmdServe();
    break;
  case "logs":
    await cmdLogs();
    break;
  case "status":
    await cmdStatus();
    break;
  case "restart":
    await cmdRestart();
    break;
  case "uninstall":
    await cmdUninstall(cmdArgs);
    break;
  case "doctor":
    await cmdDoctor();
    break;
  case "url":
    cmdUrl();
    break;
  case "backup":
    await cmdBackup(cmdArgs);
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
  case "version":
  case "--version":
  case "-v":
    // Intentionally minimal — just the version string on stdout. Scripts
    // (and `parachute-vault doctor` in a future check) rely on this being
    // a bare-number line; anything else belongs in `vault status`.
    console.log(pkg.version);
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

  // 2. Write global config. Set default_vault to the lone existing vault
  // when unset or stale — this keeps unscoped routes (/mcp, /api/*) working
  // for users who bootstrapped with `vault create <name>` before running init.
  const globalConfig = readGlobalConfig();
  const allVaults = listVaults();
  const needsDefault = !globalConfig.default_vault
    || !allVaults.includes(globalConfig.default_vault);
  if (needsDefault) {
    if (allVaults.length === 1) {
      globalConfig.default_vault = allVaults[0];
    } else if (allVaults.includes("default")) {
      globalConfig.default_vault = "default";
    } else if (allVaults.length > 0) {
      // Multi-vault, no safe fallback — don't guess. Operator must set it.
      console.log(
        `  No default_vault set and multiple vaults exist. Unscoped routes (/mcp) will error until you set one.`,
      );
      console.log(
        `  Fix:  echo 'default_vault: <name>' >> ${CONFIG_DIR}/config.yaml`,
      );
    } else {
      // We created "default" above (vaults.length === 0 branch).
      globalConfig.default_vault = "default";
    }
  }
  writeGlobalConfig(globalConfig);

  // 2a. Register in the shared services manifest so the @openparachute/cli
  // dispatcher can discover this service and its health endpoint. Upserts
  // by name, preserving entries for other services. Non-fatal on failure —
  // init can complete without the manifest, just with a warning.
  //
  // `paths[0]` is the canonical mount point — CLI uses it for the
  // `.well-known/parachute.json` URL and for `parachute expose`. Advertise
  // `/vault/<default_vault>` so MCP clients land at the scoped endpoint.
  // When no default vault exists yet (multi-vault, no fallback), fall back
  // to "/" — the CLI can detect and prompt.
  const servicePath = globalConfig.default_vault
    ? `/vault/${globalConfig.default_vault}`
    : "/";
  try {
    upsertService({
      name: "parachute-vault",
      port: globalConfig.port || DEFAULT_PORT,
      paths: [servicePath],
      health: "/health",
      version: pkg.version,
    });
  } catch (err) {
    const msg = err instanceof ServicesManifestError ? err.message : String(err);
    console.log(`  Warning: could not update ~/.parachute/services.json: ${msg}`);
  }

  // 2b. Migrate existing legacy keys into per-vault token tables
  for (const v of listVaults()) {
    try {
      const vc = readVaultConfig(v);
      if (!vc) continue;
      const store = getVaultStore(v);
      migrateVaultKeys(store.db, vc.api_keys, globalConfig.api_keys);
    } catch (err) {
      console.error(`  Warning: could not migrate keys for vault "${v}":`, err);
    }
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

  // 5b. Offer to set an owner password for OAuth consent, unless one is already set.
  if (!hasOwnerPassword()) {
    await promptForOwnerPassword("Set an owner password for OAuth consent?");
  }

  // 6. Install daemon (platform-aware). Idempotent — safe to re-run after
  // a folder move; this refreshes ~/.parachute/server-path and bounces the
  // daemon so the new location takes effect immediately.
  console.log("Installing daemon...");
  let serverPath: string | null = null;
  if (isMac) {
    ({ serverPath } = await installAgent());
  } else if (isLinux && isSystemdAvailable()) {
    ({ serverPath } = await installSystemdService());
  } else {
    console.log("  Auto-start not available on this platform.");
    console.log("  Run manually: bun src/server.ts");
    console.log("  Or use Docker: docker compose up -d");
  }
  if (serverPath) {
    console.log(`  Server path:  ${serverPath}`);
    console.log(`  Wrapper:      ~/.parachute/vault/start.sh`);
  }
  console.log(`  Listening on http://0.0.0.0:${globalConfig.port || DEFAULT_PORT}`);

  // 7. Install MCP for Claude Code (with token for auth)
  installMcpConfig(apiKey);
  console.log(`  MCP server added to ~/.claude.json`);

  // 8. Summary
  console.log("\n---");
  const port = globalConfig.port || DEFAULT_PORT;
  if (apiKey) {
    console.log(`\nYour API token: ${apiKey}`);
    console.log("  Use this in Claude Desktop, curl, or any client.");
    console.log("  Pass via: Authorization: Bearer <token>");
    console.log("  Or via:   X-API-Key: <token>");
    console.log("\nSave this — it will not be shown again.");
  }

  console.log(`\nConfig:   ${CONFIG_DIR}`);
  console.log(`Server:   http://0.0.0.0:${port}`);

  console.log(`\nUsage examples:`);
  console.log(`  curl http://localhost:${port}/health`);
  if (apiKey) {
    console.log(`  curl -H "Authorization: Bearer ${apiKey}" http://localhost:${port}/api/notes`);
  }

  console.log(`\nNext steps:`);
  console.log(`  parachute-vault status            check everything is running`);
  console.log(`  parachute-vault config             view/edit configuration`);
}

async function promptForOwnerPassword(purpose: string): Promise<boolean> {
  console.log(`\n${purpose}`);
  console.log("  Used on the OAuth consent page to authorize third-party clients");
  console.log("  (Claude Web, Claude Desktop, etc.) to access this vault.");
  console.log(`  Minimum 12 characters.\n`);

  while (true) {
    const pw = await askPassword("  Password (or leave blank to skip)");
    if (!pw) {
      console.log("  Skipped — you can set one later with `parachute-vault set-password`.");
      return false;
    }

    const err = validatePasswordStrength(pw);
    if (err) {
      console.log(`  ${err} Try again.`);
      continue;
    }

    const confirmPw = await askPassword("  Confirm password");
    if (pw !== confirmPw) {
      console.log("  Passwords don't match. Try again.");
      continue;
    }

    await setOwnerPassword(pw);
    console.log("  Password set.");
    return true;
  }
}

async function cmdSetPassword(args: string[]) {
  const wantsClear = args.includes("--clear") || args.includes("--unset");
  if (wantsClear) {
    if (!hasOwnerPassword()) {
      console.log("No owner password is set.");
      return;
    }
    const twoFaNote = hasTotpEnrolled()
      ? " Note: 2FA management operations will require your authenticator app or a backup code instead."
      : "";
    const ok = await confirm(
      `Remove the owner password? OAuth consent will fall back to vault-token auth.${twoFaNote}`,
      false,
    );
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
    clearOwnerPassword();
    console.log("Owner password cleared.");
    return;
  }

  const purpose = hasOwnerPassword()
    ? "Change owner password"
    : "Set owner password";
  await promptForOwnerPassword(purpose);
}

// ---------------------------------------------------------------------------
// 2FA — parachute-vault 2fa [enroll | disable | backup-codes | status]
// ---------------------------------------------------------------------------

async function confirmOwnerPassword(purpose: string): Promise<boolean> {
  const hash = getOwnerPasswordHash();
  if (!hash) {
    console.error("No owner password is set. Run: parachute-vault set-password");
    return false;
  }
  console.log(purpose);
  const pw = await askPassword("  Current password");
  if (!pw) {
    console.log("  Cancelled.");
    return false;
  }
  const ok = await verifyOwnerPassword(pw, hash);
  if (!ok) {
    console.error("  Incorrect password.");
    return false;
  }
  return true;
}

/**
 * Confirm ownership for 2FA-management commands. Prefers the password when
 * one is set; otherwise falls back to a TOTP or backup code so the owner
 * isn't locked out if they cleared the password while 2FA was still enrolled.
 */
async function confirmForTwoFactor(purpose: string): Promise<boolean> {
  if (hasOwnerPassword()) {
    return confirmOwnerPassword(purpose);
  }
  // Fallback path: no password, must prove via current TOTP or backup code.
  const secret = getTotpSecret();
  if (!secret) {
    console.error("2FA is not enabled.");
    return false;
  }
  console.log(purpose);
  console.log("  (No owner password set — confirm with an authenticator code or a backup code.)");
  const totp = (await ask("  Authenticator code (blank to use a backup code)")).trim();
  if (totp) {
    if (verifyTotpCode(secret, totp)) return true;
    console.error("  Invalid authenticator code.");
    return false;
  }
  console.log("  This will consume one of your backup codes.");
  const backup = (await ask("  Backup code")).trim();
  if (!backup) {
    console.log("  Cancelled.");
    return false;
  }
  const ok = await verifyAndConsumeBackupCode(backup);
  if (!ok) {
    console.error("  Invalid or already-used backup code.");
    return false;
  }
  console.log("  (Backup code consumed.)");
  return true;
}

async function cmd2fa(args: string[]) {
  const sub = args[0] ?? "status";

  if (sub === "status") {
    if (hasTotpEnrolled()) {
      console.log(`2FA: enabled (${getBackupCodeCount()} backup code(s) remaining)`);
    } else {
      console.log("2FA: not enabled");
      console.log("  Enable with: parachute-vault 2fa enroll");
    }
    return;
  }

  if (sub === "enroll") {
    if (!hasOwnerPassword()) {
      console.error("Set an owner password first: parachute-vault set-password");
      process.exit(1);
    }
    if (hasTotpEnrolled()) {
      const ok = await confirm("2FA is already enabled. Re-enroll (invalidates existing authenticator + backup codes)?", false);
      if (!ok) {
        console.log("Cancelled.");
        return;
      }
    }
    if (!(await confirmOwnerPassword("Confirm your owner password to enroll 2FA:"))) {
      process.exit(1);
    }

    const result = await enrollTotp();
    // qrcode-terminal ships no types; shape: { generate(text, {small}, cb) }.
    const qrcode = (await import("qrcode-terminal")).default as {
      generate: (text: string, opts: { small: boolean }, cb: (q: string) => void) => void;
    };

    console.log("\nScan this QR code with your authenticator app:\n");
    await new Promise<void>((resolve) => {
      qrcode.generate(result.otpauthUrl, { small: true }, (q: string) => {
        console.log(q);
        resolve();
      });
    });
    console.log(`Or enter this secret manually:\n  ${result.secret}\n`);

    // Confirmation step: require a code from the newly-enrolled app before
    // we consider enrollment final. Protects against the user scanning wrong
    // and locking themselves out.
    let confirmed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const entered = (await ask("Enter the 6-digit code from your authenticator to confirm")).trim();
      // markUsed=false — don't consume the code here; the user may need it
      // again immediately for the consent page.
      if (verifyTotpCode(result.secret, entered, false)) {
        confirmed = true;
        break;
      }
      console.log(`  Incorrect code. (${2 - attempt} attempt(s) left)`);
    }
    if (!confirmed) {
      console.error("Enrollment failed — rolling back. Re-run `parachute-vault 2fa enroll` to try again.");
      disableTotp();
      process.exit(1);
    }

    console.log("\nBackup codes (single-use; store somewhere safe — they are NOT retrievable):");
    for (const code of result.backupCodes) {
      console.log(`  ${code}`);
    }
    console.log("\n2FA is now active for OAuth consent on this vault.");
    return;
  }

  if (sub === "disable") {
    if (!hasTotpEnrolled()) {
      console.log("2FA is not enabled.");
      return;
    }
    if (!(await confirmForTwoFactor("Confirm ownership to disable 2FA:"))) {
      process.exit(1);
    }
    disableTotp();
    console.log("2FA disabled. Backup codes cleared.");
    return;
  }

  if (sub === "backup-codes") {
    if (!hasTotpEnrolled()) {
      console.error("2FA is not enabled. Run: parachute-vault 2fa enroll");
      process.exit(1);
    }
    if (!(await confirmForTwoFactor("Confirm ownership to regenerate backup codes:"))) {
      process.exit(1);
    }
    const codes = await regenerateBackupCodes();
    console.log("\nNew backup codes (previous codes are now invalid):");
    for (const code of codes) {
      console.log(`  ${code}`);
    }
    return;
  }

  console.error(`Unknown 2fa command: ${sub}`);
  console.error("Usage: parachute-vault 2fa [status | enroll | disable | backup-codes]");
  process.exit(1);
}

function cmdCreate(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: parachute-vault create <name>");
    process.exit(1);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error("Vault name must contain only letters, numbers, hyphens, and underscores.");
    process.exit(1);
  }
  if (name === "list") {
    // Reserved — keeps the "list" vault name out of play even though per-vault
    // routes now live under /vault/<name>/ and no longer collide with the
    // /vaults/list discovery endpoint.
    console.error(`"list" is a reserved vault name.`);
    process.exit(1);
  }

  const existing = readVaultConfig(name);
  if (existing) {
    console.error(`Vault "${name}" already exists.`);
    process.exit(1);
  }

  ensureConfigDirSync();
  const wasFirst = listVaults().length === 0;
  const key = createVault(name);

  // If this is the only vault now, make it the default so unscoped routes
  // (/mcp, /api/*, /oauth/*) target it. Avoids the "single vault named
  // 'journal' but /mcp returns 404" surprise.
  const globalConfig = readGlobalConfig();
  const needsDefault = !globalConfig.default_vault
    || !listVaults().includes(globalConfig.default_vault);
  let defaultNote: string | null = null;
  if (needsDefault) {
    globalConfig.default_vault = name;
    writeGlobalConfig(globalConfig);
    defaultNote = wasFirst
      ? `Set as default vault (unscoped routes will target "${name}")`
      : `Set as default vault (previous default was missing)`;
  }

  console.log(`Vault "${name}" created.`);
  console.log(`  Path: ${vaultDir(name)}`);
  console.log(`  API token: ${key}`);
  console.log(`  Save this — it will not be shown again.`);
  if (defaultNote) {
    console.log(`  ${defaultNote}`);
  }
  console.log();
  console.log(`To add MCP to Claude: parachute-vault mcp-install ${name}`);
}

function cmdList() {
  const vaults = listVaults();
  if (vaults.length === 0) {
    console.log("No vaults. Run: parachute-vault init");
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
    console.error("Usage: parachute-vault remove <name>");
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
    console.log(`\nTo confirm: parachute-vault remove ${name} --yes`);
    return;
  }

  rmSync(vaultDir(name), { recursive: true, force: true });
  console.log(`Vault "${name}" removed.`);

  // Keep default_vault in sync. If the removed vault was the default, either
  // promote the remaining vault (if exactly one) or clear the setting.
  const globalConfig = readGlobalConfig();
  if (globalConfig.default_vault === name) {
    const remaining = listVaults();
    if (remaining.length === 1) {
      globalConfig.default_vault = remaining[0];
      writeGlobalConfig(globalConfig);
      console.log(`  Default vault is now "${remaining[0]}".`);
    } else {
      delete globalConfig.default_vault;
      writeGlobalConfig(globalConfig);
      if (remaining.length > 1) {
        console.log(`  Cleared default_vault — set one with: editor ${CONFIG_DIR}/config.yaml`);
      }
    }
  }
}

async function cmdConfig(args: string[]) {
  const subcmd = args[0];

  // parachute-vault config — show current config
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
      console.log("  No env vars set. Use: parachute-vault config set <key> <value>");
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

  // parachute-vault config set <key> <value>
  if (subcmd === "set") {
    const key = args[1];
    const value = args.slice(2).join(" ");
    if (!key || !value) {
      console.error("Usage: parachute-vault config set <key> <value>");
      process.exit(1);
    }
    setEnvVar(key, value);
    console.log(`Set ${key}=${key.includes("KEY") ? value.slice(0, 8) + "..." : value}`);
    console.log("Restart the daemon to apply: parachute-vault restart");
    return;
  }

  // parachute-vault config unset <key>
  if (subcmd === "unset") {
    const key = args[1];
    if (!key) {
      console.error("Usage: parachute-vault config unset <key>");
      process.exit(1);
    }
    unsetEnvVar(key);
    console.log(`Removed ${key}`);
    console.log("Restart the daemon to apply: parachute-vault restart");
    return;
  }

  console.error(`Unknown config command: ${subcmd}`);
  console.error("Usage: parachute-vault config [set <key> <value> | unset <key>]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Tokens — parachute-vault tokens [create | list | revoke]
// ---------------------------------------------------------------------------

function cmdTokens(args: string[]) {
  const subcmd = args[0];

  // parachute-vault tokens — list all tokens (across all vaults)
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
        const expiry = t.expires_at ? ` (expires: ${t.expires_at})` : "";
        const lastUsed = t.last_used_at ? ` (last used: ${t.last_used_at})` : "";
        console.log(`  ${t.id}  ${t.label}  [${t.permission}]${expiry}${lastUsed}`);
      }
      console.log();
    }

    if (!anyTokens) {
      console.log("No tokens found. Create one: parachute-vault tokens create");
    }
    return;
  }

  // parachute-vault tokens create --vault <name> [--permission full|read]
  //   [--expires <duration>] [--label <label>]
  if (subcmd === "create") {
    const vaultFlag = args.indexOf("--vault");
    const vaultName = vaultFlag !== -1 ? args[vaultFlag + 1] : (readGlobalConfig().default_vault || "default");

    const vc = readVaultConfig(vaultName);
    if (!vc) {
      console.error(`Vault "${vaultName}" not found.`);
      process.exit(1);
    }

    // --read shorthand or --permission full|read
    const isReadShorthand = args.includes("--read");
    const permFlag = args.indexOf("--permission");
    const rawPerm = isReadShorthand ? "read" : (permFlag !== -1 ? args[permFlag + 1] : "full");
    const permission: TokenPermission = rawPerm === "read" ? "read" : "full";
    if (!["full", "read", "admin", "write"].includes(rawPerm)) {
      console.error(`Invalid permission: ${rawPerm}. Must be full or read.`);
      process.exit(1);
    }

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
      expires_at: expiresAt,
    });

    console.log(`Created token for vault "${vaultName}":`);
    console.log(`  Token:      ${fullToken}`);
    console.log(`  Permission: ${permission}`);
    if (expiresAt) console.log(`  Expires:    ${expiresAt}`);
    console.log(`  Label:      ${label}`);
    console.log();
    console.log("Save this token — it will not be shown again.");
    return;
  }

  // parachute-vault tokens revoke <token-id> --vault <name>
  if (subcmd === "revoke") {
    const tokenId = args[1];
    if (!tokenId) {
      console.error("Usage: parachute-vault tokens revoke <token-id> --vault <name>");
      process.exit(1);
    }

    const vaultFlag = args.indexOf("--vault");
    const vaultName = vaultFlag !== -1 ? args[vaultFlag + 1] : (readGlobalConfig().default_vault || "default");

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
  console.error("Usage: parachute-vault tokens [create | list | revoke <id>]");
  process.exit(1);
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

async function cmdLogs() {
  const proc = Bun.spawn(["tail", "-f", LOG_PATH, ERR_PATH], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}

async function cmdRestart() {
  loadEnvFile();
  const port = readGlobalConfig().port || DEFAULT_PORT;

  console.log("Restarting daemon...");
  if (process.platform === "darwin") {
    await restartAgent();
  } else if (isSystemdAvailable()) {
    await restartSystemdService();
  } else {
    console.error("No daemon manager available. Restart manually or use Docker.");
    process.exit(1);
  }

  process.stdout.write("Waiting for /health ");
  // Dot-progress only to interactive terminals so piped output stays clean.
  const interval = process.stdout.isTTY
    ? setInterval(() => process.stdout.write("."), 500)
    : null;
  const health = await waitForHealthy(port, { totalMs: 10_000 });
  if (interval) clearInterval(interval);
  process.stdout.write("\n");

  if (health.status === "healthy") {
    console.log(`Vault is healthy at http://127.0.0.1:${port} (${health.latencyMs}ms)`);
    return;
  }

  console.error(`Vault did not come up within 10s — status: ${health.status}${health.error ? ` (${health.error})` : ""}`);
  printErrLogTail(20);
  process.exit(1);
}

async function cmdStatus() {
  loadEnvFile();
  const globalConfig = readGlobalConfig();
  const port = globalConfig.port || DEFAULT_PORT;
  const vaults = listVaults();

  // Three distinct states:
  //   loaded — launchd/systemd believes the agent is running
  //   health — what the HTTP server at <port> actually responds with
  let loaded: boolean | "n/a";
  if (process.platform === "darwin") {
    loaded = await isAgentLoaded();
  } else if (isSystemdAvailable()) {
    loaded = await isServiceActive();
  } else {
    loaded = "n/a"; // no daemon manager on this platform
  }
  const health = await checkHealth(port);

  console.log("Parachute Vault\n");
  console.log(`  Daemon:   ${renderLoaded(loaded)}`);
  console.log(`  Server:   ${renderHealth(health, port)}`);
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

  // If loaded but not healthy, surface the recent error log. This is the
  // "daemon is running but wedged" case that bit us when start.sh pointed
  // at a moved repo — launchctl said it was loaded, the port was closed,
  // and the cause was sitting in vault.err.
  if (loaded === true && health.status !== "healthy") {
    printErrLogTail(20);
  }
}

function renderLoaded(loaded: boolean | "n/a"): string {
  if (loaded === "n/a") return "(no daemon manager on this platform)";
  if (!loaded) return "not loaded";
  // Keep the manager name honest per-platform so Linux users don't see
  // "launchctl" in their status output.
  const manager = process.platform === "darwin" ? "launchctl" : "systemd";
  return `loaded (${manager})`;
}

function renderHealth(h: HealthResult, port: number): string {
  switch (h.status) {
    case "healthy":
      return `healthy — http://127.0.0.1:${port} (${h.latencyMs}ms)`;
    case "unhealthy":
      return `responding but unhealthy — HTTP ${h.statusCode} on port ${port}`;
    case "not-listening":
      return `not listening — nothing bound to port ${port}`;
    case "error":
      return `unreachable — ${h.error ?? "unknown error"}`;
  }
}

function printErrLogTail(n: number) {
  const tail = tailFile(ERR_PATH, n);
  console.log(`\n  Recent errors from ${ERR_PATH}:`);
  if (tail === null) {
    console.log(`    (no log file at ${ERR_PATH})`);
    return;
  }
  if (tail === "") {
    console.log(`    (log file is empty)`);
    return;
  }
  for (const line of tail.split("\n")) {
    console.log(`    ${line}`);
  }
}

// ---------------------------------------------------------------------------
// Uninstall / Doctor / URL
// ---------------------------------------------------------------------------

async function cmdUninstall(argsList: string[]) {
  const wipe = argsList.includes("--wipe");
  const skipPrompts = argsList.includes("--yes") || argsList.includes("-y");

  console.log("Parachute Vault uninstall\n");
  console.log("This removes the daemon registration and wrapper script.");
  if (wipe) {
    console.log("`--wipe` will ALSO remove vaults, .env, config.yaml, and daemon logs.\n");
  } else {
    console.log("User data (~/.parachute/vault/) is left alone.\n");
  }

  // Scripted `--yes --wipe` bypasses both interactive confirms. That's the
  // intended contract for unattended uninstalls, but it should not be
  // silent — print a single audit line so logs show when a destructive
  // wipe ran and which paths it targeted. Non-interactive callers won't
  // miss this; interactive users already see the prompts.
  if (skipPrompts && wipe) {
    const ts = new Date().toISOString();
    const targets = [DATA_DIR, ENV_PATH, GLOBAL_CONFIG_PATH, LOG_PATH, ERR_PATH].join(", ");
    console.log(`[${ts}] scripted destructive wipe: ${targets}`);
  }

  if (!skipPrompts) {
    const ok = await confirm("Proceed?");
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  // 1. Stop and remove the daemon registration.
  if (process.platform === "darwin") {
    console.log("Removing launchd agent...");
    await uninstallAgent();
    // Scheduled backup agent lives in a separate plist — uninstall it too,
    // otherwise `uninstall` leaves the backup job firing forever on an
    // install whose daemon has been removed.
    await uninstallBackupAgent();
  } else if (isSystemdAvailable()) {
    console.log("Removing systemd service...");
    await uninstallSystemdService();
  } else {
    console.log("No daemon manager on this platform — skipping service removal.");
  }

  // 2. Remove wrapper + pointer file (shared across platforms).
  console.log("Removing wrapper and server-path pointer...");
  await removeDaemonWrapper();

  // 3. Clear the MCP entry in ~/.claude.json so Claude Code doesn't keep
  // retrying a dead server every session. If ~/.claude.json doesn't exist
  // or has no matching entry, this is a silent no-op.
  console.log("Removing MCP entry from ~/.claude.json...");
  removeMcpConfig();

  // 4. Optionally wipe user data. The second confirm below defaults to
  // NO so a distracted Enter-presser can't lose their vault. `--yes`
  // explicitly opts into the destructive path for scripted uninstalls.
  if (wipe) {
    // Inventory what's actually on disk. Paths that don't exist are a
    // silent no-op on removal, but we also skip listing them so the
    // "would be removed" summary doesn't lie to the user.
    const vaultsExist = existsSync(DATA_DIR);
    const envExists = existsSync(ENV_PATH);
    const configExists = existsSync(GLOBAL_CONFIG_PATH);
    const logExists = existsSync(LOG_PATH);
    const errExists = existsSync(ERR_PATH);

    const anyExist = vaultsExist || envExists || configExists || logExists || errExists;
    if (!anyExist) {
      console.log("No user data to remove.");
    } else {
      console.log("\nUser data that would be removed:");
      if (vaultsExist) console.log(`  ${DATA_DIR} (per-vault SQLite data)`);
      if (envExists) console.log(`  ${ENV_PATH} (.env config + secrets)`);
      if (configExists) console.log(`  ${GLOBAL_CONFIG_PATH} (global config)`);
      if (logExists) console.log(`  ${LOG_PATH} (daemon log)`);
      if (errExists) console.log(`  ${ERR_PATH} (daemon error log)`);

      // Default to NO on the wipe confirm — this is the "don't lose a
      // vault to muscle memory" guard. `--yes` is an explicit opt-in to
      // the whole destructive path.
      let doWipe = skipPrompts;
      if (!skipPrompts) {
        doWipe = await confirm("Delete this data? (cannot be undone)", false);
      }
      if (doWipe) {
        if (vaultsExist) rmSync(DATA_DIR, { recursive: true, force: true });
        if (envExists) rmSync(ENV_PATH, { force: true });
        if (configExists) rmSync(GLOBAL_CONFIG_PATH, { force: true });
        if (logExists) rmSync(LOG_PATH, { force: true });
        if (errExists) rmSync(ERR_PATH, { force: true });
        console.log("User data removed.");
      } else {
        console.log("Kept user data.");
      }
    }
  }

  console.log("\nDone. To reinstall: `parachute-vault init`.");
}

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail?: string;
  fix?: string;
}

async function cmdDoctor() {
  const checks: DoctorCheck[] = [];

  // Pointer file. The stale-path failure mode shows up here first.
  if (!existsSync(SERVER_PATH_FILE)) {
    checks.push({
      name: "server-path pointer",
      status: "fail",
      detail: `missing: ${SERVER_PATH_FILE}`,
      fix: "Run `parachute-vault init` to create it.",
    });
  } else {
    const pointed = readServerPathPointer();
    if (!pointed) {
      checks.push({
        name: "server-path pointer",
        status: "fail",
        detail: `empty: ${SERVER_PATH_FILE}`,
        fix: "Run `parachute-vault init` to rewrite it.",
      });
    } else if (!existsSync(pointed)) {
      checks.push({
        name: "server.ts at pointer target",
        status: "fail",
        detail: `points to ${pointed}, which does not exist`,
        fix: "Run `parachute-vault init` from the current repo location.",
      });
    } else {
      checks.push({
        name: "server-path pointer",
        status: "pass",
        detail: `→ ${pointed}`,
      });
    }
  }

  // Wrapper script. Independent of the pointer — a missing wrapper means
  // launchd/systemd has nothing to exec.
  if (!existsSync(WRAPPER_PATH)) {
    checks.push({
      name: "wrapper script",
      status: "fail",
      detail: `missing: ${WRAPPER_PATH}`,
      fix: "Run `parachute-vault init`.",
    });
  } else {
    checks.push({ name: "wrapper script", status: "pass", detail: WRAPPER_PATH });
  }

  // Daemon registration.
  if (process.platform === "darwin") {
    const loaded = await isAgentLoaded();
    checks.push({
      name: "launchd agent",
      status: loaded ? "pass" : "warn",
      detail: loaded ? "loaded" : "not loaded",
      fix: loaded ? undefined : "Run `parachute-vault init` or `parachute-vault restart`.",
    });
  } else if (isSystemdAvailable()) {
    const active = await isServiceActive();
    checks.push({
      name: "systemd service",
      status: active ? "pass" : "warn",
      detail: active ? "active" : "not active",
      fix: active ? undefined : "Run `parachute-vault init` or `parachute-vault restart`.",
    });
  }

  // bun on PATH. Not strictly required for an already-installed vault
  // (start.sh embeds an absolute bun path at init time), but missing `bun`
  // is the #1 failure mode for first-time OSS users, so surface it clearly.
  const bunOnPath = Bun.which("bun");
  if (bunOnPath) {
    checks.push({ name: "bun on PATH", status: "pass", detail: bunOnPath });
  } else {
    checks.push({
      name: "bun on PATH",
      status: "warn",
      detail: "`bun` not resolvable via PATH",
      fix: "Install Bun: curl -fsSL https://bun.sh/install | bash (then restart your shell).",
    });
  }

  // MCP entry in ~/.claude.json. Split into three separate checks so the
  // user can see exactly which condition fails: "entry present", "port
  // matches vault", "daemon reachable over MCP URL". A common failure is
  // "entry exists but port is stale" after the user changed PORT without
  // re-running `mcp-install`.
  const port = resolveVaultPort();
  const mcpEntry = readMcpEntry();
  if (!mcpEntry.found) {
    checks.push({
      name: "MCP entry in ~/.claude.json",
      status: "warn",
      detail: mcpEntry.reason,
      fix: "Run `parachute-vault mcp-install` to register the vault with Claude.",
    });
  } else {
    checks.push({
      name: "MCP entry in ~/.claude.json",
      status: "pass",
      detail: mcpEntry.url,
    });

    // Port match. Fall back to a warn if the URL has no parseable port
    // (malformed entry) rather than a hard fail — we can still tell the
    // user what we saw.
    if (mcpEntry.port === port) {
      checks.push({
        name: "MCP URL port matches vault",
        status: "pass",
        detail: `port ${port}`,
      });
    } else {
      checks.push({
        name: "MCP URL port matches vault",
        status: "warn",
        detail: `MCP URL port ${mcpEntry.port ?? "(unparseable)"} ≠ vault port ${port}`,
        fix: "Re-run `parachute-vault mcp-install` to refresh the MCP URL.",
      });
    }

    // Reachability probe. We do NOT require the daemon to be up for doctor
    // to pass: a user who ran `vault status` already knows the daemon is
    // off. This line is just a bonus telltale. Treat any HTTP response
    // (even 401/404) as "reachable" — we're testing TCP+HTTP, not auth.
    const reach = await probeMcpUrl(mcpEntry.url);
    if (reach.ok) {
      checks.push({
        name: "MCP URL reachable",
        status: "pass",
        detail: reach.detail,
      });
    } else {
      checks.push({
        name: "MCP URL reachable",
        status: "warn",
        detail: reach.detail,
        fix: "Start the daemon: `parachute-vault restart` (or `init` if not yet installed).",
      });
    }
  }

  // Port collision. If something's holding the vault's configured port
  // that ISN'T our daemon, the server will fail to bind on restart — a
  // silent-until-crash-loop failure we want to catch at doctor time.
  const collision = await checkPortCollision(port);
  switch (collision.status) {
    case "free":
      checks.push({
        name: `port ${port} availability`,
        status: "pass",
        detail: "no listener (ready to bind)",
      });
      break;
    case "ours":
      checks.push({
        name: `port ${port} availability`,
        status: "pass",
        detail: `held by our daemon (pid ${collision.pids.join(", ")})`,
      });
      break;
    case "foreign":
      checks.push({
        name: `port ${port} availability`,
        status: "warn",
        detail: `port in use by non-vault process: ${collision.detail}`,
        fix: "Stop the conflicting process, or set a different PORT in ~/.parachute/vault/.env and re-run `parachute-vault init`.",
      });
      break;
    case "unknown":
      // Tool unavailable (no lsof / ss). Silent: we prefer a missing check
      // over a spurious warning on minimal Linux images.
      break;
  }

  // Backup — only verify when the user has asked for automatic backups.
  // Manual mode is the default; showing a "not loaded" check when the user
  // explicitly didn't configure scheduled backups is noise, not a finding.
  const backupCfg = readGlobalConfig().backup;
  if (backupCfg && backupCfg.schedule !== "manual") {
    // 1. Agent loaded? (macOS only — systemd path for backup lands in a
    // follow-up PR; on Linux we silently skip this half of the check.)
    if (process.platform === "darwin") {
      const loaded = await isBackupAgentLoaded();
      checks.push({
        name: "backup agent",
        status: loaded ? "pass" : "warn",
        detail: loaded ? `loaded (schedule: ${backupCfg.schedule})` : `not loaded (schedule: ${backupCfg.schedule})`,
        fix: loaded ? undefined : `Re-run \`parachute-vault backup --schedule ${backupCfg.schedule}\` to reinstall the agent.`,
      });
    }

    // 2. Destination writability. A backup agent that fires into a path that
    // doesn't exist (or is read-only) is the worst failure mode — silent
    // until the user needs the backup, then "I have no backups." We try to
    // mkdir the configured path and tap it for write access.
    if (backupCfg.destinations.length === 0) {
      checks.push({
        name: "backup destinations",
        status: "warn",
        detail: "schedule is active but no destinations configured",
        fix: "Edit ~/.parachute/vault/config.yaml and add at least one destination under `backup.destinations`.",
      });
    } else {
      for (const dest of backupCfg.destinations) {
        const res = checkDestinationWritable(dest);
        checks.push({
          name: `backup destination (${dest.kind})`,
          status: res.ok ? "pass" : "warn",
          detail: res.ok ? res.path : `${res.path}: ${res.error}`,
          fix: res.ok ? undefined : "Ensure the path exists and is writable, or update it in ~/.parachute/vault/config.yaml.",
        });
      }
    }
  }


  // Render.
  const icons = { pass: " ✓", warn: " !", fail: " ✗" } as const;
  console.log("Parachute Vault — doctor\n");
  for (const c of checks) {
    const icon = icons[c.status];
    console.log(`  ${icon} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
    if (c.fix) console.log(`       fix: ${c.fix}`);
  }

  const hasFailure = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  console.log();
  if (hasFailure) {
    console.log("doctor: problems found (exit 1). See `parachute-vault status` for runtime details.");
    process.exit(1);
  } else if (hasWarn) {
    console.log("doctor: warnings only. `parachute-vault status` has live runtime detail.");
  } else {
    console.log("doctor: all checks passed. For live runtime state: `parachute-vault status`.");
  }
}

function cmdUrl() {
  // Intentionally minimal — scripts parse this, so print only the URL.
  console.log(`http://127.0.0.1:${resolveVaultPort()}`);
}

/**
 * Resolve the vault's port the way `status`, `restart`, `url`, and `doctor`
 * all need to agree on: env override (~/.parachute/vault/.env) wins, then
 * config.yaml, then DEFAULT_PORT. Sources .env as a side effect so callers
 * running this before any env read still see PORT.
 */
function resolveVaultPort(): number {
  loadEnvFile();
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  return envPort ?? readGlobalConfig().port ?? DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// Doctor helpers — MCP entry / port collision
// ---------------------------------------------------------------------------

type McpEntryLookup =
  | { found: false; reason: string }
  | { found: true; url: string; port: number | null };

/**
 * Read `~/.claude.json` and return the shape of the `parachute-vault` MCP
 * entry if present. The entry is always an HTTP MCP pointing at the local
 * daemon — `{ type: "http", url: "http://127.0.0.1:<port>/vault/<name>/mcp" }`
 * — so we parse the URL's port for the port-match check.
 *
 * Invariant: the check is NON-fatal. A missing ~/.claude.json is a warn,
 * not a fail: plenty of users install the vault first and wire it to
 * Claude later. We just make the "is it wired up?" state legible.
 */
function readMcpEntry(): McpEntryLookup {
  const claudeJsonPath = resolve(homedir(), ".claude.json");
  if (!existsSync(claudeJsonPath)) {
    return { found: false, reason: `${claudeJsonPath} does not exist` };
  }
  let config: any;
  try {
    config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
  } catch (err: any) {
    return {
      found: false,
      reason: `${claudeJsonPath} is not valid JSON: ${String(err?.message ?? err)}`,
    };
  }
  const entry = config?.mcpServers?.["parachute-vault"];
  if (!entry) {
    return {
      found: false,
      reason: `no mcpServers["parachute-vault"] entry in ${claudeJsonPath}`,
    };
  }
  // The entry is always a URL-bearing HTTP MCP. Non-URL shapes are
  // unexpected (Claude Code would ignore them anyway) but we surface the
  // raw shape so the user can see what's there.
  const url = typeof entry.url === "string" ? entry.url : null;
  if (!url) {
    return {
      found: false,
      reason: `mcpServers["parachute-vault"] has no \`url\` field (got ${JSON.stringify(entry).slice(0, 80)})`,
    };
  }
  let entryPort: number | null = null;
  try {
    const parsed = new URL(url);
    entryPort = parsed.port ? Number(parsed.port) : null;
  } catch {
    entryPort = null;
  }
  return { found: true, url, port: entryPort };
}

/**
 * HEAD-probe the MCP URL to tell "entry present but daemon unreachable"
 * apart from "entry present and daemon happily responding." Any HTTP
 * response — including auth failures — counts as reachable: the check is
 * about TCP + HTTP liveness, not correctness of the user's token.
 *
 * 2s timeout keeps `doctor` snappy when the daemon is down.
 */
async function probeMcpUrl(url: string): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(url, { method: "HEAD", signal: controller.signal });
    return { ok: true, detail: `HTTP ${resp.status}` };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (
      /ECONNREFUSED|ConnectionRefused|Unable to connect|refused/i.test(msg) ||
      err?.code === "ECONNREFUSED"
    ) {
      return { ok: false, detail: `connection refused (daemon not running?)` };
    }
    if (err?.name === "AbortError" || /aborted|timeout/i.test(msg)) {
      return { ok: false, detail: `timeout after 2000ms` };
    }
    return { ok: false, detail: msg };
  } finally {
    clearTimeout(timer);
  }
}

type PortCollision =
  | { status: "free" }
  | { status: "ours"; pids: number[] }
  | { status: "foreign"; pids: number[]; detail: string }
  | { status: "unknown" }; // no probe tool available

/**
 * Probe which process (if any) holds a TCP LISTEN socket on `port`.
 *
 * macOS: lsof is ubiquitous; we prefer it.
 * Linux: lsof is common but not guaranteed. Fall back to `ss -tlnp`. If
 *        neither exists, return "unknown" rather than a misleading "free."
 *
 * To decide whether the holder is "ours," we pull `ps -o command= -p <pid>`
 * for each listening PID and look for a marker unique to our daemon —
 * either the wrapper path or the pointer-file's server.ts path. This is
 * heuristic but good enough to avoid warning when the vault is just
 * running normally.
 */
async function checkPortCollision(port: number): Promise<PortCollision> {
  const pids = await listListeningPids(port);
  if (pids === null) return { status: "unknown" };
  if (pids.length === 0) return { status: "free" };

  // Build the set of path fragments that mark a process as ours. We check
  // multiple signals because `doctor` may be running from a different
  // PARACHUTE_HOME than the live daemon (tempdirs, Docker, developer
  // machines): the wrapper path alone isn't enough. The pointer target and
  // the currently-resolved server.ts path cover the common deployments.
  const marks: string[] = [WRAPPER_PATH, resolveServerPath()];
  const pointed = readServerPathPointer();
  if (pointed) marks.push(pointed);

  const descriptions: string[] = [];
  let allOurs = true;
  for (const pid of pids) {
    const cmdline = await describeProcess(pid);
    descriptions.push(`pid ${pid}: ${cmdline ?? "(unknown)"}`);
    const mine = cmdline !== null && marks.some((m) => cmdline.includes(m));
    if (!mine) allOurs = false;
  }
  if (allOurs) return { status: "ours", pids };
  return { status: "foreign", pids, detail: descriptions.join("; ") };
}

/**
 * Return PIDs holding a TCP LISTEN socket on `port`, or null if we can't
 * tell (no probe tool). Empty array means no listener.
 */
async function listListeningPids(port: number): Promise<number[] | null> {
  // Prefer lsof — same invocation works on macOS and Linux where present.
  if (Bun.which("lsof")) {
    try {
      const r = await Bun.$`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fp`.quiet().nothrow();
      // lsof exits 1 with no output when nothing matches; that's "free," not
      // an error. We distinguish by inspecting stdout rather than exitCode.
      const out = r.stdout.toString();
      const pids = [...out.matchAll(/^p(\d+)/gm)].map((m) => Number(m[1]));
      return [...new Set(pids)];
    } catch {
      // Fall through to ss if lsof itself blew up unexpectedly.
    }
  }
  if (Bun.which("ss")) {
    try {
      const r = await Bun.$`ss -tlnpH sport = :${port}`.quiet().nothrow();
      const out = r.stdout.toString();
      // `users:(("bun",pid=12345,fd=7))` — we pull every pid=NNNN.
      const pids = [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
      if (pids.length > 0) return [...new Set(pids)];
      // No users field but a listener row present? Treat as foreign with no
      // attributable PID. Parsing the local address is overkill for a warn.
      if (/LISTEN/.test(out)) return [-1];
      return [];
    } catch {}
  }
  return null;
}

/**
 * Fetch a one-line description of a process by PID. Returns null if the
 * PID is gone or ps is missing. Used only to classify a listener as ours
 * vs foreign, so "good enough" beats "precisely parsed."
 */
async function describeProcess(pid: number): Promise<string | null> {
  if (pid < 0) return null;
  try {
    const r = await Bun.$`ps -o command= -p ${pid}`.quiet().nothrow();
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backup — parachute-vault backup [--schedule <freq> | status]
// ---------------------------------------------------------------------------

async function cmdBackup(args: string[]) {
  // Subcommand: `status`
  if (args[0] === "status") {
    await cmdBackupStatus();
    return;
  }

  // Flag: `--schedule <freq>`
  const schedFlag = args.indexOf("--schedule");
  if (schedFlag !== -1) {
    const raw = args[schedFlag + 1];
    if (!raw) {
      console.error("Usage: parachute-vault backup --schedule <hourly|daily|weekly|manual>");
      process.exit(1);
    }
    if (raw !== "hourly" && raw !== "daily" && raw !== "weekly" && raw !== "manual") {
      console.error(`Invalid schedule: ${raw}. Must be one of: hourly, daily, weekly, manual.`);
      process.exit(1);
    }
    await cmdBackupSchedule(raw);
    return;
  }

  // Default: one-shot backup.
  await cmdBackupRun();
}

async function cmdBackupRun() {
  const cfg = readGlobalConfig().backup ?? defaultBackupConfig();
  if (cfg.destinations.length === 0) {
    console.error("No backup destinations configured. Edit ~/.parachute/vault/config.yaml:");
    console.error("  backup:");
    console.error("    destinations:");
    console.error("      - kind: local");
    console.error(`        path: ~/Library/Mobile Documents/com~apple~CloudDocs/parachute-backups`);
    process.exit(1);
  }

  console.log("Running backup...");
  const result = await runBackup({ backup: cfg });
  const bytes = result.bytes;
  const kb = Math.round(bytes / 1024);
  console.log(`  Snapshot: ${result.contents.dbSnapshots.length} DB(s), ${result.contents.configFiles.length} config file(s), ${kb} KB`);

  let ok = 0;
  for (const r of result.destinations) {
    if (r.error) {
      console.error(`  ${r.destination.kind} — FAILED: ${r.error}`);
      continue;
    }
    ok++;
    const prunedStr = r.pruned > 0 ? ` (pruned ${r.pruned} older)` : "";
    console.log(`  ${r.destination.kind} → ${r.writtenPath}${prunedStr}`);
  }
  if (ok === 0) {
    process.exit(1);
  }
}

async function cmdBackupSchedule(schedule: BackupSchedule) {
  const cfg = updateBackupConfig({ schedule });

  if (process.platform !== "darwin") {
    console.log(`Schedule set to: ${schedule}`);
    console.log("Note: scheduled backups are only registered on macOS in this MVP.");
    console.log("Linux systemd-timer support is a follow-up PR.");
    return;
  }

  if (schedule === "manual") {
    await uninstallBackupAgent();
    console.log("Schedule: manual — backup agent removed.");
    console.log("Run `parachute-vault backup` to trigger a backup on demand.");
    return;
  }

  if (cfg.destinations.length === 0) {
    console.log(`Schedule set to: ${schedule}`);
    console.log();
    console.log("WARNING: no destinations configured — scheduled runs will fail.");
    console.log("Edit ~/.parachute/vault/config.yaml and add at least one destination under `backup.destinations`.");
  }

  await installBackupAgent(schedule);
  console.log(`Schedule: ${schedule} — backup agent installed.`);
  console.log(`  Plist:    ${BACKUP_PLIST_PATH}`);
  console.log(`  Next run: ${describeNextRun(schedule)}`);
}

async function cmdBackupStatus() {
  const cfg = readGlobalConfig().backup ?? defaultBackupConfig();
  const last = readLastBackup();

  console.log("Parachute Vault — backup\n");
  console.log(`  Schedule:   ${cfg.schedule}`);
  // Tiered retention is always rendered as a one-line summary; per-tier
  // counts from real destinations go under each destination below.
  const r = cfg.retention;
  const yearlyStr = r.yearly === null ? "∞" : String(r.yearly);
  console.log(`  Retention:  ${r.daily} daily / ${r.weekly} weekly / ${r.monthly} monthly / ${yearlyStr} yearly`);

  if (cfg.destinations.length === 0) {
    console.log(`  Destinations: (none)`);
  } else {
    console.log(`  Destinations:`);
    for (const d of cfg.destinations) {
      if (d.kind === "local") {
        const path = expandTilde(d.path);
        console.log(`    - local: ${path}`);
        // Per-destination tier breakdown — counts the snapshots on disk and
        // each tier's individual contribution to the keep set. A snapshot
        // can satisfy multiple tiers, so per-tier counts may sum to > total.
        const t = tierTally(path, cfg.retention);
        if (t.total > 0) {
          console.log(`        on-disk: ${t.total} snapshot(s) — ${t.daily}d / ${t.weekly}w / ${t.monthly}mo / ${t.yearly}y`);
        }
      }
    }
  }

  if (process.platform === "darwin") {
    const loaded = await isBackupAgentLoaded();
    console.log(`  Agent:      ${loaded ? "loaded (launchctl)" : "not loaded"}`);
  }

  if (last) {
    console.log();
    console.log(`  Last run:   ${last.timestamp}`);
    console.log(`    Size:     ${Math.round(last.bytes / 1024)} KB`);
    for (const d of last.destinations) {
      if (d.error) {
        console.log(`    FAILED:   ${d.error}`);
      } else if (d.path) {
        console.log(`    Wrote:    ${d.path}`);
      }
    }
  } else {
    console.log();
    console.log("  Last run:   (never)");
  }

  if (cfg.schedule !== "manual") {
    console.log();
    console.log(`  Next run:   ${describeNextRun(cfg.schedule)}`);
  }
}

function describeNextRun(schedule: BackupSchedule): string {
  const est = nextRunEstimate(schedule, new Date());
  if (!est) return "(manual — on demand only)";
  // Render in local time so the user's sense of "around 3am" matches what
  // launchd will actually do.
  return est.toLocaleString();
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
    console.error("Usage: parachute-vault import <path> [--vault <name>] [--dry-run]");
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
    console.error(`Vault "${vaultName}" not found. Run: parachute-vault create ${vaultName}`);
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
    const existing = await store.getNoteByPath(note.path);
    if (existing) {
      skipped++;
      continue;
    }

    // Build metadata from frontmatter (excluding tags, already extracted)
    const metadata = Object.keys(note.frontmatter).length > 0 ? note.frontmatter : undefined;

    await store.createNoteRaw(note.content, {
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
    const linkResult = await store.syncAllWikilinks();
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
    console.error("Usage: parachute-vault export <output-path> [--vault <name>]");
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
  const notes = await store.queryNotes({ limit: 100000, sort: "asc" });

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
  const config: VaultConfig = {
    name,
    api_keys: [],
    created_at: new Date().toISOString(),
  };
  writeVaultConfig(config);

  // Create a pvt_ token in the vault's DB
  const store = getVaultStore(name);
  const { fullToken } = generateToken();
  createToken(store.db, fullToken, { label: "default", permission: "full" });
  return fullToken;
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

  // Single HTTP MCP entry — use per-vault endpoint so pvt_ tokens work.
  // Pick the URL that matches the OAuth issuer vault will advertise, in this
  // order: explicit hub origin env > active tailnet/public exposure >
  // loopback. Otherwise a strict MCP client (Claude Code) hits a loopback URL
  // whose discovery issuer points at the hub and rejects on origin mismatch
  // (RFC 8414).
  const defaultVault = globalConfig.default_vault || "default";
  const { url: mcpUrl, source } = chooseMcpUrl(defaultVault, port);
  console.log(`MCP URL: ${mcpUrl} (${source})`);
  const mcpEntry: Record<string, unknown> = { type: "http", url: mcpUrl };
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

If you installed via the Parachute CLI, prefer the wrapper commands for
lifecycle — \`parachute start vault\`, \`parachute stop vault\`,
\`parachute status\` — and use the vault-direct commands below for setup,
data, and debugging.

── Standard use ───────────────────────────────────────────────────────

Setup:
  parachute-vault init                     Set up everything (one command, idempotent)
  parachute-vault doctor                   Diagnose install/config issues
  parachute-vault uninstall [--wipe] [--yes]
                                           Remove daemon + MCP entry; --wipe also removes vaults, .env,
                                           config.yaml, and daemon logs (vault.log, vault.err).
                                           --yes skips prompts (DANGEROUS with --wipe: no confirmation).
  parachute-vault url                      Print the local server URL (for scripts)
  parachute --version                      Print the installed version (alias: -v, version)

Vaults:
  parachute-vault create <name>            Create a new vault
  parachute-vault list                     List all vaults
  parachute-vault remove <name> [--yes]    Remove a vault
  parachute-vault mcp-install              Add vault MCP to Claude

Tokens:
  parachute-vault tokens                          List all tokens
  parachute-vault tokens create                   Create a full-access token in the default vault
  parachute-vault tokens create --vault <name>    Create a token in a specific vault
  parachute-vault tokens create --read            Read-only token
  parachute-vault tokens create --label x         Set a label
  parachute-vault tokens create --expires 30d     Expiring token
  parachute-vault tokens revoke <token-id>        Revoke a token (default vault)

OAuth:
  parachute-vault set-password             Set/change the owner password (for consent page)
  parachute-vault set-password --clear     Remove the owner password
  parachute-vault 2fa status               Show 2FA state
  parachute-vault 2fa enroll               Enable TOTP 2FA (QR + backup codes)
  parachute-vault 2fa disable              Disable 2FA (requires password)
  parachute-vault 2fa backup-codes         Regenerate backup codes

Config:
  parachute-vault config                   Show current configuration
  parachute-vault config set <key> <val>   Set a config value
  parachute-vault config unset <key>       Remove a config value

Backup:
  parachute-vault backup                        One-shot backup to configured destinations
  parachute-vault backup --schedule <freq>      hourly | daily | weekly | manual (macOS launchd)
  parachute-vault backup status                 Show schedule, last run, destinations, next run

Import/Export:
  parachute-vault import <path>            Import an Obsidian vault
  parachute-vault import <path> --dry-run  Preview import without writing
  parachute-vault export <path>            Export vault as Obsidian markdown

── Advanced / standalone ──────────────────────────────────────────────

Direct daemon controls. For normal use, prefer the Parachute CLI wrappers
— they add PID tracking, log rotation, and cross-service \`parachute status\`
visibility. Use these when running vault without the CLI or when debugging.

  parachute-vault serve                    Run server in the foreground (no PID tracking).
                                           Prefer \`parachute start vault\` for managed lifecycle.
  parachute-vault status                   Vault-only daemon status.
                                           Prefer \`parachute status\` for a cross-service view.
  parachute-vault logs                     Stream server logs
  parachute-vault restart                  Restart the daemon
`);
}
