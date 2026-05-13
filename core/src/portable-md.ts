/**
 * Portable markdown knowledge-base format — lossless export/import for any
 * markdown+frontmatter consumer (Obsidian, Logseq, Foam, Quartz, Dendron,
 * static-site generators).
 *
 * The format is **not Obsidian-specific** — Obsidian happens to consume it
 * cleanly because Obsidian's `.md + YAML frontmatter` shape is the
 * de-facto knowledge-base interchange format. Anchoring the function name
 * to the format (rather than to one consumer) keeps the door open as
 * other consumers adopt the same shape.
 *
 * ## Why this exists separately from `obsidian.ts`
 *
 * `obsidian.ts` ships a lossy export (no IDs, no typed links, no
 * schemas, no attachments, no idempotency). That's fine for one-shot
 * "give me an Obsidian copy" but it can't round-trip back to byte-equivalent
 * vault state. Several real use cases want round-trip:
 *   - Gitcoin Brain's vault-as-primary + git-as-projection architecture.
 *   - Disaster recovery (backups that restore exact state).
 *   - Audit trails not dependent on vault's internal storage.
 *   - Migrations between vault hosts.
 *
 * This module implements the lossless format. `obsidian.ts` stays as a
 * deprecated back-compat shim so existing callers don't break.
 *
 * ## Format
 *
 * ```
 * <export-dir>/
 *   .parachute/
 *     vault.yaml              # vault meta + export format version
 *     schemas/<tag>.yaml      # per-tag: description, fields, relationships, parent_names
 *     attachments/<att-id>/<filename>   # binary files (PR 2; #308)
 *   <note.path>.md            # one file per note
 * ```
 *
 * ## Frontmatter (per-note, fixed top-level key order)
 *
 * ```yaml
 * ---
 * id: 01HGZ9...
 * path: Inbox/2026-05-12-meeting
 * tags:
 *   - meeting
 *   - donor-pipeline
 * metadata:                   # alpha-sorted keys
 *   priority: high
 * links:                      # typed links (non-wikilink)
 *   - target: 01HGZA...
 *     relationship: derived-from
 *     metadata: { source: git://... }
 * attachments:                # PR 2 (#308)
 *   - id: att_01HGZB...
 *     path: 2026-05-12/audio.m4a
 *     mime_type: audio/mp4
 * created_at: 2026-05-12T10:00:00.000Z
 * updated_at: 2026-05-12T11:23:45.123Z
 * ---
 * <note content with [[wikilinks]] preserved verbatim>
 * ```
 *
 * ## Idempotency
 *
 * - Top-level frontmatter keys emitted in fixed order (above).
 * - Nested object keys alpha-sorted.
 * - Booleans `true`/`false`; numbers as-is; strings bare unless they
 *   contain YAML-meaningful characters, then single-quoted.
 * - Trailing newline after closing `---`.
 *
 * Pin: vault → export → re-export → byte-identical bytes.
 *
 * See vault#308.
 */

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "fs";
import { join, relative, extname, dirname } from "path";
import type { Store, Note, Link, Attachment } from "./types.js";
import type { TagRecord } from "./tag-schemas.js";

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

/** Bumped if/when the export format makes a backward-incompatible change. */
export const EXPORT_FORMAT_VERSION = 1;

/** Sidecar directory name. Dot-prefixed so it matches Obsidian's `.obsidian/`
 *  convention — directory walkers that skip dot-dirs (including our own
 *  `walkMarkdownFiles` below) won't accidentally re-import schemas/vault-meta
 *  as notes; consumers like Logseq/Foam/Quartz don't see the sidecar. */
export const SIDECAR_DIR = ".parachute";

/** Order in which top-level frontmatter keys are emitted. Fixed — required
 *  for byte-identical re-exports of unchanged vault state. */
