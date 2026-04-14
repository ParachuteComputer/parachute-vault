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

import { readVaultConfig, readGlobalConfig, writeGlobalConfig, writeVaultConfig, listVaults, DEFAULT_PORT, ensureConfigDirSync, loadEnvFile, generateApiKey, hashKey } from "./config.ts";
import { authenticateVaultRequest, authenticateGlobalRequest, isMethodAllowed, extractApiKey } from "./auth.ts";
import type { AuthResult } from "./auth.ts";
import type { VaultConfig } from "./config.ts";
import { migrateVaultKeys } from "./token-store.ts";
import { getVaultStore } from "./vault-store.ts";
import { handleUnifiedMcp, handleScopedMcp } from "./mcp-http.ts";
import { handleNotes, handleTags, handleFindPath, handleVault, handleUnresolvedWikilinks, handleStorage, handleViewNote } from "./routes.ts";
import { defaultHookRegistry } from "../core/src/hooks.ts";
import { registerTriggers } from "./triggers.ts";
import { handleProtectedResource, handleAuthorizationServer, handleRegister, handleAuthorizeGet, handleAuthorizePost, handleToken } from "./oauth.ts";

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

// Migrate tag schemas from vault.yaml → DB for each vault.
// Only inserts schemas that don't already exist in the DB (safe across restarts).
for (const vaultName of listVaults()) {
  const vaultConfig = readVaultConfig(vaultName);
  if (vaultConfig?.tag_schemas && Object.keys(vaultConfig.tag_schemas).length > 0) {
    const store = getVaultStore(vaultName);
    const existingTags = new Set(store.listTagSchemas().map((s) => s.tag));
    let migrated = 0;
    for (const [tag, schema] of Object.entries(vaultConfig.tag_schemas)) {
      if (!existingTags.has(tag)) {
        store.upsertTagSchema(tag, schema);
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

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
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
function isViewAuthenticated(req: Request, vaultConfig: VaultConfig | null, vaultDb?: import("bun:sqlite").Database): boolean {
  if (!vaultConfig) return false;
  // extractApiKey now checks headers AND ?key= query param
  const key = extractApiKey(req);
  if (!key) return false;
  const auth = authenticateVaultRequest(req, vaultConfig, vaultDb);
  return !("error" in auth);
}

async function route(req: Request, path: string, clientIp?: string): Promise<Response> {
  // OAuth discovery endpoints (no auth required)
  if (path === "/.well-known/oauth-protected-resource") {
    return handleProtectedResource(req);
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return handleAuthorizationServer(req);
  }

  // OAuth flow endpoints (no auth — these ARE the auth)
  if (path === "/oauth/register" || path === "/oauth/authorize" || path === "/oauth/token") {
    const defaultVault = readGlobalConfig().default_vault ?? "default";
    const vaultConfig = readVaultConfig(defaultVault);
    if (!vaultConfig) {
      return Response.json({ error: "server_error", error_description: "Default vault not configured" }, { status: 500 });
    }
    const store = getVaultStore(defaultVault);

    if (path === "/oauth/register") {
      return handleRegister(req, store.db);
    }
    if (path === "/oauth/authorize") {
      const ownerPasswordHash = readGlobalConfig().owner_password_hash ?? null;
      if (req.method === "GET") {
        return handleAuthorizeGet(req, store.db, vaultConfig.name, ownerPasswordHash);
      }
      if (req.method === "POST") {
        return handleAuthorizePost(req, store.db, {
          vaultName: vaultConfig.name,
          clientIp,
          ownerPasswordHash,
        });
      }
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    if (path === "/oauth/token") {
      return handleToken(req, store.db);
    }
  }

  // Health check — vault names only for authenticated requests
  if (path === "/health") {
    const auth = authenticateGlobalRequest(req);
    if ("error" in auth) {
      return Response.json({ status: "ok" });
    }
    return Response.json({ status: "ok", vaults: listVaults() });
  }

  // Unified MCP (all vaults, global auth)
  if (path === "/mcp" || path.startsWith("/mcp/")) {
    const auth = authenticateGlobalRequest(req);
    if ("error" in auth) return auth.error;
    return handleUnifiedMcp(req, auth);
  }

  // View endpoint — serves notes as HTML (auth-aware, supports ID or path)
  const viewMatch = path.match(/^\/view\/(.+)$/);
  if (viewMatch && req.method === "GET") {
    const defaultVault = readGlobalConfig().default_vault ?? "default";
    const vaultConfig = readVaultConfig(defaultVault);
    if (!vaultConfig) {
      return Response.json({ error: "Default vault not found" }, { status: 404 });
    }
    const store = getVaultStore(defaultVault);
    const authenticated = isViewAuthenticated(req, vaultConfig, store.db);
    return handleViewNote(store, decodeURIComponent(viewMatch[1]), {
      authenticated,
      publishedTag: vaultConfig.published_tag,
    });
  }

  // Backward compat: /public/:noteId → /view/:noteId (preserving query params)
  const publicMatch = path.match(/^\/public\/([^/]+)$/);
  if (publicMatch && req.method === "GET") {
    const dest = new URL(`/view/${publicMatch[1]}`, req.url);
    dest.search = new URL(req.url).search;
    return Response.redirect(dest.toString(), 301);
  }


  // List vaults — requires auth
  if (path === "/vaults" && req.method === "GET") {
    const auth = authenticateGlobalRequest(req);
    if ("error" in auth) return auth.error;
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
    const store = getVaultStore(defaultVault);
    const auth = authenticateVaultRequest(req, vaultConfig, store.db);
    if ("error" in auth) return auth.error;
    if (!isMethodAllowed(req.method, auth.permission)) {
      return Response.json({ error: "Forbidden", message: "Insufficient permissions" }, { status: 403 });
    }
    const apiPath = path.slice(4); // strip "/api"
    if (apiPath.startsWith("/notes")) return handleNotes(req, store, apiPath.slice(6));
    if (apiPath.startsWith("/tags")) return handleTags(req, store, apiPath.slice(5));
    if (apiPath === "/find-path") return handleFindPath(req, store);
    if (apiPath === "/vault") return handleVault(req, store, vaultConfig, (desc) => {
      vaultConfig.description = desc;
      writeVaultConfig(vaultConfig);
    });
    if (apiPath === "/unresolved-wikilinks") return handleUnresolvedWikilinks(req, store);
    if (apiPath.startsWith("/storage")) return handleStorage(req, apiPath.slice(8), defaultVault);
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
    const dest = new URL(`/vaults/${vaultName}/view/${vaultPublicMatch[1]}`, req.url);
    dest.search = new URL(req.url).search;
    return Response.redirect(dest.toString(), 301);
  }

  // View endpoint — serves notes as HTML (auth-aware, vault-scoped, supports ID or path)
  const vaultViewMatch = subpath.match(/^\/view\/(.+)$/);
  if (vaultViewMatch && req.method === "GET") {
    const store = getVaultStore(vaultName);
    const authenticated = isViewAuthenticated(req, vaultConfig, store.db);
    return handleViewNote(store, decodeURIComponent(vaultViewMatch[1]), {
      authenticated,
      publishedTag: vaultConfig.published_tag,
    });
  }

  // Vault-scoped OAuth endpoints (no auth — these ARE the auth)
  if (subpath === "/oauth/register" || subpath === "/oauth/authorize" || subpath === "/oauth/token") {
    const store = getVaultStore(vaultName);
    if (subpath === "/oauth/register") return handleRegister(req, store.db);
    if (subpath === "/oauth/authorize") {
      const ownerPasswordHash = readGlobalConfig().owner_password_hash ?? null;
      if (req.method === "GET") return handleAuthorizeGet(req, store.db, vaultConfig.name, ownerPasswordHash);
      if (req.method === "POST") return handleAuthorizePost(req, store.db, {
        vaultName: vaultConfig.name,
        clientIp,
        ownerPasswordHash,
      });
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    if (subpath === "/oauth/token") return handleToken(req, store.db);
  }

  // Vault-scoped discovery endpoints
  if (subpath === "/.well-known/oauth-protected-resource") return handleProtectedResource(req, `/vaults/${vaultName}/mcp`);
  if (subpath === "/.well-known/oauth-authorization-server") return handleAuthorizationServer(req);

  // Auth: per-vault key OR global key
  const store = getVaultStore(vaultName);
  const auth = authenticateVaultRequest(req, vaultConfig, store.db);
  if ("error" in auth) return auth.error;

  // Per-vault scoped MCP
  if (subpath === "/mcp" || subpath.startsWith("/mcp/")) {
    return handleScopedMcp(req, vaultName, auth);
  }

  // Bare /vaults/{name} — single-vault root. Returns name, description,
  // createdAt, and stats. One round trip for a viz landing page.
  if (subpath === "" || subpath === "/") {
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const stats = store.getVaultStats();
    return Response.json({
      name: vaultName,
      description: vaultConfig.description,
      createdAt: vaultConfig.created_at,
      stats,
    });
  }

  // REST API — enforce permission level
  if (!isMethodAllowed(req.method, auth.permission)) {
    return Response.json(
      { error: "Forbidden", message: "Insufficient permissions" },
      { status: 403 },
    );
  }

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
  if (apiPath === "/find-path") {
    return handleFindPath(req, store);
  }
  if (apiPath === "/vault") {
    return handleVault(req, store, vaultConfig, (desc) => {
      vaultConfig.description = desc;
      writeVaultConfig(vaultConfig);
    });
  }
  if (apiPath === "/unresolved-wikilinks") {
    return handleUnresolvedWikilinks(req, store);
  }
  if (apiPath.startsWith("/storage")) {
    return handleStorage(req, apiPath.slice(8), vaultName);
  }
  if (apiPath === "/health") {
    return Response.json({ status: "ok", vault: vaultName });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
