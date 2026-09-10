/**
 * Tag-scope enforcement for tag-scoped tokens (docs/contracts/tag-scoped-tokens.md).
 *
 * A token's `scoped_tags` allowlist narrows its effective access to notes
 * carrying one of the allowlisted tags or a sub-tag thereof. The expansion
 * to descendants happens via the per-vault `_tags/<name>` config-note
 * hierarchy (see core/src/tag-hierarchy.ts).
 *
 * Auth check pseudocode (from docs/contracts/tag-scoped-tokens.md):
 *
 *   if (!hasScope(token, ...)) return forbidden();
 *   if (token.scoped_tags === null) return ok();   // unscoped
 *   const noteTags = note.tags;                     // hierarchy-aware
 *   if (noteTags.some(t => allowlist.includes(rootOf(t)))) return ok();
 *   return forbidden();
 *
 * This module returns the *expanded* allowlist (root + descendants), so
 * call-sites just intersect with the note's actual tag set — no per-tag
 * `rootOf` walk is needed at the boundary.
 */

import type { Store, Note, HydratedLink, NoteSummary } from "../core/src/types.ts";
import type { TagFieldViolation } from "../core/src/tag-schemas.ts";
import { ParentCycleError } from "../core/src/tag-schemas.ts";
import { IndexedFieldError } from "../core/src/indexed-fields.ts";
import { stripTagHash } from "../core/src/tag-hierarchy.ts";

/** Generic replacement for a redacted out-of-scope tag name — never the real name. */
const OUT_OF_SCOPE_LABEL = "(outside your token's tag scope)";

/**
 * Build the effective tag-allowlist for a token: union of `{root} ∪
 * descendants(root)` for each root in `scoped_tags`. Returns null when the
 * token is unscoped (no enforcement needed). An empty array also returns
 * null — defensive parity with the token-store parser, which collapses
 * `[]` to null.
 */
export async function expandTokenTagScope(
  store: Store,
  scoped_tags: string[] | null,
): Promise<Set<string> | null> {
  if (!scoped_tags || scoped_tags.length === 0) return null;
  return await store.expandTagsWithDescendants(scoped_tags);
}

/**
 * Return true iff the note's tag set intersects the expanded allowlist OR
 * — fail-open per docs/contracts/tag-scoped-tokens.md §Storage — any of the
 * note's tags has a string-form root inside `rawRoots`. The string-form
 * fallback covers the orphan-sub-tag case: a token allowlisted for
 * `health` should still see `#health/food` even when no `_tags/health/food`
 * schema declares the hierarchy. The raw `rawRoots` array is the canonical
 * allowlist source; `allowed` is just a precomputed expansion for the
 * common (declared-hierarchy) case.
 *
 * Pass `null` for both when the token is unscoped (always permitted).
 */
export function noteWithinTagScope(
  note: Note,
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): boolean {
  if (rawRoots === null) return true;
  if (!note.tags || note.tags.length === 0) return false;
  for (const t of note.tags) {
    if (allowed && allowed.has(t)) return true;
    const root = t.split("/")[0];
    if (root && rawRoots.includes(root)) return true;
  }
  return false;
}

/**
 * Filter an array of notes to those within the token's tag scope.
 * No-op when `rawRoots` is null. See `noteWithinTagScope` for the
 * string-form fallback semantics.
 */
export function filterNotesByTagScope<T extends Note>(
  notes: T[],
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): T[] {
  if (rawRoots === null) return notes;
  return notes.filter((n) => noteWithinTagScope(n, allowed, rawRoots));
}

/**
 * Is a SINGLE tag name visible to this token? The per-tag core of
 * `noteWithinTagScope` — exact allowlist membership OR string-form root
 * match — pulled out so the `validation_status` scrub below (which reasons
 * about a warning's `schema`/`loser_schema` tag NAMES, not a note's whole
 * tag set) uses the identical visibility rule. `rawRoots === null` (unscoped)
 * → always visible.
 *
 * Exported (vault aggregate/rollup feature) so `query-notes`'s `aggregate`
 * mode under `group_by: "tag"` can scrub GROUP NAMES for a scoped caller —
 * a co-tagged note that's itself in scope (visible via one tag) still
 * carries out-of-scope tags, and a tag rollup's groups ARE tag names, so
 * narrowing which NOTES count (the `aggregateVisibility` note-level
 * predicate) isn't sufficient on its own to keep an out-of-scope tag name
 * from surfacing as a group. See `src/mcp-tools.ts` / `src/routes.ts`'s
 * aggregate branches.
 */
