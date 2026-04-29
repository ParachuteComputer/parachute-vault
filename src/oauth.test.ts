/**
 * Tests for the OAuth 2.1 provider.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initSchema } from "../core/src/schema.ts";
import { generateToken, createToken, resolveToken } from "./token-store.ts";
import {
  handleProtectedResource,
  handleAuthorizationServer,
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleToken,
} from "./oauth.ts";
import * as OTPAuth from "otpauth";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

/** Generate a PKCE code_verifier and its S256 code_challenge. */
function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** Create a valid owner token in the DB and return the raw token string. */
function createOwnerToken(): string {
  const { fullToken } = generateToken();
  createToken(db, fullToken, { label: "owner", permission: "full" });
  return fullToken;
}

/** Register a client and return the client_id. */
async function registerClient(name = "Test Client", redirectUris = ["https://example.com/callback"]): Promise<string> {
  const req = makeRequest("https://vault.test/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris }),
  });
  const res = await handleRegister(req, db);
  const body = await res.json();
  return body.client_id;
}

/** Run the full OAuth flow and return the access_token. */
async function fullOAuthFlow(opts?: { scope?: string }): Promise<string> {
  const ownerToken = createOwnerToken();
  const clientId = await registerClient();
  const { codeVerifier, codeChallenge } = generatePkce();
  const redirectUri = "https://example.com/callback";
  const scope = opts?.scope || "full";

  // POST authorize (simulate user clicking Authorize with valid owner token)
  const authReq = makeRequest("https://vault.test/oauth/authorize", {
    method: "POST",
    body: new URLSearchParams({
      action: "authorize",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope,
      state: "test-state",
      owner_token: ownerToken,
    }),
  });
  const authRes = await handleAuthorizePost(authReq, db, { vaultName: "default" });
  expect(authRes.status).toBe(302);
  const location = new URL(authRes.headers.get("location")!);
  const code = location.searchParams.get("code")!;
  expect(code).toBeTruthy();

  // Exchange code for token
  const tokenReq = makeRequest("https://vault.test/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const tokenRes = await handleToken(tokenReq, db, "default");
  const tokenBody = await tokenRes.json();
  return tokenBody.access_token;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("OAuth discovery", () => {
  test("protected resource metadata", async () => {
    const req = makeRequest("https://vault.test/vault/default/.well-known/oauth-protected-resource");
    const res = handleProtectedResource(req, "default");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://vault.test/vault/default/mcp");
    expect(body.authorization_servers).toEqual(["https://vault.test/vault/default"]);
    expect(body.scopes_supported).toContain("full");
    expect(body.scopes_supported).toContain("read");
  });

  test("authorization server metadata", async () => {
    const req = makeRequest("https://vault.test/vault/default/.well-known/oauth-authorization-server");
    const res = handleAuthorizationServer(req, "default");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe("https://vault.test/vault/default");
    expect(body.authorization_endpoint).toBe("https://vault.test/vault/default/oauth/authorize");
    expect(body.token_endpoint).toBe("https://vault.test/vault/default/oauth/token");
    expect(body.registration_endpoint).toBe("https://vault.test/vault/default/oauth/register");
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("resource URL reflects the vault name", async () => {
    const req = makeRequest("https://vault.test/vault/work/.well-known/oauth-protected-resource");
    const res = handleProtectedResource(req, "work");
    const body = await res.json();
    expect(body.resource).toBe("https://vault.test/vault/work/mcp");
  });

  test("uses x-forwarded-proto and x-forwarded-host", async () => {
    const req = makeRequest("http://localhost:1940/vault/default/.well-known/oauth-protected-resource", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "vault.example.com",
      },
    });
    const res = handleProtectedResource(req, "default");
    const body = await res.json();
    expect(body.resource).toBe("https://vault.example.com/vault/default/mcp");
  });
});

// ---------------------------------------------------------------------------
// Client Registration
// ---------------------------------------------------------------------------

describe("OAuth client registration", () => {
  test("registers a client", async () => {
    const req = makeRequest("https://vault.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Web",
        redirect_uris: ["https://claude.ai/callback"],
      }),
    });
    const res = await handleRegister(req, db);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBeTruthy();
    expect(body.client_name).toBe("Claude Web");
    expect(body.redirect_uris).toEqual(["https://claude.ai/callback"]);
  });

  test("rejects missing redirect_uris", async () => {
    const req = makeRequest("https://vault.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Bad Client" }),
    });
    const res = await handleRegister(req, db);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("rejects non-POST", async () => {
    const req = makeRequest("https://vault.test/oauth/register");
    const res = await handleRegister(req, db);
    expect(res.status).toBe(405);
  });

  test("defaults client_name to Unknown Client", async () => {
    const req = makeRequest("https://vault.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://example.com/cb"] }),
    });
    const res = await handleRegister(req, db);
    const body = await res.json();
    expect(body.client_name).toBe("Unknown Client");
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("OAuth authorization", () => {
  test("renders consent page with valid params", async () => {
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();

    const req = makeRequest(
      `https://vault.test/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=https://example.com/callback&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=full&state=abc`,
    );
    const res = handleAuthorizeGet(req, db, "default");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authorize access");
    expect(html).toContain("Test Client");
    expect(html).toContain("Full access");
  });

  test("rejects missing client_id", () => {
    const req = makeRequest("https://vault.test/oauth/authorize?response_type=code&redirect_uri=x&code_challenge=y");
    const res = handleAuthorizeGet(req, db, "default");
    expect(res.status).toBe(400);
  });

  test("rejects unknown client", () => {
    const req = makeRequest(
      "https://vault.test/oauth/authorize?response_type=code&client_id=unknown&redirect_uri=x&code_challenge=y",
    );
    const res = handleAuthorizeGet(req, db, "default");
    expect(res.status).toBe(400);
  });

  test("rejects mismatched redirect_uri", async () => {
    const clientId = await registerClient();
    const req = makeRequest(
      `https://vault.test/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=https://evil.com/callback&code_challenge=abc`,
    );
    const res = handleAuthorizeGet(req, db, "default");
    expect(res.status).toBe(400);
  });

  test("POST authorize (approve) redirects with code", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();

    const req = makeRequest("https://vault.test/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({
        action: "authorize",
        client_id: clientId,
        redirect_uri: "https://example.com/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: "full",
        state: "mystate",
        owner_token: ownerToken,
      }),
    });
    const res = await handleAuthorizePost(req, db);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://example.com");
    expect(location.pathname).toBe("/callback");
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("mystate");
  });

  test("POST authorize (deny) redirects with error", async () => {
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const req = makeRequest("https://vault.test/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({
        action: "deny",
        client_id: clientId,
        redirect_uri: "https://example.com/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: "s",
      }),
    });
    const res = await handleAuthorizePost(req, db);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  test("POST authorize rejects unregistered redirect_uri (prevents open redirect)", async () => {
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const req = makeRequest("https://vault.test/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({
        action: "deny",
        client_id: clientId,
        redirect_uri: "https://evil.com/steal",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }),
    });
    const res = await handleAuthorizePost(req, db);
    // Should NOT redirect — returns 400 instead
    expect(res.status).toBe(400);
  });

  test("POST authorize rejects unknown client_id", async () => {
    const { codeChallenge } = generatePkce();
    const req = makeRequest("https://vault.test/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({
        action: "authorize",
        client_id: "nonexistent",
        redirect_uri: "https://evil.com/steal",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }),
    });
    const res = await handleAuthorizePost(req, db);
    expect(res.status).toBe(400);
  });

  test("POST authorize rejects missing owner token", async () => {
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const req = makeRequest("https://vault.test/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({
        action: "authorize",
        client_id: clientId,
        redirect_uri: "https://example.com/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: "full",
      }),
    });
    const res = await handleAuthorizePost(req, db, { vaultName: "default" });
    // Should re-render consent page with error, not redirect
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Vault token is required");
  });

  test("POST authorize rejects invalid owner token", async () => {
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const req = makeRequest("https://vault.test/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({
        action: "authorize",
        client_id: clientId,
        redirect_uri: "https://example.com/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: "full",
        owner_token: "pvt_invalid_token_value",
      }),
    });
    const res = await handleAuthorizePost(req, db, { vaultName: "default" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid vault token");
  });
});

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

