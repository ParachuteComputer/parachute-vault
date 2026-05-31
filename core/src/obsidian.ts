/**
 * Obsidian-compatible markdown export/import — back-compat shim.
 *
 * @deprecated The canonical home for the markdown knowledge-base format
 * is `portable-md.ts`. The format isn't Obsidian-specific (it's consumed
 * unchanged by Logseq, Foam, Quartz, Dendron, and most markdown-shaped
 * static-site generators) — anchoring the function name to the format
 * keeps the door open as other consumers adopt the same shape. See
 * vault#308.
 *
 * What lives here:
 *   - `toObsidianMarkdown` — the **legacy** lossy emitter (flat
 *     frontmatter, no IDs, no typed links, no attachments). Kept for
 *     existing callers; for round-trippable exports use
 *     `toPortableMarkdown` in `portable-md.ts`.
 *   - `parseObsidianVault` / `parseObsidianFile` — directory + file
 *     parsers. These delegate to `portable-md.ts`'s parser, which
 *     handles both the new lossless shape and the legacy flat
 *     frontmatter shape.
 *   - Re-exports of `parseFrontmatter`, `extractInlineTags`,
 *     `walkMarkdownFiles` from `portable-md.ts` so existing imports
 *     keep working without code-level churn.
 *
 * New code should import from `portable-md.ts` directly.
 */

import { readFileSync } from "fs";
import { relative } from "path";

// Re-export the canonical parser helpers so existing callers (and tests)
// keep working against the legacy import path.
export {
  parseFrontmatter,
  extractInlineTags,
  walkMarkdownFiles,
  normalizeTagValue,
  isMarkdownExtension,
  isExcludedPath,
} from "./portable-md.js";

import {
  parseFrontmatter,
  walkMarkdownFiles,
  extractInlineTags,
  normalizeTagValue,
} from "./portable-md.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObsidianNote {
  /** Relative path without .md/.markdown extension (e.g.,
   *  "Projects/Parachute/README"). A frontmatter `path:` override wins. */
  path: string;
  /** Raw markdown content (frontmatter stripped) */
  content: string;
  /** Parsed YAML frontmatter with hoisted keys (id/path/tags/timestamps)
   *  removed — i.e. the metadata bag the importer persists. */
  frontmatter: Record<string, unknown>;
  /** Tags from both frontmatter and inline #tags */
  tags: string[];
  /** Frontmatter `id` (string, trimmed, non-empty), if present. The write
   *  adapter upserts-by-id when set. Absent → field omitted. */
  id?: string;
  /** Frontmatter `created_at` / `createdAt` (verbatim string, no Date
   *  coercion), if present. Preserved on write. */
  createdAt?: string;
  /** Frontmatter `updated_at` / `updatedAt` (verbatim string), if present. */
  updatedAt?: string;
}

export interface ImportStats {
  files: number;
  imported: number;
  skipped: number;
  tags: number;
  errors: { path: string; error: string }[];
}

/**
 * Tags from frontmatter (handles both array and string formats), routed
 * through the canonical `normalizeTagValue` (contract C6 / §1.4) so they
 * are slug-validated, lowercased, and `#`-stripped identically to the web
 * parser. A string value is split on `/[,\s]+/` (comma OR whitespace).
 * Invalid values (`My Tag!`, non-scalars) are dropped.
 */
function extractFrontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  if (raw === undefined || raw === null) return [];
  const candidates: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];
  const out: string[] = [];
  for (const c of candidates) {
    const tag = normalizeTagValue(c);
    if (tag) out.push(tag);
  }
  return out;
}

/**
 * Normalize an import path (contract §1.8). Case-PRESERVING: backslash →
 * forward slash, strip trailing `.md`/`.markdown`, collapse repeated
 * slashes, trim leading/trailing slashes. Empty result → "". Does not
 * lowercase or slugify (friend-friendly paths). Agrees with the Store's
 * `paths.ts::normalizePath` on the slug rules; additionally strips
 * `.markdown` and returns "" (not null) for empty.
 */
function normalizeImportPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\.(md|markdown)$/i, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

// ---------------------------------------------------------------------------
// Parse a single file
// ---------------------------------------------------------------------------

