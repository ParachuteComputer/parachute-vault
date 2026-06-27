/**
 * Write-attribution threading (vault#298) — the server-side half: how the
 * authenticated request resolves the two provenance axes onto `AuthResult`,
 * and how the MCP layer refines the `via` channel.
 *
 *   - WHO  (`actor`): JWT `sub` on the hub path; `operator` for the env-var
 *     bearer; `token:<id>` for legacy YAML keys.
 *   - VIA  (`via`):  `api` (credential class) on the REST path; `operator` for
 *     the env-var bearer; refined to `mcp` by the MCP handler.
 *
 * The store-layer column behavior + query filters live in
 * core/src/attribution.test.ts. This file pins the AUTH → AuthResult mapping
 * and the MCP via-refinement end-to-end (an MCP create lands attribution in
 * the row).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  writeVaultConfig,
  writeGlobalConfig,
  readVaultConfig,
  readGlobalConfig,
  generateApiKey,
  hashKey,
} from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { authenticateVaultRequest } from "./auth.ts";
import { resetJwksCache, resetRevocationCache } from "./hub-jwt.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { parseNotesQueryOpts } from "./routes.ts";
import type { AuthResult } from "./auth.ts";

// ---------------------------------------------------------------------------
// Hub-JWT fixture (mirrors auth-hub-jwt.test.ts)
// ---------------------------------------------------------------------------
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
function startHubFixture(keys: Keypair[]): { origin: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") {
        return Response.json({ keys: keys.map((k) => k.publicJwk) });
      }
      if (url.pathname === "/.well-known/parachute-revocation.json") {
        return Response.json({ generated_at: new Date().toISOString(), jtis: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
async function signJwt(
  kp: Keypair,
  opts: { iss: string; aud: string; scope: string; sub?: string },
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return await new SignJWT({ scope: opts.scope, client_id: "test-client" })
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer(opts.iss)
    .setSubject(opts.sub ?? "user-1")
    .setAudience(opts.aud)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .setJti(`jti-${Math.random().toString(36).slice(2)}`)
    .sign(kp.privateKey);
}
function bearer(token: string): Request {
  return new Request("https://vault.test/x", { headers: { Authorization: `Bearer ${token}` } });
}

let tmpHome: string;
let prevHome: string | undefined;
let prevHubOrigin: string | undefined;
let prevJwksOrigin: string | undefined;
let prevAuthToken: string | undefined;
let fixture: { origin: string; stop: () => void };
let kp: Keypair;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `vault-attr-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();

  kp = await makeKeypair("k1");
  fixture = startHubFixture([kp]);
  prevHubOrigin = process.env.PARACHUTE_HUB_ORIGIN;
  prevJwksOrigin = process.env.PARACHUTE_HUB_JWKS_ORIGIN;
  prevAuthToken = process.env.VAULT_AUTH_TOKEN;
  process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
  process.env.PARACHUTE_HUB_JWKS_ORIGIN = fixture.origin;
  delete process.env.VAULT_AUTH_TOKEN;
  resetJwksCache();
  resetRevocationCache();
});

afterEach(() => {
  fixture.stop();
  clearVaultStoreCache();
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("PARACHUTE_HOME", prevHome);
  restore("PARACHUTE_HUB_ORIGIN", prevHubOrigin);
  restore("PARACHUTE_HUB_JWKS_ORIGIN", prevJwksOrigin);
  restore("VAULT_AUTH_TOKEN", prevAuthToken);
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function seedVaultWithKey(name: string): string {
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
  getVaultStore(name);
  return fullKey;
}

function seedVaultNoKey(name: string): void {
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  getVaultStore(name);
}

describe("attribution threading — AuthResult actor/via derivation", () => {
  test("hub JWT → actor = sub, via = 'api' (the REST credential class)", async () => {
    seedVaultNoKey("journal");
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "vault.journal",
      scope: "vault:journal:write",
      sub: "mathilda",
    });
    const result = await authenticateVaultRequest(bearer(token), readVaultConfig("journal")!);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.actor).toBe("mathilda");
      expect(result.via).toBe("api");
    }
  });

  test("VAULT_AUTH_TOKEN operator bearer → actor = via = 'operator'", async () => {
    seedVaultNoKey("journal");
    process.env.VAULT_AUTH_TOKEN = "super-secret-operator-bearer";
    const result = await authenticateVaultRequest(
      bearer("super-secret-operator-bearer"),
      readVaultConfig("journal")!,
    );
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.actor).toBe("operator");
      expect(result.via).toBe("operator");
    }
  });

  test("legacy YAML api_key → actor = 'token:<id>', via = 'api' (never crashes)", async () => {
    const fullKey = seedVaultWithKey("journal");
    const result = await authenticateVaultRequest(bearer(fullKey), readVaultConfig("journal")!);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.actor).toMatch(/^token:[0-9a-f]{1,}$/i);
      expect(result.via).toBe("api");
      expect(result.legacyDerived).toBe(true);
    }
  });
});

describe("attribution threading — MCP refines via to 'mcp' and stamps the write", () => {
  function authFor(sub: string, vaultName: string): AuthResult {
    return {
      permission: "full",
      scopes: [`vault:${vaultName}:write`, `vault:${vaultName}:read`],
      legacyDerived: false,
      scoped_tags: null,
      vault_name: null,
      caller_jti: null,
      actor: sub,
      via: "api", // base class from auth; the MCP layer should refine to "mcp"
    };
  }

  test("a create-note through the MCP tools lands actor=sub + via='mcp'", async () => {
    seedVaultNoKey("journal");
    const auth = authFor("aaron", "journal");
    const tools = generateScopedMcpTools("journal", auth, null);
    const create = tools.find((t) => t.name === "create-note")!;
    const created = (await create.execute({ content: "via mcp" })) as {
      id: string;
      createdBy?: string | null;
      createdVia?: string | null;
      lastUpdatedVia?: string | null;
    };
    expect(created.createdBy).toBe("aaron");
    expect(created.createdVia).toBe("mcp");
    expect(created.lastUpdatedVia).toBe("mcp");

    // Confirm it persisted to the row, not just the response shape.
    const store = getVaultStore("journal");
    const row = store.db
      .prepare("SELECT created_by, created_via FROM notes WHERE id = ?")
      .get(created.id) as { created_by: string | null; created_via: string | null };
    expect(row.created_by).toBe("aaron");
    expect(row.created_via).toBe("mcp");
  });

  test("an update-note through the MCP tools bumps last_updated_via='mcp'", async () => {
    seedVaultNoKey("journal");
    const store = getVaultStore("journal");
    const seed = await store.createNote("seed", { actor: "aaron", via: "api" });

    const auth = authFor("aaron", "journal");
    const tools = generateScopedMcpTools("journal", auth, null);
    const update = tools.find((t) => t.name === "update-note")!;
    // `force: true` waives the optimistic-concurrency precondition (we don't
    // echo updated_at in this focused test).
    await update.execute({ id: seed.id, content: "edited via mcp", force: true });

    const after = await store.getNote(seed.id);
    expect(after?.createdVia).toBe("api"); // set-once original channel
    expect(after?.lastUpdatedBy).toBe("aaron");
    expect(after?.lastUpdatedVia).toBe("mcp"); // refined channel of the latest edit
  });

  test("update-note with if_missing:'create' on a MISSING note attributes the created row", async () => {
    // Regression: the upsert-create branch built createOpts without actor/via,
    // so an MCP-driven upsert that CREATES a note wrote NULL attribution while
    // create-note + REST upsert-create did it right. (vault#298 review.)
    seedVaultNoKey("journal");
    const store = getVaultStore("journal");

    const tools = generateScopedMcpTools("journal", authFor("aaron", "journal"), null);
    const update = tools.find((t) => t.name === "update-note")!;
    const created = (await update.execute({
      id: "Projects/Brand New",
      content: "born via upsert",
      if_missing: "create",
    })) as { id: string; createdBy?: string | null; createdVia?: string | null };

    // The note did not exist → this is a create; attribution must be set.
    expect(created.createdBy).toBe("aaron");
    expect(created.createdVia).toBe("mcp"); // refined channel, not NULL

    // Confirm it persisted to the row, not just the echoed shape.
    const row = store.db
      .prepare(
        "SELECT created_by, created_via, last_updated_by, last_updated_via FROM notes WHERE id = ?",
      )
      .get(created.id) as {
      created_by: string | null;
      created_via: string | null;
      last_updated_by: string | null;
      last_updated_via: string | null;
    };
    expect(row.created_by).toBe("aaron");
    expect(row.created_via).toBe("mcp");
    // First write IS the latest write — the last_updated_* pair mirrors it.
    expect(row.last_updated_by).toBe("aaron");
    expect(row.last_updated_via).toBe("mcp");
  });

  test("the operator bearer keeps via='operator' even on the MCP channel", async () => {
    seedVaultNoKey("journal");
    const auth: AuthResult = {
      permission: "full",
      scopes: ["vault:admin", "vault:write", "vault:read"],
      legacyDerived: false,
      scoped_tags: null,
      vault_name: null,
      caller_jti: null,
      actor: "operator",
      via: "operator",
    };
    const tools = generateScopedMcpTools("journal", auth, null);
    const create = tools.find((t) => t.name === "create-note")!;
    const created = (await create.execute({ content: "op write" })) as {
      createdVia?: string | null;
    };
    expect(created.createdVia).toBe("operator");
  });

  test("content_edit (surgical find-and-replace) also attributes the latest edit", async () => {
    seedVaultNoKey("journal");
    const store = getVaultStore("journal");
    const seed = await store.createNote("hello WORLD", { actor: "aaron", via: "api" });

    const tools = generateScopedMcpTools("journal", authFor("mathilda", "journal"), null);
    const update = tools.find((t) => t.name === "update-note")!;
    await update.execute({
      id: seed.id,
      content_edit: { old_text: "WORLD", new_text: "there" },
      force: true,
    });

    const after = await store.getNote(seed.id);
    expect(after?.content).toBe("hello there");
    expect(after?.createdBy).toBe("aaron"); // set-once
    expect(after?.lastUpdatedBy).toBe("mathilda"); // content_edit flows through updateNote
    expect(after?.lastUpdatedVia).toBe("mcp");
  });
});

describe("attribution threading — REST query filters (symmetric with MCP)", () => {
  test("parseNotesQueryOpts wires the four attribution filter params", () => {
    const url = new URL(
      "http://localhost:1940/vault/journal/api/notes" +
        "?created_by=aaron&last_updated_by=agent:nightly" +
        "&created_via=surface:meeting-ingest&last_updated_via=mcp",
    );
    const { queryOpts } = parseNotesQueryOpts(url);
    expect(queryOpts?.createdBy).toBe("aaron");
    expect(queryOpts?.lastUpdatedBy).toBe("agent:nightly");
    expect(queryOpts?.createdVia).toBe("surface:meeting-ingest");
    expect(queryOpts?.lastUpdatedVia).toBe("mcp");
  });

  test("absent attribution params leave the filters undefined (no spurious filtering)", () => {
    const url = new URL("http://localhost:1940/vault/journal/api/notes?tag=daily");
    const { queryOpts } = parseNotesQueryOpts(url);
    expect(queryOpts?.createdBy).toBeUndefined();
    expect(queryOpts?.lastUpdatedVia).toBeUndefined();
  });
});
