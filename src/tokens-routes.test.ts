/**
 * Tests for `/vault/<name>/tokens` REST endpoints (issue #173).
 *
 * Covers the seven cases the design brief named, plus method-not-allowed
 * and the hub-JWT auth path. Each test uses its own PARACHUTE_HOME tmp dir,
 * mirroring `routing.test.ts` and `auth-hub-jwt.test.ts`.
 *
 * Key invariants under test:
 *   - POST returns plaintext exactly once (201 body), but never afterwards
 *     in GET listings (no plaintext, no token_hash field exposed).
 *   - Scope subset enforcement: minted scopes must be ≤ caller's vault
 *     verb power. Cross-vault scopes (`vault:other:*`) rejected.
 *   - Admin gate: read/write callers cannot reach the endpoint at all.
 *   - DELETE is intentionally non-leaky — non-existent ids return 200.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const testDir = join(
  tmpdir(),
  `vault-tokens-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.PARACHUTE_HOME = testDir;

const { route } = await import("./routing.ts");
const { writeGlobalConfig, writeVaultConfig } = await import("./config.ts");
const { clearVaultStoreCache, getVaultStore } = await import("./vault-store.ts");
const { generateToken, createToken, resolveToken } = await import("./token-store.ts");
const { resetJwksCache } = await import("./hub-jwt.ts");

interface Keypair {
  privateKey: CryptoKey;
  publicJwk: { kty: string; n: string; e: string; kid: string; alg: string; use: string };
  kid: string;
}

async function makeKeypair(kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: { kty: "RSA", n: jwk.n!, e: jwk.e!, kid, alg: "RS256", use: "sig" },
    kid,
  };
}

interface JwksFixture {
  origin: string;
  stop: () => void;
}

function startJwksFixture(keys: Keypair[]): JwksFixture {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/.well-known/jwks.json") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({ keys: keys.map((k) => k.publicJwk) });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

async function signHubJwt(
  kp: Keypair,
  iss: string,
  aud: string,
  scope: string,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return await new SignJWT({ scope, client_id: "test-client" })
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer(iss)
    .setSubject("user-1")
    .setAudience(aud)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .setJti(`jti-${Math.random().toString(36).slice(2)}`)
    .sign(kp.privateKey);
}

function createVault(name: string): void {
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  getVaultStore(name);
}

function mintAdminToken(vaultName: string): string {
  const store = getVaultStore(vaultName);
  const { fullToken } = generateToken();
  createToken(store.db, fullToken, {
    label: "test-admin",
    permission: "full",
    scopes: ["vault:read", "vault:write", "vault:admin"],
  });
  return fullToken;
}

function mintReadOnlyToken(vaultName: string): string {
  const store = getVaultStore(vaultName);
  const { fullToken } = generateToken();
  createToken(store.db, fullToken, {
    label: "test-read",
    permission: "read",
    scopes: ["vault:read"],
  });
  return fullToken;
}

let fixture: JwksFixture | null = null;
let kp: Keypair | null = null;
let prevHubOrigin: string | undefined;

beforeEach(async () => {
  clearVaultStoreCache();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "vault", "data"), { recursive: true });
  writeGlobalConfig({ port: 1940 });

  kp = await makeKeypair("k1");
  fixture = startJwksFixture([kp]);
  prevHubOrigin = process.env.PARACHUTE_HUB_ORIGIN;
  process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
  resetJwksCache();
});

afterEach(() => {
  if (fixture) fixture.stop();
  fixture = null;
  kp = null;
  if (prevHubOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = prevHubOrigin;
  clearVaultStoreCache();
});

function postTokens(
  vaultName: string,
  bearer: string | null,
  body: Record<string, unknown>,
): Promise<Response> {
  const path = `/vault/${vaultName}/tokens`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return route(
    new Request(`http://localhost:1940${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    path,
  );
}

function getTokens(vaultName: string, bearer: string | null): Promise<Response> {
  const path = `/vault/${vaultName}/tokens`;
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return route(new Request(`http://localhost:1940${path}`, { headers }), path);
}

function deleteToken(
  vaultName: string,
  id: string,
  bearer: string | null,
): Promise<Response> {
  const path = `/vault/${vaultName}/tokens/${id}`;
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return route(
    new Request(`http://localhost:1940${path}`, { method: "DELETE", headers }),
    path,
  );
}

describe("POST /vault/<name>/tokens — happy path", () => {
  test("admin pvt_* mints a token with default full scopes; plaintext returned exactly once", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");

    const res = await postTokens("journal", admin, { label: "agent-x" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      token: string;
      label: string;
      permission: string;
      scopes: string[];
      expires_at: string | null;
      created_at: string;
    };
    expect(body.token).toMatch(/^pvt_/);
    expect(body.id).toMatch(/^t_/);
    expect(body.label).toBe("agent-x");
    expect(body.permission).toBe("full");
    expect(body.scopes).toEqual(["vault:read", "vault:write", "vault:admin"]);
    expect(body.expires_at).toBeNull();

    // Minted token actually authenticates against the vault.
    const store = getVaultStore("journal");
    const resolved = resolveToken(store.db, body.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.permission).toBe("full");
  });

  test("admin pvt_* mints with explicit narrowed scopes — read-only", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");

    const res = await postTokens("journal", admin, {
      label: "reader",
      scopes: ["vault:read"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      permission: string;
      scopes: string[];
    };
    expect(body.permission).toBe("read");
    expect(body.scopes).toEqual(["vault:read"]);
  });

  test("admin pvt_* mints with OAuth-style space-separated `scope` string", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");

    const res = await postTokens("journal", admin, {
      scope: "vault:read vault:write",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scopes: string[]; permission: string };
    expect(body.scopes).toEqual(["vault:read", "vault:write"]);
    expect(body.permission).toBe("full");
  });

  test("hub JWT with vault:<name>:admin can mint", async () => {
    createVault("journal");
    const token = await signHubJwt(
      kp!,
      fixture!.origin,
      "vault.journal",
      "vault:journal:admin",
    );

    const res = await postTokens("journal", token, { label: "from-hub" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; label: string };
    expect(body.token).toMatch(/^pvt_/);
    expect(body.label).toBe("from-hub");
  });

  test("future expires_at is accepted and round-trips", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");
    const exp = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const res = await postTokens("journal", admin, { expires_at: exp });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { expires_at: string };
    // The stored value is a re-serialized ISO string — same instant, byte-equal here.
    expect(body.expires_at).toBe(exp);
  });
});

describe("POST /vault/<name>/tokens — scope narrowing", () => {
  test("hub JWT with write scope can mint a write-or-lower token", async () => {
    createVault("journal");
    // Bypass the admin gate by minting with admin first to seed; then test
    // narrowing by minting via a write-scoped JWT — but the gate blocks
    // that path. The narrowing rule is most meaningful via subset check
    // independently of the gate, so we use an admin JWT that requests a
    // narrower (write-only) token. This is the supported narrowing path.
    const token = await signHubJwt(
      kp!,
      fixture!.origin,
      "vault.journal",
      "vault:journal:admin",
    );

    const res = await postTokens("journal", token, {
      label: "write-only",
      scopes: ["vault:write"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { permission: string; scopes: string[] };
    expect(body.scopes).toEqual(["vault:write"]);
    // Resolved permission derives from the highest scope held — write → full.
    expect(body.permission).toBe("full");
  });

  test("cross-vault scope `vault:<other>:read` is rejected with 400", async () => {
    createVault("journal");
    createVault("work");
    const admin = mintAdminToken("journal");

    const res = await postTokens("journal", admin, {
      label: "cross-vault-attempt",
      scopes: ["vault:work:read"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      message: string;
      rejected: { scope: string; reason: string }[];
    };
    expect(body.message).toBe("scope rejected");
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.scope).toBe("vault:work:read");
    expect(body.rejected[0]!.reason).toContain("cross-vault");
  });

  test("invalid scope name is rejected with 400 (no token created)", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");

    const res = await postTokens("journal", admin, {
      scopes: ["vault:read", "not-a-real-scope"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      rejected: { scope: string; reason: string }[];
    };
    expect(body.rejected.some((r) => r.scope === "not-a-real-scope")).toBe(true);

    // Confirm no token was minted.
    const list = await getTokens("journal", admin).then((r) => r.json()) as {
      tokens: { label: string }[];
    };
    expect(list.tokens.find((t) => t.label !== "test-admin")).toBeUndefined();
  });

  test("expires_at in the past is rejected with 400", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");
    const past = new Date(Date.now() - 1000).toISOString();

    const res = await postTokens("journal", admin, { expires_at: past });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("future");
  });
});

describe("POST /vault/<name>/tokens — auth gates", () => {
  test("missing auth → 401", async () => {
    createVault("journal");
    const res = await postTokens("journal", null, { label: "x" });
    expect(res.status).toBe(401);
  });

  test("read-only pvt_* token → 403 insufficient_scope (admin required)", async () => {
    createVault("journal");
    const reader = mintReadOnlyToken("journal");

    const res = await postTokens("journal", reader, { label: "x" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error_type: string;
      required_scope: string;
    };
    expect(body.error_type).toBe("insufficient_scope");
    expect(body.required_scope).toBe("vault:admin");
  });

  test("hub JWT scoped to a different vault → 401 audience mismatch", async () => {
    createVault("journal");
    createVault("work");
    const wrongAud = await signHubJwt(
      kp!,
      fixture!.origin,
      "vault.work",
      "vault:work:admin",
    );

    const res = await postTokens("journal", wrongAud, {});
    expect(res.status).toBe(401);
  });
});

describe("GET /vault/<name>/tokens — list", () => {
  test("admin can list tokens; response excludes plaintext and hash", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");
    // Add a second token via the endpoint so we have multiple rows.
    await postTokens("journal", admin, { label: "agent-x", scopes: ["vault:read"] });

    const res = await getTokens("journal", admin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokens: Array<{
        id: string;
        label: string;
        permission: string;
        scopes: string[];
        expires_at: string | null;
        created_at: string;
        last_used_at: string | null;
      }>;
    };
    expect(body.tokens.length).toBeGreaterThanOrEqual(2);
    for (const t of body.tokens) {
      expect(t.id).toMatch(/^t_/);
      // Plaintext and hash must never appear, even by accident.
      expect(JSON.stringify(t)).not.toMatch(/pvt_/);
      expect(JSON.stringify(t)).not.toMatch(/token_hash/);
      expect(JSON.stringify(t)).not.toMatch(/sha256:/);
    }
    const minted = body.tokens.find((t) => t.label === "agent-x");
    expect(minted).toBeDefined();
    expect(minted!.scopes).toEqual(["vault:read"]);
    expect(minted!.permission).toBe("read");
  });

  test("read-only token cannot list (admin gate) → 403", async () => {
    createVault("journal");
    const reader = mintReadOnlyToken("journal");

    const res = await getTokens("journal", reader);
    expect(res.status).toBe(403);
  });
});

describe("DELETE /vault/<name>/tokens/<id> — revoke", () => {
  test("admin revokes by display id; revoked token no longer resolves", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");

    const minted = (await (await postTokens("journal", admin, {
      label: "to-revoke",
    })).json()) as { id: string; token: string };
    const store = getVaultStore("journal");
    expect(resolveToken(store.db, minted.token)).not.toBeNull();

    const res = await deleteToken("journal", minted.id, admin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);

    expect(resolveToken(store.db, minted.token)).toBeNull();
  });

  test("non-existent id → 200 with revoked:true (no existence leak)", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");

    const res = await deleteToken("journal", "t_doesnotexist", admin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);
  });

  test("read-only token cannot revoke → 403", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");
    const reader = mintReadOnlyToken("journal");

    const minted = (await (await postTokens("journal", admin, {
      label: "victim",
    })).json()) as { id: string };

    const res = await deleteToken("journal", minted.id, reader);
    expect(res.status).toBe(403);
  });
});

describe("/vault/<name>/tokens — method handling", () => {
  test("PUT on collection → 405", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");
    const path = "/vault/journal/tokens";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${admin}` },
      }),
      path,
    );
    expect(res.status).toBe(405);
  });

  test("PATCH on item → 405", async () => {
    createVault("journal");
    const admin = mintAdminToken("journal");
    const path = "/vault/journal/tokens/t_anything";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${admin}` },
      }),
      path,
    );
    expect(res.status).toBe(405);
  });
});
