/**
 * HTTP request router for the multi-vault server.
 *
 * All per-vault resources live under `/vault/<name>/...`. There is no
 * unscoped fallback — a request must name the vault it targets. A fresh
 * install creates a vault named `default`, so `/vault/default/...` is the
 * baseline URL for single-vault deployments.
 *
 * Dispatch shape:
 *
 *   /.well-known/parachute.json        — NOT served here (CLI owns it at
 *                                        origin root; vault never handles it)
 *   /health                            — liveness ping, vault names leaked
 *                                        only to authenticated callers
 *   /vaults/list                       — public vault-name discovery (can be
 *                                        disabled globally via config)
 *   /vaults                            — authenticated vault metadata list
 *   /vault/<name>/.well-known/*        — per-vault OAuth discovery
 *   /vault/<name>/oauth/{register,authorize,token}
 *   /vault/<name>/mcp[/*]              — MCP endpoint (Bearer auth)
 *   /vault/<name>/view/<idOrPath>      — auth-aware HTML view
 *   /vault/<name>/public/<noteId>      — legacy alias → /view redirect
 *   /vault/<name>                      — vault metadata + stats (auth)
 *   /vault/<name>/api/...              — REST surface (auth)
 *
 * There is deliberately no compat for the old `/api/*`, `/mcp`, `/oauth/*`,
 * `/view/*`, or `/vaults/<name>/*` prefixes. Clients must re-authenticate
 * after the upgrade and point at the new URLs.
 */

import type { VaultConfig } from "./config.ts";
import {
  readVaultConfig,
  readGlobalConfig,
  writeVaultConfig,
  listVaults,
} from "./config.ts";
import {
  authenticateVaultRequest,
  authenticateGlobalRequest,
  isMethodAllowed,
  extractApiKey,
} from "./auth.ts";
import { getVaultStore } from "./vault-store.ts";
import { handleScopedMcp } from "./mcp-http.ts";
import {
  handleNotes,
  handleTags,
  handleFindPath,
  handleVault,
  handleUnresolvedWikilinks,
  handleStorage,
  handleViewNote,
} from "./routes.ts";
import {
  handleProtectedResource,
  handleAuthorizationServer,
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleToken,
  getBaseUrl,
} from "./oauth.ts";

/**
 * Decorate a 401 response from the MCP endpoint with the RFC 9728 challenge
 * header pointing at the matching protected-resource metadata document.
 *
 * An MCP-capable OAuth client that receives a plain 401 has no structured way
 * to discover which authorization server to use; the `WWW-Authenticate`
 * header names the metadata document for the exact endpoint they hit.
 */
function mcpWwwAuthenticate(req: Request, vaultName: string): string {
  const base = getBaseUrl(req);
  return `Bearer resource_metadata="${base}/vault/${vaultName}/.well-known/oauth-protected-resource"`;
}

/**
 * Clone a 401 Response and attach the `WWW-Authenticate` challenge header.
 * The auth module returns a fully-baked `Response`, and headers on a consumed
 * `Response` can't be mutated in place; cloning is the cheap path.
 */
async function withMcpChallenge(
  res: Response,
  req: Request,
  vaultName: string,
): Promise<Response> {
  if (res.status !== 401) return res;
  const body = await res.text();
  const headers = new Headers(res.headers);
  headers.set("WWW-Authenticate", mcpWwwAuthenticate(req, vaultName));
  return new Response(body, { status: 401, headers });
}

/**
 * Check if a /view request has a valid API key (header or ?key= query param).
 * Returns true if authenticated, false if not. Never rejects — unauthenticated
 * requests still get public notes.
 */
function isViewAuthenticated(
  req: Request,
  vaultConfig: VaultConfig | null,
  vaultDb?: import("bun:sqlite").Database,
): boolean {
  if (!vaultConfig) return false;
  const key = extractApiKey(req);
  if (!key) return false;
  const auth = authenticateVaultRequest(req, vaultConfig, vaultDb);
  return !("error" in auth);
}

