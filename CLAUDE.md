# Parachute Vault

Agent-native knowledge graph. Notes, tags, links over MCP. Self-hosted, one command setup.

## Architecture

```
parachute vault init     →  ~/.parachute/ (config, .env, daemon, MCP)
parachute vault create   →  new vault (SQLite DB + vault.yaml + API key)
parachute vault config   →  manage env vars (PORT, etc.)
parachute vault keys     →  list / create / revoke API keys

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
- **Unified config**: All env vars in `~/.parachute/.env` (or `$PARACHUTE_HOME/.env` in Docker).
- **Docker-friendly**: `PARACHUTE_HOME` env var overrides data directory. Server auto-creates default vault on first run.

## Config

All configuration in `~/.parachute/.env`:

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
bun src/cli.ts vault import <path> # import Obsidian vault
bun src/cli.ts vault export <path> # export as Obsidian markdown
bun test src/                      # run server tests
bun test core/src/                 # run core tests
```

## Deployment

Self-hosted:
- **Mac**: `bun install && vault init` (launchd daemon, localhost)
- **VPS**: `docker compose up -d` (Hetzner, DigitalOcean, etc.)
- **Remote access**: Cloudflare Tunnel for HTTPS (`cloudflared tunnel --url http://localhost:1940`)

Hosted (future, issue #5):
- Cloudflare Workers + D1 + R2
- Requires async Store interface refactor
