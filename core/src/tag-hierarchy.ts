/**
 * Tag hierarchy resolution from the `tags.parent_names` column.
 *
 * A `tags` row named `voice` with `parent_names = ["manual", "note"]`
 * registers `voice` as a child of `manual` and `note`. Queries that ask for
 * `tags: ["manual"]` then transparently match notes tagged `#voice` (or any
 * other transitive descendant of `#manual`).
 *
 * History: pre-v14 vaults stored hierarchy in notes-as-config at
 * `_tags/<name>`. The v14 migration (see core/src/schema.ts:migrateToV14)
 * lifts those parent declarations onto the tags row and the resolver here
 * was swapped accordingly. See parachute-patterns/patterns/tag-data-model.md.
 *
 * Resolution model:
 * - Lazy: built on first access, cached on the store.
 * - Invalidated synchronously when a tag's parent_names changes (see
 *   `BunSqliteStore.invalidateTagCaches`).
 * - Tags without parent_names are treated as root-level (no parents, no
 *   children). They still match queries by their own name.
 *
 * Cycle handling:
 * - Cycles in declared parents are tolerated at load — we don't reject the
 *   config (we don't have a "fail loud" signal at boot from inside a query).
 *   Descendant traversal uses a visited-set so a cycle can't loop forever;
 *   the resolved descendant set is well-defined regardless.
 */

import { Database } from "bun:sqlite";

export interface TagHierarchy {
  /** tag → set of immediate child tags (those that declared `tag` as a parent). */
  childrenOf: Map<string, Set<string>>;
  /** Memoization cache: tag → set including the tag itself plus all transitive descendants. */
  descendantsCache: Map<string, Set<string>>;
}

/**
 * Pre-v14 path prefix that marked a note as a tag-hierarchy declaration.
 * Retained as an exported constant so call-sites that still need to know
 * about historical `_tags/*` notes (cache-invalidation, importers) can
 * reference a single source of truth.
 */
export const TAG_CONFIG_PREFIX = "_tags/";

/**
 * Decode a JSON-encoded `parent_names` column value, defending against
 * malformed input. Non-string entries are dropped silently — the column
 * is expected to be well-formed (we control all writers) but a single bad
 * row shouldn't break the whole hierarchy resolution.
 */
function readParentNames(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Scan the `tags` table and build the parent→children adjacency map.
 * Each row's `parent_names` JSON array contributes one edge per parent.
 */
export function loadTagHierarchy(db: Database): TagHierarchy {
  const rows = db.prepare(
    `SELECT name, parent_names FROM tags WHERE parent_names IS NOT NULL`,
  ).all() as { name: string; parent_names: string | null }[];

  const childrenOf = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!row.name) continue;
    const parents = readParentNames(row.parent_names);
    for (const parent of parents) {
      let children = childrenOf.get(parent);
      if (!children) {
        children = new Set();
        childrenOf.set(parent, children);
      }
      children.add(row.name);
    }
  }

  return { childrenOf, descendantsCache: new Map() };
}

/**
 * Return the tag plus all transitive descendants. Always includes the tag
 * itself, so callers can use the result as a drop-in replacement for the
 * input tag when expanding queries.
 */
export function getTagDescendants(h: TagHierarchy, tag: string): Set<string> {
  const cached = h.descendantsCache.get(tag);
  if (cached) return cached;

  const result = new Set<string>([tag]);
  const stack = [tag];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const children = h.childrenOf.get(current);
    if (!children) continue;
    for (const child of children) {
      if (result.has(child)) continue;
      result.add(child);
      stack.push(child);
    }
  }

  h.descendantsCache.set(tag, result);
  return result;
}

/**
 * Detect cycles in the declared hierarchy. Returns the list of tags
 * reachable from themselves via parent declarations. Used by
 * `update-tag` write paths to surface a warning to the caller without
 * blocking the write — cycles are tolerated at runtime (descendant
 * traversal uses a visited set), but they're almost always a config bug.
 */
export function findHierarchyCycles(h: TagHierarchy): string[] {
  const cycles: string[] = [];
  for (const tag of h.childrenOf.keys()) {
    const descendants = getTagDescendants(h, tag);
    if (descendants.has(tag) && descendants.size > 1) {
      // tag reaches itself through a non-trivial path
      const ownChildren = h.childrenOf.get(tag);
      if (ownChildren) {
        for (const child of ownChildren) {
          if (getTagDescendants(h, child).has(tag)) {
            cycles.push(tag);
            break;
          }
        }
      }
    }
  }
  return cycles;
}
