/**
 * Contract suite — search (Wave 1's findings, Wave 3's fix — Reliability &
 * Usability Program, umbrella #556, WS2A #551). Encodes the 2026-07-09
 * nine-persona deep test's search findings as executable tests: PASSING
 * tests lock in behavior that is correct today; the #551 `test.todo`
 * entries this file used to carry have all been flipped to real assertions
 * against the literal-by-default fix (escaping, `search_mode: "advanced"`,
 * honored `sort`, structured `invalid_search_syntax`) — see #551 for the
 * full write-up. Covers `src/routes.ts` (the REST surface) plus a handful
 * of MCP-parity checks (`core/src/mcp.ts`) where the two surfaces share one
 * implementation (`core/src/notes.ts` `searchNotes` + `core/src/search-
 * query.ts`) and a REST-only test wouldn't prove the MCP side actually got
 * the fix — mirrors the pattern in `contract-honest-queries.test.ts`.
 *
 * Ground truth for every assertion here was re-verified live against this
 * repo's FTS5 search path (`core/src/notes.ts` searchNotes → REST `GET
 * /notes?search=`) before writing — see the PR description for the probe
 * transcript.
 */

import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleNotes } from "./routes.ts";
import { generateMcpTools } from "../core/src/mcp.ts";

let db: Database;
let store: BunStore;

const BASE = "http://localhost/api";

function search(qs: string): Promise<Response> {
  return handleNotes(new Request(`${BASE}/notes?${qs}`, { method: "GET" }), store, "");
}

/** Decode the `X-Parachute-Warnings` header (vault#550 — percent-encoded JSON; see `jsonWithWarnings` in routes.ts). */
function decodeWarningsHeader(res: Response): any[] | null {
  const raw = res.headers.get("X-Parachute-Warnings");
  if (!raw) return null;
  return JSON.parse(decodeURIComponent(raw));
}

/** Planted corpus — each note exists to exercise exactly one FTS5 quirk. */
const NOTES = {
  hyphenPhrase: "The rollout had an eleven-day capping delay before it shipped.",
  contraction: "She said she didn't know about the capping delay.",
  decimal: "The measurement came out to 18.6 percent this quarter.",
  bothWords: "A plain keyword note about widgets and gadgets.",
  widgetsOnly: "Only widgets here, no other word.",
  gadgetsOnly: "Gadgets alone, nothing else notable.",
  filler1: "Quarterly report drafted for the finance team.",
  filler2: "Meeting notes from the Tuesday standup.",
  filler3: "Grocery list: eggs, bread, oat milk.",
  filler4: "Project plan for the Q3 roadmap.",
  filler5: "Weekly retro: wins and blockers for the sprint.",
  filler6: "Random thoughts on the trip itinerary.",
};

beforeEach(async () => {
  db = new Database(":memory:");
  store = new BunStore(db);
  for (const content of Object.values(NOTES)) {
    await store.createNote(content);
  }
});

afterEach(() => {
  db.close();
});

async function bodyOf(res: Response): Promise<any> {
  return res.json();
}

describe("contract: search — passing (lock in current behavior)", () => {
  it("plain keyword search finds the matching notes", async () => {
    const res = await search("search=widgets&include_content=true");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const contents = new Set(body.map((n: any) => n.content));
    expect(contents.has(NOTES.bothWords)).toBe(true);
    expect(contents.has(NOTES.widgetsOnly)).toBe(true);
    expect(contents.has(NOTES.gadgetsOnly)).toBe(false);
  });

  it("two-word unquoted search is implicit AND — only the note containing BOTH terms matches", async () => {
    const res = await search("search=widgets+gadgets&include_content=true");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.bothWords]);
  });

  // The next three tests manually quote the search string, expecting raw
  // FTS5 phrase syntax to be honored. That's advanced-mode behavior as of
  // #551 (literal-by-default escapes a caller's own `"` characters as
  // ordinary content instead of honoring them as phrase syntax) — updated
  // to pass `search_mode: "advanced"` explicitly. (Note for reviewers:
  // empirically the bare literal-mode escaping of these SAME manually-
  // quoted strings still resolves to the identical result set for this
  // corpus — FTS5's tokenizer strips the embedded `"` characters the same
  // way it strips other punctuation — but the semantic guarantee these
  // tests were written to pin (phrase ADJACENCY honored as syntax) only
  // holds under advanced mode; literal mode no longer enforces adjacency
  // at all, it just happens to agree here because no other note contains
  // a subset of the same words. See #551 test coverage for the literal-
  // mode equivalents of these same strings, unquoted, further down.)
  it('quoted phrase finds hyphenated phrase text: "eleven-day capping delay" (search_mode: "advanced")', async () => {
    const res = await search(`search=${encodeURIComponent('"eleven-day capping delay"')}&search_mode=advanced&include_content=true`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.hyphenPhrase]);
  });

  it('quoted decimal literal finds it: "18.6" (search_mode: "advanced")', async () => {
    const res = await search(`search=${encodeURIComponent('"18.6"')}&search_mode=advanced&include_content=true`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.decimal]);
  });

  it('quoted contraction finds it: "didn\'t" (search_mode: "advanced")', async () => {
    const res = await search(`search=${encodeURIComponent(`"didn't"`)}&search_mode=advanced&include_content=true`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.contraction]);
  });

  it("unknown-word search returns []", async () => {
    const res = await search("search=zzzznonexistentword&include_content=true");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toEqual([]);
  });
});

