/**
 * Golden-bytes regression for the portable-md streaming export refactor
 * (Phase-1 shared-core, vault cloud design §4).
 *
 * `core/src/__fixtures__/portable-export-golden.json` was captured from the
 * PRE-refactor (full-corpus, sync-fs) exporter by
 * `scripts/capture-portable-golden.ts`. This test builds the SAME
 * deterministic vault and asserts the CURRENT exporter reproduces those
 * bytes exactly — the streaming/source-sink rewrite must be byte-for-byte
 * indistinguishable on the fs backend. A diff here is a real format drift,
 * not test flake (both sides share `buildGoldenVault` + `serializeExportTree`
 * from the fixture module, so a fixture-vs-test mismatch is impossible).
 *
 * If a format change is ever intentional, re-run the capture script against
 * the new code, review the JSON diff, and commit both together.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SqliteStore } from "./store.js";
import { exportVaultToDir } from "./portable-md.js";
import {
  buildGoldenVault,
  serializeExportTree,
  GOLDEN_EXPORTED_AT,
} from "./__fixtures__/golden-vault.js";
import goldenTree from "./__fixtures__/portable-export-golden.json";

describe("portable-md golden bytes — new exporter == old-exporter fixture", () => {
  it("reproduces the captured export tree byte-for-byte", async () => {
    const store = new SqliteStore(new Database(":memory:"));
    await buildGoldenVault(store);

    const outDir = mkdtempSync(join(tmpdir(), "portable-golden-test-"));
    try {
      await exportVaultToDir(store, {
        outDir,
        vaultName: "golden",
        vaultDescription: "portable-md byte-stability fixture",
        exportedAt: GOLDEN_EXPORTED_AT,
        caseSensitiveOverride: true,
      });
      const tree = serializeExportTree(outDir);
      // Compare as objects (per-file byte equality) — a keyed diff points
      // straight at the drifting file if this ever fails.
      expect(tree).toEqual(goldenTree as Record<string, string>);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
