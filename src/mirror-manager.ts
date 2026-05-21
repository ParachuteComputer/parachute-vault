/**
 * Mirror lifecycle manager — boot-time bootstrap + in-process watch loop.
 *
 * This is the persistent counterpart to vault#346's CLI watch+commit mode.
 * Responsibilities:
 *
 *   - On vault server boot: read mirror config, resolve mirror path,
 *     bootstrap (mkdir + git init + initial commit) when internal + new,
 *     trigger an initial export to bring the mirror to current state,
 *     and — if `watch: true` — start an in-process polling loop.
 *
 *   - On config change (via `PUT /admin/mirror` or operator-triggered
 *     reload): stop the current watch loop cleanly, re-resolve, restart
 *     with the new shape.
 *
 *   - On vault server shutdown: drain in-flight export + cancel the
 *     interval timer cleanly.
 *
 * Singleton per-process: one `MirrorManager` instance backs the vault
 * server's lifecycle. Tests instantiate `MirrorManager` directly with
 * fake deps to exercise lifecycle transitions without spawning a full
 * vault server.
 *
 * Phase A1 deliberately surfaces ONE mirror per vault server (matching
 * the design doc's single-mirror-per-vault model). Multi-vault server
 * deployments today already pin one vault per server via
 * `PARACHUTE_VAULT_NAME` / `default_vault`; the mirror config follows
 * suit. Multi-vault mirror routing is a future ripple (open question 2
 * in the design doc).
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "fs";

import {
  defaultMirrorConfig,
  resolveMirrorPath,
  type MirrorConfig,
} from "./mirror-config.ts";
import {
  gitAddAll,
  gitCommit,
  isGitRepo,
  runGitCommitCycle,
} from "./export-watch.ts";
import { vaultDir } from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Runtime snapshot of mirror state — surfaced via `GET /admin/mirror` so
 * the operator (and the future hub admin SPA) can see what vault is
 * actually doing without grepping logs.
 */
export interface MirrorStatus {
  /** True iff `mirror.enabled` is true AND bootstrap succeeded. */
  enabled: boolean;
  /** True iff a watch interval timer is currently armed. */
  watch_running: boolean;
  /** Resolved mirror path on disk, or null if disabled / unresolved. */
  mirror_path: string | null;
  /** ISO timestamp of the most recent export pass (initial or watch). */
  last_export_at: string | null;
  /** Notes touched by the most recent export pass. */
  last_export_notes_count: number | null;
  /** Commit sha of the most recent vault-authored commit. Null if no commit yet. */
  last_commit_sha: string | null;
  /** Last error message (if any). Cleared on the next successful pass. */
  last_error: string | null;
}

/**
 * Dependency-injection seam — what the manager needs from the rest of the
 * vault. Carrying these as fields keeps the tests cheap (no real vault DB,
 * no real config.yaml writes) and the production wiring obvious (server.ts
 * passes the live store + writer at construction time).
 */
export interface MirrorDeps {
  /** Name of the vault whose state the mirror reflects. */
  vaultName: string;
  /**
   * Run a single export pass into `outDir`. Returns the count of notes
   * touched so the commit cycle can render `{{notes_changed}}`. Optional
   * `sinceCursor` controls incremental vs full export.
   */
  runExport: (opts: {
    outDir: string;
    sinceCursor?: string;
  }) => Promise<{ notes: number }>;
  /**
   * Resolve the first-changed-note title since `cursor`, for the
   * `{{first_note_title}}` commit-template variable. Best-effort — empty
   * string when nothing matches.
   */
  firstChangedNoteTitle: (cursor: string | undefined) => Promise<string>;
  /** Read current mirror config from persistent storage (or defaults). */
  readMirrorConfig: () => MirrorConfig | undefined;
  /**
   * Atomically persist the mirror config block. Writes the config.yaml
   * via the standard writer — used by `PUT /admin/mirror`.
   */
  writeMirrorConfig: (config: MirrorConfig) => void;
}

// ---------------------------------------------------------------------------
// Internal-mirror bootstrap
//
// `mkdir -p` → `git init` → initial commit only if the dir is empty + new.
// If the path already exists AND is a git repo: leave it alone (operator
// might have set it up themselves; we trust their state).
// If the path exists but ISN'T a git repo: refuse to clobber. Return an
// error the caller surfaces in logs + status.
// ---------------------------------------------------------------------------

