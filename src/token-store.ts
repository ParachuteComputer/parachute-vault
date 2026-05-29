/**
 * Token operations for the per-vault `tokens` table.
 *
 * VESTIGIAL as of 0.6.0 (vault#282 Stage 2). Vault is a pure hub
 * resource-server: it no longer mints (`pvt_*`) or validates rows in this
 * table. What survives here:
 *   - `listTokens` / `revokeToken` / `findTokensReferencingTag` — read/clean up
 *     any leftover pre-0.6.0 rows.
 *   - `migrateVaultKeys` — the legacy-YAML-api_keys import landing zone (raw
 *     INSERT; the only writer left).
 *   - the `mcp_mint_ledger` helpers — hub-JWT attribution for manage-token.
 *
 * The `Token`/field docs below describe the historical (pre-0.6.0) auth
 * semantics for the surviving read/cleanup paths; no validation path reads
 * `scoped_tags` / `vault_name` off these rows anymore.
 *
 * Permission levels ("full" / "read") and the legacy "admin"/"write" → "full"
 * normalization are kept for displaying any leftover rows.
 */

import { Database } from "bun:sqlite";
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
  /**
   * Tag-allowlist (root tag names). When non-null, the token's effective
   * access is the intersection of `scopes` and notes carrying one of these
   * tags or a sub-tag thereof (hierarchy expansion via getTagDescendants).
   * NULL = unscoped, full vault access per `scopes`. See
   * patterns/tag-scoped-tokens.md.
   */
  scoped_tags: string[] | null;
  /**
   * Per-vault binding (v16). Non-null = token can only authenticate against
   * this vault; cross-vault presentation rejects in
   * `authenticateVaultRequest`. NULL = legacy / server-wide token, accepted
   * for any vault. See vault#257.
   */
  vault_name: string | null;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  /**
   * Provenance (v19). 'mcp_mint' = minted via manage-token MCP tool;
   * NULL = pre-v19 / CLI / REST / YAML-import. Used by manage-token list
   * to restrict the surface to MCP-session-managed tokens. See vault#376.
   */
  created_via: string | null;
  /**
   * Session pin (v19). When this token was minted via manage-token, this
   * is the hub JWT's jti claim of the minting session. NULL otherwise.
   * (Vestigial post-0.6.0 — no new rows are written; vault no longer mints
   * vault-DB tokens. See vault#282 Stage 2.)
   */
  parent_jti: string | null;
  /**
   * Soft-revoke timestamp (v19). Marked the row revoked while keeping it in
   * place for audit history. Vestigial post-0.6.0 (vault#282 Stage 2) — no
   * validation path reads these rows anymore. NULL = active.
   */
  revoked_at: string | null;
}

/**
 * Parse the JSON-encoded `scoped_tags` column. Returns null for NULL/empty
 * input. Defensive: malformed JSON or non-array shapes degrade to null
 * (treat as unscoped) rather than throwing — a corrupt column value
 * shouldn't take down auth; it just means the token loses its tag scope.
 */
