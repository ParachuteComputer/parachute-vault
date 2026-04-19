/**
 * REST API route handlers for the multi-vault server.
 *
 * Mirrors the 9 MCP tools:
 *   /api/notes          — query-notes, create-note, update-note, delete-note
 *   /api/tags           — list-tags, update-tag, delete-tag
 *   /api/find-path      — find-path
 *   /api/vault          — vault-info
 *
 * Each handler receives a Store instance (already resolved for the vault)
 * and the Request, and returns a Response.
 */

import type { Store, Note } from "../core/src/types.ts";
import { listUnresolvedWikilinks } from "../core/src/wikilinks.ts";
import { toNoteIndex, filterMetadata } from "../core/src/notes.ts";
import * as linkOps from "../core/src/links.ts";
import * as tagSchemaOps from "../core/src/tag-schemas.ts";
import {
  expandContent,
  DEFAULT_EXPAND_DEPTH,
  MAX_EXPAND_DEPTH,
  type ExpandContext,
  type ExpandMode,
} from "../core/src/expand.ts";
import { join, extname, normalize } from "path";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { vaultDir } from "./config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function parseBool(val: string | null, defaultVal: boolean): boolean {
  if (val === null) return defaultVal;
  return val === "true" || val === "1";
}

function parseQuery(url: URL, key: string): string | null {
  return url.searchParams.get(key);
}

function parseQueryList(url: URL, key: string): string[] | undefined {
  const val = url.searchParams.get(key);
  return val ? val.split(",") : undefined;
}

