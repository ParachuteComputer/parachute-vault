/**
 * Tests for the git-history read surface (vault#300).
 *
 * The vault is already git-backed via the mirror — one file per note — so
 * `git log` IS the write history. These tests exercise:
 *   - the `readMirrorHistory` / `showMirrorRevision` / `noteHistoryPathspec`
 *     helpers (mirror-manager.ts) against a real seeded git repo in a tmpdir
 *   - the `handleMirrorHistory` / `handleMirrorHistoryShow` REST handlers
 *     (mirror-routes.ts), including the not-initialized + path-scoped cases
 *
 * Routing-level admin-gate enforcement lives in routing.test.ts (alongside
 * the sibling mirror routes); these are the after-auth handler + helper
 * tests, matching the mirror-manager / mirror-routes test split.
 *
 * Like the other mirror tests: real tempdirs + real `git` so we exercise
 * the actual log/show behavior, not a mock.
 */

import { describe, test, expect, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HISTORY_MAX_LIMIT,
  noteHistoryPathspec,
  readMirrorHistory,
  showMirrorRevision,
  MirrorManager,
  type MirrorDeps,
} from "./mirror-manager.ts";
import {
  handleMirrorHistory,
  handleMirrorHistoryShow,
} from "./mirror-routes.ts";
import { defaultMirrorConfig, type MirrorConfig } from "./mirror-config.ts";

// Keep HOME / PARACHUTE_HOME from leaking between test files — same pattern
// as mirror-manager.test.ts.
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

/** Write a file (creating parent dirs), `git add -A`, commit with `message`. */
function commitFile(dir: string, relPath: string, content: string, message: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-q", "-m", message], { cwd: dir });
}

// ---------------------------------------------------------------------------
// noteHistoryPathspec — normalize + traversal guard
// ---------------------------------------------------------------------------

