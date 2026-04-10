#!/usr/bin/env bun
/**
 * Multi-vault HTTP server using Bun.serve().
 *
 * Routes:
 *   GET  /health                           — health check
 *   *    /mcp                              — unified MCP (all vaults, vault param)
 *   *    /vaults/{name}/mcp                — scoped MCP (single vault, no vault param)
 *   POST /v1/audio/transcriptions          — transcription (via scribe)
 *   POST /v1/audio/speech                  — text-to-speech (OpenAI-compatible, OGG Opus)
 *   GET  /v1/models                        — transcription providers
 *   GET  /vaults                           — list vaults
 *   *    /vaults/{name}/api/...            — per-vault REST API
 */

// If embeddings are configured, swap to Homebrew SQLite on macOS (must happen before any DB opens)
import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
const _configDir = process.env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
const _envPath = resolve(_configDir, ".env");
if (existsSync(_envPath)) {
  const _envContent = readFileSync(_envPath, "utf-8");
  if (/EMBEDDING_PROVIDER\s*=/.test(_envContent) && !/EMBEDDING_PROVIDER\s*=\s*none/i.test(_envContent)) {
    const { useHomebrewSQLiteIfNeeded } = require("../core/src/embeddings.ts");
    useHomebrewSQLiteIfNeeded();
  }
}

import { readVaultConfig, readGlobalConfig, writeGlobalConfig, writeVaultConfig, listVaults, DEFAULT_PORT, ensureConfigDirSync, loadEnvFile, generateApiKey, hashKey } from "./config.ts";
import { authenticateVaultRequest, authenticateGlobalRequest, isMethodAllowed } from "./auth.ts";
import { getVaultStore } from "./vault-store.ts";
import { handleUnifiedMcp, handleScopedMcp } from "./mcp-http.ts";
import { handleNotes, handleTags, handleLinks, handleSearch, handleStorage, handleIngest, handleTranscription, handleModels, handleTtsSpeech } from "./routes.ts";
import { defaultHookRegistry } from "../core/src/hooks.ts";
import { registerTtsHook, type NarrateModule } from "./tts-hook.ts";
import { registerTranscriptionHook, type ScribeModule } from "./transcription-hook.ts";
import { getVaultNameForStore } from "./vault-store.ts";
import { assetsDir } from "./routes.ts";
import type { SqliteStore } from "../core/src/store.ts";

// Features register their note-mutation hooks here. The TTS (#reader →
// audio) hook is registered if BOTH `parachute-narrate` is installed AND
// a TTS provider is configured in env. Either missing → hook is silently
// skipped, same shape as how transcription handles optional scribe.
async function registerHooks(): Promise<void> {
  let narrate: NarrateModule | null = null;
  try {
    narrate = (await import("parachute-narrate")) as unknown as NarrateModule;
  } catch {
    console.log("[hooks] parachute-narrate not installed; skipping tts-reader hook");
    return;
  }

  // Narrate is loaded but may still be unusable if no provider is
  // configured in env. We probe via `getTtsProvider` rather than waiting
  // for the first note to fail.
  const narrateWithProbe = narrate as NarrateModule & {
    getTtsProvider?: (env: Record<string, string | undefined>) => { name: string } | null;
  };
  const probedProvider = narrateWithProbe.getTtsProvider?.(process.env) ?? null;
  if (!probedProvider) {
    console.log("[hooks] no TTS provider configured in env; skipping tts-reader hook");
    return;
  }

  registerTtsHook(defaultHookRegistry, {
    narrate,
    voice: process.env.TTS_VOICE,
    resolveAssetsDir: (store) => {
      const name = getVaultNameForStore(store as SqliteStore);
      if (!name) {
        throw new Error("tts-hook: store is not registered with a vault");
      }
      return assetsDir(name);
    },
  });
  console.log(`[hooks] tts-reader hook registered (provider=${probedProvider.name}, via parachute-narrate)`);
}

async function registerTranscriptionHooks(): Promise<void> {
  if (process.env.AUTO_TRANSCRIBE === "false") {
    console.log("[hooks] AUTO_TRANSCRIBE=false; skipping transcribe-capture hook");
    return;
  }

  let scribe: ScribeModule | null = null;
  try {
    scribe = (await import("parachute-scribe")) as unknown as ScribeModule;
  } catch {
    console.log("[hooks] parachute-scribe not installed; skipping transcribe-capture hook");
    return;
  }

  registerTranscriptionHook(defaultHookRegistry, {
    scribe,
    transcribeProvider: process.env.TRANSCRIBE_PROVIDER,
    cleanupProvider: process.env.CLEANUP_PROVIDER,
    resolveAssetsDir: (store) => {
      const name = getVaultNameForStore(store as SqliteStore);
      if (!name) {
        throw new Error("transcription-hook: store is not registered with a vault");
      }
      return assetsDir(name);
    },
  });
  console.log("[hooks] transcribe-capture hook registered (via parachute-scribe)");
}

await registerHooks();
await registerTranscriptionHooks();

