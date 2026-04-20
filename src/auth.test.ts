/**
 * Auth invariants — per-vault routing with strict isolation.
 *
 * Every HTTP path that touches a vault lives under `/vault/<name>/...`, so
 * a token minted for vault A must authenticate at vault A endpoints and
 * must not authenticate at vault B endpoints. The global auth path still
 * exists for cross-vault listings (`/vaults`) and scans every vault's DB.
 *
 * These tests isolate `PARACHUTE_HOME` so they don't touch the user's real
 * config. Each test builds 1-2 vaults from scratch.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeVaultConfig,
  writeGlobalConfig,
  readVaultConfig,
  readGlobalConfig,
  generateApiKey,
  hashKey,
} from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateToken, createToken } from "./token-store.ts";
import { authenticateVaultRequest, authenticateGlobalRequest } from "./auth.ts";
import { handleRegister, handleAuthorizePost, handleToken } from "./oauth.ts";
import crypto from "node:crypto";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();
});

afterEach(() => {
  clearVaultStoreCache();
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function seedVault(name: string, opts: { isDefault?: boolean } = {}): void {
  const { fullKey, keyId } = generateApiKey();
  writeVaultConfig({
    name,
    api_keys: [
      {
        id: keyId,
        label: "bootstrap",
        scope: "write",
        key_hash: hashKey(fullKey),
        created_at: new Date().toISOString(),
      },
    ],
    created_at: new Date().toISOString(),
  });
  if (opts.isDefault) {
    const gc = readGlobalConfig();
    gc.default_vault = name;
    writeGlobalConfig(gc);
  }
}

/** Mint a fresh OAuth-style token directly into the named vault's DB. */
function mintTokenInVault(vaultName: string): string {
  const store = getVaultStore(vaultName);
  const { fullToken } = generateToken();
  createToken(store.db, fullToken, { label: "test", permission: "full" });
  return fullToken;
}

