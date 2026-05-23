/**
 * Reader for the package's own `.parachute/module.json`.
 *
 * Vault ships `module.json` alongside `package.json` at the package root.
 * This module locates the file via `import.meta.url` (which works for both
 * `bun src/cli.ts …` dev runs and the published-package `parachute-vault`
 * binary — the file ships in `package.json` `files` next to `src/`).
 *
 * Used by `self-register.ts` on server boot: vault reads its own manifest
 * + computes the package's `installDir` so the services.json row carries
 * the same metadata that hub's `FIRST_PARTY_FALLBACKS[vault]` provides
 * today. The endgame is that hub's vendored fallback retires once every
 * first-party module self-registers reliably — this is the POC for the
 * pattern.
 *
 * Shape mirrors `parachute-hub/src/module-manifest.ts`. Kept narrow: we
 * only consume the fields vault stamps onto services.json
 * (displayName, tagline, stripPrefix). The full manifest validator lives
 * on the hub side; vault treats its own manifest as authored-by-us +
 * trusts the shape.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ModuleKind = "api" | "frontend" | "tool";

/**
 * Subset of the full manifest schema (see `parachute-hub/src/module-manifest.ts`)
 * — only the fields vault's self-registration consumes today. Adding more is
 * a one-line edit when the surface widens.
 */
export interface VaultModuleManifest {
  readonly name: string;
  readonly manifestName: string;
  readonly displayName?: string;
  readonly tagline?: string;
  /**
   * Deprecated as of hub#301 Phase B (kind retirement, 2026-05-23). Hub's
   * validator dropped `kind` from required-fields in hub#327; vault no
   * longer ships the field in `.parachute/module.json`. Kept here as
   * optional only so an older shipped manifest (pinned legacy install)
   * still parses without throwing — the field is never branched on.
   */
  readonly kind?: ModuleKind;
  readonly port: number;
  readonly paths: readonly string[];
  readonly health: string;
  readonly stripPrefix?: boolean;
}

/**
 * Resolve the path to the package root — the directory containing both
 * `package.json` and `.parachute/module.json`. Walks up from
 * `import.meta.url` so the answer is correct under both:
 *
 *   - dev:  `bun src/cli.ts serve` → `src/module-manifest.ts` → parent = repo root
 *   - prod: published package → `src/module-manifest.ts` → parent = installed
 *           package dir (e.g. `~/.bun/install/global/node_modules/@openparachute/vault`)
 *
 * Exported for tests + the self-register flow that needs to stamp this as
 * `installDir` on the services.json row.
 */
export function resolvePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // `src/module-manifest.ts` lives one level under the package root.
  return resolve(here, "..");
}

/**
 * Read `<packageRoot>/.parachute/module.json` if present. Returns null when
 * the file is missing (e.g. during local dev before the file was committed)
 * — callers treat that as "self-registration unavailable, log + continue."
 *
 * Throws on malformed JSON: a corrupt manifest is a deploy bug we want to
 * surface, not silently swallow. The self-register caller catches + logs
 * so a bad manifest doesn't crash server boot.
 */
export function readSelfManifest(
  packageRoot: string = resolvePackageRoot(),
): VaultModuleManifest | null {
  const path = join(packageRoot, ".parachute", "module.json");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // Minimal shape validation. Only the fields we actually consume — anything
  // else passes through untouched. Strict full-shape validation is the hub's
  // job (it'll fail an install on a malformed manifest); vault treats its
  // own shipped file as authored-by-us.
  if (typeof parsed.name !== "string" || typeof parsed.manifestName !== "string") {
    throw new Error(`${path}: manifest missing required "name" / "manifestName"`);
  }
  if (typeof parsed.port !== "number" || !Array.isArray(parsed.paths)) {
    throw new Error(`${path}: manifest missing required "port" / "paths"`);
  }
  if (typeof parsed.health !== "string") {
    throw new Error(`${path}: manifest missing required "health"`);
  }
  // `kind` is retired as of hub#301 Phase B — hub#327 made it optional in
  // the hub-side validator, and vault no longer ships it. If a legacy
  // manifest still includes the field, accept it; just don't require it.
  return parsed as unknown as VaultModuleManifest;
}
