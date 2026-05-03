/**
 * HTTP client for the per-vault tokens REST surface.
 *
 * Hits `GET|POST /vault/<name>/tokens` (list + mint) and
 * `DELETE /vault/<name>/tokens/<id>` (revoke). Backed by `src/tokens-routes.ts`
 * — the server enforces `vault:<name>:admin` for all three; we send the cached
 * hub-issued JWT as `Authorization: Bearer <jwt>`.
 *
 * Mint returns the plaintext `pvt_*` token exactly once (server can't re-emit
 * it). The caller is responsible for stashing it and surfacing the one-time
 * banner; this module just relays the response.
 */
import { getToken } from "./auth.ts";
import { HttpError } from "./api.ts";

export interface TokenSummary {
  id: string;
  label: string;
  permission: "read" | "full";
  scopes: string[];
  /**
   * Tag-allowlist (root tags). `null` = unscoped (sees the whole vault).
   * Sub-tags inherit at request time via the `_tags/<name>` hierarchy —
   * see patterns/tag-scoped-tokens.md.
   */
  scoped_tags: string[] | null;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface MintTokenResult extends TokenSummary {
  /** Plaintext `pvt_*` token. Shown once; the server never re-emits. */
  token: string;
}

export interface MintTokenInput {
  label?: string;
  /** Optional narrowing. Omit to inherit caller's full scope set. */
  scopes?: string[];
  /**
   * Optional tag-allowlist. Each entry must be an existing root-tag name
   * (no `/`). Omit (or pass null) for an unscoped token. The server
   * enforces a subset rule against the minter's own allowlist.
   */
  tags?: string[] | null;
  expires_at?: string | null;
}

/**
 * Tag listing for the mint form's tag-picker. Hits `GET /vault/<name>/api/tags`
 * — the same endpoint that backs `query-notes`-adjacent tag UIs. The mint
 * picker only needs root-tag names (the picker filters out anything with a
 * `/` since the server only accepts root tags in the `tags` field).
 */
export async function listVaultTags(vaultName: string): Promise<{ name: string; count: number }[]> {
  const res = await fetch(`/vault/${encodeURIComponent(vaultName)}/api/tags`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  const body = (await res.json()) as { name: string; count: number }[];
  return Array.isArray(body) ? body : [];
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) {
    throw new HttpError(401, "no admin token — open this page from the hub directory");
  }
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: string; error_description?: string; message?: string };
    if (parsed.error_description) return parsed.error_description;
    if (parsed.message) return parsed.message;
    if (parsed.error) return parsed.error;
    if (text) return text;
  } catch {
    // not JSON
  }
  return `${res.status} ${res.statusText}`;
}

export async function listTokens(vaultName: string): Promise<TokenSummary[]> {
  const res = await fetch(`/vault/${encodeURIComponent(vaultName)}/tokens`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  const body = (await res.json()) as { tokens?: TokenSummary[] };
  return body.tokens ?? [];
}

export async function mintToken(vaultName: string, input: MintTokenInput): Promise<MintTokenResult> {
  const body: Record<string, unknown> = {};
  if (input.label && input.label.length > 0) body["label"] = input.label;
  if (input.scopes && input.scopes.length > 0) body["scopes"] = input.scopes;
  // `tags: []` would be rejected by the server (non-empty required) — we
  // either send a populated array or omit the field entirely (= unscoped).
  if (input.tags && input.tags.length > 0) body["tags"] = input.tags;
  if (input.expires_at !== undefined) body["expires_at"] = input.expires_at;

  const res = await fetch(`/vault/${encodeURIComponent(vaultName)}/tokens`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as MintTokenResult;
}

export async function revokeToken(vaultName: string, tokenId: string): Promise<void> {
  const res = await fetch(
    `/vault/${encodeURIComponent(vaultName)}/tokens/${encodeURIComponent(tokenId)}`,
    {
      method: "DELETE",
      headers: authHeaders(),
    },
  );
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
}
