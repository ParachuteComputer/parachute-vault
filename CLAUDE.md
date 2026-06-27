# Parachute Vault

Agent-native knowledge graph. Notes, tags, links over MCP. Self-hosted, one command setup.

## Architecture

```
parachute-vault init     →  ~/.parachute/vault/ (config, .env, daemon, MCP)
parachute-vault create   →  new vault (SQLite DB + vault.yaml; mints a hub JWT when a hub is reachable, else emits guidance — vault#282 Stage 2)
parachute-vault config   →  manage env vars (PORT, etc.)
parachute-vault tokens   →  list / revoke vestigial pre-0.5.0 rows (minting is hub's job now)

CLI  →  Bun server (port 1940)  →  multiple vaults (each its own SQLite DB)
                                         ↑
Any AI  →  MCP (stdio or HTTP)  ─────────┘
Phone   →  REST API  ──────────────────┘
```

## Packages

```
core/    — TypeScript library: schema, store, MCP tools, wikilinks, paths (bun:sqlite)
src/     — Bun CLI + server + MCP + webhook triggers
deploy/  — systemd unit, Dockerfile, docker-compose, fly.toml, railway.json
```

## Data Model

Five core tables per vault. Vaults start blank — no predefined tags or schema. Clients create the tags they need.

```sql
notes       (id, content, path, metadata, created_at, updated_at)
tags        (name)
note_tags   (note_id, tag_name)
attachments (id, note_id, path, mime_type, metadata, created_at)
links       (source_id, target_id, relationship, metadata, created_at)
```

Additional tables:
- `tags` — first-class identity row carrying description, fields (the schema-validation surface), relationships, parent_names
- `unresolved_wikilinks` — pending wikilink resolution
- `schema_version` — migration tracking

Metadata is a JSON column on notes, links, and attachments. Queryable via `json_extract()`.

Path is unique (when set), normalized (no .md, no trailing slashes), and used for wikilink resolution.

### MCP Tools (9)

Notes: `query-notes` (single by ID/path, filter, search, graph neighborhood), `create-note` (single or batch), `update-note` (single or batch — content, tags, links, metadata merge), `delete-note`

Tags: `list-tags` (with optional schema detail), `update-tag` (upsert schema), `delete-tag`

Graph: `find-path` (BFS shortest path)

Vault: `vault-info` (get/update description + stats)


## Bun-native

Use Bun for everything. No Node.js.

- `Bun.serve()` for HTTP server
- `bun:sqlite` for SQLite
- `Bun.$` for shell commands
- `bun test` for tests

## Key design decisions

