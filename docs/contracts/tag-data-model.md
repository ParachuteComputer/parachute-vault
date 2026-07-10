> Moved from parachute-patterns/patterns/tag-data-model.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# Tag data model

> One-line summary: a tag is a single SQL row carrying its identity, description, indexed fields, a declared relationship vocabulary (opaque JSON map), and parent-tag pointers. Schemas inherit through `parent_names`; `_default` is the implicit universal parent. No notes-as-config for tag concerns. Vault is SQLite; tags belong in tables.

## Convention

The vault `tags` table holds everything about a tag in one row:

```sql
CREATE TABLE tags (
  name TEXT PRIMARY KEY,
  description TEXT,                  -- markdown blurb describing the tag
  fields TEXT,                       -- JSON: indexed metadata fields per `query-operators.md`
  relationships TEXT,                -- JSON: opaque relationship-vocabulary map (see §Relationships)
  parent_names TEXT,                 -- JSON array of parent tag names (multi-inheritance, see §Schema inheritance)
  created_at TEXT NOT NULL,
  updated_at TEXT
);
```

**One tag = one row.** No sidecar table for fields. No sidecar table for note-validation defaults. No config notes for hierarchy parents. Authoring is via direct API (`update-tag` MCP tool / vault admin SPA).

The legacy `tag_schemas` sidecar table, the `_tags/<name>` config-note pattern, the `_schemas/*` notes-as-config pattern, and the short-lived `note_schemas` + `schema_mappings` two-table subsystem are all retired in favor of in-table state on `tags`. See §Migration history.

## Why

**Notes are content; system configuration is in tables.** Vault is a SQLite-backed agent-native knowledge graph, not a markdown-files-on-disk system. Configuration-as-data via "edit a `_tags/<name>` note" was historical accretion — it predates having a SQL identity for tags at all. Now that tags are first-class rows, the schema-on-tag and hierarchy-on-tag concerns belong as columns on that row, not as parsed JSON in another note's metadata.

The conflation between "this is a note" and "this is system configuration" was creating real confusion (see `parachute-patterns/research/parachute-data-model-shape.md`). Drawing the line cleanly: notes carry user content. Anything else is a SQL table or a column.

## Relationships

`tags.relationships` is an **opaque relationship vocabulary**: a plain JSON map of relationship-name → arbitrary JSON value, stored verbatim. The vault validates only that the top level is a plain object — it **rejects** a top-level array, primitive, `null`, or empty-string key — and does **not** enforce the inner shape of each value. Whatever the app writes under a relationship name is stored and returned as-is for the app to interpret. The declaration is informational throughout: not enforced at write time for either the map shape or any link a note carries (see §Future evolution).

This is the canonical contract as of vault#431. The earlier strict `{target_tag, cardinality}` validator was loosened to this opaque map so the Weaver/UI can store a freeform relationship vocabulary directly. Because any plain object is accepted, the old typed shape (below) is still fully valid — the opaque map is a backwards-compatible superset.

The Weaver's freeform vocabulary is a typical opaque map (relationship-name → whatever the app needs):

```json
{
  "works-on":  { "from": "person", "to": "project" },
  "member-of": { "from": "person", "to": "organization" }
}
```

### Recommended convention: `{target_tag, cardinality}` typed-link declarations

For declaring the **expected** typed-link shapes for notes carrying a tag, the recommended convention is a per-relationship object of `{ target_tag, cardinality, description? }`. This is a *convention*, not a requirement — the vault accepts it because it's a valid opaque map, but does not enforce its keys. Agents use it to understand what links a typed note "should" have; the UI uses it to surface affordances ("Add author" on a `#book`):

```json
{
  "author": {
    "target_tag": "person",
    "cardinality": "one",
    "description": "the book's author"
  },
  "genre": {
    "target_tag": "genre",
    "cardinality": "many",
    "description": "thematic category"
  },
  "publisher": {
    "target_tag": "publisher",
    "cardinality": "optional",
    "description": "publishing house"
  }
}
```

#### Cardinality vocabulary

When following the typed-link convention, `cardinality` uses four named values, chosen for AI legibility (LLMs parse named cardinalities more reliably than `"1..*"` style numerics):

| Value | Meaning |
|---|---|
| `"one"` | Exactly one link of this relationship is expected (1) |
| `"optional"` | Zero or one (0..1) |
| `"many"` | Zero or more (0..*) |
| `"many-required"` | One or more (1..*) |

