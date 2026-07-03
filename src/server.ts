#!/usr/bin/env bun
/**
 * Multi-vault HTTP server using Bun.serve().
 *
 * Routes:
 *   GET  /health                           — health check
 *   GET  /vaults                           — list vaults with metadata (authenticated)
 *   GET  /vaults/list                      — list vault names (public; disable via config.discovery)
 *   *    /vault/{name}/mcp                 — scoped MCP (per-vault session)
 *   *    /vault/{name}/oauth/...           — per-vault OAuth flow
 *   *    /vault/{name}/.well-known/...     — per-vault OAuth discovery
 *   *    /vault/{name}/view/...            — auth-aware HTML note view
 *   *    /vault/{name}/api/...             — per-vault REST API
 *
 * The request pipeline lives in ./routing.ts (exported for unit testing).
 */

import { readVaultConfig, readGlobalConfig, writeGlobalConfig, writeVaultConfig, listVaults, DEFAULT_PORT, ensureConfigDirSync, loadEnvFile, generateApiKey, hashKey, stopSignalPath, bootAutoCreateAllowed } from "./config.ts";
import { existsSync, rmSync } from "fs";
import { migrateVaultKeys } from "./token-store.ts";
import { resolveFirstBootVaultName, reservedNameSquatWarnings } from "./vault-name.ts";
import { getVaultStore, getVaultNameForStore } from "./vault-store.ts";
import { seedOnboardingNotesBestEffort } from "./onboarding-seed.ts";
import { defaultHookRegistry } from "../core/src/hooks.ts";
import { registerTriggers } from "./triggers.ts";
import { loadVaultTriggers } from "./triggers-api.ts";
import { route } from "./routing.ts";
import { startTranscriptionWorker, registerTranscriptionHook, type TranscriptionWorker } from "./transcription-worker.ts";
import { setTranscriptionWorker } from "./transcription-registry.ts";
import { assetsDir } from "./routes.ts";
import { resolveScribeAuthToken, ensureScribeBearer } from "./scribe-env.ts";
import { getCachedScribeUrl } from "./scribe-discovery.ts";
import { readEnvFile, setEnvVar } from "./config.ts";
import { resolveBindHostname } from "./bind.ts";
import { MirrorManager } from "./mirror-manager.ts";
import {
  setMirrorManager,
  setMirrorManagerFactory,
  listMirrorManagers,
} from "./mirror-registry.ts";
import { buildMirrorDeps, resolveMirrorVaultName } from "./mirror-deps.ts";
import { migrateLegacyServerWideCredentials } from "./mirror-credentials.ts";
import {
  commentOutLegacyMirrorBlockFile,
  migrateLegacyServerWideConfig,
  readMirrorConfigForVault,
} from "./mirror-config.ts";
import { GLOBAL_CONFIG_PATH } from "./config.ts";
import { selfRegister } from "./self-register.ts";
import { warnLegacyGlobalApiKeys } from "./auth.ts";
import pkg from "../package.json" with { type: "json" };

// Register webhook triggers from global config. Replaces the old hardcoded
// tts-hook and transcription-hook with config-driven webhooks.
function registerConfiguredTriggers(): void {
  const config = readGlobalConfig();
  if (!config.triggers?.length) {
    console.log("[triggers] no triggers configured in config.yaml");
    return;
  }
  registerTriggers(defaultHookRegistry, config.triggers);
  console.log(`[triggers] registered ${config.triggers.length} trigger(s)`);

  // Soft-deprecation warning: if the dedicated transcription worker is
  // enabled AND a trigger points at what looks like the same scribe endpoint,
  // both will process the same attachments. The trigger's `missing_metadata`
  // guard keeps it idempotent once the worker marks `transcript` on the
  // attachment, but the noise is worth flagging.
  const probedScribeUrl = getCachedScribeUrl();
  if (probedScribeUrl) {
    const scribeHost = safeHost(probedScribeUrl);
    for (const t of config.triggers) {
      if (t.action.send !== "attachment") continue;
      if (scribeHost && safeHost(t.action.webhook) === scribeHost) {
        console.warn(
          `[triggers] "${t.name}" points at scribe (${t.action.webhook}) and the dedicated worker is also enabled; ` +
          `these may double-fire. Prefer the dedicated worker for /v1/audio/transcriptions and remove this trigger.`,
        );
      }
    }
  }
}

