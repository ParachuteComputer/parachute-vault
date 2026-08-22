import { Database } from "bun:sqlite";
import type { Store, Note, QueryOpts, Attachment } from "./types.js";
import { transactionAsync } from "./txn.js";
import * as noteOps from "./notes.js";
import { filterMetadata, MAX_BATCH_SIZE, validateExtension, ExtensionValidationError, validatePath } from "./notes.js";
import { normalizePath } from "./paths.js";
import { QueryError } from "./query-operators.js";
import { TAG_EXPAND_MODES, stripTagHash, suggestSimilarTag, type TagExpandMode } from "./tag-hierarchy.js";
import {
  collectUnknownTagWarnings,
  emptySearchWarning,
  ignoredParamWarning,
  truncatedResultsWarning,
  computeSearchDidYouMean,
  searchDidYouMeanWarning,
  embeddingsPendingWarning,
  type QueryWarning,
} from "./query-warnings.js";
import { SEARCH_MODES, buildLiteralSearchQuery, isValidSearchMode, type SearchMode } from "./search-query.js";
import * as linkOps from "./links.js";
import {
  resolveOrQueueLink,
  resolveStructuredLinkNote,
  getUnresolvedLinksForNote,
  getUnresolvedLinksForNotes,
  getContentWikilinkWarnings,
} from "./wikilinks.js";
import * as tagSchemaOps from "./tag-schemas.js";
import type { TagFieldSchema } from "./tag-schemas.js";
import {
  SchemaValidationError,
  strictViolations,
  type ValidationWarning,
} from "./schema-defaults.js";
import {
  expandContent,
  DEFAULT_EXPAND_DEPTH,
  MAX_EXPAND_DEPTH,
  type ExpandContext,
  type ExpandMode,
} from "./expand.js";
import {
  parseContentRange,
  applyContentRange,
  contentRangeRequiresContent,
  parseAttachmentContentRange,
  alignByteWindow,
} from "./content-range.js";
import { MCP_TOOL_MANIFEST } from "./mcp-manifest.js";
import {
  BLOCKED_ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MIME_TYPES,
  sanitizeAttachmentExtension,
  mimeForAttachmentExtension,
} from "./attachment/policy.js";
import {
  computeTicketTtlMs,
  generateTicketId,
  MAX_TICKET_UPLOAD_BYTES,
  type AttachmentTicket,
  type AttachmentTicketProvider,
} from "./attachment/tickets.js";
import {
  MAX_ATTACHMENT_IMAGE_BYTES,
  type AttachmentBytesProvider,
} from "./attachment/bytes-provider.js";

/**
 * A single MCP tool-result content block. Mirrors the subset of the MCP SDK's
 * `CallToolResult.content` shape this codebase actually emits — a plain text
 * block (the existing, universal shape) or a real image block (`read-attachment`'s
 * image branch, D3). Kept as a local, minimal type rather than importing the
 * SDK's own (broader — audio, resource links, ...) union, since core has no
 * dependency on `@modelcontextprotocol/sdk` today and this is the only shape
 * any tool here produces.
 */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => unknown | Promise<unknown>;
  /**
   * Minimum scope verb the caller must hold for THIS vault to see + invoke
   * the tool. `read` for pure queries, `write` for mutations, `admin` for
   * operator-only surfaces (`prune-schema` in core; `manage-token` in the
   * server layer). The MCP HTTP layer filters
   * `tools/list` by this field and verb-gates `tools/call` against it; the
   * filter is the primary defense, the inner gate is defense-in-depth.
   *
   * Pre-v19 unstamped tools default to `write` at the dispatch layer so a
   * future addition that forgets to stamp this gets the safer treatment.
   */
  requiredVerb: "read" | "write" | "admin";
  /**
   * OPTIONAL override for how `execute()`'s return value becomes MCP
   * `content` blocks. Every tool WITHOUT this wraps its result as the single
   * `JSON.stringify` text block the HTTP layer has always produced
   * (`src/mcp-http.ts`) — unchanged default behavior. `read-attachment`'s
   * image branch is the only current user: it needs a REAL `{type:"image"}`
   * block alongside the row-JSON text block so the model actually SEES the
   * picture, not just its metadata (D3, attachments-for-agents design "the
   * one wrapper change").
   */
  resultContent?: (result: unknown) => McpContentBlock[];
}

/**
 * The store-bound behavior half of a tool, keyed by tool `name`.
 * `generateMcpTools` builds one of these per tool, then zips it with the
 * matching {@link MCP_TOOL_MANIFEST} entry (which owns name/description/
 * inputSchema/requiredVerb) to produce the final {@link McpToolDef}. Splitting
 * behavior from metadata is what lets the pure-data manifest live in a
 * `bun:sqlite`-free module a front-of-house layer can import.
 */
