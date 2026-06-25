/**
 * Hub-issued JWT validation — vault as resource server.
 *
 * Spins up a fake JWKS endpoint (Bun.serve) with a known RSA keypair, signs
 * JWTs locally with `jose.SignJWT`, and asserts `validateHubJwt` accepts the
 * good ones and rejects every failure mode the spec cares about: bad
 * signature, wrong issuer, expired, missing kid, unknown kid, JWKS
 * unreachable. Audience permissiveness is exercised — both `aud="operator"`
 * and `aud="<client_id>"` shapes pass.
 *
 * Each test resets the JWKS cache so the origin/keys can change between
 * cases. The cache is module-scoped; without `resetJwksCache()` we'd reuse
 * the previous origin's getter and miss test rotations.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  resetJwksCache,
  resetRevocationCache,
  validateHubJwt,
  looksLikeJwt,
  getHubOrigin,
  getJwksOrigin,
  parseHubOrigins,
} from "./hub-jwt.ts";

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
    publicJwk: {
      kty: "RSA",
      n: jwk.n!,
      e: jwk.e!,
      kid,
      alg: "RS256",
      use: "sig",
    },
    kid,
  };
}

interface JwksFixture {
  origin: string;
  stop: () => void;
  setKeys: (keys: Keypair[]) => void;
  setUnreachable: (down: boolean) => void;
}

function startJwksFixture(): JwksFixture {
  let keys: Keypair[] = [];
  let down = false;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (down) return new Response("upstream down", { status: 503 });
      if (url.pathname === "/.well-known/jwks.json") {
        return Response.json({ keys: keys.map((k) => k.publicJwk) });
      }
      // scope-guard 0.2+ consults `/.well-known/parachute-revocation.json` on
      // every JWT validation (when the token has a jti). Serve an empty list
      // by default so unrelated tests in this file aren't fail-closed by a
      // 404 on that endpoint. The integration tests (`auth-hub-jwt.test.ts`)
      // own the revoked-jti / fail-closed cases separately.
      if (url.pathname === "/.well-known/parachute-revocation.json") {
        return Response.json({ generated_at: new Date().toISOString(), jtis: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    setKeys: (next) => { keys = next; },
    setUnreachable: (v) => { down = v; },
  };
}

interface SignOpts {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  scope?: string;
  jti?: string;
  clientId?: string;
  ttlSeconds?: number;
  expiresAtSeconds?: number;
  omitKid?: boolean;
  kid?: string;
  /** `permissions` claim (auth-unification C0). Undefined → omit. */
  permissions?: unknown;
}

async function signJwt(kp: Keypair, opts: SignOpts): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = opts.expiresAtSeconds ?? iat + (opts.ttlSeconds ?? 60);
  const claims: Record<string, unknown> = {
    scope: opts.scope ?? "vault:read vault:write",
    client_id: opts.clientId ?? "test-client",
  };
  if (opts.permissions !== undefined) claims.permissions = opts.permissions;
  const builder = new SignJWT(claims)
    .setProtectedHeader(opts.omitKid ? { alg: "RS256" } : { alg: "RS256", kid: opts.kid ?? kp.kid })
    .setIssuer(opts.iss ?? "http://issuer.invalid")
    .setSubject(opts.sub ?? "user-1")
    .setAudience(opts.aud ?? "operator")
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(opts.jti ?? "jti-1");
  return await builder.sign(kp.privateKey);
}

let fixture: JwksFixture;
let kp: Keypair;
let prevHubOrigin: string | undefined;
let prevJwksOrigin: string | undefined;
let prevHubOrigins: string | undefined;

beforeAll(async () => {
  fixture = startJwksFixture();
  kp = await makeKeypair("k1");
  fixture.setKeys([kp]);
});

