/**
 * Tests for `/admin/mirror` route handlers — GET/PUT shapes, validation
 * gates, atomic persist + restart (vault-sync Phase A1).
 *
 * Auth gating happens upstream in `routing.ts`; these tests cover the
 * after-auth handler logic.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultMirrorConfig,
  readMirrorConfigForVault,
  writeMirrorConfigForVault,
  type MirrorConfig,
} from "./mirror-config.ts";
import {
  MirrorManager,
  type MirrorDeps,
} from "./mirror-manager.ts";
import {
  enableSyncToImportedRepo,
  _resetDeviceFlowSessionsForTest,
  handleAuthDelete,
  handleAuthGet,
  handleAuthGithubCreateRepo,
  handleAuthGithubDeviceCode,
  handleAuthGithubInstallations,
  handleAuthGithubPoll,
  handleAuthGithubRepos,
  handleAuthGithubSelectRepo,
  handleAuthPat,
  handleMirrorGet,
  handleMirrorImport,
  handleMirrorImportStatus,
  handleMirrorPushNow,
  handleMirrorPut,
  handleMirrorRunNow,
} from "./mirror-routes.ts";
import {
  _resetImportInFlightForTest,
  type GitSpawn,
} from "./mirror-import.ts";
import { _resetImportJobsForTest, type ImportJob } from "./mirror-import-jobs.ts";
import { writeVaultConfig } from "./config.ts";
import { clearVaultStoreCache } from "./vault-store.ts";
import { exportVaultToDir } from "../core/src/portable-md.ts";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { cpSync, writeFileSync as nodeWriteFileSync } from "node:fs";
import {
  mirrorCredentialsPath,
  readCredentials,
  writeCredentials,
  type MirrorCredentials,
} from "./mirror-credentials.ts";
import type { FetchLike } from "./github-device-flow.ts";

// Same env-restore pattern as mirror-manager.test.ts — keeps HOME +
// PARACHUTE_HOME from leaking between test files.
const ORIG_HOME = process.env.HOME;
const ORIG_PARACHUTE_HOME = process.env.PARACHUTE_HOME;
afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_PARACHUTE_HOME === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = ORIG_PARACHUTE_HOME;
});
afterAll(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "t@p.computer"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "T P"], { cwd: dir });
  Bun.spawnSync(["git", "config", "commit.gpgsign", "false"], { cwd: dir });
}

function makeManager(home: string): {
  manager: MirrorManager;
  deps: MirrorDeps & { storedConfig: MirrorConfig | undefined };
  exportCalls: () => Array<{ outDir: string }>;
} {
  process.env.PARACHUTE_HOME = home;
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
  const state: {
    config: MirrorConfig | undefined;
    calls: Array<{ outDir: string }>;
  } = { config: undefined, calls: [] };
  const deps: MirrorDeps = {
    vaultName: "default",
    runExport: async ({ outDir }) => {
      state.calls.push({ outDir });
      return { notes: 0 };
    },
    firstChangedNoteTitle: async () => "",
    readMirrorConfig: () => state.config,
    writeMirrorConfig: (c) => {
      state.config = c;
    },
  };
  Object.defineProperty(deps, "storedConfig", {
    get: () => state.config,
    enumerable: true,
  });
  const manager = new MirrorManager(deps);
  return {
    manager,
    deps: deps as MirrorDeps & { storedConfig: MirrorConfig | undefined },
    exportCalls: () => state.calls,
  };
}

// ---------------------------------------------------------------------------
// GET /admin/mirror
// ---------------------------------------------------------------------------

describe("handleMirrorGet", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("returns defaults + status when no config has been written", async () => {
    home = tmp("mirror-get-defaults-");
    const { manager } = makeManager(home);
    const res = handleMirrorGet(manager);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: MirrorConfig; status: { enabled: boolean } };
    expect(body.config).toEqual(defaultMirrorConfig());
    expect(body.status.enabled).toBe(false);
  });

  test("after a successful start with enabled config, reports running status", async () => {
    home = tmp("mirror-get-enabled-");
    const { manager, deps } = makeManager(home);
    deps.writeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
      watch: false,
      auto_commit: false,
    });
    await manager.start();
    const res = handleMirrorGet(manager);
    const body = (await res.json()) as {
      config: MirrorConfig;
      status: { enabled: boolean; mirror_path: string | null };
    };
    expect(body.config.enabled).toBe(true);
    expect(body.status.enabled).toBe(true);
    expect(body.status.mirror_path).toContain("mirror");
    await manager.stop();
  });
});

// ---------------------------------------------------------------------------
// PUT /admin/mirror
// ---------------------------------------------------------------------------

describe("handleMirrorPut", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("rejects invalid JSON body with 400", async () => {
    home = tmp("mirror-put-badjson-");
    const { manager } = makeManager(home);
    const req = new Request("http://x/admin/mirror", {
      method: "PUT",
      body: "{not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await handleMirrorPut(req, manager);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid JSON");
  });

  test("rejects shape errors with 400 + field localization", async () => {
    home = tmp("mirror-put-shape-");
    const { manager } = makeManager(home);
    const req = new Request("http://x/admin/mirror", {
      method: "PUT",
      body: JSON.stringify({ location: "moon" }),
    });
    const res = await handleMirrorPut(req, manager);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string; message: string };
    expect(body.field).toBe("location");
    expect(body.message).toContain("location");
  });

  test("rejects external + missing external_path with 400", async () => {
    home = tmp("mirror-put-noext-");
    const { manager } = makeManager(home);
    const req = new Request("http://x/admin/mirror", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, location: "external" }),
    });
    const res = await handleMirrorPut(req, manager);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("external_path");
  });

  test("rejects external + non-existent path with 400 + actionable error", async () => {
    home = tmp("mirror-put-missing-");
    const { manager } = makeManager(home);
    const req = new Request("http://x/admin/mirror", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        location: "external",
        external_path: "/definitely/not/here",
      }),
    });
    const res = await handleMirrorPut(req, manager);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("doesn't exist");
  });

  test("rejects external + non-git directory with 400", async () => {
    home = tmp("mirror-put-nogit-");
    const { manager } = makeManager(home);
    const external = tmp("mirror-put-plain-");
    try {
      const req = new Request("http://x/admin/mirror", {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          location: "external",
          external_path: external,
        }),
      });
      const res = await handleMirrorPut(req, manager);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain("isn't a git repository");
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  test("external + git not installed → 503 git_not_installed + actionable message", async () => {
    // vault#415 nit — handleMirrorPut validates the external path via
    // validateExternalPath, which shells `git`. On a git-less server it must
    // return the friendly 503 (consistent with the import route), not let a
    // raw "Executable not found" crash out. Force the preflight via the
    // whichOverride seam against a REAL git repo so the only failure is the
    // preflight.
    home = tmp("mirror-put-nogit-installed-");
    const { manager } = makeManager(home);
    const external = tmp("mirror-put-nogit-target-");
    initRepo(external);
    try {
      const req = new Request("http://x/admin/mirror", {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          location: "external",
          external_path: external,
        }),
      });
      const res = await handleMirrorPut(req, manager, () => null);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error_type: string; message: string };
      expect(body.error_type).toBe("git_not_installed");
      expect(body.message).toContain("git is required");
      expect(body.message).toContain("dnf install git");
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  test("accepts a valid external config, persists, restarts watch", async () => {
    home = tmp("mirror-put-happy-");
    const external = tmp("mirror-put-ext-");
    initRepo(external);
    fs.writeFileSync(path.join(external, ".gitkeep"), "");
    Bun.spawnSync(["git", "add", "-A"], { cwd: external });
    Bun.spawnSync(["git", "commit", "-q", "-m", "i"], { cwd: external });
    try {
      const { manager, deps, exportCalls } = makeManager(home);
      const req = new Request("http://x/admin/mirror", {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          location: "external",
          external_path: external,
          watch: false,
          auto_commit: false,
        }),
      });
      const res = await handleMirrorPut(req, manager);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { config: MirrorConfig; status: { enabled: boolean; mirror_path: string } };
      expect(body.config.enabled).toBe(true);
      expect(body.status.enabled).toBe(true);
      expect(body.status.mirror_path).toBe(external);
      // Persisted via writeMirrorConfig.
      expect(deps.storedConfig?.external_path).toBe(external);
      // Initial export ran into the new path.
      expect(exportCalls()).toHaveLength(1);
      expect(exportCalls()[0]!.outDir).toBe(external);
      await manager.stop();
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  test("accepts disable-only PUT even when external_path no longer valid", async () => {
    home = tmp("mirror-put-disable-");
    const { manager } = makeManager(home);
    const req = new Request("http://x/admin/mirror", {
      method: "PUT",
      body: JSON.stringify({
        enabled: false,
        location: "external",
        external_path: "/this/path/is/gone",
      }),
    });
    const res = await handleMirrorPut(req, manager);
    // enabled:false skips the filesystem check.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: MirrorConfig; status: { enabled: boolean } };
    expect(body.status.enabled).toBe(false);
    expect(body.config.external_path).toBe("/this/path/is/gone");
    await manager.stop();
  });

  test("accepts disable-only PUT with external location and no external_path at all", async () => {
    // Reviewer-flagged regression: previously `validateMirrorConfigShape`
    // ran the cross-field "external requires external_path" rule
    // unconditionally, so `{enabled: false, location: "external"}` (no
    // path) returned 400. The rule now gates on `enabled`, matching
    // the disable-should-never-fail-on-path-issues intent of the
    // route-layer filesystem check skip.
    home = tmp("mirror-put-disable-nopath-");
    const { manager } = makeManager(home);
    const req = new Request("http://x/admin/mirror", {
      method: "PUT",
      body: JSON.stringify({
        enabled: false,
        location: "external",
        // no external_path
      }),
    });
    const res = await handleMirrorPut(req, manager);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: MirrorConfig; status: { enabled: boolean } };
    expect(body.status.enabled).toBe(false);
    expect(body.config.external_path).toBeNull();
    await manager.stop();
  });

  test("PUT restarts event-driven mirror lifecycle", async () => {
    home = tmp("mirror-put-restart-");
    const { manager } = makeManager(home);
    // Enable with events sync_mode.
    const req1 = new Request("http://x/admin/mirror", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        location: "internal",
        sync_mode: "events",
        auto_commit: false,
        safety_net_seconds: 60,
      }),
    });
    const res1 = await handleMirrorPut(req1, manager);
    expect(res1.status).toBe(200);
    expect(manager.getStatus().watch_running).toBe(true);

    // Disable.
    const req2 = new Request("http://x/admin/mirror", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    const res2 = await handleMirrorPut(req2, manager);
    expect(res2.status).toBe(200);
    expect(manager.getStatus().watch_running).toBe(false);
    await manager.stop();
  });

  test("two PUTs fired in quick succession both apply; manager ends in the second config's state", async () => {
    // Reviewer concern: a second PUT entering `reload()` while the
    // first PUT's `stop()` is still inside its 250ms in-flight settle
    // window could theoretically race the `stopping` flag. JS's
    // microtask-serialized awaits make this safe in practice — each
    // PUT's reload→start chain runs to completion on its own tick
    // before the next runs — but pinning the expected outcome with a
    // test documents the behavior + catches a regression if the
    // serialization ever relaxes.
    //
    // What we assert:
    //   - Both PUTs return 200 (no crash, no stuck-in-flight).
    //   - After both resolve, the manager is in the SECOND config's
    //     shape (last-writer-wins; not a stale first-config state
    //     leaking through).
    home = tmp("mirror-put-concurrent-");
    const { manager } = makeManager(home);
    const put = (body: Record<string, unknown>) =>
      handleMirrorPut(
        new Request("http://x/admin/mirror", {
          method: "PUT",
          body: JSON.stringify(body),
        }),
        manager,
      );
    const [res1, res2] = await Promise.all([
      put({
        enabled: true,
        location: "internal",
        sync_mode: "events",
        auto_commit: false,
        safety_net_seconds: 60,
      }),
      put({
        enabled: true,
        location: "internal",
        sync_mode: "events",
        auto_commit: false,
        safety_net_seconds: 120,
      }),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Both PUTs read the same config-storage seam (deps.writeMirrorConfig)
    // and serialize through the manager's async start() under the
    // microtask queue. Final config reflects whichever PUT entered
    // `reload()` last — practically the second one — but the salient
    // assertion is "the manager isn't stuck": enabled + watch_running.
    const status = manager.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.watch_running).toBe(true);
    expect(manager.getConfig().safety_net_seconds).toBe(120);
    await manager.stop();
  });
});

// ---------------------------------------------------------------------------
// POST /.parachute/mirror/run-now
// ---------------------------------------------------------------------------

describe("handleMirrorRunNow", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("returns 400 when mirror is disabled (avoids stale-status no-op)", async () => {
    home = tmp("mirror-runnow-disabled-");
    const { manager, exportCalls } = makeManager(home);
    const res = await handleMirrorRunNow(manager);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toContain("not enabled");
    // The disabled-guard short-circuits BEFORE manager.runNow(), so no
    // export attempt happens — pinning this distinguishes the guard from
    // a "200 with stale status" pass-through that would have looked
    // identical to the operator.
    expect(exportCalls()).toHaveLength(0);
  });

  test("fires an export pass and returns the updated config+status on success", async () => {
    home = tmp("mirror-runnow-happy-");
    const { manager, deps, exportCalls } = makeManager(home);
    deps.writeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
      watch: false,
      auto_commit: false,
    });
    await manager.start();
    // The initial export from start() already ran once. We pin the
    // delta — run-now must trigger a SECOND export pass and the
    // response must carry the updated status.
    const exportsBefore = exportCalls().length;
    const res = await handleMirrorRunNow(manager);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: MirrorConfig;
      status: { enabled: boolean; last_export_at: string | null; mirror_path: string };
    };
    expect(body.config.enabled).toBe(true);
    expect(body.status.enabled).toBe(true);
    expect(body.status.last_export_at).not.toBeNull();
    expect(body.status.mirror_path).toContain("mirror");
    expect(exportCalls().length).toBe(exportsBefore + 1);
    await manager.stop();
  });
});

// ---------------------------------------------------------------------------
// /.parachute/mirror/auth/* — credential routes (Cut 3)
//
// These routes back the SPA's "Connect GitHub" / "Use PAT" / "Disconnect"
// flows. The route layer is tested in isolation: we inject a mock fetch
// so GitHub's API calls don't go over the wire, point PARACHUTE_HOME at
// a tempdir so credentials writes don't touch real operator state, and
// drive the routes via the same Request/Response API the live router
// uses.
// ---------------------------------------------------------------------------

function buildMockFetch(
  responses: Array<{ match: (u: string) => boolean; body: unknown; status?: number }>,
): FetchLike {
  let idx = 0;
  return async (url) => {
    for (let i = idx; i < responses.length; i++) {
      if (responses[i]!.match(url)) {
        idx = i + 1;
        const r = responses[i]!;
        return {
          ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
          status: r.status ?? 200,
          text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
          json: async () => r.body,
        };
      }
    }
    throw new Error(`mockFetch: no matching response for ${url}`);
  };
}

describe("auth credential routes — GET /auth", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    _resetDeviceFlowSessionsForTest();
  });

  test("returns fully-null sanitized shape when no credentials stored", async () => {
    home = tmp("mirror-auth-empty-");
    const { manager } = makeManager(home);
    const res = handleAuthGet(manager);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active_method: null; github_oauth: null; pat: null };
    expect(body.active_method).toBeNull();
    expect(body.github_oauth).toBeNull();
    expect(body.pat).toBeNull();
  });

  test("returns sanitized shape when github_oauth credentials present (no token leaks)", async () => {
    home = tmp("mirror-auth-oauth-");
    const { manager } = makeManager(home);
    const creds: MirrorCredentials = {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_secret123456789",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    };
    writeCredentials("default", creds);
    const res = handleAuthGet(manager);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("gho_secret");
    const body = JSON.parse(text) as { github_oauth: { user_login: string; token_preview: string } };
    expect(body.github_oauth.user_login).toBe("aaron");
    expect(body.github_oauth.token_preview).toBe("gho_…6789");
  });
});

describe("auth credential routes — DELETE /auth", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    _resetDeviceFlowSessionsForTest();
  });

  test("wipes credentials from disk", async () => {
    home = tmp("mirror-auth-delete-");
    const { manager } = makeManager(home);
    writeCredentials("default", {
      active_method: "pat",
      github_oauth: null,
      pat: {
        token: "ghp_xxxxxxxxxxxxxxxxxxxx",
        remote_url: "https://github.com/a/b.git",
        label: "test",
      },
    });
    expect(fs.existsSync(mirrorCredentialsPath("default"))).toBe(true);
    const res = await handleAuthDelete(manager);
    expect(res.status).toBe(200);
    expect(fs.existsSync(mirrorCredentialsPath("default"))).toBe(false);
  });

  test("idempotent — missing credentials file still 200", async () => {
    home = tmp("mirror-auth-delete-empty-");
    const { manager } = makeManager(home);
    const res = await handleAuthDelete(manager);
    expect(res.status).toBe(200);
  });
});

describe("auth credential routes — device flow", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    _resetDeviceFlowSessionsForTest();
    delete process.env.PARACHUTE_GITHUB_CLIENT_ID;
  });

  test("device-code returns 503 when the env override is placeholder-shaped", async () => {
    home = tmp("mirror-auth-placeholder-");
    makeManager(home);
    // A real default ships in the build, so the placeholder guard is only
    // reachable via a misconfigured PARACHUTE_GITHUB_CLIENT_ID override.
    process.env.PARACHUTE_GITHUB_CLIENT_ID = "Iv1.PLACEHOLDER_REPLACE_ME_BEFORE_RELEASE";
    const res = await handleAuthGithubDeviceCode();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error_type: string };
    expect(body.error_type).toBe("placeholder_client_id");
  });

  test("poll without polling_id returns 400", async () => {
    home = tmp("mirror-auth-poll-bad-");
    const { manager } = makeManager(home);
    process.env.PARACHUTE_GITHUB_CLIENT_ID = "Iv1.real";
    const req = new Request("http://x/auth/github/poll", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await handleAuthGithubPoll(req, manager);
    expect(res.status).toBe(400);
  });

  test("poll with unknown polling_id returns 404 with expired state", async () => {
    home = tmp("mirror-auth-poll-unknown-");
    const { manager } = makeManager(home);
    process.env.PARACHUTE_GITHUB_CLIENT_ID = "Iv1.real";
    const req = new Request("http://x/auth/github/poll", {
      method: "POST",
      body: JSON.stringify({ polling_id: "nonexistent" }),
    });
    const res = await handleAuthGithubPoll(req, manager);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("expired");
  });

  test("full device flow with mocked fetch — code → granted → user → credentials saved", async () => {
    home = tmp("mirror-auth-flow-");
    const { manager } = makeManager(home);
    process.env.PARACHUTE_GITHUB_CLIENT_ID = "Iv1.real";

    // device-code request
    const fetchA = buildMockFetch([
      {
        match: (u) => u.includes("/login/device/code"),
        body: {
          device_code: "dev_xyz",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        },
      },
    ]);
    const codeRes = await handleAuthGithubDeviceCode(fetchA);
    expect(codeRes.status).toBe(200);
    const codeBody = (await codeRes.json()) as { polling_id: string; user_code: string };
    expect(codeBody.user_code).toBe("ABCD-1234");
    // device_code MUST NOT leak in the response.
    expect(JSON.stringify(codeBody)).not.toContain("dev_xyz");
    const polling_id = codeBody.polling_id;
    expect(polling_id.length).toBeGreaterThan(0);

    // poll once — pending
    const fetchPending = buildMockFetch([
      {
        match: () => true,
        body: { error: "authorization_pending" },
      },
    ]);
    const pendingRes = await handleAuthGithubPoll(
      new Request("http://x/poll", { method: "POST", body: JSON.stringify({ polling_id }) }),
      manager,
      fetchPending,
    );
    expect(pendingRes.status).toBe(200);
    const pendingBody = (await pendingRes.json()) as { state: string };
    expect(pendingBody.state).toBe("pending");

    // poll once — granted, fetch user, save credentials
    const fetchGranted = buildMockFetch([
      {
        match: (u) => u.includes("/login/oauth/access_token"),
        body: { access_token: "gho_real1234567890", scope: "repo", token_type: "bearer" },
      },
      {
        match: (u) => u.includes("/user"),
        body: { login: "aaron", id: 12345, name: "Aaron G", avatar_url: "https://x/y.png" },
      },
    ]);
    const grantRes = await handleAuthGithubPoll(
      new Request("http://x/poll", { method: "POST", body: JSON.stringify({ polling_id }) }),
      manager,
      fetchGranted,
    );
    expect(grantRes.status).toBe(200);
    const grantBody = (await grantRes.json()) as {
      state: string;
      user: { login: string; id: number };
    };
    expect(grantBody.state).toBe("granted");
    expect(grantBody.user.login).toBe("aaron");
    expect(grantBody.user.id).toBe(12345);
    // Credentials persisted; no token leak in response.
    expect(JSON.stringify(grantBody)).not.toContain("gho_real");
    const saved = readCredentials("default");
    expect(saved?.active_method).toBe("github_oauth");
    expect(saved?.github_oauth?.access_token).toBe("gho_real1234567890");
    expect(saved?.github_oauth?.user_login).toBe("aaron");
    // vault#483: the grant also carries the history-on-link outcome (the
    // dedicated branches are covered in the "history-on-link" describe).
    expect("history_enabled" in (grantBody as Record<string, unknown>)).toBe(true);
    // The grant may have started the mirror lifecycle (history-on-link) —
    // tear it down so no safety-net timer outlives the test.
    await manager.stop();
  });
});

describe("auth credential routes — PAT", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("rejects missing token with 400", async () => {
    home = tmp("mirror-auth-pat-notoken-");
    const { manager } = makeManager(home);
    const res = await handleAuthPat(
      new Request("http://x/pat", {
        method: "POST",
        body: JSON.stringify({ remote_url: "https://github.com/a/b.git" }),
      }),
      manager,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("token");
  });

  test("rejects missing remote_url with 400", async () => {
    home = tmp("mirror-auth-pat-nourl-");
    const { manager } = makeManager(home);
    const res = await handleAuthPat(
      new Request("http://x/pat", {
        method: "POST",
        body: JSON.stringify({ token: "ghp_x" }),
      }),
      manager,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("remote_url");
  });

  test("rejects non-HTTPS remote_url (SSH/file URLs not yet supported)", async () => {
    home = tmp("mirror-auth-pat-ssh-");
    const { manager } = makeManager(home);
    const res = await handleAuthPat(
      new Request("http://x/pat", {
        method: "POST",
        body: JSON.stringify({
          token: "ghp_x",
          remote_url: "git@github.com:owner/repo.git",
        }),
      }),
      manager,
    );
    expect(res.status).toBe(400);
  });

  test("probe-fail returns 400 with redacted error message (no token leak)", async () => {
    // Probe against a definitely-not-real domain. We bypass the network
    // path via a token that should cause `git ls-remote` to fail
    // immediately. The interesting assertion is "the error message we
    // surface back doesn't include the token literal".
    home = tmp("mirror-auth-pat-probefail-");
    const { manager } = makeManager(home);
    const secret = "ghp_definitelynotvalidatall1234567890";
    const res = await handleAuthPat(
      new Request("http://x/pat", {
        method: "POST",
        body: JSON.stringify({
          token: secret,
          remote_url: "https://nonexistent.parachute.test/owner/repo.git",
        }),
      }),
      manager,
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(secret);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Cuts 3 + 6: credential save → auto_push flipped on + initial push fires.
//
// The PAT route gates on a real `git ls-remote` probe, so it's awkward
// to exercise end-to-end in a hermetic test. The select-repo route has
// no probe — it accepts the operator's already-OAuth'd token and wires
// the URL. We drive the side-effect helpers (maybeEnableAutoPush +
// maybeFireInitialPush) through select-repo, with a local bare repo as
// the "GitHub" remote — overridden via post-save remote-URL rewrite so
// pushNow targets the test repo.
// ---------------------------------------------------------------------------

describe("auth credential routes — credential-save side-effects (Cuts 3 + 6)", () => {
  let home: string;
  let remote: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  });

  test("select-repo flips auto_push from false → true on an enabled internal mirror", async () => {
    home = tmp("mirror-selectrepo-autopush-");
    remote = tmp("mirror-selectrepo-remote-");
    Bun.spawnSync(["git", "init", "--bare", "-q", "-b", "main"], { cwd: remote });

    const { manager, deps } = makeManager(home);
    deps.writeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
      sync_mode: "manual",
      auto_commit: false,
      auto_push: false,
    });
    // Mirror the in-memory deps config into the REAL per-vault file:
    // select-repo now runs maybeEnableHistoryOnLink (PR #484 fold), whose
    // never-configured branch keys off the file's existence — without it
    // the helper would see "never configured" and clobber this test's
    // config with defaults.
    writeMirrorConfigForVault("default", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
      sync_mode: "manual",
      auto_commit: false,
      auto_push: false,
    });
    await manager.start();
    expect(manager.getConfig().auto_push).toBe(false);

    // Seed github_oauth credentials. select-repo doesn't probe; it just
    // sets origin to github.com/<owner>/<repo>.git. We then rewrite
    // origin to our local bare repo so pushNow has somewhere to land.
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_fake1234567890abcd",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });

    const res = await handleAuthGithubSelectRepo(
      new Request("http://x/select", {
        method: "POST",
        body: JSON.stringify({ owner: "aaron", name: "my-vault" }),
      }),
      manager,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      auto_push_was_already_enabled: boolean;
      auto_push_enabled: boolean;
      initial_push:
        | { fired: false; reason: string }
        | { fired: true; pushed: boolean; error?: string; sha?: string };
    };
    // Cut 3 — auto_push went from false → true.
    expect(body.auto_push_was_already_enabled).toBe(false);
    expect(body.auto_push_enabled).toBe(true);
    expect(manager.getConfig().auto_push).toBe(true);
    // Cut 6 — initial push fired. It points at github.com which doesn't
    // exist for our fake creds → expected to fail with a redacted error
    // in last_push_error, but the helper still reports fired=true.
    expect(body.initial_push.fired).toBe(true);
    if (body.initial_push.fired === true) {
      // Push failure is fine — point is "we tried."
      expect(typeof body.initial_push.pushed).toBe("boolean");
    }
    // Token doesn't leak into the response.
    expect(JSON.stringify(body)).not.toContain("gho_fake1234567890");
    await manager.stop();
  }, 30_000);

  test("vault#401: owner/name survive a cleared origin + restart (persisted in creds, not just the git remote)", async () => {
    // The bug: pre-#401, select-repo wrote owner/name ONLY into the git
    // origin URL. On restart, applyCredentialsToRemote regex-parsed them back
    // out of the origin — so clearing the origin (DELETE /auth → re-OAuth
    // without re-selecting) silently lost the repo even with a valid token.
    // Now select-repo persists owner/name into the credentials struct, and
    // applyCredentialsToRemote prefers the persisted values. With the origin
    // cleared, a restart still reconstructs the github.com remote.
    home = tmp("mirror-selectrepo-persist-");
    const { manager, deps } = makeManager(home);
    const cfg = {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal" as const,
      sync_mode: "manual" as const,
      auto_commit: false,
      auto_push: false,
    };
    // The manager reads config via deps.readMirrorConfig (in-memory); the
    // route's history-on-link keys off the real per-vault file's existence.
    // Seed both, same as the autopush test above.
    deps.writeMirrorConfig(cfg);
    writeMirrorConfigForVault("default", cfg);
    await manager.start();
    const mirrorPath = manager.getStatus().mirror_path;
    expect(mirrorPath).toBeTruthy();

    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_persisttoken12345",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });

    const res = await handleAuthGithubSelectRepo(
      new Request("http://x/select", {
        method: "POST",
        body: JSON.stringify({ owner: "aaron", name: "backup-repo" }),
      }),
      manager,
    );
    expect(res.status).toBe(200);

    // The fix: owner/name persisted into the credentials struct (not just origin).
    const persisted = readCredentials("default");
    expect(persisted?.github_oauth?.owner).toBe("aaron");
    expect(persisted?.github_oauth?.name).toBe("backup-repo");

    // Simulate the DELETE /auth + re-OAuth-without-reselect path: the OAuth
    // token survives, but the git origin gets cleared.
    Bun.spawnSync(["git", "remote", "remove", "origin"], { cwd: mirrorPath! });
    const afterClear = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      cwd: mirrorPath!,
    });
    expect(afterClear.exitCode).not.toBe(0); // origin is gone

    // Restart — applyCredentialsToRemote runs again. Pre-#401 it would find no
    // origin to parse and leave the remote unset; post-#401 it rebuilds from
    // the persisted owner/name.
    await manager.stop();
    await manager.start();

    const reapplied = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      cwd: mirrorPath!,
    });
    expect(reapplied.exitCode).toBe(0);
    const reappliedUrl = reapplied.stdout.toString().trim();
    // The remote was reconstructed from persisted owner/name (token embedded,
    // not asserted here). Without persistence this would be empty.
    expect(reappliedUrl).toContain("github.com/aaron/backup-repo");
    await manager.stop();
  }, 30_000);

  test("select-repo is a no-op for auto_push when mirror is disabled", async () => {
    // Operator wiring credentials before flipping the mirror on — don't
    // mutate auto_push behind their back.
    home = tmp("mirror-selectrepo-disabled-");
    const { manager, deps } = makeManager(home);
    deps.writeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: false,
      auto_push: false,
    });
    // Real file too — select-repo's history-on-link (PR #484 fold) must
    // see this as an EXPLICIT enabled:false (left_disabled), not as a
    // never-configured vault it should enable.
    writeMirrorConfigForVault("default", {
      ...defaultMirrorConfig(),
      enabled: false,
      auto_push: false,
    });
    await manager.start();
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_anothertoken12345",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });
    const res = await handleAuthGithubSelectRepo(
      new Request("http://x/select", {
        method: "POST",
        body: JSON.stringify({ owner: "aaron", name: "v" }),
      }),
      manager,
    );
    expect(res.status).toBe(200);
    expect(manager.getConfig().auto_push).toBe(false);
    await manager.stop();
  });
});

// ---------------------------------------------------------------------------
// Cut 6: POST /.parachute/mirror/push-now route handler.
// ---------------------------------------------------------------------------

describe("handleMirrorPushNow — Cut 6", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("returns 400 when mirror is not enabled", async () => {
    home = tmp("mirror-pushnow-disabled-");
    const { manager, deps } = makeManager(home);
    deps.writeMirrorConfig({ ...defaultMirrorConfig(), enabled: false });
    await manager.start();
    const res = await handleMirrorPushNow(manager);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Mirror not enabled");
  });

  test("returns 200 + push outcome when mirror is enabled (even on push failure)", async () => {
    home = tmp("mirror-pushnow-enabled-");
    const { manager, deps } = makeManager(home);
    deps.writeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
      sync_mode: "manual",
      auto_commit: false,
    });
    await manager.start();
    // No remote → push will fail; the handler still returns 200 with
    // the failure surface in the body. Push failures aren't 500s.
    const res = await handleMirrorPushNow(manager);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: { last_push_error: string | null };
      push: { fired: boolean };
    };
    expect(body.push.fired).toBe(true);
    expect(body.status.last_push_error).not.toBeNull();
    await manager.stop();
  }, 30_000);
});

describe("auth credential routes — github repos / create-repo", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("repos returns 400 when not connected to GitHub", async () => {
    home = tmp("mirror-auth-repos-noauth-");
    const { manager } = makeManager(home);
    const res = await handleAuthGithubRepos(manager);
    expect(res.status).toBe(400);
  });

  test("repos lists from the installation (vault#480) — installed:true + account annotation", async () => {
    home = tmp("mirror-auth-repos-ok-");
    const { manager } = makeManager(home);
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "ghu_test1234567890",
        scope: "",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/installations?"),
        body: {
          total_count: 1,
          installations: [
            {
              id: 101,
              app_slug: "parachute-computer",
              account: { login: "aaron", type: "User" },
              repository_selection: "selected",
            },
          ],
        },
      },
      {
        match: (u) => u.includes("/user/installations/101/repositories"),
        body: {
          total_count: 1,
          repositories: [
            {
              name: "a",
              full_name: "aaron/a",
              private: true,
              html_url: "https://github.com/aaron/a",
              description: null,
              updated_at: "2026-05-28T00:00:00Z",
              clone_url: "https://github.com/aaron/a.git",
              owner: { login: "aaron" },
            },
          ],
        },
      },
    ]);
    const res = await handleAuthGithubRepos(manager, fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installed: boolean;
      truncated: boolean;
      repos: Array<{ full_name: string; account_login: string; installation_id: number }>;
    };
    expect(body.installed).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]!.full_name).toBe("aaron/a");
    expect(body.repos[0]!.account_login).toBe("aaron");
    expect(body.repos[0]!.installation_id).toBe(101);
  });

  test("repos unions multiple installations (user + org) with per-repo annotation", async () => {
    // The org-repos blind spot Aaron hit live: GET /user/repos?type=owner
    // excluded org-owned repos by construction. The installations source
    // enumerates both.
    home = tmp("mirror-auth-repos-multi-");
    const { manager } = makeManager(home);
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "ghu_test1234567890",
        scope: "",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });
    const repoItem = (owner: string, name: string) => ({
      name,
      full_name: `${owner}/${name}`,
      private: true,
      html_url: `https://github.com/${owner}/${name}`,
      description: null,
      updated_at: "2026-06-10T00:00:00Z",
      clone_url: `https://github.com/${owner}/${name}.git`,
      owner: { login: owner },
    });
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/installations?"),
        body: {
          total_count: 2,
          installations: [
            {
              id: 101,
              app_slug: "parachute-computer",
              account: { login: "aaron", type: "User" },
              repository_selection: "selected",
            },
            {
              id: 202,
              app_slug: "parachute-computer",
              account: { login: "unforced-org", type: "Organization" },
              repository_selection: "selected",
            },
          ],
        },
      },
      {
        match: (u) => u.includes("/user/installations/101/repositories"),
        body: { total_count: 1, repositories: [repoItem("aaron", "personal-vault")] },
      },
      {
        match: (u) => u.includes("/user/installations/202/repositories"),
        body: { total_count: 1, repositories: [repoItem("unforced-org", "team-vault")] },
      },
    ]);
    const res = await handleAuthGithubRepos(manager, fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installed: boolean;
      repos: Array<{ full_name: string; account_login: string; installation_id: number }>;
    };
    expect(body.installed).toBe(true);
    expect(body.repos).toHaveLength(2);
    expect(body.repos[0]!.full_name).toBe("aaron/personal-vault");
    expect(body.repos[0]!.account_login).toBe("aaron");
    expect(body.repos[0]!.installation_id).toBe(101);
    expect(body.repos[1]!.full_name).toBe("unforced-org/team-vault");
    expect(body.repos[1]!.account_login).toBe("unforced-org");
    expect(body.repos[1]!.installation_id).toBe(202);
  });

  test("repos are sorted most-recently-updated first within each account group", async () => {
    // The installation-repositories endpoint has no `sort` param (the old
    // GET /user/repos?sort=updated source did) — the handler sorts each
    // group itself so the repo the operator probably wants is near the top.
    home = tmp("mirror-auth-repos-sorted-");
    const { manager } = makeManager(home);
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "ghu_test1234567890",
        scope: "",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });
    const repoItem = (name: string, updated_at: string) => ({
      name,
      full_name: `aaron/${name}`,
      private: true,
      html_url: `https://github.com/aaron/${name}`,
      description: null,
      updated_at,
      clone_url: `https://github.com/aaron/${name}.git`,
      owner: { login: "aaron" },
    });
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/installations?"),
        body: {
          total_count: 1,
          installations: [
            {
              id: 101,
              app_slug: "parachute-computer",
              account: { login: "aaron", type: "User" },
              repository_selection: "all",
            },
          ],
        },
      },
      {
        match: (u) => u.includes("/user/installations/101/repositories"),
        body: {
          total_count: 3,
          // Alphabetical wire order (GitHub's default) — NOT recency.
          repositories: [
            repoItem("alpha", "2026-01-01T00:00:00Z"),
            repoItem("beta", "2026-06-09T00:00:00Z"),
            repoItem("gamma", "2026-03-15T00:00:00Z"),
          ],
        },
      },
    ]);
    const res = await handleAuthGithubRepos(manager, fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: Array<{ name: string }> };
    expect(body.repos.map((r) => r.name)).toEqual(["beta", "gamma", "alpha"]);
  });

  test("repos returns the machine-readable not_installed state when authorized but not installed", async () => {
    home = tmp("mirror-auth-repos-notinstalled-");
    const { manager } = makeManager(home);
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "ghu_test1234567890",
        scope: "",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/installations?"),
        body: { total_count: 0, installations: [] },
      },
    ]);
    const res = await handleAuthGithubRepos(manager, fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installed: boolean;
      install_url: string;
      repos: unknown[];
      truncated: boolean;
    };
    expect(body.installed).toBe(false);
    expect(body.install_url).toBe(
      "https://github.com/apps/parachute-computer/installations/new",
    );
    expect(body.repos).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  test("repos carries truncated:true when an installation hits the page cap", async () => {
    home = tmp("mirror-auth-repos-trunc-");
    const { manager } = makeManager(home);
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "ghu_test1234567890",
        scope: "",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });
    // The route calls listInstallationRepos with defaults (perPage=100,
    // maxPages=3): serve 3 FULL pages of 100 so the cap trips.
    const fullPage = (page: number) => ({
      total_count: 1000,
      repositories: Array.from({ length: 100 }, (_, i) => {
        const n = page * 100 + i;
        return {
          name: `r${n}`,
          full_name: `aaron/r${n}`,
          private: false,
          html_url: `https://github.com/aaron/r${n}`,
          description: null,
          updated_at: "2026-06-10T00:00:00Z",
          clone_url: `https://github.com/aaron/r${n}.git`,
          owner: { login: "aaron" },
        };
      }),
    });
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/installations?"),
        body: {
          total_count: 1,
          installations: [
            {
              id: 101,
              app_slug: "parachute-computer",
              account: { login: "aaron", type: "User" },
              repository_selection: "all",
            },
          ],
        },
      },
      { match: (u) => u.includes("/repositories") && u.includes("page=1"), body: fullPage(0) },
      { match: (u) => u.includes("/repositories") && u.includes("page=2"), body: fullPage(1) },
      { match: (u) => u.includes("/repositories") && u.includes("page=3"), body: fullPage(2) },
    ]);
    const res = await handleAuthGithubRepos(manager, fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installed: boolean; truncated: boolean; repos: unknown[] };
    expect(body.installed).toBe(true);
    expect(body.truncated).toBe(true);
    expect(body.repos).toHaveLength(300);
  });

  test("create-repo proxies through with mocked fetch", async () => {
    home = tmp("mirror-auth-create-repo-");
    const { manager } = makeManager(home);
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_test1234567890",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/repos"),
        status: 201,
        body: {
          name: "new-vault",
          full_name: "aaron/new-vault",
          private: true,
          html_url: "https://github.com/aaron/new-vault",
          description: "x",
          updated_at: "2026-05-28T00:00:00Z",
          clone_url: "https://github.com/aaron/new-vault.git",
          owner: { login: "aaron" },
        },
      },
    ]);
    const req = new Request("http://x/create", {
      method: "POST",
      body: JSON.stringify({ name: "new-vault" }),
    });
    const res = await handleAuthGithubCreateRepo(req, manager, fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { full_name: string };
    expect(body.full_name).toBe("aaron/new-vault");
  });

  test("create-repo maps GitHub's 403 to app_lacks_admin_permission + the guided-manual path (vault#480)", async () => {
    // Expected with the shared Contents-only app: POST /user/repos needs
    // Administration:write. The response must be actionable + machine-
    // readable, not a generic 502.
    home = tmp("mirror-auth-create-repo-403-");
    const { manager } = makeManager(home);
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "ghu_test1234567890",
        scope: "",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/repos"),
        status: 403,
        body: { message: "Resource not accessible by integration" },
      },
    ]);
    const req = new Request("http://x/create", {
      method: "POST",
      body: JSON.stringify({ name: "new-vault" }),
    });
    const res = await handleAuthGithubCreateRepo(req, manager, fetcher);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_type: string; message: string };
    expect(body.error_type).toBe("app_lacks_admin_permission");
    // Names the guided-manual path: create at github.com/new → add to the
    // installation → refresh.
    expect(body.message).toContain("github.com/new");
    expect(body.message).toContain("installation");
  });
});

// ---------------------------------------------------------------------------
// GET /.parachute/mirror/auth/github/installations — install state (vault#480).
// ---------------------------------------------------------------------------

describe("auth credential routes — install state (GET /auth/github/installations)", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    delete process.env.PARACHUTE_GITHUB_CLIENT_ID;
    delete process.env.PARACHUTE_GITHUB_APP_SLUG;
  });

  const oauthCreds = (): MirrorCredentials => ({
    active_method: "github_oauth",
    github_oauth: {
      access_token: "ghu_test1234567890",
      scope: "",
      authorized_at: "2026-06-10T00:00:00.000Z",
      user_login: "aaron",
      user_id: 1,
    },
    pat: null,
  });

  test("400 github_not_connected when no github_oauth credential exists", async () => {
    // 400, not 401, matching the sibling repos handler — a 401 would trip
    // the SPA's authedFetch token-refresh machinery (clearing a valid
    // cached admin token) over a condition that isn't an auth failure.
    home = tmp("mirror-installstate-nocred-");
    const { manager } = makeManager(home);
    const res = await handleAuthGithubInstallations(manager);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_type: string; message: string };
    expect(body.error_type).toBe("github_not_connected");
    expect(body.message).toContain("device flow");
  });

  test("authorized but not installed → installed:false + install_url, empty installations", async () => {
    home = tmp("mirror-installstate-notinstalled-");
    const { manager } = makeManager(home);
    writeCredentials("default", oauthCreds());
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/installations?"),
        body: { total_count: 0, installations: [] },
      },
    ]);
    const res = await handleAuthGithubInstallations(manager, fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      app: { client_id: string; slug: string; is_shared_default: boolean };
      installed: boolean;
      install_url: string;
      installations: unknown[];
    };
    expect(body.installed).toBe(false);
    expect(body.installations).toEqual([]);
    expect(body.install_url).toBe(
      "https://github.com/apps/parachute-computer/installations/new",
    );
    expect(body.app.slug).toBe("parachute-computer");
    expect(body.app.client_id).toBe("Iv23livaRF4VcvPhu3uB");
    expect(body.app.is_shared_default).toBe(true);
  });

  test("installed on a user account AND an org → both surfaced", async () => {
    home = tmp("mirror-installstate-installed-");
    const { manager } = makeManager(home);
    writeCredentials("default", oauthCreds());
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/installations?"),
        body: {
          total_count: 2,
          installations: [
            {
              id: 101,
              app_slug: "parachute-computer",
              account: { login: "aaron", type: "User" },
              repository_selection: "selected",
            },
            {
              id: 202,
              app_slug: "parachute-computer",
              account: { login: "unforced-org", type: "Organization" },
              repository_selection: "all",
            },
          ],
        },
      },
    ]);
    const res = await handleAuthGithubInstallations(manager, fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installed: boolean;
      installations: Array<{
        id: number;
        account_login: string;
        account_type: string;
        repository_selection: string;
      }>;
    };
    expect(body.installed).toBe(true);
    expect(body.installations).toHaveLength(2);
    expect(body.installations[0]).toEqual({
      id: 101,
      account_login: "aaron",
      account_type: "User",
      repository_selection: "selected",
    });
    expect(body.installations[1]).toEqual({
      id: 202,
      account_login: "unforced-org",
      account_type: "Organization",
      repository_selection: "all",
    });
  });

  test("BYO-app env overrides are reflected in the app block (is_shared_default false)", async () => {
    home = tmp("mirror-installstate-byo-");
    const { manager } = makeManager(home);
    writeCredentials("default", oauthCreds());
    process.env.PARACHUTE_GITHUB_CLIENT_ID = "Iv1.byoclient";
    process.env.PARACHUTE_GITHUB_APP_SLUG = "my-own-app";
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/installations?"),
        body: { total_count: 0, installations: [] },
      },
    ]);
    const res = await handleAuthGithubInstallations(manager, fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      app: { client_id: string; slug: string; is_shared_default: boolean };
      install_url: string;
    };
    expect(body.app.client_id).toBe("Iv1.byoclient");
    expect(body.app.slug).toBe("my-own-app");
    expect(body.app.is_shared_default).toBe(false);
    expect(body.install_url).toBe("https://github.com/apps/my-own-app/installations/new");
  });

  test("502 when GitHub is unreachable / errors", async () => {
    home = tmp("mirror-installstate-apierr-");
    const { manager } = makeManager(home);
    writeCredentials("default", oauthCreds());
    const fetcher = buildMockFetch([
      {
        match: (u) => u.includes("/user/installations?"),
        status: 401,
        body: { message: "Bad credentials" },
      },
    ]);
    const res = await handleAuthGithubInstallations(manager, fetcher);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Installation check failed");
  });
});

// ---------------------------------------------------------------------------
// vault#483 fix 1 — history-on-link (credential save enables history for a
// never-configured vault; explicit operator choices are respected).
//
// Managers here are wired to the REAL per-vault mirror-config file (the
// makeSyncManager pattern) because the never-configured branch keys off the
// file's existence — the in-memory makeManager deps would diverge from what
// maybeEnableHistoryOnLink reads.
// ---------------------------------------------------------------------------

describe("history-on-link (vault#483)", () => {
  let home: string;
  let manager: MirrorManager;
  afterEach(async () => {
    if (manager) await manager.stop();
    if (home) fs.rmSync(home, { recursive: true, force: true });
    _resetDeviceFlowSessionsForTest();
  });

  /** Run the device flow to `granted` against a mocked GitHub. */
  async function grantDeviceFlow(mgr: MirrorManager): Promise<{
    state: string;
    history_enabled: true | false | "left_disabled";
  }> {
    const fetchCode = buildMockFetch([
      {
        match: (u) => u.includes("/login/device/code"),
        body: {
          device_code: "dev_xyz",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        },
      },
    ]);
    const codeRes = await handleAuthGithubDeviceCode(fetchCode);
    expect(codeRes.status).toBe(200);
    const { polling_id } = (await codeRes.json()) as { polling_id: string };
    const fetchGranted = buildMockFetch([
      {
        match: (u) => u.includes("/login/oauth/access_token"),
        body: { access_token: "ghu_granted1234567890", scope: "", token_type: "bearer" },
      },
      {
        match: (u) => u.includes("/user"),
        body: { login: "aaron", id: 12345, name: "Aaron G" },
      },
    ]);
    const grantRes = await handleAuthGithubPoll(
      new Request("http://x/poll", { method: "POST", body: JSON.stringify({ polling_id }) }),
      mgr,
      fetchGranted,
    );
    expect(grantRes.status).toBe(200);
    return (await grantRes.json()) as {
      state: string;
      history_enabled: true | false | "left_disabled";
    };
  }

  test("device-flow grant on a never-configured vault enables history with the standard defaults", async () => {
    home = tmp("history-link-fresh-");
    manager = makeSyncManager(home);
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });

    const body = await grantDeviceFlow(manager);
    expect(body.state).toBe("granted");
    expect(body.history_enabled).toBe(true);

    // Config file now exists with the standard internal-mirror defaults.
    const cfg = readMirrorConfigForVault("default");
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.location).toBe("internal");
    expect(cfg?.sync_mode).toBe("events");
    expect(cfg?.auto_commit).toBe(true);
    // auto_push stays OFF at link time — no repo picked yet; select-repo's
    // Cut 3 flips it once a remote exists.
    expect(cfg?.auto_push).toBe(false);
    // And the mirror actually started.
    expect(manager.getStatus().enabled).toBe(true);
  });

  test("device-flow grant does NOT flip an explicitly-disabled mirror; flags left_disabled", async () => {
    home = tmp("history-link-disabled-");
    manager = makeSyncManager(home);
    writeMirrorConfigForVault("default", {
      ...defaultMirrorConfig(),
      enabled: false,
    });

    const body = await grantDeviceFlow(manager);
    expect(body.state).toBe("granted");
    expect(body.history_enabled).toBe("left_disabled");

    // The operator's explicit choice survives untouched.
    const cfg = readMirrorConfigForVault("default");
    expect(cfg?.enabled).toBe(false);
    expect(manager.getStatus().enabled).toBe(false);
  });

  test("device-flow grant leaves an already-enabled mirror untouched (history_enabled true)", async () => {
    home = tmp("history-link-enabled-");
    manager = makeSyncManager(home);
    // Non-default field values so "untouched" is distinguishable from
    // "rewritten with defaults."
    writeMirrorConfigForVault("default", {
      ...defaultMirrorConfig(),
      enabled: true,
      sync_mode: "manual",
      auto_commit: false,
      safety_net_seconds: 120,
    });

    const body = await grantDeviceFlow(manager);
    expect(body.state).toBe("granted");
    expect(body.history_enabled).toBe(true);

    const cfg = readMirrorConfigForVault("default");
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.sync_mode).toBe("manual");
    expect(cfg?.auto_commit).toBe(false);
    expect(cfg?.safety_net_seconds).toBe(120);
  });

  test("PAT save on a never-configured vault enables history, then Cut 3 flips auto_push (remote known)", async () => {
    home = tmp("history-link-pat-fresh-");
    manager = makeSyncManager(home);
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });

    // probeOverride bypasses the real `git ls-remote`; 127.0.0.1:1 keeps the
    // post-save initial push hermetic (instant connection refusal — never a
    // real GitHub round-trip).
    const res = await handleAuthPat(
      new Request("http://x/pat", {
        method: "POST",
        body: JSON.stringify({
          token: "ghp_link_test_token_123",
          remote_url: "https://127.0.0.1:1/owner/repo.git",
        }),
      }),
      manager,
      async () => ({ ok: true }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      history_enabled: true | false | "left_disabled";
      auto_push_enabled: boolean;
    };
    expect(body.history_enabled).toBe(true);
    // PAT carries the remote, so the full chain runs: history on → Cut 3
    // flips auto_push on the now-enabled mirror.
    expect(body.auto_push_enabled).toBe(true);
    const cfg = readMirrorConfigForVault("default");
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.auto_push).toBe(true);
    // No token leak.
    expect(JSON.stringify(body)).not.toContain("ghp_link_test_token_123");
  }, 30_000);

  test("PAT save respects an explicitly-disabled mirror (left_disabled; auto_push untouched)", async () => {
    home = tmp("history-link-pat-disabled-");
    manager = makeSyncManager(home);
    writeMirrorConfigForVault("default", {
      ...defaultMirrorConfig(),
      enabled: false,
    });

    const res = await handleAuthPat(
      new Request("http://x/pat", {
        method: "POST",
        body: JSON.stringify({
          token: "ghp_link_test_token_456",
          remote_url: "https://127.0.0.1:1/owner/repo.git",
        }),
      }),
      manager,
      async () => ({ ok: true }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      history_enabled: true | false | "left_disabled";
      auto_push_enabled: boolean;
    };
    expect(body.history_enabled).toBe("left_disabled");
    expect(body.auto_push_enabled).toBe(false);
    const cfg = readMirrorConfigForVault("default");
    expect(cfg?.enabled).toBe(false);
    expect(cfg?.auto_push).toBe(false);
  });

  /** Seed a stored github_oauth credential — the select-repo precondition.
   *  Models a credential saved BEFORE history-on-link existed: the operator
   *  re-enters via "Choose repository…" without a fresh grant. */
  function seedOauthCredential(): void {
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_selectrepo1234567890",
        scope: "repo",
        authorized_at: "2026-06-10T00:00:00.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });
  }

  test("select-repo on a never-configured vault enables history + carries history_enabled (PR #484 fold)", async () => {
    // The #483 re-entry gap: a credential saved pre-history-on-link on a
    // never-configured vault. The grant/PAT paths never ran for this
    // config, so select-repo is the first linked action — it must wire
    // history (before auto_push, which no-ops on a disabled mirror).
    home = tmp("history-link-selectrepo-fresh-");
    manager = makeSyncManager(home);
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    seedOauthCredential();
    expect(readMirrorConfigForVault("default")).toBeUndefined();

    const res = await handleAuthGithubSelectRepo(
      new Request("http://x/select", {
        method: "POST",
        body: JSON.stringify({ owner: "aaron", name: "my-vault" }),
      }),
      manager,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      history_enabled: true | false | "left_disabled";
      auto_push_enabled: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.history_enabled).toBe(true);
    // History first, so the full chain runs: enabled mirror → Cut 3 flips
    // auto_push (the PAT handler's ordering, mirrored).
    expect(body.auto_push_enabled).toBe(true);
    const cfg = readMirrorConfigForVault("default");
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.location).toBe("internal");
    expect(cfg?.auto_push).toBe(true);
    expect(manager.getStatus().enabled).toBe(true);
    // No token leak.
    expect(JSON.stringify(body)).not.toContain("gho_selectrepo1234567890");
  }, 30_000);

  test("select-repo respects an explicitly-disabled mirror (left_disabled; stays off)", async () => {
    home = tmp("history-link-selectrepo-disabled-");
    manager = makeSyncManager(home);
    writeMirrorConfigForVault("default", {
      ...defaultMirrorConfig(),
      enabled: false,
    });
    seedOauthCredential();

    const res = await handleAuthGithubSelectRepo(
      new Request("http://x/select", {
        method: "POST",
        body: JSON.stringify({ owner: "aaron", name: "my-vault" }),
      }),
      manager,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      history_enabled: true | false | "left_disabled";
      auto_push_enabled: boolean;
    };
    // The operator's explicit choice survives — the UI gets the one-click
    // "Turn on history now?" offer instead of a silent flip.
    expect(body.history_enabled).toBe("left_disabled");
    expect(body.auto_push_enabled).toBe(false);
    const cfg = readMirrorConfigForVault("default");
    expect(cfg?.enabled).toBe(false);
    expect(cfg?.auto_push).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /.parachute/mirror/import — clone-and-import HTTP route (vault#391).
// ---------------------------------------------------------------------------

/**
 * Bootstrap a real vault config + db file so getVaultStore('default')
 * succeeds inside the handler. Returns the home dir for cleanup.
 */
async function bootstrapVault(home: string): Promise<void> {
  process.env.PARACHUTE_HOME = home;
  process.env.HOME = home;
  // The minimal layout vault needs to spin up its store: a per-vault
  // dir at $PARACHUTE_HOME/vault/data/<name> + a `vault.yaml` config.
  // writeVaultConfig creates these for us.
  fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
  writeVaultConfig({
    name: "default",
    description: "import-test vault",
    created_at: "2026-05-28T00:00:00.000Z",
    api_keys: [],
  });
  clearVaultStoreCache();
}

/**
 * Build a real portable-md vault export, return the path. The clone
 * spawn-mock copies this into the tempdir to simulate a successful
 * `git clone`.
 */
async function buildExportFixture(): Promise<string> {
  const fixture = tmp("import-route-fixture-");
  const exportStore = new SqliteStore(new Database(":memory:"));
  await exportStore.createNote("alpha body", { id: "n-alpha", path: "alpha", tags: ["t1"] });
  await exportStore.createNote("beta body", { id: "n-beta", path: "beta" });
  await exportVaultToDir(exportStore, {
    outDir: fixture,
    vaultName: "source",
    exportedAt: "2026-05-28T00:00:00.000Z",
  });
  return fixture;
}

const spawnCloneSuccess = (fixture: string): GitSpawn => async (argv) => {
  const destDir = argv[argv.length - 1]!;
  cpSync(fixture, destDir, { recursive: true });
  return { exitCode: 0, stderr: "", timedOut: false };
};

const spawnCloneFail: GitSpawn = async () => ({
  exitCode: 128,
  stderr: "fatal: repository not found",
  timedOut: false,
});

/**
 * vault#416 — a MirrorManager wired to the REAL per-vault config file (so
 * `handleMirrorImport`'s `readMirrorConfigForVault` agrees with what
 * `manager.reload()` wrote) + a no-op export. Passed to `handleMirrorImport`
 * as the `managerOverride` so the sync-enable step has a live manager without
 * standing up the registry factory. Bootstrap (git init of the internal
 * mirror) runs for real; push to a fake remote fails non-fatally (we assert
 * on persisted config + credentials, not on a landed push).
 */
function makeSyncManager(home: string): MirrorManager {
  process.env.PARACHUTE_HOME = home;
  process.env.HOME = home;
  const deps: MirrorDeps = {
    vaultName: "default",
    runExport: async () => ({ notes: 0 }),
    firstChangedNoteTitle: async () => "",
    readMirrorConfig: () => readMirrorConfigForVault("default"),
    writeMirrorConfig: (c) => writeMirrorConfigForVault("default", c),
  };
  return new MirrorManager(deps);
}

describe("handleMirrorImport", () => {
  let home: string;
  let fixture: string;

  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
    _resetImportInFlightForTest();
    _resetImportJobsForTest();
    clearVaultStoreCache();
  });

  test("rejects invalid JSON body with 400", async () => {
    home = tmp("import-route-badjson-");
    await bootstrapVault(home);
    const req = new Request("http://x/import", {
      method: "POST",
      body: "{not-json",
    });
    const res = await handleMirrorImport(req, "default");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_type: string };
    expect(body.error_type).toBe("invalid_json");
  });

  test("rejects missing remote_url with 400", async () => {
    home = tmp("import-route-no-url-");
    await bootstrapVault(home);
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({ mode: "merge" }),
    });
    const res = await handleMirrorImport(req, "default");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("remote_url");
  });

  test("rejects invalid mode with 400", async () => {
    home = tmp("import-route-bad-mode-");
    await bootstrapVault(home);
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({ remote_url: "https://github.com/a/b.git", mode: "wipe" }),
    });
    const res = await handleMirrorImport(req, "default");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("mode");
  });

  test("rejects per-call PAT without token", async () => {
    home = tmp("import-route-pat-missing-token-");
    await bootstrapVault(home);
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "" },
      }),
    });
    const res = await handleMirrorImport(req, "default");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("credentials.token");
  });

  test("rejects unknown credentials.kind", async () => {
    home = tmp("import-route-bad-kind-");
    await bootstrapVault(home);
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "magic" },
      }),
    });
    const res = await handleMirrorImport(req, "default");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("credentials.kind");
  });

  test("success path — merge mode imports notes into target vault", async () => {
    home = tmp("import-route-success-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "none" },
      }),
    });
    const res = await handleMirrorImport(req, "default", spawnCloneSuccess(fixture));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notes_imported: number;
      tags_imported: number;
      attachments_imported: number;
      warnings: string[];
      notes_deleted?: number;
    };
    expect(body.notes_imported).toBe(2);
    expect(body.warnings).toEqual([]);
    expect(body.notes_deleted).toBeUndefined();
  });

  test("replace mode sets notes_deleted in response", async () => {
    home = tmp("import-route-replace-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    // Seed the target vault with a local-only note that gets wiped.
    const { getVaultStore } = await import("./vault-store.ts");
    const store = getVaultStore("default");
    await store.createNote("local", { id: "n-local", path: "local" });

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "replace",
        wait: true,
        credentials: { kind: "none" },
      }),
    });
    const res = await handleMirrorImport(req, "default", spawnCloneSuccess(fixture));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notes_imported: number;
      notes_deleted: number;
    };
    expect(body.notes_imported).toBe(2);
    expect(body.notes_deleted).toBe(1);
  });

  test("clone failure returns 502 with redacted message", async () => {
    home = tmp("import-route-clone-fail-");
    await bootstrapVault(home);
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_secret_xyz" },
      }),
    });
    const res = await handleMirrorImport(req, "default", spawnCloneFail);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("ghp_secret_xyz");
    const body = JSON.parse(text) as { error_type: string };
    expect(body.error_type).toBe("clone_failed");
  });

  test("not-a-vault-export returns 400 with actionable message", async () => {
    home = tmp("import-route-not-vault-");
    await bootstrapVault(home);
    const notAnExport = tmp("import-route-notvault-fixture-");
    nodeWriteFileSync(path.join(notAnExport, "README.md"), "hello");
    fixture = notAnExport;
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "none" },
      }),
    });
    const res = await handleMirrorImport(req, "default", spawnCloneSuccess(notAnExport));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_type: string; message: string };
    expect(body.error_type).toBe("not_a_vault_export");
    expect(body.message).toContain("vault.yaml");
  });

  test("git not installed returns 503 + git_not_installed + actionable message", async () => {
    // vault#415 — live bug on a git-less Amazon Linux EC2 box. Force the
    // preflight (via the whichOverride seam) to see no git; the spawn seam
    // should never be reached.
    home = tmp("import-route-nogit-");
    await bootstrapVault(home);
    let spawnCalled = false;
    const spyingSpawn: GitSpawn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stderr: "", timedOut: false };
    };
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "none" },
      }),
    });
    const res = await handleMirrorImport(req, "default", spyingSpawn, () => null);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error_type: string; message: string };
    expect(body.error_type).toBe("git_not_installed");
    expect(body.message).toContain("git is required");
    expect(body.message).toContain("dnf install git");
    // Failed fast: the git spawn was never reached.
    expect(spawnCalled).toBe(false);
  });

  test("uses stored credentials when credentials: null (credentialsFile path)", async () => {
    home = tmp("import-route-stored-creds-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    // Write a stored PAT credential matching github.com.
    writeCredentials("default", {
      active_method: "pat",
      github_oauth: null,
      pat: {
        token: "ghp_stored_token_xyz",
        remote_url: "https://x-access-token:ghp_stored_token_xyz@github.com/a/b.git",
        label: "stored",
      },
    });
    // Assert the spawn argv carries the stored token (proves the
    // credentialsFile path resolved).
    let observedArgv: string[] | null = null;
    const fakeSpawn: GitSpawn = async (argv) => {
      observedArgv = argv;
      const destDir = argv[argv.length - 1]!;
      cpSync(fixture, destDir, { recursive: true });
      return { exitCode: 0, stderr: "", timedOut: false };
    };
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "merge",
        wait: true,
        credentials: null,
      }),
    });
    const res = await handleMirrorImport(req, "default", fakeSpawn);
    expect(res.status).toBe(200);
    // The clone URL should have the stored token embedded.
    expect(observedArgv).not.toBeNull();
    expect(observedArgv!.some((arg) => arg.includes("ghp_stored_token_xyz"))).toBe(true);
  });

  test("per-call PAT override is used when supplied", async () => {
    home = tmp("import-route-per-call-pat-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    // Stored credentials should be IGNORED when per-call PAT is supplied.
    writeCredentials("default", {
      active_method: "pat",
      github_oauth: null,
      pat: {
        token: "ghp_stored_xyz",
        remote_url: "https://x-access-token:ghp_stored_xyz@github.com/a/b.git",
        label: "stored",
      },
    });
    let observedArgv: string[] | null = null;
    const fakeSpawn: GitSpawn = async (argv) => {
      observedArgv = argv;
      const destDir = argv[argv.length - 1]!;
      cpSync(fixture, destDir, { recursive: true });
      return { exitCode: 0, stderr: "", timedOut: false };
    };
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_per_call_only" },
      }),
    });
    const res = await handleMirrorImport(req, "default", fakeSpawn);
    expect(res.status).toBe(200);
    expect(observedArgv).not.toBeNull();
    const joined = observedArgv!.join(" ");
    expect(joined).toContain("ghp_per_call_only");
    expect(joined).not.toContain("ghp_stored_xyz");
  });
});