describe("OAuth token exchange", () => {
  test("full flow: register → authorize → token", async () => {
    const token = await fullOAuthFlow();
    expect(token.startsWith("pvt_")).toBe(true);

    // The token should resolve in the vault's token table
    const resolved = resolveToken(db, token);
    expect(resolved).not.toBeNull();
    expect(resolved!.permission).toBe("full");
  });

  test("read scope produces read-only token", async () => {
    const token = await fullOAuthFlow({ scope: "read" });
    const resolved = resolveToken(db, token);
    expect(resolved!.permission).toBe("read");
  });

  test("rejects invalid code", async () => {
    const clientId = await registerClient();
    const req = makeRequest("https://vault.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "bogus",
        code_verifier: "whatever",
        client_id: clientId,
        redirect_uri: "https://example.com/callback",
      }).toString(),
    });
    const res = await handleToken(req, db, "default");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });

  test("rejects wrong PKCE verifier", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    // Get a real code
    const authReq = makeRequest("https://vault.test/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({
        action: "authorize",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: "full",
        owner_token: ownerToken,
      }),
    });
    const authRes = await handleAuthorizePost(authReq, db, { vaultName: "default" });
    const location = new URL(authRes.headers.get("location")!);
    const code = location.searchParams.get("code")!;

    // Try to exchange with wrong verifier
    const tokenReq = makeRequest("https://vault.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "wrong-verifier",
        client_id: clientId,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const res = await handleToken(tokenReq, db, "default");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_description).toContain("PKCE");
  });

  test("rejects already-used code", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    // Get code
    const authReq = makeRequest("https://vault.test/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({
        action: "authorize",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: "full",
        owner_token: ownerToken,
      }),
    });
    const authRes = await handleAuthorizePost(authReq, db, { vaultName: "default" });
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }).toString();

    // First exchange — succeeds
    const res1 = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams,
      }),
      db,
      "default",
    );
    expect(res1.status).toBe(200);

    // Second exchange — fails (code already used)
    const res2 = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams,
      }),
      db,
      "default",
    );
    expect(res2.status).toBe(400);
    const body = await res2.json();
    expect(body.error_description).toContain("already used");
  });

  test("rejects expired code", async () => {
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    // Insert an expired code directly
    const code = crypto.randomBytes(32).toString("base64url");
    db.prepare(`
      INSERT INTO oauth_codes (code, client_id, code_challenge, code_challenge_method, scope, redirect_uri, expires_at, created_at)
      VALUES (?, ?, ?, 'S256', 'full', ?, ?, ?)
    `).run(code, clientId, codeChallenge, redirectUri, "2020-01-01T00:00:00.000Z", new Date().toISOString());

    const res = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_description).toContain("expired");
  });

  test("rejects mismatched client_id", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const otherClientId = await registerClient("Other Client");
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    // Get code for clientId
    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    // Try to exchange with different client_id
    const res = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: otherClientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });

  test("rejects unsupported grant_type", async () => {
    const res = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      }),
      db,
      "default",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unsupported_grant_type");
  });

  test("accepts JSON body", async () => {
    const token = await fullOAuthFlow();
    // fullOAuthFlow uses form-encoded. Let's also test JSON for token endpoint
    expect(token.startsWith("pvt_")).toBe(true);
  });

  test("rejects missing redirect_uri", async () => {
    const clientId = await registerClient();
    const res = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "some-code",
          code_verifier: "some-verifier",
          client_id: clientId,
        }).toString(),
      }),
      db,
      "default",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
  });

  test("rejects non-POST", async () => {
    const res = await handleToken(
      makeRequest("https://vault.test/oauth/token"),
      db,
      "default",
    );
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Password-based owner auth
// ---------------------------------------------------------------------------

describe("OAuth consent — password mode", () => {
  // Use bcrypt cost 4 in tests to keep them fast
  async function hashPassword(pw: string): Promise<string> {
    return await Bun.password.hash(pw, { algorithm: "bcrypt", cost: 4 });
  }

  test("GET renders password field when password is set", async () => {
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const url = new URL("https://vault.test/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://example.com/callback");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "full");
    const res = handleAuthorizeGet(makeRequest(url.toString()), db, "default", "$2a$fake");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="password"');
    expect(html).not.toContain('name="owner_token"');
  });

  test("GET renders owner_token field when no password is set", async () => {
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const url = new URL("https://vault.test/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://example.com/callback");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "full");
    const res = handleAuthorizeGet(makeRequest(url.toString()), db, "default", null);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="owner_token"');
    expect(html).not.toContain('name="password"');
  });

  test("POST accepts correct password and mints a token", async () => {
    const password = "correcthorsebatterystaple";
    const passwordHash = await hashPassword(password);
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          password,
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash, vaultName: "default" },
    );

    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
    expect(code).toBeTruthy();

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    const body = await tokenRes.json();
    expect(body.access_token.startsWith("pvt_")).toBe(true);
  });

  test("POST rejects wrong password with re-rendered consent", async () => {
    const passwordHash = await hashPassword("correcthorsebatterystaple");
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();

    const res = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: "https://example.com/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          password: "wrongpassword",
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid credentials");
    // Should render password field, not owner_token
    expect(html).toContain('name="password"');
  });

  test("POST rejects missing password in password mode", async () => {
    const passwordHash = await hashPassword("correcthorsebatterystaple");
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();

    const res = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: "https://example.com/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Password is required");
  });

  test("owner_token is ignored when password is configured", async () => {
    const passwordHash = await hashPassword("correcthorsebatterystaple");
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();

    // In password mode, providing a valid owner_token is insufficient —
    // only the password is accepted.
    const res = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: "https://example.com/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
          // no password
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Password is required");
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("OAuth consent — rate limiting", () => {
  test("locks out an IP after threshold failures", async () => {
    const { RateLimiter } = await import("./owner-auth.ts");
    const limiter = new RateLimiter(3, 60_000, 60_000); // 3 fails = lock
    const passwordHash = await Bun.password.hash("correcthorsebatterystaple", {
      algorithm: "bcrypt",
      cost: 4,
    });
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const clientIp = "192.0.2.42";

    const makeAttempt = () => handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: "https://example.com/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          password: "wrongwrongwrong",
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash, clientIp, rateLimiter: limiter },
    );

    // First 3 attempts: 200 with "Invalid credentials"
    for (let i = 0; i < 3; i++) {
      const res = await makeAttempt();
      expect(res.status).toBe(200);
    }
    // 4th attempt should be locked out with 429
    const res = await makeAttempt();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  test("successful auth clears the failure counter", async () => {
    const { RateLimiter } = await import("./owner-auth.ts");
    const limiter = new RateLimiter(3, 60_000, 60_000);
    const password = "correcthorsebatterystaple";
    const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 });
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const clientIp = "192.0.2.43";

    const attempt = (pw: string) => handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: "https://example.com/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          password: pw,
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash, clientIp, rateLimiter: limiter },
    );

    await attempt("wrong1");
    await attempt("wrong2");
    const good = await attempt(password);
    expect(good.status).toBe(302);

    // Counter reset — we can still do more wrong attempts without lockout
    const r1 = await attempt("wrong3");
    expect(r1.status).toBe(200);
    const r2 = await attempt("wrong4");
    expect(r2.status).toBe(200);
  });

  test("locks out an IP after threshold 2FA failures (valid password, bad TOTP)", async () => {
    const { RateLimiter } = await import("./owner-auth.ts");
    const limiter = new RateLimiter(3, 60_000, 60_000); // 3 fails = lock
    const password = "correcthorsebatterystaple";
    const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 });
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const clientIp = "192.0.2.44";

    const makeAttempt = () => handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: "https://example.com/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          password,
          totp_code: "000000", // always invalid
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash, totpSecret: secret, clientIp, rateLimiter: limiter },
    );

    // First 3 attempts: 200 with the unified "Invalid credentials" error
    for (let i = 0; i < 3; i++) {
      const res = await makeAttempt();
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Invalid credentials");
    }
    // 4th attempt should be locked out with 429
    const res = await makeAttempt();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Scope selection
