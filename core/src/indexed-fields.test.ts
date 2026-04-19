import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools, type McpToolDef } from "./mcp.js";
import {
  IndexedFieldError,
  declareField,
  getIndexedField,
  listIndexedFields,
  rebuildIndexes,
  releaseField,
  TYPE_MAP,
  validateFieldName,
} from "./indexed-fields.js";

let db: Database;
let store: SqliteStore;
let tools: Record<string, McpToolDef>;

function findTool(name: string): McpToolDef {
  const t = tools[name];
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
  tools = Object.fromEntries(generateMcpTools(store).map((t) => [t.name, t]));
});

function notesColumns(): string[] {
  return (db.prepare("PRAGMA table_xinfo(notes)").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

function notesIndexes(): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notes'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

describe("indexed-fields: module", () => {
  it("schema creates the indexed_fields table", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_fields'")
      .get();
    expect(row).toBeTruthy();
  });

  it("validateFieldName accepts safe identifiers", () => {
    expect(() => validateFieldName("status")).not.toThrow();
    expect(() => validateFieldName("first_seen_at")).not.toThrow();
    expect(() => validateFieldName("_private")).not.toThrow();
  });

  it("validateFieldName rejects unsafe names", () => {
    expect(() => validateFieldName("has-dash")).toThrow(IndexedFieldError);
    expect(() => validateFieldName("1leading_digit")).toThrow(IndexedFieldError);
    expect(() => validateFieldName("has space")).toThrow(IndexedFieldError);
    expect(() => validateFieldName("'; DROP TABLE notes; --")).toThrow(IndexedFieldError);
  });

  it("TYPE_MAP covers string/integer/boolean", () => {
    expect(TYPE_MAP.string).toBe("TEXT");
    expect(TYPE_MAP.integer).toBe("INTEGER");
    expect(TYPE_MAP.boolean).toBe("INTEGER");
  });

  it("declareField creates column + index on first declaration", () => {
    declareField(db, "status", "TEXT", "project");
    expect(notesColumns()).toContain("meta_status");
    expect(notesIndexes()).toContain("idx_meta_status");
    const row = getIndexedField(db, "status");
    expect(row?.sqliteType).toBe("TEXT");
    expect(row?.declarerTags).toEqual(["project"]);
  });

  it("declareField adds second declarer without duplicating the column", () => {
    declareField(db, "status", "TEXT", "project");
    declareField(db, "status", "TEXT", "ticket");
    const row = getIndexedField(db, "status");
    expect(row?.declarerTags).toEqual(["project", "ticket"]);
    const statusColumns = notesColumns().filter((c) => c === "meta_status");
    expect(statusColumns).toHaveLength(1);
  });

  it("declareField is idempotent when the tag is already a declarer", () => {
    declareField(db, "status", "TEXT", "project");
    declareField(db, "status", "TEXT", "project");
    const row = getIndexedField(db, "status");
    expect(row?.declarerTags).toEqual(["project"]);
  });

  it("declareField throws on type mismatch with other declarers", () => {
    declareField(db, "priority", "INTEGER", "project");
    expect(() => declareField(db, "priority", "TEXT", "ticket")).toThrow(IndexedFieldError);
    const row = getIndexedField(db, "priority");
    expect(row?.sqliteType).toBe("INTEGER");
    expect(row?.declarerTags).toEqual(["project"]);
  });

  it("declareField allows a sole declarer to change type (drops + recreates)", () => {
    declareField(db, "priority", "TEXT", "project");
    declareField(db, "priority", "INTEGER", "project");
    const row = getIndexedField(db, "priority");
    expect(row?.sqliteType).toBe("INTEGER");
  });

  it("releaseField removes a single declarer but keeps column while others remain", () => {
    declareField(db, "status", "TEXT", "project");
    declareField(db, "status", "TEXT", "ticket");
    const dropped = releaseField(db, "status", "project");
    expect(dropped).toBe(false);
    expect(notesColumns()).toContain("meta_status");
    const row = getIndexedField(db, "status");
    expect(row?.declarerTags).toEqual(["ticket"]);
  });

  it("releaseField drops column + index when last declarer leaves", () => {
    declareField(db, "status", "TEXT", "project");
    const dropped = releaseField(db, "status", "project");
    expect(dropped).toBe(true);
    expect(notesColumns()).not.toContain("meta_status");
    expect(notesIndexes()).not.toContain("idx_meta_status");
    expect(getIndexedField(db, "status")).toBeNull();
  });

  it("releaseField is a no-op for unknown field", () => {
    expect(releaseField(db, "nonexistent", "t")).toBe(false);
  });

  it("indexed column reflects json_extract of metadata at query time", async () => {
    declareField(db, "priority", "INTEGER", "project");
    await store.createNote("a", { metadata: { priority: 1 } });
    await store.createNote("b", { metadata: { priority: 5 } });
    await store.createNote("c", { metadata: { priority: 3 } });
    const rows = db
      .prepare("SELECT id, meta_priority FROM notes ORDER BY meta_priority")
      .all() as { id: string; meta_priority: number }[];
    expect(rows.map((r) => r.meta_priority)).toEqual([1, 3, 5]);
  });

  it("listIndexedFields returns rows ordered by field", () => {
    declareField(db, "zeta", "TEXT", "t");
    declareField(db, "alpha", "TEXT", "t");
    declareField(db, "mu", "TEXT", "t");
    expect(listIndexedFields(db).map((f) => f.field)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("rebuildIndexes restores columns that are missing from notes", () => {
    declareField(db, "status", "TEXT", "project");
    // Simulate a stale DB: drop the column while leaving the row intact.
    db.exec('DROP INDEX IF EXISTS "idx_meta_status"');
    db.exec('ALTER TABLE notes DROP COLUMN "meta_status"');
    expect(notesColumns()).not.toContain("meta_status");
    rebuildIndexes(db);
    expect(notesColumns()).toContain("meta_status");
    expect(notesIndexes()).toContain("idx_meta_status");
  });
});

describe("update-tag: indexed flag", () => {
  it("declaring indexed field creates column + index", async () => {
    await findTool("update-tag").execute({
      tag: "project",
      fields: { status: { type: "string", indexed: true } },
    });
    expect(notesColumns()).toContain("meta_status");
    expect(notesIndexes()).toContain("idx_meta_status");
    expect(getIndexedField(db, "status")?.declarerTags).toEqual(["project"]);
  });

  it("second declarer with matching type joins the declarer set", async () => {
    const t = findTool("update-tag");
    await t.execute({ tag: "project", fields: { status: { type: "string", indexed: true } } });
    await t.execute({ tag: "ticket", fields: { status: { type: "string", indexed: true } } });
    expect(getIndexedField(db, "status")?.declarerTags).toEqual(["project", "ticket"]);
  });

  it("type conflict across declarers throws and names the other tag", async () => {
    const t = findTool("update-tag");
    await t.execute({ tag: "project", fields: { status: { type: "string", indexed: true } } });
    expect(() =>
      t.execute({ tag: "ticket", fields: { status: { type: "integer", indexed: true } } }),
    ).toThrow(/tag "project".*"string"/);
  });

  it("indexed-flag conflict across declarers throws", async () => {
    const t = findTool("update-tag");
    await t.execute({ tag: "project", fields: { priority: { type: "integer", indexed: true } } });
    expect(() =>
      t.execute({ tag: "ticket", fields: { priority: { type: "integer", indexed: false } } }),
    ).toThrow(/indexed-flag conflict/);
  });

  it("unsupported field type for indexing throws", async () => {
    expect(() =>
      findTool("update-tag").execute({
        tag: "project",
        fields: { weird: { type: "date", indexed: true } },
      }),
    ).toThrow(/unsupported type "date"/);
  });

  it("invalid field name for indexing throws", async () => {
    expect(() =>
      findTool("update-tag").execute({
        tag: "project",
        fields: { "bad-name": { type: "string", indexed: true } },
      }),
    ).toThrow(IndexedFieldError);
  });

  it("rejects non-atomic indexed-flag change while other declarers hold it true", async () => {
    const t = findTool("update-tag");
    await t.execute({ tag: "project", fields: { status: { type: "string", indexed: true } } });
    await t.execute({ tag: "ticket", fields: { status: { type: "string", indexed: true } } });
    expect(() =>
      t.execute({
        tag: "project",
        fields: { status: { type: "string", indexed: false } },
      }),
    ).toThrow(/indexed-flag conflict.*tag "ticket"/);
    expect(getIndexedField(db, "status")?.declarerTags).toEqual(["project", "ticket"]);
  });

  it("last declarer releasing drops column + index", async () => {
    const t = findTool("update-tag");
    await t.execute({ tag: "project", fields: { status: { type: "string", indexed: true } } });
    await t.execute({ tag: "project", fields: { status: { type: "string", indexed: false } } });
    expect(getIndexedField(db, "status")).toBeNull();
    expect(notesColumns()).not.toContain("meta_status");
  });

  it("indexing a boolean field maps to INTEGER storage", async () => {
    await findTool("update-tag").execute({
      tag: "project",
      fields: { archived: { type: "boolean", indexed: true } },
    });
    expect(getIndexedField(db, "archived")?.sqliteType).toBe("INTEGER");
  });

  it("non-indexed fields are not tracked", async () => {
    await findTool("update-tag").execute({
      tag: "project",
      fields: { notes: { type: "string" } },
    });
    expect(listIndexedFields(db)).toEqual([]);
    expect(notesColumns()).not.toContain("meta_notes");
  });
});

describe("delete-tag: indexed fields", () => {
  it("releases indexed fields the tag declared", async () => {
    const update = findTool("update-tag");
    const del = findTool("delete-tag");
    await update.execute({
      tag: "project",
      fields: { status: { type: "string", indexed: true } },
    });
    await del.execute({ tag: "project" });
    expect(getIndexedField(db, "status")).toBeNull();
    expect(notesColumns()).not.toContain("meta_status");
  });

  it("keeps the column if another tag still declares the field", async () => {
    const update = findTool("update-tag");
    const del = findTool("delete-tag");
    await update.execute({
      tag: "project",
      fields: { status: { type: "string", indexed: true } },
    });
    await update.execute({
      tag: "ticket",
      fields: { status: { type: "string", indexed: true } },
    });
    await del.execute({ tag: "project" });
    expect(getIndexedField(db, "status")?.declarerTags).toEqual(["ticket"]);
    expect(notesColumns()).toContain("meta_status");
  });
});
