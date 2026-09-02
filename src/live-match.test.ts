/**
 * Predicate-parity tests for the live matcher (live-query SSE).
 *
 * The load-bearing invariant: for any supported query, the set of notes the
 * snapshot SQL (`store.queryNotes`) returns MUST equal the set the in-process
 * `buildLiveMatcher` accepts over the same corpus. Each `it` seeds a corpus,
 * runs both evaluators for a query shape, and asserts the id-sets are equal.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { generateMcpTools } from "../core/src/mcp.ts";
import type { QueryOpts } from "../core/src/types.ts";
import { buildLiveMatcher } from "./live-match.ts";

/**
 * Declare metadata fields as `indexed: true` via the update-tag MCP tool —
 * the only path that populates the `indexed_fields` table + reconciles the
 * generated `meta_<field>` columns the snapshot operator queries need.
 * `store.upsertTagSchema` alone records the schema but NOT the index.
 */
async function declareIndexed(tag: string, fields: Record<string, { type: string; indexed: boolean }>) {
  const tools = generateMcpTools(store);
  const updateTag = tools.find((t) => t.name === "update-tag")!;
  await updateTag.execute({ tag, fields });
}

let db: Database;
let store: SqliteStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

afterEach(() => {
  db.close();
});

/** Build the parity assertion: snapshot id-set === live-matcher id-set. */
async function assertParity(opts: QueryOpts): Promise<Set<string>> {
  const snapshot = await store.queryNotes(opts);
  const snapshotIds = new Set(snapshot.map((n) => n.id));

  const all = await store.queryNotes({ limit: 100000 });
  const matcher = await buildLiveMatcher(store, opts);
  const liveIds = new Set(all.filter((n) => matcher.match(n)).map((n) => n.id));

  expect([...liveIds].sort()).toEqual([...snapshotIds].sort());
  return snapshotIds;
}

