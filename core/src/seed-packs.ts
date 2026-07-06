/**
 * Named seed packs — curated starter content a vault can be seeded with, plus
 * the generic idempotent applier.
 *
 * A pack is a named bundle of `tags` (upserted) + `notes` (created only when
 * no note already lives at the path). Three packs ship today:
 *
 *   - `welcome` — the five-guide welcome ring (Welcome, Capture anything, Tags
 *     and the graph, Connect your AI, Yours to keep) + the `capture` / `guide`
 *     / `pinned` tags the Notes surface expects. Default-seeded on creation.
 *   - `getting-started` — the AI-facing start-here guide (SKILL.md-style
 *     doctrine addressed to a connected assistant). Default-seeded.
 *   - `surface-starter` — the living starter guide for building a custom
 *     surface (UI) over the vault. NOT default-seeded (ratified 2026-07-02:
 *     Surface Starter is out of the default seed) — added on demand via
 *     `parachute-vault add-pack surface-starter` or a console affordance.
 *
 * Guides are the vault's skill files — the Parachute equivalent of a
 * `SKILL.md`. They're tagged `#guide` (GUIDE_TAG). Written for a connected AI
 * first (it reads them to learn the vault), but they're plain markdown, so the
 * human reads them just as well — no per-guide audience field is needed.
 *
 * This module is the single source of truth for pack content across BOTH
 * runtimes: the bun vault (`src/onboarding-seed.ts` default seed + the
 * `add-pack` CLI verb) and the cloud vault DO (parachute-cloud
 * `workers/vault` — a sibling PR consumes these packs in place of its own
 * `welcome.ts` copy). Keep `applySeedPack` to single-item Store calls: the
 * cloud DO routes them through its real `transactionSync` seam, and its
 * conformance suite pins a zero-raw-BEGIN tripwire.
 *
 * `core/src/onboarding.ts` remains as a deprecated re-export shim for the
 * Getting Started / Surface Starter path + content constants.
 */

import type { Store, TagFieldSchema } from "./types.ts";

// ---------------------------------------------------------------------------
// Default vault descriptions — the single source of truth
// ---------------------------------------------------------------------------

/**
 * The `vault-info` description a **brand-new** vault ships with. It's the first
 * thing a connected AI reads about the vault, so it doubles as a nudge: orient
 * the person, read the Getting Started brief, do one small real thing, and — once
 * real structure lands — REPLACE this text with a current picture of the vault.
 *
 * Exported as the single source of truth; the runtimes (bun vault default seed +
 * cloud vault DO) consume it in a follow-up PR. Not wired into `applySeedPack`
 * here — a description is vault metadata, not a pack note.
 */
export const DEFAULT_VAULT_DESCRIPTION =
  'This is a brand-new personal vault — just its starter guides so far; the person it belongs to is probably new to Parachute. Before helping them set it up, read the "Getting Started" note — it\'s your onboarding brief. Short version: start with a conversation, not a filing system; learn how they want to use this and where their notes live today; do one small real thing first. When the vault has real structure, replace this description (vault-info { description: "..." }) with a current picture of what lives here and how to work it — so every future session, yours or another AI\'s, starts oriented.';

/**
 * The `vault-info` description a vault gets when it was **imported/restored** —
 * it arrived with content. Flips the AI's first job from seed-it to learn-it:
 * orient over the existing shape, reflect it back, and only then replace this
 * text with a current picture.
 */
export const IMPORTED_VAULT_DESCRIPTION =
  'This vault was imported — it arrived with its own notes, tags, and history. Orient before you write: vault-info { include_stats: true }, list-tags, read a sample, and read "Getting Started" if present. Your first job is to learn the shape that\'s already here and reflect it back to the person — not to propose new structure cold. When you understand it, replace this description (vault-info { description: "..." }) with a current picture.';

// ---------------------------------------------------------------------------
// Pack shape
// ---------------------------------------------------------------------------

