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
  test("token minted in a vault authenticates at its own /vault/<name>/* endpoints", async () => {
    seedVault("journal");
    const token = mintTokenInVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    // /vault/journal/api/* and /vault/journal/mcp both funnel into
    // authenticateVaultRequest with journal's config + DB.
    const vaultAuth = await authenticateVaultRequest(bearer(token), journalConfig, journalStore.db);
    expect("error" in vaultAuth).toBe(false);
    if (!("error" in vaultAuth)) expect(vaultAuth.permission).toBe("full");

    // /vaults (global metadata listing) uses authenticateGlobalRequest which
    // scans every vault's DB. Since the token is in journal's DB, it must resolve.
    const global = await authenticateGlobalRequest(bearer(token));
    expect("error" in global).toBe(false);
  });

  // HTTP-level routing stand-in. Mirrors routing.ts: every vault-scoped path
  // matches `/vault/<name>/...`, we look the vault up, then authenticate the
  // request against that vault's DB.
  async function dispatchAuthFromPath(path: string, req: Request): Promise<{
    status: number;
    permission?: string;
  }> {
    const match = path.match(/^\/vault\/([^/]+)(\/.*)?$/);
    if (!match) return { status: 404 };
    const vaultName = match[1]!;
    const vaultConfig = readVaultConfig(vaultName);
    if (!vaultConfig) return { status: 404 };
    const store = getVaultStore(vaultName);
    const res = await authenticateVaultRequest(req, vaultConfig, store.db);
    if ("error" in res) return { status: res.error.status };
    return { status: 200, permission: res.permission };
  }

  test("routing: /vault/<name>/api/health accepts a token minted in that vault", async () => {
    seedVault("journal");
    const token = mintTokenInVault("journal");

    const result = await dispatchAuthFromPath("/vault/journal/api/health", bearer(token));
    expect(result.status).toBe(200);
    expect(result.permission).toBe("full");
  });

  test("routing: /vault/A/api/* rejects a token issued for vault B", async () => {
    // The privilege-escalation barrier: a valid token for vault A must not
    // authenticate at vault B's endpoint, even though the token is valid
    // for some vault. This is the point of per-vault DBs.
    seedVault("journal");
    seedVault("work");
    const workToken = mintTokenInVault("work");

    const crossVault = await dispatchAuthFromPath("/vault/journal/api/health", bearer(workToken));
    expect(crossVault.status).toBe(401);
  });

  test("routing: /vault/<unknown> returns 404 (not 401)", async () => {
    seedVault("journal");
    const token = mintTokenInVault("journal");
    const result = await dispatchAuthFromPath("/vault/nonexistent/api/health", bearer(token));
    expect(result.status).toBe(404);
  });
});

