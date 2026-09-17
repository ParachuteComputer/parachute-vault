import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { handleMcp } from "./mcp-http.ts";
import { route } from "./routing.ts";
import { resetJwksCache, resetRevocationCache } from "./hub-jwt.ts";
import { writeVaultConfig, readVaultConfig, vaultConfigPath } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { BunSqliteStore } from "../core/src/store.ts";
import * as history from "../core/src/history.ts";

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

import { applyImportedNote, beginImportRun, importTargetDigest } from "../core/src/history-import.ts";
test("authenticated history REST redacts scoped provenance for read/write/admin tokens", async () => {
  const note = await store.createNote("before", { tags: ["journal"] });
  await store.updateNote(note.id, { content: "after", actor: "HISTORICAL_EDITOR", via: "HISTORICAL_INTERFACE" });
  for (const verb of ["read", "write", "admin"]) {
    for (const scoped of [false, true]) {
      for (const suffix of ["/versions", "/versions/0"]) {
        const got = await call(`/notes/${note.id}${suffix}`, "GET", undefined, verb, scoped);
        expect(got.status).toBe(200);
        const row = got.body.versions?.[0] ?? got.body;
        expect(Object.hasOwn(row, "actor")).toBe(!scoped);
        expect(Object.hasOwn(row, "via")).toBe(!scoped);
        if (!scoped) expect(row.actor).toBe("HISTORICAL_EDITOR");
        expect(row.version_ix).toBe(0);
      }
    }
  }
  expect((await store.getNoteVersion(note.id, 0))!.actor).toBe("HISTORICAL_EDITOR");
});
test("imported REST references restore by ID or encoded path and preserve native keys", async () => {
  const note = await store.createNote("native", { path: "folder/imported", tags: ["journal"] });
  await store.updateNote(note.id, { content: "current" });
  const run = { run_id: "rest", source_fingerprint: "source", tip: "tip", options_digest: "options" };
  beginImportRun(store.db, run);
  applyImportedNote(store.db, { run, noteId: note.id, targetDigest: importTargetDigest(store.db, note.id), policy: history.resolveHistoryPolicy({ min_versions: 20 }), now: Date.now(), observations: [{ content: "archive", path: "old/path", metadata: { old: true }, extension: "md", created_at: null, observed_at: new Date().toISOString(), commit: "commit", blob: "blob" }] });
  for (const ref of [note.id, encodeURIComponent("folder/imported")]) {
    const got = await call(`/notes/${ref}/imports/0`);
    expect(got.status).toBe(200);
    expect(got.body.content).toBe("archive");
    expect(got.body.origin).toBe("git-import");
    expect(got.body.import_ix).toBe(0);
    expect(got.body.version_ix).toBeUndefined();
  }
  const native = await call(`/notes/${note.id}/versions/0`);
  expect(native.body.version_ix).toBe(0);
  expect(native.body.origin).toBeUndefined();
  const list = await call(`/notes/${note.id}/versions`);
  expect(list.body.versions.map((v: any) => v.version_ix ?? v.origin)).toEqual([0, "git-import"]);
  for (const body of [{ origin: "git-import" }, { import_ix: 0 }, { origin: "git-import", import_ix: 0, version_ix: 0 }, { origin: "git-import", import_ix: -1 }]) expect((await call(`/notes/${note.id}/restore`, "POST", body)).status).toBe(400);
  expect((await call(`/notes/${note.id}/versions/-1`)).status).toBe(400);
  const restored = await call(`/notes/${note.id}/restore`, "POST", { origin: "git-import", import_ix: 0 });
  expect(restored.status).toBe(200);
  expect(restored.body.restored_from).toEqual({ origin: "git-import", import_ix: 0 });
  expect((await store.getNote(note.id))!.content).toBe("archive");
  expect((await store.getNote(note.id))!.path).toBe("folder/imported");
  const missing = await call(`/notes/${note.id}/imports/99`);
  expect(missing.status).toBe(404);
  expect(missing.body).toMatchObject({ origin: "git-import", import_ix: 99 });
  await store.deleteNote(note.id);
  const recreated = await call(`/notes/${note.id}/restore`, "POST", { origin: "git-import", import_ix: 0 });
  expect(recreated.status).toBe(200);
  expect(recreated.body.recreated).toBe(true);
  expect((await store.getNote(note.id))!.content).toBe("archive");
  const hash = store.db.query("SELECT content_hash FROM note_versions WHERE note_id=? AND version_ix=-1").get(note.id) as { content_hash: string };
  store.db.query("UPDATE note_blobs SET encoding='unknown' WHERE hash=?").run(hash.content_hash);
  const broken = await call(`/notes/${note.id}/imports/0`);
  expect(broken.status).toBe(409);
  expect(broken.body).toMatchObject({ origin: "git-import", import_ix: 0, error_type: "history_unrecoverable" });
  expect(JSON.stringify(broken.body)).not.toContain("version_ix");
  expect(JSON.stringify(broken.body)).not.toContain("@-1");
  const privateNote = await store.createNote("private", { tags: ["secret"] });
  expect((await call(`/notes/${privateNote.id}/imports/0`, "GET", undefined, "read", true)).status).toBe(404);
});
