// @ts-nocheck
/*! (c) Dmitry Chestnykh, D. Richard Hipp | BSD 2-Clause | https://github.com/dchest/fossil-delta-js/ */
// Vendored from fossil-delta@2.0.0 (npm sha512-rcvnd0xjV7KNkEbXhTCsjHhONvdami+WWhTYGf4ORkPk9ixkQDmVeII96F6wBD/6qa9zBjH15bOzSARKsQ/rKg==).
// Upstream fossil-delta.ts sha256 29d795837d08ff9305e145d20611e721e52aa29969c10c39c8f9d3d51be67b6c.
// CHANGES FROM UPSTREAM, and there are exactly four:
//   1. createStringDelta / applyStringDelta / getStringDeltaTargetSize are
//      DELETED. They decode raw delta bytes with TextDecoder (upstream
//      :455-461, :466-477), which replaces any non-UTF-8 byte run with U+FFFD.
//      MEASURED on this box: with a MID-BODY EDIT on an emoji body,
//      createStringDelta round-trips throw `unknown delta operator` 189 times
//      in 200 randomised cases. A pure APPEND on the same alphabet round-trips
//      fine, which is why the trigger is the edit shape, not the alphabet.
//      encodeDelta/decodeDelta below are the supported surface. (§1 probe C.)
//   2. encodeDelta / decodeDelta added.
//   3. This header.
//   4. Isolated in vendor/fossil-delta.ts with a file-scoped TypeScript opt-out.
//      Typed wrappers remain strict in ../delta.ts (spec §11.12).
// Why vendored rather than a dependency: core/package.json declares no
// dependencies at all, core never imports a third-party library by house rule
// (see BunSqliteStore.embeddingProvider's doc comment, core/src/store.ts:
// "core never imports a model library itself (dependency-purity rule)"), and
// PR 1 §1 probe E set the precedent by refusing @noble/hashes. The Fossil
// delta format is a frozen, documented wire format, not a moving target.


// Fossil SCM delta compression algorithm

// We accept plain arrays of bytes or Uint8Array.
export type ByteArray = number[] | Uint8Array;

// Hash window width in bytes. Must be a power of two.
const NHASH = 16;

class RollingHash {
  private a = 0; // hash     (16-bit unsigned)
  private b = 0; // values   (16-bit unsigned)
  private i = 0; // start of the hash window (16-bit unsigned)
  private z = new Array(NHASH); // the values that have been hashed.

  // Initialize the rolling hash using the first NHASH bytes of
  // z at the given position.
  init(z: ByteArray, pos: number) {
    let a = 0,
      b = 0;
    for (let i = 0; i < NHASH; i++) {
      const x = z[pos + i];
      a = (a + x) & 0xffff;
      b = (b + (NHASH - i) * x) & 0xffff;
      this.z[i] = x;
    }
    this.a = a & 0xffff;
    this.b = b & 0xffff;
    this.i = 0;
  }

  // Advance the rolling hash by a single byte "c".
  next(c: number) {
    const old = this.z[this.i];
    this.z[this.i] = c;
    this.i = (this.i + 1) & (NHASH - 1);
    this.a = (this.a - old + c) & 0xffff;
    this.b = (this.b - NHASH * old + this.a) & 0xffff;
  }

  // Return a 32-bit hash value.
  value() {
    return ((this.a & 0xffff) | ((this.b & 0xffff) << 16)) >>> 0;
  }
}

const zDigits =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~"
    .split("")
    .map(function (x) {
      return x.charCodeAt(0);
    });

const zValue = [
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, -1, -1,
  -1, -1, -1, -1, -1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
  24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, -1, -1, -1, -1, 36, -1, 37,
  38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
  57, 58, 59, 60, 61, 62, -1, -1, -1, 63, -1,
];

// Reader reads bytes, chars, ints from array.
class Reader {
  public a: ByteArray;
  public pos: number;

  constructor(array: ByteArray) {
    this.a = array; // source array
    this.pos = 0; // current position in array
  }

  haveBytes() {
    return this.pos < this.a.length;
  }