describe("auth — cross-vault isolation", () => {
  test("token minted in a non-default vault authenticates via scoped and global paths", async () => {
    seedVault("journal", { isDefault: true });
    seedVault("work");
    const workToken = mintTokenInVault("work");
    const workConfig = readVaultConfig("work")!;
    const workStore = getVaultStore("work");

    const scoped = await authenticateVaultRequest(bearer(workToken), workConfig, workStore.db);
    expect("error" in scoped).toBe(false);

    // Global auth scans every vault, must find the token in work's DB.
    const global = await authenticateGlobalRequest(bearer(workToken));
    expect("error" in global).toBe(false);
  });

  test("a work-vault token does NOT authenticate against the journal vault", async () => {
    seedVault("journal", { isDefault: true });
    seedVault("work");
    const workToken = mintTokenInVault("work");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const res = await authenticateVaultRequest(bearer(workToken), journalConfig, journalStore.db);
    expect("error" in res).toBe(true);
  });

  test("v16 vault_name binding rejects with 403 when the row is cross-vault", async () => {
    // Per-vault DB scoping is the first line of defense (a token only
    // resolves against the DB it was minted in). The v16 vault_name column
    // is defense-in-depth: if a token row somehow lives in vault A's DB
    // but its vault_name says "B" (e.g. an out-of-band copy, or a future
    // mistake in the mint path), the binding mismatch must reject. We
    // simulate that by minting into journal's DB with vault_name="work".
    seedVault("journal", { isDefault: true });
    seedVault("work");
    const journalStore = getVaultStore("journal");
    const { fullToken } = generateToken();
    createToken(journalStore.db, fullToken, {
      label: "mis-bound",
      permission: "full",
      vault_name: "work",
    });
    const journalConfig = readVaultConfig("journal")!;

    const res = await authenticateVaultRequest(bearer(fullToken), journalConfig, journalStore.db);
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error.status).toBe(403);
    }
  });

  test("v16 vault_name binding accepts when token is bound to the requested vault", async () => {
    seedVault("work");
    const workStore = getVaultStore("work");
    const { fullToken } = generateToken();
    createToken(workStore.db, fullToken, {
      label: "bound",
      permission: "full",
      vault_name: "work",
    });
    const workConfig = readVaultConfig("work")!;

    const res = await authenticateVaultRequest(bearer(fullToken), workConfig, workStore.db);
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.vault_name).toBe("work");
    }
  });

  test("legacy NULL-bound tokens still authenticate against any vault", async () => {
    // Backwards compatibility: pre-v16 tokens (and legacy YAML keys, and
    // hub JWTs) all carry vault_name = null. They keep working at any
    // vault — the migration is lenient by design.
    seedVault("work");
    const workToken = mintTokenInVault("work");
    const workConfig = readVaultConfig("work")!;
    const workStore = getVaultStore("work");

    const res = await authenticateVaultRequest(bearer(workToken), workConfig, workStore.db);
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.vault_name).toBeNull();
    }
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
    const vaultAuth = await authenticateVaultRequest(bearer(token), cfg, store.db);
    expect("error" in vaultAuth).toBe(false);

    // /vaults (authenticated listing) uses authenticateGlobalRequest.
    const global = await authenticateGlobalRequest(bearer(token));
    expect("error" in global).toBe(false);
  });

  test("named-vault OAuth: token works for its vault, rejected by others", async () => {
    seedVault("journal", { isDefault: true });
    seedVault("work");
    const token = await runOAuthFlow("work");
    const workCfg = readVaultConfig("work")!;
    const workStore = getVaultStore("work");

    // Valid at work's own endpoints.
    const scoped = await authenticateVaultRequest(bearer(token), workCfg, workStore.db);
    expect("error" in scoped).toBe(false);

    // Global auth finds the token in work's DB.
    const global = await authenticateGlobalRequest(bearer(token));
    expect("error" in global).toBe(false);

    // Isolation: the token is NOT usable against the journal vault.
    const journalCfg = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");
    const crossCheck = await authenticateVaultRequest(bearer(token), journalCfg, journalStore.db);
    expect("error" in crossCheck).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy YAML global keys — scope must round-trip through the parser
// ---------------------------------------------------------------------------

describe("auth — legacy global YAML keys honor declared scope", () => {
  test("scope: read on a global config.yaml key resolves to read permission, not full", async () => {
    // Regression: the global parser used to drop the `scope` field, leaving
    // `globalKey.scope` undefined. The auth check `=== "read"` then resolved
    // any undefined value to "full", silently escalating read-only keys.
    const { fullKey, keyId } = generateApiKey();
    writeGlobalConfig({
      port: 1940,
      api_keys: [
        {
          id: keyId,
          label: "reader",
          scope: "read",
          key_hash: hashKey(fullKey),
          created_at: new Date().toISOString(),
        },
      ],
    });

    const result = await authenticateGlobalRequest(bearer(fullKey));
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("read");
    }
  });

  test("scope: write on a global config.yaml key resolves to full permission", async () => {
    const { fullKey, keyId } = generateApiKey();
    writeGlobalConfig({
      port: 1940,
      api_keys: [
        {
          id: keyId,
          label: "writer",
          scope: "write",
          key_hash: hashKey(fullKey),
          created_at: new Date().toISOString(),
        },
      ],
    });

    const result = await authenticateGlobalRequest(bearer(fullKey));
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("full");
    }
  });
});

// ---------------------------------------------------------------------------
// VAULT_AUTH_TOKEN — server-wide operator bearer (vault#339)
//
// The container-shape auth gate. When the env var is set, a request whose
// `Authorization: Bearer <value>` matches authenticates as full/admin
// against any vault on the server — the operator-channel path for sibling
// services on Render where vault and hub run as separate containers and
// hub needs a stable shared bearer to call vault.
//
// Semantic confirmed for the loopback/non-loopback split (auth gate is
// orthogonal to socket-level loopback): when VAULT_AUTH_TOKEN is unset,
// vault's existing token surface (per-vault DB tokens + hub JWTs + legacy
// YAML keys) is the ONLY auth surface. The bind socket defaults to
// 127.0.0.1 (`VAULT_BIND` in bind.ts), but no implicit loopback trust
// exists at the auth layer — a request from 127.0.0.1 still has to
// present a valid bearer. This matches docs/auth-model.md §1.
// ---------------------------------------------------------------------------

