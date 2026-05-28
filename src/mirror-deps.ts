/**
 * Production wiring for the mirror manager — builds a `MirrorDeps` from
 * the live vault store + config writers.
 *
 * Kept separate from `mirror-manager.ts` so the manager stays mock-
 * friendly: tests pass fake deps directly, never importing real
 * vault-store + portable-md.
 */

import { exportVaultToDir, pruneOrphans } from "../core/src/portable-md.ts";

import { defaultHookRegistry } from "../core/src/hooks.ts";
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
    runPrune: async ({ outDir }) => {
      const store = getVaultStore(vaultName);
      // Build the valid-id sets the prune sweep needs. Single-query
      // walk per dimension; cheap on typical vaults.
      const allNotes = await store.queryNotes({ limit: 1_000_000, sort: "asc" });
      const validNoteIds = new Set(allNotes.map((n) => n.id));
      // Tag names with schema content drive the schema sidecars. We
      // include ALL tag names (not just schema-bearing) — the prune
      // sweep removes a sidecar only when the tag is gone, and a tag
      // whose schema content was wiped but name persists still has a
      // sidecar slot the next export will rewrite from scratch.
      const tagRecords = await store.listTagRecords();
      const validTagNames = new Set(tagRecords.map((t) => t.tag));
      // Attachment IDs across all notes (the prune sweep keys on id).
      const validAttachmentIds = new Set<string>();
      for (const note of allNotes) {
        const atts = await store.getAttachments(note.id);
        for (const a of atts) validAttachmentIds.add(a.id);
      }
      const stats = pruneOrphans({
        outDir,
        validNoteIds,
        validTagNames,
        validAttachmentIds,
      });
      return {
        notes_removed: stats.notes_removed,
        sidecars_removed: stats.sidecars_removed,
        schemas_removed: stats.schemas_removed,
        attachment_dirs_removed: stats.attachment_dirs_removed,
      };
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
    // Share the process-wide hook registry so mirror's subscriptions land
    // on the same event bus that `BunSqliteStore` dispatches on. This is
    // load-bearing for the event-driven path; without it, the manager
    // falls back to safety-net polling only.
    hooks: defaultHookRegistry,
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
