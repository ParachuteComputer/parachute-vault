/**
 * End-to-end auth tests for the hub-JWT path.
 *
 * `hub-jwt.test.ts` covers `validateHubJwt` in isolation. This file exercises
 * the full request path: a JWT bearer arrives at `authenticateVaultRequest`,
 * goes through `authenticateHubJwt`, and the result either resolves into an
 * `AuthResult` or surfaces as a 401 Response. The cases that matter most:
 *
 *   - happy path with narrowed scopes
 *   - broad `vault:<verb>` scope rejected (forced narrowing per #180)
 *   - `aud=vault.<other>` rejected (audience mismatch)
 *   - JWT path rejected at the global (cross-vault) entrypoint
 *   - revoked jti rejected (revocation list integration; client-facing
 *     message is sanitized so the jti doesn't leak)
 *   - revocation list unavailable on cold start → fail-closed 401
 *
 * Each test owns a fresh `PARACHUTE_HOME` and a fake hub fixture that serves
 * BOTH `/.well-known/jwks.json` and `/.well-known/parachute-revocation.json`.
 * scope-guard's own unit suite covers the cache mechanics (TTL refresh,
 * fail-open with last-good, single-flight); this file pins the vault-side
 * wiring and the response-shape contract.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { writeVaultConfig, readVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { authenticateVaultRequest, authenticateGlobalRequest, deriveVaultFromToken } from "./auth.ts";
import { resetJwksCache, resetRevocationCache } from "./hub-jwt.ts";

interface Keypair {
  privateKey: CryptoKey;
  publicJwk: { kty: string; n: string; e: string; kid: string; alg: string; use: string };
  kid: string;
}

async function makeKeypair(kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: { kty: "RSA", n: jwk.n!, e: jwk.e!, kid, alg: "RS256", use: "sig" },
    kid,
  };
}

interface HubFixture {
  origin: string;
  /** Drive the revocation list contents; cleared by default. */
  setRevoked(jtis: string[]): void;
  /** When true, the revocation endpoint returns 503 — exercises fail-closed. */
  setRevocationFails(fails: boolean): void;
  stop: () => void;
}

function startHubFixture(keys: Keypair[]): HubFixture {
  let revokedJtis: string[] = [];
  let revocationFails = false;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") {
        return Response.json({ keys: keys.map((k) => k.publicJwk) });
      }
      if (url.pathname === "/.well-known/parachute-revocation.json") {
        if (revocationFails) {
          return new Response("hub down", { status: 503 });
        }
        return Response.json({
          generated_at: new Date().toISOString(),
          jtis: revokedJtis,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    setRevoked: (jtis) => {
      revokedJtis = jtis;
    },
    setRevocationFails: (fails) => {
      revocationFails = fails;
    },
    stop: () => server.stop(true),
  };
}

interface SignOpts {
  iss: string;
  aud: string;
  scope: string;
  sub?: string;
  ttlSeconds?: number;
  /** Override the random jti — needed when a test wants to revoke this exact token. */
  jti?: string;
  /**
   * `vault_scope` claim (multi-user Phase 1 PR 4 / scope-guard 0.3+).
   * Undefined → omit the claim entirely (pre-PR-4 token shape; surfaces
   * at scope-guard as `[]` = unrestricted). Provide `[]` explicitly for
   * a hub-minted admin token; provide `["<name>"]` for a non-admin user.
   */
  vaultScope?: string[];
  /**
   * `permissions` claim (auth-unification arc, C0). Undefined → omit
   * entirely (today's hub-JWT shape → unscoped). Provide
   * `{ scoped_tags: [...] }` for a tag-scoped token, or a deliberately
   * malformed value to exercise the fail-closed path.
   */
  permissions?: unknown;
}

async function signJwt(kp: Keypair, opts: SignOpts): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (opts.ttlSeconds ?? 60);
  const payload: Record<string, unknown> = {
    scope: opts.scope,
    client_id: "test-client",
  };
  if (opts.vaultScope !== undefined) payload.vault_scope = opts.vaultScope;
  if (opts.permissions !== undefined) payload.permissions = opts.permissions;
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer(opts.iss)
    .setSubject(opts.sub ?? "user-1")
    .setAudience(opts.aud)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(opts.jti ?? `jti-${Math.random().toString(36).slice(2)}`)
    .sign(kp.privateKey);
}

