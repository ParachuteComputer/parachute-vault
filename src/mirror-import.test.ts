/**
 * Tests for the clone-and-import worker (vault#391).
 *
 * Mocks the git binary via the `spawn` injection point so we don't
 * actually clone anything in tests — instead we pre-populate the tempdir
 * the fake "clone" claims to have written, or have the fake return a
 * non-zero exit code to exercise the failure paths.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteStore } from "../core/src/store.ts";
import { exportVaultToDir } from "../core/src/portable-md.ts";
import {
  CloneFailedError,
  ImportConflictError,
  NotAVaultExportError,
  _isImportInFlight,
  _resetImportInFlightForTest,
  authedCloneUrl,
  cloneAndImport,
  type GitSpawn,
} from "./mirror-import.ts";
import {
  emptyCredentials,
  mirrorCredentialsPath,
  writeCredentials,
  type MirrorCredentials,
} from "./mirror-credentials.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Build a real portable-md export on disk + return its path. Used by tests
 * that need a valid clone-target so the import succeeds.
 */
async function buildExportFixture(opts?: { extraNotes?: number }): Promise<string> {
  const extraNotes = opts?.extraNotes ?? 0;
  const store = new SqliteStore(new Database(":memory:"));
  await store.createNote("alpha body", { id: "n-alpha", path: "alpha", tags: ["t1"] });
  await store.createNote("beta body", { id: "n-beta", path: "beta" });
  for (let i = 0; i < extraNotes; i++) {
    await store.createNote(`extra ${i}`, { id: `n-extra-${i}`, path: `extra-${i}` });
  }
  const exportDir = tmp("import-fixture-export-");
  await exportVaultToDir(store, {
    outDir: exportDir,
    vaultName: "source",
    exportedAt: "2026-05-28T00:00:00.000Z",
  });
  return exportDir;
}

/**
 * Build a fake spawn that copies a pre-baked fixture into the tempdir
 * the importer expects. Mimics what `git clone <url> <tempDir>` would do
 * on success: populate the tempDir with the fixture's contents.
 */
function spawnCloneSuccess(fixtureDir: string): GitSpawn {
  return async (argv) => {
    // argv = ["git", "clone", "--depth", "1", <url>, <destDir>]
    expect(argv[0]).toBe("git");
    expect(argv[1]).toBe("clone");
    const destDir = argv[argv.length - 1]!;
    // Copy fixture into the destination. The destination already exists
    // (mkdtempSync created it), so use cpSync's `recursive` mode.
    cpSync(fixtureDir, destDir, { recursive: true });
    return { exitCode: 0, stderr: "", timedOut: false };
  };
}

const spawnCloneFailure = (stderr: string): GitSpawn =>
  async () => ({ exitCode: 128, stderr, timedOut: false });

const spawnCloneTimeout: GitSpawn = async () => ({
  exitCode: -1,
  stderr: "",
  timedOut: true,
});

const ORIG_HOME = process.env.HOME;
const ORIG_PARACHUTE_HOME = process.env.PARACHUTE_HOME;

afterEach(() => {
  _resetImportInFlightForTest();
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_PARACHUTE_HOME === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = ORIG_PARACHUTE_HOME;
});

// ---------------------------------------------------------------------------
// authedCloneUrl
// ---------------------------------------------------------------------------

