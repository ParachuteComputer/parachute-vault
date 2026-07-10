/**
 * The `warnings: []` channel (vault#550 — Reliability & Usability Program
 * WS1, "honest queries"). Ratified principle: if the vault can still answer
 * the question asked, answer it and attach a warning; if it would answer a
 * DIFFERENT question, return a structured named error. Silence is never the
 * third option.
 *
 * This module owns the ONE validated choke point for `unknown_tag`
 * warnings — both the REST structured-query path (`src/routes.ts`) and the
 * MCP `query-notes` tool call into `collectUnknownTagWarnings` so the two
 * surfaces can't drift. REST-only warnings (`removed_param` — a REST query
 * string concept with no MCP analog) stay in `src/routes.ts`.
 *
 * Tag-scope note (security review): this module is deliberately
 * SCOPE-UNAWARE — `collectUnknownTagWarnings` always resolves against the
 * full vault-wide tag catalog, exactly like `core/src/notes.ts:queryNotes`
 * itself. Callers on a tag-scoped session MUST NOT surface these warnings
 * (or must first narrow the candidate pool) — `did_you_mean` naming an
 * out-of-scope tag would leak its existence across the scope boundary,
 * which this codebase treats as a hard "no leak" invariant elsewhere (see
 * `docs/contracts/tag-scoped-tokens.md`). `src/routes.ts` skips this call
 * entirely for scoped sessions; `src/mcp-tools.ts`'s `query-notes` wrapper
 * strips any `warnings` core computed before returning to a scoped caller.
 */

import { Database } from "bun:sqlite";
import {
  DEFAULT_TAG_EXPAND_MODE,
  getTagExpansion,
  loadTagHierarchy,
  stripTagHash,
  suggestSimilarTag,
  type TagExpandMode,
  type TagHierarchy,
} from "./tag-hierarchy.js";
import { chunkForInClause } from "./sql-in.js";

export interface QueryWarning {
  code: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Cap on `unknown_tag` warnings per query (vault#550 fold). A caller
 * passing a garbage `tags` array (hundreds of junk names) would otherwise
 * inflate the response — and the REST `X-Parachute-Warnings` header —
 * unboundedly. Past the cap, a single `warnings_truncated` entry reports
 * how many were suppressed.
 */
export const MAX_UNKNOWN_TAG_WARNINGS = 8;

/**
 * Membership counts for a specific set of candidate tag names — NOT a
 * full `listTags()` vault-wide scan. `listTags` additionally computes
 * `expanded_count` (a full `note_tags` pass over EVERY tag, vault#550),
 * which this function deliberately avoids: `collectUnknownTagWarnings` runs
 * on every tag-filtered structured query (a hot path), so paying for a
 * vault-wide rollup just to answer "does tag X have ANY notes" would be a
 * real perf regression. This scopes the `note_tags` scan to only the
 * (typically small) set of names actually reachable from the query's own
 * tag filter and its expansion.
 */
function countMembership(db: Database, names: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  if (names.size === 0) return counts;
  for (const chunk of chunkForInClause([...names])) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.prepare(
      `SELECT tag_name, COUNT(*) as c FROM note_tags WHERE tag_name IN (${placeholders}) GROUP BY tag_name`,
    ).all(...chunk) as { tag_name: string; c: number }[];
    for (const row of rows) counts.set(row.tag_name, row.c);
  }
  return counts;
}

/**
 * Warn on each literal tag name in a `tags` filter that can contribute
 * NOTHING to the result set no matter what — the caller almost certainly
 * mistyped it, or is thinking of a different vault. A tag survives (no
 * warning) if ANY of the following holds:
 *
 *   - it has its own identity row (a `tags` table entry — created via
 *     `update-tag` or implicitly by tagging a note), OR
 *   - at least one note literally carries that tag, OR
 *   - its mode-aware expansion (subtypes/namespace/both/exact — whatever
 *     the query's `expand` axis resolves to) contains at least one tag
 *     name that itself has notes.
 *
 * `did_you_mean` names the closest existing tag (case variant, prefix
 * relationship, or small edit distance) when one exists — see
 * `suggestSimilarTag`.
 *
 * Scoped to the POSITIVE `tags` filter only — `excludeTags` is not
 * checked (excluding a nonexistent tag is a harmless no-op, not a sign of
 * a mistaken query) and this does not run under `search=` (out of scope
 * for this wave — see #551).
 *
 * Perf shape (vault#550 fold): this runs on EVERY tag-filtered structured
 * query, so the common all-tags-known case must cost ~nothing. Pass the
 * store's cached `hierarchy` (`Store.getTagHierarchy()` — invalidated on
 * tag writes) so no fresh `tags`-table scan happens per request; the
 * `note_tags` membership query below only runs for input tags MISSING
 * from the identity set (`h.allTags`), which for a well-formed query is
 * none — a tag with an identity row can never warn (`hasIdentity`
 * short-circuits), so there's nothing to look up. The `hierarchy` param
 * stays optional for direct-core callers/tests (falls back to a fresh
 * load).
 */
export function collectUnknownTagWarnings(
  db: Database,
  tags: string[] | undefined,
  expandMode: TagExpandMode | undefined,
  hierarchy?: TagHierarchy,
): QueryWarning[] {
  if (!tags || tags.length === 0) return [];

  const h = hierarchy ?? loadTagHierarchy(db);
  const mode = expandMode ?? DEFAULT_TAG_EXPAND_MODE;

  // Fast path: dedupe inputs and drop every tag with an identity row —
  // those can never warn. For a well-formed query this empties the list
  // and we return without touching the DB at all.
  const suspects: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = stripTagHash(raw);
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    if (h.allTags.has(tag)) continue; // identity row → never unknown
    suspects.push(tag);
  }
  if (suspects.length === 0) return [];

