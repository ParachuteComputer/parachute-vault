#!/usr/bin/env bun
/**
 * Multi-vault HTTP server using Bun.serve().
 *
 * Routes:
 *   GET  /health                           — health check
 *   *    /mcp                              — unified MCP (all vaults, vault param)
 *   POST /v1/audio/transcriptions          — transcription (via scribe)
 *   GET  /v1/models                        — transcription providers
 *   GET  /vaults                           — list vaults
 *   *    /vaults/{name}/api/notes[/...]     — note CRUD
 *   *    /vaults/{name}/api/tags            — tag listing
 *   *    /vaults/{name}/api/links           — link CRUD
 *   GET  /vaults/{name}/api/search          — full-text search
 */

import { readVaultConfig, readGlobalConfig, listVaults, DEFAULT_PORT, ensureConfigDirSync, loadEnvFile } from "./config.ts";
import { authenticateRequest } from "./auth.ts";
import { getVaultStore } from "./vault-store.ts";
import { handleMcpHttp } from "./mcp-http.ts";
import { handleNotes, handleTags, handleLinks, handleSearch, handleTranscription, handleModels } from "./routes.ts";

ensureConfigDirSync();
loadEnvFile();

const globalConfig = readGlobalConfig();
const port = parseInt(process.env.PORT ?? "") || globalConfig.port || DEFAULT_PORT;

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Mcp-Session-Id",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const response = await route(req, path);
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

  // Unified MCP endpoint (all vaults via `vault` param on each tool)
  if (path === "/mcp" || path.startsWith("/mcp/")) {
    return handleMcpHttp(req);
  }

  // Whisper-compatible transcription
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

  // Vault-scoped REST API: /vaults/{name}/api/...
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

  const authError = authenticateRequest(req, vaultConfig);
  if (authError) return authError;

  const store = getVaultStore(vaultName);

  // REST API routes under /vaults/{name}/api/...
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
  if (apiPath === "/health") {
    return Response.json({ status: "ok", vault: vaultName });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
