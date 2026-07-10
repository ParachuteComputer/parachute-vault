/**
 * Content + registry pins for the named seed packs (core/src/seed-packs.ts).
 *
 * Pure content tests — no DB. The applier's behavior (idempotence, seeding,
 * tag/metadata write-through) is exercised store-level in
 * src/onboarding-seed.test.ts and CLI-level in src/add-pack.test.ts.
 *
 * The load-bearing pins:
 *   - the `welcome` pack's tags must CONTAIN notes-ui's NOTES_REQUIRED_SCHEMA
 *     byte-for-byte — the Notes PWA's connect-time audit compares `description`
 *     verbatim, and its schema banner only clears when the capture tag genuinely
 *     carries the semantics Notes declares. (Containment, not equality: the
 *     welcome pack now also ships the #guide tag.)
 *   - `#guide` is the vault's skill-file tag (no schema — guides are AI-first
 *     and human-readable markdown, so no per-guide audience field). Every seeded
 *     guide note is tagged `#guide`.
 *   - the five-guide welcome ring links into a connected web with no dangling
 *     wikilinks across the default seed.
 */

import { describe, test, expect } from "bun:test";
import {
  applySeedPack,
  CAPTURE_ANYTHING_PATH,
  CONNECT_AI_PATH,
  DEFAULT_VAULT_DESCRIPTION,
  IMPORTED_VAULT_DESCRIPTION,
  YOURS_TO_KEEP_PATH,
  GETTING_STARTED_CONTENT,
  GETTING_STARTED_PACK,
  GETTING_STARTED_PATH,
  getSeedPack,
  GUIDE_TAG,
  listSeedPacks,
  NOTES_REQUIRED_TAGS,
  SEED_PACK_NAMES,
  SURFACE_STARTER_CONTENT,
  SURFACE_STARTER_PACK,
  SURFACE_STARTER_PATH,
  TAGS_GRAPH_PATH,
  WELCOME_PATH,
  welcomePack,
  YOURS_TO_KEEP_PATH,
  type SeedPack,
  type SeedPackNote,
} from "./seed-packs.ts";
import * as onboardingShim from "./onboarding.ts";

/**
 * LITERAL copy of `NOTES_REQUIRED_SCHEMA.tags` from
 * parachute-surface/packages/notes-ui/src/lib/vault/schema.ts — deliberately
 * NOT imported (different repo; and the whole point is an independent copy
 * that breaks this test when either side drifts). If this test fails, change
 * notes-ui and the pack in lockstep, never one side alone.
 */
const NOTES_UI_REQUIRED_SCHEMA_TAGS = [
  {
    name: "capture",
    description: "Notes captured directly by the user (text or voice).",
  },
];

/**
 * Extract every REAL `[[wikilink]]` target from note content — mirroring the
 * store's parser (core/src/wikilinks.ts), which ignores wikilinks inside
 * fenced/inline code. So an illustrative `[[wikilinks]]` in a code span (as in
 * the Getting Started guide) is not counted — it never becomes a link.
 */
