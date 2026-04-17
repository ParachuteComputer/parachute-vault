/**
 * HTTP request router for the multi-vault server.
 *
 * Extracted from server.ts so routes are unit-testable without spinning up
 * Bun.serve(). server.ts imports this and wires it into the listener.
 *
 * Path dispatch order (skim):
 *   - /.well-known/oauth-*           — public OAuth discovery
 *   - /oauth/*                       — unscoped OAuth (targets default vault)
 *   - /health                        — lightweight ping
 *   - /mcp, /mcp/*                   — unified MCP (global auth)
 *   - /view/:id                      — default-vault HTML view
 *   - /public/:id                    — backward-compat redirect → /view
 *   - /vaults/list                   — PUBLIC vault names (no auth, no metadata)
 *   - /vaults                        — authenticated vault metadata listing
 *   - /api/*                         — default-vault REST API
 *   - /vaults/:name/*                — vault-scoped: view, oauth, mcp, api
 */

import type { VaultConfig } from "./config.ts";
import {
  readVaultConfig,
  readGlobalConfig,
  writeVaultConfig,
  listVaults,
  resolveDefaultVault,
} from "./config.ts";
import {
  authenticateVaultRequest,
  authenticateGlobalRequest,
  isMethodAllowed,
  extractApiKey,
} from "./auth.ts";
import { getVaultStore } from "./vault-store.ts";
import { handleUnifiedMcp, handleScopedMcp } from "./mcp-http.ts";
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
} from "./oauth.ts";

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
  // extractApiKey now checks headers AND ?key= query param
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
  // OAuth discovery endpoints (no auth required)
  if (path === "/.well-known/oauth-protected-resource") {
    return handleProtectedResource(req);
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return handleAuthorizationServer(req);
  }

  // OAuth flow endpoints (no auth — these ARE the auth)
  if (path === "/oauth/register" || path === "/oauth/authorize" || path === "/oauth/token") {
    const defaultVault = resolveDefaultVault();
    const vaultConfig = defaultVault ? readVaultConfig(defaultVault) : null;
    if (!defaultVault || !vaultConfig) {
      return Response.json(
        { error: "server_error", error_description: "Default vault not configured" },
        { status: 500 },
      );
    }
    const store = getVaultStore(defaultVault);

    if (path === "/oauth/register") {
      return handleRegister(req, store.db);
    }
    if (path === "/oauth/authorize") {
      const gc = readGlobalConfig();
      const ownerPasswordHash = gc.owner_password_hash ?? null;
      const totpSecret = gc.totp_secret ?? null;
      const totpEnrolled = typeof totpSecret === "string" && totpSecret.length > 0;
      if (req.method === "GET") {
        return handleAuthorizeGet(req, store.db, vaultConfig.name, ownerPasswordHash, totpEnrolled);
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
    if (path === "/oauth/token") {
      // PR #111: handleToken echoes the vault name back to the client so it
      // knows which vault it just connected to.
      return handleToken(req, store.db, defaultVault);
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
    const defaultVault = resolveDefaultVault();
    const vaultConfig = defaultVault ? readVaultConfig(defaultVault) : null;
    if (!defaultVault || !vaultConfig) {
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

  // Public vault names — no auth, no metadata. Lets unauthenticated clients
  // (e.g. the Daily vault-picker dropdown before OAuth) know which vault to
  // target. Only vault names are exposed; descriptions, counts, timestamps,
  // and API keys are never returned from this endpoint.
  //
  // Operators who want to hide vault existence from anonymous callers can set
  // `discovery: disabled` in ~/.parachute/config.yaml — the endpoint then
  // returns 404 as if it didn't exist.
  if (path === "/vaults/list" && req.method === "GET") {
    const globalConfig = readGlobalConfig();
    if (globalConfig.discovery === "disabled") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ vaults: listVaults() });
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
    const defaultVault = resolveDefaultVault();
    const vaultConfig = defaultVault ? readVaultConfig(defaultVault) : null;
    if (!defaultVault || !vaultConfig) {
      return Response.json({ error: "Default vault not found" }, { status: 404 });
    }
    const store = getVaultStore(defaultVault);
    const auth = authenticateVaultRequest(req, vaultConfig, store.db);
    if ("error" in auth) return auth.error;
    if (!isMethodAllowed(req.method, auth.permission)) {
      return Response.json(
        { error: "Forbidden", message: "Insufficient permissions" },
        { status: 403 },
      );
    }
    const apiPath = path.slice(4); // strip "/api"
    if (apiPath.startsWith("/notes")) return handleNotes(req, store, apiPath.slice(6));
    if (apiPath.startsWith("/tags")) return handleTags(req, store, apiPath.slice(5));
    if (apiPath === "/find-path") return handleFindPath(req, store);
    if (apiPath === "/vault") {
      return handleVault(req, store, vaultConfig, (desc) => {
        vaultConfig.description = desc;
        writeVaultConfig(vaultConfig);
      });
    }
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
    return Response.json({ error: "Vault not found", vault: vaultName }, { status: 404 });
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
    // PR #111: handleToken now requires the vault name so it can (a) pin the
    // OAuth code to the issuing vault (prevents cross-vault code replay) and
    // (b) echo `vault: <name>` back to the client in the token response.
    if (subpath === "/oauth/token") return handleToken(req, store.db, vaultName);
  }

  // Vault-scoped discovery endpoints. PR #111: the protected-resource
  // advertises a vault-scoped authorization server (`${base}/vaults/${name}`),
  // and the vault-scoped authorization-server metadata returns endpoints
  // scoped to `/vaults/${name}/oauth/*` so tokens mint against this vault's
  // DB. Keeps the RFC 9728 → RFC 8414 chain coherent end-to-end.
  if (subpath === "/.well-known/oauth-protected-resource") {
    return handleProtectedResource(
      req,
      `/vaults/${vaultName}/mcp`,
      `/vaults/${vaultName}`,
    );
  }
  if (subpath === "/.well-known/oauth-authorization-server") {
    return handleAuthorizationServer(req, vaultName);
  }

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
    const stats = await store.getVaultStats();
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

  if (apiPath.startsWith("/notes")) return handleNotes(req, store, apiPath.slice(6));
  if (apiPath.startsWith("/tags")) return handleTags(req, store, apiPath.slice(5));
  if (apiPath === "/find-path") return handleFindPath(req, store);
  if (apiPath === "/vault") {
    return handleVault(req, store, vaultConfig, (desc) => {
      vaultConfig.description = desc;
      writeVaultConfig(vaultConfig);
    });
  }
  if (apiPath === "/unresolved-wikilinks") return handleUnresolvedWikilinks(req, store);
  if (apiPath.startsWith("/storage")) return handleStorage(req, apiPath.slice(8), vaultName);
  if (apiPath === "/health") return Response.json({ status: "ok", vault: vaultName });

  return Response.json({ error: "Not found" }, { status: 404 });
}
