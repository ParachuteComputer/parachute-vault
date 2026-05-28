/**
 * GitHub OAuth Device Flow client + supporting API calls.
 *
 * Why Device Flow (not Web Flow): self-hosted vault origins are
 * unpredictable (localhost:1940, random Tailscale FQDN, custom domain). Web
 * Flow needs a pre-registered callback URL per OAuth app; Device Flow needs
 * only a public `client_id` and the operator authorizes by typing a code at
 * github.com/login/device from any device. Same UX as `gh auth login`.
 *
 * Spec: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 *
 * All HTTP calls accept an injectable `fetch` so tests can mock the wire
 * without spawning a real GitHub round-trip. Production wiring uses the
 * platform `fetch` (Bun's native).
 *
 * **GITHUB_CLIENT_ID setup (REQUIRED before this works in production):**
 *
 *   1. Visit https://github.com/settings/developers
 *   2. "OAuth Apps" → "New OAuth App"
 *   3. Application name: "Parachute Vault" (or operator-chosen)
 *      Homepage URL: https://parachute.computer
 *      Authorization callback URL: https://parachute.computer/oauth/github
 *      (callback URL is required by GitHub's form but unused in Device Flow)
 *   4. After creating: open the app's settings page
 *   5. Tick the "Enable Device Flow" checkbox
 *   6. Copy the Client ID (looks like `Iv1.abc123...` or `Ov23li...`)
 *   7. Set the `GITHUB_CLIENT_ID` constant below to that value
 *
 * The placeholder ships with this PR. Production builds are gated on a real
 * client_id; the PR body flags Aaron as the action owner.
 */

// ---------------------------------------------------------------------------
// Client ID — REPLACE BEFORE TAGGING A RELEASE.
//
// This is the public OAuth app client_id. No secret is needed for Device
// Flow (the operator's typed code is the proof-of-presence factor). Safe to
// commit + ship in client builds. But: tied to ONE registered GitHub OAuth
// App, which Aaron owns under the Parachute org / his account. Set this
// after running the setup checklist above.
//
// TODO(aaron): replace with the real client_id from the registered OAuth
// app. Until then, the device-flow endpoints return a clear-error response
// instead of attempting GitHub's API with an invalid id (which surfaces an
// opaque "Not Found" that's hard to debug).
// ---------------------------------------------------------------------------

export const GITHUB_CLIENT_ID_PLACEHOLDER =
  "Iv1.PLACEHOLDER_REPLACE_ME_BEFORE_RELEASE" as const;

/**
 * The active client id at runtime. Resolved from the env (preferred — lets
 * operators override per-deploy) or the constant above (for tests +
 * defaults). Defaults to the placeholder; the route handlers check for the
 * placeholder and return an actionable error before hitting GitHub.
 */
export function getGithubClientId(): string {
  return process.env.PARACHUTE_GITHUB_CLIENT_ID || GITHUB_CLIENT_ID_PLACEHOLDER;
}

/** Returns true when no real client id has been configured. */
export function isPlaceholderClientId(clientId: string): boolean {
  return clientId === GITHUB_CLIENT_ID_PLACEHOLDER || clientId.includes("PLACEHOLDER");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  /** Seconds the client should wait between polls. */
  interval: number;
}

/** Discriminated union of poll outcomes. */
export type TokenPollResult =
  | { state: "pending" }
  | { state: "slow_down"; interval: number }
  | { state: "expired" }
  | { state: "denied" }
  | {
      state: "granted";
      access_token: string;
      scope: string;
      token_type: string;
    };

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url?: string;
}

export interface GitHubRepoInfo {
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  /** ISO timestamp. Used by the SPA for "last updated" sort/display. */
  updated_at: string;
  /** HTTPS clone URL (no auth). The mirror gets the authed shape applied
   *  separately via `applyToGitRemote`. */
  clone_url: string;
}

export interface ListReposResult {
  repos: GitHubRepoInfo[];
  /** True when the operator has more than `maxPages * per_page` repos and
   *  we stopped paginating. Signals the UI to recommend the manual-URL
   *  paste or a search filter. */
  truncated: boolean;
}

/** Minimal fetch-like surface — injectable for tests. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

function defaultFetch(): FetchLike {
  return globalThis.fetch as FetchLike;
}

// ---------------------------------------------------------------------------
// Device Flow endpoints
// ---------------------------------------------------------------------------

/**
 * Start a device-flow authorization. POSTs to GitHub's `/login/device/code`
 * with the public client_id + the `repo` scope (the minimum we need to push
 * to the operator's private repos).
 *
 * Throws on transport or shape error — the route handler catches + returns
 * a 502. Successful return is the four-tuple GitHub spec calls for
 * (device_code, user_code, verification_uri, expires_in, interval).
 */
