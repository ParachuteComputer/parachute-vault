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
const {
  getSharedAttachmentTicketProvider,
  InProcessAttachmentTicketProvider,
  sweepExpiredAttachmentTickets,
  startAttachmentTicketSweep,
  stopAttachmentTicketSweep,
} = await import("./attachment-tickets.ts");
const { generateTicketId } = await import("../core/src/attachment/tickets.ts");
import type { AttachmentTicket } from "../core/src/attachment/tickets.ts";
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

  // vault#643 — the fresh-install case. Auto-transcribe is ON by default and
  // no provider is reachable (SCRIBE_URL unset, no scribe row), which is
  // exactly what a new box looks like. The upload must not come back looking
  // like an ordinary file: it carries a `failed` status and an actionable
  // reason, so the state is visible in the API and the admin SPA.
  test("audio + auto-transcribe on + NO provider → attachment records the failure, not silence", async () => {
    const vaultName = freshVault("tickets-no-provider");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# Voice memo\n", { path: "memo-noprov" });

    const mint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "memo.webm",
      size_bytes: 4,
      // NO `transcribe: true` — this is the AUTO path, the one that used to
      // silently do nothing.
    });
    const res = await routeReq(
      new Request(mint.url, {
        method: "PUT",
        headers: { "content-type": "audio/webm" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    expect(res.status).toBe(201);
    const attachment = (await res.json()) as any;
    expect(attachment.metadata.transcribe_status).toBe("failed");
    expect(attachment.metadata.transcribe_error).toMatch(/no transcription provider configured/i);
    // The reason has to be actionable — naming both routes out of it.
    expect(attachment.metadata.transcribe_error).toMatch(/TRANSCRIPTION_PROVIDER/);
    expect(attachment.metadata.transcribe_error).toMatch(/SCRIBE_URL/);
    expect(attachment.metadata.transcribe_origin).toBe("auto");
  });

  // The counter-case: turning auto-transcribe OFF must stay silent. The
  // operator asked for nothing to happen, so nothing happening is correct and
  // must not be dressed up as a failure.
  test("audio + auto-transcribe explicitly OFF → no transcribe metadata at all", async () => {
    const vaultName = freshVault("tickets-transcribe-off");
    const store = getVaultStore(vaultName);
    writeVaultConfig({
      name: vaultName,
      api_keys: [],
      created_at: new Date().toISOString(),
      auto_transcribe: { enabled: false },
    } as never);
    const note = await store.createNote("# Voice memo\n", { path: "memo-off" });

    const mint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "memo.webm",
      size_bytes: 4,
    });
    const res = await routeReq(
      new Request(mint.url, {
        method: "PUT",
        headers: { "content-type": "audio/webm" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    expect(res.status).toBe(201);
    const attachment = (await res.json()) as any;
    expect(attachment.metadata.transcribe_status).toBeUndefined();
    expect(attachment.metadata.transcribe_error).toBeUndefined();
  });

  test("segment_index (voice W2): a valid integer >= 0 rides ticket mint through to the attachment row", async () => {
    const vaultName = freshVault("tickets-segment");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# Voice memo\n\n_Transcript pending (part 2)._", { path: "memo-seg" });

    const mint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "part-2.wav",
      size_bytes: 4,
      transcribe: true,
      segment_index: 1,
    });
    const res = await routeReq(
      new Request(mint.url, { method: "PUT", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1, 2, 3, 4]) }),
    );
    expect(res.status).toBe(201);
    const attachment = (await res.json()) as any;
    expect(attachment.metadata.segment_index).toBe(1);
    expect(attachment.metadata.transcribe_status).toBe("pending");
  });

  test.each([
    ["negative", -1],
    ["non-integer", 1.5],
    ["string", "1"],
  ])("segment_index (voice W2): an invalid value (%s) is dropped at mint, not stored — same fallback as the REST path", async (_label, bad) => {
    const vaultName = freshVault(`tickets-segment-bad-${_label}`);
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# Voice memo\n\n_Transcript pending._", { path: "memo-seg-bad" });

    const mint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "bad.wav",
      size_bytes: 4,
      transcribe: true,
      segment_index: bad,
    });
    const res = await routeReq(
      new Request(mint.url, { method: "PUT", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1, 2, 3, 4]) }),
    );
    expect(res.status).toBe(201);
    const attachment = (await res.json()) as any;
    expect(attachment.metadata.segment_index).toBeUndefined();
    expect(attachment.metadata.transcribe_status).toBe("pending");
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

  test("spend Content-Type is extension-derived, not the caller-asserted row mime (vault#617)", async () => {
    const vaultName = freshVault("tickets-download-mime");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# T\n", { path: "t" });

    const uploadMint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "photo.png",
      size_bytes: 4,
      mime_type: "text/html",
    });
    const uploadRes = await routeReq(
      new Request(uploadMint.url, {
        method: "PUT",
        headers: { "content-type": "text/html" },
        body: new Uint8Array([137, 80, 78, 71]),
      }),
    );
    const attachment = (await uploadRes.json()) as any;
    expect(attachment.mimeType).toBe("text/html");

    const downloadMint = await callTool(vaultName, "request-attachment-download", {
      attachment_id: attachment.id,
    });
    const downloadRes = await routeReq(new Request(downloadMint.url, { method: "GET" }));
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("image/png");
    expect(downloadRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(downloadMint.mime_type).toBe("image/png");
  });

  test("uncurated extension with caller-asserted text/html serves octet-stream (vault#617)", async () => {
    const vaultName = freshVault("tickets-download-octet");
    const store = getVaultStore(vaultName);
    const note = await store.createNote("# T\n", { path: "t" });

    const uploadMint = await callTool(vaultName, "request-attachment-upload", {
      note: note.id,
      filename: "payload.bin",
      size_bytes: 4,
      mime_type: "text/html",
    });
    const uploadRes = await routeReq(
      new Request(uploadMint.url, {
        method: "PUT",
        headers: { "content-type": "text/html" },
        body: new Uint8Array([10, 20, 30, 40]),
      }),
    );
    expect(uploadRes.status).toBe(201);
    const attachment = (await uploadRes.json()) as any;

    const downloadMint = await callTool(vaultName, "request-attachment-download", {
      attachment_id: attachment.id,
    });
    const downloadRes = await routeReq(new Request(downloadMint.url, { method: "GET" }));
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(downloadRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(downloadMint.mime_type).toBe("application/octet-stream");
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

  test("attachmentsInstructionBlock teaches read-attachment when readEnabled, and omits it when not", () => {
    const enabled = attachmentsInstructionBlock({ ticketsEnabled: true, readEnabled: true });
    expect(enabled).toContain("read-attachment");

    const disabled = attachmentsInstructionBlock({ ticketsEnabled: true, readEnabled: false });
    expect(disabled).not.toContain("read-attachment");
  });

  test("bun's connect-time getServerInstruction teaches read-attachment too", async () => {
    const vaultName = freshVault("tickets-instructions-read");
    const md = await getServerInstruction(vaultName);
    expect(md).toContain("read-attachment");
  });
});

describe("attachment ticket sweep (vault#612)", () => {
  // Isolated instance — no risk of touching the one process-wide provider
  // every OTHER test in this file (and every other test FILE, via
  // getSharedAttachmentTicketProvider) also shares.
  function ticketExpiringAt(id: string, expiresAt: number): AttachmentTicket {
    return {
      id,
      kind: "download",
      vaultName: "sweep-unit-test",
      createdAt: expiresAt - 60_000,
      expiresAt,
      attachmentId: "att-1",
    };
  }

  test("sweepExpired drops only expired-unspent tickets and returns the count dropped", async () => {
    const provider = new InProcessAttachmentTicketProvider();
    const now = Date.now();
    await provider.put(ticketExpiringAt("expired-1", now - 5000));
    await provider.put(ticketExpiringAt("expired-2", now - 1));
    await provider.put(ticketExpiringAt("fresh-1", now + 60_000));
    expect(provider.size()).toBe(3);

    const dropped = provider.sweepExpired(now);
    expect(dropped).toBe(2);
    expect(provider.size()).toBe(1);

    // Dropped tickets are gone — take() returns null, same as "never existed".
    expect(await provider.take("expired-1")).toBeNull();
    expect(await provider.take("expired-2")).toBeNull();
    // The unexpired ticket survived the sweep and is still spendable.
    const fresh = await provider.take("fresh-1");
    expect(fresh?.id).toBe("fresh-1");
  });

  test("a ticket expiring exactly `now` counts as expired (< comparison, not <=)", async () => {
    const provider = new InProcessAttachmentTicketProvider();
    const now = Date.now();
    await provider.put(ticketExpiringAt("boundary", now));
    expect(provider.sweepExpired(now)).toBe(0); // expiresAt === now is NOT yet expired
    expect(provider.sweepExpired(now + 1)).toBe(1); // one ms later, it is
  });

  test("a no-op sweep (nothing expired) drops nothing", () => {
    const provider = new InProcessAttachmentTicketProvider();
    expect(provider.sweepExpired(Date.now())).toBe(0);
    expect(provider.size()).toBe(0);
  });

  test("sweepExpiredAttachmentTickets delegates to the shared provider (unique ids — safe alongside concurrent tests)", async () => {
    const provider = getSharedAttachmentTicketProvider();
    const now = Date.now();
    const expiredId = generateTicketId();
    const freshId = generateTicketId();
    await provider.put(ticketExpiringAt(expiredId, now - 1));
    await provider.put(ticketExpiringAt(freshId, now + 60_000));

    sweepExpiredAttachmentTickets(now);

    expect(await provider.take(expiredId)).toBeNull();
    const fresh = await provider.take(freshId);
    expect(fresh?.id).toBe(freshId);
  });

  test("sweepExpiredAttachmentTickets always returns a number (the `?? 0` fallback path never throws)", () => {
    // By this point in the suite the shared provider already exists (other
    // tests above created it) — this doesn't re-prove the true
    // never-created case in isolation, but pins the return type/no-throw
    // contract the periodic sweep timer depends on every tick.
    expect(typeof sweepExpiredAttachmentTickets()).toBe("number");
  });

  test("start/stop the periodic sweep: idempotent start, a short-interval real timer actually drops an expired ticket, clean stop", async () => {
    // Poll via `size()`, NOT `take(id)` — `take()` deletes unconditionally
    // on any lookup (expired or not; see its own doc comment), so polling
    // with it would consume the ticket itself on the FIRST poll — before
    // the timer ever fires — and the test would pass for the wrong reason.
    const provider = getSharedAttachmentTicketProvider() as InstanceType<typeof InProcessAttachmentTicketProvider>;
    const now = Date.now();
    const id = generateTicketId();
    await provider.put(ticketExpiringAt(id, now - 1)); // already expired
    const baseline = provider.size();

    startAttachmentTicketSweep(15); // 15ms — short enough to observe within the test timeout
    startAttachmentTicketSweep(15); // idempotent — no-op, doesn't create a second timer

    // Poll briefly rather than a single fixed sleep — bounded by the test
    // runner's own timeout.
    let sizeDropped = false;
    for (let i = 0; i < 20 && !sizeDropped; i++) {
      await new Promise((r) => setTimeout(r, 15));
      if (provider.size() < baseline) sizeDropped = true;
    }
    stopAttachmentTicketSweep();
    stopAttachmentTicketSweep(); // idempotent — no-op on an already-stopped sweep

    expect(sizeDropped).toBe(true);
    // Confirm it was genuinely OUR ticket the sweep dropped, not a
    // coincidental size change from something else.
    expect(await provider.take(id)).toBeNull();
  });
});
