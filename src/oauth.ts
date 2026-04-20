/**
 * OAuth 2.1 provider for Parachute Vault.
 *
 * Implements the subset of OAuth 2.1 needed for MCP clients (Claude Web,
 * Claude Desktop, etc.) to connect via the standard browser-based flow:
 *
 *   1. Dynamic Client Registration (RFC 7591)  — POST /vault/<name>/oauth/register
 *   2. Authorization endpoint (PKCE required)   — GET/POST /vault/<name>/oauth/authorize
 *   3. Token endpoint (code exchange)           — POST /vault/<name>/oauth/token
 *   4. Discovery endpoints                      — GET /vault/<name>/.well-known/*
 *
 * The flow produces a standard `pvt_` token stored in the vault's tokens table.
 * After the OAuth handshake, all requests use the same Bearer token auth path.
 */

import crypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { generateToken, createToken, resolveToken } from "./token-store.ts";
import type { TokenPermission } from "./token-store.ts";
import { verifyOwnerPassword, authorizeRateLimit, type RateLimiter } from "./owner-auth.ts";
import { verifyTotpCode, verifyAndConsumeBackupCode } from "./two-factor.ts";
import { readManifest, ServicesManifestError } from "./services-manifest.ts";
import { legacyPermissionToScopes, SCOPE_READ, serializeScopes } from "./scopes.ts";

/** Options for handleAuthorizePost. */
export interface AuthorizePostOptions {
  vaultName?: string;
  /** Client IP address (from Bun server.requestIP). If provided, rate limiting is applied. */
  clientIp?: string;
  /**
   * Bcrypt hash of the owner password. When set, the consent form requires a
   * `password` field. When null/undefined, falls back to legacy `owner_token`
   * auth (vault token in the consent form).
   */
  ownerPasswordHash?: string | null;
  /**
   * Base32-encoded TOTP secret. When set, consent additionally requires a
   * `totp_code` (6-digit) or `backup_code` form field.
   */
  totpSecret?: string | null;
  /** Override for testing; defaults to the module singleton. */
  rateLimiter?: RateLimiter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Public-facing base URL of the server. Honors `x-forwarded-*` headers so a
 * Cloudflare Tunnel / Tailscale Funnel / reverse-proxied deployment advertises
 * the right external origin in discovery documents (RFC 8414, RFC 9728).
 *
 * Exported so the router can build `WWW-Authenticate` challenge headers that
 * point at the same origin as the `/.well-known/*` metadata documents.
 */
export function getBaseUrl(req: Request): string {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto");
  if (forwardedHost) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }
  // Fall back to the request URL's origin
  const url = new URL(req.url);
  return url.origin;
}

/**
 * Public origin the client reached vault through. When `PARACHUTE_HUB_ORIGIN`
 * is set AND matches the incoming request's base URL, returns the hub; else
 * returns the request base. This is the RFC 8414 compliance hinge: discovery
 * metadata's `issuer`, token `iss` claims, and the service catalog all stem
 * from this, so the issuer view is always self-consistent with the origin the
 * client is actually talking to.
 */
function resolvePublicOrigin(req: Request): string {
  const hub = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  const base = getBaseUrl(req);
  return hub && base === hub ? hub : base;
}

/**
 * OAuth endpoint coordinates. Hub-rooted when the request came in through the
 * hub origin (`PARACHUTE_HUB_ORIGIN` set AND matches the incoming base URL),
 * vault-path-rooted otherwise. The same vault exposes both views concurrently:
 * a loopback client gets `issuer = http://127.0.0.1:<port>/vault/<name>`; a
 * client reaching vault via the hub reverse proxy gets `issuer = <hub>`.
 *
 * This is how vault stays RFC 8414 compliant while a single process serves
 * both origins — discovery always returns the issuer matching the client's
 * origin.
 */
