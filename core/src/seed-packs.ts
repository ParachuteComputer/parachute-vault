/**
 * Named seed packs — curated starter content a vault can be seeded with, plus
 * the generic idempotent applier.
 *
 * A pack is a named bundle of `tags` (upserted) + `notes` (created only when
 * no note already lives at the path). Three packs ship today:
 *
 *   - `welcome` — the five-guide welcome ring (Welcome, Capture anything, Tags
 *     and the graph, Connect your AI, Yours to keep) + the `capture` / `guide`
 *     tags the Notes surface expects. Default-seeded on creation.
 *   - `getting-started` — the AI-facing start-here guide (SKILL.md-style
 *     doctrine addressed to a connected assistant). Default-seeded.
 *   - `surface-starter` — the living starter guide for building a custom
 *     surface (UI) over the vault. NOT default-seeded (ratified 2026-07-02:
 *     Surface Starter is out of the default seed) — added on demand via
 *     `parachute-vault add-pack surface-starter` or a console affordance.
 *   - `starter-ontology` — four starter **meta tags** (`view`, `archived`,
 *     `pinned`, `capture`) with constitution-style descriptions, plus seed
 *     `#view` notes mirroring the app's default pages (All notes, Recent,
 *     Pinned, Archive). NOT default-seeded (ratified 2026-07-16 design
 *     dialogue — deliberately opt-in; a fresh-vault materialization change
 *     needs its own decision) — added on demand via `parachute-vault
 *     add-pack starter-ontology` or a console affordance.
 *
 * Guides are the vault's skill files — the Parachute equivalent of a
 * `SKILL.md`. They're tagged `#guide` (GUIDE_TAG): notes that teach how this
 * vault works and how to work it, for you and your AI alike. Some (the welcome
 * ring) are voiced to the person; some (Getting Started) to the assistant; all
 * are plain markdown either reads — so no per-guide audience field is needed.
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
  'This is a brand-new personal vault — just its starter guides so far; the person it belongs to is probably new to Parachute. Before helping them set it up, read the "Getting Started" note — it\'s your onboarding brief. Short version: start with a conversation, not a filing system; learn how they want to use this and where their notes live today; do one small real thing first. When the vault has real structure, replace this description (vault-info { description: "..." } — an admin-scope action) with a current picture of what lives here and how to work it — so every future session, yours or another AI\'s, starts oriented.';

/**
 * The `vault-info` description a vault gets when it was **imported/restored** —
 * it arrived with content. Flips the AI's first job from seed-it to learn-it:
 * orient over the existing shape, reflect it back, and only then replace this
 * text with a current picture.
 */
export const IMPORTED_VAULT_DESCRIPTION =
  'This vault was imported — it arrived with its own notes, tags, and history. Orient before you write: vault-info { include_stats: true }, list-tags, read a sample, and read "Getting Started" if present. Your first job is to learn the shape that\'s already here and reflect it back to the person — not to propose new structure cold. When you understand it, replace this description (vault-info { description: "..." } — an admin-scope action) with a current picture.';

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
 * equivalent of a `SKILL.md`: notes that teach how this vault works and how to
 * work it, for you and your AI alike. Plain markdown, so either reads them.
 *
 * Declared by every pack that ships guide notes (welcome / getting-started /
 * surface-starter). The upserts converge on one row, so each pack stays
 * self-sufficient — applying any one of them alone still lands the tag.
 */
export const GUIDE_TAG: SeedPackTag = {
  name: "guide",
  description:
    "Guides — the vault's skill files. Notes that teach how this vault works and how to work it, for you and your AI alike. Plain markdown, so either reads them.",
};

export const WELCOME_PATH = "Welcome to your vault 🪂";
export const CAPTURE_ANYTHING_PATH = "Capture anything";
export const TAGS_GRAPH_PATH = "Tags and the graph";
export const CONNECT_AI_PATH = "Connect your AI";
export const YOURS_TO_KEEP_PATH = "Yours to keep";

