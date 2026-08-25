/**
 * Shared attachment upload policy — extension blocklist + MIME lookup.
 *
 * Canonical source for every upload path into this vault's attachment
 * storage: the REST `POST /storage/upload` handler (`src/routes.ts`, which
 * imports these constants rather than declaring its own) and the
 * attachment-ticket mint/spend path (`core/src/mcp.ts`'s
 * `request-attachment-upload` tool + `src/attachment-tickets.ts`'s spend
 * route). One list, so a blocked extension can never diverge between the
 * two upload doors into this vault (vault attachment-tickets design,
 * "shared BLOCKED_EXTENSIONS").
 *
 * Deliberately dependency-free (no `node:path`) — this module is imported
 * by `core/src/mcp.ts`, which a Cloudflare Worker (cloud's runtime) bundles
 * directly; a hand-rolled `extname` keeps that bundle Node-compat-free.
 */

// Storage upload policy: DENY-LIST (vault#517). A knowledge vault stores
// arbitrary files — ebooks, office docs, datasets, archives, binaries — so we
// accept ANY upload EXCEPT the handful of types a browser can execute as
// active content in our origin when served back from /storage/. (The prior
// allowlist rejected the long tail: .epub/.csv/.zip/… all came back "File type
// not allowed".)
//
// BLOCKED — same-origin-XSS / active-content set:
//   .html/.htm/.xhtml/.shtml/.xht  HTML — embeds <script>
//   .svg                           XML image — embeds <script>
//   .xml                           can carry XSLT / be parsed as XHTML
//   .js/.mjs/.cjs                  JavaScript
//   .css                           style-injection / UI-redress vector
//
// Two independent guards keep every STORED file inert when served:
//   1. Only the curated MIME_TYPES below map to a real (always passive) type;
//      every other extension serves as application/octet-stream — a download,
//      never rendered.
//   2. The GET byte-serve response pins `X-Content-Type-Options: nosniff`, so
//      a browser can't sniff an octet-stream body into an executable type.
// The blocklist is belt-and-suspenders on top of those: even if a future MIME
// entry or an upstream proxy weakened (1) or (2), these extensions still never
// land on disk. If a future use case needs SVG, sanitize on read (strip
// <script>/<foreignObject>) and revisit.
export const BLOCKED_ATTACHMENT_EXTENSIONS = new Set([
  ".html", ".htm", ".xhtml", ".shtml", ".xht",
  ".svg",
  ".xml",
  ".js", ".mjs", ".cjs",
  ".css",
]);

// Explicit MIME types for the commonly-previewed formats. Anything accepted
// but absent here serves as application/octet-stream — a download, never
// rendered (e.g. .pages/.key/.numbers/.azw3/.exe/arbitrary binaries). None of
// these map to an active type (text/html, image/svg+xml), so a served asset
// can't execute script; `nosniff` on the GET response makes that ironclad.
//
// INVARIANT: never add an entry that maps to a browser-active type —
// text/html, image/svg+xml, application/xhtml+xml, text/javascript,
// application/wasm, text/css. Doing so re-enables same-origin execution for
// that extension (and would mean it must also join BLOCKED_ATTACHMENT_EXTENSIONS).
export const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  // Audio
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  // Image
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  // Video
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  // Documents / ebooks / data
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".mobi": "application/x-mobipocket-ebook",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".rtf": "application/rtf",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".zip": "application/zip",
};

/** Node-`path`-free `extname`: lowercased, leading-dot dotfiles ("`.bashrc`") report no extension — same edge case Node's `path.extname` treats as extensionless. */
function extnameOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return "";
  return filename.slice(idx).toLowerCase();
}

/**
 * Extract the sanitized, lowercased extension from a caller-supplied
 * filename. Strips trailing dots/whitespace FIRST so `evil.html.` /
 * `evil.svg ` can't slip past `BLOCKED_ATTACHMENT_EXTENSIONS`
 * (`extname("evil.html.")` would otherwise be `"."`, not `.html`) — mirrors
 * `src/routes.ts`'s upload-handler sanitization exactly.
 */
export function sanitizeAttachmentExtension(filename: string): string {
  return extnameOf(filename.replace(/[.\s]+$/, ""));
}

/** MIME type for a (already-sanitized) extension, `application/octet-stream` when uncurated — never an active/executable type (see the INVARIANT above). */
export function mimeForAttachmentExtension(ext: string): string {
  return ATTACHMENT_MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Download Content-Type for an attachment path (vault#617).
 * Extension wins; the row's caller-asserted `mime_type` is never consulted.
 * Matches REST `GET /storage/<path>` (`src/routes.ts`).
 */
export function contentTypeForAttachmentPath(path: string): string {
  return mimeForAttachmentExtension(sanitizeAttachmentExtension(path));
}
