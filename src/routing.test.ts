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

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const testDir = join(
  tmpdir(),
  `vault-routing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.PARACHUTE_HOME = testDir;

// Dynamic import after env override so modules pick up the tmp dir.
const { route, filterVaultListForBinding } = await import("./routing.ts");
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
const { vaultDbPath } = await import("./config.ts");
const { resetJwksCache, resetRevocationCache } = await import("./hub-jwt.ts");
const { invalidateUsageCache } = await import("./usage.ts");

// ---------------------------------------------------------------------------
// Hub-JWT mint fixture (vault#282 Stage 2 — vault is a pure hub
// resource-server, so the only mintable user credential is a hub JWT). A fake
// hub serves JWKS + an empty revocation list; `mintJwt` signs tokens with the
// requested narrowed scope so the scope-enforcement matrix below exercises the
// surviving credential. The scope shape is `vault:<name>:<verb>` (narrowed) —
// the granted_scopes assertions reflect that.
// ---------------------------------------------------------------------------

let hubServer: ReturnType<typeof Bun.serve>;
let signingKey: CryptoKey;
let publicJwk: Record<string, unknown>;
let hubFixtureOrigin = "";
const KID = "routing-test-k1";

async function mintJwt(opts: {
  vaultName: string;
  scopes: string[];
  scopedTags?: string[];
}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    scope: opts.scopes.join(" "),
    client_id: "routing-test",
  };
  if (opts.scopedTags && opts.scopedTags.length > 0) {
    payload.permissions = { scoped_tags: opts.scopedTags };
  }
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(hubServer ? `http://127.0.0.1:${hubServer.port}` : "")
    .setSubject("routing-test-user")
    .setAudience(`vault.${opts.vaultName}`)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .setJti(`jti-${Math.random().toString(36).slice(2)}`)
    .sign(signingKey);
}

/** Mint a narrowed hub JWT carrying every vault verb (admin) for `vaultName`. */
function createAdminToken(vaultName: string): Promise<string> {
  return mintJwt({ vaultName, scopes: [`vault:${vaultName}:admin`] });
}

function createVault(name: string, description?: string): void {
  writeVaultConfig({
    name,
    api_keys: [],
    created_at: new Date().toISOString(),
    description,
  });
}

/**
 * Seed a vestigial row directly into a vault's `tokens` table (raw INSERT).
 * Post-0.5.0 (vault#282 Stage 2) vault no longer mints these, but the table
 * survives + `/auth/status` probes it for leftover pre-0.5.0 rows. This is how
 * we exercise the `hasTokens=true` branch now that there's no mint path.
 */
function seedVestigialTokenRow(vaultName: string): void {
  const store = getVaultStore(vaultName);
  store.db
    .prepare("INSERT INTO tokens (token_hash, label, permission, created_at) VALUES (?, ?, ?, ?)")
    .run(`sha256:vestigial-${Math.random().toString(36).slice(2)}`, "leftover", "full", new Date().toISOString());
}

/**
 * Seed a vestigial tag-scoped row (raw INSERT, `scoped_tags` JSON populated).
 * The tag-delete / -rename / -merge fail-closed guard (`findTokensReferencingTag`)
 * reads this column. Post-0.5.0 hub-JWT tag scopes live in the JWT claim, not
 * the DB, so the guard now protects only these vestigial rows — these tests
 * pin that the DB-row guard still fires.
 */
function seedTagScopedRow(vaultName: string, scopedTags: string[], label = "test-tag-scoped"): void {
  const store = getVaultStore(vaultName);
  store.db
    .prepare(
      "INSERT INTO tokens (token_hash, label, permission, scoped_tags, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      `sha256:tagscoped-${Math.random().toString(36).slice(2)}`,
      label,
      "read",
      JSON.stringify(scopedTags),
      new Date().toISOString(),
    );
}

