/**
 * Tests for the MirrorManager lifecycle — bootstrap, start/stop/reload,
 * watch loop arming, status tracking (vault-sync Phase A1).
 *
 * The manager is dependency-injected so tests pass fake `runExport` +
 * `firstChangedNoteTitle` + config read/write closures. No real vault
 * store needed.
 *
 * Filesystem assertions hit real tempdirs + spawn real `git` so we
 * exercise the actual bootstrap logic (mkdir + git init + initial commit).
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bootstrapInternalMirror,
  MirrorManager,
  type MirrorDeps,
} from "./mirror-manager.ts";
import { defaultMirrorConfig, type MirrorConfig } from "./mirror-config.ts";

// Snapshot HOME + PARACHUTE_HOME at module load; restore after every test
// so the `process.env.HOME = ...` rewrite in `makeFakeDeps` doesn't leak
// into sibling test files (e.g. mcp-install.test.ts reads `os.homedir()`
// and would otherwise see our tempdir).
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

function seedCommit(dir: string): void {
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-q", "-m", "initial"], { cwd: dir });
}

function isGitRepoSync(dir: string): boolean {
  const proc = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
  });
  return (proc.exitCode ?? 1) === 0;
}

function commitCount(dir: string): number {
  const proc = Bun.spawnSync(["git", "log", "--oneline"], { cwd: dir, stdout: "pipe" });
  return new TextDecoder()
    .decode(proc.stdout)
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

/**
 * Build a fake `MirrorDeps` with controllable export + config behavior.
 * `parachuteHome` controls `vaultDir()` lookups so internal-location
 * resolution lands inside a tempdir.
 */
function makeFakeDeps(opts: {
  vaultName?: string;
  parachuteHome: string;
  initialConfig?: MirrorConfig | undefined;
  /** Optional override for runExport — return note count per call. */
  runExport?: (call: { outDir: string; sinceCursor?: string }) => Promise<{ notes: number }>;
}): MirrorDeps & {
  exportCalls: Array<{ outDir: string; sinceCursor: string | undefined }>;
  storedConfig: MirrorConfig | undefined;
} {
  process.env.PARACHUTE_HOME = opts.parachuteHome;
  process.env.HOME = opts.parachuteHome;

  const state: {
    config: MirrorConfig | undefined;
    exportCalls: Array<{ outDir: string; sinceCursor: string | undefined }>;
  } = {
    config: opts.initialConfig,
    exportCalls: [],
  };

  const base: MirrorDeps = {
    vaultName: opts.vaultName ?? "default",
    runExport: async (call: { outDir: string; sinceCursor?: string }) => {
      state.exportCalls.push({
        outDir: call.outDir,
        sinceCursor: call.sinceCursor,
      });
      if (opts.runExport) return opts.runExport(call);
      return { notes: 1 };
    },
    firstChangedNoteTitle: async () => "Inbox/fake",
    readMirrorConfig: () => state.config,
    writeMirrorConfig: (c: MirrorConfig) => {
      state.config = c;
    },
  };
  // Defining the test-visible getters via defineProperty so the getter
  // bodies run on every access — otherwise an Object.assign snapshots
  // the field once at construction time and stale values leak.
  Object.defineProperty(base, "exportCalls", {
    get: () => state.exportCalls,
    enumerable: true,
  });
  Object.defineProperty(base, "storedConfig", {
    get: () => state.config,
    enumerable: true,
  });
  return base as MirrorDeps & {
    exportCalls: Array<{ outDir: string; sinceCursor: string | undefined }>;
    storedConfig: MirrorConfig | undefined;
  };
}

// ---------------------------------------------------------------------------
// bootstrapInternalMirror
// ---------------------------------------------------------------------------

