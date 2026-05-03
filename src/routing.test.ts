/**
 * Tests for the HTTP routing layer (src/routing.ts).
 *
 * The server exposes four root-level endpoints and everything else under
 * `/vault/<name>/...`. These tests pin the dispatcher's behaviour:
 *
 *  1. `/vaults/list` — public, unauthenticated discovery. Returns vault
 *     names only, 404 when operator disables discovery.
 *  2. `/vaults` — authenticated metadata listing.
 *  3. `/vault/<name>/...` — per-vault routing (OAuth, MCP, view, API).
 *  4. The RFC 9728 WWW-Authenticate challenge that decorates MCP 401s.
 *
 * No unscoped `/mcp`, `/api/*`, `/oauth/*` routes exist — every per-vault
 * resource must name the vault it targets.
 *
 * Uses PARACHUTE_HOME override so each test's vaults live in a tmp dir and
 * never touch ~/.parachute.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(
  tmpdir(),
  `vault-routing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.PARACHUTE_HOME = testDir;

// Dynamic import after env override so modules pick up the tmp dir.
const { route } = await import("./routing.ts");
const {
  readGlobalConfig,
  writeGlobalConfig,
  writeVaultConfig,
  resolveDefaultVault,
  listVaults,
} = await import("./config.ts");
// clearVaultStoreCache was added in #111 for exactly this kind of test
// that wipes its PARACHUTE_HOME between runs — it closes stores silently
// even when the DB files are already gone.
const { clearVaultStoreCache, getVaultStore } = await import("./vault-store.ts");
const { generateToken, createToken } = await import("./token-store.ts");
const { vaultDbPath } = await import("./config.ts");

function createVault(name: string, description?: string): void {
  writeVaultConfig({
    name,
    api_keys: [],
    created_at: new Date().toISOString(),
    description,
  });
}

/**
 * Mint an admin-scoped token for `vaultName` and return its bearer value.
 * Used by tests that hit admin-gated endpoints (e.g. /.parachute/config).
 */
function createAdminToken(vaultName: string): string {
  const store = getVaultStore(vaultName);
  const { fullToken } = generateToken();
  createToken(store.db, fullToken, {
    label: "test-admin",
    permission: "full",
    scopes: ["vault:read", "vault:write", "vault:admin"],
  });
  return fullToken;
}

function reset(): void {
  clearVaultStoreCache();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "vault", "data"), { recursive: true });
  writeGlobalConfig({ port: 1940 });
}

beforeEach(() => {
  reset();
});

