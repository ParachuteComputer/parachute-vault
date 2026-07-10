/**
 * Tag-scope interaction with create-note/update-note's `unresolved_link` /
 * `ambiguous_link` warnings (vault#555, vault#570).
 *
 * `applyTagScopeWrappers`'s `query-notes` wrapper (src/mcp-tools.ts) DROPS
 * its `warnings` array for a tag-scoped session — `unknown_tag`/
 * `did_you_mean`/`search_did_you_mean` are computed against the FULL
 * vault-wide tag catalog / FTS5 vocabulary, so surfacing them to a scoped
 * caller would leak an out-of-scope tag's/note's existence (see
 * docs/HTTP_API.md's "Tag-scoped tokens never see unknown_tag/did_you_mean
 * or search_did_you_mean" paragraph, and docs/contracts/tag-scoped-tokens.md).
 *
 * `create-note`/`update-note`'s link warnings are a DIFFERENT case: they
 * describe the CALLER'S OWN note's own outgoing link, named by the caller —
 * not a vault-wide vocabulary scan the caller wouldn't otherwise see. The
 * existing `unresolved_link` warning (structured `links`, vault#555) was
 * never gated by `applyTagScopeWrappers`'s `create-note`/`update-note`
 * wrappers (see `wrapReadTool(tools, "create-note", ...)` /
 * `"update-note"` in src/mcp-tools.ts — neither calls `scrubNoteLinks` or
 * strips `.warnings`), and docs/HTTP_API.md's "never see" list names only
 * the vault-wide-vocabulary warnings above, NOT `unresolved_link`.
 *
 * This test locks in that vault#570's new content-wikilink `unresolved_link`
 * and the new `ambiguous_link` warning (both content and structured) follow
 * that SAME existing pattern — present under a tag-scoped session, exactly
 * as they are unscoped — rather than silently introducing a NEW special
 * case one way or the other.
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
  tmpHome = join(tmpdir(), `vault-link-warnings-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function toolsFor(vaultName: string, scopedTags: string[] | null) {
  return generateScopedMcpTools(vaultName, authFor(vaultName, scopedTags));
}

describe("create-note/update-note link warnings under a tag-scoped session (vault#570)", () => {
  test("scoped create-note: content [[wikilink]] to a missing target still warns (unresolved_link) — same as unscoped", async () => {
    seedVault("journal");
    const tools = toolsFor("journal", ["health"]);
    const createNote = tools.find((t) => t.name === "create-note")!;

    const result = (await createNote.execute({
      content: "See [[Missing Health Note]].",
      tags: ["health"],
    })) as any;

    expect(result.warnings).toBeDefined();
    expect(result.warnings[0].code).toBe("unresolved_link");
    expect(result.warnings[0].target).toBe("Missing Health Note");
  });

  test("scoped create-note: content [[wikilink]] to an ambiguous target still warns (ambiguous_link), no edge — same as unscoped", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    await store.createNote("A", { path: "Folder1/ScopedDup", tags: ["health"] });
    await store.createNote("B", { path: "Folder2/ScopedDup", tags: ["health"] });

    const tools = toolsFor("journal", ["health"]);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const result = (await createNote.execute({
      content: "See [[ScopedDup]].",
      tags: ["health"],
    })) as any;

    expect(result.warnings).toBeDefined();
    expect(result.warnings[0].code).toBe("ambiguous_link");
    expect(result.warnings[0].candidate_count).toBe(2);
    expect(await store.getLinks(result.id, { direction: "outbound" })).toHaveLength(0);
  });

  test("scoped update-note: content update introducing a [[wikilink]] to a missing target still warns", async () => {
    seedVault("journal");
    const store = getVaultStore("journal");
    const note = await store.createNote("plain", { path: "ScopedUpdatable", tags: ["health"] });

    const tools = toolsFor("journal", ["health"]);
    const updateNote = tools.find((t) => t.name === "update-note")!;
    const result = (await updateNote.execute({
      id: note.id,
      content: "now references [[Still Missing Scoped]]",
      force: true,
    })) as any;

    expect(result.warnings).toBeDefined();
    expect(result.warnings[0].code).toBe("unresolved_link");
    expect(result.warnings[0].target).toBe("Still Missing Scoped");
  });

  test("unscoped session sees the identical warning shape (parity check)", async () => {
    seedVault("journal");
    const tools = toolsFor("journal", null);
    const createNote = tools.find((t) => t.name === "create-note")!;

    const result = (await createNote.execute({
      content: "See [[Missing Health Note]].",
    })) as any;

    expect(result.warnings).toBeDefined();
    expect(result.warnings[0].code).toBe("unresolved_link");
    expect(result.warnings[0].target).toBe("Missing Health Note");
  });
});
