/**
 * Tag-expansion axis (`expand`) tests — vault tag `expand` axis
 * (design `design/2026-06-09-tag-expand-axis.md`).
 *
 * Covers the query engine (`store.queryNotes` → `expandQueryTags` →
 * `_tagsExpanded`) and the mode-aware core helpers
 * (`getTagExpansion`/`getTagNamespace`). REST + MCP + SSE parity are exercised
 * in their own suites (`routes`/`mcp` here, `subscribe`/`live-match` in src/).
 *
 * The corpus deliberately separates the two axes so a mode that confuses them
 * fails loudly:
 *   - `entity` is the SUBTYPE parent of `person` (declared via parent_names).
 *     `person` is NOT name-prefixed `entity/`.
 *   - `entity/archived` is NAME-prefixed under `entity` but is NOT a declared
 *     subtype (no parent_names link to `entity`).
 *   - `entity/person` is BOTH a declared subtype-child of `entity` AND
 *     name-prefixed `entity/` — the dedupe case.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import {
  loadTagHierarchy,
  getTagExpansion,
  getTagNamespace,
  getTagDescendants,
} from "./tag-hierarchy.js";

let store: SqliteStore;
let db: Database;

/**
 * Seed the two-axis corpus and return the set of note ids by their kind so
 * tests can assert membership without depending on insertion order.
 */
async function seedTwoAxisCorpus(s: SqliteStore) {
  // SUBTYPE axis: person is-a entity (declared), but NOT filed under entity/.
  await s.upsertTagRecord("entity", { description: "an entity" });
  await s.upsertTagRecord("person", { parent_names: ["entity"] });
  // NAMESPACE axis: entity/archived is filed under entity/ but declares no
  // parent_names (pure filing, no is-a edge).
  await s.upsertTagRecord("entity/archived", {});
  // BOTH axes: entity/person is a declared subtype-child AND name-prefixed.
  await s.upsertTagRecord("entity/person", { parent_names: ["entity"] });

  const nEntity = await s.createNote("literal entity", { tags: ["entity"] });
  const nPerson = await s.createNote("a person (subtype)", { tags: ["person"] });
  const nArchived = await s.createNote("filed under entity/", { tags: ["entity/archived"] });
  const nBoth = await s.createNote("subtype AND filed", { tags: ["entity/person"] });
  const nUnrelated = await s.createNote("unrelated", { tags: ["work"] });

  return {
    entity: nEntity.id,
    person: nPerson.id,
    archived: nArchived.id,
    both: nBoth.id,
    unrelated: nUnrelated.id,
  };
}

const idsOf = (notes: { id: string }[]) => new Set(notes.map((n) => n.id));

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("tag expand axis — core helpers", () => {
  it("getTagNamespace returns the tag + lexically prefixed names, no parent_names subtypes", async () => {
    await seedTwoAxisCorpus(store);
    const h = loadTagHierarchy(db);
    const ns = getTagNamespace(h, "entity");
    // tag itself + name-prefixed entity/*
    expect(ns).toContain("entity");
    expect(ns).toContain("entity/archived");
    expect(ns).toContain("entity/person");
    // `person` is a subtype but NOT name-prefixed → must be absent.
    expect(ns.has("person")).toBe(false);
  });

  it("getTagExpansion: subtypes = descendants, namespace = lexical, both = union, exact = literal", async () => {
    await seedTwoAxisCorpus(store);
    const h = loadTagHierarchy(db);

    const subtypes = getTagExpansion(h, "entity", "subtypes");
    // descendants via parent_names: entity, person, entity/person — NOT entity/archived
    expect(subtypes).toEqual(getTagDescendants(h, "entity"));
    expect(subtypes).toContain("person");
    expect(subtypes).toContain("entity/person");
    expect(subtypes.has("entity/archived")).toBe(false);

    const ns = getTagExpansion(h, "entity", "namespace");
    expect(ns).toContain("entity/archived");
    expect(ns).toContain("entity/person");
    expect(ns.has("person")).toBe(false);

    const both = getTagExpansion(h, "entity", "both");
    // union: subtype-only person + namespace-only entity/archived + shared
    expect(both).toContain("person");
    expect(both).toContain("entity/archived");
    expect(both).toContain("entity/person");

    const exact = getTagExpansion(h, "entity", "exact");
    expect(exact).toEqual(new Set(["entity"]));
  });

  it("dedupe: entity/person (subtype AND name-prefixed) appears once under both", async () => {
    await seedTwoAxisCorpus(store);
    const h = loadTagHierarchy(db);
    const both = getTagExpansion(h, "entity", "both");
    const count = Array.from(both).filter((t) => t === "entity/person").length;
    expect(count).toBe(1);
  });

  it("store.expandTags mirrors the helper modes and unions multi-tag input", async () => {
    await seedTwoAxisCorpus(store);
    expect(await store.expandTags(["entity"], "exact")).toEqual(new Set(["entity"]));
    const ns = await store.expandTags(["entity"], "namespace");
    expect(ns).toContain("entity/archived");
    expect(ns.has("person")).toBe(false);
    // default (no mode) === subtypes === expandTagsWithDescendants
    const def = await store.expandTags(["entity"]);
    expect(def).toEqual(await store.expandTagsWithDescendants(["entity"]));
  });
});