/**
 * Build the `welcome` pack: the five-guide welcome ring — Welcome, Capture
 * anything, Tags and the graph, Connect your AI, Yours to keep — plus the
 * `capture` / `guide` tags. The guides are ordinary notes tagged `#guide`
 * (the vault's skill-file tag). They form a
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
      "The five-guide welcome ring (Welcome, Capture anything, Tags and the graph, Connect your AI, Yours to keep) — the vault's #guide skill files — plus the capture/guide tags. Seeded by default on new vaults.",
    // capture (Notes surface) + guide (the skill-file tag). Upserts are idempotent.
    tags: [...NOTES_REQUIRED_TAGS, GUIDE_TAG],
    // `[[wikilinks]]` resolve by note path — pending links auto-resolve when
    // the target is created, so order only affects how briefly a link sits
    // unresolved during the seed. Every [[target]] here resolves to a note the
    // default seed writes (the four siblings + [[Getting Started]] from the
    // getting-started pack) — no dangling links on a fresh vault.
    notes: [
      {
        path: WELCOME_PATH,
        tags: ["guide"],
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

**Capture first, ask second.** If the person's very first message already names
something real — a live project, a decision they're weighing, a deadline —
**capture THAT as the first note from what they've told you, before asking for
more detail.** Don't interview them into an empty vault: the note you can
already write is worth more than the three you're still asking about, and your
questions land better as the follow-up to a captured thing ("got the commission
down — when's it due, and who's the client?") than as the opener. A good first
conversation that leaves the vault empty is a miss, not a success — something
they said should have stuck.

Five short guides ship in this vault for the person to read (tagged \`#guide\`):
[[Welcome to your vault 🪂]], [[Capture anything]], [[Tags and the graph]],
[[Connect your AI]], and [[Yours to keep]]. Point them there for anything you'd
otherwise lecture about — they're the return-point between sessions. If a
session ends mid-setup, leave a breadcrumb (update this note or the vault
description) so the next one picks up where you left off.

### If this vault already has content

Some vaults arrive full — an import, a restore, months of use. Then your first
job is to **learn it, not seed it**: \`vault-info\` — a single call now returns
a compact \`map\` (every tag's note count, every top-level path's note count,
total notes) alongside the schema catalog, so you get the shape of a strange
vault in one round trip; add \`include_stats: true\` only if you also want the
deeper monthly distribution. Then \`list-tags\` and read a sample
(\`query-notes { search: "..." }\`), and reflect the shape back to the person
and ask what's missing or wrong. Propose structure only once you can describe
what's already there.

### Close the loop: describe the vault

When the first real structure lands, update the vault description —
\`vault-info { description: "..." }\`, an \`admin\`-scope action — so every future
session (yours or another AI's) starts oriented: what this vault is for, its main tags, its conventions.
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

Core moves, grouped by the scope each needs — \`tools/list\` shows exactly the
ones your token can call (see "What your scope allows" below):
- **Read:** \`query-notes\` (by id/path, by tag, full-text \`search\`, or graph
  \`near\` a note), \`list-tags\`, \`find-path\` (shortest link path between two
  notes), \`vault-info\` (the live schema projection + a compact \`map\` — tag
  counts, top-level path-bucket counts, total notes — so you orient in one
  call), \`doctor\` (read-only integrity scan).
- **Write:** \`create-note\` / \`update-note\` / \`delete-note\` — author notes,
  single or batch.
- **Admin:** \`update-tag\` / \`delete-tag\` / \`rename-tag\` / \`merge-tags\` /
  \`prune-schema\` (the tag vocabulary + schemas), \`vault-info { description }\`
  (the vault's own description), \`manage-token\` (mint scoped child tokens).

\`[[wikilinks]]\` in note content auto-link to the note at that path — use them
freely; they resolve even if the target is created later.

## What your scope allows

Your connection carries one of three scopes, and it shapes what you can do here
— by design, so the person can grant exactly as much authority as they mean to:

- **\`read\`** — explore and answer: query notes, read tags, traverse the graph,
  run \`doctor\`. You can't change anything.
- **\`write\`** — everything read can do, plus author content: create, update,
  and delete notes. You can capture and edit freely, but you *can't* reshape the
  vault's structure — renaming/merging/deleting tags, editing schemas, and
  rewriting the vault description all need admin.
- **\`admin\`** — everything, including that restructuring, plus minting scoped
  child tokens.

If a tool this guide mentions fails with "Unknown tool" — or a normally-visible
tool refuses one argument with "Forbidden" (e.g. \`vault-info { description }\`
for a non-admin) — that's your scope, not a bug: the action sits above your
tier. Don't fight it: tell the person plainly
what you'd do with more access ("I can add notes, but reorganizing your tags
needs admin — want to grant it?") and let them decide. Most people connect with
admin, so usually you'll have the whole set.

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
  \`update-tag\`, an \`admin\`-scope move) to declare typed metadata fields — e.g. \`#meeting\` with a
  \`held_on\` date, \`#person\` with an \`email\`. Each field can **optionally** be
  marked \`indexed: true\` to make it **queryable with operators** (\`query-notes
  { tag: "meeting", metadata: { held_on: { gte: "2026-01-01" } } }\`); indexing
  is opt-in per field, not automatic. Add a schema (and index a field) when you
  find yourself wanting to filter or sort on a value, not before. **Field names
  are global across the vault, not scoped per tag** — two tags that declare the
  same field name must agree on its type. So prefer a tag-specific name
  (\`price_tier\` on \`#restaurant\`, \`book_rating\` on \`#book\`) over a generic
  shared one (a \`rating\` that means 1–10 on one tag and \`$\`–\`$$$$\` on another
  collides); when in doubt, name the field for the tag it belongs to.

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
    held_on: { type: "string", indexed: true },                                         // queryable with operators
    status:  { type: "string", enum: ["scheduled", "done"], default: "scheduled" },      // explicit default — declare one to auto-fill
    meeting_rating: { type: "integer" }                                                 // no default — stays unset until written; tag-specific name, not a bare rating
  }
}
\`\`\`

\`fields\` is **merged** (new keys added, existing replaced); \`parent_names\` and
\`relationships\` are replaced wholesale when passed. Only \`indexed: true\` fields
support operator queries (\`metadata: { held_on: { gte: "..." } }\`) and
\`order_by\`; all tags declaring the same field must agree on its \`type\` and
\`indexed\` flag.

## A few shapes worth reusing

Testers of this vault independently reinvented these — start from them instead:

- **Journaling.** One tag (\`#journal\`) with an indexed \`entry_date\`
  (\`{ type: "string", indexed: true }\`, ISO date) and a \`mood\` enum
  (\`{ type: "string", enum: [...] }\`). Indexing \`entry_date\` (see "Only
  \`indexed: true\` fields support operator queries" above) is what makes
  date-range queries (\`metadata: { entry_date: { gte: "2026-01-01" } }\`) and
  \`order_by: "entry_date"\` work.
- **Agent memory (thread + messages, crash-replay-safe).** Model a
  conversation as one \`#thread\` note (metadata: \`status\`, \`cursor\`) plus many
  \`#message\` notes linked to it (\`relationship: "in-thread"\`), each carrying
  its own \`status\`. If your write loop can crash and replay the same message,
  give it a stable \`path\` (e.g. \`Threads/<thread-id>/msg-<n>\`) and create it
  with \`if_exists: "ignore"\` — a retry after a crash safely returns the
  already-written message instead of creating a duplicate, no
  query-before-write round trip needed.
- **Search.** \`query-notes { search: "..." }\` is literal by default — your
  text is escaped, not parsed as FTS5 syntax, so punctuation like "didn't" or
  "18.6" just works. Pass \`search_mode: "advanced"\` only when you actually
  want FTS5 boolean/phrase/prefix syntax.
- **A front-door "Map" note.** Once a vault grows past a few dozen notes,
  keep one note (path \`Map\`, or whatever fits) as a human-legible index —
  the tags and top-level paths that matter and what each means, with
  wikilinks into anchor notes. It's the "why" companion to \`vault-info\`'s
  auto-computed \`map\` (tag/path-bucket counts, the "what's there"): the
  counts tell a fresh AI the shape of the vault in one call, this note tells
  it what that shape MEANS. Update it when the vault's structure shifts;
  link to it from the vault description so it's easy to find.

## Write gotchas

A few behaviors worth knowing before you write at scale:

- **\`update-note\` requires optimistic concurrency by default.** Pass
  \`if_updated_at\` with the \`updated_at\` you last read; a mismatch returns a
  conflict error (re-read, reconcile, retry). For bulk/scripted writes where
  concurrency is known-safe, pass \`force: true\` to waive the *requirement to
  supply* it. \`append\`/\`prepend\`-only updates are exempt (no-conflict-by-design).
- **A schema field only back-fills when you declare an explicit \`default\`.**
  When a note gets a tag whose schema declares a field with a \`default\`, an
  unset field is filled with THAT value. A field with no \`default\` stays
  genuinely absent — \`query-notes { metadata: { meeting_rating: { exists: false } } }\`
  reliably finds notes that never set \`meeting_rating\`. Declare \`default\` on a field
  only when "unset" and "explicitly set to X" should read the same; leave it
  off when you need to tell them apart.
- **Validation is advisory, never blocking — EXCEPT an \`indexed: true\`
  field's type.** A type/enum mismatch on a non-indexed field (or a
  non-\`strict\` constraint on any field) comes back as a \`validation_status\`
  warning and the write still lands — read those warnings and self-correct on
  the next turn. An \`indexed: true\` field's TYPE is always enforced, though:
  writing a string into an indexed \`integer\` field is REJECTED with a
  \`schema_validation\` error, because a bad-typed value would otherwise
  silently poison range queries (\`gt\`/\`gte\`/\`lt\`/\`lte\`) on that field. Mark a
  field \`strict: true\` to enforce its OTHER constraints
  (enum/required/cardinality) the same hard way.

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

## Deploying your surface

A surface is a **static build** — there's no server to run. \`bun run build\`
produces a \`dist/\` of plain HTML/JS/CSS that any static host serves: GitHub
Pages, Cloudflare Pages, Netlify, an S3 bucket.

For **GitHub Pages**, push the BUILT FILES to a \`gh-pages\` branch (or a
\`docs/\` folder on your default branch) and point Settings → Pages at it.
Deliberately: **don't reach for an Actions workflow.** Some agent GitHub
integrations can't write \`.github/workflows/*\` — the push comes back 403 —
and a static build doesn't need CI at all. Build locally, publish the output.

Two things must line up or the deployed surface will load and then fail to
sign in:

- the **hub origin** your surface points at has to be reachable from wherever
  the browser is (a \`localhost\` hub won't answer a page served from GitHub
  Pages);
- that surface's **origin must be trusted by the hub** for CORS + as an OAuth
  redirect origin.

Both trace back to the same place the \`createVaultSurface\` config above does:
\`vault-info\`'s **"This vault's coordinates"** block reports this vault's hub
origin and name. If sign-in fails from the deployed URL but works from
\`localhost\`, suspect the origin allowlist before the code.

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
// `starter-ontology` pack — four starter meta tags (opt-in)
// ---------------------------------------------------------------------------

/**
 * The starter ontology, ratified in the 2026-07-16 design dialogue (Letter 1,
 * Q5: "yes — tiny, opinionated, removable"): exactly four tags, no more.
 * "Really want to start simple" / "don't be too prescriptive" — the vault
 * ships the mechanisms; each parachute writes its own rules on top.
 *
 * A **meta tag** (the ratified user-facing term for "a tag with a schema")
 * is `view` alone here — it carries `fields`. `archived`, `pinned`, and
 * `capture` are plain tags: no schema, just a description that teaches the
 * convention. Every description below is written as a constitution — it's
 * read by both a human deciding whether to use the tag and an agent deciding
 * how to behave around it — plain and warm, describing the DEFAULT
 * convention rather than dictating one ("different people will draw that
 * line differently").
 *
 * `capture` is NOT redeclared with new text — it's the exact `NOTES_REQUIRED_TAGS`
 * entry, reused verbatim, because notes-ui's connect-time schema audit
 * compares its `description` byte-for-byte (see the comment on
 * `NOTES_REQUIRED_TAGS` above). Applying this pack must never be able to
 * drift that string out from under the welcome pack, in either apply order.
 *
 * `pinned` shipped once before and was dropped as vestigial (PR #547,
 * 2026-07-07): it was seeded onto `Welcome` with old sort-first semantics,
 * which did nothing visible on a fresh vault (the Notes app had no list
 * badge, and Welcome was already first). This is a different tag: the
 * ratified semantics are partition-not-sort, it isn't stamped onto any
 * existing note, and the pack ships a `Pinned` view that actually surfaces
 * it.
 */
