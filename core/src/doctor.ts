/**
 * `vault doctor` — read-only taxonomy/metadata integrity scan (vault#552).
 *
 * NOT to be confused with `parachute-vault doctor` (the CLI's install/daemon
 * diagnostic in `src/cli.ts` — port reachability, config sanity, launchd/
 * systemd registration). This module answers a different question: "did my
 * tag reorg (rename/merge/delete) leak?" It never auto-fixes — every finding
 * carries a suggested `remedy` the caller applies deliberately (usually via
 * `rename-tag`/`merge-tags`/`prune-schema`/another `update-tag` call).
 *
 * Scans:
 *   - `dangling_parent_name`   — a `parent_names` entry naming a tag with no
 *     identity row.
 *   - `parent_names_cycle`     — a tag that reaches itself through its
 *     declared ancestor chain (traversal is cycle-safe; this just SURFACES
 *     data that predates the vault#552 write-time cycle guard, or was
 *     written by a path that bypasses it).
 *   - `mixed_type_indexed_field` — a note whose `metadata.<field>` JSON type
 *     disagrees with the field's declared indexed sqlite type. This is the
 *     WS4 typed-index "poison precursor": inconsistent column affinity
 *     coercion silently breaks ordering/comparison across rows. The finding
 *     shape here is intentionally reusable as WS4's migration pre-flight.
 *   - `orphaned_indexed_field_declarer` — an `indexed_fields` row naming a
 *     declarer tag with no `tags` row (overlaps `prune-schema`, which is the
 *     suggested remedy).
 *   - `dead_tag_metadata_reference` — HEURISTIC, always labeled `heuristic:
 *     true`. A metadata key is used elsewhere in the vault with values that
 *     ARE live tag names (establishing "this key holds tag-shaped values");
 *     a value under the same key that does NOT match any live tag is
 *     flagged as a possible stale reference to a renamed/merged/deleted tag
 *     — the PM's `metadata.epic` drift class from the #552 write-up. Vault
 *     has no history of past tag names, so this can never be certain —
 *     hence heuristic.
 *
 * Tag-scope (vault#552): pass `allowedTags` (the caller's EXPANDED
 * allowlist, e.g. from `expandTokenTagScope`) to restrict every finding to
 * in-scope tags/fields/notes. `null` (or omitted) — the default — scans the
 * whole vault. The scan is re-run with the allowlist rather than filtering
 * an unscoped result afterward, so the `summary` counts never leak
 * out-of-scope activity.
 */

import { Database } from "bun:sqlite";
import { loadTagHierarchy, findHierarchyCycles } from "./tag-hierarchy.js";
import { listIndexedFields } from "./indexed-fields.js";
import { pruneOrphanedIndexedFields } from "./indexed-fields.js";

export type DoctorFindingType =
  | "dangling_parent_name"
  | "parent_names_cycle"
  | "mixed_type_indexed_field"
  | "orphaned_indexed_field_declarer"
  | "dead_tag_metadata_reference";

export type DoctorSeverity = "error" | "warning" | "info";

export interface DoctorFinding {
  type: DoctorFindingType;
  severity: DoctorSeverity;
  /** The tag / field / metadata-key this finding is about. */
  subject: string;
  detail: string;
  remedy: string;
  /**
   * True ONLY for `dead_tag_metadata_reference` — flags the finding as a
   * best-effort inference (no tag-rename history exists to confirm it),
   * never present (not even `false`) on the other, structurally-certain
   * finding types.
   */
  heuristic?: true;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  summary: string;
  scanned_at: string;
}

export interface DoctorScanOpts {
  /**
   * The caller's expanded tag allowlist (root ∪ descendants). `null`
   * (default) scans the whole vault. See the module doc comment for how
   * each finding type is scoped.
   */
  allowedTags?: Set<string> | null;
}

/** Cap on exemplar note IDs embedded in a finding's `detail` (vault#552 — keep report bodies bounded). */
const MAX_EXEMPLARS = 5;