function safeHost(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

// Load .env before anything reads process.env — otherwise SCRIBE_URL and
// friends configured in ~/.parachute/vault/.env are invisible to the
// transcription-worker check and the trigger double-fire warning below.
ensureConfigDirSync();
loadEnvFile();

registerConfiguredTriggers();

/**
 * Start the transcription worker if scribe is discoverable. Scribe URL
 * resolution order (per `scribe-discovery.ts`): `SCRIBE_URL` env var, then
 * `~/.parachute/services.json` `parachute-scribe` entry, then nothing.
 *
 * Bearer generation (vault#353): if neither `SCRIBE_AUTH_TOKEN` nor the
 * legacy `SCRIBE_TOKEN` is set, generate a fresh 32-byte base64url bearer
 * and persist it to vault's `.env` so subsequent restarts use the same
 * value. Idempotent — calls after the first see the existing token. The
 * operator (or hub install) is expected to mirror this bearer to scribe's
 * `SCRIBE_AUTH_TOKEN`; without that mirror, scribe will reject the
 * Authorization header on a 401 and transcription fails with a friendly
 * error captured on the transcript note.
 */
const scribeUrl = getCachedScribeUrl();
let transcriptionWorker: TranscriptionWorker | null = null;
if (scribeUrl) {
  // Generate + persist the shared bearer on first boot. Subsequent boots
  // pick up the existing value and don't rotate. Loading the .env back
  // into process.env happens above (`loadEnvFile()`); we re-load here to
  // pick up the just-written value without restart.
  const { created, token } = ensureScribeBearer(readEnvFile, setEnvVar);
  if (created) {
    process.env.SCRIBE_AUTH_TOKEN = token;
    console.log("[transcribe] generated SCRIBE_AUTH_TOKEN (32 bytes, base64url) — mirror this value into scribe's config");
  }
  transcriptionWorker = startTranscriptionWorker({
    vaultList: () => listVaults(),
    getStore: (name) => getVaultStore(name),
    scribeUrl,
    scribeToken: resolveScribeAuthToken(),
    resolveAssetsDir: (vault) => assetsDir(vault),
    getAudioRetention: (vault) => readVaultConfig(vault)?.audio_retention ?? "keep",
    getContextPredicates: (vault) => readVaultConfig(vault)?.transcription?.context,
  });
  // Event-driven hot path — the `attachment:created` hook fires the worker
  // in a microtask instead of waiting for the 30s sweep.
  registerTranscriptionHook(
    defaultHookRegistry,
    transcriptionWorker,
    (store) => getVaultNameForStore(store as never),
  );
  // Expose the worker to the REST retry endpoint so retries kick immediately
  // instead of waiting for the sweep. Idempotent on second boot.
  setTranscriptionWorker(transcriptionWorker);
  console.log(`[transcribe] worker started → ${scribeUrl}`);
} else {
  console.log("[transcribe] worker disabled (no scribe in services.json and SCRIBE_URL unset)");
}

if (process.env.VAULT_AUTH_TOKEN?.trim()) {
  console.log("[auth] VAULT_AUTH_TOKEN set — server-wide operator bearer active");
}

// Legacy GLOBAL api_keys warning (security review — multi-user hardening).
// Surfaced at boot so the operator rotates/removes cross-vault credentials
// before multi-user sharing. Warning only — never touches the keys. The
// logic lives in auth.ts (import-safe + unit-tested); see warnLegacyGlobalApiKeys.
warnLegacyGlobalApiKeys(readGlobalConfig().api_keys);

// First-boot vault creation — ONLY when PARACHUTE_VAULT_NAME is explicitly
// set in the environment. (#478 Part 2)
//
// The hub setup wizard and `parachute init --vault-name <name>` both spawn
// the vault server with PARACHUTE_VAULT_NAME=<operator-chosen-name>; that
// env var is the load-bearing signal that an external orchestrator has
// decided what the first vault should be called. With the env var unset the
// server boots with zero vaults and stays that way — no silent "default"
// — so a fresh install without a wizard can't accidentally squash an
// explicit later `parachute-vault create <name>` call.
//
// Gated on the `auto_create: false` marker (2026-06-09 hub-module-boundary
// migration): `parachute-vault remove` writes it when the operator deletes
// their LAST vault, so an explicit empty-the-server action isn't silently
// undone by a resurrection with fresh credentials on the next boot. Fresh
// installs have no config.yaml — no marker — so the env-var-driven path
// still works on a clean box.
if (listVaults().length === 0) {
  const globalConfig = readGlobalConfig();
  if (!bootAutoCreateAllowed(globalConfig)) {
    console.log(
      '[vault first-boot] auto-create disabled (auto_create: false in config.yaml — the last vault was removed deliberately). Create one with: parachute-vault create <name>',
    );
  } else if (!globalConfig.default_vault) {
    const firstBoot = resolveFirstBootVaultName(process.env.PARACHUTE_VAULT_NAME);
    if (firstBoot.source === "env") {
      // PARACHUTE_VAULT_NAME explicitly set + valid — create the named vault.
      console.log(`[vault first-boot] PARACHUTE_VAULT_NAME=${firstBoot.name} — creating vault`);
      const vaultName = firstBoot.name;
      const { fullKey, keyId } = generateApiKey();
      writeVaultConfig({
        name: vaultName,
        api_keys: [{
          id: keyId,
          label: "default",
          scope: "write",
          key_hash: hashKey(fullKey),
          created_at: new Date().toISOString(),
        }],
        created_at: new Date().toISOString(),
      });
      globalConfig.default_vault = vaultName;
      if (!globalConfig.api_keys?.length) {
        globalConfig.api_keys = [{
          id: keyId,
          label: "default",
          scope: "write",
          key_hash: hashKey(fullKey),
          created_at: new Date().toISOString(),
        }];
      }
      writeGlobalConfig(globalConfig);
      console.log(`Auto-created vault "${vaultName}" (API key: ${fullKey})`);
      // Seed the default packs (welcome web + capture tag, Getting Started
      // guide) so a connected AI can self-orient and help set the vault up —
      // same as the `create`/`init` CLI path. Idempotent + best-effort (never
      // fails first boot). Mirrors createVault() in cli.ts.
      await seedOnboardingNotesBestEffort(getVaultStore(vaultName));
    } else if (firstBoot.source === "env-invalid") {
      // PARACHUTE_VAULT_NAME was set but failed validation — do NOT silently
      // fall back to "default". Log the problem and stay empty so the operator
      // sees the misconfiguration instead of a phantom vault.
      console.warn(
        `[vault first-boot] PARACHUTE_VAULT_NAME=${JSON.stringify(firstBoot.rawValue)} is invalid (${firstBoot.reason}) — server starting with zero vaults. Fix the env var, or create one via the admin wizard, parachute init --vault-name <name>, or parachute-vault create <name>.`,
      );
    } else {
      // PARACHUTE_VAULT_NAME unset — stay empty. No silent "default".
      console.log(
        '[vault first-boot] no vaults and PARACHUTE_VAULT_NAME unset — staying empty. Create one via the admin wizard, parachute init --vault-name <name>, or parachute-vault create <name>.',
      );
    }
  } else {
    // Stale config: default_vault is set but no vault DB exists on disk, so
    // first-boot create is skipped. Without a log line the server would boot
    // empty and silent here, which is confusing. (#478 Part 2)
    console.warn(
      '[vault first-boot] config.yaml has default_vault set but no vaults exist on disk — skipping first-boot create. Create one with: parachute-vault create <name>',
    );
  }
}

// vault#266 — self-register manifest + installDir into services.json so
// hub's discovery / admin SPA can find vault without a `parachute install
// vault` round-trip. Idempotent (re-runs produce the same row when nothing
// changed); never throws (boot must not fail on bookkeeping). The merge-
// preserving `upsertService` ensures any hub-stamped fields on the row
// survive — see self-register.ts header for the v0.6 vs v0.7 design note.
selfRegister({ version: pkg.version });

// Loud boot warning for vaults squatting a shadowed reserved name (B2 of the
// 2026-06-09 hub-module-boundary migration). A vault named `admin`/`new`/
// `assets` (created before the names were reserved) has its entire
// `/vault/<name>/*` data plane shadowed by reserved hub/daemon routes — warn
// with the recovery procedure rather than silently serving nothing.
for (const warning of reservedNameSquatWarnings(listVaults())) {
  console.warn(warning);
}

// Migrate tag schemas from vault.yaml → DB for each vault.
// Only inserts schemas that don't already exist in the DB (safe across restarts).
for (const vaultName of listVaults()) {
  const vaultConfig = readVaultConfig(vaultName);
  if (vaultConfig?.tag_schemas && Object.keys(vaultConfig.tag_schemas).length > 0) {
    const store = getVaultStore(vaultName);
    const existingTags = new Set((await store.listTagSchemas()).map((s) => s.tag));
    let migrated = 0;
    for (const [tag, schema] of Object.entries(vaultConfig.tag_schemas)) {
      if (!existingTags.has(tag)) {
        await store.upsertTagSchema(tag, schema);
        migrated++;
      }
    }
    if (migrated > 0) {
      console.log(`[migration] migrated ${migrated} tag schema(s) from vault.yaml to DB for vault "${vaultName}"`);
    } else {
      console.log(`[migration] vault "${vaultName}" has tag_schemas in vault.yaml (already in DB — vault.yaml section can be removed)`);
    }
  }
}

// Migrate existing API keys from config.yaml → per-vault token tables (idempotent)
{
  const globalCfg = readGlobalConfig();
  for (const vaultName of listVaults()) {
    try {
      const vc = readVaultConfig(vaultName);
      if (!vc) continue;
      const store = getVaultStore(vaultName);
      const migrated = migrateVaultKeys(store.db, vc.api_keys, globalCfg.api_keys);
      if (migrated > 0) {
        console.log(`[tokens] migrated ${migrated} API key(s) into vault "${vaultName}"`);
      }
    } catch (err) {
      console.error(`[tokens] migration error for vault "${vaultName}":`, err);
    }
  }
}

// Load persisted runtime triggers for each vault and register them
// vault-scoped on the shared hook registry (frictionless-channel-setup PR 1).
// Runs alongside the config.yaml trigger registration above; config.yaml
// triggers stay global, these fire only for their own vault. Survives
// restart — the `triggers` table is the source of truth. Per-vault failure
// is isolated so one bad vault can't block the others.
{
  let totalTriggers = 0;
  for (const vaultName of listVaults()) {
    try {
      const store = getVaultStore(vaultName);
      const n = loadVaultTriggers(vaultName, store);
      totalTriggers += n;
      if (n > 0) {
        console.log(`[triggers] loaded ${n} runtime trigger(s) for vault "${vaultName}"`);
      }
    } catch (err) {
      console.error(`[triggers] failed to load runtime triggers for vault "${vaultName}":`, err);
    }
  }
  if (totalTriggers === 0) {
    console.log("[triggers] no persisted runtime triggers");
  }
}

const globalConfig = readGlobalConfig();
const port = parseInt(process.env.PORT ?? "") || globalConfig.port || DEFAULT_PORT;
const hostname = resolveBindHostname();

// ---------------------------------------------------------------------------
// Mirror lifecycle — per-vault (vault#400).
//
// Before vault#400 the server stood up a SINGLE mirror manager bound to the
// mirror-owning vault (default/first), and every mirror route resolved to it
// — so every vault's mirror page showed the default vault's config + git
// remote. Now each vault gets its OWN config (`data/<vault>/mirror-config.yaml`)
// + its OWN manager. Boot:
//
//   1. Migrate the legacy SERVER-WIDE credentials file (vault#399) + the
//      legacy server-wide `mirror:` config block (vault#400) to the
//      mirror-owning vault (default/first). Other vaults start unconfigured.
//   2. Install the lazy-build factory so routes can stand up a manager for
//      any vault on first request (handles a vault configured at runtime
//      without a restart).
//   3. Iterate ALL vaults; for each whose per-vault config has
//      `enabled: true`, build + register + start its manager. Per-vault
//      failure is logged + isolated — one vault's mirror error never breaks
//      another vault's mirror or the vault server's serving path.
// ---------------------------------------------------------------------------
{
  // Canonicalized in `mirror-deps.ts:resolveMirrorVaultName` — the binding
  // rule (default_vault → first listed vault → null) lives in exactly one
  // place. Post-vault#400 it's only used for migration attribution.
  const mirrorVaultName = resolveMirrorVaultName(listVaults);

  // vault#399: migrate the legacy SERVER-WIDE credentials file to the
  // per-vault layout, attributed to the mirror-owning vault. Idempotent +
  // safe (no-op when no legacy file / already migrated; legacy file renamed
  // `.bak`, never deleted). Runs even with no vaults (no-op).
  try {
    migrateLegacyServerWideCredentials(mirrorVaultName);
  } catch (err) {
    console.warn(
      `[mirror] legacy credential migration failed (non-fatal): ${(err as Error).message ?? err}`,
    );
  }

  // vault#400: migrate the legacy server-wide `mirror:` CONFIG block from
  // config.yaml to the mirror-owning vault's per-vault config file. The
  // legacy block is commented out in place (preserved for reference), never
  // silently dropped. Idempotent: no-op when no block / target already
  // configured. (#399 already moved credentials — we do NOT re-migrate them.)
  try {
    migrateLegacyServerWideConfig(
      readGlobalConfig().mirror,
      mirrorVaultName,
      () => commentOutLegacyMirrorBlockFile(GLOBAL_CONFIG_PATH),
    );
  } catch (err) {
    console.warn(
      `[mirror] legacy config migration failed (non-fatal): ${(err as Error).message ?? err}`,
    );
  }

  // Install the lazy-build factory so routes can stand up a per-vault manager
  // on demand (a vault configured at runtime works without a restart).
  setMirrorManagerFactory((name) => new MirrorManager(buildMirrorDeps(name)));

  // Stand up every vault whose per-vault config is enabled. Don't block
  // server startup on slow initial exports — kick each off in the background.
  const vaults = listVaults();
  if (vaults.length === 0) {
    console.log("[mirror] no vaults yet — managers stand up on next restart after a vault exists");
  }
  for (const name of vaults) {
    let cfg;
    try {
      cfg = readMirrorConfigForVault(name);
    } catch (err) {
      console.warn(`[mirror] could not read config for vault "${name}" (skipping): ${(err as Error).message ?? err}`);
      continue;
    }
    if (!cfg?.enabled) continue; // unconfigured / disabled → no manager work
    try {
      const mgr = new MirrorManager(buildMirrorDeps(name));
      setMirrorManager(name, mgr);
      void mgr
        .start()
        .then((status) => {
          if (!status.enabled && status.last_error) {
            console.warn(`[mirror] vault "${name}" startup error: ${status.last_error}`);
          }
        })
        .catch((err) => {
          console.warn(`[mirror] vault "${name}" startup threw: ${(err as Error).message ?? err}`);
        });
    } catch (err) {
      // Isolated per-vault: one vault's failure never touches others.
      console.warn(`[mirror] vault "${name}" manager construction failed: ${(err as Error).message ?? err}`);
    }
  }
}

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 120, // seconds — webhook triggers can take a while
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Mcp-Session-Id",
      // Expose response headers a BROWSER-based MCP client (e.g. claude.ai) must
      // read cross-origin: `WWW-Authenticate` carries the RFC 9728 auth challenge
      // (the `resource_metadata` PRM URL) the client follows to discover the auth
      // server — without exposing it, the browser's fetch() can't see it and the
      // OAuth flow never starts ("Couldn't register with the sign-in service").
      // `Mcp-Session-Id` is the streamable-HTTP MCP session the client echoes
      // back. (Claude Code is a CLI → no CORS → unaffected. The hub already
      // exposes WWW-Authenticate; this matches it on the resource server.)
      "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const start = Date.now();
      const response = await route(req, path);
      const ms = Date.now() - start;
      console.log(`${req.method} ${path} ${response.status} ${ms}ms`);
      for (const [k, v] of Object.entries(corsHeaders)) {
        response.headers.set(k, v);
      }
      return response;
    } catch (err) {
      console.error(`[${req.method} ${path}]`, err);
      return Response.json(
        { error: "Internal server error" },
        { status: 500, headers: corsHeaders },
      );
    }
  },
});

