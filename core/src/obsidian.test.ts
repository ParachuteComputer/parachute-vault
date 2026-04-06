import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import {
  parseFrontmatter,
  extractInlineTags,
  parseObsidianVault,
  toObsidianMarkdown,
  exportFilePath,
} from "./obsidian.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("parses simple key-value pairs", () => {
    const raw = `---
title: My Note
author: Aaron
---
Note content here.`;

    const { frontmatter, content } = parseFrontmatter(raw);
    expect(frontmatter.title).toBe("My Note");
    expect(frontmatter.author).toBe("Aaron");
    expect(content).toBe("Note content here.");
  });

  it("parses array tags", () => {
    const raw = `---
tags:
  - daily
  - voice
---
Content`;

    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(["daily", "voice"]);
  });

  it("parses inline array tags", () => {
    const raw = `---
tags: [daily, voice, project]
---
Content`;

    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(["daily", "voice", "project"]);
  });

  it("parses numbers and booleans", () => {
    const raw = `---
priority: 3
draft: true
rating: 4.5
---
Content`;

    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.priority).toBe(3);
    expect(frontmatter.draft).toBe(true);
    expect(frontmatter.rating).toBe(4.5);
  });

  it("handles quoted strings", () => {
    const raw = `---
title: "My Title"
subtitle: 'Sub Title'
---
Content`;

    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.title).toBe("My Title");
    expect(frontmatter.subtitle).toBe("Sub Title");
  });

  it("returns empty frontmatter when none exists", () => {
    const raw = "Just content, no frontmatter.";
    const { frontmatter, content } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(content).toBe("Just content, no frontmatter.");
  });

  it("handles empty frontmatter block", () => {
    const raw = `---
---
Content`;

    const { frontmatter, content } = parseFrontmatter(raw);
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(content).toBe("Content");
  });

  it("treats empty values as empty strings, not arrays", () => {
    const raw = `---
description:
title: My Note
---
Content`;

    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.description).toBe("");
    expect(frontmatter.title).toBe("My Note");
  });

  it("does not match keys with spaces", () => {
    const raw = `---
valid-key: yes
another_key: also yes
---
Content`;

    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter["valid-key"]).toBe("yes");
    expect(frontmatter["another_key"]).toBe("also yes");
  });

  it("handles date values as strings", () => {
    const raw = `---
date: 2026-04-05
---
Content`;

    const { frontmatter } = parseFrontmatter(raw);
    // Date-like strings should be kept as strings
    expect(typeof frontmatter.date).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Inline tag extraction
// ---------------------------------------------------------------------------

describe("extractInlineTags", () => {
  it("extracts simple tags", () => {
    const tags = extractInlineTags("Some text #daily and #voice here.");
    expect(tags).toContain("daily");
    expect(tags).toContain("voice");
  });

  it("extracts nested tags", () => {
    const tags = extractInlineTags("Tagged #projects/parachute here.");
    expect(tags).toContain("projects/parachute");
  });

  it("ignores tags in code blocks", () => {
    const content = `
Some text #real-tag

\`\`\`
#not-a-tag
\`\`\`
`;
    const tags = extractInlineTags(content);
    expect(tags).toContain("real-tag");
    expect(tags).not.toContain("not-a-tag");
  });

  it("ignores tags in inline code", () => {
    const tags = extractInlineTags("Use `#not-a-tag` for tagging. #real-tag");
    expect(tags).not.toContain("not-a-tag");
    expect(tags).toContain("real-tag");
  });

  it("deduplicates tags", () => {
    const tags = extractInlineTags("#daily notes #daily logs");
    expect(tags.filter((t) => t === "daily")).toHaveLength(1);
  });

  it("lowercases tags", () => {
    const tags = extractInlineTags("#Daily #VOICE");
    expect(tags).toContain("daily");
    expect(tags).toContain("voice");
  });

  it("handles tags at start of line", () => {
    const tags = extractInlineTags("#first-tag\nSome text");
    expect(tags).toContain("first-tag");
  });
});

// ---------------------------------------------------------------------------
// Full vault parsing (with temp directory)
// ---------------------------------------------------------------------------

describe("parseObsidianVault", () => {
  const tmpBase = join(tmpdir(), "parachute-test-obsidian");

  beforeEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(tmpBase, { recursive: true });
  });

  it("parses a simple vault", () => {
    writeFileSync(join(tmpBase, "Note One.md"), `---
tags: [daily]
---
Hello world.`);
    writeFileSync(join(tmpBase, "Note Two.md"), "Plain note. #voice");

    const { notes, errors } = parseObsidianVault(tmpBase);
    expect(errors).toHaveLength(0);
    expect(notes).toHaveLength(2);

    const one = notes.find((n) => n.path === "Note One");
    expect(one).toBeTruthy();
    expect(one!.tags).toContain("daily");
    expect(one!.content).toBe("Hello world.");

    const two = notes.find((n) => n.path === "Note Two");
    expect(two).toBeTruthy();
    expect(two!.tags).toContain("voice");
  });

  it("handles nested directories", () => {
    mkdirSync(join(tmpBase, "Projects", "Parachute"), { recursive: true });
    writeFileSync(join(tmpBase, "Projects", "Parachute", "README.md"), "# Parachute");

    const { notes } = parseObsidianVault(tmpBase);
    expect(notes).toHaveLength(1);
    expect(notes[0].path).toBe("Projects/Parachute/README");
  });

  it("skips .obsidian directory", () => {
    mkdirSync(join(tmpBase, ".obsidian"), { recursive: true });
    writeFileSync(join(tmpBase, ".obsidian", "app.json"), "{}");
    writeFileSync(join(tmpBase, "Real Note.md"), "Content");

    const { notes } = parseObsidianVault(tmpBase);
    expect(notes).toHaveLength(1);
    expect(notes[0].path).toBe("Real Note");
  });

  it("merges frontmatter and inline tags", () => {
    writeFileSync(join(tmpBase, "Mixed.md"), `---
tags: [project]
---
Some text #daily here.`);

    const { notes } = parseObsidianVault(tmpBase);
    expect(notes[0].tags).toContain("project");
    expect(notes[0].tags).toContain("daily");
  });

  it("preserves non-tag frontmatter as metadata", () => {
    writeFileSync(join(tmpBase, "Rich.md"), `---
tags: [daily]
status: draft
priority: 3
---
Content`);

    const { notes } = parseObsidianVault(tmpBase);
    expect(notes[0].frontmatter.status).toBe("draft");
    expect(notes[0].frontmatter.priority).toBe(3);
    // tags should be removed from frontmatter (they go to tags table)
    expect(notes[0].frontmatter.tags).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("toObsidianMarkdown", () => {
  it("generates markdown with frontmatter", () => {
    const md = toObsidianMarkdown({
      id: "test-id",
      path: "My Note",
      content: "Hello world.",
      tags: ["daily", "voice"],
      metadata: { status: "draft" },
      createdAt: "2026-04-05T12:00:00Z",
    });

    expect(md).toContain("---");
    expect(md).toContain("tags:");
    expect(md).toContain("  - daily");
    expect(md).toContain("  - voice");
    expect(md).toContain("status: draft");
    expect(md).toContain("Hello world.");
  });

  it("skips frontmatter when no metadata or tags", () => {
    const md = toObsidianMarkdown({
      id: "test-id",
      content: "Just content.",
      createdAt: "2026-04-05T12:00:00Z",
    });

    expect(md).not.toContain("---");
    expect(md).toBe("Just content.");
  });
});

describe("exportFilePath", () => {
  it("uses note path with .md extension", () => {
    expect(exportFilePath({
      id: "test", path: "Projects/README", content: "", createdAt: "2026-04-05T12:00:00Z",
    })).toBe("Projects/README.md");
  });

  it("generates path from date for pathless notes", () => {
    expect(exportFilePath({
      id: "abc123", content: "", createdAt: "2026-04-05T12:00:00Z",
    })).toBe("2026-04-05/abc123.md");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: import → export
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  const tmpBase = join(tmpdir(), "parachute-test-roundtrip");
  let store: SqliteStore;

  beforeEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
    mkdirSync(tmpBase, { recursive: true });
    store = new SqliteStore(new Database(":memory:"));
  });

  it("preserves content through import → vault → export", () => {
    // Create source files
    writeFileSync(join(tmpBase, "Note.md"), `---
tags: [daily]
status: active
---
Hello world.`);

    // Parse
    const { notes } = parseObsidianVault(tmpBase);
    expect(notes).toHaveLength(1);

    // Import into vault
    const note = store.createNote(notes[0].content, {
      path: notes[0].path,
      tags: notes[0].tags,
      metadata: notes[0].frontmatter,
    });

    expect(note.content).toBe("Hello world.");
    expect(note.path).toBe("Note");
    expect(note.tags).toContain("daily");
    expect(note.metadata?.status).toBe("active");

    // Export back
    const md = toObsidianMarkdown(note);
    expect(md).toContain("tags:");
    expect(md).toContain("  - daily");
    expect(md).toContain("status: active");
    expect(md).toContain("Hello world.");
  });

  it("resolves wikilinks during import", () => {
    writeFileSync(join(tmpBase, "A.md"), "See [[B]] for details.");
    writeFileSync(join(tmpBase, "B.md"), "I am note B.");

    const { notes } = parseObsidianVault(tmpBase);

    // Import all notes
    for (const n of notes) {
      store.createNote(n.content, {
        path: n.path,
        tags: n.tags.length > 0 ? n.tags : undefined,
      });
    }

    // Check that A links to B
    const noteA = store.getNoteByPath("A")!;
    const noteB = store.getNoteByPath("B")!;
    const links = store.getLinks(noteA.id, { direction: "outbound" });
    expect(links.some((l) => l.targetId === noteB.id && l.relationship === "wikilink")).toBe(true);
  });
});
