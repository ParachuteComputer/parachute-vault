/**
 * REST handlers for `/vault/<name>/tokens`.
 *
 * The endpoint is admin-gated upstream — `route()` checks
 * `hasScopeForVault(auth.scopes, vaultName, "admin")` before dispatching here,
 * so any caller reaching this module already holds vault:admin (broad or
 * narrowed). POST mints a new pvt_* token with caller-narrowed scopes and
 * returns the plaintext exactly once. GET lists existing tokens (metadata
 * only — no plaintext, no hash). DELETE revokes by display id (`t_…`); a
 * non-existent id still returns 200 to avoid leaking which ids exist.
 *
 * Scope narrowing is enforced as a strict subset check via
 * `validateMintedScopes` — defense-in-depth even with the admin gate, so a
 * future relaxation of the gate cannot accidentally permit privilege
 * escalation. Cross-vault scopes (`vault:<other>:<verb>`) are rejected with
 * the same path.
 *
 * Tag-allowlist narrowing (per patterns/tag-scoped-tokens.md) follows the
 * same defense-in-depth shape: the requested allowlist must be a subset of
 * the minter's. A `null` minter allowlist is the universe — any allowlist
 * may be granted. Each tag must be an existing root-tag name (no `/`) —
 * sub-tags are reached via the `_tags/<name>` hierarchy at enforcement time,
 * not at mint time.
 */

import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../core/src/store.ts";
import {
  generateToken,
  createToken,
  revokeToken,
  normalizePermission,
  type TokenPermission,
} from "./token-store.ts";
import {
  validateMintedScopes,
  parseScopes,
  hasScope,
  SCOPE_WRITE,
  SCOPE_ADMIN,
} from "./scopes.ts";

interface MintRequestBody {
  label?: string;
  /** Either an array (preferred) or a space-separated OAuth-style string. */
  scopes?: string[];
  scope?: string;
  /** ISO-8601 future timestamp, or null/omitted for never-expiring. */
  expires_at?: string | null;
  /**
   * Optional tag-allowlist. Each entry must be an existing root-tag name
   * (no `/`). When omitted or null, the token is unscoped (current behavior).
   * The minted allowlist must be a subset of the caller's allowlist.
   */
  tags?: string[] | null;
}

function badRequest(message: string, extra?: Record<string, unknown>): Response {
  return Response.json({ error: "Bad Request", message, ...extra }, { status: 400 });
}

