import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { normalize, dot, encodeVector, decodeVector } from "./vector-codec.js";

describe("normalize", () => {
  it("produces a unit-length vector", () => {
    const v = new Float32Array([3, 4]); // 3-4-5 triangle
    const n = normalize(v);
    const len = Math.sqrt(n[0] * n[0] + n[1] * n[1]);
    expect(len).toBeCloseTo(1, 5);
    expect(n[0]).toBeCloseTo(0.6, 5);
    expect(n[1]).toBeCloseTo(0.8, 5);
  });

  it("does not mutate the input", () => {
    const v = new Float32Array([3, 4]);
    normalize(v);
    expect(v[0]).toBe(3);
    expect(v[1]).toBe(4);
  });

  it("guards the all-zero vector instead of dividing by zero", () => {
    const v = new Float32Array([0, 0, 0]);
    const n = normalize(v);
    expect(Array.from(n)).toEqual([0, 0, 0]);
    expect(n.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe("dot", () => {
  it("computes the dot product of two vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    expect(dot(a, b)).toBeCloseTo(1 * 4 + 2 * 5 + 3 * 6, 5);
  });

  it("cosine similarity of two normalized identical vectors is 1", () => {
    const v = normalize(new Float32Array([1, 2, 3, 4]));
    expect(dot(v, v)).toBeCloseTo(1, 5);
  });

  it("cosine similarity of two normalized orthogonal vectors is 0", () => {
    const a = normalize(new Float32Array([1, 0]));
    const b = normalize(new Float32Array([0, 1]));
    expect(dot(a, b)).toBeCloseTo(0, 5);
  });
});

describe("encodeVector / decodeVector round-trip", () => {
  it("round-trips a vector through actual bytes (not a tautological identity check)", () => {
    const original = new Float32Array([0.1, -0.2, 3.14159, -0.0, 42, -42, 1e-10]);
    const encoded = encodeVector(original);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.byteLength).toBe(original.length * 4);
    const decoded = decodeVector(encoded);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("round-trips through an ACTUAL SQLite BLOB column, not just in-memory bytes", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (v BLOB)");
    const original = normalize(new Float32Array(384).map((_, i) => Math.sin(i)));
    db.prepare("INSERT INTO t (v) VALUES (?)").run(encodeVector(original));
    const row = db.prepare("SELECT v FROM t").get() as { v: Uint8Array };
    const decoded = decodeVector(row.v);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i], 5);
    }
    db.close();
  });

  it("encodeVector copies rather than aliasing the input buffer", () => {
    const original = new Float32Array([1, 2, 3]);
    const encoded = encodeVector(original);
    original[0] = 999;
    const decoded = decodeVector(encoded);
    expect(decoded[0]).toBeCloseTo(1, 5); // unaffected by the mutation above
  });

  it("decodeVector throws on a byte length that isn't a multiple of 4", () => {
    const bad = new Uint8Array([1, 2, 3]);
    expect(() => decodeVector(bad)).toThrow(RangeError);
  });

  it("decodeVector handles a non-4-aligned view into a larger shared buffer", () => {
    // Simulate what a driver might hand back: a Uint8Array view starting at
    // a byte offset that isn't a multiple of 4 within a larger buffer.
    const backing = new ArrayBuffer(20);
    const view = new Uint8Array(backing, 1, 16); // offset 1 — misaligned for Float32Array
    const original = new Float32Array([1.5, -2.5, 3.5, 4.5]);
    view.set(new Uint8Array(original.buffer, original.byteOffset, original.byteLength));
    const decoded = decodeVector(view);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
});
