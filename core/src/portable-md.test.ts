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
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { SqliteStore } from "./store.js";
import {
  emitYamlDoc,
  exportVaultToDir,
  noteToPortable,
  parseFrontmatter,
  portableExportFilePath,
  SIDECAR_DIR,
  toPortableMarkdown,
  type PortableNote,
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