export const VIEW_TAG: SeedPackTag = {
  name: "view",
  description:
    'A meta tag — it carries a schema, which is what makes a #view note a saved view rather than just a label. Tag a note #view and its metadata becomes the definition: `query` is the saved query itself (the same JSON shape query-notes accepts — tag, exclude_tags, search, metadata, order_by, ...), and `kind` says how to render the result (list, board, calendar, or gallery; an unrecognized or missing kind should degrade to list rather than fail — a view is never wrong to render as a list). `lane_by` names the metadata field a board\'s lanes come from; `date_field` names the date-typed field a calendar plots against — both only meaningful for their matching `kind`, and unset otherwise. The note\'s body is for people: what this view is for, when to reach for it. Because the definition lives in the vault as an ordinary note, any surface can read it and render the same view, and any agent can write one — "make me a board of my active drafts" is just creating a note. Authoring convention worth keeping: most views should write `exclude_tags: ["archived"]` into their own query rather than leaning on some surface-side default — an Archive view is the deliberate exception.',
  fields: {
    kind: {
      type: "string",
      description:
        "How to render this view. Unrecognized or absent degrades to list — a view is never wrong to render as a list.",
      enum: ["list", "board", "calendar", "gallery"],
      default: "list",
    },
    query: {
      type: "string",
      description:
        "The saved query — a JSON string of query-notes parameters (tag, exclude_tags, search, metadata, order_by, sort, ...). This is what actually determines which notes the view shows; kind only says how to draw them.",
    },
    lane_by: {
      type: "string",
      description:
        "Board views only: the metadata field whose distinct values become the board's lanes/columns. Unset outside kind: board.",
    },
    date_field: {
      type: "string",
      description:
        "Calendar views only: the date-typed metadata field the calendar plots notes against. Unset outside kind: calendar.",
    },
  },
};

