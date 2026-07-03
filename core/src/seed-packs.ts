/**
 * Named seed packs — curated starter content a vault can be seeded with, plus
 * the generic idempotent applier.
 *
 * A pack is a named bundle of `tags` (upserted) + `notes` (created only when
 * no note already lives at the path). Three packs ship today:
 *
 *   - `welcome` — the person-voiced three-note welcome web + the `capture`
 *     tag the Notes surface expects. Default-seeded on vault creation.
 *   - `getting-started` — the AI-facing start-here guide (SKILL.md-style
 *     doctrine addressed to a connected assistant). Default-seeded.
 *   - `surface-starter` — the living starter guide for building a custom
 *     surface (UI) over the vault. NOT default-seeded (ratified 2026-07-02:
 *     Surface Starter is out of the default seed) — added on demand via
 *     `parachute-vault add-pack surface-starter` or a console affordance.
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

import type { Store } from "./types.ts";

// ---------------------------------------------------------------------------
// Pack shape
// ---------------------------------------------------------------------------

/** A tag declaration a pack upserts (identity row, not a schema migration). */
export interface SeedPackTag {
  name: string;
  description: string;
  parent_names?: string[];
}

/** A note a pack seeds — created only when no note exists at `path`. */
export interface SeedPackNote {
  path: string;
  content: string;
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

export const WELCOME_PATH = "Welcome to your vault 🪂";
export const TRY_LINKING_PATH = "Try linking notes";
export const CONNECT_AI_PATH = "Connect your AI";

/**
 * Build the `welcome` pack: a three-note welcome web (welcome → try-linking →
 * back, connect-AI → welcome) so the graph view shows a connected structure
 * from minute one, plus the `capture` tag above. The notes are ordinary
 * notes — no special flags, deletable like anything else.
 *
 * Content is ported EXACTLY from parachute-cloud workers/vault/src/welcome.ts
 * (person-voiced, addressed to the everyday user). `consoleOrigin` is the
 * origin of the operator's console (the cloud console, or a hub portal) —
 * when known, the Connect-your-AI note names it; when omitted (the bun vault
 * seeds at create time, often pre-expose, and must never bake in a loopback
 * origin) the line stays generic.
 */
export function welcomePack(opts: { consoleOrigin?: string } = {}): SeedPack {
  const consoleLine = opts.consoleOrigin
    ? `Grab the connection URL from your console at ${opts.consoleOrigin}.`
    : `Grab the connection URL from your console.`;
  return {
    name: "welcome",
    description:
      "A small linked welcome web (three notes) + the capture tag the Notes surface uses. Seeded by default on new vaults.",
    tags: NOTES_REQUIRED_TAGS,
    // `[[wikilinks]]` resolve by note path — pending links auto-resolve when
    // the target is created, so order only affects how briefly a link sits
    // unresolved during the seed.
    notes: [
      {
        path: WELCOME_PATH,
        content: `# ${WELCOME_PATH}

This vault is yours.
Write anything.
Notes can link to each other, like this: [[${TRY_LINKING_PATH}]].
`,
      },
      {
        path: TRY_LINKING_PATH,
        content: `# ${TRY_LINKING_PATH}

Wrap a note's name in double square brackets to make a wikilink, like this one back to [[${WELCOME_PATH}]].
`,
      },
      {
        path: CONNECT_AI_PATH,
        content: `# ${CONNECT_AI_PATH}

Your vault speaks MCP. ${consoleLine}
Start from [[${WELCOME_PATH}]].
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
 * Voice: addressed to the connected AI ("you"), practical, SKILL.md-style.
 * Covers (a) what a Parachute vault is, (b) tags-vs-paths-vs-schemas design,
 * (c) importing existing notes, (d) that it's an adaptable starting point.
 * Mentions the Surface Starter PACK by name (no wikilink — the note isn't
 * seeded by default, and a dangling `[[Surface Starter]]` would sit unresolved
 * on every fresh vault).
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
operator wants one, add the **Surface Starter** guide to this vault — it's a
seed pack that isn't installed by default. Run
\`parachute-vault add-pack surface-starter\` (or use the console's add-pack
affordance) to seed it; it covers building a surface with
\`@openparachute/surface-client\` + \`@openparachute/surface-render\`.

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
  tags: [],
  notes: [{ path: GETTING_STARTED_PATH, content: GETTING_STARTED_CONTENT }],
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
  tags: [],
  notes: [{ path: SURFACE_STARTER_PATH, content: SURFACE_STARTER_CONTENT }],
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
    });
    result.tags.push(decl.name);
  }

  for (const { path, content } of pack.notes) {
    const existing = await store.getNoteByPath(path);
    if (existing) {
      result.skippedNotes.push(path);
      continue;
    }
    await store.createNote(content, { path });
    result.seededNotes.push(path);
  }

  return result;
}
