/**
 * Authentication and authorization for the vault server.
 *
 * As of 0.5.0 vault is a PURE HUB RESOURCE-SERVER (vault#282 Stage 2). The
 * opaque `pvt_*` vault-DB token was dropped — vault no longer mints or
 * validates it. Three auth paths survive:
 *
 *   1. Hub-issued JWT — the user-credential path. JWT-shaped bearers are
 *      validated against the hub's JWKS (`authenticateHubJwt` → hub-jwt.ts →
 *      scope-guard), audience-pinned to `vault.<name>`, scope-narrowed.
 *   2. VAULT_AUTH_TOKEN — the server-wide operator bearer (env var,
 *      constant-time compare). Short-circuits both auth entry points.
 *   3. Legacy YAML api_keys — hashed keys in vault.yaml / config.yaml. A
 *      separate deprecation axis from pvt_*; still validated here.
 *
 * Permission levels remain "full" / "read"; legacy "admin"/"write" DB values
 * normalize to "full" at read time.
 *
 * The unified /mcp endpoint accepts only VAULT_AUTH_TOKEN + global config.yaml
 * keys — hub JWTs are vault-bound (aud=vault.<name>) and have no single
 * audience to strict-check on the cross-vault surface.
 */

import { readGlobalConfig, writeVaultConfig, writeGlobalConfig, verifyKey } from "./config.ts";
import type { VaultConfig, StoredKey } from "./config.ts";
import type { TokenPermission } from "./token-store.ts";
import crypto from "node:crypto";
import {
  findBroadVaultScopes,
  hasScope,
  hasScopeForVault,
  legacyPermissionToScopes,
  narrowedVaultNames,
  SCOPE_ADMIN,
  SCOPE_READ,
  SCOPE_WRITE,
} from "./scopes.ts";
import { enforceVaultScope } from "@openparachute/scope-guard";
import { HubJwtError, looksLikeJwt, validateHubJwt } from "./hub-jwt.ts";

/**
 * Server-wide operator bearer token, sourced from the `VAULT_AUTH_TOKEN`
 * environment variable.
 *
 * Read dynamically per request (not cached at import time) so test seams
 * that mutate `process.env.VAULT_AUTH_TOKEN` work without re-importing.
 * In production the env var is set at container start and doesn't change.
 *
 * Empty / whitespace-only values are treated as unset — the operator
 * either commits to bearer auth or doesn't, no degraded "empty token
 * always matches" failure mode.
 */
function getServerWideAuthToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.VAULT_AUTH_TOKEN;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Constant-time string equality. Returns false when lengths differ
 * (timingSafeEqual throws on length mismatch; we want a quiet false).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * If `VAULT_AUTH_TOKEN` is set and the provided bearer matches it
 * (constant-time), return a full-admin AuthResult that's accepted by
 * every vault on the server.
 *
 * The operator-channel auth shape for non-loopback deploys (Render,
 * sibling-container setups, vault#339). Hub uses this to call vault
 * across a container boundary; end-user OAuth tokens take the per-vault
 * hub-JWT path below. See `docs/auth-model.md` §2.
 *
 * Scope set is broad (`vault:admin`) — the env-var bearer is an
 * operator credential, not a user credential. Tag-scoping doesn't
 * apply; we represent it as unscoped (`scoped_tags: null`).
 */
function tryServerWideAuth(
  providedKey: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthResult | null {
  const configured = getServerWideAuthToken(env);
  if (configured === null) return null;
  if (!constantTimeEquals(providedKey, configured)) return null;
  return {
    permission: "full",
    scopes: [SCOPE_ADMIN, SCOPE_WRITE, SCOPE_READ],
    legacyDerived: false,
    scoped_tags: null,
    vault_name: null,
    // No stable session id for the env-var operator token — every request
    // is the operator-bearer, not a minted session. manage-token's session
    // pin is a no-op for this caller (it'd still mint, but list/revoke
    // would see no other operator mints; that's fine — env-var-bearer is
    // explicitly the operator-channel, not a user surface).
    caller_jti: null,
    // Write-attribution (vault#298): the env-var bearer IS the operator
    // channel. `actor: "operator"` + `via: "operator"` — a stable, honest
    // label for cross-container hub→vault and CLI operator writes.
    actor: "operator",
    via: "operator",
  };
}

/** Result of a successful auth check. */
export interface AuthResult {
  permission: TokenPermission;
  /** OAuth-standard scopes granted to this token. */
  scopes: string[];
  /**
   * True iff scopes were derived from a legacy permission value (no `vault:*`
   * scopes stored on the token row or legacy YAML key). Callers should log a
   * one-time deprecation warning when they encounter `legacyDerived: true`.
   */
  legacyDerived: boolean;
  /**
   * Tag-allowlist (root tag names) for tag-scoped tokens. NULL = unscoped
   * (current full-vault behavior). Hub-issued JWTs and legacy YAML keys
   * always have null — tag scoping is a per-token vault-DB attribute, not
   * an OAuth-claim concern. See docs/contracts/tag-scoped-tokens.md.
   */
  scoped_tags: string[] | null;
  /**
   * Per-vault binding (v16). Non-null = token can only authenticate against
   * this vault. authenticateVaultRequest enforces the match before this
   * result returns; callers downstream can read it for additional scoping
   * (e.g. cross-vault filtering at the unified /mcp endpoint). NULL =
   * legacy / server-wide / hub JWT — no per-vault binding. See vault#257.
   */
  vault_name: string | null;
  /**
   * Session identifier. For hub JWTs this is the `jti` claim, when present.
   * NULL for legacy YAML keys / server-wide env-var tokens / hub JWTs
   * without a `jti`. Used by the manage-token MCP tool to stamp child
   * mints with `parent_jti` so list/revoke can scope to this session's
   * mints. See vault#376.
   */
  caller_jti: string | null;
  /**
   * Write-attribution axis 1 — WHO (vault#298). The principal a write is
   * attributed to:
   *   - Hub JWT  → the validated `sub` claim (the human or the identity an
   *     agent runs as).
   *   - VAULT_AUTH_TOKEN operator bearer → `"operator"`.
   *   - Legacy YAML api_keys → `"token:<keyhash-prefix>"` so legacy writes
   *     still attribute to *something* stable, never crash.
   * NULL only when no principal could be resolved (shouldn't happen on a
   * successful auth, but kept nullable so a future credential class that
   * lacks a subject degrades gracefully rather than throwing).
   */
  actor: string | null;
  /**
   * Write-attribution axis 2 — VIA WHAT (vault#298). The interface/channel a
   * write arrived through, derived PRAGMATICALLY from the credential class
   * here, then REFINED by the request path at the call site (the MCP handler
   * stamps `mcp`; the REST router keeps the credential-class default). Values:
   * `mcp` · `surface:<name>` · `agent:<id>` · `nostr:<pubkey>` · `operator` ·
   * `api`. This is the BASE value from auth — the credential class:
   *   - Hub JWT with a `permissions.principal_pubkey` claim → `nostr:<pubkey>`
   *     (vault#698). The signer is MORE specific than the channel, and unlike
   *     every other class it distinguishes two agents that share one hub user,
   *     so downstream does NOT refine it away — see `mcp-tools.ts`.
   *   - Hub JWT  → `"api"` (the generic class; refined to `mcp` etc. downstream
   *     once the channel is known).
   *   - operator bearer → `"operator"`.
   *   - legacy YAML key → `"api"` (a REST credential; the `token:<id>` actor
   *     already carries the legacy-key identity).
   * Never blocks the `actor` work — if the channel can't be cleanly
   * determined the class (or `api`) stands.
   */
  via: string | null;
}

/**
 * Convert a legacy "read" | "full" permission into scopes + the legacyDerived
 * flag. Used for legacy YAML key authentication paths and for tokens whose
 * `scopes` column is still NULL.
 *
 * `actorLabel` (vault#298) is the write-attribution principal for this legacy
 * credential — `token:<keyhash-prefix>` so a legacy-YAML-keyed write still
 * attributes to a stable identity. Defaults to `"operator"` for the rare
 * call site without a key in hand. `via` is the generic `api` class (legacy
 * keys are a REST credential); the MCP handler refines it to `mcp` downstream.
 */
function legacyAuthResult(
  permission: TokenPermission,
  actorLabel: string = "operator",
): AuthResult {
  return {
    permission,
    scopes: legacyPermissionToScopes(permission),
    legacyDerived: true,
    scoped_tags: null,
    vault_name: null,
    caller_jti: null,
    actor: actorLabel,
    via: "api",
  };
}

/**
 * Stable short label for a legacy YAML api_key, derived from its stored hash.
 * `token:<first-12-of-hash>` — enough to distinguish keys for attribution
 * without putting a full secret-derived hash into note rows. The hash is
 * already a one-way digest of the key (see config.ts `verifyKey`), so a prefix
 * leaks nothing usable.
 */
function legacyKeyActorLabel(keyHash: string): string {
  const clean = keyHash.replace(/^[^:]*:/, ""); // drop any `algo:` prefix
  return `token:${clean.slice(0, 12)}`;
}

// One-shot deprecation warning tracker, keyed by token hash / legacy label so
// we don't spam the log on every request.
const warnedLegacyTokens = new Set<string>();

/**
 * Log a one-time deprecation warning for legacy-derived auth results.
 * Safe to call on every request — dedupes internally by cache key.
 */
export function warnLegacyOnce(cacheKey: string, context: string): void {
  if (warnedLegacyTokens.has(cacheKey)) return;
  warnedLegacyTokens.add(cacheKey);
  console.warn(
    `[scopes] legacy permission-based auth used (${context}); migrate to vault:read / vault:write / vault:admin scopes. This compat shim will be removed after the next release.`,
  );
}

/**
 * Boot-time warning for legacy GLOBAL `api_keys` in `config.yaml` (security
 * review — multi-user hardening). Those keys are CROSS-VAULT credentials: a
 * single key authenticates against EVERY vault on this server (see the global
 * `api_keys` branch in `authenticate` ~L283). That predates per-vault keys +
 * tag-scoped hub JWTs and is a confidentiality hazard once a server hosts
 * multiple users' vaults — one user's global key reads another's vault.
 *
 * WARNING ONLY — never touches the keys (the operator owns them). The
 * verification flagged 6 such keys on the live box; this surfaces them at
 * boot so they're rotated/removed before multi-user sharing. Returns the
 * count it warned about (0 = silent) so callers / tests can assert.
 */
export function warnLegacyGlobalApiKeys(
  globalApiKeys: StoredKey[] | undefined,
  warn: (msg: string) => void = console.warn,
): number {
  const count = globalApiKeys?.length ?? 0;
  if (count === 0) return 0;
  warn(
    `[auth] WARNING: ${count} legacy GLOBAL api_key(s) found in config.yaml. ` +
      "These are CROSS-VAULT credentials (each grants access to every vault on this server) " +
      "and predate per-vault keys + tag-scoped hub JWTs. Before multi-user sharing, ROTATE or " +
      "REMOVE them — a global key leaks one user's vault to another. They remain active (the " +
      "operator owns them); this is a heads-up, not an automatic change.",
  );
  return count;
}

/** Read-only tools (the only tools allowed for "read" permission). */
const READ_TOOLS = new Set([
  "query-notes",
  "list-tags",
  "find-path",
  "vault-info",
]);

/** Check if a tool call is allowed for a given permission level. */
export function isToolAllowed(toolName: string, permission: TokenPermission): boolean {
  if (permission === "full") return true;
  return READ_TOOLS.has(toolName);
}

/** Read-only HTTP methods. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Check if an HTTP method is allowed for a given permission level. */
export function isMethodAllowed(method: string, permission: TokenPermission): boolean {
  if (permission === "full") return true;
  return READ_METHODS.has(method);
}

// RFC 7235: the auth-scheme token is case-insensitive (`Bearer`/`bearer`/
// `BEARER` are all the same scheme) — only the token68/credentials that
// follow are case-sensitive. `\s+` (not a single literal space) tolerates
// the rare client that sends more than one space after the scheme.
const BEARER_PREFIX = /^Bearer\s+/i;

/**
 * Extract API key/token from request.
 * Priority: Authorization header → X-API-Key header → ?key= query param.
 */
export function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader && BEARER_PREFIX.test(authHeader)) {
    return authHeader.replace(BEARER_PREFIX, "");
  }
  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return xApiKey;
  // Query param fallback — enables URL-only auth for MCP clients (e.g. Claude Web)
  const url = new URL(req.url);
  return url.searchParams.get("key");
}

