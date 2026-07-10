/**
 * Contract suite — honest queries at the REST boundary (Wave 1 of the
 * Reliability & Usability Program, umbrella #556). Encodes the 2026-07-09
 * nine-persona deep test's WS1 findings (#550) as executable tests: PASSING
 * tests lock in behavior that is correct today; `test.todo` entries describe
 * the target behavior for confirmed-broken cases, to be flipped to real
 * assertions in a later wave. See #550 for the full write-up — this file
 * covers the `src/routes.ts` REST surface specifically (the cursor-bootstrap
 * gap lives at routes.ts:1102/1106, the tags/{name} 404 gap at the GET /tags
 * handler in `handleTags`).
 */

import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleNotes, handleTags } from "./routes.ts";

let db: Database;
let store: BunStore;

const BASE = "http://localhost/api";

function getNotes(qs: string): Promise<Response> {
  return handleNotes(new Request(`${BASE}/notes?${qs}`, { method: "GET" }), store, "");
}

function getTags(qs: string): Promise<Response> {
  return handleTags(new Request(`${BASE}/tags?${qs}`, { method: "GET" }), store, "");
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
    // Shape may gain a `warnings` field later (#550) — assert only status +
    // array shape now so that addition doesn't break this contract test.
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

  // removed in W2 — once #550's cursor-bootstrap fix lands, an omitted
  // `cursor` param will (per the documented intent) still return a flat
  // array for callers who never opt into cursor pagination, so this
  // specific assertion should survive; the paired todo below is the one
  // that flips when the bootstrap gap closes. Kept both here so the fix
  // is a conscious, reviewed change rather than an incidental snapshot.
  it("a cursor-less limit query returns a flat array (today's shape) — removed in W2", async () => {
    await store.createNote("only note");
    const res = await getNotes("limit=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("contract: honest queries — todo (#550)", () => {
  test.todo(
    "#550: limit=-1 returns a structured error instead of silently meaning \"unlimited\" (today: SQLite's negative-LIMIT-means-no-limit semantics leak straight through to the caller)",
  );
  test.todo(
    "#550: query responses carry a warnings: [] channel, populated with a did_you_mean suggestion for an unknown tag name",
  );
  test.todo(
    "#550: an invalid date_filter value (unparseable date string) returns a structured error instead of silently matching nothing or everything",
  );
  test.todo(
    "#550: GET /api/tags/{nonexistent} returns 404 instead of 200 with an all-null synthesized record",
  );
  test.todo(
    "#550: list-tags reports expanded_count (rollup through parent_names descendants) alongside the literal per-tag count — today a parent tag with only child-tagged notes reports count: 0",
  );
  test.todo(
    "#550: cursor bootstrap — a first call that expresses cursor intent (no `cursor` param yet, but pagination is desired) returns a {notes, next_cursor} envelope, and a second call passing that cursor back sees only notes written since the first call (today: routes.ts only wraps the response in {notes, next_cursor} when a cursor param is ALREADY present, so the very first call can never obtain one — core/src/mcp.ts:331 documents a bootstrap flow that is not actually reachable)",
  );
});
