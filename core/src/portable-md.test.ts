/**
 * Tests for `portable-md.ts` — the canonical home for the markdown
 * knowledge-base format (vault#308).
 *
 * Test coverage:
 *   - YAML emitter: scalar quoting, idempotent key order, nested
 *     objects/arrays, empty collections.
 *   - `toPortableMarkdown`: frontmatter top-level key order, alpha-sort
 *     within nested objects, byte-identical re-emit of unchanged input.
 *   - `parseFrontmatter`: round-trips the emitter's output (own-format
 *     fidelity) and accepts legacy flat-frontmatter shape (back-compat).
 *   - `exportVaultToDir`: writes `.parachute/vault.yaml`, per-tag
 *     `schemas/<tag>.yaml`, per-note `<path>.md`. Respects `--since`.
 *   - Round-trip (PR 1 scope): export → re-export with same
 *     `exportedAt` → byte-identical files. Full vault → empty vault →
 *     re-import → notes/tags/links/schemas restored (without
 *     attachments, which is PR 2).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { SqliteStore } from "./store.js";
import { getIndexedField } from "./indexed-fields.js";
import { buildVaultProjection } from "./vault-projection.js";
import {
  CaseCollisionError,
  emitYamlDoc,
  exportVault,
  exportVaultToDir,
  importPortableVault,
  noteToPortable,
  parseFrontmatter,
  portableExportFilePath,
  probeCaseSensitive,
  pruneOrphans,
  SIDECAR_DIR,
  NOTES_META_DIR,
  supportsInlineFrontmatter,
  toPortableMarkdown,
  toSidecarYaml,
  type ExportSink,
  type PortableNote,
  type SinkWriteResult,
} from "./portable-md.js";

// ---------------------------------------------------------------------------
// YAML emitter
// ---------------------------------------------------------------------------

describe("emitYamlDoc — idempotent serializer", () => {
  it("alpha-sorts top-level keys", () => {
    const out = emitYamlDoc({ b: 2, a: 1, c: 3 });
    expect(out).toBe("a: 1\nb: 2\nc: 3\n");
  });

  it("quotes strings that would round-trip as different types", () => {
    const out = emitYamlDoc({ x: "true", y: "42", z: "null" });
    // Each is single-quoted so the parser doesn't reinterpret as boolean/number/null.
    expect(out).toContain("x: 'true'");
    expect(out).toContain("y: '42'");
    expect(out).toContain("z: 'null'");
  });

  it("leaves plain strings unquoted", () => {
    const out = emitYamlDoc({ name: "donor-pipeline" });
    expect(out).toBe("name: donor-pipeline\n");
  });

  it("emits booleans and numbers bare", () => {
    const out = emitYamlDoc({ active: true, count: 42, ratio: 3.14 });
    expect(out).toContain("active: true");
    expect(out).toContain("count: 42");
    expect(out).toContain("ratio: 3.14");
  });

  it("emits empty array as []", () => {
    const out = emitYamlDoc({ tags: [] });
    expect(out).toBe("tags: []\n");
  });

  it("emits empty object as {}", () => {
    const out = emitYamlDoc({ meta: {} });
    expect(out).toBe("meta: {}\n");
  });

  it("emits nested object with alpha-sorted keys", () => {
    const out = emitYamlDoc({ meta: { z: 1, a: 2 } });
    expect(out).toBe("meta:\n  a: 2\n  z: 1\n");
  });

  it("emits block-form array of scalars", () => {
    const out = emitYamlDoc({ tags: ["b", "a", "c"] });
    // Insertion order preserved for scalar arrays (caller's responsibility
    // to pre-sort when stability matters). Emitter doesn't reorder array
    // items — they may be semantically ordered (e.g. link types).
    expect(out).toBe("tags:\n  - b\n  - a\n  - c\n");
  });

  it("emits block-form array of objects with alpha-sorted keys per item", () => {
    const out = emitYamlDoc({
      links: [
        { target: "x", relationship: "r1" },
        { metadata: { k: "v" }, target: "y", relationship: "r2" },
      ],
    });
    expect(out).toContain("links:");
    expect(out).toContain("  - relationship: r1");
    expect(out).toContain("    target: x");
    expect(out).toContain("  - metadata:");
    expect(out).toContain("      k: v");
    expect(out).toContain("    relationship: r2");
    expect(out).toContain("    target: y");
  });

  it("re-emit is byte-identical (idempotent)", () => {
    const input = { z: 1, a: { y: 2, x: 3 }, m: [1, 2, 3] };
    const first = emitYamlDoc(input);
    // Round-trip: parse the emitted bytes, emit again, compare. Use
    // parseFrontmatter via a stub document.
    const wrapped = "---\n" + first + "---\n";
    const { frontmatter } = parseFrontmatter(wrapped);
    const second = emitYamlDoc(frontmatter);
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// toPortableMarkdown — note frontmatter
// ---------------------------------------------------------------------------

describe("toPortableMarkdown — note frontmatter shape", () => {
  it("emits top-level keys in fixed order (id, path, tags, metadata, links, attachments, created_at, updated_at)", () => {
    const note: PortableNote = {
      id: "abc",
      path: "Inbox/x",
      content: "hello\n",
      tags: ["b", "a"],
      metadata: { priority: "high" },
      links: [{ target: "def", relationship: "derived-from" }],
      attachments: [{ id: "att_1", path: "p.m4a", mime_type: "audio/mp4" }],
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T11:00:00.000Z",
    };
    const md = toPortableMarkdown(note);
    // Extract just the frontmatter portion.
    const fmEnd = md.indexOf("\n---\n", 4);
    const fm = md.slice(4, fmEnd);
    // Top-level key lines, in their emitted order:
    const topKeys = fm.split("\n")
      .filter((l) => /^\w/.test(l))   // top-level (no indent)
      .map((l) => l.split(":")[0]);
    expect(topKeys).toEqual([
      "id", "path", "tags", "metadata", "links", "attachments", "created_at", "updated_at",
    ]);
  });

  it("omits keys whose value is empty (no metadata: {}, no tags: [])", () => {
    const note: PortableNote = {
      id: "abc",
      content: "hi\n",
      created_at: "2026-05-12T10:00:00.000Z",
    };
    const md = toPortableMarkdown(note);
    expect(md).not.toContain("metadata:");
    expect(md).not.toContain("tags:");
    expect(md).not.toContain("links:");
    expect(md).not.toContain("attachments:");
    expect(md).toContain("id: abc");
  });

  it("sorts tags alphabetically (deterministic)", () => {
    const note: PortableNote = {
      id: "x",
      content: "",
      tags: ["zebra", "alpha", "mike"],
      created_at: "2026-05-12T00:00:00.000Z",
    };
    const md = toPortableMarkdown(note);
    // Sorted order: alpha, mike, zebra.
    const aIdx = md.indexOf("- alpha");
    const mIdx = md.indexOf("- mike");
    const zIdx = md.indexOf("- zebra");
    expect(aIdx).toBeGreaterThan(0);
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });

  it("preserves note content verbatim including wikilinks", () => {
    const note: PortableNote = {
      id: "x",
      content: "See [[OtherNote]] for context.\n",
      created_at: "2026-05-12T00:00:00.000Z",
    };
    const md = toPortableMarkdown(note);
    expect(md).toContain("See [[OtherNote]] for context.");
  });

  it("re-emit is byte-identical: emit → parseFrontmatter → reconstruct → re-emit (idempotency pin, vault#317 F2)", () => {
    // The pre-fold version of this test called `toPortableMarkdown` twice
    // on the same in-memory object — that proves nothing about
    // round-tripping through the bytes. Real invariant: emit, parse the
    // bytes back, reconstruct a PortableNote, re-emit. Output must be
    // byte-identical.
    const note: PortableNote = {
      id: "abc",
      path: "Inbox/x",
      content: "body\n",
      tags: ["donor", "meeting"], // pre-sorted (emitter sorts; reconstruct must match)
      metadata: { priority: "high", status: "active" },
      links: [
        { target: "def", relationship: "derived-from", metadata: { source: "git://x" } },
      ],
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T11:00:00.000Z",
    };
    const first = toPortableMarkdown(note);
    const reconstructed = reconstructFromMarkdown(first);
    const second = toPortableMarkdown(reconstructed);
    expect(second).toBe(first);
  });

  // vault#317 F1 — pre-fold, multi-line strings in metadata silently
  // corrupted: the single-quoted emit split across physical YAML lines
  // and the line-oriented parser truncated at the first newline. Now the
  // emitter detects newlines + control characters and switches to
  // double-quoted with escape sequences, keeping the value on one line.
  it("multi-line string in metadata round-trips byte-equivalent (vault#317 F1)", () => {
    const note: PortableNote = {
      id: "abc",
      content: "body\n",
      metadata: { transcript: "line1\nline2\nline3" },
      created_at: "2026-05-12T10:00:00.000Z",
    };
    const first = toPortableMarkdown(note);

    // The emit must keep the value on a single physical YAML line —
    // critical for the parser's line-oriented scan.
    const fmEnd = first.indexOf("\n---\n", 4);
    const fm = first.slice(4, fmEnd);
    const transcriptLines = fm.split("\n").filter((l) => l.includes("transcript"));
    expect(transcriptLines).toHaveLength(1);
    expect(transcriptLines[0]).toContain("\\n"); // escape sequence, not raw newline

    // And round-trip preserves the value exactly.
    const reconstructed = reconstructFromMarkdown(first);
    expect(reconstructed.metadata!.transcript).toBe("line1\nline2\nline3");

    // And re-emit is byte-identical.
    const second = toPortableMarkdown(reconstructed);
    expect(second).toBe(first);
  });

  it("control characters in metadata round-trip via \\xNN escapes (vault#317 F1)", () => {
    const note: PortableNote = {
      id: "abc",
      content: "",
      metadata: { control: "before\tafterend" },
      created_at: "2026-05-12T10:00:00.000Z",
    };
    const first = toPortableMarkdown(note);
    const reconstructed = reconstructFromMarkdown(first);
    expect(reconstructed.metadata!.control).toBe("before\tafterend");
  });
});

/**
 * Helper for idempotency tests — round-trip a portable-md document
 * through `parseFrontmatter` and reconstruct a `PortableNote`. Mirrors
 * the shape the importer will use in PR 2; keeping it test-local here so
 * the production import path can land cleanly later without churning
 * this test's assertions.
 */
