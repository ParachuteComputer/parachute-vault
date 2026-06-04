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
 *   /vault/<name>/.well-known/oauth-*  — discovery forwarder; metadata names
 *                                        the hub as the authorization server
 *                                        (vault is resource-server only)
 *   /vault/<name>/mcp[/*]              — MCP endpoint (Bearer auth)
 *   /vault/<name>/view/<idOrPath>      — auth-aware HTML view
 *   /vault/<name>/public/<noteId>      — legacy alias → /view redirect
 *   /vault/<name>                      — vault metadata + stats (auth)
 *   /vault/<name>/api/...              — REST surface (auth)
 *
 * There is deliberately no compat for the old `/api/*`, `/mcp`, `/oauth/*`,
 * `/view/*`, or `/vaults/<name>/*` prefixes. Clients must re-authenticate
 * after the upgrade and point at the new URLs.
 *
 * **No standalone OAuth issuer.** vault does not mint OAuth tokens or
 * render a consent UI. Hub is the issuer; vault validates hub-signed
 * JWTs (see `auth.ts` + `hub-jwt.ts`). The discovery endpoints above are
 * forwarders that point clients at the hub. The standalone surface that
 * lived in `src/oauth.ts` was retired in vault#366 (workstream E of the
 * UX audit, 2026-05-25).
 */

import pkg from "../package.json" with { type: "json" };
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
  extractApiKey,
} from "./auth.ts";
import { hasScopeForVault, SCOPE_ADMIN, SCOPE_READ, scopeForMethod, verbForMethod } from "./scopes.ts";
import { getVaultStore } from "./vault-store.ts";
import { handleScopedMcp } from "./mcp-http.ts";
import { defaultAdminSpaDistDir, isAdminSpaPath, serveAdminSpa } from "./admin-spa.ts";
import {
  handleNotes,
  handleTags,
  handleFindPath,
  handleVault,
  handleUnresolvedWikilinks,
  handleStorage,
  handleViewNote,
  type TagScopeCtx,
} from "./routes.ts";
import { expandTokenTagScope } from "./tag-scope.ts";
import {
  handleProtectedResource,
  handleAuthorizationServer,
  getBaseUrl,
} from "./oauth-discovery.ts";
import { handleConfigSchema, handleConfig } from "./module-config.ts";
import { buildAuthStatus } from "./auth-status.ts";
import {
  handleAuthDelete,
  handleAuthGet,
  handleAuthGithubCreateRepo,
  handleAuthGithubDeviceCode,
  handleAuthGithubPoll,
  handleAuthGithubRepos,
  handleAuthGithubSelectRepo,
  handleAuthPat,
  handleMirrorGet,
  handleMirrorImport,
  handleMirrorPushNow,
  handleMirrorPut,
  handleMirrorRunNow,
} from "./mirror-routes.ts";
import { getMirrorManager } from "./mirror-registry.ts";
import { buildUsageReport } from "./usage.ts";

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
async function isViewAuthenticated(
  req: Request,
  vaultConfig: VaultConfig | null,
): Promise<boolean> {
  if (!vaultConfig) return false;
  const key = extractApiKey(req);
  if (!key) return false;
  const auth = await authenticateVaultRequest(req, vaultConfig);
  return !("error" in auth);
}

/**
 * Public service-info card for the CLI hub page. The CLI fetches this from
 * every service registered in `~/.parachute/well-known/parachute.json` and
 * renders each as a tile — services own their display story, CLI is a dumb
 * aggregator. No auth, no PII, CORS `*` so the hub can call us cross-origin.
 */
