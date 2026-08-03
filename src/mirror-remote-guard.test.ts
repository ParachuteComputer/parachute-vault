/**
 * Tests for the cross-vault remote-clobber guard (vault#482).
 *
 * Two layers:
 *   - Pure normalization / equivalence (`normalizeRemoteIdentity`,
 *     `sameRemoteIdentity`) — https vs ssh vs scp-shorthand vs .git-suffix.
 *   - `findConflictingVault` against real on-disk vault state under a temp
 *     PARACHUTE_HOME (no network, no live manager).
 */

import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  normalizeRemoteIdentity,
  sameRemoteIdentity,
  claimedRemoteOf,
  findConflictingVault,
  findUnrelatedRemoteHistory,
  unrelatedHistoryMessage,
} from "./mirror-remote-guard.ts";
import { writeMirrorConfigForVault, defaultMirrorConfig } from "./mirror-config.ts";
import { writeCredentials } from "./mirror-credentials.ts";

const ORIG_PARACHUTE_HOME = process.env.PARACHUTE_HOME;
const ORIG_HOME = process.env.HOME;
afterEach(() => {
  if (ORIG_PARACHUTE_HOME === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = ORIG_PARACHUTE_HOME;
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Stand up a vault on disk under the active PARACHUTE_HOME so `listVaults()`
 * sees it: create `data/<name>/vault.yaml`. Optionally seed an enabled
 * internal mirror config + a mirror-dir `origin` and/or a PAT credential.
 */
function seedVault(
  name: string,
  opts: {
    origin?: string;
    pat?: string;
    enabledMirror?: boolean;
  } = {},
): void {
  const home = process.env.PARACHUTE_HOME!;
  const vaultDataDir = path.join(home, "vault", "data", name);
  fs.mkdirSync(vaultDataDir, { recursive: true });
  // Minimal vault.yaml so listVaults() recognizes it.
  fs.writeFileSync(path.join(vaultDataDir, "vault.yaml"), `name: ${name}\n`);

  if (opts.enabledMirror !== false && (opts.origin || opts.pat)) {
    writeMirrorConfigForVault(name, {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
    });
  }

  if (opts.origin) {
    // Write the mirror dir's git config origin straight to disk — no git
    // spawn needed; the guard reads `.git/config` directly.
    const mirrorGitDir = path.join(vaultDataDir, "mirror", ".git");
    fs.mkdirSync(mirrorGitDir, { recursive: true });
    fs.writeFileSync(
      path.join(mirrorGitDir, "config"),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${opts.origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
  }

  if (opts.pat) {
    writeCredentials(name, {
      active_method: "pat",
      github_oauth: null,
      pat: { token: "ghp_seedtoken1234567890", remote_url: opts.pat, label: "seed" },
    });
  }
}

// ---------------------------------------------------------------------------
// Normalization / equivalence
// ---------------------------------------------------------------------------

describe("normalizeRemoteIdentity", () => {
  test("https with and without .git normalize equal", () => {
    expect(normalizeRemoteIdentity("https://github.com/x/y")).toBe("github.com/x/y");
    expect(normalizeRemoteIdentity("https://github.com/x/y.git")).toBe("github.com/x/y");
  });

  test("trailing slash is stripped", () => {
    expect(normalizeRemoteIdentity("https://github.com/x/y/")).toBe("github.com/x/y");
    expect(normalizeRemoteIdentity("https://github.com/x/y.git/")).toBe("github.com/x/y");
  });

  test("host is lower-cased", () => {
    expect(normalizeRemoteIdentity("https://GitHub.com/x/y")).toBe("github.com/x/y");
  });

  test("owner/repo is lower-cased too (GitHub is case-insensitive) — the clobber guard", () => {
    // Aaron/Vault and aaron/vault are the SAME GitHub repo; both must normalize
    // equal so two vaults with different-case configs are caught, not clobbered.
    expect(normalizeRemoteIdentity("https://github.com/Aaron/Vault.git")).toBe("github.com/aaron/vault");
    expect(normalizeRemoteIdentity("git@github.com:Aaron/Vault.git")).toBe("github.com/aaron/vault");
  });

  test("embedded userinfo (token) is stripped", () => {
    expect(
      normalizeRemoteIdentity("https://x-access-token:ghp_secret@github.com/x/y.git"),
    ).toBe("github.com/x/y");
  });

  test("scp-style SSH shorthand normalizes to host/path", () => {
    expect(normalizeRemoteIdentity("git@github.com:x/y.git")).toBe("github.com/x/y");
  });

  test("ssh:// URL normalizes to host/path", () => {
    expect(normalizeRemoteIdentity("ssh://git@github.com/x/y.git")).toBe("github.com/x/y");
  });

  test("empty / whitespace → null", () => {
    expect(normalizeRemoteIdentity("")).toBeNull();
    expect(normalizeRemoteIdentity("   ")).toBeNull();
  });
});

describe("sameRemoteIdentity — the equivalence the guard keys off", () => {
  test("https ≡ ssh ≡ scp-shorthand ≡ .git-suffix for the same repo", () => {
    const variants = [
      "https://github.com/aaron/my-vault.git",
      "https://github.com/aaron/my-vault",
      "git@github.com:aaron/my-vault.git",
      "ssh://git@github.com/aaron/my-vault",
      "https://x-access-token:ghp_tok@github.com/aaron/my-vault.git",
    ];
    for (const a of variants) {
      for (const b of variants) {
        expect(sameRemoteIdentity(a, b)).toBe(true);
      }
    }
  });

  test("case-insensitive owner/repo: Aaron/Vault ≡ aaron/vault (the data-loss gap)", () => {
    expect(
      sameRemoteIdentity("https://github.com/Aaron/Vault.git", "https://github.com/aaron/vault"),
    ).toBe(true);
  });

  test("different repos are NOT equal", () => {
    expect(
      sameRemoteIdentity(
        "https://github.com/aaron/my-vault.git",
        "https://github.com/aaron/other-vault.git",
      ),
    ).toBe(false);
  });

  test("different owners are NOT equal (the family-box case)", () => {
    expect(
      sameRemoteIdentity(
        "https://github.com/alice/backup.git",
        "https://github.com/bob/backup.git",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// claimedRemoteOf — reads both origin + PAT sources
// ---------------------------------------------------------------------------

describe("claimedRemoteOf", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("reads the mirror dir origin (covers OAuth-selected repos)", () => {
    home = tmp("guard-claimed-origin-");
    process.env.PARACHUTE_HOME = home;
    seedVault("a", { origin: "https://github.com/aaron/my-vault.git" });
    expect(claimedRemoteOf("a")).toBe("github.com/aaron/my-vault");
  });

  test("reads the stored PAT remote_url when no origin on disk", () => {
    home = tmp("guard-claimed-pat-");
    process.env.PARACHUTE_HOME = home;
    seedVault("a", {
      pat: "https://x-access-token:ghp_x@github.com/aaron/pat-vault.git",
    });
    expect(claimedRemoteOf("a")).toBe("github.com/aaron/pat-vault");
  });

  test("returns null for a vault with no mirror remote", () => {
    home = tmp("guard-claimed-none-");
    process.env.PARACHUTE_HOME = home;
    seedVault("a", {});
    expect(claimedRemoteOf("a")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findConflictingVault — the cross-vault scan
// ---------------------------------------------------------------------------

describe("findConflictingVault", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("detects a sibling vault targeting the same repo (origin source)", () => {
    home = tmp("guard-conflict-origin-");
    process.env.PARACHUTE_HOME = home;
    // Vault "a" already backs up to aaron/shared via its mirror origin.
    seedVault("a", { origin: "https://github.com/aaron/shared.git" });
    seedVault("b", {});
    // Vault "b" tries to bind the SAME repo via a different URL shape.
    const conflict = findConflictingVault("b", "git@github.com:aaron/shared.git");
    expect(conflict).not.toBeNull();
    expect(conflict!.conflictingVault).toBe("a");
    expect(conflict!.remoteIdentity).toBe("github.com/aaron/shared");
  });

  test("detects a sibling vault targeting the same repo (PAT source)", () => {
    home = tmp("guard-conflict-pat-");
    process.env.PARACHUTE_HOME = home;
    seedVault("a", {
      pat: "https://x-access-token:ghp_a@github.com/aaron/shared.git",
    });
    seedVault("b", {});
    const conflict = findConflictingVault(
      "b",
      "https://github.com/aaron/shared",
    );
    expect(conflict).not.toBeNull();
    expect(conflict!.conflictingVault).toBe("a");
  });

  test("excludes the current vault — re-pointing to its OWN remote is allowed", () => {
    home = tmp("guard-conflict-self-");
    process.env.PARACHUTE_HOME = home;
    seedVault("a", { origin: "https://github.com/aaron/shared.git" });
    // Vault "a" re-binds its OWN repo (token rotation / re-pick) → no conflict.
    const conflict = findConflictingVault("a", "https://github.com/aaron/shared.git");
    expect(conflict).toBeNull();
  });

  test("no false positive when no sibling targets the repo", () => {
    home = tmp("guard-conflict-clear-");
    process.env.PARACHUTE_HOME = home;
    seedVault("a", { origin: "https://github.com/aaron/vault-a.git" });
    seedVault("b", {});
    const conflict = findConflictingVault("b", "https://github.com/aaron/vault-b.git");
    expect(conflict).toBeNull();
  });

  test("an empty / unparseable candidate never conflicts", () => {
    home = tmp("guard-conflict-empty-");
    process.env.PARACHUTE_HOME = home;
    seedVault("a", { origin: "https://github.com/aaron/shared.git" });
    expect(findConflictingVault("b", "")).toBeNull();
    expect(findConflictingVault("b", "   ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// vault#823 — unrelated-history guard, against REAL git repos.
//
// The failure being guarded is deterministic and reproduces in plain git:
// give a remote some history, `git init` a fresh mirror beside it, bind, push
// → `! [rejected] (non-fast-forward)`, forever. These tests build exactly that
// on disk rather than mocking the object database, because the whole claim is
// about what git does with two roots.
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (!proc.success) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
}

function headShasOf(repo: string): string[] {
  const proc = Bun.spawnSync(["git", "ls-remote", repo], { stdout: "pipe", stderr: "ignore" });
  return new TextDecoder()
    .decode(proc.stdout)
    .split("\n")
    .map((l) => l.split("\t")[0])
    .filter((s) => /^[0-9a-f]{40}$/.test(s));
}

describe("findUnrelatedRemoteHistory (vault#823)", () => {
  test("fresh mirror + non-empty remote → flagged, and the real push really is rejected", async () => {
    const root = tmp("pv-unrelated-");
    const remote = path.join(root, "remote.git");
    fs.mkdirSync(remote, { recursive: true });
    git(remote, "init", "-q", "--bare");

    // Seed the remote with history, the way a prior machine's mirror would.
    const seed = path.join(root, "seed");
    fs.mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(seed, "n1.md"), "note one");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "vault export 1");
    git(seed, "push", "-q", remote, "HEAD:main");

    // The imported box: notes came across, the mirror is a fresh `git init`.
    const mirror = path.join(root, "mirror");
    fs.mkdirSync(mirror);
    git(mirror, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(mirror, "n1.md"), "note one");
    git(mirror, "add", "-A");
    git(mirror, "commit", "-qm", "vault mirror seed");

    const heads = headShasOf(remote);
    expect(heads.length).toBeGreaterThan(0);

    const found = await findUnrelatedRemoteHistory({
      mirrorPath: mirror,
      remoteUrl: `https://github.com/a/b.git`,
      remoteHeads: heads,
    });
    expect(found).not.toBeNull();
    expect(found?.mirrorIsFresh).toBe(false); // the dir exists, it's just unrelated

    // And the thing the guard is predicting actually happens.
    const push = Bun.spawnSync(["git", "push", remote, "HEAD:main"], {
      cwd: mirror,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(push.success).toBe(false);
    expect(new TextDecoder().decode(push.stderr)).toContain("rejected");
  });

  test("mirror cloned FROM the remote → not flagged (re-bind after token rotation)", async () => {
    const root = tmp("pv-related-");
    const remote = path.join(root, "remote.git");
    fs.mkdirSync(remote, { recursive: true });
    git(remote, "init", "-q", "--bare");
    const seed = path.join(root, "seed");
    fs.mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(seed, "n1.md"), "note one");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "vault export 1");
    git(seed, "push", "-q", remote, "HEAD:main");

    const mirror = path.join(root, "mirror");
    git(root, "clone", "-q", remote, mirror);

    const found = await findUnrelatedRemoteHistory({
      mirrorPath: mirror,
      remoteUrl: "https://github.com/a/b.git",
      remoteHeads: headShasOf(remote),
    });
    expect(found).toBeNull();
  });

  test("empty remote → not flagged (the ordinary fresh-repo setup)", async () => {
    const root = tmp("pv-emptyremote-");
    const mirror = path.join(root, "mirror");
    fs.mkdirSync(mirror, { recursive: true });
    git(mirror, "init", "-q", "-b", "main");
    const found = await findUnrelatedRemoteHistory({
      mirrorPath: mirror,
      remoteUrl: "https://github.com/a/b.git",
      remoteHeads: [],
    });
    expect(found).toBeNull();
  });

  test("no mirror on disk yet + non-empty remote → flagged as fresh", async () => {
    const root = tmp("pv-nomirror-");
    const found = await findUnrelatedRemoteHistory({
      mirrorPath: path.join(root, "does-not-exist"),
      remoteUrl: "https://github.com/a/b.git",
      remoteHeads: ["a".repeat(40)],
    });
    expect(found).not.toBeNull();
    expect(found?.mirrorIsFresh).toBe(true);
  });

  test("null mirrorPath + non-empty remote → flagged as fresh", async () => {
    const found = await findUnrelatedRemoteHistory({
      mirrorPath: null,
      remoteUrl: "https://github.com/a/b.git",
      remoteHeads: ["b".repeat(40)],
    });
    expect(found?.mirrorIsFresh).toBe(true);
  });

  test("message names the repo, the cause, and never leaks a token", () => {
    const msg = unrelatedHistoryMessage({
      remoteIdentity: "github.com/aaron/my-vault",
      mirrorIsFresh: true,
    });
    expect(msg).toContain("github.com/aaron/my-vault");
    expect(msg).toContain("non-fast-forward");
    expect(msg).toContain("override=true");

    // Unparseable URL falls back to a userinfo-stripped form, not the raw one.
    const leaky = unrelatedHistoryMessage({
      remoteIdentity: "not a url",
      mirrorIsFresh: false,
    });
    expect(leaky).not.toContain("@");
  });
});
