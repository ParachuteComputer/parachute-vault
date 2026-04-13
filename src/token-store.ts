/**
 * Token operations for per-vault token management.
 *
 * Tokens live in each vault's SQLite database (the `tokens` table is part of
 * the vault schema as of v7). All functions take a Database parameter — the
 * vault's own DB connection.
 *
 * Tokens support three permission levels (admin/write/read) and optional
 * scope filtering by tag or path prefix.
 */

import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { hashKey } from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenPermission = "admin" | "write" | "read";

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
    /** @deprecated Written to DB but not enforced at runtime. */
    scope_tag?: string | null;
    /** @deprecated Written to DB but not enforced at runtime. */
    scope_path_prefix?: string | null;
    expires_at?: string | null;
  },
): Token {
  const tokenHash = hashKey(fullToken);
  const now = new Date().toISOString();
  const permission = opts.permission ?? "admin";

  db.prepare(`
    INSERT INTO tokens (token_hash, label, permission, scope_tag, scope_path_prefix, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenHash,
    opts.label,
    permission,
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
    SELECT token_hash, permission, expires_at
    FROM tokens WHERE token_hash = ?
  `).get(candidateHash) as {
    token_hash: string;
    permission: TokenPermission;
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

  return { permission: row.permission };
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
      db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(rows[0].token_hash);
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
 * - Global keys from config.yaml (they become admin tokens in every vault)
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
      db.prepare(`
        INSERT INTO tokens (token_hash, label, permission, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        key.key_hash,
        key.label,
        key.scope === "read" ? "read" : "admin",
        key.created_at,
        key.last_used_at ?? null,
      );
      migrated++;
    }
  }

  // Import global keys as admin tokens
  if (globalKeys) {
    for (const key of globalKeys) {
      const exists = db.prepare("SELECT 1 FROM tokens WHERE token_hash = ?").get(key.key_hash);
      if (!exists) {
        db.prepare(`
          INSERT INTO tokens (token_hash, label, permission, created_at, last_used_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          key.key_hash,
          key.label,
          "admin",
          key.created_at,
          key.last_used_at ?? null,
        );
        migrated++;
      }
    }
  }

  return migrated;
}