export async function route(
  req: Request,
  path: string,
  clientIp?: string,
): Promise<Response> {
  // ---------------------------------------------------------------------
  // Cross-vault / origin-root endpoints
  // ---------------------------------------------------------------------

  if (path === "/health") {
    const auth = authenticateGlobalRequest(req);
    if ("error" in auth) {
      return Response.json({ status: "ok" });
    }
    return Response.json({ status: "ok", vaults: listVaults() });
  }

  // Public vault-name discovery. Lets unauthenticated clients (e.g. the
  // Daily vault-picker dropdown before OAuth) know which vault to target.
  // Operators who want to hide vault existence can set `discovery: disabled`
  // in ~/.parachute/config.yaml — the endpoint then returns 404.
  if (path === "/vaults/list" && req.method === "GET") {
    const globalConfig = readGlobalConfig();
    if (globalConfig.discovery === "disabled") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ vaults: listVaults() });
  }

  // Authenticated vault metadata list.
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

  // ---------------------------------------------------------------------
  // Per-vault routing: /vault/<name>/...
  // ---------------------------------------------------------------------

  const vaultMatch = path.match(/^\/vault\/([^/]+)(\/.*)?$/);
  if (!vaultMatch) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const vaultName = vaultMatch[1];
  const subpath = vaultMatch[2] ?? "";

  const vaultConfig = readVaultConfig(vaultName);
  if (!vaultConfig) {
    return Response.json({ error: "Vault not found", vault: vaultName }, { status: 404 });
  }

  // Legacy-style /public/:noteId → /view/:noteId redirect (kept as a
  // convenience for published-note URLs that predate the /view/ path).
  const vaultPublicMatch = subpath.match(/^\/public\/([^/]+)$/);
  if (vaultPublicMatch && req.method === "GET") {
    const dest = new URL(`/vault/${vaultName}/view/${vaultPublicMatch[1]}`, req.url);
    dest.search = new URL(req.url).search;
    return Response.redirect(dest.toString(), 301);
  }

  // View endpoint — auth-aware HTML renderer. Unauthenticated requests
  // still serve public notes; a valid API key via header or ?key= query
  // parameter unlocks private notes.
  const vaultViewMatch = subpath.match(/^\/view\/(.+)$/);
  if (vaultViewMatch && req.method === "GET") {
    const store = getVaultStore(vaultName);
    const authenticated = isViewAuthenticated(req, vaultConfig, store.db);
    return handleViewNote(store, decodeURIComponent(vaultViewMatch[1]), {
      authenticated,
      publishedTag: vaultConfig.published_tag,
    });
  }

  // OAuth flow endpoints (no auth — these ARE the auth).
  if (subpath === "/oauth/register" || subpath === "/oauth/authorize" || subpath === "/oauth/token") {
    const store = getVaultStore(vaultName);
    if (subpath === "/oauth/register") return handleRegister(req, store.db);
    if (subpath === "/oauth/authorize") {
      const gc = readGlobalConfig();
      const ownerPasswordHash = gc.owner_password_hash ?? null;
      const totpSecret = gc.totp_secret ?? null;
      const totpEnrolled = typeof totpSecret === "string" && totpSecret.length > 0;
      if (req.method === "GET") {
        return handleAuthorizeGet(
          req,
          store.db,
          vaultConfig.name,
          ownerPasswordHash,
          totpEnrolled,
        );
      }
      if (req.method === "POST") {
        return handleAuthorizePost(req, store.db, {
          vaultName: vaultConfig.name,
          clientIp,
          ownerPasswordHash,
          totpSecret,
        });
      }
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    // handleToken pins the OAuth code to the issuing vault (prevents
    // cross-vault code replay) and echoes `vault: <name>` in the response.
    if (subpath === "/oauth/token") return handleToken(req, store.db, vaultName);
  }

  // OAuth discovery (no auth). The protected-resource metadata advertises
  // this vault's MCP endpoint and names the vault's authorization server;
  // the authorization-server metadata returns endpoints scoped to
  // `/vault/<name>/oauth/*`. Together they keep RFC 9728 → RFC 8414
  // discovery coherent for a single vault.
  if (subpath === "/.well-known/oauth-protected-resource") {
    return handleProtectedResource(req, vaultName);
  }
  if (subpath === "/.well-known/oauth-authorization-server") {
    return handleAuthorizationServer(req, vaultName);
  }

  // ---------------------------------------------------------------------
  // Authenticated surface
  // ---------------------------------------------------------------------

  const store = getVaultStore(vaultName);
  const auth = authenticateVaultRequest(req, vaultConfig, store.db);
  const isScopedMcp = subpath === "/mcp" || subpath.startsWith("/mcp/");
  if ("error" in auth) {
    return isScopedMcp ? withMcpChallenge(auth.error, req, vaultName) : auth.error;
  }

  // MCP (per-vault, single-vault session).
  if (isScopedMcp) {
    return handleScopedMcp(req, vaultName, auth);
  }

  // Bare `/vault/<name>` — single-vault root. Returns name, description,
  // createdAt, and stats. One round trip for a viz landing page.
  if (subpath === "" || subpath === "/") {
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const stats = await store.getVaultStats();
    return Response.json({
      name: vaultName,
      description: vaultConfig.description,
      createdAt: vaultConfig.created_at,
      stats,
    });
  }

  // REST API — enforce permission level.
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

  if (apiPath.startsWith("/notes")) return handleNotes(req, store, apiPath.slice(6), vaultName);
  if (apiPath.startsWith("/tags")) return handleTags(req, store, apiPath.slice(5));
  if (apiPath === "/find-path") return handleFindPath(req, store);
  if (apiPath === "/vault") {
    return handleVault(req, store, vaultConfig, () => {
      writeVaultConfig(vaultConfig);
    });
  }
  if (apiPath === "/unresolved-wikilinks") return handleUnresolvedWikilinks(req, store);
  if (apiPath.startsWith("/storage")) return handleStorage(req, apiPath.slice(8), vaultName);
  if (apiPath === "/health") return Response.json({ status: "ok", vault: vaultName });

  return Response.json({ error: "Not found" }, { status: 404 });
}