// ---------------------------------------------------------------------------

describe("OAuth consent — scope selection", () => {
  test("user can downgrade from full to read via radio", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",           // requested
          selected_scope: "read",  // user chose read-only
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    const body = await tokenRes.json();
    expect(body.scope).toBe("vault:read");
  });

  test("defaults selected_scope to requested scope when not provided", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "read",  // requested only, no radio selection
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    const body = await tokenRes.json();
    expect(body.scope).toBe("vault:read");
  });

  test("consent HTML includes both scope radio buttons", async () => {
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const url = new URL("https://vault.test/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://example.com/callback");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "full");
    const res = handleAuthorizeGet(makeRequest(url.toString()), db, "default");
    const html = await res.text();
    expect(html).toContain('name="selected_scope"');
    expect(html).toContain('value="full"');
    expect(html).toContain('value="read"');
    // The requested scope should be pre-checked
    expect(html).toMatch(/value="full"\s+checked/);
  });
});

// ---------------------------------------------------------------------------
// 2FA (TOTP) on consent
// ---------------------------------------------------------------------------

describe("OAuth consent — 2FA (TOTP)", () => {
  async function hashPassword(pw: string): Promise<string> {
    return await Bun.password.hash(pw, { algorithm: "bcrypt", cost: 4 });
  }

  function makeTotp(secretBase32: string) {
    return new OTPAuth.TOTP({
      issuer: "Parachute Vault",
      label: "owner",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
  }

  test("GET renders TOTP field when 2FA enrolled", async () => {
    const passwordHash = await hashPassword("correcthorsebatterystaple");
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const url = new URL("https://vault.test/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://example.com/callback");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("response_type", "code");

    const res = handleAuthorizeGet(makeRequest(url.toString()), db, "default", passwordHash, true);
    const html = await res.text();
    expect(html).toContain('name="totp_code"');
    expect(html).toContain('name="backup_code"');
  });

  test("GET omits TOTP field when 2FA not enrolled", async () => {
    const passwordHash = await hashPassword("correcthorsebatterystaple");
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const url = new URL("https://vault.test/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://example.com/callback");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("response_type", "code");

    const res = handleAuthorizeGet(makeRequest(url.toString()), db, "default", passwordHash, false);
    const html = await res.text();
    expect(html).not.toContain('name="totp_code"');
  });

  test("POST accepts valid TOTP + password and mints a token", async () => {
    const password = "correcthorsebatterystaple";
    const passwordHash = await hashPassword(password);
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const code = makeTotp(secret).generate();

    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const res = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          state: "",
          password,
          totp_code: code,
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash, totpSecret: secret, vaultName: "default" },
    );
    expect(res.status).toBe(302);
    const authCode = new URL(res.headers.get("location")!).searchParams.get("code")!;
    expect(authCode).toBeTruthy();

    // Exchange works end-to-end
    const tokenRes = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    expect(tokenRes.status).toBe(200);
    const body = await tokenRes.json();
    expect(body.access_token).toBeTruthy();
  });

  test("POST rejects wrong TOTP with re-rendered consent (no code issued)", async () => {
    const password = "correcthorsebatterystaple";
    const passwordHash = await hashPassword(password);
    const secret = new OTPAuth.Secret({ size: 20 }).base32;

    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();

    const res = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: "https://example.com/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          state: "",
          password,
          totp_code: "000000",
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash, totpSecret: secret },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid credentials");
    // No auth code was created
    const rows = db.prepare("SELECT COUNT(*) as n FROM oauth_codes").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("POST rejects missing TOTP when 2FA enrolled", async () => {
    const password = "correcthorsebatterystaple";
    const passwordHash = await hashPassword(password);
    const secret = new OTPAuth.Secret({ size: 20 }).base32;

    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();

    const res = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: "https://example.com/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          state: "",
          password,
          // no totp_code, no backup_code
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash, totpSecret: secret },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Enter a 6-digit code");
  });

  test("POST rejects TOTP when password itself is wrong (TOTP not consulted)", async () => {
    const passwordHash = await hashPassword("correcthorsebatterystaple");
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const validCode = makeTotp(secret).generate();

    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();

    const res = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: "https://example.com/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          state: "",
          password: "wrongwrongwrong",
          totp_code: validCode,
        }),
      }),
      db,
      { ownerPasswordHash: passwordHash, totpSecret: secret },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid credentials");
  });
});

