/**
 * Live-query SSE subscription tests (design 2026-06-08).
 *
 * Exercises the route handler end-to-end over a real `text/event-stream`
 * Response: snapshot correctness, live insert/update/delete events,
 * set-transition (matching→non-matching → remove; non-matching→matching →
 * upsert), the load-bearing SCOPE-INTERSECTION guarantee (a tag-scoped token
 * never receives out-of-scope notes in the snapshot OR live), `search`/`near`
 * → 400, and over-cap → 503.
 *
 * Hook dispatch is deferred (microtask + queued handler), so each mutation is
 * followed by `settle()` before asserting the stream contents.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import { handleSubscribe } from "./subscribe.ts";
import { SubscriptionManager } from "./subscriptions.ts";
import { expandTokenTagScope } from "./tag-scope.ts";
import type { TagScopeCtx } from "./routes.ts";

const VAULT = "testvault";

let db: Database;
let hooks: HookRegistry;
let store: SqliteStore;
let manager: SubscriptionManager;

beforeEach(() => {
  db = new Database(":memory:");
  hooks = new HookRegistry({ concurrency: 4, logger: { error() {} } });
  store = new SqliteStore(db, { hooks });
  // Manager registers its broad hooks on THIS store's registry, and resolves
  // every event to VAULT (the test store isn't in the global vault WeakMap).
  manager = new SubscriptionManager(hooks, { resolveVault: () => VAULT });
});

afterEach(() => {
  manager.shutdown();
  db.close();
});

/** Let deferred hook dispatch + handlers run. */
async function settle(): Promise<void> {
  // queueMicrotask → handler runs under the semaphore (async). A couple of
  // macrotask ticks is plenty for the in-memory path.
  await new Promise((r) => setTimeout(r, 10));
}

/** An SSE frame parsed off the wire. */
interface Frame {
  event: string;
  data: any;
}

