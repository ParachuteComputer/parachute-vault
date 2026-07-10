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

import { readdirSync, readFileSync, realpathSync, statSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from "fs";
import { basename, join, relative, extname, dirname, resolve as resolvePath, sep as pathSep } from "path";
import type { Store, Note, Link, Attachment } from "./types.js";
import type { TagRecord } from "./tag-schemas.js";
import { ParentCycleError } from "./tag-schemas.js";

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

/**
 * Subdirectory under the sidecar where per-note metadata sidecars live
 * for non-frontmatter-compatible extensions (vault#328). One YAML file
 * per note, keyed by note id: `.parachute/notes-meta/<note-id>.yaml`.
 * Mirrors the inline-frontmatter shape so the parser can chew either.
 */
export const NOTES_META_DIR = "notes-meta";

/**
 * Extensions whose serialized form carries metadata as inline YAML
 * frontmatter at the top of the content file. `.md` is the canonical
 * case; `.mdx` joins it because MDX's parser accepts the same `---`
 * delimited preamble (and Aaron's planning to use MDX in notes).
 * Anything else is sidecar-required — see `core/src/portable-md.ts`
 * write/read paths.
 *
 * Easy to extend later — e.g. `.org` if/when a real workflow demands
 * it. Today's set is conservative: only formats whose parser semantics
 * we've explicitly validated.
 */
const FRONTMATTER_COMPAT_EXTENSIONS = new Set(["md", "mdx"]);

export function supportsInlineFrontmatter(extension: string): boolean {
  return FRONTMATTER_COMPAT_EXTENSIONS.has(extension.toLowerCase());
}

/** Order in which top-level frontmatter keys are emitted. Fixed — required
 *  for byte-identical re-exports of unchanged vault state. `extension` is
 *  emitted right after `path` so the suffix story sits with the
 *  filesystem-location story; emitted only when non-default ("md"
 *  doesn't get a frontmatter line so the existing `.md`-only corpus
 *  diffs cleanly against pre-vault#328 exports). */
const FRONTMATTER_KEY_ORDER = [
  "id",
  "path",
  "extension",
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

/** Per-note shape written into one file (frontmatter + content for
 *  `.md`/`.mdx`; raw content + sidecar metadata for everything else). */
export interface PortableNote {
  id: string;
  path?: string;
  content: string;
  /**
   * File extension (vault#328). Defaults to "md" when omitted —
   * back-compat with PR1/PR2 exports that predate the extension axis.
   * Controls both the file suffix on disk AND whether metadata goes
   * inline as frontmatter (`md`, `mdx`) or in a sidecar
   * (`csv`/`yaml`/`json`/etc).
   */
  extension?: string;
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
  attachments: number;
  /**
   * Per-note metadata sidecars written for non-frontmatter-compatible
   * extensions (vault#328). For `.md`/`.mdx` notes this stays 0 —
   * metadata is inline. For `.csv`/`.yaml`/`.json` notes, one sidecar
   * per note.
   */
  sidecars: number;
  /**
   * True when the export ran on a case-insensitive filesystem (macOS
   * APFS default, Windows NTFS, FAT/exFAT) — whether or not any
   * collision actually occurred. The probe runs once per export
   * regardless of the note set; this field reflects the probe's
   * outcome. To detect actual collisions, check
   * `disambiguated_paths.length > 0`. See vault#327.
   */
  case_insensitive_fs: boolean;
  /**
   * Per-note disambiguation detail when the export's case-insensitive
   * filesystem would otherwise silently collapse notes whose paths
   * differ only by case (vault#327). Each entry records the original
   * path + the suffixed on-disk filename so the operator can audit.
   * Empty on case-sensitive filesystems and on case-insensitive
   * filesystems with no collisions.
   */
  disambiguated_paths: Array<{ note_id: string; original_path: string; disambiguated_filename: string }>;
  /** Set when caller passed `since`; counts notes whose `updated_at >= since`. */
  filtered_by_since: boolean;
  /**
   * Number of notes skipped because their resolved write target escaped
   * the export root. Operators / programmatic callers (e.g. PR 2's
   * importer) inspect this to decide whether to treat the export as
   * complete. The corresponding entries are detailed in `skipped_notes`.
   * vault#318.
   */
  skipped_traversal: number;
  /**
   * Per-skipped-note detail. Each entry pairs the offending note's path
   * with the human-readable reason it was skipped. Empty when nothing
   * was skipped.
   */
  skipped_notes: Array<{ path: string | undefined; reason: string }>;
  /**
   * Per-skipped-attachment detail. Skipped reasons: source file missing,
   * source path escapes assetsDir, dest path escapes outDir. Importer
   * uses this to distinguish expected-missing from data corruption.
   */
  skipped_attachments: Array<{ note_id: string; attachment_id: string; path: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// YAML emitter (idempotent, hand-rolled — no new dep)
// ---------------------------------------------------------------------------

/**
 * Quote a string when it contains YAML-meaningful characters. Mirrors the
 * subset of YAML 1.2 plain-scalar rules that matter for our payloads:
 * leading whitespace / `-` / `?` / `:` / `#` / `&` / `*` / `!` / `|` / `>`,
 * leading/trailing whitespace, embedded `:` followed by whitespace,
 * embedded newlines / control characters, or values that would parse as
 * boolean/null/numeric.
 *
 * Newline detection is critical (vault#317 F1): vault `metadata` is
 * `Record<string, unknown>` and notes legitimately carry multi-line
 * strings (transcripts, descriptions, body-as-metadata). Without a
 * newline check, single-quoting splits the value across physical lines
 * and the parser silently truncates or corrupts. Multi-line values fall
 * through to `quoteString` which switches to the double-quoted form
 * with `\n` escapes so the whole value stays on one line.
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
  // Embedded newlines / control characters require the double-quoted
  // escape form. vault#317 F1.
  // eslint-disable-next-line no-control-regex
  if (/[\n\r\t\v\f\x00-\x08\x0e-\x1f]/.test(s)) return true;
  return false;
}

/**
 * Quote a string for YAML emission. Strings containing newlines or other
 * control characters use the **double-quoted** form with escape sequences
 * (so the value stays on one physical YAML line — single-quoted multi-
 * line splits the parser, vault#317 F1). All other quoted strings use the
 * single-quoted form (cleaner output; YAML 1.2 escapes `'` by doubling).
 */
function quoteString(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\n\r\t\v\f\x00-\x08\x0e-\x1f]/.test(s)) {
    // Double-quoted with escape sequences. Escape backslash first so we
    // don't double-escape the escapes themselves.
    const escaped = s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, "\\\"")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/\v/g, "\\v")
      .replace(/\f/g, "\\f")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0e-\x1f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
    return `"${escaped}"`;
  }
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
  // Emit only when non-default ("md") so legacy markdown-only exports
  // produce byte-identical bytes pre- and post-vault#328.
  if (note.extension && note.extension !== "md") fm.extension = note.extension;
  if (note.tags && note.tags.length > 0) fm.tags = [...note.tags].sort();
  if (note.metadata && Object.keys(note.metadata).length > 0) fm.metadata = note.metadata;
  if (note.links && note.links.length > 0) fm.links = note.links;
  if (note.attachments && note.attachments.length > 0) fm.attachments = note.attachments;
  fm.created_at = note.created_at;
  if (note.updated_at) fm.updated_at = note.updated_at;
  return fm;
}

/**
 * Emit a frontmatter-shape object using `FRONTMATTER_KEY_ORDER`: each
 * present key gets one or more lines (inline form for scalars + empty
 * collections, block form otherwise). Every line ends in `\n`. The
 * output does NOT include the `---` wrapper — that's the caller's
 * concern (only `toPortableMarkdown` wraps; `toSidecarYaml` doesn't).
 *
 * Single source of truth for the per-key emit loop shared by
 * `toPortableMarkdown` and `toSidecarYaml` (vault#330 F3 — pure
 * refactor, behavior unchanged).
 */
function emitFrontmatterKeys(fm: Record<string, unknown>): string {
  let out = "";
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
  return out;
}

/**
 * Render a note's content-file bytes. Behavior depends on the note's
 * `extension`:
 *
 *   - Frontmatter-compatible (`.md`, `.mdx`): emits `--- <frontmatter>
 *     --- <content>`. Today's behavior, generalized to also handle MDX.
 *   - Sidecar-required (`.csv`, `.yaml`, `.json`, etc.): emits the
 *     raw content as-is (no frontmatter prepend). The metadata lives in
 *     `.parachute/notes-meta/<id>.yaml`; see `toSidecarYaml`.
 *
 * Trailing-newline: frontmatter form always ends with `\n`. Raw content
 * form is returned verbatim — if the note's content has no trailing
 * newline, the file ends without one. Callers wanting strict
 * trailing-newline normalization (re-emit invariant) should add it
 * outside this function.
 */