// ---------------------------------------------------------------------------
// Token response — honest vault name (Fix 1)
// ---------------------------------------------------------------------------

describe("OAuth token response — vault name", () => {
  test("includes vault name for the default (unscoped) flow", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    const body = await tokenRes.json();
    expect(body.access_token).toMatch(/^pvt_/);
    expect(body.vault).toBe("default");
    expect(body.token_type).toBe("bearer");
    expect(body.scope).toBe("vault:read vault:write vault:admin");
  });

  test("includes vault name for a scoped (named-vault) flow", async () => {
    // The vaultName is purely a response-shape concern; the DB is the same
    // in-memory DB here. The point is that handleToken echoes the name it
    // was called with, so the client can trust which vault it just connected to.
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/vault/work/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "work" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/vault/work/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "work",
    );
    const body = await tokenRes.json();
    expect(body.vault).toBe("work");
  });
});

// ---------------------------------------------------------------------------
// Vault-scoped discovery (Fix 3 — routing coherence)
// ---------------------------------------------------------------------------

describe("OAuth discovery — vault-scoped", () => {
  test("authorization-server metadata scopes all endpoints to the vault", async () => {
    const req = makeRequest("https://vault.test/vault/work/.well-known/oauth-authorization-server");
    const res = handleAuthorizationServer(req, "work");
    const body = await res.json();
    // Issuer and endpoints all live under /vault/work. A client following the
    // scoped discovery gets redirected to the scoped authorize/token endpoints,
    // which in turn mint the token into the named vault's DB.
    expect(body.issuer).toBe("https://vault.test/vault/work");
    expect(body.authorization_endpoint).toBe("https://vault.test/vault/work/oauth/authorize");
    expect(body.token_endpoint).toBe("https://vault.test/vault/work/oauth/token");
    expect(body.registration_endpoint).toBe("https://vault.test/vault/work/oauth/register");
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("protected-resource advertises a vault-scoped authorization server", async () => {
    const req = makeRequest("https://vault.test/vault/work/.well-known/oauth-protected-resource");
    const res = handleProtectedResource(req, "work");
    const body = await res.json();
    expect(body.resource).toBe("https://vault.test/vault/work/mcp");
    // The authorization server the client should fetch next is the scoped one,
    // so the client discovers the scoped authorize/token endpoints.
    expect(body.authorization_servers).toEqual(["https://vault.test/vault/work"]);
  });

  test("scoped discovery honors x-forwarded-host", async () => {
    const req = makeRequest("http://localhost:1940/vault/work/.well-known/oauth-authorization-server", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "vault.example.com",
      },
    });
    const res = handleAuthorizationServer(req, "work");
    const body = await res.json();
    expect(body.issuer).toBe("https://vault.example.com/vault/work");
    expect(body.authorization_endpoint).toBe("https://vault.example.com/vault/work/oauth/authorize");
  });
});

