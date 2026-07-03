/**
 * Unit tests for the default-pack seeding (originally demo-prep Workstream A —
 * A1/A2/A3; reshaped for named seed packs).
 *
 * Store-direct (no CLI subprocess) so they're fast. Covers:
 *   - default seed = `welcome` (3-note web + capture tags) + `getting-started`
 *     — and NOT `surface-starter` (out of the default seed, ratified 2026-07-02).
 *   - A1: the Getting Started doctrine markers.
 *   - A3 (reshaped): the welcome web's wikilinks resolve; Getting Started
 *     points at the surface-starter PACK without a dangling wikilink.
 *   - idempotency: a re-run never clobbers an edited note.
 *   - applySeedPack(surface-starter): the add-pack path works + is idempotent,
 *     and the guide carries the surface doctrine (GAP 1/2 markers).
 *   - A2: the projection / vault-info pointer steers the AI at Getting Started.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BunStore } from "./vault-store.ts";
import { seedOnboardingNotes } from "./onboarding-seed.ts";
import {
  applySeedPack,
  CONNECT_AI_PATH,
  GETTING_STARTED_PATH,
  NOTES_REQUIRED_TAGS,
  SURFACE_STARTER_PACK,
  SURFACE_STARTER_PATH,
  TRY_LINKING_PATH,
  WELCOME_PATH,
} from "../core/src/seed-packs.ts";
import {
  buildVaultProjection,
  projectionToMarkdown,
} from "../core/src/vault-projection.ts";

/** Every note path the default seed writes on a blank vault. */
const DEFAULT_SEED_PATHS = [
  WELCOME_PATH,
  TRY_LINKING_PATH,
  CONNECT_AI_PATH,
  GETTING_STARTED_PATH,
];