afterAll(() => {
  fixture.stop();
  if (prevHubOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = prevHubOrigin;
  if (prevJwksOrigin === undefined) delete process.env.PARACHUTE_HUB_JWKS_ORIGIN;
  else process.env.PARACHUTE_HUB_JWKS_ORIGIN = prevJwksOrigin;
  if (prevHubOrigins === undefined) delete process.env.PARACHUTE_HUB_ORIGINS;
  else process.env.PARACHUTE_HUB_ORIGINS = prevHubOrigins;
});

beforeEach(() => {
  // Each test sets its own origin for clarity. Post-vault#464 the JWKS *fetch*
  // origin is resolved separately from the iss-validation origin, so point the
  // JWKS fetch at the fixture too — otherwise the guard would read keys from
  // the loopback default (no JWKS server there) and every case would fail.
  prevHubOrigin = process.env.PARACHUTE_HUB_ORIGIN;
  prevJwksOrigin = process.env.PARACHUTE_HUB_JWKS_ORIGIN;
  prevHubOrigins = process.env.PARACHUTE_HUB_ORIGINS;
  process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
  process.env.PARACHUTE_HUB_JWKS_ORIGIN = fixture.origin;
  // Default each case to the single-origin (env-unset) world so the multi-origin
  // iss-set is opt-in per test — unrelated cases stay byte-identical to before.
  delete process.env.PARACHUTE_HUB_ORIGINS;
  fixture.setUnreachable(false);
  fixture.setKeys([kp]);
  resetJwksCache();
  // Drop the per-process revocation cache so each test starts cold against
  // the fixture (an empty list by default; tests opt into populated lists).
  resetRevocationCache();
});

describe("looksLikeJwt", () => {
  test("`eyJ` prefix → true", () => {
    expect(looksLikeJwt("eyJhbGciOiJSUzI1NiJ9.x.y")).toBe(true);
  });

  test("pvt_ token → false", () => {
    expect(looksLikeJwt("pvt_abcdef0123456789")).toBe(false);
  });

  test("empty / random → false", () => {
    expect(looksLikeJwt("")).toBe(false);
    expect(looksLikeJwt("hello-world")).toBe(false);
  });
});

describe("parseHubOrigins — multi-origin iss-set (hub#692)", () => {
  test("undefined → [] (back-compat: env unset collapses to single hubOrigin)", () => {
    expect(parseHubOrigins(undefined)).toEqual([]);
  });

  test("empty string → []", () => {
    expect(parseHubOrigins("")).toEqual([]);
  });

  test("splits, trims, strips trailing slash, drops empties, dedupes", () => {
    // "a,b/, ,a" → [a, b]: trailing slash off b, blank entry dropped, dup a collapsed.
    expect(parseHubOrigins("https://a.example,https://b.example/, ,https://a.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  test("whitespace-only entries are dropped", () => {
    expect(parseHubOrigins("  ,  ,  ")).toEqual([]);
  });
});

describe("origin resolvers — iss/jwks split (vault#464)", () => {
  test("getHubOrigin honors PARACHUTE_HUB_ORIGIN (iss-validation origin)", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "https://vault.example.com/";
    expect(getHubOrigin()).toBe("https://vault.example.com");
  });

  test("getHubOrigin falls back to loopback when unset", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });

  test("getJwksOrigin defaults to loopback (no env override)", () => {
    delete process.env.PARACHUTE_HUB_JWKS_ORIGIN;
    expect(getJwksOrigin()).toBe("http://127.0.0.1:1939");
  });

  test("getJwksOrigin honors PARACHUTE_HUB_JWKS_ORIGIN and strips trailing slash", () => {
    process.env.PARACHUTE_HUB_JWKS_ORIGIN = "http://10.0.0.5:1939/";
    expect(getJwksOrigin()).toBe("http://10.0.0.5:1939");
  });

  test("jwks fetch is decoupled from the iss origin: keys served ONLY at the jwks origin still validate a token whose iss is the (separate) public origin", async () => {
    // Mirrors the vault#464 deploy shape: iss + revocation live at the public
    // origin (the default `fixture` here), while the JWKS is reachable only at
    // a SEPARATE jwks origin (a second fixture standing in for loopback). The
    // guard must fetch keys from the jwks origin, not the iss origin.
    const jwksOnly = startJwksFixture();
    jwksOnly.setKeys([kp]);
    // The public iss origin (default fixture) serves revocation but NOT keys —
    // if the guard fetched JWKS from here, verification would fail "no key".
    fixture.setKeys([]);
    try {
      process.env.PARACHUTE_HUB_ORIGIN = fixture.origin; // iss + revocation
      process.env.PARACHUTE_HUB_JWKS_ORIGIN = jwksOnly.origin; // keys only
      resetJwksCache();
      const token = await signJwt(kp, { iss: fixture.origin });
      const claims = await validateHubJwt(token);
      expect(claims.sub).toBe("user-1");
    } finally {
      jwksOnly.stop();
    }
  });

  test("token whose iss does NOT match the iss origin is rejected even when keys resolve at the jwks origin", async () => {
    const jwksOnly = startJwksFixture();
    jwksOnly.setKeys([kp]);
    try {
      process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
      process.env.PARACHUTE_HUB_JWKS_ORIGIN = jwksOnly.origin;
      resetJwksCache();
      const token = await signJwt(kp, { iss: "https://attacker.example" });
      await expect(validateHubJwt(token)).rejects.toThrow(/verification failed/);
    } finally {
      jwksOnly.stop();
    }
  });
});

describe("validateHubJwt — multi-origin iss-set (hub#692)", () => {
  // A second + third origin that are NOT the canonical PARACHUTE_HUB_ORIGIN.
  // Every token here is signed by the SAME published key (`kp`), so the
  // signature always verifies — the ONLY variable under test is whether the
  // token's `iss` is in the accepted set. JWKS + revocation stay served by the
  // default `fixture`, reached as both the iss origin and the jwks origin.
  const SECOND = "https://second.example";
  const THIRD = "https://third.example";

  test("token issued by a SECOND origin validates when that origin is in PARACHUTE_HUB_ORIGINS", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin; // canonical (also JWKS host)
    process.env.PARACHUTE_HUB_ORIGINS = `${fixture.origin},${SECOND}`;
    resetJwksCache();
    const token = await signJwt(kp, { iss: SECOND });
    const claims = await validateHubJwt(token);
    expect(claims.sub).toBe("user-1");
  });

  test("the canonical origin still validates when PARACHUTE_HUB_ORIGINS lists a different second origin", async () => {
    // The resolved hubOrigin is always added to the set, so a token minted under
    // the canonical origin keeps validating even when the env names only others.
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
    process.env.PARACHUTE_HUB_ORIGINS = SECOND; // env need not include the canonical
    resetJwksCache();
    const token = await signJwt(kp, { iss: fixture.origin });
    const claims = await validateHubJwt(token);
    expect(claims.sub).toBe("user-1");
  });

  test("token issued by a THIRD, unlisted origin is rejected even with PARACHUTE_HUB_ORIGINS set", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
    process.env.PARACHUTE_HUB_ORIGINS = `${fixture.origin},${SECOND}`;
    resetJwksCache();
    const token = await signJwt(kp, { iss: THIRD });
    await expect(validateHubJwt(token)).rejects.toThrow(/verification failed/);
  });

  test("back-compat: with PARACHUTE_HUB_ORIGINS UNSET only the canonical origin validates; a second origin is rejected", async () => {
    delete process.env.PARACHUTE_HUB_ORIGINS;
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
    resetJwksCache();
    // canonical iss → accepted
    const ok = await signJwt(kp, { iss: fixture.origin });
    expect((await validateHubJwt(ok)).sub).toBe("user-1");
    // the same SECOND origin that WOULD pass when listed → rejected when unset
    const bad = await signJwt(kp, { iss: SECOND });
    await expect(validateHubJwt(bad)).rejects.toThrow(/verification failed/);
  });
});

