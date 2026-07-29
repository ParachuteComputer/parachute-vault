#!/usr/bin/env bun

/**
 * Parachute Vault CLI.
 *
 * Usage:
 *   parachute-vault init                    — set up everything, one command
 *   parachute-vault create <name>           — create a new vault
 *   parachute-vault list                    — list all vaults
 *   parachute-vault mcp-install [flags]     — install vault MCP into a client config
 *                                              (defaults: --mint into ~/.claude.json)
 *   parachute-vault remove <name>           — remove a vault
 *   parachute-vault config                  — show all config
 *   parachute-vault config set <key> <val>  — set a config value
 *   parachute-vault config unset <key>      — remove a config value
 *   parachute-vault serve                   — run the server (foreground)
 *   parachute-vault status                  — show full status
 */

import { resolve, join, dirname } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, chmodSync, readdirSync, statSync, renameSync } from "fs";
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
  vaultDbPath,
  vaultConfigPath,
  DEFAULT_PORT,
  CONFIG_DIR,
  ASSETS_DIR,
  ENV_PATH,
  LOG_PATH,
  ERR_PATH,
  GLOBAL_CONFIG_PATH,
  stopSignalPath,
} from "./config.ts";
import type { VaultConfig } from "./config.ts";
import { DATA_DIR } from "./config.ts";
import { installAgent, uninstallAgent, isAgentLoaded, restartAgent } from "./launchd.ts";
import {
  buildMcpConfigJson,
  buildMcpEntryPlan,
  chooseHubOrigin,
  chooseMcpUrl,
  DEFAULT_HUB_LOOPBACK_PORT,
  detectHubPresence,
  detectInstallContext,
  mintHubJwt,
  noOperatorTokenGuidance,
  readOperatorToken,
  removeMcpConfig,
  resolveInstallTarget,
  type InstallScope,
} from "./mcp-install.ts";
import {
  defaultInteractiveIO,
  runInteractiveInstall,
  type InteractiveIO,
} from "./mcp-install-interactive.ts";
import { buildInitSummaryLines } from "./init-summary.ts";
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
import { resolveBindHostname } from "./bind.ts";
import { listTokens, revokeToken, migrateVaultKeys } from "./token-store.ts";
import { VAULT_SCOPES } from "./scopes.ts";
import { validateVaultName, decideInitVaultName } from "./vault-name.ts";
import { decideAutostart } from "./autostart.ts";
import { getVaultStore } from "./vault-store.ts";
import { seedOnboardingNotesBestEffort } from "./onboarding-seed.ts";
import {
  defaultMirrorConfig,
  readMirrorConfigForVault,
  resolveMirrorPath,
  writeMirrorConfigForVault,
  type MirrorConfig,
} from "./mirror-config.ts";
import {
  bootstrapInternalMirror,
  readMirrorHistory,
  showMirrorRevision,
} from "./mirror-manager.ts";
import { GitNotInstalledError, ensureGitAvailable } from "./git-preflight.ts";
import { selfRegister } from "./self-register.ts";
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
import {
  planInstall,
  detectTotalRamBytes,
  isSharedLibFile,
  MODELS,
  type InstallPlan,
  type ModelChoice,
} from "./transcription/install.ts";
import {
  resolveTranscribeCppPaths,
  resolveTranscriptionProviderName,
  transcribeCppInstalled,
  probeTranscribeCliRunnable,
  readManifest,
  transcriptionHomeDir,
  pythonVenvDir,
  pythonManifestPath,
  readPythonManifest,
  resolveParakeetMlxBin,
  resolveParakeetMlxModel,
  resolveOnnxAsrBin,
  resolveOnnxAsrModel,
  parakeetMlxInstalled,
  onnxAsrInstalled,
  type TranscribeCppManifest,
  type PythonInstallManifest,
} from "./transcription/select.ts";
import {
  buildTranscribeCli,
  cliSourceUrl,
  compilerInstallHint,
  TRANSCRIBE_CPP_SOURCE_REF,
  type CliBuildResult,
} from "./transcription/build.ts";
import { downloadTo } from "./transcription/download.ts";
import {
  describeWhisperPlan,
  planWhisperInstall,
} from "./transcription/install-whisper-cpp.ts";
import {
  ensureBinaries,
  ensureModel,
  verifyTranscription,
} from "./transcription/install-whisper-exec.ts";
import {
  binaryNameFor,
  candidateBinDirs,
  resolveCliBinary,
  resolveFfmpeg,
} from "./transcription/resolve-binary.ts";
import { selectDefaultProvider, NOMINAL_SLACK_GB, type TierPlan } from "./transcription/tiers.ts";
import {
  PYTHON_PROVIDERS,
  buildDefaultPythonDeps,
  installPythonBackend,
  type PythonProviderName,
} from "./transcription/install-python.ts";

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
    await cmdInit(cmdArgs);
    break;
  case "create":
    await cmdCreate(cmdArgs);
    break;
  case "add-pack":
    await cmdAddPack(cmdArgs);
    break;
  case "list":
  case "ls":
    cmdList();
    break;
  case "mcp-install":
    await cmdMcpInstall(cmdArgs);
    break;
  case "mcp-config":
    await cmdMcpConfig(cmdArgs);
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
  case "stop":
    await cmdStop();
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
  case "history":
    await cmdHistory(cmdArgs);
    break;
  case "schema":
    await cmdSchema(cmdArgs);
    break;
  case "transcription":
    await cmdTranscription(cmdArgs);
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

/**
 * Resolve the origin to use for the web setup wizard link (`<origin>/admin/setup`).
 *
 * The wizard is served by the HUB, not by vault, so the loopback fallback must
 * target the hub's fixed loopback port (1939 / $PARACHUTE_HUB_PORT) — NOT
 * vault's listen port. `chooseHubOrigin` returns vault's loopback as its
 * fallback, so we only reuse it when a real (env / expose-state) hub origin is
 * configured; otherwise we synthesize the hub's loopback URL.
 *
 * `vaultPort` is vault's listen port — passed only so `chooseHubOrigin`'s
 * loopback branch is well-formed; we discard that loopback URL in favor of the
 * hub-port one.
 */
function resolveHubOriginForWizard(vaultPort: number): string {
  const { url, source } = chooseHubOrigin(vaultPort);
  if (source === "loopback") {
    // Guard against a non-numeric PARACHUTE_HUB_PORT producing
    // `http://127.0.0.1:NaN` — mirror detectHubPresence's Number.isFinite guard.
    const envPort = process.env.PARACHUTE_HUB_PORT
      ? Number(process.env.PARACHUTE_HUB_PORT)
      : undefined;
    const hubPort = Number.isFinite(envPort) ? (envPort as number) : DEFAULT_HUB_LOOPBACK_PORT;
    return `http://127.0.0.1:${hubPort}`;
  }
  return url;
}

