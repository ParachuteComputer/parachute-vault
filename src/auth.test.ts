/**
 * Auth invariants — routing coherence between unscoped and scoped paths.
 *
 * See Fix 2 in the OAuth-to-Daily launch work: a vault token minted by one
 * path (unscoped `/oauth/token` or scoped `/vaults/X/oauth/token`) must
 * authenticate identically at every endpoint that addresses the same vault,
 * regardless of whether the URL uses `/api/*` (default-vault shortcut) or
 * `/vaults/X/api/*` (explicit). Same for `/mcp` vs `/vaults/X/mcp`.
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
  mkdirSync(join(tmpHome, "vaults"), { recursive: true });
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

describe("auth — default-vault routing coherence", () => {
  test("token minted in default vault authenticates at both unscoped and scoped paths", () => {
    seedVault("default", { isDefault: true });
    const token = mintTokenInVault("default");
    const defaultConfig = readVaultConfig("default")!;
    const defaultStore = getVaultStore("default");

    // Unscoped `/api/*` flow: server resolves default vault, calls
    // authenticateVaultRequest with default's config + DB. Token must resolve.
    const unscoped = authenticateVaultRequest(bearer(token), defaultConfig, defaultStore.db);
    expect("error" in unscoped).toBe(false);
    if (!("error" in unscoped)) expect(unscoped.permission).toBe("full");

    // Scoped `/vaults/default/api/*` flow: same defaultConfig + DB. Must also
    // resolve — this is the invariant Aaron's complaint hinges on.
    const scoped = authenticateVaultRequest(bearer(token), defaultConfig, defaultStore.db);
    expect("error" in scoped).toBe(false);

    // Unified `/mcp` flow: authenticateGlobalRequest scans every vault's DB.
    // Since the token is in default's DB, this must also resolve.
    const global = authenticateGlobalRequest(bearer(token));
    expect("error" in global).toBe(false);
  });

  test("scoped and unscoped auth return the same permission for the same token", () => {
    seedVault("default", { isDefault: true });
    const token = mintTokenInVault("default");
    const cfg = readVaultConfig("default")!;
    const db = getVaultStore("default").db;

    const a = authenticateVaultRequest(bearer(token), cfg, db);
    const b = authenticateVaultRequest(bearer(token), cfg, db);
    const g = authenticateGlobalRequest(bearer(token));
    if ("error" in a || "error" in b || "error" in g) {
      throw new Error("Expected all three to succeed");
    }
    expect(a.permission).toBe(b.permission);
    expect(a.permission).toBe(g.permission);
  });
});

describe("auth — named-vault routing coherence", () => {
  test("token minted in a non-default vault authenticates via scoped and global paths", () => {
    seedVault("default", { isDefault: true });
    seedVault("work");
    const workToken = mintTokenInVault("work");
    const workConfig = readVaultConfig("work")!;
    const workStore = getVaultStore("work");

    // Scoped `/vaults/work/api/*` — must resolve against work's DB.
    const scoped = authenticateVaultRequest(bearer(workToken), workConfig, workStore.db);
    expect("error" in scoped).toBe(false);

    // Unified `/mcp` — global auth scans all vaults, must find it.
    const global = authenticateGlobalRequest(bearer(workToken));
    expect("error" in global).toBe(false);
  });

  test("a work-vault token does NOT authenticate against the default vault's /api/*", () => {
    // This is the correct isolation behavior: a token scoped to vault X has no
    // business being accepted at endpoints that address vault Y. If this ever
    // regressed, we'd have a privilege-escalation bug (read a different vault
    // by just sending a valid token at the wrong URL).
    seedVault("default", { isDefault: true });
    seedVault("work");
    const workToken = mintTokenInVault("work");
    const defaultConfig = readVaultConfig("default")!;
    const defaultStore = getVaultStore("default");

    const res = authenticateVaultRequest(bearer(workToken), defaultConfig, defaultStore.db);
    expect("error" in res).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: OAuth flow → resulting token authenticates at expected paths
// ---------------------------------------------------------------------------

describe("OAuth-minted tokens — cross-endpoint coherence", () => {
  // These tests drive the OAuth handlers directly (no HTTP), then take the
  // resulting access_token and verify it resolves at every endpoint that
  // addresses its issuing vault. This is the key coherence invariant for
  // Aaron's launch complaint.

  async function runOAuthFlow(vaultName: string): Promise<string> {
    const store = getVaultStore(vaultName);
    const db = store.db;

    // Seed an owner token so consent passes in legacy-token mode.
    const { fullToken: ownerToken } = generateToken();
    createToken(db, ownerToken, { label: "owner", permission: "full" });

    // 1. Register client
    const regRes = await handleRegister(
      new Request("https://vault.test/oauth/register", {
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
      new Request("https://vault.test/oauth/authorize", {
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
      new Request("https://vault.test/oauth/token", {
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

  test("default-vault OAuth: token works at /api/*, /mcp, /vaults/default/api/*, /vaults/default/mcp", async () => {
    seedVault("default", { isDefault: true });
    const token = await runOAuthFlow("default");
    const cfg = readVaultConfig("default")!;
    const store = getVaultStore("default");

    // `/api/*` — unscoped path resolves default vault, calls authenticateVaultRequest.
    const apiUnscoped = authenticateVaultRequest(bearer(token), cfg, store.db);
    expect("error" in apiUnscoped).toBe(false);

    // `/vaults/default/api/*` — scoped path resolves same default, same DB, same call.
    const apiScoped = authenticateVaultRequest(bearer(token), cfg, store.db);
    expect("error" in apiScoped).toBe(false);

    // `/mcp` — unified endpoint uses authenticateGlobalRequest which scans all DBs.
    const mcpUnscoped = authenticateGlobalRequest(bearer(token));
    expect("error" in mcpUnscoped).toBe(false);

    // `/vaults/default/mcp` — scoped MCP uses authenticateVaultRequest (same as api).
    const mcpScoped = authenticateVaultRequest(bearer(token), cfg, store.db);
    expect("error" in mcpScoped).toBe(false);
  });

  test("named-vault OAuth: token works at /vaults/X/api/*, /vaults/X/mcp, /mcp", async () => {
    seedVault("default", { isDefault: true });
    seedVault("work");
    const token = await runOAuthFlow("work");
    const workCfg = readVaultConfig("work")!;
    const workStore = getVaultStore("work");

    // Scoped endpoints addressing vault work — must resolve.
    const apiScoped = authenticateVaultRequest(bearer(token), workCfg, workStore.db);
    expect("error" in apiScoped).toBe(false);

    // Unified /mcp scans all vaults, must find the token in work's DB.
    const mcpUnified = authenticateGlobalRequest(bearer(token));
    expect("error" in mcpUnified).toBe(false);

    // Defensive: the same token is NOT usable against the default vault's /api/*.
    const defaultCfg = readVaultConfig("default")!;
    const defaultStore = getVaultStore("default");
    const crossCheck = authenticateVaultRequest(bearer(token), defaultCfg, defaultStore.db);
    expect("error" in crossCheck).toBe(true);
  });
});
