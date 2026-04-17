# Changelog

All notable changes to Parachute Vault are documented here.

This project loosely follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [0.2.0] — 2026-04-17

First tagged public release. Ships the auth, backup, and onboarding surface the project needs for first-wave users.

### Authentication

- **OAuth 2.1 + PKCE** with Dynamic Client Registration (RFC 7591). Claude Desktop, Parachute Daily, and any OAuth-capable MCP client can connect with no manual token paste — user clicks "Add integration", browser opens to the vault's consent page, done.
- **Owner password** (bcrypt-hashed, min 12 characters) for the OAuth consent page. Prompt fires at `vault init`; manage later with `parachute vault set-password` / `--clear`.
- **TOTP 2FA with single-use backup codes**. `parachute vault 2fa enroll` prints a QR and one-time backup codes; `status` / `disable` / `backup-codes` subcommands for lifecycle.
- **Per-vault OAuth scope** — discovery at `/vaults/{name}/.well-known/oauth-authorization-server` returns vault-scoped endpoints. Tokens minted there authenticate only against that vault.
- **Cross-vault substitution blocked**: an OAuth code issued for one vault cannot be redeemed at another vault's token endpoint (schema-enforced via a `vault_name` column on `oauth_codes`).
- **Honest token response**: `/oauth/token` returns `{ access_token, token_type, scope, vault }` so the client knows which vault it just connected to.
- **Two permission tiers**: `full` (CRUD + delete + token management) and `read` (query / list / find-path / vault-info). Tokens default to `full`; pass `--read` to `tokens create` for read-only.
- **Token CLI**: `parachute vault tokens` (list), `tokens create [--vault] [--read] [--expires <N{h|d|w|m|y}>] [--label]`, `tokens revoke <id> [--vault]`. Tokens are SHA-256 hashed at rest.
- **Query-param auth for `/view`**: `?key=pvt_...` works alongside `Authorization: Bearer` and `X-API-Key` headers, convenient for browsers.

### Backup

- **`parachute vault backup`** — one-shot snapshot: atomic `VACUUM INTO` of every vault's `vault.db`, plus `config.yaml` and each vault's `vault.yaml`, bundled as a timestamped `.tar.gz`. Safe under concurrent reads/writes.
- **Scheduled runs** via `parachute vault backup --schedule hourly|daily|weekly|manual` (macOS launchd). Linux systemd-timer support is a follow-up; wire cron yourself for now.
- **`backup status`** shows schedule, last run, destinations, next run, and per-destination tier breakdown.
- **Tiered (grandfather-father-son) retention**. Default: `daily: 7 / weekly: 4 / monthly: 12 / yearly: null` (unbounded). Set any tier to `0` to disable. Local-timezone bucketing.
- **Pluggable destinations**. `local` (any filesystem path — iCloud Drive, external disk, rsync/Syncthing folder) ships in 0.2.0. `s3`, `rsync`, and `cloud` destinations designed but not yet implemented.
- **`vault uninstall` tears down the backup agent too** on macOS, so scheduled backups don't keep firing on a removed install.

### Reliability

- **`parachute vault doctor`** — diagnostic suite covering server-path pointer, wrapper script, launchd agent (macOS) / systemd service (Linux), bun-on-PATH, MCP entry in `~/.claude.json` (presence + URL port match + reachability), port-collision (free / ours / foreign via `lsof` or `ss`), and — when scheduled backups are configured — backup agent + per-destination writability. Exits 1 on any `fail`.
- **`vault status`** is healthcheck-aware and reports live daemon state, not just service registration.
- **`vault restart`** blocks until `/health` returns 200, with a sensible budget and progress indicator.
- **Path-resilient `start.sh`** — the wrapper launchd/systemd executes embeds an absolute `bun` path + points at `~/.parachute/server-path`, which resolves to the current repo location. Move the repo, re-run `vault init`, and the daemon follows you.
- **Idempotent `vault init`** — safe to re-run after a folder move or config edit; refreshes the pointer, wrapper, and service registration without touching user data.
- **Graceful shutdown**: in-flight webhook triggers get a 5 s drain window before the daemon exits on SIGTERM/SIGINT.

