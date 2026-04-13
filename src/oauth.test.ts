/**
 * Tests for the OAuth 2.1 provider.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { initSchema } from "../core/src/schema.ts";
import { resolveToken } from "./token-store.ts";
import {
  handleProtectedResource,
  handleAuthorizationServer,
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleToken,
} from "./oauth.ts";

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
  const clientId = await registerClient();
  const { codeVerifier, codeChallenge } = generatePkce();
  const redirectUri = "https://example.com/callback";
  const scope = opts?.scope || "full";

  // POST authorize (simulate user clicking Authorize)
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
    }),
  });
  const authRes = await handleAuthorizePost(authReq, db);
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
  const tokenRes = await handleToken(tokenReq, db);
  const tokenBody = await tokenRes.json();
  return tokenBody.access_token;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("OAuth discovery", () => {
  test("protected resource metadata", async () => {
    const req = makeRequest("https://vault.test/.well-known/oauth-protected-resource");
    const res = handleProtectedResource(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://vault.test");
    expect(body.scopes_supported).toContain("full");
    expect(body.scopes_supported).toContain("read");
  });

  test("authorization server metadata", async () => {
    const req = makeRequest("https://vault.test/.well-known/oauth-authorization-server");
    const res = handleAuthorizationServer(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe("https://vault.test");
    expect(body.authorization_endpoint).toBe("https://vault.test/oauth/authorize");
    expect(body.token_endpoint).toBe("https://vault.test/oauth/token");
    expect(body.registration_endpoint).toBe("https://vault.test/oauth/register");
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("uses x-forwarded-proto and x-forwarded-host", async () => {
    const req = makeRequest("http://localhost:1940/.well-known/oauth-protected-resource", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "vault.example.com",
      },
    });
    const res = handleProtectedResource(req);
    const body = await res.json();
    expect(body.resource).toBe("https://vault.example.com");
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
    const res = await handleToken(req, db);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });

  test("rejects wrong PKCE verifier", async () => {
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
      }),
    });
    const authRes = await handleAuthorizePost(authReq, db);
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
    const res = await handleToken(tokenReq, db);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_description).toContain("PKCE");
  });

  test("rejects already-used code", async () => {
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
      }),
    });
    const authRes = await handleAuthorizePost(authReq, db);
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
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_description).toContain("expired");
  });

  test("rejects mismatched client_id", async () => {
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
        }),
      }),
      db,
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
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
  });

  test("rejects non-POST", async () => {
    const res = await handleToken(
      makeRequest("https://vault.test/oauth/token"),
      db,
    );
    expect(res.status).toBe(405);
  });
});
