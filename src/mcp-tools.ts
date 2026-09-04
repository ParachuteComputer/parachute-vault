/**
 * MCP tool generation for the scoped (per-vault) MCP endpoint.
 *
 * Every MCP session is now bound to one vault via `/vault/<name>/mcp`, so
 * tools operate on that vault and vault-info picks up its config directly.
 */

import { generateMcpTools } from "../core/src/mcp.ts";
import type { McpToolDef, GenerateMcpToolsOpts } from "../core/src/mcp.ts";
import { getNoteTags, getVaultMap } from "../core/src/notes.ts";
import type { Note } from "../core/src/types.ts";
import {
  buildVaultProjection,
  projectionToMarkdown,
  type VaultProjection,
} from "../core/src/vault-projection.ts";
import { readVaultConfig, writeVaultConfig } from "./config.ts";
import { getVaultStore } from "./vault-store.ts";
import { hasScopeForVault, hasMigrateScopeForVault, parseScopes, validateMintedScopes, logStrictBypass } from "./scopes.ts";
import type { AuthResult } from "./auth.ts";
import { refineMcpVia } from "./auth.ts";
import {
  expandTokenTagScope,
  filterHydratedLinksByTagScope,
  noteWithinTagScope,
  scopeQueryTagParam,
  scrubIndexedFieldConflictError,
  scrubNoteTagsByScope,
  scrubParentCycleError,
  scrubReferencingTagsByScope,
  scrubTagFieldViolationsByScope,
  scrubValidationStatusByScope,
  tagsWithinScope,
  tagVisibleInScope,
} from "./tag-scope.ts";
import { TagFieldConflictError, ParentCycleError } from "../core/src/tag-schemas.ts";
import { IndexedFieldError } from "../core/src/indexed-fields.ts";
import { runDoctorScan } from "../core/src/doctor.ts";
import {
  findTokensReferencingTag,
  recordMcpMintLedger,
  listMcpMintedHubJwts,
  findMcpMintLedgerEntry,
  markMcpMintLedgerRevoked,
} from "./token-store.ts";
import { chooseHubOrigin, mintHubJwt, revokeHubJwt } from "./mcp-install.ts";
import { looksLikeJwt } from "./hub-jwt.ts";
import { readGlobalConfig, DEFAULT_PORT } from "./config.ts";
import { getBaseUrl } from "./oauth-discovery.ts";
import { getSharedAttachmentTicketProvider } from "./attachment-tickets.ts";
import { createFsAttachmentBytesProvider } from "./attachment-bytes.ts";

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
    coordinates: resolveVaultCoordinates(),
    // Bun always wires an in-process AttachmentTicketProvider AND a fresh
    // fs-backed AttachmentBytesProvider per session (see
    // `generateScopedMcpTools` below) — the connect-time brief can
    // unconditionally teach both the ticket tools and read-attachment on
    // this door.
    attachments: { ticketsEnabled: true, readEnabled: true },
  });
}

/**
 * Resolve this vault's own public coordinates for the projection. The vault
 * always knows its NAME; its hub origin comes from `resolveHubOrigin()`
 * (PARACHUTE_HUB_ORIGIN → expose-state FQDN → loopback). A loopback source
 * means no public origin is configured — flagged via `hubOriginKnown: false`
 * so the projection renders relative path templates rather than a loopback URL
 * a remote surface-builder can't use.
 */
function resolveVaultCoordinates(): { hubOrigin: string; hubOriginKnown: boolean } {
  const { url, source } = resolveHubOrigin();
  return { hubOrigin: url, hubOriginKnown: source !== "loopback" };
}

/**
 * Generate MCP tools scoped to a single vault.
 *
 * `auth` is the resolved token for the caller and is captured by vault-info's
 * execute closure so the description-update branch can perform a secondary
 * scope check: the tool itself is gated at vault:read (so read-only callers
 * can fetch stats), but writing a new description requires vault:admin
 * (tightened from vault:write by the write/admin re-tier — description is
 * vault curation, not content).
 *
 * When omitted (internal callers that only inspect the tool list — no execute
 * path exercised), the description-update branch is disabled entirely.
 */
