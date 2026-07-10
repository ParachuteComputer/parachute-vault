# Typed reference field — indexed value + auto-link

**Status:** shipped (scalar case), known gaps below
**Date:** 2026-07-10
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

2. **Scalar values only.** `cardinality: "many"` (an array of references,
   e.g. `assignees: ["alice", "bob"]`) is stored and validated (each item
   would need to independently satisfy `type: "reference"`'s string check,
   though `valueMatchesType`'s array/cardinality checks today validate the
   ARRAY shape, not per-item types) but does **not** create any links — the
   sync's `typeof nextValue === "string"` guard means a non-string (array)
   value is simply skipped for linking. Multi-target reference fields would
   need: (a) per-item type validation, and (b) diffing an array-of-old vs
   array-of-new to add/remove the right subset of links rather than the
   current "clear all under this relationship, recreate one" strategy. Left
   for a follow-up once there's a concrete multi-assignee use case to design
   against.

3. **No retroactive backfill.** If a tag GAINS a `type: "reference"`
   declaration for a field that existing notes already carry a value for,
   those notes are not retroactively linked — only a write that actually
   touches the field (going forward) triggers the sync. This mirrors the
   existing posture for `indexed: true` (declaring a field indexed doesn't
   retroactively index prior notes' values beyond the generated column
   itself, which IS backfilled by SQLite's `GENERATED ALWAYS AS`) and for
   `default` (vault#553 Decision B — no implicit backfill). An operator
   wanting to backfill links for pre-existing data would re-`update-note`
   each affected note (even a no-op `metadata` echo would trigger the sync,
   since the "unchanged" fast path compares against the PRE-write value, not
   "was this call's payload identical" — actually: echoing the SAME value
   back IS treated as unchanged and skipped. A genuine backfill needs a
   one-off script that walks affected notes and re-writes with a real
   value, or a small dedicated `reconcileReferenceLinks` admin op — not
   built here).

4. **Tag-mutation-triggered sync not wired.** Adding/removing a TAG on a
   note (`tagNote`/`untagNote`, or the `tags` param some update-note flows
   pass separately from `metadata`) can change which schema fields apply to
   a note without touching `metadata` in that same `store.updateNote` call.
   If that tag-add newly makes an already-set field a reference field, the
   link isn't created until the field is next written. Same rationale as
   #3 — the sync is a WRITE-PATH concern (mirrors how `applySchemaDefaults`
   backfill also only runs at the moment tags are being added in the same
   MCP/REST call, not retroactively).

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