const FRONTMATTER_KEY_ORDER = [
  "id",
  "path",
  "tags",
  "metadata",
  "links",
  "attachments",
  "created_at",
  "updated_at",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-note shape written into one .md file (frontmatter + content). */
export interface PortableNote {
  id: string;
  path?: string;
  content: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  links?: PortableLink[];
  attachments?: PortableAttachmentRef[];
  created_at: string;
  updated_at?: string;
}

/** A typed-link relationship serialized in frontmatter. Target is a note ID
 *  (stable across renames). Missing targets at import time skip with a
 *  warning rather than aborting the import. */
export interface PortableLink {
  target: string;
  relationship: string;
  metadata?: Record<string, unknown>;
}

/** Attachment reference in frontmatter. Binary file lives at
 *  `.parachute/attachments/<id>/<filename>`. PR 2 wires the file copy;
 *  PR 1 emits the reference. */
export interface PortableAttachmentRef {
  id: string;
  path: string;
  mime_type: string;
  metadata?: Record<string, unknown>;
}

/** Vault-level metadata in `.parachute/vault.yaml`. */
export interface PortableVaultMeta {
  name?: string;
  description?: string;
  export_format_version: number;
  exported_at: string;
}

/** Stats returned from `exportVaultToDir`. */
export interface ExportStats {
  notes: number;
  schemas: number;
  /** Set when caller passed `since`; counts notes whose `updated_at >= since`. */
  filtered_by_since: boolean;
}

// ---------------------------------------------------------------------------
// YAML emitter (idempotent, hand-rolled — no new dep)
// ---------------------------------------------------------------------------

/**
 * Quote a string when it contains YAML-meaningful characters. Mirrors the
 * subset of YAML 1.2 plain-scalar rules that matter for our payloads:
 * leading whitespace / `-` / `?` / `:` / `#` / `&` / `*` / `!` / `|` / `>`,
 * leading/trailing whitespace, embedded `:` followed by whitespace, or
 * values that would parse as boolean/null/numeric.
 */
function needsQuote(s: string): boolean {
  if (s === "") return true;
  if (s !== s.trim()) return true;
  // Booleans / null / numbers — would round-trip as a different type.
  if (s === "true" || s === "false" || s === "null") return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  // YAML-meaningful starters.
  if (/^[-?:&*!|>%@`#]/.test(s)) return true;
  // Embedded `: ` (key/value separator) or `#` (comment) makes a plain
  // scalar ambiguous.
  if (s.includes(": ") || s.includes(" #")) return true;
  return false;
}

function quoteString(s: string): string {
  // Single-quote — easier than double for embedded backslashes; YAML 1.2
  // escapes single quotes by doubling them.
  return `'${s.replace(/'/g, "''")}'`;
}

function emitScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") {
    return needsQuote(value) ? quoteString(value) : value;
  }
  // Fallback — shouldn't happen for primitives but defensive.
  return quoteString(String(value));
}

/**
 * Emit an object as YAML at the given indent depth. Keys alpha-sorted for
 * idempotency. Nested objects recurse; arrays use block-style for
 * readability. Inline `{ ... }` is used only for objects nested in array
 * items at depth >= 2 to keep the output compact.
 */
function emitObject(obj: Record<string, unknown>, indent: number): string {
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return "{}";
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const key of keys) {
    lines.push(`${pad}${key}: ${emitValueInline(obj[key], indent + 1) ?? ""}`);
    const block = emitValueBlock(obj[key], indent + 1);
    if (block !== null) {
      // Block form was used — replace the inline placeholder above with the
      // block form. Done by overwriting the last pushed line with key: only.
      lines[lines.length - 1] = `${pad}${key}:`;
      lines.push(block);
    }
  }
  return lines.join("\n");
}

/**
 * Inline form of a value when it fits on one line; null when block form
 * should be used instead (caller emits `key:` then the block on the next
 * lines).
 */
