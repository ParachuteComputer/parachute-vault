import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { route } from "./routing.ts";
import { resetJwksCache, resetRevocationCache } from "./hub-jwt.ts";
import { writeVaultConfig, readVaultConfig, vaultConfigPath } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { BunSqliteStore } from "../core/src/store.ts";
import * as history from "../core/src/history.ts";
const codec = await import("../core/src/delta.js").catch(() => null);
let taskDir: string, savedHome: string | undefined, savedOrigin: string | undefined, savedJwks: string | undefined, origin: string;
let store: ReturnType<typeof getVaultStore>, server: ReturnType<typeof Bun.serve>, privateKey: CryptoKey;
beforeEach(async () => {
  savedHome = process.env.PARACHUTE_HOME;
  savedOrigin = process.env.PARACHUTE_HUB_ORIGIN;
  savedJwks = process.env.PARACHUTE_HUB_JWKS_ORIGIN;
  taskDir = mkdtempSync(join(tmpdir(), "vault-compact-"));
  process.env.PARACHUTE_HOME = taskDir;
  writeVaultConfig({ name: "compact", api_keys: [], created_at: new Date().toISOString() });
  store = getVaultStore("compact");
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  const jwk = await exportJWK(keys.publicKey);
  server = Bun.serve({ port: 0, fetch(req) { return new URL(req.url).pathname === "/.well-known/jwks.json" ? Response.json({ keys: [{ ...jwk, kid: "compact-test", alg: "RS256", use: "sig" }] }) : Response.json({ generated_at: new Date().toISOString(), jtis: [] }); } });
  origin = `http://127.0.0.1:${server.port}`;
  process.env.PARACHUTE_HUB_ORIGIN = origin;
  process.env.PARACHUTE_HUB_JWKS_ORIGIN = origin;
  resetJwksCache();
  resetRevocationCache();
});
afterEach(() => { server.stop(true); clearVaultStoreCache(); rmSync(taskDir, { recursive: true, force: true }); for (const [key, value] of [["PARACHUTE_HOME", savedHome], ["PARACHUTE_HUB_ORIGIN", savedOrigin], ["PARACHUTE_HUB_JWKS_ORIGIN", savedJwks]] as const) {
  if (value === undefined)
    delete process.env[key];
  else
    process.env[key] = value;
} resetJwksCache(); resetRevocationCache(); });
async function call(path: string, method = "GET", body?: unknown, verb = "admin", scoped = false) {
  const token = await new SignJWT({ scope: `vault:compact:${verb}`, client_id: "compact-test", ...(scoped ? { permissions: { scoped_tags: ["journal"] } } : {}) }).setProtectedHeader({ alg: "RS256", kid: "compact-test" }).setIssuer(origin).setSubject("tester").setAudience("vault.compact").setIssuedAt().setExpirationTime("5m").setJti(crypto.randomUUID()).sign(privateKey);
  const full = `/vault/compact/api${path}`, response = await route(new Request(`http://localhost${full}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://localhost${full}`).pathname);
  return { status: response.status, body: await response.json() as any };
}
async function seed(name = "secret-path", count = 12) { const n = await store.createNote((`private-body-sentinel ${name} abcdefgh\n`).repeat(800), { path: name, tags: ["journal"] }); for (let i = 0; i < count; i++)
  await store.updateNote(n.id, { append: `\nedit${i}` }); return n; }
