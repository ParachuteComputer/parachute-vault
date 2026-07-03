/**
 * Seed the default packs on vault creation.
 *
 * A freshly-created vault gets the `welcome` pack (the person-voiced
 * three-note welcome web + the `capture` tags the Notes surface expects) and
 * the `getting-started` pack (the AI-legible start-here doctrine) — so the
 * first minute shows a small living graph, and a connected AI can read the
 * guide and help the operator set the vault up.
 *
 * The `surface-starter` pack is deliberately NOT part of the default seed
 * (ratified 2026-07-02): it's added on demand via
 * `parachute-vault add-pack surface-starter` or a console affordance.
 *
 * IDEMPOTENT + create-time only: each note is written ONLY when absent (tag
 * upserts converge on the same rows). A re-init, restart, or re-run never
 * clobbers a note the operator/AI has since edited. Existing vaults are
 * unaffected — this runs on the create path, not as a sweep over existing
 * vaults.
 *
 * Best-effort + non-fatal: seeding must NEVER fail a vault create. Any error
 * is caught and logged; the vault is still usable without the starter content.
 *
 * Pack contents live in core/src/seed-packs.ts (shared with the cloud vault).
 */

import {
  applySeedPack,
  GETTING_STARTED_PACK,
  welcomePack,
} from "../core/src/seed-packs.ts";
import type { Store } from "../core/src/types.ts";

interface SeedResult {
  /** Note paths actually written this run (absent ones). Empty when all pre-existed. */
  seeded: string[];
  /** Note paths skipped because the note already existed (idempotency). */
  skipped: string[];
  /** Tag names upserted (idempotent by nature). */
  tags: string[];
}

/**
 * Seed the default packs (`welcome` + `getting-started`) into `store`,
 * idempotently. Welcome first so the welcome web exists before the guide
 * lands (wikilinks auto-resolve either way; this just keeps the seed's
 * unresolved-link window minimal).
 */
export async function seedOnboardingNotes(store: Store): Promise<SeedResult> {
  const seeded: string[] = [];
  const skipped: string[] = [];
  const tags: string[] = [];

  // No consoleOrigin: create-time runs are often pre-expose, and a baked-in
  // loopback origin would go stale — the generic line is the safe default.
  for (const pack of [welcomePack(), GETTING_STARTED_PACK]) {
    const result = await applySeedPack(store, pack);
    seeded.push(...result.seededNotes);
    skipped.push(...result.skippedNotes);
    tags.push(...result.tags);
  }

  return { seeded, skipped, tags };
}

/**
 * Best-effort wrapper for the create path: seed the default packs, swallow
 * and log any error so a seeding failure never fails the vault create.
 */
export async function seedOnboardingNotesBestEffort(store: Store): Promise<void> {
  try {
    await seedOnboardingNotes(store);
  } catch (err) {
    console.error(
      `Note: starter content not seeded (${(err as Error)?.message ?? err}). ` +
        `The vault was still created; you can connect an AI and ask it to set things up.`,
    );
  }
}
