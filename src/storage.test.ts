/**
 * Storage upload allowlist tests (issue #127; widened for documents/ebooks).
 *
 * The allowlist guards `POST /api/storage/upload` against turning user
 * uploads into XSS vectors when the asset is later served back from
 * `/storage/`. We pin both the accepted set and the deliberate exclusions
 * so a future widening doesn't quietly let SVG/HTML in.
 *
 * The accepted set is intentionally broad — a knowledge vault stores ebooks
 * (.epub/.mobi), office docs, plain text / markdown / data, and .zip archives,
 * not just media. But it stays an ALLOWLIST (fail-closed): active-content
 * extensions (.svg/.html/.js…) and unknown binaries (.exe) are rejected. The
 * GET serve path additionally pins `X-Content-Type-Options: nosniff` so a
 * served asset can never be sniffed into an executable type.
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

  test("accepts .epub — the reported gap (ebooks are knowledge content)", async () => {
    const res = await handleStorage(uploadRequest("book.epub", "application/epub+zip"), "/upload", "default", uploadStore);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mimeType: string; path: string };
    expect(body.mimeType).toBe("application/epub+zip");
    expect(body.path).toMatch(/\.epub$/);
  });

  test("accepts common document / text / data / archive types", async () => {
    for (const [name, mime, expected] of [
      ["notes.txt", "text/plain", "text/plain; charset=utf-8"],
      ["readme.md", "text/markdown", "text/markdown; charset=utf-8"],
      ["data.csv", "text/csv", "text/csv; charset=utf-8"],
      ["data.json", "application/json", "application/json; charset=utf-8"],
      ["doc.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["archive.zip", "application/zip", "application/zip"],
      ["clip.mov", "video/quicktime", "video/quicktime"],
      ["photo.heic", "image/heic", "image/heic"],
    ] as const) {
      const res = await handleStorage(uploadRequest(name, mime), "/upload", "default", uploadStore);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { mimeType: string };
      expect(body.mimeType).toBe(expected);
    }
  });

  test("an allowed extension without an explicit MIME serves as octet-stream (download)", async () => {
    // .pages is allowed (iWork doc) but has no entry in MIME_TYPES → octet-stream.
    const res = await handleStorage(uploadRequest("deck.pages", "application/octet-stream"), "/upload", "default", uploadStore);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mimeType: string };
    expect(body.mimeType).toBe("application/octet-stream");
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

  test("rejects .js / .xhtml — active-content types stay out even after widening", async () => {
    for (const [name, mime] of [
      ["script.js", "text/javascript"],
      ["page.xhtml", "application/xhtml+xml"],
    ] as const) {
      const res = await handleStorage(uploadRequest(name, mime), "/upload", "default", uploadStore);
      expect(res.status).toBe(400);
    }
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
    // Served bytes pin nosniff so a browser can't sniff them into an active type.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
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

// ---------------------------------------------------------------------------
// GET percent-encoded-slash handling (feedback finding D).
//
// `path` reaches handleStorage from `url.pathname`, which keeps an encoded
// `%2F` slash LITERAL (WHATWG). The old `path.match(/^\/([^/]+)\/(.+)$/)`
// required a literal slash, so `/api/storage/<date>%2F<file>` fell to the
// unconditional 404 — a trap-grade asymmetry with the single-note routes,
// which decode their first segment and therefore REQUIRE `%2F`. The fix
// decodes `path` before matching, accepting BOTH forms; the decoded path is
// also what the DB stores (`${date}/${filename}`), so tag-scope lookup and
// the traversal guard keep working. These tests pin both forms + the
// guard-safety of the decode.
// ---------------------------------------------------------------------------

describe("storage GET percent-encoded slash (finding D)", () => {
  const VAULT = "encode-vault";

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

  // The request URL carries the encoded form; the `path` arg mirrors what the
  // dispatcher hands the handler (derived from url.pathname, %2F kept literal).
  function getReqEncoded(reqPath: string): { req: Request; path: string } {
    const encoded = reqPath.replace(/\//g, "%2F");
    return {
      req: new Request(`http://localhost:1940/storage/${encoded}`, { method: "GET" }),
      path: `/${encoded}`,
    };
  }

  test("encoded %2F path serves the same bytes as the literal form (200)", async () => {
    const { store, inScopePath } = await setup();
    const ctx = await tagScopeCtx(store, ["work"]);
    const { req, path } = getReqEncoded(inScopePath);
    const res = await handleStorage(req, path, VAULT, store, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect((await res.arrayBuffer()).byteLength).toBe(4);
  });

  test("literal-slash path still serves (regression)", async () => {
    const { store, inScopePath } = await setup();
    const ctx = await tagScopeCtx(store, ["work"]);
    const res = await handleStorage(
      new Request(`http://localhost:1940/storage/${inScopePath}`, { method: "GET" }),
      `/${inScopePath}`,
      VAULT,
      store,
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(4);
  });

  test("encoded traversal %2E%2E%2F… → 403 (decoded `..` hits the traversal guard)", async () => {
    const { store } = await setup();
    const ctx = await tagScopeCtx(store, ["work"]);
    // Fully percent-encoded `/a/../../../../../../etc/passwd`. Decode yields
    // the literal traversal, which resolves outside assetsDir → 403.
    const evilDecoded = "/a/../../../../../../etc/passwd";
    const evilEncoded = "/a%2F%2E%2E%2F%2E%2E%2F%2E%2E%2F%2E%2E%2F%2E%2E%2F%2E%2E%2Fetc%2Fpasswd";
    expect(decodeURIComponent(evilEncoded)).toBe(evilDecoded);
    const res = await handleStorage(
      new Request(`http://localhost:1940/storage${evilEncoded}`, { method: "GET" }),
      evilEncoded,
      VAULT,
      store,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  test("tag-scoped token + out-of-scope owning note → still 404 with an encoded path", async () => {
    const { store, outScopePath } = await setup();
    const ctx = await tagScopeCtx(store, ["work"]);
    const { req, path } = getReqEncoded(outScopePath);
    const res = await handleStorage(req, path, VAULT, store, ctx);
    expect(res.status).toBe(404);
  });

  test("malformed `%` (e.g. /api/storage/2026%2) → 404, not 500", async () => {
    const { store } = await setup();
    const ctx = await tagScopeCtx(store, ["work"]);
    // `%2` is not a valid percent-escape → decodeURIComponent throws → 404.
    const bad = "/2026%2";
    expect(() => decodeURIComponent(bad)).toThrow();
    const res = await handleStorage(
      new Request(`http://localhost:1940/storage${bad}`, { method: "GET" }),
      bad,
      VAULT,
      store,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("double-encoded %252F → 404 (decodes ONCE to literal %2F, no slash, no second decode)", async () => {
    const { store } = await setup();
    const ctx = await tagScopeCtx(store, ["work"]);
    // `%252F` → decodeURIComponent once → `%2F` (a literal `%2F`, NOT a slash).
    // The single decode is deliberate: a second decode would turn this into a
    // real slash and risk serving / re-looping. With one decode the path has
    // no `/` separator, so the date/file match fails → 404.
    const doubleEncoded = "/2026-05-28%252Ffile.bin";
    expect(decodeURIComponent(doubleEncoded)).toBe("/2026-05-28%2Ffile.bin");
    const res = await handleStorage(
      new Request(`http://localhost:1940/storage${doubleEncoded}`, { method: "GET" }),
      doubleEncoded,
      VAULT,
      store,
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST parity (finding D — decode block must not change upload behavior).
//
// The `POST /upload` branch returns BEFORE the decode block, so a real upload
// is untouched. A POST to a non-`/upload` storage path with a malformed `%`
// falls past the upload branch into the decode (the `try/catch` is not method-
// gated), where the throw → 404 — the same status the pre-fix unconditional
// final 404 produced for this request. Pins that the decode doesn't turn a
// malformed-`%` POST into a 500 and keeps POST behavior at parity.
// ---------------------------------------------------------------------------

describe("storage POST parity (finding D)", () => {
  test("POST to a malformed-`%` storage path → 404, unchanged by the GET-side decode", async () => {
    const bad = "/2026%2";
    const res = await handleStorage(
      new Request(`http://localhost:1940/storage${bad}`, { method: "POST" }),
      bad,
      "default",
      uploadStore,
    );
    expect(res.status).toBe(404);
  });
});