export interface BootstrapResultOk {
  ok: true;
  /** True iff this call performed the initial `git init` + seed commit. */
  initialized: boolean;
  /** Resolved path to the mirror dir. */
  path: string;
}
export interface BootstrapResultError {
  ok: false;
  error: string;
}
export type BootstrapResult = BootstrapResultOk | BootstrapResultError;

/**
 * Ensure the internal mirror directory exists and is a git repo. Idempotent
 * — calling on an already-initialized mirror is a fast no-op that just
 * checks the existing repo.
 *
 * Refuse-to-clobber policy: if the path exists and contains files but
 * isn't a git repo, we don't `git init` over the operator's data. Surface
 * a clear error and let them choose (rm + retry, or switch to external).
 * This matches the "don't auto-git-init" framing in the design doc — for
 * internal mirrors we DO auto-init, but only on the empty case, not on
 * pre-existing non-git state.
 */
export async function bootstrapInternalMirror(
  path: string,
): Promise<BootstrapResult> {
  if (existsSync(path)) {
    let stat;
    try {
      stat = statSync(path);
    } catch (err) {
      return {
        ok: false,
        error: `Could not stat internal mirror path ${path}: ${(err as Error).message ?? err}`,
      };
    }
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: `Internal mirror path ${path} exists but isn't a directory. Remove it (or switch to location=external) and retry.`,
      };
    }
    // Existing dir — check git-repo-ness.
    const isRepo = await isGitRepo(path);
    if (isRepo) return { ok: true, initialized: false, path };
    // Non-empty, non-git: refuse to clobber.
    const entries = readdirSync(path);
    if (entries.length > 0) {
      return {
        ok: false,
        error: `Internal mirror path ${path} exists with ${entries.length} entries but isn't a git repository. Remove it (\`rm -rf ${path}\`) and restart the vault to re-bootstrap, or switch to a different location.`,
      };
    }
    // Empty dir, not yet a repo — fall through to init.
  } else {
    mkdirSync(path, { recursive: true });
  }

  // `git init` — default branch `main` to match the CLI's convention from
  // vault#346 and avoid the `git init` legacy `master` default surprising
  // operators in newer git installs.
  const initProc = Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: path, stdout: "pipe", stderr: "pipe" });
  const initCode = await initProc.exited;
  if (initCode !== 0) {
    const stderr = new TextDecoder().decode(await new Response(initProc.stderr).arrayBuffer());
    return {
      ok: false,
      error: `\`git init\` failed in ${path}: ${stderr.trim()}`,
    };
  }

  // Seed user.email/user.name LOCAL to this repo. The internal mirror is
  // vault-managed — operators' global git config might be unset (CI, fresh
  // Docker containers) or might point at a different identity. Local config
  // beats inheriting whatever happens to be on the box.
  Bun.spawnSync(["git", "config", "user.email", "vault@parachute.computer"], { cwd: path });
  Bun.spawnSync(["git", "config", "user.name", "Parachute Vault"], { cwd: path });
  // Avoid GPG signing failing on dev boxes that have commit.gpgsign=true
  // globally but no key in this context.
  Bun.spawnSync(["git", "config", "commit.gpgsign", "false"], { cwd: path });

  // Seed commit so the repo has a HEAD — keeps subsequent commits + diff
  // tooling simple. A bare `.gitkeep` is the lightest touch.
  const fs = await import("fs");
  fs.writeFileSync(`${path}/.gitkeep`, "");
  const add = await gitAddAll(path);
  if (!add.ok) {
    return {
      ok: false,
      error: `\`git add\` of seed file failed in ${path}: ${add.stderr}`,
    };
  }
  const commit = await gitCommit(path, "initial mirror bootstrap");
  if (!commit.ok) {
    return {
      ok: false,
      error: `\`git commit\` of seed file failed in ${path}: ${commit.stderr}`,
    };
  }
  return { ok: true, initialized: true, path };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Singleton lifecycle controller. Holds the active mirror config, the
 * resolved path, the watch timer (when running), and the rolling status.
 *
 * State transitions:
 *
 *   constructed → start() → [enabled? bootstrap+initial-export+watch?]
 *     ↓                              ↓
 *     stop()                       reload() — stop current loop, re-evaluate
 *
 * Re-entrancy: the watch tick uses a `inFlight` guard like the CLI mode so
 * back-to-back ticks (e.g. when an export takes longer than the interval)
 * don't pile up.
 */
