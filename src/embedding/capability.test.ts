import { describe, test, expect } from "bun:test";
import { resolveEmbeddingCapability } from "./capability.ts";
import type { EmbeddingProvider, EmbedInput, EmbedResult, ProviderAvailability } from "../../core/src/embedding/provider.ts";

class FakeProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly dims = 4;
  constructor(private ok: boolean, private reason?: string) {}
  async embed(_input: EmbedInput): Promise<EmbedResult> {
    return { vectors: [], model: this.model, dims: this.dims };
  }
  async available(): Promise<ProviderAvailability> {
    return this.ok ? { ok: true } : { ok: false, reason: this.reason };
  }
}

describe("resolveEmbeddingCapability", () => {
  test("enabled:true with provider/model when the provider is available", async () => {
    const cap = await resolveEmbeddingCapability(new FakeProvider(true));
    expect(cap).toEqual({ enabled: true, provider: "fake", model: "fake-model" });
  });

  test("enabled:false with no provider/model when unavailable", async () => {
    const cap = await resolveEmbeddingCapability(new FakeProvider(false, "not ready"));
    expect(cap).toEqual({ enabled: false });
  });
});
