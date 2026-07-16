/**
 * `external-api` — the config-upgrade self-host embedding provider
 * (semantic search MVP — two-tier self-host shape, Aaron-ratified).
 *
 * Speaks the OpenAI-compatible `POST {url}/embeddings` shape:
 * `{ model, input: string[] }` → `{ data: [{ embedding, index }, ...], model }`.
 * This one tiny client covers Ollama (the recommended quality tier — `ollama
 * pull bge-m3`, fully local + private), LM Studio, OpenAI itself, or any
 * hosted endpoint speaking the same contract — an `EMBEDDING_API_URL` /
 * `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` env trio, mirroring the existing
 * `PARACHUTE_GITHUB_*` bring-your-own pattern in `.env`.
 *
 * Structurally a sibling of `scribe-http.ts` (same AbortController+timeout
 * shape, same "no URL configured → available()=false, cheap, no network
 * probe" contract, same 4xx-terminal/5xx-retriable error mapping) — the
 * embedding seam clones the transcription seam's provider shape, not just
 * its interface.
 *
 * Config wins over the bundled floor (`onnx-transformers.ts`) when
 * `EMBEDDING_API_URL` is set — see `src/embedding/select.ts`.
 */

import {
  EmbeddingError,
  type EmbeddingProvider,
  type EmbedInput,
  type EmbedResult,
  type ProviderAvailability,
} from "../../core/src/embedding/provider.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ExternalApiEmbeddingProviderOpts {
  /** Base URL (e.g. `http://localhost:11434/v1`, `https://api.openai.com/v1`). `undefined`/empty → unavailable, non-retriable on embed(). Trailing slash trimmed. */
  url?: string;
  /** Bearer token, when the endpoint needs one (OpenAI does; a bare local Ollama typically doesn't). */
  apiKey?: string;
  /** Model identifier the endpoint should embed with (e.g. "bge-m3"). */
  model: string;
  /** Per-request timeout (ms). Default 120s. */
  timeoutMs?: number;
  /** Injection seam for tests; production omits it and uses global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface OpenAiEmbeddingRow {
  embedding: number[];
  index: number;
}

interface OpenAiEmbeddingResponse {
  data: OpenAiEmbeddingRow[];
  model?: string;
}

export class ExternalApiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "external-api";
  readonly model: string;
  /** Best-known dims — refined on the first successful embed() call (the model's own response is the ground truth). */
  dims: number;

  private readonly url: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ExternalApiEmbeddingProviderOpts) {
    this.url = opts.url?.trim() ? opts.url.trim().replace(/\/$/, "") : undefined;
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.dims = 0; // unknown until the first embed() response — see `dims` doc.
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Availability is purely "is a URL configured" — no network round-trip
   * (mirrors `ScribeHttpProvider.available()`; the capability flag reads
   * this on every `GET /api/vault`, so it must stay cheap).
   */
  async available(): Promise<ProviderAvailability> {
    if (!this.url) {
      return {
        ok: false,
        reason:
          "no embedding API URL configured (set EMBEDDING_API_URL/EMBEDDING_API_KEY/EMBEDDING_MODEL, e.g. for a local Ollama: EMBEDDING_API_URL=http://localhost:11434/v1)",
      };
    }
    return { ok: true };
  }

  async embed(input: EmbedInput): Promise<EmbedResult> {
    if (!this.url) {
      throw new EmbeddingError("no embedding API URL configured", {
        code: "missing_provider",
        retriable: false,
      });
    }
    if (input.texts.length === 0) {
      return { vectors: [], model: this.model, dims: this.dims };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

      const resp = await this.fetchImpl(`${this.url}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: input.texts }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        const retriable = resp.status >= 500;
        throw new EmbeddingError(`embedding API returned ${resp.status}: ${body.slice(0, 500)}`, {
          code: "external_api_error",
          httpStatus: resp.status,
          retriable,
        });
      }
      const parsed = (await resp.json()) as OpenAiEmbeddingResponse;
      if (!Array.isArray(parsed.data)) {
        throw new Error("embedding API response missing `data` array");
      }
      // The API contract guarantees `index` order matches input order, but
      // don't trust it blindly — sort defensively so `vectors[i]` always
      // corresponds to `input.texts[i]`.
      const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
      const vectors = sorted.map((row) => new Float32Array(row.embedding));
      if (vectors.length !== input.texts.length) {
        throw new Error(
          `embedding API returned ${vectors.length} vector(s) for ${input.texts.length} input text(s)`,
        );
      }
      if (vectors[0]) this.dims = vectors[0].length;
      return { vectors, model: this.model, dims: this.dims };
    } finally {
      clearTimeout(timer);
    }
  }
}
