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
import { resetJwksCache, validateHubJwt, looksLikeJwt } from "./hub-jwt.ts";

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
      if (url.pathname !== "/.well-known/jwks.json") {
        return new Response("not found", { status: 404 });
      }
      if (down) return new Response("upstream down", { status: 503 });
      return Response.json({ keys: keys.map((k) => k.publicJwk) });
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
  aud?: string;
  sub?: string;
  scope?: string;
  jti?: string;
  clientId?: string;
  ttlSeconds?: number;
  expiresAtSeconds?: number;
  omitKid?: boolean;
  kid?: string;
}

async function signJwt(kp: Keypair, opts: SignOpts): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = opts.expiresAtSeconds ?? iat + (opts.ttlSeconds ?? 60);
  const builder = new SignJWT({
    scope: opts.scope ?? "vault:read vault:write",
    client_id: opts.clientId ?? "test-client",
  })
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

beforeAll(async () => {
  fixture = startJwksFixture();
  kp = await makeKeypair("k1");
  fixture.setKeys([kp]);
});

afterAll(() => {
  fixture.stop();
  if (prevHubOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = prevHubOrigin;
});

beforeEach(() => {
  // Each test sets its own origin for clarity.
  prevHubOrigin = process.env.PARACHUTE_HUB_ORIGIN;
  process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
  fixture.setUnreachable(false);
  fixture.setKeys([kp]);
  resetJwksCache();
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
