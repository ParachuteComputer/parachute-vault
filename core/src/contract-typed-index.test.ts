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
import { generateMcpTools, SchemaValidationError } from "./mcp.js";
import { TransitionConflictError } from "./notes.js";
import * as noteOps from "./notes.js";
import { TagFieldConflictError } from "./tag-schemas.js";
import { initSchema, SCHEMA_VERSION } from "./schema.js";

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

describe("contract: typed indexes — Decision A: indexed ⇒ strict writes (#553, flipped from todo)", () => {
  it("a write of a TEXT value to an indexed integer field is REJECTED, not just warned", async () => {
    await store.upsertTagRecord("metric", { fields: { n: { type: "integer", indexed: true } } });
    const create = generateMcpTools(store).find((t) => t.name === "create-note")!;

    let err: any;
    try {
      await create.execute({ content: "x", tags: ["metric"], metadata: { n: "four" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect(err.violations).toHaveLength(1);
    expect(err.violations[0].field).toBe("n");
    expect(err.violations[0].reason).toBe("type_mismatch");
    expect(err.violations[0].strict).toBe(true);
    // Message names field + expected type + got type.
    expect(err.violations[0].message).toContain("n");
    expect(err.violations[0].message).toContain("integer");
    expect(err.violations[0].message).toContain("string");

    // Nothing was written — the poisoned row never lands, so it can never
    // sort above a real integer under {gt: 100}-style range queries.
    const all = await store.queryNotes({ tags: ["metric"] });
    expect(all).toHaveLength(0);
  });

  it("rejects the same indexed-type violation on update-note", async () => {
    await store.upsertTagRecord("metric", { fields: { n: { type: "integer", indexed: true } } });
    const create = generateMcpTools(store).find((t) => t.name === "create-note")!;
    const update = generateMcpTools(store).find((t) => t.name === "update-note")!;
    const note = (await create.execute({ content: "x", tags: ["metric"], metadata: { n: 5 } })) as any;

    await expect(
      update.execute({ id: note.id, metadata: { n: "four" }, if_updated_at: note.updatedAt }),
    ).rejects.toThrow(SchemaValidationError);

    // Untouched — still the original, well-typed value.
    const fresh = await store.getNote(note.id);
    expect((fresh!.metadata as any).n).toBe(5);
  });

  it("a range query never matches a TEXT value on an indexed integer field (the poisoning is now unreachable)", async () => {
    await store.upsertTagRecord("metric", { fields: { n: { type: "integer", indexed: true } } });
    const create = generateMcpTools(store).find((t) => t.name === "create-note")!;
    await create.execute({ content: "n=5", tags: ["metric"], metadata: { n: 5 } });
    await expect(
      create.execute({ content: "poison", tags: ["metric"], metadata: { n: "four" } }),
    ).rejects.toThrow(SchemaValidationError);

    const gt100 = await store.queryNotes({ tags: ["metric"], metadata: { n: { gt: 100 } } });
    expect(gt100).toHaveLength(0);
  });

  it("a type_mismatch on a NON-indexed field stays advisory (unchanged behavior — the escalation is scoped to indexed:true)", async () => {
    await store.upsertTagRecord("metric", { fields: { n: { type: "integer" } } });
    const create = generateMcpTools(store).find((t) => t.name === "create-note")!;
    const note = (await create.execute({ content: "x", tags: ["metric"], metadata: { n: "four" } })) as any;
    // Write succeeded — advisory only.
    expect(note.metadata.n).toBe("four");
    expect(note.validation_status.warnings[0].reason).toBe("type_mismatch");
    expect(note.validation_status.warnings[0].strict).toBeUndefined();
  });
});

describe("contract: typed indexes — Decision B: explicit-default-only enum backfill (#553, flipped from todo)", () => {
  it("an unset enum field stays ABSENT — no first-value backfill — so exists:false correctly matches", async () => {
    await store.upsertTagRecord("task", {
      fields: { status: { type: "string", enum: ["queued", "done"], indexed: true } }, // no `default`
    });
    const create = generateMcpTools(store).find((t) => t.name === "create-note")!;
    const query = generateMcpTools(store).find((t) => t.name === "query-notes")!;

    const note = (await create.execute({ content: "x", tags: ["task"] })) as any;
    expect(note.metadata?.status).toBeUndefined();
    const onDisk = await store.getNote(note.id);
    expect((onDisk!.metadata as any)?.status).toBeUndefined();

    const unset = (await query.execute({
      tag: "task",
      metadata: { status: { exists: false } },
    })) as any[];
    expect(unset.map((n) => n.id)).toContain(note.id);

    const set = (await query.execute({
      tag: "task",
      metadata: { status: { exists: true } },
    })) as any[];
    expect(set.map((n) => n.id)).not.toContain(note.id);
  });

  it("an EXPLICIT `default:` backfills as before — exists:true matches it", async () => {
    await store.upsertTagRecord("task", {
      fields: { status: { type: "string", enum: ["queued", "done"], default: "queued", indexed: true } },
    });
    const create = generateMcpTools(store).find((t) => t.name === "create-note")!;
    const query = generateMcpTools(store).find((t) => t.name === "query-notes")!;

    const note = (await create.execute({ content: "x", tags: ["task"] })) as any;
    expect(note.metadata.status).toBe("queued");

    const set = (await query.execute({
      tag: "task",
      metadata: { status: { exists: true } },
    })) as any[];
    expect(set.map((n) => n.id)).toContain(note.id);
  });

  it("a non-conforming `default` is rejected as a tag-schema error, not silently stored", async () => {
    const updateTag = generateMcpTools(store).find((t) => t.name === "update-tag")!;
    let err: any;
    try {
      await updateTag.execute({
        tag: "task",
        fields: { status: { type: "string", enum: ["queued", "done"], default: "bogus" } },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TagFieldConflictError);
    expect(err.violations.some((v: any) => v.reason === "invalid_default" && v.field === "status")).toBe(true);
    // Nothing persisted.
    expect((await store.getTagRecord("task"))?.fields ?? null).toBeFalsy();
  });
});

describe("contract: typed indexes — Decision C: honest type list (#553, flipped from todo)", () => {
  it("the update-tag field-type description clarifies only string/integer/boolean/reference are indexable", () => {
    const updateTag = generateMcpTools(store).find((t) => t.name === "update-tag")!;
    const typeDesc = (updateTag.inputSchema as any).properties.fields.additionalProperties.properties.type.description as string;
    // Honest about the full storage/advisory vocabulary AND the indexable subset.
    expect(typeDesc).toContain("number");
    // vault#typed-reference-field: `reference` joined the indexable subset
    // alongside string/integer/boolean.
    expect(typeDesc).toContain("Only string/integer/boolean/reference are INDEXABLE");
  });

  it("declaring indexed:true with an unindexable type (number) is rejected", async () => {
    const updateTag = generateMcpTools(store).find((t) => t.name === "update-tag")!;
    let err: any;
    try {
      await updateTag.execute({ tag: "metric", fields: { score: { type: "number", indexed: true } } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TagFieldConflictError);
    expect(err.violations[0].reason).toBe("unsupported_indexed_type");
  });

  it("declaring a number field WITHOUT indexed:true is accepted (storage/advisory only)", async () => {
    const updateTag = generateMcpTools(store).find((t) => t.name === "update-tag")!;
    const result = await updateTag.execute({ tag: "metric", fields: { score: { type: "number" } } }) as any;
    expect(result.fields.score.type).toBe("number");
  });
});

describe("contract: typed indexes — Decision D: migrateToV24 poison coercion (#553, new)", () => {
  it("coerces a lossless numeric string, leaves a genuinely non-coercible string, and is idempotent on re-run", async () => {
    // Declare the field indexed AFTER notes already exist (real-data-like:
    // a field indexed retroactively on a vault with pre-existing rows).
    const clean = noteOps.createNote(db, "clean", { metadata: { n: 42 } });
    const coercible = noteOps.createNote(db, "coercible", { metadata: { n: "5" } }); // clean numeric string
    const nonCoercible = noteOps.createNote(db, "non-coercible", { metadata: { n: "hello" } });
    const boolish = noteOps.createNote(db, "boolish", { metadata: { flag: "true" } });

    await store.upsertTagRecord("metric", {
      fields: {
        n: { type: "integer", indexed: true },
        flag: { type: "boolean", indexed: true },
      },
    });
    noteOps.tagNote(db, clean.id, ["metric"]);
    noteOps.tagNote(db, coercible.id, ["metric"]);
    noteOps.tagNote(db, nonCoercible.id, ["metric"]);
    noteOps.tagNote(db, boolish.id, ["metric"]);

    // Re-running initSchema (idempotent by construction for every migration
    // step) exercises migrateToV24's coercion pass over the poison just
    // planted via the raw noteOps layer (bypassing the strict write gate —
    // simulating data that predates it, or an operator-side bulk import).
    initSchema(db);

    const after = (id: string) => (noteOps.getNote(db, id)!.metadata as any);
    expect(after(clean.id).n).toBe(42); // untouched — was already clean
    expect(after(coercible.id).n).toBe(5); // coerced: "5" (string) → 5 (number)
    expect(after(nonCoercible.id).n).toBe("hello"); // LEFT IN PLACE — never deleted or nulled
    expect(after(boolish.id).flag).toBe(true); // coerced: "true" (string) → true (boolean)

    // Doctor still surfaces the genuinely non-coercible one for operator cleanup.
    const report = await store.doctor();
    const finding = report.findings.find(
      (f) => f.type === "mixed_type_indexed_field" && f.subject === "n",
    );
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain(nonCoercible.id);

    // Idempotency: a second re-run coerces nothing further and doesn't
    // touch the already-clean/already-coerced/already-left values.
    initSchema(db);
    expect(after(clean.id).n).toBe(42);
    expect(after(coercible.id).n).toBe(5);
    expect(after(nonCoercible.id).n).toBe("hello");
    expect(after(boolish.id).flag).toBe(true);
  });

  it("coerces a number into a TEXT-indexed field losslessly", async () => {
    const note = noteOps.createNote(db, "x", { metadata: { code: 12345 } });
    await store.upsertTagRecord("item", { fields: { code: { type: "string", indexed: true } } });
    noteOps.tagNote(db, note.id, ["item"]);

    initSchema(db);
    expect((noteOps.getNote(db, note.id)!.metadata as any).code).toBe("12345");
  });

  it("leaves array/object values in an indexed field untouched (never coercible, never deleted)", async () => {
    const note = noteOps.createNote(db, "x", { metadata: { n: [1, 2, 3] } });
    await store.upsertTagRecord("metric", { fields: { n: { type: "integer", indexed: true } } });
    noteOps.tagNote(db, note.id, ["metric"]);

    initSchema(db);
    expect((noteOps.getNote(db, note.id)!.metadata as any).n).toEqual([1, 2, 3]);
  });

  it("is a no-op on a vault with zero indexed fields (schema_version still advances)", async () => {
    const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION);
  });
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