function parseInt10(val: string | null): number | undefined {
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

/**
 * Parse include_metadata query param.
 * - absent/null → undefined (all metadata, default)
 * - "true"/"1" → true (all metadata)
 * - "false"/"0" → false (no metadata)
 * - "summary,status" → ["summary", "status"] (field filter)
 */
function parseIncludeMetadata(url: URL): boolean | string[] | undefined {
  const val = url.searchParams.get("include_metadata");
  if (val === null) return undefined;
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  const fields = val.split(",").map((s) => s.trim()).filter(Boolean);
  if (fields.length === 0) return undefined; // empty string → treat as default (all)
  return fields;
}

/**
 * Parse expand_links/expand_depth/expand_mode from query params, returning
 * an (ExpandContext, depth) pair if expansion is requested, else null.
 */
function parseExpandParams(
  url: URL,
  db: any,
): { ctx: ExpandContext; depth: number } | null {
  if (!parseBool(parseQuery(url, "expand_links"), false)) return null;
  const modeRaw = parseQuery(url, "expand_mode");
  const mode: ExpandMode = modeRaw === "summary" ? "summary" : "full";
  const depth = Math.max(
    0,
    Math.min(
      parseInt10(parseQuery(url, "expand_depth")) ?? DEFAULT_EXPAND_DEPTH,
      MAX_EXPAND_DEPTH,
    ),
  );
  return { ctx: { db, mode, expanded: new Set() }, depth };
}


/**
 * Resolve a note by ID or path. Tries ID first, then case-insensitive path.
 */
async function resolveNote(store: Store, idOrPath: string): Promise<Note | null> {
  const byId = await store.getNote(idOrPath);
  if (byId) return byId;
  return await store.getNoteByPath(idOrPath);
}

async function requireNote(store: Store, idOrPath: string): Promise<Note> {
  const note = await resolveNote(store, idOrPath);
  if (!note) throw new NotFoundError(`Note not found: "${idOrPath}"`);
  return note;
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Notes — GET/POST/PATCH/DELETE /api/notes[/:idOrPath]
// ---------------------------------------------------------------------------

export async function handleNotes(
  req: Request,
  store: Store,
  subpath: string,
  vault?: string,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const db = (store as any).db;

  // ---- Collection routes (no ID in path) ----
  if (subpath === "") {
    // GET /notes — query (all filters as query params)
    if (method === "GET") {
      const id = parseQuery(url, "id");
      const search = parseQuery(url, "search");

      // Single note by id/path
      if (id) {
        const note = await resolveNote(store, id);
        if (!note) return json({ error: "Note not found", id }, 404);
        const includeContent = parseBool(parseQuery(url, "include_content"), true);
        let result: any = includeContent ? { ...note } : toNoteIndex(note);
        const expand = parseExpandParams(url, db);
        if (expand && includeContent && typeof result.content === "string") {
          expand.ctx.expanded.add(note.id);
          result.content = expandContent(result.content, expand.ctx, expand.depth);
        }
        result = filterMetadata(result, parseIncludeMetadata(url));
        if (parseBool(parseQuery(url, "include_links"), false)) {
          result.links = linkOps.getLinksHydrated(db, note.id);
        }
        if (parseBool(parseQuery(url, "include_attachments"), false)) {
          result.attachments = await store.getAttachments(note.id);
        }
        return json(result);
      }

      // Full-text search
      if (search) {
        const searchTags = parseQueryList(url, "tag");
        const limit = parseInt10(parseQuery(url, "limit")) ?? 50;
        const results = await store.searchNotes(search, { tags: searchTags, limit });
        const includeContent = parseBool(parseQuery(url, "include_content"), false);
        const inclMeta = parseIncludeMetadata(url);
        let output: any[] = includeContent ? results.map((n) => ({ ...n })) : results.map(toNoteIndex);
        const expand = parseExpandParams(url, db);
        if (expand && includeContent) {
          for (const n of output) expand.ctx.expanded.add(n.id);
          for (const n of output) {
            if (typeof n.content === "string") {
              n.content = expandContent(n.content, expand.ctx, expand.depth);
            }
          }
        }
        if (inclMeta !== undefined && inclMeta !== true) {
          output = output.map((n: any) => filterMetadata(n, inclMeta));
        }
        return json(output);
      }

      // Structured query
      const tags = parseQueryList(url, "tag");
      let results: Note[] = await store.queryNotes({
        tags,
        tagMatch: (parseQuery(url, "tag_match") as "all" | "any") ?? (tags && tags.length > 1 ? "any" : undefined),
        excludeTags: parseQueryList(url, "exclude_tag"),
        path: parseQuery(url, "path") ?? undefined,
        pathPrefix: parseQuery(url, "path_prefix") ?? undefined,
        metadata: undefined, // metadata filter not practical in query params
        dateFrom: parseQuery(url, "date_from") ?? undefined,
        dateTo: parseQuery(url, "date_to") ?? undefined,
        sort: (parseQuery(url, "sort") as "asc" | "desc") ?? undefined,
        limit: parseInt10(parseQuery(url, "limit")) ?? 50,
        offset: parseInt10(parseQuery(url, "offset")),
      });

      // Near-scope filter (graph neighborhood)
      const nearNoteId = parseQuery(url, "near[note_id]");
      if (nearNoteId) {
        const anchor = await resolveNote(store, nearNoteId);
        if (!anchor) return json({ error: "Anchor note not found", note_id: nearNoteId }, 404);
        const depth = Math.min(parseInt10(parseQuery(url, "near[depth]")) ?? 2, 5);
        const relationship = parseQuery(url, "near[relationship]") ?? undefined;
        const traversed = linkOps.traverseLinks(db, anchor.id, { max_depth: depth, relationship });
        const nearScope = new Set([anchor.id, ...traversed.map((t) => t.noteId)]);
        results = results.filter((n) => nearScope.has(n.id));
      }

      const includeContent = parseBool(parseQuery(url, "include_content"), false);
      const includeLinks = parseBool(parseQuery(url, "include_links"), false);
      const includeAttachments = parseBool(parseQuery(url, "include_attachments"), false);
      const inclMeta = parseIncludeMetadata(url);
      let output: any[] = includeContent ? results.map((n) => ({ ...n })) : results.map(toNoteIndex);
      const expand = parseExpandParams(url, db);
      if (expand && includeContent) {
        for (const n of output) expand.ctx.expanded.add(n.id);
        for (const n of output) {
          if (typeof n.content === "string") {
            n.content = expandContent(n.content, expand.ctx, expand.depth);
          }
        }
      }
      if (inclMeta !== undefined && inclMeta !== true) {
        output = output.map((n: any) => filterMetadata(n, inclMeta));
      }

      // Graph format — reshape into { nodes, edges }
      if (parseQuery(url, "format") === "graph") {
        const resultIds = new Set(results.map((n) => n.id));
        const nodes = output.map((n: any) => ({ id: n.id, path: n.path ?? null, tags: n.tags ?? [] }));
        const edges: { source: string; target: string; relationship: string }[] = [];
        if (includeLinks) {
          for (const n of results) {
            for (const link of linkOps.getLinksHydrated(db, n.id)) {
              // Only include edges where source is this note and target is in the result set
              if (link.sourceId === n.id && resultIds.has(link.targetId)) {
                edges.push({ source: link.sourceId, target: link.targetId, relationship: link.relationship });
              }
            }
          }
        }
        return json({ nodes, edges });
      }

      if (includeLinks || includeAttachments) {
        const enrichedOut: any[] = [];
        for (const n of output) {
          const enriched: any = { ...n };
          if (includeLinks) enriched.links = linkOps.getLinksHydrated(db, n.id);
          if (includeAttachments) enriched.attachments = await store.getAttachments(n.id);
          enrichedOut.push(enriched);
        }
        return json(enrichedOut);
      }

      return json(output);
    }

    // POST /notes — create (single or batch)
    if (method === "POST") {
      const body = await req.json() as any;
      const items: any[] = body.notes ?? [body];

      const created: Note[] = [];
      for (const item of items) {
        const note = await store.createNote(item.content ?? "", {
          id: item.id,
          path: item.path,
          tags: item.tags,
          metadata: item.metadata,
          created_at: item.createdAt ?? item.created_at,
        });

        // Create explicit links
        if (item.links) {
          for (const link of item.links as { target: string; relationship: string }[]) {
            const target = await resolveNote(store, link.target);
            if (target) await store.createLink(note.id, target.id, link.relationship);
          }
        }

        created.push((await store.getNote(note.id)) ?? note);
      }

      // Apply tag schema defaults
      for (const note of created) {
        if (note.tags?.length) {
          await applySchemaDefaults(store, db, [note.id], note.tags);
        }
      }

      return json(body.notes ? created : created[0], 201);
    }

    return json({ error: "Method not allowed" }, 405);
  }

  // ---- Note-level routes (/notes/:idOrPath[/attachments]) ----
  const idMatch = subpath.match(/^\/([^/]+)(\/.*)?$/);
  if (!idMatch) return json({ error: "Not found" }, 404);

  const idOrPath = decodeURIComponent(idMatch[1]);
  const sub = idMatch[2] ?? "";

  // Attachments sub-routes (keep as-is — Daily needs them)
  if (sub === "/attachments") {
    if (method === "POST") {
      const note = await resolveNote(store, idOrPath);
      if (!note) return json({ error: "Not found" }, 404);
      const body = await req.json() as { path: string; mimeType: string; transcribe?: boolean };
      if (!body.path || !body.mimeType) return json({ error: "path and mimeType are required" }, 400);

      // `transcribe: true` asks the transcription worker to read this audio
      // file and replace the note's content with the transcript. The caller
      // is declaring "overwrite my current content when the transcript lands"
      // — we persist that as `transcribe_stub: true` on the note so a later
      // user edit (which clears the marker) can opt out before the worker
      // runs.
      const attMeta = body.transcribe
        ? { transcribe_status: "pending" as const, transcribe_requested_at: new Date().toISOString() }
        : undefined;

      const attachment = await store.addAttachment(note.id, body.path, body.mimeType, attMeta);

      if (body.transcribe) {
        const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
        if (noteMeta.transcribe_stub !== true) {
          await store.updateNote(note.id, {
            metadata: { ...noteMeta, transcribe_stub: true },
            skipUpdatedAt: true,
          });
        }
      }

      return json(attachment, 201);
    }
    if (method === "GET") {
      const note = await resolveNote(store, idOrPath);
      if (!note) return json({ error: "Not found" }, 404);
      return json(await store.getAttachments(note.id));
    }
    return json({ error: "Method not allowed" }, 405);
  }

  const attMatch = sub.match(/^\/attachments\/([^/]+)$/);
  if (attMatch) {
    const attId = decodeURIComponent(attMatch[1]!);
    if (method === "DELETE") {
      const note = await resolveNote(store, idOrPath);
      if (!note) return json({ error: "Not found" }, 404);
      const result = await store.deleteAttachment(note.id, attId);
      if (!result.deleted) return json({ error: "Not found" }, 404);
      // Unlink the storage file only if no other attachment still references
      // the same path. Best-effort: the row is already gone, so a missing
      // file or unlink error should not flip the DELETE to an error.
      if (vault && result.path && result.orphaned) {
        const assets = assetsDir(vault);
        const filePath = normalize(join(assets, result.path));
        if (filePath.startsWith(normalize(assets)) && existsSync(filePath)) {
          try { unlinkSync(filePath); } catch {}
        }
      }
      return new Response(null, { status: 204 });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  if (sub !== "") return json({ error: "Not found" }, 404);

  // GET /notes/:idOrPath — single note
  if (method === "GET") {
    const note = await resolveNote(store, idOrPath);
    if (!note) return json({ error: "Not found" }, 404);
    const includeContent = parseBool(parseQuery(url, "include_content"), true);
    let result: any = includeContent ? { ...note } : toNoteIndex(note);
    const expand = parseExpandParams(url, db);
    if (expand && includeContent && typeof result.content === "string") {
      expand.ctx.expanded.add(note.id);
      result.content = expandContent(result.content, expand.ctx, expand.depth);
    }
    result = filterMetadata(result, parseIncludeMetadata(url));
    if (parseBool(parseQuery(url, "include_links"), false)) {
      result.links = linkOps.getLinksHydrated(db, note.id);
    }
    if (parseBool(parseQuery(url, "include_attachments"), false)) {
      result.attachments = await store.getAttachments(note.id);
    }
    return json(result);
  }

  // PATCH /notes/:idOrPath — update (content, path, metadata, tags, links)
  if (method === "PATCH") {
    try {
      const note = await resolveNote(store, idOrPath);
      if (!note) throw new NotFoundError(`Note not found: "${idOrPath}"`);
      const body = await req.json() as any;

      // --- Plan bracket cleanup for wikilink removals (no DB writes yet) ---
      // The actual link deletions happen only after the core UPDATE succeeds,
      // so a conflict leaves the note untouched.
      let contentOverride = body.content as string | undefined;
      const linksRemove = body.links?.remove as { target: string; relationship: string }[] | undefined;
      const resolvedLinksToRemove: { targetId: string; relationship: string }[] = [];
      if (linksRemove) {
        for (const link of linksRemove) {
          const target = await resolveNote(store, link.target);
          if (!target) continue;
          resolvedLinksToRemove.push({ targetId: target.id, relationship: link.relationship });
          if (link.relationship === "wikilink" && target.path) {
            const current = contentOverride ?? note.content;
            const cleaned = removeWikilinkBrackets(current, target.path);
            if (cleaned !== current) contentOverride = cleaned;
          }
        }
      }

      // --- Core update (runs the if_updated_at check atomically) ---
      const updates: any = {};
      if (contentOverride !== undefined) updates.content = contentOverride;
      if (body.path !== undefined) updates.path = body.path;
      if (body.metadata !== undefined) {
        const existing = (note.metadata as Record<string, unknown>) ?? {};
        updates.metadata = { ...existing, ...body.metadata };
      }
      if (body.created_at !== undefined || body.createdAt !== undefined) {
        updates.created_at = body.created_at ?? body.createdAt;
      }
      if (body.if_updated_at !== undefined) {
        updates.if_updated_at = body.if_updated_at;
      }

      if (Object.keys(updates).length > 0) {
        await store.updateNote(note.id, updates);
      }

      // --- Remove links (after core UPDATE; conflict would have thrown already) ---
      for (const { targetId, relationship } of resolvedLinksToRemove) {
        await store.deleteLink(note.id, targetId, relationship);
      }

      // Tags
      if (body.tags?.add?.length) {
        await store.tagNote(note.id, body.tags.add);
        await applySchemaDefaults(store, db, [note.id], body.tags.add);
      }
      if (body.tags?.remove?.length) {
        await store.untagNote(note.id, body.tags.remove);
      }

      // Add links
      if (body.links?.add) {
        for (const link of body.links.add as { target: string; relationship: string; metadata?: Record<string, unknown> }[]) {
          const target = await resolveNote(store, link.target);
          if (target) await store.createLink(note.id, target.id, link.relationship, link.metadata);
        }
      }

      return json(await store.getNote(note.id));
    } catch (e: any) {
      if (e instanceof NotFoundError) return json({ error: e.message }, 404);
      // Duck-type on `code` rather than `instanceof ConflictError`: this
      // error originates in the core package and survives any future
      // bundling / module-boundary split more robustly than a prototype check.
      if (e && e.code === "CONFLICT") {
        return json(
          {
            error: "conflict",
            message: e.message,
            note_id: e.note_id,
            current_updated_at: e.current_updated_at ?? null,
            expected_updated_at: e.expected_updated_at,
          },
          409,
        );
      }
      throw e;
    }
  }

  // DELETE /notes/:idOrPath — admin only (enforced at server level)
  if (method === "DELETE") {
    const note = await resolveNote(store, idOrPath);
    if (!note) return json({ error: "Not found" }, 404);
    await store.deleteNote(note.id);
    return json({ deleted: true, id: note.id });
  }

  return json({ error: "Method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Tags — GET/PUT/DELETE /api/tags[/:name], POST /api/tags/merge,
//        POST /api/tags/:name/rename
// ---------------------------------------------------------------------------

export async function handleTags(req: Request, store: Store, subpath = ""): Promise<Response> {
  const url = new URL(req.url);

  // GET /tags — list all, or get single tag detail
  if (req.method === "GET" && subpath === "") {
    const singleTag = parseQuery(url, "tag");

    if (singleTag) {
      const allTags = await store.listTags();
      const found = allTags.find((t) => t.name === singleTag);
      const schema = await store.getTagSchema(singleTag);
      return json({
        name: singleTag,
        count: found?.count ?? 0,
        description: schema?.description ?? null,
        fields: schema?.fields ?? null,
      });
    }

    const tags = await store.listTags();
    if (parseBool(parseQuery(url, "include_schema"), false)) {
      const schemas = await store.getTagSchemaMap();
      return json(tags.map((t) => ({
        ...t,
        description: schemas[t.name]?.description ?? null,
        fields: schemas[t.name]?.fields ?? null,
      })));
    }
    return json(tags);
  }

  // POST /tags/merge — atomic multi-source merge into a target tag.
  // Must come before the /:name matcher so "merge" isn't read as a tag name.
  if (subpath === "/merge") {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = (await req.json().catch(() => null)) as
      | { sources?: unknown; target?: unknown }
      | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);
    const sources = body.sources;
    const target = body.target;
    if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string" && s.length > 0)) {
      return json({ error: "sources must be a non-empty array of strings" }, 400);
    }
    if (typeof target !== "string" || target.length === 0) {
      return json({ error: "target must be a non-empty string" }, 400);
    }
    const result = await store.mergeTags(sources, target);
    return json(result);
  }

  // POST /tags/:name/rename — atomic rename across tags + note_tags + schema
  const renameMatch = subpath.match(/^\/([^/]+)\/rename$/);
  if (renameMatch) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const oldName = decodeURIComponent(renameMatch[1]);
    const body = (await req.json().catch(() => null)) as { new_name?: unknown } | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);
    const newName = body.new_name;
    if (typeof newName !== "string" || newName.length === 0) {
      return json({ error: "new_name must be a non-empty string" }, 400);
    }
    const result = await store.renameTag(oldName, newName);
    if ("error" in result) {
      if (result.error === "not_found") return json({ error: "not_found", tag: oldName }, 404);
      if (result.error === "target_exists") {
        return json(
          {
            error: "target_exists",
            target: newName,
            message: "Target tag already exists; use POST /api/tags/merge to combine them.",
          },
          409,
        );
      }
    }
    return json(result);
  }

  // Routes with tag name
  const nameMatch = subpath.match(/^\/([^/]+)$/);
  if (!nameMatch) return json({ error: "Not found" }, 404);
  const tagName = decodeURIComponent(nameMatch[1]);

  // GET /tags/:name — single tag detail
  if (req.method === "GET") {
    const allTags = await store.listTags();
    const found = allTags.find((t) => t.name === tagName);
    const schema = await store.getTagSchema(tagName);
    return json({
      name: tagName,
      count: found?.count ?? 0,
      description: schema?.description ?? null,
      fields: schema?.fields ?? null,
    });
  }

  // PUT /tags/:name — upsert tag schema (description + fields)
  if (req.method === "PUT") {
    const body = await req.json() as { description?: string; fields?: Record<string, unknown> };
    const existing = await store.getTagSchema(tagName);
    const mergedFields = { ...existing?.fields, ...(body.fields as any) };
    const schema = await store.upsertTagSchema(tagName, {
      description: body.description ?? existing?.description,
      fields: Object.keys(mergedFields).length > 0 ? mergedFields : undefined,
    });
    return json(schema);
  }

  // DELETE /tags/:name — delete tag + schema from all notes
  if (req.method === "DELETE") {
    await store.deleteTagSchema(tagName);
    return json(await store.deleteTag(tagName));
  }

  return json({ error: "Method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Find-path — GET /api/find-path?source=...&target=...
// ---------------------------------------------------------------------------

export async function handleFindPath(req: Request, store: Store): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const source = parseQuery(url, "source");
  const target = parseQuery(url, "target");
  if (!source || !target) return json({ error: "source and target parameters are required" }, 400);

  const db = (store as any).db;
  try {
    const sourceNote = await resolveNote(store, source);
    if (!sourceNote) return json({ error: `Note not found: "${source}"` }, 404);
    const targetNote = await resolveNote(store, target);
    if (!targetNote) return json({ error: `Note not found: "${target}"` }, 404);
    const maxDepth = Math.min(parseInt10(parseQuery(url, "max_depth")) ?? 5, 10);

    const result = linkOps.findPath(db, sourceNote.id, targetNote.id, { max_depth: maxDepth });
    return json(result);
  } catch (e: any) {
    if (e instanceof NotFoundError) return json({ error: e.message }, 404);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Vault info — GET/PATCH /api/vault
// ---------------------------------------------------------------------------

type VaultConfigLike = {
  name: string;
  description?: string;
  audio_retention?: "keep" | "until_transcribed" | "never";
};

const VALID_AUDIO_RETENTION = ["keep", "until_transcribed", "never"] as const;

function vaultResponse(vaultConfig: VaultConfigLike): Record<string, unknown> {
  return {
    name: vaultConfig.name,
    description: vaultConfig.description ?? null,
    config: {
      audio_retention: vaultConfig.audio_retention ?? "keep",
    },
  };
}

export async function handleVault(
  req: Request,
  store: Store,
  vaultConfig: VaultConfigLike,
  persist?: () => void,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const result: Record<string, unknown> = vaultResponse(vaultConfig);
    if (parseBool(parseQuery(url, "include_stats"), false)) {
      result.stats = await store.getVaultStats();
    }
    return json(result);
  }

  if (req.method === "PATCH") {
    const body = await req.json() as {
      description?: string;
      config?: { audio_retention?: string };
    };
    let dirty = false;

    if (body.description !== undefined) {
      vaultConfig.description = body.description;
      dirty = true;
    }

    if (body.config?.audio_retention !== undefined) {
      const v = body.config.audio_retention;
      if (!VALID_AUDIO_RETENTION.includes(v as typeof VALID_AUDIO_RETENTION[number])) {
        return json(
          {
            error: "invalid_audio_retention",
            message: `audio_retention must be one of: ${VALID_AUDIO_RETENTION.join(", ")}`,
          },
          400,
        );
      }
      vaultConfig.audio_retention = v as typeof VALID_AUDIO_RETENTION[number];
      dirty = true;
    }

    if (dirty && persist) persist();
    return json(vaultResponse(vaultConfig));
  }

  return json({ error: "Method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Unresolved wikilinks — REST-only (admin/maintenance)
// ---------------------------------------------------------------------------

export function handleUnresolvedWikilinks(req: Request, store: Store): Response {
  const url = new URL(req.url);
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : 50;
  const db = (store as any).db;
  return Response.json(listUnresolvedWikilinks(db, limit));
}

// ---------------------------------------------------------------------------
// Published notes — public, no-auth HTML rendering
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        out.push("</code></pre>");
        inCodeBlock = false;
      } else {
        out.push("<pre><code>");
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      out.push(escapeHtml(line));
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed) {
      out.push("");
      continue;
    }

    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      out.push(`<h${level}>${inlineMarkdown(escapeHtml(headerMatch[2]))}</h${level}>`);
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const items: string[] = [trimmed.slice(2)];
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next.startsWith("- ") || next.startsWith("* ")) {
          items.push(next.slice(2));
          i++;
        } else break;
      }
      out.push("<ul>");
      for (const item of items) {
        out.push(`<li>${inlineMarkdown(escapeHtml(item))}</li>`);
      }
      out.push("</ul>");
      continue;
    }

    out.push(`<p>${inlineMarkdown(escapeHtml(trimmed))}</p>`);
  }

  if (inCodeBlock) out.push("</code></pre>");
  return out.join("\n");
}

function inlineMarkdown(html: string): string {
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, (_match, text, url) => {
    const decoded = url.replace(/&amp;/g, "&");
    if (/^(https?:|mailto:|#|\/)/i.test(decoded)) {
      return `<a href="${url}">${text}</a>`;
    }
    return text;
  });
  return html;
}

function isNotePublished(note: { tags?: string[]; metadata?: unknown }, publishedTag: string = "publish"): boolean {
  if (note.tags?.includes(publishedTag)) return true;
  const meta = note.metadata as Record<string, unknown> | undefined;
  if (meta?.published === true) return true;
  return false;
}

/**
 * GET /view/:idOrPath — serve a note as clean HTML.
 * Supports ID or path resolution.
 */
export async function handleViewNote(
  store: Store,
  idOrPath: string,
  options: { authenticated?: boolean; publishedTag?: string } = {},
): Promise<Response> {
  const { authenticated = false, publishedTag = "publish" } = options;
  const note = await resolveNote(store, idOrPath);
  if (!note) {
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  if (!authenticated && !isNotePublished(note, publishedTag)) {
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const title = note.path?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? note.id;
  const rendered = renderMarkdown(note.content);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body {
    max-width: 42rem;
    margin: 2rem auto;
    padding: 0 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
  }
  pre {
    background: #f5f5f5;
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
  }
  code {
    font-size: 0.9em;
    background: #f5f5f5;
    padding: 0.15em 0.3em;
    border-radius: 3px;
  }
  pre code {
    background: none;
    padding: 0;
  }
  a { color: #0066cc; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
  ul { padding-left: 1.5em; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e0e0e0; }
    pre, code { background: #2a2a2a; }
    a { color: #66b3ff; }
  }
</style>
</head>
<body>
${rendered}
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

// ---------------------------------------------------------------------------
// Storage (file upload/serve) — kept as-is, Daily needs it
// ---------------------------------------------------------------------------

export function assetsDir(vault: string): string {
  return process.env.ASSETS_DIR ?? join(vaultDir(vault), "assets");
}
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

const ALLOWED_EXTENSIONS = new Set([
  ".wav", ".mp3", ".m4a", ".ogg", ".webm",
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
]);

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

    const date = new Date().toISOString().split("T")[0];
    const dir = join(assets, date);
    mkdirSync(dir, { recursive: true });

    const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`;
    const filePath = join(dir, filename);
    const buffer = Buffer.from(await file.arrayBuffer());
    writeFileSync(filePath, buffer);

    const relativePath = `${date}/${filename}`;
    const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

    return json({ path: relativePath, size: buffer.length, mimeType }, 201);
  }

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
// Tag schema defaults — same logic as core/src/mcp.ts applySchemaDefaults
// ---------------------------------------------------------------------------

async function applySchemaDefaults(store: Store, db: any, noteIds: string[], tags: string[]): Promise<void> {
  const schemas = tagSchemaOps.getTagSchemaMap(db);
  if (Object.keys(schemas).length === 0) return;

  const defaults: Record<string, unknown> = {};
  for (const tag of tags) {
    const schema = schemas[tag];
    if (!schema?.fields) continue;
    for (const [field, fieldSchema] of Object.entries(schema.fields)) {
      if (!(field in defaults)) {
        defaults[field] = defaultForField(fieldSchema);
      }
    }
  }
  if (Object.keys(defaults).length === 0) return;

  for (const noteId of noteIds) {
    const note = await store.getNote(noteId);
    if (!note) continue;
    const existing = (note.metadata as Record<string, unknown>) ?? {};
    const missing: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(defaults)) {
      if (!(field in existing)) missing[field] = value;
    }
    if (Object.keys(missing).length === 0) continue;
    await store.updateNote(noteId, {
      metadata: { ...existing, ...missing },
      skipUpdatedAt: true,
    });
  }
}

function defaultForField(field: { type: string; enum?: string[] }): unknown {
  if (field.enum && field.enum.length > 0) return field.enum[0];
  switch (field.type) {
    case "boolean": return false;
    case "integer": return 0;
    default: return "";
  }
}

function removeWikilinkBrackets(content: string, targetPath: string): string {
  const escaped = targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  content = content.replace(new RegExp(`\\[\\[${escaped}\\|([^\\]]+)\\]\\]`, "gi"), "$1");
  content = content.replace(new RegExp(`\\[\\[${escaped}(#[^\\]]+)?\\]\\]`, "gi"), `${targetPath}$1`);
  return content;
}
