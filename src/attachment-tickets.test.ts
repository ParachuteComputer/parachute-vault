/**
 * Attachment tickets — end-to-end lifecycle (mint via the real MCP tool
 * call path, spend via the real unauthenticated `/vault/<name>/tickets/<id>`
 * route dispatched through `routing.ts`'s `route()`). Covers the Wave 1
 * security posture: single-use, TTL/expiry, size-cap, wrong-vault scoping,
 * uniform 404, upload→row+transcribe, download streaming + path
 * confinement, and the connect-time instructions block.
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(
  tmpdir(),
  `vault-attachment-tickets-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.PARACHUTE_HOME = testDir;
// Deliberately NOT setting ASSETS_DIR (unlike storage.test.ts, which wants a
// single shared assets root for its own reasons): that env var is global to
// the whole `bun test` process (all files share one Node process), so
// setting it here would leak into every OTHER test file's assetsDir() calls
// too. Each vault below gets a unique, unset-ASSETS_DIR-default assets dir
// (`vaultDir(name)/assets`) scoped under this file's own unique
// PARACHUTE_HOME — fully isolated without needing the override.

const { route } = await import("./routing.ts");
const { handleScopedMcp } = await import("./mcp-http.ts");
const { getServerInstruction } = await import("./mcp-tools.ts");
const { writeVaultConfig } = await import("./config.ts");
const { getVaultStore } = await import("./vault-store.ts");
const { getSharedAttachmentTicketProvider } = await import("./attachment-tickets.ts");
const { attachmentsInstructionBlock } = await import("../core/src/vault-projection.ts");

/** `route()` takes the pathname as a separate arg (server.ts derives it from `req.url`) — this wrapper matches that call shape everywhere below. */
async function routeReq(req: Request): Promise<Response> {
  return route(req, new URL(req.url).pathname);
}

function freshVault(prefix: string): string {
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  return name;
}

/** Bypasses `authenticateVaultRequest` the same way vault.test.ts's scope-tier tests do — a fabricated already-resolved auth object. */
function mcpAuth(scopes: string[]) {
  return {
    permission: scopes.includes("vault:write") || scopes.includes("vault:admin") ? "full" : "read",
    scopes,
    legacyDerived: false,
    scoped_tags: null,
  } as any;
}