/**
 * Validate a key against a list of stored keys (legacy YAML-based auth).
 * Returns the matched key or null.
 */
function validateKey(keys: StoredKey[], providedKey: string): StoredKey | null {
  for (const stored of keys) {
    if (verifyKey(providedKey, stored.key_hash)) {
      stored.last_used_at = new Date().toISOString();
      return stored;
    }
  }
  return null;
}

/**
 * Authenticate for a specific vault.
 *
 * Token shape decides the path (vault#282 Stage 2 — vault is a pure hub
 * resource-server, the `pvt_*` vault-DB lookup is GONE):
 *   - VAULT_AUTH_TOKEN match → server-wide operator bearer (checked first).
 *   - JWT-shaped (`eyJ…`) → validate against the hub's JWKS. JWT-shaped tokens
 *     commit to JWT validation; we don't fall through on failure, since a
 *     malformed JWT was never going to be a valid local credential anyway.
 *   - Anything else → legacy YAML api_keys (vault.yaml, then config.yaml).
 *     A `pvt_*`-prefixed bearer is not JWT-shaped and matches no `key_hash`,
 *     so it falls through to the 401 — pvt_* is unvalidatable post-DROP.
 */
export async function authenticateVaultRequest(
  req: Request,
  vaultConfig: VaultConfig,
): Promise<{ error: Response } | AuthResult> {
  const key = extractApiKey(req);
  if (!key) {
    return { error: Response.json({ error: "Unauthorized", message: "API key required" }, { status: 401 }) };
  }

  // Server-wide operator token (vault#339). When VAULT_AUTH_TOKEN is set,
  // a matching bearer authenticates as full/admin against any vault. This
  // is the cross-container path for Render / sibling-service deployments
  // where hub talks to vault over HTTP. Checked first so it short-circuits
  // JWT validation — the operator token is a credential the operator opts
  // into, not one we'd ever fall through.
  const serverWide = tryServerWideAuth(key);
  if (serverWide !== null) return serverWide;

  // JWT path: hub-issued tokens. Trust pinned to the hub origin via `iss`
  // verification inside validateHubJwt; signature checked against hub's JWKS.
  // Audience strict-checked against `vault.<name>` so a token stamped for
  // one vault can't reach another. `vault_scope` claim additionally checked
  // against `vaultConfig.name` so a per-user vault pin refuses cross-vault
  // access even if a scope-string somehow named the wrong vault (multi-user
  // Phase 1 defense-in-depth — see hub#283 + scope-guard 0.3.0).
  if (looksLikeJwt(key)) {
    return await authenticateHubJwt(key, {
      expectedAudience: `vault.${vaultConfig.name}`,
      vaultName: vaultConfig.name,
    });
  }

  // Legacy: check per-vault keys from vault.yaml
  const vaultKey = validateKey(vaultConfig.api_keys, key);
  if (vaultKey) {
    try { writeVaultConfig(vaultConfig); } catch {}
    warnLegacyOnce(`yaml-vault:${vaultKey.key_hash}`, "vault.yaml api_keys");
    return legacyAuthResult(
      vaultKey.scope === "read" ? "read" : "full",
      legacyKeyActorLabel(vaultKey.key_hash),
    );
  }

  // Legacy: check global keys from config.yaml
  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys) {
    const globalKey = validateKey(globalConfig.api_keys, key);
    if (globalKey) {
      try { writeGlobalConfig(globalConfig); } catch {}
      warnLegacyOnce(`yaml-global:${globalKey.key_hash}`, "config.yaml api_keys");
      return legacyAuthResult(
        globalKey.scope === "read" ? "read" : "full",
        legacyKeyActorLabel(globalKey.key_hash),
      );
    }
  }

  if (looksLikeDroppedPvtToken(key)) {
    return { error: droppedPvtTokenResponse() };
  }
  return { error: Response.json({ error: "Unauthorized", message: "Invalid API key" }, { status: 401 }) };
}

