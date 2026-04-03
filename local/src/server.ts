import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createRoutes } from "./routes.js";
import { createStore } from "./db.js";
import { authMiddleware, authRoutes, getAuthMode } from "./auth.js";
import { TranscriptionService } from "./transcription.js";
import { transcribeRoutes } from "./routes/transcribe.js";
import { mcpRoutes } from "./mcp-http.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const PORT = parseInt(process.env.PORT ?? "1940", 10);
const DB_PATH = process.env.PARACHUTE_DB ?? path.join(os.homedir(), ".parachute", "daily.db");
const ASSETS_DIR = process.env.PARACHUTE_ASSETS ?? path.join(os.homedir(), ".parachute", "daily", "assets");

// Ensure directories exist
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });

const store = createStore(DB_PATH);
const transcription = new TranscriptionService();

const app = new Hono();

// CORS for Flutter app
app.use("/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
}));

// Auth middleware (before routes, after CORS)
app.use("/*", authMiddleware());

// Health check (auth skipped via SKIP_PATHS in middleware)
app.get("/api/health", async (c) => {
  const transcriptionAvailable = await transcription.isAvailable();
  return c.json({
    status: "ok",
    version: "0.2.0",
    schema_version: 3,
    auth_mode: getAuthMode(),
    transcription_available: transcriptionAvailable,
  });
});

// Auth management routes (localhost-only)
app.route("/api/auth", authRoutes());

// Transcription route
app.route("/api/transcribe", transcribeRoutes(store, transcription, ASSETS_DIR));

// MCP over Streamable HTTP
app.route("/mcp", mcpRoutes(store.db));

// Mount API routes
const routes = createRoutes(store, ASSETS_DIR);
app.route("/api", routes);

serve({ fetch: app.fetch, port: PORT }, async (info) => {
  const hasTranscription = await transcription.isAvailable();
  console.log(`Parachute Daily server listening on http://localhost:${info.port}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Assets: ${ASSETS_DIR}`);
  console.log(`Auth mode: ${getAuthMode()}`);
  console.log(`Transcription: ${hasTranscription ? "available" : "not available"}`);
});

export { app };
