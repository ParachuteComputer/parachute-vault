/**
 * Embedding capability flag (semantic search MVP — EXPERIMENTAL).
 * Mirrors `src/transcription/capability.ts` exactly: the vault landing
 * (`GET /vault/<name>/api/vault`) surfaces an `embeddings` capability so a
 * surface (or Adam's Claude) can tell, before ever calling `query-notes
 * { semantic: true }`, whether meaning-based search is actually possible
 * on this vault right now — `enabled` is true only when a provider is
 * configured AND its `available()` probe passes.
 */

import type { EmbeddingProvider } from "../../core/src/embedding/provider.ts";

export interface EmbeddingCapability {
  /** True when a provider is configured AND available. `query-notes { semantic: true }` throws `semantic_unavailable` when false. */
  enabled: boolean;
  /** The active provider's name (e.g. "onnx-transformers", "external-api"). Omitted when disabled. */
  provider?: string;
  /** The active provider's model (e.g. "bge-small-en-v1.5", "bge-m3"). Omitted when disabled. */
  model?: string;
}

export async function resolveEmbeddingCapability(provider: EmbeddingProvider): Promise<EmbeddingCapability> {
  const avail = await provider.available();
  if (!avail.ok) return { enabled: false };
  return { enabled: true, provider: provider.name, model: provider.model };
}
