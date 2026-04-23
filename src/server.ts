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

import { readVaultConfig, readGlobalConfig, writeGlobalConfig, writeVaultConfig, listVaults, DEFAULT_PORT, ensureConfigDirSync, loadEnvFile, generateApiKey, hashKey } from "./config.ts";
import { migrateVaultKeys } from "./token-store.ts";
import { getVaultStore, getVaultNameForStore } from "./vault-store.ts";
import { defaultHookRegistry } from "../core/src/hooks.ts";
import { registerTriggers } from "./triggers.ts";
import { route } from "./routing.ts";
import { startTranscriptionWorker, registerTranscriptionHook, type TranscriptionWorker } from "./transcription-worker.ts";
import { assetsDir } from "./routes.ts";
import { resolveScribeAuthToken } from "./scribe-env.ts";
import { resolveBindHostname } from "./bind.ts";

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
  if (process.env.SCRIBE_URL) {
    const scribeHost = safeHost(process.env.SCRIBE_URL);
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
 * Start the transcription worker if SCRIBE_URL is configured. The worker
 * polls every vault for attachments with `metadata.transcribe_status = "pending"`
 * and sends the audio to scribe. Absent SCRIBE_URL, the worker stays off
 * — `{transcribe: true}` uploads still enqueue, they just wait.
 */
let transcriptionWorker: TranscriptionWorker | null = null;
if (process.env.SCRIBE_URL) {
  transcriptionWorker = startTranscriptionWorker({
    vaultList: () => listVaults(),
    getStore: (name) => getVaultStore(name),
    scribeUrl: process.env.SCRIBE_URL,
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
  console.log(`[transcribe] worker started → ${process.env.SCRIBE_URL}`);
} else {
  console.log("[transcribe] worker disabled (set SCRIBE_URL to enable)");
}

// Auto-init: create a default vault if none exist (first run in Docker)
if (listVaults().length === 0) {
  const globalConfig = readGlobalConfig();
  if (!globalConfig.default_vault) {
    const { fullKey, keyId } = generateApiKey();
    writeVaultConfig({
      name: "default",
      api_keys: [{
        id: keyId,
        label: "default",
        scope: "write",
        key_hash: hashKey(fullKey),
        created_at: new Date().toISOString(),
      }],
      created_at: new Date().toISOString(),
    });
    globalConfig.default_vault = "default";
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
    console.log(`Auto-created default vault (API key: ${fullKey})`);
  }
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

const globalConfig = readGlobalConfig();
const port = parseInt(process.env.PORT ?? "") || globalConfig.port || DEFAULT_PORT;
const hostname = resolveBindHostname();

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 120, // seconds — webhook triggers can take a while
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Mcp-Session-Id",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Derive client IP. Default: socket IP only (safe for direct-internet
    // deployments). If TRUST_PROXY=1 is set, honor X-Forwarded-For — use
    // this only when a reverse proxy (Cloudflare Tunnel, nginx, etc.) is
    // terminating the connection, otherwise attackers can spoof the header
    // to evade per-IP rate limiting.
    const trustProxy = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
    const forwardedFor = trustProxy ? req.headers.get("x-forwarded-for") : null;
    const clientIp = forwardedFor
      ? forwardedFor.split(",")[0].trim()
      : server.requestIP(req)?.address;

    try {
      const start = Date.now();
      const response = await route(req, path, clientIp);
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
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[${signal}] shutting down; in-flight hooks: ${defaultHookRegistry.inFlightCount}`);
  try {
    await Promise.race([
      Promise.all([
        defaultHookRegistry.drain(),
        transcriptionWorker?.stop() ?? Promise.resolve(),
      ]),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (err) {
    console.error("[shutdown] drain error:", err);
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

