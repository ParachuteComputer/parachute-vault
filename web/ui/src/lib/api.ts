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
import { clearToken, ensureToken, getToken } from "./auth.ts";

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

/**
 * Status code carried alongside the message so callers can branch
 * numerically. `errorType` carries the server's machine-readable
 * `error_type` discriminator when the response body includes one (e.g.
 * `app_lacks_admin_permission` from create-repo, `github_not_connected`
 * from the installations probe) so the UI can branch on a stable token
 * instead of string-matching the human message.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errorType?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Bearer-authed fetch with a single silent-refresh retry on 401.
 *
 * The flow:
 *   1. Read the cached token via `getToken()`. If missing, try
 *      `ensureToken(vaultName)` first — covers the page-refresh case where
 *      the SPA boots without a fragment-supplied token.
 *   2. Fire the request with `Authorization: Bearer <token>`.
 *   3. On 401, run `ensureToken(vaultName)` once more (the token may have
 *      expired between the proactive-refresh window and the operator's
 *      next action). If the refresh succeeds, retry the original request
 *      with the new token. If THAT also returns 401, throw HttpError as
 *      usual — the operator's session is genuinely gone.
 *
 * Why a single retry: the API call's job is one round trip; the auth
 * layer's job is to keep a token in hand. If both fail, the caller's
 * existing 401 handler renders the auth-required banner, whose poll loop
 * will then attempt yet another `ensureToken` — but as a banner-level
 * concern, not a hidden recursion in the fetch wrapper.
 *
 * Returns the `Response` for the caller to inspect (`.ok`, `.status`,
 * `.json()`, …). Doesn't centralize body parsing because the callsites
 * have heterogenous return shapes.
 */
interface AuthedFetchInit extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
}

async function authedFetch(
  vaultName: string,
  url: string,
  init: AuthedFetchInit = {},
): Promise<Response> {
  let token = getToken();
  if (!token) {
    const ensured = await ensureToken(vaultName);
    if (ensured.kind !== "ok") {
      throw new HttpError(401, "no admin token — sign in to the hub to refresh");
    }
    token = ensured.token;
  }
  const { headers: extraHeaders, ...rest } = init;
  const buildHeaders = (bearer: string): Record<string, string> => ({
    accept: "application/json",
    ...(extraHeaders ?? {}),
    authorization: `Bearer ${bearer}`,
  });
  const res = await fetch(url, { ...rest, headers: buildHeaders(token) });
  if (res.status !== 401) return res;
  // 401 → try one silent refresh + retry. The cached token might be stale
  // (expired between proactive ticks; or the hub revoked it). We clear
  // the cached token first so `ensureToken` is forced to hit the mint
  // endpoint — without this, a stale-but-not-expired-by-our-clock token
  // would be handed back unchanged and the retry would 401 again.
  clearToken();
  const refreshed = await ensureToken(vaultName);
  if (refreshed.kind !== "ok") {
    // Silent refresh also failed — return the original 401 response so
    // the caller's existing handler renders the auth-required banner.
    return res;
  }
  return fetch(url, { ...rest, headers: buildHeaders(refreshed.token) });
}

/**
 * Internal helper exported for tokens-api.ts and any other authed-fetch
 * caller in the SPA. Keeps the retry-on-401 logic centralized.
 */
export { authedFetch as _authedFetch };

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
  const res = await authedFetch(name, `/vault/${encodeURIComponent(name)}/`);
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
  /**
   * Push observability — Cut 5 of vault#392. `last_push_at` is the ISO
   * timestamp of the most recent successful push; `last_push_sha` is the
   * sha that landed at that time; `last_push_error` is set after a
   * failed push (cleared on the next successful one). `commits_unpushed`
   * counts local commits ahead of upstream tracking (null when no
   * upstream is configured yet — first push hasn't fired).
   */
  last_push_at: string | null;
  last_push_sha: string | null;
  last_push_error: string | null;
  commits_unpushed: number | null;
}

export interface MirrorSnapshot {
  config: MirrorConfig;
  status: MirrorStatus;
}

/** GET the persisted mirror config + the current runtime status snapshot. */
export async function getMirror(vaultName: string): Promise<MirrorSnapshot> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror`,
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
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
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
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/run-now`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as MirrorSnapshot;
}

