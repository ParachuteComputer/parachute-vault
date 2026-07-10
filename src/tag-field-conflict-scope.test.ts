/**
 * Tag-scope scrub on cross-tag field-conflict errors (vault#554
 * auth-and-scope review fold, refined by the wire review).
 *
 * Core's cross-tag field validation (`collectCrossTagFieldViolations` /
 * `collectTagFieldViolations`, core/src/tag-schemas.ts) scans EVERY tag's
 * schema — scope-unaware by architecture — so a tag-scoped caller updating
 * its own in-scope tag used to receive violations NAMING an out-of-scope
 * tag and revealing its declared type/indexed flag (proven live on both MCP
 * and REST during review). The fix keeps the rejection (schema integrity is
 * scope-independent) but generalizes any violation whose conflicting
 * declarer is outside the caller's allowlist: no tag name, no declared
 * type/flag, `other_tag` dropped (`scrubTagFieldViolationsByScope`,
 * src/tag-scope.ts). In-scope declarers keep full detail; unscoped callers
 * are untouched.
 *
 * The same information leaks through a SECOND door (wire-review
 * interaction): a BOTH-indexed cross-tag type conflict deliberately
 * bypasses the 422 pre-check to preserve its pre-existing `declareField` →
 * 400 `invalid_indexed_field` contract, and declareField's message names
 * the other declarer tag(s) + their sqlite type. `scrubIndexedFieldConflictError`
 * generalizes that message for scoped callers — same 400, same error_type,
 * no leak. Covered on both surfaces below.
 *
 * Fixture: PARACHUTE_HOME temp home + hand-built AuthResult, same pattern
 * as mcp-list-tags-scope.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { handleTags } from "./routes.ts";
import type { AuthResult } from "./auth.ts";
import { TagFieldConflictError } from "../core/src/tag-schemas.ts";
import { IndexedFieldError } from "../core/src/indexed-fields.ts";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-tagconflict-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();
});

afterEach(() => {
  clearVaultStoreCache();
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function seedVault(name: string): void {
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  getVaultStore(name);
}

function authFor(vaultName: string, scopedTags: string[] | null): AuthResult {
  return {
    permission: "full",
    scopes: [`vault:${vaultName}:read`, `vault:${vaultName}:write`],
    legacyDerived: false,
    scoped_tags: scopedTags,
    vault_name: null,
    caller_jti: null,
    actor: "test-user",
    via: "api",
  };
}

async function updateTagTool(vaultName: string, scopedTags: string[] | null) {
  const tools = generateScopedMcpTools(vaultName, authFor(vaultName, scopedTags));
  return tools.find((t) => t.name === "update-tag")!;
}

/** Everything an agent-facing serialization of the error could carry. */
function serializeError(err: TagFieldConflictError): string {
  return JSON.stringify({ message: err.message, tag: err.tag, violations: err.violations });
}

describe("tag_field_conflict × tag scope — out-of-scope declarers scrubbed (vault#554 fold)", () => {
  test("MCP: scoped caller + out-of-scope NON-indexed type conflict → still rejected (422 class), but the out-of-scope tag's name and schema appear NOWHERE in the error", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    // Out-of-scope declarer with a distinctive name + type (non-indexed —
    // the both-indexed variant routes through the 400 path, tested below).
    await store.upsertTagRecord("project-manhattan", {
      fields: { x: { type: "string" } },
    });
    // Caller's own in-scope tag.
    await store.upsertTagRecord("mine", { description: "in scope" });

    const tool = await updateTagTool("journal", ["mine"]);
    let caught: unknown;
    try {
      await tool.execute({ tag: "mine", fields: { x: { type: "integer" } } });
    } catch (e) {
      caught = e;
    }

    // The write is STILL rejected — integrity is scope-independent.
    expect(caught).toBeInstanceOf(TagFieldConflictError);
    const err = caught as TagFieldConflictError;
    expect(err.violations).toHaveLength(1);
    expect(err.violations[0]!.field).toBe("x");
    expect(err.violations[0]!.reason).toBe("type_conflict");
    expect(err.message).toContain("no changes were applied");

    // The scrub: no tag name, no declared type, no other_tag — anywhere.
    expect(err.violations[0]!.other_tag).toBeUndefined();
    const serialized = serializeError(err);
    expect(serialized).not.toContain("project-manhattan");
    expect(serialized).not.toContain('declares "string"');

    // Nothing persisted.
    const mine = await store.getTagRecord("mine");
    expect(mine?.fields ?? null).toBeFalsy();
  });

  test("MCP: scoped caller + IN-scope conflict keeps full detail (tag name + declared type + other_tag)", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("mine-too", {
      fields: { x: { type: "string" } },
    });
    await store.upsertTagRecord("mine", { description: "in scope" });

    const tool = await updateTagTool("journal", ["mine", "mine-too"]);
    let caught: unknown;
    try {
      await tool.execute({ tag: "mine", fields: { x: { type: "integer" } } });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TagFieldConflictError);
    const err = caught as TagFieldConflictError;
    expect(err.violations).toHaveLength(1);
    expect(err.violations[0]!.other_tag).toBe("mine-too");
    expect(err.violations[0]!.message).toContain("mine-too");
    expect(err.violations[0]!.message).toContain('declares "string"');
  });

  test("REST: scoped caller + out-of-scope NON-indexed type conflict → 422 with generalized violation, out-of-scope tag name nowhere in the body", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("project-manhattan", {
      fields: { x: { type: "string" } },
    });
    await store.upsertTagRecord("mine", { description: "in scope" });

    const req = new Request("http://localhost/api/tags/mine", {
      method: "PUT",
      body: JSON.stringify({ fields: { x: { type: "integer" } } }),
    });
    const res = await handleTags(req, store, "/mine", {
      allowed: new Set(["mine"]),
      raw: ["mine"],
    });

    expect(res.status).toBe(422);
    const body: any = await res.json();
    expect(body.error_type).toBe("tag_field_conflict");
    expect(body.violations).toHaveLength(1);
    expect(body.violations[0].field).toBe("x");
    expect(body.violations[0].reason).toBe("type_conflict");
    expect(body.violations[0].other_tag).toBeUndefined();
    expect(body.message).toContain("no changes were applied");

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("project-manhattan");
    expect(serialized).not.toContain('declares "string"');

    const mine = await store.getTagRecord("mine");
    expect(mine?.fields ?? null).toBeFalsy();
  });

  test("REST: scoped caller + IN-scope conflict keeps full detail", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("mine-too", {
      fields: { x: { type: "string" } },
    });
    await store.upsertTagRecord("mine", { description: "in scope" });

    const req = new Request("http://localhost/api/tags/mine", {
      method: "PUT",
      body: JSON.stringify({ fields: { x: { type: "integer" } } }),
    });
    const res = await handleTags(req, store, "/mine", {
      allowed: new Set(["mine", "mine-too"]),
      raw: ["mine", "mine-too"],
    });

    expect(res.status).toBe(422);
    const body: any = await res.json();
    expect(body.violations).toHaveLength(1);
    expect(body.violations[0].other_tag).toBe("mine-too");
    expect(body.violations[0].message).toContain("mine-too");
    expect(body.violations[0].message).toContain('declares "string"');
  });

  test("unscoped callers keep full detail everywhere (MCP + REST controls)", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("project-manhattan", {
      fields: { x: { type: "string" } },
    });

    // MCP — unscoped session: applyTagScopeWrappers never installs, core's
    // full-detail error passes through untouched.
    const tool = await updateTagTool("journal", null);
    let caught: unknown;
    try {
      await tool.execute({ tag: "mine", fields: { x: { type: "integer" } } });
    } catch (e) {
      caught = e;
    }
    const err = caught as TagFieldConflictError;
    expect(err.violations[0]!.other_tag).toBe("project-manhattan");
    expect(err.violations[0]!.message).toContain("project-manhattan");

    // REST — unscoped ctx (allowed === null): scrub is a no-op.
    const req = new Request("http://localhost/api/tags/mine", {
      method: "PUT",
      body: JSON.stringify({ fields: { x: { type: "integer" } } }),
    });
    const res = await handleTags(req, store, "/mine");
    expect(res.status).toBe(422);
    const body: any = await res.json();
    expect(body.violations[0].other_tag).toBe("project-manhattan");
    expect(body.violations[0].message).toContain("project-manhattan");
  });
});

