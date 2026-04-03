/**
 * REST API route handlers for the multi-vault server.
 *
 * Each handler receives a Store instance (already resolved for the vault)
 * and the Request, and returns a Response.
 */

import type { Store } from "@parachute/core";

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

  // GET /notes — Query notes
  if (method === "GET" && path === "") {
    const results = store.queryNotes({
      tags: parseQueryList(url, "tag"),
      excludeTags: parseQueryList(url, "exclude_tag"),
      dateFrom: parseQuery(url, "date_from") ?? undefined,
      dateTo: parseQuery(url, "date_to") ?? undefined,
      sort: (parseQuery(url, "sort") as "asc" | "desc") ?? undefined,
      limit: parseQuery(url, "limit") ? parseInt(parseQuery(url, "limit")!, 10) : undefined,
      offset: parseQuery(url, "offset") ? parseInt(parseQuery(url, "offset")!, 10) : undefined,
    });
    return json(results);
  }

  // POST /notes — Create note
  if (method === "POST" && path === "") {
    const body = await req.json() as {
      content: string;
      id?: string;
      path?: string;
      tags?: string[];
    };
    const note = store.createNote(body.content ?? "", {
      id: body.id,
      path: body.path,
      tags: body.tags,
    });
    return json(note, 201);
  }

  // Routes with note ID
  const idMatch = path.match(/^\/([^/]+)(\/.*)?$/);
  if (!idMatch) return json({ error: "Not found" }, 404);

  const noteId = idMatch[1];
  const subpath = idMatch[2] ?? "";

  // GET /notes/:id
  if (method === "GET" && subpath === "") {
    const note = store.getNote(noteId);
    if (!note) return json({ error: "Not found" }, 404);
    return json(note);
  }

  // PATCH /notes/:id
  if (method === "PATCH" && subpath === "") {
    const existing = store.getNote(noteId);
    if (!existing) return json({ error: "Not found" }, 404);
    const body = await req.json() as { content?: string; path?: string };
    const updated = store.updateNote(noteId, { content: body.content, path: body.path });
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

  // GET /notes/:id/links
  if (method === "GET" && subpath === "/links") {
    const direction = parseQuery(url, "direction") as "outbound" | "inbound" | "both" | null;
    const links = store.getLinks(noteId, { direction: direction ?? "both" });
    return json(links);
  }

  // POST /notes/:id/attachments
  if (method === "POST" && subpath === "/attachments") {
    const existing = store.getNote(noteId);
    if (!existing) return json({ error: "Not found" }, 404);
    const body = await req.json() as { path: string; mime_type: string };
    if (!body.path || !body.mime_type) {
      return json({ error: "path and mime_type are required" }, 400);
    }
    const attachment = store.addAttachment(noteId, body.path, body.mime_type);
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

export function handleTags(req: Request, store: Store): Response {
  if (req.method === "GET") {
    return json(store.listTags());
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
  if (req.method === "POST") {
    const body = await req.json() as {
      source_id: string;
      target_id: string;
      relationship: string;
    };
    if (!body.source_id || !body.target_id || !body.relationship) {
      return json({ error: "source_id, target_id, and relationship are required" }, 400);
    }
    const link = store.createLink(body.source_id, body.target_id, body.relationship);
    return json(link, 201);
  }

  if (req.method === "DELETE") {
    const body = await req.json() as {
      source_id: string;
      target_id: string;
      relationship: string;
    };
    store.deleteLink(body.source_id, body.target_id, body.relationship);
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed" }, 405);
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
