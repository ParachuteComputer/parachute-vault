/**
 * Process-singleton holder for the active MirrorManager.
 *
 * Why a registry module: `server.ts` owns the lifecycle (constructs + starts
 * on boot, drains on shutdown), but `routing.ts` needs to hand the same
 * instance to the `/admin/mirror` HTTP handlers. A shared module with a
 * setter + getter is the lightest seam — no top-level circular import,
 * no globals on `process`, no DI framework.
 *
 * Tests instantiate their own manager + call `setMirrorManager` to inject
 * it before exercising the route handlers.
 */

import type { MirrorManager } from "./mirror-manager.ts";

let activeManager: MirrorManager | null = null;

/** Install (or replace) the process-wide mirror manager. */
export function setMirrorManager(manager: MirrorManager | null): void {
  activeManager = manager;
}

/** Retrieve the current mirror manager. Null when boot hasn't wired one yet. */
export function getMirrorManager(): MirrorManager | null {
  return activeManager;
}
