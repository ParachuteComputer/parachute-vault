/**
 * Contract suite — error taxonomy at the REST boundary (Wave 1 of the
 * Reliability & Usability Program, umbrella #556). Encodes the 2026-07-09
 * nine-persona deep test's WS5 findings (#554) as executable tests: PASSING
 * tests lock in the structured-error precedents that already exist
 * (`path_conflict`, `conflict` with current/expected timestamps,
 * `precondition_required`, `schema_validation`); `test.todo` entries
 * describe the target behavior for confirmed-broken cases, to be flipped to
 * real assertions in a later wave. See #554 for the full write-up.
 */

import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleNotes } from "./routes.ts";

let db: Database;
let store: BunStore;

const BASE = "http://localhost/api";

function post(body: unknown): Promise<Response> {
  return handleNotes(
    new Request(`${BASE}/notes`, { method: "POST", body: JSON.stringify(body) }),
    store,
    "",
  );
}

function patch(id: string, body: unknown): Promise<Response> {
  return handleNotes(
    new Request(`${BASE}/notes/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    store,
    `/${id}`,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  store = new BunStore(db);
});

afterEach(() => {
  db.close();
});

describe("contract: error taxonomy — passing (lock in existing structured precedents)", () => {
  it("creating a note at a path that's already taken returns 409 path_conflict", async () => {
    await store.createNote("first", { path: "taken" });
    const res = await post({ content: "second", path: "taken" });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error_type).toBe("path_conflict");
    expect(body.path).toBe("taken");
  });

  it("updating with a stale if_updated_at returns 409 conflict carrying current_updated_at + your_updated_at", async () => {
    const note = await store.createNote("original", { id: "n1" });
    const res = await patch(note.id, { content: "changed", if_updated_at: "2020-01-01T00:00:00.000Z" });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error_type).toBe("conflict");
    expect(body.current_updated_at).toBe(note.updatedAt);
    expect(body.your_updated_at).toBe("2020-01-01T00:00:00.000Z");
  });

  it("a strict schema violation on write returns 422 schema_validation naming every violation", async () => {
    await store.upsertTagRecord("strict-status", {
      fields: { status: { type: "string", enum: ["active", "archived"], strict: true } },
    });
    const res = await post({ content: "x", tags: ["strict-status"], metadata: { status: "bogus" } });
    expect(res.status).toBe(422);
    const body: any = await res.json();
    expect(body.error_type).toBe("schema_validation");
    expect(Array.isArray(body.violations)).toBe(true);
    expect(body.violations.length).toBeGreaterThan(0);
    expect(body.violations[0].field).toBe("status");
    expect(body.violations[0].reason).toBe("enum_mismatch");
  });

  it("updating a note without if_updated_at or force returns 428 precondition_required", async () => {
    const note = await store.createNote("original", { id: "n1" });
    const res = await patch(note.id, { content: "changed, no precondition" });
    expect(res.status).toBe(428);
    const body: any = await res.json();
    expect(body.error_type).toBe("precondition_required");
    expect(body.note_id).toBe(note.id);
  });
});

describe("contract: error taxonomy — todo (#554)", () => {
  test.todo(
    "#554: every error response carries a structured {error_type, hint} pair — today error_type exists on many paths but no response carries a `hint` field, and some error paths (e.g. bad_request/ambiguous/unprocessable_content in the PATCH content_edit branch) are still bare {error, message} strings with no error_type at all",
  );
  test.todo(
    "#554: batch update-note honors a top-level `force` (or `if_updated_at`) applied per-item — today the batch entry point does `items = batch ?? [params]`, so a top-level force:true on the request never reaches the per-item precondition check (core/src/mcp.ts ~line 1114 reads item.force only) and each item without its OWN force/if_updated_at still throws precondition_required",
  );
});
