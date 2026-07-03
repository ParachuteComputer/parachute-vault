/**
 * DEPRECATED back-compat shim — the onboarding content moved to
 * `seed-packs.ts` (named seed packs: `welcome` / `getting-started` /
 * `surface-starter`, one canonical content module for both the bun and cloud
 * runtimes).
 *
 * Kept so existing importers (including out-of-repo consumers of core, e.g.
 * parachute-cloud's `file:` dep) keep resolving. New code imports from
 * `seed-packs.ts` directly — prefer the `SeedPack` objects + `applySeedPack`
 * over these raw constants.
 */

export {
  GETTING_STARTED_PATH,
  GETTING_STARTED_CONTENT,
  SURFACE_STARTER_PATH,
  SURFACE_STARTER_CONTENT,
} from "./seed-packs.ts";
