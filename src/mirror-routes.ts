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

import {
  defaultMirrorConfig,
  validateExternalPath,
  validateMirrorConfigShape,
  type MirrorConfig,
} from "./mirror-config.ts";
import type { MirrorManager } from "./mirror-manager.ts";
import {
  applyToGitRemote,
  deleteCredentials,
  emptyCredentials,
  readCredentials,
  sanitizeCredentials,
  unsetGitRemote,
  writeCredentials,
  type MirrorCredentials,
} from "./mirror-credentials.ts";
import {
  createRepo,
  fetchUser,
  getGithubClientId,
  isPlaceholderClientId,
  listRepos,
  pollForToken,
  requestDeviceCode,
  type FetchLike,
  type GitHubRepoInfo,
} from "./github-device-flow.ts";

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
  const config = manager.getConfig();
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

  const shape = validateMirrorConfigShape(body);
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
    const pathCheck = await validateExternalPath(config.external_path);
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
// Credential routes — Cut 3 of the UI-configurable push credentials work.
//
// Six surfaces, all `vault:<name>:admin`-gated upstream:
//
//   POST   /.parachute/mirror/auth/github/device-code  — start GitHub Device
//          Flow; returns { polling_id, user_code, verification_uri, expires_in,
//          interval }. The full device_code is kept server-side; the SPA polls
//          by polling_id (a short opaque token) so the device_code doesn't
//          land on the wire twice.
//   POST   /.parachute/mirror/auth/github/poll         — poll for token, body
//          { polling_id }. On `granted`: fetch user, save credentials, set
//          remote URL, return { state: "granted", user }. Other states
//          surface verbatim.
//   POST   /.parachute/mirror/auth/pat                 — validate + store a
//          PAT (token + remote_url + label). Validates via `git ls-remote`.
//   GET    /.parachute/mirror/auth                     — current connection
//          status (NO secrets). Returns the sanitized public shape.
//   DELETE /.parachute/mirror/auth                     — wipe credentials,
//          unset embedded-credential remote URL.
//   GET    /.parachute/mirror/auth/github/repos        — list operator's
//          GitHub repos via stored OAuth token.
//   POST   /.parachute/mirror/auth/github/create-repo  — create a new private
//          repo on behalf of the operator.
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
 * Errors out cleanly when the operator hasn't replaced the placeholder
 * client_id. The user-facing message explains the next step.
 */
function placeholderClientIdResponse(): Response {
  return Response.json(
    {
      error: "GitHub OAuth not configured",
      error_type: "placeholder_client_id",
      message:
        "This Parachute Vault build doesn't have a registered GitHub OAuth App client_id. Set the PARACHUTE_GITHUB_CLIENT_ID environment variable (see src/github-device-flow.ts for setup steps) or use the Personal Access Token path instead.",
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
    const existing = readCredentials() ?? emptyCredentials();
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
      writeCredentials(next);
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
    // Apply to git remote if mirror is currently running on an external
    // path that's a git repo. The credentials become active on next push;
    // the operator doesn't have to restart vault. We don't have an owner/
    // repo yet (the operator hasn't picked a repo) — that wiring happens
    // in the create-repo or repo-picked path. So at this point we just
    // store credentials; the URL gets set when the operator picks a repo.
    return Response.json(
      {
        state: "granted",
        user: {
          login: user.login,
          id: user.id,
          name: user.name,
          avatar_url: user.avatar_url,
        },
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
  const probeResult = await probeGitLsRemote(authedUrl, 10_000);
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
  // bare `git push` works without needing GIT_ASKPASS etc.
  const next: MirrorCredentials = {
    ...(readCredentials() ?? emptyCredentials()),
    active_method: "pat",
    pat: {
      token,
      remote_url: authedUrl,
      label,
    },
  };
  try {
    writeCredentials(next);
  } catch (err) {
    return Response.json(
      {
        error: "Credentials write failed",
        message: (err as Error).message ?? String(err),
      },
      { status: 500 },
    );
  }

  // Push the new URL onto the mirror's git remote if it's currently
  // resolved + on disk. Non-fatal if the mirror isn't running.
  await applyCredentialsToMirror(manager);

  return Response.json(sanitizeCredentials(next), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

/**
 * Run `git ls-remote <url>` with a hard timeout, no interactive prompts.
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
 * `GET /.parachute/mirror/auth` — connection status (no secrets).
 */
export function handleAuthGet(): Response {
  const creds = readCredentials();
  return Response.json(sanitizeCredentials(creds), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

/**
 * `DELETE /.parachute/mirror/auth` — wipe credentials, clear the embedded
 * remote URL on the mirror dir.
 */
export async function handleAuthDelete(manager: MirrorManager): Promise<Response> {
  deleteCredentials();
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
 * `GET /.parachute/mirror/auth/github/repos` — list operator's repos via
 * the stored OAuth token. Requires `active_method === "github_oauth"`.
 */
export async function handleAuthGithubRepos(
  fetchImpl?: FetchLike,
): Promise<Response> {
  const creds = readCredentials();
  if (!creds || creds.active_method !== "github_oauth" || !creds.github_oauth) {
    return Response.json(
      {
        error: "Not connected to GitHub",
        message: "Run the device flow first (POST /.parachute/mirror/auth/github/device-code).",
      },
      { status: 400 },
    );
  }
  let result;
  try {
    result = await listRepos(creds.github_oauth.access_token, {}, fetchImpl);
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
    { repos: result.repos, truncated: result.truncated },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * `POST /.parachute/mirror/auth/github/create-repo` — create a new repo on
 * the operator's account, return the new RepoInfo. The SPA flows straight
 * from this into the "repo selected" state.
 */
export async function handleAuthGithubCreateRepo(
  req: Request,
  fetchImpl?: FetchLike,
): Promise<Response> {
  const creds = readCredentials();
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
  const creds = readCredentials();
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
  return Response.json(
    {
      ok: true,
      applied,
      owner,
      name,
      // Echo the redacted form back so the SPA can show "pushing to <repo>".
      // No raw token in the response.
      remote: `https://github.com/${owner}/${name}.git`,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
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
  const creds = readCredentials();
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
