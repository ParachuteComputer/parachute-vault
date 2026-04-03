import { Hono } from "hono";
import type { SqliteStore } from "@parachute/core";
import { noteRoutes } from "./routes/notes.js";
import { tagRoutes } from "./routes/tags.js";
import { linkRoutes } from "./routes/links.js";
import { searchRoutes } from "./routes/search.js";
import { storageRoutes } from "./routes/storage.js";

export function createRoutes(
  store: SqliteStore,
  assetsDir: string,
): Hono {
  const app = new Hono();

  app.route("/notes", noteRoutes(store));
  app.route("/tags", tagRoutes(store));
  app.route("/links", linkRoutes(store));
  app.route("/search", searchRoutes(store));
  app.route("/storage", storageRoutes(assetsDir));

  return app;
}
