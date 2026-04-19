# Changelog

All notable changes to Parachute Vault are documented here.

This project loosely follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed

- **Fresh notes now have `updated_at = created_at` instead of `NULL`.** Clients that fall back to `createdAt` when computing an optimistic-concurrency token (the common `updatedAt ?? createdAt` pattern, used by the Lens editor) were being rejected with a `409 CONFLICT` on the very first edit of a just-created note, because the stored `updated_at IS NULL` never matched the sent timestamp. The insert path now writes both columns at once; a one-time idempotent migration backfills `updated_at = created_at` for any existing rows with `NULL`. Rows that already had a real `updated_at` are untouched. Hook-style writes with `skipUpdatedAt` continue to preserve the column, so `updated_at > created_at` still means "user-touched since creation."

### Changed

- **CLI renamed: `parachute` → `parachute-vault`.** The published `@openparachute/vault` package now exposes its binary as `parachute-vault`, freeing the `parachute` name for the forthcoming `@openparachute/cli` dispatcher that will front this service alongside sibling Parachute Computer services. Direct invocations become `parachute-vault init`, `parachute-vault status`, etc. Users installing the upcoming dispatcher can keep typing `parachute vault <cmd>` — the dispatcher forwards to `parachute-vault <cmd>` transparently. The CLI's own arg-parser still accepts a leading `vault` prefix (`parachute-vault vault init` works), so existing launchd / systemd wrappers that hardcode the full form continue to work across the upgrade.

### Added

- **`update-tag` field specs gain `indexed: boolean`; declared-indexed fields get a generated column + B-tree index on `notes`.** When any tag schema declares a field with `indexed: true`, vault adds a VIRTUAL generated column `meta_<field>` computed from `json_extract(notes.metadata, '$."<field>"')` and indexes it. The tag authorizes the index; the index is universal across all notes, not partitioned by tag — so once `#project` declares `status: indexed`, any note with `status` in its metadata is indexed regardless of tags. `type` and `indexed` are global — all declarers must agree; mismatches at `update-tag` throw a loud error naming the conflicting tag. `description` and `enum` remain per-tag. A new `indexed_fields` table (`field`, `sqlite_type`, `declarer_tags` JSON) is the single source of truth; the column + index drop when the last declarer releases the flag or is removed via `delete-tag`. Type map: `string`→TEXT, `integer`/`boolean`→INTEGER. Field names are restricted to `[A-Za-z_][A-Za-z0-9_]{0,62}` for SQL-identifier safety. Indexes are rebuilt idempotently from `indexed_fields` on every vault init. The query surface — operator objects on `metadata` and `order_by` — lands separately; this release just puts the indexes in place.
- **`parachute-vault init` registers the service in `~/.parachute/services.json`.** An `upsertService` call writes `{name: "parachute-vault", port, paths: ["/"], health: "/health", version}` into the shared manifest that the `@openparachute/cli` dispatcher consumes for discovery, health probes, and routing. The write is upsert-by-name and preserves entries from other services (notes, scribe, channel) that share the file. Malformed-manifest errors are logged and init proceeds — the manifest is advisory, not a blocker.
- **Atomic tag rename + merge endpoints.** `POST /api/tags/{name}/rename` with `{new_name}` rewrites the tag across `tags`, `note_tags`, and the schema row in a single transaction; `POST /api/tags/merge` with `{sources, target}` retags every note carrying any source tag onto the target (creating it if missing), preserves the target's schema, and drops the sources. Rename returns `409 {error: "target_exists"}` when `new_name` is already a tag, pointing clients at the merge endpoint instead of the previous N+1 client-side PATCH stopgap.
- **Server-side transcription on attachment upload.** `POST /api/notes/{id}/attachments` now accepts `{transcribe: true}`. The attachment is stamped with `transcribe_status: "pending"` and the note with `transcribe_stub: true`. A background worker (enabled by setting `SCRIBE_URL` / optional `SCRIBE_TOKEN` in the server environment) drains the queue FIFO, POSTs the audio to `${SCRIBE_URL}/v1/audio/transcriptions`, and on success replaces the `_Transcript pending._` placeholder (or the whole body, if absent) with the transcript. If the user cleared the stub marker before the transcript arrived, the note is left alone — but the transcript is still recorded on the attachment. Retries use exponential backoff up to three attempts before flipping to `transcribe_status: "failed"`. The queue is the `attachments` table, so a restart resumes pending work. Per-vault `audio_retention: "until_transcribed"` (in `vault.yaml`) unlinks the audio file after success while keeping the attachment row (and transcript) addressable; `"keep"` (default) preserves the file.
- **Audio retention API: `GET` + `PATCH /api/vault` expose `config.audio_retention`.** The previously file-only setting is now mutable at runtime without hand-editing `vault.yaml`. `GET` reports the active mode (defaulting to `"keep"` for vaults created before the setting existed); `PATCH {config: {audio_retention: ...}}` sets it and validates against the allowed set `"keep"` / `"until_transcribed"` / `"never"`. The new `"never"` mode unlinks audio on *any* terminal state — including failure — for users who want to guarantee no audio persists after processing, trading off the ability to retry a failed transcription. The file is still kept during mid-queue retries so in-flight attempts have something to send. Invalid modes return `400 {error: "invalid_audio_retention"}`.