describe("bootstrapInternalMirror", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("creates the dir + git-inits + seed commit when path doesn't exist", async () => {
    dir = path.join(tmp("mirror-boot-"), "mirror");
    expect(fs.existsSync(dir)).toBe(false);
    const r = await bootstrapInternalMirror(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.initialized).toBe(true);
      expect(fs.existsSync(dir)).toBe(true);
      expect(isGitRepoSync(dir)).toBe(true);
      expect(commitCount(dir)).toBe(1);
    }
  });

  test("idempotent on already-bootstrapped repo (no re-init)", async () => {
    const parent = tmp("mirror-boot-idem-");
    dir = path.join(parent, "mirror");
    fs.mkdirSync(dir);
    initRepo(dir);
    seedCommit(dir);
    const before = commitCount(dir);
    const r = await bootstrapInternalMirror(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.initialized).toBe(false);
      expect(commitCount(dir)).toBe(before); // didn't add a new seed commit
    }
  });

  test("refuses to clobber a non-empty, non-git directory", async () => {
    dir = tmp("mirror-boot-clobber-");
    fs.writeFileSync(path.join(dir, "important.txt"), "do not nuke");
    const r = await bootstrapInternalMirror(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("isn't a git repository");
      expect(r.error).toContain("Remove it");
    }
    // The operator's file is untouched.
    expect(fs.readFileSync(path.join(dir, "important.txt"), "utf-8")).toBe("do not nuke");
  });

  test("initializes an empty, non-git directory", async () => {
    dir = tmp("mirror-boot-empty-");
    expect(fs.readdirSync(dir)).toEqual([]);
    const r = await bootstrapInternalMirror(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.initialized).toBe(true);
      expect(isGitRepoSync(dir)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// MirrorManager.start — boot-time lifecycle matrix
// ---------------------------------------------------------------------------

describe("MirrorManager.start — lifecycle matrix", () => {
  let home: string;
  afterEach(async () => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("enabled: false → no mirror behavior (regression for upgrading vaults)", async () => {
    home = tmp("mgr-disabled-");
    // Seed the vault dir so vaultDir() resolves cleanly.
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: { ...defaultMirrorConfig(), enabled: false },
    });
    const mgr = new MirrorManager(deps);
    const status = await mgr.start();
    expect(status.enabled).toBe(false);
    expect(status.watch_running).toBe(false);
    expect(status.mirror_path).toBeNull();
    expect(deps.exportCalls).toHaveLength(0);
    await mgr.stop();
  });

  test("undefined config → behaves like disabled", async () => {
    home = tmp("mgr-undef-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const deps = makeFakeDeps({ parachuteHome: home, initialConfig: undefined });
    const mgr = new MirrorManager(deps);
    const status = await mgr.start();
    expect(status.enabled).toBe(false);
    expect(deps.exportCalls).toHaveLength(0);
    await mgr.stop();
  });

  test("internal + watch:false → bootstraps + runs initial export, no watch", async () => {
    home = tmp("mgr-int-nowatch-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: {
        ...defaultMirrorConfig(),
        enabled: true,
        location: "internal",
        watch: false,
        auto_commit: false, // skip commit cycle for this unit
      },
    });
    const mgr = new MirrorManager(deps);
    const status = await mgr.start();
    expect(status.enabled).toBe(true);
    expect(status.watch_running).toBe(false);
    expect(status.mirror_path).toBe(
      path.join(home, "vault", "data", "default", "mirror"),
    );
    expect(deps.exportCalls).toHaveLength(1);
    expect(deps.exportCalls[0]!.sinceCursor).toBeUndefined(); // initial = full
    // Bootstrapped on disk.
    expect(fs.existsSync(status.mirror_path!)).toBe(true);
    expect(isGitRepoSync(status.mirror_path!)).toBe(true);
    await mgr.stop();
  });

  test("internal + watch:true → bootstraps + runs initial export + arms watch", async () => {
    home = tmp("mgr-int-watch-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: {
        ...defaultMirrorConfig(),
        enabled: true,
        location: "internal",
        watch: true,
        auto_commit: false,
        interval_seconds: 1,
      },
    });
    const mgr = new MirrorManager(deps);
    const status = await mgr.start();
    expect(status.enabled).toBe(true);
    expect(status.watch_running).toBe(true);
    // Initial export ran.
    expect(deps.exportCalls).toHaveLength(1);
    await mgr.stop();
    expect(mgr.getStatus().watch_running).toBe(false);
  });

  test("external + watch:true with valid git repo → uses external path", async () => {
    home = tmp("mgr-ext-watch-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const external = tmp("mgr-ext-target-");
    initRepo(external);
    seedCommit(external);
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: {
        ...defaultMirrorConfig(),
        enabled: true,
        location: "external",
        external_path: external,
        watch: true,
        auto_commit: false,
        interval_seconds: 1,
      },
    });
    const mgr = new MirrorManager(deps);
    const status = await mgr.start();
    expect(status.enabled).toBe(true);
    expect(status.watch_running).toBe(true);
    expect(status.mirror_path).toBe(external);
    // Initial export pointed at the external path.
    expect(deps.exportCalls[0]!.outDir).toBe(external);
    await mgr.stop();
    fs.rmSync(external, { recursive: true, force: true });
  });

  test("external + missing path → enabled:false with clear error", async () => {
    home = tmp("mgr-ext-missing-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: {
        ...defaultMirrorConfig(),
        enabled: true,
        location: "external",
        external_path: "/definitely/not/a/path/here",
        watch: true,
      },
    });
    const mgr = new MirrorManager(deps);
    const status = await mgr.start();
    expect(status.enabled).toBe(false);
    expect(status.last_error).toContain("doesn't exist");
    expect(deps.exportCalls).toHaveLength(0);
    await mgr.stop();
  });

  test("external + path exists but not a git repo → enabled:false", async () => {
    home = tmp("mgr-ext-nogit-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const external = tmp("mgr-ext-plain-");
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: {
        ...defaultMirrorConfig(),
        enabled: true,
        location: "external",
        external_path: external,
      },
    });
    const mgr = new MirrorManager(deps);
    const status = await mgr.start();
    expect(status.enabled).toBe(false);
    expect(status.last_error).toContain("isn't a git repository");
    await mgr.stop();
    fs.rmSync(external, { recursive: true, force: true });
  });

  test("internal bootstrap refuses to clobber pre-existing non-git data", async () => {
    home = tmp("mgr-int-clobber-");
    const mirrorPath = path.join(home, "vault", "data", "default", "mirror");
    fs.mkdirSync(mirrorPath, { recursive: true });
    fs.writeFileSync(path.join(mirrorPath, "manual-note.md"), "user content");
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: {
        ...defaultMirrorConfig(),
        enabled: true,
        location: "internal",
        watch: false,
      },
    });
    const mgr = new MirrorManager(deps);
    const status = await mgr.start();
    expect(status.enabled).toBe(false);
    expect(status.last_error).toContain("isn't a git repository");
    // The operator's file survives.
    expect(fs.existsSync(path.join(mirrorPath, "manual-note.md"))).toBe(true);
    expect(deps.exportCalls).toHaveLength(0);
    await mgr.stop();
  });

  test("internal bootstrap reuses an existing git repo without re-init", async () => {
    home = tmp("mgr-int-reuse-");
    const mirrorPath = path.join(home, "vault", "data", "default", "mirror");
    fs.mkdirSync(mirrorPath, { recursive: true });
    initRepo(mirrorPath);
    seedCommit(mirrorPath);
    const before = commitCount(mirrorPath);
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: {
        ...defaultMirrorConfig(),
        enabled: true,
        location: "internal",
        watch: false,
        auto_commit: false,
      },
    });
    const mgr = new MirrorManager(deps);
    const status = await mgr.start();
    expect(status.enabled).toBe(true);
    // Did not re-bootstrap; the existing seed commit is still the only commit.
    expect(commitCount(mirrorPath)).toBe(before);
    await mgr.stop();
  });
});

