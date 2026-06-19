# Typed link fields — a metadata field that is a reference to another note

**Status:** design (2026-06-18, draft to tend later). Captured at Aaron's request as a
larger vault-platform feature to pick up as its own arc — NOT built yet. Consumers
(agents, proposals, person↔org) use the **interim** (`[[wikilinks]]` in bodies / opaque
id strings) until this lands. Will get a proper review + migration plan when the arc
starts.

## The gap
A tag-schema field today is `string | integer | boolean` (indexed) or basic JSON
(validated). There is **no `link`/`reference` field type**. A string field can hold
another note's id or path, but the vault treats it as an **opaque string**: no
target-existence check, no participation in the link graph, no reverse index. The only
real note→note edges come from **`[[wikilinks]]` in the note body** — parsed, resolved
by path/name, **stored by id** in the `links` table, with deferred resolution for
forward-refs and `ON DELETE CASCADE`. `parent_names` is tag→tag (is-a), not note→note.
`tags.relationships` is an unenforced vocabulary declaration, not a wired feature.

So when a note's metadata says "this belongs to / replies-to / triggers that note," that
relationship is invisible to the graph and has zero referential integrity.

## Why this is a vault-platform feature (not per-module)
Every module models note→note references: agents (`thread --of--> definition`,
`message --in_reply_to--> message`, `job --triggers--> definition`), proposals→captures,
surfaces→inquiries, person→org. A typed-reference field with target validation, edge
materialization, and a reverse index is *the* missing relationship primitive — it belongs
in the vault where everything benefits (hub-module-boundary: the vault owns the
data-model platform). Agents are just its first serious consumer.

## The design (reuses the wikilink machinery wholesale)
A typed link field is **"a schema-declared, validated, auto-synced `links` edge sourced
from a metadata field instead of from `[[brackets]]` in the body."**

- **New `TagFieldSchema` field type:**
  `{ type: "link", target_tag?: "#X", cardinality?: "one" | "many", relationship?: "<rel>" }`.
  - `target_tag` (optional): constrain the referent to notes carrying that tag (validated at write).
  - `cardinality`: `one` (a single ref) or `many` (an array of refs).
  - `relationship`: the edge label written into `links` (so the graph carries semantics).
- **On write** (`createNote`/`updateNote`): resolve the field value (id **or** path) →
  confirm the target exists (and carries `target_tag` if declared) → **materialize a
  `links` row** with the declared `relationship` — mirroring `syncWikilinks` exactly.
  The field now participates in `near` / `find-path` / `linkCount` for free, and
  `idx_links_target` gives the **reverse lookup** ("which threads point at this def?") with
  no new index.
- **Deferred resolution** for forward-refs (an `unresolved_*` analogue of the wikilink
  path), and lifecycle via the `links` FK `ON DELETE CASCADE`.

## id vs path vs unique-key — store id, accept either, resolve on write
The existing wikilink design already answers this correctly: **resolve by path/name at
write time, store the id in the edge.** Ids (`notes.id` PK, a timestamp string) are
stable across renames; **paths** are what users rename. So the edge survives renames via
the `links` FK, exactly as wikilinks do. The MCP `resolveNote` already accepts id-or-path.
Don't invent a third "unique key" concept — **`path` is the human-facing unique key, `id`
is the stable internal one**, and resolve-by-path/store-by-id is already proven. (See the
sibling decision in the agent work: encode human-unique identities in `path` — `path` is
already a UNIQUE column — rather than adding UNIQUE metadata indexes.)

## What it unlocks for consumers
The relationship graph becomes navigable with the same tools as everything else:
- Agents: `thread --of--> definition`, `message --in_reply_to--> message`,
  `job --triggers--> definition` → "show me everything about agent X" is one `near`
  query; "all threads of this def" is one reverse-lookup. (`channel` stays a plain string —
  it's a routing label, not a note; don't over-model it.) The agent module unified "run"
  into "thread" (a run was always a thread with one turn); this doc tracks that vocabulary.
- Generic: proposals→captures, person↔org, etc.

## Scope of the change (when we build it)
Touches: `TagFieldSchema` type + validator (accept `link`, validate target_tag /
cardinality); the note write path (`createNote`/`updateNote` — resolve + materialize the
edge + deferred-resolution for forward refs); the graph/query layer (the field-sourced
edges already flow through `links`, so `near`/`find-path` need no change beyond
recognizing the new edge source); a migration to optionally backfill edges from existing
opaque-string id fields that adopt the new type. Plus the MCP/REST surface to declare a
`link` field.

## Open questions (resolve when the arc starts)
- **Validation strictness:** reject a write whose target is missing, or accept + defer
  (like forward-ref wikilinks)? Probably defer (matches wikilinks) + surface unresolved.
- **`cardinality: many`** storage: an array of refs in the field → N `links` rows.
- **`relationship` vocabulary:** reconcile with the existing (unenforced) `tags.relationships`.
- **Migration:** how existing opaque-string id refs (e.g. agent `definition`,
  `in_reply_to`) upgrade to typed links — in place, with the resolve-by-id path.
- **Reverse-query ergonomics:** expose "incoming links of type R to note N" cleanly in
  the MCP/REST (the index exists; the query surface may need a verb).
- **Tag-scope / permissions:** does following a link cross a tag-scope boundary the
  caller's token doesn't have? (Likely the read still respects scoped_tags.)

## Sequencing
A deliberate vault arc on its own timeline — design-doc-first (this), then build behind
the interim. Does **not** block the agent UI or schema work; agent edges ride
`[[wikilinks]]` / opaque id strings until typed link fields land, then upgrade underneath
with no consumer-surface change.
