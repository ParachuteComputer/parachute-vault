/**
 * #780 review blocker — `target_tags` must not leak tags/existence of a note
 * the tag-scoped caller can't see. A hidden target is treated exactly like an
 * unresolved one (advisory `unresolved_reference`, never rejected), and no
 * message ever carries the target's tag list.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { handleNotes, type TagScopeCtx } from "./routes.ts";
import { expandTokenTagScope } from "./tag-scope.ts";
import type { AuthResult } from "./auth.ts";
import type { Store } from "../core/src/types.ts";

const HIDDEN_TAG = "hidden-zzz-secret";
let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-780-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

async function seed(strict: boolean): Promise<Store> {
  writeVaultConfig({ name: "v", api_keys: [], created_at: new Date().toISOString() });
  const store = getVaultStore("v");
  await store.upsertTagRecord("node", {});
  await store.upsertTagRecord("task", {
    fields: { node: { type: "reference", target_tags: ["node"], ...(strict ? { strict: true } : {}) } },
  });
  // Hidden: wrong type AND outside the token's scope (task + node only).
  await store.createNote("secret", { path: "Hidden/note", tags: [HIDDEN_TAG] });
  // Visible, wrong type: carries only an in-scope non-node tag.
  await store.upsertTagRecord("other", {});
  await store.createNote("vis", { path: "Vis/other", tags: ["other"] });
  return store;
}

function auth(scoped: string[] | null): AuthResult {
  return {
    permission: "full",
    scopes: ["vault:v:read", "vault:v:write"],
    legacyDerived: false,
    scoped_tags: scoped,
    vault_name: null,
    caller_jti: null,
    actor: "t",
    via: "api",
  } as AuthResult;
}
const SCOPE = ["task", "node", "other"];

async function mcpCreate(target: string, scoped: string[] | null): Promise<{ ok: boolean; out: any }> {
  const tool = generateScopedMcpTools("v", auth(scoped) as any).find((t) => t.name === "create-note")!;
  try {
    return { ok: true, out: await tool.execute({ content: "t", tags: ["task"], metadata: { node: target } }) };
  } catch (e: any) {
    return { ok: false, out: { message: String(e?.message ?? e), type: e?.error_type ?? e?.name, e } };
  }
}
async function restCreate(store: Store, target: string, scoped: string[] | null): Promise<{ status: number; body: any }> {
  const scope: TagScopeCtx = { allowed: await expandTokenTagScope(store, scoped), raw: scoped };
  const req = new Request("http://localhost/vault/v/api/notes", {
    method: "POST",
    body: JSON.stringify({ content: "t", tags: ["task"], metadata: { node: target } }),
    headers: { "content-type": "application/json" },
  });
  const res = await handleNotes(req, store, "", "v", scope);
  return { status: res.status, body: await res.json() };
}
const reasons = (vs: any) => (vs?.warnings ?? []).map((w: any) => w.reason);

for (const strict of [false, true]) {
  describe(`target_tags scope (${strict ? "strict" : "advisory"} field)`, () => {
    test("MCP: hidden wrong-type target == nonexistent target; no hidden tag leaked", async () => {
      await seed(strict);
      const hidden = await mcpCreate("Hidden/note", SCOPE);
      const missing = await mcpCreate("Nowhere/at-all", SCOPE);
      expect(hidden.ok).toBe(true);
      expect(missing.ok).toBe(true);
      expect(reasons(hidden.out.validation_status)).toEqual(["unresolved_reference"]);
      expect(reasons(missing.out.validation_status)).toEqual(["unresolved_reference"]);
      expect(hidden.out.validation_status.warnings[0].strict).toBeUndefined();
      expect(JSON.stringify(hidden.out)).not.toContain(HIDDEN_TAG);
    });

    test("REST: hidden wrong-type target == nonexistent target; no hidden tag leaked", async () => {
      const store = await seed(strict);
      const hidden = await restCreate(store, "Hidden/note", SCOPE);
      const missing = await restCreate(store, "Nowhere/at-all", SCOPE);
      expect(hidden.status).toBe(missing.status);
      expect(hidden.status).toBe(201);
      expect(reasons(hidden.body.validation_status)).toEqual(["unresolved_reference"]);
      expect(reasons(missing.body.validation_status)).toEqual(["unresolved_reference"]);
      expect(JSON.stringify(hidden.body)).not.toContain(HIDDEN_TAG);
    });

    test("scoped but target visible and wrong type: still a mismatch, message names only expected tags", async () => {
      const store = await seed(strict);
      const r = await restCreate(store, "Vis/other", SCOPE);
      if (strict) {
        expect(r.status).toBe(422);
        expect(r.body.error_type).toBe("schema_validation");
      } else {
        expect(r.status).toBe(201);
        expect(reasons(r.body.validation_status)).toEqual(["target_tag_mismatch"]);
      }
      const text = JSON.stringify(r.body);
      expect(text).not.toContain("target carries");
      expect(text).toContain("node");
    });

    test("UNSCOPED behaviour unchanged: wrong-type target flagged, still no tag list in message", async () => {
      const store = await seed(strict);
      const r = await restCreate(store, "Hidden/note", null);
      if (strict) {
        expect(r.status).toBe(422);
        expect(r.body.error_type).toBe("schema_validation");
      } else {
        expect(reasons(r.body.validation_status)).toEqual(["target_tag_mismatch"]);
      }
      expect(JSON.stringify(r.body)).not.toContain("target carries");
    });
  });
}

describe("target_tags scope — read path", () => {
  test("scoped query-notes of a task pointing at a hidden note shows unresolved_reference", async () => {
    const store = await seed(false);
    const t = await store.createNote("t", { tags: ["task"], metadata: { node: "Hidden/note" } });
    const tool = generateScopedMcpTools("v", auth(SCOPE) as any).find((x) => x.name === "query-notes")!;
    const out: any = await tool.execute({ id: t.id });
    expect(reasons(out.validation_status)).toEqual(["unresolved_reference"]);
    expect(JSON.stringify(out)).not.toContain(HIDDEN_TAG);
  });
});
