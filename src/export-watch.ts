/**
 * Helpers for `parachute-vault export --watch` and `--git-commit`.
 *
 * Split out from `cli.ts` so the template renderer and git-shell helpers are
 * unit-testable without spawning the full CLI. The CLI imports and wires
 * these into `cmdExport`'s watch loop; tests import them directly.
 *
 * No new deps — `git` is shelled out via `Bun.spawn`. Watch detection is
 * polling: every `intervalSeconds`, run an incremental export with the
 * cursor captured at the *start* of the previous cycle. Vault writes are
 * HTTP-mediated and don't surface to filesystem watchers (the bun:sqlite DB
 * is opaque), so polling on `updated_at >= cursor` is the simplest robust
 * detection. See `parachute-patterns/cookbook/vault-portable-export.md`.
 */

import { ensureGitAvailable } from "./git-preflight.ts";

// ---------------------------------------------------------------------------
// Commit message templating
// ---------------------------------------------------------------------------

/** Variables exposed to `--git-message-template`. */
export interface CommitTemplateVars {
  /** ISO-formatted UTC timestamp captured at commit time. */
  date: string;
  /** Count of notes changed since the previous export cursor. */
  notes_changed: number;
  /**
   * First changed note's title (or path / id fallback) since the previous
   * cursor — useful for single-note commits. Empty when nothing matched or
   * on the initial export (where "first changed" is ambiguous).
   */
  first_note_title: string;
  /** Source vault name. */
  vault_name: string;
}

/**
 * Substitute `{{var}}` tokens in `template`. Recognized vars:
 *
 *   `{{date}}` `{{notes_changed}}` `{{plural}}` `{{first_note_title}}` `{{vault_name}}`
 *
 * `{{plural}}` is `""` when `notes_changed === 1`, else `"s"` — so
 * `"{{notes_changed}} note{{plural}}"` reads naturally for both 1 and N
 * without the operator writing their own conditional.
 *
 * Unknown tokens pass through untouched (so a typo in the template is
 * visible in the commit message rather than silently dropped).
 */
export function renderCommitMessage(template: string, vars: CommitTemplateVars): string {
  return template
    .replace(/\{\{date\}\}/g, vars.date)
    .replace(/\{\{notes_changed\}\}/g, String(vars.notes_changed))
    .replace(/\{\{plural\}\}/g, vars.notes_changed === 1 ? "" : "s")
    .replace(/\{\{first_note_title\}\}/g, vars.first_note_title)
    .replace(/\{\{vault_name\}\}/g, vars.vault_name);
}

/** Default commit message template. Reads as "export: <iso> (N note[s])". */
export const DEFAULT_COMMIT_TEMPLATE =
  "export: {{date}} ({{notes_changed}} note{{plural}})";

// ---------------------------------------------------------------------------
// Git shell helpers (Bun.spawn — no new dep)
// ---------------------------------------------------------------------------

/**
 * Return true if `dir` is inside a git working tree.
 *
 * Implementation: `git rev-parse --is-inside-work-tree`, exit code 0 = yes.
 * No reliance on `.git/` existing as a directory (handles worktrees + bare
 * submodule layouts uniformly).
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

/** List the paths git currently has staged (cached). One per line. */
export async function listStagedFiles(repoDir: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "diff", "--cached", "--name-only"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const out = new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Run `git add -A` in `repoDir`. Returns true on success. */
export async function gitAddAll(repoDir: string): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["git", "add", "-A"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stderr = new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
  return { ok: exitCode === 0, stderr: stderr.trim() };
}

/** Run `git commit -m <message>` in `repoDir`. Returns true on success. */
export async function gitCommit(
  repoDir: string,
  message: string,
): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["git", "commit", "-m", message], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stderr = new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
  return { ok: exitCode === 0, stderr: stderr.trim() };
}

/**
 * Run `git push` in `repoDir`. Returns true on success.
 *
 * Handles the first-push case: a freshly-bootstrapped mirror has
 * commits but no upstream tracking, and a bare `git push` fails with
 * "fatal: The current branch X has no upstream branch." That's
 * unrecoverable from the operator's POV — they'd have to drop to a
 * shell and run `git push -u origin main`. The wiring here detects the
 * missing-upstream case ahead of time and falls back to `git push -u
 * origin <branch>` so the first push works and every subsequent push
 * picks up the now-configured tracking.
 *
 * Vault#382 carried bare `git push`; this is the Cut 4 fix in the
 * credentials-save round-trip work.
 */