## [0.2.4] — 2026-04-18

### Added

- `link_count` surfaced in the vault stats response (REST + MCP `vault-info`), matching the existing note and tag counts.

## [0.2.3] — 2026-04-17

### Fixed

- **OAuth discovery endpoints now served at RFC-compliant path-insertion URLs (`/.well-known/oauth-authorization-server/{path}`) in addition to the existing path-append form.** Restores Claude Code's MCP OAuth SDK compatibility, which follows RFC 8414 §3.1 and RFC 9728 §3 strictly and probes only the path-insertion shape. Before 0.2.3, the SDK's AS-metadata fetch 404'd, leaving it without a `registration_endpoint` and cascading into a 404 on the `/register` fallback. Both scoped forms now work: `/.well-known/oauth-authorization-server/vaults/<name>` and the longer `/.well-known/oauth-authorization-server/vaults/<name>/mcp`; same shapes on `/.well-known/oauth-protected-resource/...`. Path-append routes (`/vaults/<name>/.well-known/<type>`) are unchanged so lax clients keep working.

## [0.2.2] — 2026-04-17

### Fixed

- **`start.sh` daemon wrapper no longer crashes on user shell profiles that reference unbound variables.** The generated wrapper ran `source ~/.zprofile` and `source ~/.zshrc` under `set -u`, so a zsh plugin framework or any conditional profile setup that touched an unset variable would abort the wrapper with exit 1. The `2>/dev/null` redirect swallowed the error, launchd saw repeated exit 1s, and the daemon silently refused to start with an empty `vault.err`. The wrapper now brackets the profile-source lines with `set +u` / `set -u` so -u is only active for code the wrapper owns. Run `parachute vault init` once on 0.2.2 to rewrite `~/.parachute/start.sh` — the rewrite is idempotent.

### Added

- **`parachute --version` / `parachute -v` / `parachute version`** print the installed package version to stdout. Works at the root and with the `vault` prefix (`parachute vault --version`, etc.). Reads from the installed `package.json` at module load, not a hardcoded string.

## [0.2.1] — 2026-04-17

### Fixed

- OAuth discovery now works against Claude Code's MCP SDK (and any other strict RFC 9728 client): 401 responses from the MCP endpoint carry a `WWW-Authenticate: Bearer resource_metadata="…"` header pointing at the scoped or unscoped protected-resource metadata document, matching the URL the client actually hit. Previously, clients with no pointer fell back to probing the root `/.well-known/oauth-protected-resource`, got `resource: <base>/mcp`, and rejected any connection to `/vaults/<name>/mcp` as a resource mismatch.

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

[0.2.3]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.3
[0.2.2]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.2
[0.2.1]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.1
[0.2.0]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.0
