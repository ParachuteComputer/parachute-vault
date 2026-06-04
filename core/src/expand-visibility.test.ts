import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./schema.js";
import { createNote } from "./notes.js";
import { expandContent, type ExpandContext } from "./expand.js";
import type { Note } from "./types.js";

/**
 * Security regression (vault security review — tag-scope confidentiality).
 *
 * `expandContent`'s optional `isVisible` predicate is the seam that keeps
 * core scope-unaware while letting the server enforce tag scope during
 * wikilink inlining. These tests pin the load-bearing invariant: when the
 * predicate rejects a target, the wikilink is left UNRESOLVED — byte-for-byte
 * identical to a genuinely-missing target, so the response can't reveal that
 * the out-of-scope note exists. They MUST fail if the predicate is removed.
 */

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

function ctx(over: Partial<ExpandContext> = {}): ExpandContext {
  return { db, mode: "full", expanded: new Set<string>(), ...over };
}

describe("expandContent isVisible predicate (tag-scope confidentiality)", () => {
  it("inlines an in-scope target's content when no predicate is set (baseline)", () => {
    createNote(db, "SECRET BODY", { path: "Secret", tags: ["personal"] });
    const out = expandContent("see [[Secret]]", ctx(), 1);
    expect(out).toContain("SECRET BODY");
  });

  it("leaves an out-of-scope wikilink unresolved — no content inlined", () => {
    createNote(db, "SECRET BODY", { path: "Secret", tags: ["personal"] });
    // Predicate: only #work notes are visible. The target is #personal.
    const isVisible = (n: Note) => (n.tags ?? []).includes("work");
    const out = expandContent("see [[Secret]]", ctx({ isVisible }), 1);
    expect(out).not.toContain("SECRET BODY");
    // The wikilink stays literal.
    expect(out).toBe("see [[Secret]]");
  });

  it("out-of-scope target is INDISTINGUISHABLE from a missing target", () => {
    // Case A: target exists but is out of scope.
    createNote(db, "SECRET BODY", { path: "Secret", tags: ["personal"] });
    const isVisible = (n: Note) => (n.tags ?? []).includes("work");
    const outOfScope = expandContent("see [[Secret]]", ctx({ isVisible }), 1);

    // Case B: target genuinely does not exist (fresh db, same predicate).
    const db2 = new Database(":memory:");
    initSchema(db2);
    const missing = expandContent("see [[Secret]]", { db: db2, mode: "full", expanded: new Set(), isVisible }, 1);

    // Byte-identical output → existence is not leaked.
    expect(outOfScope).toBe(missing);
    expect(outOfScope).toBe("see [[Secret]]");
  });

  it("a second reference to an out-of-scope note does NOT render `(expanded above)`", () => {
    // Pins that an out-of-scope note never enters the `expanded` set — else a
    // repeat reference would render `(expanded above)` and leak existence via
    // a different output than a missing target.
    createNote(db, "SECRET BODY", { path: "Secret", tags: ["personal"] });
    const isVisible = (n: Note) => (n.tags ?? []).includes("work");
    const out = expandContent("[[Secret]] and again [[Secret]]", ctx({ isVisible }), 1);
    expect(out).toBe("[[Secret]] and again [[Secret]]");
    expect(out).not.toContain("expanded above");
    expect(out).not.toContain("SECRET BODY");
  });

  it("multi-hop (depth>1) does not leak out-of-scope content at any depth", () => {
    // in-scope #work note → wikilinks an out-of-scope #personal note.
    createNote(db, "DEEP SECRET", { path: "Deep", tags: ["personal"] });
    createNote(db, "intro [[Deep]]", { path: "Mid", tags: ["work"] });
    createNote(db, "top [[Mid]]", { path: "Top", tags: ["work"] });

    const isVisible = (n: Note) => (n.tags ?? []).includes("work");
    // Depth 3 — would walk Top → Mid → Deep without the predicate.
    const out = expandContent("[[Top]]", ctx({ isVisible }), 3);
    // The in-scope Mid IS inlined; the out-of-scope Deep is NOT.
    expect(out).toContain("intro");
    expect(out).not.toContain("DEEP SECRET");
    // The Deep wikilink stays literal inside Mid's inlined content.
    expect(out).toContain("[[Deep]]");
  });

  it("predicate is also honored in summary mode", () => {
    createNote(db, "x", {
      path: "Secret",
      tags: ["personal"],
      metadata: { summary: "SECRET SUMMARY" },
    });
    const isVisible = (n: Note) => (n.tags ?? []).includes("work");
    const out = expandContent("see [[Secret]]", ctx({ mode: "summary", isVisible }), 1);
    expect(out).not.toContain("SECRET SUMMARY");
    expect(out).toBe("see [[Secret]]");
  });
});