function emitValueInline(value: unknown, indent: number): string | null {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return emitScalar(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return null; // block form
  }
  if (typeof value === "object") {
    if (Object.keys(value as object).length === 0) return "{}";
    return null; // block form
  }
  return emitScalar(value);
}

function emitValueBlock(value: unknown, indent: number): string | null {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value) && value.length > 0) {
    const lines: string[] = [];
    for (const item of value) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        // Scalar / array item — single line with `- `.
        lines.push(`${pad}- ${emitScalar(item)}`);
      } else {
        // Object item: emit keys with `- ` prefix on the first key, hanging
        // indent for the rest. Alpha-sort keys for idempotency.
        const keys = Object.keys(item as Record<string, unknown>).sort();
        const obj = item as Record<string, unknown>;
        let first = true;
        for (const key of keys) {
          const prefix = first ? `${pad}- ` : `${pad}  `;
          const inline = emitValueInline(obj[key], indent + 2);
          if (inline !== null) {
            lines.push(`${prefix}${key}: ${inline}`);
          } else {
            lines.push(`${prefix}${key}:`);
            const block = emitValueBlock(obj[key], indent + 2);
            if (block !== null) lines.push(block);
          }
          first = false;
        }
      }
    }
    return lines.join("\n");
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (Object.keys(value as object).length === 0) return null;
    return emitObject(value as Record<string, unknown>, indent);
  }
  return null;
}

/**
 * Emit a complete YAML document. Used for sidecar files
 * (`vault.yaml`, `schemas/<tag>.yaml`). Trailing newline included.
 */
export function emitYamlDoc(obj: Record<string, unknown>): string {
  return emitObject(obj, 0) + "\n";
}

// ---------------------------------------------------------------------------
// Frontmatter emitter (note-level)
// ---------------------------------------------------------------------------

/**
 * Build the ordered frontmatter object for a note. Only includes keys whose
 * value is non-empty (no `metadata: {}` lines, no `links: []`) so unchanged
 * vaults produce minimal diffs.
 */
function buildFrontmatter(note: PortableNote): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  fm.id = note.id;
  if (note.path) fm.path = note.path;
  if (note.tags && note.tags.length > 0) fm.tags = [...note.tags].sort();
  if (note.metadata && Object.keys(note.metadata).length > 0) fm.metadata = note.metadata;
  if (note.links && note.links.length > 0) fm.links = note.links;
  if (note.attachments && note.attachments.length > 0) fm.attachments = note.attachments;
  fm.created_at = note.created_at;
  if (note.updated_at) fm.updated_at = note.updated_at;
  return fm;
}

/**
 * Render a note as portable markdown: `--- <frontmatter> --- <content>`.
 * Frontmatter keys in `FRONTMATTER_KEY_ORDER`; nested objects alpha-sorted.
 * Trailing newline preserved from `content` (or one is added if absent).
 */
