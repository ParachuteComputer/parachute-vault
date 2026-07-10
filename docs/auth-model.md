# Auth model

Reference for how Parachute Vault authenticates and authorizes requests. The
**vault is auth-gated by default**: every route that touches vault data
requires a credential. The narrow set of genuinely public routes (OAuth
discovery forwarders, the service-info card, published notes) is listed
explicitly in §2.

**Vault is OAuth resource-server-only.** It does not mint OAuth tokens, render
a consent UI, or accept dynamic-client-registration requests. The
authorization server is the hub (`@openparachute/hub`) — install it to drive
the OAuth flow. Vault validates the hub's signed JWTs; the discovery
endpoints below are forwarders that point clients at the hub.

For the OAuth-issuer story that sits above this layer, see
[`design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md`](../../parachute.computer/design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md).

> **History.** Vault used to ship a standalone OAuth 2.1 + PKCE + DCR
> issuer with a server-rendered consent page protected by an owner password
> (+ optional TOTP). That posture was retired in vault 0.4.x (workstream E
> of the UX audit, 2026-05-25). Operators on that posture should install
> the hub — see [`UPGRADING.md`](../UPGRADING.md#workstream-e--standalone-oauth-retired).

## 1. Mechanisms

### Hub-issued JWT (the OAuth path)

The hub signs JWTs (RS256, keys advertised at `<hub>/.well-known/jwks.json`).
Vault validates them via `validateHubJwt` (`src/hub-jwt.ts`):

- `iss` must equal the hub origin (`PARACHUTE_HUB_ORIGIN`, defaulting to
  `http://127.0.0.1:1939`).
- The JWKS used to verify the signature is fetched from the **local** hub
  (loopback `http://127.0.0.1:1939` by default), **not** from the `iss`
  origin. The two are separate concerns: `iss` validates against the public
  origin the hub mints with, while the keys are read from the co-located hub
  to avoid hairpinning the fetch out through the public Cloudflare tunnel and
  back to the same box (vault#464). A vault running on a **separate box** from
  its hub overrides the fetch origin with `PARACHUTE_HUB_JWKS_ORIGIN` (the
  hub's reachable internal address); co-located / standalone / single-container
  deploys need no action.
- `aud` is strict-checked against `vault.<name>` so a token stamped for one
  vault can't reach another.
- `scope` claim carries OAuth-standard scopes (see "API tokens" below for the
  scope vocabulary).
- A `vault_scope` claim provides per-user vault pinning (multi-user Phase 1).

Discovery surface vault still serves so clients can find the hub:

- **RFC 9728** Protected Resource Metadata —
  `/vault/<name>/.well-known/oauth-protected-resource` advertises the MCP
  endpoint as the protected resource and names the hub as the authorization
  server.
- **RFC 8414** Authorization Server Metadata —
  `/vault/<name>/.well-known/oauth-authorization-server` returns hub-rooted
  issuer + endpoint URLs. Both path-append
  (`/vault/<name>/.well-known/<type>`) and path-insert
  (`/.well-known/<type>/vault/<name>`) shapes are served; the path-insert
  form is what strict clients (e.g. Claude Code's MCP SDK) probe.

**Clients that use this flow today:** claude.ai, ChatGPT, Claude Desktop,
Claude Code, the Notes PWA.

### API tokens (Bearer)

Long-lived tokens for scripts, agents, and any client that won't drive a
browser through consent. As of vault 0.5.0 (vault#282 Stage 2) these are
**hub-issued JWTs** — vault no longer mints its own opaque tokens.

**Format:** a hub-signed JWT (RS256), the same shape the OAuth flow issues.
Audience-bound to `vault.<name>`, scope-narrowed (`vault:<name>:<verb>`).
See "Hub-issued JWT (the OAuth path)" above for the validation contract.

**Provenance + storage:** minted and tracked on the hub, not in vault. Vault
validates each presented JWT against the hub's JWKS per-request; it stores no
token plaintext or hash. (A vestigial per-vault `tokens` table persists in
older DBs from pre-0.5.0 minting — it's no longer written to; `parachute-vault
tokens list` / `revoke` exist only to clean those rows up.)

**Scopes** (carried in the JWT `scope` claim):

- `vault:read` — GETs on `/api/*` and read-only MCP tools (`query-notes`,
  `list-tags`, `find-path`, `vault-info`, `doctor` — `doctor` moved here from
  `admin` in the write/admin re-tier below: it never mutates and is already
  tag-scope-restricted)
- `vault:write` — mutation routes on `/api/*`, and the content-authorship MCP
  tools (`create-note`, `update-note`, `delete-note`)
- `vault:admin` — `GET /.parachute/config`; the schema/taxonomy-curation MCP
  tools (`update-tag`, `delete-tag`, `rename-tag`, `merge-tags`,
  `prune-schema`, `manage-token`) and `vault-info`'s description-update
  branch — structure/taxonomy/vault-config curation is a distinct tier from
  content authorship, moved here from `write` (BREAKING — see CHANGELOG);
  inherits read + write

  MCP tool → verb reference: `read` = `query-notes`, `list-tags`,
  `find-path`, `vault-info` (stats), `doctor`. `write` (additive) =
  `create-note`, `update-note`, `delete-note`. `admin` (additive) =
  `update-tag`, `delete-tag`, `rename-tag`, `merge-tags`, `prune-schema`,
  `manage-token`, `vault-info` (description update). Source of truth:
  `requiredVerb` on each tool in `core/src/mcp.ts`.

Inheritance: `vault:admin ⊇ vault:write ⊇ vault:read`. The
`vault:<name>:<verb>` shape is the resource-narrowed form hub JWTs carry.

**Transport:** tokens are accepted in this priority order:

1. `Authorization: Bearer <token>`
2. `X-API-Key: <token>`
3. `?key=<token>` query string (for MCP clients that can only carry a URL,
   e.g. Claude Web)

**Minting (on the hub):**

```
parachute auth mint-token --scope vault:<name>:read     # read-only JWT for a vault
parachute auth mint-token --scope vault:<name>:write    # mutation JWT
parachute auth mint-token --scope vault:<name>:admin    # admin JWT (config, etc.)
parachute-vault mcp-install --mint                       # mint + wire a JWT into an MCP client
```

The admin SPA's **Tokens** page is the GUI equivalent — mint, list, and revoke
hub JWTs from the browser. `parachute-vault tokens` retains only:

```
parachute-vault tokens                     # list vestigial pre-0.5.0 token rows (all vaults)
parachute-vault tokens revoke <token-id>   # revoke a vestigial row
```

`parachute-vault tokens create` was **removed at 0.5.0** — it now exits 1 with
a pointer to `parachute auth mint-token`. Minting and revocation live on the
hub; vault is a pure resource-server.

### Legacy: YAML `api_keys` and `X-API-Key`

Older deployments stored keys as bcrypt hashes in
`~/.parachute/vault/config.yaml` (`api_keys`) or per-vault in
`~/.parachute/vault/<vault>/vault.yaml`. These keys had a `pvk_` prefix.

Status: **still accepted for back-compat** and matched after the hub-JWT
and operator-token checks fail (`src/auth.ts`). Each use logs a one-time
deprecation warning (`[scopes] legacy permission-based auth used …`). Plan
to remove one release after the scope model settles.

The `X-API-Key` header itself is not legacy — it's still a supported
transport for any accepted credential (hub JWT, `VAULT_AUTH_TOKEN`, or a
legacy `pvk_` key).

## 2. Endpoint-by-endpoint auth behavior

Per-vault resources live under `/vault/<name>/…`. The table covers every
route registered in `src/routing.ts`, `src/routes.ts`, and `src/mcp-http.ts`.

### Cross-vault / origin-root

| Path | Method | Auth required | Unauthenticated response | Notes |
|---|---|---|---|---|
| `/health` | GET | None (public by design) | `200 {"status":"ok"}` | With a valid bearer, additionally returns `vaults: […]`. Intentionally public so monitoring probes work without a secret. |
| `/vaults/list` | GET | None (public by design) | `200 {"vaults":[…]}`, or `404` if `discovery: disabled` is set in global config | Leaks vault *names*. Opt out by setting `discovery: disabled` in `~/.parachute/vault/config.yaml`. |
| `/vaults` | GET | Bearer (any scope) | `401 {"error":"Unauthorized", "message":"API key required"}` | Returns `{name, description, created_at}` per vault. |
| `/.well-known/oauth-protected-resource/vault/<name>[/mcp]` | GET | None (RFC 9728 discovery) | `200 <metadata>` or `404` if vault not found | Public by spec — advertises where to authenticate. |
| `/.well-known/oauth-authorization-server/vault/<name>[/mcp]` | GET | None (RFC 8414 discovery) | `200 <metadata>` or `404` if vault not found | Public by spec. |

### Per-vault OAuth discovery (`/vault/<name>/…`)

| Path | Method | Auth required | Response |
|---|---|---|---|
| `/oauth/register` | POST | — (retired) | `410 {error:"oauth_endpoint_removed", protected_resource_metadata: "…"}` |
| `/oauth/authorize` | GET/POST | — (retired) | `410` (same shape) |
| `/oauth/token` | POST | — (retired) | `410` (same shape) |
| `/.well-known/oauth-protected-resource` | GET | None (discovery) | `200 {resource, authorization_servers: [<hub-origin>], …}` |
| `/.well-known/oauth-authorization-server` | GET | None (discovery) | `200 {issuer: <hub-origin>, authorization_endpoint: <hub>/oauth/authorize, …}` (forwarder document) |

The `/oauth/{register,authorize,token}` endpoints returned vault-side OAuth
issuance until vault 0.4.x. They now return `410 Gone` with a pointer to
the protected-resource metadata so confused clients can rediscover the new
issuer (the hub). The discovery documents stay live, forwarding clients to
the hub's OAuth endpoints.

### Per-vault service info + icon (hub integration)

| Path | Method | Auth required | Response |
|---|---|---|---|
| `/vault/<name>/.parachute/info` | GET | None (public; `Access-Control-Allow-Origin: *`) | `200 {name, displayName, tagline, version, iconUrl, kind}` |
| `/vault/<name>/.parachute/icon.svg` | GET | None (public; cached 1 h) | `200 <svg>` |
| `/vault/<name>/.parachute/config/schema` | GET | None (public by design — schema is shape, not values) | `200 <JSON schema>` |
| `/vault/<name>/.parachute/config` | GET | Bearer with `vault:admin` | `200 <config>`, `401` if no credential, `403 {error:"Forbidden", error_type:"insufficient_scope", required_scope:"vault:admin", granted_scopes:[…]}` otherwise |

### Per-vault MCP + views + REST

| Path | Method | Auth required | Unauthenticated response | Authenticated-but-underscoped response |
|---|---|---|---|---|
| `/vault/<name>/mcp[/…]` | any | Bearer (any vault scope) | `401 {error:"Unauthorized", …}` + `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728 challenge) | Per-tool: `vault:read` (`query-notes`/`list-tags`/`find-path`/`vault-info`/`doctor`), `vault:write` (`create-note`/`update-note`/`delete-note`), or `vault:admin` (`update-tag`/`delete-tag`/`rename-tag`/`merge-tags`/`prune-schema`/`manage-token`, and `vault-info`'s description-update branch). Under-scoped `tools/call` returns `{isError:true, content:[…"requires the '<verb>' scope"…]}`. Under-scoped tools are *also filtered out of `tools/list`*. |
| `/vault/<name>/view/<idOrPath>` | GET | Auth-aware (see notes) | `404 Not Found` for private notes; `200 <html>` for published notes | — |
| `/vault/<name>/public/<id>` | GET | Auth-aware (legacy alias) | `301` to `/vault/<name>/view/<id>` preserving `?key=…` | — |
| `/vault/<name>` | GET | Bearer (any scope) | `401` | — |
| `/vault/<name>/api/notes[/…]` | GET/HEAD | Bearer with `vault:read` | `401` | `403 {error:"Forbidden", error_type:"insufficient_scope", required_scope:"vault:read", granted_scopes:[…]}` |
| `/vault/<name>/api/notes[/…]` | POST/PATCH/DELETE | Bearer with `vault:write` | `401` | `403` with `required_scope:"vault:write"` |
| `/vault/<name>/api/tags[/…]` | GET | Bearer with `vault:read` | `401` | `403` |
| `/vault/<name>/api/tags[/…]` | POST/PUT/DELETE | Bearer with `vault:write` | `401` | `403` |
| `/vault/<name>/api/find-path` | GET | Bearer with `vault:read` | `401` | `403` |
| `/vault/<name>/api/vault` | GET | Bearer with `vault:read` | `401` | `403` |
| `/vault/<name>/api/vault` | PATCH | Bearer with `vault:write` | `401` | `403` |
| `/vault/<name>/api/unresolved-wikilinks` | GET | Bearer with `vault:read` | `401` | `403` |
| `/vault/<name>/api/storage/upload` | POST | Bearer with `vault:write` | `401` | `403` |
| `/vault/<name>/api/storage/<path>` | GET | Bearer with `vault:read` | `401` | `403` |
| `/vault/<name>/api/health` | GET | Bearer with `vault:read` | `401` | `403` |

**`/view/<idOrPath>` notes:** always served over GET. Publication is
determined by (a) the note carrying the `published_tag` from
`vault.yaml` (default `publish`), or (b) `metadata.published === true`.
An authenticated caller sees any note; an unauthenticated caller sees
*only* published notes and gets `404` for everything else (same response
shape as a missing note — we don't leak the existence of private notes).

**Scope inheritance:** every `403` above resolves against
`admin ⊇ write ⊇ read`. A token with `vault:admin` passes every scope
gate; a `vault:write` token passes read gates; a `vault:read` token
fails write gates.

**MCP `tools/list` visibility:** tools the caller can't execute are
hidden from the list, not just rejected on call. Read-only keys see
`query-notes`, `list-tags`, `find-path`, `vault-info`, `doctor` and nothing
else.

## 3. What a user has to do

Two setup paths. **Neither is a prerequisite for the other** — either
works on its own, and running both is fine.

### Path A: "I want humans (claude.ai, ChatGPT, Claude Desktop, …) to use this"

OAuth lives on the hub. Install it:

```
parachute install hub
```

Then, in the client:

- Add the vault's MCP URL (`https://…/vault/<name>/mcp`) as a connector.
- The client does OAuth discovery → DCR → authorize → token exchange
  against the hub (the discovery documents vault serves forward there
  automatically).
- The hub renders the consent page; sign-in there with your hub credentials.
- The client stores the minted hub JWT and uses it from then on.

### Path B: "I want a script or agent to use this"

Mint a hub JWT — vault no longer mints its own tokens (vault#282 Stage 2):

```
parachute auth mint-token --scope vault:<name>:read     # read-only JWT for a vault
parachute auth mint-token --scope vault:<name>:write    # mutation JWT
parachute auth mint-token --scope vault:<name>:admin    # admin JWT (config, etc.)
```

The command prints the JWT once. Put it in the client's
`Authorization: Bearer <token>` header (or `X-API-Key`, or `?key=`).
The admin SPA's **Tokens** page is the GUI equivalent (mint / list /
revoke); revocation lives on the hub.

Pick the narrowest `--scope` that the script needs — a `vault:<name>:read`
JWT can't mutate, which keeps blast radius small if it leaks. For wiring a
hub JWT straight into an MCP client config, `parachute-vault mcp-install
--mint` does the mint-and-write in one step (see §1 "API tokens").

## 4. Default exposure posture

The Bun server binds **`127.0.0.1`** by default (`src/server.ts`,
resolved via `src/bind.ts`). The socket itself only accepts connections
arriving on the loopback interface — LAN and public interfaces are not
reachable unless the operator opts in. The startup log echoes the
resolved hostname (`Parachute Vault server listening on
http://127.0.0.1:1940`) so the bind is always visible.

**Overriding the default**: set `VAULT_BIND` to bind a different
interface. The two common reasons to override:

- `VAULT_BIND=0.0.0.0` — accept traffic from every interface. Required
  for **Docker bridge networking** (the container's virtual interface
  isn't loopback from the server's perspective) and for intentional
  **LAN setups** where another machine on the local network needs to
  reach vault directly.
- `VAULT_BIND=10.0.0.5` (or similar) — bind one specific interface IP
  on a multi-homed host.

Empty or whitespace-only `VAULT_BIND` is treated as unset.

**Supported remote-access paths are unaffected by the loopback
default.** `parachute expose tailnet` (Tailscale Serve) and `parachute
expose public` (Cloudflare Tunnel) both proxy *from* loopback — they
connect to `127.0.0.1:1940` on the local host and forward the decrypted
traffic in. Neither needs `VAULT_BIND` set. The auth model does not
change when you expose: those commands don't rewrite auth rules, they
just change *which networks can attempt to reach* an already
auth-gated server. Everything in §2 still applies — the bearer gate,
the scope gate, the OAuth flow, the public-by-design endpoints. When
you expose, the public-by-design endpoints (`/health`, `/vaults/list`,
`/.well-known/*`, OAuth discovery, `/.parachute/info`,
`/.parachute/icon.svg`, `/.parachute/config/schema`, published notes
at `/view/…`) become reachable from wherever you exposed to. Treat
that as part of the threat model, not as a bug.

## 5. Known rough edges

Honest list. Things a user might trip over, or that the launch copy
should be careful about.

- **Mint the narrowest scope you need.** `parachute auth mint-token`
  takes an explicit `--scope vault:<name>:<verb>`; a `vault:<name>:read`
  JWT can't mutate, which keeps blast radius small if it leaks. There's no
  full-scope default to trip over post-0.5.0 — minting moved to the hub,
  and the hub asks for a scope. (vault#282 Stage 2 removed
  `parachute-vault tokens create`, whose no-flag default *was* full scope.)
- **Hub JWTs are audience-bound, not per-vault-DB.** A hub JWT is stamped
  `aud=vault.<name>` and validated against the hub's JWKS per-request — it
  carries its vault in the token, not in a per-vault SQLite row. A token
  for one vault is rejected at any other (audience strict-check +
  `vault_scope` defense-in-depth). The old per-vault `pvt_*` DB tokens
  this bullet used to describe were dropped at 0.5.0.
- **No per-IP rate limit on bearer-token brute-force.** An attacker
  hammering `/vault/<name>/api/notes` with forged bearers is not rate
  limited at the vault layer. Hub JWTs are RS256-signed (forgery needs the
  hub's private key, not a guess), so this is academic, but worth knowing
  when planning exposure. (The per-IP rate limiter that used to gate the
  standalone OAuth consent POST was retired alongside the consent page in
  vault 0.4.x; the hub-owned consent surface has its own rate limit.)
- **Public-by-design endpoints leak structural info.** `/health` (with
  auth) and `/vaults/list` (by default, disable with `discovery:
  disabled`) reveal which vaults exist. `/.well-known/oauth-*` reveals
  that a vault exists at `/vault/<name>`. `/.parachute/info` reveals the
  running version. All of these are intentional, but each is
  discoverable by anyone who can reach the server.
- **Published notes bypass auth by design.** `/vault/<name>/view/<id>`
  serves any note tagged with `published_tag` (default `publish`) or
  carrying `metadata.published: true` as HTML with no credential. If a
  user inadvertently tags a private note `publish`, the whole internet
  sees it once the vault is exposed.
- **Legacy `pvk_` keys and `X-API-Key` keep working.** Pre-v0.3 users'
  YAML-stored `pvk_` keys are accepted and migrated on init; each use
  logs a one-time deprecation warning. Plan removal is "one release
  after scope enforcement settles" (not yet scheduled).
- **`WWW-Authenticate` challenges are only added on `/mcp` 401s.** The
  REST API returns plain `401 {error:"Unauthorized"}` without an RFC
  9728 challenge header. A generic HTTP client won't auto-discover the
  authorization server from a REST 401 — that's fine (clients that care
  use the MCP path), but REST API consumers must read the OAuth
  metadata document explicitly.
