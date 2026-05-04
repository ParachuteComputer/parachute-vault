/**
 * Mount detection for the vault admin SPA.
 *
 * Vault#252 moved the SPA from origin-rooted `/admin/*` to per-vault
 * `/vault/<name>/admin/*` so the bundle is reachable through hub's
 * `/vault/<name>/*` proxy. The same compiled bundle has to work at any
 * mount — Vite's `base` is relative (`./`) so asset URLs resolve under
 * whichever path served `index.html`, and the React Router basename has
 * to be discovered at runtime since the vault name isn't known at build
 * time.
 *
 * Two callers today:
 *   - `main.tsx` reads `getBasename()` once at bootstrap to feed
 *     `<BrowserRouter basename={...}>`.
 *   - `App.tsx` reads `getMountedVaultName()` to redirect the `/` route
 *     to the vault's detail page when the SPA is mounted under a
 *     specific vault (no `/vaults/list` round-trip needed — and that
 *     endpoint isn't reachable through the hub proxy anyway).
 */

const MOUNT_RE = /^\/vault\/([^/]+)\/admin(?=\/|$)/;

/**
 * Extract `<name>` from a `/vault/<name>/admin/...` mount, decoded.
 * Returns `null` when the SPA is loaded outside a per-vault mount —
 * i.e. dev served at `/admin/*` or a stand-alone `/`-rooted bundle.
 */
export function getMountedVaultName(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(MOUNT_RE);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    // Malformed percent-encoding — treat as no mount rather than crashing
    // the entire SPA bootstrap.
    return null;
  }
}

/**
 * Compute the React Router basename matching the current mount.
 *
 *   /vault/boulder/admin/...  → "/vault/boulder/admin"
 *   /admin/...                → "/admin"          (legacy / dev fallback)
 *   anything else             → ""                (stand-alone root)
 *
 * The returned value preserves the URL's percent-encoding so React Router
 * matches it byte-for-byte against `window.location.pathname` — decoding
 * would break basename stripping for vault names with URL-reserved
 * characters.
 */
export function getBasename(): string {
  if (typeof window === "undefined") return "";
  const path = window.location.pathname;
  const m = path.match(MOUNT_RE);
  if (m) return `/vault/${m[1]}/admin`;
  if (path === "/admin" || path.startsWith("/admin/")) return "/admin";
  return "";
}
