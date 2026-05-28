/**
 * HTTP client for the vault admin SPA.
 *
 * Two surfaces:
 *   - `GET /vaults/list` — public discovery (no auth). Used to populate the
 *     SPA's vault picker on first load before any token is in hand.
 *   - `GET /vault/<name>/` — per-vault metadata (auth). Returns name,
 *     description, created_at, and stats in a single response. Requires a
 *     hub-issued JWT scoped `vault:<name>:read` (or higher).
 *
 * `vault:<name>:admin` is the scope the SPA's eventual mutate-paths (token
 * mint, config edit) will require — Phase A only reads, but the same JWT
 * carries enough to do so under the inherit rule (admin ⊇ write ⊇ read).
 */
import { getToken } from "./auth.ts";

/**
 * Counts surface in `VaultDetail.tsx`'s Stats section. Field names mirror
 * the server's `core/src/types.ts:VaultStats` shape so the JSON parses
 * straight in — historically the SPA shadowed the server with shorter
 * names (`notes`, `tags`, `attachments`, `links`) which silently rendered
 * as empty strings since none of those keys actually exist on the wire.
 *
 * The wire payload carries more fields than this (timeline, top tags,
 * earliest/latest note); we only declare the ones the SPA reads, since
 * adding the rest just buys drift surface.
 */
export interface VaultStats {
  totalNotes: number;
  tagCount: number;
  attachmentCount: number;
  linkCount: number;
}

export interface VaultDetailResult {
  name: string;
  description?: string | null;
  createdAt?: string;
  stats: VaultStats;
}

/** Status code carried alongside the message so callers can branch numerically. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Public vault-name list. Returns the names of every vault hosted by this
 * server. No auth — operators who want to hide vault existence set
 * `discovery: disabled` in `~/.parachute/vault/config.yaml` (the endpoint
 * 404s in that case; the SPA surfaces an empty list).
 */
export async function listVaultNames(): Promise<string[]> {
  const res = await fetch("/vaults/list", { headers: { accept: "application/json" } });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new HttpError(res.status, `vaults/list fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { vaults?: string[] };
  return body.vaults ?? [];
}

/**
 * Per-vault detail. Hits `/vault/<name>/` — the single-shot landing-page
 * endpoint that returns name, description, createdAt, and stats. Requires
 * a hub-issued JWT in the cached auth state; throws `HttpError(401)` if
 * none is present so the caller can render an "auth required" empty state
 * instead of a generic error.
 */
export async function getVaultDetail(name: string): Promise<VaultDetailResult> {
  const token = getToken();
  if (!token) {
    throw new HttpError(401, "no admin token — open this page from the hub directory");
  }
  const res = await fetch(`/vault/${encodeURIComponent(name)}/`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as VaultDetailResult;
}

// ---------------------------------------------------------------------------
// Mirror — `/vault/<name>/.parachute/mirror[/run-now]`
//
// The backend's persisted config + runtime status shape, mirrored as
// TypeScript so the SPA reads/writes the same JSON the server emits.
// Field semantics live in `src/mirror-config.ts:MirrorConfig` and
// `src/mirror-manager.ts:MirrorStatus`; the comments here just sketch
// what each field controls so a reader of the SPA doesn't have to
// jump out to the backend module.
// ---------------------------------------------------------------------------

export type MirrorLocation = "internal" | "external";

/**
 * Event-driven mode subscribes to in-process hooks (note / tag /
 * attachment mutations) and debounces them into a single export pass;
 * a background safety-net poll catches anything missed. Manual mode
 * fires no automatic exports — the operator triggers via the "Run
 * export now" button or `parachute-vault export` from the CLI.
 *
 * Pre-vault#382 `watch: boolean` migrated as: true → "events", false →
 * "manual". The backend's validator still accepts `watch` as a back-
 * compat alias.
 */
export type MirrorSyncMode = "events" | "manual";

export interface MirrorConfig {
  enabled: boolean;
  /** "internal" → hidden under vault data dir; "external" → operator-picked path. */
  location: MirrorLocation;
  /** Required when location=external + enabled. Must exist + be a git repo. */
  external_path: string | null;
  /**
   * `events` (default) → hooks drive exports; mirror stays current as you
   * write. `manual` → no auto-fire; operator runs exports explicitly.
   */
  sync_mode: MirrorSyncMode;
  /** Per-pass `git add -A && git commit` if true. */
  auto_commit: boolean;
  /** Per-commit `git push` if true. Failures non-fatal. */
  auto_push: boolean;
  /** Verbatim template; reuses the CLI's variable set (`{{date}}` etc.). */
  commit_template: string;
  /**
   * Background safety-net poll interval in seconds (only matters when
   * `sync_mode: events`). Default 3600. Clamped to a sane range
   * server-side; the SPA doesn't surface this directly today.
   */
  safety_net_seconds: number;
}

export interface MirrorStatus {
  enabled: boolean;
  watch_running: boolean;
  mirror_path: string | null;
  last_export_at: string | null;
  last_export_notes_count: number | null;
  last_commit_sha: string | null;
  last_error: string | null;
}

export interface MirrorSnapshot {
  config: MirrorConfig;
  status: MirrorStatus;
}

function mirrorAuthHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) {
    throw new HttpError(401, "no admin token — open this page from the hub directory");
  }
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
}

/** GET the persisted mirror config + the current runtime status snapshot. */
export async function getMirror(vaultName: string): Promise<MirrorSnapshot> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror`,
    { headers: mirrorAuthHeaders() },
  );
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as MirrorSnapshot;
}

/**
 * PUT a new config. The server validates shape (400 on type errors with a
 * `field`-localized message), filesystem-validates external paths when
 * enabling, then persists + restarts the lifecycle. Returns the updated
 * snapshot.
 */