ensureConfigDirSync();
loadEnvFile();

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

const globalConfig = readGlobalConfig();
const port = parseInt(process.env.PORT ?? "") || globalConfig.port || DEFAULT_PORT;

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  idleTimeout: 120, // seconds — transcription can take a while
  async fetch(req) {
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

console.log(`Parachute Vault server listening on http://0.0.0.0:${server.port}`);

// Graceful shutdown — best-effort drain of in-flight note-mutation hooks.
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[${signal}] shutting down; in-flight hooks: ${defaultHookRegistry.inFlightCount}`);
  try {
    await Promise.race([
      defaultHookRegistry.drain(),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (err) {
    console.error("[shutdown] hook drain error:", err);
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function route(req: Request, path: string): Promise<Response> {
  // Health check
  if (path === "/health") {
    return Response.json({ status: "ok", vaults: listVaults() });
  }

  // Unified MCP (all vaults, global auth)
  if (path === "/mcp" || path.startsWith("/mcp/")) {
    const auth = authenticateGlobalRequest(req);
    if ("error" in auth) return auth.error;
    return handleUnifiedMcp(req, auth.scope);
  }

  // Transcription
  if (path === "/v1/audio/transcriptions" && req.method === "POST") {
    return handleTranscription(req);
  }
  if (path === "/v1/audio/speech" && req.method === "POST") {
    return handleTtsSpeech(req);
  }
  if (path === "/v1/models" && req.method === "GET") {
    return handleModels();
  }

  // List vaults
  if (path === "/vaults" && req.method === "GET") {
    const names = listVaults();
    const vaults = names.map((name) => {
      const config = readVaultConfig(name);
      return {
        name,
        description: config?.description,
        created_at: config?.created_at,
      };
    });
    return Response.json({ vaults });
  }

  // Backward-compatible: /api/* routes to default vault
  if (path.startsWith("/api/")) {
    const defaultVault = readGlobalConfig().default_vault ?? "default";
    const vaultConfig = readVaultConfig(defaultVault);
    if (!vaultConfig) {
      return Response.json({ error: "Default vault not found" }, { status: 404 });
    }
    const auth = authenticateVaultRequest(req, vaultConfig);
    if ("error" in auth) return auth.error;
    if (!isMethodAllowed(req.method, auth.scope)) {
      return Response.json({ error: "Forbidden", message: "Read-only API key" }, { status: 403 });
    }
    const store = getVaultStore(defaultVault);
    const apiPath = path.slice(4); // strip "/api"
    if (apiPath.startsWith("/notes")) return handleNotes(req, store, apiPath.slice(6));
    if (apiPath.startsWith("/tags")) return handleTags(req, store, apiPath.slice(5));
    if (apiPath === "/links") return handleLinks(req, store);
    if (apiPath === "/search") return handleSearch(req, store);
    if (apiPath.startsWith("/storage")) return handleStorage(req, apiPath.slice(8), defaultVault);
    if (apiPath === "/ingest") return handleIngest(req, store, defaultVault);
    if (apiPath === "/health") return Response.json({ status: "ok", vault: defaultVault });
  }

  // Vault-scoped routes: /vaults/{name}/...
  const vaultMatch = path.match(/^\/vaults\/([^/]+)(\/.*)?$/);
  if (!vaultMatch) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const vaultName = vaultMatch[1];
  const subpath = vaultMatch[2] ?? "";

  const vaultConfig = readVaultConfig(vaultName);
  if (!vaultConfig) {
    return Response.json(
      { error: "Vault not found", vault: vaultName },
      { status: 404 },
    );
  }

  // Auth: per-vault key OR global key
  const auth = authenticateVaultRequest(req, vaultConfig);
  if ("error" in auth) return auth.error;

  // Per-vault scoped MCP
  if (subpath === "/mcp" || subpath.startsWith("/mcp/")) {
    return handleScopedMcp(req, vaultName, auth.scope);
  }

  // REST API — enforce read-only scope
  if (!isMethodAllowed(req.method, auth.scope)) {
    return Response.json(
      { error: "Forbidden", message: "Read-only API key cannot perform write operations" },
      { status: 403 },
    );
  }

  const store = getVaultStore(vaultName);
  const apiMatch = subpath.match(/^\/api(\/.*)?$/);
  if (!apiMatch) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const apiPath = apiMatch[1] ?? "";

  if (apiPath.startsWith("/notes")) {
    return handleNotes(req, store, apiPath.slice(6));
  }
  if (apiPath.startsWith("/tags")) {
    return handleTags(req, store, apiPath.slice(5));
  }
  if (apiPath === "/links") {
    return handleLinks(req, store);
  }
  if (apiPath === "/search") {
    return handleSearch(req, store);
  }
  if (apiPath.startsWith("/storage")) {
    return handleStorage(req, apiPath.slice(8), vaultName);
  }
  if (apiPath === "/ingest") {
    return handleIngest(req, store, vaultName);
  }
  if (apiPath === "/health") {
    return Response.json({ status: "ok", vault: vaultName });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
