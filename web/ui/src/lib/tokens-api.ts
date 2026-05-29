/**
 * HTTP client for the vault admin SPA's tokens page.
 *
 * Tokens are **hub JWTs** (the only mint path — vault#282 Stage 2 dropped the
 * legacy `pvt_*` read/revoke surface; vault is a pure hub resource-server).
 * Hub's token registry: `/api/auth/mint-token` (mint), `/api/auth/tokens`
 * (list), `/api/auth/revoke-token` (revoke), authed with the **host-admin**
 * bearer from `host-admin-auth.ts` (carries `parachute:host:auth`, which the
 * list endpoint hard-requires). These mint canonical `vault:<name>:<verb>`
 * hub JWTs.
 *
 * The tag picker (`listVaultTags`) still uses the **vault-admin** bearer via
 * `api.ts:_authedFetch` to read `/vault/<name>/api/tags`.
 */
import { HttpError, _authedFetch } from "./api.ts";
import { hostAdminAuthedFetch } from "./host-admin-auth.ts";

// ---------------------------------------------------------------------------
// Hub JWT tokens — the live mint/list/revoke path.
// ---------------------------------------------------------------------------

/** TTL options for the mint form's dropdown, in days. Hub caps at 365d. */
export const TTL_DAY_OPTIONS = [30, 90, 180, 365] as const;
/** Default TTL the mint form selects, in days. */
export const DEFAULT_TTL_DAYS = 90;

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Display shape for a hub-JWT row, mapped from the `/api/auth/tokens` wire
 * row. The registry has no human-label column — the operator's label
 * round-trips through `subject` (set at mint, read back here for display).
 */
export interface HubTokenSummary {
  /** Revocation key (the registry's `jti`). */
  jti: string;
  /** Operator-supplied label, carried in the JWT `subject` claim. */
  label: string | null;
  /** Canonical `vault:<name>:<verb>` scopes (+ any others on the row). */
  scopes: string[];
  /**
   * Tag-allowlist (root tags) from the `permissions.scoped_tags` claim.
   * `null` = unscoped (sees the whole vault). Read directly off the parsed
   * `permissions` object — hub parses it server-side, no JSON.parse here.
   */
  scoped_tags: string[] | null;
  expires_at: string | null;
  /** ISO timestamp when revoked, else `null`. Drives the "revoked" pill. */
  revoked_at: string | null;
  created_at: string;
}

export interface MintHubTokenResult {
  jti: string;
  /** One-time-reveal hub JWT. Same field name as the old `pvt_*` path so the
   *  reveal banner works unchanged. */
  token: string;
  scope: string;
  expires_at: string | null;
}

/** Verb for the minted scope. */
export type ScopeVerb = "read" | "write" | "admin";

/** Wire row shape from `GET /api/auth/tokens`. `permissions` is a PARSED
 *  object (hub parses the JSON-string column server-side). */
interface HubTokenWireRow {
  jti: string;
  user_id: string | null;
  subject: string | null;
  client_id: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  created_via: string;
  permissions: Record<string, unknown> | null;
}

interface HubTokensListResponse {
  tokens?: HubTokenWireRow[];
  next_cursor?: string | null;
}

/** Pull `scoped_tags` (a `string[]`) out of a parsed permissions object, or
 *  `null` when absent/malformed. */
function scopedTagsFromPermissions(permissions: Record<string, unknown> | null): string[] | null {
  if (!permissions) return null;
  const raw = permissions["scoped_tags"];
  if (!Array.isArray(raw)) return null;
  const tags = raw.filter((t): t is string => typeof t === "string" && t.length > 0);
  return tags.length > 0 ? tags : null;
}

function mapHubRow(row: HubTokenWireRow): HubTokenSummary {
  return {
    jti: row.jti,
    label: row.subject,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    scoped_tags: scopedTagsFromPermissions(row.permissions),
    expires_at: row.expires_at ?? null,
    revoked_at: row.revoked_at ?? null,
    created_at: row.created_at,
  };
}

/**
 * Mint a hub JWT scoped to this vault.
 *
 * Hits `POST /api/auth/mint-token` with the host-admin bearer. Body uses the
 * SINGULAR space-joined `scope` string (not a `scopes` array) per the hub
 * contract. The minted token is pinned to `vault:<name>:<verb>`; the audience
 * auto-derives to `vault.<name>` so we omit it. The operator label rides in
 * `subject` (the registry's only place to round-trip a human label).
 *
 * Tag-scoping: when `scopedTags` is non-empty we add
 * `permissions: { scoped_tags: [...] }`. We OMIT `permissions` ENTIRELY when
 * no tags are selected — vault C0 fail-closes on an empty/malformed
 * `scoped_tags` array (it would 401 at request time), so an empty array must
 * never reach the wire.
 */
