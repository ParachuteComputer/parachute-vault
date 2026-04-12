#!/usr/bin/env bun
/**
 * Multi-vault HTTP server using Bun.serve().
 *
 * Routes:
 *   GET  /health                           — health check
 *   *    /mcp                              — unified MCP (all vaults, vault param)
 *   *    /vaults/{name}/mcp                — scoped MCP (single vault, no vault param)
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
import { authenticateVaultRequest, authenticateGlobalRequest, isMethodAllowed, extractApiKey, isLocalhost } from "./auth.ts";
import type { VaultConfig } from "./config.ts";
import { getVaultStore } from "./vault-store.ts";
import { handleUnifiedMcp, handleScopedMcp } from "./mcp-http.ts";
import { handleNotes, handleTags, handleLinks, handleGraph, handleSearch, handleResolveWikilink, handleUnresolvedWikilinks, handleStorage, handleIngest, handleViewNote } from "./routes.ts";
import { defaultHookRegistry } from "../core/src/hooks.ts";
import { registerTriggers } from "./triggers.ts";

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
}

registerConfiguredTriggers();

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
  idleTimeout: 120, // seconds — webhook triggers can take a while
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

/**
 * Check if a /view request has a valid API key (header or ?key= query param).
 * Returns true if authenticated, false if not. Never rejects — unauthenticated
 * requests still get public notes.
 */
function isViewAuthenticated(req: Request, vaultConfig: VaultConfig | null): boolean {
  if (isLocalhost(req)) return true;

  // Check query param first (convenient for browsers)
  const url = new URL(req.url);
  const queryKey = url.searchParams.get("key");
  const headerKey = extractApiKey(req);
  const key = queryKey ?? headerKey;
  if (!key || !vaultConfig) return false;

  const auth = authenticateVaultRequest(
    queryKey && !headerKey
      ? new Request(req.url, { headers: { ...Object.fromEntries(req.headers), "x-api-key": key } })
      : req,
    vaultConfig,
  );
  return !("error" in auth);
}

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

  // View endpoint — serves notes as HTML (auth-aware)
  const viewMatch = path.match(/^\/view\/([^/]+)$/);
  if (viewMatch && req.method === "GET") {
    const defaultVault = readGlobalConfig().default_vault ?? "default";
    const vaultConfig = readVaultConfig(defaultVault);
    if (!vaultConfig) {
      return Response.json({ error: "Default vault not found" }, { status: 404 });
    }
    const store = getVaultStore(defaultVault);
    const authenticated = isViewAuthenticated(req, vaultConfig);
    return handleViewNote(store, viewMatch[1], {
      authenticated,
      publishedTag: vaultConfig.published_tag,
    });
  }

  // Backward compat: /public/:noteId → /view/:noteId
  const publicMatch = path.match(/^\/public\/([^/]+)$/);
  if (publicMatch && req.method === "GET") {
    return Response.redirect(new URL(`/view/${publicMatch[1]}`, req.url).toString(), 301);
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
    if (apiPath === "/graph") return handleGraph(req, store);
    if (apiPath === "/search") return handleSearch(req, store);
    if (apiPath === "/resolve-wikilink") return handleResolveWikilink(req, store);
    if (apiPath === "/unresolved-wikilinks") return handleUnresolvedWikilinks(req, store);
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

  // Backward compat: /vaults/{name}/public/:noteId → /view/:noteId
  const vaultPublicMatch = subpath.match(/^\/public\/([^/]+)$/);
  if (vaultPublicMatch && req.method === "GET") {
    return Response.redirect(new URL(`/vaults/${vaultName}/view/${vaultPublicMatch[1]}`, req.url).toString(), 301);
  }

  // View endpoint — serves notes as HTML (auth-aware, vault-scoped)
  const vaultViewMatch = subpath.match(/^\/view\/([^/]+)$/);
  if (vaultViewMatch && req.method === "GET") {
    const store = getVaultStore(vaultName);
    const authenticated = isViewAuthenticated(req, vaultConfig);
    return handleViewNote(store, vaultViewMatch[1], {
      authenticated,
      publishedTag: vaultConfig.published_tag,
    });
  }

  // Auth: per-vault key OR global key
  const auth = authenticateVaultRequest(req, vaultConfig);
  if ("error" in auth) return auth.error;

  // Per-vault scoped MCP
  if (subpath === "/mcp" || subpath.startsWith("/mcp/")) {
    return handleScopedMcp(req, vaultName, auth.scope);
  }

  // Bare /vaults/{name} — single-vault root. Returns name, description,
  // createdAt, and stats. One round trip for a viz landing page.
  if (subpath === "" || subpath === "/") {
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const store = getVaultStore(vaultName);
    const stats = store.getVaultStats();
    return Response.json({
      name: vaultName,
      description: vaultConfig.description,
      createdAt: vaultConfig.created_at,
      stats,
    });
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
  if (apiPath === "/graph") {
    return handleGraph(req, store);
  }
  if (apiPath === "/search") {
    return handleSearch(req, store);
  }
  if (apiPath === "/resolve-wikilink") {
    return handleResolveWikilink(req, store);
  }
  if (apiPath === "/unresolved-wikilinks") {
    return handleUnresolvedWikilinks(req, store);
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
