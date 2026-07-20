/**
 * Live-query frame PARITY + the pure WS helpers (WS-hibernation migration,
 * self-host door).
 *
 * The load-bearing CROSS-DOOR conformance check: for the shared frame corpus
 * (mirrored byte-for-byte from the cloud door), the self-host WS message folds
 * the event name into a `type` discriminator (plus the snapshot `done` chunk
 * flag) over an inner payload (`notes` / `note` / `id`) that serializes
 * byte-IDENTICALLY to the corpus. Because the corpus AND the `wsFrame` formatter
 * are byte-shaped identical to cloud's, this transitively proves: self-host WS
 * bytes === corpus === cloud WS bytes. (SSE was the original transport; it was
 * removed in Phase 5 — WebSocket is now the sole live transport, polling the
 * client floor.)
 *
 * Plus unit coverage of the pure helpers that back the Bun.serve integration:
 * snapshot chunking, first-message parsing, verb-rank, and the query rejects.
 */
import { describe, it, expect } from "bun:test";
import { wsFrame, WsSink } from "./subscriptions.ts";
import {
  buildSnapshotFrames,
  parseClientMessage,
  vaultVerbRank,
  sameTagScope,
  validateWsSubscribeQuery,
  subscriptionCapResponse,
  urlFromQuery,
  SNAPSHOT_CHUNK_MAX_NOTES,
  WS_CLOSE,
} from "./ws-subscribe.ts";
import { unsupportedSubscriptionReason } from "./live-match.ts";
import { FRAME_CORPUS, NOTE_A } from "./test-support/live-frame-corpus.ts";

describe("live-frame parity — self-host WS bytes === corpus === cloud WS bytes", () => {
  for (const c of FRAME_CORPUS) {
    it(`${c.name}: WS message folds the event into \`type\` over the corpus payload`, () => {
      const ws = wsFrame(c.event, c.data);

      // WS message is `{ type, ...data }` — the event name folds into `type`.
      const parsedWs = JSON.parse(ws) as Record<string, unknown>;
      expect(parsedWs.type).toBe(c.event);
      const { type, ...rest } = parsedWs;
      void type;
      expect(rest).toEqual(c.data);

      // BYTE parity of the inner payload: whatever value the event carries
      // (`notes` / `note` / `id`) serializes IDENTICALLY to the corpus
      // serialization (the cross-door invariant).
      const innerKey = c.event === "snapshot" ? "notes" : c.event === "upsert" ? "note" : "id";
      const innerBytes = JSON.stringify((c.data as Record<string, unknown>)[innerKey]);
      expect(ws.includes(innerBytes)).toBe(true);
    });
  }
});

describe("sink classes render through the ONE formatter", () => {
  it("WsSink.send emits exactly wsFrame(event, data)", () => {
    const sent: string[] = [];
    const sink = new WsSink({ send: (d: string) => sent.push(d), close: () => {} });
    for (const c of FRAME_CORPUS) {
      sink.send(c.event, c.data);
      expect(sent.at(-1)).toBe(wsFrame(c.event, c.data));
    }
  });
});