describe("live-match — predicate parity with the query engine", () => {
  it("tags (single, no hierarchy)", async () => {
    await store.createNote("a", { tags: ["chat"] });
    await store.createNote("b", { tags: ["chat", "x"] });
    await store.createNote("c", { tags: ["other"] });
    await store.createNote("d", {});
    const ids = await assertParity({ tags: ["chat"] });
    expect(ids.size).toBe(2);
  });

  it("tags 'all' (AND) across multiple tags", async () => {
    await store.createNote("a", { tags: ["chat", "x"] });
    await store.createNote("b", { tags: ["chat"] });
    await store.createNote("c", { tags: ["x"] });
    const ids = await assertParity({ tags: ["chat", "x"], tagMatch: "all" });
    expect(ids.size).toBe(1);
  });

  it("tags 'any' (OR) across multiple tags", async () => {
    await store.createNote("a", { tags: ["chat"] });
    await store.createNote("b", { tags: ["x"] });
    await store.createNote("c", { tags: ["other"] });
    const ids = await assertParity({ tags: ["chat", "x"], tagMatch: "any" });
    expect(ids.size).toBe(2);
  });

  it("tags with descendant/hierarchy expansion", async () => {
    // Declare voice as a child of manual via parent_names.
    await store.upsertTagRecord("manual", { description: "manual root" });
    await store.upsertTagRecord("voice", { parent_names: ["manual"] });
    await store.createNote("root", { tags: ["manual"] });
    await store.createNote("child", { tags: ["voice"] });
    await store.createNote("unrelated", { tags: ["other"] });
    // Query for #manual should match notes tagged #voice (a descendant).
    const ids = await assertParity({ tags: ["manual"] });
    expect(ids.has("nonexistent")).toBe(false);
    // Both root + child match.
    const notes = await store.queryNotes({ tags: ["manual"] });
    expect(notes.length).toBe(2);
  });

  it("excludeTags (raw, no expansion — mirrors engine)", async () => {
    await store.createNote("a", { tags: ["chat"] });
    await store.createNote("b", { tags: ["chat", "muted"] });
    await assertParity({ tags: ["chat"], excludeTags: ["muted"] });
  });

  it("path (case-insensitive exact)", async () => {
    await store.createNote("a", { path: "Channels/general" });
    await store.createNote("b", { path: "Channels/random" });
    await assertParity({ path: "channels/general" });
  });

  it("pathPrefix", async () => {
    await store.createNote("a", { path: "Channels/general" });
    await store.createNote("b", { path: "Channels/random" });
    await store.createNote("c", { path: "Other/thing" });
    const ids = await assertParity({ pathPrefix: "Channels/" });
    expect(ids.size).toBe(2);
  });

  it("pathPrefix (mixed-case — parity with the engine's CI LIKE) (N1)", async () => {
    await store.createNote("a", { path: "Channels/general" });
    await store.createNote("b", { path: "Channels/random" });
    await store.createNote("c", { path: "Other/thing" });
    // Lower-case prefix must still match the title-case paths, same as the
    // engine's `LIKE 'channels/%'` (ASCII case-insensitive).
    const ids = await assertParity({ pathPrefix: "channels/" });
    expect(ids.size).toBe(2);
  });

  it("excludePathPrefix (vault#628)", async () => {
    await store.createNote("user", { path: "Projects/a" });
    await store.createNote("sys", { path: ".parachute/notes/settings" });
    await store.createNote("bare");
    const ids = await assertParity({ excludePathPrefix: [".parachute/"] });
    expect(ids.size).toBe(2);
  });

  it("pathPrefix with a LIKE metachar matches literally (vault#659)", async () => {
    // `_` is LIKE's single-char wildcard. Unescaped, `LIKE '_tags/%'` also
    // matched `atags/x` in SQL while the matcher's `startsWith` did not —
    // a snapshot/live divergence that also just returned the wrong answer.
    const under = await store.createNote("under", { path: "_tags/x" });
    await store.createNote("decoy", { path: "atags/x" });
    const ids = await assertParity({ pathPrefix: "_tags/" });
    expect([...ids]).toEqual([under.id]);
  });

  it("excludePathPrefix with a LIKE metachar excludes literally (vault#659)", async () => {
    await store.createNote("under", { path: "_tags/x" });
    const decoy = await store.createNote("decoy", { path: "atags/x" });
    const ids = await assertParity({ excludePathPrefix: ["_tags/"] });
    expect([...ids]).toEqual([decoy.id]);
  });

  it("hasTags true/false (M1 — presence parity)", async () => {
    await store.createNote("tagged", { tags: ["x"] });
    await store.createNote("bare", {});
    const has = await assertParity({ hasTags: true });
    expect(has.size).toBe(1);
    const none = await assertParity({ hasTags: false });
    expect(none.size).toBe(1);
  });

  it("hasTags is ignored when a tag filter is also present (engine parity)", async () => {
    // queryNotes drops hasTags when `tags` is set (the tag filter already
    // constrains to tagged notes); the matcher must mirror that exactly.
    await store.createNote("a", { tags: ["chat"] });
    await store.createNote("b", { tags: ["other"] });
    await assertParity({ tags: ["chat"], hasTags: false });
  });

  it("extension (default md + explicit)", async () => {
    await store.createNote("md1", { path: "n1" });
    await store.createNote("csv1", { path: "n2", extension: "csv" });
    await assertParity({ extension: "csv" });
    await assertParity({ extension: "md" });
    await assertParity({ extension: ["csv", "yaml"] });
  });

  describe("metadata operators (indexed field)", () => {
    beforeEach(async () => {
      // Declare `channel` + `count` indexed so the snapshot operator path works.
      await declareIndexed("msg", {
        channel: { type: "string", indexed: true },
        count: { type: "integer", indexed: true },
      });
      await store.createNote("g1", { tags: ["msg"], metadata: { channel: "general", count: 5 } });
      await store.createNote("g2", { tags: ["msg"], metadata: { channel: "general", count: 10 } });
      await store.createNote("r1", { tags: ["msg"], metadata: { channel: "random", count: 1 } });
      await store.createNote("n1", { tags: ["msg"] }); // no channel/count
    });

    it("eq", async () => {
      const ids = await assertParity({ tags: ["msg"], metadata: { channel: { eq: "general" } } });
      expect(ids.size).toBe(2);
    });
    it("ne (absent field passes)", async () => {
      await assertParity({ tags: ["msg"], metadata: { channel: { ne: "general" } } });
    });
    it("gt / gte / lt / lte", async () => {
      await assertParity({ tags: ["msg"], metadata: { count: { gt: 5 } } });
      await assertParity({ tags: ["msg"], metadata: { count: { gte: 5 } } });
      await assertParity({ tags: ["msg"], metadata: { count: { lt: 5 } } });
      await assertParity({ tags: ["msg"], metadata: { count: { lte: 5 } } });
    });
    it("in / not_in", async () => {
      await assertParity({ tags: ["msg"], metadata: { channel: { in: ["general", "random"] } } });
      await assertParity({ tags: ["msg"], metadata: { channel: { not_in: ["random"] } } });
    });
    it("exists true/false", async () => {
      await assertParity({ tags: ["msg"], metadata: { channel: { exists: true } } });
      await assertParity({ tags: ["msg"], metadata: { channel: { exists: false } } });
    });
    it("combined: tag + metadata operator (the channel case)", async () => {
      const ids = await assertParity({
        tags: ["msg"],
        metadata: { channel: { eq: "general" }, count: { gte: 10 } },
      });
      expect(ids.size).toBe(1);
    });
  });

  it("metadata primitive exact-match (shorthand)", async () => {
    await store.createNote("a", { tags: ["t"], metadata: { kind: "note" } });
    await store.createNote("b", { tags: ["t"], metadata: { kind: "task" } });
    await assertParity({ tags: ["t"], metadata: { kind: "note" } });
  });
});

describe("live-match — unsupportedSubscriptionReason cursor guard (vault#550)", () => {
  it("rejects a bootstrap empty-string cursor (presence, not truthiness)", async () => {
    const { unsupportedSubscriptionReason } = await import("./live-match.ts");
    // `cursor: ""` is cursor INTENT (the vault#550 bootstrap call) — a live
    // subscription can't paginate, so it must be rejected the same as a
    // real cursor, not silently treated as "no cursor requested."
    expect(unsupportedSubscriptionReason({ cursor: "" } as QueryOpts)).toContain("cursor");
    expect(unsupportedSubscriptionReason({ cursor: "eyJxaC" } as QueryOpts)).toContain("cursor");
  });

  it("an omitted/undefined cursor does not reject", async () => {
    const { unsupportedSubscriptionReason } = await import("./live-match.ts");
    expect(unsupportedSubscriptionReason({ cursor: undefined } as QueryOpts)).toBeNull();
    expect(unsupportedSubscriptionReason({} as QueryOpts)).toBeNull();
  });
});