// ---------------------------------------------------------------------------
// MirrorManager.stop + reload
// ---------------------------------------------------------------------------

describe("MirrorManager.stop / reload", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("stop() halts the watch timer", async () => {
    home = tmp("mgr-stop-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: {
        ...defaultMirrorConfig(),
        enabled: true,
        location: "internal",
        watch: true,
        auto_commit: false,
        interval_seconds: 1,
      },
    });
    const mgr = new MirrorManager(deps);
    await mgr.start();
    expect(mgr.getStatus().watch_running).toBe(true);
    await mgr.stop();
    expect(mgr.getStatus().watch_running).toBe(false);
  });

  test("reload() persists + restarts with new config", async () => {
    home = tmp("mgr-reload-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: undefined,
    });
    const mgr = new MirrorManager(deps);
    await mgr.start();
    expect(mgr.getStatus().enabled).toBe(false);

    // Enable + reload.
    const newConfig: MirrorConfig = {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
      watch: false,
      auto_commit: false,
    };
    const status = await mgr.reload(newConfig);
    expect(status.enabled).toBe(true);
    expect(deps.storedConfig).toEqual(newConfig);

    // Disable.
    const disabled = await mgr.reload({ ...newConfig, enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(mgr.getStatus().watch_running).toBe(false);
    await mgr.stop();
  });

  test("reload from internal → external swaps the mirror path", async () => {
    home = tmp("mgr-swap-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const external = tmp("mgr-swap-ext-");
    initRepo(external);
    seedCommit(external);
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: {
        ...defaultMirrorConfig(),
        enabled: true,
        location: "internal",
        watch: false,
        auto_commit: false,
      },
    });
    const mgr = new MirrorManager(deps);
    await mgr.start();
    const internalPath = mgr.getStatus().mirror_path;
    expect(internalPath).toContain(path.join("vault", "data", "default", "mirror"));

    const swapped = await mgr.reload({
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: external,
      watch: false,
      auto_commit: false,
    });
    expect(swapped.mirror_path).toBe(external);
    expect(deps.exportCalls.length).toBeGreaterThanOrEqual(2);
    await mgr.stop();
    fs.rmSync(external, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// runNow
// ---------------------------------------------------------------------------

describe("MirrorManager.runNow", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("runs a single cycle on demand when enabled", async () => {
    home = tmp("mgr-runnow-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: {
        ...defaultMirrorConfig(),
        enabled: true,
        location: "internal",
        watch: false,
        auto_commit: false,
      },
    });
    const mgr = new MirrorManager(deps);
    await mgr.start();
    expect(deps.exportCalls).toHaveLength(1); // initial
    await mgr.runNow();
    expect(deps.exportCalls).toHaveLength(2);
    // The non-initial run carries a cursor.
    expect(deps.exportCalls[1]!.sinceCursor).toBeDefined();
    await mgr.stop();
  });

  test("noop when disabled", async () => {
    home = tmp("mgr-runnow-disabled-");
    fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
    const deps = makeFakeDeps({
      parachuteHome: home,
      initialConfig: { ...defaultMirrorConfig(), enabled: false },
    });
    const mgr = new MirrorManager(deps);
    await mgr.start();
    await mgr.runNow();
    expect(deps.exportCalls).toHaveLength(0);
    await mgr.stop();
  });
});