- **Bare primitives**: Vault has no opinions about tags or conventions. It's the engine, not the schema. Clients (parachute-daily, etc.) bring their own tag schema.
- **Multi-vault**: One server hosts many vaults. Each vault = own SQLite DB + config + API keys.
- **Per-vault MCP descriptions**: vault.yaml is sent as MCP server instruction at session start. The vault teaches the AI how to use it.
- **Wikilink auto-linking**: `[[wikilinks]]` in note content are automatically parsed and maintained as links. Unresolved links auto-resolve when target notes are created.
- **Path normalization**: Paths are normalized on write (strip .md, collapse slashes, trim). UNIQUE constraint enforced. Rename cascading updates wikilinks in other notes.
- **Obsidian interop**: Import/export preserves frontmatter, tags, wikilinks, and file paths.
- **Unified config**: All env vars in `~/.parachute/vault/.env` (or `$PARACHUTE_HOME/vault/.env` in Docker).
- **Docker-friendly**: `PARACHUTE_HOME` env var overrides the ecosystem root; vault state lands at `$PARACHUTE_HOME/vault/`. Server auto-creates default vault on first run.
- **Autostart opt-out**: `parachute-vault init` registers a launchd / systemd daemon by default (boot start + crash restart) — **but only when no hub supervisor is detected**. Under hub-as-supervisor the hub owns vault's lifecycle, so a self-registered launchd/systemd unit (`KeepAlive`/`RunAtLoad`) would race the supervisor's child for :1940 ([parachute-hub#580](https://github.com/ParachuteComputer/parachute-hub/issues/580)). When init detects a hub (via `detectHubPresence` — configured non-loopback origin or a live `:1939/health`), it defaults autostart **off** and prints "Hub supervisor detected — not registering a separate daemon." Pass `--autostart` to force registration anyway (logged with a race warning); pass `--no-autostart` to skip — init writes `autostart: false` to `config.yaml` and removes any prior registration. An explicit flag persists in `config.yaml`; the hub-present default is a per-run inference (not persisted), so a later standalone re-run falls back to register. **Upgrade path**: a box that already has a persisted `autostart: true` (from an earlier explicit `--autostart`) keeps registering a daemon even under a hub — run `parachute-vault init --no-autostart` once to clear the persisted value and hand the lifecycle to the hub. The user runs `parachute-vault serve` manually or wires their own supervisor. Use the off path for CI, dev sandboxes, Docker, or wherever another process manager owns the lifecycle.

## Config

All configuration in `~/.parachute/vault/.env`:

```
PORT=1940

# Bring-your-own GitHub App for the mirror "Back up to GitHub" flow
# (optional — defaults to the shared Parachute app). Set BOTH or NEITHER:
# the pair must name the SAME GitHub App; mixing apps breaks the
# install probe (the client_id mints the tokens, the slug builds the
# install link).
PARACHUTE_GITHUB_CLIENT_ID=Iv1.yourappclientid
PARACHUTE_GITHUB_APP_SLUG=your-app-slug
```

## Naming

- Domain: `parachute.computer`
- Package ID: `computer.parachute.vault`
- npm scope: `@openparachute/`
- Launchd label: `computer.parachute.vault`

## Running

```bash
bun src/cli.ts vault init          # setup everything
bun src/cli.ts vault status        # check status
bun src/cli.ts vault config        # view/edit config
bun src/cli.ts vault stop          # graceful shutdown via filesystem sentinel
bun src/cli.ts vault import <path> # import Obsidian vault (legacy lossy)
bun src/cli.ts vault export <dir>  # export as portable markdown (vault#308 — lossless across IDs, typed links, schemas)
bun src/cli.ts vault export <dir> --since <iso>  # incremental — only notes updated_at >= iso
bun test ./src/                    # run server tests (anchored — also excluded from bare `bun test`)
bun test ./core/src/               # run core tests
bun test                           # run server + core (web/ui excluded via bunfig.toml pathIgnorePatterns)
cd web/ui && bunx vitest run       # run the React SPA's tests (different runner — vi.mock + jsdom)
```

The repo holds two test suites with different runners. Server + core run under `bun:test` (Bun-native, `bun:sqlite`-aware). The React admin SPA at `web/ui/` runs under **vitest 4.x** because its tests use `vi.mock("path")` single-arg auto-stubbing, jsdom, and `@testing-library/react` — none of which `bun:test` supports today. `bunfig.toml` excludes `web/ui/**` from `bun test` discovery so the bare `bun test` stays green; the SPA's canonical test command is `vitest run` (its `npm test` script). See vault#294.

#### Subprocess tests + `Bun.serve`: never `Bun.spawnSync` (vault#325)

A test that keeps an in-process `Bun.serve` listening **for the child subprocess to probe over HTTP** must spawn the child with async `Bun.spawn` + `await proc.exited`, **never** `Bun.spawnSync`. `spawnSync` blocks the parent's event loop until the child exits, so the in-test server can't answer the child's request — it silently times out into the "nothing listening" branch and the assertion tests the wrong path (the guard never fires, or fails for non-obvious reasons). This bit the daemon-busy import guard; fixed in vault#324. Use the shared `runSubprocess` helper in `src/test-support/spawn.ts` for any CLI integration test. `Bun.spawnSync` is **fine** where no in-test server is involved (shelling out to `git` to build fixtures in `mirror-*.test.ts` / `vault-create.test.ts`) or where a `Bun.serve` only *holds a port* for an `lsof`/availability probe rather than answering an HTTP call from the child (`doctor.test.ts`). See `src/test-support/spawn.ts` for the full rule.

### Graceful shutdown

`parachute-vault stop` writes a sentinel file at `~/.parachute/vault/stop.signal`. The running server polls for it every 500ms and, when it finds one, deletes it and runs the same drain-and-exit shutdown path used for SIGINT/SIGTERM. Stale sentinels are removed at server startup, so a `stop` written while no server was listening can't pre-empt the next boot. This exists for environments where signals are awkward (Docker exec, foreground runs without a managed PID) — when you have a PID, `kill -TERM` still works and is the more direct path.

### `uninstall --skip-daemon` (test-only)

`parachute-vault uninstall` calls `uninstallAgent()` which targets the hardcoded launchd label `computer.parachute.vault`. That label ignores `PARACHUTE_HOME`, so a naive test that spawns `parachute-vault uninstall --yes` on a developer's machine would `launchctl bootout` the real registered daemon. The undocumented `--skip-daemon` flag bypasses the launchd / systemd / backup-agent uninstall calls — tests use it to exercise the rest of the flow (wrapper removal, MCP cleanup, exit codes, ordering) without touching real operator state. Humans should never need it; it's intentionally absent from `usage()` so it doesn't invite "I'll just skip the daemon step" misuse that orphans a daemon firing on a missing wrapper. See vault#296.

### Portable markdown export + import (vault#308)

`core/src/portable-md.ts` is the canonical home for the markdown knowledge-base format. Vault's `parachute-vault export <dir>` writes:

```
<dir>/
  .parachute/
    vault.yaml                # vault meta + export_format_version
    schemas/<tag>.yaml        # per-tag: description, fields, relationships, parent_names
    attachments/<id>/<file>   # attachment binaries (when assetsDir is wired — CLI does)
  <note.path>.md              # one file per note
```

Per-note frontmatter uses a fixed top-level key order (`id` → `path` → `tags` → `metadata` → `links` → `attachments` → `created_at` → `updated_at`) with alpha-sorted keys in nested objects, so re-exporting an unchanged vault produces byte-identical output (clean git diffs). The frontmatter `attachments[].path` value is the **original vault-internal path** (relative to `assetsDir`); the sidecar location is derived from `id` so it stays stable across renames + different export runs.

`parachute-vault import <dir>` is the lossless round-trip path. Autodetects the format via `.parachute/vault.yaml`'s presence: if there, runs `importPortableVault` (upsert-by-id; preserves IDs, restores tag schemas, replays typed links, restores attachment binaries when `assetsDir` is wired); if absent, falls back to the legacy obsidian parser. `--blow-away` is the disaster-recovery path — wipes the target vault before replaying, confirms unless `--yes` is set.

Round-trip invariant pinned by `portable-md.test.ts`: realistic vault → export → blow-away import → re-export → byte-equivalent. Path-traversal guards on every file write (source under assetsDir, dest under outDir's sidecar root); skips with `console.warn` rather than aborting.

`core/src/obsidian.ts` is a deprecated back-compat shim — re-exports the parser helpers and keeps the legacy lossy `toObsidianMarkdown` / `exportFilePath` for callers that intentionally want the flat-frontmatter shape. New code imports from `portable-md.ts` directly. See vault#308 (PR 1 = export + schemas + idempotency; PR 2 = attachments + import + round-trip).

## Deployment

Self-hosted:
- **Mac**: `bun install && vault init` (launchd daemon, localhost)
- **VPS**: `docker compose up -d` (Hetzner, DigitalOcean, etc.)
- **Remote access**: Cloudflare Tunnel for HTTPS (`cloudflared tunnel --url http://localhost:1940`)

Hosted (future, issue #5):
- Cloudflare Workers + D1 + R2
- Requires async Store interface refactor

## Post-merge hygiene

When a PR is merged, locally:

```
git checkout main && git pull
```

Aaron runs vault via `bun link` in development — the linked install follows whatever branch is checked out. Leaving the repo on a feature branch after merge means Aaron's `parachute start vault` is running stale feature-branch code, not the merged main. Caught 2026-04-21 when several stewards (including vault) left their local repo on a feature branch after merge.