describe("buildSnapshotFrames — chunking + done flag", () => {
  it("empty set → exactly one done:true frame", () => {
    const frames = buildSnapshotFrames([]);
    expect(frames.length).toBe(1);
    expect(JSON.parse(frames[0]!)).toEqual({ type: "snapshot", notes: [], done: true });
  });

  it("small set → one done:true frame carrying every note", () => {
    const frames = buildSnapshotFrames([NOTE_A as any, NOTE_A as any]);
    expect(frames.length).toBe(1);
    const f = JSON.parse(frames[0]!);
    expect(f.done).toBe(true);
    expect(f.notes.length).toBe(2);
  });

  it("> SNAPSHOT_CHUNK_MAX_NOTES → multiple frames, only the last done:true, concat = full set", () => {
    const many = Array.from({ length: SNAPSHOT_CHUNK_MAX_NOTES + 5 }, (_, i) => ({ ...NOTE_A, id: `n-${i}` }));
    const frames = buildSnapshotFrames(many as any);
    expect(frames.length).toBeGreaterThan(1);
    const parsed = frames.map((f) => JSON.parse(f));
    expect(parsed.filter((p) => p.done).length).toBe(1);
    expect(parsed[parsed.length - 1]!.done).toBe(true);
    parsed.slice(0, -1).forEach((p) => expect(p.done).toBe(false));
    const concat = parsed.flatMap((p) => p.notes);
    expect(concat.map((n: any) => n.id)).toEqual(many.map((n) => n.id));
  });

  it("each frame stays under the WS message ceiling with large notes", () => {
    const big = Array.from({ length: 8 }, (_, i) => ({ ...NOTE_A, id: `big-${i}`, content: "x".repeat(200_000) }));
    const frames = buildSnapshotFrames(big as any);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(new TextEncoder().encode(f).byteLength).toBeLessThan(1_000_000);
    expect(frames.flatMap((f) => JSON.parse(f).notes).length).toBe(8);
  });

  it("is shape-agnostic — frames a lean NoteIndex entry verbatim", () => {
    // A lean subscription hands `toNoteIndex`-projected entries; the framer
    // serializes them byte-for-byte, no content field re-added.
    const lean = { id: "x", byteSize: 3, preview: "abc", displayTitle: "abc", tags: ["chat"], metadata: {} };
    const frames = buildSnapshotFrames([lean as any]);
    expect(frames.length).toBe(1);
    const f = JSON.parse(frames[0]!);
    expect(f.done).toBe(true);
    expect(f.notes).toEqual([lean]);
    expect(f.notes[0].content).toBeUndefined();
  });
});

describe("parseClientMessage", () => {
  it("valid auth", () => {
    expect(parseClientMessage(JSON.stringify({ type: "auth", token: "t" }))).toEqual({ kind: "auth", token: "t" });
  });
  it("auth without a token → malformed", () => {
    expect(parseClientMessage(JSON.stringify({ type: "auth" })).kind).toBe("malformed");
    expect(parseClientMessage(JSON.stringify({ type: "auth", token: "" })).kind).toBe("malformed");
  });
  it("non-json / non-object → malformed", () => {
    expect(parseClientMessage("not json").kind).toBe("malformed");
    expect(parseClientMessage(JSON.stringify([1, 2])).kind).toBe("malformed");
  });
  it("other typed message → other", () => {
    expect(parseClientMessage(JSON.stringify({ type: "hello" }))).toEqual({ kind: "other", type: "hello" });
  });
  it("decodes a Uint8Array frame", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "auth", token: "b" }));
    expect(parseClientMessage(bytes)).toEqual({ kind: "auth", token: "b" });
  });
});

describe("vaultVerbRank — narrow-or-equal ordering", () => {
  it("ranks read < write < admin, -1 for none/other-vault", () => {
    expect(vaultVerbRank(["vault:v:read"], "v")).toBe(0);
    expect(vaultVerbRank(["vault:v:write"], "v")).toBe(1);
    expect(vaultVerbRank(["vault:v:admin"], "v")).toBe(2);
    expect(vaultVerbRank(["vault:other:read"], "v")).toBe(-1);
    expect(vaultVerbRank([], "v")).toBe(-1);
  });
  it("a widen is strictly greater (the 4403 trigger)", () => {
    expect(vaultVerbRank(["vault:v:admin"], "v") > vaultVerbRank(["vault:v:read"], "v")).toBe(true);
    expect(vaultVerbRank(["vault:v:read"], "v") > vaultVerbRank(["vault:v:admin"], "v")).toBe(false);
  });
});

