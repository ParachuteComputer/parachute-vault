/**
 * Unit tests for the onboarding-guide seeding (demo-prep Workstream A — A1/A2/A3).
 *
 * Store-direct (no CLI subprocess) so they're fast. Covers:
 *   - A1: seedOnboardingNotes writes Getting Started + Surface Starter.
 *   - A3: Surface Starter is linked from Getting Started (wikilink).
 *   - idempotency: a re-run never clobbers an edited note.
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
  GETTING_STARTED_PATH,
  SURFACE_STARTER_PATH,
} from "../core/src/onboarding.ts";
import {
  buildVaultProjection,
  projectionToMarkdown,
} from "../core/src/vault-projection.ts";

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

describe("seedOnboardingNotes (A1/A3)", () => {
  test("seeds Getting Started + Surface Starter on a blank vault", async () => {
    const result = await seedOnboardingNotes(store);
    expect(result.seeded.sort()).toEqual(
      [GETTING_STARTED_PATH, SURFACE_STARTER_PATH].sort(),
    );
    expect(result.skipped).toEqual([]);

    const gs = await store.getNoteByPath(GETTING_STARTED_PATH);
    expect(gs).not.toBeNull();
    expect(gs!.content).toContain("# Getting Started");
    // A1 doctrine markers: tags-as-types, the three-axis design vocab, import,
    // and the living-note instruction.
    expect(gs!.content).toContain("Tags = types");
    expect(gs!.content).toContain("Paths = organization");
    expect(gs!.content).toContain("Schemas = indexed metadata fields");
    expect(gs!.content).toContain("parachute-vault import");
    expect(gs!.content).toContain("Keep this note growing");

    const ss = await store.getNoteByPath(SURFACE_STARTER_PATH);
    expect(ss).not.toBeNull();
    expect(ss!.content).toContain("# Surface Starter");
    // A3: the two surface packages by name.
    expect(ss!.content).toContain("@openparachute/surface-client");
    expect(ss!.content).toContain("@openparachute/surface-render");
    expect(ss!.content).toContain("createVaultSurface");
    expect(ss!.content).toContain("NoteRenderer");
  });

  test("A3: Getting Started links to Surface Starter via a resolved wikilink", async () => {
    await seedOnboardingNotes(store);
    const gs = await store.getNoteByPath(GETTING_STARTED_PATH);
    expect(gs!.content).toContain("[[Surface Starter]]");

    // Wikilink auto-resolution: Getting Started → Surface Starter link row.
    const ss = await store.getNoteByPath(SURFACE_STARTER_PATH);
    const outbound = await store.getLinks(gs!.id, { direction: "outbound" });
    expect(outbound.some((l) => l.targetId === ss!.id)).toBe(true);
  });

  test("idempotent: a second seed run skips both (does not duplicate)", async () => {
    await seedOnboardingNotes(store);
    const second = await seedOnboardingNotes(store);
    expect(second.seeded).toEqual([]);
    expect(second.skipped.sort()).toEqual(
      [GETTING_STARTED_PATH, SURFACE_STARTER_PATH].sort(),
    );

    // Exactly one note per path — no duplicates.
    const all = await store.queryNotes({});
    expect(all.filter((n) => n.path === GETTING_STARTED_PATH)).toHaveLength(1);
    expect(all.filter((n) => n.path === SURFACE_STARTER_PATH)).toHaveLength(1);
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
    expect(md).not.toContain("Keep this note growing");
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
