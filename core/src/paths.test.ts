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

describe("path uniqueness", async () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(new Database(":memory:"));
  });

  it("allows multiple notes without paths", async () => {
    await store.createNote("A");
    await store.createNote("B");
    // Both should exist
    const notes = await store.queryNotes({ limit: 10 });
    expect(notes).toHaveLength(2);
  });

  it("rejects duplicate paths", async () => {
    await store.createNote("A", { path: "My Note" });
    expect(async () => await store.createNote("B", { path: "My Note" })).toThrow();
  });

  it("normalizes before checking uniqueness", async () => {
    await store.createNote("A", { path: "My Note.md" });
    // "My Note.md" normalizes to "My Note" — should conflict
    expect(async () => await store.createNote("B", { path: "My Note" })).toThrow();
  });

  it("allows different paths", async () => {
    await store.createNote("A", { path: "Note A" });
    await store.createNote("B", { path: "Note B" });
    expect(await store.getNoteByPath("Note A")).toBeTruthy();
    expect(await store.getNoteByPath("Note B")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Path normalization in store operations
// ---------------------------------------------------------------------------

describe("path normalization in store", async () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(new Database(":memory:"));
  });

  it("normalizes path on create", async () => {
    const note = await store.createNote("Test", { path: "  Projects//README.md  " });
    expect(note.path).toBe("Projects/README");
  });

  it("normalizes path on update", async () => {
    const note = await store.createNote("Test", { path: "Old Path" });
    const updated = await store.updateNote(note.id, { path: "New Path.md" });
    expect(updated.path).toBe("New Path");
  });
});

// ---------------------------------------------------------------------------
// Rename cascading
// ---------------------------------------------------------------------------

describe("rename cascading", async () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(new Database(":memory:"));
  });

  it("updates wikilinks in other notes when path changes", async () => {
    const target = await store.createNote("I am the target", { path: "Old Name" });
    const source = await store.createNote("See [[Old Name]] for details.");

    // Verify link exists
    expect(await store.getLinks(source.id, { direction: "outbound" })).toHaveLength(1);

    // Rename the target
    await store.updateNote(target.id, { path: "New Name" });

    // Source content should be updated
    const updatedSource = await store.getNote(source.id)!;
    expect(updatedSource.content).toBe("See [[New Name]] for details.");

    // Link should still work
    const links = await store.getLinks(source.id, { direction: "outbound" });
    expect(links).toHaveLength(1);
    expect(links[0].targetId).toBe(target.id);
  });

  it("updates aliased wikilinks", async () => {
    const target = await store.createNote("Target", { path: "Old" });
    const source = await store.createNote("See [[Old|click here]] for info.");

    await store.updateNote(target.id, { path: "New" });

    const updated = await store.getNote(source.id)!;
    expect(updated.content).toBe("See [[New|click here]] for info.");
  });

  it("updates wikilinks with anchors", async () => {
    const target = await store.createNote("Target", { path: "Old" });
    const source = await store.createNote("See [[Old#Section]].");

    await store.updateNote(target.id, { path: "New" });

    const updated = await store.getNote(source.id)!;
    expect(updated.content).toBe("See [[New#Section]].");
  });

  it("does not update unrelated wikilinks", async () => {
    await store.createNote("Target", { path: "Old" });
    const other = await store.createNote("Other", { path: "Other" });
    const source = await store.createNote("See [[Other]] and [[Old]].");

    await store.updateNote((await store.getNoteByPath("Old"))!.id, { path: "New" });

    const updated = await store.getNote(source.id)!;
    expect(updated.content).toBe("See [[Other]] and [[New]].");
  });
});
