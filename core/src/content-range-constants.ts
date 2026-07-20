/**
 * Content-range constants with ZERO runtime dependencies.
 *
 * Extracted from `content-range.ts` (which imports `QueryError` from
 * `query-operators.ts` → `bun:sqlite`) so the pure-data MCP tool manifest
 * (`mcp-manifest.ts`) can reference `MIN_CONTENT_LENGTH` in a tool
 * `description` without dragging the sqlite driver into its import graph —
 * the front-of-house Wave 0 workerd invariant. `content-range.ts` re-exports
 * `MIN_CONTENT_LENGTH` from here, so every existing importer is unaffected.
 */

/**
 * Minimum accepted `content_length`. A UTF-8 codepoint is at most 4 bytes,
 * so any budget >= 4 is guaranteed to make progress (the codepoint at the
 * window start always fits). Budgets 1–3 could stall forever on a 4-byte
 * emoji (empty slice, next_offset == offset); rejecting them up front is
 * deterministic and simpler than a runtime "no progress" error.
 */
export const MIN_CONTENT_LENGTH = 4;
