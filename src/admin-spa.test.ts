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
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isAdminSpaPath, serveAdminSpa, ADMIN_SPA_MOUNT } from "./admin-spa.ts";

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
  test("matches /admin and /admin/...", () => {
    expect(isAdminSpaPath("/admin")).toBe(true);
    expect(isAdminSpaPath("/admin/")).toBe(true);
    expect(isAdminSpaPath("/admin/vault/foo")).toBe(true);
    expect(isAdminSpaPath("/admin/assets/index.js")).toBe(true);
  });

  test("does not match /administrative or /admin-foo", () => {
    expect(isAdminSpaPath("/administrative")).toBe(false);
    expect(isAdminSpaPath("/admin-foo")).toBe(false);
    expect(isAdminSpaPath("/adminx")).toBe(false);
  });

  test("does not match unrelated paths", () => {
    expect(isAdminSpaPath("/")).toBe(false);
    expect(isAdminSpaPath("/vault/work")).toBe(false);
    expect(isAdminSpaPath("/vaults")).toBe(false);
  });

  test("export of mount constant is /admin", () => {
    expect(ADMIN_SPA_MOUNT).toBe("/admin");
  });
});

describe("serveAdminSpa", () => {
  test("503 when the dist dir is absent (unbuilt)", async () => {
    const res = await serveAdminSpa("/nonexistent/dist/dir", "/admin/");
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("not found");
    expect(body).toContain("bun run build");
  });

  test("/admin returns the SPA index", async () => {
    const res = await serveAdminSpa(fixtureDir, "/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("shell");
  });

  test("/admin/ returns the SPA index", async () => {
    const res = await serveAdminSpa(fixtureDir, "/admin/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("client-routed path (no extension) falls through to index.html", async () => {
    const res = await serveAdminSpa(fixtureDir, "/admin/vault/work");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("shell");
  });

  test("real asset path returns the asset with the right content-type", async () => {
    const jsRes = await serveAdminSpa(fixtureDir, "/admin/assets/index-abc.js");
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("application/javascript");
    expect(await jsRes.text()).toContain("console.log");

    const cssRes = await serveAdminSpa(fixtureDir, "/admin/assets/index-abc.css");
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");
  });

  test("typo'd asset path falls through to index.html (not a 404)", async () => {
    const res = await serveAdminSpa(fixtureDir, "/admin/assets/missing-xyz.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("path traversal (..) cannot escape dist dir", async () => {
    // Triggers the asset-shape filter (.. is rejected) so this falls through
    // to the SPA shell rather than reading something outside dist/.
    const res = await serveAdminSpa(fixtureDir, "/admin/../../etc/passwd");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("shell");
    expect(body).not.toContain("root:");
  });
});
