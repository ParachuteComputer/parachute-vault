/**
 * Mount detection for the vault admin SPA.
 *
 * Vault#252 moved the SPA from origin-rooted `/admin/*` to per-vault
 * `/vault/<name>/admin/*` so the bundle is reachable through hub's
 * `/vault/<name>/*` proxy. The 2026-06-09 hub-module-boundary migration
 * (B3) added a THIRD mount: the daemon-level multi-vault home at
 * `/vault/admin/*`. The same compiled bundle has to work at any mount —
 * Vite's `base` is relative (`./`) so asset URLs resolve under whichever
 * path served `index.html`, and the React Router basename has to be
 * discovered at runtime since the mount isn't known at build time.
 *
 * Detection order matters: the multi-vault mount is checked FIRST.
 * `/vault/admin/...` would otherwise mis-parse against the per-vault regex
 * — `/vault/admin/admin` reads as vault "admin" — and `admin` is a
 * reserved vault name (the daemon routes `/vault/admin/*` before the
 * per-vault branch for the same reason).
 *
 * Callers today:
 *   - `main.tsx` reads `getBasename()` once at bootstrap to feed
 *     `<BrowserRouter basename={...}>`, and `isMultiVaultMount()` /
 *     `getMountedVaultName()` to decide whether to attempt the per-vault
 *     boot mint (skipped in multi-vault mode — there is no single vault to
 *     mint against; the home view mints host-admin lazily).
 *   - `App.tsx` reads both to pick one of THREE route trees: multi-vault
 *     home, per-vault detail, or the legacy stand-alone picker.
 */

const MULTI_VAULT_MOUNT_RE = /^\/vault\/admin(?=\/|$)/;
const MOUNT_RE = /^\/vault\/([^/]+)\/admin(?=\/|$)/;

/**
 * True when the SPA booted under the daemon-level multi-vault mount
 * (`/vault/admin` or any subpath). Checked before the per-vault detection
 * everywhere — see the module docstring.
 */
export function isMultiVaultMount(): boolean {
  if (typeof window === "undefined") return false;
  return MULTI_VAULT_MOUNT_RE.test(window.location.pathname);
}

/**
 * Extract `<name>` from a `/vault/<name>/admin/...` mount, decoded.
 * Returns `null` when the SPA is loaded outside a per-vault mount —
 * i.e. the multi-vault mount at `/vault/admin/*`, dev served at
 * `/admin/*`, or a stand-alone `/`-rooted bundle.
 */
export function getMountedVaultName(): string | null {
  if (typeof window === "undefined") return null;
  // Multi-vault mount first: `/vault/admin/admin` must NOT read as a
  // per-vault mount for a vault named "admin".
  if (isMultiVaultMount()) return null;
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
 *   /vault/admin/...          → "/vault/admin"   (multi-vault home, B3)
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
  if (MULTI_VAULT_MOUNT_RE.test(path)) return "/vault/admin";
  const m = path.match(MOUNT_RE);
  if (m) return `/vault/${m[1]}/admin`;
  if (path === "/admin" || path.startsWith("/admin/")) return "/admin";
  return "";
}
