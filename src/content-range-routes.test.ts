/**
 * REST face of content range / pagination (bounded reads for large notes).
 *
 * Exercises all four GET shapes that accept `content_offset` /
 * `content_length`:
 *   - GET /notes?id=…           (single, folded into the collection route)
 *   - GET /notes/:idOrPath      (single point read)
 *   - GET /notes?…              (structured list)
 *   - GET /notes?search=…       (full-text list)
 *
 * Slice mechanics (codepoint boundaries, reassembly invariant) are pinned
 * in core/src/content-range.test.ts; this suite covers the HTTP wiring:
 * param parsing, 400s, per-shape application, and the no-params
 * regression. Fully sandboxed — in-memory SQLite, no daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleNotes } from "./routes.ts";

let db: Database;
let store: BunStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new BunStore(db);
});

afterEach(() => {
  db.close();
});

const BASE = "http://localhost/api";

function get(path: string): Promise<Response> {
  return handleNotes(new Request(`${BASE}/notes${path}`, { method: "GET" }), store, pathSub(path));
}

/** Extract the handleNotes subpath ("/<id>" for point reads, "" otherwise). */
function pathSub(path: string): string {
  const m = path.match(/^\/([^?/]+)/);
  return m ? `/${m[1]}` : "";
}

describe("REST content range — single note", () => {
  it("GET /notes?id=… honors content_length and adds the range fields", async () => {
    const note = await store.createNote("0123456789");
    const res = await get(`?id=${note.id}&content_length=4`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.content).toBe("0123");
    expect(body.content_offset).toBe(0);
    expect(body.content_total_length).toBe(10);
    expect(body.content_next_offset).toBe(4);
  });

  it("GET /notes/:id honors content_offset (tail read to the end)", async () => {
    const note = await store.createNote("hello world", { path: "tail-note" });
    const res = await get(`/${note.id}?content_offset=6`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.content).toBe("world");
    expect(body.content_total_length).toBe(11);
    expect(body.content_next_offset).toBeNull();
  });

  it("paged loop over REST reassembles multi-byte content byte-identically", async () => {
    const content = "ab\u{1F600}cd 你好 ".repeat(20).trim();
    const note = await store.createNote(content);
    let offset = 0;
    let assembled = "";
    for (;;) {
      const res = await get(`/${note.id}?content_offset=${offset}&content_length=16`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(Buffer.byteLength(body.content, "utf8")).toBeLessThanOrEqual(16);
      assembled += body.content;
      if (body.content_next_offset === null) break;
      offset = body.content_next_offset;
    }
    expect(assembled).toBe(content);
  });

  it("offset past end → 200 with empty slice and null next_offset", async () => {
    const note = await store.createNote("abc");
    const res = await get(`?id=${note.id}&content_offset=500`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.content).toBe("");
    expect(body.content_next_offset).toBeNull();
    expect(body.content_total_length).toBe(3);
  });

  it("include_content=false + range params → 400 INVALID_QUERY", async () => {
    const note = await store.createNote("abc");
    const res = await get(`?id=${note.id}&include_content=false&content_length=8`);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.code).toBe("INVALID_QUERY");
    expect(body.error).toContain("include_content");
  });

  it("zero / sub-minimum / malformed budgets → 400 INVALID_QUERY", async () => {
    const note = await store.createNote("abc");
    for (const qs of ["content_length=0", "content_length=2", "content_length=abc", "content_offset=-1"]) {
      const res = await get(`?id=${note.id}&${qs}`);
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.code).toBe("INVALID_QUERY");
    }
  });

  it("no range params → response shape unchanged (regression)", async () => {
    const note = await store.createNote("plain body", { path: "plain" });
    const res = await get(`/${note.id}`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.content).toBe("plain body");
    expect("content_total_length" in body).toBe(false);
    expect("content_next_offset" in body).toBe(false);
    expect("content_offset" in body).toBe(false);
  });
});

describe("REST content range — list shapes", () => {
  it("structured list with include_content=true applies the window per note", async () => {
    await store.createNote("first body first body", { tags: ["paged"] });
    await store.createNote("second body second body", { tags: ["paged"] });
    const res = await get(`?tag=paged&include_content=true&content_length=6`);
    expect(res.status).toBe(200);
    const body: any[] = await res.json();
    expect(body.length).toBe(2);
    for (const n of body) {
      expect(Buffer.byteLength(n.content, "utf8")).toBeLessThanOrEqual(6);
      expect(typeof n.content_total_length).toBe("number");
      expect(n.content_next_offset).toBe(6);
    }
  });

  it("structured list on the lean default + range params → 400", async () => {
    await store.createNote("body", { tags: ["paged"] });
    const res = await get(`?tag=paged&content_length=8`);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.code).toBe("INVALID_QUERY");
    expect(body.error).toContain("include_content");
  });

  it("search list with include_content=true applies the window per note", async () => {
    await store.createNote("the quick brown fox jumps over the lazy dog");
    const res = await get(`?search=fox&include_content=true&content_length=9`);
    expect(res.status).toBe(200);
    const body: any[] = await res.json();
    expect(body.length).toBe(1);
    expect(Buffer.byteLength(body[0].content, "utf8")).toBeLessThanOrEqual(9);
    expect(body[0].content_total_length).toBe(
      Buffer.byteLength("the quick brown fox jumps over the lazy dog", "utf8"),
    );
  });

  it("search list on the lean default + range params → 400", async () => {
    await store.createNote("the quick brown fox");
    const res = await get(`?search=fox&content_length=8`);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.code).toBe("INVALID_QUERY");
  });

  it("list without range params → no range fields injected (regression)", async () => {
    await store.createNote("body here", { tags: ["paged"] });
    const res = await get(`?tag=paged&include_content=true`);
    expect(res.status).toBe(200);
    const body: any[] = await res.json();
    expect("content_total_length" in body[0]).toBe(false);
    expect("content_next_offset" in body[0]).toBe(false);
  });
});