export async function mintHubToken(
  vaultName: string,
  args: { verb: ScopeVerb; label: string; scopedTags: string[]; ttlDays: number },
): Promise<MintHubTokenResult> {
  const body: Record<string, unknown> = {
    scope: `vault:${vaultName}:${args.verb}`,
    expires_in: args.ttlDays * DAY_SECONDS,
    subject: args.label,
  };
  // OMIT permissions when no tags — vault C0 fail-closes on empty scoped_tags.
  if (args.scopedTags.length > 0) {
    body["permissions"] = { scoped_tags: args.scopedTags };
  }

  const res = await hostAdminAuthedFetch("/api/auth/mint-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  const parsed = (await res.json()) as {
    jti: string;
    token: string;
    scope: string;
    expires_at?: string | null;
  };
  return {
    jti: parsed.jti,
    token: parsed.token,
    scope: parsed.scope,
    expires_at: parsed.expires_at ?? null,
  };
}

/**
 * List the hub JWTs scoped to this vault.
 *
 * Hits `GET /api/auth/tokens` (host-admin bearer). The endpoint has NO
 * server-side vault filter and pages at 50 rows, so we:
 *   1. Follow `next_cursor` and accumulate ALL pages (a single-page filter
 *      would silently hide vault rows once the registry exceeds 50 entries).
 *   2. Client-filter to rows carrying any `vault:<name>:*` scope.
 *
 * `?revoked=all` so revoked rows show too (the UI renders a "revoked" pill).
 */
export async function listHubTokens(vaultName: string): Promise<HubTokenSummary[]> {
  const scopePrefix = `vault:${vaultName}:`;
  const all: HubTokenWireRow[] = [];
  let cursor: string | null = null;
  // Bound the loop defensively — a registry pathologically large or a
  // server bug returning a non-advancing cursor shouldn't spin forever.
  for (let page = 0; page < 1000; page++) {
    const qs = new URLSearchParams({ revoked: "all" });
    if (cursor) qs.set("cursor", cursor);
    const res: Response = await hostAdminAuthedFetch(`/api/auth/tokens?${qs.toString()}`);
    if (!res.ok) {
      throw new HttpError(res.status, await readError(res));
    }
    const body = (await res.json()) as HubTokensListResponse;
    const rows = Array.isArray(body.tokens) ? body.tokens : [];
    all.push(...rows);
    cursor = body.next_cursor ?? null;
    if (!cursor) break;
  }
  return all
    .filter((r) => Array.isArray(r.scopes) && r.scopes.some((s) => s.startsWith(scopePrefix)))
    .map(mapHubRow);
}

/**
 * Revoke a hub JWT by jti.
 *
 * Hits `POST /api/auth/revoke-token` (host-admin bearer) with `{ jti }`.
 * Idempotent server-side (re-revoking returns the existing `revoked_at`).
 */
export async function revokeHubToken(jti: string): Promise<void> {
  const res = await hostAdminAuthedFetch("/api/auth/revoke-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jti }),
  });
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
}

// ---------------------------------------------------------------------------
// Tag picker — vault-admin bearer.
// ---------------------------------------------------------------------------

/**
 * Tag listing for the mint form's tag-picker. Hits `GET /vault/<name>/api/tags`
 * with the vault-admin bearer. The picker only needs root-tag names (it
 * filters out anything with a `/` — only root tags are valid `scoped_tags`).
 */
export async function listVaultTags(vaultName: string): Promise<{ name: string; count: number }[]> {
  const res = await _authedFetch(vaultName, `/vault/${encodeURIComponent(vaultName)}/api/tags`);
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  const body = (await res.json()) as { name: string; count: number }[];
  return Array.isArray(body) ? body : [];
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as {
      error?: string;
      error_description?: string;
      message?: string;
    };
    if (parsed.error_description) return parsed.error_description;
    if (parsed.message) return parsed.message;
    if (parsed.error) return parsed.error;
    if (text) return text;
  } catch {
    // not JSON
  }
  return `${res.status} ${res.statusText}`;
}
