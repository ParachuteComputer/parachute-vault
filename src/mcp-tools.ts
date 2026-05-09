/**
 * MCP tool generation for the scoped (per-vault) MCP endpoint.
 *
 * Every MCP session is now bound to one vault via `/vault/<name>/mcp`, so
 * tools operate on that vault and vault-info picks up its config directly.
 */

import { generateMcpTools } from "../core/src/mcp.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import {
  buildVaultProjection,
  projectionToMarkdown,
  type VaultProjection,
} from "../core/src/vault-projection.ts";
import { readVaultConfig, writeVaultConfig } from "./config.ts";
import { getVaultStore } from "./vault-store.ts";
import { hasScopeForVault } from "./scopes.ts";
import type { AuthResult } from "./auth.ts";
import {
  expandTokenTagScope,
  noteWithinTagScope,
  tagsWithinScope,
} from "./tag-scope.ts";
import { findTokensReferencingTag } from "./token-store.ts";

/**
 * Filter a vault projection to entries an in-scope tag contributes to.
 *
 * Mirrors the JSON `vault-info` wrapper exactly so the connect-time
 * markdown brief and the JSON tool surface identical scope shapes:
 *
 *   - `tags` array → drop entries whose name isn't in `allowed`.
 *   - `indexed_fields` array → for each entry, intersect `tags` (the
 *     declarer list) with `allowed`. Drop the entry entirely when no
 *     declarer survives.
 *
 * Aggregate stats and the static `query_hints` catalog pass through
 * unchanged — counts are aggregate (already pre-#271 behavior) and hints
 * are pure documentation.
 */
function filterProjectionByScope(
  projection: VaultProjection,
  allowed: Set<string>,
): VaultProjection {
  return {
    ...projection,
    tags: projection.tags.filter((t) => allowed.has(t.name)),
    indexed_fields: projection.indexed_fields
      .map((f) => ({ ...f, tags: f.tags.filter((t) => allowed.has(t)) }))
      .filter((f) => f.tags.length > 0),
  };
}

/**
 * Get the MCP server instruction for a vault.
 *
 * Sent once at session init via the MCP `initialize` response — not per
 * tool. The body is a markdown brief composed from the same vault projection
 * `vault-info` returns, so an agent has everything it needs to orient
 * itself before issuing a single query. Stats are included so the count
 * line ("N notes, M tags") is always populated.
 *
 * When `auth` carries `scoped_tags`, the projection is filtered to those
 * tags + descendants before rendering — symmetric with the JSON
 * `vault-info` wrapper, so a tag-scoped token never learns about
 * out-of-scope tags via the connect-time brief either. Aggregate counts
 * pass through unchanged (they were pre-existing leak surface; not new).
 *
 * Async because expanding the tag-scope allowlist hits the store's
 * hierarchy resolver. Returns the orientation block even when the vault
 * has no description or schemas — empty vaults still get the query-hint
 * catalog and refresh pointers.
 */
export async function getServerInstruction(
  vaultName: string,
  auth?: AuthResult,
): Promise<string> {
  const config = readVaultConfig(vaultName);
  const store = getVaultStore(vaultName);
  let projection = buildVaultProjection(store.db, { includeStats: true });

  if (auth?.scoped_tags && auth.scoped_tags.length > 0) {
    const allowed = await expandTokenTagScope(store, auth.scoped_tags);
    if (allowed) projection = filterProjectionByScope(projection, allowed);
  }

  return projectionToMarkdown({
    vaultName,
    description: config?.description ?? null,
    projection,
  });
}

/**
 * Generate MCP tools scoped to a single vault.
 *
 * `auth` is the resolved token for the caller and is captured by vault-info's
 * execute closure so the description-update branch can perform a secondary
 * scope check: the tool itself is gated at vault:read (so read-only callers
 * can fetch stats), but writing a new description requires vault:write.
 *
 * When omitted (internal callers that only inspect the tool list — no execute
 * path exercised), the description-update branch is disabled entirely.
 */
export function generateScopedMcpTools(vaultName: string, auth?: AuthResult): McpToolDef[] {
  const store = getVaultStore(vaultName);
  const tools = generateMcpTools(store);

  overrideVaultInfo(tools, vaultName, auth);
  applyTagDependencyGuards(tools, vaultName);
  applyTagScopeWrappers(tools, vaultName, auth);

  return tools;
}

/**
 * Tag-delete and (future) tag-merge always check for tag-scoped tokens
 * referencing the doomed tag — regardless of whether the *deleter* is
 * itself tag-scoped. A successful delete that orphans an allowlist would
 * silently widen surface area downstream. Mirrors the REST 409
 * `tag_in_use_by_tokens` envelope.
 */
