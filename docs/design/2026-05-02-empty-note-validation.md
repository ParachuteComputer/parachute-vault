# Empty-note validation on create

**Status:** draft for review
**Date:** 2026-05-02
**Author:** vault tentacle
**Issue:** [vault#213](https://github.com/ParachuteComputer/parachute-vault/issues/213)
**Reporter:** @omniharmonic (Benjamin) — incident on 2026-04-26, 7,453 empty pathless notes (54% of vault) created in a millisecond burst by a misbehaving MCP client

## What can be created today

Two write paths reach `Store.createNote(content: string, opts?: { path?, tags?, metadata?, ... })`:

1. **HTTP** — `POST /api/notes` (`src/routes.ts:285`), single body or `{notes: [...]}` batch. Per-item: `store.createNote(item.content ?? "", { path: item.path, ... })`. Missing content silently becomes `""`; missing path stays undefined.
2. **MCP** — `create-note` tool (`core/src/mcp.ts:322`), single params or `notes` batch. Same shape: `store.createNote(item.content as string ?? "", { path: ..., ... })`. The tool's `inputSchema` lists `content` as `required` only inside the batch sub-array (top-level single-call has no `required`); even where required, MCP frameworks vary in whether they enforce `required` at runtime.

So `POST /api/notes` with `{notes: [{}, {}, ...]}` and an MCP `create-note` call with `{notes: [{}, {}]}` both produce notes with `path = null`, `content = ""`, `tags = []`, `metadata = {}`. There is no caller-side guard, no batch cap, no rate limit. The 100MB upload limit is for attachment binaries and doesn't apply here.

## What "empty" should mean

There are three empty shapes; only one is junk:

| `content` | `path`  | Meaning                                                                                    | Verdict |
| --------- | ------- | ------------------------------------------------------------------------------------------ | ------- |
| present   | absent  | Un-pathed jot — agents create these all the time, hub MCP UI wires them in                 | KEEP    |
| absent    | present | Placeholder for an unresolved wikilink; pathed schema-effect notes (`_schemas/...`)        | KEEP    |
| absent    | absent  | No identity, no payload, no way to dedupe / search / link / cite — pure noise              | REJECT  |

The third row is what flooded Benjamin's vault. Nothing legitimate produces it.

## Where validation belongs

The natural chokepoint is the Store, not the HTTP route. Store is shared by both write paths and by future ones (a Bun script, a CLI repair tool). Putting the invariant at the HTTP layer leaves the MCP path open until someone adds a duplicate guard there too — which is exactly the maintenance trap that produced this bug (the HTTP route's `?? ""` got copy-pasted into the MCP tool unchanged).

Concretely:

- **`core/src/notes.ts:createNote`** throws a typed error (mirroring `PathConflictError`) when `(content ?? "").length === 0 && !normalizePath(opts?.path)`. Both halves use the same normalization the row insert uses, so trailing whitespace doesn't sneak through.
- **`src/routes.ts` POST handler** catches the typed error and returns `400 { error_type: "empty_note", message: "Note must have either content or path" }`. The error response shape mirrors the existing `path_conflict` 409.
- **`core/src/mcp.ts` create-note executor** lets the typed error propagate as an MCP tool error — the framework already serializes thrown errors back to the agent, and the message is operator-readable.

This is the same Store-as-trust-boundary pattern PathConflictError already uses; the HTTP route translates the typed error to an HTTP code and the MCP tool surfaces it as a tool-call error.

## Batch cap as defense-in-depth

Even with the empty-note guard, a runaway client could still flood with non-empty junk (`[{content: "x"}, {content: "x"}, ...]`). The empty-note guard fixes the diagnosed incident; the batch cap prevents the next variant.

Proposal: **cap `POST /api/notes` and MCP `create-note` at 500 items per call**. Benjamin's incident was thousands of items in one burst; 500 covers any legitimate batch (Obsidian import uses a different path, `createNotes` bulk, which isn't a per-request endpoint). Above the cap, return `400 { error_type: "batch_too_large", limit: 500, received: N }`. Same place as the empty-note check — at the HTTP/MCP entrypoints, not in Store, since "one create at a time" is a transport concern, not a data-model invariant.

## Update path

PATCH `/notes/:idOrPath` (`src/routes.ts:428`) doesn't have the same blast radius — every update requires `if_updated_at` precondition or `force: true`, and each call targets one note. But for consistency: a PATCH that would result in `content = "" && path = null` should be rejected the same way. Cheap to add. Also belongs at the Store boundary (the same `createNote` invariant lives in `updateNote`).

## What I'd want explicit input on before shipping the impl

1. **Batch cap value: 500 or 1000?** Benjamin suggested 500. I'm fine with either; 500 is more conservative.
2. **Update-path symmetry: ship in this PR or follow-up?** I'd ship together — small additional scope, prevents the same-shape bug appearing on update.
3. **Logging on legitimate empty-content (path-only) creates?** Benjamin suggested log warnings for empty content even when path is set. I'd skip — path-only placeholder notes are too common (wikilink resolution, schema config) and the warnings would be noise. The empty+empty rejection already gives the operability signal we need.

## Plan

1. **This PR (doc-only):** ship this design doc, get Aaron's read on the three open questions.
2. **Follow-up PR (impl):** Store invariant in `createNote` + `updateNote`, HTTP error mapping, MCP error propagation, 500-item batch cap on both transports, regression tests covering: bare `{}` body, `{notes: [{}]}` batch, MCP single + batch, oversized batch, valid path-only, valid content-only, update into empty+empty.