export function toPortableMarkdown(note: PortableNote): string {
  const fm = buildFrontmatter(note);
  let out = "---\n";
  for (const key of FRONTMATTER_KEY_ORDER) {
    if (!(key in fm)) continue;
    const value = fm[key];
    const inline = emitValueInline(value, 1);
    if (inline !== null) {
      out += `${key}: ${inline}\n`;
    } else {
      out += `${key}:\n`;
      const block = emitValueBlock(value, 1);
      if (block !== null) out += `${block}\n`;
    }
  }
  out += "---\n";
  // Preserve content as-is; ensure exactly one trailing newline if missing.
  out += note.content;
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

/**
 * Determine the file path for an exported portable-md note. Notes with a
 * `path` use it; pathless notes use `_unpathed/<id>.md` (no date-prefix
 * coincidence with user content).
 */
export function portableExportFilePath(note: PortableNote): string {
  if (note.path) return note.path + ".md";
  return `_unpathed/${note.id}.md`;
}

// ---------------------------------------------------------------------------
// Pull-from-store: build PortableNote shapes
// ---------------------------------------------------------------------------

/**
 * Convert a store `Note` + its typed `Link`s + `Attachment`s into the
 * PortableNote shape. Wikilinks are excluded from the `links` block —
 * they're recoverable from the content text on import. Stable orderings:
 * tags alpha-sorted; links sorted by `(relationship, target)`; attachments
 * sorted by `id`.
 */
export async function notetoPortable(
  note: Note,
  store: Store,
): Promise<PortableNote> {
  // Typed links only (exclude wikilink — that's the content's job).
  const allLinks = await store.getLinks(note.id, { direction: "outbound" });
  const typedLinks: PortableLink[] = allLinks
    .filter((l) => l.relationship !== "wikilink")
    .map((l) => ({
      target: l.targetId,
      relationship: l.relationship,
      ...(l.metadata && Object.keys(l.metadata).length > 0 ? { metadata: l.metadata } : {}),
    }))
    .sort((a, b) =>
      a.relationship.localeCompare(b.relationship) || a.target.localeCompare(b.target),
    );

  const atts = await store.getAttachments(note.id);
  const attachments: PortableAttachmentRef[] = atts
    .map((a) => ({
      id: a.id,
      path: a.path,
      mime_type: a.mimeType,
      ...(a.metadata && Object.keys(a.metadata).length > 0 ? { metadata: a.metadata } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const result: PortableNote = {
    id: note.id,
    ...(note.path ? { path: note.path } : {}),
    content: note.content,
    ...(note.metadata && Object.keys(note.metadata).length > 0 ? { metadata: note.metadata } : {}),
    ...(note.tags && note.tags.length > 0 ? { tags: [...note.tags].sort() } : {}),
    ...(typedLinks.length > 0 ? { links: typedLinks } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    created_at: note.createdAt,
    ...(note.updatedAt ? { updated_at: note.updatedAt } : {}),
  };
  return result;
}

// ---------------------------------------------------------------------------
// Vault-level export
// ---------------------------------------------------------------------------

export interface ExportOptions {
  /** Output directory. Created if missing; existing files overwritten. */
  outDir: string;
  /** Vault name for the sidecar's `vault.yaml`. Defaults to "default". */
  vaultName?: string;
  /** Vault description (free text) for the sidecar's `vault.yaml`. */
  vaultDescription?: string;
  /** Incremental: only export notes with `updated_at >= since`. */
  since?: string;
  /** Override `exported_at` timestamp (test seam — keeps re-export byte-equiv). */
  exportedAt?: string;
}

/**
 * Export a vault to a portable-markdown directory. Writes:
 *   - `<outDir>/.parachute/vault.yaml`
 *   - `<outDir>/.parachute/schemas/<tag>.yaml` for each tag that declares
 *     description/fields/relationships/parent_names.
 *   - `<outDir>/<note.path>.md` for each note (or `_unpathed/<id>.md`).
 *
 * Attachment file-copying is PR 2 (#308). The PortableNote shape includes
 * attachment refs already; the binaries land in PR 2.
 */
export async function exportVaultToDir(
  store: Store,
  opts: ExportOptions,
): Promise<ExportStats> {
  const outDir = opts.outDir;
  mkdirSync(outDir, { recursive: true });
  const sidecar = join(outDir, SIDECAR_DIR);
  mkdirSync(sidecar, { recursive: true });
  mkdirSync(join(sidecar, "schemas"), { recursive: true });

  // 1. vault.yaml — vault meta + export format version. Trailing
  // export-time timestamp is the one place where re-exports legitimately
  // produce different bytes; callers wanting byte-equiv re-export pass
  // `exportedAt` explicitly (tests do).
  const vaultMeta: PortableVaultMeta = {
    export_format_version: EXPORT_FORMAT_VERSION,
    exported_at: opts.exportedAt ?? new Date().toISOString(),
    ...(opts.vaultName ? { name: opts.vaultName } : {}),
    ...(opts.vaultDescription ? { description: opts.vaultDescription } : {}),
  };
  writeFileSync(join(sidecar, "vault.yaml"), emitYamlDoc(vaultMeta as unknown as Record<string, unknown>));

  // 2. Per-tag schemas. Only tags carrying at least one schema-shaped
  // field (description, fields, relationships, parent_names) get a file;
  // tags that are just-a-name don't pollute the sidecar.
  const tagRecords = await store.listTagRecords();
  let schemasWritten = 0;
  for (const tag of tagRecords) {
    if (!hasSchemaContent(tag)) continue;
    const filename = sanitizeTagFilename(tag.tag) + ".yaml";
    const doc: Record<string, unknown> = { name: tag.tag };
    if (tag.description !== undefined) doc.description = tag.description;
    if (tag.fields !== undefined) doc.fields = tag.fields;
    if (tag.relationships !== undefined) doc.relationships = tag.relationships;
    if (tag.parent_names !== undefined && tag.parent_names.length > 0) {
      doc.parent_names = tag.parent_names;
    }
    writeFileSync(join(sidecar, "schemas", filename), emitYamlDoc(doc));
    schemasWritten++;
  }

  // 3. Per-note files. Iterate the full vault; if `since` is set, filter
  // by updated_at >= since (incremental export).
  const allNotes = await store.queryNotes({ limit: 1_000_000, sort: "asc" });
  const since = opts.since;
  let notesWritten = 0;
  for (const note of allNotes) {
    if (since && !shouldIncludeForSince(note, since)) continue;
    const portable = await notetoPortable(note, store);
    const relPath = portableExportFilePath(portable);
    const fullPath = join(outDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, toPortableMarkdown(portable));
    notesWritten++;
  }

  return {
    notes: notesWritten,
    schemas: schemasWritten,
    filtered_by_since: since !== undefined,
  };
}

function hasSchemaContent(tag: TagRecord): boolean {
  if (tag.description !== undefined && tag.description.length > 0) return true;
  if (tag.fields && Object.keys(tag.fields).length > 0) return true;
  if (tag.relationships && Object.keys(tag.relationships).length > 0) return true;
  if (tag.parent_names && tag.parent_names.length > 0) return true;
  return false;
}

/**
 * Tag names may contain `/` (sub-tag hierarchy). Replace with `__` for the
 * filename so the sidecar stays flat: `.parachute/schemas/<safe>.yaml`.
 * Round-trip on import recovers the `/` form from the `name:` key inside
 * the file, not from the filename.
 */
function sanitizeTagFilename(tag: string): string {
  return tag.replace(/[/\\]/g, "__");
}

function shouldIncludeForSince(note: Note, since: string): boolean {
  const stamp = note.updatedAt ?? note.createdAt;
  return stamp >= since;
}

// ---------------------------------------------------------------------------
// Parser — shared with `obsidian.ts` (legacy back-compat) via re-export
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from markdown content. Returns
 * { frontmatter, content } where content has frontmatter stripped.
 *
 * Hand-rolled parser — no YAML library dep. Handles the subset of YAML
 * the emitter produces plus the legacy obsidian shapes the importer has
 * to accept: bare strings, single-quoted strings, booleans, integers,
 * floats, inline arrays `[a, b]`, block arrays, block objects, and the
 * `key: { inline }` form.
 *
 * This is the canonical parser for the portable-md format. The legacy
 * `parseFrontmatter` in `obsidian.ts` delegates here.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  if (!raw.startsWith("---")) return { frontmatter: {}, content: raw };
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) return { frontmatter: {}, content: raw };
  const yamlBlock = raw.slice(4, endIdx); // skip opening "---\n"
  const content = raw.slice(endIdx + 4).replace(/^\n/, "");
  return { frontmatter: parseBlock(yamlBlock, 0).value, content };
}

interface ParseResult {
  value: Record<string, unknown>;
  consumed: number; // number of lines consumed (for nested blocks)
}

/**
 * Parse a YAML block at a given indent depth. Returns the parsed object
 * plus the line count consumed (so callers can advance past nested blocks).
 *
 * The parser handles the shapes the emitter produces. Unknown shapes
 * (anchors, references, multi-document streams, multi-line strings) are
 * not supported — out of scope for the export format.
 */
function parseBlock(text: string, baseIndent: number): ParseResult {
  const lines = text.split("\n");
  const result: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }
    const indent = countLeadingSpaces(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) { i++; continue; } // shouldn't happen at this level

    const kv = line.slice(baseIndent).match(/^([\w][\w-]*):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1]!;
    const valueText = kv[2]!.trim();

    if (valueText === "") {
      // Block-form value follows. Could be either an object or an array.
      // Determine by peeking at the next non-blank line's first
      // non-whitespace character — `-` ⇒ array, otherwise object.
      const peekIdx = peekNextContent(lines, i + 1);
      if (peekIdx === -1) {
        result[key] = "";
        i++;
        continue;
      }
      const peekLine = lines[peekIdx]!;
      const peekIndent = countLeadingSpaces(peekLine);
      if (peekIndent <= baseIndent) {
        // No nested content — empty value.
        result[key] = "";
        i++;
        continue;
      }
      if (peekLine.slice(peekIndent).startsWith("- ")) {
        const { value, consumed } = parseArrayBlock(lines, i + 1, peekIndent);
        result[key] = value;
        i = i + 1 + consumed;
      } else {
        const block = lines.slice(i + 1).join("\n");
        const { value, consumed } = parseBlock(block, peekIndent);
        result[key] = value;
        i = i + 1 + consumed;
      }
    } else {
      result[key] = parseScalarOrInline(valueText);
      i++;
    }
  }
  return { value: result, consumed: i };
}

function peekNextContent(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i]!.trim() !== "") return i;
  }
  return -1;
}