export function tagVisibleInScope(
  tag: string,
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): boolean {
  if (rawRoots === null) return true;
  if (allowed && allowed.has(tag)) return true;
  const root = tag.split("/")[0];
  return !!root && rawRoots.includes(root);
}

/**
 * Scrub a note's `validation_status` so a tag-scoped caller can't learn the
 * SCHEMA SHAPE (field name, type, enum values) of an OUT-OF-SCOPE tag that
 * happens to co-tag a note it can otherwise see (vault#555 auth review;
 * the #560 leak class). Repro: a scoped caller reading a note tagged both
 * `mine` (in scope) and `project-manhattan` (out of scope) received
 * `validation_status.warnings: [{ schema: "project-manhattan", message:
 * "'codeword' must be one of [fizzbuzz] ...", ... }]` and
 * `schemas: ["project-manhattan"]` — leaking that tag's field/enum.
 *
 * Core produces the FULL status (scope-unaware by architecture, same as
 * every other core surface); this server-layer scrub — mirroring
 * `scrubTagFieldViolationsByScope` — drops any warning whose declaring
 * tag (`schema`, and for a `schema_conflict` the overridden `loser_schema`)
 * is out of scope, and filters the `schemas` array to visible tags. When
 * nothing in-scope remains (the note's only schema-declaring tag was
 * out-of-scope), returns `undefined` so the caller omits `validation_status`
 * entirely — byte-identical to a note with no applicable schema. Unscoped
 * callers (`rawRoots === null`) get the status untouched.
 *
 * Applied at every point a scoped caller receives `validation_status`: the
 * MCP `query-notes` wrapper and the REST `GET /notes[/{id}]` read paths.
 */
export function scrubValidationStatusByScope<
  S extends { schemas: string[]; warnings: Array<{ schema: string; loser_schema?: string }> },
>(
  status: S | null | undefined,
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): S | undefined {
  if (!status || rawRoots === null) return status ?? undefined;
  const schemas = status.schemas.filter((s) => tagVisibleInScope(s, allowed, rawRoots));
  const warnings = status.warnings.filter(
    (w) =>
      tagVisibleInScope(w.schema, allowed, rawRoots) &&
      (w.loser_schema === undefined || tagVisibleInScope(w.loser_schema, allowed, rawRoots)),
  );
  if (schemas.length === 0 && warnings.length === 0) return undefined;
  return { ...status, schemas, warnings };
}

/**
 * For write paths: a note being created/updated must end up carrying at
 * least one tag inside the allowlist. `tags` is the post-write tag set
 * (already including any tag updates). The string-form fallback in
 * `rawRoots` mirrors the read-path semantics — a token allowlisted for
 * `health` can write `#health/food` even when the sub-tag has no
 * declared schema. Returns true iff write is permitted.
 */
export function tagsWithinScope(
  tags: string[] | undefined,
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): boolean {
  if (rawRoots === null) return true;
  if (!tags || tags.length === 0) return false;
  for (const t of tags) {
    if (allowed && allowed.has(t)) return true;
    const root = t.split("/")[0];
    if (root && rawRoots.includes(root)) return true;
  }
  return false;
}

/**
 * Build a per-note visibility predicate for wikilink expansion
 * (`ExpandContext.isVisible` in core/src/expand.ts). When the token is
 * unscoped (`rawRoots === null`) this returns `undefined` so the expander
 * keeps its original scope-unaware behavior (no predicate installed). When
 * scoped, it returns a closure over the SAME `noteWithinTagScope` allowlist
 * logic every other read path uses — so a wikilink whose target is outside
 * the token's tag scope is left unresolved during inlining, never embedded.
 *
 * This is the seam that keeps core scope-unaware: the predicate is built
 * server-side from the tag-scope machinery and injected into the context;
 * core only calls it.
 */
export function buildExpandVisibility(
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): ((note: Note) => boolean) | undefined {
  if (rawRoots === null) return undefined;
  return (note: Note) => noteWithinTagScope(note, allowed, rawRoots);
}

