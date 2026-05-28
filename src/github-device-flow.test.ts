/**
 * Tests for the GitHub Device Flow client. All HTTP calls go through an
 * injected fetch — no real network round-trips, no real GitHub OAuth app.
 *
 * Coverage:
 *   - requestDeviceCode happy path + missing-field error
 *   - pollForToken: granted / pending / slow_down / expired / denied
 *   - fetchUser happy path
 *   - listRepos: single-page, paginated, truncated
 *   - createRepo happy path
 */

import { describe, expect, test } from "bun:test";

import {
  createRepo,
  fetchUser,
  GITHUB_CLIENT_ID_PLACEHOLDER,
  getGithubClientId,
  isPlaceholderClientId,
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

  test("getGithubClientId falls back to placeholder when env unset", () => {
    const prev = process.env.PARACHUTE_GITHUB_CLIENT_ID;
    delete process.env.PARACHUTE_GITHUB_CLIENT_ID;
    try {
      expect(getGithubClientId()).toBe(GITHUB_CLIENT_ID_PLACEHOLDER);
    } finally {
      if (prev !== undefined) process.env.PARACHUTE_GITHUB_CLIENT_ID = prev;
    }
  });

  test("isPlaceholderClientId catches the literal + the substring", () => {
    expect(isPlaceholderClientId(GITHUB_CLIENT_ID_PLACEHOLDER)).toBe(true);
    expect(isPlaceholderClientId("PLACEHOLDER_X")).toBe(true);
    expect(isPlaceholderClientId("Iv1.realone")).toBe(false);
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
});
