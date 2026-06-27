/**
 * Boot-time self-registration of vault's manifest + `installDir` into
 * `~/.parachute/services.json` — the POC for retiring hub's
 * `FIRST_PARTY_FALLBACKS[vault]` (vault#266).
 *
 * Background: hub today vendors a `VAULT_FALLBACK` manifest in
 * `parachute-hub/src/service-spec.ts` and stamps `installDir` onto the
 * services.json row via `stampInstallDirOnRow` during `parachute install
 * vault` / API install. That fallback exists because (a) bun-link dev
 * mode never runs the hub install path so installDir isn't stamped,
 * and (b) v0.5 vault didn't ship its own `.parachute/module.json` so
 * hub had no manifest to read at lifecycle time.
 *
 * The endgame: every first-party module self-registers its manifest +
 * installDir on startup so hub's vendored fallbacks retire one by one.
 * This module is vault's piece of that pattern. Once vault/notes/scribe/
 * runner all self-register reliably, a hub follow-up deletes
 * `FIRST_PARTY_FALLBACKS` (see `parachute-hub` for the cleanup PR).
 *
 * Design choice — filesystem-direct rather than HTTP:
 *
 *   In v0.6 (single-container, hub-as-supervisor — see workspace
 *   CLAUDE.md), hub and vault share the same filesystem. Writing directly
 *   to services.json with the existing merge-preserving `upsertService`
 *   is the simplest shape that works today. The hub-stamped fields the
 *   row already carries (`installDir`, anything else hub adds in the
 *   future) ride through because `upsertService` merges rather than
 *   replaces (see `services-manifest.ts`).
 *
 *   v0.7 (multi-container cloud) will need an HTTP `POST
 *   /api/modules/self-register` on hub so a module on a different
 *   container can register without filesystem access to the operator's
 *   `~/.parachute/`. Filed as a separate hub follow-up; this module's
 *   shape is forward-compatible — `selfRegister` is the single seam that
 *   would swap from filesystem to HTTP transport.
 *
 * Failure mode: every error path logs + returns (never throws). A bad
 * registration must not crash server boot — the running vault is more
 * valuable than the discoverability bookkeeping. Symptom of failure is
 * "vault doesn't appear on hub discovery / admin SPA"; the fix is to
 * restart vault or run `parachute install vault` to stamp the row via
 * the hub-side path.
 */

import { readSelfManifest, resolvePackageRoot, type VaultModuleManifest } from "./module-manifest.ts";
import {
  ServicesManifestError,
  type ServiceEntry,
  readManifest,
  upsertService,
} from "./services-manifest.ts";
import { listVaults, readGlobalConfig, DEFAULT_PORT } from "./config.ts";

/**
 * Compute the `paths` array for the parachute-vault services.json entry.
 *
 * Mirrors `buildVaultServicePaths` in `cli.ts` so the self-register pass
 * produces the same multi-vault path advertisement as `parachute-vault
 * init` / `vault create`.
 *
 * At zero vaults, returns an empty array (`paths: []`). The row remains
 * present in services.json (name, port, health, version, installDir intact
 * — so the module is still detected as installed), but it advertises no
 * `/vault/<name>` path and the hub must not resolve it to a phantom
 * `/vault/default`. Closes #478.
 *
 * Exported for tests; not part of the public module surface.
 */
export function buildVaultServicePaths(
  defaultVault: string | undefined,
  vaults: readonly string[],
): string[] {
  if (vaults.length === 0) return [];
  if (defaultVault && vaults.includes(defaultVault)) {
    return [
      `/vault/${defaultVault}`,
      ...vaults.filter((v) => v !== defaultVault).map((v) => `/vault/${v}`),
    ];
  }
  return vaults.map((v) => `/vault/${v}`);
}

export interface SelfRegisterDeps {
  /** Override the manifest reader (tests inject a stub manifest). */
  readManifest?: () => VaultModuleManifest | null;
  /** Override the package-root resolver (tests inject a tmp dir). */
  resolvePackageRoot?: () => string;
  /** Override the services.json reader (tests inject a tmp-file reader). */
  readServicesManifest?: typeof readManifest;
  /** Override the services.json upsert (tests inject a tmp-file writer). */
  upsertService?: typeof upsertService;
  /** Override the vault lister (tests pass a fixed list). */
  listVaults?: typeof listVaults;
  /** Override the global config reader (tests pass a synthetic config). */
  readGlobalConfig?: typeof readGlobalConfig;
  /** Sink for status + warning lines. Production passes a console wrapper. */
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Vault's runtime version (from `package.json`). Required — no default. */
  version: string;
}

/** Result of a `selfRegister` call, surfaced to callers for observability. */
export type SelfRegisterResult =
  | { status: "registered"; installDir: string; changed: boolean }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Self-register vault's manifest + installDir into `~/.parachute/services.json`.
 *
 * Idempotent: re-runs with the same manifest + installDir produce the same
 * row (the `changed` field on the result telegraphs whether the write
 * actually mutated the file).
 *
 * Never throws. Errors (missing manifest, services.json unreadable,
 * filesystem write failure) are logged via `warn` and surfaced as a
 * `failed` / `skipped` result. The caller (server boot) treats failure
 * as non-fatal — vault keeps serving without the row stamp.
 */