interface McpToolExecutor {
  name: string;
  execute: (params: Record<string, unknown>) => unknown | Promise<unknown>;
  resultContent?: (result: unknown) => McpContentBlock[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a plain `Error` carrying a stable `error_type` (+ optional `field`/
 * `hint`) as duck-typed extra properties — the same pattern `QueryError`
 * uses for its optional structured fields. For validation leaves that don't
 * warrant a dedicated exported class (one caller-facing shape, not a reusable
 * domain error), this is what lets the generic domain-error mapping in
 * `src/mcp-http.ts` surface `data.error_type` instead of falling through to
 * the unstructured `isError: true` text fallback (vault#554).
 */
function structuredError(
  message: string,
  fields: { error_type: string; field?: string; hint?: string } & Record<string, unknown>,
): Error {
  return Object.assign(new Error(message), fields);
}

/**
 * Resolve a note identifier — tries ID first, then case-insensitive
 * path match, then (additive fallback) an H1-title match. Works
 * everywhere a note reference is accepted (query-notes `id`, update-note
 * `id`, delete-note `id`, find-path anchors).
 *
 * Path-with-extension form (vault#330 S1): a trailing `.<ext>` matching
 * the extension pattern (`/^[a-z0-9]{1,16}$/i`) is parsed as
 * `(path, extension)` to disambiguate notes that share a path
 * differing only by extension. Mirrors the wikilink ambiguity policy
 * from vault#328.
 *
 * On ambiguous path with no extension hint, `getNoteByPath` throws
 * `AmbiguousPathError` — `resolveNote` propagates it so MCP / REST
 * handlers can surface a clear 4xx rather than picking arbitrarily.
 *
 * Title fallback (additive): reached only when id AND path/extension
 * BOTH miss cleanly (no throw). Resolves via `noteOps.getNoteByTitle` —
 * the note whose first `# ` content line equals `idOrPath`, exactly one
 * match required. Same [[wikilink]] semantics as `resolveWikilink`; exact
 * id/path always wins first.
 */
function resolveNote(db: Database, idOrPath: string): Note | null {
  // Try ID match first (fast, indexed)
  const byId = noteOps.getNote(db, idOrPath);
  if (byId) return byId;
  // Path-with-extension form: `Tabular/budget.csv` → (path="Tabular/
  // budget", extension="csv"). Only kicks in when the suffix looks
  // like an extension AND a `(path, ext)` row exists. Fall through to
  // the no-extension lookup if not (so `Recipe.v2` where `v2` isn't a
  // real extension still finds Recipe.v2 by exact-path).
  const extMatch = idOrPath.match(/^(.*)\.([a-z0-9]{1,16})$/i);
  if (extMatch) {
    const explicit = noteOps.getNoteByPath(db, extMatch[1]!, extMatch[2]!);
    if (explicit) return explicit;
  }
  const byPath = noteOps.getNoteByPath(db, idOrPath);
  if (byPath) return byPath;
  return noteOps.getNoteByTitle(db, idOrPath);
}

function requireNote(db: Database, idOrPath: string): Note {
  const note = resolveNote(db, idOrPath);
  if (!note) {
    throw structuredError(`Note not found: "${idOrPath}"`, { error_type: "not_found", field: "id" });
  }
  return note;
}

/**
 * Remove [[wikilink]] brackets from note content for a specific target.
 * Handles [[Target]], [[Target|alias]], [[Target#section]].
 */
function removeWikilinkBrackets(content: string, targetPath: string): string {
  // Match [[TargetPath...]] with optional alias/anchor, replace with display text
  const escaped = targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // [[Target|alias]] → alias
  content = content.replace(
    new RegExp(`\\[\\[${escaped}\\|([^\\]]+)\\]\\]`, "gi"),
    "$1",
  );
  // [[Target#section]] → Target#section (just remove brackets)
  content = content.replace(
    new RegExp(`\\[\\[${escaped}(#[^\\]]+)?\\]\\]`, "gi"),
    `${targetPath}$1`,
  );
  return content;
}

// ---------------------------------------------------------------------------
// read-attachment helpers (Wave 2 model lane — D2-D5)
// ---------------------------------------------------------------------------

/** Non-`text/*` mime types `read-attachment` still treats as text (D2's "text/* + TEXT_MIMES allowlist"). `text/csv` and `text/markdown` already match `text/*` via ATTACHMENT_MIME_TYPES, so they need no entry here. */
const TEXT_MIME_ALLOWLIST = new Set([
  "application/json",
  "application/ndjson",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
]);

function baseMime(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

function isTextMime(mimeType: string): boolean {
  const base = baseMime(mimeType);
  return base.startsWith("text/") || TEXT_MIME_ALLOWLIST.has(base);
}

function isImageMime(mimeType: string): boolean {
  return baseMime(mimeType).startsWith("image/");
}

function isAudioOrVideoMime(mimeType: string): boolean {
  const base = baseMime(mimeType);
  return base.startsWith("audio/") || base.startsWith("video/");
}

/**
 * Effective mime for `read-attachment` — same discipline the REST byte-serve
 * route uses (`src/routes.ts`'s `GET /storage/<path>`): the stored file's
 * EXTENSION wins over the row's `mime_type` column, since the row's mime is
 * caller-asserted at upload time and never verified against the bytes. Falls
 * back to the row's mime_type, then `application/octet-stream`.
 */
function effectiveAttachmentMime(attachment: Attachment): string {
  const ext = sanitizeAttachmentExtension(attachment.path);
  return ATTACHMENT_MIME_TYPES[ext] ?? attachment.mimeType ?? "application/octet-stream";
}

/** Stat the attachment's bytes, or throw the `attachment_binary_missing` refusal (D5's "row outlived bytes" case — e.g. an audio-retention eviction). */
async function statAttachmentOrMissing(
  attachment: Attachment,
  provider: AttachmentBytesProvider,
): Promise<{ size: number }> {
  const stat = await provider.stat(attachment);
  if (!stat) {
    throw structuredError(`Attachment binary missing: "${attachment.id}"`, {
      error_type: "attachment_binary_missing",
      how_to:
        "the attachment row exists but its bytes are gone (e.g. an audio-retention eviction after transcription) — this content can't be read",
    });
  }
  return stat;
}

/**
 * Text branch: byte-windowed read using the exact query-notes pagination
 * contract (`content`/`content_offset`/`content_total_length`/
 * `content_next_offset`). Does a BOUNDED positional read — never the whole
 * file — via `alignByteWindow` (see its doc comment for the exact window
 * the provider is asked to fetch).
 */
async function readTextAttachment(
  attachment: Attachment,
  mimeType: string,
  params: Record<string, unknown>,
  provider: AttachmentBytesProvider,
): Promise<Record<string, unknown>> {
  const range = parseAttachmentContentRange(params.content_offset, params.content_length);
  const stat = await statAttachmentOrMissing(attachment, provider);
  const total = stat.size;

  if (range.offset >= total) {
    return {
      attachment_id: attachment.id,
      mime_type: mimeType,
      content: "",
      content_offset: total,
      content_total_length: total,
      content_next_offset: null,
    };
  }

  const rawStart = Math.max(0, range.offset - 3);
  // +1: alignByteWindow's end-boundary check reads the byte AT the window's
  // exclusive end — see its doc comment precondition.
  const rawEnd = Math.min(total, range.offset + range.length + 1);
  const raw = await provider.readRange(attachment, rawStart, rawEnd);
  const fields = alignByteWindow(raw, rawStart, range, total);

  return {
    attachment_id: attachment.id,
    mime_type: mimeType,
    ...fields,
  };
}

/**
 * Image branch: whole-file read, gated by {@link MAX_ATTACHMENT_IMAGE_BYTES}
 * (checked via `stat` BEFORE any bytes are read — an over-cap image never
 * touches `readRange` at all). The base64 payload rides in `_mcpImage`, a
 * field this tool's own `resultContent` consumes to build the real MCP image
 * block and then strips before the text block is serialized (see the tool
 * definition below) — no other caller should read `_mcpImage`.
 */
async function readImageAttachment(
  attachment: Attachment,
  mimeType: string,
  provider: AttachmentBytesProvider,
): Promise<Record<string, unknown>> {
  const stat = await statAttachmentOrMissing(attachment, provider);
  if (stat.size > MAX_ATTACHMENT_IMAGE_BYTES) {
    throw structuredError(
      `Image attachment (${stat.size} bytes) exceeds the ${MAX_ATTACHMENT_IMAGE_BYTES} byte (4 MiB) read cap`,
      {
        error_type: "image_too_large",
        size: stat.size,
        max_bytes: MAX_ATTACHMENT_IMAGE_BYTES,
        how_to: "mint a download ticket with request-attachment-download and process the image locally",
      },
    );
  }
  const raw = await provider.readRange(attachment, 0, stat.size);
  return {
    attachment_id: attachment.id,
    mime_type: mimeType,
    size_bytes: stat.size,
    _mcpImage: { data: Buffer.from(raw).toString("base64"), mimeType },
  };
}

/**
 * Audio/video branch: never bytes. Returns a transcript pointer built
 * entirely from metadata the transcription pipeline already stamps
 * (`attachment.metadata.transcribe_status`) plus the provider's OPTIONAL
 * sibling-note resolution — no bytes are read or even stat'd.
 */
async function readAudioPointer(
  attachment: Attachment,
  provider: AttachmentBytesProvider,
): Promise<Record<string, unknown>> {
  const meta = attachment.metadata as Record<string, unknown> | undefined;
  const transcribeStatus = typeof meta?.transcribe_status === "string" ? meta.transcribe_status : undefined;
  if (!transcribeStatus) {
    throw structuredError(`Audio/video attachment "${attachment.id}" has no transcript`, {
      error_type: "audio_bytes_not_supported",
      how_to:
        "re-attach with transcribe: true to get a transcript, or mint a download ticket with request-attachment-download to process the bytes locally",
    });
  }
  const result: Record<string, unknown> = {
    attachment_id: attachment.id,
    transcribe_status: transcribeStatus,
    note_id: attachment.noteId,
  };
  if (provider.resolveTranscriptNote) {
    const transcriptNote = await provider.resolveTranscriptNote(attachment);
    if (transcriptNote) result.transcript_note = transcriptNote;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool generation
// ---------------------------------------------------------------------------

/**
 * Options for {@link generateMcpTools}.
 *
 * `expandVisibility` (vault security review) is an OPTIONAL per-note
 * visibility predicate threaded into the wikilink-expansion context for
 * `query-notes`. When provided, `expand_links` inlining leaves any wikilink
 * whose target fails the predicate UNRESOLVED — so a tag-scoped MCP session
 * can't inline out-of-scope note content during expansion (the filtering
 * happens DURING expansion, not after). Core stays scope-unaware: it
 * receives a plain `(note) => boolean` closure and never imports the
 * server's tag-scope module. Omitted (every internal / unscoped caller) →
 * expansion behaves exactly as before.
 */
export interface GenerateMcpToolsOpts {
  /**
   * Write-attribution context (vault#298) stamped onto every note written
   * through these tools. `actor` is the principal (JWT `sub` / operator
   * label); `via` is the interface the write arrived through (here, always an
   * MCP session — the server-side wrapper derives `mcp` or a more specific
   * `agent:<id>` / `surface:<name>` when the token's claims reveal it). The
   * core tools pass it straight into `store.createNote` / `store.updateNote`.
   * Omitted (internal / unattributed callers) → writes leave attribution NULL.
   */
  writeContext?: { actor?: string | null; via?: string | null };
  /**
   * Strict-schema enforcement controls (vault#299 Part A). By default every
   * write through these tools enforces `strict:true` field constraints — a
   * violation throws `SchemaValidationError` and the note is NOT written.
   *
   *   `strictBypass: true` — the caller holds the migration-bypass scope
   *     (`vault:migrate`); skip enforcement so non-conforming notes can be
   *     migrated/backfilled. Every bypassed write that WOULD have been
   *     rejected calls `onStrictBypass` for logging (the audit-log table,
   *     #300, is deferred — we log to the daemon's structured log for now).
   *   `onStrictBypass` — invoked once per bypassed write with the would-be
   *     violations plus the actor/via from `writeContext`. Server-layer
   *     supplies a structured logger; core stays log-sink-agnostic.
   */
  strictBypass?: boolean;
  onStrictBypass?: (info: {
    actor: string | null;
    via: string | null;
    path?: string | null;
    tags?: string[];
    violations: ValidationWarning[];
  }) => void;
  expandVisibility?: (note: Note) => boolean;
  /**
   * `nearTraversable` (vault#439) is an OPTIONAL per-note predicate threaded
   * into the `near[]` graph BFS. When provided, the traversal refuses to walk
   * THROUGH any note that fails the predicate — making a tag-scoped `near[]`
   * query symmetric with `find-path` (scope is a wall, not a sieve). Core
   * stays scope-unaware: it receives a plain `(noteId) => boolean` closure.
   * Omitted (unscoped / internal callers) → the full graph is walked.
   */
  nearTraversable?: (noteId: string) => boolean;
  /**
   * `ifExistsVisible` (vault#555 auth-review must-fix) is an OPTIONAL per-note
   * predicate gating the `create-note` `if_exists` upsert. `if_exists` resolves
   * the target `path` VAULT-WIDE (`getNoteByPath`) and then returns (ignore) /
   * updates / replaces the found note — so without a scope gate a tag-scoped
   * caller could READ or OVERWRITE an out-of-scope note just by naming its
   * path. When provided, `applyExistingNote` calls this predicate on the
   * RESOLVED existing note and, if it returns false, throws `PathConflictError`
   * instead (the path is taken but invisible to this caller — no content
   * exposed, nothing mutated). It's applied INSIDE `applyExistingNote`, which
   * BOTH the proactive-check site AND the concurrent-INSERT race-backstop site
   * funnel through — so a TOCTOU race (both existence checks miss, the real
   * INSERT then loses to a concurrent writer's out-of-scope note) can't slip a
   * note past it. Core stays scope-unaware: it receives a plain
   * `(note) => boolean` closure and never imports the server's tag-scope
   * module. Omitted (unscoped / internal callers) → `if_exists` resolves
   * against the full vault exactly as before.
   */
  ifExistsVisible?: (note: Note) => boolean;
  /**
   * `aggregateVisibility` is an OPTIONAL per-note visibility predicate for
   * `query-notes`'s `aggregate` mode. When provided, the aggregate is
   * computed by first fetching every note the OTHER filters match
   * (unpaginated), narrowing to the notes the predicate accepts, and THEN
   * aggregating over just that visible id set — rather than the (faster)
   * direct SQL GROUP BY the unscoped path takes. This mirrors
   * `expandVisibility`/`nearTraversable`: core stays scope-unaware, it only
   * invokes a plain `(note) => boolean` closure the server injects. Omitted
   * (unscoped / internal callers) → the aggregate runs the fast direct-SQL
   * path with no extra fetch.
   */
  aggregateVisibility?: (note: Note) => boolean;
  /**
   * `AttachmentTicketProvider` seam (vault attachment-tickets design,
   * Wave 1 — D10 "tools omitted when unwired"). When provided,
   * `generateMcpTools` appends `request-attachment-upload` /
   * `request-attachment-download` to the returned tool list. Omitted (a
   * door that hasn't wired its ticket seam yet) → the two tools are
   * ABSENT from the list entirely — not merely erroring on call — so an
   * agent is never shown an affordance the runtime can't back.
   */
  attachmentTickets?: {
    provider: AttachmentTicketProvider;
    /** This vault's own name — stamped onto every minted ticket so the spend route can cheaply reject a cross-vault replay. */
    vaultName: string;
    /**
     * Absolute base URL for this vault's ticket spend path, no trailing
     * slash — e.g. `https://host/vault/<name>`. A minted ticket's URL is
     * `${urlBase}/tickets/<id>`. Resolved by the caller (server layer)
     * from the incoming request's `X-Forwarded-Host`/proto — core stays
     * request-unaware.
     */
    urlBase: string;
    /**
     * OPTIONAL per-note visibility predicate (tag-scope confidentiality —
     * same intent as `expandVisibility`/`ifExistsVisible` above, kept
     * separate because it needs to be awaitable). Both ticket tools run
     * fully async execute() paths (unlike `expandVisibility`/
     * `ifExistsVisible`, which feed core's SYNCHRONOUS wikilink/if_exists
     * code and so need the shared pre-resolved-allowlist-holder
     * machinery), so this can just be awaited inline. Omitted (unscoped /
     * internal callers) → every note/attachment is visible.
     */
    noteVisible?: (note: Note) => boolean | Promise<boolean>;
  };
  /**
   * `AttachmentBytesProvider` seam (Wave 2 model lane — D10, same "tools
   * omitted when unwired" posture as `attachmentTickets` above). When
   * provided, `generateMcpTools` appends `read-attachment` to the returned
   * tool list. Omitted (a door that hasn't wired byte access yet) →
   * `read-attachment` is ABSENT from the list entirely.
   */
  attachmentBytes?: {
    provider: AttachmentBytesProvider;
    /**
     * OPTIONAL per-note visibility predicate — identical contract to
     * `attachmentTickets.noteVisible` above (same tag-scope confidentiality
     * intent; kept as a separate field since a caller could in principle
     * wire one seam without the other, though the server layer always wires
     * both from the same underlying check). Omitted → every attachment is
     * visible.
     */
    noteVisible?: (note: Note) => boolean | Promise<boolean>;
  };
}

/**
 * Generate the consolidated MCP tools for a vault. Surface (13):
 * query-notes, list-tags, find-path, vault-info, doctor (read); create-note,
 * update-note, delete-note (write); update-tag, delete-tag, rename-tag,
 * merge-tags, prune-schema (admin). `manage-token` (admin) is appended by
 * the SERVER layer (src/mcp-tools.ts), not here — see that file's doc
 * comment.
 *
 * **Re-tier (this PR):** content-authorship (write) is now separate from
 * structure/taxonomy/schema-curation (admin). `update-tag`/`delete-tag`/
 * `rename-tag`/`merge-tags` moved write → admin — they define schemas and
 * restructure the tag graph across ALL notes, not just author content.
 * `doctor` moved admin → read — it's a read-only, tag-scope-restricted
 * diagnostic (see `applyTagScopeWrappers` in src/mcp-tools.ts), and
 * read-scoped monitoring/tending jobs need to be able to run it without an
 * admin credential. BREAKING: a `vault:write` token that used to
 * rename/merge/delete/update tags now gets `insufficient_scope`; a
 * `vault:read` token can now call `doctor`. See CHANGELOG.
 */
export function generateMcpTools(store: Store, opts?: GenerateMcpToolsOpts): McpToolDef[] {
  const db: Database = store.db;
  const expandVisibility = opts?.expandVisibility;
  const nearTraversable = opts?.nearTraversable;
  const ifExistsVisible = opts?.ifExistsVisible;
  const aggregateVisibility = opts?.aggregateVisibility;
  // Write-attribution (vault#298) — captured once at tool-generation time
  // (a fresh tool set is generated per MCP request, so this is request-scoped)
  // and folded into every create/update the tools perform.
  const writeActor = opts?.writeContext?.actor ?? null;
  const writeVia = opts?.writeContext?.via ?? null;
  const strictBypass = opts?.strictBypass === true;
  const onStrictBypass = opts?.onStrictBypass;

  /**
   * Pre-write strict-schema gate (vault#299 Part A). Validate the PROSPECTIVE
   * note shape (final tags + merged metadata) against the resolved schemas.
   * - No strict violations → no-op (the write proceeds; advisory warnings
   *   still surface later via `attachValidationStatus`).
   * - Strict violations + no bypass → throw `SchemaValidationError` (single
   *   error, all per-field violations) so nothing is written.
   * - Strict violations + bypass → log via `onStrictBypass` and proceed.
   * Called immediately before `store.createNote` / `store.updateNote` so a
   * rejection leaves the note untouched.
   */
  const enforceStrict = (shape: {
    path?: string | null;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): void => {
    enforceStrictWrite(store, shape, {
      bypass: strictBypass,
      onBypass: onStrictBypass
        ? (violations) =>
            onStrictBypass({
              actor: writeActor,
              via: writeVia,
              path: shape.path ?? null,
              tags: shape.tags,
              violations,
            })
        : undefined,
    });
  };

  // Store-bound behavior, keyed by tool name. Metadata (name/description/
  // inputSchema/requiredVerb + inclusion condition) lives in MCP_TOOL_MANIFEST;
  // the return step below zips the two together. Order here is irrelevant —
  // the emitted tool order comes from the manifest.
  const executorDefs: McpToolExecutor[] = [

    // =====================================================================
    // 1. query-notes — the universal read tool
    // =====================================================================
    {
      name: "query-notes",
      execute: async (params) => {
        // --- Link expansion config (shared across single + list paths) ---
        const expandLinks = params.expand_links === true;
        const expandMode = (params.expand_mode as ExpandMode) ?? "full";
        const expandDepth = Math.max(
          0,
          Math.min(
            (params.expand_depth as number | undefined) ?? DEFAULT_EXPAND_DEPTH,
            MAX_EXPAND_DEPTH,
          ),
        );
        const expandCtx: ExpandContext | null = expandLinks
          ? {
              db,
              mode: expandMode,
              expanded: new Set(),
              // Tag-scope confidentiality (security review): when a visibility
              // predicate was injected, wikilinks to out-of-scope notes are
              // left unresolved DURING inlining — never embedded. Unscoped
              // callers pass no predicate and inlining is unchanged.
              ...(expandVisibility ? { isVisible: expandVisibility } : {}),
            }
          : null;

        // --- Content range (bounded reads for large notes) ---
        // Validates loudly: bad values throw QueryError here, before any
        // query work. Null when neither param is present — response shape
        // stays byte-identical to the no-pagination behavior.
        const contentRange = parseContentRange(params.content_offset, params.content_length);

        // --- Single note by ID/path ---
        if (params.id) {
          const note = resolveNote(db, params.id as string);
          if (!note) return { error: "Note not found", error_type: "not_found", id: params.id };
          const includeContent = params.include_content !== false; // default true for single
          // Range params are meaningless on a content-less shape — error
          // rather than silently ignore (same loud-validation policy as
          // `expand`).
          if (contentRange && !includeContent) throw contentRangeRequiresContent();
          let result: any = includeContent ? { ...note } : noteOps.toNoteIndex(note);
          // --- Attach validation_status (vault#555 fix 3) ---
          // Mirrors create/update-note's `attachValidationStatus` — additive,
          // present only when at least one tag on the note declares
          // `fields`. Before this, `validation_status` (including an
          // `enum_mismatch` on a non-strict indexed field) was surfaced ONLY
          // on the one-time create/update WRITE response; a caller reading
          // the note back via `query-notes` (the natural way to re-check a
          // value after write) saw nothing at all — contradicting the
          // documented "advisory violations surface as warnings" for every
          // read after the initial write.
          {
            const status = store.validateNoteAgainstSchemas({
              path: note.path,
              tags: note.tags,
              metadata: note.metadata as Record<string, unknown> | undefined,
            });
            if (status) result.validation_status = status;
          }
          if (expandCtx && includeContent && typeof result.content === "string") {
            // Mark the top-level note as already expanded so it can't recursively inline itself.
            expandCtx.expanded.add(note.id);
            result.content = expandContent(result.content, expandCtx, expandDepth);
          }
          // Range applies to the FINAL returned content — after wikilink
          // expansion — so the window the client pages through is the same
          // document it would have received unpaged.
          if (contentRange && includeContent) applyContentRange(result, contentRange);
          result = filterMetadata(result, params.include_metadata as boolean | string[] | undefined);
          if (params.include_links) {
            result.links = linkOps.getLinksHydrated(db, note.id);
          }
          if (params.include_broken_links) {
            result.broken_links = getUnresolvedLinksForNote(db, note.id);
          }
          if (params.include_attachments) {
            result.attachments = await store.getAttachments(note.id);
          }
          // linkCount injected after filterMetadata on purpose — same as
          // links/attachments above; filterMetadata only touches `metadata`.
          if (params.include_link_count) {
            const dir = normalizeLinkCountDirection(params.link_count_direction);
            result.linkCount = linkOps.getLinkCounts(db, [note.id], dir).get(note.id) ?? 0;
          }
          return result;
        }

        // --- Build near-scope (graph-filtered set of allowed IDs) ---
        //
        // Tag-scope policy for `near[]` (vault#439 — hop-guard, symmetric with
        // find-path): when the session is tag-scoped the server injects a
        // `nearTraversable` predicate (mcp-tools.ts), and the BFS refuses to
        // walk THROUGH out-of-scope notes — scope is a wall, not a sieve. So a
        // token scoped to ["work"] can't reach an in-scope note at depth 2 via
        // a #personal intermediary at depth 1. Core stays scope-unaware: it
        // only invokes the injected closure. Unscoped sessions pass no
        // predicate → the FULL graph is walked exactly as before. The
        // `applyTagScopeWrappers` result-filter still runs afterward (defense
        // in depth), but the wall makes it redundant for `near[]`.
        let nearScope: Set<string> | null = null;
        if (params.near) {
          const near = params.near as { note_id: string; depth?: number; relationship?: string };
          const anchor = resolveNote(db, near.note_id);
          if (!anchor) return { error: "Anchor note not found", error_type: "not_found", note_id: near.note_id };
          const depth = Math.min(near.depth ?? 2, 5);
          const traversed = linkOps.traverseLinks(db, anchor.id, {
            max_depth: depth,
            relationship: near.relationship,
            isTraversable: nearTraversable,
          });
          nearScope = new Set([anchor.id, ...traversed.map((t) => t.noteId)]);
        }

        // --- Cursor mode (vault#313) ---
        // When the caller passes `cursor`, the response shape switches to
        // `{notes, next_cursor}` and `queryNotesPaged` handles the keyset
        // pagination. Cursor mode is incompatible with full-text search
        // (FTS owns its own ordering — relevance, not updated_at) and
        // graph-neighborhood scoping (`near` would have to rebuild the
        // neighborhood every call to be cursor-stable; we punt for now).
        // Both surface as INVALID_QUERY rather than silently returning
        // wrong rows.
        // Presence, not truthiness (vault#550 bootstrap fix) — `cursor: ""`
        // is the bootstrap call ("I want to paginate, no watermark yet") and
        // must still engage cursor mode. Before this fix `"".length > 0` was
        // false, so the very first call could never obtain a `next_cursor`.
        const cursorMode = typeof params.cursor === "string";
        if (cursorMode && params.search) {
          throw new QueryError(
            `cursor is incompatible with full-text search — FTS has its own ordering. Use date_filter on updated_at for since-last-checked search.`,
            "INVALID_QUERY",
          );
        }
        if (cursorMode && params.near) {
          throw new QueryError(
            `cursor is incompatible with near (graph neighborhood). Resolve the neighborhood first, then iterate with cursor + ids.`,
            "INVALID_QUERY",
          );
        }
        if (cursorMode && params.semantic) {
          throw new QueryError(
            `cursor is incompatible with semantic search — ranking is by similarity, not a stable row order to page through.`,
            "INVALID_QUERY",
          );
        }
        // Tag-expansion axis (vault tag `expand` axis). Validate loudly so a
        // typo'd value doesn't silently fall back to the default.
        let expand: TagExpandMode | undefined;
        if (params.expand !== undefined && params.expand !== null) {
          if (typeof params.expand !== "string" || !(TAG_EXPAND_MODES as readonly string[]).includes(params.expand)) {
            throw new QueryError(
              `invalid \`expand\` value ${JSON.stringify(params.expand)} — must be one of ${TAG_EXPAND_MODES.map((m) => `"${m}"`).join(", ")}. Omit for the default ("subtypes").`,
              "INVALID_QUERY",
            );
          }
          expand = params.expand as TagExpandMode;
        }

        // --- Aggregation / rollup mode (top new-feature ask from a UX round) ---
        // Mutually exclusive with `search`/`near`/`cursor` — a rollup returns
        // one row per group, not a paginated / graph-scoped / ranked note
        // list — so reject those combos loudly before touching the DB.
        if (params.aggregate) {
          if (params.search) {
            throw new QueryError(
              `aggregate is incompatible with full-text search — pick one.`,
              "INVALID_QUERY",
              { error_type: "invalid_query", field: "aggregate", hint: "drop `search` when using `aggregate`" },
            );
          }
          if (params.near) {
            throw new QueryError(
              `aggregate is incompatible with near (graph neighborhood).`,
              "INVALID_QUERY",
              { error_type: "invalid_query", field: "aggregate", hint: "drop `near` when using `aggregate`" },
            );
          }
          if (typeof params.cursor === "string") {
            throw new QueryError(
              `aggregate is incompatible with cursor pagination — a rollup has no watermark to page through.`,
              "INVALID_QUERY",
              { error_type: "invalid_query", field: "aggregate", hint: "drop `cursor` when using `aggregate`" },
            );
          }
          if (params.semantic) {
            throw new QueryError(
              `aggregate is incompatible with semantic search — a rollup returns groups, not ranked notes.`,
              "INVALID_QUERY",
              { error_type: "invalid_query", field: "aggregate", hint: "drop `semantic`/`near_text` when using `aggregate`" },
            );
          }
          const aggRaw = params.aggregate as Record<string, unknown>;
          if (typeof aggRaw !== "object" || aggRaw === null || Array.isArray(aggRaw)) {
            throw new QueryError(
              `aggregate must be an object: {group_by, op, field?}`,
              "INVALID_QUERY",
              { error_type: "invalid_query", field: "aggregate", got: aggRaw },
            );
          }
          // Shape coercion only — `group_by`/`op`/`field` validity (indexed
          // field, numeric type, sum requires field, ...) is enforced by
          // `aggregateNotes` itself, reusing the exact FIELD_NOT_INDEXED /
          // INVALID_QUERY contract every other query surface uses.
          const aggregateSpec = {
            group_by: aggRaw.group_by as string,
            op: aggRaw.op as "count" | "sum",
            field: aggRaw.field as string | undefined,
          };
          const aggTags = normalizeTags(params.tag);
          const aggExcludeTagsRaw = params.exclude_tags ?? params.excludeTags ?? params.exclude_tag;
          const aggExcludeTags = normalizeTags(aggExcludeTagsRaw);
          const aggFilterOpts: QueryOpts = {
            tags: aggTags,
            tagMatch: (params.tag_match as "all" | "any") ?? (aggTags && aggTags.length > 1 ? "any" : undefined),
            expand,
            excludeTags: aggExcludeTags,
            hasTags: params.has_tags as boolean | undefined,
            hasLinks: params.has_links as boolean | undefined,
            hasBrokenLinks: params.has_broken_links as boolean | undefined,
            path: params.path as string | undefined,
            pathPrefix: params.path_prefix as string | undefined,
            extension: params.extension as string | string[] | undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
            createdBy: params.created_by as string | undefined,
            lastUpdatedBy: params.last_updated_by as string | undefined,
            createdVia: params.created_via as string | undefined,
            lastUpdatedVia: params.last_updated_via as string | undefined,
            dateFrom: params.date_from as string | undefined,
            dateTo: params.date_to as string | undefined,
            dateFilter: params.date_filter as
              | { field?: string; from?: string; to?: string }
              | undefined,
          };
          if (!aggregateVisibility) {
            return await store.aggregateNotes({ ...aggFilterOpts, aggregate: aggregateSpec });
          }
          // Tag-scoped: filter to visible notes FIRST — fetch every note the
          // OTHER filters match (unpaginated, same `limit: 1000000` "get
          // everything" convention `syncAllWikilinks` uses), narrow to what
          // the injected predicate accepts, THEN aggregate over just that id
          // set (reusing the `ids` semijoin `near` already pushes into SQL).
          // Core stays scope-unaware — it only invokes the plain closure.
          const aggAllMatches = await store.queryNotes({ ...aggFilterOpts, limit: 1000000 });
          const aggVisibleIds = aggAllMatches.filter(aggregateVisibility).map((n) => n.id);
          if (aggVisibleIds.length === 0) return [];
          return await store.aggregateNotes({ ids: aggVisibleIds, aggregate: aggregateSpec });
        }

        // `search_mode` (vault#551) — validate loudly (same policy as
        // `expand` above) so a typo'd value doesn't silently fall back to
        // the default. Resolved here (before the search/structured branch)
        // because BOTH branches need to know whether it was passed: the
        // search branch to select escaping behavior, the structured branch
        // to warn that it's being ignored.
        let searchMode: SearchMode | undefined;
        if (params.search_mode !== undefined && params.search_mode !== null) {
          if (typeof params.search_mode !== "string" || !isValidSearchMode(params.search_mode)) {
            throw new QueryError(
              `invalid \`search_mode\` value ${JSON.stringify(params.search_mode)} — must be one of ${SEARCH_MODES.map((m) => `"${m}"`).join(", ")}. Omit for the default ("literal").`,
              "INVALID_QUERY",
              {
                error_type: "invalid_query",
                field: "search_mode",
                got: params.search_mode,
                hint: `pass "literal" or "advanced", or omit for the default ("literal")`,
              },
            );
          }
          searchMode = params.search_mode;
        }

        // --- Full-text search ---
        let results: Note[];
        let nextCursor: string | null = null;
        // Warnings channel (vault#550). `search=` warnings (`empty_search`,
        // `ignored_param` for a stray `search_mode`) joined the channel at
        // #551 — the rest (`unknown_tag`) stays structured-query only.
        // Scope-unaware by design (see `core/src/query-warnings.ts` doc
        // comment) — a tag-scoped MCP session gets these stripped by the
        // `applyTagScopeWrappers` query-notes wrapper in `src/mcp-tools.ts`
        // before the result reaches the caller, so an out-of-scope tag name
        // never leaks via `did_you_mean`.
        let queryWarnings: QueryWarning[] = [];
        // `near_text` only does anything alongside `semantic: true` (mirrors
        // the `search_mode`-without-`search` ignored_param case above).
        if (params.near_text !== undefined && !params.semantic) {
          queryWarnings.push(
            ignoredParamWarning(
              "near_text",
              "`semantic: true` is required to activate near_text — pass both together",
            ),
          );
        }
        // --- Semantic search (EXPERIMENTAL — semantic search MVP) ---
        if (params.semantic) {
          if (params.search) {
            throw new QueryError(
              `semantic is incompatible with full-text search — pick one (semantic ranks by meaning via near_text; search ranks by keyword).`,
              "INVALID_QUERY",
              {
                error_type: "invalid_query",
                field: "semantic",
                hint: "drop `search` when using `semantic`, or drop `semantic`/`near_text` to use keyword search",
              },
            );
          }
          if (typeof params.near_text !== "string" || params.near_text.trim() === "") {
            throw new QueryError(
              `semantic: true requires \`near_text\` — the free text to rank notes by meaning.`,
              "INVALID_QUERY",
              {
                error_type: "invalid_query",
                field: "near_text",
                hint: `pass near_text: "..." alongside semantic: true`,
              },
            );
          }
          // `search_mode` only shapes `search` text parsing — a stray value
          // alongside `semantic` is almost certainly a leftover from a
          // keyword query, so flag it (same policy as the structured-query
          // branch below).
          if (searchMode !== undefined) {
            queryWarnings.push(
              ignoredParamWarning(
                "search_mode",
                "no `search` was provided — search_mode only affects full-text search query parsing",
              ),
            );
          }
          const tags = normalizeTags(params.tag);
          const excludeTagsRaw = params.exclude_tags ?? params.excludeTags ?? params.exclude_tag;
          const excludeTags = normalizeTags(excludeTagsRaw);
          const semanticOpts: QueryOpts = {
            tags,
            tagMatch: (params.tag_match as "all" | "any") ?? (tags && tags.length > 1 ? "any" : undefined),
            expand,
            excludeTags,
            hasTags: params.has_tags as boolean | undefined,
            hasLinks: params.has_links as boolean | undefined,
            hasBrokenLinks: params.has_broken_links as boolean | undefined,
            path: params.path as string | undefined,
            pathPrefix: params.path_prefix as string | undefined,
            extension: params.extension as string | string[] | undefined,
            // Same `near[]` neighborhood push-down `search`/structured-query
            // use — a semantic query can be scoped to a graph neighborhood too.
            ids: nearScope ? [...nearScope] : undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
            createdBy: params.created_by as string | undefined,
            lastUpdatedBy: params.last_updated_by as string | undefined,
            createdVia: params.created_via as string | undefined,
            lastUpdatedVia: params.last_updated_via as string | undefined,
            dateFrom: params.date_from as string | undefined,
            dateTo: params.date_to as string | undefined,
            dateFilter: params.date_filter as
              | { field?: string; from?: string; to?: string }
              | undefined,
            limit: (params.limit as number) ?? 50,
          };
          // Uncaught on purpose: `semantic_unavailable` (no/not-ready
          // provider) propagates to src/mcp-http.ts's QueryError → JSON-RPC
          // error mapping, same as `invalid_search_syntax` above — never a
          // silent fallback to keyword search.
          const semanticResult = await store.semanticSearch(params.near_text, semanticOpts);
          results = semanticResult.notes;
          if (semanticResult.pendingCount > 0) {
            queryWarnings.push(
              embeddingsPendingWarning(semanticResult.pendingCount, semanticResult.totalCandidates),
            );
          }
        } else if (params.search) {
          // `offset` under full-text search (vault contracts-brief V1.2):
          // `searchNotes` has no offset parameter at all — FTS5 ranks by
          // relevance, not a stable row order, so paging by offset over it
          // is unsound. Rather than silently return page 1 with no signal,
          // flag it. Presence check (`!== undefined`) so `offset: 0` — a
          // caller being explicit about "start" — still warns. The
          // structured-query branch (below) has real offset support and is
          // unaffected.
          if (params.offset !== undefined) {
            queryWarnings.push(
              ignoredParamWarning(
                "offset",
                "full-text search has no stable row order to offset into — results are always page 1, ranked by relevance",
              ),
            );
          }
          // Normalize tag param
          const tags = normalizeTags(params.tag);
          const excludeTagsRaw = params.exclude_tags ?? params.excludeTags ?? params.exclude_tag;
          const excludeTags = normalizeTags(excludeTagsRaw);
          const mode: SearchMode = searchMode ?? "literal";
          // "Only whitespace/quotes" (vault#551 edge case): short-circuit
          // BEFORE ever calling FTS5 — an empty/all-punctuation phrase can
          // be a syntax error (or a meaningless always-empty query)
          // depending on exactly how it degenerates, so this is checked
          // here rather than left to the DB layer to (maybe) reject.
          if (mode === "literal" && buildLiteralSearchQuery(params.search as string).isEmpty) {
            results = [];
            queryWarnings.push(emptySearchWarning());
          } else {
            // Route through `store.searchNotes` (not `noteOps.searchNotes`) so
            // tag-hierarchy expansion fires for MCP callers the same as for
            // HTTP REST callers — `tag: "manual"` matches descendants declared
            // via `_tags/*` config notes. Mirrors the structured-query fix
            // from #214; same class of bypass bug (tracked as #227). A
            // malformed advanced-mode query throws here (structured
            // `invalid_search_syntax`, vault#551) — uncaught on purpose, it
            // propagates to `src/mcp-http.ts`, which maps it to a JSON-RPC
            // error the same way it maps `invalid_query`.
            // vault#647: forward the same QueryOpts the structured /
            // semantic branches already pass. Pre-fix only tags/limit/
            // expand/mode/sort reached searchNotes, so exclude_tags and
            // date_from were silently dropped (a well-formed result set
            // answering a different question).
            results = await store.searchNotes(params.search as string, {
              tags,
              tagMatch: (params.tag_match as "all" | "any") ?? (tags && tags.length > 1 ? "any" : undefined),
              expand,
              excludeTags,
              hasTags: params.has_tags as boolean | undefined,
              hasLinks: params.has_links as boolean | undefined,
              hasBrokenLinks: params.has_broken_links as boolean | undefined,
              path: params.path as string | undefined,
              pathPrefix: params.path_prefix as string | undefined,
              extension: params.extension as string | string[] | undefined,
              ids: nearScope ? [...nearScope] : undefined,
              metadata: params.metadata as Record<string, unknown> | undefined,
              createdBy: params.created_by as string | undefined,
              lastUpdatedBy: params.last_updated_by as string | undefined,
              createdVia: params.created_via as string | undefined,
              lastUpdatedVia: params.last_updated_via as string | undefined,
              dateFrom: params.date_from as string | undefined,
              dateTo: params.date_to as string | undefined,
              dateFilter: params.date_filter as
                | { field?: string; from?: string; to?: string }
                | undefined,
              limit: (params.limit as number) ?? 50,
              mode,
              sort: params.sort as "asc" | "desc" | undefined,
            });
            // Zero-result `did_you_mean` (vault#551 WS2B) — cheap (a bounded
            // FTS5-vocabulary scan) and ONLY computed on the already-rare
            // empty-result path, mirroring `unknown_tag`'s did_you_mean.
            // Scope-unaware by construction (same as `collectUnknownTagWarnings`
            // above) — safe here because `applyTagScopeWrappers`'s
            // `query-notes` wrapper (`src/mcp-tools.ts`) strips the ENTIRE
            // `warnings` array for a tag-scoped session before it reaches the
            // caller, so this never leaks out-of-scope vocabulary to one.
            if (results.length === 0) {
              const suggestion = computeSearchDidYouMean(db, params.search as string);
              if (suggestion) {
                queryWarnings.push(searchDidYouMeanWarning(params.search as string, suggestion));
              }
            }
          }
        } else {
          // --- Structured query ---
          // `search_mode` only shapes how `search` text becomes an FTS5
          // query — passing it without `search` is almost always a mistake
          // (meant to pass `search` too), so flag it rather than silently
          // doing nothing with it.
          if (searchMode !== undefined) {
            queryWarnings.push(
              ignoredParamWarning(
                "search_mode",
                "no `search` was provided — search_mode only affects full-text search query parsing",
              ),
            );
          }
          const tags = normalizeTags(params.tag);
          // Accept canonical `exclude_tags` plus camelCase / singular aliases.
          // LLM callers frequently pick the wrong name (training-data drift
          // toward camelCase across MCP tools) and the JSON-RPC layer drops
          // unknown keys silently; aliasing here closes the silent-no-op gap.
          const excludeTagsRaw = params.exclude_tags ?? params.excludeTags ?? params.exclude_tag;
          const excludeTags = normalizeTags(excludeTagsRaw);
          // Route through `store.queryNotes`/`queryNotesPaged` (not the raw
          // `noteOps` exports) so tag-hierarchy expansion fires for MCP
          // callers the same as for HTTP REST callers — `tag: "manual"`
          // matches descendants declared via `_tags/*` config notes. The
          // previous direct-noteOps call bypassed the wrapper and silently
          // dropped hierarchy expansion.
          const queryOpts = {
            tags,
            tagMatch: (params.tag_match as "all" | "any") ?? (tags && tags.length > 1 ? "any" : undefined),
            expand,
            excludeTags,
            hasTags: params.has_tags as boolean | undefined,
            hasLinks: params.has_links as boolean | undefined,
            hasBrokenLinks: params.has_broken_links as boolean | undefined,
            path: params.path as string | undefined,
            pathPrefix: params.path_prefix as string | undefined,
            extension: params.extension as string | string[] | undefined,
            // Push the near-scope into the SQL WHERE so that LIMIT and ORDER
            // BY apply to the neighborhood. Without this, queryNotes would
            // fetch the first `limit` notes by created_at and then post-
            // filter to the few in-scope ones — which silently empties the
            // result whenever the neighborhood lies outside that prefix.
            ids: nearScope ? [...nearScope] : undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
            // Write-attribution filters (vault#298): "who wrote / via what."
            createdBy: params.created_by as string | undefined,
            lastUpdatedBy: params.last_updated_by as string | undefined,
            createdVia: params.created_via as string | undefined,
            lastUpdatedVia: params.last_updated_via as string | undefined,
            dateFrom: params.date_from as string | undefined,
            dateTo: params.date_to as string | undefined,
            dateFilter: params.date_filter as
              | { field?: string; from?: string; to?: string }
              | undefined,
            sort: params.sort as "asc" | "desc" | undefined,
            orderBy: params.order_by as string | undefined,
            limit: (params.limit as number) ?? 50,
            offset: params.offset as number | undefined,
            cursor: cursorMode ? (params.cursor as string) : undefined,
          };
          // Concatenate (not overwrite) — `queryWarnings` may already carry
          // the `ignored_param` warning for a stray `search_mode` pushed
          // above (vault#551).
          queryWarnings = queryWarnings.concat(
            collectUnknownTagWarnings(db, queryOpts.tags, queryOpts.expand, store.getTagHierarchy()),
          );
          if (cursorMode) {
            const page = await store.queryNotesPaged(queryOpts);
            results = page.notes;
            nextCursor = page.next_cursor;
          } else {
            results = await store.queryNotes(queryOpts);
            // Truncation-honesty (vault contracts-brief V1.3): no cursor was
            // requested, so `next_cursor` never surfaces as an honest
            // "more may follow" signal — this is that signal. Mirrors the
            // REST structured-query path in src/routes.ts.
            if (results.length === queryOpts.limit) {
              queryWarnings.push(truncatedResultsWarning(queryOpts.limit));
            }
          }
        }

        // For full-text search the post-filter is still the right shape — FTS
        // owns its own ranked LIMIT and we just narrow to the neighborhood
        // afterwards. Structured queries already pushed `ids` into SQL above.
        if (nearScope && params.search) {
          results = results.filter((n) => nearScope!.has(n.id));
        }

        // --- Format output ---
        const includeContent = params.include_content === true; // default false for list
        // Range params require content in the response — on lists that
        // means an explicit include_content=true (the lean default carries
        // no content to slice). Error rather than silently ignore.
        if (contentRange && !includeContent) throw contentRangeRequiresContent();
        const includeMetadata = params.include_metadata as boolean | string[] | undefined;
        let output: any[] = includeContent ? results.map((n) => ({ ...n })) : results.map(noteOps.toNoteIndex);

        // --- Expand wikilinks inline (only meaningful when content is present) ---
        if (expandCtx && includeContent) {
          // Mark all top-level notes as already expanded so they can't inline each other.
          for (const n of output) expandCtx.expanded.add(n.id);
          for (const n of output) {
            if (typeof n.content === "string") {
              n.content = expandContent(n.content, expandCtx, expandDepth);
            }
          }
        }

        // --- Content range (per-note, post-expansion) ---
        // The same byte window applies to EACH note's content independently
        // — the primary use is a single large note, but list mode keeps the
        // simple per-note semantic (every note reports its own
        // content_total_length / content_next_offset).
        if (contentRange && includeContent) {
          for (const n of output) applyContentRange(n, contentRange);
        }

        // --- Attach validation_status (vault#555 fix 3) ---
        // Same reasoning as the single-note path above — additive, present
        // only when at least one tag on the note declares `fields`. Runs
        // BEFORE metadata filtering so it sees the note's full metadata
        // regardless of `include_metadata`; the `validation_status` key
        // itself survives `filterMetadata` (which only touches `metadata`).
        {
          const statusById = new Map(
            results.map((n) => [
              n.id,
              store.validateNoteAgainstSchemas({
                path: n.path,
                tags: n.tags,
                metadata: n.metadata as Record<string, unknown> | undefined,
              }),
            ]),
          );
          for (const n of output as any[]) {
            const status = statusById.get(n.id);
            if (status) n.validation_status = status;
          }
        }

        // --- Apply metadata filtering ---
        if (includeMetadata !== undefined && includeMetadata !== true) {
          output = output.map((n: any) => filterMetadata(n, includeMetadata));
        }

        // --- Opt-in link degree (vault feedback #4) ---
        // ONE batch count over all result ids (NOT per-note), so the field
        // stays O(2 index scans) per request regardless of page size.
        // Injected on the same objects the enrichment loop copies below.
        // Ordering: runs AFTER the filterMetadata pass above on purpose —
        // filterMetadata only touches the `metadata` key, so linkCount
        // survives. Don't casually swap the order.
        if (params.include_link_count) {
          const dir = normalizeLinkCountDirection(params.link_count_direction);
          const counts = linkOps.getLinkCounts(db, output.map((n: any) => n.id), dir);
          for (const n of output) n.linkCount = counts.get(n.id) ?? 0;
        }

        // --- Hydrate links/attachments/broken-links per note if requested ---
        if (params.include_links || params.include_attachments || params.include_broken_links) {
          // Links hydrate for the WHOLE page in a constant number of
          // queries (see getLinksHydratedForNotes) — the per-note variant
          // cost (1 link query + 1 summary query + N tag queries) × page
          // size. 2026-06-10 perf measurements.
          const linksByNote = params.include_links
            ? linkOps.getLinksHydratedForNotes(db, (output as any[]).map((n: any) => n.id))
            : null;
          // Same one-batched-query-for-the-page shape as links (vault#555).
          const brokenLinksByNote = params.include_broken_links
            ? getUnresolvedLinksForNotes(db, (output as any[]).map((n: any) => n.id))
            : null;
          const enrichedOut: any[] = [];
          for (const n of output as any[]) {
            const enriched: any = { ...n };
            if (linksByNote) enriched.links = linksByNote.get(n.id) ?? [];
            if (brokenLinksByNote) enriched.broken_links = brokenLinksByNote.get(n.id) ?? [];
            if (params.include_attachments) enriched.attachments = await store.getAttachments(n.id);
            enrichedOut.push(enriched);
          }
          // Cursor mode wraps the list in `{notes, next_cursor}` so callers can
          // chain calls without tracking a watermark client-side. Legacy
          // callers (no `cursor` param, no warnings) still get the flat
          // array (vault#550 — warnings channel is additive, never forces
          // the envelope on its own outside cursor mode... except when
          // there ARE warnings, in which case the envelope is the only way
          // to attach them).
          if (cursorMode) {
            return {
              notes: enrichedOut,
              next_cursor: nextCursor,
              ...(queryWarnings.length > 0 ? { warnings: queryWarnings } : {}),
            };
          }
          return queryWarnings.length > 0 ? { notes: enrichedOut, warnings: queryWarnings } : enrichedOut;
        }

        if (cursorMode) {
          return {
            notes: output,
            next_cursor: nextCursor,
            ...(queryWarnings.length > 0 ? { warnings: queryWarnings } : {}),
          };
        }
        return queryWarnings.length > 0 ? { notes: output, warnings: queryWarnings } : output;
      },
    },

    // =====================================================================
    // 2. create-note — single or batch
    // =====================================================================
    {
      name: "create-note",
      execute: async (params) => {
        const batch = params.notes as any[] | undefined;
        const items = batch ?? [params];

        if (items.length > MAX_BATCH_SIZE) {
          throw new BatchTooLargeError(items.length);
        }

        const created: Note[] = [];
        // Structured `links` are resolved in a SECOND pass, after every
        // note in this batch has been created (vault#555) — resolving
        // inline (the old behavior) meant a link from item 0 to item 1's
        // path silently dropped, since item 1 didn't exist yet at the
        // moment item 0's links were processed. Deferring makes
        // within-batch forward-refs resolve exactly like a same-content
        // [[wikilink]] already does. `pendingLinks` carries the SOURCE
        // note id (known immediately — createNote assigns it synchronously,
        // and so does the `if_exists` existing-note branch below) alongside
        // each item's raw `links` array.
        const pendingLinks: { sourceId: string; links: { target: string; relationship: string }[] }[] = [];
        // Per-note `unresolved_link` warnings (vault#555 — "never silent").
        // Populated in the second pass; folded into each note's response
        // below, same pattern as `validation_status`.
        const linkWarningsByNote = new Map<string, QueryWarning[]>();
        const pushLinkWarning = (noteId: string, warning: QueryWarning): void => {
          const list = linkWarningsByNote.get(noteId) ?? [];
          list.push(warning);
          linkWarningsByNote.set(noteId, list);
        };
        // Content wikilinks whose note+content pair needs an `unresolved_link`/
        // `ambiguous_link` warning check (vault#570). Deferred to the same
        // second pass as `pendingLinks` — a content `[[wikilink]]` to a
        // sibling created LATER in this batch resolves via the same
        // forward-ref backfill structured `links` use, so the classification
        // must run only after every item in the batch exists.
        const contentWikilinkNotes: { noteId: string; content: string }[] = [];
        // `if_exists` bookkeeping (vault#555). `existedMap` is set ONLY for
        // items whose `if_exists` engaged (ignore/update/replace) — absent
        // means the default "error" path ran, so a plain create-note call
        // sees zero response-shape change. `true` = the path already named
        // a note and that branch fired; `false` = if_exists was set but no
        // conflict occurred (a normal fresh insert). `noMutateIds` marks
        // "ignore" hits so the schema-defaults pass below skips them
        // entirely — "ignore" promises NO mutation, including backfill.
        const existedMap = new Map<string, boolean>();
        const noMutateIds = new Set<string>();
        /** Record an `if_exists` collision outcome — shared by both call sites below. */
        const recordExistedBranch = (resultNote: Note, noMutate: boolean): void => {
          existedMap.set(resultNote.id, true);
          if (noMutate) noMutateIds.add(resultNote.id);
          created.push(resultNote);
        };

        /**
         * Handle an `if_exists` collision against an already-resolved
         * `existingNote` — shared by the proactive pre-check (the common,
         * non-racing path) and the insert-time PathConflictError catch
         * (the race-closing backstop: a concurrent writer's INSERT
         * committed between our check and ours). Returns the note to put
         * in the response and whether it must be excluded from the
         * schema-defaults mutation pass ("ignore" — genuinely untouched).
         */
        const applyExistingNote = async (
          item: any,
          existingNote: Note,
          mode: "ignore" | "update" | "replace",
        ): Promise<{ note: Note; noMutate: boolean }> => {
          // CRITICAL scope guard (vault#555 auth-review must-fix). `existingNote`
          // was resolved VAULT-WIDE by path (getNoteByPath) at whichever call
          // site reached here — the proactive check OR the concurrent-INSERT
          // race backstop. A tag-scoped MCP session injects `ifExistsVisible`
          // (see GenerateMcpToolsOpts); when the resolved note fails it, the
          // caller must not read (ignore) / update / replace an out-of-scope
          // note it named only by path — throw PathConflictError (path taken,
          // invisible to this caller) BEFORE any read or mutation, so no
          // content leaks and nothing is written. Placing it HERE — not only in
          // the server-layer wrapper's pre-check — is what closes the
          // race-backstop TOCTOU: the pre-check + core's proactive check can
          // BOTH miss a note a concurrent writer then INSERTs, and the backstop
          // re-resolves it into this exact call. Core stays scope-unaware: it
          // only invokes the injected closure. Unscoped/internal callers pass no
          // predicate → unchanged behavior.
          if (ifExistsVisible && !ifExistsVisible(existingNote)) {
            throw new noteOps.PathConflictError(existingNote.path ?? "");
          }
          if (mode === "ignore") {
            // No error, no mutation of any kind — not even schema-default
            // backfill. Return the existing note exactly as stored.
            return { note: existingNote, noMutate: true };
          }

          // "update" / "replace" both apply tags/links additively (union) —
          // they differ only in how content/metadata combine with the
          // existing values. See the tool description for the full contract.
          const updates: { content?: string; metadata?: Record<string, unknown> } = {};
          if (mode === "update") {
            if (item.content !== undefined) updates.content = item.content as string;
            if (item.metadata !== undefined) {
              updates.metadata = noteOps.mergeMetadata(
                existingNote.metadata as Record<string, unknown> | null | undefined,
                item.metadata as Record<string, unknown>,
              );
            }
          } else {
            // "replace" — PUT semantics: content/metadata become exactly
            // this payload (empty default when omitted), never merged.
            updates.content = (item.content as string | undefined) ?? "";
            updates.metadata = (item.metadata as Record<string, unknown> | undefined) ?? {};
          }

          const incomingTags = (item.tags as string[] | undefined) ?? [];
          const projectedTags = new Set<string>([...(existingNote.tags ?? []), ...incomingTags]);
          const projectedMetadata =
            updates.metadata ?? ((existingNote.metadata as Record<string, unknown>) ?? {});
          // Strict-schema gate (vault#299) against the PROJECTED final shape
          // (existing ∪ incoming), not the raw incoming item — a caller
          // updating one field of an already-conforming note shouldn't have
          // to re-supply every `required` field just to pass validation.
          enforceStrict({ path: existingNote.path, tags: [...projectedTags], metadata: projectedMetadata });

          // vault#555 fix 2 (W8 fix-2 bug class, generalist must-fix): a
          // tags-only or links-only "update" leaves `updates` empty, so
          // gating store.updateNote on `updates` ALONE would skip it — and
          // then a genuine tag/link mutation (store.tagNote below) would never
          // bump `updated_at`, breaking cursor polling (`ORDER BY updated_at`)
          // and any since-last-check sync. Gate on the tag/link mutation too,
          // mirroring the update-note/PATCH path's hasTagMutation||hasLinkMutation.
          // store.updateNote with empty core fields still issues a real UPDATE
          // that bumps updated_at (+ last_updated_by/via). "replace" always
          // sets content+metadata, so it was never affected.
          const hasLinkMutation = item.links !== undefined;
          let result: Note = existingNote;
          if (Object.keys(updates).length > 0 || incomingTags.length > 0 || hasLinkMutation) {
            result = await store.updateNote(existingNote.id, {
              ...updates,
              actor: writeActor,
              via: writeVia,
              // `tagsForSchemaResolution` (vault#date-field-type review round
              // 2) — same bug/fix as the update-note handler: `store.tagNote`
              // below runs AFTER this UPDATE, so without the PROJECTED tag
              // set here, `date`-field normalization inside store.updateNote
              // would miss a field newly declared by an incoming tag.
              tagsForSchemaResolution: [...projectedTags],
            });
          }

          // Content-wikilink warnings (vault#570) — this branch's content
          // update (if any) already ran `syncWikilinks` inside
          // `store.updateNote` above; queue the (noteId, content) pair for
          // the shared second-pass classification below (same treatment as
          // a fresh create's content).
          if (updates.content !== undefined) {
            contentWikilinkNotes.push({ noteId: result.id, content: updates.content });
          }

          if (incomingTags.length > 0) {
            await store.tagNote(result.id, incomingTags);
            // Note: applySchemaDefaults also runs in the outer batch loop for
            // this note (it's not in `noMutateIds` — only "ignore" hits are),
            // so this inline call is redundant. Harmless (idempotent — fills
            // only still-missing fields), kept so the update/replace branch is
            // self-contained; left un-gated to avoid coupling to the outer loop.
            await applySchemaDefaults(store, db, [result.id], incomingTags);
          }

          if (item.links) {
            pendingLinks.push({ sourceId: result.id, links: item.links as { target: string; relationship: string }[] });
          }

          return { note: noteOps.getNote(db, result.id) ?? result, noMutate: false };
        };

        // Wrap multi-item batches in a SQLite transaction so a mid-batch
        // failure rolls back every prior insert — see #236. This guards
        // anything thrown from store.createNote / createLink (path
        // conflict, etc.). Single-item calls skip the wrap to avoid
        // colliding with concurrent callers on the shared bun:sqlite
        // connection. Catching a PathConflictError INSIDE this callback
        // (the if_exists race backstop below) does NOT roll back the
        // transaction — only a throw that escapes `runBatch` does (see
        // core/src/txn.ts) — so the fallback-to-existing-note path commits
        // normally alongside every other item in the batch.
        const batched = items.length > 1;
        const runBatch = async (): Promise<void> => {
          for (const item of items) {
            // Validate extension up front (vault#328). Throwing here while
            // inside the batch transaction rolls it back — the same behavior
            // as a path conflict mid-batch.
            const extension = item.extension !== undefined
              ? validateExtension(item.extension)
              : undefined;
            // Reject NUL / `..` paths at the write surface (vault#589 / FIX 2).
            // Throws inside the batch transaction — rolls it back, same as a
            // path conflict; mcp-http's generic error_type mapping → clean 400.
            validatePath(item.path);
            const effectiveExtension = extension ?? "md";
            const ifExists = (item.if_exists as string | undefined) ?? "error";
            const upsertMode = ifExists === "ignore" || ifExists === "update" || ifExists === "replace";

            // Proactive existence check (vault#555) — only possible when a
            // path is set (a pathless create can never conflict). Handles
            // the common, non-racing case cleanly: skip the raw-item strict
            // gate entirely (it would validate the wrong shape — see
            // `applyExistingNote`) and go straight to the ignore/update/
            // replace branch. The insert-time catch below is the backstop
            // for the rare true race.
            let existingNote: Note | null = null;
            if (upsertMode && item.path) {
              const normalized = normalizePath(item.path as string);
              existingNote = normalized ? noteOps.getNoteByPath(db, normalized, effectiveExtension) : null;
            }
            if (existingNote) {
              const { note: resultNote, noMutate } = await applyExistingNote(item, existingNote, ifExists as "ignore" | "update" | "replace");
              recordExistedBranch(resultNote, noMutate);
              continue;
            }

            // Strict-schema gate (vault#299) — reject before any write so a
            // mid-batch violation rolls back the batch transaction.
            enforceStrict({
              path: item.path as string | undefined,
              tags: item.tags as string[] | undefined,
              metadata: item.metadata as Record<string, unknown> | undefined,
            });
            let note: Note;
            try {
              note = await store.createNote(item.content as string ?? "", {
                path: item.path as string | undefined,
                tags: item.tags as string[] | undefined,
                metadata: item.metadata as Record<string, unknown> | undefined,
                created_at: item.created_at as string | undefined,
                ...(extension !== undefined ? { extension } : {}),
                // Write-attribution (vault#298) — same actor/via for every item
                // in a batch (the whole call came from one authenticated session).
                actor: writeActor,
                via: writeVia,
              });
            } catch (err) {
              // Race backstop (vault#555): a concurrent writer's INSERT
              // committed between our proactive check (skipped or missed
              // above) and this one. Re-resolve the now-existing row and
              // fall through to the SAME branch a proactive hit would have
              // taken — closes the create-race gap even under true
              // concurrency, not just the sequential common case.
              if (upsertMode && err instanceof noteOps.PathConflictError) {
                const winner = noteOps.getNoteByPath(db, err.path, effectiveExtension);
                if (winner) {
                  const { note: resultNote, noMutate } = await applyExistingNote(item, winner, ifExists as "ignore" | "update" | "replace");
                  recordExistedBranch(resultNote, noMutate);
                  continue;
                }
              }
              throw err;
            }

            if (upsertMode) existedMap.set(note.id, false);

            if (item.links) {
              pendingLinks.push({ sourceId: note.id, links: item.links as { target: string; relationship: string }[] });
            }

            // Content-wikilink warnings (vault#570) — `store.createNote`
            // above already ran `syncWikilinks` (gated on `content` truthy,
            // same condition here) — queue for the shared second-pass
            // classification below.
            if (item.content) {
              contentWikilinkNotes.push({ noteId: note.id, content: item.content as string });
            }

            created.push(noteOps.getNote(db, note.id) ?? note);
          }

          // --- Resolve structured links (vault#555) ---
          // Same semantics as [[wikilinks]]: ID or path/title match, tried
          // now that every sibling note in this batch exists. A target that
          // STILL doesn't resolve (typo, or a note that arrives in a later
          // call) is queued for lazy resolution — it backfills automatically
          // the moment a matching note is created — and surfaces an
          // `unresolved_link` warning naming the target. A target that
          // matched ≥2 notes (vault#570) is neither linked nor queued —
          // surfaces a distinct `ambiguous_link` warning instead. Never silent.
          for (const { sourceId, links } of pendingLinks) {
            for (const link of links) {
              const outcome = resolveOrQueueLink(db, sourceId, link.target, link.relationship);
              if (outcome.status === "resolved") {
                await store.createLink(sourceId, outcome.note_id, link.relationship);
              } else if (outcome.status === "ambiguous") {
                pushLinkWarning(sourceId, {
                  code: "ambiguous_link",
                  message: `link target "${link.target}" (relationship "${link.relationship}") matched ${outcome.candidates.length} notes — ambiguous, no link created. Use a more specific path or the note's ID to disambiguate.`,
                  target: link.target,
                  relationship: link.relationship,
                  candidate_count: outcome.candidates.length,
                });
              } else {
                pushLinkWarning(sourceId, {
                  code: "unresolved_link",
                  message: `link target "${link.target}" (relationship "${link.relationship}") did not resolve to any note — queued and will backfill automatically if a matching note is created later.`,
                  target: link.target,
                  relationship: link.relationship,
                });
              }
            }
          }

          // --- Content-wikilink warnings (vault#570) ---
          // Same forward-ref-aware timing as the structured-links pass above
          // — every sibling in this batch exists by now, so a content
          // `[[wikilink]]` to a later batch item already resolved via the
          // pending-wikilink backfill (`resolveUnresolvedWikilinks`, run
          // inside each `store.createNote`/`updateNote` call above).
          for (const { noteId, content } of contentWikilinkNotes) {
            for (const warning of getContentWikilinkWarnings(db, noteId, content)) {
              pushLinkWarning(noteId, warning);
            }
          }
        };
        await (batched ? transactionAsync(db, runBatch) : runBatch());

        // Apply tag schema effects, then re-read the notes whose metadata was
        // actually default-filled so the response reflects the final on-disk
        // state (the `created` entries were read before `applySchemaDefaults`
        // ran, so default-filled metadata isn't on them yet). This mirrors the
        // update-note path, which already re-reads post-defaults. The re-read
        // is batched (`getNotes` = one `WHERE id IN (...)`) and skipped
        // entirely when no defaults were applied, so the common no-defaults
        // path adds zero extra reads. `noMutateIds` ("ignore" hits) are
        // skipped entirely — "ignore" promises zero mutation, including
        // backfill of a since-added default the existing note predates.
        const mutatedIds = new Set<string>();
        for (const note of created) {
          if (noMutateIds.has(note.id)) continue;
          if (note.tags && note.tags.length > 0) {
            for (const id of await applySchemaDefaults(store, db, [note.id], note.tags)) {
              mutatedIds.add(id);
            }
          }
        }
        const refreshed =
          mutatedIds.size === 0
            ? created
            : (() => {
                const byId = new Map(
                  noteOps.getNotes(db, [...mutatedIds]).map((n) => [n.id, n]),
                );
                return created.map((n) => byId.get(n.id) ?? n);
              })();

        // Attach `validation_status` from any tag's `fields` declaration that
        // applies to this note, against the post-defaults state. Fold in any
        // `unresolved_link` warnings collected above (vault#555) — additive,
        // present only when this note's `links` had a target that didn't
        // resolve. `existed` (vault#555) is attached ONLY for items whose
        // `if_exists` actually engaged — the default "error" path's response
        // shape is untouched.
        const final = refreshed.map((n) => {
          const validated = attachValidationStatus(store, db, n);
          const warnings = linkWarningsByNote.get(n.id);
          const existed = existedMap.get(n.id);
          let out: Note & { warnings?: QueryWarning[]; existed?: boolean } = validated;
          if (warnings && warnings.length > 0) out = { ...out, warnings };
          if (existed !== undefined) out = { ...out, existed };
          return out;
        });

        // Batch summary (vault#555) — compact shape instead of N full note
        // objects. Batch-only (a `notes` array); `summary` is ignored on a
        // single-note call, matching `if_exists`'s per-item batch scoping.
        if (batch && params.summary === true) {
          return {
            created: final.filter((n: any) => n.existed !== true).length,
            ids: final.map((n) => n.id),
            // Reserved for future partial-batch-failure reporting — a batch
            // create is all-or-nothing today (see the tool description), so
            // this is always empty.
            failed: [] as unknown[],
          };
        }

        return batch ? final : final[0];
      },
    },

    // =====================================================================
    // 3. update-note — single or batch, absorbs tag/untag + link add/remove
    // =====================================================================
    {
      name: "update-note",
      execute: async (params) => {
        const batch = params.notes as any[] | undefined;
        // vault#554: top-level `force` / `if_updated_at` apply as per-item
        // DEFAULTS in a batch call — item-level values win when both are
        // present. Before this fix `items = batch ?? [params]` never merged
        // the top-level fields into batch items at all, so a caller passing
        // `{force: true, notes: [...]}` had it silently ignored: every item
        // without its OWN `force`/`if_updated_at` still threw
        // `PreconditionRequiredError` (a gardener-reported round-trip cost).
        // The single-item form (`items = [params]`) already behaved this
        // way implicitly (params IS the item), so only the batch branch
        // needs the merge.
        const items = batch
          ? batch.map((item: any) => ({
              ...(params.force !== undefined ? { force: params.force } : {}),
              ...(params.if_updated_at !== undefined ? { if_updated_at: params.if_updated_at } : {}),
              ...item,
            }))
          : [params];

        if (items.length > MAX_BATCH_SIZE) {
          throw new BatchTooLargeError(items.length);
        }

        const updated: Note[] = [];
        // Track which note IDs were freshly created via `if_missing: "create"`
        // so the response can carry `created: true|false` per-note. The
        // sync-loop caller (Gitcoin Brain et al) reads this to know which
        // path fired without doing a separate query. vault#309.
        const createdIds = new Set<string>();
        // Track which note IDs should echo hydrated links on the response.
        // A note qualifies when this request mutated its links
        // (`links.add`/`links.remove`) OR the caller set `include_links`.
        // vault feedback #8 — previously the update response omitted links
        // entirely, forcing a re-query just to confirm a link the caller had
        // just added/removed. Per-item on batch. Note IDs (not item indices)
        // key this so the create-on-missing branch, which assigns the id
        // late, can register correctly.
        const echoLinkIds = new Set<string>();
        // Structured `links.add` entries, deferred to a second pass AFTER
        // every item in this batch has been created/updated (vault#555) —
        // resolving inline would silently drop a link from item 0 to a note
        // item 1 (later in the same batch) creates via `if_missing:
        // "create"`. Same fix as create-note's `pendingLinks`.
        const pendingLinks: { sourceId: string; links: { target: string; relationship: string; metadata?: Record<string, unknown> }[] }[] = [];
        // Per-note `unresolved_link` warnings (vault#555 — "never silent").
        const linkWarningsByNote = new Map<string, QueryWarning[]>();
        const pushLinkWarning = (noteId: string, warning: QueryWarning): void => {
          const list = linkWarningsByNote.get(noteId) ?? [];
          list.push(warning);
          linkWarningsByNote.set(noteId, list);
        };
        // Content wikilinks whose note+content pair needs an `unresolved_link`/
        // `ambiguous_link` warning check (vault#570) — deferred to the same
        // second pass as `pendingLinks` for the same forward-ref-within-batch
        // reason.
        const contentWikilinkNotes: { noteId: string; content: string }[] = [];
        // Wrap multi-item batches in a SQLite transaction so any mid-batch
        // failure (precondition error, content_edit miss, ConflictError, …)
        // rolls back every prior mutation in the batch — see #236.
        // Single-item calls skip the wrap so concurrent callers don't
        // collide on the shared bun:sqlite connection.
        const batched = items.length > 1;
        const runBatch = async (): Promise<void> => {
          for (const item of items) {
            // Try ID-then-path resolve. If not found AND
            // `if_missing: "create"` is set, fall through to the create
            // branch using this same item's payload. Otherwise mirror the
            // existing `requireNote` behavior (throw "Note not found").
            // vault#309.
            const resolved = resolveNote(db, item.id as string);
            if (!resolved) {
              if (item.if_missing === "create") {
                // Treat the update payload as a create payload. Minimum:
                // content OR a path/id (something the createNote-empty-row
                // invariant accepts). createNote enforces its own
                // not-both-empty check — we leave that to the Store and
                // surface any error to the caller verbatim.
                //
                // Field mapping (mirrors the create-note tool surface):
                //   - `item.id` → both the note's `id` AND a fallback
                //     `path` when `item.path` isn't set. Treating `id` as
                //     the path-or-id lookup key matches Gitcoin's nightly
                //     sync shape where the canonical key is a path string
                //     like "Inbox/2026-05-13-meeting". If the caller
                //     supplied an opaque ULID as `id` and no `path`, we
                //     still create with that as `id` (path stays null).
                //   - `item.content` / `item.path` / `item.tags` /
                //     `item.metadata` / `item.created_at` → forwarded.
                //   - `if_updated_at` / `force` / `content_edit` /
                //     `append` / `prepend` are update-only — silently
                //     ignored on the create branch. (Content-edit on a
                //     non-existent note is a nonsense combination; the
                //     caller's intent on missing-note is "create the
                //     row", not "patch in this section".)
                //   - `links.remove` is also ignored on create (nothing
                //     to remove on a fresh note).
                //   - `links.add` IS applied below — the drift sync can
                //     declare typed links at upsert time and have them
                //     materialize alongside the create. See vault#320
                //     reviewer F1 — the prior comment claimed all
                //     `links` were ignored, but `links.add` was already
                //     processed and used by Gitcoin's sync; the
                //     misleading wording is fixed here so a future
                //     reader doesn't trust it and break the workflow.
                const idOrPath = item.id as string;
                // Heuristic: if `path` isn't set AND the `id` looks like a
                // path (contains "/" or doesn't match a typical opaque-id
                // shape), use it as the path too. Otherwise treat it as a
                // pure id. The shared `id` field for update is ID-or-path
                // already (see `resolveNote`), so this preserves the
                // caller's intent.
                const idLooksLikePath = idOrPath.includes("/") || !/^[A-Za-z0-9_-]+$/.test(idOrPath);
                const explicitPath = typeof item.path === "string" ? item.path as string : undefined;
                // Validate extension before reaching the Store — same
                // contract as the create-note tool.
                const createExt = item.extension !== undefined
                  ? validateExtension(item.extension)
                  : undefined;
                // Reject NUL / `..` paths at the write surface (vault#589 / FIX 2).
                validatePath(explicitPath ?? (idLooksLikePath ? idOrPath : undefined));
                const createOpts: Parameters<Store["createNote"]>[1] = {
                  ...(idLooksLikePath ? { path: explicitPath ?? idOrPath } : { id: idOrPath, ...(explicitPath !== undefined ? { path: explicitPath } : {}) }),
                  ...(item.tags && Array.isArray((item.tags as any).add)
                    ? { tags: (item.tags as any).add as string[] }
                    : Array.isArray(item.tags)
                      ? { tags: item.tags as string[] }
                      : {}),
                  ...(item.metadata !== undefined ? { metadata: item.metadata as Record<string, unknown> } : {}),
                  ...(item.created_at !== undefined ? { created_at: item.created_at as string } : {}),
                  ...(createExt !== undefined ? { extension: createExt } : {}),
                  // Write-attribution (vault#298) — the if_missing:"create" upsert
                  // branch is still a CREATE, so it must stamp the same actor/via
                  // as the create-note tool + the REST upsert-create path. Without
                  // this an MCP-driven upsert-create wrote NULL attribution.
                  actor: writeActor,
                  via: writeVia,
                };
                const content = (item.content as string | undefined) ?? "";
                // Strict-schema gate (vault#299) — the if_missing:"create"
                // branch is still a create, so it enforces too. Tags come from
                // createOpts (already normalized from the {add} dict / array).
                enforceStrict({
                  path: createOpts.path ?? undefined,
                  tags: createOpts.tags,
                  metadata: createOpts.metadata,
                });
                const created = await store.createNote(content, createOpts);
                await applySchemaDefaults(store, db, [created.id], created.tags ?? []);
                // Defer links.add resolution to the second pass (vault#555)
                // — same reasoning as create-note.
                const linksAdd = (item.links as any)?.add as { target: string; relationship: string; metadata?: Record<string, unknown> }[] | undefined;
                if (linksAdd) {
                  pendingLinks.push({ sourceId: created.id, links: linksAdd });
                }
                // Content-wikilink warnings (vault#570) — same deferral as
                // create-note's fresh-create branch.
                if (content) {
                  contentWikilinkNotes.push({ noteId: created.id, content });
                }
                const fresh = noteOps.getNote(db, created.id) ?? created;
                updated.push(fresh);
                createdIds.add(fresh.id);
                // Echo links if this create-on-missing declared `links.add`
                // (the only link op honored on create) or asked explicitly.
                if (linksAdd !== undefined || item.include_links === true) {
                  echoLinkIds.add(fresh.id);
                }
                continue;
              }
              // Fallthrough: not-found + no if_missing → existing error
              // contract. Match `requireNote`'s message shape so existing
              // callers see no behavior change.
              throw structuredError(`Note not found: "${item.id}"`, { error_type: "not_found", field: "id" });
            }
            const note = resolved;

            // --- Validate mutual exclusion of content modes ---
            const hasContent = item.content !== undefined;
            const hasAppendPrepend = item.append !== undefined || item.prepend !== undefined;
            const hasContentEdit = item.content_edit !== undefined;
            const contentModes = (hasContent ? 1 : 0) + (hasAppendPrepend ? 1 : 0) + (hasContentEdit ? 1 : 0);
            if (contentModes > 1) {
              throw structuredError(
                `update-note: \`content\`, \`append\`/\`prepend\`, and \`content_edit\` are mutually exclusive — pick one mode of content update for note "${note.id}".`,
                { error_type: "mutually_exclusive", hint: "pass exactly one of `content`, `append`/`prepend`, or `content_edit`" },
              );
            }

            // --- Safety-by-default: refuse mutations without a precondition ---
            // The caller must either echo the note's last-seen `updated_at`
            // (`if_updated_at`) so the conditional UPDATE can catch lost
            // writes, or explicitly opt out with `force: true`. This runs
            // *before* any DB writes so a rejection leaves the note untouched.
            //
            // Append/prepend-only updates are exempt: they're SQL-atomic
            // concatenations that can't lose data on a stale read, so the
            // precondition would be ceremony for no benefit. Tag and link
            // mutations are *not* exempt — they're idempotent set-ops at
            // the SQL layer but still represent a non-content change the
            // caller should have observed before re-asserting (#201).
            const isAppendOnly = hasAppendPrepend
              && !hasContent
              && !hasContentEdit
              && item.path === undefined
              && item.metadata === undefined
              && item.created_at === undefined
              && item.tags === undefined
              && item.links === undefined;
            // A state_transition is itself a compare-and-set precondition
            // (vault#299 Part B) — a transition-only update doesn't need
            // `if_updated_at`/`force`, the CAS guards the lost-write window.
            const isTransitionOnly = item.state_transition !== undefined
              && !hasContent
              && !hasAppendPrepend
              && !hasContentEdit
              && item.path === undefined
              && item.metadata === undefined
              && item.created_at === undefined
              && item.tags === undefined
              && item.links === undefined;
            if (!isAppendOnly && !isTransitionOnly && item.if_updated_at === undefined && item.force !== true) {
              throw new PreconditionRequiredError(note.id, note.path ?? null);
            }

            // --- Resolve content_edit into a full content string ---
            // We do the find-and-replace at the JS level (read note.content,
            // validate occurrence count, replace). The race window between
            // this read and the UPDATE is closed by `if_updated_at` for
            // strict callers; without it, content_edit is fail-closed —
            // a stale read where someone else removed `old_text` produces
            // a "not found" error instead of silently overwriting.
            let contentOverride = item.content as string | undefined;
            if (hasContentEdit) {
              const ce = item.content_edit as { old_text: string; new_text: string };
              if (typeof ce?.old_text !== "string" || typeof ce?.new_text !== "string") {
                throw structuredError(
                  "update-note: `content_edit` requires { old_text: string, new_text: string }.",
                  { error_type: "invalid_content_edit", field: "content_edit", hint: "pass { old_text: string, new_text: string }" },
                );
              }
              const idx = note.content.indexOf(ce.old_text);
              if (idx < 0) {
                throw structuredError(
                  `update-note content_edit: \`old_text\` not found in note "${note.id}". The note may have been edited — re-read and retry.`,
                  { error_type: "content_edit_not_found", field: "content_edit.old_text", hint: "re-read the note's current content and retry with an old_text that occurs exactly once" },
                );
              }
              const second = note.content.indexOf(ce.old_text, idx + 1);
              if (second >= 0) {
                throw structuredError(
                  `update-note content_edit: \`old_text\` matches multiple times in note "${note.id}" — must match exactly once. Add surrounding context to disambiguate.`,
                  { error_type: "content_edit_ambiguous", field: "content_edit.old_text", hint: "add surrounding context to old_text so it matches exactly once" },
                );
              }
              contentOverride = note.content.slice(0, idx) + ce.new_text + note.content.slice(idx + ce.old_text.length);
            }

            // --- Plan bracket cleanup for wikilink removals (no DB writes yet) ---
            // We compute the cleaned content so we can do the core UPDATE first
            // (with if_updated_at atomically) before any link deletions. If the
            // UPDATE fails on a conflict, nothing has been mutated.
            const linksRemove = (item.links as any)?.remove as { target: string; relationship: string }[] | undefined;
            const resolvedLinksToRemove: { targetId: string; relationship: string }[] = [];
            if (linksRemove) {
              for (const link of linksRemove) {
                const target = resolveStructuredLinkNote(db, link.target);
                if (!target) continue;
                resolvedLinksToRemove.push({ targetId: target.id, relationship: link.relationship });
                if (link.relationship === "wikilink" && target.path) {
                  // Wikilink-removal bracket cleanup operates on the prospective
                  // *full* content. Coexists with content_edit; would fight
                  // append/prepend (which leave existing content untouched at
                  // the JS layer), so we pre-materialize the would-be content
                  // for those callers and switch to a `content`-style update.
                  const currentContent = contentOverride
                    ?? (hasAppendPrepend
                      ? (item.prepend as string ?? "") + note.content + (item.append as string ?? "")
                      : note.content);
                  const cleaned = removeWikilinkBrackets(currentContent, target.path);
                  if (cleaned !== currentContent) {
                    contentOverride = cleaned;
                  }
                }
              }
            }

            // --- Core update (content, path, metadata, created_at + concurrency check) ---
            const updates: any = {};
            if (contentOverride !== undefined) {
              updates.content = contentOverride;
            } else if (hasAppendPrepend) {
              // No content_edit and no wikilink-removal pre-materialization —
              // route the append/prepend down to the SQL-atomic path.
              if (item.append !== undefined) updates.append = item.append;
              if (item.prepend !== undefined) updates.prepend = item.prepend;
            }
            if (item.path !== undefined) {
              // Reject NUL / `..` paths at the write surface (vault#589 / FIX 2).
              validatePath(item.path);
              updates.path = item.path;
            }
            if (item.extension !== undefined) {
              updates.extension = validateExtension(item.extension);
            }
            if (item.metadata !== undefined) {
              // Merge metadata (RFC 7386: keys are merged, incoming `null`
              // removes the key rather than persisting a literal null —
              // vault#478/#479). Mirrors the REST PATCH path.
              updates.metadata = noteOps.mergeMetadata(
                note.metadata as Record<string, unknown> | null | undefined,
                item.metadata as Record<string, unknown>,
              );
            }
            if (item.created_at !== undefined) updates.created_at = item.created_at;
            if (item.if_updated_at !== undefined) updates.if_updated_at = item.if_updated_at as string;
            // Compare-and-set state transition (vault#299 Part B). Combinable
            // with other field updates — it folds into the same atomic UPDATE.
            const stItem = item.state_transition as { field?: unknown; from?: unknown; to?: unknown } | undefined;
            if (stItem !== undefined) {
              if (typeof stItem.field !== "string" || stItem.field.length === 0) {
                throw structuredError(
                  `update-note: \`state_transition.field\` must be a non-empty string (note "${note.id}").`,
                  { error_type: "invalid_state_transition", field: "state_transition.field", hint: "pass a non-empty string naming the metadata field to transition" },
                );
              }
              updates.state_transition = { field: stItem.field, from: stItem.from, to: stItem.to };
            }

            // --- Strict-schema gate (vault#299 Part A) ---
            // Validate the PROSPECTIVE shape (final tags + merged metadata,
            // including a state_transition's `to`) before the write so a
            // rejection leaves the note untouched. `projectedTags` is hoisted
            // out of this block (not just used here) — the `store.updateNote`
            // call below also needs it, as `tagsForSchemaResolution`, so that
            // `date`-field normalization sees a tag ADDED in this SAME call
            // (vault#date-field-type review round 2 — the actual `store.tagNote`
            // mutation happens AFTER the core UPDATE, so without this the
            // schema resolution inside `store.updateNote` would still be
            // looking at the note's stale pre-write tag set).
            let projectedTags: Set<string>;
            {
              const removeSet = new Set<string>((item.tags as any)?.remove ?? []);
              projectedTags = new Set<string>((note.tags ?? []).filter((t) => !removeSet.has(t)));
              for (const t of ((item.tags as any)?.add as string[] | undefined) ?? []) projectedTags.add(t);
              const baseMeta = updates.metadata ?? ((note.metadata as Record<string, unknown>) ?? {});
              const projectedMeta = stItem !== undefined
                ? { ...baseMeta, [stItem.field as string]: stItem.to }
                : baseMeta;
              enforceStrict({ path: note.path, tags: [...projectedTags], metadata: projectedMeta });
            }

            // vault#555 fix 2 — tag and link mutations must bump `updated_at`
            // too, not just core-field (content/path/metadata) changes. Before
            // this, a tags-only or links-only call with `force: true` (no
            // `if_updated_at`) left `updates` completely empty — the branch
            // below skipped `store.updateNote` ENTIRELY, so `updated_at` never
            // moved even though tags/note_tags or links genuinely changed.
            // (A tags-only call that happened to pass `if_updated_at` already
            // worked by accident — it populated `updates.if_updated_at` — which
            // is why this was easy to miss in ad hoc testing.) This breaks
            // cursor polling (`ORDER BY updated_at`) and any `updated_at`-based
            // sync filter: the mutation is real but invisible to a
            // since-last-check loop.
            const hasTagMutation = ((item.tags as any)?.add?.length ?? 0) > 0
              || ((item.tags as any)?.remove?.length ?? 0) > 0;
            const hasLinkMutation = (item.links as any)?.add !== undefined
              || (item.links as any)?.remove !== undefined;

            // Content-wikilink warnings (vault#570) gate on the SAME
            // condition `store.updateNote`/`syncWikilinks` use to decide
            // whether to re-sync content wikilinks at all — a tags/links-only
            // update must not spuriously re-warn about pre-existing broken
            // links this call never touched.
            const contentChanged = updates.content !== undefined
              || updates.append !== undefined
              || updates.prepend !== undefined;

            let result: Note;
            if (Object.keys(updates).length > 0 || hasTagMutation || hasLinkMutation) {
              // Write-attribution (vault#298): stamp the most-recent-write
              // columns on the same UPDATE that bumps `updated_at`. Only set when
              // there's a real change to write (the empty-updates branch below
              // leaves attribution untouched, symmetric with not bumping
              // updated_at on a no-op).
              updates.actor = writeActor;
              updates.via = writeVia;
              // `tagsForSchemaResolution` (vault#date-field-type review round
              // 2) — the PROJECTED final tag set, so `date`-field
              // normalization inside store.updateNote sees a tag ADDED in
              // this same call, not just the note's pre-write tags. See the
              // comment on `projectedTags`'s declaration above.
              updates.tagsForSchemaResolution = [...projectedTags];
              // store.updateNote routes through noteOps.updateNote, which runs
              // the UPDATE (with optional `AND updated_at IS ?`) atomically and
              // throws ConflictError on mismatch. No mutations have happened
              // yet, so a throw here leaves the note untouched. `updates` may
              // carry no core fields at all (a pure tag/link mutation) — that's
              // fine: `noteOps.updateNote` unconditionally SETs
              // `updated_at`/`last_updated_by`/`last_updated_via` whenever
              // `skipUpdatedAt` isn't set, so this still issues a real UPDATE
              // (not the true no-op/precondition-only branch, which only fires
              // when the caller passes ZERO fields AND no mutation is pending).
              result = await store.updateNote(note.id, updates);
            } else {
              result = note;
            }

            // --- Remove links (after core UPDATE so a conflict leaves them intact) ---
            for (const { targetId, relationship } of resolvedLinksToRemove) {
              await store.deleteLink(note.id, targetId, relationship);
            }

            // --- Tags ---
            const tagsOp = item.tags as { add?: string[]; remove?: string[] } | undefined;
            if (tagsOp?.add?.length) {
              await store.tagNote(note.id, tagsOp.add);
              await applySchemaDefaults(store, db, [note.id], tagsOp.add);
            }
            if (tagsOp?.remove?.length) {
              await store.untagNote(note.id, tagsOp.remove);
            }

            // --- Add links (deferred to the second pass — vault#555) ---
            const linksAdd = (item.links as any)?.add as { target: string; relationship: string; metadata?: Record<string, unknown> }[] | undefined;
            if (linksAdd) {
              pendingLinks.push({ sourceId: note.id, links: linksAdd });
            }

            // Echo links if this update mutated them (`links.add`/`links.remove`)
            // or the caller asked explicitly. vault feedback #8.
            const linkMutated = (item.links as any)?.add !== undefined || (item.links as any)?.remove !== undefined;
            if (linkMutated || item.include_links === true) {
              echoLinkIds.add(note.id);
            }

            // Re-read for final state
            const finalNote = noteOps.getNote(db, note.id) ?? result;
            if (contentChanged) {
              contentWikilinkNotes.push({ noteId: note.id, content: finalNote.content });
            }
            updated.push(finalNote);
          }

          // --- Resolve structured `links.add` (vault#555) ---
          // Deferred until every item in this batch has been created/
          // updated — same [[wikilink]] semantics (ID or path/title match),
          // now tried against the FULL post-batch note set so a forward-ref
          // to a sibling item resolves. A target that still doesn't resolve
          // is queued for lazy resolution (backfills when a matching note
          // is created later) and surfaces an `unresolved_link` warning —
          // never silently dropped.
          for (const { sourceId, links } of pendingLinks) {
            for (const link of links) {
              const outcome = resolveOrQueueLink(db, sourceId, link.target, link.relationship);
              if (outcome.status === "resolved") {
                await store.createLink(sourceId, outcome.note_id, link.relationship, link.metadata);
              } else if (outcome.status === "ambiguous") {
                pushLinkWarning(sourceId, {
                  code: "ambiguous_link",
                  message: `link target "${link.target}" (relationship "${link.relationship}") matched ${outcome.candidates.length} notes — ambiguous, no link created. Use a more specific path or the note's ID to disambiguate.`,
                  target: link.target,
                  relationship: link.relationship,
                  candidate_count: outcome.candidates.length,
                });
              } else {
                pushLinkWarning(sourceId, {
                  code: "unresolved_link",
                  message: `link target "${link.target}" (relationship "${link.relationship}") did not resolve to any note — queued and will backfill automatically if a matching note is created later.`,
                  target: link.target,
                  relationship: link.relationship,
                });
              }
            }
          }

          // --- Content-wikilink warnings (vault#570) ---
          // Same forward-ref-aware timing as the structured-links pass above.
          for (const { noteId, content } of contentWikilinkNotes) {
            for (const warning of getContentWikilinkWarnings(db, noteId, content)) {
              pushLinkWarning(noteId, warning);
            }
          }
        };
        await (batched ? transactionAsync(db, runBatch) : runBatch());

        // Response shape: full Note (back-compat default) or lean NoteIndex
        // (#285 friction point 2.response — opt-out for callers making
        // frequent small edits to large notes). `validation_status` from
        // `tags.fields` is preserved across either shape. `created: true|false`
        // (vault#309) is attached to every response so callers using
        // `if_missing: "create"` can tell which branch fired without a
        // separate query. `false` for the (overwhelmingly common) update
        // path; `true` only when this call took the create-on-missing
        // branch.
        const includeContent = params.include_content !== false;
        const final = updated.map((n) => {
          const validated = attachValidationStatus(store, db, n);
          const created = createdIds.has(n.id);
          // Echo hydrated links when this note was flagged for it (mutated
          // its links or `include_links` was set). Additive key, present only
          // when triggered — mirrors the GET / query-notes shape exactly via
          // the shared `linkOps.getLinksHydrated` call. vault feedback #8.
          const echoLinks = echoLinkIds.has(n.id);
          // `unresolved_link` warnings (vault#555) — additive, present only
          // when this note's `links.add` had a target that didn't resolve.
          const warnings = linkWarningsByNote.get(n.id);
          if (includeContent) {
            const full: any = { ...validated, created };
            if (echoLinks) full.links = linkOps.getLinksHydrated(db, n.id);
            if (warnings && warnings.length > 0) full.warnings = warnings;
            return full as Note & { created: boolean };
          }
          const lean: any = noteOps.toNoteIndex(validated);
          const vs = (validated as any).validation_status;
          if (vs !== undefined) lean.validation_status = vs;
          lean.created = created;
          // Carry the link echo across the lean conversion — `toNoteIndex`
          // drops unknown fields.
          if (echoLinks) lean.links = linkOps.getLinksHydrated(db, n.id);
          if (warnings && warnings.length > 0) lean.warnings = warnings;
          return lean;
        });
        return batch ? final : final[0];
      },
    },

    // =====================================================================
    // 4. delete-note
    // =====================================================================
    {
      name: "delete-note",
      execute: async (params) => {
        const note = requireNote(db, params.id as string);
        await store.deleteNote(note.id);
        return { deleted: true, id: note.id };
      },
    },

    // =====================================================================
    // 5. list-tags — with optional single-tag detail + schema
    // =====================================================================
    {
      name: "list-tags",
      execute: (params) => {
        const singleTag = params.tag as string | undefined;

        if (singleTag) {
          const allTags = noteOps.listTags(db);
          const found = allTags.find((t) => t.name === singleTag);
          const record = tagSchemaOps.getTagRecord(db, singleTag);
          // vault#550 — a tag with no identity row AND no note carrying it
          // isn't a legitimate (if empty) tag, it's a typo or a tag from a
          // different vault. Return a structured miss instead of a
          // synthesized all-null 200. `did_you_mean` searches the full
          // vault-wide tag catalog — core is scope-unaware by architecture.
          // Tag-scope enforcement lives in the server layer's list-tags
          // wrapper (src/mcp-tools.ts:applyTagScopeWrappers): a scoped
          // session's out-of-scope `tag` param short-circuits to
          // tag_not_found BEFORE this executes, and an in-scope miss gets
          // its `did_you_mean` dropped unless the suggestion is also
          // in-scope.
          if (!found && !record) {
            const suggestion = suggestSimilarTag(allTags.map((t) => t.name), singleTag);
            return {
              error: "Tag not found",
              error_type: "tag_not_found",
              tag: singleTag,
              ...(suggestion ? { did_you_mean: suggestion } : {}),
            };
          }
          return {
            name: singleTag,
            count: found?.count ?? 0,
            expanded_count: found?.expanded_count ?? 0,
            description: record?.description ?? null,
            fields: record?.fields ?? null,
            relationships: record?.relationships ?? null,
            parent_names: record?.parent_names ?? null,
            created_at: record?.created_at ?? null,
            updated_at: record?.updated_at ?? null,
          };
        }

        const tags = noteOps.listTags(db);
        if (params.include_schema) {
          const records = new Map(
            tagSchemaOps.listTagRecords(db).map((r) => [r.tag, r] as const),
          );
          return tags.map((t) => {
            const r = records.get(t.name);
            return {
              ...t,
              description: r?.description ?? null,
              fields: r?.fields ?? null,
              relationships: r?.relationships ?? null,
              parent_names: r?.parent_names ?? null,
              created_at: r?.created_at ?? null,
              updated_at: r?.updated_at ?? null,
            };
          });
        }
        return tags;
      },
    },

    // =====================================================================
    // 6. update-tag — create/update tag description + schema fields
    // =====================================================================
    {
      name: "update-tag",
      execute: async (params) => {
        // Canonical-bare-tag guard (PR #516): normalize the tag NAME up front
        // so the existing-record lookup (and the field/cross-tag merge that
        // depends on it) reads the bare `foo` row, not a phantom `#foo` miss.
        // store.upsertTagRecord normalizes again (idempotent) for non-MCP
        // callers; doing it here keeps the merge correct.
        const tag = stripTagHash(params.tag as string);
        const existing = tagSchemaOps.getTagRecord(db, tag);

        // ---- fields: three-way semantics, distinguishing `null` from
        // `undefined` (do NOT collapse with `?? {}` — that silently turns an
        // explicit clear-all into a no-op, the gitcoin orphaned-fields bug).
        //   - undefined  → no change. Preserve every existing field; declare
        //                  nothing new. mergedFields === existing.fields.
        //   - null       → clear ALL of this tag's field schemas.
        //                  mergedFields = {} so the diff below releases every
        //                  indexed field this tag exclusively declares.
        //   - object     → shallow-merge into existing (preserves prior keys).
        const incomingFields =
          params.fields === null || params.fields === undefined
            ? {}
            : (params.fields as Record<string, TagFieldSchema>);
        const mergedFields: Record<string, TagFieldSchema> =
          params.fields === null
            ? {}
            : { ...(existing?.fields ?? {}), ...incomingFields };

        // Validate cross-tag consistency on fields being (re)declared in this
        // call. `type` and `indexed` are global — all declarers must agree.
        // vault#553/#554: collects EVERY violation instead of throwing on the
        // first — a caller declaring two bad fields sees both in one
        // response, and the thrown error states explicitly that no changes
        // were applied (nothing is persisted before this check runs).
        const fieldViolations = tagSchemaOps.collectTagFieldViolations(db, tag, incomingFields);
        if (fieldViolations.length > 0) {
          throw new tagSchemaOps.TagFieldConflictError(tag, fieldViolations);
        }

        // ---- relationships: replace wholesale when provided. `relationships`
        // is an opaque vocabulary map (relationship-name → arbitrary JSON the
        // app interprets). Validate only that it's a JSON object (a map), then
        // persist verbatim — no inner-shape enforcement.
        let relationshipsPatch: tagSchemaOps.TagRelationshipMap | null | undefined;
        if (params.relationships === null) {
          relationshipsPatch = null;
        } else if (params.relationships !== undefined) {
          relationshipsPatch = tagSchemaOps.validateRelationships(params.relationships);
        }

        // ---- parent_names: replace wholesale when provided. Empty array
        // collapses to null (clear) — a tag with `parent_names = []` and
        // a tag with `parent_names = null` are indistinguishable at the
        // hierarchy layer.
        let parentNamesPatch: string[] | null | undefined;
        if (params.parent_names === null) {
          parentNamesPatch = null;
        } else if (params.parent_names !== undefined) {
          if (!Array.isArray(params.parent_names)) {
            throw structuredError("parent_names must be an array of tag names", {
              error_type: "invalid_parent_names",
              field: "parent_names",
              hint: "pass an array of tag name strings, or null to clear",
            });
          }
          const cleaned = (params.parent_names as unknown[])
            .filter((p): p is string => typeof p === "string" && p.length > 0);
          parentNamesPatch = cleaned.length > 0 ? cleaned : null;
        }

        // ---- Persist via the store wrapper so the hierarchy cache is
        // invalidated when parent_names is touched.
        const fieldsPatch = Object.keys(mergedFields).length > 0
          ? mergedFields
          : (params.fields !== undefined ? null : undefined);
        const descriptionPatch =
          params.description === undefined ? undefined : (params.description as string);
        // The indexed-field lifecycle (declareField for added indexed fields,
        // releaseField for removed ones, with the co-declaration guard) is
        // reconciled inside store.upsertTagRecord — the single chokepoint all
        // callers (MCP, REST PUT /tags/:name, import) share — so it can't be
        // bypassed. The cross-tag validation above stays here to surface a
        // clean error before persisting. See the gitcoin orphaned-fields bug.
        const result = await store.upsertTagRecord(tag, {
          ...(descriptionPatch !== undefined ? { description: descriptionPatch } : {}),
          ...(fieldsPatch !== undefined ? { fields: fieldsPatch } : {}),
          ...(relationshipsPatch !== undefined ? { relationships: relationshipsPatch } : {}),
          ...(parentNamesPatch !== undefined ? { parent_names: parentNamesPatch } : {}),
        });

        return result;
      },
    },

    // =====================================================================
    // 7. delete-tag — delete tag + schema from all notes
    // =====================================================================
    {
      name: "delete-tag",
      execute: async (params) => {
        const tag = params.tag as string;
        // Drop the row outright — description/fields/relationships/parents
        // travel with it. (No more sidecar table to clear separately.)
        // Indexed-field release is handled inside store.deleteTag →
        // noteOps.deleteTag so every entry point (MCP, REST, import sweep)
        // releases consistently with the co-declaration guard. See the
        // gitcoin orphaned-fields bug report. The referential-integrity
        // guard (vault#552) is ALSO inside store.deleteTag, so it returns
        // (not throws) `{error: "tag_referenced_as_parent", ...}` when
        // refused — same in-band shape delete-tag has always used for its
        // token-reference guard (applyTagDependencyGuards, src/mcp-tools.ts).
        return await store.deleteTag(tag, {
          cascade: params.cascade === true,
          detach: params.detach === true,
        });
      },
    },

    // =====================================================================
    // 7a. rename-tag — atomic cascading rename (vault#552 MCP parity)
    // =====================================================================
    {
      name: "rename-tag",
      execute: async (params) => {
        const oldName = (params.old_name ?? params.from ?? params.tag) as string | undefined;
        const newName = (params.new_name ?? params.to) as string | undefined;
        if (typeof oldName !== "string" || oldName.length === 0) {
          throw structuredError("rename-tag: old_name (or from/tag) is required", {
            error_type: "invalid_request",
            field: "old_name",
          });
        }
        if (typeof newName !== "string" || newName.length === 0) {
          throw structuredError("rename-tag: new_name (or to) is required", {
            error_type: "invalid_request",
            field: "new_name",
          });
        }
        const result = await store.renameTag(oldName, newName);
        if ("error" in result) {
          if (result.error === "not_found") {
            throw structuredError(`rename-tag: tag "${oldName}" not found`, {
              error_type: "tag_not_found",
              field: "old_name",
            });
          }
          throw Object.assign(
            new Error(
              `rename-tag: target "${newName}" (or one of its sub-tags) already exists — use merge-tags to combine them instead`,
            ),
            {
              error_type: "target_exists" as const,
              target: newName,
              conflicting: result.conflicting,
              hint: "use merge-tags to combine the tags instead",
            },
          );
        }
        return result;
      },
    },

    // =====================================================================
    // 7b. merge-tags — same machinery, N sources → one target
    // =====================================================================
    {
      name: "merge-tags",
      execute: async (params) => {
        const sources = params.sources;
        const target = params.target;
        if (!Array.isArray(sources) || sources.length === 0 || !sources.every((s) => typeof s === "string" && s.length > 0)) {
          throw structuredError("merge-tags: sources must be a non-empty array of strings", {
            error_type: "invalid_request",
            field: "sources",
          });
        }
        if (typeof target !== "string" || target.length === 0) {
          throw structuredError("merge-tags: target must be a non-empty string", {
            error_type: "invalid_request",
            field: "target",
          });
        }
        return await store.mergeTags(sources as string[], target);
      },
    },

    // =====================================================================
    // 8. find-path — BFS between two notes
    // =====================================================================
    {
      name: "find-path",
      execute: (params) => {
        const source = requireNote(db, params.source as string);
        const target = requireNote(db, params.target as string);
        return linkOps.findPath(db, source.id, target.id, {
          max_depth: Math.min((params.max_depth as number) ?? 5, 10),
        });
      },
    },

    // =====================================================================
    // 9. vault-info — get/update vault description + stats
    // =====================================================================
    {
      name: "vault-info",
      execute: () => {
        // This is a placeholder — vault-info needs access to vault config,
        // which is only available in the server layer (mcp-tools.ts).
        return { error: "vault-info must be configured by the server layer", error_type: "not_configured" };
      },
    },

    // =====================================================================
    // 10. prune-schema — drop orphaned indexed-field columns
    // =====================================================================
    {
      name: "prune-schema",
      execute: async (params) => {
        const apply = params.apply === true;
        const plan = await store.pruneIndexedFields({ dryRun: !apply });
        const dropped = plan.filter((p) => p.dropped);
        const trimmed = plan.filter((p) => !p.dropped);
        return {
          dry_run: !apply,
          fields_dropped: dropped.map((p) => ({ field: p.field, dead_declarers: p.deadDeclarers })),
          fields_trimmed: trimmed.map((p) => ({ field: p.field, dead_declarers: p.deadDeclarers })),
          summary: apply
            ? `pruned ${dropped.length} orphaned field(s); trimmed dead declarers on ${trimmed.length} co-declared field(s)`
            : `would prune ${dropped.length} orphaned field(s); would trim dead declarers on ${trimmed.length} co-declared field(s) — pass apply:true to execute`,
        };
      },
    },

    // =====================================================================
    // 11. doctor — read-only taxonomy/metadata integrity scan (vault#552)
    // =====================================================================
    {
      name: "doctor",
      execute: async () => {
        return await store.doctor();
      },
    },

  ];

  // =====================================================================
  // 12/13. request-attachment-upload / request-attachment-download —
  // runtime-lane attachment tickets (Wave 1). Present ONLY when the
  // server layer wires an AttachmentTicketProvider — see
  // `GenerateMcpToolsOpts.attachmentTickets`'s doc comment (D10, "tools
  // omitted when unwired"). Bytes never pass through either tool: the
  // model gets back a URL + a literal curl_example; a runtime with a
  // shell spends it directly, outside this MCP session entirely.
  // =====================================================================
  const ticketSeam = opts?.attachmentTickets;
  if (ticketSeam) {
    executorDefs.push(
      {
        name: "request-attachment-upload",
        execute: async (params) => {
          const noteRef = params.note;
          if (typeof noteRef !== "string" || noteRef.trim() === "") {
            throw structuredError("`note` is required", {
              error_type: "missing_required_field",
              field: "note",
              how_to: "pass the target note's id or path",
            });
          }
          const filename = params.filename;
          if (typeof filename !== "string" || filename.trim() === "") {
            throw structuredError("`filename` is required", {
              error_type: "missing_required_field",
              field: "filename",
              how_to: "pass the original filename you're about to upload",
            });
          }
          const sizeBytes = params.size_bytes;
          if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
            throw structuredError("`size_bytes` must be a positive number", {
              error_type: "invalid_query",
              field: "size_bytes",
              how_to: "pass the exact byte length of the file you're about to upload",
            });
          }
          if (sizeBytes > MAX_TICKET_UPLOAD_BYTES) {
            throw structuredError(
              `size_bytes (${sizeBytes}) exceeds the ${MAX_TICKET_UPLOAD_BYTES} byte (100 MiB) upload cap`,
              {
                error_type: "file_too_large",
                field: "size_bytes",
                limit: MAX_TICKET_UPLOAD_BYTES,
                got: sizeBytes,
                how_to: "REST /storage/upload shares this same 100 MiB ceiling — split the file or upload it out-of-band",
              },
            );
          }

          const note = requireNote(db, noteRef);
          if (ticketSeam.noteVisible && !(await ticketSeam.noteVisible(note))) {
            // Uniform not_found — a tag-scoped caller learns nothing about
            // an out-of-scope note's existence (same posture as every other
            // scope-gated tool in this file).
            throw structuredError(`Note not found: "${noteRef}"`, { error_type: "not_found", field: "note" });
          }

          const ext = sanitizeAttachmentExtension(filename);
          if (BLOCKED_ATTACHMENT_EXTENSIONS.has(ext)) {
            throw structuredError(`File type ${ext} not allowed (active/executable content)`, {
              error_type: "blocked_upload_extension",
              field: "filename",
              extension: ext,
              how_to: "rename with a non-executable extension, or store the content as note text instead",
            });
          }

          const mimeType =
            typeof params.mime_type === "string" && params.mime_type.trim() !== ""
              ? params.mime_type
              : mimeForAttachmentExtension(ext);

          // Per-segment slots (voice W2), ticket-mint parity with the REST
          // path's own validation (`src/routes.ts` POST /notes/:id/attachments):
          // an integer >= 0, else silently dropped — a malformed value falls
          // back to the un-segmented bare markers rather than erroring the mint.
          const segIdx = params.segment_index;
          const validSegment = typeof segIdx === "number" && Number.isInteger(segIdx) && segIdx >= 0;

          const now = Date.now();
          const expiresAt = now + computeTicketTtlMs(sizeBytes);
          const id = generateTicketId();
          const ticket: AttachmentTicket = {
            id,
            kind: "upload",
            vaultName: ticketSeam.vaultName,
            createdAt: now,
            expiresAt,
            noteId: note.id,
            filename,
            mimeType,
            sizeBytes,
            transcribe: params.transcribe === true,
            ...(validSegment ? { segmentIndex: segIdx } : {}),
          };
          await ticketSeam.provider.put(ticket);

          const url = `${ticketSeam.urlBase}/tickets/${id}`;
          return {
            method: "PUT",
            url,
            headers: { "content-type": mimeType },
            expires_at: new Date(expiresAt).toISOString(),
            max_bytes: sizeBytes,
            curl_example: `curl -X PUT -H 'content-type: ${mimeType}' --data-binary @${filename} '${url}'`,
          };
        },
      },
      {
        name: "request-attachment-download",
        execute: async (params) => {
          const attachmentId = params.attachment_id;
          if (typeof attachmentId !== "string" || attachmentId.trim() === "") {
            throw structuredError("`attachment_id` is required", {
              error_type: "missing_required_field",
              field: "attachment_id",
              how_to: "pass the attachment id from a note's attachment rows",
            });
          }

          const attachment = await store.getAttachment(attachmentId);
          if (!attachment) {
            throw structuredError(`Attachment not found: "${attachmentId}"`, {
              error_type: "not_found",
              field: "attachment_id",
            });
          }

          if (ticketSeam.noteVisible) {
            const owningNote = await store.getNote(attachment.noteId);
            // A missing owning note (shouldn't happen — ON DELETE CASCADE —
            // but never trust it) collapses to the same not_found as an
            // out-of-scope note: no oracle either way.
            if (!owningNote || !(await ticketSeam.noteVisible(owningNote))) {
              throw structuredError(`Attachment not found: "${attachmentId}"`, {
                error_type: "not_found",
                field: "attachment_id",
              });
            }
          }

          const metaSize = attachment.metadata?.size;
          const declaredSize = typeof metaSize === "number" ? metaSize : undefined;
          const now = Date.now();
          const expiresAt = now + computeTicketTtlMs(declaredSize);
          const id = generateTicketId();
          const ticket: AttachmentTicket = {
            id,
            kind: "download",
            vaultName: ticketSeam.vaultName,
            createdAt: now,
            expiresAt,
            attachmentId: attachment.id,
            mimeType: attachment.mimeType,
            sizeBytes: declaredSize,
          };
          await ticketSeam.provider.put(ticket);

          const url = `${ticketSeam.urlBase}/tickets/${id}`;
          return {
            method: "GET",
            url,
            mime_type: attachment.mimeType,
            ...(declaredSize !== undefined ? { size_bytes: declaredSize } : {}),
            expires_at: new Date(expiresAt).toISOString(),
            curl_example: `curl -o downloaded${sanitizeAttachmentExtension(attachment.path) || ""} '${url}'`,
          };
        },
      },
    );
  }

  // =====================================================================
  // 14. read-attachment — model-lane byte reads (Wave 2). Present ONLY
  // when the server layer wires an AttachmentBytesProvider — see
  // `GenerateMcpToolsOpts.attachmentBytes`'s doc comment (D10). Dispatches
  // by mime family: text ranges come back as `content`/`content_offset`/
  // `content_total_length`/`content_next_offset` (the exact query-notes
  // pagination contract); images come back as a real MCP image block (see
  // this tool's `resultContent`); audio/video never send bytes — a
  // transcript pointer instead; PDF/other binary refuse with a
  // download-ticket pointer. Unlike the ticket tools, bytes (or a base64
  // encoding of them) DO pass through this tool — that's the whole point
  // of the model lane.
  // =====================================================================
  const bytesSeam = opts?.attachmentBytes;
  if (bytesSeam) {
    executorDefs.push({
      name: "read-attachment",
      execute: async (params) => {
        const attachmentId = params.attachment_id;
        if (typeof attachmentId !== "string" || attachmentId.trim() === "") {
          throw structuredError("`attachment_id` is required", {
            error_type: "missing_required_field",
            field: "attachment_id",
            how_to: "pass the attachment id from a note's attachment rows",
          });
        }

        const attachment = await store.getAttachment(attachmentId);
        if (!attachment) {
          throw structuredError(`Attachment not found: "${attachmentId}"`, {
            error_type: "not_found",
            field: "attachment_id",
          });
        }

        if (bytesSeam.noteVisible) {
          const owningNote = await store.getNote(attachment.noteId);
          // Same uniform not_found posture as the ticket tools — a
          // tag-scoped caller learns nothing about an out-of-scope note's
          // existence via a differential error.
          if (!owningNote || !(await bytesSeam.noteVisible(owningNote))) {
            throw structuredError(`Attachment not found: "${attachmentId}"`, {
              error_type: "not_found",
              field: "attachment_id",
            });
          }
        }

        const mimeType = effectiveAttachmentMime(attachment);

        if (isImageMime(mimeType)) {
          if (params.content_offset !== undefined || params.content_length !== undefined) {
            throw structuredError("content_offset/content_length don't apply to image attachments", {
              error_type: "invalid_query",
              field: "content_offset",
              hint: "omit content_offset/content_length for an image read — the whole image (up to the 4 MiB cap) comes back in one call",
            });
          }
          return await readImageAttachment(attachment, mimeType, bytesSeam.provider);
        }
        if (isTextMime(mimeType)) {
          return await readTextAttachment(attachment, mimeType, params, bytesSeam.provider);
        }
        if (isAudioOrVideoMime(mimeType)) {
          return await readAudioPointer(attachment, bytesSeam.provider);
        }

        // Other binary (PDF, zip, docx, ...) — refuse honestly rather than
        // returning garbage or truncated bytes; extraction is a v2 concern
        // (D5). Still stats first so a row whose bytes are ALSO gone gets
        // the more accurate attachment_binary_missing instead.
        const stat = await statAttachmentOrMissing(attachment, bytesSeam.provider);
        throw structuredError(`Attachment type "${mimeType}" isn't directly readable by this tool`, {
          error_type: "unsupported_attachment_type",
          mime_type: mimeType,
          size: stat.size,
          how_to: "mint a download ticket with request-attachment-download and process the file locally",
        });
      },
      resultContent: (result) => {
        const r = result as ({ _mcpImage?: { data: string; mimeType: string } } & Record<string, unknown>) | null;
        if (r && r._mcpImage) {
          const { _mcpImage, ...rest } = r;
          return [
            { type: "text", text: JSON.stringify(rest, null, 2) },
            { type: "image", data: _mcpImage.data, mimeType: _mcpImage.mimeType },
          ];
        }
        return [{ type: "text", text: JSON.stringify(result, null, 2) }];
      },
    });
  }

  // Zip each manifest entry (the single source of name/description/
  // inputSchema/requiredVerb + inclusion condition) with its store-bound
  // executor, in manifest order. A conditional tool whose seam wasn't wired is
  // skipped BEFORE its executor is looked up — matching the pre-manifest
  // "omitted when unwired" posture exactly. The emitted set is byte-identical
  // to the pre-refactor tool literals (pinned by mcp-manifest.test.ts).
  const executorsByName = new Map(executorDefs.map((e) => [e.name, e]));
  const tools: McpToolDef[] = [];
  for (const entry of MCP_TOOL_MANIFEST) {
    if (entry.condition === "attachment-tickets" && !ticketSeam) continue;
    if (entry.condition === "attachment-bytes" && !bytesSeam) continue;
    const impl = executorsByName.get(entry.name);
    if (!impl) {
      // A core (or wired-seam) tool with no executor is a manifest/impl drift
      // bug — fail loudly rather than silently drop a tool.
      throw new Error(`generateMcpTools: no executor registered for MCP tool "${entry.name}"`);
    }
    tools.push({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      requiredVerb: entry.requiredVerb,
      execute: impl.execute,
      ...(impl.resultContent ? { resultContent: impl.resultContent } : {}),
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Tag schema effects — auto-populate defaults when tags are applied
// ---------------------------------------------------------------------------

/**
 * Fill schema-declared default values into the metadata of the given notes
 * for any field they omitted. Returns the IDs of the notes whose metadata was
 * actually written — callers use this to re-read ONLY the mutated notes (and
 * to skip the re-read entirely when nothing changed). The common no-schema /
 * no-declared-defaults path returns an empty array.
 *
 * vault#553 Decision B: backfill is EXPLICIT-`default`-only. A field with no
 * declared `default` is skipped entirely here — it stays genuinely absent on
 * the note, not silently filled with the first enum value or a type
 * zero-value (the pre-0.7.0 behavior, which made "never set" and
 * "explicitly set to the default" indistinguishable and broke `exists:false`).
 * Exported so `src/routes.ts` (REST create/PATCH) shares this ONE
 * implementation instead of carrying its own copy — the two had drifted into
 * a byte-identical duplicate pre-#553; centralizing here means the cloud
 * runtime (which imports core directly, not `src/routes.ts`) automatically
 * inherits this behavior with zero handler-side work.
 *
 * vault#299: this runs AFTER the create write (so AFTER the strict gate) and
 * intentionally does NOT re-run `enforceStrict`. Defaults are always
 * conforming by construction — `store.upsertTagRecord` validates a field's
 * `default` against its own `type`/`enum` BEFORE the schema can be persisted
 * (`InvalidFieldDefaultError` / `TagFieldConflictError` reason
 * `invalid_default`), so a default can never violate type/enum at read time
 * here. And a `required` strict field is already caught at the pre-write
 * gate, so a note that would need a default to satisfy `required` never
 * reaches this filler (the create was rejected first) — declaring a
 * `default` does NOT satisfy `required`; the caller must still set the field
 * explicitly. Don't add a defaults path that could inject a violating value
 * without re-gating.
 */
export async function applySchemaDefaults(store: Store, db: Database, noteIds: string[], tags: string[]): Promise<string[]> {
  const schemas = tagSchemaOps.getTagSchemaMap(db);
  if (Object.keys(schemas).length === 0) return [];

  const defaults: Record<string, unknown> = {};
  for (const tag of tags) {
    const schema = schemas[tag];
    if (!schema?.fields) continue;
    for (const [field, fieldSchema] of Object.entries(schema.fields)) {
      if (field in defaults) continue; // first tag that declares a REAL default wins
      const value = defaultForField(fieldSchema);
      if (value === undefined) continue; // no `default` declared — leave the slot open for a later tag
      defaults[field] = value;
    }
  }
  if (Object.keys(defaults).length === 0) return [];

  const mutated: string[] = [];
  for (const noteId of noteIds) {
    const note = noteOps.getNote(db, noteId);
    if (!note) continue;
    const existing = (note.metadata as Record<string, unknown>) ?? {};
    const missing: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(defaults)) {
      if (!(field in existing)) {
        missing[field] = value;
      }
    }
    if (Object.keys(missing).length === 0) continue;
    await store.updateNote(noteId, {
      metadata: { ...existing, ...missing },
      skipUpdatedAt: true,
    });
    mutated.push(noteId);
  }
  return mutated;
}

/**
 * Resolve a field's backfill value — its declared `default` (vault#553
 * Decision B), or `undefined` when none was declared (the field stays
 * absent). Exported alongside `applySchemaDefaults` for `src/routes.ts`.
 */
export function defaultForField(field: { default?: unknown }): unknown {
  return field.default;
}

// ---------------------------------------------------------------------------
// `tags.fields` validation — surface validation_status on create/update
// ---------------------------------------------------------------------------

/**
 * Attach a `validation_status` field to the response when at least one tag
 * on the note declares `fields` on its `tags` row. Validation is advisory
 * only — writes are never blocked. The agent receives warnings (type
 * mismatch, enum mismatch) so it can self-correct on the next turn.
 *
 * Returns the note unchanged when no tag declares fields, so callers
 * without any tag schemas see no behavior change.
 *
 * Exported so both transports (MCP `update-note` here, HTTP `PATCH
 * /api/notes/:id` in `src/routes.ts`) attach the same status field by
 * the same recipe — see vault#287 for the asymmetry that motivated
 * exposing it.
 */
/**
 * Pre-write strict-schema gate (vault#299 Part A). Shared by both write
 * transports (MCP tools here, REST PATCH/POST in `src/routes.ts`) so the
 * enforcement contract can't drift between them — the same recipe the
 * `validation_status` attachment shares via `attachValidationStatus`.
 *
 * Validates the PROSPECTIVE note shape (final tags + merged metadata) against
 * the resolved schemas and:
 *   - no strict violations → no-op, the write proceeds.
 *   - violations + `bypass:false` → throw `SchemaValidationError` (one error,
 *     all per-field violations — settled lead #1). Caller writes nothing.
 *   - violations + `bypass:true` → invoke `onBypass(violations)` (migration
 *     scope) and return; the caller proceeds with the non-conforming write.
 *
 * Returns the would-be violations (empty when none) so a caller can inspect
 * them; the throw / bypass decision is already made internally.
 */
export function enforceStrictWrite(
  store: Store,
  shape: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> },
  opts?: { bypass?: boolean; onBypass?: (violations: ValidationWarning[]) => void },
): ValidationWarning[] {
  const status = store.validateNoteAgainstSchemas(shape);
  const violations = strictViolations(status);
  if (violations.length === 0) return [];
  if (opts?.bypass !== true) throw new SchemaValidationError(violations);
  opts.onBypass?.(violations);
  return violations;
}

export function attachValidationStatus(store: Store, _db: Database, note: Note): Note {
  // Short-circuit cheaply: when no tag declares fields, the resolver
  // returns null without us paying a re-read of the note.
  const status = store.validateNoteAgainstSchemas({
    path: note.path,
    tags: note.tags,
    metadata: note.metadata as Record<string, unknown> | undefined,
  });
  if (!status) return note;
  return { ...note, validation_status: status } as Note & { validation_status: typeof status };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeTags(tag: unknown): string[] | undefined {
  if (!tag) return undefined;
  // Defensive copy: callers downstream sometimes mutate the array (sort,
  // splice, push for hierarchy expansion). Returning a fresh array keeps
  // the original `params` object untouched.
  if (Array.isArray(tag)) return [...tag];
  return [tag as string];
}

/**
 * Coerce the `link_count_direction` MCP param to a known value, defaulting
 * to "both" (matches the REST `parseLinkCountDirection` fallback). A typo
 * silently degrades to the documented default rather than erroring.
 */
function normalizeLinkCountDirection(v: unknown): "both" | "outbound" | "inbound" {
  if (v === "outbound" || v === "inbound") return v;
  return "both";
}

// Re-exported for backward compat; defined in notes.ts alongside the
// conditional-UPDATE implementation that raises it. AmbiguousPathError
// joins the set (vault#331 N2) so external callers can `instanceof`
// it without crossing module boundaries.
export { ConflictError, PathConflictError, AmbiguousPathError, TransitionConflictError, MAX_BATCH_SIZE } from "./notes.js";
// vault#299: strict-schema enforcement error, re-exported alongside the other
// write-path domain errors so external callers can `instanceof` it without
// crossing module boundaries.
export { SchemaValidationError } from "./schema-defaults.js";

/**
 * Thrown by the `update-note` MCP tool (and the REST PATCH handler) when a
 * caller tries to mutate a note without either an `if_updated_at` token or
 * an explicit `force: true` opt-out. The `if_updated_at` requirement is the
 * safety-by-default posture — we'd rather refuse an ambiguous write than
 * silently overwrite someone else's edit.
 */
export class PreconditionRequiredError extends Error {
  code = "PRECONDITION_REQUIRED" as const;
  note_id: string;
  note_path: string | null;

  constructor(noteId: string, notePath: string | null) {
    super(
      `precondition required: update-note rejects an item without \`if_updated_at\` (read the note's updated_at and echo it) or \`force: true\` (explicit override). note="${noteId}"`,
    );
    this.name = "PreconditionRequiredError";
    this.note_id = noteId;
    this.note_path = notePath;
  }
}

/**
 * Thrown by `create-note` / `update-note` when a batch exceeds
 * `MAX_BATCH_SIZE` (re-exported from `./notes.js` — single source of truth).
 * Bounds the blast radius of a runaway client — see #213, where one MCP
 * burst created 7,453 empty notes in minutes. Surfaces as 413 at the HTTP
 * layer.
 */
export class BatchTooLargeError extends Error {
  code = "BATCH_TOO_LARGE" as const;
  // Stable error_type (vault#554) — additive; matches the string REST has
  // hardcoded in its json response since #213.
  error_type = "batch_too_large" as const;
  limit: number;
  got: number;

  constructor(got: number) {
    super(`batch_too_large: max ${MAX_BATCH_SIZE} notes per call, got ${got}`);
    this.name = "BatchTooLargeError";
    this.limit = MAX_BATCH_SIZE;
    this.got = got;
  }
}