function methodNotAllowed(): Response {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

function permissionForScopes(scopes: string[]): TokenPermission {
  return hasScope(scopes, SCOPE_WRITE) || hasScope(scopes, SCOPE_ADMIN) ? "full" : "read";
}

export async function handleTokens(
  req: Request,
  store: SqliteStore,
  vaultName: string,
  callerScopes: string[],
  callerScopedTags: string[] | null,
  subpath: string,
): Promise<Response> {
  if (subpath === "" || subpath === "/") {
    if (req.method === "GET") return listHandler(store.db);
    if (req.method === "POST") return mintHandler(req, store, vaultName, callerScopes, callerScopedTags);
    return methodNotAllowed();
  }
  const idMatch = subpath.match(/^\/([^/]+)$/);
  if (idMatch && idMatch[1]) {
    if (req.method === "DELETE") return revokeHandler(store.db, idMatch[1]);
    return methodNotAllowed();
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

async function mintHandler(
  req: Request,
  store: SqliteStore,
  vaultName: string,
  callerScopes: string[],
  callerScopedTags: string[] | null,
): Promise<Response> {
  let body: MintRequestBody;
  try {
    const raw = await req.text();
    body = raw.length === 0 ? {} : (JSON.parse(raw) as MintRequestBody);
  } catch {
    return badRequest("invalid JSON body");
  }

  let requested: string[];
  if (Array.isArray(body.scopes)) {
    requested = body.scopes.filter((s): s is string => typeof s === "string" && s.length > 0);
  } else if (typeof body.scope === "string") {
    requested = parseScopes(body.scope);
  } else {
    // Default: full scope set. Admin caller is required to reach this code,
    // so granting full scope is within their power; explicit narrowing is
    // available via `scopes` / `scope` for least-privilege deployments.
    requested = ["vault:read", "vault:write", "vault:admin"];
  }
  if (requested.length === 0) {
    return badRequest("at least one scope required");
  }

  const validation = validateMintedScopes(requested, vaultName, callerScopes);
  if (!validation.ok) {
    return Response.json(
      { error: "Bad Request", message: "scope rejected", rejected: validation.rejected },
      { status: 400 },
    );
  }

  // Tag-allowlist narrowing. `tags === undefined` or `null` means unscoped
  // (no filtering). When provided, every entry must (a) be a non-empty
  // string, (b) contain no `/` (root tags only — sub-tags reach via the
  // `_tags/<name>` hierarchy at enforcement time), (c) exist in the vault's
  // tag list, and (d) fall within the caller's own allowlist when the caller
  // is themselves tag-scoped (null caller scope = universe = anything OK).
  //
  // Privilege-escalation guard: a tag-scoped minter must NOT be able to
  // produce a `null`-allowlist token (the universe is broader than any
  // finite allowlist). We reject the omission with a clear 403 rather than
  // silently inheriting — explicit > implicit at a security boundary.
  let scopedTags: string[] | null = null;
  if ((body.tags === undefined || body.tags === null) && callerScopedTags !== null) {
    return Response.json(
      {
        error: "Forbidden",
        error_type: "tag_scope_violation",
        message: `minter is tag-scoped (${callerScopedTags.join(", ")}) — request must include an explicit "tags" array within that allowlist; an unscoped token cannot be minted from a scoped one`,
        minter_scoped_tags: callerScopedTags,
      },
      { status: 403 },
    );
  }
  if (body.tags !== undefined && body.tags !== null) {
    if (!Array.isArray(body.tags)) {
      return badRequest("tags must be an array of strings or null");
    }
    if (body.tags.length === 0) {
      return badRequest("tags must be a non-empty array (omit the field, or pass null, for an unscoped token)");
    }
    const cleaned: string[] = [];
    for (const t of body.tags) {
      if (typeof t !== "string" || t.length === 0) {
        return badRequest("each tag must be a non-empty string");
      }
      if (t.includes("/")) {
        return badRequest(
          `tag "${t}" must be a root-tag name (no path separators). Sub-tags inherit via the _tags/<name> hierarchy at enforcement time.`,
        );
      }
      cleaned.push(t);
    }
    // Dedupe while preserving caller-supplied order.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const t of cleaned) {
      if (!seen.has(t)) {
        seen.add(t);
        deduped.push(t);
      }
    }
    // Existence check against the vault's tag list. The pattern doc names
    // list-tags as the source of truth — keeps the CLI/SPA picker and the
    // server in agreement.
    const known = new Set((await store.listTags()).map((t) => t.name));
    const unknown = deduped.filter((t) => !known.has(t));
    if (unknown.length > 0) {
      return badRequest(
        `unknown tag(s): ${unknown.join(", ")} — must be existing root-tag names in vault '${vaultName}'`,
        { unknown_tags: unknown },
      );
    }
    // Subset rule: if the caller is tag-scoped, every requested tag must be
    // in the caller's allowlist. Null caller = universe.
    if (callerScopedTags !== null) {
      const callerSet = new Set(callerScopedTags);
      const escalating = deduped.filter((t) => !callerSet.has(t));
      if (escalating.length > 0) {
        return Response.json(
          {
            error: "Forbidden",
            error_type: "tag_scope_violation",
            message: `cannot mint a token with tag(s) outside the minter's allowlist: ${escalating.join(", ")}`,
            rejected_tags: escalating,
            minter_scoped_tags: callerScopedTags,
          },
          { status: 403 },
        );
      }
    }
    scopedTags = deduped;
  }

  let expiresAt: string | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null) {
    if (typeof body.expires_at !== "string") {
      return badRequest("expires_at must be an ISO-8601 string or null");
    }
    const t = Date.parse(body.expires_at);
    if (Number.isNaN(t)) {
      return badRequest("expires_at is not a valid ISO-8601 timestamp");
    }
    if (t <= Date.now()) {
      return badRequest("expires_at must be in the future");
    }
    expiresAt = new Date(t).toISOString();
  }

  const label = typeof body.label === "string" && body.label.length > 0 ? body.label : "API token";
  const permission = permissionForScopes(requested);

  const { fullToken } = generateToken();
  const created = createToken(store.db, fullToken, {
    label,
    permission,
    scopes: requested,
    scoped_tags: scopedTags,
    expires_at: expiresAt,
  });

  // Display id mirrors `listTokens`: `t_` + first 12 chars of the SHA-256
  // hash payload (the part after the `sha256:` prefix). Stable across reads.
  const id = `t_${created.token_hash.slice(7, 19)}`;

  return Response.json(
    {
      id,
      token: fullToken,
      label: created.label,
      permission: created.permission,
      scopes: requested,
      scoped_tags: scopedTags,
      expires_at: created.expires_at,
      created_at: created.created_at,
    },
    { status: 201 },
  );
}

function listHandler(db: Database): Response {
  // Direct SELECT (rather than reusing `listTokens`) so we can include the
  // `scopes` and `scoped_tags` columns without changing the existing
  // CLI-facing shape that goes through `listTokens`.
  const rows = db.prepare(`
    SELECT token_hash, label, permission, scopes, scoped_tags, expires_at, created_at, last_used_at
    FROM tokens ORDER BY created_at DESC
  `).all() as {
    token_hash: string;
    label: string;
    permission: string;
    scopes: string | null;
    scoped_tags: string | null;
    expires_at: string | null;
    created_at: string;
    last_used_at: string | null;
  }[];

  return Response.json({
    tokens: rows.map((r) => ({
      id: `t_${r.token_hash.slice(7, 19)}`,
      label: r.label,
      permission: normalizePermission(r.permission),
      scopes: parseScopes(r.scopes),
      scoped_tags: parseScopedTagsJSON(r.scoped_tags),
      expires_at: r.expires_at,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
    })),
  });
}

/**
 * Defensive parser for the `tokens.scoped_tags` JSON column. Mirrors the
 * shape used by `token-store.ts#parseScopedTags`: collapse anything that
 * isn't a non-empty array of strings to `null` (the unscoped sentinel) so a
 * corrupt row can't masquerade as a scoped token in the listing.
 */
function parseScopedTagsJSON(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const cleaned = parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

function revokeHandler(db: Database, id: string): Response {
  // Always 200, never leak whether the id existed. Ambiguous prefix matches
  // are treated the same (revokeToken returns false; we ignore it). The 12-
  // char hex prefix collision space is large enough that organic ambiguity
  // is effectively impossible, and security-significant ambiguity would
  // require a chosen-prefix attack against SHA-256.
  revokeToken(db, id);
  return Response.json({ revoked: true });
}
