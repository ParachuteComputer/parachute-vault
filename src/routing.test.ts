/**
 * Tests for the HTTP routing layer (src/routing.ts).
 *
 * Two surfaces under test here:
 *
 *  1. `/vaults/list` — public, unauthenticated discovery endpoint.
 *     Intended for the Daily vault-picker dropdown pre-OAuth.
 *     Must never leak anything beyond vault names; must return 404 when
 *     the operator disables discovery in config.yaml.
 *
 *  2. Single-vault auto-default. A user with exactly one vault (named
 *     anything — not necessarily "default") should be able to hit unscoped
 *     routes (/mcp, /api/*, /oauth/*) and have them transparently target
 *     their sole vault. Previously `/mcp` tried to look up a vault literally
 *     named "default" and failed. The coherence invariant from PR #111 says
 *     `/mcp` and `/vaults/:name/mcp` must behave identically for that vault.
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
  mkdirSync(join(testDir, "vaults"), { recursive: true });
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
// resolveDefaultVault — the function that powers every "unscoped" route.
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
    // No default_vault in global config.
    expect(resolveDefaultVault()).toBe("journal");
  });

  test("returns the sole vault even if default_vault points to a deleted one", () => {
    // Simulates: user had two vaults, removed the one that was the default,
    // but config.yaml still references the old name.
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

  test("does not special-case the name 'default' — a vault named 'journal' alone is the default", () => {
    // This is the Aaron-acked bug: having to go to /vaults/journal/mcp
    // when it's the only vault was confusing. Now the name doesn't matter.
    createVault("journal");
    expect(resolveDefaultVault()).toBe("journal");
    expect(listVaults()).toEqual(["journal"]);
    // And explicitly: "default" is NOT synthesized when it doesn't exist.
    expect(resolveDefaultVault()).not.toBe("default");
  });
});

// ---------------------------------------------------------------------------
// /vaults/list — Task 1: public discovery endpoint for the Daily picker.
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
    // Even with an obviously-wrong token, the endpoint must still succeed.
    // This catches a regression where we'd accidentally gate it behind auth.
    createVault("journal");
    const req = new Request("http://localhost:1940/vaults/list", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    const res = await route(req, "/vaults/list");
    expect(res.status).toBe(200);
  });

  test("rejects non-GET methods (falls through to vault-scoped 404 path)", async () => {
    // Non-GET methods on /vaults/list fall through to the /vaults/:name
    // matcher with name="list". Since no vault named "list" can exist
    // (reserved name), we get a 404. This is the expected behavior —
    // the endpoint is GET-only.
    createVault("journal");
    const req = new Request("http://localhost:1940/vaults/list", { method: "POST" });
    const res = await route(req, "/vaults/list");
    expect(res.status).toBe(404);
  });

  test("discovery disabled still allows authenticated /vaults listing (they are separate concerns)", async () => {
    // /vaults (authenticated, with metadata) is orthogonal to /vaults/list
    // (public, names only). Disabling discovery hides the public endpoint
    // but not the authenticated one.
    createVault("journal");
    writeGlobalConfig({ port: 1940, discovery: "disabled" });
    // We can at least assert that /vaults still returns 401 (auth required)
    // rather than 404 (disabled). Past that, auth is covered elsewhere.
    const req = new Request("http://localhost:1940/vaults");
    const res = await route(req, "/vaults");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Single-vault auto-default — Task 2: /mcp, /api/*, /oauth/* target the
// only vault regardless of its name.
// ---------------------------------------------------------------------------

describe("single-vault auto-default", () => {
  test("one vault named 'journal' → /mcp requires auth (would error if vault not resolvable)", async () => {
    // With one vault named "journal" and no default_vault set, /mcp must
    // still hit the MCP handler. The handler itself requires a valid
    // Bearer token — we assert 401 (auth failure), proving the request
    // reached the MCP layer and did NOT bail out with "Default vault not
    // found". Before this fix, /mcp would error because the code
    // hardcoded the fallback name "default".
    createVault("journal");
    // Deliberately no default_vault — single-vault fallback should kick in.
    const req = new Request("http://localhost:1940/mcp");
    const res = await route(req, "/mcp");
    expect(res.status).toBe(401);
  });

  test("one vault named 'journal' → /api/notes reaches auth (not 404'd)", async () => {
    createVault("journal");
    const req = new Request("http://localhost:1940/api/notes");
    const res = await route(req, "/api/notes");
    // Unauthenticated: 401 from per-vault auth. Before the fix, it would
    // have 404'd with "Default vault not found".
    expect(res.status).toBe(401);
  });

  test("one vault named 'journal' → /oauth/register reaches the OAuth handler (not 500'd)", async () => {
    createVault("journal");
    const req = new Request("http://localhost:1940/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "test", redirect_uris: ["https://x.example/cb"] }),
    });
    const res = await route(req, "/oauth/register");
    // Successful registration (201) or 400 from a validation issue —
    // either way, we're PAST the "Default vault not configured" path.
    expect(res.status).not.toBe(500);
    expect([201, 400]).toContain(res.status);
  });

  test("one vault named 'journal' → /vaults/journal/mcp still works identically (coherence invariant)", async () => {
    // This is the invariant from PR #111: the scoped and unscoped MCP paths
    // must behave identically for a single-vault deployment. Both should
    // land on the MCP auth gate and return 401 unauthenticated.
    createVault("journal");
    const unscopedReq = new Request("http://localhost:1940/mcp");
    const unscopedRes = await route(unscopedReq, "/mcp");
    const scopedReq = new Request("http://localhost:1940/vaults/journal/mcp");
    const scopedRes = await route(scopedReq, "/vaults/journal/mcp");
    expect(unscopedRes.status).toBe(scopedRes.status);
    expect(unscopedRes.status).toBe(401);
  });

  test("multiple vaults, no default_vault → /mcp returns a clear error, not a silent guess", async () => {
    createVault("journal");
    createVault("work");
    // No default_vault set.
    const req = new Request("http://localhost:1940/mcp");
    const res = await route(req, "/mcp");
    // We refuse to guess when multiple vaults exist. Hitting /mcp here
    // must NOT silently target one of them. We expect a non-200 status
    // that is not the auth gate (since resolveDefaultVault returns null,
    // we return 401 because auth runs first, but the underlying MCP
    // handler never runs — the previous test guarantees that). For the
    // /api/ path, which checks the vault before auth, we get 404.
    const apiReq = new Request("http://localhost:1940/api/notes");
    const apiRes = await route(apiReq, "/api/notes");
    expect(apiRes.status).toBe(404);
  });

  test("multiple vaults, default_vault='journal' → /api/notes targets journal", async () => {
    createVault("journal");
    createVault("work");
    writeGlobalConfig({ port: 1940, default_vault: "journal" });
    const req = new Request("http://localhost:1940/api/notes");
    const res = await route(req, "/api/notes");
    // Reaches auth (401) rather than "Default vault not found" (404).
    expect(res.status).toBe(401);
  });

  test("default_vault points to a deleted vault but one other exists → fall back to the survivor", async () => {
    createVault("journal");
    writeGlobalConfig({ port: 1940, default_vault: "deleted-vault" });
    // resolveDefaultVault ignores the stale pointer and returns journal.
    expect(resolveDefaultVault()).toBe("journal");
    // And /api/notes now routes to it — 401 from per-vault auth, not 404.
    const req = new Request("http://localhost:1940/api/notes");
    const res = await route(req, "/api/notes");
    expect(res.status).toBe(401);
  });

  test("default_vault points to a deleted vault and multiple others exist → error (no guessing)", async () => {
    createVault("journal");
    createVault("work");
    writeGlobalConfig({ port: 1940, default_vault: "deleted-vault" });
    expect(resolveDefaultVault()).toBeNull();
    const req = new Request("http://localhost:1940/api/notes");
    const res = await route(req, "/api/notes");
    expect(res.status).toBe(404);
  });

  test("no vaults exist → /mcp returns auth error (MCP handler short-circuits on empty global config)", async () => {
    // Edge case: /mcp runs global auth first. With no vaults and no keys,
    // auth fails → 401. This is fine — the handler never sees the empty
    // state. We assert we never return 500.
    const req = new Request("http://localhost:1940/mcp");
    const res = await route(req, "/mcp");
    expect(res.status).not.toBe(500);
  });

  test("empty config file (no default_vault) with single vault — existing deployments keep working", async () => {
    // Migration concern: users with a config.yaml that never had
    // default_vault set (pre-#111 deployments) should not break.
    // Drop a minimal config.yaml that only specifies port.
    writeGlobalConfig({ port: 1940 });
    createVault("my-only-vault");
    const cfg = readGlobalConfig();
    expect(cfg.default_vault).toBeUndefined();
    // /api/notes still routes to my-only-vault via single-vault fallback.
    const req = new Request("http://localhost:1940/api/notes");
    const res = await route(req, "/api/notes");
    expect(res.status).toBe(401); // reached per-vault auth
  });
});

// ---------------------------------------------------------------------------
// RFC 9728 WWW-Authenticate challenge on MCP 401.
//
// Claude Code's MCP SDK (and any other strict RFC 9728 client) requires the
// server to emit `WWW-Authenticate: Bearer resource_metadata="..."` on 401
// so the client knows which protected-resource metadata document applies to
// the endpoint it just hit. Without it, clients fall back to probing the
// root `/.well-known/oauth-protected-resource`, get `resource: <base>/mcp`,
// and reject any connection to `/vaults/<name>/mcp` as a resource mismatch.
// ---------------------------------------------------------------------------

describe("MCP 401 WWW-Authenticate challenge (RFC 9728)", () => {
  test("unscoped /mcp 401 carries the root protected-resource pointer", async () => {
    createVault("journal");
    const req = new Request("http://localhost:1940/mcp");
    const res = await route(req, "/mcp");
    expect(res.status).toBe(401);
    const header = res.headers.get("WWW-Authenticate");
    expect(header).toBe(
      'Bearer resource_metadata="http://localhost:1940/.well-known/oauth-protected-resource"',
    );
  });

  test("scoped /vaults/{name}/mcp 401 carries the vault-scoped pointer", async () => {
    createVault("journal");
    const req = new Request("http://localhost:1940/vaults/journal/mcp");
    const res = await route(req, "/vaults/journal/mcp");
    expect(res.status).toBe(401);
    const header = res.headers.get("WWW-Authenticate");
    expect(header).toBe(
      'Bearer resource_metadata="http://localhost:1940/vaults/journal/.well-known/oauth-protected-resource"',
    );
  });

  test("challenge points at the same PRM document the server actually serves", async () => {
    // Belt-and-braces: whatever we advertise in the header MUST line up with
    // what `/.well-known/oauth-protected-resource` actually returns. If these
    // drift, a conforming client will chase the pointer, fetch the PRM, then
    // reject on resource mismatch anyway. Test both directions.
    createVault("journal");

    // Scoped: header points at /vaults/journal/.well-known/...
    const scopedReq = new Request("http://localhost:1940/vaults/journal/mcp");
    const scopedRes = await route(scopedReq, "/vaults/journal/mcp");
    const scopedHeader = scopedRes.headers.get("WWW-Authenticate")!;
    const scopedPrmUrl = scopedHeader.match(/resource_metadata="([^"]+)"/)![1];
    // Fetch that PRM. Bypass the full URL by extracting the path.
    const prmPath = new URL(scopedPrmUrl).pathname;
    const prmRes = await route(new Request(`http://localhost:1940${prmPath}`), prmPath);
    expect(prmRes.status).toBe(200);
    const prm = (await prmRes.json()) as { resource: string };
    expect(prm.resource).toBe("http://localhost:1940/vaults/journal/mcp");

    // Unscoped: header points at root /.well-known/...
    const unscopedReq = new Request("http://localhost:1940/mcp");
    const unscopedRes = await route(unscopedReq, "/mcp");
    const unscopedHeader = unscopedRes.headers.get("WWW-Authenticate")!;
    const unscopedPrmUrl = unscopedHeader.match(/resource_metadata="([^"]+)"/)![1];
    const unscopedPrmPath = new URL(unscopedPrmUrl).pathname;
    const unscopedPrmRes = await route(
      new Request(`http://localhost:1940${unscopedPrmPath}`),
      unscopedPrmPath,
    );
    expect(unscopedPrmRes.status).toBe(200);
    const unscopedPrm = (await unscopedPrmRes.json()) as { resource: string };
    expect(unscopedPrm.resource).toBe("http://localhost:1940/mcp");
  });

  test("MCP 401 with invalid token still carries the challenge", async () => {
    // The no-token case is one 401 code path (extractApiKey returns null);
    // the invalid-token case is another (extractApiKey returns a string but
    // resolveToken / validateKey all fail). Both must emit the header.
    createVault("journal");
    const req = new Request("http://localhost:1940/vaults/journal/mcp", {
      headers: { Authorization: "Bearer pvt_not-a-real-token" },
    });
    const res = await route(req, "/vaults/journal/mcp");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:1940/vaults/journal/.well-known/oauth-protected-resource"',
    );
  });

  test("non-MCP 401s do NOT carry the challenge (spec is MCP-only)", async () => {
    // The RFC 9728 challenge header is specific to the MCP resource; plain
    // REST endpoints are not OAuth resources in the same sense. A spurious
    // challenge here could confuse non-MCP clients and makes the /api
    // surface look OAuth-gated when it is not.
    createVault("journal");

    // /api/notes (unscoped) — 401, no challenge.
    const unscopedApi = await route(new Request("http://localhost:1940/api/notes"), "/api/notes");
    expect(unscopedApi.status).toBe(401);
    expect(unscopedApi.headers.get("WWW-Authenticate")).toBeNull();

    // /vaults/journal/api/notes (scoped) — 401, no challenge. This is the
    // code path that shares the auth check with the scoped MCP branch, so
    // if we leak the header here the isScopedMcp gate has regressed.
    const scopedApi = await route(
      new Request("http://localhost:1940/vaults/journal/api/notes"),
      "/vaults/journal/api/notes",
    );
    expect(scopedApi.status).toBe(401);
    expect(scopedApi.headers.get("WWW-Authenticate")).toBeNull();

    // /vaults (authenticated listing) — 401, no challenge.
    const vaultsList = await route(new Request("http://localhost:1940/vaults"), "/vaults");
    expect(vaultsList.status).toBe(401);
    expect(vaultsList.headers.get("WWW-Authenticate")).toBeNull();
  });

  test("x-forwarded-host and x-forwarded-proto shape the challenge URL", async () => {
    // Remote deployments behind Cloudflare Tunnel / Tailscale Funnel / any
    // reverse proxy need the challenge URL to match the external origin,
    // not the 127.0.0.1:1940 the server actually binds. Parallels how the
    // /.well-known/* endpoints already honor these headers.
    createVault("journal");
    const req = new Request("http://127.0.0.1:1940/vaults/journal/mcp", {
      headers: {
        "x-forwarded-host": "vault.example.com",
        "x-forwarded-proto": "https",
      },
    });
    const res = await route(req, "/vaults/journal/mcp");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://vault.example.com/vaults/journal/.well-known/oauth-protected-resource"',
    );
  });
});

// ---------------------------------------------------------------------------
// RFC 8414 §3.1 / RFC 9728 §3 path-insertion discovery.
//
// For a resource at `/vaults/<name>/mcp`, the spec-mandated metadata URLs are
//   /.well-known/oauth-authorization-server/vaults/<name>[/mcp]
//   /.well-known/oauth-protected-resource/vaults/<name>[/mcp]
// rather than the path-append form
//   /vaults/<name>/.well-known/<type>
// that PR #111 also ships. Strict clients (including Claude Code's MCP OAuth
// SDK) probe only the path-insertion form; lax clients try path-append. We
// serve both so any conformant probe hits a live endpoint.
// ---------------------------------------------------------------------------

describe("path-insertion OAuth discovery (RFC 8414 §3.1 / RFC 9728 §3)", () => {
  test("/.well-known/oauth-authorization-server/vaults/<name> returns vault-scoped AS metadata", async () => {
    createVault("journal");
    const path = "/.well-known/oauth-authorization-server/vaults/journal";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };
    // All four endpoints must be vault-scoped — otherwise Claude Code's
    // registration_endpoint falls back to root `/register` and cascades 404.
    expect(body.issuer).toBe("http://localhost:1940/vaults/journal");
    expect(body.authorization_endpoint).toBe("http://localhost:1940/vaults/journal/oauth/authorize");
    expect(body.token_endpoint).toBe("http://localhost:1940/vaults/journal/oauth/token");
    expect(body.registration_endpoint).toBe("http://localhost:1940/vaults/journal/oauth/register");
  });

  test("/.well-known/oauth-authorization-server/vaults/<name>/mcp (longer form) also returns AS metadata", async () => {
    // Aaron's log shows Claude Code probes this longer form too; cheap to
    // support since it resolves to the same AS for the same vault.
    createVault("journal");
    const path = "/.well-known/oauth-authorization-server/vaults/journal/mcp";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string; registration_endpoint: string };
    expect(body.issuer).toBe("http://localhost:1940/vaults/journal");
    expect(body.registration_endpoint).toBe("http://localhost:1940/vaults/journal/oauth/register");
  });

  test("/.well-known/oauth-protected-resource/vaults/<name> returns vault-scoped PRM", async () => {
    createVault("journal");
    const path = "/.well-known/oauth-protected-resource/vaults/journal";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("http://localhost:1940/vaults/journal/mcp");
    expect(body.authorization_servers).toEqual(["http://localhost:1940/vaults/journal"]);
  });

  test("/.well-known/oauth-protected-resource/vaults/<name>/mcp (longer form) also returns PRM", async () => {
    createVault("journal");
    const path = "/.well-known/oauth-protected-resource/vaults/journal/mcp";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe("http://localhost:1940/vaults/journal/mcp");
  });

  test("path-insertion and path-append forms return identical metadata", async () => {
    // The coherence guarantee: a client that follows either spec shape MUST
    // land on the same AS config. If these drift, a mixed-toolchain deploy
    // (CLI using one form, daemon using the other) would mint tokens
    // against inconsistent endpoints.
    createVault("journal");

    // AS metadata
    const insertAsPath = "/.well-known/oauth-authorization-server/vaults/journal";
    const appendAsPath = "/vaults/journal/.well-known/oauth-authorization-server";
    const insertAsRes = await route(new Request(`http://localhost:1940${insertAsPath}`), insertAsPath);
    const appendAsRes = await route(new Request(`http://localhost:1940${appendAsPath}`), appendAsPath);
    expect(await insertAsRes.json()).toEqual(await appendAsRes.json());

    // PRM
    const insertPrmPath = "/.well-known/oauth-protected-resource/vaults/journal";
    const appendPrmPath = "/vaults/journal/.well-known/oauth-protected-resource";
    const insertPrmRes = await route(new Request(`http://localhost:1940${insertPrmPath}`), insertPrmPath);
    const appendPrmRes = await route(new Request(`http://localhost:1940${appendPrmPath}`), appendPrmPath);
    expect(await insertPrmRes.json()).toEqual(await appendPrmRes.json());
  });

  test("unknown vault in path-insertion URL returns 404, not boilerplate metadata", async () => {
    // Don't leak metadata for phantom vaults. The equivalent path-append
    // route also 404s when the vault doesn't exist (`readVaultConfig` miss
    // at the vault-scoped routes branch); path-insertion must match.
    createVault("journal");
    for (const path of [
      "/.well-known/oauth-authorization-server/vaults/nonexistent",
      "/.well-known/oauth-authorization-server/vaults/nonexistent/mcp",
      "/.well-known/oauth-protected-resource/vaults/nonexistent",
      "/.well-known/oauth-protected-resource/vaults/nonexistent/mcp",
    ]) {
      const res = await route(new Request(`http://localhost:1940${path}`), path);
      expect(res.status).toBe(404);
    }
  });

  test("x-forwarded-* headers propagate into the generated metadata URLs", async () => {
    // Same contract as the WWW-Authenticate challenge and the root/append
    // discovery endpoints: metadata must match the public-facing origin so
    // a Cloudflare Tunnel / Tailscale Funnel deployment doesn't advertise
    // internal localhost:1940 URLs.
    createVault("journal");
    const path = "/.well-known/oauth-authorization-server/vaults/journal";
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
    expect(body.issuer).toBe("https://vault.example.com/vaults/journal");
    expect(body.registration_endpoint).toBe(
      "https://vault.example.com/vaults/journal/oauth/register",
    );
  });

  test("end-to-end flow: WWW-Authenticate → PRM → AS metadata → registration_endpoint is live", async () => {
    // The actual Claude-Code bug: on 401, follow the challenge to the PRM,
    // then follow PRM.authorization_servers[0] to the AS metadata (via
    // path-insertion), then hit the `registration_endpoint`. Every hop
    // must resolve — before the fix, the AS-metadata-via-path-insertion
    // step 404'd and the SDK fell back to `/register` which also 404'd.
    createVault("journal");

    // Step 1: unauthenticated MCP → 401 + WWW-Authenticate.
    const mcpRes = await route(
      new Request("http://localhost:1940/vaults/journal/mcp"),
      "/vaults/journal/mcp",
    );
    expect(mcpRes.status).toBe(401);
    const challenge = mcpRes.headers.get("WWW-Authenticate")!;
    const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)![1];

    // Step 2: fetch PRM. The challenge points at the path-append form, but
    // a strict client might also try path-insertion — both must work.
    // Follow the advertised URL (path-append in this case) and note the
    // authorization_servers pointer.
    const prmPath = new URL(prmUrl).pathname;
    const prmRes = await route(new Request(`http://localhost:1940${prmPath}`), prmPath);
    expect(prmRes.status).toBe(200);
    const prm = (await prmRes.json()) as { authorization_servers: string[] };
    const asBase = prm.authorization_servers[0]; // "http://localhost:1940/vaults/journal"

    // Step 3: strict-client path-insertion probe for AS metadata.
    const asBasePath = new URL(asBase).pathname; // "/vaults/journal"
    const asInsertPath = `/.well-known/oauth-authorization-server${asBasePath}`;
    const asRes = await route(
      new Request(`http://localhost:1940${asInsertPath}`),
      asInsertPath,
    );
    // This was the 404 before the fix — the reason Claude Code's SDK gave
    // up and cascade-404'd on `/register`.
    expect(asRes.status).toBe(200);
    const asMeta = (await asRes.json()) as { registration_endpoint: string };

    // Step 4: the advertised registration_endpoint must be live (POST-only).
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
    // Successful DCR is 201; anything but 404 proves the endpoint is wired.
    expect(regRes.status).toBe(201);
  });
});