export function generateScopedMcpTools(
  vaultName: string,
  auth?: AuthResult,
  callerBearer?: string | null,
  /**
   * The incoming MCP request, when available (omitted by the many
   * test-only call sites that construct tools without a live request).
   * Threaded through ONLY so the attachment-ticket tools can resolve a
   * request-accurate `urlBase` (honoring `X-Forwarded-Host`/proto, same as
   * `getBaseUrl`) — falls back to `resolveVaultCoordinates()`'s configured/
   * expose-state origin when omitted, so ticket tools are still present
   * (just less precisely origined) in that case.
   */
  req?: Request,
): McpToolDef[] {
  const store = getVaultStore(vaultName);

  // Tag-scope confidentiality (security review): when the session is
  // tag-scoped, build an expand-visibility predicate so `query-notes`'s
  // `expand_links` inlining can't embed out-of-scope note content. The
  // predicate reads from a SHARED holder that `applyTagScopeWrappers`
  // populates with the resolved allowlist before core's execute runs the
  // (synchronous) expansion — so by the time core calls `isVisible(note)`
  // the allowlist is ready. Core stays scope-unaware: it only receives the
  // plain closure. Unscoped sessions pass no predicate (unchanged path).
  const scoped = Boolean(auth?.scoped_tags && auth.scoped_tags.length > 0);
  const allowedHolder: { value: Set<string> | null } = { value: null };
  const rawTags = scoped ? auth!.scoped_tags : null;
  const expandVisibility = scoped
    ? (note: Note) => noteWithinTagScope(note, allowedHolder.value, rawTags)
    : undefined;

  // Tag-scope for `query-notes`'s `aggregate` mode (top new-feature ask
  // from a UX round): a rollup has no per-note shape to post-filter (the
  // response is `[{group, value}]`, not notes), so scope has to be applied
  // BEFORE core aggregates, not after. Same shared `allowedHolder` /
  // `getAllowed()`-before-`orig()` ordering invariant as `expandVisibility`
  // above — reads the resolved allowlist safely because the query-notes
  // wrapper always awaits `getAllowed()` before invoking core's (synchronous
  // use of this) execute. Unscoped sessions install no predicate → the
  // aggregate runs core's fast direct-SQL path.
  const aggregateVisibility = scoped
    ? (note: Note) => noteWithinTagScope(note, allowedHolder.value, rawTags)
    : undefined;

  // Tag-scope hop-guard for `near[]` (vault#439): a per-note predicate the
  // core BFS consults so it refuses to traverse THROUGH out-of-scope notes —
  // symmetric with find-path. Reads from the SAME shared `allowedHolder` the
  // result-filter populates; the query-notes wrapper `await getAllowed()`s
  // (which fills the holder) before core's execute runs the BFS, so the
  // allowlist is ready by the time this fires. Looks up each candidate note's
  // tags by id (sync, core-native). Unscoped sessions install no predicate.
  const nearTraversable = scoped
    ? (noteId: string) =>
        noteWithinTagScope(
          { id: noteId, tags: getNoteTags(store.db, noteId) } as Note,
          allowedHolder.value,
          rawTags,
        )
    : undefined;

  // Tag-scope guard for the ambiguous-links surface (vault#581 auth review):
  // `candidate_count` is derived vault-wide, so without this a `work`-scoped
  // reader learns from `candidate_count: 2` on its own `[[Dup]]` that a
  // second `Dup` exists in a scope it cannot see — and `has_ambiguous_links:
  // true` turns that into a standing, sweepable census of cross-scope naming
  // collisions. Identical closure/shape to `nearTraversable` above (by note
  // id, tags looked up sync + core-native); core narrows each row's
  // candidates through it. Unscoped sessions install no predicate, so the
  // persisted counts and the SQL filter answer directly, unchanged.
  const ambiguityVisible = scoped
    ? (noteId: string) =>
        noteWithinTagScope(
          { id: noteId, tags: getNoteTags(store.db, noteId) } as Note,
          allowedHolder.value,
          rawTags,
        )
    : undefined;

  // Tag-scope guard for `create-note` `if_exists` (vault#555 auth-review
  // must-fix): the core `if_exists` upsert resolves the target path VAULT-WIDE
  // and returns/updates/replaces the found note, so a scoped caller could
  // read/overwrite an out-of-scope note by naming its path. Inject a
  // visibility predicate the core `applyExistingNote` consults on the RESOLVED
  // existing note — covering BOTH the proactive check AND the concurrent-INSERT
  // race backstop (a wrapper-only pre-check misses the latter). Reads from the
  // SAME shared `allowedHolder` the create-note wrapper's `getAllowed()`
  // populates before core's execute runs. Unscoped sessions install no
  // predicate (unchanged). Same closure as `expandVisibility`.
  const ifExistsVisible = scoped
    ? (note: Note) => noteWithinTagScope(note, allowedHolder.value, rawTags)
    : undefined;

  // Write-attribution (vault#298). Every write through an MCP session arrives
  // on the `mcp` channel — so we REFINE the auth's base `via` (the generic
  // credential class) to `mcp` here, where the path/channel is known. `actor`
  // (the principal) passes through unchanged.
  //
  // Two classes are kept INSTEAD of `mcp`, because each is strictly more
  // informative than the channel:
  //   - `operator` — the env-var bearer's credential class IS its channel, and
  //     it names cross-container hub→vault writes (vault#298).
  //   - `nostr:<pubkey>` — the NIP-98 signer (vault#698). Every agent coming
  //     through the hub's `/mcp` door arrives on the `mcp` channel, so `mcp`
  //     cannot tell two agents apart; the signing key can. `created_by` is
  //     still the shared hub user, so this is the ONLY attribution axis that
  //     distinguishes them — flattening it here would reintroduce the bug.
  const writeContext = auth ? { actor: auth.actor, via: refineMcpVia(auth.via) } : undefined;

  // Migration-bypass (vault#299): a `vault:migrate`-scoped MCP session skips
  // strict-schema enforcement and logs every bypassed write. Orthogonal to
  // read/write/admin — an admin token does NOT bypass unless it also holds
  // `migrate`. `onStrictBypass` writes the same structured log line the REST
  // path uses (the audit-log table, #300, is deferred).
  const strictBypass = auth ? hasMigrateScopeForVault(auth.scopes, vaultName) : false;
  const onStrictBypass: GenerateMcpToolsOpts["onStrictBypass"] = strictBypass
    ? (info) => logStrictBypass(info)
    : undefined;

  // Attachment tickets (Wave 1): bun always wires the in-process provider
  // (see src/attachment-tickets.ts) — unlike the tag-scope predicates
  // above, this isn't conditional on `scoped` because the tools should be
  // listed for every session, scoped or not. Tag-scope confidentiality is
  // still enforced (`noteVisible`, awaited inline inside the ticket tools'
  // own async execute — see its doc comment in generateMcpTools for why
  // this doesn't need the shared allowedHolder machinery the OTHER
  // predicates above do).
  const ticketNoteVisible = scoped
    ? async (note: Note) => {
        const allowed = await expandTokenTagScope(store, rawTags);
        return noteWithinTagScope(note, allowed, rawTags);
      }
    : undefined;
  const ticketUrlBase = req
    ? `${getBaseUrl(req).replace(/\/$/, "")}/vault/${vaultName}`
    : `${resolveVaultCoordinates().hubOrigin.replace(/\/$/, "")}/vault/${vaultName}`;

  const tools = generateMcpTools(store, {
    ...(expandVisibility ? { expandVisibility } : {}),
    ...(nearTraversable ? { nearTraversable } : {}),
    ...(ifExistsVisible ? { ifExistsVisible } : {}),
    ...(aggregateVisibility ? { aggregateVisibility } : {}),
    ...(ambiguityVisible ? { ambiguityVisible } : {}),
    ...(writeContext ? { writeContext } : {}),
    ...(strictBypass ? { strictBypass } : {}),
    ...(onStrictBypass ? { onStrictBypass } : {}),
    attachmentTickets: {
      provider: getSharedAttachmentTicketProvider(),
      vaultName,
      urlBase: ticketUrlBase,
      ...(ticketNoteVisible ? { noteVisible: ticketNoteVisible } : {}),
    },
    // Attachment bytes (Wave 2 model lane): bun always wires a fresh fs
    // provider per session — cheap (stateless), unlike the ticket
    // provider's process-wide shared Map. Same `ticketNoteVisible`
    // tag-scope predicate as the ticket seam above (identical contract:
    // "is the owning note in scope").
    attachmentBytes: {
      provider: createFsAttachmentBytesProvider(vaultName),
      ...(ticketNoteVisible ? { noteVisible: ticketNoteVisible } : {}),
    },
  });

  overrideVaultInfo(tools, vaultName, auth);
  applyTagDependencyGuards(tools, vaultName);
  applyTagScopeWrappers(tools, vaultName, auth, allowedHolder);

  // manage-token is server-only (needs token-store + auth context), so it
  // lives here rather than in core. Always appended to the surface; the
  // `requiredVerb: "admin"` filter in mcp-http.ts hides it from non-admin
  // callers. See vault#376. The raw caller bearer (vault#403, MGT) is
  // forwarded to hub's mint-token attenuation proxy on mint.
  tools.push(buildManageTokenTool(vaultName, auth, callerBearer ?? null));

  return tools;
}

/**
 * Tag-delete and tag-merge always check for tag-scoped tokens referencing
 * the doomed tag(s) — regardless of whether the CALLER is itself
 * tag-scoped. A successful delete/merge that orphans an allowlist would
 * silently widen surface area downstream. Mirrors the REST 409
 * `tag_in_use_by_tokens` envelope (routes.ts's DELETE /tags/:name and
 * POST /tags/merge run the identical check).
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
  // vault#552: merging consumes every source tag (same identity-drop as
  // delete), so a source referenced by a tag-scoped token would orphan that
  // token's allowlist exactly like a bare delete would. Aggregate matches
  // across all sources into one 409-equivalent envelope, same shape REST's
  // POST /tags/merge returns.
  wrapReadTool(tools, "merge-tags", async (orig, params) => {
    const sources = Array.isArray((params as any).sources) ? ((params as any).sources as unknown[]) : [];
    const referenced: { source: string; tokens: { id: string; label: string }[] }[] = [];
    for (const src of sources) {
      if (typeof src !== "string") continue;
      const tokens = findTokensReferencingTag(store.db, src);
      if (tokens.length > 0) referenced.push({ source: src, tokens });
    }
    if (referenced.length > 0) {
      return {
        error: "TagInUseByTokens",
        error_type: "tag_in_use_by_tokens",
        message: `Cannot merge: ${referenced.length} source tag(s) referenced by tag-scoped token(s); revoke or re-mint them first.`,
        referenced_by: referenced,
      };
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
 * Mutating-tool gating happens in handleScopedMcp at the verb-scope layer
 * (`vault:write` for create/update/delete-note, `vault:admin` for the
 * tag-schema/taxonomy tools since the write/admin re-tier) AND inside each
 * tool's wrapper here, so a tag-scoped token — whatever verb it holds —
 * can't mutate outside its allowlist. See applyTagScopeWriteGuards.
 */
