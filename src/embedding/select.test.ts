import { describe, test, expect } from "bun:test";
import {
  resolveEmbeddingApiConfig,
  buildEmbeddingProvider,
  embeddingsExplicitlyDisabled,
  DEFAULT_EXTERNAL_EMBEDDING_MODEL,
} from "./select.ts";
import { ExternalApiEmbeddingProvider } from "./external-api.ts";
import { OnnxTransformersEmbeddingProvider } from "./onnx-transformers.ts";

describe("resolveEmbeddingApiConfig", () => {
  test("all undefined when no env vars are set", () => {
    expect(resolveEmbeddingApiConfig({})).toEqual({ url: undefined, apiKey: undefined, model: undefined });
  });

  test("reads the EMBEDDING_API_URL/EMBEDDING_API_KEY/EMBEDDING_MODEL trio", () => {
    const config = resolveEmbeddingApiConfig({
      EMBEDDING_API_URL: "http://localhost:11434/v1",
      EMBEDDING_API_KEY: "secret",
      EMBEDDING_MODEL: "bge-m3",
    });
    expect(config).toEqual({ url: "http://localhost:11434/v1", apiKey: "secret", model: "bge-m3" });
  });

  test("blank/whitespace-only values are treated as absent", () => {
    const config = resolveEmbeddingApiConfig({ EMBEDDING_API_URL: "   ", EMBEDDING_MODEL: "" });
    expect(config.url).toBeUndefined();
    expect(config.model).toBeUndefined();
  });
});

describe("buildEmbeddingProvider — two-tier selection", () => {
  test("zero-config: no EMBEDDING_API_URL -> the bundled floor (onnx-transformers)", () => {
    const provider = buildEmbeddingProvider({});
    expect(provider).toBeInstanceOf(OnnxTransformersEmbeddingProvider);
  });

  test("EMBEDDING_API_URL set -> the config upgrade tier (external-api) wins", () => {
    const provider = buildEmbeddingProvider({ EMBEDDING_API_URL: "http://localhost:11434/v1" });
    expect(provider).toBeInstanceOf(ExternalApiEmbeddingProvider);
    expect(provider.model).toBe(DEFAULT_EXTERNAL_EMBEDDING_MODEL);
  });

  test("EMBEDDING_MODEL alone (no URL) has no effect — still the bundled floor", () => {
    const provider = buildEmbeddingProvider({ EMBEDDING_MODEL: "bge-m3" });
    expect(provider).toBeInstanceOf(OnnxTransformersEmbeddingProvider);
  });

  test("an explicit EMBEDDING_MODEL overrides the config-tier default", () => {
    const provider = buildEmbeddingProvider({
      EMBEDDING_API_URL: "http://x",
      EMBEDDING_MODEL: "nomic-embed-text",
    });
    expect(provider.model).toBe("nomic-embed-text");
  });
});

describe("embeddingsExplicitlyDisabled — the EMBEDDINGS_ENABLED off switch (M1)", () => {
  test("false only for the literal string \"false\"", () => {
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "false" })).toBe(true);
  });

  test("case-insensitive and trims whitespace", () => {
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "FALSE" })).toBe(true);
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "  false  " })).toBe(true);
  });

  test("unset defaults to enabled (not disabled)", () => {
    expect(embeddingsExplicitlyDisabled({})).toBe(false);
  });

  test("\"true\" (and any other value) is enabled — this var is an off switch, not an opt-in", () => {
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "true" })).toBe(false);
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "0" })).toBe(false);
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "no" })).toBe(false);
  });
});

describe("buildEmbeddingProvider — EMBEDDINGS_ENABLED=false (M1)", () => {
  test("returns undefined even when the config-upgrade tier is otherwise fully configured", () => {
    const provider = buildEmbeddingProvider({
      EMBEDDINGS_ENABLED: "false",
      EMBEDDING_API_URL: "http://localhost:11434/v1",
      EMBEDDING_MODEL: "bge-m3",
    });
    expect(provider).toBeUndefined();
  });

  test("returns undefined for the zero-config (bundled-floor) case too", () => {
    expect(buildEmbeddingProvider({ EMBEDDINGS_ENABLED: "false" })).toBeUndefined();
  });

  test("EMBEDDINGS_ENABLED=true (or unset) is unaffected — both tiers still resolve normally", () => {
    expect(buildEmbeddingProvider({ EMBEDDINGS_ENABLED: "true" })).toBeInstanceOf(OnnxTransformersEmbeddingProvider);
    expect(
      buildEmbeddingProvider({ EMBEDDINGS_ENABLED: "true", EMBEDDING_API_URL: "http://x" }),
    ).toBeInstanceOf(ExternalApiEmbeddingProvider);
  });
});
