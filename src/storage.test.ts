/**
 * Storage upload allowlist tests (issue #127).
 *
 * The allowlist guards `POST /api/storage/upload` against turning user
 * uploads into XSS vectors when the asset is later served back from
 * `/storage/`. We pin both the accepted set and the deliberate exclusions
 * so a future widening doesn't quietly let SVG/HTML in.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { initSchema } from "../core/src/schema.ts";
import type { Store } from "../core/src/types.ts";
import type { TagScopeCtx } from "./routes.ts";

const testDir = join(
  tmpdir(),
  `vault-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.PARACHUTE_HOME = testDir;
process.env.ASSETS_DIR = join(testDir, "assets");

const { handleStorage } = await import("./routes.ts");
const { expandTokenTagScope } = await import("./tag-scope.ts");

// The upload-allowlist tests never touch the store (POST /upload writes to
// disk only); a fresh in-memory store satisfies the now-required param.
function freshStore(): SqliteStore {
  const db = new Database(":memory:");
  initSchema(db);
  return new SqliteStore(db);
}
const uploadStore = freshStore();

function uploadRequest(filename: string, mimeType: string): Request {
  const form = new FormData();
  const file = new File([new Uint8Array([0x00, 0x01, 0x02])], filename, {
    type: mimeType,
  });
  form.set("file", file);
  return new Request("http://localhost:1940/storage/upload", {
    method: "POST",
    body: form,
  });
}

/** Build the per-request TagScopeCtx the dispatcher hands handlers. */
async function tagScopeCtx(store: Store, scopedTags: string[] | null): Promise<TagScopeCtx> {
  return { allowed: await expandTokenTagScope(store, scopedTags), raw: scopedTags };
}

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "assets"), { recursive: true });
});

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("storage upload allowlist", () => {
  test("accepts .pdf — knowledge-vault content (#127)", async () => {
    const res = await handleStorage(uploadRequest("paper.pdf", "application/pdf"), "/upload", "default", uploadStore);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mimeType: string; path: string };
    expect(body.mimeType).toBe("application/pdf");
    expect(body.path).toMatch(/\.pdf$/);
  });

  test("accepts .mp4 — mobile capture default (#127)", async () => {
    const res = await handleStorage(uploadRequest("clip.mp4", "video/mp4"), "/upload", "default", uploadStore);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mimeType: string };
    expect(body.mimeType).toBe("video/mp4");
  });

  test("still accepts the existing audio + image set", async () => {
    for (const [name, mime] of [
      ["clip.wav", "audio/wav"],
      ["clip.mp3", "audio/mpeg"],
      ["photo.png", "image/png"],
      ["photo.jpg", "image/jpeg"],
      ["clip.webm", "audio/webm"],
    ] as const) {
      const res = await handleStorage(uploadRequest(name, mime), "/upload", "default", uploadStore);
      expect(res.status).toBe(201);
    }
  });

  test("rejects .svg — XSS vector via inline <script> (#127)", async () => {
    const res = await handleStorage(uploadRequest("evil.svg", "image/svg+xml"), "/upload", "default", uploadStore);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(".svg");
  });

  test("rejects .html — same XSS surface as SVG (#127)", async () => {
    const res = await handleStorage(uploadRequest("evil.html", "text/html"), "/upload", "default", uploadStore);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(".html");
  });

  test("rejects unknown extensions (default-deny)", async () => {
    const res = await handleStorage(uploadRequest("payload.exe", "application/octet-stream"), "/upload", "default", uploadStore);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET byte-serve tag-scope enforcement (C0 adversarial-audit finding).
//
// The raw `/api/storage/<date>/<file>` endpoint historically served bytes by
// filesystem path with only a path-traversal guard — bypassing the tag-scope
// enforcement that gates every note-keyed attachment surface. A tag-scoped
// token could therefore fetch an out-of-scope note's attachment bytes
// directly if it learned the (UUID-secret) storage path. These tests pin the
// fix: in-scope → 200, out-of-scope → 404 (no existence oracle), unscoped →
// 200 (regression), path-traversal guard intact (regression).
// ---------------------------------------------------------------------------

describe("storage GET tag-scope enforcement", () => {
  // Each test builds its own vault assets dir + store so rows and on-disk
  // files line up. `vault` names the assets subdir; ASSETS_DIR is global to
  // the test process, so we point it at this vault's dir per test.
  const VAULT = "scope-vault";

  async function setup(): Promise<{
    store: SqliteStore;
    assets: string;
    inScopePath: string;
    outScopePath: string;
  }> {
    const store = freshStore();
    const assets = join(testDir, "assets", VAULT, "data");
    mkdirSync(join(assets, "2026-05-28"), { recursive: true });
    process.env.ASSETS_DIR = assets;

    // An in-scope (#work) note + attachment, and an out-of-scope (#health)
    // note + attachment. Both files exist on disk.
    const workNote = await store.createNote("work note", { tags: ["work"] });
    const healthNote = await store.createNote("health note", { tags: ["health"] });

    const inScopePath = "2026-05-28/work-asset.pdf";
    const outScopePath = "2026-05-28/health-asset.pdf";
    writeFileSync(join(assets, inScopePath), Buffer.from([0x25, 0x50, 0x44, 0x46])); // %PDF
    writeFileSync(join(assets, outScopePath), Buffer.from([0x25, 0x50, 0x44, 0x46]));

    await store.addAttachment(workNote.id, inScopePath, "application/pdf");
    await store.addAttachment(healthNote.id, outScopePath, "application/pdf");

    return { store, assets, inScopePath, outScopePath };
  }

  function getReq(reqPath: string): Request {
    return new Request(`http://localhost:1940/storage/${reqPath}`, { method: "GET" });
  }

  test("tag-scoped token (work): GET in-scope attachment → 200 (bytes served)", async () => {
    const { store, inScopePath } = await setup();
    const ctx = await tagScopeCtx(store, ["work"]);
    const res = await handleStorage(getReq(inScopePath), `/${inScopePath}`, VAULT, store, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect((await res.arrayBuffer()).byteLength).toBe(4);
  });

  test("tag-scoped token (work): GET OUT-of-scope attachment → 404 (no existence oracle)", async () => {
    const { store, outScopePath } = await setup();
    const ctx = await tagScopeCtx(store, ["work"]);
    const res = await handleStorage(getReq(outScopePath), `/${outScopePath}`, VAULT, store, ctx);
    expect(res.status).toBe(404);
  });

  test("tag-scoped token: GET path with NO owning attachment row → 404", async () => {
    const { store, assets } = await setup();
    // A real on-disk file that no attachment row references — must 404 for a
    // scoped token (would-be existence oracle otherwise).
    const orphanPath = "2026-05-28/orphan-on-disk.pdf";
    writeFileSync(join(assets, orphanPath), Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const ctx = await tagScopeCtx(store, ["work"]);
    const res = await handleStorage(getReq(orphanPath), `/${orphanPath}`, VAULT, store, ctx);
    expect(res.status).toBe(404);
  });

  test("unscoped token: GET any attachment → 200 (regression — no behavior change)", async () => {
    const { store, outScopePath } = await setup();
    const ctx = await tagScopeCtx(store, null); // unscoped
    const res = await handleStorage(getReq(outScopePath), `/${outScopePath}`, VAULT, store, ctx);
    expect(res.status).toBe(200);
  });

  test("default ctx (no tagScope arg): unscoped behavior — 200 (regression)", async () => {
    const { store, outScopePath } = await setup();
    const res = await handleStorage(getReq(outScopePath), `/${outScopePath}`, VAULT, store);
    expect(res.status).toBe(200);
  });

  test("path-traversal guard still blocks ../ escapes (regression)", async () => {
    const { store } = await setup();
    const ctx = await tagScopeCtx(store, ["work"]);
    // `/a/../../../etc/passwd` resolves outside assetsDir → 403 Invalid path.
    const evil = "/a/../../../../../../etc/passwd";
    const res = await handleStorage(
      new Request(`http://localhost:1940/storage${evil}`, { method: "GET" }),
      evil,
      VAULT,
      store,
      ctx,
    );
    expect(res.status).toBe(403);
  });
});