export function parseObsidianFile(filePath: string, vaultRoot: string): ObsidianNote {
  const raw = readFileSync(filePath, "utf-8");
  const { frontmatter, content } = parseFrontmatter(raw);

  // Path: a frontmatter `path:` override wins (contract §1.8); otherwise
  // derive from the source filename. Both routed through the
  // case-preserving `normalizeImportPath` (strips .md/.markdown,
  // backslash→/, collapse + trim slashes).
  const fmPath = frontmatter.path;
  const path =
    typeof fmPath === "string" && fmPath.trim() !== ""
      ? normalizeImportPath(fmPath.trim())
      : normalizeImportPath(relative(vaultRoot, filePath));

  // Hoist id (contract §1.5) — string, trimmed, non-empty.
  const rawId = frontmatter.id;
  const id =
    typeof rawId === "string" && rawId.trim() !== "" ? rawId.trim() : undefined;

  // Hoist created_at/updated_at (contract §1.6) — verbatim string, with
  // camelCase fallback, NO Date coercion.
  const createdAt = hoistTimestamp(frontmatter.created_at ?? frontmatter.createdAt);
  const updatedAt = hoistTimestamp(frontmatter.updated_at ?? frontmatter.updatedAt);

  // Merge tags from frontmatter and inline.
  const fmTags = extractFrontmatterTags(frontmatter);
  const inlineTags = extractInlineTags(content);
  const allTags = [...new Set([...fmTags, ...inlineTags])];

  // Strip all hoisted keys from the metadata bag (contract C7) — they
  // become first-class note fields / the tags table, not metadata.
  const metadata = { ...frontmatter };
  delete metadata.id;
  delete metadata.path;
  delete metadata.tags;
  delete metadata.created_at;
  delete metadata.createdAt;
  delete metadata.updated_at;
  delete metadata.updatedAt;

  const note: ObsidianNote = { path, content, frontmatter: metadata, tags: allTags };
  if (id !== undefined) note.id = id;
  if (createdAt !== undefined) note.createdAt = createdAt;
  if (updatedAt !== undefined) note.updatedAt = updatedAt;
  return note;
}

/** Coerce a hoisted timestamp frontmatter value to a verbatim trimmed
 *  string (contract §1.6) — no Date coercion. Numbers (e.g. a bare year
 *  `2024`) stringify; non-scalars are dropped. */
function hoistTimestamp(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? undefined : t;
  }
  if (typeof v === "number") return String(v);
  return undefined;
}

// ---------------------------------------------------------------------------
// Import an Obsidian vault
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Override vault name to import into */
  vault?: string;
  /** Dry run — don't actually import */
  dryRun?: boolean;
}

/**
 * Parse an entire Obsidian vault directory into ObsidianNote objects.
 * Does not write to the database — caller handles that.
 */
export function parseObsidianVault(vaultPath: string): {
  notes: ObsidianNote[];
  errors: { path: string; error: string }[];
} {
  const files = walkMarkdownFiles(vaultPath);
  const notes: ObsidianNote[] = [];
  const errors: { path: string; error: string }[] = [];

  for (const file of files) {
    try {
      const note = parseObsidianFile(file, vaultPath);
      notes.push(note);
    } catch (err) {
      errors.push({
        path: relative(vaultPath, file),
        error: err instanceof Error ? err.message : "parse error",
      });
    }
  }

  return { notes, errors };
}

// ---------------------------------------------------------------------------
// Legacy import write adapter (contract C10)
// ---------------------------------------------------------------------------

import type { Note } from "./types.js";

/**
 * The Store surface `importObsidianNotes` needs. `SqliteStore` satisfies
 * this structurally; defined locally (rather than importing the full
 * `Store` interface) because `createNoteRaw` is a Store-implementation
 * method, not on the public `Store` interface.
 */
export interface ImportWriteStore {
  getNote(id: string): Promise<Note | null>;
  getNoteByPath(path: string, extension?: string): Promise<Note | null>;
  createNoteRaw(
    content: string,
    opts?: {
      id?: string;
      path?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
      created_at?: string;
      extension?: string;
    },
  ): Promise<Note>;
  updateNote(
    id: string,
    updates: { content?: string; path?: string; metadata?: Record<string, unknown> },
  ): Promise<Note>;
  tagNote(noteId: string, tags: string[]): Promise<void>;
  untagNote(noteId: string, tags: string[]): Promise<void>;
  restoreNoteTimestamps(id: string, createdAt: string, updatedAt: string): Promise<void>;
}

/**
 * Write parsed Obsidian notes into the Store (legacy import path —
 * contract C10). Behavior:
 *
 *  - **id-aware upsert** (correction #4): a frontmatter `id` upserts by id.
 *    If that id already exists at a DIFFERENT path, the import does NOT
 *    overwrite the unrelated note — it skips with a warning. Same id +
 *    same/absent path updates in place.
 *  - **timestamp preservation** (correction #3): frontmatter
 *    `created_at`/`updated_at` are pegged via `restoreNoteTimestamps` on
 *    BOTH the id and no-id branches (the no-id path mints an id first).
 *  - **intra-batch path-dedup + write isolation** (correction #5):
 *    `Foo.md` + `Foo.markdown` both normalize to path `Foo`; the second is
 *    counted skipped (dedup OR a caught `PathConflictError`). Each note's
 *    write is wrapped in try/catch so one failure never aborts the batch.
 *
 * Does NOT run wikilink sync — the caller does a single post-batch pass
 * (much faster for large vaults). Returns `{ imported, skipped }`.
 */