export function selfRegister(deps: SelfRegisterDeps): SelfRegisterResult {
  const log = deps.log ?? ((m) => console.log(m));
  const warn = deps.warn ?? ((m) => console.warn(m));
  const readManifestImpl = deps.readManifest ?? readSelfManifest;
  const resolveRootImpl = deps.resolvePackageRoot ?? resolvePackageRoot;
  const upsertImpl = deps.upsertService ?? upsertService;
  const listVaultsImpl = deps.listVaults ?? listVaults;
  const readGlobalConfigImpl = deps.readGlobalConfig ?? readGlobalConfig;

  let manifest: VaultModuleManifest | null;
  try {
    manifest = readManifestImpl();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[self-register] could not read .parachute/module.json: ${msg}`);
    return { status: "failed", reason: msg };
  }
  if (!manifest) {
    log("[self-register] no .parachute/module.json found — skipping (legacy install or dev tree)");
    return { status: "skipped", reason: "manifest absent" };
  }

  // `installDir` is the directory containing both `package.json` and
  // `.parachute/module.json`. Hub's resolver (`<installDir>/.parachute/module.json`)
  // expects exactly this shape — see `parachute-hub/src/post-install.ts`'s
  // `stampInstallDirOnRow`.
  let installDir: string;
  try {
    installDir = resolveRootImpl();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[self-register] could not resolve package root: ${msg}`);
    return { status: "failed", reason: msg };
  }

  let globalConfig: ReturnType<typeof readGlobalConfig>;
  let vaults: string[];
  try {
    globalConfig = readGlobalConfigImpl();
    vaults = listVaultsImpl();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[self-register] could not read vault config: ${msg}`);
    return { status: "failed", reason: msg };
  }

  const paths = buildVaultServicePaths(globalConfig.default_vault, vaults);
  const port = globalConfig.port ?? DEFAULT_PORT;

  // Derive the health path from the primary path (paths[0]) rather than
  // using `manifest.health` verbatim. The manifest's `health` is
  // `/vault/default/health` — a template literal where `default` is the
  // placeholder vault name. When the operator named their vault something
  // other than `default` (e.g. `notes`, `journal`, or — caught in the wild
  // on a Render rebuild — just `vault`), the manifest's `default` doesn't
  // get rewritten and the hub's per-module health probe ends up hitting
  // `/vault/default/health` against a vault that lives at `/vault/<other>/`,
  // returning 404 even when the vault is healthy. Build health off paths[0]
  // so the path follows the primary vault by construction. Closes vault#369.
  const primaryPath = paths[0] ?? "/vault/default";
  const health = `${primaryPath}/health`;

  // Build the entry with manifest-sourced metadata (displayName, tagline,
  // stripPrefix) layered on top of the operationally-determined fields
  // (port from config, paths from current vault list, version from
  // package.json). hub-stamped fields on the existing row (installDir
  // from prior CLI install path, anything future) survive via
  // `upsertService`'s merge semantics — see services-manifest.ts.
  const entry: ServiceEntry & {
    installDir: string;
    displayName?: string;
    tagline?: string;
    stripPrefix?: boolean;
  } = {
    name: manifest.manifestName,
    port,
    paths,
    health,
    version: deps.version,
    installDir,
  };
  if (manifest.displayName !== undefined) entry.displayName = manifest.displayName;
  if (manifest.tagline !== undefined) entry.tagline = manifest.tagline;
  if (manifest.stripPrefix !== undefined) entry.stripPrefix = manifest.stripPrefix;

  // Detect whether the existing row already matches (no-op idempotency
  // signal). We don't gate the write on this — `upsertService` itself is
  // already idempotent at the byte level — but reporting `changed: false`
  // lets the boot log say "already registered" instead of restamping noise.
  let priorRow: (ServiceEntry & { installDir?: string }) | undefined;
  try {
    const current = (deps.readServicesManifest ?? readManifest)();
    priorRow = current.services.find((s) => s.name === manifest.manifestName) as
      | (ServiceEntry & { installDir?: string })
      | undefined;
  } catch (err) {
    // Read failure here is non-fatal — we'll still attempt the write below.
    // services.json may not exist yet (fresh boot); upsertService creates it.
    if (err instanceof ServicesManifestError) {
      warn(`[self-register] services.json read warning: ${err.message}`);
    } else {
      warn(`[self-register] services.json read warning: ${String(err)}`);
    }
  }

  const changed =
    !priorRow ||
    priorRow.installDir !== installDir ||
    priorRow.version !== deps.version ||
    priorRow.port !== port ||
    JSON.stringify(priorRow.paths) !== JSON.stringify(paths) ||
    priorRow.health !== health ||
    (priorRow as { displayName?: string }).displayName !== manifest.displayName ||
    (priorRow as { tagline?: string }).tagline !== manifest.tagline ||
    (priorRow as { stripPrefix?: boolean }).stripPrefix !== manifest.stripPrefix;

  try {
    upsertImpl(entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[self-register] services.json write failed: ${msg}`);
    return { status: "failed", reason: msg };
  }

  if (changed) {
    log(`[self-register] registered ${manifest.manifestName} (installDir=${installDir})`);
  } else {
    log(`[self-register] already registered ${manifest.manifestName} (no changes)`);
  }
  return { status: "registered", installDir, changed };
}
