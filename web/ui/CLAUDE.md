# Vault admin web UI

Vite + React + TypeScript SPA mounted at `/admin/` on the running vault
server. Phase A (vault#216) ships the scaffold + per-vault detail page;
Phase B (#217) adds tokens; Phase C (#218) adds permissions.

## Mount-aware contract

The same bundle has to work two places:

- **Production** — served by `src/admin-spa.ts` at `/admin/*` on the vault
  HTTP server. Vite's `base` defaults to `/admin/` (`vite.config.ts`), so
  asset URLs come out as `/admin/assets/...` and react-router's `basename`
  resolves to `/admin`.
- **Dev** (`bun run dev`) — Vite serves at `http://127.0.0.1:5175/admin/`
  with a proxy that forwards `/vault` and `/vaults` to `VAULT_ORIGIN`
  (default `http://127.0.0.1:1940`). Override the base with
  `VITE_BASE_PATH=/` if you need to dev against the origin root.

`scripts/verify-base.mjs` runs after every build and aborts if
`dist/index.html` doesn't carry the `/admin/`-prefixed asset URLs — the
same drift hub#157 / paraclaw#25 codified.

**Lesson: never hardcode a leading-slash URL** in `Link to=`, `fetch`,
or `<a href>`. `Link` resolves against `BASE_URL` automatically; `fetch`
calls hit the origin root regardless of mount, which is what we want for
`/vaults/list` and `/vault/<name>/...`. If you need the mounted prefix,
use `import.meta.env.BASE_URL`.

## Auth

Vault doesn't run its own session-cookie surface (unlike hub). The SPA
consumes a hub-issued JWT that carries a `vault:<name>:admin` scope —
the canonical token shape per scope-narrowing-and-audience.

The token reaches the SPA via URL fragment (`#token=…`), which the hub
will append when its directory page renders the "Manage" link to
vault's `managementUrl: "/admin"`. On bootstrap (`main.tsx`) the SPA
calls `lib/auth.ts:captureTokenFromFragment()`:

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
    ├── main.tsx            # BrowserRouter w/ mount-aware basename
    ├── App.tsx             # nav + Routes
    ├── styles.css          # brand tokens (kept in sync with hub's)
    ├── lib/
    │   ├── auth.ts         # fragment-token capture, in-memory cache
    │   └── api.ts          # listVaultNames + getVaultDetail
    ├── routes/
    │   ├── VaultsList.tsx  # /
    │   └── VaultDetail.tsx # /vault/:name
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