export async function importObsidianNotes(
  store: ImportWriteStore,
  notes: ObsidianNote[],
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  // `getNoteByPath` matches COLLATE NOCASE, so the dedup key is lowercased.
  const seenPaths = new Set<string>();

  for (const note of notes) {
    const metadata = Object.keys(note.frontmatter).length > 0 ? note.frontmatter : undefined;

    try {
      if (note.id) {
        const existing = await store.getNote(note.id);
        if (existing && existing.path != null && note.path && existing.path !== note.path) {
          console.warn(
            `skip: id ${note.id} exists at "${existing.path}", incoming path "${note.path}" differs`,
          );
          skipped++;
          continue;
        }
        if (existing) {
          await store.updateNote(note.id, {
            content: note.content,
            ...(note.path ? { path: note.path } : {}),
            ...(metadata ? { metadata: metadata as Record<string, unknown> } : {}),
          });
          if (existing.tags && existing.tags.length > 0) await store.untagNote(note.id, existing.tags);
          if (note.tags.length > 0) await store.tagNote(note.id, note.tags);
        } else {
          await store.createNoteRaw(note.content, {
            id: note.id,
            path: note.path || undefined,
            tags: note.tags.length > 0 ? note.tags : undefined,
            metadata: metadata as Record<string, unknown>,
          });
        }
        if (note.createdAt) {
          await store.restoreNoteTimestamps(note.id, note.createdAt, note.updatedAt ?? note.createdAt);
        }
        if (note.path) seenPaths.add(note.path.toLowerCase());
        imported++;
      } else {
        const key = (note.path || "").toLowerCase();
        if (note.path && seenPaths.has(key)) {
          skipped++;
          continue;
        }
        const existing = note.path ? await store.getNoteByPath(note.path) : null;
        if (existing) {
          skipped++;
          if (note.path) seenPaths.add(key);
          continue;
        }
        const created = await store.createNoteRaw(note.content, {
          path: note.path || undefined,
          tags: note.tags.length > 0 ? note.tags : undefined,
          metadata: metadata as Record<string, unknown>,
        });
        if (note.path) seenPaths.add(key);
        if (note.createdAt) {
          await store.restoreNoteTimestamps(created.id, note.createdAt, note.updatedAt ?? note.createdAt);
        }
        imported++;
      }
    } catch (err) {
      // A collision that slips past the dedup (or a path-conflict on the
      // id-upsert branch) throws from the UNIQUE insert. Collect + continue
      // rather than aborting the whole import (correction #5).
      console.warn(`skip: ${note.path}: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// Legacy export — kept for back-compat. New code: use `toPortableMarkdown`.
// ---------------------------------------------------------------------------

/**
 * Note shape the legacy export accepts. Distinct from `PortableNote` —
 * older + lossy by design (no IDs, no typed links, no attachments).
 */
export interface ExportableNote {
  path?: string;
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  createdAt: string;
}

/**
 * Convert a vault note to Obsidian-compatible markdown with YAML
 * frontmatter — legacy flat-frontmatter shape (metadata keys at the
 * top level, no IDs, no typed links, no attachments).
 *
 * @deprecated Prefer `toPortableMarkdown` in `portable-md.ts` for new
 * code. This function is preserved for callers that intentionally want
 * the legacy lossy shape — typically one-shot "give me an Obsidian
 * copy" exports without round-trip concerns. See vault#308.
 */
export function toObsidianMarkdown(note: ExportableNote): string {
  const fm: Record<string, unknown> = {};

  if (note.tags && note.tags.length > 0) fm.tags = note.tags;
  if (note.metadata) {
    for (const [key, value] of Object.entries(note.metadata)) {
      if (key === "tags") continue;
      fm[key] = value;
    }
  }

  let result = "";
  if (Object.keys(fm).length > 0) {
    result += "---\n";
    for (const [key, value] of Object.entries(fm)) {
      if (Array.isArray(value)) {
        result += `${key}:\n`;
        for (const item of value) result += `  - ${item}\n`;
      } else if (typeof value === "object" && value !== null) {
        result += `${key}: ${JSON.stringify(value)}\n`;
      } else {
        result += `${key}: ${value}\n`;
      }
    }
    result += "---\n";
  }

  result += note.content;
  return result;
}

/**
 * Determine the file path for an exported note (legacy form).
 * @deprecated Use `portableExportFilePath` from `portable-md.ts`.
 */
export function exportFilePath(note: ExportableNote): string {
  if (note.path) return note.path + ".md";
  const date = note.createdAt.split("T")[0];
  return `${date}/${note.id}.md`;
}
