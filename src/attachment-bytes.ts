/**
 * Attachment bytes — bun's filesystem implementation of the model-lane
 * (Wave 2) `AttachmentBytesProvider` seam (`core/src/attachment/bytes-provider.ts`).
 *
 * Stateless by design (unlike the ticket provider, there's no in-memory
 * state to share across requests) — a fresh instance per MCP session is
 * cheap, so `createFsAttachmentBytesProvider` is a plain factory, not a
 * shared singleton.
 *
 * `readRange` uses `Bun.file(path).slice(start, end)` — a bounded,
 * positional read (Bun resolves the slice lazily via `pread` under the
 * hood), never the whole-file `readFileSync` this design explicitly moves
 * away from (see `handleStorage`'s REST `Range` support in `src/routes.ts`
 * for the sibling fix on the byte-serve side).
 */

import { existsSync, statSync } from "fs";
import { join, normalize } from "path";
import type { Attachment } from "../core/src/types.ts";
import type { AttachmentBytesProvider } from "../core/src/attachment/bytes-provider.ts";
import { assetsDir } from "./config.ts";
import { transcriptPathFor } from "./transcript-note.ts";
import { getVaultStore } from "./vault-store.ts";

/**
 * Resolve + confine an attachment's on-disk path under this vault's assets
 * dir. Same guard as the ticket download spend route (`src/attachment-tickets.ts`)
 * and the REST byte-serve route (`src/routes.ts`): normalize, then require
 * the result to still start with the (normalized) assets root — a stored
 * `path` can never resolve outside it, but a defense-in-depth check costs
 * nothing. Returns `null` on a traversal attempt (treated identically to
 * "file doesn't exist" by every caller here).
 */
function resolveConfinedPath(vaultName: string, attachment: Attachment): string | null {
  const assets = assetsDir(vaultName);
  const filePath = normalize(join(assets, attachment.path));
  if (!filePath.startsWith(normalize(assets))) return null;
  return filePath;
}

class FsAttachmentBytesProvider implements AttachmentBytesProvider {
  constructor(private readonly vaultName: string) {}

  async stat(attachment: Attachment): Promise<{ size: number } | null> {
    const filePath = resolveConfinedPath(this.vaultName, attachment);
    if (!filePath || !existsSync(filePath)) return null;
    return { size: statSync(filePath).size };
  }

  async readRange(attachment: Attachment, start: number, end: number): Promise<Uint8Array> {
    const filePath = resolveConfinedPath(this.vaultName, attachment);
    if (!filePath) return new Uint8Array(0);
    const slice = Bun.file(filePath).slice(start, end);
    return new Uint8Array(await slice.arrayBuffer());
  }

  async resolveTranscriptNote(attachment: Attachment): Promise<{ id: string; path: string } | null> {
    const store = getVaultStore(this.vaultName);
    const note = await store.getNoteByPath(transcriptPathFor(attachment.path));
    if (!note) return null;
    return { id: note.id, path: note.path ?? transcriptPathFor(attachment.path) };
  }
}

/** Build a fresh `AttachmentBytesProvider` scoped to one vault. Cheap — safe to call per-request. */
export function createFsAttachmentBytesProvider(vaultName: string): AttachmentBytesProvider {
  return new FsAttachmentBytesProvider(vaultName);
}
