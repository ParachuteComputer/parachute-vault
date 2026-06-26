/**
 * Tests for the admin SPA static-file mount (`src/admin-spa.ts`).
 *
 * The routing layer's responsibility is just "dispatch /admin/* to the SPA";
 * this file tests the SPA-serving behavior itself with a tmp dist dir so
 * the assertions don't depend on `bun run build` having been run in
 * `web/ui/`. The integration check (admin path → SPA dispatch) lives in
 * `routing.test.ts`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  isAdminSpaPath,
  isDaemonAdminSpaPath,
  serveAdminSpa,
  serveDaemonAdminSpa,
} from "./admin-spa.ts";

const fixtureDir = join(tmpdir(), `vault-admin-spa-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
  mkdirSync(join(fixtureDir, "assets"), { recursive: true });
  writeFileSync(join(fixtureDir, "index.html"), "<!doctype html><html><body>shell</body></html>");
  writeFileSync(join(fixtureDir, "assets", "index-abc.js"), "console.log('bundle');");
  writeFileSync(join(fixtureDir, "assets", "index-abc.css"), "body { color: red; }");
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("isAdminSpaPath", () => {
  test("matches /vault/<name>/admin and /vault/<name>/admin/...", () => {
    expect(isAdminSpaPath("/vault/work/admin")).toBe(true);
    expect(isAdminSpaPath("/vault/work/admin/")).toBe(true);
    expect(isAdminSpaPath("/vault/work/admin/tokens")).toBe(true);
    expect(isAdminSpaPath("/vault/boulder/admin/assets/index.js")).toBe(true);
    // Canonical-charset names (lowercase alphanumerics + hyphen / underscore)
    // match; dots are NOT canonical (see the vault#253 reject test below).
    expect(isAdminSpaPath("/vault/my-vault_2/admin")).toBe(true);
  });

  test("vault#253: names outside the canonical charset do NOT match the mount", () => {
    // The mount used to capture `[^/]+`, so a name hub can never manage
    // (dots, @, unicode) still served the admin SPA. Aligning the mount to
    // hub's VAULT_NAME_CHARSET_RE (`/^[a-z0-9_-]+$/`) makes a non-canonical
    // name 404 — the same answer hub gives. No legitimately-created vault can
    // carry these characters (cmdCreate / init / the env var all reject them
    // via validateVaultName), so nothing reachable regresses.
    expect(isAdminSpaPath("/vault/my.vault/admin")).toBe(false);
    expect(isAdminSpaPath("/vault/vault@v2/admin")).toBe(false);
    expect(isAdminSpaPath("/vault/Work/admin")).toBe(false); // uppercase isn't canonical
    expect(isAdminSpaPath("/vault/🦑/admin")).toBe(false);
  });

  test("does not match adjacent paths under the same vault", () => {
    expect(isAdminSpaPath("/vault/work")).toBe(false);
    expect(isAdminSpaPath("/vault/work/")).toBe(false);
    expect(isAdminSpaPath("/vault/work/api/notes")).toBe(false);
    expect(isAdminSpaPath("/vault/work/tokens")).toBe(false);
    // Bare `admin-foo` suffix must not trigger — only the SPA mount itself.
    expect(isAdminSpaPath("/vault/work/admin-foo")).toBe(false);
    expect(isAdminSpaPath("/vault/work/administrative")).toBe(false);
  });

  test("does not match origin-rooted /admin (legacy mount retired)", () => {
    expect(isAdminSpaPath("/admin")).toBe(false);
    expect(isAdminSpaPath("/admin/")).toBe(false);
    expect(isAdminSpaPath("/admin/tokens")).toBe(false);
  });

  test("does not match unrelated paths", () => {
    expect(isAdminSpaPath("/")).toBe(false);
    expect(isAdminSpaPath("/vaults")).toBe(false);
    expect(isAdminSpaPath("/auth/status")).toBe(false);
  });
});

describe("serveAdminSpa", () => {
  test("503 when the dist dir is absent (unbuilt)", async () => {
    const res = await serveAdminSpa("/nonexistent/dist/dir", "/vault/work/admin/");
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("not found");
    expect(body).toContain("bun run build");
  });

  test("bare /vault/<name>/admin redirects to trailing-slash form (301)", async () => {
    // Vite's relative asset URLs (./assets/...) resolve against the
    // *directory* of the current document — without a trailing slash,
    // /vault/foo/admin's directory is /vault/foo/ and assets 404 against
    // the per-vault auth wall. Hub's resolveManagementUrl generates the
    // bare form, so this redirect is the load-bearing canonicalization.
    const res = await serveAdminSpa(fixtureDir, "/vault/work/admin");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/vault/work/admin/");
  });

  test("/vault/<name>/admin/ returns the SPA index", async () => {
    const res = await serveAdminSpa(fixtureDir, "/vault/work/admin/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("shell");
  });

  test("client-routed path (no extension) falls through to index.html", async () => {
    const res = await serveAdminSpa(fixtureDir, "/vault/work/admin/tokens");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("shell");
  });

  test("real asset path returns the asset with the right content-type", async () => {
    const jsRes = await serveAdminSpa(fixtureDir, "/vault/work/admin/assets/index-abc.js");
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("application/javascript");
    expect(await jsRes.text()).toContain("console.log");

    const cssRes = await serveAdminSpa(fixtureDir, "/vault/work/admin/assets/index-abc.css");
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");
  });

  test("canonical-charset vault names strip cleanly", async () => {
    const res = await serveAdminSpa(fixtureDir, "/vault/my-vault_2/admin/assets/index-abc.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
  });

  test("typo'd asset path falls through to index.html (not a 404)", async () => {
    const res = await serveAdminSpa(fixtureDir, "/vault/work/admin/assets/missing-xyz.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("path traversal (..) cannot escape dist dir", async () => {
    // Triggers the asset-shape filter (.. is rejected) so this falls through
    // to the SPA shell rather than reading something outside dist/.
    const res = await serveAdminSpa(fixtureDir, "/vault/work/admin/../../etc/passwd");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("shell");
    expect(body).not.toContain("root:");
  });
});

describe("isDaemonAdminSpaPath", () => {
  test("matches /vault/admin and true subpaths", () => {
    expect(isDaemonAdminSpaPath("/vault/admin")).toBe(true);
    expect(isDaemonAdminSpaPath("/vault/admin/")).toBe(true);
    expect(isDaemonAdminSpaPath("/vault/admin/assets/index.js")).toBe(true);
    // The doubled path the per-vault regex would mis-read as vault "admin".
    expect(isDaemonAdminSpaPath("/vault/admin/admin")).toBe(true);
  });

  test("does not match vaults whose name merely starts with 'admin'", () => {
    expect(isDaemonAdminSpaPath("/vault/adminx")).toBe(false);
    expect(isDaemonAdminSpaPath("/vault/admin2/admin")).toBe(false);
    expect(isDaemonAdminSpaPath("/vault/admin-foo")).toBe(false);
  });

  test("does not match per-vault mounts or unrelated paths", () => {
    expect(isDaemonAdminSpaPath("/vault/work/admin")).toBe(false);
    expect(isDaemonAdminSpaPath("/admin")).toBe(false);
    expect(isDaemonAdminSpaPath("/vaults")).toBe(false);
  });
});

describe("serveDaemonAdminSpa (the /vault/admin multi-vault mount)", () => {
  test("bare /vault/admin redirects to trailing-slash form (301)", async () => {
    // Same load-bearing canonicalization as the per-vault mount: Vite's
    // relative asset URLs (./assets/...) resolve against the document's
    // DIRECTORY, so /vault/admin (bare) would resolve assets to
    // /vault/assets/... and 404 them.
    const res = await serveDaemonAdminSpa(fixtureDir, "/vault/admin");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/vault/admin/");
  });

  test("/vault/admin/ returns the SPA index", async () => {
    const res = await serveDaemonAdminSpa(fixtureDir, "/vault/admin/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("shell");
  });

  test("daemon-mount asset path strips cleanly", async () => {
    const res = await serveDaemonAdminSpa(fixtureDir, "/vault/admin/assets/index-abc.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
  });

  test("/vault/admin/admin serves the shell (client route, not a per-vault boot)", async () => {
    const res = await serveDaemonAdminSpa(fixtureDir, "/vault/admin/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("shell");
  });

  test("path traversal (..) cannot escape dist dir on the daemon mount", async () => {
    const res = await serveDaemonAdminSpa(fixtureDir, "/vault/admin/../../etc/passwd");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("shell");
  });
});

describe("hub <-> vault managementUrl contract", () => {
  // Browsers drop the URL fragment when following a 301 (RFC 7231 SHOULD
  // preserve, but Chrome/Firefox/Safari are inconsistent in practice). The
  // hub-issued JWT travels in `#token=...`, so a redirected click loses the
  // token and the SPA boots unauthenticated. Under the B4 URL-resolution
  // semantics (hub#637) a RELATIVE managementUrl is mount-joined per
  // instance (`/vault/<name>` + "/" + "admin/") — if it ends with "/" the
  // canonical click target is `/vault/<name>/admin/` (no redirect, fragment
  // preserved). Without the trailing slash hub emits `/vault/<name>/admin`,
  // the server 301s, and the fragment is gone.
  test("module.json managementUrl ends with '/' so hub emits the no-redirect form", () => {
    const moduleJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", ".parachute", "module.json"), "utf8"),
    );
    expect(moduleJson.managementUrl).toMatch(/\/$/);
  });

  test("managementUrl + uiUrl are RELATIVE (per-instance); configUiUrl is origin-absolute (daemon-level)", () => {
    // B4 semantics (2026-06-09 hub-module-boundary): relative = mount-joined
    // per instance; leading "/" = origin-absolute verbatim. The per-instance
    // surfaces (manage tile, instance UI) stay per-vault; the module-level
    // config UI points at the daemon-level multi-vault home. A leading "/"
    // on managementUrl/uiUrl here would flip every instance tile to the
    // module home; a relative configUiUrl would wrongly mount-join.
    const moduleJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", ".parachute", "module.json"), "utf8"),
    );
    expect(moduleJson.managementUrl).toBe("admin/");
    expect(moduleJson.uiUrl).toBe("admin/");
    expect(moduleJson.configUiUrl).toBe("/vault/admin/");
  });

  test("the canonical hub-emitted per-instance URL serves the SPA shell directly (no 301)", async () => {
    // Mirror hub's per-instance join under B4: mount + "/" + relative
    // managementUrl. With managementUrl="admin/" the result is
    // /vault/<name>/admin/ — which serveAdminSpa returns as 200, not 301.
    const moduleJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", ".parachute", "module.json"), "utf8"),
    );
    const canonical = `/vault/work/${moduleJson.managementUrl}`;
    const res = await serveAdminSpa(fixtureDir, canonical);
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
  });

  test("the canonical configUiUrl serves the daemon-level shell directly (no 301)", async () => {
    const moduleJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", ".parachute", "module.json"), "utf8"),
    );
    const res = await serveDaemonAdminSpa(fixtureDir, moduleJson.configUiUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
  });
});