describe("validateHubJwt — happy path", () => {
  test("valid JWT with correct iss → claims surface", async () => {
    const token = await signJwt(kp, { iss: fixture.origin, scope: "vault:work:read vault:work:write" });
    const claims = await validateHubJwt(token);
    expect(claims.sub).toBe("user-1");
    expect(claims.scopes).toEqual(["vault:work:read", "vault:work:write"]);
    expect(claims.aud).toBe("operator");
    expect(claims.jti).toBe("jti-1");
    expect(claims.clientId).toBe("test-client");
  });

  test("aud=operator accepted when expectedAudience not set", async () => {
    const token = await signJwt(kp, { iss: fixture.origin, aud: "operator" });
    const claims = await validateHubJwt(token);
    expect(claims.aud).toBe("operator");
  });

  test("aud=<client_id> accepted when expectedAudience not set", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "did:plc:randomclientid",
      clientId: "did:plc:randomclientid",
    });
    const claims = await validateHubJwt(token);
    expect(claims.aud).toBe("did:plc:randomclientid");
  });

  test("empty scope claim → empty scopes array", async () => {
    const token = await signJwt(kp, { iss: fixture.origin, scope: "" });
    const claims = await validateHubJwt(token);
    expect(claims.scopes).toEqual([]);
  });

  test("audience strict-check passes when expected matches", async () => {
    const token = await signJwt(kp, { iss: fixture.origin, aud: "vault.work" });
    const claims = await validateHubJwt(token, { expectedAudience: "vault.work" });
    expect(claims.aud).toBe("vault.work");
  });

  test("permissions claim surfaces on the validated result (C0)", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      permissions: { scoped_tags: ["health", "finance"] },
    });
    const claims = await validateHubJwt(token);
    expect(claims.permissions).toEqual({ scoped_tags: ["health", "finance"] });
  });

  test("no permissions claim → permissions is undefined", async () => {
    const token = await signJwt(kp, { iss: fixture.origin });
    const claims = await validateHubJwt(token);
    expect(claims.permissions).toBeUndefined();
  });

  test("non-object permissions claim → permissions is undefined (not surfaced)", async () => {
    const token = await signJwt(kp, { iss: fixture.origin, permissions: "not-an-object" });
    const claims = await validateHubJwt(token);
    expect(claims.permissions).toBeUndefined();
  });
});

