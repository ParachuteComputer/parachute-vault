/**
 * One-shot: capture the portable-md export "golden bytes" fixture.
 *
 * Run this against the PRE-refactor exporter to freeze exactly what the
 * fs exporter produces today; the streaming-export refactor must then
 * reproduce these bytes exactly (see portable-md-golden.test.ts). Safe to
 * re-run to regenerate after an INTENTIONAL, reviewed format change.
 *
 *   bun run scripts/capture-portable-golden.ts
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SqliteStore } from "../core/src/store.ts";
import { exportVaultToDir } from "../core/src/portable-md.ts";
import {
  buildGoldenVault,
  serializeExportTree,
  GOLDEN_EXPORTED_AT,
} from "../core/src/__fixtures__/golden-vault.ts";

const GOLDEN_PATH = join(import.meta.dir, "../core/src/__fixtures__/portable-export-golden.json");

const store = new SqliteStore(new Database(":memory:"));
await buildGoldenVault(store);

const outDir = mkdtempSync(join(tmpdir(), "portable-golden-"));
try {
  await exportVaultToDir(store, {
    outDir,
    vaultName: "golden",
    vaultDescription: "portable-md byte-stability fixture",
    exportedAt: GOLDEN_EXPORTED_AT,
    caseSensitiveOverride: true,
  });
  const tree = serializeExportTree(outDir);
  writeFileSync(GOLDEN_PATH, JSON.stringify(tree, null, 2) + "\n");
  console.log(`[golden] wrote ${Object.keys(tree).length} entries → ${GOLDEN_PATH}`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
