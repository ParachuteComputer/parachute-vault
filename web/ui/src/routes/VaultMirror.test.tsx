/**
 * VaultMirror smoke tests — loading state, status render, preset apply,
 * save → PUT, manual run → POST, auth-required redirect.
 *
 * `lib/api.ts` is mocked for the wire surface; `lib/scope.ts` is mocked
 * so admin-vs-read gating is controllable per test without crafting JWTs.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
    // Import is a two-call flow since vault#640: POST starts a job, GET polls
    // it. Both must be mocked or the polling effect hits the real fetch.
    getMirrorImportJob: vi.fn(),
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
    // Install-state probe (vault#480). Default: shared app, installed on
    // the operator's user account with all-repos selection — the happy
    // "ready" state, so pre-#480 tests with a github_oauth credential see
    // a quiet probe instead of a crash. Per-test overrides via
    // `vi.mocked(api.getGithubInstallations).mockResolvedValue(...)`.
    getGithubInstallations: vi.fn().mockResolvedValue({
      app: {
        client_id: "Iv23livaRF4VcvPhu3uB",
        slug: "parachute-computer",
        is_shared_default: true,
      },
      installed: true,
      install_url: "https://github.com/apps/parachute-computer/installations/new",
      installations: [
        {
          id: 11,
          account_login: "aaron",
          account_type: "User",
          repository_selection: "all",
        },
      ],
    }),
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

/**
 * The page now leads with a plain-language backup status banner + the
 * "Back up to GitHub" upgrade. The preset soup, raw config fields, the
 * Status card (run-now / push-now), and import-from-git all live behind
 * a single page-level "Advanced settings" disclosure — a normal owner
 * never opens it. Tests that exercise those operator surfaces open it
 * first via this helper.
 */
