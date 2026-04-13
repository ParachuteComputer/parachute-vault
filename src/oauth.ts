/**
 * OAuth 2.1 provider for Parachute Vault.
 *
 * Implements the subset of OAuth 2.1 needed for MCP clients (Claude Web,
 * Claude Desktop, etc.) to connect via the standard browser-based flow:
 *
 *   1. Dynamic Client Registration (RFC 7591)  — POST /oauth/register
 *   2. Authorization endpoint (PKCE required)   — GET/POST /oauth/authorize
 *   3. Token endpoint (code exchange)           — POST /oauth/token
 *   4. Discovery endpoints                      — GET /.well-known/*
 *
 * The flow produces a standard `pvt_` token stored in the vault's tokens table.
 * After the OAuth handshake, all requests use the same Bearer token auth path.
 */

import crypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { generateToken, createToken } from "./token-store.ts";
import type { TokenPermission } from "./token-store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBaseUrl(req: Request): string {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto");
  if (forwardedHost) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }
  // Fall back to the request URL's origin
  const url = new URL(req.url);
  return url.origin;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Discovery endpoints
// ---------------------------------------------------------------------------

export function handleProtectedResource(req: Request): Response {
  const base = getBaseUrl(req);
  return Response.json({
    resource: base,
    authorization_servers: [base],
    scopes_supported: ["full", "read"],
    bearer_methods_supported: ["header"],
  });
}

export function handleAuthorizationServer(req: Request): Response {
  const base = getBaseUrl(req);
  return Response.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["full", "read"],
  });
}

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

export function handleAuthorizeGet(req: Request, db: Database, vaultName: string): Response {
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

  // Normalize scope
  const normalizedScope: TokenPermission = scope === "read" ? "read" : "full";

  // Render consent page
  const html = renderConsentPage({
    vaultName,
    clientName: client.client_name,
    scope: normalizedScope,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    state,
  });

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function handleAuthorizePost(req: Request, db: Database): Promise<Response> {
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
  const scope = form.get("scope") as string || "full";
  const state = form.get("state") as string || "";

  if (!clientId || !redirectUri || !codeChallenge) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const redirect = new URL(redirectUri);
  if (state) redirect.searchParams.set("state", state);

  // User denied
  if (action === "deny") {
    redirect.searchParams.set("error", "access_denied");
    return Response.redirect(redirect.toString(), 302);
  }

  // Validate client
  const client = db.prepare("SELECT redirect_uris FROM oauth_clients WHERE client_id = ?")
    .get(clientId) as { redirect_uris: string } | null;

  if (!client) {
    redirect.searchParams.set("error", "invalid_request");
    return Response.redirect(redirect.toString(), 302);
  }

  const registeredUris: string[] = JSON.parse(client.redirect_uris);
  if (!registeredUris.includes(redirectUri)) {
    return Response.json({ error: "invalid_request", error_description: "redirect_uri mismatch" }, { status: 400 });
  }

  // Generate auth code
  const code = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

  db.prepare(`
    INSERT INTO oauth_codes (code, client_id, code_challenge, code_challenge_method, scope, redirect_uri, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, clientId, codeChallenge, codeChallengeMethod, scope, redirectUri, expiresAt, new Date().toISOString());

  redirect.searchParams.set("code", code);
  return Response.redirect(redirect.toString(), 302);
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export async function handleToken(req: Request, db: Database): Promise<Response> {
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

  if (!code || !codeVerifier || !clientId) {
    return Response.json({ error: "invalid_request", error_description: "Missing required parameters" }, { status: 400 });
  }

  // Look up the auth code
  const authCode = db.prepare(`
    SELECT code, client_id, code_challenge, code_challenge_method, scope, redirect_uri, expires_at, used
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

  // Validate redirect_uri matches (if provided)
  if (redirectUri && authCode.redirect_uri !== redirectUri) {
    return Response.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, { status: 400 });
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

  // Create a real pvt_ token
  const permission: TokenPermission = authCode.scope === "read" ? "read" : "full";
  const { fullToken } = generateToken();
  createToken(db, fullToken, {
    label: `oauth:${clientId.slice(0, 8)}`,
    permission,
  });

  return Response.json({
    access_token: fullToken,
    token_type: "bearer",
    scope: permission,
  });
}

// ---------------------------------------------------------------------------
// Consent page HTML
// ---------------------------------------------------------------------------

interface ConsentParams {
  vaultName: string;
  clientName: string;
  scope: TokenPermission;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
}

function renderConsentPage(p: ConsentParams): string {
  const scopeLabel = p.scope === "read" ? "Read-only access" : "Full access";
  const scopeDesc = p.scope === "read"
    ? "Query notes, list tags, and view vault info"
    : "Read, create, update, and delete notes, tags, and links";

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
  .scope {
    background: #f5f5f5;
    border-radius: 4px;
    padding: 0.75rem 1rem;
    margin: 1rem 0;
  }
  .scope-label { font-weight: 600; }
  .scope-desc { font-size: 0.9rem; color: #666; }
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
    .scope { background: #2a2a2a; }
    .scope-desc { color: #999; }
    .client { color: #66b3ff; }
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
  <div class="scope">
    <div class="scope-label">${escapeHtml(scopeLabel)}</div>
    <div class="scope-desc">${escapeHtml(scopeDesc)}</div>
  </div>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(p.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(p.redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(p.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(p.codeChallengeMethod)}">
    <input type="hidden" name="scope" value="${escapeHtml(p.scope)}">
    <input type="hidden" name="state" value="${escapeHtml(p.state)}">
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
