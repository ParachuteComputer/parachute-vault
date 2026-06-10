/**
 * Tests for the GitHub Device Flow client. All HTTP calls go through an
 * injected fetch — no real network round-trips, no real GitHub OAuth app.
 *
 * Coverage:
 *   - requestDeviceCode happy path + missing-field error
 *   - pollForToken: granted / pending / slow_down / expired / denied
 *   - fetchUser happy path
 *   - listRepos: single-page, paginated, truncated
 *   - listInstallations: happy (user + org), empty, bad shape, API error
 *   - listInstallationRepos: happy, paginated/truncated, bad shape
 *   - createRepo happy path + GitHubApiError status (403 = no Administration)
 *   - app slug helpers + install URL
 */

import { describe, expect, test } from "bun:test";

import {
  createRepo,
  fetchUser,
  GITHUB_APP_SLUG_DEFAULT,
  GITHUB_CLIENT_ID_DEFAULT,
  getGithubAppSlug,
  getGithubClientId,
  GitHubApiError,
  installUrlForSlug,
  isPlaceholderClientId,
  listInstallationRepos,
  listInstallations,
  listRepos,
  pollForToken,
  requestDeviceCode,
  type FetchLike,
} from "./github-device-flow.ts";

/** Build a mock fetch that returns a predefined response per URL match. */
function mockFetch(
  responses: Array<{
    match: (url: string) => boolean;
    response: {
      ok: boolean;
      status: number;
      body: unknown;
    };
  }>,
): FetchLike {
  let callIdx = 0;
  return async (url) => {
    // Walk in order; allow each handler to be hit once unless multi-use.
    for (let i = callIdx; i < responses.length; i++) {
      if (responses[i]!.match(url)) {
        callIdx = i + 1;
        const r = responses[i]!.response;
        return {
          ok: r.ok,
          status: r.status,
          text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
          json: async () => r.body,
        };
      }
    }
    throw new Error(`mockFetch: no matching response for ${url}`);
  };
}

// ---------------------------------------------------------------------------
// Client id helpers
// ---------------------------------------------------------------------------

