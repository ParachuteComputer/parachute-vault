/**
 * Runtime trigger-registration API (frictionless-channel-setup PR 1).
 *
 * Covers:
 *  - CRUD over the REST surface (POST creates+persists+lists, DELETE removes,
 *    POST same name replaces).
 *  - Persistence across restart (loadAllTriggers → re-register → still fires).
 *  - Per-vault firing isolation (a trigger for vault A does NOT fire on a
 *    vault-B note event) — the load-bearing test.
 *  - JWT webhook auth (action.auth.bearer → Authorization: Bearer header).
 *  - Admin-scope enforcement (read/write token → 403, admin → 200).
 *  - Live registration (POST then a matching note fires WITHOUT a restart).
 *
 * Uses PARACHUTE_HOME override + a real hub-JWT mint fixture (JWKS server) so
 * the admin-scope path exercises the surviving credential shape end-to-end,
 * mirroring routing.test.ts.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const testDir = join(
  tmpdir(),
  `vault-triggers-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.PARACHUTE_HOME = testDir;

const { route } = await import("./routing.ts");
const { writeGlobalConfig, writeVaultConfig } = await import("./config.ts");
const { clearVaultStoreCache, getVaultStore, defaultHookRegistry } = await import("./vault-store.ts");
const {
  loadVaultTriggers,
  registerLiveTrigger,
  clearLiveTriggers,
} = await import("./triggers-api.ts");
const { registerTriggers } = await import("./triggers.ts");
const { listTriggers, getTrigger } = await import("../core/src/triggers-store.ts");
const { resetJwksCache, resetRevocationCache } = await import("./hub-jwt.ts");

// ---------------------------------------------------------------------------
// Hub-JWT fixture (same shape as routing.test.ts).
// ---------------------------------------------------------------------------

let hubServer: ReturnType<typeof Bun.serve>;
let signingKey: CryptoKey;
let publicJwk: Record<string, unknown>;
let hubFixtureOrigin = "";
const KID = "triggers-api-test-k1";

async function mintJwt(vaultName: string, scopes: string[]): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return await new SignJWT({ scope: scopes.join(" "), client_id: "triggers-api-test" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(hubServer ? `http://127.0.0.1:${hubServer.port}` : "")
    .setSubject("triggers-api-test-user")
    .setAudience(`vault.${vaultName}`)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .setJti(`jti-${Math.random().toString(36).slice(2)}`)
    .sign(signingKey);
}

function adminToken(vaultName: string) {
  return mintJwt(vaultName, [`vault:${vaultName}:admin`]);
}

function createVault(name: string): void {
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// A local webhook receiver — records every hit (and its Authorization header).
// ---------------------------------------------------------------------------

interface WebhookHit {
  url: string;
  auth: string | null;
  body: unknown;
}

let webhookServer: ReturnType<typeof Bun.serve>;
let hits: WebhookHit[] = [];
let webhookBase = "";

/** Await pending hook handlers: flush the queued microtask, then drain. */
async function settleHooks(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await defaultHookRegistry.drain();
}