  // Slow path (only for identity-less names): pre-compute each suspect's
  // expansion set (memoized on `h.descendantsCache` — safe to share with
  // the store's cache, entries are pure derived state) so the membership
  // check is ONE batched IN-list query over the union, not one per tag.
  // An identity-less tag can still be "known" two ways: a `note_tags` row
  // exists without a `tags` row (not produced by current writers, but
  // contract-tolerated), or children declared it a parent (`childrenOf`
  // edges exist for undeclared parents) and a descendant has notes.
  const expansions = new Map<string, Set<string>>();
  for (const tag of suspects) expansions.set(tag, getTagExpansion(h, tag, mode));
  const candidateNames = new Set<string>();
  for (const set of expansions.values()) for (const name of set) candidateNames.add(name);
  const counts = countMembership(db, candidateNames);

  const warnings: QueryWarning[] = [];
  let suppressed = 0;
  for (const tag of suspects) {
    const hasOwnMembership = (counts.get(tag) ?? 0) > 0;
    let hasExpansionMembers = false;
    for (const t of expansions.get(tag)!) {
      if ((counts.get(t) ?? 0) > 0) {
        hasExpansionMembers = true;
        break;
      }
    }

    if (!hasOwnMembership && !hasExpansionMembers) {
      if (warnings.length >= MAX_UNKNOWN_TAG_WARNINGS) {
        suppressed++;
        continue;
      }
      const suggestion = suggestSimilarTag(h.allTags, tag);
      warnings.push({
        code: "unknown_tag",
        message: `tag "${tag}" has no identity row and no notes match it (directly or via expansion) — check spelling, or create it first with update-tag`,
        tag,
        ...(suggestion ? { did_you_mean: suggestion } : {}),
      });
    }
  }
  if (suppressed > 0) {
    warnings.push({
      code: "warnings_truncated",
      message: `${suppressed} additional unknown_tag warning(s) suppressed — at most ${MAX_UNKNOWN_TAG_WARNINGS} are reported per query.`,
      suppressed,
      limit: MAX_UNKNOWN_TAG_WARNINGS,
    });
  }
  return warnings;
}