export function resolveOAuthCoordinates(
  req: Request,
  vaultName: string,
): {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
} {
  const origin = resolvePublicOrigin(req);
  const hub = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (hub && origin === hub) {
    return {
      issuer: hub,
      authorizationEndpoint: `${hub}/oauth/authorize`,
      tokenEndpoint: `${hub}/oauth/token`,
      registrationEndpoint: `${hub}/oauth/register`,
    };
  }
  const prefix = `/vault/${vaultName}`;
  return {
    issuer: `${origin}${prefix}`,
    authorizationEndpoint: `${origin}${prefix}/oauth/authorize`,
    tokenEndpoint: `${origin}${prefix}/oauth/token`,
    registrationEndpoint: `${origin}${prefix}/oauth/register`,
  };
}

/**
 * Ecosystem service catalog for the token response (Phase 1 of the
 * hub-as-OAuth-issuer design). Reads `~/.parachute/services.json` — the same
 * manifest the CLI maintains — and rewrites each entry's canonical path into
 * an absolute URL rooted at the origin the client reached vault through. A
 * client that came in via the hub gets hub-rooted URLs; a loopback client
 * gets loopback URLs. Same vault, same manifest, origin-consistent.
 *
 * Failure to read the manifest is non-fatal: we log and return an empty
 * catalog rather than refusing to issue the token. The token response shape
 * is additive — clients that don't expect `services` ignore it.
 */
export function buildServiceCatalog(
  req: Request,
): Record<string, { url: string; version: string }> {
  let entries: ReturnType<typeof readManifest>["services"];
  try {
    entries = readManifest().services;
  } catch (err) {
    if (err instanceof ServicesManifestError) {
      console.warn(`[parachute-vault] services.json unreadable: ${err.message}`);
      return {};
    }
    throw err;
  }
  const origin = resolvePublicOrigin(req);
  const catalog: Record<string, { url: string; version: string }> = {};
  for (const entry of entries) {
    const path = entry.paths[0] ?? "/";
    catalog[entry.name] = {
      url: `${origin}${path}`,
      version: entry.version,
    };
  }
  return catalog;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Discovery endpoints
// ---------------------------------------------------------------------------

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * @param vaultName — the vault whose MCP endpoint is the protected resource.
 *                    The metadata advertises `resource: {base}/vault/{name}/mcp`
 *                    and the vault's authorization server at
 *                    `{base}/vault/{name}`. Clients discover the AS metadata
 *                    at `{base}/vault/{name}/.well-known/oauth-authorization-server`.
 */
export function handleProtectedResource(req: Request, vaultName: string): Response {
  const { issuer } = resolveOAuthCoordinates(req, vaultName);
  const base = getBaseUrl(req);
  const prefix = `/vault/${vaultName}`;
  return Response.json({
    resource: `${base}${prefix}/mcp`,
    // `authorization_servers` points clients at the AS metadata doc. When the
    // hub is the issuer (Phase 0), the AS metadata still lives on the vault
    // itself — it's the document that tells clients where the hub endpoints
    // are. So we use the issuer as the AS locator when set, otherwise the
    // vault origin.
    authorization_servers: [issuer],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
  });
}

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414). Endpoint URLs and
 * `issuer` honor `PARACHUTE_HUB_ORIGIN` when set — see
 * `resolveOAuthCoordinates` for the hub-vs-standalone contract.
 */
export function handleAuthorizationServer(req: Request, vaultName: string): Response {
  const coord = resolveOAuthCoordinates(req, vaultName);
  return Response.json({
    issuer: coord.issuer,
    authorization_endpoint: coord.authorizationEndpoint,
    token_endpoint: coord.tokenEndpoint,
    registration_endpoint: coord.registrationEndpoint,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPES_SUPPORTED,
  });
}

