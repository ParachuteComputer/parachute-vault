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
  It reconciles against the RESOLVED next-set (round-4 review NIT 3): the
  whole new array is resolved to a set of target ids (misses queued,
  duplicates and order collapsed — `["carol","carol"]` is one edge), then
  existing edges under `(source, relationship)` are reconciled to that set —
  every edge whose `target_id` is NOT in the resolved next-set is deleted,
  every resolved target is (re-)created via `INSERT OR IGNORE` (so an
  unchanged element keeps its original `created_at`). Reconciling on
  resolved TARGETS rather than re-resolving each removed raw string is what
  makes the three corners come out right: a removed element whose target was
  **renamed/deleted** since (its edge target is simply absent from the
  next-set → dropped, where re-resolving the stale string missed and left
  the edge forever), a removed element now **ambiguous** (same), and two
  elements **aliasing the same target** (a path and its H1 title) where
  dropping one alias keeps the shared edge because the survivor still
  resolves that target. Queued forward-refs for dropped elements are cleared
  per-element via `clearQueuedLinkTarget` (NOT the blanket `clearQueuedLink`,
  which would also drop other elements' still-pending queue rows).
  `valueMatchesType` (`core/src/schema-defaults.ts`) also gained a
  `cardinality: "many"` branch for the `reference` type — a conforming array
  write no longer trips a self-contradictory `type_mismatch` warning (an
  array is exactly what "many" asks for; only a non-string ELEMENT now
  fails the check).

- **`update-tag` backfills links for existing notes whenever the persisted
  schema declares a `type: "reference"` field.** `BunSqliteStore.upsertTagRecord`
  (the chokepoint both the MCP `update-tag` tool and REST's `PUT
  /api/tags/:name` funnel through) fires `backfillReferenceFieldLinks` for
  ANY reference field in the tag's declared schema — not only a
  type-transition (round-4 review BLOCKER 2). That matters because the
  documented heal path is "re-declare the reference field to build links for
  notes that predate the fix"; a transition-keyed trigger made that a silent
  no-op (an already-reference field stays reference, so nothing fires). The
  walk covers **every** note carrying the tag or a descendant — an
  **unbounded** id sweep (round-4 review BLOCKER 1: the first cut walked via
  `queryNotes`, which silently caps at `LIMIT 100`, so a >100-note tag left
  the majority unlinked — the exact silent-half-graph this feature exists to
  prevent). For each note it materializes the missing link(s) for the
  declared reference field(s) via a purely **additive, idempotent** helper
  (`backfillOneReferenceField`): resolve-or-queue + `INSERT OR IGNORE`
  `createLink`, **never** deleting — so re-declaring a schema doesn't churn
  already-correct edges (`created_at` preserved) and a scalar value that has
  since gone ambiguous doesn't lose its already-built edge (round-4 review
  NIT 5). The walk is **scoped to the field(s) this `update-tag` declared
  reference** (NIT 5), so declaring a reference field on tag A never touches
  an unrelated reference field contributed by tag B on a note carrying both.
  It runs **inside** the same transaction as the tag-record write (round-4
  review NIT 4), with the schema-config + hierarchy caches busted BEFORE the
  walk (round-4 review NIT 6 — the `_default` universal-parent gate and the
  just-persisted declaration must both be visible), so a walk failure rolls
  the schema write back and the retry re-fires rather than persisting a
  `reference` schema whose links never got built.

  **The additive-only tradeoff** (round-4 review nit): because the heal never
  deletes, it cannot reconcile away a *stale* edge left by a prior type
  round-trip — declare `manager` reference (edge → Alice) → flip `manager` to
  `type: "string"` → change the value to Bob via a normal write (reference sync
  doesn't fire on a non-reference field, so the Alice edge persists) →
  re-declare `manager` reference. The heal correctly adds the Bob edge, but the
  orphaned Alice edge remains until the next reference-typed write to that field
  reconciles it (via the normal `syncReferenceFieldLinks` delete-and-recreate
  path). Reconciling during the heal-walk is deliberately avoided: it would
  clobber hand-authored structured `links` under the same relationship (see the
  known gap below) and reintroduce the whole-tag churn nit 5 removed. The stale
  edge is stranded by the type-flip, not by the backfill.

All of the above are covered in `core/src/core.test.ts` under the same
`describe("typed reference field", …)` block (search `cardinality:'many'`,
`backfills links for existing notes`, `BLOCKER`, and `NIT 3`).

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

3. ~~No retroactive backfill.~~ **CLOSED 2026-07-10** — see the new "§3"
   section above. `update-tag` now backfills links for existing notes
   whenever the tag's persisted schema declares a `type: "reference"` field.
   Because the trigger fires for ANY reference field in the declared schema
   (not just a type-transition — round-4 review BLOCKER 2), the earlier
   narrowing is gone: re-declaring an already-reference field HEALS notes
   whose links were never built (a pre-fix vault, or a `cardinality` change
   from `"one"` → `"many"`), and the walk covers every matching note
   (unbounded, not the first 100). The only backfill still NOT wired is the
   NOTE-side mirror image — see gap #4 (adding a tag to a note that makes an
   already-set field newly a reference field).

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
