/**
 * Schema conformance check — count how many EXISTING notes would violate a
 * PROPOSED field spec for a tag, before the operator commits a tightening
 * (vault#283, the MW2/#314 tie-in).
 *
 * Motivation: marking a field `strict`/`required`, narrowing an `enum`, or
 * changing a `type` is a backwards-incompatible move — notes written under
 * the old contract may now reject on their next write
 * (`enforceStrictSchema` → `SchemaValidationError`). The Schema editor in
 * the admin SPA calls this BEFORE save so the operator sees "N existing
 * notes violate this — they'll reject on next write" and is pointed at the
 * `parachute-vault schema migrate-field` CLI (#314) rather than silently
 * shipping a contract their own data breaks.
 *
 * What "violate" means here: we overlay the PROPOSED `fields` for `tag` on
 * top of the live schema config, treating every proposed field as if it
 * were `strict:true` for the purpose of the count (so the count is "notes
 * that would hard-reject IF this field were strict" — the worst case the
 * operator is being warned about). We then walk every note carrying `tag`
 * (descendants included, per the hierarchy) and run the SAME `validateNote`
 * resolver the write path uses, counting notes with ≥1 violation on a field
 * the proposal touches.
 *
 * This is a READ — no mutation. It's deliberately scoped to the proposed
 * tag's own fields (the columns the operator is editing); inherited fields
 * from ancestors are already enforced and aren't what the operator is
 * tightening in this edit.
 */

import { Database } from "bun:sqlite";
import {
  loadSchemaConfig,
  validateNote,
  type SchemaField,
  type ResolvedSchemas,
} from "./schema-defaults.ts";
import type { TagFieldSchema } from "./tag-schemas.ts";
import { getTagDescendants, loadTagHierarchy } from "./tag-hierarchy.ts";
import { getNotes, getNoteTagsForNotes } from "./notes.ts";
import { chunkForInClause } from "./sql-in.ts";

export interface ConformanceViolation {
  /** Note id of a non-conforming note. */
  id: string;
  /** Note path, when set (helps the operator find it). */
  path?: string | null;
  /** The proposed-field violations on this note (reasons + messages). */
  fields: { field: string; reason: string; message: string }[];
}

export interface ConformanceReport {
  tag: string;
  /** Total notes carrying the tag (descendants included). */
  total_notes: number;
  /** Count of notes that would violate the proposed spec. */
  violating_notes: number;
  /** The field names the proposal touches (the ones checked). */
  checked_fields: string[];
  /**
   * A bounded sample of violating notes (id + path + which fields), so the
   * SPA can show examples without paging the whole vault. Capped at
   * `sampleLimit` (default 20).
   */
  sample: ConformanceViolation[];
}

/**
 * Convert the on-disk `TagFieldSchema` shape to the resolver's `SchemaField`
 * shape, FORCING `strict:true` so `validateNote` flags every constraint as a
 * (strict) violation we can count. `indexed` is dropped — it's not a
 * note-data constraint. `type` is narrowed to the resolver's union; an
 * unknown type string is dropped (no type check) rather than throwing.
 */
function toStrictSchemaField(spec: TagFieldSchema): SchemaField {
  const out: SchemaField = { strict: true };
  if (
    spec.type === "string" ||
    spec.type === "number" ||
    spec.type === "integer" ||
    spec.type === "boolean" ||
    spec.type === "array" ||
    spec.type === "object" ||
    spec.type === "date"
  ) {
    out.type = spec.type;
  }
  if (Array.isArray(spec.enum)) out.enum = spec.enum;
  if (spec.required === true) out.required = true;
  if (spec.cardinality === "one" || spec.cardinality === "many") {
    out.cardinality = spec.cardinality;
  }
  if (typeof spec.description === "string") out.description = spec.description;
  return out;
}

/**
 * Build a `ResolvedSchemas` snapshot with the proposed fields overlaid on
 * `tag`'s OWN field map. We start from the live config (so inheritance +
 * other tags are intact) and replace just `tag`'s field declarations with
 * the strict-forced proposed set.
 */
function overlayProposedSchema(
  base: ResolvedSchemas,
  tag: string,
  proposedFields: Record<string, TagFieldSchema>,
): ResolvedSchemas {
  const tagToFields = new Map(base.tagToFields);
  const forced: Record<string, SchemaField> = {};
  for (const [name, spec] of Object.entries(proposedFields)) {
    forced[name] = toStrictSchemaField(spec);
  }
  if (Object.keys(forced).length > 0) {
    tagToFields.set(tag, forced);
  } else {
    tagToFields.delete(tag);
  }
  return {
    allTags: new Set(base.allTags).add(tag),
    tagToFields,
    tagToParents: base.tagToParents,
  };
}

