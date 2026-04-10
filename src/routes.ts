/**
 * REST API route handlers for the multi-vault server.
 *
 * Each handler receives a Store instance (already resolved for the vault)
 * and the Request, and returns a Response.
 */

import type { Store } from "../core/src/types.ts";
import { resolveWikilinkDetailed, listUnresolvedWikilinks } from "../core/src/wikilinks.ts";
import { join, extname, normalize } from "path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { vaultDir } from "./config.ts";
import type { NarrateModule } from "./tts-hook.ts";

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
      tagMatch: (parseQuery(url, "tag_match") as "all" | "any") ?? undefined,
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
      metadata?: Record<string, unknown>;
      created_at?: string;
    };
    const note = store.createNote(body.content ?? "", {
      id: body.id,
      path: body.path,
      tags: body.tags,
      metadata: body.metadata,
      created_at: body.created_at,
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

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".ogg", ".webm"]);

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
    const result: Record<string, unknown> = {
      path: relativePath,
      size: buffer.length,
      mime_type: mimeType,
    };

    // Optional: transcribe audio in the same request
    const shouldTranscribe = form.get("transcribe");
    if (shouldTranscribe === "true" && AUDIO_EXTENSIONS.has(ext)) {
      const scribe = await getScribe();
      if (scribe) {
        try {
          const audioFile = new File([buffer], file.name, { type: file.type });
          result.transcription = await scribe.transcribe(audioFile);
        } catch (err: unknown) {
          result.transcription_error = err instanceof Error ? err.message : "transcription failed";
        }
      }
    }

    return json(result, 201);
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
// Ingest — one-request voice note flow
// ---------------------------------------------------------------------------

/**
 * POST /ingest — Upload audio, optionally transcribe, create note, attach audio.
 *
 * Multipart form:
 *   file          — audio file (required)
 *   content       — note text (optional, e.g., client transcription or user notes)
 *   created_at    — when the note was taken, ISO-8601 (optional, defaults to now)
 *   tags          — comma-separated tags (optional)
 *   path          — note path (optional)
 *   metadata      — JSON string of note metadata (optional)
 *   sync          — "true" to transcribe server-side before responding (optional)
 *   transcribe    — alias for sync (optional)
 *   id            — client-provided note ID (optional, for offline sync)
 *
 * Returns: { note, attachment, transcription? }
 */
