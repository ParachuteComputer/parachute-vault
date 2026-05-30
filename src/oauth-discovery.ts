/**
 * OAuth discovery endpoints — the *resource server* side of the
 * authorization story.
 *
 * Vault is a resource server, not an authorization server. The hub is the
 * OAuth issuer (see [`design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md`](
 * ../../parachute.computer/design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md)
 * and `docs/auth-model.md`). The endpoints below advertise that contract to
 * clients per RFC 8414 + RFC 9728:
 *
 *   - `handleProtectedResource` — RFC 9728: "this is the protected resource
 *     at `<vault>/mcp`; the authorization server lives at <hub>"
 *   - `handleAuthorizationServer` — RFC 8414: "go to <hub>/oauth/* for the
 *     authorization endpoints" (forwarded shape — issuer + endpoints all
 *     name the hub)
 *
 * The standalone OAuth issuer that previously lived in `src/oauth.ts` was
 * retired in vault#366 (workstream E of the UX audit). Hub is now a hard
 * requirement; vault never mints OAuth tokens itself, never renders a
 * consent UI, never accepts `/oauth/authorize|token|register` requests.
 * Operators who need OAuth install the hub and front vault with it.
 *
 * `PARACHUTE_HUB_ORIGIN` is required for these endpoints to advertise the
 * right issuer URL. Without it we fall back to the canonical loopback
 * (`http://127.0.0.1:1939`) since the hub binds that port by default — that
 * keeps single-host installs working without explicit configuration.
 */

import { getHubOrigin } from "./hub-jwt.ts";

/**
 * OAuth scopes vault publishes through discovery, RESOURCE-NARROWED to the
 * specific vault instance the metadata document describes.
 *
 * This MUST be narrowed (`vault:<name>:<verb>`), not broad (`vault:<verb>`).
 * Post auth-unification (vault#282/#412), vault is a pure hub resource server
 * that REJECTS broad `vault:<verb>` tokens (`findBroadVaultScopes` → 401) and
 * requires `vault:<name>:<verb>` scopes carrying `aud=vault.<name>`. A
 * spec-following MCP client (e.g. Claude) reads `scopes_supported` from this
 * PRM and requests exactly those scopes; if we advertise broad `vault:read`
 * the client gets a token stamped `aud=vault` and the per-vault MCP endpoint
 * rejects it ("audience mismatch: expected vault.<name>, got vault") — the
 * "Authorization with the MCP server failed" symptom. Advertising the narrowed
 * shape makes the client request the scope vault will actually accept. The
 * hub's RFC 8707 resource-binding narrows too, but only when the client echoes
 * the `resource` param — advertising narrowed scopes here is the belt that
 * works regardless. See scopes.ts for enforcement.
 */
function scopesSupportedFor(vaultName: string): string[] {
  return [`vault:${vaultName}:read`, `vault:${vaultName}:write`, `vault:${vaultName}:admin`];
}

/**
 * Public-facing base URL of the server. Honors `x-forwarded-*` headers so a
 * Cloudflare Tunnel / Tailscale Funnel / reverse-proxied deployment advertises
 * the right external origin in `resource` URLs.
 *
 * Exported so the router can build `WWW-Authenticate` challenge headers that
 * point at the same origin as the `/.well-known/*` metadata documents.
 */
export function getBaseUrl(req: Request): string {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto");
  if (forwardedHost) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }
  const url = new URL(req.url);
  return url.origin;
}

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Advertises the MCP endpoint as the protected resource and names the hub as
 * the authorization server. Clients following the spec fetch this, then fetch
 * the AS metadata at `<hub>/.well-known/oauth-authorization-server` to drive
 * the full flow.
 */
export function handleProtectedResource(req: Request, vaultName: string): Response {
  const base = getBaseUrl(req);
  const prefix = `/vault/${vaultName}`;
  return Response.json({
    resource: `${base}${prefix}/mcp`,
    authorization_servers: [getHubOrigin()],
    scopes_supported: scopesSupportedFor(vaultName),
    bearer_methods_supported: ["header"],
  });
}

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 *
 * Vault is a resource server, not an authorization server — but we serve this
 * document at `/vault/<name>/.well-known/oauth-authorization-server` (and the
 * RFC 8414 §3.1 path-insertion shape) as a *forwarding* metadata document:
 * issuer + every endpoint name the hub. Clients that follow the PRM pointer
 * land here and discover the hub's actual endpoints; conformant clients that
 * probe AS metadata directly at the vault path get the same answer.
 */
export function handleAuthorizationServer(_req: Request, vaultName: string): Response {
  const hub = getHubOrigin();
  return Response.json({
    issuer: hub,
    authorization_endpoint: `${hub}/oauth/authorize`,
    token_endpoint: `${hub}/oauth/token`,
    registration_endpoint: `${hub}/oauth/register`,
    jwks_uri: `${hub}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: scopesSupportedFor(vaultName),
  });
}
