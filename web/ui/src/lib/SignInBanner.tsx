/**
 * `SignInBanner` — the auth-required empty state for the vault admin SPA.
 *
 * Replaces the older "Open this page from the hub's directory" copy. With
 * silent token refresh (see `auth.ts:ensureToken`) the only remaining
 * paths into this banner are:
 *
 *   1. Operator isn't signed in to the hub (no session cookie). Hub's
 *      `/admin/vault-admin-token/<name>` returns 401.
 *   2. The session cookie expired or was revoked. Same 401 from hub.
 *   3. Operator is signed in but isn't the first admin (the multi-user
 *      Phase 1 gate). Hub returns 403 (`not_admin`).
 *   4. The vault name isn't installed on this hub. Hub returns 404.
 *
 * For cases 1+2 the operator needs to sign in at hub's `/login`. We
 * surface a direct link with a `?next=` continuation back to the current
 * URL so they land back on the admin page once authenticated.
 *
 * Case 3 (403) is different: the operator IS signed in — they just aren't
 * the hub admin, and vault management is admin-only (multi-user Phase 1).
 * Sending them to `/login` loops them forever: they sign in again as the
 * same non-admin, get the same 403, repeat (vault#451). So we branch the
 * 403 to "you're signed in, but this is admin-only" copy with a link to
 * `/account/` (their actual home on the hub) instead of the sign-in CTA.
 * The recovery poll is also stopped for 403 — re-minting can never succeed
 * for a non-admin session, so polling would burn requests with no payoff.
 *
 * Case 4 (404) shows distinct "no such vault" copy but keeps the sign-in
 * CTA + poll (rendering-equivalent to the 401 path — there's no better
 * SPA-side unblock for a vault that isn't reachable through this hub).
 *
 * To make the recovery loop genuinely hands-off for the recoverable cases
 * (401/404/null), the banner polls `ensureToken` every 5s. The instant the
 * operator signs into the hub in another tab, the next poll succeeds and
 * `onRecovered()` fires so the parent route re-attempts its data load. No
 * manual refresh needed.
 *
 * The poll is gated on `document.visibilityState === "visible"` so a
 * background tab doesn't spam the hub once a minute for a session that
 * may never materialize. The poll resumes on `visibilitychange`.
 */
import { useEffect } from "react";
import { ensureToken } from "./auth.ts";

const POLL_INTERVAL_MS = 5000;

export interface SignInBannerProps {
  /** Vault name for the default per-vault poll (`ensureToken(vaultName)`).
   *  Multi-vault mode (the `/vault/admin/` home) has no single vault — it
   *  omits this and supplies `ensure` instead. */
  vaultName?: string;
  /**
   * Override the poll's mint attempt. The default is the per-vault
   * `ensureToken(vaultName)`; the multi-vault home passes
   * `ensureHostAdminToken` so recovery tracks the host-admin mint its
   * create/delete actions actually need. Only `kind === "ok"` is read.
   */
  ensure?: () => Promise<{ kind: string }>;
  /**
   * Status code from the most recent attempt. Drives the copy + CTA:
   *   - 401 / null → "you're not signed in" + sign-in CTA (the recoverable
   *     default; `null` = first attempt failed before a status, e.g.
   *     `getToken()` returned null at bootstrap and we never hit the mint
   *     endpoint).
   *   - 403 → "you're signed in, but management is admin-only" + a link to
   *     `/account/` (vault#451 — sign-in would loop a non-admin forever).
   *   - 404 → "this hub doesn't host that vault" + sign-in CTA.
   */
  status?: number | null;
  /** Called when the poll succeeds. Parent re-fires its data load. */
  onRecovered: () => void;
}

export function SignInBanner({ vaultName, status, onRecovered, ensure }: SignInBannerProps) {
  // A 403 (`not_admin`) can never recover for this session — the operator is
  // signed in but isn't the hub admin. Polling would re-mint forever with no
  // payoff, so we don't start the poll at all. See vault#451.
  const isForbidden = status === 403;

  useEffect(() => {
    if (isForbidden) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      // Skip work when the tab is hidden. Don't reschedule — the
      // visibilitychange listener below fires an immediate poll on
      // resume, which then chain-schedules the next tick. Rescheduling
      // here would burn a setTimeout queue entry every POLL_INTERVAL_MS
      // for the entire time the tab is backgrounded with no payoff.
      // Reviewer-flagged on vault#395.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      const result = await (ensure ? ensure() : ensureToken(vaultName ?? ""));
      if (cancelled) return;
      if (result.kind === "ok") {
        onRecovered();
        return;
      }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    // Fire a single tick on resume so a tab that returns from background
    // doesn't wait POLL_INTERVAL_MS for the next scheduled check.
    const onVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "visible") {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        void poll();
      }
    };

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [vaultName, onRecovered, isForbidden, ensure]);

  // 403: signed in but not the hub admin. Don't offer sign-in (it loops);
  // point them at their account home instead. No auto-refresh — this state
  // can't recover for a non-admin session.
  if (isForbidden) {
    return (
      <div className="warn-banner" role="status">
        <p style={{ margin: "0 0 0.5rem" }}>
          You're signed in, but vault management is restricted to the hub admin.{" "}
          <a href="/account/">Go to your account →</a>
        </p>
        <p className="dim" style={{ margin: 0, fontSize: "0.85rem" }}>
          Ask the hub admin if you need access to manage this vault.
        </p>
      </div>
    );
  }

  const next = composeNext();
  const loginHref = `/login?next=${encodeURIComponent(next)}`;
  const headline =
    status === 404
      ? "This hub doesn't host a vault by that name."
      : "You're not signed in to the hub.";

  return (
    <div className="warn-banner" role="status">
      <p style={{ margin: "0 0 0.5rem" }}>
        {headline} <a href={loginHref}>Sign in to the hub →</a>
      </p>
      <p className="dim" style={{ margin: 0, fontSize: "0.85rem" }}>
        After signing in, this page will refresh automatically.
      </p>
    </div>
  );
}

/** Compose the `?next=` value for hub's login redirect. We want the
 *  operator to land back at the current URL after they sign in, so the
 *  vault SPA re-bootstraps + the silent-refresh path picks up a fresh
 *  session cookie. Use the full `pathname + search + hash` — same shape
 *  hub's login form expects (see `parachute-hub/src/admin-login-ui.ts`). */
function composeNext(): string {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}