  getByte() {
    const b = this.a[this.pos];
    this.pos++;
    if (this.pos > this.a.length) throw new RangeError("out of bounds");
    return b;
  }

  getChar() {
    return String.fromCharCode(this.getByte());
  }

  // Read base64-encoded unsigned integer.
  getInt() {
    let v = 0;
    let c: number;
    while (this.haveBytes() && (c = zValue[0x7f & this.getByte()]) >= 0) {
      v = (v << 6) + c;
    }
    this.pos--;
    return v >>> 0;
  }
}

// Write writes an array.
class Writer {
  private a: number[] = [];

  toByteArray<T extends ByteArray>(sourceType: T): T {
    if (Array.isArray(sourceType)) {
      return this.a as T;
    }
    return new Uint8Array(this.a) as T;
  }

  putByte(b: number) {
    this.a.push(b & 0xff);
  }

  // Write an ASCII character (s is a one-char string).
  putChar(s: string) {
    this.putByte(s.charCodeAt(0));
  }

  // Write a base64 unsigned integer.
  putInt(v: number) {
    const zBuf: number[] = [];
    if (v === 0) {
      this.putChar("0");
      return;
    }
    let i = 0;
    for (; v > 0; i++, v >>>= 6) {
      zBuf.push(zDigits[v & 0x3f]);
    }
    for (let j = i - 1; j >= 0; j--) {
      this.putByte(zBuf[j]);
    }
  }

  // Copy from array at start to end.
  putArray(a: ByteArray, start: number, end: number) {
    // TODO: optimize
    for (let i = start; i < end; i++) this.a.push(a[i]);
  }
}

// Return the number digits in the base64 representation of a positive integer.
function digitCount(v: number) {
  let i: number, x: number;
  for (i = 1, x = 64; v >= x; i++, x <<= 6) {
    /* nothing */
  }
  return i;
}

// Return a 32-bit checksum of the array.
function checksum(arr: ByteArray): number {
  let sum0 = 0,
    sum1 = 0,
    sum2 = 0,
    sum3 = 0,
    z = 0,
    N = arr.length;
  //TODO measure if this unrolling is helpful.
  while (N >= 16) {
    sum0 = (sum0 + arr[z + 0]) | 0;
    sum1 = (sum1 + arr[z + 1]) | 0;
    sum2 = (sum2 + arr[z + 2]) | 0;
    sum3 = (sum3 + arr[z + 3]) | 0;

    sum0 = (sum0 + arr[z + 4]) | 0;
    sum1 = (sum1 + arr[z + 5]) | 0;
    sum2 = (sum2 + arr[z + 6]) | 0;
    sum3 = (sum3 + arr[z + 7]) | 0;

    sum0 = (sum0 + arr[z + 8]) | 0;
    sum1 = (sum1 + arr[z + 9]) | 0;
    sum2 = (sum2 + arr[z + 10]) | 0;
    sum3 = (sum3 + arr[z + 11]) | 0;

    sum0 = (sum0 + arr[z + 12]) | 0;
    sum1 = (sum1 + arr[z + 13]) | 0;
    sum2 = (sum2 + arr[z + 14]) | 0;
    sum3 = (sum3 + arr[z + 15]) | 0;

    z += 16;
    N -= 16;
  }
  while (N >= 4) {
    sum0 = (sum0 + arr[z + 0]) | 0;
    sum1 = (sum1 + arr[z + 1]) | 0;
    sum2 = (sum2 + arr[z + 2]) | 0;
    sum3 = (sum3 + arr[z + 3]) | 0;
    z += 4;
    N -= 4;
  }
  sum3 = (((((sum3 + (sum2 << 8)) | 0) + (sum1 << 16)) | 0) + (sum0 << 24)) | 0;
  switch (N) {
    case 3:
      sum3 = (sum3 + (arr[z + 2] << 8)) | 0; /* falls through */
    case 2:
      sum3 = (sum3 + (arr[z + 1] << 16)) | 0; /* falls through */
    case 1:
      sum3 = (sum3 + (arr[z + 0] << 24)) | 0; /* falls through */
  }
  return sum3 >>> 0;
}