/**
 * Filter a note's OWN `.tags` array to the tags this token can see
 * (vault#568). A tag-scoped token is admitted to a note when ANY of its tags
 * is in scope (`noteWithinTagScope`) — but the note that came back carried
 * its FULL tag set, so a note tagged `["mine","project-manhattan"]` read by a
 * `mine`-scoped token disclosed the NAME `project-manhattan`. Same
 * out-of-scope-tag-name disclosure class as #560 and the `validation_status`
 * scrub above, through a different field.
 *
 * Policy: `.tags` becomes exactly the in-scope subset, using the SAME
 * per-tag rule (`tagVisibleInScope`) that admitted the note — allowlist
 * membership OR string-form root match. Non-mutating: returns the input
 * untouched when nothing is filtered (and always when unscoped), otherwise a
 * shallow copy with a fresh `tags` array. That matters at the live-
 * subscription seam, where ONE `Note` payload fans out to many subscribers
 * with different allowlists — mutating it would cross-contaminate.
 *
 * **The result is never empty for a note the caller can see.** A note whose
 * tags are ALL out of scope fails `noteWithinTagScope` and is already
 * invisible (404 on a single read, silently dropped from lists) — it never
 * reaches this scrub. So the visible-subset is non-empty by construction,
 * and this fix introduces no new "note with no tags" shape. The precedent
 * it follows is the contract's §Semantics "out-of-scope reads return 404,
 * not 403": the scope boundary is invisible, not redacted-in-place.
 *
 * Applies to READ responses on both doors AND to write responses, which
 * echo the stored note — a scoped caller could otherwise recover the full
 * tag set with a no-op `update-note`/`PATCH`.
 */
export function scrubNoteTagsByScope<T extends { tags?: string[] }>(
  note: T,
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): T {
  if (rawRoots === null || !note || !Array.isArray(note.tags)) return note;
  const visible = note.tags.filter((t) => tagVisibleInScope(t, allowed, rawRoots));
  if (visible.length === note.tags.length) return note;
  return { ...note, tags: visible };
}

/** Array form of `scrubNoteTagsByScope`. No-op when unscoped. */
export function scrubNotesTagsByScope<T extends { tags?: string[] }>(
  notes: T[],
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): T[] {
  if (rawRoots === null) return notes;
  return notes.map((n) => scrubNoteTagsByScope(n, allowed, rawRoots));
}

/**
 * The stand-in an out-of-scope QUERY tag is rewritten to (vault#675) — a
 * name no real tagging workflow can produce, so a filter naming it matches
 * nothing. See `scopeQueryTags` for why that is the whole fix.
 *
 * Two properties are load-bearing, both pinned by
 * `tag-scope-query-tag.test.ts`:
 *
 *  1. **It survives `stripTagHash`.** `SqliteStore.normalizeQueryTags` maps
 *     `stripTagHash` over query tags and drops the empties — a substitute
 *     that normalized away would collapse `tags` to `[]`, skip the tag
 *     filter entirely, and hand an out-of-scope probe the caller's WHOLE
 *     visible set. Hence the NUL rather than a leading `#`/space.
 *  2. **A collision is inert.** Storage does not police tag bytes, so a
 *     note CAN be written carrying this name (nothing that reads YAML
 *     front-matter or a JSON `tags` array will do so by accident). It buys
 *     an attacker nothing: this rewrite only changes which notes the query
 *     matches, and every read path still applies the unchanged result-side
 *     `filterNotesByTagScope` — so a planted decoy can only ever surface to
 *     a caller who could already read it.
 */
export const OUT_OF_SCOPE_QUERY_TAG = "\u0000out-of-scope";