describe("contract: search composes with structured filters (vault#647)", () => {
  it("REST ?search= + exclude_tag drops notes that carry the excluded tag", async () => {
    await store.createNote("unique-647-term keep", { tags: ["keep-tag"] });
    await store.createNote("unique-647-term drop", { tags: ["keep-tag", "drop-tag"] });
    const res = await search("search=unique-647-term&tag=keep-tag&exclude_tag=drop-tag&include_content=true");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const contents = body.map((n: any) => n.content);
    expect(contents).toContain("unique-647-term keep");
    expect(contents).not.toContain("unique-647-term drop");
  });

  it("REST ?search= + meta[created_at][gte] drops notes below the date floor", async () => {
    // REST removed the flat date_from param at 0.6.4; the live date grammar
    // is bracket-style. Same composition hole as MCP date_from.
    await store.createNote("unique-647-date recent", {
      tags: ["keep-tag"],
      created_at: "2026-07-01T00:00:00.000Z",
    });
    await store.createNote("unique-647-date old", {
      tags: ["keep-tag"],
      created_at: "2023-06-01T00:00:00.000Z",
    });
    const res = await search(
      "search=unique-647-date&tag=keep-tag&meta[created_at][gte]=2026-06-01&include_content=true",
    );
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const contents = body.map((n: any) => n.content);
    expect(contents).toContain("unique-647-date recent");
    expect(contents).not.toContain("unique-647-date old");
  });

  it("REST ?search= + exclude_path_prefix drops matching paths (vault#628)", async () => {
    await store.createNote("unique-628-search-term keep", { path: "Projects/a" });
    await store.createNote("unique-628-search-term drop", { path: ".parachute/notes/settings" });
    const res = await search(
      "search=unique-628-search-term&exclude_path_prefix=.parachute/&include_content=true",
    );
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const contents = body.map((n: any) => n.content);
    expect(contents).toContain("unique-628-search-term keep");
    expect(contents).not.toContain("unique-628-search-term drop");
  });
});

