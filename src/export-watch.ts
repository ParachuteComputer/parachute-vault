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

/** Run `git push` in `repoDir`. Returns true on success. */
export async function gitPush(
  repoDir: string,
): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["git", "push"], {
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
 * Returns whether a commit landed.
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
}): Promise<{ committed: boolean; message?: string }> {
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
      console.warn(`[git-commit] git push failed (non-fatal): ${pushResult.stderr}`);
    } else {
      console.log(`[git-commit] pushed`);
    }
  }

  return { committed: true, message };
}
