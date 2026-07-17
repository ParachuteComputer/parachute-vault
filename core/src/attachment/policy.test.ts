import { describe, test, expect } from "bun:test";
import {
  BLOCKED_ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MIME_TYPES,
  sanitizeAttachmentExtension,
  mimeForAttachmentExtension,
} from "./policy.ts";

describe("sanitizeAttachmentExtension", () => {
  test("extracts a lowercased extension", () => {
    expect(sanitizeAttachmentExtension("Photo.PNG")).toBe(".png");
  });

  test("strips trailing dots/whitespace before extracting — evil.html. can't slip past the blocklist as an empty extension", () => {
    expect(sanitizeAttachmentExtension("evil.html.")).toBe(".html");
    expect(sanitizeAttachmentExtension("evil.svg ")).toBe(".svg");
  });

  test("a dotfile with no real extension reports none", () => {
    expect(sanitizeAttachmentExtension(".bashrc")).toBe("");
  });

  test("a filename with no dot reports none", () => {
    expect(sanitizeAttachmentExtension("README")).toBe("");
  });
});

describe("BLOCKED_ATTACHMENT_EXTENSIONS — active-content set", () => {
  test("blocks the same-origin-XSS extensions", () => {
    for (const ext of [".html", ".htm", ".xhtml", ".shtml", ".xht", ".svg", ".xml", ".js", ".mjs", ".cjs", ".css"]) {
      expect(BLOCKED_ATTACHMENT_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  test("does not block ordinary document/media extensions", () => {
    for (const ext of [".png", ".pdf", ".csv", ".epub", ".zip", ".mp3", ".docx"]) {
      expect(BLOCKED_ATTACHMENT_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});

describe("mimeForAttachmentExtension", () => {
  test("resolves a curated extension", () => {
    expect(mimeForAttachmentExtension(".png")).toBe("image/png");
    expect(mimeForAttachmentExtension(".pdf")).toBe("application/pdf");
  });

  test("falls back to application/octet-stream for an uncurated extension", () => {
    expect(mimeForAttachmentExtension(".azw3")).toBe("application/octet-stream");
  });

  test("no MIME entry maps to a browser-active type (INVARIANT)", () => {
    const activeTypes = new Set([
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
      "text/javascript",
      "application/wasm",
      "text/css",
    ]);
    for (const mime of Object.values(ATTACHMENT_MIME_TYPES)) {
      const bare = mime.split(";")[0]!.trim();
      expect(activeTypes.has(bare)).toBe(false);
    }
  });
});