function bearer(token: string): Request {
  return new Request("https://vault.test/x", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("auth — per-vault routing", () => {
  test("token minted in a vault authenticates at its own /vault/<name>/* endpoints", () => {
    seedVault("journal");
    const token = mintTokenInVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    // /vault/journal/api/* and /vault/journal/mcp both funnel into
    // authenticateVaultRequest with journal's config + DB.
    const vaultAuth = authenticateVaultRequest(bearer(token), journalConfig, journalStore.db);
    expect("error" in vaultAuth).toBe(false);
    if (!("error" in vaultAuth)) expect(vaultAuth.permission).toBe("full");

    // /vaults (global metadata listing) uses authenticateGlobalRequest which
    // scans every vault's DB. Since the token is in journal's DB, it must resolve.
    const global = authenticateGlobalRequest(bearer(token));
    expect("error" in global).toBe(false);
  });

  // HTTP-level routing stand-in. Mirrors routing.ts: every vault-scoped path
  // matches `/vault/<name>/...`, we look the vault up, then authenticate the
  // request against that vault's DB.
  function dispatchAuthFromPath(path: string, req: Request): {
    status: number;
    permission?: string;
  } {
    const match = path.match(/^\/vault\/([^/]+)(\/.*)?$/);
    if (!match) return { status: 404 };
    const vaultName = match[1];
    const vaultConfig = readVaultConfig(vaultName);
    if (!vaultConfig) return { status: 404 };
    const store = getVaultStore(vaultName);
    const res = authenticateVaultRequest(req, vaultConfig, store.db);
    if ("error" in res) return { status: res.error.status };
    return { status: 200, permission: res.permission };
  }

  test("routing: /vault/<name>/api/health accepts a token minted in that vault", () => {
    seedVault("journal");
    const token = mintTokenInVault("journal");

    const result = dispatchAuthFromPath("/vault/journal/api/health", bearer(token));
    expect(result.status).toBe(200);
    expect(result.permission).toBe("full");
  });

  test("routing: /vault/A/api/* rejects a token issued for vault B", () => {
    // The privilege-escalation barrier: a valid token for vault A must not
    // authenticate at vault B's endpoint, even though the token is valid
    // for some vault. This is the point of per-vault DBs.
    seedVault("journal");
    seedVault("work");
    const workToken = mintTokenInVault("work");

    const crossVault = dispatchAuthFromPath("/vault/journal/api/health", bearer(workToken));
    expect(crossVault.status).toBe(401);
  });

  test("routing: /vault/<unknown> returns 404 (not 401)", () => {
    seedVault("journal");
    const token = mintTokenInVault("journal");
    const result = dispatchAuthFromPath("/vault/nonexistent/api/health", bearer(token));
    expect(result.status).toBe(404);
  });
});

describe("auth — cross-vault isolation", () => {
  test("token minted in a non-default vault authenticates via scoped and global paths", () => {
    seedVault("journal", { isDefault: true });
    seedVault("work");
    const workToken = mintTokenInVault("work");
    const workConfig = readVaultConfig("work")!;
    const workStore = getVaultStore("work");

    const scoped = authenticateVaultRequest(bearer(workToken), workConfig, workStore.db);
    expect("error" in scoped).toBe(false);

    // Global auth scans every vault, must find the token in work's DB.
    const global = authenticateGlobalRequest(bearer(workToken));
    expect("error" in global).toBe(false);
  });

  test("a work-vault token does NOT authenticate against the journal vault", () => {
    seedVault("journal", { isDefault: true });
    seedVault("work");
    const workToken = mintTokenInVault("work");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const res = authenticateVaultRequest(bearer(workToken), journalConfig, journalStore.db);
    expect("error" in res).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: OAuth flow → resulting token authenticates against its vault
// ---------------------------------------------------------------------------

describe("OAuth-minted tokens — per-vault coherence", () => {
  // These tests drive the OAuth handlers directly (no HTTP), then take the
  // resulting access_token and verify it resolves at endpoints addressing
  // its issuing vault — and only its issuing vault.

  async function runOAuthFlow(vaultName: string): Promise<string> {
    const store = getVaultStore(vaultName);
    const db = store.db;

    // Seed an owner token so consent passes in legacy-token mode.
    const { fullToken: ownerToken } = generateToken();
    createToken(db, ownerToken, { label: "owner", permission: "full" });

    // 1. Register client
    const regRes = await handleRegister(
      new Request(`https://vault.test/vault/${vaultName}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Daily",
          redirect_uris: ["parachute://oauth/callback"],
        }),
      }),
      db,
    );
    const { client_id } = (await regRes.json()) as { client_id: string };

    // 2. PKCE + authorize
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const authRes = await handleAuthorizePost(
      new Request(`https://vault.test/vault/${vaultName}/oauth/authorize`, {
        method: "POST",
        body: new URLSearchParams({
          action: "authorize",
          client_id,
          redirect_uri: "parachute://oauth/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          scope: "full",
          owner_token: ownerToken,
        }),
      }),
      db,
      { vaultName },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

    // 3. Token exchange
    const tokRes = await handleToken(
      new Request(`https://vault.test/vault/${vaultName}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id,
          redirect_uri: "parachute://oauth/callback",
        }).toString(),
      }),
      db,
      vaultName,
    );
    const tokBody = (await tokRes.json()) as { access_token: string; vault: string };
    expect(tokBody.vault).toBe(vaultName);
    return tokBody.access_token;
  }

  test("OAuth-minted token works at /vault/<name>/api/* and /vault/<name>/mcp", async () => {
    seedVault("journal", { isDefault: true });
    const token = await runOAuthFlow("journal");
    const cfg = readVaultConfig("journal")!;
    const store = getVaultStore("journal");

    // /vault/journal/api/* and /vault/journal/mcp both reach this auth call.
    const vaultAuth = authenticateVaultRequest(bearer(token), cfg, store.db);
    expect("error" in vaultAuth).toBe(false);

    // /vaults (authenticated listing) uses authenticateGlobalRequest.
    const global = authenticateGlobalRequest(bearer(token));
    expect("error" in global).toBe(false);
  });

  test("named-vault OAuth: token works for its vault, rejected by others", async () => {
    seedVault("journal", { isDefault: true });
    seedVault("work");
    const token = await runOAuthFlow("work");
    const workCfg = readVaultConfig("work")!;
    const workStore = getVaultStore("work");

    // Valid at work's own endpoints.
    const scoped = authenticateVaultRequest(bearer(token), workCfg, workStore.db);
    expect("error" in scoped).toBe(false);

    // Global auth finds the token in work's DB.
    const global = authenticateGlobalRequest(bearer(token));
    expect("error" in global).toBe(false);

    // Isolation: the token is NOT usable against the journal vault.
    const journalCfg = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");
    const crossCheck = authenticateVaultRequest(bearer(token), journalCfg, journalStore.db);
    expect("error" in crossCheck).toBe(true);
  });
});
