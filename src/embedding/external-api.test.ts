import { describe, test, expect } from "bun:test";
import { ExternalApiEmbeddingProvider } from "./external-api.ts";
import { EmbeddingError } from "../../core/src/embedding/provider.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recordingFetch(response: Response | (() => Response | Promise<Response>)): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return typeof response === "function" ? await response() : response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("ExternalApiEmbeddingProvider.available", () => {
  test("ok:true when a URL is configured", async () => {
    const p = new ExternalApiEmbeddingProvider({ url: "http://localhost:11434/v1", model: "bge-m3" });
    expect(await p.available()).toEqual({ ok: true });
  });

  test("ok:false with a reason when no URL is configured", async () => {
    const p = new ExternalApiEmbeddingProvider({ model: "bge-m3" });
    const avail = await p.available();
    expect(avail.ok).toBe(false);
    expect(avail.reason).toBeTruthy();
  });

  test("ok:false for an empty/whitespace URL", async () => {
    const p = new ExternalApiEmbeddingProvider({ url: "   ", model: "bge-m3" });
    expect((await p.available()).ok).toBe(false);
  });

  test("name is stable 'external-api'", () => {
    expect(new ExternalApiEmbeddingProvider({ url: "http://x", model: "bge-m3" }).name).toBe("external-api");
  });
});

describe("ExternalApiEmbeddingProvider.embed — happy path", () => {
  test("POSTs { model, input } to {url}/embeddings and returns ordered vectors", async () => {
    const { fetchImpl, calls } = recordingFetch(
      jsonResponse({
        data: [
          { embedding: [1, 2, 3], index: 0 },
          { embedding: [4, 5, 6], index: 1 },
        ],
        model: "bge-m3",
      }),
    );
    const p = new ExternalApiEmbeddingProvider({ url: "http://localhost:11434/v1", model: "bge-m3", fetchImpl });
    const result = await p.embed({ texts: ["hello", "world"] });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:11434/v1/embeddings");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body).toEqual({ model: "bge-m3", input: ["hello", "world"] });

    expect(result.vectors.length).toBe(2);
    expect(Array.from(result.vectors[0])).toEqual([1, 2, 3]);
    expect(Array.from(result.vectors[1])).toEqual([4, 5, 6]);
    expect(result.model).toBe("bge-m3");
    expect(result.dims).toBe(3);
  });

  test("reorders by `index` even if the API returns rows out of order", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse({
        data: [
          { embedding: [4, 5, 6], index: 1 },
          { embedding: [1, 2, 3], index: 0 },
        ],
      }),
    );
    const p = new ExternalApiEmbeddingProvider({ url: "http://x", model: "m", fetchImpl });
    const result = await p.embed({ texts: ["a", "b"] });
    expect(Array.from(result.vectors[0])).toEqual([1, 2, 3]);
    expect(Array.from(result.vectors[1])).toEqual([4, 5, 6]);
  });

  test("sends a Bearer header when an apiKey is configured", async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ data: [{ embedding: [1], index: 0 }] }));
    const p = new ExternalApiEmbeddingProvider({ url: "http://x", model: "m", apiKey: "secret-key", fetchImpl });
    await p.embed({ texts: ["a"] });
    expect((calls[0].init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-key");
  });

  test("no Authorization header when no apiKey is configured", async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ data: [{ embedding: [1], index: 0 }] }));
    const p = new ExternalApiEmbeddingProvider({ url: "http://x", model: "m", fetchImpl });
    await p.embed({ texts: ["a"] });
    expect((calls[0].init!.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  test("empty texts array short-circuits with no fetch call", async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ data: [] }));
    const p = new ExternalApiEmbeddingProvider({ url: "http://x", model: "m", fetchImpl });
    const result = await p.embed({ texts: [] });
    expect(calls.length).toBe(0);
    expect(result.vectors).toEqual([]);
  });
});

describe("ExternalApiEmbeddingProvider.embed — error mapping", () => {
  test("throws missing_provider (non-retriable) when no URL is configured", async () => {
    const p = new ExternalApiEmbeddingProvider({ model: "m" });
    let caught: unknown;
    try {
      await p.embed({ texts: ["x"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbeddingError);
    expect((caught as EmbeddingError).code).toBe("missing_provider");
    expect((caught as EmbeddingError).retriable).toBe(false);
  });

  test("4xx is non-retriable", async () => {
    const { fetchImpl } = recordingFetch(jsonResponse({ error: "bad request" }, 400));
    const p = new ExternalApiEmbeddingProvider({ url: "http://x", model: "m", fetchImpl });
    let caught: unknown;
    try {
      await p.embed({ texts: ["a"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbeddingError);
    expect((caught as EmbeddingError).retriable).toBe(false);
    expect((caught as EmbeddingError).httpStatus).toBe(400);
  });

  test("5xx is retriable", async () => {
    const { fetchImpl } = recordingFetch(new Response("upstream hiccup", { status: 503 }));
    const p = new ExternalApiEmbeddingProvider({ url: "http://x", model: "m", fetchImpl });
    let caught: unknown;
    try {
      await p.embed({ texts: ["a"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbeddingError);
    expect((caught as EmbeddingError).retriable).toBe(true);
  });

  test("a vector-count mismatch throws (defensive — never silently mis-align)", async () => {
    const { fetchImpl } = recordingFetch(jsonResponse({ data: [{ embedding: [1], index: 0 }] }));
    const p = new ExternalApiEmbeddingProvider({ url: "http://x", model: "m", fetchImpl });
    await expect(p.embed({ texts: ["a", "b"] })).rejects.toThrow();
  });
});
