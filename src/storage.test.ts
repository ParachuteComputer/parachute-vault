/**
 * Storage upload policy tests (issue #127 origin; vault#517 deny-list).
 *
 * `POST /api/storage/upload` accepts ANY file EXCEPT the active-content set a
 * browser can execute when the asset is served back same-origin from
 * `/storage/` (.svg/.html/.htm/.xhtml/.xml/.js/.mjs/.cjs/.css). A knowledge
 * vault stores arbitrary files — ebooks, office docs, datasets, archives,
 * binaries — so the long tail (.epub/.csv/.zip/.exe/…) is accepted, not
 * rejected. We pin the accepted breadth AND the deliberate blocklist so a
 * future edit can't quietly let SVG/HTML in (or quietly start rejecting docs).
 * Two guards keep served files inert: every non-curated type serves as
 * application/octet-stream, and the GET serve path pins
 * `X-Content-Type-Options: nosniff`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
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

const { handleStorage, MAX_UPLOAD_BYTES, MAX_REQUEST_BODY_BYTES, parseByteRangeHeader } = await import("./routes.ts");
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

  test("accepts arbitrary / unknown files — served as octet-stream (download), never run", async () => {
    // Deny-list policy (vault#517): anything not in the active-content blocklist
    // is accepted. Unknown/no-MIME extensions serve as octet-stream — a download.
    for (const name of ["deck.pages", "tool.exe", "data.bin", "Makefile", "archive.tar.gz"] as const) {
      const res = await handleStorage(uploadRequest(name, "application/octet-stream"), "/upload", "default", uploadStore);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { mimeType: string };
      expect(body.mimeType).toBe("application/octet-stream");
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

  test("rejects the active-content set (.js/.mjs/.cjs/.xhtml/.htm/.xml/.css/.shtml)", async () => {
    for (const [name, mime] of [
      ["script.js", "text/javascript"],
      ["mod.mjs", "text/javascript"],
      ["mod.cjs", "text/javascript"],
      ["page.xhtml", "application/xhtml+xml"],
      ["page.xht", "application/xhtml+xml"],
      ["page.htm", "text/html"],
      ["page.shtml", "text/html"],
      ["feed.xml", "application/xml"],
      ["style.css", "text/css"],
    ] as const) {
      const res = await handleStorage(uploadRequest(name, mime), "/upload", "default", uploadStore);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("not allowed");
    }
  });

  test("trailing-dot / trailing-space can't slip a blocked type past the guard", async () => {
    // extname("evil.html.") === "." — normalize the trailing run first.
    for (const name of ["evil.html.", "evil.svg ", "evil.js."] as const) {
      const res = await handleStorage(uploadRequest(name, "text/plain"), "/upload", "default", uploadStore);
      expect(res.status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// vault#588 FIX 1 — a malformed/non-multipart POST /upload body used to
// throw uncaught out of `req.formData()`, escaping to server.ts's generic
// top-level catch: a 500 with no `error_type`. Same class LB7 (vault.test.ts)
// fixed for `req.json()` on the JSON-bodied mutating routes, applied to the
// multipart transport. Every assertion here MUST fail without the fix.
// ---------------------------------------------------------------------------
describe("storage upload — malformed multipart body (vault#588 FIX 1)", () => {
  test("garbage body + a multipart Content-Type header -> 400 invalid_request, not 500", async () => {
    const req = new Request("http://localhost:1940/storage/upload", {
      method: "POST",
      body: "not a valid multipart body at all",
      headers: { "Content-Type": "multipart/form-data; boundary=----doesNotMatchBody" },
    });
    const res = await handleStorage(req, "/upload", "default", uploadStore);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_type: string };
    expect(body.error_type).toBe("invalid_request");
  });

  test("plain-text body with no multipart Content-Type at all -> 400 invalid_request, not 500", async () => {
    const req = new Request("http://localhost:1940/storage/upload", {
      method: "POST",
      body: "just some text, not multipart",
      headers: { "Content-Type": "text/plain" },
    });
    const res = await handleStorage(req, "/upload", "default", uploadStore);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_type: string };
    expect(body.error_type).toBe("invalid_request");
  });

  test("empty body -> 400 invalid_request, not 500", async () => {
    const req = new Request("http://localhost:1940/storage/upload", {
      method: "POST",
      body: "",
      headers: { "Content-Type": "multipart/form-data; boundary=----empty" },
    });
    const res = await handleStorage(req, "/upload", "default", uploadStore);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_type: string };
    expect(body.error_type).toBe("invalid_request");
  });

  test("well-formed multipart form MISSING the `file` field -> 400 missing_required_field (unchanged, not a TypeError)", async () => {
    const form = new FormData();
    form.set("not_file", "some value");
    const req = new Request("http://localhost:1940/storage/upload", { method: "POST", body: form });
    const res = await handleStorage(req, "/upload", "default", uploadStore);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_type: string; field: string };
    expect(body.error_type).toBe("missing_required_field");
    expect(body.field).toBe("file");
  });

  test("a well-formed upload still succeeds (regression — the catch doesn't swallow the happy path)", async () => {
    const res = await handleStorage(uploadRequest("still-works.pdf", "application/pdf"), "/upload", "default", uploadStore);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mimeType: string };
    expect(body.mimeType).toBe("application/pdf");
  });
});

// ---------------------------------------------------------------------------
// vault#588 FIX 2 — explicit Bun.serve `maxRequestBodySize` transport ceiling.
// The JSON-body cap (MAX_JSON_BODY_BYTES) only gates AFTER the transport
// already buffered the body when Content-Length is absent (chunked
// requests); before this fix, the only backstop was Bun's unconfigured
// default (128MB). MAX_REQUEST_BODY_BYTES must sit >= MAX_UPLOAD_BYTES (the
// /upload app-level cap) with headroom, or a legitimate max-size attachment
// upload would be rejected at the transport layer before /upload's own
// 100MB check ever runs. These pin the reconciliation and the wiring;
// see routes.ts's MAX_REQUEST_BODY_BYTES doc comment for the full rationale.
// ---------------------------------------------------------------------------
describe("transport-level request-body ceiling (vault#588 FIX 2)", () => {
  test("MAX_REQUEST_BODY_BYTES is comfortably >= MAX_UPLOAD_BYTES (never caps a legitimate attachment below its own app-level limit)", () => {
    expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThanOrEqual(MAX_UPLOAD_BYTES);
    // Pin the chosen ceiling (100MB upload cap + 20MB multipart-overhead
    // headroom = 120MB) so a future edit that silently narrows it fails loudly.
    expect(MAX_REQUEST_BODY_BYTES).toBe(120 * 1024 * 1024);
  });

  test("server.ts wires maxRequestBodySize to MAX_REQUEST_BODY_BYTES on the Bun.serve config", () => {
    // A config-level assertion (per vault#588's own guidance — a real
    // >MAX_REQUEST_BODY_BYTES streaming test isn't worth the fixture cost).
    // server.ts's `Bun.serve({...})` is a module-level side effect (it boots
    // the real listener on import), so we can't import it in-test; read the
    // source instead to confirm the constant is actually wired in, not just
    // defined and forgotten.
    const serverSrc = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    expect(serverSrc).toMatch(/import\s*\{[^}]*MAX_REQUEST_BODY_BYTES[^}]*\}\s*from\s*"\.\/routes\.ts"/);
    expect(serverSrc).toMatch(/maxRequestBodySize:\s*MAX_REQUEST_BODY_BYTES/);
  });

  test("a legitimate upload at exactly MAX_UPLOAD_BYTES still succeeds (not capped below its own limit)", async () => {
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES);
    const file = new File([bytes], "max-size.bin", { type: "application/octet-stream" });
    const form = new FormData();
    form.set("file", file);
    const req = new Request("http://localhost:1940/storage/upload", { method: "POST", body: form });
    const res = await handleStorage(req, "/upload", "default", uploadStore);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { size: number };
    expect(body.size).toBe(MAX_UPLOAD_BYTES);
  });

  test("one byte over MAX_UPLOAD_BYTES still rejects at the app-level gate (413 file_too_large, unaffected by the transport ceiling)", async () => {
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    const file = new File([bytes], "over-size.bin", { type: "application/octet-stream" });
    const form = new FormData();
    form.set("file", file);
    const req = new Request("http://localhost:1940/storage/upload", { method: "POST", body: form });
    const res = await handleStorage(req, "/upload", "default", uploadStore);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error_type: string };
    expect(body.error_type).toBe("file_too_large");
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

// ---------------------------------------------------------------------------
// REST Range (206) — vault attachments-for-agents design D9, the REST twin
// of MCP's content_offset/content_length.
// ---------------------------------------------------------------------------

describe("parseByteRangeHeader", () => {
  test("no header → null (full response)", () => {
    expect(parseByteRangeHeader(null, 100)).toBeNull();
  });

  test("bytes=0-99 on a 100-byte file → the whole file as one satisfiable range", () => {
    expect(parseByteRangeHeader("bytes=0-99", 100)).toEqual({ start: 0, end: 99 });
  });

  test("bytes=10-19 → an inclusive mid-file window", () => {
    expect(parseByteRangeHeader("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
  });

  test("bytes=90- (open-ended) → reads to EOF", () => {
    expect(parseByteRangeHeader("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
  });

  test("bytes=-10 (suffix range) → the last 10 bytes", () => {
    expect(parseByteRangeHeader("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  });

  test("bytes=-1000 (suffix longer than the file) → clamps to the whole file", () => {
    expect(parseByteRangeHeader("bytes=-1000", 100)).toEqual({ start: 0, end: 99 });
  });

  test("bytes=50-1000 (end past EOF) → clamps end to the last byte", () => {
    expect(parseByteRangeHeader("bytes=50-1000", 100)).toEqual({ start: 50, end: 99 });
  });

  test("start past EOF → null (this function's own contract; a real Bun.serve() socket overrides with a native 416 — see doc comment)", () => {
    expect(parseByteRangeHeader("bytes=100-200", 100)).toBeNull();
    expect(parseByteRangeHeader("bytes=1000-", 100)).toBeNull();
  });

  test("start > end → null (malformed)", () => {
    expect(parseByteRangeHeader("bytes=50-10", 100)).toBeNull();
  });

  test("bytes=- (both empty) → null", () => {
    expect(parseByteRangeHeader("bytes=-", 100)).toBeNull();
  });

  test("a multi-range list (bytes=0-10,20-30) → null (ignored per D9, not an error)", () => {
    expect(parseByteRangeHeader("bytes=0-10,20-30", 100)).toBeNull();
  });

  test("an unrecognized unit → null", () => {
    expect(parseByteRangeHeader("items=0-10", 100)).toBeNull();
  });

  test("garbage value → null, not a throw", () => {
    expect(parseByteRangeHeader("bytes=abc-def", 100)).toBeNull();
    expect(parseByteRangeHeader("nonsense", 100)).toBeNull();
  });

  test("a zero-byte file → null regardless of header (nothing to range over)", () => {
    expect(parseByteRangeHeader("bytes=0-0", 0)).toBeNull();
  });
});

describe("storage GET Range support (vault attachments-for-agents design D9)", () => {
  const VAULT = "range-vault";
  // 26 bytes, byte-identical to its own index — content[i] === i (0x00..0x19)
  // — so any slice's bytes can be asserted exactly by index, not just length.
  const CONTENT = Buffer.from(Array.from({ length: 26 }, (_, i) => i));

  async function setup(): Promise<{ store: SqliteStore; assets: string; relPath: string }> {
    const store = freshStore();
    const assets = join(testDir, "assets", VAULT, "data");
    mkdirSync(join(assets, "2026-05-28"), { recursive: true });
    process.env.ASSETS_DIR = assets;

    const relPath = "2026-05-28/ranged.bin";
    writeFileSync(join(assets, relPath), CONTENT);
    const note = await store.createNote("range note", { tags: ["misc"] });
    await store.addAttachment(note.id, relPath, "application/octet-stream");

    return { store, assets, relPath };
  }

  function getReq(reqPath: string, range?: string): Request {
    const headers: Record<string, string> = {};
    if (range !== undefined) headers.range = range;
    return new Request(`http://localhost:1940/storage/${reqPath}`, { method: "GET", headers });
  }

  test("no Range header → 200, full body, Accept-Ranges advertised", async () => {
    const { store, relPath } = await setup();
    const res = await handleStorage(getReq(relPath), `/${relPath}`, VAULT, store);
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("26");
    expect(res.headers.has("Content-Range")).toBe(false);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(CONTENT)).toBe(true);
  });

  test("Range: bytes=0-9 → 206, first 10 bytes, correct Content-Range", async () => {
    const { store, relPath } = await setup();
    const res = await handleStorage(getReq(relPath, "bytes=0-9"), `/${relPath}`, VAULT, store);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-9/26");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(CONTENT.subarray(0, 10))).toBe(true);
  });

  test("Range: bytes=16-25 (to EOF) → 206, correct tail bytes", async () => {
    const { store, relPath } = await setup();
    const res = await handleStorage(getReq(relPath, "bytes=16-25"), `/${relPath}`, VAULT, store);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 16-25/26");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(CONTENT.subarray(16, 26))).toBe(true);
  });

  test("Range: bytes=-5 (suffix) → 206, last 5 bytes", async () => {
    const { store, relPath } = await setup();
    const res = await handleStorage(getReq(relPath, "bytes=-5"), `/${relPath}`, VAULT, store);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 21-25/26");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(CONTENT.subarray(21, 26))).toBe(true);
  });

  test("paging the whole file via sequential ranges reassembles byte-identical content", async () => {
    const { store, relPath } = await setup();
    const chunkSize = 7; // doesn't divide 26 evenly — exercises a short final chunk
    const chunks: Buffer[] = [];
    for (let start = 0; start < 26; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, 25);
      const res = await handleStorage(getReq(relPath, `bytes=${start}-${end}`), `/${relPath}`, VAULT, store);
      expect(res.status).toBe(206);
      chunks.push(Buffer.from(await res.arrayBuffer()));
    }
    expect(Buffer.concat(chunks).equals(CONTENT)).toBe(true);
  });

  test("a malformed Range header → 200 full response, not an error (D9: ignore, don't fail)", async () => {
    const { store, relPath } = await setup();
    const res = await handleStorage(getReq(relPath, "not-a-range"), `/${relPath}`, VAULT, store);
    expect(res.status).toBe(200);
    expect(res.headers.has("Content-Range")).toBe(false);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(CONTENT)).toBe(true);
  });

  test("a multi-range Range header → 200 full response (multipart ranges unsupported, ignored per D9)", async () => {
    const { store, relPath } = await setup();
    const res = await handleStorage(getReq(relPath, "bytes=0-5,10-15"), `/${relPath}`, VAULT, store);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(CONTENT)).toBe(true);
  });

  test("an unsatisfiable Range (start past EOF) → handleStorage's OWN logic returns 200 (parseByteRangeHeader's null contract)", async () => {
    // IMPORTANT — this is NOT the whole live story. `handleStorage` is
    // called here directly, in-process, so this only exercises OUR
    // fallback logic (parseByteRangeHeader → null → the unranged 200
    // branch). Live-verified against a real `Bun.serve()` socket (not
    // this harness): Bun's own runtime independently reinterprets the
    // incoming `Range` header on a `Bun.file()`-backed response body and
    // overrides an out-of-bounds range with a native
    // **416 Range Not Satisfiable** — RFC 7233-correct, and kept, not
    // fought. This in-process harness has no socket for Bun's native
    // layer to intercept, so it can only ever observe the 200 our own
    // code returns — see `parseByteRangeHeader`'s doc comment
    // (`src/routes.ts`) for the full explanation.
    const { store, relPath } = await setup();
    const res = await handleStorage(getReq(relPath, "bytes=1000-2000"), `/${relPath}`, VAULT, store);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(CONTENT)).toBe(true);
  });

  test("Range is still honored for a tag-scoped in-scope request (206)", async () => {
    const { store, relPath } = await setup();
    const ctx = await tagScopeCtx(store, ["misc"]);
    const res = await handleStorage(getReq(relPath, "bytes=0-3"), `/${relPath}`, VAULT, store, ctx);
    expect(res.status).toBe(206);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(CONTENT.subarray(0, 4))).toBe(true);
  });

  test("Range on an out-of-scope attachment still 404s (same confinement guard, byte-identical to the non-ranged path)", async () => {
    const { store, relPath } = await setup();
    const ctx = await tagScopeCtx(store, ["totally-unrelated-tag"]);
    const res = await handleStorage(getReq(relPath, "bytes=0-3"), `/${relPath}`, VAULT, store, ctx);
    expect(res.status).toBe(404);
  });
});