function applyTagDependencyGuards(tools: McpToolDef[], vaultName: string): void {
  const store = getVaultStore(vaultName);
  wrapReadTool(tools, "delete-tag", async (orig, params) => {
    const tag = (params as any).tag ?? (params as any).name;
    if (typeof tag === "string") {
      const referenced_by = findTokensReferencingTag(store.db, tag);
      if (referenced_by.length > 0) {
        return {
          error: "TagInUseByTokens",
          error_type: "tag_in_use_by_tokens",
          message: `Tag "${tag}" is referenced by ${referenced_by.length} tag-scoped token(s); revoke or re-mint them before deleting.`,
          tag,
          referenced_by,
        };
      }
    }
    return await orig(params);
  });
}

/**
 * Wrap read-tool execute() functions to filter results down to what the
 * token's `scoped_tags` allowlist permits. No-op when the token is
 * unscoped — the wrappers fast-path on `auth.scoped_tags === null` so
 * unscoped sessions retain identical pre-tag-scope behavior.
 *
 * Read tools handled here:
 *   - query-notes: filter single-note returns + result lists
 *   - list-tags:   filter to allowlisted tags + descendants
 *   - find-path:   require both endpoints (and every hop) in scope
 *   - vault-info:  filter projection.tags + projection.indexed_fields
 *                  to entries an in-scope tag contributes to
 *
 * Write-tool gating happens in handleScopedMcp at the verb-scope layer
 * AND inside each tool's wrapper here (so a tag-scoped `vault:write`
 * token can't write outside its allowlist). See applyTagScopeWriteGuards.
 */
function applyTagScopeWrappers(
  tools: McpToolDef[],
  vaultName: string,
  auth: AuthResult | undefined,
): void {
  if (!auth || !auth.scoped_tags || auth.scoped_tags.length === 0) return;
  const store = getVaultStore(vaultName);
  // Lazy: only build the expanded allowlist on first tool call.
  let allowedPromise: Promise<Set<string> | null> | null = null;
  const getAllowed = (): Promise<Set<string> | null> => {
    if (!allowedPromise) {
      allowedPromise = expandTokenTagScope(store, auth.scoped_tags);
    }
    return allowedPromise;
  };
  const rawTags = auth.scoped_tags;

  wrapReadTool(tools, "query-notes", async (orig, params) => {
    const allowed = await getAllowed();
    const result = await orig(params);
    if (!allowed) return result;
    // Single-note shape (`{...note}` with `id`) vs list shape (array).
    if (Array.isArray(result)) {
      return result.filter((n: any) => noteWithinTagScope(n, allowed, rawTags));
    }
    if (result && typeof result === "object" && "id" in result && "tags" in result) {
      return noteWithinTagScope(result as any, allowed, rawTags)
        ? result
        : { error: "Note not found", id: (result as any).id };
    }
    return result;
  });

  wrapReadTool(tools, "list-tags", async (orig, params) => {
    const allowed = await getAllowed();
    const result = await orig(params);
    if (!allowed || !Array.isArray(result)) return result;
    return result.filter((t: any) => allowed.has(t.name));
  });

  wrapReadTool(tools, "find-path", async (orig, params) => {
    const allowed = await getAllowed();
    const result = await orig(params);
    if (!allowed || !result || typeof result !== "object" || !("path" in result)) return result;
    const ids = (result as any).path as string[];
    for (const id of ids) {
      const note = await store.getNote(id);
      if (!note || !noteWithinTagScope(note, allowed, rawTags)) {
        return null;
      }
    }
    return result;
  });

  // vault-info projection (#271): filter the tags catalog to in-scope tags
  // and the indexed_fields catalog to fields with at least one in-scope
  // declarer. Within each surviving indexed_fields entry, also drop
  // out-of-scope declarer names from the `tags` array — a token scoped to
  // `task` shouldn't learn that `project` declares `status` too. Other
  // top-level keys (name, description, query_hints, stats) pass through:
  // counts are aggregate and existing pre-#271 behavior already returned
  // them to scoped tokens. The same `filterProjectionByScope` helper backs
  // `getServerInstruction` so the JSON tool and the connect-time markdown
  // brief stay in lockstep.
  wrapReadTool(tools, "vault-info", async (orig, params) => {
    const allowed = await getAllowed();
    const result = await orig(params);
    if (!allowed || !result || typeof result !== "object") return result;
    const r = result as Record<string, unknown> & Partial<VaultProjection>;
    const partial: VaultProjection = {
      tags: Array.isArray(r.tags) ? r.tags : [],
      indexed_fields: Array.isArray(r.indexed_fields) ? r.indexed_fields : [],
      query_hints: Array.isArray(r.query_hints) ? r.query_hints : [],
    };
    const filtered = filterProjectionByScope(partial, allowed);
    r.tags = filtered.tags;
    r.indexed_fields = filtered.indexed_fields;
    return r;
  });

  // ---- Write-side guards ----
  //
  // The verb-scope check (`vault:write`) is enforced at the dispatch layer
  // in handleScopedMcp. These wrappers add the second axis: a scoped
  // `vault:write` token can only mutate within its tag-allowlist, never
  // outside it. Tag operations (`update-tag`, `delete-tag`) gate on the
  // tag name itself; note operations gate on the prospective tag set.

  const forbidden = (msg: string): unknown => ({
    error: "Forbidden",
    error_type: "tag_scope_violation",
    message: `${msg} (token tag-allowlist: ${rawTags.join(", ")})`,
    scoped_tags: rawTags,
  });

  wrapReadTool(tools, "create-note", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    // Single or batch shape: `{notes: [...]}` is the batch form (mirrors HTTP).
    const items = Array.isArray((params as any).notes)
      ? (params as any).notes
      : [params];
    for (const item of items) {
      const itemTags = Array.isArray((item as any).tags) ? ((item as any).tags as string[]) : [];
      if (!tagsWithinScope(itemTags, allowed, rawTags)) {
        return forbidden("create-note: every note must carry at least one tag in the token's allowlist");
      }
    }
    return await orig(params);
  });

  wrapReadTool(tools, "update-note", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    const items = Array.isArray((params as any).notes)
      ? (params as any).notes
      : [params];
    for (const item of items) {
      const id = (item as any).id ?? (item as any).note_id;
      if (!id) continue;
      const existing = await store.getNote(id as string);
      if (!existing || !noteWithinTagScope(existing, allowed, rawTags)) {
        return { error: "Note not found", id };
      }
      const removed = new Set<string>((item as any).tags?.remove ?? []);
      const projected = new Set<string>((existing.tags ?? []).filter((t) => !removed.has(t)));
      for (const t of ((item as any).tags?.add ?? []) as string[]) projected.add(t);
      if (!tagsWithinScope([...projected], allowed, rawTags)) {
        return forbidden("update-note: post-update tag set must satisfy the token's allowlist");
      }
    }
    return await orig(params);
  });

  wrapReadTool(tools, "delete-note", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    const id = (params as any).id ?? (params as any).note_id;
    if (id) {
      const existing = await store.getNote(id as string);
      if (!existing || !noteWithinTagScope(existing, allowed, rawTags)) {
        return { error: "Note not found", id };
      }
    }
    return await orig(params);
  });

  wrapReadTool(tools, "update-tag", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    const tag = (params as any).tag ?? (params as any).name;
    if (typeof tag === "string" && !allowed.has(tag)) {
      return forbidden(`update-tag: tag "${tag}" is outside the token's allowlist`);
    }
    return await orig(params);
  });

  wrapReadTool(tools, "delete-tag", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    const tag = (params as any).tag ?? (params as any).name;
    if (typeof tag === "string" && !allowed.has(tag)) {
      return forbidden(`delete-tag: tag "${tag}" is outside the token's allowlist`);
    }
    return await orig(params);
  });

}

