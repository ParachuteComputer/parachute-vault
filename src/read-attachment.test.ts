/**
 * `read-attachment` — the model-lane (Wave 2) MCP tool. Bytes DO pass
 * through this tool (unlike the ticket tools), dispatched by mime family:
 * text (byte-windowed pagination, the query-notes content_offset contract),
 * image (a real MCP image content block, 4 MiB cap), audio/video (a
 * transcript pointer, never bytes), and other binary (an honest refusal
 * pointing at a download ticket). Exercised end-to-end through the real
 * `tools/call` JSON-RPC path (`handleScopedMcp`), same harness shape as
 * `attachment-tickets.test.ts`.
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, writeFileSync } from "fs";

const testDir = join(
  tmpdir(),
  `vault-read-attachment-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.PARACHUTE_HOME = testDir;
// Deliberately NOT setting ASSETS_DIR — see attachment-tickets.test.ts's doc
// comment for why (it's process-global; each vault below gets its own
// unset-ASSETS_DIR-default assets dir, fully isolated under this file's own
// unique PARACHUTE_HOME).

const { handleScopedMcp } = await import("./mcp-http.ts");
const { writeVaultConfig, assetsDir } = await import("./config.ts");
const { getVaultStore } = await import("./vault-store.ts");
const { transcriptPathFor } = await import("./transcript-note.ts");
const { MAX_ATTACHMENT_IMAGE_BYTES } = await import("../core/src/attachment/bytes-provider.ts");
const { DEFAULT_ATTACHMENT_WINDOW_BYTES, MAX_ATTACHMENT_WINDOW_BYTES } = await import(
  "../core/src/content-range.ts"
);

function freshVault(prefix: string): string {
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  return name;
}

function auth(scopedTags: string[] | null = null) {
  return {
    permission: "full" as const,
    scopes: ["vault:read", "vault:write"],
    legacyDerived: false,
    scoped_tags: scopedTags,
  } as any;
}

/** Full `tools/call` content array — needed for the image branch's two-block shape (a plain callTool() only sees content[0]). */
async function callToolContent(
  vaultName: string,
  name: string,
  args: Record<string, unknown>,
  a = auth(),
): Promise<any[]> {
  const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleScopedMcp(req, vaultName, a);
  const body = (await res.json()) as any;
  if (body.error) {
    const err = new Error(body.error.message);
    Object.assign(err, body.error.data ?? {});
    throw err;
  }
  return body.result.content;
}

async function callTool(
  vaultName: string,
  name: string,
  args: Record<string, unknown>,
  a = auth(),
): Promise<any> {
  const content = await callToolContent(vaultName, name, args, a);
  return JSON.parse(content[0].text);
}

/** Write bytes to the vault's real on-disk assets dir and register the attachment row — mirrors what REST upload / ticket spend do, without going through either. */
async function makeAttachment(
  vaultName: string,
  relPath: string,
  bytes: Buffer,
  mimeType: string,
  opts: { noteTags?: string[]; metadata?: Record<string, unknown>; skipWrite?: boolean } = {},
): Promise<{ attachmentId: string; noteId: string }> {
  const store = getVaultStore(vaultName);
  const note = await store.createNote(`note for ${relPath}`, { tags: opts.noteTags ?? ["misc"] });
  if (!opts.skipWrite) {
    const dir = join(assetsDir(vaultName), relPath.split("/").slice(0, -1).join("/") || ".");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(assetsDir(vaultName), relPath), bytes);
  }
  const attachment = await store.addAttachment(note.id, relPath, mimeType, opts.metadata);
  return { attachmentId: attachment.id, noteId: note.id };
}

describe("read-attachment — attachment_id validation + not_found", () => {
  test("missing attachment_id → missing_required_field", async () => {
    const vaultName = freshVault("ra-missing-id");
    await expect(callTool(vaultName, "read-attachment", {})).rejects.toMatchObject({
      error_type: "missing_required_field",
      field: "attachment_id",
    });
  });

  test("unknown attachment_id → not_found", async () => {
    const vaultName = freshVault("ra-unknown-id");
    await expect(
      callTool(vaultName, "read-attachment", { attachment_id: "does-not-exist" }),
    ).rejects.toMatchObject({ error_type: "not_found", field: "attachment_id" });
  });
});

