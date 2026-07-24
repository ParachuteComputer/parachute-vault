# Parachute Vault

Agent-native knowledge graph — notes, tags, links, attachments over MCP + REST. Self-hosted,
one-command setup; one Bun server (port 1940) hosts many vaults, each its own SQLite DB.
**Real users depend on this repo — keep the wire contract and on-disk formats compatible.**

## Layout

- `core/` owns the domain — schema, store + query, wikilinks, paths, MCP tool generation
  (`core/src/`). Read the data model and tool inventory from source when you need them;
  don't trust a memorized list.
- `src/` — the Bun CLI + daemon around core: server, MCP (stdio + HTTP), webhook triggers.
- `web/ui/` — React admin SPA · `deploy/` — systemd / Docker / compose.

## Conventions

- Bun for everything (`Bun.serve`, `bun:sqlite`, `Bun.$`, `bun test`). No Node.js.
- Bare primitives: vaults start blank — clients bring their own tag schema. Opt-in seed
  packs live in `core/src/seed-packs.ts` (`add-pack <name>`).
- `[[wikilinks]]` in content are parsed and maintained as links automatically; paths are
  normalized + UNIQUE and drive wikilink resolution.
- `vault.yaml`'s description is served as the MCP session instruction — the vault teaches
  the AI how to use it.
- All config lives in `~/.parachute/vault/.env`; `PARACHUTE_HOME` overrides the root (Docker).
- `core/src/portable-md.ts` is the canonical portable-markdown format (lossless
  export/import round-trip, pinned by `portable-md.test.ts`); `core/src/obsidian.ts` is a
  deprecated back-compat shim — new code imports from portable-md.

## Tests — two suites, two runners

- Server + core run under `bun:test`: `bun test ./src/`, `bun test ./core/src/`, or bare
  `bun test` for both (`web/ui/**` is excluded via `bunfig.toml`).
- The admin SPA runs under **vitest** (`cd web/ui && bunx vitest run`) — its tests need
  `vi.mock` auto-stubbing, jsdom, and testing-library, none of which `bun:test` supports
  (vault#294). A `bun test` that walks into `web/ui/` fails spuriously on a green tree.

## Gotchas — the burn list

- **Never `Bun.spawnSync` a child that probes an in-process `Bun.serve` over HTTP** —
  `spawnSync` blocks the parent's event loop, the in-test server can't answer, and the
  test silently times out into the "nothing listening" branch, asserting the wrong path
  (vault#325). Use `runSubprocess` from `src/test-support/spawn.ts`; the full rule
  (including where `spawnSync` is still fine) lives in that file.
- **`uninstall --skip-daemon` — test-only, deliberately absent from `usage()`.** Uninstall
  targets the hardcoded launchd label `computer.parachute.vault` regardless of
  `PARACHUTE_HOME`, so a naive test spawning `uninstall --yes` would `launchctl bootout`
  the developer's real daemon. Tests pass the flag to exercise everything else (vault#296);
  humans should never use it.
- **Autostart defaults off when a hub supervisor is detected** — a self-registered
  launchd/systemd unit would race the hub-supervised child for :1940 (parachute-hub#580).
  An explicit `--autostart` / `--no-autostart` persists in `config.yaml`; the hub-present
  default is a per-run inference. A box with a previously persisted `autostart: true`
  keeps self-registering even under a hub — clear it once with
  `parachute-vault init --no-autostart`.
- **BYO GitHub App for the mirror backup flow**: `PARACHUTE_GITHUB_CLIENT_ID` +
  `PARACHUTE_GITHUB_APP_SLUG` must be set both-or-neither and name the SAME GitHub App —
  mixing apps breaks the install probe (the client_id mints the tokens, the slug builds
  the install link).

## Deployment

Self-hosted is this repo's product: Mac launchd, VPS via `docker compose`, Cloudflare
Tunnel for HTTPS. The hosted door ships today from [`parachute-cloud`](../parachute-cloud)
(Cloudflare Workers / D1 / R2) — not from this repo.
