/**
 * Enforced writes — vault#299.
 *
 * Part A: opt-in field-level strict schema validation (enum / required /
 * type / cardinality reject under strict; advisory unchanged; migration
 * bypass writes through AND logs).
 *
 * Part B: compare-and-set state-transition (`state_transition`) +
 * `transition_conflict`; value-matched trigger operators (`matchesOperator`).
 *
 * Plus a state-machine cookbook test wiring all three together.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import {
  generateMcpTools,
  SchemaValidationError,
  TransitionConflictError,
  enforceStrictWrite,
} from "./mcp.js";
import {
  loadSchemaConfig,
  validateNote,
  strictViolations,
  enforceStrictSchema,
} from "./schema-defaults.js";
import { matchesOperator } from "./query-operators.js";
import * as noteOps from "./notes.js";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

/** Find an MCP tool's execute by name. */
function tool(name: string, opts?: Parameters<typeof generateMcpTools>[1]) {
  return generateMcpTools(store, opts).find((t) => t.name === name)!;
}

// ---------------------------------------------------------------------------
// Part A — validateNote: required / cardinality / strict flag
// ---------------------------------------------------------------------------

describe("validateNote — required + cardinality + strict flag (vault#299)", () => {
  beforeEach(async () => {
    await store.upsertTagRecord("piece", {
      fields: {
        state: { type: "string", enum: ["idea", "published"], strict: true },
        priority: { type: "number" }, // advisory
        owners: { type: "array", cardinality: "many", strict: true },
        title: { type: "string", required: true, strict: true },
      },
    });
  });

  it("flags missing_required and marks it strict", () => {
    const resolved = loadSchemaConfig(db);
    const status = validateNote(resolved, { tags: ["piece"], metadata: { state: "idea", owners: ["a"] } });
    const missing = status!.warnings.find((w) => w.reason === "missing_required");
    expect(missing).toBeDefined();
    expect(missing!.field).toBe("title");
    expect(missing!.strict).toBe(true);
  });

  it("flags cardinality_mismatch when a 'many' field gets a scalar", () => {
    const resolved = loadSchemaConfig(db);
    const status = validateNote(resolved, {
      tags: ["piece"],
      metadata: { state: "idea", title: "t", owners: "not-an-array" },
    });
    const card = status!.warnings.find((w) => w.reason === "cardinality_mismatch");
    expect(card).toBeDefined();
    expect(card!.field).toBe("owners");
    expect(card!.strict).toBe(true);
  });

  it("advisory (non-strict) fields don't carry strict:true", () => {
    const resolved = loadSchemaConfig(db);
    const status = validateNote(resolved, {
      tags: ["piece"],
      metadata: { state: "idea", title: "t", owners: ["a"], priority: "high" },
    });
    const tm = status!.warnings.find((w) => w.field === "priority");
    expect(tm).toBeDefined();
    expect(tm!.reason).toBe("type_mismatch");
    expect(tm!.strict).toBeUndefined();
  });

  it("strictViolations excludes advisory + conflict warnings", () => {
    const resolved = loadSchemaConfig(db);
    const status = validateNote(resolved, {
      tags: ["piece"],
      metadata: { state: "bogus", title: "t", owners: ["a"], priority: "high" },
    });
    const strict = strictViolations(status);
    // enum violation on `state` is strict; priority type_mismatch is advisory.
    expect(strict.map((v) => v.field).sort()).toEqual(["state"]);
  });

  it("enforceStrictSchema throws on strict violation, passes when clean", () => {
    const resolved = loadSchemaConfig(db);
    expect(() =>
      enforceStrictSchema(resolved, { tags: ["piece"], metadata: { state: "idea", owners: ["a"] } }),
    ).toThrow(SchemaValidationError);
    // Clean note: no throw.
    const ok = enforceStrictSchema(resolved, {
      tags: ["piece"],
      metadata: { state: "idea", title: "t", owners: ["a"] },
    });
    expect(ok.violations.length).toBe(0);
  });

  it("enforceStrictSchema bypass:true skips the throw", () => {
    const resolved = loadSchemaConfig(db);
    const res = enforceStrictSchema(
      resolved,
      { tags: ["piece"], metadata: { state: "idea", owners: ["a"] } },
      { bypass: true },
    );
    expect(res.violations.length).toBeGreaterThan(0); // would-be violations reported
  });
});