function applyTagScopeWrappers(
  tools: McpToolDef[],
  vaultName: string,
  auth: AuthResult | undefined,
  allowedHolder?: { value: Set<string> | null },
): void {
  if (!auth || !auth.scoped_tags || auth.scoped_tags.length === 0) return;
  const store = getVaultStore(vaultName);
  // Lazy: only build the expanded allowlist on first tool call.
  let allowedPromise: Promise<Set<string> | null> | null = null;
  const getAllowed = (): Promise<Set<string> | null> => {
    if (!allowedPromise) {
      allowedPromise = expandTokenTagScope(store, auth.scoped_tags).then((a) => {
        // Publish the resolved allowlist into the shared holder so the
        // expand-visibility predicate (wired in generateScopedMcpTools and
        // baked into the query-notes expand context) sees the same set.
        // The query-notes wrapper awaits getAllowed() before calling the
        // core execute that runs expansion, so the holder is populated in
        // time. Security review: closes the expand_links content leak.
        if (allowedHolder) allowedHolder.value = a;
        return a;
      });
    }
    return allowedPromise;
  };
  const rawTags = auth.scoped_tags;

  // Apply every scope scrub a returned note needs, in one place:
  //
  //  1. hydrated `links` (present when the caller set `include_links`) — drop
  //     out-of-scope NEIGHBOR summaries (id/path/tags) and scrub the
  //     surviving summaries' own `.tags`; symmetric with REST.
  //  2. `validation_status` (vault#555 auth review) — a note the caller can
  //     see may ALSO carry an out-of-scope co-tag whose schema would
  //     otherwise leak (field name / type / enum values, the #560 class).
  //  3. the note's OWN `.tags` array (vault#568) — being admitted via one
  //     in-scope tag must not disclose the NAMES of its out-of-scope
  //     co-tags. This is the same leak class as (2) through a plainer field.
  //
  // (1) and (2) mutate in place; (3) is non-mutating and may return a NEW
  // object, so callers must use the RETURN VALUE, never rely on the mutation.
  //
  // Ordering invariant: reading `allowedHolder.value` here is safe ONLY
  // because every wrapper that calls scrubNoteForScope first does
  // `await getAllowed()` (which populates the holder) before `orig(params)`
  // and before this scrub runs. So by the time we read `holder.value` it is
  // the resolved allowlist, never the initial `null`. The `?? null` fallback
  // is the unscoped/holder-absent path; `filterHydratedLinksByTagScope` then
  // keys off `rawTags` (non-null here) for the actual scope check.
  const scrubNoteForScope = (n: any): any => {
    if (n && Array.isArray(n.links)) {
      n.links = filterHydratedLinksByTagScope(n.links, allowedHolder?.value ?? null, rawTags);
    }
    if (n && n.validation_status) {
      const scrubbed = scrubValidationStatusByScope(n.validation_status, allowedHolder?.value ?? null, rawTags);
      if (scrubbed === undefined) delete n.validation_status;
      else n.validation_status = scrubbed;
    }
    return scrubNoteTagsByScope(n, allowedHolder?.value ?? null, rawTags);
  };

  /**
   * Shape dispatcher for the WRITE tools (vault#568). `create-note` and
   * `update-note` echo the stored note, so they leak exactly what the read
   * paths leak — and a no-op `update-note` would otherwise be a one-call
   * bypass of the read-path scrub. Their result is a single note, a `notes`
   * array (batch), or a `{created, ids, failed}` batch summary (no note
   * bodies → nothing to scrub). Errors (`{error, error_type}`) pass through.
   */
  const scrubWriteResult = (result: any): any => {
    if (!result || typeof result !== "object") return result;
    if (Array.isArray(result)) return result.map(scrubNoteForScope);
    if ("error" in result) return result;
    if (Array.isArray((result as any).notes)) {
      return { ...result, notes: (result as any).notes.map(scrubNoteForScope) };
    }
    if ("id" in result && "tags" in result) return scrubNoteForScope(result);
    return result;
  };

  /**
   * Neutralise out-of-scope tags NAMED IN THE QUERY (vault#675) before core
   * ever runs. Without this a scoped session could ask `query-notes { tag:
   * "project-manhattan" }` and read the answer off hit/miss — a co-tagged
   * note is in scope via its OTHER tag, so it survived the result filter
   * below and confirmed the guessed name. Rewriting the input (rather than
   * emptying the output) keeps the response byte-identical to the same call
   * naming a tag that doesn't exist, in every shape this tool returns —
   * including the `aggregate` rollup and the `next_cursor` envelope, which
   * an output-side patch could not reproduce. `exclude_tags` is rewritten on
   * the same terms (core skips an exclude clause that can't match, so it
   * excludes nothing — again exactly a nonexistent tag). Aliases mirror
   * core's `exclude_tags ?? excludeTags ?? exclude_tag` resolution order.
   */
  const QUERY_TAG_PARAMS = ["tag", "exclude_tags", "excludeTags", "exclude_tag"] as const;
  const scopeQueryTagParams = (params: any, allowed: Set<string> | null): any => {
    if (!params || typeof params !== "object") return params;
    let next = params;
    for (const key of QUERY_TAG_PARAMS) {
      if (params[key] === undefined) continue;
      const scoped = scopeQueryTagParam(params[key], allowed, rawTags);
      if (scoped === params[key]) continue;
      if (next === params) next = { ...params };
      next[key] = scoped;
    }
    return next;
  };

  wrapReadTool(tools, "query-notes", async (orig, params) => {
    const allowed = await getAllowed();
    const result = await orig(scopeQueryTagParams(params, allowed));
    if (!allowed) return result;
    // `aggregate` mode returns `[{group, value}]` rollup rows — no `.tags`
    // to post-filter (and `noteWithinTagScope` would wrongly drop every
    // row, since an absent `.tags` reads as "out of scope"). WHICH NOTES
    // count was already narrowed INSIDE core via the `aggregateVisibility`
    // predicate (see `generateScopedMcpTools`): fetch the full filtered
    // set, keep only allowlisted notes, THEN aggregate.
    //
    // That note-level narrowing is NOT sufficient on its own under
    // `group_by: "tag"`, though: a note can be in scope via one tag while
    // ALSO carrying an out-of-scope co-tag (the same class of leak
    // `scrubValidationStatusByScope` closes for `validation_status`), and a
    // tag rollup's `group` values ARE tag names — the co-tag would surface
    // directly as a group. Scrub group NAMES here, the same way every other
    // tag-shaped output on this wrapper is scrubbed.
    if ((params as any).aggregate) {
      const groupBy = (params as any).aggregate?.group_by;
      if (groupBy === "tag" && Array.isArray(result)) {
        return result.filter(
          (r: any) => typeof r?.group === "string" && tagVisibleInScope(r.group, allowed, rawTags),
        );
      }
      return result;
    }
    // Possible response shapes (vault#550 added the `warnings` variants):
    //   - Array (legacy list, no cursor, no warnings)
    //   - `{notes, next_cursor}` (cursor mode, vault#313)
    //   - `{notes, warnings}` (warnings present, not in cursor mode)
    //   - `{notes, next_cursor, warnings}` (both)
    //   - `{...note}` with `id`+`tags` (single-note by id)
    if (Array.isArray(result)) {
      return result
        .filter((n: any) => noteWithinTagScope(n, allowed, rawTags))
        .map(scrubNoteForScope);
    }
    if (
      result &&
      typeof result === "object" &&
      "notes" in result &&
      Array.isArray((result as any).notes)
    ) {
      const r = result as { notes: any[]; next_cursor?: string | null; warnings?: unknown };
      return {
        notes: r.notes
          .filter((n: any) => noteWithinTagScope(n, allowed, rawTags))
          .map(scrubNoteForScope),
        ...("next_cursor" in r ? { next_cursor: r.next_cursor } : {}),
        // `warnings` intentionally DROPPED for a tag-scoped session: core's
        // `collectUnknownTagWarnings` (core/src/query-warnings.ts) resolves
        // `did_you_mean` against the FULL vault-wide tag catalog, which
        // would leak an out-of-scope tag's existence/name to a token that
        // can't otherwise see it — the same "no leak across the scope
        // boundary" stance this file takes everywhere else (see
        // docs/contracts/tag-scoped-tokens.md). Unscoped sessions keep
        // `warnings` untouched via the `!allowed` early return above.
      };
    }
    if (result && typeof result === "object" && "id" in result && "tags" in result) {
      return noteWithinTagScope(result as any, allowed, rawTags)
        ? scrubNoteForScope(result)
        : { error: "Note not found", error_type: "not_found", id: (result as any).id };
    }
    return result;
  });

  wrapReadTool(tools, "list-tags", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    // Single-tag detail (`{tag}` param) — the non-array shape the old
    // wrapper silently passed through, which leaked BOTH the full record of
    // an existing out-of-scope tag (vault#560) AND, post-#550, a vault-wide
    // `did_you_mean` suggestion for a nonexistent one. This wrapper is the
    // enforcement layer for tag scope on this tool; core's list-tags stays
    // scope-unaware by architecture (same division as every other wrapper
    // in this file).
    const singleTag = typeof (params as any).tag === "string" ? ((params as any).tag as string) : null;
    if (singleTag !== null && !allowed.has(singleTag)) {
      // Out-of-scope name — whether the tag exists or not. Same
      // "tag_not_found, no leak" shape as the REST handlers' early-return,
      // and deliberately NO did_you_mean (any suggestion would be computed
      // vault-wide). Short-circuits BEFORE core runs, so the full record /
      // suggestion is never even computed.
      return { error: "Tag not found", error_type: "tag_not_found", tag: singleTag };
    }
    const result = await orig(params);
    if (Array.isArray(result)) {
      return result.filter((t: any) => allowed.has(t.name));
    }
    // In-scope single-tag miss (nonexistent but allowlisted name): core's
    // tag_not_found may carry a vault-wide `did_you_mean` — keep it only
    // when the suggestion itself is inside the allowlist.
    if (
      result &&
      typeof result === "object" &&
      (result as any).error_type === "tag_not_found" &&
      typeof (result as any).did_you_mean === "string" &&
      !allowed.has((result as any).did_you_mean)
    ) {
      const { did_you_mean: _dropped, ...scrubbed } = result as Record<string, unknown>;
      return scrubbed;
    }
    return result;
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
      // Unused by filterProjectionByScope (map is handled separately below,
      // via a live recompute) — a placeholder to satisfy VaultProjection's
      // shape.
      map: { total_notes: 0, tags: [], path_buckets: [], unfiled_notes: 0 },
    };
    const filtered = filterProjectionByScope(partial, allowed);
    r.tags = filtered.tags;
    r.indexed_fields = filtered.indexed_fields;
    // `map` (front-door structural rollup): post-hoc filtering the unscoped
    // aggregate isn't possible for path-bucket counts (they need per-note
    // tag membership, not just a tag-name allowlist over a precomputed
    // rollup) — so re-run the cheap grouped-count query restricted to the
    // resolved allowlist instead of filtering `orig`'s unscoped result.
    if (r.map) {
      r.map = getVaultMap(store.db, { tagFilter: [...allowed] });
    }
    return r;
  });

  // ---- Write-side guards ----
  //
  // The verb-scope check (`vault:write` for note ops, `vault:admin` for the
  // tag-schema/taxonomy ops post-re-tier) is enforced at the dispatch layer
  // in handleScopedMcp. These wrappers add the second axis: a scoped token
  // can only mutate within its tag-allowlist, never outside it. Tag
  // operations (`update-tag`, `delete-tag`, `rename-tag`, `merge-tags`) gate
  // on the tag name(s) themselves; note operations gate on the prospective
  // tag set.

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
    // `if_exists` scope enforcement (vault#555 auth-review must-fix) is NOT
    // done here as a wrapper pre-check — that would miss core's concurrent-
    // INSERT race backstop. Instead the `ifExistsVisible` predicate wired into
    // generateMcpTools above fires INSIDE core's `applyExistingNote`, covering
    // both the proactive site and the race-backstop site with one guard. The
    // `await getAllowed()` at the top of this wrapper populates the shared
    // `allowedHolder` the predicate reads, before core's execute runs.
    // vault#568 — scrub the echoed note(s): under `if_exists: ignore|update|
    // replace` the response is a PRE-EXISTING note whose co-tags this caller
    // never supplied and must not learn.
    return scrubWriteResult(await orig(params));
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
        return { error: "Note not found", error_type: "not_found", id };
      }
      const removed = new Set<string>((item as any).tags?.remove ?? []);
      const projected = new Set<string>((existing.tags ?? []).filter((t) => !removed.has(t)));
      for (const t of ((item as any).tags?.add ?? []) as string[]) projected.add(t);
      if (!tagsWithinScope([...projected], allowed, rawTags)) {
        return forbidden("update-note: post-update tag set must satisfy the token's allowlist");
      }
    }
    // vault#568 — scrub the echoed note(s). Without this a no-op update-note
    // is a one-call bypass of the read-path `.tags` scrub. Also closes two
    // pre-existing parity gaps on this tool: the echoed hydrated `links`
    // (REST's PATCH already scrubbed them at the `filterHydratedLinksByTagScope`
    // call; MCP did not) and `validation_status` (#555 wired the scrub to the
    // read paths only).
    return scrubWriteResult(await orig(params));
  });

  wrapReadTool(tools, "delete-note", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    const id = (params as any).id ?? (params as any).note_id;
    if (id) {
      const existing = await store.getNote(id as string);
      if (!existing || !noteWithinTagScope(existing, allowed, rawTags)) {
        return { error: "Note not found", error_type: "not_found", id };
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
    try {
      return await orig(params);
    } catch (err: any) {
      // Tag-scope scrub for cross-tag field conflicts (vault#554
      // auth-and-scope fold). Core's validation scans EVERY tag's schema
      // (scope-unaware by architecture), so its TagFieldConflictError can
      // name an OUT-OF-SCOPE tag and reveal its declared type/flag in both
      // the violation entries and the error message. The write stays
      // rejected — schema integrity is scope-independent — but re-throw
      // with scrubbed violations (out-of-scope declarers generalized, no
      // tag name / declared type, `other_tag` dropped; in-scope declarers
      // keep full detail). Rebuilding via the constructor also rebuilds
      // the top-level message from the scrubbed entries. Same pattern as
      // the list-tags `did_you_mean` scrub above.
      if (err && err.code === "TAG_FIELD_CONFLICT" && Array.isArray(err.violations)) {
        throw new TagFieldConflictError(
          err.tag ?? (tag as string),
          scrubTagFieldViolationsByScope(err.violations, allowed),
        );
      }
      // Same leak through the OTHER door (wire-review interaction): a
      // both-indexed cross-tag type conflict deliberately bypasses the
      // pre-check (preserving its declareField → invalid_indexed_field
      // contract), and declareField's IndexedFieldError message names the
      // other declarer tag(s). Generalize for scoped callers; solo
      // own-field IndexedFieldErrors (no declarer_tags) pass untouched.
      if (err instanceof IndexedFieldError) {
        throw scrubIndexedFieldConflictError(err, allowed);
      }
      // parent_names cycle guard (vault#552) — the hierarchy `upsertTagRecord`
      // validates against is vault-wide (scope-unaware by architecture), so
      // the cycle path can name an out-of-scope tag. Same "write stays
      // rejected, path gets generalized" posture as the field-conflict scrub
      // above.
      if (err instanceof ParentCycleError) {
        throw scrubParentCycleError(err, allowed);
      }
      throw err;
    }
  });

  wrapReadTool(tools, "delete-tag", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    const tag = (params as any).tag ?? (params as any).name;
    if (typeof tag === "string" && !allowed.has(tag)) {
      return forbidden(`delete-tag: tag "${tag}" is outside the token's allowlist`);
    }
    const result = await orig(params);
    // Referential-integrity refusal (vault#552) — scrub out-of-scope
    // referencing tag names before returning. The delete stays refused
    // either way; only the response's tag-name visibility changes.
    if (result && typeof result === "object" && (result as any).error_type === "tag_referenced_as_parent") {
      return {
        ...(result as Record<string, unknown>),
        referencing_tags: scrubReferencingTagsByScope((result as any).referencing_tags ?? [], allowed),
      };
    }
    return result;
  });

  // rename-tag / merge-tags (vault#552 — MCP parity with the pre-existing
  // REST engine). Same tag-scope posture as update-tag/delete-tag: every
  // tag NAMED in the request (source(s) + target, or old/new name) must be
  // inside the caller's allowlist — a rename/merge that pulls a tag out of
  // scope (or in) is a privilege-boundary move, refuse the whole op before
  // it reaches core.
  wrapReadTool(tools, "rename-tag", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    const oldName = (params as any).old_name ?? (params as any).from ?? (params as any).tag;
    const newName = (params as any).new_name ?? (params as any).to;
    for (const t of [oldName, newName]) {
      if (typeof t === "string" && !allowed.has(t)) {
        return forbidden(`rename-tag: tag "${t}" is outside the token's allowlist`);
      }
    }
    return await orig(params);
  });

  wrapReadTool(tools, "merge-tags", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    const sources = Array.isArray((params as any).sources) ? ((params as any).sources as unknown[]) : [];
    const target = (params as any).target;
    for (const t of [...sources, target]) {
      if (typeof t === "string" && !allowed.has(t)) {
        return forbidden(`merge-tags: tag "${t}" is outside the token's allowlist`);
      }
    }
    return await orig(params);
  });

  // doctor (vault#552) — the scan itself is re-run with the caller's
  // expanded allowlist rather than post-filtering the unscoped result, so
  // aggregate counts (findings summary) never reflect out-of-scope data.
  wrapReadTool(tools, "doctor", async (orig, params) => {
    const allowed = await getAllowed();
    if (!allowed) return await orig(params);
    return runDoctorScan(store.db, { allowedTags: allowed });
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
    // NOTE (vault#554): these two throws are deliberately left as plain,
    // unstructured `Error`s — NOT given `error_type` — even though the rest
    // of this file's sweep attaches one everywhere else. Attaching one here
    // routes the throw through mcp-http.ts's structured-error mapping, which
    // surfaces it as a JSON-RPC protocol-level error (`response.error`)
    // instead of the in-band tool result the existing contract test asserts
    // (`response.result.isError === true`, `response.result.content[0].text`
    // containing the scope name) — see "tools/call of vault-info with
    // description arg and vault:read scope is refused" in src/vault.test.ts.
    // Changing that transport shape is out of scope for this wave.
    const config = readVaultConfig(vaultName);
    if (!config) throw new Error(`Vault "${vaultName}" not found`);

    if (params.description !== undefined) {
      // Secondary scope check: vault-info is read-gated so read-only callers
      // can fetch stats, but mutating the vault description requires admin
      // for THIS vault (was `write` — tightened by the write/admin re-tier:
      // writing the vault's own description/config is curation, same class
      // as update-tag et al, not content authorship). Without this, a
      // vault:read OR vault:write token could bypass the outer gate by
      // passing `description` to a tool the outer gate considers read-only.
      if (!auth || !hasScopeForVault(auth.scopes, vaultName, "admin")) {
        throw new Error(
          `Forbidden: updating the vault description requires the 'vault:admin' scope (or 'vault:${vaultName}:admin'). Granted scopes: ${auth?.scopes.join(" ") || "(none)"}.`,
        );
      }
      // vault#669: runtime type guard — the `as string` cast below was a
      // compile-time claim guarding nothing, so a write/admin caller could
      // persist a non-string `description` (or crash serializeVaultConfig
      // with `description.split is not a function`) and poison the NEXT
      // MCP `initialize` (projectionToMarkdown's `description.trim()`).
      // Reject non-string/non-null here as a structured invalid-params
      // error: a duck-typed `error_type` throw, which src/mcp-http.ts's
      // generic branch turns into JSON-RPC -32602 INVALID_PARAMS carrying
      // structured `data` — the same shape core's own validation leaves
      // take, no new error family. `null` stays legal: it clears the
      // description. Cross-door parity with cloud#263 (closes the bun
      // half of cloud#87).
      if (params.description !== null && typeof params.description !== "string") {
        throw Object.assign(new Error("description must be a string or null"), {
          error_type: "invalid_description",
          field: "description",
          got: params.description,
          hint: "pass a string, or null to clear the description",
        });
      }
      config.description = params.description as string | null;
      writeVaultConfig(config);
    }

    const store = getVaultStore(vaultName);
    const includeStats = Boolean(params.include_stats);
    const projection = buildVaultProjection(store.db, { includeStats });

    // GAP 3 / vault coordinates: surface the vault's own NAME + REST/MCP URL
    // templates so a surface-builder doesn't have to learn them from the MCP
    // connector config. `base_url` is absolute when the vault knows its public
    // origin (PARACHUTE_HUB_ORIGIN / expose-state); null on a loopback-only
    // box, where `rest_api` / `mcp` carry `<hub-origin>` placeholder templates
    // resolved against whatever origin the client connected through.
    const coords = resolveVaultCoordinates();
    const coordBase = coords.hubOriginKnown ? coords.hubOrigin.replace(/\/$/, "") : "<hub-origin>";

    const result: Record<string, unknown> = {
      name: config.name,
      description: config.description ?? null,
      coordinates: {
        name: config.name,
        base_url: coords.hubOriginKnown ? `${coordBase}/vault/${config.name}` : null,
        rest_api: `${coordBase}/vault/${config.name}/api`,
        mcp: `${coordBase}/vault/${config.name}/mcp`,
      },
      tags: projection.tags,
      indexed_fields: projection.indexed_fields,
      query_hints: projection.query_hints,
      map: projection.map,
    };

    // A2: surface a pointer (path, not body) to the seeded onboarding guide so
    // any connected AI is steered to read it first. Present only when the note
    // exists (buildVaultProjection gates on it). Older vaults without one omit
    // the field entirely.
    if (projection.getting_started) {
      result.getting_started = projection.getting_started;
    }

    if (projection.stats) {
      result.stats = projection.stats;
    }

    return result;
  };
}

