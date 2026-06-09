/**
 * Multi-vault home (`/vault/admin/`, B3) behavior pins:
 *
 *   - the list renders from the stubbed well-known doc, and each row's
 *     "Manage" deep-link is a PLAIN ANCHOR with an origin-absolute
 *     `/vault/<name>/admin/` href (full-document navigation — React Router
 *     `Link` under basename `/vault/admin` would mangle it, and the
 *     per-vault token cache is one-vault-per-document);
 *   - create drives `createVaultViaHub` and shows the one-shot token banner;
 *   - delete requires the retype-the-name confirm, renders the structured
 *     cascade summary (incl. the orphaned-channels warning), and surfaces
 *     the 409 last-vault refusal message;
 *   - signed-out boot (host-admin mint fails 401) renders the SignInBanner
 *     while the list stays visible (load-open page);
 *   - no-hub boot (well-known 404) renders the read-only degraded banner.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import * as hostAdmin from "../lib/host-admin-auth.ts";
import * as mva from "../lib/multi-vault-api.ts";
import { MultiVaultHome } from "./MultiVaultHome.tsx";

vi.mock("../lib/api.ts");
vi.mock("../lib/host-admin-auth.ts");
// Keep the REAL VaultsApiError (the component branches on `instanceof`) and
// the real pure helpers (name validation, formatBytes); mock only the
// network-touching functions.
vi.mock("../lib/multi-vault-api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/multi-vault-api.ts")>();
  return {
    ...actual,
    listWellKnownVaults: vi.fn(),
    fetchVaultUsage: vi.fn(),
    createVaultViaHub: vi.fn(),
    deleteVaultViaHub: vi.fn(),
  };
});

const wellKnownOk = (names: string[]): mva.WellKnownVaultsResult => ({
  kind: "ok",
  vaults: names.map((name) => ({
    name,
    url: `https://hub.example/vault/${name}`,
    version: "0.5.2",
  })),
});

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <MultiVaultHome />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mva.listWellKnownVaults).mockResolvedValue(wellKnownOk(["default", "work"]));
  vi.mocked(mva.fetchVaultUsage).mockResolvedValue({ notes: 7, totalBytes: 1024 });
  vi.mocked(hostAdmin.ensureHostAdminToken).mockResolvedValue({ kind: "ok", token: "host.jwt" });
});

describe("MultiVaultHome — list", () => {
  it("renders a row per well-known vault with usage", async () => {
    renderHome();
    expect(await screen.findByText("default")).toBeInTheDocument();
    expect(screen.getByText("work")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("vault-usage-work")).toHaveTextContent("7 notes");
    });
  });

  it("per-vault deep-links are plain origin-absolute anchors (full-document nav)", async () => {
    renderHome();
    await screen.findByText("default");
    const manageLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.endsWith("/admin/"));
    expect(manageLinks.map((a) => a.getAttribute("href"))).toEqual([
      "/vault/default/admin/",
      "/vault/work/admin/",
    ]);
  });

  it("a failed usage fetch collapses to the '—' placeholder, not an error page", async () => {
    vi.mocked(mva.fetchVaultUsage).mockRejectedValue(new Error("mint failed: 401"));
    renderHome();
    await screen.findByText("default");
    await waitFor(() => {
      expect(screen.getByTestId("vault-usage-default")).toHaveTextContent("—");
    });
  });
});

describe("MultiVaultHome — auth states", () => {
  it("signed-out: list stays visible + SignInBanner renders (load-open page)", async () => {
    vi.mocked(hostAdmin.ensureHostAdminToken).mockResolvedValue({
      kind: "auth-required",
      status: 401,
    });
    renderHome();
    expect(await screen.findByText("default")).toBeInTheDocument();
    expect(await screen.findByText(/not signed in to the hub/i)).toBeInTheDocument();
    // Mutations hidden while unauthenticated.
    expect(screen.queryByRole("button", { name: /^Delete$/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New vault name")).not.toBeInTheDocument();
  });

  it("non-admin (403): the 'go to your account' banner case renders", async () => {
    vi.mocked(hostAdmin.ensureHostAdminToken).mockResolvedValue({ kind: "forbidden" });
    renderHome();
    expect(await screen.findByText(/restricted to the hub admin/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to your account/i })).toBeInTheDocument();
  });

  it("no-hub (well-known 404): read-only degraded banner with best-effort names", async () => {
    vi.mocked(mva.listWellKnownVaults).mockResolvedValue({ kind: "no-hub" });
    vi.mocked(api.listVaultNames).mockResolvedValue(["default"]);
    renderHome();
    expect(
      await screen.findByText(/served directly by the vault daemon/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/hub origin is the front door/i)).toBeInTheDocument();
    // Read-only: names render as per-vault anchors, no create/delete.
    const link = screen.getByRole("link", { name: /default/ });
    expect(link).toHaveAttribute("href", "/vault/default/admin/");
    expect(screen.queryByLabelText("New vault name")).not.toBeInTheDocument();
  });
});

describe("MultiVaultHome — create", () => {
  it("submits the name to createVaultViaHub and shows the one-shot token banner", async () => {
    const user = userEvent.setup();
    vi.mocked(mva.createVaultViaHub).mockResolvedValue({
      name: "scratch",
      url: "https://hub.example/vault/scratch",
      version: "0.5.2",
      created: true,
      token: "jwt.one.shot",
    });
    renderHome();
    await screen.findByLabelText("New vault name");

    await user.type(screen.getByLabelText("New vault name"), "scratch");
    await user.click(screen.getByRole("button", { name: /create vault/i }));

    expect(mva.createVaultViaHub).toHaveBeenCalledWith("scratch");
    expect(await screen.findByText(/access token \(shown once\)/i)).toBeInTheDocument();
    expect(screen.getByText("jwt.one.shot")).toBeInTheDocument();
  });

  it("client-side validation blocks reserved names before any request", async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByLabelText("New vault name");

    await user.type(screen.getByLabelText("New vault name"), "admin");
    expect(await screen.findByText(/reserved name/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create vault/i })).toBeDisabled();
    expect(mva.createVaultViaHub).not.toHaveBeenCalled();
  });

  it("a created-but-no-token result renders the guidance branch, not 'already existed'", async () => {
    const user = userEvent.setup();
    vi.mocked(mva.createVaultViaHub).mockResolvedValue({
      name: "scratch",
      url: "u",
      version: "v",
      created: true,
      tokenGuidance: "No token minted — per-user OAuth.",
    });
    renderHome();
    await screen.findByLabelText("New vault name");
    await user.type(screen.getByLabelText("New vault name"), "scratch");
    await user.click(screen.getByRole("button", { name: /create vault/i }));

    expect(await screen.findByText(/was created/)).toBeInTheDocument();
    expect(screen.getByText(/No token minted/)).toBeInTheDocument();
    expect(screen.queryByText(/already existed/)).not.toBeInTheDocument();
  });
});

describe("MultiVaultHome — delete", () => {
  const cascade: mva.DeleteCascadeSummary = {
    tokens_revoked: 3,
    grants_rewritten: 1,
    grants_dropped: 0,
    user_vaults_removed: 2,
    invites_invalidated: 1,
    connections_torn_down: 1,
    orphaned_channels: ["legacy-tg"],
    vault_removed: true,
    module_restarted: true,
  };

  it("requires the retype-the-name confirm, then renders the cascade summary", async () => {
    const user = userEvent.setup();
    vi.mocked(mva.deleteVaultViaHub).mockResolvedValue({
      name: "work",
      cascade,
      warnings: [],
    });
    renderHome();
    await screen.findByText("work");

    // Open the confirm UI on the "work" row. findAll: the Delete buttons
    // appear only after the async host-admin probe resolves to "ok".
    const deleteButtons = await screen.findAllByRole("button", { name: /^Delete$/ });
    await user.click(deleteButtons[1]!);

    const confirmButton = screen.getByRole("button", { name: /delete this vault/i });
    expect(confirmButton).toBeDisabled();

    // Wrong name keeps it disabled; the exact name arms it.
    const input = screen.getByLabelText("Type work to confirm deletion");
    await user.type(input, "wrok");
    expect(confirmButton).toBeDisabled();
    await user.clear(input);
    await user.type(input, "work");
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(mva.deleteVaultViaHub).toHaveBeenCalledWith("work");

    // Structured cascade summary, incl. the orphaned-channels warning.
    const summary = (await screen.findByRole("status")).closest("div")!;
    expect(within(summary).getByText(/3 token\(s\) revoked/)).toBeInTheDocument();
    expect(within(summary).getByText(/1 invite\(s\) invalidated/)).toBeInTheDocument();
    expect(within(summary).getByText("legacy-tg")).toBeInTheDocument();
    expect(within(summary).getByText(/channel module's own admin page/)).toBeInTheDocument();
  });

  it("renders the 409 last-vault refusal message on the row", async () => {
    const user = userEvent.setup();
    vi.mocked(mva.deleteVaultViaHub).mockRejectedValue(
      new mva.VaultsApiError(
        409,
        '"default" is the last vault on this hub. Create another vault first, or use the CLI.',
        "last_vault",
      ),
    );
    renderHome();
    await screen.findByText("default");

    const deleteButtons = await screen.findAllByRole("button", { name: /^Delete$/ });
    await user.click(deleteButtons[0]!);
    await user.type(screen.getByLabelText("Type default to confirm deletion"), "default");
    await user.click(screen.getByRole("button", { name: /delete this vault/i }));

    expect(await screen.findByText(/last vault on this hub/)).toBeInTheDocument();
  });
});
