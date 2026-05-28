/**
 * Clone + import worker — symmetric counterpart to the export path that
 * vault#382 + vault#384 shipped.
 *
 * The "import from a git repo" feature lets an operator on machine B pull a
 * vault state that machine A has been pushing to a git remote. The flow:
 *
 *   1. Operator opens the admin SPA's "Import from git" section.
 *   2. Picks a remote URL (paste, OAuth repo-picker, or a one-time PAT).
 *   3. Picks a mode — `merge` (upsert-by-id, preserves notes that aren't
 *      in the remote) or `replace` (wipe-then-import, the remote becomes
 *      the new source of truth).
 *   4. POSTs to `/.parachute/mirror/import`. The handler delegates to
 *      `cloneAndImport()` below.
 *
 * `cloneAndImport()`:
 *
 *   - Creates a temp dir (`os.tmpdir() + /parachute-import-<rand>`).
 *   - Resolves the authed clone URL (stored credentials, supplied per-call
 *     PAT, or none).
 *   - Shells `git clone --depth 1 <authedUrl> <tempDir>` with a 60s
 *     timeout and `GIT_TERMINAL_PROMPT=0` so bad credentials fail fast
 *     rather than blocking on a stdin prompt.
 *   - Validates the clone looks like a vault export — `.parachute/vault.yaml`
 *     must be present. Refuses with a clear error otherwise.
 *   - On `mode: "replace"`: wipes notes + tags via `store.deleteNote()` /
 *     `store.deleteTag()` (same shape `importPortableVault` does
 *     internally when `blowAway: true` — we call the importer with
 *     `blowAway: true` to inherit that semantics rather than rolling our
 *     own delete loop).
 *   - Calls `importPortableVault(store, { inDir, blowAway, assetsDir })`.
 *   - Returns aggregated stats (notes_imported, tags_imported,
 *     attachments_imported, notes_deleted, warnings).
 *   - Always cleans up the temp dir on every code path (try/finally).
 *
 * **Threat model — credentials in argv (reviewer-flagged vault#384):**
 *
 *   `git clone <https://x-access-token:TOKEN@host/...>` puts the token in
 *   `/proc/<pid>/cmdline` for the clone window (~few seconds). For vault's
 *   owner-operated, single-user self-host posture this is acceptable —
 *   anyone with shell on the box already has read access to
 *   `~/.parachute/vault/.mirror-credentials.yaml` (0600) and would have
 *   `~/.git-credentials` for that matter. Same posture as `git ls-remote`
 *   in mirror-credentials.ts. Multi-tenant cloud (cloud Tier 2) would
 *   switch this to a credential-helper script so the token never enters
 *   argv. Today's pattern: documented + scoped to the threat model.
 *
 * **Concurrency:** the in-flight set below blocks two concurrent imports
 * against the same vault name. The first lays a marker; the second
 * receives the conflict signal so the HTTP handler can return 409.
 *
 * **SIGTERM tempdir leak (known, acceptable):** if vault gets killed
 * mid-clone (SIGINT/SIGTERM during the `Bun.spawn` window), the
 * `parachute-import-<rand>` tempdir is abandoned on disk. Same posture
 * as `probeGitLsRemote` in mirror-routes.ts — owner can sweep
 * `/tmp/parachute-import-*` manually if they care. Adding a signal
 * handler that cleans up only the in-flight import dir(s) is feasible
 * but a) requires registering on every server boot, b) interacts
 * weirdly with the existing graceful-shutdown drain path, c) doesn't
 * close the OOM-killer / power-loss case anyway. Acceptable as-is for
 * the self-host threat model.
 *
 * See vault#391 (the import sibling of #384's export work).
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  importPortableVault,
  type ImportStats,
} from "../core/src/portable-md.ts";
import type { SqliteStore } from "../core/src/store.ts";
import { redactRemoteUrl, readCredentials } from "./mirror-credentials.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Auth shape for a clone:
 *
 *   - `{ kind: "credentialsFile" }` — use the stored mirror credentials
 *     (`~/.parachute/vault/.mirror-credentials.yaml`). If none exist the
 *     clone proceeds unauthed — fine for public repos, will fail for
 *     private ones with a clear `git`-surfaced error.
 *   - `{ kind: "pat", token, remoteUrl }` — one-shot. The supplied PAT
 *     gets embedded in the remote URL via the GitHub `x-access-token`
 *     convention. Does NOT touch the stored credentials.
 *   - `{ kind: "none" }` — explicit no-auth (for genuinely public repos).
 */