/**
 * POST a manual "push now" trigger — Cut 6 of vault#392. Distinguished
 * from `runMirrorNow` in that this only fires `git push` against
 * already-committed state; it doesn't export or commit. Returns the
 * updated snapshot + push outcome.
 */
export interface MirrorPushNowResponse extends MirrorSnapshot {
  push:
    | { fired: false; reason: "not_enabled" | "no_mirror_path" }
    | { fired: true; pushed: boolean; sha?: string; error?: string };
}
export async function pushMirrorNow(vaultName: string): Promise<MirrorPushNowResponse> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/push-now`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as MirrorPushNowResponse;
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

/**
 * vault#483 fix 1 — outcome flag carried on the credential-save responses
 * (device-flow grant + PAT save). Linking implies backup intent, so the
 * backend turns history on for a never-configured vault:
 *   - `true` — history (the mirror) is on: just-enabled or already on.
 *   - `"left_disabled"` — a config exists with `enabled: false`; the server
 *     refuses to silently flip an explicit operator choice. The UI offers
 *     the one-click "Turn on history now?" enable (`PUT` with enabled:true).
 *   - `false` — enable was attempted but the mirror didn't come up; the
 *     mirror status carries the actionable error.
 */
export type HistoryOnLink = true | false | "left_disabled";

export type DevicePollState =
  | { state: "pending" }
  | { state: "slow_down"; interval: number }
  | { state: "expired"; message?: string }
  | { state: "denied" }
  | {
      state: "granted";
      user: { login: string; id: number; name: string | null; avatar_url?: string };
      /** vault#483 — history-on-link outcome (see `HistoryOnLink`). */
      history_enabled: HistoryOnLink;
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

// ---------------------------------------------------------------------------
// GitHub App install state — vault#480.
//
// GitHub-App semantics that shape the connect flow: authorization (device
// flow) and installation are SEPARATE, order-independent steps. A granted
// token reaches no private repos until the operator also installs the app
// on their account (and each org) and selects repos. The installations
// endpoint is the canonical probe; `installed: false` = authorized-but-
// not-installed (the state Aaron walked into blind).
// ---------------------------------------------------------------------------

export interface GitHubAppInfo {
  client_id: string;
  /** URL slug — drives github.com/apps/<slug>/installations/new. */
  slug: string;
  /** True when running on the shared Parachute app; false = BYO app. */
  is_shared_default: boolean;
}

export interface GitHubInstallationInfo {
  id: number;
  account_login: string;
  /** Cast from the wire without runtime narrowing — safe by degradation:
   *  an unknown value falls through to the 'user' branch in
   *  `installationSettingsUrl`, it isn't validated. */
  account_type: "User" | "Organization";
  /** Whether the installation grants all repos or a hand-picked subset. */
  repository_selection: "all" | "selected";
}

export interface GithubInstallState {
  app: GitHubAppInfo;
  installed: boolean;
  install_url: string;
  installations: GitHubInstallationInfo[];
}

/** A repo annotated with which installation (account) grants it. */
export interface GitHubRepoWithInstallation extends GitHubRepoInfo {
  account_login: string;
  installation_id: number;
}

/**
 * Discriminated repo-picker payload. `installed: false` means the operator
 * authorized the app but hasn't installed it anywhere — the UI shows the
 * guided-install step instead of an empty "you have no repos" list.
 */
export type GithubReposResult =
  | { installed: true; repos: GitHubRepoWithInstallation[]; truncated: boolean }
  | { installed: false; install_url: string; repos: GitHubRepoWithInstallation[]; truncated: false };

export async function getMirrorAuth(vaultName: string): Promise<MirrorCredentialStatus> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth`,
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as MirrorCredentialStatus;
}

export async function deleteMirrorAuth(vaultName: string): Promise<MirrorCredentialStatus> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as MirrorCredentialStatus;
}

export async function startGithubDeviceFlow(
  vaultName: string,
): Promise<DeviceCodeResponse> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/device-code`,
    { method: "POST" },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as DeviceCodeResponse;
}

export async function pollGithubDeviceFlow(
  vaultName: string,
  pollingId: string,
): Promise<DevicePollState> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/poll`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ polling_id: pollingId }),
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as DevicePollState;
}

