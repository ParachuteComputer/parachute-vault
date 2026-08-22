/**
 * vault#568 — a scoped read must not disclose out-of-scope tag NAMES via a
 * note's own `.tags` array.
 *
 * `noteWithinTagScope` admits a note when ANY of its tags is in scope, but
 * the note that came back carried its FULL tag set. A note tagged
 * `["mine","project-manhattan"]` read by a `mine`-scoped token disclosed the
 * NAME `project-manhattan` — the same out-of-scope-tag-name class as #560
 * and the W8 `validation_status` scrub, through a plainer field.
 *
 * The fix (`scrubNoteTagsByScope`, src/tag-scope.ts) filters `.tags` to the
 * in-scope subset using the SAME per-tag rule that admitted the note, on
 * BOTH doors (REST + MCP) and on the live-subscription transport. Write
 * responses are scrubbed too: they echo the stored note, so a no-op
 * `update-note` / `PATCH` would otherwise be a one-call bypass.
 *
 * Fixture: PARACHUTE_HOME temp home + hand-built AuthResult, same pattern as
 * tag-field-conflict-scope.test.ts.
 *
 * Naming convention used throughout: `mine` is in scope, `project-manhattan`
 * is the out-of-scope co-tag whose NAME must appear nowhere in a scoped
 * response. Every test carries an UNSCOPED control asserting the full tag
 * set still comes back — the fix must be invisible to unscoped callers.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { handleNotes, type TagScopeCtx } from "./routes.ts";
import { SubscriptionManager, type SubscriptionSink } from "./subscriptions.ts";
import { buildLiveMatcher } from "./live-match.ts";
import { expandTokenTagScope } from "./tag-scope.ts";
import type { AuthResult } from "./auth.ts";
import type { Note, Store } from "../core/src/types.ts";

const OUT_OF_SCOPE = "project-manhattan";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-568-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();
});

afterEach(() => {
  clearVaultStoreCache();
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function seedVault(name: string): Store {
  writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
  return getVaultStore(name);
}

function authFor(vaultName: string, scopedTags: string[] | null): AuthResult {
  return {
    permission: "full",
    scopes: [`vault:${vaultName}:read`, `vault:${vaultName}:write`],
    legacyDerived: false,
    scoped_tags: scopedTags,
    vault_name: null,
    caller_jti: null,
    actor: "test-user",
    via: "api",
  } as AuthResult;
}

/** The REST layer's tag-scope context, built the way routing.ts builds it. */
async function restScope(store: Store, scopedTags: string[] | null): Promise<TagScopeCtx> {
  return { allowed: await expandTokenTagScope(store, scopedTags), raw: scopedTags };
}

