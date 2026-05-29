/**
 * Mirror lifecycle manager — boot-time bootstrap + event-driven exports.
 *
 * This is the persistent counterpart to vault#346's CLI watch+commit mode.
 * Post-event-driven shift (vault#382, this PR), the manager replaces the
 * original `setInterval` polling loop with in-process hook subscriptions.
 * Every note / tag / attachment mutation fires an event; the manager
 * debounces them (~500ms) into a single export pass. A background
 * safety-net poll runs once per `safety_net_seconds` (default 1h) to
 * catch anything the event path missed — direct SQL writes, dropped
 * hook dispatches, restart gaps.
 *
 * Responsibilities:
 *
 *   - On vault server boot: read mirror config, resolve mirror path,
 *     bootstrap (mkdir + git init + initial commit) when internal + new,
 *     trigger an initial export to bring the mirror to current state,
 *     and — if `sync_mode: events` — subscribe to hooks + arm the
 *     safety-net poll.
 *
 *   - On config change (via `PUT /admin/mirror` or operator-triggered
 *     reload): tear down all subscriptions + timers, re-resolve,
 *     restart with the new shape.
 *
 *   - On vault server shutdown: unsubscribe, cancel any pending
 *     debounce timer, cancel safety-net poll, let an in-flight export
 *     finish via the soft settle window.
 *
 * One `MirrorManager` instance PER VAULT (vault#400). The per-vault
 * registry (`mirror-registry.ts`) holds them keyed by vault name; boot
 * stands up a manager for each vault whose config is enabled, and the
 * routes resolve a manager by the URL's vault name. Tests instantiate
 * `MirrorManager` directly with fake deps to exercise lifecycle
 * transitions without spawning a full vault server.
 *
 * Each manager is bound to its vault via `deps.vaultName` — its config
 * read/write, credential reads, and resolved mirror path are all
 * scoped to that one vault, so vault A's mirror never touches vault B's.
 *
 * ## Race-condition contract
 *
 * - **Burst collapse** — two events within DEBOUNCE_MS produce one
 *   export pass. The first event arms the timer; subsequent events
 *   re-arm it.
 * - **Event during in-flight export** — flag `dirtyDuringFlush`; after
 *   the in-flight pass completes, run another. No second concurrent
 *   pass; no missed events.
 * - **Stop() during in-flight** — like the legacy soft-settle window,
 *   give the export ~250ms to finish before returning. Subscriptions
 *   come down BEFORE the settle wait so no further events queue.
 * - **Safety net during event-driven path** — the poll's tick first
 *   checks the dirty bit. If clear, it runs a full sweep anyway (catches
 *   missed events). If set, it skips — the debounce timer's already
 *   coming.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "fs";

import {
  DEFAULT_SAFETY_NET_SECONDS,
  defaultMirrorConfig,
  resolveMirrorPath,
  type MirrorConfig,
} from "./mirror-config.ts";
import {
  gitAddAll,
  gitCommit,
  gitPush,
  isGitRepo,
  redactToken,
  runGitCommitCycle,
} from "./export-watch.ts";
import { vaultDir } from "./config.ts";
import {
  applyToGitRemote,
  readCredentials,
} from "./mirror-credentials.ts";
import { ensureGitAvailable } from "./git-preflight.ts";
import type { HookRegistry } from "../core/src/hooks.ts";

/**
 * Debounce window between an event arrival and the export pass it
 * triggers. 500ms is the sweet spot: long enough to collapse a burst
 * (typing in a frontend, a batch import) into one export, short enough
 * that the mirror feels live during normal editing.
 */
