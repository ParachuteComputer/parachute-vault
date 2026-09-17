import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleNotes, handleTags, type WriteCtx } from "./routes.ts";
import {
  writeVaultConfig,
  readVaultConfig,
  vaultConfigPath,
} from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { runDoctorScan } from "../core/src/doctor.ts";
import { applyImportedNote, beginImportRun, importTargetDigest } from "../core/src/history-import.ts";
import { resolveHistoryPolicy } from "../core/src/history.ts";
let taskDir: string,
  savedHome: string | undefined,
  store: ReturnType<typeof getVaultStore>;
beforeEach(() => {
  savedHome = process.env.PARACHUTE_HOME;
  taskDir = mkdtempSync(join(tmpdir(), "vault-history-"));
  process.env.PARACHUTE_HOME = taskDir;
  writeVaultConfig({
    name: "history",
    api_keys: [],
    created_at: new Date().toISOString(),
  });
  store = getVaultStore("history");
});
afterEach(() => {
  clearVaultStoreCache();
  rmSync(taskDir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = savedHome;
});
async function call(
  id: string,
  sub = "",
  method = "GET",
  body?: unknown,
  scoped = false,
  ctx: WriteCtx = { actor: "tester", via: "api" },
) {
  const req = new Request(`http://localhost/api/notes/${id}${sub}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const response = await handleNotes(
    req,
    store,
    `/${id}${sub.split("?")[0]}`,
    "history",
    scoped
      ? { raw: ["journal"], allowed: new Set(["journal"]) }
      : { raw: null, allowed: null },
    ctx,
  );
  return { status: response.status, body: (await response.json()) as any };
}
function query(tags: string[] | null = null, tool = "query-notes") {
  return generateScopedMcpTools("history", {
    permission: "full",
    scopes: ["vault:history:read"],
    legacyDerived: false,
    scoped_tags: tags,
    vault_name: null,
    caller_jti: null,
    actor: "tester",
    via: "api",
  }).find((t) => t.name === tool)!.execute;
}
async function fixture() {
  const n = await store.createNote("zero", { path: "p", tags: ["journal"] });
  await store.updateNote(n.id, { content: "one" });
  await store.updateNote(n.id, { content: "two" });
  return n;
}
test("tag-scoped REST and MCP history omit provenance without changing stored rows", async () => {
  const n = await store.createNote("original", { path: "history-visible", tags: ["journal"] });
  await store.updateNote(n.id, { content: "current", actor: "PRIVATE_EDITOR", via: "PRIVATE_INTERFACE" });
  const run = { run_id: "visibility", source_fingerprint: "source", tip: "tip", options_digest: "options" };
  beginImportRun(store.db, run);
  applyImportedNote(store.db, { run, noteId: n.id, targetDigest: importTargetDigest(store.db, n.id),
    policy: resolveHistoryPolicy({ min_versions: 20 }), now: Date.now(),
    observations: [{ content: "archive", path: "old/path", metadata: {}, extension: "md", created_at: null,
      observed_at: new Date().toISOString(), commit: "commit", blob: "blob" }] });
  const before = await store.listNoteVersions(n.id);
  const full = (await call(n.id, "/versions")).body;
  expect(full.versions[0]).toMatchObject({ actor: "PRIVATE_EDITOR", via: "PRIVATE_INTERFACE" });
  for (const scoped of [false, true]) {
    const rest = (await call(n.id, "/versions", "GET", undefined, scoped)).body;
    const mcp = await query(scoped ? ["journal"] : null)({ versions: { note_id: n.id } });
    expect(mcp).toEqual(rest);
    expect(rest.total).toBe(2);
    expect(rest.versions[0].version_ix).toBe(0);
    expect(rest.versions[1]).toMatchObject({ origin: "git-import", import_ix: 0 });
    for (const row of rest.versions) {
      expect(Object.hasOwn(row, "actor")).toBe(!scoped);
      expect(Object.hasOwn(row, "via")).toBe(!scoped);
    }
    for (const [path, selector, content] of [
      ["/versions/0", { version_ix: 0 }, "original"],
      ["/imports/0", { origin: "git-import", import_ix: 0 }, "archive"],
    ] as const) {
      const one = await call(n.id, path, "GET", undefined, scoped);
      expect(one.status).toBe(200);
      expect(one.body.content).toBe(content);
      expect(await query(scoped ? ["journal"] : null)({ versions: { note_id: n.id, ...selector } })).toEqual(one.body);
      expect(Object.hasOwn(one.body, "actor")).toBe(!scoped);
      expect(Object.hasOwn(one.body, "via")).toBe(!scoped);
    }
  }
  expect(await store.listNoteVersions(n.id)).toEqual(before);
  expect((await store.getNote(n.id))!.content).toBe("current");
  // Empty tag lists mean unrestricted in the existing authorization contract.
  expect(await query([])({ versions: { note_id: n.id } })).toEqual(full);
  const denied = await query(["unrelated"])({ versions: { note_id: n.id } });
  expect(denied).toMatchObject({ error_type: "not_found" });
});
test("P5 REST restore rejects stale optimistic tokens without capture", async () => {
  const n = await fixture();
  const before = await store.listNoteVersions(n.id);
  const r = await call(n.id, "/restore", "POST", {
    version_ix: 0,
    if_updated_at: "1999-01-01T00:00:00.000Z",
  });
  expect(r.status).toBe(409);
  expect(r.body.error_type).toBe("conflict");
  const nonString = await call(n.id, "/restore", "POST", {
    version_ix: 0,
    if_updated_at: 12345,
  });
  expect(nonString.status).toBe(409);
  expect(nonString.body.error_type).toBe("conflict");
  expect(await store.listNoteVersions(n.id)).toEqual(before);
  expect((await store.getNote(n.id))!.content).toBe("two");
});
test("P7/P10 deleted history is readable unscoped and indistinguishable from missing when scoped", async () => {
  const n = await fixture();
  await call(n.id, "", "DELETE");
  expect((await call(n.id)).status).toBe(404);
  expect((await call(n.id, "/versions")).body.versions[0]).toMatchObject({
    op: "delete",
    actor: "tester",
    via: "api",
  });
  expect(await call(n.id, "/versions", "GET", undefined, true)).toEqual({
    status: 404,
    body: { error: "Not found", error_type: "not_found" },
  });
});
test("P11 REST transition-only writes capture the old metadata", async () => {
  const n = await store.createNote("body", { metadata: { status: "a" } });
  const r = await call(n.id, "", "PATCH", {
    state_transition: { field: "status", from: "a", to: "b" },
  });
  expect(r.status).toBe(200);
  expect(await store.getNoteVersion(n.id, 0)).toMatchObject({
    metadata: { status: "a" },
  });
  expect(await store.listNoteVersions(n.id)).toHaveLength(1);
});
test("P13 REST overflowing prior body rejects the write with 413", async () => {
  const n = await store.createNote("é".repeat(1000001));
  const r = await call(n.id, "", "PATCH", { content: "small", force: true });
  expect(r.status).toBe(413);
  expect(r.body.error_type).toBe("history_overflow");
  expect(await store.listNoteVersions(n.id)).toHaveLength(0);
});
test("P15 REST list/get and MCP project the same ordered versions", async () => {
  const n = await fixture(),
    rest = await call(n.id, "/versions?limit=1&offset=1");
  expect(rest.status).toBe(200);
  expect(rest.body.total).toBe(2);
  expect((await call(n.id, "/versions?limit=0")).body).toEqual({
    versions: [],
    total: 2,
  });
  expect(rest.body.versions).toHaveLength(1);
  expect(rest.body.versions[0].version_ix).toBe(0);
  expect(rest.body.versions[0]).not.toHaveProperty("content");
  const mcp: any = await query()({
    versions: { note_id: n.id, limit: 1, offset: 1 },
  });
  expect(mcp).toEqual(rest.body);
  expect(await query()({ versions: { note_id: n.id, limit: -1 } })).toEqual({
    versions: [],
    total: 2,
  });
  const one = await call(n.id, "/versions/0");
  expect(one.body.content).toBe("zero");
  expect(await query()({ versions: { note_id: n.id, version_ix: 0 } })).toEqual(
    one.body,
  );
  expect((await call(n.id, "/versions/999")).status).toBe(404);
  for (const ix of ["-1", "1.5", "oops", "0x0"])
    expect((await call(n.id, `/versions/${ix}`)).status).toBe(400);
  expect((await call(n.id, "/restore", "POST", {})).body.error_type).toBe(
    "missing_required_field",
  );
  expect(
    (await call(n.id, "/restore", "POST", { version_ix: -1 })).status,
  ).toBe(400);
});
for (const mode of ["aggregate", "near", "search", "cursor", "semantic", "id"])
  test(`P15 MCP versions excludes ${mode}`, async () => {
    const n = await fixture();
    const values: Record<string, unknown> = {
      aggregate: { group_by: "tag" },
      near: { note_id: n.id },
      search: "zero",
      cursor: "invalid",
      semantic: true,
      id: n.id,
    };
    await expect(
      query()({ versions: { note_id: n.id }, [mode]: values[mode] }),
    ).rejects.toMatchObject({ error_type: "invalid_query", field: "versions" });
  });
test("P16 doctor reports deleted-history upper bounds without mutation or scoped leakage", async () => {
  const a = await store.createNote("same"),
    b = await store.createNote("same");
  await store.deleteNote(a.id);
  await store.deleteNote(b.id);
  const before = store.db
    .prepare(
      "SELECT note_id, version_ix, content_hash, path, metadata, extension, superseded_at, actor, via, op, content_len, encoding FROM note_versions ORDER BY note_id",
    )
    .all();
  const report = runDoctorScan(store.db);
  expect(
    report.findings.find((f) => f.type === "deleted_note_history"),
  ).toMatchObject({
    severity: "info",
    subject: "2 deleted note(s)",
    detail: expect.stringContaining("upper bound"),
  });
  const mcp: any = await query(null, "doctor")({});
  expect(
    mcp.findings.find((f: any) => f.type === "deleted_note_history"),
  ).toMatchObject({
    severity: "info",
    subject: "2 deleted note(s)",
    detail: expect.stringContaining("upper bound"),
  });
  const scopedDoctor: any = await query(["journal"], "doctor")({});
  expect(
    scopedDoctor.findings.some((f: any) => f.type === "deleted_note_history"),
  ).toBe(false);
  expect(
    report.findings.filter((f) => f.type === "deleted_note_history"),
  ).toHaveLength(1);
  expect(
    runDoctorScan(store.db, {
      allowedTags: new Set(["journal"]),
    }).findings.some((f) => f.type === "deleted_note_history"),
  ).toBe(false);
  expect(
    store.db
      .prepare(
        "SELECT note_id, version_ix, content_hash, path, metadata, extension, superseded_at, actor, via, op, content_len, encoding FROM note_versions ORDER BY note_id",
      )
      .all(),
  ).toEqual(before);
  expect(await store.deletedHistoryStats()).toMatchObject({
    notes: 2,
    versions: 2,
    bytes: 8,
  });
});
test("P18 MCP protects the new object result from out-of-scope disclosure", async () => {
  const x = await store.createNote("X_SENTINEL", { tags: ["journal"] }),
    y = await store.createNote("Y_SECRET_SENTINEL", { tags: ["work"] });
  await store.updateNote(x.id, { content: "x2" });
  await store.updateNote(y.id, { content: "y2" });
  await store.updateNote(x.id, { content: "x3" });
  await store.updateNote(y.id, { content: "y3" });
  const denied: any = await query(["journal"])({ versions: { note_id: y.id } });
  expect(denied.error_type).toBe("not_found");
  expect(JSON.stringify(denied)).not.toContain("Y_SECRET_SENTINEL");
  expect(denied).not.toHaveProperty("versions");
  expect(
    ((await query(["journal"])({ versions: { note_id: x.id } })) as any)
      .versions,
  ).toHaveLength(2);
  expect(
    ((await query()({ versions: { note_id: y.id } })) as any).versions,
  ).toHaveLength(2);
  expect(
    ((await query()({ versions: { note_id: y.id, version_ix: 0 } })) as any)
      .content,
  ).toBe("Y_SECRET_SENTINEL");
  for (const tags of [["journal"], null]) {
    const error = await query(tags)({
      id: y.id,
      versions: { note_id: x.id },
    }).catch((e) => e);
    expect(error).toMatchObject({
      error_type: "invalid_query",
      field: "versions",
      hint: "drop id when using versions",
    });
    expect(JSON.stringify(error)).not.toContain("Y_SECRET_SENTINEL");
  }
  const contentDenied: any = await query(["journal"])({
    versions: { note_id: y.id, version_ix: 0 },
  });
  expect(contentDenied.error_type).toBe("not_found");
  expect(JSON.stringify(contentDenied)).not.toContain("Y_SECRET_SENTINEL");
  const empty = await store.createNote("EMPTY_SECRET_SENTINEL", {
    tags: ["work"],
  });
  const emptyDenied: any = await query(["journal"])({
    versions: { note_id: empty.id },
  });
  expect(emptyDenied.error_type).toBe("not_found");
  expect(emptyDenied).not.toHaveProperty("versions");
  expect(JSON.stringify(emptyDenied)).not.toContain("EMPTY_SECRET_SENTINEL");
  await store.deleteNote(y.id);
  for (const tags of [["journal"], null])
    await expect(
      query(tags)({ versions: { note_id: y.id } }),
    ).rejects.toMatchObject({ error_type: "not_found" });
});
test("P18h missing versions do not disclose a scoped-out path's canonical id", async () => {
  const ref = "private/history-target";
  const n = await store.createNote("PRIVATE_CONTENT", {
    path: ref,
    tags: ["work"],
    metadata: { secret: "PRIVATE_METADATA" },
  });
  await store.updateNote(n.id, { content: "later" });
  const params = { versions: { note_id: ref, version_ix: 999 } };
  const scoped = await query(["journal"])(params);
  expect(scoped).toEqual({
    error: "Note not found",
    error_type: "not_found",
    id: ref,
  });
  expect(JSON.stringify(scoped)).not.toContain(n.id);
  const unscoped = await query()(params);
  expect(unscoped).toEqual({
    error: `Version not found: "${ref}"@999`,
    error_type: "not_found",
    id: ref,
    version_ix: 999,
  });
  expect(JSON.stringify(unscoped)).not.toContain(n.id);
});
test("P19 overflow deletion remains possible but its tombstone cannot restore", async () => {
  const n = await store.createNote("x".repeat(2000001));
  expect((await call(n.id, "", "DELETE")).status).toBe(200);
  expect((await call(n.id, "/versions/0")).body).toMatchObject({
    encoding: "overflow",
    content: null,
    content_hash: null,
  });
  const r = await call(n.id, "/restore", "POST", { version_ix: 0 });
  expect(r.status).toBe(409);
  expect(r.body.error_type).toBe("history_unrecoverable");
});
test("P20 REST recreates untagged at the tombstone path and guards conflicts", async () => {
  const n = await fixture();
  await store.deleteNote(n.id);
  for (const [sub, method, body] of [
    ["/versions", "GET", undefined],
    ["/versions/0", "GET", undefined],
    ["/restore", "POST", { version_ix: 0 }],
  ] as const)
    expect((await call(n.id, sub, method, body, true)).status).toBe(404);
  expect(
    (
      await call(n.id, "/restore", "POST", {
        version_ix: 0,
        if_updated_at: "stale",
      })
    ).status,
  ).toBe(409);
  const r = await call(n.id, "/restore", "POST", { version_ix: 0 });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({
    id: n.id,
    path: "p",
    content: "zero",
    tags: [],
    recreated: true,
    restored_from: 0,
  });
});
test("P22 config round-trips all five history fields including zero and null", () => {
  const c = readVaultConfig("history")!;
  c.history = {
    enabled: false,
    min_versions: 0,
    max_versions: 7,
    max_age_days: 0,
    deleted_retention_days: null,
  };
  writeVaultConfig(c);
  expect(readVaultConfig("history")!.history).toEqual(c.history);
  const p = vaultConfigPath("history"),
    text = readFileSync(p, "utf8");
  writeFileSync(p, text.replace("max_versions: 7", "max_versions: nonsense"));
  expect(readVaultConfig("history")!.history?.max_versions).toBeUndefined();
  expect(readVaultConfig("history")!.history?.min_versions).toBe(0);
});
async function strictFixture() {
  await store.upsertTagRecord("task", {});
  const n = await store.createNote("old", {
    tags: ["task"],
    metadata: { status: "obsolete" },
  });
  await store.upsertTagRecord("task", {
    fields: {
      status: { type: "string", enum: ["active", "archived"], strict: true },
    },
  });
  await store.updateNote(n.id, { metadata: { status: "active" } });
  return n;
}
test("P23 restore enforces today's strict schema without changing note or history", async () => {
  const n = await strictFixture(),
    before = await store.getNote(n.id),
    versions = await store.listNoteVersions(n.id);
  const r = await call(n.id, "/restore", "POST", { version_ix: 0 });
  expect(r.status).toBe(422);
  expect(r.body.error_type).toBe("schema_validation");
  expect(await store.getNote(n.id)).toEqual(before);
  expect(await store.listNoteVersions(n.id)).toEqual(versions);
});
test("P24 migration bypass restores, captures once, and emits the bypass log", async () => {
  const n = await strictFixture();
  const log = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const r = await call(n.id, "/restore", "POST", { version_ix: 0 }, false, {
      actor: "migrator",
      via: "api",
      bypassStrict: true,
    });
    expect(r.status).toBe(200);
    expect((await store.getNote(n.id))!.metadata.status).toBe("obsolete");
    expect(await store.listNoteVersions(n.id)).toHaveLength(2);
    expect(JSON.stringify(log.mock.calls)).toContain("strict_schema_bypass");
  } finally {
    log.mockRestore();
  }
});

test("P8c REST tag rename carries the caller attribution", async () => {
  await store.upsertTagRecord("old", {});
  const n = await store.createNote("#old body");
  const r = await handleTags(
    new Request("http://localhost/api/tags/old/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "new" }),
    }),
    store,
    "/old/rename",
    { raw: null, allowed: null },
    { actor: "renamer", via: "api" },
  );
  expect(r.status).toBe(200);
  expect(await store.getNoteVersion(n.id, 0)).toMatchObject({
    op: "tag-rename",
    actor: "renamer",
    via: "api",
  });
});
test("P20 REST path collision and absent lineage return existing error vocabulary", async () => {
  const n = await fixture();
  await store.deleteNote(n.id);
  await store.createNote("occupant", { path: "p" });
  const before = await store.listNoteVersions(n.id);
  const r = await call(n.id, "/restore", "POST", { version_ix: 0 });
  expect(r.status).toBe(409);
  expect(r.body.error_type).toBe("path_conflict");
  expect(await store.getNote(n.id)).toBeNull();
  expect(await store.listNoteVersions(n.id)).toEqual(before);
  expect(
    (
      await call("01M2GT8W9W19TXZR57NQ5JZD3J", "/restore", "POST", {
        version_ix: 0,
      })
    ).status,
  ).toBe(404);
});
test("P22 parser distinguishes zero deleted retention and retains following keys", () => {
  const p = vaultConfigPath("history");
  writeFileSync(
    p,
    `name: history\ncreated_at: "2026-09-14T00:00:00Z"\napi_keys: []\nhistory:\n  enabled: false\n  min_versions: 5\n  max_versions: 9\n  max_age_days: 30\n  deleted_retention_days: 0\ndescription: following\n`,
  );
  const c = readVaultConfig("history")!;
  expect(c.history).toEqual({
    enabled: false,
    min_versions: 5,
    max_versions: 9,
    max_age_days: 30,
    deleted_retention_days: 0,
  });
  expect(c.description).toBe("following");
  writeVaultConfig(c);
  expect(readVaultConfig("history")!.history).toEqual(c.history);
});
test("P7e/P15 full routing requires admin for irreversible erasure", async () => {
  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const { route } = await import("./routing.ts");
  const { resetJwksCache, resetRevocationCache } = await import("./hub-jwt.ts");
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return new URL(req.url).pathname === "/.well-known/jwks.json"
        ? Response.json({
            keys: [{ ...jwk, kid: "history-test", alg: "RS256", use: "sig" }],
          })
        : Response.json({ generated_at: new Date().toISOString(), jtis: [] });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`,
    savedOrigin = process.env.PARACHUTE_HUB_ORIGIN,
    savedJwks = process.env.PARACHUTE_HUB_JWKS_ORIGIN;
  process.env.PARACHUTE_HUB_ORIGIN = origin;
  process.env.PARACHUTE_HUB_JWKS_ORIGIN = origin;
  resetJwksCache();
  resetRevocationCache();
  try {
    const n = await fixture();
    await store.deleteNote(n.id);
    const request = async (verb: string, tagRename = false, doctor = false) => {
      const token = await new SignJWT({
        scope: `vault:history:${verb}`,
        client_id: "history-test",
      })
        .setProtectedHeader({ alg: "RS256", kid: "history-test" })
        .setIssuer(origin)
        .setSubject("history-tester")
        .setAudience("vault.history")
        .setIssuedAt()
        .setExpirationTime("1m")
        .setJti(`history-${verb}`)
        .sign(privateKey);
      const path = doctor
        ? "/vault/history/api/doctor"
        : tagRename
          ? "/vault/history/api/tags/old/rename"
          : `/vault/history/api/notes/${n.id}/versions`;
      const r = await route(
        new Request(`http://localhost${path}`, {
          method: doctor ? "GET" : tagRename ? "POST" : "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(tagRename ? { body: JSON.stringify({ new_name: "new" }) } : {}),
        }),
        path,
      );
      return { status: r.status, body: (await r.json()) as any };
    };
    const other = await store.createNote("other");
    await store.deleteNote(other.id);
    const doctor = await request("read", false, true);
    expect(doctor.status).toBe(200);
    expect(
      doctor.body.findings.find((f: any) => f.type === "deleted_note_history"),
    ).toMatchObject({
      severity: "info",
      subject: "2 deleted note(s)",
      detail: expect.stringContaining("upper bound"),
    });
    const denied = await request("write");
    expect(denied.status).toBe(403);
    expect(denied.body.required_scope).toBe("vault:admin");
    expect(await store.listNoteVersions(n.id)).toHaveLength(3);
    const erased = await request("admin");
    expect(erased.status).toBe(200);
    expect(erased.body.erased).toBe(true);
    expect((await call(n.id, "/versions")).status).toBe(404);
    await store.upsertTagRecord("old", {});
    const tagged = await store.createNote("#old body");
    expect((await request("admin", true)).status).toBe(200);
    expect(await store.getNoteVersion(tagged.id, 0)).toMatchObject({
      op: "tag-rename",
      actor: "history-tester",
      via: "api",
    });
  } finally {
    server.stop(true);
    if (savedOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
    else process.env.PARACHUTE_HUB_ORIGIN = savedOrigin;
    if (savedJwks === undefined) delete process.env.PARACHUTE_HUB_JWKS_ORIGIN;
    else process.env.PARACHUTE_HUB_JWKS_ORIGIN = savedJwks;
    resetJwksCache();
    resetRevocationCache();
  }
});
