/**
 * Streaming file download for `transcription install` (tarball, GGUF models,
 * CLI sources).
 *
 * ## Why a manual pump instead of `Bun.write(dest, resp)` (vault#534 blocker 1)
 *
 * `Bun.write(dest, response)` HANGS FOREVER on Linux when streaming a large
 * Response body to disk — zero bytes land, no error, no timeout. Reproduced
 * deterministically in real Linux containers on BOTH arches (aarch64 native +
 * x86_64 emulated) across bun 1.2.23 / 1.3.13 / 1.3.14, while the identical
 * code works on macOS. In the same environment `curl` pulls the same URL at
 * full speed and `await resp.arrayBuffer()` gets all 26MB in ~2s — the bug is
 * specifically Bun's Response→file streaming fast path. Manually pumping
 * `resp.body` chunks into a `Bun.file(dest).writer()` moves the same 26MB in
 * <1s and works on both platforms, so that's what we do everywhere (no
 * platform gate). See vault#534 for the full container verification.
 */

import { existsSync, rmSync } from "fs";

/**
 * A content hash the UPSTREAM host publishes for an artifact, discovered at
 * download time rather than pinned in this repo.
 */
export interface UpstreamDigest {
  /** Lowercase hex sha256 of the file's bytes. */
  sha256: string;
  /** Where we learned it, for error messages. */
  source: string;
}

/**
 * Ask the host whether it publishes a content digest for `url`, WITHOUT
 * downloading the body.
 *
 * HuggingFace — where every GGUF model in `models.ts` / `install.ts` comes
 * from — serves LFS-backed `resolve/` URLs as a 302 whose `x-linked-etag`
 * header is the git-LFS oid: the plain sha256 of the file's bytes. Verified
 * against a real download (`ggml-tiny.en.bin`, 77,704,715 bytes): the header
 * and `shasum -a 256` of the fetched file agree exactly. `x-linked-size`
 * likewise matches the byte count.
 *
 * The redirect TARGET's own `etag` is a different thing — HF's Xet CAS hash,
 * not a sha256 of the content — so the digest has to be read off the 302
 * itself. That's why this uses `redirect: "manual"` instead of reading
 * headers off the followed response.
 *
 * Returns `null` for any host that publishes nothing (GitHub release assets,
 * today). A missing digest is NOT an error: it degrades to the size check
 * `downloadTo` already performs. Network failures here are swallowed for the
 * same reason — a checksum probe must never be the thing that breaks an
 * install.
 */
export async function fetchUpstreamDigest(url: string): Promise<UpstreamDigest | null> {
  try {
    const resp = await fetch(url, { method: "GET", redirect: "manual", headers: { range: "bytes=0-0" } });
    // Consume/discard: with `redirect: manual` the 302 body is a short stub,
    // and the range header keeps a non-redirecting 200 to a single byte.
    try { await resp.arrayBuffer(); } catch { /* nothing worth reporting */ }
    const linked = resp.headers.get("x-linked-etag") ?? resp.headers.get("x-linked-etag".toUpperCase());
    const hex = normalizeSha256Etag(linked);
    if (hex) return { sha256: hex, source: "HuggingFace x-linked-etag (git-LFS oid)" };
    return null;
  } catch {
    return null;
  }
}

/**
 * An ETag is quoted and may carry a `W/` weak prefix. Accept it only when what
 * remains is exactly 64 hex characters — anything else is some other host's
 * opaque cache token, not a sha256, and must not be treated as one.
 */
