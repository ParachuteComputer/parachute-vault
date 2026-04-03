import { Hono } from "hono";
import type { SqliteStore } from "@parachute/core";

export function tagRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  // GET / — List tags with counts
  app.get("/", (c) => {
    const tags = store.listTags();
    return c.json(tags);
  });

  return app;
}
