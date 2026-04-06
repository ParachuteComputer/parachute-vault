# Parachute Vault

Agent-native knowledge graph. Notes, tags, links over MCP. Self-hosted, one command setup.

## Architecture

```
parachute vault init     →  ~/.parachute/ (config, .env, daemon, MCP)
parachute vault create   →  new vault (SQLite DB + vault.yaml + API key)
parachute vault config   →  manage env vars (API keys, providers)

CLI  →  Bun server (port 1940)  →  multiple vaults (each its own SQLite DB)
                                         ↑
Any AI  →  MCP (stdio or HTTP)  ─────────┘
Phone   →  REST API + transcription  ────┘
```

## Packages

```
core/    — TypeScript library: schema, store, MCP tools, wikilinks, embeddings, paths (bun:sqlite)
src/     — Bun CLI + server + MCP + transcription + embedding providers
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

Additional tables (created on demand):
- `unresolved_wikilinks` — pending wikilink resolution
- `vec_notes` — sqlite-vec virtual table for embeddings
- `embedding_meta` — tracks which notes are embedded
- `embedding_config` — stores embedding dimensions
- `schema_version` — migration tracking

Metadata is a JSON column on notes, links, and attachments. Queryable via `json_extract()`.

Path is unique (when set), normalized (no .md, no trailing slashes), and used for wikilink resolution.

### MCP Tools (20+)

Core: `get-note`, `create-note`, `update-note`, `delete-note`, `read-notes`, `search-notes`, `tag-note`, `untag-note`, `create-link`, `delete-link`, `get-links`, `list-tags`

Bulk: `create-notes`, `batch-tag`, `batch-untag`

Graph: `traverse-links`, `find-path`

Vault: `list-vaults`, `get-vault-description`, `update-vault-description`

Semantic (conditional): `semantic-search`, `embed-notes`

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
- **Semantic search**: Optional sqlite-vec integration. Embedding providers are configurable (OpenAI, Ollama). Tag/date filters pushed into SQL for efficient filtered search.
- **Obsidian interop**: Import/export preserves frontmatter, tags, wikilinks, and file paths.
- **Unified config**: All env vars in `~/.parachute/.env` (or `$PARACHUTE_HOME/.env` in Docker).
- **Optional transcription**: parachute-scribe is an optional dependency. If installed, vault exposes Whisper-compatible endpoints.
- **Docker-friendly**: `PARACHUTE_HOME` env var overrides data directory. Server auto-creates default vault on first run.

## Config

All configuration in `~/.parachute/.env`:

```
PORT=1940
TRANSCRIBE_PROVIDER=groq        # or parakeet-mlx, openai
CLEANUP_PROVIDER=claude          # or ollama, none
EMBEDDING_PROVIDER=openai        # or ollama, none
EMBEDDING_MODEL=text-embedding-3-small
GROQ_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

## Naming

- Domain: `parachute.computer`
- Package ID: `computer.parachute.vault`
- npm scope: `@parachute/`
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
