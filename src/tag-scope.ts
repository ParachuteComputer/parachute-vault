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

import type { Store, Note } from "../core/src/types.ts";

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
 * Return true iff the note's tag set intersects the expanded allowlist.
 * Pass `null` for `allowed` when the token is unscoped (always permitted).
 */
export function noteWithinTagScope(note: Note, allowed: Set<string> | null): boolean {
  if (allowed === null) return true;
  if (!note.tags || note.tags.length === 0) return false;
  for (const t of note.tags) {
    if (allowed.has(t)) return true;
  }
  return false;
}

/**
 * Filter an array of notes to those within the token's tag scope.
 * No-op when `allowed` is null.
 */
export function filterNotesByTagScope<T extends Note>(notes: T[], allowed: Set<string> | null): T[] {
  if (allowed === null) return notes;
  return notes.filter((n) => noteWithinTagScope(n, allowed));
}

/**
 * For write paths: a note being created/updated must end up carrying at
 * least one tag inside the allowlist. `tags` is the post-write tag set
 * (already including any tag updates); `allowed` is the expanded
 * allowlist. Returns true iff write is permitted.
 */
export function tagsWithinScope(tags: string[] | undefined, allowed: Set<string> | null): boolean {
  if (allowed === null) return true;
  if (!tags || tags.length === 0) return false;
  for (const t of tags) {
    if (allowed.has(t)) return true;
  }
  return false;
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