export async function gitPush(
  repoDir: string,
): Promise<{ ok: boolean; stderr: string }> {
  // Resolve the current branch name. `git rev-parse --abbrev-ref HEAD`
  // returns the branch on a checked-out branch (e.g. "main"); on a
  // detached HEAD it returns "HEAD" — in that case we bail to bare push
  // since `-u origin HEAD` doesn't mean anything useful.
  let branch: string | null = null;
  try {
    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const branchCode = await branchProc.exited;
    if (branchCode === 0) {
      const out = new TextDecoder()
        .decode(await new Response(branchProc.stdout).arrayBuffer())
        .trim();
      if (out.length > 0 && out !== "HEAD") branch = out;
    }
  } catch {
    // Fall through to bare push.
  }

  // Probe for an existing upstream. `git rev-parse --abbrev-ref
  // --symbolic-full-name @{u}` exits non-zero when no upstream is
  // configured for the current branch. Exit 0 + a value → upstream
  // exists; bare `git push` is fine.
  let hasUpstream = false;
  if (branch !== null) {
    const upstreamProc = Bun.spawn(
      ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      {
        cwd: repoDir,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const upstreamCode = await upstreamProc.exited;
    hasUpstream = upstreamCode === 0;
  }

  // First-push path: `git push -u origin <branch>` to establish
  // tracking. Subsequent calls take the bare path because hasUpstream
  // will be true after this lands.
  const cmd =
    branch !== null && !hasUpstream
      ? ["git", "push", "-u", "origin", branch]
      : ["git", "push"];
  const proc = Bun.spawn(cmd, {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stderr = new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
  return { ok: exitCode === 0, stderr: stderr.trim() };
}

/**
 * Unstage everything in `repoDir` (no-op if nothing staged).
 *
 * Uses bare `git reset` (no `HEAD`, no path args) so the call works on a
 * fresh repo with no commits yet — an operator who runs `--git-commit`
 * against a `git init`'d empty repo and lands in the `.parachute/`-only
 * skip path on the first cycle would otherwise leave staging dirty.
 * Both `git reset HEAD -- .` and `git restore --staged .` require a
 * resolvable HEAD; bare `git reset` falls back cleanly when none exists.
 * See vault#346 reviewer note.
 */
export async function gitUnstageAll(repoDir: string): Promise<void> {
  const proc = Bun.spawn(["git", "reset"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

// ---------------------------------------------------------------------------
// Cycle-level helpers: commit-or-skip decision + execution
// ---------------------------------------------------------------------------

/**
 * Decide whether the currently-staged set warrants a commit, given the
 * `notes_changed` reported by the export cycle.
 *
 * Skip rules:
 *   - Empty staging → skip (nothing to commit).
 *   - `notes_changed === 0` AND every staged path lives under `.parachute/`
 *     → skip. This filters the pure `vault.yaml` `exported_at` churn that
 *     would otherwise produce a commit per watch interval forever.
 *
 * Otherwise → commit.
 *
 * Note: a vault rename (vault.yaml `name` field changes) also follows the
 * skip path. Metadata-only changes don't commit by design — the operator
 * who renames a vault and wants that in the git mirror history can either
 * touch a note or run a one-shot `git commit --allow-empty -m "rename vault"`
 * by hand.
 */
export function shouldCommit(stagedFiles: string[], notesChanged: number): {
  commit: boolean;
  reason: "ok" | "empty" | "parachute_meta_only";
} {
  if (stagedFiles.length === 0) return { commit: false, reason: "empty" };
  if (notesChanged === 0 && stagedFiles.every((f) => f.startsWith(".parachute/"))) {
    return { commit: false, reason: "parachute_meta_only" };
  }
  return { commit: true, reason: "ok" };
}

/**
 * Stage → decide → commit → optionally push. Logs status to stdout/stderr.
 * Returns whether a commit landed and (when push was attempted) the
 * push outcome — so callers can surface push status in their UIs
 * without having to grep logs.
 *
 * Cut 5: the return shape now includes a `push` field with the outcome
 * when push was attempted. Tokens are redacted from `push.error` via
 * the userinfo + `gho_/ghp_/glpat-` regex so log + status surfaces are
 * safe to display.
 */
export async function runGitCommitCycle(opts: {
  repoDir: string;
  template: string;
  notesChanged: number;
  vaultName: string;
  firstNoteTitle: string;
  push: boolean;
  /** Override for tests — defaults to `new Date().toISOString()`. */
  now?: () => string;
  /**
   * Override the git-presence probe (test seam — defaults to `Bun.which`).
   * Inject a fn returning `null` to exercise the git-not-installed path.
   */
  which?: (cmd: string) => string | null;
}): Promise<{
  committed: boolean;
  message?: string;
  push?: { attempted: true; ok: boolean; error?: string };
}> {
  // Preflight: every step below shells `git`. On a git-less server the first
  // `Bun.spawn(["git", ...])` would throw a raw "Executable not found" error;
  // surface the friendly, actionable GitNotInstalledError so callers can
  // thread it into mirror status (`last_error`) instead of crashing the
  // watch loop with an opaque message.
  ensureGitAvailable(opts.which);

  const now = opts.now ?? (() => new Date().toISOString());

  const add = await gitAddAll(opts.repoDir);
  if (!add.ok) {
    console.error(`[git-commit] git add failed: ${add.stderr}`);
    return { committed: false };
  }

  const staged = await listStagedFiles(opts.repoDir);
  const decision = shouldCommit(staged, opts.notesChanged);
  if (!decision.commit) {
    if (decision.reason === "empty") {
      console.log(`[git-commit] no changes; skipping commit`);
    } else if (decision.reason === "parachute_meta_only") {
      // Unstage so the next cycle starts clean and the operator's
      // `git status` reflects the skip-decision.
      await gitUnstageAll(opts.repoDir);
      console.log(
        `[git-commit] no note changes (only .parachute/ metadata); skipping commit`,
      );
    }
    return { committed: false };
  }

  const message = renderCommitMessage(opts.template, {
    date: now(),
    notes_changed: opts.notesChanged,
    first_note_title: opts.firstNoteTitle,
    vault_name: opts.vaultName,
  });

  const commit = await gitCommit(opts.repoDir, message);
  if (!commit.ok) {
    console.error(`[git-commit] git commit failed: ${commit.stderr}`);
    return { committed: false };
  }
  console.log(`[git-commit] ${message}`);

  if (opts.push) {
    const pushResult = await gitPush(opts.repoDir);
    if (!pushResult.ok) {
      // Non-fatal — a network blip shouldn't kill a watch loop. Warn and
      // move on; the next successful commit's push will catch up history.
      const redacted = redactToken(pushResult.stderr);
      console.warn(`[git-commit] git push failed (non-fatal): ${redacted}`);
      return {
        committed: true,
        message,
        push: { attempted: true, ok: false, error: redacted },
      };
    }
    console.log(`[git-commit] pushed`);
    return { committed: true, message, push: { attempted: true, ok: true } };
  }

  return { committed: true, message };
}

/**
 * Redact tokens from a string that came back from `git push` /
 * `git ls-remote` stderr. Same pattern as `redactRemoteUrl` for full
 * URLs; also handles bare `gho_*`/`ghp_*`/`glpat-*` tokens that
 * sometimes show up in git error messages.
 *
 * Best-effort — git's error format isn't a stable contract, so we
 * scrub the obvious patterns and accept that a really unusual
 * formatting could slip through. The credentials file is the
 * authoritative store; logs are diagnostic.
 */
export function redactToken(text: string): string {
  return text
    // userinfo (https://user:token@host/…)
    .replace(/https?:\/\/[^@\s]+@/g, "https://***@")
    // bare GitHub OAuth tokens
    .replace(/gho_[A-Za-z0-9_]{8,}/g, "gho_***")
    // bare GitHub PATs
    .replace(/ghp_[A-Za-z0-9_]{8,}/g, "ghp_***")
    // bare GitLab PATs
    .replace(/glpat-[A-Za-z0-9_-]{8,}/g, "glpat-***");
}