describe("client id helpers", () => {
  test("getGithubClientId reads from env when set", () => {
    const prev = process.env.PARACHUTE_GITHUB_CLIENT_ID;
    try {
      process.env.PARACHUTE_GITHUB_CLIENT_ID = "Iv1.realclient";
      expect(getGithubClientId()).toBe("Iv1.realclient");
    } finally {
      if (prev === undefined) delete process.env.PARACHUTE_GITHUB_CLIENT_ID;
      else process.env.PARACHUTE_GITHUB_CLIENT_ID = prev;
    }
  });

  test("getGithubClientId falls back to the shared-app default when env unset", () => {
    const prev = process.env.PARACHUTE_GITHUB_CLIENT_ID;
    delete process.env.PARACHUTE_GITHUB_CLIENT_ID;
    try {
      expect(getGithubClientId()).toBe(GITHUB_CLIENT_ID_DEFAULT);
    } finally {
      if (prev !== undefined) process.env.PARACHUTE_GITHUB_CLIENT_ID = prev;
    }
  });

  test("the shipped default is the registered Parachute GitHub App id", () => {
    // Pin the exact value — it's public by design, and a typo'd constant
    // would otherwise still pass a shape check.
    expect(GITHUB_CLIENT_ID_DEFAULT).toBe("Iv23livaRF4VcvPhu3uB");
    expect(isPlaceholderClientId(GITHUB_CLIENT_ID_DEFAULT)).toBe(false);
  });

  test("isPlaceholderClientId catches placeholder-shaped env overrides", () => {
    expect(isPlaceholderClientId("Iv1.PLACEHOLDER_REPLACE_ME_BEFORE_RELEASE")).toBe(true);
    expect(isPlaceholderClientId("PLACEHOLDER_X")).toBe(true);
    expect(isPlaceholderClientId("Iv1.realone")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// App slug helpers
// ---------------------------------------------------------------------------

describe("app slug helpers", () => {
  test("getGithubAppSlug reads from env when set (BYO-app pairing)", () => {
    const prev = process.env.PARACHUTE_GITHUB_APP_SLUG;
    try {
      process.env.PARACHUTE_GITHUB_APP_SLUG = "my-own-app";
      expect(getGithubAppSlug()).toBe("my-own-app");
    } finally {
      if (prev === undefined) delete process.env.PARACHUTE_GITHUB_APP_SLUG;
      else process.env.PARACHUTE_GITHUB_APP_SLUG = prev;
    }
  });

  test("getGithubAppSlug falls back to the shared-app default when env unset", () => {
    const prev = process.env.PARACHUTE_GITHUB_APP_SLUG;
    delete process.env.PARACHUTE_GITHUB_APP_SLUG;
    try {
      expect(getGithubAppSlug()).toBe(GITHUB_APP_SLUG_DEFAULT);
    } finally {
      if (prev !== undefined) process.env.PARACHUTE_GITHUB_APP_SLUG = prev;
    }
  });

  test("the shipped default slug is the registered Parachute GitHub App's", () => {
    // Pin the exact value — a typo'd slug would build a 404 install link.
    expect(GITHUB_APP_SLUG_DEFAULT).toBe("parachute-computer");
  });

  test("installUrlForSlug builds the installations/new URL", () => {
    expect(installUrlForSlug("parachute-computer")).toBe(
      "https://github.com/apps/parachute-computer/installations/new",
    );
  });
});

// ---------------------------------------------------------------------------
// requestDeviceCode
// ---------------------------------------------------------------------------

describe("requestDeviceCode", () => {
  test("returns the GitHub device-code tuple on success", async () => {
    const fetcher = mockFetch([
      {
        match: (u) => u.includes("/login/device/code"),
        response: {
          ok: true,
          status: 200,
          body: {
            device_code: "abc123",
            user_code: "XXXX-YYYY",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          },
        },
      },
    ]);
    const result = await requestDeviceCode("Iv1.test", fetcher);
    expect(result.device_code).toBe("abc123");
    expect(result.user_code).toBe("XXXX-YYYY");
    expect(result.interval).toBe(5);
  });

  test("throws on missing required fields (bad shape from upstream)", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: { ok: true, status: 200, body: { user_code: "X" } },
      },
    ]);
    await expect(requestDeviceCode("Iv1.test", fetcher)).rejects.toThrow(
      /missing required fields/,
    );
  });

  test("throws on non-2xx HTTP response", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: { ok: false, status: 404, body: "not found" },
      },
    ]);
    await expect(requestDeviceCode("Iv1.test", fetcher)).rejects.toThrow(/404/);
  });
});

// ---------------------------------------------------------------------------
// pollForToken — every spec state
// ---------------------------------------------------------------------------

describe("pollForToken", () => {
  test("granted state with access token", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: {
          ok: true,
          status: 200,
          body: { access_token: "gho_real", scope: "repo", token_type: "bearer" },
        },
      },
    ]);
    const r = await pollForToken("Iv1.test", "dev_code", fetcher);
    expect(r.state).toBe("granted");
    if (r.state === "granted") {
      expect(r.access_token).toBe("gho_real");
      expect(r.scope).toBe("repo");
    }
  });

  test("pending state", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: {
          ok: true,
          status: 200,
          body: { error: "authorization_pending" },
        },
      },
    ]);
    const r = await pollForToken("Iv1.test", "dev_code", fetcher);
    expect(r.state).toBe("pending");
  });

  test("slow_down state carries new interval", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: {
          ok: true,
          status: 200,
          body: { error: "slow_down", interval: 10 },
        },
      },
    ]);
    const r = await pollForToken("Iv1.test", "dev_code", fetcher);
    expect(r.state).toBe("slow_down");
    if (r.state === "slow_down") expect(r.interval).toBe(10);
  });

  test("expired state", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: { ok: true, status: 200, body: { error: "expired_token" } },
      },
    ]);
    const r = await pollForToken("Iv1.test", "dev_code", fetcher);
    expect(r.state).toBe("expired");
  });

  test("denied state", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: { ok: true, status: 200, body: { error: "access_denied" } },
      },
    ]);
    const r = await pollForToken("Iv1.test", "dev_code", fetcher);
    expect(r.state).toBe("denied");
  });

  test("unknown error maps to denied (defense)", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: {
          ok: true,
          status: 200,
          body: { error: "weird_new_error" },
        },
      },
    ]);
    const r = await pollForToken("Iv1.test", "dev_code", fetcher);
    expect(r.state).toBe("denied");
  });
});

