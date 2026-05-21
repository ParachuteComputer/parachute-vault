/**
 * Tests for vault transcript-note materialization (vault#353).
 *
 * Covers two surfaces:
 *   - `buildTranscriptNote` — pure, frontmatter shape per design Q3.
 *   - `upsertTranscriptNote` — DB-backed, create + retry-update flow.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BunStore } from "./vault-store.ts";
import { buildTranscriptNote, transcriptPathFor, upsertTranscriptNote } from "./transcript-note.ts";

let db: Database;
let store: BunStore;
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `transcript-note-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  db = new Database(join(tmpDir, "test.db"));
  store = new BunStore(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("transcriptPathFor", () => {
  test("appends `.transcript` to the audio path", () => {
    expect(transcriptPathFor("inbox/2026-05-21.m4a")).toBe("inbox/2026-05-21.m4a.transcript");
  });

  test("handles nested paths", () => {
    expect(transcriptPathFor("a/b/c/voice.webm")).toBe("a/b/c/voice.webm.transcript");
  });
});

describe("buildTranscriptNote — success shape", () => {
  test("frontmatter includes transcript_of, status, attachment id, duration, and provider", () => {
    const result = buildTranscriptNote({
      attachmentPath: "inbox/voice.webm",
      attachmentId: "att-1",
      attachmentNoteId: "note-1",
      status: "complete",
      text: "hello world",
      provider: "groq",
      durationMs: 1234,
      createdAt: new Date("2026-05-21T09:13:42Z"),
    });
    expect(result.path).toBe("inbox/voice.webm.transcript");
    expect(result.content).toBe("hello world");
    expect(result.tags).toEqual(["transcript", "capture"]);
    expect(result.metadata.transcript_of).toBe("inbox/voice.webm");
    expect(result.metadata.transcript_attachment_id).toBe("att-1");
    expect(result.metadata.transcript_status).toBe("complete");
    expect(result.metadata.transcript_provider).toBe("groq");
    expect(result.metadata.transcript_duration_ms).toBe(1234);
    expect(result.metadata.title).toBe("Transcript of voice.webm");
    expect(result.createdAt).toBe("2026-05-21T09:13:42.000Z");
    expect(result.metadata.transcript_error).toBeUndefined();
  });

  test("provider/duration omitted when not supplied", () => {
    const result = buildTranscriptNote({
      attachmentPath: "voice.m4a",
      attachmentId: "att-x",
      attachmentNoteId: "note-x",
      status: "complete",
      text: "no provider info",
    });
    expect(result.metadata.transcript_provider).toBeUndefined();
    expect(result.metadata.transcript_duration_ms).toBeUndefined();
  });
});

describe("buildTranscriptNote — failure shape", () => {
  test("body is empty + transcript_error captured", () => {
    const result = buildTranscriptNote({
      attachmentPath: "inbox/voice.webm",
      attachmentId: "att-1",
      attachmentNoteId: "note-1",
      status: "failed",
      error: "no transcription provider configured",
    });
    expect(result.content).toBe("");
    expect(result.metadata.transcript_status).toBe("failed");
    expect(result.metadata.transcript_error).toBe("no transcription provider configured");
  });

  test("falls back to 'unknown error' when no error string is supplied", () => {
    const result = buildTranscriptNote({
      attachmentPath: "voice.m4a",
      attachmentId: "att-1",
      attachmentNoteId: "note-1",
      status: "failed",
    });
    expect(result.metadata.transcript_error).toBe("unknown error");
  });
});

describe("upsertTranscriptNote", () => {
  test("creates a new note + link on first call", async () => {
    const audioOwner = await store.createNote("# Voice memo\n", { id: "owner" });
    await store.addAttachment(audioOwner.id, "memos/a.webm", "audio/webm");

    const note = await upsertTranscriptNote(store, {
      attachmentPath: "memos/a.webm",
      attachmentId: "att-1",
      attachmentNoteId: audioOwner.id,
      status: "complete",
      text: "spoken words",
      provider: "groq",
      durationMs: 999,
    });
    expect(note.content).toBe("spoken words");
    expect(note.path).toBe("memos/a.webm.transcript");

    const fetched = await store.getNoteByPath("memos/a.webm.transcript");
    expect(fetched?.id).toBe(note.id);
    expect((fetched?.metadata as any)?.transcript_status).toBe("complete");
    expect(fetched?.tags).toContain("transcript");
    expect(fetched?.tags).toContain("capture");
  });

  test("overwrites existing transcript note in place on retry (id preserved)", async () => {
    const owner = await store.createNote("# Voice memo\n", { id: "owner-2" });
    await store.addAttachment(owner.id, "memos/b.webm", "audio/webm");

    const first = await upsertTranscriptNote(store, {
      attachmentPath: "memos/b.webm",
      attachmentId: "att-2",
      attachmentNoteId: owner.id,
      status: "failed",
      error: "no transcription provider configured",
    });
    expect(first.content).toBe("");

    const retried = await upsertTranscriptNote(store, {
      attachmentPath: "memos/b.webm",
      attachmentId: "att-2",
      attachmentNoteId: owner.id,
      status: "complete",
      text: "transcript that finally landed",
      durationMs: 500,
    });
    expect(retried.id).toBe(first.id);
    expect(retried.content).toBe("transcript that finally landed");
    expect((retried.metadata as any)?.transcript_status).toBe("complete");
    expect((retried.metadata as any)?.transcript_error).toBeUndefined();
  });

  test("attempting to upsert when the attachmentNoteId is missing still creates the note (link skipped)", async () => {
    // No owner note created — the link create will throw or silently skip;
    // either way the transcript note must still land so the failure has
    // a visible record. (Defensive: a deleted-attachment race.)
    const note = await upsertTranscriptNote(store, {
      attachmentPath: "missing/a.webm",
      attachmentId: "att-x",
      attachmentNoteId: "nonexistent-note",
      status: "failed",
      error: "audio file not found",
    });
    expect(note.path).toBe("missing/a.webm.transcript");
    expect((note.metadata as any)?.transcript_status).toBe("failed");
  });
});
