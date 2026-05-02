/**
 * Token operations for per-vault token management.
 *
 * Tokens live in each vault's SQLite database (the `tokens` table is part of
 * the vault schema as of v7). All functions take a Database parameter — the
 * vault's own DB connection.
 *
 * Two permission levels:
 *   - "full"  — unrestricted access (CRUD, delete, token management)
 *   - "read"  — query-only (no mutations)
 *
 * Legacy "admin" and "write" values in the DB are normalized to "full" at
 * read time for backward compatibility.
 */

import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { hashKey } from "./config.ts";
import { legacyPermissionToScopes, parseScopes, serializeScopes } from "./scopes.ts";

function scopesForMigratedPermission(permission: string): string {
  return serializeScopes(legacyPermissionToScopes(permission));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenPermission = "full" | "read";

/**
 * Normalize legacy permission values ("admin", "write") to the current
 * two-tier model. Existing DB rows may contain the old values.
 */
export function normalizePermission(p: string): TokenPermission {
  if (p === "read") return "read";
  return "full"; // "admin", "write", or anything else → full
}

export interface Token {
  token_hash: string;
  label: string;
  permission: TokenPermission;
  /** @deprecated Scope columns exist in DB but are not enforced at runtime. */
  scope_tag: string | null;
  /** @deprecated Scope columns exist in DB but are not enforced at runtime. */
  scope_path_prefix: string | null;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface ResolvedToken {
  permission: TokenPermission;
  /**
   * Granted scopes, parsed from the token row's `scopes` column. Pre-v12
   * tokens (where the column is NULL) fall back to the legacy permission
   * → scopes mapping and `legacyDerived` is set true so callers can log
   * a deprecation warning on first use.
   */
  scopes: string[];
  /** True iff `scopes` was derived from the legacy `permission` column. */
  legacyDerived: boolean;
}

// ---------------------------------------------------------------------------
// Token operations
// ---------------------------------------------------------------------------

export function generateToken(): { fullToken: string; tokenHash: string } {
  const random = crypto.randomBytes(32).toString("base64url").slice(0, 32);
  const fullToken = `pvt_${random}`;
  return { fullToken, tokenHash: hashKey(fullToken) };
}

export function createToken(
  db: Database,
  fullToken: string,
  opts: {
    label: string;
    permission?: TokenPermission;
    /**
     * Explicit OAuth-standard scopes to persist. If omitted, derived from
     * `permission` (read → [vault:read], anything else → [vault:read,
     * vault:write, vault:admin]). Written as a whitespace-separated string.
     */
    scopes?: string[];
    /** @deprecated Written to DB but not enforced at runtime. */
    scope_tag?: string | null;
    /** @deprecated Written to DB but not enforced at runtime. */
    scope_path_prefix?: string | null;
    expires_at?: string | null;
  },
): Token {
  const tokenHash = hashKey(fullToken);
  const now = new Date().toISOString();
  const permission = opts.permission ?? "full";
  const scopes = opts.scopes ?? legacyPermissionToScopes(permission);
  const scopesStr = serializeScopes(scopes);

  db.prepare(`
    INSERT INTO tokens (token_hash, label, permission, scopes, scope_tag, scope_path_prefix, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenHash,
    opts.label,
    permission,
    scopesStr,
    opts.scope_tag ?? null,
    opts.scope_path_prefix ?? null,
    opts.expires_at ?? null,
    now,
  );

  return {
    token_hash: tokenHash,
    label: opts.label,
    permission,
    scope_tag: opts.scope_tag ?? null,
    scope_path_prefix: opts.scope_path_prefix ?? null,
    expires_at: opts.expires_at ?? null,
    created_at: now,
    last_used_at: null,
  };
}

/**
 * Resolve a bearer token. Returns the token info if valid, null if not found or expired.
 * Updates last_used_at on successful resolution.
 */
export function resolveToken(db: Database, providedToken: string): ResolvedToken | null {
  // Hash-then-lookup: the SQL = comparison on SHA-256 output is not timing-safe,
  // but this is acceptable — the attacker would need to guess a valid SHA-256
  // preimage, which is computationally infeasible regardless of timing leaks.
  const candidateHash = hashKey(providedToken);

  const row = db.prepare(`
    SELECT token_hash, permission, scopes, expires_at
    FROM tokens WHERE token_hash = ?
  `).get(candidateHash) as {
    token_hash: string;
    permission: string;
    scopes: string | null;
    expires_at: string | null;
  } | null;

  if (!row) return null;

  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return null;
  }

  // Update last_used_at
  db.prepare("UPDATE tokens SET last_used_at = ? WHERE token_hash = ?")
    .run(new Date().toISOString(), row.token_hash);

  const permission = normalizePermission(row.permission);
  const parsed = parseScopes(row.scopes);
  const hasVaultScope = parsed.some((s) => s.startsWith("vault:"));
  const scopes = hasVaultScope ? parsed : legacyPermissionToScopes(permission);
  const legacyDerived = !hasVaultScope;

  return { permission, scopes, legacyDerived };
}

/**
 * List all tokens (for CLI display). Never exposes the hash directly —
 * shows a truncated prefix for identification.
 */
export function listTokens(db: Database): (Token & { id: string })[] {
  const rows = db.prepare(`
    SELECT token_hash, label, permission, scope_tag, scope_path_prefix,
           expires_at, created_at, last_used_at
    FROM tokens ORDER BY created_at DESC
  `).all() as Token[];

  return rows.map((r) => ({
    ...r,
    permission: normalizePermission(r.permission),
    // Derive a short display ID from the hash (first 12 chars after "sha256:")
    id: `t_${r.token_hash.slice(7, 19)}`,
  }));
}

/**
 * Revoke (delete) a token by its display ID or full hash.
 * Returns true if exactly one token was deleted.
 * If a display ID prefix matches multiple tokens, returns false (ambiguous).
 */
export function revokeToken(db: Database, idOrHash: string): boolean {
  // Try matching by display ID prefix
  if (idOrHash.startsWith("t_")) {
    const hashPrefix = idOrHash.slice(2);
    const rows = db.prepare(
      "SELECT token_hash FROM tokens WHERE token_hash LIKE ?"
    ).all(`sha256:${hashPrefix}%`) as { token_hash: string }[];
    if (rows.length === 1) {
      db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(rows[0]!.token_hash);
      return true;
    }
    if (rows.length > 1) {
      // Ambiguous prefix — refuse to revoke
      return false;
    }
  }

  // Try matching by full hash
  const result = db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(idOrHash);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Migration: import existing API keys from config.yaml into a vault's DB
// ---------------------------------------------------------------------------

/**
 * Import existing API keys for a specific vault from config.yaml into its DB.
 * Idempotent — skips keys whose hash already exists.
 *
 * Imports:
 * - Per-vault keys from vault.yaml (direct match)
 * - Global keys from config.yaml (they become full-access tokens in every vault)
 */
export function migrateVaultKeys(
  db: Database,
  vaultKeys: { key_hash: string; label: string; scope?: string; created_at: string; last_used_at?: string }[],
  globalKeys?: { key_hash: string; label: string; scope?: string; created_at: string; last_used_at?: string }[],
): number {
  let migrated = 0;

  // Import per-vault keys
  for (const key of vaultKeys) {
    const exists = db.prepare("SELECT 1 FROM tokens WHERE token_hash = ?").get(key.key_hash);
    if (!exists) {
      const permission = key.scope === "read" ? "read" : "full";
      db.prepare(`
        INSERT INTO tokens (token_hash, label, permission, scopes, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        key.key_hash,
        key.label,
        permission,
        scopesForMigratedPermission(permission),
        key.created_at,
        key.last_used_at ?? null,
      );
      migrated++;
    }
  }

  // Import global keys as full-access tokens
  if (globalKeys) {
    for (const key of globalKeys) {
      const exists = db.prepare("SELECT 1 FROM tokens WHERE token_hash = ?").get(key.key_hash);
      if (!exists) {
        db.prepare(`
          INSERT INTO tokens (token_hash, label, permission, scopes, created_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          key.key_hash,
          key.label,
          "full",
          scopesForMigratedPermission("full"),
          key.created_at,
          key.last_used_at ?? null,
        );
        migrated++;
      }
    }
  }

  return migrated;
}
