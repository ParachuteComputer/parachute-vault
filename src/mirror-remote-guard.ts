/**
 * Cross-vault remote-clobber guard (vault#482).
 *
 * Per-vault mirror managers (vault#400) made every vault on a server
 * independently linkable to a GitHub (or any git) remote. Nothing stopped
 * TWO vaults on the same server from pointing their mirror at the SAME repo —
 * and two mirrors pushing the same branch of the same repo fight each other:
 * each `git push` (often `--force` for a mirror) overwrites the other vault's
 * snapshot. The loser's backup is silently clobbered. Realistic on a
 * family/shared box where two users share one GitHub account and both pick the
 * obvious repo name, and more likely once the multi-user invite flow makes
 * per-user vaults common.
 *
 * This module is the cheap same-server guard the issue calls for: when a vault
 * is about to bind a remote (PAT save, OAuth repo pick, or import-then-sync),
 * scan the OTHER vaults on this server for one that already claims the same
 * normalized remote and refuse — naming the conflicting vault + the repo —
 * unless the caller passes an explicit override.
 *
 * Cross-SERVER collisions can't be detected locally; the docs cover that half
 * ("one repo per vault").
 *
 * ## What counts as a vault's "claimed remote"
 *
 * A vault's mirror remote lives in two places depending on the credential
 * method:
 *   - **PAT** — the full authed `remote_url` in the per-vault credentials file.
 *   - **GitHub OAuth** — NOT in credentials (the credential carries no
 *     owner/repo). The actual remote is written onto the mirror dir's git
 *     `origin` by the select-repo flow.
 * So we look at BOTH: the stored PAT credential, and the mirror dir's `origin`
 * read straight from `.git/config`. Reading `.git/config` is a plain file read
 * (no network, no git spawn) so the scan stays fast + hermetic.
 *
 * ## Normalization
 *
 * `https://github.com/x/y`, `https://github.com/x/y.git`,
 * `git@github.com:x/y.git`, and `ssh://git@github.com/x/y` all name the same
 * repo. We normalize to `<host-lowercased>/<owner>/<repo>` (userinfo + auth
 * token stripped, `.git` + trailing slash removed) so equivalent URLs compare
 * equal regardless of protocol/case/suffix.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { listVaults } from "./config.ts";
import { readCredentials } from "./mirror-credentials.ts";
import { readMirrorConfigForVault, resolveMirrorPath } from "./mirror-config.ts";

/**
 * Canonical identity for a git remote, used for "same repo?" comparison.
 * Strips the auth token / userinfo, lower-cases the host, drops a trailing
 * `.git` and trailing slashes. Returns `<host>/<path>` (e.g.
 * `github.com/aaron/my-vault`).
 *
 * Recognizes the three remote shapes git accepts:
 *   - HTTPS/HTTP/ssh:// URLs (parse via `URL`).
 *   - SCP-style SSH shorthand `git@host:owner/repo(.git)`.
 *   - Anything else (local path, oddball) → a trimmed, suffix-stripped string
 *     compare, so two byte-identical local paths still match.
 *
 * Returns `null` for an empty/whitespace string (nothing to compare).
 */
export function normalizeRemoteIdentity(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return null;

  // The whole identity is LOWER-CASED before returning. The host is
  // case-insensitive by DNS, and GitHub (the primary mirror target) treats
  // owner/repo case-insensitively too — `github.com/Aaron/Vault` and
  // `github.com/aaron/vault` are the SAME repo, so a data-loss guard must treat
  // them as equal (else two vaults with different-case configs still clobber).
  // The theoretical false-positive on a path-case-SENSITIVE Git host is
  // acceptable for a clobber guard — the operator can override.

  // SCP-style SSH shorthand: `user@host:owner/repo.git`. Doesn't parse as a
  // URL (no scheme), so detect + rewrite to the canonical `host/path` shape
  // before the URL path. Pattern: `<user>@<host>:<path>` where the char after
  // the colon isn't a slash (a `//` after colon would be a real URL).
  const scp = trimmed.match(/^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/);
  if (scp && !scp[2]!.startsWith("/")) {
    const host = scp[1]!;
    const path = stripRepoSuffix(scp[2]!);
    return `${host}/${path}`.toLowerCase();
  }

  try {
    const url = new URL(trimmed);
    // Host already excludes userinfo. `URL` keeps a leading slash on pathname —
    // drop it so the join below doesn't double up.
    const host = url.host;
    const path = stripRepoSuffix(url.pathname.replace(/^\/+/, ""));
    const identity = path.length === 0 ? host : `${host}/${path}`;
    return identity.toLowerCase();
  } catch {
    // Non-URL, non-SCP (local path, etc.) — fall back to a trimmed,
    // suffix-stripped string compare so identical local paths match.
    return stripRepoSuffix(trimmed).toLowerCase();
  }
}

/** Strip a trailing `.git` and any trailing slashes from a remote path. */
function stripRepoSuffix(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
}

/** Two remotes name the same repo iff their normalized identities match. */
export function sameRemoteIdentity(a: string, b: string): boolean {
  const na = normalizeRemoteIdentity(a);
  const nb = normalizeRemoteIdentity(b);
  if (na === null || nb === null) return false;
  return na === nb;
}

// ---------------------------------------------------------------------------
// Per-vault claimed-remote resolution
// ---------------------------------------------------------------------------

/** The vault home root — `<configDir>/vault`. Re-reads PARACHUTE_HOME per call. */
function vaultHomeRoot(): string {
  const root = process.env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
  return join(root, "vault");
}

