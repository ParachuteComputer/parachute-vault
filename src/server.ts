#!/usr/bin/env bun
/**
 * Multi-vault HTTP server using Bun.serve().
 *
 * Routes:
 *   GET  /health                           — health check
 *   *    /mcp                              — unified MCP (all vaults, vault param)
 *   *    /vaults/{name}/mcp                — scoped MCP (single vault, no vault param)
 *   POST /v1/audio/transcriptions          — transcription (via scribe)
 *   GET  /v1/models                        — transcription providers
 *   GET  /vaults                           — list vaults
 *   *    /vaults/{name}/api/...            — per-vault REST API
 */

import { useHomebrewSQLiteIfNeeded } from "../core/src/embeddings.ts";

// Must be called before any Database is opened — enables sqlite-vec on macOS
useHomebrewSQLiteIfNeeded();

import { readVaultConfig, readGlobalConfig, listVaults, DEFAULT_PORT, ensureConfigDirSync, loadEnvFile } from "./config.ts";
import { authenticateVaultRequest, authenticateGlobalRequest, isMethodAllowed } from "./auth.ts";
import { getVaultStore } from "./vault-store.ts";
import { handleUnifiedMcp, handleScopedMcp } from "./mcp-http.ts";
import { handleNotes, handleTags, handleLinks, handleSearch, handleStorage, handleIngest, handleTranscription, handleModels } from "./routes.ts";

ensureConfigDirSync();
loadEnvFile();

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
    if (apiPath === "/tags") return handleTags(req, store);
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
  if (apiPath === "/tags") {
    return handleTags(req, store);
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