describe("read-attachment — text family (D2)", () => {
  test("plain text, no range params → default 64 KiB window, content_next_offset present when there's more", async () => {
    const vaultName = freshVault("ra-text-default");
    const content = "x".repeat(DEFAULT_ATTACHMENT_WINDOW_BYTES + 500);
    const { attachmentId } = await makeAttachment(vaultName, "d/note.txt", Buffer.from(content, "utf8"), "text/plain; charset=utf-8");

    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId });
    expect(result.mime_type).toBe("text/plain; charset=utf-8");
    expect(Buffer.byteLength(result.content, "utf8")).toBe(DEFAULT_ATTACHMENT_WINDOW_BYTES);
    expect(result.content_offset).toBe(0);
    expect(result.content_total_length).toBe(content.length);
    expect(result.content_next_offset).toBe(DEFAULT_ATTACHMENT_WINDOW_BYTES);
  });

  test("a small file fits in one call → content_next_offset null", async () => {
    const vaultName = freshVault("ra-text-small");
    const { attachmentId } = await makeAttachment(vaultName, "d/small.txt", Buffer.from("hello world", "utf8"), "text/plain; charset=utf-8");
    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId });
    expect(result.content).toBe("hello world");
    expect(result.content_next_offset).toBeNull();
    expect(result.content_total_length).toBe(11);
  });

  test("explicit content_offset/content_length page a window mid-file", async () => {
    const vaultName = freshVault("ra-text-window");
    const { attachmentId } = await makeAttachment(vaultName, "d/abc.txt", Buffer.from("abcdefghij", "utf8"), "text/plain; charset=utf-8");
    const result = await callTool(vaultName, "read-attachment", {
      attachment_id: attachmentId,
      content_offset: 3,
      content_length: 4,
    });
    expect(result.content).toBe("defg");
    expect(result.content_offset).toBe(3);
    expect(result.content_next_offset).toBe(7);
  });

  test("content_length above the 256 KiB max → invalid_query", async () => {
    const vaultName = freshVault("ra-text-toobig");
    const { attachmentId } = await makeAttachment(vaultName, "d/x.txt", Buffer.from("hi", "utf8"), "text/plain; charset=utf-8");
    await expect(
      callTool(vaultName, "read-attachment", { attachment_id: attachmentId, content_length: MAX_ATTACHMENT_WINDOW_BYTES + 1 }),
    ).rejects.toMatchObject({ error_type: "invalid_query" });
  });

  test("content_length below the minimum (4 bytes) → invalid_query", async () => {
    const vaultName = freshVault("ra-text-toosmall");
    const { attachmentId } = await makeAttachment(vaultName, "d/x.txt", Buffer.from("hi", "utf8"), "text/plain; charset=utf-8");
    await expect(
      callTool(vaultName, "read-attachment", { attachment_id: attachmentId, content_length: 1 }),
    ).rejects.toMatchObject({ error_type: "invalid_query" });
  });

  test("JSON (extension-curated) is treated as text", async () => {
    const vaultName = freshVault("ra-text-json");
    const { attachmentId } = await makeAttachment(vaultName, "d/data.json", Buffer.from('{"a":1}', "utf8"), "application/json; charset=utf-8");
    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId });
    expect(result.content).toBe('{"a":1}');
  });

  test("application/x-ndjson (TEXT_MIME_ALLOWLIST, no curated extension) is treated as text", async () => {
    const vaultName = freshVault("ra-text-ndjson");
    // .ndjson has no ATTACHMENT_MIME_TYPES entry, so effectiveAttachmentMime
    // falls through to the row's own mimeType — exercising the allowlist
    // path specifically, not the extension-curation path.
    const { attachmentId } = await makeAttachment(
      vaultName,
      "d/log.ndjson",
      Buffer.from('{"a":1}\n{"b":2}\n', "utf8"),
      "application/x-ndjson",
    );
    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId });
    expect(result.mime_type).toBe("application/x-ndjson");
    expect(result.content).toBe('{"a":1}\n{"b":2}\n');
  });

  test("range paging round-trip on a >256 KiB file with multi-byte UTF-8 reassembles byte-identical content", async () => {
    const vaultName = freshVault("ra-text-bigroundtrip");
    // Deterministic mixed-width content: ASCII + a repeating multi-byte
    // sequence, long enough that MAX_ATTACHMENT_WINDOW_BYTES pages don't
    // divide it evenly (forces a short final page) and multiple full-cap
    // pages are needed.
    const unit = "The quick brown fox jumps over the lazy dog. 你好世界 😀 café. ";
    let content = "";
    while (Buffer.byteLength(content, "utf8") < 300_000) content += unit;
    const totalBytes = Buffer.byteLength(content, "utf8");
    expect(totalBytes).toBeGreaterThan(256 * 1024);

    const { attachmentId } = await makeAttachment(vaultName, "d/big.txt", Buffer.from(content, "utf8"), "text/plain; charset=utf-8");

    let offset: number | null = 0;
    let assembled = "";
    let calls = 0;
    while (offset !== null) {
      const result = await callTool(vaultName, "read-attachment", {
        attachment_id: attachmentId,
        content_offset: offset,
        content_length: MAX_ATTACHMENT_WINDOW_BYTES, // deliberate big bites — exercises the 256 KiB max
      });
      expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_ATTACHMENT_WINDOW_BYTES);
      expect(result.content_total_length).toBe(totalBytes);
      assembled += result.content;
      offset = result.content_next_offset;
      calls++;
      expect(calls).toBeLessThan(10); // sanity bound — must make progress
    }
    expect(assembled).toBe(content);
    expect(calls).toBeGreaterThan(1); // actually exercised pagination, not a single call
  });

  test("attachment_binary_missing when the row exists but the file was never written", async () => {
    const vaultName = freshVault("ra-text-missing-binary");
    const { attachmentId } = await makeAttachment(vaultName, "d/gone.txt", Buffer.from("x"), "text/plain; charset=utf-8", {
      skipWrite: true,
    });
    await expect(callTool(vaultName, "read-attachment", { attachment_id: attachmentId })).rejects.toMatchObject({
      error_type: "attachment_binary_missing",
    });
  });
});