export class MirrorManager {
  private deps: MirrorDeps;
  private status: MirrorStatus = {
    enabled: false,
    watch_running: false,
    mirror_path: null,
    last_export_at: null,
    last_export_notes_count: null,
    last_commit_sha: null,
    last_error: null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private inFlight = false;
  /** Most recent export cursor — passed as `--since` to the next pass. */
  private cursor: string | undefined = undefined;
  private currentConfig: MirrorConfig = defaultMirrorConfig();
  /**
   * Counts how many times start() has been called. Used by tests to assert
   * idempotency (a no-op restart on the same config doesn't re-bootstrap).
   */
  private startCount = 0;

  constructor(deps: MirrorDeps) {
    this.deps = deps;
  }

  /**
   * Read the current config snapshot. Returns a copy so callers can't
   * accidentally mutate the manager's internal state.
   */
  getConfig(): MirrorConfig {
    return { ...this.currentConfig };
  }

  /**
   * Get the current status snapshot. Returns a copy for the same reason as
   * `getConfig`.
   */
  getStatus(): MirrorStatus {
    return { ...this.status };
  }

  /**
   * Start (or restart) the mirror lifecycle from the current persisted
   * config. Idempotent within an "enabled+running" steady state but always
   * stops first to avoid double-armed timers.
   *
   * Returns the final status snapshot — useful for tests + the PUT
   * endpoint response.
   */
  async start(): Promise<MirrorStatus> {
    this.startCount++;
    await this.stop({ preserveStatus: true });

    const config = this.deps.readMirrorConfig() ?? defaultMirrorConfig();
    this.currentConfig = config;

    if (!config.enabled) {
      this.status = {
        enabled: false,
        watch_running: false,
        mirror_path: null,
        last_export_at: null,
        last_export_notes_count: null,
        last_commit_sha: null,
        last_error: null,
      };
      return this.getStatus();
    }

    const vaultDataDir = vaultDir(this.deps.vaultName);
    const path = resolveMirrorPath(vaultDataDir, config);
    if (!path) {
      this.status.enabled = false;
      this.status.last_error =
        "Mirror enabled but path could not be resolved (location=external without external_path?).";
      console.warn(`[mirror] ${this.status.last_error}`);
      return this.getStatus();
    }
    this.status.mirror_path = path;

    // Internal bootstrap. External path is the operator's responsibility —
    // they should have validated via the PUT endpoint before we hit boot.
    // We re-check `isGitRepo` defensively here either way; a missing/non-
    // git external path lands as a soft-error status without crashing the
    // vault server.
    if (config.location === "internal") {
      const result = await bootstrapInternalMirror(path);
      if (!result.ok) {
        this.status.enabled = false;
        this.status.last_error = result.error;
        console.warn(`[mirror] bootstrap failed: ${result.error}`);
        return this.getStatus();
      }
      if (result.initialized) {
        console.log(`[mirror] initialized internal mirror at ${path}`);
      }
    } else {
      // External — sanity-check the path is still there + is a git repo.
      if (!existsSync(path)) {
        this.status.enabled = false;
        this.status.last_error = `External mirror path ${path} doesn't exist on disk.`;
        console.warn(`[mirror] ${this.status.last_error}`);
        return this.getStatus();
      }
      if (!(await isGitRepo(path))) {
        this.status.enabled = false;
        this.status.last_error = `External mirror path ${path} isn't a git repository.`;
        console.warn(`[mirror] ${this.status.last_error}`);
        return this.getStatus();
      }
    }

    this.status.enabled = true;
    this.status.last_error = null;

    // Initial export — full pass (no cursor) so the mirror starts
    // byte-equivalent to current vault state, regardless of when the
    // previous mirror was last refreshed.
    try {
      await this.runOneCycle({ isInitial: true });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.status.last_error = `initial export failed: ${msg}`;
      console.warn(`[mirror] ${this.status.last_error}`);
      // Don't disable the manager — operator may want to retry without
      // restarting the server. Keep status.enabled true so the watch
      // loop attempts again if armed; the next successful pass clears
      // last_error.
    }

    if (config.watch) {
      this.armWatchTimer();
      this.status.watch_running = true;
      console.log(
        `[mirror] enabled (location: ${config.location}, watch: true) — initial export complete, watch loop running every ${config.interval_seconds}s`,
      );
    } else {
      this.status.watch_running = false;
      console.log(
        `[mirror] enabled (location: ${config.location}, watch: false) — initial export complete, manual mode`,
      );
    }

    return this.getStatus();
  }

  /**
   * Stop the watch loop cleanly. Awaits the in-flight cycle (if any) up to
   * a soft timeout — don't hang shutdown forever, but give a running
   * export a chance to finish + write a coherent commit.
   *
   * `preserveStatus: true` is the start()-internal path that keeps the
   * status fields around for the about-to-restart pass; default false
   * blanks them.
   */
  async stop(opts: { preserveStatus?: boolean } = {}): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Brief settle window — match the CLI watch-loop convention.
    const settleMs = 250;
    const start = Date.now();
    while (this.inFlight && Date.now() - start < settleMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!opts.preserveStatus) {
      this.status.watch_running = false;
    }
    this.stopping = false;
  }

