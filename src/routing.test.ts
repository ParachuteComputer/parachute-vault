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
import { rmSync, existsSync, mkdirSync } from "fs";
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
const { clearVaultStoreCache } = await import("./vault-store.ts");

function createVault(name: string, description?: string): void {
  writeVaultConfig({
    name,
    api_keys: [],
    created_at: new Date().toISOString(),
    description,
  });
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
