/**
 * Path normalization and validation for Obsidian interop.
 *
 * Conventions:
 *   - No .md extension (stored without, added on export)
 *   - No leading/trailing slashes
 *   - Forward slashes only (no backslash)
 *   - Collapse multiple slashes
 *   - Trim whitespace
 *   - Paths are nullable (not all notes need them)
 *   - Paths are unique when set (enforced at DB level)
 */

/**
 * Normalize a note path for storage.
 * Returns null if the path is empty after normalization.
 */
export function normalizePath(path: string | null | undefined): string | null {
  if (path === null || path === undefined) return null;

  let p = path
    .trim()
    .replace(/\\/g, "/")          // backslash → forward slash
    .replace(/\.md$/i, "")         // strip .md extension
    .replace(/\/+/g, "/")          // collapse multiple slashes
    .replace(/^\//, "")            // no leading slash
    .replace(/\/$/, "");           // no trailing slash

  if (p === "") return null;
  return p;
}

/**
 * Extract the display title from a path.
 * Returns the last segment (filename without folders).
 *
 * "Projects/Parachute/README" → "README"
 * "Grocery List" → "Grocery List"
 */
export function pathTitle(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1];
}

/**
 * Characters forbidden in Obsidian filenames.
 * We don't enforce this strictly — just provide a check for import/export.
 */
const FORBIDDEN_CHARS = /[*"<>:|?]/;

export function hasInvalidChars(path: string): boolean {
  return FORBIDDEN_CHARS.test(path);
}