/**
 * Rewrite an out-of-scope tag NAMED IN A QUERY to `OUT_OF_SCOPE_QUERY_TAG`
 * (vault#675 — the existence-oracle class left open after #568/#674).
 *
 * #568 stopped scoped reads from DISCLOSING an out-of-scope co-tag's name.
 * A scoped caller could still name one itself — `?tag=project-manhattan`,
 * `query-notes { tag }`, a live subscription — and read the answer off
 * hit/miss: a note tagged `["mine","project-manhattan"]` passes
 * `noteWithinTagScope` via `mine`, so the co-tagged filter came back with a
 * row and confirmed the guessed name. No name leaked; membership did.
 *
 * Policy: **an out-of-scope tag behaves exactly as a tag that does not
 * exist** — the same equivalence the rest of this contract already runs on
 * (an out-of-scope note 404s like a missing one; `list-tags { tag }` /
 * `GET /api/tags?tag=` return `tag_not_found` for an out-of-scope name
 * "whether the tag exists or not"). In the FILTER position a nonexistent tag
 * is not an error — it is a filter that matches nothing — so this is a
 * rewrite, not a rejection: the query still runs and still returns 200, it
 * just can't match. Rewriting (rather than short-circuiting per door) is
 * what makes the response byte-identical to the nonexistent-tag control on
 * every door and in every shape — list, cursor envelope, `format=graph`,
 * aggregate rollup, live snapshot — because it IS the nonexistent-tag code
 * path, not a reconstruction of it.
 *
 * Composition falls out of that, no special cases:
 *   - `tag=X` (out of scope) → matches nothing → `[]`.
 *   - `tag=mine&tag=X&tag_match=all` → the `X` membership clause matches
 *     nothing → `[]` (dropping `X` instead would have WIDENED the answer).
 *   - `tag=mine&tag=X&tag_match=any` → the union is just `mine`'s notes.
 *   - `exclude_tag=X` → core skips an exclude clause that can't match,
 *     so it excludes nothing — again exactly a nonexistent tag.
 *
 * Visibility uses the same `tagVisibleInScope` rule that admits a note and
 * scrubs `.tags`, applied to the BARE form (`stripTagHash`) because the
 * query engine strips `#` before matching — otherwise `?tag=%23mine` would
 * be neutralised for a `mine`-scoped caller.
 *
 * Non-mutating, and a no-op for unscoped tokens (`rawRoots === null`) and
 * for queries whose tags are all in scope — the input object is returned by
 * reference in both cases.
 */
export function scopeQueryTags<T extends { tags?: string[]; excludeTags?: string[] }>(
  opts: T,
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): T {
  if (rawRoots === null || !opts) return opts;
  const tags = scopeQueryTagList(opts.tags, allowed, rawRoots);
  const excludeTags = scopeQueryTagList(opts.excludeTags, allowed, rawRoots);
  if (tags === opts.tags && excludeTags === opts.excludeTags) return opts;
  const next: T = { ...opts };
  if (tags !== opts.tags) next.tags = tags;
  if (excludeTags !== opts.excludeTags) next.excludeTags = excludeTags;
  return next;
}

/** `scopeQueryTags` for one array of query tags. Same array back if unchanged. */
function scopeQueryTagList(
  tags: string[] | undefined,
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): string[] | undefined {
  if (!tags || tags.length === 0) return tags;
  let changed = false;
  const out = tags.map((t) => {
    if (typeof t !== "string" || tagVisibleInScope(stripTagHash(t), allowed, rawRoots)) return t;
    changed = true;
    return OUT_OF_SCOPE_QUERY_TAG;
  });
  return changed ? out : tags;
}

/**
 * `scopeQueryTags` for an MCP tool param, which is `string | string[]`
 * (`normalizeTags` accepts either). Shape-preserving — a string stays a
 * string — so the rewritten params lower to the same `QueryOpts` the
 * original would have. Same reference back when nothing is rewritten.
 */
export function scopeQueryTagParam<V>(value: V, allowed: Set<string> | null, rawRoots: string[] | null): V {
  if (rawRoots === null || value === undefined || value === null) return value;
  if (typeof value === "string") {
    return (tagVisibleInScope(stripTagHash(value), allowed, rawRoots)
      ? value
      : OUT_OF_SCOPE_QUERY_TAG) as unknown as V;
  }
  if (Array.isArray(value)) {
    const scoped = scopeQueryTagList(value as string[], allowed, rawRoots);
    return (scoped === (value as unknown as string[]) ? value : scoped) as unknown as V;
  }
  return value;
}

/**
 * Treat a hydrated link's endpoint summary as a scope-checkable note. The
 * summary carries `id` + `tags`, which is all `noteWithinTagScope` needs.
 * A summary with no tags is out of scope under a tag-scoped token (same as
 * a real note with no tags).
 */