export type ImportAuth =
  | { kind: "credentialsFile" }
  | { kind: "pat"; token: string }
  | { kind: "none" };

/** What the caller passes to `cloneAndImport`. */
export interface ImportOpts {
  /** Target vault name (the one currently being imported INTO). */
  vaultName: string;
  /** HTTPS or SSH clone URL the operator pasted / picked. */
  remoteUrl: string;
  /** How to authenticate the clone. See `ImportAuth`. */
  auth: ImportAuth;
  /**
   * `merge` — upsert-by-id semantics. Existing notes updated, new ones
   * created, notes that aren't in the remote SURVIVE.
   * `replace` — wipe-first. The remote becomes the new source of truth;
   * any local-only notes are deleted.
   */
  mode: "merge" | "replace";
  /** Vault store to write into. */
  store: SqliteStore;
  /**
   * Assets dir (where attachment binaries live for this vault). Wire
   * via `assetsDir(vaultName)` from `routes.ts`.
   */
  assetsDir: string;
  /** Override the temp dir (test seam). Defaults to `os.tmpdir()`. */
  workDirRoot?: string;
  /** Override the spawner (test seam — fake `git`). */
  spawn?: GitSpawn;
  /** Override the post-clone import path (test seam — assume cloned dir is a vault export). */
  importer?: typeof importPortableVault;
  /** Override the clone timeout (default 60s; test seam to shorten). */
  cloneTimeoutMs?: number;
}

/**
 * Counts + warnings returned to the HTTP caller. `notes_imported` totals
 * created+updated so the operator sees a single "imported N notes" number
 * regardless of mode. `notes_deleted` is set only when `mode === "replace"`.
 */
export interface ImportResult {
  notes_imported: number;
  tags_imported: number;
  attachments_imported: number;
  /** Only set when `mode === "replace"`. */
  notes_deleted?: number;
  /**
   * Per-skipped-thing detail (links pointing to notes outside the import
   * set, attachments missing binaries, sidecars without content files,
   * etc.). The HTTP handler returns these so the operator can audit.
   */
  warnings: string[];
}

/**
 * Shape of the spawner we accept. Real impl is `Bun.spawn`. Tests inject
 * a fake to skip the real git binary.
 */
export type GitSpawn = (
  argv: string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<GitSpawnResult>;

export interface GitSpawnResult {
  exitCode: number;
  stderr: string;
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Concurrency guard — refuse 409 if the same vault is already importing.
// ---------------------------------------------------------------------------

const inFlight = new Set<string>();

/** Throw the conflict signal — handler catches and turns into a 409. */
export class ImportConflictError extends Error {
  constructor(vaultName: string) {
    super(
      `Import already running for vault "${vaultName}". Wait for it to finish before starting another.`,
    );
    this.name = "ImportConflictError";
  }
}

/** Throw when the clone target is not a portable-md vault export. */
export class NotAVaultExportError extends Error {
  constructor() {
    super(
      'This does not look like a Parachute vault export — no `.parachute/vault.yaml` found at the repo root. ' +
        "Make sure the remote was created by `parachute-vault export` or the mirror's export flow.",
    );
    this.name = "NotAVaultExportError";
  }
}

/** Throw when the clone itself fails (network, auth, missing repo, etc.). */
export class CloneFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloneFailedError";
  }
}

// ---------------------------------------------------------------------------
// Auth URL helpers
// ---------------------------------------------------------------------------

/**
 * Build the URL we hand to `git clone`. Behavior depends on `auth`:
 *
 *   - `pat` → embed `x-access-token:<TOKEN>` userinfo if the URL doesn't
 *     already carry creds. Sibling of `mirror-credentials.ts`'s
 *     `applyToGitRemote` approach.
 *   - `credentialsFile` → if stored creds are GitHub OAuth, embed the
 *     token. If stored creds are a PAT with a saved URL whose host
 *     matches, reuse the stored URL. Otherwise pass the URL verbatim.
 *   - `none` → return the URL verbatim.
 *
 * Returns `null` when the URL is unparseable (caller surfaces a 400).
 */
