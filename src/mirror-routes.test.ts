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

import { defaultMirrorConfig, type MirrorConfig } from "./mirror-config.ts";
import {
  MirrorManager,
  type MirrorDeps,
} from "./mirror-manager.ts";
import {
  _resetDeviceFlowSessionsForTest,
  handleAuthDelete,
  handleAuthGet,
  handleAuthGithubCreateRepo,
  handleAuthGithubDeviceCode,
  handleAuthGithubPoll,
  handleAuthGithubRepos,
  handleAuthPat,
  handleMirrorGet,
  handleMirrorPut,
  handleMirrorRunNow,
} from "./mirror-routes.ts";
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
    makeManager(home);
    const res = handleAuthGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active_method: null; github_oauth: null; pat: null };
    expect(body.active_method).toBeNull();
    expect(body.github_oauth).toBeNull();
    expect(body.pat).toBeNull();
  });

  test("returns sanitized shape when github_oauth credentials present (no token leaks)", async () => {
    home = tmp("mirror-auth-oauth-");
    makeManager(home);
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
    writeCredentials(creds);
    const res = handleAuthGet();
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
    writeCredentials({
      active_method: "pat",
      github_oauth: null,
      pat: {
        token: "ghp_xxxxxxxxxxxxxxxxxxxx",
        remote_url: "https://github.com/a/b.git",
        label: "test",
      },
    });
    expect(fs.existsSync(mirrorCredentialsPath())).toBe(true);
    const res = await handleAuthDelete(manager);
    expect(res.status).toBe(200);
    expect(fs.existsSync(mirrorCredentialsPath())).toBe(false);
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

  test("device-code returns 503 with placeholder client_id (no env override)", async () => {
    home = tmp("mirror-auth-placeholder-");
    makeManager(home);
    delete process.env.PARACHUTE_GITHUB_CLIENT_ID;
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
    const saved = readCredentials();
    expect(saved?.active_method).toBe("github_oauth");
    expect(saved?.github_oauth?.access_token).toBe("gho_real1234567890");
    expect(saved?.github_oauth?.user_login).toBe("aaron");
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

describe("auth credential routes — github repos / create-repo", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("repos returns 400 when not connected to GitHub", async () => {
    home = tmp("mirror-auth-repos-noauth-");
    makeManager(home);
    const res = await handleAuthGithubRepos();
    expect(res.status).toBe(400);
  });

  test("repos returns list when authed", async () => {
    home = tmp("mirror-auth-repos-ok-");
    makeManager(home);
    writeCredentials({
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
        body: [
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
    ]);
    const res = await handleAuthGithubRepos(fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: Array<{ full_name: string }> };
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]!.full_name).toBe("aaron/a");
  });

  test("create-repo proxies through with mocked fetch", async () => {
    home = tmp("mirror-auth-create-repo-");
    makeManager(home);
    writeCredentials({
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
    const res = await handleAuthGithubCreateRepo(req, fetcher);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { full_name: string };
    expect(body.full_name).toBe("aaron/new-vault");
  });
});

