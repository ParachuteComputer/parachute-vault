/**
 * Data plane for the multi-vault home (`/vault/admin/`, B3 of the
 * 2026-06-09 hub-module-boundary migration).
 *
 * Reads:
 *   - The vault LIST comes from the hub's `/.well-known/parachute.json`
 *     `vaults[]` (public, CORS `*`, origin-relative fetch) — the exact read
 *     the hub SPA's VaultsList does. The daemon's own `/vaults` /
 *     `/vaults/list` endpoints are deliberately NOT used: they aren't
 *     proxied through the hub, and `/vaults` rejects hub JWTs.
 *   - Per-vault usage comes from the authed
 *     `GET /vault/<name>/.parachute/usage`, with a fresh per-vault admin
 *     bearer minted from the hub session cookie per call
 *     (`/admin/vault-admin-token/<name>`). Deliberately UNCACHED: the SPA's
 *     `lib/auth.ts` token cache is one-vault-per-document by design, and a
 *     list view fanning out across N vaults must not churn it. Same shape
 *     as the hub SPA's `getVaultUsage`.
 *
 * Writes (both drive hub identity-transaction endpoints with a host-admin
 * bearer via `hostAdminAuthedFetch` — the seam the hub-module-boundary
 * charter names: the hub owns the transaction, this module's surface owns
 * the UX):
 *   - create → `POST /vaults` (201 fresh / 200 idempotent re-POST).
 *   - delete → `DELETE /vaults/<name>` with the retype-the-name
 *     `{"confirm": "<name>"}` body; 200 carries the structured cascade
 *     summary, 409 is the last-vault refusal.
 *
 * No-hub detection: served direct on :1940 the daemon doesn't host
 * `/.well-known/parachute.json` (the hub origin is the front door), so the
 * well-known fetch 404s → the home degrades to a read-only banner.
 */
import { HostAdminError, hostAdminAuthedFetch } from "./host-admin-auth.ts";

/** One `vaults[]` entry from the hub's well-known doc (the fields the home
 *  view reads — the wire carries more). */
export interface WellKnownVault {
  name: string;
  url: string;
  version: string;
  managementUrl?: string;
}

export type WellKnownVaultsResult =
  | { kind: "ok"; vaults: WellKnownVault[] }
  /** Well-known doc absent — the SPA is being served directly by the vault
   *  daemon (no hub front door). The home renders read-only. */
  | { kind: "no-hub" }
  | { kind: "error"; message: string };