// ---------------------------------------------------------------------------
// vault#416 — auto-enable sync to the imported repo (default-on, opt-out).
// ---------------------------------------------------------------------------

describe("handleMirrorImport — auto-enable sync (vault#416)", () => {
  let home: string;
  let fixture: string;
  let manager: MirrorManager;

  afterEach(async () => {
    if (manager) await manager.stop();
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
    _resetImportInFlightForTest();
    _resetImportJobsForTest();
    clearVaultStoreCache();
  });

  test("enable_sync true + PAT auth → mirror configured, creds persisted, auto_push on, sync_enabled true", async () => {
    home = tmp("import-sync-pat-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_import_token_abc" },
        enable_sync: true,
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notes_imported: number;
      sync_enabled: boolean;
      sync_warning?: string;
    };
    expect(body.notes_imported).toBe(2);
    expect(body.sync_enabled).toBe(true);
    expect(body.sync_warning).toBeUndefined();

    // Mirror config persisted with auto_push + enabled.
    const cfg = readMirrorConfigForVault("default");
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.auto_push).toBe(true);

    // Credentials persisted, pointing at the imported remote.
    const creds = readCredentials("default");
    expect(creds?.active_method).toBe("pat");
    expect(creds?.pat?.token).toBe("ghp_import_token_abc");
    expect(creds?.pat?.remote_url).toContain("github.com/aaron/my-vault.git");
  });

  test("enable_sync false → no mirror configured, sync_enabled false, no warning", async () => {
    home = tmp("import-sync-optout-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_import_token_abc" },
        enable_sync: false,
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sync_enabled: boolean;
      sync_warning?: string;
    };
    expect(body.sync_enabled).toBe(false);
    expect(body.sync_warning).toBeUndefined();

    // Nothing configured.
    expect(readMirrorConfigForVault("default")).toBeUndefined();
    expect(readCredentials("default")).toBeNull();
  });

  test("enable_sync true + auth none → sync_enabled false + needs-write-creds warning; no broken mirror", async () => {
    home = tmp("import-sync-nocreds-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "none" },
        enable_sync: true,
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notes_imported: number;
      sync_enabled: boolean;
      sync_warning?: string;
    };
    // Import still succeeded.
    expect(body.notes_imported).toBe(2);
    expect(body.sync_enabled).toBe(false);
    expect(body.sync_warning).toContain("write credentials");

    // No mirror left configured, no credentials written.
    expect(readMirrorConfigForVault("default")).toBeUndefined();
    expect(readCredentials("default")).toBeNull();
  });

  // vault#641 — the default INVERTED. Import is a read; it must not arm a
  // write to the source repo unless the operator says so. Pinned as its own
  // test because the old default (ON, vault#416) was the single most dangerous
  // thing about this flow: pulling a vault onto a new box silently repointed
  // backup at the repo you pulled from.
  test("enable_sync defaults to FALSE when omitted — import never arms push-back on its own", async () => {
    home = tmp("import-sync-default-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_default_off_token" },
        // enable_sync omitted — must default OFF.
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sync_enabled: boolean;
      sync_warning?: string;
    };
    expect(body.sync_enabled).toBe(false);
    // Not a failure — the operator didn't ask. No scary warning either.
    expect(body.sync_warning).toBeUndefined();
    // The decisive assertion: nothing was wired up.
    expect(readMirrorConfigForVault("default")?.auto_push ?? false).toBe(false);
  });

  test("enable_sync: true still opts in explicitly", async () => {
    home = tmp("import-sync-optin-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        enable_sync: true,
        credentials: { kind: "pat", token: "ghp_opt_in_token" },
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sync_enabled: boolean };
    expect(body.sync_enabled).toBe(true);
    expect(readMirrorConfigForVault("default")?.auto_push).toBe(true);
  });

  test("existing mirror to a DIFFERENT remote → not clobbered, sync_enabled false + conflict warning", async () => {
    home = tmp("import-sync-conflict-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    // Pre-existing mirror config (enabled) + credential pointing elsewhere.
    writeMirrorConfigForVault("default", {
      ...defaultMirrorConfig(),
      enabled: true,
      auto_push: true,
    });
    writeCredentials("default", {
      active_method: "pat",
      github_oauth: null,
      pat: {
        token: "ghp_existing_other",
        remote_url:
          "https://x-access-token:ghp_existing_other@github.com/aaron/OTHER-repo.git",
        label: "existing backup",
      },
    });

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_import_token_abc" },
        enable_sync: true,
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sync_enabled: boolean;
      sync_warning?: string;
    };
    expect(body.sync_enabled).toBe(false);
    expect(body.sync_warning).toContain("already syncs to a different repo");

    // The existing credential was NOT clobbered.
    const creds = readCredentials("default");
    expect(creds?.pat?.token).toBe("ghp_existing_other");
    expect(creds?.pat?.remote_url).toContain("OTHER-repo.git");
  });

  test("vault#482: import-sync to a repo a SIBLING vault already backs up → import succeeds but sync declined + conflict warning", async () => {
    home = tmp("import-sync-cross-vault-");
    await bootstrapVault(home); // creates vault "default"
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    // Sibling vault "family" already syncs to the repo we're importing.
    const sibDataDir = path.join(home, "vault", "data", "family");
    fs.mkdirSync(sibDataDir, { recursive: true });
    fs.writeFileSync(path.join(sibDataDir, "vault.yaml"), "name: family\n");
    writeMirrorConfigForVault("family", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
    });
    const sibGitDir = path.join(sibDataDir, "mirror", ".git");
    fs.mkdirSync(sibGitDir, { recursive: true });
    fs.writeFileSync(
      path.join(sibGitDir, "config"),
      '[remote "origin"]\n\turl = https://github.com/aaron/my-vault.git\n',
    );

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_import_token_abc" },
        enable_sync: true,
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notes_imported: number;
      sync_enabled: boolean;
      sync_warning?: string;
    };
    // Import itself never fails on the conflict.
    expect(body.notes_imported).toBe(2);
    // ...but sync is declined + the warning names the sibling vault + repo.
    expect(body.sync_enabled).toBe(false);
    expect(body.sync_warning).toContain("family");
    expect(body.sync_warning).toContain("github.com/aaron/my-vault");

    // No sync config / credential got persisted for "default".
    expect(readMirrorConfigForVault("default")).toBeUndefined();
    expect(readCredentials("default")).toBeNull();
  });

  test("vault#482: import-sync with override=true binds anyway despite a sibling on the same repo", async () => {
    home = tmp("import-sync-cross-override-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    const sibDataDir = path.join(home, "vault", "data", "family");
    fs.mkdirSync(sibDataDir, { recursive: true });
    fs.writeFileSync(path.join(sibDataDir, "vault.yaml"), "name: family\n");
    writeMirrorConfigForVault("family", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
    });
    const sibGitDir = path.join(sibDataDir, "mirror", ".git");
    fs.mkdirSync(sibGitDir, { recursive: true });
    fs.writeFileSync(
      path.join(sibGitDir, "config"),
      '[remote "origin"]\n\turl = https://github.com/aaron/my-vault.git\n',
    );

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_import_token_abc" },
        enable_sync: true,
        override: true,
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sync_enabled: boolean };
    expect(body.sync_enabled).toBe(true);
    // Sync config + credential persisted for "default" despite the sibling.
    expect(readMirrorConfigForVault("default")?.auto_push).toBe(true);
    expect(readCredentials("default")?.pat?.token).toBe("ghp_import_token_abc");
  });

  test("existing mirror to the SAME remote → no-op success (sync_enabled true)", async () => {
    home = tmp("import-sync-same-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    writeMirrorConfigForVault("default", {
      ...defaultMirrorConfig(),
      enabled: true,
      auto_push: true,
    });
    writeCredentials("default", {
      active_method: "pat",
      github_oauth: null,
      pat: {
        token: "ghp_same_token",
        remote_url:
          "https://x-access-token:ghp_same_token@github.com/aaron/my-vault.git",
        label: "existing same",
      },
    });

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_same_token" },
        enable_sync: true,
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sync_enabled: boolean;
      sync_warning?: string;
    };
    expect(body.sync_enabled).toBe(true);
    expect(body.sync_warning).toBeUndefined();
  });

  test("existing GitHub-connected mirror → PAT import doesn't clobber it (sync_enabled false + warning)", async () => {
    home = tmp("import-sync-oauth-conflict-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    writeMirrorConfigForVault("default", {
      ...defaultMirrorConfig(),
      enabled: true,
      auto_push: true,
    });
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_existing_oauth",
        scope: "repo",
        authorized_at: "2026-05-28T00:00:00.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_import_token_abc" },
        enable_sync: true,
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sync_enabled: boolean;
      sync_warning?: string;
    };
    expect(body.sync_enabled).toBe(false);
    expect(body.sync_warning).toContain("connected GitHub account");

    // The existing OAuth credential is untouched (not switched to a PAT).
    const creds = readCredentials("default");
    expect(creds?.active_method).toBe("github_oauth");
    expect(creds?.pat).toBeNull();
  });

  test("sync-setup failure after a successful import → import result still returned, sync_enabled false + warning", async () => {
    home = tmp("import-sync-setupfail-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();
    manager = makeSyncManager(home);

    // Force the sync-enable step to throw by stubbing the manager's reload.
    // The import itself has already succeeded by the time reload runs, so the
    // request must still return a 200 with the import counts intact.
    manager.reload = async () => {
      throw new Error("boom: simulated reload failure");
    };

    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "pat", token: "ghp_import_token_abc" },
        enable_sync: true,
      }),
    });
    const res = await handleMirrorImport(
      req,
      "default",
      spawnCloneSuccess(fixture),
      undefined,
      manager,
      // vault#823: hermetic probe — reachable, empty remote (no guard fire).
      async () => ({ ok: true, heads: [] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notes_imported: number;
      sync_enabled: boolean;
      sync_warning?: string;
    };
    // Import NOT lost.
    expect(body.notes_imported).toBe(2);
    expect(body.sync_enabled).toBe(false);
    expect(body.sync_warning).toContain("enabling Sync failed");
  });

  test("invalid enable_sync type → 400 validation error", async () => {
    home = tmp("import-sync-badtype-");
    await bootstrapVault(home);
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/aaron/my-vault.git",
        mode: "merge",
        wait: true,
        credentials: { kind: "none" },
        enable_sync: "yes",
      }),
    });
    const res = await handleMirrorImport(req, "default");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("enable_sync");
  });
});

