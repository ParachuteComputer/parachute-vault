/**
 * Contract suite — honest queries at the REST + MCP boundary (Wave 1's
 * findings, Wave 2's fixes — Reliability & Usability Program, umbrella
 * #556). Encodes the 2026-07-09 nine-persona deep test's WS1 findings
 * (#550) as executable tests: PASSING tests lock in behavior that is
 * correct today; the #550 `test.todo` entries this file used to carry have
 * all been flipped to real assertions against the WS1 fixes (warnings
 * channel, structured invalids, cursor bootstrap, tags 404, expanded_count)
 * — see #550 for the full write-up. Covers `src/routes.ts` (the REST
 * surface) plus a handful of MCP-parity checks (`core/src/mcp.ts`) where
 * the two surfaces share one implementation and a REST-only test wouldn't
 * prove the MCP side actually got the fix.
 */

import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleNotes, handleTags, handleFindPath } from "./routes.ts";
import { generateMcpTools } from "../core/src/mcp.ts";

let db: Database;
let store: BunStore;

const BASE = "http://localhost/api";

function getNotes(qs: string): Promise<Response> {
  return handleNotes(new Request(`${BASE}/notes?${qs}`, { method: "GET" }), store, "");
}

function getTags(qs: string): Promise<Response> {
  return handleTags(new Request(`${BASE}/tags?${qs}`, { method: "GET" }), store, "");
}

function getTagByName(name: string): Promise<Response> {
  return handleTags(new Request(`${BASE}/tags/${name}`, { method: "GET" }), store, `/${name}`);
}

function findPath(source: string, target: string): Promise<Response> {
  return handleFindPath(new Request(`${BASE}/find-path?source=${source}&target=${target}`, { method: "GET" }), store);
}

/** Decode the `X-Parachute-Warnings` header (vault#550 — percent-encoded JSON; see `jsonWithWarnings` in routes.ts). */
function decodeWarningsHeader(res: Response): any[] | null {
  const raw = res.headers.get("X-Parachute-Warnings");
  if (!raw) return null;
  return JSON.parse(decodeURIComponent(raw));
}

beforeEach(() => {
  db = new Database(":memory:");
  store = new BunStore(db);
});

afterEach(() => {
  db.close();
});

describe("contract: honest queries — passing (lock in current behavior)", () => {
  it("querying a nonexistent tag returns 200 with an empty array, not an error", async () => {
    const res = await getNotes("tag=zzznonexistenttag");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Shape may gain a `warnings` HEADER (vault#550, additive) — assert
    // only status + array shape here so the header addition doesn't break
    // this contract test. The header itself is exercised below.
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  it("a metadata operator query on a non-indexed field errors loudly with FIELD_NOT_INDEXED (existing behavior)", async () => {
    const res = await getNotes("meta[not_a_real_field][gt]=5");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.code).toBe("FIELD_NOT_INDEXED");
  });

  it("a `near` query against a nonexistent anchor note errors cleanly with 404, not a silent []", async () => {
    const res = await getNotes("near[note_id]=does-not-exist");
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error).toBeDefined();
    expect(body.note_id).toBe("does-not-exist");
  });

  // The cursor-bootstrap fix (vault#550) means `cursor` is now keyed on
  // PRESENCE, not truthiness — `?cursor=` (present, empty) now engages the
  // envelope (see the "cursor bootstrap" test below). An OMITTED `cursor`
  // param is a completely different thing — no pagination intent at all —
  // and still returns today's flat array. This test pins that omission
  // case specifically, distinct from bootstrap.
  it("a cursor-less limit query (cursor param OMITTED entirely) returns a flat array", async () => {
    await store.createNote("only note");
    const res = await getNotes("limit=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("contract: honest queries — structured invalids (#550)", () => {
  it("limit=-1 returns a structured invalid_query error instead of silently meaning \"unlimited\"", async () => {
    await store.createNote("a note");
    const res = await getNotes("limit=-1");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error_type).toBe("invalid_query");
    expect(body.field).toBe("limit");
    expect(body.got).toBe("-1");
    expect(typeof body.hint).toBe("string");
  });

  it("limit=abc (non-numeric) returns invalid_query instead of silently falling back to the default", async () => {
    const res = await getNotes("limit=abc");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error_type).toBe("invalid_query");
    expect(body.field).toBe("limit");
    expect(body.got).toBe("abc");
  });

  it("offset=-1 (negative offset) returns a structured invalid_query error", async () => {
    const res = await getNotes("offset=-1");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error_type).toBe("invalid_query");
    expect(body.field).toBe("offset");
    expect(body.got).toBe("-1");
    expect(typeof body.hint).toBe("string");
  });

  it("an unparseable date value in a bracket date filter returns invalid_query instead of silently matching nothing or everything", async () => {
    const res = await getNotes("meta[created_at][gte]=not-a-real-date");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error_type).toBe("invalid_query");
    expect(body.got).toBe("not-a-real-date");
    expect(typeof body.hint).toBe("string");
    expect(body.hint.toLowerCase()).toContain("iso");
  });

  it("a malformed cursor's error message states the bootstrap flow explicitly", async () => {
    const res = await getNotes("cursor=not-a-valid-cursor!!!");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.code).toBe("cursor_invalid");
    // Must name the recovery flow, not just "this is broken" — the P1
    // fix's whole point is that the bootstrap shape is DISCOVERABLE from
    // the error, not just from documentation the caller may never read.
    expect(body.error).toContain('cursor:""');
    expect(body.error.toLowerCase()).toContain("next_cursor");
  });
});

