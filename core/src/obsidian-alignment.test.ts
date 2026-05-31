/**
 * Obsidian-importer alignment fixtures (vault#423).
 *
 * These assert the vault/CLI parser + write adapter against the SHARED
 * canonical fixture set in the alignment contract. The parachute-surface
 * web parser asserts the SAME fixtures (its own test runner) so both
 * importers produce identical parsed results. Do NOT change expected
 * values here without changing the contract + the web side in lockstep.
 *
 * Fixture inputs are inline strings (`srcPath` + content). Parse-tier
 * fixtures write the file to a temp dir and parse via `parseObsidianFile`
 * — the same code the CLI runs. Write-tier fixtures (FX-ID-COLLISION,
 * FX-SAME-STEM-COLLISION, FX-CREATED-AT write assertion) exercise the
 * real `importObsidianNotes` adapter against an in-memory SqliteStore.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import {
  parseObsidianFile,
  importObsidianNotes,
  isMarkdownExtension,
  isExcludedPath,
  type ObsidianNote,
} from "./obsidian.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Parse-tier helper: write `content` at `srcPath` under a fresh temp root,
// parse it via the real `parseObsidianFile`, and return the ObsidianNote.
// ---------------------------------------------------------------------------

const PARSE_ROOT = join(tmpdir(), "parachute-align-parse");

function parseFixture(srcPath: string, content: string): ObsidianNote {
  rmSync(PARSE_ROOT, { recursive: true, force: true });
  const full = join(PARSE_ROOT, srcPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return parseObsidianFile(full, PARSE_ROOT);
}

/** Sorted tag array, for stable comparison against the contract's
 *  "(sorted)" expected tag lists. */
function tags(note: ObsidianNote): string[] {
  return [...note.tags].sort();
}

