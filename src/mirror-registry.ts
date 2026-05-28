/**
 * Per-vault holder for MirrorManager instances.
 *
 * Why a registry module: `server.ts` owns the lifecycle (constructs + starts
 * each enabled vault's manager on boot, drains on shutdown), but `routing.ts`
 * needs to hand the SAME instance to the `/.parachute/mirror[/*]` HTTP
 * handlers for the vault named in the URL. A shared module with per-vault
 * get/set is the lightest seam — no top-level circular import, no globals on
 * `process`, no DI framework.
 *
 * ## Why per-vault (vault#400)
 *
 * Before vault#400 this module held a SINGLE `activeManager` bound to the
 * mirror-owning vault (`resolveMirrorVaultName` = default/first). Every
 * mirror route — for EVERY vault in the URL — resolved to that one manager,
 * so `GET /vault/gitcoin/.parachute/mirror` returned the DEFAULT vault's
 * config + status + git remote. The admin SPA showed the same remote on
 * every vault's mirror page. vault#399 fixed credential STORAGE to be
 * per-vault; vault#400 completes the job: per-vault config + per-vault
 * manager + routes that resolve by the URL vault name.
 *
 * Now the registry is a `Map<vaultName, MirrorManager>`. A vault that has
 * config but no manager yet (runtime-enabled without a restart) is built
 * lazily on first `getMirrorManager(vaultName)` via the installed factory.
 *
 * Tests instantiate their own manager + call `setMirrorManager(name, mgr)`
 * to inject it before exercising the route handlers, OR install a fake
 * factory via `setMirrorManagerFactory`. `clearMirrorManagers()` resets
 * the map between tests.
 */

import type { MirrorManager } from "./mirror-manager.ts";

/**
 * Factory that builds a fresh MirrorManager for a vault. Installed by
 * production wiring (server.ts) so the registry can lazily stand up a
 * manager for a vault that has config but no live instance yet — without
 * the registry importing the heavy production deps (mirror-deps → config,
 * vault-store, routes) at module load. Tests install a fake factory or
 * skip lazy-build entirely by pre-seeding the map.
 */
export type MirrorManagerFactory = (vaultName: string) => MirrorManager;

const managers = new Map<string, MirrorManager>();
let factory: MirrorManagerFactory | null = null;

/**
 * Install (or replace) the lazy-build factory. server.ts wires this once at
 * boot to `(name) => new MirrorManager(buildMirrorDeps(name))`. Until it's
 * set, `getMirrorManager` won't lazily build — it returns whatever's already
 * in the map (or null).
 */
export function setMirrorManagerFactory(f: MirrorManagerFactory | null): void {
  factory = f;
}

/** Install (or replace) the manager for a vault. Pass null to evict. */
export function setMirrorManager(
  vaultName: string,
  manager: MirrorManager | null,
): void {
  if (manager === null) {
    managers.delete(vaultName);
  } else {
    managers.set(vaultName, manager);
  }
}

/**
 * Retrieve the manager for `vaultName`. If none is registered and a factory
 * is installed, build one lazily, register it, and return it — so a vault
 * whose mirror config was flipped on at runtime works without a restart.
 *
 * The lazily-built manager is NOT auto-started here (start() is async + does
 * filesystem work); callers that need it running call `manager.start()`.
 * Route handlers read `getConfig()`/`getStatus()` which reflect "disabled /
 * not configured" until a start happens — exactly the right answer for a
 * vault the operator hasn't enabled. The PUT handler's `reload()` is what
 * stands it up when the operator enables it.
 *
 * Returns null only when no manager exists AND no factory is installed
 * (e.g. tests that pre-seed the map deliberately, or a boot that hasn't
 * wired the factory yet).
 */
export function getMirrorManager(vaultName: string): MirrorManager | null {
  const existing = managers.get(vaultName);
  if (existing) return existing;
  if (!factory) return null;
  const built = factory(vaultName);
  managers.set(vaultName, built);
  return built;
}

/** Snapshot of vault names with a live manager. Used by shutdown drain. */
export function listMirrorManagers(): MirrorManager[] {
  return Array.from(managers.values());
}

/** Reset the registry (drops all managers + the factory). Test seam. */
export function clearMirrorManagers(): void {
  managers.clear();
  factory = null;
}