/**
 * `MirrorCredentialSaveResult` — Cut 3/Cut 6 extends the PAT-save +
 * select-repo responses with side-effects of the save: auto_push being
 * auto-enabled and an initial push being fired. The SPA uses these to
 * render a toast "Credentials wired + auto-push enabled. Your next
 * commit will push to <repo>" rather than a silent "saved" confirmation.
 */
export interface MirrorCredentialSaveResult extends MirrorCredentialStatus {
  /** vault#483 — history-on-link outcome (see `HistoryOnLink`). */
  history_enabled: HistoryOnLink;
  auto_push_was_already_enabled: boolean;
  auto_push_enabled: boolean;
  initial_push:
    | { fired: false; reason: string }
    | { fired: true; pushed: boolean; error?: string; sha?: string };
}

export async function postMirrorAuthPat(
  vaultName: string,
  args: { token: string; remote_url: string; label?: string },
): Promise<MirrorCredentialSaveResult> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/pat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as MirrorCredentialSaveResult;
}

/**
 * Install state for the connect flow (vault#480): which GitHub App is in
 * play (shared default vs BYO), whether it's installed ANYWHERE for this
 * operator, the install link, and the per-account installations.
 *
 * Explicitly a network probe (the server calls GitHub) — call it when
 * rendering the connect flow / repo picker, not on every status poll.
 * Throws `HttpError` with `errorType: "github_not_connected"` (400 — not
 * 401, which would trip `authedFetch`'s token-refresh retry and clear a
 * perfectly valid cached admin token) when no GitHub sign-in is stored.
 */
export async function getGithubInstallations(
  vaultName: string,
): Promise<GithubInstallState> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/installations`,
  );
  if (!res.ok) {
    const { message, errorType } = await readErrorParts(res);
    throw new HttpError(res.status, message, errorType);
  }
  return (await res.json()) as GithubInstallState;
}

export async function listGithubRepos(
  vaultName: string,
): Promise<GithubReposResult> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/repos`,
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as GithubReposResult;
}

/**
 * Create a repo on the operator's account. With the shared Parachute app
 * this 403s by design (`POST /user/repos` needs Administration:write; the
 * shared app is frozen at Contents-only) — the throw carries
 * `errorType: "app_lacks_admin_permission"` so the UI renders the
 * guided-manual checklist instead of an error toast. BYO apps that grant
 * Administration:write succeed.
 */
export async function createGithubRepo(
  vaultName: string,
  args: { name: string; description?: string; private?: boolean },
): Promise<GitHubRepoInfo> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/create-repo`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    },
  );
  if (!res.ok) {
    const { message, errorType } = await readErrorParts(res);
    throw new HttpError(res.status, message, errorType);
  }
  return (await res.json()) as GitHubRepoInfo;
}

export interface SelectGithubRepoResult {
  ok: boolean;
  applied: boolean;
  owner: string;
  name: string;
  remote: string;
  /**
   * vault#483 — history-on-link outcome (see `HistoryOnLink`). Select-repo
   * runs history-on-link too: the "Choose repository…" re-entry can be the
   * first linked action for a credential saved before history-on-link
   * existed, on a never-configured vault.
   */
  history_enabled: HistoryOnLink;
  /** Cut 3/Cut 6 — auto_push side-effects from credential save. */
  auto_push_was_already_enabled: boolean;
  auto_push_enabled: boolean;
  initial_push:
    | { fired: false; reason: string }
    | { fired: true; pushed: boolean; error?: string; sha?: string };
}

export async function selectGithubRepo(
  vaultName: string,
  args: { owner: string; name: string },
): Promise<SelectGithubRepoResult> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/auth/github/select-repo`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as SelectGithubRepoResult;
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
  /**
   * Also enable sync (mirror push-back) to the imported repo, reusing the
   * import credentials. **Defaults to FALSE on the server** since vault#641 —
   * an import is a read and must not arm a write on its own. The UI sends the
   * checkbox state explicitly either way.
   */
  enable_sync?: boolean;
}

/** Stage the running import is in. Mirrors `src/mirror-import.ts:ImportStage`. */
export type MirrorImportStage = "cloning" | "importing" | "syncing";

/** Terminal + non-terminal job states. */
export type MirrorImportStatus = "running" | "succeeded" | "failed";

/** Why an import failed. Mirrors `src/mirror-import-jobs.ts:ImportJobError`. */
export interface MirrorImportError {
  error_type:
    | "git_not_installed"
    | "concurrent_import"
    | "not_a_vault_export"
    | "clone_failed"
    | "internal";
  message: string;
}

