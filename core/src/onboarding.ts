/**
 * Onboarding doctrine — the in-vault guide a freshly-created vault seeds so a
 * connected AI can self-orient and set the vault up on the operator's behalf.
 *
 * This module is the single source of truth for the *content* + the *paths* of
 * the seeded notes. It lives in `core` (not `src`) so both:
 *   - the seeding path (`src/onboarding-seed.ts`, called from `createVault`), and
 *   - the projection/`vault-info` pointer (`core/src/vault-projection.ts`)
 * can share the canonical note paths without a cross-layer import.
 *
 * The notes are AI-legible, practical (SKILL.md-style) guides addressed to the
 * assistant that connects to the vault. They are a starting point, not gospel —
 * Getting Started tells the AI it can adapt them as the vault matures. Seeding is
 * create-time only and idempotent (never clobbers a note the operator/AI has
 * since edited).
 *
 * See the demo-prep Workstream A (A1/A2/A3).
 */

/** Canonical path of the seeded onboarding guide. Top-level, title-cased so it
 *  reads as a doc and sorts to the top of a casual file listing. */
export const GETTING_STARTED_PATH = "Getting Started";

/** Canonical path of the seeded surface-build starter, linked from Getting
 *  Started. */
export const SURFACE_STARTER_PATH = "Surface Starter";

/**
 * Body of the seeded `Getting Started` note.
 *
 * Voice: addressed to the connected AI ("you"), practical, SKILL.md-style.
 * Covers (a) what a Parachute vault is, (b) tags-vs-paths-vs-schemas design,
 * (c) importing existing notes, (d) that it's an adaptable starting point.
 */
export const GETTING_STARTED_CONTENT = `# Getting Started

This is the **start-here guide** for this Parachute vault — think of it like a
\`SKILL.md\`: practical instructions for setting up and growing the vault. Read it
when you're **getting the vault started** or orienting yourself to it — you don't
need to re-read it every session. It's a **starting point, not a script**, and
it's adaptable: edit it (see "Adapt this note") as the vault takes shape.

When the operator says something like *"help me set up my parachute,"* this is
your brief: design their structure with them, import what they already have, and
shape the vault around how they actually think and work.

## What a Parachute vault is

A vault is **notes + tags + links** in one graph, reachable over MCP (you, now),
a REST API (scripts), and any surface (a UI). It ships *blank* — no predefined
tags or schema. You and the operator design the structure that fits *their*
life and work. The vault is the engine; the meaning is yours to bring.

Core moves you already have as MCP tools:
- \`create-note\` / \`update-note\` / \`delete-note\` — write notes (single or batch).
- \`query-notes\` — by id/path, by tag, full-text \`search\`, or graph \`near\` a note.
- \`list-tags\` / \`update-tag\` / \`delete-tag\` — manage the tag vocabulary + schemas.
- \`find-path\` — shortest link path between two notes.
- \`vault-info\` — refresh the live schema/stats projection any time.

\`[[wikilinks]]\` in note content auto-link to the note at that path — use them
freely; they resolve even if the target is created later.

## Tags vs paths vs schemas — the design vocabulary

These three axes are the heart of vault design. Use the right one for the job:

- **Tags = types / membership.** A tag answers *"what kind of thing is this?"*
  (\`#person\`, \`#meeting\`, \`#project\`). Queries **expand over tags**: a tag can
  declare \`parent_names\` so \`tag:X\` also returns its subtypes (e.g. tagging a
  note \`#meeting/standup\` with \`parent_names: [meeting]\` means \`query-notes
  { tag: "meeting" }\` finds it). Tags are how you ask *"show me all my people."*
  This is the primary structure — reach for a tag first.

- **Paths = organization / filing.** A path (\`Projects/Acme/Kickoff\`) is *where*
  a note lives — a human-browsable address, unique per note. Paths are for
  folders and named docs (like this one). They do **not** drive type queries;
  don't encode meaning in a path that a tag should carry. A note can have a
  path, tags, or both.

- **Schemas = typed metadata fields.** Attach a schema to a tag (via
  \`update-tag\`) to declare typed metadata fields — e.g. \`#meeting\` with a
  \`held_on\` date, \`#person\` with an \`email\`. Each field can **optionally** be
  marked \`indexed: true\` to make it **queryable with operators** (\`query-notes
  { tag: "meeting", metadata: { held_on: { gte: "2026-01-01" } } }\`); indexing
  is opt-in per field, not automatic. Add a schema (and index a field) when you
  find yourself wanting to filter or sort on a value, not before.

Rule of thumb: **type with tags, file with paths, make-it-queryable with
schemas.** Start minimal — invent tags as real notes need them, declare a
schema only when a query demands it. Over-designing an empty vault is the
common mistake.

(Full design guide, with copy-paste examples: https://parachute.computer/scripting/)

## Importing existing notes

If the operator already keeps notes (Obsidian, Markdown, etc.), bring them in
rather than starting cold:

- **Obsidian / a Markdown folder:** \`parachute-vault import <path>\` — preserves
  frontmatter, tags, \`[[wikilinks]]\`, and file paths.
- **A portable Parachute export** (a dir with \`.parachute/vault.yaml\`): the same
  \`import\` command auto-detects it and does a lossless round-trip (ids, typed
  links, tag schemas, attachments).
- **Ad hoc / pasted content:** just \`create-note\` it. Then help the operator tag
  and schematize: read a sample of imported notes, propose a small tag
  vocabulary, and apply it.

After an import, orient yourself: \`vault-info\` for the new schema picture,
\`list-tags\` to see what vocabulary arrived, \`query-notes { search: "..." }\` to
spot-check. Then propose structure — don't impose it silently.

## Later: a custom surface

Building a custom UI over the vault (a dashboard, a notes app) is usually **not**
the starting point — get the notes and structure right first. If and when the
operator wants one, see **[[Surface Starter]]** (built with
\`@openparachute/surface-client\` + \`@openparachute/surface-render\`).

## Adapt this note

This guide is a **default starting point, not gospel** — edit it to fit this
vault. As you and the operator settle on a tag vocabulary, conventions, or a
surface, you can record that here so a future session inherits the current shape
of the vault instead of this blank-slate default. Useful things to capture:
- the tag vocabulary you've settled on and what each tag means;
- naming/path conventions for this vault;
- which schemas exist and why;
- anything a fresh AI would need to be immediately useful.

Treat setup as a relationship, not a one-time install.
`;

