/**
 * Contract suite — error taxonomy at the REST boundary (Wave 1 of the
 * Reliability & Usability Program, umbrella #556). Encodes the 2026-07-09
 * nine-persona deep test's WS5 findings (#554) as executable tests: PASSING
 * tests lock in the structured-error precedents that already exist
 * (`path_conflict`, `conflict` with current/expected timestamps,
 * `precondition_required`, `schema_validation`). The Wave 4 (#554) error
 * taxonomy sweep flipped the original `test.todo` entries into real
 * assertions below — see that describe block.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleNotes, handleTags } from "./routes.ts";
import { generateMcpTools, PreconditionRequiredError } from "../core/src/mcp.ts";

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
    expect(typeof body.hint).toBe("string");
  });

  it("updating with a stale if_updated_at returns 409 conflict carrying current_updated_at + your_updated_at", async () => {
    const note = await store.createNote("original", { id: "n1" });
    const res = await patch(note.id, { content: "changed", if_updated_at: "2020-01-01T00:00:00.000Z" });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error_type).toBe("conflict");
    expect(body.current_updated_at).toBe(note.updatedAt);
    expect(body.your_updated_at).toBe("2020-01-01T00:00:00.000Z");
    expect(typeof body.hint).toBe("string");
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
    expect(typeof body.hint).toBe("string");
  });

  it("updating a note without if_updated_at or force returns 428 precondition_required", async () => {
    const note = await store.createNote("original", { id: "n1" });
    const res = await patch(note.id, { content: "changed, no precondition" });
    expect(res.status).toBe(428);
    const body: any = await res.json();
    expect(body.error_type).toBe("precondition_required");
    expect(body.note_id).toBe(note.id);
    expect(typeof body.hint).toBe("string");
  });
});

describe("contract: error taxonomy — #554 (flipped from todo)", () => {
  it("every error response on the PATCH content_edit branch carries a structured {error_type, hint} pair — previously bare {error, message} strings with no error_type at all", async () => {
    const note = await store.createNote("the quick brown fox jumps over the fox", { id: "n1" });

    // mutually_exclusive — content + append in the same call.
    const mutEx = await patch(note.id, { content: "x", append: "y", force: true });
    expect(mutEx.status).toBe(400);
    const mutExBody: any = await mutEx.json();
    expect(mutExBody.error_type).toBe("mutually_exclusive");
    expect(typeof mutExBody.hint).toBe("string");

    // invalid_content_edit — content_edit missing new_text.
    const badShape = await patch(note.id, { content_edit: { old_text: "fox" }, force: true });
    expect(badShape.status).toBe(400);
    const badShapeBody: any = await badShape.json();
    expect(badShapeBody.error_type).toBe("invalid_content_edit");
    expect(badShapeBody.field).toBe("content_edit");
    expect(typeof badShapeBody.hint).toBe("string");

    // content_edit_not_found — old_text absent from the note's content.
    const notFound = await patch(note.id, {
      content_edit: { old_text: "giraffe", new_text: "zebra" },
      force: true,
    });
    expect(notFound.status).toBe(422);
    const notFoundBody: any = await notFound.json();
    expect(notFoundBody.error_type).toBe("content_edit_not_found");
    expect(notFoundBody.field).toBe("content_edit.old_text");
    expect(typeof notFoundBody.hint).toBe("string");

    // content_edit_ambiguous — old_text ("fox") matches twice in the seed content.
    const ambiguous = await patch(note.id, {
      content_edit: { old_text: "fox", new_text: "wolf" },
      force: true,
    });
    expect(ambiguous.status).toBe(409);
    const ambiguousBody: any = await ambiguous.json();
    expect(ambiguousBody.error_type).toBe("content_edit_ambiguous");
    expect(ambiguousBody.field).toBe("content_edit.old_text");
    expect(typeof ambiguousBody.hint).toBe("string");

    // invalid_state_transition — state_transition.field is an empty string.
    const badTransition = await patch(note.id, { state_transition: { field: "", from: "a", to: "b" } });
    expect(badTransition.status).toBe(400);
    const badTransitionBody: any = await badTransition.json();
    expect(badTransitionBody.error_type).toBe("invalid_state_transition");
    expect(badTransitionBody.field).toBe("state_transition.field");
    expect(typeof badTransitionBody.hint).toBe("string");
  });

  it("batch update-note honors a top-level `force` applied per-item as a DEFAULT, and an item's own value still wins", async () => {
    const a = await store.createNote("a", { id: "a1" });
    const b = await store.createNote("b", { id: "b1" });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    // Top-level force:true, item omits its own force/if_updated_at — the
    // default applies and the write succeeds instead of throwing
    // precondition_required. Before the fix, `items = batch ?? [params]`
    // never merged the top-level field in, so this ALWAYS threw.
    const result: any = await updateNote.execute({
      force: true,
      notes: [{ id: a.id, content: "a-updated" }],
    });
    expect(result[0].content).toBe("a-updated");

    // Item-level values still win over the top-level default: this item
    // explicitly sets `force: false` (overriding the batch default) and
    // supplies no `if_updated_at` of its own, so the precondition gate
    // still fires for it.
    let caught: unknown;
    try {
      await updateNote.execute({
        force: true,
        notes: [{ id: b.id, content: "b-updated", force: false }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PreconditionRequiredError);
  });

  it("REST PUT /api/tags/:name reports ALL cross-tag field violations in one call and states no changes were applied (#553 messaging, mirrors the MCP tool)", async () => {
    // Tag "a" declares two indexed fields; tag "b" redeclares BOTH with
    // conflicting specs in the SAME PUT — a type conflict on "x" and an
    // indexed-flag conflict on "y". Before this fix REST had no cross-tag
    // pre-check at all here (a gap distinct from the MCP tool's old
    // first-field-only throw); now both surfaces report identically.
    await store.upsertTagRecord("a", {
      fields: {
        x: { type: "string", indexed: true },
        y: { type: "boolean", indexed: true },
      },
    });

    const req = new Request("http://localhost/api/tags/b", {
      method: "PUT",
      body: JSON.stringify({
        fields: {
          x: { type: "integer", indexed: true },
          y: { type: "boolean", indexed: false },
        },
      }),
    });
    const res = await handleTags(req, store, "/b");
    expect(res.status).toBe(422);
    const body: any = await res.json();
    expect(body.error_type).toBe("tag_field_conflict");
    expect(body.violations).toHaveLength(2);
    const byField = new Map(body.violations.map((v: any) => [v.field, v.reason]));
    expect(byField.get("x")).toBe("type_conflict");
    expect(byField.get("y")).toBe("indexed_flag_conflict");
    expect(body.message).toContain("no changes were applied");

    // Nothing partially landed.
    const bRecord = await store.getTagRecord("b");
    expect(bRecord?.fields ?? null).toBeFalsy();
  });

  it("REST PUT /api/tags/:name still returns 400 invalid_indexed_field for a solo bad field name (vault#478 contract unchanged)", async () => {
    // No cross-tag conflict here — "meeting-type" is invalid on its OWN
    // (kebab-case). This must stay on the pre-existing 400/invalid_indexed_field
    // path, NOT the new 422/tag_field_conflict path — the cross-tag pre-check
    // is deliberately scoped to type/indexed-flag agreement only (see
    // `collectCrossTagFieldViolations`'s doc comment in core/src/tag-schemas.ts).
    const req = new Request("http://localhost/api/tags/meeting", {
      method: "PUT",
      body: JSON.stringify({ fields: { "meeting-type": { type: "string", indexed: true } } }),
    });
    const res = await handleTags(req, store, "/meeting");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error_type).toBe("invalid_indexed_field");
  });
});