// ---------------------------------------------------------------------------
// manage-token (vault#376) — single MCP tool with mint/revoke/list actions
// ---------------------------------------------------------------------------

/**
 * TTL bounds for `manage-token` action=mint, in seconds. Short by design:
 * the design doc (vault#376) calls the tool out as the "AI mints a token
 * for one-shot scripted work, then revokes immediately" surface. A long
 * TTL would defeat the safety story — if revoke fails (network blip,
 * model error), the cap is the backstop. Operators wanting long-lived
 * tokens mint a hub-issued JWT via the hub mint-token flow (the REST
 * /vault/<name>/tokens endpoint was removed with the pvt_* drop, vault#282).
 * The `long_lived: true` opt-in deliberately relaxes this to a 90-day
 * ceiling for standing credentials; the caller's admin JWT could already
 * mint longer directly from the hub, so the flag adds no new authority.
 */
const MANAGE_TOKEN_DEFAULT_TTL_SECONDS = 900; // 15 minutes
const MANAGE_TOKEN_MAX_TTL_SECONDS = 3600; // 1 hour
const MANAGE_TOKEN_LONG_TTL_MAX_SECONDS = 7776000; // 90 days; opt-in ceiling for `long_lived: true`, matching hub's API_MINT_TOKEN_DEFAULT_TTL_SECONDS

