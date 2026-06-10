/**
 * Mirror credentials store — UI-configurable git push credentials.
 *
 * After vault#382 (event-driven mirror), `auto_push: true` works only if the
 * operator's shell has the right git credential plumbing wired (SSH key,
 * GH_TOKEN, system credential helper). For self-hosted users that pattern is
 * a non-starter — most have never opened a terminal. This module owns the
 * UI-configurable alternative.
 *
 * Two surfaces:
 *   - **GitHub OAuth Device Flow** — the recommended path. Operator opens a
 *     modal, vault calls GitHub's device-code endpoint, the operator types
 *     a code at github.com/login/device, vault polls until granted, the
 *     resulting `gho_*` token is stored and embedded in the mirror's git
 *     remote URL so bare `git push` works. Same UX as `gh auth login`.
 *     **Why Device Flow, not Web Flow:** Web Flow needs a pre-registered
 *     callback URL per OAuth app; self-hosted vaults have unpredictable
 *     origins (localhost:1940, random Tailscale FQDN, custom domain). Device
 *     Flow needs only a public `client_id` and works against any vault
 *     origin without infrastructure.
 *   - **Personal Access Token (PAT) fallback** — provider-agnostic. Operator
 *     pastes a token + a remote URL with HTTPS auth; vault stores both and
 *     embeds them in the mirror's remote URL. Works against GitHub, GitLab,
 *     Codeberg, Gitea, anything that accepts an HTTPS token in the URL.
 *
 * **Storage:** `<configDir>/vault/data/<vaultName>/.mirror-credentials.yaml`,
 * perms `0o600`, **not encrypted at rest**. Rationale: encryption-at-rest
 * with the key on the same disk doesn't add real security; OS perms ARE the
 * protection. Same trust model as `~/.git-credentials` (which most operators
 * already use). The file is documented as sensitive; redaction in logs is
 * enforced by `sanitizeCredentials` + a discipline of "never log the raw
 * token."
 *
 * **Per-vault (vault#399).** Credentials — both the PAT and the embedded
 * `remote_url` — live under each vault's own data dir, alongside its SQLite
 * DB + vault.yaml. This is the existing per-vault-state pattern. Before
 * vault#399 they lived in a single SERVER-WIDE file
 * (`<configDir>/vault/.mirror-credentials.yaml`); that leaked the first
 * vault's remote + PAT onto every other vault that configured git sync —
 * pointing vault B at vault A's GitHub repo. The legacy server-wide file is
 * migrated to its owning vault on first per-vault read (see
 * `migrateLegacyServerWideCredentials`).
 *
 * **One credential set per vault.** Multi-credential ("I want repo A pushed
 * with token X, repo B with token Y") within a single vault isn't supported —
 * vault#382 ships one mirror per vault; one credential set per vault matches.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Which credential surface is currently active. Null when none configured.
 * - `github_oauth` — populated `github_oauth` block.
 * - `pat` — populated `pat` block (Personal Access Token + remote URL).
 */
export type ActiveMethod = "github_oauth" | "pat" | null;

/**
 * GitHub OAuth Device Flow result. Stored verbatim after a successful poll
 * returns `granted`. The `access_token` is what gets embedded in the git
 * remote URL at push time (via `x-access-token:<TOKEN>@github.com/...`).
 */
export interface GitHubOAuthCredential {
  /** The `gho_*` token returned by GitHub's `/login/oauth/access_token`. */
  access_token: string;
  /** Scope string GitHub granted (typically "repo"). */
  scope: string;
  /** ISO timestamp captured at the moment we saved the token. */
  authorized_at: string;
  /** GitHub login (`@octocat`). */
  user_login: string;
  /** GitHub numeric user id — stable across login renames. */
  user_id: number;
}

/**
 * Personal Access Token fallback. The operator pastes both the token AND
 * the remote URL — vault doesn't try to guess one from the other (GitHub
 * uses `https://x-access-token:<token>@github.com/...`, GitLab uses
 * `https://oauth2:<token>@gitlab.com/...`, etc., and there's no generic
 * rule). The stored URL is what gets set as the mirror's remote.
 */
