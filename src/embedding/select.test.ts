import { describe, test, expect } from "bun:test";
import {
  resolveEmbeddingApiConfig,
  buildEmbeddingProvider,
  embeddingsEnabledEnvOverride,
  resolveEmbeddingsEnabled,
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

describe("buildEmbeddingProvider — two-tier selection (once ENABLED)", () => {
  // Semantic search is opt-in as of 0.7.3, so every case here enables it
  // (via the env override) before asserting WHICH tier is selected.
  test("zero-config: no EMBEDDING_API_URL -> the bundled floor (onnx-transformers)", () => {
    const provider = buildEmbeddingProvider({ EMBEDDINGS_ENABLED: "true" });
    expect(provider).toBeInstanceOf(OnnxTransformersEmbeddingProvider);
  });

  test("EMBEDDING_API_URL set -> the config upgrade tier (external-api) wins", () => {
    const provider = buildEmbeddingProvider({ EMBEDDINGS_ENABLED: "true", EMBEDDING_API_URL: "http://localhost:11434/v1" });
    expect(provider).toBeInstanceOf(ExternalApiEmbeddingProvider);
    expect(provider!.model).toBe(DEFAULT_EXTERNAL_EMBEDDING_MODEL);
  });

  test("EMBEDDING_MODEL alone (no URL) has no effect — still the bundled floor", () => {
    const provider = buildEmbeddingProvider({ EMBEDDINGS_ENABLED: "true", EMBEDDING_MODEL: "bge-m3" });
    expect(provider).toBeInstanceOf(OnnxTransformersEmbeddingProvider);
  });

  test("an explicit EMBEDDING_MODEL overrides the config-tier default", () => {
    const provider = buildEmbeddingProvider({
      EMBEDDINGS_ENABLED: "true",
      EMBEDDING_API_URL: "http://x",
      EMBEDDING_MODEL: "nomic-embed-text",
    });
    expect(provider!.model).toBe("nomic-embed-text");
  });
});

describe("embeddingsEnabledEnvOverride — the EMBEDDINGS_ENABLED tri-state override", () => {
  test("\"true\"/\"1\" force ON (case-insensitive, trimmed)", () => {
    expect(embeddingsEnabledEnvOverride({ EMBEDDINGS_ENABLED: "true" })).toBe(true);
    expect(embeddingsEnabledEnvOverride({ EMBEDDINGS_ENABLED: "TRUE" })).toBe(true);
    expect(embeddingsEnabledEnvOverride({ EMBEDDINGS_ENABLED: "  1  " })).toBe(true);
  });

  test("\"false\"/\"0\" force OFF (case-insensitive, trimmed)", () => {
    expect(embeddingsEnabledEnvOverride({ EMBEDDINGS_ENABLED: "false" })).toBe(false);
    expect(embeddingsEnabledEnvOverride({ EMBEDDINGS_ENABLED: "FALSE" })).toBe(false);
    expect(embeddingsEnabledEnvOverride({ EMBEDDINGS_ENABLED: "  0  " })).toBe(false);
  });

  test("unset / blank / unrecognized → undefined (defer to the persisted setting)", () => {
    expect(embeddingsEnabledEnvOverride({})).toBeUndefined();
    expect(embeddingsEnabledEnvOverride({ EMBEDDINGS_ENABLED: "" })).toBeUndefined();
    expect(embeddingsEnabledEnvOverride({ EMBEDDINGS_ENABLED: "  " })).toBeUndefined();
    expect(embeddingsEnabledEnvOverride({ EMBEDDINGS_ENABLED: "yes" })).toBeUndefined();
  });
});

describe("resolveEmbeddingsEnabled — env override, else persisted, else OFF", () => {
  test("defaults OFF when neither env nor persisted setting is present (opt-in)", () => {
    expect(resolveEmbeddingsEnabled({})).toBe(false);
    expect(resolveEmbeddingsEnabled({}, undefined)).toBe(false);
  });

  test("persisted setting decides when the env var is absent", () => {
    expect(resolveEmbeddingsEnabled({}, true)).toBe(true);
    expect(resolveEmbeddingsEnabled({}, false)).toBe(false);
  });

  test("env override wins over the persisted setting in BOTH directions", () => {
    expect(resolveEmbeddingsEnabled({ EMBEDDINGS_ENABLED: "false" }, true)).toBe(false);
    expect(resolveEmbeddingsEnabled({ EMBEDDINGS_ENABLED: "true" }, false)).toBe(true);
  });

  test("an unrecognized env value defers to the persisted setting (not a guess)", () => {
    expect(resolveEmbeddingsEnabled({ EMBEDDINGS_ENABLED: "maybe" }, true)).toBe(true);
    expect(resolveEmbeddingsEnabled({ EMBEDDINGS_ENABLED: "maybe" }, false)).toBe(false);
  });
});

describe("buildEmbeddingProvider — opt-in gate (0.7.3)", () => {
  test("DEFAULT off: no provider when nothing enables it (unset env, no persisted setting)", () => {
    expect(buildEmbeddingProvider({})).toBeUndefined();
    expect(buildEmbeddingProvider({ EMBEDDING_API_URL: "http://localhost:11434/v1", EMBEDDING_MODEL: "bge-m3" })).toBeUndefined();
  });

  test("EMBEDDINGS_ENABLED=false forces off even with the persisted setting on", () => {
    expect(buildEmbeddingProvider({ EMBEDDINGS_ENABLED: "false" }, { persistedEnabled: true })).toBeUndefined();
  });

  test("EMBEDDINGS_ENABLED=true (or =1) enables — both tiers then resolve normally", () => {
    expect(buildEmbeddingProvider({ EMBEDDINGS_ENABLED: "true" })).toBeInstanceOf(OnnxTransformersEmbeddingProvider);
    expect(buildEmbeddingProvider({ EMBEDDINGS_ENABLED: "1" })).toBeInstanceOf(OnnxTransformersEmbeddingProvider);
    expect(
      buildEmbeddingProvider({ EMBEDDINGS_ENABLED: "true", EMBEDDING_API_URL: "http://x" }),
    ).toBeInstanceOf(ExternalApiEmbeddingProvider);
  });

  test("the persisted setting alone enables it (the self-host settings toggle, no env var)", () => {
    expect(buildEmbeddingProvider({}, { persistedEnabled: true })).toBeInstanceOf(OnnxTransformersEmbeddingProvider);
    expect(buildEmbeddingProvider({}, { persistedEnabled: false })).toBeUndefined();
  });
});