describe("tag expand axis — query engine", () => {
  it("subtypes (default / absent) is a pure regression: descendants only, no namespaced sibling", async () => {
    const ids = await seedTwoAxisCorpus(store);

    const absent = await store.queryNotes({ tags: ["entity"] });
    const explicit = await store.queryNotes({ tags: ["entity"], expand: "subtypes" });

    // Absent ≡ explicit "subtypes" — byte-identical result set.
    expect(idsOf(explicit)).toEqual(idsOf(absent));

    // Returns the literal + declared subtypes…
    expect(idsOf(absent)).toEqual(new Set([ids.entity, ids.person, ids.both]));
    // …and NOT the namespace-only sibling entity/archived.
    expect(idsOf(absent).has(ids.archived)).toBe(false);
  });

  it("namespace returns tag + tag/* lexical, NOT parent_names-only subtypes", async () => {
    const ids = await seedTwoAxisCorpus(store);
    const res = await store.queryNotes({ tags: ["entity"], expand: "namespace" });
    // entity (literal) + entity/archived + entity/person (name-prefixed)
    expect(idsOf(res)).toEqual(new Set([ids.entity, ids.archived, ids.both]));
    // `person` is a subtype but not name-prefixed → excluded.
    expect(idsOf(res).has(ids.person)).toBe(false);
  });

  it("both = union of subtypes and namespace", async () => {
    const ids = await seedTwoAxisCorpus(store);
    const res = await store.queryNotes({ tags: ["entity"], expand: "both" });
    expect(idsOf(res)).toEqual(
      new Set([ids.entity, ids.person, ids.archived, ids.both]),
    );
  });

  it("exact = literal tag only, no descendants", async () => {
    const ids = await seedTwoAxisCorpus(store);
    const res = await store.queryNotes({ tags: ["entity"], expand: "exact" });
    expect(idsOf(res)).toEqual(new Set([ids.entity]));
  });

  it("dedupe: a note tagged with a both-axis tag is returned once under both", async () => {
    await seedTwoAxisCorpus(store);
    const res = await store.queryNotes({ tags: ["entity"], expand: "both" });
    const bothCount = res.filter((n) => n.content === "subtype AND filed").length;
    expect(bothCount).toBe(1);
  });

  it("_default magic stays subtypes-only: namespace on _default does NOT collapse to all notes", async () => {
    // _default declared → universal subtype parent. With a namespaced child.
    await store.upsertTagRecord("_default", { description: "universal" });
    await store.upsertTagRecord("_default/scoped", {});
    const nA = await store.createNote("a", { tags: ["alpha"] });
    const nScoped = await store.createNote("scoped", { tags: ["_default/scoped"] });

    // subtypes: _default expands to ALL tags → every note matches.
    const sub = await store.queryNotes({ tags: ["_default"], expand: "subtypes" });
    expect(idsOf(sub).has(nA.id)).toBe(true);

    // namespace: _default is treated literally → only _default + _default/* —
    // does NOT collapse to "all notes" (nA, tagged only `alpha`, is excluded).
    const ns = await store.queryNotes({ tags: ["_default"], expand: "namespace" });
    expect(idsOf(ns).has(nA.id)).toBe(false);
    expect(idsOf(ns).has(nScoped.id)).toBe(true);
  });

  it("both + _default collapses to all-notes via the subtypes axis", async () => {
    // `both` includes the subtypes axis, so the `_default` universal-parent
    // magic must still fire — the union with the namespace axis can only widen
    // the set, and subtypes alone already means "every note." Untagged notes
    // included (the _default collapse drops the tag filter entirely).
    await store.upsertTagRecord("_default", { description: "universal" });
    const nTagged = await store.createNote("tagged", { tags: ["alpha"] });
    const nUntagged = await store.createNote("untagged", {});

    const res = await store.queryNotes({ tags: ["_default"], expand: "both" });
    const got = idsOf(res);
    expect(got.has(nTagged.id)).toBe(true);
    expect(got.has(nUntagged.id)).toBe(true);
    // Equivalent to the no-filter corpus.
    const all = await store.queryNotes({});
    expect(got).toEqual(idsOf(all));
  });
});