function countLeadingSpaces(s: string): number {
  let n = 0;
  while (n < s.length && s[n] === " ") n++;
  return n;
}

/**
 * Parse an array block: lines starting with `- ` at `arrayIndent`.
 * Returns the array + lines consumed.
 *
 * Each `- ` introduces an item:
 *   - `- value` → scalar item.
 *   - `- key: value` (with possible following indented keys) → object item.
 */
function parseArrayBlock(lines: string[], start: number, arrayIndent: number): { value: unknown[]; consumed: number } {
  const result: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }
    const indent = countLeadingSpaces(line);
    if (indent < arrayIndent) break;
    if (indent > arrayIndent) { i++; continue; }
    if (!line.slice(indent).startsWith("- ")) break;

    // First content after `- `.
    const after = line.slice(indent + 2).trim();
    // Is this a scalar item (`- foo`) or an object item (`- key: value`)?
    const objMatch = after.match(/^([\w][\w-]*):\s*(.*)$/);
    if (!objMatch) {
      result.push(parseScalarOrInline(after));
      i++;
      continue;
    }

    // Object item. Build a fake block: the first line becomes a key at
    // indent+2, and subsequent lines at indent+2 are siblings. We
    // synthesize a normalized block string and recurse.
    const itemIndent = indent + 2;
    const itemKey = objMatch[1]!;
    const itemValue = objMatch[2]!.trim();
    const itemObj: Record<string, unknown> = {};
    if (itemValue === "") {
      // First key's value is a nested block — look at next line.
      const peekIdx = peekNextContent(lines, i + 1);
      if (peekIdx !== -1) {
        const peekLine = lines[peekIdx]!;
        const peekIndent = countLeadingSpaces(peekLine);
        if (peekIndent > itemIndent) {
          // Nested block under this first key.
          if (peekLine.slice(peekIndent).startsWith("- ")) {
            const { value, consumed } = parseArrayBlock(lines, i + 1, peekIndent);
            itemObj[itemKey] = value;
            i = i + 1 + consumed;
          } else {
            const block = lines.slice(i + 1).join("\n");
            const { value, consumed } = parseBlock(block, peekIndent);
            itemObj[itemKey] = value;
            i = i + 1 + consumed;
          }
        } else {
          itemObj[itemKey] = "";
          i++;
        }
      } else {
        itemObj[itemKey] = "";
        i++;
      }
    } else {
      itemObj[itemKey] = parseScalarOrInline(itemValue);
      i++;
    }

    // Continue consuming sibling keys at itemIndent that aren't `- `-prefixed.
    while (i < lines.length) {
      const sib = lines[i]!;
      if (sib.trim() === "") { i++; continue; }
      const sibIndent = countLeadingSpaces(sib);
      if (sibIndent !== itemIndent) break;
      if (sib.slice(sibIndent).startsWith("- ")) break;
      const sibKv = sib.slice(sibIndent).match(/^([\w][\w-]*):\s*(.*)$/);
      if (!sibKv) break;
      const sibKey = sibKv[1]!;
      const sibValue = sibKv[2]!.trim();
      if (sibValue === "") {
        const peekIdx = peekNextContent(lines, i + 1);
        if (peekIdx !== -1) {
          const peekLine = lines[peekIdx]!;
          const peekIndent = countLeadingSpaces(peekLine);
          if (peekIndent > itemIndent) {
            if (peekLine.slice(peekIndent).startsWith("- ")) {
              const { value, consumed } = parseArrayBlock(lines, i + 1, peekIndent);
              itemObj[sibKey] = value;
              i = i + 1 + consumed;
            } else {
              const block = lines.slice(i + 1).join("\n");
              const { value, consumed } = parseBlock(block, peekIndent);
              itemObj[sibKey] = value;
              i = i + 1 + consumed;
            }
            continue;
          }
        }
        itemObj[sibKey] = "";
        i++;
      } else {
        itemObj[sibKey] = parseScalarOrInline(sibValue);
        i++;
      }
    }

    result.push(itemObj);
  }
  return { value: result, consumed: i - start };
}