/**
 * A bearer of the dropped `pvt_*` shape (vault#282 Stage 2 — vault no longer
 * mints or validates the per-vault opaque token). Detected by prefix so a
 * caller still presenting one gets a pointed 401 instead of the generic
 * "Invalid API key" — the prefix is the user-meaningful signal, and a real
 * hub JWT / `pvk_` / `VAULT_AUTH_TOKEN` never starts with `pvt_`.
 */
function looksLikeDroppedPvtToken(key: string): boolean {
  return key.startsWith("pvt_");
}

function droppedPvtTokenResponse(): Response {
  return Response.json(
    {
      error: "Unauthorized",
      message:
        "pvt_* tokens are no longer supported (vault 0.5.0). Re-add this vault via your hub to get an access token.",
    },
    { status: 401 },
  );
}

/**
 * Sentinel thrown when a hub JWT carries a `permissions.scoped_tags` claim
 * that is present but malformed (not an array of non-empty strings). See
 * `parseScopedTagsFromPermissions` for why this MUST fail closed.
 */
class MalformedScopedTagsError extends Error {}

/**
 * Map a validated hub JWT's `permissions` claim into the `scoped_tags`
 * allowlist for `AuthResult` (auth-unification arc, C0 — the READ side).
 *
 * Wire contract (the shape the SPA + manage-token mint sides target):
 *
 *   permissions: { scoped_tags: string[] }   // root tag names
 *
 * Each entry is a ROOT tag name; the token sees notes carrying that tag or a
 * sub-tag thereof (hierarchy expansion happens in tag-scope.ts).
 *
 * Three outcomes, chosen for a strict FAIL-CLOSED invariant — tag-scoping is
 * always a RESTRICTION, so a misread must NEVER widen access:
 *
 *   1. Claim absent (no `permissions`, or no `scoped_tags` key) → returns
 *      `null` = UNSCOPED = full vault. This is legitimate and is today's
 *      behavior for every hub JWT. Absence genuinely means "not tag-scoped".
 *
 *   2. `scoped_tags` is a non-empty array of non-empty strings → returns
 *      that array. The token is tag-scoped; the allowlist is enforced.
 *
 *   3. `scoped_tags` is present but MALFORMED — a string, a number, an
 *      object, an array containing a non-string / empty-string, or an empty
 *      array `[]` — throws `MalformedScopedTagsError`. The caller REJECTS
 *      the request (401). We do NOT coerce to `null` or `[]`:
 *
 *      - Coercing to `null` would WIDEN a token that was MEANT to be scoped
 *        up to full-vault — a privilege leak. Forbidden.
 *      - Coercing to `[]` is NOT reliably fail-closed across enforcement
 *        paths. The MCP read-tool wrappers fast-path out on
 *        `scoped_tags.length === 0` (mcp-tools.ts ~L178) and the REST path
 *        collapses `[]` → null inside `expandTokenTagScope` (tag-scope.ts
 *        ~L35) — both treat `[]` as UNSCOPED = full vault. So `[]` would
 *        ALSO widen. (Note: `filterNotesByTagScope`/`noteWithinTagScope`
 *        would treat a raw `[]` as "matches nothing", but the call sites
 *        never reach them with `[]` because of the upstream short-circuits —
 *        the two enforcement paths disagree on `[]`, which is exactly why we
 *        refuse to manufacture it here.)
 *
 *      The only correct fail-closed action for a present-but-unreadable
 *      scope is to reject the whole request — never serve it wide.
 */
