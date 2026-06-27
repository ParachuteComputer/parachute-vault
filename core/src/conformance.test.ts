/**
 * Conformance check (vault#283) — counting existing notes that would violate
 * a proposed tightening of a tag's field spec. Backs the Schema editor's
 * "N existing notes violate this" warning.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { countConformanceViolations } from "./conformance.js";

let db: Database;
let store: SqliteStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("countConformanceViolations", () => {
  it("returns zero violations when proposed fields is empty", async () => {
    await store.createNote("n", { tags: ["task"], metadata: { status: "open" } });
    const r = countConformanceViolations(db, "task", {});
    expect(r.total_notes).toBe(1);
    expect(r.violating_notes).toBe(0);
    expect(r.checked_fields).toEqual([]);
  });

  it("counts notes missing a newly-required field", async () => {
    await store.createNote("has", { tags: ["task"], metadata: { due: "2026-01-01" } });
    await store.createNote("missing-1", { tags: ["task"], metadata: {} });
    await store.createNote("missing-2", { tags: ["task"] });

    const r = countConformanceViolations(db, "task", {
      due: { type: "string", required: true },
    });
    expect(r.total_notes).toBe(3);
    expect(r.violating_notes).toBe(2);
    expect(r.checked_fields).toEqual(["due"]);
    // missing_required reasons surface in the sample.
    expect(r.sample.every((s) => s.fields.some((f) => f.reason === "missing_required"))).toBe(true);
  });

  it("counts notes whose value falls outside a narrowed enum", async () => {
    await store.createNote("ok", { tags: ["task"], metadata: { status: "open" } });
    await store.createNote("bad", { tags: ["task"], metadata: { status: "archived" } });

    const r = countConformanceViolations(db, "task", {
      status: { type: "string", enum: ["open", "done"] },
    });
    expect(r.violating_notes).toBe(1);
    expect(r.sample[0]?.fields[0]?.reason).toBe("enum_mismatch");
  });

  it("counts notes whose value contradicts a changed type", async () => {
    await store.createNote("num", { tags: ["task"], metadata: { count: 3 } });
    await store.createNote("str", { tags: ["task"], metadata: { count: "three" } });

    const r = countConformanceViolations(db, "task", {
      count: { type: "integer" },
    });
    expect(r.violating_notes).toBe(1);
    expect(r.sample[0]?.fields[0]?.reason).toBe("type_mismatch");
  });

  it("includes descendant-tag notes via inheritance", async () => {
    // dev/log declares dev as a parent → a strict field on dev applies to
    // dev/log notes too.
    await store.upsertTagRecord("dev/log", { parent_names: ["dev"] });
    await store.createNote("parent-note", { tags: ["dev"], metadata: {} });
    await store.createNote("child-note", { tags: ["dev/log"], metadata: {} });

    const r = countConformanceViolations(db, "dev", {
      kind: { type: "string", required: true },
    });
    expect(r.total_notes).toBe(2);
    expect(r.violating_notes).toBe(2);
  });

  it("ignores fields the proposal does not touch", async () => {
    await store.createNote("n", { tags: ["task"], metadata: { other: 123 } });
    // We only propose `status`; `other` being weird is irrelevant.
    const r = countConformanceViolations(db, "task", {
      status: { type: "string" },
    });
    // `status` absent + not required → no violation.
    expect(r.violating_notes).toBe(0);
  });

  it("caps the sample at sampleLimit but counts all violations", async () => {
    for (let i = 0; i < 5; i++) {
      await store.createNote(`n${i}`, { tags: ["task"], metadata: {} });
    }
    const r = countConformanceViolations(
      db,
      "task",
      { req: { type: "string", required: true } },
      { sampleLimit: 2 },
    );
    expect(r.violating_notes).toBe(5);
    expect(r.sample.length).toBe(2);
  });
});

describe("store.countTagConformance", () => {
  it("proxies to the core helper", async () => {
    await store.createNote("n", { tags: ["task"], metadata: {} });
    const r = await store.countTagConformance("task", {
      due: { type: "string", required: true },
    });
    expect(r.violating_notes).toBe(1);
  });
});
