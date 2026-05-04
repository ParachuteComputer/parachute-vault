/**
 * Per-vault mount pins the route-doubling fix.
 *
 * The bug: under `<BrowserRouter basename="/vault/<name>/admin">`, a
 * `<Navigate to="/vault/<name>">` from a `/` route resolved to
 * `/vault/<name>/admin/vault/<name>` (basename + path). The fix splits
 * App into two route tables based on mount mode — these tests assert
 * that:
 *   - per-vault mount renders VaultDetail directly at `/` (no redirect)
 *     and emits sub-route Links without the `/vault/<name>` prefix
 *     (so a click can't re-double the URL);
 *   - stand-alone mount keeps the picker-then-detail tree.
 *
 * `lib/mount.ts:getMountedVaultName()` is mocked so we can flip mount
 * mode without manipulating window.location across tests.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "./lib/api.ts";
import * as mount from "./lib/mount.ts";
import * as scope from "./lib/scope.ts";
import { App } from "./App.tsx";

vi.mock("./lib/api.ts");
vi.mock("./lib/mount.ts");
vi.mock("./lib/scope.ts");

const detailFixture = (over: Partial<api.VaultDetailResult> = {}): api.VaultDetailResult => ({
  name: "boulder",
  description: "ops vault",
  createdAt: "2026-05-01T00:00:00Z",
  stats: { totalNotes: 0, tagCount: 0, attachmentCount: 0, linkCount: 0 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(scope.getIssuerOrigin).mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App — per-vault mount", () => {
  beforeEach(() => {
    vi.mocked(mount.getMountedVaultName).mockReturnValue("boulder");
    vi.mocked(api.getVaultDetail).mockResolvedValue(detailFixture());
  });

  it("renders the actual stat counts from the wire payload (regression: empty values)", async () => {
    // Aaron caught this in the rc.37 ship: labels rendered (Notes / Tags /
    // Attachments / Links) but the values were empty because the SPA's old
    // VaultStats interface used short names (`notes`, `tags`, `attachments`,
    // `links`) that don't exist on the wire — the server returns
    // `totalNotes`, `tagCount`, `attachmentCount`, `linkCount` per
    // `core/src/types.ts:VaultStats`. Every read coerced undefined → "" and
    // rendered blank. Pin the four values explicitly so a future drift on
    // either side trips this test.
    vi.mocked(api.getVaultDetail).mockResolvedValue(
      detailFixture({
        stats: { totalNotes: 12, tagCount: 3, attachmentCount: 1, linkCount: 4 },
      }),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("renders VaultDetail at `/` (no redirect, no doubled URL)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    // The detail component fetches by the vault name passed as a prop —
    // if App had used <Navigate to="/vault/boulder"> instead, the route
    // table wouldn't have a matching entry under per-vault mount and we'd
    // see the 404 shell or a redirect loop instead.
    await waitFor(() => {
      expect(api.getVaultDetail).toHaveBeenCalledWith("boulder");
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Vault\s+boulder/i })).toBeInTheDocument();
    });
  });

  it("emits sub-route Tokens link as `/tokens`, not `/vault/<name>/tokens`", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: /Tokens/ });
    // Under `basename="/vault/boulder/admin"` in production, this href is
    // joined to the basename → final URL `/vault/boulder/admin/tokens`.
    // If we emitted `/vault/boulder/tokens` here we'd get the doubled
    // `/vault/boulder/admin/vault/boulder/tokens` — exactly the bug this
    // PR fixes. Pin the shape to prevent regression.
    expect(link).toHaveAttribute("href", "/tokens");
  });

  it("renders VaultTokens at `/tokens`", async () => {
    vi.mocked(api.HttpError).mockImplementation((status, message) => {
      const err = new Error(message);
      Object.assign(err, { status });
      return err as never;
    });
    render(
      <MemoryRouter initialEntries={["/tokens"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: /Tokens for/ })).toBeInTheDocument();
  });

  it("nav-bar shows the mounted vault name as a link to `/`", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    const navLink = screen.getAllByRole("link").find((l) => l.textContent?.trim() === "boulder");
    expect(navLink).toBeDefined();
    expect(navLink).toHaveAttribute("href", "/");
  });
});

describe("App — stand-alone mount", () => {
  beforeEach(() => {
    vi.mocked(mount.getMountedVaultName).mockReturnValue(null);
    vi.mocked(api.listVaultNames).mockResolvedValue(["boulder", "work"]);
    vi.mocked(api.getVaultDetail).mockResolvedValue(detailFixture());
  });

  it("renders the picker (VaultsList) at `/`", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(api.listVaultNames).toHaveBeenCalled();
    });
    expect(await screen.findByRole("link", { name: /boulder/ })).toBeInTheDocument();
  });

  it("renders VaultDetail at `/vault/:name`", async () => {
    render(
      <MemoryRouter initialEntries={["/vault/boulder"]}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(api.getVaultDetail).toHaveBeenCalledWith("boulder");
    });
  });

  it("VaultDetail emits the Tokens link with the full `/vault/<name>/tokens` shape", async () => {
    render(
      <MemoryRouter initialEntries={["/vault/boulder"]}>
        <App />
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: /Tokens/ });
    expect(link).toHaveAttribute("href", "/vault/boulder/tokens");
  });

  it("nav-bar shows the generic Vaults link", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Vaults" })).toBeInTheDocument();
  });
});