/**
 * Scopes published in OAuth discovery. Phase 2 enforces these at request time
 * (`vault:admin` ⊇ `vault:write` ⊇ `vault:read`). `vault:<name>:*` refinements
 * are documented as future shape; the scope parser accepts them as synonyms
 * for `vault:*` today.
 *
 * Legacy `full`/`read` remain in the list for back-compat with 0.2.x clients
 * that hardcoded those names — they're translated into `vault:*` scopes on the
 * way in and out.
 */
const SCOPES_SUPPORTED = ["vault:read", "vault:write", "vault:admin", "full", "read"];

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

export async function handleRegister(req: Request, db: Database): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_request", error_description: "Invalid JSON body" }, { status: 400 });
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return Response.json(
      { error: "invalid_client_metadata", error_description: "redirect_uris is required" },
      { status: 400 },
    );
  }

  const clientId = crypto.randomUUID();
  const clientName = body.client_name || "Unknown Client";
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
    VALUES (?, ?, ?, ?)
  `).run(clientId, clientName, JSON.stringify(redirectUris), now);

  return Response.json({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Authorization endpoint
// ---------------------------------------------------------------------------

export function handleAuthorizeGet(
  req: Request,
  db: Database,
  vaultName: string,
  ownerPasswordHash?: string | null,
  totpEnrolled = false,
): Response {
  const url = new URL(req.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "S256";
  const responseType = url.searchParams.get("response_type");
  const scope = url.searchParams.get("scope") || "full";
  const state = url.searchParams.get("state") || "";

  // Validate required params
  if (!clientId || !redirectUri || !codeChallenge || responseType !== "code") {
    return new Response(renderErrorPage("Missing or invalid parameters. Required: client_id, redirect_uri, code_challenge, response_type=code"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (codeChallengeMethod !== "S256") {
    return new Response(renderErrorPage("Only S256 code challenge method is supported."), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Validate client
  const client = db.prepare("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?")
    .get(clientId) as { client_id: string; client_name: string; redirect_uris: string } | null;

  if (!client) {
    return new Response(renderErrorPage("Unknown client."), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Validate redirect_uri matches registration
  const registeredUris: string[] = JSON.parse(client.redirect_uris);
  if (!registeredUris.includes(redirectUri)) {
    return new Response(renderErrorPage("Redirect URI does not match registered client."), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Normalize requested scope. The user can change it via the radio buttons.
  const requestedScope: TokenPermission = scope === "read" ? "read" : "full";

  // Render consent page
  const html = renderConsentPage({
    vaultName,
    clientName: client.client_name,
    requestedScope,
    selectedScope: requestedScope,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    state,
    passwordMode: typeof ownerPasswordHash === "string" && ownerPasswordHash.length > 0,
    totpEnrolled,
  });

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function handleAuthorizePost(
  req: Request,
  db: Database,
  opts: AuthorizePostOptions = {},
): Promise<Response> {
  const { vaultName, clientIp, ownerPasswordHash, totpSecret, rateLimiter = authorizeRateLimit } = opts;
  const totpEnrolled = typeof totpSecret === "string" && totpSecret.length > 0;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const action = form.get("action") as string;
  const clientId = form.get("client_id") as string;
  const redirectUri = form.get("redirect_uri") as string;
  const codeChallenge = form.get("code_challenge") as string;
  const codeChallengeMethod = form.get("code_challenge_method") as string || "S256";
  // Requested scope (from hidden field, carried from GET) and selected scope
  // (from radio button on the consent page). Default selected to requested.
  const requestedScope = form.get("scope") as string || "full";
  const selectedScopeRaw = form.get("selected_scope") as string | null;
  const selectedScope = selectedScopeRaw === "read" || selectedScopeRaw === "full"
    ? selectedScopeRaw
    : (requestedScope === "read" ? "read" : "full");
  const state = form.get("state") as string || "";

  if (!clientId || !redirectUri || !codeChallenge) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Validate client and redirect_uri BEFORE constructing any redirect.
  // This prevents open-redirect attacks via crafted redirect_uri values.
  const client = db.prepare("SELECT redirect_uris FROM oauth_clients WHERE client_id = ?")
    .get(clientId) as { redirect_uris: string } | null;

  if (!client) {
    return Response.json({ error: "invalid_request", error_description: "Unknown client" }, { status: 400 });
  }

  const registeredUris: string[] = JSON.parse(client.redirect_uris);
  if (!registeredUris.includes(redirectUri)) {
    return Response.json({ error: "invalid_request", error_description: "redirect_uri mismatch" }, { status: 400 });
  }

  // Only S256 is supported
  if (codeChallengeMethod !== "S256") {
    return Response.json({ error: "invalid_request", error_description: "Only S256 code challenge method is supported" }, { status: 400 });
  }

  const redirect = new URL(redirectUri);
  if (state) redirect.searchParams.set("state", state);

  // User denied
  if (action === "deny") {
    redirect.searchParams.set("error", "access_denied");
    return Response.redirect(redirect.toString(), 302);
  }

  // Rate-limit the owner-auth step. Applied before any credential check so
  // brute-force attempts are capped regardless of which path (password or
  // legacy token) is being used.
  if (clientIp) {
    const gate = rateLimiter.check(clientIp);
    if (!gate.allowed) {
      return new Response(renderErrorPage(
        `Too many failed attempts. Try again in ${Math.ceil(gate.retryAfterSec / 60)} minute(s).`,
      ), {
        status: 429,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Retry-After": String(gate.retryAfterSec),
        },
      });
    }
  }

  // Verify owner identity — password if configured, else legacy vault token.
  const passwordMode = typeof ownerPasswordHash === "string" && ownerPasswordHash.length > 0;
  let ownerOk = false;
  let errorMsg = "";

  if (passwordMode) {
    const password = form.get("password") as string;
    if (!password) {
      errorMsg = "Password is required.";
    } else {
      ownerOk = await verifyOwnerPassword(password, ownerPasswordHash!);
      // Keep failure messages uniform across password / TOTP / backup-code so
      // an attacker can't tell which factor was wrong.
      if (!ownerOk) errorMsg = "Invalid credentials.";
    }
  } else {
    const ownerToken = form.get("owner_token") as string;
    if (!ownerToken) {
      errorMsg = "Vault token is required.";
    } else {
      ownerOk = resolveToken(db, ownerToken) !== null;
      if (!ownerOk) errorMsg = "Invalid vault token.";
    }
  }

  if (!ownerOk) {
    if (clientIp) rateLimiter.recordFailure(clientIp);
    return renderConsentWithError(db, vaultName || "vault", {
      clientId, redirectUri, codeChallenge, codeChallengeMethod,
      requestedScope, selectedScope, state, passwordMode, totpEnrolled,
      error: errorMsg,
    });
  }

  // 2FA check — password passed, now verify TOTP or backup code.
  if (totpEnrolled) {
    const totpCode = ((form.get("totp_code") as string | null) ?? "").trim();
    const backupCode = ((form.get("backup_code") as string | null) ?? "").trim();
    let twoFaOk = false;
    let twoFaError = "";
    if (totpCode) {
      twoFaOk = verifyTotpCode(totpSecret!, totpCode);
      if (!twoFaOk) twoFaError = "Invalid credentials.";
    } else if (backupCode) {
      twoFaOk = await verifyAndConsumeBackupCode(backupCode);
      if (!twoFaOk) twoFaError = "Invalid credentials.";
    } else {
      twoFaError = "Enter a 6-digit code from your authenticator app, or a backup code.";
    }
    if (!twoFaOk) {
      if (clientIp) rateLimiter.recordFailure(clientIp);
      return renderConsentWithError(db, vaultName || "vault", {
        clientId, redirectUri, codeChallenge, codeChallengeMethod,
        requestedScope, selectedScope, state, passwordMode, totpEnrolled,
        error: twoFaError,
      });
    }
  }

  if (clientIp) rateLimiter.recordSuccess(clientIp);

  // Generate auth code — persist the user-selected scope (not the requested one)
  const code = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

  // vault_name pins the code to the issuing vault. handleToken rejects
  // any code whose vault_name doesn't match the token-endpoint's vault.
  db.prepare(`
    INSERT INTO oauth_codes (code, client_id, code_challenge, code_challenge_method, scope, redirect_uri, expires_at, created_at, vault_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, clientId, codeChallenge, codeChallengeMethod, selectedScope, redirectUri, expiresAt, new Date().toISOString(), vaultName ?? null);

  redirect.searchParams.set("code", code);
  return Response.redirect(redirect.toString(), 302);
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

