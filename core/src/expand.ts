/**
 * Inline expansion of [[wikilinks]] in note content.
 *
 * Used by `query-notes` when `expand_links=true`. Replaces wikilink matches
 * with delimited blocks containing the linked note's content (full mode) or
 * a summary (summary mode): `metadata.summary` when present, else the
 * target note's lede (see `summaryText`). Deduplicates across the query and
 * guards against cycles via a shared `expanded` set.
 */

import { Database } from "bun:sqlite";
import type { Note } from "./types.js";
import * as noteOps from "./notes.js";
import { resolveWikilink } from "./wikilinks.js";

export type ExpandMode = "full" | "summary";

export const DEFAULT_EXPAND_DEPTH = 1;
export const MAX_EXPAND_DEPTH = 3;

export interface ExpandContext {
  db: Database;
  mode: ExpandMode;
  /** Note IDs already expanded in this query. Shared across all expansions. */
  expanded: Set<string>;
  /**
   * Optional visibility predicate (tag-scope confidentiality, vault security
   * review). When set and it returns `false` for a resolved target note, the
   * wikilink is left UNRESOLVED — byte-identical to the not-found/unresolved
   * branch, so an out-of-scope target is indistinguishable from a missing one
   * (we never reveal existence differently across the scope boundary).
   *
   * Core stays scope-unaware: the server constructs this predicate from its
   * tag-scope machinery and injects it; core only ever *calls* it. When
   * unset (every unscoped caller), expansion behaves exactly as before.
   *
   * Applied at every hop — multi-hop (`expand_depth > 1`) expansion runs the
   * predicate on each resolved target before inlining, so a deep chain can't
   * tunnel out-of-scope content through an in-scope intermediary.
   */
  isVisible?: (note: Note) => boolean;
}

/**
 * Matches wikilinks the same way the parser does — but retains positions.
 * Embeds (`![[...]]`) are treated as regular links here; the `!` is discarded
 * in the expansion output. If embed-specific rendering is needed later,
 * inspect the first capture group.
 */
const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

/**
 * Expand wikilinks in `content` up to `remainingDepth` levels deep. Returns
 * content with `<expanded>` blocks replacing each wikilink occurrence.
 *
 * `remainingDepth` counts down: when it reaches 0, no further expansion
 * happens. A call with remainingDepth=1 expands top-level wikilinks only;
 * wikilinks inside those expansions are left as-is.
 *
 * Wikilinks inside fenced or inline code blocks are left untouched — mirrors
 * the behavior of `parseWikilinks` in `wikilinks.ts` so the link graph and
 * the expansion view stay consistent.
 */
export function expandContent(
  content: string,
  ctx: ExpandContext,
  remainingDepth: number,
): string {
  if (remainingDepth <= 0) return content;

  const codeSkip = codeRanges(content);

  return content.replace(WIKILINK_RE, (match, _bang: string, inner: string, offset: number) => {
    if (inCodeRange(offset, codeSkip)) return match;

    const target = parseTarget(inner);
    if (!target) return match;

    const noteId = resolveWikilink(ctx.db, target);
    if (!noteId) return match; // unresolved or ambiguous — leave as-is

    // Resolve the target BEFORE the dedup check so the visibility gate can run
    // first — an out-of-scope target must never enter `expanded` (otherwise a
    // second reference to it would render `(expanded above)` and leak its
    // existence via a different output than a genuinely-missing target).
    const note = noteOps.getNote(ctx.db, noteId);
    if (!note) return match; // shouldn't happen, but be safe

    // Tag-scope confidentiality (vault security review): if a visibility
    // predicate is installed and the resolved target is out of scope, leave
    // the wikilink UNRESOLVED — byte-identical to the not-found / unresolved
    // branches above. The out-of-scope case must be indistinguishable from a
    // missing target so the response can't leak the target's existence. Runs
    // at every hop, so multi-hop expansion can't tunnel out-of-scope content.
    if (ctx.isVisible && !ctx.isVisible(note)) return match;

    if (ctx.expanded.has(noteId)) {
      return `${match} (expanded above)`;
    }
    ctx.expanded.add(noteId);

    if (ctx.mode === "summary") {
      // Summary mode doesn't recurse: depth > 1 has no additional effect.
      return renderSummary(note);
    }

    // Full mode — expand nested wikilinks one less level deep.
    const nested = expandContent(note.content, ctx, remainingDepth - 1);
    return renderFull(note, nested);
  });
}

function codeRanges(content: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fenced = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(content)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(content)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function inCodeRange(pos: number, ranges: [number, number][]): boolean {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) return true;
  }
  return false;
}

function parseTarget(inner: string): string | null {
  // Strip display alias: "target|display" → "target"
  const pipeIdx = inner.indexOf("|");
  let targetPart = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
  // Strip anchor/block-ref: "target#heading" → "target"
  const hashIdx = targetPart.indexOf("#");
  if (hashIdx !== -1) targetPart = targetPart.slice(0, hashIdx);
  const target = targetPart.trim();
  return target || null;
}

function renderFull(note: Note, content: string): string {
  const pathAttr = escapeAttr(note.path ?? note.id);
  return `<expanded path="${pathAttr}" mode="full">\n${content}\n</expanded>`;
}

function renderSummary(note: Note): string {
  const pathAttr = escapeAttr(note.path ?? note.id);
  const summary = summaryText(note);
  return `<expanded path="${pathAttr}" mode="summary">\n${summary}\n</expanded>`;
}

/**
 * `metadata.summary` wins when present (no behavior change for existing
 * callers). Absent it, falls back to the target note's lede — its opening
 * paragraph, per `computeLede` — so a note that was never given a
 * `metadata.summary` still yields something useful in summary-mode
 * expansion instead of an empty block.
 */
function summaryText(note: Note): string {
  const meta = note.metadata as Record<string, unknown> | undefined;
  const s = meta?.summary;
  if (typeof s === "string" && s.trim()) return s.trim();
  return noteOps.computeLede(note.content) ?? "";
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