export const ARCHIVED_TAG: SeedPackTag = {
  name: "archived",
  description:
    "A plain tag — no schema, just a convention: this note is out of the flow of the present. Not deleted, not wrong, just done, closed, or set aside for now. The one behavior worth relying on: default views exclude archived notes unless a view's own query says otherwise (an Archive view, for instance, asks for them back on purpose). Archiving a note doesn't touch its content, tags, or links — it only changes whether it shows up by default. What actually gets archived, and when, is yours to decide: a finished project, last month's drafts, a conversation that's resolved. Different people will draw that line differently, and that's fine — the tag only promises the one thing above.",
};

export const PINNED_TAG: SeedPackTag = {
  name: "pinned",
  description:
    "A plain tag — no schema, just a convention: this note gets surfaced first. Pinning is a partition, not a sort — a view that honors it renders pinned notes as their own small group above everything else, rather than nudging them up the existing order. That also means pinning doesn't fight with however the rest of a view is sorted; it just carves out a \"see this first\" spot above it. There's no built-in limit on how many notes can be pinned, and no rule about what belongs there — a current focus, something you keep needing to find, a note you're mid-thought on. Unpin by removing the tag. Different people, and different views, will use it differently; the tag only promises the placement, not the policy.",
};

export const VIEWS_PATH_PREFIX = "Views/";
export const ALL_NOTES_VIEW_PATH = `${VIEWS_PATH_PREFIX}All notes`;
export const RECENT_VIEW_PATH = `${VIEWS_PATH_PREFIX}Recent`;
export const PINNED_VIEW_PATH = `${VIEWS_PATH_PREFIX}Pinned`;
export const ARCHIVE_VIEW_PATH = `${VIEWS_PATH_PREFIX}Archive`;

