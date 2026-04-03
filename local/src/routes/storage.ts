import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

const MAX_UPLOAD_BYTES = parseInt(
  process.env.PARACHUTE_MAX_UPLOAD_MB ?? "100",
  10,
) * 1024 * 1024;

export function storageRoutes(assetsDir: string): Hono {
  const app = new Hono();

  // Allowed upload extensions
  const ALLOWED_EXTENSIONS = new Set([
    ".wav", ".mp3", ".m4a", ".ogg", ".webm",
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ]);

  // POST /upload — Upload a file
  app.post("/upload", async (c) => {
    try {
      const formData = await c.req.formData();
      const file = formData.get("file") as File | null;
      if (!file) return c.json({ error: "file is required" }, 400);

      if (file.size > MAX_UPLOAD_BYTES) {
        return c.json({
          error: `File too large (${Math.round(file.size / 1024 / 1024)}MB). Max: ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`,
        }, 413);
      }

      const ext = path.extname(file.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return c.json({ error: `File type ${ext} not allowed` }, 400);
      }

      // Organize by date
      const date = new Date().toISOString().split("T")[0];
      const dir = path.join(assetsDir, date);
      fs.mkdirSync(dir, { recursive: true });

      // Write file
      const filename = `${Date.now()}-${file.name}`;
      const filePath = path.join(dir, filename);
      const buffer = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(filePath, buffer);

      const relativePath = `${date}/${filename}`;
      return c.json({ path: relativePath, size: buffer.length }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      return c.json({ error: message }, 500);
    }
  });

  // GET /:date/:file — Serve a stored file
  app.get("/:date/:file", (c) => {
    const reqPath = `${c.req.param("date")}/${c.req.param("file")}`;
    const filePath = path.normalize(path.join(assetsDir, reqPath));

    // Prevent path traversal outside assets directory
    if (!filePath.startsWith(assetsDir)) {
      return c.json({ error: "Invalid path" }, 403);
    }

    if (!fs.existsSync(filePath)) {
      return c.json({ error: "Not found" }, 404);
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
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

    const contentType = mimeTypes[ext] ?? "application/octet-stream";
    const fileBuffer = fs.readFileSync(filePath);

    return new Response(fileBuffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
      },
    });
  });

  return app;
}
