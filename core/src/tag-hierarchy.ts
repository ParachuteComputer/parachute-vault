/**
 * Tag hierarchy resolution from `_tags/<name>` config notes.
 *
 * A note at path `_tags/voice` declaring `metadata.parents = ["manual", "note"]`
 * registers `voice` as a child of `manual` and `note`. Queries that ask for
 * `tags: ["manual"]` then transparently match notes tagged `#voice` (or any
 * other transitive descendant of `#manual`).
 *
 * Why notes-as-config rather than a SQL table:
 * - Vault is note-first. Configuration-as-data is more vault-native.
 * - Users edit the hierarchy with the same tools they use for any other note.
 * - Exports/imports of the vault carry the hierarchy with the content.
 * - Survives DB schema evolution without migrations.
 *
 * Resolution model:
 * - Lazy: built on first access, cached on the store.
 * - Invalidated synchronously when any note at `_tags/*` is created, updated,
 *   or deleted (see `BunSqliteStore.invalidateConfigCaches`).
 * - Tags not declared at `_tags/<name>` are treated as root-level (no parents,
 *   no children). They still match queries by their own name.
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
 * Path prefix that marks a note as a tag-hierarchy declaration. The remainder
 * of the path (after `_tags/`) is the tag name.
 */
export const TAG_CONFIG_PREFIX = "_tags/";

/**
 * Read a `parents` array from a note's metadata, defending against malformed
 * input. Non-string entries are dropped silently — config notes are
 * expected to be well-formed but we don't want a single bad row to break
 * the whole hierarchy resolution.
 */
function readParents(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).parents;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Scan all `_tags/*` notes and build the parent→children adjacency map.
 * The tag name comes from the path suffix (e.g. `_tags/voice` → `voice`).
 */
export function loadTagHierarchy(db: Database): TagHierarchy {
  const rows = db.prepare(
    `SELECT path, metadata FROM notes WHERE path LIKE '_tags/%'`,
  ).all() as { path: string; metadata: string | null }[];

  const childrenOf = new Map<string, Set<string>>();

  for (const row of rows) {
    const tagName = row.path.slice(TAG_CONFIG_PREFIX.length);
    if (!tagName) continue;

    let metadata: unknown = null;
    if (row.metadata && row.metadata !== "{}") {
      try { metadata = JSON.parse(row.metadata); } catch {}
    }
    const parents = readParents(metadata);

    for (const parent of parents) {
      let children = childrenOf.get(parent);
      if (!children) {
        children = new Set();
        childrenOf.set(parent, children);
      }
      children.add(tagName);
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
