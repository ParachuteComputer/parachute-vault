/**
 * Vault projection — computes a comprehensive description of the vault
 * (tags-with-schemas + effective inheritance + indexed-field catalog +
 * query hints) shared by two consumers:
 *
 *   - `vault-info` MCP tool — returns the full projection as a JSON object
 *     so an agent can request a refresh mid-session.
 *   - `getServerInstruction` (MCP `initialize` response) — renders the
 *     same projection as a terse markdown brief sent once at connect.
 *
 * The projection lives outside the per-note path: it describes what kinds
 * of notes and queries are available, not the contents. Nothing here
 * depends on auth/scopes — both consumers compose this with vault config
 * (name/description) and any policy-driven framing on top.
 *
 * See vault#271 for design notes.
 */

import { Database } from "bun:sqlite";
import {
  loadSchemaConfig,
  resolveNoteSchemas,
  walkAncestors,
  type ResolvedSchemas,
  type SchemaField,
} from "./schema-defaults.ts";
import { listIndexedFields } from "./indexed-fields.ts";
import {
  listTagRecords,
  type TagFieldSchema,
  type TagRecord,
} from "./tag-schemas.ts";
import { DEFAULT_TAG_NAME } from "./tag-hierarchy.ts";
import * as noteOps from "./notes.ts";
import type { VaultStats, VaultMap } from "./types.ts";
import { GETTING_STARTED_PATH } from "./seed-packs.ts";

/**
 * Does a note live at the seeded onboarding path? Used to gate the "Start here"
 * pointer so it only fires when the guide actually exists (fresh vaults seed it;
 * pre-existing vaults that never seeded one shouldn't dangle a dead pointer).
 */