// ---------------------------------------------------------------------------
// Cross-vault code replay defense
// ---------------------------------------------------------------------------

describe("OAuth token — cross-vault code replay", () => {
  // The in-memory DB in this suite is shared, but handleToken is passed the
  // vaultName it was invoked under. That's the check: a code issued for
  // vault A must not mint a token when presented to vault B's token endpoint,
  // even if both endpoints share storage.

  test("code issued for vault A rejected at vault B's token endpoint", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    // Issue a code under vault A's authorize endpoint
    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/vault/vault-a/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "vault-a" },
    );
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    // Try to redeem it at vault B's token endpoint — must reject with
    // invalid_grant per RFC 6749 §5.2. This is the privilege-escalation
    // barrier: without the vault_name pinning, the code would mint a token
    // into whichever vault's DB this handleToken was called against.
    const tokenRes = await handleToken(
      makeRequest("https://vault.test/vault/vault-b/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "vault-b",
    );
    expect(tokenRes.status).toBe(400);
    const body = await tokenRes.json();
    expect(body.error).toBe("invalid_grant");
  });

  test("code issued for vault A still redeems successfully at vault A's token endpoint", async () => {
    // Control case — same setup as the rejection test, but the token
    // endpoint matches the authorize endpoint. Must succeed.
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/vault/vault-a/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "vault-a" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/vault/vault-a/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "vault-a",
    );
    expect(tokenRes.status).toBe(200);
    const body = await tokenRes.json();
    expect(body.vault).toBe("vault-a");
    expect(body.access_token).toMatch(/^pvt_/);
  });
});

