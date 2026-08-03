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

// ---------------------------------------------------------------------------
// Unrelated-history guard (vault#823).
//
// Field report: a vault imported from a git repo, then armed Sync against that
// same repo, and every push for five days was refused as non-fast-forward.
// `mirror-import.ts` clones to a TEMP dir, imports notes into the store, and
// deletes the temp dir — it never touches the mirror dir. The mirror is then
// stood up fresh by `bootstrapInternalMirror` (`git init` + seed commit), so
// its root commit has no relationship to anything on the remote. Two histories,
// no common ancestor, and no push can ever land. It is deterministic, not a
// race: ANY import onto a non-empty remote produces a mirror that can never
// push.
//
// The cross-vault guard above answers "is someone else using this repo?". This
// one answers a different question about the SAME bind: "can my history reach
// theirs at all?" — and it is the one the import path needs, because on that
// path the remote is not a stranger's repo, it is the repo we just cloned FROM.
//
// Detection, without a fetch: ask the remote for its head shas (`ls-remote`,
// already run at the PAT bind point), then ask the mirror whether it HOLDS any
// of those objects (`git cat-file -e`). A mirror that was cloned from — or has
// ever pushed to — the remote holds them. A freshly-`git init`ed one does not.
// ---------------------------------------------------------------------------

/** A detected unrelated-history bind — the mirror can never push to this remote. */
export interface UnrelatedHistory {
  /** Normalized repo identity, or the raw URL when it can't be parsed. */
  remoteIdentity: string;
  /** True when the mirror dir doesn't exist / holds no commits yet. */
  mirrorIsFresh: boolean;
}

/**
 * Does `mirrorPath` hold at least one of `remoteHeads`?
 *
 * `git cat-file -e <sha>^{commit}` is a local object-database lookup — no
 * network, no fetch, no working-tree touch. Fails closed to `false` (we do not
 * hold it) on any spawn error, which routes into "unrelated" and therefore into
 * a warning rather than a silent arm. That is the safe direction: the cost of a
 * false warning is one confused operator; the cost of a false all-clear is five
 * days with no backup.
 */
async function mirrorHoldsAnyRemoteHead(
  mirrorPath: string,
  remoteHeads: string[],
  spawnImpl: typeof Bun.spawn = Bun.spawn,
): Promise<boolean> {
  for (const sha of remoteHeads) {
    if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
    try {
      const proc = spawnImpl(["git", "cat-file", "-e", `${sha}^{commit}`], {
        cwd: mirrorPath,
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await proc.exited) === 0) return true;
    } catch {
      // git missing / path unreadable — treat as "not held" and keep going.
    }
  }
  return false;
}

/**
 * Detect a bind whose pushes can never land: a non-empty remote whose history
 * the local mirror cannot reach.
 *
 * Returns null (bind is fine) when:
 *   - the remote is EMPTY — nothing to conflict with; the first push defines
 *     the history. This is the ordinary "fresh repo" setup and must not warn.
 *   - the mirror already holds one of the remote's heads — it was cloned from
 *     there, or has pushed there before. Re-binding after a token rotation
 *     lands here and must not warn.
 *
 * Returns a struct (bind will never push) when the remote has refs and the
 * mirror holds none of them — including the case where the mirror does not
 * exist yet, because what gets created will be a fresh `git init`.
 */
export async function findUnrelatedRemoteHistory(opts: {
  mirrorPath: string | null;
  remoteUrl: string;
  /** Head shas from `git ls-remote` — empty array means an empty remote. */
  remoteHeads: string[];
  /** Test seam. */
  spawnImpl?: typeof Bun.spawn;
}): Promise<UnrelatedHistory | null> {
  const { mirrorPath, remoteUrl, remoteHeads, spawnImpl } = opts;
  // An empty remote can't conflict — the first push establishes the history.
  if (remoteHeads.length === 0) return null;

  const remoteIdentity = normalizeRemoteIdentity(remoteUrl) ?? redactUrlForMessage(remoteUrl);

  // No mirror on disk yet → whatever gets bootstrapped will be a fresh root.
  if (mirrorPath === null || !existsSync(join(mirrorPath, ".git"))) {
    return { remoteIdentity, mirrorIsFresh: true };
  }
  if (await mirrorHoldsAnyRemoteHead(mirrorPath, remoteHeads, spawnImpl)) return null;
  return { remoteIdentity, mirrorIsFresh: false };
}

/**
 * Strip any userinfo from a remote URL so an unparseable one can still be
 * named in an operator-facing message without leaking a token.
 */
function redactUrlForMessage(remote: string): string {
  return remote.replace(/\/\/[^@/]*@/, "//");
}

/**
 * Operator-facing message for a refused arm. Says what is wrong, why it can
 * never self-correct, and what the three real options are — deliberately
 * concrete, because "non-fast-forward" is exactly the error an operator cannot
 * act on without knowing the histories are unrelated.
 */
export function unrelatedHistoryMessage(found: UnrelatedHistory): string {
  return (
    `${found.remoteIdentity} already has commits that this vault's backup history doesn't share, ` +
    `so every push would be rejected (non-fast-forward) and it would never recover on its own. ` +
    `Importing brings your notes across but not the old backup history, which is why they don't line up. ` +
    `Either back up to a new empty repo, or replace the repo's contents with this vault's history on purpose. ` +
    `If you know they should be joined, pass override=true to arm Sync anyway.`
  );
}