export async function putMirror(
  vaultName: string,
  config: Partial<MirrorConfig>,
): Promise<MirrorSnapshot> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror`,
    {
      method: "PUT",
      headers: { ...mirrorAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify(config),
    },
  );
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as MirrorSnapshot;
}

/**
 * POST a manual "run export now" trigger. Returns the updated snapshot.
 * Server returns 400 if the mirror isn't enabled — the SPA surfaces that
 * as the configured-but-disabled hint rather than a generic error.
 */
export async function runMirrorNow(vaultName: string): Promise<MirrorSnapshot> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/run-now`,
    {
      method: "POST",
      headers: mirrorAuthHeaders(),
    },
  );
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as MirrorSnapshot;
}

// ---------------------------------------------------------------------------
// Mirror credentials — `/vault/<name>/.parachute/mirror/auth[/*]`
//
// UI-configurable git push credentials. Two surfaces: Personal Access
// Token (universal — works against any HTTPS+token git host) and GitHub
// OAuth Device Flow (one-click shortcut for GitHub users, same
// end-state as a hand-pasted PAT). The endpoints don't return secrets
// — only redacted previews + user metadata.
// ---------------------------------------------------------------------------

/** Sanitized public shape — what the server hands back on GET /auth. */
export interface MirrorCredentialStatus {
  active_method: "github_oauth" | "pat" | null;
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

export interface DeviceCodeResponse {
  polling_id: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type DevicePollState =
  | { state: "pending" }
  | { state: "slow_down"; interval: number }
  | { state: "expired"; message?: string }
  | { state: "denied" }
  | {
      state: "granted";
      user: { login: string; id: number; name: string | null; avatar_url?: string };
    };

export interface GitHubRepoInfo {
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  updated_at: string;
  clone_url: string;
}

export async function getMirrorAuth(vaultName: string): Promise<MirrorCredentialStatus> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth`,
    { headers: mirrorAuthHeaders() },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as MirrorCredentialStatus;
}

export async function deleteMirrorAuth(vaultName: string): Promise<MirrorCredentialStatus> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth`,
    { method: "DELETE", headers: mirrorAuthHeaders() },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as MirrorCredentialStatus;
}

export async function startGithubDeviceFlow(
  vaultName: string,
): Promise<DeviceCodeResponse> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/device-code`,
    { method: "POST", headers: mirrorAuthHeaders() },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as DeviceCodeResponse;
}

export async function pollGithubDeviceFlow(
  vaultName: string,
  pollingId: string,
): Promise<DevicePollState> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/poll`,
    {
      method: "POST",
      headers: { ...mirrorAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ polling_id: pollingId }),
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as DevicePollState;
}

export async function postMirrorAuthPat(
  vaultName: string,
  args: { token: string; remote_url: string; label?: string },
): Promise<MirrorCredentialStatus> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/pat`,
    {
      method: "POST",
      headers: { ...mirrorAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify(args),
    },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as MirrorCredentialStatus;
}

export async function listGithubRepos(
  vaultName: string,
): Promise<{ repos: GitHubRepoInfo[]; truncated: boolean }> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/repos`,
    { headers: mirrorAuthHeaders() },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as { repos: GitHubRepoInfo[]; truncated: boolean };
}

export async function createGithubRepo(
  vaultName: string,
  args: { name: string; description?: string; private?: boolean },
): Promise<GitHubRepoInfo> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/create-repo`,
    {
      method: "POST",
      headers: { ...mirrorAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify(args),
    },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as GitHubRepoInfo;
}

export async function selectGithubRepo(
  vaultName: string,
  args: { owner: string; name: string },
): Promise<{ ok: boolean; applied: boolean; owner: string; name: string; remote: string }> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/select-repo`,
    {
      method: "POST",
      headers: { ...mirrorAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify(args),
    },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as {
    ok: boolean;
    applied: boolean;
    owner: string;
    name: string;
    remote: string;
  };
}

// ---------------------------------------------------------------------------
// Mirror import — `/vault/<name>/.parachute/mirror/import`
//
// Symmetric counterpart to the export-to-git flow. Clones a remote git
// repo into a tempdir, validates it's a vault export, and imports it
// into THIS vault. See `src/mirror-import.ts` for the worker.
// ---------------------------------------------------------------------------

/** How to authenticate the clone. See `src/mirror-import.ts:ImportAuth`. */
export type MirrorImportCredentials =
  | null // use stored mirror credentials
  | { kind: "credentialsFile" } // explicit — same as null
  | { kind: "pat"; token: string } // one-shot, doesn't touch stored creds
  | { kind: "none" }; // public repo, no auth

export interface MirrorImportRequest {
  remote_url: string;
  mode: "merge" | "replace";
  credentials: MirrorImportCredentials;
}

export interface MirrorImportResult {
  notes_imported: number;
  tags_imported: number;
  attachments_imported: number;
  /** Only set when `mode === "replace"`. */
  notes_deleted?: number;
  warnings: string[];
}

/**
 * POST a clone-and-import request. Returns the import stats on success.
 * Throws `HttpError` on validation/clone/conflict failures — caller can
 * surface the status code-specific message to the user.
 */
export async function postMirrorImport(
  vaultName: string,
  args: MirrorImportRequest,
): Promise<MirrorImportResult> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/import`,
    {
      method: "POST",
      headers: { ...mirrorAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify(args),
    },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as MirrorImportResult;
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: string; error_description?: string; message?: string };
    if (parsed.error_description) return parsed.error_description;
    if (parsed.message) return parsed.message;
    if (parsed.error) return parsed.error;
    if (text) return text;
  } catch {
    // not JSON
  }
  return `${res.status} ${res.statusText}`;
}
