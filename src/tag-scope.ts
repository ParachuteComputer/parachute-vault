/**
 * Tag-scope enforcement for tag-scoped tokens (patterns/tag-scoped-tokens.md).
 *
 * A token's `scoped_tags` allowlist narrows its effective access to notes
 * carrying one of the allowlisted tags or a sub-tag thereof. The expansion
 * to descendants happens via the per-vault `_tags/<name>` config-note
 * hierarchy (see core/src/tag-hierarchy.ts).
 *
 * Auth check pseudocode (from patterns/tag-scoped-tokens.md):
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
 * — fail-open per patterns/tag-scoped-tokens.md §Storage — any of the
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
 * No-op when the token is unscoped (`rawRoots === null`) — identical to the
 * pre-fix behavior.
 */
export function filterHydratedLinksByTagScope(
  links: HydratedLink[],
  allowed: Set<string> | null,
  rawRoots: string[] | null,
): HydratedLink[] {
  if (rawRoots === null) return links;
  return links.filter(
    (link) =>
      summaryWithinTagScope(link.sourceNote, allowed, rawRoots) &&
      summaryWithinTagScope(link.targetNote, allowed, rawRoots),
  );
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