export function toPortableMarkdown(note: PortableNote): string {
  const ext = note.extension ?? "md";
  if (!supportsInlineFrontmatter(ext)) {
    // Sidecar-required: content goes out as-is. No frontmatter, no
    // synthetic trailing newline — the file is whatever the caller
    // stored as `content`.
    return note.content;
  }
  const fm = buildFrontmatter(note);
  let out = "---\n";
  out += emitFrontmatterKeys(fm);
  out += "---\n";
  // Preserve content as-is; ensure exactly one trailing newline if missing.
  out += note.content;
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

/**
 * Render a note's sidecar metadata bytes (vault#328). Same key set as
 * the inline frontmatter — just lifted out of the content file. Used
 * for sidecar-required extensions (`.csv`/`.yaml`/`.json`/etc.) where
 * the content file can't host YAML. Order of keys is fixed
 * (`FRONTMATTER_KEY_ORDER`) so the sidecar bytes are byte-identical
 * across re-exports of unchanged vault state.
 *
 * Always includes the `extension` field (unlike `buildFrontmatter`,
 * which omits it for `md` to keep legacy diffs clean) — the sidecar is
 * a new artifact, the omit-default optimization buys nothing.
 */
export function toSidecarYaml(note: PortableNote): string {
  // Build a "full" frontmatter — same as buildFrontmatter, but always
  // emit the extension. The sidecar's purpose is exactly to record
  // the extension that's not in the filename.
  const fm: Record<string, unknown> = {};
  fm.id = note.id;
  if (note.path) fm.path = note.path;
  fm.extension = note.extension ?? "md";
  if (note.tags && note.tags.length > 0) fm.tags = [...note.tags].sort();
  if (note.metadata && Object.keys(note.metadata).length > 0) fm.metadata = note.metadata;
  if (note.links && note.links.length > 0) fm.links = note.links;
  if (note.attachments && note.attachments.length > 0) fm.attachments = note.attachments;
  fm.created_at = note.created_at;
  if (note.updated_at) fm.updated_at = note.updated_at;

  return emitFrontmatterKeys(fm);
}

/**
 * Determine the file path for an exported portable-md note. Notes with a
 * `path` use it + their `extension`; pathless notes use
 * `_unpathed/<id>.<extension>` (no date-prefix coincidence with user
 * content). Default extension is "md" so pre-vault#328 exports produce
 * the same filenames.
 */
export function portableExportFilePath(note: PortableNote): string {
  const ext = note.extension ?? "md";
  if (note.path) return `${note.path}.${ext}`;
  return `_unpathed/${note.id}.${ext}`;
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
export async function noteToPortable(
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

  // Default to "md" so old PR1/PR2 callers (or callers that didn't get
  // the v18 column from a fresh-DB read) keep producing identical
  // frontmatter shape.
  const extension = note.extension ?? "md";

  const result: PortableNote = {
    id: note.id,
    ...(note.path ? { path: note.path } : {}),
    content: note.content,
    ...(extension ? { extension } : {}),
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
  /**
   * Absolute path to the vault's assets directory (where attachment
   * bytes live, one file per `attachments.path` row). When set, attachment
   * binaries are copied into `<outDir>/.parachute/attachments/<id>/<basename>`
   * alongside the frontmatter reference. When unset, attachment refs are
   * still emitted but the binaries stay where they are — useful for
   * partial exports / git-projection where only the markdown is checked
   * in. The CLI computes this via `src/routes.ts:assetsDir(vault)`; core
   * stays pure (no dep on server-side path resolution).
   */
  assetsDir?: string;
  /**
   * Override the filesystem case-sensitivity probe (vault#327). Pass
   * `false` to force the case-insensitive code path (with auto-
   * disambiguation) regardless of the real filesystem; pass `true` to
   * force the case-sensitive code path. Test seam — lets the round-trip
   * suite exercise both branches on whatever FS the test happens to
   * run on. When unset (the production default), the probe runs.
   */
  caseSensitiveOverride?: boolean;
  /**
   * Strict mode for case-collision handling on case-insensitive
   * filesystems (vault#327 Phase 2). When `true`, the first detected
   * collision aborts the export by throwing a `CaseCollisionError`
   * naming every colliding path. When `false` (the default), the
   * existing lossless behavior is preserved — the colliding note is
   * written to a disambiguated filename (`<base>__<id-short>.<ext>`)
   * and recorded in `ExportStats.disambiguated_paths`.
   *
   * Use `true` for one-shot CLI flows where the operator wants to be
   * forced to fix the source-of-truth (rename one of the colliding
   * notes in the vault before re-exporting). Leave `false` for
   * long-running watch / mirror loops where a hard failure mid-loop
   * would block the operator's actual work.
   */
  failOnCaseCollision?: boolean;
}

/**
 * Thrown by `exportVaultToDir` when `failOnCaseCollision: true` is set
 * and the export detects two-or-more notes whose paths differ only by
 * case on a case-insensitive filesystem (vault#327).
 *
 * The error names every colliding path (full N-way group, not just
 * the first pair) so the operator can audit the whole set in one
 * pass. Caller catches by type and surfaces `.collisions` for a
 * clean error report:
 *
 * ```ts
 * try {
 *   await exportVaultToDir(store, { ..., failOnCaseCollision: true });
 * } catch (err) {
 *   if (err instanceof CaseCollisionError) {
 *     for (const group of err.collisions) {
 *       console.error(`collision: ${group.map((g) => g.path).join(", ")}`);
 *     }
 *   }
 * }
 * ```
 */
export class CaseCollisionError extends Error {
  /**
   * Each entry is one collision group — every note that shares the same
   * lowercased `(path, extension)` slot. Two notes per group is the
   * common case; three-or-more (`Foo.md` + `foo.md` + `FOO.md`) is rare
   * but supported. Notes are listed in the order they were encountered
   * during the export walk (deterministic — `queryNotes` sorts ASC).
   */
  readonly collisions: Array<Array<{ note_id: string; path: string; extension: string }>>;
  constructor(collisions: CaseCollisionError["collisions"]) {
    const lines: string[] = [
      "Export failed: case-collision detected on case-insensitive filesystem.",
      "The following notes have paths that differ only by case:",
    ];
    // Separate distinct collision groups with `  ---` so operators
    // reading the error in a terminal can tell where one (Foo.md /
    // foo.md) pair ends and the next (Bar.md / bar.md) begins. Without
    // a separator, multi-group output runs together as an unbroken
    // bullet list. vault#350.
    collisions.forEach((group, idx) => {
      if (idx > 0) lines.push("  ---");
      for (const entry of group) {
        lines.push(`  - ${entry.path}.${entry.extension} (note id: ${entry.note_id})`);
      }
    });
    lines.push(
      "Rename one of them in the vault before re-exporting, or run from a case-sensitive filesystem.",
    );
    super(lines.join("\n"));
    this.name = "CaseCollisionError";
    this.collisions = collisions;
  }
}

// ---------------------------------------------------------------------------
// Export sink — the destination seam (Phase-1 shared-core, cloud design §4)
// ---------------------------------------------------------------------------

/** Result of a sink write: `ok`, or a refusal the engine records as a skip
 *  (path-traversal, missing source) and surfaces in `ExportStats` without
 *  aborting the whole export. */
export type SinkWriteResult = { ok: true } | { ok: false; reason: string };

/**
 * Where an export's bytes land. `exportVault` (the engine) owns every
 * format, ordering, case-collision and since-filter decision and asks the
 * sink only to persist bytes — so a Durable-Object/R2 backend plugs a
 * key-value sink in behind the same engine (cloud design §4/§5). The
 * `caseSensitive` flag lets a key-addressed sink opt out of the
 * disambiguation path; `attachmentsEnabled` gates binary copies.
 */
export interface ExportSink {
  /** Whether the destination namespace distinguishes filenames by case.
   *  The fs sink probes the real filesystem (macOS/Windows default to
   *  case-insensitive); a key-addressed sink (R2/DO) is always true. */
  readonly caseSensitive: boolean;
  /** Whether attachment binaries are copied. The fs sink enables this only
   *  when an `assetsDir` is wired; markdown-only exports still emit the
   *  frontmatter refs but leave the binaries in place. */
  readonly attachmentsEnabled: boolean;
  /** Persist a UTF-8 text document at export-root-relative `relPath`,
   *  creating any parent structure. */
  writeText(relPath: string, content: string): SinkWriteResult;
  /** Copy one attachment binary into the export. `srcRelPath` is relative
   *  to the attachment source (fs: `assetsDir`); `destRelPath` is export-
   *  root-relative. Only called when `attachmentsEnabled`. */
  copyAttachment(srcRelPath: string, destRelPath: string): SinkWriteResult;
}

/**
 * Filesystem `ExportSink` — the bun backend. Reproduces the pre-seam
 * on-disk layout byte-for-byte (pinned by `portable-md-golden.test.ts`).
 * Owns the case-sensitivity probe, the path-traversal guards (a note whose
 * `path` escapes the export root is refused, never written off-tree), and
 * attachment source resolution against `assetsDir`.
 *
 * Every guard resolves against the export root: keeping a write inside the
 * export dir is the security property (the pre-seam per-subtree checks were
 * belt-and-suspenders — a ULID sidecar id or a `basename()`-ed attachment
 * name can't escape a subtree without also escaping the root).
 */
export class FsExportSink implements ExportSink {
  readonly caseSensitive: boolean;
  readonly attachmentsEnabled: boolean;
  private readonly root: string;
  private readonly rootResolved: string;
  private readonly assetsDirResolved?: string;

  constructor(opts: { outDir: string; assetsDir?: string; caseSensitiveOverride?: boolean }) {
    this.root = opts.outDir;
    mkdirSync(this.root, { recursive: true });
    const sidecar = join(this.root, SIDECAR_DIR);
    mkdirSync(sidecar, { recursive: true });
    mkdirSync(join(sidecar, "schemas"), { recursive: true });
    // attachments dir only when assetsDir is wired (caller opted in).
    if (opts.assetsDir) {
      mkdirSync(join(sidecar, "attachments"), { recursive: true });
      this.assetsDirResolved = resolvePath(opts.assetsDir);
    }
    this.attachmentsEnabled = !!opts.assetsDir;
    this.rootResolved = resolvePath(this.root);
    // Probe AFTER outDir exists — probeCaseSensitive writes a tempfile into it.
    this.caseSensitive = opts.caseSensitiveOverride ?? probeCaseSensitive(this.root);
  }

  writeText(relPath: string, content: string): SinkWriteResult {
    const full = join(this.root, relPath);
    const fullResolved = resolvePath(full);
    if (!isWithinDir(fullResolved, this.rootResolved)) {
      return {
        ok: false,
        reason: `path-traversal: resolved write target "${fullResolved}" escapes export root "${this.rootResolved}"`,
      };
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return { ok: true };
  }

  copyAttachment(srcRelPath: string, destRelPath: string): SinkWriteResult {
    // attachmentsEnabled guarantees assetsDirResolved is set.
    const assetsDirResolved = this.assetsDirResolved!;
    const srcResolved = resolvePath(join(assetsDirResolved, srcRelPath));
    if (!isWithinDir(srcResolved, assetsDirResolved)) {
      return {
        ok: false,
        reason: `path-traversal: source "${srcResolved}" escapes assetsDir "${assetsDirResolved}"`,
      };
    }
    if (!existsSync(srcResolved)) {
      return { ok: false, reason: `source file missing at "${srcResolved}"` };
    }
    const destFull = join(this.root, destRelPath);
    const destResolved = resolvePath(destFull);
    if (!isWithinDir(destResolved, this.rootResolved)) {
      return {
        ok: false,
        reason: `path-traversal: dest "${destResolved}" escapes export root "${this.rootResolved}"`,
      };
    }
    mkdirSync(dirname(destFull), { recursive: true });
    copyFileSync(srcResolved, destResolved);
    return { ok: true };
  }
}

/** Note-iteration batch size for the export walk — bounds the working set so
 *  a large vault never materializes its whole corpus at once (the pre-seam
 *  full `limit: 1_000_000` load was the flagged memory-spike hazard). */
const EXPORT_BATCH_SIZE = 500;

/**
 * Iterate every note in `(created_at ASC, id ASC)` order — the exact order
 * the pre-seam `queryNotes({ sort: "asc", limit: 1_000_000 })` produced — in
 * batches of `EXPORT_BATCH_SIZE`, so the export streams instead of
 * materializing the full corpus. Windowing uses `limit`/`offset`, not the
 * opaque cursor: the cursor path forces `updated_at` ordering, which would
 * change which of two case-colliding notes keeps the plain filename (that
 * choice is order-pinned by tests). A `(created_at, id)` keyset predicate
 * isn't on the Store API surface; if offset re-scan cost ever bites on a
 * very large vault that's a follow-up — the memory hazard the refactor
 * targets is already closed by the windowing.
 */
async function* iterateAllNotes(store: Store): AsyncGenerator<Note> {
  let offset = 0;
  for (;;) {
    const batch = await store.queryNotes({ sort: "asc", limit: EXPORT_BATCH_SIZE, offset });
    for (const note of batch) yield note;
    if (batch.length < EXPORT_BATCH_SIZE) break;
    offset += EXPORT_BATCH_SIZE;
  }
}

/** Engine-level export options — the subset of `ExportOptions` that isn't
 *  fs-sink-specific (`outDir`/`assetsDir`/`caseSensitiveOverride` are owned
 *  by `FsExportSink`). */
export interface ExportEngineOptions {
  vaultName?: string;
  vaultDescription?: string;
  since?: string;
  exportedAt?: string;
  failOnCaseCollision?: boolean;
}

/**
 * Sink-agnostic export engine (Phase-1 shared-core, cloud design §4). Walks
 * the vault in bounded batches and drives an `ExportSink`: `exportVaultToDir`
 * wires the fs backend; a DO/R2 backend supplies its own sink. All format,
 * ordering, case-collision and since-filter policy lives here — the sink only
 * persists bytes, so the two runtimes stay byte-identical by construction.
 */
export async function exportVault(
  store: Store,
  sink: ExportSink,
  opts: ExportEngineOptions = {},
): Promise<ExportStats> {
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
  sink.writeText(join(SIDECAR_DIR, "vault.yaml"), emitYamlDoc(vaultMeta as unknown as Record<string, unknown>));

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
    sink.writeText(join(SIDECAR_DIR, "schemas", filename), emitYamlDoc(doc));
    schemasWritten++;
  }

  // 3. Per-note files — streamed in `EXPORT_BATCH_SIZE` batches (no
  // full-corpus load). If `since` is set, filter by updated_at >= since
  // (incremental export).
  const since = opts.since;
  const caseSensitive = sink.caseSensitive;
  let notesWritten = 0;
  let attachmentsWritten = 0;
  let sidecarsWritten = 0;
  const skipped: { path: string | undefined; reason: string }[] = [];
  const skippedAttachments: { note_id: string; attachment_id: string; path: string; reason: string }[] = [];
  const disambiguatedPaths: ExportStats["disambiguated_paths"] = [];

  // Case-collision detection (vault#327). On case-insensitive filesystems
  // (macOS APFS-default, Windows NTFS-default, FAT/exFAT), two notes whose
  // paths differ only by case collapse into one file on write — silent
  // data loss. The sink reports its namespace's case-sensitivity; on a
  // case-insensitive sink we build a lowercase `(path, extension)` index
  // during the walk and disambiguate colliding notes with an `__<id-short>`
  // filename suffix. The note's stored `path` (in frontmatter + sidecar)
  // stays canonical; only the on-disk filename is suffixed. Import recovers
  // the canonical path from frontmatter/sidecar, not from the filename.
  const seenLowerKeys = new Map<string, string>();

  // Strict-mode pre-scan (vault#327 Phase 2). When the caller passes
  // `failOnCaseCollision: true`, surface every collision group in one typed
  // error BEFORE any note write lands — partial-export-then-throw would
  // leave the operator a half-mirrored dir to clean up. The pre-scan walks
  // every note (NOT since-filtered: a collision can involve one old + one
  // new path). It streams in the same batches as the main pass and keeps
  // only lightweight `(id, path, extension)` entries — the pre-seam version
  // cached every full PortableNote to avoid a second `noteToPortable`, but
  // that reintroduced the whole-corpus memory hazard this refactor closes;
  // strict mode is a one-shot CLI flow, so the second serialize pass is an
  // acceptable trade for bounded memory.
  if (opts.failOnCaseCollision && !caseSensitive) {
    const groups = new Map<string, Array<{ note_id: string; path: string; extension: string }>>();
    for await (const note of iterateAllNotes(store)) {
      const portable = await noteToPortable(note, store);
      if (!portable.path) continue; // _unpathed/<id>.<ext> is case-stable
      const ext = portable.extension ?? "md";
      const key = `${portable.path.toLowerCase()}|${ext.toLowerCase()}`;
      const entry = { note_id: portable.id, path: portable.path, extension: ext };
      const existing = groups.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        groups.set(key, [entry]);
      }
    }
    const collisions = Array.from(groups.values()).filter((g) => g.length > 1);
    if (collisions.length > 0) {
      throw new CaseCollisionError(collisions);
    }
  }

  for await (const note of iterateAllNotes(store)) {
    if (since && !shouldIncludeForSince(note, since)) continue;
    const portable = await noteToPortable(note, store);
    let relPath = portableExportFilePath(portable);

    // Decide whether this note's filename needs disambiguation (vault#327).
    // Only meaningful when the sink is case-insensitive AND a prior note's
    // (path, ext) tuple already claimed the same lowercased filename slot.
    // Pathless notes (`_unpathed/<id>.<ext>`) are immune by construction —
    // their filename embeds the id, which is case-stable already.
    if (!caseSensitive && portable.path) {
      const ext = portable.extension ?? "md";
      const key = `${portable.path.toLowerCase()}|${ext.toLowerCase()}`;
      const prior = seenLowerKeys.get(key);
      if (prior !== undefined && prior !== portable.id) {
        // Collision: emit the disambiguated form. The frontmatter / sidecar
        // `path:` still holds the canonical (original) path so import
        // recovers the truth.
        const disambig = disambiguateFilename(portable.path, ext, portable.id);
        relPath = disambig;
        disambiguatedPaths.push({
          note_id: portable.id,
          original_path: portable.path,
          disambiguated_filename: disambig,
        });
      } else if (prior === undefined) {
        seenLowerKeys.set(key, portable.id);
      }
    }

    // vault#317 F3 — path-traversal guard now lives in the sink: a note with
    // `path: "../../.ssh/authorized_keys"` is refused (not written off-tree)
    // and surfaced in `skipped_notes` so the operator can fix the note.
    const noteWrite = sink.writeText(relPath, toPortableMarkdown(portable));
    if (!noteWrite.ok) {
      skipped.push({ path: portable.path, reason: noteWrite.reason });
      continue;
    }
    notesWritten++;

    // Sidecar metadata write for non-frontmatter-compat extensions
    // (vault#328). The content file holds raw bytes (no YAML); the sidecar
    // at .parachute/notes-meta/<id>.yaml carries id/path/tags/metadata/
    // links/attachments/timestamps.
    const portableExt = portable.extension ?? "md";
    if (!supportsInlineFrontmatter(portableExt)) {
      const sidecarWrite = sink.writeText(
        join(SIDECAR_DIR, NOTES_META_DIR, `${portable.id}.yaml`),
        toSidecarYaml(portable),
      );
      if (!sidecarWrite.ok) {
        skipped.push({ path: portable.path, reason: sidecarWrite.reason });
      } else {
        sidecarsWritten++;
      }
    }

    // Copy attachment binaries when the sink has them enabled. Each
    // attachment is path-traversal-guarded on both ends by the sink; missing
    // source files are skipped (warn) rather than aborting — the assets state
    // may legitimately lag the DB (e.g. file evicted while row persists).
    if (sink.attachmentsEnabled && portable.attachments && portable.attachments.length > 0) {
      for (const att of portable.attachments) {
        // Dest: .parachute/attachments/<att-id>/<basename(att.path)>. Using
        // att.id as the directory name keeps multiple attachments with the
        // same basename from colliding; basename keeps it human-readable.
        const destRelPath = join(SIDECAR_DIR, "attachments", att.id, basename(att.path));
        const copyResult = sink.copyAttachment(att.path, destRelPath);
        if (copyResult.ok) {
          attachmentsWritten++;
        } else {
          skippedAttachments.push({
            note_id: portable.id,
            attachment_id: att.id,
            path: att.path,
            reason: copyResult.reason,
          });
        }
      }
    }
  }
  if (skipped.length > 0) {
    // Surface to the caller without aborting — partial export is more useful
    // than no export. CLI prints the list; programmatic callers inspect the
    // return value.
    for (const s of skipped) {
      // eslint-disable-next-line no-console
      console.warn(`[export] skipped note (path="${s.path ?? "<unpathed>"}"): ${s.reason}`);
    }
  }
  if (skippedAttachments.length > 0) {
    for (const s of skippedAttachments) {
      // eslint-disable-next-line no-console
      console.warn(`[export] skipped attachment (note=${s.note_id}, path="${s.path}"): ${s.reason}`);
    }
  }

  return {
    notes: notesWritten,
    schemas: schemasWritten,
    attachments: attachmentsWritten,
    sidecars: sidecarsWritten,
    case_insensitive_fs: !caseSensitive,
    disambiguated_paths: disambiguatedPaths,
    filtered_by_since: since !== undefined,
    skipped_traversal: skipped.length,
    skipped_notes: skipped,
    skipped_attachments: skippedAttachments,
  };
}

/**
 * Export a vault to a portable-markdown directory (the bun/fs backend —
 * thin wrapper over `exportVault` with an `FsExportSink`). Writes:
 *   - `<outDir>/.parachute/vault.yaml`
 *   - `<outDir>/.parachute/schemas/<tag>.yaml` for each tag that declares
 *     description/fields/relationships/parent_names.
 *   - `<outDir>/<note.path>.md` for each note (or `_unpathed/<id>.md`).
 *   - `<outDir>/.parachute/attachments/<id>/<basename>` for each attachment
 *     (only when `opts.assetsDir` is set; the sink's path-traversal guard
 *     rejects attachments whose source escapes assetsDir or whose dest would
 *     escape outDir).
 *
 * The frontmatter `attachments[].path` value preserves the original
 * vault-internal path (relative to `assetsDir`). Import restores the binary
 * to that path. The sidecar location is derived from `id` so it stays stable
 * across renames + different export runs.
 */
export async function exportVaultToDir(
  store: Store,
  opts: ExportOptions,
): Promise<ExportStats> {
  const sink = new FsExportSink({
    outDir: opts.outDir,
    assetsDir: opts.assetsDir,
    caseSensitiveOverride: opts.caseSensitiveOverride,
  });
  return exportVault(store, sink, {
    vaultName: opts.vaultName,
    vaultDescription: opts.vaultDescription,
    since: opts.since,
    exportedAt: opts.exportedAt,
    failOnCaseCollision: opts.failOnCaseCollision,
  });
}

// ---------------------------------------------------------------------------
// Orphan sweep — for git-mirror's delete propagation
// ---------------------------------------------------------------------------

/**
 * Result of a `pruneOrphans` pass.
 */
export interface PruneOrphansStats {
  /** Note content files removed (frontmatter id not in `validNoteIds`). */
  notes_removed: number;
  /** Sidecar metadata files removed (under `.parachute/notes-meta/`). */
  sidecars_removed: number;
  /** Schema sidecars removed (under `.parachute/schemas/`). */
  schemas_removed: number;
  /** Attachment directories removed (under `.parachute/attachments/`). */
  attachment_dirs_removed: number;
  /**
   * Files we couldn't parse / classify. Surfaced for operator audit;
   * the sweep doesn't touch them. Empty when everything classified
   * cleanly.
   */
  unparseable_files: Array<{ path: string; reason: string }>;
}

/**
 * Options for the orphan-sweep pass. Run periodically (the mirror manager
 * arms a safety-net poll, default 1h) and after operator-visible deletions
 * (the mirror manager's targeted-deletion fast path also calls this for the
 * touched-set).
 *
 * The sweep is the bookkeeping cousin of the event-driven fast path: events
 * cover the common case (a single note deletion fires "deleted" → mirror
 * removes that file); the sweep covers anything the fast path missed
 * (direct SQL writes, app crashes between dispatch and handler, restart
 * gaps).
 */
export interface PruneOrphansOptions {
  /** Directory to sweep — same shape as an `exportVaultToDir` outDir. */
  outDir: string;
  /** Note IDs that should be kept (everything else under the export gets removed). */
  validNoteIds: Set<string>;
  /** Tag names that should be kept (other schema sidecars under `.parachute/schemas/` get removed). */
  validTagNames: Set<string>;
  /** Attachment IDs that should be kept (other dirs under `.parachute/attachments/` get removed). */
  validAttachmentIds: Set<string>;
  /**
   * Override `extension`-based content-file extension recognition. The
   * default treats `.md` and `.mdx` as having inline frontmatter (with
   * `id:` reachable via the file head); everything else needs a sidecar
   * lookup to know what id owns it.
   */
  supportsInlineFrontmatter?: (ext: string) => boolean;
}

/**
 * Sweep the export directory for files belonging to notes / tags /
 * attachments that no longer exist in the vault. Removes them so the
 * mirror's `git diff` reflects what vault actually has.
 *
 * Strategy:
 *   1. Walk content files. For each `.md` / `.mdx`, parse the frontmatter
 *      `id` and compare against `validNoteIds`. Mismatch → remove the
 *      file. Files we can't parse are recorded in `unparseable_files`
 *      and left alone (best-effort, no destructive guesses).
 *   2. For non-inline-frontmatter extensions (`.csv`, `.yaml`, etc.),
 *      check the matching `.parachute/notes-meta/<id>.yaml` sidecar — the
 *      sidecar carries the canonical `id` + `path` + `extension` triple.
 *      An orphaned sidecar (no matching content file) is also removed,
 *      and an orphaned content file (no matching sidecar) without a
 *      parseable frontmatter is left as unparseable.
 *   3. Walk `.parachute/schemas/`. Each file is `<tag>.yaml` (after
 *      filename sanitization). Parse the `name:` field; compare against
 *      `validTagNames`. Mismatch → remove.
 *   4. Walk `.parachute/attachments/`. Each subdir name IS the
 *      attachment id (per `exportVaultToDir`'s layout). Compare against
 *      `validAttachmentIds`. Mismatch → recursive remove.
 *
 * Returns counts so callers can log + decide whether to commit.
 *
 * Safe to call on a directory that's never been exported to (returns
 * zero counts; doesn't create anything).
 */
export function pruneOrphans(opts: PruneOrphansOptions): PruneOrphansStats {
  const stats: PruneOrphansStats = {
    notes_removed: 0,
    sidecars_removed: 0,
    schemas_removed: 0,
    attachment_dirs_removed: 0,
    unparseable_files: [],
  };

  const outDir = opts.outDir;
  if (!existsSync(outDir)) return stats;

  const supportsInline = opts.supportsInlineFrontmatter ?? supportsInlineFrontmatter;
  const sidecarRoot = join(outDir, SIDECAR_DIR);
  const notesMetaRoot = join(sidecarRoot, NOTES_META_DIR);
  const schemasRoot = join(sidecarRoot, "schemas");
  const attachmentsRoot = join(sidecarRoot, "attachments");

  // Path-traversal guard. `walkContentFiles` uses `statSync` which
  // follows symlinks — a symlink inside the mirror pointing OUTSIDE
  // `outDir` would resurface its target's files in the prune sweep,
  // and a bare `rmSync(filepath)` would delete them off-tree. Every
  // deletion in this function routes through `safeRm`, which calls
  // `realpathSync` (resolves through symlinks, unlike syntactic-only
  // `path.resolve`) and refuses to delete anything that isn't `outDir`
  // or beneath it after symlink resolution. Refusals get recorded in
  // `unparseable_files` so an operator can see what was skipped.
  // Reviewer-flagged on vault#382 (Critical #2).
  const outDirReal = realpathSync(outDir);
  const safeRm = (
    candidate: string,
    onSuccess: () => void,
    options: { recursive?: boolean } = {},
  ): void => {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch (err) {
      // realpathSync throws if the path doesn't exist or is unreadable.
      // Don't delete what we can't fully resolve.
      stats.unparseable_files.push({
        path: candidate,
        reason: `realpath failed: ${(err as Error).message ?? err}`,
      });
      return;
    }
    if (!isWithinDir(real, outDirReal)) {
      stats.unparseable_files.push({
        path: candidate,
        reason: "real path resolved outside mirror outDir — refusing to delete (symlink?)",
      });
      return;
    }
    try {
      // Delete via the resolved real path; never via the unresolved
      // candidate (which could route through a symlink we already
      // determined would escape).
      rmSync(real, { force: true, recursive: options.recursive ?? false });
      onSuccess();
    } catch (err) {
      stats.unparseable_files.push({
        path: candidate,
        reason: `unlink failed: ${(err as Error).message ?? err}`,
      });
    }
  };

  // ---- 1 + 2. Notes + sidecars ----
  //
  // First pass: build the sidecar id → { path, extension } map so we can
  // resolve non-inline-frontmatter content files via their sidecar.
  // Sidecars whose claimed (path, extension) doesn't map to an existing
  // content file are tracked as "orphaned sidecar" candidates.
  const sidecarById = new Map<string, { path: string | null; extension: string | null }>();
  const sidecarFilesById = new Map<string, string>(); // id → absolute filepath
  if (existsSync(notesMetaRoot)) {
    try {
      for (const entry of readdirSync(notesMetaRoot)) {
        if (!entry.endsWith(".yaml")) continue;
        const id = entry.slice(0, -5);
        const full = join(notesMetaRoot, entry);
        sidecarFilesById.set(id, full);
        try {
          const text = readFileSync(full, "utf-8");
          const { frontmatter } = parseFrontmatter(`---\n${text}---\n`);
          sidecarById.set(id, {
            path: typeof frontmatter.path === "string" ? (frontmatter.path as string) : null,
            extension: typeof frontmatter.extension === "string" ? (frontmatter.extension as string) : null,
          });
        } catch (err) {
          stats.unparseable_files.push({
            path: full,
            reason: `failed to parse sidecar: ${(err as Error).message ?? err}`,
          });
        }
      }
    } catch (err) {
      // Notes-meta dir read-error is non-fatal — record + carry on.
      stats.unparseable_files.push({
        path: notesMetaRoot,
        reason: `notes-meta walk failed: ${(err as Error).message ?? err}`,
      });
    }
  }

  // Now walk content files (everything outside the .parachute sidecar).
  const contentFiles = walkContentFiles(outDir);
  // Track which sidecars matched a content file so we can also remove
  // orphaned sidecars (sidecar present but content file gone).
  const pairedSidecarIds = new Set<string>();
  for (const filepath of contentFiles) {
    const ext = extname(filepath).slice(1).toLowerCase();
    if (supportsInline(ext)) {
      // Parse frontmatter, read id.
      try {
        const raw = readFileSync(filepath, "utf-8");
        const { frontmatter } = parseFrontmatter(raw);
        const id = typeof frontmatter.id === "string" ? (frontmatter.id as string) : null;
        if (!id) {
          stats.unparseable_files.push({
            path: filepath,
            reason: "no `id` in frontmatter",
          });
          continue;
        }
        if (!opts.validNoteIds.has(id)) {
          safeRm(filepath, () => {
            stats.notes_removed++;
          });
        }
      } catch (err) {
        stats.unparseable_files.push({
          path: filepath,
          reason: `read failed: ${(err as Error).message ?? err}`,
        });
      }
    } else {
      // Sidecar-required extension. Find the matching sidecar by
      // (path, extension) — sidecars are keyed by id, so we sweep the
      // sidecarById map.
      const relPath = relative(outDir, filepath).replace(/\\/g, "/");
      // Strip extension to get the canonical path stored in the sidecar
      // (vault paths don't carry extensions).
      const pathNoExt = relPath.slice(0, -(ext.length + 1));
      let foundId: string | null = null;
      for (const [id, info] of sidecarById.entries()) {
        if (
          info.path === pathNoExt &&
          (info.extension ?? "md").toLowerCase() === ext
        ) {
          foundId = id;
          break;
        }
      }
      if (!foundId) {
        // Content file with no sidecar — can't tell which note owns it.
        // Conservative: leave alone, record as unparseable.
        stats.unparseable_files.push({
          path: filepath,
          reason: "no sidecar metadata could be matched by (path, extension)",
        });
        continue;
      }
      pairedSidecarIds.add(foundId);
      if (!opts.validNoteIds.has(foundId)) {
        // Note is orphaned — remove both content and sidecar.
        safeRm(filepath, () => {
          stats.notes_removed++;
        });
        const sidecarPath = sidecarFilesById.get(foundId);
        if (sidecarPath) {
          safeRm(sidecarPath, () => {
            stats.sidecars_removed++;
          });
        }
      }
    }
  }

  // Sweep up orphaned sidecars (sidecar exists but no content file
  // matched OR sidecar's id isn't in validNoteIds).
  for (const [id, sidecarPath] of sidecarFilesById.entries()) {
    if (opts.validNoteIds.has(id) && pairedSidecarIds.has(id)) continue;
    if (opts.validNoteIds.has(id) && !pairedSidecarIds.has(id)) {
      // Sidecar refers to a valid note but the content file is gone —
      // that's an inconsistency, not an orphan. Leave the sidecar so
      // the next export can rewrite the content file alongside it.
      continue;
    }
    safeRm(sidecarPath, () => {
      stats.sidecars_removed++;
    });
  }

  // ---- 3. Schema sidecars ----
  if (existsSync(schemasRoot)) {
    try {
      for (const entry of readdirSync(schemasRoot)) {
        if (!entry.endsWith(".yaml")) continue;
        const full = join(schemasRoot, entry);
        try {
          const text = readFileSync(full, "utf-8");
          const { frontmatter } = parseFrontmatter(`---\n${text}---\n`);
          const name = typeof frontmatter.name === "string" ? (frontmatter.name as string) : null;
          if (!name) {
            // Fall back to filename — sanitizeTagFilename replaces `/`
            // with `__`, so reverse for the lookup.
            const fromFilename = entry.slice(0, -5).replace(/__/g, "/");
            if (!opts.validTagNames.has(fromFilename)) {
              safeRm(full, () => {
                stats.schemas_removed++;
              });
            }
            continue;
          }
          if (!opts.validTagNames.has(name)) {
            safeRm(full, () => {
              stats.schemas_removed++;
            });
          }
        } catch (err) {
          stats.unparseable_files.push({
            path: full,
            reason: `schema sweep failed: ${(err as Error).message ?? err}`,
          });
        }
      }
    } catch (err) {
      stats.unparseable_files.push({
        path: schemasRoot,
        reason: `schemas walk failed: ${(err as Error).message ?? err}`,
      });
    }
  }

  // ---- 4. Attachment directories ----
  if (existsSync(attachmentsRoot)) {
    try {
      for (const entry of readdirSync(attachmentsRoot)) {
        const full = join(attachmentsRoot, entry);
        let stat;
        try {
          stat = statSync(full);
        } catch (err) {
          stats.unparseable_files.push({
            path: full,
            reason: `stat failed: ${(err as Error).message ?? err}`,
          });
          continue;
        }
        if (!stat.isDirectory()) continue;
        // The directory name IS the attachment id (per the export layout).
        if (!opts.validAttachmentIds.has(entry)) {
          safeRm(
            full,
            () => {
              stats.attachment_dirs_removed++;
            },
            { recursive: true },
          );
        }
      }
    } catch (err) {
      stats.unparseable_files.push({
        path: attachmentsRoot,
        reason: `attachments walk failed: ${(err as Error).message ?? err}`,
      });
    }
  }

  return stats;
}

/**
 * True iff the tag carries content the export writer will emit as a
 * schema sidecar (`.parachute/schemas/<tag>.yaml`). Bare-name tags
 * (the `tags` table has a row but description/fields/relationships/
 * parents are all empty) get no sidecar — and crucially, after
 * `deleteTagSchema` clears those fields the row persists with the
 * bare name. Callers building the `validTagNames` set for
 * `pruneOrphans` MUST filter through this predicate, otherwise the
 * stale sidecar lingers indefinitely.
 *
 * Reviewer-flagged on vault#382: without this filter, a cleared
 * schema's sidecar never gets pruned.
 */
export function hasSchemaContent(tag: TagRecord): boolean {
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

/**
 * Path-traversal guard (vault#317 F3). Returns true iff `candidate` is
 * exactly `root` or sits beneath it. Both inputs must be **already
 * resolved** (no `..` segments). Uses a trailing-separator check rather
 * than a bare `startsWith` so `outDir/foo` doesn't satisfy a containment
 * check for outDir `outDi` (substring-match false-positive).
 */
function isWithinDir(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root + pathSep);
}

/**
 * Probe whether `dir` lives on a case-sensitive filesystem (vault#327).
 *
 * The check writes a hidden tempfile, then tests whether the same file
 * is reachable via its uppercased name. macOS APFS-default and Windows
 * NTFS-default are case-insensitive (the file IS reachable); Linux
 * ext4 and macOS APFS-CS are case-sensitive (the file is NOT). Other
 * platforms (FAT32, exFAT, network shares to either) collapse to the
 * same probe result.
 *
 * Returns true when the filesystem distinguishes case, false otherwise.
 * Defaults to true (case-sensitive — current export behavior) if the
 * probe fails for any reason — we'd rather ship without disambiguation
 * than fail-closed on an unexpected I/O error mid-export.
 *
 * The probe cleans up after itself: tempfile is removed before return.
 * Tempfile name uses a UUID-ish suffix so concurrent probes don't
 * collide in shared directories.
 */
export function probeCaseSensitive(dir: string): boolean {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const lowerName = `._parachute_cs_probe_${suffix}`;
  const upperName = `._PARACHUTE_CS_PROBE_${suffix.toUpperCase()}`;
  const lowerPath = join(dir, lowerName);
  const upperPath = join(dir, upperName);
  try {
    writeFileSync(lowerPath, "");
    // On a case-insensitive FS, `existsSync(upperPath)` returns true
    // because upperPath references the same inode. On a case-sensitive
    // FS, the file at upperPath doesn't exist.
    const caseInsensitive = existsSync(upperPath);
    return !caseInsensitive;
  } catch {
    // Probe failed — assume case-sensitive (the conservative default
    // that matches today's export behavior).
    return true;
  } finally {
    try { rmSync(lowerPath, { force: true }); } catch {}
    // Defensive: if some FS variant created a distinct file at
    // upperPath, clean that too. No-op when it was the same inode.
    try { rmSync(upperPath, { force: true }); } catch {}
  }
}

/**
 * Compute the disambiguated filename for a colliding note (vault#327).
 * Appends `__<id-short>` to the path's basename, before the extension.
 * The id-short is the first 8 chars of the note ID — short enough to
 * stay readable, unique enough to avoid secondary collisions in
 * practice (vault IDs are timestamp-prefixed YYYY-MM-DD-HH-MM-SS-ffffff,
 * so the first 8 chars include the year + month + day).
 *
 * Example: `Journal/2025-05-26 Technology in Balance` (path) with
 * extension `md` + id `2025-05-26-09-15-42-123456` becomes
 * `Journal/2025-05-26 Technology in Balance__2025-05-.md`.
 *
 * The original path is preserved in the note's frontmatter/sidecar
 * `path:` field — import recovers the canonical path from there, not
 * from the disambiguated filename.
 *
 * **Assumption** (vault#331 N4): two notes created in the same month
 * share the first 8 chars of the id-prefix (`YYYY-MM-`). For import,
 * this is harmless because the resolver runs three tiers in order
 * (exact-case canonical path → leftover-bucket pick → id-prefix
 * scan), and sidecars are removed from the leftover map as they're
 * consumed. By the time the id-prefix scan runs for a disambiguated
 * filename, the only sidecars that could match are still-orphaned,
 * so there's at most one candidate per scan. If two notes in the
 * same month BOTH had disambiguated filenames AND the resolver had
 * to fall through to the prefix scan for both, the first match wins
 * deterministically (sorted dir walk). Bumping the slice to 12 or 14
 * chars would tighten this further but adds noise to filenames —
 * skip it until a real workload demands the change.
 */
function disambiguateFilename(path: string, extension: string, noteId: string): string {
  const idShort = noteId.slice(0, 8);
  return `${path}__${idShort}.${extension}`;
}

function shouldIncludeForSince(note: Note, since: string): boolean {
  const stamp = note.updatedAt ?? note.createdAt;
  return stamp >= since;
}

// ---------------------------------------------------------------------------
// Vault-level import — read a portable-md directory back into a vault
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Source directory (an `exportVaultToDir` output). */
  inDir: string;
  /**
   * Wipe the vault first (DELETE FROM notes; DELETE FROM tags;
   * cascade-deletes flow through note_tags/links/attachments). The
   * disaster-recovery path; the CLI gates this behind an
   * explicit confirm prompt. Default `false` — upsert-by-id semantics
   * (existing notes updated, new ones created).
   */
  blowAway?: boolean;
  /**
   * When set, attachment binaries are restored from
   * `<inDir>/.parachute/attachments/<id>/<basename>` to
   * `<assetsDir>/<frontmatter-path>`. When unset, the DB rows are
   * created but the binaries are left untouched (handy when assetsDir
   * isn't relevant or attachments weren't exported).
   */
  assetsDir?: string;
  /**
   * Dry run — parse the export, surface what would happen, but don't
   * write anything to the store or filesystem. The returned stats still
   * count "would-create" / "would-update" so the operator can audit.
   */
  dryRun?: boolean;
}

export interface ImportStats {
  notes_created: number;
  notes_updated: number;
  schemas_restored: number;
  links_restored: number;
  attachments_restored: number;
  /** Per-skipped-link detail: target note ID missing post-import.
   *  Common when a forward-ref points at a note that wasn't exported. */
  skipped_links: Array<{ source_id: string; target_id: string; relationship: string; reason: string }>;
  /** Per-skipped-attachment detail. */
  skipped_attachments: Array<{ note_id: string; attachment_id: string; reason: string }>;
  /**
   * Sidecars under `.parachute/notes-meta/` with no matching content
   * file on disk (vault#330 S2). Each entry records the sidecar's id +
   * the expected `(path, extension)` it claimed so the operator can
   * see what's orphaned. Empty when every sidecar paired with a
   * content file during the walk.
   */
  skipped_sidecars: Array<{ sidecar_id: string; expected_path: string | null; expected_extension: string | null; reason: string }>;
  /**
   * Tag schemas whose `parent_names` was DROPPED on restore because it
   * would have created a hierarchy cycle (vault#552 — the write-time cycle
   * guard in `upsertTagRecord`). The tag itself is still restored (its
   * description/fields/relationships land); only the offending
   * `parent_names` is skipped, so the import completes instead of aborting
   * mid-flight on an uncaught `ParentCycleError`. An OLD export that carried
   * a mutual-cycle fixture (accepted before the guard shipped) still
   * imports — the cycle is warned, not fatal. Empty in the common case.
   */
  skipped_schema_parents: Array<{ tag: string; parent_names: string[]; reason: string }>;
  /** Set when the caller passed `blowAway: true`; counts notes removed. */
  notes_wiped: number;
  /**
   * (tag, field) indexed-field declarations replayed after restoring tag
   * schemas — materializes the generated columns + indexes a live vault
   * would have. Without this an imported vault's schemas say `indexed: true`
   * but the backing columns don't exist until each tag is next `update-tag`'d
   * (queries fall back to full scans). See the import re-declare fix.
   */
  indexes_declared: number;
}

// ---------------------------------------------------------------------------
// Import source — the read seam (Phase-1 shared-core, cloud design §4)
// ---------------------------------------------------------------------------

/**
 * Where an import reads its bytes from. `importVault` (the engine) owns all
 * replay policy (schema-before-notes ordering, sidecar resolution, upsert
 * merge, forward-ref link replay) and asks the source only to enumerate +
 * read — so a DO/R2 import (from an uploaded tarball / bucket) plugs its own
 * source in behind the same engine. `FsImportSource` is the bun backend
 * (reads an `exportVaultToDir` output directory).
 */
export interface ImportSource {
  /** `*.yaml` schema docs under `.parachute/schemas/` (name + raw text). */
  readSchemaFiles(): Array<{ name: string; text: string }>;
  /** Raw text of each `*.yaml` sidecar under `.parachute/notes-meta/`. */
  readNotesMetaFiles(): string[];
  /** Content files as export-root-relative POSIX paths (sorted, dot-dirs
   *  excluded, containment-guarded). */
  listContentFiles(): string[];
  /** Read one content file by its export-relative path. */
  readContentFile(relPath: string): string;
  /** Whether attachment binaries are restored (fs: `assetsDir` wired). */
  readonly attachmentsEnabled: boolean;
  /** Restore one attachment binary. `srcRelPath` is export-root-relative
   *  (`.parachute/attachments/<att.id>/<basename>`); `destRelPath` is
   *  assets-relative (the note's `attachments[].path`). Only meaningful
   *  when `attachmentsEnabled`. */
  restoreAttachment(srcRelPath: string, destRelPath: string): SinkWriteResult;
}

/**
 * Filesystem `ImportSource` — reads an `exportVaultToDir` output directory.
 * Owns the read-side path-traversal guards (refuse to follow a symlink out
 * of the sidecar, refuse an attachment whose source escapes the attachments
 * root or whose dest escapes assetsDir) so the engine consumes clean data.
 */
export class FsImportSource implements ImportSource {
  readonly attachmentsEnabled: boolean;
  private readonly inDir: string;
  private readonly inDirResolved: string;
  private readonly sidecar: string;
  private readonly assetsDirResolved?: string;

  constructor(opts: { inDir: string; assetsDir?: string }) {
    this.inDir = opts.inDir;
    this.inDirResolved = resolvePath(opts.inDir);
    this.sidecar = join(opts.inDir, SIDECAR_DIR);
    if (opts.assetsDir) this.assetsDirResolved = resolvePath(opts.assetsDir);
    this.attachmentsEnabled = !!opts.assetsDir;
  }

  readSchemaFiles(): Array<{ name: string; text: string }> {
    const dir = join(this.sidecar, "schemas");
    if (!existsSync(dir)) return [];
    const dirResolved = resolvePath(dir);
    const out: Array<{ name: string; text: string }> = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".yaml")) continue;
      const fullPath = join(dir, entry);
      // Path-traversal guard on the read side: refuse to follow a symlink
      // out of the sidecar (readdirSync only surfaces names — belt-and-
      // suspenders).
      if (!isWithinDir(resolvePath(fullPath), dirResolved)) continue;
      out.push({ name: entry, text: readFileSync(fullPath, "utf-8") });
    }
    return out;
  }

  readNotesMetaFiles(): string[] {
    const dir = join(this.sidecar, NOTES_META_DIR);
    if (!existsSync(dir)) return [];
    const dirResolved = resolvePath(dir);
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".yaml")) continue;
      if (entry.startsWith(".")) continue;
      const fullPath = join(dir, entry);
      if (!isWithinDir(resolvePath(fullPath), dirResolved)) continue;
      out.push(readFileSync(fullPath, "utf-8"));
    }
    return out;
  }

  listContentFiles(): string[] {
    const out: string[] = [];
    for (const filePath of walkContentFiles(this.inDir)) {
      // Containment check — walkContentFiles should already be safe, but
      // verify the resolved path is inside inDir (symlinks).
      if (!isWithinDir(resolvePath(filePath), this.inDirResolved)) continue;
      out.push(relative(this.inDir, filePath).split(pathSep).join("/"));
    }
    return out;
  }

  readContentFile(relPath: string): string {
    return readFileSync(join(this.inDir, relPath), "utf-8");
  }

  restoreAttachment(srcRelPath: string, destRelPath: string): SinkWriteResult {
    const attachmentsRootResolved = resolvePath(join(this.sidecar, "attachments"));
    const srcResolved = resolvePath(join(this.inDir, srcRelPath));
    if (!isWithinDir(srcResolved, attachmentsRootResolved)) {
      return { ok: false, reason: `path-traversal on source: "${srcResolved}" escapes attachments root` };
    }
    if (!existsSync(srcResolved)) {
      return { ok: false, reason: `source attachment file missing at "${srcResolved}"` };
    }
    // attachmentsEnabled guarantees assetsDirResolved is set.
    const assetsDirResolved = this.assetsDirResolved!;
    const destResolved = resolvePath(join(assetsDirResolved, destRelPath));
    if (!isWithinDir(destResolved, assetsDirResolved)) {
      return { ok: false, reason: `path-traversal on dest: "${destResolved}" escapes assetsDir` };
    }
    mkdirSync(dirname(destResolved), { recursive: true });
    copyFileSync(srcResolved, destResolved);
    return { ok: true };
  }
}

