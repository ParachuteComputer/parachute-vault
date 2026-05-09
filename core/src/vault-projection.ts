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
import type { VaultStats } from "./types.ts";

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
  /** Included when the caller requests stats; omitted otherwise. */
  stats?: VaultStats;
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
  // We need the full walk for effective_parents — recompute it locally.
  const visited = new Set<string>();
  const order: string[] = [];
  walk(tag, resolved, visited, order);
  if (resolved.allTags.has(DEFAULT_TAG_NAME) && !visited.has(DEFAULT_TAG_NAME)) {
    walk(DEFAULT_TAG_NAME, resolved, visited, order);
  }
  const effective_parents = order.filter((t) => t !== tag);

  const effective_fields: Record<string, SchemaField> = {};
  for (const [field, { spec }] of resolution.mergedFields) {
    effective_fields[field] = spec;
  }

  return { effective_parents, effective_fields };
}

function walk(
  startTag: string,
  resolved: ResolvedSchemas,
  visited: Set<string>,
  out: string[],
): void {
  if (visited.has(startTag)) return;
  visited.add(startTag);
  out.push(startTag);
  const parents = resolved.tagToParents.get(startTag);
  if (!parents) return;
  for (const p of parents) walk(p, resolved, visited, out);
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
  };

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
}): string {
  const { vaultName, description, projection } = args;
  const stats = projection.stats;

  const lines: string[] = [];
  lines.push(`You are connected to Parachute Vault "${vaultName}".`);
  if (description && description.trim().length > 0) {
    lines.push("");
    lines.push(description.trim());
  }

  lines.push("");
  lines.push("## Quick orientation (call `vault-info` for full schema)");
  lines.push("");

  if (stats) {
    lines.push(`- ${stats.totalNotes} notes, ${stats.tagCount} tags`);
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

  return lines.join("\n");
}
