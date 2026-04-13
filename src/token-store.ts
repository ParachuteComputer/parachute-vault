/**
 * Token store — centralized token management backed by ~/.parachute/tokens.db.
 *
 * Replaces the YAML-based API key storage with a SQLite tokens table.
 * Tokens support three permission levels (admin/write/read) and optional
 * scope filtering by tag or path prefix.
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import crypto from "node:crypto";
import { CONFIG_DIR, readGlobalConfig, readVaultConfig, listVaults, hashKey, verifyKey } from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenPermission = "admin" | "write" | "read";

export interface Token {
  token_hash: string;
  label: string;
  permission: TokenPermission;
  vault: string | null; // NULL = global (all vaults)
  scope_tag: string | null;
  scope_path_prefix: string | null;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface ResolvedToken {
  permission: TokenPermission;
  vault: string | null;
  scope_tag: string | null;
  scope_path_prefix: string | null;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TOKEN_SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'admin',
  vault TEXT,
  scope_tag TEXT,
  scope_path_prefix TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
`;

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

let _db: Database | null = null;

export function getTokenDb(): Database {
  if (_db) return _db;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const dbPath = join(CONFIG_DIR, "tokens.db");
  _db = new Database(dbPath);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec(TOKEN_SCHEMA);
  return _db;
}

/** Close the token DB (for testing). */
export function closeTokenDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Override the token DB (for testing). */
export function setTokenDb(db: Database): void {
  _db = db;
  db.exec(TOKEN_SCHEMA);
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
    vault?: string | null;
    scope_tag?: string | null;
    scope_path_prefix?: string | null;
    expires_at?: string | null;
  },
): Token {
  const tokenHash = hashKey(fullToken);
  const now = new Date().toISOString();
  const permission = opts.permission ?? "admin";

  db.prepare(`
    INSERT INTO tokens (token_hash, label, permission, vault, scope_tag, scope_path_prefix, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenHash,
    opts.label,
    permission,
    opts.vault ?? null,
    opts.scope_tag ?? null,
    opts.scope_path_prefix ?? null,
    opts.expires_at ?? null,
    now,
  );

  return {
    token_hash: tokenHash,
    label: opts.label,
    permission,
    vault: opts.vault ?? null,
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
  const candidateHash = hashKey(providedToken);

  const row = db.prepare(`
    SELECT token_hash, permission, vault, scope_tag, scope_path_prefix, expires_at
    FROM tokens WHERE token_hash = ?
  `).get(candidateHash) as {
    token_hash: string;
    permission: TokenPermission;
    vault: string | null;
    scope_tag: string | null;
    scope_path_prefix: string | null;
    expires_at: string | null;
  } | null;

  if (!row) return null;

  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return null;
  }

  // Update last_used_at (fire-and-forget — don't block the request)
  db.prepare("UPDATE tokens SET last_used_at = ? WHERE token_hash = ?")
    .run(new Date().toISOString(), row.token_hash);

  return {
    permission: row.permission,
    vault: row.vault,
    scope_tag: row.scope_tag,
    scope_path_prefix: row.scope_path_prefix,
  };
}

/**
 * List all tokens (for CLI display). Never exposes the hash directly —
 * shows a truncated prefix for identification.
 */
export function listTokens(db: Database): (Token & { id: string })[] {
  const rows = db.prepare(`
    SELECT token_hash, label, permission, vault, scope_tag, scope_path_prefix,
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
 * Returns true if a token was deleted.
 */
export function revokeToken(db: Database, idOrHash: string): boolean {
  // Try matching by display ID prefix
  if (idOrHash.startsWith("t_")) {
    const hashPrefix = idOrHash.slice(2);
    const row = db.prepare(
      "SELECT token_hash FROM tokens WHERE token_hash LIKE ?"
    ).get(`sha256:${hashPrefix}%`) as { token_hash: string } | null;
    if (row) {
      db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(row.token_hash);
      return true;
    }
  }

  // Try matching by full hash
  const result = db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(idOrHash);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Migration: import existing API keys from config.yaml
// ---------------------------------------------------------------------------

/**
 * Import existing API keys from config.yaml files into the tokens DB.
 * Idempotent — skips keys whose hash already exists.
 */
export function migrateExistingKeys(db: Database): number {
  let migrated = 0;

  // Import global keys
  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys) {
    for (const key of globalConfig.api_keys) {
      const exists = db.prepare(
        "SELECT 1 FROM tokens WHERE token_hash = ?"
      ).get(key.key_hash);
      if (!exists) {
        db.prepare(`
          INSERT INTO tokens (token_hash, label, permission, vault, created_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          key.key_hash,
          key.label,
          "admin", // existing keys become admin tokens
          null,    // global scope
          key.created_at,
          key.last_used_at ?? null,
        );
        migrated++;
      }
    }
  }

  // Import per-vault keys
  for (const vaultName of listVaults()) {
    const vaultConfig = readVaultConfig(vaultName);
    if (!vaultConfig) continue;
    for (const key of vaultConfig.api_keys) {
      const exists = db.prepare(
        "SELECT 1 FROM tokens WHERE token_hash = ?"
      ).get(key.key_hash);
      if (!exists) {
        db.prepare(`
          INSERT INTO tokens (token_hash, label, permission, vault, created_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          key.key_hash,
          key.label,
          key.scope === "read" ? "read" : "admin",
          vaultName,
          key.created_at,
          key.last_used_at ?? null,
        );
        migrated++;
      }
    }
  }

  return migrated;
}