/**
 * Create a new delta array of bytes from source byte array to target byte array.
 */
export function createDelta<T extends ByteArray>(source: T, target: T): T {
  const zDelta = new Writer();
  const lenOut = target.length;
  const lenSrc = source.length;
  let lastRead = -1;

  zDelta.putInt(lenOut);
  zDelta.putChar("\n");

  // If the source is very small, it means that we have no
  // chance of ever doing a copy command.  Just output a single
  // literal segment for the entire target and exit.
  if (lenSrc <= NHASH) {
    zDelta.putInt(lenOut);
    zDelta.putChar(":");
    zDelta.putArray(target, 0, lenOut);
    zDelta.putInt(checksum(target));
    zDelta.putChar(";");
    return zDelta.toByteArray(source);
  }

  // Compute the hash table used to locate matching sections in the source.
  const nHash = Math.ceil(lenSrc / NHASH);
  const collide = new Array(nHash);
  const landmark = new Array(nHash);
  for (let i = 0; i < collide.length; i++) {
    collide[i] = -1;
  }
  for (let i = 0; i < landmark.length; i++) {
    landmark[i] = -1;
  }
  let hv: number;
  const h = new RollingHash();
  for (let i = 0; i < lenSrc - NHASH; i += NHASH) {
    h.init(source, i);
    hv = h.value() % nHash;
    collide[i / NHASH] = landmark[hv];
    landmark[hv] = i / NHASH;
  }

  let base = 0;
  let iSrc: number,
    iBlock: number,
    bestCnt: number,
    bestOfst: number,
    bestLitsz: number;
  while (base + NHASH < lenOut) {
    bestOfst = 0;
    bestLitsz = 0;
    h.init(target, base);
    let i = 0; // Trying to match a landmark against zOut[base+i]
    bestCnt = 0;
    while (1) {
      let limit = 250;
      hv = h.value() % nHash;
      iBlock = landmark[hv];
      while (iBlock >= 0 && limit-- > 0) {
        //
        // The hash window has identified a potential match against
        // landmark block iBlock.  But we need to investigate further.
        //
        // Look for a region in zOut that matches zSrc. Anchor the search
        // at zSrc[iSrc] and zOut[base+i].  Do not include anything prior to
        // zOut[base] or after zOut[outLen] nor anything after zSrc[srcLen].
        //
        // Set cnt equal to the length of the match and set ofst so that
        // zSrc[ofst] is the first element of the match.  litsz is the number
        // of characters between zOut[base] and the beginning of the match.
        // sz will be the overhead (in bytes) needed to encode the copy
        // command.  Only generate copy command if the overhead of the
        // copy command is less than the amount of literal text to be copied.
        //
        let cnt: number, ofst: number, litsz: number;
        let j: number, k: number, x: number, y: number;
        let sz: number;

        // Beginning at iSrc, match forwards as far as we can.
        // j counts the number of characters that match.
        iSrc = iBlock * NHASH;
        for (
          j = 0, x = iSrc, y = base + i;
          x < lenSrc && y < lenOut;
          j++, x++, y++
        ) {
          if (source[x] !== target[y]) break;
        }
        j--;

        // Beginning at iSrc-1, match backwards as far as we can.
        // k counts the number of characters that match.
        for (k = 1; k < iSrc && k <= i; k++) {
          if (source[iSrc - k] !== target[base + i - k]) break;
        }
        k--;

        // Compute the offset and size of the matching region.
        ofst = iSrc - k;
        cnt = j + k + 1;
        litsz = i - k; // Number of bytes of literal text before the copy
        // sz will hold the number of bytes needed to encode the "insert"
        // command and the copy command, not counting the "insert" text.
        sz = digitCount(i - k) + digitCount(cnt) + digitCount(ofst) + 3;
        if (cnt >= sz && cnt > bestCnt) {
          // Remember this match only if it is the best so far and it
          // does not increase the file size.
          bestCnt = cnt;
          bestOfst = iSrc - k;
          bestLitsz = litsz;
        }

        // Check the next matching block
        iBlock = collide[iBlock];
      }

      // We have a copy command that does not cause the delta to be larger
      // than a literal insert.  So add the copy command to the delta.
      if (bestCnt > 0) {
        if (bestLitsz > 0) {
          // Add an insert command before the copy.
          zDelta.putInt(bestLitsz);
          zDelta.putChar(":");
          zDelta.putArray(target, base, base + bestLitsz);
          base += bestLitsz;
        }
        base += bestCnt;
        zDelta.putInt(bestCnt);
        zDelta.putChar("@");
        zDelta.putInt(bestOfst);
        zDelta.putChar(",");
        if (bestOfst + bestCnt - 1 > lastRead) {
          lastRead = bestOfst + bestCnt - 1;
        }
        bestCnt = 0;
        break;
      }

      // If we reach this point, it means no match is found so far
      if (base + i + NHASH >= lenOut) {
        // We have reached the end and have not found any
        // matches.  Do an "insert" for everything that does not match
        zDelta.putInt(lenOut - base);
        zDelta.putChar(":");
        zDelta.putArray(target, base, base + lenOut - base);
        base = lenOut;
        break;
      }

      // Advance the hash by one character. Keep looking for a match.
      h.next(target[base + i + NHASH]);
      i++;
    }
  }
  // Output a final "insert" record to get all the text at the end of
  // the file that does not match anything in the source.
  if (base < lenOut) {
    zDelta.putInt(lenOut - base);
    zDelta.putChar(":");
    zDelta.putArray(target, base, base + lenOut - base);
  }
  // Output the final checksum record.
  zDelta.putInt(checksum(target));
  zDelta.putChar(";");
  return zDelta.toByteArray(source);
}

