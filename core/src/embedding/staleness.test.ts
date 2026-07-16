import { describe, it, expect } from "bun:test";
import { planStaleness, contentHash, type ExistingVectorRow } from "./staleness.js";
import type { Chunk } from "./chunker.js";

const MODEL = "bge-small-en-v1.5";

function chunk(ix: number, text: string): Chunk {
  return { ix, text };
}

function row(ix: number, text: string, model = MODEL): ExistingVectorRow {
  return { chunk_ix: ix, model, content_hash: contentHash(text) };
}

describe("contentHash", () => {
  it("is deterministic", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("differs for different content", () => {
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });
});

describe("planStaleness", () => {
  it("a brand-new note (no existing rows) is entirely stale", () => {
    const chunks = [chunk(0, "some content")];
    const plan = planStaleness([], chunks, MODEL);
    expect(plan.stale).toEqual(chunks);
    expect(plan.obsoleteIxs).toEqual([]);
  });

  it("no-op edit: identical content + same model produces zero stale chunks", () => {
    const text = "unchanged content";
    const chunks = [chunk(0, text)];
    const existing = [row(0, text)];
    const plan = planStaleness(existing, chunks, MODEL);
    expect(plan.stale).toEqual([]);
    expect(plan.obsoleteIxs).toEqual([]);
  });

  it("content change on one chunk marks only that chunk stale", () => {
    const chunks = [chunk(0, "old text"), chunk(1, "second chunk unchanged")];
    const existing = [row(0, "old text"), row(1, "second chunk unchanged")];
    // Mutate chunk 0's text after the existing row was hashed — simulates
    // an edit to that section only.
    chunks[0] = chunk(0, "NEW text");
    const plan = planStaleness(existing, chunks, MODEL);
    expect(plan.stale).toEqual([chunk(0, "NEW text")]);
    expect(plan.obsoleteIxs).toEqual([]);
  });

  it("a note that shrank (fewer chunks) marks the dropped chunk_ix as obsolete", () => {
    const existing = [row(0, "a"), row(1, "b"), row(2, "c")];
    const chunks = [chunk(0, "a"), chunk(1, "b")]; // chunk 2 no longer exists
    const plan = planStaleness(existing, chunks, MODEL);
    expect(plan.stale).toEqual([]);
    expect(plan.obsoleteIxs).toEqual([2]);
  });

  it("a note that grew (more chunks) marks the new chunk_ix as stale, not obsolete", () => {
    const existing = [row(0, "a")];
    const chunks = [chunk(0, "a"), chunk(1, "new second chunk")];
    const plan = planStaleness(existing, chunks, MODEL);
    expect(plan.stale).toEqual([chunk(1, "new second chunk")]);
    expect(plan.obsoleteIxs).toEqual([]);
  });

  it("a model change marks every existing row obsolete and every current chunk stale (full sweep)", () => {
    const existing = [row(0, "a", "old-model"), row(1, "b", "old-model")];
    const chunks = [chunk(0, "a"), chunk(1, "b")];
    const plan = planStaleness(existing, chunks, "new-model");
    expect(plan.stale).toEqual(chunks);
    expect(plan.obsoleteIxs).toEqual([0, 1]);
  });

  it("composes shrink + edit + grow in one plan", () => {
    const existing = [row(0, "a"), row(1, "b-old"), row(2, "c")]; // 3 will drop, 1 will change
    const chunks = [chunk(0, "a"), chunk(1, "b-new"), chunk(3, "d")]; // note: ix 3, not 2 — a full re-chunk
    const plan = planStaleness(existing, chunks, MODEL);
    expect(plan.stale.map((c) => c.ix)).toEqual([1, 3]);
    // ix 1 still exists in the current chunk set (its content just
    // changed), so it's STALE, not obsolete — only ix 2 (dropped entirely)
    // is obsolete.
    expect(plan.obsoleteIxs).toEqual([2]);
  });
});
