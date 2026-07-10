/**
 * Contract suite — taxonomy integrity (Wave 1 of the Reliability & Usability
 * Program, umbrella #556). Encodes the 2026-07-09 nine-persona deep test's
 * WS3 findings (#552) as executable tests: PASSING tests lock in behavior
 * that is correct today (the tag-expand axis, `delete-tag`'s "untag, don't
 * delete notes" contract, and `renameTag`'s full cascade — note_tags,
 * `parent_names` references in OTHER tags, and note body content); `test.todo`
 * entries describe the target behavior for confirmed-broken cases, to be
 * flipped to real assertions in a later wave. See #552 for the full write-up.
 */

import { describe, it, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

const idsOf = (notes: { id: string }[]) => new Set(notes.map((n) => n.id));

describe("contract: taxonomy — passing (lock in current behavior)", () => {
  it("expand axis 4-way discrimination: subtypes/namespace/both/exact each answer a distinct question", async () => {
    // Two-axis corpus (mirrors tag-expand-axis.test.ts): `person` is a
    // declared subtype of `entity` (parent_names) but not name-prefixed;
    // `entity/archived` is name-prefixed under `entity` but NOT a declared
    // subtype; `entity/person` is both.
    await store.upsertTagRecord("entity", { description: "an entity" });
    await store.upsertTagRecord("person", { parent_names: ["entity"] });
    await store.upsertTagRecord("entity/archived", {});
    await store.upsertTagRecord("entity/person", { parent_names: ["entity"] });

    const nEntity = await store.createNote("literal entity", { tags: ["entity"] });
    const nPerson = await store.createNote("a person (subtype)", { tags: ["person"] });
    const nArchived = await store.createNote("filed under entity/", { tags: ["entity/archived"] });
    const nBoth = await store.createNote("subtype AND filed", { tags: ["entity/person"] });

    const subtypes = await store.queryNotes({ tags: ["entity"], expand: "subtypes" });
    expect(idsOf(subtypes)).toEqual(new Set([nEntity.id, nPerson.id, nBoth.id]));

    const namespace = await store.queryNotes({ tags: ["entity"], expand: "namespace" });
    expect(idsOf(namespace)).toEqual(new Set([nEntity.id, nArchived.id, nBoth.id]));

    const both = await store.queryNotes({ tags: ["entity"], expand: "both" });
    expect(idsOf(both)).toEqual(new Set([nEntity.id, nPerson.id, nArchived.id, nBoth.id]));

    const exact = await store.queryNotes({ tags: ["entity"], expand: "exact" });
    expect(idsOf(exact)).toEqual(new Set([nEntity.id]));
  });

  it("delete-tag untags notes without deleting the notes themselves", async () => {
    const note = await store.createNote("keep me", { tags: ["temp", "keeper"] });
    const result = await store.deleteTag("temp");
    expect(result).toEqual({ deleted: true, notes_untagged: 1 });

    const survivor = await store.getNote(note.id);
    expect(survivor).not.toBeNull();
    expect(survivor!.content).toBe("keep me");
    expect(survivor!.tags).toEqual(["keeper"]);
    expect(survivor!.tags).not.toContain("temp");
  });

  it("renameTag cascades note_tags, other tags' parent_names, AND note body content in one atomic call", async () => {
    // note_tags surface: a note directly tagged `proj`.
    const tagged = await store.createNote("owns the proj tag", { tags: ["proj"] });
    // parent_names surface: another tag declares `proj` as a parent.
    await store.upsertTagRecord("proj", { description: "root project tag" });
    await store.upsertTagRecord("special", { parent_names: ["proj"] });
    // note-body surface: a note mentions `#proj` inline (not as a real tag).
    const mentioning = await store.createNote("kickoff notes, see #proj for context", {});

    const result = await store.renameTag("proj", "initiative");
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("unreachable");
    expect(result.renamed).toBeGreaterThanOrEqual(1);
    expect(result.parent_refs_updated).toBeGreaterThanOrEqual(1);
    expect(result.notes_rewritten).toBeGreaterThanOrEqual(1);

    // 1. note_tags cascade.
    const taggedAfter = await store.getNote(tagged.id);
    expect(taggedAfter!.tags).toContain("initiative");
    expect(taggedAfter!.tags).not.toContain("proj");

    // 2. OTHER tags' parent_names cascade.
    const specialAfter = await store.getTagRecord("special");
    expect(specialAfter?.parent_names).toEqual(["initiative"]);

    // 3. Note body content cascade.
    const mentioningAfter = await store.getNote(mentioning.id);
    expect(mentioningAfter!.content).toContain("#initiative");
    expect(mentioningAfter!.content).not.toContain("#proj");

    // The old tag name is fully retired — no longer a live tag row.
    const oldRecord = await store.getTagRecord("proj");
    expect(oldRecord).toBeNull();
  });
});

describe("contract: taxonomy — todo (#552)", () => {
  test.todo(
    "#552: deleting a tag still referenced in another tag's parent_names errors unless cascade/detach is passed (today: store.deleteTag succeeds unconditionally and leaves the referencing tag's parent_names pointing at a now-nonexistent tag name — verified with a fresh parent/child fixture)",
  );
  test.todo(
    "#552: a parent_names cycle (A declares parent B, then B declares parent A) is rejected at write time (today: store.upsertTagRecord accepts both writes with no cycle check — traversal elsewhere is cycle-safe, but the write itself is not honest about creating one)",
  );
  test.todo(
    "#552: rename-tag is exposed as an MCP tool, not just a REST endpoint (today: POST /api/tags/:name/rename exists and store.renameTag is wired, but generateMcpTools has no rename-tag tool — an MCP-only agent cannot rename a tag)",
  );
  test.todo(
    "#552: merge-tags is exposed as an MCP tool, not just a REST endpoint (today: POST /api/tags/merge exists and store.mergeTags is wired, but generateMcpTools has no merge-tags tool)",
  );
  test.todo(
    "#552: a `vault doctor` integrity scan reports dangling parent_names references (today: no doctor/scan surface inspects parent_names for referential integrity — the delete-tag gap above goes undetected)",
  );
});