/** Fetch the hub's discovery doc and project the `vaults[]` array. */
export async function listWellKnownVaults(): Promise<WellKnownVaultsResult> {
  let res: Response;
  try {
    res = await fetch("/.well-known/parachute.json", {
      headers: { accept: "application/json" },
    });
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return { kind: "no-hub" };
  if (!res.ok) {
    return { kind: "error", message: `well-known fetch failed: ${res.status}` };
  }
  let body: { vaults?: unknown };
  try {
    body = (await res.json()) as { vaults?: unknown };
  } catch {
    // A non-JSON 200 at /.well-known/parachute.json means whatever served
    // this page isn't a hub either.
    return { kind: "no-hub" };
  }
  const raw = Array.isArray(body.vaults) ? body.vaults : [];
  const vaults: WellKnownVault[] = [];
  for (const v of raw) {
    const row = (v ?? {}) as Record<string, unknown>;
    if (typeof row.name !== "string") continue;
    vaults.push({
      name: row.name,
      url: typeof row.url === "string" ? row.url : "",
      version: typeof row.version === "string" ? row.version : "",
      ...(typeof row.managementUrl === "string" ? { managementUrl: row.managementUrl } : {}),
    });
  }
  return { kind: "ok", vaults };
}

/** Subset of the per-vault usage report the list row renders. */
export interface VaultUsage {
  notes: number;
  /** Physical footprint bytes (`bytes.total` from the vault report). */
  totalBytes: number;
}

/**
 * Fetch one vault's usage through the hub proxy. Mints a fresh
 * `vault:<name>:admin` bearer from the session cookie per call (uncached —
 * see the module docstring). Throws on any failure; the caller renders "—"
 * per row, so a vault that's down / pre-usage-endpoint / unmintable never
 * breaks the list.
 */
export async function fetchVaultUsage(name: string): Promise<VaultUsage> {
  const mintRes = await fetch(`/admin/vault-admin-token/${encodeURIComponent(name)}`, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!mintRes.ok) {
    throw new Error(`vault-admin-token mint failed: ${mintRes.status}`);
  }
  const minted = (await mintRes.json()) as { token?: string };
  if (typeof minted.token !== "string" || minted.token.length === 0) {
    throw new Error("vault-admin-token mint returned no token");
  }
  const res = await fetch(`/vault/${encodeURIComponent(name)}/.parachute/usage`, {
    headers: { accept: "application/json", authorization: `Bearer ${minted.token}` },
  });
  if (!res.ok) {
    throw new Error(`usage fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    counts?: { notes?: unknown };
    bytes?: { total?: unknown };
  };
  const notes = body.counts?.notes;
  const totalBytes = body.bytes?.total;
  if (typeof notes !== "number" || typeof totalBytes !== "number") {
    throw new Error("usage report malformed");
  }
  return { notes, totalBytes };
}

/** Human-readable byte size — B / KB / MB / GB, one decimal for MB+.
 *  Ported from the hub SPA's formatBytes so the two lists read alike. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Name validation (client-side immediacy; the hub edge stays authoritative)
// ---------------------------------------------------------------------------

const VAULT_NAME_RE = /^[a-z0-9_-]+$/;
/** Mirrors the consolidated server-side set (vault `src/vault-name.ts` /
 *  hub `src/vault-name.ts` — 2026-06-09 B2). */
const RESERVED_VAULT_NAMES = new Set(["list", "new", "assets", "admin"]);

/** Returns a field error for a candidate vault name, or null when valid.
 *  Empty input returns null so an untouched field doesn't yell. */
export function validateNewVaultName(name: string): string | null {
  if (name.length === 0) return null;
  if (!VAULT_NAME_RE.test(name)) {
    return "Lowercase letters, numbers, hyphens, and underscores only.";
  }
  if (name.length < 2 || name.length > 32) {
    return "Vault names must be 2–32 characters long.";
  }
  if (RESERVED_VAULT_NAMES.has(name)) {
    return `"${name}" is a reserved name.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Create — POST /vaults (host-admin Bearer)
// ---------------------------------------------------------------------------

export interface CreateVaultResult {
  name: string;
  url: string;
  version: string;
  /** True on HTTP 201 (fresh create); false on the idempotent 200 re-POST. */
  created: boolean;
  /** One-shot bootstrap token — present only when the hub minted one. */
  token?: string;
  tokenGuidance?: string;
}

/** Error from the create/delete endpoints carrying the HTTP status and the
 *  hub's `error_description`. `HostAdminError` (auth dispositions) passes
 *  through from `hostAdminAuthedFetch` un-wrapped. */
export class VaultsApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "VaultsApiError";
  }
}

async function readApiError(res: Response): Promise<VaultsApiError> {
  let code: string | undefined;
  let message = `${res.status}`;
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    if (typeof body.error === "string") code = body.error;
    message = body.error_description ?? body.error ?? message;
  } catch {
    // non-JSON body — keep the bare status
  }
  return new VaultsApiError(res.status, message, code);
}

/** Drive hub `POST /vaults`. Throws `HostAdminError` for auth failures
 *  (sign-in banner / account redirect) and `VaultsApiError` for the rest. */
export async function createVaultViaHub(name: string): Promise<CreateVaultResult> {
  const res = await hostAdminAuthedFetch("/vaults", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw await readApiError(res);
  const body = (await res.json()) as {
    name: string;
    url: string;
    version: string;
    token?: string;
    token_guidance?: string;
  };
  const result: CreateVaultResult = {
    name: body.name,
    url: body.url,
    version: body.version,
    created: res.status === 201,
  };
  // A 201 can legitimately carry `token: ""` (mint unavailable) — branch on
  // `created`, never token truthiness (the hub SPA's NewVault lesson).
  if (body.token) result.token = body.token;
  if (body.token_guidance) result.tokenGuidance = body.token_guidance;
  return result;
}

// ---------------------------------------------------------------------------
// Delete — DELETE /vaults/<name> (host-admin Bearer + confirm body)
// ---------------------------------------------------------------------------

/** Structured cascade summary from hub#637's `DELETE /vaults/<name>`. */
export interface DeleteCascadeSummary {
  tokens_revoked: number;
  grants_rewritten: number;
  grants_dropped: number;
  user_vaults_removed: number;
  invites_invalidated: number;
  connections_torn_down: number;
  /** Legacy vault-backed channel entries still referencing the vault —
   *  report-only; the operator removes them from channel's own UI. */
  orphaned_channels: string[];
  vault_removed: boolean;
  module_restarted: boolean;
}

export interface DeleteVaultResult {
  name: string;
  cascade: DeleteCascadeSummary;
  warnings: { step: string; detail: string }[];
}

/**
 * Drive hub `DELETE /vaults/<name>` with the retype-the-name confirm body.
 * Throws `HostAdminError` for auth failures and `VaultsApiError` otherwise
 * — notably status 409 / code `last_vault` (the resurrection guard; the
 * hub's message names the CLI escape hatch).
 */
export async function deleteVaultViaHub(name: string): Promise<DeleteVaultResult> {
  const res = await hostAdminAuthedFetch(`/vaults/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: name }),
  });
  if (!res.ok) throw await readApiError(res);
  const body = (await res.json()) as {
    name: string;
    cascade: DeleteCascadeSummary;
    warnings?: { step: string; detail: string }[];
  };
  return { name: body.name, cascade: body.cascade, warnings: body.warnings ?? [] };
}

export { HostAdminError };
