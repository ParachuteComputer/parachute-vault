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
} from "./tag-hierarchy.js";
import { chunkForInClause } from "./sql-in.js";

export interface QueryWarning {
  code: string;
  message: string;
  [key: string]: unknown;
}

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
 */
export function collectUnknownTagWarnings(
  db: Database,
  tags: string[] | undefined,
  expandMode: TagExpandMode | undefined,
): QueryWarning[] {
  if (!tags || tags.length === 0) return [];

  const h = loadTagHierarchy(db);
  const mode = expandMode ?? DEFAULT_TAG_EXPAND_MODE;

  // Dedupe inputs and pre-compute each one's expansion set (memoized via
  // `h.descendantsCache` for the subtypes axis) BEFORE hitting the DB, so
  // the membership query below can be a single batched IN-list over the
  // union rather than one query per input tag.
  const cleanedInputs: string[] = [];
  const expansions = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = stripTagHash(raw);
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    cleanedInputs.push(tag);
    expansions.set(tag, getTagExpansion(h, tag, mode));
  }
  if (cleanedInputs.length === 0) return [];

  const candidateNames = new Set<string>();
  for (const set of expansions.values()) for (const name of set) candidateNames.add(name);
  const counts = countMembership(db, candidateNames);

  const warnings: QueryWarning[] = [];
  for (const tag of cleanedInputs) {
    const hasIdentity = h.allTags.has(tag);
    const hasOwnMembership = (counts.get(tag) ?? 0) > 0;
    let hasExpansionMembers = false;
    for (const t of expansions.get(tag)!) {
      if ((counts.get(t) ?? 0) > 0) {
        hasExpansionMembers = true;
        break;
      }
    }

    if (!hasIdentity && !hasOwnMembership && !hasExpansionMembers) {
      const suggestion = suggestSimilarTag(h.allTags, tag);
      warnings.push({
        code: "unknown_tag",
        message: `tag "${tag}" has no identity row and no notes match it (directly or via expansion) — check spelling, or create it first with update-tag`,
        tag,
        ...(suggestion ? { did_you_mean: suggestion } : {}),
      });
    }
  }
  return warnings;
}