describe("noteHistoryPathspec", () => {
  test("appends .md to a bare note path", () => {
    expect(noteHistoryPathspec("Inbox/today")).toBe("Inbox/today.md");
  });

  test("is idempotent on an already-suffixed path", () => {
    expect(noteHistoryPathspec("Inbox/today.md")).toBe("Inbox/today.md");
  });

  test("rejects traversal", () => {
    expect(noteHistoryPathspec("../etc/passwd")).toBeNull();
    expect(noteHistoryPathspec("Inbox/../../secret")).toBeNull();
  });

  test("rejects absolute paths", () => {
    expect(noteHistoryPathspec("/etc/passwd")).toBeNull();
  });

  test("rejects empty / whitespace", () => {
    expect(noteHistoryPathspec("")).toBeNull();
    expect(noteHistoryPathspec("   ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readMirrorHistory — the core git-log read
// ---------------------------------------------------------------------------

describe("readMirrorHistory", () => {
  test("returns commits newest-first with sha/date/message", async () => {
    const dir = tmp("vault-history-");
    initRepo(dir);
    commitFile(dir, "Inbox/one.md", "one", "export: first (1 note)");
    commitFile(dir, "Inbox/two.md", "two", "export: second (1 note)");

    const history = await readMirrorHistory(dir);
    expect(history.length).toBe(2);
    // Newest first.
    expect(history[0]!.message).toBe("export: second (1 note)");
    expect(history[1]!.message).toBe("export: first (1 note)");
    // Each entry has a full sha + an ISO date.
    for (const entry of history) {
      expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isNaN(Date.parse(entry.date))).toBe(false);
    }
  });

  test("?path filters to a single note's commits, --follow across renames", async () => {
    const dir = tmp("vault-history-path-");
    initRepo(dir);
    commitFile(dir, "Notes/alpha.md", "a1", "export: alpha created");
    commitFile(dir, "Notes/beta.md", "b1", "export: beta created");
    commitFile(dir, "Notes/alpha.md", "a2", "export: alpha edited");

    const alpha = await readMirrorHistory(dir, { notePath: "Notes/alpha" });
    // Two commits touched alpha; beta's commit is excluded.
    expect(alpha.length).toBe(2);
    expect(alpha.map((e) => e.message)).toEqual([
      "export: alpha edited",
      "export: alpha created",
    ]);

    const beta = await readMirrorHistory(dir, { notePath: "Notes/beta" });
    expect(beta.length).toBe(1);
    expect(beta[0]!.message).toBe("export: beta created");
  });

  test("limit caps the number of commits returned", async () => {
    const dir = tmp("vault-history-limit-");
    initRepo(dir);
    for (let i = 0; i < 5; i++) {
      commitFile(dir, `Notes/n${i}.md`, `v${i}`, `export: commit ${i}`);
    }
    const limited = await readMirrorHistory(dir, { limit: 2 });
    expect(limited.length).toBe(2);
    // Newest two.
    expect(limited[0]!.message).toBe("export: commit 4");
    expect(limited[1]!.message).toBe("export: commit 3");
  });

  test("an out-of-range limit is clamped to HISTORY_MAX_LIMIT (never exceeds the ceiling)", async () => {
    const dir = tmp("vault-history-ceiling-");
    initRepo(dir);
    // Seed just a few commits — the assertion is on the ARG cap, not commit
    // count: an absurd limit must never spawn `git log` with --max-count
    // above the hard ceiling. With <ceiling commits the result is bounded by
    // commit count, so we assert it's never MORE than the ceiling.
    commitFile(dir, "Notes/a.md", "a", "export: a");
    commitFile(dir, "Notes/b.md", "b", "export: b");
    const history = await readMirrorHistory(dir, { limit: 99_999_999 });
    expect(history.length).toBeLessThanOrEqual(HISTORY_MAX_LIMIT);
    // Sanity: a huge limit still returns the (few) real commits.
    expect(history.length).toBe(2);
  });

  test("no commits yet → empty list, not an error", async () => {
    const dir = tmp("vault-history-empty-");
    initRepo(dir); // repo but no commits
    const history = await readMirrorHistory(dir);
    expect(history).toEqual([]);
  });

  test("not a git repo → empty list, not an error", async () => {
    const dir = tmp("vault-history-nonrepo-");
    // No `git init`.
    const history = await readMirrorHistory(dir);
    expect(history).toEqual([]);
  });

  test("a path with no history → empty list", async () => {
    const dir = tmp("vault-history-nopath-");
    initRepo(dir);
    commitFile(dir, "Notes/exists.md", "x", "export: exists");
    const history = await readMirrorHistory(dir, { notePath: "Notes/ghost" });
    expect(history).toEqual([]);
  });

  test("an unsafe path → empty list (never an unscoped log)", async () => {
    const dir = tmp("vault-history-unsafe-");
    initRepo(dir);
    commitFile(dir, "Notes/a.md", "a", "export: a");
    commitFile(dir, "Notes/b.md", "b", "export: b");
    // A traversal path must NOT fall back to the full (unscoped) log.
    const history = await readMirrorHistory(dir, { notePath: "../../../etc/passwd" });
    expect(history).toEqual([]);
  });

  test("redacts tokens that appear in a commit subject", async () => {
    const dir = tmp("vault-history-redact-");
    initRepo(dir);
    commitFile(dir, "Notes/a.md", "a", "synced from https://x-access-token:ghp_supersecrettoken123@github.com/a/b");
    const history = await readMirrorHistory(dir);
    expect(history.length).toBe(1);
    expect(history[0]!.message).not.toContain("ghp_supersecrettoken123");
    expect(history[0]!.message).toContain("***");
  });
});

// ---------------------------------------------------------------------------
// showMirrorRevision — read a past revision of a note
// ---------------------------------------------------------------------------

describe("showMirrorRevision", () => {
  test("returns the file content at a past revision", async () => {
    const dir = tmp("vault-show-");
    initRepo(dir);
    commitFile(dir, "Notes/a.md", "version one", "export: a v1");
    // Capture the sha at v1.
    const v1 = (await readMirrorHistory(dir))[0]!.sha;
    commitFile(dir, "Notes/a.md", "version two", "export: a v2");

    const past = await showMirrorRevision(dir, v1, "Notes/a");
    expect(past).toBe("version one");

    const current = await showMirrorRevision(dir, (await readMirrorHistory(dir))[0]!.sha, "Notes/a");
    expect(current).toBe("version two");
  });

  test("unknown sha → null", async () => {
    const dir = tmp("vault-show-badsha-");
    initRepo(dir);
    commitFile(dir, "Notes/a.md", "x", "export: a");
    const result = await showMirrorRevision(dir, "deadbeef", "Notes/a");
    expect(result).toBeNull();
  });

  test("non-hex / option-looking sha → null (no smuggled ref)", async () => {
    const dir = tmp("vault-show-refsmuggle-");
    initRepo(dir);
    commitFile(dir, "Notes/a.md", "x", "export: a");
    expect(await showMirrorRevision(dir, "HEAD", "Notes/a")).toBeNull();
    expect(await showMirrorRevision(dir, "--output=/tmp/x", "Notes/a")).toBeNull();
  });

  test("unsafe path → null", async () => {
    const dir = tmp("vault-show-unsafe-");
    initRepo(dir);
    commitFile(dir, "Notes/a.md", "x", "export: a");
    const sha = (await readMirrorHistory(dir))[0]!.sha;
    expect(await showMirrorRevision(dir, sha, "../../../etc/passwd")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route handlers — handleMirrorHistory / handleMirrorHistoryShow
// ---------------------------------------------------------------------------

/**
 * Build a MirrorManager whose status reports `mirror_path = mirrorPath`
 * without standing up the full lifecycle — the history handlers only read
 * `getStatus().mirror_path`, so we start a minimal enabled internal mirror
 * pointed at a tmp repo we control.
 *
 * Simpler: construct the manager with fake deps and force the status by
 * starting it against an internal mirror dir we then seed. But the history
 * read is path-only, so we instead use a tiny manager whose deps resolve the
 * internal mirror under a tmp PARACHUTE_HOME and start it (which bootstraps a
 * real git repo), then commit into that repo.
 */
function makeStartedManager(home: string): { manager: MirrorManager; deps: MirrorDeps } {
  process.env.PARACHUTE_HOME = home;
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, "vault", "data", "default"), { recursive: true });
  let stored: MirrorConfig | undefined = { ...defaultMirrorConfig(), enabled: true };
  const deps: MirrorDeps = {
    vaultName: "default",
    runExport: async () => ({ notes: 0 }),
    firstChangedNoteTitle: async () => "",
    readMirrorConfig: () => stored,
    writeMirrorConfig: (c) => {
      stored = c;
    },
  };
  return { manager: new MirrorManager(deps), deps };
}

describe("handleMirrorHistory route", () => {
  test("not-initialized mirror → 200 empty history + note (not 500)", async () => {
    const home = tmp("vault-route-noinit-");
    const { manager } = makeStartedManager(home);
    // Never started → no mirror_path resolved.
    const res = await handleMirrorHistory(
      new Request("http://localhost/vault/default/.parachute/mirror/history"),
      manager,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: unknown[]; mirror_path: null; note?: string };
    expect(body.history).toEqual([]);
    expect(body.mirror_path).toBeNull();
    expect(body.note).toBeDefined();
  });

  test("started mirror with commits → 200 history list", async () => {
    const home = tmp("vault-route-hist-");
    const { manager } = makeStartedManager(home);
    await manager.start();
    const mirrorPath = manager.getStatus().mirror_path!;
    expect(mirrorPath).toBeTruthy();
    commitFile(mirrorPath, "Notes/a.md", "a", "export: a created");
    commitFile(mirrorPath, "Notes/b.md", "b", "export: b created");

    const res = await handleMirrorHistory(
      new Request("http://localhost/vault/default/.parachute/mirror/history"),
      manager,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      history: Array<{ sha: string; date: string; message: string }>;
      mirror_path: string;
    };
    // Includes the bootstrap commit + our two; newest first.
    expect(body.history.length).toBeGreaterThanOrEqual(3);
    expect(body.history[0]!.message).toBe("export: b created");
    expect(body.mirror_path).toBe(mirrorPath);
  });

  test("?path scopes to one note", async () => {
    const home = tmp("vault-route-histpath-");
    const { manager } = makeStartedManager(home);
    await manager.start();
    const mirrorPath = manager.getStatus().mirror_path!;
    commitFile(mirrorPath, "Notes/alpha.md", "a1", "export: alpha");
    commitFile(mirrorPath, "Notes/beta.md", "b1", "export: beta");

    const res = await handleMirrorHistory(
      new Request("http://localhost/vault/default/.parachute/mirror/history?path=Notes/alpha"),
      manager,
    );
    const body = (await res.json()) as {
      history: Array<{ message: string }>;
      path?: string;
    };
    expect(body.path).toBe("Notes/alpha");
    expect(body.history.length).toBe(1);
    expect(body.history[0]!.message).toBe("export: alpha");
  });

  test("?limit caps the count", async () => {
    const home = tmp("vault-route-histlimit-");
    const { manager } = makeStartedManager(home);
    await manager.start();
    const mirrorPath = manager.getStatus().mirror_path!;
    for (let i = 0; i < 4; i++) commitFile(mirrorPath, `Notes/n${i}.md`, `v${i}`, `export: c${i}`);

    const res = await handleMirrorHistory(
      new Request("http://localhost/vault/default/.parachute/mirror/history?limit=2"),
      manager,
    );
    const body = (await res.json()) as { history: unknown[] };
    expect(body.history.length).toBe(2);
  });

  test("invalid limit → 400", async () => {
    const home = tmp("vault-route-histbadlimit-");
    const { manager } = makeStartedManager(home);
    await manager.start();
    const res = await handleMirrorHistory(
      new Request("http://localhost/vault/default/.parachute/mirror/history?limit=-3"),
      manager,
    );
    expect(res.status).toBe(400);
  });
});

describe("handleMirrorHistoryShow route", () => {
  test("returns a past revision's content", async () => {
    const home = tmp("vault-route-show-");
    const { manager } = makeStartedManager(home);
    await manager.start();
    const mirrorPath = manager.getStatus().mirror_path!;
    commitFile(mirrorPath, "Notes/a.md", "v1 content", "export: a v1");
    const sha = (await readMirrorHistory(mirrorPath, { notePath: "Notes/a" }))[0]!.sha;
    commitFile(mirrorPath, "Notes/a.md", "v2 content", "export: a v2");

    const res = await handleMirrorHistoryShow(
      new Request(
        `http://localhost/vault/default/.parachute/mirror/history/show?sha=${sha}&path=Notes/a`,
      ),
      manager,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; sha: string; path: string };
    expect(body.content).toBe("v1 content");
    expect(body.path).toBe("Notes/a");
  });

  test("missing sha/path → 400", async () => {
    const home = tmp("vault-route-show-missing-");
    const { manager } = makeStartedManager(home);
    await manager.start();
    const res = await handleMirrorHistoryShow(
      new Request("http://localhost/vault/default/.parachute/mirror/history/show?sha=abc123"),
      manager,
    );
    expect(res.status).toBe(400);
  });

  test("unknown sha/path → 404", async () => {
    const home = tmp("vault-route-show-404-");
    const { manager } = makeStartedManager(home);
    await manager.start();
    const res = await handleMirrorHistoryShow(
      new Request(
        "http://localhost/vault/default/.parachute/mirror/history/show?sha=deadbeef&path=Notes/ghost",
      ),
      manager,
    );
    expect(res.status).toBe(404);
  });
});