describe("read-attachment — image family (D3)", () => {
  test("a small image returns a real MCP image content block alongside the row-JSON text block", async () => {
    const vaultName = freshVault("ra-image-small");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const { attachmentId } = await makeAttachment(vaultName, "d/pic.png", bytes, "image/png");

    const content = await callToolContent(vaultName, "read-attachment", { attachment_id: attachmentId });
    expect(content.length).toBe(2);
    expect(content[0].type).toBe("text");
    const rowJson = JSON.parse(content[0].text);
    expect(rowJson.attachment_id).toBe(attachmentId);
    expect(rowJson.mime_type).toBe("image/png");
    expect(rowJson.size_bytes).toBe(bytes.length);
    // The base64 payload must NOT be duplicated into the text block.
    expect(rowJson._mcpImage).toBeUndefined();
    expect(rowJson.data).toBeUndefined();

    expect(content[1].type).toBe("image");
    expect(content[1].mimeType).toBe("image/png");
    expect(Buffer.from(content[1].data, "base64").equals(bytes)).toBe(true);
  });

  test("an image over the 4 MiB cap refuses with image_too_large (size, max_bytes, how_to) — never reads the bytes", async () => {
    const vaultName = freshVault("ra-image-toobig");
    const bytes = Buffer.alloc(MAX_ATTACHMENT_IMAGE_BYTES + 1);
    const { attachmentId } = await makeAttachment(vaultName, "d/huge.png", bytes, "image/png");

    await expect(callTool(vaultName, "read-attachment", { attachment_id: attachmentId })).rejects.toMatchObject({
      error_type: "image_too_large",
      size: MAX_ATTACHMENT_IMAGE_BYTES + 1,
      max_bytes: MAX_ATTACHMENT_IMAGE_BYTES,
    });
  });

  test("an image exactly at the 4 MiB cap succeeds", async () => {
    const vaultName = freshVault("ra-image-atcap");
    const bytes = Buffer.alloc(MAX_ATTACHMENT_IMAGE_BYTES, 7);
    const { attachmentId } = await makeAttachment(vaultName, "d/exact.png", bytes, "image/png");
    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId });
    expect(result.size_bytes).toBe(MAX_ATTACHMENT_IMAGE_BYTES);
  });

  test("range params on an image → invalid_query (images don't page)", async () => {
    const vaultName = freshVault("ra-image-range");
    const { attachmentId } = await makeAttachment(vaultName, "d/pic.png", Buffer.from([1, 2, 3]), "image/png");
    await expect(
      callTool(vaultName, "read-attachment", { attachment_id: attachmentId, content_offset: 0 }),
    ).rejects.toMatchObject({ error_type: "invalid_query" });
  });

  test("attachment_binary_missing for an image row whose bytes were never written", async () => {
    const vaultName = freshVault("ra-image-missing");
    const { attachmentId } = await makeAttachment(vaultName, "d/ghost.png", Buffer.from([1]), "image/png", {
      skipWrite: true,
    });
    await expect(callTool(vaultName, "read-attachment", { attachment_id: attachmentId })).rejects.toMatchObject({
      error_type: "attachment_binary_missing",
    });
  });
});