describe('contract: search — literal-by-default (#551, flipped from todo)', () => {
  it(`unquoted search "didn't" finds the contraction content (literal-by-default — the bare apostrophe used to split into two AND'd tokens and return [])`, async () => {
    const res = await search(`search=${encodeURIComponent("didn't")}&include_content=true`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.contraction]);
  });

  it(`unquoted search "eleven-day capping delay" finds the hyphenated-phrase note (literal-by-default — the bare hyphenated word used to tokenize into a NOT-operator and return [])`, async () => {
    const res = await search(`search=${encodeURIComponent("eleven-day capping delay")}&include_content=true`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.hyphenPhrase]);
  });

  it(`unquoted search "18.6" finds the decimal note (literal-by-default — the bare decimal used to break the FTS5 parse and return [])`, async () => {
    const res = await search(`search=${encodeURIComponent("18.6")}&include_content=true`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.decimal]);
  });

  it('search_mode:"advanced" preserves raw FTS5 query syntax (boolean AND/NOT, prefix *)', async () => {
    const and = await bodyOf(
      await search(`search=${encodeURIComponent("widgets AND gadgets")}&search_mode=advanced&include_content=true`),
    );
    expect(and.map((n: any) => n.content)).toEqual([NOTES.bothWords]);

    const not = await bodyOf(
      await search(`search=${encodeURIComponent("widgets NOT gadgets")}&search_mode=advanced&include_content=true`),
    );
    expect(not.map((n: any) => n.content)).toEqual([NOTES.widgetsOnly]);

    const prefix = await bodyOf(
      await search(`search=${encodeURIComponent("wid*")}&search_mode=advanced&include_content=true`),
    );
    const prefixContents = new Set(prefix.map((n: any) => n.content));
    expect(prefixContents.has(NOTES.widgetsOnly)).toBe(true);
    expect(prefixContents.has(NOTES.bothWords)).toBe(true);
    expect(prefixContents.has(NOTES.gadgetsOnly)).toBe(false);
  });

  it('sort:"asc"/"desc" changes result order under search (previously silently ignored — FTS5 rank order won regardless of the sort param)', async () => {
    await store.createNote("sortprobe alpha content", { created_at: "2020-01-01T00:00:00.000Z" });
    await store.createNote("sortprobe beta content", { created_at: "2022-06-15T00:00:00.000Z" });
    await store.createNote("sortprobe gamma content", { created_at: "2024-12-31T00:00:00.000Z" });

    const asc = await bodyOf(await search("search=sortprobe&sort=asc&include_content=true"));
    expect(asc.map((n: any) => n.content)).toEqual([
      "sortprobe alpha content",
      "sortprobe beta content",
      "sortprobe gamma content",
    ]);

    const desc = await bodyOf(await search("search=sortprobe&sort=desc&include_content=true"));
    expect(desc.map((n: any) => n.content)).toEqual([
      "sortprobe gamma content",
      "sortprobe beta content",
      "sortprobe alpha content",
    ]);
  });

  it("malformed FTS syntax under search_mode:\"advanced\" yields a structured 400 invalid_search_syntax error, not a silently swallowed []", async () => {
    const res = await search(`search=${encodeURIComponent('"unbalanced')}&search_mode=advanced`);
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.code).toBe("INVALID_QUERY");
    expect(body.error_type).toBe("invalid_search_syntax");
    expect(body.field).toBe("search");
    expect(body.got).toBe('"unbalanced');
    expect(typeof body.hint).toBe("string");
  });

  it("the SAME malformed string in literal mode (default) returns an honest result, not an error — escaping makes it syntactically valid FTS5", async () => {
    const res = await search(`search=${encodeURIComponent('"unbalanced')}`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  // Review fold: a NUL byte inside a literal-mode token used to crash FTS5's
  // C-string parser (`SQLiteError: unterminated string`) → raw rethrow →
  // unstructured 500. Sanitization (control chars → separators) makes it a
  // normal search. `%00` is the URL-encoding of a NUL byte.
  it("search=hello%00world (NUL byte in a token) does NOT 500 — literal mode cannot throw", async () => {
    await store.createNote("hello world reachable across the NUL split", { tags: ["nul"] });
    const res = await search("search=hello%00world&include_content=true");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(Array.isArray(body)).toBe(true);
    // The NUL split the token into "hello" AND "world" — both searchable —
    // so the planted note (containing both words) is found.
    expect(body.some((n: any) => n.content.includes("hello world reachable"))).toBe(true);
  });

  it("a NUL-only search short-circuits to [] with an empty_search warning, no 500", async () => {
    const res = await search("search=%00");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toEqual([]);
    const warnings = decodeWarningsHeader(res);
    expect(warnings).not.toBeNull();
    expect(warnings!.some((w: any) => w.code === "empty_search")).toBe(true);
  });

  it("sort under search is STABLE at identical created_at (deterministic n.id tiebreaker, both directions)", async () => {
    // Two notes at the SAME millisecond — without the id tiebreaker their
    // relative order would be arbitrary/unstable (review nit).
    const ts = "2023-03-03T03:03:03.030Z";
    await store.createNote("tiebreak content one", { id: "tie-aaa", created_at: ts });
    await store.createNote("tiebreak content two", { id: "tie-bbb", created_at: ts });

    const asc = await bodyOf(await search("search=tiebreak&sort=asc&include_content=true"));
    const ascIds = asc.map((n: any) => n.id);
    // ASC id tiebreaker → tie-aaa before tie-bbb.
    expect(ascIds).toEqual(["tie-aaa", "tie-bbb"]);

    const desc = await bodyOf(await search("search=tiebreak&sort=desc&include_content=true"));
    const descIds = desc.map((n: any) => n.id);
    // DESC id tiebreaker → tie-bbb before tie-aaa (the exact reverse).
    expect(descIds).toEqual(["tie-bbb", "tie-aaa"]);
  });
});

describe("contract: search — escaping edge cases, tag-scope, warnings (#551)", () => {
  it("a double space between tokens still finds the note containing both (whitespace runs collapse)", async () => {
    const res = await search(`search=${encodeURIComponent("widgets    gadgets")}&include_content=true`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.bothWords]);
  });

  it("whitespace-only search short-circuits to [] with an empty_search warning, no FTS5 call/error", async () => {
    const res = await search(`search=${encodeURIComponent("   ")}`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toEqual([]);
    const warnings = decodeWarningsHeader(res);
    expect(warnings).not.toBeNull();
    expect(warnings!.some((w: any) => w.code === "empty_search")).toBe(true);
  });

  it('a quotes-only search (e.g. a lone `"`) short-circuits to [] with an empty_search warning', async () => {
    const res = await search(`search=${encodeURIComponent('"')}`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toEqual([]);
    const warnings = decodeWarningsHeader(res);
    expect(warnings).not.toBeNull();
    expect(warnings!.some((w: any) => w.code === "empty_search")).toBe(true);
  });

  it("tag-filtered search also gets literal escaping (the tag-scoped FTS prepared statement)", async () => {
    await store.createNote(NOTES.hyphenPhrase, { tags: ["probe"] });
    const res = await search(
      `search=${encodeURIComponent("eleven-day capping delay")}&tag=probe&include_content=true`,
    );
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.hyphenPhrase]);
    expect(body[0].tags).toContain("probe");
  });

  it("search_mode without search is a no-op that surfaces an ignored_param warning (structured-query path)", async () => {
    const res = await search("search_mode=advanced");
    expect(res.status).toBe(200);
    const warnings = decodeWarningsHeader(res);
    expect(warnings).not.toBeNull();
    expect(warnings!.some((w: any) => w.code === "ignored_param" && w.param === "search_mode")).toBe(true);
  });

  it("offset alongside search is a no-op that surfaces an ignored_param warning, results unchanged (V1.2)", async () => {
    await store.createNote("findable one", { tags: ["probe"] });
    await store.createNote("findable two", { tags: ["probe"] });

    const plain = await search("search=findable&tag=probe");
    const withOffset = await search("search=findable&tag=probe&offset=1");
    expect(withOffset.status).toBe(200);

    const plainBody = await bodyOf(plain);
    const offsetBody = await bodyOf(withOffset);
    // Page 1 either way — offset has no effect on FTS5 relevance ordering.
    expect(offsetBody.map((n: any) => n.id).sort()).toEqual(plainBody.map((n: any) => n.id).sort());

    const warnings = decodeWarningsHeader(withOffset);
    expect(warnings).not.toBeNull();
    expect(warnings!.some((w: any) => w.code === "ignored_param" && w.param === "offset")).toBe(true);

    // No search → no warning (offset only means nothing UNDER search; the
    // structured-query path honors it for real).
    const structuredNoWarning = await search("tag=probe&offset=1");
    const structuredWarnings = decodeWarningsHeader(structuredNoWarning);
    expect(
      structuredWarnings?.some((w: any) => w.code === "ignored_param" && w.param === "offset") ?? false,
    ).toBe(false);
  });

  it("an unrecognized search_mode value is a structured 400 invalid_query", async () => {
    const res = await search("search=widgets&search_mode=bogus");
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.code).toBe("INVALID_QUERY");
    expect(body.error_type).toBe("invalid_query");
    expect(body.field).toBe("search_mode");
    expect(body.got).toBe("bogus");
  });
});