/** Engine-level import options — the subset of `ImportOptions` that isn't
 *  fs-source-specific (`inDir`/`assetsDir` are owned by `FsImportSource`). */
export interface ImportEngineOptions {
  blowAway?: boolean;
  dryRun?: boolean;
}

/**
 * Sink-agnostic import engine (Phase-1 shared-core, cloud design §4). Reads
 * an `ImportSource` and replays it into `store`. `importPortableVault` wires
 * the fs backend; a DO/R2 backend supplies its own source.
 *
 * Restoration order (matters for forward refs):
 *   1. Tag schemas (so notes with schema-bearing tags validate cleanly).
 *   2. Notes — content/path/metadata/tags. Use `restoreNoteTimestamps`
 *      after create so created_at AND updated_at land at their exported
 *      values (regular createNote sets updated_at = created_at).
 *   3. Typed links — only now that all target notes exist (forward-ref
 *      pattern). Wikilinks rebuild themselves from `[[brackets]]` in
 *      content via the existing `syncAllWikilinks` pass.
 *   4. Attachments — DB row first, then file copy from sidecar to
 *      `<assetsDir>/<path>` when the source has attachments enabled.
 *
 * See vault#308 PR 2.
 */
export async function importVault(
  store: Store,
  source: ImportSource,
  opts: ImportEngineOptions = {},
): Promise<ImportStats> {
  const stats: ImportStats = {
    notes_created: 0,
    notes_updated: 0,
    schemas_restored: 0,
    links_restored: 0,
    attachments_restored: 0,
    skipped_links: [],
    skipped_attachments: [],
    skipped_sidecars: [],
    skipped_schema_parents: [],
    notes_wiped: 0,
    indexes_declared: 0,
  };

  // 1. Optional wipe. Notes are deleted via the public Store API so hooks
  // fire (callers depend on `attachment.deleted` hooks for assets-dir
  // cleanup; we don't bypass that on blow-away). Deleted in bounded batches
  // — always take the first N remaining rows, so deletion never has to
  // materialize the whole corpus (the pre-seam `limit: 1_000_000` load).
  if (opts.blowAway && !opts.dryRun) {
    for (;;) {
      const batch = await store.queryNotes({ sort: "asc", limit: EXPORT_BATCH_SIZE });
      if (batch.length === 0) break;
      for (const note of batch) {
        await store.deleteNote(note.id);
        stats.notes_wiped++;
      }
    }
    // Clear tag rows too — `deleteNote` clears note_tags via FK cascade but
    // leaves the `tags` table rows in place (orphaned schemas). `cascade:
    // true` is REQUIRED here (vault#552): a blow-away is a full wipe, and
    // `listTagRecords` returns rows `ORDER BY name`, so a namespace parent
    // (`task`) sorts before its child (`task/work`) and is visited while the
    // child's `parent_names` still references it — without `cascade`,
    // `deleteTag` would RETURN `{error: "tag_referenced_as_parent"}` (it no
    // longer throws) and silently leave the parent's row behind, defeating
    // the "clean slate." Since we're deleting every tag anyway, cascading the
    // parent_names strip is exactly right.
    const tagRecords = await store.listTagRecords();
    for (const tag of tagRecords) {
      await store.deleteTag(tag.tag, { cascade: true });
    }
  }

  // 2. Tag schemas — restore before notes so any tag a note carries can
  // validate against its schema on insert.
  for (const { text } of source.readSchemaFiles()) {
    // Reuse the frontmatter parser by wrapping the doc in `---`s. The schema
    // file is a YAML doc (no `---` markers); pad with them so
    // `parseFrontmatter` can chew on it via the same code path.
    const wrapped = `---\n${text}${text.endsWith("\n") ? "" : "\n"}---\n`;
    const { frontmatter } = parseFrontmatter(wrapped);
    const tagName = typeof frontmatter.name === "string" ? frontmatter.name : null;
    if (!tagName) continue;
    if (opts.dryRun) {
      stats.schemas_restored++;
      continue;
    }
    const parentNames = (frontmatter.parent_names as string[] | null | undefined) ?? null;
    const patch = {
      description: (frontmatter.description as string | null | undefined) ?? null,
      fields: (frontmatter.fields as Record<string, unknown> | null | undefined) as any ?? null,
      relationships: (frontmatter.relationships as Record<string, unknown> | null | undefined) as any ?? null,
      parent_names: parentNames,
    };
    try {
      await store.upsertTagRecord(tagName, patch);
    } catch (err) {
      // vault#552: the write-time cycle guard rejects a `parent_names` that
      // would close a hierarchy cycle. An OLD export carrying a mutual-cycle
      // fixture (accepted before the guard shipped) must still import —
      // dropping the offending `parent_names` and warning, not aborting the
      // whole import mid-flight (import isn't atomic; on a blow-away replace
      // the vault was already wiped in step 1, so an uncaught throw here
      // would leave it EMPTY). Retry WITHOUT parent_names so the tag's
      // description/fields/relationships still land; record a skip warning
      // mirroring the skipped_links/skipped_attachments/skipped_sidecars
      // precedent. Any OTHER error still propagates.
      if (err instanceof ParentCycleError) {
        stats.skipped_schema_parents.push({
          tag: tagName,
          parent_names: parentNames ?? [],
          reason: `parent_names would create a hierarchy cycle (${err.cycle.join(" → ")}); dropped on import`,
        });
        await store.upsertTagRecord(tagName, { ...patch, parent_names: null });
      } else {
        throw err;
      }
    }
    stats.schemas_restored++;
  }

  // 3. Notes. Walk every content file (dot-dirs already excluded by the
  // source). For frontmatter-compatible extensions (md, mdx) parse inline
  // metadata. For sidecar-required extensions (csv, yaml, json, etc.) look
  // up metadata in `.parachute/notes-meta/<id>.yaml`.
  //
  // The sidecar's `path` + `extension` are the source of truth for the
  // user-visible filename — but we walk filenames first and INDEX sidecars
  // by `(path, extension)` for O(1) lookup per content file. Sidecars with
  // no matching content file are warned about (and skipped) rather than
  // triggering a write — preserves the export-bytes-are-truth invariant.
  // Sidecar index keyed by lowercased `<path>|<ext>` so the walker's
  // filename-derived key (also lowered) matches. The bucket holds the full
  // sidecar(s) — multiple entries occur when two notes share a
  // case-insensitive path (vault#327 collisions). The lookup picks the right
  // sidecar from the bucket using the walker's case-preserved filename + the
  // disambiguated-id-suffix heuristic.
  const sidecarByKey = new Map<string, Record<string, unknown>[]>();
  const sidecarByIdLeftover = new Map<string, Record<string, unknown>>();
  for (const text of source.readNotesMetaFiles()) {
    // The sidecar is a bare YAML doc (no `---`); wrap to reuse the shared
    // frontmatter parser.
    const wrapped = `---\n${text}${text.endsWith("\n") ? "" : "\n"}---\n`;
    const { frontmatter } = parseFrontmatter(wrapped);
    const sidecarId = typeof frontmatter.id === "string" ? frontmatter.id : null;
    const sidecarPath = typeof frontmatter.path === "string" ? frontmatter.path : null;
    const sidecarExt = typeof frontmatter.extension === "string" ? frontmatter.extension : null;
    if (!sidecarId) continue;
    // Index by (path, ext) tuple lowered so case-insensitive walks match.
    // Multi-value bucket lets two case-collided sidecars coexist until the
    // per-file lookup picks the right one.
    if (sidecarPath && sidecarExt) {
      const key = `${sidecarPath.toLowerCase()}|${sidecarExt.toLowerCase()}`;
      const bucket = sidecarByKey.get(key);
      if (bucket) bucket.push(frontmatter);
      else sidecarByKey.set(key, [frontmatter]);
    }
    sidecarByIdLeftover.set(sidecarId, frontmatter);
  }

  // Track per-import (id → portable) so we can replay typed links after all
  // notes exist.
  const seenNotes = new Map<string, PortableNote>();
  for (const relPath of source.listContentFiles()) {
    // Derive the file's extension (lowercased, no leading dot) and the
    // user-visible note path (everything between the export root and the
    // extension). The source returns POSIX-relative paths already.
    const extWithDot = extname(relPath); // e.g. ".csv"
    const fileExt = extWithDot.slice(1).toLowerCase();
    if (fileExt.length === 0) continue;
    const userPath = relPath.slice(0, relPath.length - extWithDot.length);

    let frontmatter: Record<string, unknown>;
    let content: string;
    if (supportsInlineFrontmatter(fileExt)) {
      const raw = source.readContentFile(relPath);
      const parsed = parseFrontmatter(raw);
      frontmatter = parsed.frontmatter;
      content = parsed.content;
    } else {
      // Resolve which sidecar this content file belongs to. Two sources of
      // ambiguity to handle:
      //   1. vault#327 case-collisions on a case-insensitive FS — multiple
      //      sidecars share the same lowered (path, ext) key.
      //   2. Disambiguated filenames — `<base>__<id-prefix>.<ext>` — where
      //      the walker's path doesn't match any sidecar's canonical path.
      // Resolution order: exact-case match within the bucket → id-prefix
      // match against the disambiguation suffix → first remaining sidecar in
      // the bucket → fall through to id-prefix scan of all leftovers.
      let found: Record<string, unknown> | undefined;
      const key = `${userPath.toLowerCase()}|${fileExt}`;
      const bucket = sidecarByKey.get(key);
      if (bucket && bucket.length > 0) {
        // Try exact-case match on canonical path first — distinguishes
        // case-collided notes when the FS preserves filename case but not
        // equality.
        found = bucket.find((s) => typeof s.path === "string" && s.path === userPath);
        if (!found) {
          // No exact-case match. Pick a sidecar from the bucket whose id is
          // still in `leftover` (i.e. not yet consumed by a prior file in
          // the walk). This keeps two case-collided notes on a case-sensitive
          // replay from claiming the same sidecar twice.
          found = bucket.find((s) => typeof s.id === "string" && sidecarByIdLeftover.has(s.id));
        }
      }
      if (!found) {
        // Disambiguated filename fallback: `<base>__<id-prefix>.<ext>`. Strip
        // the suffix, then find a leftover sidecar whose id starts with that
        // prefix.
        const disambigMatch = userPath.match(/^(.*)__([A-Za-z0-9-]{6,})$/);
        if (disambigMatch) {
          const idPrefix = disambigMatch[2]!;
          for (const [sidecarId, sidecar] of sidecarByIdLeftover) {
            if (sidecarId.startsWith(idPrefix)) {
              found = sidecar;
              break;
            }
          }
        }
      }
      if (!found) {
        // No sidecar — log and skip. Importing the raw bytes with no metadata
        // would orphan the row (no id, no path, no timestamps). Better to
        // surface the gap than silently lose shape.
        // eslint-disable-next-line no-console
        console.warn(`[import] skipped "${relPath}": no matching sidecar at ${NOTES_META_DIR}/<id>.yaml (path="${userPath}", extension="${fileExt}")`);
        continue;
      }
      frontmatter = found;
      content = source.readContentFile(relPath);
      // Mark this sidecar as consumed so subsequent files (and the
      // stale-sidecar pass) don't double-count.
      const sidecarId = typeof found.id === "string" ? found.id : null;
      if (sidecarId) sidecarByIdLeftover.delete(sidecarId);
    }

    const id = typeof frontmatter.id === "string" ? frontmatter.id : null;
    if (!id) {
      // No `id` → legacy obsidian-style note. Skip with a warning; the
      // importer is for the portable-md format, the legacy path stays on the
      // obsidian.ts parseObsidianVault flow.
      // eslint-disable-next-line no-console
      console.warn(`[import] skipped "${relPath}": no \`id\` in frontmatter (legacy obsidian format — use parseObsidianVault)`);
      continue;
    }
    const created_at = typeof frontmatter.created_at === "string" ? frontmatter.created_at : new Date().toISOString();
    const updated_at = typeof frontmatter.updated_at === "string" ? frontmatter.updated_at : created_at;
    const path = typeof frontmatter.path === "string" ? frontmatter.path : undefined;
    // Trust the frontmatter/sidecar extension first; fall back to the
    // filename extension. Notes without an explicit extension default to "md"
    // (back-compat with pre-vault#328 exports).
    const extension = typeof frontmatter.extension === "string"
      ? frontmatter.extension
      : fileExt || "md";
    const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.filter((t): t is string => typeof t === "string") : undefined;
    const metadata = (frontmatter.metadata && typeof frontmatter.metadata === "object" && !Array.isArray(frontmatter.metadata))
      ? frontmatter.metadata as Record<string, unknown>
      : undefined;
    const links = Array.isArray(frontmatter.links) ? frontmatter.links : undefined;
    const attachments = Array.isArray(frontmatter.attachments) ? frontmatter.attachments : undefined;

    const portable: PortableNote = {
      id,
      content,
      created_at,
      updated_at,
      extension,
      ...(path ? { path } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(metadata ? { metadata } : {}),
      ...(links ? { links: links as PortableLink[] } : {}),
      ...(attachments ? { attachments: attachments as PortableAttachmentRef[] } : {}),
    };
    seenNotes.set(id, portable);

    if (opts.dryRun) {
      const existing = await store.getNote(id);
      if (existing) stats.notes_updated++; else stats.notes_created++;
      continue;
    }

    // Upsert by id. createNote will throw on duplicate id; check first.
    const existing = await store.getNote(id);
    if (existing) {
      // **Upsert merge policy** (vault#319 F2 — pinned here so future edits
      // don't drift):
      //
      //   - `content`:   ALWAYS replaced from the import. (Required — the
      //                  import always has content, even if empty string,
      //                  and that's the unambiguous source of truth on a
      //                  non-blow-away upsert.)
      //   - `tags`:      REPLACED WHOLESALE — existing tags removed, imported
      //                  set applied. The export is the source of truth for
      //                  the current tag set.
      //   - `path`:      REPLACED if the frontmatter declares one; otherwise
      //                  the existing vault path is preserved. This is
      //                  upsert-by-field, NOT replace-by-id.
      //   - `metadata`:  REPLACED if the frontmatter declares one; otherwise
      //                  existing metadata is preserved. Same upsert-by-field
      //                  asymmetry as `path`.
      //
      // For a strict replace-by-id, use `--blow-away`. Store-level updateNote
      // has no `if_updated_at` set → always succeeds (precondition gate lives
      // at the HTTP/MCP layer; the Store accepts unconditional writes from
      // importer/internal callers).
      await store.updateNote(id, {
        content,
        ...(path !== undefined ? { path } : {}),
        ...(metadata ? { metadata } : {}),
        extension,
      });
      // Tags: delete existing, re-tag with imported set.
      if (existing.tags && existing.tags.length > 0) {
        await store.untagNote(id, existing.tags);
      }
      if (tags && tags.length > 0) {
        await store.tagNote(id, tags);
      }
      stats.notes_updated++;
    } else {
      await store.createNote(content, {
        id,
        ...(path ? { path } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(metadata ? { metadata } : {}),
        created_at,
        extension,
      });
      stats.notes_created++;
    }
    // Restore both timestamps explicitly. Two reasons:
    //   1. createNote sets updated_at = created_at; we want the exported
    //      updated_at (may differ if the note was edited).
    //   2. update path bumped updated_at to now(); we want to peg it back to
    //      the exported value.
    await store.restoreNoteTimestamps(id, created_at, updated_at);
  }

  // 3b. Drain remaining sidecars (vault#330 S2). Any entry still in
  // `sidecarByIdLeftover` after the content-file walk is orphaned — its
  // expected content file wasn't on disk. Record the gap in
  // `skipped_sidecars` so programmatic callers can surface or repair.
  for (const [sidecarId, sidecar] of sidecarByIdLeftover) {
    const expectedPath = typeof sidecar.path === "string" ? sidecar.path : null;
    const expectedExt = typeof sidecar.extension === "string" ? sidecar.extension : null;
    stats.skipped_sidecars.push({
      sidecar_id: sidecarId,
      expected_path: expectedPath,
      expected_extension: expectedExt,
      reason: expectedPath
        ? `no content file at "${expectedPath}.${expectedExt ?? "md"}"`
        : "sidecar has no `path:` field; orphaned by construction",
    });
    // eslint-disable-next-line no-console
    console.warn(`[import] orphaned sidecar "${sidecarId}.yaml": ${stats.skipped_sidecars[stats.skipped_sidecars.length - 1]!.reason}`);
  }

  // 4. Typed links — replay only now that all notes exist. Wikilinks (which
  // the exporter excludes from `links:`) rebuild from content brackets via
  // syncAllWikilinks (a callable Store method).
  for (const [sourceId, portable] of seenNotes) {
    if (!portable.links) continue;
    for (const link of portable.links) {
      // Confirm target exists. Forward refs to notes the export didn't
      // include (subset export) are skipped with a warning rather than
      // aborting.
      const target = await store.getNote(link.target);
      if (!target) {
        stats.skipped_links.push({
          source_id: sourceId,
          target_id: link.target,
          relationship: link.relationship,
          reason: `target note ${link.target} not present in vault after import`,
        });
        continue;
      }
      if (opts.dryRun) {
        stats.links_restored++;
        continue;
      }
      await store.createLink(sourceId, link.target, link.relationship, link.metadata);
      stats.links_restored++;
    }
  }

  // 5. Attachments — DB row then file copy (when the source has attachments
  // enabled). Skip the file-copy phase when it isn't; the DB row still
  // restores so callers operating without an assetsDir keep parity.
  for (const [noteId, portable] of seenNotes) {
    if (!portable.attachments) continue;
    for (const att of portable.attachments) {
      if (opts.dryRun) {
        stats.attachments_restored++;
        continue;
      }
      // DB row first so the path column matches the export. The public
      // addAttachment re-mints the attachment id (there's no id-preserving
      // Store method today), so a round-trip changes att.id values while
      // (note_id, path) stays stable — a known PR-2-scope limitation
      // documented in CHANGELOG.
      const attachment = await store.addAttachment(
        noteId,
        att.path,
        att.mime_type,
        att.metadata,
      );

      // File copy: from sidecar to assetsDir. Source uses the EXPORTED
      // att.id (what the exporter wrote), not our freshly-minted row id.
      if (source.attachmentsEnabled) {
        const srcRelPath = join(SIDECAR_DIR, "attachments", att.id, basename(att.path));
        const result = source.restoreAttachment(srcRelPath, att.path);
        if (!result.ok) {
          stats.skipped_attachments.push({
            note_id: noteId,
            attachment_id: attachment.id,
            reason: result.reason,
          });
          continue;
        }
      }
      stats.attachments_restored++;
    }
  }

  // 6. Sync wikilinks across the imported set so `[[brackets]]` in content
  // rebuild link rows for the imported notes.
  if (!opts.dryRun) {
    await store.syncAllWikilinks();
  }

  // 7. Re-declare indexed fields (belt-and-suspenders + authoritative count).
  // Step 2 restored tag schemas via `store.upsertTagRecord`, which already
  // materializes the backing generated columns + indexes as it persists each
  // schema. This explicit reconcile is therefore idempotent on the happy
  // path; it stays as a safety net and gives the authoritative
  // `indexes_declared` count.
  if (!opts.dryRun) {
    stats.indexes_declared = await store.reconcileDeclaredIndexes();
  } else {
    // Dry-run: count what WOULD be declared without touching the DB. Counts
    // every `indexed: true` field including unsupported types, whereas the
    // applied `reconcileDeclaredIndexes` skips un-indexable types — so the
    // dry-run can over-count. It's a "how much indexing work" signal, not a
    // row-exact promise.
    for (const { text } of source.readSchemaFiles()) {
      const wrapped = `---\n${text}${text.endsWith("\n") ? "" : "\n"}---\n`;
      const { frontmatter } = parseFrontmatter(wrapped);
      const fields = frontmatter.fields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) {
        for (const spec of Object.values(fields as Record<string, { indexed?: boolean }>)) {
          if (spec?.indexed === true) stats.indexes_declared++;
        }
      }
    }
  }

  return stats;
}

/**
 * Read a portable-md export directory back into a vault (the bun/fs backend
 * — thin wrapper over `importVault` with an `FsImportSource`). Lossless
 * counterpart to `exportVaultToDir`. With `blowAway: true`, replaces vault
 * state byte-equivalent to the export (the disaster-recovery path). Without
 * it, upserts by frontmatter `id` — existing notes updated in place, new
 * notes created. See `importVault` for the restoration order.
 */
export async function importPortableVault(
  store: Store,
  opts: ImportOptions,
): Promise<ImportStats> {
  const sidecar = join(opts.inDir, SIDECAR_DIR);
  if (!existsSync(join(sidecar, "vault.yaml"))) {
    throw new Error(
      `not a portable-md export: missing ${join(SIDECAR_DIR, "vault.yaml")} in "${opts.inDir}". ` +
      `If this is a legacy Obsidian-shape directory, use the obsidian.ts \`parseObsidianVault\` ` +
      `path instead — vault#308 importer only handles the portable-md format.`,
    );
  }
  const source = new FsImportSource({ inDir: opts.inDir, assetsDir: opts.assetsDir });
  return importVault(store, source, { blowAway: opts.blowAway, dryRun: opts.dryRun });
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
  // 1. Strip a leading UTF-8 BOM (U+FEFF) if present. Without this an
  //    Obsidian export saved with a BOM (`﻿---\n…`) fails the open
  //    test and the whole file — frontmatter included — falls into the
  //    body, silently losing id/tags/timestamps (contract FX-FENCE-BOM).
  const src = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  // 2. Line-scan close-fence (CRLF-aware). The opening line must be
  //    EXACTLY `---`; the closing fence is the FIRST subsequent line that
  //    is EXACTLY `---` — not `----`, not `---text`, not `  ---`. An
  //    unclosed block means the whole file is body (never swallow). This
  //    replaces the old `indexOf("\n---")` which wrongly matched `\n----`
  //    and `\n---more` (contract §1.1, FX-FENCE-FOURDASH-OPEN).
  const lines = src.split(/\r?\n/);
  if (lines[0] !== "---") return { frontmatter: {}, content: src };

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { closeIdx = i; break; }
  }
  if (closeIdx === -1) return { frontmatter: {}, content: src };

  const yamlBlock = lines.slice(1, closeIdx).join("\n");
  const content = lines.slice(closeIdx + 1).join("\n");
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
    // Skip `#`-comment lines (contract C3 / §1.2). A comment at the
    // block's base level is not a key line; the parser must step over it.
    if (line.trimStart().startsWith("#")) { i++; continue; }
    const indent = countLeadingSpaces(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) { i++; continue; } // shouldn't happen at this level

    // Key regex (contract C2 / §1.2): dots allowed in keys, optional
    // whitespace before the colon (`created.at:` / `key :` both parse).
    const kv = line.slice(baseIndent).match(/^([\w][\w.-]*)\s*:\s*(.*)$/);
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
    // Key regex matches parseBlock's (contract C2): dots + optional space.
    const objMatch = after.match(/^([\w][\w.-]*)\s*:\s*(.*)$/);
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
      const sibKv = sib.slice(sibIndent).match(/^([\w][\w.-]*)\s*:\s*(.*)$/);
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
 * Quote-aware split of an inline-array body on top-level commas
 * (contract C4 / §1.2). A comma inside a single- or double-quoted string
 * does not separate items, so `"a, b", c` → `['"a, b"', 'c']`. Quote
 * chars are preserved in the parts; `parseScalarOrInline` strips them via
 * `unquote`. Mirrors the web parser's `splitInlineArray`.
 */
function splitInlineArray(inner: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ",") {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts;
}

/**
 * Parse a scalar or inline form (`[a, b]`, `{ k: v }`). Used for the
 * value portion of `key: value` lines.
 */
function parseScalarOrInline(s: string): unknown {
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    // Quote-aware split (contract C4 / §1.2): a comma inside a quoted
    // string is NOT an item separator, so `["a, b", c]` → 2 items, not 3.
    // Matches the web parser's `splitInlineArray`.
    return splitInlineArray(inner).map((part) => parseScalarOrInline(part.trim()));
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
    // Double-quoted form with escape sequences — the shape the emitter
    // produces for strings containing newlines / control characters
    // (vault#317 F1). Decode the escapes the emitter emits:
    // `\\` `\"` `\n` `\r` `\t` `\v` `\f` `\xNN`. TODO: YAML 1.2 defines
    // additional escapes (`\0` `\a` `\e` `\N` `\_` `\L` `\P` `\u<4hex>`
    // `\U<8hex>`) — the emitter never produces them, but legacy
    // vault.yaml / schema files might. Add when a real case lands.
    const body = s.slice(1, -1);
    let out = "";
    let i = 0;
    while (i < body.length) {
      const ch = body[i]!;
      if (ch === "\\" && i + 1 < body.length) {
        const next = body[i + 1]!;
        switch (next) {
          case "\\": out += "\\"; i += 2; continue;
          case "\"": out += "\""; i += 2; continue;
          case "n":  out += "\n"; i += 2; continue;
          case "r":  out += "\r"; i += 2; continue;
          case "t":  out += "\t"; i += 2; continue;
          case "v":  out += "\v"; i += 2; continue;
          case "f":  out += "\f"; i += 2; continue;
          case "x": {
            const hex = body.slice(i + 2, i + 4);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              out += String.fromCharCode(parseInt(hex, 16));
              i += 4;
              continue;
            }
            // Malformed escape — fall through, treat as literal.
            out += ch;
            i += 1;
            continue;
          }
          default:
            // Unknown escape — preserve literally; future-proof against
            // additional YAML escapes we don't yet decode.
            out += ch + next;
            i += 2;
            continue;
        }
      }
      out += ch;
      i += 1;
    }
    return out;
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

/**
 * Markdown-file classification (contract §1.7). Case-insensitive `.md`
 * OR `.markdown`. `.mdx`, `.txt`, etc. are NOT markdown for the importer.
 * Identical to the web parser's classifier.
 */
export function isMarkdownExtension(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * Named intake-excluded directory/entry segments (contract §1.9). The
 * generic `startsWith(".")` rule below subsumes the dot-prefixed ones;
 * the named set is kept explicit for readability + to cover
 * `__MACOSX`/`node_modules` (which do not start with ".").
 */
const EXCLUDED_SEGMENTS = new Set([
  ".obsidian",
  ".trash",
  ".git",
  ".parachute",
  "__MACOSX",
  "node_modules",
]);

/**
 * Intake (file-selection) exclusion (contract §1.9). Excludes a source
 * path if ANY `/`-segment is a named-excluded entry OR starts with "."
 * (generic dotfile/dotdir). Applied identically by both parsers before
 * parsing. The generic dot rule means legit dot-prefixed user files
 * (`.daily-note.md`) ARE excluded — the chosen, consistent behavior.
 */
export function isExcludedPath(sourcePath: string): boolean {
  for (const segment of sourcePath.split("/")) {
    if (segment === "") continue;
    if (EXCLUDED_SEGMENTS.has(segment)) return true;
    if (segment.startsWith(".")) return true;
  }
  return false;
}

/** Recursively list all .md / .markdown files in a directory, excluding
 *  hidden + named-internal dirs per the canonical `isExcludedPath` rule
 *  (`.parachute/`, `.obsidian/`, `node_modules`, …). Legacy import path. */
export function walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      // Per-segment exclusion: the named set + generic dotfile rule.
      if (EXCLUDED_SEGMENTS.has(entry) || entry.startsWith(".")) continue;
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && isMarkdownExtension(entry)) results.push(full);
    }
  }
  walk(dir);
  return results.sort();
}