describe("tag expand axis — MCP query-notes schema + handler", () => {
  it("query-notes schema advertises the four expand values", async () => {
    const { generateMcpTools } = await import("./mcp.js");
    const tools = generateMcpTools(store);
    const q = tools.find((t) => t.name === "query-notes")!;
    const props = (q.inputSchema as any).properties;
    expect(props.expand).toBeDefined();
    expect(props.expand.enum).toEqual(["subtypes", "namespace", "both", "exact"]);
  });

  it("query-notes handler honors expand=namespace", async () => {
    const { generateMcpTools } = await import("./mcp.js");
    const ids = await seedTwoAxisCorpus(store);
    const tools = generateMcpTools(store);
    const q = tools.find((t) => t.name === "query-notes")!;
    // Non-cursor structured query returns a flat array of note-index entries.
    const res: any = await q.execute({ tag: "entity", expand: "namespace" });
    const got = new Set<string>(res.map((n: any) => n.id));
    expect(got).toEqual(new Set([ids.entity, ids.archived, ids.both]));
    expect(got.has(ids.person)).toBe(false);
  });

  it("query-notes handler rejects an unknown expand value with INVALID_QUERY", async () => {
    const { generateMcpTools } = await import("./mcp.js");
    const tools = generateMcpTools(store);
    const q = tools.find((t) => t.name === "query-notes")!;
    let err: any;
    try {
      await q.execute({ tag: "entity", expand: "bogus" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe("INVALID_QUERY");
  });
});

describe("tag expand axis — MCP search path honors expand", () => {
  // Corpus shares the FTS term "fox" so search(tag=entity) differs ONLY by the
  // expand axis — proving the search branch threads it into store.searchNotes.
  async function seedSearchCorpus(s: SqliteStore) {
    await s.upsertTagRecord("entity", { description: "entity root" });
    await s.upsertTagRecord("person", { parent_names: ["entity"] }); // subtype, not name-prefixed
    await s.upsertTagRecord("entity/archived", {}); // name-prefixed, not subtype
    await s.createNote("fox literal", { tags: ["entity"] });
    await s.createNote("fox subtype", { tags: ["person"] });
    await s.createNote("fox filed", { tags: ["entity/archived"] });
    await s.createNote("dog unrelated", { tags: ["entity"] }); // no "fox" → FTS excludes
  }

  it("search + tag, absent expand ≡ subtypes (descendants, no namespaced sibling)", async () => {
    const { generateMcpTools } = await import("./mcp.js");
    await seedSearchCorpus(store);
    const q = generateMcpTools(store).find((t) => t.name === "query-notes")!;
    const absent: any = await q.execute({ search: "fox", tag: "entity", include_content: true });
    const sub: any = await q.execute({ search: "fox", tag: "entity", expand: "subtypes", include_content: true });
    const absentSet = new Set(absent.map((n: any) => n.content));
    expect(new Set(sub.map((n: any) => n.content))).toEqual(absentSet);
    expect(absentSet).toEqual(new Set(["fox literal", "fox subtype"]));
  });

  it("search + tag + expand=namespace returns lexical tag/*, NOT subtype sibling", async () => {
    const { generateMcpTools } = await import("./mcp.js");
    await seedSearchCorpus(store);
    const q = generateMcpTools(store).find((t) => t.name === "query-notes")!;
    const res: any = await q.execute({ search: "fox", tag: "entity", expand: "namespace", include_content: true });
    expect(new Set(res.map((n: any) => n.content))).toEqual(new Set(["fox literal", "fox filed"]));
  });

  it("search + tag + expand=exact returns only the literal-tagged match", async () => {
    const { generateMcpTools } = await import("./mcp.js");
    await seedSearchCorpus(store);
    const q = generateMcpTools(store).find((t) => t.name === "query-notes")!;
    const res: any = await q.execute({ search: "fox", tag: "entity", expand: "exact", include_content: true });
    expect(res.map((n: any) => n.content)).toEqual(["fox literal"]);
  });

  it("search + expand=bogus is rejected with INVALID_QUERY before the search runs", async () => {
    const { generateMcpTools } = await import("./mcp.js");
    await store.createNote("fox here", { tags: ["entity"] });
    const q = generateMcpTools(store).find((t) => t.name === "query-notes")!;
    let err: any;
    try {
      await q.execute({ search: "fox", tag: "entity", expand: "bogus" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe("INVALID_QUERY");
  });
});
