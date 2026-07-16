import { describe, test, expect } from "bun:test";
import { OnnxTransformersEmbeddingProvider } from "./onnx-transformers.ts";
import { EmbeddingError } from "../../core/src/embedding/provider.ts";

/**
 * The real `@huggingface/transformers` pipeline is mocked so no model
 * download / ONNX runtime call happens in the test suite (same convention
 * as `onnx-asr.test.ts` mocking its subprocess) — the bun+onnxruntime
 * end-to-end verdict is verified manually (see this module's doc comment)
 * and documented in the PR, not re-run on every `bun test`.
 */
function fakeLoader(vectorFor: (text: string) => number[]) {
  return async (_modelId: string) => {
    return async (text: string, _opts: unknown) => ({ data: new Float32Array(vectorFor(text)) });
  };
}

function throwingLoader(message: string) {
  return async (_modelId: string): Promise<never> => {
    throw new Error(message);
  };
}

describe("OnnxTransformersEmbeddingProvider.available", () => {
  test("optimistic ok:true before any real load attempt", async () => {
    const p = new OnnxTransformersEmbeddingProvider({ pipelineLoader: fakeLoader(() => [1, 0]) });
    expect(await p.available()).toEqual({ ok: true });
  });

  test("ok:false, non-retriable, once the pipeline load has actually failed", async () => {
    const p = new OnnxTransformersEmbeddingProvider({ pipelineLoader: throwingLoader("simulated ORT failure") });
    let caught: unknown;
    try {
      await p.embed({ texts: ["x"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbeddingError);
    expect((caught as EmbeddingError).retriable).toBe(false);

    const avail = await p.available();
    expect(avail.ok).toBe(false);
    expect(avail.reason).toContain("simulated ORT failure");
  });

  test("name/model are stable", () => {
    const p = new OnnxTransformersEmbeddingProvider();
    expect(p.name).toBe("onnx-transformers");
    expect(p.model).toBe("Xenova/bge-small-en-v1.5");
    expect(p.dims).toBe(384);
  });
});

describe("OnnxTransformersEmbeddingProvider.embed", () => {
  test("embeds each text and returns vectors in the same order", async () => {
    const p = new OnnxTransformersEmbeddingProvider({
      pipelineLoader: fakeLoader((text) => (text === "a" ? [1, 0, 0] : [0, 1, 0])),
    });
    const result = await p.embed({ texts: ["a", "b"] });
    expect(Array.from(result.vectors[0])).toEqual([1, 0, 0]);
    expect(Array.from(result.vectors[1])).toEqual([0, 1, 0]);
    expect(result.model).toBe("Xenova/bge-small-en-v1.5");
    expect(result.dims).toBe(3);
  });

  test("empty texts array short-circuits without loading the pipeline", async () => {
    let loaded = false;
    const p = new OnnxTransformersEmbeddingProvider({
      pipelineLoader: async () => {
        loaded = true;
        return async () => ({ data: new Float32Array([1]) });
      },
    });
    const result = await p.embed({ texts: [] });
    expect(result.vectors).toEqual([]);
    expect(loaded).toBe(false);
  });

  test("loads the pipeline only ONCE across multiple embed() calls (lazy singleton)", async () => {
    let loadCount = 0;
    const p = new OnnxTransformersEmbeddingProvider({
      pipelineLoader: async () => {
        loadCount++;
        return async () => ({ data: new Float32Array([1, 0]) });
      },
    });
    await p.embed({ texts: ["a"] });
    await p.embed({ texts: ["b"] });
    await p.embed({ texts: ["c"] });
    expect(loadCount).toBe(1);
  });

  test("a broken provider stays broken — doesn't retry a doomed load on every call", async () => {
    let attempts = 0;
    const p = new OnnxTransformersEmbeddingProvider({
      pipelineLoader: async () => {
        attempts++;
        throw new Error("always fails");
      },
    });
    await expect(p.embed({ texts: ["a"] })).rejects.toThrow(EmbeddingError);
    await expect(p.embed({ texts: ["b"] })).rejects.toThrow(EmbeddingError);
    expect(attempts).toBe(1);
  });

  test("accepts a plain number[] `data` shape (not just Float32Array) from the pipeline", async () => {
    const p = new OnnxTransformersEmbeddingProvider({
      pipelineLoader: async () => async () => ({ data: [1, 2, 3] as unknown as Float32Array }),
    });
    const result = await p.embed({ texts: ["x"] });
    expect(Array.from(result.vectors[0])).toEqual([1, 2, 3]);
  });
});