describe("alignment: parse tier", () => {
  it("FX-FENCE-BOM — strips BOM then parses frontmatter", () => {
    const n = parseFixture("Note.md", "﻿---\nid: bom1\ntags: [a]\n---\nhello");
    expect(n.path).toBe("Note");
    expect(tags(n)).toEqual(["a"]);
    expect(n.id).toBe("bom1");
    expect(n.createdAt).toBeUndefined();
    expect(n.content).toBe("hello");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-FENCE-FOURDASH — ---- body line is not a close fence", () => {
    const n = parseFixture("Doc.md", "---\nid: x9\n---\nbefore\n----\nafter");
    expect(n.path).toBe("Doc");
    expect(tags(n)).toEqual([]);
    expect(n.id).toBe("x9");
    expect(n.content).toBe("before\n----\nafter");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-FENCE-FOURDASH-OPEN — ---- after open, no real close → whole file is body", () => {
    const n = parseFixture("D2.md", "---\nid: y\n----\nbody text");
    expect(n.path).toBe("D2");
    expect(tags(n)).toEqual([]);
    expect(n.id).toBeUndefined();
    expect(n.content).toBe("---\nid: y\n----\nbody text");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-FENCE-UNCLOSED — open never closed → whole file is body", () => {
    const n = parseFixture("U.md", "---\nid: z\nbody no close");
    expect(n.path).toBe("U");
    expect(tags(n)).toEqual([]);
    expect(n.id).toBeUndefined();
    expect(n.content).toBe("---\nid: z\nbody no close");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-CODE-TAG — #tag inside fenced + inline code is dropped", () => {
    const content = "#realtag at top\n\n`#inlinenope`\n\n```\n#fencednope\n```\n";
    const n = parseFixture("C.md", content);
    expect(n.path).toBe("C");
    expect(tags(n)).toEqual(["realtag"]);
    expect(n.content).toBe(content);
    expect(n.frontmatter).toEqual({});
  });

  it("FX-NUMERIC-TAG — #2024 is not a tag, #q3/#v2 are", () => {
    const n = parseFixture("N.md", "plan #2024 and #q3 and #v2 done");
    expect(n.path).toBe("N");
    expect(tags(n)).toEqual(["q3", "v2"]);
    expect(n.frontmatter).toEqual({});
  });

  it("FX-HIER-TAG — hierarchical inline tag keeps the slash", () => {
    const n = parseFixture("H.md", "see #area/subarea here");
    expect(n.path).toBe("H");
    expect(tags(n)).toEqual(["area/subarea"]);
    expect(n.frontmatter).toEqual({});
  });

  it("FX-FM-TAGS-VALIDATE — slug-validate + normalize frontmatter tags", () => {
    const n = parseFixture(
      "T.md",
      '---\ntags: [Foo, "bad tag!", 42, true, ok-1, "#hash"]\n---\nbody',
    );
    expect(n.path).toBe("T");
    expect(tags(n)).toEqual(["42", "foo", "hash", "ok-1", "true"]);
    expect(n.content).toBe("body");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-INLINE-ARRAY — quote-aware inline-array split (2 items, not 3)", () => {
    const n = parseFixture("IA.md", '---\nkeywords: ["a, b", c]\n---\nx');
    expect(n.path).toBe("IA");
    expect(tags(n)).toEqual([]);
    expect(n.content).toBe("x");
    expect(n.frontmatter).toEqual({ keywords: ["a, b", "c"] });
  });

  it("FX-MARKDOWN-EXT — .markdown ingest + classifier", () => {
    const n = parseFixture("Folder/Note.markdown", "---\nid: m1\n---\nbody");
    expect(n.path).toBe("Folder/Note");
    expect(tags(n)).toEqual([]);
    expect(n.id).toBe("m1");
    expect(n.content).toBe("body");
    expect(n.frontmatter).toEqual({});

    expect(isMarkdownExtension("x.markdown")).toBe(true);
    expect(isMarkdownExtension("x.md")).toBe(true);
    expect(isMarkdownExtension("x.mdx")).toBe(false);
  });

  it("FX-PATH-OVERRIDE — frontmatter path: wins, not in metadata", () => {
    const n = parseFixture("deep/orig.md", "---\npath: Custom/Place\n---\nbody");
    expect(n.path).toBe("Custom/Place");
    expect(tags(n)).toEqual([]);
    expect(n.id).toBeUndefined();
    expect(n.content).toBe("body");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-PATH-OVERRIDE-EXT — frontmatter path: override is extension-stripped", () => {
    // Pins contract §1.8: a `path:` override ending in .md/.markdown has
    // its extension stripped (matches the web side). A real web-side
    // divergence here stayed green because nothing pinned the invariant.
    const n = parseFixture("deep/orig.md", "---\npath: My/Note.md\n---\nbody");
    expect(n.path).toBe("My/Note");
    expect(tags(n)).toEqual([]);
    expect(n.id).toBeUndefined();
    expect(n.content).toBe("body");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-PATH-NORMALIZE — backslash + collapse + case-preserve", () => {
    // Frontmatter path value: \Win\Path\\x\  (double-quoted in YAML).
    const n = parseFixture("X.md", '---\npath: "\\\\Win\\\\Path\\\\\\\\x\\\\"\n---\nb');
    expect(n.path).toBe("Win/Path/x");
    expect(n.content).toBe("b");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-CREATED-AT — created_at + updated_at hoisted verbatim, not in metadata", () => {
    const n = parseFixture(
      "CA.md",
      "---\nid: t1\ncreated_at: 2024-05-01T10:00:00Z\nupdated_at: 2024-06-01T12:00:00Z\n---\nbody",
    );
    expect(n.path).toBe("CA");
    expect(n.id).toBe("t1");
    expect(n.createdAt).toBe("2024-05-01T10:00:00Z");
    expect(n.updatedAt).toBe("2024-06-01T12:00:00Z");
    expect(n.content).toBe("body");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-CREATED-AT-CAMEL — camelCase createdAt fallback", () => {
    const n = parseFixture("CC.md", "---\ncreatedAt: 2024-05-01T10:00:00Z\n---\nx");
    expect(n.path).toBe("CC");
    expect(n.createdAt).toBe("2024-05-01T10:00:00Z");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-NO-ID — id absent → field omitted", () => {
    const n = parseFixture("NI.md", "---\ntitle: Hello\n---\nbody");
    expect(n.path).toBe("NI");
    expect(n.id).toBeUndefined();
    expect(tags(n)).toEqual([]);
    expect(n.content).toBe("body");
    expect(n.frontmatter).toEqual({ title: "Hello" });
  });

  it("FX-DOTDIR-EXCLUDE — intake exclusion classifier", () => {
    expect(isExcludedPath(".obsidian/app.json")).toBe(true);
    expect(isExcludedPath(".trash/x.md")).toBe(true);
    expect(isExcludedPath(".git/config")).toBe(true);
    expect(isExcludedPath(".parachute/vault.yaml")).toBe(true);
    expect(isExcludedPath("__MACOSX/x")).toBe(true);
    expect(isExcludedPath("node_modules/y/z.md")).toBe(true);
    expect(isExcludedPath(".DS_Store")).toBe(true);
    expect(isExcludedPath("sub/.hidden.md")).toBe(true);
    expect(isExcludedPath("Notes/a.md")).toBe(false);
    expect(isExcludedPath("Notes/Sub/b.markdown")).toBe(false);
  });

  it("FX-WIKILINK-PASSTHROUGH — wikilinks untouched, inline #tag still extracted", () => {
    const content = "See [[Other]] and ![[Embed]] and #tag";
    const n = parseFixture("WL.md", content);
    expect(n.content).toContain("[[Other]]");
    expect(n.content).toContain("![[Embed]]");
    expect(tags(n)).toEqual(["tag"]);
    expect(n.frontmatter).toEqual({});
  });

  it("FX-CRLF — CRLF frontmatter", () => {
    const n = parseFixture("CR.md", "---\r\nid: cr1\r\ntags: [a]\r\n---\r\nbody");
    expect(n.path).toBe("CR");
    expect(n.id).toBe("cr1");
    expect(tags(n)).toEqual(["a"]);
    expect(n.content).toBe("body");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-DOTTED-KEY — dotted frontmatter key accepted, not confused with created_at", () => {
    const n = parseFixture("DK.md", "---\ncreated.at: 2024\nid: dk1\n---\nx");
    expect(n.path).toBe("DK");
    expect(n.id).toBe("dk1");
    expect(n.createdAt).toBeUndefined();
    expect(n.frontmatter).toEqual({ "created.at": 2024 });
    expect(n.content).toBe("x");
  });

  it("FX-COMMENT-LINE — comment inside frontmatter is skipped", () => {
    const n = parseFixture("CM.md", "---\n# a yaml comment\nid: cm1\n---\nbody");
    expect(n.path).toBe("CM");
    expect(n.id).toBe("cm1");
    expect(n.content).toBe("body");
    expect(n.frontmatter).toEqual({});
  });

  it("FX-NO-FRONTMATTER — plain markdown, inline tag only", () => {
    const content = "# Title\n\nbody with #tag";
    const n = parseFixture("P.md", content);
    expect(n.path).toBe("P");
    expect(n.id).toBeUndefined();
    expect(tags(n)).toEqual(["tag"]);
    expect(n.content).toBe(content);
    expect(n.frontmatter).toEqual({});
  });

  it("FX-METADATA-EXCLUSIONS — all seven hoisted keys excluded from metadata", () => {
    const n = parseFixture(
      "M.md",
      "---\nid: i\npath: P/Q\ntags: [t]\ncreated_at: 2024\ncreatedAt: 2024\nupdated_at: 2024\nupdatedAt: 2024\nextra: keep\n---\nb",
    );
    expect(n.path).toBe("P/Q");
    expect(n.id).toBe("i");
    expect(tags(n)).toEqual(["t"]);
    expect(n.createdAt).toBe("2024");
    expect(n.updatedAt).toBe("2024");
    expect(n.content).toBe("b");
    expect(n.frontmatter).toEqual({ extra: "keep" });
  });
});