describe("contract: honest queries — warnings channel (#550)", () => {
  it("an unrecognized tag surfaces an unknown_tag warning (with did_you_mean) via the X-Parachute-Warnings header, bare-array body unchanged", async () => {
    await store.createNote("a note", { tags: ["project"] });
    const res = await getNotes("tag=projet"); // typo: missing the second "c"
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true); // shape stays a bare array
    expect(body).toEqual([]); // the typo'd tag genuinely matches nothing

    const warnings = decodeWarningsHeader(res);
    expect(warnings).not.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings![0].code).toBe("unknown_tag");
    expect(warnings![0].tag).toBe("projet");
    expect(warnings![0].did_you_mean).toBe("project");
  });

  it("a tag that has notes via subtype expansion (a real descendant) does NOT warn, even though the literal tag has zero direct matches", async () => {
    await store.upsertTagRecord("child", { parent_names: ["parent"] });
    await store.createNote("a note", { tags: ["child"] });
    const res = await getNotes("tag=parent");
    expect(res.status).toBe(200);
    const warnings = decodeWarningsHeader(res);
    expect(warnings).toBeNull(); // "parent" resolves via expansion — not unknown
  });

  it("the flat date_field/date_from/date_to params (removed at 0.6.4) surface a removed_param warning per param, still silently ignored in the result set", async () => {
    await store.createNote("in range", { created_at: "2020-06-01T00:00:00.000Z" });
    await store.createNote("out of range", { created_at: "2099-01-01T00:00:00.000Z" });
    const res = await getNotes("date_field=created_at&date_from=2020-01-01&date_to=2020-12-31");
    expect(res.status).toBe(200);
    const body: any[] = await res.json();
    // Still unfiltered (existing behavior — bracket-style is the only
    // supported date filter now; this locks in that the ignoring itself
    // didn't change, only that it's no longer SILENT). Both notes come
    // back even though `out of range` sits well outside the requested
    // window — proof the flat params never touched the query.
    expect(body.length).toBe(2);

    const warnings = decodeWarningsHeader(res);
    expect(warnings).not.toBeNull();
    const codes = warnings!.map((w) => w.code);
    expect(codes.filter((c) => c === "removed_param")).toHaveLength(3);
    const params = warnings!.filter((w) => w.code === "removed_param").map((w) => w.param).sort();
    expect(params).toEqual(["date_field", "date_from", "date_to"]);
  });

  it("cursor mode carries warnings INLINE in the envelope (in addition to the header)", async () => {
    const res = await getNotes("cursor=&tag=doesnotexist");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.notes)).toBe(true);
    expect(typeof body.next_cursor).toBe("string");
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings[0].code).toBe("unknown_tag");
    // header present too, same content
    const headerWarnings = decodeWarningsHeader(res);
    expect(headerWarnings).toEqual(body.warnings);
  });

  it("format=graph carries warnings INLINE in the {nodes, edges} envelope (in addition to the header)", async () => {
    await store.createNote("a note", { tags: ["real"] });
    const res = await getNotes("format=graph&tag=doesnotexist");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings[0].code).toBe("unknown_tag");
    const headerWarnings = decodeWarningsHeader(res);
    expect(headerWarnings).toEqual(body.warnings);
  });

  it("format=graph with no warnings carries NO warnings key and no header (shape unchanged)", async () => {
    await store.createNote("a note", { tags: ["real"] });
    const res = await getNotes("format=graph&tag=real");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.warnings).toBeUndefined();
    expect(res.headers.get("X-Parachute-Warnings")).toBeNull();
  });

  it("unknown_tag warnings are capped at 8 with a warnings_truncated marker (garbage tags array can't inflate the header unboundedly)", async () => {
    const junkTags = Array.from({ length: 12 }, (_, i) => `zz-junk-tag-${i}`);
    const res = await getNotes(`tag=${junkTags.join(",")}`);
    expect(res.status).toBe(200);
    const warnings = decodeWarningsHeader(res);
    expect(warnings).not.toBeNull();
    const unknown = warnings!.filter((w) => w.code === "unknown_tag");
    const truncated = warnings!.filter((w) => w.code === "warnings_truncated");
    expect(unknown).toHaveLength(8);
    expect(truncated).toHaveLength(1);
    expect(truncated[0].suppressed).toBe(4); // 12 junk tags − 8 reported
    expect(truncated[0].limit).toBe(8);
  });
});