Stored verbatim as the JSON string. Agents reading the schema understand intent without parsing UML notation. These values are a convention the vault does not validate.

### Relationships compose with the existing `links` table

The vault `links` table already stores edges as `(source_id, target_id, relationship)`. The tag's declared relationships are the **expected shape**; actual links live in the `links` table. The schema declaration:
- Tells agents what to look for ("this `#book` should have an `author` link to a `#person`")
- Tells the UI what affordances to surface (an "Add author" button on a `#book` note's edit view)
- Stays informational — doesn't reject writes if a `#book` note has no author

Future enforcement (see §Future evolution) layers validation on top.

## Hierarchy via `parent_names`

Tag hierarchy lives as a column on the tag row.

```sql
-- example data:
INSERT INTO tags (name, parent_names) VALUES
  ('voice',        '["manual", "note"]'),     -- voice descends from manual + note
  ('manual',       '["note"]'),                -- manual descends from note
  ('note',         '[]'),                      -- root
  ('health/food',  '[]');                      -- string-form sub-tag has no explicit parent
```

The `getTagDescendants` resolver walks the `parent_names` graph backwards (build child→parent index, invert to parent→children, transitive closure). Functionally equivalent to the historical `_tags/*` scanner; mechanically simpler.

**Cache invalidation moves with the data source.** Pre-migration the resolver invalidated on `_tags/*` note writes. The trigger now is `tags` row writes (specifically when `parent_names` changes). Same cache-key shape; only the write-side hook differs.

The string-form sub-tag fallback (per `patterns/tag-scoped-tokens.md` §Storage details) STILL applies — `health/food` matches a `[health]`-allowlisted token via `rootOf("health/food") = "health"`, regardless of whether `parent_names` is set. The two mechanisms (parent_names-driven hierarchy + string-form fallback) coexist.

## Schema inheritance

Schema inheritance is real: a tag's effective field map is its own `fields` ∪ every ancestor's `fields`, with **first-in-walk** precedence. Shipped in vault#272 (closed vault#270).

### Walk semantics

For a note carrying tags `[A, B, ...]`, the resolver visits, in order:

1. Each note tag, then its `parent_names` (depth-first, declaration order), cycle-protected via a visited Set.
2. The implicit universal parent `_default` (see below), appended last.

The first specification encountered for any field name wins. Operator-controlled precedence is therefore "first-in-`parent_names`-array wins" — a tag's earlier parents outrank its later parents.

Conflicts (same field declared by two ancestors with diverging `type` or `enum`) surface as advisory `schema_conflict` warnings on the response's `validation_status.warnings`. The warning carries:

- `field` — the contested field name
- `schema` — the tag whose declaration won
- `loser_schema` — the tag whose declaration was overridden (set only on `schema_conflict`)
- `reason: "schema_conflict"`
- `message` — human-readable

`schema_conflict` joins the existing `type_mismatch` and `enum_mismatch` warning reasons. `schema_conflict` itself is always advisory — a resolver-precedence disagreement between ancestors describes operator schema state, not a note's data, so it's never enforced even on a `strict` field.

**Correction (this line originally read "writes are never blocked" — no longer accurate as of vault#299 + vault#553):** validation is advisory BY DEFAULT, but two escalations flip specific violations to hard rejections (`422 schema_validation`, nothing written):
- a field marked `strict: true` — ALL its declared constraints (type/enum/required/cardinality) reject (vault#299).
- a field marked `indexed: true` — its TYPE constraint alone ALWAYS rejects, independent of `strict` (vault#553) — an indexed field's type is a query contract (a type-mismatched value silently poisons range-query ordering via SQLite's TEXT-sorts-above-INTEGER affinity), not just guidance.

**`indexed: true` guarantees TYPE, not enum-domain (vault#555).** An indexed field with an `enum` declared but `strict` unset still ACCEPTS a value outside the enum — `indexed` only forces the type check, by ratified decision (vault#553 Decision A scoped the escalation to type alone). The out-of-enum value is stored and fully queryable (`eq`/`in`/etc. all work normally against it — the B-tree index doesn't care about enum membership), and it DOES surface an advisory `enum_mismatch` warning in `validation_status.warnings` on every read, not just the write that introduced it (vault#555 fixed a gap where this warning was visible only on the one-time create/update response and silently absent on every subsequent `query-notes`/GET). To make an out-of-enum value a hard rejection, mark the field `strict: true` as well — `indexed` and `strict` are independent, composable flags.

See `core/src/schema-defaults.ts` (the resolver + `strictViolations`) and `docs/HTTP_API.md`'s error-taxonomy table (`schema_validation`) for the current, canonical contract — this file otherwise predates both features and doesn't enumerate `strict`/`required`/`cardinality`/`indexed`/`default` per-field flags; treat the source as authoritative over this doc for field-flag semantics.

### `_default` is the implicit universal parent

A tag named `_default` is special at *resolution* time only — it's never auto-written into any `parent_names` array, never auto-applied at the storage layer.

- When a `_default` row exists in `tags`, it's appended to every note's effective ancestor walk (including untagged notes). Its `fields` apply to every note as a low-precedence fallback.
- Because `_default` is appended **last**, any field a real tag declares wins over `_default`'s declaration of the same field.
- `getTagDescendants("_default")` returns every tag — used by `query-notes { tag: "_default" }` to mean "every note."
- When `_default` is *not* declared as a tag row, the magic is inert. The behavior is opt-in via `update-tag` like any other tag.

`_default` can technically carry its own `parent_names` and the resolver handles it (cycle guard + visited Set), but the resulting interaction is non-obvious. Treat `_default` as a root tag in normal use.

This collapses the prior `note_schemas` + `schema_mappings` two-table design into a single mechanism: instead of mapping schemas to notes by path-prefix or tag, schemas live on tags and inherit, with `_default` covering the universal-fallback case that `_schema_defaults` used to handle. Zero operator vaults used the path-prefix mapping kind, and tag-mapped schemas were fully redundant with `tags.fields` — see vault#267 for the audit.

### Field reuse across tags

The "discoverable shared field" pattern (Tana §8.1.b in `research/tana-deep-dive.md`) is implicitly delivered through inheritance: a tag with `parent_names: ["task"]` inherits task's `due`, `assignee`, etc., without redeclaring them. A field shared across many sibling tags becomes an ancestor-tag concern: declare once on the parent, every child inherits.

## Tag rename is a transactional cascade

Renaming a tag (`task` → `todo`, say) is a single transactional cascade across every surface where the old name lives. Shipped in vault#275 (closed vault#240 + vault#247). Replaces the prior fail-closed 409 on token-referenced tags.

Surfaces touched by the cascade:

1. `tags.name` PK row.
2. Sub-tag rows: `task/work` → `todo/work`, recursively (sub-tags follow their root).
3. `note_tags.tag_name` FK references for every renamed name.
4. `tags.parent_names` JSON arrays in OTHER tag rows.
5. `tokens.scoped_tags` JSON arrays.
6. `indexed_fields.declarer_tags` JSON arrays.
7. Note body `content`: `#oldname[/...]` references rewritten to `#newname[/...]`. `[[_tags/oldname]]` wikilinks rewritten.
8. `_tags/<oldname>...` paths (post-v14 these are inert historical breadcrumbs, but renaming for hygiene keeps the vault internally consistent).

**Atomicity:** a single `BEGIN IMMEDIATE` transaction. Any failure rolls back the entire cascade — no half-applied state. Pre-flight collision check covers the root rename and every sub-tag rename, so a partway-through `UNIQUE` violation can't happen.

**Pre-flight conflict surface:** if any new name already exists as a tag and isn't itself being renamed away, the call returns `{error: "target_exists", conflicting: [...]}` without touching the database.

**Reported stats:** the result includes per-surface counts (`renamed`, `sub_tags_renamed`, `parent_refs_updated`, `tokens_updated`, `indexed_field_declarers_updated`, `notes_rewritten`, `paths_renamed`) so REST/MCP responses describe what changed without a re-scan.

**Cache invalidation:** both `_tagHierarchy` and `_schemaConfig` caches bust after the cascade, since `parent_names` and the tag-set both change.

## MCP discovery surface

How an AI client learns the vault's schema shape lives in [`vault-mcp-discovery.md`](./vault-mcp-discovery.md). Short version: the same projection (tags-with-schemas + indexed fields + query hints) is rendered as markdown at MCP `initialize` and returned as JSON from the `vault-info` tool — both surfaces scope-filtered when the caller is tag-scoped.

## Authoring surface

```
MCP tool: update-tag
HTTP:     PUT /vault/<name>/api/tags/<tag>
SPA:      vault admin tag editor
```

All three write to the same `tags` row. `update-tag` accepts `{ description, fields, relationships, parent_names }` and upserts.

There is no path that authors tag state by editing a markdown note. The `_tags/<name>` and `_schemas/*` config-note conventions are retired.

## Migration history

The model arrived in three steps; this section records the arc so the migration-notes entries make sense.

1. **2026-05-03 — `tag_schemas` + `_tags/*` retirement** (vault#245, schema v13 → v14). Added `description`, `fields`, `relationships`, `parent_names` columns on `tags`. Lifted data from the `tag_schemas` sidecar and `_tags/<name>` config notes. Dropped `tag_schemas`. Left `_tags/<name>` notes in place as historical breadcrumbs.
2. **2026-05-03 — `_schemas/*` retirement** (vault#249, schema v14 → v15). Lifted `_schemas/<name>` notes and the `_schema_defaults` mapping note into a new `note_schemas` + `schema_mappings` two-table subsystem. MCP tool count went 10 → 16 with `update-note-schema`, `delete-note-schema`, `list-note-schemas`, `set-schema-mapping`, `delete-schema-mapping`, `synthesize-notes`.
3. **2026-05-09 — `note_schemas` + `schema_mappings` ripped** (vault#269, schema v16 → v17). Audit found zero operator use of the path-prefix mapping kind, and tag-mapped schemas were redundant with `tags.fields`. Subsystem removed entirely; the six new MCP tools deleted; tool count went 16 → 9. Note-validation now lives where tag-validation lives: on `tags.fields`, with `_default` as the universal-fallback (vault#272, same-day).
4. **2026-06-03 — `relationships` loosened to an opaque vocabulary map** (vault#431). Validator now accepts any plain-object map; the `{target_tag, cardinality}` typed shape becomes a recommended convention, not a requirement. Backwards-compatible superset.

The arc is one-way. Aaron approved the irreversible migrations 2026-05-03 (steps 1+2) and 2026-05-09 (step 3); the cleaner break beats keeping the subsystem alongside.

## Adoption

| Module | Action |
| --- | --- |
| **vault** | Shipped: schema v17, single-table tag model, multi-inheritance with `_default` magic, transactional rename cascade. See `core/src/schema-defaults.ts`, `core/src/notes.ts`, `core/src/vault-projection.ts`. |
| **parachute-agent** | No change — parachute-agent doesn't touch tag schema state |
| **hub** | No change |
| **notes** | The Notes UI surfaces tag schemas (declared fields + relationships) in note-edit views; tracked in the notes repo |

## Future evolution

| Extension | Sketch | When to revisit |
| --- | --- | --- |
| **Relationship enforcement** | Validate at write time that a `#book` note has an `author` link with cardinality `one`. Returns 400 on missing required relationship. | When operator pain emerges from notes lacking expected relationships |
| **Reverse-relationship inference** | `#book` declares `author → person`. Vault auto-infers `person → book` reverse with relationship `wrote`. | Phase 2 if helpful for query semantics |
| **`required` field markers** | Re-introduce required/optional on field specs (the prior `note_schemas` table carried this). | When a real "missing field" pain point emerges; advisory-only by default |
| **Schema versioning** | Optional `schema_version` field on tag rows; track migrations across schema changes | When a real schema-evolution incident happens |
| **Relationship typing per-link** (multiple authors with different roles) | Extend `links.metadata` JSON with `{ role: "primary-author" }` shape | When use-case appears |

## Adoption notes

- Aaron approved the original design 2026-05-03 in the architecture-review thread; the multi-inheritance + `_default` extension and the rename cascade landed 2026-05-09.
- The retirement of config-as-note for tag concerns is a real simplification, not just refactor — the conceptual layer "what is a note" gets clearer.
- Tag rename is now operator-friendly across all surfaces (vault#275 — superseded the earlier fail-closed 409 on token-referenced tags).
- Companion docs: `patterns/vault-mcp-discovery.md` (how clients see the schema), `research/parachute-data-model-shape.md` (architectural reflection), `research/tana-deep-dive.md` (typed-graph context), `patterns/tag-scoped-tokens.md` (token-scope concerns layered on this model).

_Last updated: 2026-06-03 — `relationships` loosened to an opaque vocabulary map (vault#431)._
