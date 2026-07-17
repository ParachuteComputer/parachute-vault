/**
 * Attachment tickets — bun's runtime-lane implementation (Wave 1).
 *
 * `InProcessAttachmentTicketProvider` is the process-wide (not per-vault)
 * ticket store — a plain `Map` keyed by the 256-bit ticket id, which is
 * already globally unguessable, so there's no need to shard by vault. A
 * daemon restart drops every outstanding ticket: acceptable given the
 * ≤30-minute TTL (a caller mid-upload across a restart just re-mints), and
 * simpler than persisting single-use, short-lived state to disk. Cloud's
 * future mirror persists to the vault's Durable Object instead — see
 * `AttachmentTicketProvider`'s doc comment (`core/src/attachment/tickets.ts`).
 *
 * `handleTicketSpend` is the bare (no auth beyond the ticket itself) HTTP
 * handler `src/routing.ts` dispatches to for `/vault/<name>/tickets/<id>`
 * — BEFORE `authenticateVaultRequest` runs, deliberately: the ticket IS
 * the credential, and a bearer-less shell (curl) must be able to spend it.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "fs";
import { join, normalize } from "path";
import type { Store } from "../core/src/types.ts";
import type { AttachmentTicket, AttachmentTicketProvider } from "../core/src/attachment/tickets.ts";
import { sanitizeAttachmentExtension } from "../core/src/attachment/policy.ts";
import { assetsDir, readVaultConfig } from "./config.ts";
import { shouldAutoTranscribe } from "./auto-transcribe.ts";
import { invalidateUsageCache } from "./usage.ts";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * Process-wide, in-memory ticket store (see module doc comment for the
 * restart-drops-tickets tradeoff). `take` deletes unconditionally on
 * lookup — single-use is enforced by the delete itself, not by a separate
 * expiry check; `takeValidTicket` below still checks `expiresAt` after
 * `take` returns, collapsing "expired" into the same null as "spent" /
 * "unknown" so the HTTP layer can give a uniform 404 (no oracle).
 */
class InProcessAttachmentTicketProvider implements AttachmentTicketProvider {
  private readonly tickets = new Map<string, AttachmentTicket>();

  async put(ticket: AttachmentTicket): Promise<void> {
    this.tickets.set(ticket.id, ticket);
  }

  async take(id: string): Promise<AttachmentTicket | null> {
    const ticket = this.tickets.get(id);
    if (!ticket) return null;
    this.tickets.delete(id);
    return ticket;
  }
}

let sharedProvider: InProcessAttachmentTicketProvider | undefined;

/** The one shared ticket provider for this process (see class doc comment above). */
export function getSharedAttachmentTicketProvider(): AttachmentTicketProvider {
  if (!sharedProvider) sharedProvider = new InProcessAttachmentTicketProvider();
  return sharedProvider;
}

/** Test-only: force a fresh provider so ticket state doesn't leak between test files. */
export function resetSharedAttachmentTicketProviderForTests(): void {
  sharedProvider = undefined;
}

/**
 * Take + validate a ticket against the URL's vault name and the spend
 * route's expected kind (a GET must not spend an upload ticket, etc.).
 * Collapses spent / expired / unknown / wrong-vault / wrong-kind into the
 * SAME `null` — the uniform-404 no-oracle posture the design calls for
 * (an adversary probing an unguessable URL learns nothing about WHY it
 * failed).
 */
async function takeValidTicket(
  provider: AttachmentTicketProvider,
  id: string,
  vaultName: string,
  kind: AttachmentTicket["kind"],
): Promise<AttachmentTicket | null> {
  const ticket = await provider.take(id);
  if (!ticket) return null;
  if (ticket.kind !== kind || ticket.vaultName !== vaultName || ticket.expiresAt < Date.now()) {
    return null;
  }
  return ticket;
}

function ticketNotFound(): Response {
  return json(
    {
      error: "Not found",
      error_type: "not_found",
      how_to:
        "tickets are single-use and short-lived — mint a new one with request-attachment-upload / request-attachment-download",
    },
    404,
  );
}

/**
 * Dispatch a ticket spend request for `/vault/<name>/tickets/<id>`. PUT or
 * POST spends an upload ticket (the mint tool advertises PUT; POST is
 * accepted too for runtimes/proxies that rewrite methods); GET spends a
 * download ticket. Any other method, or a method that doesn't match the
 * ticket's own kind, collapses to the same 404 `takeValidTicket` uses —
 * no oracle on which kind a given id was minted for.
 */
export async function handleTicketSpend(
  req: Request,
  ticketId: string,
  vaultName: string,
  store: Store,
): Promise<Response> {
  const provider = getSharedAttachmentTicketProvider();

  if (req.method === "PUT" || req.method === "POST") {
    return handleUploadSpend(req, ticketId, vaultName, store, provider);
  }
  if (req.method === "GET") {
    return handleDownloadSpend(ticketId, vaultName, store, provider);
  }
  return ticketNotFound();
}