// ---------------------------------------------------------------------------
// Write tier — real `importObsidianNotes` adapter against an in-memory Store.
// ---------------------------------------------------------------------------

describe("alignment: write tier (importObsidianNotes adapter)", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(new Database(":memory:"));
  });

  it("FX-CREATED-AT — timestamps pegged on the id path (not new Date())", async () => {
    const note = parseFixture(
      "CA.md",
      "---\nid: t1\ncreated_at: 2024-05-01T10:00:00Z\nupdated_at: 2024-06-01T12:00:00Z\n---\nbody",
    );
    const { imported, skipped } = await importObsidianNotes(store, [note]);
    expect(imported).toBe(1);
    expect(skipped).toBe(0);
    const stored = (await store.getNote("t1"))!;
    expect(stored).toBeTruthy();
    expect(stored.createdAt).toBe("2024-05-01T10:00:00Z");
    expect(stored.updatedAt).toBe("2024-06-01T12:00:00Z");
  });

  it("FX-CREATED-AT (no-id variant) — minted note still gets the frontmatter created_at", async () => {
    const note = parseFixture(
      "CA.md",
      "---\ncreated_at: 2024-05-01T10:00:00Z\nupdated_at: 2024-06-01T12:00:00Z\n---\nbody",
    );
    expect(note.id).toBeUndefined();
    const { imported } = await importObsidianNotes(store, [note]);
    expect(imported).toBe(1);
    const stored = (await store.getNoteByPath("CA"))!;
    expect(stored).toBeTruthy();
    expect(stored.createdAt).toBe("2024-05-01T10:00:00Z");
    expect(stored.updatedAt).toBe("2024-06-01T12:00:00Z");
  });

  it("FX-ID-COLLISION — id-upsert path guard skips, does not overwrite", async () => {
    // Pre-seed a note id=dup1 at path Existing/Place.
    await store.createNoteRaw("original body", { id: "dup1", path: "Existing/Place" });
    const before = (await store.getNote("dup1"))!;

    const note = parseFixture("anything.md", "---\nid: dup1\npath: Different/Place\n---\nnew body");
    expect(note.id).toBe("dup1");
    expect(note.path).toBe("Different/Place");

    const { imported, skipped } = await importObsidianNotes(store, [note]);
    expect(imported).toBe(0);
    expect(skipped).toBe(1);

    // The pre-existing note is untouched.
    const after = (await store.getNote("dup1"))!;
    expect(after.content).toBe("original body");
    expect(after.path).toBe("Existing/Place");
    expect(before.content).toBe(after.content);
    // No new note created at Different/Place.
    expect(await store.getNoteByPath("Different/Place")).toBeNull();
  });

  it("FX-SAME-STEM-COLLISION — Foo.md + Foo.markdown → 1 created, 1 skipped, no throw", async () => {
    const fooMd = parseFixture("Foo.md", "AAA");
    const fooMarkdown = parseFixture("Foo.markdown", "BBB");
    expect(fooMd.path).toBe("Foo");
    expect(fooMarkdown.path).toBe("Foo");

    // Sorted walk order: Foo.markdown sorts before Foo.md.
    const { imported, skipped } = await importObsidianNotes(store, [fooMarkdown, fooMd]);
    expect(imported).toBe(1);
    expect(skipped).toBe(1);

    const stored = (await store.getNoteByPath("Foo"))!;
    expect(stored).toBeTruthy();
    expect(["AAA", "BBB"]).toContain(stored.content);
  });

  it("intra-batch collision survives even when dedup is bypassed (try/catch isolation)", async () => {
    // Two no-id notes at the same path but built so the second slips past
    // the seenPaths guard would still be caught by the UNIQUE insert. Here
    // we exercise the belt-and-suspenders try/catch by forcing a duplicate
    // through with distinct objects (same normalized path).
    const a: ObsidianNote = { path: "Dup", content: "one", frontmatter: {}, tags: [] };
    const b: ObsidianNote = { path: "Dup", content: "two", frontmatter: {}, tags: [] };
    const { imported, skipped } = await importObsidianNotes(store, [a, b]);
    expect(imported).toBe(1);
    expect(skipped).toBe(1);
    expect((await store.getNoteByPath("Dup"))!.content).toBe("one");
  });

  it("id-upsert same-path updates content + replaces tags", async () => {
    await store.createNoteRaw("v1", { id: "up1", path: "Same/Place", tags: ["old"] });
    const note = parseFixture("x.md", "---\nid: up1\npath: Same/Place\ntags: [new]\n---\nv2");
    const { imported, skipped } = await importObsidianNotes(store, [note]);
    expect(imported).toBe(1);
    expect(skipped).toBe(0);
    const stored = (await store.getNote("up1"))!;
    expect(stored.content).toBe("v2");
    expect(stored.tags).toEqual(["new"]);
  });
});
