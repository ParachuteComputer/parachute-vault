/**
 * Opt-in scale smoke (vault#325 Part 3).
 *
 * Guards the synthetic scale harness against bit-rot WITHOUT slowing the
 * default `bun test` gate. The real benchmark lives in
 * `scripts/scale-bench.ts` (10k / 50k / 100k); this is a fast, tiny-size
 * functional smoke of the same hot-path code so a green CI run still
 * proves the harness paths execute end-to-end.
 *
 * SKIPPED BY DEFAULT. To run it:
 *
 *   VAULT_SCALE_BENCH=1 bun test ./src/scale.bench.test.ts
 *
 * For real timings + the documented ceiling, run the standalone harness:
 *
 *   bun scripts/scale-bench.ts          # 10000 50000 100000
 *
 * See docs/SCALE.md.
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "../core/src/store.ts";
import { generateMcpTools } from "../core/src/mcp.ts";
import { exportVaultToDir } from "../core/src/portable-md.ts";
import type { BulkNoteInput } from "../core/src/notes.ts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ENABLED = process.env.VAULT_SCALE_BENCH === "1";

// `describe.skipIf` keeps the suite registered (so it shows in the test list)
// but contributes zero runtime to the default gate. Size is intentionally
// tiny — this is a functional smoke, not a timing run.
describe.skipIf(!ENABLED)("scale harness smoke (opt-in: VAULT_SCALE_BENCH=1)", () => {
  test("seed + hot-path queries + export run at small N", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-scale-smoke-"));
    const db = new Database(join(dir, "smoke.db"));
    const store = new BunSqliteStore(db);
    try {
      const N = 500;

      // Declare the indexed field via the update-tag tool (the owner of the
      // indexed_fields lifecycle — mirrors scripts/scale-bench.ts).
      const tools = generateMcpTools(store);
      const updateTag = tools.find((t) => t.name === "update-tag");
      expect(updateTag).toBeDefined();
      await updateTag!.execute({
        tag: "work",
        fields: { status: { type: "string", indexed: true } },
      });

      const inputs: BulkNoteInput[] = Array.from({ length: N }, (_, i) => ({
        id: `note-${i}`,
        path: `notes/note-${i}`,
        content: `# Note ${i}\n\nconsectetur body ${i}`,
        tags: i % 3 === 0 ? ["work", "work/meeting"] : ["health"],
        metadata: { status: i % 2 === 0 ? "active" : "done", seq: i },
      }));
      await store.createNotes(inputs);

      // Hot paths — same shapes the standalone harness times.
      expect((await store.queryNotes({ tags: ["health"], limit: 50 })).length).toBeGreaterThan(0);
      expect(
        (await store.queryNotes({ metadata: { status: { eq: "active" } }, limit: 50 })).length,
      ).toBeGreaterThan(0);
      expect((await store.queryNotes({ orderBy: "status", limit: 50 })).length).toBe(50);
      expect((await store.searchNotes("consectetur", { limit: 50 })).length).toBeGreaterThan(0);

      const stats = await exportVaultToDir(store, {
        outDir: join(dir, "export"),
        vaultName: "smoke",
        exportedAt: "2026-01-01T00:00:00Z",
      });
      expect(stats.notes).toBe(N);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
