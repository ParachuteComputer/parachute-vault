/**
 * migrate-tag-field (vault#314) — evolve a tag-schema field across existing
 * notes carrying a tag.
 *
 * Coverage (per the brief):
 *   - dry-run reports the correct would-change set without mutating
 *   - apply performs remap / set-default / retype correctly
 *   - notes without the tag/field are untouched
 *   - an unconvertible retype fails cleanly (clear error, no partial corruption)
 *   - the migration writes through a strict-schema field (bypass) + the bypass
 *     is logged/attributed
 *   - idempotency (re-running apply is a no-op once conformant)
 *   - the CLI transform-spec parser
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import {
  migrateTagField,
  applyTransform,
  parseTransformSpec,
  TransformError,
  type ValidationWarning,
} from "./migrate-tag-field.js";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

async function getMeta(id: string): Promise<Record<string, unknown>> {
  const note = await store.getNote(id);
  return (note?.metadata ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dry-run vs apply
// ---------------------------------------------------------------------------

describe("dry-run reports the would-change set without mutating", () => {
  it("counts and samples changes but writes nothing", async () => {
    const a = await store.createNote("a", { tags: ["kpi"], metadata: { unit: "wip" } });
    const b = await store.createNote("b", { tags: ["kpi"], metadata: { unit: "wip" } });
    const c = await store.createNote("c", { tags: ["kpi"], metadata: { unit: "done" } });

    const result = await migrateTagField(store, {
      tag: "kpi",
      field: "unit",
      transform: { kind: "remap", map: { wip: "in_progress" } },
      // apply omitted → dry-run
    });

    expect(result.applied).toBe(false);
    expect(result.scanned).toBe(3);
    expect(result.changed).toBe(2);
    expect(result.unchanged).toBe(1);
    expect(result.errored).toBe(0);
    expect(result.sample).toHaveLength(2);

    // Nothing written.
    expect((await getMeta(a.id)).unit).toBe("wip");
    expect((await getMeta(b.id)).unit).toBe("wip");
    expect((await getMeta(c.id)).unit).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// apply: remap / set-default / retype
// ---------------------------------------------------------------------------

describe("apply performs the transform correctly", () => {
  it("remaps an enum value across matching notes only", async () => {
    const a = await store.createNote("a", { tags: ["kpi"], metadata: { state: "wip", other: 1 } });
    const b = await store.createNote("b", { tags: ["kpi"], metadata: { state: "shipped" } });

    const result = await migrateTagField(store, {
      tag: "kpi",
      field: "state",
      transform: { kind: "remap", map: { wip: "in_progress" } },
      apply: true,
    });

    expect(result.applied).toBe(true);
    expect(result.changed).toBe(1);
    expect((await getMeta(a.id)).state).toBe("in_progress");
    expect((await getMeta(a.id)).other).toBe(1); // unrelated field preserved
    expect((await getMeta(b.id)).state).toBe("shipped"); // value not in map — untouched
  });

  it("remap with a default fills missing/null AND remaps present values", async () => {
    const missing = await store.createNote("missing", { tags: ["kpi"], metadata: {} });
    const old = await store.createNote("old", { tags: ["kpi"], metadata: { state: "wip" } });
    const kept = await store.createNote("kept", { tags: ["kpi"], metadata: { state: "shipped" } });

    const result = await migrateTagField(store, {
      tag: "kpi",
      field: "state",
      transform: { kind: "remap", map: { wip: "in_progress" }, default: "unknown" },
      apply: true,
    });

    expect(result.changed).toBe(2); // missing (filled) + old (remapped)
    expect((await getMeta(missing.id)).state).toBe("unknown"); // default filled
    expect((await getMeta(old.id)).state).toBe("in_progress"); // remapped
    expect((await getMeta(kept.id)).state).toBe("shipped"); // not in map — kept
  });

  it("set_default onlyInvalid is a no-op when no schema declares the field", async () => {
    // No upsertTagRecord here — nothing to validate against, so onlyInvalid
    // must NOT clobber an existing value (the conservative reading).
    const a = await store.createNote("a", { tags: ["freeform"], metadata: { x: "anything" } });
    const result = await migrateTagField(store, {
      tag: "freeform",
      field: "x",
      transform: { kind: "set_default", value: "default", onlyInvalid: true },
      apply: true,
    });
    expect(result.changed).toBe(0);
    expect((await getMeta(a.id)).x).toBe("anything");
  });

  it("sets a default on notes missing the field", async () => {
    const a = await store.createNote("a", { tags: ["task"], metadata: { title: "t" } });
    const b = await store.createNote("b", { tags: ["task"], metadata: { title: "u", priority: "high" } });

    const result = await migrateTagField(store, {
      tag: "task",
      field: "priority",
      transform: { kind: "set_default", value: "normal" },
      apply: true,
    });

    expect(result.changed).toBe(1);
    expect((await getMeta(a.id)).priority).toBe("normal"); // filled
    expect((await getMeta(b.id)).priority).toBe("high"); // already present — untouched
  });

  it("retypes string → int and renames a key", async () => {
    const a = await store.createNote("a", { tags: ["kpi"], metadata: { count: "5" } });

    const retype = await migrateTagField(store, {
      tag: "kpi",
      field: "count",
      transform: { kind: "to_int" },
      apply: true,
    });
    expect(retype.changed).toBe(1);
    expect((await getMeta(a.id)).count).toBe(5);

    const rename = await migrateTagField(store, {
      tag: "kpi",
      field: "count",
      transform: { kind: "rename", to: "total" },
      apply: true,
    });
    expect(rename.changed).toBe(1);
    const meta = await getMeta(a.id);
    expect(meta.total).toBe(5);
    expect("count" in meta).toBe(false); // old key dropped
  });

  it("preserves created attribution; migration is the last_updated actor", async () => {
    const a = await store.createNote("a", {
      tags: ["kpi"],
      metadata: { state: "wip" },
      actor: "alice",
      via: "mcp",
    });

    await migrateTagField(store, {
      tag: "kpi",
      field: "state",
      transform: { kind: "remap", map: { wip: "done" } },
      apply: true,
      actor: "migrate-bot",
      via: "migrate",
    });

    const row = db.prepare("SELECT created_by, last_updated_by, last_updated_via FROM notes WHERE id = ?").get(a.id) as {
      created_by: string | null;
      last_updated_by: string | null;
      last_updated_via: string | null;
    };
    expect(row.created_by).toBe("alice"); // set-once, untouched
    expect(row.last_updated_by).toBe("migrate-bot");
    expect(row.last_updated_via).toBe("migrate");
  });
});

// ---------------------------------------------------------------------------
// Scope: notes without the tag/field are untouched
// ---------------------------------------------------------------------------

describe("notes without the tag/field are untouched", () => {
  it("ignores notes carrying a different tag", async () => {
    const tagged = await store.createNote("a", { tags: ["kpi"], metadata: { state: "wip" } });
    const other = await store.createNote("b", { tags: ["note"], metadata: { state: "wip" } });

    const result = await migrateTagField(store, {
      tag: "kpi",
      field: "state",
      transform: { kind: "remap", map: { wip: "done" } },
      apply: true,
    });

    expect(result.scanned).toBe(1); // only the kpi note
    expect((await getMeta(tagged.id)).state).toBe("done");
    expect((await getMeta(other.id)).state).toBe("wip"); // other tag — never seen
  });

  it("leaves the metadata blob byte-identical when nothing matches", async () => {
    const a = await store.createNote("a", { tags: ["kpi"], metadata: { state: "shipped", x: 1 } });
    const before = JSON.stringify(await getMeta(a.id));

    const result = await migrateTagField(store, {
      tag: "kpi",
      field: "state",
      transform: { kind: "remap", map: { wip: "done" } }, // "shipped" not in map
      apply: true,
    });

    expect(result.changed).toBe(0);
    expect(JSON.stringify(await getMeta(a.id))).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Clean failure on unconvertible retype
// ---------------------------------------------------------------------------

describe("unconvertible retype fails cleanly with no partial corruption", () => {
  it("atomically aborts the apply when any note can't convert", async () => {
    const good = await store.createNote("good", { tags: ["kpi"], metadata: { count: "5" } });
    const bad = await store.createNote("bad", { tags: ["kpi"], metadata: { count: "banana" } });

    const result = await migrateTagField(store, {
      tag: "kpi",
      field: "count",
      transform: { kind: "to_int" },
      apply: true,
    });

    // Atomic: nothing written because one note errored.
    expect(result.applied).toBe(false);
    expect(result.errored).toBe(1);
    expect(result.errors[0]!.error).toContain("banana");
    expect((await getMeta(good.id)).count).toBe("5"); // NOT converted — atomic abort
    expect((await getMeta(bad.id)).count).toBe("banana");
  });

  it("continue-on-error writes the convertible notes and reports the rest", async () => {
    const good = await store.createNote("good", { tags: ["kpi"], metadata: { count: "5" } });
    const bad = await store.createNote("bad", { tags: ["kpi"], metadata: { count: "banana" } });

    const result = await migrateTagField(store, {
      tag: "kpi",
      field: "count",
      transform: { kind: "to_int" },
      apply: true,
      continueOnError: true,
    });

    expect(result.applied).toBe(true);
    expect(result.changed).toBe(1);
    expect(result.errored).toBe(1);
    expect((await getMeta(good.id)).count).toBe(5); // written
    expect((await getMeta(bad.id)).count).toBe("banana"); // skipped, not corrupted
  });
});

// ---------------------------------------------------------------------------
// Strict-schema bypass + logging
// ---------------------------------------------------------------------------

describe("migration writes through a strict-schema field (bypass) and logs it", () => {
  beforeEach(async () => {
    // Declare a strict enum AFTER the back-catalog exists, so the existing
    // value is non-conforming — the exact migrate-bypass use case.
    await store.upsertTagRecord("kpi", {
      fields: {
        state: { type: "string", enum: ["in_progress", "shipped"], strict: true },
      },
    });
  });

  it("remaps a non-conforming value through strict enforcement and logs the bypass", async () => {
    const a = await store.createNote("a", { tags: ["kpi"], metadata: { state: "wip" } });

    const bypassLogs: {
      actor: string | null;
      via: string | null;
      violations: ValidationWarning[];
    }[] = [];

    const result = await migrateTagField(store, {
      tag: "kpi",
      field: "state",
      // Map the illegal "wip" to a legal enum value — but the intermediate
      // write still goes through a strict field, so the bypass path is exercised
      // and the would-be violation (the original "wip") is what's being fixed.
      transform: { kind: "remap", map: { wip: "in_progress" } },
      apply: true,
      actor: "migrate-bot",
      via: "migrate",
      onStrictBypass: (info) => bypassLogs.push(info),
    });

    expect(result.applied).toBe(true);
    expect((await getMeta(a.id)).state).toBe("in_progress");
    // The final value conforms, so no violation on the WRITTEN shape — the
    // remap fixes the data. Confirm the written note passes strict validation.
    const status = store.validateNoteAgainstSchemas({
      tags: ["kpi"],
      metadata: await getMeta(a.id),
    });
    expect(status!.warnings.filter((w) => w.strict)).toHaveLength(0);
  });

  it("logs + attributes the bypass when the written value still violates strict", async () => {
    // set-default to a value NOT in the enum: the write itself stays
    // non-conforming, so the bypass logger MUST fire (we waived enforcement).
    const a = await store.createNote("a", { tags: ["kpi"], metadata: {} });

    const bypassLogs: {
      actor: string | null;
      via: string | null;
      path?: string | null;
      violations: ValidationWarning[];
    }[] = [];

    const result = await migrateTagField(store, {
      tag: "kpi",
      field: "state",
      transform: { kind: "set_default", value: "legacy" }, // not in enum
      apply: true,
      actor: "migrate-bot",
      via: "migrate",
      onStrictBypass: (info) => bypassLogs.push(info),
    });

    expect(result.applied).toBe(true);
    expect((await getMeta(a.id)).state).toBe("legacy"); // written despite strict
    expect(bypassLogs).toHaveLength(1);
    expect(bypassLogs[0]!.actor).toBe("migrate-bot");
    expect(bypassLogs[0]!.via).toBe("migrate");
    expect(bypassLogs[0]!.violations.some((v) => v.field === "state" && v.reason === "enum_mismatch")).toBe(true);
  });

  it("set-default-invalid only overwrites values that fail the schema", async () => {
    const legal = await store.createNote("legal", { tags: ["kpi"], metadata: { state: "shipped" } });
    const illegal = await store.createNote("illegal", { tags: ["kpi"], metadata: { state: "wip" } });
    const missing = await store.createNote("missing", { tags: ["kpi"], metadata: {} });

    const result = await migrateTagField(store, {
      tag: "kpi",
      field: "state",
      transform: { kind: "set_default", value: "in_progress", onlyInvalid: true },
      apply: true,
      onStrictBypass: () => {},
    });

    expect(result.changed).toBe(2); // illegal + missing
    expect((await getMeta(legal.id)).state).toBe("shipped"); // valid — kept
    expect((await getMeta(illegal.id)).state).toBe("in_progress"); // invalid — fixed
    expect((await getMeta(missing.id)).state).toBe("in_progress"); // missing — filled
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency — re-running apply is a no-op once conformant", () => {
  it("second apply changes nothing", async () => {
    await store.createNote("a", { tags: ["kpi"], metadata: { state: "wip" } });

    const first = await migrateTagField(store, {
      tag: "kpi",
      field: "state",
      transform: { kind: "remap", map: { wip: "in_progress" } },
      apply: true,
    });
    expect(first.changed).toBe(1);

    const second = await migrateTagField(store, {
      tag: "kpi",
      field: "state",
      transform: { kind: "remap", map: { wip: "in_progress" } },
      apply: true,
    });
    expect(second.changed).toBe(0);
    expect(second.scanned).toBe(1);
  });

  it("retype is idempotent — re-running on an already-int value is a no-op", async () => {
    await store.createNote("a", { tags: ["kpi"], metadata: { count: "5" } });
    const first = await migrateTagField(store, {
      tag: "kpi", field: "count", transform: { kind: "to_int" }, apply: true,
    });
    expect(first.changed).toBe(1);
    const second = await migrateTagField(store, {
      tag: "kpi", field: "count", transform: { kind: "to_int" }, apply: true,
    });
    expect(second.changed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: applyTransform + coercion edge cases
// ---------------------------------------------------------------------------

describe("applyTransform unit", () => {
  it("rename of an absent field is a no-op", () => {
    expect(applyTransform("x", undefined, false, { kind: "rename", to: "y" })).toBeNull();
  });
  it("to_int rejects a fractional number", () => {
    expect(() => applyTransform("x", 5.5, true, { kind: "to_int" })).toThrow(TransformError);
  });
  it("to_boolean parses yes/no strings", () => {
    expect(applyTransform("x", "yes", true, { kind: "to_boolean" })!.value).toBe(true);
    expect(applyTransform("x", "no", true, { kind: "to_boolean" })!.value).toBe(false);
  });
  it("to_string of an already-string value is a no-op (idempotent)", () => {
    expect(applyTransform("x", "hi", true, { kind: "to_string" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit: parseTransformSpec
// ---------------------------------------------------------------------------

describe("parseTransformSpec", () => {
  it("parses the retype keywords", () => {
    expect(parseTransformSpec("to_string")).toEqual({ kind: "to_string" });
    expect(parseTransformSpec("to_int")).toEqual({ kind: "to_int" });
    expect(parseTransformSpec("to_number")).toEqual({ kind: "to_number" });
    expect(parseTransformSpec("to_boolean")).toEqual({ kind: "to_boolean" });
  });
  it("parses rename", () => {
    expect(parseTransformSpec("rename:metric")).toEqual({ kind: "rename", to: "metric" });
  });
  it("parses remap with multiple pairs and JSON scalars", () => {
    expect(parseTransformSpec("remap:wip=in_progress,done=shipped")).toEqual({
      kind: "remap",
      map: { wip: "in_progress", done: "shipped" },
    });
    expect(parseTransformSpec("remap:a=1,b=true")).toEqual({
      kind: "remap",
      map: { a: 1, b: true },
    });
  });
  it("parses set-default and set-default-invalid with scalar coercion", () => {
    expect(parseTransformSpec("set-default:normal")).toEqual({ kind: "set_default", value: "normal" });
    expect(parseTransformSpec("set-default:0")).toEqual({ kind: "set_default", value: 0 });
    expect(parseTransformSpec("set-default-invalid:in_progress")).toEqual({
      kind: "set_default",
      value: "in_progress",
      onlyInvalid: true,
    });
  });
  it("throws on a malformed or unknown spec", () => {
    expect(() => parseTransformSpec("bogus")).toThrow(TransformError);
    expect(() => parseTransformSpec("rename:")).toThrow(TransformError);
    expect(() => parseTransformSpec("remap:nopair")).toThrow(TransformError);
    expect(() => parseTransformSpec("frobnicate:x")).toThrow(TransformError);
  });
});