describe("contract: truncation-honesty warning (V1.3)", () => {
  it("a structured non-cursor list that hits its limit carries a `truncated` warning", async () => {
    for (let i = 0; i < 3; i++) await store.createNote(`note ${i}`);
    const res = await getNotes("limit=2");
    expect(res.status).toBe(200);
    const body: any[] = await res.json();
    expect(body.length).toBe(2); // the limit itself is unaffected — warning only
    const warnings = decodeWarningsHeader(res);
    expect(warnings).not.toBeNull();
    const truncated = warnings!.find((w) => w.code === "truncated");
    expect(truncated).toBeDefined();
    expect(truncated.limit).toBe(2);
  });

  it("an under-limit list carries no `truncated` warning", async () => {
    await store.createNote("only one");
    const res = await getNotes("limit=50");
    expect(res.status).toBe(200);
    const warnings = decodeWarningsHeader(res);
    expect(warnings?.some((w) => w.code === "truncated") ?? false).toBe(false);
  });

  it("cursor mode never carries a `truncated` warning — `next_cursor` is already the honest signal", async () => {
    for (let i = 0; i < 3; i++) await store.createNote(`note ${i}`);
    const res = await getNotes("limit=2&cursor=");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.notes.length).toBe(2);
    expect(typeof body.next_cursor).toBe("string");
    expect((body.warnings ?? []).some((w: any) => w.code === "truncated")).toBe(false);
  });

  it("MCP query-notes mirrors the same truncated warning on a limit-hit non-cursor list", async () => {
    for (let i = 0; i < 3; i++) await store.createNote(`mcp note ${i}`);
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ limit: 2 })) as any;
    expect(result.warnings).toBeDefined();
    expect(result.warnings.some((w: any) => w.code === "truncated" && w.limit === 2)).toBe(true);
  });
});

