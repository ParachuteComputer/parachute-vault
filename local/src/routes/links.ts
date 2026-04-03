import { Hono } from "hono";
import type { SqliteStore } from "@parachute/core";

export function linkRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  // POST / — Create link
  app.post("/", async (c) => {
    const body = await c.req.json<{
      source_id: string;
      target_id: string;
      relationship: string;
    }>();

    if (!body.source_id || !body.target_id || !body.relationship) {
      return c.json({ error: "source_id, target_id, and relationship are required" }, 400);
    }

    const link = store.createLink(body.source_id, body.target_id, body.relationship);
    return c.json(link, 201);
  });

  // DELETE / — Delete link
  app.delete("/", async (c) => {
    const body = await c.req.json<{
      source_id: string;
      target_id: string;
      relationship: string;
    }>();

    store.deleteLink(body.source_id, body.target_id, body.relationship);
    return c.json({ deleted: true });
  });

  return app;
}