/**
 * Nostr pubkey shape: 32 bytes, lowercase hex. NIP-01 canonical form.
 */
const NOSTR_PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * Write-attribution `via` label for a NIP-98-signed principal.
 *
 * `nostr:<64-hex>` joins the existing open-ended `via` vocabulary
 * (`mcp` · `surface:<name>` · `agent:<id>` · `operator` · `api`) — same
 * `<class>:<id>` shape as `agent:<id>`, so `created_via` / `last_updated_via`
 * stay plain exact-match strings and every existing filter keeps working.
 */
export function nostrVia(pubkey: string): string {
  return `nostr:${pubkey}`;
}

/**
 * Refine the credential-class `via` from `AuthResult` for a write that arrived
 * on the MCP channel.
 *
 * `mcp` wins over the generic classes (`api`, a legacy `token:` REST key) —
 * the channel is the more specific fact. It does NOT win over a class that
 * already names a *principal or channel of its own*:
 *
 *   - `operator` — the env-var bearer (vault#298).
 *   - `nostr:<pubkey>` — the NIP-98 signer (vault#698). Every hub `/mcp`
 *     caller is on the `mcp` channel, so `mcp` cannot distinguish two agents
 *     sharing a hub user; the key can.
 */
export function refineMcpVia(via: string | null | undefined): string {
  // `undefined` is accepted alongside `null` on purpose: `AuthResult` declares
  // `via: string | null`, but several in-repo call sites build the object
  // without the key (attachment tools, test harnesses). The expression this
  // replaced (`auth.via === "operator" ? … : "mcp"`) tolerated that silently,
  // so a `string`-only signature here would turn a missing key into a
  // TypeError at write time. Narrow on `typeof`, not on `!== null`.
  if (via === "operator") return "operator";
  if (typeof via === "string" && via.startsWith("nostr:")) return via;
  return "mcp";
}

/**
 * Read the signing pubkey out of a validated hub JWT's `permissions` claim
 * (vault#698 / hub#937 — Nostr principal attribution).
 *
 * Wire contract: `permissions: { principal_pubkey: "<64 lowercase hex>" }`.
 * The hub stamps it ONLY on tokens minted for a NIP-98-authenticated caller;
 * password / OAuth / Bearer sessions never carry it.
 *
 * Why it rides inside `permissions` rather than a top-level claim:
 * `@openparachute/scope-guard` returns a FIXED claim surface
 * (`sub`, `scopes`, `aud`, `jti`, `clientId`, `vaultScope`, `permissions`) and
 * drops everything else, and `permissions` is its documented verbatim
 * passthrough. A new top-level claim would be invisible here without a
 * scope-guard release.
 *
 * FAIL-SOFT, deliberately the opposite of `parseScopedTagsFromPermissions`:
 * this claim only *labels* a write, it never widens or narrows access. A
 * missing / malformed / wrong-case / non-hex value returns `null` and the
 * caller falls back to the generic credential class, rather than storing junk
 * in an attribution column or 401-ing a legitimate write.
 */
export function parsePrincipalPubkey(
  permissions: Record<string, unknown> | undefined,
): string | null {
  if (!permissions) return null;
  if (!("principal_pubkey" in permissions)) return null;
  const raw = permissions.principal_pubkey;
  if (typeof raw === "string" && NOSTR_PUBKEY_RE.test(raw)) return raw;
  // PRESENT but unreadable. Fail soft (see above) — but never SILENTLY: the
  // symptom of a dropped claim (`created_via` back to `mcp`) is byte-identical
  // to the symptom of the hub not having shipped the claim at all, which is
  // exactly the bug this feature exists to fix. One warn per distinct bad
  // value makes the two distinguishable in the daemon log. A pubkey is public
  // by construction, so logging the value leaks nothing.
  const seen = typeof raw === "string" ? raw : `<${typeof raw}>`;
  if (!warnedBadPubkeys.has(seen)) {
    warnedBadPubkeys.add(seen);
    console.warn(
      "[attribution] hub JWT permissions.principal_pubkey present but not 64 lowercase hex — " +
        `ignoring, falling back to the generic credential class (saw: ${JSON.stringify(seen)})`,
    );
  }
  return null;
}

/** Dedupe key set for the warn above — unbounded growth is bounded in practice
 *  by the number of DISTINCT malformed values a misconfigured hub emits (one). */
const warnedBadPubkeys = new Set<string>();