describe("auth — VAULT_AUTH_TOKEN server-wide operator bearer", () => {
  const TOKEN = "test-operator-token-deadbeef0123456789abcdef";
  let prevToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env.VAULT_AUTH_TOKEN;
  });

  afterEach(() => {
    if (prevToken === undefined) delete process.env.VAULT_AUTH_TOKEN;
    else process.env.VAULT_AUTH_TOKEN = prevToken;
  });

  test("env set + matching bearer → 200 on vault auth, full permission, admin scopes", async () => {
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const result = await authenticateVaultRequest(
      bearer(TOKEN),
      journalConfig,
      journalStore.db,
    );

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("full");
      expect(result.scopes).toContain("vault:admin");
      expect(result.legacyDerived).toBe(false);
      expect(result.scoped_tags).toBeNull();
    }
  });

  test("env set + matching bearer authenticates against ANY vault on the server", async () => {
    // Server-wide → not tied to any one vault's DB. Same bearer works
    // for journal and work without minting a per-vault token in either.
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");
    seedVault("work");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");
    const workConfig = readVaultConfig("work")!;
    const workStore = getVaultStore("work");

    const j = await authenticateVaultRequest(bearer(TOKEN), journalConfig, journalStore.db);
    const w = await authenticateVaultRequest(bearer(TOKEN), workConfig, workStore.db);

    expect("error" in j).toBe(false);
    expect("error" in w).toBe(false);
  });

  test("env set + missing bearer → 401 (no implicit auth)", async () => {
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    // No Authorization header at all.
    const noBearer = new Request("https://vault.test/x");
    const result = await authenticateVaultRequest(noBearer, journalConfig, journalStore.db);

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test("env set + wrong bearer → 401", async () => {
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const result = await authenticateVaultRequest(
      bearer("wrong-token-doesnotmatch"),
      journalConfig,
      journalStore.db,
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test("env set + bearer that matches a vault token still resolves (server-wide first, but per-vault unchanged)", async () => {
    // Per-vault tokens keep working even when the server-wide bearer is
    // set. The server-wide check is a fast-path lookup before token DB
    // resolution — a per-vault token doesn't match the env var so it
    // falls through to the existing path.
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");
    const perVaultToken = mintTokenInVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const result = await authenticateVaultRequest(
      bearer(perVaultToken),
      journalConfig,
      journalStore.db,
    );

    expect("error" in result).toBe(false);
  });

  test("env unset + valid per-vault bearer → 200 (existing behavior preserved)", async () => {
    delete process.env.VAULT_AUTH_TOKEN;
    seedVault("journal");
    const token = mintTokenInVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const result = await authenticateVaultRequest(bearer(token), journalConfig, journalStore.db);
    expect("error" in result).toBe(false);
  });

  test("env unset + missing bearer → 401 (existing behavior preserved)", async () => {
    delete process.env.VAULT_AUTH_TOKEN;
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const noBearer = new Request("https://vault.test/x");
    const result = await authenticateVaultRequest(noBearer, journalConfig, journalStore.db);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test("env unset + non-loopback simulated via X-Forwarded-For → still 401 without bearer", async () => {
    // Doc note: vault has NO implicit loopback trust at the auth layer.
    // The X-Forwarded-For shape (set by hub / Cloudflare Tunnel / etc.)
    // doesn't affect the auth gate; tokens are required regardless of
    // socket origin. The `bind.ts` 127.0.0.1 default is a socket-level
    // listen-restriction, not a trust-asymmetric auth bypass.
    delete process.env.VAULT_AUTH_TOKEN;
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const remote = new Request("https://vault.test/x", {
      headers: { "X-Forwarded-For": "203.0.113.7" },
    });
    const result = await authenticateVaultRequest(remote, journalConfig, journalStore.db);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test("env set with whitespace-only value → treated as unset", async () => {
    process.env.VAULT_AUTH_TOKEN = "   ";
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    // An empty/whitespace VAULT_AUTH_TOKEN must NOT allow any bearer to
    // pass — the operator either commits to bearer auth or doesn't.
    const result = await authenticateVaultRequest(
      bearer(""),
      journalConfig,
      journalStore.db,
    );
    expect("error" in result).toBe(true);
  });

  test("env set + matching bearer also works on the global auth surface", async () => {
    // /vaults metadata listing + /health vault names go through
    // authenticateGlobalRequest. The server-wide bearer must work there
    // too — otherwise hub couldn't enumerate vaults using the operator
    // channel.
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");

    const result = await authenticateGlobalRequest(bearer(TOKEN));
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("full");
    }
  });

  test("env set + wrong bearer on global auth surface → 401", async () => {
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");

    const result = await authenticateGlobalRequest(bearer("wrong-token"));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test("near-miss bearer (one-char difference, same length) → 401 (constant-time compare)", async () => {
    // Defensive: the server-wide compare uses crypto.timingSafeEqual so
    // a one-char-off bearer that matches length-wise still rejects.
    // We can't measure timing in a unit test, but we can pin the
    // correctness side: a same-length near-miss must still reject.
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const nearMiss = TOKEN.slice(0, -1) + "x";
    expect(nearMiss).not.toBe(TOKEN);
    expect(nearMiss.length).toBe(TOKEN.length);

    const result = await authenticateVaultRequest(
      bearer(nearMiss),
      journalConfig,
      journalStore.db,
    );
    expect("error" in result).toBe(true);
  });
});
