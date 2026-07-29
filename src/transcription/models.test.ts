/**
 * The model catalog.
 *
 * These tests care about two things a catalog gets wrong quietly: URLs that
 * don't match the filename we save to (so a re-run re-downloads forever), and
 * a default-picker that hands a 1.5 GB model to a 1 GB box.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL_ID,
  findModel,
  pickDefaultModel,
  TRANSCRIPTION_MODELS,
} from "./models.ts";

describe("catalog integrity", () => {
  test("ids are unique", () => {
    const ids = TRANSCRIPTION_MODELS.map((m) => m.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("every URL's basename matches the filename we write", () => {
    // Drift here means the downloader saves to a name the resolver never
    // looks for, so every boot re-downloads and nothing ever becomes ready.
    for (const m of TRANSCRIPTION_MODELS) {
      expect(m.url.split("/").pop()).toBe(m.filename);
    }
  });

  test("Parakeet models come from ggml-org, Whisper from ggerganov", () => {
    // Load-bearing: handy-computer's GGUFs are NOT loadable by whisper.cpp's
    // parakeet-cli (verified — "failed to load Parakeet model"). Pointing a
    // Parakeet entry at handy-computer would produce a model that downloads
    // fine and then fails at every transcription.
    for (const m of TRANSCRIPTION_MODELS) {
      if (m.engine === "parakeet") expect(m.url).toContain("ggml-org/parakeet-GGUF");
      else expect(m.url).toContain("ggerganov/whisper.cpp");
    }
  });

  test("catalog is ordered smallest-first", () => {
    const sizes = TRANSCRIPTION_MODELS.map((m) => m.sizeMb);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });

  test("the default exists and is a Parakeet model", () => {
    const d = findModel(DEFAULT_MODEL_ID);
    expect(d).toBeDefined();
    expect(d!.engine).toBe("parakeet");
  });

  test("covers the small and mid size classes an operator asks for", () => {
    const sizes = TRANSCRIPTION_MODELS.map((m) => m.sizeMb);
    expect(sizes.some((s) => s < 150)).toBe(true); // ~100 MB class
    expect(sizes.some((s) => s >= 300 && s <= 700)).toBe(true); // ~400–700 MB class
  });
});

describe("pickDefaultModel", () => {
  test("a comfortable box gets the recommended Parakeet", () => {
    expect(pickDefaultModel(16384).id).toBe(DEFAULT_MODEL_ID);
  });

  test("a small box steps DOWN rather than swapping itself to death", () => {
    const picked = pickDefaultModel(1024);
    expect(picked.minRamMb).toBeLessThanOrEqual(1024);
    expect(picked.sizeMb).toBeLessThan(200);
  });

  test("never returns undefined, even on an absurdly small box", () => {
    const picked = pickDefaultModel(64);
    expect(picked).toBeDefined();
    expect(picked.id).toBe(TRANSCRIPTION_MODELS[0]!.id);
  });

  test("a mid box gets something that fits its RAM floor", () => {
    const picked = pickDefaultModel(2048);
    expect(picked.minRamMb).toBeLessThanOrEqual(2048);
  });
});

describe("findModel", () => {
  test("unknown id → undefined, not a throw", () => {
    expect(findModel("nope")).toBeUndefined();
  });
});
