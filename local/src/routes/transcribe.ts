import { Hono } from "hono";
import type { SqliteStore } from "@parachute/core";
import type { TranscriptionService } from "../transcription.js";
import path from "node:path";

export function transcribeRoutes(
  store: SqliteStore,
  transcription: TranscriptionService,
  assetsDir: string,
): Hono {
  const app = new Hono();

  // POST / — Transcribe audio for a note
  //
  // Body: { note_id: string, audio_path: string }
  //   - note_id: The note to update with transcription text
  //   - audio_path: Path to audio file (relative to assetsDir or absolute)
  app.post("/", async (c) => {
    const body = await c.req.json<{
      note_id: string;
      audio_path: string;
    }>();

    if (!body.note_id) {
      return c.json({ error: "note_id is required" }, 400);
    }
    if (!body.audio_path) {
      return c.json({ error: "audio_path is required" }, 400);
    }

    const note = store.getNote(body.note_id);
    if (!note) {
      return c.json({ error: "Note not found" }, 404);
    }

    // Resolve relative paths against assets directory
    let audioPath = body.audio_path;
    if (!path.isAbsolute(audioPath)) {
      audioPath = path.join(assetsDir, audioPath);
    }

    if (!(await transcription.isAvailable())) {
      return c.json({ error: "No transcription backend available" }, 503);
    }

    try {
      const result = await transcription.transcribe(audioPath);

      store.updateNote(body.note_id, { content: result.text });

      return c.json({
        note_id: body.note_id,
        text: result.text,
        backend: result.backend,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      console.error(`[transcribe] Error: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