/**
 * OAuth 2.1 token endpoint — exchanges an auth code for a vault token.
 *
 * @param vaultName — the name of the vault this token is scoped to. Included
 *                    in the response as `vault: <name>` so the client knows
 *                    which vault was just connected. The token itself lives
 *                    in that vault's tokens table.
 */
export async function handleToken(
  req: Request,
  db: Database,
  vaultName: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let params: URLSearchParams;
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    params = new URLSearchParams(await req.text());
  } else if (contentType.includes("application/json")) {
    try {
      const body = await req.json();
      params = new URLSearchParams(body as Record<string, string>);
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
  } else {
    params = new URLSearchParams(await req.text());
  }

  const grantType = params.get("grant_type");

  if (grantType !== "authorization_code") {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  const code = params.get("code");
  const codeVerifier = params.get("code_verifier");
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");

  if (!code || !codeVerifier || !clientId || !redirectUri) {
    return Response.json({ error: "invalid_request", error_description: "Missing required parameters" }, { status: 400 });
  }

  // Look up the auth code
  const authCode = db.prepare(`
    SELECT code, client_id, code_challenge, code_challenge_method, scope, redirect_uri, expires_at, used, vault_name
    FROM oauth_codes WHERE code = ?
  `).get(code) as {
    code: string;
    client_id: string;
    code_challenge: string;
    code_challenge_method: string;
    scope: string;
    redirect_uri: string;
    expires_at: string;
    used: number;
    vault_name: string | null;
  } | null;

  if (!authCode) {
    return Response.json({ error: "invalid_grant", error_description: "Invalid authorization code" }, { status: 400 });
  }

  // Check single-use
  if (authCode.used) {
    return Response.json({ error: "invalid_grant", error_description: "Authorization code already used" }, { status: 400 });
  }

  // Check expiry
  if (new Date(authCode.expires_at) < new Date()) {
    return Response.json({ error: "invalid_grant", error_description: "Authorization code expired" }, { status: 400 });
  }

  // Validate client_id matches
  if (authCode.client_id !== clientId) {
    return Response.json({ error: "invalid_grant", error_description: "client_id mismatch" }, { status: 400 });
  }

  // Validate redirect_uri matches
  if (authCode.redirect_uri !== redirectUri) {
    return Response.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, { status: 400 });
  }

  // Validate the code was issued for the same vault this token endpoint
  // serves. Without this, a code issued under /vault/A/oauth/authorize
  // could be presented to /vault/B/oauth/token and the token would be
  // minted into B's DB — privilege escalation across vault boundaries.
  if (authCode.vault_name !== vaultName) {
    return Response.json({ error: "invalid_grant", error_description: "vault mismatch" }, { status: 400 });
  }

  // PKCE verification: SHA256(code_verifier) must match stored code_challenge
  const expectedChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  if (expectedChallenge !== authCode.code_challenge) {
    return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400 });
  }

  // Mark code as used
  db.prepare("UPDATE oauth_codes SET used = 1 WHERE code = ?").run(code);

  // Translate the consent-time selected scope into both the legacy permission
  // column and the OAuth-standard scope list we now persist on the token row.
  // The consent page only offers read vs full today; full becomes the
  // admin-inheriting scope set so hub admin operations keep working.
  const permission: TokenPermission = authCode.scope === "read" ? "read" : "full";
  const scopes = legacyPermissionToScopes(permission);
  const scopeString = serializeScopes(scopes);

  const { fullToken } = generateToken();
  createToken(db, fullToken, {
    label: `oauth:${clientId.slice(0, 8)}`,
    permission,
    scopes,
  });

  const { issuer } = resolveOAuthCoordinates(req, vaultName);
  return Response.json({
    access_token: fullToken,
    token_type: "bearer",
    // RFC 6749 §5.1: scope is an OAuth-standard whitespace-separated string.
    scope: scopeString,
    vault: vaultName,
    // Phase 0: identify the issuer so tokens validated by downstream services
    // can pin trust on the hub-origin URL, not vault's internal address.
    iss: issuer,
    // Phase 1: bundle the ecosystem service catalog so Notes/clients learn
    // all sibling service URLs from the token response and don't need to
    // prompt the user for each one. Additive field — older clients ignore.
    services: buildServiceCatalog(req),
  });
}

