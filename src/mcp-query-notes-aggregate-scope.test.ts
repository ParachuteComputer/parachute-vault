/**
 * Tag-scope × `query-notes` `aggregate` mode (top new-feature ask from a UX
 * round).
 *
 * A rollup response is `[{group, value}]` — no per-note `.tags` to post-hoc
 * filter (`noteWithinTagScope`, `src/tag-scope.ts`), unlike every other
 * `query-notes` shape. So `applyTagScopeWrappers`'s generic array-filter
 * (`src/mcp-tools.ts`) is skipped for aggregate requests, and scope is
 * instead enforced BEFORE aggregating via the `aggregateVisibility`
 * predicate wired in `generateScopedMcpTools`: fetch every note the other
 * filters match, narrow to the token's allowlist, THEN aggregate over just
 * that visible id set (see `core/src/mcp.ts`'s aggregate branch). This
 * suite is the self-verifying test for that path — mirrors the harness
 * `src/mcp-query-notes-search-scope.test.ts` uses for the equivalent search
 * × scope concern.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import type { AuthResult } from "./auth.ts";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-aggregate-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

async function queryNotesTool(vaultName: string, scopedTags: string[] | null) {
  const tools = generateScopedMcpTools(vaultName, authFor(vaultName, scopedTags));
  return tools.find((t) => t.name === "query-notes")!;
}

function byGroup(result: unknown): Record<string, number> {
  expect(Array.isArray(result)).toBe(true);
  return Object.fromEntries((result as any[]).map((r) => [String(r.group), r.value]));
}

describe("MCP query-notes aggregate × tag-scope — indexed-field group_by", () => {
  test("count by an indexed field is computed ONLY over notes the scoped token can see", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });

    // Same status values on both sides of the scope boundary, so a leak
    // would silently inflate the in-scope counts rather than producing an
    // obviously-wrong shape.
    await store.createNote("in-scope open 1", { tags: ["task", "health"], metadata: { status: "open" } });
    await store.createNote("in-scope done", { tags: ["task", "health"], metadata: { status: "done" } });
    await store.createNote("out-of-scope open 1", { tags: ["task", "work"], metadata: { status: "open" } });
    await store.createNote("out-of-scope open 2", { tags: ["task", "work"], metadata: { status: "open" } });

    const scopedTool = await queryNotesTool("journal", ["health"]);
    const result = await scopedTool.execute({ aggregate: { group_by: "status", op: "count" } });
    expect(byGroup(result)).toEqual({ open: 1, done: 1 });
  });

  test("sum of an indexed numeric field is computed ONLY over notes the scoped token can see", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("expense", {
      fields: {
        category: { type: "string", indexed: true },
        amount: { type: "integer", indexed: true },
      },
    });
    await store.createNote("in-scope", { tags: ["expense", "health"], metadata: { category: "food", amount: 10 } });
    await store.createNote("out-of-scope", { tags: ["expense", "work"], metadata: { category: "food", amount: 1000 } });

    const scopedTool = await queryNotesTool("journal", ["health"]);
    const result = await scopedTool.execute({
      aggregate: { group_by: "category", op: "sum", field: "amount" },
    });
    expect(byGroup(result)).toEqual({ food: 10 });
  });

  test("unscoped session sees the full rollup across both sides (control)", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    await store.createNote("a", { tags: ["task", "health"], metadata: { status: "open" } });
    await store.createNote("b", { tags: ["task", "work"], metadata: { status: "open" } });

    const unscopedTool = await queryNotesTool("journal", null);
    const result = await unscopedTool.execute({ aggregate: { group_by: "status", op: "count" } });
    expect(byGroup(result)).toEqual({ open: 2 });
  });

  test("a scoped token with no visible matches gets an empty rollup, not an error or a leak", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    await store.createNote("out-of-scope only", { tags: ["task", "work"], metadata: { status: "open" } });

    const scopedTool = await queryNotesTool("journal", ["health"]);
    const result = await scopedTool.execute({ aggregate: { group_by: "status", op: "count" } });
    expect(result).toEqual([]);
  });
});

describe("MCP query-notes aggregate × tag-scope — group_by \"tag\"", () => {
  test("an out-of-scope tag name never appears as a group, even on a co-tagged in-scope note", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    // This note IS in scope (carries "health"), but also carries the
    // out-of-scope tag "secret-project" — the rollup must not surface that
    // second tag as a group just because the note itself is visible.
    await store.createNote("co-tagged", { tags: ["health", "secret-project"] });
    await store.createNote("out-of-scope only", { tags: ["work"] });

    const scopedTool = await queryNotesTool("journal", ["health"]);
    const result = await scopedTool.execute({ aggregate: { group_by: "tag", op: "count" } });
    const groups = (result as any[]).map((r) => r.group);
    expect(groups).toContain("health");
    expect(groups).not.toContain("secret-project");
    expect(groups).not.toContain("work");
    // Belt-and-suspenders: the out-of-scope tag name must not appear ANYWHERE
    // in the serialized response.
    expect(JSON.stringify(result)).not.toContain("secret-project");
    expect(JSON.stringify(result)).not.toContain("\"work\"");
  });
});

describe("MCP query-notes aggregate — count without group_by (vault#626)", () => {
  test("returns [{group: null, value: N}] for the filtered set", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("a", { tags: ["work"] });
    await store.createNote("b", { tags: ["work"] });
    await store.createNote("c", { tags: ["personal"] });

    const tool = await queryNotesTool("journal", null);
    expect(await tool.execute({ aggregate: { op: "count" } })).toEqual([
      { group: null, value: 3 },
    ]);
    expect(await tool.execute({ tag: "work", aggregate: { op: "count" } })).toEqual([
      { group: null, value: 2 },
    ]);
  });

  test("a scoped token's total excludes out-of-scope notes", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("in", { tags: ["health"] });
    await store.createNote("out 1", { tags: ["work"] });
    await store.createNote("out 2", { tags: ["work"] });

    const scopedTool = await queryNotesTool("journal", ["health"]);
    expect(await scopedTool.execute({ aggregate: { op: "count" } })).toEqual([
      { group: null, value: 1 },
    ]);
  });

  test("a scoped token with no visible matches gets a zero total, not []", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("out-of-scope only", { tags: ["work"] });

    const scopedTool = await queryNotesTool("journal", ["health"]);
    expect(await scopedTool.execute({ aggregate: { op: "count" } })).toEqual([
      { group: null, value: 0 },
    ]);
  });
});

describe("MCP query-notes aggregate — mutual exclusivity with search/near/cursor", () => {
  test("aggregate + search is rejected", async () => {
    seedVault("journal");
    const tool = await queryNotesTool("journal", null);
    await expect(
      tool.execute({ search: "x", aggregate: { group_by: "tag", op: "count" } }),
    ).rejects.toThrow();
  });

  test("aggregate + cursor is rejected", async () => {
    seedVault("journal");
    const tool = await queryNotesTool("journal", null);
    await expect(
      tool.execute({ cursor: "", aggregate: { group_by: "tag", op: "count" } }),
    ).rejects.toThrow();
  });

  test("aggregate + near is rejected", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    const anchor = await store.createNote("anchor");
    const tool = await queryNotesTool("journal", null);
    await expect(
      tool.execute({ near: { note_id: anchor.id }, aggregate: { group_by: "tag", op: "count" } }),
    ).rejects.toThrow();
  });
});