/**
 * Return the size (in bytes) of the target from applying a delta.
 */
export function getDeltaTargetSize(delta: ByteArray): number {
  const zDelta = new Reader(delta);
  const size = zDelta.getInt();
  if (zDelta.getChar() !== "\n") {
    throw new Error("size integer not terminated by '\\n'");
  }
  return size;
}

export type Options = {
  verifyChecksum?: boolean;
};

/**
 * Apply a delta byte array to a source byte array, returning the target byte array.
 */
export function applyDelta<T extends ByteArray>(
  source: T,
  delta: T,
  opts?: Options
): T {
  let limit: number,
    total = 0;
  const zDelta = new Reader(delta);
  const lenSrc = source.length;
  const lenDelta = delta.length;

  limit = zDelta.getInt();
  if (zDelta.getChar() !== "\n")
    throw new Error("size integer not terminated by '\\n'");
  const zOut = new Writer();
  while (zDelta.haveBytes()) {
    let cnt = zDelta.getInt();
    let ofst: number;

    switch (zDelta.getChar()) {
      case "@":
        ofst = zDelta.getInt();
        if (zDelta.haveBytes() && zDelta.getChar() !== ",")
          throw new Error("copy command not terminated by ','");
        total += cnt;
        if (total > limit) throw new Error("copy exceeds output file size");
        if (ofst + cnt > lenSrc)
          throw new Error("copy extends past end of input");
        zOut.putArray(source, ofst, ofst + cnt);
        break;

      case ":":
        total += cnt;
        if (total > limit)
          throw new Error(
            "insert command gives an output larger than predicted"
          );
        if (cnt > lenDelta)
          throw new Error("insert count exceeds size of delta");
        zOut.putArray(zDelta.a, zDelta.pos, zDelta.pos + cnt);
        zDelta.pos += cnt;
        break;

      case ";":
        const out = zOut.toByteArray(source);
        if ((!opts || opts.verifyChecksum !== false) && cnt !== checksum(out))
          throw new Error("bad checksum");
        if (total !== limit)
          throw new Error("generated size does not match predicted size");
        return out;

      default:
        throw new Error("unknown delta operator");
    }
  }
  throw new Error("unterminated delta");
}
