/**
 * Filesystem-backed `BlobStore`.
 *
 * Self-hosted deployments use this with the vault's assets directory as the
 * root. Keys are relative, forward-slash paths like `2026-03-31/audio.wav`.
 * A normalize-and-prefix-check guards against `..` escape.
 */

import { existsSync, mkdirSync, statSync, unlinkSync, readFileSync } from "fs";
import { dirname, join, normalize, sep } from "path";
import type { BlobStore, BlobObject, BlobPutOptions } from "./blob-store.js";

export class FsBlobStore implements BlobStore {
  constructor(public readonly rootDir: string) {}

  async put(key: string, data: ArrayBuffer | Uint8Array | Blob, _opts?: BlobPutOptions): Promise<void> {
    const abs = this.resolve(key);
    mkdirSync(dirname(abs), { recursive: true });
    const bytes = await toUint8Array(data);
    await Bun.write(abs, bytes);
  }

  async get(key: string): Promise<BlobObject | null> {
    const abs = this.resolve(key);
    if (!existsSync(abs)) return null;
    const size = statSync(abs).size;
    // Bun.file().stream() would be nicer, but the bytes we already read are
    // cheap to re-stream and keeps this dependency-free of Bun's File type.
    const buf = readFileSync(abs);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buf));
        controller.close();
      },
    });
    return { body: stream, size };
  }

  async delete(key: string): Promise<void> {
    const abs = this.resolve(key);
    if (existsSync(abs)) unlinkSync(abs);
  }

  /** Resolve a key to an absolute path, rejecting anything that escapes `rootDir`. */
  private resolve(key: string): string {
    if (!key || key.includes("\0")) {
      throw new Error(`Invalid blob key: ${JSON.stringify(key)}`);
    }
    const root = normalize(this.rootDir);
    const abs = normalize(join(root, key));
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (abs !== root && !abs.startsWith(rootWithSep)) {
      throw new Error(`Blob key escapes root: ${JSON.stringify(key)}`);
    }
    return abs;
  }
}

async function toUint8Array(data: ArrayBuffer | Uint8Array | Blob): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}
