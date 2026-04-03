import { Hono } from "hono";
import type { SqliteStore } from "@parachute/core";

export function noteRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  // GET / — Query notes
  app.get("/", (c) => {
    const tag = c.req.query("tag");
    const tags = tag ? tag.split(",") : undefined;
    const excludeTag = c.req.query("exclude_tag");
    const excludeTags = excludeTag ? excludeTag.split(",") : undefined;
    const dateFrom = c.req.query("date_from");
    const dateTo = c.req.query("date_to");
    const sort = c.req.query("sort") as "asc" | "desc" | undefined;
    const limit = c.req.query("limit");
    const offset = c.req.query("offset");

    const results = store.queryNotes({
      tags,
      excludeTags,
      dateFrom: dateFrom ?? undefined,
      dateTo: dateTo ?? undefined,
      sort: sort ?? undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    return c.json(results);
  });

  // POST / — Create note
  app.post("/", async (c) => {
    const body = await c.req.json<{
      content: string;
      id?: string;
      path?: string;
      tags?: string[];
    }>();

    const note = store.createNote(body.content ?? "", {
      id: body.id,
      path: body.path,
      tags: body.tags,
    });

    return c.json(note, 201);
  });

  // GET /:id — Get note
  app.get("/:id", (c) => {
    const id = c.req.param("id");
    const note = store.getNote(id);
    if (!note) return c.json({ error: "Not found" }, 404);
    return c.json(note);
  });

  // PATCH /:id — Update note
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = store.getNote(id);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{
      content?: string;
      path?: string;
    }>();

    const updated = store.updateNote(id, {
      content: body.content,
      path: body.path,
    });

    return c.json(updated);
  });

  // DELETE /:id — Delete note
  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    const existing = store.getNote(id);
    if (!existing) return c.json({ error: "Not found" }, 404);

    store.deleteNote(id);
    return c.json({ deleted: true });
  });

  // POST /:id/tags — Tag a note
  app.post("/:id/tags", async (c) => {
    const id = c.req.param("id");
    const existing = store.getNote(id);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{ tags: string[] }>();
    store.tagNote(id, body.tags);
    return c.json(store.getNote(id));
  });

  // DELETE /:id/tags — Untag a note
  app.delete("/:id/tags", async (c) => {
    const id = c.req.param("id");
    const existing = store.getNote(id);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{ tags: string[] }>();
    store.untagNote(id, body.tags);
    return c.json(store.getNote(id));
  });

  // GET /:id/links — Get links for a note
  app.get("/:id/links", (c) => {
    const id = c.req.param("id");
    const direction = c.req.query("direction") as "outbound" | "inbound" | "both" | undefined;

    const links = store.getLinks(id, {
      direction: direction ?? "both",
    });

    return c.json(links);
  });

  // POST /:id/attachments — Add an attachment to a note
  app.post("/:id/attachments", async (c) => {
    const id = c.req.param("id");
    const existing = store.getNote(id);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{ path: string; mime_type: string }>();
    if (!body.path || !body.mime_type) {
      return c.json({ error: "path and mime_type are required" }, 400);
    }

    const attachment = store.addAttachment(id, body.path, body.mime_type);
    return c.json(attachment, 201);
  });

  // GET /:id/attachments — Get attachments for a note
  app.get("/:id/attachments", (c) => {
    const id = c.req.param("id");
    const attachments = store.getAttachments(id);
    return c.json(attachments);
  });

  return app;
}