function summaryWithinTagScope(
  summary: NoteSummary | undefined,
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): boolean {
  if (!summary) return true; // no summary → no out-of-scope info to leak (dangling/deleted)
  return noteWithinTagScope({ id: summary.id, tags: summary.tags ?? [] } as Note, allowed, rawRoots);
}

/**
 * Filter hydrated links for a tag-scoped token so no out-of-scope NEIGHBOR
 * metadata leaks (security review — MINOR). A `query-notes`/REST response
 * with `include_links=true` returns `sourceNote`/`targetNote` summaries
 * ({id, path, tags, metadata, …}) for every link touching the returned
 * note — INCLUDING links to notes the token can't otherwise see. Those
 * summaries leak the out-of-scope neighbor's id, path, and tags.
 *
 * Policy: drop any link whose source OR target endpoint summary is outside
 * the token's tag scope. The queried note itself is always in-scope (it had
 * to be visible to be returned), so dropping out-of-scope-neighbor links
 * removes exactly the leak while keeping every link between in-scope notes
 * fully hydrated. Dropping the whole row (vs. just nulling the summary) is
 * required because the raw row still carries the neighbor's note id.
 *
 * **Also scrubs the SURVIVING summaries' `.tags` (vault#568).** Dropping
 * wholly-out-of-scope neighbors is not sufficient: an IN-scope neighbor is
 * itself a co-tagged note, so its `NoteSummary.tags` carries the same
 * out-of-scope tag NAMES the top-level note's `.tags` does. This is the
 * second door on the same field, so it gets the same `scrubNoteTagsByScope`
 * treatment (non-mutating — the hydrated rows may be shared across a page).
 *
 * No-op when the token is unscoped (`rawRoots === null`) — identical to the
 * pre-fix behavior.
 */
export function filterHydratedLinksByTagScope(
  links: HydratedLink[],
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): HydratedLink[] {
  if (rawRoots === null) return links;
  return links
    .filter(
      (link) =>
        summaryWithinTagScope(link.sourceNote, allowed, rawRoots) &&
        summaryWithinTagScope(link.targetNote, allowed, rawRoots),
    )
    .map((link) => {
      const sourceNote = link.sourceNote
        ? scrubNoteTagsByScope(link.sourceNote, allowed, rawRoots)
        : link.sourceNote;
      const targetNote = link.targetNote
        ? scrubNoteTagsByScope(link.targetNote, allowed, rawRoots)
        : link.targetNote;
      if (sourceNote === link.sourceNote && targetNote === link.targetNote) return link;
      return { ...link, sourceNote, targetNote };
    });
}

/**
 * Scrub `tag_field_conflict` violations for a tag-scoped caller
 * (vault#554 auth-and-scope review fold). Core's cross-tag field
 * validation (`collectCrossTagFieldViolations` / `collectTagFieldViolations`
 * in core/src/tag-schemas.ts) scans EVERY tag's schema — scope-unaware by
 * architecture — so a scoped caller updating its own in-scope tag can
 * receive a violation whose `message` names an OUT-OF-SCOPE tag and
 * reveals its declared type/indexed flag (proven live on both MCP and
 * REST). Policy: the write is STILL rejected (schema integrity is
 * scope-independent — do not weaken the check), but the violation entry
 * for an out-of-scope conflicting declarer is generalized: no tag name,
 * no declared type/flag, `other_tag` dropped. In-scope conflicting
 * declarers keep full detail; solo own-field violations (no `other_tag`)
 * pass through untouched; unscoped callers (`allowed === null`) keep full
 * detail everywhere.
 *
 * Membership is `allowed.has(other_tag)` — the same convention the
 * `did_you_mean` scrub and the update-tag/delete-tag wrappers use in
 * src/mcp-tools.ts (no string-form root fallback: when in doubt, scrub —
 * the fail-closed direction only costs detail, never correctness).
 */
export function scrubTagFieldViolationsByScope(
  violations: TagFieldViolation[],
  allowed: Set<string> | null,
): TagFieldViolation[] {
  if (allowed === null) return violations;
  return violations.map((v) => {
    if (v.other_tag === undefined || allowed.has(v.other_tag)) return v;
    const generalized =
      v.reason === "type_conflict"
        ? `field "${v.field}" type conflict: another tag (outside your token's tag scope) declares this field with a different type. Types must agree across all declarers.`
        : `field "${v.field}" indexed-flag conflict: another tag (outside your token's tag scope) declares this field with a different indexed flag. Must match across all declarers.`;
    const { other_tag: _dropped, ...rest } = v;
    return { ...rest, message: generalized };
  });
}

