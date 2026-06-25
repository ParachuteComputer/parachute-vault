/**
 * Seed the in-vault onboarding guide on vault creation.
 *
 * A freshly-created vault gets a `Getting Started` note (AI-legible doctrine)
 * and a linked `Surface Starter` note, so a connected AI can read the guide and
 * help the operator set the vault up — and keep growing it over time.
 *
 * IDEMPOTENT + create-time only: each note is written ONLY when absent. A
 * re-init, restart, or re-run never clobbers a note the operator/AI has since
 * edited. Existing vaults are unaffected — this runs on the create path, not as
 * a sweep over existing vaults.
 *
 * Best-effort + non-fatal: seeding must NEVER fail a vault create. Any error is
 * caught and logged; the vault is still usable without the guide.
 *
 * See the demo-prep Workstream A (A1/A2/A3).
 */

import {
  GETTING_STARTED_PATH,
  GETTING_STARTED_CONTENT,
  SURFACE_STARTER_PATH,
  SURFACE_STARTER_CONTENT,
} from "../core/src/onboarding.ts";
import type { Store } from "../core/src/types.ts";

interface SeedResult {
  /** Paths actually written this run (absent ones). Empty when both pre-existed. */
  seeded: string[];
  /** Paths skipped because the note already existed (idempotency). */
  skipped: string[];
}

/**
 * Write a single onboarding note only if no note already lives at `path`.
 * Returns true when it wrote (was absent), false when it skipped (present).
 */
async function seedNoteIfAbsent(
  store: Store,
  path: string,
  content: string,
): Promise<boolean> {
  const existing = await store.getNoteByPath(path);
  if (existing) return false;
  await store.createNote(content, { path });
  return true;
}

/**
 * Seed the onboarding notes into `store`, idempotently. Surface Starter is
 * created first so the `[[Surface Starter]]` wikilink in Getting Started
 * resolves immediately (the create path also auto-resolves later, but this
 * keeps the link live from the first write).
 */
export async function seedOnboardingNotes(store: Store): Promise<SeedResult> {
  const seeded: string[] = [];
  const skipped: string[] = [];

  for (const [path, content] of [
    [SURFACE_STARTER_PATH, SURFACE_STARTER_CONTENT],
    [GETTING_STARTED_PATH, GETTING_STARTED_CONTENT],
  ] as const) {
    const wrote = await seedNoteIfAbsent(store, path, content);
    (wrote ? seeded : skipped).push(path);
  }

  return { seeded, skipped };
}

/**
 * Best-effort wrapper for the create path: seed the onboarding notes, swallow
 * and log any error so a seeding failure never fails the vault create.
 */
export async function seedOnboardingNotesBestEffort(store: Store): Promise<void> {
  try {
    await seedOnboardingNotes(store);
  } catch (err) {
    console.error(
      `Note: onboarding guide not seeded (${(err as Error)?.message ?? err}). ` +
        `The vault was still created; you can connect an AI and ask it to set things up.`,
    );
  }
}