/**
 * Resolve the bare hub origin for the mint/revoke proxy calls. Reuses
 * `chooseHubOrigin` (PARACHUTE_HUB_ORIGIN → expose-state FQDN → loopback) so
 * the manage-token proxy targets the same hub the rest of vault talks to.
 * The port is read from global config (same source the server binds on).
 */
function resolveHubOrigin(): { url: string; source: string } {
  let port = DEFAULT_PORT;
  try {
    port = readGlobalConfig().port || DEFAULT_PORT;
  } catch {
    // Config unreadable (fresh / test fixture) — fall back to the default
    // port; chooseHubOrigin still honors PARACHUTE_HUB_ORIGIN / expose-state.
  }
  return chooseHubOrigin(port);
}

/**
 * Build the manage-token MCP tool, wired to the calling session's auth.
 *
 * After the auth-unification arc (vault#403, MGT) the tool is a thin proxy to
 * hub's mint-token attenuation endpoint: it mints short-TTL HUB JWTs. The
 * `pvt_*` vault-DB mint infra it replaced was removed at 0.5.0 (vault#282
 * Stage 2 — vault is a pure hub resource-server).
 *
 * Closure-captured context:
 *   - `vaultName`: every mint requests `vault:<vaultName>:<verb>`; cross-vault
 *     and over-scope requests are rejected locally by `validateMintedScopes`
 *     (fail-fast) AND by hub's attenuation guard (authoritative).
 *   - `auth.scopes`: the caller must hold `vault:<vaultName>:admin` to see the
 *     tool (mcp-http.ts visibleTools filter) and to mint; `validateMintedScopes`
 *     enforces the requested scope is a same-vault subset of what's held.
 *   - `auth.caller_jti`: the minting MCP session's id, recorded as the
 *     `parent_jti` in the local ledger so list/revoke stay session-scoped.
 *     When NULL (env-var operator / hub JWT without jti) there's no stable
 *     session id → list returns empty + revoke returns not_found.
 *   - `callerBearer`: the RAW credential the session presented. Only forwarded
 *     to hub when JWT-shaped (a hub JWT carrying `vault:<name>:admin`). A
 *     non-forwardable credential (the VAULT_AUTH_TOKEN env-var operator secret)
 *     yields a clear "mint requires a hub-JWT session" error rather than a
 *     fabricated bearer.
 *
 * The execute function is async (mint/revoke do an HTTP round-trip to hub) and
 * returns a discriminated-union response shape: `{action, …}` with `action`
 * matching the requested action. The MCP HTTP layer serializes the result
 * via `JSON.stringify`, so caller-side parsing keys off the action field.
 */