function parseScopedTagsFromPermissions(
  permissions: Record<string, unknown> | undefined,
): string[] | null {
  if (!permissions || !("scoped_tags" in permissions)) return null;
  const raw = permissions.scoped_tags;
  if (raw === null || raw === undefined) return null; // explicit "unscoped"
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((t) => typeof t === "string" && t.length > 0)
  ) {
    return raw as string[];
  }
  // Present but malformed (incl. `[]`): fail closed — never widen.
  throw new MalformedScopedTagsError(
    "hub JWT permissions.scoped_tags is present but not a non-empty array of tag names",
  );
}

/**
 * Validate a JWT-shaped bearer and convert the result into an `AuthResult`.
 * The token's scope claim becomes the granted scopes; permission is derived
 * for back-compat with code paths that still branch on `permission` (MCP
 * tool gating, view auth). `legacyDerived` is `false` — JWT-issued scopes
 * are explicit, never inferred.
 *
 * Scope-shape policy: hub-issued tokens MUST carry resource-narrowed
 * `vault:<name>:<verb>` scopes. Broad `vault:<verb>` scopes are rejected
 * here — Phase B2 settled that hub tokens always name the resource. Per-
 * vault audience enforcement happens inside `validateHubJwt` via
 * `opts.expectedAudience`.
 *
 * Per-user vault-pin enforcement (multi-user Phase 1 PR 5): when
 * `opts.vaultName` is set, the token's `vault_scope` claim is checked
 * against it via scope-guard's `enforceVaultScope`. Non-admin tokens
 * (`vault_scope: [<assigned_vault>]`) refuse cross-vault access with a
 * 403 + `vault_scope_mismatch` error code. Admin tokens (`vault_scope:
 * []`) and pre-PR-4 tokens (claim absent → surfaced as `[]`) pass
 * unchanged. The 403 (not 401) signals "your credential is valid but
 * doesn't grant access to this vault" — distinct from authentication
 * failures upstream. See hub#283 + scope-guard 0.3.0 for the mint side.
 *
 * Tag-scoping (auth-unification arc, C0): the token's `permissions.scoped_tags`
 * claim (when present and well-formed) maps into `AuthResult.scoped_tags`,
 * restricting which notes the token sees. A present-but-malformed claim FAILS
 * CLOSED with a 401 rather than widening to full-vault — see
 * `parseScopedTagsFromPermissions`.
 */