async function callTool(vaultName: string, name: string, args: Record<string, unknown>): Promise<any> {
  const req = new Request(`http://localhost:1940/vault/${vaultName}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleScopedMcp(req, vaultName, mcpAuth(["vault:read", "vault:write"]));
  const body = (await res.json()) as any;
  if (body.error) {
    const err = new Error(body.error.message);
    Object.assign(err, body.error.data ?? {});
    throw err;
  }
  return JSON.parse(body.result.content[0].text);
}

describe("attachment tickets — upload lifecycle", () => {
  test("mint → spend → row registered with size + original_name; second spend of the same ticket 404s", async () => {
    const vaultName = freshVault("tickets-upload");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# Target\n", { path: "target" });

    const mint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "photo.png",
      size_bytes: 5,
      mime_type: "image/png",
    });
    expect(mint.method).toBe("PUT");
    expect(mint.url).toContain(`/vault/${vaultName}/tickets/`);
    expect(mint.max_bytes).toBe(5);

    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const spendRes = await routeReq(
      new Request(mint.url, { method: "PUT", headers: { "content-type": "image/png" }, body: bytes }),
    );
    expect(spendRes.status).toBe(201);
    const attachment = (await spendRes.json()) as any;
    expect(attachment.noteId).toBe(note.id);
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.metadata.original_name).toBe("photo.png");
    expect(attachment.metadata.size).toBe(5);

    const rows = await store.getAttachments(note.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(attachment.id);

    // Single-use: the ticket is gone after one spend — uniform 404, no
    // oracle distinguishing "spent" from "never existed".
    const secondRes = await routeReq(
      new Request(mint.url, { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array([9]) }),
    );
    expect(secondRes.status).toBe(404);
    const secondBody = (await secondRes.json()) as any;
    expect(secondBody.error_type).toBe("not_found");
    expect(typeof secondBody.how_to).toBe("string");

    // A second upload wasn't registered.
    expect((await store.getAttachments(note.id)).length).toBe(1);
  });

  test("POST also spends an upload ticket (accepted alongside the advertised PUT)", async () => {
    const vaultName = freshVault("tickets-upload-post");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# T\n", { path: "t" });
    const mint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "a.txt",
      size_bytes: 3,
    });
    const res = await routeReq(
      new Request(mint.url, { method: "POST", headers: { "content-type": "text/plain" }, body: new Uint8Array([1, 2, 3]) }),
    );
    expect(res.status).toBe(201);
  });

  test("size-cap: an upload exceeding the ticket's declared size_bytes is rejected 413 and no row is created", async () => {
    const vaultName = freshVault("tickets-size-cap");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# T\n", { path: "t" });
    const mint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "small.bin",
      size_bytes: 3,
    });
    const res = await routeReq(
      new Request(mint.url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.error_type).toBe("file_too_large");
    expect(body.limit).toBe(3);
    expect(typeof body.how_to).toBe("string");
    expect((await store.getAttachments(note.id)).length).toBe(0);
  });

  test("a mismatched Content-Length header alone is rejected 413 before the body is even read", async () => {
    const vaultName = freshVault("tickets-cl-cap");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# T\n", { path: "t" });
    const mint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "small.bin",
      size_bytes: 3,
    });
    const res = await routeReq(
      new Request(mint.url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": "1000000" },
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(res.status).toBe(413);
  });

  test("expiry: a ticket past its expires_at is rejected 404 even though it was never spent", async () => {
    const vaultName = freshVault("tickets-expiry");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# T\n", { path: "t" });

    const provider = getSharedAttachmentTicketProvider();
    const id = "e".repeat(64);
    await provider.put({
      id,
      kind: "upload",
      vaultName,
      createdAt: Date.now() - 1000,
      expiresAt: Date.now() - 1, // already expired
      noteId: note.id,
      filename: "late.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 10,
    });

    const res = await routeReq(
      new Request(`http://localhost:1940/vault/${vaultName}/tickets/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1]),
      }),
    );
    expect(res.status).toBe(404);
    expect((await store.getAttachments(note.id)).length).toBe(0);
  });

  test("wrong-vault scope: a ticket minted for vault A can't be spent against vault B's URL", async () => {
    const vaultA = freshVault("tickets-vault-a");
    const vaultB = freshVault("tickets-vault-b");
    const storeA = getVaultStore(vaultA);
    const note = await storeA.createNote("# T\n", { path: "t" });

    const mint = await callTool(vaultA, "request-attachment-upload", {
      note: note.id,
      filename: "a.bin",
      size_bytes: 3,
    });
    const ticketId = mint.url.split("/tickets/")[1] as string;

    const crossVaultRes = await routeReq(
      new Request(`http://localhost:1940/vault/${vaultB}/tickets/${ticketId}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(crossVaultRes.status).toBe(404);

    // `take()` deletes on lookup regardless of which vault asked — a
    // wrong-vault spend attempt still burns the ticket (single-use is
    // enforced by the delete, vault-match is a SEPARATE check layered on
    // top). Documenting this: the ticket is gone even for the correct
    // vault after the cross-vault probe above.
    const correctRes = await routeReq(
      new Request(mint.url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(correctRes.status).toBe(404);
  });

  test("transcribe: true rides through to the attachment row and stamps the note's transcribe_stub", async () => {
    const vaultName = freshVault("tickets-transcribe");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# Voice memo\n", { path: "memo" });

    const mint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "memo.wav",
      size_bytes: 4,
      transcribe: true,
    });
    const res = await routeReq(
      new Request(mint.url, { method: "PUT", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1, 2, 3, 4]) }),
    );
    expect(res.status).toBe(201);
    const attachment = (await res.json()) as any;
    expect(attachment.metadata.transcribe_status).toBe("pending");
    expect(attachment.metadata.transcribe_origin).toBe("legacy");

    const updatedNote = await store.getNote(note.id);
    expect((updatedNote!.metadata as any)?.transcribe_stub).toBe(true);
  });

  test("blocked extension is refused at MINT — no ticket is ever created", async () => {
    const vaultName = freshVault("tickets-blocked-ext");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# T\n", { path: "t" });
    await expect(
      callTool(vaultName, "request-attachment-upload", { note: note.id, filename: "evil.svg", size_bytes: 10 }),
    ).rejects.toThrow();
  });
});

describe("attachment tickets — download lifecycle", () => {
  test("mint → spend streams the exact bytes with the attachment's content-type", async () => {
    const vaultName = freshVault("tickets-download");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# T\n", { path: "t" });

    const uploadMint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "data.bin",
      size_bytes: 4,
      mime_type: "application/octet-stream",
    });
    const uploadRes = await routeReq(
      new Request(uploadMint.url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([10, 20, 30, 40]),
      }),
    );
    const attachment = (await uploadRes.json()) as any;

    const downloadMint = await callTool(vaultName, "request-attachment-download", {
      attachment_id: attachment.id,
    });
    expect(downloadMint.method).toBe("GET");
    expect(downloadMint.mime_type).toBe("application/octet-stream");

    const downloadRes = await routeReq(new Request(downloadMint.url, { method: "GET" }));
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(downloadRes.headers.get("x-content-type-options")).toBe("nosniff");
    const body = new Uint8Array(await downloadRes.arrayBuffer());
    expect(Array.from(body)).toEqual([10, 20, 30, 40]);

    // Single-use on the download side too.
    const secondRes = await routeReq(new Request(downloadMint.url, { method: "GET" }));
    expect(secondRes.status).toBe(404);
  });

  test("path confinement: an attachment row pointing outside assetsDir can't be walked to via a download ticket", async () => {
    const vaultName = freshVault("tickets-confinement");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# T\n", { path: "t" });
    // A row with a traversal path could only arrive via a bug elsewhere
    // (tickets themselves never accept a caller-supplied path) — this pins
    // the download spend route's OWN confinement guard as defense-in-depth.
    const attachment = await store.addAttachment(note.id, "../../../../etc/passwd", "text/plain");

    const downloadMint = await callTool(vaultName, "request-attachment-download", {
      attachment_id: attachment.id,
    });
    const res = await routeReq(new Request(downloadMint.url, { method: "GET" }));
    expect(res.status).toBe(404);
  });
});

describe("attachment tickets — discoverability", () => {
  test("attachmentsInstructionBlock teaches the ticket tools when enabled, and omits them when not", () => {
    const enabled = attachmentsInstructionBlock({ ticketsEnabled: true });
    expect(enabled).toContain("request-attachment-upload");
    expect(enabled).toContain("request-attachment-download");
    expect(enabled).toContain("curl_example");

    const disabled = attachmentsInstructionBlock({ ticketsEnabled: false });
    expect(disabled).not.toContain("request-attachment-upload");
    // The REST fallback recipe is always present, wired or not.
    expect(disabled).toContain("/storage/upload");
  });

  test("bun's connect-time getServerInstruction includes the Attachments section and teaches the ticket tools", async () => {
    const vaultName = freshVault("tickets-instructions");
    const md = await getServerInstruction(vaultName);
    expect(md).toContain("## Attachments");
    expect(md).toContain("request-attachment-upload");
  });
});
