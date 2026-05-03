/**
 * MCP tool generation for the scoped (per-vault) MCP endpoint.
 *
 * Every MCP session is now bound to one vault via `/vault/<name>/mcp`, so
 * tools operate on that vault and vault-info picks up its config directly.
 */

import { generateMcpTools } from "../core/src/mcp.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
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
 * Get the MCP server instruction for a vault.
 * Sent once at session init — not per tool.
 */
export function getServerInstruction(vaultName: string): string {
  const config = readVaultConfig(vaultName);

  const parts: string[] = [
    `You are connected to Parachute Vault "${vaultName}".`,
  ];

  if (config?.description) {
    parts.push("", config.description);
  }

  return parts.join("\n");
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
 *   - query-notes:      filter single-note returns + result lists
 *   - list-tags:        filter to allowlisted tags + descendants
 *   - find-path:        require both endpoints (and every hop) in scope
 *   - synthesize-notes: anchor + neighbors all gated by scope
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

  wrapReadTool(tools, "synthesize-notes", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    // Verify the anchor is in scope first — out-of-scope anchor 404s as if
    // the note doesn't exist, mirroring the REST find-path semantics.
    const anchorId = (params as any).id ?? (params as any).note_id;
    if (anchorId) {
      const anchor = await store.getNote(anchorId as string);
      if (!anchor || !noteWithinTagScope(anchor, allowed, rawTags)) {
        return { error: "Note not found", id: anchorId };
      }
    }
    const result = await orig(params);
    // Filter neighbors to those in scope. The synthesize-notes shape exposes
    // `neighbors` (array of note objects with tags) — mirror the query-notes
    // filter pattern here.
    if (result && typeof result === "object" && Array.isArray((result as any).neighbors)) {
      (result as any).neighbors = (result as any).neighbors.filter((n: any) =>
        noteWithinTagScope(n, allowed, rawTags),
      );
    }
    return result;
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

    const result: any = {
      name: config.name,
      description: config.description ?? null,
    };

    if (params.include_stats) {
      const store = getVaultStore(vaultName);
      result.stats = await store.getVaultStats();
    }

    return result;
  };
}
