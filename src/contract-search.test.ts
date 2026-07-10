/**
 * Contract suite — search (Wave 1 of the Reliability & Usability Program,
 * umbrella #556). Encodes the 2026-07-09 nine-persona deep test's search
 * findings (WS2, #551) as executable tests: PASSING tests lock in behavior
 * that is correct today; `test.todo` entries describe the target behavior
 * for confirmed-broken cases, to be flipped to real assertions in a later
 * wave. See #551 for the full write-up.
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

let db: Database;
let store: BunStore;

const BASE = "http://localhost/api";

function search(qs: string): Promise<Response> {
  return handleNotes(new Request(`${BASE}/notes?${qs}`, { method: "GET" }), store, "");
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

  it('quoted phrase finds hyphenated phrase text: "eleven-day capping delay"', async () => {
    const res = await search(`search=${encodeURIComponent('"eleven-day capping delay"')}&include_content=true`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.hyphenPhrase]);
  });

  it('quoted decimal literal finds it: "18.6"', async () => {
    const res = await search(`search=${encodeURIComponent('"18.6"')}&include_content=true`);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.map((n: any) => n.content)).toEqual([NOTES.decimal]);
  });

  it('quoted contraction finds it: "didn\'t"', async () => {
    const res = await search(`search=${encodeURIComponent(`"didn't"`)}&include_content=true`);
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

describe("contract: search — todo (#551, literal-by-default + recall + ranking)", () => {
  test.todo(
    `#551: unquoted search: "didn't" finds the contraction content (literal-by-default — today the bare apostrophe splits into two AND'd tokens and returns [])`,
  );
  test.todo(
    `#551: unquoted search: "eleven-day capping delay" finds the hyphenated-phrase note (literal-by-default — today the bare hyphenated word tokenizes into separate AND'd terms and returns [])`,
  );
  test.todo(
    `#551: unquoted search: "18.6" finds the decimal note (literal-by-default — today the bare decimal tokenizes into separate AND'd terms and returns [])`,
  );
  test.todo(
    `#551: search_mode:"advanced" preserves raw FTS5 query syntax (AND/OR/NOT, phrase, prefix) once literal-by-default escaping ships as the new default`,
  );
  test.todo(
    `#551: sort:"asc"/"desc" changes result order under search (today silently ignored — FTS5 rank order wins regardless of the sort param)`,
  );
  test.todo(
    `#551: malformed FTS syntax (e.g. an unbalanced quote) yields a structured warning or error, not a silently swallowed [] (today searchNotes catches every FTS5 syntax error and returns [])`,
  );
});
