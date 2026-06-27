/**
 * Synthetic scale fixture harness (vault#325 Part 3).
 *
 * Seeds a synthetic vault at one or more sizes (10k / 50k / 100k notes by
 * default) with a realistic distribution of tags, links, attachments, and
 * indexed metadata, then times the hot query / index / export paths so we
 * have a documented sense of where the single-owner vault stops being fast
 * (the load-bearing case: a large Obsidian import landing on one person's
 * machine).
 *
 * This is NOT part of the `bun test` gate — it's a standalone script so the
 * default gate stays fast. Run it explicitly:
 *
 *   bun scripts/scale-bench.ts              # default sizes: 10000 50000 100000
 *   bun scripts/scale-bench.ts 10000        # one size
 *   bun scripts/scale-bench.ts 1000 5000    # custom sizes (quick smoke)
 *
 * The opt-in `bun:test` smoke (`src/scale.bench.test.ts`) runs a tiny size
 * only when `VAULT_SCALE_BENCH=1` is set, so CI's normal run never pays for
 * it. See `docs/SCALE.md` for the documented ceiling + methodology.
 *
 * Built on an in-memory-then-flushed on-disk `bun:sqlite` DB via the same
 * `BunSqliteStore` the daemon uses, so the timings reflect the real query
 * planner against the real generated columns / indexes — not a mock.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BunSqliteStore } from "../core/src/store.ts";
import { generateMcpTools } from "../core/src/mcp.ts";
import { exportVaultToDir } from "../core/src/portable-md.ts";
import type { BulkNoteInput } from "../core/src/notes.ts";

// ---------------------------------------------------------------------------
// Synthetic corpus shape — chosen to look like a real personal vault:
//   - a handful of top-level tags + a sub-tag namespace (health/food, …)
//   - one indexed metadata field (`status`) so we exercise the generated
//     `meta_status` column / equality-filter path
//   - a sprinkle of [[wikilinks]] and explicit links → real graph density
//   - ~1-in-20 notes carry an attachment row
// ---------------------------------------------------------------------------

const TOP_TAGS = ["health", "work", "personal", "project", "reference", "daily"];
const SUB_TAGS = ["health/food", "work/meeting", "project/parachute", "reference/book"];
const STATUSES = ["active", "done", "blocked", "archived"];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]!;
}

function buildInputs(n: number): BulkNoteInput[] {
  const inputs: BulkNoteInput[] = [];
  for (let i = 0; i < n; i++) {
    const tags: string[] = [pick(TOP_TAGS, i)];
    // ~1-in-3 notes also carry a sub-tag (orphan namespace, no schema).
    if (i % 3 === 0) tags.push(pick(SUB_TAGS, i));
    // ~1-in-4 notes carry a wikilink to a deterministic earlier note so
    // the link table + wikilink resolver get real work at scale.
    const linkSuffix = i > 10 && i % 4 === 0 ? `\n\nSee [[note-${i - 7}]] for context.` : "";
    inputs.push({
      id: `note-${i}`,
      path: `notes/${pick(TOP_TAGS, i)}/note-${i}`,
      content: `# Note ${i}\n\nSynthetic note number ${i} about ${pick(TOP_TAGS, i)}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.${linkSuffix}`,
      tags,
      metadata: { status: pick(STATUSES, i), seq: i },
    });
  }
  return inputs;
}

interface Timing {
  label: string;
  ms: number;
  detail?: string;
}

async function time<T>(label: string, fn: () => Promise<T> | T): Promise<{ result: T; timing: Timing }> {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  return { result, timing: { label, ms } };
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

async function benchSize(n: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `vault-scale-${n}-`));
  const dbPath = join(dir, "scale.db");
  const exportDir = join(dir, "export");
  const db = new Database(dbPath);
  // SQLite knobs the daemon would also want under bulk load. WAL + a larger
  // page cache materially change seed time; we set them so the numbers
  // reflect a realistic configuration, not the conservative defaults.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  const store = new BunSqliteStore(db);

  const timings: Timing[] = [];

  try {
    // Declare `status` indexed so the equality-filter path hits the
    // generated `meta_status` column (the thing #485 tuned). The
    // indexed-field lifecycle is owned by the update-tag MCP tool —
    // `store.upsertTagSchema`/`upsertTagRecord` do NOT populate the
    // `indexed_fields` table (core.test.ts §11). Without this, metadata
    // operator queries + orderBy error loudly.
    const adminTools = generateMcpTools(store);
    const updateTag = adminTools.find((t) => t.name === "update-tag")!;
    await updateTag.execute({
      tag: "work",
      description: "Work notes",
      fields: { status: { type: "string", indexed: true } },
    });

    const inputs = buildInputs(n);
    // Seed in batches so a single transaction doesn't hold the whole corpus
    // in one statement — mirrors how a real import streams.
    const BATCH = 2000;
    const seed = await time("seed (bulk createNotes)", async () => {
      for (let off = 0; off < inputs.length; off += BATCH) {
        await store.createNotes(inputs.slice(off, off + BATCH));
      }
    });
    timings.push({ ...seed.timing, detail: `${n} notes in batches of ${BATCH}` });

    // ~1-in-20 notes get an attachment row.
    const att = await time("seed attachments (~5%)", async () => {
      let c = 0;
      for (let i = 0; i < n; i += 20) {
        await store.addAttachment(`note-${i}`, `assets/note-${i}.png`, "image/png");
        c++;
      }
      return c;
    });
    timings.push({ ...att.timing, detail: `${att.result} attachments` });

    // ---- HOT PATHS ----

    const qTag = await time("query-notes { tag } limit 100", async () =>
      store.queryNotes({ tags: ["health"], limit: 100 }),
    );
    timings.push({ ...qTag.timing, detail: `${qTag.result.length} rows` });

    const qIndexed = await time("query-notes { metadata: status eq } (generated column)", async () =>
      store.queryNotes({ metadata: { status: { eq: "active" } }, limit: 100 }),
    );
    timings.push({ ...qIndexed.timing, detail: `${qIndexed.result.length} rows` });

    const qSort = await time("query-notes orderBy status (indexed sort) limit 100", async () =>
      store.queryNotes({ orderBy: "status", limit: 100 }),
    );
    timings.push({ ...qSort.timing, detail: `${qSort.result.length} rows` });

    const qSearch = await time("searchNotes(\"consectetur\") limit 100", async () =>
      store.searchNotes("consectetur", { limit: 100 }),
    );
    timings.push({ ...qSearch.timing, detail: `${qSearch.result.length} rows` });

    // Single-note fetch by id — the per-request hot path for any UI render.
    const qOne = await time("queryNotes { id } single fetch", async () =>
      store.queryNotes({ ids: [`note-${Math.floor(n / 2)}`], limit: 1 }),
    );
    timings.push({ ...qOne.timing, detail: `${qOne.result.length} row` });

    // Graph neighborhood — exercises link hydration (the #485 N+1 concern).
    const qNear = await time("queryNotes { ids:[…100] } batch (link hydration)", async () => {
      const ids = Array.from({ length: 100 }, (_, k) => `note-${k * Math.max(1, Math.floor(n / 100))}`);
      return store.queryNotes({ ids, limit: 100 });
    });
    timings.push({ ...qNear.timing, detail: `${qNear.result.length} rows hydrated` });

    // ---- EXPORT (the `limit: 1_000_000` bulk-load in portable-md.ts) ----
    const exp = await time("exportVaultToDir (full bulk-load)", async () =>
      exportVaultToDir(store, { outDir: exportDir, vaultName: "scale", exportedAt: "2026-01-01T00:00:00Z" }),
    );
    timings.push({ ...exp.timing, detail: `${exp.result.notes} notes written` });

    // Checkpoint the WAL into the main DB file so the on-disk size reflects
    // the full corpus (in WAL mode the -wal sidecar holds uncheckpointed
    // pages and the main file reads tiny otherwise).
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const dbBytes = statSync(dbPath).size;

    // ---- REPORT ----
    console.log(`\n==== ${n.toLocaleString()} notes ====`);
    console.log(`db size on disk: ${(dbBytes / 1024 / 1024).toFixed(1)} MB`);
    for (const t of timings) {
      const detail = t.detail ? `  (${t.detail})` : "";
      console.log(`  ${t.label.padEnd(52)} ${fmt(t.ms).padStart(9)}${detail}`);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).map((s) => parseInt(s, 10)).filter((x) => Number.isFinite(x) && x > 0);
  const sizes = argv.length > 0 ? argv : [10_000, 50_000, 100_000];
  console.log(`Parachute Vault scale benchmark — sizes: ${sizes.map((s) => s.toLocaleString()).join(", ")}`);
  console.log("(see docs/SCALE.md for methodology + the documented ceiling)");
  for (const n of sizes) {
    await benchSize(n);
  }
  console.log("\ndone.");
}

await main();
