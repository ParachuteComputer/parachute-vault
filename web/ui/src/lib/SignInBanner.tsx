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
 *      Phase 1 gate). Hub returns 403.
 *   4. The vault name isn't installed on this hub. Hub returns 404.
 *
 * For cases 1+2 the operator needs to sign in at hub's `/login`. We
 * surface a direct link with a `?next=` continuation back to the current
 * URL so they land back on the admin page once authenticated. Cases 3+4
 * also show the link — there isn't a better unblock from the SPA's side
 * (a "sign out, sign in as someone else" is rare in single-operator
 * deploys; a 404 means the vault isn't reachable through this hub at
 * all, which is operationally distinct but rendering-equivalent).
 *
 * To make the recovery loop genuinely hands-off, the banner polls
 * `ensureToken` every 5s. The instant the operator signs into the hub
 * in another tab, the next poll succeeds and `onRecovered()` fires so
 * the parent route re-attempts its data load. No manual refresh needed.
 *
 * The poll is gated on `document.visibilityState === "visible"` so a
 * background tab doesn't spam the hub once a minute for a session that
 * may never materialize. The poll resumes on `visibilitychange`.
 */
import { useEffect } from "react";
import { ensureToken } from "./auth.ts";

const POLL_INTERVAL_MS = 5000;

export interface SignInBannerProps {
  /** Vault name. Used both for the poll-retry call and to compose the
   *  `?next=` parameter on the hub `/login` link. */
  vaultName: string;
  /**
   * Status code from the most recent attempt. Lets us tweak the copy a
   * little — 404 means "this hub doesn't host that vault" rather than
   * "sign in" — though all four (401/403/404 + null) surface the same
   * sign-in CTA since hub login is the only safe unblock from the SPA's
   * side. `null` = first attempt failed before we got a status (e.g.
   * `getToken()` returned null at bootstrap and we never even tried the
   * mint endpoint).
   */
  status?: number | null;
  /** Called when the poll succeeds. Parent re-fires its data load. */
  onRecovered: () => void;
}

export function SignInBanner({ vaultName, status, onRecovered }: SignInBannerProps) {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      // Skip work when the tab is hidden — schedule another tick so the
      // visibilitychange listener can immediately fire one on resume.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        return;
      }
      const result = await ensureToken(vaultName);
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
  }, [vaultName, onRecovered]);

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
