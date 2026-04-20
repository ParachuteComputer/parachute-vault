/**
 * Scope primitives for Phase 2 enforcement.
 *
 * Tokens carry OAuth-standard whitespace-separated scopes. This module parses,
 * normalizes, and matches them — including the `admin ⊇ write ⊇ read`
 * inheritance rule and the `vault:<name>:<verb>` future-shape synonym
 * (narrowed per-vault scopes are Phase 2+; today we treat them as equivalent
 * to `vault:<verb>`).
 *
 * Legacy back-compat: tokens without any `vault:*` scope — but with a
 * 0.2.x-era `permission = "full" | "read"` — are mapped to the appropriate
 * scope set on the fly. `legacyPermissionToScopes` is marked deprecated and
 * should be removed one release after enforcement lands.
 */

export const SCOPE_READ = "vault:read" as const;
export const SCOPE_WRITE = "vault:write" as const;
export const SCOPE_ADMIN = "vault:admin" as const;

/** All first-class vault scopes in inheritance order (lowest → highest). */
export const VAULT_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN] as const;
export type VaultScope = (typeof VAULT_SCOPES)[number];

/**
 * Parse a whitespace-separated scope string into a normalized scope list.
 *
 * Normalization:
 *   - Empty / null → []
 *   - Trim + split on any whitespace
 *   - `vault:<name>:<verb>` collapses to `vault:<verb>` (per-vault narrowing
 *     is Phase 2+; today it's treated as a synonym)
 *   - Unrecognized scopes are preserved as-is (they just won't match anything)
 */
export function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeScope(s));
}

function normalizeScope(scope: string): string {
  // `vault:<name>:<verb>` → `vault:<verb>` (synonym collapse)
  const parts = scope.split(":");
  if (parts.length === 3 && parts[0] === "vault") {
    const verb = parts[2];
    if (verb === "read" || verb === "write" || verb === "admin") {
      return `vault:${verb}`;
    }
  }
  return scope;
}

/**
 * Return true iff `granted` satisfies `required` under the inheritance rule
 * `admin ⊇ write ⊇ read`. Exact-match required for non-vault scopes.
 */
export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;

  // Inheritance: admin ⊇ write ⊇ read
  if (required === SCOPE_READ) {
    return granted.includes(SCOPE_WRITE) || granted.includes(SCOPE_ADMIN);
  }
  if (required === SCOPE_WRITE) {
    return granted.includes(SCOPE_ADMIN);
  }
  return false;
}

/**
 * Pick the required scope for a given API request.
 *   - GET/HEAD/OPTIONS → read
 *   - POST/PATCH/PUT/DELETE → write
 *
 * Admin-gated endpoints (like `/.parachute/config`) don't go through this
 * helper — they call `hasScope(auth.scopes, SCOPE_ADMIN)` directly.
 */
export function scopeForMethod(method: string): VaultScope {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return SCOPE_READ;
  return SCOPE_WRITE;
}

/**
 * Map a 0.2.x legacy `permission` column value to scopes. Kept for back-compat
 * during the one-release-cycle deprecation window — after that, every token
 * row will carry an explicit `scopes` column and this can go.
 *
 * @deprecated Remove one release after v0.4 scope enforcement lands.
 */
export function legacyPermissionToScopes(permission: string): string[] {
  // "full", "admin", "write" all historically meant unrestricted access
  if (permission === "read") return [SCOPE_READ];
  return [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN];
}

/** Serialize a scope list to an OAuth-standard whitespace-separated string. */
export function serializeScopes(scopes: string[]): string {
  return scopes.join(" ");
}