// ---------------------------------------------------------------------------
// vault#482 — cross-vault remote-clobber guard at the ROUTE level.
//
// Two vaults on one server pointing their mirror at the same repo force-push
// over each other's backups (silent data loss). The guard refuses a bind
// (PAT save / OAuth repo pick / import-then-sync) when a SIBLING vault already
// claims the same normalized remote, unless `override: true`. Re-binding a
// vault to its OWN remote is always allowed (no false positive).
// ---------------------------------------------------------------------------

/**
 * Seed a sibling vault on disk under the active PARACHUTE_HOME so
 * `listVaults()` sees it, with an enabled internal mirror whose `origin`
 * points at `originUrl`. No git spawn — we write `.git/config` directly,
 * exactly what the guard reads.
 */
function seedSiblingVault(name: string, originUrl: string): void {
  const home = process.env.PARACHUTE_HOME!;
  const dataDir = path.join(home, "vault", "data", name);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "vault.yaml"), `name: ${name}\n`);
  writeMirrorConfigForVault(name, {
    ...defaultMirrorConfig(),
    enabled: true,
    location: "internal",
  });
  const mirrorGitDir = path.join(dataDir, "mirror", ".git");
  fs.mkdirSync(mirrorGitDir, { recursive: true });
  fs.writeFileSync(
    path.join(mirrorGitDir, "config"),
    `[remote "origin"]\n\turl = ${originUrl}\n`,
  );
}

