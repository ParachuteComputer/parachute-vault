# Vault admin web UI

Vite + React + TypeScript SPA mounted per-vault at `/vault/<name>/admin/`
on the running vault server. Phase A (vault#219, closes #216) ships the
scaffold + per-vault detail page; Phase B (vault#220, closes #217) adds
tokens (list / mint / revoke + read-only fallback for non-admin sessions);
Phase C (vault#222, closes #218) surfaces a forward-pointing link from
each vault's detail page to hub's permissions UI (hub#162; grants live in
hub's grants table — modular play is "vault links to hub" rather than
"vault inlines hub data"). Vault#252 moved the mount from origin-rooted
`/admin/*` to `/vault/<name>/admin/*` so the SPA is reachable through
hub's `/vault/<name>/*` proxy.

## Mount-aware contract

The same bundle has to work at any per-vault mount — the vault name
isn't known at build time, so it gets discovered at runtime:

- **Production** — served by `src/admin-spa.ts` at `/vault/<name>/admin/*`
  on the vault HTTP server. Vite's `base` is RELATIVE (`./`) so asset
  URLs come out as `./assets/...` and resolve under whichever path
  served `index.html`. React Router's `basename` is computed at runtime
  by `lib/mount.ts:getBasename()` from `window.location.pathname` —
  hub#173 uses the same shape on the hub side for its dual /hub /vault
  mount.
- **Dev** (`bun run dev`) — Vite serves at `http://127.0.0.1:5175/admin/`
  with a proxy that forwards `/vault` and `/vaults` to `VAULT_ORIGIN`
  (default `http://127.0.0.1:1940`). The runtime basename detector
  treats `/admin/*` as a legacy fallback so dev still works without
  spinning up a real vault. Override the base with `VITE_BASE_PATH=/`
  if you need to dev against the origin root.

`scripts/verify-base.mjs` runs after every build and aborts if
`dist/index.html` doesn't carry relative `./assets/` URLs — the same
drift hub#157 / paraclaw#25 codified, adapted for the per-vault mount.

**Lesson: never hardcode a leading-slash URL** in `Link to=`, `fetch`,
or `<a href>`. `Link` resolves against the runtime basename
automatically; `fetch` calls to `/vault/<name>/...` hit the origin root
regardless of mount and route through to the per-vault API surface
either directly or via hub's proxy. `import.meta.env.BASE_URL` is no
longer the source of truth — read `lib/mount.ts:getBasename()` instead
since it knows about the runtime per-vault prefix.

## Auth

Vault doesn't run its own session-cookie surface (unlike hub). The SPA
consumes a hub-issued JWT that carries a `vault:<name>:admin` scope —
the canonical token shape per scope-narrowing-and-audience.

The token reaches the SPA via URL fragment (`#token=…`), which the hub
appends when its directory page renders the "Manage" link. Vault's
module info declares `managementUrl: "/admin"`; per the module protocol
that string is interpreted **relative to** the module URL `/vault/<name>`
— hub's `resolveManagementUrl` joins them — so the resulting click
target is `/vault/<name>/admin#token=…`. (Vault doesn't expose an
origin-rooted `/admin` route post-vault#252; the literal `/admin` only
lives in the module-info string and gets resolved against the per-vault
module URL.) On bootstrap (`main.tsx`) the SPA calls
`lib/auth.ts:captureTokenFromFragment()`:

1. Read `window.location.hash`, parse `token`.
2. Stash in a module-scoped variable. **Never** localStorage —
   page-snapshot leakage and XSS surface stay narrow.
3. Rewrite the URL via `history.replaceState` so the token doesn't
   linger in the address bar / refresh / copy-paste / screenshot.

`lib/api.ts:getVaultDetail()` sends the cached token as
`Authorization: Bearer <jwt>`. A page reload without re-entering through
the hub leaves the SPA in an unauthenticated state — the operator goes
back to the hub directory and clicks "Manage" again. Phase B may bake in
a refresh path; Phase A keeps the contract minimal.

The vault server validates the JWT through `src/auth.ts:authenticateVaultRequest`
(JWT path) → `src/hub-jwt.ts` → `@openparachute/scope-guard`. Audience
is `vault.<name>`; scope narrowing is enforced (`vault:<name>:<verb>` —
broad `vault:<verb>` from a hub JWT is rejected by `authenticateHubJwt`).

## Layout

```
web/ui/
├── index.html              # vite entry, mounts #root
├── package.json            # @openparachute/vault-web-ui
├── vite.config.ts          # base=/admin/ + dev proxy
├── vitest.config.ts        # jsdom + setup file
├── tsconfig.json
├── scripts/verify-base.mjs # post-build regression check
└── src/
    ├── main.tsx            # BrowserRouter w/ runtime-detected basename
    ├── App.tsx             # nav + Routes (redirects / to /vault/<name>
    │                       #               when mounted under a vault)
    ├── styles.css          # brand tokens (kept in sync with hub's)
    ├── lib/
    │   ├── auth.ts         # fragment-token capture, in-memory cache
    │   ├── mount.ts        # runtime basename + vault-name detection
    │   ├── scope.ts        # JWT payload decode + hasAdminScope gate
    │   ├── api.ts          # listVaultNames + getVaultDetail
    │   └── tokens-api.ts   # listTokens / mintToken / revokeToken
    ├── routes/
    │   ├── VaultsList.tsx  # /  (legacy / dev mount only)
    │   ├── VaultDetail.tsx # /vault/:name
    │   └── VaultTokens.tsx # /vault/:name/tokens
    └── test/setup.ts
```

## Build + dev

```sh
cd web/ui
bun install
bun run dev          # http://127.0.0.1:5175/admin/  (proxies to :1940)
bun run build        # → dist/  (then verify-base.mjs)
bun run typecheck    # tsc --noEmit
bun run test         # vitest run
```

`web/ui/dist/` is in `.gitignore` — the vault server serves it from a
co-located bundle that Vite produces during release builds. Until a
release pipeline lands, run `bun run build` locally; `src/admin-spa.ts`
handles a missing `dist/` by 503ing the `/admin/*` routes with a hint
to build the SPA.

## Brand tokens

`src/styles.css` mirrors hub's web/ui tokens (`--accent`, `--bg`, etc.)
so the operator sees a single visual surface as they bounce between
hub and vault admin pages. Don't drift them without updating both.
