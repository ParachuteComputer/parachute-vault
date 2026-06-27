import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import { stripTagHash } from "./tag-hierarchy.js";

// Canonical-bare-tag guard (PR #516). A `#`-prefixed tag must never be stored
// or mismatched: the agent module stored `#agent/message/inbound` literally and
// consumers querying the bare `agent/message/inbound` convention found nothing.
// The guard strips a leading `#` (idempotently) on BOTH the write path and the
// query path, while preserving casing + structure (it is NOT normalizeTagValue).

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

/** Raw read of a note's stored tag rows (bypasses any hydration). */
function storedTags(noteId: string): string[] {
  return (
    db
      .prepare("SELECT tag_name FROM note_tags WHERE note_id = ? ORDER BY tag_name")
      .all(noteId) as { tag_name: string }[]
  ).map((r) => r.tag_name);
}

describe("stripTagHash helper", () => {
  it("strips a single leading #", () => {
    expect(stripTagHash("#agent/message")).toBe("agent/message");
  });

  it("is idempotent across one or more leading # (##x → x, x → x)", () => {
    expect(stripTagHash("##x")).toBe("x");
    expect(stripTagHash("###deep")).toBe("deep");
    expect(stripTagHash("x")).toBe("x");
    expect(stripTagHash(stripTagHash("#x"))).toBe("x");
  });

  it("does NOT lowercase or otherwise transform — casing + structure preserved", () => {
    expect(stripTagHash("#Agent/Message/Inbound")).toBe("Agent/Message/Inbound");
    expect(stripTagHash("CamelCase")).toBe("CamelCase");
  });

  it("only strips LEADING # — a mid-string # (e.g. c#) is left intact", () => {
    expect(stripTagHash("c#")).toBe("c#");
    expect(stripTagHash("#c#")).toBe("c#");
    expect(stripTagHash("a#b")).toBe("a#b");
  });

  it("trims surrounding whitespace before stripping", () => {
    expect(stripTagHash("  #tag ")).toBe("tag");
  });
});

describe("write path — tags stored bare", () => {
  it("createNote: #agent/message stored as agent/message", async () => {
    const note = await store.createNote("inbound", { tags: ["#agent/message"] });
    expect(storedTags(note.id)).toEqual(["agent/message"]);
    expect(note.tags).toEqual(["agent/message"]);
  });

  it("##x stored as x; a bare foo is unchanged", async () => {
    const note = await store.createNote("memo", { tags: ["##x", "foo"] });
    expect(storedTags(note.id).sort()).toEqual(["foo", "x"]);
  });

  it("a # mid-string (c#) is NOT mangled", async () => {
    const note = await store.createNote("memo", { tags: ["c#"] });
    expect(storedTags(note.id)).toEqual(["c#"]);
  });

  it("casing is preserved through the write path", async () => {
    const note = await store.createNote("memo", { tags: ["#Agent/Inbound"] });
    expect(storedTags(note.id)).toEqual(["Agent/Inbound"]);
  });

  it("tagNote: #-prefixed add lands on the bare row", async () => {
    const note = await store.createNote("memo");
    await store.tagNote(note.id, ["#later"]);
    expect(storedTags(note.id)).toEqual(["later"]);
  });

  it("untagNote: removing #tag deletes the bare row", async () => {
    const note = await store.createNote("memo", { tags: ["later"] });
    await store.untagNote(note.id, ["#later"]);
    expect(storedTags(note.id)).toEqual([]);
  });

  it("batchTag/batchUntag normalize independently of tagNote", async () => {
    const a = await store.createNote("a");
    const b = await store.createNote("b");
    await store.batchTag([a.id, b.id], ["#batch"]);
    expect(storedTags(a.id)).toEqual(["batch"]);
    expect(storedTags(b.id)).toEqual(["batch"]);
    await store.batchUntag([a.id], ["#batch"]);
    expect(storedTags(a.id)).toEqual([]);
    expect(storedTags(b.id)).toEqual(["batch"]);
  });

  it("create-note via MCP also stores bare", async () => {
    const tools = generateMcpTools(store);
    const createNote = tools.find((t) => t.name === "create-note")!;
    const res = (await createNote.execute({
      content: "mcp inbound",
      tags: ["#agent/message/inbound"],
    })) as { id: string };
    expect(storedTags(res.id)).toEqual(["agent/message/inbound"]);
  });
});