async function handleUploadSpend(
  req: Request,
  ticketId: string,
  vaultName: string,
  store: Store,
  provider: AttachmentTicketProvider,
): Promise<Response> {
  const ticket = await takeValidTicket(provider, ticketId, vaultName, "upload");
  if (!ticket || !ticket.noteId || !ticket.filename || !ticket.mimeType) return ticketNotFound();

  // Declared size at mint IS the enforced cap here — tighter than the flat
  // REST ceiling, per the ticket's own promise (`max_bytes` in the mint
  // response). A ticket somehow minted with no declared size fails closed
  // (0 bytes allowed) rather than falling back to the flat 100 MiB cap.
  const declaredMax = ticket.sizeBytes ?? 0;

  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > declaredMax) {
      return json(
        {
          error: `Upload exceeds the ticket's declared size (${declaredMax} bytes)`,
          error_type: "file_too_large",
          limit: declaredMax,
          got: declared,
          how_to: "mint a new ticket with an accurate size_bytes",
        },
        413,
      );
    }
  }

  const buffer = Buffer.from(await req.arrayBuffer());
  if (buffer.length > declaredMax) {
    return json(
      {
        error: `Upload exceeds the ticket's declared size (${declaredMax} bytes)`,
        error_type: "file_too_large",
        limit: declaredMax,
        got: buffer.length,
        how_to: "mint a new ticket with an accurate size_bytes",
      },
      413,
    );
  }

  // Same on-disk write discipline as REST's POST /storage/upload
  // (src/routes.ts) — server-generated path, never caller-controlled.
  const ext = sanitizeAttachmentExtension(ticket.filename);
  const date = new Date().toISOString().split("T")[0]!;
  const dir = join(assetsDir(vaultName), date);
  mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`;
  writeFileSync(join(dir, filename), buffer);
  const relativePath = `${date}/${filename}`;

  invalidateUsageCache(vaultName);

  // Mirrors the REST POST /notes/:id/attachments transcribe decision
  // exactly (src/routes.ts): explicit opt-in (here, `transcribe: true` at
  // mint) wins; otherwise infer from mime-type + the owning vault's
  // auto-transcribe toggle.
  const explicitOptIn = ticket.transcribe === true;
  const perVaultEnabled = readVaultConfig(vaultName)?.auto_transcribe?.enabled;
  const autoOptIn = !explicitOptIn && shouldAutoTranscribe(ticket.mimeType, { perVaultEnabled });
  const attMeta: Record<string, unknown> = {
    original_name: ticket.filename,
    size: buffer.length,
  };
  if (explicitOptIn || autoOptIn) {
    attMeta.transcribe_status = "pending";
    attMeta.transcribe_requested_at = new Date().toISOString();
    attMeta.transcribe_origin = explicitOptIn ? "legacy" : "auto";
  }

  const attachment = await store.addAttachment(ticket.noteId, relativePath, ticket.mimeType, attMeta);

  if (explicitOptIn) {
    const note = await store.getNote(ticket.noteId);
    if (note) {
      const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
      if (noteMeta.transcribe_stub !== true) {
        await store.updateNote(ticket.noteId, {
          metadata: { ...noteMeta, transcribe_stub: true },
          skipUpdatedAt: true,
        });
      }
    }
  }

  // Ticket mint + register in one shot (vs REST's two-step upload-then-
  // attach) — the spend response is the attachment row itself, so the
  // runtime can hand the id straight back to the model.
  return json(attachment, 201);
}

async function handleDownloadSpend(
  ticketId: string,
  vaultName: string,
  store: Store,
  provider: AttachmentTicketProvider,
): Promise<Response> {
  const ticket = await takeValidTicket(provider, ticketId, vaultName, "download");
  if (!ticket || !ticket.attachmentId) return ticketNotFound();

  // The row can vanish between mint and spend (rare — a delete racing a
  // slow curl); fold that into the same uniform 404 rather than a 500.
  const attachment = await store.getAttachment(ticket.attachmentId);
  if (!attachment) return ticketNotFound();

  const assets = assetsDir(vaultName);
  const filePath = normalize(join(assets, attachment.path));
  if (!filePath.startsWith(normalize(assets)) || !existsSync(filePath)) {
    return json(
      {
        error: "Not found",
        error_type: "attachment_binary_missing",
        how_to: "the attachment row exists but its bytes are gone — this ticket can't be re-spent",
      },
      404,
    );
  }

  const stat = statSync(filePath);
  const fileBuffer = readFileSync(filePath);
  return new Response(fileBuffer, {
    status: 200,
    headers: {
      "Content-Type": attachment.mimeType || "application/octet-stream",
      "Content-Length": String(stat.size),
      // Same defense-in-depth as the existing GET /storage/<path> byte-serve
      // (src/routes.ts) — never let a browser MIME-sniff a stored asset into
      // an active type.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