// ---------------------------------------------------------------------------
// Phase 0+1: PARACHUTE_HUB_ORIGIN + service catalog in token response
// ---------------------------------------------------------------------------

describe("OAuth Phase 0: PARACHUTE_HUB_ORIGIN", () => {
  const HUB = "https://hub.example";
  let origHub: string | undefined;
  let origHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    origHub = process.env.PARACHUTE_HUB_ORIGIN;
    origHome = process.env.PARACHUTE_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vault-oauth-phase0-"));
    process.env.PARACHUTE_HOME = tmpHome;
  });

  afterEach(() => {
    if (origHub === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
    else process.env.PARACHUTE_HUB_ORIGIN = origHub;
    if (origHome === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("discovery: returns hub issuer when request arrives via hub origin", () => {
    process.env.PARACHUTE_HUB_ORIGIN = HUB;
    const req = makeRequest(`${HUB}/vault/default/.well-known/oauth-authorization-server`);
    const res = handleAuthorizationServer(req, "default");
    expect(res.status).toBe(200);
    return res.json().then((body: any) => {
      expect(body.issuer).toBe(HUB);
      expect(body.authorization_endpoint).toBe(`${HUB}/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${HUB}/oauth/token`);
      expect(body.registration_endpoint).toBe(`${HUB}/oauth/register`);
      expect(body.scopes_supported).toContain("vault:read");
      expect(body.scopes_supported).toContain("vault:write");
    });
  });

  test("discovery: trailing slash on hub origin is stripped", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = `${HUB}/`;
    const req = makeRequest(`${HUB}/vault/default/.well-known/oauth-authorization-server`);
    const res = handleAuthorizationServer(req, "default");
    const body = await res.json();
    expect(body.issuer).toBe(HUB);
    expect(body.token_endpoint).toBe(`${HUB}/oauth/token`);
  });

  test("discovery: protected-resource metadata uses hub as authorization_server when request arrives via hub", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = HUB;
    const req = makeRequest(`${HUB}/vault/default/.well-known/oauth-protected-resource`);
    const res = handleProtectedResource(req, "default");
    const body = await res.json();
    expect(body.authorization_servers).toEqual([HUB]);
    expect(body.resource).toBe(`${HUB}/vault/default/mcp`);
    expect(body.scopes_supported).toContain("vault:read");
  });

  test("discovery: RFC 8414 — hub env set, request via loopback returns loopback issuer, not hub", async () => {
    // Aaron's bug: mcp-install wrote a loopback URL while PARACHUTE_HUB_ORIGIN
    // was set, so the client fetched discovery via http://127.0.0.1 but got
    // back `issuer: https://hub.example` — origin mismatch, strict OAuth
    // clients (Claude Code) reject. Each origin must advertise its own issuer.
    process.env.PARACHUTE_HUB_ORIGIN = HUB;
    const req = makeRequest("http://127.0.0.1:1940/vault/default/.well-known/oauth-authorization-server");
    const res = handleAuthorizationServer(req, "default");
    const body = await res.json();
    expect(body.issuer).toBe("http://127.0.0.1:1940/vault/default");
    expect(body.token_endpoint).toBe("http://127.0.0.1:1940/vault/default/oauth/token");
    expect(body.registration_endpoint).toBe("http://127.0.0.1:1940/vault/default/oauth/register");
  });

  test("discovery: protected-resource on loopback returns loopback AS even with hub env set", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = HUB;
    const req = makeRequest("http://127.0.0.1:1940/vault/default/.well-known/oauth-protected-resource");
    const res = handleProtectedResource(req, "default");
    const body = await res.json();
    expect(body.authorization_servers).toEqual(["http://127.0.0.1:1940/vault/default"]);
    expect(body.resource).toBe("http://127.0.0.1:1940/vault/default/mcp");
  });

  test("discovery: falls back to vault origin when env is unset", async () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    const req = makeRequest("https://vault.test/vault/default/.well-known/oauth-authorization-server");
    const res = handleAuthorizationServer(req, "default");
    const body = await res.json();
    expect(body.issuer).toBe("https://vault.test/vault/default");
    expect(body.token_endpoint).toBe("https://vault.test/vault/default/oauth/token");
  });

  test("scopes_supported publishes new shape alongside legacy names", async () => {
    const req = makeRequest("https://vault.test/vault/default/.well-known/oauth-authorization-server");
    const res = handleAuthorizationServer(req, "default");
    const body = await res.json();
    expect(body.scopes_supported).toEqual(expect.arrayContaining(["vault:read", "vault:write", "full", "read"]));
  });

  test("token response includes iss = hub when issued on hub origin", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = HUB;
    const token = await fullOAuthFlow();
    // Re-issue a token to inspect the body (fullOAuthFlow returns only the string)
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";
    const authRes = await handleAuthorizePost(
      makeRequest(`${HUB}/vault/default/oauth/authorize`, {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await handleToken(
      makeRequest(`${HUB}/vault/default/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    expect(tokenRes.status).toBe(200);
    const body = await tokenRes.json();
    expect(body.iss).toBe(HUB);
    expect(body.services).toEqual({});
    // Back-compat: access_token still present and unchanged shape-wise.
    expect(body.access_token).toMatch(/^pvt_/);
    expect(token).toMatch(/^pvt_/);
  });

  test("token iss matches request origin when client came via loopback even with hub env set", async () => {
    // Same-vault twin of the discovery-on-loopback test: a token minted over
    // the loopback flow carries `iss` = the loopback issuer, not the hub.
    // Tokens introspected against loopback discovery's issuer must validate.
    process.env.PARACHUTE_HUB_ORIGIN = HUB;
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";
    const authRes = await handleAuthorizePost(
      makeRequest("http://127.0.0.1:1940/vault/default/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await handleToken(
      makeRequest("http://127.0.0.1:1940/vault/default/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    const body = await tokenRes.json();
    expect(body.iss).toBe("http://127.0.0.1:1940/vault/default");
  });

  test("token response services catalog reflects services.json using hub origin when issued via hub", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = HUB;
    fs.writeFileSync(
      path.join(tmpHome, "services.json"),
      JSON.stringify({
        services: [
          { name: "vault", port: 1940, paths: ["/vault/default"], health: "/health", version: "0.3.0" },
          { name: "notes", port: 1941, paths: ["/notes"], health: "/health", version: "0.1.0" },
        ],
      }),
    );

    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";
    const authRes = await handleAuthorizePost(
      makeRequest(`${HUB}/vault/default/oauth/authorize`, {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await handleToken(
      makeRequest(`${HUB}/vault/default/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    const body = await tokenRes.json();
    expect(body.services).toEqual({
      vault: { url: `${HUB}/vault/default`, version: "0.3.0" },
      notes: { url: `${HUB}/notes`, version: "0.1.0" },
    });
  });

  test("token response services catalog falls back to vault origin when hub env unset", async () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    fs.writeFileSync(
      path.join(tmpHome, "services.json"),
      JSON.stringify({
        services: [
          { name: "vault", port: 1940, paths: ["/vault/default"], health: "/health", version: "0.3.0" },
        ],
      }),
    );

    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";
    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/vault/default/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await handleToken(
      makeRequest("https://vault.test/vault/default/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      db,
      "default",
    );
    const body = await tokenRes.json();
    expect(body.iss).toBe("https://vault.test/vault/default");
    expect(body.services).toEqual({
      vault: { url: "https://vault.test/vault/default", version: "0.3.0" },
    });
  });
});

// ---------------------------------------------------------------------------
// Per-vault rate limiter + memory cap (#93)
// ---------------------------------------------------------------------------

describe("OAuth consent — per-vault rate limiting (#93)", () => {
  test("getAuthorizeRateLimiter returns the same instance for the same vault name", async () => {
    const { getAuthorizeRateLimiter, resetVaultAuthorizeRateLimiters } =
      await import("./owner-auth.ts");
    resetVaultAuthorizeRateLimiters();
    const a1 = getAuthorizeRateLimiter("alpha");
    const a2 = getAuthorizeRateLimiter("alpha");
    expect(a1).toBe(a2);
  });

  test("getAuthorizeRateLimiter returns distinct instances per vault", async () => {
    const { getAuthorizeRateLimiter, resetVaultAuthorizeRateLimiters } =
      await import("./owner-auth.ts");
    resetVaultAuthorizeRateLimiters();
    const work = getAuthorizeRateLimiter("work");
    const personal = getAuthorizeRateLimiter("personal");
    expect(work).not.toBe(personal);
  });

  test("a lockout on one vault's limiter does not lock the same IP on another vault's limiter", async () => {
    const { getAuthorizeRateLimiter, resetVaultAuthorizeRateLimiters } =
      await import("./owner-auth.ts");
    resetVaultAuthorizeRateLimiters();
    const ip = "192.0.2.55";
    const work = getAuthorizeRateLimiter("work");
    // Pump enough failures on `work` to trip the default 10-failure threshold.
    for (let i = 0; i < 10; i++) work.recordFailure(ip);
    expect(work.check(ip).allowed).toBe(false);
    // The unrelated vault's limiter should still allow this IP.
    const personal = getAuthorizeRateLimiter("personal");
    expect(personal.check(ip).allowed).toBe(true);
  });

  test("entry count is hard-capped — oldest IP is evicted FIFO when full", async () => {
    const { RateLimiter } = await import("./owner-auth.ts");
    // Tiny cap (3) so we don't have to hammer the limiter to prove eviction.
    const limiter = new RateLimiter(10, 60_000, 60_000, 3);
    limiter.recordFailure("10.0.0.1");
    limiter.recordFailure("10.0.0.2");
    limiter.recordFailure("10.0.0.3");
    expect(limiter.size()).toBe(3);
    // Adding a 4th IP must evict the oldest (10.0.0.1) to stay at the cap.
    limiter.recordFailure("10.0.0.4");
    expect(limiter.size()).toBe(3);
    // The evicted IP is treated as untracked → fresh check is allowed.
    expect(limiter.check("10.0.0.1").allowed).toBe(true);
    // Newer entries remain locked into their failure state.
    expect(limiter.check("10.0.0.4").allowed).toBe(true); // still under threshold
  });
});

// ---------------------------------------------------------------------------
// Server-bound scope at /authorize, subset enforcement at /token (#94)
// ---------------------------------------------------------------------------

describe("OAuth scope binding (#94, RFC 6749 §3.3 / §6)", () => {
  test("/authorize floors selected scope to requested — form cannot smuggle a broader scope", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "read",            // requested = read
          selected_scope: "full",   // smuggled broader value
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    // The bound scope on the issued auth code must be the narrower of the two.
    const row = db
      .prepare("SELECT scope FROM oauth_codes WHERE code = ?")
      .get(code) as { scope: string };
    expect(row.scope).toBe("read");
  });

  test("/token rejects requested scope broader than bound (read → full)", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "read",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "full", // attempt to broaden
        }).toString(),
      }),
      db,
      "default",
    );
    expect(tokenRes.status).toBe(400);
    const body = (await tokenRes.json()) as { error?: string };
    expect(body.error).toBe("invalid_scope");
  });

  test("/token accepts a narrower requested scope (full → read) and reflects it on the token", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "read", // narrower than bound
        }).toString(),
      }),
      db,
      "default",
    );
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { scope?: string };
    expect(body.scope).toBe("vault:read");
  });

  test("/token treats whitespace-only scope as absent and falls through to bound scope (#196)", async () => {
    // Guard at oauth.ts checks `scope !== null && scope.trim().length > 0`.
    // A client sending `scope=   ` is the same as omitting `scope` — we
    // must not run subset enforcement against the whitespace string and
    // reject it as invalid.
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "read",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "   ", // whitespace only — should fall through to bound
        }).toString(),
      }),
      db,
      "default",
    );
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { scope?: string };
    expect(body.scope).toBe("vault:read");
  });

  test("/token rejects unknown scope strings even when the bound scope is broad", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "vault:admin", // not in the consent vocabulary
        }).toString(),
      }),
      db,
      "default",
    );
    expect(tokenRes.status).toBe(400);
    const body = (await tokenRes.json()) as { error?: string };
    expect(body.error).toBe("invalid_scope");
  });

  test("/token uses the bound scope when no scope param is sent (regression)", async () => {
    const ownerToken = createOwnerToken();
    const clientId = await registerClient();
    const { codeVerifier, codeChallenge } = generatePkce();
    const redirectUri = "https://example.com/callback";

    const authRes = await handleAuthorizePost(
      makeRequest("https://vault.test/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "read",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName: "default" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await handleToken(
      makeRequest("https://vault.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
          // no scope param
        }).toString(),
      }),
      db,
      "default",
    );
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { scope?: string };
    expect(body.scope).toBe("vault:read");
  });
});