function handleParachuteInfo(vaultName: string): Response {
  const body = {
    name: "parachute-vault",
    displayName: "Vault",
    tagline: "Agent-native knowledge graph — notes, tags, links, attachments over REST + MCP",
    version: pkg.version,
    iconUrl: `/vault/${vaultName}/.parachute/icon.svg`,
  };
  // `kind` was previously emitted here (and matched module.json) to let the
  // hub branch its card rendering on api vs ui. Retired per hub#330 — the hub
  // now infers presentation from the response shape itself. Companion to
  // vault#359 (manifest drop); closes part of hub#340.
  return Response.json(body, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

/**
 * Placeholder monogram icon for the hub tile. Kept inline so the endpoint
 * has zero filesystem dependency — the CLI can render a card even on a
 * pristine install where no assets have been written out yet.
 */
const PARACHUTE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#879B7E"/><text x="32" y="43" text-anchor="middle" font-family="system-ui,sans-serif" font-size="32" font-weight="600" fill="#FAFAF7">V</text></svg>`;

function handleParachuteIcon(): Response {
  return new Response(PARACHUTE_ICON_SVG, {
    headers: {
      "Content-Type": "image/svg+xml",
      // Defense-in-depth: the payload is a static inline SVG with no
      // script/foreignObject, but older Edge/IE have been known to sniff
      // image/svg+xml as HTML under certain conditions. nosniff pins the
      // declared type and takes the sniff path off the table entirely.
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export async function route(
  req: Request,
  path: string,
): Promise<Response> {
  // ---------------------------------------------------------------------
  // OAuth discovery — RFC 8414 §3.1 / RFC 9728 §3 path-insertion form.
  //
  // For a resource at `/vault/<name>/mcp`, the spec-mandated metadata URLs
  // are
  //
  //   /.well-known/oauth-authorization-server/vault/<name>[/mcp]
  //   /.well-known/oauth-protected-resource/vault/<name>[/mcp]
  //
  // (path-insertion — `.well-known` goes ABOVE the issuer path), not the
  // path-append shape `/vault/<name>/.well-known/<type>` served further
  // down. Strict clients — Claude Code's MCP SDK, and any RFC 8414-
  // conformant MCP client — only probe the path-insertion form; without
  // these routes they 404 on discovery and can't authenticate.
  //
  // Both shapes return byte-identical JSON via the shared handlers. The
  // path-append branch lives inside the per-vault block alongside the
  // rest of `/vault/<name>/*` routing. PR #124 originally shipped this
  // for the `/vaults/<name>/` URL shape; PR #138 migrated URLs to
  // `/vault/<name>/` and dropped the insertion routes — this restores
  // them for the new URL shape.
  // ---------------------------------------------------------------------
  const protectedResourceInsert = path.match(
    /^\/\.well-known\/oauth-protected-resource\/vault\/([^/]+)(?:\/mcp)?$/,
  );
  if (protectedResourceInsert) {
    const vaultName = protectedResourceInsert[1]!;
    if (!readVaultConfig(vaultName)) {
      return Response.json({ error: "Vault not found", vault: vaultName }, { status: 404 });
    }
    return handleProtectedResource(req, vaultName);
  }
  const authServerInsert = path.match(
    /^\/\.well-known\/oauth-authorization-server\/vault\/([^/]+)(?:\/mcp)?$/,
  );
  if (authServerInsert) {
    const vaultName = authServerInsert[1]!;
    if (!readVaultConfig(vaultName)) {
      return Response.json({ error: "Vault not found", vault: vaultName }, { status: 404 });
    }
    return handleAuthorizationServer(req, vaultName);
  }

  // ---------------------------------------------------------------------
  // Cross-vault / origin-root endpoints
  // ---------------------------------------------------------------------

  if (path === "/health") {
    const auth = await authenticateGlobalRequest(req);
    if ("error" in auth) {
      return Response.json({ status: "ok" });
    }
    return Response.json({ status: "ok", vaults: listVaults() });
  }

  // Public vault-name discovery. Lets unauthenticated clients (e.g. the
  // Daily vault-picker dropdown before OAuth) know which vault to target.
  // Operators who want to hide vault existence can set `discovery: disabled`
  // in ~/.parachute/vault/config.yaml — the endpoint then returns 404.
  if (path === "/vaults/list" && req.method === "GET") {
    const globalConfig = readGlobalConfig();
    if (globalConfig.discovery === "disabled") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ vaults: listVaults() });
  }

  // Public auth-state probe. Tells a first-contact client whether the
  // server has any vaults yet, which bearer formats it accepts, and
  // whether owner-password / TOTP / tokens are configured. Replaces
  // hub's out-of-process filesystem snoop (parachute-hub#86 follow-up).
  // No auth, GET-only, no token counts — `hasTokens` is a yes/no signal
  // only, with `null` for "DB read failed."
  //
  // Gated on `discovery: disabled` like /vaults/list — both leak vault
  // existence (the `vaults` array names them), so an operator who hides
  // one wants both hidden (#191).
  if (path === "/auth/status" && req.method === "GET") {
    if (readGlobalConfig().discovery === "disabled") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json(buildAuthStatus(), {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  // Admin SPA — per-vault at `/vault/<name>/admin/*` (vault#252). Static-
  // file serving only (index.html + Vite asset bundle); no auth at this
  // seam since the bundle reveals nothing privileged. The SPA's data
  // fetches land on existing per-vault routes that enforce
  // `vault:<name>:read` / `:admin`. GET-only — POSTs to `.../admin/*` aren't
  // a thing the SPA bundle exposes; rejecting them here keeps surprises
  // out. Must fire BEFORE the per-vault dispatch below or the auth wall
  // there would short-circuit the static-asset response.
  if (isAdminSpaPath(path)) {
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return serveAdminSpa(defaultAdminSpaDistDir(), path);
  }

  // Authenticated vault metadata list.
  if (path === "/vaults" && req.method === "GET") {
    const auth = await authenticateGlobalRequest(req);
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

  const vaultName = vaultMatch[1]!;
  const subpath = vaultMatch[2] ?? "";

  const vaultConfig = readVaultConfig(vaultName);
  if (!vaultConfig) {
    return Response.json({ error: "Vault not found", vault: vaultName }, { status: 404 });
  }

  // Legacy-style /public/:noteId → /view/:noteId redirect (kept as a
  // convenience for published-note URLs that predate the /view/ path).
  const vaultPublicMatch = subpath.match(/^\/public\/([^/]+)$/);
  if (vaultPublicMatch && req.method === "GET") {
    const dest = new URL(`/vault/${vaultName}/view/${vaultPublicMatch[1]!}`, req.url);
    dest.search = new URL(req.url).search;
    return Response.redirect(dest.toString(), 301);
  }

  // View endpoint — auth-aware HTML renderer. Unauthenticated requests
  // still serve public notes; a valid API key via header or ?key= query
  // parameter unlocks private notes.
  const vaultViewMatch = subpath.match(/^\/view\/(.+)$/);
  if (vaultViewMatch && req.method === "GET") {
    const store = getVaultStore(vaultName);
    const authenticated = await isViewAuthenticated(req, vaultConfig);
    return handleViewNote(store, decodeURIComponent(vaultViewMatch[1]!), {
      authenticated,
      publishedTag: vaultConfig.published_tag,
    });
  }

  // The legacy `/oauth/{register,authorize,token}` flow on vault was retired
  // when the standalone OAuth issuer was removed (vault#366, workstream E of
  // the UX audit). Hub is the issuer now; vault is resource-server only. A
  // request landing here is from a client that hasn't been re-pointed at the
  // hub yet — surface a clear 410 Gone with a discovery pointer so the client
  // (or its operator) knows where the authorization server moved.
  if (subpath === "/oauth/register" || subpath === "/oauth/authorize" || subpath === "/oauth/token") {
    const base = getBaseUrl(req);
    return Response.json(
      {
        error: "oauth_endpoint_removed",
        error_description:
          "Vault no longer hosts an OAuth issuer. The hub is the authorization server. " +
          "Discover its endpoints via the protected-resource metadata.",
        protected_resource_metadata:
          `${base}/vault/${vaultName}/.well-known/oauth-protected-resource`,
      },
      { status: 410 },
    );
  }

  // Parachute service-info + icon (no auth, CORS *). The CLI hub page at
  // the ecosystem root reads `~/.parachute/well-known/parachute.json`,
  // fans out to each service's `/.parachute/info`, and renders a card per
  // response. Keeping display copy here means the hub never needs a vault
  // release to pick up wording changes.
  if (subpath === "/.parachute/info" || subpath === "/.parachute/icon.svg") {
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return subpath === "/.parachute/info"
      ? handleParachuteInfo(vaultName)
      : handleParachuteIcon();
  }

  // Module configuration endpoints (Phase 2 of the module architecture).
  // Schema is always public — hub reads it to render the config form, no
  // secrets involved. Current values require `vault:admin` as of Phase 3.
  if (subpath === "/.parachute/config/schema") {
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return handleConfigSchema();
  }
  if (subpath === "/.parachute/config") {
    if (req.method !== "GET") {
      // PUT lands in a future phase — return 405 so clients that already speak
      // the full contract discover the gap rather than silently succeeding.
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    // Admin-gated: the current config includes things that aren't user data
    // (worker intervals, TTLs, retention policy) but are still configuration
    // an attacker could use to map the deployment. `vault:admin` keeps the
    // hub's loopback workflow intact while locking out read-only tokens.
    const configAuth = await authenticateVaultRequest(req, vaultConfig);
    if ("error" in configAuth) return configAuth.error;
    if (!hasScopeForVault(configAuth.scopes, vaultName, "admin")) {
      return Response.json(
        {
          error: "Forbidden",
          error_type: "insufficient_scope",
          message: `This endpoint requires the '${SCOPE_ADMIN}' scope (or '${SCOPE_ADMIN.replace("vault:", `vault:${vaultName}:`)}').`,
          required_scope: SCOPE_ADMIN,
          granted_scopes: configAuth.scopes,
        },
        { status: 403 },
      );
    }
    const globalConfig = readGlobalConfig();
    return handleConfig(vaultConfig, globalConfig);
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
  const auth = await authenticateVaultRequest(req, vaultConfig);
  const isScopedMcp = subpath === "/mcp" || subpath.startsWith("/mcp/");
  if ("error" in auth) {
    return isScopedMcp ? withMcpChallenge(auth.error, req, vaultName) : auth.error;
  }

  // MCP (per-vault, single-vault session).
  if (isScopedMcp) {
    // Thread the RAW caller bearer (the exact credential the session
    // presented) into the MCP layer so the manage-token tool can forward it
    // to hub's mint-token attenuation proxy (vault#403, MGT). Only the raw
    // validated bearer — never a fabricated one. extractApiKey returns the
    // same value `authenticateVaultRequest` validated above; non-forwardable
    // credentials (env-var secret, legacy pvt_*) are handled by manage-token
    // itself (it only forwards JWT-shaped bearers).
    const callerBearer = extractApiKey(req);
    return handleScopedMcp(req, vaultName, auth, callerBearer);
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

  // /.parachute/usage — per-vault data-footprint report ("how big is this
  // vault"). READ-scoped, deliberately: a vault's own user must be able to
  // see their own vault's size, and the operator (who holds broad/admin)
  // inherits read. This mirrors the bare-root stats precedent above (also
  // read-gated by the method) — same data-disclosure class (counts + sizes,
  // no note content). The expensive part (two dir-walks) is TTL-cached inside
  // usage.ts; `?fresh=1` bypasses the cache. Hub-side aggregation/UI is a
  // separate follow-up; this endpoint is the load-bearing primitive.
  if (subpath === "/.parachute/usage") {
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (!hasScopeForVault(auth.scopes, vaultName, "read")) {
      return Response.json(
        {
          error: "Forbidden",
          error_type: "insufficient_scope",
          message: `This endpoint requires the '${SCOPE_READ}' scope (or '${SCOPE_READ.replace("vault:", `vault:${vaultName}:`)}').`,
          required_scope: SCOPE_READ,
          granted_scopes: auth.scopes,
        },
        { status: 403 },
      );
    }
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    const stats = await store.getVaultStats();
    return Response.json(buildUsageReport(vaultName, stats, { fresh }));
  }

  // The per-vault `/tokens` REST surface (pvt_* mint/list/revoke) was removed
  // at 0.5.0 (vault#282 Stage 2 — vault is a pure hub resource-server). Hub
  // JWTs are minted via hub's registry (`/api/auth/mint-token`); a `/tokens`
  // request now falls through to the catch-all 404 below.

  // /.parachute/mirror — Admin-gated read+write of THIS vault's persistent
  // mirror config + runtime status. Per-vault (vault#400): the manager is
  // resolved by the URL's vault name, so each vault's mirror page reflects
  // its own config + git remote. Lives under `.parachute/` (alongside
  // info/icon/config) rather than `admin/` because `/vault/<name>/admin/*`
  // is reserved for the admin SPA's static-file mount; the API surface goes
  // under `.parachute/` by the module-protocol convention.
  if (subpath === "/.parachute/mirror") {
    if (!hasScopeForVault(auth.scopes, vaultName, "admin")) {
      return Response.json(
        {
          error: "Forbidden",
          error_type: "insufficient_scope",
          message: `This endpoint requires the '${SCOPE_ADMIN}' scope (or '${SCOPE_ADMIN.replace("vault:", `vault:${vaultName}:`)}').`,
          required_scope: SCOPE_ADMIN,
          granted_scopes: auth.scopes,
        },
        { status: 403 },
      );
    }
    // vault#400: resolve the manager for THIS vault (from the URL). The
    // registry lazily builds one (via the boot-installed factory) for any
    // existing vault — including a non-default vault or one configured at
    // runtime — so the handler operates on the right vault's config + status
    // + git remote, never the default vault's.
    const manager = getMirrorManager(vaultName);
    if (!manager) {
      // Null only when boot hasn't installed the factory yet (startup race
      // or boot failure). Surface a clear 503 rather than a JSON null so the
      // operator + the hub SPA know it's a service-state issue, not a
      // misconfig on their end.
      return Response.json(
        {
          error: "Mirror manager not initialized",
          message:
            "The vault server hasn't wired the mirror manager registry yet (boot hasn't finished, or it failed). Check logs for [mirror] entries.",
        },
        { status: 503 },
      );
    }
    if (req.method === "GET") return handleMirrorGet(manager);
    if (req.method === "PUT") return handleMirrorPut(req, manager);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // /.parachute/mirror/run-now — fire a one-shot export+commit+push pass.
  // Same admin gate as the GET/PUT above; same manager presence check.
  // POST-only — a GET would imply "read the result of running" which
  // isn't the verb (the rolling status is already available on the
  // parent GET endpoint).
  if (subpath === "/.parachute/mirror/run-now") {
    if (!hasScopeForVault(auth.scopes, vaultName, "admin")) {
      return Response.json(
        {
          error: "Forbidden",
          error_type: "insufficient_scope",
          message: `This endpoint requires the '${SCOPE_ADMIN}' scope (or '${SCOPE_ADMIN.replace("vault:", `vault:${vaultName}:`)}').`,
          required_scope: SCOPE_ADMIN,
          granted_scopes: auth.scopes,
        },
        { status: 403 },
      );
    }
    const manager = getMirrorManager(vaultName);
    if (!manager) {
      return Response.json(
        {
          error: "Mirror manager not initialized",
          message:
            "The vault server hasn't wired the mirror manager registry yet (boot hasn't finished, or it failed). Check logs for [mirror] entries.",
        },
        { status: 503 },
      );
    }
    if (req.method === "POST") return handleMirrorRunNow(manager);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // /.parachute/mirror/push-now — fire `git push` against committed state.
  // Cut 6 of vault#392. Same admin gate + manager check as run-now;
  // POST-only. Distinguished from /run-now in that this skips export +
  // commit, only pushes — for "did my credentials actually work?" flow.
  if (subpath === "/.parachute/mirror/push-now") {
    if (!hasScopeForVault(auth.scopes, vaultName, "admin")) {
      return Response.json(
        {
          error: "Forbidden",
          error_type: "insufficient_scope",
          message: `This endpoint requires the '${SCOPE_ADMIN}' scope (or '${SCOPE_ADMIN.replace("vault:", `vault:${vaultName}:`)}').`,
          required_scope: SCOPE_ADMIN,
          granted_scopes: auth.scopes,
        },
        { status: 403 },
      );
    }
    const manager = getMirrorManager(vaultName);
    if (!manager) {
      return Response.json(
        {
          error: "Mirror manager not initialized",
          message:
            "The vault server hasn't wired the mirror manager registry yet (boot hasn't finished, or it failed). Check logs for [mirror] entries.",
        },
        { status: 503 },
      );
    }
    if (req.method === "POST") return handleMirrorPushNow(manager);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // /.parachute/mirror/import — clone a vault export from git + import.
  // Admin-gated. POST-only. Synchronous (imports finish in <30s for
  // typical vaults). See mirror-routes.ts:handleMirrorImport for the
  // request/response shape + error map. Symmetric counterpart to the
  // export-to-git flow vault#382 + vault#384 shipped.
  if (subpath === "/.parachute/mirror/import") {
    if (!hasScopeForVault(auth.scopes, vaultName, "admin")) {
      return Response.json(
        {
          error: "Forbidden",
          error_type: "insufficient_scope",
          message: `This endpoint requires the '${SCOPE_ADMIN}' scope (or '${SCOPE_ADMIN.replace("vault:", `vault:${vaultName}:`)}').`,
          required_scope: SCOPE_ADMIN,
          granted_scopes: auth.scopes,
        },
        { status: 403 },
      );
    }
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return handleMirrorImport(req, vaultName);
  }

  // /.parachute/mirror/auth/* — UI-configurable git push credentials.
  // GitHub OAuth Device Flow + PAT fallback. All admin-gated; the
  // routes themselves don't carry secrets in their responses
  // (mirror-routes.ts redacts via sanitizeCredentials).
  if (subpath.startsWith("/.parachute/mirror/auth")) {
    if (!hasScopeForVault(auth.scopes, vaultName, "admin")) {
      return Response.json(
        {
          error: "Forbidden",
          error_type: "insufficient_scope",
          message: `This endpoint requires the '${SCOPE_ADMIN}' scope (or '${SCOPE_ADMIN.replace("vault:", `vault:${vaultName}:`)}').`,
          required_scope: SCOPE_ADMIN,
          granted_scopes: auth.scopes,
        },
        { status: 403 },
      );
    }
    const manager = getMirrorManager(vaultName);
    if (!manager) {
      return Response.json(
        {
          error: "Mirror manager not initialized",
          message:
            "The vault server hasn't wired the mirror manager registry yet (boot hasn't finished, or it failed). Check logs for [mirror] entries.",
        },
        { status: 503 },
      );
    }

    if (subpath === "/.parachute/mirror/auth") {
      if (req.method === "GET") return handleAuthGet(manager);
      if (req.method === "DELETE") return handleAuthDelete(manager);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (subpath === "/.parachute/mirror/auth/github/device-code") {
      if (req.method === "POST") return handleAuthGithubDeviceCode();
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (subpath === "/.parachute/mirror/auth/github/poll") {
      if (req.method === "POST") return handleAuthGithubPoll(req, manager);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (subpath === "/.parachute/mirror/auth/github/repos") {
      if (req.method === "GET") return handleAuthGithubRepos(manager);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (subpath === "/.parachute/mirror/auth/github/create-repo") {
      if (req.method === "POST") return handleAuthGithubCreateRepo(req, manager);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (subpath === "/.parachute/mirror/auth/github/select-repo") {
      if (req.method === "POST") return handleAuthGithubSelectRepo(req, manager);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (subpath === "/.parachute/mirror/auth/pat") {
      if (req.method === "POST") return handleAuthPat(req, manager);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const apiMatch = subpath.match(/^\/api(\/.*)?$/);
  if (!apiMatch) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // REST API — scope gate. GET/HEAD/OPTIONS → vault:read,
  // POST/PATCH/PUT/DELETE → vault:write. Inheritance (admin ⊇ write ⊇ read)
  // and the broad-vs-narrowed shape (`vault:<verb>` from pvt_*, or
  // `vault:<vaultName>:<verb>` from hub JWTs) are handled by
  // `hasScopeForVault`.
  const requiredVerb = verbForMethod(req.method);
  if (!hasScopeForVault(auth.scopes, vaultName, requiredVerb)) {
    const requiredApiScope = scopeForMethod(req.method);
    return Response.json(
      {
        error: "Forbidden",
        error_type: "insufficient_scope",
        message: `This endpoint requires the '${requiredApiScope}' scope (or '${requiredApiScope.replace("vault:", `vault:${vaultName}:`)}').`,
        required_scope: requiredApiScope,
        granted_scopes: auth.scopes,
      },
      { status: 403 },
    );
  }

  const apiPath = apiMatch[1] ?? "";

  // Tag-scoped tokens (patterns/tag-scoped-tokens.md): expand the token's
  // root-tag allowlist into `{root} ∪ descendants(root)` once per request,
  // so handlers can intersect against the note's tag set without re-walking
  // the `_tags/<name>` hierarchy on every check. `tagScope.allowed` is null
  // for unscoped tokens — the no-op fast path leaves the pre-tag-scope
  // behavior identical.
  const tagScope: TagScopeCtx = {
    allowed: await expandTokenTagScope(store, auth.scoped_tags),
    raw: auth.scoped_tags,
  };

  if (apiPath.startsWith("/notes")) return handleNotes(req, store, apiPath.slice(6), vaultName, tagScope);
  if (apiPath.startsWith("/tags")) return handleTags(req, store, apiPath.slice(5), tagScope);
  if (apiPath === "/find-path") return handleFindPath(req, store, tagScope);
  if (apiPath === "/vault") {
    return handleVault(req, store, vaultConfig, () => {
      writeVaultConfig(vaultConfig);
    });
  }
  if (apiPath === "/unresolved-wikilinks") return handleUnresolvedWikilinks(req, store);
  if (apiPath.startsWith("/storage")) return handleStorage(req, apiPath.slice(8), vaultName, store, tagScope);
  if (apiPath === "/health") return Response.json({ status: "ok", vault: vaultName });

  return Response.json({ error: "Not found" }, { status: 404 });
}
