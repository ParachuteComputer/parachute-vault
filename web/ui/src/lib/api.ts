/**
 * HTTP client for the vault admin SPA.
 *
 * Two surfaces:
 *   - `GET /vaults/list` — public discovery (no auth). Used to populate the
 *     SPA's vault picker on first load before any token is in hand.
 *   - `GET /vault/<name>/` — per-vault metadata (auth). Returns name,
 *     description, created_at, and stats in a single response. Requires a
 *     hub-issued JWT scoped `vault:<name>:read` (or higher).
 *
 * `vault:<name>:admin` is the scope the SPA's eventual mutate-paths (token
 * mint, config edit) will require — Phase A only reads, but the same JWT
 * carries enough to do so under the inherit rule (admin ⊇ write ⊇ read).
 */
import { getToken } from "./auth.ts";

export interface VaultStats {
  notes: number;
  tags: number;
  attachments: number;
  links: number;
}

export interface VaultDetailResult {
  name: string;
  description?: string | null;
  createdAt?: string;
  stats: VaultStats;
}

/** Status code carried alongside the message so callers can branch numerically. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Public vault-name list. Returns the names of every vault hosted by this
 * server. No auth — operators who want to hide vault existence set
 * `discovery: disabled` in `~/.parachute/vault/config.yaml` (the endpoint
 * 404s in that case; the SPA surfaces an empty list).
 */
export async function listVaultNames(): Promise<string[]> {
  const res = await fetch("/vaults/list", { headers: { accept: "application/json" } });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new HttpError(res.status, `vaults/list fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { vaults?: string[] };
  return body.vaults ?? [];
}

/**
 * Per-vault detail. Hits `/vault/<name>/` — the single-shot landing-page
 * endpoint that returns name, description, createdAt, and stats. Requires
 * a hub-issued JWT in the cached auth state; throws `HttpError(401)` if
 * none is present so the caller can render an "auth required" empty state
 * instead of a generic error.
 */
export async function getVaultDetail(name: string): Promise<VaultDetailResult> {
  const token = getToken();
  if (!token) {
    throw new HttpError(401, "no admin token — open this page from the hub directory");
  }
  const res = await fetch(`/vault/${encodeURIComponent(name)}/`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as VaultDetailResult;
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
