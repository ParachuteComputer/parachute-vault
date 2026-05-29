/**
 * Auth invariants — vault as a pure hub resource-server (vault#282 Stage 2).
 *
 * The `pvt_*` opaque vault-DB token was dropped at 0.6.0: vault no longer
 * mints or validates it. The surviving auth surfaces tested here are:
 *   - VAULT_AUTH_TOKEN — the server-wide operator bearer.
 *   - Legacy YAML api_keys (vault.yaml / config.yaml) — hashed keys.
 *   - The fail-closed guarantee: a `pvt_`-prefixed bearer is now 401-rejected
 *     on both the per-vault and global auth surfaces (it's unvalidatable).
 *
 * Hub-JWT auth + its per-vault audience isolation is covered end-to-end in
 * `auth-hub-jwt.test.ts`. These tests isolate `PARACHUTE_HOME` so they don't
 * touch the user's real config.
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
import { authenticateVaultRequest, authenticateGlobalRequest } from "./auth.ts";

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

function bearer(token: string): Request {
  return new Request("https://vault.test/x", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// pvt_* fail-closed regression (vault#282 Stage 2)
//
// The DROP's load-bearing safety property: a pvt_*-prefixed bearer is no
// longer validatable. It isn't JWT-shaped (skips authenticateHubJwt), matches
// no YAML key_hash, and doesn't match VAULT_AUTH_TOKEN — so it falls through
// to a 401 on BOTH the per-vault and global surfaces. This proves pvt_* can't
// authenticate post-DROP.
// ---------------------------------------------------------------------------

describe("auth — pvt_* tokens are unvalidatable (fail closed)", () => {
  const PVT = "pvt_deadbeefdeadbeefdeadbeefdeadbeef";

  // The pointed message a pvt_*-shaped bearer gets (vs the generic "Invalid
  // API key" a non-pvt_ bad token gets) — the prefix is the user-meaningful
  // signal that the mechanism was dropped, not that the key was mistyped.
  const PVT_MESSAGE =
    "pvt_* tokens are no longer supported (vault 0.6.0). Re-add this vault via your hub to get an access token.";

  test("a pvt_* bearer is 401-rejected with the dropped-token message on the per-vault surface", async () => {
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;

    const result = await authenticateVaultRequest(bearer(PVT), journalConfig);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      const body = (await result.error.json()) as { error: string; message: string };
      expect(body.error).toBe("Unauthorized");
      expect(body.message).toBe(PVT_MESSAGE);
    }
  });

  test("a pvt_* bearer is 401-rejected with the dropped-token message on the global (/vaults) surface", async () => {
    seedVault("journal", { isDefault: true });
    seedVault("work");

    const result = await authenticateGlobalRequest(bearer(PVT));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      const body = (await result.error.json()) as { error: string; message: string };
      expect(body.error).toBe("Unauthorized");
      expect(body.message).toBe(PVT_MESSAGE);
    }
  });

  test("a pvt_* bearer is rejected even when VAULT_AUTH_TOKEN is set (no fall-through accept)", async () => {
    const prev = process.env.VAULT_AUTH_TOKEN;
    process.env.VAULT_AUTH_TOKEN = "operator-bearer-not-the-pvt-token";
    try {
      seedVault("journal");
      const journalConfig = readVaultConfig("journal")!;
      const result = await authenticateVaultRequest(bearer(PVT), journalConfig);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error.status).toBe(401);
        const body = (await result.error.json()) as { message: string };
        expect(body.message).toBe(PVT_MESSAGE);
      }
    } finally {
      if (prev === undefined) delete process.env.VAULT_AUTH_TOKEN;
      else process.env.VAULT_AUTH_TOKEN = prev;
    }
  });

  test("a non-pvt_ invalid bearer keeps the generic message (no behavior change)", async () => {
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;

    const result = await authenticateVaultRequest(bearer("notavalidkey123"), journalConfig);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      const body = (await result.error.json()) as { message: string };
      expect(body.message).toBe("Invalid API key");
    }
  });

  test("/vault/<unknown> still 404s before auth (routing precedence unchanged)", async () => {
    // HTTP-level routing stand-in mirroring routing.ts: an unknown vault is a
    // 404 (the vault config lookup fails) before any bearer is evaluated.
    seedVault("journal");
    const match = "/vault/nonexistent/api/health".match(/^\/vault\/([^/]+)(\/.*)?$/);
    const vaultName = match![1]!;
    expect(readVaultConfig(vaultName)).toBeNull();
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

  test("a per-vault YAML api_key authenticates at its vault and reports read scope", async () => {
    // The surviving legacy per-vault path: vault.yaml api_keys. seedVault
    // writes a `scope: write` key, so we mint a read one here explicitly.
    const { fullKey, keyId } = generateApiKey();
    writeVaultConfig({
      name: "journal",
      api_keys: [
        {
          id: keyId,
          label: "reader",
          scope: "read",
          key_hash: hashKey(fullKey),
          created_at: new Date().toISOString(),
        },
      ],
      created_at: new Date().toISOString(),
    });
    const journalConfig = readVaultConfig("journal")!;

    const result = await authenticateVaultRequest(bearer(fullKey), journalConfig);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("read");
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
// vault's surviving token surface (hub JWTs + legacy YAML keys) is the ONLY
// auth surface. The bind socket defaults to 127.0.0.1 (`VAULT_BIND` in
// bind.ts), but no implicit loopback trust exists at the auth layer — a
// request from 127.0.0.1 still has to present a valid bearer. This matches
// docs/auth-model.md §1.
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

    const result = await authenticateVaultRequest(bearer(TOKEN), journalConfig);

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("full");
      expect(result.scopes).toContain("vault:admin");
      expect(result.legacyDerived).toBe(false);
      expect(result.scoped_tags).toBeNull();
    }
  });

  test("env set + matching bearer authenticates against ANY vault on the server", async () => {
    // Server-wide → not tied to any one vault. Same bearer works for journal
    // and work without any per-vault credential in either.
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");
    seedVault("work");
    const journalConfig = readVaultConfig("journal")!;
    const workConfig = readVaultConfig("work")!;

    const j = await authenticateVaultRequest(bearer(TOKEN), journalConfig);
    const w = await authenticateVaultRequest(bearer(TOKEN), workConfig);

    expect("error" in j).toBe(false);
    expect("error" in w).toBe(false);
  });

  test("env set + missing bearer → 401 (no implicit auth)", async () => {
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;

    // No Authorization header at all.
    const noBearer = new Request("https://vault.test/x");
    const result = await authenticateVaultRequest(noBearer, journalConfig);

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test("env set + wrong bearer → 401", async () => {
    process.env.VAULT_AUTH_TOKEN = TOKEN;
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;

    const result = await authenticateVaultRequest(bearer("wrong-token-doesnotmatch"), journalConfig);

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test("env unset + valid per-vault YAML bearer → 200 (existing behavior preserved)", async () => {
    delete process.env.VAULT_AUTH_TOKEN;
    const { fullKey, keyId } = generateApiKey();
    writeVaultConfig({
      name: "journal",
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
    const journalConfig = readVaultConfig("journal")!;

    const result = await authenticateVaultRequest(bearer(fullKey), journalConfig);
    expect("error" in result).toBe(false);
  });

  test("env unset + missing bearer → 401 (existing behavior preserved)", async () => {
    delete process.env.VAULT_AUTH_TOKEN;
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;

    const noBearer = new Request("https://vault.test/x");
    const result = await authenticateVaultRequest(noBearer, journalConfig);
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

    const remote = new Request("https://vault.test/x", {
      headers: { "X-Forwarded-For": "203.0.113.7" },
    });
    const result = await authenticateVaultRequest(remote, journalConfig);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test("env set with whitespace-only value → treated as unset", async () => {
    process.env.VAULT_AUTH_TOKEN = "   ";
    seedVault("journal");
    const journalConfig = readVaultConfig("journal")!;

    // An empty/whitespace VAULT_AUTH_TOKEN must NOT allow any bearer to
    // pass — the operator either commits to bearer auth or doesn't.
    const result = await authenticateVaultRequest(bearer(""), journalConfig);
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

    const nearMiss = TOKEN.slice(0, -1) + "x";
    expect(nearMiss).not.toBe(TOKEN);
    expect(nearMiss.length).toBe(TOKEN.length);

    const result = await authenticateVaultRequest(bearer(nearMiss), journalConfig);
    expect("error" in result).toBe(true);
  });
});