// ---------------------------------------------------------------------------
// Consent page re-render with error
// ---------------------------------------------------------------------------

function renderConsentWithError(
  db: Database,
  vaultName: string,
  params: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    requestedScope: string;
    selectedScope: string;
    state: string;
    passwordMode: boolean;
    totpEnrolled: boolean;
    error: string;
  },
): Response {
  const client = db.prepare("SELECT client_name FROM oauth_clients WHERE client_id = ?")
    .get(params.clientId) as { client_name: string } | null;
  const clientName = client?.client_name || "Unknown Client";
  const requested: TokenPermission = params.requestedScope === "read" ? "read" : "full";
  const selected: TokenPermission = params.selectedScope === "read" ? "read" : "full";

  const html = renderConsentPage({
    vaultName,
    clientName,
    requestedScope: requested,
    selectedScope: selected,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    state: params.state,
    passwordMode: params.passwordMode,
    totpEnrolled: params.totpEnrolled,
    error: params.error,
  });

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Consent page HTML
// ---------------------------------------------------------------------------

interface ConsentParams {
  vaultName: string;
  clientName: string;
  /** Scope originally requested by the client. */
  requestedScope: TokenPermission;
  /** Scope currently selected in the radio buttons (defaults to requested). */
  selectedScope: TokenPermission;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  /** When true, render a password field; when false, render a vault-token field (legacy). */
  passwordMode: boolean;
  /** When true, additionally render TOTP + backup-code fields. */
  totpEnrolled?: boolean;
  error?: string;
}

function renderConsentPage(p: ConsentParams): string {
  const fullChecked = p.selectedScope === "full" ? " checked" : "";
  const readChecked = p.selectedScope === "read" ? " checked" : "";

  const credentialField = p.passwordMode
    ? `<div class="cred-field">
      <label for="password">Owner password</label>
      <input type="password" id="password" name="password" placeholder="Enter your vault password" required autocomplete="current-password">
    </div>`
    : `<div class="cred-field">
      <label for="owner_token">Vault token</label>
      <input type="password" id="owner_token" name="owner_token" placeholder="pvt_..." required autocomplete="off">
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize — ${escapeHtml(p.vaultName)}</title>
<style>
  body {
    max-width: 28rem;
    margin: 4rem auto;
    padding: 0 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
  }
  .card {
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 2rem;
  }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  .client { color: #0066cc; font-weight: 600; }
  .scope-options {
    background: #f5f5f5;
    border-radius: 4px;
    padding: 0.75rem 1rem;
    margin: 1rem 0;
  }
  .scope-option {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.3rem 0;
    cursor: pointer;
  }
  .scope-option input[type="radio"] {
    margin-top: 0.35rem;
  }
  .scope-option-label { font-weight: 600; }
  .scope-option-desc { font-size: 0.85rem; color: #666; }
  .cred-field {
    margin-top: 1rem;
  }
  .cred-field label {
    display: block;
    font-size: 0.9rem;
    font-weight: 600;
    margin-bottom: 0.3rem;
  }
  .cred-field input {
    width: 100%;
    padding: 0.5rem 0.6rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-size: 0.9rem;
    font-family: monospace;
    box-sizing: border-box;
  }
  .error-msg {
    color: #cc3333;
    font-size: 0.9rem;
    margin-top: 0.75rem;
  }
  .buttons {
    display: flex;
    gap: 0.75rem;
    margin-top: 1.5rem;
  }
  button {
    flex: 1;
    padding: 0.6rem 1rem;
    border-radius: 6px;
    font-size: 0.95rem;
    cursor: pointer;
    border: 1px solid #ccc;
    background: #fff;
  }
  button[value="authorize"] {
    background: #0066cc;
    color: #fff;
    border-color: #0066cc;
  }
  button[value="authorize"]:hover { background: #0055aa; }
  button[value="deny"]:hover { background: #f5f5f5; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e0e0e0; }
    .card { border-color: #333; }
    .scope-options { background: #2a2a2a; }
    .scope-option-desc { color: #999; }
    .client { color: #66b3ff; }
    .cred-field input { background: #2a2a2a; color: #e0e0e0; border-color: #444; }
    .error-msg { color: #ff6666; }
    button { background: #2a2a2a; color: #e0e0e0; border-color: #444; }
    button[value="authorize"] { background: #0066cc; color: #fff; border-color: #0066cc; }
    button[value="deny"]:hover { background: #333; }
  }
</style>
</head>
<body>
<div class="card">
  <h1>Authorize access</h1>
  <p><span class="client">${escapeHtml(p.clientName)}</span> wants to access your <strong>${escapeHtml(p.vaultName)}</strong> vault.</p>
  <form method="POST" action="">
    <input type="hidden" name="client_id" value="${escapeHtml(p.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(p.redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(p.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(p.codeChallengeMethod)}">
    <input type="hidden" name="scope" value="${escapeHtml(p.requestedScope)}">
    <input type="hidden" name="state" value="${escapeHtml(p.state)}">
    <div class="scope-options">
      <label class="scope-option">
        <input type="radio" name="selected_scope" value="full"${fullChecked}>
        <span>
          <span class="scope-option-label">Full access</span><br>
          <span class="scope-option-desc">Read, create, update, and delete notes, tags, and links.</span>
        </span>
      </label>
      <label class="scope-option">
        <input type="radio" name="selected_scope" value="read"${readChecked}>
        <span>
          <span class="scope-option-label">Read-only access</span><br>
          <span class="scope-option-desc">Query notes, list tags, and view vault info.</span>
        </span>
      </label>
    </div>
    ${credentialField}
    ${p.totpEnrolled ? `<div class="cred-field">
      <label for="totp_code">Authenticator code</label>
      <input type="text" id="totp_code" name="totp_code" placeholder="6-digit code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6">
    </div>
    <div class="cred-field">
      <label for="backup_code">Or a backup code</label>
      <input type="text" id="backup_code" name="backup_code" placeholder="single-use backup code" autocomplete="off">
    </div>` : ""}
    ${p.error ? `<div class="error-msg">${escapeHtml(p.error)}</div>` : ""}
    <div class="buttons">
      <button type="submit" name="action" value="deny">Deny</button>
      <button type="submit" name="action" value="authorize">Authorize</button>
    </div>
  </form>
</div>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Error — Parachute Vault</title>
<style>
  body {
    max-width: 28rem;
    margin: 4rem auto;
    padding: 0 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
  }
  .error { color: #cc3333; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e0e0e0; }
    .error { color: #ff6666; }
  }
</style>
</head>
<body>
<h1 class="error">Authorization Error</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>`;
}