describe("query path — # and bare forms equivalent", () => {
  it("query tag:#agent/message and tag:agent/message both match the same bare-stored note", async () => {
    const note = await store.createNote("inbound", { tags: ["agent/message"] });

    const byHash = await store.queryNotes({ tags: ["#agent/message"] });
    expect(byHash.map((n) => n.id)).toContain(note.id);

    const byBare = await store.queryNotes({ tags: ["agent/message"] });
    expect(byBare.map((n) => n.id)).toContain(note.id);
  });

  it("an old #-form query reaches a #-decorated WRITE (both normalize to the same bare row)", async () => {
    // The non-breaking guarantee: a client that writes AND queries with the
    // legacy #-form still works — both sides converge on the bare row. (Truly
    // pre-fix #-STORED data is migrated away via renameTag, not auto-reached.)
    const note = await store.createNote("inbound", { tags: ["#agent/message"] });
    const byHash = await store.queryNotes({ tags: ["#agent/message"] });
    expect(byHash.map((n) => n.id)).toContain(note.id);
    const byBare = await store.queryNotes({ tags: ["agent/message"] });
    expect(byBare.map((n) => n.id)).toContain(note.id);
  });

  it("exclude_tags #x excludes x-tagged notes", async () => {
    const kept = await store.createNote("kept", { tags: ["keep"] });
    const dropped = await store.createNote("dropped", { tags: ["keep", "x"] });

    const results = await store.queryNotes({ tags: ["keep"], excludeTags: ["#x"] });
    const ids = results.map((n) => n.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(dropped.id);
  });

  it("searchNotes treats #tag and bare tag identically", async () => {
    const note = await store.createNote("findable text here", { tags: ["agent/message"] });
    const hits = await store.searchNotes("findable", { tags: ["#agent/message"] });
    expect(hits.map((n) => n.id)).toContain(note.id);
  });

  it("query-notes via MCP: #-form matches bare-stored note", async () => {
    const note = await store.createNote("mcp query", { tags: ["agent/message/inbound"] });
    const tools = generateMcpTools(store);
    const query = tools.find((t) => t.name === "query-notes")!;
    // query-notes returns a plain array when no cursor is requested.
    const res = (await query.execute({ tag: "#agent/message/inbound" })) as { id: string }[];
    expect(res.map((n) => n.id)).toContain(note.id);
  });
});

describe("tag schema path — update-tag name + parent_names stored bare", () => {
  it("update-tag with name #foo + parent_names [#bar] → stored bare; inheritance works", async () => {
    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;

    // Establish `bar` as a parent, then `foo` as its child via #-decorated input.
    await updateTag.execute({ tag: "#bar", description: "parent" });
    await updateTag.execute({ tag: "#foo", parent_names: ["#bar"] });

    const fooRecord = await store.getTagRecord("foo");
    expect(fooRecord).not.toBeNull();
    expect(fooRecord!.parent_names).toEqual(["bar"]);
    // The #-decorated upsert must NOT have created a phantom `#foo` row.
    expect(await store.getTagRecord("#foo")).toBeNull();

    // Inheritance: tag:bar expands to foo (foo's parent is bar).
    const fooNote = await store.createNote("a foo note", { tags: ["foo"] });
    const expanded = await store.queryNotes({ tags: ["bar"] });
    expect(expanded.map((n) => n.id)).toContain(fooNote.id);
  });

  it("update-tag with #-name preserves the existing bare record's fields (merge correctness)", async () => {
    const tools = generateMcpTools(store);
    const updateTag = tools.find((t) => t.name === "update-tag")!;

    await updateTag.execute({ tag: "thing", description: "first" });
    // A #-decorated follow-up upsert must read the EXISTING bare record so the
    // partial merge doesn't clobber the prior description.
    await updateTag.execute({ tag: "#thing", parent_names: [] });

    const record = await store.getTagRecord("thing");
    expect(record!.description).toBe("first");
  });
});

describe("rename carve-out — source name stays literal (migration escape hatch)", () => {
  it("renameTag(#agent/message, agent/message) finds + renames the #-prefixed row", async () => {
    // Plant a legacy #-prefixed tag row + a note carrying it (simulating the
    // pre-fix agent data the migration must rename away).
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES ('#agent/message')").run();
    const note = await store.createNote("legacy inbound");
    db.prepare("INSERT INTO note_tags (note_id, tag_name) VALUES (?, '#agent/message')").run(note.id);

    const result = await store.renameTag("#agent/message", "agent/message");
    expect("renamed" in result).toBe(true);

    // The literal #-row is gone; the note now carries the bare tag.
    expect(storedTags(note.id)).toEqual(["agent/message"]);
    const tags = await store.listTags();
    expect(tags.map((t) => t.name)).not.toContain("#agent/message");
    expect(tags.map((t) => t.name)).toContain("agent/message");
  });

  it("renameTag normalizes the TARGET — renaming TO a #-name stores bare (can't re-introduce #)", async () => {
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES ('plainsrc')").run();
    const note = await store.createNote("x");
    db.prepare("INSERT INTO note_tags (note_id, tag_name) VALUES (?, 'plainsrc')").run(note.id);

    await store.renameTag("plainsrc", "#shiny");

    // The target #-prefix is stripped — no `#shiny` row, the note carries `shiny`.
    expect(storedTags(note.id)).toEqual(["shiny"]);
    expect((await store.listTags()).map((t) => t.name)).not.toContain("#shiny");
  });

  it("mergeTags normalizes the TARGET — merging INTO a #-name stores bare", async () => {
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES ('m1')").run();
    const note = await store.createNote("y");
    db.prepare("INSERT INTO note_tags (note_id, tag_name) VALUES (?, 'm1')").run(note.id);

    await store.mergeTags(["m1"], "#dest");

    expect(storedTags(note.id)).toEqual(["dest"]);
    expect((await store.listTags()).map((t) => t.name)).not.toContain("#dest");
  });
});

describe("regression — existing bare-tag behavior unchanged", () => {
  it("bare write + bare query still works end to end", async () => {
    const note = await store.createNote("plain", { tags: ["alpha", "beta"] });
    expect(storedTags(note.id).sort()).toEqual(["alpha", "beta"]);
    const results = await store.queryNotes({ tags: ["alpha"] });
    expect(results.map((n) => n.id)).toContain(note.id);
  });
});
