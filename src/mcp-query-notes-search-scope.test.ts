/**
 * Combined tag-scope × full-text-search enforcement (vault#554 carry-forward
 * — "auth-561" review traced the code clean; this commits the self-verifying
 * test the review promised).
 *
 * `applyTagScopeWrappers`'s `query-notes` wrapper (`src/mcp-tools.ts`) runs
 * the ENTIRE search — content matching, `search_mode` escaping, `sort` — via
 * core (scope-unaware by architecture), then filters the returned notes
 * against the token's allowlist as a post-hoc array `.filter()`
 * (`noteWithinTagScope`, `src/tag-scope.ts`). Because the filter is applied
 * uniformly AFTER core returns, in principle no single (mode, sort)
 * combination is special — but a regression in one code path (e.g. a search
 * branch that bypasses the wrapper, or a shape the filter doesn't recognize)
 * could still slip an out-of-scope note through for SOME combination. This
 * test exercises the full `search_mode × sort` matrix and asserts the
 * out-of-scope note never appears in any of them.
 *
 * Fixture: two notes both match the search term "widget" in punctuation-
 * bearing content (so literal-mode escaping and advanced-mode raw FTS5 both
 * still match it) — one tagged in-scope (`health`), one out-of-scope
 * (`work`). A tag-scoped session ["health"] must see only the in-scope note
 * across every (search_mode, sort) pairing.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import type { AuthResult } from "./auth.ts";
import { SEARCH_MODES } from "../core/src/search-query.ts";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-search-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// Normalize the tool's response (bare array, or {notes, next_cursor?,
// warnings?} in cursor/warnings mode) down to the note-id list actually
// returned — search is never cursor mode, but stays defensive to shape.
function idsOf(result: unknown): string[] {
  if (Array.isArray(result)) return result.map((n: any) => n.id);
  const notes = (result as any)?.notes;
  return Array.isArray(notes) ? notes.map((n: any) => n.id) : [];
}

describe("MCP query-notes search × tag-scope — combined enforcement (vault#554 carry-forward)", () => {
  test("out-of-scope notes never appear across every search_mode × sort combination", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");

    // Punctuation-bearing content so literal-mode's escaping and
    // advanced-mode's raw FTS5 passthrough both still match "widget"
    // cleanly (advanced mode has no operator characters to trip on here).
    const inScope = await store.createNote("didn't fix the widget yet", { tags: ["health"] });
    const outOfScope = await store.createNote("ordered a replacement widget", { tags: ["work"] });

    const tool = await queryNotesTool("journal", ["health"]);

    const sorts: (undefined | "asc" | "desc")[] = [undefined, "asc", "desc"];
    const modes: (undefined | (typeof SEARCH_MODES)[number])[] = [undefined, ...SEARCH_MODES];

    for (const search_mode of modes) {
      for (const sort of sorts) {
        const params: Record<string, unknown> = { search: "widget" };
        if (search_mode !== undefined) params.search_mode = search_mode;
        if (sort !== undefined) params.sort = sort;

        const result = await tool.execute(params);
        const ids = idsOf(result);

        expect(ids).toContain(inScope.id);
        expect(ids).not.toContain(outOfScope.id);
      }
    }
  });

  test("unscoped session sees both notes across the same matrix (control)", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");

    const a = await store.createNote("didn't fix the widget yet", { tags: ["health"] });
    const b = await store.createNote("ordered a replacement widget", { tags: ["work"] });

    const tool = await queryNotesTool("journal", null);

    for (const search_mode of [undefined, ...SEARCH_MODES]) {
      for (const sort of [undefined, "asc", "desc"] as const) {
        const params: Record<string, unknown> = { search: "widget" };
        if (search_mode !== undefined) params.search_mode = search_mode;
        if (sort !== undefined) params.sort = sort;

        const ids = idsOf(await tool.execute(params));
        expect(ids).toContain(a.id);
        expect(ids).toContain(b.id);
      }
    }
  });
});
