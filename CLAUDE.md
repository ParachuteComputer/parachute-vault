# Parachute Vault

Agent-native knowledge graph. Notes, tags, links over MCP. Any AI gets a personal knowledge vault in seconds.

## What this is

Parachute Vault is the tool all AI agents need — a dead simple knowledge graph (notes, tags, links) exposed over MCP. One command to spin up a vault, hand any AI an MCP endpoint and API token, and it has a structured knowledge base.

## Architecture

```
parachute vault init          →  ~/.parachute/ config + daemon
parachute vault create work   →  new vault (SQLite DB + config + API key)
parachute vault mcp-install   →  writes MCP config into ~/.claude.json

CLI  →  Bun server (single process)  →  multiple vaults (each its own SQLite DB)
                                              ↑
Any AI  →  MCP (stdio or HTTP)  ──────────────┘
```

## Packages

```
core/    — TypeScript library: schema, store, MCP tools (from parachute-daily)
local/   — Reference: old Hono server (being rewritten as Bun multi-vault server)
src/     — New Bun CLI + server + MCP (the main code)
```

## Data Model

Five tables per vault:

```sql
notes       (id, content, path, created_at, updated_at)
tags        (name)
note_tags   (note_id, tag_name)
attachments (id, note_id, path, mime_type, created_at)
links       (source_id, target_id, relationship, created_at)
```

### Built-in Tags

```
#daily      — user-captured content (voice memos, typed notes)
#doc        — persistent documents (blog drafts, meeting notes, lists)
#digest     — AI/system-created content for the user to consume
#pinned     — kept prominent
#archived   — done with this
#voice      — transcribed from voice
```

### MCP Tools (11)

`create-note`, `update-note`, `delete-note`, `read-notes`, `search-notes`, `tag-note`, `untag-note`, `create-link`, `delete-link`, `get-links`, `list-tags`

## Bun-native

Use Bun for everything. No Node.js build step.

- `Bun.serve()` for HTTP server (not express, not hono)
- `bun:sqlite` for SQLite (not better-sqlite3)
- `Bun.file` over `node:fs` readFile/writeFile
- `Bun.$` for shell commands (not execa)
- `bun test` for tests
- `bun install` for deps
- Bun auto-loads .env, no dotenv needed

## Key design decisions

- **Multi-vault**: One server process hosts many vaults. Each vault = own SQLite DB + config + API keys.
- **Per-vault MCP descriptions**: Each vault has a config (vault.yaml) that enriches MCP tool descriptions when an AI connects. The vault teaches the AI how to use it.
- **CLI pattern**: Follow PCC (`~/.claude.json` auto-config) and tailshare (launchd daemon, `Bun.serve()`) patterns. See `/Users/parachute/Code/pcc/` and `/Users/parachute/Code/parachute-serve/` for reference.

## Naming

- Domain: `parachute.computer`
- Package ID: `computer.parachute.vault`
- npm scope: `@parachute/`
- Subdomain: `vault.parachute.computer`

## Running

```bash
bun run src/cli.ts vault init
bun run src/cli.ts vault create <name>
bun run src/cli.ts vault list

# Tests (from core/)
cd core && npm test
```

## Reference repos

- `/Users/parachute/Code/pcc/` — PCC/meshwork: Bun CLI, auto MCP config, session management
- `/Users/parachute/Code/parachute-serve/` — tailshare: Bun CLI, launchd daemon, multi-service serving
- `/Users/parachute/Code/parachute-daily/` — original monorepo, Flutter app stays there
