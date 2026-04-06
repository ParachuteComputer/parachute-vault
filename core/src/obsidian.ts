/**
 * Obsidian vault parser — reads .md files and extracts notes, tags, links.
 *
 * Handles:
 *   - YAML frontmatter → note.metadata
 *   - Inline #tags and frontmatter tags → tags table
 *   - [[wikilinks]] → handled by wikilinks.ts on note creation
 *   - File path → note.path
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, extname, basename } from "path";

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

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter, content } where content has frontmatter stripped.
 *
 * Uses a simple parser — no dependency on a YAML library.
 * Handles common frontmatter patterns: strings, arrays, numbers, booleans.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, content: raw };
  }

  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { frontmatter: {}, content: raw };
  }

  const yamlBlock = raw.slice(4, endIdx); // skip opening "---\n"
  const content = raw.slice(endIdx + 4).replace(/^\n/, ""); // skip closing "---\n"

  const frontmatter: Record<string, unknown> = {};
  let currentKey = "";
  let currentArray: string[] | null = null;

  for (const line of yamlBlock.split("\n")) {
    // Array item (continuation of previous key)
    if (currentArray !== null && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, "").trim();
      currentArray.push(unquote(val));
      continue;
    }

    // If we were building an array, save it (or save empty string if no items found)
    if (currentArray !== null) {
      frontmatter[currentKey] = currentArray.length > 0 ? currentArray : "";
      currentArray = null;
    }

    // Key: value pair — keys must be YAML-valid (word chars and hyphens, no spaces)
    const kvMatch = line.match(/^([\w][\w-]*):\s*(.*)/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();

      if (value === "[]") {
        frontmatter[key] = [];
      } else if (value === "") {
        // Empty value: could be start of array (next lines are "- item")
        // or genuinely empty string. We start array accumulation and
        // handle the empty case when a non-array line follows.
        currentKey = key;
        currentArray = [];
      } else if (value.startsWith("[") && value.endsWith("]")) {
        // Inline array: [item1, item2]
        const items = value.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
        frontmatter[key] = items;
      } else {
        frontmatter[key] = parseValue(value);
      }
    }
  }

  // Save any trailing array (or empty string if no items)
  if (currentArray !== null) {
    frontmatter[currentKey] = currentArray.length > 0 ? currentArray : "";
  }

  return { frontmatter, content };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseValue(s: string): unknown {
  s = unquote(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

/** Extract inline #tags from markdown content. Excludes tags in code blocks. */
export function extractInlineTags(content: string): string[] {
  // Strip code blocks and inline code
  let stripped = content.replace(/```[\s\S]*?```/g, "");
  stripped = stripped.replace(/`[^`\n]+`/g, "");

  const tags = new Set<string>();
  // Match #tag and #nested/tag — must be preceded by whitespace or start of line
  const regex = /(?:^|\s)#([\w][\w/-]*[\w]|[\w])/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stripped)) !== null) {
    tags.add(match[1].toLowerCase());
  }
  return [...tags];
}

/** Extract tags from frontmatter (handles both array and string formats). */
function extractFrontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((t) => t.toLowerCase().trim()).filter(Boolean);
  return [];
}

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

/** Recursively list all .md files in a directory, excluding .obsidian/ and hidden dirs. */
export function walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      // Skip hidden directories and .obsidian config
      if (entry.startsWith(".")) continue;
      if (entry === "node_modules") continue;

      const full = join(current, entry);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && extname(entry).toLowerCase() === ".md") {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results.sort();
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

  return {
    path,
    content,
    frontmatter: metadata,
    tags: allTags,
  };
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
// Export to Obsidian format
// ---------------------------------------------------------------------------

export interface ExportableNote {
  path?: string;
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  createdAt: string;
}

/**
 * Convert a vault note to Obsidian-compatible markdown with YAML frontmatter.
 */
export function toObsidianMarkdown(note: ExportableNote): string {
  const fm: Record<string, unknown> = {};

  // Add tags to frontmatter
  if (note.tags && note.tags.length > 0) {
    fm.tags = note.tags;
  }

  // Add metadata fields (excluding internal ones)
  if (note.metadata) {
    for (const [key, value] of Object.entries(note.metadata)) {
      if (key === "tags") continue; // already handled
      fm[key] = value;
    }
  }

  // Build frontmatter string
  let result = "";
  if (Object.keys(fm).length > 0) {
    result += "---\n";
    for (const [key, value] of Object.entries(fm)) {
      if (Array.isArray(value)) {
        result += `${key}:\n`;
        for (const item of value) {
          result += `  - ${item}\n`;
        }
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
 * Determine the file path for an exported note.
 * Notes with paths use the path; pathless notes use date/id.
 */
export function exportFilePath(note: ExportableNote): string {
  if (note.path) {
    return note.path + ".md";
  }
  // Fallback: use date prefix + truncated id
  const date = note.createdAt.split("T")[0];
  return `${date}/${note.id}.md`;
}
