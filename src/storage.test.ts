/**
 * Storage upload allowlist tests (issue #127).
 *
 * The allowlist guards `POST /api/storage/upload` against turning user
 * uploads into XSS vectors when the asset is later served back from
 * `/storage/`. We pin both the accepted set and the deliberate exclusions
 * so a future widening doesn't quietly let SVG/HTML in.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(
  tmpdir(),
  `vault-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.PARACHUTE_HOME = testDir;
process.env.ASSETS_DIR = join(testDir, "assets");

const { handleStorage } = await import("./routes.ts");

function uploadRequest(filename: string, mimeType: string): Request {
  const form = new FormData();
  const file = new File([new Uint8Array([0x00, 0x01, 0x02])], filename, {
    type: mimeType,
  });
  form.set("file", file);
  return new Request("http://localhost:1940/storage/upload", {
    method: "POST",
    body: form,
  });
}

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "assets"), { recursive: true });
});

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("storage upload allowlist", () => {
  test("accepts .pdf — knowledge-vault content (#127)", async () => {
    const res = await handleStorage(uploadRequest("paper.pdf", "application/pdf"), "/upload", "default");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mimeType: string; path: string };
    expect(body.mimeType).toBe("application/pdf");
    expect(body.path).toMatch(/\.pdf$/);
  });

  test("accepts .mp4 — mobile capture default (#127)", async () => {
    const res = await handleStorage(uploadRequest("clip.mp4", "video/mp4"), "/upload", "default");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mimeType: string };
    expect(body.mimeType).toBe("video/mp4");
  });

  test("still accepts the existing audio + image set", async () => {
    for (const [name, mime] of [
      ["clip.wav", "audio/wav"],
      ["clip.mp3", "audio/mpeg"],
      ["photo.png", "image/png"],
      ["photo.jpg", "image/jpeg"],
      ["clip.webm", "audio/webm"],
    ] as const) {
      const res = await handleStorage(uploadRequest(name, mime), "/upload", "default");
      expect(res.status).toBe(201);
    }
  });

  test("rejects .svg — XSS vector via inline <script> (#127)", async () => {
    const res = await handleStorage(uploadRequest("evil.svg", "image/svg+xml"), "/upload", "default");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(".svg");
  });

  test("rejects .html — same XSS surface as SVG (#127)", async () => {
    const res = await handleStorage(uploadRequest("evil.html", "text/html"), "/upload", "default");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(".html");
  });

  test("rejects unknown extensions (default-deny)", async () => {
    const res = await handleStorage(uploadRequest("payload.exe", "application/octet-stream"), "/upload", "default");
    expect(res.status).toBe(400);
  });
});