function buildManageTokenTool(
  vaultName: string,
  auth: AuthResult | undefined,
  callerBearer: string | null,
): McpToolDef {
  return {
    name: "manage-token",
    requiredVerb: "admin",
    description:
      "Mint, revoke, or list short-TTL hub JWTs within this MCP session. " +
      "Designed for one-shot AI-driven workflows: mint a narrow token, run a " +
      "script with it, revoke immediately. Minted tokens are short-lived hub " +
      "JWTs (revocable via the hub's token registry), not legacy vault-DB " +
      "tokens. Lifetime defaults to 15 min (max 1 hour). Mints are pinned to " +
      "this vault and attenuated to a subset of the caller's scope — you cannot " +
      "escalate. Minting requires a hub-JWT session holding 'vault:" + vaultName +
      ":admin'. List + revoke are scoped to tokens this session minted; " +
      "CLI/REST-minted tokens are not surfaced here.\n\n" +
      "`long_lived: true` raises the mint TTL cap to 90 days; a 90-day token is a " +
      "standing credential and meaningfully increases blast radius if leaked/misused.\n\n" +
      "Actions (discriminator: `action`):\n" +
      "- `mint` — { scope: string|string[], ttl_seconds?: number, long_lived?: boolean, description?: string } → { action: \"mint\", token, jti, expires_at, scopes, scoped_tags, vault_name } (vault#555: scopes/scoped_tags/vault_name were previously undocumented here)\n" +
      "- `revoke` — { jti: string } → { action: \"revoke\", ok: boolean, already_revoked?: boolean } — idempotent; a jti not in this session's ledger, or already revoked, still returns ok:true. A genuine failure additionally carries error/message (and, for a hub-side rejection, hub_status).\n" +
      "- `list` — (no inputs) → { action: \"list\", tokens: [...] }",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["mint", "revoke", "list"],
          description: "Which action to perform. Required.",
        },
        scope: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "(action=mint) Scope to grant. String like \"vault:write\" or array. Must be a subset of the caller's scope; cross-vault scopes are rejected.",
        },
        ttl_seconds: {
          type: "number",
          description: `(action=mint) Token lifetime in seconds. Default ${MANAGE_TOKEN_DEFAULT_TTL_SECONDS} (15 min), max ${MANAGE_TOKEN_MAX_TTL_SECONDS} (1 hour); with long_lived=true, max ${MANAGE_TOKEN_LONG_TTL_MAX_SECONDS} (90 days). Values outside the applicable (0, max] range are rejected.`,
        },
        long_lived: {
          type: "boolean",
          description: "(action=mint, optional) Set true to raise the TTL cap from 1 hour to 90 days. A 90-day token is a standing credential: long-lived and meaningfully increases blast radius if leaked/misused.",
        },
        description: {
          type: "string",
          description: "(action=mint, optional) Free-text label surfaced in the token list + audit trail.",
        },
        jti: {
          type: "string",
          description: "(action=revoke) The jti (e.g. `t_abc123…`) returned by a prior mint. Revoke is idempotent — second revoke also returns ok=true.",
        },
      },
      required: ["action"],
    },
    execute: async (params) => {
      const action = params.action;

      // Defense-in-depth: the outer filter (mcp-http.ts visibleTools)
      // already requires vault:admin for this vault to see manage-token,
      // so reaching execute means the gate passed. A hand-crafted
      // tools/call bypassing list would still hit the dispatch verb-check
      // in handleScopedMcp. The block below is a third belt-and-suspenders
      // check so a refactor of either layer can't lose the invariant
      // silently.
      if (!auth || !hasScopeForVault(auth.scopes, vaultName, "admin")) {
        return {
          action,
          error: "Forbidden",
          message: `manage-token requires the 'vault:admin' scope (or 'vault:${vaultName}:admin'). Granted: ${auth?.scopes.join(" ") || "(none)"}.`,
        };
      }

      if (action === "mint") return await mintAction(params, vaultName, auth, callerBearer);
      if (action === "revoke") return await revokeAction(params, vaultName, auth, callerBearer);
      if (action === "list") return listAction(vaultName, auth);

      return {
        error: "invalid_request",
        message: `manage-token: unknown action "${String(action)}" — expected "mint" | "revoke" | "list".`,
      };
    },
  };
}