/**
 * Build the `starter-ontology` pack: the four meta tags above, plus four
 * seed `#view` notes mirroring the app's default pages — All notes, Recent,
 * Pinned, Archive — so "default app pages are shipped views" has its data
 * half from day one. Each view's `query` is written out explicitly
 * (`exclude_tags: ["archived"]` where it applies) rather than relying on any
 * surface-side default, per the authoring convention in `VIEW_TAG`'s own
 * description. Kept tiny on purpose — these are starting points, not a
 * demonstration of everything the schema can do.
 *
 * NOT applied by `src/onboarding-seed.ts`'s default materialization — opt-in
 * only, via `parachute-vault add-pack starter-ontology` or a console
 * affordance. A fresh-vault UX change (making this part of the default seed)
 * is a separate decision; this pack existing makes that a one-line flip
 * later, deliberately not taken here.
 */
export const STARTER_ONTOLOGY_PACK: SeedPack = {
  name: "starter-ontology",
  description:
    "The starter ontology: one meta tag (view, with a schema) and three plain tags (archived, pinned, capture), each with a constitution-style description — plus four seed #view notes (All notes, Recent, Pinned, Archive) mirroring the app's default pages. Opt-in — not seeded by default.",
  // `capture` reused verbatim from NOTES_REQUIRED_TAGS (byte-equal to the
  // welcome pack's — see the module doc above and NOTES_REQUIRED_TAGS'
  // comment). Order matches the constitution ordering, not upsert order.
  tags: [VIEW_TAG, ARCHIVED_TAG, PINNED_TAG, ...NOTES_REQUIRED_TAGS],
  notes: [
    {
      path: ALL_NOTES_VIEW_PATH,
      tags: ["view"],
      content: `# All notes

Everything in the vault except what's archived. The default view — no tag
filter, no sort override, just the whole thing minus the notes you've set
aside.
`,
      metadata: {
        kind: "list",
        query: JSON.stringify({ exclude_tags: ["archived"] }),
      },
    },
    {
      path: RECENT_VIEW_PATH,
      tags: ["view"],
      content: `# Recent

The vault, newest edits first. Same notes as [[${ALL_NOTES_VIEW_PATH}]] —
archived excluded — just ordered by when they last changed.
`,
      metadata: {
        kind: "list",
        query: JSON.stringify({
          exclude_tags: ["archived"],
          order_by: "updated_at",
          sort: "desc",
        }),
      },
    },
    {
      path: PINNED_VIEW_PATH,
      tags: ["view"],
      content: `# Pinned

Whatever you've marked #pinned — the notes surfaced first, regardless of how
anything else in the vault is organized.
`,
      metadata: {
        kind: "list",
        query: JSON.stringify({ tag: "pinned" }),
      },
    },
    {
      path: ARCHIVE_VIEW_PATH,
      tags: ["view"],
      content: `# Archive

Everything tagged #archived — out of the flow of the present, but never
gone. The one view that asks archived notes back on purpose.
`,
      metadata: {
        kind: "list",
        query: JSON.stringify({ tag: "archived" }),
      },
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
  "starter-ontology",
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
    case "starter-ontology":
      return STARTER_ONTOLOGY_PACK;
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
  /**
   * Subset of `tags` whose DESCRIPTION was left untouched this run because it
   * had been hand-edited away from the pack's canonical text (see
   * `applySeedPack`'s description-preservation rule below). `fields` /
   * `parent_names` / `relationships` are still upserted unconditionally for
   * these tags — only the description write was skipped.
   */
  preservedTagDescriptions: string[];
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
 * The per-note check is check-then-create, so two appliers running at once
 * can both see "absent" and both try to create. The loser's path-UNIQUE
 * rejection is caught and reported as a SKIP (vault#527) — same outcome the
 * non-racing branch reports, because the note it would have written is there.
 * Only a path conflict is absorbed; see `isPathConflict`.
 *
 * **Tag description preservation** (Aaron-ratified 2026-07-17): a pack writes
 * a tag's `description` only when (a) the tag has no prior description (new
 * tag, or an existing bare row nothing ever described), or (b) the prior
 * description is still byte-identical to the pack's own text — i.e. no one
 * has touched it. The moment a description differs from the pack's current
 * text, it's treated as a deliberate hand edit (a user-tuned "constitution")
 * and is never overwritten by a re-apply; omitting the `description` key from
 * the `upsertTagRecord` patch is what preserves it (the store keeps whatever
 * is already there). `fields` / `parent_names` / `relationships` are NOT
 * given this treatment here — they still upsert unconditionally, same as
 * before this change; those axes are more entangled with schema-validation
 * side effects (indexed-column lifecycle, cross-tag type agreement) to
 * safely split out in this pass. Description-only is the ratified scope.
 *
 * Known, accepted tradeoff: this compares against the pack's CURRENT text
 * only, not any prior canonical version. If a pack's canonical description
 * changes upstream, a vault that never touched it reads as "matches the OLD
 * text, therefore edited" from the new pack's point of view, and keeps the
 * old text too — same outcome as a genuine hand edit. That's fine:
 * constitutions aren't security patches that must propagate; a future
 * doctor-style scan can surface "description drifted from the current pack
 * text" as an informational finding without this applier needing to guess
 * intent. See CHANGELOG.
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
    preservedTagDescriptions: [],
    seededNotes: [],
    skippedNotes: [],
  };

  // Parents first so `parent_names` reads naturally in logs (the store accepts
  // forward references, but the order matches the conceptual model).
  for (const decl of pack.tags) {
    const existing = await store.getTagRecord(decl.name);
    const priorDescription = existing?.description ?? null;
    const isUserEdited = priorDescription != null && priorDescription !== decl.description;

    await store.upsertTagRecord(decl.name, {
      // Omitted (not `undefined`-valued) when preserving — `upsertTagRecord`
      // treats an absent `description` key as "keep the current value".
      ...(isUserEdited ? {} : { description: decl.description }),
      ...(decl.parent_names ? { parent_names: decl.parent_names } : {}),
      ...(decl.fields ? { fields: decl.fields } : {}),
    });
    result.tags.push(decl.name);
    if (isUserEdited) result.preservedTagDescriptions.push(decl.name);
  }

  for (const note of pack.notes) {
    const existing = await store.getNoteByPath(note.path);
    if (existing) {
      result.skippedNotes.push(note.path);
      continue;
    }
    try {
      await store.createNote(note.content, {
        path: note.path,
        tags: note.tags,
        metadata: note.metadata,
      });
    } catch (err) {
      // Lost a check-then-create race (vault#527). The `getNoteByPath` above
      // said absent, but another applier committed that path before our
      // insert landed, and the path UNIQUE index rejected us. The OUTCOME is
      // the one this applier already promises — a note exists at that path
      // and we didn't clobber it — so report it the same way the non-racing
      // branch does, as a skip, rather than aborting the pack mid-way with a
      // raw constraint error the operator can only answer by re-running.
      //
      // Narrow by design: ONLY a path conflict is absorbed. Any other create
      // failure still propagates, per this function's "errors propagate"
      // contract above.
      if (!isPathConflict(err)) throw err;
      result.skippedNotes.push(note.path);
      continue;
    }
    result.seededNotes.push(note.path);
  }

  return result;
}

/**
 * Is this the store's "a note already uses that path" rejection?
 *
 * Duck-typed on the STABLE `error_type` / `code` contract (vault#554) rather
 * than `instanceof PathConflictError`, because this module is deliberately
 * import-type-only — it carries no runtime dependency on `notes.ts`/`bun:sqlite`
 * so the cloud Durable Object can share it. Both fields are pinned public API
 * on the self-host class and on the REST/MCP error mapping, so matching them
 * is not a guess about internals.
 */
function isPathConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { error_type?: unknown; code?: unknown; name?: unknown };
  return (
    e.error_type === "path_conflict" ||
    e.code === "PATH_CONFLICT" ||
    e.name === "PathConflictError"
  );
}