/**
 * The mirror dir for a vault, derived from its persisted mirror config the
 * same way `MirrorManager.start()` does (`resolveMirrorPath(vaultDataDir,
 * config)`). Returns null when the vault has no enabled mirror config or the
 * path can't be resolved (e.g. external location without external_path).
 *
 * Re-derives the vault data dir from PARACHUTE_HOME rather than importing
 * `config.vaultDir` — keeping the dependency surface narrow + matching the
 * path resolution `mirror-credentials.ts` uses.
 */
function vaultMirrorDir(vaultName: string): string | null {
  const config = readMirrorConfigForVault(vaultName);
  if (!config) return null;
  const vaultDataDir = join(vaultHomeRoot(), "data", vaultName);
  return resolveMirrorPath(vaultDataDir, config);
}

/**
 * Read a vault's mirror dir `origin` URL straight from `.git/config` — no git
 * spawn, no network. Returns null when there's no mirror dir, no `.git/config`,
 * or no `[remote "origin"]` url line.
 *
 * `.git/config` is INI-ish; the origin url lives under a `[remote "origin"]`
 * section header as `url = <value>`. We do a minimal section-aware scan rather
 * than pull in a git-config parser — the file shape is stable + simple.
 */
function readOriginFromGitConfig(mirrorDir: string): string | null {
  const gitConfigPath = join(mirrorDir, ".git", "config");
  if (!existsSync(gitConfigPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(gitConfigPath, "utf8");
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const line of raw.split("\n")) {
    const section = line.match(/^\s*\[(.+?)\]\s*$/);
    if (section) {
      // Section headers: `[remote "origin"]` or `[core]` etc. Normalize the
      // inner text + match the remote-origin shape (quoting can vary).
      const header = section[1]!.trim().toLowerCase().replace(/\s+/g, " ");
      inOrigin = header === 'remote "origin"';
      continue;
    }
    if (!inOrigin) continue;
    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (url) return url[1]!;
  }
  return null;
}

/**
 * The remote a vault currently claims, normalized, or null when it claims
 * none. Looks at both credential-backed (PAT) and mirror-dir (`origin`)
 * sources, so it covers OAuth-selected repos (which live only on `origin`)
 * as well as PAT remotes.
 *
 * Returns the FIRST resolvable normalized remote it finds. `origin` is
 * authoritative when set (it's what actually gets pushed); the stored PAT
 * `remote_url` is the fallback for a vault whose mirror dir hasn't been
 * bootstrapped yet.
 */
export function claimedRemoteOf(vaultName: string): string | null {
  // 1. The live `origin` on the mirror dir — authoritative, covers OAuth.
  const mirrorDir = vaultMirrorDir(vaultName);
  if (mirrorDir) {
    const origin = readOriginFromGitConfig(mirrorDir);
    if (origin) {
      const norm = normalizeRemoteIdentity(origin);
      if (norm) return norm;
    }
  }
  // 2. The stored PAT remote_url — fallback for a not-yet-bootstrapped mirror.
  const creds = readCredentials(vaultName);
  if (creds?.active_method === "pat" && creds.pat?.remote_url) {
    const norm = normalizeRemoteIdentity(creds.pat.remote_url);
    if (norm) return norm;
  }
  return null;
}

/** A detected cross-vault remote collision. */
export interface RemoteConflict {
  /** The other vault on this server that already targets the same repo. */
  conflictingVault: string;
  /** The normalized repo identity both vaults point at (`host/owner/repo`). */
  remoteIdentity: string;
}

/**
 * Scan every OTHER vault on this server for one that already claims the same
 * remote as `candidateRemote`. Returns the first conflict found, or null when
 * the repo is unclaimed.
 *
 * The current vault is excluded — re-pointing a vault at its OWN existing
 * remote (token rotation, re-running select-repo with the same repo, re-import)
 * is legitimate + idempotent and must never trip the guard.
 *
 * Fail-open by design: any per-vault read error is swallowed (skip that vault)
 * rather than blocking a legitimate bind on an unrelated vault's broken state.
 * The guard's job is to catch the obvious double-target, not to be a hard
 * gate that a corrupt sibling vault can wedge.
 */
export function findConflictingVault(
  currentVaultName: string,
  candidateRemote: string,
): RemoteConflict | null {
  const target = normalizeRemoteIdentity(candidateRemote);
  if (target === null) return null;

  let vaults: string[];
  try {
    vaults = listVaults();
  } catch {
    return null;
  }

  for (const other of vaults) {
    if (other === currentVaultName) continue;
    let claimed: string | null;
    try {
      claimed = claimedRemoteOf(other);
    } catch {
      continue;
    }
    if (claimed !== null && claimed === target) {
      return { conflictingVault: other, remoteIdentity: target };
    }
  }
  return null;
}

/**
 * Build the operator-facing error message for a refused bind. Names the
 * conflicting vault + the repo, and tells the operator how to proceed.
 * Centralized so the three call sites (PAT, select-repo, import-sync) surface
 * identical wording.
 */
export function remoteConflictMessage(conflict: RemoteConflict): string {
  return (
    `Vault "${conflict.conflictingVault}" on this server already backs up to ${conflict.remoteIdentity}. ` +
    `Two vaults pushing to the same repo overwrite each other's backups (silent data loss). ` +
    `Pick a different repo for this vault, or disconnect the other vault's backup first. ` +
    `If you're sure (e.g. you just moved the repo between vaults), pass override=true to proceed anyway.`
  );
}
