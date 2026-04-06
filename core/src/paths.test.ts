import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { normalizePath, pathTitle, hasInvalidChars } from "./paths.js";

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

describe("normalizePath", () => {
  it("passes through simple paths", () => {
    expect(normalizePath("Projects/README")).toBe("Projects/README");
  });

  it("strips .md extension", () => {
    expect(normalizePath("Note.md")).toBe("Note");
    expect(normalizePath("Projects/README.md")).toBe("Projects/README");
    expect(normalizePath("Note.MD")).toBe("Note");
  });

  it("strips leading/trailing slashes", () => {
    expect(normalizePath("/Projects/README")).toBe("Projects/README");
    expect(normalizePath("Projects/README/")).toBe("Projects/README");
  });

  it("collapses multiple slashes", () => {
    expect(normalizePath("Projects//Parachute///README")).toBe("Projects/Parachute/README");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("Projects\\Parachute\\README")).toBe("Projects/Parachute/README");
  });

  it("trims whitespace", () => {
    expect(normalizePath("  My Note  ")).toBe("My Note");
  });

  it("returns null for empty/whitespace", () => {
    expect(normalizePath("")).toBeNull();
    expect(normalizePath("   ")).toBeNull();
    expect(normalizePath(null)).toBeNull();
    expect(normalizePath(undefined)).toBeNull();
  });

  it("returns null for just .md", () => {
    expect(normalizePath(".md")).toBeNull();
  });
});

describe("pathTitle", () => {
  it("returns last segment", () => {
    expect(pathTitle("Projects/Parachute/README")).toBe("README");
  });

  it("returns the path itself when no slashes", () => {
    expect(pathTitle("Grocery List")).toBe("Grocery List");
  });
});

describe("hasInvalidChars", () => {
  it("detects forbidden characters", () => {
    expect(hasInvalidChars("Note*")).toBe(true);
    expect(hasInvalidChars("Note<1>")).toBe(true);
    expect(hasInvalidChars('Note"quoted"')).toBe(true);
  });

  it("allows valid characters", () => {
    expect(hasInvalidChars("My Note")).toBe(false);
    expect(hasInvalidChars("Projects/Parachute/README")).toBe(false);
    expect(hasInvalidChars("2026-04-06")).toBe(false);
    expect(hasInvalidChars("note_with-dashes")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path uniqueness
// ---------------------------------------------------------------------------

describe("path uniqueness", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(new Database(":memory:"));
  });

  it("allows multiple notes without paths", () => {
    store.createNote("A");
    store.createNote("B");
    // Both should exist
    const notes = store.queryNotes({ limit: 10 });
    expect(notes).toHaveLength(2);
  });

  it("rejects duplicate paths", () => {
    store.createNote("A", { path: "My Note" });
    expect(() => store.createNote("B", { path: "My Note" })).toThrow();
  });

  it("normalizes before checking uniqueness", () => {
    store.createNote("A", { path: "My Note.md" });
    // "My Note.md" normalizes to "My Note" — should conflict
    expect(() => store.createNote("B", { path: "My Note" })).toThrow();
  });

  it("allows different paths", () => {
    store.createNote("A", { path: "Note A" });
    store.createNote("B", { path: "Note B" });
    expect(store.getNoteByPath("Note A")).toBeTruthy();
    expect(store.getNoteByPath("Note B")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Path normalization in store operations
// ---------------------------------------------------------------------------

describe("path normalization in store", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(new Database(":memory:"));
  });

  it("normalizes path on create", () => {
    const note = store.createNote("Test", { path: "  Projects//README.md  " });
    expect(note.path).toBe("Projects/README");
  });

  it("normalizes path on update", () => {
    const note = store.createNote("Test", { path: "Old Path" });
    const updated = store.updateNote(note.id, { path: "New Path.md" });
    expect(updated.path).toBe("New Path");
  });
});

// ---------------------------------------------------------------------------
// Rename cascading
// ---------------------------------------------------------------------------

describe("rename cascading", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(new Database(":memory:"));
  });

  it("updates wikilinks in other notes when path changes", () => {
    const target = store.createNote("I am the target", { path: "Old Name" });
    const source = store.createNote("See [[Old Name]] for details.");

    // Verify link exists
    expect(store.getLinks(source.id, { direction: "outbound" })).toHaveLength(1);

    // Rename the target
    store.updateNote(target.id, { path: "New Name" });

    // Source content should be updated
    const updatedSource = store.getNote(source.id)!;
    expect(updatedSource.content).toBe("See [[New Name]] for details.");

    // Link should still work
    const links = store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0].targetId).toBe(target.id);
  });

  it("updates aliased wikilinks", () => {
    const target = store.createNote("Target", { path: "Old" });
    const source = store.createNote("See [[Old|click here]] for info.");

    store.updateNote(target.id, { path: "New" });

    const updated = store.getNote(source.id)!;
    expect(updated.content).toBe("See [[New|click here]] for info.");
  });

  it("updates wikilinks with anchors", () => {
    const target = store.createNote("Target", { path: "Old" });
    const source = store.createNote("See [[Old#Section]].");

    store.updateNote(target.id, { path: "New" });

    const updated = store.getNote(source.id)!;
    expect(updated.content).toBe("See [[New#Section]].");
  });

  it("does not update unrelated wikilinks", () => {
    store.createNote("Target", { path: "Old" });
    const other = store.createNote("Other", { path: "Other" });
    const source = store.createNote("See [[Other]] and [[Old]].");

    store.updateNote(store.getNoteByPath("Old")!.id, { path: "New" });

    const updated = store.getNote(source.id)!;
    expect(updated.content).toBe("See [[Other]] and [[New]].");
  });
});
