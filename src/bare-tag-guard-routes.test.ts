/**
 * Canonical-bare-tag guard (vault#XXX) — REST layer. Confirms the PUT
 * /tags/:name route normalizes the upserted tag NAME (so the partial-merge read
 * + write land on the bare row) and leaves the rename SOURCE-name lookup literal
 * (the migration escape hatch — a #-prefixed legacy tag must still be
 * rename-able away). The query + note-tag write paths normalize in the store and
 * are covered by core/src/bare-tag-guard.test.ts.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { initSchema } from "../core/src/schema.ts";
import { handleTags } from "./routes.ts";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  store = new SqliteStore(db);
});

function put(name: string, body: unknown): Promise<Response> {
  const req = new Request(`http://localhost/api/tags/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return handleTags(req, store, `/${encodeURIComponent(name)}`);
}

describe("PUT /tags/:name — bare-tag guard", () => {
  it("PUT /tags/%23foo with parent_names [#bar] stores the bare row + bare parents", async () => {
    const res = await put("#foo", { parent_names: ["#bar"], description: "child" });
    expect(res.status).toBe(200);

    const record = await store.getTagRecord("foo");
    expect(record).not.toBeNull();
    expect(record!.parent_names).toEqual(["bar"]);
    expect(await store.getTagRecord("#foo")).toBeNull();
  });

  it("a #-decorated PUT preserves the existing bare record's fields (merge correctness)", async () => {
    await put("thing", { description: "first" });
    await put("#thing", { parent_names: [] });
    const record = await store.getTagRecord("thing");
    expect(record!.description).toBe("first");
  });
});

describe("POST /tags/:name/rename — source name stays literal", () => {
  it("rename #agent/message → agent/message finds the literal #-prefixed row", async () => {
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES ('#agent/message')").run();
    const note = await store.createNote("legacy inbound");
    db.prepare("INSERT INTO note_tags (note_id, tag_name) VALUES (?, '#agent/message')").run(note.id);

    const sub = "/" + encodeURIComponent("#agent/message") + "/rename";
    const req = new Request(`http://localhost/api/tags${sub}`, {
      method: "POST",
      body: JSON.stringify({ new_name: "agent/message" }),
    });
    const res = await handleTags(req, store, sub);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { renamed?: number };
    expect(body.renamed).toBeGreaterThan(0);

    const tags = await store.listTags();
    expect(tags.map((t) => t.name)).not.toContain("#agent/message");
    expect(tags.map((t) => t.name)).toContain("agent/message");
  });
});
