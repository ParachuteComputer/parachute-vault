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
 */

import type { Database } from "bun:sqlite";
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
  db: Database,
  vaultName: string,
  callerScopes: string[],
  subpath: string,
): Promise<Response> {
  if (subpath === "" || subpath === "/") {
    if (req.method === "GET") return listHandler(db);
    if (req.method === "POST") return mintHandler(req, db, vaultName, callerScopes);
    return methodNotAllowed();
  }
  const idMatch = subpath.match(/^\/([^/]+)$/);
  if (idMatch && idMatch[1]) {
    if (req.method === "DELETE") return revokeHandler(db, idMatch[1]);
    return methodNotAllowed();
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

async function mintHandler(
  req: Request,
  db: Database,
  vaultName: string,
  callerScopes: string[],
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
  const created = createToken(db, fullToken, {
    label,
    permission,
    scopes: requested,
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
      expires_at: created.expires_at,
      created_at: created.created_at,
    },
    { status: 201 },
  );
}

function listHandler(db: Database): Response {
  // Direct SELECT (rather than reusing `listTokens`) so we can include the
  // `scopes` column without changing the existing CLI-facing shape.
  const rows = db.prepare(`
    SELECT token_hash, label, permission, scopes, expires_at, created_at, last_used_at
    FROM tokens ORDER BY created_at DESC
  `).all() as {
    token_hash: string;
    label: string;
    permission: string;
    scopes: string | null;
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
      expires_at: r.expires_at,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
    })),
  });
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