export async function requestDeviceCode(
  clientId: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<DeviceCodeResponse> {
  const res = await fetchImpl("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      // `repo` is the broad-private-repo scope. Read-only push isn't a
      // thing on GitHub; if we want to push, we need write access to repo
      // contents, which `repo` includes. The narrower scope `public_repo`
      // wouldn't cover private repos — most operator vaults are private.
      scope: "repo",
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub device-code request failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const parsed = (await res.json()) as Partial<DeviceCodeResponse>;
  if (
    typeof parsed.device_code !== "string" ||
    typeof parsed.user_code !== "string" ||
    typeof parsed.verification_uri !== "string" ||
    typeof parsed.expires_in !== "number" ||
    typeof parsed.interval !== "number"
  ) {
    throw new Error(
      `GitHub device-code response missing required fields: ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  return parsed as DeviceCodeResponse;
}

/**
 * Poll GitHub's `/login/oauth/access_token` for a granted token. Returns a
 * discriminated union the route handler can branch on.
 *
 * GitHub returns a 200 with an `error` field for the in-flight states
 * (`authorization_pending`, `slow_down`, etc.); we map those to our `state`
 * field. A true HTTP error (5xx) throws.
 */
export async function pollForToken(
  clientId: string,
  deviceCode: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<TokenPollResult> {
  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub access_token poll failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const parsed = (await res.json()) as Record<string, unknown>;

  // Success: { access_token, scope, token_type }
  if (typeof parsed.access_token === "string") {
    return {
      state: "granted",
      access_token: parsed.access_token,
      scope: typeof parsed.scope === "string" ? parsed.scope : "",
      token_type: typeof parsed.token_type === "string" ? parsed.token_type : "bearer",
    };
  }

  // In-flight / failure states: { error, error_description, interval? }
  const error = typeof parsed.error === "string" ? parsed.error : null;
  if (error === "authorization_pending") return { state: "pending" };
  if (error === "slow_down") {
    const interval = typeof parsed.interval === "number" ? parsed.interval : 5;
    return { state: "slow_down", interval };
  }
  if (error === "expired_token") return { state: "expired" };
  if (error === "access_denied") return { state: "denied" };
  // Unknown error — treat as denied so the UI surfaces a clear failure
  // rather than hanging on pending. The actual GitHub error string is
  // not surfaced (it'd leak via logs); the route's response carries a
  // generic "denied" + the message via console.warn.
  console.warn(
    `[github-device-flow] unexpected error from access_token poll: ${error ?? JSON.stringify(parsed).slice(0, 100)}`,
  );
  return { state: "denied" };
}

// ---------------------------------------------------------------------------
// User + repo APIs (used after token granted)
// ---------------------------------------------------------------------------

/**
 * Fetch the authenticated user's profile. Used immediately after a
 * `granted` token to populate `user_login` + `user_id` in the stored
 * credential.
 */
export async function fetchUser(
  token: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<GitHubUser> {
  const res = await fetchImpl("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `token ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub /user fetch failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const parsed = (await res.json()) as Partial<GitHubUser>;
  if (typeof parsed.login !== "string" || typeof parsed.id !== "number") {
    throw new Error(`GitHub /user response missing login or id`);
  }
  return {
    login: parsed.login,
    id: parsed.id,
    name: typeof parsed.name === "string" ? parsed.name : null,
    avatar_url: typeof parsed.avatar_url === "string" ? parsed.avatar_url : undefined,
  };
}

/**
 * Paginated list of repos the authenticated user owns. Sorted by most-
 * recently-updated so the repo the operator probably wants is near the top.
 * Truncates after `maxPages * perPage` repos (default 3 * 100 = 300) — most
 * operators have far fewer, the truncation signals the UI to prompt for a
 * search filter.
 */
export async function listRepos(
  token: string,
  opts: { maxPages?: number; perPage?: number } = {},
  fetchImpl: FetchLike = defaultFetch(),
): Promise<ListReposResult> {
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 3;
  const repos: GitHubRepoInfo[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchImpl(
      `https://api.github.com/user/repos?type=owner&sort=updated&per_page=${perPage}&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `token ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `GitHub /user/repos fetch failed (${res.status}, page ${page}): ${body.slice(0, 200)}`,
      );
    }
    const items = (await res.json()) as Array<{
      name: string;
      full_name: string;
      private: boolean;
      html_url: string;
      description: string | null;
      updated_at: string;
      clone_url: string;
      owner: { login: string };
    }>;
    for (const item of items) {
      repos.push({
        owner: item.owner.login,
        name: item.name,
        full_name: item.full_name,
        private: item.private,
        html_url: item.html_url,
        description: item.description,
        updated_at: item.updated_at,
        clone_url: item.clone_url,
      });
    }
    // No more pages.
    if (items.length < perPage) {
      return { repos, truncated: false };
    }
    // Page filled to perPage — there might be more. If we're at the cap,
    // mark as truncated and return.
    if (page === maxPages) {
      truncated = true;
    }
  }
  return { repos, truncated };
}

/**
 * Create a new repo on the authenticated user's account. Defaults to private
 * because the operator's vault is more likely sensitive than public. The
 * repo gets initialized empty (no README) so the first `git push` from the
 * mirror lands the operator's vault as commit 1.
 */
export async function createRepo(
  token: string,
  opts: { name: string; description?: string; private?: boolean },
  fetchImpl: FetchLike = defaultFetch(),
): Promise<GitHubRepoInfo> {
  const res = await fetchImpl("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `token ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: opts.name,
      description: opts.description ?? "Parachute Vault mirror",
      private: opts.private ?? true,
      auto_init: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    let parsed: { message?: string } = {};
    try {
      parsed = JSON.parse(body) as { message?: string };
    } catch {
      // not JSON
    }
    throw new Error(
      `GitHub /user/repos create failed (${res.status}): ${parsed.message ?? body.slice(0, 200)}`,
    );
  }
  const item = (await res.json()) as {
    name: string;
    full_name: string;
    private: boolean;
    html_url: string;
    description: string | null;
    updated_at: string;
    clone_url: string;
    owner: { login: string };
  };
  return {
    owner: item.owner.login,
    name: item.name,
    full_name: item.full_name,
    private: item.private,
    html_url: item.html_url,
    description: item.description,
    updated_at: item.updated_at,
    clone_url: item.clone_url,
  };
}
