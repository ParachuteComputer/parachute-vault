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

import { rmSync } from "fs";

/**
 * Download `url` to `dest` (follows redirects). Streams chunk-by-chunk — never
 * buffers the whole body (models run up to ~660MB). On any mid-stream failure
 * the partial file is removed so a retry never trusts a truncated artifact.
 * When the server sent an honest `content-length` (no content-encoding
 * transform), a byte-count mismatch is treated as a failed download too.
 */
export async function downloadTo(url: string, dest: string): Promise<void> {
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

  const sink = Bun.file(dest).writer();
  let written = 0;
  try {
    for await (const chunk of resp.body) {
      sink.write(chunk);
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
}