export function parseScopedTags(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const tags = parsed.filter((t): t is string => typeof t === "string" && t.length > 0);
    return tags.length === 0 ? null : tags;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token operations
//
// vault#282 Stage 2: the pvt_* mint (`generateToken` / `createToken`) and
// validation (`resolveToken`) were removed at 0.6.0 — vault is a pure hub
// resource-server and no longer issues or accepts opaque vault-DB tokens.
// What survives: `listTokens` / `revokeToken` (cleanup of vestigial pre-0.6.0
// rows), the YAML-import landing zone (`migrateVaultKeys`, raw INSERT), and the
// `mcp_mint_ledger` machinery (hub-JWT attribution for manage-token).
// ---------------------------------------------------------------------------

/**
 * List tokens (for CLI display + admin SPA). Never exposes the hash
 * directly — shows a truncated prefix for identification.
 *
 * Filtering (v16): pass `{ vaultName }` to scope the result to tokens
 * bound to that vault. The filter is `vault_name = $vaultName OR
 * vault_name IS NULL` — legacy server-wide tokens (NULL) remain visible
 * inside every per-vault listing, since they authenticate cross-vault
 * by design and the operator should see them in any vault's admin UI
 * to revoke. Pass no filter (or `vaultName: null`) to list everything.
 */
export function listTokens(
  db: Database,
  opts: { vaultName?: string | null } = {},
): (Token & { id: string })[] {
  const where = opts.vaultName ? "WHERE vault_name = ? OR vault_name IS NULL" : "";
  const params = opts.vaultName ? [opts.vaultName] : [];
  const rows = db.prepare(`
    SELECT token_hash, label, permission, scope_tag, scope_path_prefix,
           scoped_tags, vault_name, expires_at, created_at, last_used_at,
           created_via, parent_jti, revoked_at
    FROM tokens ${where}
    ORDER BY created_at DESC
  `).all(...params) as (Omit<Token, "scoped_tags"> & { scoped_tags: string | null })[];

  return rows.map((r) => ({
    ...r,
    permission: normalizePermission(r.permission),
    scoped_tags: parseScopedTags(r.scoped_tags),
    // Derive a short display ID from the hash (first 12 chars after "sha256:")
    id: `t_${r.token_hash.slice(7, 19)}`,
  }));
}

// ---------------------------------------------------------------------------
// mcp_mint_ledger — session-pinned index of HUB JWTs minted by manage-token
// (vault#403, MGT). After the auth-unification arc the tool mints hub JWTs,
// not pvt_* rows, so the session attribution (parent_jti → minted jti) lives
// here instead of in the `tokens` table. Rows are NOT credentials — only the
// hub `jti` (the revocation handle) plus display metadata is stored; the
// signed token never touches the vault DB.
// ---------------------------------------------------------------------------

/**
 * Record a hub-minted JWT in the session-pinned ledger. `jti` is hub's
 * returned jti; `parentJti` is the minting MCP session (the caller's
 * `caller_jti`).
 *
 * Uses INSERT OR IGNORE, NOT OR REPLACE: hub guarantees jti uniqueness, so a
 * pre-existing row with this jti shouldn't happen. If it does, it's a real bug
 * (a hub jti collision) — we log a warning and KEEP the existing row rather
 * than overwriting it, because OR REPLACE would silently reset a previously-set
 * `revoked_at` and resurrect a revoked token in the list/revoke surface.
 */
export function recordMcpMintLedger(
  db: Database,
  entry: {
    jti: string;
    parentJti: string;
    vaultName: string;
    label: string;
    scopes: string[];
    scopedTags: string[] | null;
    expiresAt: string | null;
  },
): void {
  const scopedTags = entry.scopedTags && entry.scopedTags.length > 0 ? entry.scopedTags : null;
  const result = db.prepare(`
    INSERT OR IGNORE INTO mcp_mint_ledger
      (jti, parent_jti, vault_name, label, scopes, scoped_tags, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    entry.jti,
    entry.parentJti,
    entry.vaultName,
    entry.label,
    serializeScopes(entry.scopes),
    scopedTags ? JSON.stringify(scopedTags) : null,
    new Date().toISOString(),
    entry.expiresAt,
  );
  if (result.changes === 0) {
    // Row already existed — IGNORE swallowed the conflict. Surface it: a hub
    // jti collision is a real bug worth investigating (the existing row is
    // left untouched, including any `revoked_at`).
    console.warn(
      `[manage-token] mcp_mint_ledger already has a row for jti '${entry.jti}' — skipped insert (kept existing row). A hub jti collision shouldn't happen; investigate.`,
    );
  }
}

/**
 * List hub JWTs minted by a given MCP session (parent_jti) against a vault.
 * Returns metadata only (the hub `jti`, label, scopes, timestamps) so the
 * manage-token list surface stays session-scoped. Includes `revoked_at` so
 * callers can render a tombstone for soft-revoked rows.
 */
