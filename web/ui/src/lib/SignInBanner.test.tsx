/**
 * SignInBanner copy + CTA + poll behavior.
 *
 * The banner renders the auth-required empty state for the vault admin SPA.
 * Status code drives both the copy and the recovery affordance:
 *   - 401 / null → "not signed in" + sign-in CTA (poll active)
 *   - 403        → "signed in but admin-only" + /account/ link (poll OFF)
 *   - 404        → "no such vault" + sign-in CTA (poll active)
 *
 * vault#451: 403 must NOT render the "not signed in" copy or the sign-in CTA —
 * that loops a non-admin operator forever — and must not poll (it can never
 * recover for that session).
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInBanner } from "./SignInBanner.tsx";

// Auto-stub the auth module so the poll never hits the network. We assert on
// whether `ensureToken` is called to verify poll-start vs poll-suppressed.
vi.mock("./auth.ts");
import * as auth from "./auth.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(auth.ensureToken).mockResolvedValue({ kind: "auth-required", status: 401 });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("SignInBanner — copy + CTA per status", () => {
  it("401: 'not signed in' headline + sign-in CTA", () => {
    render(<SignInBanner vaultName="default" status={401} onRecovered={() => {}} />);
    expect(screen.getByText(/not signed in to the hub/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /sign in to the hub/i });
    expect(link.getAttribute("href")).toContain("/login?next=");
  });

  it("null (pre-status): same sign-in CTA as 401", () => {
    render(<SignInBanner vaultName="default" status={null} onRecovered={() => {}} />);
    expect(screen.getByText(/not signed in to the hub/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /sign in to the hub/i }).getAttribute("href"),
    ).toContain("/login?next=");
  });

  it("403: 'restricted to the hub admin' + /account/ link, NOT sign-in (vault#451)", () => {
    render(<SignInBanner vaultName="default" status={403} onRecovered={() => {}} />);
    expect(
      screen.getByText(/vault management is restricted to the hub admin/i),
    ).toBeInTheDocument();
    // No "not signed in" copy, no sign-in CTA.
    expect(screen.queryByText(/not signed in/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /sign in to the hub/i })).not.toBeInTheDocument();
    // Links to the operator's account home, not /login.
    const link = screen.getByRole("link", { name: /go to your account/i });
    expect(link.getAttribute("href")).toBe("/account/");
  });

  it("404: distinct 'no such vault' headline, keeps sign-in CTA", () => {
    render(<SignInBanner vaultName="ghost" status={404} onRecovered={() => {}} />);
    expect(screen.getByText(/doesn't host a vault by that name/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /sign in to the hub/i }).getAttribute("href"),
    ).toContain("/login?next=");
  });
});

describe("SignInBanner — recovery poll", () => {
  it("401: starts polling ensureToken", async () => {
    render(<SignInBanner vaultName="default" status={401} onRecovered={() => {}} />);
    await vi.advanceTimersByTimeAsync(5000);
    expect(auth.ensureToken).toHaveBeenCalledWith("default");
  });

  it("403: never polls — it can't recover for a non-admin (vault#451)", async () => {
    render(<SignInBanner vaultName="default" status={403} onRecovered={() => {}} />);
    await vi.advanceTimersByTimeAsync(15000);
    expect(auth.ensureToken).not.toHaveBeenCalled();
  });
});