  /**
   * Reload: persist the new config + restart the lifecycle. The PUT
   * `/admin/mirror` endpoint calls this.
   *
   * The persist step happens FIRST so a crash mid-restart still leaves
   * the operator-intended config on disk; on the next vault boot it
   * applies cleanly.
   */
  async reload(newConfig: MirrorConfig): Promise<MirrorStatus> {
    this.deps.writeMirrorConfig(newConfig);
    return this.start();
  }

  /**
   * Force a one-shot export cycle right now. Useful for "force re-export"
   * buttons (future hub UI) + tests that want a deterministic cycle
   * without waiting on the timer.
   */
  async runNow(): Promise<MirrorStatus> {
    if (!this.status.enabled) {
      return this.getStatus();
    }
    await this.runOneCycle({ isInitial: false });
    return this.getStatus();
  }

  // Visible-for-test: number of `start()` calls so far.
  _startCount(): number { return this.startCount; }

  /**
   * Stage → export → commit pipeline for a single cycle. Updates status
   * fields with the outcome. Errors logged + reflected in `last_error`
   * but never rethrown out of the watch loop (the loop would die).
   */
  private async runOneCycle(opts: { isInitial: boolean }): Promise<void> {
    const nextCursor = new Date().toISOString();
    const path = this.status.mirror_path!;
    const sinceCursor = opts.isInitial ? undefined : this.cursor;

    let stats: { notes: number };
    try {
      stats = await this.deps.runExport({ outDir: path, sinceCursor });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.status.last_error = `export failed: ${msg}`;
      console.warn(`[mirror] ${this.status.last_error}`);
      return;
    }

    this.cursor = nextCursor;
    this.status.last_export_at = nextCursor;
    this.status.last_export_notes_count = stats.notes;
    this.status.last_error = null;

    if (!this.currentConfig.auto_commit) {
      // No commit, but cursor advanced — next pass picks up only new
      // writes. Matches the "Manual Export" preset's spirit: vault still
      // tracks state, just doesn't author commits.
      return;
    }

    const firstNoteTitle = await this.deps.firstChangedNoteTitle(sinceCursor);
    const commitResult = await runGitCommitCycle({
      repoDir: path,
      template: this.currentConfig.commit_template,
      notesChanged: stats.notes,
      vaultName: this.deps.vaultName,
      firstNoteTitle,
      push: this.currentConfig.auto_push,
    });

    if (commitResult.committed) {
      // Resolve the new HEAD sha so the status displays the commit that
      // just landed. Best-effort; if the rev-parse fails (it shouldn't
      // immediately after a successful commit) we leave the prior sha.
      const shaProc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: path, stdout: "pipe", stderr: "pipe" });
      await shaProc.exited;
      const sha = new TextDecoder().decode(await new Response(shaProc.stdout).arrayBuffer()).trim();
      if (sha.length > 0) this.status.last_commit_sha = sha;
    }
  }

  /**
   * Arm the watch interval. Tick is in-flight-guarded so a slow export
   * doesn't pile up parallel runs.
   */
  private armWatchTimer(): void {
    if (this.timer) return;
    const intervalMs = this.currentConfig.interval_seconds * 1000;
    this.timer = setInterval(async () => {
      if (this.stopping || this.inFlight) return;
      this.inFlight = true;
      try {
        await this.runOneCycle({ isInitial: false });
      } catch (err) {
        // Defensive — runOneCycle already swallows export errors, but
        // commit/git errors might bubble. Never kill the loop.
        const msg = (err as Error).message ?? String(err);
        this.status.last_error = `watch tick failed: ${msg}`;
        console.warn(`[mirror] ${this.status.last_error}`);
      } finally {
        this.inFlight = false;
      }
    }, intervalMs);
    // Don't keep the server process alive purely on the timer; vault
    // already has the HTTP server + various intervals doing that.
    this.timer.unref?.();
  }
}
