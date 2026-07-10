/**
 * Unit tests for the ULID generator (vault#ulid-ids), pinned in isolation
 * from the Store. Integration coverage (new notes get ULID ids, mixed
 * old-format + ULID cursor pagination, old-format id round-trip) lives in
 * core.test.ts under `describe("ULID ids for new notes ...")`.
 */

import { describe, it, expect } from "bun:test";
import { generateUlid, ULID_REGEX } from "./ulid.js";

describe("generateUlid", () => {
  it("produces a 26-character Crockford base32 string", () => {
    const id = generateUlid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(ULID_REGEX);
  });

  it("never emits the excluded Crockford letters (I, L, O, U)", () => {
    for (let i = 0; i < 500; i++) {
      const id = generateUlid();
      expect(id).not.toMatch(/[ILOU]/);
    }
  });

  it("the first 10 chars encode a timestamp close to Date.now()", () => {
    const before = Date.now();
    const id = generateUlid();
    const after = Date.now();

    const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let time = 0;
    for (const ch of id.slice(0, 10)) {
      time = time * 32 + CROCKFORD.indexOf(ch);
    }
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
  });

  it("is monotonically increasing under plain string compare, even across a tight loop", () => {
    const ids = Array.from({ length: 1000 }, () => generateUlid());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it("produces no duplicates across many calls", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => generateUlid()));
    expect(ids.size).toBe(5000);
  });

  it("two IDs minted back-to-back share the same 10-char timestamp prefix (same ms) or the second sorts strictly after", () => {
    const a = generateUlid();
    const b = generateUlid();
    expect(b > a).toBe(true);
  });
});
