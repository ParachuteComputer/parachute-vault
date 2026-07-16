/**
 * `onnx-transformers` — the bundled zero-config self-host embedding
 * provider (semantic search MVP — two-tier self-host shape, Aaron-
 * ratified: this is the FLOOR tier; `external-api.ts`/Ollama is the
 * recommended quality upgrade).
 *
 * Runs `bge-small-en-v1.5` (q8-quantized ONNX, ~34MB — P0's eval
 * confirmed this is genuinely bundle-sized, unlike bge-m3's 1.1GB) via
 * `@huggingface/transformers`, IN-PROCESS, no subprocess. Model weights
 * download from the Hugging Face hub to a local cache on first use (a
 * base-MODEL download, not note content leaving the box) — every actual
 * embedding call after that runs entirely on this machine.
 *
 * ## bun+onnxruntime verdict (P0/V2 spike)
 *
 * Confirmed WORKING under bun 1.3.13 on this repo: `onnxruntime-node`'s
 * native binary postinstall needs `bun pm trust` to run (blocked by
 * default) — `package.json`'s `trustedDependencies: ["onnxruntime-node",
 * "protobufjs"]` auto-approves it on a fresh `bun install`, no manual step
 * for an operator. `sharp`'s postinstall stays blocked (harmless — image
 * support is unused by this text-only pipeline). Verified end-to-end:
 * `pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype:
 * "q8" })` loads and produces correct 384-dim vectors under `bun run`.
 *
 * ## Lazy-fail, not crash
 *
 * The model load is NOT attempted at construction or at `available()` —
 * it's deferred to the first real `embed()` call (loading downloads/reads
 * ~34MB, too slow for a capability probe that runs on every `GET
 * /api/vault`). If the load ever throws (a genuinely broken bun/onnxruntime
 * combination on some future platform), the failure is caught, the
 * provider latches into a `broken` state for the rest of this process, and
 * every subsequent `available()`/`embed()` reports the failure honestly
 * (`onnx_unavailable`, non-retriable) instead of retrying a doomed load on
 * every note write or crashing the server.
 */

import {
  EmbeddingError,
  type EmbeddingProvider,
  type EmbedInput,
  type EmbedResult,
  type ProviderAvailability,
} from "../../core/src/embedding/provider.ts";

/** P0-verified bundle-sized default: 34MB q8 ONNX, well under the "~100MB zero-config" bar. */
const DEFAULT_MODEL_ID = "Xenova/bge-small-en-v1.5";
const DEFAULT_DIMS = 384;

/** Structural minimum of the transformers.js feature-extraction pipeline this provider calls. */
type FeatureExtractionFn = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean; truncation: boolean },
) => Promise<{ data: Float32Array | number[] }>;

export interface OnnxTransformersProviderOpts {
  /** Hugging Face model id. Default `Xenova/bge-small-en-v1.5`. */
  modelId?: string;
  /** Expected vector dimensionality (confirmed against the first real embed() response). Default 384. */
  dims?: number;
  /**
   * Injection seam for tests — a fake `pipeline("feature-extraction", ...)`
   * loader. Production omits it and dynamically imports `@huggingface/transformers`.
   */
  pipelineLoader?: (modelId: string) => Promise<FeatureExtractionFn>;
}

async function defaultPipelineLoader(modelId: string): Promise<FeatureExtractionFn> {
  // Dynamic import (not a top-level import) — this file lives in `src/`
  // (never `core/`), but keeping the ~34MB dependency's load off the
  // module-init path means a vault that never touches semantic search
  // never pays the import cost either.
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", modelId, { dtype: "q8" });
  return extractor as unknown as FeatureExtractionFn;
}

export class OnnxTransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = "onnx-transformers";
  readonly model: string;
  dims: number;

  private readonly pipelineLoader: (modelId: string) => Promise<FeatureExtractionFn>;
  private extractorPromise: Promise<FeatureExtractionFn> | null = null;
  private broken: string | null = null;

  constructor(opts: OnnxTransformersProviderOpts = {}) {
    this.model = opts.modelId ?? DEFAULT_MODEL_ID;
    this.dims = opts.dims ?? DEFAULT_DIMS;
    this.pipelineLoader = opts.pipelineLoader ?? defaultPipelineLoader;
  }

  /**
   * Optimistic until proven otherwise — see the module doc's "lazy-fail,
   * not crash" note. A real load attempt only happens inside `embed()`.
   */
  async available(): Promise<ProviderAvailability> {
    if (this.broken) return { ok: false, reason: this.broken };
    return { ok: true };
  }

  private async getExtractor(): Promise<FeatureExtractionFn> {
    if (this.broken) {
      throw new EmbeddingError(this.broken, { code: "onnx_unavailable", retriable: false });
    }
    if (!this.extractorPromise) {
      this.extractorPromise = this.pipelineLoader(this.model).catch((err) => {
        const reason = `bundled ONNX embedding model failed to load: ${err instanceof Error ? err.message : String(err)}`;
        this.broken = reason;
        throw new EmbeddingError(reason, { code: "onnx_unavailable", retriable: false });
      });
    }
    return this.extractorPromise;
  }

  /**
   * Embeds each text through the pipeline one at a time (not a single
   * batched ONNX-session call) — this is the exact per-item invocation
   * shape the P0 eval harness verified working end-to-end; true session-
   * level batching is a future optimization, not required for the MVP's
   * correctness. `truncation: true` lets the model's own tokenizer window
   * (512 tokens for bge-small) truncate long chunks — chunking already
   * targets ~450 tokens per chunk (see `core/src/embedding/chunker.ts`),
   * so this rarely engages in practice. Returns RAW (un-normalized)
   * vectors — normalization is the store's job (one place, for every
   * provider), not each provider's.
   */
  async embed(input: EmbedInput): Promise<EmbedResult> {
    if (input.texts.length === 0) {
      return { vectors: [], model: this.model, dims: this.dims };
    }
    const extractor = await this.getExtractor();
    const vectors: Float32Array[] = [];
    for (const text of input.texts) {
      const out = await extractor(text, { pooling: "mean", normalize: false, truncation: true });
      vectors.push(out.data instanceof Float32Array ? out.data : new Float32Array(out.data));
    }
    if (vectors[0]) this.dims = vectors[0].length;
    return { vectors, model: this.model, dims: this.dims };
  }
}