async function rest(
  store: Store,
  scope: TagScopeCtx,
  method: string,
  subpath: string,
  query = "",
  body?: unknown,
): Promise<any> {
  const req = new Request(`http://localhost/vault/v/api/notes${subpath}${query}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const res = await handleNotes(req, store, subpath, "v", scope);
  return { status: res.status, body: await res.json() };
}

/** The co-tagged fixture every test reads: visible via `mine`, co-tagged out of scope. */
async function seedCoTagged(store: Store): Promise<Note> {
  return await store.createNote("co-tagged body", {
    path: "CoTagged",
    tags: ["mine", OUT_OF_SCOPE],
  });
}

describe("vault#568 — REST door: a note's own .tags is filtered to the in-scope subset", () => {
  test("GET /api/notes?id= — scoped caller sees only in-scope tags; the out-of-scope NAME is absent from the whole payload", async () => {
    const store = seedVault("v");
    const note = await seedCoTagged(store);
    const scope = await restScope(store, ["mine"]);

    const { status, body } = await rest(store, scope, "GET", "", `?id=${note.id}`);
    expect(status).toBe(200);
    expect(body.tags).toEqual(["mine"]);
    expect(JSON.stringify(body)).not.toContain(OUT_OF_SCOPE);
  });

  test("GET /api/notes?id= UNSCOPED control — full tag set survives (the fix is invisible to unscoped tokens)", async () => {
    const store = seedVault("v");
    const note = await seedCoTagged(store);
    const scope = await restScope(store, null);

    const { body } = await rest(store, scope, "GET", "", `?id=${note.id}`);
    expect([...body.tags].sort()).toEqual(["mine", OUT_OF_SCOPE]);
  });

  test("GET /api/notes/:id — the note-level route scrubs too", async () => {
    const store = seedVault("v");
    const note = await seedCoTagged(store);
    const scope = await restScope(store, ["mine"]);

    const { status, body } = await rest(store, scope, "GET", `/${note.id}`);
    expect(status).toBe(200);
    expect(body.tags).toEqual(["mine"]);
    expect(JSON.stringify(body)).not.toContain(OUT_OF_SCOPE);
  });

  test("GET /api/notes (structured list) — scrubbed in both the full and the lean (include_content=false) projection", async () => {
    const store = seedVault("v");
    await seedCoTagged(store);
    const scope = await restScope(store, ["mine"]);

    const full = await rest(store, scope, "GET", "", "?include_content=true");
    expect(full.body).toHaveLength(1);
    expect(full.body[0].tags).toEqual(["mine"]);

    const lean = await rest(store, scope, "GET", "", "?include_content=false");
    expect(lean.body[0].tags).toEqual(["mine"]);
    expect(JSON.stringify(lean.body)).not.toContain(OUT_OF_SCOPE);
  });

  test("GET /api/notes?search= — the FTS branch scrubs on the same terms", async () => {
    const store = seedVault("v");
    await seedCoTagged(store);
    const scope = await restScope(store, ["mine"]);

    const { body } = await rest(store, scope, "GET", "", "?search=co-tagged");
    expect(body).toHaveLength(1);
    expect(body[0].tags).toEqual(["mine"]);
    expect(JSON.stringify(body)).not.toContain(OUT_OF_SCOPE);
  });

  test("GET /api/notes?format=graph — nodes[].tags is scrubbed (a REST-only shape with no MCP twin)", async () => {
    const store = seedVault("v");
    await seedCoTagged(store);
    const scope = await restScope(store, ["mine"]);

    const { body } = await rest(store, scope, "GET", "", "?format=graph");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].tags).toEqual(["mine"]);
    expect(JSON.stringify(body)).not.toContain(OUT_OF_SCOPE);
  });

  test("include_links — a SURVIVING in-scope neighbour's summary.tags is scrubbed (the second door on the same field)", async () => {
    const store = seedVault("v");
    // Neighbour is IN scope via `mine`, so `filterHydratedLinksByTagScope`
    // keeps the link — but the neighbour is itself co-tagged, so its
    // NoteSummary.tags carried the out-of-scope name.
    const neighbour = await store.createNote("neighbour", {
      path: "Neighbour",
      tags: ["mine", OUT_OF_SCOPE],
    });
    const anchor = await store.createNote("anchor [[Neighbour]]", {
      path: "Anchor",
      tags: ["mine"],
    });
    const scope = await restScope(store, ["mine"]);

    const { body } = await rest(store, scope, "GET", `/${anchor.id}`, "?include_links=true");
    expect(body.links.length).toBeGreaterThan(0);
    const summaries = body.links.flatMap((l: any) => [l.sourceNote, l.targetNote].filter(Boolean));
    expect(summaries.some((s: any) => s.id === neighbour.id)).toBe(true);
    for (const s of summaries) {
      if (Array.isArray(s.tags)) expect(s.tags).not.toContain(OUT_OF_SCOPE);
    }
    expect(JSON.stringify(body)).not.toContain(OUT_OF_SCOPE);
  });

  test("PATCH echo — a no-op update does NOT hand back the full tag set (the read-path scrub would otherwise be one call from bypassed)", async () => {
    const store = seedVault("v");
    const note = await seedCoTagged(store);
    const scope = await restScope(store, ["mine"]);

    const { status, body } = await rest(store, scope, "PATCH", `/${note.id}`, "", {
      content: "edited",
      force: true,
    });
    expect(status).toBe(200);
    expect(body.tags).toEqual(["mine"]);
    expect(JSON.stringify(body)).not.toContain(OUT_OF_SCOPE);

    // ...and the write really landed: the scrub shapes the response only,
    // it never drops the tag from storage.
    const stored = await store.getNote(note.id);
    expect([...(stored!.tags ?? [])].sort()).toEqual(["mine", OUT_OF_SCOPE]);
    expect(stored!.content).toBe("edited");
  });

  test("POST if_exists:update echo — the response is a PRE-EXISTING note, and its co-tags stay hidden", async () => {
    const store = seedVault("v");
    await seedCoTagged(store);
    const scope = await restScope(store, ["mine"]);

    const { body } = await rest(store, scope, "POST", "", "", {
      path: "CoTagged",
      content: "rewritten",
      tags: ["mine"],
      if_exists: "update",
    });
    expect(body.existed).toBe(true);
    expect(body.tags).toEqual(["mine"]);
    expect(JSON.stringify(body)).not.toContain(OUT_OF_SCOPE);
  });

  test("EDGE — a note whose tags are ALL out of scope stays INVISIBLE (404), it does not come back with an empty .tags", async () => {
    const store = seedVault("v");
    const hidden = await store.createNote("secret", { path: "Secret", tags: [OUT_OF_SCOPE] });
    await seedCoTagged(store);
    const scope = await restScope(store, ["mine"]);

    // Single read → 404, per the contract's "out-of-scope reads return 404,
    // not 403" stance. The scrub never produces an empty-tags stub.
    const single = await rest(store, scope, "GET", `/${hidden.id}`);
    expect(single.status).toBe(404);

    // List → the note is absent entirely, not present-with-no-tags.
    const list = await rest(store, scope, "GET", "", "?include_content=true");
    expect(list.body.map((n: any) => n.id)).not.toContain(hidden.id);
    for (const n of list.body) expect(n.tags.length).toBeGreaterThan(0);
  });
});

describe("vault#568 — MCP door: identical semantics (one contract, two doors)", () => {
  function toolset(vaultName: string, scopedTags: string[] | null) {
    const tools = generateScopedMcpTools(vaultName, authFor(vaultName, scopedTags) as any);
    return (name: string) => tools.find((t) => t.name === name)!;
  }

  test("query-notes by id — scoped session sees only in-scope tags", async () => {
    const store = seedVault("v");
    const note = await seedCoTagged(store);

    const result: any = await toolset("v", ["mine"])("query-notes").execute({ id: note.id });
    expect(result.tags).toEqual(["mine"]);
    expect(JSON.stringify(result)).not.toContain(OUT_OF_SCOPE);
  });

  test("query-notes by id UNSCOPED control — full tag set survives", async () => {
    const store = seedVault("v");
    const note = await seedCoTagged(store);

    const result: any = await toolset("v", null)("query-notes").execute({ id: note.id });
    expect([...result.tags].sort()).toEqual(["mine", OUT_OF_SCOPE]);
  });

  test("query-notes list — scrubbed in the array shape", async () => {
    const store = seedVault("v");
    await seedCoTagged(store);

    const result: any = await toolset("v", ["mine"])("query-notes").execute({});
    const notes = Array.isArray(result) ? result : result.notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].tags).toEqual(["mine"]);
    expect(JSON.stringify(result)).not.toContain(OUT_OF_SCOPE);
  });

  test("create-note with if_exists:update — the echoed PRE-EXISTING note is scrubbed", async () => {
    const store = seedVault("v");
    await seedCoTagged(store);

    const result: any = await toolset("v", ["mine"])("create-note").execute({
      path: "CoTagged",
      content: "rewritten",
      tags: ["mine"],
      if_exists: "update",
    });
    expect(result.tags).toEqual(["mine"]);
    expect(JSON.stringify(result)).not.toContain(OUT_OF_SCOPE);
  });

  test("update-note echo — a no-op update does not leak the co-tag (bypass closed on this door too)", async () => {
    const store = seedVault("v");
    const note = await seedCoTagged(store);

    const result: any = await toolset("v", ["mine"])("update-note").execute({
      id: note.id,
      content: "edited",
      force: true,
    });
    expect(result.tags).toEqual(["mine"]);
    expect(JSON.stringify(result)).not.toContain(OUT_OF_SCOPE);

    const stored = await store.getNote(note.id);
    expect([...(stored!.tags ?? [])].sort()).toEqual(["mine", OUT_OF_SCOPE]);
  });

  test("update-note UNSCOPED control — full tag set still echoed", async () => {
    const store = seedVault("v");
    const note = await seedCoTagged(store);

    const result: any = await toolset("v", null)("update-note").execute({
      id: note.id,
      content: "edited",
      force: true,
    });
    expect([...result.tags].sort()).toEqual(["mine", OUT_OF_SCOPE]);
  });

  test("BOTH-DOOR PARITY — REST and MCP return the same tag set for the same note under the same allowlist", async () => {
    const store = seedVault("v");
    const note = await store.createNote("three tags", {
      path: "Three",
      tags: ["mine", "ops", OUT_OF_SCOPE],
    });
    const scope = await restScope(store, ["mine", "ops"]);

    const restBody = (await rest(store, scope, "GET", `/${note.id}`)).body;
    const mcpBody: any = await toolset("v", ["mine", "ops"])("query-notes").execute({ id: note.id });

    expect([...restBody.tags].sort()).toEqual(["mine", "ops"]);
    expect([...mcpBody.tags].sort()).toEqual([...restBody.tags].sort());
  });

  test("sub-tag hierarchy — the string-form root fallback keeps `mine/sub` VISIBLE while still hiding the out-of-scope name", async () => {
    const store = seedVault("v");
    const note = await store.createNote("hier", {
      path: "Hier",
      tags: ["mine/sub", OUT_OF_SCOPE],
    });
    const scope = await restScope(store, ["mine"]);

    // `mine/sub` has no declared `_tags/mine/sub` hierarchy — it survives via
    // the SAME string-form root fallback `noteWithinTagScope` admits it by,
    // so the scrub can never hide a tag the token is actually allowed to see.
    const restBody = (await rest(store, scope, "GET", `/${note.id}`)).body;
    expect(restBody.tags).toEqual(["mine/sub"]);

    const mcpBody: any = await toolset("v", ["mine"])("query-notes").execute({ id: note.id });
    expect(mcpBody.tags).toEqual(["mine/sub"]);
  });
});

describe("vault#568 — live-subscription door: an event payload is a read too", () => {
  /** Collects `(event, data)` tuples off a subscription. */
  class CapturingSink implements SubscriptionSink {
    readonly frames: Array<{ event: string; data: any }> = [];
    send(event: string, data: unknown): boolean {
      this.frames.push({ event, data });
      return true;
    }
    close(): void {}
  }

  test("upsert fan-out — each subscriber sees only ITS OWN in-scope tags, and the shared payload is not mutated", async () => {
    const store = seedVault("v");
    const note = await store.createNote("watched", {
      path: "Watched",
      tags: ["mine", "ops", OUT_OF_SCOPE],
    });

    const manager = new SubscriptionManager(undefined, { resolveVault: () => "v" });
    const matcher = await buildLiveMatcher(store, {});

    const mineSink = new CapturingSink();
    const opsSink = new CapturingSink();
    const unscopedSink = new CapturingSink();
    manager.register({
      vaultName: "v",
      matcher,
      tagScopeAllowed: await expandTokenTagScope(store, ["mine"]),
      tagScopeRaw: ["mine"],
      sink: mineSink,
      tracksFlush: false,
    });
    manager.register({
      vaultName: "v",
      matcher,
      tagScopeAllowed: await expandTokenTagScope(store, ["ops"]),
      tagScopeRaw: ["ops"],
      sink: opsSink,
      tracksFlush: false,
    });
    manager.register({
      vaultName: "v",
      matcher,
      tagScopeAllowed: null,
      tagScopeRaw: null,
      sink: unscopedSink,
      tracksFlush: false,
    });

    // ONE payload, three subscribers with three different allowlists — the
    // exact shape a mutating scrub would cross-contaminate.
    (manager as any).dispatch("updated", note, store);

    expect(mineSink.frames).toHaveLength(1);
    expect(mineSink.frames[0]!.event).toBe("upsert");
    expect(mineSink.frames[0]!.data.note.tags).toEqual(["mine"]);

    expect(opsSink.frames[0]!.data.note.tags).toEqual(["ops"]);

    // Unscoped control: untouched.
    expect([...unscopedSink.frames[0]!.data.note.tags].sort()).toEqual(["mine", "ops", OUT_OF_SCOPE]);

    // The source payload every sub shared is still intact — proof the scrub
    // copied rather than mutated. (A mutating scrub would have left `note`
    // holding whichever subscriber ran last.)
    expect([...(note.tags ?? [])].sort()).toEqual(["mine", "ops", OUT_OF_SCOPE]);

    manager.shutdown();
  });

  test("upsert fan-out — the LEAN (NoteIndex) projection is scrubbed on the same terms", async () => {
    const store = seedVault("v");
    const note = await store.createNote("watched", { path: "Watched", tags: ["mine", OUT_OF_SCOPE] });

    const manager = new SubscriptionManager(undefined, { resolveVault: () => "v" });
    const sink = new CapturingSink();
    manager.register({
      vaultName: "v",
      matcher: await buildLiveMatcher(store, {}),
      tagScopeAllowed: await expandTokenTagScope(store, ["mine"]),
      tagScopeRaw: ["mine"],
      sink,
      lean: true,
      tracksFlush: false,
    });

    (manager as any).dispatch("updated", note, store);
    expect(sink.frames[0]!.data.note.tags).toEqual(["mine"]);
    expect(JSON.stringify(sink.frames[0]!.data)).not.toContain(OUT_OF_SCOPE);
    manager.shutdown();
  });

  test("out-of-scope note still produces NO frame at all (the pre-existing gate is untouched by the scrub)", async () => {
    const store = seedVault("v");
    const hidden = await store.createNote("secret", { path: "Secret", tags: [OUT_OF_SCOPE] });

    const manager = new SubscriptionManager(undefined, { resolveVault: () => "v" });
    const sink = new CapturingSink();
    manager.register({
      vaultName: "v",
      matcher: await buildLiveMatcher(store, {}),
      tagScopeAllowed: await expandTokenTagScope(store, ["mine"]),
      tagScopeRaw: ["mine"],
      sink,
      tracksFlush: false,
    });

    (manager as any).dispatch("updated", hidden, store);
    expect(sink.frames).toHaveLength(0);
    manager.shutdown();
  });
});