const snapshot = () => store.db.prepare("SELECT hash,content,byte_size,encoding,delta_of FROM note_blobs ORDER BY hash").all();
function query(tags: string[] | null = null, tool = "query-notes") { return generateScopedMcpTools("compact", { permission: "full", scopes: ["vault:compact:read"], legacyDerived: false, scoped_tags: tags, vault_name: null, caller_jti: null, actor: "tester", via: "api" }).find(t => t.name === tool)!.execute; }
test("P9/P18 compacted REST and MCP versions roundtrip with exact keys", async () => {
  const n = await seed();
  const before = (await store.getNoteVersion(n.id, 0))!;
  store.compactNote(n.id);
  const get = await call(`/notes/${n.id}/versions/0`);
  expect(get.status).toBe(200);
  expect(get.body.content).toBe(before.content);
  expect(get.body.encoding).toBe("fossil-delta");
  expect(Object.keys(get.body).sort()).toEqual(["note_id", "version_ix", "content_hash", "path", "metadata", "extension", "superseded_at", "actor", "via", "op", "content_len", "encoding", "created_at", "content"].sort());
  const list = await call(`/notes/${n.id}/versions?limit=2`);
  expect(list.body.total).toBe(await store.countNoteVersions(n.id));
  expect(list.body.versions).toHaveLength(2);
  expect(list.body.versions.every((v: any) => v.encoding === null)).toBe(true);
  const mcp = await query()({ versions: { note_id: n.id, version_ix: 0 } }) as any;
  expect(mcp).toEqual(get.body);
  const ml = await query()({ versions: { note_id: n.id, limit: 2 } }) as any;
  expect(ml.total).toBe(list.body.total);
  const restore = await call(`/notes/${n.id}/restore`, "POST", { version_ix: 0 });
  expect(restore.status).toBe(200);
  expect((await store.getNote(n.id))!.content).toBe(before.content);
});
test("P10 full routing gates methods, admin, tag scope and optional bodies", async () => {
  const n = await seed();
  await seed("second");
  const before = snapshot();
  const denied = await call("/history/compact", "POST", undefined, "write");
  expect(denied.status).toBe(403);
  expect(denied.body).toMatchObject({ error_type: "insufficient_scope", required_scope: "vault:admin" });
  for (const method of ["GET", "PATCH", "DELETE"]) {
    expect((await call("/history/compact", method, undefined, method === "GET" ? "read" : "admin")).status).toBe(404);
    expect(snapshot()).toEqual(before);
  }
  for (const body of [undefined, { note_id: n.id }]) {
    const denied = await call("/history/compact", "POST", body, "admin", true);
    expect(denied.status).toBe(404);
    expect(denied.body.error_type).toBe("not_found");
  }
  for (const body of [{ budget_ms: 0 }, { max_notes: 0 }, { note_id: 123 }, [], null, { budget_ms: 1.5 }]) {
    const bad = await call("/history/compact", "POST", body);
    expect(bad.status).toBe(400);
    expect(bad.body.error_type).toBe("invalid_request");
  }
  const all = await call("/history/compact", "POST");
  expect(all.status).toBe(200);
  expect(all.body).toMatchObject({ notes_scanned: 2, remaining_candidates: 0, stopped_by: "complete" });
  expect(all.body.blobs_deltified).toBeGreaterThan(0);
  await seed("third");
  const empty = await call("/history/compact", "POST", {});
  expect(empty.status).toBe(200);
  expect(empty.body.blobs_deltified).toBeGreaterThan(0);
  const config = readVaultConfig("compact")!;
  writeVaultConfig({ ...config, history: { compact_min_versions: 2, compact_ratio: 1, compact_budget_ms: 0 } });
  clearVaultStoreCache();
  store = getVaultStore("compact");
  const randomBody = () => Buffer.from(crypto.getRandomValues(new Uint8Array(10240))).toString("hex");
  const a = randomBody(), b = randomBody();
  expect(codec!.encodeDelta(b, a).length).toBeGreaterThanOrEqual(a.length * .9);
  const random = await store.createNote(a);
  await store.updateNote(random.id, { content: b });
  await store.updateNote(random.id, { content: a });
  const randomBefore = snapshot();
  for (let i = 0; i < 2; i++) {
    const refused = store.compactNote(random.id);
    expect(refused.blobs_deltified).toBe(0);
    expect(refused.blobs_skipped_too_large).toBeGreaterThanOrEqual(1);
    expect(snapshot()).toEqual(randomBefore);
    const pass = await call("/history/compact", "POST", { note_id: random.id });
    expect(pass.body).toMatchObject({ notes_scanned: 1, stopped_by: "complete", blobs_deltified: 0 });
  }
  const mock = spyOn(store, "compactHistory").mockImplementation(() => { throw Error("injected"); });
  try {
    const failed = await call("/history/compact", "POST");
    expect(failed.status).toBe(500);
    expect(failed.body.error_type).toBe("compaction_failed");
  }
  finally {
    mock.mockRestore();
  }
});
test("P11 structural doctor census is read-only and hidden to scoped callers", async () => {
  const n = await seed();
  store.compactNote(n.id);
  await store.deleteNote(n.id);
  const before = snapshot();
  const versionCount = await store.countNoteVersions(n.id);
  const r = await call("/doctor"), finding = r.body.findings.find((f: any) => f.type === "history_storage");
  expect(r.status).toBe(200);
  expect(r.body.findings.filter((f: any) => f.type === "history_storage")).toHaveLength(1);
  expect(await store.countNoteVersions(n.id)).toBe(versionCount);
  expect(finding.detail).toContain(String(history.historyStorageStats(store.db).whole_bytes));
  expect(finding.severity).toBe("info");
  expect(finding.detail).toContain(String(history.historyStorageStats(store.db).delta_bytes));
  expect(finding.detail).toContain(n.id);
  expect(JSON.stringify(r.body)).not.toContain("secret-path");
  expect(JSON.stringify(r.body)).not.toContain("private-body-sentinel");
  expect(snapshot()).toEqual(before);
  expect(r.body.findings.find((f: any) => f.type === "deleted_note_history").detail).toContain("upper bound");
  const scoped = await call("/doctor", "GET", undefined, "read", true);
  expect(scoped.body.findings.filter((f: any) => ["history_storage", "history_delta_orphan"].includes(f.type))).toEqual([]);
  const mcp = await query(["journal"], "doctor")({}) as any;
  expect(JSON.stringify(mcp)).not.toContain("history_storage");
  expect(r.body.findings.some((f: any) => /budget|remaining/.test(f.type))).toBe(false);
});
for (const corruption of ["missing", "unknown", "checksum"]) {
  test(`P13 ${corruption} read and restore fail while list survives`, async () => {
    const n = await seed();
    store.compactNote(n.id);
    const v = (await store.getNoteVersion(n.id, 0))!;
    const blob = store.db.prepare("SELECT content,delta_of FROM note_blobs WHERE hash=?").get(v.content_hash) as any;
    if (corruption === "missing") {
      // Disable FK solely to construct an otherwise forbidden corrupt state.
      store.db.exec("PRAGMA foreign_keys=OFF");
      store.db.prepare("DELETE FROM note_blobs WHERE hash=?").run(blob.delta_of);
      store.db.exec("PRAGMA foreign_keys=ON");
    }
    else if (corruption === "unknown")
      store.db.prepare("UPDATE note_blobs SET encoding='fossil-delta-v9' WHERE hash=?").run(v.content_hash);
    else {
      const base = store.db.prepare("SELECT content FROM note_blobs WHERE hash=?").get(blob.delta_of) as any;
      const damaged = base.content.replaceAll("a", "Z");
      expect(codec).not.toBeNull();
      expect(() => codec!.decodeDelta(damaged, blob.content)).toThrow("bad checksum");
      store.db.prepare("UPDATE note_blobs SET content=? WHERE hash=?").run(damaged, blob.delta_of);
      expect(() => history.readBlobContent(store.db, v.content_hash!)).toThrow("bad_delta");
    }
    const get = await call(`/notes/${n.id}/versions/0`);
    expect(get.status).toBe(409);
    expect(get.body.error_type).toBe("history_unrecoverable");
    expect(get.body.hint).toContain("delta");
    expect((await call(`/notes/${n.id}/restore`, "POST", { version_ix: 0 })).status).toBe(409);
    expect((await call(`/notes/${n.id}/versions`)).status).toBe(200);
    if (corruption !== "checksum") {
      const report = await call("/doctor");
      expect(report.body.findings.find((f: any) => f.type === "history_delta_orphan").severity).toBe("error");
    }
  });
}
test("P13 overflow hint remains distinct", async () => { const n = await store.createNote("x".repeat(2000001)); await store.deleteNote(n.id); const r = await call(`/notes/${n.id}/restore`, "POST", { version_ix: 0 }); expect(r.status).toBe(409); expect(r.body.hint).toContain("overflow tombstone"); });
test("P19 config keeps all twelve values and roundtrips", () => {
  const config = readVaultConfig("compact")!;
  const policy = { enabled: false, min_versions: 5, max_versions: 9, max_age_days: 30, deleted_retention_days: 0, compact_enabled: false, compact_ratio: 2.5, compact_min_versions: 4, compact_run_length: 8, max_bytes_per_note: null, compact_budget_ms: 0, compact_max_notes: 3 };
  writeVaultConfig({ ...config, history: policy });
  expect(readVaultConfig("compact")!.history).toEqual(policy);
  writeFileSync(vaultConfigPath("compact"), "name: compact\nhistory:\n  compact_min_versions: abc\n  compact_ratio: 2.5\ndescription: following\n");
  expect(readVaultConfig("compact")!.history?.compact_min_versions).toBeUndefined();
  expect(readVaultConfig("compact")!.description).toBe("following");
});
test("P21 boot synchronous bounded, cached and tolerant of throw", async () => {
  for (let i = 0; i < 3; i++)
    await seed(`boot${i}`);
  const config = readVaultConfig("compact")!;
  writeVaultConfig({ ...config, history: { compact_max_notes: 1, compact_budget_ms: 60000 } });
  clearVaultStoreCache();
  const log = spyOn(console, "log").mockImplementation(() => { });
  try {
    store = getVaultStore("compact");
    expect(history.historyStorageStats(store.db).delta_blobs).toBeGreaterThan(0);
    const before = snapshot();
    expect(getVaultStore("compact")).toBe(store);
    expect(snapshot()).toEqual(before);
    expect(JSON.stringify(log.mock.calls)).toContain("remaining_candidates");
    const summary = log.mock.calls.find(call => String(call[0]).includes("history compaction"))![1];
    expect(summary).toMatchObject({ notes_scanned: 1, notes_compacted: 1, remaining_candidates: 2 });
  }
  finally {
    log.mockRestore();
  }
  clearVaultStoreCache();
  const mock = spyOn(BunSqliteStore.prototype, "compactHistory").mockImplementation(() => { throw Error("injected boot"); });
  const warn = spyOn(console, "warn").mockImplementation(() => { });
  try {
    store = getVaultStore("compact");
    expect((await store.queryNotes({})).length).toBe(3);
    expect(warn).toHaveBeenCalled();
  }
  finally {
    mock.mockRestore();
    warn.mockRestore();
  }
});
test("P21 zero budget performs no compaction and matches disabled open cost", async () => {
  await seed();
  const config = readVaultConfig("compact")!;
  const times: number[] = [];
  for (const historyConfig of [{ compact_enabled: false }, { compact_budget_ms: 0 }]) {
    writeVaultConfig({ ...config, history: historyConfig });
    clearVaultStoreCache();
    const start = performance.now();
    store = getVaultStore("compact");
    times.push(performance.now() - start);
    expect(history.historyStorageStats(store.db).delta_blobs).toBe(0);
  }
  expect(times[1]! - times[0]!).toBeLessThan(5);
});