describe("contract: honest queries — cursor bootstrap (#550, the P1)", () => {
  it("an empty cursor (`?cursor=`) engages the {notes, next_cursor} envelope on the VERY FIRST call, and the returned next_cursor sees only notes written after it", async () => {
    const n1 = await store.createNote("existing note");

    const first = await getNotes("cursor=");
    expect(first.status).toBe(200);
    const firstBody: any = await first.json();
    expect(Array.isArray(firstBody)).toBe(false);
    expect(Array.isArray(firstBody.notes)).toBe(true);
    expect(firstBody.notes.map((n: any) => n.id)).toEqual([n1.id]);
    expect(typeof firstBody.next_cursor).toBe("string");
    expect(firstBody.next_cursor.length).toBeGreaterThan(0);

    const n2 = await store.createNote("new note");
    const second = await getNotes(`cursor=${encodeURIComponent(firstBody.next_cursor)}`);
    expect(second.status).toBe(200);
    const secondBody: any = await second.json();
    expect(secondBody.notes.map((n: any) => n.id)).toEqual([n2.id]);
  });

  it("MCP query-notes: cursor: \"\" likewise bootstraps the envelope on the first call", async () => {
    const n1 = await store.createNote("existing note");
    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;

    const first = await queryNotes.execute({ cursor: "" }) as any;
    expect(Array.isArray(first)).toBe(false);
    expect(Array.isArray(first.notes)).toBe(true);
    expect(first.notes.map((n: any) => n.id)).toEqual([n1.id]);
    expect(typeof first.next_cursor).toBe("string");

    const n2 = await store.createNote("new note");
    const second = await queryNotes.execute({ cursor: first.next_cursor }) as any;
    expect(second.notes.map((n: any) => n.id)).toEqual([n2.id]);
  });

  it("omitting `cursor` entirely (MCP) is NOT the same as bootstrapping — no envelope, no next_cursor", async () => {
    await store.createNote("only note");
    const tools = generateMcpTools(store);
    const queryNotes = tools.find((t) => t.name === "query-notes")!;
    const result = await queryNotes.execute({}) as any;
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("contract: honest queries — tags 404 (#550)", () => {
  it("GET /api/tags/{nonexistent} returns 404 tag_not_found instead of a synthesized all-null 200", async () => {
    const res = await getTagByName("zzznonexistenttag");
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error_type).toBe("tag_not_found");
    expect(body.tag).toBe("zzznonexistenttag");
  });

  it("GET /api/tags?tag=<nonexistent> returns the same 404 tag_not_found shape, with did_you_mean when a close match exists", async () => {
    await store.upsertTagRecord("project", {});
    const res = await getTags("tag=projcet"); // transposed letters
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error_type).toBe("tag_not_found");
    expect(body.tag).toBe("projcet");
    expect(body.did_you_mean).toBe("project");
  });

  it("a tag with an identity row but zero notes is still a real 200 (not 404) — an identity row alone is enough", async () => {
    await store.upsertTagRecord("declared-but-unused", { description: "reserved for later" });
    const res = await getTagByName("declared-but-unused");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.count).toBe(0);
    expect(body.expanded_count).toBe(0);
  });

  it("MCP list-tags with a nonexistent tag param returns a structured tag_not_found object (not a thrown error, not a synthesized 200)", async () => {
    const tools = generateMcpTools(store);
    const listTags = tools.find((t) => t.name === "list-tags")!;
    const result = await listTags.execute({ tag: "zzznonexistenttag" }) as any;
    expect(result.error_type).toBe("tag_not_found");
    expect(result.tag).toBe("zzznonexistenttag");
  });
});

describe("contract: honest queries — expanded_count (#550)", () => {
  it("list-tags reports expanded_count reflecting the subtype rollup, while count stays the literal per-tag number", async () => {
    // parent/child fixture: every note is tagged with the CHILD only, so
    // the literal `count` on "parent" is 0 even though every one of those
    // notes IS conceptually a "parent" via the declared hierarchy.
    await store.upsertTagRecord("parent", {});
    await store.upsertTagRecord("child", { parent_names: ["parent"] });
    await store.createNote("n1", { tags: ["child"] });
    await store.createNote("n2", { tags: ["child"] });
    await store.createNote("n3", { tags: ["parent"] }); // also directly tagged

    const res = await getTags("");
    expect(res.status).toBe(200);
    const body: any[] = await res.json();
    const parentRow = body.find((t) => t.name === "parent")!;
    const childRow = body.find((t) => t.name === "child")!;

    expect(parentRow.count).toBe(1); // only n3 carries the literal "parent" tag
    expect(parentRow.expanded_count).toBe(3); // n1, n2 (via child) + n3
    expect(childRow.count).toBe(2);
    expect(childRow.expanded_count).toBe(2); // "child" has no further descendants
  });

  it("GET /api/tags/{name} single-tag detail also carries expanded_count", async () => {
    await store.upsertTagRecord("parent2", {});
    await store.upsertTagRecord("child2", { parent_names: ["parent2"] });
    await store.createNote("n1", { tags: ["child2"] });

    const res = await getTagByName("parent2");
    const body: any = await res.json();
    expect(body.count).toBe(0);
    expect(body.expanded_count).toBe(1);
  });
});

describe("contract: honest queries — find-path hydration (#550, additive)", () => {
  it("REST find-path hydrates `nodes` (id+path) and `edges` (source/target/relationship+paths) alongside the original path/relationships shape", async () => {
    const a = await store.createNote("A", { id: "a", path: "People/Alice" });
    const b = await store.createNote("B", { id: "b" }); // no path set
    const c = await store.createNote("C", { id: "c", path: "Projects/X" });
    await store.createLink("a", "b", "mentions");
    await store.createLink("b", "c", "related-to");

    const res = await findPath("a", "c");
    expect(res.status).toBe(200);
    const body: any = await res.json();

    // Original shape, byte-identical — back-compat.
    expect(body.path).toEqual(["a", "b", "c"]);
    expect(body.relationships).toEqual(["mentions", "related-to"]);

    // Additive hydration.
    expect(body.nodes).toEqual([
      { id: "a", path: "People/Alice" },
      { id: "b", path: null },
      { id: "c", path: "Projects/X" },
    ]);
    expect(body.edges).toEqual([
      { source: "a", target: "b", relationship: "mentions", sourcePath: "People/Alice", targetPath: null },
      { source: "b", target: "c", relationship: "related-to", sourcePath: null, targetPath: "Projects/X" },
    ]);
  });

  it("MCP find-path hydrates the same nodes/edges shape", async () => {
    await store.createNote("A", { id: "a", path: "People/Alice" });
    await store.createNote("B", { id: "b", path: "Projects/X" });
    await store.createLink("a", "b", "mentions");

    const tools = generateMcpTools(store);
    const findPathTool = tools.find((t) => t.name === "find-path")!;
    const result = await findPathTool.execute({ source: "a", target: "b" }) as any;
    expect(result.nodes).toEqual([
      { id: "a", path: "People/Alice" },
      { id: "b", path: "Projects/X" },
    ]);
    expect(result.edges).toEqual([
      { source: "a", target: "b", relationship: "mentions", sourcePath: "People/Alice", targetPath: "Projects/X" },
    ]);
  });
});

describe("contract: metadata always present on the wire (V1.1)", () => {
  it("GET /api/notes?id= on a metadata-less note carries `metadata: {}`, not an absent key", async () => {
    const note = await store.createNote("No metadata here");
    const res = await getNotes(`id=${note.id}`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toHaveProperty("metadata");
    expect(body.metadata).toEqual({});
    // `tags` has always been unconditionally present — confirm it still is.
    expect(body.tags).toEqual([]);
  });

  it("GET /api/notes (list) carries `metadata: {}` on metadata-less entries", async () => {
    await store.createNote("List entry, no metadata");
    const res = await getNotes("");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const entry of body) {
      expect(entry).toHaveProperty("metadata");
      expect(entry.metadata).toEqual({});
    }
  });

  it("GET /api/notes?search= carries `metadata: {}` on metadata-less results", async () => {
    await store.createNote("Findable via search, no metadata");
    const res = await getNotes("search=Findable");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const entry of body) {
      expect(entry).toHaveProperty("metadata");
      expect(entry.metadata).toEqual({});
    }
  });

  it("a note WITH real metadata is unaffected — the fix only changes the empty case", async () => {
    const note = await store.createNote("Has metadata", { metadata: { source: "import" } });
    const res = await getNotes(`id=${note.id}`);
    const body: any = await res.json();
    expect(body.metadata).toEqual({ source: "import" });
  });
});
