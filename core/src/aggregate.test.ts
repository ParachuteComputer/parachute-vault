/**
 * Aggregation / rollup queries (top new-feature ask from a UX round).
 *
 * `aggregateNotes` (core/src/notes.ts) applies the SAME filter surface
 * `queryNotes` does — via the shared `buildFilterConditions` — before
 * grouping into `[{group, value}]` rows. This suite pins:
 *
 *   - count by an indexed enum (string) field
 *   - sum of an indexed numeric (integer) field
 *   - a prefilter (tag / metadata) narrows the input set before aggregating
 *   - group_by "tag" (membership rollup, a note can land in several groups)
 *   - errors on a non-indexed group_by (FIELD_NOT_INDEXED)
 *   - errors on a non-indexed / non-numeric sum field
 *   - errors on a malformed aggregate spec (missing op/group_by/field)
 *   - a note missing the group_by field collects into `group: null`
 *
 * Tag-scope enforcement (server-layer, injected as an `ids` prefilter or an
 * `aggregateVisibility` predicate) is covered separately at the MCP/REST
 * integration layer (`src/mcp-query-notes-aggregate-scope.test.ts`,
 * `src/aggregate-routes.test.ts`) — core stays scope-unaware by
 * architecture, same division as every other query surface.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { aggregateNotes } from "./notes.js";
import { QueryError } from "./query-operators.js";

let db: Database;
let store: SqliteStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("aggregateNotes — count by an indexed enum field", () => {
  it("groups and counts", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    await store.createNote("a", { tags: ["task"], metadata: { status: "open" } });
    await store.createNote("b", { tags: ["task"], metadata: { status: "open" } });
    await store.createNote("c", { tags: ["task"], metadata: { status: "done" } });

    const rows = aggregateNotes(db, { aggregate: { group_by: "status", op: "count" } });
    const byGroup = Object.fromEntries(rows.map((r) => [r.group, r.value]));
    expect(byGroup).toEqual({ open: 2, done: 1 });
  });

  it("a note missing the group_by field collects into group: null", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    await store.createNote("a", { tags: ["task"], metadata: { status: "open" } });
    await store.createNote("b", { tags: ["task"] }); // no status

    const rows = aggregateNotes(db, { aggregate: { group_by: "status", op: "count" } });
    const byGroup = Object.fromEntries(rows.map((r) => [r.group, r.value]));
    expect(byGroup).toEqual({ open: 1, null: 1 });
    expect(rows.find((r) => r.group === null)?.value).toBe(1);
  });
});

describe("aggregateNotes — sum of an indexed numeric field", () => {
  it("groups and sums", async () => {
    await store.upsertTagRecord("expense", {
      fields: {
        category: { type: "string", indexed: true },
        amount: { type: "integer", indexed: true },
      },
    });
    await store.createNote("a", { tags: ["expense"], metadata: { category: "food", amount: 10 } });
    await store.createNote("b", { tags: ["expense"], metadata: { category: "food", amount: 25 } });
    await store.createNote("c", { tags: ["expense"], metadata: { category: "travel", amount: 100 } });

    const rows = aggregateNotes(db, {
      aggregate: { group_by: "category", op: "sum", field: "amount" },
    });
    const byGroup = Object.fromEntries(rows.map((r) => [r.group, r.value]));
    expect(byGroup).toEqual({ food: 35, travel: 100 });
  });

  it("sums boolean-backed indexed fields (count-of-true)", async () => {
    await store.upsertTagRecord("task", {
      fields: {
        status: { type: "string", indexed: true },
        done: { type: "boolean", indexed: true },
      },
    });
    await store.createNote("a", { tags: ["task"], metadata: { status: "x", done: true } });
    await store.createNote("b", { tags: ["task"], metadata: { status: "x", done: true } });
    await store.createNote("c", { tags: ["task"], metadata: { status: "x", done: false } });

    const rows = aggregateNotes(db, { aggregate: { group_by: "status", op: "sum", field: "done" } });
    expect(rows).toEqual([{ group: "x", value: 2 }]);
  });
});

describe("aggregateNotes — respects a prefilter", () => {
  it("a tag prefilter narrows the input set before aggregating", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    await store.createNote("a", { tags: ["task", "work"], metadata: { status: "open" } });
    await store.createNote("b", { tags: ["task", "personal"], metadata: { status: "open" } });
    await store.createNote("c", { tags: ["task", "work"], metadata: { status: "done" } });

    const rows = aggregateNotes(db, {
      tags: ["work"],
      aggregate: { group_by: "status", op: "count" },
    });
    const byGroup = Object.fromEntries(rows.map((r) => [r.group, r.value]));
    // Only the two #work notes count — the #personal "open" note is excluded.
    expect(byGroup).toEqual({ open: 1, done: 1 });
  });

  it("a metadata prefilter narrows the input set before aggregating", async () => {
    await store.upsertTagRecord("task", {
      fields: {
        status: { type: "string", indexed: true },
        priority: { type: "string", indexed: true },
      },
    });
    await store.createNote("a", { tags: ["task"], metadata: { status: "open", priority: "high" } });
    await store.createNote("b", { tags: ["task"], metadata: { status: "open", priority: "low" } });
    await store.createNote("c", { tags: ["task"], metadata: { status: "done", priority: "high" } });

    const rows = aggregateNotes(db, {
      metadata: { priority: "high" },
      aggregate: { group_by: "status", op: "count" },
    });
    const byGroup = Object.fromEntries(rows.map((r) => [r.group, r.value]));
    expect(byGroup).toEqual({ open: 1, done: 1 });
  });

  it("an `ids` prefilter narrows the input set before aggregating (the tag-scope injection point)", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    const a = await store.createNote("a", { tags: ["task"], metadata: { status: "open" } });
    await store.createNote("b", { tags: ["task"], metadata: { status: "open" } });
    await store.createNote("c", { tags: ["task"], metadata: { status: "done" } });

    const rows = aggregateNotes(db, {
      ids: [a.id],
      aggregate: { group_by: "status", op: "count" },
    });
    expect(rows).toEqual([{ group: "open", value: 1 }]);
  });
});

describe("aggregateNotes — group_by: \"tag\"", () => {
  it("counts by tag membership — a note carrying N tags contributes to N groups", async () => {
    await store.createNote("a", { tags: ["work", "urgent"] });
    await store.createNote("b", { tags: ["work"] });
    await store.createNote("c", { tags: ["personal"] });

    const rows = aggregateNotes(db, { aggregate: { group_by: "tag", op: "count" } });
    const byGroup = Object.fromEntries(rows.map((r) => [r.group, r.value]));
    expect(byGroup).toEqual({ work: 2, urgent: 1, personal: 1 });
  });

  it("sums by tag membership", async () => {
    await store.upsertTagRecord("expense", { fields: { amount: { type: "integer", indexed: true } } });
    await store.createNote("a", { tags: ["expense", "food"], metadata: { amount: 10 } });
    await store.createNote("b", { tags: ["expense", "food"], metadata: { amount: 5 } });
    await store.createNote("c", { tags: ["expense", "travel"], metadata: { amount: 100 } });

    const rows = aggregateNotes(db, { aggregate: { group_by: "tag", op: "sum", field: "amount" } });
    const byGroup = Object.fromEntries(rows.map((r) => [r.group, r.value]));
    expect(byGroup).toEqual({ expense: 115, food: 15, travel: 100 });
  });

  it("a tag prefilter composes with group_by: \"tag\" (untagged-by-the-filter tags still show up on filtered notes)", async () => {
    await store.createNote("a", { tags: ["work", "urgent"] });
    await store.createNote("b", { tags: ["work"] });
    await store.createNote("c", { tags: ["personal", "urgent"] });

    const rows = aggregateNotes(db, {
      tags: ["work"],
      aggregate: { group_by: "tag", op: "count" },
    });
    const byGroup = Object.fromEntries(rows.map((r) => [r.group, r.value]));
    // Only notes a+b match the `work` prefilter; their full tag membership
    // (including "urgent" on note a) is what's rolled up.
    expect(byGroup).toEqual({ work: 2, urgent: 1 });
  });
});

describe("aggregateNotes — errors", () => {
  it("throws FIELD_NOT_INDEXED on a non-indexed group_by", async () => {
    await store.createNote("a", { metadata: { status: "open" } });
    expect(() => aggregateNotes(db, { aggregate: { group_by: "status", op: "count" } })).toThrow(QueryError);
    try {
      aggregateNotes(db, { aggregate: { group_by: "status", op: "count" } });
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.code).toBe("FIELD_NOT_INDEXED");
    }
  });

  it("throws INVALID_QUERY when op is \"sum\" without a field", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    try {
      aggregateNotes(db, { aggregate: { group_by: "status", op: "sum" } });
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.name).toBe("QueryError");
      expect(e.code).toBe("INVALID_QUERY");
      expect(e.field).toBe("aggregate.field");
    }
  });

  it("throws FIELD_NOT_INDEXED when the sum field isn't indexed", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    try {
      aggregateNotes(db, { aggregate: { group_by: "status", op: "sum", field: "amount" } });
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.code).toBe("FIELD_NOT_INDEXED");
    }
  });

  // LB — a `type: "number"` (float) field can NEVER be `indexed: true`
  // (only integer/boolean are indexable numeric shapes), so it legitimately
  // never appears in `indexed_fields`. Before the fix, the FIELD_NOT_INDEXED
  // thrown here carried the SAME generic "declare it via update-tag with
  // indexed: true" hint every other unindexed field gets — advice that's
  // impossible to satisfy for `number` specifically, dead-ending an agent
  // that tries it and hits the SEPARATE "unsupported type ... for indexing"
  // error. The hint must instead name the real fix: store as an integer.
  it("FIELD_NOT_INDEXED on a type: \"number\" sum field carries an actionable hint, not the impossible generic \"declare indexed: true\" advice", async () => {
    await store.upsertTagRecord("expense", { fields: { amount: { type: "number" } } });
    await store.createNote("a", { tags: ["expense"], metadata: { amount: 9.99 } });
    try {
      aggregateNotes(db, { aggregate: { group_by: "tag", op: "sum", field: "amount" } });
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.code).toBe("FIELD_NOT_INDEXED");
      expect(e.message).not.toContain("declare it via update-tag with indexed: true");
      const guidance = `${e.message} ${e.hint ?? ""}`.toLowerCase();
      expect(guidance).toContain("integer");
      expect(guidance).toMatch(/float|number|decimal/);
    }
  });

  it("throws INVALID_QUERY when the sum field is indexed but not numeric (TEXT-backed)", async () => {
    await store.upsertTagRecord("task", {
      fields: {
        status: { type: "string", indexed: true },
        label: { type: "string", indexed: true },
      },
    });
    try {
      aggregateNotes(db, { aggregate: { group_by: "status", op: "sum", field: "label" } });
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.name).toBe("QueryError");
      expect(e.code).toBe("INVALID_QUERY");
      expect(e.field).toBe("aggregate.field");
    }
  });

  it("throws INVALID_QUERY on an unrecognized op", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    try {
      aggregateNotes(db, { aggregate: { group_by: "status", op: "average" as any } });
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.name).toBe("QueryError");
      expect(e.code).toBe("INVALID_QUERY");
      expect(e.field).toBe("aggregate.op");
    }
  });

  it("throws INVALID_QUERY when aggregate is entirely missing", () => {
    expect(() => aggregateNotes(db, {})).toThrow(QueryError);
  });

  it("throws INVALID_QUERY on an empty group_by", async () => {
    try {
      aggregateNotes(db, { aggregate: { group_by: "", op: "count" } });
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.name).toBe("QueryError");
      expect(e.code).toBe("INVALID_QUERY");
      expect(e.field).toBe("aggregate.group_by");
    }
  });
});