export function authedCloneUrl(
  remoteUrl: string,
  auth: ImportAuth,
): { authedUrl: string; appliedAuth: "stored_oauth" | "stored_pat" | "per_call_pat" | "none" } | null {
  // Local-path / SSH-shorthand pass-through. Git accepts three URL shapes:
  //   - HTTPS/HTTP — what we embed auth into below.
  //   - SSH (`git@host:owner/repo`) — relies on ssh-agent, no userinfo
  //     slot. We pass verbatim.
  //   - Local path (`/abs/path` or `./rel/path`) or `file://` — used by
  //     local-disk mirrors + E2E tests. Pass verbatim; no auth to embed.
  // The naive `new URL(...)` call below would reject all three of these
  // pre-validation (local paths don't have a scheme), so detect them
  // first.
  if (remoteUrl.startsWith("/") || remoteUrl.startsWith("./") || remoteUrl.startsWith("../")) {
    return { authedUrl: remoteUrl, appliedAuth: "none" };
  }
  if (remoteUrl.startsWith("file://")) {
    return { authedUrl: remoteUrl, appliedAuth: "none" };
  }
  // SSH shorthand: `git@host:owner/repo.git`. Pattern: `<user>@<host>:<path>`.
  // Doesn't parse as a URL — detect by the colon-after-host shape.
  if (/^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+:[^/]/.test(remoteUrl)) {
    return { authedUrl: remoteUrl, appliedAuth: "none" };
  }

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  // Only http/https get userinfo treatment. SSH URLs (`ssh://git@host/...`),
  // git://, etc., parse as URLs but we don't try to embed creds in them.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { authedUrl: remoteUrl, appliedAuth: "none" };
  }

  // If the URL already carries userinfo (operator pasted a URL with the
  // token baked in), trust it and don't override.
  if (parsed.username || parsed.password) {
    return { authedUrl: remoteUrl, appliedAuth: "none" };
  }

  if (auth.kind === "none") {
    return { authedUrl: remoteUrl, appliedAuth: "none" };
  }

  if (auth.kind === "pat") {
    const u = new URL(remoteUrl);
    u.username = "x-access-token";
    u.password = auth.token;
    return { authedUrl: u.toString(), appliedAuth: "per_call_pat" };
  }

  // credentialsFile path — read from disk.
  const creds = readCredentials();
  if (!creds || !creds.active_method) {
    return { authedUrl: remoteUrl, appliedAuth: "none" };
  }
  if (creds.active_method === "github_oauth" && creds.github_oauth) {
    // Embed the OAuth token if the URL is on github.com.
    if (parsed.host.toLowerCase() === "github.com") {
      const u = new URL(remoteUrl);
      u.username = "x-access-token";
      u.password = creds.github_oauth.access_token;
      return { authedUrl: u.toString(), appliedAuth: "stored_oauth" };
    }
    // GitHub OAuth token against a non-github host: useless. Fall through.
    return { authedUrl: remoteUrl, appliedAuth: "none" };
  }
  if (creds.active_method === "pat" && creds.pat) {
    // If the stored PAT URL host matches the request URL host, the stored
    // token is the right one. Embed it.
    let storedHost = "";
    try {
      storedHost = new URL(creds.pat.remote_url).host.toLowerCase();
    } catch {
      // ignore — fall through to no-auth
    }
    if (storedHost && storedHost === parsed.host.toLowerCase()) {
      const u = new URL(remoteUrl);
      u.username = "x-access-token";
      u.password = creds.pat.token;
      return { authedUrl: u.toString(), appliedAuth: "stored_pat" };
    }
    return { authedUrl: remoteUrl, appliedAuth: "none" };
  }
  return { authedUrl: remoteUrl, appliedAuth: "none" };
}

// ---------------------------------------------------------------------------
// Default git spawner — used in production. Tests inject a fake.
// ---------------------------------------------------------------------------

/**
 * Run a git command with a hard timeout + non-interactive env. Returns
 * exit code + stderr text + timeout flag.
 */