/**
 * Companion scrub for the OTHER door the same information can leak
 * through (vault#554 auth-and-scope × wire-review interaction): a
 * both-indexed cross-tag type conflict deliberately bypasses the
 * `tag_field_conflict` pre-check (preserving its pre-existing
 * `declareField` → 400 `invalid_indexed_field` contract — see
 * `collectCrossTagFieldViolations`'s doc comment), and declareField's
 * message names the other declarer tag(s) plus their sqlite type. For a
 * tag-scoped caller with any out-of-scope declarer, return a REPLACEMENT
 * `IndexedFieldError` with a generalized message (no tag names, no
 * existing type) — same rejection, same 400 status, same `error_type`,
 * just no leak. If every declarer is in scope (or the error carries no
 * `declarer_tags` — the solo own-field throws), or the caller is unscoped
 * (`allowed === null`), the original error is returned untouched.
 */
export function scrubIndexedFieldConflictError(
  err: IndexedFieldError & { field?: string; declarer_tags?: string[] },
  allowed: Set<string> | null,
): IndexedFieldError {
  if (allowed === null) return err;
  if (!Array.isArray(err.declarer_tags) || err.declarer_tags.length === 0) return err;
  if (err.declarer_tags.every((t) => allowed.has(t))) return err;
  return new IndexedFieldError(
    `field "${err.field ?? "?"}" is already indexed by another tag (outside your token's tag scope) with a conflicting type. Types must agree across all declarers.`,
  );
}

/**
 * Scrub the `referencing_tags` list on a `tag_referenced_as_parent` refusal
 * (vault#552 — deleteTag's referential-integrity guard) for a tag-scoped
 * caller. The delete is refused regardless of scope (referential integrity
 * is scope-independent, same posture as `tag_field_conflict`), but a
 * referencing tag OUTSIDE the caller's allowlist must not be named — same
 * "in doubt, scrub" convention `scrubTagFieldViolationsByScope` uses.
 * No-op for unscoped callers (`allowed === null`).
 */
export function scrubReferencingTagsByScope(
  referencing: string[],
  allowed: Set<string> | null,
): string[] {
  if (allowed === null) return referencing;
  return referencing.map((t) => (allowed.has(t) ? t : OUT_OF_SCOPE_LABEL));
}

/**
 * Scrub a `ParentCycleError`'s `cycle` path (vault#552 — the `parent_names`
 * cycle guard) for a tag-scoped caller. The write is still rejected — a
 * cycle is a structural problem independent of who's asking — but the
 * cycle path can walk through tags OUTSIDE the caller's allowlist (the
 * hierarchy `upsertTagRecord` validates against is vault-wide, scope-unaware
 * by architecture, same as the cross-tag field checks). Returns a
 * REPLACEMENT error with out-of-scope hops in `cycle` generalized; the
 * caller's own tag (`err.tag`) is always in-scope by the time this runs (the
 * update-tag wrapper already gates on it) so it's never redacted. No-op for
 * unscoped callers or a cycle with no out-of-scope hop.
 */
export function scrubParentCycleError(
  err: ParentCycleError,
  allowed: Set<string> | null,
): ParentCycleError {
  if (allowed === null) return err;
  if (err.cycle.every((t) => allowed.has(t))) return err;
  const scrubbedCycle = err.cycle.map((t) => (allowed.has(t) ? t : OUT_OF_SCOPE_LABEL));
  return new ParentCycleError(err.tag, scrubbedCycle);
}

/**
 * Standard 403 response shape for tag-scope rejections. Mirrors the
 * `insufficient_scope` 403 shape used elsewhere in the API so clients
 * get a consistent error envelope.
 */
export function tagScopeForbidden(scoped_tags: string[]): Response {
  return Response.json(
    {
      error: "Forbidden",
      error_type: "tag_scope_violation",
      message: `This token is restricted to tags: ${scoped_tags.join(", ")}. The note (or write) is outside that scope.`,
      scoped_tags,
    },
    { status: 403 },
  );
}
