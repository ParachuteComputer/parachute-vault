/**
 * Tests for `parachute-vault export --watch` and `--git-commit`.
 *
 * Three layers:
 *
 *   1. Pure helpers in `export-watch.ts` — `renderCommitMessage`,
 *      `shouldCommit`. No I/O.
 *   2. Git-shell helpers — `isGitRepo`, `gitAddAll`, `gitCommit`,
 *      `listStagedFiles`, `runGitCommitCycle`. Spawn real `git` against a
 *      throwaway repo in a tempdir.
 *   3. CLI end-to-end — spawn `bun src/cli.ts export …` against an isolated
 *      `PARACHUTE_HOME` with a seeded vault. Covers the flag-parsing surface
 *      (single-shot + --git-commit) and the watch-loop happy paths via the
 *      `--interval` knob set to a small value.
 *
 * Watch-loop tests use child process kill/timeout discipline: spawn, wait
 * for the expected log line (or timeout cap), then SIGINT and assert
 * graceful exit. No real wall-clock sleeps longer than the interval.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_COMMIT_TEMPLATE,
  gitAddAll,
  gitCommit,
  gitPush,
  gitUnstageAll,
  isGitRepo,
  listStagedFiles,
  renderCommitMessage,
  runGitCommitCycle,
  shouldCommit,
} from "./export-watch.ts";
import { GitNotInstalledError } from "./git-preflight.ts";

const CLI = path.resolve(import.meta.dir, "cli.ts");

// Capture HOME / PARACHUTE_HOME at module load so `seedVaultWithNotes`'s
// in-process env mutation (required for the deferred `vault-store.ts`
// re-import to see PARACHUTE_HOME) can be reverted between tests. Without
// this, the polluted HOME leaks into later tests in the same process — most
// visibly into `resolveInstallTarget` (mcp-install.test.ts), which reads
// `process.env.HOME` directly and would otherwise return paths under the
// tmpdir. Linux-only failure because macOS BSD developers were less likely
// to notice in dev; CI on Linux exposed it after the tag-triggered release
// workflow landed (vault#361). See vault#363.
const ORIG_HOME = process.env.HOME;
const ORIG_PARACHUTE_HOME = process.env.PARACHUTE_HOME;

function restoreHomeEnv(): void {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_PARACHUTE_HOME === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = ORIG_PARACHUTE_HOME;
}

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupBareVault(parachuteHome: string, name: string): void {
  const vaultsDir = path.join(parachuteHome, "vault", "data");
  fs.mkdirSync(path.join(vaultsDir, name), { recursive: true });
  fs.writeFileSync(
    path.join(vaultsDir, name, "vault.yaml"),
    `name: ${name}\napi_keys: []\n`,
  );
  const globalPath = path.join(parachuteHome, "vault", "config.yaml");
  if (!fs.existsSync(globalPath)) {
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, `default_vault: ${name}\nport: 1940\n`);
  }
}

/**
 * Seed a SQLite vault DB at the path the server would use, populated with
 * `n` notes. Returns the store handle so the test can write more notes
 * mid-test (to simulate a live vault under a watch loop).
 */
async function seedVaultWithNotes(
  parachuteHome: string,
  vaultName: string,
  notes: Array<{ id?: string; path: string; content: string; tags?: string[] }>,
) {
  // Defer imports so they read `PARACHUTE_HOME` from the env we set just
  // before calling this helper.
  process.env.PARACHUTE_HOME = parachuteHome;
  process.env.HOME = parachuteHome;
  const { clearVaultStoreCache, getVaultStore } = await import("./vault-store.ts");
  clearVaultStoreCache();
  const store = getVaultStore(vaultName);
  for (const n of notes) {
    await store.createNote(n.content, {
      ...(n.id ? { id: n.id } : {}),
      path: n.path,
      ...(n.tags ? { tags: n.tags } : {}),
    });
  }
  return store;
}

function initGitRepo(dir: string): void {
  // Each test gets a brand-new repo. Set user.email/name locally so commits
  // succeed without depending on the dev's global git config.
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@parachute.computer"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Parachute Test"], { cwd: dir });
  Bun.spawnSync(["git", "config", "commit.gpgsign", "false"], { cwd: dir });
}

