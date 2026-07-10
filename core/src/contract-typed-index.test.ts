/**
 * Contract suite — typed indexes (Wave 1 of the Reliability & Usability
 * Program, umbrella #556). Encodes the 2026-07-09 nine-persona deep test's
 * WS4 findings (#553) as executable tests: PASSING tests lock in behavior
 * that is correct today (well-typed integer-indexed range queries, the
 * merge-patch metadata contract, and the state_transition compare-and-set
 * conflict); `test.todo` entries describe the target behavior for
 * confirmed-broken cases, to be flipped to real assertions in a later wave.
 * See #553 for the full write-up.
 *
 * The TEXT-poisoning todo below was reproduced live before writing: declaring
 * an indexed integer field and writing `metadata.n = "four"` succeeds with
 * only an advisory `type_mismatch` warning, and the resulting row's generated
 * column carries the raw TEXT value under SQLite's INTEGER-affinity
 * coercion — which then sorts ABOVE every real integer (SQLite type
 * ordering: NULL < INTEGER/REAL < TEXT < BLOB), so `{n: {gt: 100}}`
 * incorrectly matches the poisoned row alongside genuine matches.
 */

import { describe, it, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import { TransitionConflictError } from "./notes.js";
import { TagFieldConflictError } from "./tag-schemas.js";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("contract: typed indexes — passing (lock in current behavior)", () => {
  it("an integer-indexed field with well-typed integer values answers gte/lt correctly", async () => {
    await store.upsertTagRecord("metric", { fields: { n: { type: "integer", indexed: true } } });
    const low = await store.createNote("n=5", { tags: ["metric"], metadata: { n: 5 } });
    const mid = await store.createNote("n=50", { tags: ["metric"], metadata: { n: 50 } });
    const high = await store.createNote("n=200", { tags: ["metric"], metadata: { n: 200 } });

    const gte50 = await store.queryNotes({ tags: ["metric"], metadata: { n: { gte: 50 } } });
    expect(new Set(gte50.map((n) => n.id))).toEqual(new Set([mid.id, high.id]));

    const lt50 = await store.queryNotes({ tags: ["metric"], metadata: { n: { lt: 50 } } });
    expect(new Set(lt50.map((n) => n.id))).toEqual(new Set([low.id]));
  });

  it("merge-patch metadata preserves untouched fields, updates named fields, and RFC-7386-deletes null fields", async () => {
    const note = await store.createNote("has metadata", {
      metadata: { a: 1, b: 2, c: 3 },
    });
    const tools = generateMcpTools(store);
    const updateNote = tools.find((t) => t.name === "update-note")!;

    const result: any = await updateNote.execute({
      id: note.id,
      metadata: { b: 20, c: null },
      force: true,
    });

    expect(result.metadata).toEqual({ a: 1, b: 20 });
  });

  it("a state_transition compare-and-set conflicts when the note has already transitioned away from `from`", async () => {
    const note = await store.createNote("workflow item", { metadata: { status: "draft" } });

    const first = await store.updateNote(note.id, {
      state_transition: { field: "status", from: "draft", to: "published" },
    });
    expect((first.metadata as any).status).toBe("published");

    let err: any;
    try {
      // Same `from: "draft"` precondition — but the note is now "published",
      // so this must conflict rather than silently no-op or overwrite.
      await store.updateNote(note.id, {
        state_transition: { field: "status", from: "draft", to: "archived" },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TransitionConflictError);
    expect(err.field).toBe("status");
    expect(err.expected_from).toBe("draft");
    expect(err.current).toBe("published");

    // The note's status is untouched by the rejected transition.
    const after = await store.getNote(note.id);
    expect((after!.metadata as any).status).toBe("published");
  });
});

describe("contract: typed indexes — todo (#553)", () => {
  test.todo(
    `#553: a write of a TEXT value to an indexed integer field is REJECTED (today: it is accepted with only an advisory type_mismatch warning, and the poisoned row then silently matches {gt: 100}-style range queries via SQLite's TEXT-sorts-above-INTEGER type-affinity ordering — reproduced live: metadata.n = "four" on an indexed integer field succeeds, and query {n: {gt: 100}} incorrectly returns it)`,
  );
  test.todo(
    `#553: an unset enum field stays ABSENT — no first-value backfill — so exists:false correctly matches a note that never set the field (today: applySchemaDefaults in core/src/mcp.ts backfills the schema's first enum value onto every note that gains the tag, so "never set" is indistinguishable from "explicitly set to the default" and exists:false never matches)`,
  );
  test.todo(
    `#553: the indexed-field type list is honest about what's actually indexable (core/src/mcp.ts's update-tag field-type description advertises "string, boolean, integer, number, array, object" but indexed-fields.ts's TYPE_MAP only supports string/integer/boolean — "number" and the container types are accepted as declared but silently un-indexable)`,
  );
});

describe("contract: update-tag messaging — #553/#554 (flipped from todo)", () => {
  it("update-tag reports ALL invalid fields in one call (not just the first) and states explicitly that no changes were applied", async () => {
    // Tag "a" declares two fields. Tag "b" then redeclares BOTH with
    // conflicting specs — a NON-indexed type conflict on "x" AND an
    // indexed-flag conflict on "y" — in the SAME update-tag call. Pre-#553
    // the cross-tag validation loop threw on the first offending field
    // ("x") and never even evaluated "y"; two testers independently assumed
    // the whole call (including "y") had partially landed. (The
    // BOTH-indexed type-conflict case is deliberately absent here — it
    // keeps its pre-existing declareField → IndexedFieldError path; see
    // `collectCrossTagFieldViolations`'s doc-comment exclusion 2 and the
    // both-indexed test below.)
    await store.upsertTagRecord("a", {
      fields: {
        x: { type: "string" },
        y: { type: "boolean", indexed: true },
      },
    });

    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;

    let caught: unknown;
    try {
      await updateTag.execute({
        tag: "b",
        fields: {
          x: { type: "integer" }, // non-indexed type_conflict vs tag "a"
          y: { type: "boolean", indexed: false }, // indexed_flag_conflict vs tag "a"
        },
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TagFieldConflictError);
    const err = caught as TagFieldConflictError;
    expect(err.violations).toHaveLength(2);
    const byField = new Map(err.violations.map((v) => [v.field, v.reason]));
    expect(byField.get("x")).toBe("type_conflict");
    expect(byField.get("y")).toBe("indexed_flag_conflict");
    // States explicitly that no changes were applied.
    expect(err.message).toContain("no changes were applied");
    // Structured conflicting-declarer field (scrubbed by the server layer
    // for tag-scoped sessions; full detail here — core is scope-unaware).
    expect(err.violations[0]!.other_tag).toBe("a");

    // Nothing partially landed — tag "b" has no field declarations at all.
    const bRecord = await store.getTagRecord("b");
    expect(bRecord?.fields ?? null).toBeFalsy();
  });

  it("a BOTH-indexed cross-tag type conflict keeps its pre-existing IndexedFieldError path (not TagFieldConflictError)", async () => {
    // Wire-contract floor (vault#554): this exact case already errored on
    // main via store.upsertTagRecord → declareField's cross-declarer
    // sqlite-type check → IndexedFieldError (REST maps it to 400
    // invalid_indexed_field). The new pre-check must not intercept it.
    await store.upsertTagRecord("a", {
      fields: { x: { type: "string", indexed: true } },
    });

    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;

    let caught: any;
    try {
      await updateTag.execute({
        tag: "b",
        fields: { x: { type: "integer", indexed: true } },
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(TagFieldConflictError);
    expect(caught.name).toBe("IndexedFieldError");
    expect(caught.error_type).toBe("invalid_indexed_field");
    // The structured declarer context the server's tag-scope scrub keys on.
    expect(caught.field).toBe("x");
    expect(caught.declarer_tags).toEqual(["a"]);

    // The store's transaction rolled back — nothing persisted for "b".
    const bRecord = await store.getTagRecord("b");
    expect(bRecord?.fields ?? null).toBeFalsy();
  });
  // REST `PUT /api/tags/:name` coverage for the same behavior lives in
  // src/contract-errors.test.ts (core/ shouldn't import from src/ — that
  // boundary runs one direction only).
});