/**
 * Count existing notes that would violate the PROPOSED field spec for `tag`.
 *
 * `proposedFields` is the full merged field map the operator intends to save
 * (the same object the PUT body carries). Only the fields in this map are
 * checked — the violation count answers "if I tighten THESE fields, how many
 * notes break?" The check runs against every note carrying `tag` or any of
 * its descendants.
 *
 * Pure read; no mutation. Returns 0 violating notes when `proposedFields` is
 * empty (nothing to enforce).
 *
 * The walk is UNBOUNDED — every note carrying the tag or a descendant, not a
 * `queryNotes` page (vault#592). `total_notes` is a real total.
 */
export function countConformanceViolations(
  db: Database,
  tag: string,
  proposedFields: Record<string, TagFieldSchema>,
  opts: { sampleLimit?: number } = {},
): ConformanceReport {
  const sampleLimit = opts.sampleLimit ?? 20;
  const checkedFields = Object.keys(proposedFields);

  const empty: ConformanceReport = {
    tag,
    total_notes: 0,
    violating_notes: 0,
    checked_fields: checkedFields,
    sample: [],
  };

  // Resolve the tag's descendant set so we count notes on subtype tags too
  // (a strict field on `#dev` applies to `#dev/log` notes via inheritance).
  const hierarchy = loadTagHierarchy(db);
  const tagSet = Array.from(getTagDescendants(hierarchy, tag));
  if (tagSet.length === 0) return empty;

  // All notes carrying the tag (or a descendant) — a note on ANY of these
  // tags is in scope.
  //
  // UNBOUNDED id sweep (vault#592). This used to call
  // `queryNotes(db, { tags: tagSet, tagMatch: "any" })` with no `limit`,
  // which silently inherits that function's default `LIMIT 100`
  // (`notes.ts`) — so on a tag with more than 100 notes both `total_notes`
  // and the violation scan reported the first page only. The operator was
  // told "3 of 100 notes violate this" for a 1,200-note tag, and violations
  // living past note 100 were never even looked at. A conformance count that
  // undercounts is worse than no count: it is the number the operator
  // decides on.
  //
  // Same shape as `SqliteStore.backfillReferenceFieldLinks` (store.ts),
  // which fixed the identical inherited-cap bug on the reference backfill: a
  // direct `note_tags` scan chunked under the IN-param cap, deduped across
  // tags (a note carrying both `dev` and `dev/log` is ONE note), then
  // hydrated in a batch. Still a pure read.
  const idSet = new Set<string>();
  for (const chunk of chunkForInClause(tagSet)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT DISTINCT note_id FROM note_tags WHERE tag_name IN (${placeholders})`)
      .all(...chunk) as { note_id: string }[];
    for (const r of rows) idSet.add(r.note_id);
  }
  if (idSet.size === 0) return empty;

  const notes = getNotes(db, Array.from(idSet));
  if (notes.length === 0) return empty;

  if (checkedFields.length === 0) {
    return { ...empty, total_notes: notes.length };
  }

  const base = loadSchemaConfig(db);
  const resolved = overlayProposedSchema(base, tag, proposedFields);
  const checkedSet = new Set(checkedFields);

  const tagsById = getNoteTagsForNotes(
    db,
    notes.map((n) => n.id),
  );

  let violating = 0;
  const sample: ConformanceViolation[] = [];

  for (const note of notes) {
    const tags = tagsById.get(note.id) ?? note.tags ?? [];
    const status = validateNote(resolved, {
      path: note.path ?? null,
      tags,
      metadata: note.metadata ?? {},
    });
    if (!status) continue;
    // Keep only violations on a field the PROPOSAL touches (ignore conflicts
    // + violations on inherited/other fields the operator isn't editing).
    const relevant = status.warnings.filter(
      (w) => w.reason !== "schema_conflict" && checkedSet.has(w.field),
    );
    if (relevant.length === 0) continue;
    violating++;
    if (sample.length < sampleLimit) {
      sample.push({
        id: note.id,
        path: note.path ?? null,
        fields: relevant.map((w) => ({
          field: w.field,
          reason: w.reason,
          message: w.message,
        })),
      });
    }
  }

  return {
    tag,
    total_notes: notes.length,
    violating_notes: violating,
    checked_fields: checkedFields,
    sample,
  };
}
