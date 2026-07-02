/**
 * Batched-export coverage (Phase-1 streaming refactor). The export walk
 * streams notes in windows of `EXPORT_BATCH_SIZE` (500) instead of one
 * full-corpus query. These tests prove the windowing walks EVERY note across
 * the batch boundaries — both a non-multiple remainder (1,203 = 500 + 500 +
 * 203, so the final partial batch is exercised) and an exact multiple (1,000
 * = 500 + 500 + a terminating empty query), with a sentinel note pinned in
 * the final batch so an off-by-one that dropped the tail would fail loudly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SqliteStore } from "./store.js";
import { exportVaultToDir } from "./portable-md.js";

/** Zero-padded so lexicographic id order == numeric order (the export walks
 *  `created_at ASC, id ASC`; fresh notes share a created_at so id breaks the
 *  tie — this makes the batch membership of each note deterministic). */
const pad = (i: number): string => String(i).padStart(5, "0");

async function seed(store: SqliteStore, n: number): Promise<void> {
  const inputs = [];
  for (let i = 0; i < n; i++) {
    inputs.push({ content: `note ${i}`, id: `n${pad(i)}`, path: `notes/n${pad(i)}` });
  }
  await store.createNotes(inputs);
}

describe("exportVaultToDir — batched walk across boundaries", () => {
  let store: SqliteStore;
  let outDir: string;

  beforeEach(() => {
    store = new SqliteStore(new Database(":memory:"));
    outDir = mkdtempSync(join(tmpdir(), "portable-batch-"));
  });
  afterEach(() => {
    try { rmSync(outDir, { recursive: true, force: true }); } catch {}
  });

  it("walks all 1,203 notes (2 full batches + a 203-note remainder)", async () => {
    await seed(store, 1203);
    const stats = await exportVaultToDir(store, { outDir, exportedAt: "2026-07-02T00:00:00.000Z" });

    expect(stats.notes).toBe(1203);
    // First note, both interior batch boundaries, and the sentinel in the
    // final partial batch must all be on disk.
    expect(existsSync(join(outDir, "notes/n00000.md"))).toBe(true); // batch 1 head
    expect(existsSync(join(outDir, "notes/n00500.md"))).toBe(true); // batch 2 head
    expect(existsSync(join(outDir, "notes/n01000.md"))).toBe(true); // batch 3 head
    expect(existsSync(join(outDir, "notes/n01202.md"))).toBe(true); // last partial-batch sentinel
  });

  it("walks all notes on an exact multiple of the batch size (1,000 = 2×500 + terminating empty query)", async () => {
    await seed(store, 1000);
    const stats = await exportVaultToDir(store, { outDir, exportedAt: "2026-07-02T00:00:00.000Z" });

    expect(stats.notes).toBe(1000);
    expect(existsSync(join(outDir, "notes/n00000.md"))).toBe(true);
    expect(existsSync(join(outDir, "notes/n00500.md"))).toBe(true);
    expect(existsSync(join(outDir, "notes/n00999.md"))).toBe(true); // last note of the final full batch
  });
});
