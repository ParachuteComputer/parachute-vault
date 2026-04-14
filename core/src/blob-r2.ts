/**
 * Cloudflare R2–backed `BlobStore`.
 *
 * Import only from Workers code. Avoids a hard dependency on
 * `@cloudflare/workers-types` by using a minimal structural interface for
 * the bucket surface we use. A real `R2Bucket` binding satisfies it
 * structurally.
 *
 * The `prefix` is prepended to every key with a `/` separator so one R2
 * bucket can host many vaults (`<vault-id>/<date>/<file>`).
 */

import type { BlobStore, BlobObject, BlobPutOptions } from "./blob-store.js";

// ---------------------------------------------------------------------------
// Minimal structural types — shaped to match the bits of R2 we use.
// ---------------------------------------------------------------------------

export interface R2PutOptions {
  httpMetadata?: { contentType?: string };
}

export interface R2ObjectBody {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly httpMetadata?: { contentType?: string };
}

export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array | Blob | ReadableStream, options?: R2PutOptions): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class R2BlobStore implements BlobStore {
  /**
   * @param bucket  An R2 bucket binding (from `env.<BINDING>`), or any object
   *                that satisfies `R2BucketLike`.
   * @param prefix  Optional key prefix. Joined with the user-supplied key via
   *                `/`. Empty string = no prefix.
   */
  constructor(private readonly bucket: R2BucketLike, private readonly prefix: string = "") {}

  async put(key: string, data: ArrayBuffer | Uint8Array | Blob, opts?: BlobPutOptions): Promise<void> {
    await this.bucket.put(this.fullKey(key), data, opts?.mimeType ? { httpMetadata: { contentType: opts.mimeType } } : undefined);
  }

  async get(key: string): Promise<BlobObject | null> {
    const obj = await this.bucket.get(this.fullKey(key));
    if (!obj) return null;
    return {
      body: obj.body,
      size: obj.size,
      mimeType: obj.httpMetadata?.contentType,
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(this.fullKey(key));
  }

  private fullKey(key: string): string {
    if (!key) throw new Error("Blob key must be non-empty");
    if (!this.prefix) return key;
    return `${this.prefix.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
  }
}