describe("contract: search — recall + ranking legibility (WS2B/C, #551, schema v25)", () => {
  it("a note's TITLE (path) is now searchable — a term appearing ONLY in path, not content", async () => {
    await store.createNote("nothing in this body matches the query term", {
      path: "quarterly-budget-review",
    });
    const res = await search("search=budget&include_content=true");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.some((n: any) => n.path === "quarterly-budget-review")).toBe(true);
  });

  it("a title match outranks a passing body-only mention — legible via the score field", async () => {
    await store.createNote("only a passing mention of espresso here, nothing more", {
      path: "coffee-notes",
    });
    await store.createNote("everything about espresso — brewing, grinding, tasting", {
      path: "espresso",
    });
    const res = await search("search=espresso&include_content=true");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const titleMatchIdx = body.findIndex((n: any) => n.path === "espresso");
    const bodyMatchIdx = body.findIndex((n: any) => n.path === "coffee-notes");
    expect(titleMatchIdx).toBeGreaterThanOrEqual(0);
    expect(bodyMatchIdx).toBeGreaterThanOrEqual(0);
    expect(titleMatchIdx).toBeLessThan(bodyMatchIdx);
    for (const n of body) expect(typeof n.score).toBe("number");
    const scoreOf = (path: string) => body.find((n: any) => n.path === path).score;
    expect(scoreOf("espresso")).toBeGreaterThan(scoreOf("coffee-notes"));
  });

  it("score is present on the LEAN (default, no include_content) shape too", async () => {
    await store.createNote(NOTES.bothWords);
    const res = await search("search=widgets");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.length).toBeGreaterThan(0);
    for (const n of body) expect(typeof n.score).toBe("number");
  });

  it("porter stemming: singular query matches a plural-only body word", async () => {
    await store.createNote("the firefighters responded quickly to the call");
    const res = await search("search=firefighter&include_content=true");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.some((n: any) => n.content.includes("firefighters"))).toBe(true);
  });

  it("a zero-result search with a nearby indexed term surfaces a search_did_you_mean warning", async () => {
    await store.createNote("a note that discusses Vasquez and the incident report");
    const res = await search("search=Vasqez");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toEqual([]);
    const warnings = decodeWarningsHeader(res);
    expect(warnings).not.toBeNull();
    const w = warnings!.find((x: any) => x.code === "search_did_you_mean");
    expect(w).toBeDefined();
    expect(w.did_you_mean).toBe("vasquez");
  });

  it("did_you_mean suggests a real surface word, not a porter stem (vault#570)", async () => {
    // "cactus" is porter-stemmed to "cactu" in notes_fts_vocab — the exact
    // fragment cited as a live bug in issue #570. A close-but-wrong query
    // must resolve back to the dictionary word a user actually typed
    // ("cactus"), not the truncated stem.
    await store.createNote("A desert cactus stores water efficiently.");
    const res = await search("search=cactuz");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toEqual([]);
    const warnings = decodeWarningsHeader(res);
    expect(warnings).not.toBeNull();
    const w = warnings!.find((x: any) => x.code === "search_did_you_mean");
    expect(w).toBeDefined();
    expect(w.did_you_mean).toBe("cactus");
  });

  it("a genuinely zero-result search with NO close vocabulary match carries no did_you_mean warning", async () => {
    await store.createNote(NOTES.bothWords);
    const res = await search("search=zzzznonexistentword");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toEqual([]);
    const warnings = decodeWarningsHeader(res);
    if (warnings) {
      expect(warnings.some((w: any) => w.code === "search_did_you_mean")).toBe(false);
    }
  });

  it("did_you_mean is suppressed for a tag-scoped session (no leak of vault-wide vocabulary)", async () => {
    // Out-of-scope note carries the near-match term; the scoped token's
    // own allowlist ("health") sees nothing else. The did_you_mean
    // suggestion is computed against the WHOLE vault's FTS5 vocabulary
    // regardless of scope, so a scoped caller must never see it — same
    // "no leak" stance as `unknown_tag`'s did_you_mean.
    await store.createNote("a note that discusses Vasquez and the incident report", { tags: ["work"] });
    const scopedReq = new Request(`${BASE}/notes?search=Vasqez`, { method: "GET" });
    const res = await handleNotes(scopedReq, store, "", undefined, {
      allowed: new Set(["health"]),
      raw: ["health"],
    });
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toEqual([]);
    const warnings = decodeWarningsHeader(res);
    expect(warnings?.some((w: any) => w.code === "search_did_you_mean")).toBeFalsy();
  });

  it('search_mode:"advanced" — a lone leading hyphen gets a caller-actionable hint, not raw "no such column" text', async () => {
    await store.createNote("espresso and coffee content");
    const res = await search(`search=${encodeURIComponent("-espresso")}&search_mode=advanced`);
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.code).toBe("INVALID_QUERY");
    expect(body.error_type).toBe("invalid_search_syntax");
    expect(typeof body.hint).toBe("string");
    expect(body.hint).toMatch(/BINARY operator/i);
    expect(body.hint).not.toMatch(/^no such column/i);
  });
});

