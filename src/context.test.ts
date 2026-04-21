import { describe, test, expect } from "bun:test";
import type { Note, Store } from "../core/src/types.ts";
import { appendContextPart, fetchContextEntries } from "./context.ts";

function mkNote(overrides: Partial<Note>): Note {
  return {
    id: overrides.id ?? "n1",
    content: "",
    createdAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:00:00Z",
    tags: [],
    metadata: {},
    ...overrides,
  };
}

function mkStore(byTag: Record<string, Note[]>): Store {
  return {
    queryNotes: async ({ tags, excludeTags }) => {
      const tag = tags?.[0];
      if (!tag) return [];
      const pool = byTag[tag] ?? [];
      if (!excludeTags?.length) return pool;
      const excluded = new Set(excludeTags);
      return pool.filter((n) => !(n.tags ?? []).some((t) => excluded.has(t)));
    },
  } as unknown as Store;
}

describe("fetchContextEntries", () => {
  test("returns whitelisted metadata keyed on path basename", async () => {
    const store = mkStore({
      person: [
        mkNote({
          id: "p1",
          path: "People/Aaron.md",
          tags: ["person"],
          metadata: { summary: "founder", aliases: ["A"], secret: "don't leak" },
        }),
      ],
    });

    const payload = await fetchContextEntries(store, [
      { tag: "person", include_metadata: ["summary", "aliases"] },
    ]);

    expect(payload.entries.length).toBe(1);
    expect(payload.entries[0].name).toBe("Aaron");
    expect(payload.entries[0].summary).toBe("founder");
    expect(payload.entries[0].aliases).toEqual(["A"]);
    // Non-whitelisted metadata never surfaces.
    expect(payload.entries[0].secret).toBeUndefined();
  });

  test("honors exclude_tag", async () => {
    const store = mkStore({
      project: [
        mkNote({ id: "pj1", path: "Projects/Active.md", tags: ["project"] }),
        mkNote({ id: "pj2", path: "Projects/Old.md", tags: ["project", "archived"] }),
      ],
    });

    const payload = await fetchContextEntries(store, [
      { tag: "project", exclude_tag: "archived", include_metadata: [] },
    ]);

    expect(payload.entries.map((e) => e.name)).toEqual(["Active"]);
  });

  test("dedups notes across predicates by note id (first-match wins)", async () => {
    const overlap = mkNote({ id: "x1", path: "People/X.md", tags: ["person", "project"] });
    const store = mkStore({ person: [overlap], project: [overlap] });

    const payload = await fetchContextEntries(store, [
      { tag: "person", include_metadata: [] },
      { tag: "project", include_metadata: [] },
    ]);

    expect(payload.entries.length).toBe(1);
    expect(payload.entries[0].name).toBe("X");
  });

  test("falls back to note.id when path is absent", async () => {
    const store = mkStore({
      person: [mkNote({ id: "no-path-note", path: undefined, tags: ["person"] })],
    });

    const payload = await fetchContextEntries(store, [{ tag: "person" }]);

    expect(payload.entries[0].name).toBe("no-path-note");
  });

  test("skips predicates with empty tag (defensive — not throw)", async () => {
    const store = mkStore({ person: [mkNote({ id: "p1", path: "x" })] });
    const payload = await fetchContextEntries(store, [
      { tag: "" },
      { tag: "person" },
    ]);
    expect(payload.entries.length).toBe(1);
  });

  test("logs and continues on queryNotes throw; does not abort the whole fetch", async () => {
    const errors: unknown[] = [];
    const logger = { error: (...args: unknown[]) => errors.push(args) };
    const store: Store = {
      queryNotes: async ({ tags }) => {
        if (tags?.[0] === "broken") throw new Error("boom");
        return [mkNote({ id: "ok", path: "Ok.md", tags: ["ok"] })];
      },
    } as unknown as Store;

    const payload = await fetchContextEntries(
      store,
      [{ tag: "broken" }, { tag: "ok" }],
      logger,
    );

    expect(errors.length).toBe(1);
    expect(payload.entries.map((e) => e.name)).toEqual(["Ok"]);
  });
});

describe("appendContextPart", () => {
  test("appends a JSON blob when entries exist", () => {
    const form = new FormData();
    appendContextPart(form, { entries: [{ name: "x" }] });
    const part = form.get("context");
    expect(part).toBeInstanceOf(Blob);
  });

  test("no-ops on zero-entries payload", () => {
    const form = new FormData();
    appendContextPart(form, { entries: [] });
    expect(form.get("context")).toBeNull();
  });
});