// ---------------------------------------------------------------------------
// Part A — write-path enforcement through MCP tools
// ---------------------------------------------------------------------------

describe("strict enforcement on the MCP write path (vault#299)", () => {
  beforeEach(async () => {
    await store.upsertTagRecord("piece", {
      fields: {
        state: { type: "string", enum: ["idea", "drafted", "published"], strict: true },
        count: { type: "integer", strict: true },
        title: { type: "string", required: true, strict: true },
        owners: { type: "array", cardinality: "many", strict: true },
        notes: { type: "string" }, // advisory free-form on a strict tag
      },
    });
  });

  it("rejects an enum violation on create", async () => {
    const create = tool("create-note");
    await expect(
      create.execute({ content: "x", tags: ["piece"], metadata: { state: "bogus", title: "t", owners: [] } }),
    ).rejects.toThrow(SchemaValidationError);
    // Nothing written.
    expect((await store.listTags()).find((t) => t.name === "piece")!.count).toBe(0);
  });

  it("rejects a missing-required violation on create", async () => {
    const create = tool("create-note");
    await expect(
      create.execute({ content: "x", tags: ["piece"], metadata: { state: "idea", owners: [] } }),
    ).rejects.toThrow(SchemaValidationError);
  });

  it("rejects a type-mismatch violation on create", async () => {
    const create = tool("create-note");
    await expect(
      create.execute({
        content: "x",
        tags: ["piece"],
        metadata: { state: "idea", title: "t", count: "five", owners: [] },
      }),
    ).rejects.toThrow(SchemaValidationError);
  });

  it("rejects a cardinality violation on create", async () => {
    const create = tool("create-note");
    await expect(
      create.execute({
        content: "x",
        tags: ["piece"],
        metadata: { state: "idea", title: "t", owners: "solo" },
      }),
    ).rejects.toThrow(SchemaValidationError);
  });

  it("carries ALL per-field violations in one SchemaValidationError", async () => {
    const create = tool("create-note");
    let err: SchemaValidationError | null = null;
    try {
      await create.execute({ content: "x", tags: ["piece"], metadata: { state: "bogus", count: "nope" } });
    } catch (e) {
      err = e as SchemaValidationError;
    }
    expect(err).toBeInstanceOf(SchemaValidationError);
    const fields = err!.violations.map((v) => v.field).sort();
    // state (enum) + count (type) + title (missing required). `owners` is
    // strict+cardinality but NOT required, so an absent owners is no violation.
    expect(fields).toEqual(["count", "state", "title"]);
  });

  it("accepts a fully-conforming note; advisory free-form field is fine", async () => {
    const create = tool("create-note");
    const note = (await create.execute({
      content: "x",
      tags: ["piece"],
      metadata: { state: "idea", title: "t", count: 3, owners: ["me"], notes: "anything goes here" },
    })) as any;
    expect(note.metadata.state).toBe("idea");
  });

  it("rejects a strict violation introduced on update", async () => {
    const create = tool("create-note");
    const update = tool("update-note");
    const note = (await create.execute({
      content: "x",
      tags: ["piece"],
      metadata: { state: "idea", title: "t", owners: ["me"] },
    })) as any;
    await expect(
      update.execute({ id: note.id, metadata: { state: "bogus" }, if_updated_at: note.updatedAt }),
    ).rejects.toThrow(SchemaValidationError);
    // Untouched.
    const fresh = await store.getNote(note.id);
    expect((fresh!.metadata as any).state).toBe("idea");
  });
});