describe("read-attachment — audio/video family (D4): never bytes", () => {
  test("no transcribe_status at all → audio_bytes_not_supported", async () => {
    const vaultName = freshVault("ra-audio-none");
    const { attachmentId } = await makeAttachment(vaultName, "d/voice.m4a", Buffer.from([1, 2, 3]), "audio/mp4");
    await expect(callTool(vaultName, "read-attachment", { attachment_id: attachmentId })).rejects.toMatchObject({
      error_type: "audio_bytes_not_supported",
    });
  });

  test("transcribe_status: pending → returns the pointer, not an error", async () => {
    const vaultName = freshVault("ra-audio-pending");
    const { attachmentId, noteId } = await makeAttachment(vaultName, "d/voice.m4a", Buffer.from([1, 2, 3]), "audio/mp4", {
      metadata: { transcribe_status: "pending" },
    });
    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId });
    expect(result.transcribe_status).toBe("pending");
    expect(result.note_id).toBe(noteId);
    expect(result.transcript_note).toBeUndefined();
  });

  test("transcribe_status: failed → returns the pointer with failed status, not an error", async () => {
    const vaultName = freshVault("ra-audio-failed");
    const { attachmentId, noteId } = await makeAttachment(vaultName, "d/voice.m4a", Buffer.from([1, 2, 3]), "audio/mp4", {
      metadata: { transcribe_status: "failed" },
    });
    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId });
    expect(result.transcribe_status).toBe("failed");
    expect(result.note_id).toBe(noteId);
  });

  test("transcribe_status: done + a resolvable sibling transcript note → transcript_note {id, path}", async () => {
    const vaultName = freshVault("ra-audio-done");
    const relPath = "d/voice.m4a";
    const { attachmentId, noteId } = await makeAttachment(vaultName, relPath, Buffer.from([1, 2, 3]), "audio/mp4", {
      metadata: { transcribe_status: "done" },
    });
    const store = getVaultStore(vaultName);
    const transcriptNote = await store.createNote("the transcript text", {
      path: transcriptPathFor(relPath),
      tags: ["transcript"],
    });

    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId });
    expect(result.transcribe_status).toBe("done");
    expect(result.note_id).toBe(noteId);
    expect(result.transcript_note).toEqual({ id: transcriptNote.id, path: transcriptNote.path });
    // Never the raw transcript bytes/text.
    expect(result.content).toBeUndefined();
    expect(result.transcript).toBeUndefined();
  });

  test("transcribe_status: done but NO sibling note resolves → note_id pointer only, no transcript_note key", async () => {
    const vaultName = freshVault("ra-audio-done-nosibling");
    const { attachmentId, noteId } = await makeAttachment(vaultName, "d/voice.m4a", Buffer.from([1, 2, 3]), "audio/mp4", {
      metadata: { transcribe_status: "done" },
    });
    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId });
    expect(result.transcribe_status).toBe("done");
    expect(result.note_id).toBe(noteId);
    expect(result.transcript_note).toBeUndefined();
  });

  test("video mime is treated the same as audio (never bytes)", async () => {
    const vaultName = freshVault("ra-video-none");
    const { attachmentId } = await makeAttachment(vaultName, "d/clip.mp4", Buffer.from([1, 2, 3]), "video/mp4");
    await expect(callTool(vaultName, "read-attachment", { attachment_id: attachmentId })).rejects.toMatchObject({
      error_type: "audio_bytes_not_supported",
    });
  });
});

