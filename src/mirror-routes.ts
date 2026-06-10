/**
 * HTTP surface for the mirror lifecycle.
 *
 *   GET  /vault/<name>/.parachute/mirror         — read current config + runtime status
 *   PUT  /vault/<name>/.parachute/mirror         — update config + reload watch loop
 *   POST /vault/<name>/.parachute/mirror/run-now — fire a one-shot export+commit+push pass
 *
 * URL note: the design doc names this `/admin/mirror`, but vault's
 * existing routing already mounts the admin SPA's static-file bundle at
 * `/vault/<name>/admin/*` (vault#252). Putting the API endpoint there
 * would collide with the SPA mount. We use the existing `.parachute/`
 * namespace instead — sibling to `.parachute/config`, `.parachute/info`,
 * `.parachute/icon.svg` — which matches the module-protocol convention
 * for per-module API surfaces. The hub admin SPA (Phase A2) will call
 * this URL; operators issuing `curl` calls use it directly.
 *
 * Both endpoints gate on `vault:admin` — see `routing.ts` for the
 * upstream auth wiring. This module is the after-auth handler; the
 * caller has already verified the scope.
 *
 * These two endpoints unblock the Phase A2 hub admin SPA from configuring
 * vault-side mirrors. For Phase A1 the only consumers are direct API
 * callers (curl, the future SPA) and operators editing config.yaml by
 * hand + restarting the vault.
 */

import { existsSync } from "node:fs";

import {
  defaultMirrorConfig,
  mirrorConfigPath,
  readMirrorConfigForVault,
  validateExternalPath,
  validateMirrorConfigShape,
  type MirrorConfig,
} from "./mirror-config.ts";
import type { MirrorManager } from "./mirror-manager.ts";
import { getMirrorManager } from "./mirror-registry.ts";
import {
  applyToGitRemote,
  deleteCredentials,
  emptyCredentials,
  githubAuthedRemoteUrl,
  readCredentials,
  redactRemoteUrl,
  sanitizeCredentials,
  unsetGitRemote,
  writeCredentials,
  type MirrorCredentials,
} from "./mirror-credentials.ts";
import {
  GITHUB_APP_SLUG_DEFAULT,
  GITHUB_CLIENT_ID_DEFAULT,
  GitHubApiError,
  createRepo,
  fetchUser,
  getGithubAppSlug,
  getGithubClientId,
  installUrlForSlug,
  isPlaceholderClientId,
  listInstallationRepos,
  listInstallations,
  pollForToken,
  requestDeviceCode,
  type FetchLike,
  type GitHubRepoInfo,
} from "./github-device-flow.ts";
import {
  CloneFailedError,
  ImportConflictError,
  NotAVaultExportError,
  cloneAndImport,
  type GitSpawn,
  type ImportAuth,
  type ImportResult,
} from "./mirror-import.ts";
import { redactToken } from "./export-watch.ts";
import { GitNotInstalledError, ensureGitAvailable } from "./git-preflight.ts";
import { getVaultStore } from "./vault-store.ts";
import { assetsDir } from "./routes.ts";

/**
 * `GET /vault/<name>/.parachute/mirror` — return the persisted config +
 * the runtime status the manager is currently tracking.
 *
 * Always returns 200 (auth was already enforced upstream). When no
 * mirror config has ever been written, returns the defaults — the
 * operator + the hub SPA see a consistent shape regardless of whether
 * any persistence has happened yet.
 */