/**
 * A tag declaration a pack upserts (identity row, not a schema migration).
 *
 * `fields` carries an optional typed-metadata schema — the same
 * `Record<field, { type, enum?, indexed? }>` shape `update-tag` accepts — so a
 * pack can declare a schema-carrying tag. The applier passes it straight
 * through to `upsertTagRecord`.
 */
export interface SeedPackTag {
  name: string;
  description: string;
  parent_names?: string[];
  fields?: Record<string, TagFieldSchema>;
}

/**
 * A note a pack seeds — created only when no note exists at `path`. `tags` +
 * `metadata` are applied at create time (both runtimes' `createNote` accepts
 * them); a guide note carries `tags: ["guide"]`.
 */
export interface SeedPackNote {
  path: string;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** A named bundle of starter tags + notes. */
export interface SeedPack {
  /** Stable pack name — the `add-pack <name>` handle. */
  name: string;
  /** One-line human description (shown by the pack listing). */
  description: string;
  tags: ReadonlyArray<SeedPackTag>;
  notes: ReadonlyArray<SeedPackNote>;
}

// ---------------------------------------------------------------------------
// `welcome` pack — person-voiced first-minute content
// ---------------------------------------------------------------------------

/**
 * The tag Notes requires — name/description must stay BYTE-EQUAL to notes-ui's
 * `NOTES_REQUIRED_SCHEMA`
 * (parachute-surface/packages/notes-ui/src/lib/vault/schema.ts): the PWA's
 * connect-time audit (schema-audit.ts) compares `description` verbatim, so its
 * schema banner clears because the tag genuinely exists with the semantics
 * Notes declares — not because we gamed the check. Do not edit these strings
 * without changing notes-ui in lockstep.
 *
 * ONE tag since 2026-07-03 (Aaron-ratified): `#capture` carries the sacred
 * raw-input semantics; entry method (text vs voice) is provenance, not
 * user-facing taxonomy, and moves to note `metadata.source` (`text` | `voice`)
 * — a sibling notes-ui PR lands the client side. The old `capture/text` /
 * `capture/voice` subtype tags are no longer seeded; existing vaults that
 * carry them remain valid (tags are user data — this changes only what NEW
 * vaults get).
 */
export const NOTES_REQUIRED_TAGS: ReadonlyArray<SeedPackTag> = [
  {
    name: "capture",
    description: "Notes captured directly by the user (text or voice).",
  },
];

/**
 * The `guide` tag — the vault's skill-file tag. Guides are the Parachute
 * equivalent of a `SKILL.md`: notes that teach a connected AI (and the human it
 * belongs to) how this vault works and how to work it. Written for the AI
 * first; plain markdown, so the human reads them just as well.
 *
 * Declared by every pack that ships guide notes (welcome / getting-started /
 * surface-starter). The upserts converge on one row, so each pack stays
 * self-sufficient — applying any one of them alone still lands the tag.
 */
export const GUIDE_TAG: SeedPackTag = {
  name: "guide",
  description:
    "Guides — the vault's skill files. Notes that teach a connected AI (and the human it belongs to) how this vault works and how to work it. Written for the AI first; plain markdown, so a good read for the human too.",
};

/** The `pinned` tag — notes pinned to the top of the Notes app. No schema. */
export const PINNED_TAG: SeedPackTag = {
  name: "pinned",
  description: "Notes pinned to the top of the Notes app.",
};

export const WELCOME_PATH = "Welcome to your vault 🪂";
export const CAPTURE_ANYTHING_PATH = "Capture anything";
export const TAGS_GRAPH_PATH = "Tags and the graph";
export const CONNECT_AI_PATH = "Connect your AI";
export const YOURS_TO_KEEP_PATH = "Yours to keep";

/**
 * Build the `welcome` pack: the five-guide welcome ring — Welcome, Capture
 * anything, Tags and the graph, Connect your AI, Yours to keep — plus the
 * `capture` / `guide` / `pinned` tags. The guides are ordinary notes tagged
 * `#guide` (the vault's skill-file tag); Welcome is also `#pinned` so it sits
 * at the top of the Notes app. They form a
 * small linked web (Welcome → all four; the rest chain 2→3→4→5→1; Connect
 * your AI also links the AI-facing [[Getting Started]]) so the graph view
 * shows a connected structure from minute one. Deletable like anything else.
 *
 * These five bodies are the ratified guides (already live at
 * parachute.computer/guides). `consoleOrigin` is the origin of the operator's
 * console (the cloud console, or a hub portal) — when known, the Connect-your-AI
 * note names it; when omitted (the bun vault seeds at create time, often
 * pre-expose, and must never bake in a loopback origin) the line stays generic.
 */
export function welcomePack(opts: { consoleOrigin?: string } = {}): SeedPack {
  const consoleLine = opts.consoleOrigin
    ? `Grab the connection URL from your console at ${opts.consoleOrigin}.`
    : `Grab the connection URL from your console.`;
  const guideNote = { tags: ["guide"] };
  return {
    name: "welcome",
    description:
      "The five-guide welcome ring (Welcome, Capture anything, Tags and the graph, Connect your AI, Yours to keep) — the vault's #guide skill files — plus the capture/guide/pinned tags. Seeded by default on new vaults.",
    // capture (Notes surface) + guide (the skill-file tag) + pinned
    // (top-of-app). Upserts are idempotent.
    tags: [...NOTES_REQUIRED_TAGS, GUIDE_TAG, PINNED_TAG],
    // `[[wikilinks]]` resolve by note path — pending links auto-resolve when
    // the target is created, so order only affects how briefly a link sits
    // unresolved during the seed. Every [[target]] here resolves to a note the
    // default seed writes (the four siblings + [[Getting Started]] from the
    // getting-started pack) — no dangling links on a fresh vault.
    notes: [
      {
        path: WELCOME_PATH,
        tags: ["guide", "pinned"],
        content: `# ${WELCOME_PATH}

This vault is yours.

Write anything — ideas, people, plans, wifi passwords. Notes can link to each
other, like this: [[${CAPTURE_ANYTHING_PATH}]]. Follow that link and keep going — these
guides form a small web you can wander:

- [[${CAPTURE_ANYTHING_PATH}]] — get thoughts in and link them together
- [[${TAGS_GRAPH_PATH}]] — structure that grows out of what you write
- [[${CONNECT_AI_PATH}]] — any AI can read and write your vault
- [[${YOURS_TO_KEEP_PATH}]] — export everything, anytime

They're ordinary notes, tagged #guide. Edit them, add to them, or delete the
lot — the vault is yours, remember.
`,
      },
      {
        path: CAPTURE_ANYTHING_PATH,
        ...guideNote,
        content: `# ${CAPTURE_ANYTHING_PATH}

The one habit that makes a vault work: when a thought strikes, write it down.
Don't sort it. Don't file it. Let it land.

A note can be two words or two pages. The blog idea on a trail, the follow-up
from a meeting, the dream at 2am — capture first. Organizing can happen later,
or never; that's what tags and your AI are for.

To connect two notes, wrap a note's name in double square brackets:
[[${WELCOME_PATH}]] is a link back to where you started. If the note
doesn't exist yet, the link waits patiently and connects the moment it does.

That's the whole trick. Storage is easy — connection is everything. A linked
note is a thought your future self, and your AI, can find again.

Next: [[${TAGS_GRAPH_PATH}]].
`,
      },
      {
        path: TAGS_GRAPH_PATH,
        ...guideNote,
        content: `# ${TAGS_GRAPH_PATH}

Notes and links come first. Tags come later, when you notice a pattern.

A tag answers "what kind of thing is this?" — #person, #recipe, #idea. Tag a
few notes the same way and a view lights up: all your people, all your recipes,
everything half-finished. Your vault starts with just two:

- #capture — the Notes app puts it on whatever you write or speak in directly,
  marking your own raw words.
- #guide — these notes.

Underneath, everything is one graph: every note a node, every link an edge.
Open the graph view and watch it grow; ask a connected AI "what's near this
note?" and it walks the edges for you.

The structure isn't a filing system you design on day one. It grows out of what
you actually write — so don't over-organize an empty vault. Write, link, and
let the shape appear.

Next: [[${CONNECT_AI_PATH}]].
`,
      },
      {
        path: CONNECT_AI_PATH,
        ...guideNote,
        content: `# ${CONNECT_AI_PATH}

Your vault speaks MCP — an open standard — so any AI can read and write it:
Claude, ChatGPT, Claude Code, Cursor, or an agent you build. ${consoleLine}

Once you're connected, try:

- "Read the Getting Started note and help me set this vault up."
- "What did I want to write about?"
- "Tag my untagged notes."

Your AI sees what you see — the same notes, links, and tags — and what it
writes lands here, as notes you can read, edit, or delete. There's even a note
in this vault written for it: [[${GETTING_STARTED_PATH}]], the vault-design brief your
AI reads so you don't have to.

One memory, shared with every AI you choose to connect. That's the point.

Next: [[${YOURS_TO_KEEP_PATH}]].
`,
      },
      {
        path: YOURS_TO_KEEP_PATH,
        ...guideNote,
        content: `# ${YOURS_TO_KEEP_PATH}

Everything here — every note, tag, and link — exports as plain markdown files
with the structure intact. On Parachute Cloud, it's the Export button in your
console. Self-hosting, it's one command: \`parachute-vault export <dir>\`.

What you get is a folder any app can open, and another Parachute can import
losslessly. Move from our cloud to your own machine, or the other way — same
software, same format, nothing held hostage between the doors.

We build it this way on purpose. A connection you can't leave isn't a
relationship. You can always leave — which is exactly why you can trust
staying.

Export isn't a feature we grudgingly support; it's the moral center of the
design. We test it constantly, because a promise you don't test is just a
hope.

Back to [[${WELCOME_PATH}]].
`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// `getting-started` pack — the AI-facing start-here guide
// ---------------------------------------------------------------------------

/** Canonical path of the seeded onboarding guide. Top-level, title-cased so it
 *  reads as a doc and sorts to the top of a casual file listing. */
export const GETTING_STARTED_PATH = "Getting Started";

/** Canonical path of the seeded surface-build starter (the `surface-starter`
 *  pack — NOT seeded by default; see the module doc). */
export const SURFACE_STARTER_PATH = "Surface Starter";

/**
 * Body of the seeded `Getting Started` note.
 *
 * Voice: addressed to the connected AI ("you"), warm and practical, SKILL.md-style.
 * ONE note, two labeled parts:
 *   - Part 1 — Onboarding the person: lead with a real conversation, leverage
 *     prior context, offer to survey their content, do one small real thing
 *     first, the data-in menu (import UI / MCP bridge / paste-and-file — NOT the
 *     CLI, NOT Obsidian-first), the arrived-with-content branch, and closing the
 *     loop by updating the vault description (see DEFAULT_VAULT_DESCRIPTION).
 *   - Part 2 — Vault mechanics: the preserved reference — what a vault is + the
 *     tool list, tags-vs-paths-vs-schemas, write gotchas, the custom-surface
 *     pointer, and "Adapt this note."
 *
 * Deliberately points AIs at the import UI + MCP bridge, never at a
 * `parachute-vault import` CLI (that verb doesn't exist on cloud — the old copy
 * shipped that live bug to every hosted user). Mentions the Surface Starter PACK
 * by name (no wikilink — the note isn't seeded by default, and a dangling
 * `[[Surface Starter]]` would sit unresolved on every fresh vault).
 */
export const GETTING_STARTED_CONTENT = `# Getting Started

This is the **start-here guide** for this Parachute vault — instructions for a
connected AI (you), like a \`SKILL.md\`. Read it when the vault is new, when
you're orienting yourself, or when the person says *"help me set up my
parachute."* You don't need to re-read it every session. It has two parts:
**how to onboard the person** (start there if they're new) and **vault
mechanics** (reference for operating the vault). It's a starting point, not a
script — and it's editable (see "Adapt this note" at the end).

---

## Part 1 — Onboarding the person

### Start with a conversation, not a filing system

If this vault is fresh, this is probably the person's first real session with
it. Don't start building — orient them, briefly, in your own words: this vault
is **their** memory, one place every AI they choose to connect can read and
write, and they can export all of it anytime as plain markdown. Then have a
real conversation:

- **How do they imagine using this?** A journal, a project brain, a people
  directory, meeting notes, a commonplace book — or they don't know yet
  (that's fine; capture-first works).
- **Where do their notes and data live now?** Another app, a pile of markdown,
  another Parachute — or nowhere yet.
- **What's alive for them right now?** A project, a decision, a trip, a draft.
  The first note should be about something real.

**Use what you already know.** If you have memory or context about this person
from working with them, bring it — propose the two or three kinds of
information *they specifically* would want here ("you mention a lot of book
ideas — want a place for those?"). Propose, confirm, then write; never
bulk-create structure they didn't agree to. You can also **offer to survey**
what they already have — "want me to look through what you've brought in and
suggest a few ways to organize it?" — then read a sample and propose, don't
impose.

### Do one small real thing first

The failure mode of every notes tool is over-organizing an empty vault. So:
**one small real thing this session.** Capture a thought they actually have,
file one document, or bring in one small batch — then stop and show them what
happened. Structure grows from real notes (that's Part 2's design vocabulary).
Setup is a relationship over many sessions, not an install step.

Five short guides ship in this vault for the person to read (tagged \`#guide\`):
[[Welcome to your vault 🪂]], [[Capture anything]], [[Tags and the graph]],
[[Connect your AI]], and [[Yours to keep]]. Point them there for anything you'd
otherwise lecture about — they're the return-point between sessions. If a
session ends mid-setup, leave a breadcrumb (update this note or the vault
description) so the next one picks up where you left off.

### If this vault already has content

Some vaults arrive full — an import, a restore, months of use. Then your first
job is to **learn it, not seed it**: \`vault-info { include_stats: true }\`,
\`list-tags\`, read a sample (\`query-notes { search: "..." }\`), then reflect the
shape back to the person and ask what's missing or wrong. Propose structure
only once you can describe what's already there.

### Close the loop: describe the vault

When the first real structure lands, update the vault description —
\`vault-info { description: "..." }\` — so every future session (yours or another
AI's) starts oriented: what this vault is for, its main tags, its conventions.
The default description says "brand-new vault"; once that stops being true,
replace it. Keep it a few sentences (the projection carries the schema detail,
and this note carries the richer conventions — see "Adapt this note"). Bringing
their existing data in is covered under "Bringing existing notes in" below.

---

## Part 2 — Vault mechanics

## What a Parachute vault is

A vault is **notes + tags + links** in one graph, reachable over MCP (you, now),
a REST API (scripts), and any surface (a UI). It ships *nearly blank* — just a
small welcome web and the \`capture\` tag the Notes surface uses; no other
predefined tags or schema. You and the operator design the structure that fits
*their* life and work. The vault is the engine; the meaning is yours to bring.

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

Declaring a schema is one \`update-tag\` call — the \`fields\` object maps each
field name to \`{ type, enum?, indexed? }\` (\`type\` is \`"string"\`, \`"boolean"\`,
or \`"integer"\`):

\`\`\`
update-tag {
  tag: "meeting",
  description: "A meeting with notes",
  fields: {
    held_on: { type: "string", indexed: true },              // queryable with operators
    status:  { type: "string", enum: ["scheduled", "done"] }, // first enum value is the default
    rating:  { type: "integer" }
  }
}
\`\`\`

\`fields\` is **merged** (new keys added, existing replaced); \`parent_names\` and
\`relationships\` are replaced wholesale when passed. Only \`indexed: true\` fields
support operator queries (\`metadata: { held_on: { gte: "..." } }\`) and
\`order_by\`; all tags declaring the same field must agree on its \`type\` and
\`indexed\` flag.

## Write gotchas

A few behaviors worth knowing before you write at scale:

- **\`update-note\` requires optimistic concurrency by default.** Pass
  \`if_updated_at\` with the \`updated_at\` you last read; a mismatch returns a
  conflict error (re-read, reconcile, retry). For bulk/scripted writes where
  concurrency is known-safe, pass \`force: true\` to waive the *requirement to
  supply* it. \`append\`/\`prepend\`-only updates are exempt (no-conflict-by-design).
- **A schema field's default is filled in on write, so it shows up even when you
  didn't set it.** When a note gets a tag whose schema declares a field, the
  missing field is back-filled: an \`enum\` field → its **first listed value**, an
  \`integer\` → \`0\`, a \`boolean\` → \`false\`, a plain string → \`""\`. So a
  \`rating: { type: "integer" }\` reads as \`0\` on notes nobody rated — that \`0\`
  is "unset," not "rated zero." Order an \`enum\`'s values so the first is a sane
  default, and don't read a back-filled \`0\`/\`""\`/\`false\` as a real value.
- **Validation is advisory, never blocking.** A type/enum mismatch comes back as
  a \`validation_status\` warning on the write response — the write still lands.
  Read those warnings and self-correct on the next turn.

(Full design guide, with copy-paste examples: https://parachute.computer/scripting/)

## Bringing existing notes in

If the person already keeps notes somewhere, help them bring what matters —
start with what's alive for them, not the whole archive. What works today:

- **Connect the source over MCP (the flexible path).** If their AI client can
  add other MCP servers — a Google Drive server, a Notion server, a filesystem
  server — connect it alongside this vault in the same session. Then read from
  there and \`create-note\` here: a selective, conversational migration, no
  export file needed.
- **Paste and file.** They paste anything — a doc, a list, an export — and you
  \`create-note\` it (batch mode for many at once).
- **Import a Parachute export.** Moving between Parachute vaults (cloud ⇄
  self-host) is lossless — on Parachute Cloud, the console's Import button —
  ids, tags, links, schemas, and attachments round-trip.

Bringing a whole Obsidian or Markdown library in is getting easier, and a
flexible import is on the way; for now the connect-over-MCP and paste paths
handle it without anyone touching a terminal. Whatever they bring, offer to
survey it and suggest a first structure — read a sample, propose a small tag
vocabulary, confirm, then apply. Don't impose structure silently.

After bringing content in, orient: \`vault-info\` for the schema picture,
\`list-tags\` for the vocabulary that arrived, \`query-notes { search: "..." }\`
to spot-check.

## Later: a custom surface

Building a custom UI over the vault (a dashboard, a notes app) is usually **not**
the starting point — get the notes and structure right first. When the person
wants one, add the **Surface Starter** guide to this vault — an optional pack
(not installed by default) that covers building a surface with
\`@openparachute/surface-client\` + \`@openparachute/surface-render\`. On Parachute
Cloud it's the console's add-pack affordance.

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

export const GETTING_STARTED_PACK: SeedPack = {
  name: "getting-started",
  description:
    "The AI-facing start-here guide: vault design vocabulary (tags/paths/schemas), imports, write gotchas. Seeded by default on new vaults.",
  // Declares GUIDE_TAG too — each pack is self-sufficient; the upsert converges
  // with the welcome pack's. This guide is written FOR the AI.
  tags: [GUIDE_TAG],
  notes: [
    {
      path: GETTING_STARTED_PATH,
      tags: ["guide"],
      content: GETTING_STARTED_CONTENT,
    },
  ],
};

// ---------------------------------------------------------------------------
// `surface-starter` pack — the surface-build guide (opt-in)
// ---------------------------------------------------------------------------

/**
 * Body of the seeded `Surface Starter` note.
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

## ⚠️ Build a surface in your editor, not from this session

A surface runs **in a browser**: it needs a real OAuth round-trip (a redirect to
the hub's consent screen and back), a dev server to serve the app, and a CORS
origin the hub trusts. **None of that exists in this MCP/chat session** — there's
no browser, no redirect, no dev server. So **don't try to "run" a surface from
the vault session.** Build it in **Claude Code (or your editor)** against a local
dev server (\`vite\`/\`bun dev\`), sign in through the browser there, and iterate.
From *this* session you design the vault structure the surface will consume and
write the code — you can't exercise the OAuth/render loop here.

## Don't hand-roll the plumbing

Two published packages do the heavy lifting — import them instead of writing
OAuth, the vault API client, or note rendering by hand:

- **\`@openparachute/surface-client\`** — \`createVaultSurface(...)\` wires up
  Parachute OAuth (sign-in on first connect) and a typed vault API client
  (query/create/update notes, tags, links) so your app code just calls methods.
- **\`@openparachute/surface-render\`** — \`<NoteRenderer>\` and friends render note
  content (Markdown, wikilinks, embeds) the way the rest of the ecosystem does,
  so your surface looks native without re-implementing the renderer.

## Minimal end-to-end (config → sign-in → query → render)

A React sketch wiring all four steps. \`createVaultSurface\` is the only required
config (its \`clientName\` is the sole required option; \`hubUrl\` defaults to the
page origin, \`vaultName\` to \`"default"\`, \`scope\` to \`"vault:read vault:write"\`).
\`getClient()\` returns a \`VaultClient\` (or \`null\` until signed in) whose
\`queryNotes()\` takes the same query grammar you use over MCP. See
[[Getting Started]] / \`vault-info\` for this vault's NAME and hub origin.

\`\`\`tsx
import { useEffect, useState } from "react";
import { createVaultSurface, type Note } from "@openparachute/surface-client";
import { NoteRenderer } from "@openparachute/surface-render";

// One surface per (hub, vault) config. clientName shows on the consent screen.
const surface = createVaultSurface({
  clientName: "My Vault Surface",
  hubUrl: "https://your-hub.example",   // omit to default to window.location.origin
  vaultName: "default",                 // this vault's name (see vault-info)
});

export function App() {
  const [notes, setNotes] = useState<Note[] | null>(null);

  useEffect(() => {
    (async () => {
      // OAuth: finish a redirect callback if we're on it, else send the browser
      // off to sign in. handleCallback() needs BOTH code + state, so guard on
      // both. (Real apps route /oauth/callback to its own component.)
      const q = new URLSearchParams(location.search);
      if (q.get("code") && q.get("state")) await surface.handleCallback();
      // getClient() builds a FRESH VaultClient on each call — fine here (one-shot
      // effect); in a real component keep it in state/ref, don't call it per render.
      const client = surface.getClient(); // VaultClient | null (null = not signed in)
      if (!client) return void surface.login();
      setNotes(await client.queryNotes({ tag: "note", limit: 20 }));
    })();
  }, []);

  if (!notes) return <p>Connecting…</p>;
  return (
    <>
      {notes.map((n) => (
        // resolve maps a [[wikilink]] target → { href, exists } (or null = inert).
        // You own this href's trust boundary — keep it a fragment (or validate the
        // target). Don't build a raw passthrough href: a vault note could carry a
        // javascript: target.
        <NoteRenderer
          key={n.id}
          note={n}
          resolve={(target) => ({ href: \`#/n/\${encodeURIComponent(target)}\`, exists: true })}
        />
      ))}
    </>
  );
}
\`\`\`

That's the whole spine. \`<NoteRenderer>\` also takes \`linkComponent\` (your
router's \`<Link>\`) and \`fetchBlob\` (\`(url) => Promise<Blob>\`, for auth'd
image/audio embeds) when you need them — both optional.

## Build order

1. **Auth + data first.** Stand up \`createVaultSurface\` pointed at this vault;
   confirm you can sign in and \`queryNotes\` round-trips before any UI polish.
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

export const SURFACE_STARTER_PACK: SeedPack = {
  name: "surface-starter",
  description:
    "A living starter guide for building a custom surface (UI) over this vault with the published surface packages. Opt-in — not seeded by default.",
  // A guide too (written for the AI) — declares GUIDE_TAG so the opt-in
  // add-pack path lands the tag even if this pack is applied on its own.
  tags: [GUIDE_TAG],
  notes: [
    {
      path: SURFACE_STARTER_PATH,
      tags: ["guide"],
      content: SURFACE_STARTER_CONTENT,
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The stable pack-name handles, in listing order. */
export const SEED_PACK_NAMES = [
  "welcome",
  "getting-started",
  "surface-starter",
] as const;

export type SeedPackName = (typeof SEED_PACK_NAMES)[number];

/** List the available packs (name + description) for CLI/console listings. */
export function listSeedPacks(): ReadonlyArray<{ name: string; description: string }> {
  return SEED_PACK_NAMES.map((name) => {
    const pack = getSeedPack(name)!;
    return { name: pack.name, description: pack.description };
  });
}

/**
 * Resolve a pack by name. `opts` only affects the `welcome` pack (its
 * Connect-your-AI note can name the operator's console origin). Returns
 * `null` for an unknown name — callers list the available packs.
 */
export function getSeedPack(
  name: string,
  opts: { consoleOrigin?: string } = {},
): SeedPack | null {
  switch (name) {
    case "welcome":
      return welcomePack(opts);
    case "getting-started":
      return GETTING_STARTED_PACK;
    case "surface-starter":
      return SURFACE_STARTER_PACK;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

export interface ApplySeedPackResult {
  /** The pack that was applied. */
  pack: string;
  /** Tag names upserted (upserts are idempotent; always every declared tag). */
  tags: string[];
  /** Note paths written this run (absent ones). */
  seededNotes: string[];
  /** Note paths skipped because a note already lives there (idempotency). */
  skippedNotes: string[];
}

/**
 * Apply a pack to `store`, idempotently per item: each note is created only
 * when no note exists at its path, and the tag upserts converge on the same
 * rows — so a re-run can never duplicate, and never clobbers a note the
 * operator/AI has since edited or recreated.
 *
 * Errors propagate — best-effort semantics (seed-must-never-fail-a-create)
 * belong to the caller, which knows its failure policy.
 *
 * Uses only single-item Store calls — on the cloud DO they route through the
 * real `transactionSync` seam, keeping the conformance suite's zero-raw-BEGIN
 * tripwire honest.
 */
export async function applySeedPack(
  store: Store,
  pack: SeedPack,
): Promise<ApplySeedPackResult> {
  const result: ApplySeedPackResult = {
    pack: pack.name,
    tags: [],
    seededNotes: [],
    skippedNotes: [],
  };

  // Parents first so `parent_names` reads naturally in logs (the store accepts
  // forward references, but the order matches the conceptual model).
  for (const decl of pack.tags) {
    await store.upsertTagRecord(decl.name, {
      description: decl.description,
      ...(decl.parent_names ? { parent_names: decl.parent_names } : {}),
      ...(decl.fields ? { fields: decl.fields } : {}),
    });
    result.tags.push(decl.name);
  }

  for (const note of pack.notes) {
    const existing = await store.getNoteByPath(note.path);
    if (existing) {
      result.skippedNotes.push(note.path);
      continue;
    }
    await store.createNote(note.content, {
      path: note.path,
      tags: note.tags,
      metadata: note.metadata,
    });
    result.seededNotes.push(note.path);
  }

  return result;
}
