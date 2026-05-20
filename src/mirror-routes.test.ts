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
import { handleMirrorGet, handleMirrorPut } from "./mirror-routes.ts";

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

  test("PUT restarts watch loop with new interval", async () => {
    home = tmp("mirror-put-restart-");
    const { manager } = makeManager(home);
    // Enable with watch.
    const req1 = new Request("http://x/admin/mirror", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        location: "internal",
        watch: true,
        auto_commit: false,
        interval_seconds: 1,
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
});