async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Advanced settings/i }),
    ).toBeInTheDocument(),
  );
  await user.click(screen.getByRole("button", { name: /Advanced settings/i }));
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
    const user = userEvent.setup();
    await openAdvanced(user);

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
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByText(/external path went missing/i)).toBeInTheDocument(),
    );
  });

  it("clicking a preset card pre-fills the form fields", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture());
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);

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
    await openAdvanced(user);

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
    const user = userEvent.setup();
    await openAdvanced(user);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Every change to a note, tag, or attachment triggers an export within/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/safety check runs hourly/i)).toBeInTheDocument();
  });

  it("clicking External folder mirror preset switches to external location + reveals path field", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(snapshotFixture());
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: /Apply External folder mirror preset/i }),
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
    await openAdvanced(user);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );

    // Default fixture is location=internal + no creds — Push checkbox absent.
    expect(screen.queryByLabelText(/Push after each commit/i)).not.toBeInTheDocument();

    // Flip to external via the External folder mirror preset — the checkbox
    // appears even with no creds (operator may have wired a remote manually).
    await user.click(screen.getByRole("button", { name: /Apply External folder mirror preset/i }));
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
    const user = userEvent.setup();
    await openAdvanced(user);
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
    await openAdvanced(user);

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
    await openAdvanced(user);

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
    await openAdvanced(user);

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
    const user = userEvent.setup();
    await openAdvanced(user);
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
    const user = userEvent.setup();
    await openAdvanced(user);
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
    const user = userEvent.setup();
    await openAdvanced(user);
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
    const user = userEvent.setup();
    await openAdvanced(user);
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
    const user = userEvent.setup();
    await openAdvanced(user);
    // The "Push now" button renders once `getMirror` resolves, but its
    // ENABLED state depends on `getMirrorAuth` (active_method: "pat")
    // resolving too. Wait for not-disabled rather than asserting it
    // synchronously after only waiting for presence — the two async loads
    // can settle a tick apart, which was a flaky failure here.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Push now/i })).not.toBeDisabled(),
    );
    const pushBtn = screen.getByRole("button", { name: /Push now/i });
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
    const user = userEvent.setup();
    await openAdvanced(user);
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
    await openAdvanced(user);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() =>
      expect(screen.getByText(/external_path/)).toBeInTheDocument(),
    );
  });

  // -------------------------------------------------------------------------
  // Backup status banner (the restructured hero) + Advanced disclosure.
  // -------------------------------------------------------------------------

  it("leads with the plain 'version history on' status and keeps presets/raw fields hidden until Advanced", async () => {
    // Default-shipped vault: enabled + internal. The owner should see the
    // plain-language reassurance, NOT the preset soup or raw config fields.
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal" }),
    );
    renderRoute();

    await waitFor(() =>
      expect(screen.getByText(/Version history — on/i)).toBeInTheDocument(),
    );

    // Preset soup + raw config are NOT visible on load.
    expect(
      screen.queryByRole("heading", { name: /Configuration/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Apply History preset/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Sync mode/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Run export now/i }),
    ).not.toBeInTheDocument();

    // Opening Advanced reveals them.
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Apply History preset/i }),
    ).toBeInTheDocument();
  });

  it("presents 'Back up to GitHub' as the primary upgrade above Advanced", async () => {
    // enabled + internal, no remote wired → the upgrade CTA is the
    // GitRemoteSection, rendered OUTSIDE the Advanced disclosure.
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal" }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    renderRoute();
    // The "Back up to GitHub" section is present without opening Advanced.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Back up to GitHub/i }),
      ).toBeInTheDocument(),
    );
    // Banner nudges toward it.
    expect(screen.getByText(/Want an off-machine copy too/i)).toBeInTheDocument();
  });

  it("status banner reports backed-up state when auto_push + credentials are wired", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal", auto_push: true }),
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
      expect(screen.getByText(/backed up off this machine/i)).toBeInTheDocument(),
    );
    // The connected GitHub login appears in the banner.
    expect(screen.getAllByText(/@aaron/).length).toBeGreaterThan(0);
  });

  it("status banner reports OFF when the mirror is disabled", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: false }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/Version history is off/i)).toBeInTheDocument(),
    );
  });

  it("does NOT claim backed-up when auto_push=true but NO credentials are wired (trust guard)", async () => {
    // A vault can carry auto_push=true with no working remote. The banner
    // must NOT tell the owner their data is backed up off-machine — that's
    // a trust violation. It stays on the "version history on" + upgrade
    // nudge until credentials actually exist.
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal", auto_push: true }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/Version history — on/i)).toBeInTheDocument(),
    );
    // The off-machine claim is absent.
    expect(
      screen.queryByText(/backed up off this machine/i),
    ).not.toBeInTheDocument();
    // Still nudges toward the upgrade.
    expect(screen.getByText(/Want an off-machine copy too/i)).toBeInTheDocument();
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
        screen.getByText(/You're not signed in to the hub/i),
      ).toBeInTheDocument(),
    );
    // The CTA points to hub's login surface with a `?next=` continuation
    // so the operator lands back on this page after signing in.
    const signInLink = screen.getByRole("link", { name: /Sign in to the hub/i });
    expect(signInLink.getAttribute("href")).toMatch(/^\/login\?next=/);
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
    // Read-only banner is visible without opening Advanced.
    await waitFor(() =>
      expect(screen.getByText(/read-only token/i)).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Configuration/i })).toBeInTheDocument(),
    );

    expect(screen.getByRole("button", { name: /^Save$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Run export now/i })).toBeDisabled();
  });

  it("hides the Back-up-to-GitHub section for read-only sessions (admin scope gates it)", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "external", external_path: "/tmp/x" }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/read-only token/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("heading", { name: /Back up to GitHub/i }),
    ).not.toBeInTheDocument();
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
      expect(screen.getByRole("heading", { name: /Back up to GitHub/i })).toBeInTheDocument(),
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
      expect(screen.getByRole("heading", { name: /Back up to GitHub/i })).toBeInTheDocument(),
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
    const user = userEvent.setup();
    await openAdvanced(user);
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
    const user = userEvent.setup();
    await openAdvanced(user);
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
      expect(screen.getByRole("heading", { name: /Back up to GitHub/i })).toBeInTheDocument(),
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
      history_enabled: true,
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
      expect(screen.getByRole("heading", { name: /Back up to GitHub/i })).toBeInTheDocument(),
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
      expect(screen.getByRole("heading", { name: /Back up to GitHub/i })).toBeInTheDocument(),
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

  /**
   * Stand up the async import pair (vault#640): the POST resolves with a
   * `running` job, and the first poll resolves terminal.
   *
   * The import outcome no longer arrives on the POST — it can't, because the
   * request would have to outlive the whole clone. Tests drive the same two
   * calls the component does.
   */
  function mockImportSucceeds(result: Partial<api.MirrorImportResult> = {}) {
    const job: api.MirrorImportJob = {
      job_id: "job-1",
      vault_name: "work",
      status: "running",
      stage: "cloning",
      started_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
    };
    vi.mocked(api.postMirrorImport).mockResolvedValue({ attached: false, job });
    vi.mocked(api.getMirrorImportJob).mockResolvedValue({
      ...job,
      status: "succeeded",
      finished_at: "2026-07-29T00:00:05.000Z",
      result: {
        notes_imported: 1,
        tags_imported: 0,
        attachments_imported: 0,
        warnings: [],
        sync_enabled: false,
        ...result,
      },
    });
    return job;
  }

  /** Same, but the job ends in `failed` with the given error. */
  function mockImportFails(error: api.MirrorImportError) {
    const job: api.MirrorImportJob = {
      job_id: "job-fail",
      vault_name: "work",
      status: "running",
      stage: "cloning",
      started_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
    };
    vi.mocked(api.postMirrorImport).mockResolvedValue({ attached: false, job });
    vi.mocked(api.getMirrorImportJob).mockResolvedValue({
      ...job,
      status: "failed",
      finished_at: "2026-07-29T00:00:05.000Z",
      error,
    });
  }

  it("renders the import section heading + multi-pusher caveat", async () => {
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
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
      expect(screen.getByRole("heading", { name: /Backup for/i })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("heading", { name: /Import from a git repo/i }),
    ).not.toBeInTheDocument();
  });

  it("toggling Replace requires typing the vault name to enable Start", async () => {
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );

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

  // vault#641 — the default INVERTED. An import is a read; it must not arm a
  // write to the source repo unless the operator asks. Pinned as its own test
  // because the previous default (checked) is what made operators distrust the
  // whole flow: authenticating a PULL appeared to arm a PUSH.
  it("the back-up-to-this-repo checkbox is UNCHECKED by default", async () => {
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    const syncCheckbox = screen.getByLabelText(
      /also back this vault up to the same repo/i,
    ) as HTMLInputElement;
    expect(syncCheckbox.checked).toBe(false);
    // And the copy says so plainly, so nobody has to infer it.
    expect(screen.getByText(/nothing is written back to it/i)).toBeInTheDocument();
  });

  it("a default import sends enable_sync false and wires no push-back", async () => {
    mockImportSucceeds({ notes_imported: 12 });
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/aaron/vault.git",
    );
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(api.postMirrorImport).toHaveBeenCalledWith("work", {
        remote_url: "https://github.com/aaron/vault.git",
        mode: "merge",
        credentials: { kind: "none" },
        enable_sync: false,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText(/Import succeeded/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Sync enabled/i)).not.toBeInTheDocument();
  });

  it("Start import fires postMirrorImport (enable_sync true) + shows sync-enabled confirmation", async () => {
    mockImportSucceeds({
      notes_imported: 42,
      tags_imported: 3,
      attachments_imported: 5,
      sync_enabled: true,
    });
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    const importUrlInput = screen.getByLabelText(/Remote URL/i) as HTMLInputElement;
    await user.type(importUrlInput, "https://github.com/aaron/vault.git");
    // Opt in explicitly — this is no longer the default (vault#641).
    await user.click(
      screen.getByLabelText(/also back this vault up to the same repo/i),
    );
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(screen.getByText(/Import succeeded/i)).toBeInTheDocument(),
    );
    expect(api.postMirrorImport).toHaveBeenCalledWith("work", {
      remote_url: "https://github.com/aaron/vault.git",
      mode: "merge",
      credentials: { kind: "none" },
      enable_sync: true,
    });
    // The success summary mentions the counts.
    expect(screen.getByText(/Imported 42 notes/i)).toBeInTheDocument();
    // Sync-enabled confirmation surfaces (not the old auto-wire offer).
    expect(screen.getByText(/Sync enabled/i)).toBeInTheDocument();
  });

  it("checking the box swaps the copy to the push-back warning", async () => {
    mockImportSucceeds({ notes_imported: 4 });
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/aaron/vault.git",
    );
    // Off: the copy promises nothing is written back.
    expect(screen.getByText(/nothing is written back to it/i)).toBeInTheDocument();
    await user.click(
      screen.getByLabelText(/also back this vault up to the same repo/i),
    );
    // On: the copy names the consequence and the multi-machine hazard.
    expect(
      screen.getByText(/This vault will start pushing to that repo/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/another machine already backs up there/i),
    ).toBeInTheDocument();
  });

  it("renders sync_warning as an info/warning (not error) when sync wasn't enabled", async () => {
    mockImportSucceeds({
      notes_imported: 9,
      sync_warning:
        "Sync not enabled — pushing changes back needs write credentials (a PAT or GitHub sign-in).",
    });
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/aaron/public.git",
    );
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(screen.getByText(/Import succeeded/i)).toBeInTheDocument(),
    );
    // Warning surfaces as info, not an error-banner/alert. ("Sync not
    // enabled" appears in both the <strong> lead-in and the warning copy,
    // so assert at-least-one match + the credential-specific phrase.)
    expect(screen.getAllByText(/Sync not enabled/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/needs write credentials/i)).toBeInTheDocument();
  });

  it("one-time PAT credential is sent on Start", async () => {
    mockImportSucceeds({ notes_imported: 1, sync_enabled: true });
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/aaron/private.git",
    );
    await user.click(screen.getByLabelText(/Use a one-time token for this import/i));
    const patField = screen.getByPlaceholderText(/ghp_/) as HTMLInputElement;
    await user.type(patField, "ghp_oneshot_xyz");
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(api.postMirrorImport).toHaveBeenCalledWith("work", {
        remote_url: "https://github.com/aaron/private.git",
        mode: "merge",
        credentials: { kind: "pat", token: "ghp_oneshot_xyz" },
        enable_sync: false,
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
    mockImportSucceeds({
      notes_imported: 7,
      tags_imported: 1,
      sync_enabled: true,
    });
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
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
        enable_sync: false,
      }),
    );
  });

  it("surfaces a synchronous refusal (validation / git missing) from the POST", async () => {
    vi.mocked(api.postMirrorImport).mockRejectedValue(
      new api.HttpError(503, "git is not installed on this machine."),
    );
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/missing/repo.git",
    );
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(screen.getByText(/git is not installed/i)).toBeInTheDocument(),
    );
  });

  // vault#640 — the failure that matters now arrives on the JOB, not on the
  // POST. A clone that dies ten minutes in has long since returned 202.
  it("surfaces a clone failure that lands on the job record", async () => {
    mockImportFails({
      error_type: "clone_failed",
      message:
        "git clone failed for https://***@github.com/missing/repo.git: fatal: not found",
    });
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/missing/repo.git",
    );
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(screen.getByText(/git clone failed/i)).toBeInTheDocument(),
    );
  });

  it("shows live stage + git progress while the import runs", async () => {
    const job: api.MirrorImportJob = {
      job_id: "job-live",
      vault_name: "work",
      status: "running",
      stage: "cloning",
      started_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
    };
    vi.mocked(api.postMirrorImport).mockResolvedValue({ attached: false, job });
    vi.mocked(api.getMirrorImportJob).mockResolvedValue({
      ...job,
      detail: "Receiving objects:  47% (470/1000)",
    });
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/aaron/big.git",
    );
    await user.click(screen.getByRole("button", { name: /Start import/i }));

    await waitFor(() =>
      expect(screen.getByText(/Cloning the repo/i)).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText(/Receiving objects/)).toBeInTheDocument(),
    );
    // And the reassurance that a long import is fine — the thing the old
    // 60s-timeout flow could never say truthfully.
    expect(screen.getByText(/keeps running on the server/i)).toBeInTheDocument();
  });

  it("a vault restart mid-import (404 on poll) explains itself instead of spinning", async () => {
    const job: api.MirrorImportJob = {
      job_id: "job-lost",
      vault_name: "work",
      status: "running",
      stage: "importing",
      started_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
    };
    vi.mocked(api.postMirrorImport).mockResolvedValue({ attached: false, job });
    vi.mocked(api.getMirrorImportJob).mockRejectedValue(
      new api.HttpError(404, "no such job", "job_not_found"),
    );
    renderRoute();
    const user = userEvent.setup();
    await openAdvanced(user);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Import from a git repo/i })).toBeInTheDocument(),
    );
    await user.type(
      screen.getByLabelText(/Remote URL/i),
      "https://github.com/aaron/vault.git",
    );
    await user.click(screen.getByRole("button", { name: /Start import/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/the vault restarted while it was running/i),
      ).toBeInTheDocument(),
    );
  });
});