let db: Database;
let store: BunStore;
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `onboarding-seed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  db = new Database(join(tmpDir, "test.db"));
  store = new BunStore(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("seedOnboardingNotes — default packs (welcome + getting-started)", () => {
  test("seeds the welcome web + Getting Started on a blank vault — and NOT Surface Starter", async () => {
    const result = await seedOnboardingNotes(store);
    expect(result.seeded.sort()).toEqual([...DEFAULT_SEED_PATHS].sort());
    expect(result.skipped).toEqual([]);

    // Surface Starter is OUT of the default seed (button/CLI only).
    expect(await store.getNoteByPath(SURFACE_STARTER_PATH)).toBeNull();

    const gs = await store.getNoteByPath(GETTING_STARTED_PATH);
    expect(gs).not.toBeNull();
    expect(gs!.content).toContain("# Getting Started");
    // A1 doctrine markers: tags-as-types, the three-axis design vocab, import,
    // and the living-note instruction.
    expect(gs!.content).toContain("Tags = types");
    expect(gs!.content).toContain("Paths = organization");
    expect(gs!.content).toContain("Schemas = typed metadata fields");
    expect(gs!.content).toContain("parachute-vault import");
    expect(gs!.content).toContain("Adapt this note");

    // The welcome web: three person-voiced notes.
    for (const path of [WELCOME_PATH, TRY_LINKING_PATH, CONNECT_AI_PATH]) {
      expect(await store.getNoteByPath(path)).not.toBeNull();
    }
  });

  test("seeds the capture tags Notes requires (byte-equal semantics)", async () => {
    const result = await seedOnboardingNotes(store);
    expect(result.tags).toEqual(["capture", "capture/text", "capture/voice"]);

    for (const decl of NOTES_REQUIRED_TAGS) {
      const record = await store.getTagRecord(decl.name);
      expect(record).not.toBeNull();
      expect(record!.description).toBe(decl.description);
      expect(record!.parent_names ?? []).toEqual(decl.parent_names ?? []);
    }
  });

  test("GAP 4: Getting Started shows a concrete update-tag fields example + write gotchas", async () => {
    await seedOnboardingNotes(store);
    const gs = await store.getNoteByPath(GETTING_STARTED_PATH);

    // (a) a literal update-tag fields object: field name → { type, enum?, indexed? }.
    expect(gs!.content).toContain("update-tag {");
    expect(gs!.content).toContain('{ type: "string", indexed: true }');
    expect(gs!.content).toContain('enum: ["scheduled", "done"]');

    // (b) the write-gotchas subsection — each gotcha verified against mcp.ts.
    expect(gs!.content).toContain("## Write gotchas");
    expect(gs!.content).toContain("if_updated_at"); // optimistic concurrency
    expect(gs!.content).toContain("force: true");
    // schema-default back-fill: enum→first value, integer→0.
    expect(gs!.content).toContain("first listed value");
  });

  test("A3 (reshaped): the welcome web's wikilinks resolve; Getting Started has no dangling Surface Starter link", async () => {
    await seedOnboardingNotes(store);

    // welcome → try-linking, try-linking → welcome, connect-AI → welcome.
    const welcome = await store.getNoteByPath(WELCOME_PATH);
    const tryLinking = await store.getNoteByPath(TRY_LINKING_PATH);
    const connectAi = await store.getNoteByPath(CONNECT_AI_PATH);

    const welcomeOut = await store.getLinks(welcome!.id, { direction: "outbound" });
    expect(welcomeOut.some((l) => l.targetId === tryLinking!.id)).toBe(true);
    const tryOut = await store.getLinks(tryLinking!.id, { direction: "outbound" });
    expect(tryOut.some((l) => l.targetId === welcome!.id)).toBe(true);
    const connectOut = await store.getLinks(connectAi!.id, { direction: "outbound" });
    expect(connectOut.some((l) => l.targetId === welcome!.id)).toBe(true);

    // Getting Started mentions the surface-starter PACK — not a wikilink to a
    // note that the default seed no longer creates.
    const gs = await store.getNoteByPath(GETTING_STARTED_PATH);
    expect(gs!.content).not.toContain("[[Surface Starter]]");
    expect(gs!.content).toContain("add-pack surface-starter");
  });

  test("idempotent: a second seed run skips all notes (does not duplicate)", async () => {
    await seedOnboardingNotes(store);
    const second = await seedOnboardingNotes(store);
    expect(second.seeded).toEqual([]);
    expect(second.skipped.sort()).toEqual([...DEFAULT_SEED_PATHS].sort());

    // Exactly one note per path — no duplicates.
    const all = await store.queryNotes({});
    for (const path of DEFAULT_SEED_PATHS) {
      expect(all.filter((n) => n.path === path)).toHaveLength(1);
    }
  });

  test("idempotent: never clobbers an operator-edited Getting Started", async () => {
    await seedOnboardingNotes(store);
    const gs = await store.getNoteByPath(GETTING_STARTED_PATH);

    // Operator/AI rewrites the note — the living-note case.
    const edited = "# Getting Started\n\nThis vault is for my book research.";
    await store.updateNote(gs!.id, { content: edited });

    // Re-seed (simulates a re-init / restart): the edit must survive untouched.
    const rerun = await seedOnboardingNotes(store);
    expect(rerun.seeded).toEqual([]);
    const after = await store.getNoteByPath(GETTING_STARTED_PATH);
    expect(after!.content).toBe(edited);
  });
});

describe("applySeedPack — surface-starter via add-pack", () => {
  test("applies the Surface Starter guide onto a default-seeded vault", async () => {
    await seedOnboardingNotes(store);
    const result = await applySeedPack(store, SURFACE_STARTER_PACK);
    expect(result.pack).toBe("surface-starter");
    expect(result.seededNotes).toEqual([SURFACE_STARTER_PATH]);
    expect(result.skippedNotes).toEqual([]);
    expect(result.tags).toEqual([]);

    const ss = await store.getNoteByPath(SURFACE_STARTER_PATH);
    expect(ss).not.toBeNull();
    expect(ss!.content).toContain("# Surface Starter");
    // A3: the two surface packages by name.
    expect(ss!.content).toContain("@openparachute/surface-client");
    expect(ss!.content).toContain("@openparachute/surface-render");
    expect(ss!.content).toContain("createVaultSurface");
    expect(ss!.content).toContain("NoteRenderer");

    // GAP 2: warn that a surface can't be run/developed from this MCP session.
    expect(ss!.content).toContain("not from this");
    expect(ss!.content.toLowerCase()).toContain("browser");

    // GAP 1: a real, copy-paste end-to-end snippet — every load-bearing symbol
    // present, verified against the surface-client / surface-render source.
    expect(ss!.content).toContain("clientName"); // the one required createVaultSurface option
    expect(ss!.content).toContain("getClient");
    expect(ss!.content).toContain("queryNotes");
    expect(ss!.content).toContain("handleCallback");
    expect(ss!.content).toContain("resolve="); // NoteRenderer wikilink resolver prop

    // Its [[Getting Started]] wikilink resolves against the default seed.
    const gs = await store.getNoteByPath(GETTING_STARTED_PATH);
    const outbound = await store.getLinks(ss!.id, { direction: "outbound" });
    expect(outbound.some((l) => l.targetId === gs!.id)).toBe(true);
  });

  test("idempotent: a re-apply skips and never clobbers an edited note", async () => {
    await applySeedPack(store, SURFACE_STARTER_PACK);
    const ss = await store.getNoteByPath(SURFACE_STARTER_PATH);
    const edited = "# Surface Starter\n\nWe built ours with Solid.";
    await store.updateNote(ss!.id, { content: edited });

    const rerun = await applySeedPack(store, SURFACE_STARTER_PACK);
    expect(rerun.seededNotes).toEqual([]);
    expect(rerun.skippedNotes).toEqual([SURFACE_STARTER_PATH]);

    const after = await store.getNoteByPath(SURFACE_STARTER_PATH);
    expect(after!.content).toBe(edited);
    const all = await store.queryNotes({});
    expect(all.filter((n) => n.path === SURFACE_STARTER_PATH)).toHaveLength(1);
  });
});

describe("vault-info / projection pointer (A2)", () => {
  test("projection carries getting_started when the note exists", async () => {
    // Absent before seeding → no pointer.
    const before = buildVaultProjection(db);
    expect(before.getting_started).toBeUndefined();

    await seedOnboardingNotes(store);
    const after = buildVaultProjection(db);
    expect(after.getting_started).toBe(GETTING_STARTED_PATH);
  });

  test("connect-time markdown brief steers the AI to read Getting Started first", async () => {
    await seedOnboardingNotes(store);
    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({
      vaultName: "fresh",
      description: null,
      projection,
    });

    expect(md).toContain("## Start here");
    expect(md).toContain(GETTING_STARTED_PATH);
    // It's a POINTER, not the embedded body — the fetch command appears, the
    // note's distinctive body copy does not.
    expect(md).toContain(`query-notes { id: "${GETTING_STARTED_PATH}" }`);
    expect(md).not.toContain("Adapt this note");
  });

  test("no Start-here block on a vault without the guide (back-compat)", async () => {
    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({
      vaultName: "legacy",
      description: null,
      projection,
    });
    expect(md).not.toContain("## Start here");
  });
});

describe("vault coordinates in the projection (GAP 3)", () => {
  test("renders absolute REST + MCP URLs when the hub origin is known", () => {
    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({
      vaultName: "research",
      description: null,
      projection,
      coordinates: { hubOrigin: "https://hub.example.com", hubOriginKnown: true },
    });

    expect(md).toContain("## This vault's coordinates");
    expect(md).toContain("Name: `research`");
    expect(md).toContain("https://hub.example.com/vault/research/api/...");
    expect(md).toContain("https://hub.example.com/vault/research/mcp");
  });

  test("renders relative templates + connected-origin note when origin is unknown", () => {
    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({
      vaultName: "research",
      description: null,
      projection,
      coordinates: { hubOrigin: "http://127.0.0.1:1940", hubOriginKnown: false },
    });

    expect(md).toContain("## This vault's coordinates");
    expect(md).toContain("Name: `research`");
    // The loopback URL is NOT leaked; relative templates carry a placeholder.
    expect(md).not.toContain("127.0.0.1");
    expect(md).toContain("<hub-origin>/vault/research/api/...");
    expect(md).toContain("<hub-origin>/vault/research/mcp");
  });

  test("no coordinates block when coordinates are omitted; name still in the opening line", () => {
    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({ vaultName: "research", description: null, projection });
    // Without coordinates the dedicated block is absent; the vault NAME is still
    // stated in the pre-existing opening line (the always-known coordinate).
    expect(md).toContain('Parachute Vault "research"');
    expect(md).not.toContain("## This vault's coordinates");
  });
});
