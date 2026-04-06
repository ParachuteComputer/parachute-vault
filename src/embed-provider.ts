/**
 * Embedding provider abstraction.
 *
 * Supports:
 *   - OpenAI (text-embedding-3-small, text-embedding-3-large, ada-002)
 *   - Ollama (local models like nomic-embed-text)
 *   - None (disabled)
 *
 * Configured via env vars:
 *   EMBEDDING_PROVIDER=openai|ollama|none
 *   EMBEDDING_MODEL=text-embedding-3-small (default)
 *   OPENAI_API_KEY=...
 *   OLLAMA_BASE_URL=http://localhost:11434 (default)
 */

export interface EmbeddingProvider {
  name: string;
  model: string;
  dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

const OPENAI_MODELS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

function createOpenAIProvider(model: string, apiKey: string): EmbeddingProvider {
  const dimensions = OPENAI_MODELS[model];
  if (!dimensions) {
    throw new Error(`Unknown OpenAI embedding model: ${model}. Supported: ${Object.keys(OPENAI_MODELS).join(", ")}`);
  }

  async function callAPI(input: string[]): Promise<number[][]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embeddings API error (${res.status}): ${body}`);
    }

    const data = await res.json() as {
      data: { embedding: number[]; index: number }[];
    };

    // Sort by index to match input order
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  return {
    name: "openai",
    model,
    dimensions,
    async embed(text: string): Promise<number[]> {
      const [result] = await callAPI([text]);
      return result;
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      // OpenAI supports up to 2048 inputs per request
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += 2048) {
        const batch = texts.slice(i, i + 2048);
        const embeddings = await callAPI(batch);
        results.push(...embeddings);
      }
      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

const OLLAMA_MODELS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "snowflake-arctic-embed": 1024,
};

function createOllamaProvider(model: string, baseUrl: string): EmbeddingProvider {
  const dimensions = OLLAMA_MODELS[model] ?? 768; // fallback for unknown models

  return {
    name: "ollama",
    model,
    dimensions,
    async embed(text: string): Promise<number[]> {
      const res = await fetch(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text }),
      });

      if (!res.ok) {
        throw new Error(`Ollama embed error (${res.status}): ${await res.text()}`);
      }

      const data = await res.json() as { embeddings: number[][] };
      return data.embeddings[0];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      // Ollama supports batch via array input
      const res = await fetch(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
      });

      if (!res.ok) {
        throw new Error(`Ollama embed error (${res.status}): ${await res.text()}`);
      }

      const data = await res.json() as { embeddings: number[][] };
      return data.embeddings;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmbeddingProvider(env: Record<string, string | undefined>): EmbeddingProvider | null {
  const provider = env.EMBEDDING_PROVIDER?.toLowerCase();

  if (!provider || provider === "none") return null;

  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn("EMBEDDING_PROVIDER=openai but OPENAI_API_KEY not set. Embeddings disabled.");
      return null;
    }
    const model = env.EMBEDDING_MODEL ?? "text-embedding-3-small";
    return createOpenAIProvider(model, apiKey);
  }

  if (provider === "ollama") {
    const baseUrl = env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const model = env.EMBEDDING_MODEL ?? "nomic-embed-text";
    return createOllamaProvider(model, baseUrl);
  }

  console.warn(`Unknown EMBEDDING_PROVIDER: ${provider}. Embeddings disabled.`);
  return null;
}