const DEBOUNCE_MS = 500;

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
  /**
   * True iff hook subscriptions are currently active.
   *
   * Pre-event-driven this was named after the polling loop; we retain
   * the name for SPA-shape stability — the SPA's "Watch loop" label
   * now reflects "events subscribed + safety-net armed". The semantics
   * shifted, not the API.
   */
  watch_running: boolean;
  /** Resolved mirror path on disk, or null if disabled / unresolved. */
  mirror_path: string | null;
  /** ISO timestamp of the most recent export pass (initial or event-driven or safety-net). */
  last_export_at: string | null;
  /** Notes touched by the most recent export pass. */
  last_export_notes_count: number | null;
  /** Commit sha of the most recent vault-authored commit. Null if no commit yet. */
  last_commit_sha: string | null;
  /** Last error message (if any). Cleared on the next successful pass. */
  last_error: string | null;
  /**
   * Cut 5: push observability — surfaced via GET /admin/mirror so the
   * operator (and the SPA's Status card) can see whether pushes are
   * actually landing without grepping `[git-commit]` log lines.
   *
   * - `last_push_at` — ISO timestamp of the most recent SUCCESSFUL push.
   *   Null until the first successful push.
   * - `last_push_sha` — sha that landed on the remote at `last_push_at`.
   *   Null when last_push_at is null.
   * - `last_push_error` — message from the most recent FAILED push.
   *   Cleared (back to null) on the next successful push. Tokens are
   *   redacted before this field is set (push paths use the
   *   `gho_`/`ghp_`/userinfo regex to scrub).
   * - `commits_unpushed` — count of local commits ahead of upstream
   *   (`git rev-list --count @{u}..HEAD`). Null when no upstream tracking
   *   exists yet (first push hasn't fired). 0 when the mirror is fully
   *   synced; positive when commits are queued.
   */
  last_push_at: string | null;
  last_push_sha: string | null;
  last_push_error: string | null;
  commits_unpushed: number | null;
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
   * Run an orphan-prune sweep against the mirror dir. Returns counts so
   * the manager can log + surface them in status. Optional — when
   * undefined, the manager skips the prune step (test seam; production
   * always wires it through `mirror-deps.ts`).
   */
  runPrune?: (opts: { outDir: string }) => Promise<{
    notes_removed: number;
    sidecars_removed: number;
    schemas_removed: number;
    attachment_dirs_removed: number;
  }>;
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
  /**
   * Shared in-process hook registry. The manager calls `.onNote()` /
   * `.onTag()` / `.onAttachment()` on this registry to drive
   * event-driven exports. Optional — when undefined the manager runs
   * with only the safety-net poll (back-compat shape for tests that
   * predate the event-driven path).
   */
  hooks?: HookRegistry;
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
  // Test seam for the git-presence preflight (default `Bun.which`). Inject a
  // fn returning `null` to exercise the git-not-installed bootstrap path.
  which?: (cmd: string) => string | null,
): Promise<BootstrapResult> {
  // Preflight: a git-less server can't bootstrap a mirror. Surface the
  // friendly, actionable message into the bootstrap-error channel so the
  // caller threads it into mirror status (`last_error`) rather than letting
  // a raw `Executable not found in $PATH: "git"` crash out of the spawn.
  try {
    ensureGitAvailable(which);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

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
 * Cut 5: count local commits ahead of upstream tracking. Implementation:
 * `git rev-list --count @{u}..HEAD` returns N when N commits are ahead,
 * 0 when synced, and exit-nonzero when no upstream tracking exists
 * (the branch has never been pushed with `-u`). The non-zero case maps
 * to `null` — distinct from "0 ahead" so the SPA can render "no remote
 * tracking yet" vs "fully synced" differently if desired.
 */
async function readCommitsUnpushed(repoDir: string): Promise<number | null> {
  const proc = Bun.spawn(
    ["git", "rev-list", "--count", "@{u}..HEAD"],
    {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null; // no upstream configured yet
  const out = new TextDecoder()
    .decode(await new Response(proc.stdout).arrayBuffer())
    .trim();
  const n = Number(out);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the current `origin` URL from a git repo's config, or null when no
 * origin is set. Module-local helper for the credential-application path.
 */
async function readCurrentOrigin(repoDir: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const url = new TextDecoder()
    .decode(await new Response(proc.stdout).arrayBuffer())
    .trim();
  return url.length > 0 ? url : null;
}

/**
 * Singleton lifecycle controller. Holds the active mirror config, the
 * resolved path, hook subscriptions (when sync_mode=events), the
 * safety-net poll timer, the debounce timer, and the rolling status.
 *
 * State transitions:
 *
 *   constructed → start() → [enabled? bootstrap + initial-export +
 *                            subscribe-to-hooks + arm-safety-net?]
 *     ↓                              ↓
 *     stop()                       reload() — tear down everything, re-evaluate
 *
 * Re-entrancy: in-flight + dirtyDuringFlush guards collapse concurrent
 * triggers into one pass + one follow-up (never two parallel exports).
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
    last_push_at: null,
    last_push_sha: null,
    last_push_error: null,
    commits_unpushed: null,
  };
  /** Safety-net poll timer (interval). Null while not armed. */
  private safetyNetTimer: ReturnType<typeof setInterval> | null = null;
  /** Debounce timer (single-shot setTimeout). Null when no events pending. */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Unsubscribe handles returned by `hooks.on*()`. */
  private unsubscribes: Array<() => void> = [];
  private stopping = false;
  /** A flush is currently running. Other triggers should not start a new one. */
  private inFlight = false;
  /** Set when an event/safety-net tick arrives during an in-flight flush. */
  private dirtyDuringFlush = false;
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
   * The vault this mirror manager belongs to. Credential reads/writes are
   * per-vault (vault#399); route handlers thread this into the credential
   * functions so they touch the right vault's `.mirror-credentials.yaml`.
   */
  getVaultName(): string {
    return this.deps.vaultName;
  }

  /**
   * Read the current config snapshot. Returns a copy so callers can't
   * accidentally mutate the manager's internal state.
   */
  getConfig(): MirrorConfig {
    return { ...this.currentConfig };
  }

  /**
   * The config the operator + SPA should SEE for this vault — distinct from
   * the live in-memory `getConfig()` only before the manager has started.
   *
   * Why this exists (vault#400): routes resolve a per-vault manager via the
   * registry, which can LAZILY build a manager for a vault that has config
   * on disk but no running instance yet (e.g. a non-default vault the
   * operator configured, or a runtime-enabled vault between PUT and the
   * reload's start). A freshly-constructed-but-never-started manager has
   * `currentConfig === defaultMirrorConfig()` (disabled), which would make
   * `GET /vault/<name>/.parachute/mirror` show "disabled" for a vault whose
   * file says `enabled: true`. Reading the persisted config when we haven't
   * started yet returns the truth for that vault. Once `start()` has run,
   * `currentConfig` is authoritative (it reflects the same persisted config
   * plus any bootstrap outcome).
   */
  getEffectiveConfig(): MirrorConfig {
    if (this.startCount === 0) {
      const persisted = this.deps.readMirrorConfig();
      if (persisted) return { ...persisted };
    }
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
        last_push_at: null,
        last_push_sha: null,
        last_push_error: null,
        commits_unpushed: null,
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

    // Apply UI-configured credentials to the mirror's git remote, if any.
    // The PAT path stores the full authed URL; we set it as `origin`.
    // The GitHub OAuth path only sets `origin` when the operator has
    // picked a repo (handleAuthGithubSelectRepo writes it then); on a
    // restart with credentials present but no repo picked yet, this is
    // a no-op. Failures are non-fatal — the operator's mirror still
    // exports; they get the original "push needs credentials" feedback
    // when auto_push fires.
    await this.applyCredentialsToRemote(path);

    // Initial export — full pass (no cursor) so the mirror starts
    // byte-equivalent to current vault state, regardless of when the
    // previous mirror was last refreshed. Also prunes orphans because
    // the initial pass writes the entire vault; anything left over
    // from a prior mirror run that doesn't match a current note is by
    // definition orphaned.
    try {
      await this.runOneCycle({ isInitial: true, prune: true });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.status.last_error = `initial export failed: ${msg}`;
      console.warn(`[mirror] ${this.status.last_error}`);
      // Don't disable the manager — operator may want to retry without
      // restarting the server. Keep status.enabled true so the safety-
      // net loop attempts again if armed; the next successful pass
      // clears last_error.
    }

    if (config.sync_mode === "events") {
      this.subscribeToHooks();
      this.armSafetyNetTimer();
      this.status.watch_running = true;
      console.log(
        `[mirror] enabled (location: ${config.location}, sync_mode: events) — initial export complete, hooks subscribed, safety-net every ${config.safety_net_seconds}s`,
      );
    } else {
      this.status.watch_running = false;
      console.log(
        `[mirror] enabled (location: ${config.location}, sync_mode: manual) — initial export complete, manual mode`,
      );
    }

    return this.getStatus();
  }

  /**
   * Stop the mirror lifecycle cleanly:
   *   - Unsubscribe from hooks first so no new events queue.
   *   - Cancel debounce + safety-net timers.
   *   - Await the in-flight cycle (if any) up to a soft timeout.
   *
   * `preserveStatus: true` is the start()-internal path that keeps the
   * status fields around for the about-to-restart pass; default false
   * blanks the `watch_running` indicator.
   */
  async stop(opts: { preserveStatus?: boolean } = {}): Promise<void> {
    this.stopping = true;

    // Unsubscribe BEFORE waiting for in-flight — additional events
    // arriving after we start the settle wait would re-arm the debounce
    // timer and stretch the wait indefinitely.
    for (const off of this.unsubscribes) {
      try {
        off();
      } catch (err) {
        // Unsubscribe should never throw; defensive log only.
        console.warn(`[mirror] unsubscribe threw: ${(err as Error).message ?? err}`);
      }
    }
    this.unsubscribes = [];

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.safetyNetTimer) {
      clearInterval(this.safetyNetTimer);
      this.safetyNetTimer = null;
    }

    // Brief settle window — give an in-flight export ~250ms to complete
    // + write a coherent commit. Don't hang shutdown indefinitely; the
    // export's status will surface a half-finished state on next start.
    const settleMs = 250;
    const start = Date.now();
    while (this.inFlight && Date.now() - start < settleMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!opts.preserveStatus) {
      this.status.watch_running = false;
    }
    this.stopping = false;
    // Discard any dirty bit from events that arrived during shutdown —
    // they'll be picked up on the next start()'s initial export anyway.
    this.dirtyDuringFlush = false;
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
   * buttons (admin SPA) + tests that want a deterministic cycle without
   * waiting on the debounce or safety-net timer.
   *
   * Always runs with prune=true: a manual trigger is an explicit "make
   * the mirror match vault state right now" request; orphan sweeps are
   * cheap on typical vaults and the operator probably wanted that
   * effect anyway.
   */
  async runNow(): Promise<MirrorStatus> {
    if (!this.status.enabled) {
      return this.getStatus();
    }
    await this.runOneCycle({ isInitial: false, prune: true });
    return this.getStatus();
  }

  // Visible-for-test: number of `start()` calls so far.
  _startCount(): number { return this.startCount; }

  // ---------------------------------------------------------------------
  // Event-driven path
  // ---------------------------------------------------------------------

  /**
   * Subscribe to note / tag / attachment hooks. Each event arms the
   * debounce timer (or marks the dirty bit if a flush is already
   * running). Stop() will call the unsubscribe handles in `unsubscribes`.
   *
   * Subscribes to every mutation event the mirror cares about:
   *   - notes: created, updated, deleted
   *   - tags: upserted, deleted
   *   - attachments: created, deleted
   */
  private subscribeToHooks(): void {
    const hooks = this.deps.hooks;
    if (!hooks) {
      // No hook registry wired — fall back to safety-net only. Logged
      // once at start; tests that exercise this path inspect status,
      // not logs.
      console.warn(
        `[mirror] sync_mode: events requested but no HookRegistry wired in deps — running with safety-net poll only`,
      );
      return;
    }

    const onMutation = () => {
      // Cheap pulse — flag dirty + arm the debounce.
      if (this.inFlight) {
        this.dirtyDuringFlush = true;
        return;
      }
      this.armDebounce();
    };

    this.unsubscribes.push(
      hooks.onNote({
        name: "mirror-note-mutation",
        event: ["created", "updated", "deleted"],
        handler: onMutation,
      }),
    );
    this.unsubscribes.push(
      hooks.onTag({
        name: "mirror-tag-mutation",
        event: ["upserted", "deleted"],
        handler: onMutation,
      }),
    );
    this.unsubscribes.push(
      hooks.onAttachment({
        name: "mirror-attachment-mutation",
        event: ["created", "deleted"],
        handler: onMutation,
      }),
    );
  }

  /**
   * Arm or re-arm the debounce timer. Subsequent calls within
   * DEBOUNCE_MS reset the timer (classic debounce). When the timer
   * fires, run an export pass; if events arrived during the export,
   * run again.
   */
  private armDebounce(): void {
    if (this.stopping) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runFlush({ prune: false });
    }, DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /**
   * Run a single flush — guards against concurrent runs, follows up
   * with another pass if events arrived mid-flight. The event-driven
   * fast path uses prune=false (rely on the targeted "deleted" events
   * for delete propagation; the safety-net + manual-run paths sweep).
   *
   * In practice deletions DO need pruning even on the fast path —
   * `exportVaultToDir` only writes existing notes; the file the
   * deletion event refers to has to be removed somewhere. The current
   * implementation runs a full prune sweep on every flush so deletes
   * propagate within the debounce window. (If profiling shows this is
   * expensive for very large vaults, a targeted-deletion queue could
   * replace the sweep on the fast path — recorded as a possible
   * future optimization in the design doc.)
   */
  private async runFlush(opts: { prune: boolean }): Promise<void> {
    if (this.stopping) return;
    if (this.inFlight) {
      // Shouldn't happen given the dirty-bit guards in armDebounce +
      // safetyNet; defensive only.
      this.dirtyDuringFlush = true;
      return;
    }
    this.inFlight = true;
    try {
      // Event-driven flushes prune-on-flush so deletions actually
      // propagate. Cost: O(mirror size) per flush — fine for typical
      // vaults. See doc above on the targeted-queue optimization.
      await this.runOneCycle({ isInitial: false, prune: true });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.status.last_error = `event-driven flush failed: ${msg}`;
      console.warn(`[mirror] ${this.status.last_error}`);
    } finally {
      this.inFlight = false;
    }

    // If events arrived during the flush, run again (one follow-up,
    // not a loop — armDebounce re-engages if events keep coming).
    if (this.dirtyDuringFlush && !this.stopping) {
      this.dirtyDuringFlush = false;
      this.armDebounce();
    }
  }

  /**
   * Arm the safety-net poll. Runs once per `safety_net_seconds`. When
   * it fires:
   *   - If a flush is already pending (debounce armed) or in-flight,
   *     skip (the event path will catch it).
   *   - Otherwise, run a full prune+export sweep so anything missed by
   *     the events (direct SQL writes, dropped dispatches, restart
   *     gaps) lands in the mirror.
   */
  private armSafetyNetTimer(): void {
    if (this.safetyNetTimer) return;
    const intervalMs = (
      this.currentConfig.safety_net_seconds || DEFAULT_SAFETY_NET_SECONDS
    ) * 1000;
    this.safetyNetTimer = setInterval(async () => {
      if (this.stopping) return;
      if (this.debounceTimer || this.inFlight) {
        // Event path's already handling things; this poll is a no-op.
        return;
      }
      await this.runFlush({ prune: true });
    }, intervalMs);
    this.safetyNetTimer.unref?.();
  }

  /**
   * Stage → export → prune (optional) → commit pipeline for a single
   * cycle. Updates status fields with the outcome. Errors logged +
   * reflected in `last_error` but never rethrown out of the event
   * dispatcher (would kill the loop).
   */
  private async runOneCycle(opts: { isInitial: boolean; prune: boolean }): Promise<void> {
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

    // Orphan sweep — removes files in the mirror that don't correspond
    // to a current vault note/tag/attachment. Counts surface in logs;
    // the count of removed files is folded into the commit's
    // `notes_changed` so the commit message reflects the delete too.
    let prunedNotes = 0;
    if (opts.prune && this.deps.runPrune) {
      try {
        const pruneStats = await this.deps.runPrune({ outDir: path });
        prunedNotes = pruneStats.notes_removed + pruneStats.sidecars_removed;
        const removedTotal =
          pruneStats.notes_removed +
          pruneStats.sidecars_removed +
          pruneStats.schemas_removed +
          pruneStats.attachment_dirs_removed;
        if (removedTotal > 0) {
          console.log(
            `[mirror] prune: removed ${pruneStats.notes_removed} note(s), ${pruneStats.sidecars_removed} sidecar(s), ${pruneStats.schemas_removed} schema(s), ${pruneStats.attachment_dirs_removed} attachment dir(s)`,
          );
        }
      } catch (err) {
        // Prune failure is non-fatal — the export already wrote the
        // current state; the next sweep retries.
        console.warn(
          `[mirror] prune failed (non-fatal): ${(err as Error).message ?? err}`,
        );
      }
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

    // Commit when EITHER notes changed OR orphans were pruned. The
    // commit message's `notes_changed` reflects the union — operators
    // reading a "deleted 3 notes" diff in their mirror should see that
    // count in the commit. (Pre-event-driven this was strictly
    // notes-from-export; orphan deletes weren't tracked.)
    const totalChanged = stats.notes + prunedNotes;
    if (totalChanged === 0) {
      // Nothing to commit; runGitCommitCycle would no-op anyway, but
      // skipping early avoids the firstNoteTitle DB lookup.
      return;
    }

    const firstNoteTitle = await this.deps.firstChangedNoteTitle(sinceCursor);
    let commitResult: Awaited<ReturnType<typeof runGitCommitCycle>>;
    try {
      commitResult = await runGitCommitCycle({
        repoDir: path,
        template: this.currentConfig.commit_template,
        notesChanged: totalChanged,
        vaultName: this.deps.vaultName,
        firstNoteTitle,
        push: this.currentConfig.auto_push,
      });
    } catch (err) {
      // git-not-installed (or any commit-cycle throw) lands in status as a
      // friendly last_error rather than crashing the cycle. Matches the
      // "errors reflected in last_error, never rethrown" contract above.
      const msg = (err as Error).message ?? String(err);
      this.status.last_error = `commit cycle failed: ${msg}`;
      console.warn(`[mirror] ${this.status.last_error}`);
      return;
    }

    if (commitResult.committed) {
      // Resolve the new HEAD sha so the status displays the commit that
      // just landed. Best-effort; if the rev-parse fails (it shouldn't
      // immediately after a successful commit) we leave the prior sha.
      const shaProc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: path, stdout: "pipe", stderr: "pipe" });
      await shaProc.exited;
      const sha = new TextDecoder().decode(await new Response(shaProc.stdout).arrayBuffer()).trim();
      if (sha.length > 0) this.status.last_commit_sha = sha;
    }

    // Cut 5: surface push outcome (success/failure + redacted error).
    // runGitCommitCycle returns push info iff push was attempted; we
    // mirror the same shape into status here.
    if (commitResult.push) {
      const now = new Date().toISOString();
      if (commitResult.push.ok) {
        this.status.last_push_at = now;
        this.status.last_push_sha = this.status.last_commit_sha;
        this.status.last_push_error = null;
      } else if (commitResult.push.error) {
        this.status.last_push_error = commitResult.push.error;
      }
    }

    // Cut 5: track local-commits-ahead-of-upstream so the UI can render
    // "<N> commits ready to push" subdued helper text.
    this.status.commits_unpushed = await readCommitsUnpushed(path);
  }

  /**
   * Cut 6: fire a `git push` against the current mirror dir, capture
   * the outcome into status, and return a struct the route handler can
   * fold into its response.
   *
   * Distinguished from `runNow()` which exports + commits + pushes.
   * `pushNow()` skips export + commit entirely and only pushes whatever
   * has already been committed. Used by:
   *   - the credential save path (auto-fire after `auth/pat` /
   *     `auth/github/select-repo` lands) so the operator sees the
   *     push happen rather than waiting for the next write
   *   - the explicit POST /.parachute/mirror/push-now route the SPA's
   *     "Push now" button hits
   *
   * Idempotent against a fully-synced mirror (git push reports "nothing
   * to push" with exit 0). Failure paths set `last_push_error` for the
   * status surface.
   */
  async pushNow(): Promise<
    | { fired: false; reason: "not_enabled" | "no_mirror_path" }
    | { fired: true; pushed: boolean; sha?: string; error?: string }
  > {
    if (!this.status.enabled) return { fired: false, reason: "not_enabled" };
    if (!this.status.mirror_path) return { fired: false, reason: "no_mirror_path" };
    const path = this.status.mirror_path;
    // Preflight: git-less server can't push. Surface the friendly message
    // into last_push_error (the SPA renders it) rather than throwing a raw
    // "Executable not found" out of the gitPush spawn.
    try {
      ensureGitAvailable();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.status.last_push_error = msg;
      console.warn(`[mirror] push-now failed: ${msg}`);
      return { fired: true, pushed: false, error: msg };
    }
    const pushResult = await gitPush(path);
    const now = new Date().toISOString();
    // Refresh commits_unpushed either way — a no-op push still reflects
    // the current state (0 ahead if synced, N if push failed mid-way).
    this.status.commits_unpushed = await readCommitsUnpushed(path);
    if (pushResult.ok) {
      // Capture HEAD sha at this point so the UI can show the operator
      // exactly what landed.
      const shaProc = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: path,
        stdout: "pipe",
        stderr: "pipe",
      });
      await shaProc.exited;
      const sha = new TextDecoder()
        .decode(await new Response(shaProc.stdout).arrayBuffer())
        .trim();
      this.status.last_push_at = now;
      if (sha.length > 0) this.status.last_push_sha = sha;
      this.status.last_push_error = null;
      return { fired: true, pushed: true, sha: sha.length > 0 ? sha : undefined };
    }
    const redacted = redactToken(pushResult.stderr);
    this.status.last_push_error = redacted;
    console.warn(`[mirror] push-now failed (non-fatal): ${redacted}`);
    return { fired: true, pushed: false, error: redacted };
  }

  /**
   * Apply UI-configured credentials to the mirror dir's `origin`. Called
   * on every start()/reload() so credential rotations land without
   * requiring a server restart. Idempotent:
   *   - active_method=pat → set origin to the stored authed URL
   *   - active_method=github_oauth + a picked repo → set origin (the
   *     pick path stores the authed URL in the same flow)
   *   - active_method=github_oauth + no repo picked → no-op (UI is mid-
   *     flow)
   *   - no credentials at all → leave whatever the operator wired by
   *     hand alone (don't clobber a manually-set remote)
   *
   * Never throws — push failures will surface via the existing
   * non-fatal-warn path in runGitCommitCycle.
   */
  private async applyCredentialsToRemote(repoDir: string): Promise<void> {
    try {
      const creds = readCredentials(this.deps.vaultName);
      if (!creds || !creds.active_method) {
        // No UI-configured credentials. Leave the remote alone — the
        // operator may have set one up via `git remote add` manually.
        return;
      }
      if (creds.active_method === "pat" && creds.pat) {
        const result = await applyToGitRemote(repoDir, creds.pat.remote_url);
        if (!result.ok) {
          console.warn(
            `[mirror] could not apply PAT remote URL (non-fatal): ${result.error}`,
          );
        }
        return;
      }
      // github_oauth: the active token is set, but a repo may not yet be
      // picked. The select-repo route handler writes the URL; on a
      // subsequent restart we can't reconstruct the URL without the
      // owner/repo. Best-effort: if `origin` already points at a github.com
      // URL, rewrite it with the stored token in case the token rotated.
      if (creds.active_method === "github_oauth" && creds.github_oauth) {
        const current = await readCurrentOrigin(repoDir);
        if (current && current.includes("github.com")) {
          // Parse owner/repo out of the current URL.
          const match = current.match(
            /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/,
          );
          if (match) {
            const [, owner, repo] = match;
            const { githubAuthedRemoteUrl } = await import("./mirror-credentials.ts");
            const authed = githubAuthedRemoteUrl(
              creds.github_oauth.access_token,
              owner!,
              repo!,
            );
            const result = await applyToGitRemote(repoDir, authed);
            if (!result.ok) {
              console.warn(
                `[mirror] could not refresh github_oauth remote URL (non-fatal): ${result.error}`,
              );
            }
          }
        }
      }
    } catch (err) {
      console.warn(
        `[mirror] credential application failed (non-fatal): ${(err as Error).message ?? err}`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Test seams
  // ---------------------------------------------------------------------

  /**
   * Force the debounce timer to fire immediately (cancel + run flush).
   * Used by mirror-manager.test.ts to avoid sleeping through 500ms in
   * every event-driven test case. Not exposed via the public API.
   */
  async _flushDebounceForTest(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.runFlush({ prune: false });
  }

  /** Test seam: snapshot of the unsubscribe-handle count. */
  _subscriptionCount(): number {
    return this.unsubscribes.length;
  }
}
