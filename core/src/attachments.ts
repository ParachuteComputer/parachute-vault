/**
 * Attachment DB ops — shared by `BunSqliteStore` and `DoSqliteStore`.
 * Runs against the `SqlDb` abstraction so it's portable across runtimes.
 * The `path` column is a `BlobStore` key, not a filesystem path.
 */

import type { SqlDb } from "./sql-db.js";
import type { Attachment } from "./types.js";
import { generateId } from "./notes.js";

interface AttachmentRow {
  id: string;
  note_id: string;
  path: string;
  mime_type: string;
  metadata: string | null;
  created_at: string;
}

export function addAttachment(
  db: SqlDb,
  noteId: string,
  path: string,
  mimeType: string,
  metadata?: Record<string, unknown>,
): Attachment {
  const id = generateId();
  const now = new Date().toISOString();
  const metadataJson = metadata ? JSON.stringify(metadata) : "{}";
  db.prepare(
    "INSERT INTO attachments (id, note_id, path, mime_type, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, noteId, path, mimeType, metadataJson, now);

  return { id, noteId, path, mimeType, metadata, createdAt: now };
}

export function getAttachments(db: SqlDb, noteId: string): Attachment[] {
  const rows = db.prepare(
    "SELECT * FROM attachments WHERE note_id = ? ORDER BY created_at",
  ).all<AttachmentRow>(noteId);

  return rows.map((r) => {
    let metadata: Record<string, unknown> | undefined;
    if (r.metadata && r.metadata !== "{}") {
      try { metadata = JSON.parse(r.metadata); } catch {}
    }
    return {
      id: r.id,
      noteId: r.note_id,
      path: r.path,
      mimeType: r.mime_type,
      metadata,
      createdAt: r.created_at,
    };
  });
}