// ---------------------------------------------------------------------------
// vault#640 — the ASYNC import transport.
//
// The semantic tests above (what gets imported, how sync gets wired, which
// credential is picked) run through `wait: true`, the back-compat synchronous
// path. That's deliberate, not laziness: both paths call the SAME `runImport`
// closure, so transport and semantics are genuinely orthogonal and testing
// each import behaviour twice would buy nothing. This block covers the part
// that IS different — the job lifecycle the SPA actually drives.
// ---------------------------------------------------------------------------
describe("handleMirrorImport — async job transport (vault#640)", () => {
  let home: string;
  let fixture: string;

  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
    _resetImportInFlightForTest();
    _resetImportJobsForTest();
    clearVaultStoreCache();
  });

  /** POST an import, asserting the 202, and hand back the job record. */
  async function startImport(
    spawn: GitSpawn,
    body: Record<string, unknown> = {},
  ): Promise<ImportJob> {
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "merge",
        credentials: { kind: "none" },
        ...body,
      }),
    });
    const res = await handleMirrorImport(req, "default", spawn);
    expect(res.status).toBe(202);
    return (await res.json()) as ImportJob;
  }

  /** Poll the status route until the job leaves `running`. */
  async function pollUntilDone(jobId: string, vault = "default"): Promise<ImportJob> {
    for (let i = 0; i < 200; i++) {
      const res = handleMirrorImportStatus(vault, jobId);
      const job = (await res.json()) as ImportJob;
      if (job.status !== "running") return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("import job never reached a terminal state");
  }

  test("POST returns 202 with a running job, not the result", async () => {
    home = tmp("import-async-202-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();

    const job = await startImport(spawnCloneSuccess(fixture));
    expect(job.job_id).toBeTruthy();
    expect(job.status).toBe("running");
    expect(job.stage).toBe("cloning");
    expect(job.vault_name).toBe("default");

    await pollUntilDone(job.job_id);
  });

  test("polling reaches succeeded and carries the import result", async () => {
    home = tmp("import-async-ok-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();

    const started = await startImport(spawnCloneSuccess(fixture));
    const done = await pollUntilDone(started.job_id);

    expect(done.status).toBe("succeeded");
    expect(done.finished_at).toBeTruthy();
    expect(done.result?.notes_imported).toBe(2);
    expect(done.error).toBeUndefined();
  });

  test("a clone failure lands on the job as clone_failed, with the token redacted", async () => {
    home = tmp("import-async-fail-");
    await bootstrapVault(home);

    const started = await startImport(spawnCloneFail, {
      credentials: { kind: "pat", token: "ghp_secret_xyz" },
    });
    const done = await pollUntilDone(started.job_id);

    expect(done.status).toBe("failed");
    expect(done.error?.error_type).toBe("clone_failed");
    expect(JSON.stringify(done)).not.toContain("ghp_secret_xyz");
  });

  test("a second import while one is running → 409 carrying the in-flight job_id", async () => {
    home = tmp("import-async-conflict-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();

    const first = await startImport(spawnCloneSuccess(fixture));
    const req = new Request("http://x/import", {
      method: "POST",
      body: JSON.stringify({
        remote_url: "https://github.com/a/b.git",
        mode: "merge",
        credentials: { kind: "none" },
      }),
    });
    const res = await handleMirrorImport(req, "default", spawnCloneSuccess(fixture));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error_type: string; job_id?: string };
    expect(body.error_type).toBe("concurrent_import");
    // The second tab can attach to the running import instead of being stuck.
    expect(body.job_id).toBe(first.job_id);

    await pollUntilDone(first.job_id);
  });

  test("a finished job frees the vault for the next import", async () => {
    home = tmp("import-async-serial-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();

    const first = await startImport(spawnCloneSuccess(fixture));
    await pollUntilDone(first.job_id);

    const second = await startImport(spawnCloneSuccess(fixture));
    expect(second.job_id).not.toBe(first.job_id);
    await pollUntilDone(second.job_id);
  });

  test("status is scoped to the vault — another vault's admin can't read the job", async () => {
    home = tmp("import-async-scope-");
    await bootstrapVault(home);
    fixture = await buildExportFixture();

    const started = await startImport(spawnCloneSuccess(fixture));
    const res = handleMirrorImportStatus("some-other-vault", started.job_id);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error_type: string };
    expect(body.error_type).toBe("job_not_found");

    await pollUntilDone(started.job_id);
  });

  test("unknown job id → 404 job_not_found", async () => {
    home = tmp("import-async-404-");
    await bootstrapVault(home);
    const res = handleMirrorImportStatus("default", "no-such-job");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error_type: string };
    expect(body.error_type).toBe("job_not_found");
  });
});

