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
  it("401: 'not signed in' headline + sign-in CTA", async () => {
    render(<SignInBanner vaultName="default" status={401} onRecovered={() => {}} />);
    // The banner probes the mint before committing to copy (vault#642), so the
    // signed-out claim lands one tick in — never on a guess.
    await vi.waitFor(() =>
      expect(screen.getByText(/not signed in to the hub/i)).toBeInTheDocument(),
    );
    const link = screen.getByRole("link", { name: /sign in to the hub/i });
    expect(link.getAttribute("href")).toContain("/login?next=");
  });

  it("null (pre-status): same sign-in CTA as 401", async () => {
    render(<SignInBanner vaultName="default" status={null} onRecovered={() => {}} />);
    await vi.waitFor(() =>
      expect(screen.getByText(/not signed in to the hub/i)).toBeInTheDocument(),
    );
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

  it("404: distinct 'no such vault' headline, keeps sign-in CTA", async () => {
    render(<SignInBanner vaultName="ghost" status={404} onRecovered={() => {}} />);
    await vi.waitFor(() =>
      expect(screen.getByText(/doesn't host a vault by that name/i)).toBeInTheDocument(),
    );
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

  it("404: still polls — sign-in can recover a not-yet-reachable vault", async () => {
    render(<SignInBanner vaultName="ghost" status={404} onRecovered={() => {}} />);
    await vi.advanceTimersByTimeAsync(5000);
    expect(auth.ensureToken).toHaveBeenCalledWith("ghost");
  });

  it("403: never polls — it can't recover for a non-admin (vault#451)", async () => {
    render(<SignInBanner vaultName="default" status={403} onRecovered={() => {}} />);
    await vi.advanceTimersByTimeAsync(15000);
    expect(auth.ensureToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// vault#642 — the banner must not claim you're signed out when you aren't.
//
// The incident: scope-guard couldn't reach its revocation list, so the vault
// rejected every hub-issued JWT with `revocation_unavailable`. Vault's routes
// map that 401 straight to this banner, which told a fully-signed-in operator
// "You're not signed in to the hub." Signing in again could never help — and
// the recovery poll made it worse, because it tested the token MINT (which
// worked fine) rather than the request that was failing: mint ok →
// onRecovered() → parent reloads → 401 → banner → mint ok → … every 5s.
// ---------------------------------------------------------------------------
describe("SignInBanner — mint succeeds but the API still 401s (vault#642)", () => {
  beforeEach(() => {
    // The discriminator: minting works. So the operator IS signed in.
    vi.mocked(auth.ensureToken).mockResolvedValue({ kind: "ok", token: "jwt" });
  });

  it("says the SERVER rejected the request — never 'you're not signed in'", async () => {
    render(<SignInBanner vaultName="default" status={401} onRecovered={() => {}} />);
    await vi.waitFor(() =>
      expect(
        screen.getByText(/you're signed in, but this vault rejected the request/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/not signed in to the hub/i)).not.toBeInTheDocument();
    // And no sign-in CTA — following it lands you right back here.
    expect(
      screen.queryByRole("link", { name: /sign in to the hub/i }),
    ).not.toBeInTheDocument();
  });

  it("surfaces the server's own reason, the only written record of the cause", async () => {
    render(
      <SignInBanner
        vaultName="default"
        status={401}
        serverMessage="token cannot be validated: revocation list unavailable"
        onRecovered={() => {}}
      />,
    );
    await vi.waitFor(() =>
      expect(
        screen.getByText(/revocation list unavailable/i),
      ).toBeInTheDocument(),
    );
  });

  it("does NOT hot-loop onRecovered every 5s — the bug that made it unusable", async () => {
    const onRecovered = vi.fn();
    render(<SignInBanner vaultName="default" status={401} onRecovered={onRecovered} />);
    await vi.waitFor(() =>
      expect(
        screen.getByText(/this vault rejected the request/i),
      ).toBeInTheDocument(),
    );
    onRecovered.mockClear();

    // Assert the CADENCE over a long window rather than a single tick —
    // `vi.waitFor` consumes an indeterminate amount of the pending timer, so
    // absolute timings after it aren't reproducible.
    await vi.advanceTimersByTimeAsync(60_000);
    const calls = onRecovered.mock.calls.length;

    // The old 5s loop would have fired ~12 times in this window. The 30s
    // server-healed retry fires ~2. The gap is the whole point.
    expect(calls).toBeGreaterThan(0); // it does still retry — the server may heal
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("a genuinely signed-out operator still gets the sign-in CTA and the 5s poll", async () => {
    vi.mocked(auth.ensureToken).mockResolvedValue({ kind: "auth-required", status: 401 });
    const onRecovered = vi.fn();
    render(<SignInBanner vaultName="default" status={401} onRecovered={onRecovered} />);
    await vi.waitFor(() =>
      expect(screen.getByText(/not signed in to the hub/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /sign in to the hub/i })).toBeInTheDocument();

    // Operator signs in elsewhere → the next poll mints and recovers promptly.
    vi.mocked(auth.ensureToken).mockResolvedValue({ kind: "ok", token: "jwt" });
    await vi.advanceTimersByTimeAsync(5_100);
    expect(onRecovered).toHaveBeenCalled();
  });
});