/**
 * Body of the seeded `Surface Starter` note. Linked from Getting Started.
 *
 * A concise, *living* starter prompt for building a custom surface (UI) over
 * the vault using the published surface packages. Tells the AI to import the
 * packages rather than hand-roll OAuth/API/rendering.
 */
export const SURFACE_STARTER_CONTENT = `# Surface Starter

A **surface** is a custom UI over this vault — a dashboard, a notes app, a
single-purpose tool. This note is a living starter for building one *with the
operator*. Update it as you settle on a stack, conventions, or a deployed
surface for this vault.

## Don't hand-roll the plumbing

Two published packages do the heavy lifting — import them instead of writing
OAuth, the vault API client, or note rendering by hand:

- **\`@openparachute/surface-client\`** — \`createVaultSurface(...)\` wires up
  Parachute OAuth (sign-in on first connect) and a typed vault API client
  (query/create/update notes, tags, links) so your app code just calls methods.
- **\`@openparachute/surface-render\`** — \`<NoteRenderer>\` and friends render note
  content (Markdown, wikilinks, embeds) the way the rest of the ecosystem does,
  so your surface looks native without re-implementing the renderer.

## Build order

1. **Auth + data first.** Stand up \`createVaultSurface\` pointed at this vault;
   confirm you can sign in and \`query-notes\` round-trips before any UI polish.
2. **Render next.** Drop in \`<NoteRenderer>\` to display note content; wire
   wikilink/embed resolution through the package, not by hand.
3. **UX last.** Layout, navigation, and the surface's actual purpose — now that
   auth, data, and rendering are solid.

## Design it around this vault's structure

A good surface is shaped by the vault's tags + schemas (see [[Getting Started]]
for the tags-vs-paths-vs-schemas design vocabulary). Query by the tags that
matter to the operator; surface the indexed fields they filter on. If the vault
doesn't yet have the structure a surface wants, that's a signal to design tags +
schemas first.

## Adapt this note

When you build a surface for this vault, record it here: what it's for, the
stack, how to run it, the queries it depends on. The next session should be able
to pick it up from this note.

(More on the surface stack + examples: https://parachute.computer/scripting/)
`;
