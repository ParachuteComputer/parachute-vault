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
core/    — TypeScript library: schema, store, MCP tools (bun:sqlite)
src/     — Bun CLI + server + MCP + transcription
```

## Data Model

Five tables per vault. Vaults start blank — no predefined tags or schema. Clients create the tags they need.

```sql
notes       (id, content, path, metadata, created_at, updated_at)
tags        (name)
note_tags   (note_id, tag_name)
attachments (id, note_id, path, mime_type, created_at)
links       (source_id, target_id, relationship, metadata, created_at)
```

Metadata is a JSON column on notes and links. Queryable via `json_extract()`.

### MCP Tools (18)

Core: `get-note`, `create-note`, `update-note`, `delete-note`, `read-notes`, `search-notes`, `tag-note`, `untag-note`, `create-link`, `delete-link`, `get-links`, `list-tags`

Bulk: `create-notes`, `batch-tag`, `batch-untag`

Graph: `traverse-links`, `find-path`

Multi-vault: `list-vaults`

## Bun-native

Use Bun for everything. No Node.js.

- `Bun.serve()` for HTTP server
- `bun:sqlite` for SQLite
- `Bun.$` for shell commands
- `bun test` for tests

## Key design decisions

- **Bare primitives**: Vault has no opinions about tags or conventions. It's the engine, not the schema. Clients (parachute-daily, etc.) bring their own tag schema.
- **Multi-vault**: One server hosts many vaults. Each vault = own SQLite DB + config + API keys.
- **Per-vault MCP descriptions**: vault.yaml enriches MCP tool descriptions. The vault teaches the AI how to use it.
- **Unified config**: All env vars in `~/.parachute/.env`. Managed via `vault config set/unset`. Launchd daemon sources it via wrapper script.
- **Optional transcription**: parachute-scribe is an optional dependency. If installed, vault exposes Whisper-compatible endpoints. If not, vault works fine without it.

## Config

All configuration in `~/.parachute/.env`:

```
PORT=1940
TRANSCRIBE_PROVIDER=groq        # or parakeet-mlx, openai
CLEANUP_PROVIDER=claude          # or ollama, none
GROQ_API_KEY=...
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
bun test src/                      # run tests
bun test core/src/core.test.ts     # run core tests
```