function reset(): void {
  clearVaultStoreCache();
  // The usage dir-walk cache is module-level (process-wide) and survives the
  // testDir wipe; its 60s TTL would otherwise leak a prior test's `journal`
  // entry into the next test and flip a "first read" to cached:true. Clear
  // the vault names these tests reuse so each test starts cache-cold.
  invalidateUsageCache("journal");
  invalidateUsageCache("other");
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "vault", "data"), { recursive: true });
  writeGlobalConfig({ port: 1940 });
  // Default every test to the fixture hub origin so the hub-JWT mint path
  // resolves JWKS + validates `iss`. Describes that assert the loopback
  // default (OAuth discovery metadata) override this in their own beforeEach.
  if (hubFixtureOrigin) {
    process.env.PARACHUTE_HUB_ORIGIN = hubFixtureOrigin;
    // Post-vault#464 the JWKS fetch origin resolves separately (loopback by
    // default); point it at the fixture so the mint path's JWKS fetch resolves.
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
      if (url.pathname === "/.well-known/jwks.json") {
        return Response.json({ keys: [publicJwk] });
      }
      if (url.pathname === "/.well-known/parachute-revocation.json") {
        return Response.json({ generated_at: new Date().toISOString(), jtis: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  hubFixtureOrigin = `http://127.0.0.1:${hubServer.port}`;
});

beforeEach(() => {
  reset();
});

afterAll(() => {
  clearVaultStoreCache();
  hubServer?.stop(true);
  delete process.env.PARACHUTE_HUB_ORIGIN;
  delete process.env.PARACHUTE_HUB_JWKS_ORIGIN;
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
// GET /vaults — authenticated metadata listing, filtered by vault binding
// (vault#259). Operator / admin-channel callers (vault_name === null) see the
// full list; a vault-bound caller sees only its own vault.
// ---------------------------------------------------------------------------

describe("GET /vaults (binding filter — vault#259)", () => {
  // Pure policy helper — drives the filtering decision independent of the
  // auth path (no current credential yields a non-null vault_name HERE, since
  // authenticateGlobalRequest 401s hub JWTs; the helper pins the correct
  // shape for any future vault-bound credential on this surface).
  test("filterVaultListForBinding: null binding (operator) keeps the full list", () => {
    const names = ["work", "boulder", "default"];
    expect(filterVaultListForBinding(names, null)).toEqual(names);
  });

  test("filterVaultListForBinding: a vault-bound caller sees only its own vault", () => {
    const names = ["work", "boulder", "default"];
    expect(filterVaultListForBinding(names, "work")).toEqual(["work"]);
    // No cross-vault info-leak: boulder/default are not disclosed.
    expect(filterVaultListForBinding(names, "work")).not.toContain("boulder");
    expect(filterVaultListForBinding(names, "work")).not.toContain("default");
  });

  test("filterVaultListForBinding: binding to a vault absent from the list yields empty", () => {
    expect(filterVaultListForBinding(["work", "default"], "ghost")).toEqual([]);
  });

  test("operator token (VAULT_AUTH_TOKEN) gets the UNFILTERED full listing", async () => {
    createVault("work");
    createVault("boulder");
    createVault("default");
    const prev = process.env.VAULT_AUTH_TOKEN;
    process.env.VAULT_AUTH_TOKEN = "op-secret-token-259";
    try {
      const req = new Request("http://localhost:1940/vaults", {
        headers: { authorization: "Bearer op-secret-token-259" },
      });
      const res = await route(req, "/vaults");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { vaults: { name: string }[] };
      const names = body.vaults.map((v) => v.name);
      expect(new Set(names)).toEqual(new Set(["work", "boulder", "default"]));
    } finally {
      if (prev === undefined) delete process.env.VAULT_AUTH_TOKEN;
      else process.env.VAULT_AUTH_TOKEN = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// /vault/<name>/admin/* — admin SPA static-file mount. Detailed tests live
// in admin-spa.test.ts (with a tmp dist dir); these pin the dispatch — i.e.
// the SPA layer fires *before* the per-vault dispatcher swallows the path.
// Per-vault mount (vault#252): the SPA used to live at /admin/* but is now
// scoped under each vault so it's reachable through hub's /vault/<name>/*
// proxy.
// ---------------------------------------------------------------------------

describe("/vault/<name>/admin/* SPA mount", () => {
  test("/vault/<name>/admin/ never returns the per-vault dispatcher's 404 JSON", async () => {
    // dist may or may not be built in CI; the dispatch check just asserts
    // that we don't fall through to the catch-all. Both 200 (dist present)
    // and 503 (dist absent) are valid SPA-layer responses.
    createVault("work");
    const req = new Request("http://localhost:1940/vault/work/admin/");
    const res = await route(req, "/vault/work/admin/");
    expect(res.status === 200 || res.status === 503).toBe(true);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  test("/vault/<name>/admin/tokens (client-routed path) reaches the SPA layer", async () => {
    createVault("work");
    const req = new Request("http://localhost:1940/vault/work/admin/tokens");
    const res = await route(req, "/vault/work/admin/tokens");
    expect(res.status === 200 || res.status === 503).toBe(true);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  test("/vault/<name>/admin fires the SPA layer even when the vault doesn't exist", async () => {
    // Admin-spa dispatch sits *before* the per-vault config check — the SPA
    // shell is static and surfaces its own auth-required state, so 404'ing
    // here would just hide the operator's typo behind the SPA layer's own
    // empty-state. Belt-and-braces: the SPA layer never reads vault config.
    const req = new Request("http://localhost:1940/vault/ghost/admin/");
    const res = await route(req, "/vault/ghost/admin/");
    expect(res.status === 200 || res.status === 503).toBe(true);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  test("POST /vault/<name>/admin/ returns 405 (no admin SPA writes today)", async () => {
    createVault("work");
    const req = new Request("http://localhost:1940/vault/work/admin/", { method: "POST" });
    const res = await route(req, "/vault/work/admin/");
    expect(res.status).toBe(405);
  });

  test("/vault/<name>/admin-foo does NOT match the admin mount", async () => {
    // Falls through to the per-vault dispatcher; the auth wall there 401s
    // before any route lookup runs, which is exactly the signal that the
    // SPA layer didn't swallow this path. (Same shape as /api/notes below.)
    createVault("work");
    const req = new Request("http://localhost:1940/vault/work/admin-foo");
    const res = await route(req, "/vault/work/admin-foo");
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // /vault/admin[/*] — DAEMON-LEVEL multi-vault SPA mount (B3, 2026-06-09
  // hub-module-boundary migration). `admin` is a reserved vault name (B2),
  // and this branch dispatches BEFORE both the per-vault SPA mount and the
  // per-vault dispatcher. Detailed serving behavior (the bare-mount 301,
  // asset strip) is pinned in admin-spa.test.ts with a tmp dist dir.
  // ---------------------------------------------------------------------

  test("/vault/admin/ fires the SPA layer, never the per-vault 'Vault not found' JSON", async () => {
    // No vault named "admin" exists (it can't — reserved). Without the
    // daemon-level branch this path would fall to the per-vault dispatcher
    // and 404 as JSON.
    const req = new Request("http://localhost:1940/vault/admin/");
    const res = await route(req, "/vault/admin/");
    expect(res.status === 200 || res.status === 503).toBe(true);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  test("/vault/admin/admin does NOT boot per-vault mode for a vault named 'admin'", async () => {
    // The per-vault regex would capture name="admin" here. The daemon-level
    // branch must win — the regexes are deliberately not merged.
    const req = new Request("http://localhost:1940/vault/admin/admin");
    const res = await route(req, "/vault/admin/admin");
    expect(res.status === 200 || res.status === 503).toBe(true);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  test("a squatted vault named 'admin' is shadowed — its data plane serves the SPA layer", async () => {
    // A vault created before the reservation landed. The daemon mount wins
    // over its entire /vault/admin/* surface (server boot warns with the
    // recovery procedure — see vault-name.ts:reservedNameSquatWarnings).
    createVault("admin");
    const req = new Request("http://localhost:1940/vault/admin/api/notes");
    const res = await route(req, "/vault/admin/api/notes");
    // The per-vault API would 401 (auth wall); the SPA layer serves the
    // static shell (200) or the unbuilt-dist 503 — never the API's JSON.
    expect(res.status === 200 || res.status === 503).toBe(true);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  test("POST /vault/admin/ returns 405 (daemon mount is GET-only)", async () => {
    const req = new Request("http://localhost:1940/vault/admin/", { method: "POST" });
    const res = await route(req, "/vault/admin/");
    expect(res.status).toBe(405);
  });

  test("/vault/adminx/* does NOT match the daemon mount — routes per-vault", async () => {
    // Exact-segment match only: a real vault whose name merely starts with
    // "admin" keeps its normal per-vault surface (the API auth wall 401s,
    // proving the per-vault dispatcher handled it).
    createVault("adminx");
    const req = new Request("http://localhost:1940/vault/adminx/api/notes");
    const res = await route(req, "/vault/adminx/api/notes");
    expect(res.status).toBe(401);
  });

  test("per-vault /vault/<real>/admin/ is unaffected by the daemon mount", async () => {
    createVault("work");
    const req = new Request("http://localhost:1940/vault/work/admin/");
    const res = await route(req, "/vault/work/admin/");
    expect(res.status === 200 || res.status === 503).toBe(true);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  test("origin-rooted /admin (legacy mount retired) returns 404", async () => {
    // Pre-vault#252 the SPA was at /admin/*. Routing now lets that fall
    // through to the catch-all — hub's directory page should link to
    // /vault/<name>/admin instead.
    const req = new Request("http://localhost:1940/admin/");
    const res = await route(req, "/admin/");
    expect(res.status).toBe(404);
  });

  test("/vault/<name>/api/notes still reaches the per-vault API (not the SPA)", async () => {
    // Regression: the SPA mount must not shadow the existing API surface.
    // No auth here — the per-vault dispatcher 401s, which is exactly the
    // signal that the request reached the API layer rather than the SPA.
    createVault("work");
    const req = new Request("http://localhost:1940/vault/work/api/notes");
    const res = await route(req, "/vault/work/api/notes");
    expect(res.status).toBe(401);
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
    expect(body.auth_modes).toEqual(["hub_jwt"]);
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

  test("vault with a vestigial token row: hasTokens=true", async () => {
    createVault("journal");
    seedVestigialTokenRow("journal");
    const res = await route(new Request("http://localhost:1940/auth/status"), "/auth/status");
    const body = (await res.json()) as { hasTokens: boolean | null };
    expect(body.hasTokens).toBe(true);
  });

  test("multiple vaults are all listed; hasTokens=true if any has a vestigial row", async () => {
    createVault("journal");
    createVault("work");
    getVaultStore("journal");
    seedVestigialTokenRow("work");
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
    seedVestigialTokenRow("alpha");
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
    seedVestigialTokenRow("journal");
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

  test("/vault/<name>/oauth/* returns 410 Gone (standalone issuer retired — workstream E)", async () => {
    // The standalone OAuth issuer on vault was removed in vault#366 once hub
    // became required. The 410 carries a pointer to the protected-resource
    // metadata so a confused client can rediscover the new issuer (the hub).
    createVault("journal");
    for (const subpath of ["/oauth/register", "/oauth/authorize", "/oauth/token"]) {
      const path = `/vault/journal${subpath}`;
      const res = await route(new Request(`http://localhost:1940${path}`), path);
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: string; protected_resource_metadata: string };
      expect(body.error).toBe("oauth_endpoint_removed");
      expect(body.protected_resource_metadata).toBe(
        "http://localhost:1940/vault/journal/.well-known/oauth-protected-resource",
      );
    }
  });

  test("unknown vault returns 404 before hitting auth", async () => {
    createVault("journal");
    for (const path of [
      "/vault/nonexistent/mcp",
      "/vault/nonexistent/api/notes",
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
// After workstream E (2026-05-25), vault is resource-server-only — hub is
// the OAuth issuer. The discovery endpoints stay served at
//   /vault/<name>/.well-known/oauth-protected-resource
//   /vault/<name>/.well-known/oauth-authorization-server
// but the metadata they return forwards every authorization-server endpoint
// to the hub origin. The `resource` URL still names the vault's MCP path
// (that's the resource being protected); the AS pointer is the hub.
//
// `PARACHUTE_HUB_ORIGIN` defaults to `http://127.0.0.1:1939` when unset
// (canonical hub loopback). Tests below assert against that default.
// ---------------------------------------------------------------------------

const HUB_ORIGIN = "http://127.0.0.1:1939";

// OAuth discovery metadata names the hub LOOPBACK default (1939) as issuer,
// which means these describes must run with PARACHUTE_HUB_ORIGIN UNSET — the
// opposite of the JWT-minting describes (which need the fixture origin
// `reset()` sets). Each discovery describe deletes the env in its own
// beforeEach (running after the top-level reset()). Caught when vault rc.1
// release CI failed with "Received: http://127.0.0.1:34295" — a leaked
// ephemeral port from a fixture; the per-describe override pins it here.
function useLoopbackHubOrigin(): void {
  beforeEach(() => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    resetJwksCache();
    resetRevocationCache();
  });
}

describe("per-vault OAuth discovery (hub-rooted after workstream E)", () => {
  useLoopbackHubOrigin();
  test("AS metadata names the hub as issuer + endpoints", async () => {
    createVault("journal");
    const path = "/vault/journal/.well-known/oauth-authorization-server";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      jwks_uri: string;
    };
    expect(body.issuer).toBe(HUB_ORIGIN);
    expect(body.authorization_endpoint).toBe(`${HUB_ORIGIN}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${HUB_ORIGIN}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${HUB_ORIGIN}/oauth/register`);
    expect(body.jwks_uri).toBe(`${HUB_ORIGIN}/.well-known/jwks.json`);
  });

  test("PRM names the vault's MCP endpoint and points at the hub as AS", async () => {
    createVault("journal");
    const path = "/vault/journal/.well-known/oauth-protected-resource";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("http://localhost:1940/vault/journal/mcp");
    expect(body.authorization_servers).toEqual([HUB_ORIGIN]);
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

  test("x-forwarded-* headers propagate into the PRM `resource` URL", async () => {
    // The resource URL still tracks the vault's external origin (it's the
    // protected resource the client just hit); the AS pointer is always the
    // hub, independent of the inbound request's origin.
    createVault("journal");
    const path = "/vault/journal/.well-known/oauth-protected-resource";
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
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("https://vault.example.com/vault/journal/mcp");
    expect(body.authorization_servers).toEqual([HUB_ORIGIN]);
  });

  test("AS metadata ignores x-forwarded-* (hub origin is config, not request-derived)", async () => {
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
    expect(body.issuer).toBe(HUB_ORIGIN);
    expect(body.registration_endpoint).toBe(`${HUB_ORIGIN}/oauth/register`);
  });

  test("end-to-end flow: WWW-Authenticate → PRM → hub AS metadata pointer", async () => {
    // On 401, follow the challenge to the PRM, then read
    // PRM.authorization_servers[0] — it must point at the hub origin. The
    // hub side of the test (fetching the AS metadata at the hub itself)
    // lives in hub's test suite; here we just verify vault stops at the
    // right pointer.
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

    // Step 3: the AS pointer is the hub. Clients drive the flow from there.
    expect(prm.authorization_servers).toEqual([HUB_ORIGIN]);
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
  useLoopbackHubOrigin();
  test("AS metadata at path-insertion short form names the hub", async () => {
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
    expect(body.issuer).toBe(HUB_ORIGIN);
    expect(body.authorization_endpoint).toBe(`${HUB_ORIGIN}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${HUB_ORIGIN}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${HUB_ORIGIN}/oauth/register`);
  });

  test("AS metadata at path-insertion long form (/mcp suffix) also works", async () => {
    // Some SDKs probe with the exact resource path appended. The optional
    // `/mcp` suffix covers that.
    createVault("journal");
    const path = "/.well-known/oauth-authorization-server/vault/journal/mcp";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string };
    expect(body.issuer).toBe(HUB_ORIGIN);
  });

  test("PRM at path-insertion short form returns vault-scoped resource", async () => {
    createVault("journal");
    const path = "/.well-known/oauth-protected-resource/vault/journal";
    const res = await route(new Request(`http://localhost:1940${path}`), path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("http://localhost:1940/vault/journal/mcp");
    expect(body.authorization_servers).toEqual([HUB_ORIGIN]);
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

  test("AS metadata at path-insertion is hub-rooted regardless of x-forwarded-*", async () => {
    // Hub origin is configuration, not request-derived. Proxies forwarding
    // x-forwarded-host don't override the issuer.
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
    expect(body.issuer).toBe(HUB_ORIGIN);
    expect(body.registration_endpoint).toBe(`${HUB_ORIGIN}/oauth/register`);
  });

  test("end-to-end: 401 → PRM (path-insertion) → AS pointer is the hub", async () => {
    // Exact handshake Claude Code's MCP OAuth SDK performs. After
    // workstream E the chain stops at "AS = hub origin"; the live
    // registration_endpoint lives on the hub (covered by hub's tests).
    // Both the path-append PRM (named by the WWW-Authenticate challenge)
    // and the path-insertion PRM (what strict clients probe) must
    // return the same hub pointer.
    createVault("journal");

    // Step 1: unauth MCP → 401 + WWW-Authenticate with PRM pointer.
    const mcpPath = "/vault/journal/mcp";
    const mcpRes = await route(new Request(`http://localhost:1940${mcpPath}`), mcpPath);
    expect(mcpRes.status).toBe(401);
    const challenge = mcpRes.headers.get("WWW-Authenticate")!;
    const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)![1];

    // Step 2: path-insertion PRM also resolves and names the hub.
    const prmInsertPath = "/.well-known/oauth-protected-resource/vault/journal";
    const prmRes = await route(
      new Request(`http://localhost:1940${prmInsertPath}`),
      prmInsertPath,
    );
    expect(prmRes.status).toBe(200);
    const prm = (await prmRes.json()) as { authorization_servers: string[] };
    expect(prm.authorization_servers).toEqual([HUB_ORIGIN]);

    // Step 3: AS metadata via path-insertion on the vault path returns
    // hub-rooted endpoints — strict clients that probe AS via the vault
    // path (rather than following the PRM pointer) still land at the hub.
    const asInsertPath = `/.well-known/oauth-authorization-server/vault/journal`;
    const asRes = await route(
      new Request(`http://localhost:1940${asInsertPath}`),
      asInsertPath,
    );
    expect(asRes.status).toBe(200);
    const asMeta = (await asRes.json()) as { issuer: string; registration_endpoint: string };
    expect(asMeta.issuer).toBe(HUB_ORIGIN);
    expect(asMeta.registration_endpoint).toBe(`${HUB_ORIGIN}/oauth/register`);

    // Step 4: path-append PRM URL in the challenge header still resolves
    // and agrees with the path-insertion answer.
    const prmAppendRes = await route(
      new Request(prmUrl),
      new URL(prmUrl).pathname,
    );
    expect(prmAppendRes.status).toBe(200);
    const prmAppend = (await prmAppendRes.json()) as { authorization_servers: string[] };
    expect(prmAppend.authorization_servers).toEqual([HUB_ORIGIN]);
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
    };
    expect(body).toEqual({
      name: "parachute-vault",
      displayName: "Vault",
      tagline: expect.stringContaining("knowledge graph"),
      version: pkg.version,
      iconUrl: "/vault/journal/.parachute/icon.svg",
    });
    // `kind` retired from the info-endpoint response per hub#330 (companion
    // to vault#359's module.json drop). Pin its absence so regressions are
    // surfaced — the shape is a locked contract with the hub.
    expect(body).not.toHaveProperty("kind");
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
    expect(body.properties.autoTranscribe?.type).toBe("object");
    // vault#478 scope boundary: daemon-GLOBAL fields are NOT described by the
    // per-vault admin config schema. The per-vault admin surface is "admin
    // over *your* vault only" — port / scribe URL / scribe bearer are
    // deployment-wide and live behind the operator-only surface.
    expect(body.properties).not.toHaveProperty("scribe_url");
    expect(body.properties).not.toHaveProperty("scribe_token");
    expect(body.properties).not.toHaveProperty("port");
  });

  test("config returns ONLY per-vault values, never daemon-global ones (scope boundary, vault#478)", async () => {
    createVault("journal");
    const token = await createAdminToken("journal");
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
      // Per-vault config is present.
      expect(body.audio_retention).toBe("keep"); // default when unset
      expect(body).toHaveProperty("autoTranscribe");
      // Daemon-GLOBAL values must NOT cross the per-vault admin boundary.
      expect(body).not.toHaveProperty("port");
      expect(body).not.toHaveProperty("scribe_url");
      // The discovery-resolved scribe URL is daemon-global → must not leak,
      // even nested under autoTranscribe.
      const at = body.autoTranscribe as Record<string, unknown>;
      expect(at).not.toHaveProperty("scribeUrl");
      // writeOnly field must not appear in GET.
      expect(body).not.toHaveProperty("scribe_token");
      // Defense in depth: no daemon-global value (URL or secret) anywhere.
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("super-secret-should-never-appear");
      expect(raw).not.toContain("https://scribe.example/v1");
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
    const token = await createAdminToken("journal");
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

  test("autoTranscribe.enabled reports the per-vault override (vault#478)", async () => {
    // Server default ON; this vault explicitly opts OUT — the per-vault value
    // must win, proving the field is reported per-vault (not the raw global).
    writeGlobalConfig({ port: 1940, auto_transcribe: { enabled: true } });
    writeVaultConfig({
      name: "journal",
      api_keys: [],
      created_at: new Date().toISOString(),
      auto_transcribe: { enabled: false },
    });
    const token = await createAdminToken("journal");
    const path = "/vault/journal/.parachute/config";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      path,
    );
    const body = (await res.json()) as { autoTranscribe: { enabled: boolean } };
    expect(body.autoTranscribe.enabled).toBe(false);
    writeGlobalConfig({ port: 1940 });
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
    const fullToken = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:read"] });
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
  /**
   * Mint a bearer for the scope-enforcement matrix.
   *
   * - Default: a hub JWT with the requested scopes NARROWED to
   *   `vault:<name>:<verb>` (vault#282 Stage 2 — the surviving user credential).
   * - `legacyNullScopes`: a legacy YAML api_key (vault.yaml), the surviving
   *   "legacy-derived" credential. A `read` scope key resolves to read
   *   permission; a `write` key to full. `permission='full'` maps to a write
   *   YAML key, `permission='read'` to a read one.
   */
  async function mintToken(
    vaultName: string,
    opts: {
      permission: "full" | "read";
      scopes?: string[];
      legacyNullScopes?: boolean;
    },
  ): Promise<string> {
    if (opts.legacyNullScopes) {
      const { hashKey, generateApiKey } = require("./config.ts");
      const { fullKey, keyId } = generateApiKey();
      const scope = opts.permission === "read" ? "read" : "write";
      writeVaultConfig({
        name: vaultName,
        api_keys: [
          {
            id: keyId,
            label: `legacy-${opts.permission}`,
            scope,
            key_hash: hashKey(fullKey),
            created_at: new Date().toISOString(),
          },
        ],
        created_at: new Date().toISOString(),
      });
      return fullKey;
    }
    const narrowed = (opts.scopes ?? [`vault:${opts.permission === "read" ? "read" : "admin"}`]).map(
      (s) => s.replace(/^vault:/, `vault:${vaultName}:`),
    );
    return mintJwt({ vaultName, scopes: narrowed });
  }

  function authed(token: string, method = "GET", path: string): Request {
    return new Request(`http://localhost:1940${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  test("vault:read token permits GET /api/vault", async () => {
    createVault("journal");
    const token = await mintToken("journal", {
      permission: "read",
      scopes: ["vault:read"],
    });
    const path = "/vault/journal/api/vault";
    const res = await route(authed(token, "GET", path), path);
    expect(res.status).toBe(200);
  });

  test("vault:read token rejected on POST /api/notes with 403 insufficient_scope", async () => {
    createVault("journal");
    const token = await mintToken("journal", {
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
    expect(body.granted_scopes).toEqual(["vault:journal:read"]);
  });

  test("vault:write token permits GET (inheritance: write ⊇ read)", async () => {
    createVault("journal");
    const token = await mintToken("journal", {
      permission: "full",
      scopes: ["vault:write"],
    });
    const path = "/vault/journal/api/vault";
    const res = await route(authed(token, "GET", path), path);
    expect(res.status).toBe(200);
  });

  test("vault:write token permits POST /api/notes", async () => {
    createVault("journal");
    const token = await mintToken("journal", {
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
    const token = await mintToken("journal", {
      permission: "full",
      scopes: ["vault:admin"],
    });
    const path = "/vault/journal/.parachute/config";
    const res = await route(authed(token, "GET", path), path);
    expect(res.status).toBe(200);
  });

  test("vault:admin token permits GET + POST via inheritance", async () => {
    createVault("journal");
    const token = await mintToken("journal", {
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
    const token = await mintToken("journal", {
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
    const token = await mintToken("journal", {
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
  ): Promise<string> {
    // Hub JWT with a narrowed scope + `permissions.scoped_tags` claim — the
    // tag-allowlist now rides the JWT permissions claim (C0), not a vault-DB
    // column (vault#282 Stage 2).
    const narrowed = scopes.map((s) => s.replace(/^vault:/, `vault:${vaultName}:`));
    return mintJwt({ vaultName, scopes: narrowed, scopedTags });
  }

  test("tag-scoped read token: GET /api/notes/:id 404s on out-of-scope note (no existence leak)", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    const inScope = await store.createNote("h", { tags: ["health"] });
    const outOfScope = await store.createNote("w", { tags: ["work"] });
    const token = await mintTagScopedToken("journal", ["vault:read"], ["health"]);

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
    const token = await mintTagScopedToken("journal", ["vault:read"], ["health"]);

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
    const token = await mintTagScopedToken("journal", ["vault:read"], ["health"]);

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
    const token = await mintTagScopedToken("journal", ["vault:read", "vault:write"], ["health"]);

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
    const token = await mintTagScopedToken("journal", ["vault:read", "vault:write"], ["health"]);

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
    const token = await mintTagScopedToken("journal", ["vault:read", "vault:write"], ["health"]);

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
    const token = await mintTagScopedToken("journal", ["vault:read"], ["health"]);

    const path = `/vault/journal/api/notes/${orphan.id}`;
    const res = await route(authed(token, "GET", path), path);
    expect(res.status).toBe(200);
  });

  test("tag-scoped write token: orphan sub-tag write succeeds via string-form root", async () => {
    createVault("journal");
    const token = await mintTagScopedToken("journal", ["vault:read", "vault:write"], ["health"]);

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

  // ----- vault#439: near[] BFS is a WALL, not a sieve --------------------
  // For a tag-scoped token the graph traversal must refuse to walk THROUGH
  // an out-of-scope note. So an in-scope note reachable ONLY via an
  // out-of-scope intermediary is unreachable — symmetric with find-path.
  // Topology: A(#work) --link--> P(#personal) --link--> B(#work).
  // A token scoped to ["work"] anchored at A, depth 2:
  //   - sieve (old): B survives (reached via P, then output-filtered to keep B)
  //   - wall (new):  P is the wall; B is never reached.

  test("vault#439: tag-scoped near[] cannot reach an in-scope note through an out-of-scope hop", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    const a = await store.createNote("anchor-work", { tags: ["work"] });
    const p = await store.createNote("bridge-personal", { tags: ["personal"] });
    const b = await store.createNote("far-work", { tags: ["work"] });
    await store.createLink(a.id, p.id, "relates");
    await store.createLink(p.id, b.id, "relates");
    const token = await mintTagScopedToken("journal", ["vault:read"], ["work"]);

    // `route`'s second arg is the pathname only; the query rides on req.url.
    const pathname = "/vault/journal/api/notes";
    const full = `${pathname}?near[note_id]=${a.id}&near[depth]=2`;
    const res = await route(authed(token, "GET", full), pathname);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes?: { id: string }[] } | { id: string }[];
    const list = Array.isArray(body) ? body : (body.notes ?? []);
    const ids = list.map((n) => n.id);
    // B is in-scope (#work) but only reachable via the out-of-scope #personal
    // bridge — the wall makes it unreachable.
    expect(ids).not.toContain(b.id);
    // P itself never leaks (it's out of scope).
    expect(ids).not.toContain(p.id);
  });

  test("vault#439: tag-scoped near[] still reaches in-scope notes via in-scope hops", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    const a = await store.createNote("anchor-work", { tags: ["work"] });
    const mid = await store.createNote("mid-work", { tags: ["work"] });
    const far = await store.createNote("far-work", { tags: ["work"] });
    await store.createLink(a.id, mid.id, "relates");
    await store.createLink(mid.id, far.id, "relates");
    const token = await mintTagScopedToken("journal", ["vault:read"], ["work"]);

    const pathname = "/vault/journal/api/notes";
    const full = `${pathname}?near[note_id]=${a.id}&near[depth]=2`;
    const res = await route(authed(token, "GET", full), pathname);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes?: { id: string }[] } | { id: string }[];
    const list = Array.isArray(body) ? body : (body.notes ?? []);
    const ids = list.map((n) => n.id);
    // All-in-scope path: both mid (depth 1) and far (depth 2) are reachable.
    expect(ids).toContain(mid.id);
    expect(ids).toContain(far.id);
  });

  test("vault#439: UNSCOPED token near[] still walks the full graph (behavior unchanged)", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    const a = await store.createNote("anchor-work", { tags: ["work"] });
    const p = await store.createNote("bridge-personal", { tags: ["personal"] });
    const b = await store.createNote("far-work", { tags: ["work"] });
    await store.createLink(a.id, p.id, "relates");
    await store.createLink(p.id, b.id, "relates");
    // No scopedTags → unscoped admin token; no wall installed.
    const token = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:admin"] });

    const pathname = "/vault/journal/api/notes";
    const full = `${pathname}?near[note_id]=${a.id}&near[depth]=2`;
    const res = await route(authed(token, "GET", full), pathname);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes?: { id: string }[] } | { id: string }[];
    const list = Array.isArray(body) ? body : (body.notes ?? []);
    const ids = list.map((n) => n.id);
    // Unscoped: the full neighborhood is visible, including the #personal
    // bridge and the note beyond it.
    expect(ids).toContain(p.id);
    expect(ids).toContain(b.id);
  });

  // ----- vault#404: REST-path hub-JWT tag-scoping enforcement (C0) --------
  // The MCP path's tag-scope enforcement is covered end-to-end; pin that a
  // tag-scoped HUB JWT (allowlist carried in the `permissions.scoped_tags`
  // claim, NOT a vestigial DB row) hitting the REST surface enforces the
  // same allowlist on both read and write. `mintTagScopedToken` mints a real
  // hub JWT, so these tests exercise the hub-JWT-sourced `scoped_tags` path.

  test("vault#404: hub-JWT tag-scoped READ via REST enforces the allowlist (list + single)", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    const inScope = await store.createNote("h", { tags: ["health"] });
    const outOfScope = await store.createNote("w", { tags: ["work"] });
    const token = await mintTagScopedToken("journal", ["vault:read"], ["health"]);

    // List: only in-scope notes.
    const listPath = "/vault/journal/api/notes";
    const listRes = await route(authed(token, "GET", listPath), listPath);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { notes?: { id: string }[] } | { id: string }[];
    const list = Array.isArray(listBody) ? listBody : (listBody.notes ?? []);
    const ids = list.map((n) => n.id);
    expect(ids).toContain(inScope.id);
    expect(ids).not.toContain(outOfScope.id);

    // Single in-scope → 200; single out-of-scope → 404 (no existence leak).
    const okPath = `/vault/journal/api/notes/${inScope.id}`;
    expect((await route(authed(token, "GET", okPath), okPath)).status).toBe(200);
    const denyPath = `/vault/journal/api/notes/${outOfScope.id}`;
    expect((await route(authed(token, "GET", denyPath), denyPath)).status).toBe(404);
  });

  test("vault#404: hub-JWT tag-scoped WRITE via REST enforces the allowlist", async () => {
    createVault("journal");
    const token = await mintTagScopedToken("journal", ["vault:read", "vault:write"], ["health"]);

    // In-scope write → 201.
    const path = "/vault/journal/api/notes";
    const okRes = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: "ok", tags: ["health"] }),
      }),
      path,
    );
    expect(okRes.status).toBe(201);

    // Out-of-scope write → 403 tag_scope_violation.
    const denyRes = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: "denied", tags: ["work"] }),
      }),
      path,
    );
    expect(denyRes.status).toBe(403);
    const denyBody = (await denyRes.json()) as { error_type?: string };
    expect(denyBody.error_type).toBe("tag_scope_violation");
  });

  // ----- Q5: tag-delete dependency check ---------------------------------
  // Deleting a tag referenced by any token's scoped_tags would silently
  // orphan the token's allowlist; fail closed with 409 + referenced_by.

  test("DELETE /api/tags/:name → 409 when a tag-scoped token references it", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("h", { tags: ["health"] });
    // Seed a vestigial tag-scoped row referencing `health`, then try to delete
    // `health` with an admin token — the DB-row guard must 409.
    seedTagScopedRow("journal", ["health"]);
    const admin = await createAdminToken("journal");

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
    const admin = await createAdminToken("journal");

    const path = "/vault/journal/api/tags/health";
    const res = await route(authed(admin, "DELETE", path), path);
    expect(res.status).toBe(200);
  });

  test("POST /api/tags/:name/rename → 200 cascades token allowlists (vault#240)", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("h", { tags: ["health"] });
    seedTagScopedRow("journal", ["health"]);
    const admin = await createAdminToken("journal");

    const path = "/vault/journal/api/tags/health/rename";
    const res = await route(
      new Request(`http://localhost:1940${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify({ new_name: "wellness" }),
      }),
      path,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      renamed?: number;
      tokens_updated?: number;
    };
    // The cascade reports per-surface counts so callers can see what shifted.
    expect(body.renamed).toBe(1);
    expect(body.tokens_updated).toBe(1);

    // Tag is renamed; the previously-409-blocking token's scoped_tags
    // rewrites alongside.
    expect((await store.listTags()).find((t) => t.name === "health")).toBeFalsy();
    expect((await store.listTags()).find((t) => t.name === "wellness")).toBeTruthy();
  });

  test("POST /api/tags/merge → 409 when a tag-scoped token references a source", async () => {
    createVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("a", { tags: ["alpha"] });
    await store.createNote("b", { tags: ["beta"] });
    seedTagScopedRow("journal", ["alpha"]);
    const admin = await createAdminToken("journal");

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
    const token = await mintToken("journal", {
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

// ---------------------------------------------------------------------------
// /health — smoke tests for the unauthenticated liveness probe (vault#339).
//
// /health must ALWAYS return 200 regardless of VAULT_AUTH_TOKEN config so
// Render's health probe + Docker HEALTHCHECK can poll the container even
// before the operator has configured a bearer. The response shape changes
// (vault names are leaked only to authed callers) but the status code is
// invariant.
// ---------------------------------------------------------------------------

describe("/health — always 200 (Render/Docker healthcheck contract)", () => {
  let prevToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env.VAULT_AUTH_TOKEN;
  });

  afterEach(() => {
    if (prevToken === undefined) delete process.env.VAULT_AUTH_TOKEN;
    else process.env.VAULT_AUTH_TOKEN = prevToken;
  });

  test("env unset + no bearer → 200 (anonymous probe)", async () => {
    delete process.env.VAULT_AUTH_TOKEN;
    createVault("journal");

    const res = await route(new Request("http://localhost:1940/health"), "/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    // No bearer → no vault names leaked.
    expect(body.vaults).toBeUndefined();
  });

  test("env set + no bearer → 200 (Render's health probe doesn't have the secret)", async () => {
    process.env.VAULT_AUTH_TOKEN = "operator-token-xyz";
    createVault("journal");

    const res = await route(new Request("http://localhost:1940/health"), "/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.vaults).toBeUndefined();
  });

  test("env set + matching bearer → 200 + vault names leaked", async () => {
    process.env.VAULT_AUTH_TOKEN = "operator-token-xyz";
    createVault("journal");
    createVault("work");

    const res = await route(
      new Request("http://localhost:1940/health", {
        headers: { Authorization: "Bearer operator-token-xyz" },
      }),
      "/health",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(Array.isArray(body.vaults)).toBe(true);
    expect(body.vaults).toContain("journal");
    expect(body.vaults).toContain("work");
  });

  test("env set + wrong bearer → 200 (still healthy, just no vault detail)", async () => {
    // /health doesn't 401 on a wrong bearer — it just falls back to the
    // anonymous response. The operator's probe stays green even if the
    // bearer is mid-rotation.
    process.env.VAULT_AUTH_TOKEN = "operator-token-xyz";
    createVault("journal");

    const res = await route(
      new Request("http://localhost:1940/health", {
        headers: { Authorization: "Bearer wrong-token" },
      }),
      "/health",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.vaults).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /vault/<name>/admin/mirror — vault-sync Phase A1 admin surface.
//
// These tests pin the auth gate + the no-manager-bootstrapped fallback;
// shape + lifecycle behaviour is covered in mirror-routes.test.ts /
// mirror-manager.test.ts. We exercise the route here to make sure the
// `vault:admin` enforcement matches the rest of the admin surface.
// ---------------------------------------------------------------------------

describe("/vault/<name>/.parachute/mirror — auth + dispatch", () => {
  test("unauthenticated → 401", async () => {
    createVault("journal");
    const p = "/vault/journal/.parachute/mirror";
    const res = await route(new Request(`http://localhost:1940${p}`), p);
    expect(res.status).toBe(401);
  });

  test("vault:read token → 403 insufficient_scope", async () => {
    createVault("journal");
    const fullToken = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:read"] });
    const p = "/vault/journal/.parachute/mirror";
    const res = await route(
      new Request(`http://localhost:1940${p}`, {
        headers: { authorization: `Bearer ${fullToken}` },
      }),
      p,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_type?: string; required_scope?: string };
    expect(body.error_type).toBe("insufficient_scope");
    expect(body.required_scope).toBe("vault:admin");
  });

  test("admin token reaches the handler — returns 503 when manager hasn't been wired (no boot)", async () => {
    // The routing-test harness boots `route()` without starting the
    // server.ts wiring that constructs a MirrorManager. We expect the
    // handler to surface 503 — distinct from an auth or shape error —
    // so operators can tell "manager not initialized" apart from
    // "you used the wrong creds".
    createVault("journal");
    const token = await createAdminToken("journal");
    const p = "/vault/journal/.parachute/mirror";
    const res = await route(
      new Request(`http://localhost:1940${p}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      p,
    );
    // 200 if a previous test left a manager wired (test ordering varies),
    // 503 otherwise. Both prove the auth gate passed.
    expect([200, 503]).toContain(res.status);
  });

  test("non-GET/PUT methods return 405 when manager isn't wired", async () => {
    createVault("journal");
    const token = await createAdminToken("journal");
    const p = "/vault/journal/.parachute/mirror";
    // 503 short-circuits the method check today — that's fine; what we
    // want to assert is that we don't crash + the status is non-2xx.
    const res = await route(
      new Request(`http://localhost:1940${p}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
      p,
    );
    expect([405, 503]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// /vault/<name>/.parachute/mirror/run-now — manual-trigger endpoint added
// alongside the SPA UI. Tests pin the auth gate matches the parent
// endpoint; handler-shape coverage lives in mirror-routes.test.ts.
// ---------------------------------------------------------------------------

describe("/vault/<name>/.parachute/mirror/run-now — auth + dispatch", () => {
  test("unauthenticated → 401", async () => {
    createVault("journal");
    const p = "/vault/journal/.parachute/mirror/run-now";
    const res = await route(
      new Request(`http://localhost:1940${p}`, { method: "POST" }),
      p,
    );
    expect(res.status).toBe(401);
  });

  test("vault:read token → 403 insufficient_scope", async () => {
    createVault("journal");
    const fullToken = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:read"] });
    const p = "/vault/journal/.parachute/mirror/run-now";
    const res = await route(
      new Request(`http://localhost:1940${p}`, {
        method: "POST",
        headers: { authorization: `Bearer ${fullToken}` },
      }),
      p,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_type?: string; required_scope?: string };
    expect(body.error_type).toBe("insufficient_scope");
    expect(body.required_scope).toBe("vault:admin");
  });

  test("admin token reaches the handler — 503 when manager not wired, 400 when wired+disabled", async () => {
    // Mirrors the parent endpoint's harness behavior: test ordering
    // determines whether a previous test wired a manager. Either way
    // the auth gate passed, which is what this routing-level test pins.
    createVault("journal");
    const token = await createAdminToken("journal");
    const p = "/vault/journal/.parachute/mirror/run-now";
    const res = await route(
      new Request(`http://localhost:1940${p}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      p,
    );
    expect([400, 503]).toContain(res.status);
  });

  test("non-POST methods return 405 when manager is wired", async () => {
    createVault("journal");
    const token = await createAdminToken("journal");
    const p = "/vault/journal/.parachute/mirror/run-now";
    const res = await route(
      new Request(`http://localhost:1940${p}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }),
      p,
    );
    // 503 short-circuits the method check when no manager is wired.
    expect([405, 503]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// /vault/<name>/.parachute/mirror/history — surface the git write history
// (vault#300). Admin-gated (ops/forensics surface). Tests pin the auth gate
// matches the sibling mirror routes; helper + handler shape lives in
// mirror-history.test.ts.
// ---------------------------------------------------------------------------

describe("/vault/<name>/.parachute/mirror/history — auth + dispatch", () => {
  test("unauthenticated → 401", async () => {
    createVault("journal");
    const p = "/vault/journal/.parachute/mirror/history";
    const res = await route(new Request(`http://localhost:1940${p}`), p);
    expect(res.status).toBe(401);
  });

  test("vault:read token → 403 insufficient_scope (admin required)", async () => {
    createVault("journal");
    const fullToken = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:read"] });
    const p = "/vault/journal/.parachute/mirror/history";
    const res = await route(
      new Request(`http://localhost:1940${p}`, {
        headers: { authorization: `Bearer ${fullToken}` },
      }),
      p,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_type?: string; required_scope?: string };
    expect(body.error_type).toBe("insufficient_scope");
    expect(body.required_scope).toBe("vault:admin");
  });

  test("admin token reaches the handler (200 when wired, 503 when not)", async () => {
    createVault("journal");
    const token = await createAdminToken("journal");
    const p = "/vault/journal/.parachute/mirror/history";
    const res = await route(
      new Request(`http://localhost:1940${p}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      p,
    );
    // Either way the auth gate passed — that's what this routing-level test pins.
    expect([200, 503]).toContain(res.status);
  });

  test("/history/show admin gate matches /history", async () => {
    createVault("journal");
    const fullToken = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:read"] });
    const p = "/vault/journal/.parachute/mirror/history/show";
    const res = await route(
      new Request(`http://localhost:1940${p}?sha=abc123&path=Notes/a`, {
        headers: { authorization: `Bearer ${fullToken}` },
      }),
      p,
    );
    expect(res.status).toBe(403);
  });

  test("non-GET method → 405 (or 503 when manager not wired)", async () => {
    createVault("journal");
    const token = await createAdminToken("journal");
    const p = "/vault/journal/.parachute/mirror/history";
    const res = await route(
      new Request(`http://localhost:1940${p}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      p,
    );
    expect([405, 503]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// /vault/<name>/.parachute/usage — per-vault data-footprint endpoint.
//
// READ-scoped (a vault's own user must see their own vault's size; the
// operator inherits read via broad/admin). Reports counts + byte sizes; the
// two dir-walks (assets, mirror) are TTL-cached, `?fresh=1` bypasses, and an
// attachment upload invalidates the cache. These tests exercise the auth
// gate, the response shape, the cache hit/bypass, and upload-invalidation
// end-to-end through `route()` against the real (tmp) filesystem.
// ---------------------------------------------------------------------------

describe("/vault/<name>/.parachute/usage — data-footprint endpoint", () => {
  const USAGE_PATH = "/vault/journal/.parachute/usage";

  function authedGet(token: string, path = USAGE_PATH): Request {
    return new Request(`http://localhost:1940${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  /** Upload an attachment through the real storage route (write-scoped). */
  async function uploadAttachment(token: string, bytes: number): Promise<Response> {
    const form = new FormData();
    const file = new File([new Uint8Array(bytes).fill(7)], "photo.png", { type: "image/png" });
    form.set("file", file);
    const p = "/vault/journal/api/storage/upload";
    return route(
      new Request(`http://localhost:1940${p}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      }),
      p,
    );
  }

  test("unauthenticated → 401", async () => {
    createVault("journal");
    const res = await route(new Request(`http://localhost:1940${USAGE_PATH}`), USAGE_PATH);
    expect(res.status).toBe(401);
  });

  test("read-scoped token → 200 with the full shape (owner sees own vault)", async () => {
    createVault("journal");
    // Seed two notes so counts + contentBytes are non-trivial.
    const store = getVaultStore("journal");
    await store.createNote("hello");
    await store.createNote("world!");

    const token = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:read"] });
    const res = await route(authedGet(token), USAGE_PATH);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      counts: { notes: number; attachments: number; links: number; tags: number };
      bytes: { content: number; db: number; assets: number; total: number; mirror?: number };
      computedAt: string;
      cached: boolean;
    };

    // counts match getVaultStats
    const stats = await store.getVaultStats();
    expect(body.counts.notes).toBe(stats.totalNotes);
    expect(body.counts.notes).toBe(2);
    expect(body.counts.attachments).toBe(stats.attachmentCount);
    expect(body.counts.links).toBe(stats.linkCount);
    expect(body.counts.tags).toBe(stats.tagCount);

    // bytes shape
    expect(body.bytes.content).toBe(stats.contentBytes);
    expect(body.bytes.content).toBe(11); // "hello"(5) + "world!"(6)
    expect(body.bytes.db).toBeGreaterThan(0); // a real SQLite file exists
    expect(body.bytes.assets).toBe(0); // no uploads yet
    // total = db + assets (NOT content, NOT mirror)
    expect(body.bytes.total).toBe(body.bytes.db + body.bytes.assets);
    // no mirror configured → omitted
    expect(body.bytes).not.toHaveProperty("mirror");

    expect(typeof body.computedAt).toBe("string");
    expect(typeof body.cached).toBe("boolean");
  });

  test("insufficient scope is impossible at read — but no vault: scope at all → 403", async () => {
    createVault("journal");
    // A token carrying only a non-vault scope satisfies neither read nor any
    // vault verb → 403 insufficient_scope.
    const token = await mintJwt({ vaultName: "journal", scopes: ["openid"] });
    const res = await route(authedGet(token), USAGE_PATH);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_type?: string; required_scope?: string };
    expect(body.error_type).toBe("insufficient_scope");
    expect(body.required_scope).toBe("vault:read");
  });

  test("wrong-vault scope is denied (narrowed scope names a different vault)", async () => {
    createVault("journal");
    createVault("other");
    // Token scoped to `other`, used against `journal` → denied.
    const token = await mintJwt({ vaultName: "journal", scopes: ["vault:other:read"] });
    const res = await route(authedGet(token), USAGE_PATH);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_type?: string };
    expect(body.error_type).toBe("insufficient_scope");
  });

  test("write/admin scope inherits read → 200", async () => {
    createVault("journal");
    const token = await createAdminToken("journal");
    const res = await route(authedGet(token), USAGE_PATH);
    expect(res.status).toBe(200);
  });

  test("non-GET method → 405", async () => {
    createVault("journal");
    const token = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:read"] });
    const res = await route(
      new Request(`http://localhost:1940${USAGE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      USAGE_PATH,
    );
    expect(res.status).toBe(405);
  });

  test("second read within TTL is served from cache (cached:true)", async () => {
    createVault("journal");
    const token = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:read"] });

    const first = (await (await route(authedGet(token), USAGE_PATH)).json()) as { cached: boolean };
    expect(first.cached).toBe(false);

    const second = (await (await route(authedGet(token), USAGE_PATH)).json()) as { cached: boolean };
    expect(second.cached).toBe(true);
  });

  test("?fresh=1 bypasses the cache (cached:false even on a warm cache)", async () => {
    createVault("journal");
    const token = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:read"] });

    // Prime the cache.
    await route(authedGet(token), USAGE_PATH);

    // ?fresh=1 must recompute regardless. The server passes `url.pathname`
    // (query stripped) as the `path` arg while the Request URL retains the
    // query — the route reads `fresh` from `req.url`, not `path`. Mirror that.
    const reqWithQuery = new Request(`http://localhost:1940${USAGE_PATH}?fresh=1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await route(reqWithQuery, USAGE_PATH);
    const body = (await res.json()) as { cached: boolean };
    expect(body.cached).toBe(false);
  });

  test("attachment upload invalidates the cache → assets bytes update", async () => {
    createVault("journal");
    const writeToken = await mintJwt({ vaultName: "journal", scopes: ["vault:journal:write"] });

    // Prime: assets empty.
    const before = (await (await route(authedGet(writeToken), USAGE_PATH)).json()) as {
      bytes: { assets: number };
    };
    expect(before.bytes.assets).toBe(0);

    // Upload a 4096-byte attachment (write-scoped) — this invalidates usage.
    const up = await uploadAttachment(writeToken, 4096);
    expect(up.status).toBe(201);

    // Next read must re-walk (cache was invalidated) and reflect the new file.
    const after = (await (await route(authedGet(writeToken), USAGE_PATH)).json()) as {
      bytes: { assets: number };
      cached: boolean;
    };
    expect(after.cached).toBe(false); // invalidated → recomputed
    expect(after.bytes.assets).toBeGreaterThanOrEqual(4096);
  });
});