### Multi-vault

- **Public `GET /vaults/list`** — unauthenticated discovery endpoint returning only vault names (no descriptions, timestamps, counts, or keys). Lets a client populate a vault picker before OAuth. Operators who want to hide vault existence can set `discovery: disabled` in `~/.parachute/config.yaml` to make the endpoint return 404.
- **Single-vault auto-default** — when the server has exactly one vault, the unscoped `/mcp`, `/api/*`, and `/oauth/*` paths transparently resolve to it regardless of its name. A lone vault named `journal` works at `/mcp` with no vault-in-URL needed.
- **Vault-management CLI**: `parachute vault create <name>`, `list` (alias `ls`), `remove <name> --yes` (alias `rm`).
- **Automatic `default_vault` management** — `vault create` promotes a new vault to default when none is set or the configured default points at a missing vault. `vault remove` promotes the sole survivor when you delete the default and one vault remains.

### Install / uninstall

- **`vault uninstall`** — removes the daemon registration, the `start.sh` wrapper, the `~/.parachute/server-path` pointer, and the `parachute-vault` entry in `~/.claude.json`. On macOS, tears down both the main vault agent and the backup agent. Preserves all user data.
- **`vault uninstall --wipe`** — additionally removes `vaults/`, `.env`, `config.yaml`, `vault.log`, and `vault.err` after a second interactive confirm (default NO).
- **`vault uninstall --yes --wipe`** — scripted destructive path. Skips both confirms and prints an ISO-timestamped audit line to stdout naming the target paths.
- **`vault url`** prints the local server URL in a script-friendly form.

### API / primitives

- **Optimistic concurrency on `update-note`** via an `if_updated_at` parameter. When supplied and it doesn't match the note's current `updated_at`, the update is rejected (MCP: `ConflictError`; HTTP: 409). Batch updates fail fast on the first conflict.
- **Link expansion on `query-notes`** — new `expand_links` / `expand_depth` (0–3) / `expand_mode` (`"full"` | `"summary"`) parameters inline `[[wikilink]]` targets directly into the returned content. Works on the MCP tool and the HTTP routes (single-note, search, and structured-list).
- **9 composable MCP tools** (was 30): `query-notes`, `create-note`, `update-note`, `delete-note`, `list-tags`, `update-tag`, `delete-tag`, `find-path`, `vault-info`. Every note parameter accepts either an ID or a path.
- **Webhook triggers** — declarative config-driven webhooks fire on note mutations matching tag / metadata predicates. Three send modes: `json` (general), `attachment` (Whisper-compatible transcription), `content` (OpenAI-compatible TTS).

### Documentation

- Entirely overhauled onboarding path: OAuth walkthrough, doctor + troubleshooting, first-run narrative (what `vault init` does on disk), multi-vault subsection, Tailscale Funnel walkthrough, prerequisites block.
- Honest token-shape documentation (`pvt_` is modern; `pvk_` is legacy and still accepted).
- README tells the truth about what `vault init` writes to `~/.claude.json` — a vault-scoped URL with a baked-in `pvt_` bearer, not OAuth.

### Removed

- **Semantic / vector search** — the embeddings path (`sqlite-vec`, `semantic-search` tool, embedding-provider setup wizard, `/api/ingest` endpoint). Full-text search via `query-notes` `search=` remains.
- **`parachute vault keys` subcommand** — superseded by `parachute vault tokens`. Legacy `pvk_...` keys in `config.yaml` are still honored at runtime.

### For contributors

- **Async `Store` interface**, renamed to `BunSqliteStore`. Paves the way for Durable Object SQLite and R2 blob backends (in flight).
- **`src/routing.ts`** extracted from `src/server.ts` so the request dispatcher is unit-testable without spinning up `Bun.serve()`.
- **`core/src/test-preload.ts`** isolates `PARACHUTE_HOME` for tests so `bun test` never touches a user's real `~/.parachute/`.
- Test suite at release cut: **538 passing / 0 failing / 3 skipped** across 22 files (541 tests total).

[0.2.0]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.0