describe("sameTagScope — the WS re-auth tag-scope-delta gate", () => {
  it("both unscoped (null) → same", () => {
    expect(sameTagScope(null, null)).toBe(true);
  });
  it("null vs scoped → differ (a drop/gain of scoping)", () => {
    expect(sameTagScope(null, ["work/eng"])).toBe(false);
    expect(sameTagScope(["work/eng"], null)).toBe(false);
  });
  it("same set (order/dupe-insensitive) → same", () => {
    expect(sameTagScope(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameTagScope(["a", "a", "b"], ["b", "a"])).toBe(true);
  });
  it("different membership → differ", () => {
    expect(sameTagScope(["work/eng"], ["work/sales"])).toBe(false);
    expect(sameTagScope(["a"], ["a", "b"])).toBe(false);
  });
});

describe("validateWsSubscribeQuery — same rejects as the SSE route (byte-identical bodies)", () => {
  const reject = async (q: string) => {
    const v = validateWsSubscribeQuery(new URL(`http://x/vault/v/api/subscribe?${q}`));
    expect("error" in v).toBe(true);
    const body = await (v as { error: Response }).error.json();
    expect((v as { error: Response }).error.status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
  };
  it("rejects the URL-reachable unsupported shapes: search / near / cursor / has_links", async () => {
    await reject("search=hi");
    await reject("near[note_id]=abc");
    await reject("cursor=xyz");
    await reject("has_links=true");
  });
  it("accepts a supported query", () => {
    const v = validateWsSubscribeQuery(new URL("http://x/vault/v/api/subscribe?tag=chat&path_prefix=meetings/"));
    expect("queryOpts" in v).toBe(true);
  });
  it("resolves include_content — default TRUE (full), `false`/`0` → lean, `true`/`1` → full", () => {
    const at = (q: string) =>
      validateWsSubscribeQuery(new URL(`http://x/vault/v/api/subscribe?tag=chat${q}`)) as { includeContent: boolean };
    expect(at("").includeContent).toBe(true); // absent → full (byte-unchanged default)
    expect(at("&include_content=false").includeContent).toBe(false); // opt into lean
    expect(at("&include_content=0").includeContent).toBe(false);
    expect(at("&include_content=true").includeContent).toBe(true);
    expect(at("&include_content=1").includeContent).toBe(true);
  });
  it("shares the SSE route's queryOpts-level guard (cursor/has_links/date filters)", () => {
    // The belt-and-suspenders layer both doors + the SSE route route through:
    // a date filter isn't expressible as a flat URL param (removed 0.6.4), but
    // if one ever reaches queryOpts it is rejected identically.
    expect(unsupportedSubscriptionReason({ cursor: "x" } as any)).toBeTruthy();
    expect(unsupportedSubscriptionReason({ hasLinks: true } as any)).toBeTruthy();
    expect(unsupportedSubscriptionReason({ dateFrom: "2026-01-01" } as any)).toBeTruthy();
    expect(unsupportedSubscriptionReason({ dateFilter: { field: "created_at" } } as any)).toBeTruthy();
    expect(unsupportedSubscriptionReason({ tags: ["chat"] } as any)).toBeNull();
  });
});

describe("misc pure helpers", () => {
  it("subscriptionCapResponse → 503 SUBSCRIPTION_CAP_REACHED", async () => {
    const res = subscriptionCapResponse();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("SUBSCRIPTION_CAP_REACHED");
  });
  it("urlFromQuery reconstructs searchParams from a raw query string", () => {
    expect(urlFromQuery("?tag=chat&a=b").searchParams.get("tag")).toBe("chat");
    expect(urlFromQuery("").search).toBe("");
  });
  it("WS_CLOSE carries the four application close codes", () => {
    expect([WS_CLOSE.PROTOCOL, WS_CLOSE.UNAUTHORIZED, WS_CLOSE.FORBIDDEN, WS_CLOSE.AUTH_TIMEOUT]).toEqual([
      4400, 4401, 4403, 4408,
    ]);
  });
});