async function authenticateHubJwt(
  token: string,
  opts: { expectedAudience: string | null; vaultName?: string },
): Promise<{ error: Response } | AuthResult> {
  try {
    const claims = await validateHubJwt(token, { expectedAudience: opts.expectedAudience });
    const broad = findBroadVaultScopes(claims.scopes);
    if (broad.length > 0) {
      return {
        error: Response.json(
          {
            error: "Unauthorized",
            message: `hub JWT carries broad vault scope(s): ${broad.join(" ")}. Hub-issued tokens must use resource-narrowed scopes (vault:<name>:<verb>).`,
          },
          { status: 401 },
        ),
      };
    }
    // Defense-in-depth vault-pin check (multi-user Phase 1 PR 5). Runs
    // AFTER the broad-scope check — a malformed token gets the more-
    // descriptive scope-shape error rather than a generic pin-mismatch.
    // When `vaultName` is unset (no per-vault binding known at this
    // call site), the check is skipped — the audience strict-check
    // inside validateHubJwt is the primary pin in that case.
    if (opts.vaultName !== undefined && !enforceVaultScope(claims, opts.vaultName)) {
      // Invariant: by the contract of `enforceVaultScope`, the false
      // branch requires `claims.vaultScope.length > 0` — an empty
      // `vaultScope` always returns true. The defensive assertion
      // pins that so a future refactor can't slip an empty-scope
      // request into this branch (which would render an empty
      // parenthesised list in the message and break the diagnostic).
      // Body shape: client gets `required_vault` + a message naming
      // the conflict. The token's pinned vault is intentionally NOT
      // echoed back — the attacker holds the token (and can decode
      // claims locally), so the message would only leak the pin to a
      // legitimate operator looking at a 403 log line. They already
      // know which user they assigned where; the required_vault is
      // the actionable piece.
      if (claims.vaultScope.length === 0) {
        throw new Error(
          "unreachable: enforceVaultScope returned false on an empty vaultScope",
        );
      }
      return {
        error: Response.json(
          {
            error: "Forbidden",
            error_type: "vault_scope_mismatch",
            message: `token's vault_scope (${claims.vaultScope.join(", ")}) does not include the requested vault '${opts.vaultName}'`,
            required_vault: opts.vaultName,
          },
          { status: 403 },
        ),
      };
    }
    const permission: TokenPermission =
      hasScope(claims.scopes, SCOPE_WRITE) || hasScope(claims.scopes, SCOPE_ADMIN)
        ? "full"
        : "read";
    // C0: read tag-scoping from the validated token's `permissions` claim.
    // Throws MalformedScopedTagsError (caught below → 401) on a present-but-
    // malformed claim so we never widen access on a misread.
    const scoped_tags = parseScopedTagsFromPermissions(claims.permissions);
    // Write-attribution axis 2 (vault#698): the NIP-98 signing pubkey, when
    // the hub stamped one. Fail-soft — see `parsePrincipalPubkey`.
    const principalPubkey = parsePrincipalPubkey(claims.permissions);
    return {
      permission,
      scopes: claims.scopes,
      legacyDerived: false,
      scoped_tags,
      vault_name: null,
      // claims.jti is `undefined` when the issuer didn't stamp one. Pass it
      // through verbatim — manage-token's session-pin will be null in that
      // case, and list/revoke from that session sees no mints.
      caller_jti: claims.jti ?? null,
      // Write-attribution (vault#298). WHO = the validated JWT subject (the
      // human, or the identity an agent runs as — note agent-grant tokens are
      // minted with `sub = <user-on-whose-behalf>`, so today an agent's writes
      // attribute to that human; a delegation-chain `via` is the deferred v2 in
      // the issue). VIA = `api` here, the generic credential class; the request
      // path refines it (the MCP handler stamps `mcp`). The JWT carries no
      // clean surface-name / agent-definition-id claim — `clientId` is an
      // opaque DCR id and `aud` is just `vault.<name>` — so per the issue's
      // pragmatic constraint we DON'T manufacture a more specific class; the
      // channel comes from the path instead.
      actor: claims.sub && claims.sub.length > 0 ? claims.sub : null,
      // VIA: `nostr:<pubkey>` when the hub tells us which key signed the
      // request that produced this token (vault#698 — the NIP-98 `/mcp` door),
      // otherwise the generic `api` credential class the request path refines.
      // `actor` is untouched on purpose: it stays the hub USER id, so two
      // agents sharing a hub user keep one `created_by` and are told apart by
      // `created_via` / `last_updated_via`.
      via: principalPubkey !== null ? nostrVia(principalPubkey) : "api",
    };
  } catch (err) {
    if (err instanceof MalformedScopedTagsError) {
      // Fail-closed (C0): a present-but-malformed `permissions.scoped_tags`
      // means the token wanted to be tag-scoped but we can't read the
      // allowlist. Reject rather than widen to full-vault. The audit log
      // carries the diagnostic; the client gets a generic 401.
      console.warn(`[auth] hub JWT rejected: ${err.message}`);
      return {
        error: Response.json(
          { error: "Unauthorized", message: "token has a malformed tag-scope claim" },
          { status: 401 },
        ),
      };
    }
    if (err instanceof HubJwtError) {
      // Revocation-related codes get sanitized client messages: server-side
      // audit log carries the full diagnostic (jti for `revoked`,
      // implementation-detail phrasing for `revocation_unavailable`); the
      // unauthenticated caller gets a code-shaped sentence with no internals.
      // This is the inheritable pattern across vault/scribe/agent — keep all
      // revocation-related diagnostics server-side. Other HubJwtError codes
      // (signature, audience, expired, etc.) carry generic messages and are
      // forwarded as-is; the existing test suite pins those exact strings.
      if (err.code === "revoked") {
        console.warn(`[auth] hub JWT rejected: ${err.message}`);
        return {
          error: Response.json(
            { error: "Unauthorized", message: "token has been revoked" },
            { status: 401 },
          ),
        };
      }
      if (err.code === "revocation_unavailable") {
        console.warn(`[auth] hub JWT rejected: ${err.message}`);
        return {
          error: Response.json(
            {
              error: "Unauthorized",
              message: "token cannot be validated: revocation list unavailable",
            },
            { status: 401 },
          ),
        };
      }
      return { error: Response.json({ error: "Unauthorized", message: err.message }, { status: 401 }) };
    }
    // Unknown failure shape — surface the message but stay 401.
    const msg = err instanceof Error ? err.message : "JWT validation failed";
    return { error: Response.json({ error: "Unauthorized", message: msg }, { status: 401 }) };
  }
}

/**
 * Authenticate for the unified /mcp endpoint (cross-vault: /vaults metadata,
 * /health detail). Accepts only VAULT_AUTH_TOKEN + global config.yaml keys
 * (vault#282 Stage 2 — the per-vault pvt_* DB fallback is GONE). Hub JWTs are
 * vault-bound (aud=vault.<name>) and have no single audience to strict-check
 * across every vault, so they're rejected here with a redirect hint to the
 * per-vault `/vault/<name>/*` surface.
 */
