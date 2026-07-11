# Typed reference field — indexed value + auto-link

**Status:** shipped (scalar case + `cardinality: "many"` arrays + schema-after-data backfill); remaining known gaps below
**Date:** 2026-07-10 (gaps #2/#3 closed 2026-07-10, round-4 bug hunt LB8)
**Author:** vault builder (Claude)
**Repos touched:** parachute-vault

## Why this doc exists

Builders kept hand-syncing two things that should have been one: an indexed
string field (`assignee: "alice"`) so the value is filterable, AND a
structured `links` entry (`{ target: "alice", relationship: "assigned-to" }`)
so the graph edge exists. The two drift — a metadata update that forgets the
matching link edit (or vice versa) leaves the vault lying about who's
assigned to what.

`type: "reference"` on a tag-schema field collapses this into one write. Set
the metadata field; the value is stored/validated/indexable exactly like
`string`, and the write path resolves it to a note and maintains a graph
link, `relationship` = the field name, automatically.

## What landed

### 1. The field-type vocabulary (the "easy half")

`"reference"` is now a first-class member of `TagFieldSchema.type` /
`SchemaField.type`'s seven-value vocabulary, alongside `string`/`number`/
`integer`/`boolean`/`array`/`object`:

- `core/src/tag-schemas.ts`: `VALID_FIELD_TYPES` includes `"reference"`;
  `defaultMatchesType` validates a declared `default` for a reference field
  like a string.
- `core/src/schema-defaults.ts`: `SchemaField.type` includes `"reference"`;
  `valueMatchesType` validates a note's field value like a string (so
  `type_mismatch`/`required`/`enum`/`cardinality` all work the same way they
  do for `string` fields).
- `core/src/indexed-fields.ts`: `reference` maps to `TEXT` in `TYPE_MAP`, so
  `indexed: true` on a reference field gets the same generated column +
  B-tree index a `string` field would — `eq`/`in`/range operator queries
  work. (A plain, non-operator `metadata: { field: value }` filter already
  works on ANY field via `json_extract`, indexed or not — `indexed: true`
  is only needed for the operator-object query form.)

This half is fully tested, documented in the MCP `update-tag` tool
description, and in `docs/HTTP_API.md`.

### 2. Auto-link on write (the "hard half") — landed for the scalar case

`core/src/store.ts`'s `BunSqliteStore.syncReferenceFieldLinks` is the new
private method, called from `createNote`, `updateNote` (only when the call
touches `metadata`), and the bulk `createNotes` path — the single chokepoint
both the MCP tool layer (`core/src/mcp.ts`) and the REST layer
(`src/routes.ts`) funnel every note write through, so BOTH transports get
this for free without duplicating the logic.

For each field in the note's EFFECTIVE schema (its own tags + `parent_names`
ancestors — the exact same resolution `validateNoteAgainstSchemas` already
uses, via `resolveNoteSchemas` in `schema-defaults.ts`) that declares
`type: "reference"`:

1. Compare the field's new metadata value against its value BEFORE this
   write. Unchanged → skip (no DB churn on writes that don't touch this
   field — e.g. a content-only edit).
2. Changed (set, changed, or removed) → delete every existing link from this
   note under `relationship = fieldName` (regardless of target) AND any
   queued forward-ref under that relationship
   (`links.deleteLinksBySourceRelationship` / `wikilinks.clearQueuedLink`,
   both new). This makes "the field's current value" the single source of
   truth for "this field's link" without needing to track the specific
   prior resolved target.