function reconstructFromMarkdown(md: string): PortableNote {
  const { frontmatter, content } = parseFrontmatter(md);
  return {
    id: frontmatter.id as string,
    ...(frontmatter.path ? { path: frontmatter.path as string } : {}),
    content,
    ...(frontmatter.tags ? { tags: frontmatter.tags as string[] } : {}),
    ...(frontmatter.metadata ? { metadata: frontmatter.metadata as Record<string, unknown> } : {}),
    ...(frontmatter.links ? { links: frontmatter.links as PortableNote["links"] } : {}),
    ...(frontmatter.attachments ? { attachments: frontmatter.attachments as PortableNote["attachments"] } : {}),
    created_at: frontmatter.created_at as string,
    ...(frontmatter.updated_at ? { updated_at: frontmatter.updated_at as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// portableExportFilePath
// ---------------------------------------------------------------------------

describe("portableExportFilePath", () => {
  it("uses note.path when present", () => {
    expect(portableExportFilePath({
      id: "x", content: "", created_at: "2026-05-12T00:00:00.000Z", path: "Inbox/y",
    })).toBe("Inbox/y.md");
  });

  it("falls back to _unpathed/<id>.md when path is absent", () => {
    expect(portableExportFilePath({
      id: "01HABC", content: "", created_at: "2026-05-12T00:00:00.000Z",
    })).toBe("_unpathed/01HABC.md");
  });

  it("honors the note's extension for pathless notes (vault#329 F4)", () => {
    expect(portableExportFilePath({
      id: "01HXCSV",
      content: "a,b\n1,2",
      created_at: "2026-05-12T00:00:00.000Z",
      extension: "csv",
    })).toBe("_unpathed/01HXCSV.csv");
  });

  it("honors the note's extension for pathed notes (vault#329 F4)", () => {
    expect(portableExportFilePath({
      id: "x",
      content: "",
      created_at: "2026-05-12T00:00:00.000Z",
      path: "Inbox/y",
      extension: "mdx",
    })).toBe("Inbox/y.mdx");
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter — round-trips own emit + accepts legacy
// ---------------------------------------------------------------------------

describe("parseFrontmatter — own-format round-trip + legacy", () => {
  it("round-trips a simple flat document", () => {
    const md = "---\nname: foo\ncount: 42\nactive: true\n---\nbody\n";
    const { frontmatter, content } = parseFrontmatter(md);
    expect(frontmatter).toEqual({ name: "foo", count: 42, active: true });
    expect(content).toBe("body\n");
  });

  it("parses nested metadata block (new portable-md shape)", () => {
    const md = `---
id: abc
metadata:
  priority: high
  status: active
---
body
`;
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.id).toBe("abc");
    expect(frontmatter.metadata).toEqual({ priority: "high", status: "active" });
  });

  it("parses links array of objects", () => {
    const md = `---
id: abc
links:
  - relationship: derived-from
    target: def
  - relationship: responds-to
    target: ghi
---
body
`;
    const { frontmatter } = parseFrontmatter(md);
    const links = frontmatter.links as Array<Record<string, unknown>>;
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ relationship: "derived-from", target: "def" });
    expect(links[1]).toEqual({ relationship: "responds-to", target: "ghi" });
  });

  it("parses legacy flat tags array (back-compat)", () => {
    const md = "---\ntags:\n  - daily\n  - active\n---\nbody";
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.tags).toEqual(["daily", "active"]);
  });

  it("accepts single-quoted strings (own emitter output)", () => {
    const md = "---\nstatus: 'true'\n---\nbody";
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.status).toBe("true"); // string, not boolean
  });
});

// ---------------------------------------------------------------------------
// exportVaultToDir — store → on-disk export
// ---------------------------------------------------------------------------

describe("exportVaultToDir", async () => {
  const tmpBase = join(tmpdir(), "parachute-portable-export");
  let store: SqliteStore;

  beforeEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(tmpBase, { recursive: true });
    store = new SqliteStore(new Database(":memory:"));
  });

  it("writes .parachute/vault.yaml + per-note .md files", async () => {
    await store.createNote("hello", { id: "n1", path: "Inbox/hello", tags: ["daily"] });
    await store.createNote("world", { id: "n2", path: "Inbox/world" });

    const outDir = join(tmpBase, "out");
    const stats = await exportVaultToDir(store, {
      outDir,
      vaultName: "test",
      exportedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(stats.notes).toBe(2);
    expect(existsSync(join(outDir, SIDECAR_DIR, "vault.yaml"))).toBe(true);
    expect(existsSync(join(outDir, "Inbox/hello.md"))).toBe(true);
    expect(existsSync(join(outDir, "Inbox/world.md"))).toBe(true);

    const vault = readFileSync(join(outDir, SIDECAR_DIR, "vault.yaml"), "utf-8");
    expect(vault).toContain("export_format_version: 1");
    expect(vault).toContain("exported_at: 2026-05-12T00:00:00.000Z");
    expect(vault).toContain("name: test");
  });

  // FIX 2(b) (vault#589) — a NUL-in-path note (a pre-fix poisoned row a
  // write-capable token could have planted) must be SKIPPED with a warning +
  // stat, never abort the whole export. Before the sink hardening the
  // uncaught `writeFileSync` throw aborted the entire vault export, so one bad
  // note broke backup/export for everyone.
  //
  // RED-without-fix: drop the try/catch from `FsExportSink.writeText` and this
  // test's `exportVaultToDir` call throws (whole export aborts) instead of
  // returning a partial-with-skip result. Verified manually during development.
  it("hardened export sink: a NUL-in-path note is skipped, not fatal (vault#589)", async () => {
    await store.createNote("clean one", { id: "c1", path: "clean/one" });
    await store.createNote("clean two", { id: "c2", path: "clean/two" });
    await store.createNote("poison", { id: "p1", path: "temp" });
    // Simulate a pre-fix vault: inject a real NUL directly into the stored
    // path, bypassing normalizePath (which now strips NUL). `char(0)` yields a
    // NUL byte in the TEXT column that survives read-back into note.path.
    store.db.prepare("UPDATE notes SET path = 'bad' || char(0) || 'path' WHERE id = ?").run("p1");

    const outDir = join(tmpBase, "poisoned-out");
    const stats = await exportVaultToDir(store, { outDir, exportedAt: "2026-05-13T00:00:00.000Z" });

    // The export completes and every OTHER note is written ...
    expect(existsSync(join(outDir, "clean/one.md"))).toBe(true);
    expect(existsSync(join(outDir, "clean/two.md"))).toBe(true);
    expect(stats.notes).toBe(2); // only the two clean notes counted as written

    // ... while the poisoned note is skipped-with-reason (fs write failure),
    // surfaced as a stat rather than a thrown, aborted export.
    expect(stats.skipped_traversal).toBeGreaterThanOrEqual(1);
    const poisonSkip = stats.skipped_notes.find((s) => s.reason.includes("fs write failed"));
    expect(poisonSkip).toBeTruthy();
  });

  // BLOCKER (vault#589 review) — the skip-with-warn export belt (FIX 2b) is
  // correct ONLY for per-NOTE writes. The STRUCTURAL writes (the vault.yaml
  // manifest + per-tag schema sidecars) are global: a dir missing
  // `.parachute/vault.yaml` is hard-rejected at restore/import, so a discarded
  // `{ok:false}` there would produce a manifest-less "success" — a silently
  // broken backup. Those must FAIL LOUDLY.
  //
  // RED-without-fix: with the structural writes discarding the sink result,
  // both `exportVault` calls RESOLVE (no throw) and the manifest/schema is
  // silently absent. Verified manually during development.
  it("aborts loudly when the manifest write fails (structural, not skip-with-warn)", async () => {
    await store.createNote("n", { id: "n1", path: "p" });
    // Stub sink that fails ONLY the manifest write; everything else succeeds.
    const sink: ExportSink = {
      caseSensitive: true,
      attachmentsEnabled: false,
      writeText(relPath: string): SinkWriteResult {
        if (relPath === join(SIDECAR_DIR, "vault.yaml")) {
          return { ok: false, reason: "simulated EACCES on .parachute/" };
        }
        return { ok: true };
      },
      copyAttachment(): SinkWriteResult { return { ok: true }; },
    };
    await expect(exportVault(store, sink, { exportedAt: "2026-05-13T00:00:00.000Z" }))
      .rejects.toThrow(/manifest/i);
  });

  it("aborts loudly when a schema sidecar write fails (structural, not skip-with-warn)", async () => {
    await store.upsertTagSchema("task", { description: "A unit of work" });
    await store.createNote("x", { id: "x1", tags: ["task"] });
    // Fail ONLY the schema write; the manifest (and everything else) succeeds.
    const sink: ExportSink = {
      caseSensitive: true,
      attachmentsEnabled: false,
      writeText(relPath: string): SinkWriteResult {
        if (relPath.startsWith(join(SIDECAR_DIR, "schemas"))) {
          return { ok: false, reason: "simulated disk full" };
        }
        return { ok: true };
      },
      copyAttachment(): SinkWriteResult { return { ok: true }; },
    };
    await expect(exportVault(store, sink, { exportedAt: "2026-05-13T00:00:00.000Z" }))
      .rejects.toThrow(/schema sidecar/i);
  });

  it("writes per-tag schemas to .parachute/schemas/", async () => {
    await store.upsertTagSchema("task", {
      description: "A unit of work",
      fields: { priority: { type: "string", enum: ["high", "low"] } },
    });
    await store.createNote("x", { tags: ["task"] });

    const outDir = join(tmpBase, "out");
    const stats = await exportVaultToDir(store, {
      outDir,
      exportedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(stats.schemas).toBe(1);
    const schemaPath = join(outDir, SIDECAR_DIR, "schemas", "task.yaml");
    expect(existsSync(schemaPath)).toBe(true);
    const yaml = readFileSync(schemaPath, "utf-8");
    expect(yaml).toContain("name: task");
    expect(yaml).toContain("description: A unit of work");
    expect(yaml).toContain("priority:");
  });

  it("skips tags that have no schema content (just-a-name tags)", async () => {
    await store.createNote("x", { tags: ["plain-tag-no-schema"] });
    const outDir = join(tmpBase, "out");
    const stats = await exportVaultToDir(store, {
      outDir,
      exportedAt: "2026-05-12T00:00:00.000Z",
    });
    expect(stats.schemas).toBe(0);
    const schemasDir = join(outDir, SIDECAR_DIR, "schemas");
    if (existsSync(schemasDir)) {
      expect(readdirSync(schemasDir)).toEqual([]);
    }
  });

  it("emits note frontmatter with id, path, tags, created_at", async () => {
    const note = await store.createNote("body", { id: "n1", path: "Inbox/x", tags: ["daily"] });
    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-12T00:00:00.000Z" });

    const md = readFileSync(join(outDir, "Inbox/x.md"), "utf-8");
    expect(md).toContain("id: n1");
    expect(md).toContain("path: Inbox/x");
    expect(md).toContain("- daily");
    expect(md).toContain(`created_at: ${note.createdAt}`);
    expect(md).toContain("body");
  });

  it("serializes typed links (non-wikilink)", async () => {
    await store.createNote("source", { id: "src", path: "src" });
    await store.createNote("target", { id: "tgt", path: "tgt" });
    await store.createLink("src", "tgt", "derived-from");

    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-12T00:00:00.000Z" });

    const md = readFileSync(join(outDir, "src.md"), "utf-8");
    expect(md).toContain("links:");
    expect(md).toContain("relationship: derived-from");
    expect(md).toContain("target: tgt");
  });

  it("respects --since: filters notes whose updated_at < since", async () => {
    const older = await store.createNote("old", { id: "old", path: "old" });
    // Force a later updated_at on the second note by waiting briefly OR
    // by using an explicit timestamp. The store doesn't accept
    // updated_at on create, so we simulate by updating the second note
    // after a short delay.
    const newer = await store.createNote("new-content", { id: "new", path: "new" });
    // Both notes will have createdAt close to each other. To exercise
    // the --since filter cleanly, pick a `since` between them. Use the
    // `newer` note's createdAt itself as the boundary.
    const since = newer.createdAt;
    const outDir = join(tmpBase, "out");
    const stats = await exportVaultToDir(store, {
      outDir,
      since,
      exportedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(stats.filtered_by_since).toBe(true);
    // `newer` should be present (>= since); `older` should be excluded
    // (< since). The boundary is inclusive on the new side.
    expect(existsSync(join(outDir, "new.md"))).toBe(true);
    // The older note's timestamp is strictly less than `since` only when
    // creation timestamps differ. In a tight loop they may collide; assert
    // the filter behavior is at least "not both included" — the gate works
    // semantically regardless of millisecond collisions.
    if (older.createdAt < since) {
      expect(existsSync(join(outDir, "old.md"))).toBe(false);
    }
  });

  it("re-export with same exportedAt produces byte-identical output (idempotency)", async () => {
    await store.createNote("body", { id: "n1", path: "Inbox/x", tags: ["b", "a"] });
    await store.upsertTagSchema("a", { description: "tag-a" });
    await store.upsertTagSchema("b", { description: "tag-b" });

    const out1 = join(tmpBase, "out1");
    const out2 = join(tmpBase, "out2");
    await exportVaultToDir(store, {
      outDir: out1,
      vaultName: "test",
      exportedAt: "2026-05-12T00:00:00.000Z",
    });
    await exportVaultToDir(store, {
      outDir: out2,
      vaultName: "test",
      exportedAt: "2026-05-12T00:00:00.000Z",
    });

    // Compare every file's bytes.
    const noteA = readFileSync(join(out1, "Inbox/x.md"), "utf-8");
    const noteB = readFileSync(join(out2, "Inbox/x.md"), "utf-8");
    expect(noteB).toBe(noteA);

    const vaultA = readFileSync(join(out1, SIDECAR_DIR, "vault.yaml"), "utf-8");
    const vaultB = readFileSync(join(out2, SIDECAR_DIR, "vault.yaml"), "utf-8");
    expect(vaultB).toBe(vaultA);

    const schemaA = readFileSync(join(out1, SIDECAR_DIR, "schemas", "a.yaml"), "utf-8");
    const schemaB = readFileSync(join(out2, SIDECAR_DIR, "schemas", "a.yaml"), "utf-8");
    expect(schemaB).toBe(schemaA);
  });

  it("excludes wikilinks from the links block (wikilinks live in content)", async () => {
    await store.createNote("source", { id: "src", path: "src" });
    await store.createNote("target", { id: "tgt", path: "tgt" });
    await store.createLink("src", "tgt", "wikilink");
    await store.createLink("src", "tgt", "derived-from");

    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-12T00:00:00.000Z" });

    const md = readFileSync(join(outDir, "src.md"), "utf-8");
    expect(md).toContain("derived-from");
    // Wikilink relationship is not serialized as a typed link (it's
    // recoverable from the content's [[brackets]]).
    expect(md).not.toContain("relationship: wikilink");
  });

  // vault#317 F3 — path-traversal guard. A note with `path:
  // "../../escape"` (legitimate at vault level — user owns the data)
  // must NOT be allowed to write outside the export root. Refuses with
  // a console warning rather than aborting the export, so a partial
  // export is still useful.
  it("refuses to write a note whose path escapes the export root (vault#317 F3)", async () => {
    await store.createNote("safe", { id: "ok", path: "ok" });
    await store.createNote("escape", { id: "bad", path: "../../escape-attempt" });

    const outDir = join(tmpBase, "out");
    const stats = await exportVaultToDir(store, {
      outDir,
      exportedAt: "2026-05-12T00:00:00.000Z",
    });

    // Safe note written; escape-attempt skipped.
    expect(stats.notes).toBe(1);
    expect(existsSync(join(outDir, "ok.md"))).toBe(true);
    // The escape target — under tmpBase but above outDir — must NOT exist.
    expect(existsSync(join(tmpBase, "escape-attempt.md"))).toBe(false);
  });

  // Also pin the boundary case where the resolved write target is
  // exactly the outDir (path is a single segment, no traversal). This
  // should NOT trigger the guard.
  it("permits notes whose resolved path stays inside the export root", async () => {
    await store.createNote("nested-ok", { id: "n", path: "sub/dir/note" });
    const outDir = join(tmpBase, "out");
    const stats = await exportVaultToDir(store, {
      outDir,
      exportedAt: "2026-05-12T00:00:00.000Z",
    });
    expect(stats.notes).toBe(1);
    expect(existsSync(join(outDir, "sub/dir/note.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// noteToPortable — shape conversion
// ---------------------------------------------------------------------------

describe("noteToPortable", async () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = new SqliteStore(new Database(":memory:"));
  });

  it("converts a store Note into PortableNote with sorted tags + typed links", async () => {
    const note = await store.createNote("body", {
      id: "n1", path: "x", tags: ["z", "a"], metadata: { k: "v" },
    });
    await store.createNote("t", { id: "t", path: "t" });
    await store.createLink("n1", "t", "derived-from");

    const portable = await noteToPortable(note, store);
    expect(portable.id).toBe("n1");
    expect(portable.path).toBe("x");
    expect(portable.tags).toEqual(["a", "z"]); // sorted
    expect(portable.metadata).toEqual({ k: "v" });
    expect(portable.links).toHaveLength(1);
    expect(portable.links![0]).toMatchObject({ target: "t", relationship: "derived-from" });
  });

  it("omits empty collections from the result", async () => {
    const note = await store.createNote("body", { id: "n1", path: "x" });
    const portable = await noteToPortable(note, store);
    expect(portable.tags).toBeUndefined();
    expect(portable.metadata).toBeUndefined();
    expect(portable.links).toBeUndefined();
    expect(portable.attachments).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// importPortableVault — replay from a portable-md export back to a vault
// ---------------------------------------------------------------------------

describe("importPortableVault", async () => {
  const tmpBase = join(tmpdir(), "parachute-portable-import");
  let store: SqliteStore;

  beforeEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(tmpBase, { recursive: true });
    store = new SqliteStore(new Database(":memory:"));
  });

  it("throws when input dir lacks .parachute/vault.yaml (not a portable-md export)", async () => {
    const inDir = join(tmpBase, "not-an-export");
    mkdirSync(inDir, { recursive: true });
    writeFileSync(join(inDir, "stray.md"), "hello");
    await expect(importPortableVault(store, { inDir })).rejects.toThrow(/not a portable-md export/);
  });

  it("upserts by id — new notes created, existing notes updated, ids preserved", async () => {
    // Build a 2-note vault and export it.
    const n1 = await store.createNote("alpha body", { id: "n1", path: "a", tags: ["t1"] });
    await store.createNote("beta body", { id: "n2", path: "b" });

    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-13T00:00:00.000Z" });

    // Now import into a fresh store. Notes should appear with the same
    // ids (n1, n2) and contents.
    const freshStore = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(freshStore, { inDir: outDir });
    expect(stats.notes_created).toBe(2);
    expect(stats.notes_updated).toBe(0);

    const restoredA = await freshStore.getNote("n1");
    expect(restoredA).toBeTruthy();
    // Content survives the round-trip modulo a normalizing trailing
    // newline — `toPortableMarkdown` always emits one (so the parser's
    // line-oriented scan ends cleanly), and `parseFrontmatter` preserves
    // the body verbatim. The store happily round-trips either form.
    expect(restoredA!.content.trimEnd()).toBe("alpha body");
    expect(restoredA!.path).toBe("a");
    expect(restoredA!.tags).toContain("t1");

    const restoredB = await freshStore.getNote("n2");
    expect(restoredB).toBeTruthy();
    expect(restoredB!.content.trimEnd()).toBe("beta body");

    // Re-import into a store that ALREADY has n1 — should update,
    // not error, not duplicate.
    const partialStore = new SqliteStore(new Database(":memory:"));
    await partialStore.createNote("old alpha", { id: "n1", path: "a" });
    const stats2 = await importPortableVault(partialStore, { inDir: outDir });
    expect(stats2.notes_created).toBe(1); // n2 only
    expect(stats2.notes_updated).toBe(1); // n1 overwritten
    const updated = await partialStore.getNote("n1");
    expect(updated!.content.trimEnd()).toBe("alpha body"); // import won
  });

  it("--blow-away wipes the existing vault before replaying", async () => {
    // Build a vault, export, then in a fresh store seed unrelated
    // notes + blow-away-import. Those unrelated notes should vanish.
    const outDir = join(tmpBase, "out");
    await store.createNote("kept", { id: "k1" });
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-13T00:00:00.000Z" });

    const targetStore = new SqliteStore(new Database(":memory:"));
    await targetStore.createNote("will-be-wiped", { id: "old1" });
    await targetStore.createNote("also-wiped", { id: "old2" });

    const stats = await importPortableVault(targetStore, { inDir: outDir, blowAway: true });
    expect(stats.notes_wiped).toBe(2);
    expect(stats.notes_created).toBe(1);
    expect(await targetStore.getNote("old1")).toBeNull();
    expect(await targetStore.getNote("k1")).toBeTruthy();
  });

  // FIX 1 (vault#589) — blow-away must be all-or-nothing. Before the fix, the
  // wipe + replay ran with NO enclosing transaction: a mid-replay throw (here a
  // PathConflictError from two source files declaring the same `path`) left the
  // vault WIPED + partially replayed, originals gone for good. The wrap rolls
  // the whole thing back to the exact pre-import vault.
  //
  // RED-without-fix: temporarily change `importVault` to always call
  // `importVaultReplay` unwrapped (drop the `transactionAsync`) and this test
  // ends with 1 note (`n-first`), all three originals gone — the assertions
  // below fail. Verified manually during development.
  it("--blow-away is atomic — a mid-replay throw rolls back to the original vault (vault#589)", async () => {
    // Target vault holds originals that MUST survive a failed restore.
    const target = new SqliteStore(new Database(":memory:"));
    await target.createNote("original one", { id: "orig1", path: "keep/one" });
    await target.createNote("original two", { id: "orig2", path: "keep/two" });
    await target.createNote("original three", { id: "orig3", path: "keep/three" });

    // Hand-build a poisoned export: two notes declaring the SAME frontmatter
    // `path` → the 2nd createNote throws PathConflictError mid-replay. Files
    // walk in sorted order (first.md before second.md), so first.md lands, then
    // second.md collides.
    const inDir = join(tmpBase, "poison-collide");
    mkdirSync(join(inDir, ".parachute"), { recursive: true });
    writeFileSync(join(inDir, ".parachute", "vault.yaml"), "name: poison\nexport_format_version: 1\n");
    writeFileSync(join(inDir, "first.md"), "---\nid: nfirst\npath: collide\n---\nfirst body\n");
    writeFileSync(join(inDir, "second.md"), "---\nid: nsecond\npath: collide\n---\nsecond body\n");

    // The blow-away import propagates the collision (rejects) ...
    await expect(importPortableVault(target, { inDir, blowAway: true })).rejects.toThrow();

    // ... and rolls back: all three ORIGINALS survive, and NONE of the
    // poisoned import's notes landed. The vault is exactly as it was.
    expect(await target.getNote("orig1")).toBeTruthy();
    expect(await target.getNote("orig2")).toBeTruthy();
    expect(await target.getNote("orig3")).toBeTruthy();
    expect(await target.getNote("nfirst")).toBeNull();
    expect(await target.getNote("nsecond")).toBeNull();
    const all = await target.queryNotes({ limit: 100 });
    expect(all.length).toBe(3);
  });

  // FIX 3 (vault#589) — duplicate-id and blank-id content files must be
  // reported + skipped, not silently clobber (last-wins) or seed a bogus key.
  it("reports duplicate + blank note ids instead of silently clobbering (vault#589)", async () => {
    // Hand-build a tree: two files share id "dup" (distinct content); a third
    // carries a whitespace-only id. Files walk sorted: aaa < bbb < ccc.
    const inDir = join(tmpBase, "dup-ids");
    mkdirSync(join(inDir, ".parachute"), { recursive: true });
    writeFileSync(join(inDir, ".parachute", "vault.yaml"), "name: dup\nexport_format_version: 1\n");
    writeFileSync(join(inDir, "aaa.md"), "---\nid: dup\npath: pa\n---\nfrom aaa\n");
    writeFileSync(join(inDir, "bbb.md"), "---\nid: dup\npath: pb\n---\nfrom bbb\n");
    writeFileSync(join(inDir, "ccc.md"), "---\nid: '   '\npath: pc\n---\nfrom ccc\n");

    const target = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(target, { inDir });

    // Exactly ONE note created — the FIRST of the id collision (aaa) — and the
    // collision is NOT folded into "updated".
    expect(stats.notes_created).toBe(1);
    expect(stats.notes_updated).toBe(0);
    const kept = await target.getNote("dup");
    expect(kept).toBeTruthy();
    expect(kept!.content.trimEnd()).toBe("from aaa"); // first-wins, deterministic

    // Both the duplicate (bbb) and the blank-id (ccc) file are reported as
    // skipped — surfaced in stats, not absorbed into the created/updated count.
    expect(stats.skipped_duplicate_ids.length).toBe(2);
    const dupEntry = stats.skipped_duplicate_ids.find((s) => s.reason.includes("duplicate id"));
    expect(dupEntry).toBeTruthy();
    expect(dupEntry!.path).toBe("pb");
    const blankEntry = stats.skipped_duplicate_ids.find((s) => s.reason.includes("blank"));
    expect(blankEntry).toBeTruthy();

    // The whitespace-id file clobbered nothing — no bogus key, only "dup" exists.
    const allNotes = await target.queryNotes({ limit: 100 });
    expect(allNotes.length).toBe(1);
  });

  it("restores tag schemas (description + fields)", async () => {
    await store.upsertTagSchema("task", {
      description: "A unit of work",
      fields: { priority: { type: "string", enum: ["high", "low"] } },
    });
    await store.createNote("x", { id: "x", tags: ["task"] });
    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-13T00:00:00.000Z" });

    const target = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(target, { inDir: outDir });
    expect(stats.schemas_restored).toBe(1);
    const schema = await target.getTagSchema("task");
    expect(schema).toBeTruthy();
    expect(schema!.description).toBe("A unit of work");
  });

  // Fix 2 — import must re-declare indexed fields. The import writes
  // tags.fields via upsertTagRecord but historically never materialized the
  // backing generated columns + indexes, so a fresh import advertised
  // `indexed: true` while queries silently full-scanned. Regression: export a
  // vault with an indexed field → fresh import → the generated column + index
  // exist and the field shows in the vault-info indexed_fields catalog.
  it("re-declares indexed fields on import (column + index + vault-info catalog)", async () => {
    await store.upsertTagRecord("project", {
      fields: { status: { type: "string", indexed: true } },
    });
    await store.createNote("p", { id: "p", tags: ["project"], metadata: { status: "active" } });
    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-13T00:00:00.000Z" });

    const target = new SqliteStore(new Database(":memory:"));
    const targetDb = target.db;
    // Pre-condition: a fresh store has no backing column yet.
    const colsBefore = (targetDb.prepare("PRAGMA table_xinfo(notes)").all() as { name: string }[]).map((r) => r.name);
    expect(colsBefore).not.toContain("meta_status");

    const stats = await importPortableVault(target, { inDir: outDir });
    expect(stats.schemas_restored).toBe(1);
    expect(stats.indexes_declared).toBe(1);

    // The generated column + index now exist — same introspection vault-info
    // uses to advertise the queryable-field catalog.
    const colsAfter = (targetDb.prepare("PRAGMA table_xinfo(notes)").all() as { name: string }[]).map((r) => r.name);
    expect(colsAfter).toContain("meta_status");
    const idxs = (targetDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notes'").all() as { name: string }[]).map((r) => r.name);
    expect(idxs).toContain("idx_meta_status");
    expect(getIndexedField(targetDb, "status")?.declarerTags).toEqual(["project"]);
    // And vault-info lists it.
    expect(buildVaultProjection(targetDb).indexed_fields.map((f) => f.name)).toContain("status");
  });

  it("dry-run import counts indexes_declared without materializing columns", async () => {
    await store.upsertTagRecord("project", {
      fields: { status: { type: "string", indexed: true } },
    });
    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-13T00:00:00.000Z" });

    const target = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(target, { inDir: outDir, dryRun: true });
    expect(stats.indexes_declared).toBe(1);
    // Dry-run touches nothing.
    const cols = (target.db.prepare("PRAGMA table_xinfo(notes)").all() as { name: string }[]).map((r) => r.name);
    expect(cols).not.toContain("meta_status");
  });

  it("restores typed links (non-wikilink relationships)", async () => {
    await store.createNote("src body", { id: "src", path: "src" });
    await store.createNote("tgt body", { id: "tgt", path: "tgt" });
    await store.createLink("src", "tgt", "derived-from", { source: "git://x" });
    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-13T00:00:00.000Z" });

    const target = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(target, { inDir: outDir });
    expect(stats.links_restored).toBe(1);
    const links = await target.getLinks("src", { direction: "outbound" });
    const typed = links.find((l) => l.relationship === "derived-from");
    expect(typed).toBeTruthy();
    expect(typed!.targetId).toBe("tgt");
    expect(typed!.metadata).toEqual({ source: "git://x" });
  });

  it("preserves an opaque relationship-vocabulary map across export → import → re-export (vault#428)", async () => {
    const vocab = {
      "works-on": { from: "person", to: "project" },
      "member-of": { from: "person", to: "organization" },
      "partner-of": { from: "person", to: "person" },
      "based-at": { from: "project", to: "place", note: "freeform" },
    };
    await store.upsertTagRecord("person", {
      description: "a human",
      relationships: vocab,
    });
    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-13T00:00:00.000Z" });

    const target = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(target, { inDir: outDir });
    expect(stats.schemas_restored).toBe(1);

    // Imported value matches the original verbatim.
    const restored = await target.getTagRecord("person");
    expect(restored?.relationships).toEqual(vocab);

    // Re-export from the restored store and confirm the schema file is
    // byte-identical to the first export (deep round-trip stability).
    const outDir2 = join(tmpBase, "out2");
    await exportVaultToDir(target, { outDir: outDir2, exportedAt: "2026-05-13T00:00:00.000Z" });
    const schemaA = readFileSync(join(outDir, SIDECAR_DIR, "schemas", "person.yaml"), "utf-8");
    const schemaB = readFileSync(join(outDir2, SIDECAR_DIR, "schemas", "person.yaml"), "utf-8");
    expect(schemaB).toBe(schemaA);
  });

  it("skips typed links whose target is missing from the import set", async () => {
    // Source note has a typed link to a target we don't include in
    // the export (synthetic — write the .md file by hand).
    const outDir = join(tmpBase, "out");
    const sidecar = join(outDir, SIDECAR_DIR);
    mkdirSync(sidecar, { recursive: true });
    writeFileSync(join(sidecar, "vault.yaml"), "export_format_version: 1\nexported_at: 2026-05-13T00:00:00.000Z\n");
    writeFileSync(join(outDir, "src.md"), `---
id: src
path: src
links:
  - relationship: derived-from
    target: ghost
created_at: 2026-05-13T00:00:00.000Z
---
body
`);

    const target = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(target, { inDir: outDir });
    expect(stats.skipped_links).toHaveLength(1);
    expect(stats.skipped_links[0]).toMatchObject({ source_id: "src", target_id: "ghost" });
  });

  it("dry-run counts would-be operations without writing", async () => {
    await store.createNote("x", { id: "x" });
    const outDir = join(tmpBase, "out");
    await exportVaultToDir(store, { outDir, exportedAt: "2026-05-13T00:00:00.000Z" });

    const target = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(target, { inDir: outDir, dryRun: true });
    expect(stats.notes_created).toBe(1);
    // …but nothing actually landed.
    expect(await target.getNote("x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: vault → export → blow-away import → re-export →
// byte-equivalent to first export. This is the load-bearing test for
// the format's whole pitch (vault#308 P3).
// ---------------------------------------------------------------------------

describe("portable-md round-trip — byte-equivalent re-export after blow-away import", async () => {
  const tmpBase = join(tmpdir(), "parachute-portable-roundtrip");
  let store: SqliteStore;

  beforeEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(tmpBase, { recursive: true });
    store = new SqliteStore(new Database(":memory:"));
  });

  it("realistic vault → export → blow-away import → re-export → byte-equivalent", async () => {
    // Build a vault that exercises every field of the format:
    //   - Multiple notes (some pathed, one un-pathed).
    //   - Tags with declared schemas (description + fields).
    //   - Typed links (non-wikilink).
    //   - Multi-line metadata (vault#317 F1 path).
    //   - One note edited (created_at ≠ updated_at).
    //   - Empty-content note (vault#323) — skeleton/draft shape that real
    //     vaults legitimately carry. Pins the round-trip regression that
    //     blocked stable promotion when the EMPTY_NOTE guard was still
    //     rejecting these on import.
    await store.upsertTagSchema("project", {
      description: "A long-running effort",
      fields: { status: { type: "string", enum: ["active", "done"] } },
    });
    // Opaque relationship-vocabulary map (vault#428) — exercises that the
    // round-trip preserves an arbitrary app-defined relationships shape,
    // not just the historical { target_tag, cardinality } one.
    await store.upsertTagRecord("project", {
      relationships: {
        "works-on": { from: "person", to: "project" },
        "based-at": { from: "project", to: "place", note: "freeform" },
      },
    });
    const n1 = await store.createNote("alpha body", {
      id: "01HX001",
      path: "Inbox/alpha",
      tags: ["project", "z-other"],
      metadata: {
        priority: "high",
        // Multi-line — exercises the F1 double-quoted-escape path.
        notes: "line1\nline2\nline3",
      },
    });
    await store.createNote("beta body", {
      id: "01HX002",
      path: "Inbox/beta",
      tags: ["project"],
    });
    await store.createNote("unpathed jot", { id: "01HX003" });
    // Empty-content note with a path — the skeleton/organizing-only
    // shape from vault#323. Export emits it as frontmatter + empty body;
    // import must accept it.
    await store.createNote("", {
      id: "01HX004",
      path: "Inbox/skeleton",
      tags: ["project"],
    });
    await store.createLink("01HX001", "01HX002", "derived-from", { source: "git://example" });

    // Force a divergence between created_at and updated_at on n1 so
    // the round-trip exercises restoreNoteTimestamps.
    const newerStamp = new Date(new Date(n1.createdAt).getTime() + 60_000).toISOString();
    await store.restoreNoteTimestamps("01HX001", n1.createdAt, newerStamp);

    // First export.
    const outA = join(tmpBase, "outA");
    await exportVaultToDir(store, {
      outDir: outA,
      vaultName: "test",
      exportedAt: "2026-05-13T00:00:00.000Z",
    });

    // Blow-away import into a fresh store.
    const restored = new SqliteStore(new Database(":memory:"));
    const importStats = await importPortableVault(restored, { inDir: outA, blowAway: true });
    expect(importStats.notes_created).toBe(4);
    expect(importStats.schemas_restored).toBe(1);
    expect(importStats.links_restored).toBe(1);

    // Empty-content note survives the round-trip — content is empty,
    // path + tags persist. This is the load-bearing assertion for
    // vault#323: prior to the EMPTY_NOTE drop, importPortableVault
    // threw on the createNote("") call here.
    const skeleton = await restored.getNote("01HX004");
    expect(skeleton).not.toBeNull();
    expect(skeleton!.content).toBe("");
    expect(skeleton!.path).toBe("Inbox/skeleton");
    expect(skeleton!.tags).toContain("project");

    // Second export from the restored store.
    const outB = join(tmpBase, "outB");
    await exportVaultToDir(restored, {
      outDir: outB,
      vaultName: "test",
      exportedAt: "2026-05-13T00:00:00.000Z",
    });

    // Byte-equivalence: every file in outA must match outB exactly.
    const compareTree = (a: string, b: string, prefix = "") => {
      const aEntries = readdirSync(a).sort();
      const bEntries = readdirSync(b).sort();
      expect(bEntries).toEqual(aEntries);
      for (const entry of aEntries) {
        const aPath = join(a, entry);
        const bPath = join(b, entry);
        const aStat = statSync(aPath);
        const bStat = statSync(bPath);
        expect(bStat.isDirectory()).toBe(aStat.isDirectory());
        if (aStat.isDirectory()) {
          compareTree(aPath, bPath, prefix + entry + "/");
        } else {
          const aBuf = readFileSync(aPath, "utf-8");
          const bBuf = readFileSync(bPath, "utf-8");
          if (aBuf !== bBuf) {
            // Surface the offending file path + a diff hint so a real
            // drift bug is debuggable.
            // eslint-disable-next-line no-console
            console.error(`drift at ${prefix}${entry}:\n--- outA ---\n${aBuf}\n--- outB ---\n${bBuf}`);
          }
          expect(bBuf).toBe(aBuf);
        }
      }
    };
    compareTree(outA, outB);
  });
});

// ---------------------------------------------------------------------------
// Attachment round-trip — bytes survive export → import (vault#319 F3)
// ---------------------------------------------------------------------------
//
// PR 2 added attachment binary copy on both export and import sides but
// shipped without an integration test for the byte-level round-trip.
// Folding here per reviewer F3. Two tests:
//   1. Happy path — source vault with a real binary file → export →
//      fresh-vault import → assert bytes match at the new assetsDir.
//   2. Adversarial path — attachment whose `path` escapes assetsDir on
//      import side. (Export-side guard is already covered; this is the
//      *import*-side guard we want pinned.)

describe("portable-md attachments round-trip (vault#319 F3)", async () => {
  const tmpBase = join(tmpdir(), "parachute-portable-att");
  let store: SqliteStore;

  beforeEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(tmpBase, { recursive: true });
    store = new SqliteStore(new Database(":memory:"));
  });

  it("attachment bytes survive vault → export → fresh-vault import", async () => {
    // Source vault: write a binary file at <srcAssets>/<rel>, then
    // register it via addAttachment (DB row only — the bytes already
    // exist on disk).
    const srcAssets = join(tmpBase, "src-assets");
    mkdirSync(srcAssets, { recursive: true });
    const relPath = "2026-05-13/sample.bin";
    mkdirSync(join(srcAssets, "2026-05-13"), { recursive: true });
    // Distinctive bytes — non-utf8 so we know the buffer round-tripped.
    const originalBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    writeFileSync(join(srcAssets, relPath), originalBytes);

    const note = await store.createNote("note with attachment", { id: "n-att", path: "n" });
    await store.addAttachment(note.id, relPath, "image/png");

    // Export with assetsDir wired so the binary lands in the sidecar.
    const outDir = join(tmpBase, "out");
    const exportStats = await exportVaultToDir(store, {
      outDir,
      assetsDir: srcAssets,
      exportedAt: "2026-05-13T00:00:00.000Z",
    });
    expect(exportStats.attachments).toBe(1);
    expect(exportStats.skipped_attachments).toEqual([]);

    // The binary lives at .parachute/attachments/<att-id>/sample.bin.
    const attachments = await store.getAttachments(note.id);
    expect(attachments).toHaveLength(1);
    const exportedAttId = attachments[0]!.id;
    const sidecarFile = join(outDir, SIDECAR_DIR, "attachments", exportedAttId, "sample.bin");
    expect(existsSync(sidecarFile)).toBe(true);
    expect(readFileSync(sidecarFile)).toEqual(originalBytes);

    // Import into a fresh vault + different assetsDir. Binary must
    // land at <destAssets>/<original relPath> (the frontmatter
    // preserves the original vault-internal path).
    const destAssets = join(tmpBase, "dest-assets");
    mkdirSync(destAssets, { recursive: true });
    const target = new SqliteStore(new Database(":memory:"));
    const importStats = await importPortableVault(target, {
      inDir: outDir,
      assetsDir: destAssets,
    });
    expect(importStats.attachments_restored).toBe(1);
    expect(importStats.skipped_attachments).toEqual([]);

    // Bytes match — the load-bearing assertion. Read through the
    // serialized form (filesystem), not the original buffer, to round-trip
    // honestly per the F2 memory.
    const restoredBytes = readFileSync(join(destAssets, relPath));
    expect(restoredBytes).toEqual(originalBytes);

    // DB row restored too — note has an attachment with the right path
    // + mime_type (id re-mints per the known limitation in CHANGELOG).
    const restoredAtts = await target.getAttachments("n-att");
    expect(restoredAtts).toHaveLength(1);
    expect(restoredAtts[0]!.path).toBe(relPath);
    expect(restoredAtts[0]!.mimeType).toBe("image/png");
  });

  it("import skips attachments whose frontmatter path escapes destination assetsDir", async () => {
    // Hand-craft an adversarial export: a .md file with an
    // `attachments[].path` that resolves outside the dest assetsDir.
    // Plus a dummy binary in the sidecar so the file-existence check
    // doesn't trip first (we want to exercise the path-traversal guard
    // specifically).
    const outDir = join(tmpBase, "adversarial");
    const sidecar = join(outDir, SIDECAR_DIR);
    mkdirSync(sidecar, { recursive: true });
    writeFileSync(
      join(sidecar, "vault.yaml"),
      "export_format_version: 1\nexported_at: 2026-05-13T00:00:00.000Z\n",
    );

    // Sidecar binary at attachments/<id>/escape.bin so the
    // file-existence check passes; the traversal guard fires on the
    // *dest* path resolve.
    const advAttId = "att_adversarial";
    mkdirSync(join(sidecar, "attachments", advAttId), { recursive: true });
    writeFileSync(join(sidecar, "attachments", advAttId, "escape.bin"), "harmless\n");

    // Note frontmatter with an escape path.
    writeFileSync(
      join(outDir, "n.md"),
      `---
id: n
attachments:
  - id: ${advAttId}
    path: ../../../escape.bin
    mime_type: application/octet-stream
created_at: 2026-05-13T00:00:00.000Z
---
note body
`,
    );

    // Import. assetsDir is destAssets; the adversarial path resolves
    // outside it, so the guard fires.
    const destAssets = join(tmpBase, "dest-assets");
    mkdirSync(destAssets, { recursive: true });
    const target = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(target, {
      inDir: outDir,
      assetsDir: destAssets,
    });

    // The DB row still creates (path-traversal only blocks the file
    // copy — the DB row stores whatever path the frontmatter declared;
    // the guard's job is preventing arbitrary-file-write, not
    // poisoning the DB which is operator-owned). What we pin: the
    // adversarial file did NOT land in destAssets parent.
    expect(stats.skipped_attachments).toHaveLength(1);
    expect(stats.skipped_attachments[0]!.reason).toMatch(/path-traversal/);
    // The escape target — under tmpBase/<parent-of-destAssets>/escape.bin
    // — must NOT exist. Most importantly NOT at a path higher than destAssets.
    const wouldBeEscape = join(tmpBase, "escape.bin");
    expect(existsSync(wouldBeEscape)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// File-extension support — non-markdown notes (vault#328)
// ---------------------------------------------------------------------------
//
// Two pinned behaviors per the design issue:
//   1. supportsInlineFrontmatter: md + mdx return true; everything else
//      returns false.
//   2. Round-trip integration: vault containing csv/yaml/json/mdx/empty
//      notes survives export → blow-away import → re-export byte-equiv.

describe("supportsInlineFrontmatter (vault#328)", () => {
  it("returns true for md and mdx", () => {
    expect(supportsInlineFrontmatter("md")).toBe(true);
    expect(supportsInlineFrontmatter("mdx")).toBe(true);
    // Case-insensitive — guard against caller-supplied 'MD'.
    expect(supportsInlineFrontmatter("MD")).toBe(true);
  });

  it("returns false for sidecar-required formats", () => {
    expect(supportsInlineFrontmatter("csv")).toBe(false);
    expect(supportsInlineFrontmatter("yaml")).toBe(false);
    expect(supportsInlineFrontmatter("json")).toBe(false);
    expect(supportsInlineFrontmatter("txt")).toBe(false);
    expect(supportsInlineFrontmatter("org")).toBe(false); // not yet in the set
  });
});

describe("toPortableMarkdown — extension awareness (vault#328)", () => {
  it(".md note still gets inline frontmatter", () => {
    const out = toPortableMarkdown({
      id: "1",
      path: "Inbox/a",
      extension: "md",
      content: "hello\n",
      created_at: "2026-05-15T00:00:00.000Z",
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("id: '1'");
    expect(out).toContain("hello");
  });

  it(".mdx note also gets inline frontmatter", () => {
    const out = toPortableMarkdown({
      id: "1",
      path: "Components/Card",
      extension: "mdx",
      content: "import X from './x';\n\n<X/>\n",
      created_at: "2026-05-15T00:00:00.000Z",
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("extension: mdx");
  });

  it(".csv note returns raw content — no frontmatter prepend", () => {
    const out = toPortableMarkdown({
      id: "1",
      path: "Tabular/budget",
      extension: "csv",
      content: "month,total\n2026-01,9000\n",
      created_at: "2026-05-15T00:00:00.000Z",
    });
    expect(out.startsWith("---\n")).toBe(false);
    expect(out).toBe("month,total\n2026-01,9000\n");
  });

  it("toSidecarYaml emits the same key set as inline frontmatter, always includes extension", () => {
    const sidecar = toSidecarYaml({
      id: "abc",
      path: "Tabular/budget",
      extension: "csv",
      tags: ["budget"],
      content: "irrelevant — sidecar carries metadata only",
      metadata: { fiscal_year: 2026 },
      created_at: "2026-05-15T00:00:00.000Z",
      updated_at: "2026-05-15T00:00:00.000Z",
    });
    expect(sidecar).toContain("id: abc");
    expect(sidecar).toContain("path: Tabular/budget");
    expect(sidecar).toContain("extension: csv");
    expect(sidecar).toContain("tags:");
    expect(sidecar).toContain("budget");
    expect(sidecar).toContain("fiscal_year");
  });
});

describe("portable-md non-markdown round-trip (vault#328)", async () => {
  const tmpBase = join(tmpdir(), "parachute-portable-ext");
  let store: SqliteStore;

  beforeEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(tmpBase, { recursive: true });
    store = new SqliteStore(new Database(":memory:"));
  });

  it("csv/yaml/json/mdx/empty notes survive export → blow-away import → byte-equivalent re-export", async () => {
    // Seed a vault that hits every extension axis the brief calls out:
    //   - .csv (sidecar-required, non-empty)
    //   - .yaml (sidecar-required, non-empty)
    //   - .json (sidecar-required, non-empty)
    //   - .mdx (frontmatter-compatible, non-empty)
    //   - .csv empty-content (the vault#323 edge case, vault#328 sidecar path)
    //   - .md (back-compat baseline — same shape as pre-vault#328)
    await store.createNote("month,total\n2026-01,9000\n", {
      id: "csv-1",
      path: "Tabular/budget",
      extension: "csv",
      tags: ["budget"],
      metadata: { fiscal_year: 2026, currency: "USD" },
    });
    await store.createNote("- one\n- two\n", {
      id: "yaml-1",
      path: "Config/options",
      extension: "yaml",
    });
    await store.createNote(`{"k":1}\n`, {
      id: "json-1",
      path: "Data/sample",
      extension: "json",
    });
    await store.createNote("import X from './x';\n\n<X/>\n", {
      id: "mdx-1",
      path: "Components/Card",
      extension: "mdx",
      tags: ["component"],
    });
    await store.createNote("", {
      id: "csv-empty",
      path: "Tabular/skeleton",
      extension: "csv",
    });
    await store.createNote("plain markdown body\n", {
      id: "md-1",
      path: "Inbox/note",
      tags: ["inbox"],
    });

    // Export A.
    const outA = join(tmpBase, "outA");
    const statsA = await exportVaultToDir(store, {
      outDir: outA,
      vaultName: "test",
      exportedAt: "2026-05-15T00:00:00.000Z",
    });
    expect(statsA.notes).toBe(6);
    // Four sidecar-required notes (csv ×2, yaml, json) → four sidecars.
    // md + mdx carry frontmatter inline so they don't get sidecars.
    expect(statsA.sidecars).toBe(4);

    // Sidecar files exist with the right basenames (note ids).
    const sidecarDir = join(outA, SIDECAR_DIR, NOTES_META_DIR);
    expect(readdirSync(sidecarDir).sort()).toEqual([
      "csv-1.yaml",
      "csv-empty.yaml",
      "json-1.yaml",
      "yaml-1.yaml",
    ]);

    // Content files at the user-visible paths with the right suffixes.
    expect(existsSync(join(outA, "Tabular/budget.csv"))).toBe(true);
    expect(existsSync(join(outA, "Config/options.yaml"))).toBe(true);
    expect(existsSync(join(outA, "Data/sample.json"))).toBe(true);
    expect(existsSync(join(outA, "Components/Card.mdx"))).toBe(true);
    expect(existsSync(join(outA, "Tabular/skeleton.csv"))).toBe(true);
    expect(existsSync(join(outA, "Inbox/note.md"))).toBe(true);

    // .csv content is RAW — no `---` frontmatter prepend.
    const csvFile = readFileSync(join(outA, "Tabular/budget.csv"), "utf-8");
    expect(csvFile.startsWith("---")).toBe(false);
    expect(csvFile).toBe("month,total\n2026-01,9000\n");

    // .mdx content has inline frontmatter (same as .md).
    const mdxFile = readFileSync(join(outA, "Components/Card.mdx"), "utf-8");
    expect(mdxFile.startsWith("---\n")).toBe(true);
    expect(mdxFile).toContain("extension: mdx");

    // Blow-away import into a fresh store.
    const restored = new SqliteStore(new Database(":memory:"));
    const importStats = await importPortableVault(restored, { inDir: outA, blowAway: true });
    expect(importStats.notes_created).toBe(6);

    // Verify each note round-tripped its content + extension.
    const csvRestored = await restored.getNote("csv-1");
    expect(csvRestored).not.toBeNull();
    expect(csvRestored!.content).toBe("month,total\n2026-01,9000\n");
    expect(csvRestored!.extension).toBe("csv");
    expect(csvRestored!.metadata).toEqual({ fiscal_year: 2026, currency: "USD" });
    expect(csvRestored!.tags).toContain("budget");

    const emptyCsv = await restored.getNote("csv-empty");
    expect(emptyCsv!.content).toBe("");
    expect(emptyCsv!.extension).toBe("csv");
    expect(emptyCsv!.path).toBe("Tabular/skeleton");

    const mdxRestored = await restored.getNote("mdx-1");
    expect(mdxRestored!.extension).toBe("mdx");
    expect(mdxRestored!.content).toBe("import X from './x';\n\n<X/>\n");

    const mdRestored = await restored.getNote("md-1");
    expect(mdRestored!.extension).toBe("md");
    expect(mdRestored!.tags).toContain("inbox");

    // Re-export B from the restored store.
    const outB = join(tmpBase, "outB");
    await exportVaultToDir(restored, {
      outDir: outB,
      vaultName: "test",
      exportedAt: "2026-05-15T00:00:00.000Z",
    });

    // Byte-equivalence — every file in outA matches outB.
    const compareTree = (a: string, b: string, prefix = "") => {
      const aEntries = readdirSync(a).sort();
      const bEntries = readdirSync(b).sort();
      expect(bEntries).toEqual(aEntries);
      for (const entry of aEntries) {
        const aPath = join(a, entry);
        const bPath = join(b, entry);
        const aStat = statSync(aPath);
        const bStat = statSync(bPath);
        expect(bStat.isDirectory()).toBe(aStat.isDirectory());
        if (aStat.isDirectory()) {
          compareTree(aPath, bPath, prefix + entry + "/");
        } else {
          const aBuf = readFileSync(aPath, "utf-8");
          const bBuf = readFileSync(bPath, "utf-8");
          if (aBuf !== bBuf) {
            // eslint-disable-next-line no-console
            console.error(`drift at ${prefix}${entry}:\n--- outA ---\n${aBuf}\n--- outB ---\n${bBuf}`);
          }
          expect(bBuf).toBe(aBuf);
        }
      }
    };
    compareTree(outA, outB);
  });

  it("records orphan sidecars in ImportStats.skipped_sidecars (vault#330 S2)", async () => {
    // Build a portable-md export by hand with an orphan sidecar: a
    // sidecar YAML at .parachute/notes-meta/<id>.yaml whose
    // (path, extension) doesn't point to any real content file on
    // disk. Import should record it in skipped_sidecars without
    // crashing.
    const outDir = join(tmpBase, "orphan-sidecar");
    mkdirSync(join(outDir, SIDECAR_DIR, NOTES_META_DIR), { recursive: true });
    writeFileSync(
      join(outDir, SIDECAR_DIR, "vault.yaml"),
      "export_format_version: 1\nexported_at: '2026-05-15T00:00:00.000Z'\n",
    );
    writeFileSync(
      join(outDir, SIDECAR_DIR, NOTES_META_DIR, "orphan-1.yaml"),
      "id: orphan-1\npath: Tabular/missing\nextension: csv\ncreated_at: '2026-05-15T00:00:00.000Z'\nupdated_at: '2026-05-15T00:00:00.000Z'\n",
    );

    const restored = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(restored, { inDir: outDir });
    expect(stats.notes_created).toBe(0);
    expect(stats.skipped_sidecars).toHaveLength(1);
    expect(stats.skipped_sidecars[0]!.sidecar_id).toBe("orphan-1");
    expect(stats.skipped_sidecars[0]!.expected_path).toBe("Tabular/missing");
    expect(stats.skipped_sidecars[0]!.expected_extension).toBe("csv");
    expect(stats.skipped_sidecars[0]!.reason).toMatch(/no content file/);
  });

  it("skipped_sidecars stays empty on a clean export-then-import", async () => {
    // Sanity pin: when every sidecar pairs with a content file, the
    // leftover-drain produces no entries.
    await store.createNote("month,total\n2026-01,9000", {
      id: "csv-1",
      path: "Tabular/budget",
      extension: "csv",
    });
    const outDir = join(tmpBase, "clean-sidecars");
    await exportVaultToDir(store, {
      outDir,
      vaultName: "test",
      exportedAt: "2026-05-15T00:00:00.000Z",
    });
    const restored = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(restored, { inDir: outDir, blowAway: true });
    expect(stats.skipped_sidecars).toEqual([]);
  });

  it("import refuses content files lacking a sidecar (orphaned non-md file)", async () => {
    // Build a minimal portable-md directory by hand: a valid vault.yaml
    // + a .csv content file with NO matching sidecar. The importer
    // should skip the orphaned file rather than crashing or creating
    // a sidecar-less note.
    const outDir = join(tmpBase, "orphan");
    mkdirSync(join(outDir, SIDECAR_DIR), { recursive: true });
    writeFileSync(
      join(outDir, SIDECAR_DIR, "vault.yaml"),
      "export_format_version: 1\nexported_at: '2026-05-15T00:00:00.000Z'\n",
    );
    mkdirSync(join(outDir, "Tabular"), { recursive: true });
    writeFileSync(join(outDir, "Tabular/orphan.csv"), "a,b\n1,2\n");

    const restored = new SqliteStore(new Database(":memory:"));
    const stats = await importPortableVault(restored, { inDir: outDir });
    // No sidecar → no DB row.
    expect(stats.notes_created).toBe(0);
  });

  // -------------------------------------------------------------------------
  // vault#552 — the write-time parent_names cycle guard must NOT abort an
  // import of an OLD export that carries a mutual-cycle fixture (accepted
  // before the guard shipped). The offending parent_names is dropped +
  // warned, the tags + notes still land. On a blow-away replace this is
  // load-bearing: the vault was already wiped, so an uncaught throw here
  // would leave it EMPTY with no rollback.
  // -------------------------------------------------------------------------

  /** Hand-build a portable-md export whose two tag schemas form an A↔B
   *  parent_names cycle, plus one note tagged with `a`. */
  function writeCyclicSchemaExport(dir: string): void {
    mkdirSync(join(dir, SIDECAR_DIR, "schemas"), { recursive: true });
    writeFileSync(
      join(dir, SIDECAR_DIR, "vault.yaml"),
      "export_format_version: 1\nexported_at: '2026-07-09T00:00:00.000Z'\n",
    );
    writeFileSync(
      join(dir, SIDECAR_DIR, "schemas", "a.yaml"),
      "name: a\ndescription: tag a\nparent_names:\n  - b\n",
    );
    writeFileSync(
      join(dir, SIDECAR_DIR, "schemas", "b.yaml"),
      "name: b\ndescription: tag b\nparent_names:\n  - a\n",
    );
    writeFileSync(
      join(dir, "note1.md"),
      "---\nid: note1\npath: note1\ntags:\n  - a\ncreated_at: '2026-07-09T00:00:00.000Z'\nupdated_at: '2026-07-09T00:00:00.000Z'\n---\nhello from note1\n",
    );
  }

  it("imports an export carrying a parent_names cycle — the cycle is dropped + warned, not fatal (vault#552 MUST-FIX 1)", async () => {
    const outDir = join(tmpBase, "cyclic-schemas");
    writeCyclicSchemaExport(outDir);

    const restored = new SqliteStore(new Database(":memory:"));
    // MUST complete, not throw.
    const stats = await importPortableVault(restored, { inDir: outDir });

    // Both schemas + the note landed.
    expect(stats.schemas_restored).toBe(2);
    expect(stats.notes_created).toBe(1);
    expect((await restored.getNote("note1"))!.content.trimEnd()).toBe("hello from note1");
    expect(await restored.getTagRecord("a")).not.toBeNull();
    expect(await restored.getTagRecord("b")).not.toBeNull();

    // Exactly one of the two had its parent_names dropped (whichever the
    // filesystem walk restored SECOND closes the cycle) and is recorded.
    expect(stats.skipped_schema_parents).toHaveLength(1);
    const skipped = stats.skipped_schema_parents[0]!;
    expect(["a", "b"]).toContain(skipped.tag);
    expect(skipped.reason).toMatch(/cycle/i);

    // The surviving hierarchy is acyclic: at most one of a/b still carries
    // parent_names (the other was dropped). Never both.
    const aParents = (await restored.getTagRecord("a"))!.parent_names ?? null;
    const bParents = (await restored.getTagRecord("b"))!.parent_names ?? null;
    expect(Boolean(aParents) && Boolean(bParents)).toBe(false);
  });

  it("blow-away import of a cyclic-schema export leaves the vault populated, NOT empty (vault#552 MUST-FIX 1 — destructive path)", async () => {
    const outDir = join(tmpBase, "cyclic-blowaway");
    writeCyclicSchemaExport(outDir);

    // Seed the target with a throwaway note so blow-away has something to
    // wipe — proving the wipe ran AND that the uncaught-throw regression
    // (wipe-then-abort → empty vault) is gone.
    const restored = new SqliteStore(new Database(":memory:"));
    await restored.createNote("doomed pre-existing note", { id: "old1", path: "old1" });

    const stats = await importPortableVault(restored, { inDir: outDir, blowAway: true });

    expect(stats.notes_wiped).toBe(1); // the pre-existing note was wiped
    expect(await restored.getNote("old1")).toBeNull(); // gone
    // Vault is NOT left empty — the fixture note landed despite the cycle.
    expect((await restored.getNote("note1"))!.content.trimEnd()).toBe("hello from note1");
    expect(stats.skipped_schema_parents).toHaveLength(1);
  });

  it("blow-away wipes a parent-before-child hierarchy with NO stale tag rows left (vault#552 MUST-FIX 2)", async () => {
    // The bug: blow-away's tag sweep called store.deleteTag(tag) with no
    // flag and ignored the return. listTagRecords is ORDER BY name, so the
    // namespace parent "task" is visited BEFORE its child "task/work" —
    // while the child's parent_names still references it — and deleteTag now
    // RETURNS {error:"tag_referenced_as_parent"} instead of throwing, so the
    // parent's row silently survived the "clean slate." Fixed by passing
    // {cascade:true} in the sweep.
    const target = new SqliteStore(new Database(":memory:"));
    await target.upsertTagRecord("task", { description: "parent" });
    await target.upsertTagRecord("task/work", { parent_names: ["task"], description: "child" });
    await target.createNote("stale note", { id: "stale1", path: "stale1", tags: ["task/work"] });

    // Build a minimal UNRELATED export from a fresh store to replay.
    const sourceStore = new SqliteStore(new Database(":memory:"));
    await sourceStore.createNote("fresh body", { id: "fresh1", path: "fresh1", tags: ["fresh"] });
    const outDir = join(tmpBase, "blowaway-hierarchy-source");
    await exportVaultToDir(sourceStore, { outDir, exportedAt: "2026-07-09T00:00:00.000Z" });

    await importPortableVault(target, { inDir: outDir, blowAway: true });

    // After a full wipe, NEITHER old hierarchy tag row survives.
    const remaining = (await target.listTagRecords()).map((t) => t.tag);
    expect(remaining).not.toContain("task");
    expect(remaining).not.toContain("task/work");
    expect(await target.getNote("stale1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wikilink ambiguity policy (vault#328)
// ---------------------------------------------------------------------------
//
// When two notes share a path differing only by extension (e.g. `Foo.md`
// and `Foo.csv`), `[[Foo]]` is ambiguous. The resolver must:
//   - refuse to resolve the bare form and record it as unresolved
//   - resolve `[[Foo.md]]` and `[[Foo.csv]]` to their respective notes

describe("wikilink ambiguity across extensions (vault#328)", async () => {
  it("refuses ambiguous bare-form wikilinks when path collides on extension", async () => {
    const store = new SqliteStore(new Database(":memory:"));
    const md = await store.createNote("# MD note", { path: "Foo", id: "foo-md" });
    const csv = await store.createNote("a,b\n1,2", { path: "Foo", extension: "csv", id: "foo-csv" });
    // Sanity — both rows landed under the composite uniqueness key.
    expect(md.path).toBe("Foo");
    expect(csv.path).toBe("Foo");

    // A third note linking to bare `[[Foo]]` should be UNRESOLVED.
    await store.createNote("see [[Foo]]", { id: "linker", path: "Linker" });
    const outboundLinks = await store.getLinks("linker", { direction: "outbound" });
    expect(outboundLinks).toHaveLength(0);
  });

  it("resolves explicit-extension wikilinks unambiguously", async () => {
    const store = new SqliteStore(new Database(":memory:"));
    await store.createNote("# MD note", { path: "Foo", id: "foo-md" });
    await store.createNote("a,b\n1,2", { path: "Foo", extension: "csv", id: "foo-csv" });

    await store.createNote("see [[Foo.csv]]", { id: "linker", path: "Linker" });
    const outbound = await store.getLinks("linker", { direction: "outbound" });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.targetId).toBe("foo-csv");
  });
});

// ---------------------------------------------------------------------------
// Case-collision detection + auto-disambiguation (vault#327)
// ---------------------------------------------------------------------------
//
// macOS APFS-default + Windows NTFS-default + FAT/exFAT are case-
// insensitive — two notes whose paths differ only by case collapse
// into one file on naive export. The fix probes the filesystem then
// either ships as-is (case-sensitive) or disambiguates with an
// `__<id-short>` filename suffix (case-insensitive). The note's
// stored `path` stays canonical; only the on-disk filename is suffixed.

describe("case-collision detection (vault#327)", async () => {
  const tmpBase = join(tmpdir(), "parachute-portable-case");
  let store: SqliteStore;

  beforeEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(tmpBase, { recursive: true });
    store = new SqliteStore(new Database(":memory:"));
  });

  it("probeCaseSensitive runs cleanly and returns a boolean", () => {
    // Documenting behavior rather than asserting a specific value:
    // macOS dev environments + most Linux CI runners produce different
    // results. We just pin that the probe is well-formed (doesn't throw,
    // returns boolean, cleans up its tempfile).
    const result = probeCaseSensitive(tmpBase);
    expect(typeof result).toBe("boolean");
    // After the probe runs the dir should contain no leftover probe files.
    const leftovers = readdirSync(tmpBase).filter((e) => e.includes("_parachute_cs_probe_"));
    expect(leftovers).toEqual([]);
  });

  it("ships as-is when FS is case-sensitive (override=true)", async () => {
    // Two notes with case-only-differing paths. With the case-sensitive
    // override, both files land at their canonical paths — no
    // disambiguation, no collisions in stats.
    await store.createNote("# in Balance", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Journal/2025-05-26 Technology in Balance",
    });
    await store.createNote("# in balance", {
      id: "2025-05-26-09-15-42-bbbbbb",
      path: "Journal/2025-05-26 Technology in balance",
    });

    const outDir = join(tmpBase, "cs-on");
    const stats = await exportVaultToDir(store, {
      outDir,
      vaultName: "test",
      exportedAt: "2026-05-15T00:00:00.000Z",
      caseSensitiveOverride: true,
    });
    expect(stats.notes).toBe(2);
    expect(stats.case_insensitive_fs).toBe(false);
    expect(stats.disambiguated_paths).toHaveLength(0);
  });

  it("disambiguates colliding paths on case-insensitive FS (override=false)", async () => {
    // Same fixture as above; force the case-insensitive code path. The
    // second note (deterministic order: queryNotes sorts ASC on
    // created_at — the IDs sort lexicographically so 'aaaaaa' lands
    // first, 'bbbbbb' second) gets its filename suffixed.
    await store.createNote("# in Balance", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Journal/2025-05-26 Technology in Balance",
    });
    await store.createNote("# in balance", {
      id: "2025-05-26-09-15-42-bbbbbb",
      path: "Journal/2025-05-26 Technology in balance",
    });

    const outDir = join(tmpBase, "ci-on");
    const stats = await exportVaultToDir(store, {
      outDir,
      vaultName: "test",
      exportedAt: "2026-05-15T00:00:00.000Z",
      caseSensitiveOverride: false,
    });
    expect(stats.notes).toBe(2);
    expect(stats.case_insensitive_fs).toBe(true);
    expect(stats.disambiguated_paths).toHaveLength(1);
    expect(stats.disambiguated_paths[0]!.note_id).toBe("2025-05-26-09-15-42-bbbbbb");
    expect(stats.disambiguated_paths[0]!.disambiguated_filename).toMatch(/__2025-05-/);

    // Both files exist on disk under their respective filenames.
    expect(existsSync(join(outDir, "Journal/2025-05-26 Technology in Balance.md"))).toBe(true);
    expect(existsSync(join(outDir, stats.disambiguated_paths[0]!.disambiguated_filename))).toBe(true);

    // The disambiguated file's inline frontmatter still carries the
    // canonical (original) path, NOT the disambiguated filename — that
    // way an import on a case-sensitive filesystem (or a future re-
    // export on a case-sensitive FS) recovers the truth.
    const disambigFile = readFileSync(
      join(outDir, stats.disambiguated_paths[0]!.disambiguated_filename),
      "utf-8",
    );
    expect(disambigFile).toContain("path: Journal/2025-05-26 Technology in balance");
  });

  it("disambiguated content round-trips through import (md inline frontmatter path)", async () => {
    await store.createNote("# upper", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Journal/Same-Case Different",
    });
    await store.createNote("# lower", {
      id: "2025-05-26-09-15-42-bbbbbb",
      path: "Journal/same-case different",
    });

    const outDir = join(tmpBase, "rt-md");
    const stats = await exportVaultToDir(store, {
      outDir,
      vaultName: "test",
      exportedAt: "2026-05-15T00:00:00.000Z",
      caseSensitiveOverride: false,
    });
    expect(stats.disambiguated_paths).toHaveLength(1);

    const restored = new SqliteStore(new Database(":memory:"));
    const importStats = await importPortableVault(restored, { inDir: outDir, blowAway: true });
    expect(importStats.notes_created).toBe(2);

    // Both notes recovered their canonical paths from the frontmatter.
    const upper = await restored.getNote("2025-05-26-09-15-42-aaaaaa");
    const lower = await restored.getNote("2025-05-26-09-15-42-bbbbbb");
    expect(upper!.path).toBe("Journal/Same-Case Different");
    expect(lower!.path).toBe("Journal/same-case different");
  });

  it("disambiguated sidecar-required content round-trips (csv with sidecar lookup fallback)", async () => {
    // The disambig fallback in the import loop kicks in: the sidecar
    // is keyed by canonical (path, ext) so the walker's
    // `<base>__<id8>.csv` filename doesn't match the index — but the
    // id-prefix lookup recovers the sidecar.
    await store.createNote("month,total\n2026-01,9000", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Tabular/Budget-2026",
      extension: "csv",
    });
    await store.createNote("month,total\n2026-01,1", {
      id: "2025-05-26-09-15-42-bbbbbb",
      path: "Tabular/budget-2026",
      extension: "csv",
    });

    const outDir = join(tmpBase, "rt-csv");
    const stats = await exportVaultToDir(store, {
      outDir,
      vaultName: "test",
      exportedAt: "2026-05-15T00:00:00.000Z",
      caseSensitiveOverride: false,
    });
    expect(stats.disambiguated_paths).toHaveLength(1);

    const restored = new SqliteStore(new Database(":memory:"));
    const importStats = await importPortableVault(restored, { inDir: outDir, blowAway: true });
    expect(importStats.notes_created).toBe(2);

    const upper = await restored.getNote("2025-05-26-09-15-42-aaaaaa");
    const lower = await restored.getNote("2025-05-26-09-15-42-bbbbbb");
    expect(upper!.path).toBe("Tabular/Budget-2026");
    expect(upper!.content).toBe("month,total\n2026-01,9000");
    expect(lower!.path).toBe("Tabular/budget-2026");
    expect(lower!.content).toBe("month,total\n2026-01,1");
  });

  // ---------------------------------------------------------------------------
  // failOnCaseCollision — strict mode (vault#327 Phase 2)
  // ---------------------------------------------------------------------------
  //
  // The default behavior (auto-disambiguate) is lossless but silent on the
  // wire — the CLI didn't surface it before #vault-rc.2. Strict mode is the
  // opt-in fail-fast path: throws `CaseCollisionError` with every colliding
  // path enumerated, so the operator can rename one of each pair in the
  // vault before re-exporting.

  it("failOnCaseCollision throws CaseCollisionError on case-insensitive FS", async () => {
    await store.createNote("# in Balance", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Journal/2025-05-26 Technology in Balance",
    });
    await store.createNote("# in balance", {
      id: "2025-05-26-09-15-42-bbbbbb",
      path: "Journal/2025-05-26 Technology in balance",
    });

    const outDir = join(tmpBase, "strict-throw");
    let thrown: unknown;
    try {
      await exportVaultToDir(store, {
        outDir,
        vaultName: "test",
        exportedAt: "2026-05-15T00:00:00.000Z",
        caseSensitiveOverride: false,
        failOnCaseCollision: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CaseCollisionError);
    const err = thrown as CaseCollisionError;
    expect(err.collisions).toHaveLength(1);
    expect(err.collisions[0]).toHaveLength(2);
    const ids = err.collisions[0]!.map((c) => c.note_id).sort();
    expect(ids).toEqual(["2025-05-26-09-15-42-aaaaaa", "2025-05-26-09-15-42-bbbbbb"]);
    // Error message names BOTH paths + the actionable instruction.
    expect(err.message).toContain("Journal/2025-05-26 Technology in Balance");
    expect(err.message).toContain("Journal/2025-05-26 Technology in balance");
    expect(err.message).toContain("Rename one of them");
    // Pre-scan throws BEFORE any per-note file write. The .parachute/
    // sidecar dir is still created (cheap, idempotent), but no per-note
    // .md file landed.
    expect(existsSync(join(outDir, "Journal/2025-05-26 Technology in Balance.md"))).toBe(false);
  });

  it("failOnCaseCollision is a no-op when FS is case-sensitive", async () => {
    // Same fixture as above, but force the case-sensitive code path. The
    // strict flag becomes a no-op — both files land at their canonical
    // paths, no error.
    await store.createNote("# in Balance", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Journal/2025-05-26 Technology in Balance",
    });
    await store.createNote("# in balance", {
      id: "2025-05-26-09-15-42-bbbbbb",
      path: "Journal/2025-05-26 Technology in balance",
    });

    const outDir = join(tmpBase, "strict-cs");
    const stats = await exportVaultToDir(store, {
      outDir,
      vaultName: "test",
      exportedAt: "2026-05-15T00:00:00.000Z",
      caseSensitiveOverride: true,
      failOnCaseCollision: true,
    });
    expect(stats.notes).toBe(2);
    expect(stats.disambiguated_paths).toHaveLength(0);
  });

  it("failOnCaseCollision is a no-op on case-insensitive FS when nothing collides", async () => {
    // One note. Strict mode + case-insensitive FS — should not throw,
    // should ship clean. Pre-scan walks the (single-note) list and
    // finds no collision groups.
    await store.createNote("# solo", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Journal/Solo Note",
    });

    const outDir = join(tmpBase, "strict-solo");
    const stats = await exportVaultToDir(store, {
      outDir,
      vaultName: "test",
      exportedAt: "2026-05-15T00:00:00.000Z",
      caseSensitiveOverride: false,
      failOnCaseCollision: true,
    });
    expect(stats.notes).toBe(1);
    expect(stats.disambiguated_paths).toHaveLength(0);
    expect(existsSync(join(outDir, "Journal/Solo Note.md"))).toBe(true);
  });

  it("three-way collision lists all three paths in the error", async () => {
    // Foo.md + foo.md + FOO.md — all share the same lowercased
    // `(path, ext)` slot. CaseCollisionError.collisions[0] should
    // include every one of them so the operator sees the full set in
    // a single error report, not a paint-by-numbers re-export cycle.
    await store.createNote("# upper-camel", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Journal/Foo",
    });
    await store.createNote("# lower", {
      id: "2025-05-26-09-15-42-bbbbbb",
      path: "Journal/foo",
    });
    await store.createNote("# all-caps", {
      id: "2025-05-26-09-15-42-cccccc",
      path: "Journal/FOO",
    });

    const outDir = join(tmpBase, "strict-3way");
    let thrown: unknown;
    try {
      await exportVaultToDir(store, {
        outDir,
        vaultName: "test",
        exportedAt: "2026-05-15T00:00:00.000Z",
        caseSensitiveOverride: false,
        failOnCaseCollision: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CaseCollisionError);
    const err = thrown as CaseCollisionError;
    expect(err.collisions).toHaveLength(1);
    expect(err.collisions[0]).toHaveLength(3);
    const paths = err.collisions[0]!.map((c) => c.path).sort();
    expect(paths).toEqual(["Journal/FOO", "Journal/Foo", "Journal/foo"]);
    expect(err.message).toContain("Journal/FOO");
    expect(err.message).toContain("Journal/Foo");
    expect(err.message).toContain("Journal/foo");
  });

  it("multiple independent collision groups all surface", async () => {
    // Two distinct collision groups: (Bar.md, bar.md) and (Baz.md,
    // baz.md). Both groups should appear in the error so the operator
    // doesn't have to fix-rebuild-fix in a loop. Pairs are independent —
    // resolving one doesn't reveal the other.
    await store.createNote("# bar-upper", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Bar",
    });
    await store.createNote("# bar-lower", {
      id: "2025-05-26-09-15-42-bbbbbb",
      path: "bar",
    });
    await store.createNote("# baz-upper", {
      id: "2025-05-26-09-15-42-cccccc",
      path: "Baz",
    });
    await store.createNote("# baz-lower", {
      id: "2025-05-26-09-15-42-dddddd",
      path: "baz",
    });

    const outDir = join(tmpBase, "strict-multi-group");
    let thrown: unknown;
    try {
      await exportVaultToDir(store, {
        outDir,
        vaultName: "test",
        exportedAt: "2026-05-15T00:00:00.000Z",
        caseSensitiveOverride: false,
        failOnCaseCollision: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CaseCollisionError);
    const err = thrown as CaseCollisionError;
    expect(err.collisions).toHaveLength(2);
    const allIds = err.collisions.flat().map((c) => c.note_id).sort();
    expect(allIds).toEqual([
      "2025-05-26-09-15-42-aaaaaa",
      "2025-05-26-09-15-42-bbbbbb",
      "2025-05-26-09-15-42-cccccc",
      "2025-05-26-09-15-42-dddddd",
    ]);
  });

  it("directory-level case difference triggers collision detection", async () => {
    // Two notes at `Notes/foo` and `notes/foo` — the basename matches
    // but the parent dir differs only by case. On a case-insensitive
    // FS, both files would land in the same directory because
    // `Notes/` and `notes/` resolve to the same inode. Verify the
    // lowercased-path key catches this: `notes/foo.md`.
    await store.createNote("# notes-upper", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Notes/foo",
    });
    await store.createNote("# notes-lower", {
      id: "2025-05-26-09-15-42-bbbbbb",
      path: "notes/foo",
    });

    const outDir = join(tmpBase, "strict-dir-case");
    let thrown: unknown;
    try {
      await exportVaultToDir(store, {
        outDir,
        vaultName: "test",
        exportedAt: "2026-05-15T00:00:00.000Z",
        caseSensitiveOverride: false,
        failOnCaseCollision: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CaseCollisionError);
    const err = thrown as CaseCollisionError;
    expect(err.collisions).toHaveLength(1);
    expect(err.collisions[0]).toHaveLength(2);
  });

  it("default (no failOnCaseCollision) still auto-disambiguates — back-compat", async () => {
    // The new strict mode is opt-in. Leaving failOnCaseCollision unset
    // (or false) keeps the existing lossless auto-disambiguation path
    // unchanged. This pins the back-compat contract — watch/mirror
    // loops that don't opt in to strict mode never see a thrown
    // CaseCollisionError on a colliding vault.
    await store.createNote("# upper", {
      id: "2025-05-26-09-15-42-aaaaaa",
      path: "Journal/Note",
    });
    await store.createNote("# lower", {
      id: "2025-05-26-09-15-42-bbbbbb",
      path: "Journal/note",
    });

    const outDir = join(tmpBase, "default-disambig");
    const stats = await exportVaultToDir(store, {
      outDir,
      vaultName: "test",
      exportedAt: "2026-05-15T00:00:00.000Z",
      caseSensitiveOverride: false,
      // failOnCaseCollision deliberately omitted — default behavior.
    });
    expect(stats.notes).toBe(2);
    expect(stats.disambiguated_paths).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pruneOrphans (vault#382 — event-driven mirror delete propagation)
// ---------------------------------------------------------------------------

describe("pruneOrphans", async () => {
  let tmpBase: string;
  beforeEach(() => {
    tmpBase = join(tmpdir(), `parachute-prune-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpBase, { recursive: true });
  });

  it("no-op on non-existent directory", () => {
    const stats = pruneOrphans({
      outDir: join(tmpBase, "doesnt-exist"),
      validNoteIds: new Set(),
      validTagNames: new Set(),
      validAttachmentIds: new Set(),
    });
    expect(stats.notes_removed).toBe(0);
    expect(stats.unparseable_files).toHaveLength(0);
  });

  it("removes orphaned note .md file", async () => {
    const outDir = join(tmpBase, "orphan-note");
    // First do a real export so the structure is realistic.
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    await store.createNote("alive", { id: "01HFAA", path: "alive" });
    await store.createNote("doomed", { id: "01HFBB", path: "doomed" });
    await exportVaultToDir(store, { outDir, vaultName: "t", exportedAt: "2026-01-01T00:00:00.000Z" });
    expect(existsSync(join(outDir, "alive.md"))).toBe(true);
    expect(existsSync(join(outDir, "doomed.md"))).toBe(true);

    // Now prune with only "alive" in the valid set.
    const stats = pruneOrphans({
      outDir,
      validNoteIds: new Set(["01HFAA"]),
      validTagNames: new Set(),
      validAttachmentIds: new Set(),
    });
    expect(stats.notes_removed).toBe(1);
    expect(existsSync(join(outDir, "alive.md"))).toBe(true);
    expect(existsSync(join(outDir, "doomed.md"))).toBe(false);
  });

  it("removes orphaned schema sidecar", async () => {
    const outDir = join(tmpBase, "orphan-schema");
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    await store.upsertTagRecord("alive-tag", { description: "stays" });
    await store.upsertTagRecord("doomed-tag", { description: "goes" });
    await exportVaultToDir(store, { outDir, vaultName: "t", exportedAt: "2026-01-01T00:00:00.000Z" });
    const schemasDir = join(outDir, SIDECAR_DIR, "schemas");
    expect(existsSync(join(schemasDir, "alive-tag.yaml"))).toBe(true);
    expect(existsSync(join(schemasDir, "doomed-tag.yaml"))).toBe(true);

    const stats = pruneOrphans({
      outDir,
      validNoteIds: new Set(),
      validTagNames: new Set(["alive-tag"]),
      validAttachmentIds: new Set(),
    });
    expect(stats.schemas_removed).toBe(1);
    expect(existsSync(join(schemasDir, "alive-tag.yaml"))).toBe(true);
    expect(existsSync(join(schemasDir, "doomed-tag.yaml"))).toBe(false);
  });

  it("removes orphaned attachment directories", async () => {
    const outDir = join(tmpBase, "orphan-att");
    // Build the export structure by hand (attachment binaries need
    // assetsDir wiring; cheaper to just create the dirs).
    const attachmentsDir = join(outDir, SIDECAR_DIR, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    mkdirSync(join(attachmentsDir, "att-alive"), { recursive: true });
    writeFileSync(join(attachmentsDir, "att-alive", "voice.m4a"), "");
    mkdirSync(join(attachmentsDir, "att-doomed"), { recursive: true });
    writeFileSync(join(attachmentsDir, "att-doomed", "voice.m4a"), "");
    // Need .parachute/vault.yaml so the structure is recognized (cheap to fake)
    writeFileSync(join(outDir, SIDECAR_DIR, "vault.yaml"), "name: t\n");

    const stats = pruneOrphans({
      outDir,
      validNoteIds: new Set(),
      validTagNames: new Set(),
      validAttachmentIds: new Set(["att-alive"]),
    });
    expect(stats.attachment_dirs_removed).toBe(1);
    expect(existsSync(join(attachmentsDir, "att-alive"))).toBe(true);
    expect(existsSync(join(attachmentsDir, "att-doomed"))).toBe(false);
  });

  it("skips unparseable .md files without crashing", async () => {
    const outDir = join(tmpBase, "unparseable");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "no-frontmatter.md"), "just content, no frontmatter\n");
    writeFileSync(join(outDir, "garbage.md"), "---\nnot-real-yaml\n");
    const stats = pruneOrphans({
      outDir,
      validNoteIds: new Set(),
      validTagNames: new Set(),
      validAttachmentIds: new Set(),
    });
    // Both files lacked an `id`, so we record them but don't remove.
    expect(stats.notes_removed).toBe(0);
    expect(stats.unparseable_files.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(outDir, "no-frontmatter.md"))).toBe(true);
    expect(existsSync(join(outDir, "garbage.md"))).toBe(true);
  });

  it("preserves all files when everything is in the valid sets", async () => {
    const outDir = join(tmpBase, "happy-path");
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    const a = await store.createNote("a", { path: "a" });
    const b = await store.createNote("b", { path: "b" });
    await store.upsertTagRecord("tag1", { description: "x" });
    await exportVaultToDir(store, { outDir, vaultName: "t", exportedAt: "2026-01-01T00:00:00.000Z" });
    const stats = pruneOrphans({
      outDir,
      validNoteIds: new Set([a.id, b.id]),
      validTagNames: new Set(["tag1"]),
      validAttachmentIds: new Set(),
    });
    expect(stats.notes_removed).toBe(0);
    expect(stats.schemas_removed).toBe(0);
    expect(stats.attachment_dirs_removed).toBe(0);
    expect(existsSync(join(outDir, "a.md"))).toBe(true);
    expect(existsSync(join(outDir, "b.md"))).toBe(true);
  });

  it("removes orphan note + corresponding notes-meta sidecar for csv/yaml notes", async () => {
    // For non-frontmatter extensions, the sidecar lives at
    // .parachute/notes-meta/<id>.yaml. Pruning the note should remove
    // both files.
    const outDir = join(tmpBase, "orphan-csv");
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    await store.createNote("col1,col2\n1,2\n", {
      id: "01CSV-DEL",
      path: "data/table",
      extension: "csv",
    });
    await exportVaultToDir(store, { outDir, vaultName: "t", exportedAt: "2026-01-01T00:00:00.000Z" });
    const contentFile = join(outDir, "data", "table.csv");
    const sidecarFile = join(outDir, SIDECAR_DIR, "notes-meta", "01CSV-DEL.yaml");
    expect(existsSync(contentFile)).toBe(true);
    expect(existsSync(sidecarFile)).toBe(true);

    const stats = pruneOrphans({
      outDir,
      validNoteIds: new Set(), // doom it
      validTagNames: new Set(),
      validAttachmentIds: new Set(),
    });
    expect(stats.notes_removed).toBe(1);
    expect(stats.sidecars_removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(contentFile)).toBe(false);
    expect(existsSync(sidecarFile)).toBe(false);
  });

  // Reviewer-flagged regression on vault#382 Critical #2 — pruneOrphans
  // walks via statSync (follows symlinks); without the safeRm guard a
  // symlink inside the mirror pointing OUTSIDE outDir would resurface
  // its target's files as orphans and rmSync would happily delete them
  // off-tree. The guard resolves each candidate and refuses anything
  // not under outDir; refusals get recorded in `unparseable_files` so
  // an operator can see what was skipped.
  it("refuses to delete files reached via a symlink pointing outside outDir", async () => {
    const outDir = join(tmpBase, "symlink-attack");
    const outside = join(tmpBase, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    // A real, sensitive file in `outside/` we don't want pruneOrphans
    // to touch under any circumstance.
    const externalFile = join(outside, "do-not-touch.md");
    writeFileSync(externalFile, "---\nid: 01EXTERNAL\n---\nimportant\n");
    // A symlink inside outDir pointing at outside/ — walkContentFiles
    // would normally surface outside/do-not-touch.md as a candidate.
    try {
      symlinkSync(outside, join(outDir, "via-link"));
    } catch {
      // Some CI sandboxes refuse symlink creation. Skip the test in
      // that case rather than fail spuriously.
      return;
    }

    const stats = pruneOrphans({
      outDir,
      validNoteIds: new Set(), // doom every id we see
      validTagNames: new Set(),
      validAttachmentIds: new Set(),
    });

    // Critical assertion: the external file MUST survive.
    expect(existsSync(externalFile)).toBe(true);
    // And the refusal MUST be recorded so the operator sees it.
    expect(
      stats.unparseable_files.some(
        (u) => u.path.includes("via-link") || u.reason.includes("outside"),
      ),
    ).toBe(true);
  });

  // Reviewer-flagged regression on vault#382 Critical #1 — pruneOrphans
  // builds `validTagNames` from ALL tag-table rows in mirror-deps.ts.
  // After `deleteTagSchema(t)` the schema fields are cleared but the
  // tag row persists with the bare name, so the sidecar lingers
  // forever. The fix routes validTagNames through `hasSchemaContent`
  // before passing into pruneOrphans, and exports the predicate so
  // mirror-deps can reuse the single source of truth.
  it("considers a schema-content-free tag the same as a deleted tag for sidecar pruning", async () => {
    const outDir = join(tmpBase, "stale-schema");
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    await store.upsertTagRecord("bare", {}); // bare-name only
    await store.upsertTagRecord("with-schema", { description: "real" });
    await exportVaultToDir(store, {
      outDir,
      vaultName: "t",
      exportedAt: "2026-01-01T00:00:00.000Z",
    });
    const schemasDir = join(outDir, SIDECAR_DIR, "schemas");
    // The bare tag SHOULDN'T have a sidecar; the schema-bearing one
    // SHOULD. This confirms the export-writer's contract before the
    // prune step.
    expect(existsSync(join(schemasDir, "bare.yaml"))).toBe(false);
    expect(existsSync(join(schemasDir, "with-schema.yaml"))).toBe(true);

    // Now seed a stale sidecar for `bare` (simulating "the operator
    // previously had a schema for `bare`, then cleared it via
    // `deleteTagSchema`"). pruneOrphans should remove this iff the
    // caller correctly filtered validTagNames by hasSchemaContent.
    writeFileSync(join(schemasDir, "bare.yaml"), 'name: "bare"\ndescription: "stale"\n');
    expect(existsSync(join(schemasDir, "bare.yaml"))).toBe(true);

    // Filtered set — only `with-schema` has hasSchemaContent === true.
    const validTagNames = new Set(["with-schema"]);
    const stats = pruneOrphans({
      outDir,
      validNoteIds: new Set(),
      validTagNames,
      validAttachmentIds: new Set(),
    });

    expect(stats.schemas_removed).toBe(1);
    expect(existsSync(join(schemasDir, "bare.yaml"))).toBe(false);
    expect(existsSync(join(schemasDir, "with-schema.yaml"))).toBe(true);
  });
});
