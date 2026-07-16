/**
 * Vector <-> BLOB codec + cosine-similarity math for semantic search.
 *
 * `note_vectors.vector` stores a `Float32Array` as raw bytes (a BLOB
 * column) — the door-agnostic shape the architecture doc settled on (a
 * BLOB in the same per-vault SQLite both `bun:sqlite` and the Cloudflare
 * DO shim support natively, vs. a vector extension neither door can share).
 * Vectors are stored L2-NORMALIZED (see `normalize` below) so that ranking
 * is a plain dot product — no per-query renormalization of every candidate
 * row, which matters once a scan is touching thousands of rows.
 */

/** L2-normalize a vector in place... no — returns a NEW Float32Array (never mutates the input). */
export function normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i]! * v[i]!;
  const norm = Math.sqrt(sumSq) || 1; // guard the all-zero vector (never divide by 0)
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** Dot product of two equal-length vectors. Cosine similarity IFF both are L2-normalized. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Encode a `Float32Array` to raw bytes for a SQLite BLOB parameter.
 * Copies (never returns a view over the input's possibly-shared
 * `ArrayBuffer`) so the caller's array can be mutated/GC'd freely
 * afterward without corrupting what's bound to the statement.
 */
export function encodeVector(v: Float32Array): Uint8Array {
  const copy = new Float32Array(v); // copies the values into a fresh buffer
  return new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength);
}

/**
 * Decode a BLOB column's raw bytes back to a `Float32Array`. `bun:sqlite`
 * returns BLOB columns as `Uint8Array`; a byte length not a multiple of 4
 * (corruption, or a caller passing the wrong column) throws rather than
 * silently truncating the last partial float.
 */
export function decodeVector(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new RangeError(
      `decodeVector: byte length ${blob.byteLength} is not a multiple of 4 (Float32Array) — corrupt or non-vector BLOB`,
    );
  }
  // Copy into a freshly-aligned buffer: `blob` may be a view with a
  // non-4-aligned `byteOffset` into a larger shared buffer (bun:sqlite's
  // returned Uint8Array isn't guaranteed aligned), and Float32Array's
  // constructor requires `byteOffset % 4 === 0` on the input buffer.
  const copy = new Uint8Array(blob); // copies bytes into a new, 0-offset buffer
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