/**
 * Normalize a requested scope to the resource-narrowed `vault:<name>:<verb>`
 * shape hub expects. Callers may pass either the broad `vault:<verb>` form
 * (the manage-token v1 surface accepted this) or the explicit
 * `vault:<name>:<verb>` form. We rewrite the broad form to name THIS vault so
 * hub's attenuation guard — which only knows resource-narrowed scopes — sees a
 * `vault:<vaultName>:<verb>` request. A scope already naming a different vault
 * is left untouched (validateMintedScopes rejects it before we get here).
 */
function narrowScopeForVault(scope: string, vaultName: string): string {
  const parts = scope.split(":");
  // `vault:<verb>` (2 parts) → `vault:<name>:<verb>`.
  if (parts.length === 2 && parts[0] === "vault") {
    return `vault:${vaultName}:${parts[1]}`;
  }
  return scope;
}

async function mintAction(
  params: Record<string, unknown>,
  vaultName: string,
  auth: AuthResult,
  callerBearer: string | null,
): Promise<Record<string, unknown>> {
  // Scope parsing: accept string or string[]. Empty/missing is rejected
  // explicitly (no implicit "full scope" default — manage-token always
  // narrows). The validateMintedScopes call then enforces:
  //   - shape (recognized vault scope)
  //   - vault-pin (cross-vault rejected)
  //   - subset of caller's scope on this vault.
  let requested: string[];
  if (typeof params.scope === "string") {
    requested = parseScopes(params.scope);
  } else if (Array.isArray(params.scope)) {
    requested = params.scope.filter((s): s is string => typeof s === "string" && s.length > 0);
  } else {
    return {
      action: "mint",
      error: "invalid_request",
      message: "manage-token mint: `scope` is required (string or string[]).",
    };
  }
  if (requested.length === 0) {
    return {
      action: "mint",
      error: "invalid_request",
      message: "manage-token mint: at least one scope required.",
    };
  }

  // Fail-fast local guard (defense-in-depth — hub's attenuation is
  // authoritative): cross-vault + over-scope requests are rejected here with a
  // clear message before any HTTP round-trip. The caller cannot request a
  // scope outside their own vault/authority.
  const validation = validateMintedScopes(requested, vaultName, auth.scopes);
  if (!validation.ok) {
    return {
      action: "mint",
      error: "forbidden",
      message: "manage-token mint: scope rejected (must be a subset of the caller's scope on this vault).",
      rejected: validation.rejected,
    };
  }

  // Forwardability: minting is a proxy to hub's attenuation endpoint, so the
  // caller must present a forwardable hub-JWT bearer carrying
  // `vault:<name>:admin`. A non-JWT credential (the VAULT_AUTH_TOKEN env-var
  // operator secret) can't be forwarded — and wouldn't carry mint authority at
  // hub anyway — so fail with a clear, actionable error rather than
  // fabricating a bearer.
  //
  // `looksLikeJwt` is a SYNTACTIC hint only (startsWith("eyJ") — the base64url
  // of a JWS header `{"`). It does NOT verify the signature, issuer, scopes,
  // or that the bearer actually grants mint authority. That's intentional:
  // hub's mint-token attenuation guard is the authoritative gate (it validates
  // the bearer and rejects anything it couldn't have minted). This check just
  // avoids forwarding a credential we already know can't be a hub JWT.
  if (!callerBearer || !looksLikeJwt(callerBearer)) {
    return {
      action: "mint",
      error: "forbidden",
      message:
        `manage-token mint requires a hub-JWT session holding 'vault:${vaultName}:admin'. ` +
        "This session authenticated with a non-forwardable credential (operator " +
        "env-var token or legacy vault-DB token); mint a token via the hub admin " +
        "UI / CLI instead, or reconnect MCP with a hub-issued JWT.",
    };
  }

  // TTL bounds. Default 900 (15 min); explicit values must satisfy
  // `0 < ttl <= MANAGE_TOKEN_MAX_TTL_SECONDS`, or
  // `0 < ttl <= MANAGE_TOKEN_LONG_TTL_MAX_SECONDS` with `long_lived: true`.
  // Zero, negative, NaN, and beyond-max all reject — the cap is the safety
  // backstop if revoke fails, so it must be strict.
  if (params.long_lived !== undefined && typeof params.long_lived !== "boolean") {
    return {
      action: "mint",
      error: "invalid_request",
      message: "manage-token mint: long_lived must be a boolean.",
    };
  }
  const maxTtl = params.long_lived === true
    ? MANAGE_TOKEN_LONG_TTL_MAX_SECONDS
    : MANAGE_TOKEN_MAX_TTL_SECONDS;
  let ttl = MANAGE_TOKEN_DEFAULT_TTL_SECONDS;
  if (params.ttl_seconds !== undefined && params.ttl_seconds !== null) {
    if (typeof params.ttl_seconds !== "number" || !Number.isFinite(params.ttl_seconds)) {
      return {
        action: "mint",
        error: "invalid_request",
        message: "manage-token mint: ttl_seconds must be a finite number.",
      };
    }
    if (params.ttl_seconds <= 0 || params.ttl_seconds > maxTtl) {
      return {
        action: "mint",
        error: "invalid_request",
        message: `manage-token mint: ttl_seconds must be in (0, ${maxTtl}]; got ${params.ttl_seconds}.`,
      };
    }
    ttl = params.ttl_seconds;
  }

  const description = typeof params.description === "string" && params.description.length > 0
    ? params.description
    : null;
  const label = description ?? `mcp-mint (parent=${auth.caller_jti ?? "unknown"})`;

  // Resolve hub origin (PARACHUTE_HUB_ORIGIN → expose-state FQDN → loopback).
  const hub = resolveHubOrigin();

  // Build the mint-token request. Scopes are narrowed to the resource-named
  // `vault:<name>:<verb>` form hub's attenuation guard requires. Tag-scoping
  // (when the caller is tag-scoped) rides along as `permissions.scoped_tags`
  // so the minted hub JWT carries the same restriction — vault enforces it on
  // read via C0 (vault#403). Unscoped callers omit `permissions`.
  const narrowedScopes = requested.map((s) => narrowScopeForVault(s, vaultName));
  const permissions =
    auth.scoped_tags && auth.scoped_tags.length > 0
      ? { scoped_tags: auth.scoped_tags }
      : undefined;

  const minted = await mintHubJwt({
    hubOrigin: hub.url,
    operatorToken: callerBearer,
    scope: narrowedScopes.join(" "),
    expiresInSeconds: ttl,
    ...(permissions !== undefined ? { permissions } : {}),
  });

  if ("kind" in minted) {
    // Surface a clear, action-keyed error. Network → "hub unreachable";
    // api-error → hub's own error_description (e.g. attenuation rejection).
    if (minted.kind === "network") {
      return {
        action: "mint",
        error: "hub_unreachable",
        message: `manage-token mint: could not reach hub at ${minted.origin} (${minted.cause}). Check PARACHUTE_HUB_ORIGIN / that the hub is running.`,
      };
    }
    return {
      action: "mint",
      error: "hub_rejected",
      message: `manage-token mint: hub rejected the request (${minted.error}: ${minted.description}).`,
      hub_status: minted.status,
    };
  }

  // Record in the session-pinned ledger so list/revoke can scope to this
  // session's mints. The signed JWT is never stored — only its jti (the
  // revocation handle) + display metadata. NULL caller_jti (env-var / no-jti
  // sessions) can't pass the forwardability gate above, so by here caller_jti
  // is effectively the JWT's jti; we still guard defensively.
  const store = getVaultStore(vaultName);
  if (auth.caller_jti) {
    recordMcpMintLedger(store.db, {
      jti: minted.jti,
      parentJti: auth.caller_jti,
      vaultName,
      label,
      scopes: narrowedScopes,
      scopedTags: auth.scoped_tags,
      expiresAt: minted.expires_at,
    });
  }

  return {
    action: "mint",
    token: minted.token,
    jti: minted.jti,
    expires_at: minted.expires_at,
    scopes: narrowedScopes,
    scoped_tags: auth.scoped_tags,
    vault_name: vaultName,
  };
}

