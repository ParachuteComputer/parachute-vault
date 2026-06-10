/**
 * GitHub Device Flow client + supporting API calls.
 *
 * Why Device Flow (not Web Flow): self-hosted vault origins are
 * unpredictable (localhost:1940, random Tailscale FQDN, custom domain). Web
 * Flow needs a pre-registered callback URL; Device Flow needs only a public
 * `client_id` and the operator authorizes by typing a code at
 * github.com/login/device from any device. Same UX as `gh auth login`.
 *
 * Spec: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token
 *
 * All HTTP calls accept an injectable `fetch` so tests can mock the wire
 * without spawning a real GitHub round-trip. Production wiring uses the
 * platform `fetch` (Bun's native).
 *
 * **The registered app (2026-06-10)**: the default client_id below belongs
 * to the shared Parachute **GitHub App** (not a classic OAuth App) that
 * every self-hosted install uses — the same model as `gh` CLI shipping its
 * client_id in source. Registration decisions (rationale in vault#480):
 * fine-grained permissions = Contents read/write ONLY (treat as frozen —
 * permission changes prompt every installer to re-approve); device flow
 * enabled; user-token expiration disabled (non-expiring `ghu_` tokens — an
 * unattended mirror daemon can't babysit single-use refresh tokens);
 * installable on any account; webhook inactive; no OAuth-on-install.
 *
 * GitHub-App token semantics that shape the connect flow:
 *   - The `scope` param is IGNORED. Token abilities = app permissions ∩
 *     the user's own access ∩ the repos selected when INSTALLING the app.
 *   - Authorization (this device flow) and installation are separate,
 *     order-independent steps. A granted token reaches no repos until the
 *     operator also installs the app on their account and selects repos
 *     (github.com/apps/<app-slug>/installations/new).
 */

// ---------------------------------------------------------------------------
// Client ID — the shared Parachute GitHub App (public; safe to commit).
//
// No secret is needed for Device Flow (the operator's typed code is the
// proof-of-presence factor), and a client_id is not a credential — GitHub
// treats public clients as trivially spoofable by design. Operators who
// want their own app (own rate-limit budget — the device-flow verification
// cap is 50/hour PER APP fleet-wide — or full sovereignty) set
// PARACHUTE_GITHUB_CLIENT_ID, which takes precedence. See vault#480.
// ---------------------------------------------------------------------------

export const GITHUB_CLIENT_ID_DEFAULT = "Iv23livaRF4VcvPhu3uB" as const;

/**
 * The active client id at runtime. Resolved from the env (preferred — the
 * bring-your-own-app path) or the shared-app default above.
 */
export function getGithubClientId(): string {
  return process.env.PARACHUTE_GITHUB_CLIENT_ID || GITHUB_CLIENT_ID_DEFAULT;
}

/**
 * Returns true when the configured client id is a placeholder rather than a
 * real id — only reachable via a misconfigured PARACHUTE_GITHUB_CLIENT_ID
 * override now that a real default ships. Route handlers keep the check so
 * a junk override surfaces an actionable error instead of GitHub's opaque
 * "Not Found".
 */
export function isPlaceholderClientId(clientId: string): boolean {
  return clientId.includes("PLACEHOLDER");
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
 * with the public client_id.
 *
 * No `scope` param: GitHub Apps ignore it entirely. Token abilities come
 * from the app's fine-grained permissions (Contents read/write) intersected
 * with the repos the operator selects when installing the app — push access
 * to private repos comes from that install-time selection, not a scope.
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