/**
 * An import job record (vault#640). POST returns one of these with
 * `status: "running"`; poll `getMirrorImportJob` until it goes terminal.
 */
export interface MirrorImportJob {
  job_id: string;
  vault_name: string;
  status: MirrorImportStatus;
  stage: MirrorImportStage;
  /** Live progress line — e.g. "Receiving objects:  47% (470/1000)". */
  detail?: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  result?: MirrorImportResult;
  error?: MirrorImportError;
}

/**
 * Outcome of starting an import.
 *
 * `attached: true` means we didn't start a new import — one was already
 * running for this vault and we're now watching that one instead.
 */
export interface MirrorImportStart {
  attached: boolean;
  job: MirrorImportJob;
}

export interface MirrorImportResult {
  notes_imported: number;
  tags_imported: number;
  attachments_imported: number;
  /** Only set when `mode === "replace"`. */
  notes_deleted?: number;
  warnings: string[];
  /**
   * vault#416 — whether sync to the imported repo ended up enabled. True
   * when push-back is now wired; false when opted out, blocked (no push
   * credentials / a different mirror already configured), or sync-setup
   * failed (the import still succeeded).
   */
  sync_enabled: boolean;
  /**
   * Human-readable reason sync wasn't enabled. Present only when
   * `sync_enabled` is false and the caller asked for sync. Shown as an
   * info/warning, NOT an error — the import succeeded regardless.
   */
  sync_warning?: string;
}

/**
 * START a clone-and-import. Resolves with the `running` job record as soon as
 * the server accepts it (202) — the import itself continues server-side. Poll
 * `getMirrorImportJob` for stage, progress, and the terminal outcome.
 *
 * Throws `HttpError` for the synchronous refusals: validation (400) and git
 * missing (503).
 *
 * The import OUTCOME does not arrive here (vault#640). It can't: a big vault
 * takes far longer than the ~4 minutes hub's proxy allows a single request to
 * live, so the old "await the whole import in the POST" shape capped what was
 * importable rather than what was correct.
 */
export async function postMirrorImport(
  vaultName: string,
  args: MirrorImportRequest,
): Promise<MirrorImportStart> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/import`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    },
  );
  if (res.ok) {
    return { attached: false, job: (await res.json()) as MirrorImportJob };
  }
  // 409 — this vault already has an import running. The server hands back the
  // in-flight `job_id` precisely so we can ATTACH to it: a reload mid-import,
  // or a second tab, should show the running import rather than an error about
  // an import the operator can't see.
  if (res.status === 409) {
    const text = await res.text();
    let jobId: string | undefined;
    let message = text;
    try {
      const parsed = JSON.parse(text) as { job_id?: string; message?: string };
      if (typeof parsed.job_id === "string" && parsed.job_id.length > 0) {
        jobId = parsed.job_id;
      }
      if (parsed.message) message = parsed.message;
    } catch {
      // not JSON — fall through with the raw text as the message
    }
    if (jobId) {
      return { attached: true, job: await getMirrorImportJob(vaultName, jobId) };
    }
    throw new HttpError(409, message, "concurrent_import");
  }
  throw new HttpError(res.status, await readError(res));
}

/**
 * Poll one import job. 404 (`HttpError` 404) means the id is unknown to this
 * vault — most often because the vault restarted mid-import, since jobs are
 * in-memory by design.
 */
export async function getMirrorImportJob(
  vaultName: string,
  jobId: string,
): Promise<MirrorImportJob> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/mirror/import/${encodeURIComponent(jobId)}`,
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as MirrorImportJob;
}


// ---------------------------------------------------------------------------
// Transcription — `/vault/<name>/.parachute/transcription`
//
// The setup surface. Unlike the embeddings toggle, transcription can be
// "configured" and still not work: it needs a binary and a model on disk that
// no config file can promise are there. So the snapshot carries the missing
// PIECE, the paths searched, and the command that fixes it — see
// `src/transcription-routes.ts`.
// ---------------------------------------------------------------------------

export interface TranscriptionModelOption {
  id: string;
  label: string;
  engine: "parakeet" | "whisper";
  size_mb: number;
  min_ram_mb: number;
  note: string;
  /** Whether this model's file is already downloaded. */
  installed: boolean;
}

