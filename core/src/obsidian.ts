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
} from "./portable-md.js";

import { parseFrontmatter, walkMarkdownFiles, extractInlineTags } from "./portable-md.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObsidianNote {
  /** Relative path without .md extension (e.g., "Projects/Parachute/README") */
  path: string;
  /** Raw markdown content (frontmatter stripped) */
  content: string;
  /** Parsed YAML frontmatter */
  frontmatter: Record<string, unknown>;
  /** Tags from both frontmatter and inline #tags */
  tags: string[];
}

export interface ImportStats {
  files: number;
  imported: number;
  skipped: number;
  tags: number;
  errors: { path: string; error: string }[];
}

/** Tags from frontmatter (handles both array and string formats). */
function extractFrontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((t) => t.toLowerCase().trim()).filter(Boolean);
  return [];
}

// ---------------------------------------------------------------------------
// Parse a single file
// ---------------------------------------------------------------------------

export function parseObsidianFile(filePath: string, vaultRoot: string): ObsidianNote {
  const raw = readFileSync(filePath, "utf-8");
  const { frontmatter, content } = parseFrontmatter(raw);

  // Path: relative to vault root, without .md extension
  const rel = relative(vaultRoot, filePath);
  const path = rel.replace(/\.md$/i, "");

  // Merge tags from frontmatter and inline
  const fmTags = extractFrontmatterTags(frontmatter);
  const inlineTags = extractInlineTags(content);
  const allTags = [...new Set([...fmTags, ...inlineTags])];

  // Remove tags from metadata (they go to the tags table)
  const metadata = { ...frontmatter };
  delete metadata.tags;

  return { path, content, frontmatter: metadata, tags: allTags };
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