// ---------------------------------------------------------------------------
// fetchUser
// ---------------------------------------------------------------------------

describe("fetchUser", () => {
  test("returns login + id (and optional name)", async () => {
    const fetcher = mockFetch([
      {
        match: (u) => u.includes("/user"),
        response: {
          ok: true,
          status: 200,
          body: { login: "aaron", id: 12345, name: "Aaron Gabriel", avatar_url: "https://x/y.png" },
        },
      },
    ]);
    const user = await fetchUser("gho_test", fetcher);
    expect(user.login).toBe("aaron");
    expect(user.id).toBe(12345);
    expect(user.name).toBe("Aaron Gabriel");
  });

  test("throws on missing required fields", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: { ok: true, status: 200, body: { login: "x" } },
      },
    ]);
    await expect(fetchUser("gho_test", fetcher)).rejects.toThrow(/missing login or id/);
  });
});

// ---------------------------------------------------------------------------
// listRepos
// ---------------------------------------------------------------------------

describe("listRepos", () => {
  test("single page (< perPage repos) returns repos, untruncated", async () => {
    const fetcher = mockFetch([
      {
        match: (u) => u.includes("page=1"),
        response: {
          ok: true,
          status: 200,
          body: [
            {
              name: "a",
              full_name: "aaron/a",
              private: true,
              html_url: "https://github.com/aaron/a",
              description: null,
              updated_at: "2026-05-28T00:00:00Z",
              clone_url: "https://github.com/aaron/a.git",
              owner: { login: "aaron" },
            },
          ],
        },
      },
    ]);
    const result = await listRepos("gho_test", { perPage: 100, maxPages: 3 }, fetcher);
    expect(result.repos).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.repos[0]!.owner).toBe("aaron");
    expect(result.repos[0]!.full_name).toBe("aaron/a");
  });

  test("paginates until a short page (< perPage) signals the end", async () => {
    const fullPage = Array.from({ length: 2 }, (_, i) => ({
      name: `repo${i}`,
      full_name: `aaron/repo${i}`,
      private: false,
      html_url: `https://github.com/aaron/repo${i}`,
      description: null,
      updated_at: "2026-05-28T00:00:00Z",
      clone_url: `https://github.com/aaron/repo${i}.git`,
      owner: { login: "aaron" },
    }));
    const shortPage = [
      {
        name: "last",
        full_name: "aaron/last",
        private: false,
        html_url: "https://github.com/aaron/last",
        description: null,
        updated_at: "2026-05-28T00:00:00Z",
        clone_url: "https://github.com/aaron/last.git",
        owner: { login: "aaron" },
      },
    ];
    const fetcher = mockFetch([
      { match: (u) => u.includes("page=1"), response: { ok: true, status: 200, body: fullPage } },
      { match: (u) => u.includes("page=2"), response: { ok: true, status: 200, body: shortPage } },
    ]);
    const result = await listRepos("gho_test", { perPage: 2, maxPages: 3 }, fetcher);
    expect(result.repos).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  test("marks truncated when maxPages cap hit and page still full", async () => {
    const fullPage = Array.from({ length: 2 }, (_, i) => ({
      name: `repo${i}`,
      full_name: `aaron/repo${i}`,
      private: false,
      html_url: `https://github.com/aaron/repo${i}`,
      description: null,
      updated_at: "2026-05-28T00:00:00Z",
      clone_url: `https://github.com/aaron/repo${i}.git`,
      owner: { login: "aaron" },
    }));
    const fetcher = mockFetch([
      { match: (u) => u.includes("page=1"), response: { ok: true, status: 200, body: fullPage } },
      { match: (u) => u.includes("page=2"), response: { ok: true, status: 200, body: fullPage } },
    ]);
    const result = await listRepos("gho_test", { perPage: 2, maxPages: 2 }, fetcher);
    expect(result.repos).toHaveLength(4);
    expect(result.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listInstallations
// ---------------------------------------------------------------------------

describe("listInstallations", () => {
  test("returns user + org installations with typed fields", async () => {
    const fetcher = mockFetch([
      {
        match: (u) => u.includes("/user/installations"),
        response: {
          ok: true,
          status: 200,
          body: {
            total_count: 2,
            installations: [
              {
                id: 101,
                app_slug: "parachute-computer",
                account: { login: "aaron", type: "User" },
                repository_selection: "selected",
              },
              {
                id: 202,
                app_slug: "parachute-computer",
                account: { login: "unforced-org", type: "Organization" },
                repository_selection: "all",
              },
            ],
          },
        },
      },
    ]);
    const installations = await listInstallations("ghu_test", fetcher);
    expect(installations).toHaveLength(2);
    expect(installations[0]!.id).toBe(101);
    expect(installations[0]!.account.login).toBe("aaron");
    expect(installations[0]!.account.type).toBe("User");
    expect(installations[0]!.repository_selection).toBe("selected");
    expect(installations[1]!.account.type).toBe("Organization");
    expect(installations[1]!.app_slug).toBe("parachute-computer");
  });

  test("empty installations array = authorized but not installed", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: { ok: true, status: 200, body: { total_count: 0, installations: [] } },
      },
    ]);
    const installations = await listInstallations("ghu_test", fetcher);
    expect(installations).toEqual([]);
  });

  test("throws on a response missing the installations array", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: { ok: true, status: 200, body: { total_count: 0 } },
      },
    ]);
    await expect(listInstallations("ghu_test", fetcher)).rejects.toThrow(
      /missing installations array/,
    );
  });

  test("throws on an item missing required fields", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: {
          ok: true,
          status: 200,
          body: { total_count: 1, installations: [{ id: "not-a-number", account: null }] },
        },
      },
    ]);
    await expect(listInstallations("ghu_test", fetcher)).rejects.toThrow(
      /missing required fields/,
    );
  });

  test("throws GitHubApiError carrying the status on non-2xx", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: { ok: false, status: 401, body: { message: "Bad credentials" } },
      },
    ]);
    try {
      await listInstallations("ghu_revoked", fetcher);
      throw new Error("expected listInstallations to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// listInstallationRepos
// ---------------------------------------------------------------------------

function installationRepoItem(i: number, owner = "aaron"): Record<string, unknown> {
  return {
    name: `repo${i}`,
    full_name: `${owner}/repo${i}`,
    private: true,
    html_url: `https://github.com/${owner}/repo${i}`,
    description: null,
    updated_at: "2026-06-10T00:00:00Z",
    clone_url: `https://github.com/${owner}/repo${i}.git`,
    owner: { login: owner },
  };
}

describe("listInstallationRepos", () => {
  test("single page returns GitHubRepoInfo shapes from the installation", async () => {
    const fetcher = mockFetch([
      {
        match: (u) => u.includes("/user/installations/101/repositories") && u.includes("page=1"),
        response: {
          ok: true,
          status: 200,
          body: { total_count: 1, repositories: [installationRepoItem(0)] },
        },
      },
    ]);
    const result = await listInstallationRepos("ghu_test", 101, { perPage: 100, maxPages: 3 }, fetcher);
    expect(result.repos).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.repos[0]!.full_name).toBe("aaron/repo0");
    expect(result.repos[0]!.owner).toBe("aaron");
    expect(result.repos[0]!.private).toBe(true);
  });

  test("paginates until a short page; truncates at the maxPages cap", async () => {
    const fullPage = { total_count: 4, repositories: [installationRepoItem(0), installationRepoItem(1)] };
    const fetcher = mockFetch([
      { match: (u) => u.includes("page=1"), response: { ok: true, status: 200, body: fullPage } },
      { match: (u) => u.includes("page=2"), response: { ok: true, status: 200, body: fullPage } },
    ]);
    const result = await listInstallationRepos("ghu_test", 7, { perPage: 2, maxPages: 2 }, fetcher);
    expect(result.repos).toHaveLength(4);
    expect(result.truncated).toBe(true);

    // Short-page end: page 2 has fewer than perPage → untruncated.
    const fetcher2 = mockFetch([
      { match: (u) => u.includes("page=1"), response: { ok: true, status: 200, body: fullPage } },
      {
        match: (u) => u.includes("page=2"),
        response: { ok: true, status: 200, body: { total_count: 3, repositories: [installationRepoItem(2)] } },
      },
    ]);
    const result2 = await listInstallationRepos("ghu_test", 7, { perPage: 2, maxPages: 3 }, fetcher2);
    expect(result2.repos).toHaveLength(3);
    expect(result2.truncated).toBe(false);
  });

  test("throws on a response missing the repositories array", async () => {
    const fetcher = mockFetch([
      { match: () => true, response: { ok: true, status: 200, body: { total_count: 0 } } },
    ]);
    await expect(
      listInstallationRepos("ghu_test", 101, {}, fetcher),
    ).rejects.toThrow(/missing repositories array/);
  });

  test("throws GitHubApiError carrying the status on non-2xx", async () => {
    const fetcher = mockFetch([
      { match: () => true, response: { ok: false, status: 404, body: { message: "Not Found" } } },
    ]);
    try {
      await listInstallationRepos("ghu_test", 999, {}, fetcher);
      throw new Error("expected listInstallationRepos to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// createRepo
// ---------------------------------------------------------------------------

describe("createRepo", () => {
  test("creates a private repo with description", async () => {
    const fetcher = mockFetch([
      {
        match: (u) => u.includes("/user/repos"),
        response: {
          ok: true,
          status: 201,
          body: {
            name: "my-vault",
            full_name: "aaron/my-vault",
            private: true,
            html_url: "https://github.com/aaron/my-vault",
            description: "Parachute Vault mirror",
            updated_at: "2026-05-28T00:00:00Z",
            clone_url: "https://github.com/aaron/my-vault.git",
            owner: { login: "aaron" },
          },
        },
      },
    ]);
    const repo = await createRepo(
      "gho_test",
      { name: "my-vault", description: "Parachute Vault mirror" },
      fetcher,
    );
    expect(repo.full_name).toBe("aaron/my-vault");
    expect(repo.private).toBe(true);
    expect(repo.clone_url).toBe("https://github.com/aaron/my-vault.git");
  });

  test("surfaces GitHub error message on failure (name taken, validation)", async () => {
    const fetcher = mockFetch([
      {
        match: () => true,
        response: {
          ok: false,
          status: 422,
          body: { message: "Repository creation failed: name already exists" },
        },
      },
    ]);
    await expect(
      createRepo("gho_test", { name: "exists" }, fetcher),
    ).rejects.toThrow(/already exists/);
  });

  test("403 (shared Contents-only app) throws GitHubApiError with status 403", async () => {
    // POST /user/repos needs Administration:write — the shared app's
    // expected failure. The route maps this status to the guided-manual
    // error, so the status must survive the throw.
    const fetcher = mockFetch([
      {
        match: () => true,
        response: {
          ok: false,
          status: 403,
          body: { message: "Resource not accessible by integration" },
        },
      },
    ]);
    try {
      await createRepo("ghu_test", { name: "my-vault" }, fetcher);
      throw new Error("expected createRepo to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(403);
      expect((err as Error).message).toContain("Resource not accessible");
    }
  });
});
