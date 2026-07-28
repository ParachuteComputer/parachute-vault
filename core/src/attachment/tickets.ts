/**
 * Attachment tickets — the runtime lane (Wave 1) of the two-lane
 * attachments-for-agents design. Bytes never touch the MCP session:
 * `request-attachment-upload` / `request-attachment-download`
 * (`core/src/mcp.ts`) mint a short-lived, single-use, capability-in-URL
 * ticket; a runtime with a shell (never the model) spends it directly
 * against a bare HTTP endpoint outside the authed API tree.
 *
 * This module owns the wire-shape-defining pieces so both doors can't
 * drift: the ticket record shape, TTL computation, and id generation. The
 * `AttachmentTicketProvider` seam is deliberately dumb — a single-use KV,
 * no policy — because ALL policy (note/attachment resolution, tag-scope,
 * size cap, extension sanitize) runs at mint time in the MCP tools
 * themselves, pinned here so a future cloud implementation can't drift on
 * the wire shape or the error taxonomy.
 */

export type AttachmentTicketKind = "upload" | "download";

/**
 * A minted, not-yet-spent ticket. `sizeBytes` is the DECLARED size at mint
 * — upload: caller-asserted (`request-attachment-upload`'s `size_bytes`,
 * enforced as a hard cap at spend, see `MAX_TICKET_UPLOAD_BYTES`);
 * download: best-effort from `attachments.metadata.size` when the row
 * carries one (advisory only — never enforced, since a download ticket
 * never writes bytes).
 */
export interface AttachmentTicket {
  id: string;
  kind: AttachmentTicketKind;
  vaultName: string;
  createdAt: number;
  expiresAt: number;
  mimeType?: string;
  sizeBytes?: number;
  /** Upload only. */
  noteId?: string;
  filename?: string;
  transcribe?: boolean;
  /**
   * Upload only, voice W2 parity with the REST path's `segment_index`
   * (`src/routes.ts` POST `/notes/:id/attachments`) — an integer >= 0 lets
   * one recording split across several ticket-minted attachments on ONE
   * note, each resolving into its own `(part N)` marker. Only meaningful
   * alongside `transcribe: true`; validated at mint (`generateMcpTools`'s
   * `request-attachment-upload`), consumed at spend (`handleTicketSpend`).
   */
  segmentIndex?: number;
  /** Download only. */
  attachmentId?: string;
}

/**
 * Storage seam for ticket state (D10 — "tools omitted when unwired"). A
 * door that hasn't implemented this yet passes no `attachmentTickets` opt
 * into `generateMcpTools` — `request-attachment-upload` /
 * `request-attachment-download` are then ABSENT from the tool list
 * entirely (not merely erroring on call), so an agent is never shown an
 * affordance the runtime can't back.
 *
 * "State lives where the bytes live" (design decision): bun implements
 * this as an in-process `Map` (`src/attachment-tickets.ts`) — a daemon
 * restart drops every outstanding ticket, which is acceptable at a
 * ≤30-minute TTL and is documented at that call site. A future cloud
 * implementation persists ticket rows in the vault's Durable Object
 * (`ctx.storage`, atomic delete-on-spend under `transactionSync`).
 */
export interface AttachmentTicketProvider {
  /** Persist a freshly-minted ticket. */
  put(ticket: AttachmentTicket): Promise<void>;
  /**
   * Atomic check-and-consume. Returns the ticket exactly once — a second
   * call for the same id (already spent), an id past its `expiresAt`, or
   * an id that never existed all return `null`. Collapsing all three into
   * one shape is deliberate: the spend route gives an unguessable-URL
   * adversary no oracle distinguishing "wrong id" from "right id, too
   * late" — the caller still separately checks `expiresAt` against
   * wall-clock (a `take` implementation MAY also drop expired entries
   * opportunistically, but callers must not rely on that for correctness).
   */
  take(id: string): Promise<AttachmentTicket | null>;
}

/**
 * Absolute REST upload ceiling (mirrors `MAX_UPLOAD_BYTES`,
 * `src/routes.ts`) — a ticket can never promise more than REST itself
 * accepts for the same bytes. Enforced at MINT (a `size_bytes` over this
 * is rejected before a ticket is even created) — the ticket's own
 * `sizeBytes` (always `<=` this) is the tighter, per-ticket cap the spend
 * route actually enforces.
 */
export const MAX_TICKET_UPLOAD_BYTES = 100 * 1024 * 1024;

const TICKET_TTL_BASE_MS = 10 * 60 * 1000; // 10 minutes
const TICKET_TTL_PER_MIB_MS = 10 * 1000; // +10s per declared MiB
const TICKET_TTL_MAX_MS = 30 * 60 * 1000; // hard cap, 30 minutes

/**
 * TTL for a minted ticket, in ms. 10 minutes base + 10 seconds per
 * declared MiB (a slow tether on a large upload gets proportionally more
 * room), hard-capped at 30 minutes regardless of size (Aaron-ratified
 * amendment over the spec's original flat 120s). A size-less mint
 * (download ticket for a row with no known size) gets the base TTL.
 * Single-use is enforced separately and unconditionally by
 * `AttachmentTicketProvider.take` — TTL only bounds how long an UNSPENT
 * ticket stays valid, never how many times a spent one can be reused.
 */
export function computeTicketTtlMs(sizeBytes?: number): number {
  if (!sizeBytes || sizeBytes <= 0) return TICKET_TTL_BASE_MS;
  const mib = sizeBytes / (1024 * 1024);
  return Math.min(TICKET_TTL_BASE_MS + mib * TICKET_TTL_PER_MIB_MS, TICKET_TTL_MAX_MS);
}

/**
 * 256-bit random ticket id, hex-encoded (64 chars). Capability-in-URL — the
 * ticket's entropy is the ONLY thing standing between "knows the URL" and
 * "can spend it" (no auth beyond the ticket itself), so this is Web Crypto
 * `getRandomValues`, never `Math.random()`. Global `crypto` — available in
 * both Bun and the Cloudflare Workers runtime, so this module stays
 * runtime-agnostic.
 */
export function generateTicketId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
