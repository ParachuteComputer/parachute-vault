import { Hono } from "hono";
import type { SqliteStore } from "@parachute/core";

export function searchRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  // GET / — Full-text search
  app.get("/", (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "q parameter is required" }, 400);

    const tag = c.req.query("tag");
    const tags = tag ? tag.split(",") : undefined;
    const limit = c.req.query("limit");

    const results = store.searchNotes(query, {
      tags,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return c.json(results);
  });

  return app;
}