describe("read-attachment — other binary (D5): unsupported_attachment_type", () => {
  test("PDF refuses with mime_type, size, how_to — pointing at a download ticket", async () => {
    const vaultName = freshVault("ra-pdf");
    const bytes = Buffer.from("%PDF-1.4 fake", "utf8");
    const { attachmentId } = await makeAttachment(vaultName, "d/doc.pdf", bytes, "application/pdf");
    await expect(callTool(vaultName, "read-attachment", { attachment_id: attachmentId })).rejects.toMatchObject({
      error_type: "unsupported_attachment_type",
      mime_type: "application/pdf",
      size: bytes.length,
    });
  });

  test("a zip (arbitrary binary) also refuses as unsupported_attachment_type", async () => {
    const vaultName = freshVault("ra-zip");
    const { attachmentId } = await makeAttachment(vaultName, "d/archive.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04]), "application/zip");
    await expect(callTool(vaultName, "read-attachment", { attachment_id: attachmentId })).rejects.toMatchObject({
      error_type: "unsupported_attachment_type",
    });
  });

  test("a PDF row whose bytes are gone reports attachment_binary_missing, not unsupported_attachment_type", async () => {
    const vaultName = freshVault("ra-pdf-missing");
    const { attachmentId } = await makeAttachment(vaultName, "d/gone.pdf", Buffer.from("x"), "application/pdf", {
      skipWrite: true,
    });
    await expect(callTool(vaultName, "read-attachment", { attachment_id: attachmentId })).rejects.toMatchObject({
      error_type: "attachment_binary_missing",
    });
  });
});

describe("read-attachment — tag-scope refusal", () => {
  test("a tag-scoped session can't read an out-of-scope note's attachment (uniform not_found, no oracle)", async () => {
    const vaultName = freshVault("ra-scope-out");
    const { attachmentId } = await makeAttachment(vaultName, "d/secret.txt", Buffer.from("shh", "utf8"), "text/plain; charset=utf-8", {
      noteTags: ["health"],
    });
    await expect(
      callTool(vaultName, "read-attachment", { attachment_id: attachmentId }, auth(["work"])),
    ).rejects.toMatchObject({ error_type: "not_found", field: "attachment_id" });
  });

  test("a tag-scoped session CAN read an in-scope note's attachment", async () => {
    const vaultName = freshVault("ra-scope-in");
    const { attachmentId } = await makeAttachment(vaultName, "d/visible.txt", Buffer.from("hi", "utf8"), "text/plain; charset=utf-8", {
      noteTags: ["work"],
    });
    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId }, auth(["work"]));
    expect(result.content).toBe("hi");
  });
});

describe("read-attachment — discoverability + tool tiering", () => {
  test("read-attachment is read-tier: a vault:read-only session can call it", async () => {
    const vaultName = freshVault("ra-tier");
    const { attachmentId } = await makeAttachment(vaultName, "d/x.txt", Buffer.from("ok", "utf8"), "text/plain; charset=utf-8");
    const readOnlyAuth = {
      permission: "read" as const,
      scopes: ["vault:read"],
      legacyDerived: false,
      scoped_tags: null,
    } as any;
    const result = await callTool(vaultName, "read-attachment", { attachment_id: attachmentId }, readOnlyAuth);
    expect(result.content).toBe("ok");
  });
});
