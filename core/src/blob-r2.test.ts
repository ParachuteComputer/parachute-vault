import { describe, it, expect, beforeEach } from "bun:test";
import { R2BlobStore, type R2BucketLike, type R2ObjectBody, type R2PutOptions } from "./blob-r2.js";

class MockR2Bucket implements R2BucketLike {
  readonly store = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(key: string, value: ArrayBuffer | Uint8Array | Blob | ReadableStream, options?: R2PutOptions): Promise<unknown> {
    const bytes = value instanceof Uint8Array ? value
      : value instanceof ArrayBuffer ? new Uint8Array(value)
      : value instanceof Blob ? new Uint8Array(await value.arrayBuffer())
      : await drainToBytes(value as ReadableStream<Uint8Array>);
    this.store.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    return undefined;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const v = this.store.get(key);
    if (!v) return null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(v.bytes); controller.close(); },
    });
    return {
      body,
      size: v.bytes.byteLength,
      httpMetadata: v.contentType ? { contentType: v.contentType } : undefined,
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

async function drainToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

let bucket: MockR2Bucket;

beforeEach(() => {
  bucket = new MockR2Bucket();
});

describe("R2BlobStore", () => {
  it("round-trips bytes with mimeType", async () => {
    const store = new R2BlobStore(bucket, "vault-abc");
    await store.put("2026-04-14/a.wav", new Uint8Array([1, 2, 3]), { mimeType: "audio/wav" });

    expect(bucket.store.has("vault-abc/2026-04-14/a.wav")).toBe(true);
    const got = await store.get("2026-04-14/a.wav");
    expect(got).not.toBeNull();
    expect(got!.size).toBe(3);
    expect(got!.mimeType).toBe("audio/wav");
  });

  it("returns null for missing keys", async () => {
    const store = new R2BlobStore(bucket, "v1");
    expect(await store.get("nope")).toBeNull();
  });

  it("delete removes the object", async () => {
    const store = new R2BlobStore(bucket, "v1");
    await store.put("x.bin", new Uint8Array([9]));
    await store.delete("x.bin");
    expect(await store.get("x.bin")).toBeNull();
  });

  it("works without a prefix", async () => {
    const store = new R2BlobStore(bucket, "");
    await store.put("a/b.bin", new Uint8Array([5]));
    expect(bucket.store.has("a/b.bin")).toBe(true);
  });

  it("normalizes slashes between prefix and key", async () => {
    const store = new R2BlobStore(bucket, "v1/");
    await store.put("/a/b.bin", new Uint8Array([5]));
    expect(bucket.store.has("v1/a/b.bin")).toBe(true);
  });

  it("rejects empty keys", async () => {
    const store = new R2BlobStore(bucket, "v1");
    expect(store.put("", new Uint8Array([1]))).rejects.toThrow(/non-empty/);
  });
});