export function handleMirrorGet(manager: MirrorManager): Response {
  // Per-vault (vault#400): `getEffectiveConfig()` returns THIS vault's
  // persisted config even when the lazily-built manager hasn't started yet,
  // so a non-default vault's page shows ITS config — never the default
  // vault's. That's the exact "same remote on every vault page" symptom.
  const config = manager.getEffectiveConfig();
  const status = manager.getStatus();
  return Response.json(
    {
      config,
      status,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * `PUT /vault/<name>/.parachute/mirror` — accept a JSON body with the
 * mirror config block, validate, persist, restart the in-process
 * lifecycle.
 *
 * Request shape: same JSON as the MirrorConfig type — { enabled,
 * location, external_path, sync_mode, auto_commit, auto_push,
 * commit_template, safety_net_seconds }. All fields optional; missing
 * fields fall back to defaults. Legacy `watch: boolean` and
 * `interval_seconds: number` are also accepted (back-compat with
 * hand-edited configs); they translate to `sync_mode` / `safety_net_seconds`
 * via `validateMirrorConfigShape`.
 *
 * Validation surface:
 *   - JSON shape: location ∈ {internal, external}, types match, etc.
 *     Returns 400 with `field`-localized error on failure.
 *   - For enabled=true + location=external: the supplied external_path
 *     must exist on the filesystem AND be a git repo. Returns 400
 *     with an actionable error message on failure.
 *   - For enabled=false (any location): skip BOTH the cross-field
 *     "external requires external_path" check AND the filesystem
 *     check. Disable should never fail validation on path-related
 *     issues — the operator's just trying to turn off a mirror whose
 *     path may have gone away.
 *
 * Response: 200 with the new config + status snapshot.
 */
export async function handleMirrorPut(
  req: Request,
  manager: MirrorManager,
  // Test seam for the external-path git-presence preflight (default
  // `Bun.which` inside `validateExternalPath`). Inject a fn returning `null`
  // to exercise the git_not_installed 503 path without uninstalling git.
  whichOverride?: (cmd: string) => string | null,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return Response.json(
      {
        error: "Invalid JSON body",
        message: (err as Error).message ?? String(err),
      },
      { status: 400 },
    );
  }

  // Per-vault (vault#399): bind the auto_push/internal credential gate to
  // the mirror-owning vault so it reads that vault's own credentials file.
  const shape = validateMirrorConfigShape(body, { vaultName: manager.getVaultName() });
  if (!shape.ok) {
    return Response.json(
      {
        error: "Invalid mirror config",
        field: shape.field,
        message: shape.error,
      },
      { status: 400 },
    );
  }

  const config: MirrorConfig = shape.config;

  // Filesystem-level validation runs only when the operator is asking us
  // to *do* something with an external path. Disabling the mirror by-
  // flipping enabled to false shouldn't fail because the path went away.
  if (config.enabled && config.location === "external" && config.external_path) {
    let pathCheck;
    try {
      pathCheck = await validateExternalPath(config.external_path, whichOverride);
    } catch (err) {
      if (err instanceof GitNotInstalledError) {
        // 503 git_not_installed — consistent with the import route. The
        // server can't validate (or later sync) an external git mirror
        // without git installed; the message tells the operator how to fix.
        return Response.json(
          {
            error: "git not installed",
            error_type: "git_not_installed",
            message: err.message,
          },
          { status: 503 },
        );
      }
      throw err;
    }
    if (!pathCheck.ok) {
      return Response.json(
        {
          error: "Invalid external_path",
          field: "external_path",
          message: pathCheck.error,
        },
        { status: 400 },
      );
    }
  }

  // Persist + restart lifecycle. `reload` writes the config first and
  // then calls `start()`, so a crash between the two leaves the operator-
  // intended state on disk (next boot applies it).
  const status = await manager.reload(config);
  return Response.json(
    {
      config: manager.getConfig(),
      status,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * `POST /vault/<name>/.parachute/mirror/run-now` — fire a one-shot export
 * cycle right now (export → optional commit → optional push), using the
 * persisted config. Same response shape as GET so the admin SPA reuses
 * one decoder for both initial-load and after-trigger refresh.
 *
 * Refuses to fire (400) when the mirror is disabled: `runNow()` would
 * already no-op in that case, but returning a 200 with stale status
 * lets a misclick look successful. The 400 is the actionable surface
 * — "enable the mirror first, then re-trigger."
 *
 * Mutating verb, vault:admin-gated upstream in `routing.ts` (alongside
 * the GET/PUT). Auth is already enforced by the time this handler runs.
 */
export async function handleMirrorRunNow(
  manager: MirrorManager,
): Promise<Response> {
  const status = manager.getStatus();
  if (!status.enabled) {
    return Response.json(
      {
        error: "Mirror not enabled",
        message:
          "Mirror must be enabled (and successfully bootstrapped) before a manual run can fire. Enable it via PUT /.parachute/mirror first.",
      },
      { status: 400 },
    );
  }
  const updated = await manager.runNow();
  return Response.json(
    {
      config: manager.getConfig(),
      status: updated,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * `POST /vault/<name>/.parachute/mirror/push-now` — Cut 6 of vault#392.
 *
 * Fire a push against the currently-committed state of the mirror dir.
 * Distinguished from `/run-now` which exports + commits + pushes —
 * `push-now` is the credentials-side flow where the operator just wants
 * to see "did the credentials I just saved actually work?"
 *
 * Returns the post-push status snapshot. Errors (no path, mirror
 * disabled, push failed) surface as a JSON response — push failures
 * are NOT 500s because the operator's expected next-step is to look at
 * `last_push_error` and fix their remote, not "vault crashed."
 */
export async function handleMirrorPushNow(
  manager: MirrorManager,
): Promise<Response> {
  const status = manager.getStatus();
  if (!status.enabled) {
    return Response.json(
      {
        error: "Mirror not enabled",
        message:
          "Mirror must be enabled before a push can fire. Enable it via PUT /.parachute/mirror first.",
      },
      { status: 400 },
    );
  }
  const result = await manager.pushNow();
  return Response.json(
    {
      config: manager.getConfig(),
      status: manager.getStatus(),
      push: result,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * Convenience for tests + future callers: build the GET response from a
 * known-good config without needing a real MirrorManager.
 */
export function buildMirrorGetResponse(
  config: MirrorConfig | undefined,
  status: ReturnType<MirrorManager["getStatus"]>,
): { config: MirrorConfig; status: ReturnType<MirrorManager["getStatus"]> } {
  return {
    config: config ?? defaultMirrorConfig(),
    status,
  };
}

// ---------------------------------------------------------------------------
// Credential routes — Cut 3 of the UI-configurable push credentials work,
// reshaped by the GitHub-App installation semantics (vault#480).
//
// Surfaces, all `vault:<name>:admin`-gated upstream:
//
//   POST   /.parachute/mirror/auth/github/device-code  — start GitHub Device
//          Flow; returns { polling_id, user_code, verification_uri, expires_in,
//          interval }. The full device_code is kept server-side; the SPA polls
//          by polling_id (a short opaque token) so the device_code doesn't
//          land on the wire twice.
//   POST   /.parachute/mirror/auth/github/poll         — poll for token, body
//          { polling_id }. On `granted`: fetch user, save credentials, enable
//          history for a never-configured vault (vault#483), return
//          { state: "granted", user, history_enabled }. Other states surface
//          verbatim.
//   POST   /.parachute/mirror/auth/pat                 — validate + store a
//          PAT (token + remote_url + label). Validates via `git ls-remote`.
//          Same history-on-link behavior as the poll grant (vault#483).
//   GET    /.parachute/mirror/auth                     — current connection
//          status (NO secrets, NO network). Returns the sanitized public shape.
//   DELETE /.parachute/mirror/auth                     — wipe credentials,
//          unset embedded-credential remote URL.
//   GET    /.parachute/mirror/auth/github/installations — install state
//          (vault#480): which app, whether it's installed anywhere, the
//          install link, and the per-account installations. The one
//          explicitly-network status endpoint — `GET /auth` stays offline.
//   GET    /.parachute/mirror/auth/github/repos        — list the repos the
//          operator's app INSTALLATIONS grant (user + org accounts), via the
//          stored OAuth token. Returns { installed: false, install_url,
//          repos: [] } when the app isn't installed anywhere yet.
//   POST   /.parachute/mirror/auth/github/create-repo  — create a new private
//          repo on behalf of the operator. 403s with the shared Contents-only
//          app (mapped to error_type "app_lacks_admin_permission" + the
//          guided-manual path); works for BYO apps with Administration:write.
//
// ---------------------------------------------------------------------------

/**
 * In-memory device-flow polling sessions. Maps a short opaque `polling_id`
 * to the server-side `device_code` + metadata. Lives in process memory only;
 * a vault restart blanks them (the operator restarts the flow, no big deal —
 * the OAuth app's tokens that have already landed in credentials.yaml
 * survive).
 *
 * 15-minute TTL — matches GitHub's default `expires_in` and saves us
 * leaking polling slots on abandoned flows.
 */
interface DeviceFlowSession {
  device_code: string;
  client_id: string;
  expires_at: number; // epoch ms
  interval: number;
}
const deviceFlowSessions = new Map<string, DeviceFlowSession>();

function generatePollingId(): string {
  // 16 hex chars from crypto. Not a secret (it's just a session-lookup
  // key) but cryptographic strength keeps two concurrent operators from
  // ever colliding.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function reapExpiredSessions(now = Date.now()): void {
  for (const [k, v] of deviceFlowSessions.entries()) {
    if (v.expires_at <= now) deviceFlowSessions.delete(k);
  }
}

/** Test seam — flush all in-memory sessions. */
export function _resetDeviceFlowSessionsForTest(): void {
  deviceFlowSessions.clear();
}

/**
 * Errors out cleanly when PARACHUTE_GITHUB_CLIENT_ID is set to a
 * placeholder-shaped value. A real default ships in the build (the shared
 * Parachute GitHub App — see github-device-flow.ts), so this is only
 * reachable via a misconfigured override.
 */
function placeholderClientIdResponse(): Response {
  return Response.json(
    {
      error: "GitHub auth misconfigured",
      error_type: "placeholder_client_id",
      message:
        "PARACHUTE_GITHUB_CLIENT_ID is set to a placeholder value. Unset it to use the built-in shared Parachute GitHub App, set it to your own app's client_id, or use the Personal Access Token path instead.",
    },
    { status: 503 },
  );
}

/**
 * `POST /.parachute/mirror/auth/github/device-code` — kick off the device
 * flow. Server retains the `device_code`; the SPA gets a short
 * `polling_id` it uses to poll without re-sending the device_code on
 * every round-trip.
 */
export async function handleAuthGithubDeviceCode(
  fetchImpl?: FetchLike,
): Promise<Response> {
  const clientId = getGithubClientId();
  if (isPlaceholderClientId(clientId)) {
    return placeholderClientIdResponse();
  }
  let result;
  try {
    result = await requestDeviceCode(clientId, fetchImpl);
  } catch (err) {
    return Response.json(
      {
        error: "Device code request failed",
        message: (err as Error).message ?? String(err),
      },
      { status: 502 },
    );
  }
  reapExpiredSessions();
  const polling_id = generatePollingId();
  deviceFlowSessions.set(polling_id, {
    device_code: result.device_code,
    client_id: clientId,
    expires_at: Date.now() + result.expires_in * 1000,
    interval: result.interval,
  });
  return Response.json(
    {
      polling_id,
      user_code: result.user_code,
      verification_uri: result.verification_uri,
      expires_in: result.expires_in,
      interval: result.interval,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * `POST /.parachute/mirror/auth/github/poll` — poll for token (body
 * `{polling_id}`). On `granted`, fetch user, save credentials, return
 * `{state: "granted", user}`. On `pending`/`slow_down`, return state +
 * any new interval. On terminal failure, return state + cleanup the
 * session entry.
 */
export async function handleAuthGithubPoll(
  req: Request,
  manager: MirrorManager,
  fetchImpl?: FetchLike,
): Promise<Response> {
  let body: { polling_id?: unknown };
  try {
    body = (await req.json()) as { polling_id?: unknown };
  } catch (err) {
    return Response.json(
      { error: "Invalid JSON body", message: (err as Error).message ?? String(err) },
      { status: 400 },
    );
  }
  if (typeof body.polling_id !== "string") {
    return Response.json(
      { error: "polling_id required", message: "Pass the polling_id from /auth/github/device-code." },
      { status: 400 },
    );
  }
  reapExpiredSessions();
  const session = deviceFlowSessions.get(body.polling_id);
  if (!session) {
    return Response.json(
      {
        state: "expired",
        message: "Polling session not found or expired. Start the device flow again.",
      },
      { status: 404 },
    );
  }
  let poll;
  try {
    poll = await pollForToken(session.client_id, session.device_code, fetchImpl);
  } catch (err) {
    return Response.json(
      {
        error: "Poll failed",
        message: (err as Error).message ?? String(err),
      },
      { status: 502 },
    );
  }

  if (poll.state === "granted") {
    // Fetch user info to populate credentials.
    let user;
    try {
      user = await fetchUser(poll.access_token, fetchImpl);
    } catch (err) {
      return Response.json(
        {
          error: "Token granted but /user fetch failed",
          message: (err as Error).message ?? String(err),
        },
        { status: 502 },
      );
    }
    // Persist credentials. Keep any existing PAT — only swap active method.
    const vaultName = manager.getVaultName();
    const existing = readCredentials(vaultName) ?? emptyCredentials();
    const next: MirrorCredentials = {
      ...existing,
      active_method: "github_oauth",
      github_oauth: {
        access_token: poll.access_token,
        scope: poll.scope,
        authorized_at: new Date().toISOString(),
        user_login: user.login,
        user_id: user.id,
      },
    };
    try {
      writeCredentials(vaultName, next);
    } catch (err) {
      return Response.json(
        {
          error: "Credentials write failed",
          message: (err as Error).message ?? String(err),
        },
        { status: 500 },
      );
    }
    // Clean up the polling session.
    deviceFlowSessions.delete(body.polling_id);
    // vault#483: linking implies backup intent — enable history for a
    // never-configured vault (consent-respecting; see the helper). No
    // remote URL is set here — we don't have an owner/repo yet (the
    // operator hasn't picked a repo); that wiring happens in select-repo,
    // which is also where auto_push flips on (Cut 3).
    const history_enabled = await maybeEnableHistoryOnLink(manager);
    return Response.json(
      {
        state: "granted",
        user: {
          login: user.login,
          id: user.id,
          name: user.name,
          avatar_url: user.avatar_url,
        },
        history_enabled,
      },
      { headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  if (poll.state === "expired" || poll.state === "denied") {
    deviceFlowSessions.delete(body.polling_id);
  }

  // Pending / slow_down / expired / denied — surface verbatim.
  const responseBody: Record<string, unknown> = { state: poll.state };
  if (poll.state === "slow_down") responseBody.interval = poll.interval;
  return Response.json(responseBody, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

/**
 * `POST /.parachute/mirror/auth/pat` — store a PAT + remote URL.
 *
 * Validation:
 *   - `token` is a non-empty string.
 *   - `remote_url` is a non-empty string that parses as an HTTPS URL.
 *   - `git ls-remote <remote_url>` succeeds with timeout 10s. The token
 *     can be embedded in the URL or rely on the server's git config —
 *     we just need git to be able to talk to the remote.
 *
 * Probes via `git ls-remote` with GIT_TERMINAL_PROMPT=0 (no interactive
 * prompts; bad creds fail fast) and a 10-second hard timeout.
 */
export async function handleAuthPat(
  req: Request,
  manager: MirrorManager,
  // Test seam for the `git ls-remote` validation probe (default
  // `probeGitLsRemote`, which spawns real git against the supplied remote).
  // Inject a fn returning `{ok: true}` to exercise the post-validation save
  // path (credential persist + history-on-link, vault#483) hermetically.
  probeOverride?: (
    url: string,
    timeoutMs: number,
  ) => Promise<{ ok: boolean; error?: string }>,
): Promise<Response> {
  let body: { token?: unknown; remote_url?: unknown; label?: unknown };
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch (err) {
    return Response.json(
      { error: "Invalid JSON body", message: (err as Error).message ?? String(err) },
      { status: 400 },
    );
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const remote_url = typeof body.remote_url === "string" ? body.remote_url.trim() : "";
  const label =
    typeof body.label === "string" && body.label.trim().length > 0
      ? body.label.trim()
      : "Custom git credential";
  if (token.length === 0) {
    return Response.json(
      {
        error: "token required",
        field: "token",
        message: "Provide a personal access token (e.g. ghp_...).",
      },
      { status: 400 },
    );
  }
  if (remote_url.length === 0) {
    return Response.json(
      {
        error: "remote_url required",
        field: "remote_url",
        message: "Provide the full HTTPS remote URL (e.g. https://github.com/owner/repo.git).",
      },
      { status: 400 },
    );
  }
  // Quick URL shape check.
  let parsed: URL;
  try {
    parsed = new URL(remote_url);
  } catch {
    return Response.json(
      {
        error: "remote_url invalid",
        field: "remote_url",
        message: "remote_url must be a valid URL (https://host/owner/repo.git).",
      },
      { status: 400 },
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return Response.json(
      {
        error: "remote_url invalid",
        field: "remote_url",
        message: "remote_url must use http:// or https://; SSH remotes need a different flow.",
      },
      { status: 400 },
    );
  }

  // Preflight: the validation probe (`git ls-remote`) and every later push
  // shell `git`. On a git-less server, surface the friendly, actionable
  // 503 instead of letting the probe's `Bun.spawn` throw a raw
  // "Executable not found in $PATH: \"git\"".
  try {
    ensureGitAvailable();
  } catch (err) {
    if (err instanceof GitNotInstalledError) {
      return Response.json(
        {
          error: "git not installed",
          error_type: "git_not_installed",
          message: err.message,
        },
        { status: 503 },
      );
    }
    throw err;
  }

  // Validate via `git ls-remote <embedded-auth-url>` — uses the same
  // x-access-token shape we'd embed at push time so the probe exercises
  // the actual auth path. If the operator pasted a URL that already has
  // userinfo, use it verbatim; otherwise embed token via x-access-token.
  const authedUrl =
    parsed.username || parsed.password
      ? remote_url
      : (() => {
          const u = new URL(remote_url);
          u.username = "x-access-token";
          u.password = token;
          return u.toString();
        })();
  const probeResult = await (probeOverride ?? probeGitLsRemote)(authedUrl, 10_000);
  if (!probeResult.ok) {
    return Response.json(
      {
        error: "Probe failed",
        message: `git ls-remote could not reach ${parsed.host}: ${probeResult.error}`,
      },
      { status: 400 },
    );
  }

  // Save the userinfo'd URL — that's what gets embedded as `origin` so
  // bare `git push` works without needing GIT_ASKPASS etc. Per-vault
  // (vault#399): the PAT + remote_url land in this vault's own file, not a
  // server-wide one — so configuring vault B never reuses vault A's remote.
  const vaultName = manager.getVaultName();
  const next: MirrorCredentials = {
    ...(readCredentials(vaultName) ?? emptyCredentials()),
    active_method: "pat",
    pat: {
      token,
      remote_url: authedUrl,
      label,
    },
  };
  try {
    writeCredentials(vaultName, next);
  } catch (err) {
    return Response.json(
      {
        error: "Credentials write failed",
        message: (err as Error).message ?? String(err),
      },
      { status: 500 },
    );
  }

  // vault#483: linking implies backup intent — enable history for a
  // never-configured vault BEFORE the Cut-3/Cut-6 steps below, so a fresh
  // vault gets the whole intended flow in one save: history on (the reload's
  // start() applies the just-written PAT remote to `origin`), then Cut 3
  // sees an enabled mirror and flips auto_push on, then Cut 6 fires the
  // initial push. An explicitly-disabled mirror short-circuits all of it
  // (history stays off → maybeEnableAutoPush no-ops on disabled).
  const history_enabled = await maybeEnableHistoryOnLink(manager);

  // Push the new URL onto the mirror's git remote if it's currently
  // resolved + on disk. Non-fatal if the mirror isn't running.
  await applyCredentialsToMirror(manager);

  // Cut 3: auto-enable auto_push when credentials save. Operator wiring
  // credentials almost certainly wants pushes to fire — silent
  // "credentials saved but pushes never happen" is the bug Aaron hit.
  // If `auto_push` was already true, leave it alone (idempotent).
  const autoPushChange = await maybeEnableAutoPush(manager);

  // Cut 6: kick off an initial push-now so the operator sees the push
  // happen immediately rather than waiting for the next write event.
  // Only when (a) auto_push ended up true AND (b) there are local commits
  // ahead of the (now-configured) remote.
  const initialPush = await maybeFireInitialPush(manager, autoPushChange.auto_push_now_enabled);

  return Response.json(
    {
      ...sanitizeCredentials(next),
      history_enabled,
      auto_push_was_already_enabled: autoPushChange.was_already_enabled,
      auto_push_enabled: autoPushChange.auto_push_now_enabled,
      initial_push: initialPush,
    },
    {
      headers: { "Access-Control-Allow-Origin": "*" },
    },
  );
}

/**
 * Run `git ls-remote <url>` with a hard timeout, no interactive prompts.
 *
 * Threat-model note (reviewer-flagged on vault#384):
 *   The URL passed here contains the user's token in userinfo position
 *   (`https://x-access-token:<TOKEN>@host/repo.git`). On Linux that means
 *   the token sits in `/proc/<pid>/cmdline` for the ~10s probe window,
 *   readable by any process running as another UID with default perms.
 *   For vault's threat model (owner-operated, single-user self-host) this
 *   is acceptable — anyone with shell on the box already has read access
 *   to `~/.parachute/vault/.mirror-credentials.yaml` (0600) and
 *   `<mirror>/.git/config` (0644). Same posture as `~/.git-credentials`
 *   and `~/.netrc`. If we ever ship multi-tenant vault (cloud Tier 2)
 *   this needs to switch to env-based auth via a credential helper script
 *   so the token never enters argv.
 */
async function probeGitLsRemote(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  // GIT_TERMINAL_PROMPT=0 ensures bad credentials FAIL FAST instead of
  // sitting at "Username:" indefinitely (which the timeout would then
  // catch, but failing fast on the auth wall is the better UX).
  const proc = Bun.spawn(["git", "ls-remote", url], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      // Also kill any system credential helper from intercepting — we
      // want the probe to use ONLY the URL-embedded credential, not
      // whatever's in keychain.
      GIT_ASKPASS: "/bin/echo",
    },
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (exitCode === 0) return { ok: true };
  const stderr = new TextDecoder()
    .decode(await new Response(proc.stderr).arrayBuffer())
    .trim();
  // Redact userinfo from anything we surface back; git's error messages
  // sometimes echo the URL.
  const redacted = stderr.replace(/https?:\/\/[^@\s]+@/g, "https://***@");
  return { ok: false, error: redacted };
}

/**
 * `GET /.parachute/mirror/auth` — connection status (no secrets). Reads the
 * mirror-owning vault's per-vault credentials (vault#399).
 */
export function handleAuthGet(manager: MirrorManager): Response {
  const creds = readCredentials(manager.getVaultName());
  return Response.json(sanitizeCredentials(creds), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

/**
 * `DELETE /.parachute/mirror/auth` — wipe credentials, clear the embedded
 * remote URL on the mirror dir.
 */
export async function handleAuthDelete(manager: MirrorManager): Promise<Response> {
  deleteCredentials(manager.getVaultName());
  // Strip origin from the mirror dir if one is set.
  const status = manager.getStatus();
  if (status.mirror_path) {
    try {
      await unsetGitRemote(status.mirror_path);
    } catch (err) {
      console.warn(
        `[mirror-auth] failed to unset git remote (non-fatal): ${(err as Error).message ?? err}`,
      );
    }
  }
  return Response.json(sanitizeCredentials(null), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

/**
 * `GET /.parachute/mirror/auth/github/installations` — install state for
 * the connect flow (vault#480). Answers three UI questions in one call:
 * which app is in play (shared default vs BYO), is it installed ANYWHERE
 * for this operator, and which accounts (user/orgs) carry installations.
 *
 * Deliberately a separate, explicitly-network endpoint: `GET /auth` stays
 * a pure local read of the stored credential. The SPA calls this when it
 * renders the connect flow / repo picker, not on every status poll.
 *
 * Response:
 *   200 {
 *     app: { client_id, slug, is_shared_default },
 *     installed: boolean,            // installations.length > 0
 *     install_url: string,           // github.com/apps/<slug>/installations/new
 *     installations: [{ id, account_login, account_type, repository_selection }]
 *   }
 *   401 { error, error_type: "github_not_connected", message } — no stored
 *       github_oauth credential; the device flow hasn't been run (or a PAT
 *       is active instead — install state is a GitHub-App concept).
 *   502 { error, message } — GitHub unreachable / API error.
 */
export async function handleAuthGithubInstallations(
  manager: MirrorManager,
  fetchImpl?: FetchLike,
): Promise<Response> {
  const creds = readCredentials(manager.getVaultName());
  if (!creds || creds.active_method !== "github_oauth" || !creds.github_oauth) {
    return Response.json(
      {
        error: "Not connected to GitHub",
        error_type: "github_not_connected",
        message:
          "No GitHub sign-in is stored for this vault. Run the device flow first (POST /.parachute/mirror/auth/github/device-code).",
      },
      { status: 401 },
    );
  }
  const clientId = getGithubClientId();
  const slug = getGithubAppSlug();
  let installations;
  try {
    installations = await listInstallations(creds.github_oauth.access_token, fetchImpl);
  } catch (err) {
    return Response.json(
      {
        error: "Installation check failed",
        message: (err as Error).message ?? String(err),
      },
      { status: 502 },
    );
  }
  return Response.json(
    {
      app: {
        client_id: clientId,
        slug,
        is_shared_default:
          clientId === GITHUB_CLIENT_ID_DEFAULT && slug === GITHUB_APP_SLUG_DEFAULT,
      },
      installed: installations.length > 0,
      install_url: installUrlForSlug(slug),
      installations: installations.map((i) => ({
        id: i.id,
        account_login: i.account.login,
        account_type: i.account.type,
        repository_selection: i.repository_selection,
      })),
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * `GET /.parachute/mirror/auth/github/repos` — list the repos the
 * operator's app installations grant, via the stored OAuth token. Requires
 * `active_method === "github_oauth"`.
 *
 * Source (vault#480): `GET /user/installations` → per-installation
 * `GET /user/installations/{id}/repositories`, unioned. This replaces the
 * old `GET /user/repos?type=owner` source, which (a) excluded org-owned
 * repos by construction and (b) showed all-public-repos when the app wasn't
 * installed at all (every GitHub App reads public repos) — Aaron walked
 * into exactly that "looks connected, shows the wrong repos" state live.
 *
 * Response:
 *   200 installed:    { installed: true, repos: [{ ...GitHubRepoInfo,
 *                       account_login, installation_id }], truncated }
 *   200 not installed: { installed: false, install_url, repos: [],
 *                       truncated: false } — machine-readable
 *                       authorized-but-not-installed state; the UI shows
 *                       the guided-install step, no string-matching needed.
 *   400 { error, message } — no github_oauth credential stored.
 *   502 { error, message } — GitHub unreachable / API error.
 */
export async function handleAuthGithubRepos(
  manager: MirrorManager,
  fetchImpl?: FetchLike,
): Promise<Response> {
  const creds = readCredentials(manager.getVaultName());
  if (!creds || creds.active_method !== "github_oauth" || !creds.github_oauth) {
    return Response.json(
      {
        error: "Not connected to GitHub",
        message: "Run the device flow first (POST /.parachute/mirror/auth/github/device-code).",
      },
      { status: 400 },
    );
  }
  const token = creds.github_oauth.access_token;
  let installations;
  try {
    installations = await listInstallations(token, fetchImpl);
  } catch (err) {
    return Response.json(
      {
        error: "Repo list failed",
        message: (err as Error).message ?? String(err),
      },
      { status: 502 },
    );
  }

  if (installations.length === 0) {
    // Authorized but not installed — the device-flow grant alone reaches no
    // repos. Distinct, machine-readable state (NOT an empty repo list that
    // looks like "you have no repos").
    return Response.json(
      {
        installed: false,
        install_url: installUrlForSlug(getGithubAppSlug()),
        repos: [],
        truncated: false,
      },
      { headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  const repos: Array<GitHubRepoInfo & { account_login: string; installation_id: number }> = [];
  let truncated = false;
  try {
    for (const installation of installations) {
      const result = await listInstallationRepos(token, installation.id, {}, fetchImpl);
      for (const repo of result.repos) {
        repos.push({
          ...repo,
          account_login: installation.account.login,
          installation_id: installation.id,
        });
      }
      if (result.truncated) truncated = true;
    }
  } catch (err) {
    return Response.json(
      {
        error: "Repo list failed",
        message: (err as Error).message ?? String(err),
      },
      { status: 502 },
    );
  }
  return Response.json(
    { installed: true, repos, truncated },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * `POST /.parachute/mirror/auth/github/create-repo` — create a new repo on
 * the operator's account, return the new RepoInfo. The SPA flows straight
 * from this into the "repo selected" state.
 *
 * With the shared Parachute app this 403s by design (vault#480):
 * `POST /user/repos` needs Administration:write; the shared app is frozen
 * at Contents-only. The 403 maps to error_type "app_lacks_admin_permission"
 * with the guided-manual path (create at github.com/new → add it to the
 * installation → refresh the picker). The endpoint stays functional for
 * BYO-app operators whose app grants Administration:write — and per the
 * install docs, app-created repos auto-join the installation, so their
 * create→push flow works end-to-end.
 */
export async function handleAuthGithubCreateRepo(
  req: Request,
  manager: MirrorManager,
  fetchImpl?: FetchLike,
): Promise<Response> {
  const creds = readCredentials(manager.getVaultName());
  if (!creds || creds.active_method !== "github_oauth" || !creds.github_oauth) {
    return Response.json(
      {
        error: "Not connected to GitHub",
        message: "Run the device flow first.",
      },
      { status: 400 },
    );
  }
  let body: { name?: unknown; description?: unknown; private?: unknown };
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch (err) {
    return Response.json(
      { error: "Invalid JSON body", message: (err as Error).message ?? String(err) },
      { status: 400 },
    );
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0) {
    return Response.json(
      { error: "name required", field: "name", message: "Provide a repo name." },
      { status: 400 },
    );
  }
  const isPrivate = body.private === false ? false : true; // default true
  const description = typeof body.description === "string" ? body.description : undefined;
  let repo: GitHubRepoInfo;
  try {
    repo = await createRepo(
      creds.github_oauth.access_token,
      { name, description, private: isPrivate },
      fetchImpl,
    );
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 403) {
      // Expected with the shared Contents-only app: POST /user/repos needs
      // Administration:write. Actionable, machine-readable mapping — the UI
      // renders the guided-manual checklist off error_type, not a string.
      return Response.json(
        {
          error: "Create not permitted for this GitHub App",
          error_type: "app_lacks_admin_permission",
          message:
            "The Parachute GitHub App can't create repositories (it only has Contents permission — creating repos needs Administration). Create it manually instead: 1) create a private, uninitialized repo at github.com/new, 2) add it to the app installation (GitHub → Settings → Applications → Configure), 3) refresh the repo list here and pick it.",
        },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "Create failed", message: (err as Error).message ?? String(err) },
      { status: 502 },
    );
  }
  return Response.json(repo, { headers: { "Access-Control-Allow-Origin": "*" } });
}

/**
 * `POST /.parachute/mirror/auth/github/select-repo` — operator picked a
 * repo from the list (or just created one). Body `{owner, name}`. Writes
 * the embedded-credential URL onto the mirror dir's `origin`.
 */
export async function handleAuthGithubSelectRepo(
  req: Request,
  manager: MirrorManager,
): Promise<Response> {
  const creds = readCredentials(manager.getVaultName());
  if (!creds || creds.active_method !== "github_oauth" || !creds.github_oauth) {
    return Response.json(
      {
        error: "Not connected to GitHub",
        message: "Run the device flow first.",
      },
      { status: 400 },
    );
  }
  let body: { owner?: unknown; name?: unknown };
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch (err) {
    return Response.json(
      { error: "Invalid JSON body", message: (err as Error).message ?? String(err) },
      { status: 400 },
    );
  }
  const owner = typeof body.owner === "string" ? body.owner.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!owner || !name) {
    return Response.json(
      {
        error: "owner and name required",
        message: "Provide both `owner` and `name` for the repo to push to.",
      },
      { status: 400 },
    );
  }
  // Reach into mirror-credentials.ts for the authed URL builder.
  const { githubAuthedRemoteUrl } = await import("./mirror-credentials.ts");
  const authedUrl = githubAuthedRemoteUrl(
    creds.github_oauth.access_token,
    owner,
    name,
  );

  // Apply to the mirror dir if running. If the mirror isn't running (no
  // mirror_path), we still consider this a success — the credentials are
  // stored, and the URL will get applied next time the mirror starts.
  const status = manager.getStatus();
  let applied = false;
  if (status.mirror_path) {
    const res = await applyToGitRemote(status.mirror_path, authedUrl);
    if (!res.ok) {
      return Response.json(
        {
          error: "Failed to set remote URL on mirror",
          message: res.error,
        },
        { status: 500 },
      );
    }
    applied = true;
  }
  // Cut 3 / Cut 6: auto-enable auto_push + fire initial push if there's
  // anything to push. Same logic as handleAuthPat — operator picking a
  // repo wants the push to fire.
  const autoPushChange = await maybeEnableAutoPush(manager);
  const initialPush = await maybeFireInitialPush(manager, autoPushChange.auto_push_now_enabled);

  return Response.json(
    {
      ok: true,
      applied,
      owner,
      name,
      // Echo the redacted form back so the SPA can show "pushing to <repo>".
      // No raw token in the response.
      remote: `https://github.com/${owner}/${name}.git`,
      auto_push_was_already_enabled: autoPushChange.was_already_enabled,
      auto_push_enabled: autoPushChange.auto_push_now_enabled,
      initial_push: initialPush,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * vault#483 fix 1 — linking implies backup intent. Outcome flag for the
 * credential-save responses:
 *   - `true` — history (the mirror) is on: either this link just enabled it
 *     (never-configured vault) or it was already enabled.
 *   - `"left_disabled"` — a mirror config exists with `enabled: false`; we
 *     refuse to silently flip an explicit operator choice. The UI should
 *     offer the one-click "Turn on history now?" enable.
 *   - `false` — we tried to enable history but the mirror didn't come up
 *     (e.g. git missing). Config intent is persisted (PUT semantics); the
 *     mirror status carries the actionable error.
 */
export type HistoryOnLink = true | false | "left_disabled";

/**
 * When a GitHub credential lands (device-flow grant or PAT save), turn
 * history on for a vault that has NEVER had a mirror configured — nobody
 * links GitHub to a vault for any reason other than backing it up. Aaron hit
 * this live (vault#483): pre-#440 vaults have no mirror-config file, so
 * linking stored a credential and then... nothing, with the only path out
 * buried in advanced settings.
 *
 * Consent-respecting by design:
 *   - **No config file** (never configured) → enable the internal mirror
 *     with the standard defaults (enabled, internal, events, auto_commit on,
 *     auto_push off — the same shape #440 gives new vaults). Writes through
 *     `manager.reload()` — the exact path the PUT handler uses — so persist +
 *     lifecycle-start stay one code path.
 *   - **Config file exists with enabled:false** → explicit operator choice;
 *     do NOT flip it. Return `"left_disabled"` so the UI can offer one-click
 *     enable instead.
 *   - **Config file exists with enabled:true** → nothing to do.
 *
 * The file-existence check (not just the parsed read) is the load-bearing
 * distinction: an existing-but-malformed file parses to `undefined`, same as
 * absent — but it still represents operator-touched state, so we treat it as
 * "exists, not known-enabled" and leave it alone.
 */
async function maybeEnableHistoryOnLink(
  manager: MirrorManager,
): Promise<HistoryOnLink> {
  const vaultName = manager.getVaultName();
  if (!existsSync(mirrorConfigPath(vaultName))) {
    try {
      const status = await manager.reload({
        ...defaultMirrorConfig(),
        enabled: true,
      });
      if (!status.enabled) {
        console.warn(
          `[mirror-auth] history-on-link: enabled the mirror config for vault "${vaultName}" but it didn't start: ${status.last_error ?? "unknown error"}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      console.warn(
        `[mirror-auth] history-on-link: could not enable the mirror for vault "${vaultName}" (non-fatal): ${(err as Error).message ?? err}`,
      );
      return false;
    }
  }
  const persisted = readMirrorConfigForVault(vaultName);
  if (persisted?.enabled) return true;
  return "left_disabled";
}

/**
 * Cut 3: when credentials save, flip `auto_push` from false → true on
 * the persisted config. Operators wiring credentials almost certainly
 * want pushes to fire — silent "credentials saved but no push" was the
 * three-stacking-gaps bug Aaron hit.
 *
 * Idempotent: if `auto_push` was already true, no config write happens.
 * If `auto_push` is false, write the flipped config via `manager.reload`
 * — that restarts the lifecycle and applies the credentials to the
 * remote in the same pass.
 *
 * Returns a small struct so the route handler can shape the response:
 *   - `was_already_enabled` — true iff auto_push was true before this call.
 *   - `auto_push_now_enabled` — true iff auto_push is true after this call.
 *
 * Both being false means the operator deliberately left auto_push off
 * and we leave it that way (we never touch a config whose mirror is
 * disabled, and we never flip true → false).
 */
async function maybeEnableAutoPush(
  manager: MirrorManager,
): Promise<{ was_already_enabled: boolean; auto_push_now_enabled: boolean }> {
  const config = manager.getConfig();
  // Don't muck with auto_push when the mirror is disabled — the operator
  // is configuring credentials before turning the mirror on, which is a
  // legitimate sequence. They'll flip enabled themselves.
  if (!config.enabled) {
    return {
      was_already_enabled: config.auto_push,
      auto_push_now_enabled: config.auto_push,
    };
  }
  if (config.auto_push) {
    return { was_already_enabled: true, auto_push_now_enabled: true };
  }
  try {
    await manager.reload({ ...config, auto_push: true });
    return { was_already_enabled: false, auto_push_now_enabled: true };
  } catch (err) {
    console.warn(
      `[mirror-auth] could not auto-enable auto_push (non-fatal): ${(err as Error).message ?? err}`,
    );
    return { was_already_enabled: false, auto_push_now_enabled: false };
  }
}

/**
 * Cut 6: after credential save, fire a `push-now` immediately so the
 * operator sees the push happen rather than waiting for the next write
 * event. Only when (a) auto_push is enabled (we just turned it on, or it
 * was already on) AND (b) there are local commits to push.
 *
 * Best-effort: non-fatal on any failure. Returns a struct the caller
 * folds into its response.
 */
async function maybeFireInitialPush(
  manager: MirrorManager,
  autoPushEnabled: boolean,
): Promise<
  | { fired: false; reason: "auto_push_disabled" | "no_mirror_path" | "manager_skipped" | "not_enabled" }
  | { fired: true; pushed: boolean; error?: string; sha?: string }
> {
  if (!autoPushEnabled) return { fired: false, reason: "auto_push_disabled" };
  const status = manager.getStatus();
  if (!status.mirror_path) return { fired: false, reason: "no_mirror_path" };
  // Need an active enabled mirror with a resolved path to push from.
  if (!status.enabled) return { fired: false, reason: "manager_skipped" };
  try {
    const result = await manager.pushNow();
    return result;
  } catch (err) {
    // Defense-in-depth: every other push-error site routes through
    // `redactToken` before surfacing — this catch-block was the one
    // outlier where a thrown error's `.message` could carry an
    // un-redacted token from a future code path that throws before the
    // existing internal redaction runs. Apply the same scrub here.
    // Reviewer-flagged on vault#392.
    const rawMessage = (err as Error).message ?? String(err);
    const safeMessage = redactToken(rawMessage);
    console.warn(`[mirror-auth] initial push-now failed (non-fatal): ${safeMessage}`);
    return { fired: true, pushed: false, error: safeMessage };
  }
}

/**
 * Apply the active credential's remote URL to the running mirror dir.
 * Idempotent. Called from auth/pat (after store) + auth/github/select-repo
 * (after store). Non-fatal on failure — the credentials are saved either
 * way; the next mirror restart picks them up.
 */
export async function applyCredentialsToMirror(
  manager: MirrorManager,
): Promise<void> {
  const status = manager.getStatus();
  if (!status.mirror_path) return;
  const creds = readCredentials(manager.getVaultName());
  if (!creds || !creds.active_method) {
    await unsetGitRemote(status.mirror_path);
    return;
  }
  if (creds.active_method === "pat" && creds.pat) {
    await applyToGitRemote(status.mirror_path, creds.pat.remote_url);
    return;
  }
  // GitHub OAuth — needs the operator to have picked a repo; the URL
  // wiring happens in handleAuthGithubSelectRepo. Nothing to apply here
  // until a repo is selected. Caller is responsible for invoking
  // select-repo separately.
}

// ---------------------------------------------------------------------------
// Import-from-git route — symmetric counterpart to the mirror export work.
//
// `POST /vault/<name>/.parachute/mirror/import` — clone a vault export from
// a git remote and import it into the named vault.
//
// Request body:
//   {
//     "remote_url": "https://github.com/aaron/my-vault.git",
//     "mode": "merge" | "replace",
//     "credentials": null
//       | { "kind": "pat", "token": "ghp_..." }
//       | { "kind": "none" },
//     "enable_sync": true   // optional, DEFAULT TRUE
//   }
//
// `credentials: null` means "use the stored mirror credentials." Passing
// `{kind: "pat", token}` is the one-shot path — token doesn't get persisted
// for the CLONE, but IS persisted when sync is enabled (it's the push
// credential for the now-configured mirror).
//
// `enable_sync` (vault#416) — DEFAULT TRUE when omitted. After a successful
// import, auto-enable mirror push-back to the SAME repo, reusing the import's
// credentials. Makes "import a repo" and "back up to that repo going forward"
// one fluid flow. The UI ships a checked-by-default checkbox the operator can
// uncheck. Edge cases (handled in `enableSyncToImportedRepo`, never fail the
// whole import):
//   - `auth: none` (public repo, no push creds) → skip + warn (can't push
//     without a credential).
//   - A mirror already points at a DIFFERENT remote → skip + warn (don't
//     clobber the operator's existing backup target).
//   - A mirror already points at the SAME remote → no-op success.
//   - Sync setup throws → import result still returned (success);
//     `sync_enabled: false` + a warning. Import success is never lost.
//
// Response:
//   200 { notes_imported, tags_imported, attachments_imported,
//         notes_deleted?, warnings, sync_enabled, sync_warning? }
//   400 { error, error_type, message }  — validation / not-a-vault-export
//   409 { error, error_type, message }  — concurrent import for this vault
//   502 { error, message }              — clone failed (auth, network, …)
//
// Admin-gated upstream in routing.ts.
// ---------------------------------------------------------------------------

/**
 * `POST /vault/<name>/.parachute/mirror/import`. See block comment above.
 *
 * Synchronous response: imports complete in <30s for typical vaults
 * (a 1k-note vault clones+imports in well under that bound on Aaron's hardware).
 * If/when bigger vaults arrive we promote to async polling — for now the
 * synchronous path keeps the UI flow simple.
 *
 * `spawnOverride` is a test seam: lets the test inject a fake git binary.
 * Production callers omit it; `cloneAndImport` falls back to `defaultGitSpawn`.
 *
 * `whichOverride` is a test seam for the git-presence preflight (default
 * `Bun.which` inside `cloneAndImport`). Inject a fn returning `null` to
 * exercise the git_not_installed 503 path without uninstalling git.
 *
 * `managerOverride` is a test seam for the post-import sync-enable step
 * (vault#416). Production callers omit it; the route resolves the per-vault
 * manager via `getMirrorManager(vaultName)` (same registry the auth /
 * run-now / push-now routes use). Tests inject a manager so they can assert
 * on the config it ends up with without standing up the full registry.
 */
export async function handleMirrorImport(
  req: Request,
  vaultName: string,
  spawnOverride?: GitSpawn,
  whichOverride?: (cmd: string) => string | null,
  managerOverride?: MirrorManager,
): Promise<Response> {
  let body: {
    remote_url?: unknown;
    mode?: unknown;
    credentials?: unknown;
    enable_sync?: unknown;
  };
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch (err) {
    return Response.json(
      {
        error: "Invalid JSON body",
        error_type: "invalid_json",
        message: (err as Error).message ?? String(err),
      },
      { status: 400 },
    );
  }

  const remote_url =
    typeof body.remote_url === "string" ? body.remote_url.trim() : "";
  if (remote_url.length === 0) {
    return Response.json(
      {
        error: "remote_url required",
        error_type: "validation",
        field: "remote_url",
        message: "Provide an HTTPS or SSH clone URL.",
      },
      { status: 400 },
    );
  }
  const mode = body.mode;
  if (mode !== "merge" && mode !== "replace") {
    return Response.json(
      {
        error: "mode invalid",
        error_type: "validation",
        field: "mode",
        message: 'mode must be "merge" or "replace".',
      },
      { status: 400 },
    );
  }

  // Resolve auth shape. The wire format mirrors the internal ImportAuth
  // type, but tightened: only `kind` and `token` cross the wire. `none`
  // and `null` both fall through to "use stored credentials" because the
  // common case is "I configured mirror creds; use them" — and the
  // shorthand keeps the SPA from having to track which kind to send.
  let auth: ImportAuth;
  const creds = body.credentials;
  if (creds === null || creds === undefined) {
    auth = { kind: "credentialsFile" };
  } else if (typeof creds === "object") {
    const credsObj = creds as Record<string, unknown>;
    if (credsObj.kind === "pat") {
      const token = typeof credsObj.token === "string" ? credsObj.token.trim() : "";
      if (token.length === 0) {
        return Response.json(
          {
            error: "credentials.token required",
            error_type: "validation",
            field: "credentials.token",
            message: 'When credentials.kind is "pat", credentials.token must be a non-empty string.',
          },
          { status: 400 },
        );
      }
      auth = { kind: "pat", token };
    } else if (credsObj.kind === "none") {
      auth = { kind: "none" };
    } else if (credsObj.kind === "credentialsFile") {
      auth = { kind: "credentialsFile" };
    } else {
      return Response.json(
        {
          error: "credentials.kind invalid",
          error_type: "validation",
          field: "credentials.kind",
          message: 'credentials.kind must be "pat", "credentialsFile", or "none". Or pass credentials: null.',
        },
        { status: 400 },
      );
    }
  } else {
    return Response.json(
      {
        error: "credentials invalid",
        error_type: "validation",
        field: "credentials",
        message: "credentials must be an object or null.",
      },
      { status: 400 },
    );
  }

  // vault#416: `enable_sync` defaults TRUE when omitted — the default-on UX.
  // Only a literal `false` opts out; any other type is a validation error so
  // a malformed body never silently flips the default.
  let enableSync = true;
  if ("enable_sync" in body && body.enable_sync !== undefined) {
    if (typeof body.enable_sync !== "boolean") {
      return Response.json(
        {
          error: "enable_sync invalid",
          error_type: "validation",
          field: "enable_sync",
          message: "enable_sync must be a boolean (defaults to true when omitted).",
        },
        { status: 400 },
      );
    }
    enableSync = body.enable_sync;
  }

  // Resolve the target vault's store + assets dir. The route is gated on
  // `vault:<name>:admin`, so we trust vaultName is real by the time we
  // reach this code path; defensively re-resolve in case the vault was
  // deleted between auth and now.
  const store = getVaultStore(vaultName);
  const assets = assetsDir(vaultName);

  let result: ImportResult;
  try {
    result = await cloneAndImport({
      vaultName,
      remoteUrl: remote_url,
      auth,
      mode,
      store,
      assetsDir: assets,
      spawn: spawnOverride,
      which: whichOverride,
    });
  } catch (err) {
    if (err instanceof GitNotInstalledError) {
      // 503 Service Unavailable — the server isn't configured to do this
      // yet (git missing). The message tells the operator how to fix it.
      return Response.json(
        {
          error: "git not installed",
          error_type: "git_not_installed",
          message: err.message,
        },
        { status: 503 },
      );
    }
    if (err instanceof ImportConflictError) {
      return Response.json(
        {
          error: "Import already running",
          error_type: "concurrent_import",
          message: err.message,
        },
        { status: 409 },
      );
    }
    if (err instanceof NotAVaultExportError) {
      return Response.json(
        {
          error: "Not a vault export",
          error_type: "not_a_vault_export",
          message: err.message,
        },
        { status: 400 },
      );
    }
    if (err instanceof CloneFailedError) {
      return Response.json(
        {
          error: "Clone failed",
          error_type: "clone_failed",
          message: err.message,
        },
        { status: 502 },
      );
    }
    return Response.json(
      {
        error: "Import failed",
        error_type: "internal",
        message: (err as Error).message ?? String(err),
      },
      { status: 500 },
    );
  }

  // ---- vault#416: auto-enable sync to the imported repo (default-on) -------
  //
  // The import SUCCEEDED above. From here on, every failure is non-fatal —
  // we never lose a successful import to a sync-setup error. `result` already
  // carries `sync_enabled: false` (set by importResultFromStats); we flip it
  // true only when sync is actually wired (or already wired to this remote).
  if (enableSync) {
    try {
      const manager =
        managerOverride ?? getMirrorManager(vaultName) ?? undefined;
      const outcome = await enableSyncToImportedRepo({
        vaultName,
        remoteUrl: remote_url,
        auth,
        manager,
      });
      result.sync_enabled = outcome.sync_enabled;
      if (outcome.warning) result.sync_warning = outcome.warning;
    } catch (err) {
      // Defense-in-depth: enableSyncToImportedRepo is written to not throw
      // (it catches its own write/credential/reload errors), but a future
      // edit or an unexpected throw must NOT take down a successful import.
      const msg = redactToken((err as Error).message ?? String(err));
      console.warn(
        `[mirror-import] sync-enable threw after a successful import (non-fatal): ${msg}`,
      );
      result.sync_enabled = false;
      result.sync_warning =
        "Import succeeded, but enabling Sync failed. Set up Sync separately from the Git remote section.";
    }
  }

  return Response.json(result, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

// ---------------------------------------------------------------------------
// vault#416 — sync-enable after a successful import.
// ---------------------------------------------------------------------------

/**
 * After a successful import, turn the imported-from repo into a configured,
 * credential-backed, auto-pushing mirror — reusing the import's credentials.
 * This is the back half of the default-on "import → also sync back" flow.
 *
 * Reuses the SAME machinery the manual mirror-setup flow uses:
 *   - `writeCredentials` to persist the push credential (per-vault, vault#399).
 *   - `MirrorConfig` + `manager.reload()` to enable `auto_push` and restart
 *     the lifecycle — which calls `applyCredentialsToRemote` to set `origin`
 *     from the stored credentials (exactly like handleAuthPat /
 *     handleAuthGithubSelectRepo do).
 *
 * Mirror location is left `internal` (vault-managed dir under the vault's
 * data dir) — the import didn't ask the operator to pick an external path,
 * and `auto_push + internal + credentials` is the supported "push to a
 * GitHub/GitLab remote" shape (see mirror-config.ts validation note). The
 * remote lives in credentials, not the config; that's why we persist
 * credentials AND flip auto_push.
 *
 * Never throws — every failure path returns `{ sync_enabled: false, warning }`.
 * The import already succeeded by the time this runs; a sync-setup error must
 * not be surfaced as an import failure.
 *
 * Edge cases (returns `sync_enabled: false` + a warning, no broken mirror
 * left behind):
 *   - **No push-capable credential** — `auth: none`, OR `credentialsFile`
 *     with no stored credential that covers this remote's host. Can't push
 *     without a credential; skip rather than configure a mirror that would
 *     just fail every push.
 *   - **A mirror already targets a DIFFERENT remote** — don't clobber the
 *     operator's existing backup target. Detected by comparing the existing
 *     stored credential's remote host/path against the import remote.
 *   - **A mirror already targets the SAME remote** — no-op success.
 */
export async function enableSyncToImportedRepo(opts: {
  vaultName: string;
  remoteUrl: string;
  auth: ImportAuth;
  /**
   * The per-vault mirror manager. Undefined only in the boot-race window
   * where the registry factory hasn't been installed; we then skip (warn)
   * rather than persisting a half-configured mirror with no live manager.
   */
  manager: MirrorManager | undefined;
}): Promise<{ sync_enabled: boolean; warning?: string }> {
  const { vaultName, remoteUrl, auth, manager } = opts;

  if (!manager) {
    return {
      sync_enabled: false,
      warning:
        "Sync not enabled — the vault's mirror manager wasn't ready. Set up Sync from the Git remote section.",
    };
  }

  // --- Resolve the push credential we'll persist for this remote. ----------
  // We need a credential that can PUSH to `remoteUrl`. The clone-time auth
  // shapes map onto push credentials as follows:
  //   - pat            → persist the supplied PAT against this remote.
  //   - none           → no push credential; cannot enable a working sync.
  //   - credentialsFile → reuse the already-stored credential, but only if it
  //                       actually covers this remote's host (a stored PAT for
  //                       a different host can't push here).
  let credentialToWrite: MirrorCredentials | null = null;

  if (auth.kind === "none") {
    return {
      sync_enabled: false,
      warning:
        "Sync not enabled — pushing changes back needs write credentials (a PAT or GitHub sign-in). Set up Sync separately to enable it.",
    };
  }

  if (auth.kind === "pat") {
    // Persist the supplied PAT against this remote — the same x-access-token
    // embedding the manual PAT route stores, so bare `git push` works.
    const embedded = embedTokenInRemoteUrl(remoteUrl, auth.token);
    if (!embedded) {
      return {
        sync_enabled: false,
        warning:
          "Sync not enabled — the remote URL couldn't be parsed to embed the access token. Set up Sync separately from the Git remote section.",
      };
    }
    credentialToWrite = {
      ...(readCredentials(vaultName) ?? emptyCredentials()),
      active_method: "pat",
      pat: {
        token: auth.token,
        remote_url: embedded,
        label: "Imported-repo sync",
      },
    };
  }

  // For credentialsFile we DON'T overwrite — we reuse what's already stored,
  // but must verify it covers this remote (host match). Resolve the existing
  // credential's effective remote so the conflict check below has something
  // to compare against.
  const existing = readCredentials(vaultName);

  // --- Conflict / idempotency check against any already-configured mirror. --
  // The mirror's remote lives in credentials, not in MirrorConfig. Compare
  // the existing stored credential's remote against the import remote.
  const persistedConfig = readMirrorConfigForVault(vaultName);
  const mirrorAlreadyConfigured = !!persistedConfig && persistedConfig.enabled;
  const existingRemote = existing ? effectiveRemoteOf(existing) : null;

  if (mirrorAlreadyConfigured && existingRemote) {
    if (sameRemote(existingRemote, remoteUrl)) {
      // Same remote — make sure auto_push is on, then no-op success. We don't
      // need to rewrite credentials (credentialsFile) or can refresh the PAT
      // (pat path) — either way the mirror already points here.
      if (auth.kind === "pat" && credentialToWrite) {
        try {
          writeCredentials(vaultName, credentialToWrite);
        } catch (err) {
          return {
            sync_enabled: false,
            warning: `Import succeeded; mirror already targets this repo but the credential refresh failed: ${redactToken((err as Error).message ?? String(err))}`,
          };
        }
      }
      return await applyEnabledAutoPush(manager);
    }
    // Different remote — don't clobber the operator's existing backup target.
    return {
      sync_enabled: false,
      warning: `Sync not enabled — this vault already syncs to a different repo (${redactRemoteUrl(existingRemote)}). Leaving your existing backup target untouched. Change it from the Git remote section if you want to switch.`,
    };
  }

  // A mirror is already configured + enabled with an active credential, but we
  // couldn't read its remote to compare (github_oauth stores no owner/repo at
  // the credential level — its remote lives on the mirror dir's `origin`). To
  // avoid clobbering an existing GitHub-connected backup target by switching
  // `active_method` to a PAT, refuse unless the existing credential is OAuth
  // and this is the same GitHub host (then the manual select-repo flow already
  // points origin where it should; we treat that as "already set up — leave
  // it"). Conservative: don't auto-switch an existing connected mirror.
  if (
    mirrorAlreadyConfigured &&
    existing?.active_method === "github_oauth" &&
    existing.github_oauth
  ) {
    return {
      sync_enabled: false,
      warning:
        "Sync not enabled — this vault already syncs via a connected GitHub account. Leaving your existing backup target untouched. Switch it from the Git remote section if you want to point sync at this repo instead.",
    };
  }

  // --- No conflicting mirror. Wire it up. ----------------------------------
  if (auth.kind === "credentialsFile") {
    // Reuse the stored credential — but only if it can push to this remote.
    const covers = existing && existingRemote && sameRemote(existingRemote, remoteUrl);
    const hasOauthForGithub =
      existing?.active_method === "github_oauth" &&
      !!existing.github_oauth &&
      isGithubRemote(remoteUrl);
    if (!covers && !hasOauthForGithub) {
      return {
        sync_enabled: false,
        warning:
          "Sync not enabled — no saved credential can push to this repo. Connect GitHub or paste a Personal Access Token in the Git remote section to enable Sync.",
      };
    }
    if (existing?.active_method === "github_oauth" && hasOauthForGithub) {
      // OAuth path: persist origin via the github authed URL, same as the
      // select-repo flow. Parse owner/repo from the import remote.
      const ownerRepo = parseGithubOwnerRepo(remoteUrl);
      if (!ownerRepo) {
        return {
          sync_enabled: false,
          warning:
            "Sync not enabled — couldn't parse owner/repo from the GitHub URL. Pick the repo from the Git remote section to enable Sync.",
        };
      }
      const status = manager.getStatus();
      const authedUrl = githubAuthedRemoteUrl(
        existing.github_oauth!.access_token,
        ownerRepo.owner,
        ownerRepo.repo,
      );
      if (status.mirror_path) {
        await applyToGitRemote(status.mirror_path, authedUrl);
      }
      // Stash a PAT-shaped credential so a restart re-applies the right
      // origin without needing the operator to re-pick the repo. (The OAuth
      // token works through the same x-access-token shape.) This mirrors how
      // applyCredentialsToRemote refreshes github origins on restart.
      credentialToWrite = {
        ...existing,
        active_method: "github_oauth",
      };
    }
    // covers === true → existing PAT already targets this remote; nothing to
    // re-persist. Fall through to enabling auto_push.
  }

  if (credentialToWrite) {
    try {
      writeCredentials(vaultName, credentialToWrite);
    } catch (err) {
      return {
        sync_enabled: false,
        warning: `Import succeeded, but saving the sync credential failed: ${redactToken((err as Error).message ?? String(err))}. Set up Sync separately from the Git remote section.`,
      };
    }
  }

  return await applyEnabledAutoPush(manager);
}

/**
 * Flip the mirror config to `enabled: true, auto_push: true` (internal
 * location) and reload the manager — which applies the just-persisted
 * credentials to `origin` and starts the event-driven export loop. Returns
 * the sync outcome; reload failures are non-fatal (import already succeeded).
 */
async function applyEnabledAutoPush(
  manager: MirrorManager,
): Promise<{ sync_enabled: boolean; warning?: string }> {
  const current = manager.getEffectiveConfig();
  const next: MirrorConfig = {
    ...current,
    enabled: true,
    // Keep the operator's existing location if they'd set external; default
    // internal for the fresh case. Internal + credentials is the supported
    // "push to a hosted remote" shape.
    location: current.location,
    auto_push: true,
  };
  try {
    await manager.reload(next);
  } catch (err) {
    return {
      sync_enabled: false,
      warning: `Import succeeded, but enabling Sync failed: ${redactToken((err as Error).message ?? String(err))}. Set up Sync separately from the Git remote section.`,
    };
  }
  // reload → start sets status.enabled iff bootstrap succeeded. If bootstrap
  // failed (e.g. git-less host, though import would've 503'd earlier), surface
  // that rather than claiming sync is on.
  const status = manager.getStatus();
  if (!status.enabled) {
    return {
      sync_enabled: false,
      warning: status.last_error
        ? `Import succeeded, but the mirror couldn't start: ${redactToken(status.last_error)}`
        : "Import succeeded, but the mirror couldn't start. Check the Git remote section.",
    };
  }
  return { sync_enabled: true };
}

/**
 * Embed an x-access-token credential into an HTTPS remote URL, the same shape
 * the manual PAT route persists. Returns null when the URL can't be parsed or
 * isn't http(s) (SSH / local-path remotes can't carry a token in userinfo —
 * those rely on the operator's ssh-agent, so there's no push credential for
 * us to embed). When the URL already carries userinfo, trust it verbatim.
 */
function embedTokenInRemoteUrl(remoteUrl: string, token: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return remoteUrl;
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

/**
 * The remote a stored credential effectively pushes to:
 *   - pat → its `remote_url` (userinfo-embedded; comparison strips userinfo).
 *   - github_oauth → null here (no owner/repo stored at the credential level;
 *     the origin is set when a repo is picked). Callers treat null as "no
 *     known remote to conflict with."
 */
function effectiveRemoteOf(creds: MirrorCredentials): string | null {
  if (creds.active_method === "pat" && creds.pat) return creds.pat.remote_url;
  return null;
}

/**
 * Compare two remote URLs ignoring userinfo (embedded tokens) + a trailing
 * `.git` + a trailing slash, case-insensitively on host. "Same repo" for the
 * clobber check. Falls back to a trimmed string compare for non-URL remotes
 * (SSH shorthand, local paths).
 */
function sameRemote(a: string, b: string): boolean {
  const norm = (u: string): string => {
    try {
      const url = new URL(u);
      const host = url.host.toLowerCase();
      const path = url.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
      return `${url.protocol}//${host}${path}`;
    } catch {
      return u.trim().replace(/\.git$/, "").replace(/\/+$/, "");
    }
  };
  return norm(a) === norm(b);
}

/** True when a remote URL is on github.com (host-exact, case-insensitive). */
function isGithubRemote(remoteUrl: string): boolean {
  try {
    return new URL(remoteUrl).host.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

/** Parse `owner` + `repo` out of a github.com HTTPS URL. Null when it doesn't match. */
function parseGithubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:\/)?$/i);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}