export interface TranscriptionSettings {
  provider: string;
  available_providers: string[];
  model_id: string;
  model: TranscriptionModelOption | null;
  available_models: TranscriptionModelOption[];
  /** The CLI this model needs, plus the dirs probed — so "not found" is debuggable. */
  binary: { name: string; path: string | null; searched: string[] };
  ffmpeg: { path: string | null };
  /** Everything needed is present. Distinct from `active`. */
  ready: boolean;
  /** A worker is live in the running process right now. */
  active: boolean;
  /** `ready !== active` — a persisted preference the worker hasn't picked up. */
  restart_required: boolean;
  /** Why `ready` is false; null when ready. */
  reason: string | null;
  /** The exact command that fixes it; null when ready. */
  fix_command: string | null;
}

/** Read the transcription setup snapshot. */
export async function getTranscriptionSettings(
  vaultName: string,
): Promise<TranscriptionSettings> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/transcription`,
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as TranscriptionSettings;
}

/**
 * Persist a provider and/or model preference. Does NOT install anything —
 * downloads and package managers stay in the CLI. Returns the fresh snapshot,
 * which will report `restart_required`.
 */
export async function putTranscriptionSettings(
  vaultName: string,
  body: { provider?: string; model_id?: string },
): Promise<TranscriptionSettings> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/transcription`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as TranscriptionSettings;
}

// ---------------------------------------------------------------------------
// Embeddings — `/vault/<name>/.parachute/embeddings`
//
// The semantic-search opt-in toggle (0.7.3 fast-follow). Reads/writes the
// host-global persisted `embeddings_enabled` setting. Activation is restart-
// to-apply: `active` is what's live in the running process now; `effective`
// is what a restart would produce; `restartRequired` is the gap between them.
// Field semantics live in `src/embeddings-routes.ts:EmbeddingsSettingsSnapshot`.
// ---------------------------------------------------------------------------

export interface EmbeddingsSettings {
  /** Persisted `embeddings_enabled` — what the toggle reflects (false when unset). */
  enabled: boolean;
  /** `EMBEDDINGS_ENABLED` env override: true (forced on), false (forced off), null (defers). */
  env_override: boolean | null;
  /** True exactly when `env_override` is non-null — an env var is forcing the value. */
  env_forced: boolean;
  /** What a fresh boot would resolve (env override, else persisted, else off). */
  effective: boolean;
  /** Whether semantic search is LIVE in the running process right now. */
  active: boolean;
  /** True when `active !== effective` — persisted change awaits a restart. */
  restart_required: boolean;
  /** First-enable model-download size hint (MB) for the copy. */
  model_download_mb: number;
}

/** GET the current embeddings settings snapshot. */
export async function getEmbeddingsSettings(vaultName: string): Promise<EmbeddingsSettings> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/embeddings`,
  );
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as EmbeddingsSettings;
}

/**
 * PUT a new persisted `embeddings_enabled` value. Returns the updated
 * snapshot. The server persists the setting (even when an env var is forcing
 * a value) and reports `restart_required` when the running process hasn't
 * picked up the change yet.
 */
export async function putEmbeddingsSettings(
  vaultName: string,
  enabled: boolean,
): Promise<EmbeddingsSettings> {
  const res = await authedFetch(
    vaultName,
    `/vault/${encodeURIComponent(vaultName)}/.parachute/embeddings`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as EmbeddingsSettings;
}

async function readError(res: Response): Promise<string> {
  return (await readErrorParts(res)).message;
}

/**
 * Like `readError` but also surfaces the machine-readable `error_type`
 * discriminator (when present) so callers can construct an `HttpError`
 * the UI can branch on without string-matching.
 */
async function readErrorParts(
  res: Response,
): Promise<{ message: string; errorType?: string }> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as {
      error?: string;
      error_description?: string;
      error_type?: string;
      message?: string;
    };
    const errorType = typeof parsed.error_type === "string" ? parsed.error_type : undefined;
    if (parsed.error_description) return { message: parsed.error_description, errorType };
    if (parsed.message) return { message: parsed.message, errorType };
    if (parsed.error) return { message: parsed.error, errorType };
    if (text) return { message: text, errorType };
  } catch {
    // not JSON
  }
  return { message: `${res.status} ${res.statusText}` };
}
