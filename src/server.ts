#!/usr/bin/env bun
/**
 * Multi-vault HTTP server using Bun.serve().
 *
 * Routes:
 *   GET  /health                          — health check
 *   *    /vaults/{name}/api/notes[/...]    — note CRUD
 *   *    /vaults/{name}/api/tags           — tag listing
 *   *    /vaults/{name}/api/links          — link CRUD
 *   GET  /vaults/{name}/api/search         — full-text search
 *   *    /vaults/{name}/mcp               — MCP over HTTP
 *   GET  /vaults                          — list vaults
 */

import { readVaultConfig, readGlobalConfig, listVaults, DEFAULT_PORT, ensureConfigDirSync, loadEnvFile } from "./config.ts";
import { authenticateRequest } from "./auth.ts";
import { getVaultStore } from "./vault-store.ts";
import { generateVaultMcpTools } from "./mcp-tools.ts";
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
      // Add CORS headers to response
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

  // Whisper-compatible transcription endpoint (served by parachute-scribe)
  if (path === "/v1/audio/transcriptions" && req.method === "POST") {
    return handleTranscription(req);
  }

  // Whisper-compatible models endpoint (health check for clients)
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

  // Vault-scoped routes: /vaults/{name}/...
  const vaultMatch = path.match(/^\/vaults\/([^/]+)(\/.*)?$/);
  if (!vaultMatch) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const vaultName = vaultMatch[1];
  const subpath = vaultMatch[2] ?? "";

  // Load vault config
  const vaultConfig = readVaultConfig(vaultName);
  if (!vaultConfig) {
    return Response.json(
      { error: "Vault not found", vault: vaultName },
      { status: 404 },
    );
  }

  // Auth check (skip for health)
  const authError = authenticateRequest(req, vaultConfig);
  if (authError) return authError;

  // Get or create store
  const store = getVaultStore(vaultName);

  // MCP endpoint
  if (subpath === "/mcp" || subpath.startsWith("/mcp/")) {
    const mcpTools = generateVaultMcpTools(store.db, vaultConfig);
    return handleMcpHttp(req, mcpTools, vaultName);
  }

  // REST API routes under /vaults/{name}/api/...
  const apiMatch = subpath.match(/^\/api(\/.*)?$/);
  if (!apiMatch) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const apiPath = apiMatch[1] ?? "";

  // /api/notes[/...]
  if (apiPath.startsWith("/notes")) {
    const notePath = apiPath.slice(6); // strip "/notes"
    return handleNotes(req, store, notePath);
  }

  // /api/tags
  if (apiPath === "/tags") {
    return handleTags(req, store);
  }

  // /api/links
  if (apiPath === "/links") {
    return handleLinks(req, store);
  }

  // /api/search
  if (apiPath === "/search") {
    return handleSearch(req, store);
  }

  // /api/health
  if (apiPath === "/health") {
    return Response.json({ status: "ok", vault: vaultName });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