function normalizeSha256Etag(raw: string | null): string | null {
  if (!raw) return null;
  const stripped = raw.trim().replace(/^W\//i, "").replace(/^"|"$/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(stripped) ? stripped : null;
}

/** Streaming sha256 of a file already on disk — never buffers it whole. */
export async function sha256OfFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

export interface DownloadOptions {
  /**
   * Expected lowercase-hex sha256. When set, the hash is computed AS THE BYTES
   * STREAM (no second pass, no buffering) and a mismatch removes the file and
   * throws.
   */
  sha256?: string | null;
}

/**
 * Download `url` to `dest` (follows redirects). Streams chunk-by-chunk — never
 * buffers the whole body (models run up to ~660MB). On any mid-stream failure
 * the partial file is removed so a retry never trusts a truncated artifact.
 * When the server sent an honest `content-length` (no content-encoding
 * transform), a byte-count mismatch is treated as a failed download too.
 *
 * With `opts.sha256`, content integrity is checked as well as length — a
 * corrupted-but-complete transfer (a proxy that mangles bytes, a truncation
 * the length check can't see because no `content-length` was sent) is caught
 * and the file removed.
 */
export async function downloadTo(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`download failed (${resp.status}) for ${url}`);
  if (!resp.body) throw new Error(`download failed (empty response body) for ${url}`);

  // content-length is only the on-the-wire byte count when no transfer
  // decompression happened; fetch auto-decodes content-encoding'd bodies, so
  // only enforce the size check for identity responses (the normal case for
  // release tarballs + GGUFs — both already-compressed binary).
  const encoding = resp.headers.get("content-encoding");
  const lengthHeader = resp.headers.get("content-length");
  const expectedBytes =
    (!encoding || encoding === "identity") && lengthHeader && /^\d+$/.test(lengthHeader)
      ? Number(lengthHeader)
      : null;

  const wantSha = opts.sha256 ? opts.sha256.trim().toLowerCase() : null;
  const hasher = wantSha ? new Bun.CryptoHasher("sha256") : null;

  const sink = Bun.file(dest).writer();
  let written = 0;
  try {
    for await (const chunk of resp.body) {
      sink.write(chunk);
      hasher?.update(chunk);
      written += chunk.byteLength;
    }
    await sink.end();
  } catch (err) {
    // Flush/close what we can, then remove the partial file — a half-written
    // tarball/model must never survive to be mistaken for a good artifact.
    try {
      await sink.end();
    } catch {
      // best-effort close; the rm below is what matters
    }
    rmSync(dest, { force: true });
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`download of ${url} failed after ${written} bytes: ${msg}`);
  }

  if (expectedBytes !== null && written !== expectedBytes) {
    rmSync(dest, { force: true });
    throw new Error(
      `download of ${url} was truncated: got ${written} bytes, expected ${expectedBytes} (content-length)`,
    );
  }

  if (wantSha && hasher) {
    const got = hasher.digest("hex");
    if (got !== wantSha) {
      rmSync(dest, { force: true });
      throw new Error(
        `download of ${url} failed checksum: sha256 ${got}, expected ${wantSha}`,
      );
    }
  }
}

/**
 * Fetch `url` to `dest` **idempotently** — the policy `transcription install`
 * needs for a re-run (vault#531).
 *
 * The hole this closes: the install path skipped any file that merely EXISTED
 * (`existsSync(dest) && !force`). `downloadTo` removes partials it notices, but
 * it can't notice everything — a `kill -9` mid-write, a full disk, or a server
 * that sent no `content-length` all leave a complete-looking file behind. From
 * then on every non-`--force` re-run reported "already present — skipping" and
 * the operator got a corrupt model forever, with no signal and no path out
 * short of knowing to pass `--force`.
 *
 * So: when the artifact is already on disk and the host publishes a digest, we
 * VERIFY it before trusting it, and re-download on mismatch. When the host
 * publishes nothing, behaviour is unchanged (skip) — this can only ever turn a
 * silent corruption into a repair, never a good file into a re-download.
 *
 * Returns what happened so the caller can print something honest.
 */
export type EnsureOutcome = "downloaded" | "reused" | "repaired";

export async function ensureDownloaded(
  url: string,
  dest: string,
  opts: {
    force?: boolean;
    /**
     * Called just before bytes are actually pulled, so the caller can print a
     * progress line only when there IS a transfer. `reason` distinguishes a
     * first fetch from replacing a bad file.
     */
    onBeforeDownload?: (reason: "missing" | "forced" | "corrupt") => void;
  } = {},
): Promise<{ outcome: EnsureOutcome; verified: boolean }> {
  const digest = await fetchUpstreamDigest(url);

  if (existsSync(dest) && !opts.force) {
    if (!digest) return { outcome: "reused", verified: false };
    const actual = await sha256OfFile(dest);
    if (actual === digest.sha256) return { outcome: "reused", verified: true };
    // Present but wrong — the corrupt-and-skipped case. Replace it.
    rmSync(dest, { force: true });
    opts.onBeforeDownload?.("corrupt");
    await downloadTo(url, dest, { sha256: digest.sha256 });
    return { outcome: "repaired", verified: true };
  }

  opts.onBeforeDownload?.(existsSync(dest) ? "forced" : "missing");
  await downloadTo(url, dest, { sha256: digest?.sha256 ?? null });
  return { outcome: "downloaded", verified: digest !== null };
}