describe("contract: search — MCP parity (#551)", () => {
  it("query-notes: literal-by-default finds punctuation content the same as REST", async () => {
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ search: "didn't", include_content: true })) as any[];
    expect(result.map((n: any) => n.content)).toEqual([NOTES.contraction]);
  });

  it("query-notes: search_mode validation rejects an unknown value", async () => {
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    await expect(query.execute({ search: "widgets", search_mode: "bogus" })).rejects.toThrow(/search_mode/);
  });

  it("query-notes: search_mode without search surfaces an ignored_param warning", async () => {
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ search_mode: "advanced" })) as any;
    expect(result.warnings).toBeDefined();
    expect(result.warnings.some((w: any) => w.code === "ignored_param" && w.param === "search_mode")).toBe(true);
  });

  it("query-notes: offset alongside search is a no-op that surfaces an ignored_param warning (V1.2)", async () => {
    await store.createNote("mcp findable", { tags: ["probe"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ search: "findable", offset: 5 })) as any;
    expect(result.warnings).toBeDefined();
    expect(result.warnings.some((w: any) => w.code === "ignored_param" && w.param === "offset")).toBe(true);

    // Structured query (no search) — offset is honored for real, no warning.
    const structured = (await query.execute({ tag: "probe", offset: 0 })) as any;
    expect(
      (structured.warnings ?? []).some((w: any) => w.code === "ignored_param" && w.param === "offset"),
    ).toBe(false);
  });

  it("query-notes: search_mode:\"advanced\" + malformed syntax throws a structured invalid_search_syntax error", async () => {
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    await expect(
      query.execute({ search: '"unbalanced', search_mode: "advanced" }),
    ).rejects.toMatchObject({ error_type: "invalid_search_syntax" });
  });

  it("query-notes: sort:\"asc\"/\"desc\" changes order under search (parity with REST)", async () => {
    await store.createNote("mcpsortprobe alpha", { created_at: "2020-01-01T00:00:00.000Z" });
    await store.createNote("mcpsortprobe beta", { created_at: "2024-01-01T00:00:00.000Z" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const asc = (await query.execute({ search: "mcpsortprobe", sort: "asc", include_content: true })) as any[];
    expect(asc.map((n: any) => n.content)).toEqual(["mcpsortprobe alpha", "mcpsortprobe beta"]);
    const desc = (await query.execute({ search: "mcpsortprobe", sort: "desc", include_content: true })) as any[];
    expect(desc.map((n: any) => n.content)).toEqual(["mcpsortprobe beta", "mcpsortprobe alpha"]);
  });

  it("query-notes: title match outranks a body-only mention, and results carry a score (parity with REST)", async () => {
    await store.createNote("only a passing mention of espresso here, nothing more", { path: "coffee-notes" });
    await store.createNote("everything about espresso — brewing, grinding, tasting", { path: "espresso" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ search: "espresso" })) as any[];
    const titleIdx = result.findIndex((n: any) => n.path === "espresso");
    const bodyIdx = result.findIndex((n: any) => n.path === "coffee-notes");
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(titleIdx).toBeLessThan(bodyIdx);
    for (const n of result) expect(typeof n.score).toBe("number");
  });

  it("query-notes: a note's title (path) is searchable (parity with REST)", async () => {
    await store.createNote("nothing in this body matches the query term", { path: "quarterly-budget-review" });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ search: "budget" })) as any[];
    expect(result.some((n: any) => n.path === "quarterly-budget-review")).toBe(true);
  });

  it("query-notes: porter stemming matches a plural-only body word (parity with REST)", async () => {
    await store.createNote("the firefighters responded quickly to the call");
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ search: "firefighter", include_content: true })) as any[];
    expect(result.some((n: any) => n.content.includes("firefighters"))).toBe(true);
  });

  it("query-notes: zero-result search with a nearby indexed term surfaces search_did_you_mean", async () => {
    await store.createNote("a note that discusses Vasquez and the incident report");
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    const result = (await query.execute({ search: "Vasqez" })) as any;
    // Zero notes + a non-empty warnings array — per the response-shape
    // contract (vault#550) that's the `{notes, warnings}` envelope, not a
    // bare array (a bare array can't carry `warnings` at all).
    expect(Array.isArray(result)).toBe(false);
    expect(result.notes).toEqual([]);
    expect(result.warnings).toBeDefined();
    const w = result.warnings.find((x: any) => x.code === "search_did_you_mean");
    expect(w).toBeDefined();
    expect(w.did_you_mean).toBe("vasquez");
  });

  it('query-notes: search_mode:"advanced" — a lone leading hyphen gets a caller-actionable hint, not raw "no such column" text', async () => {
    await store.createNote("espresso and coffee content");
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    let err: any;
    try {
      await query.execute({ search: "-espresso", search_mode: "advanced" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.error_type).toBe("invalid_search_syntax");
    expect(typeof err.hint).toBe("string");
    expect(err.hint).toMatch(/BINARY operator/i);
    expect(err.hint).not.toMatch(/^no such column/i);
  });
});
