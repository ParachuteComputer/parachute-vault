/**
 * Runtime-portable blob (binary payload) storage.
 *
 * Attachment *metadata* lives in the SQLite `attachments` table; the actual
 * bytes live here. Self-hosted deployments back this with the filesystem
 * (`FsBlobStore`); Cloudflare Workers deployments back it with R2
 * (`R2BlobStore`). The SQLite row's `path` column is the `key` passed to
 * these methods — it is an opaque, forward-slash-separated string, never an
 * absolute filesystem path.
 */

export interface BlobPutOptions {
  mimeType?: string;
}

export interface BlobObject {
  /** Readable stream of the blob's bytes. Consumer is responsible for draining. */
  body: ReadableStream<Uint8Array>;
  mimeType?: string;
  size?: number;
}

export interface BlobStore {
  put(key: string, data: ArrayBuffer | Uint8Array | Blob, opts?: BlobPutOptions): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
}
