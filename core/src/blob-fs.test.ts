import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FsBlobStore } from "./blob-fs.js";

let root: string;
let store: FsBlobStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pv-blob-fs-"));
  store = new FsBlobStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

describe("FsBlobStore", () => {
  it("round-trips bytes via nested key", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await store.put("2026-04-14/audio.wav", bytes);

    const got = await store.get("2026-04-14/audio.wav");
    expect(got).not.toBeNull();
    expect(got!.size).toBe(5);
    const drained = await drain(got!.body);
    expect(Array.from(drained)).toEqual([1, 2, 3, 4, 5]);
  });

  it("get returns null for missing keys", async () => {
    expect(await store.get("missing/file.bin")).toBeNull();
  });

  it("delete removes the file; subsequent delete is a no-op", async () => {
    await store.put("x/y.bin", new Uint8Array([9]));
    await store.delete("x/y.bin");
    expect(await store.get("x/y.bin")).toBeNull();
    // Deleting again must not throw.
    await store.delete("x/y.bin");
  });

  it("accepts ArrayBuffer and Blob inputs", async () => {
    const ab = new Uint8Array([7, 8]).buffer;
    await store.put("ab.bin", ab);
    const blob = new Blob([new Uint8Array([9])]);
    await store.put("blob.bin", blob);

    const a = await store.get("ab.bin");
    const b = await store.get("blob.bin");
    expect(Array.from(await drain(a!.body))).toEqual([7, 8]);
    expect(Array.from(await drain(b!.body))).toEqual([9]);
  });

  it("rejects keys that escape the root via '..'", async () => {
    expect(store.put("../outside.bin", new Uint8Array([1]))).rejects.toThrow(/escapes root/);
    expect(store.get("../outside.bin")).rejects.toThrow(/escapes root/);
    expect(store.delete("../../outside.bin")).rejects.toThrow(/escapes root/);
  });

  it("rejects empty and null-byte keys", async () => {
    expect(store.put("", new Uint8Array([1]))).rejects.toThrow(/Invalid blob key/);
    expect(store.put("a\0b", new Uint8Array([1]))).rejects.toThrow(/Invalid blob key/);
  });

  it("creates intermediate directories as needed", async () => {
    await store.put("deep/nested/path/thing.bin", new Uint8Array([1]));
    expect(existsSync(join(root, "deep", "nested", "path", "thing.bin"))).toBe(true);
  });
});