describe("cross-vault remote-clobber guard (vault#482)", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("PAT: a second vault targeting a sibling's repo is refused with 409 + helpful error", async () => {
    home = tmp("guard-pat-refuse-");
    const { manager } = makeManager(home); // vault "default"
    // Sibling vault "family" already backs up to aaron/shared.
    seedSiblingVault("family", "https://github.com/aaron/shared.git");

    const res = await handleAuthPat(
      new Request("http://x/pat", {
        method: "POST",
        body: JSON.stringify({
          token: "ghp_newtoken1234567890",
          remote_url: "https://github.com/aaron/shared.git",
        }),
      }),
      manager,
      // Probe stub — the conflict guard runs AFTER the probe, so the probe
      // must pass for us to reach (and assert on) the guard.
      async () => ({ ok: true }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error_type: string;
      conflicting_vault: string;
      remote: string;
      message: string;
    };
    expect(body.error_type).toBe("remote_conflict");
    expect(body.conflicting_vault).toBe("family");
    expect(body.remote).toBe("github.com/aaron/shared");
    // Names the vault + repo + tells the operator how to proceed.
    expect(body.message).toContain("family");
    expect(body.message).toContain("github.com/aaron/shared");
    expect(body.message).toContain("override");
    // Nothing got persisted for the refused vault.
    expect(readCredentials("default")).toBeNull();
  });

  test("PAT: URL-normalization — sibling stored as scp-shorthand, candidate https → recognized as same repo", async () => {
    home = tmp("guard-pat-norm-");
    const { manager } = makeManager(home);
    // Sibling stored its origin as SSH scp-shorthand.
    seedSiblingVault("family", "git@github.com:aaron/shared.git");

    const res = await handleAuthPat(
      new Request("http://x/pat", {
        method: "POST",
        body: JSON.stringify({
          token: "ghp_newtoken1234567890",
          // ...candidate arrives as HTTPS without .git.
          remote_url: "https://github.com/aaron/shared",
        }),
      }),
      manager,
      async () => ({ ok: true }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { conflicting_vault: string };
    expect(body.conflicting_vault).toBe("family");
  });

  test("PAT: re-pointing the SAME vault at its OWN remote is allowed (no false positive)", async () => {
    home = tmp("guard-pat-self-");
    const { manager } = makeManager(home); // vault "default"
    // "default" already targets aaron/mine (its own origin) + a sibling
    // targets a DIFFERENT repo — neither should block a self re-bind.
    seedSiblingVault("default", "https://github.com/aaron/mine.git");
    seedSiblingVault("family", "https://github.com/aaron/theirs.git");

    const res = await handleAuthPat(
      new Request("http://x/pat", {
        method: "POST",
        body: JSON.stringify({
          token: "ghp_rotated1234567890",
          // Same repo "default" already points at — token rotation.
          remote_url: "https://github.com/aaron/mine.git",
        }),
      }),
      manager,
      async () => ({ ok: true }),
    );
    expect(res.status).toBe(200);
    const creds = readCredentials("default");
    expect(creds?.active_method).toBe("pat");
    expect(creds?.pat?.remote_url).toContain("github.com/aaron/mine.git");
  });

  test("PAT: override=true bypasses the guard and saves anyway", async () => {
    home = tmp("guard-pat-override-");
    const { manager } = makeManager(home);
    seedSiblingVault("family", "https://github.com/aaron/shared.git");

    const res = await handleAuthPat(
      new Request("http://x/pat", {
        method: "POST",
        body: JSON.stringify({
          token: "ghp_newtoken1234567890",
          remote_url: "https://github.com/aaron/shared.git",
          override: true,
        }),
      }),
      manager,
      async () => ({ ok: true }),
    );
    expect(res.status).toBe(200);
    expect(readCredentials("default")?.active_method).toBe("pat");
  });

  test("select-repo: picking a sibling's repo is refused with 409", async () => {
    home = tmp("guard-selectrepo-refuse-");
    const { manager } = makeManager(home);
    seedSiblingVault("family", "https://github.com/aaron/shared.git");
    // "default" has an OAuth credential (select-repo requires one).
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_fake1234567890abcd",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });

    const res = await handleAuthGithubSelectRepo(
      new Request("http://x/select", {
        method: "POST",
        body: JSON.stringify({ owner: "aaron", name: "shared" }),
      }),
      manager,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error_type: string;
      conflicting_vault: string;
    };
    expect(body.error_type).toBe("remote_conflict");
    expect(body.conflicting_vault).toBe("family");
  });

  test("select-repo: override=true bypasses the guard", async () => {
    home = tmp("guard-selectrepo-override-");
    const { manager } = makeManager(home);
    seedSiblingVault("family", "https://github.com/aaron/shared.git");
    writeCredentials("default", {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_fake1234567890abcd",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: null,
    });
    const res = await handleAuthGithubSelectRepo(
      new Request("http://x/select", {
        method: "POST",
        body: JSON.stringify({ owner: "aaron", name: "shared", override: true }),
      }),
      manager,
    );
    // 200 (or any non-409) — the guard didn't block it. (mirror_path is
    // unresolved since the manager never started, so it stores creds + returns
    // ok without applying to a remote.)
    expect(res.status).not.toBe(409);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vault#823 — enableSyncToImportedRepo must consult the unrelated-history
// guard, not just contain a call to it.
//
// The lesson from hub#820, applied before shipping rather than after: proving
// `findUnrelatedRemoteHistory` returns a struct proves nothing about whether
// the arm path reads it. Mutating `if (unrelated)` to `if (false && unrelated)`
// left the whole vault suite green, which is how this test came to exist.
// ---------------------------------------------------------------------------

describe("enableSyncToImportedRepo — unrelated-history guard (vault#823)", () => {
  /** Minimal manager stand-in: the guard branch only reads `mirror_path`. */
  function stubManager(mirrorPath: string | null): MirrorManager {
    return {
      getStatus: () => ({ mirror_path: mirrorPath }),
    } as unknown as MirrorManager;
  }

  test("non-empty remote + fresh mirror → sync NOT armed, and the reason is stated", async () => {
    const res = await enableSyncToImportedRepo({
      vaultName: "solo",
      remoteUrl: "https://github.com/aaron/my-vault.git",
      auth: { kind: "none" },
      manager: stubManager(null), // nothing bootstrapped yet — the import case
      probeOverride: async () => ({ ok: true, heads: ["a".repeat(40)] }),
    });
    expect(res.sync_enabled).toBe(false);
    expect(res.warning).toContain("github.com/aaron/my-vault");
    expect(res.warning).toContain("non-fast-forward");
    // It must not be mistaken for the "no credential" refusal further down —
    // that one fires for auth.kind === "none" and would also return false.
    expect(res.warning).not.toContain("write credentials");
  });

  test("empty remote → guard stays out of the way (falls through to the credential check)", async () => {
    const res = await enableSyncToImportedRepo({
      vaultName: "solo",
      remoteUrl: "https://github.com/aaron/fresh.git",
      auth: { kind: "none" },
      manager: stubManager(null),
      probeOverride: async () => ({ ok: true, heads: [] }),
    });
    expect(res.sync_enabled).toBe(false);
    // Reached the NEXT refusal, which proves the history guard declined to fire.
    expect(res.warning).toContain("write credentials");
  });

  test("override=true skips the guard entirely", async () => {
    const res = await enableSyncToImportedRepo({
      vaultName: "solo",
      remoteUrl: "https://github.com/aaron/my-vault.git",
      auth: { kind: "none" },
      manager: stubManager(null),
      override: true,
      probeOverride: async () => ({ ok: true, heads: ["a".repeat(40)] }),
    });
    expect(res.warning).toContain("write credentials");
    expect(res.warning).not.toContain("non-fast-forward");
  });

  test("unreachable remote fails OPEN — a network blip must not block setup", async () => {
    const res = await enableSyncToImportedRepo({
      vaultName: "solo",
      remoteUrl: "https://github.com/aaron/my-vault.git",
      auth: { kind: "none" },
      manager: stubManager(null),
      probeOverride: async () => ({ ok: false, error: "could not resolve host" }),
    });
    expect(res.warning).toContain("write credentials");
    expect(res.warning).not.toContain("non-fast-forward");
  });

  test("a skipped check is SAID, not silent — the advisory rides on a successful arm", async () => {
    // Uni's catch on #646: this guard runs at BIND time and there may be no
    // next bind. An operator arms Sync once and walks away, so a probe blip
    // that silently skips the check reproduces the exact five-day silence the
    // guard exists to prevent. Failing open is still right; failing open
    // WITHOUT saying so is not.
    let armed = false;
    const manager = {
      getStatus: () => (armed ? { mirror_path: "/tmp/m", enabled: true } : { mirror_path: null }),
      getEffectiveConfig: () => ({ enabled: false, auto_push: false, location: "internal" }),
      reload: async () => {
        armed = true;
      },
    } as unknown as MirrorManager;

    const res = await enableSyncToImportedRepo({
      vaultName: "solo",
      remoteUrl: "https://github.com/aaron/my-vault.git",
      auth: { kind: "pat", token: "ghp_x" },
      manager,
      probeOverride: async () => ({ ok: false, error: "could not resolve host" }),
    });
    expect(res.sync_enabled).toBe(true);
    expect(res.warning).toContain("couldn't reach the repo");
    // Points at the surface that WILL catch it after the fact (hub#820).
    expect(res.warning).toContain("backup status");
  });

  test("a probe that succeeded adds no advisory", async () => {
    let armed = false;
    const manager = {
      getStatus: () => (armed ? { mirror_path: "/tmp/m", enabled: true } : { mirror_path: null }),
      getEffectiveConfig: () => ({ enabled: false, auto_push: false, location: "internal" }),
      reload: async () => {
        armed = true;
      },
    } as unknown as MirrorManager;

    const res = await enableSyncToImportedRepo({
      vaultName: "solo",
      remoteUrl: "https://github.com/aaron/fresh.git",
      auth: { kind: "pat", token: "ghp_x" },
      manager,
      probeOverride: async () => ({ ok: true, heads: [] }),
    });
    expect(res.sync_enabled).toBe(true);
    expect(res.warning ?? "").not.toContain("couldn't reach");
  });
});
