/**
 * Production wiring for the mirror manager — builds a `MirrorDeps` from
 * the live vault store + config writers.
 *
 * Kept separate from `mirror-manager.ts` so the manager stays mock-
 * friendly: tests pass fake deps directly, never importing real
 * vault-store + portable-md.
 */

import { exportVaultToDir, hasSchemaContent, pruneOrphans } from "../core/src/portable-md.ts";

import { defaultHookRegistry } from "../core/src/hooks.ts";
import { readGlobalConfig, readVaultConfig } from "./config.ts";
import {
  defaultMirrorConfig,
  readMirrorConfigForVault,
  writeMirrorConfigForVault,
  type MirrorConfig,
} from "./mirror-config.ts";
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
 *   - `readMirrorConfig` / `writeMirrorConfig` → per-vault config file at
 *     `data/<vault>/mirror-config.yaml` (vault#400). Each vault carries its
 *     own mirror config, so configuring vault B never touches vault A's.
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
      // Tag names with schema content drive the schema sidecars. Filter
      // through `hasSchemaContent` — a tag whose schema content was wiped
      // via `deleteTagSchema` keeps its tags-table row (bare name), so a
      // map-by-name set would leave the stale sidecar in the mirror
      // indefinitely. Only schema-bearing tags belong in this set.
      // Reviewer-flagged on vault#382 (Critical #1).
      const tagRecords = await store.listTagRecords();
      const validTagNames = new Set(
        tagRecords.filter((t) => hasSchemaContent(t)).map((t) => t.tag),
      );
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
    // Per-vault (vault#400): read/write THIS vault's own config file, never
    // a shared server-wide block. Configuring vault B's mirror leaves vault
    // A's config untouched.
    readMirrorConfig: () => readMirrorConfigForVault(vaultName),
    writeMirrorConfig: (config: MirrorConfig) => {
      writeMirrorConfigForVault(vaultName, config);
    },
    // Share the process-wide hook registry so mirror's subscriptions land
    // on the same event bus that `BunSqliteStore` dispatches on. This is
    // load-bearing for the event-driven path; without it, the manager
    // falls back to safety-net polling only.
    hooks: defaultHookRegistry,
  };
}

/**
 * Resolve the mirror's "owning" vault — the one the LEGACY server-wide
 * config + credentials are attributed to during migration.
 *
 * Post-vault#400 every vault has its own mirror config + manager (real
 * multi-vault mirroring), so this is no longer "the one vault that can
 * mirror." It survives as the migration-attribution target: the legacy
 * server-wide `mirror:` block (vault#400) and the legacy server-wide
 * credentials file (vault#399) belong to the vault the single old mirror
 * was bound to — `default_vault`, or the first listed vault when no default
 * is set. Localizing the binding here keeps the migration attribution in one
 * place.
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
