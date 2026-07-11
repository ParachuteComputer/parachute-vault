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

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import { ParentCycleError } from "./tag-schemas.js";
import { declareField } from "./indexed-fields.js";

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

describe("contract: taxonomy — #552 (flipped from test.todo)", () => {
  it("rename-tag is exposed as an MCP tool and cascades parent_names — the gardener's exact bug no longer happens", async () => {
    // Root tag, a child that declares it as a parent (the parent_names
    // surface the gardener's rename left orphaned), and a note tagged with
    // the CHILD only (proves subtype expansion still finds it post-rename).
    await store.upsertTagRecord("proj", { description: "root project tag" });
    await store.upsertTagRecord("special", { parent_names: ["proj"] });
    const childTagged = await store.createNote("filed under the child tag", { tags: ["special"] });

    const tools = generateMcpTools(store);
    const renameTag = tools.find((t) => t.name === "rename-tag");
    expect(renameTag).toBeDefined();
    // Re-tier: rename-tag is taxonomy curation, not content — write → admin.
    expect(renameTag!.requiredVerb).toBe("admin");

    const result = await renameTag!.execute({ old_name: "proj", new_name: "initiative" }) as any;
    expect("error" in result).toBe(false);
    expect(result.parent_refs_updated).toBeGreaterThanOrEqual(1);

    // The exact gardener's bug: "special"'s parent_names must follow the
    // rename, not keep pointing at the now-dead "proj".
    const special = await store.getTagRecord("special");
    expect(special?.parent_names).toEqual(["initiative"]);

    // The renamed-away tag is NOT a live query surface anymore.
    const projRecord = await store.getTagRecord("proj");
    expect(projRecord).toBeNull();

    // The NEW tag doesn't silently miss child-tagged notes (the gardener's
    // second symptom): subtype expansion of "initiative" still reaches the
    // note tagged only with the child "special".
    const viaExpansion = await store.queryNotes({ tags: ["initiative"] });
    expect(viaExpansion.map((n) => n.id)).toContain(childTagged.id);
  });

  it("rename-tag MCP tool reports target_exists (not a silent overwrite) and tag_not_found for a missing source", async () => {
    await store.upsertTagRecord("a", {});
    await store.upsertTagRecord("b", {});
    const tools = generateMcpTools(store);
    const renameTag = tools.find((t) => t.name === "rename-tag")!;

    let caught: any;
    try {
      await renameTag.execute({ old_name: "a", new_name: "b" });
    } catch (e) { caught = e; }
    expect(caught?.error_type).toBe("target_exists");
    expect(caught?.conflicting).toContain("b");

    caught = undefined;
    try {
      await renameTag.execute({ old_name: "nonexistent", new_name: "whatever" });
    } catch (e) { caught = e; }
    expect(caught?.error_type).toBe("tag_not_found");
  });

  it("merge-tags is exposed as an MCP tool and merges N sources into one target", async () => {
    await store.upsertTagRecord("draft", {});
    await store.upsertTagRecord("wip", {});
    const draftNote = await store.createNote("draft note", { tags: ["draft"] });
    const wipNote = await store.createNote("wip note", { tags: ["wip"] });

    const tools = generateMcpTools(store);
    const mergeTags = tools.find((t) => t.name === "merge-tags");
    expect(mergeTags).toBeDefined();
    // Re-tier: merge-tags is taxonomy curation, not content — write → admin.
    expect(mergeTags!.requiredVerb).toBe("admin");

    const result = await mergeTags!.execute({ sources: ["draft", "wip"], target: "active" }) as any;
    expect(result.target).toBe("active");
    expect(result.merged.draft).toBe(1);
    expect(result.merged.wip).toBe(1);

    const draftAfter = await store.getNote(draftNote.id);
    const wipAfter = await store.getNote(wipNote.id);
    expect(draftAfter!.tags).toEqual(["active"]);
    expect(wipAfter!.tags).toEqual(["active"]);
    expect(await store.getTagRecord("draft")).toBeNull();
    expect(await store.getTagRecord("wip")).toBeNull();
  });

  it("delete-tag refuses a tag still referenced in another tag's parent_names, then cascade/detach both proceed and strip the reference", async () => {
    await store.upsertTagRecord("proj", { description: "root" });
    await store.upsertTagRecord("child", { parent_names: ["proj"] });

    const tools = generateMcpTools(store);
    const deleteTag = tools.find((t) => t.name === "delete-tag")!;

    // Default (no flag): refused, nothing mutated.
    const refused = await deleteTag.execute({ tag: "proj" }) as any;
    expect(refused.error).toBe("tag_referenced_as_parent");
    expect(refused.referencing_tags).toEqual(["child"]);
    expect(await store.getTagRecord("proj")).not.toBeNull();
    expect((await store.getTagRecord("child"))?.parent_names).toEqual(["proj"]);

    // cascade: true proceeds and strips the stale reference.
    const cascaded = await deleteTag.execute({ tag: "proj", cascade: true }) as any;
    expect(cascaded.deleted).toBe(true);
    expect(cascaded.parent_refs_detached).toBe(1);
    expect(await store.getTagRecord("proj")).toBeNull();
    expect((await store.getTagRecord("child"))?.parent_names ?? null).toBeFalsy();

    // detach is a synonym — same repair, exercised on a second fixture.
    await store.upsertTagRecord("proj2", { description: "root2" });
    await store.upsertTagRecord("child2", { parent_names: ["proj2"] });
    const detached = await deleteTag.execute({ tag: "proj2", detach: true }) as any;
    expect(detached.deleted).toBe(true);
    expect(detached.parent_refs_detached).toBe(1);
    expect((await store.getTagRecord("child2"))?.parent_names ?? null).toBeFalsy();
  });

  it("a parent_names cycle (direct A→B→A, and bare self-parent) is rejected at write time with error_type parent_cycle", async () => {
    await store.upsertTagRecord("B", {});
    await store.upsertTagRecord("A", { parent_names: ["B"] });

    let caught: unknown;
    try {
      await store.upsertTagRecord("B", { parent_names: ["A"] });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ParentCycleError);
    const cycleErr = caught as ParentCycleError;
    expect(cycleErr.error_type).toBe("parent_cycle");
    expect(cycleErr.tag).toBe("B");
    expect(cycleErr.cycle).toContain("A");
    expect(cycleErr.cycle).toContain("B");
    // Nothing persisted — B's parent_names is untouched by the rejected write.
    expect((await store.getTagRecord("B"))?.parent_names ?? null).toBeFalsy();

    // Bare self-parent: also caught (getTagDescendants always includes the
    // tag itself).
    let selfCaught: unknown;
    try {
      await store.upsertTagRecord("C", { parent_names: ["C"] });
    } catch (e) { selfCaught = e; }
    expect(selfCaught).toBeInstanceOf(ParentCycleError);
    expect((selfCaught as ParentCycleError).cycle).toEqual(["C", "C"]);
  });

  it("doctor reports each finding type on a seeded-broken fixture, and stays clean on a healthy one", async () => {
    // 1. dangling_parent_name — "ghost-parent" is never created as a tag row.
    await store.upsertTagRecord("orphan-child", { parent_names: ["ghost-parent"] });

    // 2. parent_names_cycle — the write-time guard blocks NEW cycles, so
    // simulate pre-existing/pre-guard cyclic data with a direct DB write
    // (same technique core.test.ts's cycle-tolerance tests use).
    await store.upsertTagRecord("cyc-a", {});
    await store.upsertTagRecord("cyc-b", { parent_names: ["cyc-a"] });
    db.prepare("UPDATE tags SET parent_names = ? WHERE name = ?").run(JSON.stringify(["cyc-b"]), "cyc-a");

    // 3. mixed_type_indexed_field — "n" is indexed INTEGER, but this note's
    // metadata.n is a JSON string. Not `strict`, so the write succeeds with
    // just an advisory warning — landing exactly the mismatched value.
    await store.upsertTagRecord("metric", { fields: { n: { type: "integer", indexed: true } } });
    await store.createNote("bad metric", { tags: ["metric"], metadata: { n: "not-a-number" } });

    // 4. orphaned_indexed_field_declarer — declare directly via the
    // indexed-fields API, then drop the tag row WITHOUT releasing (the
    // pre-fix gitcoin state prune-schema's own tests seed identically).
    declareField(db, "legacy_status", "TEXT", "ghost-declarer");

    // 5. dead_tag_metadata_reference (heuristic) — "epic" holds tag-shaped
    // values elsewhere (a live tag), so a value that ISN'T a live tag is
    // the drift signal.
    await store.upsertTagRecord("launch-v2", {});
    await store.createNote("current epic", { tags: ["launch-v2"], metadata: { epic: "launch-v2" } });
    await store.createNote("stale epic reference", { tags: ["launch-v2"], metadata: { epic: "launch-v1" } });

    const report = await store.doctor();
    const byType = new Map(report.findings.map((f) => [f.type, f]));

    expect(byType.get("dangling_parent_name")?.subject).toBe("orphan-child");
    expect(byType.get("parent_names_cycle")).toBeDefined();
    expect(byType.get("mixed_type_indexed_field")?.subject).toBe("n");
    expect(byType.get("mixed_type_indexed_field")?.severity).toBe("error");
    expect(byType.get("orphaned_indexed_field_declarer")?.subject).toBe("legacy_status");
    const driftFinding = byType.get("dead_tag_metadata_reference");
    expect(driftFinding?.subject).toBe("metadata.epic");
    expect(driftFinding?.heuristic).toBe(true);
    expect(driftFinding?.detail).toContain("launch-v1");

    // Every finding type from the fixture is present — five distinct types.
    expect(byType.size).toBe(5);

    // A fresh, healthy vault reports clean.
    const cleanDb = new Database(":memory:");
    const cleanStore = new SqliteStore(cleanDb);
    await cleanStore.upsertTagRecord("healthy", { description: "nothing wrong here" });
    await cleanStore.createNote("fine", { tags: ["healthy"] });
    const cleanReport = await cleanStore.doctor();
    expect(cleanReport.findings).toEqual([]);
    expect(cleanReport.summary).toContain("clean");
  });

  // LB — a DIRECT self-parent (`parent_names: [tag]` on tag itself) is a
  // degenerate one-node cycle: `getTagDescendants` starts its traversal
  // result at `{tag}`, and the moment it walks the tag's own self-edge it
  // finds `tag` already `result.has(child)` and skips re-expanding it — so
  // `descendants` never grows past size 1. `findHierarchyCycles`'s original
  // gate (`descendants.has(tag) && descendants.size > 1`) requires size>1,
  // so this exact case reported clean despite being a real cycle. Only
  // reachable via guard-bypassing data (direct DB write / import) since
  // `upsertTagRecord` rejects a self-parent at write time (see the "bare
  // self-parent: also caught" assertion above, which exercises the WRITE
  // guard — this test exercises the READ-side doctor scan on data that
  // skipped that guard).
  it("doctor flags a bare self-parent cycle (X declares parent_names: [X]), which the size>1 gate alone misses", async () => {
    await store.upsertTagRecord("self-cyc", {});
    db.prepare("UPDATE tags SET parent_names = ? WHERE name = ?").run(JSON.stringify(["self-cyc"]), "self-cyc");

    const report = await store.doctor();
    const finding = report.findings.find((f) => f.type === "parent_names_cycle" && f.subject === "self-cyc");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
  });

  it("dead_tag_metadata_reference does not false-positive on a schema-declared enum field whose values coincide with an unrelated live tag (vault#570)", async () => {
    // "archived" is a real, unrelated live tag — coincidentally sharing a
    // name with one of "status"'s declared enum values. Pre-fix, this ONE
    // coincidental collision was enough to convince the heuristic that
    // metadata.status "holds tag-shaped values", and then flag status's
    // OTHER legitimate enum values ("active", "done") as stale tag
    // references — even though neither was ever a tag at all.
    await store.upsertTagRecord("archived", {});
    await store.upsertTagRecord("task", {
      fields: { status: { type: "string", enum: ["active", "archived", "done"] } },
    });
    await store.createNote("task one", { tags: ["task"], metadata: { status: "active" } });
    await store.createNote("task two", { tags: ["task"], metadata: { status: "done" } });
    await store.createNote("task three", { tags: ["task"], metadata: { status: "archived" } });

    const report = await store.doctor();
    const driftFindings = report.findings.filter(
      (f) => f.type === "dead_tag_metadata_reference" && f.subject === "metadata.status",
    );
    expect(driftFindings).toEqual([]);
  });
});
