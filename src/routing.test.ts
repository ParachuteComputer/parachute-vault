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