describe("authedCloneUrl", () => {
  test("returns null for unparseable URL", () => {
    expect(authedCloneUrl("not-a-url", { kind: "none" })).toBeNull();
  });

  test("passes git:// URLs verbatim (no userinfo to embed)", () => {
    // `git://github.com/owner/repo.git` parses as a URL with protocol
    // `git:`, not http/https — our helper returns it verbatim.
    const r = authedCloneUrl("git://github.com/owner/repo.git", { kind: "pat", token: "ghp_x" });
    expect(r).not.toBeNull();
    expect(r!.authedUrl).toBe("git://github.com/owner/repo.git");
    expect(r!.appliedAuth).toBe("none");
  });

  // Reviewer-flagged on vault#390 — the original ssh-shorthand assertion
  // accidentally tested `git://` instead of the `git@host:owner/repo`
  // shape, leaving the ssh-shorthand regex branch uncovered. SSH
  // shorthand doesn't parse as `new URL()` (no scheme), so authedCloneUrl
  // falls through the regex matcher and returns the URL verbatim — there
  // is no userinfo slot to embed a token into. This test pins that path.
  test("passes ssh-shorthand URLs verbatim (no scheme, no userinfo slot)", () => {
    const r = authedCloneUrl("git@github.com:owner/repo.git", {
      kind: "pat",
      token: "ghp_should_not_appear",
    });
    expect(r).not.toBeNull();
    expect(r!.authedUrl).toBe("git@github.com:owner/repo.git");
    expect(r!.authedUrl).not.toContain("ghp_should_not_appear");
    expect(r!.appliedAuth).toBe("none");
  });

  test("passes ssh:// URLs verbatim", () => {
    const r = authedCloneUrl("ssh://git@github.com/owner/repo.git", {
      kind: "pat",
      token: "ghp_x",
    });
    expect(r).not.toBeNull();
    expect(r!.authedUrl).toBe("ssh://git@github.com/owner/repo.git");
    expect(r!.appliedAuth).toBe("none");
  });

  test("does not override URL that already carries userinfo", () => {
    const r = authedCloneUrl("https://user:pass@github.com/owner/repo.git", {
      kind: "pat",
      token: "ghp_x",
    });
    expect(r).not.toBeNull();
    expect(r!.authedUrl).toContain("user:pass@");
    expect(r!.appliedAuth).toBe("none");
  });

  test("per-call PAT embeds x-access-token user", () => {
    const r = authedCloneUrl("https://github.com/owner/repo.git", {
      kind: "pat",
      token: "ghp_abc123",
    });
    expect(r).not.toBeNull();
    expect(r!.authedUrl).toContain("x-access-token:ghp_abc123@");
    expect(r!.appliedAuth).toBe("per_call_pat");
  });

  test("none auth returns verbatim URL", () => {
    const r = authedCloneUrl("https://github.com/owner/repo.git", { kind: "none" });
    expect(r).not.toBeNull();
    expect(r!.authedUrl).toBe("https://github.com/owner/repo.git");
    expect(r!.appliedAuth).toBe("none");
  });

  describe("credentialsFile path", () => {
    let home: string;
    beforeEach(() => {
      home = tmp("import-creds-");
      process.env.PARACHUTE_HOME = home;
      process.env.HOME = home;
    });
    afterEach(() => {
      if (home) rmSync(home, { recursive: true, force: true });
    });

    test("no credentials file → verbatim URL", () => {
      const r = authedCloneUrl("https://github.com/owner/repo.git", { kind: "credentialsFile" });
      expect(r!.appliedAuth).toBe("none");
    });

    test("stored github_oauth credentials → embed token on github.com", () => {
      const creds: MirrorCredentials = {
        ...emptyCredentials(),
        active_method: "github_oauth",
        github_oauth: {
          access_token: "gho_abc",
          scope: "repo",
          authorized_at: "2026-05-28T00:00:00.000Z",
          user_login: "aaron",
          user_id: 1,
        },
      };
      writeCredentials(creds);
      const r = authedCloneUrl("https://github.com/owner/repo.git", { kind: "credentialsFile" });
      expect(r!.authedUrl).toContain("x-access-token:gho_abc@");
      expect(r!.appliedAuth).toBe("stored_oauth");
    });

    test("stored github_oauth + non-github host → verbatim (OAuth token is useless off-host)", () => {
      const creds: MirrorCredentials = {
        ...emptyCredentials(),
        active_method: "github_oauth",
        github_oauth: {
          access_token: "gho_abc",
          scope: "repo",
          authorized_at: "2026-05-28T00:00:00.000Z",
          user_login: "aaron",
          user_id: 1,
        },
      };
      writeCredentials(creds);
      const r = authedCloneUrl("https://gitlab.com/owner/repo.git", { kind: "credentialsFile" });
      expect(r!.appliedAuth).toBe("none");
    });

    test("stored PAT + matching host → embed token", () => {
      const creds: MirrorCredentials = {
        ...emptyCredentials(),
        active_method: "pat",
        pat: {
          token: "glpat_xyz",
          remote_url: "https://x-access-token:glpat_xyz@gitlab.com/owner/repo.git",
          label: "GitLab PAT",
        },
      };
      writeCredentials(creds);
      const r = authedCloneUrl("https://gitlab.com/owner/repo.git", { kind: "credentialsFile" });
      expect(r!.authedUrl).toContain("x-access-token:glpat_xyz@");
      expect(r!.appliedAuth).toBe("stored_pat");
    });

    test("stored PAT + non-matching host → verbatim", () => {
      const creds: MirrorCredentials = {
        ...emptyCredentials(),
        active_method: "pat",
        pat: {
          token: "glpat_xyz",
          remote_url: "https://x-access-token:glpat_xyz@gitlab.com/owner/repo.git",
          label: "GitLab PAT",
        },
      };
      writeCredentials(creds);
      const r = authedCloneUrl("https://github.com/owner/repo.git", { kind: "credentialsFile" });
      expect(r!.appliedAuth).toBe("none");
    });
  });
});