describe("validateHubJwt — audience strict-check", () => {
  test("mismatched audience throws with the expected vs got values", async () => {
    const token = await signJwt(kp, { iss: fixture.origin, aud: "vault.personal" });
    await expect(
      validateHubJwt(token, { expectedAudience: "vault.work" }),
    ).rejects.toThrow(/audience mismatch.*vault\.work.*vault\.personal/);
  });

  test("missing audience claim throws when expected is set", async () => {
    // jose's SignJWT requires .setAudience() — provide an unrelated value to
    // exercise "not the expected one" rather than a literal missing claim.
    const token = await signJwt(kp, { iss: fixture.origin, aud: "operator" });
    await expect(
      validateHubJwt(token, { expectedAudience: "vault.work" }),
    ).rejects.toThrow(/audience mismatch/);
  });

  test("expectedAudience: null skips the check (cross-vault path)", async () => {
    const token = await signJwt(kp, { iss: fixture.origin, aud: "vault.anything" });
    const claims = await validateHubJwt(token, { expectedAudience: null });
    expect(claims.aud).toBe("vault.anything");
  });

  test("array aud: passes when expected is one of the entries", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: ["vault.work", "vault.personal", "operator"],
    });
    const claims = await validateHubJwt(token, { expectedAudience: "vault.personal" });
    expect(claims.aud).toBe("vault.personal");
  });

  test("array aud: rejects when expected is not in the entries", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: ["vault.work", "operator"],
    });
    await expect(
      validateHubJwt(token, { expectedAudience: "vault.personal" }),
    ).rejects.toThrow(/audience mismatch.*vault\.personal.*vault\.work.*operator/);
  });

  test("array aud: surfaces the first entry when no expectation is set", async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: ["vault.first", "vault.second"],
    });
    const claims = await validateHubJwt(token, { expectedAudience: null });
    expect(claims.aud).toBe("vault.first");
  });
});

describe("validateHubJwt — failure modes", () => {
  test("wrong issuer → throws", async () => {
    const token = await signJwt(kp, { iss: "http://attacker.example" });
    await expect(validateHubJwt(token)).rejects.toThrow(/verification failed/);
  });

  test("expired token → throws", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signJwt(kp, { iss: fixture.origin, expiresAtSeconds: past });
    await expect(validateHubJwt(token)).rejects.toThrow(/verification failed/);
  });

  test("bad signature (token signed by an unpublished key) → throws", async () => {
    const otherKp = await makeKeypair("k1"); // same kid, different key
    const token = await signJwt(otherKp, { iss: fixture.origin });
    await expect(validateHubJwt(token)).rejects.toThrow(/verification failed/);
  });

  test("unknown kid → throws", async () => {
    const token = await signJwt(kp, { iss: fixture.origin, kid: "does-not-exist" });
    await expect(validateHubJwt(token)).rejects.toThrow(/verification failed/);
  });

  test("missing kid header → throws when JWKS has multiple keys", async () => {
    // jose's createRemoteJWKSet falls back to the only key when JWKS has just
    // one — so to exercise the "no kid" failure path we need ≥2 keys.
    const kp2 = await makeKeypair("k2");
    fixture.setKeys([kp, kp2]);
    resetJwksCache();
    const token = await signJwt(kp, { iss: fixture.origin, omitKid: true });
    await expect(validateHubJwt(token)).rejects.toThrow(/verification failed/);
  });

  test("JWKS endpoint unreachable → throws (fail closed)", async () => {
    fixture.setUnreachable(true);
    const token = await signJwt(kp, { iss: fixture.origin });
    await expect(validateHubJwt(token)).rejects.toThrow(/verification failed/);
  });

  test("missing `sub` claim → throws", async () => {
    // SignJWT requires .setSubject; build the token manually-ish: pass empty sub.
    const iat = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ scope: "vault:read" })
      .setProtectedHeader({ alg: "RS256", kid: kp.kid })
      .setIssuer(fixture.origin)
      .setAudience("operator")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .setJti("jti-no-sub")
      .sign(kp.privateKey);
    await expect(validateHubJwt(token)).rejects.toThrow(/missing required `sub`/);
  });
});

describe("validateHubJwt — JWKS rotation", () => {
  test("rotated key (new kid published) verifies after cache reset", async () => {
    const kp2 = await makeKeypair("k2");
    fixture.setKeys([kp, kp2]);
    resetJwksCache();
    const token = await signJwt(kp2, { iss: fixture.origin });
    const claims = await validateHubJwt(token);
    expect(claims.sub).toBe("user-1");
  });
});