export async function handleIngest(
  req: Request,
  store: Store,
  vault: string,
): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ error: "file is required" }, 400);
  }

  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return json({ error: `File type ${ext} not allowed` }, 400);
  }

  // 1. Store the file
  const assets = assetsDir(vault);
  const date = new Date().toISOString().split("T")[0];
  const dir = join(assets, date);
  mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${file.name}`;
  const filePath = join(dir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  writeFileSync(filePath, buffer);
  const relativePath = `${date}/${filename}`;
  const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

  // 2. Optionally transcribe (sync=true or transcribe=true)
  let transcription: string | undefined;
  let transcriptionError: string | undefined;
  const shouldTranscribe = form.get("sync") ?? form.get("transcribe");
  if (shouldTranscribe === "true" && AUDIO_EXTENSIONS.has(ext)) {
    const scribe = await getScribe();
    if (scribe) {
      try {
        const audioFile = new File([buffer], file.name, { type: file.type });
        transcription = await scribe.transcribe(audioFile);
      } catch (err) {
        transcriptionError = err instanceof Error ? err.message : "transcription failed";
      }
    }
  }

  // 3. Build note content
  const clientContent = form.get("content") as string | null;
  let content: string;
  if (transcription && clientContent) {
    content = transcription; // server transcription takes priority, client content preserved in metadata
  } else if (transcription) {
    content = transcription;
  } else if (clientContent) {
    content = clientContent;
  } else {
    content = "";
  }

  // 4. Parse options
  const createdAt = (form.get("created_at") as string) ?? undefined;
  const tagsStr = form.get("tags") as string | null;
  const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const path = (form.get("path") as string) ?? undefined;
  const id = (form.get("id") as string) ?? undefined;
  let metadata: Record<string, unknown> | undefined;
  const metadataStr = form.get("metadata") as string | null;
  if (metadataStr) {
    try { metadata = JSON.parse(metadataStr); } catch {}
  }

  // Enrich metadata with audio info
  metadata = {
    ...metadata,
    source: "voice-memo",
    audio_duration_bytes: buffer.length,
    ...(clientContent && transcription ? { client_transcription: clientContent } : {}),
    ...(transcriptionError ? { transcription_error: transcriptionError } : {}),
  };

  // 5. Create note
  const note = store.createNote(content, {
    id,
    path,
    tags,
    metadata,
    created_at: createdAt,
  });

  // 6. Create attachment
  const attachment = store.addAttachment(note.id, relativePath, mimeType, {
    size_bytes: buffer.length,
    original_filename: file.name,
  });

  return json({
    note,
    attachment,
    transcription: transcription ?? null,
  }, 201);
}

// ---------------------------------------------------------------------------
// Transcription (via parachute-scribe)
// ---------------------------------------------------------------------------

let scribeAvailable: boolean | null = null;

async function getScribe() {
  if (scribeAvailable === false) return null;
  try {
    const scribe = await import("parachute-scribe");
    scribeAvailable = true;
    return scribe;
  } catch {
    scribeAvailable = false;
    return null;
  }
}

export async function handleTranscription(req: Request): Promise<Response> {
  const scribe = await getScribe();
  if (!scribe) {
    return json({ error: "Transcription not available — parachute-scribe is not installed" }, 501);
  }

  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return json({ error: "missing 'file' field" }, 400);
  }

  try {
    const text = await scribe.transcribe(file);
    return json({ text });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "transcription failed";
    console.error("Transcription error:", message);
    return json({ error: message }, 500);
  }
}

export async function handleModels(): Promise<Response> {
  const scribe = await getScribe();
  if (!scribe) {
    return json({ data: [] });
  }
  const providers = scribe.availableProviders();
  return json({
    data: providers.transcription.map((id: string) => ({ id, object: "model" })),
  });
}

// ---------------------------------------------------------------------------
// TTS speech — OpenAI-compatible POST /v1/audio/speech (backed by narrate)
// ---------------------------------------------------------------------------

let narrateAvailable: boolean | null = null;
let narrateCached: NarrateModule | null = null;

async function getNarrate(): Promise<NarrateModule | null> {
  if (narrateAvailable === false) return null;
  if (narrateCached) return narrateCached;
  try {
    const mod = (await import("parachute-narrate")) as unknown as NarrateModule;
    narrateCached = mod;
    narrateAvailable = true;
    return mod;
  } catch {
    narrateAvailable = false;
    return null;
  }
}

/**
 * Dependencies for `handleTtsSpeech`. Production defaults dynamically
 * import `parachute-narrate`; tests inject a stub module to avoid the
 * real provider, subprocess, and ffmpeg.
 */
export interface TtsSpeechDeps {
  /** Override the narrate module resolution (for tests). */
  getNarrate?: () => Promise<NarrateModule | null>;
}


/**
 * POST /v1/audio/speech — OpenAI-compatible text-to-speech.
 *
 * Accepts the OpenAI request shape (`model`, `voice`, `input`,
 * `response_format`). `model` is ignored (the active provider is whatever
 * `parachute-narrate` resolves from env at call time). `response_format`
 * accepts `"opus"` / `"mp3"` as aliases and always returns OGG Opus,
 * because the vault unified on that format in #43. Unknown values are
 * rejected with 400 so callers don't silently get the "wrong" format.
 *
 * All heavy lifting (markdown preprocessing, provider resolution, ffmpeg
 * encoding) lives in `parachute-narrate`. This handler's job is just
 * request parsing, validation, narrate invocation, and error-to-status
 * mapping.
 */
export async function handleTtsSpeech(req: Request, deps: TtsSpeechDeps = {}): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "body must be a JSON object" }, 400);
  }
  const b = body as Record<string, unknown>;

  if (typeof b.input !== "string" || b.input.length === 0) {
    return json({ error: "'input' must be a non-empty string" }, 400);
  }
  if (b.voice !== undefined && typeof b.voice !== "string") {
    return json({ error: "'voice' must be a string" }, 400);
  }
  if (b.response_format !== undefined) {
    if (
      typeof b.response_format !== "string" ||
      (b.response_format !== "opus" && b.response_format !== "mp3")
    ) {
      return json({ error: "'response_format' must be 'opus' or 'mp3'" }, 400);
    }
  }

  const resolveNarrate = deps.getNarrate ?? getNarrate;
  const narrate = await resolveNarrate();
  if (!narrate) {
    return json({ error: "TTS not available — parachute-narrate is not installed" }, 501);
  }

  try {
    const result = await narrate.synthesize(b.input, { voice: b.voice as string | undefined });
    return new Response(result.audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/ogg",
        "Content-Length": String(result.audio.length),
      },
    });
  } catch (err) {
    // Narrate exposes typed error classes on the module surface; we
    // `instanceof`-check against the resolved module to map them to HTTP
    // statuses without substring-matching error messages. The fields are
    // optional on `NarrateModule` so an older narrate without them doesn't
    // crash the catch block with `instanceof undefined` — we null-check
    // before each check.
    if (
      narrate.NarrateEmptyInputError &&
      err instanceof narrate.NarrateEmptyInputError
    ) {
      return json(
        { error: "input has no speakable content after markdown preprocessing" },
        400,
      );
    }
    if (
      narrate.NarrateNoProviderError &&
      err instanceof narrate.NarrateNoProviderError
    ) {
      return json({ error: "TTS provider not configured" }, 503);
    }
    const message = err instanceof Error ? err.message : "TTS synthesis failed";
    console.error("TTS synthesis error:", message);
    return json({ error: message }, 500);
  }
}
