/**
 * End-to-end auth tests for the hub-JWT path.
 *
 * `hub-jwt.test.ts` covers `validateHubJwt` in isolation. This file exercises
 * the full request path: a JWT bearer arrives at `authenticateVaultRequest`,
 * goes through `authenticateHubJwt`, and the result either resolves into an
 * `AuthResult` or surfaces as a 401 Response. The cases that matter most:
 *
 *   - happy path with narrowed scopes
 *   - broad `vault:<verb>` scope rejected (forced narrowing per #180)
 *   - `aud=vault.<other>` rejected (audience mismatch)
 *   - JWT path rejected at the global (cross-vault) entrypoint
 *
 * Each test owns a fresh `PARACHUTE_HOME` and JWKS fixture, like the auth.test
 * peer file. The JWKS fixture mirrors the one in hub-jwt.test.ts; duplicating
 * ~30 lines is cheaper than introducing a shared test-helper module.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { writeVaultConfig, readVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { authenticateVaultRequest, authenticateGlobalRequest } from "./auth.ts";
import { resetJwksCache } from "./hub-jwt.ts";

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

interface SignOpts {
  iss: string;
  aud: string;
  scope: string;
  sub?: string;
  ttlSeconds?: number;
}

async function signJwt(kp: Keypair, opts: SignOpts): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (opts.ttlSeconds ?? 60);
  return await new SignJWT({ scope: opts.scope, client_id: "test-client" })
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer(opts.iss)
    .setSubject(opts.sub ?? "user-1")
    .setAudience(opts.aud)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(`jti-${Math.random().toString(36).slice(2)}`)
    .sign(kp.privateKey);
}

function bearer(token: string): Request {
  return new Request("https://vault.test/x", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

let tmpHome: string;
let prevHome: string | undefined;
let prevHubOrigin: string | undefined;
let fixture: JwksFixture;
let kp: Keypair;

beforeEach(async () => {
  tmpHome = join(
    tmpdir(),
    `vault-auth-jwt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();

  kp = await makeKeypair("k1");
  fixture = startJwksFixture([kp]);
  prevHubOrigin = process.env.PARACHUTE_HUB_ORIGIN;
  process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
  resetJwksCache();
});

afterEach(() => {
  fixture.stop();
  clearVaultStoreCache();
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (prevHubOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = prevHubOrigin;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function seedVault(name: string): void {
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  // Touch the store so the DB file exists (matches the routing path's expectation).
  getVaultStore(name);
}

describe("authenticateVaultRequest — hub JWT integration", () => {
  test("narrowed scope + matching aud → AuthResult with permission derived from verb", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:write",
    });
    const config = readVaultConfig("journal")!;
    const store = getVaultStore("journal");

    const result = await authenticateVaultRequest(bearer(token), config, store.db);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("full");
      expect(result.scopes).toEqual(["vault:journal:write"]);
      expect(result.legacyDerived).toBe(false);
    }
  });

  test("narrowed read scope → permission='read'", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:read",
    });
    const config = readVaultConfig("journal")!;
    const store = getVaultStore("journal");

    const result = await authenticateVaultRequest(bearer(token), config, store.db);
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.permission).toBe("read");
  });

  test("broad vault:write scope from a JWT → 401 with explanatory message", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:write",
    });
    const config = readVaultConfig("journal")!;
    const store = getVaultStore("journal");

    const result = await authenticateVaultRequest(bearer(token), config, store.db);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      const body = (await result.error.json()) as { error: string; message: string };
      expect(body.error).toBe("Unauthorized");
      expect(body.message).toContain("broad vault scope");
      expect(body.message).toContain("vault:write");
    }
  });

  test("aud=vault.work cannot reach /vault/journal/* → 401 audience mismatch", async () => {
    seedVault("journal");
    seedVault("work");
    // Token is correctly stamped for work, but presented at journal's endpoint.
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.work",
      scope: "vault:work:write",
    });
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const result = await authenticateVaultRequest(
      bearer(token),
      journalConfig,
      journalStore.db,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      const body = (await result.error.json()) as { error: string; message: string };
      expect(body.message).toMatch(/audience mismatch.*vault\.journal.*vault\.work/);
    }
  });

  test("hub JWT at the global (cross-vault) entrypoint → 401 with vault-bound hint", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:read",
    });
    const result = await authenticateGlobalRequest(bearer(token));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      const body = (await result.error.json()) as { error: string; message: string };
      expect(body.message).toContain("vault-bound");
      expect(body.message).toContain("/vault/<name>");
    }
  });
});