describe("invalid_indexed_field × tag scope — the 400 door is scrubbed too (wire-review interaction)", () => {
  test("REST: scoped caller + BOTH-indexed type conflict vs out-of-scope tag → 400 invalid_indexed_field (status preserved) with a generalized message", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("project-manhattan", {
      fields: { x: { type: "string", indexed: true } },
    });
    await store.upsertTagRecord("mine", { description: "in scope" });

    const req = new Request("http://localhost/api/tags/mine", {
      method: "PUT",
      body: JSON.stringify({ fields: { x: { type: "integer", indexed: true } } }),
    });
    const res = await handleTags(req, store, "/mine", {
      allowed: new Set(["mine"]),
      raw: ["mine"],
    });

    // Status + error_type are the PRESERVED pre-existing contract; only
    // the message prose is generalized for the scoped caller.
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error_type).toBe("invalid_indexed_field");
    expect(body.error).toContain('field "x"');
    expect(body.error).toContain("outside your token's tag scope");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("project-manhattan");
    expect(serialized).not.toContain("TEXT"); // the existing sqlite type stays hidden too

    // Still rejected — nothing persisted.
    const mine = await store.getTagRecord("mine");
    expect(mine?.fields ?? null).toBeFalsy();
  });

  test("MCP: scoped caller + BOTH-indexed type conflict vs out-of-scope tag → IndexedFieldError with a generalized message", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("project-manhattan", {
      fields: { x: { type: "string", indexed: true } },
    });
    await store.upsertTagRecord("mine", { description: "in scope" });

    const tool = await updateTagTool("journal", ["mine"]);
    let caught: any;
    try {
      await tool.execute({ tag: "mine", fields: { x: { type: "integer", indexed: true } } });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(IndexedFieldError);
    expect(caught.error_type).toBe("invalid_indexed_field");
    expect(caught.message).toContain("outside your token's tag scope");
    expect(caught.message).not.toContain("project-manhattan");
    expect(caught.message).not.toContain("TEXT");
    // The structured declarer context is dropped from the scrubbed error.
    expect(caught.declarer_tags).toBeUndefined();
  });

  test("both-indexed conflict vs an IN-scope tag keeps declareField's full message on both surfaces", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("mine-too", {
      fields: { x: { type: "string", indexed: true } },
    });
    await store.upsertTagRecord("mine", { description: "in scope" });

    // REST
    const req = new Request("http://localhost/api/tags/mine", {
      method: "PUT",
      body: JSON.stringify({ fields: { x: { type: "integer", indexed: true } } }),
    });
    const res = await handleTags(req, store, "/mine", {
      allowed: new Set(["mine", "mine-too"]),
      raw: ["mine", "mine-too"],
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error_type).toBe("invalid_indexed_field");
    expect(body.error).toContain("mine-too");

    // MCP
    const tool = await updateTagTool("journal", ["mine", "mine-too"]);
    let caught: any;
    try {
      await tool.execute({ tag: "mine", fields: { x: { type: "integer", indexed: true } } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IndexedFieldError);
    expect(caught.message).toContain("mine-too");
  });
});
