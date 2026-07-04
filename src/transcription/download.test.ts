import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { downloadTo } from "./download.ts";

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
        expect(String(err)).toMatch(/failed after \d+ bytes|truncated/);
      }
      expect(threw).toBe(true);
      // The half-written file must not survive to be mistaken for a good artifact.
      expect(existsSync(dest)).toBe(false);
    } finally {
      listener.stop(true);
    }
  });
});