// ===========================================================================
// GitHub App install flow (vault#480) + history-on-link (vault#483).
//
// GitHub-App semantics: authorization (device flow) and installation are
// SEPARATE steps — a granted token reaches no private repos until the app
// is also installed. The page probes install state whenever a github_oauth
// credential is active and renders the guided state machine:
//   not-linked → linked-but-not-installed → installed-no-repo → ready.
// ===========================================================================

const githubCreds = (): api.MirrorCredentialStatus => ({
  active_method: "github_oauth",
  github_oauth: {
    user_login: "aaron",
    user_id: 1,
    scope: "",
    authorized_at: "2026-06-10T03:14:15.000Z",
    token_preview: "ghu_…7890",
  },
  pat: null,
});

const installStateFixture = (
  over: Partial<api.GithubInstallState> = {},
): api.GithubInstallState => ({
  app: {
    client_id: "Iv23livaRF4VcvPhu3uB",
    slug: "parachute-computer",
    is_shared_default: true,
  },
  installed: true,
  install_url: "https://github.com/apps/parachute-computer/installations/new",
  installations: [
    { id: 11, account_login: "aaron", account_type: "User", repository_selection: "all" },
  ],
  ...over,
});

const repoFixture = (
  over: Partial<api.GitHubRepoWithInstallation> = {},
): api.GitHubRepoWithInstallation => ({
  owner: "aaron",
  name: "a-vault",
  full_name: "aaron/a-vault",
  private: true,
  html_url: "https://github.com/aaron/a-vault",
  description: null,
  updated_at: "2026-06-01T00:00:00Z",
  clone_url: "https://github.com/aaron/a-vault.git",
  account_login: "aaron",
  installation_id: 11,
  ...over,
});

