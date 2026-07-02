/**
 * Shared deterministic vault builder + export-tree serializer for the
 * portable-md "old bytes == new bytes" golden fixture (Phase-1 streaming
 * export refactor).
 *
 * Both the one-shot capture script (scripts/capture-portable-golden.ts,
 * run against the PRE-refactor code) and the regression test
 * (portable-md-golden.test.ts, run against the POST-refactor code) build
 * the SAME vault here and serialize the export tree the SAME way — so a
 * byte diff between the committed golden JSON and a fresh export is a real
 * drift, not a fixture-vs-test mismatch.
 *
 * Determinism requirements met here:
 *   - explicit note ids + pinned created_at/updated_at (no wall-clock)
 *   - export called with `exportedAt` + `caseSensitiveOverride: true`
 *     (so the bytes don't depend on the runner's filesystem)
 *   - content that exercises every format field: pathed / unpathed /
 *     empty-content notes, a non-md (csv) note that forces a notes-meta
 *     sidecar, tags with schema + relationships, typed links, multi-line
 *     + control-character metadata, and created_at != updated_at.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { Store } from "../types.js";

/** Fixed export timestamp — pins vault.yaml's `exported_at`. */
export const GOLDEN_EXPORTED_AT = "2026-07-02T00:00:00.000Z";

/**
 * Populate `store` with a deterministic, format-exhaustive vault. Callers
 * export it with `{ exportedAt: GOLDEN_EXPORTED_AT, caseSensitiveOverride: true }`.
 */
export async function buildGoldenVault(store: Store): Promise<void> {
  // Tag schema + opaque relationship vocabulary (vault#428 shape).
  await store.upsertTagSchema("project", {
    description: "A long-running effort",
    fields: { status: { type: "string", enum: ["active", "done"], indexed: true } },
  });
  await store.upsertTagRecord("project", {
    relationships: {
      "works-on": { from: "person", to: "project" },
      "based-at": { from: "project", to: "place", note: "freeform" },
    },
  });

  const t0 = "2026-01-01T00:00:00.000Z";
  const t1 = "2026-01-01T00:01:00.000Z";

  await store.createNote("alpha body", {
    id: "01HX001",
    path: "Inbox/alpha",
    tags: ["project", "z-other"],
    metadata: {
      priority: "high",
      notes: "line1\nline2\nline3",
      // control character exercises the \xNN escape path (vault#317 F1)
      ctrl: "a\tb",
      status: "active",
    },
    created_at: t0,
  });
  await store.createNote("beta body", {
    id: "01HX002",
    path: "Inbox/beta",
    tags: ["project"],
    metadata: { status: "done" },
    created_at: t0,
  });
  await store.createNote("unpathed jot", { id: "01HX003", created_at: t0 });
  // Empty-content skeleton note (vault#323).
  await store.createNote("", {
    id: "01HX004",
    path: "Inbox/skeleton",
    tags: ["project"],
    created_at: t0,
  });
  // Non-md note → forces a .parachute/notes-meta/<id>.yaml sidecar.
  await store.createNote("col1,col2\n1,2\n", {
    id: "01HX005",
    path: "Data/table",
    extension: "csv",
    tags: ["z-other"],
    metadata: { rows: 2 },
    created_at: t0,
  });

  await store.createLink("01HX001", "01HX002", "derived-from", { source: "git://example" });

  // Pin every timestamp so the export bytes are wall-clock-independent.
  // n1 gets a divergent updated_at to exercise restoreNoteTimestamps.
  await store.restoreNoteTimestamps("01HX001", t0, t1);
  for (const id of ["01HX002", "01HX003", "01HX004", "01HX005"]) {
    await store.restoreNoteTimestamps(id, t0, t0);
  }
}

/**
 * Recursively serialize an export directory into a sorted map of
 * `<relative-posix-path>` → file content. Directories are recorded as
 * entries with a trailing `/` and an empty value so an intentionally
 * empty dir (e.g. `.parachute/schemas/` on a schema-less vault) still
 * shows up in the byte comparison.
 */
export function serializeExportTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string): void => {
    const entries = readdirSync(abs).sort();
    if (entries.length === 0 && rel !== "") {
      out[rel + "/"] = "";
      return;
    }
    for (const entry of entries) {
      const childAbs = join(abs, entry);
      const childRel = rel === "" ? entry : `${rel}/${entry}`;
      if (statSync(childAbs).isDirectory()) {
        walk(childAbs, childRel);
      } else {
        out[childRel] = readFileSync(childAbs, "utf-8");
      }
    }
  };
  walk(dir, "");
  return out;
}