function reset(): void {
  clearLiveTriggers();
  defaultHookRegistry.clear();
  clearVaultStoreCache();
  hits = [];
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "vault", "data"), { recursive: true });
  writeGlobalConfig({ port: 1940 });
  if (hubFixtureOrigin) {
    process.env.PARACHUTE_HUB_ORIGIN = hubFixtureOrigin;
    process.env.PARACHUTE_HUB_JWKS_ORIGIN = hubFixtureOrigin;
  }
  resetJwksCache();
  resetRevocationCache();
}

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  signingKey = privateKey;
  const jwk = await exportJWK(publicKey);
  publicJwk = { kty: "RSA", n: jwk.n, e: jwk.e, kid: KID, alg: "RS256", use: "sig" };
  hubServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [publicJwk] });
      if (url.pathname === "/.well-known/parachute-revocation.json") {
        return Response.json({ generated_at: new Date().toISOString(), jtis: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  hubFixtureOrigin = `http://127.0.0.1:${hubServer.port}`;

  webhookServer = Bun.serve({
    port: 0,
    async fetch(req) {
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      hits.push({
        url: req.url,
        auth: req.headers.get("authorization"),
        body,
      });
      // Standard json webhook response — no content/metadata mutation needed.
      return Response.json({});
    },
  });
  webhookBase = `http://127.0.0.1:${webhookServer.port}`;
});

beforeEach(() => {
  reset();
});

afterEach(() => {
  clearLiveTriggers();
  defaultHookRegistry.clear();
});

afterAll(() => {
  clearVaultStoreCache();
  hubServer?.stop(true);
  webhookServer?.stop(true);
  delete process.env.PARACHUTE_HUB_ORIGIN;
  delete process.env.PARACHUTE_HUB_JWKS_ORIGIN;
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

function triggerBody(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    events: ["created", "updated"],
    when: { tags: ["channel-message"] },
    action: { webhook: `${webhookBase}/hook`, ...extra },
  };
}

async function post(vault: string, token: string, body: unknown): Promise<Response> {
  const path = `/vault/${vault}/api/triggers`;
  return route(
    new Request(`http://localhost:1940${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    path,
  );
}

async function get(vault: string, token: string): Promise<Response> {
  const path = `/vault/${vault}/api/triggers`;
  return route(
    new Request(`http://localhost:1940${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    path,
  );
}

async function getOne(vault: string, token: string, name: string): Promise<Response> {
  const path = `/vault/${vault}/api/triggers/${name}`;
  return route(
    new Request(`http://localhost:1940${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    path,
  );
}

async function del(vault: string, token: string, name: string): Promise<Response> {
  const path = `/vault/${vault}/api/triggers/${name}`;
  return route(
    new Request(`http://localhost:1940${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
    path,
  );
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe("triggers REST CRUD", () => {
  test("POST creates + persists + lists", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");

    const res = await post("alpha", token, triggerBody("inbound"));
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.trigger.name).toBe("inbound");
    expect(created.trigger.created_at).toBeTruthy();

    // Persisted to the table.
    const rows = listTriggers(getVaultStore("alpha").db);
    expect(rows.map((r) => r.name)).toEqual(["inbound"]);

    // Listed via GET.
    const listRes = await get("alpha", token);
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.triggers.map((t: { name: string }) => t.name)).toEqual(["inbound"]);
  });

  test("DELETE removes the row + 404 on a missing name", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    await post("alpha", token, triggerBody("inbound"));

    const res = await del("alpha", token, "inbound");
    expect(res.status).toBe(200);
    expect(listTriggers(getVaultStore("alpha").db)).toHaveLength(0);

    const missing = await del("alpha", token, "inbound");
    expect(missing.status).toBe(404);
  });

  test("POST with the same name replaces (upsert by name)", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");

    await post("alpha", token, triggerBody("inbound", { timeout: 1000 }));
    await post("alpha", token, triggerBody("inbound", { timeout: 5000 }));

    const rows = listTriggers(getVaultStore("alpha").db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action.timeout).toBe(5000);
  });

  test("POST with an invalid webhook URL → 400", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    const res = await post("alpha", token, {
      name: "bad",
      when: { tags: ["x"] },
      action: { webhook: "ftp://nope" },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Admin-scope enforcement
// ---------------------------------------------------------------------------

describe("triggers admin-scope", () => {
  test("read token → 403", async () => {
    createVault("alpha");
    const readTok = await mintJwt("alpha", ["vault:alpha:read"]);
    const res = await get("alpha", readTok);
    expect(res.status).toBe(403);
  });

  test("write token → 403 on POST", async () => {
    createVault("alpha");
    const writeTok = await mintJwt("alpha", ["vault:alpha:write"]);
    const res = await post("alpha", writeTok, triggerBody("inbound"));
    expect(res.status).toBe(403);
  });

  test("admin token → 200", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    const res = await post("alpha", token, triggerBody("inbound"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Live registration (no restart) + JWT webhook auth
// ---------------------------------------------------------------------------

describe("triggers live registration", () => {
  test("POST then a matching note fires the webhook WITHOUT a restart", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    await post("alpha", token, triggerBody("inbound"));

    const store = getVaultStore("alpha");
    await store.createNote("hello from alpha", { tags: ["channel-message"] });
    await settleHooks();

    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toContain("/hook");
  });

  test("action.auth.bearer → Authorization: Bearer on the fired request", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    await post("alpha", token, triggerBody("inbound", { auth: { bearer: "hub-jwt-xyz" } }));

    const store = getVaultStore("alpha");
    await store.createNote("ping", { tags: ["channel-message"] });
    await settleHooks();

    expect(hits).toHaveLength(1);
    expect(hits[0]!.auth).toBe("Bearer hub-jwt-xyz");
  });
});

// ---------------------------------------------------------------------------
// Secret redaction on read (M1) — action.auth.bearer is one-way: never
// readable back over GET, but the live fire still carries the real token.
// ---------------------------------------------------------------------------

describe("triggers webhook-auth redaction", () => {
  test("GET list redacts action.auth.bearer; DB keeps the real value", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    await post("alpha", token, triggerBody("inbound", { auth: { bearer: "super-secret-jwt" } }));

    const res = await get("alpha", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.triggers).toHaveLength(1);
    // Key present (auth IS configured) but value redacted.
    expect(body.triggers[0].action.auth.bearer).toBe("[REDACTED]");

    // The stored row keeps the real bearer — redaction is response-only.
    expect(getTrigger(getVaultStore("alpha").db, "inbound")!.action.auth!.bearer).toBe(
      "super-secret-jwt",
    );
  });

  test("GET :name redacts action.auth.bearer", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    await post("alpha", token, triggerBody("inbound", { auth: { bearer: "super-secret-jwt" } }));

    const res = await getOne("alpha", token, "inbound");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trigger.action.auth.bearer).toBe("[REDACTED]");
  });

  test("POST response echoes a redacted bearer (does not re-expose the input)", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    const res = await post("alpha", token, triggerBody("inbound", { auth: { bearer: "secret" } }));
    const body = await res.json();
    expect(body.trigger.action.auth.bearer).toBe("[REDACTED]");
  });

  test("redaction is response-only — the live webhook still fires with the REAL bearer", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    await post("alpha", token, triggerBody("inbound", { auth: { bearer: "the-real-token" } }));

    // Read it back over GET (redacted) — must NOT change the fire behavior.
    await get("alpha", token);
    await getOne("alpha", token, "inbound");

    await getVaultStore("alpha").createNote("fire", { tags: ["channel-message"] });
    await settleHooks();

    expect(hits).toHaveLength(1);
    expect(hits[0]!.auth).toBe("Bearer the-real-token");
  });

  test("a trigger WITHOUT auth lists with no auth key (no spurious [REDACTED])", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    await post("alpha", token, triggerBody("inbound"));
    const body = await (await get("alpha", token)).json();
    expect(body.triggers[0].action.auth).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// action.auth.bearer input validation (M2)
// ---------------------------------------------------------------------------

describe("triggers auth.bearer validation", () => {
  test("POST with auth.bearer = 42 → 400", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    const res = await post("alpha", token, triggerBody("bad", { auth: { bearer: 42 } }));
    expect(res.status).toBe(400);
  });

  test("POST with auth.bearer = {} → 400", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    const res = await post("alpha", token, triggerBody("bad", { auth: { bearer: {} } }));
    expect(res.status).toBe(400);
  });

  test("POST with auth.bearer = '' (empty) → 400", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    const res = await post("alpha", token, triggerBody("bad", { auth: { bearer: "" } }));
    expect(res.status).toBe(400);
  });

  test("POST with a valid string bearer → 200", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    const res = await post("alpha", token, triggerBody("ok", { auth: { bearer: "jwt" } }));
    expect(res.status).toBe(200);
  });

  test("POST with empty auth object ({}) → 200 (no bearer to validate)", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    const res = await post("alpha", token, triggerBody("ok2", { auth: {} }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Persistence across restart
// ---------------------------------------------------------------------------

describe("triggers persistence across restart", () => {
  test("loadVaultTriggers re-registers a persisted trigger so it fires again", async () => {
    createVault("alpha");
    const token = await adminToken("alpha");
    await post("alpha", token, triggerBody("inbound"));

    // Simulate a restart: drop every live hook + the store cache, then
    // re-load from the table (the boot path).
    clearLiveTriggers();
    defaultHookRegistry.clear();
    clearVaultStoreCache();

    const store = getVaultStore("alpha");
    const n = loadVaultTriggers("alpha", store);
    expect(n).toBe(1);

    await store.createNote("after restart", { tags: ["channel-message"] });
    await settleHooks();

    expect(hits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Per-vault firing isolation — the load-bearing test
// ---------------------------------------------------------------------------

describe("triggers per-vault firing isolation", () => {
  test("a trigger registered for vault A does NOT fire on a vault-B note event", async () => {
    createVault("alpha");
    createVault("beta");

    // Register the trigger for ALPHA only.
    const alphaTok = await adminToken("alpha");
    await post("alpha", alphaTok, triggerBody("inbound"));

    // A matching note in BETA must NOT fire the webhook.
    const betaStore = getVaultStore("beta");
    await betaStore.createNote("from beta", { tags: ["channel-message"] });
    await settleHooks();
    expect(hits).toHaveLength(0);

    // The same note in ALPHA fires exactly once.
    const alphaStore = getVaultStore("alpha");
    await alphaStore.createNote("from alpha", { tags: ["channel-message"] });
    await settleHooks();
    expect(hits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// config.yaml back-compat — global triggers still load + fire
// ---------------------------------------------------------------------------

describe("config.yaml triggers back-compat", () => {
  test("a config.yaml (global, unscoped) trigger fires for any vault", async () => {
    createVault("alpha");
    createVault("beta");

    // Register a global trigger the way server.ts:registerConfiguredTriggers
    // does — no vaultName, so it fires for every vault.
    registerTriggers(defaultHookRegistry, [
      {
        name: "global-hook",
        events: ["created", "updated"],
        when: { tags: ["channel-message"] },
        action: { webhook: `${webhookBase}/hook` },
      },
    ]);

    await getVaultStore("alpha").createNote("a", { tags: ["channel-message"] });
    await getVaultStore("beta").createNote("b", { tags: ["channel-message"] });
    await settleHooks();

    // Fired for BOTH vaults — global, not vault-scoped.
    expect(hits).toHaveLength(2);
  });
});