describe("VaultMirror — GitHub App install flow (vault#480)", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(true);
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal" }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue(githubCreds());
    // Re-establish the persistent default per test: `vi.clearAllMocks()`
    // clears CALLS but a sibling test's `mockResolvedValue` would
    // otherwise leak its implementation into tests relying on the
    // installed-on-@aaron baseline.
    vi.mocked(api.getGithubInstallations).mockResolvedValue(installStateFixture());
  });

  it("renders the linked-but-not-installed guided state (the one Aaron hit blind)", async () => {
    vi.mocked(api.getGithubInstallations).mockResolvedValue(
      installStateFixture({ installed: false, installations: [] }),
    );
    renderRoute();

    // Explainer: authorized, one step left.
    await waitFor(() =>
      expect(
        screen.getByText(/one step left: install the app/i),
      ).toBeInTheDocument(),
    );
    // Install link points at the API-provided install URL.
    const installLink = screen.getByRole("link", { name: /Install on GitHub/i });
    expect(installLink.getAttribute("href")).toBe(
      "https://github.com/apps/parachute-computer/installations/new",
    );
    // Repeatable re-check action.
    expect(
      screen.getByRole("button", { name: /I've installed it — check again/i }),
    ).toBeInTheDocument();
    // Org note — installing is per-account and repeatable.
    expect(
      screen.getByText(/Install the app on that org too/i),
    ).toBeInTheDocument();
  });

  it("transitions not-installed → installed via the check-again action", async () => {
    // First probe (page load): not installed. Second (the re-check):
    // the factory default — installed on @aaron.
    vi.mocked(api.getGithubInstallations).mockResolvedValueOnce(
      installStateFixture({ installed: false, installations: [] }),
    );
    renderRoute();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /I've installed it — check again/i }),
      ).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /I've installed it — check again/i }),
    );

    // The installed state replaces the guided-install panel.
    await waitFor(() =>
      expect(screen.getByText(/App installed on/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Choose repository/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/one step left: install the app/i),
    ).not.toBeInTheDocument();
    expect(api.getGithubInstallations).toHaveBeenCalledTimes(2);
  });

  it("ready state shows the active-app identity line, selection mode, and repeatable org install", async () => {
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/App installed on/i)).toBeInTheDocument(),
    );
    // Active-app identity (shared default).
    expect(
      screen.getByText(/Using the shared Parachute GitHub App/i),
    ).toBeInTheDocument();
    // repository_selection surfaced.
    expect(screen.getByText(/All repos/i)).toBeInTheDocument();
    // "Install on another account/org" stays reachable.
    expect(
      screen.getByRole("link", { name: /Install on another account or org/i }),
    ).toBeInTheDocument();
  });

  it("repo picker groups repos by account (user + org) and labels selected-only installs", async () => {
    vi.mocked(api.getGithubInstallations).mockResolvedValue(
      installStateFixture({
        installations: [
          { id: 11, account_login: "aaron", account_type: "User", repository_selection: "all" },
          {
            id: 22,
            account_login: "parachute-org",
            account_type: "Organization",
            repository_selection: "selected",
          },
        ],
      }),
    );
    vi.mocked(api.listGithubRepos).mockResolvedValue({
      installed: true,
      repos: [
        repoFixture(),
        repoFixture({
          owner: "parachute-org",
          name: "org-vault",
          full_name: "parachute-org/org-vault",
          account_login: "parachute-org",
          installation_id: 22,
        }),
      ],
      truncated: false,
    });
    vi.mocked(api.selectGithubRepo).mockResolvedValue({
      ok: true,
      applied: true,
      owner: "parachute-org",
      name: "org-vault",
      remote: "https://github.com/parachute-org/org-vault.git",
      history_enabled: true,
      auto_push_was_already_enabled: false,
      auto_push_enabled: true,
      initial_push: { fired: true, pushed: true, sha: "feedface123456" },
    });

    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Choose repository/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Choose repository/i }));

    // The picker modal probes install state, then lists repos grouped by
    // account: both group headers + the org's "Selected repos only" label.
    const modal = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(modal).getByText("parachute-org")).toBeInTheDocument(),
    );
    expect(within(modal).getByText("aaron")).toBeInTheDocument();
    expect(within(modal).getByText(/Selected repos only/i)).toBeInTheDocument();
    // Org repo is pickable — the old GET /user/repos picker couldn't see
    // org repos at all.
    await user.click(within(modal).getByRole("button", { name: /org-vault/i }));
    await waitFor(() =>
      expect(api.selectGithubRepo).toHaveBeenCalledWith("work", {
        owner: "parachute-org",
        name: "org-vault",
      }),
    );
  });

  it("open picker fetches the repo list exactly once — no per-second refetch loop (PR #484 fold)", async () => {
    // Regression: the modal's countdown ticker re-rendered every phase each
    // second, and RepoPicker's inline `onError`/`onNotInstalled` props sat
    // in its fetch-effect deps — so an open picker refetched the repo list
    // (1+N GitHub API calls server-side) every ~1s. With the fix, the
    // ticker is gated to the polling phase and the callbacks are stable:
    // sitting in the open picker across several ticker periods must not
    // re-arm the fetch. Real time (not vi.useFakeTimers) — RTL's waitFor
    // can't detect vitest fake timers and deadlocks; the sibling
    // device-flow test waits on real ~1s ticks the same way.
    vi.mocked(api.listGithubRepos).mockResolvedValue({
      installed: true,
      repos: [repoFixture()],
      truncated: false,
    });
    renderRoute();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Choose repository/i }),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /Choose repository/i }));
    const modal = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(modal).getByRole("button", { name: /a-vault/i }),
      ).toBeInTheDocument(),
    );
    expect(api.listGithubRepos).toHaveBeenCalledTimes(1);

    // Sit in the open picker across ~3 ticker periods. The unfixed code
    // refires the fetch on every 1s tick (4+ calls by now).
    await act(() => new Promise((resolve) => setTimeout(resolve, 3200)));
    expect(api.listGithubRepos).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("shared app: create-repo renders the guided-manual checklist, never a dead POST", async () => {
    vi.mocked(api.listGithubRepos).mockResolvedValue({
      installed: true,
      repos: [repoFixture()],
      truncated: false,
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Choose repository/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Choose repository/i }));
    const modal = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(modal).getByRole("button", { name: /\+ Create new private repo/i }),
      ).toBeInTheDocument(),
    );
    await user.click(
      within(modal).getByRole("button", { name: /\+ Create new private repo/i }),
    );

    // The checklist renders directly — the shared app is KNOWN
    // Contents-only, so there's no Create button that would just 403.
    await waitFor(() =>
      expect(
        within(modal).getByText(/deliberately can't create repos/i),
      ).toBeInTheDocument(),
    );
    expect(
      within(modal).queryByRole("button", { name: /^Create$/i }),
    ).not.toBeInTheDocument();

    // Typing a name prefills the github.com/new link (best-effort).
    await user.type(
      within(modal).getByLabelText(/New repo name/i),
      "my-vault-backup",
    );
    const newRepoLink = within(modal).getByRole("link", {
      name: /Create a new repo on GitHub/i,
    });
    expect(newRepoLink.getAttribute("href")).toBe(
      "https://github.com/new?name=my-vault-backup",
    );
    // Step 2 deep-links the installation's settings page.
    const configureLink = within(modal).getByRole("link", {
      name: /configure on aaron/i,
    });
    expect(configureLink.getAttribute("href")).toBe(
      "https://github.com/settings/installations/11",
    );
    // Step 3 closes the loop back into the picker. ("Refresh list" also
    // exists in the picker's own action row — expect both.)
    expect(
      within(modal).getAllByRole("button", { name: /Refresh list/i }).length,
    ).toBeGreaterThanOrEqual(2);
    expect(api.createGithubRepo).not.toHaveBeenCalled();
  });

  it("BYO app: create-repo 403 app_lacks_admin_permission falls back to the checklist (not an error toast)", async () => {
    vi.mocked(api.getGithubInstallations).mockResolvedValue(
      installStateFixture({
        app: { client_id: "Iv1.byo", slug: "my-backup-app", is_shared_default: false },
        install_url: "https://github.com/apps/my-backup-app/installations/new",
      }),
    );
    vi.mocked(api.listGithubRepos).mockResolvedValue({
      installed: true,
      repos: [repoFixture()],
      truncated: false,
    });
    vi.mocked(api.createGithubRepo).mockRejectedValue(
      new api.HttpError(
        403,
        "The Parachute GitHub App can't create repositories…",
        "app_lacks_admin_permission",
      ),
    );

    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Choose repository/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Choose repository/i }));
    const modal = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(modal).getByRole("button", { name: /\+ Create new private repo/i }),
      ).toBeInTheDocument(),
    );
    await user.click(
      within(modal).getByRole("button", { name: /\+ Create new private repo/i }),
    );

    // BYO app → the live Create button renders (the app MIGHT grant
    // Administration:write — no way to know without trying).
    await user.type(within(modal).getByLabelText(/New repo name/i), "new-backup");
    await user.click(within(modal).getByRole("button", { name: /^Create$/i }));

    // 403 with the machine-readable error_type → guided checklist, and
    // the modal does NOT flip to the error phase. (The word
    // "Administration" sits in an <em>, so match the surrounding text
    // node — getNodeText only sees an element's own text children.)
    await waitFor(() =>
      expect(
        within(modal).getByText(/permission needed to create repos/i),
      ).toBeInTheDocument(),
    );
    expect(within(modal).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("BYO disclosure: renders custom-app identity + the registration recipe", async () => {
    vi.mocked(api.getGithubInstallations).mockResolvedValue(
      installStateFixture({
        app: { client_id: "Iv1.byo", slug: "my-backup-app", is_shared_default: false },
      }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText(/Using your own GitHub App/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("my-backup-app")).toBeInTheDocument();

    // The collapsible recipe: env-var pair + the no-private-key stance.
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /Use your own GitHub App/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/PARACHUTE_GITHUB_CLIENT_ID/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/PARACHUTE_GITHUB_APP_SLUG/)).toBeInTheDocument();
    expect(screen.getByText(/Don't generate a private key/i)).toBeInTheDocument();
    expect(screen.getByText(/Contents — Read and write/i)).toBeInTheDocument();
  });
});

// ===========================================================================
// History-on-link (vault#483) — linking implies backup intent. The backend
// reports what it did via `history_enabled`; the section renders the
// outcome: on ✓ / one-click enable offer / pointer at the status error.
// ===========================================================================

describe("VaultMirror — history-on-link (vault#483)", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(true);
    vi.mocked(api.getMirrorAuth).mockResolvedValue({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
    // See the sibling describe — guard against implementation leakage.
    vi.mocked(api.getGithubInstallations).mockResolvedValue(installStateFixture());
  });

  /** Drives the PAT modal to a save — the shortest path to a credential-
   *  save response carrying `history_enabled`. */
  async function savePat(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Use Personal Access Token/i }),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /Use Personal Access Token/i }));
    const modal = await screen.findByRole("dialog");
    await user.type(within(modal).getByLabelText(/Token/i), "ghp_x");
    await user.type(
      within(modal).getByLabelText(/Remote URL/i),
      "https://github.com/a/b.git",
    );
    await user.click(screen.getByRole("button", { name: /Validate & save/i }));
  }

  const patSaveResult = (
    history: api.HistoryOnLink,
  ): api.MirrorCredentialSaveResult => ({
    active_method: "pat",
    github_oauth: null,
    pat: {
      label: "GitHub PAT",
      remote_url: "https://x-access-token:***@github.com/a/b.git",
      token_preview: "ghp_…7890",
    },
    history_enabled: history,
    auto_push_was_already_enabled: false,
    auto_push_enabled: true,
    initial_push: { fired: false, reason: "nothing_to_push" },
  });

  it("history_enabled: true → 'History is on ✓' confirmation", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal" }),
    );
    vi.mocked(api.postMirrorAuthPat).mockResolvedValue(patSaveResult(true));
    renderRoute();
    const user = userEvent.setup();
    await savePat(user);
    await waitFor(() =>
      expect(screen.getByText(/History is on/i)).toBeInTheDocument(),
    );
  });

  it("history_enabled: 'left_disabled' → one-click enable that PUTs enabled:true", async () => {
    // The vault carries an explicit enabled:false the backend refused to
    // flip — the UI offers consent-respecting one-click enable instead.
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: false, location: "internal" }),
    );
    vi.mocked(api.postMirrorAuthPat).mockResolvedValue(
      patSaveResult("left_disabled"),
    );
    vi.mocked(api.putMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal" }),
    );
    renderRoute();
    const user = userEvent.setup();
    await savePat(user);

    await waitFor(() =>
      expect(
        screen.getByText(/Version history is still off for this vault/i),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /Turn on history now/i }));
    await waitFor(() =>
      expect(api.putMirror).toHaveBeenCalledWith("work", { enabled: true }),
    );
    // The banner flips to the confirmation.
    await waitFor(() =>
      expect(screen.getByText(/History is on/i)).toBeInTheDocument(),
    );
  });

  it("history_enabled: false → points at the mirror status error", async () => {
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: false, location: "internal" }),
    );
    vi.mocked(api.postMirrorAuthPat).mockResolvedValue(patSaveResult(false));
    renderRoute();
    const user = userEvent.setup();
    await savePat(user);
    await waitFor(() =>
      expect(
        screen.getByText(/tried to turn on version history .* didn't\s*start/i),
      ).toBeInTheDocument(),
    );
  });

  it("device-flow grant carries history through the full connect chain (grant → probe → guided install → picker)", async () => {
    // The end-to-end Aaron path: authorize via device flow, history-on-link
    // fires at the grant, the probe says "not installed", the guided
    // install renders IN the modal, the re-check lands in the picker.
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: true, location: "internal" }),
    );
    vi.mocked(api.startGithubDeviceFlow).mockResolvedValue({
      polling_id: "pid",
      user_code: "WXYZ-9876",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 1, // floor — keeps the poll tick ~1s in this test
    });
    vi.mocked(api.pollGithubDeviceFlow).mockResolvedValue({
      state: "granted",
      user: { login: "aaron", id: 1, name: "Aaron" },
      history_enabled: true,
    });
    vi.mocked(api.getGithubInstallations)
      .mockResolvedValueOnce(installStateFixture({ installed: false, installations: [] }))
      .mockResolvedValueOnce(installStateFixture());
    vi.mocked(api.listGithubRepos).mockResolvedValue({
      installed: true,
      repos: [repoFixture()],
      truncated: false,
    });

    renderRoute();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Connect GitHub/i })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Connect GitHub/i }));
    // Device code renders, then the ~1s poll tick lands the grant and the
    // modal probes installations → guided install.
    await waitFor(() => expect(screen.getByText("WXYZ-9876")).toBeInTheDocument());
    const modal = screen.getByRole("dialog");
    await waitFor(
      () =>
        expect(
          within(modal).getByText(/one step left: install the app/i),
        ).toBeInTheDocument(),
      { timeout: 4000 },
    );
    // History banner surfaced at grant time (NOT deferred to repo pick —
    // the operator may close the modal mid-flow).
    expect(screen.getByText(/History is on/i)).toBeInTheDocument();

    // Re-check → installed → picker with the repo list.
    await user.click(
      within(modal).getByRole("button", { name: /I've installed it — check again/i }),
    );
    await waitFor(() =>
      expect(within(modal).getByRole("button", { name: /a-vault/i })).toBeInTheDocument(),
    );
  });

  it("repo-pick re-entry (choose-repo) surfaces the history outcome like the grant path (PR #484 fold)", async () => {
    // A credential saved BEFORE history-on-link existed, on a vault whose
    // mirror is explicitly off: the operator re-enters via "Choose
    // repository…" (no fresh grant, so the grant-time onHistory never
    // fires). The select-repo response now carries history_enabled — the
    // banner must fire off THAT, here the one-click enable offer.
    vi.mocked(api.getMirror).mockResolvedValue(
      snapshotFixture({ enabled: false, location: "internal" }),
    );
    vi.mocked(api.getMirrorAuth).mockResolvedValue(githubCreds());
    vi.mocked(api.listGithubRepos).mockResolvedValue({
      installed: true,
      repos: [repoFixture()],
      truncated: false,
    });
    vi.mocked(api.selectGithubRepo).mockResolvedValue({
      ok: true,
      applied: false,
      owner: "aaron",
      name: "a-vault",
      remote: "https://github.com/aaron/a-vault.git",
      history_enabled: "left_disabled",
      auto_push_was_already_enabled: false,
      auto_push_enabled: false,
      initial_push: { fired: false, reason: "auto_push_disabled" },
    });

    renderRoute();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Choose repository/i }),
      ).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Choose repository/i }));
    const modal = await screen.findByRole("dialog");
    await user.click(
      await within(modal).findByRole("button", { name: /a-vault/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Version history is still off for this vault/i),
      ).toBeInTheDocument(),
    );
  });
});