function bearer(token: string): Request {
  return new Request("https://vault.test/x", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

let tmpHome: string;
let prevHome: string | undefined;
let prevHubOrigin: string | undefined;
let prevJwksOrigin: string | undefined;
let fixture: HubFixture;
let kp: Keypair;

beforeAll(async () => {
  // RSA keygen is the expensive part of this file (~tens of ms locally,
  // hundreds under a loaded full-suite worker). Doing it per-test is what
  // clustered failures under parallel contention (vault#609): 30 tests ×
  // generateKeyPair competing with the rest of `bun test ./src/` blew the
  // 5s default. One keypair is enough — kid, n, e are stable for the file.
  kp = await makeKeypair("k1");
});

beforeEach(async () => {
  tmpHome = join(
    tmpdir(),
    `vault-auth-jwt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();

  fixture = startHubFixture([kp]);
  prevHubOrigin = process.env.PARACHUTE_HUB_ORIGIN;
  prevJwksOrigin = process.env.PARACHUTE_HUB_JWKS_ORIGIN;
  process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
  // Post-vault#464 the JWKS fetch origin resolves separately (loopback by
  // default); point it at the fixture so keys are reachable in-test.
  process.env.PARACHUTE_HUB_JWKS_ORIGIN = fixture.origin;
  resetJwksCache();
  resetRevocationCache();
});

afterEach(() => {
  fixture.stop();
  clearVaultStoreCache();
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (prevHubOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = prevHubOrigin;
  if (prevJwksOrigin === undefined) delete process.env.PARACHUTE_HUB_JWKS_ORIGIN;
  else process.env.PARACHUTE_HUB_JWKS_ORIGIN = prevJwksOrigin;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function seedVault(name: string): void {
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  // Touch the store so the DB file exists (matches the routing path's expectation).
  getVaultStore(name);
}

describe("authenticateVaultRequest — hub JWT integration", () => {
  test("narrowed scope + matching aud → AuthResult with permission derived from verb", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:write",
    });
    const config = readVaultConfig("journal")!;
    const store = getVaultStore("journal");

    const result = await authenticateVaultRequest(bearer(token), config);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("full");
      expect(result.scopes).toEqual(["vault:journal:write"]);
      expect(result.legacyDerived).toBe(false);
    }
  });

  test("narrowed read scope → permission='read'", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:read",
    });
    const config = readVaultConfig("journal")!;
    const store = getVaultStore("journal");

    const result = await authenticateVaultRequest(bearer(token), config);
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.permission).toBe("read");
  });

  test("broad vault:write scope from a JWT → 401 with explanatory message", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:write",
    });
    const config = readVaultConfig("journal")!;
    const store = getVaultStore("journal");

    const result = await authenticateVaultRequest(bearer(token), config);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      const body = (await result.error.json()) as { error: string; message: string };
      expect(body.error).toBe("Unauthorized");
      expect(body.message).toContain("broad vault scope");
      expect(body.message).toContain("vault:write");
    }
  });

  test("aud=vault.work cannot reach /vault/journal/* → 401 audience mismatch", async () => {
    seedVault("journal");
    seedVault("work");
    // Token is correctly stamped for work, but presented at journal's endpoint.
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.work",
      scope: "vault:work:write",
    });
    const journalConfig = readVaultConfig("journal")!;
    const journalStore = getVaultStore("journal");

    const result = await authenticateVaultRequest(
      bearer(token),
      journalConfig,
      journalStore.db,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      const body = (await result.error.json()) as { error: string; message: string };
      expect(body.message).toMatch(/audience mismatch.*vault\.journal.*vault\.work/);
    }
  });

  test("hub JWT at the global (cross-vault) entrypoint → 401 with vault-bound hint", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:read",
    });
    const result = await authenticateGlobalRequest(bearer(token));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      const body = (await result.error.json()) as { error: string; message: string };
      expect(body.message).toContain("vault-bound");
      expect(body.message).toContain("/vault/<name>");
    }
  });

  test("revoked jti → 401 sanitized; full diagnostic (with jti) routed to console.warn audit log", async () => {
    seedVault("journal");
    const revokedJti = "jti-revoked-by-operator";
    fixture.setRevoked([revokedJti]);
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:read",
      jti: revokedJti,
    });
    const config = readVaultConfig("journal")!;
    const store = getVaultStore("journal");

    // Spy + suppress so the assertion is the audit-trail invariant for
    // this scenario, not a stderr inspection. Pattern carries to scribe/agent.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await authenticateVaultRequest(bearer(token), config);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error.status).toBe(401);
        const body = (await result.error.json()) as { error: string; message: string };
        expect(body.error).toBe("Unauthorized");
        // Client-facing message must NOT carry the jti — that's a server-side
        // audit-log concern only. See the `code === "revoked"` branch in
        // authenticateHubJwt for the sanitization.
        expect(body.message).toBe("token has been revoked");
        expect(body.message).not.toContain(revokedJti);
      }
      // Audit-log invariant: console.warn fires exactly once with a message
      // that carries the jti, so an operator chasing a 401 in production logs
      // can correlate to which token was retired.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = warnSpy.mock.calls[0]![0] as string;
      expect(warnArg).toContain(revokedJti);
      expect(warnArg).toContain("revoked");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("non-revoked jti against populated list → still honored (happy path with active revocations)", async () => {
    seedVault("journal");
    fixture.setRevoked(["some-other-revoked-jti"]);
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:write",
      jti: "jti-still-good",
    });
    const config = readVaultConfig("journal")!;
    const store = getVaultStore("journal");

    const result = await authenticateVaultRequest(bearer(token), config);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("full");
      expect(result.scopes).toEqual(["vault:journal:write"]);
    }
  });

  test("vault_scope=[aaron] reaching /vault/aaron → success (matching pin)", async () => {
    // Non-admin user assigned to vault "aaron" presenting their token
    // at their own vault. The vault_scope claim names "aaron"; the
    // request targets "aaron"; the defense-in-depth check passes.
    seedVault("aaron");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.aaron",
      scope: "vault:aaron:write",
      vaultScope: ["aaron"],
    });
    const config = readVaultConfig("aaron")!;
    const store = getVaultStore("aaron");

    const result = await authenticateVaultRequest(bearer(token), config);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("full");
      expect(result.scopes).toEqual(["vault:aaron:write"]);
    }
  });

  test("vault_scope=[aaron] reaching /vault/bob (cross-vault) → 403 vault_scope_mismatch", async () => {
    // The exact threat model multi-user Phase 1 PR 5 protects against.
    // A non-admin user pinned to "aaron" somehow gets a token naming
    // "bob" in its scope string (mint bug, edited token, third-party RS
    // bug, replay attack). The audience strict-check inside
    // validateHubJwt would catch the obvious shape (aud=vault.bob
    // reaching journal endpoint), but the case below pre-fabricates a
    // token whose aud + scope DO name bob — only the vault_scope claim
    // pins the user to aaron. Without the new enforcement, the request
    // would coast through.
    seedVault("aaron");
    seedVault("bob");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.bob", // audience matches bob (so the aud check passes)
      scope: "vault:bob:write", // scope strings name bob too
      vaultScope: ["aaron"], // but the user is pinned to aaron
    });
    const bobConfig = readVaultConfig("bob")!;
    const bobStore = getVaultStore("bob");

    const result = await authenticateVaultRequest(bearer(token), bobConfig);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(403);
      const body = (await result.error.json()) as {
        error: string;
        error_type: string;
        message: string;
        required_vault: string;
        granted_vault_scope?: unknown;
      };
      expect(body.error).toBe("Forbidden");
      expect(body.error_type).toBe("vault_scope_mismatch");
      // Message names both the pinned vault (aaron) and the requested
      // vault (bob) so operators reading 403 logs can correlate to
      // user assignment without needing to decode the token.
      expect(body.message).toContain("aaron");
      expect(body.message).toContain("bob");
      expect(body.required_vault).toBe("bob");
      // Surface hygiene: the pinned vault is intentionally NOT echoed
      // back in a dedicated body field. The message carries enough
      // diagnostic for an operator reading logs; a dedicated field
      // would only leak the pin to a passive observer (the attacker
      // already has it via local decode, but pattern hygiene says
      // don't volunteer it).
      expect(body.granted_vault_scope).toBeUndefined();
    }
  });

  test("vault_scope=[] (admin token) passes any-vault check", async () => {
    // Admin tokens carry vault_scope: [] — the explicit "no per-user pin"
    // sentinel. The defense-in-depth check skips, and the request is
    // gated purely by audience + scope strings. Both name "work" here,
    // so the request succeeds.
    seedVault("work");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.work",
      scope: "vault:work:admin",
      vaultScope: [],
    });
    const config = readVaultConfig("work")!;
    const store = getVaultStore("work");

    const result = await authenticateVaultRequest(bearer(token), config);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("full");
      expect(result.scopes).toEqual(["vault:work:admin"]);
    }
  });

  test("pre-PR-4 token (vault_scope claim absent) → treated as admin (back-compat)", async () => {
    // Every operator token + CLI-mint that existed before hub PR 4
    // merged lacks the vault_scope claim entirely. scope-guard surfaces
    // the absent claim as `[]`, which the helper treats as
    // "unrestricted" — so the request goes through as long as audience
    // + scope strings are correct. Without this back-compat, the entire
    // pre-PR-4 fleet would 403 the moment this code shipped, which is
    // the wrong tradeoff for a defense-in-depth check.
    seedVault("legacy");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.legacy",
      scope: "vault:legacy:write",
      // vaultScope intentionally omitted — pre-PR-4 token shape
    });
    const config = readVaultConfig("legacy")!;
    const store = getVaultStore("legacy");

    const result = await authenticateVaultRequest(bearer(token), config);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.permission).toBe("full");
      expect(result.scopes).toEqual(["vault:legacy:write"]);
    }
  });

  test("vault_scope check runs AFTER broad-scope check — broad scope still wins the failure mode", async () => {
    // A token with a broad vault scope AND a vault_scope pin gets
    // rejected for the broad scope (more diagnostic). Pinning the
    // ordering matters because the 401 message tells the operator
    // "your token shape is wrong" whereas 403 vault_scope_mismatch
    // tells them "your user can't reach this vault" — those have
    // different remediation paths.
    seedVault("aaron");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.aaron",
      scope: "vault:write", // broad — should trigger 401 first
      vaultScope: ["other-vault"], // would also fail vault_scope check
    });
    const config = readVaultConfig("aaron")!;
    const store = getVaultStore("aaron");

    const result = await authenticateVaultRequest(bearer(token), config);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      // 401, not 403 — broad-scope rejection takes precedence.
      expect(result.error.status).toBe(401);
      const body = (await result.error.json()) as { error: string; message: string };
      expect(body.message).toContain("broad vault scope");
    }
  });

  test("revocation list unreachable on cold start → fail-closed 401 sanitized; full diagnostic routed to console.warn", async () => {
    seedVault("journal");
    // Hub is reachable for JWKS but the revocation endpoint 503s. Cold cache
    // + first-fetch-fail = "unknown" outcome, surfaced as
    // HubJwtError(code: "revocation_unavailable"). Client gets a code-shaped
    // sentence; the implementation-detail phrasing ("no last-good cache")
    // stays in the server-side audit log.
    fixture.setRevocationFails(true);
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:read",
    });
    const config = readVaultConfig("journal")!;
    const store = getVaultStore("journal");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await authenticateVaultRequest(bearer(token), config);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error.status).toBe(401);
        const body = (await result.error.json()) as { error: string; message: string };
        // Client message: code-shaped, no internals.
        expect(body.message).toBe("token cannot be validated: revocation list unavailable");
        // The internal phrase "no last-good cache" is a scope-guard
        // implementation detail and must not leak into the public response.
        expect(body.message).not.toContain("last-good cache");
      }
      // Audit-log invariant: full diagnostic routed to console.warn so
      // operators can distinguish cold-start from sustained outage.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = warnSpy.mock.calls[0]![0] as string;
      expect(warnArg).toContain("no last-good cache");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("authenticateVaultRequest — hub JWT tag-scoping (auth-unification C0)", () => {
  // Helper: pull a successful AuthResult out of authenticateVaultRequest,
  // failing the test loudly if auth returned an error Response.
  async function authOk(
    token: string,
    vaultName: string,
  ): Promise<import("./auth.ts").AuthResult> {
    const config = readVaultConfig(vaultName)!;
    const store = getVaultStore(vaultName);
    const result = await authenticateVaultRequest(bearer(token), config);
    if ("error" in result) {
      const body = await result.error.json();
      throw new Error(`expected AuthResult, got ${result.error.status}: ${JSON.stringify(body)}`);
    }
    return result;
  }

  test("permissions.scoped_tags:[health] → AuthResult.scoped_tags=[health]; query-notes enforces (health visible, work hidden)", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    // Seed two notes: one tagged health, one tagged work.
    await store.createNote("blood pressure log", { path: "h1", tags: ["health"] });
    await store.createNote("quarterly OKRs", { path: "w1", tags: ["work"] });

    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:read",
      permissions: { scoped_tags: ["health"] },
    });

    const auth = await authOk(token, "journal");
    // The READ side: the allowlist is lifted off the validated token.
    expect(auth.scoped_tags).toEqual(["health"]);

    // End-to-end enforcement: the tag-scope-wrapped query-notes tool must
    // hide the `work` note and surface the `health` note.
    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const tools = generateScopedMcpTools("journal", auth);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({})) as any;
    const notes = Array.isArray(result) ? result : result.notes;
    const paths = notes.map((n: any) => n.path).sort();
    expect(paths).toEqual(["h1"]);
    expect(paths).not.toContain("w1");
  });

  test("no permissions claim → scoped_tags=null (unscoped, full vault — regression: unchanged)", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("a", { path: "h1", tags: ["health"] });
    await store.createNote("b", { path: "w1", tags: ["work"] });

    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:read",
      // permissions intentionally omitted — today's hub-JWT shape
    });

    const auth = await authOk(token, "journal");
    expect(auth.scoped_tags).toBeNull();

    const { generateScopedMcpTools } = await import("./mcp-tools.ts");
    const tools = generateScopedMcpTools("journal", auth);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({})) as any;
    const notes = Array.isArray(result) ? result : result.notes;
    const paths = notes.map((n: any) => n.path).sort();
    // Unscoped: BOTH notes visible.
    expect(paths).toEqual(["h1", "w1"]);
  });

  test("permissions present but scoped_tags absent → scoped_tags=null (unscoped)", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:read",
      permissions: { some_other_perm: true },
    });
    const auth = await authOk(token, "journal");
    expect(auth.scoped_tags).toBeNull();
  });

  test("permissions.scoped_tags:null → scoped_tags=null (explicit unscoped)", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:read",
      permissions: { scoped_tags: null },
    });
    const auth = await authOk(token, "journal");
    expect(auth.scoped_tags).toBeNull();
  });

  // ---- Fail-closed cases: present-but-malformed scoped_tags MUST 401, ----
  // ---- never silently widen to full-vault. ----
  for (const [label, badValue] of [
    ["a string", "health"],
    ["a number", 42],
    ["an object", { health: true }],
    ["an array with a non-string", ["health", 5]],
    ["an array with an empty string", ["health", ""]],
    ["an empty array", []],
  ] as Array<[string, unknown]>) {
    test(`malformed scoped_tags (${label}) → 401 fail-closed (does NOT widen to full vault)`, async () => {
      seedVault("journal");
      const token = await signJwt(kp, {
        iss: fixture.origin,
        aud: "vault.journal",
        scope: "vault:journal:read",
        permissions: { scoped_tags: badValue },
      });
      const config = readVaultConfig("journal")!;
      const store = getVaultStore("journal");

      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await authenticateVaultRequest(bearer(token), config);
        // The whole request is rejected — NOT served with scoped_tags=null
        // (full vault) or scoped_tags=[] (also full vault on the MCP path).
        expect("error" in result).toBe(true);
        if ("error" in result) {
          expect(result.error.status).toBe(401);
          const body = (await result.error.json()) as { error: string; message: string };
          expect(body.error).toBe("Unauthorized");
          expect(body.message).toContain("malformed tag-scope");
        }
        // Audit log carries the diagnostic.
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// pvt_* DROP (vault#282 Stage 2 — BREAKING). pvt_* tokens were the only
// non-JWT, non-YAML credential vault used to mint + validate. At 0.5.0 the
// mint + validation were removed entirely: a pvt_*-prefixed bearer is no
// longer JWT-shaped (skips authenticateHubJwt) and matches no surviving
// credential, so it 401s. The hub JWT — the migration target — keeps working.
// ---------------------------------------------------------------------------

describe("pvt_* DROP (vault#282 Stage 2 — unvalidatable)", () => {
  test("a pvt_* bearer is 401-rejected on the per-vault hub-JWT surface", async () => {
    seedVault("journal");
    const config = readVaultConfig("journal")!;
    const pvt = "pvt_deadbeefdeadbeefdeadbeefdeadbeef";

    const result = await authenticateVaultRequest(bearer(pvt), config);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(401);
  });

  test("a real hub JWT still authenticates (migration target works)", async () => {
    seedVault("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:write",
    });
    const config = readVaultConfig("journal")!;

    const result = await authenticateVaultRequest(bearer(token), config);
    expect("error" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveVaultFromToken — the derivation precedence for the canonical root
// `/mcp` endpoint (U1). This function READS a validated token's claims to name
// the target vault; it never authorizes (the router re-dispatches through the
// full per-vault machinery). These cases isolate the three naming sources —
// narrowed scope / `aud=vault.<name>` / single-element `vault_scope` — and the
// fail-closed rules (agree → one name; disagree or none → `not_derivable`).
// The end-to-end routing.test.ts covers the wired behavior; this pins the
// precedence logic directly.
// ---------------------------------------------------------------------------
describe("deriveVaultFromToken — root /mcp vault derivation (U1)", () => {
  test("all three sources agree → that vault", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:write",
      vaultScope: ["journal"],
    });
    expect(await deriveVaultFromToken(bearer(token))).toEqual({ vaultName: "journal" });
  });

  test("narrowed scope alone names the vault (non-vault aud, no vault_scope)", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "urn:opaque-resource",
      scope: "vault:journal:read",
    });
    expect(await deriveVaultFromToken(bearer(token))).toEqual({ vaultName: "journal" });
  });

  test("aud=vault.<name> alone names the vault (broad scope names nothing)", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:read",
    });
    expect(await deriveVaultFromToken(bearer(token))).toEqual({ vaultName: "journal" });
  });

  test("single-element vault_scope alone names the vault", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "urn:opaque-resource",
      scope: "vault:read",
      vaultScope: ["journal"],
    });
    expect(await deriveVaultFromToken(bearer(token))).toEqual({ vaultName: "journal" });
  });

  test("multi-element vault_scope is NOT a single name → not_derivable (nothing else names)", async () => {
    // Phase-2 multi-vault shape: a multi-element vault_scope doesn't name ONE
    // vault, so at the single-vault root it can't be the sole source.
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "urn:opaque-resource",
      scope: "vault:read",
      vaultScope: ["journal", "work"],
    });
    expect(await deriveVaultFromToken(bearer(token))).toEqual({ error: "not_derivable" });
  });

  test("sources disagree (scope vs aud) → not_derivable, never a guess", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.work",
      scope: "vault:journal:write",
    });
    expect(await deriveVaultFromToken(bearer(token))).toEqual({ error: "not_derivable" });
  });

  test("no source names a vault → not_derivable", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "urn:opaque-resource",
      scope: "vault:read",
    });
    expect(await deriveVaultFromToken(bearer(token))).toEqual({ error: "not_derivable" });
  });

  test("no bearer → no_bearer", async () => {
    const req = new Request("https://vault.test/mcp");
    expect(await deriveVaultFromToken(req)).toEqual({ error: "no_bearer" });
  });

  test("non-JWT bearer (operator / legacy shape) names no vault → not_derivable", async () => {
    // The operator VAULT_AUTH_TOKEN and legacy YAML keys are vault-agnostic —
    // they can't route the token-derived root endpoint (they keep working at
    // the per-vault URL).
    expect(await deriveVaultFromToken(bearer("opaque-operator-secret"))).toEqual({
      error: "not_derivable",
    });
  });

  test("expired JWT → not_derivable (validated with the full trust kernel)", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:write",
      ttlSeconds: -10, // already expired
    });
    expect(await deriveVaultFromToken(bearer(token))).toEqual({ error: "not_derivable" });
  });

  test("revoked JWT → not_derivable (revocation runs in derivation too)", async () => {
    const jti = "u1-derive-revoked";
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:write",
      jti,
    });
    fixture.setRevoked([jti]);
    resetRevocationCache();
    expect(await deriveVaultFromToken(bearer(token))).toEqual({ error: "not_derivable" });
  });
});
