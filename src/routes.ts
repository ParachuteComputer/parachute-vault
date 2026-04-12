/**
 * REST API route handlers for the multi-vault server.
 *
 * Each handler receives a Store instance (already resolved for the vault)
 * and the Request, and returns a Response.
 */

import type { Store } from "../core/src/types.ts";
import { resolveWikilinkDetailed, listUnresolvedWikilinks } from "../core/src/wikilinks.ts";
import { toNoteIndex } from "../core/src/notes.ts";
import { join, extname, normalize } from "path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { vaultDir } from "./config.ts";
function parseBool(val: string | null, defaultVal: boolean): boolean {
  if (val === null) return defaultVal;
  return val === "true" || val === "1";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function parseQuery(url: URL, key: string): string | null {
  return url.searchParams.get(key);
}

function parseQueryList(url: URL, key: string): string[] | undefined {
  const val = url.searchParams.get(key);
  return val ? val.split(",") : undefined;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function handleNotes(
  req: Request,
  store: Store,
  path: string,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // GET /notes — Query notes.
  // Default response is the lean index shape (no content). Pass
  // ?include_content=true to get full notes. Pass ?ids=a,b,c to fetch
  // specific notes by ID (still honors include_content).
  if (method === "GET" && path === "") {
    const includeContent = parseBool(parseQuery(url, "include_content"), false);
    const ids = parseQueryList(url, "ids");
    const fetched = ids
      ? store.getNotes(ids)
      : store.queryNotes({
          tags: parseQueryList(url, "tag"),
          tagMatch: (parseQuery(url, "tag_match") as "all" | "any") ?? undefined,
          excludeTags: parseQueryList(url, "exclude_tag"),
          dateFrom: parseQuery(url, "date_from") ?? undefined,
          dateTo: parseQuery(url, "date_to") ?? undefined,
          sort: (parseQuery(url, "sort") as "asc" | "desc") ?? undefined,
          limit: parseQuery(url, "limit") ? parseInt(parseQuery(url, "limit")!, 10) : undefined,
          offset: parseQuery(url, "offset") ? parseInt(parseQuery(url, "offset")!, 10) : undefined,
        });
    return json(includeContent ? fetched : fetched.map(toNoteIndex));
  }

  // POST /notes — Create note
  if (method === "POST" && path === "") {
    const body = await req.json() as {
      content: string;
      id?: string;
      path?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
      createdAt?: string;
    };
    const note = store.createNote(body.content ?? "", {
      id: body.id,
      path: body.path,
      tags: body.tags,
      metadata: body.metadata,
      created_at: body.createdAt,
    });
    return json(note, 201);
  }

  // Routes with note ID
  const idMatch = path.match(/^\/([^/]+)(\/.*)?$/);
  if (!idMatch) return json({ error: "Not found" }, 404);

  const noteId = idMatch[1];
  const subpath = idMatch[2] ?? "";

  // GET /notes/:id
  // Defaults to full content (the point-read case). Pass
  // ?include_content=false to get the lean index shape.
  if (method === "GET" && subpath === "") {
    const note = store.getNote(noteId);
    if (!note) return json({ error: "Not found" }, 404);
    const includeContent = parseBool(parseQuery(url, "include_content"), true);
    return json(includeContent ? note : toNoteIndex(note));
  }

  // PATCH /notes/:id
  if (method === "PATCH" && subpath === "") {
    const existing = store.getNote(noteId);
    if (!existing) return json({ error: "Not found" }, 404);
    const body = await req.json() as { content?: string; path?: string; metadata?: Record<string, unknown>; created_at?: string };
    const updated = store.updateNote(noteId, { content: body.content, path: body.path, metadata: body.metadata, created_at: body.created_at });
    return json(updated);
  }

  // DELETE /notes/:id
  if (method === "DELETE" && subpath === "") {
    const existing = store.getNote(noteId);
    if (!existing) return json({ error: "Not found" }, 404);
    store.deleteNote(noteId);
    return json({ deleted: true });
  }

  // POST /notes/:id/tags
  if (method === "POST" && subpath === "/tags") {
    const existing = store.getNote(noteId);
    if (!existing) return json({ error: "Not found" }, 404);
    const body = await req.json() as { tags: string[] };
    store.tagNote(noteId, body.tags);
    return json(store.getNote(noteId));
  }

  // DELETE /notes/:id/tags
  if (method === "DELETE" && subpath === "/tags") {
    const existing = store.getNote(noteId);
    if (!existing) return json({ error: "Not found" }, 404);
    const body = await req.json() as { tags: string[] };
    store.untagNote(noteId, body.tags);
    return json(store.getNote(noteId));
  }

  // POST /notes/:id/attachments
  if (method === "POST" && subpath === "/attachments") {
    const existing = store.getNote(noteId);
    if (!existing) return json({ error: "Not found" }, 404);
    const body = await req.json() as { path: string; mimeType: string };
    if (!body.path || !body.mimeType) {
      return json({ error: "path and mimeType are required" }, 400);
    }
    const attachment = store.addAttachment(noteId, body.path, body.mimeType);
    return json(attachment, 201);
  }

  // GET /notes/:id/attachments
  if (method === "GET" && subpath === "/attachments") {
    const attachments = store.getAttachments(noteId);
    return json(attachments);
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function handleTags(req: Request, store: Store, subpath = ""): Response {
  if (req.method === "GET" && subpath === "") {
    return json(store.listTags());
  }

  // DELETE /tags/:name
  const nameMatch = subpath.match(/^\/(.+)$/);
  if (req.method === "DELETE" && nameMatch) {
    const tagName = decodeURIComponent(nameMatch[1]);
    const result = store.deleteTag(tagName);
    return json(result);
  }

  return json({ error: "Method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export async function handleLinks(
  req: Request,
  store: Store,
): Promise<Response> {
  // GET /links — list edges.
  // Filters: ?note_id (only links touching this note), ?direction
  // (outbound|inbound|both, only meaningful with note_id), ?relationship.
  // Returns bare Link[], no hydration. Pair with GET /notes?ids=... if you
  // need the connected notes' details.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const noteId = parseQuery(url, "note_id") ?? undefined;
    const direction = (parseQuery(url, "direction") as "outbound" | "inbound" | "both" | null) ?? undefined;
    const relationship = parseQuery(url, "relationship") ?? undefined;
    return json(store.listLinks({ noteId, direction: direction ?? undefined, relationship }));
  }

  if (req.method === "POST") {
    const body = await req.json() as {
      sourceId: string;
      targetId: string;
      relationship: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.sourceId || !body.targetId || !body.relationship) {
      return json({ error: "sourceId, targetId, and relationship are required" }, 400);
    }
    const link = store.createLink(body.sourceId, body.targetId, body.relationship, body.metadata);
    return json(link, 201);
  }

  if (req.method === "DELETE") {
    const body = await req.json() as {
      sourceId: string;
      targetId: string;
      relationship: string;
    };
    store.deleteLink(body.sourceId, body.targetId, body.relationship);
    return json({ deleted: true });
  }

  // GET handled in the new polymorphic path below
  return json({ error: "Method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/**
 * GET /graph — one-shot knowledge graph payload.
 *
 * Returns { notes, links, tags, meta }. Lean notes by default (NoteIndex),
 * include_content=true fattens them. Optional tag filter restricts notes
 * to a subgraph; links are filtered to edges between notes in the subset.
 */
export function handleGraph(req: Request, store: Store): Response {
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }
  const url = new URL(req.url);
  const tags = parseQueryList(url, "tag");
  const tagMatch = (parseQuery(url, "tag_match") as "all" | "any") ?? undefined;
  const excludeTags = parseQueryList(url, "exclude_tag");
  const includeContent = parseBool(parseQuery(url, "include_content"), false);

  const hasTagFilter = !!(tags?.length || excludeTags?.length);
  const filteredNotes = store.queryNotes({
    tags,
    tagMatch,
    excludeTags,
    limit: 1_000_000,
  });
  const outNotes = includeContent ? filteredNotes : filteredNotes.map(toNoteIndex);

  const allLinks = store.listLinks();
  const outLinks = hasTagFilter
    ? (() => {
        const ids = new Set(filteredNotes.map((n) => n.id));
        return allLinks.filter((l) => ids.has(l.sourceId) && ids.has(l.targetId));
      })()
    : allLinks;

  const stats = store.getVaultStats({ topTagsLimit: 1_000_000 });

  return json({
    notes: outNotes,
    links: outLinks,
    tags: store.listTags(),
    meta: {
      totalNotes: stats.totalNotes,
      totalLinks: allLinks.length,
      filteredNotes: outNotes.length,
      filteredLinks: outLinks.length,
      includeContent,
    },
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function handleSearch(req: Request, store: Store): Response {
  const url = new URL(req.url);
  const query = url.searchParams.get("q");
  if (!query) return json({ error: "q parameter is required" }, 400);

  const tags = parseQueryList(url, "tag");
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  const results = store.searchNotes(query, { tags, limit });
  return json(results);
}

// ---------------------------------------------------------------------------
// Wikilinks
// ---------------------------------------------------------------------------

export function handleResolveWikilink(req: Request, store: Store): Response {
  const url = new URL(req.url);
  const target = url.searchParams.get("target");
  if (!target) return json({ error: "target parameter is required" }, 400);
  const db = (store as any).db;
  return json(resolveWikilinkDetailed(db, target));
}

export function handleUnresolvedWikilinks(req: Request, store: Store): Response {
  const url = new URL(req.url);
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : 50;
  const db = (store as any).db;
  return json(listUnresolvedWikilinks(db, limit));
}

// ---------------------------------------------------------------------------
// Storage (file upload/serve)
// ---------------------------------------------------------------------------

export function assetsDir(vault: string): string {
  return process.env.ASSETS_DIR ?? join(vaultDir(vault), "assets");
}
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

const ALLOWED_EXTENSIONS = new Set([
  ".wav", ".mp3", ".m4a", ".ogg", ".webm",
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
]);

const MIME_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function handleStorage(req: Request, path: string, vault: string): Promise<Response> {
  const assets = assetsDir(vault);

  // POST /storage/upload
  if (req.method === "POST" && path === "/upload") {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return json({ error: "file is required" }, 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return json({ error: `File too large (${Math.round(file.size / 1024 / 1024)}MB). Max: 100MB` }, 413);
    }
    const ext = extname(file.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return json({ error: `File type ${ext} not allowed` }, 400);
    }

    // Store the file
    const date = new Date().toISOString().split("T")[0];
    const dir = join(assets, date);
    mkdirSync(dir, { recursive: true });

    const filename = `${Date.now()}-${file.name}`;
    const filePath = join(dir, filename);
    const buffer = Buffer.from(await file.arrayBuffer());
    writeFileSync(filePath, buffer);

    const relativePath = `${date}/${filename}`;
    const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

    return json({
      path: relativePath,
      size: buffer.length,
      mimeType,
    }, 201);
  }

  // GET /storage/:date/:file
  const fileMatch = path.match(/^\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && fileMatch) {
    const reqPath = `${fileMatch[1]}/${fileMatch[2]}`;
    const filePath = normalize(join(assets, reqPath));

    if (!filePath.startsWith(normalize(assets))) {
      return json({ error: "Invalid path" }, 403);
    }
    if (!existsSync(filePath)) {
      return json({ error: "Not found" }, 404);
    }

    const stat = statSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const fileBuffer = readFileSync(filePath);

    return new Response(fileBuffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
      },
    });
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Published notes — public, no-auth HTML rendering
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal markdown-to-HTML for published notes. Handles:
 * - Paragraphs (blank-line separated)
 * - Headers (# through ######)
 * - Bold (**text**), italic (*text*), inline code (`code`)
 * - Unordered lists (- item)
 * - Fenced code blocks (```...```)
 * - Links [text](url)
 *
 * This is intentionally simple — we don't pull in a markdown library.
 */
function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code blocks
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        out.push("</code></pre>");
        inCodeBlock = false;
      } else {
        out.push("<pre><code>");
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      out.push(escapeHtml(line));
      continue;
    }

    const trimmed = line.trim();

    // Empty line
    if (!trimmed) {
      out.push("");
      continue;
    }

    // Headers
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      out.push(`<h${level}>${inlineMarkdown(escapeHtml(headerMatch[2]))}</h${level}>`);
      continue;
    }

    // Unordered list items
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      // Collect consecutive list items
      const items: string[] = [trimmed.slice(2)];
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next.startsWith("- ") || next.startsWith("* ")) {
          items.push(next.slice(2));
          i++;
        } else break;
      }
      out.push("<ul>");
      for (const item of items) {
        out.push(`<li>${inlineMarkdown(escapeHtml(item))}</li>`);
      }
      out.push("</ul>");
      continue;
    }

    // Paragraph
    out.push(`<p>${inlineMarkdown(escapeHtml(trimmed))}</p>`);
  }

  if (inCodeBlock) out.push("</code></pre>");
  return out.join("\n");
}

function inlineMarkdown(html: string): string {
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Inline code
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  // Links [text](url) — sanitize href to prevent javascript:/data: XSS
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, (_match, text, url) => {
    const decoded = url.replace(/&amp;/g, "&");
    if (/^(https?:|mailto:|#|\/)/i.test(decoded)) {
      return `<a href="${url}">${text}</a>`;
    }
    return text; // strip unsafe links, keep text
  });
  return html;
}

/**
 * Check if a note is published. A note is published if:
 * 1. It has the configured published tag (default: "publish"), OR
 * 2. It has metadata.published === true (always honored regardless of custom tag)
 */
function isNotePublished(note: { tags?: string[]; metadata?: unknown }, publishedTag: string = "publish"): boolean {
  if (note.tags?.includes(publishedTag)) return true;
  const meta = note.metadata as Record<string, unknown> | undefined;
  if (meta?.published === true) return true;
  return false;
}

/**
 * GET /view/:noteId — serve a note as clean HTML.
 *
 * Without auth: only serves notes marked as published (via tag or metadata).
 * With auth: serves any note in the vault.
 */
export function handleViewNote(
  store: Store,
  noteId: string,
  options: { authenticated?: boolean; publishedTag?: string } = {},
): Response {
  const { authenticated = false, publishedTag = "published" } = options;
  const note = store.getNote(noteId);
  if (!note) {
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  if (!authenticated && !isNotePublished(note, publishedTag)) {
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const title = note.path?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? note.id;
  const rendered = renderMarkdown(note.content);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body {
    max-width: 42rem;
    margin: 2rem auto;
    padding: 0 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
  }
  pre {
    background: #f5f5f5;
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
  }
  code {
    font-size: 0.9em;
    background: #f5f5f5;
    padding: 0.15em 0.3em;
    border-radius: 3px;
  }
  pre code {
    background: none;
    padding: 0;
  }
  a { color: #0066cc; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
  ul { padding-left: 1.5em; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e0e0e0; }
    pre, code { background: #2a2a2a; }
    a { color: #66b3ff; }
  }
</style>
</head>
<body>
${rendered}
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

