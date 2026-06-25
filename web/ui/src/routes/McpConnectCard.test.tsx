/**
 * McpConnectCard tests — the vault admin SPA's "Connect to your AI" surface.
 *
 * Covers:
 *   - the pure endpoint/command builders (the load-bearing strings the
 *     operator pastes into a terminal);
 *   - the rendered card showing the correct `<origin>/vault/<name>/mcp`
 *     endpoint + the `claude mcp add` OAuth command for a given vault name;
 *   - deriving the hub origin from `window.location.origin` (no explicit
 *     `origin` prop) — the real production path;
 *   - the Copy affordance writing the real command to the clipboard.
 *
 * Wrapped in `MemoryRouter` because the card renders a React Router `Link`
 * when `tokensHref` is supplied.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  McpConnectCard,
  claudeMcpAddCommand,
  mcpEndpointFor,
} from "./McpConnectCard.tsx";

function renderCard(props: { vaultName: string; origin?: string; tokensHref?: string }) {
  return render(
    <MemoryRouter>
      <McpConnectCard {...props} />
    </MemoryRouter>,
  );
}

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  vi.clearAllMocks();
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("command builders", () => {
  it("derives the MCP endpoint from the origin + vault name, stripping a trailing slash", () => {
    expect(mcpEndpointFor("https://hub.example.ts.net", "work")).toBe(
      "https://hub.example.ts.net/vault/work/mcp",
    );
    expect(mcpEndpointFor("https://hub.example.ts.net/", "work")).toBe(
      "https://hub.example.ts.net/vault/work/mcp",
    );
  });

  it("URL-encodes a vault name with reserved characters", () => {
    expect(mcpEndpointFor("https://hub.example.ts.net", "my vault")).toBe(
      "https://hub.example.ts.net/vault/my%20vault/mcp",
    );
  });

  it("builds the OAuth `claude mcp add` command with no token", () => {
    expect(claudeMcpAddCommand("https://hub.example.ts.net", "work")).toBe(
      "claude mcp add --transport http parachute-work https://hub.example.ts.net/vault/work/mcp",
    );
  });

  it("handles a slug-style multi-segment vault name (hyphens) — the real-world case", () => {
    // Vault names are slug-constrained at creation (lowercase letters, digits,
    // hyphens, underscores — see MultiVaultHome's validateNewVaultName), so a
    // shell-safe `parachute-<name>` server label is always produced.
    expect(claudeMcpAddCommand("https://hub.example.ts.net", "my-work-vault")).toBe(
      "claude mcp add --transport http parachute-my-work-vault https://hub.example.ts.net/vault/my-work-vault/mcp",
    );
    // Underscores are also slug-valid — same shell-safe shape.
    expect(claudeMcpAddCommand("https://hub.example.ts.net", "scratch_pad")).toBe(
      "claude mcp add --transport http parachute-scratch_pad https://hub.example.ts.net/vault/scratch_pad/mcp",
    );
  });
});

describe("McpConnectCard", () => {
  const ORIGIN = "https://hub.example.ts.net";

  it("renders the correct /vault/<name>/mcp endpoint for the given origin + vault", () => {
    renderCard({ vaultName: "work", origin: ORIGIN });
    expect(screen.getByTestId("mcp-endpoint")).toHaveTextContent(
      "https://hub.example.ts.net/vault/work/mcp",
    );
  });

  it("renders the `claude mcp add` OAuth command (no token in the command)", () => {
    renderCard({ vaultName: "work", origin: ORIGIN });
    const cmd = screen.getByTestId("mcp-add-command");
    expect(cmd).toHaveTextContent(
      "claude mcp add --transport http parachute-work https://hub.example.ts.net/vault/work/mcp",
    );
    // The default command carries NO bearer header — OAuth is the path.
    expect(cmd.textContent).not.toContain("Authorization");
  });

  it("derives the hub origin from window.location.origin when no origin prop is passed", () => {
    // jsdom's default location is http://localhost:3000 — the SPA is served
    // at <hub-origin>/vault/<name>/admin, so window.location.origin IS the
    // hub origin in production. This pins that derivation path.
    renderCard({ vaultName: "boulder" });
    expect(screen.getByTestId("mcp-endpoint")).toHaveTextContent(
      `${window.location.origin}/vault/boulder/mcp`,
    );
    expect(screen.getByTestId("mcp-add-command")).toHaveTextContent(
      `claude mcp add --transport http parachute-boulder ${window.location.origin}/vault/boulder/mcp`,
    );
  });

  it("copies the real `claude mcp add` command to the clipboard via its Copy button", async () => {
    renderCard({ vaultName: "work", origin: ORIGIN });
    // Two copy buttons: endpoint (first), command (second).
    const copyButtons = screen.getAllByRole("button", { name: /^copy$/i });
    fireEvent.click(copyButtons[1]);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "claude mcp add --transport http parachute-work https://hub.example.ts.net/vault/work/mcp",
      ),
    );
  });

  it("copies the endpoint URL to the clipboard via its Copy button", async () => {
    renderCard({ vaultName: "work", origin: ORIGIN });
    const copyButtons = screen.getAllByRole("button", { name: /^copy$/i });
    fireEvent.click(copyButtons[0]);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://hub.example.ts.net/vault/work/mcp"),
    );
  });

  it("links the Tokens page to the supplied in-SPA route when tokensHref is given", () => {
    renderCard({ vaultName: "work", origin: ORIGIN, tokensHref: "/tokens" });
    const link = screen.getByRole("link", { name: /tokens page/i });
    expect(link).toHaveAttribute("href", "/tokens");
  });

  it("links to the full connect docs", () => {
    renderCard({ vaultName: "work", origin: ORIGIN });
    expect(screen.getByRole("link", { name: /full connect docs/i })).toHaveAttribute(
      "href",
      "https://parachute.computer/install#connect-mcp-clients",
    );
  });
});