export async function authenticateGlobalRequest(
  req: Request,
): Promise<{ error: Response } | AuthResult> {
  const key = extractApiKey(req);
  if (!key) {
    return { error: Response.json({ error: "Unauthorized", message: "API key required" }, { status: 401 }) };
  }

  // Server-wide operator token (vault#339). When VAULT_AUTH_TOKEN is set,
  // a matching bearer authenticates as full/admin on cross-vault routes
  // (/vaults metadata listing, /health detail). Checked first so a
  // container-host operator-channel call doesn't depend on any per-vault
  // DB lookup.
  const serverWide = tryServerWideAuth(key);
  if (serverWide !== null) return serverWide;

  // Hub-issued JWTs are always vault-bound (aud=vault.<name>). The unified
  // /vaults / /health surface spans every vault and has no single audience to
  // strict-check against, so JWTs aren't accepted here. Cross-vault listing
  // for hub-authenticated callers will land alongside the `parachute:host:*`
  // scope namespace; until then, callers wanting `/vaults` from a JWT
  // context use a per-vault token at `/vault/<name>` and rely on services.json
  // for the broader catalog.
  if (looksLikeJwt(key)) {
    return {
      error: Response.json(
        {
          error: "Unauthorized",
          message:
            "Hub-issued JWTs are vault-bound; use /vault/<name>/* endpoints. Cross-vault routes accept legacy config.yaml keys or per-vault tokens.",
        },
        { status: 401 },
      ),
    };
  }

  // Legacy: check global keys from config.yaml
  const globalConfig = readGlobalConfig();
  if (globalConfig.api_keys) {
    const matched = validateKey(globalConfig.api_keys, key);
    if (matched) {
      try { writeGlobalConfig(globalConfig); } catch {}
      warnLegacyOnce(`yaml-global:${matched.key_hash}`, "config.yaml api_keys");
      return legacyAuthResult(
        matched.scope === "read" ? "read" : "full",
        legacyKeyActorLabel(matched.key_hash),
      );
    }
  }

  if (looksLikeDroppedPvtToken(key)) {
    return { error: droppedPvtTokenResponse() };
  }
  return { error: Response.json({ error: "Unauthorized", message: "Invalid API key" }, { status: 401 }) };
}

/**
 * Outcome of deriving a target vault from a request's bearer at the canonical
 * root `/mcp` endpoint (U1). `vaultName` on success; a coarse failure `error`
 * otherwise. Both failure reasons map to the SAME 401 + root-PRM challenge at
 * the router — the distinction exists for logging/tests, never leaks to the
 * client. `no_bearer` = no credential presented; `not_derivable` = a credential
 * that names no single vault (non-JWT operator/legacy bearer, invalid /
 * expired / revoked JWT, or a JWT whose scope / `aud` / `vault_scope` sources
 * name zero or conflicting vaults).
 */
export type VaultDerivation =
  | { vaultName: string }
  | { error: "no_bearer" | "not_derivable" };

/**
 * Derive the target vault from a request's bearer token WITHOUT authorizing the
 * request. The caller re-dispatches the derived name through the full per-vault
 * auth machinery (`authenticateVaultRequest`), which re-validates the token
 * WITH the audience pin — derive-then-redispatch, so a bad derivation FAILS the
 * inner check rather than bypassing it (defense in depth). This function only
 * reads the claims well enough to name the vault; it is never the authorization
 * gate.
 *
 * Only hub-issued JWTs name a vault. The operator `VAULT_AUTH_TOKEN` and legacy
 * YAML keys are vault-agnostic (they name no resource — see scopes.ts), so they
 * return `not_derivable` here and keep working at the URL-addressed
 * `/vault/<name>/*` surface. The JWT is validated with the SAME scope-guard
 * trust kernel the per-vault path uses (signature, `iss` pin, `jti` +
 * revocation, expiry) but WITHOUT `expectedAudience` — at the root we don't yet
 * know which audience to expect; that pin is re-applied by the re-dispatch.
 *
 * From the validated claims, three independent sources can name a vault:
 *   1. a narrowed `vault:<name>:<verb>` scope,
 *   2. an `aud` of the form `vault.<name>`,
 *   3. a single-element `vault_scope` claim.
 * On a hub-minted token these AGREE. We collect every name any source provides
 * and require EXACTLY ONE distinct name: zero (nothing named a vault) and
 * two-or-more (the sources disagree) both fail closed with `not_derivable`. We
 * never pick a winner from a precedence order — an ambiguous or unnamed token
 * gets the discovery challenge, not a silent guess.
 */
export async function deriveVaultFromToken(req: Request): Promise<VaultDerivation> {
  const key = extractApiKey(req);
  if (!key) return { error: "no_bearer" };
  if (!looksLikeJwt(key)) return { error: "not_derivable" };
  let claims;
  try {
    // No `expectedAudience`: the per-vault trust kernel minus the aud pin
    // (which the re-dispatch re-applies). A bad signature / iss / expiry /
    // revoked jti throws here → not_derivable → the standard 401 challenge.
    claims = await validateHubJwt(key, {});
  } catch {
    return { error: "not_derivable" };
  }
  const named = new Set<string>();
  for (const name of narrowedVaultNames(claims.scopes)) named.add(name);
  const audMatch = claims.aud?.match(/^vault\.(.+)$/);
  if (audMatch) named.add(audMatch[1]!);
  if (claims.vaultScope.length === 1) named.add(claims.vaultScope[0]!);
  if (named.size !== 1) return { error: "not_derivable" };
  return { vaultName: [...named][0]! };
}
