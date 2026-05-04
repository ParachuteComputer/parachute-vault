/**
 * Admin SPA mount. Serves `web/ui/dist/` under `/vault/<name>/admin/*`.
 *
 * The vault HTTP server hosts an admin SPA (vault#216) co-located in the
 * source tree at `web/ui/`. Vite produces the bundle in `web/ui/dist/`
 * (gitignored — built locally before publish, or by a release pipeline).
 * This module turns the bundle into a static-file response.
 *
 * Per-vault mount (vault#252): the SPA lives under `/vault/<name>/admin/*`
 * rather than the origin-rooted `/admin/*` it shipped with. The hub only
 * proxies `/vault/<name>/*` paths (per parachute-patterns/module-protocol),
 * so an origin-rooted SPA is unreachable through the hub. Asset URLs are
 * relative (Vite `base: "./"`), so the same bundle works at any mount
 * point — no rebuild per vault.
 *
 * Mirrors `parachute-hub/src/hub-server.ts:serveSpa` — the conventions
 * (strip mount, asset-shape filter, `.html` fallthrough for client routes)
 * are identical so an operator who knows one knows the other.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regex anchoring the per-vault SPA mount. Matches `/vault/<name>/admin`
 * exactly and any subpath under it. The `<name>` capture is reused by the
 * prefix-strip below — keep the two in sync if this regex moves.
 */
const ADMIN_SPA_MOUNT_RE = /^\/vault\/([^/]+)\/admin(?=\/|$)/;

/**
 * Resolve the default SPA bundle dir. Anchored to this file's location so
 * a `bun src/server.ts` from any cwd still finds `<repo>/web/ui/dist/`.
 * Tests / production override via the `spaDistDir` argument to
 * `serveAdminSpa`.
 */
export function defaultAdminSpaDistDir(): string {
  // import.meta.dir is the dir holding *this* file (`src/`); the SPA bundle
  // sits at `<repo>/web/ui/dist/`.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "web", "ui", "dist");
}

/**
 * Pick a content type for static assets the SPA build produces. Vite's
 * fingerprinted output is the realistic surface — js / css / svg / png /
 * woff2 / ico. Mismatches show up loud (a `.js` served as `text/html` is
 * unmistakable) and the list is trivially extensible if a future feature
 * adds an asset type.
 */
function spaContentType(pathname: string): string {
  const ext = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "ico":
      return "image/x-icon";
    case "woff2":
      return "font/woff2";
    case "woff":
      return "font/woff";
    case "json":
    case "map":
      return "application/json";
    case "txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Serve a single file under the SPA mount, falling back to `index.html`
 * for client-side-routed paths (anything that doesn't resolve to a real
 * file under `dist/`). Path-traversal is blocked twice: the asset-shape
 * filter rejects sub-paths containing "..", and the resolved absolute
 * path is checked to start with `dist/` before any read.
 *
 * No auth is enforced at this seam — the SPA's `index.html` and bundle are
 * static assets and reveal nothing privileged. The data fetches the SPA
 * issues land on existing per-vault routes that already enforce
 * `vault:<name>:read` / `vault:<name>:admin`. This keeps the SPA loadable
 * even before a token has been minted (so the operator can actually see
 * the empty / auth-required state we render in `VaultDetail.tsx`).
 */
export async function serveAdminSpa(spaDistDir: string, pathname: string): Promise<Response> {
  if (!existsSync(spaDistDir)) {
    return new Response(
      "vault admin SPA bundle not found — run `bun run build` in web/ui/ to produce dist/",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  // Strip the mount prefix:
  //   /vault/foo/admin       → ""
  //   /vault/foo/admin/      → "/"
  //   /vault/foo/admin/x.js  → "/x.js"
  const sub = pathname.replace(ADMIN_SPA_MOUNT_RE, "");

  // Canonicalize the bare mount → trailing-slash form. Vite emits
  // *relative* asset URLs (`./assets/index-abc.js`) since `<name>` isn't
  // known at build time, and browsers resolve relative URLs against the
  // **directory** of the current document — not the document itself. So:
  //   /vault/foo/admin/  → asset resolves to /vault/foo/admin/assets/...  ✓
  //   /vault/foo/admin   → asset resolves to /vault/foo/assets/...        ✗
  // Without this redirect, the bare-form URL hub#162 generates (per
  // `resolveManagementUrl` — strip trailing slash, append `/admin`)
  // would 404 every asset against the per-vault auth wall, and the SPA
  // would never boot. Same canonicalization the notes-server `--mount`
  // path does for the same reason.
  if (sub === "") {
    return Response.redirect(`${pathname}/`, 301);
  }
  const indexPath = join(spaDistDir, "index.html");

  // Empty / mount-root / any non-asset request → SPA shell. The router
  // takes it from there. First defense against traversal: bare paths and
  // anything containing ".." never enter the asset branch — they fall
  // through to the shell below.
  const looksLikeAsset = sub.length > 0 && /\.[a-z0-9]+$/i.test(sub) && !sub.includes("..");
  if (!looksLikeAsset) {
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const filePath = resolve(spaDistDir, `.${sub}`);
  // Second defense: even if a future tweak loosens looksLikeAsset, refuse
  // any resolved path that escapes dist/. Belt-and-braces.
  if (!filePath.startsWith(`${spaDistDir}/`)) {
    return new Response("not found", { status: 404 });
  }
  if (!existsSync(filePath)) {
    // Asset request that doesn't resolve to a real file → SPA shell.
    // (e.g. `/admin/vault/foo` with a typo'd extension shouldn't 404 the
    // page.)
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response(Bun.file(filePath), {
    headers: { "content-type": spaContentType(filePath) },
  });
}

/**
 * Match `/vault/<name>/admin` or `/vault/<name>/admin/...`. Bare
 * `/vault/<name>/admin-foo` and `/vault/<name>` (the metadata endpoint)
 * must NOT trigger this — only the SPA mount root and its true subpaths.
 */
export function isAdminSpaPath(pathname: string): boolean {
  return ADMIN_SPA_MOUNT_RE.test(pathname);
}