export interface PATCredential {
  /** Bearer token (ghp_*, glpat-*, etc.). */
  token: string;
  /**
   * Full HTTPS remote URL with auth embedded, e.g.
   * `https://x-access-token:ghp_abc@github.com/owner/repo.git`. The operator
   * supplies this; we don't synthesize.
   */
  remote_url: string;
  /** Operator-visible label, e.g. "GitHub PAT for backup". */
  label: string;
}

/**
 * The on-disk + on-the-wire shape. One file per VAULT (vault#399) — keyed by
 * the vault's data dir, not the server. Each vault has its own PAT + its own
 * `remote_url`, so configuring git sync for vault B never reuses vault A's
 * remote.
 */
export interface MirrorCredentials {
  /**
   * Which credential method is active. Read paths check this; if null the
   * mirror runs with no embedded credentials (bare `git push` inherits
   * the shell — back-compat with pre-PR operators).
   */
  active_method: ActiveMethod;
  github_oauth: GitHubOAuthCredential | null;
  pat: PATCredential | null;
}

/**
 * Redacted view of credentials, safe for logs / API responses. Masks tokens
 * to first-4 + last-4 chars; preserves user metadata so the operator can
 * verify "yes, this is the right account/repo" without re-authenticating.
 */
export interface MirrorCredentialsPublic {
  active_method: ActiveMethod;
  github_oauth: {
    user_login: string;
    user_id: number;
    scope: string;
    authorized_at: string;
    token_preview: string;
  } | null;
  pat: {
    label: string;
    remote_url: string;
    token_preview: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** The vault home root — `<configDir>/vault`. Re-reads PARACHUTE_HOME per call. */
function vaultHomeRoot(): string {
  const root = process.env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
  return join(root, "vault");
}

/**
 * Path to a vault's per-vault credentials file (vault#399).
 *
 * `<configDir>/vault/data/<vaultName>/.mirror-credentials.yaml` — under the
 * vault's own data dir, alongside its SQLite DB (`vault.db`) + config
 * (`vault.yaml`). This is the canonical per-vault-state location; every
 * vault carries its own PAT + remote_url so git sync for one vault never
 * reuses another vault's remote.
 *
 * Path resolution mirrors `config.ts:vaultDir()` rather than importing it —
 * mirror-config.ts imports this module and config.ts imports mirror-config.ts,
 * so importing config.ts here would close an import cycle. We re-derive the
 * path from `PARACHUTE_HOME` (the canonical override the rest of vault honors)
 * instead, which keeps this module dependency-light.
 */
export function mirrorCredentialsPath(vaultName: string): string {
  return join(vaultHomeRoot(), "data", vaultName, ".mirror-credentials.yaml");
}

/**
 * Path to the LEGACY server-wide credentials file
 * (`<configDir>/vault/.mirror-credentials.yaml`) used before vault#399.
 * Retained only so the migration can find + attribute + rename it.
 */
export function legacyServerWideCredentialsPath(): string {
  return join(vaultHomeRoot(), ".mirror-credentials.yaml");
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Empty credentials — what readCredentials returns when the file is absent. */
export function emptyCredentials(): MirrorCredentials {
  return {
    active_method: null,
    github_oauth: null,
    pat: null,
  };
}

// ---------------------------------------------------------------------------
// YAML — hand-rolled to match the pattern in mirror-config.ts. No new dep.
// ---------------------------------------------------------------------------

/**
 * Serialize credentials as YAML. Keeps the file hand-editable for operators
 * who want to rotate a token by `vim`-ing the file.
 *
 * Format:
 *
 *   active_method: github_oauth
 *   github_oauth:
 *     access_token: ghu_...
 *     scope: ""
 *     authorized_at: 2026-05-28T03:14:15.000Z
 *     user_login: aaron
 *     user_id: 12345
 *   pat:
 *     token: ghp_...
 *     remote_url: https://github.com/aaron/my-vault.git
 *     label: "GitHub PAT"
 *
 * `scope` is always `""` for tokens from the shared Parachute GitHub App
 * (GitHub Apps use fine-grained permissions, not scopes). Credentials from
 * the classic-OAuth era may still carry `scope: repo` — both parse fine.
 */
export function serializeCredentials(creds: MirrorCredentials): string {
  const lines: string[] = [];
  lines.push(`active_method: ${creds.active_method === null ? "null" : creds.active_method}`);
  if (creds.github_oauth) {
    lines.push("github_oauth:");
    lines.push(`  access_token: ${quoteIfNeeded(creds.github_oauth.access_token)}`);
    lines.push(`  scope: ${quoteIfNeeded(creds.github_oauth.scope)}`);
    lines.push(`  authorized_at: ${quoteIfNeeded(creds.github_oauth.authorized_at)}`);
    lines.push(`  user_login: ${quoteIfNeeded(creds.github_oauth.user_login)}`);
    lines.push(`  user_id: ${creds.github_oauth.user_id}`);
  } else {
    lines.push("github_oauth: null");
  }
  if (creds.pat) {
    lines.push("pat:");
    lines.push(`  token: ${quoteIfNeeded(creds.pat.token)}`);
    lines.push(`  remote_url: ${quoteIfNeeded(creds.pat.remote_url)}`);
    lines.push(`  label: ${quoteIfNeeded(creds.pat.label)}`);
  } else {
    lines.push("pat: null");
  }
  return lines.join("\n") + "\n";
}

/**
 * Quote a YAML scalar when it contains characters that confuse parsers.
 * `gho_*` / `ghp_*` tokens never carry newlines or special chars, but the
 * operator-supplied `label` field has no such guarantee — a label with a
 * literal `\n` would break the parser's per-line section logic. Escape
 * newlines + carriage returns + backslash + quote inside the quoted form.
 * Reviewer-flagged on vault#384.
 */
function quoteIfNeeded(value: string): string {
  if (/[:#"'\\\n\r]/.test(value) || value.trim() !== value || value.length === 0) {
    return `"${value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")}"`;
  }
  return value;
}

/** Parse a YAML scalar that may be quoted; otherwise return the trimmed value. */
function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/**
 * Parse the credentials YAML file. Lenient — unknown fields ignored, missing
 * blocks default to null. Returns `emptyCredentials()` if the file is empty
 * or contains nothing recognized.
 */
export function parseCredentials(yaml: string): MirrorCredentials {
  const result = emptyCredentials();
  const lines = yaml.split("\n");
  let section: "github_oauth" | "pat" | null = null;
  // Buffer per-section scalars so we can validate as a block before commit.
  let oauth: Partial<GitHubOAuthCredential> = {};
  let pat: Partial<PATCredential> = {};

  const commitSection = () => {
    if (section === "github_oauth") {
      if (
        oauth.access_token &&
        oauth.scope !== undefined &&
        oauth.authorized_at &&
        oauth.user_login &&
        typeof oauth.user_id === "number"
      ) {
        result.github_oauth = oauth as GitHubOAuthCredential;
      }
      oauth = {};
    } else if (section === "pat") {
      if (pat.token && pat.remote_url && pat.label !== undefined) {
        result.pat = pat as PATCredential;
      }
      pat = {};
    }
  };

  for (const line of lines) {
    if (line.match(/^\s*$/)) continue;

    // Top-level scalars / section headers.
    if (line.match(/^\S/)) {
      // Close the previous section before starting a new one.
      commitSection();
      section = null;
      const activeMatch = line.match(/^active_method:\s*(.*)$/);
      if (activeMatch) {
        const v = parseScalar(activeMatch[1]!);
        if (v === "github_oauth" || v === "pat") result.active_method = v;
        else result.active_method = null;
        continue;
      }
      if (line.match(/^github_oauth:\s*null\s*$/)) {
        result.github_oauth = null;
        continue;
      }
      if (line.match(/^pat:\s*null\s*$/)) {
        result.pat = null;
        continue;
      }
      if (line.match(/^github_oauth:\s*$/)) {
        section = "github_oauth";
        continue;
      }
      if (line.match(/^pat:\s*$/)) {
        section = "pat";
        continue;
      }
      continue;
    }

    // Indented section field.
    const fieldMatch = line.match(/^\s+(\w+):\s*(.*)$/);
    if (!fieldMatch) continue;
    const [, key, rawVal] = fieldMatch;
    if (section === "github_oauth") {
      if (key === "access_token") oauth.access_token = parseScalar(rawVal!);
      else if (key === "scope") oauth.scope = parseScalar(rawVal!);
      else if (key === "authorized_at") oauth.authorized_at = parseScalar(rawVal!);
      else if (key === "user_login") oauth.user_login = parseScalar(rawVal!);
      else if (key === "user_id") {
        const n = Number(parseScalar(rawVal!));
        if (Number.isFinite(n)) oauth.user_id = n;
      }
    } else if (section === "pat") {
      if (key === "token") pat.token = parseScalar(rawVal!);
      else if (key === "remote_url") pat.remote_url = parseScalar(rawVal!);
      else if (key === "label") pat.label = parseScalar(rawVal!);
    }
  }

  commitSection();
  return result;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Read a vault's credentials from disk. Returns `null` when the file doesn't
 * exist (operator hasn't connected anything yet); throws when the file is
 * present but unreadable (a permission error is a loud configuration problem).
 *
 * vault#399 migration: if the per-vault file is absent but the legacy
 * server-wide file exists, `migrateLegacyServerWideCredentials` may have
 * promoted it to THIS vault (when it's the migration target). The migration
 * runs at boot (server.ts) and is idempotent; this read just picks up
 * whatever landed on disk.
 */
export function readCredentials(vaultName: string): MirrorCredentials | null {
  const path = mirrorCredentialsPath(vaultName);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return parseCredentials(raw);
}

/**
 * Persist credentials atomically:
 *   1. Write to `<path>.tmp` with perms 0600 (write + read by owner only).
 *   2. Rename onto the final path (atomic on POSIX; mostly atomic on Windows).
 *   3. Re-apply 0600 perms in case the rename clobbered them (defense in
 *      depth — `mv` shouldn't alter perms, but the test surface is wide).
 *
 * Fails loudly: any errno propagates. Callers (the route handler) catch +
 * surface a 500 with the underlying message — quietly losing credentials
 * would be worse than crashing the request.
 */
export function writeCredentials(vaultName: string, creds: MirrorCredentials): void {
  const path = mirrorCredentialsPath(vaultName);
  const dir = dirname(path);
  // Vault home may not exist yet (tests, fresh installs); create it.
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  const serialized = serializeCredentials(creds);
  writeFileSync(tmp, serialized, { mode: 0o600 });
  // Belt-and-braces: writeFileSync's `mode` is only honored on file
  // CREATION. If the temp file already existed (interrupted prior write),
  // the existing perms persist. Re-chmod to be sure.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  // Some filesystems preserve the old file's perms across rename; force
  // 0600 on the final path. No-op on the common case.
  chmodSync(path, 0o600);

  // Defensive verification — if the perms are wrong on disk, throw so the
  // caller surfaces the misconfiguration to the operator. A world-readable
  // credentials file would silently leak the OAuth token.
  const stat = statSync(path);
  const perms = stat.mode & 0o777;
  if (perms !== 0o600) {
    throw new Error(
      `Mirror credentials file at ${path} has perms ${perms.toString(8)}, expected 0600. Refusing to leave a world-readable token on disk.`,
    );
  }
}

/**
 * Delete the credentials file. Idempotent — missing file is a no-op (the
 * Disconnect UX should succeed even if the file was already removed).
 */
export function deleteCredentials(vaultName: string): void {
  const path = mirrorCredentialsPath(vaultName);
  if (existsSync(path)) unlinkSync(path);
}

// ---------------------------------------------------------------------------
// Migration — legacy server-wide → per-vault (vault#399)
// ---------------------------------------------------------------------------

/**
 * One-time migration of the legacy server-wide credentials file to the
 * per-vault layout (vault#399).
 *
 * The bug: pre-vault#399, credentials (PAT + embedded `remote_url`) lived in a
 * single `<configDir>/vault/.mirror-credentials.yaml` shared across ALL
 * vaults. Configuring git sync for a second vault reused the first vault's
 * remote, pointing it at the wrong GitHub repo.
 *
 * Attribution policy (SAFEST per the design): attribute the legacy creds to
 * the FIRST vault — the earliest-created one, which is what
 * `resolveMirrorVaultName()` already bound the single server-wide mirror to.
 * That's the vault whose remote/PAT the legacy file actually corresponds to.
 * We do NOT copy the same remote/PAT onto every vault — that would recreate
 * the leak.
 *
 * Safety:
 *   - No-op when no legacy file exists (fresh installs, already-migrated).
 *   - No-op when the target vault already has a per-vault file (don't clobber
 *     creds the operator set post-migration).
 *   - Leaves the legacy file in place renamed `.bak` (never silently deleted)
 *     so nothing is lost if attribution was wrong — the operator can recover.
 *   - Logs the attribution decision clearly.
 *
 * @param targetVaultName the vault to attribute the legacy creds to (caller
 *   passes the result of `resolveMirrorVaultName()`, i.e. default-or-first).
 * @returns a struct describing what happened, for logging + tests.
 */
export function migrateLegacyServerWideCredentials(
  targetVaultName: string | null,
):
  | { migrated: false; reason: "no_legacy_file" | "no_target_vault" | "target_already_has_creds" }
  | { migrated: true; targetVaultName: string; backupPath: string } {
  const legacyPath = legacyServerWideCredentialsPath();
  if (!existsSync(legacyPath)) {
    return { migrated: false, reason: "no_legacy_file" };
  }
  if (!targetVaultName) {
    // Legacy file present but no vault to attribute it to. Leave it in
    // place — a future boot (once a vault exists) migrates it.
    return { migrated: false, reason: "no_target_vault" };
  }
  const targetPath = mirrorCredentialsPath(targetVaultName);
  if (existsSync(targetPath)) {
    // The target vault already has per-vault creds (operator configured
    // them post-migration, or a prior migration ran). Don't clobber.
    // Still rename the legacy file so we don't re-evaluate it forever.
    const backupPath = `${legacyPath}.bak`;
    try {
      if (!existsSync(backupPath)) renameSync(legacyPath, backupPath);
    } catch {
      // Non-fatal — worst case we re-check next boot and short-circuit here.
    }
    return { migrated: false, reason: "target_already_has_creds" };
  }

  // Read the legacy creds + write them to the target vault's per-vault file.
  const raw = readFileSync(legacyPath, "utf8");
  const creds = parseCredentials(raw);
  writeCredentials(targetVaultName, creds);

  // Rename the legacy file to .bak rather than deleting — never silently
  // lose an operator's only copy of a token/remote.
  const backupPath = `${legacyPath}.bak`;
  try {
    renameSync(legacyPath, backupPath);
  } catch {
    // If the rename fails (e.g. .bak already exists from a partial prior
    // run), fall back to unlinking the original — the creds are now safely
    // in the per-vault file.
    try {
      unlinkSync(legacyPath);
    } catch {
      // Leave it; the target_already_has_creds branch short-circuits next boot.
    }
  }

  console.log(
    `[mirror] migrated legacy server-wide mirror credentials → vault "${targetVaultName}" (per-vault, vault#399). ` +
      `Other vaults start with no mirror credentials (configure each separately). ` +
      `Legacy file preserved at ${backupPath}.`,
  );
  return { migrated: true, targetVaultName, backupPath };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Mask a token to first-4 + last-4 chars with a fixed-width middle. Designed
 * to be safe to log + display in the UI's status section (operator can verify
 * "yes, this is the token I authorized" without revealing the secret).
 *
 * Short tokens (< 12 chars) get fully masked rather than partially revealed
 * — anything that short isn't a real production token, but defense in depth
 * costs nothing.
 */
export function previewToken(token: string): string {
  if (token.length < 12) return "***";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * Produce a redacted view of credentials. Use this anywhere credentials
 * leave the trust boundary — logs, HTTP responses, UI state. The full
 * shape lives only in memory + on disk.
 */
export function sanitizeCredentials(
  creds: MirrorCredentials | null,
): MirrorCredentialsPublic {
  if (!creds) {
    return { active_method: null, github_oauth: null, pat: null };
  }
  return {
    active_method: creds.active_method,
    github_oauth: creds.github_oauth
      ? {
          user_login: creds.github_oauth.user_login,
          user_id: creds.github_oauth.user_id,
          scope: creds.github_oauth.scope,
          authorized_at: creds.github_oauth.authorized_at,
          token_preview: previewToken(creds.github_oauth.access_token),
        }
      : null,
    pat: creds.pat
      ? {
          label: creds.pat.label,
          remote_url: redactRemoteUrl(creds.pat.remote_url),
          token_preview: previewToken(creds.pat.token),
        }
      : null,
  };
}

/**
 * Mask the userinfo portion of a remote URL — the operator might have
 * pasted `https://user:token@host/...` and we don't want the raw token
 * leaking via the redacted view. Returns the URL with `user:***@` swapped
 * in for the entire userinfo, leaving the host + path intact.
 */
export function redactRemoteUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
      return u.toString();
    }
    return url;
  } catch {
    // Non-URL string — return a generic placeholder.
    return "***";
  }
}

// ---------------------------------------------------------------------------
// Git remote URL helpers
// ---------------------------------------------------------------------------

/**
 * Build the HTTPS remote URL with an embedded GitHub OAuth token for `owner/repo`.
 *
 *   https://x-access-token:<TOKEN>@github.com/<owner>/<repo>.git
 *
 * The `x-access-token` username convention is GitHub-specific. PATs work
 * through the same shape (GitHub treats `gho_*` and `ghp_*` identically at
 * the credential-helper layer); GitLab / Codeberg use different conventions,
 * so the PAT path stores the full URL operator-supplied rather than
 * synthesizing.
 */
export function githubAuthedRemoteUrl(
  token: string,
  owner: string,
  repo: string,
): string {
  // GitHub repo names allow `.`, `-`, `_`. URL-escape just in case
  // someone has a weird name; the path-component encoder is too aggressive
  // here (it would escape `.`), so we trust GitHub's naming rules.
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

/**
 * Set the embedded-credential remote URL on a mirror repo's git config.
 *
 * Idempotent: calling on an already-configured remote replaces the URL
 * (which is what we want — token rotation should "just work" when the
 * stored credentials update). Adds the remote if it doesn't exist; updates
 * it if it does.
 *
 * **Logs are scrubbed.** We never log the URL itself (it carries the
 * token). We log a redacted form via `redactRemoteUrl` instead.
 */
export async function applyToGitRemote(
  repoDir: string,
  remoteUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  // Probe for an existing `origin`. `git remote get-url origin` returns
  // exit 0 if it exists, non-zero otherwise.
  const probe = Bun.spawn(["git", "remote", "get-url", "origin"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const probeCode = await probe.exited;
  const verb = probeCode === 0 ? "set-url" : "add";
  const cmd =
    verb === "set-url"
      ? ["git", "remote", "set-url", "origin", remoteUrl]
      : ["git", "remote", "add", "origin", remoteUrl];
  const proc = Bun.spawn(cmd, {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = new TextDecoder()
      .decode(await new Response(proc.stderr).arrayBuffer())
      .trim();
    return { ok: false, error: stderr };
  }
  return { ok: true };
}

/**
 * Remove the embedded-credential remote (when credentials are cleared).
 * Idempotent: missing remote is fine — the operator might never have had
 * one set up.
 */
export async function unsetGitRemote(
  repoDir: string,
): Promise<{ ok: boolean; error?: string }> {
  const probe = Bun.spawn(["git", "remote", "get-url", "origin"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const probeCode = await probe.exited;
  if (probeCode !== 0) return { ok: true }; // nothing to unset
  const proc = Bun.spawn(["git", "remote", "remove", "origin"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = new TextDecoder()
      .decode(await new Response(proc.stderr).arrayBuffer())
      .trim();
    return { ok: false, error: stderr };
  }
  return { ok: true };
}
