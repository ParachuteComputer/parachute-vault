/**
 * REST face of aggregation / rollup queries (top new-feature ask from a UX
 * round) — `GET /notes?aggregate[group_by]=…&aggregate[op]=…&aggregate[field]=…`.
 *
 * Core-level SQL correctness (count/sum semantics, group_by "tag", NULL
 * groups, the FIELD_NOT_INDEXED / INVALID_QUERY error contract) is pinned
 * in `core/src/aggregate.test.ts`; this suite covers the HTTP wiring: param
 * parsing, 400s, the response shape, and — the part that can't be tested at
 * the core layer since core stays scope-unaware — that a tag-scoped caller's
 * rollup is computed only over notes it can see (no out-of-scope leakage,
 * and no undercounting of in-scope notes). Fully sandboxed — in-memory
 * SQLite, no daemon.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleNotes, type TagScopeCtx } from "./routes.ts";

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
const NO_SCOPE: TagScopeCtx = { allowed: null, raw: null };

function get(path: string, tagScope: TagScopeCtx = NO_SCOPE): Promise<Response> {
  return handleNotes(new Request(`${BASE}/notes${path}`, { method: "GET" }), store, "", undefined, tagScope);
}

describe("REST GET /notes — aggregate: count by an indexed enum field", () => {
  it("returns [{group, value}] rows", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    await store.createNote("a", { tags: ["task"], metadata: { status: "open" } });
    await store.createNote("b", { tags: ["task"], metadata: { status: "open" } });
    await store.createNote("c", { tags: ["task"], metadata: { status: "done" } });

    const res = await get("?aggregate[group_by]=status&aggregate[op]=count");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const byGroup = Object.fromEntries(body.map((r: any) => [r.group, r.value]));
    expect(byGroup).toEqual({ open: 2, done: 1 });
  });
});

describe("REST GET /notes — aggregate: sum a numeric field", () => {
  it("sums per group", async () => {
    await store.upsertTagRecord("expense", {
      fields: {
        category: { type: "string", indexed: true },
        amount: { type: "integer", indexed: true },
      },
    });
    await store.createNote("a", { tags: ["expense"], metadata: { category: "food", amount: 10 } });
    await store.createNote("b", { tags: ["expense"], metadata: { category: "food", amount: 25 } });
    await store.createNote("c", { tags: ["expense"], metadata: { category: "travel", amount: 100 } });

    const res = await get("?aggregate[group_by]=category&aggregate[op]=sum&aggregate[field]=amount");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const byGroup = Object.fromEntries(body.map((r: any) => [r.group, r.value]));
    expect(byGroup).toEqual({ food: 35, travel: 100 });
  });
});

describe("REST GET /notes — aggregate respects a prefilter", () => {
  it("a tag= prefilter narrows the input set before aggregating", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    await store.createNote("a", { tags: ["task", "work"], metadata: { status: "open" } });
    await store.createNote("b", { tags: ["task", "personal"], metadata: { status: "open" } });
    await store.createNote("c", { tags: ["task", "work"], metadata: { status: "done" } });

    const res = await get("?tag=work&aggregate[group_by]=status&aggregate[op]=count");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const byGroup = Object.fromEntries(body.map((r: any) => [r.group, r.value]));
    expect(byGroup).toEqual({ open: 1, done: 1 });
  });

  it("a meta[field][op] prefilter narrows the input set before aggregating", async () => {
    await store.upsertTagRecord("task", {
      fields: {
        status: { type: "string", indexed: true },
        priority: { type: "string", indexed: true },
      },
    });
    await store.createNote("a", { tags: ["task"], metadata: { status: "open", priority: "high" } });
    await store.createNote("b", { tags: ["task"], metadata: { status: "open", priority: "low" } });
    await store.createNote("c", { tags: ["task"], metadata: { status: "done", priority: "high" } });

    const res = await get("?meta[priority][eq]=high&aggregate[group_by]=status&aggregate[op]=count");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const byGroup = Object.fromEntries(body.map((r: any) => [r.group, r.value]));
    expect(byGroup).toEqual({ open: 1, done: 1 });
  });
});

describe("REST GET /notes — aggregate errors", () => {
  it("400s on a non-indexed group_by (FIELD_NOT_INDEXED)", async () => {
    await store.createNote("a", { metadata: { status: "open" } });
    const res = await get("?aggregate[group_by]=status&aggregate[op]=count");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.code).toBe("FIELD_NOT_INDEXED");
  });

  it("400s when op is \"sum\" without a field", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    const res = await get("?aggregate[group_by]=status&aggregate[op]=sum");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.field).toBe("aggregate.field");
  });

  it("400s on an unrecognized op", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    const res = await get("?aggregate[group_by]=status&aggregate[op]=average");
    expect(res.status).toBe(400);
  });

  it("400s when group_by is present but op is missing", async () => {
    const res = await get("?aggregate[group_by]=status");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.field).toBe("aggregate");
  });

  it("400s when aggregate is combined with cursor", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    const res = await get("?aggregate[group_by]=status&aggregate[op]=count&cursor=");
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.field).toBe("aggregate");
  });

  it("400s when aggregate is combined with near", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    const anchor = await store.createNote("anchor", { tags: ["task"], metadata: { status: "open" } });
    const res = await get(`?aggregate[group_by]=status&aggregate[op]=count&near[note_id]=${anchor.id}`);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.field).toBe("aggregate");
  });
});

describe("REST GET /notes — aggregate: group_by \"tag\"", () => {
  it("counts by tag membership", async () => {
    await store.createNote("a", { tags: ["work", "urgent"] });
    await store.createNote("b", { tags: ["work"] });
    await store.createNote("c", { tags: ["personal"] });

    const res = await get("?aggregate[group_by]=tag&aggregate[op]=count");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const byGroup = Object.fromEntries(body.map((r: any) => [r.group, r.value]));
    expect(byGroup).toEqual({ work: 2, urgent: 1, personal: 1 });
  });
});

describe("REST GET /notes — aggregate: tag-scope respected (no out-of-scope leakage)", () => {
  it("counts by an indexed field ONLY over notes the token can see", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    // Two in-scope (#work) notes, two out-of-scope (#personal) notes — all
    // sharing the SAME status values, so a leak would silently inflate the
    // in-scope counts rather than surfacing as an obviously-wrong shape.
    await store.createNote("a", { tags: ["task", "work"], metadata: { status: "open" } });
    await store.createNote("b", { tags: ["task", "work"], metadata: { status: "done" } });
    await store.createNote("c", { tags: ["task", "personal"], metadata: { status: "open" } });
    await store.createNote("d", { tags: ["task", "personal"], metadata: { status: "open" } });

    const scoped: TagScopeCtx = { allowed: new Set(["work"]), raw: ["work"] };
    const res = await get("?aggregate[group_by]=status&aggregate[op]=count", scoped);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const byGroup = Object.fromEntries(body.map((r: any) => [r.group, r.value]));
    // Only the two #work notes — the #personal "open" pair must not leak
    // into (or inflate) the "open" group.
    expect(byGroup).toEqual({ open: 1, done: 1 });
  });

  it("group_by \"tag\" never surfaces an out-of-scope tag name — including an out-of-scope CO-TAG on an otherwise-visible note", async () => {
    // Note "a" is visible (carries "work"), but ALSO carries "urgent" —
    // an out-of-scope co-tag. Narrowing which NOTES count isn't enough:
    // "urgent" must not surface as a group just because its note is
    // visible via a different tag.
    await store.createNote("a", { tags: ["work", "urgent"] });
    await store.createNote("b", { tags: ["personal", "secret-project"] });

    const scoped: TagScopeCtx = { allowed: new Set(["work"]), raw: ["work"] };
    const res = await get("?aggregate[group_by]=tag&aggregate[op]=count", scoped);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const groups = body.map((r: any) => r.group);
    expect(groups).toEqual(["work"]);
    expect(groups).not.toContain("urgent");
    expect(groups).not.toContain("personal");
    expect(groups).not.toContain("secret-project");
  });

  it("an out-of-scope token aggregating over a filter that matches NO visible notes returns an empty rollup, not an error", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    await store.createNote("a", { tags: ["task", "personal"], metadata: { status: "open" } });

    const scoped: TagScopeCtx = { allowed: new Set(["work"]), raw: ["work"] };
    const res = await get("?aggregate[group_by]=status&aggregate[op]=count", scoped);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual([]);
  });

  it("an unscoped token sees the full rollup (regression check against the scoped path above)", async () => {
    await store.upsertTagRecord("task", { fields: { status: { type: "string", indexed: true } } });
    await store.createNote("a", { tags: ["task", "work"], metadata: { status: "open" } });
    await store.createNote("b", { tags: ["task", "personal"], metadata: { status: "open" } });

    const res = await get("?aggregate[group_by]=status&aggregate[op]=count");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const byGroup = Object.fromEntries(body.map((r: any) => [r.group, r.value]));
    expect(byGroup).toEqual({ open: 2 });
  });
});
