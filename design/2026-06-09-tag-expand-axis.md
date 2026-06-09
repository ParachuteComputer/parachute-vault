# Tag query expansion axes — `expand` param

**Status:** design → build (2026-06-09)
**Scope:** parachute-vault. Additive, backward-compatible (default = current behavior).

## The problem

A vault tag relates to another along **two orthogonal axes**, but the query
engine only knows one of them:

| Axis | Meaning | Declared by | Today |
|---|---|---|---|
| **Subtype (is-a)** | semantic inheritance | `tags.parent_names` | expands by default |
| **Namespace (path)** | organizational filing | the slash in the tag *name* | **not a query axis at all** |

So `query-notes { tag: "entity" }` returns `person`/`work`/… (subtypes, via
`parent_names`) — but a tag *named* `entity/archived` is invisible to it, because
the slash is purely cosmetic. There's no way to say "also give me everything
filed under `entity/`," and no way to say "give me ONLY `#entity`, no expansion."

This bit us in parachute-channel: `#channel-message/inbound` was assumed to be
queryable under `#channel-message` and wasn't (fixed there by tagging both
literally). The root fix is to make namespace a real, opt-in query axis.

## The model

Make tag expansion mode-selectable via a new `expand` field on `QueryOpts`:

```
expand: "subtypes"   (DEFAULT) — tag ∪ parent_names-descendants. Current behavior, unchanged.
expand: "namespace"            — tag ∪ {names lexically prefixed `tag/`}. New.
expand: "both"                 — union of the two.
expand: "exact"                — just the literal tag, no expansion. New escape hatch.
```

- **Default `"subtypes"`** — semantic. "Give me everything that *is a* message."
  Namespaced things never show up unbidden (the surprise we just hit). This is
  the behavior every existing caller already gets, so the change is a pure
  superset — no migration, no semantic shift for anyone not passing `expand`.
- **Namespace is purely lexical** — `name = tag OR name LIKE tag || '/%'` over the
  known tag set. No schema, no `parent_names` — namespacing is free-form, which
  is the whole point (subtyping is declared; filing is not).
- `"exact"` turns off the descendant expansion that's currently always-on — useful
  for "this precise tag only."

Per-input-tag: `expand` applies to each tag in a multi-tag query independently
(mirrors today's per-input expansion).

## Where it threads (the "few places")

1. **Expansion core** (`core/src/store.ts expandTagsWithDescendants` +
   `core/src/tag-hierarchy.ts`): generalize to `expandTags(tags, mode)`. Subtypes
   = today's `getTagDescendants` (parent_names). Namespace = lexical prefix over
   `TagHierarchy.allTags` (already loaded). Both = union. Exact = identity.
   Keep `expandTagsWithDescendants` as a `mode:"subtypes"` shim so existing
   callers are untouched.
2. **Query engine** (`core/src/notes.ts queryNotes`): honor `opts.expand` when
   building `_tagsExpanded`. Default `"subtypes"`.
3. **REST** (`src/routes.ts parseNotesQueryOpts`): parse `?expand=`; validate
   against the enum (unknown → 400). Flows into both `/notes` and `/subscribe`.
4. **MCP** (`core/src/mcp.ts query-notes`): add `expand` to the tool schema with
   the four values + doc text; default `"subtypes"`.
5. **Live-query SSE** (`src/live-match.ts buildLiveMatcher` + `src/subscribe.ts`):
   the matcher's tag expansion MUST use the same mode as the snapshot, so a
   subscription's snapshot and live events agree. Thread `opts.expand` through
   `buildLiveMatcher`; it currently hardcodes subtype expansion. **This is the
   consistency-load-bearing point** — snapshot and live must lower the identical
   expansion.
6. **Types** (`core/src/types.ts`): add `expand?: "subtypes" | "namespace" | "both" | "exact"` to `QueryOpts` and to the `Store.expandTags` signature.

## `_default` interaction

`_default` (the universal-parent magic, vault#270) stays a **subtypes-axis**
concept — namespace mode does not trigger it. `expand: "namespace"` on `_default`
is just the lexical `_default/*` prefix (almost certainly empty); the universal
expansion only fires under `"subtypes"`/`"both"`. Keep that branch in the
subtype path only.

## Backward compatibility

`expand` is optional; absent → `"subtypes"` → byte-identical to today's behavior.
No data migration, no schema change. Every existing query, REST call, MCP call,
and the live-query snapshot/matcher keep their current results.

## Channel follow-on (not this PR)

Once shipped, `#channel-message/inbound|outbound` *could* be modeled as declared
subtypes of `#channel-message` (semantically honest — an inbound message is-a
channel message) so a default search returns them, letting channel drop the
tag-both. Optional cleanup; tag-both stays correct meanwhile.

## Test plan

- `expand:"subtypes"` (and absent) == current behavior over a corpus with a
  `parent_names` hierarchy (regression: identical results).
- `expand:"namespace"` returns `tag` + `tag/*` lexical, and does NOT return
  `parent_names`-only subtypes that aren't name-prefixed.
- `expand:"both"` = union; `expand:"exact"` = literal tag only (no descendants).
- A tag that is BOTH a declared subtype-child AND name-prefixed appears once
  (set semantics, no dup).
- REST `?expand=` parses + validates (bad value → 400); MCP schema accepts it.
- **SSE consistency:** subscribe with each `expand` mode → snapshot set ≡ live
  matcher acceptance for that mode (extends the existing parity tests).
- `bun test ./src` + `bun test ./core/src` + `bun run typecheck` green.
