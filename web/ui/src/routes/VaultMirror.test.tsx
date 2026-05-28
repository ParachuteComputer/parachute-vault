/**
 * VaultMirror smoke tests — loading state, status render, preset apply,
 * save → PUT, manual run → POST, auth-required redirect.
 *
 * `lib/api.ts` is mocked for the wire surface; `lib/scope.ts` is mocked
 * so admin-vs-read gating is controllable per test without crafting JWTs.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import * as scope from "../lib/scope.ts";
import { VaultMirror } from "./VaultMirror.tsx";

// Preserve HttpError as a real class so the component's `err instanceof
// HttpError` branches still match instances we throw in tests; everything
// else is auto-stubbed. (vi.mock's single-arg form replaces the entire
// module — we'd lose the class identity and the auth-required path
// wouldn't trigger.)
vi.mock("../lib/api.ts", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.ts")>(
    "../lib/api.ts",
  );
  return {
    ...actual,
    getMirror: vi.fn(),
    putMirror: vi.fn(),
    runMirrorNow: vi.fn(),
    pushMirrorNow: vi.fn(),
    // Credential surface (vault#384 — UI-configurable push credentials).
    // Default mocks return "no credentials configured" so existing tests
    // see the expected pre-credentials shape. Per-test overrides via
    // `vi.mocked(api.getMirrorAuth).mockResolvedValue(...)`.
    getMirrorAuth: vi.fn().mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    }),
    deleteMirrorAuth: vi.fn(),
    startGithubDeviceFlow: vi.fn(),
    pollGithubDeviceFlow: vi.fn(),
    postMirrorAuthPat: vi.fn(),
    listGithubRepos: vi.fn(),
    createGithubRepo: vi.fn(),
    selectGithubRepo: vi.fn(),
    // Import from git (vault#391).
    postMirrorImport: vi.fn(),
  };
});
vi.mock("../lib/scope.ts");

const snapshotFixture = (
  over: Partial<api.MirrorConfig & api.MirrorStatus> = {},
): api.MirrorSnapshot => {
  const config: api.MirrorConfig = {
    enabled: false,
    location: "internal",
    external_path: null,
    sync_mode: "events",
    auto_commit: true,
    auto_push: false,
    commit_template:
      "export: {{date}} ({{notes_changed}} note{{plural}})",
    safety_net_seconds: 3600,
    // override any config-typed fields if passed
    ...Object.fromEntries(
      Object.entries(over).filter(([k]) =>
        [
          "enabled",
          "location",
          "external_path",
          "sync_mode",
          "auto_commit",
          "auto_push",
          "commit_template",
          "safety_net_seconds",
        ].includes(k),
      ),
    ),
  } as api.MirrorConfig;
  const status: api.MirrorStatus = {
    enabled: config.enabled,
    watch_running: false,
    mirror_path: null,
    last_export_at: null,
    last_export_notes_count: null,
    last_commit_sha: null,
    last_error: null,
    last_push_at: null,
    last_push_sha: null,
    last_push_error: null,
    commits_unpushed: null,
    ...Object.fromEntries(
      Object.entries(over).filter(([k]) =>
        [
          "watch_running",
          "mirror_path",
          "last_export_at",
          "last_export_notes_count",
          "last_commit_sha",
          "last_error",
          "last_push_at",
          "last_push_sha",
          "last_push_error",
          "commits_unpushed",
        ].includes(k),
      ),
    ),
  } as api.MirrorStatus;
  return { config, status };
};

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/vault/work/mirror"]}>
      <Routes>
        <Route path="/vault/:name/mirror" element={<VaultMirror />} />
        <Route path="/vault/:name" element={<div>detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VaultMirror — admin scope", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(true);
  });

  it("shows a loading state then renders the status card", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({
        enabled: true,
        location: "internal",
        sync_mode: "events",
        watch_running: true,
        mirror_path: "/tmp/vault/mirror",
        last_export_at: "2026-05-27T10:00:00.000Z",
        last_export_notes_count: 3,
        last_commit_sha: "abc1234567890def",
      }),
    );

    renderRoute();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Status/i })).toBeInTheDocument(),
    );
    // Status fields render
    expect(screen.getByText("/tmp/vault/mirror")).toBeInTheDocument();
    expect(screen.getByText("2026-05-27T10:00:00.000Z")).toBeInTheDocument();
    // Short sha (first 10)
    expect(screen.getByText("abc1234567")).toBeInTheDocument();
    expect(screen.getByText(/3 notes/)).toBeInTheDocument();
  });

  it("surfaces last_error in red when present", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({
        enabled: true,
        last_error: "external path went missing",
      }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/external path went missing/i)).toBeInTheDocument(),
    );
  });

  it("clicking a preset card pre-fills the form fields", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture());
    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );

    // Apply "History" preset → enabled, internal, sync_mode events
    await user.click(
      screen.getByRole("button", { name: /Apply History preset/i }),
    );

    const enableCheckbox = screen.getByLabelText(/Enable mirror/i) as HTMLInputElement;
    expect(enableCheckbox.checked).toBe(true);

    // Sync mode resolves to "events" (the new default for hook-driven exports)
    const syncModeSelect = screen.getByLabelText(/Sync mode/i) as HTMLSelectElement;
    expect(syncModeSelect.value).toBe("events");

    // Internal radio selected
    const internalRadio = screen.getByLabelText(
      /Internal/i,
    ) as HTMLInputElement;
    expect(internalRadio.checked).toBe(true);
  });

  it("Manual Export preset switches to sync_mode: manual", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture());
    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: /Apply Manual Export preset/i }),
    );

    const syncModeSelect = screen.getByLabelText(/Sync mode/i) as HTMLSelectElement;
    expect(syncModeSelect.value).toBe("manual");
    expect(
      screen.getByText(/No auto-fire. Exports only run when you click/i),
    ).toBeInTheDocument();
  });

  it("sync_mode events shows the safety-net hint", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture({ enabled: true, sync_mode: "events" }));
    renderRoute();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Every change to a note, tag, or attachment triggers an export within/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/safety check runs hourly/i)).toBeInTheDocument();
  });

  it("clicking Live Mirror preset switches to external location + reveals path field", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture());
    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: /Apply Live Mirror preset/i }),
    );

    // External-path input now visible
    expect(screen.getByLabelText(/External path/i)).toBeInTheDocument();
    expect(screen.getByText(/Path must exist AND be a git repo/i)).toBeInTheDocument();
  });

  it("hides the Push-after-commit checkbox when internal AND no credentials are wired", async () => {
    // Pre-credentials: internal mirrors had no remote, so auto_push was
    // meaningless and the checkbox was hidden. Post-credentials (Cut 2):
    // the checkbox stays hidden ONLY when both (a) location is internal
    // AND (b) no credentials are configured — without a remote there's
    // nothing to push to.
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture());
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );

    // Default fixture is location=internal + no creds — Push checkbox absent.
    expect(screen.queryByLabelText(/Push after each commit/i)).not.toBeInTheDocument();

    // Flip to external via the Live Mirror preset — the checkbox appears
    // even with no creds (operator may have wired a remote manually).
    await user.click(screen.getByRole("button", { name: /Apply Live Mirror preset/i }));
    expect(screen.getByLabelText(/Push after each commit/i)).toBeInTheDocument();
  });

  it("shows the Push-after-commit checkbox when internal AND credentials are wired (Cut 2)", async () => {
    // Aaron's three-stacking-gaps bug surfaced here: History preset
    // (internal location) + PAT saved → no in-UI affordance to enable
    // auto_push. Now the checkbox renders whenever the operator has a
    // remote to push to, regardless of where the working tree lives.
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture({ location: "internal" }));
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: "pat",
      github_oauth: null,
      pat: {
        label: "GitHub PAT",
        remote_url: "https://x-access-token:***@github.com/aaron/v.git",
        token_preview: "ghp_…1234",
      },
    });
    renderRoute();
    // Wait for both the mirror snapshot AND the credential status to
    // resolve — the checkbox visibility depends on `creds.active_method`,
    // which lives in a separate fetch from the mirror snapshot.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/Push after each commit/i)).toBeInTheDocument(),
    );
    // Helper copy that explains the cross-location behavior is rendered.
    expect(
      screen.getByText(/vault can push the mirror's commits to your remote/i),
    ).toBeInTheDocument();
  });

  it("shows a cursor-advance hint when auto_commit is unchecked", async () => {
    // Unchecking Commit-after-each-export doesn't disable the export cursor —
    // it just suppresses the commit. An operator clicking Run-now expecting
    // a full snapshot would be surprised; the hint surfaces that gotcha.
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture());
    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );

    // No hint while auto_commit is the default (true).
    expect(screen.queryByText(/export cursor still advances/i)).not.toBeInTheDocument();
    // Uncheck — hint appears.
    await user.click(screen.getByLabelText(/Commit after each export/i));
    expect(screen.getByText(/export cursor still advances/i)).toBeInTheDocument();
  });

  it("Save button calls PUT with the current config", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture());
    vi.mocked(api.putMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal", sync_mode: "events" }),
    );

    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );

    // Flip the master switch on, save.
    await user.click(screen.getByLabelText(/Enable mirror/i));
    await user.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => {
      expect(api.putMirror).toHaveBeenCalled();
    });
    const [vaultArg, configArg] = vi.mocked(api.putMirror).mock.calls[0]!;
    expect(vaultArg).toBe("work");
    expect((configArg as api.MirrorConfig).enabled).toBe(true);
  });

  it("Run export now triggers POST and refreshes status", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal" }),
    );
    vi.mocked(api.runMirrorNow).mockResolvedValue(
      snapshotFixture({
        enabled: true,
        location: "internal",
        last_export_at: "2026-05-27T11:00:00.000Z",
        last_export_notes_count: 7,
      }),
    );

    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Run export now/i }),
      ).toBeInTheDocument(),
    );
    const runBtn = screen.getByRole("button", { name: /Run export now/i });
    expect(runBtn).not.toBeDisabled();

    await user.click(runBtn);

    await waitFor(() => {
      expect(api.runMirrorNow).toHaveBeenCalledWith("work");
    });
    // Status pulled from the returned snapshot.
    await waitFor(() =>
      expect(screen.getByText("2026-05-27T11:00:00.000Z")).toBeInTheDocument(),
    );
    expect(screen.getByText(/7 notes/)).toBeInTheDocument();
  });

  it("Run export now is disabled when status.enabled is false", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: false }),
    );

    renderRoute();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Run export now/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Run export now/i })).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Cut 5: push status fields render in the Status card.
  // -------------------------------------------------------------------------

  it("renders Last push timestamp + sha when last_push_at is set", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({
        enabled: true,
        location: "internal",
        last_push_at: "2026-05-28T10:30:00.000Z",
        last_push_sha: "deadbeef1234567890abcdef",
        commits_unpushed: 0,
      }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Status/i })).toBeInTheDocument(),
    );
    expect(screen.getByText("2026-05-28T10:30:00.000Z")).toBeInTheDocument();
    // Truncated short sha (first 10).
    expect(screen.getByText("deadbeef12")).toBeInTheDocument();
  });

  it("surfaces last_push_error in red when present", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({
        enabled: true,
        last_push_error: "fatal: Could not resolve host: github.example.com",
      }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/Last push failed/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Could not resolve host/i)).toBeInTheDocument();
  });

  it("shows '<N> commits ready to push' hint when commits_unpushed > 0 and no recent push", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({
        enabled: true,
        commits_unpushed: 3,
      }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/3 commits ready to push/i)).toBeInTheDocument(),
    );
  });

  // -------------------------------------------------------------------------
  // Cut 6: explicit "Push now" button + pushMirrorNow call.
  // -------------------------------------------------------------------------

  it("Push now button fires pushMirrorNow + refreshes status", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({
        enabled: true,
        location: "internal",
        commits_unpushed: 1,
      }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: "pat",
      github_oauth: null,
      pat: {
        label: "GitHub PAT",
        remote_url: "https://x-access-token:***@github.com/aaron/v.git",
        token_preview: "ghp_…1234",
      },
    });
    vi.mocked(api.pushMirrorNow).mockResolvedValue({
      ...snapshotFixture({
        enabled: true,
        location: "internal",
        last_push_at: "2026-05-28T10:31:00.000Z",
        last_push_sha: "feedface1234567890abc",
        commits_unpushed: 0,
      }),
      push: { fired: true, pushed: true, sha: "feedface1234567890abc" },
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Push now/i })).toBeInTheDocument(),
    );
    const pushBtn = screen.getByRole("button", { name: /Push now/i });
    expect(pushBtn).not.toBeDisabled();
    const user = userEvent.setup();
    await user.click(pushBtn);
    await waitFor(() => {
      expect(api.pushMirrorNow).toHaveBeenCalledWith("work");
    });
    // The post-push status flows back into the card.
    await waitFor(() =>
      expect(screen.getByText("2026-05-28T10:31:00.000Z")).toBeInTheDocument(),
    );
  });

  it("Push now is disabled when no credentials are wired AND auto_push is false", async () => {
    // No remote to push to → button disabled with a tooltip nudge to
    // wire credentials. (Operators with auto_push on but no creds still
    // get the button — clicking surfaces last_push_error cleanly.)
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal", auto_push: false }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Push now/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Push now/i })).toBeDisabled();
  });

  it("surfaces a PUT error from the server next to the form", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture());
    vi.mocked(api.putMirror).mockRejectedValue(
      new api.HttpError(
        400,
        '`external_path` is required when `location` is "external"',
      ),
    );

    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() =>
      expect(screen.getByText(/external_path/)).toBeInTheDocument(),
    );
  });
});

describe("VaultMirror — auth-required path", () => {
  it("shows the auth banner on 401 from getMirror", async () => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(false);
    // The real HttpError class is preserved via the vi.mock factory above
    // — `err instanceof HttpError` in the component matches a real
    // instance thrown here.
    vi.mocked(api.getMirror).mockRejectedValue(
      new api.HttpError(401, "no admin token"),
    );

    renderRoute();

    await waitFor(() =>
      expect(
        screen.getByText(/Open this page from the hub's directory/i),
      ).toBeInTheDocument(),
    );
  });
});

describe("VaultMirror — read scope", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(false);
  });

  it("disables save + run buttons and shows the read-only banner", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal" }),
    );

    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );

    expect(screen.getByText(/read-only token/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Run export now/i })).toBeDisabled();
  });

  it("hides the Git remote section for read-only sessions (admin scope gates it)", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "external", external_path: "/tmp/x" }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: /Git remote/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Git remote credentials section (vault#384)
// ---------------------------------------------------------------------------

describe("VaultMirror — Git remote credentials", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(true);
  });

  it("shows 'Not connected' + the two connect buttons when no credentials", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "external", external_path: "/tmp/x" }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Git remote/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Not connected/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Connect GitHub/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Use Personal Access Token/i }),
    ).toBeInTheDocument();
  });

  // Reviewer-flagged on vault#388 — substring-matchy existence checks
  // above don't pin the primary/secondary distinction. Per Aaron's
  // 2026-05-28 direction, PAT is the primary action (works against any
  // HTTPS+token git host); GitHub Device Flow is the GitHub-specific
  // one-click shortcut and gets the .secondary class. A future
  // refactor that flips them back would now fail this assertion.
  it("renders PAT as primary action and GitHub as secondary shortcut", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "external", external_path: "/tmp/x" }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Git remote/i })).toBeInTheDocument(),
    );
    const patBtn = screen.getByRole("button", { name: /Use Personal Access Token/i });
    const ghBtn = screen.getByRole("button", { name: /Connect GitHub/i });
    expect(patBtn.className).not.toContain("secondary");
    expect(ghBtn.className).toContain("secondary");
  });

  it("shows 'Connected to @login' + Disconnect when github_oauth is active", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "external", external_path: "/tmp/x" }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: "github_oauth",
      github_oauth: {
        user_login: "aaron",
        user_id: 1,
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        token_preview: "gho_…7890",
      },
      pat: null,
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/Connected to/i)).toBeInTheDocument(),
    );
    // Show the masked token preview, not a raw token.
    expect(screen.getByText("gho_…7890")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Disconnect/i })).toBeInTheDocument();
  });

  it("displays the friendly auto_push warning when no credentials but auto_push=true", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({
        enabled: true,
        location: "external",
        external_path: "/tmp/x",
        auto_push: true,
      }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/Auto-push needs git credentials/i)).toBeInTheDocument(),
    );
  });

  it("displays 'Will push to @login' when credentials configured and auto_push=true", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({
        enabled: true,
        location: "external",
        external_path: "/tmp/x",
        auto_push: true,
      }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: "github_oauth",
      github_oauth: {
        user_login: "aaron",
        user_id: 1,
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        token_preview: "gho_…7890",
      },
      pat: null,
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/Will push to/i)).toBeInTheDocument(),
    );
    // Use of @login appears in the auto_push banner; the Connected status
    // also says the login. Both should be rendered.
    const matches = screen.getAllByText(/@aaron/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("opens the OAuth modal and displays the user_code after a successful device-code request", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "external", external_path: "/tmp/x" }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    vi.mocked(api.startGithubDeviceFlow).mockResolvedValue({
      polling_id: "test_polling_id",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
    vi.mocked(api.pollGithubDeviceFlow).mockResolvedValue({ state: "pending" });

    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Git remote/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Connect GitHub/i }));
    await waitFor(() =>
      expect(screen.getByText("ABCD-1234")).toBeInTheDocument(),
    );
    expect(api.startGithubDeviceFlow).toHaveBeenCalledWith("work");
    // verification_uri rendered as a link.
    const link = screen.getByRole("link", { name: /github\.com\/login\/device/i }) as HTMLAnchorElement;
    expect(link.href).toContain("github.com/login/device");
  });

  it("surfaces 'Auto-push enabled + first push landed' toast after PAT save (Cut 3 + 6)", async () => {
    // After PAT save the backend may auto-enable auto_push AND fire an
    // initial push. The SPA shows a toast with the actual outcome
    // (sha pushed) so the operator sees the credentials worked.
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal" }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    vi.mocked(api.postMirrorAuthPat).mockResolvedValue({
      active_method: "pat",
      github_oauth: null,
      pat: {
        label: "GitHub PAT",
        remote_url: "https://x-access-token:***@github.com/a/b.git",
        token_preview: "ghp_…7890",
      },
      auto_push_was_already_enabled: false,
      auto_push_enabled: true,
      initial_push: {
        fired: true,
        pushed: true,
        sha: "abc1234567def890",
      },
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Git remote/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Use Personal Access Token/i }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Use Personal Access Token/i })).toBeInTheDocument(),
    );
    const modal = screen.getByRole("dialog");
    await user.type(
      within(modal).getByLabelText(/Token/i),
      "ghp_test1234567890",
    );
    await user.type(
      within(modal).getByLabelText(/Remote URL/i),
      "https://github.com/a/b.git",
    );
    await user.click(screen.getByRole("button", { name: /Validate & save/i }));
    // The toast confirms the auto_push + push outcome.
    await waitFor(() =>
      expect(screen.getByText(/Credentials saved/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Auto-push enabled and the first push landed/i),
    ).toBeInTheDocument();
    // The pushed sha (truncated to 10) appears.
    expect(screen.getByText("abc1234567")).toBeInTheDocument();
  });

  it("opens the PAT modal and accepts token + remote URL input", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "external", external_path: "/tmp/x" }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Git remote/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Use Personal Access Token/i }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Use Personal Access Token/i })).toBeInTheDocument(),
    );
    // Scope to the PAT modal — vault#391 added an "Import from a git
    // repo" section below GitRemoteSection which also renders a "Remote
    // URL" field, so a bare getByLabelText match would be ambiguous.
    const modal = screen.getByRole("dialog");
    const tokenInput = within(modal).getByLabelText(/Token/i) as HTMLInputElement;
    const urlInput = within(modal).getByLabelText(/Remote URL/i) as HTMLInputElement;
    await user.type(tokenInput, "ghp_test1234567890");
    await user.type(urlInput, "https://github.com/aaron/vault.git");
    expect(tokenInput.value).toBe("ghp_test1234567890");
    expect(urlInput.value).toBe("https://github.com/aaron/vault.git");
  });
});

// ===========================================================================
// Import-from-git section (vault#391) — symmetric counterpart to the
// export flow. Tests the ImportFromGitSection's render, mode toggle,
// confirm-name gate for Replace, success modal, and error path.
// ===========================================================================

describe("VaultMirror — Import from git section", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(true);
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: false, location: "internal" }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
  });

  it("renders the import section heading + multi-pusher caveat", async () => {
    renderRoute();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Import from a git repo/i }),
      ).toBeInTheDocument(),
    );
    // Matches either the <strong> "One vault per remote." or the rest
    // of the banner body — getAllByText since both render.
    const matches = screen.getAllByText(/One vault per remote/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("hides import section for read-only users", async () => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(false);
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Git backup for/i })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("heading", { name: /Import from a git repo/i }),
    ).not.toBeInTheDocument();
  });

  it("toggling Replace requires typing the vault name to enable Start", async () => {
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    // Type a URL into the import section's Remote URL field (the one
    // INSIDE the import section, not the PAT modal which isn't open).
    const importUrlInput = screen.getByLabelText(/Remote URL/i) as HTMLInputElement;
    await user.type(importUrlInput, "https://github.com/aaron/vault.git");

    // Switch to Replace mode.
    await user.click(screen.getByRole("radio", { name: /Replace/i }));
    expect(screen.getByText(/Replace will delete every note/i)).toBeInTheDocument();

    const startBtn = screen.getByRole("button", { name: /Start import/i });
    expect(startBtn).toBeDisabled();

    // Wrong confirmation — still disabled.
    const confirm = screen.getByLabelText(/Type vault name to confirm/i) as HTMLInputElement;
    await user.type(confirm, "wrong");
    expect(startBtn).toBeDisabled();

    // Right confirmation — enabled.
    await user.clear(confirm);
    await user.type(confirm, "work");
    expect(startBtn).not.toBeDisabled();
  });

  it("Start import fires postMirrorImport + shows success summary on resolve", async () => {
    vi.mocked(api.postMirrorImport).mockResolvedValue({
      notes_imported: 42,
      tags_imported: 3,
      attachments_imported: 5,
      warnings: [],
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    const importUrlInput = screen.getByLabelText(/Remote URL/i) as HTMLInputElement;
    await user.type(importUrlInput, "https://github.com/aaron/vault.git");
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(screen.getByText(/Import succeeded/i)).toBeInTheDocument(),
    );
    expect(api.postMirrorImport).toHaveBeenCalledWith("work", {
      remote_url: "https://github.com/aaron/vault.git",
      mode: "merge",
      credentials: { kind: "none" },
    });
    // The success summary mentions the counts.
    expect(screen.getByText(/Imported 42 notes/i)).toBeInTheDocument();
    // Auto-wire offer surfaces.
    expect(screen.getByText(/Set this repo as the active mirror remote/i)).toBeInTheDocument();
  });

  it("one-time PAT credential is sent on Start", async () => {
    vi.mocked(api.postMirrorImport).mockResolvedValue({
      notes_imported: 1,
      tags_imported: 0,
      attachments_imported: 0,
      warnings: [],
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/aaron/private.git",
    );
    await user.click(screen.getByLabelText(/One-time credential/i));
    const patField = screen.getByPlaceholderText(/ghp_/) as HTMLInputElement;
    await user.type(patField, "ghp_oneshot_xyz");
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(api.postMirrorImport).toHaveBeenCalledWith("work", {
        remote_url: "https://github.com/aaron/private.git",
        mode: "merge",
        credentials: { kind: "pat", token: "ghp_oneshot_xyz" },
      }),
    );
  });

  it("uses credentials: null (stored creds) when mirror has saved credentials", async () => {
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: "pat",
      github_oauth: null,
      pat: {
        label: "saved",
        remote_url: "https://github.com/aaron/saved.git",
        token_preview: "ghp_…1234",
      },
    });
    vi.mocked(api.postMirrorImport).mockResolvedValue({
      notes_imported: 7,
      tags_imported: 1,
      attachments_imported: 0,
      warnings: [],
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/aaron/saved.git",
    );
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(api.postMirrorImport).toHaveBeenCalledWith("work", {
        remote_url: "https://github.com/aaron/saved.git",
        mode: "merge",
        credentials: null,
      }),
    );
  });

  it("surfaces server error message on failure", async () => {
    vi.mocked(api.postMirrorImport).mockRejectedValue(
      new api.HttpError(502, "git clone failed for https://***@github.com/missing/repo.git: fatal: not found"),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/missing/repo.git",
    );
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(screen.getByText(/git clone failed/i)).toBeInTheDocument(),
    );
  });
});
