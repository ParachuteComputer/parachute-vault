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
 *   - Every GitHub App can read ALL public repos — never infer "installed"
 *     from repo visibility. `GET /user/installations` (which requires NO
 *     permissions) is the canonical install probe: an empty array means
 *     "authorized but not installed yet."
 *
 * **Bring-your-own-app (BYO)**: operators who want their own GitHub App
 * (own rate-limit budget, full sovereignty) must override BOTH env vars as
 * a pair — `PARACHUTE_GITHUB_CLIENT_ID` (their app's client_id, used for
 * the device flow) AND `PARACHUTE_GITHUB_APP_SLUG` (their app's URL slug,
 * used to build the install link). Overriding only one mixes two apps:
 * tokens would be minted for one app while the install link points at the
 * other, and `GET /user/installations` (which lists installations of the
 * TOKEN's app) would never agree with the link.
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
// App slug — the shared Parachute GitHub App's URL slug. Drives the install
// link (github.com/apps/<slug>/installations/new), which the connect flow
// surfaces when the operator is authorized-but-not-installed. BYO-app
// operators override PARACHUTE_GITHUB_APP_SLUG *together with*
// PARACHUTE_GITHUB_CLIENT_ID (see the header comment — the pair must come
// from the same app).
// ---------------------------------------------------------------------------

export const GITHUB_APP_SLUG_DEFAULT = "parachute-computer" as const;

/**
 * The active app slug at runtime. Resolved from the env (the BYO-app path,
 * paired with PARACHUTE_GITHUB_CLIENT_ID) or the shared-app default above.
 */
export function getGithubAppSlug(): string {
  return process.env.PARACHUTE_GITHUB_APP_SLUG || GITHUB_APP_SLUG_DEFAULT;
}

/**
 * The "install this app / pick repos" URL for an app slug. Installation is
 * the second, separate step of the connect flow (authorization being the
 * first); the same URL also serves "add another account/org" and "change
 * repo selection" — GitHub routes already-installed accounts to the
 * configure screen.
 */
export function installUrlForSlug(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
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

/**
 * One installation of the app, as returned by `GET /user/installations`.
 * That endpoint lists installations OF THE TOKEN'S APP that the token's
 * user can access — user-account installs and org installs alike — and
 * requires NO permissions, so it works with the Contents-only shared app.
 * An empty list means "authorized but not installed yet" (the device-flow
 * grant alone reaches no repos).
 */
export interface GitHubInstallation {
  id: number;
  /** The app's URL slug (e.g. "parachute-computer"). Always this app's —
   *  the endpoint is app-scoped by the token — but carried for display +
   *  defensive checks. */
  app_slug: string;
  account: {
    login: string;
    /** "User" or "Organization". */
    type: string;
  };
  /** "all" or "selected" — whether the installation covers every repo on
   *  the account or an operator-picked subset. */
  repository_selection: string;
}

/**
 * Error thrown by the GitHub API helpers when GitHub returns a non-2xx
 * response. Carries the HTTP status so route handlers can branch on
 * specific failure classes (e.g. createRepo's 403 = the app lacks
 * Administration:write) without string-matching the message.
 */
export class GitHubApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
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
 *
 * **No longer the repo-picker source** (vault#480): `type=owner` excludes
 * org-owned repos by construction, and with a GitHub-App token an
 * uninstalled app still sees all PUBLIC repos — so this list silently
 * misleads ("looks connected, shows the wrong repos"). The picker now goes
 * `listInstallations` → `listInstallationRepos`, which enumerates exactly
 * what the operator granted. No production callers remain — kept exported
 * for its test coverage and as a building block for potential external /
 * non-App callers.
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

// ---------------------------------------------------------------------------
// Installation APIs — the honest sources for the connect flow (vault#480).
// ---------------------------------------------------------------------------

/**
 * List the token-user's installations of this app — `GET /user/installations`.
 *
 * Requires NO permissions (works with the Contents-only shared app), and is
 * the canonical "is the app installed?" probe: an empty array means the
 * operator authorized via device flow but hasn't installed the app on any
 * account yet, so the token reaches no repos. Items cover both user-account
 * and org installs, which is how org-owned mirror repos become reachable.
 *
 * Single page at per_page=100 — more than 100 installations of one app for
 * one user is beyond any plausible operator; truncating there is acceptable.
 *
 * Throws `GitHubApiError` on a non-2xx response, plain Error on a bad shape.
 */
export async function listInstallations(
  token: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<GitHubInstallation[]> {
  const res = await fetchImpl("https://api.github.com/user/installations?per_page=100", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `token ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GitHubApiError(
      `GitHub /user/installations fetch failed (${res.status}): ${body.slice(0, 200)}`,
      res.status,
    );
  }
  const parsed = (await res.json()) as { installations?: unknown };
  if (!parsed || !Array.isArray(parsed.installations)) {
    throw new Error(
      `GitHub /user/installations response missing installations array: ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  const installations: GitHubInstallation[] = [];
  for (const item of parsed.installations as Array<Record<string, unknown>>) {
    const account = item.account as Record<string, unknown> | null | undefined;
    if (
      typeof item.id !== "number" ||
      !account ||
      typeof account.login !== "string" ||
      typeof account.type !== "string"
    ) {
      throw new Error(
        `GitHub /user/installations item missing required fields: ${JSON.stringify(item).slice(0, 200)}`,
      );
    }
    installations.push({
      id: item.id,
      app_slug: typeof item.app_slug === "string" ? item.app_slug : "",
      account: { login: account.login, type: account.type },
      repository_selection:
        typeof item.repository_selection === "string" ? item.repository_selection : "selected",
    });
  }
  return installations;
}

/**
 * Paginated list of the repos one installation grants access to —
 * `GET /user/installations/{id}/repositories`. Metadata-read suffices (our
 * Contents permission implies it); private repos within the installation
 * are included, which is exactly the set the repo picker should show.
 * Pagination + truncation semantics match `listRepos` (per_page=100,
 * `maxPages` cap, `truncated` flag for the UI).
 *
 * Throws `GitHubApiError` on a non-2xx response, plain Error on a bad shape.
 */
export async function listInstallationRepos(
  token: string,
  installationId: number,
  opts: { maxPages?: number; perPage?: number } = {},
  fetchImpl: FetchLike = defaultFetch(),
): Promise<ListReposResult> {
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 3;
  const repos: GitHubRepoInfo[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchImpl(
      `https://api.github.com/user/installations/${installationId}/repositories?per_page=${perPage}&page=${page}`,
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
      throw new GitHubApiError(
        `GitHub /user/installations/${installationId}/repositories fetch failed (${res.status}, page ${page}): ${body.slice(0, 200)}`,
        res.status,
      );
    }
    const parsed = (await res.json()) as { repositories?: unknown };
    if (!parsed || !Array.isArray(parsed.repositories)) {
      throw new Error(
        `GitHub /user/installations/${installationId}/repositories response missing repositories array: ${JSON.stringify(parsed).slice(0, 200)}`,
      );
    }
    const items = parsed.repositories as Array<{
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
      if (
        typeof item.name !== "string" ||
        typeof item.full_name !== "string" ||
        !item.owner ||
        typeof item.owner.login !== "string"
      ) {
        throw new Error(
          `GitHub /user/installations/${installationId}/repositories item missing required fields: ${JSON.stringify(item).slice(0, 200)}`,
        );
      }
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
 *
 * **403 with the shared app is EXPECTED** (vault#480): `POST /user/repos`
 * requires the Administration repository permission (write); the shared
 * Parachute app is frozen at Contents-only, so this call only succeeds for
 * BYO-app operators whose app grants Administration:write. Throws
 * `GitHubApiError` carrying the status so the route can map the 403 to the
 * guided-manual-creation error rather than a generic failure.
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
    throw new GitHubApiError(
      `GitHub /user/repos create failed (${res.status}): ${parsed.message ?? body.slice(0, 200)}`,
      res.status,
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
