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
 * was swapped accordingly. See docs/contracts/tag-data-model.md.
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

/**
 * Canonical-bare-tag guard (vault#XXX). Strip any leading `#` (one or more)
 * from a tag value so a `#`-prefixed tag can never be stored or queried
 * out-of-band. Tags are stored BARE by convention (`agent/message/inbound`,
 * not `#agent/message/inbound`); a client that passes the `#`-decorated form —
 * as the agent module did, persisting `#agent/message/inbound` literally — must
 * land on the same canonical row everyone else queries.
 *
 * Deliberately MINIMAL: this is NOT `normalizeTagValue` (portable-md.ts). It
 * does NOT lowercase, slug-validate, or otherwise transform the value — casing
 * and structure are preserved. The ONLY job is to remove the stray leading `#`.
 *
 * Idempotent: `#tag` / `##tag` / `tag` all collapse to `tag`. Only LEADING `#`
 * is stripped — a `#` mid-string (e.g. `c#`) is left intact. Whitespace is
 * trimmed first so a `" #tag"` from a sloppy client also normalizes. Applied at
 * the canonical chokepoints (note-tag write, query/exclude filters, tag-schema
 * name + parent_names) so MCP, REST, and direct-core callers all converge.
 */
export function stripTagHash(tag: string): string {
  // Strip any LEADING run of `#`/whitespace (handles `#tag`, `##tag`, `  #tag`,
  // and `# tag` with a space after the hash), then trim the tail. A `#`
  // mid-string (`c#`) is untouched; a degenerate `# #` collapses to "" (the
  // write-path empty-tag gate drops it).
  return tag.replace(/^[#\s]+/, "").trim();
}

export interface TagHierarchy {
  /** tag → set of immediate child tags (those that declared `tag` as a parent). */
  childrenOf: Map<string, Set<string>>;
  /** Memoization cache: tag → set including the tag itself plus all transitive descendants. */
  descendantsCache: Map<string, Set<string>>;
  /**
   * Every known tag name in the vault. Loaded once at hierarchy build so the
   * `_default` universal-parent magic in `getTagDescendants` can answer
   * "expand `_default` → every tag" without a second DB scan.
   */
  allTags: Set<string>;
}

/**
 * Reserved tag name treated as the implicit universal parent of every other
 * tag (vault#270). When a row named `_default` exists in the `tags` table,
 * its schema applies to all notes — tagged or not — and tag-hierarchy queries
 * for `_default` expand to the full tag list. The `tags.parent_names` column
 * is never auto-mutated; the universal-parent property lives at resolve time.
 */
export const DEFAULT_TAG_NAME = "_default";

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
 * Also collects every known tag name in `allTags` so the `_default`
 * universal-parent leg in `getTagDescendants` can return the full tag list
 * without a second scan.
 */
export function loadTagHierarchy(db: Database): TagHierarchy {
  const rows = db.prepare(
    `SELECT name, parent_names FROM tags`,
  ).all() as { name: string; parent_names: string | null }[];

  const childrenOf = new Map<string, Set<string>>();
  const allTags = new Set<string>();

  for (const row of rows) {
    if (!row.name) continue;
    allTags.add(row.name);
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

  return { childrenOf, descendantsCache: new Map(), allTags };
}

/**
 * Return the tag plus all transitive descendants. Always includes the tag
 * itself, so callers can use the result as a drop-in replacement for the
 * input tag when expanding queries.
 *
 * Special case: `_default` is treated as the implicit parent of every tag
 * (vault#270). When a row named `_default` exists in the `tags` table, this
 * function returns the full set of known tag names — symmetric with the
 * schema-inheritance model where `_default`'s fields apply to every note.
 * When `_default` is *not* declared as a tag row, the call falls through to
 * normal descendant traversal (which yields just `{_default}` since nothing
 * lists it as a parent).
 */
export function getTagDescendants(h: TagHierarchy, tag: string): Set<string> {
  const cached = h.descendantsCache.get(tag);
  if (cached) return cached;

  if (tag === DEFAULT_TAG_NAME && h.allTags.has(DEFAULT_TAG_NAME)) {
    const universal = new Set<string>(h.allTags);
    h.descendantsCache.set(tag, universal);
    return universal;
  }

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
 * Tag-expansion axis (vault tag `expand` axis — design
 * `design/2026-06-09-tag-expand-axis.md`). A tag relates to others along two
 * orthogonal axes; this selects which one (or both, or neither) a query expands
 * along:
 *
 * - `"subtypes"` (DEFAULT): tag ∪ `parent_names` descendants. The semantic
 *   is-a axis — today's always-on behavior, unchanged. `_default` universal
 *   parent magic fires here.
 * - `"namespace"`: tag ∪ {names lexically prefixed `tag/`}. The organizational
 *   filing axis — purely lexical over the known tag set, no `parent_names`, no
 *   `_default` magic.
 * - `"both"`: union of subtypes and namespace.
 * - `"exact"`: the literal tag only, no expansion.
 */
export type TagExpandMode = "subtypes" | "namespace" | "both" | "exact";

export const TAG_EXPAND_MODES: readonly TagExpandMode[] = [
  "subtypes",
  "namespace",
  "both",
  "exact",
] as const;

export const DEFAULT_TAG_EXPAND_MODE: TagExpandMode = "subtypes";

/**
 * Lexical namespace expansion for a single tag: the tag itself plus every
 * known tag name filed under it (`name === tag` OR `name` starts with
 * `tag + "/"`). Purely a string-prefix match over `h.allTags` — namespacing is
 * free-form (the slash in the tag *name*), declared nowhere, which is the whole
 * point: subtyping is declared via `parent_names`, filing is not. No `_default`
 * magic here — that's a subtypes-axis concept.
 */
export function getTagNamespace(h: TagHierarchy, tag: string): Set<string> {
  // Pre-seeded with `tag` itself, so the loop only needs the strict `tag/*`
  // prefix test (the `name === tag` case is already covered by the seed).
  const result = new Set<string>([tag]);
  const prefix = tag + "/";
  for (const name of h.allTags) {
    if (name.startsWith(prefix)) result.add(name);
  }
  return result;
}

/**
 * Mode-aware single-tag expansion (vault tag `expand` axis). Returns the set of
 * tag names a query for `tag` should match under `mode`. Always includes `tag`
 * itself. Set semantics: a tag that is BOTH a declared subtype-child AND
 * name-prefixed appears once.
 *
 * - `"subtypes"` → `getTagDescendants` (parent_names + `_default` magic).
 * - `"namespace"` → `getTagNamespace` (lexical `tag/*`).
 * - `"both"` → union of the two.
 * - `"exact"` → `{tag}`.
 */
export function getTagExpansion(
  h: TagHierarchy,
  tag: string,
  mode: TagExpandMode,
): Set<string> {
  switch (mode) {
    case "exact":
      return new Set<string>([tag]);
    case "namespace":
      return getTagNamespace(h, tag);
    case "both": {
      const union = new Set<string>(getTagDescendants(h, tag));
      for (const name of getTagNamespace(h, tag)) union.add(name);
      return union;
    }
    case "subtypes":
    default:
      // `default` is a defensive fallback — `TagExpandMode` already constrains
      // the value to the four cases above; it can only be reached if an
      // untyped caller passes a bad string.
      return getTagDescendants(h, tag);
  }
}

/**
 * Suggest the closest EXISTING tag name to an unmatched input — the
 * `did_you_mean` hint on `unknown_tag` warnings (vault#550) and
 * `tag_not_found` errors. Candidates are scored, lower is better:
 *
 *   0. case-only difference (`Voice` vs `voice`)
 *   1. a prefix relationship either direction (`voice` / `voice-memo` —
 *      catches plural/singular drift and namespace-child typos)
 *   2+dist. Levenshtein edit distance, when within a length-scaled budget
 *
 * Returns the single best match, or `undefined` when nothing is close
 * enough to be worth suggesting — a genuinely novel tag name shouldn't get
 * a noisy "did you mean" pointing at an unrelated tag.
 */
export function suggestSimilarTag(
  candidates: Iterable<string>,
  input: string,
): string | undefined {
  const lower = input.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate === input) continue;
    const candLower = candidate.toLowerCase();
    let score: number | null = null;
    if (candLower === lower) {
      score = 0;
    } else if (lower.length >= 2 && candLower.length >= 2 && (candLower.startsWith(lower) || lower.startsWith(candLower))) {
      score = 1;
    } else {
      const dist = levenshtein(lower, candLower);
      const budget = Math.max(2, Math.ceil(Math.min(lower.length, candLower.length) * 0.34));
      if (dist <= budget) score = 2 + dist;
    }
    if (score !== null && score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Classic Levenshtein edit distance, O(m·n) time / O(n) space. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/**
 * Compute, for every declared tag, the number of DISTINCT notes matching
 * that tag OR any transitive descendant under the subtypes axis (vault#550
 * `expanded_count` — the rollup a parent tag whose notes are all tagged
 * with a CHILD tag needs to report a non-zero count).
 *
 * One query fetches every `(tag_name, note_id)` pairing from `note_tags`;
 * the fan-out to ancestors is pure in-memory set work over the (memoized)
 * hierarchy — not one query per tag, so this stays cheap regardless of how
 * many tags the vault declares. `getTagDescendants` is memoized per tag on
 * `h`, so the ancestor-closure build below reuses that cache instead of
 * re-walking the graph per candidate.
 */
export function computeExpandedTagCounts(
  db: Database,
  h: TagHierarchy,
): Map<string, number> {
  const rows = db.prepare(`SELECT tag_name, note_id FROM note_tags`).all() as
    { tag_name: string; note_id: string }[];

  const expandedNotes = new Map<string, Set<string>>();
  const ancestorsCache = new Map<string, string[]>();

  function ancestorsOrSelf(x: string): string[] {
    const cached = ancestorsCache.get(x);
    if (cached) return cached;
    const result: string[] = [];
    for (const t of h.allTags) {
      if (getTagDescendants(h, t).has(x)) result.push(t);
    }
    if (!result.includes(x)) result.push(x);
    ancestorsCache.set(x, result);
    return result;
  }

  for (const row of rows) {
    for (const ancestor of ancestorsOrSelf(row.tag_name)) {
      let set = expandedNotes.get(ancestor);
      if (!set) {
        set = new Set();
        expandedNotes.set(ancestor, set);
      }
      set.add(row.note_id);
    }
  }

  const counts = new Map<string, number>();
  for (const [tag, set] of expandedNotes) counts.set(tag, set.size);
  return counts;
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