function wikilinkTargets(content: string): string[] {
  const stripped = content
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length)) // fenced code
    .replace(/`[^`]*`/g, (m) => " ".repeat(m.length)); // inline code
  return [...stripped.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!);
}

/** A note in a pack, by path (fails loudly if absent). */
function noteAt(pack: SeedPack, path: string): SeedPackNote {
  const note = pack.notes.find((n) => n.path === path);
  if (!note) throw new Error(`no note at path ${path}`);
  return note;
}

describe("guide tag — the vault's skill-file tag", () => {
  test("GUIDE_TAG is the skill-file tag with no per-guide audience schema", () => {
    expect(GUIDE_TAG.name).toBe("guide");
    expect(GUIDE_TAG.description).toContain("skill file");
    // written_for was dropped (2026-07-06): guides are AI-first + human-readable
    // markdown, so a per-guide audience field earns nothing. No schema on the tag.
    expect(GUIDE_TAG.fields).toBeUndefined();
  });

});

describe("welcome pack — notes-ui schema parity (containment)", () => {
  test("welcome tags CONTAIN notes-ui's NOTES_REQUIRED_SCHEMA byte-for-byte", () => {
    // The independent copy still matches, and the welcome pack still ships it.
    expect(NOTES_REQUIRED_TAGS).toEqual(NOTES_UI_REQUIRED_SCHEMA_TAGS);
    for (const req of NOTES_UI_REQUIRED_SCHEMA_TAGS) {
      const found = welcomePack().tags.find((t) => t.name === req.name);
      expect(found).toBeDefined();
      // Field-level byte pins (toEqual ignores key order; these don't).
      expect(found!.name).toBe(req.name);
      expect(found!.description).toBe(req.description);
      expect(found!.parent_names).toBeUndefined();
    }
  });

  test("welcome tags = capture + guide (the guide tag rides along)", () => {
    expect(welcomePack().tags.map((t) => t.name)).toEqual([
      "capture",
      "guide",
    ]);
    expect(welcomePack().tags).toContain(GUIDE_TAG);
  });

  test("exactly ONE capture tag — no subtype tags, no parent_names (2026-07-03)", () => {
    // Entry method is metadata.source (text|voice), not taxonomy. The old
    // capture/text + capture/voice subtypes must not creep back into the seed
    // (existing vaults carrying them stay valid — tags are user data).
    expect(NOTES_REQUIRED_TAGS).toHaveLength(1);
    expect(NOTES_REQUIRED_TAGS[0]!.name).toBe("capture");
    expect(NOTES_REQUIRED_TAGS[0]!.parent_names).toBeUndefined();
  });
});

describe("welcome pack — the five-guide ring", () => {
  test("five guides at the ratified paths, in order", () => {
    const pack = welcomePack();
    expect(pack.name).toBe("welcome");
    expect(pack.notes.map((n) => n.path)).toEqual([
      WELCOME_PATH,
      CAPTURE_ANYTHING_PATH,
      TAGS_GRAPH_PATH,
      CONNECT_AI_PATH,
      YOURS_TO_KEEP_PATH,
    ]);
  });

  test("the link web: welcome → all four; 2→3→4→5→1; connect → Getting Started", () => {
    const pack = welcomePack();

    // Welcome wikilinks to all four siblings.
    const welcomeLinks = wikilinkTargets(noteAt(pack, WELCOME_PATH).content);
    for (const target of [
      CAPTURE_ANYTHING_PATH,
      TAGS_GRAPH_PATH,
      CONNECT_AI_PATH,
      YOURS_TO_KEEP_PATH,
    ]) {
      expect(welcomeLinks).toContain(target);
    }

    // The chain forward: 2→3, 3→4, 4→5, 5→1.
    expect(wikilinkTargets(noteAt(pack, CAPTURE_ANYTHING_PATH).content)).toContain(
      TAGS_GRAPH_PATH,
    );
    expect(wikilinkTargets(noteAt(pack, TAGS_GRAPH_PATH).content)).toContain(
      CONNECT_AI_PATH,
    );
    expect(wikilinkTargets(noteAt(pack, CONNECT_AI_PATH).content)).toContain(
      YOURS_TO_KEEP_PATH,
    );
    expect(wikilinkTargets(noteAt(pack, YOURS_TO_KEEP_PATH).content)).toContain(
      WELCOME_PATH,
    );

    // Connect your AI points the human at the AI-facing Getting Started note.
    expect(wikilinkTargets(noteAt(pack, CONNECT_AI_PATH).content)).toContain(
      GETTING_STARTED_PATH,
    );
  });

  test("NO dangling wikilinks across the default seed (welcome + getting-started)", () => {
    // Both packs auto-seed on create, so every [[target]] across their notes
    // must resolve to a note one of them writes — including [[Getting Started]].
    const seededPaths = new Set<string>([
      ...welcomePack().notes.map((n) => n.path),
      ...GETTING_STARTED_PACK.notes.map((n) => n.path),
    ]);
    for (const pack of [welcomePack(), GETTING_STARTED_PACK]) {
      for (const note of pack.notes) {
        for (const target of wikilinkTargets(note.content)) {
          expect(seededPaths.has(target)).toBe(true);
        }
      }
    }
  });

  test("every welcome guide is tagged #guide", () => {
    for (const note of welcomePack().notes) {
      expect(note.tags).toContain("guide");
    }
  });

  test("no seeded note is pinned (pinning is a user action, not seeded)", () => {
    // The vestigial #pinned seed was dropped 2026-07-07 — it did nothing visible
    // on a fresh vault. Pinning still works when a user pins a note in the app.
    const pinned = welcomePack().notes.filter((n) => n.tags?.includes("pinned"));
    expect(pinned).toEqual([]);
    expect(noteAt(welcomePack(), WELCOME_PATH).tags).toEqual(["guide"]);
  });

  test("content anchors: the ratified copy is present (guards body drift)", () => {
    const pack = welcomePack();
    expect(noteAt(pack, WELCOME_PATH).content).toContain("This vault is yours.");
    expect(noteAt(pack, WELCOME_PATH).content).toContain("tagged #guide");
    expect(noteAt(pack, CAPTURE_ANYTHING_PATH).content).toContain(
      "The one habit that makes a vault work",
    );
    expect(noteAt(pack, TAGS_GRAPH_PATH).content).toContain(
      "Notes and links come first. Tags come later",
    );
    expect(noteAt(pack, YOURS_TO_KEEP_PATH).content).toContain(
      "the moral center of the",
    );
    // Yours to keep carries the self-host export command (backtick-wrapped).
    expect(noteAt(pack, YOURS_TO_KEEP_PATH).content).toContain(
      "`parachute-vault export <dir>`",
    );
  });

  test("consoleOrigin renders both modes on the Connect-your-AI note", () => {
    const origin = "https://cloud.parachute.computer";

    // With origin: the console sentence names it, no `undefined`, no `at .`.
    const withOrigin = noteAt(welcomePack({ consoleOrigin: origin }), CONNECT_AI_PATH);
    expect(withOrigin.content).toContain(
      `Grab the connection URL from your console at ${origin}.`,
    );
    expect(withOrigin.content).not.toContain("undefined");

    // Without origin: the line stays generic — no baked loopback, no `at .`.
    const generic = noteAt(welcomePack(), CONNECT_AI_PATH);
    expect(generic.content).toContain(
      "Grab the connection URL from your console.",
    );
    expect(generic.content).not.toContain("undefined");
    expect(generic.content).not.toContain("at .");
    expect(generic.content).not.toContain(origin);
  });
});

describe("getting-started pack", () => {
  test("carries the AI-facing guide note, tagged #guide", () => {
    expect(GETTING_STARTED_PACK.name).toBe("getting-started");
    // Declares the guide tag (self-sufficient — converges with the welcome pack).
    expect(GETTING_STARTED_PACK.tags).toEqual([GUIDE_TAG]);
    expect(GETTING_STARTED_PACK.notes).toEqual([
      {
        path: GETTING_STARTED_PATH,
        tags: ["guide"],
        content: GETTING_STARTED_CONTENT,
      },
    ]);
  });

  test("the Getting Started body is byte-unchanged", () => {
    // The AI-facing doctrine copy is not touched by the ring rewrite.
    expect(noteAt(GETTING_STARTED_PACK, GETTING_STARTED_PATH).content).toBe(
      GETTING_STARTED_CONTENT,
    );
    expect(GETTING_STARTED_CONTENT.startsWith("# Getting Started\n")).toBe(true);
  });

  test("no dangling [[Surface Starter]] wikilink — points at the add-pack flow instead", () => {
    // Surface Starter is out of the default seed (ratified 2026-07-02), so the
    // default-seeded guide must not carry a wikilink to a note that doesn't
    // exist. It names the pack + the way to add it.
    expect(GETTING_STARTED_CONTENT).not.toContain("[[Surface Starter]]");
    expect(GETTING_STARTED_CONTENT).toContain("Surface Starter");
    // Points at the add-pack flow (console affordance / CLI) without spelling
    // out a terminal command — de-emphasise the CLI (Aaron 2026-07-06).
    expect(GETTING_STARTED_CONTENT).toContain("add-pack");
    // The surface packages are still named for discoverability.
    expect(GETTING_STARTED_CONTENT).toContain("@openparachute/surface-client");
    expect(GETTING_STARTED_CONTENT).toContain("@openparachute/surface-render");
  });

  test("Getting Started is onboarding-first + carries no dead CLI guidance (2026-07-06 rewrite)", () => {
    // Two-part structure: onboarding conversation leads, mechanics reference follows.
    expect(GETTING_STARTED_CONTENT).toContain("## Part 1 — Onboarding the person");
    expect(GETTING_STARTED_CONTENT).toContain("## Part 2 — Vault mechanics");
    // Points the person at the five human guides by name (all resolve to seeds).
    for (const g of [WELCOME_PATH, CAPTURE_ANYTHING_PATH, TAGS_GRAPH_PATH, CONNECT_AI_PATH, YOURS_TO_KEEP_PATH]) {
      expect(GETTING_STARTED_CONTENT).toContain("[[" + g + "]]");
    }
    // The old live bug: it told cloud AIs to run a CLI that doesn't exist there.
    expect(GETTING_STARTED_CONTENT).not.toContain("parachute-vault import");
    // Data-in leads with the import UI + MCP bridge, not the terminal.
    expect(GETTING_STARTED_CONTENT).toContain("Import button");
    expect(GETTING_STARTED_CONTENT).toContain("over MCP");
  });

  test("Getting Started carries the journaling / agent-memory / search conventions (vault#555)", () => {
    expect(GETTING_STARTED_CONTENT).toContain("## A few shapes worth reusing");
    // Journaling: indexed entry_date + mood enum.
    expect(GETTING_STARTED_CONTENT).toContain("entry_date");
    expect(GETTING_STARTED_CONTENT).toContain("mood");
    // Agent-memory pattern: thread + messages + the if_exists:"ignore" crash-replay recipe.
    expect(GETTING_STARTED_CONTENT).toContain("#thread");
    expect(GETTING_STARTED_CONTENT).toContain("#message");
    expect(GETTING_STARTED_CONTENT).toContain('if_exists: "ignore"');
    // Search one-liner: literal by default, search_mode:"advanced" for FTS syntax.
    expect(GETTING_STARTED_CONTENT).toContain("literal by default");
    expect(GETTING_STARTED_CONTENT).toContain('search_mode: "advanced"');
  });

  test("default vault-description constants orient + tell the AI to self-replace them", () => {
    for (const d of [DEFAULT_VAULT_DESCRIPTION, IMPORTED_VAULT_DESCRIPTION]) {
      expect(d.length).toBeGreaterThan(100);
      expect(d).toContain("Getting Started");
      expect(d).toContain("vault-info { description:"); // the self-replace instruction
    }
    expect(DEFAULT_VAULT_DESCRIPTION).toContain("brand-new");
    expect(IMPORTED_VAULT_DESCRIPTION).toContain("imported");
  });
});

describe("surface-starter pack", () => {
  test("carries the surface guide, tagged #guide (opt-in, not default)", () => {
    expect(SURFACE_STARTER_PACK.name).toBe("surface-starter");
    expect(SURFACE_STARTER_PACK.tags).toEqual([GUIDE_TAG]);
    expect(SURFACE_STARTER_PACK.notes).toEqual([
      {
        path: SURFACE_STARTER_PATH,
        tags: ["guide"],
        content: SURFACE_STARTER_CONTENT,
      },
    ]);
    expect(SURFACE_STARTER_PACK.description).toContain("not seeded by default");
  });

  test("links back to Getting Started (default-seeded, so the wikilink resolves)", () => {
    expect(SURFACE_STARTER_CONTENT).toContain("[[Getting Started]]");
  });
});

describe("pack registry", () => {
  test("lists exactly the three packs, in order", () => {
    expect([...SEED_PACK_NAMES]).toEqual([
      "welcome",
      "getting-started",
      "surface-starter",
    ]);
    expect(listSeedPacks().map((p) => p.name)).toEqual([...SEED_PACK_NAMES]);
    for (const p of listSeedPacks()) {
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  test("getSeedPack resolves each name and returns null for unknown", () => {
    for (const name of SEED_PACK_NAMES) {
      expect(getSeedPack(name)?.name).toBe(name);
    }
    expect(getSeedPack("nope")).toBeNull();
    expect(getSeedPack("")).toBeNull();
  });

  test("applySeedPack is exported for both runtimes", () => {
    expect(typeof applySeedPack).toBe("function");
  });
});

describe("onboarding.ts back-compat shim", () => {
  test("re-exports the canonical paths + contents from seed-packs", () => {
    expect(onboardingShim.GETTING_STARTED_PATH).toBe(GETTING_STARTED_PATH);
    expect(onboardingShim.GETTING_STARTED_CONTENT).toBe(GETTING_STARTED_CONTENT);
    expect(onboardingShim.SURFACE_STARTER_PATH).toBe(SURFACE_STARTER_PATH);
    expect(onboardingShim.SURFACE_STARTER_CONTENT).toBe(SURFACE_STARTER_CONTENT);
  });
});
