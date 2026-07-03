/**
 * Content + registry pins for the named seed packs (core/src/seed-packs.ts).
 *
 * Pure content tests — no DB. The applier's behavior (idempotence, seeding)
 * is exercised store-level in src/onboarding-seed.test.ts and CLI-level in
 * src/add-pack.test.ts.
 *
 * The load-bearing pin: the `welcome` pack's tags must stay byte-equal to
 * notes-ui's NOTES_REQUIRED_SCHEMA — the Notes PWA's connect-time audit
 * compares `description` and `parent_names` verbatim, and its schema banner
 * only clears when the tags genuinely carry the semantics Notes declares.
 */

import { describe, test, expect } from "bun:test";
import {
  applySeedPack,
  CONNECT_AI_PATH,
  GETTING_STARTED_CONTENT,
  GETTING_STARTED_PACK,
  GETTING_STARTED_PATH,
  getSeedPack,
  listSeedPacks,
  NOTES_REQUIRED_TAGS,
  SEED_PACK_NAMES,
  SURFACE_STARTER_CONTENT,
  SURFACE_STARTER_PACK,
  SURFACE_STARTER_PATH,
  TRY_LINKING_PATH,
  WELCOME_PATH,
  welcomePack,
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
  {
    name: "capture/text",
    parent_names: ["capture"],
    description: "Text capture.",
  },
  {
    name: "capture/voice",
    parent_names: ["capture"],
    description: "Voice capture.",
  },
];

describe("welcome pack — notes-ui schema parity", () => {
  test("welcome tags are byte-equal to notes-ui's NOTES_REQUIRED_SCHEMA", () => {
    expect(NOTES_REQUIRED_TAGS).toEqual(NOTES_UI_REQUIRED_SCHEMA_TAGS);
    expect(welcomePack().tags).toEqual(NOTES_UI_REQUIRED_SCHEMA_TAGS);
    // Field-level byte pins (toEqual ignores key order; these don't).
    for (const [i, expected] of NOTES_UI_REQUIRED_SCHEMA_TAGS.entries()) {
      expect(NOTES_REQUIRED_TAGS[i]!.name).toBe(expected.name);
      expect(NOTES_REQUIRED_TAGS[i]!.description).toBe(expected.description);
      expect(NOTES_REQUIRED_TAGS[i]!.parent_names).toEqual(expected.parent_names);
    }
  });
});

describe("welcome pack — person-voiced welcome web", () => {
  test("three notes forming a linked web (welcome ⇄ try-linking, connect-AI → welcome)", () => {
    const pack = welcomePack();
    expect(pack.name).toBe("welcome");
    expect(pack.notes.map((n) => n.path)).toEqual([
      WELCOME_PATH,
      TRY_LINKING_PATH,
      CONNECT_AI_PATH,
    ]);

    const [welcome, tryLinking, connectAi] = pack.notes;
    expect(welcome!.content).toContain(`[[${TRY_LINKING_PATH}]]`);
    expect(tryLinking!.content).toContain(`[[${WELCOME_PATH}]]`);
    expect(connectAi!.content).toContain(`[[${WELCOME_PATH}]]`);
  });

  test("content with consoleOrigin is byte-equal to the cloud's welcome copy", () => {
    // Pinned against parachute-cloud workers/vault/src/welcome.ts
    // `welcomeNotes(consoleOrigin)` — the sibling cloud PR swaps that module
    // for this pack, so the ported content must not drift.
    const origin = "https://cloud.parachute.computer";
    const pack = welcomePack({ consoleOrigin: origin });

    expect(pack.notes[0]!.content).toBe(`# ${WELCOME_PATH}

This vault is yours.
Write anything.
Notes can link to each other, like this: [[${TRY_LINKING_PATH}]].
`);
    expect(pack.notes[1]!.content).toBe(`# ${TRY_LINKING_PATH}

Wrap a note's name in double square brackets to make a wikilink, like this one back to [[${WELCOME_PATH}]].
`);
    expect(pack.notes[2]!.content).toBe(`# ${CONNECT_AI_PATH}

Your vault speaks MCP. Grab the connection URL from your console at ${origin}.
Start from [[${WELCOME_PATH}]].
`);
  });

  test("without consoleOrigin the Connect-AI line stays generic (no baked origin)", () => {
    const connectAi = welcomePack().notes[2]!;
    expect(connectAi.content).toContain(
      "Your vault speaks MCP. Grab the connection URL from your console.",
    );
    expect(connectAi.content).not.toContain("undefined");
    expect(connectAi.content).not.toContain("at .");
  });
});

describe("getting-started pack", () => {
  test("carries the doctrine note at the canonical path", () => {
    expect(GETTING_STARTED_PACK.name).toBe("getting-started");
    expect(GETTING_STARTED_PACK.tags).toEqual([]);
    expect(GETTING_STARTED_PACK.notes).toEqual([
      { path: GETTING_STARTED_PATH, content: GETTING_STARTED_CONTENT },
    ]);
  });

  test("no dangling [[Surface Starter]] wikilink — points at the add-pack flow instead", () => {
    // Surface Starter is out of the default seed (ratified 2026-07-02), so the
    // default-seeded guide must not carry a wikilink to a note that doesn't
    // exist. It names the pack + the way to add it.
    expect(GETTING_STARTED_CONTENT).not.toContain("[[Surface Starter]]");
    expect(GETTING_STARTED_CONTENT).toContain("Surface Starter");
    expect(GETTING_STARTED_CONTENT).toContain("add-pack surface-starter");
    // The surface packages are still named for discoverability.
    expect(GETTING_STARTED_CONTENT).toContain("@openparachute/surface-client");
    expect(GETTING_STARTED_CONTENT).toContain("@openparachute/surface-render");
  });
});

describe("surface-starter pack", () => {
  test("carries the surface guide at the canonical path (opt-in, not default)", () => {
    expect(SURFACE_STARTER_PACK.name).toBe("surface-starter");
    expect(SURFACE_STARTER_PACK.tags).toEqual([]);
    expect(SURFACE_STARTER_PACK.notes).toEqual([
      { path: SURFACE_STARTER_PATH, content: SURFACE_STARTER_CONTENT },
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