function gitLogOneline(dir: string): string[] {
  const proc = Bun.spawnSync(["git", "log", "--oneline"], { cwd: dir, stdout: "pipe" });
  return new TextDecoder()
    .decode(proc.stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function gitLastCommitMessage(dir: string): string {
  const proc = Bun.spawnSync(["git", "log", "-1", "--pretty=%B"], { cwd: dir, stdout: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim();
}

function runCli(
  args: string[],
  parachuteHome: string,
  extraEnv: Record<string, string | undefined> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    cwd: parachuteHome,
    env: {
      ...process.env,
      PARACHUTE_HOME: parachuteHome,
      HOME: parachuteHome,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe("renderCommitMessage", () => {
  test("substitutes all documented vars", () => {
    const msg = renderCommitMessage(
      "{{date}} | {{notes_changed}} | {{plural}} | {{first_note_title}} | {{vault_name}}",
      {
        date: "2026-05-20T15:42:01Z",
        notes_changed: 3,
        first_note_title: "Inbox/2026-05-20",
        vault_name: "gitcoin",
      },
    );
    expect(msg).toBe("2026-05-20T15:42:01Z | 3 | s | Inbox/2026-05-20 | gitcoin");
  });

  test("{{plural}} is empty when notes_changed === 1", () => {
    const msg = renderCommitMessage("{{notes_changed}} note{{plural}}", {
      date: "x",
      notes_changed: 1,
      first_note_title: "",
      vault_name: "v",
    });
    expect(msg).toBe("1 note");
  });

  test("{{plural}} is 's' when notes_changed === 0", () => {
    // "0 notes" reads correctly — pluralize unless exactly one.
    const msg = renderCommitMessage("{{notes_changed}} note{{plural}}", {
      date: "x",
      notes_changed: 0,
      first_note_title: "",
      vault_name: "v",
    });
    expect(msg).toBe("0 notes");
  });

  test("default template renders the expected shape", () => {
    const msg = renderCommitMessage(DEFAULT_COMMIT_TEMPLATE, {
      date: "2026-05-20T00:00:00Z",
      notes_changed: 2,
      first_note_title: "",
      vault_name: "default",
    });
    expect(msg).toBe("export: 2026-05-20T00:00:00Z (2 notes)");
  });

  test("unknown tokens pass through untouched (typo-visible)", () => {
    const msg = renderCommitMessage("{{not_a_var}} and {{date}}", {
      date: "now",
      notes_changed: 0,
      first_note_title: "",
      vault_name: "",
    });
    expect(msg).toBe("{{not_a_var}} and now");
  });

  test("repeated tokens are all substituted", () => {
    const msg = renderCommitMessage("{{date}} / {{date}}", {
      date: "X",
      notes_changed: 0,
      first_note_title: "",
      vault_name: "",
    });
    expect(msg).toBe("X / X");
  });
});

describe("shouldCommit", () => {
  test("empty staging → skip", () => {
    expect(shouldCommit([], 0)).toEqual({ commit: false, reason: "empty" });
    expect(shouldCommit([], 5)).toEqual({ commit: false, reason: "empty" });
  });

  test("note changes → commit even if .parachute/ also dirty", () => {
    expect(
      shouldCommit([".parachute/vault.yaml", "Inbox/foo.md"], 1),
    ).toEqual({ commit: true, reason: "ok" });
  });

  test("only .parachute/ + no notes changed → skip (filter exported_at churn)", () => {
    expect(shouldCommit([".parachute/vault.yaml"], 0)).toEqual({
      commit: false,
      reason: "parachute_meta_only",
    });
  });

  test("only .parachute/ + nonzero notes_changed → commit (defensive)", () => {
    // notes_changed > 0 means real work happened even if its files don't
    // appear in the staged set (could be tags-only schema export edge); we
    // trust the stats over the staging filter.
    expect(shouldCommit([".parachute/schemas/foo.yaml"], 1)).toEqual({
      commit: true,
      reason: "ok",
    });
  });

  test("non-parachute file + zero notes_changed → commit", () => {
    // Probably a manual edit in the export dir — defensive: commit it.
    // Watch loop doesn't put us here normally, but the rule should be
    // total over the staged set.
    expect(shouldCommit(["Inbox/foo.md"], 0)).toEqual({
      commit: true,
      reason: "ok",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Git-shell helpers
// ---------------------------------------------------------------------------

describe("git-shell helpers", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmp("vault-git-helpers-");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("isGitRepo: false in a fresh directory, true after `git init`", async () => {
    expect(await isGitRepo(dir)).toBe(false);
    initGitRepo(dir);
    expect(await isGitRepo(dir)).toBe(true);
  });

  test("gitAddAll + listStagedFiles: stage everything", async () => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "a.md"), "# a\n");
    fs.writeFileSync(path.join(dir, "b.md"), "# b\n");
    const add = await gitAddAll(dir);
    expect(add.ok).toBe(true);
    const staged = await listStagedFiles(dir);
    expect(staged.sort()).toEqual(["a.md", "b.md"]);
  });

  test("gitCommit lands a real commit with the given message", async () => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "a.md"), "# a\n");
    await gitAddAll(dir);
    const result = await gitCommit(dir, "test: first commit");
    expect(result.ok).toBe(true);
    expect(gitLastCommitMessage(dir)).toBe("test: first commit");
    expect(gitLogOneline(dir)).toHaveLength(1);
  });

  test("gitUnstageAll works on a fresh repo with no commits (no HEAD yet)", async () => {
    // Regression for vault#346 reviewer note: prior version used `git reset
    // HEAD -- .` which fails on a fresh repo before any commit. The
    // .parachute/-only skip path on the first cycle would leave staging
    // dirty. Verify `git restore --staged .` clears staging cleanly.
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "a.md"), "# a\n");
    await gitAddAll(dir);
    expect(await listStagedFiles(dir)).toEqual(["a.md"]);
    await gitUnstageAll(dir);
    expect(await listStagedFiles(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2b. gitPush — first-push upstream tracking (Cut 4 of vault#392)
//
// A freshly-bootstrapped mirror has commits but no upstream branch.
// Bare `git push` fails with "fatal: The current branch X has no upstream
// branch." gitPush now detects the missing-upstream case and falls back
// to `git push -u origin <branch>`. Subsequent pushes go bare.
// ---------------------------------------------------------------------------

describe("gitPush — upstream tracking", () => {
  let workdir: string;
  let remote: string;
  beforeEach(() => {
    workdir = makeTmp("vault-push-work-");
    remote = makeTmp("vault-push-remote-");
    // Bare repo as the "remote" — `git push` to it lands like any real remote.
    Bun.spawnSync(["git", "init", "--bare", "-q", "-b", "main"], { cwd: remote });
    initGitRepo(workdir);
    Bun.spawnSync(["git", "remote", "add", "origin", remote], { cwd: workdir });
    fs.writeFileSync(path.join(workdir, "seed.md"), "# seed\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: workdir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "initial"], { cwd: workdir });
  });
  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });

  test("first push to a fresh remote establishes upstream tracking", async () => {
    // Pre-Cut-4 this failed with "no upstream branch."
    const result = await gitPush(workdir);
    expect(result.ok).toBe(true);
    // Verify upstream is now set so subsequent pushes can be bare.
    const upstream = Bun.spawnSync(
      ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd: workdir, stdout: "pipe" },
    );
    expect(upstream.exitCode).toBe(0);
    expect(
      new TextDecoder().decode(upstream.stdout).trim(),
    ).toBe("origin/main");
  });

  test("subsequent push (upstream already set) succeeds bare", async () => {
    // First push wires the upstream.
    await gitPush(workdir);
    // Make another commit, push again — should succeed.
    fs.writeFileSync(path.join(workdir, "n.md"), "# n\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: workdir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "second"], { cwd: workdir });
    const result = await gitPush(workdir);
    expect(result.ok).toBe(true);
  });

  test("push with no remote configured surfaces the error (back-compat)", async () => {
    // Same shape as the existing "no remote" test in runGitCommitCycle —
    // the branch probe returns a branch but no upstream, gitPush falls
    // back to `git push -u origin main`, which fails because there's no
    // `origin` remote configured.
    const localOnly = makeTmp("vault-push-noremote-");
    initGitRepo(localOnly);
    fs.writeFileSync(path.join(localOnly, "x.md"), "# x\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: localOnly });
    Bun.spawnSync(["git", "commit", "-q", "-m", "x"], { cwd: localOnly });
    const result = await gitPush(localOnly);
    expect(result.ok).toBe(false);
    // Doesn't matter what the exact error is — just that it's non-fatal
    // (gitPush returns rather than throws).
    expect(typeof result.stderr).toBe("string");
    fs.rmSync(localOnly, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 3. runGitCommitCycle — stage → decide → commit → push
// ---------------------------------------------------------------------------

describe("runGitCommitCycle", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmp("vault-commit-cycle-");
    initGitRepo(dir);
    // Seed an initial commit so HEAD exists — `git commit` on a fresh repo
    // with no parent works, but the test mostly assumes a non-empty history.
    fs.writeFileSync(path.join(dir, ".gitkeep"), "");
    Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "initial"], { cwd: dir });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("commits when there are real note changes", async () => {
    fs.writeFileSync(path.join(dir, "Inbox.md"), "# Inbox\n");
    const result = await runGitCommitCycle({
      repoDir: dir,
      template: DEFAULT_COMMIT_TEMPLATE,
      notesChanged: 1,
      vaultName: "default",
      firstNoteTitle: "Inbox",
      push: false,
      now: () => "2026-05-20T15:42:01Z",
    });
    expect(result.committed).toBe(true);
    expect(result.message).toBe("export: 2026-05-20T15:42:01Z (1 note)");
    expect(gitLastCommitMessage(dir)).toBe("export: 2026-05-20T15:42:01Z (1 note)");
  });

  test("skips commit when nothing is staged", async () => {
    // No new files since the seed commit.
    const result = await runGitCommitCycle({
      repoDir: dir,
      template: DEFAULT_COMMIT_TEMPLATE,
      notesChanged: 0,
      vaultName: "default",
      firstNoteTitle: "",
      push: false,
    });
    expect(result.committed).toBe(false);
    expect(gitLogOneline(dir)).toHaveLength(1); // only the seed
  });

  test("skips when only .parachute/ metadata changed (and notes_changed=0)", async () => {
    fs.mkdirSync(path.join(dir, ".parachute"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".parachute", "vault.yaml"),
      "exported_at: 2026-05-20T00:00:00Z\nexport_format_version: 1\n",
    );
    const result = await runGitCommitCycle({
      repoDir: dir,
      template: DEFAULT_COMMIT_TEMPLATE,
      notesChanged: 0,
      vaultName: "default",
      firstNoteTitle: "",
      push: false,
    });
    expect(result.committed).toBe(false);
    // History unchanged.
    expect(gitLogOneline(dir)).toHaveLength(1);
    // Staging area cleared so the next cycle starts clean.
    expect(await listStagedFiles(dir)).toEqual([]);
  });

  test("commits when .parachute/ AND a note changed", async () => {
    fs.mkdirSync(path.join(dir, ".parachute"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".parachute", "vault.yaml"), "x\n");
    fs.writeFileSync(path.join(dir, "Note.md"), "# n\n");
    const result = await runGitCommitCycle({
      repoDir: dir,
      template: "test: {{notes_changed}}",
      notesChanged: 1,
      vaultName: "default",
      firstNoteTitle: "Note",
      push: false,
    });
    expect(result.committed).toBe(true);
    expect(gitLastCommitMessage(dir)).toBe("test: 1");
  });

  test("--git-push failure is non-fatal (no remote configured)", async () => {
    fs.writeFileSync(path.join(dir, "Note.md"), "# n\n");
    // No remote — `git push` will fail. runGitCommitCycle should still
    // return committed=true (the commit landed) and not throw.
    const result = await runGitCommitCycle({
      repoDir: dir,
      template: "test push",
      notesChanged: 1,
      vaultName: "default",
      firstNoteTitle: "Note",
      push: true,
    });
    expect(result.committed).toBe(true);
    // Commit landed even though push failed.
    expect(gitLogOneline(dir)).toHaveLength(2); // seed + new
  });

  test("first_note_title substitutes into single-note commit messages", async () => {
    fs.writeFileSync(path.join(dir, "DonorMeeting.md"), "# d\n");
    const result = await runGitCommitCycle({
      repoDir: dir,
      template: "note: {{first_note_title}}",
      notesChanged: 1,
      vaultName: "gitcoin",
      firstNoteTitle: "Inbox/DonorMeeting",
      push: false,
    });
    expect(result.message).toBe("note: Inbox/DonorMeeting");
  });

  test("git missing → throws GitNotInstalledError (sync surfaces friendly error, not raw spawn crash)", async () => {
    // vault#415 — the sync/commit path must surface the actionable
    // git-not-installed message (which the manager threads into
    // status.last_error) instead of crashing with a raw "Executable not
    // found in $PATH". Force the preflight to see no git via the `which`
    // seam; no real spawn should be reached.
    fs.writeFileSync(path.join(dir, "Note.md"), "# n\n");
    await expect(
      runGitCommitCycle({
        repoDir: dir,
        template: DEFAULT_COMMIT_TEMPLATE,
        notesChanged: 1,
        vaultName: "default",
        firstNoteTitle: "Note",
        push: false,
        which: () => null,
      }),
    ).rejects.toBeInstanceOf(GitNotInstalledError);
    // The commit cycle bailed at the preflight — no commit landed.
    expect(gitLogOneline(dir)).toHaveLength(1); // only the seed
  });
});

// ---------------------------------------------------------------------------
// 4. CLI end-to-end — single-shot mode
// ---------------------------------------------------------------------------

describe("export CLI: single-shot", () => {
  let tmp: string;
  let exportDir: string;

  beforeEach(async () => {
    tmp = makeTmp("vault-export-cli-");
    exportDir = makeTmp("vault-export-out-");
    setupBareVault(tmp, "default");
    await seedVaultWithNotes(tmp, "default", [
      { id: "01HZA111111111111111111111", path: "Inbox/note-a", content: "# a\n" },
      { id: "01HZA222222222222222222222", path: "Inbox/note-b", content: "# b\n" },
    ]);
  });

  afterEach(async () => {
    // Close cached stores before the tempdir disappears — otherwise the
    // next test's reset trips a "vault not found" against a dangling
    // SQLite handle pointing at a deleted file.
    const { clearVaultStoreCache } = await import("./vault-store.ts");
    clearVaultStoreCache();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(exportDir, { recursive: true, force: true });
    restoreHomeEnv();
  });

  test("--git-commit requires an initialized git repo (clear error)", () => {
    const res = runCli(["export", exportDir, "--git-commit"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--git-commit requires");
    expect(res.stderr).toContain("git init");
  });

  test("--git-commit on a real repo: export → commit", () => {
    initGitRepo(exportDir);
    // Seed a commit so the export commit is a delta.
    fs.writeFileSync(path.join(exportDir, ".gitkeep"), "");
    Bun.spawnSync(["git", "add", "-A"], { cwd: exportDir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "initial"], { cwd: exportDir });

    const res = runCli(["export", exportDir, "--git-commit"], tmp);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("[git-commit] export:");
    const log = gitLogOneline(exportDir);
    expect(log.length).toBe(2); // initial + export
    expect(gitLastCommitMessage(exportDir)).toMatch(/^export: /);
    expect(gitLastCommitMessage(exportDir)).toContain("2 notes");
    // Sanity: the export landed on disk.
    expect(fs.existsSync(path.join(exportDir, ".parachute", "vault.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, "Inbox", "note-a.md"))).toBe(true);
  });

  test("--git-commit with custom template renders correctly", () => {
    initGitRepo(exportDir);
    fs.writeFileSync(path.join(exportDir, ".gitkeep"), "");
    Bun.spawnSync(["git", "add", "-A"], { cwd: exportDir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "initial"], { cwd: exportDir });

    const res = runCli(
      [
        "export",
        exportDir,
        "--git-commit",
        "--git-message-template",
        "vault {{vault_name}}: {{notes_changed}} note{{plural}}",
      ],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    expect(gitLastCommitMessage(exportDir)).toBe("vault default: 2 notes");
  });

  test("--git-commit on a second export with no changes: skips commit", () => {
    initGitRepo(exportDir);
    fs.writeFileSync(path.join(exportDir, ".gitkeep"), "");
    Bun.spawnSync(["git", "add", "-A"], { cwd: exportDir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "initial"], { cwd: exportDir });

    // First export — commits.
    const first = runCli(["export", exportDir, "--git-commit"], tmp);
    expect(first.exitCode).toBe(0);
    const afterFirst = gitLogOneline(exportDir).length;
    expect(afterFirst).toBe(2);

    // Second export — only .parachute/vault.yaml's exported_at changes, so
    // we expect a skip-message and no new commit.
    const second = runCli(
      ["export", exportDir, "--git-commit", "--since", "2999-01-01T00:00:00Z"],
      tmp,
    );
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("skipping commit");
    expect(gitLogOneline(exportDir).length).toBe(afterFirst);
  });

  test("--interval without --watch is a usage error", () => {
    const res = runCli(["export", exportDir, "--interval", "2"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--interval only applies with --watch");
  });

  test("--git-push without --git-commit is a usage error", () => {
    const res = runCli(["export", exportDir, "--git-push"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--git-push / --git-message-template only apply with --git-commit");
  });

  test("{{first_note_title}} resolves to the actual updated note (end-to-end)", async () => {
    // Regression test for vault#346 reviewer note: previously
    // firstChangedNoteTitle used `sort: "asc"` + `limit: 1` + a client-side
    // `stamp >= cursor` post-filter, which fetched the vault's *oldest*
    // note and almost always failed the post-filter — rendering
    // {{first_note_title}} as "" in production. The fix moves the filter
    // to the DB via dateFilter; this test exercises the full CLI to catch
    // a regression that the helper-unit tests (which inject the title)
    // can't see.
    initGitRepo(exportDir);
    fs.writeFileSync(path.join(exportDir, ".gitkeep"), "");
    Bun.spawnSync(["git", "add", "-A"], { cwd: exportDir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "initial"], { cwd: exportDir });

    // Capture a cursor strictly after the seed notes were created, then
    // add a fresh note whose `updated_at` is after the cursor.
    await new Promise((r) => setTimeout(r, 10));
    const cursor = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    await seedVaultWithNotes(tmp, "default", [
      {
        id: "01HZN111111111111111111111",
        path: "Inbox/DonorMeeting",
        content: "# fresh\n",
      },
    ]);
    const { clearVaultStoreCache } = await import("./vault-store.ts");
    clearVaultStoreCache();

    const res = runCli(
      [
        "export",
        exportDir,
        "--since",
        cursor,
        "--git-commit",
        "--git-message-template",
        "note: {{first_note_title}}",
      ],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    const last = gitLastCommitMessage(exportDir);
    // The fix renders "Inbox/DonorMeeting"; the bug rendered "note: ".
    expect(last).toBe("note: Inbox/DonorMeeting");
  });

  test("--git-message-template without --git-commit is a usage error", () => {
    // Same guard as --git-push but covers the template-only misuse path —
    // an operator who set just the template (e.g. via shell history) and
    // forgot --git-commit would otherwise silently do a plain export.
    const res = runCli(
      ["export", exportDir, "--git-message-template", "hi"],
      tmp,
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(
      "--git-push / --git-message-template only apply with --git-commit",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. CLI end-to-end — --watch loop
// ---------------------------------------------------------------------------

/**
 * Spawn the CLI as a streaming child process for watch tests. Returns the
 * process handle + an awaitWatchLine helper that resolves when stdout
 * surfaces a line matching `predicate` (or rejects on timeout).
 */
function spawnWatchCli(args: string[], parachuteHome: string) {
  const proc = Bun.spawn({
    cmd: ["bun", CLI, ...args],
    cwd: parachuteHome,
    env: {
      ...process.env,
      PARACHUTE_HOME: parachuteHome,
      HOME: parachuteHome,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const seenLines: string[] = [];
  const seenStderr: string[] = [];
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const waiters: Array<{ predicate: (line: string) => boolean; resolve: () => void }> = [];

  (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      stdoutBuffer += new TextDecoder().decode(chunk);
      let nl: number;
      while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        seenLines.push(line);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.predicate(line)) {
            waiters[i]!.resolve();
            waiters.splice(i, 1);
          }
        }
      }
    }
  })();

  (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      stderrBuffer += new TextDecoder().decode(chunk);
      let nl: number;
      while ((nl = stderrBuffer.indexOf("\n")) >= 0) {
        seenStderr.push(stderrBuffer.slice(0, nl));
        stderrBuffer = stderrBuffer.slice(nl + 1);
      }
    }
  })();

  async function awaitLine(predicate: (line: string) => boolean, timeoutMs: number): Promise<string> {
    // Fast path: already seen.
    for (const l of seenLines) {
      if (predicate(l)) return l;
    }
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `awaitLine timeout after ${timeoutMs}ms. ` +
              `Lines seen so far (stdout):\n${seenLines.join("\n")}\n` +
              `(stderr):\n${seenStderr.join("\n")}`,
          ),
        );
      }, timeoutMs);
      waiters.push({
        predicate,
        resolve: () => {
          clearTimeout(timer);
          // Find the matching line we just pushed (last one matching).
          for (let i = seenLines.length - 1; i >= 0; i--) {
            if (predicate(seenLines[i]!)) {
              resolve(seenLines[i]!);
              return;
            }
          }
          resolve("");
        },
      });
    });
  }

  return {
    proc,
    awaitLine,
    seenLines,
    seenStderr,
  };
}

describe("export CLI: --watch", () => {
  let tmp: string;
  let exportDir: string;

  beforeEach(async () => {
    tmp = makeTmp("vault-watch-cli-");
    exportDir = makeTmp("vault-watch-out-");
    setupBareVault(tmp, "default");
    await seedVaultWithNotes(tmp, "default", [
      { id: "01HZB111111111111111111111", path: "Inbox/seed", content: "# seed\n" },
    ]);
    // Close the in-test store so the spawned CLI can open its own writer.
    const { clearVaultStoreCache } = await import("./vault-store.ts");
    clearVaultStoreCache();
  });

  afterEach(async () => {
    const { clearVaultStoreCache } = await import("./vault-store.ts");
    clearVaultStoreCache();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(exportDir, { recursive: true, force: true });
    restoreHomeEnv();
  });

  test(
    "initial export + idle polling: status lines + SIGINT exits cleanly",
    async () => {
      const watch = spawnWatchCli(["export", exportDir, "--watch", "--interval", "1"], tmp);
      try {
        // Initial export prints the "Exported N notes" line.
        await watch.awaitLine((l) => l.includes("Exported 1 note"), 10_000);
        // Watch loop prints the polling banner.
        await watch.awaitLine((l) => l.includes("[watch] polling every 1s"), 5_000);
        // At least one idle tick.
        await watch.awaitLine((l) => l.includes("[watch] no changes"), 5_000);
      } finally {
        watch.proc.kill("SIGINT");
      }
      const exit = await watch.proc.exited;
      expect(exit).toBe(0);
      // Stopping line printed on shutdown.
      expect(watch.seenLines.some((l) => l.includes("[watch] stopping watch"))).toBe(true);
    },
    30_000,
  );

  test(
    "vault write triggers a re-export within the next poll interval",
    async () => {
      const watch = spawnWatchCli(["export", exportDir, "--watch", "--interval", "1"], tmp);
      try {
        await watch.awaitLine((l) => l.includes("[watch] polling every 1s"), 10_000);

        // Open the vault DB out-of-band and add a note. The watch loop
        // should pick it up within ~2 intervals.
        const { clearVaultStoreCache, getVaultStore } = await import("./vault-store.ts");
        clearVaultStoreCache();
        const store = getVaultStore("default");
        await store.createNote("# new\n", {
          id: "01HZB999999999999999999999",
          path: "Inbox/triggered",
          tags: ["watched"],
        });
        clearVaultStoreCache();

        // Expect the watch-mode incremental-export line.
        const line = await watch.awaitLine(
          (l) => l.startsWith("[watch] exported"),
          10_000,
        );
        expect(line).toMatch(/\[watch\] exported \d+ note/);
        // And the on-disk file landed.
        // Wait briefly for the write — awaitLine returned as soon as the
        // log line appeared, but the file write happens immediately before.
      } finally {
        watch.proc.kill("SIGINT");
      }
      await watch.proc.exited;
      expect(fs.existsSync(path.join(exportDir, "Inbox", "triggered.md"))).toBe(true);
    },
    30_000,
  );

  test(
    "--strict-case-collision: mid-watch collision stops the loop with the full error + hint",
    async () => {
      // vault#350 reviewer fix. Before: the watch polling timer's
      // generic catch swallowed a CaseCollisionError thrown by a
      // post-initial-export poll, logging only `[watch] export error:
      // ...` and continuing to spin. The strict-mode guarantee
      // ("refuse to continue when a collision appears") evaporated
      // after the initial export.
      //
      // Scenario: start --watch --strict-case-collision against a
      // vault whose initial state has no collisions (so the watch
      // loop boots). Write a colliding note out-of-band. On the next
      // poll cycle, runCycle throws CaseCollisionError; the watch
      // catch path should now (a) print the full err.message to
      // stderr including every colliding path, (b) print the
      // actionable hint, (c) exit non-zero.
      //
      // The CLI doesn't expose `caseSensitiveOverride`, so this test
      // is meaningful only on a case-insensitive FS (macOS APFS
      // default, Windows NTFS default). On a case-sensitive Linux
      // ext4, the pre-scan is a no-op by design and the path under
      // test never fires — skip rather than assert a behavior that
      // can't manifest there.
      const { probeCaseSensitive } = await import("../core/src/portable-md.ts");
      if (probeCaseSensitive(exportDir)) {
        console.log(
          "skipping mid-watch strict-collision test on case-sensitive FS — the strict pre-scan is a no-op here",
        );
        return;
      }
      const watch = spawnWatchCli(
        [
          "export",
          exportDir,
          "--watch",
          "--interval",
          "1",
          "--strict-case-collision",
        ],
        tmp,
      );
      try {
        // Initial export must succeed (seed has no collision).
        await watch.awaitLine((l) => l.includes("Exported 1 note"), 10_000);
        await watch.awaitLine((l) => l.includes("[watch] polling every 1s"), 5_000);

        // Inject a collision: existing seed is `Inbox/seed`; write
        // `Inbox/SEED` so the lowercased (path, ext) key collides.
        const { clearVaultStoreCache, getVaultStore } = await import("./vault-store.ts");
        clearVaultStoreCache();
        const store = getVaultStore("default");
        await store.createNote("# upper\n", {
          id: "01HZB222222222222222222222",
          path: "Inbox/SEED",
        });
        clearVaultStoreCache();
      } catch (err) {
        watch.proc.kill("SIGKILL");
        throw err;
      }

      // The strict-mode catch path exits the process. Wait for it.
      // Use a guarded race so a hung process doesn't eat the full
      // 30s suite budget — surface a useful failure message instead.
      const exit = await Promise.race([
        watch.proc.exited,
        new Promise<number>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `CLI did not exit within 15s of collision injection.\n` +
                    `stdout:\n${watch.seenLines.join("\n")}\n` +
                    `stderr:\n${watch.seenStderr.join("\n")}`,
                ),
              ),
            15_000,
          ),
        ),
      ]).catch((err) => {
        watch.proc.kill("SIGKILL");
        throw err;
      });
      // Non-zero exit: strict mode refused to continue.
      expect(exit).not.toBe(0);

      const stderr = watch.seenStderr.join("\n");
      // Full collision message: header line + every colliding path.
      expect(stderr).toContain("case-collision detected");
      expect(stderr).toContain("Inbox/seed.md");
      expect(stderr).toContain("Inbox/SEED.md");
      // Actionable hint (the new line added by this fix).
      expect(stderr).toContain("Resolve the collision in the vault");
      expect(stderr).toContain("--strict-case-collision");
    },
    30_000,
  );

  test(
    "--watch + --git-commit: vault write → re-export → auto-commit → continues",
    async () => {
      initGitRepo(exportDir);
      fs.writeFileSync(path.join(exportDir, ".gitkeep"), "");
      Bun.spawnSync(["git", "add", "-A"], { cwd: exportDir });
      Bun.spawnSync(["git", "commit", "-q", "-m", "initial"], { cwd: exportDir });

      const watch = spawnWatchCli(
        ["export", exportDir, "--watch", "--interval", "1", "--git-commit"],
        tmp,
      );
      try {
        await watch.awaitLine((l) => l.includes("[watch] polling every 1s"), 10_000);
        // Initial export should have produced a commit.
        await watch.awaitLine((l) => l.startsWith("[git-commit] export:"), 10_000);
        const afterInitial = gitLogOneline(exportDir).length;

        // Add a note → expect another commit on the next cycle.
        const { clearVaultStoreCache, getVaultStore } = await import("./vault-store.ts");
        clearVaultStoreCache();
        const store = getVaultStore("default");
        await store.createNote("# live\n", {
          id: "01HZC111111111111111111111",
          path: "Inbox/live-edit",
        });
        clearVaultStoreCache();

        // Wait for a second `[git-commit] export:` line (distinct from the
        // initial one). Use the watch handle's seenLines snapshot to count.
        await watch.awaitLine((_l) => {
          const count = watch.seenLines.filter((line) =>
            line.startsWith("[git-commit] export:"),
          ).length;
          return count >= 2;
        }, 15_000);
        const afterEdit = gitLogOneline(exportDir).length;
        expect(afterEdit).toBe(afterInitial + 1);
      } finally {
        watch.proc.kill("SIGINT");
      }
      await watch.proc.exited;
    },
    30_000,
  );
});