// ---------------------------------------------------------------------------
// cloneAndImport — success path
// ---------------------------------------------------------------------------

describe("cloneAndImport — success", () => {
  let fixtureDir: string;
  let assetsDir: string;
  let store: SqliteStore;

  beforeEach(async () => {
    fixtureDir = await buildExportFixture();
    assetsDir = tmp("import-assets-");
    store = new SqliteStore(new Database(":memory:"));
  });

  afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    if (assetsDir) rmSync(assetsDir, { recursive: true, force: true });
  });

  test("merge mode — imports notes from a fixture export", async () => {
    const result = await cloneAndImport({
      vaultName: "default",
      remoteUrl: "https://github.com/owner/repo.git",
      auth: { kind: "none" },
      mode: "merge",
      store,
      assetsDir,
      spawn: spawnCloneSuccess(fixtureDir),
    });
    expect(result.notes_imported).toBe(2); // alpha + beta
    expect(result.notes_deleted).toBeUndefined();
    expect(result.warnings).toEqual([]);

    const restored = await store.getNote("n-alpha");
    expect(restored).toBeTruthy();
    expect(restored!.content.trimEnd()).toBe("alpha body");
  });

  test("merge mode — preserves existing notes that aren't in the remote", async () => {
    // Seed a local note that the remote doesn't carry.
    await store.createNote("local-only", { id: "n-local", path: "local" });
    const result = await cloneAndImport({
      vaultName: "default",
      remoteUrl: "https://github.com/owner/repo.git",
      auth: { kind: "none" },
      mode: "merge",
      store,
      assetsDir,
      spawn: spawnCloneSuccess(fixtureDir),
    });
    expect(result.notes_imported).toBe(2);
    expect(result.notes_deleted).toBeUndefined();
    // Local note survives.
    const localStill = await store.getNote("n-local");
    expect(localStill).toBeTruthy();
  });

  test("replace mode — wipes existing notes, sets notes_deleted", async () => {
    await store.createNote("local-only", { id: "n-local", path: "local" });
    const result = await cloneAndImport({
      vaultName: "default",
      remoteUrl: "https://github.com/owner/repo.git",
      auth: { kind: "none" },
      mode: "replace",
      store,
      assetsDir,
      spawn: spawnCloneSuccess(fixtureDir),
    });
    expect(result.notes_imported).toBe(2);
    expect(result.notes_deleted).toBe(1);
    // Local note got wiped before the import replayed.
    const localGone = await store.getNote("n-local");
    expect(localGone).toBeNull();
  });

  test("cleans up tempdir on success", async () => {
    const workDirRoot = tmp("import-workroot-");
    await cloneAndImport({
      vaultName: "default",
      remoteUrl: "https://github.com/owner/repo.git",
      auth: { kind: "none" },
      mode: "merge",
      store,
      assetsDir,
      spawn: spawnCloneSuccess(fixtureDir),
      workDirRoot,
    });
    // workDirRoot itself still exists; the parachute-import-<rand> subdir
    // inside it should be gone.
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(workDirRoot);
    expect(entries.filter((e) => e.startsWith("parachute-import-"))).toEqual([]);
    rmSync(workDirRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// cloneAndImport — failure paths
// ---------------------------------------------------------------------------

describe("cloneAndImport — failures", () => {
  let assetsDir: string;
  let store: SqliteStore;

  beforeEach(() => {
    assetsDir = tmp("import-assets-fail-");
    store = new SqliteStore(new Database(":memory:"));
  });

  afterEach(() => {
    if (assetsDir) rmSync(assetsDir, { recursive: true, force: true });
  });

  test("invalid URL → CloneFailedError before any spawn", async () => {
    let spawnCalled = false;
    const fakeSpawn: GitSpawn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stderr: "", timedOut: false };
    };
    await expect(
      cloneAndImport({
        vaultName: "default",
        remoteUrl: "not-a-url",
        auth: { kind: "none" },
        mode: "merge",
        store,
        assetsDir,
        spawn: fakeSpawn,
      }),
    ).rejects.toThrow(CloneFailedError);
    expect(spawnCalled).toBe(false);
  });

  test("git clone non-zero exit → CloneFailedError with redacted stderr", async () => {
    await expect(
      cloneAndImport({
        vaultName: "default",
        remoteUrl: "https://github.com/owner/repo.git",
        auth: { kind: "pat", token: "ghp_secret" },
        mode: "merge",
        store,
        assetsDir,
        spawn: spawnCloneFailure(
          "fatal: could not read Password for 'https://x-access-token:ghp_secret@github.com'",
        ),
      }),
    ).rejects.toThrow(/git clone failed/);

    // Re-run to capture the error message; ensure the token is redacted.
    try {
      await cloneAndImport({
        vaultName: "default",
        remoteUrl: "https://github.com/owner/repo.git",
        auth: { kind: "pat", token: "ghp_secret" },
        mode: "merge",
        store,
        assetsDir,
        spawn: spawnCloneFailure(
          "fatal: could not read Password for 'https://x-access-token:ghp_secret@github.com'",
        ),
      });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("ghp_secret");
      expect(message).toContain("***@");
    }
  });

  test("clone timeout → CloneFailedError mentioning timeout", async () => {
    await expect(
      cloneAndImport({
        vaultName: "default",
        remoteUrl: "https://github.com/owner/repo.git",
        auth: { kind: "none" },
        mode: "merge",
        store,
        assetsDir,
        spawn: spawnCloneTimeout,
        cloneTimeoutMs: 100,
      }),
    ).rejects.toThrow(/timed out/);
  });

  test("clone target lacks .parachute/vault.yaml → NotAVaultExportError", async () => {
    const notAnExport = tmp("import-not-export-");
    writeFileSync(join(notAnExport, "README.md"), "hello");
    const fakeSpawn: GitSpawn = async (argv) => {
      const dest = argv[argv.length - 1]!;
      cpSync(notAnExport, dest, { recursive: true });
      return { exitCode: 0, stderr: "", timedOut: false };
    };
    await expect(
      cloneAndImport({
        vaultName: "default",
        remoteUrl: "https://github.com/owner/repo.git",
        auth: { kind: "none" },
        mode: "merge",
        store,
        assetsDir,
        spawn: fakeSpawn,
      }),
    ).rejects.toThrow(NotAVaultExportError);
    rmSync(notAnExport, { recursive: true, force: true });
  });

  test("concurrent imports against the same vault → ImportConflictError", async () => {
    // Build a real fixture so the long-running clone has something
    // valid to find.
    const fixture = await buildExportFixture();

    // First import — slow spawn (resolves on the next tick), but starts
    // immediately.
    let firstSpawnGate: (v?: unknown) => void;
    const firstSpawn: GitSpawn = async (argv) => {
      await new Promise((res) => {
        firstSpawnGate = res;
      });
      const dest = argv[argv.length - 1]!;
      cpSync(fixture, dest, { recursive: true });
      return { exitCode: 0, stderr: "", timedOut: false };
    };

    const firstPromise = cloneAndImport({
      vaultName: "default",
      remoteUrl: "https://github.com/owner/repo.git",
      auth: { kind: "none" },
      mode: "merge",
      store,
      assetsDir,
      spawn: firstSpawn,
    });

    // Wait a tick so the inFlight set has populated.
    await new Promise((res) => setTimeout(res, 10));
    expect(_isImportInFlight("default")).toBe(true);

    // Second import — should immediately reject.
    await expect(
      cloneAndImport({
        vaultName: "default",
        remoteUrl: "https://github.com/owner/repo.git",
        auth: { kind: "none" },
        mode: "merge",
        store,
        assetsDir,
        spawn: spawnCloneSuccess(fixture),
      }),
    ).rejects.toThrow(ImportConflictError);

    // Let the first import finish.
    firstSpawnGate!();
    await firstPromise;
    expect(_isImportInFlight("default")).toBe(false);

    rmSync(fixture, { recursive: true, force: true });
  });

  test("cleans up tempdir even when import throws", async () => {
    const workDirRoot = tmp("import-workroot-fail-");
    const notAnExport = tmp("import-not-export-fail-");
    writeFileSync(join(notAnExport, "README.md"), "hello");
    const fakeSpawn: GitSpawn = async (argv) => {
      const dest = argv[argv.length - 1]!;
      cpSync(notAnExport, dest, { recursive: true });
      return { exitCode: 0, stderr: "", timedOut: false };
    };
    await expect(
      cloneAndImport({
        vaultName: "default",
        remoteUrl: "https://github.com/owner/repo.git",
        auth: { kind: "none" },
        mode: "merge",
        store,
        assetsDir,
        spawn: fakeSpawn,
        workDirRoot,
      }),
    ).rejects.toThrow();
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(workDirRoot);
    expect(entries.filter((e) => e.startsWith("parachute-import-"))).toEqual([]);
    rmSync(workDirRoot, { recursive: true, force: true });
    rmSync(notAnExport, { recursive: true, force: true });
  });
});
