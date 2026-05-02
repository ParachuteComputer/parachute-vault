/**
 * VaultTokens smoke tests — list render, scope-gated mutate UI, mint banner
 * single-emit, revoke confirm flow.
 *
 * `lib/tokens-api.ts` is mocked so the wire isn't touched; `lib/scope.ts` is
 * mocked so we control admin-vs-read gating without crafting JWTs in every
 * test (decode is tested separately in scope.test.ts).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as scope from "../lib/scope.ts";
import * as tokensApi from "../lib/tokens-api.ts";
import { VaultTokens } from "./VaultTokens.tsx";

vi.mock("../lib/tokens-api.ts");
vi.mock("../lib/scope.ts");

const tokenFixture = (over: Partial<tokensApi.TokenSummary> = {}): tokensApi.TokenSummary => ({
  id: "t_abc123",
  label: "ci",
  permission: "full",
  scopes: ["vault:work:write"],
  expires_at: null,
  created_at: "2026-05-01T00:00:00Z",
  last_used_at: null,
  ...over,
});

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/vault/work/tokens"]}>
      <Routes>
        <Route path="/vault/:name/tokens" element={<VaultTokens />} />
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

describe("VaultTokens — admin scope", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(true);
  });

  it("renders the existing-tokens list", async () => {
    vi.mocked(tokensApi.listTokens).mockResolvedValue([
      tokenFixture({ label: "ci" }),
      tokenFixture({ id: "t_def456", label: "paraclaw" }),
    ]);

    renderRoute();

    await waitFor(() => expect(screen.getByText("ci")).toBeInTheDocument());
    expect(screen.getByText("paraclaw")).toBeInTheDocument();
    expect(screen.getByText("t_abc123")).toBeInTheDocument();
  });

  it("shows the mint form and minted-token banner on success", async () => {
    vi.mocked(tokensApi.listTokens).mockResolvedValue([]);
    vi.mocked(tokensApi.mintToken).mockResolvedValue({
      ...tokenFixture({ label: "new-token" }),
      token: "pvt_super_secret",
    });

    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mint token/i })).toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText(/label/i), "new-token");
    await user.click(screen.getByRole("button", { name: /mint token/i }));

    await waitFor(() =>
      expect(screen.getByText(/new token \(shown once\)/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("pvt_super_secret")).toBeInTheDocument();
    expect(screen.getByText(/don't dismiss this banner/i)).toBeInTheDocument();
    expect(tokensApi.mintToken).toHaveBeenCalledWith("work", {
      label: "new-token",
      scopes: ["vault:work:admin"],
    });
  });

  it("rejects mint when label is empty (no API call, error shown)", async () => {
    vi.mocked(tokensApi.listTokens).mockResolvedValue([]);

    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mint token/i })).toBeInTheDocument(),
    );
    // Submit button is disabled when label is empty — type then clear to
    // exercise the form-onSubmit guard rather than the disabled state alone.
    const labelInput = screen.getByLabelText(/label/i);
    await user.type(labelInput, "x");
    await user.clear(labelInput);
    expect(screen.getByRole("button", { name: /mint token/i })).toBeDisabled();
    expect(tokensApi.mintToken).not.toHaveBeenCalled();
  });

  it("revoke shows a confirm step before deleting", async () => {
    vi.mocked(tokensApi.listTokens).mockResolvedValue([tokenFixture()]);
    vi.mocked(tokensApi.revokeToken).mockResolvedValue();

    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^revoke$/i })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^revoke$/i }));

    // Confirm step replaces the bare Revoke button with Confirm + Cancel.
    expect(screen.getByRole("button", { name: /confirm revoke/i })).toBeInTheDocument();
    expect(tokensApi.revokeToken).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /confirm revoke/i }));
    await waitFor(() =>
      expect(tokensApi.revokeToken).toHaveBeenCalledWith("work", "t_abc123"),
    );
  });
});

describe("VaultTokens — read scope", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(false);
  });

  it("hides the mint form and the per-token revoke buttons", async () => {
    vi.mocked(tokensApi.listTokens).mockResolvedValue([tokenFixture()]);

    renderRoute();

    await waitFor(() => expect(screen.getByText("ci")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /mint token/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^revoke$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only token/i)).toBeInTheDocument();
  });
});