function hasGettingStartedNote(db: Database): boolean {
  try {
    const row = db
      .query("SELECT 1 FROM notes WHERE path = ? LIMIT 1")
      .get(GETTING_STARTED_PATH);
    return row != null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectionTag {
  name: string;
  description: string | null;
  /** Direct parents declared in `tags.parent_names` (verbatim, no walk). */
  parents: string[];
  /**
   * Walk-order ancestor closure (parents → grandparents → …) including the
   * implicit `_default` universal parent when present, with the tag itself
   * excluded. Empty when the tag has no parents and no `_default` exists.
   */
  effective_parents: string[];
  /**
   * Own field declarations (verbatim from `tags.fields`). Carries the full
   * `TagFieldSchema` shape — `type` (string), optional `description`,
   * `enum`, `indexed`. Width matches the on-disk row.
   */
  fields: Record<string, TagFieldSchema> | null;
  /**
   * Merged field map = own ∪ inherited (first-in-walk wins, matching
   * `resolveNoteSchemas`). Uses the `SchemaField` view returned by the
   * resolver (narrower `type` enum). Empty when no ancestor — including
   * the tag itself — declared anything.
   */
  effective_fields: Record<string, SchemaField>;
  relationships: TagRecord["relationships"] | null;
}

export interface ProjectionIndexedField {
  name: string;
  /** User-facing field type ("string" | "integer" | "boolean") drawn from the first declarer. */
  type: string;
  tags: string[];
}

export interface VaultProjection {
  tags: ProjectionTag[];
  indexed_fields: ProjectionIndexedField[];
  query_hints: string[];
  /**
   * Path of the seeded onboarding guide, when present. A pointer (NOT the note
   * body) so any connected AI is steered to read `Getting Started` first, every
   * session — the AI fetches it with `query-notes { id: "<path>" }`. Omitted
   * when no such note exists (older vaults that never seeded one). See
   * core/src/onboarding.ts.
   */
  getting_started?: string;
  /** Included when the caller requests stats; omitted otherwise. */
  stats?: VaultStats;
  /**
   * Compact structural map — total note count, tag counts, top-level
   * path-bucket counts (front-door orientation). ALWAYS present (unlike
   * `stats`): it's three cheap grouped-COUNT queries, so a fresh reader
   * orients in one `vault-info` call without also passing
   * `include_stats: true`. See `noteOps.getVaultMap`. Scope-aware callers
   * (tag-scoped tokens) get a RECOMPUTED map from the server layer — see
   * `applyTagScopeWrappers` in src/mcp-tools.ts — because path-bucket counts
   * can't be reconstructed by post-hoc filtering an unscoped rollup.
   */
  map: VaultMap;
}

// ---------------------------------------------------------------------------
// Inheritance helpers (built on the #272 resolver)
// ---------------------------------------------------------------------------

/**
 * Resolve a single tag's effective inheritance.
 *
 * Built on top of `resolveNoteSchemas({ tags: [tag] })` so the walk order
 * and conflict precedence match the runtime validator exactly. Returns:
 *
 *   - `effective_parents`: walk-order ancestor list with the tag itself
 *     excluded. Includes `_default` when a `_default` row exists, regardless
 *     of whether the tag declares it (universal-parent semantics).
 *   - `effective_fields`: merged field map (first-in-walk wins). When no
 *     ancestor contributes, this equals the tag's own `fields`.
 */
export function resolveTagInheritance(
  resolved: ResolvedSchemas,
  tag: string,
): { effective_parents: string[]; effective_fields: Record<string, SchemaField> } {
  const resolution = resolveNoteSchemas(resolved, { tags: [tag] });

  // resolveNoteSchemas returns effectiveTags (only fields-contributing tags).
  // We need the full walk for effective_parents — replay using the same
  // resolver helper so walk-order semantics stay in lockstep with #270.
  const visited = new Set<string>();
  const order: string[] = [];
  walkAncestors(tag, resolved, visited, order);
  if (resolved.allTags.has(DEFAULT_TAG_NAME) && !visited.has(DEFAULT_TAG_NAME)) {
    walkAncestors(DEFAULT_TAG_NAME, resolved, visited, order);
  }
  const effective_parents = order.filter((t) => t !== tag);

  const effective_fields: Record<string, SchemaField> = {};
  for (const [field, { spec }] of resolution.mergedFields) {
    effective_fields[field] = spec;
  }

  return { effective_parents, effective_fields };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Static query-hint catalog. Sent verbatim in both vault-info JSON and the
 * connect-time markdown projection so an agent can self-orient without
 * reading source. Edit here when query semantics change.
 */
export const QUERY_HINTS: readonly string[] = [
  "query-notes { tag: \"X\" } — all notes with tag X (includes descendants per inheritance)",
  "query-notes { tag: \"X\", metadata: { field: { op: value } } } — operator queries on indexed fields (eq/ne/gt/gte/lt/lte/in/not_in/exists)",
  "query-notes { search: \"...\" } — full-text search across content",
  "query-notes { near: { id: \"...\" }, depth: 2 } — graph neighborhood within N hops",
  "query-notes { id: \"<note-id-or-path>\" } — fetch a single note by ID or path",
] as const;

/**
 * Build the comprehensive vault projection. Pure read; no caches mutated.
 *
 * Shape rules:
 *
 *   - `tags`: only tags carrying their own `description` or `fields`. A
 *     hierarchy-only tag (parent_names but no own schema) is omitted from
 *     the catalog — its semantics live in whichever ancestor contributes
 *     fields. `effective_fields` still surfaces the merged spec when the
 *     tag *does* appear (because it has its own description/fields).
 *
 *   - `indexed_fields`: one entry per row in the `indexed_fields` table.
 *     The user-facing `type` is drawn from the first declarer's spec —
 *     declarers must agree on type (enforced at write time) so picking the
 *     first is unambiguous. `tags` lists every declarer, sorted.
 *
 *   - `stats`: included when `opts.includeStats === true`. Uses the
 *     existing `getVaultStats` shape unchanged — camelCase keys, full
 *     monthly distribution.
 *
 *   - `map`: ALWAYS included (unlike `stats`) — `getVaultMap`'s cheap
 *     total-notes / tag-counts / path-bucket-counts rollup, computed
 *     vault-wide (unscoped). See the `VaultProjection.map` doc comment for
 *     why a tag-scoped caller's map is recomputed one layer up rather than
 *     filtered here.
 */
export function buildVaultProjection(
  db: Database,
  opts?: { includeStats?: boolean },
): VaultProjection {
  const resolved = loadSchemaConfig(db);
  const records = listTagRecords(db);

  const tags: ProjectionTag[] = [];
  for (const r of records) {
    const hasOwnSchema =
      (r.description !== undefined && r.description !== null) ||
      (r.fields !== undefined && r.fields !== null && Object.keys(r.fields).length > 0);
    if (!hasOwnSchema) continue;

    const { effective_parents, effective_fields } = resolveTagInheritance(resolved, r.tag);

    tags.push({
      name: r.tag,
      description: r.description ?? null,
      parents: r.parent_names ?? [],
      effective_parents,
      fields: r.fields ?? null,
      effective_fields,
      relationships: r.relationships ?? null,
    });
  }

  const indexedRows = listIndexedFields(db);
  const indexed_fields: ProjectionIndexedField[] = indexedRows.map((row) => {
    const declarers = [...row.declarerTags].sort();
    // Recover the user-facing type from the first declarer's spec. Falls
    // back to a sqlite-derived label if the declarer's row is gone (race;
    // shouldn't happen because release drops the indexed_fields row, but
    // robust against drift).
    let userType = sqliteToUserType(row.sqliteType);
    for (const t of declarers) {
      const fields = resolved.tagToFields.get(t);
      const declared = fields?.[row.field]?.type;
      if (typeof declared === "string" && declared.length > 0) {
        userType = declared;
        break;
      }
    }
    return { name: row.field, type: userType, tags: declarers };
  });

  const projection: VaultProjection = {
    tags,
    indexed_fields,
    query_hints: [...QUERY_HINTS],
    map: noteOps.getVaultMap(db),
  };

  // A2: point any connected AI at the seeded onboarding guide (a path pointer,
  // never the body). Only when the note actually exists.
  if (hasGettingStartedNote(db)) {
    projection.getting_started = GETTING_STARTED_PATH;
  }

  if (opts?.includeStats) {
    projection.stats = noteOps.getVaultStats(db);
  }

  return projection;
}

function sqliteToUserType(t: string): string {
  if (t === "TEXT") return "string";
  if (t === "INTEGER") return "integer";
  return t.toLowerCase();
}

// ---------------------------------------------------------------------------
// Attachments orientation block (attachment-tickets design, Wave 0+1)
// ---------------------------------------------------------------------------

/**
 * The Attachments orientation block, rendered into the connect-time
 * markdown brief (`projectionToMarkdown`) so every agent learns, every
 * session, how to move file bytes into/out of this vault without spending
 * its own context on them (bytes never ride MCP either way).
 *
 * `ticketsEnabled` reflects whether THIS door has wired an
 * `AttachmentTicketProvider` (bun: always, as of the Wave 1 PR; cloud: not
 * yet — its mirror is a separate PR). `readEnabled` reflects whether it's
 * wired an `AttachmentBytesProvider` (bun: always, as of this PR — Wave 2).
 * An unwired seam omits BOTH its tool(s) from `tools/list` (see
 * `generateMcpTools`'s `attachmentTickets` / `attachmentBytes` opts) AND
 * its sentence here — the brief never dangles a pointer at a tool the
 * agent can't actually call.
 *
 * Kept as a single dense paragraph (not its own multi-line list) to stay
 * inside the connect-time brief's token budget — see
 * `projectionToMarkdown`'s doc comment.
 */
export function attachmentsInstructionBlock(opts: { ticketsEnabled: boolean; readEnabled?: boolean }): string {
  const sentences: string[] = [
    "Notes can carry file attachments (`include_attachments: true` on `query-notes` returns their rows; bytes don't ride MCP tool RESULTS unless you ask for them).",
  ];
  if (opts.ticketsEnabled) {
    sentences.push(
      "To move bytes without spending your own context, call `request-attachment-upload` / `request-attachment-download` — each mints a short-lived, single-use URL (with a ready-to-run `curl_example`) your shell spends directly; no MCP session credential is needed to spend it.",
    );
  }
  if (opts.readEnabled) {
    sentences.push(
      "To read an attachment directly into this conversation, call `read-attachment` — text comes back as a paginated `content` slice, images as a real image you can see, audio/video as a transcript pointer (never raw bytes), and PDF/other binary formats point you at a download ticket instead.",
    );
  }
  sentences.push(
    "If your runtime holds this vault's own API token, REST works too: upload = `POST {base}/storage/upload` (multipart `file`, ≤100 MB) then `POST {base}/notes/{id}/attachments` `{path, mimeType, transcribe?}`; download = `GET {base}/storage/{path}` with the same `Authorization: Bearer` (honors a `Range: bytes=a-b` header for partial reads). Audio attached with `transcribe: true` is transcribed automatically.",
  );
  return sentences.join(" ");
}

// ---------------------------------------------------------------------------
// Markdown rendering — for getServerInstruction
// ---------------------------------------------------------------------------

/**
 * Render a vault projection as a terse markdown brief for the MCP
 * `initialize` response. Keep dense — agents see this once at connect, and
 * the goal is "everything an agent needs to start using the vault sensibly,
 * with explicit pointers for refresh."
 *
 * Token budget guideline: ~600 tokens for a small vault (Aaron's, ~4 tags-
 * with-schemas) and under ~5K tokens at 50 tags-with-schemas. Listing all
 * tags-with-schemas inline is the default; cap heuristics can be added if
 * a real test shape demands it.
 */
export function projectionToMarkdown(args: {
  vaultName: string;
  description?: string | null;
  projection: VaultProjection;
  /**
   * This vault's own public coordinates, surfaced so a surface-builder never has
   * to guess the vault NAME or reconstruct the REST/MCP URLs from the connector
   * config. When `hubOrigin` is a known absolute origin (configured
   * `PARACHUTE_HUB_ORIGIN` or an active expose-state FQDN), the absolute base
   * URLs are rendered; when it's only the loopback fallback (no public origin
   * known to the vault), relative path templates are rendered with a note that
   * the origin is whatever the client connected through. The NAME is always
   * known and always surfaced. See `chooseHubOrigin` (src/mcp-install.ts).
   */
  coordinates?: { hubOrigin: string; hubOriginKnown: boolean };
  /**
   * Attachments orientation (see `attachmentsInstructionBlock`). Omitted
   * defaults to `{ ticketsEnabled: false }` — safe-by-default so a caller
   * that hasn't wired ticket support yet (or a test fixture) never
   * accidentally advertises tools it can't back.
   */
  attachments?: { ticketsEnabled: boolean; readEnabled?: boolean };
}): string {
  const { vaultName, description, projection, coordinates } = args;
  const stats = projection.stats;

  const lines: string[] = [];
  lines.push(`You are connected to Parachute Vault "${vaultName}".`);
  // vault#669 / cloud#87 recovery: a non-string description (poisoned
  // via an unguarded write door) used to throw here (`description.trim
  // is not a function`) and take down MCP `initialize` — the first
  // frame, so the connected AI never reached a tool that could repair
  // it. Skip a non-string the same way we skip null/empty: render the
  // base brief. The write doors now reject this shape; this is the
  // already-poisoned reconnect path.
  if (typeof description === "string" && description.trim().length > 0) {
    lines.push("");
    lines.push(description.trim());
  }

  // GAP 3 / vault coordinates: state the vault's own NAME + REST/MCP URLs so a
  // surface-builder (or any scripting client) doesn't have to learn them from
  // the MCP connector config. Absolute when the vault knows its public origin;
  // relative templates otherwise.
  if (coordinates) {
    lines.push("");
    lines.push("## This vault's coordinates");
    lines.push("");
    lines.push(`- Name: \`${vaultName}\``);
    if (coordinates.hubOriginKnown) {
      const base = coordinates.hubOrigin.replace(/\/$/, "");
      lines.push(`- REST API base: \`${base}/vault/${vaultName}/api/...\``);
      lines.push(`- MCP endpoint: \`${base}/vault/${vaultName}/mcp\``);
    } else {
      lines.push(
        `- REST API: \`<hub-origin>/vault/${vaultName}/api/...\` — \`<hub-origin>\` is the origin you connected through (the vault has no public origin configured to render here).`,
      );
      lines.push(`- MCP endpoint: \`<hub-origin>/vault/${vaultName}/mcp\``);
    }
  }

  // A2: surface the seeded onboarding guide so a connected AI can discover it
  // when setting up or orienting. A pointer only — the AI fetches the body on
  // demand. NOT a mandate to re-read every session; it's a start-here guide.
  if (projection.getting_started) {
    lines.push("");
    lines.push(
      `## Start here\n\nThis vault has a **${projection.getting_started}** guide — how to set it up ` +
        `and grow it (what a Parachute vault is, designing tags vs paths vs schemas, importing ` +
        `existing notes). Read it when setting up or getting oriented, or when the operator asks ` +
        `for help setting up their parachute. Fetch it with \`query-notes { id: "${projection.getting_started}" }\`.`,
    );
  }

  lines.push("");
  lines.push("## Quick orientation (call `vault-info` for full schema)");
  lines.push("");

  if (stats) {
    // Two distinct counts surface here so an agent doesn't conflate
    // them (vault#274): `tagCount` is "tags ANY note uses" — driven by
    // note_tags rows. `projection.tags.length` is "tags carrying a
    // schema declaration" — strictly smaller and the relevant denominator
    // for the schema-bearing list a few lines down. Showing only one
    // hid the gap (e.g., 100 tags but only 5 with schemas read as
    // "100 tags with schemas").
    const noteCount = stats.totalNotes;
    const tagCount = stats.tagCount;
    const withSchemas = projection.tags.length;
    const noteLabel = noteCount === 1 ? "note" : "notes";
    const tagLabel = tagCount === 1 ? "tag" : "tags";
    const tagSuffix = withSchemas > 0 ? `, ${withSchemas} with schemas` : "";
    lines.push(`- ${noteCount} ${noteLabel}, ${tagCount} ${tagLabel} total${tagSuffix}`);
  } else {
    lines.push(`- (call \`vault-info { include_stats: true }\` for note/tag counts)`);
  }

  if (projection.tags.length === 0) {
    lines.push(`- No tag schemas declared yet — every note is freeform.`);
  } else {
    const names = projection.tags.map((t) => t.name).join(", ");
    lines.push(`- ${projection.tags.length} tag${projection.tags.length === 1 ? "" : "s"} with schemas: ${names}`);
  }

  if (projection.indexed_fields.length > 0) {
    lines.push(`- Indexed metadata fields (queryable with operators):`);
    for (const f of projection.indexed_fields) {
      const declarers = f.tags.map((t) => `#${t}`).join(", ");
      lines.push(`  - ${f.name} (${f.type}; from ${declarers})`);
    }
  } else {
    lines.push(`- No indexed metadata fields.`);
  }

  // Strict fields (vault#299): surface the enforced contract so an agent knows
  // BEFORE writing which fields hard-reject on violation (not just warn).
  // Derived from each schema tag's effective fields carrying `strict: true`.
  const strictLines: string[] = [];
  for (const t of projection.tags) {
    const strictNames = Object.entries(t.effective_fields)
      .filter(([, spec]) => (spec as { strict?: boolean }).strict === true)
      .map(([name]) => name);
    if (strictNames.length > 0) {
      strictLines.push(`  - #${t.name}: ${strictNames.join(", ")}`);
    }
  }
  if (strictLines.length > 0) {
    lines.push(
      `- Strict fields (writes that violate these are REJECTED, not just warned — enum/type/required/cardinality enforced):`,
    );
    lines.push(...strictLines);
  }

  lines.push("");
  lines.push("## Querying");
  lines.push("");
  for (const hint of projection.query_hints) {
    lines.push(`- \`${hint}\``);
  }

  lines.push("");
  lines.push("## Refreshing context");
  lines.push("");
  lines.push("If schema or tags change during this session, call `vault-info` to refresh the full projection. Call `list-tags { include_schema: true }` for tag-only details.");

  lines.push("");
  lines.push("## Attachments");
  lines.push("");
  lines.push(attachmentsInstructionBlock(args.attachments ?? { ticketsEnabled: false }));

  // Scripting pointer block: the connect-time brief used to dead-end on
  // querying — an agent had no path to "how do I script/automate against this
  // vault." Point at the guide rather than inlining it, to keep this brief
  // lean (token-budget note above). Uses the concrete vault name so the mint
  // command is copy-paste ready.
  lines.push("");
  lines.push("## Scripting & automation (beyond this session)");
  lines.push("");
  lines.push(
    "This vault is also a plain HTTP API — reach for it when the user wants a script, cron job, or CI step rather than an interactive session:",
  );
  lines.push(
    `- Mint a scoped credential: \`parachute auth mint-token --scope vault:${vaultName}:read --ephemeral\` (\`--ephemeral\` = short-lived, ideal for scripts; use \`:write\` to create/edit).`,
  );
  lines.push(`- Call the REST API at \`<hub-origin>/vault/${vaultName}/api/...\`.`);
  lines.push(
    "- Full guide — copy-paste bash/Python/JS examples, plus how to design tags vs paths vs schemas: https://parachute.computer/scripting/",
  );
  lines.push("- For a prompt on a schedule with no code, see Parachute Runner.");

  return lines.join("\n");
}
