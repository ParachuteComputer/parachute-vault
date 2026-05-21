/**
 * Unit tests for the opaque-cursor primitives (vault#313).
 *
 * Integration tests against `queryNotesPaged` live in core.test.ts under
 * `describe("cursor pagination")`. This file pins down the
 * encode/decode/hash invariants directly so a regression in the codec
 * surfaces here before it reaches the wider query pipeline.
 */

import { describe, it, expect } from "bun:test";
import {
  CURSOR_VERSION,
  CursorError,
  computeQueryHash,
  decodeCursor,
  encodeCursor,
  isoToMillis,
  millisToIso,
} from "./cursor.js";

describe("cursor codec", () => {
  it("encodes + decodes round-trips a payload", () => {
    const payload = {
      v: CURSOR_VERSION,
      last_updated_at: 1714000000000,
      last_id: "note-xyz",
      query_hash: "a".repeat(64),
    };
    const cursor = encodeCursor(payload);
    expect(typeof cursor).toBe("string");
    expect(cursor.length).toBeGreaterThan(0);
    // base64url has no `+`, `/`, or `=` padding.
    expect(cursor).not.toMatch(/[+/=]/);

    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual(payload);
  });

  it("decodeCursor rejects an empty string", () => {
    try {
      decodeCursor("");
      throw new Error("expected throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(CursorError);
      expect(err.code).toBe("cursor_invalid");
    }
  });

  it("decodeCursor rejects non-JSON inside a valid base64url", () => {
    const bogus = Buffer.from("not-json", "utf8").toString("base64url");
    try {
      decodeCursor(bogus);
      throw new Error("expected throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(CursorError);
      expect(err.code).toBe("cursor_invalid");
    }
  });

  it("decodeCursor rejects a wrong version number", () => {
    const cursor = encodeCursor({
      v: 999,
      last_updated_at: 0,
      last_id: "",
      query_hash: "abc",
    } as any);
    try {
      decodeCursor(cursor);
      throw new Error("expected throw");
    } catch (err: any) {
      expect(err.code).toBe("cursor_invalid");
      expect(err.message).toContain("schema version");
    }
  });

  it("decodeCursor rejects missing or wrong-type fields", () => {
    // Missing last_id.
    const missing = Buffer.from(
      JSON.stringify({ v: CURSOR_VERSION, last_updated_at: 0, query_hash: "x" }),
    ).toString("base64url");
    expect(() => decodeCursor(missing)).toThrow();

    // last_updated_at NaN.
    const nan = encodeCursor({
      v: CURSOR_VERSION,
      last_updated_at: NaN,
      last_id: "",
      query_hash: "x",
    });
    expect(() => decodeCursor(nan)).toThrow();
  });
});

describe("computeQueryHash", () => {
  it("is stable across key-order permutations", () => {
    const h1 = computeQueryHash({
      tags: ["alpha"],
      path: "p",
      metadata: { status: "open" },
    });
    const h2 = computeQueryHash({
      metadata: { status: "open" },
      path: "p",
      tags: ["alpha"],
    });
    expect(h1).toBe(h2);
  });

  it("is stable across tag-array order permutations", () => {
    const h1 = computeQueryHash({ tags: ["a", "b", "c"] });
    const h2 = computeQueryHash({ tags: ["c", "b", "a"] });
    expect(h1).toBe(h2);
  });

  it("treats `tags: []` and missing `tags` as equivalent (both mean 'no tag filter')", () => {
    const h1 = computeQueryHash({});
    const h2 = computeQueryHash({ tags: [] });
    expect(h1).toBe(h2);
  });

  it("changes when the query filters change", () => {
    const h1 = computeQueryHash({ tags: ["a"] });
    const h2 = computeQueryHash({ tags: ["b"] });
    expect(h1).not.toBe(h2);

    const h3 = computeQueryHash({ path: "p" });
    expect(h3).not.toBe(h1);
  });

  it("returns a 64-char hex string (sha256)", () => {
    const h = computeQueryHash({ tags: ["x"] });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("nested metadata operator clauses hash stably under key reorder", () => {
    // `{gte: 5, lt: 10}` and `{lt: 10, gte: 5}` are semantically identical
    // at the SQL layer (AND-conjunction of clauses); the hash must match.
    const h1 = computeQueryHash({ metadata: { priority: { gte: 5, lt: 10 } } });
    const h2 = computeQueryHash({ metadata: { priority: { lt: 10, gte: 5 } } });
    expect(h1).toBe(h2);
  });

  it("dateFilter contributes to the hash", () => {
    const h1 = computeQueryHash({ dateFilter: { field: "created_at", from: "2026-01-01" } });
    const h2 = computeQueryHash({ dateFilter: { field: "created_at", from: "2026-02-01" } });
    expect(h1).not.toBe(h2);
  });
});

describe("isoToMillis / millisToIso", () => {
  it("round-trips", () => {
    const iso = "2026-04-15T12:34:56.789Z";
    const ms = isoToMillis(iso);
    expect(millisToIso(ms)).toBe(iso);
  });

  it("rejects malformed ISO", () => {
    expect(() => isoToMillis("not-a-date")).toThrow();
  });
});