/**
 * Build a per-note in-scope predicate for a tag-scoped doctor run (vault#552
 * auth fold). A note is in-scope iff at least one of its tags is in
 * `allowedTags`; an unscoped run (`allowedTags === null`) treats every note
 * as in-scope. Caches each note's tag lookup so repeated checks across scans
 * cost one query per note. Shared by the mixed-type-indexed-field and
 * dead-tag-metadata scans, both of which query notes vault-wide and must NOT
 * surface an out-of-scope note id (or count, or exemplar) to a scoped caller.
 */
function makeNoteInScope(db: Database, allowedTags: Set<string> | null): (id: string) => boolean {
  if (!allowedTags) return () => true;
  const cache = new Map<string, boolean>();
  return (id: string): boolean => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const tags = (db.prepare("SELECT tag_name FROM note_tags WHERE note_id = ?").all(id) as { tag_name: string }[]).map((r) => r.tag_name);
    const inScope = tags.some((t) => allowedTags.has(t));
    cache.set(id, inScope);
    return inScope;
  };
}

export function runDoctorScan(db: Database, opts?: DoctorScanOpts): DoctorReport {
  const allowedTags = opts?.allowedTags ?? null;
  const findings: DoctorFinding[] = [
    ...scanDanglingParentNames(db, allowedTags),
    ...scanParentNamesCycles(db, allowedTags),
    ...scanMixedTypeIndexedFields(db, allowedTags),
    ...scanOrphanedIndexedFieldDeclarers(db, allowedTags),
    ...scanDeadTagMetadataReferences(db, allowedTags),
  ];

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const infos = findings.filter((f) => f.severity === "info").length;
  const summary =
    findings.length === 0
      ? "clean — no integrity findings"
      : `${findings.length} finding(s): ${errors} error(s), ${warnings} warning(s), ${infos} info(s)`;

  return { findings, summary, scanned_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// A. dangling parent_names
// ---------------------------------------------------------------------------

function scanDanglingParentNames(db: Database, allowedTags: Set<string> | null): DoctorFinding[] {
  const rows = db
    .prepare("SELECT name, parent_names FROM tags WHERE parent_names IS NOT NULL")
    .all() as { name: string; parent_names: string }[];
  const allTags = new Set(
    (db.prepare("SELECT name FROM tags").all() as { name: string }[]).map((r) => r.name),
  );

  const findings: DoctorFinding[] = [];
  for (const row of rows) {
    if (allowedTags && !allowedTags.has(row.name)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.parent_names); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const parent of parsed) {
      if (typeof parent !== "string" || parent.length === 0) continue;
      if (allTags.has(parent)) continue;
      findings.push({
        type: "dangling_parent_name",
        severity: "warning",
        subject: row.name,
        detail: `tag "${row.name}" declares parent "${parent}", which has no identity row — a typo, a tag that was never created, or a rename/delete that didn't update this reference.`,
        remedy: `remove "${parent}" from "${row.name}"'s parent_names (update-tag), or create the missing "${parent}" tag if it's meant to exist`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// B. parent_names cycles (pre-existing data — the write-time guard blocks
//    NEW ones; this surfaces anything already on disk)
// ---------------------------------------------------------------------------

function scanParentNamesCycles(db: Database, allowedTags: Set<string> | null): DoctorFinding[] {
  const hierarchy = loadTagHierarchy(db);
  const cycles = findHierarchyCycles(hierarchy);
  const findings: DoctorFinding[] = [];
  for (const tag of cycles) {
    if (allowedTags && !allowedTags.has(tag)) continue;
    findings.push({
      type: "parent_names_cycle",
      severity: "error",
      subject: tag,
      detail: `tag "${tag}" reaches itself through its declared parent_names ancestor chain. Query expansion tolerates this (a visited-set stops it looping), but it's confusing hierarchy state.`,
      remedy: `clear or correct parent_names on one of the tags in "${tag}"'s ancestor chain (update-tag) to break the cycle`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// C. mixed-type values in an indexed column (WS4 poison precursor)
// ---------------------------------------------------------------------------

/** `json_type()` results consistent with each declared indexed sqlite storage class. */
const EXPECTED_JSON_TYPES: Record<string, Set<string>> = {
  INTEGER: new Set(["integer", "real", "true", "false"]),
  TEXT: new Set(["text"]),
};

/** One vault-wide-scan result row from {@link findMixedTypeIndexedFieldNotes}. */
export interface MixedTypeIndexedFieldRow {
  id: string;
  /** SQLite `json_type()` of the CURRENT `metadata.<field>` value — "text", "integer", "real", "true", "false", "array", "object" (never "null": absent/null keys are excluded upstream). */
  jt: string;
}

/**
 * Vault-wide detector: every note whose `metadata.<field>` JSON type
 * disagrees with `sqliteType` (the field's declared indexed storage class —
 * "INTEGER" or "TEXT"). Returns `[]` for an unknown `sqliteType` or when
 * nothing mismatches. UNSCOPED — no tag-scope filtering (that's the caller's
 * job; see `scanMixedTypeIndexedFields` below for the tag-scoped doctor
 * finding, and `migrateToV24` in `core/src/schema.ts` for the unscoped
 * migration consumer). `json_type(metadata, ?)` returns NULL when the key is
 * absent — those notes simply don't declare the field and aren't a mismatch.
 *
 * Extracted (vault#553 Decision D) so the SAME detection query backs both
 * the `mixed_type_indexed_field` doctor finding AND the `migrateToV24`
 * startup migration's poison scan — one source of truth for "what counts as
 * mismatched," so a fix to one can't silently diverge from the other.
 */
export function findMixedTypeIndexedFieldNotes(
  db: Database,
  field: string,
  sqliteType: string,
): MixedTypeIndexedFieldRow[] {
  const expected = EXPECTED_JSON_TYPES[sqliteType];
  if (!expected) return []; // unknown sqlite_type — nothing to compare against
  const path = `$."${field}"`;
  const rows = db
    .prepare(
      `SELECT id, json_type(metadata, ?) as jt FROM notes WHERE metadata IS NOT NULL AND metadata != '' AND json_valid(metadata)`,
    )
    .all(path) as { id: string; jt: string | null }[];
  return rows.filter((r): r is MixedTypeIndexedFieldRow => r.jt !== null && !expected.has(r.jt));
}

function scanMixedTypeIndexedFields(db: Database, allowedTags: Set<string> | null): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const noteInScope = makeNoteInScope(db, allowedTags);
  for (const f of listIndexedFields(db)) {
    if (allowedTags && !f.declarerTags.some((t) => allowedTags.has(t))) continue;

    const rows = findMixedTypeIndexedFieldNotes(db, f.field, f.sqliteType);
    if (rows.length === 0) continue;

    // Tag-scope (vault#552 auth fold): the note query above is vault-wide —
    // filter mismatches to IN-SCOPE notes so a scoped caller never sees an
    // out-of-scope note id (nor a count/exemplar reflecting one). If every
    // mismatch is on an out-of-scope note, the finding is dropped entirely.
    const mismatches = rows.filter((r) => noteInScope(r.id));
    if (mismatches.length === 0) continue;

    // Also generalize the "Declared by" list to in-scope declarers only —
    // the field can be co-declared by an out-of-scope tag whose name must
    // not leak (the caller sees this field only via its in-scope declarer).
    const visibleDeclarers = allowedTags
      ? f.declarerTags.filter((t) => allowedTags.has(t))
      : f.declarerTags;
    const exemplars = mismatches.slice(0, MAX_EXEMPLARS).map((r) => `${r.id} (${r.jt})`);
    findings.push({
      type: "mixed_type_indexed_field",
      severity: "error",
      subject: f.field,
      detail: `field "${f.field}" is indexed as ${f.sqliteType} but ${mismatches.length} note(s) carry a metadata."${f.field}" value of a disagreeing JSON type — the generated column's affinity coercion makes ordering/filtering across these rows inconsistent. Declared by: ${visibleDeclarers.join(", ") || "(no live declarer)"}. Example note(s): ${exemplars.join(", ")}${mismatches.length > exemplars.length ? ", …" : ""}`,
      remedy: `backfill each listed note's metadata."${f.field}" to a value matching the declared type, or relax the field's declared type (update-tag) if the mixed values are intentional`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// D. orphaned indexed_fields declarers (overlaps prune-schema)
// ---------------------------------------------------------------------------

function scanOrphanedIndexedFieldDeclarers(db: Database, allowedTags: Set<string> | null): DoctorFinding[] {
  const plan = pruneOrphanedIndexedFields(db, { dryRun: true });
  const findings: DoctorFinding[] = [];
  for (const p of plan) {
    if (allowedTags && !p.deadDeclarers.some((t) => allowedTags.has(t))) {
      // Dead declarer names never survive `allowedTags` (it's derived from
      // LIVE tags only) — this branch exists for completeness; in practice
      // a scoped caller only sees this finding when the report is unscoped.
      continue;
    }
    findings.push({
      type: "orphaned_indexed_field_declarer",
      severity: p.dropped ? "warning" : "info",
      subject: p.field,
      detail: p.dropped
        ? `field "${p.field}" has NO surviving live declarer (dead: ${p.deadDeclarers.join(", ")}) — the generated column + index are stale and will be dropped on next prune (metadata values are never lost, only the index).`
        : `field "${p.field}" has dead declarer tag(s) [${p.deadDeclarers.join(", ")}] still listed alongside live ones — cosmetic, no functional impact.`,
      remedy: `run the prune-schema tool (apply: true) to drop the dead declarer(s)${p.dropped ? " and the now-unreferenced column/index" : ""}`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// E. metadata values equal to a tag name that no longer exists (heuristic)
// ---------------------------------------------------------------------------

function scanDeadTagMetadataReferences(db: Database, allowedTags: Set<string> | null): DoctorFinding[] {
  const liveTags = new Set(
    (db.prepare("SELECT name FROM tags").all() as { name: string }[]).map((r) => r.name),
  );

  const rows = db
    .prepare("SELECT id, metadata FROM notes WHERE metadata IS NOT NULL AND metadata != ''")
    .all() as { id: string; metadata: string }[];

  // key -> value -> note ids carrying that (key, value) pair.
  const byKey = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.metadata); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" || value.length === 0) continue;
      let valueMap = byKey.get(key);
      if (!valueMap) { valueMap = new Map(); byKey.set(key, valueMap); }
      let ids = valueMap.get(value);
      if (!ids) { ids = []; valueMap.set(value, ids); }
      ids.push(row.id);
    }
  }

  // Tag-scope (vault#552 auth fold): a note is in-scope iff at least one of
  // its tags is in `allowedTags` (unscoped → every note in-scope).
  const noteInScope = makeNoteInScope(db, allowedTags);

  const findings: DoctorFinding[] = [];
  for (const [key, valueMap] of byKey) {
    // Signal: does this metadata key hold tag-shaped values on IN-SCOPE
    // notes? Computed over in-scope notes ONLY (not vault-wide) so the
    // example live value quoted in `detail` can never leak an out-of-scope
    // tag name — a scoped caller must not learn a tag exists just because a
    // note it can't see uses it as a metadata value. Only flag mismatches
    // under a key that demonstrably holds tag-shaped values in-scope.
    const liveValuesInScope = [...valueMap.entries()]
      .filter(([v, ids]) => liveTags.has(v) && ids.some(noteInScope))
      .map(([v]) => v);
    if (liveValuesInScope.length === 0) continue;

    for (const [value, noteIds] of valueMap) {
      if (liveTags.has(value)) continue;
      const inScopeIds = noteIds.filter(noteInScope);
      if (inScopeIds.length === 0) continue;
      const exemplars = inScopeIds.slice(0, MAX_EXEMPLARS);
      findings.push({
        type: "dead_tag_metadata_reference",
        severity: "info",
        subject: `metadata.${key}`,
        detail: `${inScopeIds.length} note(s) carry metadata.${key} = "${value}", which matches no current tag — other notes' metadata.${key} values ARE live tags (e.g. "${liveValuesInScope[0]}"), suggesting "${value}" may be a stale reference to a tag that was renamed, merged, or deleted. Example note(s): ${exemplars.join(", ")}${inScopeIds.length > exemplars.length ? ", …" : ""}`,
        remedy: `if "${value}" was renamed/merged/deleted, update these notes' metadata.${key} to the current tag name; if "${value}" was never a tag, ignore this finding`,
        heuristic: true,
      });
    }
  }
  return findings;
}