async function cmdInit(args: string[] = []) {
  ensureConfigDirSync();

  // Writing the Claude Code MCP config (~/.claude.json) is now OPT-IN
  // (2026-06-23). init's primary job is to get the operator to the hub's
  // web setup wizard and SURFACE the self-serve connection info (connector
  // URL + a ready-to-paste `claude mcp add` command), NOT to silently write
  // a config file as a side effect of setup. The site no longer claims
  // "Claude Code is auto-configured," so the install code stops doing it by
  // default.
  //
  // Opt in with --configure-claude-code (aliases --mcp-install, --mcp) to
  // have init write the entry for you. --no-mcp is retained as the explicit
  // "definitely don't" form (and wins if both are passed — safer default).
  // The standalone `parachute-vault mcp-install` command is unchanged — it
  // remains the canonical explicit opt-in path.
  //
  // --token / --no-token control whether init ALSO mints + surfaces a
  // header-auth API token (for pasting into non-OAuth MCP clients, scripts,
  // or curl). Default stays off.
  //
  // --vault-name <name> skips the name prompt for non-interactive installs
  // (validated up front; exits non-zero on invalid input).
  const flagMcpOn =
    args.includes("--configure-claude-code") ||
    args.includes("--mcp-install") ||
    args.includes("--mcp");
  const flagMcpOff = args.includes("--no-mcp");
  const flagTokenOn = args.includes("--token");
  const flagTokenOff = args.includes("--no-token");
  // --autostart / --no-autostart toggle daemon registration. The default is
  // context-aware (resolved by decideAutostart below): ON for standalone
  // deploys, but OFF when a hub supervisor is detected, since the hub owns
  // vault's lifecycle and a launchd/systemd unit would race it for :1940
  // (ParachuteComputer/parachute-hub#580). --no-autostart always skips
  // registering AND removes any prior registration — for CI, dev sandboxes,
  // Docker, or any environment where another supervisor manages the process.
  // --autostart forces registration even under a hub (logged with a warning).
  // --no-autostart wins over --autostart on the same command line
  // (safer-default precedence).
  const flagAutostartOn = args.includes("--autostart");
  const flagAutostartOff = args.includes("--no-autostart");

  const nameDecision = decideInitVaultName(args, {
    isTTY: !!process.stdin.isTTY,
  });
  if (nameDecision.kind === "error") {
    console.error(nameDecision.message);
    process.exit(1);
  }
  // Whether the user explicitly supplied --vault-name. We use this both to
  // pick the chosen name on first init AND to print a friendly notice if
  // they pass --vault-name on a re-run where vaults already exist.
  const vaultNameFlagSupplied = args.indexOf("--vault-name") !== -1;

  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";
  const isFirstRun = !existsSync(ENV_PATH);

  console.log("Parachute Vault — self-hosted knowledge graph\n");

  // 1. Create the vault if none exist. The name is decided here — flag wins,
  // else prompt in a TTY (default "default"), else fall back to "default" so
  // piped installs keep working unchanged.
  const vaults = listVaults();
  let apiKey: string | undefined;
  // Guidance carried from the bootstrap-credential step — surfaced at the end
  // when no token could be issued (standalone, no hub) so the operator knows
  // how to make the vault reachable. vault#282 Stage 2.
  let credentialGuidance: string | undefined;
  if (vaults.length === 0) {
    const chosenName =
      nameDecision.kind === "name" ? nameDecision.name : await promptVaultName();
    console.log(`Creating vault "${chosenName}"...`);
    const credential = await createVault(chosenName);
    apiKey = credential.token ?? undefined;
    credentialGuidance = credential.guidance;
    console.log(`  Created vault: ${chosenName}`);
    console.log(`  ${credential.guidance}`);
  } else {
    if (vaultNameFlagSupplied) {
      console.log(
        `  --vault-name ignored: ${vaults.length} vault(s) already exist. Use \`parachute-vault create\` to add another.`,
      );
    }
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

  // 2a. Register in the shared services manifest so the @openparachute/hub
  // dispatcher can discover this service and its health endpoint. Upserts
  // by name, preserving entries for other services. Non-fatal on failure —
  // init can complete without the manifest, just with a warning.
  //
  // `selfRegister` stamps the full manifest-sourced row (displayName, tagline,
  // stripPrefix, installDir) from `.parachute/module.json` — the same shape
  // server boot writes via the self-registration pass (vault#266). Keeping
  // the two write paths in lockstep means `parachute-vault init` and the
  // first server boot agree on the row contents; without that, a re-init
  // would silently lose the manifest fields the boot pass had added.
  //
  // `paths[0]` is the canonical mount point — the hub uses it for the
  // `.well-known/parachute.json` URL and for `parachute expose`, so the
  // default vault always sorts first. Remaining vaults follow so the hub
  // well-known and paraclaw's attach picker see every vault on this server.
  // Re-running init re-registers the full set; that doubles as the
  // recovery path for installs whose services.json is stale (#208).
  selfRegister({
    version: pkg.version,
    warn: (msg) => console.error(`  Warning: ${msg}`),
    log: () => {}, // CLI init has its own status lines; suppress duplicate noise.
  });

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

  // 5b. OAuth consent now runs on the hub (workstream E, 2026-05-25). Vault
  // no longer renders its own consent page, so no owner-password prompt
  // belongs in `vault init`. Operators who want to expose vault publicly to
  // browser-based clients should run `parachute install hub`; the hub owns
  // the consent surface, the sign-in flow, and the JWT issuance.

  // 6. Install daemon (platform-aware). Idempotent — safe to re-run after
  // a folder move; this refreshes ~/.parachute/server-path and bounces the
  // daemon so the new location takes effect immediately.
  //
  // Autostart precedence is resolved by `decideAutostart` (pure, unit-tested):
  //   1. --no-autostart on this run             → false (and persisted)
  //   2. --autostart on this run                → true  (and persisted; warns
  //                                                if a supervised hub was seen)
  //   3. Existing config.autostart              → that value
  //   4. Hub present, no flag, no persisted val → false (the hub supervisor
  //                                                owns the lifecycle — #580)
  //   5. Default                                → true  (standalone deploys
  //                                                genuinely need a daemon)
  // When false: skip register AND uninstall any prior registration so the
  // decision's intent ("don't auto-start / don't auto-restart") matches reality
  // even if a previous run had registered a daemon.
  //
  // The hub probe runs only when neither flag was passed AND no value is
  // persisted — i.e. only when the hub signal can actually change the outcome.
  // It targets the hub's fixed loopback port (1939 / $PARACHUTE_HUB_PORT) and
  // never throws (see detectHubPresence). We skip it when a flag/persisted
  // value already decides, to avoid an 800ms wait on a flagged run.
  //
  // False-positive risk: a stale expose-state / leftover PARACHUTE_HUB_ORIGIN
  // makes detectHubPresence return true on a genuinely hubless box, so init
  // silently skips registering a daemon. Narrow + accepted — recover with
  // `parachute-vault init --autostart`. The pre-decided guard below means any
  // explicit flag or persisted value never even reaches the probe.
  const autostartPreDecided =
    flagAutostartOff || flagAutostartOn || typeof globalConfig.autostart === "boolean";
  const hubPresentForAutostart = autostartPreDecided ? false : await detectHubPresence();
  const autostartDecision = decideAutostart({
    flagOn: flagAutostartOn,
    flagOff: flagAutostartOff,
    persisted: globalConfig.autostart,
    hubPresent: hubPresentForAutostart,
  });
  const autostartEnabled = autostartDecision.enabled;

  if (autostartDecision.persist) {
    globalConfig.autostart = autostartEnabled;
    writeGlobalConfig(globalConfig);
  }

  let serverPath: string | null = null;
  if (!autostartEnabled) {
    if (autostartDecision.reason === "hub-default-off") {
      console.log(
        "Hub supervisor detected — not registering a separate daemon. The hub manages vault's lifecycle.",
      );
      console.log("  To force a standalone daemon anyway: parachute-vault init --autostart");
    } else {
      console.log("Autostart disabled — skipping daemon registration.");
    }
    if (isMac) {
      await uninstallAgent();
    } else if (isLinux && isSystemdAvailable()) {
      await uninstallSystemdService();
    }
    console.log("  To run vault: parachute-vault serve   (or use your own supervisor)");
    if (autostartDecision.reason !== "hub-default-off") {
      console.log("  To re-enable: parachute-vault init --autostart");
    }
  } else {
    if (autostartDecision.overrodeHub) {
      console.log(
        "Warning: a supervised hub was detected, but --autostart was passed — registering a "
          + "standalone daemon anyway. This can race the hub supervisor for the vault port; "
          + "prefer letting the hub manage vault unless you know you need both.",
      );
    }
    console.log("Installing daemon...");
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
  }
  const bindHost = resolveBindHostname(process.env);
  console.log(`  Listening on http://${bindHost}:${globalConfig.port || DEFAULT_PORT}`);

  // 7. Optionally write the Claude Code MCP config (~/.claude.json). This is
  // OPT-IN as of 2026-06-23 (see the flag-parsing note above). init's job is
  // to point the operator at the web wizard + surface the self-serve connect
  // info; it does NOT write ~/.claude.json by default. Resolution:
  //   --no-mcp                          → false (explicit "don't")
  //   --configure-claude-code / --mcp   → true  (explicit opt-in)
  //   TTY, no flag                      → ask (default NO — opt-in, not -out)
  //   non-TTY, no flag                  → false (no silent side effect in
  //                                       piped installs; the connect info is
  //                                       printed for copy-paste instead)
  let addMcp: boolean;
  if (flagMcpOff) {
    addMcp = false;
  } else if (flagMcpOn) {
    addMcp = true;
  } else if (process.stdin.isTTY) {
    addMcp = await confirm(
      "Also write the Claude Code MCP config now (~/.claude.json)? (you can always copy-paste the command below later)",
      false,
    );
  } else {
    addMcp = false; // non-interactive: no silent ~/.claude.json write
  }

  // 7b. Mint an API token for the header-auth / script use case? (Codex,
  // Goose, OpenCode, Cursor, Zed, Cline, scripts, curl.)
  //
  // vault#442: default vault auth is per-user OAuth — the Claude Code MCP entry
  // is written WITHOUT a baked bearer, so the first connection does browser
  // sign-in. We mint a token ONLY when the operator explicitly opts in
  // (`--token`, or "yes" at the prompt), and then it's scope-narrow
  // (`vault:<name>:read`), NEVER admin. `--no-token` (and the non-interactive
  // default) skips minting entirely — no auto-mint, no noisy mint-failure on a
  // fresh vault.
  let addToken: boolean;
  if (flagTokenOff) {
    addToken = false;
  } else if (flagTokenOn) {
    addToken = true;
  } else if (process.stdin.isTTY) {
    addToken = await confirm(
      "Also mint a header-auth API token for non-OAuth clients / scripts (Codex, Goose, curl)? (OAuth works without one)",
      false,
    );
  } else {
    addToken = false; // non-interactive default: OAuth-first, no auto-mint
  }

  // Mint a scope-narrow token ONLY when explicitly opted in and we don't
  // already have one from vault creation. vault#282 Stage 2: vault no longer
  // mints pvt_* tokens — this is a hub JWT via the operator.token → hub
  // mint-token path (`mintBootstrapCredential`), scoped `vault:<name>:read`.
  // When no hub is reachable, `apiKey` stays undefined and we carry the
  // guidance to the summary. The default (OAuth) path never reaches here.
  const defaultVault = globalConfig.default_vault || "default";
  if (addToken && !apiKey) {
    const credential = await mintBootstrapCredential(defaultVault, "read");
    apiKey = credential.token ?? undefined;
    credentialGuidance = credential.guidance;
    if (!apiKey) console.log(`  ${credential.guidance}`);
  }

  if (addMcp) {
    // Goes through `buildMcpEntryPlan` for entryKey + url so this path shares
    // the writer-side invariant with `executeMcpInstall` — a future URL-shape
    // change can't drift between init and mcp-install. By default NO bearer is
    // baked (vault#442 — OAuth on first connect); a bearer is embedded only
    // when the operator explicitly opted into a scope-narrow token above.
    const target = resolveInstallTarget("user");
    const { entryKey, url, source } = buildMcpEntryPlan({
      vaultName: defaultVault,
      vaultExplicit: false,
      port: globalConfig.port || DEFAULT_PORT,
    });
    installMcpConfig({
      targetPath: target.path,
      entryKey,
      url,
      bearer: apiKey,
    });
    console.log(`MCP URL: ${url} (${source})`);
    console.log(`  MCP server added to ~/.claude.json`);
    if (!apiKey) {
      console.log(`  No token baked in — you'll sign in via OAuth on first connect.`);
    }
  }
  // No else: when the operator didn't opt in, the init summary below surfaces
  // the connector URL + a copy-paste `claude mcp add` command instead of a
  // "skipped" line — that's the self-serve path.

  // 8. Summary
  const port = globalConfig.port || DEFAULT_PORT;
  // Connector URL surfaced for self-serve copy-paste. Hub-origin / expose-state
  // aware (chooseMcpUrl), so it's the URL a remote Claude Code / other client
  // actually reaches, not a bare loopback. The init-summary prints a
  // ready-to-paste `claude mcp add ...` built from this.
  const { url: connectorUrl } = chooseMcpUrl(defaultVault, port);
  // Web setup wizard lives on the hub at <hub-origin>/admin/setup. Resolve the
  // hub origin the same way (env / expose-state / loopback); the loopback form
  // points at the co-located hub's fixed port (1939), not vault's listen port.
  const wizardUrl = `${resolveHubOriginForWizard(port)}/admin/setup`;
  // Probe whether a hub is present so the summary's "opted into a token but
  // none minted" copy reflects reality: under a hub the vault is reachable via
  // browser OAuth even with no header-auth token (#445). Only matters for the
  // !apiKey branches; cheap + best-effort (never throws).
  const hubPresent = !apiKey ? await detectHubPresence() : true;
  const lines = buildInitSummaryLines({
    addMcp,
    addToken,
    apiKey,
    configDir: CONFIG_DIR,
    bindHost,
    port,
    mcpUrl: connectorUrl,
    wizardUrl,
    vaultName: defaultVault,
    noTokenGuidance: credentialGuidance,
    hubPresent,
  });
  for (const line of lines) console.log(line);
}


async function promptVaultName(): Promise<string> {
  while (true) {
    const answer = await ask("What would you like to call this vault?", "default");
    const v = validateVaultName(answer);
    if (v.ok) return v.name;
    console.log(`  ${v.error}`);
  }
}


async function promptForOwnerPassword(purpose: string): Promise<boolean> {
  console.log(`\n${purpose}`);
  console.log("  Legacy field — vault's standalone OAuth consent was retired in 0.4.x.");
  console.log("  Stored in config.yaml for hub's expose-posture-check only.");
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
  // Legacy command (workstream E, 2026-05-25). Vault's standalone OAuth
  // consent page was retired; this command now only writes the
  // `owner_password_hash` field that hub's `expose public` posture-check
  // reads. It no longer gates any auth flow inside vault. Set hub
  // credentials with `parachute auth set-password`.
  console.warn(
    "[deprecated] vault's standalone OAuth consent was retired in 0.4.x; OAuth runs on the hub.\n" +
      "             This command writes a legacy YAML field but no longer gates auth inside vault.\n" +
      "             Set hub credentials with `parachute auth set-password`.\n",
  );
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
      `Remove the owner password? (Legacy field — vault's standalone OAuth consent was retired in 0.4.x; OAuth runs on the hub now.)${twoFaNote}`,
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
  // Legacy command (workstream E, 2026-05-25). See cmdSetPassword for the
  // full deprecation story. 2FA on vault used to layer on top of the
  // owner-password gate for the standalone OAuth consent page; both have
  // been retired. The CLI still manages the legacy YAML fields for
  // back-compat.
  console.warn(
    "[deprecated] vault's standalone OAuth consent was retired in 0.4.x; OAuth runs on the hub.\n" +
      "             This command writes legacy YAML fields but no longer gates auth inside vault.\n",
  );

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
    console.log("\n2FA is now recorded in the legacy YAML field. (See deprecation note above.)");
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

async function cmdCreate(args: string[]) {
  // --json: emit a single machine-readable object on stdout instead of the
  // human-friendly multi-line print. Designed for orchestrators (the hub's
  // POST /vaults shells out to this CLI and parses stdout). Errors still go
  // to stderr as plain text and exit nonzero — callers branch on exit code.
  const jsonMode = args.includes("--json");
  // `--no-mirror` opts THIS create out of the default internal live mirror
  // even when the server-wide `default_mirror` knob is `internal`. Parity for
  // operators who want one bare vault without flipping the global default.
  const noMirror = args.includes("--no-mirror");

  // --- Auth opt-in (vault#442). Default = per-user OAuth, NO token minted. ---
  // `--mint` opts into a scope-narrow hub JWT for the header-auth / script
  // use case; `--scope read|write` (default read) picks the verb. `:admin` is
  // intentionally NOT accepted from the create flow. `--token <bearer>` is the
  // paste path — use an existing bearer instead of minting. The two are
  // mutually exclusive.
  const wantMint = args.includes("--mint");
  const createTokenArg = takeArgValue(args, "--token");
  if (createTokenArg.missingValue) {
    console.error("--token requires a value (the bearer token to embed).");
    process.exit(1);
  }
  const pastedToken = createTokenArg.value;
  if (wantMint && pastedToken !== undefined) {
    console.error("--mint and --token are mutually exclusive.");
    process.exit(1);
  }
  const createScopeArg = takeArgValue(args, "--scope");
  if (createScopeArg.missingValue) {
    console.error("--scope requires a value: read or write.");
    process.exit(1);
  }
  const rawCreateVerb = createScopeArg.value ?? "read";
  if (rawCreateVerb !== "read" && rawCreateVerb !== "write") {
    console.error(
      `--scope must be "read" or "write" for create (admin is minted out-of-band via \`mcp-install --scope vault:admin\`). Got: ${rawCreateVerb}.`,
    );
    process.exit(1);
  }
  const mintVerb: "read" | "write" | undefined = wantMint ? rawCreateVerb : undefined;

  // Greedy strip of any `--*` token (and any `--flag value` pairs we consumed
  // above) to recover the positional vault name. `--json`, `--no-mirror`,
  // `--mint`, `--token <v>`, `--scope <v>` are recognized; any other `--foo` is
  // silently dropped, and the value following a recognized value-flag is
  // skipped so it can't be mistaken for the vault name.
  const VALUE_FLAGS = new Set(["--token", "--scope"]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) i++; // skip the flag's value
      continue;
    }
    positional.push(a);
  }
  const name = positional[0];
  if (!name) {
    console.error("Usage: parachute-vault create <name> [--json]");
    process.exit(1);
  }

  // One validator for every name-minting edge (2026-06-09 hub-module-boundary
  // migration B2). cmdCreate used to carry its own inline charset check plus a
  // hardcoded `"list"` reservation that had drifted from `validateVaultName`'s
  // set — a vault named `admin`/`new`/`assets` could enter through `create`
  // and capture a reserved route (`/vault/admin` is the daemon-level admin
  // mount as of B3). Consuming the shared validator also picks up its 2–32
  // length rule, aligning `create` with `init`, the env var, and hub's wizard.
  const nameValidation = validateVaultName(name);
  if (!nameValidation.ok) {
    console.error(nameValidation.error);
    process.exit(1);
  }

  const existing = readVaultConfig(name);
  if (existing) {
    console.error(`Vault "${name}" already exists.`);
    process.exit(1);
  }

  ensureConfigDirSync();
  const wasFirst = listVaults().length === 0;
  const credential = await createVault(name, {
    ...(noMirror ? { enableMirror: false } : {}),
    ...(mintVerb ? { mintVerb } : {}),
  });

  // `--token <bearer>` paste path: the operator supplied their own bearer
  // instead of minting one. Surface it as the credential token so the
  // downstream JSON / human / summary copy treats it the same as a minted one.
  const effectiveToken = pastedToken ?? credential.token;
  const effectiveGuidance = pastedToken
    ? "Using the bearer you supplied via --token."
    : credential.guidance;

  // If this is the only vault now, make it the default so unscoped routes
  // (/mcp, /api/*, /oauth/*) target it. Avoids the "single vault named
  // 'journal' but /mcp returns 404" surprise.
  const globalConfig = readGlobalConfig();
  const needsDefault = !globalConfig.default_vault
    || !listVaults().includes(globalConfig.default_vault);
  let defaultNote: string | null = null;
  let setAsDefault = false;
  if (needsDefault) {
    globalConfig.default_vault = name;
    writeGlobalConfig(globalConfig);
    setAsDefault = true;
    defaultNote = wasFirst
      ? `Set as default vault (unscoped routes will target "${name}")`
      : `Set as default vault (previous default was missing)`;
  }

  // Re-register in services.json so the hub well-known and paraclaw's
  // attach picker see this vault. cmdInit registers on first run; cmdCreate
  // adds the new path on every subsequent vault. Without this, vaults
  // created after init were invisible to the hub (#208).
  //
  // Routed through `selfRegister` (vault#266) so the row carries the full
  // manifest-sourced metadata (displayName, tagline, stripPrefix, installDir)
  // — same shape server boot writes. Warnings go to stderr to keep --json
  // stdout clean for the orchestrator.
  selfRegister({
    version: pkg.version,
    warn: (msg) => console.error(`Warning: ${msg}`),
    log: () => {}, // CLI create has its own status lines.
  });

  const endpoint = chooseMcpUrl(name, globalConfig.port || DEFAULT_PORT).url;

  if (jsonMode) {
    // Contract (hub's admin-vaults.ts requires `typeof token === "string"`):
    // emit a token string when one was minted/pasted. vault#442 default is
    // per-user OAuth — no token is minted — so `token` is the empty string and
    // `token_guidance` carries the OAuth-first connect path. (Hub's admin SPA
    // already handles the empty-token case + has its own session-cookie admin
    // mint path, so it doesn't depend on create minting a token.)
    const payload = {
      name,
      token: effectiveToken ?? "",
      token_guidance: effectiveGuidance,
      paths: {
        vault_dir: vaultDir(name),
        vault_db: vaultDbPath(name),
        vault_config: vaultConfigPath(name),
      },
      set_as_default: setAsDefault,
    };
    console.log(JSON.stringify(payload));
    return;
  }

  console.log(`Vault "${name}" created.`);
  console.log(`  Path: ${vaultDir(name)}`);
  if (effectiveToken) {
    console.log(`  API token: ${effectiveToken}`);
    console.log(`  ${effectiveGuidance}`);
    console.log(`  Save this — it will not be shown again.`);
  } else {
    console.log(`  ${effectiveGuidance}`);
  }
  if (defaultNote) {
    console.log(`  ${defaultNote}`);
  }
  console.log();
  console.log(`Connect your AI: claude mcp add --transport http parachute-${name} ${endpoint}`);
  console.log(`  (no token needed — you'll sign in on first use)`);
  console.log(`Need a header-auth token for a script? parachute auth mint-token --scope vault:${name}:read`);
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

/**
 * Parse a `--flag value` pair from an args array. Returns the value (or
 * undefined when the flag isn't present) and a flag whether the flag's value
 * was actually present (catches `--flag` without an argument).
 */
function takeArgValue(args: string[], name: string): { value?: string; missingValue?: boolean } {
  const idx = args.indexOf(name);
  if (idx === -1) return {};
  const next = args[idx + 1];
  if (!next || next.startsWith("--")) return { missingValue: true };
  return { value: next };
}

/**
 * `parachute-vault mcp-install` — install the vault MCP server into an
 * AI client's config. Two auth modes (mutually exclusive — vault#282 Stage 2
 * dropped the `--legacy-pat` pvt_* mint; vault is a pure hub resource-server):
 *
 *   --mint                (default) Mint a hub JWT via `POST <hub>/api/auth/mint-token`
 *                         using the local operator token.
 *   --token <bearer>      Use an existing bearer (hub JWT or VAULT_AUTH_TOKEN).
 *
 * Targeting:
 *   --scope <verb>        vault:read | vault:write | vault:admin (default: vault:read).
 *                         For --mint, expands to vault:<vault-name>:<verb>.
 *                         vault:admin is mintable via --mint as of hub PR-A
 *                         (hub#449): hub mints per-vault admin when the operator
 *                         bearer carries parachute:host:admin (the default
 *                         operator.token does). Requires a hub running PR-A.
 *   --install-scope <s>   local (default) | user | project. local writes to
 *                         ~/.claude.json under projects[<cwd>].mcpServers
 *                         (private, this directory only — matches Claude
 *                         Code's own default). user writes to top-level
 *                         mcpServers (every project). project writes to
 *                         ./.mcp.json (check into the repo).
 *   --vault <name>        Vault to target (default: default_vault). Multi-vault
 *                         installs key the entry as `parachute-vault-<name>`.
 *   --client <name>       Reserved for Phase C. Only `claude-code` accepted.
 */
async function cmdMcpInstall(args: string[]): Promise<void> {
  // Set of install-shaping flags. Any one flips dispatch to non-interactive
  // — flag-passing semantics are "I know what I want."
  //
  // Declared inside the function (rather than module-top) because this
  // file's top-level dispatch await runs cmdMcpInstall during module
  // initialization, and a module-top `const` is still in its temporal
  // dead zone when the function body first executes from that dispatch.
  const MCP_INSTALL_FLAG_NAMES = [
    "--mint",
    "--token",
    "--scope",
    "--install-scope",
    "--vault",
    "--client",
    "--dry-run",
  ];

  const hasFlag = args.some((a) => MCP_INSTALL_FLAG_NAMES.includes(a));
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  // Interactive dispatch fires when the operator passed no install-shaping
  // flags AND stdin is a TTY. No separate `--interactive` flag — TTY+
  // no-flags already covers the "walk me through it" case, and forcing
  // interactive with partial flags is a half-feature that silently
  // discards co-present flag values (vault#292 review F1). Non-TTY
  // bare invocation falls through to the flag-driven defaults.
  if (isTTY && !hasFlag) {
    return await cmdMcpInstallInteractive();
  }

  // --- Auth-mode parsing (mutually exclusive). vault#282 Stage 2 dropped
  // --legacy-pat (the pvt_* mint) — vault is a pure hub resource-server, so
  // the only auth modes are --mint (hub JWT, default) and --token (paste). ---
  const wantMint = args.includes("--mint");
  const tokenArg = takeArgValue(args, "--token");
  if (tokenArg.missingValue) {
    console.error("--token requires a value (the bearer token to embed).");
    process.exit(1);
  }
  const wantToken = tokenArg.value !== undefined;
  if (wantMint && wantToken) {
    console.error("--mint and --token are mutually exclusive.");
    process.exit(1);
  }
  const mode: "mint" | "token" = wantToken ? "token" : "mint";

  // --- Scope parsing. Default vault:read (least-privilege). ---
  const scopeArg = takeArgValue(args, "--scope");
  if (scopeArg.missingValue) {
    console.error("--scope requires a value: vault:read, vault:write, or vault:admin.");
    process.exit(1);
  }
  const rawScope = scopeArg.value ?? "vault:read";
  if (!(VAULT_SCOPES as readonly string[]).includes(rawScope)) {
    console.error(
      `--scope must be one of: ${VAULT_SCOPES.join(", ")}. Got: ${rawScope}.`,
    );
    process.exit(1);
  }

  // --- Install scope: local (default), user, or project. ---
  // `local` matches Claude Code's own `claude mcp add` default — entry sits
  // under `projects[<cwd>].mcpServers` in ~/.claude.json, private to this
  // machine + this directory. Operators wanting a global install pass
  // `--install-scope user`; team-shared installs pass `--install-scope project`.
  const installScopeArg = takeArgValue(args, "--install-scope");
  if (installScopeArg.missingValue) {
    console.error("--install-scope requires a value: local, user, or project.");
    process.exit(1);
  }
  const installScopeRaw = installScopeArg.value ?? "local";
  if (
    installScopeRaw !== "user" &&
    installScopeRaw !== "project" &&
    installScopeRaw !== "local"
  ) {
    console.error(
      `--install-scope must be "local", "user", or "project". Got: ${installScopeRaw}.`,
    );
    process.exit(1);
  }
  const installScope: InstallScope = installScopeRaw;

  // --- Client (Phase C placeholder). Reject anything other than claude-code. ---
  // Validated before filesystem-dependent vault-existence so a static flag
  // typo fails on its own terms ("--client cursor not supported") rather
  // than getting masked by an unrelated "vault not found" error.
  const clientArg = takeArgValue(args, "--client");
  if (clientArg.missingValue) {
    console.error("--client requires a value.");
    process.exit(1);
  }
  const client = clientArg.value ?? "claude-code";
  if (client !== "claude-code") {
    console.error(
      `--client "${client}" is not yet supported. Only "claude-code" is wired up; ` +
        `Cursor / Claude Desktop / Codex / Zed are Phase C work.`,
    );
    process.exit(1);
  }

  // --- Vault target. Default = default_vault; validate existence. ---
  // Read --dry-run *before* the vault-existence guard so a probe like
  // `mcp-install --vault future-vault --dry-run` can describe the
  // intended write even when the vault hasn't been created yet. The
  // dry-run contract ("no side effects, including failures on state
  // the caller is asking us about") is broken otherwise.
  const dryRun = args.includes("--dry-run");
  const vaultArg = takeArgValue(args, "--vault");
  if (vaultArg.missingValue) {
    console.error("--vault requires a value (the vault name).");
    process.exit(1);
  }
  const globalConfig = readGlobalConfig();
  const defaultVault = globalConfig.default_vault || "default";
  const vaultName = vaultArg.value ?? defaultVault;
  const vaultExplicit = vaultArg.value !== undefined;
  if (!dryRun && !readVaultConfig(vaultName)) {
    console.error(`Vault "${vaultName}" not found. Available: ${listVaults().join(", ") || "(none)"}.`);
    process.exit(1);
  }

  await executeMcpInstall({
    mode,
    rawScope,
    installScope,
    vaultName,
    vaultExplicit,
    pastedToken: mode === "token" ? tokenArg.value : undefined,
    globalConfig,
    dryRun,
  });
}

/**
 * Interactive front-end for `mcp-install`. Builds the install context,
 * walks the operator through prompts, then hands the resolved decision
 * to `executeMcpInstall`. Failure modes from the walkthrough (operator
 * aborted, no vaults yet, etc.) exit cleanly without touching disk.
 */
async function cmdMcpInstallInteractive(): Promise<void> {
  const globalConfig = readGlobalConfig();
  const defaultVault = globalConfig.default_vault || "default";
  const port = globalConfig.port || DEFAULT_PORT;
  const ctx = detectInstallContext({
    vaults: listVaults(),
    defaultVault,
    port,
  });
  const io = await defaultInteractiveIO();
  const decision = await runInteractiveInstall(ctx, io);
  if (decision === "abort") {
    process.exit(0);
  }
  await executeMcpInstall({
    mode: decision.mode,
    rawScope: decision.scope,
    installScope: decision.installScope,
    vaultName: decision.vaultName,
    vaultExplicit: decision.vaultExplicit,
    pastedToken: decision.pastedToken,
    existingEntryKey: decision.existingEntryKey,
    globalConfig,
  });
}

/**
 * `parachute-vault mcp-config <vault-name>` — emit the JSON shape
 * `claude -p --mcp-config '<json>'` consumes, scoped to a named vault.
 * Pattern from Aaron's Gitcoin Brain runner:
 *
 *   claude -p --mcp-config "$(parachute-vault mcp-config gitcoin)" \
 *             --strict-mcp-config ...
 *
 * Synthesizing this JSON by hand was per-script boilerplate every runner
 * that spawned `claude -p` against a vault had to write. This command is
 * the canonical synthesizer — the JSON shape is owned here once.
 *
 * No state is mutated; this only emits to stdout. The bearer is read from
 * `--token <bearer>` or `PARACHUTE_VAULT_TOKEN` env (deliberate — we don't
 * mint here, since this is a stdout-piped subprocess where prompting would
 * deadlock the parent script). If neither is present, we exit 1 with a
 * clear stderr message; runners get a fail-fast.
 *
 * Flags:
 *   --token <bearer>   Bearer to embed verbatim (alternative: PARACHUTE_VAULT_TOKEN).
 *   --base-url <url>   Override the auto-detected hub origin (default: chooseHubOrigin).
 *                      Useful for tailnet-exposed hubs (`--base-url https://hub.tail.ts.net`).
 *   --env-vars         Emit the template form with `${PARACHUTE_HUB_URL}` and
 *                      `${PARACHUTE_VAULT_TOKEN}` placeholders rather than
 *                      inlined values. Safe to commit; the shell expands at
 *                      runtime.
 */
async function cmdMcpConfig(args: string[]): Promise<void> {
  const vaultName = args[0];
  if (!vaultName || vaultName.startsWith("--")) {
    console.error("Usage: parachute-vault mcp-config <vault-name> [--token <bearer>] [--base-url <url>] [--env-vars]");
    console.error("");
    console.error("Emits the JSON config consumed by `claude -p --mcp-config '<json>'`.");
    console.error("Pattern: claude -p --mcp-config \"$(parachute-vault mcp-config <name>)\" --strict-mcp-config ...");
    process.exit(1);
  }

  const tokenArg = takeArgValue(args, "--token");
  if (tokenArg.missingValue) {
    console.error("--token requires a value (the bearer to embed).");
    process.exit(1);
  }
  const baseUrlArg = takeArgValue(args, "--base-url");
  if (baseUrlArg.missingValue) {
    console.error("--base-url requires a value (e.g. https://hub.example.ts.net).");
    process.exit(1);
  }
  const useEnvVars = args.includes("--env-vars");

  // --env-vars mode is shape-only — no need to resolve the vault, mint a
  // token, or even verify the vault exists. Operators committing the
  // template don't necessarily have the target vault on the machine
  // generating the config.
  if (useEnvVars) {
    const json = buildMcpConfigJson({
      vaultName,
      baseUrl: "",
      bearer: "",
      useEnvVars: true,
    });
    process.stdout.write(json + "\n");
    return;
  }

  // Literal mode: verify the vault exists locally, resolve the URL, and
  // require a bearer (either --token or PARACHUTE_VAULT_TOKEN env).
  if (!readVaultConfig(vaultName)) {
    const available = listVaults();
    console.error(`Vault "${vaultName}" not found. Available: ${available.join(", ") || "(none — run `parachute-vault create <name>`)"}.`);
    process.exit(1);
  }

  const bearer = tokenArg.value ?? process.env.PARACHUTE_VAULT_TOKEN;
  if (!bearer) {
    console.error("No bearer token provided. Pass --token <bearer> or set PARACHUTE_VAULT_TOKEN.");
    console.error("  Mint a hub JWT with: parachute-vault mcp-install --vault " + vaultName + "   (or `parachute auth mint-token`)");
    console.error("  Or use --env-vars to emit the template form (safe to commit; expands at runtime).");
    process.exit(1);
  }

  const globalConfig = readGlobalConfig();
  const port = globalConfig.port || DEFAULT_PORT;
  let baseUrl: string;
  if (baseUrlArg.value) {
    baseUrl = baseUrlArg.value;
  } else {
    // chooseHubOrigin walks PARACHUTE_HUB_ORIGIN → expose-state → loopback;
    // for a script invoking `claude -p` against a local vault, loopback is
    // the right default.
    baseUrl = chooseHubOrigin(port).url;
  }

  const json = buildMcpConfigJson({
    vaultName,
    baseUrl,
    bearer,
    useEnvVars: false,
  });
  process.stdout.write(json + "\n");
}

interface ExecuteMcpInstallOpts {
  mode: "mint" | "token";
  /** Full scope string (e.g. "vault:read"). The verb segment narrows downstream. */
  rawScope: string;
  installScope: InstallScope;
  vaultName: string;
  /** Whether vault target was explicit (controls singular vs per-vault entry key). */
  vaultExplicit: boolean;
  /** Bearer the operator pasted in `--token` / interactive paste mode. */
  pastedToken?: string;
  /**
   * When the interactive walkthrough is updating an existing entry, the
   * walkthrough's preview pinned a specific key (e.g. `parachute-vault-work`
   * because that's what was already there). Passing it through ensures the
   * write lands at the same key the operator just confirmed. Absent for
   * fresh installs and for the flag-driven path (which always synthesizes).
   * See vault#293.
   */
  existingEntryKey?: string;
  /** Reused across the call chain to avoid re-parsing config.yaml. */
  globalConfig: ReturnType<typeof readGlobalConfig>;
  /**
   * When true, describe the write that *would* happen (target path,
   * entry key, URL, install scope) and exit 0 without touching the
   * filesystem or hitting the network for a hub-mint. Useful for
   * probing the command from a script that's setting up a runner.
   * Aaron hit this when accidentally creating an empty
   * `projects[<cwd>]` entry while just running `--help` — see the
   * `mcp-config` PR notes.
   */
  dryRun?: boolean;
}

/**
 * Shared backend for both the flag-driven path and the interactive
 * walkthrough. Acquires the bearer per mode, writes the entry, prints the
 * result. The interactive path delays this call until *after* the
 * preview-and-confirm step so a cancel skips the network mint entirely.
 */
async function executeMcpInstall(opts: ExecuteMcpInstallOpts): Promise<void> {
  const { mode, rawScope, installScope, vaultName, vaultExplicit, pastedToken, globalConfig, existingEntryKey, dryRun } = opts;
  const verb = rawScope.split(":")[1]!;
  const target = resolveInstallTarget(installScope);
  // Single source of truth shared with the interactive walkthrough's
  // preview — preview-shows-this-shape ⇒ this-shape-lands-on-disk. The
  // helper closes both halves of the invariant (entryKey + url) — see
  // vault#293 for the seam, vault#302 for closing the writer-side URL.
  const { entryKey, url, source } = buildMcpEntryPlan({
    vaultName,
    vaultExplicit,
    port: globalConfig.port || DEFAULT_PORT,
    ...(existingEntryKey ? { existingEntryKey } : {}),
  });

  // --dry-run: describe the write that *would* happen without touching
  // the filesystem or minting any token. Print to stdout (scripts may
  // parse this); exit 0. Skip the auth-acquisition entirely — the point
  // of --dry-run is to inspect without side effects, including the
  // network round-trip for hub-mint *and* the vault-existence guard
  // (probing the install for a not-yet-created vault is a legitimate
  // pre-create check, not an error).
  if (dryRun) {
    const vaultExists = readVaultConfig(vaultName) !== null;
    console.log(`[dry-run] No changes written.`);
    console.log(`  Target file:    ${target.path}`);
    console.log(`  Install scope:  ${target.scope}`);
    if (target.localProjectKey) {
      console.log(`  Project key:    ${target.localProjectKey}`);
    }
    console.log(`  Entry key:      ${entryKey}`);
    console.log(`  MCP URL:        ${url} (${source})`);
    console.log(`  Auth mode:      ${mode}${mode === "mint" ? ` (scope vault:${vaultName}:${verb})` : ""}`);
    console.log(`  Vault:          ${vaultName}${vaultExists ? "" : " (does not exist yet — create with `parachute-vault create " + vaultName + "`)"}`);
    console.log(`  Re-run without --dry-run to apply.`);
    return;
  }

  let bearer: string;
  if (mode === "token") {
    if (!pastedToken) {
      console.error("Internal error: token mode missing pastedToken.");
      process.exit(1);
    }
    bearer = pastedToken;
    console.log(`Using supplied token (skipping mint).`);
  } else {
    // mode === "mint"
    // `vault:<name>:admin` is mintable via the hub mint-token endpoint as
    // of hub PR-A (hub#449): the hub mints per-vault admin when the calling
    // operator bearer carries `parachute:host:admin` (which the default
    // operator.token does). No admin pre-flight reject — the narrowScope
    // below produces `vault:<name>:admin` and the hub honors it. This
    // requires a hub running PR-A; older hubs reject admin with HTTP 400
    // invalid_scope, surfaced via the api-error branch below. There is no
    // local pvt_* fallback anymore (vault#282 Stage 2) — without a hub, the
    // operator pastes an existing bearer via `--token` or sets VAULT_AUTH_TOKEN.
    const operatorToken = readOperatorToken();
    if (!operatorToken) {
      console.error(
        "No operator token found at ~/.parachute/operator.token. The default install path " +
          "(--mint) requires a hub-issued operator token to mint scope-narrow JWTs.\n" +
          "  Fix: run `parachute auth rotate-operator` to create one, then re-run.\n" +
          "  Or:  use `--token <bearer>` to paste an existing token, or set VAULT_AUTH_TOKEN.",
      );
      process.exit(1);
    }
    const port = globalConfig.port || DEFAULT_PORT;
    const hub = chooseHubOrigin(port);
    if (hub.source === "loopback") {
      console.error(
        "No hub origin configured (PARACHUTE_HUB_ORIGIN unset, no active expose-state). " +
          "Hub-mint (--mint) needs a real hub URL to call. Either:\n" +
          "  - Start the hub and set PARACHUTE_HUB_ORIGIN, OR\n" +
          "  - Bring up an exposure (`parachute expose tailnet`), OR\n" +
          "  - Use --token <bearer> to paste an existing token instead.",
      );
      process.exit(1);
    }
    const narrowScope = `vault:${vaultName}:${verb}`;
    const result = await mintHubJwt({
      hubOrigin: hub.url,
      operatorToken,
      scope: narrowScope,
      subject: "parachute-vault-mcp",
    });
    if ("kind" in result) {
      switch (result.kind) {
        case "network":
          console.error(
            `Hub unreachable at ${result.origin} — ${result.cause}.\n` +
              `  Fix: verify the hub is running and PARACHUTE_HUB_ORIGIN is set, ` +
              `or use --token <bearer> to skip hub-mint.`,
          );
          break;
        case "api-error":
          console.error(
            `Hub mint-token rejected (HTTP ${result.status}, ${result.error}): ${result.description}`,
          );
          // Older hubs (pre-hub#449) reject vault:<name>:admin as a
          // non-requestable scope with HTTP 400 invalid_scope. Surface an
          // actionable hint so the operator reaches for the upgrade rather
          // than chasing the wire-level error.
          if (result.status === 400 && verb === "admin") {
            console.error(
              "  Hint: minting vault:admin requires a hub with per-vault admin mint support " +
                "(hub#449). Your hub may predate it — upgrade the hub, or use --token <bearer> " +
                "to paste an existing admin token instead.",
            );
          }
          break;
      }
      process.exit(1);
    }
    bearer = result.token;
    console.log(`Minted hub JWT (jti=${result.jti}, expires ${result.expires_at}, scope ${result.scope}).`);
  }

  installMcpConfig({
    targetPath: target.path,
    entryKey,
    url,
    bearer,
    ...(target.localProjectKey ? { localProjectKey: target.localProjectKey } : {}),
  });
  console.log(`MCP URL: ${url} (${source})`);
  if (target.scope === "local") {
    console.log(`Added MCP server "${entryKey}" to ${target.path} under projects["${target.localProjectKey}"] (local scope).`);
    console.log(`  Installed locally for this directory only — runs only when Claude Code launches from ${target.localProjectKey}.`);
    console.log(`  To install globally instead, re-run with --install-scope user.`);
    // Headless-flow heads-up: local-scope MCP entries do NOT propagate
    // to subprocesses spawned by `claude -p` (script / cron / runner
    // shapes), even with --setting-sources covering local. Operators
    // wiring up a runner usually want `--install-scope user` so the
    // entry reaches every `claude` invocation on this machine.
    console.log(`  Headless flows (claude -p in scripts, cron, runners): prefer --install-scope user — local-scope entries don't propagate to claude -p subprocesses.`);
  } else {
    console.log(`Added MCP server "${entryKey}" to ${target.path}`);
  }
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
  const remaining = listVaults();
  let configDirty = false;
  if (globalConfig.default_vault === name) {
    if (remaining.length === 1) {
      globalConfig.default_vault = remaining[0];
      console.log(`  Default vault is now "${remaining[0]}".`);
    } else {
      delete globalConfig.default_vault;
      if (remaining.length > 1) {
        console.log(`  Cleared default_vault — set one with: editor ${CONFIG_DIR}/config.yaml`);
      }
    }
    configDirty = true;
  }

  // Last-vault marker (2026-06-09 hub-module-boundary migration, B1's
  // CLI-side improvement). Server boot auto-creates `default` when zero
  // vaults exist — without the marker, an operator who explicitly emptied
  // the server would find a freshly-credentialed `default` resurrected on
  // the next restart. Fresh installs never carry the marker (no config.yaml
  // at all), so Docker / hub-install first-run auto-create is preserved.
  if (remaining.length === 0 && globalConfig.auto_create !== false) {
    globalConfig.auto_create = false;
    configDirty = true;
    console.log(
      `  Last vault removed — wrote auto_create: false to ${GLOBAL_CONFIG_PATH} so the` +
        ` server won't auto-create a first vault on next boot. Create one with:` +
        ` parachute-vault create <name>`,
    );
  }
  if (configDirty) writeGlobalConfig(globalConfig);

  // Refresh services.json so the removed vault's /vault/<name> path drops
  // out of the parachute-vault row immediately — the same selfRegister
  // refresh cmdCreate does (#208). Without this, the hub's well-known
  // fan-out kept advertising the deleted vault until the next server boot.
  // Note: with zero vaults remaining, selfRegister emits paths: [] (#478) —
  // the row stays present (so the hub still sees the module as installed)
  // but advertises no /vault/<name> path. The hub must tolerate empty-paths
  // rows and skip them rather than resolving a phantom "default". Warnings
  // go to stderr; status lines stay ours.
  selfRegister({
    version: pkg.version,
    warn: (msg) => console.error(`Warning: ${msg}`),
    log: () => {},
  });
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

  // parachute-vault tokens [list] [--vault <name>]
  //   Default: every vault's tokens, grouped by vault.
  //   --vault <name>: only that vault.
  if (!subcmd || subcmd === "list") {
    const vaultFlag = args.indexOf("--vault");
    const onlyVault = vaultFlag !== -1 ? args[vaultFlag + 1] : null;
    if (vaultFlag !== -1 && !onlyVault) {
      console.error("--vault requires a value.");
      process.exit(1);
    }
    const vaults = onlyVault ? [onlyVault] : listVaults();
    let anyTokens = false;

    for (const vaultName of vaults) {
      const vc = readVaultConfig(vaultName);
      if (!vc) {
        if (onlyVault) {
          console.error(`Vault "${vaultName}" not found.`);
          process.exit(1);
        }
        continue;
      }
      const store = getVaultStore(vaultName);
      // Ensure legacy keys are migrated
      const globalCfg = readGlobalConfig();
      migrateVaultKeys(store.db, vc.api_keys, globalCfg.api_keys);

      // Per-vault filter (v16): only tokens bound to this vault, plus
      // legacy NULL-bound (server-wide) rows. The `[server-wide]` annotation
      // surfaces the latter so an operator listing one vault still sees
      // tokens that authenticate cross-vault.
      const tokens = listTokens(store.db, { vaultName });
      if (tokens.length === 0) continue;
      anyTokens = true;

      console.log(`Vault "${vaultName}" tokens:`);
      for (const t of tokens) {
        const expiry = t.expires_at ? ` (expires: ${t.expires_at})` : "";
        const lastUsed = t.last_used_at ? ` (last used: ${t.last_used_at})` : "";
        const serverWide = t.vault_name === null ? " [server-wide]" : "";
        console.log(`  ${t.id}  ${t.label}  [${t.permission}]${serverWide}${expiry}${lastUsed}`);
      }
      console.log();
    }

    if (!anyTokens) {
      console.log(
        "No vault-DB tokens found. Vault tokens are now hub-issued JWTs — " +
          "run `parachute-vault mcp-install` to mint one.",
      );
    }
    return;
  }

  // `tokens create` was removed at 0.5.0 (vault#282 Stage 2). Vault no longer
  // mints its own (pvt_*) tokens — it's a pure hub resource-server. Tokens are
  // now hub-issued JWTs: run `parachute-vault mcp-install` to mint + wire one
  // for an MCP client, or `parachute auth mint-token --scope vault:<name>:<verb>`
  // for scripts. `tokens list` / `tokens revoke` remain for cleaning up any
  // vestigial pre-0.5.0 rows.
  if (subcmd === "create") {
    console.error(
      "`parachute-vault tokens create` was removed at 0.5.0 — vault no longer mints its own tokens.\n" +
        "  Mint a hub-issued JWT instead:\n" +
        "    parachute-vault mcp-install --scope vault:<verb>   # wire an MCP client\n" +
        "    parachute auth mint-token --scope vault:<name>:<verb>   # for scripts\n" +
        "  See UPGRADING.md (pvt_* token removal, vault#282).",
    );
    process.exit(1);
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
    if (!vaultName) {
      console.error("--vault requires a value.");
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
  console.error("Usage: parachute-vault tokens [create | list | revoke <id>]");
  process.exit(1);
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

async function cmdStop() {
  loadEnvFile();
  const port = readGlobalConfig().port || DEFAULT_PORT;
  const sentinel = stopSignalPath();

  // Health check first: avoid leaving a stale sentinel that would kill the
  // *next* server boot. The server clears any pre-existing sentinel on
  // startup, but only after it loads — a sentinel written between launch
  // and the first poll could still win the race. Skipping the write when
  // nothing is listening is the cheap, obvious guard.
  const health = await checkHealth(port);
  if (health.status === "not-listening" || health.status === "error") {
    console.log(`Vault is not running (${health.status}${health.error ? `: ${health.error}` : ""}).`);
    return;
  }

  ensureConfigDirSync();
  writeFileSync(sentinel, `${new Date().toISOString()}\n`);
  console.log(`Stop signal written: ${sentinel}`);

  // Wait briefly for the server to pick up the sentinel and stop responding.
  // Polls match the server's 500ms cadence; give it ~5s before giving up.
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    await new Promise((r) => setTimeout(r, 600));
    const h = await checkHealth(port);
    if (h.status === "not-listening" || h.status === "error") {
      console.log(`Vault stopped (${Math.round((Date.now() - start) / 100) / 10}s).`);
      return;
    }
  }
  console.error("Vault did not stop within 5s. Check vault logs or `parachute-vault status`.");
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
  // Test-isolation escape hatch (vault#296): skip the launchd / systemd /
  // backup-agent uninstall calls. Those target hardcoded labels
  // (`computer.parachute.vault*`) that ignore `PARACHUTE_HOME`, so a test
  // run on a developer's machine would `launchctl bootout` their real
  // daemon. With this flag tests can exercise the rest of the uninstall
  // flow (wrapper removal, MCP cleanup, ordering, exit codes) safely.
  // Intentionally not documented in `usage()` — humans should never need
  // it; surfacing it would invite "I'll just skip the daemon step" misuse
  // that leaves an orphaned daemon firing on a missing wrapper.
  const skipDaemon = argsList.includes("--skip-daemon");

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
  if (skipDaemon) {
    console.log("Skipping daemon removal (--skip-daemon).");
  } else if (process.platform === "darwin") {
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

  // MCP entry in ~/.claude.json or ./.mcp.json. Split into three separate
  // checks so the user can see exactly which condition fails: "entry
  // present", "port matches vault", "daemon reachable over MCP URL". A
  // common failure is "entry exists but port is stale" after the user
  // changed PORT without re-running `mcp-install`.
  const port = resolveVaultPort();
  const mcpEntry = readMcpEntry();
  if (!mcpEntry.found) {
    checks.push({
      name: "MCP entry in MCP client config",
      status: "warn",
      detail: mcpEntry.reason,
      fix: "Run `parachute-vault mcp-install` to register the vault with Claude.",
    });
  } else {
    checks.push({
      name: `MCP entry in ${mcpEntry.locationLabel}`,
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
  | { found: true; url: string; port: number | null; locationLabel: string };

/**
 * Read the parachute vault MCP entry from either `~/.claude.json` (user
 * scope) or `./.mcp.json` (project scope), preferring user-level. Accepts
 * the singular `parachute-vault` key or any per-vault `parachute-vault-<name>`
 * key — multi-vault installs key per-vault. The entry is always an HTTP MCP
 * pointing at the local daemon, so we parse the URL's port for the
 * port-match check.
 *
 * Invariant: the check is NON-fatal. A missing entry is a warn, not a fail:
 * plenty of users install the vault first and wire it to Claude later. We
 * just make the "is it wired up?" state legible.
 */
function readMcpEntry(): McpEntryLookup {
  // Bun's process.cwd() already follows symlinks on macOS, so resolve()
  // matches the key the install writer used; tests assert with
  // fs.realpathSync to match the same shape.
  const cwd = resolve(process.cwd());
  // Two entries point at the same ~/.claude.json file but search different
  // key namespaces — top-level `mcpServers` (user scope) vs
  // `projects[<cwd>].mcpServers` (local scope). Intentional duplication: a
  // single read can't satisfy both without restructuring the search loop,
  // and the cost of reading the file twice is trivial against the doctor
  // run's other work.
  const candidates: Array<{ path: string; label: string; localProjectKey?: string }> = [
    { path: resolve(homedir(), ".claude.json"), label: "~/.claude.json" },
    { path: resolve(homedir(), ".claude.json"), label: `~/.claude.json (projects["${cwd}"])`, localProjectKey: cwd },
    { path: resolve(cwd, ".mcp.json"), label: `${cwd}/.mcp.json` },
  ];
  const checkedReasons: string[] = [];
  for (const { path, label, localProjectKey } of candidates) {
    if (!existsSync(path)) {
      checkedReasons.push(`${label} does not exist`);
      continue;
    }
    let config: any;
    try {
      config = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err: any) {
      checkedReasons.push(`${label} is not valid JSON: ${String(err?.message ?? err)}`);
      continue;
    }
    const servers = localProjectKey
      ? (config?.projects?.[localProjectKey]?.mcpServers ?? {})
      : (config?.mcpServers ?? {});
    // Prefer the singular `parachute-vault` slot (canonical default
    // install); fall back to the first `parachute-vault-<name>` per-vault
    // entry. Multi-vault installs may have several; the doctor reports on
    // the one it finds first so the basic "is something wired up?" check
    // still works without enumerating every vault.
    let entry = servers["parachute-vault"];
    let entryKey = "parachute-vault";
    if (!entry) {
      for (const key of Object.keys(servers)) {
        if (key.startsWith("parachute-vault-")) {
          entry = servers[key];
          entryKey = key;
          break;
        }
      }
    }
    if (!entry) {
      checkedReasons.push(`no parachute-vault entry in ${label}`);
      continue;
    }
    const url = typeof entry.url === "string" ? entry.url : null;
    if (!url) {
      checkedReasons.push(
        `${label} mcpServers["${entryKey}"] has no \`url\` field (got ${JSON.stringify(entry).slice(0, 80)})`,
      );
      continue;
    }
    let entryPort: number | null = null;
    try {
      const parsed = new URL(url);
      entryPort = parsed.port ? Number(parsed.port) : null;
    } catch {
      entryPort = null;
    }
    return { found: true, url, port: entryPort, locationLabel: `${label} (${entryKey})` };
  }
  return {
    found: false,
    reason: checkedReasons.length > 0 ? checkedReasons.join("; ") : "no MCP config files found",
  };
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
  let vaultName = "default";
  let sourcePath = "";
  let dryRun = false;
  let blowAway = false;
  let assumeYes = false;
  // `--format <name>` / `--obsidian` retained as no-op hints — autodetect
  // now drives the format choice (presence of `.parachute/vault.yaml`).
  // Surfaced in help text below; ignored at runtime to avoid surprising
  // operators with stale flags.

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--format") {
      i++; // consume the value; ignored.
    } else if (arg === "--vault") {
      const v = args[++i];
      if (!v) {
        console.error("--vault requires a value.");
        process.exit(1);
      }
      vaultName = v;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--obsidian") {
      // no-op; autodetect.
    } else if (arg === "--blow-away") {
      blowAway = true;
    } else if (arg === "--yes" || arg === "-y") {
      assumeYes = true;
    } else {
      positional.push(arg);
    }
  }
  sourcePath = positional[0] ?? "";

  if (!sourcePath) {
    console.error("Usage: parachute-vault import <path> [--vault <name>] [--blow-away] [--yes] [--dry-run]");
    console.error("\nImports a portable-md export OR a legacy Obsidian vault. Format is");
    console.error("autodetected by the presence of `.parachute/vault.yaml` in the input dir.");
    console.error("\nOptions:");
    console.error("  --vault <name>   Target vault (default: 'default')");
    console.error("  --blow-away      DESTRUCTIVE: wipe the target vault first, then replay");
    console.error("                   the import. Disaster-recovery path. Confirms unless");
    console.error("                   `--yes` is set.");
    console.error("  --yes, -y        Skip the destructive-action confirm prompt.");
    console.error("  --dry-run        Show what would be imported without writing.");
    process.exit(1);
  }

  const { resolve: resolvePath } = await import("path");
  const { join } = await import("path");
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

  // Daemon-busy guard (vault#323): the import opens its own bun:sqlite
  // connection, but a running daemon already holds the writer lock. The
  // first createNote then trips SQLITE_BUSY mid-stream and leaves a
  // partially-replayed vault. Refuse with a clear error rather than
  // attempt-and-fail. WAL/concurrent-writer is a separate follow-up.
  const globalConfig = readGlobalConfig();
  const port = globalConfig.port || DEFAULT_PORT;
  const health = await checkHealth(port);
  if (health.status === "healthy" || health.status === "unhealthy") {
    console.error(
      `error: vault daemon is running on port ${port}; stop it first with:\n` +
        `  parachute stop vault\n` +
        `the import requires exclusive write access to the SQLite database.`,
    );
    process.exit(1);
  }

  // Autodetect: portable-md export → `.parachute/vault.yaml` present.
  const isPortableMd = existsSync(join(fullPath, ".parachute", "vault.yaml"));

  if (isPortableMd) {
    // New lossless path. Supports --blow-away for disaster recovery.
    const { importPortableVault } = await import("../core/src/portable-md.ts");
    const { getVaultStore } = await import("./vault-store.ts");
    const { assetsDir } = await import("./routes.ts");

    if (blowAway && !assumeYes && !dryRun) {
      // Confirm-prompt the destructive action. Default NO — every other
      // destructive confirm in this CLI (uninstall's wipe, 2FA
      // re-enrollment) defaults NO, so a distracted Enter-press can't
      // wipe a vault. vault#319 fold F1.
      const proceed = await confirm(
        `\nDESTRUCTIVE: --blow-away will DELETE every note in vault "${vaultName}" before replaying from "${fullPath}". Proceed?`,
        false,
      );
      if (!proceed) {
        console.log("Cancelled.");
        return;
      }
    }

    const store = getVaultStore(vaultName);
    console.log(
      `Importing portable-md export from ${fullPath} into vault "${vaultName}"` +
      `${blowAway ? " (BLOW-AWAY)" : ""}${dryRun ? " (dry-run)" : ""}`,
    );
    const stats = await importPortableVault(store, {
      inDir: fullPath,
      blowAway,
      assetsDir: assetsDir(vaultName),
      dryRun,
    });

    console.log(
      `\n${dryRun ? "Would " : ""}created ${stats.notes_created} note(s), ` +
      `updated ${stats.notes_updated}, ` +
      `restored ${stats.schemas_restored} schema(s), ` +
      `${stats.links_restored} link(s), ` +
      `${stats.attachments_restored} attachment(s).`,
    );
    if (stats.notes_wiped > 0) {
      console.log(`Blow-away: wiped ${stats.notes_wiped} pre-existing note(s).`);
    }
    if (stats.skipped_links.length > 0) {
      console.log(`Skipped ${stats.skipped_links.length} link(s) — target notes not in import set.`);
    }
    if (stats.skipped_attachments.length > 0) {
      console.log(`Skipped ${stats.skipped_attachments.length} attachment(s) — see warnings above.`);
    }
    if (stats.skipped_duplicate_ids.length > 0) {
      console.log(
        `Skipped ${stats.skipped_duplicate_ids.length} file(s) with duplicate/blank note id(s) — ` +
        `kept the first of each collision; see warnings above.`,
      );
    }
    return;
  }

  // Legacy obsidian-format path. No-op when --blow-away passed (this
  // path is for "ingest an external Obsidian vault" not disaster
  // recovery); explicit error so the operator doesn't get a surprising
  // partial wipe.
  if (blowAway) {
    console.error(
      "--blow-away requires a portable-md export (`.parachute/vault.yaml` present in the input dir). " +
      "Legacy Obsidian imports don't support --blow-away — they always upsert by path.",
    );
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

  // Import into vault — use the shared `importObsidianNotes` adapter
  // (obsidian.ts). It uses createNoteRaw to skip per-note wikilink sync,
  // id-aware upsert with a path-conflict guard, intra-batch collision
  // dedup, per-note error isolation, and timestamp preservation. The
  // single wikilink pass runs below, after all notes exist.
  const { importObsidianNotes } = await import("../core/src/obsidian.ts");
  const store = getVaultStore(vaultName);
  const { imported, skipped } = await importObsidianNotes(store, notes);

  console.log(`\nImported ${imported} notes into vault "${vaultName}"`);
  if (skipped > 0) console.log(`Skipped ${skipped} notes (path already exists or conflict)`);

  if (imported > 0) {
    const linkResult = await store.syncAllWikilinks();
    console.log(`Resolved ${linkResult.totalAdded} wikilinks across ${linkResult.synced} notes.`);
  }
}

async function cmdExport(args: string[]) {
  let vaultName = "default";
  let outputPath = "";
  let since: string | undefined;
  let watch = false;
  let intervalSeconds = 5;
  let gitCommit = false;
  const { DEFAULT_COMMIT_TEMPLATE } = await import("./export-watch.ts");
  let gitMessageTemplate = DEFAULT_COMMIT_TEMPLATE;
  let gitPush = false;
  let strictCaseCollision = false;

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--vault") {
      const v = args[++i];
      if (!v) {
        console.error("--vault requires a value.");
        process.exit(1);
      }
      vaultName = v;
    } else if (arg === "--since") {
      const v = args[++i];
      if (!v) {
        console.error("--since requires an ISO-8601 timestamp value.");
        process.exit(1);
      }
      // Defensive: parse to verify it's a real ISO timestamp before we
      // hand it to the store. Avoids silent "no matches" when the
      // operator typo's the date and gets an empty export.
      const parsed = Date.parse(v);
      if (Number.isNaN(parsed)) {
        console.error(`--since: invalid ISO-8601 timestamp '${v}'`);
        process.exit(1);
      }
      since = v;
    } else if (arg === "--watch") {
      watch = true;
    } else if (arg === "--interval") {
      const v = args[++i];
      if (!v) {
        console.error("--interval requires a number of seconds.");
        process.exit(1);
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`--interval: must be a positive number of seconds (got '${v}')`);
        process.exit(1);
      }
      intervalSeconds = n;
    } else if (arg === "--git-commit") {
      gitCommit = true;
    } else if (arg === "--git-message-template") {
      const v = args[++i];
      if (!v) {
        console.error("--git-message-template requires a value.");
        process.exit(1);
      }
      gitMessageTemplate = v;
    } else if (arg === "--git-push") {
      gitPush = true;
    } else if (arg === "--strict-case-collision") {
      strictCaseCollision = true;
    } else {
      positional.push(arg);
    }
  }
  outputPath = positional[0] ?? "";

  if (!outputPath) {
    console.error(
      "Usage: parachute-vault export <dir> [--since <iso>] [--vault <name>]\n" +
        "                                  [--watch [--interval <seconds>]]\n" +
        "                                  [--git-commit [--git-message-template <tpl>] [--git-push]]",
    );
    console.error("\nExports a Parachute Vault as portable markdown — round-trippable across");
    console.error("Obsidian / Logseq / Foam / Quartz / Dendron and most markdown SSGs.");
    console.error("\nOptions:");
    console.error("  --vault <name>              Source vault (default: 'default')");
    console.error("  --since <iso>               Only export notes whose updated_at >= ISO timestamp");
    console.error("                              (incremental — useful for git-projection cadences)");
    console.error("  --watch                     Stay alive; re-export incrementally on every");
    console.error("                              vault write. Polls every --interval seconds.");
    console.error("  --interval <seconds>        Watch poll interval (default: 5)");
    console.error("  --git-commit                After each export, `git add -A` + commit in <dir>.");
    console.error("                              Requires <dir> to be an initialized git repo.");
    console.error("                              Combine with --watch for auto-history.");
    console.error("  --git-message-template <t>  Commit message template. Variables:");
    console.error("                                {{date}}, {{notes_changed}}, {{plural}},");
    console.error("                                {{first_note_title}}, {{vault_name}}");
    console.error("                              (default: \"export: {{date}} ({{notes_changed}} note{{plural}})\")");
    console.error("  --git-push                  After commit, run `git push` (non-fatal on failure).");
    console.error("  --strict-case-collision     On case-insensitive filesystems (macOS APFS-default,");
    console.error("                              Windows NTFS, FAT/exFAT), abort the export if two notes");
    console.error("                              have paths differing only by case (vault#327).");
    console.error("                              Without this flag, colliding notes are auto-disambiguated");
    console.error("                              with an `__<id-short>` filename suffix (lossless; both");
    console.error("                              files land, canonical path preserved in frontmatter).");
    process.exit(1);
  }

  if (intervalSeconds !== 5 && !watch) {
    console.error("--interval only applies with --watch.");
    process.exit(1);
  }
  if ((gitPush || gitMessageTemplate !== DEFAULT_COMMIT_TEMPLATE) && !gitCommit) {
    console.error("--git-push / --git-message-template only apply with --git-commit.");
    process.exit(1);
  }

  const { resolve: resolvePath } = await import("path");
  const fullPath = resolvePath(outputPath);

  const config = readVaultConfig(vaultName);
  if (!config) {
    console.error(`Vault "${vaultName}" not found.`);
    process.exit(1);
  }

  const { exportVaultToDir } = await import("../core/src/portable-md.ts");
  const { getVaultStore } = await import("./vault-store.ts");
  const { assetsDir } = await import("./routes.ts");

  const store = getVaultStore(vaultName);
  const assetsDirPath = assetsDir(vaultName);
  const vaultDescription = config.description;

  // Git-repo precheck: fail fast and loud before we run a long-lived loop.
  if (gitCommit) {
    await ensureGitRepo(fullPath);
  }

  /**
   * Run a single export cycle: export → optionally commit/push. Returns the
   * stats + a freshly-captured cursor for the next incremental run. We
   * capture the cursor *before* the export starts, so any write that lands
   * during the export is picked up next cycle (cost: at most one note
   * re-exported next round when its `updated_at` equals our cursor).
   */
  async function runCycle(opts: { sinceCursor?: string; isInitial: boolean }): Promise<{
    stats: Awaited<ReturnType<typeof exportVaultToDir>>;
    nextCursor: string;
    committed: boolean;
  }> {
    const nextCursor = new Date().toISOString();
    if (opts.isInitial) {
      console.log(
        `Exporting vault "${vaultName}" to ${fullPath}${opts.sinceCursor ? ` (since ${opts.sinceCursor})` : ""}`,
      );
    }
    const stats = await exportVaultToDir(store, {
      outDir: fullPath,
      vaultName,
      assetsDir: assetsDirPath,
      ...(vaultDescription ? { vaultDescription } : {}),
      ...(opts.sinceCursor ? { since: opts.sinceCursor } : {}),
      ...(strictCaseCollision ? { failOnCaseCollision: true } : {}),
    });

    if (opts.isInitial) {
      console.log(
        `Exported ${stats.notes} note(s), ${stats.schemas} tag schema(s), ${stats.attachments} attachment(s).`,
      );
      console.log(`Sidecar: ${fullPath}/.parachute/`);
      if (stats.filtered_by_since) {
        console.log(`Incremental: filtered by --since ${opts.sinceCursor}.`);
      }
      if (stats.skipped_traversal > 0) {
        console.log(
          `Note: ${stats.skipped_traversal} note(s) skipped (path-traversal). See [export] warnings above.`,
        );
      }
      if (stats.skipped_attachments.length > 0) {
        console.log(
          `Note: ${stats.skipped_attachments.length} attachment(s) skipped. See [export] warnings above.`,
        );
      }
      // vault#327 Phase 2 — surface case-collision auto-disambiguation
      // explicitly. The previous fix landed the logic silently; the
      // operator had no signal that filenames had been munged. Now we
      // print the count + every disambiguated path so the operator can
      // (a) audit, (b) decide whether to rename a colliding note in
      // the vault and re-export, or (c) re-run with
      // --strict-case-collision to refuse the disambiguation entirely.
      if (stats.disambiguated_paths.length > 0) {
        const n = stats.disambiguated_paths.length;
        console.warn(
          `Warning: ${n} note${n === 1 ? "" : "s"} had path${n === 1 ? "" : "s"} that ` +
          `differ only by case on this case-insensitive filesystem. ` +
          `Auto-disambiguated on disk (canonical paths preserved in frontmatter):`,
        );
        for (const d of stats.disambiguated_paths) {
          console.warn(`  - ${d.original_path} → ${d.disambiguated_filename} (id: ${d.note_id})`);
        }
        console.warn(
          `Re-run with --strict-case-collision to abort instead, or rename one of each ` +
          `colliding pair in the vault before re-exporting. See vault#327.`,
        );
      }
    } else {
      // Watch-mode status line: keep tight; the loop logs every interval.
      if (stats.notes > 0) {
        console.log(
          `[watch] exported ${stats.notes} note${stats.notes === 1 ? "" : "s"} (cursor: ${nextCursor})`,
        );
      } else {
        console.log(`[watch] no changes`);
      }
      // Watch-mode: log new disambiguations per cycle. Operators running
      // a long-lived watch loop want to be notified the moment a
      // collision shows up — they can fix it at the source without
      // waiting for the next manual full export.
      if (stats.disambiguated_paths.length > 0) {
        const n = stats.disambiguated_paths.length;
        console.warn(
          `[watch] case-collision: ${n} disambiguated path${n === 1 ? "" : "s"} this cycle ` +
          `(see vault#327; --strict-case-collision to abort instead).`,
        );
      }
    }

    let committed = false;
    if (gitCommit) {
      const { runGitCommitCycle } = await import("./export-watch.ts");
      const commitResult = await runGitCommitCycle({
        repoDir: fullPath,
        template: gitMessageTemplate,
        notesChanged: stats.notes,
        vaultName,
        firstNoteTitle: await firstChangedNoteTitle(store, opts.sinceCursor),
        push: gitPush,
      });
      committed = commitResult.committed;
    }

    return { stats, nextCursor, committed };
  }

  // Import the typed CaseCollisionError once so both the single-shot and
  // watch-initial paths can render it the same way. vault#327 Phase 2.
  const { CaseCollisionError } = await import("../core/src/portable-md.ts");

  // ---- Single-shot mode ----
  if (!watch) {
    try {
      await runCycle({ sinceCursor: since, isInitial: true });
    } catch (err) {
      if (err instanceof CaseCollisionError) {
        // The error's own message already includes the actionable
        // instruction ("Rename one of them..."). Print verbatim + exit
        // non-zero so scripts catch the failure deterministically.
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    return;
  }

  // ---- Watch mode ----
  // Initial full (or since-filtered) export, then poll every interval.
  let initial: Awaited<ReturnType<typeof runCycle>>;
  try {
    initial = await runCycle({ sinceCursor: since, isInitial: true });
  } catch (err) {
    if (err instanceof CaseCollisionError) {
      console.error(err.message);
      console.error(
        "\n--strict-case-collision is enabled; refusing to start the watch loop until the " +
        "collision is resolved in the vault. Re-export without --strict-case-collision to " +
        "auto-disambiguate instead.",
      );
      process.exit(1);
    }
    throw err;
  }
  let cursor = initial.nextCursor;
  console.log(`[watch] polling every ${intervalSeconds}s; press Ctrl-C to stop.`);

  let stopping = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const onStop = () => {
    if (stopping) return;
    stopping = true;
    // Clear the interval immediately so the timer can't fire one more
    // time during the in-flight settle window — `stopping` already guards
    // re-entry, but symmetry beats relying on that guard.
    if (timer) clearInterval(timer);
    console.log("\n[watch] stopping watch");
    // Give an in-flight cycle a brief moment to settle, then exit. Don't
    // hang forever — operator hit Ctrl-C, they want out.
    setTimeout(() => process.exit(0), inFlight ? 250 : 0);
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  timer = setInterval(async () => {
    if (stopping || inFlight) return;
    inFlight = true;
    try {
      const cycle = await runCycle({ sinceCursor: cursor, isInitial: false });
      cursor = cycle.nextCursor;
    } catch (err) {
      // CaseCollisionError under --strict-case-collision means the
      // operator opted into "abort on any collision". A new collision
      // that appears mid-watch (e.g. an LLM client just wrote
      // `Inbox/Foo` to a vault that already had `Inbox/foo`) must NOT
      // be swallowed into the generic [watch] export-error log — the
      // strict-mode guarantee would silently degrade after the initial
      // export. Print the full collision message + actionable hint and
      // stop the loop via the same SIGINT-style pathway used by Ctrl-C
      // (clears timer, gives in-flight work a 250ms settle window).
      // Exits non-zero so supervisors / git-watch sidecars catch it.
      if (err instanceof CaseCollisionError) {
        console.error(err.message);
        console.error(
          "Resolve the collision in the vault or re-run without --strict-case-collision to fall back to auto-disambiguate mode.",
        );
        stopping = true;
        if (timer) clearInterval(timer);
        setTimeout(() => process.exit(1), 0);
        return;
      }
      // Don't kill the loop on a transient export error — log and keep
      // polling. Operator can Ctrl-C if they want to bail.
      console.error(`[watch] export error: ${(err as Error).message ?? err}`);
    } finally {
      inFlight = false;
    }
  }, intervalSeconds * 1000);
  // Keep a reference so the timer isn't GC'd; nothing else holds the loop open.
  timer.unref?.();
  // Block forever (signal handler is the exit path).
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// `parachute-vault history` — surface the vault's git write history (vault#300)
// ---------------------------------------------------------------------------

/**
 * `parachute-vault history [--note <path>] [--limit N] [--vault <name>] [--json]`
 *
 * Surfaces the mirror's git commit log — the vault is already git-backed
 * (one file per note), so `git log` IS a tamper-evident, diffable write
 * history. This CLI front-door wraps the SAME `readMirrorHistory` helper the
 * REST `/history` endpoint uses (no drift between the two surfaces).
 *
 * `--note <path>` scopes to a single note's history (`git log --follow --
 * <path>.md`). `--show <sha>` (with `--note`) prints that note's content at
 * a past revision (`git show <sha>:<path>.md`).
 */
async function cmdHistory(args: string[]) {
  let vaultName = "default";
  let notePath: string | undefined;
  let limit: number | undefined;
  let showSha: string | undefined;
  let asJson = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--vault") {
      const v = args[++i];
      if (!v) {
        console.error("--vault requires a value.");
        process.exit(1);
      }
      vaultName = v;
    } else if (arg === "--note") {
      const v = args[++i];
      if (!v) {
        console.error("--note requires a note path.");
        process.exit(1);
      }
      notePath = v;
    } else if (arg === "--limit") {
      const v = args[++i];
      if (!v) {
        console.error("--limit requires a number.");
        process.exit(1);
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`--limit: must be a positive integer (got '${v}')`);
        process.exit(1);
      }
      limit = n;
    } else if (arg === "--show") {
      const v = args[++i];
      if (!v) {
        console.error("--show requires a commit sha.");
        process.exit(1);
      }
      showSha = v;
    } else if (arg === "--json") {
      asJson = true;
    } else if (arg === "--help" || arg === "-h") {
      printHistoryUsage();
      return;
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHistoryUsage();
      process.exit(1);
    }
  }

  if (showSha && !notePath) {
    console.error("--show <sha> requires --note <path> (which file to read at that revision).");
    process.exit(1);
  }

  const config = readVaultConfig(vaultName);
  if (!config) {
    console.error(`Vault "${vaultName}" not found. Available: ${listVaults().join(", ") || "(none)"}.`);
    process.exit(1);
  }

  // Resolve the mirror dir the same way the server does: per-vault mirror
  // config (or defaults) → resolveMirrorPath against the vault's data dir.
  const mirrorConfig = readMirrorConfigForVault(vaultName) ?? defaultMirrorConfig();
  const mirrorPath = resolveMirrorPath(vaultDir(vaultName), mirrorConfig);
  if (!mirrorPath || !existsSync(mirrorPath)) {
    console.error(
      `No git history for vault "${vaultName}" — the mirror isn't initialized yet.\n` +
        `Enable history (backup) so writes are recorded, then re-run.`,
    );
    process.exit(1);
  }

  // Preflight git — friendly, actionable message instead of a raw spawn throw.
  try {
    ensureGitAvailable();
  } catch (err) {
    if (err instanceof GitNotInstalledError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // `--show` path: print one note's content at a past revision.
  if (showSha && notePath) {
    const content = await showMirrorRevision(mirrorPath, showSha, notePath);
    if (content === null) {
      console.error(
        `No content for "${notePath}" at ${showSha} — the sha may be unknown, the note may not have existed at that commit, or the path is invalid.`,
      );
      process.exit(1);
    }
    process.stdout.write(content);
    return;
  }

  const history = await readMirrorHistory(mirrorPath, { notePath, limit });

  if (asJson) {
    console.log(JSON.stringify(history, null, 2));
    return;
  }

  if (history.length === 0) {
    if (notePath) {
      console.log(`No history for note "${notePath}" in vault "${vaultName}".`);
    } else {
      console.log(`No history yet for vault "${vaultName}".`);
    }
    return;
  }

  const scope = notePath ? ` for "${notePath}"` : "";
  console.log(`Git history for vault "${vaultName}"${scope} (${history.length} commit${history.length === 1 ? "" : "s"}):\n`);
  for (const entry of history) {
    // Short sha + date + subject — one line per commit, the `git log --oneline`
    // shape an operator expects.
    console.log(`  ${entry.sha.slice(0, 8)}  ${entry.date}  ${entry.message}`);
  }
}

function printHistoryUsage(): void {
  console.error(
    "Usage: parachute-vault history [--note <path>] [--limit N] [--vault <name>] [--json]\n" +
      "                              [--note <path> --show <sha>]",
  );
  console.error("\nSurface the vault's git write history. The vault is already git-backed via the");
  console.error("mirror (one file per note), so `git log` IS a tamper-evident, diffable history.");
  console.error("\nOptions:");
  console.error("  --vault <name>   Vault to read (default: 'default')");
  console.error("  --note <path>    Scope to a single note's history (git log --follow)");
  console.error("  --limit N        Cap the number of commits returned (default 100)");
  console.error("  --show <sha>     With --note: print that note's content at the given revision");
  console.error("  --json           Emit the history as JSON instead of the human-readable list");
}

// ---------------------------------------------------------------------------
// Transcription — `parachute-vault transcription <subcommand>` (scribe-fold 2a)
// ---------------------------------------------------------------------------

/**
 * `parachute-vault transcription install` — set up a LOCAL transcription
 * provider. With no `--provider`, the ratified RAM/arch/OS tier table
 * (scribe-fold Phase 2b, `tiers.ts`) picks the host's default:
 *
 *   - macOS Apple Silicon 8GB+ → parakeet-mlx (Python venv, MLX)
 *   - Linux 4GB+               → onnx-asr (Python venv, int8 ONNX)
 *   - Linux ~2GB               → transcribe-cpp + small whisper GGUF
 *   - ~1GB / below floor       → remote steer (scribe-http), never forced
 *
 * The pick + footprint is printed and the operator confirms (or overrides
 * with `--provider`/`--model`). Every path is idempotent + non-fatal, and
 * activation is HONEST: `TRANSCRIPTION_PROVIDER` flips only when a runnable
 * binary actually exists (PRs #532/#533 precedent). `--dry-run`/`--plan`
 * prints the selection without downloading.
 *
 * `parachute-vault transcription status` — show the configured provider +
 * per-provider install state.
 */
async function cmdTranscription(args: string[]) {
  const sub = args[0];
  if (sub === "install") {
    await cmdTranscriptionInstall(args.slice(1));
    return;
  }
  if (sub === "status" || sub === undefined) {
    await cmdTranscriptionStatus();
    return;
  }
  console.error(`Unknown transcription subcommand: ${sub}`);
  console.error(
    "Usage: parachute-vault transcription install [--dry-run] [--model <id>] [--provider <transcribe-cpp|parakeet-mlx|onnx-asr|scribe-http>]",
  );
  console.error("       parachute-vault transcription status");
  process.exit(1);
}

/** Render an install plan for the human (shared by --dry-run + the real run). */
function printTranscriptionPlan(plan: InstallPlan): void {
  console.log(`Host:  ${plan.platform}/${plan.arch}, ${plan.totalRamGb}GB RAM`);
  if (!plan.supported) {
    console.log(`\n  ${plan.refused ? "Refused" : "Unsupported"}: ${plan.reason}`);
    return;
  }
  const m = plan.model!;
  console.log(`Binary: ${plan.asset!.asset}`);
  console.log(`Model:  ${m.name}  (${m.file})`);
  console.log(`        ${m.note}`);
  console.log(`        ~${m.approxSizeMb}MB download, ~${m.approxRuntimeGb}GB peak RAM while transcribing`);
}


/**
 * `parachute-vault transcription install` — the whisper.cpp path.
 *
 * Plan → binaries → model → VERIFY → activate. The verify step is the
 * load-bearing one: the provider this replaces was activated by an install
 * that never checked whether what it configured could run, which is how
 * `TRANSCRIPTION_PROVIDER` came to point at a CLI that has never existed.
 * `TRANSCRIPTION_PROVIDER` flips only after a real CLI transcribes a real
 * file, so an install that reports success is one that works.
 */
async function runWhisperCppInstall(opts: {
  modelId?: string;
  dryRun: boolean;
  yes: boolean;
}): Promise<void> {
  const plan = planWhisperInstall(opts.modelId, {
    resolveExisting: (engine) => resolveCliBinary(engine),
  });
  for (const line of describeWhisperPlan(plan)) console.log(line);

  if (!plan.supported) {
    console.error("\nCan't install automatically on this host — see above.");
    process.exit(1);
  }
  if (opts.dryRun) {
    console.log("\n(dry run — nothing downloaded or changed)");
    return;
  }
  if (!opts.yes) {
    // Bun's global `confirm()` reads stdin. In a non-TTY — which is exactly
    // how the unified setup script and any CI invocation call this — it would
    // block forever, so require an explicit --yes there instead of hanging.
    if (!process.stdin.isTTY) {
      console.error(
        "\nNot a terminal — re-run with --yes to install without confirmation.",
      );
      process.exit(1);
    }
    if (!confirm("\nProceed?")) {
      console.log("Cancelled.");
      return;
    }
  }

  const log = (l: string) => console.log(`  ${l}`);

  const bin = await ensureBinaries(plan, { log });
  console.log(`${bin.ok ? "✓" : "✗"} ${bin.message}`);
  if (!bin.ok) process.exit(1);

  const model = await ensureModel(plan, { log });
  console.log(`${model.ok ? "✓" : "✗"} ${model.message}`);
  if (!model.ok) process.exit(1);

  // Re-resolve AFTER install — a brew install just changed what's on disk.
  const binPath = resolveCliBinary(plan.model.engine);
  if (!binPath) {
    console.error(
      `✗ ${binaryNameFor(plan.model.engine)} still isn't resolvable after install. ` +
        `Searched: ${candidateBinDirs().slice(0, 5).join(", ")}`,
    );
    process.exit(1);
  }

  const verified = await verifyTranscription(plan, binPath, { log });
  console.log(`${verified.ok ? "✓" : "✗"} ${verified.message}`);
  if (!verified.ok) {
    console.error("\nNot activating — an install that can't transcribe isn't installed.");
    process.exit(1);
  }

  setEnvVar("TRANSCRIPTION_PROVIDER", "whisper-cpp");
  setEnvVar("TRANSCRIPTION_MODEL", plan.model.id);
  console.log(`\n✓ Activated: whisper-cpp with ${plan.model.label}.`);

  if (!resolveFfmpeg()) {
    console.log(
      "\n! ffmpeg isn't installed. Audio has to be transcoded to 16 kHz mono WAV before\n" +
        "  transcription, so voice memos will fail until you install it:\n" +
        "    macOS:  brew install ffmpeg\n" +
        "    Debian: sudo apt install ffmpeg",
    );
  }
  console.log("\nRestart the vault to apply (`parachute restart vault`).");
}

async function cmdTranscriptionInstall(args: string[]) {
  const dryRun = args.includes("--dry-run") || args.includes("--plan");
  const force = args.includes("--force");
  const yes = args.includes("--yes") || args.includes("-y");
  const overrideModel = takeArgValue(args, "--model").value;
  const providerArg = takeArgValue(args, "--provider").value;

  // whisper-cpp is the local path now, and the DEFAULT when no --provider is
  // given. The legacy tier table below still serves an explicit
  // `--provider transcribe-cpp|parakeet-mlx|onnx-asr`, but nothing routes
  // there by default any more: transcribe-cpp's CLI has never shipped, and
  // the Python providers need a venv plus a multi-GB model.
  if (!providerArg || providerArg === "whisper-cpp") {
    await runWhisperCppInstall({ modelId: overrideModel, dryRun, yes });
    return;
  }

  if (providerArg === "scribe-http") {
    // Just flip config back to the remote provider — no download.
    if (dryRun) {
      console.log("Would set TRANSCRIPTION_PROVIDER=scribe-http in the vault .env (remote provider; no download).");
      return;
    }
    setEnvVar("TRANSCRIPTION_PROVIDER", "scribe-http");
    console.log("Set TRANSCRIPTION_PROVIDER=scribe-http. Restart vault to apply. (Remote provider — no local binary/model needed.)");
    return;
  }

  let provider: string;
  let tierModel: string | undefined;
  if (providerArg) {
    if (!["transcribe-cpp", "parakeet-mlx", "onnx-asr"].includes(providerArg)) {
      console.error(
        `Unknown --provider "${providerArg}". Valid: whisper-cpp (default), transcribe-cpp, parakeet-mlx, onnx-asr, scribe-http.`,
      );
      process.exit(1);
    }
    provider = providerArg;
  } else {
    // Auto-default: the ratified RAM/arch/OS tier table (tiers.ts). Probe the
    // host, print the pick + footprint; the operator confirms below (or
    // re-runs with --provider/--model to override).
    const tier = selectDefaultProvider({
      platform: process.platform,
      arch: process.arch,
      totalRamBytes: detectTotalRamBytes(),
    });
    printTierPick(tier);
    if (tier.provider === "scribe-http") {
      // Remote steer — never force a local install on a below-tier box.
      console.log("\nNo local install performed. To point at a remote provider now:");
      console.log("  parachute-vault transcription install --provider scribe-http");
      if (tier.localOptIn) {
        console.log(`\nLocal opt-in (explicit only — not auto-installed): ${tier.localOptIn.note}`);
      }
      process.exit(dryRun ? 0 : 1);
    }
    provider = tier.provider;
    tierModel = tier.model;
    console.log("");
  }

  if (provider === "transcribe-cpp") {
    // The tier's model pick (e.g. the Linux ~2GB whisper-small tier) seeds the
    // transcribe-cpp flow; an explicit --model always wins.
    await runTranscribeCppInstall({ dryRun, force, yes, overrideModel: overrideModel ?? tierModel });
    return;
  }
  await runPythonProviderInstall(provider as PythonProviderName, {
    dryRun,
    force,
    yes,
    overrideModel,
  });
}

/** Print the tier-table pick for this host (the install auto-default). */
function printTierPick(tier: TierPlan): void {
  console.log(`Host: ${tier.platform}/${tier.arch}, ${tier.totalRamGb}GB RAM`);
  console.log(`Tier default: ${tier.provider}${tier.model ? ` (${tier.model})` : ""}`);
  console.log(`  ${tier.reason}`);
  if (tier.approxDiskMb) {
    console.log(`  ~${tier.approxDiskMb}MB download${tier.peakRamNote ? `, ${tier.peakRamNote}` : ""}`);
  }
  console.log("  (override with --provider <transcribe-cpp|parakeet-mlx|onnx-asr|scribe-http>)");
}

/**
 * Install a Python-based local provider (parakeet-mlx / onnx-asr) into the
 * managed venv under `~/.parachute/transcription/venv/` and — honestly —
 * activate it only when a runnable binary verified (`install-python.ts` owns
 * the apt/venv/warm-pull steps; activation + manifest stay here, mirroring
 * the transcribe-cpp flow).
 */
async function runPythonProviderInstall(
  provider: PythonProviderName,
  opts: { dryRun: boolean; force: boolean; yes: boolean; overrideModel?: string },
): Promise<void> {
  const spec = PYTHON_PROVIDERS[provider];
  const venv = pythonVenvDir();
  // `--model` wins; else env/manifest/ratified default. The pick lands in the
  // install manifest, which the runtime model resolution reads back.
  const model =
    opts.overrideModel ??
    (provider === "parakeet-mlx" ? resolveParakeetMlxModel() : resolveOnnxAsrModel());
  const totalRamGb = Math.round((detectTotalRamBytes() / 2 ** 30) * 10) / 10;

  console.log(`Transcription install plan (${provider} — local, Python venv):\n`);
  console.log(`Host:    ${process.platform}/${process.arch}, ${totalRamGb}GB RAM`);
  console.log(`Package: ${spec.pipTarget} → ${venv}`);
  console.log(`Model:   ${model}`);
  console.log(`         ~${spec.approxDiskMb}MB model download, ${spec.peakRamNote}`);

  if (opts.dryRun) {
    // Preview the guards the real run would hit — pure, no side effects.
    if (spec.platform && spec.platform !== process.platform) {
      console.log(`\n  Refused: ${provider} only runs on ${spec.platform}; this host is ${process.platform}.`);
    } else if (spec.arch && spec.arch !== process.arch) {
      console.log(`\n  Refused: ${provider} needs ${spec.arch} (Apple Silicon); this host is ${process.arch}.`);
    } else if (totalRamGb < spec.minRamGb - NOMINAL_SLACK_GB && !opts.force) {
      console.log(`\n  Refused: ${totalRamGb}GB RAM < the ~${spec.minRamGb}GB ${provider} floor. ${spec.ramFloorRationale}`);
    }
    console.log("\n(--dry-run) Nothing installed.");
    return;
  }

  if (!opts.yes) {
    const ok = await confirm(
      `Install ${spec.pipTarget} into ${venv} (model ~${spec.approxDiskMb}MB ${provider === "parakeet-mlx" ? "downloads on first use" : "warm-pulled now"})?`,
      true,
    );
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const outcome = await installPythonBackend(buildDefaultPythonDeps(), {
    provider,
    force: opts.force,
    model,
  });

  if (!outcome.ok || !outcome.binPath) {
    console.error(`\n✗ ${outcome.summary}`);
    console.error(
      "Your current provider is unchanged — the verb is idempotent; fix the issue and re-run. Or use the remote provider: parachute-vault transcription install --provider scribe-http",
    );
    process.exit(1);
  }

  // Manifest + honest activation (a runnable binary exists — verified above).
  const manifest: PythonInstallManifest = {
    provider,
    pipTarget: spec.pipTarget,
    bin: outcome.binPath,
    venv: outcome.venv ?? "",
    model,
    os: process.platform,
    arch: process.arch,
    ram_gb: totalRamGb,
    installedAt: new Date().toISOString(),
  };
  mkdirSync(transcriptionHomeDir(), { recursive: true });
  writeFileSync(pythonManifestPath(), JSON.stringify(manifest, null, 2));

  setEnvVar("TRANSCRIPTION_PROVIDER", provider);
  console.log(`\n✓ Installed and activated → TRANSCRIPTION_PROVIDER=${provider} set in the vault .env.`);
  console.log(`  Binary: ${outcome.binPath}`);
  console.log(`  Model:  ${model}`);
  if (provider === "parakeet-mlx") {
    console.log(`  NOTE: the model (~${spec.approxDiskMb}MB) downloads into the HuggingFace cache on the first transcription.`);
  }
  console.log(`  Restart vault to activate:  parachute restart vault`);
}

async function runTranscribeCppInstall(opts: {
  dryRun: boolean;
  force: boolean;
  yes: boolean;
  overrideModel?: string;
}) {
  const { dryRun, force, yes, overrideModel } = opts;
  const plan = planInstall({
    platform: process.platform,
    arch: process.arch,
    totalRamBytes: detectTotalRamBytes(),
    overrideModel,
  });

  console.log("Transcription install plan (transcribe-cpp — local, no Python):\n");
  printTranscriptionPlan(plan);

  if (!plan.supported) {
    // Refused / unsupported is not a hard error — it's a steer to remote.
    console.log("\nNo local install performed. See the note above.");
    process.exit(dryRun ? 0 : 1);
  }

  const paths = resolveTranscribeCppPaths();
  console.log(`\nInstall dir: ${paths.dir}`);

  if (dryRun) {
    console.log("\n(--dry-run) No files downloaded.");
    return;
  }

  if (!yes) {
    const ok = await confirm(`Download ~${plan.footprintMb}MB and install to ${paths.dir}?`, true);
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  // ffmpeg hint (non-fatal — the transcode path checks at runtime).
  if (!Bun.which("ffmpeg")) {
    console.warn(
      "\n⚠  ffmpeg not found on PATH. transcribe-cli needs 16kHz mono WAV; non-WAV capture audio is transcoded via ffmpeg.\n" +
        "   Install it: apt install ffmpeg  (Debian/Ubuntu)  |  brew install ffmpeg  (macOS)",
    );
  }

  try {
    mkdirSync(paths.binDir, { recursive: true });
    mkdirSync(paths.libsDir, { recursive: true });
    mkdirSync(paths.modelsDir, { recursive: true });

    // 1) Release library bundle → extract the runtime dylibs/sos into libs/.
    //    transcribe.cpp v0.1.1 ships a LIBRARY, not a prebuilt transcribe-cli,
    //    so a CLI is usually NOT placed here — `installTranscribeLibs` still
    //    opportunistically places one if a (future) asset includes it.
    const existingLibs = (readdirSync(paths.libsDir) as string[]).filter(isSharedLibFile);
    let libFiles = existingLibs;
    if (existingLibs.length && !force) {
      console.log(`\n✓ runtime libraries already present (${paths.libsDir}) — skipping (use --force to re-download).`);
    } else {
      console.log(`\nDownloading ${plan.asset!.asset} …`);
      libFiles = await installTranscribeLibs(plan, paths);
      console.log(
        libFiles.length
          ? `✓ Extracted ${libFiles.length} runtime library file(s) → ${paths.libsDir}`
          : `⚠  no shared libraries found in ${plan.asset!.asset} (the asset layout may have changed).`,
      );
    }

    // 2) Model GGUF.
    const modelDest = join(paths.modelsDir, plan.model!.file);
    if (existsSync(modelDest) && !force) {
      console.log(`✓ model already present (${modelDest}) — skipping (use --force to re-download).`);
    } else {
      console.log(`Downloading model ${plan.model!.file} (~${plan.model!.approxSizeMb}MB) …`);
      await downloadTo(plan.model!.url, modelDest);
    }

    // 3) Build transcribe-cli from source against the extracted dylibs.
    //    transcribe.cpp v0.1.1 ships a LIBRARY, not a prebuilt CLI, so we
    //    compile examples/cli/main.cpp + examples/common/wav.cpp against
    //    libtranscribe (a tiny ~127KB compile — no ggml rebuild). Non-fatal:
    //    any failure keeps the current provider + prints guidance.
    const buildResult = await maybeBuildTranscribeCli(paths, libFiles, force);

    // 4) Manifest.
    const manifest: TranscribeCppManifest = {
      version: plan.asset!.asset,
      asset: plan.asset!.asset,
      binFile: "transcribe-cli",
      model: plan.model!.name,
      modelFile: plan.model!.file,
      libFiles,
      binBuiltFrom: buildResult?.ok ? TRANSCRIBE_CPP_SOURCE_REF : undefined,
      os: plan.platform,
      arch: plan.arch,
      ram_gb: plan.totalRamGb,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2));

    // 5) CLI resolution + provider switch — honest, no silent success. `binPath`
    //    resolves to TRANSCRIBE_CPP_BIN or the built binary; we activate
    //    transcribe-cpp only when one actually EXECUTES (`--help` exits 0 —
    //    vault#534: an existsSync-only check activated Linux installs whose CLI
    //    exited 1 on every run). Otherwise we keep the current provider and
    //    report the gap rather than taking transcription offline behind a
    //    provider that can't run.
    if (existsSync(paths.binPath)) {
      const probe = await probeTranscribeCliRunnable(paths.binPath);
      if (probe.ok) {
        setEnvVar("TRANSCRIPTION_PROVIDER", "transcribe-cpp");
        console.log(`\n✓ Installed and activated → TRANSCRIPTION_PROVIDER=transcribe-cpp set in the vault .env.`);
        console.log(`  CLI:   ${paths.binPath} (verified runnable)`);
        console.log(`  Restart vault to activate:  parachute restart vault`);
      } else {
        console.log(
          `\n⚠  transcribe-cli exists at ${paths.binPath} but is NOT runnable (${probe.reason}).`,
        );
        console.log("   NOT activating transcribe-cpp — your current provider is unchanged.");
        console.log(noRunnableCliGuidance(paths, buildResult));
      }
    } else {
      console.log(`\n✓ Libraries + model installed to ${paths.dir} — transcription is NOT yet activated.`);
      console.log(noRunnableCliGuidance(paths, buildResult));
    }
  } catch (err) {
    console.error(`\nInstall failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error("The verb is idempotent — fix the issue and re-run. Or use the remote provider: parachute-vault transcription install --provider scribe-http");
    process.exit(1);
  }
}

/**
 * Download the release tarball, extract it, and place its runtime shared
 * libraries (libtranscribe + libggml `.dylib`/`.so`) into `paths.libsDir`,
 * returning the extracted lib filenames. transcribe.cpp v0.1.1 ships a LIBRARY,
 * not a prebuilt `transcribe-cli` — so we also look for a CLI binary (a future
 * asset may include one) and, if present, place it at `paths.binPath` + chmod +x
 * (the caller decides activation from whether a CLI exists). Uses system `tar`
 * (present on Linux + macOS). Kept out of the plan/dry-run path so tests never
 * hit the network.
 */
async function installTranscribeLibs(
  plan: InstallPlan,
  paths: ReturnType<typeof resolveTranscribeCppPaths>,
): Promise<string[]> {
  const tmpRoot = join(paths.dir, ".dl");
  mkdirSync(tmpRoot, { recursive: true });
  const tarball = join(tmpRoot, plan.asset!.asset);
  await downloadTo(plan.asset!.url, tarball);

  const extractDir = join(tmpRoot, "x");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const tarProc = Bun.spawnSync(["tar", "-xzf", tarball, "-C", extractDir]);
  if (tarProc.exitCode !== 0) {
    throw new Error(`tar extract failed: ${new TextDecoder().decode(tarProc.stderr)}`);
  }

  // Walk the extracted tree: keep the shared libs, opportunistically place a CLI.
  mkdirSync(paths.libsDir, { recursive: true });
  const libFiles: string[] = [];
  for (const rel of readdirSync(extractDir, { recursive: true }) as string[]) {
    const abs = join(extractDir, rel);
    if (!statSync(abs).isFile()) continue;
    const base = rel.split("/").pop()!;
    if (isSharedLibFile(base)) {
      copyFileSync(abs, join(paths.libsDir, base));
      libFiles.push(base);
    } else if (base === "transcribe-cli") {
      copyFileSync(abs, paths.binPath);
      chmodSync(paths.binPath, 0o755);
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  return libFiles;
}

/**
 * Build `transcribe-cli` from source against the extracted dylibs, honoring
 * idempotency + the `TRANSCRIBE_CPP_BIN` operator override. Returns the build
 * result, or `null` when the build was intentionally skipped (already built /
 * operator-provided binary / no libs to link). Non-fatal — logs progress and
 * warnings; failures come back as a typed `{ ok:false }` the caller reports.
 */
async function maybeBuildTranscribeCli(
  paths: ReturnType<typeof resolveTranscribeCppPaths>,
  libFiles: string[],
  force: boolean,
): Promise<CliBuildResult | null> {
  if (process.env.TRANSCRIBE_CPP_BIN?.trim()) {
    console.log(
      existsSync(paths.binPath)
        ? `\n✓ Using operator-provided TRANSCRIBE_CPP_BIN=${paths.binPath} — skipping source build.`
        : `\n⚠  TRANSCRIBE_CPP_BIN=${paths.binPath} is set but no file exists there — skipping source build; nothing will be activated until it points at a real binary.`,
    );
    return null;
  }
  if (existsSync(paths.binPath) && !force) {
    console.log(`\n✓ transcribe-cli already built (${paths.binPath}) — skipping build (use --force to rebuild).`);
    return null;
  }
  if (libFiles.length === 0) {
    console.warn(`\n⚠  no runtime libraries were extracted — cannot build transcribe-cli. Skipping build.`);
    return null;
  }

  console.log(`\nBuilding transcribe-cli from source (transcribe.cpp @ ${TRANSCRIBE_CPP_SOURCE_REF.slice(0, 12)}) …`);
  mkdirSync(paths.binDir, { recursive: true });
  const srcDir = join(paths.dir, ".src");
  const result = await buildTranscribeCli(
    { srcDir, libsDir: paths.libsDir, binPath: paths.binPath },
    {
      platform: process.platform,
      which: (c) => Bun.which(c),
      fetchSource: async (files, dir) => {
        rmSync(dir, { recursive: true, force: true });
        for (const rel of files) {
          const dest = join(dir, rel);
          mkdirSync(dirname(dest), { recursive: true });
          await downloadTo(cliSourceUrl(rel), dest);
        }
      },
      readFile: (p) => readFileSync(p, "utf8"),
      writeFile: (p, content) => writeFileSync(p, content),
      compile: (cmd) => {
        const p = Bun.spawnSync(cmd);
        return { exitCode: p.exitCode ?? 1, stderr: new TextDecoder().decode(p.stderr) };
      },
      exists: existsSync,
      removeBin: (p) => rmSync(p, { force: true }),
      rename: (from, to) => renameSync(from, to),
    },
  );

  if (result.ok) {
    chmodSync(paths.binPath, 0o755); // belt-and-suspenders; the compiler emits 0755
    rmSync(srcDir, { recursive: true, force: true }); // tidy — source is re-fetchable
    console.log(`✓ Built transcribe-cli → ${result.binPath}`);
  } else {
    // Keep srcDir on failure so the printed compile command can be re-run by hand.
    console.warn(`⚠  transcribe-cli build failed (${result.stage}): ${result.message}`);
    if (result.command) console.warn(`   compile command tried:\n     ${result.command}`);
  }
  return result;
}

/**
 * The "no runnable CLI" guidance printed when activation can't proceed —
 * tailored to WHY (build failed at toolchain vs compile, or was skipped).
 */
function noRunnableCliGuidance(
  paths: ReturnType<typeof resolveTranscribeCppPaths>,
  build: CliBuildResult | null,
): string {
  const lines: string[] = [];
  if (build && !build.ok && build.stage === "toolchain") {
    lines.push(
      `\n⚠  Could not build transcribe-cli — ${build.message}`,
      "   To finish, either:",
      `     • install a C++ compiler and re-run this verb (${compilerInstallHint(process.platform)}); OR`,
      "     • build transcribe-cli yourself, point TRANSCRIBE_CPP_BIN at it, and re-run; OR",
      "     • use the remote provider:  parachute-vault transcription install --provider scribe-http",
    );
  } else if (build && !build.ok && build.stage === "fetch") {
    lines.push(
      `\n⚠  Could not fetch the transcribe-cli source — ${build.message}`,
      "   The libraries + model are installed; only the source download failed (check network/proxy).",
      "   To finish, either:",
      "     • re-run this verb once connectivity is restored; OR",
      "     • build transcribe-cli yourself, point TRANSCRIBE_CPP_BIN at it, and re-run; OR",
      "     • use the remote provider:  parachute-vault transcription install --provider scribe-http",
    );
  } else if (build && !build.ok && build.stage === "patch") {
    lines.push(
      `\n⚠  Could not apply the vault#534 backend-init source patch — ${build.message}`,
      "   The pinned upstream source no longer matches the patch anchor. This needs a code fix",
      "   (re-anchor or drop the patch), not a toolchain fix. Until then, either:",
      "     • build a transcribe-cli yourself, point TRANSCRIBE_CPP_BIN at it, and re-run; OR",
      "     • use the remote provider:  parachute-vault transcription install --provider scribe-http",
    );
  } else if (build && !build.ok) {
    lines.push(
      `\n⚠  transcribe-cli build failed (${build.stage}). The libraries + model are installed;`,
      "   the CLI is not. To finish, either:",
      "     • fix the toolchain and re-run this verb; OR",
      "     • build transcribe-cli yourself (the compile command tried is printed above),",
      "       point TRANSCRIBE_CPP_BIN at the result, and re-run; OR",
      "     • use the remote provider:  parachute-vault transcription install --provider scribe-http",
    );
  } else {
    // Build skipped (no libs, or an operator-provided binary that isn't present).
    lines.push(
      "\n⚠  No runnable transcribe-cli is available yet. To finish, either:",
      `     • re-run this verb so it builds a transcribe-cli against ${paths.libsDir} (needs a C++ compiler); OR`,
      "     • point TRANSCRIBE_CPP_BIN at a transcribe-cli you built, and re-run; OR",
      "     • use the remote provider:  parachute-vault transcription install --provider scribe-http",
    );
  }
  lines.push("   Your current provider is unchanged — check with `parachute-vault transcription status`.");
  return lines.join("\n");
}

/** `parachute-vault transcription status` — provider + per-provider install state. */
async function cmdTranscriptionStatus(): Promise<void> {
  const active = resolveTranscriptionProviderName();
  console.log(`Configured provider: ${active}`);

  // What the ratified tier table would pick for this host (install default).
  const tier = selectDefaultProvider({
    platform: process.platform,
    arch: process.arch,
    totalRamBytes: detectTotalRamBytes(),
  });
  console.log(
    `Tier default for this host (${tier.platform}/${tier.arch}, ${tier.totalRamGb}GB): ${tier.provider}${tier.model ? ` (${tier.model})` : ""}`,
  );

  // transcribe-cpp — prebuilt libs + GGUF model + built CLI. "runnable" is an
  // EXECUTED verdict, not a stat: `--help` must actually exit 0 (vault#534 —
  // an existsSync-only check said "yes" on Linux while the CLI exited 1 on
  // every real transcription because its dlopen'd CPU backends never loaded).
  const paths = resolveTranscribeCppPaths();
  const manifest = readManifest(paths.manifestPath);
  const cliPresent = existsSync(paths.binPath);
  const filesPresent = transcribeCppInstalled(paths); // CLI + model both on disk
  let installed = false;
  let notRunnableReason: string | undefined;
  if (!filesPresent) {
    notRunnableReason = !cliPresent ? "no transcribe-cli binary" : "no GGUF model on disk";
  } else {
    const probe = await probeTranscribeCliRunnable(paths.binPath);
    installed = probe.ok;
    notRunnableReason = probe.reason;
  }
  console.log(`\ntranscribe-cpp runnable: ${installed ? "yes" : `no (${notRunnableReason})`}`);
  if (manifest) {
    console.log(`  model:   ${manifest.model} (${manifest.modelFile})`);
    console.log(
      `  libs:    ${paths.libsDir}${manifest.libFiles?.length ? ` (${manifest.libFiles.length} file(s))` : ""}`,
    );
    console.log(
      cliPresent
        ? `  cli:     ${paths.binPath}${manifest.binBuiltFrom ? ` (built from source @ ${manifest.binBuiltFrom.slice(0, 12)})` : ""}`
        : `  cli:     NOT FOUND — re-run \`transcription install\` to build one (needs a C++ compiler), or set TRANSCRIBE_CPP_BIN`,
    );
    console.log(`  ram:     ${manifest.ram_gb}GB at install (${manifest.os}/${manifest.arch})`);
  } else {
    console.log(`  (not installed — run: parachute-vault transcription install --provider transcribe-cpp)`);
  }

  // parakeet-mlx / onnx-asr — Python venv providers (scribe-fold Phase 2b).
  const pyManifest = readPythonManifest(pythonManifestPath());
  const pkBin = resolveParakeetMlxBin();
  const pkRunnable = parakeetMlxInstalled();
  console.log(`\nparakeet-mlx runnable: ${pkRunnable ? "yes" : "no"}`);
  if (pkRunnable) {
    console.log(`  bin:     ${pkBin}`);
    console.log(`  model:   ${resolveParakeetMlxModel()} (HF cache; downloads on first use)`);
  } else {
    console.log(
      process.platform === "darwin" && process.arch === "arm64"
        ? `  (not installed — run: parachute-vault transcription install${tier.provider === "parakeet-mlx" ? "" : " --provider parakeet-mlx"})`
        : "  (macOS Apple Silicon only)",
    );
  }

  const oxBin = resolveOnnxAsrBin();
  const oxRunnable = onnxAsrInstalled();
  console.log(`onnx-asr runnable: ${oxRunnable ? "yes" : "no"}`);
  if (oxRunnable) {
    console.log(`  bin:     ${oxBin}`);
    console.log(`  model:   ${resolveOnnxAsrModel()} (HF cache)`);
  } else {
    console.log(
      `  (not installed — run: parachute-vault transcription install${tier.provider === "onnx-asr" ? "" : " --provider onnx-asr"})`,
    );
  }
  if (pyManifest) {
    console.log(
      `  python install: ${pyManifest.provider} (${pyManifest.pipTarget}) @ ${pyManifest.installedAt}${pyManifest.venv ? ` — venv ${pyManifest.venv}` : ""}`,
    );
  }

  // Offline warning when the ACTIVE provider isn't runnable.
  const activeRunnable =
    active === "scribe-http" ||
    (active === "transcribe-cpp" && installed) ||
    (active === "parakeet-mlx" && pkRunnable) ||
    (active === "onnx-asr" && oxRunnable);
  if (!activeRunnable) {
    console.log(
      `\n⚠  provider is ${active} but no runnable ${active} install was found — transcription is offline until one is available (\`parachute-vault transcription install\`).`,
    );
  }
  console.log(
    `\nAvailable transcribe-cpp models (override with --model): ${Object.values(MODELS).map((m: ModelChoice) => m.name).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Schema maintenance — `parachute-vault schema <subcommand>`
// ---------------------------------------------------------------------------

/**
 * `parachute-vault schema prune` — drop orphaned indexed-field columns +
 * indexes whose declaring tags no longer exist (the gitcoin orphaned-fields
 * bug). Dry-run by default; `--apply` (alias `--yes`) executes. A field
 * co-declared by a still-live tag is never dropped — only the dead declarers
 * are trimmed. Dropping a generated column loses only the index; the source
 * values stay in notes.metadata, so the column rebuilds when the field is
 * declared again.
 */
async function cmdSchema(args: string[] = []) {
  const sub = args[0];
  if (sub === "migrate-field") {
    await cmdSchemaMigrateField(args.slice(1));
    return;
  }
  if (sub !== "prune") {
    console.error("Usage: parachute-vault schema <prune|migrate-field> ...");
    console.error("\nSubcommands:");
    console.error("  prune          Drop orphaned indexed-field columns whose declaring tags are gone.");
    console.error("                 Dry-run by default (--dry-run is an explicit alias); pass --apply (or --yes) to execute.");
    console.error("  migrate-field  Evolve a tag-schema field across existing notes (rename/remap/set-default/retype).");
    console.error("                 Dry-run by default; pass --apply (or --yes) to write. See `schema migrate-field --help`.");
    process.exit(1);
  }

  let vaultName = "default";
  let apply = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--vault") {
      const v = args[++i];
      if (!v) {
        console.error("--vault requires a value.");
        process.exit(1);
      }
      vaultName = v;
    } else if (arg === "--apply" || arg === "--yes") {
      apply = true;
    } else if (arg === "--dry-run") {
      // Dry-run is the default; accept the flag as an explicit affirmative
      // for convention + scriptability. --apply wins if both are passed.
    } else {
      console.error(`Unknown flag for \`schema prune\`: ${arg}`);
      process.exit(1);
    }
  }

  const config = readVaultConfig(vaultName);
  if (!config) {
    console.error(`Vault "${vaultName}" not found.`);
    process.exit(1);
  }

  const { getVaultStore } = await import("./vault-store.ts");
  const store = getVaultStore(vaultName);
  const plan = await store.pruneIndexedFields({ dryRun: !apply });

  const dropped = plan.filter((p) => p.dropped);
  const trimmed = plan.filter((p) => !p.dropped);

  if (plan.length === 0) {
    console.log(`No orphaned indexed fields in vault "${vaultName}". Nothing to prune.`);
    return;
  }

  console.log(
    apply
      ? `Pruned orphaned indexed fields in vault "${vaultName}":`
      : `Would prune orphaned indexed fields in vault "${vaultName}" (dry-run):`,
  );
  for (const p of dropped) {
    console.log(
      `  ${apply ? "DROPPED" : "drop  "} ${p.field}  (dead declarers: ${p.deadDeclarers.join(", ")})`,
    );
  }
  for (const p of trimmed) {
    console.log(
      `  ${apply ? "TRIMMED" : "trim  "} ${p.field}  (removed dead declarers: ${p.deadDeclarers.join(", ")}; column kept — still co-declared)`,
    );
  }
  console.log(
    `\n${apply ? "Dropped" : "Would drop"} ${dropped.length} orphaned field(s); ${apply ? "trimmed" : "would trim"} ${trimmed.length} co-declared field(s).`,
  );
  if (!apply) {
    console.log("Re-run with --apply (or --yes) to execute.");
  }
}

/**
 * `parachute-vault schema migrate-field <tag> <field> --transform <spec>` —
 * evolve a tag-schema field's type / values across the existing notes that
 * carry the tag (vault#314). Dry-run by default — prints the count + a sample
 * of what WOULD change and writes nothing; `--apply` (alias `--yes`) executes.
 *
 * Transform specs (the built-in set — issue #314):
 *   rename:<newkey>          move the field's value to <newkey>, drop the old key
 *   remap:<old>=<new>[,…]    rewrite enum-style values (repeatable / comma-sep)
 *   set-default:<value>      fill the field where missing/null
 *   set-default-invalid:<v>  set <v> where missing/null OR currently schema-invalid
 *   to_string | to_int | to_number | to_boolean   retype the value
 *
 * The migration writes through `strict` enforcement (the migrate-bypass path,
 * vault#299) so a freshly-declared strict field that the back-catalog violates
 * doesn't block the rewrite, and every bypassed write is logged. Rewrites are
 * attributed `migrate` (last_updated_*); created_* is preserved.
 *
 * Atomic by default: if any note's value can't be converted (e.g. `to_int` on
 * "banana"), the apply aborts BEFORE writing anything and lists the offenders.
 * Pass `--continue-on-error` for best-effort (write the convertible, skip the rest).
 */
async function cmdSchemaMigrateField(args: string[]) {
  const usageLine =
    "Usage: parachute-vault schema migrate-field <tag> <field> --transform <spec> [--vault <name>] [--apply|--yes] [--continue-on-error]";
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(usageLine);
    console.log("\nTransform specs:");
    console.log("  rename:<newkey>          Move the field's value to <newkey>, drop the old key.");
    console.log("  remap:<old>=<new>[,...]  Rewrite enum-style values (repeatable, comma-separated).");
    console.log("  set-default:<value>      Set <value> on notes where the field is missing/null.");
    console.log("  set-default-invalid:<v>  Set <v> where missing/null OR the current value is schema-invalid.");
    console.log("  to_string | to_int | to_number | to_boolean   Retype the field's value.");
    console.log("\nDry-run by default — prints the plan. Pass --apply (or --yes) to write.");
    return;
  }

  let vaultName = "default";
  let apply = false;
  let continueOnError = false;
  let transformSpec: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--vault") {
      const v = args[++i];
      if (!v) { console.error("--vault requires a value."); process.exit(1); }
      vaultName = v;
    } else if (arg === "--transform") {
      const v = args[++i];
      if (!v) { console.error("--transform requires a value."); process.exit(1); }
      transformSpec = v;
    } else if (arg === "--apply" || arg === "--yes") {
      apply = true;
    } else if (arg === "--dry-run") {
      // default; accept as an explicit affirmative
    } else if (arg === "--continue-on-error") {
      continueOnError = true;
    } else if (arg.startsWith("--")) {
      console.error(`Unknown flag for \`schema migrate-field\`: ${arg}`);
      process.exit(1);
    } else {
      positionals.push(arg);
    }
  }

  const [tag, field] = positionals;
  if (!tag || !field || !transformSpec) {
    console.error(usageLine);
    console.error("\n  <tag> <field> and --transform <spec> are all required.");
    console.error("  Run `schema migrate-field --help` for the transform spec list.");
    process.exit(1);
  }

  const { parseTransformSpec } = await import("../core/src/migrate-tag-field.ts");
  let transform;
  try {
    transform = parseTransformSpec(transformSpec);
  } catch (err) {
    console.error(`Invalid --transform "${transformSpec}": ${(err as Error).message}`);
    process.exit(1);
  }

  const config = readVaultConfig(vaultName);
  if (!config) {
    console.error(`Vault "${vaultName}" not found.`);
    process.exit(1);
  }

  const { getVaultStore } = await import("./vault-store.ts");
  const { migrateTagField } = await import("../core/src/migrate-tag-field.ts");
  const { logStrictBypass } = await import("./scopes.ts");
  const store = getVaultStore(vaultName);

  const result = await migrateTagField(store, {
    tag,
    field,
    transform: transform!,
    apply,
    continueOnError,
    // The CLI is the operator path — it bypasses strict enforcement by nature
    // (writes go through the store, not the scope-gated transport). Log every
    // waived violation so the bypass is auditable, exactly as MW2 intends.
    onStrictBypass: (info) => logStrictBypass(info),
  });

  const verb = result.applied ? "Migrated" : "Would migrate";
  console.log(
    `${verb} field "${result.field}" on #${result.tag} in vault "${vaultName}"${result.applied ? "" : " (dry-run)"}:`,
  );
  console.log(
    `  scanned ${result.scanned} · ${result.applied ? "changed" : "would change"} ${result.changed} · unchanged ${result.unchanged} · errored ${result.errored}`,
  );

  if (result.sample.length > 0) {
    console.log(`\n  ${result.applied ? "Changes" : "Sample of changes"} (${result.sample.length}${result.changed > result.sample.length ? ` of ${result.changed}` : ""}):`);
    for (const c of result.sample) {
      const ref = c.path ?? c.id;
      if (c.renamedTo) {
        console.log(`    ${ref}: ${field} → ${c.renamedTo} = ${JSON.stringify(c.after)}`);
      } else {
        console.log(`    ${ref}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
      }
    }
  }

  if (result.errors.length > 0) {
    console.log(`\n  Unconvertible (${result.errors.length}):`);
    for (const e of result.errors) {
      console.log(`    ${e.path ?? e.id}: ${e.error}`);
    }
    if (apply && !result.applied) {
      console.log(
        "\n  Aborted without writing — some notes can't be converted (atomic by default).",
      );
      console.log("  Fix the data, or re-run with --continue-on-error to migrate the rest.");
      process.exit(1);
    }
  }

  if (!apply && result.changed > 0) {
    console.log("\n  Re-run with --apply (or --yes) to write these changes.");
  }
  if (result.changed === 0 && result.errored === 0) {
    console.log("\n  Nothing to migrate — the back-catalog already conforms.");
  }
}

// ---------------------------------------------------------------------------
// Export-watch glue. The git-shell + commit-message logic lives in
// `./export-watch.ts` for unit-testability; cli.ts just wires it in.
// ---------------------------------------------------------------------------

async function ensureGitRepo(dir: string): Promise<void> {
  const { isGitRepo } = await import("./export-watch.ts");
  if (!(await isGitRepo(dir))) {
    console.error(
      `error: --git-commit requires "${dir}" to be a git repo.\n` +
        `Initialize it first:\n` +
        `  cd "${dir}" && git init && git add -A && git commit -m "initial"\n` +
        `Then re-run the export.`,
    );
    process.exit(1);
  }
}

/**
 * Snapshot the title of the first changed note since `cursor` — used as the
 * `{{first_note_title}}` template variable for single-note commit messages.
 * Best-effort: returns empty string when nothing matches, or when the cursor
 * is unset (initial export, where "first changed note" is ambiguous).
 *
 * Filters at the DB layer via `dateFilter: { field: "updated_at", from:
 * cursor }` — earlier versions used `sort: "asc"` + `limit: 1` + a
 * client-side `stamp >= cursor` post-filter, which fetched the vault's
 * oldest note and almost always failed the filter, rendering the template
 * variable as empty in production. See vault#346 reviewer note.
 */
async function firstChangedNoteTitle(
  store: ReturnType<typeof import("./vault-store.ts")["getVaultStore"]>,
  cursor: string | undefined,
): Promise<string> {
  if (!cursor) return "";
  try {
    const notes = await store.queryNotes({
      limit: 1,
      sort: "asc",
      dateFilter: { field: "updated_at", from: cursor },
    });
    return notes[0]?.path ?? notes[0]?.id ?? "";
  } catch {
    // Best-effort; template var defaults to empty.
    return "";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Outcome of bootstrapping a fresh vault's first credential (vault#282 Stage 2).
 *
 * Vault no longer mints `pvt_*` tokens. When a token IS minted (explicit opt-in
 * only — vault#442), it's a hub-issued JWT scoped narrow (`vault:<name>:read`
 * or `:write`, NEVER `:admin`), minted via the same operator.token → hub
 * mint-token path `mcp-install --mint` uses (cli.ts ~`cmdMcpInstall`). When no
 * hub is reachable (standalone install, no operator.token, or no real hub
 * origin), `token` is null and `guidance` carries the operator's next step.
 */
interface VaultCredential {
  /** Hub-issued JWT scoped narrow (read/write), or null when not minted / no hub reachable. */
  token: string | null;
  /** Human-readable note: how the token was issued, or why it wasn't. */
  guidance: string;
}

/**
 * Mint a scope-narrow credential for a vault (explicit opt-in — vault#442).
 *
 * Default vault auth is per-user OAuth (browser sign-in on first MCP connect);
 * tokens are only for the header-auth / script use case and are minted ONLY
 * when explicitly requested. Decision (vault#442): the create/init flow NEVER
 * auto-mints, and when a token IS requested it's scope-narrow — `verb` is
 * `read` (default) or `write`, NEVER `admin`. (Admin tokens, when truly
 * needed, are minted out-of-band via `mcp-install --scope vault:admin` against
 * a hub running hub#449, or the hub admin SPA's own session-cookie path.)
 *
 * When a hub is reachable (operator.token present AND a real hub origin
 * resolves), mint a `vault:<name>:<verb>` hub JWT and return it. When no hub is
 * reachable, return `token: null` plus explicit standalone guidance. There is
 * no local pvt_* fallback anymore.
 */
async function mintBootstrapCredential(
  name: string,
  verb: "read" | "write" = "read",
  /**
   * Test seam — injectable hub-presence probe. Defaults to the live
   * `detectHubPresence` (loopback `/health` + configured-origin check). Lets
   * tests drive both branches of the no-operator-token copy without a real hub.
   */
  detectHub: typeof detectHubPresence = detectHubPresence,
): Promise<VaultCredential> {
  const operatorToken = readOperatorToken();
  if (!operatorToken) {
    // No operator.token. Two very different worlds, identical symptom:
    //   (a) Hub running on a fresh box — the token isn't minted until the
    //       admin wizard creates the first admin user (hub init Step 1.5 is a
    //       no-op until then). NOTHING to do here; the old "install the hub …"
    //       copy is circular (this very flow was spawned *by* the hub). #445.
    //   (b) Genuinely standalone — no hub at all. The original guidance holds.
    const hubPresent = await detectHub();
    return {
      token: null,
      guidance: noOperatorTokenGuidance(hubPresent),
    };
  }
  const port = readGlobalConfig().port || DEFAULT_PORT;
  const hub = chooseHubOrigin(port);
  if (hub.source === "loopback") {
    return {
      token: null,
      guidance:
        "No token issued — no hub origin configured (PARACHUTE_HUB_ORIGIN unset, no active " +
        "expose-state). Start the hub and set PARACHUTE_HUB_ORIGIN (or bring up an exposure), " +
        "then run `parachute-vault mcp-install`, or set VAULT_AUTH_TOKEN.",
    };
  }
  const result = await mintHubJwt({
    hubOrigin: hub.url,
    operatorToken,
    scope: `vault:${name}:${verb}`,
    subject: "parachute-vault-bootstrap",
  });
  if ("kind" in result) {
    const detail =
      result.kind === "network"
        ? `hub unreachable at ${result.origin} — ${result.cause}`
        : `hub mint-token rejected (HTTP ${result.status}, ${result.error}): ${result.description}`;
    return {
      token: null,
      guidance:
        `No token issued — ${detail}. Verify the hub is running, ` +
        "then run `parachute-vault mcp-install`, or set VAULT_AUTH_TOKEN.",
    };
  }
  return {
    token: result.token,
    guidance: `Minted hub JWT (jti=${result.jti}, expires ${result.expires_at}, scope ${result.scope}).`,
  };
}

/**
 * Create a vault's config + DB.
 *
 * Default vault auth is per-user OAuth (vault#442) — create does NOT mint or
 * bake in any token. Returns a `VaultCredential` whose `token` is null and
 * whose `guidance` points at the OAuth-first connect path. A scope-narrow
 * token is minted only when the caller passes `mintVerb` (the explicit
 * header-auth / script opt-in: `read` default or `write`, NEVER `admin`). The
 * DB is created lazily via `getVaultStore` so migrations + schema run; we never
 * write any pvt_* row.
 */
interface CreateVaultOptions {
  /**
   * Opt-in token mint (vault#442). Unset → no token is minted; the vault uses
   * per-user OAuth on first MCP connect. Set to `read`/`write` → mint a
   * scope-narrow `vault:<name>:<verb>` hub JWT for the header-auth / script
   * use case. `admin` is intentionally NOT accepted here.
   */
  mintVerb?: "read" | "write";
  /**
   * Override the server-wide `default_mirror` knob for this one create.
   * `--no-mirror` on `parachute-vault create` sets this to `false` so the
   * vault is created with no mirror config even when the knob is `internal`.
   * Unset → fall back to the `default_mirror` global config knob (default
   * `internal`).
   */
  enableMirror?: boolean;
  /**
   * Test seam threaded straight into `bootstrapInternalMirror` (default
   * `Bun.which`). Inject a fn returning `null` to exercise the
   * git-not-installed best-effort path without uninstalling git from the
   * test host.
   */
  which?: (cmd: string) => string | null;
}

/**
 * The History / "Live Mirror" preset, written at create time when the
 * `default_mirror` knob resolves to `internal`. Matches the History preset
 * the admin SPA's VaultMirror page applies:
 *   `{enabled:true, location:internal, sync_mode:events, auto_commit:true,
 *    auto_push:false}`.
 * Built on top of `defaultMirrorConfig()` so the non-preset fields
 * (commit_template, safety_net_seconds) stay canonical.
 */
function historyPresetMirrorConfig(): MirrorConfig {
  return {
    ...defaultMirrorConfig(),
    enabled: true,
    location: "internal",
    sync_mode: "events",
    auto_commit: true,
    auto_push: false,
  };
}

/**
 * Resolve whether a freshly created vault should get the internal mirror.
 * Precedence: explicit per-create override (`--no-mirror`) → server-wide
 * `default_mirror` knob (default `internal`).
 */
function shouldEnableCreateTimeMirror(opts: CreateVaultOptions): boolean {
  if (opts.enableMirror !== undefined) return opts.enableMirror;
  // Default to "internal" when the knob is unset — backup-on-by-default.
  return (readGlobalConfig().default_mirror ?? "internal") === "internal";
}

async function createVault(
  name: string,
  opts: CreateVaultOptions = {},
): Promise<VaultCredential> {
  const config: VaultConfig = {
    name,
    api_keys: [],
    created_at: new Date().toISOString(),
  };
  writeVaultConfig(config);

  // Touch the store so the vault's SQLite DB + schema are created. No token
  // row is written — vault is a pure hub resource-server post-0.5.0.
  const seedStore = getVaultStore(name);

  // Seed the default packs (welcome web + capture tag, Getting Started guide)
  // so the first minute shows a small living graph and a connected AI can read
  // the guide and help the operator set the vault up. Surface Starter is NOT
  // default-seeded — `parachute-vault add-pack surface-starter` adds it later.
  // Idempotent + best-effort: only writes notes that are absent, and never
  // fails the create. Runs BEFORE the mirror bootstrap so the seeded content
  // lands in the initial mirror commit. See src/onboarding-seed.ts +
  // core/src/seed-packs.ts.
  await seedOnboardingNotesBestEffort(seedStore);

  // Default new vaults to an internal live mirror (local git backup of the
  // markdown projection). Backup-on-by-default; GitHub off-site backup is an
  // opt-in upgrade layered on top later. Opt out via the `default_mirror: off`
  // global knob (operators on git-less / disk-constrained / cloud boxes) or
  // the `--no-mirror` flag (this one create only).
  //
  // BEST-EFFORT, NON-FATAL: write the mirror config first (so the operator's
  // intent persists even if git is absent), then attempt the bootstrap. A
  // git-less box leaves the config written but inactive + logs an actionable
  // hint — it must NEVER fail the vault create. Create-time ONLY: existing
  // vaults are never retroactively migrated.
  if (shouldEnableCreateTimeMirror(opts)) {
    const mirrorConfig = historyPresetMirrorConfig();
    writeMirrorConfigForVault(name, mirrorConfig);
    const mirrorPath = resolveMirrorPath(vaultDir(name), mirrorConfig);
    if (mirrorPath) {
      try {
        const result = await bootstrapInternalMirror(mirrorPath, opts.which);
        if (!result.ok) {
          // git-not-installed (or refuse-to-clobber) — config stays written,
          // mirror just isn't active yet. Surface an actionable line; the
          // vault create succeeds regardless.
          console.error(
            `Note: local git backup configured but not yet active — ${result.error} ` +
              `Install git to activate; the backup turns on automatically on the next vault restart.`,
          );
        }
      } catch (err) {
        // Defense-in-depth: bootstrapInternalMirror already converts the
        // git-missing case into a non-throwing { ok:false } result, but a
        // truly unexpected throw must still not fail the create.
        console.error(
          `Note: local git backup configured but bootstrap hit an unexpected error ` +
            `(${(err as Error).message ?? err}). The vault was still created; ` +
            `the backup will retry on the next vault restart.`,
        );
      }
    }
  }

  // vault#442: default to per-user OAuth — do NOT auto-mint or bake in a
  // shared token. Only mint when the caller explicitly opted in (header-auth /
  // script use case), and then scope-narrow (read/write, never admin).
  if (opts.mintVerb) {
    return mintBootstrapCredential(name, opts.mintVerb);
  }
  return {
    token: null,
    guidance:
      "No token minted — this vault uses per-user OAuth (sign in on first connect). " +
      "Need a header-auth token for a script? Run " +
      `\`parachute auth mint-token --scope vault:${name}:read\` (or \`:write\`).`,
  };
}

interface InstallMcpConfigOpts {
  /** Absolute path to the MCP client config file. Computed by the caller via `resolveInstallTarget`. */
  targetPath: string;
  /** `mcpServers.<entryKey>` slot the entry lands at. Default is `parachute-vault`; multi-vault installs key as `parachute-vault-<name>`. */
  entryKey: string;
  /**
   * URL embedded in the entry's `url` field. The caller is the sole source of
   * truth — `buildMcpEntryPlan` produces both `entryKey` and `url` together,
   * and passing them through closes the preview ⇄ writer invariant (the
   * shape the preview promised is the shape that lands on disk). See
   * vault#302; #301 introduced the seam for `entryKey`, this closes it for
   * `url` too.
   */
  url: string;
  /** Bearer token to embed in `Authorization: Bearer …`. Omitted means the entry is unauthenticated — only useful for OAuth-capable clients (Claude Code does discovery). */
  bearer?: string;
  /**
   * When set, the entry is keyed under `projects[<localProjectKey>].mcpServers`
   * inside `~/.claude.json` (Claude Code's `local` scope: private to this
   * machine, scoped to this directory). When unset, keyed at top-level
   * `mcpServers` (user scope) or written directly to `./.mcp.json`
   * (project scope — caller passes the project file path).
   */
  localProjectKey?: string;
}

/**
 * Write the MCP entry into the target config file. Pure file-writer — the
 * caller has already decided `entryKey` and `url` (via `buildMcpEntryPlan`).
 * Returns `void`; the caller already has `url` and `source` for logging.
 */
function installMcpConfig(opts: InstallMcpConfigOpts): void {
  const { targetPath, entryKey, url, bearer, localProjectKey } = opts;

  let config: any = {};
  if (existsSync(targetPath)) {
    try {
      config = JSON.parse(readFileSync(targetPath, "utf-8"));
    } catch {}
  }

  const mcpEntry: Record<string, unknown> = { type: "http", url };
  if (bearer) {
    mcpEntry.headers = { Authorization: `Bearer ${bearer}` };
  }

  if (localProjectKey) {
    if (!config.projects || typeof config.projects !== "object") config.projects = {};
    if (!config.projects[localProjectKey] || typeof config.projects[localProjectKey] !== "object") {
      config.projects[localProjectKey] = {};
    }
    const projectEntry = config.projects[localProjectKey];
    if (!projectEntry.mcpServers || typeof projectEntry.mcpServers !== "object") {
      projectEntry.mcpServers = {};
    }
    projectEntry.mcpServers[entryKey] = mcpEntry;
  } else {
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[entryKey] = mcpEntry;
  }

  writeFileSync(targetPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * `parachute-vault add-pack <pack> [--vault <name>]` — apply a named seed
 * pack (starter notes + tags) to a vault.
 *
 * New vaults default-seed the `welcome` + `getting-started` packs at create;
 * this verb adds the opt-in ones (today: `surface-starter`) — or re-applies a
 * default pack to an older vault that predates it. Idempotent per item: a
 * note is created only when no note lives at its path (a re-run never
 * clobbers an edited note); tag upserts converge on the same rows.
 *
 * Unlike `import` (bulk stream writes, vault#323 daemon-busy guard), this is
 * a handful of tiny writes against a WAL database, so it runs fine next to a
 * live daemon; a write-lock collision (SQLITE_BUSY) is caught with a
 * retry-is-safe message instead of pre-emptively demanding a daemon stop.
 */
async function cmdAddPack(args: string[]) {
  let vaultName = "default";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--vault") {
      const v = args[++i];
      if (!v) {
        console.error("--vault requires a value.");
        process.exit(1);
      }
      vaultName = v;
    } else {
      positional.push(arg);
    }
  }
  const packName = positional[0];

  const { listSeedPacks, getSeedPack, applySeedPack } = await import(
    "../core/src/seed-packs.ts"
  );

  const printPacks = () => {
    console.error("\nAvailable packs:");
    for (const p of listSeedPacks()) {
      console.error(`  ${p.name.padEnd(17)} ${p.description}`);
    }
  };

  if (!packName) {
    console.error("Usage: parachute-vault add-pack <pack> [--vault <name>]");
    printPacks();
    process.exit(1);
  }

  const pack = getSeedPack(packName);
  if (!pack) {
    console.error(`Unknown pack: "${packName}"`);
    printPacks();
    process.exit(1);
  }

  const config = readVaultConfig(vaultName);
  if (!config) {
    console.error(`Vault "${vaultName}" not found. Run: parachute-vault create ${vaultName}`);
    process.exit(1);
  }

  const store = getVaultStore(vaultName);
  try {
    const result = await applySeedPack(store, pack);
    console.log(`Pack "${pack.name}" applied to vault "${vaultName}":`);
    for (const path of result.seededNotes) {
      console.log(`  + note  ${path}`);
    }
    for (const path of result.skippedNotes) {
      console.log(`  = note  ${path} (already exists — left untouched)`);
    }
    for (const tag of result.tags) {
      if (result.preservedTagDescriptions.includes(tag)) {
        console.log(`  ~ tag   ${tag} (kept user description)`);
      } else {
        console.log(`  ~ tag   ${tag} (upserted)`);
      }
    }
    if (result.seededNotes.length === 0 && result.tags.length === 0) {
      console.log("  Nothing to add — everything was already in place.");
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    if (message.includes("SQLITE_BUSY") || (err as { code?: string })?.code === "SQLITE_BUSY") {
      console.error(
        `error: the vault database is busy (a running daemon holds the write lock). ` +
          `add-pack is idempotent — re-run it, or stop the daemon first with: parachute stop vault`,
      );
    } else {
      console.error(`error: failed to apply pack "${pack.name}": ${message}`);
    }
    process.exit(1);
  }
}

function usage() {
  console.log(`
Parachute Vault — self-hosted knowledge graph

If you installed via the Parachute Hub, prefer the wrapper commands for
lifecycle — \`parachute start vault\`, \`parachute stop vault\`,
\`parachute status\` — and use the vault-direct commands below for setup,
data, and debugging.

── Standard use ───────────────────────────────────────────────────────

Setup:
  parachute-vault init [--configure-claude-code|--no-mcp] [--token|--no-token]
                       [--vault-name <name>] [--autostart|--no-autostart]
                                           Set up everything (one command, idempotent). init's
                                           job is to get you to the web setup wizard and surface
                                           your connector URL + a ready-to-paste \`claude mcp add\`
                                           command — it does NOT write the Claude Code MCP config
                                           (~/.claude.json) by default. Pass --configure-claude-code
                                           (alias --mcp-install / --mcp) to opt in and have init
                                           write that entry for you (per-user OAuth — no baked token;
                                           sign in on first connect); --no-mcp is the explicit "don't".
                                           The standalone \`parachute-vault mcp-install\` command remains
                                           the canonical way to wire Claude Code anytime.
                                           --token opts into ALSO minting a scope-narrow
                                           header-auth token (vault:<name>:read) for non-OAuth clients /
                                           scripts; --no-token (the default) skips minting entirely.
                                           --vault-name skips the prompt and names the vault
                                           (lowercase alphanumeric, hyphens, underscores;
                                           omit to be prompted interactively, default "default").
                                           --autostart registers vault with launchd / systemd so
                                           it starts on boot AND auto-restarts on crash; it forces
                                           registration even when a hub supervisor is detected
                                           (logged with a warning). --no-autostart skips daemon
                                           registration AND uninstalls any prior registration — for
                                           CI, dev sandboxes, Docker, or environments where another
                                           supervisor manages the process. Default: register when
                                           standalone, but skip when a hub is detected (the hub
                                           supervisor owns vault's lifecycle). An explicit flag
                                           persists in config.yaml as 'autostart: true|false'.
                                           Upgrade note: a box with a persisted 'autostart: true'
                                           (from an earlier explicit --autostart) keeps registering
                                           even under a hub — run init --no-autostart once to clear
                                           it and let the hub manage vault.
  parachute-vault doctor                   Diagnose install/config issues
  parachute-vault uninstall [--wipe] [--yes]
                                           Remove daemon + MCP entry; --wipe also removes vaults, .env,
                                           config.yaml, and daemon logs (vault.log, vault.err).
                                           --yes skips prompts (DANGEROUS with --wipe: no confirmation).
  parachute-vault url                      Print the local server URL (for scripts)
  parachute --version                      Print the installed version (alias: -v, version)

Vaults:
  parachute-vault create <name> [--json] [--no-mirror] [--mint [--scope read|write]] [--token <bearer>]
                                           Create a new vault (--json: emit { name, token, paths, set_as_default }).
                                           Default auth is per-user OAuth — NO token is minted; connect with
                                           "claude mcp add --transport http parachute-<name> <endpoint>" and sign in
                                           on first use. --mint opts into a scope-narrow hub JWT for the header-auth /
                                           script case (--scope read [default] | write — admin is NOT mintable from
                                           create); --token <bearer> pastes an existing bearer instead of minting.
                                           New vaults default to an internal live mirror — a local git backup of
                                           the markdown projection (backup on by default; GitHub off-site is an
                                           opt-in upgrade). --no-mirror creates a bare vault with no mirror config.
                                           Operators can flip the server-wide default with 'default_mirror: off' in
                                           config.yaml (recommended for cloud / disk-constrained boxes).
  parachute-vault add-pack <pack> [--vault <name>]
                                           Add a named seed pack (starter notes + tags) to a vault
                                           (default vault: "default"). Run with no arguments to list
                                           the available packs. New vaults seed the "welcome" +
                                           "getting-started" packs automatically; "surface-starter"
                                           is opt-in via this command. Idempotent: notes are only
                                           created when absent — a re-run never clobbers an edited
                                           note.
  parachute-vault list                     List all vaults
  parachute-vault remove <name> [--yes]    Remove a vault
  parachute-vault mcp-install [--mint|--token <t>]
                              [--scope vault:read|vault:write|vault:admin]
                              [--install-scope local|user|project]
                              [--vault <name>] [--client claude-code]
                              [--dry-run]
                                            Install vault MCP into a client config.
                                            From a terminal with no flags: walks you
                                            through a contextual conversation (vault,
                                            location, auth) with smart defaults +
                                            preview before write. Pass any flag and
                                            the command runs non-interactively.
                                            Default (non-interactive): --mint
                                            (hub-issued JWT via ~/.parachute/operator.token)
                                            into ~/.claude.json under
                                            projects[<cwd>].mcpServers (local scope,
                                            matches Claude Code's claude-mcp-add
                                            default) with vault:read scope.
                                            --token <t>: paste an existing bearer
                                            (hub JWT or VAULT_AUTH_TOKEN) instead of
                                            minting. (vault#282 Stage 2 removed the
                                            --legacy-pat pvt_* mint — vault is a pure
                                            hub resource-server now; without a hub,
                                            paste a bearer or set VAULT_AUTH_TOKEN.)
                                            --scope vault:admin IS mintable via
                                            --mint (hub#449): hub mints
                                            vault:<name>:admin when the operator
                                            bearer carries parachute:host:admin
                                            (the default operator.token does).
                                            Requires a hub running hub#449.
                                            --install-scope local (default) writes
                                            ~/.claude.json under
                                            projects[<cwd>].mcpServers (this
                                            directory only). user writes top-level
                                            mcpServers (every project). project
                                            writes ./.mcp.json (check into the repo).
                                            For headless flows (\`claude -p\` in
                                            scripts, cron jobs, runners), prefer
                                            --install-scope user — local-scope
                                            entries don't propagate to claude -p
                                            subprocesses; interactive sessions
                                            from the install directory still see
                                            local just fine.
                                            --vault <name> targets a specific
                                            vault and keys the entry as
                                            parachute-vault-<name>.
                                            --dry-run prints the write that would
                                            happen (target file, entry key, URL)
                                            without touching disk or hitting the
                                            hub. Useful for probing.

  parachute-vault mcp-config <vault-name> [--token <bearer>] [--base-url <url>]
                                          [--env-vars]
                                            Emit the JSON config consumed by
                                            \`claude -p --mcp-config '<json>'\`.
                                            Pattern:
                                              claude -p --mcp-config \\
                                                "$(parachute-vault mcp-config <name>)" \\
                                                --strict-mcp-config ...
                                            --token or PARACHUTE_VAULT_TOKEN env
                                            supplies the bearer; both absent
                                            exits 1 with a clear error.
                                            --base-url overrides the auto-detected
                                            origin (e.g. tailnet-exposed hubs).
                                            --env-vars emits the template form
                                            with \${PARACHUTE_HUB_URL} and
                                            \${PARACHUTE_VAULT_TOKEN} placeholders
                                            (safe to commit; expanded at runtime).

Tokens (vault#282 Stage 2 — vault is a pure hub resource-server; it no longer
mints its own tokens. Mint a hub-issued JWT with \`parachute-vault mcp-install\`
or \`parachute auth mint-token --scope vault:<name>:<verb>\`. \`list\` / \`revoke\`
below operate on any vestigial pre-0.5.0 rows for cleanup.):
  parachute-vault tokens                          List vault-DB tokens (every vault)
  parachute-vault tokens list --vault <name>      List tokens for one vault only
  parachute-vault tokens revoke <token-id>        Revoke a vestigial token (default vault)

OAuth — owner password + 2FA (LEGACY):
  Vault's standalone OAuth consent page was retired in 0.4.x (workstream E).
  OAuth runs on the hub now. These commands still write the legacy YAML
  fields (hub's \`expose public\` posture-check reads them), but they
  don't gate any consent flow inside vault. Set hub credentials with
  \`parachute auth set-password\`.

  parachute-vault set-password             Set/change owner password (legacy YAML field)
  parachute-vault set-password --clear     Remove the owner password
  parachute-vault 2fa status               Show 2FA state
  parachute-vault 2fa enroll               Enable TOTP 2FA (QR + backup codes)
  parachute-vault 2fa disable              Disable 2FA
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
  parachute-vault import <path>                       Import portable-md export OR legacy
                                                       Obsidian vault (autodetected by
                                                       presence of .parachute/vault.yaml)
  parachute-vault import <path> --blow-away           DESTRUCTIVE: wipe target vault, replay
                                                       (disaster recovery; confirms)
  parachute-vault import <path> --dry-run             Preview import without writing
  parachute-vault export <dir>                        Export vault as portable markdown
                                                       (Obsidian/Logseq/Foam/Quartz-compatible)
  parachute-vault export <dir> --since <iso>          Incremental: only notes updated_at >= ISO
  parachute-vault export <dir> --watch                Stay alive; re-export on every write
                                                       (poll every --interval seconds, default 5)
  parachute-vault export <dir> --git-commit           After export, git add -A + commit in <dir>
                                                       (combine with --watch for auto-history;
                                                       template via --git-message-template;
                                                       --git-push to push after commit)

History:
  parachute-vault history [--vault <name>]             Show the vault's git write history (the
                                                       mirror is git-backed — one file per note,
                                                       so git log IS a tamper-evident history)
  parachute-vault history --note <path>                Scope to one note's history (git log --follow)
  parachute-vault history --limit N                    Cap the number of commits (default 100)
  parachute-vault history --note <path> --show <sha>   Print that note's content at a past revision
  parachute-vault history --json                       Emit history as JSON

Schema maintenance:
  parachute-vault schema prune [--vault <name>]       Drop orphaned indexed-field columns +
                                                       indexes whose declaring tags no longer
                                                       exist. Dry-run by default (--dry-run is an
                                                       explicit alias) — prints the drop plan
                                                       without changing anything.
  parachute-vault schema prune --apply                Execute the prune (alias: --yes). Co-declared
                                                       fields keep their column; a drop loses only
                                                       the index (data lives in notes.metadata).
  parachute-vault schema migrate-field <tag> <field>  Evolve a tag-schema field across existing
    --transform <spec>                                 notes (rename:<key>, remap:<old>=<new>,
                                                       set-default:<v>, to_string/to_int/to_number/
                                                       to_boolean). Dry-run by default — prints the
                                                       plan; pass --apply (or --yes) to write.
                                                       Writes through strict enforcement (migrate
                                                       bypass). See \`schema migrate-field --help\`.

Transcription (scribe-fold):
  parachute-vault transcription install [--dry-run] [--model <id>] [--force] [--yes]
                                           Install this host's tier-default LOCAL provider (probes
                                           OS/arch + RAM, prints the pick + footprint, confirms):
                                             macOS Apple Silicon 8GB+ → parakeet-mlx (Python venv, MLX)
                                             Linux 4GB+               → onnx-asr (Python venv, int8 ONNX)
                                             Linux ~2GB               → transcribe-cpp + small whisper GGUF
                                             ~1GB / below floor       → remote steer (never forced)
                                           Activation is honest: TRANSCRIPTION_PROVIDER flips only when
                                           a runnable binary exists. Idempotent; --dry-run prints the
                                           pick without downloading; --force re-downloads / bypasses the
                                           RAM floor on an explicit --provider; --yes skips the confirm.
  parachute-vault transcription install --provider <name>
                                           Override the tier default. transcribe-cpp downloads the
                                           runtime libs + a GGUF (--model overrides the RAM-tier pick:
                                           whisper-tiny.en | whisper-small.en | parakeet-tdt-0.6b-v3;
                                           builds transcribe-cli from source — needs a C++ compiler).
                                           parakeet-mlx / onnx-asr install a Python venv under
                                           ~/.parachute/transcription/venv (needs python3; apt-installs
                                           python3/ffmpeg on Linux). scribe-http switches back to the
                                           remote provider (no download).
  parachute-vault transcription status     Show the configured provider, this host's tier default, and
                                           per-provider install state.

── Advanced / standalone ──────────────────────────────────────────────

Direct daemon controls. For normal use, prefer the Parachute Hub wrappers
— they add PID tracking, log rotation, and cross-service \`parachute status\`
visibility. Use these when running vault without the hub or when debugging.

  parachute-vault serve                    Run server in the foreground (no PID tracking).
                                           Prefer \`parachute start vault\` for managed lifecycle.
  parachute-vault status                   Vault-only daemon status.
                                           Prefer \`parachute status\` for a cross-service view.
  parachute-vault logs                     Stream server logs
  parachute-vault restart                  Restart the daemon
  parachute-vault stop                     Signal a graceful shutdown of the running server
                                           (writes \`~/.parachute/vault/stop.signal\` — useful
                                           when no signal channel is available, e.g. Docker
                                           exec or unmanaged foreground runs).
`);
}
