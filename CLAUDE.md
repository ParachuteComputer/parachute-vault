# Parachute Vault

Agent-native knowledge graph. Notes, tags, links over MCP. Self-hosted, one command setup.

## Architecture

```
parachute-vault init     →  ~/.parachute/vault/ (config, .env, daemon, MCP)
parachute-vault create   →  new vault (SQLite DB + vault.yaml + pvt_ token)
parachute-vault config   →  manage env vars (PORT, etc.)
parachute-vault tokens   →  list / create / revoke per-vault tokens

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
- `tag_schemas` — tag description + metadata field definitions (JSON)
- `unresolved_wikilinks` — pending wikilink resolution
- `schema_version` — migration tracking

Metadata is a JSON column on notes, links, and attachments. Queryable via `json_extract()`.

Path is unique (when set), normalized (no .md, no trailing slashes), and used for wikilink resolution.

### MCP Tools (10)

Notes: `query-notes` (single by ID/path, filter, search, graph neighborhood), `create-note` (single or batch), `update-note` (single or batch — content, tags, links, metadata merge), `delete-note`

Tags: `list-tags` (with optional schema detail), `update-tag` (upsert schema), `delete-tag`

Graph: `find-path` (BFS shortest path), `synthesize-notes` (anchor + neighbors + search → ranked neighborhood, connections, tag distribution, timeline; agent writes the narrative)

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
- **Autostart opt-out**: `parachute-vault init` registers a launchd / systemd daemon by default (boot start + crash restart). Pass `--no-autostart` to skip — init writes `autostart: false` to `config.yaml` and removes any prior registration. The user runs `parachute-vault serve` manually or wires their own supervisor. Use this for CI, dev sandboxes, Docker, or wherever another process manager owns the lifecycle.

## Config

All configuration in `~/.parachute/vault/.env`:

```
PORT=1940
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
bun src/cli.ts vault import <path> # import Obsidian vault
bun src/cli.ts vault export <path> # export as Obsidian markdown
bun test src/                      # run server tests
bun test core/src/                 # run core tests
```

### Graceful shutdown

`parachute-vault stop` writes a sentinel file at `~/.parachute/vault/stop.signal`. The running server polls for it every 500ms and, when it finds one, deletes it and runs the same drain-and-exit shutdown path used for SIGINT/SIGTERM. Stale sentinels are removed at server startup, so a `stop` written while no server was listening can't pre-empt the next boot. This exists for environments where signals are awkward (Docker exec, foreground runs without a managed PID) — when you have a PID, `kill -TERM` still works and is the more direct path.

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