3. If the new value is a non-empty string, resolve it via
   `wikilinks.resolveOrQueueLink` — the EXACT SAME id → path/title
   resolution AND lazy-forward-ref-queueing that a structured `links` entry
   uses (vault#555). A target that doesn't exist yet is queued in
   `unresolved_wikilinks` and backfills automatically the moment a matching
   note is created, same as any other structured link.

This is a real, reused-machinery implementation, not a stub — see the tests
in `core/src/core.test.ts` (search `type: "reference"`) covering: create
sets both the indexed value and the link; changing the value re-points the
link (old edge dropped, new edge created); clearing the field drops the
link; an unresolved target queues and backfills when the target note is
created later; querying by the field (both plain metadata-equality and, when
`indexed: true`, the `eq` operator) works.

### 3. `cardinality: "many"` (array) values, and schema-after-data backfill — CLOSED (round-4 bug hunt, LB8, 2026-07-10)

Gaps #2 and #3 below (as originally numbered) are now closed:

- **Array reference values create real links — one edge per element.**
  `BunSqliteStore.syncReferenceFieldArrayLinks` (`core/src/store.ts`) is the
  `cardinality: "many"` counterpart to the scalar sync above, dispatched
  whenever either side of a field's before/after comparison is an array.
  Old-vs-new membership is diffed as a SET (order and duplicate elements
  don't matter — `["carol","carol"]` collapses to one edge, matching what
  the `links` table's own `UNIQUE(source_id, target_id, relationship)`
  would do anyway): elements only in the new set are resolved-or-queued
  exactly like a scalar reference (same self-link, ambiguous-match, and
  forward-ref-backfill contracts); elements only in the old set have their
  specific edge (and only that element's queued forward-ref, via the new
  `clearQueuedLinkTarget`, NOT the blanket `clearQueuedLink` a multi-element
  field can't safely use) removed; elements in BOTH sets are left
  completely untouched — no delete/recreate churn on an unchanged element,
  same "don't touch what didn't change" discipline the scalar path already
  had. `valueMatchesType` (`core/src/schema-defaults.ts`) also gained a
  `cardinality: "many"` branch for the `reference` type — a conforming array
  write no longer trips a self-contradictory `type_mismatch` warning (an
  array is exactly what "many" asks for; only a non-string ELEMENT now
  fails the check).

- **`update-tag` backfills links when a field is newly declared (or
  changed) to `type: "reference"`.** `BunSqliteStore.upsertTagRecord` (the
  chokepoint both the MCP `update-tag` tool and REST's `PUT
  /api/tags/:name` funnel through) now diffs the tag's prior field map
  against the incoming one; for every field whose type is transitioning TO
  `"reference"`, `backfillReferenceFieldLinks` walks every note carrying the
  tag (or a descendant, via schema inheritance — same scope
  `countConformanceViolations` uses for its own schema-change impact walk)
  and re-runs the write-path sync against each note's CURRENT metadata, as
  if the value had just been set. Runs AFTER the schema-config cache is
  invalidated, so the sync resolves against the just-persisted declaration;
  runs in its own transaction, separate from the tag-record write itself.
  Idempotent by construction (same clear-before-create / diff-only
  discipline as the write-path sync) — re-declaring an unchanged schema, or
  a later call that adds an unrelated reference field (which re-walks the
  WHOLE tag, since the sync is per-note not per-field), never duplicates an
  already-correct link. Scoped to fields transitioning TO `"reference"`
  specifically — a field that's ALREADY `"reference"` and stays
  `"reference"` on a re-declare skips the walk entirely (already in sync
  from prior writes/backfills); a `cardinality` change on an
  already-`"reference"` field (e.g. `"one"` → `"many"`) does NOT re-trigger
  this walk today — see the still-open note under gap #3 below.

Both are covered in `core/src/core.test.ts` under the same `describe("typed
reference field", …)` block (search `cardinality:'many'` and
`backfills links for existing notes`).

## Known gaps (deliberately out of scope for this PR)

1. **No inline `unresolved_link` warning on the response.** Structured
   `links` entries in `create-note`/`update-note` surface an inline
   `unresolved_link` warning in that SAME call's response when the target
   doesn't resolve. A reference field's forward-ref is queued into the exact
   same `unresolved_wikilinks` table, so it's discoverable via the EXISTING
   `has_broken_links`/`include_broken_links` filters on
   `query-notes`/`GET /api/notes` — but the create/update call itself
   doesn't (yet) fold an equivalent warning into its own response. Doing so
   cleanly needs `store.createNote`/`updateNote` to surface a structured
   "this write queued N forward-refs" result the MCP/REST layers can fold
   into their existing `warnings` array — a small, mechanical follow-up.

2. ~~Scalar values only.~~ **CLOSED 2026-07-10** — see the new "§3" section
   above. `cardinality: "many"` array values now create one link per element
   with proper add/remove diffing, and the spurious `type_mismatch` warning
   on a valid array write is gone.

3. ~~No retroactive backfill.~~ **CLOSED (mostly) 2026-07-10** — see the new
   "§3" section above. `update-tag` now backfills links for existing notes
   when a field is newly declared (or changed) to `type: "reference"`. One
   narrower case remains open: a field that's ALREADY `type: "reference"`
   and has its `cardinality` changed (e.g. `"one"` → `"many"`) does NOT
   re-trigger the backfill walk, since the trigger is keyed on the field's
   TYPE transitioning to `"reference"`, not on any change to its spec. Notes
   with array-shaped values written while the field was still misdeclared
   as `cardinality: "one"` (or written against pre-fix code, before gap #2
   closed) stay unlinked until either a real write touches the field again
   or the field's `type` is round-tripped (cleared then re-declared
   `"reference"`, which re-triggers the walk). No test/use case has needed
   this yet; flag it if one shows up.

4. **Tag-mutation-triggered sync not wired.** Adding/removing a TAG on a
   note (`tagNote`/`untagNote`, or the `tags` param some update-note flows
   pass separately from `metadata`) can change which schema fields apply to
   a note without touching `metadata` in that same `store.updateNote` call.
   If that tag-add newly makes an already-set field a reference field, the
   link isn't created until the field is next written. This is the mirror
   image of the now-closed gap #3 (schema changes under a note vs. a note
   changing under a schema): #3's backfill runs from the TAG side
   (`update-tag` walking its notes); this one would need to run from the
   NOTE side (`tagNote` walking the note's newly-effective schema) — not
   wired here, same "sync is a write-path concern" rationale (mirrors how
   `applySchemaDefaults` backfill also only runs at the moment tags are
   being added in the same MCP/REST call, not retroactively).

5. **Relationship-name collision is intentional, not defended against.** A
   reference field's relationship name is field-owned: if a note ALSO
   carries a hand-authored structured `links` entry using the SAME
   relationship name as a reference field, and that field's metadata value
   is written in the same call, the sync's "clear all under this
   relationship, recreate one" step will supersede the hand-authored link.
   This is intentional (the field becomes the authority for that
   relationship name once declared) but worth calling out explicitly for
   anyone reusing relationship names across both mechanisms on the same tag.

## Why the write-path hook, not a Store-external layer

`core/src/store.ts`'s `BunSqliteStore` is already the established
single-chokepoint pattern for this codebase — `upsertTagRecord`'s indexed-
field lifecycle reconciliation, `createNote`/`updateNote`'s wikilink sync,
and `deleteTag`'s cascade all live here specifically so MCP and REST can't
drift by each reimplementing the same policy. Hooking reference-field sync
here (rather than in `core/src/mcp.ts`/`src/routes.ts`, which is where the
STRUCTURED `links` param is currently handled) means every future transport
gets this behavior for free, and it's the literal reuse the task asked for:
"reuse existing link resolution + link machinery in the write path."
