/**
 * Production wiring for the mirror manager — builds a `MirrorDeps` from
 * the live vault store + config writers.
 *
 * Kept separate from `mirror-manager.ts` so the manager stays mock-
 * friendly: tests pass fake deps directly, never importing real
 * vault-store + portable-md.
 */

import { exportVaultToDir } from "../core/src/portable-md.ts";

import { readGlobalConfig, writeGlobalConfig, readVaultConfig } from "./config.ts";
import { defaultMirrorConfig, type MirrorConfig } from "./mirror-config.ts";
import type { MirrorDeps } from "./mirror-manager.ts";
import { assetsDir } from "./routes.ts";
import { getVaultStore } from "./vault-store.ts";

/**
 * Build production MirrorDeps for a given vault.
 *
 *   - `runExport` → `core/src/portable-md.ts:exportVaultToDir`. The same
 *     entry point the CLI's `cmdExport` uses; behavior matches the manual
 *     CLI mode exactly.
 *   - `firstChangedNoteTitle` → DB query for the most recent note with
 *     `updated_at >= cursor`. Identical to the CLI helper.
 *   - `readMirrorConfig` / `writeMirrorConfig` → round-trip through
 *     `readGlobalConfig` + `writeGlobalConfig`, preserving the rest of
 *     the global config file atomically.
 */
export function buildMirrorDeps(vaultName: string): MirrorDeps {
  return {
    vaultName,
    runExport: async ({ outDir, sinceCursor }) => {
      const store = getVaultStore(vaultName);
      const vaultConfig = readVaultConfig(vaultName);
      const stats = await exportVaultToDir(store, {
        outDir,
        vaultName,
        assetsDir: assetsDir(vaultName),
        ...(vaultConfig?.description ? { vaultDescription: vaultConfig.description } : {}),
        ...(sinceCursor ? { since: sinceCursor } : {}),
      });
      return { notes: stats.notes };
    },
    firstChangedNoteTitle: async (cursor) => {
      if (!cursor) return "";
      try {
        const store = getVaultStore(vaultName);
        const notes = await store.queryNotes({
          limit: 1,
          sort: "asc",
          dateFilter: { field: "updated_at", from: cursor },
        });
        return notes[0]?.path ?? notes[0]?.id ?? "";
      } catch {
        return "";
      }
    },
    readMirrorConfig: () => readGlobalConfig().mirror,
    writeMirrorConfig: (config: MirrorConfig) => {
      const global = readGlobalConfig();
      global.mirror = config;
      writeGlobalConfig(global);
    },
  };
}

/**
 * Resolve the mirror's owning vault. Today the mirror is per-server
 * (single config block in `config.yaml`), and the natural binding is
 * `default_vault` (the same vault the CLI + MCP wire up by default).
 * If no default is set, fall back to the first listed vault.
 *
 * Multi-vault mirror routing is future work (open question 2 in the
 * design doc); this helper localizes the binding decision so a future
 * refactor only touches one site.
 */
export function resolveMirrorVaultName(
  listVaults: () => string[],
): string | null {
  const global = readGlobalConfig();
  if (global.default_vault) return global.default_vault;
  const vaults = listVaults();
  return vaults[0] ?? null;
}

/** Re-export for callers that want defaults without importing two modules. */
export { defaultMirrorConfig };