console.log(`Parachute Vault server listening on http://${hostname}:${server.port}`);

// Graceful shutdown — best-effort drain of in-flight note-mutation hooks.
//
// Order matters under the event-driven mirror shape (vault#382):
//   1. Every MirrorManager.stop() runs FIRST (vault#400: drain ALL per-vault
//      managers, not just one) so they unsubscribe from hooks cleanly +
//      cancel their debounce timers. Otherwise the registry drain below
//      would wait on a manager's hook handler that just queued itself after
//      a final mutation.
//   2. Then drain hooks + stop the transcription worker in parallel —
//      neither depends on the other.
//
// The whole thing races a 5s timeout so a stuck handler doesn't hang
// shutdown indefinitely.
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[${signal}] shutting down; in-flight hooks: ${defaultHookRegistry.inFlightCount}`);
  try {
    await Promise.race([
      (async () => {
        // Mirror stop first — unsubscribes + cancels each debounce. Each
        // manager's internal soft-settle timeout (250ms) bounds the wait;
        // drain them in parallel so total shutdown stays bounded.
        await Promise.all(
          listMirrorManagers().map((m) =>
            m.stop().catch((err) =>
              console.warn(`[mirror] stop threw during shutdown (non-fatal): ${(err as Error).message ?? err}`),
            ),
          ),
        );
        // Then drain hooks + stop the transcription worker in parallel.
        await Promise.all([
          defaultHookRegistry.drain(),
          transcriptionWorker?.stop() ?? Promise.resolve(),
        ]);
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (err) {
    console.error("[shutdown] drain error:", err);
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Filesystem-sentinel shutdown: `parachute-vault stop` writes
// `~/.parachute/vault/stop.signal`; we poll for it and exit cleanly when it
// appears. Useful when no signal channel is available — Docker exec, foreground
// runs without a TTY, scripts that can't manage PIDs. Any stale sentinel is
// removed before we start polling so a previous `stop` can't pre-empt this boot.
const STOP_POLL_MS = 500;
try {
  if (existsSync(stopSignalPath())) rmSync(stopSignalPath(), { force: true });
} catch (err) {
  console.warn("[stop-signal] could not clear stale sentinel:", err);
}
setInterval(() => {
  if (!existsSync(stopSignalPath())) return;
  try {
    rmSync(stopSignalPath(), { force: true });
  } catch (err) {
    console.warn("[stop-signal] could not remove sentinel:", err);
  }
  void shutdown("STOP_SIGNAL");
}, STOP_POLL_MS).unref();