function wrapReadTool(
  tools: McpToolDef[],
  name: string,
  wrapper: (orig: (params: Record<string, unknown>) => Promise<unknown>, params: Record<string, unknown>) => Promise<unknown>,
): void {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return;
  // McpToolDef.execute returns `unknown | Promise<unknown>` (sync OR async).
  // Adapt to the wrapper's strictly-async signature so wrappers can `await
  // orig(params)` uniformly without re-checking each tool.
  const orig = tool.execute;
  const origAsync = (params: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve(orig(params));
  tool.execute = (params) => wrapper(origAsync, params);
}

function overrideVaultInfo(
  tools: McpToolDef[],
  vaultName: string,
  auth: AuthResult | undefined,
): void {
  const vaultInfo = tools.find((t) => t.name === "vault-info");
  if (!vaultInfo) return;

  vaultInfo.execute = async (params) => {
    const config = readVaultConfig(vaultName);
    if (!config) throw new Error(`Vault "${vaultName}" not found`);

    if (params.description !== undefined) {
      // Secondary scope check: vault-info is read-gated so read-only callers
      // can fetch stats, but mutating the vault description requires write
      // for THIS vault. Without this, a vault:read token could bypass the
      // outer gate by passing `description` to a tool the outer gate
      // considers read-only.
      if (!auth || !hasScopeForVault(auth.scopes, vaultName, "write")) {
        throw new Error(
          `Forbidden: updating the vault description requires the 'vault:write' scope (or 'vault:${vaultName}:write'). Granted scopes: ${auth?.scopes.join(" ") || "(none)"}.`,
        );
      }
      config.description = params.description as string;
      writeVaultConfig(config);
    }

    const store = getVaultStore(vaultName);
    const includeStats = Boolean(params.include_stats);
    const projection = buildVaultProjection(store.db, { includeStats });

    const result: Record<string, unknown> = {
      name: config.name,
      description: config.description ?? null,
      tags: projection.tags,
      indexed_fields: projection.indexed_fields,
      query_hints: projection.query_hints,
    };

    if (projection.stats) {
      result.stats = projection.stats;
    }

    return result;
  };
}