describe("advisory (strict:false) behavior is unchanged (vault#299)", () => {
  beforeEach(async () => {
    await store.upsertTagRecord("task", {
      fields: {
        status: { type: "string", enum: ["open", "done"] }, // advisory — no strict
        priority: { type: "number" },
      },
    });
  });

  it("writes a non-conforming note through and surfaces validation_status warnings", async () => {
    const create = tool("create-note");
    const note = (await create.execute({
      content: "x",
      tags: ["task"],
      metadata: { status: "bogus", priority: "high" },
    })) as any;
    // Write succeeded.
    expect(note.metadata.status).toBe("bogus");
    // Advisory warnings present.
    expect(note.validation_status).toBeDefined();
    const reasons = note.validation_status.warnings.map((w: any) => w.reason).sort();
    expect(reasons).toContain("enum_mismatch");
    expect(reasons).toContain("type_mismatch");
  });
});

// ---------------------------------------------------------------------------
// Part A — migration bypass + logging
// ---------------------------------------------------------------------------

describe("migration-bypass scope writes through AND logs (vault#299)", () => {
  beforeEach(async () => {
    await store.upsertTagRecord("piece", {
      fields: {
        state: { type: "string", enum: ["idea", "published"], strict: true },
        title: { type: "string", required: true, strict: true },
      },
    });
  });

  it("enforceStrictWrite with bypass:false throws and never logs", () => {
    const calls: any[] = [];
    expect(() =>
      enforceStrictWrite(
        store,
        { tags: ["piece"], metadata: { state: "bogus" } },
        { bypass: false, onBypass: (v) => calls.push(v) },
      ),
    ).toThrow(SchemaValidationError);
    expect(calls.length).toBe(0);
  });

  it("enforceStrictWrite with bypass:true writes through and logs the would-be violations", () => {
    const logged: any[] = [];
    const violations = enforceStrictWrite(
      store,
      { tags: ["piece"], metadata: { state: "bogus" } },
      { bypass: true, onBypass: (v) => logged.push(v) },
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(logged.length).toBe(1);
    // The log carries the field+reason of every waived violation.
    const reasons = logged[0].map((v: any) => v.reason).sort();
    expect(reasons).toContain("enum_mismatch");
    expect(reasons).toContain("missing_required");
  });

  it("MCP tools with strictBypass:true write non-conforming notes + fire onStrictBypass", async () => {
    const logged: any[] = [];
    const create = generateMcpTools(store, {
      strictBypass: true,
      onStrictBypass: (info) => logged.push(info),
      writeContext: { actor: "migrator", via: "operator" },
    }).find((t) => t.name === "create-note")!;
    const note = (await create.execute({
      content: "legacy row",
      tags: ["piece"],
      metadata: { state: "bogus" },
    })) as any;
    // Written despite violations.
    expect(note.metadata.state).toBe("bogus");
    // Logged with attribution (MW1 actor/via).
    expect(logged.length).toBe(1);
    expect(logged[0].actor).toBe("migrator");
    expect(logged[0].via).toBe("operator");
    expect(logged[0].violations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Part B — state_transition compare-and-set
// ---------------------------------------------------------------------------

describe("state_transition compare-and-set (vault#299 Part B)", () => {
  async function seed(state: string) {
    const note = noteOps.createNote(db, "body", { metadata: { state } });
    return note;
  }

  it("transitions when current == from", () => {
    const note = noteOps.createNote(db, "b", { metadata: { state: "draft" } });
    const updated = noteOps.updateNote(db, note.id, {
      state_transition: { field: "state", from: "draft", to: "published" },
    });
    expect((updated.metadata as any).state).toBe("published");
  });

  it("conflicts when current != from", () => {
    const note = noteOps.createNote(db, "b", { metadata: { state: "draft" } });
    expect(() =>
      noteOps.updateNote(db, note.id, {
        state_transition: { field: "state", from: "published", to: "archived" },
      }),
    ).toThrow(TransitionConflictError);
    // Unchanged.
    expect((noteOps.getNote(db, note.id)!.metadata as any).state).toBe("draft");
  });

  it("missing field counts as a conflict", () => {
    const note = noteOps.createNote(db, "b", { metadata: {} });
    let err: TransitionConflictError | null = null;
    try {
      noteOps.updateNote(db, note.id, {
        state_transition: { field: "state", from: "draft", to: "published" },
      });
    } catch (e) {
      err = e as TransitionConflictError;
    }
    expect(err).toBeInstanceOf(TransitionConflictError);
    expect(err!.code).toBe("TRANSITION_CONFLICT");
    expect(err!.field).toBe("state");
    expect(err!.current).toBeUndefined();
  });

  it("combines with other field updates in the same write (raw layer)", () => {
    const note = noteOps.createNote(db, "b", { metadata: { state: "draft", views: 1 } });
    const updated = noteOps.updateNote(db, note.id, {
      metadata: { state: "draft", views: 99, extra: "added" },
      state_transition: { field: "state", from: "draft", to: "published" },
    });
    const meta = updated.metadata as any;
    expect(meta.state).toBe("published"); // transition wins for the state field
    expect(meta.views).toBe(99); // other merged field landed
    expect(meta.extra).toBe("added");
  });

  it("combines with other field updates through the MCP layer (needs if_updated_at for the OTHER fields)", async () => {
    const create = tool("create-note");
    const update = tool("update-note");
    const note = (await create.execute({ content: "b", metadata: { state: "draft", views: 1 } })) as any;
    const updated = (await update.execute({
      id: note.id,
      metadata: { views: 99, extra: "added" },
      state_transition: { field: "state", from: "draft", to: "published" },
      if_updated_at: note.updatedAt, // combined write still needs the OC token for the merge
    })) as any;
    expect(updated.metadata.state).toBe("published");
    expect(updated.metadata.views).toBe(99);
    expect(updated.metadata.extra).toBe("added");
  });

  it("from: null matches an absent/null field; non-null from conflicts on it", () => {
    // Absent field + from:null → transition commits.
    const a = noteOps.createNote(db, "b", { metadata: {} });
    const a2 = noteOps.updateNote(db, a.id, { state_transition: { field: "phase", from: null, to: "start" } });
    expect((a2.metadata as any).phase).toBe("start");
    // A non-null field + from:null → conflict (it's neither absent nor null).
    const c = noteOps.createNote(db, "b", { metadata: { phase: "running" } });
    expect(() =>
      noteOps.updateNote(db, c.id, { state_transition: { field: "phase", from: null, to: "start" } }),
    ).toThrow(TransitionConflictError);
  });

  it("a losing concurrent transitioner sees the conflict (CAS race)", () => {
    const note = noteOps.createNote(db, "b", { metadata: { state: "draft" } });
    // First transition wins.
    noteOps.updateNote(db, note.id, { state_transition: { field: "state", from: "draft", to: "published" } });
    // Second observer still thinks it's "draft" → conflict.
    expect(() =>
      noteOps.updateNote(db, note.id, { state_transition: { field: "state", from: "draft", to: "archived" } }),
    ).toThrow(TransitionConflictError);
  });

  it("transition_conflict is a distinct code from CONFLICT (if_updated_at)", () => {
    const note = noteOps.createNote(db, "b", { metadata: { state: "draft" } });
    let code: string | undefined;
    try {
      noteOps.updateNote(db, note.id, { state_transition: { field: "state", from: "X", to: "Y" } });
    } catch (e) {
      code = (e as any).code;
    }
    expect(code).toBe("TRANSITION_CONFLICT");
    expect(code).not.toBe("CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// Part B — value-matched operator engine
// ---------------------------------------------------------------------------

describe("matchesOperator — in-memory value matching (vault#299)", () => {
  it("eq matches and rejects", () => {
    expect(matchesOperator("state", "published", { eq: "published" })).toBe(true);
    expect(matchesOperator("state", "draft", { eq: "published" })).toBe(false);
  });

  it("in matches membership", () => {
    expect(matchesOperator("state", "published", { in: ["queued", "published"] })).toBe(true);
    expect(matchesOperator("state", "draft", { in: ["queued", "published"] })).toBe(false);
  });

  it("absent field never matches eq/in", () => {
    expect(matchesOperator("state", undefined, { eq: "published" })).toBe(false);
    expect(matchesOperator("state", undefined, { in: ["published"] })).toBe(false);
  });

  it("ne / not_in treat absent as a match (SQL NULL parity)", () => {
    expect(matchesOperator("state", undefined, { ne: "published" })).toBe(true);
    expect(matchesOperator("state", undefined, { not_in: ["published"] })).toBe(true);
  });

  it("numeric comparisons + cross-type loose eq", () => {
    expect(matchesOperator("n", 5, { gt: 3, lt: 10 })).toBe(true);
    expect(matchesOperator("n", 5, { gt: 5 })).toBe(false);
    expect(matchesOperator("n", "5", { eq: 5 })).toBe(true); // round-tripped JSON shape
  });

  it("exists", () => {
    expect(matchesOperator("x", "v", { exists: true })).toBe(true);
    expect(matchesOperator("x", undefined, { exists: false })).toBe(true);
    expect(matchesOperator("x", undefined, { exists: true })).toBe(false);
  });

  it("unknown operator throws", () => {
    expect(() => matchesOperator("x", "v", { equals: "v" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cookbook — a full state machine (strict enum + state_transition)
// ---------------------------------------------------------------------------

describe("cookbook: content state machine (vault#299)", () => {
  it("strict enum state + advance via state_transition; bad target rejected; bad transition conflicts", async () => {
    // 1. Declare a strict enum state field.
    await store.upsertTagRecord("concept-seed", {
      fields: {
        state: {
          type: "string",
          enum: ["idea", "drafted", "scripted", "produced", "published", "killed"],
          strict: true,
        },
        title: { type: "string", required: true, strict: true },
      },
    });

    const create = tool("create-note");
    const update = tool("update-note");

    // 2. Create a conforming seed.
    const seed = (await create.execute({
      content: "a content idea",
      path: "Seeds/my-idea",
      tags: ["concept-seed"],
      metadata: { state: "idea", title: "My idea" },
    })) as any;
    expect(seed.metadata.state).toBe("idea");

    // 3. Advance it race-safely with a value-matched compare-and-set.
    const advanced = (await update.execute({
      id: seed.id,
      state_transition: { field: "state", from: "idea", to: "drafted" },
    })) as any;
    expect(advanced.metadata.state).toBe("drafted");

    // 4. A transition to a non-enum value is rejected by strict validation.
    await expect(
      update.execute({ id: seed.id, state_transition: { field: "state", from: "drafted", to: "bogus" } }),
    ).rejects.toThrow(SchemaValidationError);

    // 5. A transition from the wrong current value conflicts.
    await expect(
      update.execute({ id: seed.id, state_transition: { field: "state", from: "idea", to: "scripted" } }),
    ).rejects.toThrow(TransitionConflictError);

    // 6. The note is still "drafted" — neither bad attempt mutated it.
    expect((await store.getNote(seed.id))!.metadata).toMatchObject({ state: "drafted" });
  });

  it("value-matched trigger predicate fires on eq/in match and NOT otherwise", async () => {
    // The trigger predicate uses matchesOperator with the same engine. Emulate
    // a value-matched `when.metadata` against a note's live metadata.
    const when = { state: { eq: "published" } as Record<string, unknown> };
    const fires = (meta: Record<string, unknown>) =>
      Object.entries(when).every(([f, op]) => matchesOperator(f, meta[f], op));

    expect(fires({ state: "published" })).toBe(true);
    expect(fires({ state: "drafted" })).toBe(false);
    expect(fires({})).toBe(false); // absent → no fire

    const whenIn = { state: { in: ["produced", "published"] } as Record<string, unknown> };
    const firesIn = (meta: Record<string, unknown>) =>
      Object.entries(whenIn).every(([f, op]) => matchesOperator(f, meta[f], op));
    expect(firesIn({ state: "produced" })).toBe(true);
    expect(firesIn({ state: "idea" })).toBe(false);
  });
});