export function listMcpMintedHubJwts(
  db: Database,
  parentJti: string,
  vaultName: string,
): Array<{
  jti: string;
  label: string;
  scopes: string[];
  scoped_tags: string[] | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}> {
  const rows = db.prepare(`
    SELECT jti, label, scopes, scoped_tags, created_at, expires_at, revoked_at
    FROM mcp_mint_ledger
    WHERE parent_jti = ? AND vault_name = ?
    ORDER BY created_at DESC
  `).all(parentJti, vaultName) as {
    jti: string;
    label: string;
    scopes: string | null;
    scoped_tags: string | null;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
  }[];
  return rows.map((r) => ({
    jti: r.jti,
    label: r.label,
    scopes: parseScopes(r.scopes),
    scoped_tags: parseScopedTags(r.scoped_tags),
    created_at: r.created_at,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
  }));
}

/**
 * Look up a single ledger row by (jti, parent_jti, vault_name) — the
 * session-pin gate for revoke. Returns null when the jti isn't in THIS
 * session's ledger (a different session's mint, or a never-minted jti),
 * which the caller turns into the not_found path. Returns the row (incl.
 * `revoked_at`) when it belongs to this session.
 */
export function findMcpMintLedgerEntry(
  db: Database,
  jti: string,
  parentJti: string,
  vaultName: string,
): { jti: string; revoked_at: string | null } | null {
  const row = db.prepare(`
    SELECT jti, revoked_at FROM mcp_mint_ledger
    WHERE jti = ? AND parent_jti = ? AND vault_name = ?
    LIMIT 1
  `).get(jti, parentJti, vaultName) as { jti: string; revoked_at: string | null } | null;
  return row ?? null;
}

/**
 * Mark a ledger row revoked (the local attribution-side soft-revoke; the
 * authoritative revocation happens in hub's registry via the revoke-token
 * call). Idempotent: a second call on an already-revoked row leaves the
 * existing timestamp in place. Only flips rows belonging to the given
 * session — defense-in-depth on top of the caller's `findMcpMintLedgerEntry`
 * gate.
 */
export function markMcpMintLedgerRevoked(
  db: Database,
  jti: string,
  parentJti: string,
  vaultName: string,
): void {
  db.prepare(`
    UPDATE mcp_mint_ledger SET revoked_at = ?
    WHERE jti = ? AND parent_jti = ? AND vault_name = ? AND revoked_at IS NULL
  `).run(new Date().toISOString(), jti, parentJti, vaultName);
}

/**
 * Find tokens whose `scoped_tags` allowlist references the given root tag.
 * Used by tag-delete and tag-merge to fail-closed (409) when removing a
 * tag would silently orphan a tag-scoped token's allowlist entry.
 *
 * Returns display ID + label pairs (no token-hash exposure) so error
 * envelopes can name the offending tokens for the operator. The match is
 * exact on the root name — `scoped_tags` only ever stores roots per
 * patterns/tag-scoped-tokens.md.
 */
export function findTokensReferencingTag(
  db: Database,
  tag: string,
): { id: string; label: string }[] {
  const rows = db.prepare(`
    SELECT token_hash, label, scoped_tags
    FROM tokens
    WHERE scoped_tags IS NOT NULL
  `).all() as { token_hash: string; label: string; scoped_tags: string | null }[];

  const matches: { id: string; label: string }[] = [];
  for (const row of rows) {
    const tags = parseScopedTags(row.scoped_tags);
    if (tags && tags.includes(tag)) {
      matches.push({ id: `t_${row.token_hash.slice(7, 19)}`, label: row.label });
    }
  }
  return matches;
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
  const deleted = db.prepare(
    "DELETE FROM tokens WHERE token_hash = ? RETURNING token_hash",
  ).get(idOrHash) as { token_hash: string } | null;
  return deleted !== null;
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
