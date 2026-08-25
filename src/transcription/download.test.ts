import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  downloadTo,
  ensureDownloaded,
  fetchUpstreamDigest,
  sha256OfFile,
} from "./download.ts";

/**
 * `downloadTo` tests (vault#534 blocker 1). The manual body→FileSink pump
 * replaced `Bun.write(dest, resp)`, which hangs forever on Linux for large
 * responses. These run the pump against an in-process `Bun.serve` (no
 * subprocess involved — see CLAUDE.md's spawnSync note; plain in-process
 * fetches are fine) and pin: bytes land intact, HTTP errors throw, and a
 * mid-stream failure never leaves a partial file behind.
 */

const dir = mkdtempSync(join(tmpdir(), "vault-download-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// 4MB of deterministic non-trivial bytes — large enough to stream in many
// chunks (the hang was specific to the large-response path).
const PAYLOAD = new Uint8Array(4 * 1024 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 31 + (i >> 8)) & 0xff;

function serve(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { server, url: `http://127.0.0.1:${server.port}` };
}

describe("downloadTo", () => {
  test("streams a multi-MB body to disk byte-for-byte", async () => {
    const { server, url } = serve(() => new Response(PAYLOAD));
    const dest = join(dir, "ok.bin");
    try {
      await downloadTo(`${url}/file`, dest);
      const got = readFileSync(dest);
      expect(got.byteLength).toBe(PAYLOAD.byteLength);
      expect(Buffer.from(got).equals(Buffer.from(PAYLOAD))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("non-OK status throws with the status + URL, writes nothing", async () => {
    const { server, url } = serve(() => new Response("nope", { status: 404 }));
    const dest = join(dir, "missing.bin");
    try {
      expect(downloadTo(`${url}/gone`, dest)).rejects.toThrow(/download failed \(404\)/);
      expect(existsSync(dest)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("truncated download throws AND removes the partial file", async () => {
    // Raw TCP fixture: a real content-length response (how GitHub releases +
    // HuggingFace serve these binaries) whose connection dies mid-body.
    // Bun.serve can't fixture this — it re-frames streamed responses as
    // chunked (dropping content-length), and Bun's fetch ends a truncated
    // chunked stream CLEANLY, so truncation is only detectable on the
    // content-length path `downloadTo` verifies.
    const partial = PAYLOAD.slice(0, 64 * 1024);
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(
            `HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: ${PAYLOAD.byteLength}\r\n\r\n`,
          );
          socket.write(partial);
          socket.end(); // die after 64KB of a declared 4MB
        },
        open() {},
        close() {},
        error() {},
      },
    });
    const dest = join(dir, "partial.bin");
    try {
      let threw = false;
      try {
        await downloadTo(`http://127.0.0.1:${listener.port}/flaky`, dest);
      } catch (err) {
        threw = true;
        // The truncation surfaces differently per platform: on macOS the body
        // stream errors mid-pump (wrapped "failed after N bytes") or the
        // short read trips the content-length check ("truncated"); on Linux
        // Bun's fetch() itself rejects on the early socket close. All are
        // loud failures — the invariants are THROWS + NO PARTIAL FILE.
        expect(String(err)).toMatch(
          /failed after \d+ bytes|truncated|socket connection was closed|connection closed/i,
        );
      }
      expect(threw).toBe(true);
      // The half-written file must not survive to be mistaken for a good artifact.
      expect(existsSync(dest)).toBe(false);
    } finally {
      listener.stop(true);
    }
  });
});

/**
 * Checksum + idempotency (vault#531). The digest shape under test is the real
 * one: HuggingFace serves LFS-backed `resolve/` URLs as a 302 carrying
 * `x-linked-etag` = the plain sha256 of the bytes. Verified against a live
 * download of ggml-tiny.en.bin (77,704,715 bytes) — header and
 * `shasum -a 256` agreed exactly — and fixtured here so the suite stays
 * offline.
 */
const PAYLOAD_SHA = new Bun.CryptoHasher("sha256").update(PAYLOAD).digest("hex");

describe("downloadTo — sha256 verification", () => {
  test("accepts a body whose hash matches", async () => {
    const { server, url } = serve(() => new Response(PAYLOAD));
    const dest = join(dir, "sha-ok.bin");
    try {
      await downloadTo(`${url}/file`, dest, { sha256: PAYLOAD_SHA });
      expect(readFileSync(dest).byteLength).toBe(PAYLOAD.byteLength);
    } finally {
      server.stop(true);
    }
  });

  test("a complete-but-corrupt body throws AND removes the file", async () => {
    // Length is right, bytes are wrong — invisible to the content-length
    // check, which is exactly the gap a checksum closes.
    const corrupt = new Uint8Array(PAYLOAD);
    corrupt[corrupt.length - 1] ^= 0xff;
    const { server, url } = serve(() => new Response(corrupt));
    const dest = join(dir, "sha-bad.bin");
    try {
      expect(downloadTo(`${url}/file`, dest, { sha256: PAYLOAD_SHA })).rejects.toThrow(
        /failed checksum: sha256 [0-9a-f]{64}, expected/,
      );
    } finally {
      server.stop(true);
    }
  });

  test("no sha256 given → unchanged behaviour, body accepted", async () => {
    const { server, url } = serve(() => new Response(PAYLOAD));
    const dest = join(dir, "sha-none.bin");
    try {
      await downloadTo(`${url}/file`, dest);
      expect(existsSync(dest)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("fetchUpstreamDigest", () => {
  function redirectingServer(headers: Record<string, string>) {
    return serve((req) => {
      if (new URL(req.url).pathname === "/target") return new Response(PAYLOAD);
      return new Response("", { status: 302, headers: { location: "/target", ...headers } });
    });
  }

  test("reads the sha256 off a HuggingFace-style x-linked-etag 302", async () => {
    const { server, url } = redirectingServer({ "x-linked-etag": `"${PAYLOAD_SHA}"` });
    try {
      const digest = await fetchUpstreamDigest(`${url}/model.bin`);
      expect(digest?.sha256).toBe(PAYLOAD_SHA);
    } finally {
      server.stop(true);
    }
  });

  test("tolerates a weak-etag prefix", async () => {
    const { server, url } = redirectingServer({ "x-linked-etag": `W/"${PAYLOAD_SHA}"` });
    try {
      expect((await fetchUpstreamDigest(`${url}/model.bin`))?.sha256).toBe(PAYLOAD_SHA);
    } finally {
      server.stop(true);
    }
  });

  test("returns null for an opaque etag that is not a sha256", async () => {
    // A GitHub-release-style cache token must never be mistaken for a digest.
    const { server, url } = redirectingServer({ "x-linked-etag": '"0x8DA1B2C3D4E5F60"' });
    try {
      expect(await fetchUpstreamDigest(`${url}/model.bin`)).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("returns null when the host publishes no digest at all", async () => {
    const { server, url } = serve(() => new Response(PAYLOAD));
    try {
      expect(await fetchUpstreamDigest(`${url}/asset.tar.gz`)).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("returns null (does not throw) when the probe cannot connect", async () => {
    expect(await fetchUpstreamDigest("http://127.0.0.1:1/nope")).toBeNull();
  });
});

describe("ensureDownloaded — partial-download idempotency (vault#531)", () => {
  function digestServer() {
    return serve((req) => {
      if (new URL(req.url).pathname === "/target") return new Response(PAYLOAD);
      return new Response("", {
        status: 302,
        headers: { location: "/target", "x-linked-etag": `"${PAYLOAD_SHA}"` },
      });
    });
  }

  test("fetches when absent and reports it verified", async () => {
    const { server, url } = digestServer();
    const dest = join(dir, "ens-new.bin");
    try {
      const r = await ensureDownloaded(`${url}/model.bin`, dest);
      expect(r.outcome).toBe("downloaded");
      expect(r.verified).toBe(true);
      expect(await sha256OfFile(dest)).toBe(PAYLOAD_SHA);
    } finally {
      server.stop(true);
    }
  });

  test("reuses an intact existing file without re-downloading", async () => {
    const { server, url } = digestServer();
    const dest = join(dir, "ens-good.bin");
    try {
      await Bun.write(dest, PAYLOAD);
      const r = await ensureDownloaded(`${url}/model.bin`, dest);
      expect(r.outcome).toBe("reused");
      expect(r.verified).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("REPAIRS a corrupt file that a plain existsSync check would have skipped", async () => {
    // The bug: install skipped anything that existed. A truncated model
    // survived every non---force re-run.
    const { server, url } = digestServer();
    const dest = join(dir, "ens-corrupt.bin");
    try {
      await Bun.write(dest, PAYLOAD.slice(0, 1024)); // truncated leftover
      const r = await ensureDownloaded(`${url}/model.bin`, dest);
      expect(r.outcome).toBe("repaired");
      expect(await sha256OfFile(dest)).toBe(PAYLOAD_SHA);
    } finally {
      server.stop(true);
    }
  });

  test("force re-downloads even an intact file", async () => {
    const { server, url } = digestServer();
    const dest = join(dir, "ens-force.bin");
    try {
      await Bun.write(dest, PAYLOAD);
      const r = await ensureDownloaded(`${url}/model.bin`, dest, { force: true });
      expect(r.outcome).toBe("downloaded");
    } finally {
      server.stop(true);
    }
  });

  test("no published digest → an existing file is reused unverified, as before", async () => {
    const { server, url } = serve(() => new Response(PAYLOAD));
    const dest = join(dir, "ens-nodigest.bin");
    try {
      await Bun.write(dest, PAYLOAD.slice(0, 512));
      const r = await ensureDownloaded(`${url}/asset.tar.gz`, dest);
      expect(r.outcome).toBe("reused");
      expect(r.verified).toBe(false);
      // Unchanged: with nothing to check against we must not guess.
      expect(readFileSync(dest).byteLength).toBe(512);
    } finally {
      server.stop(true);
    }
  });
});
