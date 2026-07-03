/**
 * Unit coverage for the DO-safe IN-list helpers (sql-in.ts).
 *
 * These are the cheap, backing-store-independent guards: a regression that
 * raises the chunk size above the Cloudflare Durable Object 100-bound-param
 * cap — the exact class that 500'd cloud-vault exports — fails HERE, without
 * needing a live DO. The behavioral proof over a real >100-note vault lives
 * in do-param-cap.test.ts; the ultimate DO-constraint proof is the cloud
 * staging export re-verify (bun:sqlite tolerates 999 params, so it can't
 * reproduce the DO failure locally).
 */
import { describe, it, expect } from "bun:test";
import { IN_PARAM_CHUNK, chunkForInClause, IN_VIA_JSON_EACH, jsonEachParam } from "./sql-in.js";

describe("IN_PARAM_CHUNK", () => {
  it("stays at or under the DO 100-bound-param cap (regression guard)", () => {
    // The whole point: never let the chunk size drift back over the cap.
    expect(IN_PARAM_CHUNK).toBeLessThanOrEqual(100);
    expect(IN_PARAM_CHUNK).toBeGreaterThan(0);
  });
});

describe("chunkForInClause", () => {
  it("splits 250 ids into chunks that are each <= the chunk size", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`);
    const chunks = chunkForInClause(ids);
    // 250 / 90 -> 3 chunks (90, 90, 70)
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(IN_PARAM_CHUNK);
    expect(chunks.map((c) => c.length)).toEqual([90, 90, 70]);
    // Every id is present exactly once, in order.
    expect(chunks.flat()).toEqual(ids);
  });

  it("returns no chunks for empty input", () => {
    expect(chunkForInClause([])).toEqual([]);
  });

  it("returns a single chunk when input fits", () => {
    const ids = ["a", "b", "c"];
    expect(chunkForInClause(ids)).toEqual([["a", "b", "c"]]);
  });

  it("honors an explicit smaller size", () => {
    const chunks = chunkForInClause([1, 2, 3, 4, 5], 2);
    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("json_each single-param IN", () => {
  it("serializes an id-set to one bound JSON param", () => {
    const ids = ["a", "b", "c"];
    expect(jsonEachParam(ids)).toBe('["a","b","c"]');
    // The fragment carries exactly one placeholder regardless of set size.
    expect(IN_VIA_JSON_EACH).toContain("json_each(?)");
    expect((IN_VIA_JSON_EACH.match(/\?/g) ?? []).length).toBe(1);
  });
});