/**
 * Open an SSE reader over a subscribe Response. `frames()` returns everything
 * parsed so far; `close()` cancels the stream (→ subscription teardown).
 */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: Frame[] = [];
  let done = false;

  function drainBuffer() {
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (raw.startsWith(":")) continue; // keepalive comment
      const lines = raw.split("\n");
      let event = "message";
      let dataStr = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      frames.push({ event, data: dataStr ? JSON.parse(dataStr) : null });
    }
  }

  // ONE continuous background read loop — a single outstanding `reader.read()`
  // at a time (concurrent reads on one reader throw / steal chunks). It drains
  // frames into `frames` as bytes arrive; `pump()` just waits a beat.
  (async () => {
    try {
      while (true) {
        const { value, done: d } = await reader.read();
        if (d) {
          done = true;
          break;
        }
        if (value) {
          buf += decoder.decode(value, { stream: true });
          drainBuffer();
        }
      }
    } catch {
      done = true;
    }
  })();

  return {
    /** Wait a beat for in-flight frames to land. */
    async pump() {
      await new Promise((r) => setTimeout(r, 30));
      return frames;
    },
    frames: () => frames,
    isDone: () => done,
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

function unscopedScope(): TagScopeCtx {
  return { allowed: null, raw: null };
}

async function scopedTo(roots: string[]): Promise<TagScopeCtx> {
  return { allowed: await expandTokenTagScope(store, roots), raw: roots };
}

function subscribeReq(query: string): Request {
  return new Request(`http://localhost/vault/${VAULT}/api/subscribe?${query}`);
}

describe("handleSubscribe — snapshot", () => {
  it("sends a snapshot of currently-matching notes", async () => {
    await store.createNote("hello", { tags: ["chat"], metadata: {} });
    await store.createNote("nope", { tags: ["other"] });

    const res = await handleSubscribe(subscribeReq("tag=chat"), store, VAULT, unscopedScope(), manager);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const r = sseReader(res);
    await r.pump();
    const snap = r.frames().find((f) => f.event === "snapshot");
    expect(snap).toBeTruthy();
    expect(snap!.data.notes.length).toBe(1);
    expect(snap!.data.notes[0].content).toBe("hello");
    await r.close();
  });
});

describe("handleSubscribe — live events", () => {
  it("emits upsert on a matching insert after connect", async () => {
    const res = await handleSubscribe(subscribeReq("tag=chat"), store, VAULT, unscopedScope(), manager);
    const r = sseReader(res);
    await r.pump();
    expect(r.frames().filter((f) => f.event === "snapshot").length).toBe(1);

    await store.createNote("live one", { tags: ["chat"] });
    await settle();
    await r.pump();

    const upserts = r.frames().filter((f) => f.event === "upsert");
    expect(upserts.length).toBe(1);
    expect(upserts[0]!.data.note.content).toBe("live one");
    await r.close();
  });

  it("does NOT emit on a non-matching insert", async () => {
    const res = await handleSubscribe(subscribeReq("tag=chat"), store, VAULT, unscopedScope(), manager);
    const r = sseReader(res);
    await r.pump();

    await store.createNote("irrelevant", { tags: ["other"] });
    await settle();
    await r.pump();

    expect(r.frames().filter((f) => f.event === "upsert").length).toBe(0);
    await r.close();
  });

  it("emits remove on hard delete", async () => {
    const note = await store.createNote("doomed", { tags: ["chat"] });
    const res = await handleSubscribe(subscribeReq("tag=chat"), store, VAULT, unscopedScope(), manager);
    const r = sseReader(res);
    await r.pump();

    await store.deleteNote(note.id);
    await settle();
    await r.pump();

    const removes = r.frames().filter((f) => f.event === "remove");
    expect(removes.length).toBe(1);
    expect(removes[0]!.data.id).toBe(note.id);
    await r.close();
  });
});

describe("handleSubscribe — set transitions", () => {
  it("matching → non-matching update emits remove", async () => {
    // channel field indexed so the snapshot operator query works.
    const { generateMcpTools } = await import("../core/src/mcp.ts");
    const updateTag = generateMcpTools(store).find((t) => t.name === "update-tag")!;
    await updateTag.execute({ tag: "msg", fields: { channel: { type: "string", indexed: true } } });

    const note = await store.createNote("m", { tags: ["msg"], metadata: { channel: "general" } });
    const res = await handleSubscribe(
      subscribeReq("tag=msg&meta[channel][eq]=general"),
      store,
      VAULT,
      unscopedScope(),
      manager,
    );
    const r = sseReader(res);
    await r.pump();
    expect(r.frames().find((f) => f.event === "snapshot")!.data.notes.length).toBe(1);

    // Move the note out of the set (channel → random).
    await store.updateNote(note.id, { metadata: { channel: "random" } });
    await settle();
    await r.pump();

    const removes = r.frames().filter((f) => f.event === "remove");
    expect(removes.length).toBe(1);
    expect(removes[0]!.data.id).toBe(note.id);
    await r.close();
  });

  it("non-matching → matching update emits upsert", async () => {
    const note = await store.createNote("m", { tags: ["other"] });
    const res = await handleSubscribe(subscribeReq("tag=chat"), store, VAULT, unscopedScope(), manager);
    const r = sseReader(res);
    await r.pump();
    expect(r.frames().find((f) => f.event === "snapshot")!.data.notes.length).toBe(0);

    // Re-tag into the set. updateNote doesn't take tags directly; use tagNote
    // then a metadata touch to fire an "updated" event carrying fresh tags.
    await store.tagNote(note.id, ["chat"]);
    await store.updateNote(note.id, { metadata: { touched: true } });
    await settle();
    await r.pump();

    const upserts = r.frames().filter((f) => f.event === "upsert");
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    expect(upserts.at(-1)!.data.note.tags).toContain("chat");
    await r.close();
  });
});

describe("handleSubscribe — SCOPE INTERSECTION (security)", () => {
  it("snapshot withholds a note that MATCHES the predicate but is OUT OF SCOPE (predicate∧scope) (N3)", async () => {
    // Both notes carry #work and so MATCH the `tag=work` predicate. Scope must
    // still withhold the one outside the token's allowlist. The token is scoped
    // to #work/eng, so #work/sales is in-predicate-but-out-of-scope.
    await store.upsertTagRecord("work", { description: "work root" });
    await store.upsertTagRecord("work/eng", { parent_names: ["work"] });
    await store.upsertTagRecord("work/sales", { parent_names: ["work"] });
    await store.createNote("eng note", { tags: ["work/eng"] });
    await store.createNote("sales note", { tags: ["work/sales"] });

    const scope = await scopedTo(["work/eng"]);
    // Predicate `tag=work` matches BOTH (sales is a #work descendant) — only
    // scope distinguishes them, exercising the AND-gate, not the predicate.
    const res = await handleSubscribe(subscribeReq("tag=work"), store, VAULT, scope, manager);
    const r = sseReader(res);
    await r.pump();
    const snap = r.frames().find((f) => f.event === "snapshot")!;
    const contents = snap.data.notes.map((n: any) => n.content);
    expect(contents).toContain("eng note");
    expect(contents).not.toContain("sales note");
    await r.close();
  });

  it("a live INSERT matching the predicate but OUT OF SCOPE never reaches a scoped stream (N3)", async () => {
    await store.upsertTagRecord("work", { description: "work root" });
    await store.upsertTagRecord("work/eng", { parent_names: ["work"] });
    await store.upsertTagRecord("work/sales", { parent_names: ["work"] });
    const scope = await scopedTo(["work/eng"]);
    const res = await handleSubscribe(subscribeReq("tag=work"), store, VAULT, scope, manager);
    const r = sseReader(res);
    await r.pump();

    // Out-of-scope but predicate-matching (#work/sales is a #work descendant).
    await store.createNote("sales leak", { tags: ["work/sales"] });
    await settle();
    await r.pump();
    expect(r.frames().filter((f) => f.event === "upsert").length).toBe(0);

    // Sanity: an in-scope, predicate-matching insert DOES arrive.
    await store.createNote("eng allowed", { tags: ["work/eng"] });
    await settle();
    await r.pump();
    const upserts = r.frames().filter((f) => f.event === "upsert");
    expect(upserts.length).toBe(1);
    expect(upserts[0]!.data.note.content).toBe("eng allowed");
    await r.close();
  });

  it("a live UPDATE of an out-of-scope predicate-matching note still never leaks (upsert OR remove) (M2)", async () => {
    await store.upsertTagRecord("work", { description: "work root" });
    await store.upsertTagRecord("work/sales", { parent_names: ["work"] });
    const scope = await scopedTo(["work/eng"]);
    // #work/sales matches `tag=work` but is OUT of the #work/eng scope.
    const note = await store.createNote("sales secret", { tags: ["work/sales"] });
    const res = await handleSubscribe(subscribeReq("tag=work"), store, VAULT, scope, manager);
    const r = sseReader(res);
    await r.pump();

    await store.updateNote(note.id, { metadata: { touched: true } });
    await settle();
    await r.pump();
    // No upsert (scope vetoes) AND no remove (would leak the uuid — M2).
    expect(r.frames().filter((f) => f.event === "upsert").length).toBe(0);
    expect(r.frames().filter((f) => f.event === "remove").length).toBe(0);
    await r.close();
  });

  it("M2 — scoped sub gets NO remove when an OUT-OF-SCOPE note leaves the set", async () => {
    // channel indexed so the snapshot operator query works.
    const { generateMcpTools } = await import("../core/src/mcp.ts");
    const updateTag = generateMcpTools(store).find((t) => t.name === "update-tag")!;
    await updateTag.execute({ tag: "msg", fields: { channel: { type: "string", indexed: true } } });
    await store.upsertTagRecord("work", { description: "work root" });
    await store.upsertTagRecord("work/sales", { parent_names: ["work"] });

    const scope = await scopedTo(["work/eng"]);
    // A #work/sales note (out of scope) that currently matches the predicate
    // tag=work ∧ channel=general.
    const note = await store.createNote("sales", {
      tags: ["msg", "work/sales"],
      metadata: { channel: "general" },
    });
    const res = await handleSubscribe(
      subscribeReq("tag=work&meta[channel][eq]=general"),
      store,
      VAULT,
      scope,
      manager,
    );
    const r = sseReader(res);
    await r.pump();
    // Out of scope → not in the snapshot either.
    expect(r.frames().find((f) => f.event === "snapshot")!.data.notes.length).toBe(0);

    // Move it out of the predicate set (channel → random). It was never in the
    // scoped sub's set; emitting a remove would leak its uuid → must stay silent.
    await store.updateNote(note.id, { metadata: { channel: "random" } });
    await settle();
    await r.pump();
    expect(r.frames().filter((f) => f.event === "remove").length).toBe(0);
    await r.close();
  });

  it("M2 — scoped sub DOES get a remove when an IN-SCOPE note it could see leaves the set", async () => {
    const { generateMcpTools } = await import("../core/src/mcp.ts");
    const updateTag = generateMcpTools(store).find((t) => t.name === "update-tag")!;
    await updateTag.execute({ tag: "msg", fields: { channel: { type: "string", indexed: true } } });
    await store.upsertTagRecord("work", { description: "work root" });
    await store.upsertTagRecord("work/eng", { parent_names: ["work"] });

    const scope = await scopedTo(["work/eng"]);
    // In-scope note matching the predicate.
    const note = await store.createNote("eng", {
      tags: ["msg", "work/eng"],
      metadata: { channel: "general" },
    });
    const res = await handleSubscribe(
      subscribeReq("tag=work&meta[channel][eq]=general"),
      store,
      VAULT,
      scope,
      manager,
    );
    const r = sseReader(res);
    await r.pump();
    expect(r.frames().find((f) => f.event === "snapshot")!.data.notes.length).toBe(1);

    // Leave the set (channel → random) while staying IN scope → a remove the
    // sub legitimately needs (it held this id).
    await store.updateNote(note.id, { metadata: { channel: "random" } });
    await settle();
    await r.pump();
    const removes = r.frames().filter((f) => f.event === "remove");
    expect(removes.length).toBe(1);
    expect(removes[0]!.data.id).toBe(note.id);
    await r.close();
  });
});

describe("handleSubscribe — rejected query shapes", () => {
  it("search → 400", async () => {
    const res = await handleSubscribe(subscribeReq("search=hello"), store, VAULT, unscopedScope(), manager);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
  });

  it("near → 400", async () => {
    const res = await handleSubscribe(
      subscribeReq("near%5Bnote_id%5D=abc"),
      store,
      VAULT,
      unscopedScope(),
      manager,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
  });

  it("has_links → 400 (M1 — needs the links table)", async () => {
    const res = await handleSubscribe(subscribeReq("has_links=true"), store, VAULT, unscopedScope(), manager);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
    expect(body.error).toContain("has_links");
  });

  it("date filter → 400 (M1) — legacy date_from", async () => {
    const res = await handleSubscribe(
      subscribeReq("date_from=2026-01-01"),
      store,
      VAULT,
      unscopedScope(),
      manager,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
    expect(body.error).toContain("date");
  });

  it("date filter → 400 (M1) — bracket date_filter on updated_at", async () => {
    const res = await handleSubscribe(
      subscribeReq("meta%5Bupdated_at%5D%5Bgte%5D=2026-01-01"),
      store,
      VAULT,
      unscopedScope(),
      manager,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
    expect(body.error).toContain("date");
  });
});

describe("handleSubscribe — snapshot completeness (M3)", () => {
  it("a subscription matching >50 notes gets ALL of them in the snapshot", async () => {
    // The default query limit is 50; seed 60 matching notes and assert the
    // snapshot carries the full set (paging stripped for the snapshot query).
    for (let i = 0; i < 60; i++) {
      await store.createNote(`n${i}`, { tags: ["chat"] });
    }
    const res = await handleSubscribe(subscribeReq("tag=chat"), store, VAULT, unscopedScope(), manager);
    const r = sseReader(res);
    await r.pump();
    const snap = r.frames().find((f) => f.event === "snapshot")!;
    expect(snap.data.notes.length).toBe(60);
    await r.close();
  });
});

describe("handleSubscribe — expand axis snapshot↔live consistency", () => {
  // vault tag `expand` axis (design 2026-06-09): a subscription's snapshot
  // (query engine) and its live matcher MUST lower the IDENTICAL tag
  // expansion. We seed the two-axis corpus, then for each `expand` mode assert
  // the snapshot set EQUALS the set the live matcher would accept over every
  // note in the vault.
  async function seedTwoAxis() {
    await store.upsertTagRecord("entity", { description: "entity root" });
    await store.upsertTagRecord("person", { parent_names: ["entity"] }); // subtype, not name-prefixed
    await store.upsertTagRecord("entity/archived", {}); // name-prefixed, not subtype
    await store.upsertTagRecord("entity/person", { parent_names: ["entity"] }); // both
    await store.createNote("literal", { tags: ["entity"] });
    await store.createNote("subtype", { tags: ["person"] });
    await store.createNote("filed", { tags: ["entity/archived"] });
    await store.createNote("both", { tags: ["entity/person"] });
    await store.createNote("unrelated", { tags: ["work"] });
  }

  for (const mode of ["subtypes", "namespace", "both", "exact"] as const) {
    it(`expand=${mode}: snapshot set ≡ live-matcher acceptance`, async () => {
      await seedTwoAxis();
      const { buildLiveMatcher } = await import("./live-match.ts");

      const res = await handleSubscribe(
        subscribeReq(`tag=entity&expand=${mode}`),
        store,
        VAULT,
        unscopedScope(),
        manager,
      );
      expect(res.status).toBe(200);
      const r = sseReader(res);
      await r.pump();
      const snap = r.frames().find((f) => f.event === "snapshot")!;
      const snapIds = new Set<string>(snap.data.notes.map((n: any) => n.id));

      // The matcher accepts/rejects each note in the vault — compute its set.
      const matcher = await buildLiveMatcher(store, { tags: ["entity"], expand: mode });
      const allNotes = await store.queryNotes({ limit: Number.MAX_SAFE_INTEGER });
      const liveIds = new Set<string>(allNotes.filter((n) => matcher.match(n)).map((n) => n.id));

      expect(liveIds).toEqual(snapIds);
      await r.close();
    });
  }

  it("expand=namespace: a live insert filed under entity/ arrives; a subtype-only insert does NOT", async () => {
    await seedTwoAxis();
    // The matcher freezes its tag expansion at subscribe time (mirroring the
    // snapshot query — design "resolved ONCE at subscribe time"). So the tags
    // these live notes carry must already be KNOWN at subscribe time:
    //   - entity/inbox: name-prefixed → in the frozen namespace set.
    //   - agent: declared subtype of entity, NOT name-prefixed → excluded by
    //     namespace mode.
    await store.upsertTagRecord("entity/inbox", {});
    await store.upsertTagRecord("agent", { parent_names: ["entity"] });

    const res = await handleSubscribe(
      subscribeReq("tag=entity&expand=namespace"),
      store,
      VAULT,
      unscopedScope(),
      manager,
    );
    const r = sseReader(res);
    await r.pump();

    await store.createNote("new filed", { tags: ["entity/inbox"] }); // name-prefixed → upsert
    await store.createNote("new subtype", { tags: ["agent"] }); // subtype-only → no upsert
    await settle();
    await r.pump();

    const upserts = r.frames().filter((f) => f.event === "upsert");
    const contents = upserts.map((u) => u.data.note.content);
    expect(contents).toContain("new filed");
    expect(contents).not.toContain("new subtype");
    await r.close();
  });

  it("invalid expand value → 400 INVALID_QUERY before any stream opens", async () => {
    const res = await handleSubscribe(
      subscribeReq("tag=entity&expand=bogus"),
      store,
      VAULT,
      unscopedScope(),
      manager,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_QUERY");
  });
});

describe("handleSubscribe — cap", () => {
  it("over-cap subscribe → 503", async () => {
    const capped = new SubscriptionManager(hooks, { maxPerVault: 1, resolveVault: () => VAULT });
    const r1 = await handleSubscribe(subscribeReq("tag=chat"), store, VAULT, unscopedScope(), capped);
    expect(r1.status).toBe(200);
    const reader1 = sseReader(r1);
    await reader1.pump();
    expect(capped.countForVault(VAULT)).toBe(1);

    const r2 = await handleSubscribe(subscribeReq("tag=chat"), store, VAULT, unscopedScope(), capped);
    expect(r2.status).toBe(503);
    const body = await r2.json();
    expect(body.code).toBe("SUBSCRIPTION_CAP_REACHED");

    await reader1.close();
    capped.shutdown();
  });

  it("closing a stream frees a cap slot", async () => {
    const capped = new SubscriptionManager(hooks, { maxPerVault: 1, resolveVault: () => VAULT });
    const r1 = await handleSubscribe(subscribeReq("tag=chat"), store, VAULT, unscopedScope(), capped);
    const reader1 = sseReader(r1);
    await reader1.pump();
    expect(capped.countForVault(VAULT)).toBe(1);

    await reader1.close();
    // Cancel propagates to the manager teardown.
    await settle();
    expect(capped.countForVault(VAULT)).toBe(0);
    capped.shutdown();
  });
});