export const defaultGitSpawn: GitSpawn = async (argv, options) => {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      // Kill any system credential helper from intercepting — we want
      // the clone to use ONLY the URL-embedded credential, not whatever's
      // in keychain. Same shape as the ls-remote probe.
      GIT_ASKPASS: "/bin/echo",
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, options.timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const stderr = new TextDecoder()
    .decode(await new Response(proc.stderr).arrayBuffer())
    .trim();
  return { exitCode, stderr, timedOut };
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Clone a vault export from a git remote and import it into the target
 * vault. See module-level docstring for the full shape.
 *
 * Throws:
 *   - `ImportConflictError` — another import is already running for this
 *     vault. Handler returns 409.
 *   - `CloneFailedError` — git clone exited non-zero (auth wall, network,
 *     missing repo). Message has the token redacted. Handler returns 502.
 *   - `NotAVaultExportError` — the clone target lacks `.parachute/vault.yaml`.
 *     Handler returns 400.
 *   - Other errors (filesystem, store) propagate; handler returns 500.
 *
 * Always cleans up the temp dir.
 */
export async function cloneAndImport(opts: ImportOpts): Promise<ImportResult> {
  if (inFlight.has(opts.vaultName)) {
    throw new ImportConflictError(opts.vaultName);
  }
  inFlight.add(opts.vaultName);

  const spawn = opts.spawn ?? defaultGitSpawn;
  const importer = opts.importer ?? importPortableVault;
  const workDirRoot = opts.workDirRoot ?? tmpdir();
  const cloneTimeoutMs = opts.cloneTimeoutMs ?? 60_000;

  const authResult = authedCloneUrl(opts.remoteUrl, opts.auth);
  if (!authResult) {
    inFlight.delete(opts.vaultName);
    throw new CloneFailedError(
      `remote_url is not a valid URL: "${redactRemoteUrl(opts.remoteUrl)}"`,
    );
  }
  const { authedUrl } = authResult;

  const tempDir = mkdtempSync(join(workDirRoot, "parachute-import-"));
  try {
    const cloneResult = await spawn(
      ["git", "clone", "--depth", "1", authedUrl, tempDir],
      { timeoutMs: cloneTimeoutMs },
    );
    if (cloneResult.timedOut) {
      throw new CloneFailedError(
        `git clone timed out after ${Math.floor(cloneTimeoutMs / 1000)}s. ` +
          `Check the network connection or try a shallower remote. URL: ${redactRemoteUrl(opts.remoteUrl)}`,
      );
    }
    if (cloneResult.exitCode !== 0) {
      // Redact any leaked URLs in stderr — git error messages echo them.
      const redactedStderr = cloneResult.stderr.replace(
        /https?:\/\/[^@\s]+@/g,
        "https://***@",
      );
      throw new CloneFailedError(
        `git clone failed for ${redactRemoteUrl(opts.remoteUrl)}: ${redactedStderr}`,
      );
    }

    // Validate the clone looks like a vault export.
    if (!existsSync(join(tempDir, ".parachute", "vault.yaml"))) {
      throw new NotAVaultExportError();
    }

    // Delegate to the importer. `blowAway: true` for replace mode triggers
    // the wipe-then-import path (deletes notes via the public store API
    // so hooks fire); `false` for merge does upsert-by-id.
    const stats: ImportStats = await importer(opts.store, {
      inDir: tempDir,
      blowAway: opts.mode === "replace",
      assetsDir: opts.assetsDir,
    });

    return importResultFromStats(stats, opts.mode);
  } finally {
    // Always nuke the temp dir, even on error. The clone might have
    // partially populated it; force:true skips ENOENT.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Don't mask the original error with a cleanup error — just log.
      console.warn(
        `[mirror-import] temp dir cleanup failed (non-fatal): ${(err as Error).message ?? err}`,
      );
    }
    inFlight.delete(opts.vaultName);
  }
}

/**
 * Map the `importPortableVault` stats shape onto the import-API result
 * shape. Combines created+updated into a single "imported" count (the
 * operator's mental model is "I imported N notes" not "I created X and
 * updated Y"); surfaces every skipped link/attachment/sidecar as a
 * warning string.
 */
function importResultFromStats(
  stats: ImportStats,
  mode: "merge" | "replace",
): ImportResult {
  const warnings: string[] = [];
  for (const sl of stats.skipped_links) {
    warnings.push(
      `Skipped link ${sl.source_id} → ${sl.target_id} (${sl.relationship}): ${sl.reason}`,
    );
  }
  for (const sa of stats.skipped_attachments) {
    warnings.push(
      `Skipped attachment ${sa.attachment_id} on note ${sa.note_id}: ${sa.reason}`,
    );
  }
  for (const ss of stats.skipped_sidecars) {
    warnings.push(
      `Orphaned sidecar ${ss.sidecar_id} (path=${ss.expected_path ?? "—"}): ${ss.reason}`,
    );
  }
  const result: ImportResult = {
    notes_imported: stats.notes_created + stats.notes_updated,
    tags_imported: stats.schemas_restored,
    attachments_imported: stats.attachments_restored,
    warnings,
  };
  if (mode === "replace") {
    result.notes_deleted = stats.notes_wiped;
  }
  return result;
}

/** Test seam — surface in-flight state for assertions. */
export function _isImportInFlight(vaultName: string): boolean {
  return inFlight.has(vaultName);
}

/** Test seam — clear the in-flight set. */
export function _resetImportInFlightForTest(): void {
  inFlight.clear();
}