async function revokeAction(
  params: Record<string, unknown>,
  vaultName: string,
  auth: AuthResult,
  callerBearer: string | null,
): Promise<Record<string, unknown>> {
  if (typeof params.jti !== "string" || params.jti.length === 0) {
    return {
      action: "revoke",
      ok: false,
      error: "invalid_request",
      message: "manage-token revoke: `jti` is required (string).",
    };
  }
  const jti = params.jti;

  // Session-pin: revoke is restricted to hub JWTs THIS MCP session minted.
  // When auth.caller_jti is null (no stable session id — env-var operator,
  // legacy YAML key, hub JWT without jti), there are no attributable mints,
  // so revoke returns not_found.
  if (!auth.caller_jti) {
    return {
      action: "revoke",
      ok: false,
      error: "not_found",
      message: "manage-token revoke: this session has no stable id; revoke via the hub admin UI / CLI.",
    };
  }

  const store = getVaultStore(vaultName);
  const entry = findMcpMintLedgerEntry(store.db, jti, auth.caller_jti, vaultName);
  if (!entry) {
    // Idempotency: not-in-this-session's-ledger returns ok=true so the AI's
    // "mint → run → revoke" loop doesn't surface a confusing failure on a
    // duplicate revoke or a network-blip retry. The "minted by another
    // session" case also lands here; we don't differentiate (no information
    // leak about other sessions' jti space).
    return { action: "revoke", ok: true, note: "no matching token in this session" };
  }
  if (entry.revoked_at) {
    // Already revoked locally — idempotent success, no second hub round-trip.
    return { action: "revoke", ok: true, already_revoked: true };
  }

  // Forward the revoke to hub's token registry (the authoritative revocation
  // surface — vault is resource-server-only). The caller's `vault:<N>:admin`
  // bearer is forwarded, same as on mint. As of hub#454 this is the
  // expected-SUCCESS path: hub's revoke-token applies capability attenuation
  // symmetric to mint, so a `vault:<N>:admin` bearer may revoke any jti whose
  // scopes it could have minted (and these are exactly the tokens this session
  // minted within that vault's authority). Hub's revoke-token is idempotent.
  //
  // The `"kind" in revoked` branch below is now the EXCEPTION, not the norm —
  // it only fires on a genuine edge (network blip, or a hub-side rejection
  // that shouldn't happen for an in-authority jti). When it does, we still
  // flip the local ledger marker so list reflects the operator's intent, and
  // surface the hub failure so the caller knows the registry-side revoke may
  // not have landed (the short TTL is the backstop either way).
  if (callerBearer && looksLikeJwt(callerBearer)) {
    const hub = resolveHubOrigin();
    const revoked = await revokeHubJwt({
      hubOrigin: hub.url,
      operatorToken: callerBearer,
      jti,
    });
    if ("kind" in revoked) {
      // Unexpected hub failure. Local ledger still flips (operator asked to
      // revoke), but report the hub-side failure so a network blip / scope
      // gap is visible.
      markMcpMintLedgerRevoked(store.db, jti, auth.caller_jti, vaultName);
      if (revoked.kind === "network") {
        return {
          action: "revoke",
          ok: false,
          error: "hub_unreachable",
          message: `manage-token revoke: could not reach hub at ${revoked.origin} (${revoked.cause}); local ledger marked revoked but the hub registry may still list it. The token's short TTL is the backstop.`,
        };
      }
      return {
        action: "revoke",
        ok: false,
        error: "hub_rejected",
        message: `manage-token revoke: hub rejected the request (${revoked.error}: ${revoked.description}); local ledger marked revoked. The token's short TTL is the backstop.`,
        hub_status: revoked.status,
      };
    }
  }

  markMcpMintLedgerRevoked(store.db, jti, auth.caller_jti, vaultName);
  return { action: "revoke", ok: true, already_revoked: false };
}

function listAction(vaultName: string, auth: AuthResult): Record<string, unknown> {
  if (!auth.caller_jti) {
    // No session id → no attributable mints. Return empty list rather
    // than erroring, so callers can branch on tokens.length without
    // exception handling.
    return { action: "list", tokens: [] };
  }
  const store = getVaultStore(vaultName);
  // Read from the hub-JWT mint ledger (vault#403, MGT) — mints now live in
  // hub's registry, not the pvt_* tokens table; the ledger is the local
  // session-attribution index.
  const tokens = listMcpMintedHubJwts(store.db, auth.caller_jti, vaultName);
  return { action: "list", tokens };
}