afterAll(() => {
  clearVaultStoreCache();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveDefaultVault — used by the CLI to pick the vault to wire into
// `~/.claude.json`, not on the request path (which is always scoped).
// ---------------------------------------------------------------------------

describe("resolveDefaultVault", () => {
  test("returns the configured default_vault when it exists", () => {
    createVault("journal");
    createVault("work");
    writeGlobalConfig({ port: 1940, default_vault: "journal" });
    expect(resolveDefaultVault()).toBe("journal");
  });

  test("returns the sole vault when default_vault is unset", () => {
    createVault("journal");
    expect(resolveDefaultVault()).toBe("journal");
  });

  test("returns the sole vault even if default_vault points to a deleted one", () => {
    createVault("journal");
    writeGlobalConfig({ port: 1940, default_vault: "deleted-vault" });
    expect(resolveDefaultVault()).toBe("journal");
  });

  test("returns null when multiple vaults exist and no valid default", () => {
    createVault("journal");
    createVault("work");
    writeGlobalConfig({ port: 1940, default_vault: "missing" });
    expect(resolveDefaultVault()).toBeNull();
  });

  test("returns null when no vaults exist", () => {
    expect(resolveDefaultVault()).toBeNull();
  });

  test("does not special-case the name 'default'", () => {
    createVault("journal");
    expect(resolveDefaultVault()).toBe("journal");
    expect(listVaults()).toEqual(["journal"]);
    expect(resolveDefaultVault()).not.toBe("default");
  });
});

// ---------------------------------------------------------------------------
// /vaults/list — public discovery endpoint for the Daily picker.
// ---------------------------------------------------------------------------

describe("GET /vaults/list (public discovery)", () => {
  test("unauthenticated request returns 200 with the list of names", async () => {
    createVault("journal");
    createVault("work");
    const req = new Request("http://localhost:1940/vaults/list");
    const res = await route(req, "/vaults/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vaults: string[] };
    // Order mirrors listVaults() (alphabetical from `ls`). Assert as set
    // to avoid coupling to the shell order on exotic filesystems.
    expect(new Set(body.vaults)).toEqual(new Set(["journal", "work"]));
  });

  test("response contains only names — no descriptions, timestamps, counts, or keys", async () => {
    createVault("journal", "Private journal — do not expose this description");
    const req = new Request("http://localhost:1940/vaults/list");
    const res = await route(req, "/vaults/list");
    const body = await res.json();

    // Must be exactly { vaults: [string, ...] }. Anything else is a leak.
    expect(Object.keys(body as object).sort()).toEqual(["vaults"]);
    expect((body as { vaults: unknown[] }).vaults).toEqual(["journal"]);

    // Defense in depth: stringify and grep for anything sensitive.
    const dump = JSON.stringify(body);
    expect(dump).not.toContain("Private journal");
    expect(dump).not.toContain("description");
    expect(dump).not.toContain("created_at");
    expect(dump).not.toContain("api_keys");
    expect(dump).not.toContain("key_hash");
  });

  test("returns an empty list (still 200) when no vaults exist", async () => {
    const req = new Request("http://localhost:1940/vaults/list");
    const res = await route(req, "/vaults/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vaults: string[] };
    expect(body.vaults).toEqual([]);
  });

  test("returns 404 when discovery is disabled in config", async () => {
    createVault("journal");
    writeGlobalConfig({ port: 1940, discovery: "disabled" });
    const req = new Request("http://localhost:1940/vaults/list");
    const res = await route(req, "/vaults/list");
    expect(res.status).toBe(404);
    const body = await res.json();
    // Must not leak that any vaults exist.
    const dump = JSON.stringify(body);
    expect(dump).not.toContain("journal");
  });

  test("returns 200 when discovery is explicitly enabled", async () => {
    createVault("journal");
    writeGlobalConfig({ port: 1940, discovery: "enabled" });
    const req = new Request("http://localhost:1940/vaults/list");
    const res = await route(req, "/vaults/list");
    expect(res.status).toBe(200);
  });

  test("ignores Authorization header (endpoint is public)", async () => {
    createVault("journal");
    const req = new Request("http://localhost:1940/vaults/list", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    const res = await route(req, "/vaults/list");
    expect(res.status).toBe(200);
  });

  test("rejects non-GET methods (falls through to 404)", async () => {
    createVault("journal");
    const req = new Request("http://localhost:1940/vaults/list", { method: "POST" });
    const res = await route(req, "/vaults/list");
    expect(res.status).toBe(404);
  });

  test("discovery disabled still allows authenticated /vaults listing (separate concerns)", async () => {
    createVault("journal");
    writeGlobalConfig({ port: 1940, discovery: "disabled" });
    const req = new Request("http://localhost:1940/vaults");
    const res = await route(req, "/vaults");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// /admin/* — admin SPA static-file mount. Detailed tests live in
// admin-spa.test.ts (with a tmp dist dir); these only pin the dispatch
// — i.e. /admin paths reach the SPA layer rather than falling through to
// the per-vault dispatcher's "Not found".
// ---------------------------------------------------------------------------

describe("/admin/* SPA mount", () => {
  test("/admin/ never returns the per-vault dispatcher's 404 JSON", async () => {
    // dist may or may not be built in CI; the dispatch check just asserts
    // that we don't fall through to the catch-all. Both 200 (dist present)
    // and 503 (dist absent) are valid SPA-layer responses.
    const req = new Request("http://localhost:1940/admin/");
    const res = await route(req, "/admin/");
    expect(res.status === 200 || res.status === 503).toBe(true);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  test("/admin/vault/work (client-routed path) reaches the SPA layer", async () => {
    const req = new Request("http://localhost:1940/admin/vault/work");
    const res = await route(req, "/admin/vault/work");
    expect(res.status === 200 || res.status === 503).toBe(true);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  test("POST /admin/ returns 405 (no admin SPA writes today)", async () => {
    const req = new Request("http://localhost:1940/admin/", { method: "POST" });
    const res = await route(req, "/admin/");
    expect(res.status).toBe(405);
  });

  test("/administrative does NOT match the admin mount (falls through to 404)", async () => {
    const req = new Request("http://localhost:1940/administrative");
    const res = await route(req, "/administrative");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /auth/status — public preflight discovery (issue #163). Tells first-contact
// clients which bearer format to use and surfaces auth-state bits the hub's
// post-exposure flow needs without locking us into any auth check.
// ---------------------------------------------------------------------------

describe("GET /auth/status (public auth preflight)", () => {
  test("empty server: initialized=false, no vaults, no auth bits", async () => {
    const res = await route(new Request("http://localhost:1940/auth/status"), "/auth/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      initialized: boolean;
      auth_modes: string[];
      vaults: { name: string; url: string }[];
      hasOwnerPassword: boolean;
      hasTotp: boolean;
      hasTokens: boolean | null;
    };
    expect(body.initialized).toBe(false);
    expect(body.vaults).toEqual([]);
    expect(body.auth_modes).toEqual(["pvt_token", "hub_jwt"]);
    expect(body.hasOwnerPassword).toBe(false);
    expect(body.hasTotp).toBe(false);
    // No vaults means hasTokens collapses to false (not null), since there's
    // no DB to fail on.
    expect(body.hasTokens).toBe(false);
  });

  test("vault with no tokens: initialized=true, hasTokens=false", async () => {
    createVault("journal");
    // getVaultStore opens (and creates) the SQLite file with the tokens
    // table — without it, the probe falls into the "DB missing" branch and
    // hasTokens stays false anyway, but we want the table to exist for the
    // realistic case.
    getVaultStore("journal");
    const res = await route(new Request("http://localhost:1940/auth/status"), "/auth/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      initialized: boolean;
      vaults: { name: string; url: string }[];
      hasTokens: boolean | null;
    };
    expect(body.initialized).toBe(true);
    expect(body.vaults).toEqual([{ name: "journal", url: "/vault/journal" }]);
    expect(body.hasTokens).toBe(false);
  });

  test("vault with a token: hasTokens=true", async () => {
    createVault("journal");
    createAdminToken("journal");
    const res = await route(new Request("http://localhost:1940/auth/status"), "/auth/status");
    const body = (await res.json()) as { hasTokens: boolean | null };
    expect(body.hasTokens).toBe(true);
  });

  test("multiple vaults are all listed; hasTokens=true if any has tokens", async () => {
    createVault("journal");
    createVault("work");
    getVaultStore("journal");
    createAdminToken("work");
    const res = await route(new Request("http://localhost:1940/auth/status"), "/auth/status");
    const body = (await res.json()) as {
      vaults: { name: string; url: string }[];
      hasTokens: boolean | null;
    };
    expect(new Set(body.vaults.map((v) => v.name))).toEqual(new Set(["journal", "work"]));
    expect(body.hasTokens).toBe(true);
  });

  test("hasTokens degrades to null when one vault has tokens and another DB is unreadable (#192)", async () => {
    // The probe loop's whole point: a single failed DB read poisons the
    // overall answer to `null`, even if an earlier vault already proved
    // tokens exist. Otherwise an operator who locked one DB would see a
    // misleading `true` and think auth-state is fully observable.
    createVault("alpha");
    createAdminToken("alpha");
    createVault("beta");
    // Replace beta's DB file with a non-SQLite blob; the readonly Database
    // open throws at probe time. clearVaultStoreCache so beta's pre-opened
    // handle (if any) doesn't shadow the on-disk corruption.
    clearVaultStoreCache();
    writeFileSync(vaultDbPath("beta"), "not-a-sqlite-file");
    const res = await route(new Request("http://localhost:1940/auth/status"), "/auth/status");
    const body = (await res.json()) as { hasTokens: boolean | null };
    expect(body.hasTokens).toBeNull();
  });

  test("owner password / TOTP set in global config surface as true", async () => {
    createVault("journal");
    writeGlobalConfig({
      port: 1940,
      owner_password_hash: "$2b$10$abcdefghijklmnopqrstuv",
      totp_secret: "JBSWY3DPEHPK3PXP",
    });
    const res = await route(new Request("http://localhost:1940/auth/status"), "/auth/status");
    const body = (await res.json()) as { hasOwnerPassword: boolean; hasTotp: boolean };
    expect(body.hasOwnerPassword).toBe(true);
    expect(body.hasTotp).toBe(true);
  });

  test("response never leaks secrets, hashes, descriptions, or token counts", async () => {
    createVault("journal", "Private journal — must not appear in /auth/status");
    createAdminToken("journal");
    writeGlobalConfig({
      port: 1940,
      owner_password_hash: "$2b$10$verysecretpasswordhash",
      totp_secret: "JBSWY3DPEHPK3PXP",
      backup_codes: ["$2b$10$backup1", "$2b$10$backup2"],
    });
    const res = await route(new Request("http://localhost:1940/auth/status"), "/auth/status");
    const dump = JSON.stringify(await res.json());
    expect(dump).not.toContain("Private journal");
    expect(dump).not.toContain("$2b$10$verysecretpasswordhash");
    expect(dump).not.toContain("JBSWY3DPEHPK3PXP");
    expect(dump).not.toContain("backup");
    // Token-count guard: even with one token created above, no integer count
    // appears in the dump. `hasTokens` is the only token-derived field.
    expect(dump).not.toMatch(/"tokenCount"/);
    expect(dump).not.toMatch(/"token_count"/);
  });

  test("ignores Authorization header (endpoint is public)", async () => {
    const req = new Request("http://localhost:1940/auth/status", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    const res = await route(req, "/auth/status");
    expect(res.status).toBe(200);
  });

  test("rejects non-GET methods (falls through to 404)", async () => {
    const req = new Request("http://localhost:1940/auth/status", { method: "POST" });
    const res = await route(req, "/auth/status");
    expect(res.status).toBe(404);
  });

  test("response includes CORS allow-origin so first-contact browser clients can read it", async () => {
    const res = await route(new Request("http://localhost:1940/auth/status"), "/auth/status");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ---------------------------------------------------------------------------
// Per-vault routing: /vault/<name>/... is the only URL shape for vault
// resources. Unscoped routes (/mcp, /api/*, /oauth/*) no longer exist.
// ---------------------------------------------------------------------------

describe("per-vault routing under /vault/<name>/", () => {
  test("/vault/<name>/mcp reaches the MCP handler (401 unauthenticated)", async () => {
    createVault("journal");
    const path = "/vault/journal/mcp";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(401);
  });

  test("/vault/<name>/api/notes reaches per-vault auth (401 unauthenticated)", async () => {
    createVault("journal");
    const path = "/vault/journal/api/notes";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(401);
  });

  test("/vault/<name>/oauth/register reaches the OAuth handler", async () => {
    createVault("journal");
    const path = "/vault/journal/oauth/register";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "test", redirect_uris: ["https://x.example/cb"] }),
      }),
      path,
    );
    expect(res.status).not.toBe(500);
    expect([201, 400]).toContain(res.status);
  });

  test("unknown vault returns 404 before hitting auth", async () => {
    createVault("journal");
    for (const path of [
      "/vault/nonexistent/mcp",
      "/vault/nonexistent/api/notes",
      "/vault/nonexistent/oauth/register",
    ]) {
      const res = await route(new Request(`http://localhost:1940${path}`), path);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Vault not found");
    }
  });

  test("no /mcp, /api, /oauth unscoped routes — all 404", async () => {
    createVault("journal");
    for (const path of ["/mcp", "/api/notes", "/oauth/register", "/oauth/authorize"]) {
      const res = await route(new Request(`http://localhost:1940${path}`), path);
      expect(res.status).toBe(404);
    }
  });

  test("bare /vault/<name> returns metadata for authenticated callers", async () => {
    createVault("journal", "My journal vault");
    const path = "/vault/journal";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    // No auth → 401 from per-vault auth gate.
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// RFC 9728 WWW-Authenticate challenge on MCP 401.
//
// Claude Code's MCP SDK (and any other strict RFC 9728 client) requires the
// server to emit `WWW-Authenticate: Bearer resource_metadata="..."` on 401
// so the client knows which protected-resource metadata document applies to
// the endpoint it just hit.
// ---------------------------------------------------------------------------

describe("MCP 401 WWW-Authenticate challenge (RFC 9728)", () => {
  test("/vault/<name>/mcp 401 carries the vault-scoped pointer", async () => {
    createVault("journal");
    const path = "/vault/journal/mcp";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(401);
    const header = res.headers.get("WWW-Authenticate");
    expect(header).toBe(
      'Bearer resource_metadata="http://localhost:1940/vault/journal/.well-known/oauth-protected-resource"',
    );
  });

  test("challenge points at the PRM document the server actually serves", async () => {
    // Belt-and-braces: whatever we advertise in the header MUST line up with
    // what `/.well-known/oauth-protected-resource` actually returns. If these
    // drift, a conforming client will chase the pointer, fetch the PRM, then
    // reject on resource mismatch anyway.
    createVault("journal");

    const mcpPath = "/vault/journal/mcp";
    const mcpRes = await route(new Request(`http://localhost:1940${mcpPath}`), mcpPath);
    const header = mcpRes.headers.get("WWW-Authenticate")!;
    const prmUrl = header.match(/resource_metadata="([^"]+)"/)![1];
    const prmPath = new URL(prmUrl).pathname;
    const prmRes = await route(new Request(`http://localhost:1940${prmPath}`), prmPath);
    expect(prmRes.status).toBe(200);
    const prm = (await prmRes.json()) as { resource: string };
    expect(prm.resource).toBe("http://localhost:1940/vault/journal/mcp");
  });

  test("MCP 401 with invalid token still carries the challenge", async () => {
    createVault("journal");
    const path = "/vault/journal/mcp";
    const req = new Request(`http://localhost:1940${path}`, {
      headers: { Authorization: "Bearer pvt_not-a-real-token" },
    });
    const res = await route(req, path);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:1940/vault/journal/.well-known/oauth-protected-resource"',
    );
  });

  test("non-MCP 401s do NOT carry the challenge (spec is MCP-only)", async () => {
    createVault("journal");

    // /vault/journal/api/notes — 401, no challenge.
    const apiPath = "/vault/journal/api/notes";
    const apiRes = await route(new Request(`http://localhost:1940${apiPath}`), apiPath);
    expect(apiRes.status).toBe(401);
    expect(apiRes.headers.get("WWW-Authenticate")).toBeNull();

    // /vaults (authenticated listing) — 401, no challenge.
    const vaultsList = await route(new Request("http://localhost:1940/vaults"), "/vaults");
    expect(vaultsList.status).toBe(401);
    expect(vaultsList.headers.get("WWW-Authenticate")).toBeNull();
  });

  test("x-forwarded-host and x-forwarded-proto shape the challenge URL", async () => {
    // Remote deployments behind Cloudflare Tunnel / Tailscale Funnel / any
    // reverse proxy need the challenge URL to match the external origin,
    // not the 127.0.0.1:1940 the server actually binds.
    createVault("journal");
    const path = "/vault/journal/mcp";
    const req = new Request(`http://127.0.0.1:1940${path}`, {
      headers: {
        "x-forwarded-host": "vault.example.com",
        "x-forwarded-proto": "https",
      },
    });
    const res = await route(req, path);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://vault.example.com/vault/journal/.well-known/oauth-protected-resource"',
    );
  });
});

// ---------------------------------------------------------------------------
// Per-vault OAuth discovery (RFC 8414 / RFC 9728, path-append form).
//
// For a resource at `/vault/<name>/mcp`, clients fetch metadata from
//   /vault/<name>/.well-known/oauth-protected-resource
//   /vault/<name>/.well-known/oauth-authorization-server
// All endpoints in the AS metadata are vault-scoped so a client that
// discovers the AS at that URL can drive the full authorization flow.
// ---------------------------------------------------------------------------

describe("per-vault OAuth discovery", () => {
  test("/vault/<name>/.well-known/oauth-authorization-server returns vault-scoped AS metadata", async () => {
    createVault("journal");
    const path = "/vault/journal/.well-known/oauth-authorization-server";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };
    expect(body.issuer).toBe("http://localhost:1940/vault/journal");
    expect(body.authorization_endpoint).toBe("http://localhost:1940/vault/journal/oauth/authorize");
    expect(body.token_endpoint).toBe("http://localhost:1940/vault/journal/oauth/token");
    expect(body.registration_endpoint).toBe("http://localhost:1940/vault/journal/oauth/register");
  });

  test("/vault/<name>/.well-known/oauth-protected-resource returns vault-scoped PRM", async () => {
    createVault("journal");
    const path = "/vault/journal/.well-known/oauth-protected-resource";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("http://localhost:1940/vault/journal/mcp");
    expect(body.authorization_servers).toEqual(["http://localhost:1940/vault/journal"]);
  });

  test("unknown vault returns 404 rather than boilerplate metadata", async () => {
    createVault("journal");
    for (const path of [
      "/vault/nonexistent/.well-known/oauth-authorization-server",
      "/vault/nonexistent/.well-known/oauth-protected-resource",
    ]) {
      const res = await route(new Request(`http://localhost:1940${path}`), path);
      expect(res.status).toBe(404);
    }
  });

  test("x-forwarded-* headers propagate into the generated metadata URLs", async () => {
    createVault("journal");
    const path = "/vault/journal/.well-known/oauth-authorization-server";
    const res = await route(
      new Request(`http://127.0.0.1:1940${path}`, {
        headers: {
          "x-forwarded-host": "vault.example.com",
          "x-forwarded-proto": "https",
        },
      }),
      path,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string; registration_endpoint: string };
    expect(body.issuer).toBe("https://vault.example.com/vault/journal");
    expect(body.registration_endpoint).toBe(
      "https://vault.example.com/vault/journal/oauth/register",
    );
  });

  test("end-to-end flow: WWW-Authenticate → PRM → AS metadata → registration_endpoint is live", async () => {
    // On 401, follow the challenge to the PRM, then follow
    // PRM.authorization_servers[0] to the AS metadata, then hit the
    // `registration_endpoint`. Every hop must resolve.
    createVault("journal");

    // Step 1: unauthenticated MCP → 401 + WWW-Authenticate.
    const mcpPath = "/vault/journal/mcp";
    const mcpRes = await route(new Request(`http://localhost:1940${mcpPath}`), mcpPath);
    expect(mcpRes.status).toBe(401);
    const challenge = mcpRes.headers.get("WWW-Authenticate")!;
    const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)![1];

    // Step 2: fetch PRM.
    const prmPath = new URL(prmUrl).pathname;
    const prmRes = await route(new Request(`http://localhost:1940${prmPath}`), prmPath);
    expect(prmRes.status).toBe(200);
    const prm = (await prmRes.json()) as { authorization_servers: string[] };
    const asBase = prm.authorization_servers[0]; // "http://localhost:1940/vault/journal"

    // Step 3: AS metadata lives at `{asBase}/.well-known/oauth-authorization-server`.
    const asBasePath = new URL(asBase).pathname; // "/vault/journal"
    const asMetaPath = `${asBasePath}/.well-known/oauth-authorization-server`;
    const asRes = await route(new Request(`http://localhost:1940${asMetaPath}`), asMetaPath);
    expect(asRes.status).toBe(200);
    const asMeta = (await asRes.json()) as { registration_endpoint: string };

    // Step 4: the advertised registration_endpoint must be live.
    const regPath = new URL(asMeta.registration_endpoint).pathname;
    const regRes = await route(
      new Request(`http://localhost:1940${regPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Test",
          redirect_uris: ["https://example.com/cb"],
        }),
      }),
      regPath,
    );
    expect(regRes.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// RFC 8414 §3.1 / RFC 9728 §3 path-insertion discovery URLs.
//
// For a resource at `/vault/<name>/mcp`, conformant clients (including
// Claude Code's MCP OAuth SDK) probe metadata at
//
//   /.well-known/oauth-authorization-server/vault/<name>[/mcp]
//   /.well-known/oauth-protected-resource/vault/<name>[/mcp]
//
// These routes MUST return the same document as the path-append form —
// otherwise mixed-toolchain clients see drifted metadata. Coherence check
// below asserts deep equality.
// ---------------------------------------------------------------------------

describe("OAuth discovery (RFC 8414/9728 path-insertion form)", () => {
  test("AS metadata at path-insertion short form returns vault-scoped endpoints", async () => {
    createVault("journal");
    const path = "/.well-known/oauth-authorization-server/vault/journal";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };
    expect(body.issuer).toBe("http://localhost:1940/vault/journal");
    expect(body.authorization_endpoint).toBe("http://localhost:1940/vault/journal/oauth/authorize");
    expect(body.token_endpoint).toBe("http://localhost:1940/vault/journal/oauth/token");
    expect(body.registration_endpoint).toBe("http://localhost:1940/vault/journal/oauth/register");
  });

  test("AS metadata at path-insertion long form (/mcp suffix) also works", async () => {
    // Some SDKs probe with the exact resource path appended. The optional
    // `/mcp` suffix covers that.
    createVault("journal");
    const path = "/.well-known/oauth-authorization-server/vault/journal/mcp";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string };
    expect(body.issuer).toBe("http://localhost:1940/vault/journal");
  });

  test("PRM at path-insertion short form returns vault-scoped resource", async () => {
    createVault("journal");
    const path = "/.well-known/oauth-protected-resource/vault/journal";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("http://localhost:1940/vault/journal/mcp");
    expect(body.authorization_servers).toEqual(["http://localhost:1940/vault/journal"]);
  });

  test("PRM at path-insertion long form (/mcp suffix) also works", async () => {
    createVault("journal");
    const path = "/.well-known/oauth-protected-resource/vault/journal/mcp";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe("http://localhost:1940/vault/journal/mcp");
  });

  test("path-insertion and path-append forms return deep-equal JSON (coherence)", async () => {
    // Belt-and-braces: a client that probes one form and validates against
    // the other (or a proxy that caches based on URL) must see identical
    // bytes. If these drift, strict/lax clients will disagree on reality.
    createVault("journal");
    const asPaths = [
      "/.well-known/oauth-authorization-server/vault/journal",
      "/vault/journal/.well-known/oauth-authorization-server",
    ];
    const [asInsert, asAppend] = await Promise.all(
      asPaths.map(async (p) => {
        const r = await route(new Request(`http://localhost:1940${p}`), p);
        return r.json();
      }),
    );
    expect(asInsert).toEqual(asAppend);

    const prmPaths = [
      "/.well-known/oauth-protected-resource/vault/journal",
      "/vault/journal/.well-known/oauth-protected-resource",
    ];
    const [prmInsert, prmAppend] = await Promise.all(
      prmPaths.map(async (p) => {
        const r = await route(new Request(`http://localhost:1940${p}`), p);
        return r.json();
      }),
    );
    expect(prmInsert).toEqual(prmAppend);
  });

  test("unknown vault → 404 on all four path-insertion shapes (no phantom metadata)", async () => {
    createVault("journal");
    for (const path of [
      "/.well-known/oauth-authorization-server/vault/nonexistent",
      "/.well-known/oauth-authorization-server/vault/nonexistent/mcp",
      "/.well-known/oauth-protected-resource/vault/nonexistent",
      "/.well-known/oauth-protected-resource/vault/nonexistent/mcp",
    ]) {
      const res = await route(new Request(`http://localhost:1940${path}`), path);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Vault not found");
    }
  });

  test("x-forwarded-* headers propagate through path-insertion URLs", async () => {
    createVault("journal");
    const path = "/.well-known/oauth-authorization-server/vault/journal";
    const res = await route(
      new Request(`http://127.0.0.1:1940${path}`, {
        headers: {
          "x-forwarded-host": "vault.example.com",
          "x-forwarded-proto": "https",
        },
      }),
      path,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string; registration_endpoint: string };
    expect(body.issuer).toBe("https://vault.example.com/vault/journal");
    expect(body.registration_endpoint).toBe(
      "https://vault.example.com/vault/journal/oauth/register",
    );
  });

  test("end-to-end: 401 → PRM (path-insertion) → AS (path-insertion) → DCR lands", async () => {
    // Exact handshake Claude Code's MCP OAuth SDK performs. If any hop
    // 404s, auth cascade-fails — this is the launch-blocker regression
    // we're fixing.
    createVault("journal");

    // Step 1: unauth MCP → 401 + WWW-Authenticate with PRM pointer.
    const mcpPath = "/vault/journal/mcp";
    const mcpRes = await route(new Request(`http://localhost:1940${mcpPath}`), mcpPath);
    expect(mcpRes.status).toBe(401);
    const challenge = mcpRes.headers.get("WWW-Authenticate")!;
    const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)![1];

    // The challenge still points at the path-append PRM (we emit one URL
    // in the header). Strict clients ignore the hint and probe the
    // path-insertion form regardless — that's the path we care about here.
    const prmInsertPath = "/.well-known/oauth-protected-resource/vault/journal";
    const prmRes = await route(
      new Request(`http://localhost:1940${prmInsertPath}`),
      prmInsertPath,
    );
    expect(prmRes.status).toBe(200);
    const prm = (await prmRes.json()) as { authorization_servers: string[] };
    const asBase = prm.authorization_servers[0]; // http://localhost:1940/vault/journal

    // Step 2: fetch AS metadata via path-insertion. The issuer path is
    // everything after the host — here, `/vault/journal`.
    const asBasePath = new URL(asBase).pathname;
    const asInsertPath = `/.well-known/oauth-authorization-server${asBasePath}`;
    const asRes = await route(
      new Request(`http://localhost:1940${asInsertPath}`),
      asInsertPath,
    );
    expect(asRes.status).toBe(200);
    const asMeta = (await asRes.json()) as { registration_endpoint: string };

    // Step 3: registration_endpoint must be live.
    const regPath = new URL(asMeta.registration_endpoint).pathname;
    const regRes = await route(
      new Request(`http://localhost:1940${regPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Test",
          redirect_uris: ["https://example.com/cb"],
        }),
      }),
      regPath,
    );
    expect(regRes.status).toBe(201);

    // Path-append PRM URL in the challenge header must still resolve —
    // we haven't broken the back-compat path.
    const prmAppendRes = await route(
      new Request(prmUrl),
      new URL(prmUrl).pathname,
    );
    expect(prmAppendRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// /.parachute/info + /.parachute/icon.svg — public service-info card for the
// CLI hub page at the ecosystem root. The hub fetches these per service to
// render tiles, so the endpoints are public (no auth), CORS `*`, and zero
// PII. Shape is locked so all services line up in the aggregator UI.
// ---------------------------------------------------------------------------

describe("/.parachute/info + /.parachute/icon.svg", () => {
  test("info returns the locked card shape with version from package.json", async () => {
    createVault("journal");
    const pkg = (await import("../package.json", { with: { type: "json" } })).default;
    const path = "/vault/journal/.parachute/info";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as {
      name: string;
      displayName: string;
      tagline: string;
      version: string;
      iconUrl: string;
      kind: string;
    };
    expect(body).toEqual({
      name: "parachute-vault",
      displayName: "Vault",
      tagline: expect.stringContaining("knowledge graph"),
      version: pkg.version,
      iconUrl: "/vault/journal/.parachute/icon.svg",
      kind: "api",
    });
  });

  test("info iconUrl is vault-scoped and points at a live icon handler", async () => {
    createVault("work");
    const infoPath = "/vault/work/.parachute/info";
    const infoRes = await route(new Request(`http://localhost:1940${infoPath}`), infoPath);
    const info = (await infoRes.json()) as { iconUrl: string };
    expect(info.iconUrl).toBe("/vault/work/.parachute/icon.svg");

    // Follow the pointer — the advertised iconUrl must resolve.
    const iconRes = await route(
      new Request(`http://localhost:1940${info.iconUrl}`),
      info.iconUrl,
    );
    expect(iconRes.status).toBe(200);
  });

  test("icon.svg returns an SVG body with the right content-type + CORS", async () => {
    createVault("journal");
    const path = "/vault/journal/.parachute/icon.svg";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Pin nosniff so older Edge/IE can't sniff the inline SVG as HTML.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).toContain("</svg>");
  });

  test("both endpoints are public — no auth header required, none honored", async () => {
    createVault("journal");
    for (const path of [
      "/vault/journal/.parachute/info",
      "/vault/journal/.parachute/icon.svg",
    ]) {
      // No Authorization header.
      const resAnon = await route(new Request(`http://localhost:1940${path}`), path);
      expect(resAnon.status).toBe(200);

      // Bogus Authorization header — still 200, auth is not consulted.
      const resWithHeader = await route(
        new Request(`http://localhost:1940${path}`, {
          headers: { Authorization: "Bearer pvt_nonsense" },
        }),
        path,
      );
      expect(resWithHeader.status).toBe(200);
    }
  });

  test("unknown vault returns 404 before reaching the info/icon handlers", async () => {
    createVault("journal");
    for (const path of [
      "/vault/nonexistent/.parachute/info",
      "/vault/nonexistent/.parachute/icon.svg",
    ]) {
      const res = await route(new Request(`http://localhost:1940${path}`), path);
      expect(res.status).toBe(404);
    }
  });

  test("non-GET methods return 405 (and never trigger auth — stays public)", async () => {
    createVault("journal");
    for (const path of [
      "/vault/journal/.parachute/info",
      "/vault/journal/.parachute/icon.svg",
    ]) {
      const res = await route(
        new Request(`http://localhost:1940${path}`, { method: "POST" }),
        path,
      );
      expect(res.status).toBe(405);
    }
  });
});

// ---------------------------------------------------------------------------
// /.parachute/config/schema + /.parachute/config — module config (Phase 2).
// ---------------------------------------------------------------------------

describe("/.parachute/config/schema + /.parachute/config", () => {
  test("schema returns JSON Schema draft-07 shape with the documented properties", async () => {
    createVault("journal");
    const path = "/vault/journal/.parachute/config/schema";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as {
      $schema: string;
      type: string;
      title: string;
      properties: Record<string, { type?: string; enum?: string[]; writeOnly?: boolean; readOnly?: boolean }>;
    };
    expect(body.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(body.type).toBe("object");
    expect(body.properties.audio_retention?.type).toBe("string");
    expect(body.properties.audio_retention?.enum).toEqual(["keep", "until_transcribed", "never"]);
    expect(body.properties.scribe_url?.type).toBe("string");
    expect(body.properties.scribe_token?.writeOnly).toBe(true);
    expect(body.properties.port?.readOnly).toBe(true);
  });

  test("config returns current values with writeOnly fields excluded", async () => {
    createVault("journal");
    const token = createAdminToken("journal");
    const path = "/vault/journal/.parachute/config";
    const origScribeToken = process.env.SCRIBE_TOKEN;
    const origScribeUrl = process.env.SCRIBE_URL;
    process.env.SCRIBE_TOKEN = "super-secret-should-never-appear";
    process.env.SCRIBE_URL = "https://scribe.example/v1";
    try {
      const res = await route(
        new Request(`http://localhost:1940${path}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        path,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.audio_retention).toBe("keep"); // default when unset
      expect(body.scribe_url).toBe("https://scribe.example/v1");
      expect(body.port).toBe(1940);
      // writeOnly field must not appear in GET.
      expect(body).not.toHaveProperty("scribe_token");
      // Defense in depth: grep the raw body for the token value.
      expect(JSON.stringify(body)).not.toContain("super-secret-should-never-appear");
    } finally {
      if (origScribeToken === undefined) delete process.env.SCRIBE_TOKEN;
      else process.env.SCRIBE_TOKEN = origScribeToken;
      if (origScribeUrl === undefined) delete process.env.SCRIBE_URL;
      else process.env.SCRIBE_URL = origScribeUrl;
    }
  });

  test("config reflects per-vault audio_retention override", async () => {
    writeVaultConfig({
      name: "journal",
      api_keys: [],
      created_at: new Date().toISOString(),
      audio_retention: "until_transcribed",
    });
    const token = createAdminToken("journal");
    const path = "/vault/journal/.parachute/config";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      path,
    );
    const body = (await res.json()) as { audio_retention: string };
    expect(body.audio_retention).toBe("until_transcribed");
  });

  test("config scribe_url falls back to empty string when SCRIBE_URL env is unset", async () => {
    createVault("journal");
    const token = createAdminToken("journal");
    const orig = process.env.SCRIBE_URL;
    delete process.env.SCRIBE_URL;
    try {
      const path = "/vault/journal/.parachute/config";
      const res = await route(
        new Request(`http://localhost:1940${path}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        path,
      );
      const body = (await res.json()) as { scribe_url: string };
      expect(body.scribe_url).toBe("");
    } finally {
      if (orig !== undefined) process.env.SCRIBE_URL = orig;
    }
  });

  test("unknown vault returns 404 before reaching the config handlers", async () => {
    createVault("journal");
    for (const path of [
      "/vault/nonexistent/.parachute/config/schema",
      "/vault/nonexistent/.parachute/config",
    ]) {
      const res = await route(new Request(`http://localhost:1940${path}`), path);
      expect(res.status).toBe(404);
    }
  });

  test("non-GET methods return 405 — PUT lands in Phase 3, not silently accepted now", async () => {
    createVault("journal");
    for (const path of [
      "/vault/journal/.parachute/config/schema",
      "/vault/journal/.parachute/config",
    ]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await route(
          new Request(`http://localhost:1940${path}`, { method }),
          path,
        );
        expect(res.status).toBe(405);
      }
    }
  });

  test("schema endpoint is public — hub form renders without auth", async () => {
    createVault("journal");
    const path = "/vault/journal/.parachute/config/schema";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
  });

  test("config endpoint requires vault:admin — unauthenticated GET returns 401", async () => {
    createVault("journal");
    const path = "/vault/journal/.parachute/config";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(401);
  });

  test("config endpoint rejects a vault:read token with 403 + insufficient_scope", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    const { fullToken } = generateToken();
    createToken(store.db, fullToken, {
      label: "reader",
      permission: "read",
      scopes: ["vault:read"],
    });
    const path = "/vault/journal/.parachute/config";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        headers: { authorization: `Bearer ${fullToken}` },
      }),
      path,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_type?: string; required_scope?: string };
    expect(body.error_type).toBe("insufficient_scope");
    expect(body.required_scope).toBe("vault:admin");
  });
});

// ---------------------------------------------------------------------------
// Scope enforcement on /api/* — PR D (task #97).
//
// The REST surface picks the required scope per method (GET → vault:read,
// POST/PATCH/DELETE → vault:write). These tests pin the full matrix:
// read-only rejected on writes, write succeeds on GET via inheritance, admin
// succeeds everywhere, legacy DB rows with NULL scopes keep working, and the
// 403 body names the required scope so agents can diagnose without tracing.
// ---------------------------------------------------------------------------

describe("scope enforcement on /api/*", () => {
  /** Mint a token with the given scopes and return its bearer value. */
  function mintToken(
    vaultName: string,
    opts: {
      permission: "full" | "read";
      scopes?: string[];
      legacyNullScopes?: boolean;
    },
  ): string {
    const store = getVaultStore(vaultName);
    const { fullToken } = generateToken();
    if (opts.legacyNullScopes) {
      // Simulate a pre-v12 token row: NULL scopes column, legacy permission
      // value. resolveToken should fall back via legacyPermissionToScopes.
      const { hashKey } = require("./config.ts");
      const hash = hashKey(fullToken);
      store.db.prepare(
        "INSERT INTO tokens (token_hash, label, permission, created_at) VALUES (?, ?, ?, ?)",
      ).run(hash, `legacy-${opts.permission}`, opts.permission, new Date().toISOString());
    } else {
      createToken(store.db, fullToken, {
        label: `test-${opts.permission}`,
        permission: opts.permission,
        scopes: opts.scopes,
      });
    }
    return fullToken;
  }

  function authed(token: string, method = "GET", path: string): Request {
    return new Request(`http://localhost:1940${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  test("vault:read token permits GET /api/vault", async () => {
    createVault("journal");
    const token = mintToken("journal", {
      permission: "read",
      scopes: ["vault:read"],
    });
    const path = "/vault/journal/api/vault";
    const res = await route(authed(token, "GET", path), path);
    expect(res.status).toBe(200);
  });

  test("vault:read token rejected on POST /api/notes with 403 insufficient_scope", async () => {
    createVault("journal");
    const token = mintToken("journal", {
      permission: "read",
      scopes: ["vault:read"],
    });
    const path = "/vault/journal/api/notes";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "nope" }),
      }),
      path,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_type?: string; required_scope?: string; granted_scopes?: string[] };
    expect(body.error_type).toBe("insufficient_scope");
    expect(body.required_scope).toBe("vault:write");
    expect(body.granted_scopes).toEqual(["vault:read"]);
  });

  test("vault:write token permits GET (inheritance: write ⊇ read)", async () => {
    createVault("journal");
    const token = mintToken("journal", {
      permission: "full",
      scopes: ["vault:write"],
    });
    const path = "/vault/journal/api/vault";
    const res = await route(authed(token, "GET", path), path);
    expect(res.status).toBe(200);
  });

  test("vault:write token permits POST /api/notes", async () => {
    createVault("journal");
    const token = mintToken("journal", {
      permission: "full",
      scopes: ["vault:write"],
    });
    const path = "/vault/journal/api/notes";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "hi" }),
      }),
      path,
    );
    // 200/201 means scope gate allowed through — we don't care about the
    // shape of the note here, just that we got past auth.
    expect(res.status).toBeLessThan(400);
  });

  test("vault:admin token permits admin-only /.parachute/config", async () => {
    createVault("journal");
    const token = mintToken("journal", {
      permission: "full",
      scopes: ["vault:admin"],
    });
    const path = "/vault/journal/.parachute/config";
    const res = await route(authed(token, "GET", path), path);
    expect(res.status).toBe(200);
  });

  test("vault:admin token permits GET + POST via inheritance", async () => {
    createVault("journal");
    const token = mintToken("journal", {
      permission: "full",
      scopes: ["vault:admin"],
    });
    const getPath = "/vault/journal/api/vault";
    const getRes = await route(authed(token, "GET", getPath), getPath);
    expect(getRes.status).toBe(200);

    const postPath = "/vault/journal/api/notes";
    const postRes = await route(
      new Request(`http://localhost:1940${postPath}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "hi" }),
      }),
      postPath,
    );
    expect(postRes.status).toBeLessThan(400);
  });

  test("legacy token (NULL scopes, permission='full') still works on writes", async () => {
    createVault("journal");
    const token = mintToken("journal", {
      permission: "full",
      legacyNullScopes: true,
    });
    const path = "/vault/journal/api/notes";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "legacy" }),
      }),
      path,
    );
    expect(res.status).toBeLessThan(400);
  });

  test("legacy token (NULL scopes, permission='read') rejected on writes", async () => {
    createVault("journal");
    const token = mintToken("journal", {
      permission: "read",
      legacyNullScopes: true,
    });
    const path = "/vault/journal/api/notes";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "nope" }),
      }),
      path,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required_scope?: string };
    expect(body.required_scope).toBe("vault:write");
  });

  test("unauthenticated request to /api returns 401 (not 403)", async () => {
    createVault("journal");
    const path = "/vault/journal/api/vault";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(401);
  });

  // ----- tag-scoped tokens (patterns/tag-scoped-tokens.md) -----------------

  /**
   * Mint a tag-scoped token. Mirrors `mintToken` above but threads
   * `scoped_tags` through to the token row so `resolveToken` returns the
   * allowlist on the AuthResult and routing.ts feeds it into the per-request
   * TagScopeCtx that handlers consult.
   */
  function mintTagScopedToken(
    vaultName: string,
    scopes: string[],
    scopedTags: string[],
  ): string {
    const store = getVaultStore(vaultName);
    const { fullToken } = generateToken();
    createToken(store.db, fullToken, {
      label: `test-tag-scoped`,
      permission: scopes.includes("vault:write") || scopes.includes("vault:admin") ? "full" : "read",
      scopes,
      scoped_tags: scopedTags,
    });
    return fullToken;
  }

  test("tag-scoped read token: GET /api/notes/:id 404s on out-of-scope note (no existence leak)", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    const inScope = await store.createNote("h", { tags: ["health"] });
    const outOfScope = await store.createNote("w", { tags: ["work"] });
    const token = mintTagScopedToken("journal", ["vault:read"], ["health"]);

    const ok = `/vault/journal/api/notes/${inScope.id}`;
    expect((await route(authed(token, "GET", ok), ok)).status).toBe(200);

    const notFound = `/vault/journal/api/notes/${outOfScope.id}`;
    expect((await route(authed(token, "GET", notFound), notFound)).status).toBe(404);
  });

  test("tag-scoped read token: GET /api/notes filters list to in-scope notes only", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("h", { tags: ["health"] });
    await store.createNote("w", { tags: ["work"] });
    const token = mintTagScopedToken("journal", ["vault:read"], ["health"]);

    const path = "/vault/journal/api/notes";
    const res = await route(authed(token, "GET", path), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes?: { tags: string[] }[] } | { tags: string[] }[];
    const list = Array.isArray(body) ? body : (body.notes ?? []);
    expect(list.every((n) => n.tags.includes("health"))).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  test("tag-scoped read token: GET /api/tags filters to allowlisted tags", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("h", { tags: ["health"] });
    await store.createNote("w", { tags: ["work"] });
    const token = mintTagScopedToken("journal", ["vault:read"], ["health"]);

    const path = "/vault/journal/api/tags";
    const res = await route(authed(token, "GET", path), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string }[];
    const names = body.map((t) => t.name);
    expect(names).toContain("health");
    expect(names).not.toContain("work");
  });

  test("tag-scoped write token: POST /api/notes with in-scope tag → 201", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("seed", { tags: ["health"] });
    const token = mintTagScopedToken("journal", ["vault:read", "vault:write"], ["health"]);

    const path = "/vault/journal/api/notes";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: "ok", tags: ["health"] }),
      }),
      path,
    );
    expect(res.status).toBe(201);
  });

  test("tag-scoped write token: POST /api/notes outside allowlist → 403 tag_scope_violation", async () => {
    createVault("journal");
    const token = mintTagScopedToken("journal", ["vault:read", "vault:write"], ["health"]);

    const path = "/vault/journal/api/notes";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: "denied", tags: ["work"] }),
      }),
      path,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_type?: string };
    expect(body.error_type).toBe("tag_scope_violation");
  });

  test("tag-scoped write token: DELETE on out-of-scope note → 404 (no leak)", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    const outOfScope = await store.createNote("w", { tags: ["work"] });
    const token = mintTagScopedToken("journal", ["vault:read", "vault:write"], ["health"]);

    const path = `/vault/journal/api/notes/${outOfScope.id}`;
    const res = await route(authed(token, "DELETE", path), path);
    expect(res.status).toBe(404);
  });

  // ----- Q6: orphan-sub-tag fail-open ------------------------------------
  // patterns/tag-scoped-tokens.md §Storage: when a sub-tag has no declared
  // schema, the string-form root authorizes. Token allowlisted for `health`
  // must see `#health/food` even when no `_tags/health/food` schema exists.

  test("tag-scoped read token: orphan sub-tag is in scope via string-form root", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    // No `_tags/health/food` schema is created — this is the orphan case.
    const orphan = await store.createNote("orphan", { tags: ["health/food"] });
    const token = mintTagScopedToken("journal", ["vault:read"], ["health"]);

    const path = `/vault/journal/api/notes/${orphan.id}`;
    const res = await route(authed(token, "GET", path), path);
    expect(res.status).toBe(200);
  });

  test("tag-scoped write token: orphan sub-tag write succeeds via string-form root", async () => {
    createVault("journal");
    const token = mintTagScopedToken("journal", ["vault:read", "vault:write"], ["health"]);

    const path = "/vault/journal/api/notes";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: "ok", tags: ["health/food"] }),
      }),
      path,
    );
    expect(res.status).toBe(201);
  });

  // ----- Q5: tag-delete dependency check ---------------------------------
  // Deleting a tag referenced by any token's scoped_tags would silently
  // orphan the token's allowlist; fail closed with 409 + referenced_by.

  test("DELETE /api/tags/:name → 409 when a tag-scoped token references it", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("h", { tags: ["health"] });
    // Mint a tag-scoped token that references `health`, then try to delete
    // `health` with an admin token.
    mintTagScopedToken("journal", ["vault:read"], ["health"]);
    const admin = createAdminToken("journal");

    const path = "/vault/journal/api/tags/health";
    const res = await route(authed(admin, "DELETE", path), path);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error_type?: string;
      tag?: string;
      referenced_by?: { id: string; label: string }[];
    };
    expect(body.error_type).toBe("tag_in_use_by_tokens");
    expect(body.tag).toBe("health");
    expect(body.referenced_by?.length).toBe(1);
    expect(body.referenced_by?.[0]?.label).toBe("test-tag-scoped");
  });

  test("DELETE /api/tags/:name → 200 when no tag-scoped token references it", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("h", { tags: ["health"] });
    const admin = createAdminToken("journal");

    const path = "/vault/journal/api/tags/health";
    const res = await route(authed(admin, "DELETE", path), path);
    expect(res.status).toBe(200);
  });

  test("POST /api/tags/:name/rename → 409 when a tag-scoped token references the old name", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("h", { tags: ["health"] });
    mintTagScopedToken("journal", ["vault:read"], ["health"]);
    const admin = createAdminToken("journal");

    const path = "/vault/journal/api/tags/health/rename";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify({ new_name: "wellness" }),
      }),
      path,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error_type?: string;
      tag?: string;
      referenced_by?: { id: string; label: string }[];
    };
    expect(body.error_type).toBe("tag_in_use_by_tokens");
    expect(body.tag).toBe("health");
    expect(body.referenced_by?.length).toBe(1);

    // Tag was not renamed.
    expect((await store.listTags()).find((t) => t.name === "health")).toBeTruthy();
    expect((await store.listTags()).find((t) => t.name === "wellness")).toBeFalsy();
  });

  test("POST /api/tags/merge → 409 when a tag-scoped token references a source", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("a", { tags: ["alpha"] });
    await store.createNote("b", { tags: ["beta"] });
    mintTagScopedToken("journal", ["vault:read"], ["alpha"]);
    const admin = createAdminToken("journal");

    const path = "/vault/journal/api/tags/merge";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify({ sources: ["alpha"], target: "beta" }),
      }),
      path,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error_type?: string;
      referenced_by?: { source: string; tokens: { id: string; label: string }[] }[];
    };
    expect(body.error_type).toBe("tag_in_use_by_tokens");
    expect(body.referenced_by?.[0]?.source).toBe("alpha");
    expect(body.referenced_by?.[0]?.tokens?.length).toBe(1);
  });

  test("CLI --read equivalent token (permission='read', scopes=[vault:read]) is read-only at the HTTP boundary", async () => {
    // This pins the end-to-end contract: a token minted the way
    // `parachute-vault tokens create --read` mints them actually refuses
    // writes. Without this, a cosmetic `--read` flag could silently allow
    // mutations — the whole point of the review item.
    createVault("journal");
    const token = mintToken("journal", {
      permission: "read",
      scopes: ["vault:read"],
    });

    const readPath = "/vault/journal/api/vault";
    const readRes = await route(authed(token, "GET", readPath), readPath);
    expect(readRes.status).toBe(200);

    const writePath = "/vault/journal/api/notes";
    const writeRes = await route(
      new Request(`http://localhost:1940${writePath}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "nope" }),
      }),
      writePath,
    );
    expect(writeRes.status).toBe(403);
  });
});
