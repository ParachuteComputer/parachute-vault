/**
 * Tests for scripts/migrate-audio-to-opus.ts.
 *
 * Spins up a temp vault layout under a fresh PARACHUTE_HOME, seeds a WAV
 * attachment, runs the script in dry-run then real mode, asserts the DB
 * row was rewritten, the .ogg file exists, and the original was unlinked.
 *
 * Uses the real ffmpeg binary (matches src/audio-encoding.test.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SCHEMA_SQL } from "../core/src/schema.ts";
import { runMigration } from "./migrate-audio-to-opus.ts";

function buildSilentWav(samples: number): Buffer {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples * blockAlign;
  const chunkSize = 36 + dataSize;
  const buf = Buffer.alloc(44 + dataSize);
  let off = 0;
  buf.write("RIFF", off); off += 4;
  buf.writeUInt32LE(chunkSize, off); off += 4;
  buf.write("WAVE", off); off += 4;
  buf.write("fmt ", off); off += 4;
  buf.writeUInt32LE(16, off); off += 4;
  buf.writeUInt16LE(1, off); off += 2;
  buf.writeUInt16LE(numChannels, off); off += 2;
  buf.writeUInt32LE(sampleRate, off); off += 4;
  buf.writeUInt32LE(byteRate, off); off += 4;
  buf.writeUInt16LE(blockAlign, off); off += 2;
  buf.writeUInt16LE(bitsPerSample, off); off += 2;
  buf.write("data", off); off += 4;
  buf.writeUInt32LE(dataSize, off); off += 4;
  return buf;
}

let tmpHome: string;
let prevHome: string | undefined;
let prevAssets: string | undefined;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  prevAssets = process.env.ASSETS_DIR;
  process.env.PARACHUTE_HOME = tmpHome;
  delete process.env.ASSETS_DIR; // use default per-vault assets dir
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (prevAssets === undefined) delete process.env.ASSETS_DIR;
  else process.env.ASSETS_DIR = prevAssets;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

interface SeedResult {
  vault: string;
  dbPath: string;
  assetsBase: string;
  noteId: string;
  attachmentId: string;
  relWavPath: string;
  absWavPath: string;
  relOggPath: string;
  absOggPath: string;
  noteUpdatedAt: string;
}

function seedVaultWithWav(vaultName: string): SeedResult {
  const vaultDir = join(tmpHome, "vaults", vaultName);
  mkdirSync(vaultDir, { recursive: true });
  const dbPath = join(vaultDir, "vault.db");
  const assetsBase = join(vaultDir, "assets");
  mkdirSync(assetsBase, { recursive: true });

  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);

  const noteId = "n_" + Math.random().toString(36).slice(2, 10);
  const attachmentId = "a_" + Math.random().toString(36).slice(2, 10);
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO notes (id, content, path, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(noteId, "hello reader", null, "{}", now, now);

  const relWavPath = `tts/2026-04-08/${noteId}-123.wav`;
  const absWavPath = join(assetsBase, relWavPath);
  mkdirSync(join(assetsBase, "tts", "2026-04-08"), { recursive: true });
  // Write ~1s of silence WAV. ffmpeg handles this fine.
  writeFileSync(absWavPath, buildSilentWav(8000));

  db.prepare(
    "INSERT INTO attachments (id, note_id, path, mime_type, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(attachmentId, noteId, relWavPath, "audio/wav", "{}", now);

  db.close();

  return {
    vault: vaultName,
    dbPath,
    assetsBase,
    noteId,
    attachmentId,
    relWavPath,
    absWavPath,
    relOggPath: relWavPath.replace(/\.wav$/, ".ogg"),
    absOggPath: absWavPath.replace(/\.wav$/, ".ogg"),
    noteUpdatedAt: now,
  };
}

describe("migrate-audio-to-opus", () => {
  test("dry-run reports candidates without touching anything", async () => {
    const seed = seedVaultWithWav("default");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const summaries = await runMigration(["--vault", "default", "--dry-run"]);
      expect(summaries.length).toBe(1);
      expect(summaries[0].dryRunCandidates).toBe(1);
      expect(summaries[0].converted).toBe(0);
      expect(summaries[0].errors).toBe(0);
    } finally {
      console.log = origLog;
    }

    expect(logs.some((l) => l.includes("DRY-RUN convert") && l.includes(seed.relWavPath))).toBe(
      true,
    );

    // Nothing moved.
    expect(existsSync(seed.absWavPath)).toBe(true);
    expect(existsSync(seed.absOggPath)).toBe(false);

    const db = new Database(seed.dbPath);
    try {
      const row = db
        .prepare("SELECT path, mime_type FROM attachments WHERE id = ?")
        .get(seed.attachmentId) as { path: string; mime_type: string };
      expect(row.path).toBe(seed.relWavPath);
      expect(row.mime_type).toBe("audio/wav");
    } finally {
      db.close();
    }
  });

  test("full run converts WAV to Opus, updates DB, unlinks original, no updated_at bump", async () => {
    const seed = seedVaultWithWav("default");

    const origLog = console.log;
    console.log = () => {};
    try {
      const summaries = await runMigration(["--vault", "default"]);
      expect(summaries[0].converted).toBe(1);
      expect(summaries[0].errors).toBe(0);
      expect(summaries[0].bytesAfter).toBeGreaterThan(0);
    } finally {
      console.log = origLog;
    }

    // Original .wav removed, .ogg exists and has OggS magic bytes.
    expect(existsSync(seed.absWavPath)).toBe(false);
    expect(existsSync(seed.absOggPath)).toBe(true);
    const oggBytes = readFileSync(seed.absOggPath);
    expect(oggBytes.toString("ascii", 0, 4)).toBe("OggS");

    // DB row rewritten.
    const db = new Database(seed.dbPath);
    try {
      const row = db
        .prepare("SELECT path, mime_type FROM attachments WHERE id = ?")
        .get(seed.attachmentId) as { path: string; mime_type: string };
      expect(row.path).toBe(seed.relOggPath);
      expect(row.mime_type).toBe("audio/ogg");

      // Note's updated_at must NOT have changed — this is a storage
      // migration, not a content edit.
      const note = db
        .prepare("SELECT updated_at FROM notes WHERE id = ?")
        .get(seed.noteId) as { updated_at: string };
      expect(note.updated_at).toBe(seed.noteUpdatedAt);
    } finally {
      db.close();
    }
  });

  test("re-running after a successful migration is a no-op (idempotent)", async () => {
    seedVaultWithWav("default");

    const origLog = console.log;
    console.log = () => {};
    try {
      await runMigration(["--vault", "default"]);
      const second = await runMigration(["--vault", "default"]);
      expect(second[0].converted).toBe(0);
      expect(second[0].skipped).toBe(1);
      expect(second[0].errors).toBe(0);
    } finally {
      console.log = origLog;
    }
  });
});