/**
 * Recursively list all content files in a portable-md export (vault#328).
 * Same dot-dir exclusion as `walkMarkdownFiles` — sidecar metadata under
 * `.parachute/` is reached separately by the importer. Files with no
 * extension are skipped (no way to tell what they are; vault doesn't
 * write extensionless notes by design).
 */
export function walkContentFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      if (entry.startsWith(".")) continue;
      if (entry === "node_modules") continue;
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && extname(entry).length > 0) results.push(full);
    }
  }
  walk(dir);
  return results.sort();
}

/**
 * Canonical inline-tag regex (contract §1.3). `#` at line-start or after
 * whitespace; body chars `[A-Za-z0-9_/-]` (slash for hierarchy); the tag
 * MUST contain ≥1 non-numeric char (the middle `[A-Za-z_/-]`), so `#2024`
 * is NOT a tag but `#v2`, `#2024-plan`, `#area/sub` are. Identical to the
 * web parser's `INLINE_HASHTAG`.
 */
const INLINE_TAG_REGEX = /(?:^|\s)#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g;

/**
 * Normalize + slug-validate a tag value (contract §1.4). Shared by inline
 * tag extraction and frontmatter tag extraction (obsidian.ts re-exports
 * this) so both surfaces validate identically. Returns null when the
 * value is unusable (non-string non-scalar, empty, or fails slug rules).
 */
export function normalizeTagValue(v: unknown): string | null {
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v).toLowerCase();
  }
  if (typeof v !== "string") return null;
  const stripped = v.trim().replace(/^#/, "").toLowerCase();
  if (stripped === "") return null;
  // Slug-validate: lowercase alnum, underscore, hyphen, slash (hierarchy).
  if (!/^[a-z0-9_/-]+$/.test(stripped)) return null;
  return stripped;
}

/** Extract inline #tags from markdown content. Excludes tags in code blocks. */
export function extractInlineTags(content: string): string[] {
  let stripped = content.replace(/```[\s\S]*?```/g, "");
  stripped = stripped.replace(/`[^`\n]+`/g, "");
  const tags = new Set<string>();
  const regex = new RegExp(INLINE_TAG_REGEX.source, INLINE_TAG_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stripped)) !== null) {
    const tag = normalizeTagValue(match[1]!);
    if (tag) tags.add(tag);
  }
  return [...tags];
}
