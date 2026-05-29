/**
 * VaultTokens smoke tests — hub-JWT list render, scope-gated mutate UI, mint
 * banner single-emit, revoke confirm flow, and the legacy `pvt_*` section
 * (shown only when the legacy list is non-empty).
 *
 * `lib/tokens-api.ts` is mocked so the wire isn't touched; `lib/scope.ts` and
 * `lib/host-admin-auth.ts` are mocked so we control admin gating + the
 * forbidden-redirect side effect without crafting JWTs in every test.
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
vi.mock("../lib/host-admin-auth.ts", async (importOriginal) => {
  // Keep the real HostAdminError class (the component does `instanceof`),
  // stub the redirect side effect.
  const actual = await importOriginal<typeof import("../lib/host-admin-auth.ts")>();
  return { ...actual, redirectToAccountHome: vi.fn() };
});

const hubFixture = (over: Partial<tokensApi.HubTokenSummary> = {}): tokensApi.HubTokenSummary => ({
  jti: "j_abc123",
  label: "ci",
  scopes: ["vault:work:write"],
  scoped_tags: null,
  expires_at: null,
  revoked_at: null,
  created_at: "2026-05-01T00:00:00Z",
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
  vi.mocked(tokensApi.listVaultTags).mockResolvedValue([]);
  // Default the hub-token list; per-test cases override.
  vi.mocked(tokensApi.listHubTokens).mockResolvedValue([]);
  // Re-expose the const re-exports the component imports from tokens-api
  // (vi.mock auto-stubs the module — restore the value exports the form needs).
  vi.mocked(tokensApi).TTL_DAY_OPTIONS = [30, 90, 180, 365];
  vi.mocked(tokensApi).DEFAULT_TTL_DAYS = 90;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VaultTokens — admin scope", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(true);
  });

  it("renders the existing hub-token list", async () => {
    vi.mocked(tokensApi.listHubTokens).mockResolvedValue([
      hubFixture({ label: "ci" }),
      hubFixture({ jti: "j_def456", label: "paraclaw" }),
    ]);

    renderRoute();

    await waitFor(() => expect(screen.getByText("ci")).toBeInTheDocument());
    expect(screen.getByText("paraclaw")).toBeInTheDocument();
    expect(screen.getByText("j_abc123")).toBeInTheDocument();
  });

  it("shows the mint form (with TTL dropdown) and minted-token banner on success", async () => {
    vi.mocked(tokensApi.mintHubToken).mockResolvedValue({
      jti: "j_new",
      token: "hub.jwt.value",
      scope: "vault:work:admin",
      expires_at: null,
    });

    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mint token/i })).toBeInTheDocument(),
    );
    // TTL dropdown is present.
    expect(screen.getByLabelText(/expires after/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^label/i), "new-token");
    await user.click(screen.getByRole("button", { name: /mint token/i }));

    await waitFor(() =>
      expect(screen.getByText(/new token \(shown once\)/i)).toBeInTheDocument(),
    );
    // Reveal field is `token` (banner works unchanged) — and it's NOT a pvt_*.
    expect(screen.getByText("hub.jwt.value")).toBeInTheDocument();
    expect(screen.queryByText(/pvt_/)).not.toBeInTheDocument();
    expect(tokensApi.mintHubToken).toHaveBeenCalledWith("work", {
      verb: "admin",
      label: "new-token",
      scopedTags: [],
      ttlDays: 90,
    });
  });

  it("attaches a beforeunload guard while the reveal banner shows and detaches on dismiss", async () => {
    vi.mocked(tokensApi.mintHubToken).mockResolvedValue({
      jti: "j_new",
      token: "hub.jwt.value",
      scope: "vault:work:admin",
      expires_at: null,
    });

    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mint token/i })).toBeInTheDocument(),
    );
    expect(addSpy.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);

    await user.type(screen.getByLabelText(/^label/i), "ci");
    await user.click(screen.getByRole("button", { name: /mint token/i }));

    await waitFor(() =>
      expect(screen.getByText(/new token \(shown once\)/i)).toBeInTheDocument(),
    );
    const beforeunloadCall = addSpy.mock.calls.find(([type]) => type === "beforeunload");
    expect(beforeunloadCall).toBeDefined();
    const handler = beforeunloadCall![1] as (e: BeforeUnloadEvent) => void;

    const fakeEvent = {
      preventDefault: vi.fn(),
      returnValue: undefined as unknown as string,
    } as unknown as BeforeUnloadEvent;
    handler(fakeEvent);
    expect(fakeEvent.preventDefault).toHaveBeenCalled();
    expect(fakeEvent.returnValue).toBe("");

    await user.click(screen.getByRole("button", { name: /done — i've saved the token/i }));

    await waitFor(() =>
      expect(
        removeSpy.mock.calls.some(([type, fn]) => type === "beforeunload" && fn === handler),
      ).toBe(true),
    );
  });

  it("rejects mint when label is empty (button disabled, no API call)", async () => {
    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mint token/i })).toBeInTheDocument(),
    );
    const labelInput = screen.getByLabelText(/^label/i);
    await user.type(labelInput, "x");
    await user.clear(labelInput);
    expect(screen.getByRole("button", { name: /mint token/i })).toBeDisabled();
    expect(tokensApi.mintHubToken).not.toHaveBeenCalled();
  });

  it("revoke keys on jti and shows a confirm step before deleting", async () => {
    vi.mocked(tokensApi.listHubTokens).mockResolvedValue([hubFixture()]);
    vi.mocked(tokensApi.revokeHubToken).mockResolvedValue();

    renderRoute();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^revoke$/i })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^revoke$/i }));

    expect(screen.getByRole("button", { name: /confirm revoke/i })).toBeInTheDocument();
    expect(tokensApi.revokeHubToken).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /confirm revoke/i }));
    await waitFor(() => expect(tokensApi.revokeHubToken).toHaveBeenCalledWith("j_abc123"));
  });

  it("shows a 'revoked' pill and hides the revoke button for already-revoked rows", async () => {
    vi.mocked(tokensApi.listHubTokens).mockResolvedValue([
      hubFixture({ jti: "j_rev", label: "dead", revoked_at: "2026-05-10T00:00:00Z" }),
    ]);

    renderRoute();

    await waitFor(() => expect(screen.getByText("dead")).toBeInTheDocument());
    expect(screen.getByText("revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^revoke$/i })).not.toBeInTheDocument();
  });

  it("renders scoped_tags pills from permissions.scoped_tags", async () => {
    vi.mocked(tokensApi.listHubTokens).mockResolvedValue([
      hubFixture({ jti: "j_tagged", label: "scoped", scoped_tags: ["health", "work"] }),
    ]);

    renderRoute();

    await waitFor(() => expect(screen.getByText("scoped")).toBeInTheDocument());
    expect(screen.getByText("#health")).toBeInTheDocument();
    expect(screen.getByText("#work")).toBeInTheDocument();
  });
});

describe("VaultTokens — legacy pvt_* section removed (vault#282 Stage 2)", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(true);
  });

  it("never renders a legacy-tokens section (the pvt_* surface is gone)", async () => {
    vi.mocked(tokensApi.listHubTokens).mockResolvedValue([hubFixture()]);

    renderRoute();

    await waitFor(() => expect(screen.getByText("ci")).toBeInTheDocument());
    // No legacy section, ever — vault no longer serves pvt_* rows.
    expect(screen.queryByText(/legacy tokens/i)).not.toBeInTheDocument();
  });
});

describe("VaultTokens — read scope", () => {
  beforeEach(() => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(false);
  });

  it("hides the mint form and per-token revoke buttons", async () => {
    vi.mocked(tokensApi.listHubTokens).mockResolvedValue([hubFixture()]);

    renderRoute();

    await waitFor(() => expect(screen.getByText("ci")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /mint token/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^revoke$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only token/i)).toBeInTheDocument();
  });
});