/**
 * Parse a scalar or inline form (`[a, b]`, `{ k: v }`). Used for the
 * value portion of `key: value` lines.
 */
function parseScalarOrInline(s: string): unknown {
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => parseScalarOrInline(part.trim()));
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return {};
    const out: Record<string, unknown> = {};
    // Simple split on `, ` — sufficient for our emitter's shape (no
    // nested commas at this level since nested objects use block form).
    for (const part of inner.split(",")) {
      const m = part.trim().match(/^([\w][\w-]*):\s*(.*)$/);
      if (m) out[m[1]!] = parseScalarOrInline(m[2]!.trim());
    }
    return out;
  }
  return unquote(s);
}

function unquote(s: string): unknown {
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// ---------------------------------------------------------------------------
// Directory walking — shared with obsidian.ts
// ---------------------------------------------------------------------------

/** Recursively list all .md files in a directory, excluding hidden dirs
 *  (including `.parachute/` and `.obsidian/`). */
export function walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      if (entry.startsWith(".")) continue;
      if (entry === "node_modules") continue;
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && extname(entry).toLowerCase() === ".md") results.push(full);
    }
  }
  walk(dir);
  return results.sort();
}

/** Extract inline #tags from markdown content. Excludes tags in code blocks. */
export function extractInlineTags(content: string): string[] {
  let stripped = content.replace(/```[\s\S]*?```/g, "");
  stripped = stripped.replace(/`[^`\n]+`/g, "");
  const tags = new Set<string>();
  const regex = /(?:^|\s)#([\w][\w/-]*[\w]|[\w])/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stripped)) !== null) {
    tags.add(match[1]!.toLowerCase());
  }
  return [...tags];
}
